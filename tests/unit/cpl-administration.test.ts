import { describe, expect, it } from "vitest";
import {
  cplAdminId,
  cplAdminKey,
  cplAdminVersion,
  normalizeCplMemberChange,
  CPL_ADMIN_ROLE_DESCRIPTIONS,
} from "../../packages/domain/src/cpl-admin";
import {
  CPL_LOCAL_PERSONAS,
  cplLocalPersona,
} from "../../packages/security/src/local-development-personas";
import { cplTenantRoleAllows } from "../../packages/database/src/tenant-repository";
describe("bounded company administration contracts", () => {
  it("normalizes reasons and rejects fabricated roles, IDs, versions and keys", () => {
    const input = {
      identityId: "d294d0d8-abcb-44ea-a07e-273bd7257e92",
      role: "member",
      status: "active",
      expectedVersion: 1,
      reason: " Deliberate\nreactivation ",
      idempotencyKey: "member-change-1",
    };
    expect(normalizeCplMemberChange(input).reason).toBe("Deliberate\nreactivation");
    for (const extra of [
      { role: "platform-admin" },
      { status: "deleted" },
      { identityId: "../other" },
      { expectedVersion: 0 },
      { reason: "" },
      { reason: "secret\u0000" },
      { idempotencyKey: "x" },
    ])
      expect(() => normalizeCplMemberChange({ ...input, ...extra })).toThrow();
    expect(() => cplAdminVersion(Number.MAX_SAFE_INTEGER)).toThrow();
    expect(() => cplAdminKey("a?token=123")).toThrow();
    expect(cplAdminId(input.identityId.toUpperCase())).toBe(input.identityId);
  });
  it("keeps fixed local personas distinct from browser role claims", () => {
    expect(CPL_LOCAL_PERSONAS.filter((p) => p.platformOperator).map((p) => p.key)).toEqual([
      "platform-operator",
    ]);
    expect(cplLocalPersona("legacy-owner")?.subject).toBe("local-owner");
    expect(cplLocalPersona({ role: "owner" })).toBeNull();
    expect(cplLocalPersona("attacker")).toBeNull();
    expect(new Set(CPL_LOCAL_PERSONAS.map((p) => p.subject)).size).toBe(CPL_LOCAL_PERSONAS.length);
    expect(CPL_LOCAL_PERSONAS.every((p) => p.email.endsWith("@cpl.invalid"))).toBe(true);
  });
  it("separates company administration, directory access and field permissions", () => {
    expect(cplTenantRoleAllows("owner", "members:manage")).toBe(true);
    expect(cplTenantRoleAllows("admin", "company:configure")).toBe(true);
    expect(cplTenantRoleAllows("manager", "company:configure")).toBe(false);
    expect(cplTenantRoleAllows("member", "directory:read")).toBe(true);
    expect(cplTenantRoleAllows("reviewer", "directory:read")).toBe(false);
    expect(cplTenantRoleAllows("field-user", "directory:read")).toBe(false);
    expect(cplTenantRoleAllows("field-user", "audit:read")).toBe(false);
    expect(cplTenantRoleAllows("field-user", "field:write")).toBe(true);
    expect(Object.values(CPL_ADMIN_ROLE_DESCRIPTIONS).every((s) => s.length > 30)).toBe(true);
  });
});
