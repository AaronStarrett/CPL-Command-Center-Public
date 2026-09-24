import { CPL_LOCAL_PERSONAS, type CplLocalPersonaKey } from "@bea/security/hosted";
import type { DatabaseAdapter } from "./adapter.js";

export type CplLocalSchemaExpectation = readonly { id: string; checksum: string }[];
export type CplLocalEntryReadiness = {
  ready: boolean;
  code: string;
  schemaHead: string | null;
  personaKeys: CplLocalPersonaKey[];
};
export function readLocalDevelopmentSchemaExpectation(
  source: Readonly<Record<string, string | undefined>> = process.env,
): CplLocalSchemaExpectation {
  try {
    const raw = source.CPL_LOCAL_SCHEMA_MANIFEST;
    if (!raw || raw.length > 32_768) throw new Error();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.length || parsed.length > 200) throw new Error();
    let previous = "";
    for (const value of parsed) {
      if (
        !value ||
        typeof value !== "object" ||
        Object.keys(value).sort().join(",") !== "checksum,id" ||
        typeof value.id !== "string" ||
        !/^[0-9]{4}_[a-z0-9_]+\.sql$/u.test(value.id) ||
        value.id <= previous ||
        typeof value.checksum !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value.checksum)
      )
        throw new Error();
      previous = value.id;
    }
    return parsed as CplLocalSchemaExpectation;
  } catch {
    throw new Error("CPL_LOCAL_SCHEMA_EXPECTATION_MISSING");
  }
}

const requiredColumns: Record<string, string[]> = {
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
const requiredPrivileges: Record<string, string[]> = {
  bea_schema_migrations: ["SELECT"],
  cpl_identities: ["SELECT"],
  cpl_sessions: ["SELECT", "INSERT", "UPDATE"],
  cpl_auth_audit_events: ["INSERT"],
  cpl_auth_rate_limits: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  cpl_platform_administrators: ["SELECT"],
};

/** SELECT-only prerequisite check, after the strict local role/marker guard.
 * Never issues a session, grants membership, invents MFA or mutates a fixture.
 * A served sign-in page is insufficient; these SQL prerequisites must match the
 * exact migration manifest supplied by the normal verified local launcher. */
export async function verifyLocalDevelopmentEntryReadiness(
  database: DatabaseAdapter,
  expectedMigrationIdsAndChecksums: CplLocalSchemaExpectation,
  options: { personaKey?: CplLocalPersonaKey } = {},
): Promise<CplLocalEntryReadiness> {
  const unavailable = (code: string, schemaHead: string | null = null): CplLocalEntryReadiness => ({
    ready: false,
    code,
    schemaHead,
    personaKeys: [],
  });
  try {
    const expected = readLocalDevelopmentSchemaExpectation({
      CPL_LOCAL_SCHEMA_MANIFEST: JSON.stringify(expectedMigrationIdsAndChecksums),
    });
    if (database.kind !== "postgres") return unavailable("CPL_LOCAL_DATABASE_UNAVAILABLE");
    const actual = await database.query<{ id: string; checksum: string }>(
      "SELECT id,checksum FROM bea_schema_migrations ORDER BY id",
    );
    if (
      actual.rows.length !== expected.length ||
      expected.some(
        (row, index) =>
          actual.rows[index]?.id !== row.id || actual.rows[index]?.checksum !== row.checksum,
      )
    )
      return unavailable("CPL_LOCAL_SCHEMA_NOT_READY");
    const schemaHead = expected.at(-1)!.id;
    const columns = await database.query<{ table_name: string; column_name: string }>(
      "SELECT c.relname AS table_name,a.attname AS column_name FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND a.attnum>0 AND NOT a.attisdropped",
      [Object.keys(requiredColumns)],
    );
    if (
      Object.entries(requiredColumns).some(([table, names]) =>
        names.some(
          (name) =>
            !columns.rows.some((row) => row.table_name === table && row.column_name === name),
        ),
      )
    )
      return unavailable("CPL_LOCAL_SCHEMA_NOT_READY", schemaHead);
    const wanted = Object.entries(requiredPrivileges).flatMap(([table_name, privileges]) =>
      privileges.map((privilege) => ({ table_name, privilege })),
    );
    const privileges = await database.query<{ allowed: boolean }>(
      "SELECT bool_and(has_table_privilege(current_user,format('public.%I',r.table_name),r.privilege)) AS allowed FROM jsonb_to_recordset($1::jsonb) AS r(table_name text,privilege text)",
      [JSON.stringify(wanted)],
    );
    if (privileges.rows[0]?.allowed !== true)
      return unavailable("CPL_LOCAL_SESSION_PREREQUISITES_UNAVAILABLE", schemaHead);
    const identities = await database.query<{
      subject: string;
      email: string;
      platform_status: string | null;
    }>(
      "SELECT i.subject,i.email,p.status AS platform_status FROM cpl_identities i LEFT JOIN cpl_platform_administrators p ON p.identity_id=i.id WHERE i.issuer='https://local.cpl.invalid' AND i.status='active' AND i.email_verified=TRUE AND i.hosted_domain IS NULL",
    );
    const personaKeys = CPL_LOCAL_PERSONAS.filter((persona) =>
      identities.rows.some(
        (row) =>
          row.subject === persona.subject &&
          row.email === persona.email &&
          (persona.platformOperator
            ? row.platform_status === "active"
            : persona.key === "legacy-owner" || row.platform_status === null),
      ),
    ).map((persona) => persona.key);
    if (!personaKeys.length || (options.personaKey && !personaKeys.includes(options.personaKey)))
      return unavailable("CPL_LOCAL_PERSONA_UNAVAILABLE", schemaHead);
    return { ready: true, code: "CPL_LOCAL_ENTRY_READY", schemaHead, personaKeys };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    return unavailable(
      code === "42P01" || code === "42703"
        ? "CPL_LOCAL_SCHEMA_NOT_READY"
        : code === "42501"
          ? "CPL_LOCAL_SESSION_PREREQUISITES_UNAVAILABLE"
          : "CPL_LOCAL_DATABASE_UNAVAILABLE",
    );
  }
}
