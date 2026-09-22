import { describe, expect, it, vi } from "vitest";
import handler from "../../apps/worker/cloudflare-worker.mjs";
import {
  createHostedScheduledHandler,
  workerDatabaseConnectionString,
} from "../../apps/worker/cloudflare-scheduler.mjs";

const syntheticDatabase = "postgres://worker:synthetic@database.invalid/test";
const syntheticHyperdriveHost = "0123456789abcdef0123456789abcdef.hyperdrive.local";
const syntheticFrontendDatabase = "3".repeat(32);
const syntheticFrontendUser = "1".repeat(32);
const syntheticHyperdriveUrl = new URL(
  `postgresql://${syntheticHyperdriveHost}:5432/${syntheticFrontendDatabase}?sslmode=disable`,
);
syntheticHyperdriveUrl.username = syntheticFrontendUser;
syntheticHyperdriveUrl.password = "synthetic";
const syntheticHyperdrive = {
  host: syntheticHyperdriveHost,
  port: 5432,
  database: syntheticFrontendDatabase,
  user: syntheticFrontendUser,
  password: "synthetic",
  connectionString: syntheticHyperdriveUrl.toString(),
};
const serverDeadlines = {
  rows: [{ statement_timeout_ms: 4000, idle_timeout_ms: 4000 }],
  rowCount: 1,
};

function environment(transport) {
  return transport === "hyperdrive"
    ? { CPL_DATABASE_TRANSPORT: "hyperdrive", CPL_JOBS_DB: syntheticHyperdrive }
    : { CPL_DATABASE_TRANSPORT: "direct", CPL_WORKER_DATABASE_URL: syntheticDatabase };
}

function fixture(overrides = {}) {
  const database = {
    kind: "postgres",
    query: vi.fn().mockResolvedValue(serverDeadlines),
    transaction: vi.fn((operation) => operation(database)),
    close: vi.fn().mockResolvedValue(undefined),
  };
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
    expect(test.database.query).not.toHaveBeenCalled();
    expect(test.logger.info).toHaveBeenCalledExactlyOnceWith(
      '{"code":"CPL_HOSTED_JOBS_COMPLETE","claimed":1,"completed":1,"retried":0,"failed":0}',
    );
  });

  it.each([
    { claimed: 0, completed: 0, retried: 0, failed: 0 },
    { claimed: 1, completed: 1, retried: 0, failed: 0 },
    { claimed: 1, completed: 0, retried: 1, failed: 0 },
    { claimed: 1, completed: 0, retried: 0, failed: 1 },
  ])("retains exact bounded completion counts in one JSON log %#", async (counts) => {
    const test = fixture();
    test.processJobs.mockResolvedValue({
      ...counts,
      privateJobContent: "synthetic-private-job-content",
    });
    await test.scheduled({}, environment("hyperdrive"));
    expect(test.logger.info).toHaveBeenCalledTimes(1);
    expect(test.logger.info.mock.calls[0]).toHaveLength(1);
    const message = test.logger.info.mock.calls[0][0];
    expect(typeof message).toBe("string");
    expect(JSON.parse(message)).toEqual({ code: "CPL_HOSTED_JOBS_COMPLETE", ...counts });
    expect(message).not.toContain("synthetic-private-job-content");
    expect(test.logger.error).not.toHaveBeenCalled();
    expect(test.database.close).toHaveBeenCalledTimes(1);
  });

  it("uses only the worker binding and sets deadlines in the transaction before claim SQL", async () => {
    const test = fixture();
    test.processJobs.mockImplementation(async (database) => {
      await database.transaction((executor) => executor.query("SELECT 'synthetic-claim'"));
      return { claimed: 1, completed: 1, retried: 0, failed: 0 };
    });
    await test.scheduled(
      {},
      {
        ...environment("hyperdrive"),
        CPL_WORKER_DATABASE_URL: "invalid-unselected-direct-credential",
      },
    );
    expect(test.createDatabase).toHaveBeenCalledExactlyOnceWith({
      connectionString: syntheticHyperdrive.connectionString,
      ssl: false,
      max: 1,
      connectionTimeoutMillis: 5_000,
      query_timeout: 5_000,
      statement_timeout: 4_000,
      idle_in_transaction_session_timeout: 4_000,
      options: "-c statement_timeout=4000 -c idle_in_transaction_session_timeout=4000",
      idleTimeoutMillis: 1_000,
      allowExitOnIdle: true,
    });
    expect(test.database.transaction).toHaveBeenCalledTimes(1);
    expect(test.database.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("set_config('statement_timeout','4000ms',true)"),
    );
    expect(test.database.query).toHaveBeenNthCalledWith(2, "SELECT 'synthetic-claim'");
    expect(test.processJobs.mock.calls[0][0]).not.toBe(test.database);
    expect(test.processJobs).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ kind: "postgres" }),
      { claimOwner: "cloudflare:synthetic-invocation", limit: 1 },
    );
    expect(test.database.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing worker binding", { CPL_JOBS_DB: undefined }],
    ["malformed worker binding", { CPL_JOBS_DB: { connectionString: syntheticDatabase } }],
    ["web binding present", { CPL_WEB_DB: syntheticHyperdrive }],
  ])("refuses %s without falling back to a direct credential", async (_label, bindings) => {
    const test = fixture();
    await expect(
      test.scheduled(
        {},
        {
          ...environment("hyperdrive"),
          CPL_WORKER_DATABASE_URL: syntheticDatabase,
          ...bindings,
        },
      ),
    ).rejects.toThrow("CPL_HYPERDRIVE_BINDING_REFUSED");
    expect(test.createDatabase).not.toHaveBeenCalled();
    expect(test.processJobs).not.toHaveBeenCalled();
  });

  it("rejects an unknown transport before opening either database", async () => {
    const test = fixture();
    await expect(
      test.scheduled(
        {},
        {
          ...environment("hyperdrive"),
          CPL_DATABASE_TRANSPORT: "automatic",
          CPL_WORKER_DATABASE_URL: syntheticDatabase,
        },
      ),
    ).rejects.toThrow("CPL_DATABASE_TRANSPORT_REFUSED");
    expect(test.createDatabase).not.toHaveBeenCalled();
  });

  it.each(["missing", "disabled", "weaker", "query failure"])(
    "refuses %s server deadlines, closes the pool, and never executes claim SQL",
    async (failure) => {
      const test = fixture();
      test.processJobs.mockImplementation((database) => database.query("SELECT 'synthetic-claim'"));
      if (failure === "query failure")
        test.database.query.mockRejectedValue(new Error("synthetic-private-deadline-error"));
      else
        test.database.query.mockResolvedValue({
          rows:
            failure === "missing"
              ? []
              : [
                  {
                    statement_timeout_ms: failure === "disabled" ? 0 : 4001,
                    idle_timeout_ms: 4000,
                  },
                ],
        });
      await expect(test.scheduled({}, environment("hyperdrive"))).rejects.toThrow(
        "CPL_HOSTED_JOBS_FAILED",
      );
      expect(test.database.transaction).toHaveBeenCalledTimes(1);
      expect(test.database.query).toHaveBeenCalledTimes(1);
      expect(test.database.query.mock.calls[0][0]).toContain("set_config('statement_timeout'");
      expect(test.database.close).toHaveBeenCalledTimes(1);
      expect(test.logger.error).toHaveBeenCalledExactlyOnceWith({ code: "CPL_HOSTED_JOBS_FAILED" });
      expect(JSON.stringify(test.logger.error.mock.calls)).not.toContain(
        "synthetic-private-deadline-error",
      );
    },
  );

  it("still verifies the live worker role under transaction-local Hyperdrive deadlines", async () => {
    const database = {
      kind: "postgres",
      query: vi.fn().mockResolvedValueOnce(serverDeadlines).mockResolvedValueOnce({ rows: [] }),
      transaction: vi.fn((operation) => operation(database)),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const scheduled = createHostedScheduledHandler({
      createDatabase: () => database,
      logger: { info: vi.fn(), error: vi.fn() },
    });
    await expect(scheduled({}, environment("hyperdrive"))).rejects.toThrow(
      "CPL_HOSTED_JOBS_FAILED",
    );
    expect(database.query).toHaveBeenCalledTimes(2);
    expect(database.query.mock.calls[1][0]).toContain("WITH RECURSIVE inherited");
    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(database.close).toHaveBeenCalledTimes(1);
  });

  it.each(["direct", "hyperdrive"])("closes an empty %s invocation", async (transport) => {
    const test = fixture();
    const empty = { claimed: 0, completed: 0, retried: 0, failed: 0 };
    test.processJobs.mockResolvedValue(empty);
    await expect(test.scheduled({}, environment(transport))).resolves.toEqual(empty);
    expect(test.processJobs).toHaveBeenCalledTimes(1);
    expect(test.database.close).toHaveBeenCalledTimes(1);
  });

  it.each(["direct", "hyperdrive"])(
    "keeps concurrent %s invocations on distinct pools and claim owners",
    async (transport) => {
      const databases = [];
      const test = fixture({
        createDatabase: () => {
          const database = {
            kind: "postgres",
            query: vi.fn().mockResolvedValue(serverDeadlines),
            close: vi.fn().mockResolvedValue(undefined),
          };
          databases.push(database);
          return database;
        },
        claimId: vi.fn().mockReturnValueOnce("first").mockReturnValueOnce("second"),
      });
      await Promise.all([
        test.scheduled({}, environment(transport)),
        test.scheduled({}, environment(transport)),
      ]);
      expect(databases).toHaveLength(2);
      expect(databases[0]).not.toBe(databases[1]);
      for (const database of databases) expect(database.close).toHaveBeenCalledTimes(1);
      const jobDatabases = test.processJobs.mock.calls.map(([database]) => database);
      expect(jobDatabases[0]).not.toBe(jobDatabases[1]);
      if (transport === "direct") expect(jobDatabases).toEqual(databases);
      else for (const database of jobDatabases) expect(databases).not.toContain(database);
      expect(test.processJobs.mock.calls.map(([, options]) => options)).toEqual([
        { claimOwner: "cloudflare:first", limit: 1 },
        { claimOwner: "cloudflare:second", limit: 1 },
      ]);
    },
  );

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
