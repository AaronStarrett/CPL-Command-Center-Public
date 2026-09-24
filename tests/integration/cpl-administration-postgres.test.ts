import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgSqlDatabaseAdapter } from "../../packages/database/src/pg-sql-adapter";
import { migrateDatabase, verifyMigrations } from "../../packages/database/src/migrations";
import {
  configureHostedRuntimeRole,
  configureCplAutomationWorker,
  verifyHostedDatabaseRole,
} from "../../packages/database/src/hosted-database-role";
import { SqlCplHostedAuthStore } from "../../packages/database/src/hosted-auth-store";
import { SqlCplTenantRepository } from "../../packages/database/src/tenant-repository";
import { SqlCplAdministrationRepository } from "../../packages/database/src/cpl-administration-repository";
import {
  SqlCplWorkflowRepository,
  processHostedJobs,
} from "../../packages/database/src/hosted-workflow";
import { SqlCplAutomationRepository } from "../../packages/database/src/cpl-automation-repository";
import { SqlCplCommercialRepository } from "../../packages/database/src/cpl-commercial-repository";
import { SqlCplExecutionRepository } from "../../packages/database/src/cpl-execution-repository";
import { SqlCplFieldRepository } from "../../packages/database/src/cpl-field-repository";
import { SqlCplReportRepository } from "../../packages/database/src/cpl-report-repository";
import { SqlCplDeliveryRepository } from "../../packages/database/src/cpl-delivery-repository";
import { defaultCplCommercialBranding } from "../../packages/domain/src/cpl-commercial";
import type { CplVisitInput } from "../../packages/domain/src/cpl-execution";
import type { CplAdminRole } from "../../packages/domain/src/cpl-admin";
import { CPL_LOCAL_IDENTITY_ISSUER } from "../../packages/security/src/local-development-auth";

const material = process.env.CPL_HOSTED_POSTGRES_TEST_CONFIG_JSON,
  configPath = process.env.CPL_HOSTED_POSTGRES_TEST_CONFIG;
const suite = material || configPath ? describe : describe.skip;
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
suite("company administration using isolated restricted PostgreSQL", () => {
  let control: PgSqlDatabaseAdapter,
    admin: PgSqlDatabaseAdapter,
    web: PgSqlDatabaseAdapter,
    worker: PgSqlDatabaseAdapter;
  let auth: SqlCplHostedAuthStore,
    tenants: SqlCplTenantRepository,
    service: SqlCplAdministrationRepository;
  const databaseName = `cpl_administration_test_${randomBytes(6).toString("hex")}`;
  let created = false;
  beforeAll(async () => {
    const config = JSON.parse(material ?? readFileSync(configPath!, "utf8"));
    for (const url of [config.adminUrl, config.webUrl, config.workerUrl])
      if (!["127.0.0.1", "localhost"].includes(new URL(url).hostname))
        throw Error("Isolated local PostgreSQL only");
    control = new PgSqlDatabaseAdapter({ connectionString: config.adminUrl, max: 1 });
    await control.execute(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const connect = (raw: string) => {
      const u = new URL(raw);
      u.pathname = "/" + databaseName;
      return u.href;
    };
    admin = new PgSqlDatabaseAdapter({ connectionString: connect(config.adminUrl), max: 3 });
    await migrateDatabase(admin);
    await configureHostedRuntimeRole(admin, new URL(config.webUrl).username, "web");
    await configureHostedRuntimeRole(admin, new URL(config.workerUrl).username, "worker");
    await configureCplAutomationWorker(admin, new URL(config.workerUrl).username);
    web = new PgSqlDatabaseAdapter({
      connectionString: connect(config.webUrl),
      max: 6,
      statement_timeout: 10000,
    });
    worker = new PgSqlDatabaseAdapter({
      connectionString: connect(config.workerUrl),
      max: 2,
      statement_timeout: 10000,
    });
    auth = new SqlCplHostedAuthStore(web);
    tenants = new SqlCplTenantRepository(web);
    service = new SqlCplAdministrationRepository(tenants);
  }, 180000);
  afterAll(async () => {
    await Promise.all([worker?.close(), web?.close(), admin?.close()]);
    if (created) await control.execute(`DROP DATABASE "${databaseName}" WITH(FORCE)`);
    await control?.close();
  }, 60000);
  async function login(displayName = "Fictional administration user") {
    const token = randomBytes(32).toString("base64url"),
      now = new Date().toISOString();
    const session = await auth.createSession({
      identity: {
        issuer: "https://accounts.google.com",
        subject: randomUUID(),
        email: "fictional@example.invalid",
        emailVerified: true,
        hostedDomain: null,
        displayName,
        authenticatedAt: now,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
      material: {
        tokenHash: sha(token),
        csrfTokenHash: sha(randomUUID()),
        expiresAt: new Date(Date.now() + 3500000).toISOString(),
        absoluteExpiresAt: new Date(Date.now() + 28000000).toISOString(),
      },
      now,
    });
    return { token, identityId: session.identityId, sessionId: session.id };
  }
  async function operator() {
    const actor = await login("Fictional test platform operator");
    // Test-only operator establishment. Application routes cannot execute this SQL.
    await admin.query(
      "INSERT INTO cpl_platform_administrators(identity_id,status) VALUES($1,'active')",
      [actor.identityId],
    );
    await admin.query(
      "UPDATE cpl_sessions SET mfa_verified=TRUE,mfa_verified_at=clock_timestamp() WHERE id=$1",
      [actor.sessionId],
    );
    return actor;
  }
  async function fixture(
    modules = [
      "intake-job-tracker",
      "proposal-builder",
      "award-to-project-launcher",
      "field-report-assembler",
    ],
  ) {
    const platform = await operator(),
      owner = await login("Fictional company owner");
    const input = {
      slug: "fictional-" + randomBytes(5).toString("hex"),
      displayName: "Fictional phase five company",
      initialOwnerIdentityId: owner.identityId,
      enabledModules: modules,
      idempotencyKey: randomUUID(),
    };
    const org = await service.provisionOrganization({ sessionToken: platform.token, input });
    return {
      platform,
      owner,
      org,
      input,
      request: { sessionToken: owner.token, organizationId: org.id },
    };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function join(
    f: Fixture,
    role: Exclude<CplAdminRole, "owner"> = "member",
    displayName = "Fictional invited member",
  ) {
    const user = await login(displayName);
    const issued = await service.createInvitation({
      ...f.request,
      input: { recipientIdentityId: user.identityId, role, idempotencyKey: randomUUID() },
    });
    const access = await service.acceptInvitation({
      sessionToken: user.token,
      organizationId: f.org.id,
      invitationToken: issued.token!,
      idempotencyKey: randomUUID(),
    });
    return {
      ...user,
      role,
      version: access.membershipVersion,
      issued,
      request: { sessionToken: user.token, organizationId: f.org.id },
    };
  }
  const change = (
    f: Fixture,
    identityId: string,
    role: CplAdminRole,
    status: "active" | "removed" | "suspended",
    expectedVersion: number,
  ) =>
    service.changeMember({
      ...f.request,
      input: {
        identityId,
        role,
        status,
        expectedVersion,
        reason: "Deliberate fictional team administration",
        idempotencyKey: randomUUID(),
      },
    });
  it("applies forward migration without seeds and verifies forced RLS and role grants", async () => {
    const migrations = await verifyMigrations(admin);
    expect(migrations.current).toBe("0039_cpl_durable_inbound.sql");
    expect(migrations.verified).toContain("0036_cpl_company_administration.sql");
    await expect(verifyHostedDatabaseRole(web, "web")).resolves.toMatchObject({ purpose: "web" });
    await expect(verifyHostedDatabaseRole(worker, "worker")).resolves.toMatchObject({
      purpose: "worker",
    });
    const rows = await admin.query(
      "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN('cpl_administration_mutations','cpl_platform_provision_requests')",
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((r) => r.relrowsecurity && r.relforcerowsecurity)).toBe(true);
    expect((await admin.query("SELECT * FROM cpl_identities")).rows).toHaveLength(0);
  });
  it("provisions the explicit distinct owner and modules once under concurrent retries", async () => {
    const f = await fixture(["intake-job-tracker"]);
    const repeated = await Promise.all([
      service.provisionOrganization({ sessionToken: f.platform.token, input: f.input }),
      service.provisionOrganization({ sessionToken: f.platform.token, input: f.input }),
    ]);
    expect(repeated.map((r) => r.id)).toEqual([f.org.id, f.org.id]);
    expect(
      (
        await admin.query("SELECT identity_id,role FROM cpl_memberships WHERE organization_id=$1", [
          f.org.id,
        ])
      ).rows,
    ).toEqual([{ identity_id: f.owner.identityId, role: "owner" }]);
    expect(
      (
        await admin.query("SELECT 1 FROM cpl_platform_administrators WHERE identity_id=$1", [
          f.owner.identityId,
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (await tenants.listEntitlements(f.request)).filter((m) => m.enabled).map((m) => m.moduleKey),
    ).toEqual(["intake-job-tracker"]);
    for (const table of [
      "cpl_workflow_leads",
      "cpl_commercial_proposals",
      "cpl_commercial_projects",
      "cpl_reports",
      "cpl_workflow_jobs",
    ])
      expect(
        (await admin.query(`SELECT 1 FROM ${table} WHERE organization_id=$1`, [f.org.id])).rows,
      ).toEqual([]);
  });
  it("fails closed for company owners, missing MFA, same operator/owner and unlaunched modules", async () => {
    const f = await fixture();
    await expect(
      service.provisionOrganization({
        sessionToken: f.owner.token,
        input: { ...f.input, idempotencyKey: randomUUID() },
      }),
    ).rejects.toMatchObject({ code: "CPL_PLATFORM_MFA_REQUIRED" });
    await expect(
      service.provisionOrganization({
        sessionToken: f.platform.token,
        input: { ...f.input, initialOwnerIdentityId: f.platform.identityId },
      }),
    ).rejects.toMatchObject({ code: "CPL_INITIAL_OWNER_MUST_BE_DISTINCT" });
    await expect(
      service.provisionOrganization({
        sessionToken: f.platform.token,
        input: { ...f.input, enabledModules: ["ai-receptionist"] },
      }),
    ).rejects.toMatchObject({ code: "CPL_ADMIN_INVALID_INPUT" });
    await admin.query(
      "UPDATE cpl_sessions SET mfa_verified_at=clock_timestamp()-interval '16 minutes' WHERE id=$1",
      [f.platform.sessionId],
    );
    await expect(
      service.provisionOrganization({ sessionToken: f.platform.token, input: f.input }),
    ).rejects.toMatchObject({ code: "CPL_PLATFORM_MFA_REQUIRED" });
  });
  it("rolls back company, owner, modules and receipt if platform audit fails", async () => {
    const platform = await operator(),
      owner = await login(),
      slug = "rollback-" + randomBytes(5).toString("hex");
    await admin.execute(
      "ALTER TABLE cpl_platform_audit_events ADD CONSTRAINT synthetic_admin_audit_failure CHECK(action<>'company.provisioned') NOT VALID",
    );
    try {
      await expect(
        service.provisionOrganization({
          sessionToken: platform.token,
          input: {
            slug,
            displayName: "Fictional rollback",
            initialOwnerIdentityId: owner.identityId,
            enabledModules: [],
            idempotencyKey: randomUUID(),
          },
        }),
      ).rejects.toThrow();
    } finally {
      await admin.execute(
        "ALTER TABLE cpl_platform_audit_events DROP CONSTRAINT synthetic_admin_audit_failure",
      );
    }
    expect(
      (await admin.query("SELECT 1 FROM cpl_organizations WHERE slug=$1", [slug])).rows,
    ).toEqual([]);
    expect(
      (await admin.query("SELECT 1 FROM cpl_memberships WHERE identity_id=$1", [owner.identityId]))
        .rows,
    ).toEqual([]);
  });
  it("rejects reused provisioning keys with changed intent and duplicate slugs", async () => {
    const f = await fixture();
    await expect(
      service.provisionOrganization({
        sessionToken: f.platform.token,
        input: { ...f.input, displayName: "Changed" },
      }),
    ).rejects.toMatchObject({ code: "CPL_ADMIN_IDEMPOTENCY_CONFLICT" });
    await expect(
      service.provisionOrganization({
        sessionToken: f.platform.token,
        input: { ...f.input, idempotencyKey: randomUUID() },
      }),
    ).rejects.toMatchObject({ code: "CPL_ORGANIZATION_SLUG_UNAVAILABLE" });
  });
  it("bootstraps administration without product modules and keeps platform capability separate", async () => {
    const f = await fixture([]);
    const boot = await service.bootstrap({ ...f.request });
    expect(boot.enabledModules).toEqual([]);
    expect(boot.platform.canProvision).toBe(false);
    expect(boot.permissions.canManageMembers).toBe(true);
    expect(boot.localRecipients).toEqual([]);
    const operatorBoot = await service.bootstrap({ sessionToken: f.platform.token });
    expect(operatorBoot.platform).toEqual({ canProvision: true, assurance: "verified-mfa" });
    expect(operatorBoot.organizations).toEqual([]);
    expect(operatorBoot.permissions.canManageMembers).toBe(false);
    await tenants.setSetting({
      ...f.request,
      key: "company.profile",
      value: { displayName: "Updated current company label" },
      expectedVersion: 0,
    });
    expect((await service.bootstrap(f.request)).organizations[0]!.displayName).toBe(
      "Updated current company label",
    );
  });
  it("protects the last owner and serializes reciprocal owner removals without deadlock", async () => {
    const f = await fixture(),
      second = await join(f);
    await expect(change(f, f.owner.identityId, "member", "active", 1)).rejects.toMatchObject({
      code: "CPL_LAST_ACTIVE_OWNER",
    });
    await change(f, second.identityId, "owner", "active", second.version);
    const result = await Promise.allSettled([
      change(f, second.identityId, "owner", "removed", 2),
      service.changeMember({
        ...second.request,
        input: {
          identityId: f.owner.identityId,
          role: "owner",
          status: "removed",
          expectedVersion: 1,
          reason: "Concurrent deliberate owner removal",
          idempotencyKey: randomUUID(),
        },
      }),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(result.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(
      (
        await admin.query(
          "SELECT count(*)::integer AS count FROM cpl_memberships WHERE organization_id=$1 AND role='owner' AND status='active'",
          [f.org.id],
        )
      ).rows[0]!.count,
    ).toBe(1);
  });
  it("prevents admin self-escalation and unauthorized owner/admin changes", async () => {
    const f = await fixture(),
      a = await join(f, "admin"),
      m = await join(f, "member");
    for (const identityId of [a.identityId, f.owner.identityId, m.identityId])
      await expect(
        service.changeMember({
          ...a.request,
          input: {
            identityId,
            role: "owner",
            status: "active",
            expectedVersion: 1,
            reason: "Forbidden escalation",
            idempotencyKey: randomUUID(),
          },
        }),
      ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
    await expect(service.listMembers(m.request)).rejects.toMatchObject({
      code: "CPL_ACCESS_DENIED",
    });
    await expect(
      service.changeMember({
        ...f.request,
        input: {
          identityId: m.identityId,
          role: "platform-admin",
          status: "active",
          expectedVersion: 1,
          reason: "Forged role",
          idempotencyKey: randomUUID(),
        },
      }),
    ).rejects.toThrow();
  });
  it("rejects stale changes and retains atomic reasoned audit with idempotent retry", async () => {
    const f = await fixture(),
      m = await join(f);
    const input = {
      identityId: m.identityId,
      role: "reviewer",
      status: "active",
      expectedVersion: 1,
      reason: "Review responsibility\nexplicitly reassigned",
      idempotencyKey: randomUUID(),
    };
    expect((await service.changeMember({ ...f.request, input })).version).toBe(2);
    expect((await service.changeMember({ ...f.request, input })).version).toBe(2);
    await expect(change(f, m.identityId, "member", "active", 1)).rejects.toMatchObject({
      code: "CPL_ADMIN_STALE_VERSION",
    });
    const events = await admin.query(
      "SELECT safe_summary,resource_version FROM cpl_tenant_audit_events WHERE organization_id=$1 AND resource_id=$2 AND action='membership.changed'",
      [f.org.id, m.identityId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]!.safe_summary).toMatchObject({
      message: input.reason,
      previousRole: "member",
      role: "reviewer",
    });
  });
  it("revokes old-session company authority immediately but retains other-company membership/history", async () => {
    const f = await fixture(),
      other = await fixture(),
      m = await join(f, "manager");
    const invitation = await service.createInvitation({
      ...other.request,
      input: { recipientIdentityId: m.identityId, role: "member", idempotencyKey: randomUUID() },
    });
    await service.acceptInvitation({
      ...m.request,
      organizationId: other.org.id,
      invitationToken: invitation.token!,
      idempotencyKey: randomUUID(),
    });
    await change(f, m.identityId, "manager", "suspended", 1);
    await expect(
      tenants.authorize({ ...m.request, permission: "records:read", module: "proposal-builder" }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
    await expect(
      tenants.authorize({ ...m.request, organizationId: other.org.id, permission: "records:read" }),
    ).resolves.toMatchObject({ role: "member" });
    expect((await auth.readSession(sha(m.token), new Date().toISOString()))?.identityId).toBe(
      m.identityId,
    );
    await change(f, m.identityId, "manager", "active", 2);
    await expect(
      tenants.authorize({ ...m.request, permission: "records:read" }),
    ).resolves.toMatchObject({ membershipVersion: 3 });
    expect(
      (
        await admin.query("SELECT 1 FROM cpl_tenant_audit_events WHERE actor_identity_id=$1", [
          m.identityId,
        ])
      ).rows.length,
    ).toBeGreaterThan(0);
  });
  it("lists deterministic bounded member pages and accurate filtered totals without cross-tenant entries", async () => {
    const f = await fixture(),
      other = await fixture();
    for (let n = 0; n < 5; n++) await join(f, "member", `Pagination user ${n}`);
    await join(other, "member", "Pagination foreign");
    const all: string[] = [];
    let cursor: string | null = null;
    do {
      const result = await service.listMembers({
        ...f.request,
        query: "Pagination",
        limit: 2,
        cursor,
      });
      expect(result.total).toBe(5);
      all.push(...result.items.map((m) => m.identityId));
      cursor = result.nextCursor;
    } while (cursor);
    expect(all).toHaveLength(5);
    expect(new Set(all).size).toBe(5);
    const first = await service.listMembers({ ...f.request, query: "Pagination", limit: 2 });
    await expect(
      service.listMembers({ ...f.request, query: "different", cursor: first.nextCursor }),
    ).rejects.toMatchObject({ code: "CPL_ADMIN_INVALID_CURSOR" });
  });
  it("keeps tokens hashed, subject-bound, undisclosed in lists/audit and issues once per request", async () => {
    const f = await fixture(),
      recipient = await login(),
      wrong = await login();
    const input = {
      recipientIdentityId: recipient.identityId,
      role: "member",
      idempotencyKey: randomUUID(),
    };
    const issued = await service.createInvitation({ ...f.request, input });
    expect((await service.createInvitation({ ...f.request, input })).token).toBeNull();
    await expect(
      service.createInvitation({ ...f.request, input: { ...input, idempotencyKey: randomUUID() } }),
    ).rejects.toMatchObject({ code: "CPL_INVITATION_ALREADY_EXISTS" });
    const stored = (
      await admin.query(
        "SELECT token_hash,inviter_membership_version FROM cpl_invitations WHERE id=$1",
        [issued.invitation.id],
      )
    ).rows[0]!;
    expect(stored.token_hash).toBe(sha(issued.token!));
    expect(stored.inviter_membership_version).toBe(1);
    await expect(
      service.acceptInvitation({
        sessionToken: wrong.token,
        organizationId: f.org.id,
        invitationToken: issued.token!,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "CPL_INVITATION_UNAVAILABLE" });
    expect(JSON.stringify(await service.listInvitations(f.request))).not.toContain(issued.token!);
    expect(
      JSON.stringify(
        (
          await admin.query(
            "SELECT safe_summary FROM cpl_tenant_audit_events WHERE organization_id=$1",
            [f.org.id],
          )
        ).rows,
      ),
    ).not.toContain(issued.token!);
  });
  it("accepts concurrent same-subject retries with exactly one membership and redemption event", async () => {
    const f = await fixture(),
      user = await login();
    const issued = await service.createInvitation({
      ...f.request,
      input: { recipientIdentityId: user.identityId, role: "member", idempotencyKey: randomUUID() },
    });
    const request = {
      sessionToken: user.token,
      organizationId: f.org.id,
      invitationToken: issued.token!,
      idempotencyKey: randomUUID(),
    };
    const results = await Promise.all([
      service.acceptInvitation(request),
      service.acceptInvitation(request),
    ]);
    expect(results.every((a) => a.membershipVersion === 1)).toBe(true);
    expect(
      (
        await admin.query(
          "SELECT 1 FROM cpl_tenant_audit_events WHERE organization_id=$1 AND resource_id=$2 AND action='invitation.redeemed'",
          [f.org.id, issued.invitation.id],
        )
      ).rows,
    ).toHaveLength(1);
    await change(f, user.identityId, "member", "removed", 1);
    await expect(service.acceptInvitation(request)).rejects.toMatchObject({
      code: "CPL_INVITATION_UNAVAILABLE",
    });
  });
  it("handles expiry/revocation/reissue and invalidates every older token", async () => {
    const f = await fixture(),
      user = await login();
    const first = await service.createInvitation({
      ...f.request,
      input: {
        recipientIdentityId: user.identityId,
        role: "reviewer",
        idempotencyKey: randomUUID(),
      },
    });
    await admin.query(
      "UPDATE cpl_invitations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [first.invitation.id],
    );
    await expect(
      service.acceptInvitation({
        sessionToken: user.token,
        organizationId: f.org.id,
        invitationToken: first.token!,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "CPL_INVITATION_UNAVAILABLE" });
    const input = {
      invitationId: first.invitation.id,
      expectedVersion: 1,
      reason: "Fresh deliberate local handoff",
      idempotencyKey: randomUUID(),
    };
    const second = await service.reissueInvitation({ ...f.request, input });
    expect(second.invitation.replacesId).toBe(first.invitation.id);
    expect(second.token).not.toBe(first.token);
    expect((await service.reissueInvitation({ ...f.request, input })).token).toBeNull();
    const superseded = (await service.listInvitations(f.request)).items.find(
      (i) => i.id === first.invitation.id,
    )!;
    expect(superseded.canReissue).toBe(false);
    await expect(
      service.reissueInvitation({
        ...f.request,
        input: { ...input, expectedVersion: superseded.version, idempotencyKey: randomUUID() },
      }),
    ).rejects.toMatchObject({ code: "CPL_INVITATION_UNAVAILABLE" });
    await service.revokeInvitation({
      ...f.request,
      input: {
        invitationId: second.invitation.id,
        expectedVersion: 1,
        reason: "Revoke fictional invitation",
        idempotencyKey: randomUUID(),
      },
    });
    for (const token of [first.token!, second.token!])
      await expect(
        service.acceptInvitation({
          sessionToken: user.token,
          organizationId: f.org.id,
          invitationToken: token,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "CPL_INVITATION_UNAVAILABLE" });
  });
  it("never revives an old invitation/service grant after inviter suspension and reactivation", async () => {
    const f = await fixture(),
      inviter = await join(f, "admin"),
      recipient = await login();
    const invitation = await service.createInvitation({
      ...inviter.request,
      input: {
        recipientIdentityId: recipient.identityId,
        role: "member",
        idempotencyKey: randomUUID(),
      },
    });
    const grant = await tenants.issueServiceGrant({
      ...inviter.request,
      module: "proposal-builder",
    });
    await change(f, inviter.identityId, "admin", "suspended", 1);
    await change(f, inviter.identityId, "admin", "active", 2);
    const list = await service.listInvitations(f.request);
    expect(list.items.find((i) => i.id === invitation.invitation.id)?.status).toBe(
      "authority_changed",
    );
    await expect(
      service.acceptInvitation({
        sessionToken: recipient.token,
        organizationId: f.org.id,
        invitationToken: invitation.token!,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "CPL_INVITATION_UNAVAILABLE" });
    await expect(
      tenants.authorizeService({
        token: grant.token,
        organizationId: f.org.id,
        module: "proposal-builder",
      }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
  });
  it("keeps owner-only admin invitations unavailable to lower administrators", async () => {
    const f = await fixture(),
      a = await join(f, "admin"),
      recipient = await login();
    await expect(
      service.createInvitation({
        ...a.request,
        input: {
          recipientIdentityId: recipient.identityId,
          role: "admin",
          idempotencyKey: randomUUID(),
        },
      }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
    const issued = await service.createInvitation({
      ...f.request,
      input: {
        recipientIdentityId: recipient.identityId,
        role: "admin",
        idempotencyKey: randomUUID(),
      },
    });
    await expect(
      service.revokeInvitation({
        ...a.request,
        input: {
          invitationId: issued.invitation.id,
          expectedVersion: 1,
          reason: "Forbidden",
          idempotencyKey: randomUUID(),
        },
      }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
    await expect(
      tenants.revokeInvitation({ ...a.request, invitationId: issued.invitation.id }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
    expect(
      (
        await admin.query("SELECT revoked_at,version FROM cpl_invitations WHERE id=$1", [
          issued.invitation.id,
        ])
      ).rows[0],
    ).toEqual({ revoked_at: null, version: 1 });
    await expect(
      tenants.revokeInvitation({ ...f.request, invitationId: issued.invitation.id }),
    ).resolves.toBeUndefined();
    expect(
      (
        await admin.query("SELECT revoked_at,version FROM cpl_invitations WHERE id=$1", [
          issued.invitation.id,
        ])
      ).rows[0],
    ).toMatchObject({ version: 2 });
  });
  it("rolls back membership mutation when its audit cannot commit", async () => {
    const f = await fixture(),
      m = await join(f);
    await admin.execute(
      "ALTER TABLE cpl_tenant_audit_events ADD CONSTRAINT synthetic_member_audit_failure CHECK(action<>'membership.changed') NOT VALID",
    );
    try {
      await expect(change(f, m.identityId, "reviewer", "active", 1)).rejects.toThrow();
    } finally {
      await admin.execute(
        "ALTER TABLE cpl_tenant_audit_events DROP CONSTRAINT synthetic_member_audit_failure",
      );
    }
    expect(
      (
        await admin.query(
          "SELECT role,version FROM cpl_memberships WHERE organization_id=$1 AND identity_id=$2",
          [f.org.id, m.identityId],
        )
      ).rows[0],
    ).toEqual({ role: "member", version: 1 });
  });
  it("isolates administration reads and refuses worker access to administrative capabilities", async () => {
    const a = await fixture(),
      b = await fixture();
    await expect(
      service.listMembers({ ...a.request, organizationId: b.org.id }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
    await expect(
      service.listInvitations({ ...a.request, organizationId: b.org.id }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
    expect((await web.query("SELECT * FROM cpl_administration_mutations")).rows).toEqual([]);
    expect((await web.query("SELECT * FROM cpl_platform_provision_requests")).rows).toEqual([]);
    await expect(worker.query("SELECT * FROM cpl_platform_provision_requests")).rejects.toThrow();
    await expect(worker.query("SELECT * FROM cpl_administration_mutations")).rejects.toThrow();
  });
  it("preserves assignments and surfaces reassignment after suspension", async () => {
    const f = await fixture(),
      m = await join(f),
      intake = new SqlCplWorkflowRepository(web, tenants);
    const lead = await intake.createLead({
      ...f.request,
      title: "Fictional assigned intake",
      assignedMemberIdentityId: m.identityId,
      idempotencyKey: randomUUID(),
    });
    await change(f, m.identityId, "member", "suspended", 1);
    expect(
      (await service.listMembers(f.request)).items.find((x) => x.identityId === m.identityId)
        ?.needsReassignment,
    ).toBe(true);
    expect((await intake.getLead({ ...f.request, leadId: lead.id })).assignedMemberIdentityId).toBe(
      m.identityId,
    );
  });
  it("rechecks queued recipe sponsor after role change and never revives its old grant", async () => {
    const f = await fixture(),
      sponsor = await join(f, "admin"),
      intake = new SqlCplWorkflowRepository(web, tenants),
      automation = new SqlCplAutomationRepository(tenants);
    await automation.saveRecipe({
      ...sponsor.request,
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
      input: {
        name: "Fictional revoked sponsor handoff",
        trigger: "lead.ready",
        enabled: true,
        service: "Fictional phase5",
        prepareDraft: false,
        templateId: null,
        templateVersion: null,
        templateApprovedForAutomation: false,
        owner: { kind: "unassigned", identityId: null, role: null },
        dueAfterHours: null,
        taskTitle: "Human review",
      },
    });
    const lead = await intake.createLead({
      ...f.request,
      title: "Fictional queued lead",
      customerName: "Fictional customer",
      contactName: "Fictional contact",
      contactEmail: "f@example.invalid",
      siteName: "Fictional site",
      siteAddress: "123 Fictional Road",
      details: "Confirmed scope",
      requestedService: "Fictional phase5",
      assignedMemberIdentityId: f.owner.identityId,
      nextAction: "Review",
      idempotencyKey: randomUUID(),
    });
    await intake.updateLead({
      ...f.request,
      leadId: lead.id,
      expectedVersion: lead.version,
      status: "ready_for_proposal",
    });
    await change(f, sponsor.identityId, "admin", "suspended", 1);
    await change(f, sponsor.identityId, "admin", "active", 2);
    await processHostedJobs(worker, { claimOwner: "phase5-isolated-test", limit: 1 });
    const jobs = (
      await admin.query(
        "SELECT status,last_error_code FROM cpl_workflow_jobs WHERE organization_id=$1 AND kind='automation.recipe'",
        [f.org.id],
      )
    ).rows;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe("skipped");
    expect(
      (
        await admin.query(
          "SELECT 1 FROM cpl_action_tasks WHERE organization_id=$1 AND execution_id IS NOT NULL",
          [f.org.id],
        )
      ).rows,
    ).toEqual([]);
  });
  it("a local administration flag alone cannot bypass the production/environment/database boundary", async () => {
    const user = await login();
    const local = new SqlCplAdministrationRepository(
      new SqlCplTenantRepository(web, { localDevelopmentAdministration: true }),
    );
    await expect(
      local.provisionOrganization({
        sessionToken: user.token,
        input: {
          slug: "forbidden-local",
          displayName: "Forbidden",
          initialOwnerIdentityId: randomUUID(),
          enabledModules: [],
          idempotencyKey: randomUUID(),
        },
      }),
    ).rejects.toThrow();
    expect(
      (await admin.query("SELECT 1 FROM cpl_organizations WHERE slug='forbidden-local'")).rows,
    ).toEqual([]);
  });
  it.each(["suspended", "demoted"] as const)(
    "denies queued work after sponsor %s, preserves another company, and requires a new grant after restoration",
    async (mode) => {
      const a = await fixture(),
        b = await fixture(),
        sponsor = await join(a, "admin");
      const invitation = await service.createInvitation({
        ...b.request,
        input: {
          recipientIdentityId: sponsor.identityId,
          role: "admin",
          idempotencyKey: randomUUID(),
        },
      });
      await service.acceptInvitation({
        sessionToken: sponsor.token,
        organizationId: b.org.id,
        invitationToken: invitation.token!,
        idempotencyKey: randomUUID(),
      });
      const bScope = { sessionToken: sponsor.token, organizationId: b.org.id };
      const intake = new SqlCplWorkflowRepository(web, tenants),
        automation = new SqlCplAutomationRepository(tenants),
        commercial = new SqlCplCommercialRepository(tenants);
      const configure = async (f: Fixture) => {
        const template = await commercial.createTemplate({
          ...f.request,
          idempotencyKey: randomUUID(),
          input: {
            name: "Explicit fictional queued-work template",
            currency: "USD",
            catalog: [
              {
                serviceCode: "QUEUED",
                description: "Fictional service",
                unit: "visit",
                unitPriceMinor: 50000,
              },
            ],
            terms: "Human approval remains required",
          },
        });
        const input = {
          name: "Fictional current membership handoff",
          trigger: "lead.ready" as const,
          enabled: true,
          service: "Phase5 queued authority",
          prepareDraft: true,
          templateId: template.id,
          templateVersion: 1,
          templateApprovedForAutomation: true,
          owner: { kind: "unassigned" as const, identityId: null, role: null },
          dueAfterHours: null,
          taskTitle: "Human proposal review",
        };
        const recipe = await automation.saveRecipe({
          sessionToken: sponsor.token,
          organizationId: f.org.id,
          expectedVersion: 0,
          idempotencyKey: randomUUID(),
          input,
        });
        return { recipe, input };
      };
      const source = async (f: Fixture) => {
        const unique = randomUUID();
        const lead = await intake.createLead({
          ...f.request,
          title: "Fictional queue " + unique,
          customerName: "Customer " + unique,
          contactName: "Fictional contact",
          contactEmail: unique + "@example.invalid",
          siteName: "Site " + unique,
          siteAddress: "Fictional address " + unique,
          details: "Confirmed synthetic service scope",
          requestedService: "Phase5 queued authority",
          assignedMemberIdentityId: f.owner.identityId,
          nextAction: "Review",
          idempotencyKey: randomUUID(),
        });
        return intake.updateLead({
          ...f.request,
          leadId: lead.id,
          expectedVersion: lead.version,
          status: "ready_for_proposal",
        });
      };
      const counts = async (f: Fixture) =>
        (
          await admin.query(
            `SELECT
        (SELECT count(*)::integer FROM cpl_commercial_proposals WHERE organization_id=$1) AS proposals,
        (SELECT count(*)::integer FROM cpl_action_tasks WHERE organization_id=$1 AND execution_id IS NOT NULL) AS tasks,
        (SELECT count(*)::integer FROM cpl_workflow_jobs WHERE organization_id=$1 AND kind='automation.recipe' AND status='completed') AS completed,
        (SELECT count(*)::integer FROM cpl_workflow_jobs WHERE organization_id=$1 AND kind='automation.recipe' AND status='skipped') AS skipped`,
            [f.org.id],
          )
        ).rows[0];
      const run = async (cycles: number) => {
        for (let n = 0; n < cycles; n++)
          await processHostedJobs(worker, {
            claimOwner: "phase5-real-worker-revocation",
            limit: 1,
          });
      };
      const configured = await configure(a);
      await configure(b);
      await source(a);
      await source(b);
      await change(
        a,
        sponsor.identityId,
        mode === "demoted" ? "member" : "admin",
        mode === "suspended" ? "suspended" : "active",
        1,
      );
      await expect(
        automation.saveRecipe({
          ...sponsor.request,
          recipeId: configured.recipe.id,
          expectedVersion: 1,
          idempotencyKey: randomUUID(),
          input: configured.input,
        }),
      ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
      expect(
        (await service.listMembers(bScope)).items.find((m) => m.identityId === sponsor.identityId),
      ).toMatchObject({ status: "active", role: "admin", version: 1 });
      await run(4);
      expect(await counts(a)).toEqual({ proposals: 0, tasks: 0, completed: 0, skipped: 1 });
      expect(await counts(b)).toEqual({ proposals: 1, tasks: 1, completed: 1, skipped: 0 });
      await change(a, sponsor.identityId, "admin", "active", 2);
      await source(a);
      await run(3);
      expect(await counts(a)).toEqual({ proposals: 0, tasks: 0, completed: 0, skipped: 2 });
      const old = (await automation.getWorkspace(a.request)).executions;
      expect(old).toHaveLength(2);
      expect(old.every((job) => job.status === "skipped")).toBe(true);
      await automation.saveRecipe({
        ...sponsor.request,
        recipeId: configured.recipe.id,
        expectedVersion: 1,
        idempotencyKey: randomUUID(),
        input: configured.input,
      });
      await source(a);
      await run(4);
      expect(await counts(a)).toEqual({ proposals: 1, tasks: 1, completed: 1, skipped: 2 });
      expect(await counts(b)).toEqual({ proposals: 1, tasks: 1, completed: 1, skipped: 0 });
      await source(a);
      await automation.saveRecipe({
        ...sponsor.request,
        recipeId: configured.recipe.id,
        expectedVersion: 2,
        idempotencyKey: randomUUID(),
        input: { ...configured.input, enabled: false },
      });
      await run(3);
      expect(await counts(a)).toEqual({ proposals: 1, tasks: 1, completed: 1, skipped: 3 });
      await automation.saveRecipe({
        ...sponsor.request,
        recipeId: configured.recipe.id,
        expectedVersion: 3,
        idempotencyKey: randomUUID(),
        input: configured.input,
      });
      await run(3);
      expect(await counts(a)).toEqual({ proposals: 1, tasks: 1, completed: 1, skipped: 3 });
      expect(await counts(b)).toEqual({ proposals: 1, tasks: 1, completed: 1, skipped: 0 });
      expect(
        (
          await admin.query(
            "SELECT count(*)::integer AS versions FROM cpl_commercial_versions WHERE organization_id=ANY($1::uuid[])",
            [[a.org.id, b.org.id]],
          )
        ).rows[0],
      ).toEqual({ versions: 2 });
    },
  );
  it("never treats a preserved local synthetic MFA flag as production platform assurance", async () => {
    const actor = await operator();
    await admin.query("UPDATE cpl_identities SET issuer=$2,subject=$3 WHERE id=$1", [
      actor.identityId,
      CPL_LOCAL_IDENTITY_ISSUER,
      "legacy-test-" + randomUUID(),
    ]);
    await expect(
      tenants.createEnabledOrganization(actor.token, {
        slug: "legacy-local-" + randomBytes(4).toString("hex"),
        displayName: "Must not be provisioned",
      }),
    ).rejects.toMatchObject({ code: "CPL_PLATFORM_MFA_REQUIRED" });
    const recipient = await login();
    await expect(
      service.provisionOrganization({
        sessionToken: actor.token,
        input: {
          slug: "local-forbidden-" + randomBytes(4).toString("hex"),
          displayName: "Must not be provisioned",
          initialOwnerIdentityId: recipient.identityId,
          enabledModules: [],
          idempotencyKey: randomUUID(),
        },
      }),
    ).rejects.toMatchObject({ code: "CPL_PLATFORM_MFA_REQUIRED" });
    expect(
      (
        await admin.query(
          "SELECT 1 FROM cpl_platform_provision_requests WHERE actor_identity_id=$1",
          [actor.identityId],
        )
      ).rows,
    ).toEqual([]);
  });
  it("paginates invitations by stable scoped cursors with accurate totals", async () => {
    const f = await fixture(),
      other = await fixture();
    for (let n = 0; n < 5; n++) {
      const recipient = await login(`Invitation pagination ${n}`);
      await service.createInvitation({
        ...f.request,
        input: {
          recipientIdentityId: recipient.identityId,
          role: "member",
          idempotencyKey: randomUUID(),
        },
      });
    }
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await service.listInvitations({
        ...f.request,
        query: "Invitation pagination",
        status: "pending",
        limit: 2,
        cursor,
      });
      expect(page.total).toBe(5);
      ids.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    const first = await service.listInvitations({
      ...f.request,
      query: "Invitation pagination",
      status: "pending",
      limit: 2,
    });
    await expect(
      service.listInvitations({
        ...other.request,
        query: "Invitation pagination",
        status: "pending",
        cursor: first.nextCursor,
      }),
    ).rejects.toMatchObject({ code: "CPL_ADMIN_INVALID_CURSOR" });
  });
  async function assignedFixture() {
    const f = await fixture(),
      staff = await join(f, "field-user"),
      other = await join(f, "field-user");
    const intake = new SqlCplWorkflowRepository(web, tenants),
      commercial = new SqlCplCommercialRepository(tenants),
      execution = new SqlCplExecutionRepository(tenants),
      field = new SqlCplFieldRepository(tenants);
    const lead = await intake.createLead({
      ...f.request,
      title: "Fictional assigned service",
      customerName: "Fictional customer",
      contactName: "Fictional contact",
      contactEmail: "f@example.invalid",
      siteName: "Fictional site",
      siteAddress: "123 Fictional Road",
      details: "Confirmed scope",
      requestedService: "Fictional assigned service",
      assignedMemberIdentityId: f.owner.identityId,
      nextAction: "Review",
      notes: "PRIVATE LEAD CANARY",
      evidenceNote: "PRIVATE EVIDENCE CANARY",
      idempotencyKey: randomUUID(),
    });
    await intake.updateLead({
      ...f.request,
      leadId: lead.id,
      expectedVersion: lead.version,
      status: "ready_for_proposal",
    });
    await commercial.saveBranding({
      ...f.request,
      expectedRevision: 0,
      input: { ...defaultCplCommercialBranding(), businessName: "Fictional field service" },
    });
    let proposal = await commercial.createProposal({
      ...f.request,
      leadId: lead.id,
      idempotencyKey: randomUUID(),
    });
    proposal = await commercial.saveProposal({
      ...f.request,
      proposalId: proposal.id,
      expectedRevision: proposal.revision,
      internalNotes: "PRIVATE COMMERCIAL CANARY",
      content: {
        ...proposal.versions[0]!.content,
        lineItems: [
          {
            serviceCode: "FIELD",
            description: "Fictional field service",
            quantity: "1",
            unit: "visit",
            unitPriceMinor: 876543,
          },
        ],
      },
    });
    proposal = await commercial.submitProposal({
      ...f.request,
      proposalId: proposal.id,
      expectedRevision: proposal.revision,
    });
    proposal = await commercial.reviewProposal({
      ...f.request,
      proposalId: proposal.id,
      expectedRevision: proposal.revision,
      decision: "approve",
    });
    proposal = await commercial.recordOutcome({
      ...f.request,
      proposalId: proposal.id,
      expectedRevision: proposal.revision,
      outcome: "awarded",
      award: {
        awardDate: "2026-09-23",
        amountMinor: proposal.versions[0]!.totals.totalMinor,
        currency: "USD",
        purchaseOrder: "PRIVATE PO CANARY",
        startDate: null,
        notes: "PRIVATE AWARD CANARY",
      },
      idempotencyKey: randomUUID(),
    });
    const project = await commercial.createProject({
      ...f.request,
      proposalId: proposal.id,
      idempotencyKey: randomUUID(),
    });
    const input: CplVisitInput = {
      purpose: "Assigned field inspection",
      serviceType: "Fictional field service",
      status: "scheduled",
      timeZone: "America/Indiana/Indianapolis",
      plannedStartLocal: "2026-10-12T09:00",
      plannedEndLocal: "2026-10-12T10:00",
      plannedStartOffsetMinutes: null,
      plannedEndOffsetMinutes: null,
      responsibleIdentityId: staff.identityId,
      siteName: "Fictional site",
      siteAddress: "123 Fictional Road",
      accessInstructions: "Authorized assigned visit access",
      actualStartAt: null,
      actualEndAt: null,
      completionNote: "",
      cancellationReason: "",
      tasks: [],
    };
    const visit = await execution.createVisit({
      ...f.request,
      projectId: project.id,
      input,
      idempotencyKey: randomUUID(),
    });
    const foreignVisit = await execution.createVisit({
      ...f.request,
      projectId: project.id,
      input: {
        ...input,
        purpose: "OTHER STAFF VISIT CANARY",
        responsibleIdentityId: other.identityId,
      },
      idempotencyKey: randomUUID(),
    });
    const t = await field.saveTemplate({
      ...f.request,
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
      input: {
        name: "Assigned pinned template",
        description: "Human entries",
        sections: [
          {
            id: randomUUID(),
            title: "Visit",
            items: [
              {
                id: randomUUID(),
                label: "Observation",
                instructions: "Record",
                type: "text",
                required: false,
                unit: "",
                options: [],
                naReasonRequired: true,
                minimumPhotos: 0,
              },
            ],
          },
        ],
      },
    });
    await field.attachTemplate({
      ...f.request,
      projectId: project.id,
      visitId: visit.id,
      expectedRevision: 0,
      templateId: t.id,
      templateVersion: 1,
      idempotencyKey: randomUUID(),
    });
    await field.saveTemplate({
      ...f.request,
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
      input: { ...t, name: "OTHER TEMPLATE CANARY" },
    });
    return {
      ...f,
      staff,
      other,
      intake,
      commercial,
      execution,
      field,
      project,
      proposal,
      visit,
      foreignVisit,
      template: t,
      staffScope: { ...staff.request, projectId: project.id, visitId: visit.id },
    };
  }
  it("provides usable assigned-only field navigation without commercial or unrelated visit data", async () => {
    const f = await assignedFixture();
    const assigned = await f.execution.readAssignedWork(f.staff.request);
    expect(assigned.items.map((item) => item.visit.id)).toEqual([f.visit.id]);
    expect(assigned.items[0]!.projectId).toBe(f.project.id);
    expect(assigned.permissions.canCompleteAssignedVisits).toBe(true);
    const encoded = JSON.stringify(assigned);
    for (const hidden of ["PRIVATE", "876543", "OTHER STAFF", "award", "snapshot", "purchaseOrder"])
      expect(encoded).not.toContain(hidden);
    const agenda = await f.execution.readAgenda({
      ...f.staff.request,
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-11-01T00:00:00.000Z",
    });
    expect(agenda.items.map((item) => item.visit.id)).toEqual([f.visit.id]);
    expect((await f.execution.getVisit(f.staffScope)).id).toBe(f.visit.id);
    const field = await f.field.getVisitWorkspace(f.staffScope);
    expect(field.templates.map((t) => t.id)).toEqual([f.template.id]);
    expect(JSON.stringify(field)).not.toContain("OTHER TEMPLATE CANARY");
    const progress = await f.execution.saveVisit({
      ...f.staffScope,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      input: { ...f.visit, status: "in_progress", actualStartAt: new Date().toISOString() },
    });
    expect(progress.status).toBe("in_progress");
  });
  it("rejects field-role direct commercial/admin/download and other-assignment bypasses", async () => {
    const f = await assignedFixture(),
      reports = new SqlCplReportRepository(tenants),
      delivery = new SqlCplDeliveryRepository(tenants);
    const denied = [
      () => f.execution.getProjectWorkspace(f.staffScope),
      () => f.execution.getVisit({ ...f.staffScope, visitId: f.foreignVisit.id }),
      () => f.field.getVisitWorkspace({ ...f.staffScope, visitId: f.foreignVisit.id }),
      () =>
        f.field.getPhotoContent({
          ...f.staffScope,
          visitId: f.foreignVisit.id,
          photoId: randomUUID(),
          kind: "original",
        }),
      () => f.field.listTemplates(f.staff.request),
      () => f.intake.readWorkspace(f.staff.request),
      () => f.intake.downloadProposal({ ...f.staff.request, proposalId: randomUUID() }),
      () => f.commercial.getProject(f.staffScope),
      () => f.commercial.getProposal({ ...f.staff.request, proposalId: f.proposal.id }),
      () => reports.getArtifact({ ...f.staffScope, reportId: randomUUID(), version: 1 }),
      () => delivery.workspace(f.staffScope),
      () => service.listMembers(f.staff.request),
    ];
    for (const operation of denied)
      await expect(operation()).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
    await change(f, f.staff.identityId, "field-user", "suspended", 1);
    await expect(f.execution.readAssignedWork(f.staff.request)).rejects.toMatchObject({
      code: "CPL_ACCESS_DENIED",
    });
    await expect(f.field.getVisitWorkspace(f.staffScope)).rejects.toMatchObject({
      code: "CPL_ACCESS_DENIED",
    });
    expect(
      (await f.execution.getVisit({ ...f.request, projectId: f.project.id, visitId: f.visit.id }))
        .responsibleIdentityId,
    ).toBe(f.staff.identityId);
  });
  it("uses configured timezone only for new operations and preserves existing schedule instants", async () => {
    const f = await assignedFixture();
    await tenants.setSetting({
      ...f.request,
      key: "company.profile",
      expectedVersion: 0,
      value: { timeZone: "America/Chicago" },
    });
    const first = await f.execution.getProjectWorkspace({ ...f.request, projectId: f.project.id });
    expect(first.operations.timeZone).toBe("America/Chicago");
    await f.execution.saveProject({
      ...f.request,
      projectId: f.project.id,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
      input: first.operations,
    });
    await tenants.setSetting({
      ...f.request,
      key: "company.profile",
      expectedVersion: 1,
      value: { timeZone: "America/Denver" },
    });
    const retained = await f.execution.getProjectWorkspace({
      ...f.request,
      projectId: f.project.id,
    });
    expect(retained.operations.timeZone).toBe("America/Chicago");
    expect(retained.visits.find((v) => v.id === f.visit.id)?.plannedStartAt).toBe(
      f.visit.plannedStartAt,
    );
    expect(retained.visits.find((v) => v.id === f.visit.id)?.timeZone).toBe(f.visit.timeZone);
    expect(retained.project.snapshot).toEqual(f.project.snapshot);
  });
});
