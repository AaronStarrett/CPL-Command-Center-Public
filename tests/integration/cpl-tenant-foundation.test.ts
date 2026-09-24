import { migrateDatabase, verifyMigrations } from "../../packages/database/src/migrations.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGliteDatabaseAdapter } from "../../packages/database/src/pglite-adapter.js";
import {
  CPL_MODULE_KEYS,
  SqlCplTenantRepository,
  type CplIdentityVerifier,
  type CplTenantRequest,
  type CplNamespaceKind,
  type CplModuleKey,
} from "../../packages/database/src/tenant-repository.js";

const ISSUER = "https://identity.example.invalid";
let database: PGliteDatabaseAdapter;
let repository: SqlCplTenantRepository;
let currentTime = Date.parse("2026-09-21T12:00:00.000Z");
const now = () => new Date(currentTime);
const assertions = new Map<string, Awaited<ReturnType<CplIdentityVerifier["verify"]>>>();
const verifier: CplIdentityVerifier = {
  async verify(assertion) {
    const verified = assertions.get(assertion);
    if (!verified) throw new Error("Invalid synthetic test assertion");
    return verified;
  },
};
async function login(subject: string, mfaVerified = false) {
  const assertion = randomUUID();
  assertions.set(assertion, {
    issuer: ISSUER,
    subject,
    displayName: `Synthetic ${subject}`,
    authenticatedAt: now().toISOString(),
    expiresAt: new Date(currentTime + 60 * 60_000).toISOString(),
    mfaVerified,
  });
  return repository.createSession(assertion);
}
let ownerA: Awaited<ReturnType<typeof login>>;
let ownerB: Awaited<ReturnType<typeof login>>;
let platformAdmin: Awaited<ReturnType<typeof login>>;
let requestA: CplTenantRequest;
let requestB: CplTenantRequest;
async function entitle(request: CplTenantRequest, enabled = true, usageLimit: number | null = 100) {
  await repository.setEntitlement({
    ...request,
    sessionToken: platformAdmin.token,
    module: "proposal-builder",
    enabled,
    usageLimit,
  });
}
async function join(
  request: CplTenantRequest,
  subject: string,
  role: "member" | "admin" | "reviewer" = "member",
) {
  const user = await login(subject);
  const invitation = await repository.invite({ ...request, issuer: ISSUER, subject, role });
  await repository.redeemInvitation({
    organizationId: request.organizationId,
    sessionToken: user.token,
    invitationToken: invitation.token,
  });
  return user;
}

beforeAll(async () => {
  database = new PGliteDatabaseAdapter();
  // Register and apply the complete migration chain without any business or identity seed.
  const migration = await migrateDatabase(database);
  expect(migration.applied.at(-1)).toBe("0039_cpl_durable_inbound.sql");
  expect((await verifyMigrations(database)).current).toBe("0039_cpl_durable_inbound.sql");
  repository = new SqlCplTenantRepository(database, {
    identityVerifier: verifier,
    trustedIssuers: [ISSUER],
    now,
  });
}, 60_000);
afterAll(async () => {
  await database?.close();
});

describe("additive CPL tenant foundation using isolated PGlite preview persistence", () => {
  it("starts with no organizations, identities, sessions, invitations or administrators", async () => {
    for (const table of [
      "cpl_organizations",
      "cpl_identities",
      "cpl_sessions",
      "cpl_invitations",
      "cpl_platform_administrators",
    ]) {
      const result = await database.query<{ count: number }>(
        `SELECT COUNT(*)::integer AS count FROM ${table}`,
      );
      expect(result.rows[0]?.count).toBe(0);
    }
  });
  it("refuses login without an IdP verifier and rejects unverified or expired assertions", async () => {
    await expect(
      new SqlCplTenantRepository(database).createSession("claims-from-browser"),
    ).rejects.toMatchObject({ code: "CPL_IDENTITY_PROVIDER_UNAVAILABLE" });
    await expect(repository.createSession("invented-owner-claims")).rejects.toMatchObject({
      code: "CPL_ACCESS_DENIED",
    });
    assertions.set("expired", {
      issuer: ISSUER,
      subject: "expired",
      displayName: "Expired",
      authenticatedAt: new Date(currentTime - 3_600_000).toISOString(),
      expiresAt: new Date(currentTime - 1).toISOString(),
      mfaVerified: true,
    });
    await expect(repository.createSession("expired")).rejects.toMatchObject({
      code: "CPL_ACCESS_DENIED",
    });
    assertions.set("wrong-issuer", {
      ...assertions.get("expired")!,
      issuer: "https://attacker.example.invalid",
      expiresAt: new Date(currentTime + 60_000).toISOString(),
    });
    await expect(repository.createSession("wrong-issuer")).rejects.toMatchObject({
      code: "CPL_IDENTITY_PROVIDER_UNAVAILABLE",
    });
  });
  it("creates two empty organizations and gives no platform privileges to first signup", async () => {
    ownerA = await login("owner-a", true);
    ownerB = await login("owner-b", true);
    const organizationA = await repository.createOrganization(ownerA.token, {
      slug: "synthetic-a",
      displayName: "Synthetic Organization A",
    });
    const organizationB = await repository.createOrganization(ownerB.token, {
      slug: "synthetic-b",
      displayName: "Synthetic Organization B",
    });
    requestA = { sessionToken: ownerA.token, organizationId: organizationA.id };
    requestB = { sessionToken: ownerB.token, organizationId: organizationB.id };
    expect((await repository.listOrganizations(ownerA.token)).map((item) => item.id)).toEqual([
      organizationA.id,
    ]);
    const entitlements = await repository.listEntitlements(requestA);
    expect(entitlements).toHaveLength(CPL_MODULE_KEYS.length);
    expect(entitlements.every((item) => !item.enabled && item.usageLimit === 0)).toBe(true);
    await expect(repository.authorizePlatformAdministrator(ownerA.token)).rejects.toMatchObject({
      code: "CPL_PLATFORM_ADMIN_REQUIRED",
    });
    expect(
      (
        await database.query<{ count: number }>(
          "SELECT COUNT(*)::integer AS count FROM cpl_platform_administrators",
        )
      ).rows[0]?.count,
    ).toBe(0);
  });
  it.each(["", "unknown-module"])(
    "refuses malformed module selection %j instead of bypassing entitlements",
    async (module) => {
      await expect(
        repository.authorize({
          ...requestA,
          permission: "records:read",
          module: module as CplModuleKey,
        }),
      ).rejects.toMatchObject({ code: "CPL_UNKNOWN_MODULE" });
      await expect(
        repository.namespaceFor({
          ...requestA,
          kind: "exports",
          resourceId: "same-source",
          module: module as CplModuleKey,
        }),
      ).rejects.toMatchObject({ code: "CPL_UNKNOWN_MODULE" });
    },
  );
  it.each([undefined, null])(
    "refuses an absent namespace module %j instead of bypassing entitlements",
    async (module) => {
      await expect(
        repository.namespaceFor({
          ...requestA,
          kind: "exports",
          resourceId: "same-source",
          ...(module === undefined ? {} : { module }),
        } as Parameters<SqlCplTenantRepository["namespaceFor"]>[0]),
      ).rejects.toMatchObject({ code: "CPL_UNKNOWN_MODULE" });
    },
  );
  it("stores hashed session tokens and revokes a session durably", async () => {
    const session = await login("revocable");
    const result = await database.query<{ token_hash: string }>(
      "SELECT token_hash FROM cpl_sessions WHERE identity_id=$1",
      [session.identityId],
    );
    expect(result.rows[0]?.token_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.rows[0]?.token_hash).not.toEqual(session.token);
    await repository.revokeSession(session.token);
    await expect(
      repository.createOrganization(session.token, { slug: "revoked", displayName: "Revoked" }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
  });
  it("keeps settings separate, detects edit conflicts and denies cross-organization reads/writes/exports", async () => {
    expect(
      await repository.setSetting({
        ...requestA,
        key: "company.profile",
        value: { displayName: "Organization A", template: "A" },
        expectedVersion: 0,
      }),
    ).toBe(1);
    expect(
      await repository.setSetting({
        ...requestB,
        key: "company.profile",
        value: { displayName: "Organization B", template: "B" },
        expectedVersion: 0,
      }),
    ).toBe(1);
    expect(await repository.getSetting({ ...requestA, key: "company.profile" })).toEqual({
      value: { displayName: "Organization A", template: "A" },
      version: 1,
    });
    expect(
      await repository.setSetting({
        ...requestA,
        key: "company.profile",
        value: { template: "A2" },
        expectedVersion: 1,
      }),
    ).toBe(2);
    await expect(
      repository.setSetting({
        ...requestA,
        key: "company.profile",
        value: { template: "stale" },
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "CPL_SETTING_CONFLICT" });
    const foreign = { ...requestA, organizationId: requestB.organizationId };
    await expect(repository.getOrganization(foreign)).rejects.toMatchObject({
      code: "CPL_ACCESS_DENIED",
    });
    await expect(
      repository.getSetting({ ...foreign, key: "company.profile" }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
    await expect(
      repository.setSetting({
        ...foreign,
        key: "company.profile",
        value: "malicious edit",
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
    await expect(
      repository.namespaceFor({
        ...foreign,
        kind: "exports",
        resourceId: "same-source",
        module: "proposal-builder",
      }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
    expect((await repository.getSetting({ ...requestB, key: "company.profile" }))?.value).toEqual({
      displayName: "Organization B",
      template: "B",
    });
  });
  it("binds invitation to issuer/subject and tenant, hashes token and redeems only once under concurrency", async () => {
    const invited = await login("invited-user");
    const invitation = await repository.invite({
      ...requestA,
      issuer: ISSUER,
      subject: "invited-user",
      role: "reviewer",
    });
    const stored = await database.query<{ token_hash: string }>(
      "SELECT token_hash FROM cpl_invitations WHERE id=$1",
      [invitation.id],
    );
    expect(stored.rows[0]?.token_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(stored.rows[0]?.token_hash).not.toBe(invitation.token);
    await expect(
      repository.redeemInvitation({ ...requestB, invitationToken: invitation.token }),
    ).rejects.toMatchObject({ code: "CPL_INVITATION_UNAVAILABLE" });
    await expect(
      repository.redeemInvitation({ ...requestA, invitationToken: invitation.token }),
    ).rejects.toMatchObject({ code: "CPL_INVITATION_UNAVAILABLE" });
    const redeem = {
      organizationId: requestA.organizationId,
      sessionToken: invited.token,
      invitationToken: invitation.token,
    };
    const results = await Promise.allSettled([
      repository.redeemInvitation(redeem),
      repository.redeemInvitation(redeem),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);
    await expect(
      repository.authorize({
        ...requestA,
        sessionToken: invited.token,
        permission: "settings:write",
      }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
    expect(
      (
        await repository.authorize({
          ...requestA,
          sessionToken: invited.token,
          permission: "records:read",
        })
      ).role,
    ).toBe("reviewer");
  });
  it("persists distinct synthetic company catalogs and templates with optimistic concurrency", async () => {
    const catalogA = {
      services: [{ key: "synthetic-roof-review", rateMinor: 12000, currency: "USD" }],
    };
    const catalogB = {
      services: [{ key: "synthetic-field-survey", rateMinor: 7500, currency: "USD" }],
    };
    await repository.setSetting({
      ...requestA,
      key: "workflow.service-catalog",
      value: catalogA,
      expectedVersion: 0,
    });
    await repository.setSetting({
      ...requestB,
      key: "workflow.service-catalog",
      value: catalogB,
      expectedVersion: 0,
    });
    await repository.setSetting({
      ...requestA,
      key: "workflow.proposal-template",
      value: { title: "Synthetic A proposal", version: 1 },
      expectedVersion: 0,
    });
    await repository.setSetting({
      ...requestB,
      key: "workflow.proposal-template",
      value: { title: "Synthetic B proposal", version: 1 },
      expectedVersion: 0,
    });
    const freshRepository = new SqlCplTenantRepository(database, { now });
    expect(
      (await freshRepository.getSetting({ ...requestA, key: "workflow.service-catalog" }))?.value,
    ).toEqual(catalogA);
    expect(
      (await freshRepository.getSetting({ ...requestB, key: "workflow.service-catalog" }))?.value,
    ).toEqual(catalogB);
    expect(
      (await freshRepository.getSetting({ ...requestB, key: "workflow.proposal-template" }))?.value,
    ).toEqual({ title: "Synthetic B proposal", version: 1 });
    const updates = await Promise.allSettled(
      ["first", "second"].map((title) =>
        repository.setSetting({
          ...requestA,
          key: "workflow.proposal-template",
          value: { title },
          expectedVersion: 1,
        }),
      ),
    );
    expect(updates.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(updates.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      (await freshRepository.getSetting({ ...requestA, key: "workflow.proposal-template" }))
        ?.version,
    ).toBe(2);
  });
  it("rejects expired/revoked invitations and invitations issued by a revoked administrator", async () => {
    const recipient = await login("expired-recipient");
    const expired = await repository.invite({
      ...requestA,
      issuer: ISSUER,
      subject: "expired-recipient",
      role: "member",
      expiresInMinutes: 1,
    });
    currentTime += 60_001;
    await expect(
      repository.redeemInvitation({
        ...requestA,
        sessionToken: recipient.token,
        invitationToken: expired.token,
      }),
    ).rejects.toMatchObject({ code: "CPL_INVITATION_UNAVAILABLE" });
    const revoked = await repository.invite({
      ...requestA,
      issuer: ISSUER,
      subject: "expired-recipient",
      role: "member",
    });
    await repository.revokeInvitation({ ...requestA, invitationId: revoked.id });
    await expect(
      repository.redeemInvitation({
        ...requestA,
        sessionToken: recipient.token,
        invitationToken: revoked.token,
      }),
    ).rejects.toMatchObject({ code: "CPL_INVITATION_UNAVAILABLE" });
    const admin = await join(requestA, "inviting-admin", "admin");
    const grant = await repository.invite({
      ...requestA,
      sessionToken: admin.token,
      issuer: ISSUER,
      subject: "expired-recipient",
      role: "member",
    });
    await repository.setMembershipStatus({
      ...requestA,
      identityId: admin.identityId,
      status: "removed",
    });
    await expect(
      repository.redeemInvitation({
        ...requestA,
        sessionToken: recipient.token,
        invitationToken: grant.token,
      }),
    ).rejects.toMatchObject({ code: "CPL_INVITATION_UNAVAILABLE" });
  });
  it("rechecks membership on each switch and operation while preserving independent memberships", async () => {
    const member = await join(requestA, "multi-org-user");
    const secondInvite = await repository.invite({
      ...requestB,
      issuer: ISSUER,
      subject: "multi-org-user",
      role: "member",
    });
    await repository.redeemInvitation({
      ...requestB,
      sessionToken: member.token,
      invitationToken: secondInvite.token,
    });
    expect(await repository.listOrganizations(member.token)).toHaveLength(2);
    await repository.setMembershipStatus({
      ...requestA,
      identityId: member.identityId,
      status: "suspended",
    });
    await expect(
      repository.getOrganization({ ...requestA, sessionToken: member.token }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
    expect((await repository.getOrganization({ ...requestB, sessionToken: member.token })).id).toBe(
      requestB.organizationId,
    );
    await expect(
      repository.setMembershipStatus({
        ...requestA,
        identityId: ownerA.identityId,
        status: "removed",
      }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
  });
  it("refuses invitations from a suspended identity even while its membership remains active", async () => {
    const admin = await join(requestA, "suspended-inviter", "admin");
    const recipient = await login("suspended-inviter-recipient");
    const invitation = await repository.invite({
      ...requestA,
      sessionToken: admin.token,
      issuer: ISSUER,
      subject: "suspended-inviter-recipient",
      role: "member",
    });
    await database.query("UPDATE cpl_identities SET status='suspended' WHERE id=$1", [
      admin.identityId,
    ]);
    await expect(
      repository.redeemInvitation({
        ...requestA,
        sessionToken: recipient.token,
        invitationToken: invitation.token,
      }),
    ).rejects.toMatchObject({ code: "CPL_INVITATION_UNAVAILABLE" });
  });
  it("requires explicitly provisioned platform admin plus recent MFA for entitlement changes", async () => {
    await expect(
      repository.setEntitlement({
        ...requestA,
        module: "proposal-builder",
        enabled: true,
        usageLimit: 100,
      }),
    ).rejects.toMatchObject({ code: "CPL_PLATFORM_ADMIN_REQUIRED" });
    platformAdmin = await login("platform-admin", true);
    // Isolated test fixture simulates a separate explicit operator provisioning step.
    await database.query(
      "INSERT INTO cpl_platform_administrators (identity_id,status) VALUES ($1,'active')",
      [platformAdmin.identityId],
    );
    const noMfa = await login("platform-admin", false);
    await expect(repository.authorizePlatformAdministrator(noMfa.token)).rejects.toMatchObject({
      code: "CPL_PLATFORM_MFA_REQUIRED",
    });
    await entitle(requestA);
    await entitle(requestB);
    expect(
      (
        await repository.authorize({
          ...requestA,
          permission: "jobs:run",
          module: "proposal-builder",
        })
      ).organizationId,
    ).toBe(requestA.organizationId);
    await entitle(requestA, true, 0);
    await expect(
      repository.authorize({ ...requestA, permission: "jobs:run", module: "proposal-builder" }),
    ).rejects.toMatchObject({ code: "CPL_ALLOWANCE_EXHAUSTED" });
    await entitle(requestA, false);
    await expect(
      repository.authorize({ ...requestA, permission: "jobs:run", module: "proposal-builder" }),
    ).rejects.toMatchObject({ code: "CPL_MODULE_DISABLED" });
    await entitle(requestA);
  });
  it("derives disjoint file/vector/cache/job/export/credential namespaces from verified membership", async () => {
    for (const kind of [
      "objects",
      "vectors",
      "cache",
      "jobs",
      "exports",
      "credentials",
    ] as const satisfies readonly CplNamespaceKind[]) {
      const a = await repository.namespaceFor({
        ...requestA,
        kind,
        resourceId: "../../same-untrusted-source",
        module: "proposal-builder",
      });
      const b = await repository.namespaceFor({
        ...requestB,
        kind,
        resourceId: "../../same-untrusted-source",
        module: "proposal-builder",
      });
      expect(a).not.toBe(b);
      expect(a).toMatch(
        new RegExp(`^organizations/${requestA.organizationId}/${kind}/[a-f0-9]{64}$`, "u"),
      );
      expect(a).not.toContain("..");
    }
  });
  it("revalidates worker grants, rejects cross-tenant/module jobs and honors revocation and limits", async () => {
    const grant = await repository.issueServiceGrant({ ...requestA, module: "proposal-builder" });
    expect(
      (
        await repository.authorizeService({
          token: grant.token,
          organizationId: requestA.organizationId,
          module: "proposal-builder",
        })
      ).organizationId,
    ).toBe(requestA.organizationId);
    await expect(
      repository.authorizeService({
        token: grant.token,
        organizationId: requestB.organizationId,
        module: "proposal-builder",
      }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
    await expect(
      repository.authorizeService({
        token: grant.token,
        organizationId: requestA.organizationId,
        module: "ai-receptionist",
      }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
    await entitle(requestA, false);
    await expect(
      repository.authorizeService({
        token: grant.token,
        organizationId: requestA.organizationId,
        module: "proposal-builder",
      }),
    ).rejects.toMatchObject({ code: "CPL_MODULE_DISABLED" });
    await entitle(requestA);
    await repository.revokeServiceGrant({ ...requestA, grantId: grant.id });
    await expect(
      repository.authorizeService({
        token: grant.token,
        organizationId: requestA.organizationId,
        module: "proposal-builder",
      }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
    const admin = await join(requestA, "worker-admin", "admin");
    const tied = await repository.issueServiceGrant({
      ...requestA,
      sessionToken: admin.token,
      module: "proposal-builder",
    });
    await repository.setMembershipStatus({
      ...requestA,
      identityId: admin.identityId,
      status: "removed",
    });
    await expect(
      repository.authorizeService({
        token: tied.token,
        organizationId: requestA.organizationId,
        module: "proposal-builder",
      }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
    await repository.setMembershipStatus({
      ...requestA,
      identityId: admin.identityId,
      status: "active",
    });
    // Restoring membership must not revive old worker capabilities.
    await expect(
      repository.authorizeService({
        token: tied.token,
        organizationId: requestA.organizationId,
        module: "proposal-builder",
      }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
    const renewed = await repository.issueServiceGrant({
      ...requestA,
      sessionToken: admin.token,
      module: "proposal-builder",
      expiresInMinutes: 1,
    });
    currentTime += 60_001;
    await expect(
      repository.authorizeService({
        token: renewed.token,
        organizationId: requestA.organizationId,
        module: "proposal-builder",
      }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
  });
  it("enforces composite tenant membership references even on privileged service writes", async () => {
    await expect(
      database.query(
        "INSERT INTO cpl_organization_settings (organization_id,setting_key,value_json,updated_by_identity_id) VALUES ($1,'company.invalid','{}'::jsonb,$2)",
        [requestA.organizationId, ownerB.identityId],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      database.query(
        "INSERT INTO cpl_service_grants (id,organization_id,module_key,token_hash,issued_by_identity_id,issued_membership_version,expires_at) VALUES ($1,$2,'proposal-builder','invalid-cross-tenant-reference',$3,1,$4)",
        [
          randomUUID(),
          requestA.organizationId,
          ownerB.identityId,
          new Date(currentTime + 60_000).toISOString(),
        ],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
  it("forces database row isolation under a non-bypass role and clears transaction-local context", async () => {
    await database.execute(
      "CREATE ROLE cpl_rls_test NOLOGIN NOSUPERUSER NOBYPASSRLS; GRANT USAGE ON SCHEMA public TO cpl_rls_test; GRANT SELECT, INSERT, UPDATE ON cpl_organizations,cpl_memberships,cpl_module_entitlements,cpl_organization_settings,cpl_invitations,cpl_service_grants,cpl_tenant_audit_events,cpl_platform_audit_events TO cpl_rls_test;",
    );
    await database.transaction(async (executor) => {
      await executor.execute("SET LOCAL ROLE cpl_rls_test");
      expect((await executor.query("SELECT * FROM cpl_organization_settings")).rows).toHaveLength(
        0,
      );
      await executor.query("SELECT set_config('cpl.organization_id',$1,true)", [
        requestA.organizationId,
      ]);
      const visible = await executor.query<{ organization_id: string }>(
        "SELECT organization_id FROM cpl_organization_settings",
      );
      expect(visible.rows.length).toBeGreaterThan(0);
      expect(visible.rows.every((row) => row.organization_id === requestA.organizationId)).toBe(
        true,
      );
      expect(
        (
          await executor.query("SELECT * FROM cpl_organization_settings WHERE organization_id=$1", [
            requestB.organizationId,
          ])
        ).rows,
      ).toHaveLength(0);
      const audit = await executor.query<{ organization_id: string }>(
        "SELECT organization_id FROM cpl_platform_audit_events",
      );
      expect(audit.rows.length).toBeGreaterThan(0);
      expect(audit.rows.every((row) => row.organization_id === requestA.organizationId)).toBe(true);
      expect(
        (
          await executor.query(
            "UPDATE cpl_organization_settings SET value_json='\"attack\"'::jsonb WHERE organization_id=$1 RETURNING *",
            [requestB.organizationId],
          )
        ).rowCount,
      ).toBe(0);
    });
    await expect(
      database.transaction(async (executor) => {
        await executor.execute("SET LOCAL ROLE cpl_rls_test");
        await executor.query("SELECT set_config('cpl.organization_id',$1,true)", [
          requestA.organizationId,
        ]);
        await executor.query(
          "INSERT INTO cpl_organization_settings (organization_id,setting_key,value_json,updated_by_identity_id) VALUES ($1,'company.attack','{}'::jsonb,$2)",
          [requestB.organizationId, ownerB.identityId],
        );
      }),
    ).rejects.toMatchObject({ code: "42501" });
    await database.transaction(async (executor) => {
      await executor.execute("SET LOCAL ROLE cpl_rls_test");
      expect((await executor.query("SELECT * FROM cpl_organization_settings")).rows).toHaveLength(
        0,
      );
    });
    const flags = await database.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('cpl_organizations','cpl_memberships','cpl_module_entitlements','cpl_organization_settings','cpl_invitations','cpl_service_grants','cpl_tenant_audit_events','cpl_platform_audit_events')",
    );
    expect(flags.rows).toHaveLength(8);
    expect(flags.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  });
  it("invalidates all user sessions and refuses stale platform MFA", async () => {
    const first = await login("revoke-all");
    const second = await login("revoke-all");
    await repository.revokeAllSessions(first.token);
    await expect(repository.listOrganizations(first.token)).rejects.toMatchObject({
      code: "CPL_ACCESS_DENIED",
    });
    await expect(repository.listOrganizations(second.token)).rejects.toMatchObject({
      code: "CPL_ACCESS_DENIED",
    });
    currentTime += 16 * 60_000;
    await expect(
      repository.authorizePlatformAdministrator(platformAdmin.token),
    ).rejects.toMatchObject({ code: "CPL_PLATFORM_MFA_REQUIRED" });
  });
});
