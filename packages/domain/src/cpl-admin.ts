export const CPL_ADMIN_ROLES = [
  "owner",
  "admin",
  "manager",
  "reviewer",
  "member",
  "field-user",
] as const;
export type CplAdminRole = (typeof CPL_ADMIN_ROLES)[number];
export type CplMemberStatus = "active" | "suspended" | "removed";
export type CplInvitationStatus =
  "pending" | "expired" | "revoked" | "redeemed" | "authority_changed";
export const CPL_ADMIN_ROLE_DESCRIPTIONS: Readonly<Record<CplAdminRole, string>> = {
  owner:
    "Company administration, ownership changes, operations and review. No platform or entitlement authority.",
  admin:
    "Company configuration and lower-role team administration, operations and review. Cannot grant ownership or administer other owners/admins.",
  manager:
    "Operational planning, approvals, awards, delivery confirmation and reasoned readiness overrides.",
  reviewer: "Assigned review and approval capabilities. No company or team administration.",
  member:
    "Operational drafting, planning, field work and delivery preparation. Cannot approve or award.",
  "field-user":
    "Assigned visit and field work only. No unrestricted directory, commercial or administration access.",
};
export interface CplAdminPermissions {
  canManageMembers: boolean;
  canGrantOwner: boolean;
  canConfigureCompany: boolean;
  canReadDirectory: boolean;
  canWriteDirectory: boolean;
  canReadIntegrations: boolean;
  canReadAudit: boolean;
}
export interface CplAdminMember {
  identityId: string;
  displayName: string;
  email: string | null;
  role: CplAdminRole;
  status: CplMemberStatus;
  version: number;
  createdAt: string;
  canChange: boolean;
  canGrantOwner: boolean;
  /** Historical assignments stay attached; this indicates deliberate reassignment is needed. */
  needsReassignment: boolean;
}
export interface CplAdminInvitation {
  id: string;
  organizationId: string;
  recipientIdentityId: string | null;
  recipientDisplayName: string;
  role: Exclude<CplAdminRole, "owner">;
  status: CplInvitationStatus;
  version: number;
  createdAt: string;
  expiresAt: string;
  redeemedAt: string | null;
  revokedAt: string | null;
  invitedByIdentityId: string;
  replacesId: string | null;
  canReissue: boolean;
  canRevoke: boolean;
}
export interface CplAdminPage<T> {
  items: T[];
  total: number;
  nextCursor: string | null;
  limit: number;
}
export interface CplAdminListInput {
  query?: string;
  status?: string;
  limit?: number;
  cursor?: string | null;
}
export interface CplAdminBootstrap {
  identity: { id: string; displayName: string };
  organizations: { id: string; slug: string; displayName: string; status: string }[];
  selectedOrganizationId: string | null;
  membership: { role: CplAdminRole; version: number } | null;
  platform: { canProvision: boolean; assurance: "local-development" | "verified-mfa" | "none" };
  permissions: CplAdminPermissions;
  enabledModules: string[];
  roles: { role: CplAdminRole; description: string; canGrant: boolean }[];
  /** Fixed, operator-created local fixtures only; absent in hosted mode. */
  localRecipients: { identityId: string; personaKey: string; displayName: string }[];
}
export interface CplProvisionOrganizationInput {
  slug: string;
  displayName: string;
  initialOwnerIdentityId: string;
  enabledModules: string[];
  idempotencyKey: string;
}
export interface CplChangeMemberInput {
  identityId: string;
  role: CplAdminRole;
  status: CplMemberStatus;
  expectedVersion: number;
  reason: string;
  idempotencyKey: string;
}
export interface CplCreateInvitationInput {
  recipientIdentityId: string;
  role: Exclude<CplAdminRole, "owner">;
  expiresInMinutes?: number;
  idempotencyKey: string;
}
export interface CplInvitationChangeInput {
  invitationId: string;
  expectedVersion: number;
  reason: string;
  idempotencyKey: string;
}
export interface CplInvitationIssueResult {
  invitation: CplAdminInvitation;
  /** Returned once, never stored or included in ordinary list/audit responses.
   * A repeated request returns null; deliberate reissue creates a new token. */
  token: string | null;
  delivery: "not_sent";
}
export class CplAdminInputError extends Error {
  readonly code = "CPL_ADMIN_INVALID_INPUT";
  constructor() {
    super("CPL_ADMIN_INVALID_INPUT");
    this.name = "CplAdminInputError";
  }
}
export function cplAdminObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CplAdminInputError();
  return value as Record<string, unknown>;
}
export function cplAdminText(value: unknown, maximum = 240, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  )
    throw new CplAdminInputError();
  const text = value.trim();
  if (!allowEmpty && !text) throw new CplAdminInputError();
  return text;
}
export function cplAdminId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  )
    throw new CplAdminInputError();
  return value.toLowerCase();
}
export function cplAdminVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 2147483646)
    throw new CplAdminInputError();
  return Number(value);
}
export function cplAdminKey(value: unknown): string {
  const key = cplAdminText(value, 120);
  if (!/^[A-Za-z0-9_-]{8,120}$/u.test(key)) throw new CplAdminInputError();
  return key;
}
export function cplAdminRole(value: unknown): CplAdminRole {
  if (!CPL_ADMIN_ROLES.includes(value as CplAdminRole)) throw new CplAdminInputError();
  return value as CplAdminRole;
}
export function normalizeCplMemberChange(value: unknown): CplChangeMemberInput {
  const v = cplAdminObject(value);
  if (!["active", "suspended", "removed"].includes(String(v.status)))
    throw new CplAdminInputError();
  return {
    identityId: cplAdminId(v.identityId),
    role: cplAdminRole(v.role),
    status: v.status as CplMemberStatus,
    expectedVersion: cplAdminVersion(v.expectedVersion),
    reason: cplAdminText(v.reason, 2000),
    idempotencyKey: cplAdminKey(v.idempotencyKey),
  };
}
