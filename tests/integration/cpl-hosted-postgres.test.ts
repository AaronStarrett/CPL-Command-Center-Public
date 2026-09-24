import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { rootCertificates } from "node:tls";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgSqlDatabaseAdapter as PgDatabaseAdapter } from "../../packages/database/src/pg-sql-adapter.js";
import { migrateDatabase, verifyMigrations } from "../../packages/database/src/migrations.js";
import { SqlCplHostedAuthStore } from "../../packages/database/src/hosted-auth-store.js";
import {
  SqlCplTenantRepository,
  type CplTenantRequest,
} from "../../packages/database/src/tenant-repository.js";
import {
  SqlCplWorkflowRepository,
  processHostedJobs,
  type CplWorkflowLead,
  type CplProposalDraft,
} from "../../packages/database/src/hosted-workflow.js";
import {
  configureHostedRuntimeRole,
  verifyHostedDatabaseRole,
} from "../../packages/database/src/hosted-database-role.js";
import type {
  CplHostedSession,
  CplHostedSessionMaterial,
} from "../../packages/security/src/hosted-authentication-contracts.js";
import type { DatabaseAdapter, SqlExecutor } from "../../packages/database/src/adapter.js";

// Explicit operator-owned config only. This suite creates distinct disposable
// databases; it never uses the configured application's business database.
const configPath = process.env.CPL_HOSTED_POSTGRES_TEST_CONFIG;
const configMaterial = process.env.CPL_HOSTED_POSTGRES_TEST_CONFIG_JSON;
const suite = configPath || configMaterial ? describe : describe.skip;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const now = () => new Date().toISOString();
function material(absolute?: string) {
  const raw = token();
  return {
    raw,
    value: {
      tokenHash: sha(raw),
      csrfTokenHash: sha(token()),
      expiresAt: new Date(Date.now() + 3_500_000).toISOString(),
      absoluteExpiresAt: absolute ?? new Date(Date.now() + 28_000_000).toISOString(),
    } satisfies CplHostedSessionMaterial,
  };
}
function connectionFor(connectionString: string, database: string) {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}
const lockedDraftRead =
  "SELECT id,title,content,version FROM cpl_proposal_drafts WHERE organization_id=$1 AND id=$2 FOR UPDATE";
async function waitForDraftLockHook(waiting: Promise<void>, processing: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      waiting,
      processing.then(() => {
        throw Error("CPL_TEST_DRAFT_LOCK_HOOK_NOT_REACHED");
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Error("CPL_TEST_DRAFT_LOCK_HOOK_TIMEOUT")), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
suite("hosted workflow against real PostgreSQL with restricted runtime roles", () => {
  let admin: PgDatabaseAdapter,
    control: PgDatabaseAdapter,
    web: PgDatabaseAdapter,
    worker: PgDatabaseAdapter;
  let auth: SqlCplHostedAuthStore,
    tenants: SqlCplTenantRepository,
    workflows: SqlCplWorkflowRepository;
  let config: {
    adminUrl: string;
    webUrl: string;
    workerUrl: string;
    toolDirectory?: string;
    allowHostedDisposableDatabase?: boolean;
  };
  const databaseName = `cpl_acceptance_${randomBytes(6).toString("hex")}`;
  const restoredName = `${databaseName}_restore`;
  let owner: CplHostedSession,
    ownerMaterial: ReturnType<typeof material>,
    requestA: CplTenantRequest,
    requestB: CplTenantRequest;
  let leadA: CplWorkflowLead, proposalA: CplProposalDraft;
  let created = false,
    restored = false;
  const credential = {
    id: randomBytes(32).toString("base64url"),
    publicKey: randomBytes(64).toString("base64url"),
    counter: 0,
    transports: ["internal"],
    deviceType: "singleDevice" as const,
    backedUp: false,
  };
  async function signIn(
    subject: string,
    email = `${subject}@example.invalid`,
    hostedDomain: string | null = null,
  ) {
    const issued = material();
    const session = await auth.createSession({
      identity: {
        issuer: "https://accounts.google.com",
        subject,
        email,
        emailVerified: true,
        hostedDomain,
        displayName: `Fictional ${subject}`,
        authenticatedAt: now(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      material: issued.value,
      now: now(),
    });
    return { session, issued };
  }
  async function draft() {
    return workflows.createProposalDraft({
      ...requestA,
      leadId: leadA.id,
      title: "Fictional manual draft",
      content: "Manual scope supplied by the test user.",
      idempotencyKey: randomUUID(),
    });
  }
  async function scope(
    database: PgDatabaseAdapter,
    organizationId: string,
    operation: (executor: SqlExecutor) => Promise<void>,
  ) {
    await database.transaction(async (executor) => {
      await executor.query("SELECT set_config('cpl.organization_id',$1,true)", [organizationId]);
      await operation(executor);
    });
  }
  beforeAll(async () => {
    config = JSON.parse(configMaterial ?? readFileSync(configPath!, "utf8"));
    const url = new URL(config.adminUrl);
    if (
      !["127.0.0.1", "localhost"].includes(url.hostname) &&
      config.allowHostedDisposableDatabase !== true
    )
      throw Error("Explicit hosted disposable-database authorization required");
    control = new PgDatabaseAdapter({
      connectionString: config.adminUrl,
      max: 1,
      connectionTimeoutMillis: 10_000,
    });
    await control.execute(`CREATE DATABASE "${databaseName}"`);
    created = true;
    admin = new PgDatabaseAdapter({
      connectionString: connectionFor(config.adminUrl, databaseName),
      max: 2,
    });
    await migrateDatabase(admin);
    await configureHostedRuntimeRole(admin, new URL(config.webUrl).username, "web");
    await configureHostedRuntimeRole(admin, new URL(config.workerUrl).username, "worker");
    web = new PgDatabaseAdapter({
      connectionString: connectionFor(config.webUrl, databaseName),
      max: 1,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 10_000,
    });
    worker = new PgDatabaseAdapter({
      connectionString: connectionFor(config.workerUrl, databaseName),
      max: 2,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 10_000,
    });
    auth = new SqlCplHostedAuthStore(web);
    tenants = new SqlCplTenantRepository(web);
    workflows = new SqlCplWorkflowRepository(web, tenants);
  }, 180_000);
  afterAll(async () => {
    await Promise.all([web?.close(), worker?.close(), admin?.close()]);
    if (restored) await control.execute(`DROP DATABASE "${restoredName}" WITH (FORCE)`);
    if (created) await control.execute(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await control?.close();
  }, 60_000);
  it("applies the forward migration with no identities, organizations or business seed", async () => {
    expect((await verifyMigrations(admin)).current).toBe("0039_cpl_durable_inbound.sql");
    for (const table of [
      "cpl_identities",
      "cpl_organizations",
      "cpl_workflow_leads",
      "cpl_proposal_drafts",
      "cpl_workflow_jobs",
      "leads",
    ]) {
      expect(
        (await admin.query<{ count: string }>(`SELECT count(*) FROM ${table}`)).rows[0]?.count,
      ).toBe("0");
    }
    expect((await migrateDatabase(admin)).applied).toEqual([]);
  });
  it("rejects elevated or wrong-purpose connections and denies legacy and role-registry access", async () => {
    await expect(verifyHostedDatabaseRole(web, "web")).resolves.toMatchObject({ purpose: "web" });
    await expect(verifyHostedDatabaseRole(worker, "worker")).resolves.toMatchObject({
      purpose: "worker",
    });
    await expect(verifyHostedDatabaseRole(admin, "web")).rejects.toThrow(
      "CPL_HOSTED_DATABASE_ROLE_REFUSED",
    );
    await expect(processHostedJobs(web, { claimOwner: "wrong-role" })).rejects.toThrow(
      "CPL_HOSTED_DATABASE_ROLE_REFUSED",
    );
    for (const database of [web, worker]) {
      await expect(database.query("SELECT * FROM leads")).rejects.toMatchObject({ code: "42501" });
      await expect(
        database.query("UPDATE cpl_runtime_roles SET purpose='worker'"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        database.execute("CREATE TABLE forbidden_runtime_ddl(id integer)"),
      ).rejects.toMatchObject({ code: "42501" });
    }
    const flags = await admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('cpl_workflow_leads','cpl_proposal_drafts','cpl_workflow_jobs','cpl_workflow_mutations','cpl_organizations')",
    );
    expect(flags.rows).toHaveLength(5);
    expect(flags.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  });
  it("atomically consumes OAuth state with the exact browser binding once", async () => {
    const flow = {
      browserBindingHash: sha(token()),
      stateHash: sha(token()),
      nonce: token(),
      pkceVerifier: token(),
      returnTo: "/workspace",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
    await auth.createOAuthFlow(flow);
    expect(
      await auth.consumeOAuthFlow({ ...flow, browserBindingHash: sha(token()), now: now() }),
    ).toBeNull();
    const consumed = await Promise.all([
      auth.consumeOAuthFlow({ ...flow, now: now() }),
      auth.consumeOAuthFlow({ ...flow, now: now() }),
    ]);
    expect(consumed.filter(Boolean)).toHaveLength(1);
  });
  it("rejects a nonprivileged login that can SET ROLE to a tenant table owner", async () => {
    const suffix = randomBytes(6).toString("hex");
    const ownerRole = `cpl_owner_probe_${suffix}`,
      loginRole = `cpl_login_probe_${suffix}`;
    const password = randomBytes(32).toString("hex");
    const administrator = String(
      (await admin.query<{ role: string }>("SELECT current_user AS role")).rows[0]!.role,
    );
    const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
    let probe: PgDatabaseAdapter | undefined,
      ownerCreated = false,
      loginCreated = false,
      ownershipChanged = false;
    try {
      await admin.execute(
        `CREATE ROLE ${quote(ownerRole)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
      ownerCreated = true;
      await admin.execute(
        `CREATE ROLE ${quote(loginRole)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
      );
      loginCreated = true;
      await configureHostedRuntimeRole(admin, loginRole, "web");
      const url = new URL(connectionFor(config.webUrl, databaseName));
      url.username = loginRole;
      url.password = password;
      probe = new PgDatabaseAdapter({ connectionString: url.toString(), max: 1 });
      await expect(verifyHostedDatabaseRole(probe, "web")).resolves.toMatchObject({
        purpose: "web",
      });
      await admin.execute(
        `GRANT ${quote(ownerRole)} TO ${quote(administrator)}; GRANT CREATE ON SCHEMA public TO ${quote(ownerRole)}; ALTER TABLE cpl_proposal_drafts OWNER TO ${quote(ownerRole)}; REVOKE CREATE ON SCHEMA public FROM ${quote(ownerRole)}`,
      );
      ownershipChanged = true;
      await admin.execute(`GRANT ${quote(ownerRole)} TO ${quote(loginRole)}`);
      await expect(verifyHostedDatabaseRole(probe, "web")).rejects.toThrow(
        "CPL_HOSTED_DATABASE_ROLE_REFUSED",
      );
      const flags = (
        await probe.query<{ rolsuper: boolean; rolbypassrls: boolean; rolinherit: boolean }>(
          "SELECT rolsuper,rolbypassrls,rolinherit FROM pg_roles WHERE rolname=current_user",
        )
      ).rows[0];
      expect(flags).toEqual({ rolsuper: false, rolbypassrls: false, rolinherit: false });
      // Prove the dangerous capability, but roll the DDL back so isolation is
      // never left disabled. This is confined to the disposable test database.
      await expect(
        probe.transaction(async (executor) => {
          await executor.execute(`SET LOCAL ROLE ${quote(ownerRole)}`);
          await executor.execute("ALTER TABLE cpl_proposal_drafts NO FORCE ROW LEVEL SECURITY");
          throw Error("rollback owner-capability probe");
        }),
      ).rejects.toThrow("rollback owner-capability probe");
    } finally {
      await probe?.close();
      if (ownershipChanged)
        await admin.execute(`ALTER TABLE cpl_proposal_drafts OWNER TO ${quote(administrator)}`);
      if (loginCreated) {
        await admin.execute(`GRANT ${quote(loginRole)} TO ${quote(administrator)}`);
        await admin.execute(`DROP OWNED BY ${quote(loginRole)}`);
        await admin.query("DELETE FROM cpl_runtime_roles WHERE role_name=$1", [loginRole]);
        await admin.execute(`DROP ROLE ${quote(loginRole)}`);
      }
      if (ownerCreated) {
        await admin.execute(`GRANT ${quote(ownerRole)} TO ${quote(administrator)}`);
        await admin.execute(`DROP OWNED BY ${quote(ownerRole)}`);
        await admin.execute(`DROP ROLE ${quote(ownerRole)}`);
      }
    }
    await expect(verifyHostedDatabaseRole(web, "web")).resolves.toMatchObject({ purpose: "web" });
  });
  it("refuses runtime access when operator drift removes forced tenant isolation", async () => {
    await admin.execute("ALTER TABLE cpl_proposal_drafts NO FORCE ROW LEVEL SECURITY");
    try {
      await expect(verifyHostedDatabaseRole(web, "web")).rejects.toThrow(
        "CPL_HOSTED_DATABASE_ROLE_REFUSED",
      );
    } finally {
      await admin.execute("ALTER TABLE cpl_proposal_drafts FORCE ROW LEVEL SECURITY");
    }
    await expect(verifyHostedDatabaseRole(web, "web")).resolves.toMatchObject({ purpose: "web" });
  });
  it("never makes the first visitor or a Google-only owner session an administrator", async () => {
    const visitor = await signIn("first-visitor");
    expect(visitor.session.platformAdministrator).toBe(false);
    const signed = await signIn(
      "owner-subject",
      "astarrett@cyberpiratelabs.com",
      "cyberpiratelabs.com",
    );
    owner = signed.session;
    ownerMaterial = signed.issued;
    expect(owner.mfaVerifiedAt).toBeNull();
    expect(owner.platformAdministrator).toBe(false);
    await expect(
      tenants.createEnabledOrganization(ownerMaterial.raw, {
        slug: "too-early",
        displayName: "Too early",
      }),
    ).rejects.toMatchObject({ code: "CPL_PLATFORM_MFA_REQUIRED" });
  });
  it("enrolls a credential without setting MFA; signed-auth completion rotates and binds owner once", async () => {
    const previous = ownerMaterial;
    ownerMaterial = material(owner.absoluteExpiresAt);
    owner = await auth.completeRegistration({
      tokenHash: previous.value.tokenHash,
      credential,
      material: ownerMaterial.value,
      now: now(),
    });
    expect(owner.mfaVerifiedAt).toBeNull();
    expect(owner.platformAdministrator).toBe(false);
    expect(await auth.readSession(previous.value.tokenHash, now())).toBeNull();
    const enrolled = ownerMaterial;
    ownerMaterial = material(owner.absoluteExpiresAt);
    owner = await auth.completeAuthentication({
      tokenHash: enrolled.value.tokenHash,
      credentialId: credential.id,
      previousCounter: 0,
      newCounter: 1,
      material: ownerMaterial.value,
      now: now(),
    });
    expect(owner.mfaVerifiedAt).not.toBeNull();
    expect(owner.platformAdministrator).toBe(true);
    expect((await admin.query("SELECT * FROM cpl_platform_owner_binding")).rows).toHaveLength(1);
    expect(
      (
        await admin.query(
          "SELECT action FROM cpl_auth_audit_events WHERE action IN ('passkey.registered','passkey.authenticated','owner.bound')",
        )
      ).rows,
    ).toHaveLength(3);
  });
  it("creates enabled empty organizations atomically and stores selected membership", async () => {
    const a = await tenants.createEnabledOrganization(ownerMaterial.raw, {
      slug: "fictional-alpha",
      displayName: "Fictional Alpha",
    });
    const b = await tenants.createEnabledOrganization(ownerMaterial.raw, {
      slug: "fictional-beta",
      displayName: "Fictional Beta",
    });
    requestA = { sessionToken: ownerMaterial.raw, organizationId: a.id };
    requestB = { sessionToken: ownerMaterial.raw, organizationId: b.id };
    expect(await workflows.listLeads(requestA)).toEqual([]);
    expect(await workflows.listProposalDrafts(requestB)).toEqual([]);
    await auth.selectOrganization(ownerMaterial.value.tokenHash, a.id, now());
    expect(
      (await auth.readSession(ownerMaterial.value.tokenHash, now()))?.selectedOrganizationId,
    ).toBe(a.id);
    await expect(
      auth.selectOrganization(ownerMaterial.value.tokenHash, randomUUID(), now()),
    ).rejects.toMatchObject({ code: "CPL_ORGANIZATION_ACCESS_DENIED" });
  });
  it("rejects stale or future first enrollment and counter replay under real row locks", async () => {
    for (const offset of [-6 * 60_000, 60_000]) {
      const signed = await signIn(`freshness-${offset}`);
      await admin.query("UPDATE cpl_sessions SET created_at=$2 WHERE id=$1", [
        signed.session.id,
        new Date(Date.now() + offset).toISOString(),
      ]);
      await expect(
        auth.completeRegistration({
          tokenHash: signed.issued.value.tokenHash,
          credential: { ...credential, id: token() },
          material: material(signed.session.absoluteExpiresAt).value,
          now: now(),
        }),
      ).rejects.toMatchObject({ code: "CPL_FRESH_SIGN_IN_REQUIRED" });
    }
    const signed = await signIn(
      "owner-subject",
      "astarrett@cyberpiratelabs.com",
      "cyberpiratelabs.com",
    );
    await expect(
      auth.completeRegistration({
        tokenHash: signed.issued.value.tokenHash,
        credential: { ...credential, id: token() },
        material: material(signed.session.absoluteExpiresAt).value,
        now: now(),
      }),
    ).rejects.toMatchObject({ code: "CPL_MFA_REQUIRED" });
    await expect(
      auth.completeAuthentication({
        tokenHash: signed.issued.value.tokenHash,
        credentialId: credential.id,
        previousCounter: 0,
        newCounter: 1,
        material: material(signed.session.absoluteExpiresAt).value,
        now: now(),
      }),
    ).rejects.toMatchObject({ code: "CPL_PASSKEY_REJECTED" });
  });
  it("never transfers immutable owner binding to a different Google subject", async () => {
    const impostor = await signIn(
      "different-owner-subject",
      "astarrett@cyberpiratelabs.com",
      "cyberpiratelabs.com",
    );
    const enrolled = material(impostor.session.absoluteExpiresAt),
      key = { ...credential, id: token() };
    await auth.completeRegistration({
      tokenHash: impostor.issued.value.tokenHash,
      credential: key,
      material: enrolled.value,
      now: now(),
    });
    const verified = await auth.completeAuthentication({
      tokenHash: enrolled.value.tokenHash,
      credentialId: key.id,
      previousCounter: 0,
      newCounter: 1,
      material: material(impostor.session.absoluteExpiresAt).value,
      now: now(),
    });
    expect(verified.platformAdministrator).toBe(false);
    expect(
      (
        await admin.query<{ identity_id: string }>(
          "SELECT identity_id FROM cpl_platform_owner_binding",
        )
      ).rows[0]?.identity_id,
    ).toBe(owner.identityId);
  });
  it("persists manual leads with atomic idempotency and rejects changed replay payloads", async () => {
    const input = {
      ...requestA,
      title: "Fictional service inquiry",
      contactName: "Jordan Example",
      contactEmail: "jordan@example.invalid",
      details: "A synthetic acceptance record.",
      requestedService: "Fictional advisory service",
      assignedMemberIdentityId: owner.identityId,
      nextAction: "Prepare a manual proposal",
      idempotencyKey: randomUUID(),
    };
    const results = await Promise.all([workflows.createLead(input), workflows.createLead(input)]);
    leadA = results[0]!;
    expect(results[1]?.id).toBe(leadA.id);
    await expect(workflows.createLead({ ...input, title: "Changed" })).rejects.toMatchObject({
      code: "CPL_IDEMPOTENCY_CONFLICT",
    });
    expect(await workflows.listLeads(requestA)).toHaveLength(1);
    leadA = await workflows.updateLead({
      ...requestA,
      leadId: leadA.id,
      expectedVersion: leadA.version,
      status: "ready_for_proposal",
    });
  });
  it("rejects forged organization, lead and proposal IDs across every read/write/download path", async () => {
    proposalA = await draft();
    expect(await workflows.listLeads(requestB)).toEqual([]);
    expect(await workflows.listProposalDrafts(requestB)).toEqual([]);
    expect(await workflows.listJobs(requestB)).toEqual([]);
    for (const operation of [
      workflows.getLead({ ...requestB, leadId: leadA.id }),
      workflows.getProposalDraft({ ...requestB, proposalId: proposalA.id }),
      workflows.downloadProposal({ ...requestB, proposalId: proposalA.id }),
      workflows.createProposalDraft({
        ...requestB,
        leadId: leadA.id,
        title: "Forged",
        content: "Forged",
        idempotencyKey: randomUUID(),
      }),
    ])
      await expect(operation).rejects.toMatchObject({ code: "CPL_RECORD_NOT_FOUND" });
    await expect(
      workflows.updateProposalDraft({
        ...requestB,
        proposalId: proposalA.id,
        title: "Forged",
        content: "Forged",
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "CPL_PROPOSAL_VERSION_CONFLICT" });
    const outsider = await signIn("outsider");
    await expect(
      workflows.listLeads({ ...requestA, sessionToken: outsider.issued.raw }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
  });
  it("enforces real RLS reads and WITH CHECK writes for an explicit tenant context", async () => {
    expect((await web.query("SELECT * FROM cpl_workflow_leads")).rows).toEqual([]);
    await scope(web, requestB.organizationId, async (executor) => {
      expect(
        (await executor.query("SELECT * FROM cpl_workflow_leads WHERE id=$1", [leadA.id])).rows,
      ).toEqual([]);
      expect(
        (
          await executor.query("UPDATE cpl_workflow_leads SET title='forged' WHERE id=$1", [
            leadA.id,
          ])
        ).rowCount,
      ).toBe(0);
      await expect(
        executor.query(
          "INSERT INTO cpl_workflow_leads(id,organization_id,title,contact_name,created_by_identity_id) VALUES ($1,$2,'forged','forged',$3)",
          [randomUUID(), requestA.organizationId, owner.identityId],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    });
  });
  it("clears pooled tenant context after commit, application rollback and SQL-error rollback", async () => {
    for (const mode of ["commit", "throw", "sql-error"]) {
      const operation = web.transaction(async (executor) => {
        await executor.query("SELECT set_config('cpl.organization_id',$1,true)", [
          requestA.organizationId,
        ]);
        expect((await executor.query("SELECT id FROM cpl_workflow_leads")).rows).toHaveLength(1);
        if (mode === "throw") throw Error("rollback fixture");
        if (mode === "sql-error") await executor.query("SELECT 1/0");
      });
      if (mode === "commit") await operation;
      else await expect(operation).rejects.toThrow();
      expect((await web.query("SELECT id FROM cpl_workflow_leads")).rows).toEqual([]);
      expect(
        (
          await web.query<{ scope: string | null }>(
            "SELECT NULLIF(current_setting('cpl.organization_id',true),'') AS scope",
          )
        ).rows[0]?.scope,
      ).toBeNull();
    }
  });
  it("durably queues exactly one version job and produces a tenant-authorized immediate download", async () => {
    await expect(
      workflows.downloadProposal({ ...requestA, proposalId: proposalA.id }),
    ).rejects.toMatchObject({ code: "CPL_PROPOSAL_NOT_READY" });
    expect(await processHostedJobs(worker, { claimOwner: "local-scheduler-1", limit: 1 })).toEqual({
      claimed: 1,
      completed: 1,
      retried: 0,
      failed: 0,
    });
    const file = await workflows.downloadProposal({ ...requestA, proposalId: proposalA.id });
    expect(file.content).toContain("Manual scope supplied");
    expect(sha(file.content)).toBe(file.sha256);
    expect(await processHostedJobs(worker, { claimOwner: "repeat" })).toEqual({
      claimed: 0,
      completed: 0,
      retried: 0,
      failed: 0,
    });
    const reopened = new PgDatabaseAdapter({
      connectionString: connectionFor(config.webUrl, databaseName),
      max: 1,
    });
    try {
      expect(
        (
          await new SqlCplWorkflowRepository(
            reopened,
            new SqlCplTenantRepository(reopened),
          ).getProposalDraft({ ...requestA, proposalId: proposalA.id })
        ).content,
      ).toBe(proposalA.content);
    } finally {
      await reopened.close();
    }
  });
  it("detects optimistic edit conflicts and prepares only the newest draft version", async () => {
    const next = await workflows.updateProposalDraft({
      ...requestA,
      proposalId: proposalA.id,
      title: "Version two",
      content: "Manually revised scope",
      expectedVersion: 1,
    });
    expect(next.version).toBe(2);
    await expect(
      workflows.updateProposalDraft({
        ...requestA,
        proposalId: proposalA.id,
        title: "Stale",
        content: "Stale",
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "CPL_PROPOSAL_VERSION_CONFLICT" });
    await expect(
      workflows.downloadProposal({ ...requestA, proposalId: proposalA.id }),
    ).rejects.toMatchObject({ code: "CPL_PROPOSAL_NOT_READY" });
    const results = await Promise.all([
      processHostedJobs(worker, { claimOwner: "parallel-1" }),
      processHostedJobs(worker, { claimOwner: "parallel-2" }),
    ]);
    expect(results.reduce((sum, item) => sum + item.completed, 0)).toBe(1);
    expect(
      (await workflows.downloadProposal({ ...requestA, proposalId: proposalA.id })).content,
    ).toContain("Manually revised scope");
  });
  it("recovers an expired lease and never duplicates the completed preparation", async () => {
    const pending = await draft();
    await admin.query(
      "UPDATE cpl_workflow_jobs SET status='running',attempts=1,lease_token=$2,lease_owner='crashed',lease_expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE proposal_id=$1",
      [pending.id, randomUUID()],
    );
    expect((await processHostedJobs(worker, { claimOwner: "recovered" })).completed).toBe(1);
    expect(
      (await workflows.listJobs(requestA)).find((item) => item.proposalId === pending.id),
    ).toMatchObject({ attempts: 2, status: "completed" });
  });
  it("backs off transient failures and exhausts a bounded three-attempt retry budget", async () => {
    const pending = await draft();
    let injectedFailures = 0;
    const failing = new Proxy(worker, {
      get(target, key) {
        if (key === "transaction")
          return async (operation: Parameters<DatabaseAdapter["transaction"]>[0]) =>
            target.transaction((executor) =>
              operation({
                ...executor,
                execute: executor.execute.bind(executor),
                query: async (sql: string, parameters?: readonly unknown[]) => {
                  if (sql === lockedDraftRead) {
                    injectedFailures++;
                    throw Error("private backend failure must not be logged");
                  }
                  return executor.query(sql, parameters);
                },
              }),
            );
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DatabaseAdapter;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await processHostedJobs(failing, { claimOwner: "transient-fixture" });
      expect(injectedFailures, "Retry injection must reach the locked draft read").toBe(attempt);
      expect(result[attempt === 3 ? "failed" : "retried"]).toBe(1);
      const record = (await workflows.listJobs(requestA)).find(
        (item) => item.proposalId === pending.id,
      );
      expect(record).toMatchObject({
        attempts: attempt,
        lastErrorCode: "CPL_JOB_PROCESSING_FAILED",
      });
      if (attempt < 3) {
        expect((await processHostedJobs(worker, { claimOwner: "too-soon" })).claimed).toBe(0);
        await admin.query(
          "UPDATE cpl_workflow_jobs SET available_at=CURRENT_TIMESTAMP WHERE proposal_id=$1",
          [pending.id],
        );
      }
    }
    expect(
      (await workflows.listJobs(requestA)).find((item) => item.proposalId === pending.id)?.status,
    ).toBe("failed");
  });
  it("revalidates issuing membership version before any queued work", async () => {
    const pending = await draft();
    await admin.query(
      "UPDATE cpl_memberships SET version=version+1 WHERE organization_id=$1 AND identity_id=$2",
      [requestA.organizationId, owner.identityId],
    );
    expect((await processHostedJobs(worker, { claimOwner: "revoked-grant" })).failed).toBe(1);
    expect(
      (await workflows.listJobs(requestA)).find((item) => item.proposalId === pending.id)
        ?.lastErrorCode,
    ).toBe("CPL_JOB_AUTHORIZATION_REVOKED");
    await expect(
      workflows.downloadProposal({ ...requestA, proposalId: pending.id }),
    ).rejects.toMatchObject({ code: "CPL_PROPOSAL_NOT_READY" });
  });
  it("fences a replaced lease before processing and preserves its replacement owner", async () => {
    const pending = await draft(),
      replacement = randomUUID();
    let replaced = false;
    const delayed = new Proxy(worker, {
      get(target, key) {
        if (key === "transaction")
          return async (operation: Parameters<DatabaseAdapter["transaction"]>[0]) =>
            target.transaction((executor) =>
              operation({
                execute: executor.execute.bind(executor),
                query: async (sql: string, parameters?: readonly unknown[]) => {
                  if (
                    !replaced &&
                    sql.startsWith("SELECT id FROM cpl_workflow_jobs WHERE organization_id")
                  ) {
                    replaced = true;
                    await admin.query(
                      "UPDATE cpl_workflow_jobs SET lease_token=$2,lease_owner='replacement' WHERE proposal_id=$1",
                      [pending.id, replacement],
                    );
                  }
                  return executor.query(sql, parameters);
                },
              }),
            );
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DatabaseAdapter;
    await expect(processHostedJobs(delayed, { claimOwner: "stale-owner" })).rejects.toMatchObject({
      code: "CPL_JOB_LEASE_LOST",
    });
    expect(
      (
        await admin.query<{ lease_token: string; lease_owner: string }>(
          "SELECT lease_token,lease_owner FROM cpl_workflow_jobs WHERE proposal_id=$1",
          [pending.id],
        )
      ).rows[0],
    ).toEqual({ lease_token: replacement, lease_owner: "replacement" });
    await admin.query(
      "UPDATE cpl_workflow_jobs SET lease_expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE proposal_id=$1",
      [pending.id],
    );
    expect((await processHostedJobs(worker, { claimOwner: "recover-fenced-job" })).completed).toBe(
      1,
    );
  });
  it("refuses preparation when membership is revoked while waiting for a proposal row lock", async () => {
    const pending = await draft();
    const blocker = await admin.pool.connect();
    let lockedDraftReads = 0;
    let releaseWait!: () => void;
    const waiting = new Promise<void>((resolve) => {
      releaseWait = resolve;
    });
    const observed = new Proxy(worker, {
      get(target, key) {
        if (key === "transaction")
          return async (operation: Parameters<DatabaseAdapter["transaction"]>[0]) =>
            target.transaction((executor) =>
              operation({
                execute: executor.execute.bind(executor),
                query: async (sql: string, parameters?: readonly unknown[]) => {
                  if (sql === lockedDraftRead) {
                    lockedDraftReads++;
                    releaseWait();
                  }
                  return executor.query(sql, parameters);
                },
              }),
            );
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DatabaseAdapter;
    let processing: ReturnType<typeof processHostedJobs> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM cpl_proposal_drafts WHERE id=$1 FOR UPDATE", [
        pending.id,
      ]);
      processing = processHostedJobs(observed, { claimOwner: "revoked-while-blocked" });
      await waitForDraftLockHook(waiting, processing);
      expect(lockedDraftReads, "Revocation rendezvous must reach the locked draft read").toBe(1);
      await admin.query(
        "UPDATE cpl_memberships SET status='suspended',version=version+1 WHERE organization_id=$1 AND identity_id=$2",
        [requestA.organizationId, owner.identityId],
      );
      await blocker.query("COMMIT");
      expect(await processing).toMatchObject({ claimed: 1, completed: 0, failed: 1 });
      const record = (
        await admin.query<{
          status: string;
          last_error_code: string;
          result_sha256: string | null;
        }>(
          "SELECT status,last_error_code,result_sha256 FROM cpl_workflow_jobs WHERE proposal_id=$1",
          [pending.id],
        )
      ).rows[0];
      expect(record).toEqual({
        status: "failed",
        last_error_code: "CPL_JOB_AUTHORIZATION_REVOKED",
        result_sha256: null,
      });
      expect(
        (
          await admin.query<{ prepared_version: number | null }>(
            "SELECT prepared_version FROM cpl_proposal_drafts WHERE id=$1",
            [pending.id],
          )
        ).rows[0]?.prepared_version,
      ).toBeNull();
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await processing?.catch(() => undefined);
      await admin.query(
        "UPDATE cpl_memberships SET status='active',version=version+1 WHERE organization_id=$1 AND identity_id=$2",
        [requestA.organizationId, owner.identityId],
      );
    }
  });
  it("atomically consumes challenges and applies durable rate limits across store instances", async () => {
    const challenge = {
      sessionId: owner.id,
      ceremonyTokenHash: sha(token()),
      kind: "authentication" as const,
      challenge: token(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
    await auth.createChallenge(challenge);
    const other = new SqlCplHostedAuthStore(web);
    expect(
      (
        await Promise.all([
          auth.consumeChallenge({ ...challenge, now: now() }),
          other.consumeChallenge({ ...challenge, now: now() }),
        ])
      ).filter(Boolean),
    ).toHaveLength(1);
    const limit = { key: randomUUID(), limit: 2, windowSeconds: 60, now: now() };
    expect(await auth.consumeRateLimit(limit)).toBe(true);
    expect(await other.consumeRateLimit(limit)).toBe(true);
    expect(await auth.consumeRateLimit(limit)).toBe(false);
  });
  it("preserves original creation and absolute lifetime across renewal, and revokes old tokens", async () => {
    const previous = ownerMaterial;
    ownerMaterial = material(owner.absoluteExpiresAt);
    const originalCreated = owner.createdAt;
    owner = await auth.rotateSession({
      tokenHash: previous.value.tokenHash,
      material: ownerMaterial.value,
      now: now(),
    });
    expect(owner.createdAt).toBe(originalCreated);
    expect(owner.absoluteExpiresAt).toBe(previous.value.absoluteExpiresAt);
    expect(await auth.readSession(previous.value.tokenHash, now())).toBeNull();
    requestA = { ...requestA, sessionToken: ownerMaterial.raw };
    requestB = { ...requestB, sessionToken: ownerMaterial.raw };
    expect(
      (await workflows.getProposalDraft({ ...requestA, proposalId: proposalA.id })).version,
    ).toBe(2);
    await expect(
      auth.rotateSession({
        tokenHash: ownerMaterial.value.tokenHash,
        material: material().value,
        now: now(),
      }),
    ).rejects.toThrow();
  });
  it("backs up and restores PostgreSQL data, RLS and manual draft persistence", async () => {
    if (!config.toolDirectory)
      throw Error("Real PostgreSQL pg_dump/pg_restore toolDirectory is required");
    const artifactDirectory = process.env.CPL_HOSTED_POSTGRES_TEST_ARTIFACTS;
    if (!artifactDirectory) throw Error("Private backup artifact directory required");
    mkdirSync(artifactDirectory, { recursive: true });
    const backup = path.join(artifactDirectory, `${databaseName}.dump`);
    const roots = path.join(artifactDirectory, "public-root-certificates.pem");
    writeFileSync(roots, rootCertificates.join("\n") + "\n");
    const url = new URL(connectionFor(config.adminUrl, databaseName));
    const env = {
      ...process.env,
      PGHOST: url.hostname,
      PGPORT: url.port || "5432",
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: databaseName,
      PGSSLMODE: url.searchParams.get("sslmode") ?? "prefer",
      PGSSLROOTCERT: roots,
    };
    const run = (binary: string, args: string[]) => {
      const result = spawnSync(
        path.join(config.toolDirectory!, `${binary}${process.platform === "win32" ? ".exe" : ""}`),
        args,
        { env, encoding: "utf8", windowsHide: true, timeout: 120_000 },
      );
      if (result.status !== 0)
        throw Error(`${binary} failed (${result.status}); private stderr withheld`);
    };
    run("pg_dump", ["--format=custom", "--no-owner", "--no-acl", "--file", backup]);
    expect(statSync(backup).size).toBeGreaterThan(1000);
    await control.execute(`CREATE DATABASE "${restoredName}"`);
    restored = true;
    run("pg_restore", [
      "--no-owner",
      "--no-acl",
      "--exit-on-error",
      "--dbname",
      restoredName,
      backup,
    ]);
    const restoredAdmin = new PgDatabaseAdapter(connectionFor(config.adminUrl, restoredName));
    let restoredWeb: PgDatabaseAdapter | undefined;
    try {
      // --no-acl intentionally omits the original PUBLIC revocations. A restore
      // operator must restore these denials before granting a runtime role.
      await expect(
        configureHostedRuntimeRole(restoredAdmin, new URL(config.webUrl).username, "web"),
      ).rejects.toThrow("CPL_INTEGRATION_SQL_CONTRACT_REFUSED");
      const publicExecution = await restoredAdmin.query<{ count: string }>(
        "SELECT count(*) FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=ANY(ARRAY['cpl_integration_oauth_context(text,text)'::regprocedure,'cpl_inbound_admission_budget(text)'::regprocedure,'cpl_inbound_public_context(text)'::regprocedure,'cpl_ingestion_lock_authority(uuid,uuid,uuid)'::regprocedure]) AND a.grantee=0 AND a.privilege_type='EXECUTE'",
      );
      expect(Number(publicExecution.rows[0]!.count)).toBe(4);
      await restoredAdmin.execute(
        "REVOKE ALL ON FUNCTION cpl_integration_oauth_context(text,text),cpl_inbound_admission_budget(text),cpl_inbound_public_context(text),cpl_ingestion_lock_authority(uuid,uuid,uuid) FROM PUBLIC",
      );
      await configureHostedRuntimeRole(restoredAdmin, new URL(config.webUrl).username, "web");
      restoredWeb = new PgDatabaseAdapter(connectionFor(config.webUrl, restoredName));
      await verifyHostedDatabaseRole(restoredWeb, "web");
      const repo = new SqlCplWorkflowRepository(
        restoredWeb,
        new SqlCplTenantRepository(restoredWeb),
      );
      expect((await repo.getProposalDraft({ ...requestA, proposalId: proposalA.id })).content).toBe(
        "Manually revised scope",
      );
      expect(await repo.listLeads(requestB)).toEqual([]);
      expect((await verifyMigrations(restoredAdmin)).current).toBe("0039_cpl_durable_inbound.sql");
    } finally {
      await restoredWeb?.close();
      await restoredAdmin.close();
    }
  }, 180_000);
  async function intakeWorkspace() {
    const organization = await tenants.createEnabledOrganization(ownerMaterial.raw, {
      slug: `intake-${randomBytes(5).toString("hex")}`,
      displayName: "Fictional intake test",
    });
    return { sessionToken: ownerMaterial.raw, organizationId: organization.id };
  }
  function completeIntake(request: CplTenantRequest, extra: Record<string, unknown> = {}) {
    return {
      ...request,
      title: "Fictional service inquiry",
      contactName: "Fictional customer",
      details: "Manual request evidence",
      requestedService: "Configurable advisory service",
      assignedMemberIdentityId: owner.identityId,
      nextAction: "Prepare scope",
      idempotencyKey: randomUUID(),
      ...extra,
    };
  }
  it("captures incomplete intake, preserves original evidence during correction, and gates new proposals", async () => {
    const request = await intakeWorkspace();
    const captured = await workflows.createLead({
      ...request,
      title: "Incomplete telephone inquiry",
      sourceType: "phone",
      sourceReference: "call:fictional-reference",
      evidenceNote: "Original words from caller",
      idempotencyKey: randomUUID(),
    });
    expect(captured.readiness.readyForProposal).toBe(false);
    expect(captured.readiness.missingInformation).toContainEqual(
      expect.objectContaining({ code: "requested_service", severity: "blocking" }),
    );
    await expect(
      workflows.createProposalDraft({
        ...request,
        leadId: captured.id,
        title: "Premature",
        content: "Manual scope",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "CPL_LEAD_NOT_READY" });
    await expect(
      workflows.updateLead({
        ...request,
        leadId: captured.id,
        expectedVersion: 1,
        status: "ready_for_proposal",
      }),
    ).rejects.toMatchObject({ code: "CPL_LEAD_NOT_READY" });
    expect((await workflows.getLead({ ...request, leadId: captured.id })).version).toBe(1);
    const corrected = await workflows.updateLead({
      ...request,
      leadId: captured.id,
      expectedVersion: 1,
      contactName: "Corrected fictional contact",
      details: "Clarified request",
      requestedService: "Remote advisory",
      assignedMemberIdentityId: owner.identityId,
      nextAction: "Prepare proposal",
      status: "ready_for_proposal",
    });
    expect(corrected.readiness.readyForProposal).toBe(true);
    expect(corrected.evidence).toEqual(captured.evidence);
    expect(corrected.evidence[0]?.note).toBe("Original words from caller");
    const frozen = await admin.query<{ capture_json: { contactName: string; details: string } }>(
      "SELECT capture_json FROM cpl_lead_evidence WHERE organization_id=$1 AND lead_id=$2 AND kind='initial_capture'",
      [request.organizationId, captured.id],
    );
    expect(frozen.rows[0]?.capture_json).toMatchObject({ contactName: "", details: "" });
    const proposal = await workflows.createProposalDraft({
      ...request,
      leadId: captured.id,
      title: "Eligible manual draft",
      content: "Human supplied scope",
      idempotencyKey: randomUUID(),
    });
    expect(proposal.leadId).toBe(captured.id);
  });
  it("uses same-tenant directory references and immutable snapshots without changing shared records", async () => {
    const request = await intakeWorkspace();
    const customer = await workflows.createDirectoryEntry({
      ...request,
      kind: "customer",
      name: "Fictional shared customer",
      idempotencyKey: randomUUID(),
    });
    const second = await workflows.createDirectoryEntry({
      ...request,
      kind: "customer",
      name: "Another fictional customer",
      idempotencyKey: randomUUID(),
    });
    const contact = await workflows.createDirectoryEntry({
      ...request,
      kind: "contact",
      customerId: customer.id,
      name: "Fictional contact",
      email: "directory@example.invalid",
      idempotencyKey: randomUUID(),
    });
    const site = await workflows.createDirectoryEntry({
      ...request,
      kind: "site",
      customerId: customer.id,
      name: "Fictional site",
      address: "Example address",
      idempotencyKey: randomUUID(),
    });
    const lead = await workflows.createLead({
      ...completeIntake(request),
      customerId: customer.id,
      contactId: contact.id,
      siteId: site.id,
    });
    expect(lead).toMatchObject({
      customerName: customer.name,
      contactName: contact.name,
      contactEmail: "directory@example.invalid",
      siteName: site.name,
      siteAddress: "Example address",
    });
    const corrected = await workflows.updateLead({
      ...request,
      leadId: lead.id,
      expectedVersion: lead.version,
      contactName: "Corrected for this inquiry",
    });
    expect(corrected.contactName).toBe("Corrected for this inquiry");
    expect(
      (await workflows.getIntakeDirectory(request)).contacts.find((item) => item.id === contact.id)
        ?.name,
    ).toBe("Fictional contact");
    await expect(
      workflows.createLead({
        ...completeIntake(request),
        customerId: second.id,
        contactId: contact.id,
      }),
    ).rejects.toMatchObject({ code: "CPL_REFERENCE_CONFLICT" });
    await expect(
      workflows.createLead({ ...completeIntake(requestB), customerId: customer.id }),
    ).rejects.toMatchObject({ code: "CPL_RECORD_NOT_FOUND" });
    await expect(
      workflows.createDirectoryEntry({
        ...requestB,
        kind: "site",
        customerId: customer.id,
        name: "Forged relationship",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "CPL_RECORD_NOT_FOUND" });
    expect((await workflows.getIntakeDirectory(requestB)).customers).toEqual([]);
    await expect(
      admin.query("UPDATE cpl_customers SET name='Overwritten' WHERE id=$1", [customer.id]),
    ).rejects.toMatchObject({ code: "42501" });
  });
  it("appends evidence once, refuses stale changes and protects original evidence from mutation", async () => {
    const request = await intakeWorkspace();
    const lead = await workflows.createLead(completeIntake(request));
    const input = {
      ...request,
      leadId: lead.id,
      expectedVersion: lead.version,
      label: "Original imported request",
      reference: "message:fictional",
      note: "Untrusted text remains data",
      idempotencyKey: randomUUID(),
    };
    const appended = await workflows.appendLeadEvidence(input);
    const replay = await workflows.appendLeadEvidence(input);
    expect(replay).toEqual(appended);
    expect(appended.evidence).toHaveLength(2);
    expect(appended.version).toBe(2);
    await expect(
      workflows.appendLeadEvidence({ ...input, note: "Changed same key" }),
    ).rejects.toMatchObject({ code: "CPL_IDEMPOTENCY_CONFLICT" });
    await expect(
      workflows.appendLeadEvidence({ ...input, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: "CPL_LEAD_VERSION_CONFLICT" });
    await expect(
      workflows.appendLeadEvidence({ ...input, ...requestB, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: "CPL_RECORD_NOT_FOUND" });
    for (const statement of [
      "UPDATE cpl_lead_evidence SET note='Forged' WHERE lead_id=$1",
      "DELETE FROM cpl_lead_evidence WHERE lead_id=$1",
    ])
      await expect(admin.query(statement, [lead.id])).rejects.toMatchObject({ code: "42501" });
    expect((await workflows.getLead({ ...request, leadId: lead.id })).evidence).toHaveLength(2);
  });
  it("requires reasoned duplicate review and invalidates stale dismissal when another match appears", async () => {
    const request = await intakeWorkspace();
    const original = await workflows.createLead(
      completeIntake(request, { contactEmail: "duplicate@example.invalid" }),
    );
    const other = await workflows.createLead(
      completeIntake(request, {
        title: "Second inquiry",
        contactEmail: "duplicate@example.invalid",
      }),
    );
    const current = await workflows.getLead({ ...request, leadId: original.id });
    expect(current.duplicateCandidates).toEqual([
      { leadId: other.id, title: other.title, reasons: ["same_contact_email"] },
    ]);
    expect(current.readiness.conflicts).toContainEqual(
      expect.objectContaining({ code: "duplicate_review_required" }),
    );
    await expect(
      workflows.updateLead({
        ...request,
        leadId: original.id,
        expectedVersion: 1,
        duplicateDisposition: "distinct",
        status: "ready_for_proposal",
      }),
    ).rejects.toMatchObject({ code: "CPL_INVALID_INPUT" });
    const reviewed = await workflows.updateLead({
      ...request,
      leadId: original.id,
      expectedVersion: 1,
      duplicateDisposition: "distinct",
      duplicateReason: "Separate scope confirmed by the customer",
      status: "ready_for_proposal",
    });
    expect(reviewed.duplicateReview.disposition).toBe("distinct");
    expect(reviewed.readiness.readyForProposal).toBe(true);
    await workflows.createLead(
      completeIntake(request, {
        title: "Third inquiry",
        contactEmail: "duplicate@example.invalid",
      }),
    );
    const invalidated = await workflows.getLead({ ...request, leadId: original.id });
    expect(invalidated.duplicateReview.disposition).toBe("unreviewed");
    expect(invalidated.readiness.readyForProposal).toBe(false);
    await expect(
      workflows.createProposalDraft({
        ...request,
        leadId: original.id,
        title: "Blocked again",
        content: "Scope",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "CPL_LEAD_NOT_READY" });
    const duplicate = await workflows.updateLead({
      ...request,
      leadId: original.id,
      expectedVersion: invalidated.version,
      duplicateDisposition: "duplicate",
      duplicateReason: "Customer confirmed this is the same inquiry",
      duplicateLeadId: other.id,
      status: "needs_info",
    });
    expect(duplicate.readiness.readyForProposal).toBe(false);
    const history = await admin.query<{ count: string }>(
      "SELECT count(*) FROM cpl_lead_review_events WHERE organization_id=$1 AND lead_id=$2",
      [request.organizationId, original.id],
    );
    expect(history.rows[0]?.count).toBe("2");
    await expect(
      admin.query("DELETE FROM cpl_lead_review_events WHERE lead_id=$1", [original.id]),
    ).rejects.toMatchObject({ code: "42501" });
  });
  it("separates intake editing from review permission and rejects foreign or inactive assignees", async () => {
    const request = await intakeWorkspace();
    const reviewer = await signIn(`reviewer-${randomBytes(4).toString("hex")}`);
    const member = await signIn(`member-${randomBytes(4).toString("hex")}`);
    for (const [identity, role] of [
      [reviewer.session.identityId, "reviewer"],
      [member.session.identityId, "member"],
    ])
      await admin.query(
        "INSERT INTO cpl_memberships(organization_id,identity_id,role,status) VALUES($1,$2,$3,'active')",
        [request.organizationId, identity, role],
      );
    const reviewerRequest = { ...request, sessionToken: reviewer.issued.raw },
      memberRequest = { ...request, sessionToken: member.issued.raw };
    const lead = await workflows.createLead(completeIntake(request));
    await expect(
      workflows.updateLead({
        ...reviewerRequest,
        leadId: lead.id,
        expectedVersion: 1,
        title: "Reviewer forged edit",
      }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
    await expect(workflows.createLead(completeIntake(reviewerRequest))).rejects.toMatchObject({
      code: "CPL_ACCESS_DENIED",
    });
    const corrected = await workflows.updateLead({
      ...memberRequest,
      leadId: lead.id,
      expectedVersion: 1,
      notes: "Member correction",
    });
    await expect(
      workflows.updateLead({
        ...memberRequest,
        leadId: lead.id,
        expectedVersion: corrected.version,
        status: "ready_for_proposal",
      }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
    const reviewed = await workflows.updateLead({
      ...reviewerRequest,
      leadId: lead.id,
      expectedVersion: corrected.version,
      status: "ready_for_proposal",
    });
    expect(reviewed.status).toBe("ready_for_proposal");
    expect((await workflows.readWorkspace(reviewerRequest)).permissions).toMatchObject({
      canEditLead: false,
      canReviewLead: true,
    });
    await expect(
      workflows.createLead(
        completeIntake(requestB, { assignedMemberIdentityId: member.session.identityId }),
      ),
    ).rejects.toMatchObject({ code: "CPL_ASSIGNEE_UNAVAILABLE" });
    await admin.query(
      "UPDATE cpl_memberships SET status='removed',version=version+1 WHERE organization_id=$1 AND identity_id=$2",
      [request.organizationId, member.session.identityId],
    );
    await expect(
      workflows.updateLead({
        ...request,
        leadId: lead.id,
        expectedVersion: reviewed.version,
        assignedMemberIdentityId: member.session.identityId,
      }),
    ).rejects.toMatchObject({ code: "CPL_ASSIGNEE_UNAVAILABLE" });
  });
  it("invalidates duplicate dismissal when the same candidate changes its matching evidence", async () => {
    const request = await intakeWorkspace();
    const original = await workflows.createLead(
      completeIntake(request, {
        contactEmail: "candidate-version@example.invalid",
        siteAddress: "1 Example Road",
      }),
    );
    const candidate = await workflows.createLead(
      completeIntake(request, {
        contactEmail: "candidate-version@example.invalid",
        siteAddress: "2 Example Road",
      }),
    );
    const reviewed = await workflows.updateLead({
      ...request,
      leadId: original.id,
      expectedVersion: 1,
      duplicateDisposition: "distinct",
      duplicateReason: "These requests concern different sites",
      status: "ready_for_proposal",
    });
    expect(reviewed.readiness.readyForProposal).toBe(true);
    await workflows.updateLead({
      ...request,
      leadId: candidate.id,
      expectedVersion: 1,
      siteAddress: "1 Example Road",
    });
    const stale = await workflows.getLead({ ...request, leadId: original.id });
    expect(stale.duplicateCandidates[0]?.reasons).toContain("same_site_and_title");
    expect(stale.duplicateReview.disposition).toBe("unreviewed");
    await expect(
      workflows.createProposalDraft({
        ...request,
        leadId: original.id,
        title: "Stale reviewed evidence",
        content: "Manual scope",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "CPL_LEAD_NOT_READY" });
  });
  it("finds normalized customer/title and site/title matches despite internal whitespace", async () => {
    const request = await intakeWorkspace();
    const first = await workflows.createLead(
      completeIntake(request, {
        title: "Service   inquiry",
        customerName: "Fictional   Company",
        siteAddress: "1  Example Road",
      }),
    );
    const second = await workflows.createLead(
      completeIntake(request, {
        title: "Service inquiry",
        customerName: "Fictional Company",
        siteAddress: "1 Example Road",
      }),
    );
    expect(second.duplicateCandidates).toEqual([
      {
        leadId: first.id,
        title: first.title,
        reasons: ["same_customer_and_title", "same_site_and_title"],
      },
    ]);
    expect(second.readiness.readyForProposal).toBe(false);
    await expect(
      workflows.updateLead({
        ...request,
        leadId: second.id,
        expectedVersion: 1,
        status: "ready_for_proposal",
      }),
    ).rejects.toMatchObject({ code: "CPL_LEAD_NOT_READY" });
  });
  it("rechecks assigned-member revocation while proposal creation waits for its row lock", async () => {
    const request = await intakeWorkspace();
    const assigned = await signIn(`assignee-${randomBytes(4).toString("hex")}`);
    await admin.query(
      "INSERT INTO cpl_memberships(organization_id,identity_id,role,status) VALUES($1,$2,'member','active')",
      [request.organizationId, assigned.session.identityId],
    );
    const lead = await workflows.createLead(
      completeIntake(request, { assignedMemberIdentityId: assigned.session.identityId }),
    );
    await workflows.updateLead({
      ...request,
      leadId: lead.id,
      expectedVersion: 1,
      status: "ready_for_proposal",
    });
    const blocker = await admin.pool.connect();
    let processing: Promise<CplProposalDraft> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "UPDATE cpl_memberships SET status='removed',version=version+1 WHERE organization_id=$1 AND identity_id=$2",
        [request.organizationId, assigned.session.identityId],
      );
      processing = workflows.createProposalDraft({
        ...request,
        leadId: lead.id,
        title: "Blocked proposal",
        content: "Manual scope",
        idempotencyKey: randomUUID(),
      });
      // Attach the handler before releasing a rejected operation; no unhandled rejection.
      const outcome = processing.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      let observedLock = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const activity = await admin.query<{ waiting: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE 'SELECT m.identity_id FROM cpl_memberships m%FOR SHARE OF m,i') AS waiting",
          [databaseName],
        );
        if (activity.rows[0]?.waiting) {
          observedLock = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(observedLock).toBe(true);
      await blocker.query("COMMIT");
      expect((await outcome).error).toMatchObject({ code: "CPL_LEAD_NOT_READY" });
      expect(await workflows.listProposalDrafts(request)).toEqual([]);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await processing?.catch(() => undefined);
    }
  });
  it("fences concurrent corrections and enforces RLS on all five new record types", async () => {
    const request = await intakeWorkspace();
    const lead = await workflows.createLead(completeIntake(request));
    const results = await Promise.allSettled(
      ["First", "Second"].map((notes) =>
        workflows.updateLead({ ...request, leadId: lead.id, expectedVersion: 1, notes }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "CPL_LEAD_VERSION_CONFLICT" },
    });
    for (const table of [
      "cpl_customers",
      "cpl_contacts",
      "cpl_sites",
      "cpl_lead_evidence",
      "cpl_lead_review_events",
    ])
      expect((await web.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
    await scope(web, requestB.organizationId, async (executor) => {
      expect(
        (await executor.query("SELECT id FROM cpl_lead_evidence WHERE lead_id=$1", [lead.id])).rows,
      ).toEqual([]);
      await expect(
        executor.query(
          "INSERT INTO cpl_customers(id,organization_id,name,created_by_identity_id) VALUES($1,$2,'Forged',$3)",
          [randomUUID(), request.organizationId, owner.identityId],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    });
    await admin.execute("ALTER TABLE cpl_lead_evidence NO FORCE ROW LEVEL SECURITY");
    try {
      await expect(verifyHostedDatabaseRole(web, "web")).rejects.toThrow(
        "CPL_HOSTED_DATABASE_ROLE_REFUSED",
      );
      await expect(workflows.getLead({ ...request, leadId: lead.id })).rejects.toMatchObject({
        code: "CPL_INTAKE_SCHEMA_UNSAFE",
      });
    } finally {
      await admin.execute("ALTER TABLE cpl_lead_evidence FORCE ROW LEVEL SECURITY");
    }
    expect((await workflows.getLead({ ...request, leadId: lead.id })).version).toBe(2);
  });
  it("suspends the bound owner's privilege if its later verified Google claims drift", async () => {
    await signIn("owner-subject", "changed@example.invalid", null);
    expect(
      (await auth.readSession(ownerMaterial.value.tokenHash, now()))?.platformAdministrator,
    ).toBe(false);
    await expect(
      tenants.createEnabledOrganization(ownerMaterial.raw, {
        slug: "after-drift",
        displayName: "Denied",
      }),
    ).rejects.toMatchObject({ code: "CPL_PLATFORM_ADMIN_REQUIRED" });
    expect(
      (
        await admin.query(
          "SELECT action FROM cpl_auth_audit_events WHERE action='owner.claims-changed'",
        )
      ).rows,
    ).toHaveLength(1);
    await auth.revokeSession(ownerMaterial.value.tokenHash, now(), true);
    expect(await auth.readSession(ownerMaterial.value.tokenHash, now())).toBeNull();
  });
});
