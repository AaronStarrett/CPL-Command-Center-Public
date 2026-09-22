import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
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
  "SELECT id,attempts,max_attempts FROM cpl_workflow_jobs WHERE (status='queued' AND available_at<=CURRENT_TIMESTAMP) OR (status='running' AND lease_expires_at<=CURRENT_TIMESTAMP) ORDER BY available_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1";
const claimUpdateSql =
  "UPDATE cpl_workflow_jobs SET status='running',attempts=attempts+1,lease_token=$2,lease_owner=$3,lease_expires_at=CURRENT_TIMESTAMP+INTERVAL '30 seconds',updated_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING id,organization_id,proposal_id,proposal_version,issued_by_identity_id,issued_membership_version,attempts,max_attempts";
const draftSql =
  "SELECT id,title,content,version FROM cpl_proposal_drafts WHERE organization_id=$1 AND id=$2 FOR UPDATE";
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

describe("narrow job projections preserve processing and recovery fields", () => {
  const jobId = "10000000-0000-4000-8000-000000000001";
  const organizationId = "10000000-0000-4000-8000-000000000002";
  const proposalId = "10000000-0000-4000-8000-000000000003";
  const identityId = "10000000-0000-4000-8000-000000000004";
  const membershipVersion = 7;
  const expectedDigest = createHash("sha256")
    .update(
      "# Synthetic proposal\n\nProposal draft · version 2\n\nSynthetic manually supplied content\n\n---\nManually supplied content. This draft has not been sent to a customer.\n",
    )
    .digest("hex");

  function processingFixture(mode: string) {
    const f = fixture();
    const baseQuery = f.query.getMockImplementation()!;
    const priorAttempts = mode === "exhausted" ? 3 : mode === "final-attempt" ? 2 : 0;
    let leaseToken: unknown;
    f.query.mockImplementation(async (sql, values = []) => {
      expect(values).not.toContain(undefined);
      if (sql === claimSql)
        return { rows: [{ id: jobId, attempts: priorAttempts, max_attempts: 3 }], rowCount: 1 };
      if (sql === claimUpdateSql) {
        expect(values).toEqual([jobId, expect.any(String), "synthetic-claim"]);
        leaseToken = values[1];
        // Only the eight projected fields are available to subsequent work.
        return {
          rows: [
            {
              id: jobId,
              organization_id: organizationId,
              proposal_id: proposalId,
              proposal_version: mode === "superseded" ? 1 : 2,
              issued_by_identity_id: identityId,
              issued_membership_version: membershipVersion,
              attempts: priorAttempts + 1,
              max_attempts: 3,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql === draftSql) {
        expect(values).toEqual([organizationId, proposalId]);
        return {
          rows:
            mode === "missing-draft"
              ? []
              : [
                  {
                    id: proposalId,
                    title: "Synthetic proposal",
                    content: "Synthetic manually supplied content",
                    version: 2,
                  },
                ],
          rowCount: mode === "missing-draft" ? 0 : 1,
        };
      }
      if (sql.startsWith("SELECT set_config('cpl.organization_id'")) {
        expect(values).toEqual([organizationId, identityId]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("SELECT id FROM cpl_workflow_jobs")) {
        expect(sql).toContain("lease_token=$3 AND lease_expires_at>CURRENT_TIMESTAMP FOR UPDATE");
        expect(values).toEqual([organizationId, jobId, leaseToken]);
        return {
          rows: mode === "lease-lost" ? [] : [{ id: jobId }],
          rowCount: mode === "lease-lost" ? 0 : 1,
        };
      }
      if (sql.startsWith("SELECT m.role,m.version")) {
        expect(values).toEqual([organizationId, identityId]);
        return {
          rows: [
            {
              role: "member",
              version: mode === "revoked" ? membershipVersion + 1 : membershipVersion,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.startsWith("UPDATE cpl_proposal_drafts SET prepared_version")) {
        expect(values).toEqual([
          organizationId,
          proposalId,
          expectedDigest,
          identityId,
          membershipVersion,
        ]);
        if (["retry", "final-attempt"].includes(mode))
          throw new Error("Synthetic processing failure");
        return {
          rows: mode === "revoked-at-write" ? [] : [{ id: proposalId }],
          rowCount: mode === "revoked-at-write" ? 0 : 1,
        };
      }
      if (sql.startsWith("UPDATE cpl_workflow_jobs SET status='completed'")) {
        expect(values).toEqual([organizationId, jobId, leaseToken, expectedDigest]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("INSERT INTO cpl_tenant_audit_events")) {
        expect(values).toEqual([
          expect.any(String),
          organizationId,
          identityId,
          mode === "superseded" ? "proposal.preparation-superseded" : "proposal.prepared",
          proposalId,
        ]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE cpl_workflow_jobs SET status=$3")) {
        const code =
          mode === "revoked" || mode === "revoked-at-write"
            ? "CPL_JOB_AUTHORIZATION_REVOKED"
            : mode === "missing-draft"
              ? "CPL_RECORD_NOT_FOUND"
              : "CPL_JOB_PROCESSING_FAILED";
        expect(values).toEqual([jobId, leaseToken, mode === "retry" ? "queued" : "failed", code]);
        expect(sql).toContain("WHERE id=$1 AND lease_token=$2 AND status='running'");
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("last_error_code='CPL_JOB_RETRY_EXHAUSTED'")) {
        expect(values).toEqual([jobId]);
        return { rows: [], rowCount: 1 };
      }
      return baseQuery(sql, values);
    });
    return f;
  }

  it.each(["prepared", "superseded"])(
    "preserves %s rendering, tenant fencing and audit",
    async (mode) => {
      const f = processingFixture(mode);
      await expect(
        processHostedJobs(f.database, { claimOwner: "synthetic-claim" }),
      ).resolves.toEqual({
        claimed: 1,
        completed: 1,
        retried: 0,
        failed: 0,
      });
      const statements = f.query.mock.calls.map(([sql]) => sql);
      expect(statements).toHaveLength(mode === "prepared" ? 16 : 15);
      expect(statements.filter((sql) => sql === "BEGIN")).toHaveLength(2);
      expect(statements.filter((sql) => sql === "COMMIT")).toHaveLength(2);
      expect(statements.filter((sql) => sql.includes("WITH RECURSIVE inherited"))).toHaveLength(1);
      expect(statements).toContain(claimSql);
      expect(statements).toContain(claimUpdateSql);
      expect(statements).toContain(draftSql);
      expect(
        statements.filter((sql) => sql.startsWith("INSERT INTO cpl_tenant_audit_events")),
      ).toHaveLength(1);
      expect(
        statements.some((sql) => sql.startsWith("UPDATE cpl_proposal_drafts SET prepared_version")),
      ).toBe(mode === "prepared");
      expect(f.connect).toHaveBeenCalledTimes(2);
      expect(f.release).toHaveBeenCalledTimes(2);
      expect(f.standalone).not.toHaveBeenCalled();
    },
  );

  it.each(["revoked", "revoked-at-write", "missing-draft", "retry", "final-attempt"])(
    "preserves %s rollback and fenced terminal/retry transition",
    async (mode) => {
      const f = processingFixture(mode);
      await expect(
        processHostedJobs(f.database, { claimOwner: "synthetic-claim" }),
      ).resolves.toEqual({
        claimed: 1,
        completed: 0,
        retried: mode === "retry" ? 1 : 0,
        failed: mode === "retry" ? 0 : 1,
      });
      const statements = f.query.mock.calls.map(([sql]) => sql);
      const rollbackIndex = statements.indexOf("ROLLBACK");
      expect(rollbackIndex).toBeGreaterThan(0);
      expect(
        statements.findIndex((sql) => sql.startsWith("UPDATE cpl_workflow_jobs SET status=$3")),
      ).toBeGreaterThan(rollbackIndex);
      expect(
        statements.some(
          (sql) =>
            sql.startsWith("INSERT INTO cpl_tenant_audit_events") ||
            sql.startsWith("UPDATE cpl_workflow_jobs SET status='completed'"),
        ),
      ).toBe(false);
      expect(f.connect).toHaveBeenCalledTimes(3);
      expect(f.release).toHaveBeenCalledTimes(3);
    },
  );

  it("uses only projected retry counters for exhaustion without processing", async () => {
    const f = processingFixture("exhausted");
    await expect(processHostedJobs(f.database, { claimOwner: "synthetic-claim" })).resolves.toEqual(
      {
        claimed: 1,
        completed: 0,
        retried: 0,
        failed: 1,
      },
    );
    expect(f.query.mock.calls.some(([sql]) => sql === claimUpdateSql || sql === draftSql)).toBe(
      false,
    );
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("retains lease-loss refusal without unfenced recovery or completion", async () => {
    const f = processingFixture("lease-lost");
    await expect(
      processHostedJobs(f.database, { claimOwner: "synthetic-claim" }),
    ).rejects.toMatchObject({ code: "CPL_JOB_LEASE_LOST" });
    expect(
      f.query.mock.calls.some(
        ([sql]) =>
          sql === draftSql ||
          sql.startsWith("UPDATE cpl_workflow_jobs SET status=$3") ||
          sql.startsWith("INSERT INTO cpl_tenant_audit_events"),
      ),
    ).toBe(false);
    expect(f.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(f.connect).toHaveBeenCalledTimes(2);
    expect(f.release).toHaveBeenCalledTimes(2);
  });
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
