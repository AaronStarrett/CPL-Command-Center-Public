import { getEventListeners } from "node:events";

import { describe, expect, it, vi } from "vitest";
import { createDatabaseAdapter, type DatabaseAdapter } from "../../packages/database/src/index.js";
import { runWorker, type WorkerRuntimeDependencies } from "../../apps/worker/src/runtime.js";
import { ARTIFACT_RETENTION_QUEUE_NAME } from "../../packages/automation/src/index.js";
import type { StructuredLogger } from "../../packages/observability/src/index.js";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve: () => resolve?.() };
}

const workerEnvironment = {
  NODE_ENV: "test",
  APP_MODE: "demo",
  DATABASE_DRIVER: "pglite",
  DEMO_DATABASE_PATH: "memory://",
  WORKER_DEMO_DATABASE_PATH: "memory://",
  DEMO_AUTH_ENABLED: "true",
  WORKER_QUEUE_ADAPTER: "inline",
  WORKER_HEALTH_PORT: "0",
  WORKER_POLL_INTERVAL_MS: "60000",
  LOG_LEVEL: "silent",
} as const;

function wrapDatabase(
  adapter: DatabaseAdapter,
  overrides: Partial<Pick<DatabaseAdapter, "health" | "close">>,
): DatabaseAdapter {
  return {
    kind: adapter.kind,
    query: (sql, parameters) => adapter.query(sql, parameters),
    execute: (sql) => adapter.execute(sql),
    transaction: (operation) => adapter.transaction(operation),
    health: overrides.health ?? (() => adapter.health()),
    close: overrides.close ?? (() => adapter.close()),
  };
}

function createTestLogger(error: StructuredLogger["error"] = () => undefined): StructuredLogger {
  const logger: StructuredLogger = {
    child: () => logger,
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error,
    fatal: () => undefined,
  };
  return logger;
}

describe("worker runtime startup", () => {
  it("starts isolated demo serve mode, exposes health, and shuts down cleanly", async () => {
    const result = await runWorker(["--serve"], {
      ...workerEnvironment,
    });
    expect(result.status).toBe("serving");
    expect(result.healthPort).toBeGreaterThan(0);
    const response = await fetch(`http://127.0.0.1:${result.healthPort}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ service: "bea-worker", status: "healthy" });
    await result.close?.();
  }, 30_000);

  it("keeps serve health degraded when the initial workflow is degraded", async () => {
    const dependencies: WorkerRuntimeDependencies = {
      createDatabase: (environment) => {
        const adapter = createDatabaseAdapter(environment);
        return wrapDatabase(adapter, {
          health: async () => ({
            status: "degraded",
            adapter: "pglite",
            checkedAt: new Date().toISOString(),
            latencyMs: 1,
            detail: "test-degraded",
          }),
        });
      },
    };
    const result = await runWorker(["--serve"], workerEnvironment, undefined, dependencies);
    const response = await fetch(`http://127.0.0.1:${result.healthPort}/health`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "degraded",
      lastWorkflowRun: { status: "degraded" },
    });
    await result.close?.();
  }, 30_000);

  it("cleans the timer and database when health-server startup fails", async () => {
    let databaseClosed = false;
    let timerCleared = false;
    const error = vi.fn<StructuredLogger["error"]>();
    const dependencies: WorkerRuntimeDependencies = {
      createDatabase: (environment) => {
        const adapter = createDatabaseAdapter(environment);
        return wrapDatabase(adapter, {
          close: async () => {
            databaseClosed = true;
            await adapter.close();
          },
        });
      },
      startHealthServer: async () => {
        throw new Error("private health-bind sentinel");
      },
      createLogger: () => createTestLogger(error),
      clearInterval: (timer) => {
        timerCleared = true;
        clearInterval(timer);
      },
    };

    await expect(
      runWorker(["--serve"], workerEnvironment, undefined, dependencies),
    ).rejects.toThrow("private health-bind sentinel");
    expect(timerCleared).toBe(true);
    expect(databaseClosed).toBe(true);
    expect(error).toHaveBeenCalledWith(
      { errorCode: "WORKER_STARTUP_FAILED", errorName: "Error" },
      "Worker startup failed",
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain("private health-bind sentinel");
  }, 30_000);

  it("reports a degraded one-shot result and rejects a failed one-shot result", async () => {
    const degraded = await runWorker(
      ["--once", "--idempotency-key=worker-once-degraded"],
      workerEnvironment,
      undefined,
      {
        createDatabase: (environment) => {
          const adapter = createDatabaseAdapter(environment);
          return wrapDatabase(adapter, {
            health: async () => ({
              status: "degraded",
              adapter: "pglite",
              checkedAt: new Date().toISOString(),
              latencyMs: 1,
              detail: "test-degraded",
            }),
          });
        },
      },
    );
    expect(degraded).toMatchObject({ mode: "once", status: "degraded" });

    await expect(
      runWorker(["--once", "--idempotency-key=worker-once-failed"], workerEnvironment, undefined, {
        createDatabase: (environment) => {
          const adapter = createDatabaseAdapter(environment);
          return wrapDatabase(adapter, {
            health: async () => {
              throw new Error("private worker database detail");
            },
          });
        },
      }),
    ).rejects.toThrow("Foundation worker workflow failed.");
  }, 30_000);

  it("rejects a pre-aborted serve signal before constructing runtime resources", async () => {
    const controller = new AbortController();
    controller.abort();
    const createDatabase = vi.fn(() => {
      throw new Error("database must not be constructed");
    });

    await expect(
      runWorker(["--serve"], workerEnvironment, controller.signal, { createDatabase }),
    ).rejects.toThrow("Worker startup aborted before serving.");
    expect(createDatabase).not.toHaveBeenCalled();
  });

  it("removes abort listeners across repeated manual worker lifecycles", async () => {
    const controller = new AbortController();
    const productionLifecycleEnvironment = {
      NODE_ENV: "test",
      APP_MODE: "production",
      APP_BASE_URL: "https://command-center.example.invalid",
      DATABASE_DRIVER: "postgres",
      DATABASE_URL: "postgresql://database.example.invalid/bea",
      DEMO_AUTH_ENABLED: "false",
      SESSION_SECRET: "example-only-session-secret-32-characters",
      WORKER_QUEUE_ADAPTER: "pg-boss",
      WORKER_HEALTH_PORT: "3001",
      LOG_LEVEL: "silent",
    } as const;
    for (let iteration = 0; iteration < 12; iteration += 1) {
      const database = {
        kind: "postgres",
        query: vi.fn(),
        execute: vi.fn(),
        transaction: vi.fn(),
        health: vi.fn(),
        close: vi.fn(async () => undefined),
      } as unknown as DatabaseAdapter;
      const result = await runWorker(
        ["--serve"],
        productionLifecycleEnvironment,
        controller.signal,
        {
          createDatabase: () => database,
          createQueue: async () => ({
            kind: "pg-boss" as const,
            start: async () => undefined,
            stop: async () => undefined,
            enqueue: async () => "unused-test-job",
            work: async () => undefined,
          }),
          startHealthServer: async () => ({
            port: 43_211,
            close: async () => undefined,
          }),
        },
      );
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
      await result.close?.();
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      expect(database.close).toHaveBeenCalledOnce();
    }
  }, 15_000);

  it("rejects a CLI serve override that would share one persistent PGlite owner", async () => {
    const createDatabase = vi.fn(() => {
      throw new Error("database must not be constructed");
    });

    await expect(
      runWorker(
        ["--serve"],
        {
          ...workerEnvironment,
          WORKER_MODE: "once",
          DEMO_DATABASE_PATH: ".data/shared-cli-owner",
          WORKER_DEMO_DATABASE_PATH: ".data/../.data/shared-cli-owner",
        },
        undefined,
        { createDatabase },
      ),
    ).rejects.toThrow(/must use distinct data paths/u);
    expect(createDatabase).not.toHaveBeenCalled();
  });

  it("safely logs scheduled execution rejection and marks worker health degraded", async () => {
    let rejectScheduledClaim = false;
    let scheduledCallback: (() => void) | undefined;
    let resolveScheduledLog: (() => void) | undefined;
    const scheduledLog = new Promise<void>((resolve) => {
      resolveScheduledLog = resolve;
    });
    const error = vi.fn<StructuredLogger["error"]>((bindings, message) => {
      if (message === "Scheduled worker workflow failed") resolveScheduledLog?.();
    });
    const runMaintenanceSweep = vi.fn(async () => ({
      status: "completed" as const,
      expired: { deletedIds: [], failed: [] },
      orphans: {
        deletedIds: [],
        deletedInvalidMetadataIds: [],
        deletedTemporaryFiles: 0,
        failed: [],
      },
    }));
    const dependencies: WorkerRuntimeDependencies = {
      createArtifactMaintenance: () => ({ runMaintenanceSweep }),
      createDatabase: (environment) => {
        const adapter = createDatabaseAdapter(environment);
        return {
          kind: adapter.kind,
          query: async <Row extends Record<string, unknown>>(
            sql: string,
            parameters: readonly unknown[] = [],
          ) => {
            if (rejectScheduledClaim && sql.includes("INSERT INTO workflow_runs")) {
              throw new Error("private scheduled database detail");
            }
            return adapter.query<Row>(sql, parameters);
          },
          execute: (sql) => adapter.execute(sql),
          transaction: (operation) => adapter.transaction(operation),
          health: () => adapter.health(),
          close: () => adapter.close(),
        };
      },
      createLogger: () => createTestLogger(error),
      setInterval: ((callback: () => void) => {
        scheduledCallback = callback;
        return 1 as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval,
      clearInterval: vi.fn() as unknown as typeof clearInterval,
    };

    const result = await runWorker(["--serve"], workerEnvironment, undefined, dependencies);
    rejectScheduledClaim = true;
    scheduledCallback?.();
    await scheduledLog;

    expect(error).toHaveBeenCalledWith(
      { errorCode: "WORKER_SCHEDULED_RUN_FAILED" },
      "Scheduled worker workflow failed",
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain("private scheduled database detail");
    expect(runMaintenanceSweep).toHaveBeenCalledOnce();
    const response = await fetch(`http://127.0.0.1:${result.healthPort}/health`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "degraded" });
    await result.close?.();
  }, 30_000);

  it("automatically runs retention and orphan reconciliation on the inline schedule", async () => {
    let scheduledCallback: (() => void) | undefined;
    const record = vi.fn(async () => ({ id: "maintenance-audit" }) as never);
    const runMaintenanceSweep = vi.fn(async () => ({
      status: "completed" as const,
      expired: { deletedIds: ["art_expired"], failed: [] },
      orphans: {
        deletedIds: ["art_orphan"],
        deletedInvalidMetadataIds: [],
        deletedTemporaryFiles: 2,
        failed: [],
      },
    }));
    const result = await runWorker(["--serve"], workerEnvironment, undefined, {
      artifactMaintenanceAudit: { record },
      createArtifactMaintenance: () => ({ runMaintenanceSweep }),
      setInterval: ((callback: () => void) => {
        scheduledCallback = callback;
        return 1 as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval,
      clearInterval: vi.fn() as unknown as typeof clearInterval,
    });

    expect(runMaintenanceSweep).not.toHaveBeenCalled();
    scheduledCallback?.();
    await vi.waitFor(() => expect(runMaintenanceSweep).toHaveBeenCalledOnce());
    expect(record).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        eventType: "artifact.maintenance.started",
        action: "artifacts.retention-sweep",
        outcome: "allowed",
      }),
    );
    expect(record).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        eventType: "artifact.maintenance.completed",
        action: "artifacts.retention-sweep",
        outcome: "succeeded",
        metadata: expect.objectContaining({
          deletedExpiredCount: 1,
          deletedOrphanCount: 1,
          deletedTemporaryCount: 2,
          failureCount: 0,
        }),
      }),
    );
    expect(record.mock.invocationCallOrder[0]).toBeLessThan(
      runMaintenanceSweep.mock.invocationCallOrder[0]!,
    );
    await result.close?.();
  }, 30_000);

  it("queues a singleton retention sweep for pg-boss and executes its registered handler", async () => {
    let scheduledCallback: (() => void) | undefined;
    const handlers = new Map<
      string,
      (job: { id: string; name: string; data: object }) => Promise<void>
    >();
    const enqueue = vi.fn(async () => "retention-job");
    const record = vi.fn(async () => ({ id: "maintenance-audit" }) as never);
    const runMaintenanceSweep = vi.fn(async () => ({
      status: "completed" as const,
      expired: { deletedIds: [], failed: [] },
      orphans: {
        deletedIds: [],
        deletedInvalidMetadataIds: [],
        deletedTemporaryFiles: 0,
        failed: [],
      },
    }));
    const result = await runWorker(
      ["--serve"],
      { ...workerEnvironment, WORKER_QUEUE_ADAPTER: "pg-boss" },
      undefined,
      {
        artifactMaintenanceAudit: { record },
        createArtifactMaintenance: () => ({ runMaintenanceSweep }),
        createQueue: async () => ({
          kind: "pg-boss",
          start: async () => undefined,
          stop: async () => undefined,
          enqueue,
          work: async (name, handler) => {
            handlers.set(
              name,
              handler as (job: { id: string; name: string; data: object }) => Promise<void>,
            );
          },
        }),
        setInterval: ((callback: () => void) => {
          scheduledCallback = callback;
          return 1 as unknown as ReturnType<typeof setInterval>;
        }) as typeof setInterval,
        clearInterval: vi.fn() as unknown as typeof clearInterval,
      },
    );

    scheduledCallback?.();
    await vi.waitFor(() =>
      expect(enqueue).toHaveBeenCalledWith(
        ARTIFACT_RETENTION_QUEUE_NAME,
        { scheduledBy: "bea-worker" },
        expect.stringMatching(/^scheduled:artifacts\.retention-sweep:\d+$/u),
      ),
    );
    const handler = handlers.get(ARTIFACT_RETENTION_QUEUE_NAME);
    expect(handler).toBeDefined();
    await handler?.({ id: "retention-job", name: ARTIFACT_RETENTION_QUEUE_NAME, data: {} });
    expect(runMaintenanceSweep).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: "artifact-retention:retention-job" }),
    );
    await result.close?.();
  }, 30_000);

  it("drains one active inline run before closing health and database resources", async () => {
    const runStarted = deferred();
    const releaseRun = deferred();
    const order: string[] = [];
    let interceptScheduledRun = false;
    let scheduledClaims = 0;
    let scheduledCallback: (() => void) | undefined;
    const dependencies: WorkerRuntimeDependencies = {
      createArtifactMaintenance: () => ({
        runMaintenanceSweep: async () => ({
          status: "completed",
          expired: { deletedIds: [], failed: [] },
          orphans: {
            deletedIds: [],
            deletedInvalidMetadataIds: [],
            deletedTemporaryFiles: 0,
            failed: [],
          },
        }),
      }),
      createDatabase: (environment) => {
        const adapter = createDatabaseAdapter(environment);
        return {
          kind: adapter.kind,
          query: async <Row extends Record<string, unknown>>(
            sql: string,
            parameters: readonly unknown[] = [],
          ) => {
            if (interceptScheduledRun && sql.includes("INSERT INTO workflow_runs")) {
              scheduledClaims += 1;
              runStarted.resolve();
              await releaseRun.promise;
              order.push("inline-run-drained");
            }
            return adapter.query<Row>(sql, parameters);
          },
          execute: (sql) => adapter.execute(sql),
          transaction: (operation) => adapter.transaction(operation),
          health: () => adapter.health(),
          close: async () => {
            order.push("database-close");
            await adapter.close();
          },
        };
      },
      startHealthServer: async () => ({
        port: 43_211,
        close: async () => {
          order.push("health-close");
        },
      }),
      setInterval: ((callback: () => void) => {
        scheduledCallback = callback;
        return 1 as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval,
      clearInterval: (() => {
        order.push("scheduling-stop");
      }) as typeof clearInterval,
    };

    const result = await runWorker(["--serve"], workerEnvironment, undefined, dependencies);
    if (result.mode !== "serve") throw new Error("Expected serve-mode worker result.");
    interceptScheduledRun = true;
    scheduledCallback?.();
    await runStarted.promise;
    scheduledCallback?.();
    await Promise.resolve();
    expect(scheduledClaims).toBe(1);

    const closing = result.close();
    await Promise.resolve();
    expect(order).toEqual(["scheduling-stop"]);

    releaseRun.resolve();
    await closing;
    expect(order).toEqual([
      "scheduling-stop",
      "inline-run-drained",
      "health-close",
      "database-close",
    ]);
    await result.close();
    expect(order).toHaveLength(4);
  }, 30_000);

  it("gracefully drains the queue before closing health and database resources", async () => {
    const releaseQueue = deferred();
    const queueStopStarted = deferred();
    const order: string[] = [];
    const dependencies: WorkerRuntimeDependencies = {
      createDatabase: (environment) => {
        const adapter = createDatabaseAdapter(environment);
        return wrapDatabase(adapter, {
          close: async () => {
            order.push("database-close");
            await adapter.close();
          },
        });
      },
      createQueue: async () => ({
        kind: "pg-boss",
        start: async () => undefined,
        stop: async () => {
          order.push("queue-stop-start");
          queueStopStarted.resolve();
          await releaseQueue.promise;
          order.push("queue-drained");
        },
        enqueue: async () => "unused-job",
        work: async () => undefined,
      }),
      startHealthServer: async () => ({
        port: 43_212,
        close: async () => {
          order.push("health-close");
        },
      }),
    };
    const result = await runWorker(
      ["--serve"],
      { ...workerEnvironment, WORKER_QUEUE_ADAPTER: "pg-boss" },
      undefined,
      dependencies,
    );
    if (result.mode !== "serve") throw new Error("Expected serve-mode worker result.");

    const closing = result.close();
    await queueStopStarted.promise;
    expect(order).toEqual(["queue-stop-start"]);

    releaseQueue.resolve();
    await closing;
    expect(order).toEqual(["queue-stop-start", "queue-drained", "health-close", "database-close"]);
  }, 30_000);

  it("handles abort cleanup rejection without exposing private cleanup details", async () => {
    const controller = new AbortController();
    let databaseClosed = false;
    let resolveCleanupLog: (() => void) | undefined;
    const cleanupLog = new Promise<void>((resolve) => {
      resolveCleanupLog = resolve;
    });
    const error = vi.fn<StructuredLogger["error"]>((bindings, message) => {
      if (message === "Worker cleanup failed after abort") resolveCleanupLog?.();
    });
    const result = await runWorker(["--serve"], workerEnvironment, controller.signal, {
      createDatabase: (environment) => {
        const adapter = createDatabaseAdapter(environment);
        return wrapDatabase(adapter, {
          close: async () => {
            databaseClosed = true;
            await adapter.close();
          },
        });
      },
      createLogger: () => createTestLogger(error),
      startHealthServer: async () => ({
        port: 43_210,
        close: async () => {
          throw new Error("private abort cleanup detail");
        },
      }),
    });

    controller.abort();
    await cleanupLog;

    expect(result).toMatchObject({ mode: "serve", status: "serving", healthPort: 43_210 });
    expect(databaseClosed).toBe(true);
    expect(error).toHaveBeenCalledWith(
      { errorCode: "WORKER_ABORT_CLEANUP_FAILED", errorName: "Error" },
      "Worker cleanup failed after abort",
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain("private abort cleanup detail");
  }, 30_000);
});
