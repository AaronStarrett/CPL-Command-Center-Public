import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { loadRepositoryEnvironment, type ServerEnvironment } from "@bea/config";
import { toSafeErrorDetails } from "@bea/observability";

export const PRODUCTION_HEALTH_QUEUE = "bea.phase134.production-health";

interface QueueJob {
  readonly id: string;
  readonly state?: string;
}

export interface ProductionQueueClient {
  start(): Promise<unknown>;
  stop(options?: { graceful?: boolean; timeout?: number }): Promise<unknown>;
  createQueue(name: string, options?: Record<string, unknown>): Promise<unknown>;
  send(
    name: string,
    data: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<string | null>;
  work(
    name: string,
    options: Record<string, unknown>,
    handler: (jobs: readonly QueueJob[]) => Promise<void>,
  ): Promise<string>;
  offWork(target: string | { readonly id: string }): Promise<void>;
  getJobById<T>(name: string, id: string): Promise<(QueueJob & { readonly data?: T }) | null>;
}

export interface ProductionQueueCheckResult {
  readonly queue: typeof PRODUCTION_HEALTH_QUEUE;
  readonly schemaInstalled: true;
  readonly healthJobCompleted: true;
  readonly idempotencyVerified: true;
  readonly retryVerified: true;
  readonly failedJobVerified: true;
  readonly gracefulShutdownVerified: true;
}

function assertProductionQueueEnvironment(environment: ServerEnvironment): void {
  if (
    environment.appMode !== "production" ||
    environment.runtimeMode !== "production" ||
    environment.databaseDriver !== "postgres" ||
    environment.workerQueueAdapter !== "pg-boss" ||
    environment.workerMode !== "serve" ||
    environment.demoAuthEnabled
  ) {
    throw new Error(
      "The production queue check requires the validated PostgreSQL pg-boss profile.",
    );
  }
}

async function waitForJobState(
  client: ProductionQueueClient,
  jobId: string,
  accepted: ReadonlySet<string>,
  options: { readonly timeoutMs?: number; readonly intervalMs?: number } = {},
): Promise<string> {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  while (Date.now() < deadline) {
    const job = await client.getJobById(PRODUCTION_HEALTH_QUEUE, jobId);
    if (job?.state && accepted.has(job.state)) return job.state;
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 100));
  }
  throw new Error("The pg-boss health job did not reach the expected state.");
}

export async function runProductionQueueCheck(
  rawEnvironment: Readonly<Record<string, string | undefined>>,
  dependencies: {
    readonly createClient?: (databaseUrl: string) => Promise<ProductionQueueClient>;
    readonly id?: () => string;
  } = {},
): Promise<ProductionQueueCheckResult> {
  const { environment } = loadRepositoryEnvironment({
    processEnvironment: rawEnvironment,
    loadEnvFile: false,
  });
  assertProductionQueueEnvironment(environment);
  if (!environment.databaseUrl) throw new Error("PostgreSQL is not configured.");
  const createClient =
    dependencies.createClient ??
    (async (databaseUrl: string) => {
      const module = await import("pg-boss");
      const Constructor = module.default as unknown as new (options: {
        readonly connectionString: string;
      }) => ProductionQueueClient;
      return new Constructor({ connectionString: databaseUrl });
    });
  const client = await createClient(environment.databaseUrl);
  let stopped = false;
  try {
    await client.start();
    await client.createQueue(PRODUCTION_HEALTH_QUEUE, { retryLimit: 1, retryDelay: 1 });

    const runId = (dependencies.id ?? randomUUID)();
    let healthHandled = false;
    let failureAttempts = 0;
    const workerId = await client.work(
      PRODUCTION_HEALTH_QUEUE,
      { batchSize: 1, pollingIntervalSeconds: 0.1 },
      async (jobs) => {
        const job = jobs.at(0);
        if (!job) return;
        const stored = await client.getJobById<{ readonly kind?: string }>(
          PRODUCTION_HEALTH_QUEUE,
          job.id,
        );
        if (stored?.data?.kind === "forced-retry") {
          failureAttempts += 1;
          throw new Error("Intentional queue acceptance retry.");
        }
        healthHandled = true;
      },
    );

    const singletonKey = `phase134-health-${runId}`;
    const healthId = await client.send(
      PRODUCTION_HEALTH_QUEUE,
      { kind: "health", runId },
      { singletonKey, singletonSeconds: 60, retryLimit: 1 },
    );
    const duplicateId = await client.send(
      PRODUCTION_HEALTH_QUEUE,
      { kind: "health", runId },
      { singletonKey, singletonSeconds: 60, retryLimit: 1 },
    );
    if (!healthId || duplicateId !== null) {
      throw new Error("pg-boss idempotency verification failed.");
    }
    await waitForJobState(client, healthId, new Set(["completed"]));
    if (!healthHandled) throw new Error("The harmless pg-boss health job was not handled.");

    const failedId = await client.send(
      PRODUCTION_HEALTH_QUEUE,
      { kind: "forced-retry", runId },
      { retryLimit: 1, retryDelay: 1, retryBackoff: false },
    );
    if (!failedId) throw new Error("The pg-boss retry probe was not enqueued.");
    await waitForJobState(client, failedId, new Set(["failed"]));
    if (failureAttempts < 2) throw new Error("The pg-boss retry policy was not observed.");

    await client.offWork({ id: workerId });
    await client.stop({ graceful: true, timeout: 10_000 });
    stopped = true;
    return {
      queue: PRODUCTION_HEALTH_QUEUE,
      schemaInstalled: true,
      healthJobCompleted: true,
      idempotencyVerified: true,
      retryVerified: true,
      failedJobVerified: true,
      gracefulShutdownVerified: true,
    };
  } finally {
    if (!stopped) await client.stop({ graceful: true, timeout: 10_000 }).catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runProductionQueueCheck(process.env)
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error: unknown) => {
      process.stderr.write(
        `${JSON.stringify({
          code: "BEA_PRODUCTION_QUEUE_CHECK_FAILED",
          ...toSafeErrorDetails(error, "PRODUCTION_QUEUE_CHECK_FAILED"),
        })}\n`,
      );
      process.exitCode = 1;
    });
}
