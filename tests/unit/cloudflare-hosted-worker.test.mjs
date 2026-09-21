import { describe, expect, it, vi } from "vitest";
import handler from "../../apps/worker/cloudflare-worker.mjs";
import {
  createHostedScheduledHandler,
  workerDatabaseConnectionString,
} from "../../apps/worker/cloudflare-scheduler.mjs";

const syntheticDatabase = "postgres://worker:synthetic@database.invalid/test";

function fixture(overrides = {}) {
  const database = { close: vi.fn().mockResolvedValue(undefined) };
  const createDatabase = vi.fn(() => database);
  const processJobs = vi
    .fn()
    .mockResolvedValue({ claimed: 1, completed: 1, retried: 0, failed: 0 });
  const logger = { info: vi.fn(), error: vi.fn() };
  return {
    database,
    createDatabase,
    processJobs,
    logger,
    scheduled: createHostedScheduledHandler({
      createDatabase,
      processJobs,
      logger,
      claimId: () => "synthetic-invocation",
      ...overrides,
    }),
  };
}

describe("bounded Cloudflare background worker", () => {
  it("processes one durable job and closes its invocation-owned pool", async () => {
    const test = fixture();
    await expect(
      test.scheduled({}, { CPL_WORKER_DATABASE_URL: syntheticDatabase + "?sslmode=require" }),
    ).resolves.toEqual({ claimed: 1, completed: 1, retried: 0, failed: 0 });
    expect(test.createDatabase).toHaveBeenCalledWith(
      expect.objectContaining({
        max: 1,
        connectionTimeoutMillis: 5_000,
        statement_timeout: 4_000,
        connectionString: syntheticDatabase,
        ssl: { rejectUnauthorized: true },
      }),
    );
    expect(test.processJobs).toHaveBeenCalledExactlyOnceWith(test.database, {
      claimOwner: "cloudflare:synthetic-invocation",
      limit: 1,
    });
    expect(test.database.close).toHaveBeenCalledTimes(1);
    expect(test.logger.info).toHaveBeenCalledWith({
      code: "CPL_HOSTED_JOBS_COMPLETE",
      claimed: 1,
      completed: 1,
      retried: 0,
      failed: 0,
    });
  });

  it("cannot accidentally use the web credential or start without a scheduler credential", async () => {
    const test = fixture();
    await expect(
      test.scheduled({}, { DATABASE_URL: "postgres://synthetic.invalid/web" }),
    ).rejects.toThrow("CPL_WORKER_DATABASE_UNCONFIGURED");
    expect(test.createDatabase).not.toHaveBeenCalled();
    expect(test.processJobs).not.toHaveBeenCalled();
  });

  it("closes on failure, reports scheduler failure, and redacts the original error", async () => {
    const test = fixture();
    test.processJobs.mockRejectedValue(new Error("synthetic-private-job-content"));
    await expect(
      test.scheduled({}, { CPL_WORKER_DATABASE_URL: syntheticDatabase }),
    ).rejects.toThrow("CPL_HOSTED_JOBS_FAILED");
    expect(test.database.close).toHaveBeenCalledTimes(1);
    expect(test.logger.error).toHaveBeenCalledWith({ code: "CPL_HOSTED_JOBS_FAILED" });
    expect(JSON.stringify(test.logger.error.mock.calls)).not.toContain(
      "synthetic-private-job-content",
    );
  });

  it("reports cleanup failure without exposing database details", async () => {
    const test = fixture();
    test.database.close.mockRejectedValue(new Error("synthetic-private-connection-string"));
    await expect(
      test.scheduled({}, { CPL_WORKER_DATABASE_URL: syntheticDatabase }),
    ).rejects.toThrow("CPL_HOSTED_JOBS_CONNECTION_CLOSE_FAILED");
    expect(JSON.stringify(test.logger.error.mock.calls)).not.toContain(
      "synthetic-private-connection-string",
    );
  });

  it("exposes no HTTP job trigger", async () => {
    const response = handler.fetch(
      new Request("https://synthetic.invalid/run", { method: "POST" }),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects unverified TLS modes, local certificate loading, and malformed credentials", () => {
    for (const value of [
      undefined,
      "https://database.invalid/test",
      "postgres://database.invalid/test",
      syntheticDatabase + "?sslmode=disable",
      syntheticDatabase + "?sslmode=no-verify",
      syntheticDatabase + "?sslrootcert=private.pem",
      syntheticDatabase + "?sslmode=require&uselibpqcompat=true",
      syntheticDatabase + "?SSLMODE=disable",
    ])
      expect(() => workerDatabaseConnectionString(value)).toThrow(
        "CPL_WORKER_DATABASE_UNCONFIGURED",
      );
    expect(workerDatabaseConnectionString(syntheticDatabase + "?sslmode=verify-full")).toBe(
      syntheticDatabase,
    );
  });
});
