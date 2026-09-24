import { describe, expect, it, vi } from "vitest";
import {
  readLocalDevelopmentSchemaExpectation,
  verifyLocalDevelopmentEntryReadiness,
} from "../../packages/database/src/cpl-local-entry-readiness";
import type { DatabaseAdapter } from "../../packages/database/src/adapter";

const expected = [{ id: "0037_cpl_company_configuration.sql", checksum: "a".repeat(64) }];
const columns: Record<string, string[]> = {
  cpl_identities: ["id", "issuer", "subject", "email", "email_verified", "hosted_domain", "status"],
  cpl_sessions: [
    "id",
    "identity_id",
    "token_hash",
    "authenticated_at",
    "mfa_verified",
    "expires_at",
    "csrf_token_hash",
    "absolute_expires_at",
    "mfa_verified_at",
    "revoked_at",
    "selected_organization_id",
    "created_at",
  ],
  cpl_auth_audit_events: ["id", "identity_id", "session_id", "action"],
  cpl_auth_rate_limits: ["key_hash", "count", "expires_at"],
  cpl_platform_administrators: ["identity_id", "status"],
};
const personas = [
  { subject: "local-owner-alpha", email: "local-owner-alpha@cpl.invalid", platform_status: null },
  { subject: "local-owner-beta", email: "local-owner-beta@cpl.invalid", platform_status: null },
];
function database(
  options: {
    ledger?: unknown[];
    omitColumn?: string;
    privileges?: boolean;
    identities?: unknown[];
    unavailable?: boolean;
    errorCode?: string;
  } = {},
) {
  const query = vi.fn(async (sql: string) => {
    expect(sql).toMatch(/^SELECT /u);
    if (options.errorCode)
      throw Object.assign(new Error("private SQL message"), { code: options.errorCode });
    if (options.unavailable)
      throw Object.assign(new Error("private SQL message"), { code: "08006" });
    if (sql.includes("bea_schema_migrations")) return { rows: options.ledger ?? expected };
    if (sql.includes("pg_attribute"))
      return {
        rows: Object.entries(columns).flatMap(([table_name, names]) =>
          names
            .filter((column_name) => column_name !== options.omitColumn)
            .map((column_name) => ({ table_name, column_name })),
        ),
      };
    if (sql.includes("has_table_privilege"))
      return { rows: [{ allowed: options.privileges ?? true }] };
    return { rows: options.identities ?? personas };
  });
  return { kind: "postgres", query } as unknown as DatabaseAdapter;
}
describe("local entry readiness without side effects", () => {
  it("validates exact ordered server migration metadata and rejects absent/partial structure", () => {
    expect(
      readLocalDevelopmentSchemaExpectation({
        CPL_LOCAL_SCHEMA_MANIFEST: JSON.stringify(expected),
      }),
    ).toEqual(expected);
    for (const raw of [
      undefined,
      "[]",
      JSON.stringify([...expected, ...expected]),
      JSON.stringify([{ ...expected[0], extra: true }]),
    ])
      expect(() =>
        readLocalDevelopmentSchemaExpectation({ CPL_LOCAL_SCHEMA_MANIFEST: raw }),
      ).toThrow("CPL_LOCAL_SCHEMA_EXPECTATION_MISSING");
  });
  it("checks schema, privileges and selectable persona tuples through SELECT only", async () => {
    const db = database();
    const result = await verifyLocalDevelopmentEntryReadiness(db, expected);
    expect(result).toEqual({
      ready: true,
      code: "CPL_LOCAL_ENTRY_READY",
      schemaHead: expected[0]!.id,
      personaKeys: ["owner-alpha", "owner-beta"],
    });
    expect(db.query).toHaveBeenCalledTimes(4);
  });
  it.each([
    { ledger: [] },
    { ledger: [{ ...expected[0], checksum: "b".repeat(64) }] },
    { ledger: [...expected, { id: "0038_unexpected.sql", checksum: "c".repeat(64) }] },
  ])("refuses migration drift before trying a session prerequisite", async ({ ledger }) => {
    const db = database({ ledger });
    expect((await verifyLocalDevelopmentEntryReadiness(db, expected)).code).toBe(
      "CPL_LOCAL_SCHEMA_NOT_READY",
    );
    expect(db.query).toHaveBeenCalledTimes(1);
  });
  it("detects a missing session column and missing mutation privilege independently", async () => {
    expect(
      (
        await verifyLocalDevelopmentEntryReadiness(
          database({ omitColumn: "csrf_token_hash" }),
          expected,
        )
      ).code,
    ).toBe("CPL_LOCAL_SCHEMA_NOT_READY");
    expect(
      (await verifyLocalDevelopmentEntryReadiness(database({ privileges: false }), expected)).code,
    ).toBe("CPL_LOCAL_SESSION_PREREQUISITES_UNAVAILABLE");
  });
  it("one unavailable persona does not prevent other valid personas from entering", async () => {
    const db = database({ identities: personas.slice(1) });
    expect((await verifyLocalDevelopmentEntryReadiness(db, expected)).ready).toBe(true);
    expect(
      (await verifyLocalDevelopmentEntryReadiness(db, expected, { personaKey: "owner-alpha" }))
        .code,
    ).toBe("CPL_LOCAL_PERSONA_UNAVAILABLE");
  });
  it("does not advertise mismatched or unexpectedly privileged synthetic personas", async () => {
    const identities = [
      { ...personas[0], email: "someone@example.invalid" },
      { ...personas[1], platform_status: "active" },
    ];
    expect(
      (await verifyLocalDevelopmentEntryReadiness(database({ identities }), expected)).ready,
    ).toBe(false);
  });
  it("database failures return only a fixed safe readiness code", async () => {
    const result = await verifyLocalDevelopmentEntryReadiness(
      database({ unavailable: true }),
      expected,
    );
    expect(result).toEqual({
      ready: false,
      code: "CPL_LOCAL_DATABASE_UNAVAILABLE",
      schemaHead: null,
      personaKeys: [],
    });
    expect(JSON.stringify(result)).not.toMatch(/SQL|08006/u);
  });
  it.each([
    ["42P01", "CPL_LOCAL_SCHEMA_NOT_READY"],
    ["42703", "CPL_LOCAL_SCHEMA_NOT_READY"],
    ["42501", "CPL_LOCAL_SESSION_PREREQUISITES_UNAVAILABLE"],
  ])("identifies missing schema or grants from safe SQLSTATE %s", async (errorCode, code) => {
    const result = await verifyLocalDevelopmentEntryReadiness(database({ errorCode }), expected);
    expect(result).toEqual({ ready: false, code, schemaHead: null, personaKeys: [] });
    expect(JSON.stringify(result)).not.toContain("private");
  });
});
