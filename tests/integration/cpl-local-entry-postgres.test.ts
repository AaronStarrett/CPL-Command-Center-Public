import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgSqlDatabaseAdapter } from "../../packages/database/src/pg-sql-adapter";
import { loadMigrations, migrateDatabase } from "../../packages/database/src/migrations";
import {
  configureHostedRuntimeRole,
  verifyHostedDatabaseRole,
} from "../../packages/database/src/hosted-database-role";
import {
  verifyLocalDevelopmentEntryReadiness,
  type CplLocalSchemaExpectation,
} from "../../packages/database/src/cpl-local-entry-readiness";

const material = process.env.CPL_HOSTED_POSTGRES_TEST_CONFIG_JSON;
const configPath = process.env.CPL_HOSTED_POSTGRES_TEST_CONFIG;
(material || configPath ? describe : describe.skip)(
  "entry readiness on real restricted PostgreSQL",
  () => {
    const name = "cpl_entry_test_" + randomBytes(6).toString("hex");
    let control: PgSqlDatabaseAdapter, admin: PgSqlDatabaseAdapter, web: PgSqlDatabaseAdapter;
    let expected: CplLocalSchemaExpectation,
      role: string,
      created = false;
    beforeAll(async () => {
      const config = JSON.parse(material ?? readFileSync(configPath!, "utf8"));
      for (const value of [config.adminUrl, config.webUrl])
        if (!["127.0.0.1", "localhost"].includes(new URL(value).hostname))
          throw new Error("Local isolated PostgreSQL only");
      role = new URL(config.webUrl).username;
      if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(role)) throw new Error("Test role refused");
      const connection = (value: string) => {
        const url = new URL(value);
        url.pathname = "/" + name;
        return url.href;
      };
      control = new PgSqlDatabaseAdapter({ connectionString: config.adminUrl, max: 1 });
      await control.execute(`CREATE DATABASE "${name}"`);
      created = true;
      admin = new PgSqlDatabaseAdapter({ connectionString: connection(config.adminUrl), max: 1 });
      await migrateDatabase(admin);
      await configureHostedRuntimeRole(admin, role, "web");
      web = new PgSqlDatabaseAdapter({ connectionString: connection(config.webUrl), max: 1 });
      await verifyHostedDatabaseRole(web, "web");
      expected = (await loadMigrations()).map(({ id, checksum }) => ({ id, checksum }));
      for (const suffix of ["alpha", "beta"])
        await admin.query(
          "INSERT INTO cpl_identities(id,issuer,subject,display_name,email,email_verified,hosted_domain) VALUES($1,'https://local.cpl.invalid',$2,$3,$4,TRUE,NULL)",
          [
            randomUUID(),
            "local-owner-" + suffix,
            "Readiness fixture " + suffix,
            "local-owner-" + suffix + "@cpl.invalid",
          ],
        );
    }, 180_000);
    afterAll(async () => {
      await web?.close();
      await admin?.close();
      if (created) await control.execute(`DROP DATABASE "${name}" WITH(FORCE)`);
      await control?.close();
    }, 60_000);
    it("verifies the actual ledger/auth columns/privileges without creating sessions or audit rows", async () => {
      const before = await admin.query(
        "SELECT (SELECT count(*) FROM cpl_sessions) AS sessions,(SELECT count(*) FROM cpl_auth_audit_events) AS events",
      );
      const result = await verifyLocalDevelopmentEntryReadiness(web, expected, {
        personaKey: "owner-alpha",
      });
      expect(result).toEqual({
        ready: true,
        code: "CPL_LOCAL_ENTRY_READY",
        schemaHead: expected.at(-1)!.id,
        personaKeys: ["owner-alpha", "owner-beta"],
      });
      const after = await admin.query(
        "SELECT (SELECT count(*) FROM cpl_sessions) AS sessions,(SELECT count(*) FROM cpl_auth_audit_events) AS events",
      );
      expect(after.rows).toEqual(before.rows);
      await expect(
        web.query("UPDATE bea_schema_migrations SET checksum=checksum"),
      ).rejects.toMatchObject({ code: "42501" });
    });
    it("detects real ledger corruption instead of accepting a responsive database", async () => {
      const head = expected.at(-1)!;
      await admin.query("UPDATE bea_schema_migrations SET checksum=$2 WHERE id=$1", [
        head.id,
        "0".repeat(64),
      ]);
      try {
        expect((await verifyLocalDevelopmentEntryReadiness(web, expected)).code).toBe(
          "CPL_LOCAL_SCHEMA_NOT_READY",
        );
      } finally {
        await admin.query("UPDATE bea_schema_migrations SET checksum=$2 WHERE id=$1", [
          head.id,
          head.checksum,
        ]);
      }
    });
    it("detects a revoked INSERT privilege even while SELECT and the ledger work", async () => {
      await admin.execute(`REVOKE INSERT ON cpl_sessions FROM "${role}"`);
      try {
        expect((await verifyLocalDevelopmentEntryReadiness(web, expected)).code).toBe(
          "CPL_LOCAL_SESSION_PREREQUISITES_UNAVAILABLE",
        );
      } finally {
        await admin.execute(`GRANT INSERT ON cpl_sessions TO "${role}"`);
      }
    });
    it("a suspended selection is refused without disabling an unrelated valid persona", async () => {
      await admin.query(
        "UPDATE cpl_identities SET status='suspended' WHERE issuer='https://local.cpl.invalid' AND subject='local-owner-alpha'",
      );
      try {
        expect(
          (await verifyLocalDevelopmentEntryReadiness(web, expected, { personaKey: "owner-alpha" }))
            .code,
        ).toBe("CPL_LOCAL_PERSONA_UNAVAILABLE");
        expect(
          (await verifyLocalDevelopmentEntryReadiness(web, expected, { personaKey: "owner-beta" }))
            .ready,
        ).toBe(true);
      } finally {
        await admin.query(
          "UPDATE cpl_identities SET status='active' WHERE issuer='https://local.cpl.invalid' AND subject='local-owner-alpha'",
        );
      }
    });
  },
);
