import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  CPL_ADMIN_ROLES,
  CPL_ADMIN_ROLE_DESCRIPTIONS,
  cplAdminObject,
  cplAdminText,
  cplAdminId,
  cplAdminVersion,
  cplAdminKey,
  cplAdminRole,
  normalizeCplMemberChange,
  type CplAdminBootstrap,
  type CplAdminPermissions,
  type CplAdminMember,
  type CplAdminInvitation,
  type CplAdminPage,
  type CplAdminListInput,
  type CplInvitationIssueResult,
} from "@bea/domain/cpl-admin";
import { CPL_LOCAL_PERSONAS, CPL_LOCAL_IDENTITY_ISSUER } from "@bea/security/hosted";
import type { SqlExecutor } from "./adapter.js";
import {
  CPL_MODULE_KEYS,
  CplTenantAccessError,
  cplTenantRoleAllows,
  type CplTenantAccess,
  type CplTenantRequest,
  type SqlCplTenantRepository,
  type CplOrganization,
} from "./tenant-repository.js";

type Row = Record<string, unknown>;
type TenantInput = CplTenantRequest & { input: unknown };
const RELEASED = [
  "intake-job-tracker",
  "proposal-builder",
  "award-to-project-launcher",
  "field-report-assembler",
];
function fail(code: string): never {
  throw new CplTenantAccessError(code);
}
function iso(value: unknown): string {
  return new Date(value instanceof Date ? value.getTime() : String(value)).toISOString();
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function tokenHash(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value))
    fail("CPL_INVITATION_UNAVAILABLE");
  return createHash("sha256").update(value).digest("hex");
}
function permissions(a: CplTenantAccess | null): CplAdminPermissions {
  return {
    canManageMembers: !!a && cplTenantRoleAllows(a.role, "members:manage"),
    canGrantOwner: a?.role === "owner",
    canConfigureCompany: !!a && cplTenantRoleAllows(a.role, "company:configure"),
    canReadDirectory: !!a && cplTenantRoleAllows(a.role, "directory:read"),
    canWriteDirectory: !!a && cplTenantRoleAllows(a.role, "directory:write"),
    canReadIntegrations: !!a && cplTenantRoleAllows(a.role, "integrations:read"),
    canReadAudit: !!a && cplTenantRoleAllows(a.role, "audit:read"),
  };
}
function page(input: CplAdminListInput, kind: string) {
  const q = input.query === undefined ? "" : cplAdminText(input.query, 160, true);
  const status = input.status === undefined ? "all" : cplAdminText(input.status, 30);
  const limit = input.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail("CPL_ADMIN_INVALID_INPUT");
  let cursorAt: string | null = null,
    cursorId: string | null = null;
  if (input.cursor) {
    try {
      if (typeof input.cursor !== "string" || input.cursor.length > 1000) throw new Error();
      const v = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as Record<
        string,
        unknown
      >;
      if (v.filter !== hash([kind, q, status])) throw new Error();
      cursorAt = iso(v.at);
      cursorId = cplAdminId(v.id);
    } catch {
      fail("CPL_ADMIN_INVALID_CURSOR");
    }
  }
  return {
    q,
    status,
    limit,
    cursorAt,
    cursorId,
    next: (row: Row, key: string) =>
      Buffer.from(
        JSON.stringify({
          filter: hash([kind, q, status]),
          at: iso(row.created_at),
          id: String(row[key]),
        }),
      ).toString("base64url"),
  };
}
async function audit(
  e: SqlExecutor,
  a: CplTenantAccess,
  action: string,
  id: string,
  type: string,
  version: number,
  summary: Row,
) {
  await e.query(
    "INSERT INTO cpl_tenant_audit_events(id,organization_id,actor_identity_id,action,resource_id,resource_type,resource_version,safe_summary) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
    [
      randomUUID(),
      a.organizationId,
      a.identityId,
      action,
      id,
      type,
      version,
      JSON.stringify(summary),
    ],
  );
}
async function previous(
  e: SqlExecutor,
  a: CplTenantAccess,
  action: string,
  key: string,
  input: unknown,
): Promise<Row | null> {
  const result = await e.query<Row>(
    "SELECT request_hash,result FROM cpl_administration_mutations WHERE organization_id=$1 AND actor_identity_id=$2 AND action=$3 AND idempotency_key=$4",
    [a.organizationId, a.identityId, action, key],
  );
  const row = result.rows[0];
  if (row && row.request_hash !== hash(input)) fail("CPL_ADMIN_IDEMPOTENCY_CONFLICT");
  return row ? (row.result as Row) : null;
}
async function remember(
  e: SqlExecutor,
  a: CplTenantAccess,
  action: string,
  key: string,
  input: unknown,
  result: Row,
) {
  await e.query(
    "INSERT INTO cpl_administration_mutations(organization_id,actor_identity_id,action,idempotency_key,request_hash,result) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
    [a.organizationId, a.identityId, action, key, hash(input), JSON.stringify(result)],
  );
}
function canChange(a: CplTenantAccess, row: Row): boolean {
  return (
    a.role === "owner" || (a.role === "admin" && !["owner", "admin"].includes(String(row.role)))
  );
}
function member(row: Row, a: CplTenantAccess): CplAdminMember {
  return {
    identityId: String(row.identity_id),
    displayName: String(row.display_name),
    email: row.email_verified === true && row.email ? String(row.email) : null,
    role: cplAdminRole(row.role),
    status: row.status as CplAdminMember["status"],
    version: Number(row.version),
    createdAt: iso(row.created_at),
    canChange: canChange(a, row),
    canGrantOwner: a.role === "owner",
    needsReassignment: row.needs_reassignment === true,
  };
}
const INVITATION_QUERY = `SELECT i.*,u.id AS recipient_identity_id,u.display_name AS recipient_display_name,
 m.status AS inviter_status,m.role AS inviter_role,m.version AS inviter_current_version,author.status AS inviter_identity_status,
 EXISTS(SELECT 1 FROM cpl_invitations successor WHERE successor.organization_id=i.organization_id AND successor.replaces_id=i.id) AS has_replacement
 FROM cpl_invitations i LEFT JOIN cpl_identities u ON u.issuer=i.recipient_issuer AND u.subject=i.recipient_subject
 JOIN cpl_memberships m ON m.organization_id=i.organization_id AND m.identity_id=i.invited_by_identity_id
 JOIN cpl_identities author ON author.id=m.identity_id`;
function invitationStatus(row: Row): CplAdminInvitation["status"] {
  if (row.redeemed_at) return "redeemed";
  if (row.revoked_at) return "revoked";
  if (new Date(iso(row.expires_at)).getTime() <= Date.now()) return "expired";
  if (
    row.inviter_status !== "active" ||
    row.inviter_identity_status !== "active" ||
    !["owner", "admin"].includes(String(row.inviter_role)) ||
    (row.role === "admin" && row.inviter_role !== "owner") ||
    row.inviter_membership_version !== row.inviter_current_version
  )
    return "authority_changed";
  return "pending";
}
function invitation(row: Row, a: CplTenantAccess): CplAdminInvitation {
  const status = invitationStatus(row),
    manage = a.role === "owner" || (a.role === "admin" && row.role !== "admin");
  return {
    id: String(row.id),
    organizationId: a.organizationId,
    recipientIdentityId: row.recipient_identity_id ? String(row.recipient_identity_id) : null,
    recipientDisplayName: String(row.recipient_display_name ?? "Verified identity"),
    role: row.role as CplAdminInvitation["role"],
    status,
    version: Number(row.version),
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    redeemedAt: row.redeemed_at ? iso(row.redeemed_at) : null,
    revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
    invitedByIdentityId: String(row.invited_by_identity_id),
    replacesId: row.replaces_id ? String(row.replaces_id) : null,
    canReissue: manage && status !== "redeemed" && row.has_replacement !== true,
    canRevoke: manage && ["pending", "authority_changed", "expired"].includes(status),
  };
}

/** Uses the existing identity, member, invitation and audit stores. No bootstrap
 * SQL, browser assertions, session fabrication or legacy global repositories. */
export class SqlCplAdministrationRepository {
  constructor(private readonly tenants: SqlCplTenantRepository) {}
  async bootstrap(request: {
    sessionToken: string;
    organizationId?: string | null;
  }): Promise<CplAdminBootstrap> {
    const identity = await this.tenants.withSessionTransaction(
      request.sessionToken,
      async (_e, s) => ({ id: s.identityId, displayName: s.displayName }),
    );
    const organizations = [...(await this.tenants.listOrganizations(request.sessionToken))];
    let platform: CplAdminBootstrap["platform"] = { canProvision: false, assurance: "none" };
    try {
      platform = await this.tenants.withPlatformAdministrationTransaction(
        request.sessionToken,
        async (_e, a) => ({ canProvision: true, assurance: a.assurance }),
      );
    } catch (error) {
      if (
        !(error instanceof CplTenantAccessError) ||
        !["CPL_PLATFORM_MFA_REQUIRED", "CPL_PLATFORM_ADMIN_REQUIRED"].includes(error.code)
      )
        throw error;
    }
    let access: CplTenantAccess | null = null;
    let enabledModules: string[] = [];
    const selectedOrganizationId = request.organizationId
      ? cplAdminId(request.organizationId)
      : null;
    if (selectedOrganizationId) {
      access = await this.tenants.authorize({
        sessionToken: request.sessionToken,
        organizationId: selectedOrganizationId,
        permission: "settings:read",
      });
      enabledModules = (
        await this.tenants.listEntitlements({
          sessionToken: request.sessionToken,
          organizationId: selectedOrganizationId,
        })
      )
        .filter((m) => m.enabled && m.usageLimit !== 0)
        .map((m) => m.moduleKey);
    }
    let localRecipients: CplAdminBootstrap["localRecipients"] = [];
    if (platform.canProvision || permissions(access).canManageMembers) {
      localRecipients = await this.tenants.withSessionTransaction(
        request.sessionToken,
        async (e) => {
          if (!(await this.tenants.verifyLocalAdministrationBoundary(e))) return [];
          const result = await e.query<Row>(
            "SELECT id,subject,display_name,email FROM cpl_identities WHERE issuer=$1 AND subject=ANY($2::text[]) AND status='active' AND email_verified=TRUE AND hosted_domain IS NULL ORDER BY subject",
            [
              CPL_LOCAL_IDENTITY_ISSUER,
              CPL_LOCAL_PERSONAS.filter((p) => !p.platformOperator).map((p) => p.subject),
            ],
          );
          return result.rows.flatMap((row) => {
            const persona = CPL_LOCAL_PERSONAS.find(
              (p) => p.subject === row.subject && p.email === row.email && !p.platformOperator,
            );
            return persona
              ? [
                  {
                    identityId: String(row.id),
                    personaKey: persona.key,
                    displayName: String(row.display_name),
                  },
                ]
              : [];
          });
        },
      );
    }
    return {
      identity,
      organizations,
      selectedOrganizationId,
      membership: access ? { role: access.role, version: access.membershipVersion } : null,
      platform,
      permissions: permissions(access),
      enabledModules,
      roles: CPL_ADMIN_ROLES.map((role) => ({
        role,
        description: CPL_ADMIN_ROLE_DESCRIPTIONS[role],
        canGrant:
          access?.role === "owner" ||
          (access?.role === "admin" && !["owner", "admin"].includes(role)),
      })),
      localRecipients,
    };
  }
  async provisionOrganization(request: {
    sessionToken: string;
    input: unknown;
  }): Promise<CplOrganization> {
    const v = cplAdminObject(request.input),
      slug = cplAdminText(v.slug, 63),
      displayName = cplAdminText(v.displayName),
      initialOwnerIdentityId = cplAdminId(v.initialOwnerIdentityId),
      key = cplAdminKey(v.idempotencyKey);
    if (
      !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u.test(slug) ||
      !Array.isArray(v.enabledModules) ||
      v.enabledModules.some((m) => typeof m !== "string" || !RELEASED.includes(m)) ||
      new Set(v.enabledModules).size !== v.enabledModules.length
    )
      fail("CPL_ADMIN_INVALID_INPUT");
    const enabledModules = [...(v.enabledModules as string[])].sort(),
      input = { slug, displayName, initialOwnerIdentityId, enabledModules };
    return this.tenants.withPlatformAdministrationTransaction(
      request.sessionToken,
      async (e, actor) => {
        if (actor.identityId === initialOwnerIdentityId) fail("CPL_INITIAL_OWNER_MUST_BE_DISTINCT");
        await e.query("SELECT pg_advisory_xact_lock(hashtextextended($1,36))", [
          `provision:${actor.identityId}:${key}`,
        ]);
        const prior = (
          await e.query<Row>(
            "SELECT request_hash,organization_id FROM cpl_platform_provision_requests WHERE actor_identity_id=$1 AND idempotency_key=$2",
            [actor.identityId, key],
          )
        ).rows[0];
        if (prior && prior.request_hash !== hash(input)) fail("CPL_ADMIN_IDEMPOTENCY_CONFLICT");
        const organizationId = prior ? String(prior.organization_id) : randomUUID();
        await e.query("SELECT set_config('cpl.organization_id',$1,true)", [organizationId]);
        if (!prior) {
          const owner = await this.recipient(e, initialOwnerIdentityId);
          if (
            actor.assurance !== "local-development" &&
            owner.issuer !== "https://accounts.google.com"
          )
            fail("CPL_ADMIN_RECIPIENT_UNAVAILABLE");
          try {
            await e.query("INSERT INTO cpl_organizations(id,slug,display_name) VALUES($1,$2,$3)", [
              organizationId,
              slug,
              displayName,
            ]);
          } catch (error) {
            if ((error as { code?: string }).code === "23505")
              fail("CPL_ORGANIZATION_SLUG_UNAVAILABLE");
            throw error;
          }
          await e.query(
            "INSERT INTO cpl_memberships(organization_id,identity_id,role) VALUES($1,$2,'owner')",
            [organizationId, initialOwnerIdentityId],
          );
          for (const module of CPL_MODULE_KEYS)
            await e.query(
              "INSERT INTO cpl_module_entitlements(organization_id,module_key,enabled,usage_limit) VALUES($1,$2,$3,$4)",
              [
                organizationId,
                module,
                enabledModules.includes(module),
                enabledModules.includes(module) ? null : 0,
              ],
            );
          await e.query(
            "INSERT INTO cpl_platform_provision_requests(actor_identity_id,idempotency_key,request_hash,organization_id) VALUES($1,$2,$3,$4)",
            [actor.identityId, key, hash(input), organizationId],
          );
          await e.query(
            "INSERT INTO cpl_platform_audit_events(id,actor_identity_id,organization_id,action,resource_id) VALUES($1,$2,$3,'company.provisioned',$4)",
            [randomUUID(), actor.identityId, organizationId, initialOwnerIdentityId],
          );
        }
        const row = (
          await e.query<Row>(
            "SELECT id,slug,display_name,status FROM cpl_organizations WHERE id=$1",
            [organizationId],
          )
        ).rows[0]!;
        return {
          id: String(row.id),
          slug: String(row.slug),
          displayName: String(row.display_name),
          status: String(row.status),
        };
      },
    );
  }
  private async recipient(e: SqlExecutor, identityId: string): Promise<Row> {
    const row = (
      await e.query<Row>(
        "SELECT id,issuer,subject,email,display_name FROM cpl_identities WHERE id=$1 AND status='active' AND email_verified=TRUE FOR SHARE",
        [identityId],
      )
    ).rows[0];
    if (!row) fail("CPL_ADMIN_RECIPIENT_UNAVAILABLE");
    if (row.issuer === "https://accounts.google.com") return row;
    if (
      row.issuer !== CPL_LOCAL_IDENTITY_ISSUER ||
      !CPL_LOCAL_PERSONAS.some(
        (p) => !p.platformOperator && p.subject === row.subject && p.email === row.email,
      ) ||
      !(await this.tenants.verifyLocalAdministrationBoundary(e))
    )
      fail("CPL_ADMIN_RECIPIENT_UNAVAILABLE");
    return row;
  }
  async listMembers(
    request: CplTenantRequest & CplAdminListInput,
  ): Promise<CplAdminPage<CplAdminMember>> {
    const p = page(request, `members:${request.organizationId}`);
    if (!["all", "active", "suspended", "removed"].includes(p.status))
      fail("CPL_ADMIN_INVALID_INPUT");
    return this.tenants.withOrganizationTransaction(request, "members:manage", async (e, a) => {
      const filter =
        "m.organization_id=$1 AND($2='all' OR m.status=$2) AND($3='' OR position(lower($3) in lower(i.display_name||' '||coalesce(i.email,'')))>0)";
      const parameters = [a.organizationId, p.status, p.q];
      const count = await e.query<Row>(
        `SELECT count(*) AS total FROM cpl_memberships m JOIN cpl_identities i ON i.id=m.identity_id WHERE ${filter}`,
        parameters,
      );
      const rows = await e.query<Row>(
        `SELECT m.*,i.display_name,i.email,i.email_verified,(m.status<>'active' OR i.status<>'active') AND (
        EXISTS(SELECT 1 FROM cpl_workflow_leads l WHERE l.organization_id=m.organization_id AND l.assigned_member_identity_id=m.identity_id)
        OR EXISTS(SELECT 1 FROM cpl_project_visits v WHERE v.organization_id=m.organization_id AND v.responsible_identity_id=m.identity_id AND v.status NOT IN('completed','cancelled'))
        OR EXISTS(SELECT 1 FROM cpl_action_tasks t WHERE t.organization_id=m.organization_id AND t.owner->>'identityId'=m.identity_id::text AND t.status IN('open','in_progress','blocked'))
      ) AS needs_reassignment FROM cpl_memberships m JOIN cpl_identities i ON i.id=m.identity_id WHERE ${filter} AND($4::timestamptz IS NULL OR(date_trunc('milliseconds',m.created_at),m.identity_id)<($4::timestamptz,$5::uuid)) ORDER BY date_trunc('milliseconds',m.created_at) DESC,m.identity_id DESC LIMIT $6`,
        [...parameters, p.cursorAt, p.cursorId, p.limit + 1],
      );
      const more = rows.rows.length > p.limit,
        items = rows.rows.slice(0, p.limit);
      return {
        items: items.map((r) => member(r, a)),
        total: Number(count.rows[0]!.total),
        nextCursor: more ? p.next(items.at(-1)!, "identity_id") : null,
        limit: p.limit,
      };
    });
  }
  private async memberRow(
    e: SqlExecutor,
    a: CplTenantAccess,
    identityId: string,
    lock = false,
  ): Promise<Row> {
    return (
      (
        await e.query<Row>(
          `SELECT m.*,i.display_name,i.email,i.email_verified,i.status AS identity_status FROM cpl_memberships m JOIN cpl_identities i ON i.id=m.identity_id WHERE m.organization_id=$1 AND m.identity_id=$2 ${lock ? "FOR UPDATE OF m FOR SHARE OF i" : ""}`,
          [a.organizationId, identityId],
        )
      ).rows[0] ?? fail("CPL_MEMBER_NOT_FOUND")
    );
  }
  async changeMember(request: TenantInput): Promise<CplAdminMember> {
    const v = normalizeCplMemberChange(request.input);
    return this.tenants.withAdministrationTransaction(request, async (e, a) => {
      const prior = await previous(e, a, "member.change", v.idempotencyKey, v);
      if (prior) return member(await this.memberRow(e, a, v.identityId), a);
      const target = await this.memberRow(e, a, v.identityId, true);
      if (!canChange(a, target) || (a.role !== "owner" && ["owner", "admin"].includes(v.role)))
        fail("CPL_ACCESS_DENIED");
      if (Number(target.version) !== v.expectedVersion) fail("CPL_ADMIN_STALE_VERSION");
      if (v.status === "active" && target.identity_status !== "active")
        fail("CPL_ADMIN_RECIPIENT_UNAVAILABLE");
      if (
        target.role === "owner" &&
        target.status === "active" &&
        (v.role !== "owner" || v.status !== "active")
      ) {
        const count = await e.query<Row>(
          "SELECT count(*) AS owners FROM cpl_memberships m JOIN cpl_identities i ON i.id=m.identity_id WHERE m.organization_id=$1 AND m.role='owner' AND m.status='active' AND i.status='active'",
          [a.organizationId],
        );
        if (Number(count.rows[0]!.owners) < 2) fail("CPL_LAST_ACTIVE_OWNER");
      }
      await e.query(
        "UPDATE cpl_memberships SET role=$3,status=$4,version=version+1 WHERE organization_id=$1 AND identity_id=$2",
        [a.organizationId, v.identityId, v.role, v.status],
      );
      await audit(
        e,
        a,
        target.role === "owner" || v.role === "owner"
          ? "membership.ownership-changed"
          : "membership.changed",
        v.identityId,
        "membership",
        v.expectedVersion + 1,
        {
          message: v.reason,
          changedFields: ["role", "status"],
          previousRole: target.role,
          role: v.role,
          previousStatus: target.status,
          status: v.status,
        },
      );
      await remember(e, a, "member.change", v.idempotencyKey, v, { identityId: v.identityId });
      return member(await this.memberRow(e, a, v.identityId), a);
    });
  }
  private async invitationRow(
    e: SqlExecutor,
    a: CplTenantAccess,
    invitationId: string,
    lock = false,
  ): Promise<Row> {
    return (
      (
        await e.query<Row>(
          `${INVITATION_QUERY} WHERE i.organization_id=$1 AND i.id=$2 ${lock ? "FOR UPDATE OF i FOR SHARE OF m,author" : ""}`,
          [a.organizationId, invitationId],
        )
      ).rows[0] ?? fail("CPL_INVITATION_UNAVAILABLE")
    );
  }
  async listInvitations(
    request: CplTenantRequest & CplAdminListInput,
  ): Promise<CplAdminPage<CplAdminInvitation>> {
    const p = page(request, `invitations:${request.organizationId}`);
    if (
      !["all", "pending", "expired", "revoked", "redeemed", "authority_changed"].includes(p.status)
    )
      fail("CPL_ADMIN_INVALID_INPUT");
    return this.tenants.withOrganizationTransaction(request, "members:manage", async (e, a) => {
      const base = `WITH invitations AS (${INVITATION_QUERY} WHERE i.organization_id=$1), scoped AS(SELECT *,CASE WHEN redeemed_at IS NOT NULL THEN 'redeemed' WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN expires_at<=CURRENT_TIMESTAMP THEN 'expired' WHEN inviter_status<>'active' OR inviter_identity_status<>'active' OR inviter_role NOT IN('owner','admin') OR(role='admin' AND inviter_role<>'owner') OR inviter_membership_version<>inviter_current_version THEN 'authority_changed' ELSE 'pending' END AS effective_status FROM invitations) `;
      const filter =
        "($2='all' OR effective_status=$2) AND($3='' OR position(lower($3) in lower(coalesce(recipient_display_name,'')))>0)";
      const parameters = [a.organizationId, p.status, p.q];
      const count = await e.query<Row>(
        `${base} SELECT count(*) AS total FROM scoped WHERE ${filter}`,
        parameters,
      );
      const rows = await e.query<Row>(
        `${base} SELECT * FROM scoped WHERE ${filter} AND($4::timestamptz IS NULL OR(date_trunc('milliseconds',created_at),id)<($4::timestamptz,$5::uuid)) ORDER BY date_trunc('milliseconds',created_at) DESC,id DESC LIMIT $6`,
        [...parameters, p.cursorAt, p.cursorId, p.limit + 1],
      );
      const more = rows.rows.length > p.limit,
        items = rows.rows.slice(0, p.limit);
      return {
        items: items.map((r) => invitation(r, a)),
        total: Number(count.rows[0]!.total),
        nextCursor: more ? p.next(items.at(-1)!, "id") : null,
        limit: p.limit,
      };
    });
  }
  private async issue(
    e: SqlExecutor,
    a: CplTenantAccess,
    recipient: Row,
    role: string,
    expiresInMinutes: number,
    replacesId: string | null,
  ): Promise<CplInvitationIssueResult> {
    if (role === "owner" || (role === "admin" && a.role !== "owner")) fail("CPL_ACCESS_DENIED");
    const existing = (
      await e.query<Row>(
        "SELECT role,status FROM cpl_memberships WHERE organization_id=$1 AND identity_id=$2",
        [a.organizationId, recipient.id],
      )
    ).rows[0];
    if (existing && (existing.status !== "removed" || existing.role === "owner"))
      fail("CPL_MEMBER_ALREADY_EXISTS");
    const pending = await e.query(
      "SELECT id FROM cpl_invitations WHERE organization_id=$1 AND recipient_issuer=$2 AND recipient_subject=$3 AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp() LIMIT 1",
      [a.organizationId, recipient.issuer, recipient.subject],
    );
    if (pending.rows.length) fail("CPL_INVITATION_ALREADY_EXISTS");
    const token = randomBytes(32).toString("base64url"),
      invitationId = randomUUID();
    await e.query(
      "INSERT INTO cpl_invitations(id,organization_id,token_hash,recipient_issuer,recipient_subject,role,invited_by_identity_id,expires_at,inviter_membership_version,replaces_id) VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+($8::integer*interval '1 minute'),$9,$10)",
      [
        invitationId,
        a.organizationId,
        tokenHash(token),
        recipient.issuer,
        recipient.subject,
        role,
        a.identityId,
        expiresInMinutes,
        a.membershipVersion,
        replacesId,
      ],
    );
    await audit(
      e,
      a,
      replacesId ? "invitation.reissued" : "invitation.created",
      invitationId,
      "invitation",
      1,
      {
        message: "Local handoff or verified subject-bound invitation created; not sent.",
        changedFields: ["role", "expiresAt"],
        replacesId,
      },
    );
    return {
      invitation: invitation(await this.invitationRow(e, a, invitationId), a),
      token,
      delivery: "not_sent",
    };
  }
  async createInvitation(request: TenantInput): Promise<CplInvitationIssueResult> {
    const input = cplAdminObject(request.input),
      recipientIdentityId = cplAdminId(input.recipientIdentityId),
      role = cplAdminRole(input.role),
      key = cplAdminKey(input.idempotencyKey),
      expiresInMinutes = input.expiresInMinutes ?? 1440;
    if (
      role === "owner" ||
      !Number.isInteger(expiresInMinutes) ||
      Number(expiresInMinutes) < 1 ||
      Number(expiresInMinutes) > 10080
    )
      fail("CPL_ADMIN_INVALID_INPUT");
    const normalized = { recipientIdentityId, role, expiresInMinutes };
    return this.tenants.withAdministrationTransaction(request, async (e, a) => {
      if (role === "admin" && a.role !== "owner") fail("CPL_ACCESS_DENIED");
      const prior = await previous(e, a, "invitation.create", key, normalized);
      if (prior)
        return {
          invitation: invitation(await this.invitationRow(e, a, String(prior.id)), a),
          token: null,
          delivery: "not_sent",
        };
      const result = await this.issue(
        e,
        a,
        await this.recipient(e, recipientIdentityId),
        role,
        Number(expiresInMinutes),
        null,
      );
      await remember(e, a, "invitation.create", key, normalized, { id: result.invitation.id });
      return result;
    });
  }
  private async invitationChange(
    request: TenantInput,
    reissue: boolean,
  ): Promise<CplInvitationIssueResult> {
    const raw = cplAdminObject(request.input),
      id = cplAdminId(raw.invitationId),
      expectedVersion = cplAdminVersion(raw.expectedVersion),
      reason = cplAdminText(raw.reason, 2000),
      key = cplAdminKey(raw.idempotencyKey),
      input = { id, expectedVersion, reason },
      action = reissue ? "invitation.reissue" : "invitation.revoke";
    return this.tenants.withAdministrationTransaction(request, async (e, a) => {
      const prior = await previous(e, a, action, key, input);
      if (prior)
        return {
          invitation: invitation(await this.invitationRow(e, a, String(prior.id)), a),
          token: null,
          delivery: "not_sent",
        };
      const row = await this.invitationRow(e, a, id, true);
      if (row.role === "admin" && a.role !== "owner") fail("CPL_ACCESS_DENIED");
      if (Number(row.version) !== expectedVersion) fail("CPL_ADMIN_STALE_VERSION");
      if (row.redeemed_at || (!reissue && row.revoked_at)) fail("CPL_INVITATION_UNAVAILABLE");
      if (reissue && row.has_replacement === true) fail("CPL_INVITATION_UNAVAILABLE");
      await e.query(
        "UPDATE cpl_invitations SET revoked_at=coalesce(revoked_at,clock_timestamp()),version=version+1 WHERE organization_id=$1 AND id=$2",
        [a.organizationId, id],
      );
      await audit(e, a, "invitation.revoked", id, "invitation", expectedVersion + 1, {
        message: reason,
        changedFields: ["status"],
      });
      const result = reissue
        ? await this.issue(
            e,
            a,
            await this.recipient(e, cplAdminId(row.recipient_identity_id)),
            String(row.role),
            1440,
            id,
          )
        : {
            invitation: invitation(await this.invitationRow(e, a, id), a),
            token: null,
            delivery: "not_sent" as const,
          };
      await remember(e, a, action, key, input, { id: result.invitation.id });
      return result;
    });
  }
  reissueInvitation(request: TenantInput): Promise<CplInvitationIssueResult> {
    return this.invitationChange(request, true);
  }
  revokeInvitation(request: TenantInput): Promise<CplInvitationIssueResult> {
    return this.invitationChange(request, false);
  }
  async acceptInvitation(request: {
    sessionToken: string;
    organizationId: string;
    invitationToken: string;
    idempotencyKey: string;
  }): Promise<CplTenantAccess> {
    const organizationId = cplAdminId(request.organizationId),
      token = tokenHash(request.invitationToken),
      key = cplAdminKey(request.idempotencyKey);
    return this.tenants.withSessionTransaction(request.sessionToken, async (e, s) => {
      await e.query("SELECT pg_advisory_xact_lock(hashtextextended($1,36))", [organizationId]);
      await e.query("SELECT set_config('cpl.organization_id',$1,true)", [organizationId]);
      const row = (
        await e.query<Row>(
          `${INVITATION_QUERY} JOIN cpl_organizations o ON o.id=i.organization_id WHERE i.organization_id=$1 AND i.token_hash=$2 AND o.status='active' FOR UPDATE OF i FOR SHARE OF o,m,author`,
          [organizationId, token],
        )
      ).rows[0];
      if (!row || row.recipient_issuer !== s.issuer || row.recipient_subject !== s.subject)
        fail("CPL_INVITATION_UNAVAILABLE");
      await previous(
        e,
        {
          organizationId,
          identityId: s.identityId,
          role: cplAdminRole(row.role),
          membershipVersion: 0,
        },
        "invitation.accept",
        key,
        { invitationId: String(row.id) },
      );
      if (row.redeemed_at) {
        const current = (
          await e.query<Row>(
            "SELECT role,version FROM cpl_memberships WHERE organization_id=$1 AND identity_id=$2 AND status='active' FOR SHARE",
            [organizationId, s.identityId],
          )
        ).rows[0];
        if (
          row.redeemed_by_identity_id !== s.identityId ||
          !current ||
          current.version !== row.redeemed_membership_version
        )
          fail("CPL_INVITATION_UNAVAILABLE");
        return {
          organizationId,
          identityId: s.identityId,
          role: cplAdminRole(current.role),
          membershipVersion: Number(current.version),
        };
      }
      if (invitationStatus(row) !== "pending") fail("CPL_INVITATION_UNAVAILABLE");
      const inserted = await e.query<Row>(
        `INSERT INTO cpl_memberships(organization_id,identity_id,role) VALUES($1,$2,$3)
        ON CONFLICT(organization_id,identity_id) DO UPDATE SET role=EXCLUDED.role,status='active',version=cpl_memberships.version+1
        WHERE cpl_memberships.status='removed' AND cpl_memberships.role<>'owner' RETURNING role,version`,
        [organizationId, s.identityId, row.role],
      );
      if (!inserted.rows[0]) fail("CPL_INVITATION_UNAVAILABLE");
      const a: CplTenantAccess = {
        organizationId,
        identityId: s.identityId,
        role: cplAdminRole(inserted.rows[0].role),
        membershipVersion: Number(inserted.rows[0].version),
      };
      await e.query(
        "UPDATE cpl_invitations SET redeemed_at=clock_timestamp(),redeemed_by_identity_id=$3,redeemed_membership_version=$4,version=version+1 WHERE organization_id=$1 AND id=$2",
        [organizationId, row.id, s.identityId, a.membershipVersion],
      );
      await audit(
        e,
        a,
        "invitation.redeemed",
        String(row.id),
        "invitation",
        Number(row.version) + 1,
        { message: "Verified subject accepted the invitation.", changedFields: ["status"] },
      );
      await remember(
        e,
        a,
        "invitation.accept",
        key,
        { invitationId: String(row.id) },
        { identityId: s.identityId },
      );
      return a;
    });
  }
}
