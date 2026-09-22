import { describe, expect, it } from "vitest";
import type {
  DatabaseAdapter,
  DatabaseResult,
  SqlExecutor,
} from "../../packages/database/src/adapter";
import { SqlCplHostedAuthStore } from "../../packages/database/src/hosted-auth-store";
import { verifyHostedDatabaseRole } from "../../packages/database/src/hosted-database-role";
import { withHyperdriveDeadlines } from "../../packages/database/src/hosted-connection";
import { withHostedWebRoleGuard } from "../../packages/database/src/hosted-web-role-guard";

const identityId = "11111111-1111-4111-8111-111111111111";
const tokenHash = "a".repeat(64);
const now = "2026-09-22T20:00:00.000Z";
function fixture(selected: boolean, passkey: unknown = false) {
  const commands: { sql: string; parameters: readonly unknown[] }[] = [];
  const executor: SqlExecutor = {
    async query<Row extends Record<string, unknown>>(
      sql: string,
      parameters: readonly unknown[] = [],
    ): Promise<DatabaseResult<Row>> {
      commands.push({ sql, parameters });
      let rows: Record<string, unknown>[] = [];
      if (sql.includes("WITH RECURSIVE inherited"))
        rows = [
          {
            rolname: "cpl_web_runtime",
            purpose: "web",
            tenant_tables_protected: true,
            ...Object.fromEntries(
              [
                "rolsuper",
                "rolbypassrls",
                "rolcreatedb",
                "rolcreaterole",
                "rolreplication",
                "owns_database",
                "owns_schema",
                "owns_application_tables",
                "schema_create",
                "elevated_membership",
                "can_change_role_registry",
                "can_read_legacy_leads",
              ].map((key) => [key, false]),
            ),
          },
        ];
      else if (sql.includes("set_config('statement_timeout'"))
        rows = [{ statement_timeout_ms: 15000, idle_timeout_ms: 15000 }];
      else if (sql.includes("SELECT s.*"))
        rows = [
          {
            id: "22222222-2222-4222-8222-222222222222",
            identity_id: identityId,
            issuer: "https://accounts.google.com",
            subject: "synthetic",
            email: "synthetic@example.invalid",
            display_name: "Synthetic",
            created_at: now,
            authenticated_at: now,
            expires_at: "2026-09-22T21:00:00.000Z",
            absolute_expires_at: "2026-09-23T04:00:00.000Z",
            mfa_verified_at: null,
            selected_organization_id: selected ? "33333333-3333-4333-8333-333333333333" : null,
            csrf_token_hash: "b".repeat(64),
            platform_administrator: false,
          },
        ];
      else if (sql.includes("SELECT m.identity_id")) rows = [{ identity_id: identityId }];
      else if (sql.includes("AS has_passkey")) rows = [{ has_passkey: passkey }];
      return { rows: rows as Row[], rowCount: rows.length };
    },
    async execute(sql) {
      await executor.query(sql);
    },
  };
  const base: DatabaseAdapter = {
    kind: "postgres",
    ...executor,
    async transaction(operation) {
      await executor.query("BEGIN");
      try {
        const result = await operation(executor);
        await executor.query("COMMIT");
        return result;
      } catch (error) {
        await executor.query("ROLLBACK");
        throw error;
      }
    },
    async close() {},
    async health() {
      return { status: "healthy", adapter: "postgres", checkedAt: now, latencyMs: 0 };
    },
  };
  return { base, commands };
}
describe("source-level valid session SQL and pg frontend message counts", () => {
  it.each([null, "true", 1, {}])(
    "indeterminate credential existence rolls back instead of coercing %j",
    async (value) => {
      const f = fixture(false, value);
      const store = new SqlCplHostedAuthStore(f.base);
      await expect(store.readSessionWithPasskey(tokenHash, now)).rejects.toThrow(
        "CPL_AUTHENTICATION_REQUIRED",
      );
      expect(f.commands.at(-1)?.sql).toBe("ROLLBACK");
      expect(f.commands.some((command) => command.sql === "COMMIT")).toBe(false);
    },
  );
  it.each([
    { transport: "hyperdrive", selected: false, before: [16, 28], after: [10, 22] },
    { transport: "hyperdrive", selected: true, before: [20, 48], after: [14, 42] },
    { transport: "direct", selected: false, before: [8, 20], after: [8, 20] },
    { transport: "direct", selected: true, before: [12, 40], after: [12, 40] },
  ])("$transport selected=$selected retains auth work with bounded counts", async (scenario) => {
    for (const candidate of [false, true]) {
      const f = fixture(scenario.selected);
      const transport =
        scenario.transport === "hyperdrive" ? withHyperdriveDeadlines(f.base, "web") : f.base;
      const database =
        candidate && scenario.transport === "hyperdrive"
          ? withHostedWebRoleGuard(transport)
          : transport;
      if (!candidate || scenario.transport === "direct")
        await verifyHostedDatabaseRole(database, "web");
      const store = new SqlCplHostedAuthStore(database);
      expect(await store.readSession(tokenHash, now)).not.toBeNull();
      if (candidate)
        expect((await store.readSessionWithPasskey(tokenHash, now))?.hasPasskey).toBe(false);
      else {
        const session = await store.readSession(tokenHash, now);
        await store.listCredentials(session!.identityId);
      }
      // Pinned pg uses one Q frame without values; parameterized unnamed SELECT
      // uses Parse/Bind/Describe/Execute/Sync. These are source-inferred message
      // counts, not network packet counts, CPU timings, or hosted acceptance.
      expect([
        f.commands.length,
        f.commands.reduce((total, command) => total + (command.parameters.length ? 5 : 1), 0),
      ]).toEqual(candidate ? scenario.after : scenario.before);
      expect(
        f.commands.filter((command) => command.sql.includes("WITH RECURSIVE inherited")),
      ).toHaveLength(1);
      expect(f.commands.filter((command) => command.sql.includes("SELECT s.*"))).toHaveLength(2);
      expect(
        f.commands.filter((command) => command.sql.includes("SELECT m.identity_id")),
      ).toHaveLength(scenario.selected ? 2 : 0);
      if (candidate) {
        const credentials = f.commands.find((command) => command.sql.includes("AS has_passkey"));
        expect(credentials?.parameters).toEqual([identityId]);
        expect(credentials?.sql).toContain("i.status='active'");
        expect(f.commands.some((command) => command.sql.includes("SELECT c.*"))).toBe(false);
      }
    }
  });
});
