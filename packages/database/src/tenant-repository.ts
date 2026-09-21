import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseAdapter, SqlExecutor } from "./adapter.js";

export const CPL_MODULE_KEYS = [
  "intake-job-tracker",
  "field-report-assembler",
  "proposal-builder",
  "invoice-ready-closeout",
  "scope-change-detector",
  "missing-information-coordinator",
  "award-to-project-launcher",
  "pre-visit-readiness",
  "recurring-service",
  "ai-receptionist",
] as const;
export type CplModuleKey = (typeof CPL_MODULE_KEYS)[number];
export const CPL_TENANT_ROLES = [
  "owner",
  "admin",
  "manager",
  "reviewer",
  "member",
  "field-user",
] as const;
export type CplTenantRole = (typeof CPL_TENANT_ROLES)[number];
export type CplTenantPermission =
  | "records:read"
  | "records:write"
  | "settings:read"
  | "settings:write"
  | "members:manage"
  | "jobs:run";
export type CplNamespaceKind = "objects" | "vectors" | "cache" | "jobs" | "exports" | "credentials";
type Row = Record<string, unknown>;

/** Implement only with a supported IdP SDK validating signature, issuer, audience,
 * expiry, nonce and authentication context. No default or browser-claims adapter exists. */
export interface CplIdentityVerifier {
  verify(assertion: string): Promise<{
    readonly issuer: string;
    readonly subject: string;
    readonly displayName: string;
    readonly authenticatedAt: string;
    readonly expiresAt: string;
    readonly mfaVerified: boolean;
  }>;
}
export interface CplTenantRepositoryOptions {
  readonly identityVerifier?: CplIdentityVerifier;
  readonly trustedIssuers?: readonly string[];
  readonly now?: () => Date;
}
export interface CplTenantAccess {
  readonly organizationId: string;
  readonly identityId: string;
  readonly role: CplTenantRole;
  readonly membershipVersion: number;
}
export interface CplTenantRequest {
  readonly sessionToken: string;
  readonly organizationId: string;
}
export interface CplOrganization {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly status: string;
}
export class CplTenantAccessError extends Error {
  constructor(readonly code: string = "CPL_ACCESS_DENIED") {
    super(code);
    this.name = "CplTenantAccessError";
  }
}
const administratorRoles: readonly CplTenantRole[] = ["owner", "admin"];
const permissionRoles: Readonly<Record<CplTenantPermission, readonly CplTenantRole[]>> = {
  "records:read": CPL_TENANT_ROLES,
  "records:write": ["owner", "admin", "manager", "member", "field-user"],
  "settings:read": CPL_TENANT_ROLES,
  "settings:write": administratorRoles,
  "members:manage": administratorRoles,
  "jobs:run": ["owner", "admin", "manager"],
};
const namespaceKinds: readonly string[] = [
  "objects",
  "vectors",
  "cache",
  "jobs",
  "exports",
  "credentials",
];
function fail(code = "CPL_ACCESS_DENIED"): never {
  throw new CplTenantAccessError(code);
}
function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value))
    fail();
  return value.toLowerCase();
}
function text(value: string, maximum = 240): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum ||
    /[\u0000-\u001f]/u.test(value)
  )
    fail("CPL_INVALID_INPUT");
  return value.trim();
}
function tokenHash(token: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) fail();
  return createHash("sha256").update(token).digest("hex");
}
function issueToken() {
  return randomBytes(32).toString("base64url");
}
function moduleKey(value: string): CplModuleKey {
  if (!(CPL_MODULE_KEYS as readonly string[]).includes(value)) fail("CPL_UNKNOWN_MODULE");
  return value as CplModuleKey;
}
function instant(value: unknown): number {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(parsed)) fail();
  return parsed;
}
function expires(now: Date, minutes: number, maximum: number): string {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > maximum) fail("CPL_INVALID_EXPIRY");
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}
function organization(row: Row): CplOrganization {
  return {
    id: String(row.id),
    slug: String(row.slug),
    displayName: String(row.display_name),
    status: String(row.status),
  };
}

/** Persistence and authorization for the additive CPL control plane only.
 * Legacy BEA business repositories must not be exposed through this API until
 * their records, files, jobs and queries have been migrated to tenant isolation. */
export class SqlCplTenantRepository {
  private readonly now: () => Date;
  constructor(
    private readonly database: DatabaseAdapter,
    private readonly options: CplTenantRepositoryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }
  private async scope(
    executor: SqlExecutor,
    organizationId: string,
    identityId?: string,
  ): Promise<void> {
    await executor.query(
      "SELECT set_config('cpl.organization_id',$1,true), set_config('cpl.identity_id',$2,true)",
      [uuid(organizationId), identityId ?? ""],
    );
  }
  private issuer(value: string): string {
    const issuer = text(value, 2_000);
    if (!issuer.startsWith("https://") || !this.options.trustedIssuers?.includes(issuer))
      fail("CPL_IDENTITY_PROVIDER_UNAVAILABLE");
    return issuer;
  }
  async createSession(
    assertion: string,
  ): Promise<{ readonly token: string; readonly identityId: string; readonly expiresAt: string }> {
    if (!this.options.identityVerifier || !this.options.trustedIssuers?.length)
      fail("CPL_IDENTITY_PROVIDER_UNAVAILABLE");
    if (typeof assertion !== "string" || assertion.length < 1 || assertion.length > 16_384) fail();
    let claims: Awaited<ReturnType<CplIdentityVerifier["verify"]>>;
    try {
      claims = await this.options.identityVerifier.verify(assertion);
    } catch {
      fail();
    }
    const issuer = this.issuer(claims.issuer);
    const subject = text(claims.subject, 1_000);
    const now = this.now();
    const authenticatedAt = instant(claims.authenticatedAt);
    const identityExpires = instant(claims.expiresAt);
    if (
      authenticatedAt > now.getTime() + 30_000 ||
      identityExpires <= now.getTime() ||
      identityExpires <= authenticatedAt ||
      typeof claims.mfaVerified !== "boolean"
    )
      fail();
    const expiresAt = new Date(
      Math.min(identityExpires, now.getTime() + 60 * 60_000),
    ).toISOString();
    const token = issueToken();
    return this.database.transaction(async (executor) => {
      const result = await executor.query<Row>(
        `INSERT INTO cpl_identities (id,issuer,subject,display_name) VALUES ($1,$2,$3,$4)
         ON CONFLICT (issuer,subject) DO UPDATE SET display_name=EXCLUDED.display_name RETURNING id,status`,
        [randomUUID(), issuer, subject, text(claims.displayName)],
      );
      const identity = result.rows[0];
      if (!identity || identity.status !== "active") fail();
      const identityId = String(identity.id);
      await executor.query(
        `INSERT INTO cpl_sessions (id,identity_id,token_hash,authenticated_at,mfa_verified,expires_at,mfa_verified_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          randomUUID(),
          identityId,
          tokenHash(token),
          new Date(authenticatedAt).toISOString(),
          claims.mfaVerified,
          expiresAt,
          claims.mfaVerified ? new Date(authenticatedAt).toISOString() : null,
        ],
      );
      return { token, identityId, expiresAt };
    });
  }
  private async session(executor: SqlExecutor, token: string): Promise<Row> {
    const result = await executor.query<Row>(
      `SELECT s.id AS session_id,s.identity_id,s.expires_at,s.revoked_at,s.mfa_verified,s.authenticated_at,s.mfa_verified_at,
              i.issuer,i.subject,i.status AS identity_status
       FROM cpl_sessions s JOIN cpl_identities i ON i.id=s.identity_id WHERE s.token_hash=$1 FOR SHARE OF s,i`,
      [tokenHash(token)],
    );
    const found = result.rows[0];
    if (
      !found ||
      found.revoked_at !== null ||
      found.identity_status !== "active" ||
      instant(found.expires_at) <= this.now().getTime()
    )
      fail();
    return found;
  }
  async revokeSession(token: string): Promise<void> {
    await this.database.query(
      "UPDATE cpl_sessions SET revoked_at=$2 WHERE token_hash=$1 AND revoked_at IS NULL",
      [tokenHash(token), this.now().toISOString()],
    );
  }
  async revokeAllSessions(token: string): Promise<void> {
    await this.database.transaction(async (executor) => {
      const session = await this.session(executor, token);
      await executor.query(
        "UPDATE cpl_sessions SET revoked_at=$2 WHERE identity_id=$1 AND revoked_at IS NULL",
        [session.identity_id, this.now().toISOString()],
      );
    });
  }
  private async member(
    executor: SqlExecutor,
    organizationId: string,
    identityId: string,
    permission: CplTenantPermission,
    requestedModule?: CplModuleKey,
  ): Promise<CplTenantAccess> {
    await this.scope(executor, organizationId, identityId);
    const result = await executor.query<Row>(
      `SELECT m.role,m.version FROM cpl_memberships m JOIN cpl_organizations o ON o.id=m.organization_id
       JOIN cpl_identities u ON u.id=m.identity_id
       WHERE m.organization_id=$1 AND m.identity_id=$2 AND m.status='active' AND o.status='active' AND u.status='active' FOR SHARE OF m,o,u`,
      [organizationId, identityId],
    );
    const found = result.rows[0];
    const role = found?.role as CplTenantRole | undefined;
    if (!found || !role || !permissionRoles[permission]?.includes(role)) fail();
    if (requestedModule !== undefined)
      await this.entitled(executor, organizationId, requestedModule);
    return Object.freeze({
      organizationId,
      identityId,
      role,
      membershipVersion: Number(found.version),
    });
  }
  private async entitled(
    executor: SqlExecutor,
    organizationId: string,
    key: CplModuleKey,
  ): Promise<void> {
    const result = await executor.query<Row>(
      "SELECT enabled,usage_limit FROM cpl_module_entitlements WHERE organization_id=$1 AND module_key=$2 FOR SHARE",
      [organizationId, moduleKey(key)],
    );
    if (result.rows[0]?.enabled !== true) fail("CPL_MODULE_DISABLED");
    if (result.rows[0].usage_limit === 0) fail("CPL_ALLOWANCE_EXHAUSTED");
  }
  private async authenticated<T>(
    request: CplTenantRequest,
    permission: CplTenantPermission,
    operation: (executor: SqlExecutor, access: CplTenantAccess) => Promise<T>,
    requestedModule?: CplModuleKey,
  ): Promise<T> {
    const organizationId = uuid(request.organizationId);
    return this.database.transaction(async (executor) => {
      const session = await this.session(executor, request.sessionToken);
      const access = await this.member(
        executor,
        organizationId,
        String(session.identity_id),
        permission,
        requestedModule,
      );
      return operation(executor, access);
    });
  }
  async authorize(
    request: CplTenantRequest & {
      readonly permission: CplTenantPermission;
      readonly module?: CplModuleKey;
    },
  ): Promise<CplTenantAccess> {
    return this.authenticated(
      request,
      request.permission,
      async (_executor, access) => access,
      request.module,
    );
  }
  /** Trusted server repository composition only. Authorization and tenant scope
   * stay in the same transaction as the supplied database operation. */
  async withTenantTransaction<T>(
    request: CplTenantRequest,
    permission: CplTenantPermission,
    module: CplModuleKey,
    operation: (executor: SqlExecutor, access: CplTenantAccess) => Promise<T>,
  ): Promise<T> {
    return this.authenticated(request, permission, operation, moduleKey(module));
  }
  private async audit(
    executor: SqlExecutor,
    access: CplTenantAccess,
    action: string,
    resourceId: string,
  ): Promise<void> {
    await executor.query(
      "INSERT INTO cpl_tenant_audit_events (id,organization_id,actor_identity_id,action,resource_id) VALUES ($1,$2,$3,$4,$5)",
      [randomUUID(), access.organizationId, access.identityId, action, resourceId],
    );
  }
  async createOrganization(
    sessionToken: string,
    input: { readonly slug: string; readonly displayName: string },
  ): Promise<CplOrganization> {
    if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u.test(input.slug))
      fail("CPL_INVALID_ORGANIZATION_SLUG");
    return this.database.transaction(async (executor) => {
      const session = await this.session(executor, sessionToken);
      const identityId = String(session.identity_id);
      const id = randomUUID();
      await this.scope(executor, id, identityId);
      const inserted = await executor.query<Row>(
        "INSERT INTO cpl_organizations (id,slug,display_name) VALUES ($1,$2,$3) RETURNING *",
        [id, input.slug, text(input.displayName)],
      );
      await executor.query(
        "INSERT INTO cpl_memberships (organization_id,identity_id,role) VALUES ($1,$2,'owner')",
        [id, identityId],
      );
      for (const key of CPL_MODULE_KEYS)
        await executor.query(
          "INSERT INTO cpl_module_entitlements (organization_id,module_key,enabled,usage_limit) VALUES ($1,$2,FALSE,0)",
          [id, key],
        );
      await this.audit(
        executor,
        { organizationId: id, identityId, role: "owner", membershipVersion: 1 },
        "organization.created",
        id,
      );
      return organization(inserted.rows[0]!);
    });
  }
  async listOrganizations(sessionToken: string): Promise<readonly CplOrganization[]> {
    return this.database.transaction(async (executor) => {
      const session = await this.session(executor, sessionToken);
      await executor.query(
        "SELECT set_config('cpl.organization_id','',true),set_config('cpl.identity_id',$1,true)",
        [session.identity_id],
      );
      const memberships = await executor.query<Row>(
        "SELECT organization_id FROM cpl_memberships WHERE identity_id=$1 AND status='active' ORDER BY organization_id",
        [session.identity_id],
      );
      const organizations: CplOrganization[] = [];
      for (const row of memberships.rows) {
        await this.scope(executor, String(row.organization_id), String(session.identity_id));
        const result = await executor.query<Row>(
          "SELECT * FROM cpl_organizations WHERE id=$1 AND status='active'",
          [row.organization_id],
        );
        if (result.rows[0]) organizations.push(organization(result.rows[0]));
      }
      return organizations;
    });
  }
  /** Initial production slice: an explicitly provisioned owner with recent real
   * MFA creates an empty organization and enables only the two released modules. */
  async createEnabledOrganization(
    sessionToken: string,
    input: { readonly slug: string; readonly displayName: string },
  ): Promise<CplOrganization> {
    if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u.test(input.slug))
      fail("CPL_INVALID_ORGANIZATION_SLUG");
    return this.database.transaction(async (executor) => {
      const session = await this.platformAdministrator(executor, sessionToken);
      const identityId = String(session.identity_id);
      const id = randomUUID();
      await this.scope(executor, id, identityId);
      const inserted = await executor.query<Row>(
        "INSERT INTO cpl_organizations (id,slug,display_name) VALUES ($1,$2,$3) RETURNING *",
        [id, input.slug, text(input.displayName)],
      );
      await executor.query(
        "INSERT INTO cpl_memberships (organization_id,identity_id,role) VALUES ($1,$2,'owner')",
        [id, identityId],
      );
      for (const key of CPL_MODULE_KEYS) {
        const enabled = key === "intake-job-tracker" || key === "proposal-builder";
        await executor.query(
          "INSERT INTO cpl_module_entitlements (organization_id,module_key,enabled,usage_limit) VALUES ($1,$2,$3,$4)",
          [id, key, enabled, enabled ? null : 0],
        );
      }
      await this.audit(
        executor,
        { organizationId: id, identityId, role: "owner", membershipVersion: 1 },
        "organization.hosted-created",
        id,
      );
      await executor.query(
        "INSERT INTO cpl_platform_audit_events (id,actor_identity_id,organization_id,action,resource_id) VALUES ($1,$2,$3,'hosted-modules.enabled',$4)",
        [randomUUID(), identityId, id, id],
      );
      return organization(inserted.rows[0]!);
    });
  }
  async getOrganization(request: CplTenantRequest): Promise<CplOrganization> {
    return this.authenticated(request, "settings:read", async (executor) => {
      const result = await executor.query<Row>("SELECT * FROM cpl_organizations WHERE id=$1", [
        request.organizationId,
      ]);
      return organization(result.rows[0]!);
    });
  }
  async listEntitlements(
    request: CplTenantRequest,
  ): Promise<readonly { moduleKey: CplModuleKey; enabled: boolean; usageLimit: number | null }[]> {
    return this.authenticated(request, "settings:read", async (executor) => {
      const result = await executor.query<Row>(
        "SELECT module_key,enabled,usage_limit FROM cpl_module_entitlements WHERE organization_id=$1 ORDER BY module_key",
        [request.organizationId],
      );
      return result.rows.map((row) => ({
        moduleKey: moduleKey(String(row.module_key)),
        enabled: row.enabled === true,
        usageLimit: row.usage_limit === null ? null : Number(row.usage_limit),
      }));
    });
  }
  private async platformAdministrator(executor: SqlExecutor, sessionToken: string): Promise<Row> {
    const session = await this.session(executor, sessionToken);
    if (
      session.mfa_verified !== true ||
      session.mfa_verified_at == null ||
      this.now().getTime() - instant(session.mfa_verified_at) > 15 * 60_000 ||
      instant(session.mfa_verified_at) > this.now().getTime() + 30_000
    )
      fail("CPL_PLATFORM_MFA_REQUIRED");
    const result = await executor.query<Row>(
      "SELECT identity_id FROM cpl_platform_administrators WHERE identity_id=$1 AND status='active' FOR SHARE",
      [session.identity_id],
    );
    if (!result.rows[0]) fail("CPL_PLATFORM_ADMIN_REQUIRED");
    return session;
  }
  async authorizePlatformAdministrator(
    sessionToken: string,
  ): Promise<{ readonly identityId: string }> {
    return this.database.transaction(async (executor) => ({
      identityId: String((await this.platformAdministrator(executor, sessionToken)).identity_id),
    }));
  }
  async setEntitlement(
    request: CplTenantRequest & {
      readonly module: CplModuleKey;
      readonly enabled: boolean;
      readonly usageLimit: number | null;
    },
  ): Promise<void> {
    const organizationId = uuid(request.organizationId);
    const key = moduleKey(request.module);
    if (
      typeof request.enabled !== "boolean" ||
      (request.usageLimit !== null &&
        (!Number.isSafeInteger(request.usageLimit) ||
          request.usageLimit < 0 ||
          request.usageLimit > 2_147_483_647))
    )
      fail("CPL_INVALID_ENTITLEMENT");
    await this.database.transaction(async (executor) => {
      const session = await this.platformAdministrator(executor, request.sessionToken);
      await this.scope(executor, organizationId, String(session.identity_id));
      const updated = await executor.query<Row>(
        "UPDATE cpl_module_entitlements SET enabled=$3,usage_limit=$4,version=version+1 WHERE organization_id=$1 AND module_key=$2 RETURNING organization_id",
        [organizationId, key, request.enabled, request.usageLimit],
      );
      if (!updated.rows[0]) fail();
      await executor.query(
        "INSERT INTO cpl_platform_audit_events (id,actor_identity_id,organization_id,action,resource_id) VALUES ($1,$2,$3,'entitlement.updated',$4)",
        [randomUUID(), session.identity_id, organizationId, key],
      );
    });
  }
  async setSetting(
    request: CplTenantRequest & {
      readonly key: string;
      readonly value: unknown;
      readonly expectedVersion: number;
    },
  ): Promise<number> {
    const key = text(request.key, 120);
    if (
      !/^(company|workflow|retention)\.[a-z][a-z0-9.-]{0,100}$/u.test(key) ||
      /secret|password|token|credential/iu.test(key)
    )
      fail("CPL_INVALID_SETTING");
    let encoded: string | undefined;
    try {
      encoded = JSON.stringify(request.value);
    } catch {
      fail("CPL_INVALID_SETTING");
    }
    if (
      !encoded ||
      encoded.length > 64_000 ||
      !Number.isInteger(request.expectedVersion) ||
      request.expectedVersion < 0
    )
      fail("CPL_INVALID_SETTING");
    return this.authenticated(request, "settings:write", async (executor, access) => {
      const result = await executor.query<Row>(
        `INSERT INTO cpl_organization_settings (organization_id,setting_key,value_json,version,updated_by_identity_id)
         SELECT $1,$2,$3::jsonb,1,$4 WHERE $5=0
         ON CONFLICT (organization_id,setting_key) DO UPDATE SET value_json=EXCLUDED.value_json,version=cpl_organization_settings.version+1,updated_by_identity_id=EXCLUDED.updated_by_identity_id,updated_at=CURRENT_TIMESTAMP
         WHERE cpl_organization_settings.version=$5 RETURNING version`,
        [access.organizationId, key, encoded, access.identityId, request.expectedVersion],
      );
      // Existing rows require an UPDATE because INSERT ... SELECT is empty for expectedVersion > 0.
      const version =
        result.rows[0]?.version ??
        (request.expectedVersion > 0
          ? (
              await executor.query<Row>(
                "UPDATE cpl_organization_settings SET value_json=$3::jsonb,version=version+1,updated_by_identity_id=$4,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND setting_key=$2 AND version=$5 RETURNING version",
                [access.organizationId, key, encoded, access.identityId, request.expectedVersion],
              )
            ).rows[0]?.version
          : undefined);
      if (version === undefined) fail("CPL_SETTING_CONFLICT");
      await this.audit(executor, access, "setting.updated", key);
      return Number(version);
    });
  }
  async getSetting(
    request: CplTenantRequest & { readonly key: string },
  ): Promise<{ readonly value: unknown; readonly version: number } | null> {
    return this.authenticated(request, "settings:read", async (executor) => {
      const result = await executor.query<Row>(
        "SELECT value_json,version FROM cpl_organization_settings WHERE organization_id=$1 AND setting_key=$2",
        [request.organizationId, text(request.key, 120)],
      );
      return result.rows[0]
        ? { value: result.rows[0].value_json, version: Number(result.rows[0].version) }
        : null;
    });
  }
  async invite(
    request: CplTenantRequest & {
      readonly issuer: string;
      readonly subject: string;
      readonly role: Exclude<CplTenantRole, "owner">;
      readonly expiresInMinutes?: number;
    },
  ): Promise<{ readonly id: string; readonly token: string; readonly expiresAt: string }> {
    const issuer = this.issuer(request.issuer);
    const subject = text(request.subject, 1_000);
    if (!CPL_TENANT_ROLES.includes(request.role) || (request.role as string) === "owner")
      fail("CPL_INVALID_INVITATION_ROLE");
    const token = issueToken();
    const expiresAt = expires(this.now(), request.expiresInMinutes ?? 1_440, 10_080);
    return this.authenticated(request, "members:manage", async (executor, access) => {
      if (request.role === "admin" && access.role !== "owner") fail();
      const id = randomUUID();
      await executor.query(
        "INSERT INTO cpl_invitations (id,organization_id,token_hash,recipient_issuer,recipient_subject,role,invited_by_identity_id,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          id,
          access.organizationId,
          tokenHash(token),
          issuer,
          subject,
          request.role,
          access.identityId,
          expiresAt,
        ],
      );
      await this.audit(executor, access, "invitation.created", id);
      return { id, token, expiresAt };
    });
  }
  async redeemInvitation(
    request: CplTenantRequest & { readonly invitationToken: string },
  ): Promise<CplTenantAccess> {
    const organizationId = uuid(request.organizationId);
    return this.database.transaction(async (executor) => {
      const session = await this.session(executor, request.sessionToken);
      const identityId = String(session.identity_id);
      await this.scope(executor, organizationId, identityId);
      const result = await executor.query<Row>(
        `SELECT i.*,o.status AS organization_status,m.status AS inviter_status,m.role AS inviter_role,u.status AS inviter_identity_status
         FROM cpl_invitations i JOIN cpl_organizations o ON o.id=i.organization_id
         JOIN cpl_memberships m ON m.organization_id=i.organization_id AND m.identity_id=i.invited_by_identity_id
         JOIN cpl_identities u ON u.id=m.identity_id
         WHERE i.organization_id=$1 AND i.token_hash=$2 FOR UPDATE OF i FOR SHARE OF o,m,u`,
        [organizationId, tokenHash(request.invitationToken)],
      );
      const invitation = result.rows[0];
      if (
        !invitation ||
        invitation.redeemed_at !== null ||
        invitation.revoked_at !== null ||
        invitation.organization_status !== "active" ||
        invitation.inviter_status !== "active" ||
        invitation.inviter_identity_status !== "active" ||
        !administratorRoles.includes(invitation.inviter_role as CplTenantRole) ||
        (invitation.role === "admin" && invitation.inviter_role !== "owner") ||
        instant(invitation.expires_at) <= this.now().getTime() ||
        invitation.recipient_issuer !== session.issuer ||
        invitation.recipient_subject !== session.subject
      )
        fail("CPL_INVITATION_UNAVAILABLE");
      const inserted = await executor.query<Row>(
        `INSERT INTO cpl_memberships (organization_id,identity_id,role) VALUES ($1,$2,$3)
         ON CONFLICT (organization_id,identity_id) DO UPDATE SET role=EXCLUDED.role,status='active',version=cpl_memberships.version+1
         WHERE cpl_memberships.status='removed' AND cpl_memberships.role <> 'owner' RETURNING version`,
        [organizationId, identityId, invitation.role],
      );
      if (!inserted.rows[0]) fail("CPL_INVITATION_UNAVAILABLE");
      await executor.query("UPDATE cpl_invitations SET redeemed_at=$2 WHERE id=$1", [
        invitation.id,
        this.now().toISOString(),
      ]);
      const access = {
        organizationId,
        identityId,
        role: invitation.role as CplTenantRole,
        membershipVersion: Number(inserted.rows[0].version),
      };
      await this.audit(executor, access, "invitation.redeemed", String(invitation.id));
      return Object.freeze(access);
    });
  }
  async revokeInvitation(
    request: CplTenantRequest & { readonly invitationId: string },
  ): Promise<void> {
    await this.authenticated(request, "members:manage", async (executor, access) => {
      const result = await executor.query<Row>(
        "UPDATE cpl_invitations SET revoked_at=$3 WHERE organization_id=$1 AND id=$2 AND redeemed_at IS NULL RETURNING id",
        [access.organizationId, uuid(request.invitationId), this.now().toISOString()],
      );
      if (!result.rows[0]) fail();
      await this.audit(executor, access, "invitation.revoked", request.invitationId);
    });
  }
  async setMembershipStatus(
    request: CplTenantRequest & {
      readonly identityId: string;
      readonly status: "active" | "suspended" | "removed";
    },
  ): Promise<void> {
    if (!["active", "suspended", "removed"].includes(request.status))
      fail("CPL_INVALID_MEMBERSHIP");
    await this.authenticated(request, "members:manage", async (executor, access) => {
      const result = await executor.query<Row>(
        "UPDATE cpl_memberships SET status=$3,version=version+1 WHERE organization_id=$1 AND identity_id=$2 AND role <> 'owner' AND (role <> 'admin' OR $4='owner') RETURNING identity_id",
        [access.organizationId, uuid(request.identityId), request.status, access.role],
      );
      if (!result.rows[0]) fail();
      await this.audit(executor, access, "membership.updated", request.identityId);
    });
  }
  async issueServiceGrant(
    request: CplTenantRequest & {
      readonly module: CplModuleKey;
      readonly expiresInMinutes?: number;
    },
  ): Promise<{ readonly id: string; readonly token: string; readonly expiresAt: string }> {
    const token = issueToken();
    const expiresAt = expires(this.now(), request.expiresInMinutes ?? 15, 60);
    return this.authenticated(
      request,
      "settings:write",
      async (executor, access) => {
        const id = randomUUID();
        await executor.query(
          "INSERT INTO cpl_service_grants (id,organization_id,module_key,token_hash,issued_by_identity_id,issued_membership_version,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [
            id,
            access.organizationId,
            moduleKey(request.module),
            tokenHash(token),
            access.identityId,
            access.membershipVersion,
            expiresAt,
          ],
        );
        await this.audit(executor, access, "service-grant.created", id);
        return { id, token, expiresAt };
      },
      request.module,
    );
  }
  /** Workers must call immediately before every operation; a returned snapshot is
   * not a bearer capability and must never replace current membership checks. */
  async authorizeService(input: {
    readonly token: string;
    readonly organizationId: string;
    readonly module: CplModuleKey;
  }): Promise<CplTenantAccess> {
    const organizationId = uuid(input.organizationId);
    return this.database.transaction(async (executor) => {
      await this.scope(executor, organizationId);
      const result = await executor.query<Row>(
        "SELECT * FROM cpl_service_grants WHERE organization_id=$1 AND token_hash=$2 AND module_key=$3 FOR SHARE",
        [organizationId, tokenHash(input.token), moduleKey(input.module)],
      );
      const grant = result.rows[0];
      if (!grant || grant.revoked_at !== null || instant(grant.expires_at) <= this.now().getTime())
        fail();
      const access = await this.member(
        executor,
        organizationId,
        String(grant.issued_by_identity_id),
        "settings:write",
        input.module,
      );
      if (access.membershipVersion !== Number(grant.issued_membership_version)) fail();
      return access;
    });
  }
  async revokeServiceGrant(
    request: CplTenantRequest & { readonly grantId: string },
  ): Promise<void> {
    await this.authenticated(request, "settings:write", async (executor, access) => {
      const result = await executor.query<Row>(
        "UPDATE cpl_service_grants SET revoked_at=$3 WHERE organization_id=$1 AND id=$2 RETURNING id",
        [access.organizationId, uuid(request.grantId), this.now().toISOString()],
      );
      if (!result.rows[0]) fail();
      await this.audit(executor, access, "service-grant.revoked", request.grantId);
    });
  }
  async namespaceFor(
    request: CplTenantRequest & {
      readonly kind: CplNamespaceKind;
      readonly resourceId: string;
      readonly module: CplModuleKey;
    },
  ): Promise<string> {
    const module = moduleKey(request.module);
    if (!namespaceKinds.includes(request.kind)) fail("CPL_INVALID_NAMESPACE");
    const resource = text(request.resourceId, 1_000);
    return this.authenticated(
      request,
      "records:read",
      async (_executor, access) =>
        `organizations/${access.organizationId}/${request.kind}/${createHash("sha256").update(resource).digest("hex")}`,
      module,
    );
  }
}
