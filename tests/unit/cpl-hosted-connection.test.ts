import { afterEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { SqlExecutor } from "../../packages/database/src/adapter";
import { PgSqlDatabaseAdapter } from "../../packages/database/src/pg-sql-adapter";
import {
  hostedDatabaseTransport,
  hyperdriveConnection,
  hyperdriveTimeoutIntent,
  verifyHyperdriveServerDeadlines,
  withHyperdriveDeadlines,
  type HostedDatabasePurpose,
} from "../../packages/database/src/hosted-connection";

function binding(purpose: HostedDatabasePurpose = "web") {
  const host = "a".repeat(32) + ".hyperdrive.local";
  const user = (purpose === "web" ? "1" : "2").repeat(32);
  const database = (purpose === "web" ? "3" : "4").repeat(32);
  const password = "synthetic:p@ss/with%encoding";
  const url = new URL(`postgresql://${host}:5432/${database}?sslmode=disable`);
  url.username = user;
  url.password = encodeURIComponent(password);
  return {
    host,
    port: 5432,
    database,
    user,
    password,
    connectionString: url.toString(),
  };
}

describe("hosted database transport boundary", () => {
  it("preserves existing direct installations and refuses unknown selectors", () => {
    expect(hostedDatabaseTransport(undefined)).toBe("direct");
    expect(hostedDatabaseTransport("direct")).toBe("direct");
    expect(hostedDatabaseTransport("hyperdrive")).toBe("hyperdrive");
    for (const value of ["", "auto", "Hyperdrive", " direct", "hyperdrive "])
      expect(() => hostedDatabaseTransport(value)).toThrow("CPL_DATABASE_TRANSPORT_REFUSED");
  });

  it.each(["web", "worker"] as const)(
    "accepts generated %s frontend credentials that differ from origin metadata",
    (purpose) => {
      const selected = binding(purpose);
      expect(selected.database).not.toBe("cpl_command_center");
      expect(selected.user).not.toBe(purpose === "web" ? "cpl_web_runtime" : "cpl_worker_runtime");
      const bindings = purpose === "web" ? { CPL_WEB_DB: selected } : { CPL_JOBS_DB: selected };
      expect(hyperdriveConnection(bindings, purpose)).toEqual({
        connectionString: selected.connectionString,
        ssl: false,
      });
    },
  );

  it("refuses a missing, wrong-name or mixed-purpose binding rather than using another credential", () => {
    for (const bindings of [
      {},
      { CPL_JOBS_DB: binding("worker") },
      { CPL_WEB_DB: binding(), CPL_JOBS_DB: binding("worker") },
      { CPL_WEB_DB: binding().connectionString },
      { CPL_WEB_DB: null },
    ])
      expect(() => hyperdriveConnection(bindings, "web")).toThrow("CPL_HYPERDRIVE_BINDING_REFUSED");
    expect(() => hyperdriveConnection({ CPL_WEB_DB: binding() }, "worker")).toThrow(
      "CPL_HYPERDRIVE_BINDING_REFUSED",
    );
  });

  it("also accepts self-consistent local-development origin fields", () => {
    const selected = binding();
    selected.user = "cpl_web_runtime";
    selected.database = "cpl_command_center";
    const url = new URL(selected.connectionString);
    url.username = selected.user;
    url.pathname = "/" + selected.database;
    selected.connectionString = url.toString();
    expect(hyperdriveConnection({ CPL_WEB_DB: selected }, "web").connectionString).toBe(
      selected.connectionString,
    );
  });

  it.each(["user", "database", "password"] as const)(
    "refuses empty, oversized or control-bearing frontend %s even when the URI agrees",
    (field) => {
      for (const value of ["", "x".repeat(1025), "synthetic\u0000value", "synthetic\nvalue"]) {
        const selected = binding();
        selected[field] = value;
        const url = new URL(selected.connectionString);
        if (field === "user") url.username = encodeURIComponent(value);
        else if (field === "password") url.password = encodeURIComponent(value);
        else url.pathname = "/" + encodeURIComponent(value);
        selected.connectionString = url.toString();
        expect(() => hyperdriveConnection({ CPL_WEB_DB: selected }, "web")).toThrow(
          "CPL_HYPERDRIVE_BINDING_REFUSED",
        );
      }
    },
  );

  it.each([
    ["host", "remote.example.test"],
    ["host", "a.hyperdrive.local"],
    ["host", "a".repeat(32) + ".hyperdrive.local.example.test"],
    ["port", 5433],
    ["port", "5432"],
    ["database", "other_database"],
    ["user", "cpl_worker_runtime"],
    ["password", "different-credential"],
    ["password", ""],
  ])("rejects mismatched or unreviewed binding field %s=%s", (name, value) => {
    expect(() =>
      hyperdriveConnection({ CPL_WEB_DB: { ...binding(), [name!]: value } }, "web"),
    ).toThrow("CPL_HYPERDRIVE_BINDING_REFUSED");
  });

  it.each([
    (url: string) => url.replace("postgresql:", "https:"),
    (url: string) => url.replace("1".repeat(32) + ":", "2".repeat(32) + ":"),
    (url: string) => url.replace("a".repeat(32), "b".repeat(32)),
    (url: string) => url.replace(":5432/", ":5433/"),
    (url: string) => url.replace("/" + "3".repeat(32) + "?", "/other_database?"),
    (url: string) => url.replace("sslmode=disable", "sslmode=require"),
    (url: string) => url + "&sslmode=disable",
    (url: string) => url + "&options=-c%20role%3Dpostgres",
    (url: string) => url + "#unreviewed",
    (url: string) => " " + url,
  ])("refuses altered connection URI metadata (%#)", (change) => {
    const selected = binding();
    selected.connectionString = change(selected.connectionString);
    expect(() => hyperdriveConnection({ CPL_WEB_DB: selected }, "web")).toThrow(
      "CPL_HYPERDRIVE_BINDING_REFUSED",
    );
  });

  it("never includes an invalid binding value or getter error in a refusal", () => {
    const selected = {
      get connectionString(): string {
        throw new Error("private synthetic connection material");
      },
    };
    expect(() => hyperdriveConnection({ CPL_WEB_DB: selected }, "web")).toThrow(
      /^CPL_HYPERDRIVE_BINDING_REFUSED$/u,
    );
  });
});

describe("Hyperdrive deadlines share the operation's transaction", () => {
  const adapters: PgSqlDatabaseAdapter[] = [];
  function fixture(purpose: HostedDatabasePurpose = "web") {
    const milliseconds = purpose === "web" ? 15000 : 4000;
    const base = new PgSqlDatabaseAdapter({ max: 1 });
    adapters.push(base);
    const query = vi.fn<
      (
        sql: string,
        parameters?: readonly unknown[],
      ) => Promise<{
        rows: Record<string, unknown>[];
        rowCount: number;
      }>
    >(async (sql: string) =>
      sql.includes("set_config('statement_timeout'")
        ? {
            rows: [{ statement_timeout_ms: milliseconds, idle_timeout_ms: milliseconds }],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 },
    );
    const release = vi.fn();
    const connect = vi
      .spyOn(base.pool, "connect")
      .mockImplementation(async () => ({ query, release }) as unknown as PoolClient);
    const standalone = vi
      .spyOn(base.pool, "query")
      .mockRejectedValue(new Error("unguarded pool query"));
    return {
      base,
      query,
      connect,
      release,
      standalone,
      wrapped: withHyperdriveDeadlines(base, purpose),
    };
  }
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const adapter of adapters.splice(0)) await adapter.close();
  });

  it("sets local deadlines once inside the same BEGIN as a multi-query transaction", async () => {
    const f = fixture();
    await f.wrapped.transaction(async (executor) => {
      await executor.query("SELECT set_config('cpl.organization_id',$1,true)", ["synthetic-org"]);
      await executor.query("SELECT 1 AS tenant_work");
    });
    const statements = f.query.mock.calls.map(([sql]) => sql);
    expect(statements[0]).toBe("BEGIN");
    expect(statements[1]).toContain("set_config('statement_timeout','15000ms',true)");
    expect(f.query).toHaveBeenNthCalledWith(2, expect.any(String), []);
    expect(statements.slice(2)).toEqual([
      "SELECT set_config('cpl.organization_id',$1,true)",
      "SELECT 1 AS tenant_work",
      "COMMIT",
    ]);
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(f.standalone).not.toHaveBeenCalled();
  });

  it.each(["web", "worker"] as const)(
    "uses only the fixed %s deadline SQL without protocol bind parameters",
    async (purpose) => {
      const f = fixture(purpose);
      const value = purpose === "web" ? "15000ms" : "4000ms";
      await f.wrapped.query("SELECT 1 AS guarded_work");
      const [sql, parameters] = f.query.mock.calls[1]!;
      expect(sql).toBe(
        `SELECT (extract(epoch FROM set_config('statement_timeout','${value}',true)::interval)*1000)::integer AS statement_timeout_ms,
            (extract(epoch FROM set_config('idle_in_transaction_session_timeout','${value}',true)::interval)*1000)::integer AS idle_timeout_ms`,
      );
      expect(parameters).toEqual([]);
      expect(sql).not.toMatch(/\$[12]/u);
      expect(f.query.mock.calls.map(([statement]) => statement)).toEqual([
        "BEGIN",
        sql,
        "SELECT 1 AS guarded_work",
        "COMMIT",
      ]);
    },
  );

  it.each(["", "other", "web'; SELECT 1--"])(
    "refuses unreviewed purpose %s before SQL",
    (purpose) => {
      const f = fixture();
      expect(() => withHyperdriveDeadlines(f.base, purpose as HostedDatabasePurpose)).toThrow(
        "CPL_HYPERDRIVE_BINDING_REFUSED",
      );
      expect(f.connect).not.toHaveBeenCalled();
    },
  );

  it.each(
    [
      [],
      [
        { statement_timeout_ms: 15000, idle_timeout_ms: 15000 },
        { statement_timeout_ms: 15000, idle_timeout_ms: 15000 },
      ],
      [{ statement_timeout_ms: 0, idle_timeout_ms: 15000 }],
      [{ statement_timeout_ms: 15001, idle_timeout_ms: 15000 }],
      [{ statement_timeout_ms: 15000, idle_timeout_ms: 0 }],
      [{ statement_timeout_ms: 15000, idle_timeout_ms: 15001 }],
      [{ statement_timeout_ms: "15000", idle_timeout_ms: 15000 }],
    ].map((rows) => ({ rows })),
  )("retains exact deadline readback refusal for malformed result %#", async ({ rows }) => {
    const f = fixture();
    f.query.mockImplementation(async () => ({ rows, rowCount: rows.length }));
    const operation = vi.fn();
    await expect(f.wrapped.transaction(operation)).rejects.toThrow(
      "CPL_HYPERDRIVE_SERVER_DEADLINES_REFUSED",
    );
    expect(operation).not.toHaveBeenCalled();
    expect(f.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(f.release).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("wraps each standalone query and execute in its own initialized transaction", async () => {
    const f = fixture();
    await f.wrapped.query("SELECT 1 AS first_operation");
    await f.wrapped.execute("SELECT 2 AS second_operation");
    const statements = f.query.mock.calls.map(([sql]) => sql);
    expect(statements.filter((sql) => sql === "BEGIN")).toHaveLength(2);
    expect(statements.filter((sql) => sql.includes("set_config('statement_timeout'"))).toHaveLength(
      2,
    );
    expect(statements.filter((sql) => sql === "COMMIT")).toHaveLength(2);
    expect(f.connect).toHaveBeenCalledTimes(2);
    expect(f.release).toHaveBeenCalledTimes(2);
    expect(f.standalone).not.toHaveBeenCalled();
  });

  it("refuses failed setup before application SQL and delegates rollback/release", async () => {
    const f = fixture();
    f.query.mockImplementation(async (sql) => {
      if (sql.includes("set_config('statement_timeout'")) throw new Error("private SQL details");
      return { rows: [], rowCount: 0 };
    });
    const operation = vi.fn();
    await expect(f.wrapped.transaction(operation)).rejects.toThrow(
      /^CPL_HYPERDRIVE_SERVER_DEADLINES_REFUSED$/u,
    );
    expect(operation).not.toHaveBeenCalled();
    expect(f.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(f.release).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("preserves application errors and failed-rollback connection disposal", async () => {
    const f = fixture();
    const original = new Error("synthetic application failure");
    f.query.mockImplementation(async (sql) => {
      if (sql === "ROLLBACK") throw new Error("synthetic disconnect");
      return { rows: [{ statement_timeout_ms: 15000, idle_timeout_ms: 15000 }], rowCount: 1 };
    });
    await expect(
      f.wrapped.transaction(async () => {
        throw original;
      }),
    ).rejects.toBe(original);
    expect(f.release).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "PostgreSQL rollback failed; discard connection.",
      }),
    );
  });

  it("guards health queries and propagates close errors through the original pool", async () => {
    const f = fixture();
    expect(await f.wrapped.health()).toMatchObject({ status: "healthy", adapter: "postgres" });
    expect(f.query.mock.calls[2]?.[0]).toBe("SELECT 1 AS healthy");
    const failure = new Error("synthetic close failure");
    vi.spyOn(f.base, "close").mockRejectedValue(failure);
    await expect(f.wrapped.close()).rejects.toBe(failure);
  });

  it.each(["web", "worker"] as const)(
    "executes %s deadline SQL and resets local state after commit and both rollback paths in PGlite",
    async (purpose) => {
      // SQL semantics only: this is not real PostgreSQL, Hyperdrive or CPU evidence.
      const { PGlite } = await import("@electric-sql/pglite");
      const sqlDatabase = await PGlite.create();
      const f = fixture(purpose);
      f.query.mockImplementation(async (sql, parameters) => {
        const result = await sqlDatabase.query<Record<string, unknown>>(sql, [
          ...(parameters ?? []),
        ]);
        return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
      });
      const settings = "SELECT setting FROM pg_settings WHERE name='statement_timeout'";
      try {
        const before = (await sqlDatabase.query<{ setting: string }>(settings)).rows[0]?.setting;
        const during = await f.wrapped.query<{ setting: string }>(settings);
        expect(during.rows[0]?.setting).toBe(purpose === "web" ? "15000" : "4000");
        expect((await sqlDatabase.query<{ setting: string }>(settings)).rows[0]?.setting).toBe(
          before,
        );
        const failure = new Error("synthetic application rollback");
        await expect(
          f.wrapped.transaction(async (executor) => {
            await executor.query("SELECT set_config('cpl.organization_id',$1,true)", [
              "synthetic-org",
            ]);
            throw failure;
          }),
        ).rejects.toBe(failure);
        expect((await sqlDatabase.query<{ setting: string }>(settings)).rows[0]?.setting).toBe(
          before,
        );
        await expect(f.wrapped.query("SELECT 1/0")).rejects.toThrow();
        expect((await sqlDatabase.query<{ setting: string }>(settings)).rows[0]?.setting).toBe(
          before,
        );
        expect(
          (
            await sqlDatabase.query<{ value: string }>(
              "SELECT current_setting('cpl.organization_id',true) AS value",
            )
          ).rows[0]?.value ?? "",
        ).toBe("");
      } finally {
        await sqlDatabase.close();
      }
    },
  );
});

describe("Hyperdrive server deadline preflight", () => {
  function executor(settings = ["15000", "15000"]) {
    return {
      query: vi.fn(async () => ({
        rows: [
          { name: "statement_timeout", setting: settings[0], unit: "ms" },
          { name: "idle_in_transaction_session_timeout", setting: settings[1], unit: "ms" },
        ],
      })),
    };
  }

  it.each(["web", "worker"] as const)("requires finite %s startup deadlines", async (purpose) => {
    const intent = hyperdriveTimeoutIntent(purpose);
    const milliseconds = purpose === "web" ? 15000 : 4000;
    expect(intent).toEqual({
      statement_timeout: milliseconds,
      idle_in_transaction_session_timeout: milliseconds,
      options: `-c statement_timeout=${milliseconds} -c idle_in_transaction_session_timeout=${milliseconds}`,
    });
    const database = executor([String(milliseconds), String(milliseconds)]);
    await verifyHyperdriveServerDeadlines(database as unknown as SqlExecutor, purpose);
    expect(database.query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("pg_settings"));
  });

  it.each(["0", "15001", "15s", "-1", "NaN", "9007199254740992"])(
    "refuses disabled, weaker or invalid server deadline %s",
    async (setting) => {
      await expect(
        verifyHyperdriveServerDeadlines(
          executor([setting, "15000"]) as unknown as SqlExecutor,
          "web",
        ),
      ).rejects.toThrow("CPL_HYPERDRIVE_SERVER_DEADLINES_REFUSED");
    },
  );

  it("refuses missing rows and query failures without leaking database diagnostics", async () => {
    for (const query of [
      vi.fn(async () => ({ rows: [] })),
      vi.fn(async () => {
        throw new Error("private synthetic query error");
      }),
    ]) {
      await expect(
        verifyHyperdriveServerDeadlines({ query } as unknown as SqlExecutor, "worker"),
      ).rejects.toThrow(/^CPL_HYPERDRIVE_SERVER_DEADLINES_REFUSED$/u);
    }
    await expect(
      verifyHyperdriveServerDeadlines(executor() as unknown as SqlExecutor, "worker"),
    ).rejects.toThrow("CPL_HYPERDRIVE_SERVER_DEADLINES_REFUSED");
  });
});
