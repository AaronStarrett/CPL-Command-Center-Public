import { describe, expect, it } from "vitest";
import type {
  DatabaseAdapter,
  DatabaseResult,
  SqlExecutor,
} from "../../packages/database/src/adapter";
import {
  SqlCplTenantRepository,
  type CplModuleKey,
} from "../../packages/database/src/tenant-repository";
import { SqlCplWorkflowRepository } from "../../packages/database/src/hosted-workflow";
import { SqlCplHostedAuthStore } from "../../packages/database/src/hosted-auth-store";
import { withHyperdriveDeadlines } from "../../packages/database/src/hosted-connection";
import { withHostedWebRoleGuard } from "../../packages/database/src/hosted-web-role-guard";
import { verifyHostedDatabaseRole } from "../../packages/database/src/hosted-database-role";

const organizationId = "11111111-1111-4111-8111-111111111111";
const identityId = "22222222-2222-4222-8222-222222222222";
const request = { organizationId, sessionToken: "a".repeat(43) };
const initialTime = Date.parse("2026-09-22T20:00:00.000Z");
const expiry = initialTime + 60_000;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(membershipCount = 1) {
  const commands: { sql: string; parameters: readonly unknown[] }[] = [];
  const state = {
    time: initialTime,
    revoked: false,
    identity: true,
    membership: true,
    role: "member",
    roleUnsafe: false,
    intake: true,
    proposal: true,
    allowance: null as number | null,
    context: "",
    failure: "",
    malformed: false,
    before: async (sql: string) => {
      if (!sql) throw Error("Expected SQL");
    },
    committed: () => {},
  };
  const executor: SqlExecutor = {
    async query<Row extends Record<string, unknown>>(
      sql: string,
      parameters: readonly unknown[] = [],
    ): Promise<DatabaseResult<Row>> {
      commands.push({ sql, parameters });
      await state.before(sql);
      if (state.failure && sql.includes(state.failure)) throw Error("Synthetic SQL failure");
      let rows: Record<string, unknown>[] = [];
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) rows = [];
      else if (sql.includes("set_config('statement_timeout'"))
        rows = [{ statement_timeout_ms: 15000, idle_timeout_ms: 15000 }];
      else if (sql.includes("WITH RECURSIVE inherited"))
        rows = [
          {
            rolname: "cpl_web_runtime",
            purpose: "web",
            tenant_tables_protected: true,
            ...Object.fromEntries(
              [
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
              ].map((key) => [key, key === "rolsuper" && state.roleUnsafe]),
            ),
          },
        ];
      else if (sql.includes("SELECT s.*"))
        rows = [
          {
            id: identityId,
            identity_id: identityId,
            issuer: "https://accounts.google.com",
            subject: "synthetic",
            email: "synthetic@example.invalid",
            display_name: "Synthetic",
            created_at: new Date(initialTime).toISOString(),
            authenticated_at: new Date(initialTime).toISOString(),
            expires_at: new Date(expiry).toISOString(),
            absolute_expires_at: new Date(expiry + 60_000).toISOString(),
            selected_organization_id: organizationId,
            csrf_token_hash: "b".repeat(64),
            mfa_verified_at: null,
            platform_administrator: false,
          },
        ];
      else if (sql.includes("SELECT s.id AS session_id"))
        rows = [
          {
            session_id: identityId,
            identity_id: identityId,
            revoked_at: state.revoked ? new Date(initialTime).toISOString() : null,
            identity_status: state.identity ? "active" : "suspended",
            expires_at: new Date(expiry).toISOString(),
          },
        ];
      else if (sql.includes("set_config('cpl.organization_id'")) {
        state.context = sql.includes("organization_id','',true") ? "" : String(parameters[0]);
      } else if (sql.includes("SELECT organization_id FROM cpl_memberships"))
        rows = Array.from({ length: membershipCount }, (_, index) => ({
          organization_id: index === 0 ? organizationId : "33333333-3333-4333-8333-333333333333",
        }));
      else if (sql.includes("SELECT * FROM cpl_organizations"))
        rows = [
          { id: parameters[0], slug: "synthetic", display_name: "Synthetic", status: "active" },
        ];
      else if (sql.includes("AS protected FROM pg_class")) rows = [{ protected: true }];
      else if (/SELECT (?:id,name|id,customer_id,name|m.identity_id,i.display_name)/u.test(sql)) {
        expect(state.context).toBe(organizationId);
        expect(parameters[0]).toBe(organizationId);
        rows = [];
      } else if (sql.includes("SELECT m.identity_id")) rows = [{ identity_id: identityId }];
      else if (sql.includes("SELECT m.role,m.version"))
        rows = state.membership ? [{ role: state.role, version: 1 }] : [];
      else if (sql.includes("SELECT enabled,usage_limit"))
        rows = [
          {
            enabled: parameters[1] === "intake-job-tracker" ? state.intake : state.proposal,
            usage_limit: state.allowance,
          },
        ];
      else if (/SELECT \* FROM cpl_(workflow_leads|proposal_drafts|workflow_jobs)/u.test(sql)) {
        expect(state.context).toBe(organizationId);
        expect(parameters[0]).toBe(organizationId);
        expect(sql).toContain("ORDER BY created_at DESC,id LIMIT 100");
        if (state.malformed) rows = [{ created_at: "invalid", updated_at: "invalid" }];
      } else throw Error("Unexpected synthetic SQL");
      return { rows: rows as Row[], rowCount: rows.length };
    },
    async execute(sql) {
      await executor.query(sql);
    },
  };
  let pending = Promise.resolve();
  const base: DatabaseAdapter = {
    kind: "postgres",
    ...executor,
    async transaction(operation) {
      const previous = pending,
        released = deferred();
      pending = released.promise;
      await previous;
      await executor.query("BEGIN");
      try {
        const value = await operation(executor);
        await executor.query("COMMIT");
        state.committed();
        return value;
      } catch (error) {
        await executor.query("ROLLBACK");
        throw error;
      } finally {
        state.context = "";
        released.resolve();
      }
    },
    async close() {},
    async health() {
      return {
        status: "healthy",
        adapter: "postgres",
        checkedAt: new Date(initialTime).toISOString(),
        latencyMs: 0,
      };
    },
  };
  const database = withHostedWebRoleGuard(withHyperdriveDeadlines(base, "web"));
  const tenants = new SqlCplTenantRepository(database, { now: () => new Date(state.time) });
  return {
    state,
    commands,
    base,
    database,
    tenants,
    workflow: new SqlCplWorkflowRepository(database, tenants),
  };
}
const business = (sql: string) =>
  /SELECT \* FROM cpl_(workflow_leads|proposal_drafts|workflow_jobs)/u.test(sql);
const emptyWorkspace = {
  leads: [],
  proposals: [],
  jobs: [],
  intakeDirectory: { customers: [], contacts: [], sites: [], members: [] },
  permissions: {
    canCreateLead: true,
    canEditLead: true,
    canReviewLead: false,
    canCreateProposal: true,
    canEditProposal: true,
  },
};
describe("workspace transaction authorization and failure boundaries", () => {
  it.each([
    "intake",
    "proposal",
    "allowance",
    "revoked",
    "identity",
    "membership",
    "role",
    "expired",
    "roleUnsafe",
  ])("denies %s before any business read", async (condition) => {
    const f = fixture();
    if (condition === "intake") f.state.intake = false;
    if (condition === "proposal") f.state.proposal = false;
    if (condition === "allowance") f.state.allowance = 0;
    if (condition === "revoked") f.state.revoked = true;
    if (condition === "identity") f.state.identity = false;
    if (condition === "membership") f.state.membership = false;
    if (condition === "role") f.state.role = "unrecognized";
    if (condition === "expired") f.state.time = expiry;
    if (condition === "roleUnsafe") f.state.roleUnsafe = true;
    await expect(f.workflow.readWorkspace(request)).rejects.toThrow();
    expect(f.commands.filter((x) => business(x.sql))).toHaveLength(0);
    expect(f.commands.at(-1)?.sql).toBe("ROLLBACK");
    expect(f.state.context).toBe("");
  });
  it.each([[], ["proposal-builder", "proposal-builder"], ["unrecognized"], null])(
    "refuses malformed module set %j without starting SQL",
    async (modules) => {
      const f = fixture();
      await expect(
        f.tenants.withTenantReadTransaction(
          request,
          modules as readonly CplModuleKey[],
          async () => null,
        ),
      ).rejects.toThrow();
      expect(f.commands).toHaveLength(0);
    },
  );
  it("holds both module locks before business queries and returns only after commit", async () => {
    const f = fixture();
    expect(await f.workflow.readWorkspace(request)).toEqual(emptyWorkspace);
    const entitlement = f.commands.filter((x) => x.sql.includes("SELECT enabled,usage_limit"));
    expect(entitlement.map((x) => x.parameters[1])).toEqual([
      "intake-job-tracker",
      "proposal-builder",
    ]);
    expect(entitlement.every((x) => x.sql.endsWith("FOR SHARE"))).toBe(true);
    const first = f.commands.findIndex((x) => business(x.sql));
    expect(f.commands.slice(0, first)).toEqual(expect.arrayContaining(entitlement));
    expect(f.commands.find((x) => x.sql.includes("SELECT s.id AS session_id"))?.sql).toContain(
      "FOR SHARE OF s,i",
    );
    expect(f.commands.find((x) => x.sql.includes("SELECT m.role,m.version"))?.sql).toContain(
      "FOR SHARE OF m,o,u",
    );
    expect(f.commands.at(-1)?.sql).toBe("COMMIT");
    expect(f.state.context).toBe("");
  });
  it.each([
    "cpl_workflow_leads WHERE",
    "cpl_proposal_drafts WHERE",
    "cpl_workflow_jobs WHERE",
    "COMMIT",
  ])("propagates %s failure with rollback and no partial result", async (failure) => {
    const f = fixture();
    f.state.failure = failure;
    await expect(f.workflow.readWorkspace(request)).rejects.toThrow("Synthetic SQL failure");
    expect(f.commands.at(-1)?.sql).toBe("ROLLBACK");
    expect(f.state.context).toBe("");
  });
  it("rolls back DTO mapping failure", async () => {
    const f = fixture();
    f.state.malformed = true;
    await expect(f.workflow.readWorkspace(request)).rejects.toThrow();
    expect(f.commands.at(-1)?.sql).toBe("ROLLBACK");
  });
  it("expiry during reads refuses the aggregate before commit", async () => {
    const f = fixture();
    f.state.before = async (sql) => {
      if (sql.includes("SELECT * FROM cpl_workflow_jobs")) f.state.time = expiry;
    };
    await expect(f.workflow.readWorkspace(request)).rejects.toThrow("CPL_ACCESS_DENIED");
    expect(f.commands.at(-1)?.sql).toBe("ROLLBACK");
  });
  it("expiry during commit withholds the committed read result", async () => {
    const f = fixture();
    f.state.committed = () => {
      f.state.time = expiry;
    };
    await expect(f.workflow.readWorkspace(request)).rejects.toThrow("CPL_ACCESS_DENIED");
    expect(f.commands.at(-1)?.sql).toBe("COMMIT");
    expect(f.state.context).toBe("");
  });
  it("overlapping reads stay serialized and the second rechecks revocation", async () => {
    const f = fixture(),
      entered = deferred(),
      release = deferred();
    f.state.before = async (sql) => {
      if (sql.includes("SELECT * FROM cpl_workflow_leads")) {
        entered.resolve();
        await release.promise;
      }
    };
    const first = f.workflow.readWorkspace(request);
    await entered.promise;
    const second = f.workflow.readWorkspace(request);
    const rejected = expect(second).rejects.toThrow("CPL_ACCESS_DENIED");
    f.state.committed = () => {
      f.state.revoked = true;
    };
    release.resolve();
    expect(await first).toEqual(emptyWorkspace);
    await rejected;
    expect(f.commands.filter((x) => business(x.sql))).toHaveLength(3);
    expect(f.commands.filter((x) => x.sql.includes("SELECT s.id AS session_id"))).toHaveLength(2);
    expect(f.commands.at(-1)?.sql).toBe("ROLLBACK");
  });
});
describe("source-inferred complete selected workspace SQL and pg frontend frames", () => {
  it.each([
    { transport: "hyperdrive", memberships: 1, before: [46, 150], after: [31, 111] },
    { transport: "hyperdrive", memberships: 2, before: [48, 160], after: [33, 121] },
    { transport: "direct", memberships: 1, before: [40, 144], after: [28, 108] },
    { transport: "direct", memberships: 2, before: [42, 154], after: [30, 118] },
  ])(
    "$transport batches authorization with $memberships memberships and retains the first session read",
    async (scenario) => {
      for (const candidate of [false, true]) {
        const f = fixture(scenario.memberships),
          database = scenario.transport === "hyperdrive" ? f.database : f.base;
        if (scenario.transport === "direct") await verifyHostedDatabaseRole(database, "web");
        const tenants = new SqlCplTenantRepository(database, { now: () => new Date(f.state.time) });
        const workflow = new SqlCplWorkflowRepository(database, tenants),
          auth = new SqlCplHostedAuthStore(database);
        expect(
          await auth.readSession("a".repeat(64), new Date(initialTime).toISOString()),
        ).not.toBeNull();
        expect(await tenants.listOrganizations(request.sessionToken)).toHaveLength(
          scenario.memberships,
        );
        if (candidate) await workflow.readWorkspace(request);
        else {
          await tenants.authorize({ ...request, permission: "records:read" });
          await workflow.listLeads(request);
          await workflow.listProposalDrafts(request);
          await workflow.listJobs(request);
        }
        // Pinned pg sends one Q for simple SQL, or Parse/Bind/Describe/Execute/Sync
        // for these parameterized queries. Not packet counts or CPU evidence.
        expect([
          f.commands.length,
          f.commands.reduce((n, x) => n + (x.parameters.length ? 5 : 1), 0),
        ]).toEqual(candidate ? scenario.after : scenario.before);
        expect(f.commands.filter((x) => x.sql.includes("WITH RECURSIVE inherited"))).toHaveLength(
          1,
        );
        expect(f.commands.filter((x) => business(x.sql))).toHaveLength(3);
        expect(f.state.context).toBe("");
      }
    },
  );
});
