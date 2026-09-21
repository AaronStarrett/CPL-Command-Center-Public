import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";

import {
  PRODUCTION_HEALTH_QUEUE,
  runProductionQueueCheck,
  type ProductionQueueClient,
} from "../../apps/worker/src/production-queue-check.js";

const environment = {
  APP_BASE_URL: "https://bea.localhost:3443",
  APP_MODE: "production",
  BEA_AUTH_PROVIDER: "local-owner",
  BEA_DEPLOYMENT_PROFILE: "local-live",
  BEA_DISABLE_ENV_FILE: "true",
  BEA_PRODUCTION_SECRET_PATH: join(
    process.env.LOCALAPPDATA ?? "C:\\Users\\owner\\AppData\\Local",
    "BEA",
    "CommandCenter",
    "secrets",
    "production-secrets.dpapi.json",
  ),
  BEA_RUNTIME_MODE: "production",
  DATABASE_DRIVER: "postgres",
  DATABASE_URL: "postgresql://bea:redacted@127.0.0.1:55432/bea",
  DEMO_AUTH_ENABLED: "false",
  NODE_ENV: "production",
  SESSION_SECRET: "s".repeat(64),
  WORKER_HEALTH_PORT: "3211",
  WORKER_MODE: "serve",
  WORKER_QUEUE_ADAPTER: "pg-boss",
} as const;

describe("Phase 1.3.4 real pg-boss acceptance contract", () => {
  it("verifies one health job, idempotency, retry/failure, and graceful stop", async () => {
    const jobs = new Map<string, { state: string; data: { kind: string; runId: string } }>();
    let handler: ((jobs: readonly { id: string; state: string }[]) => Promise<void>) | undefined;
    let sequence = 0;
    const client: ProductionQueueClient = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      createQueue: vi.fn(async () => undefined),
      work: vi.fn(async (_name, _options, next) => {
        handler = next;
        return "worker-1";
      }),
      offWork: vi.fn(async () => undefined),
      send: vi.fn(async (_name, data, options = {}) => {
        if (
          options.singletonKey &&
          [...jobs.values()].some((job) => job.data.runId === data.runId)
        ) {
          return null;
        }
        const id = `job-${String(++sequence)}`;
        jobs.set(id, { state: "created", data: data as { kind: string; runId: string } });
        queueMicrotask(async () => {
          if (!handler) return;
          try {
            await handler([{ id, state: "active" }]);
            jobs.get(id)!.state = "completed";
          } catch {
            try {
              await handler([{ id, state: "retry" }]);
            } catch {
              jobs.get(id)!.state = "failed";
            }
          }
        });
        return id;
      }),
      getJobById: vi.fn(async (_name, id) => {
        const job = jobs.get(id);
        return job ? { id, state: job.state, data: job.data } : null;
      }),
    };
    const result = await runProductionQueueCheck(environment, {
      createClient: async () => client,
      id: () => "run-1",
    });
    expect(result).toEqual({
      queue: PRODUCTION_HEALTH_QUEUE,
      schemaInstalled: true,
      healthJobCompleted: true,
      idempotencyVerified: true,
      retryVerified: true,
      failedJobVerified: true,
      gracefulShutdownVerified: true,
    });
    expect(client.offWork).toHaveBeenCalledWith({ id: "worker-1" });
    expect(client.stop).toHaveBeenCalledWith({ graceful: true, timeout: 10_000 });
  });

  it("rejects inline, Demo, and non-PostgreSQL profiles before a client is created", async () => {
    const createClient = vi.fn();
    await expect(
      runProductionQueueCheck(
        {
          ...environment,
          APP_MODE: "demo",
          BEA_RUNTIME_MODE: "development",
          BEA_DEPLOYMENT_PROFILE: "demo",
          BEA_AUTH_PROVIDER: "demo",
          DATABASE_DRIVER: "pglite",
          DATABASE_URL: "",
          DEMO_AUTH_ENABLED: "true",
          WORKER_QUEUE_ADAPTER: "inline",
        },
        { createClient },
      ),
    ).rejects.toThrow();
    expect(createClient).not.toHaveBeenCalled();
  });
});
