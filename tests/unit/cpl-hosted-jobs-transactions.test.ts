import { afterEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { DatabaseAdapter } from "../../packages/database/src/adapter";
import { PgSqlDatabaseAdapter } from "../../packages/database/src/pg-sql-adapter";
import { withHyperdriveDeadlines } from "../../packages/database/src/hosted-connection";
import { processHostedJobs } from "../../packages/database/src/hosted-workflow";
import { verifyHostedDatabaseRole } from "../../packages/database/src/hosted-database-role";

const deniedPrivileges = [
  "rolsuper",
  "rolbypassrls",
  "rolcreatedb",
  "rolcreaterole",
  "rolreplication",
  "owns_database",
  "owns_schema",
  "owns_application_tables",
  "schema_create",
  "elevated_membership",
  "can_change_role_registry",
  "can_read_legacy_leads",
] as const;
const safeRole = {
  rolname: "cpl_worker_runtime",
  purpose: "worker",
  tenant_tables_protected: true,
  ...Object.fromEntries(deniedPrivileges.map((name) => [name, false])),
};
const claimSql =
  "SELECT * FROM cpl_workflow_jobs WHERE (status='queued' AND available_at<=CURRENT_TIMESTAMP) OR (status='running' AND lease_expires_at<=CURRENT_TIMESTAMP) ORDER BY available_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1";
const adapters: PgSqlDatabaseAdapter[] = [];
function fixture(transport: "direct" | "hyperdrive" = "hyperdrive") {
  const base = new PgSqlDatabaseAdapter({ max: 1 });
  adapters.push(base);
  const roleRows: Record<string, unknown>[] = [{ ...safeRole }];
  const query = vi.fn<
    (
      sql: string,
      values?: readonly unknown[],
    ) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>
  >(async (sql) => {
    if (sql.includes("set_config('statement_timeout'"))
      return { rows: [{ statement_timeout_ms: 4000, idle_timeout_ms: 4000 }], rowCount: 1 };
    if (sql.includes("WITH RECURSIVE inherited"))
      return { rows: roleRows, rowCount: roleRows.length };
    if (["BEGIN", "COMMIT", "ROLLBACK", claimSql].includes(sql)) return { rows: [], rowCount: 0 };
    throw new Error("Unexpected fixture SQL");
  });
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  // A second checkout would deadlock a real max-one pool. Refuse it immediately.
  const connect = vi.spyOn(base.pool, "connect").mockImplementation(async () => {
    if (connect.mock.calls.length > release.mock.calls.length + 1)
      throw new Error("Nested checkout refused");
    return client;
  });
  const standalone = vi
    .spyOn(base.pool, "query")
    .mockRejectedValue(new Error("Standalone role query refused"));
  return {
    base,
    roleRows,
    query,
    connect,
    release,
    standalone,
    database: transport === "hyperdrive" ? withHyperdriveDeadlines(base, "worker") : base,
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const database of adapters.splice(0)) await database.close();
});

describe("hosted claim verifies its actual role inside the same transaction", () => {
  it.each(["direct", "hyperdrive"] as const)(
    "keeps the %s empty claim bounded to one checkout with role verification before locks",
    async (transport) => {
      const f = fixture(transport);
      await expect(
        processHostedJobs(f.database, { claimOwner: "synthetic-claim", limit: 1 }),
      ).resolves.toEqual({ claimed: 0, completed: 0, retried: 0, failed: 0 });
      const statements = f.query.mock.calls.map(([sql]) => sql);
      expect(statements).toHaveLength(transport === "hyperdrive" ? 5 : 4);
      expect(statements[0]).toBe("BEGIN");
      if (transport === "hyperdrive")
        expect(statements[1]).toContain("set_config('statement_timeout','4000ms',true)");
      expect(statements.at(-3)).toContain("WITH RECURSIVE inherited");
      expect(statements.at(-2)).toBe(claimSql);
      expect(statements.at(-1)).toBe("COMMIT");
      expect(f.query.mock.calls.every(([, values]) => !values?.length)).toBe(true);
      expect(f.connect).toHaveBeenCalledOnce();
      expect(f.release).toHaveBeenCalledExactlyOnceWith(undefined);
      expect(f.standalone).not.toHaveBeenCalled();
    },
  );

  it.each(deniedPrivileges)(
    "retains fail-closed %s checks before any claim SQL",
    async (privilege) => {
      for (const value of [true, null, undefined]) {
        const f = fixture();
        f.roleRows[0] = { ...safeRole, [privilege]: value };
        await expect(
          processHostedJobs(f.database, { claimOwner: "synthetic-claim" }),
        ).rejects.toThrow("CPL_HOSTED_DATABASE_ROLE_REFUSED");
        expect(
          f.query.mock.calls.some(
            ([sql]) => sql.includes("FOR UPDATE") || sql.startsWith("UPDATE"),
          ),
        ).toBe(false);
        expect(f.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
        expect(f.connect).toHaveBeenCalledOnce();
        expect(f.release).toHaveBeenCalledExactlyOnceWith(undefined);
        expect(f.standalone).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    { rows: [] },
    { rows: [{ ...safeRole, purpose: "web" }] },
    { rows: [{ ...safeRole, purpose: undefined }] },
    { rows: [{ ...safeRole, tenant_tables_protected: false }] },
    { rows: [{ ...safeRole, tenant_tables_protected: null }] },
  ])("retains purpose, role presence and forced-RLS refusal %#", async ({ rows }) => {
    const f = fixture();
    f.roleRows.splice(0, 1, ...rows);
    await expect(processHostedJobs(f.database, { claimOwner: "synthetic-claim" })).rejects.toThrow(
      "CPL_HOSTED_DATABASE_ROLE_REFUSED",
    );
    expect(f.query.mock.calls.some(([sql]) => sql === claimSql)).toBe(false);
    expect(f.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(f.release).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("rolls back a failed claim and disposes the connection if rollback also fails", async () => {
    const f = fixture();
    const original = new Error("synthetic claim failure");
    const query = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (sql, values) => {
      if (sql === claimSql) throw original;
      if (sql === "ROLLBACK") throw new Error("synthetic connection loss");
      return query(sql, values);
    });
    await expect(processHostedJobs(f.database, { claimOwner: "synthetic-claim" })).rejects.toBe(
      original,
    );
    expect(f.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
    expect(f.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(f.release).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "PostgreSQL rollback failed; discard connection." }),
    );
    expect(f.standalone).not.toHaveBeenCalled();
  });

  it("rejects non-PostgreSQL before starting the claim transaction", async () => {
    const f = fixture();
    const database = { ...f.database, kind: "pglite" } as DatabaseAdapter;
    await expect(processHostedJobs(database, { claimOwner: "synthetic-claim" })).rejects.toThrow(
      "CPL_HOSTED_POSTGRES_REQUIRED",
    );
    await expect(verifyHostedDatabaseRole(database, "worker")).rejects.toThrow(
      "CPL_HOSTED_POSTGRES_REQUIRED",
    );
    expect(f.connect).not.toHaveBeenCalled();
  });
});
