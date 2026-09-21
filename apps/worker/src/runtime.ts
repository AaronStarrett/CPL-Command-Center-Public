import {
  ARTIFACT_RETENTION_QUEUE_NAME,
  DIGITAL_WORKFORCE_QUEUE_NAME,
  FOUNDATION_QUEUE_NAME,
  OPERATIONS_QUEUE_NAME,
  FoundationSystemHealthWorkflow,
  PgBossQueueAdapter,
  type JobQueue,
  type PgBossClientSeam,
} from "@bea/automation";
import { RepositoryArtifactFileStore, type ArtifactMaintenanceResult } from "@bea/artifacts";
import {
  assertDistinctPgliteServePaths,
  assertLegacyRuntimeTestOnly,
  loadRepositoryEnvironment,
  type ServerEnvironment,
} from "@bea/config";
import {
  createDatabaseAdapter,
  createInspectionReportPipeline,
  executeDigitalWorkforceRun,
  migrateDatabase,
  seedDatabase,
  SqlDigitalWorkforceRepository,
  SqlFoundationRepository,
  SqlLeadRepository,
  type DatabaseAdapter,
} from "@bea/database";
import {
  createDefaultMockProviderRegistry,
  createUnavailableProviderRegistry,
} from "@bea/integrations";
import { createLogger, type StructuredLogger } from "@bea/observability";
import { parseWorkerArguments } from "./cli.js";
import {
  startWorkerHealthServer,
  WorkerHealthMonitor,
  type WorkerHealthServer,
} from "./health-server.js";

export type WorkerRunResult =
  | {
      readonly mode: "once";
      readonly status: "succeeded" | "degraded";
      readonly workflowRunId: string;
      readonly reused: boolean;
    }
  | {
      readonly mode: "serve";
      readonly status: "serving";
      readonly healthPort: number;
      readonly close: () => Promise<void>;
    };

export function recordScheduledWorkerFailure(
  monitor: WorkerHealthMonitor,
  logger: StructuredLogger,
): void {
  monitor.markDegraded();
  logger.error({ errorCode: "WORKER_SCHEDULED_RUN_FAILED" }, "Scheduled worker workflow failed");
}

export class InlineScheduledRunCoordinator {
  private activeRun: Promise<void> | undefined;
  private stopped = false;

  start(operation: () => Promise<void>, onFailure: (error: unknown) => void): boolean {
    if (this.stopped || this.activeRun) return false;

    const activeRun = Promise.resolve()
      .then(operation)
      .catch(onFailure)
      .finally(() => {
        if (this.activeRun === activeRun) this.activeRun = undefined;
      });
    this.activeRun = activeRun;
    return true;
  }

  stopScheduling(): void {
    this.stopped = true;
  }

  async drain(): Promise<void> {
    await this.activeRun;
  }
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

async function createPgBossQueue(environment: ServerEnvironment): Promise<PgBossQueueAdapter> {
  if (!environment.databaseUrl) throw new Error("pg-boss requires DATABASE_URL.");
  const pgBossModule = await import("pg-boss");
  const Constructor = pgBossModule.default as unknown as new (configuration: {
    connectionString: string;
  }) => PgBossClientSeam;
  return new PgBossQueueAdapter(new Constructor({ connectionString: environment.databaseUrl }));
}

export interface WorkerRuntimeDependencies {
  readonly artifactMaintenanceAudit?: Pick<SqlFoundationRepository, "record">;
  readonly createArtifactMaintenance?: (
    repositoryRoot: string,
  ) => Pick<RepositoryArtifactFileStore, "runMaintenanceSweep">;
  readonly createDatabase?: (environment: ServerEnvironment) => DatabaseAdapter;
  readonly createQueue?: (environment: ServerEnvironment) => Promise<JobQueue>;
  readonly startHealthServer?: (
    monitor: WorkerHealthMonitor,
    port: number,
  ) => Promise<WorkerHealthServer>;
  readonly setInterval?: typeof setInterval;
  readonly clearInterval?: typeof clearInterval;
  readonly createLogger?: typeof createLogger;
}

export async function runWorker(
  arguments_: readonly string[],
  rawEnvironment: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal,
  dependencies: WorkerRuntimeDependencies = {},
): Promise<WorkerRunResult> {
  assertLegacyRuntimeTestOnly(rawEnvironment);
  const { environment, repositoryRoot } = loadRepositoryEnvironment({
    processEnvironment: rawEnvironment,
  });
  const options = parseWorkerArguments(arguments_, environment.workerMode);
  assertDistinctPgliteServePaths(environment, options.mode);
  if (options.mode === "serve" && signal?.aborted) {
    throw new Error("Worker startup aborted before serving.");
  }
  const logger = (dependencies.createLogger ?? createLogger)({
    service: "bea-worker",
    environment: environment.nodeEnv,
    level: environment.logLevel,
  });
  const workerEnvironment: ServerEnvironment =
    environment.appMode === "demo" && options.mode === "serve"
      ? { ...environment, demoDatabasePath: environment.workerDemoDatabasePath }
      : environment;
  const database = (dependencies.createDatabase ?? createDatabaseAdapter)(workerEnvironment);
  const repository = new SqlFoundationRepository(database);
  const operationsPipeline = createInspectionReportPipeline(database, environment.appMode, {
    processInline: false,
  });
  const workControl = operationsPipeline.workControl;
  const artifactMaintenanceAudit = dependencies.artifactMaintenanceAudit ?? repository;
  const workflow = new FoundationSystemHealthWorkflow({
    database,
    providers:
      environment.runtimeMode === "production"
        ? createUnavailableProviderRegistry()
        : createDefaultMockProviderRegistry(),
    store: repository,
    audit: repository,
    logger,
  });
  const monitor = new WorkerHealthMonitor();
  let queue: JobQueue | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let healthServer: WorkerHealthServer | undefined;
  let closing: Promise<void> | undefined;
  let abortCleanupHandled = false;
  let abortListener: (() => void) | undefined;
  const inlineRuns = new InlineScheduledRunCoordinator();
  const artifactMaintenance = (
    dependencies.createArtifactMaintenance ??
    ((root) => new RepositoryArtifactFileStore({ repositoryRoot: root }))
  )(repositoryRoot);
  const runArtifactMaintenance = async (
    correlationId: string,
  ): Promise<ArtifactMaintenanceResult> => {
    await artifactMaintenanceAudit.record({
      eventType: "artifact.maintenance.started",
      action: "artifacts.retention-sweep",
      outcome: "allowed",
      actorUserId: null,
      resourceType: "artifact-store",
      resourceId: null,
      correlationId,
      metadata: { maintenanceStatus: "started" },
    });
    let result: ArtifactMaintenanceResult;
    try {
      result = await artifactMaintenance.runMaintenanceSweep();
    } catch (error) {
      await artifactMaintenanceAudit.record({
        eventType: "artifact.maintenance.failed",
        action: "artifacts.retention-sweep",
        outcome: "failed",
        actorUserId: null,
        resourceType: "artifact-store",
        resourceId: null,
        correlationId,
        metadata: {
          errorCode: "ARTIFACT_MAINTENANCE_FAILED",
          errorName: safeErrorName(error),
        },
      });
      throw error;
    }
    const failureCodes = [
      ...result.expired.failed.map(({ code }) => `expired:${code}`),
      ...result.orphans.failed.map(({ code }) => `orphan:${code}`),
    ];
    const hasFailures = failureCodes.length > 0;
    await artifactMaintenanceAudit.record({
      eventType:
        result.status === "skipped-active"
          ? "artifact.maintenance.skipped"
          : hasFailures
            ? "artifact.maintenance.failed"
            : "artifact.maintenance.completed",
      action: "artifacts.retention-sweep",
      outcome: hasFailures ? "failed" : "succeeded",
      actorUserId: null,
      resourceType: "artifact-store",
      resourceId: null,
      correlationId,
      metadata: {
        deletedExpiredCount: result.expired.deletedIds.length,
        deletedOrphanCount: result.orphans.deletedIds.length,
        deletedInvalidMetadataCount: result.orphans.deletedInvalidMetadataIds.length,
        deletedTemporaryCount: result.orphans.deletedTemporaryFiles,
        failureCodes: [...new Set(failureCodes)].sort(),
        failureCount: failureCodes.length,
        maintenanceStatus: result.status,
      },
    });
    if (hasFailures) throw new Error("Artifact maintenance sweep reported safe cleanup failures.");
    logger.info(
      {
        deletedExpiredCount: result.expired.deletedIds.length,
        deletedOrphanCount: result.orphans.deletedIds.length,
        deletedInvalidMetadataCount: result.orphans.deletedInvalidMetadataIds.length,
        deletedTemporaryCount: result.orphans.deletedTemporaryFiles,
        maintenanceStatus: result.status,
      },
      "Artifact maintenance sweep completed",
    );
    return result;
  };
  const detachAbortListener = () => {
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
      abortListener = undefined;
    }
  };
  const close = (): Promise<void> => {
    if (!closing) {
      closing = (async () => {
        detachAbortListener();
        monitor.markStopping();
        inlineRuns.stopScheduling();
        if (timer) {
          (dependencies.clearInterval ?? clearInterval)(timer);
          timer = undefined;
        }

        const failures: unknown[] = [];
        const settle = async (operation: () => Promise<void>): Promise<void> => {
          try {
            await operation();
          } catch (error) {
            failures.push(error);
          }
        };

        await settle(() => inlineRuns.drain());
        await settle(() => queue?.stop() ?? Promise.resolve());
        await settle(() => healthServer?.close() ?? Promise.resolve());
        await settle(() => database.close());

        const failure = failures.at(0);
        if (failure !== undefined) throw failure;
      })();
    }
    return closing;
  };
  const closeAfterAbort = async (): Promise<void> => {
    try {
      await close();
    } catch (cleanupError) {
      logger.error(
        {
          errorCode: "WORKER_ABORT_CLEANUP_FAILED",
          errorName: safeErrorName(cleanupError),
        },
        "Worker cleanup failed after abort",
      );
    }
  };
  try {
    if (environment.appMode === "demo") {
      await migrateDatabase(database);
      await seedDatabase(database);
    }
    await workControl?.driveStartup();
    if (options.mode === "once") {
      const result = await workflow.execute({
        idempotencyKey: options.idempotencyKey,
        trigger: "worker",
      });
      await close();
      if (result.run.status === "failed") {
        throw new Error("Foundation worker workflow failed.");
      }
      if (result.run.status !== "succeeded" && result.run.status !== "degraded") {
        throw new Error(`Foundation worker workflow did not finish (${result.run.status}).`);
      }
      return {
        mode: "once",
        status: result.run.status,
        workflowRunId: result.run.id,
        reused: result.reused,
      };
    }

    if (environment.workerQueueAdapter === "pg-boss") {
      queue = await (dependencies.createQueue ?? createPgBossQueue)(environment);
      const activeQueue = queue;
      await activeQueue.start();
      await activeQueue.work(FOUNDATION_QUEUE_NAME, async (job) => {
        const result = await workflow.execute({
          idempotencyKey: String(job.data.idempotencyKey ?? job.id),
          trigger: "worker",
        });
        monitor.recordWorkflow(result.run, result.reused);
      });
      await activeQueue.work(ARTIFACT_RETENTION_QUEUE_NAME, async (job) => {
        try {
          await runArtifactMaintenance(`artifact-retention:${job.id}`);
        } catch (error) {
          recordScheduledWorkerFailure(monitor, logger);
          throw error;
        }
      });
      await activeQueue.work(DIGITAL_WORKFORCE_QUEUE_NAME, async (job) => {
        const runId = typeof job.data.runId === "string" ? job.data.runId : "";
        const workforce = new SqlDigitalWorkforceRepository(database);
        const leads = new SqlLeadRepository(database);
        await executeDigitalWorkforceRun({
          workforce,
          leads,
          runId,
          claimOwner: `worker:${job.id}`,
          adapters: {
            liveEnabled: false,
            demoFallbackAllowed: true,
            resolveModel: async ({ profile }) => ({
              model: `deterministic:${profile}`,
              fallbackUsed: null,
              provider: "deterministic",
            }),
            generatePdf: async (pdfInput) => ({
              artifactId: pdfInput.runId,
              title: pdfInput.title,
            }),
          },
        });
      });
      await activeQueue.work(OPERATIONS_QUEUE_NAME, async (job) => {
        await operationsPipeline.processPendingJobs({
          claimOwner: `worker:${job.id}`,
        });
        await workControl?.drivePoll(`worker:${job.id}`);
      });
      timer = (dependencies.setInterval ?? setInterval)(() => {
        inlineRuns.start(
          async () => {
            const bucket = Math.floor(Date.now() / environment.workerPollIntervalMs);
            await activeQueue.enqueue(
              ARTIFACT_RETENTION_QUEUE_NAME,
              { scheduledBy: "bea-worker" },
              `scheduled:artifacts.retention-sweep:${bucket}`,
            );
            await operationsPipeline.processPendingJobs({
              claimOwner: `worker-poll:${bucket}`,
            });
            await workControl?.drivePoll(`worker-poll:${bucket}`);
          },
          () => recordScheduledWorkerFailure(monitor, logger),
        );
      }, environment.workerPollIntervalMs);
      monitor.markHealthy();
    } else {
      const runFoundationWorkflow = async (): Promise<void> => {
        const bucket = Math.floor(Date.now() / environment.workerPollIntervalMs);
        const result = await workflow.execute({
          idempotencyKey: `scheduled:foundation.system-health-check:${bucket}`,
          trigger: "worker",
        });
        monitor.recordWorkflow(result.run, result.reused);
      };
      await runFoundationWorkflow();
      timer = (dependencies.setInterval ?? setInterval)(() => {
        inlineRuns.start(
          async () => {
            const bucket = Math.floor(Date.now() / environment.workerPollIntervalMs);
            let firstFailure: unknown;
            try {
              await runFoundationWorkflow();
            } catch (error) {
              firstFailure = error;
            }
            try {
              await runArtifactMaintenance(`scheduled:artifacts.retention-sweep:${bucket}`);
            } catch (error) {
              firstFailure ??= error;
            }
            try {
              await operationsPipeline.processPendingJobs({
                claimOwner: `worker-inline:${bucket}`,
              });
              await workControl?.drivePoll(`worker-inline:${bucket}`);
            } catch (error) {
              firstFailure ??= error;
            }
            if (firstFailure !== undefined) throw firstFailure;
          },
          () => recordScheduledWorkerFailure(monitor, logger),
        );
      }, environment.workerPollIntervalMs);
    }

    healthServer = await (dependencies.startHealthServer ?? startWorkerHealthServer)(
      monitor,
      environment.workerHealthPort,
    );
    if (signal?.aborted) {
      abortCleanupHandled = true;
      await closeAfterAbort();
      throw new Error("Worker startup aborted before serving.");
    }
    if (signal) {
      abortListener = () => void closeAfterAbort();
      signal.addEventListener("abort", abortListener, { once: true });
    }
    return { mode: "serve", status: "serving", healthPort: healthServer.port, close };
  } catch (error) {
    logger.error(
      { errorCode: "WORKER_STARTUP_FAILED", errorName: safeErrorName(error) },
      "Worker startup failed",
    );
    if (!abortCleanupHandled) {
      try {
        await close();
      } catch (cleanupError) {
        logger.error(
          {
            errorCode: "WORKER_STARTUP_CLEANUP_FAILED",
            errorName: safeErrorName(cleanupError),
          },
          "Worker cleanup failed after startup error",
        );
      }
    }
    throw error;
  }
}
