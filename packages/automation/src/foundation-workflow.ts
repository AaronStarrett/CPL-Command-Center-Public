import { randomUUID } from "node:crypto";
import type {
  AuditSink,
  Clock,
  DatabaseHealthProvider,
  IdGenerator,
  JsonObject,
  StructuredError,
  WorkflowRun,
  WorkflowStepRun,
  WorkflowStore,
} from "@bea/domain";
import type { ProviderRegistry } from "@bea/integrations";
import type { StructuredLogger } from "@bea/observability";

export const FOUNDATION_WORKFLOW_KEY = "foundation.system-health-check";

const systemClock: Clock = { now: () => new Date() };
const uuidGenerator: IdGenerator = { next: () => randomUUID() };
const noopLogger: StructuredLogger = {
  child: () => noopLogger,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
};

export interface FoundationWorkflowDependencies {
  readonly database: DatabaseHealthProvider;
  readonly providers: ProviderRegistry;
  readonly store: WorkflowStore;
  readonly audit?: AuditSink;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly logger?: StructuredLogger;
}

export interface FoundationWorkflowInput {
  readonly idempotencyKey: string;
  readonly correlationId?: string;
  readonly actorUserId?: string;
  readonly trigger?: "manual" | "worker" | "seed";
}

export interface FoundationWorkflowResult {
  readonly run: WorkflowRun;
  readonly reused: boolean;
  readonly steps: readonly WorkflowStepRun[];
}

function toStructuredError(): StructuredError {
  return {
    code: "FOUNDATION_WORKFLOW_FAILED",
    message: "Foundation health check failed.",
    retryable: true,
  };
}

function toStepStatus(
  status: "healthy" | "degraded" | "unhealthy" | "unknown",
): WorkflowStepRun["status"] {
  if (status === "healthy") return "succeeded";
  if (status === "degraded" || status === "unknown") return "degraded";
  return "failed";
}

export class FoundationSystemHealthWorkflow {
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly logger: StructuredLogger;

  constructor(private readonly dependencies: FoundationWorkflowDependencies) {
    this.clock = dependencies.clock ?? systemClock;
    this.ids = dependencies.ids ?? uuidGenerator;
    this.logger = dependencies.logger ?? noopLogger;
  }

  async execute(input: FoundationWorkflowInput): Promise<FoundationWorkflowResult> {
    if (!input.idempotencyKey.trim()) {
      throw new Error("A non-empty idempotency key is required.");
    }
    const startedAt = this.clock.now().toISOString();
    const correlationId = input.correlationId ?? this.ids.next();
    const candidate: WorkflowRun = {
      id: this.ids.next(),
      workflowKey: FOUNDATION_WORKFLOW_KEY,
      status: "running",
      triggerMetadata: {
        trigger: input.trigger ?? "manual",
        nonDestructive: true,
        externalSideEffects: false,
      },
      correlationId,
      idempotencyKey: input.idempotencyKey,
      startedAt,
      finishedAt: null,
      error: null,
      retryCount: 0,
      cancellationRequested: false,
      createdByUserId: input.actorUserId ?? null,
      createdAt: startedAt,
      updatedAt: startedAt,
      version: 1,
    };
    const claim = await this.dependencies.store.claimWorkflowRun(candidate);
    if (!claim.claimed) {
      this.logger.info(
        { correlationId, idempotencyKey: input.idempotencyKey },
        "Foundation workflow reused an idempotent result",
      );
      const persistedSteps = await this.dependencies.store.listWorkflowStepRuns(claim.run.id);
      return { run: claim.run, reused: true, steps: persistedSteps };
    }

    this.logger.info({ correlationId, workflowRunId: candidate.id }, "Foundation workflow started");
    const steps: WorkflowStepRun[] = [];
    try {
      const databaseHealth = await this.dependencies.database.health();
      steps.push(
        await this.persistStep(
          candidate,
          "database-health",
          1,
          toStepStatus(databaseHealth.status),
          {
            status: databaseHealth.status,
            adapter: databaseHealth.adapter,
            latencyMs: databaseHealth.latencyMs,
          },
        ),
      );

      const providerHealth = await this.dependencies.providers.healthSummary();
      steps.push(
        await this.persistStep(
          candidate,
          "provider-registry-health",
          2,
          toStepStatus(providerHealth.status),
          {
            status: providerHealth.status,
            total: providerHealth.total,
            simulated: providerHealth.simulated,
            connected: providerHealth.connected,
            failed: providerHealth.failed,
          },
        ),
      );

      const status =
        databaseHealth.status === "unhealthy" || providerHealth.status === "unhealthy"
          ? "failed"
          : databaseHealth.status === "healthy" && providerHealth.status === "healthy"
            ? "succeeded"
            : "degraded";
      const finishedAt = this.clock.now().toISOString();
      const run = await this.dependencies.store.finishWorkflowRun({
        id: candidate.id,
        status,
        finishedAt,
        error: null,
        expectedVersion: candidate.version,
      });
      if (this.dependencies.audit) {
        await this.dependencies.audit.record({
          eventType: "workflow.completed",
          action: FOUNDATION_WORKFLOW_KEY,
          outcome: status === "succeeded" ? "succeeded" : "failed",
          actorUserId: input.actorUserId ?? null,
          resourceType: "workflow-run",
          resourceId: run.id,
          correlationId,
          metadata: { status, idempotencyKey: input.idempotencyKey },
          createdAt: finishedAt,
        });
      }
      this.logger.info(
        { correlationId, workflowRunId: run.id, status },
        "Foundation workflow finished",
      );
      return { run, reused: false, steps };
    } catch (error) {
      const structuredError = toStructuredError();
      const finishedAt = this.clock.now().toISOString();
      const run = await this.dependencies.store.finishWorkflowRun({
        id: candidate.id,
        status: "failed",
        finishedAt,
        error: structuredError,
        expectedVersion: candidate.version,
      });
      if (this.dependencies.audit) {
        await this.dependencies.audit.record({
          eventType: "workflow.failed",
          action: FOUNDATION_WORKFLOW_KEY,
          outcome: "failed",
          actorUserId: input.actorUserId ?? null,
          resourceType: "workflow-run",
          resourceId: run.id,
          correlationId,
          metadata: {
            status: "failed",
            idempotencyKey: input.idempotencyKey,
            errorCode: structuredError.code,
          },
          createdAt: finishedAt,
        });
      }
      this.logger.error(
        {
          correlationId,
          workflowRunId: run.id,
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorCode: structuredError.code,
        },
        "Foundation workflow failed",
      );
      return { run, reused: false, steps };
    }
  }

  private async persistStep(
    run: WorkflowRun,
    stepKey: string,
    sequence: number,
    status: WorkflowStepRun["status"],
    result: JsonObject,
  ): Promise<WorkflowStepRun> {
    const startedAt = this.clock.now().toISOString();
    const finishedAt = this.clock.now().toISOString();
    const step: WorkflowStepRun = {
      id: this.ids.next(),
      workflowRunId: run.id,
      stepKey,
      sequence,
      status,
      startedAt,
      finishedAt,
      result,
      error: null,
      retryCount: 0,
      createdAt: startedAt,
      updatedAt: finishedAt,
      version: 1,
    };
    await this.dependencies.store.saveWorkflowStepRun(step);
    this.logger.info(
      { correlationId: run.correlationId, workflowRunId: run.id, stepKey },
      "Foundation workflow step finished",
    );
    return step;
  }
}
