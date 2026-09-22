import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGliteDatabaseAdapter } from "../../packages/database/src/pglite-adapter";
import { migrateDatabase } from "../../packages/database/src/migrations";
import {
  SqlCplTenantRepository,
  type CplTenantRequest,
} from "../../packages/database/src/tenant-repository";
import { SqlCplWorkflowRepository } from "../../packages/database/src/hosted-workflow";

// Disposable local SQL/RLS evidence; this single-engine fixture does not prove
// live PostgreSQL lock contention, Hyperdrive behavior, or provider CPU.
let database: PGliteDatabaseAdapter;
let tenants: SqlCplTenantRepository;
let workflows: SqlCplWorkflowRepository;
let time = Date.parse("2026-09-22T20:00:00.000Z");
const issuer = "https://identity.example.invalid";
beforeAll(async () => {
  database = new PGliteDatabaseAdapter();
  await migrateDatabase(database);
  tenants = new SqlCplTenantRepository(database, {
    trustedIssuers: [issuer],
    now: () => new Date(time),
    identityVerifier: {
      async verify(subject) {
        return {
          issuer,
          subject,
          displayName: "Synthetic",
          authenticatedAt: new Date(time).toISOString(),
          expiresAt: new Date(time + 3_600_000).toISOString(),
          mfaVerified: false,
        };
      },
    },
  });
  workflows = new SqlCplWorkflowRepository(database, tenants);
  await database.execute(
    "CREATE ROLE cpl_workspace_test NOLOGIN NOSUPERUSER NOBYPASSRLS; GRANT USAGE ON SCHEMA public TO cpl_workspace_test; GRANT SELECT,UPDATE ON cpl_sessions,cpl_identities,cpl_memberships,cpl_organizations,cpl_module_entitlements TO cpl_workspace_test; GRANT SELECT ON cpl_workflow_leads,cpl_proposal_drafts,cpl_workflow_jobs,cpl_runtime_roles TO cpl_workspace_test;",
  );
}, 60_000);
afterAll(async () => {
  await database?.close();
});
async function provision() {
  const session = await tenants.createSession(randomUUID());
  const organization = await tenants.createOrganization(session.token, {
    slug: randomUUID(),
    displayName: "Synthetic organization",
  });
  const request = { sessionToken: session.token, organizationId: organization.id };
  await database.query(
    "UPDATE cpl_module_entitlements SET enabled=TRUE,usage_limit=NULL WHERE organization_id=$1 AND module_key IN ('intake-job-tracker','proposal-builder')",
    [organization.id],
  );
  const lead = await workflows.createLead({
    ...request,
    title: "Synthetic lead",
    contactName: "Example",
    details: "Local test",
    idempotencyKey: randomUUID(),
  });
  const proposal = await workflows.createProposalDraft({
    ...request,
    leadId: lead.id,
    title: "Synthetic draft",
    content: "Local test content",
    idempotencyKey: randomUUID(),
  });
  return { request, identityId: session.identityId, session, lead, proposal };
}
async function withRestrictedRole<T>(operation: () => Promise<T>) {
  await database.execute("SET ROLE cpl_workspace_test");
  try {
    return await operation();
  } finally {
    await database.execute("RESET ROLE");
  }
}
async function individual(request: CplTenantRequest) {
  return {
    leads: await workflows.listLeads(request),
    proposals: await workflows.listProposalDrafts(request),
    jobs: await workflows.listJobs(request),
  };
}
async function assertCleanContext() {
  const state = await database.query<{ organization: string | null; identity: string | null }>(
    "SELECT current_setting('cpl.organization_id',true) AS organization,current_setting('cpl.identity_id',true) AS identity",
  );
  expect(state.rows[0]?.organization ?? "").toBe("");
  expect(state.rows[0]?.identity ?? "").toBe("");
}
describe("workspace aggregate SQL parity and tenant isolation", () => {
  it("returns exactly the existing DTOs with isolated tenants under forced RLS", async () => {
    const left = await provision(),
      right = await provision();
    await withRestrictedRole(async () => {
      for (const actor of [left, right]) {
        expect(await workflows.readWorkspace(actor.request)).toEqual(
          await individual(actor.request),
        );
        const result = await workflows.readWorkspace(actor.request);
        expect(result.leads.map((x) => x.id)).toEqual([actor.lead.id]);
        expect(result.proposals.map((x) => x.id)).toEqual([actor.proposal.id]);
        expect(result.jobs).toHaveLength(1);
        for (const list of [result.leads, result.proposals, result.jobs])
          expect(list.every((x) => x.organizationId === actor.request.organizationId)).toBe(true);
        await assertCleanContext();
      }
      await expect(
        workflows.readWorkspace({ ...left.request, organizationId: right.request.organizationId }),
      ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
      await assertCleanContext();
      expect((await database.query("SELECT id FROM cpl_workflow_leads")).rows).toEqual([]);
      expect((await database.query("SELECT id FROM cpl_proposal_drafts")).rows).toEqual([]);
      expect((await database.query("SELECT id FROM cpl_workflow_jobs")).rows).toEqual([]);
    });
  });
  it.each(["intake-job-tracker", "proposal-builder"])(
    "requires %s independently and restores access on re-enable",
    async (module) => {
      const actor = await provision();
      await database.query(
        "UPDATE cpl_module_entitlements SET enabled=FALSE WHERE organization_id=$1 AND module_key=$2",
        [actor.request.organizationId, module],
      );
      await expect(
        withRestrictedRole(() => workflows.readWorkspace(actor.request)),
      ).rejects.toMatchObject({ code: "CPL_MODULE_DISABLED" });
      await assertCleanContext();
      await database.query(
        "UPDATE cpl_module_entitlements SET enabled=TRUE,usage_limit=0 WHERE organization_id=$1 AND module_key=$2",
        [actor.request.organizationId, module],
      );
      await expect(
        withRestrictedRole(() => workflows.readWorkspace(actor.request)),
      ).rejects.toMatchObject({ code: "CPL_ALLOWANCE_EXHAUSTED" });
      await database.query(
        "UPDATE cpl_module_entitlements SET usage_limit=NULL WHERE organization_id=$1 AND module_key=$2",
        [actor.request.organizationId, module],
      );
      expect(
        (await withRestrictedRole(() => workflows.readWorkspace(actor.request))).leads,
      ).toHaveLength(1);
    },
  );
  it.each(["revoked", "identity", "membership", "organization", "expired"])(
    "rechecks %s after an earlier valid read",
    async (condition) => {
      const actor = await provision();
      expect((await workflows.readWorkspace(actor.request)).leads).toHaveLength(1);
      if (condition === "revoked") await tenants.revokeSession(actor.session.token);
      if (condition === "identity")
        await database.query("UPDATE cpl_identities SET status='suspended' WHERE id=$1", [
          actor.identityId,
        ]);
      if (condition === "membership")
        await database.query(
          "UPDATE cpl_memberships SET status='removed' WHERE organization_id=$1 AND identity_id=$2",
          [actor.request.organizationId, actor.identityId],
        );
      if (condition === "organization")
        await database.query("UPDATE cpl_organizations SET status='suspended' WHERE id=$1", [
          actor.request.organizationId,
        ]);
      const saved = time;
      if (condition === "expired") time = Date.parse(actor.session.expiresAt);
      try {
        await expect(
          withRestrictedRole(() => workflows.readWorkspace(actor.request)),
        ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
      } finally {
        time = saved;
      }
      await assertCleanContext();
    },
  );
  it("keeps each list's independent 100-row cap and deterministic ordering", async () => {
    const actor = await provision();
    await database.query(
      "INSERT INTO cpl_workflow_leads (id,organization_id,title,contact_name,created_by_identity_id,created_at) SELECT md5('lead'||g::text)::uuid,$1,'Synthetic '||g,'Example',$2,'2026-09-22T20:00:00Z'::timestamptz+(g||' seconds')::interval FROM generate_series(1,101) g",
      [actor.request.organizationId, actor.identityId],
    );
    await database.query(
      "INSERT INTO cpl_proposal_drafts (id,organization_id,lead_id,title,content,created_by_identity_id,created_at) SELECT md5('proposal'||g::text)::uuid,$1,$2,'Synthetic '||g,'Local test',$3,'2026-09-22T20:00:00Z'::timestamptz+(g||' seconds')::interval FROM generate_series(1,101) g",
      [actor.request.organizationId, actor.lead.id, actor.identityId],
    );
    await database.query(
      "INSERT INTO cpl_workflow_jobs (id,organization_id,proposal_id,proposal_version,issued_by_identity_id,issued_membership_version,created_at) SELECT md5('job'||g::text)::uuid,$1,md5('proposal'||g::text)::uuid,1,$2,1,'2026-09-22T20:00:00Z'::timestamptz+(g||' seconds')::interval FROM generate_series(1,101) g",
      [actor.request.organizationId, actor.identityId],
    );
    await withRestrictedRole(async () => {
      const result = await workflows.readWorkspace(actor.request);
      expect(result).toEqual(await individual(actor.request));
      expect([result.leads.length, result.proposals.length, result.jobs.length]).toEqual([
        100, 100, 100,
      ]);
      await assertCleanContext();
    });
  });
  it("a failed aggregate rolls back tenant settings and a later fresh read succeeds", async () => {
    const actor = await provision();
    await database.execute(
      "ALTER TABLE cpl_proposal_drafts RENAME TO unavailable_workspace_drafts",
    );
    try {
      await expect(
        withRestrictedRole(() => workflows.readWorkspace(actor.request)),
      ).rejects.toThrow();
    } finally {
      await database.execute(
        "ALTER TABLE unavailable_workspace_drafts RENAME TO cpl_proposal_drafts",
      );
    }
    await assertCleanContext();
    expect(
      (await withRestrictedRole(() => workflows.readWorkspace(actor.request))).proposals,
    ).toHaveLength(1);
  });
});
