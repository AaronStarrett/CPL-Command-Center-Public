import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { PgSqlDatabaseAdapter } from "../../packages/database/src/pg-sql-adapter";
import { migrateDatabase, verifyMigrations } from "../../packages/database/src/migrations";
import {
  configureHostedRuntimeRole,
  verifyHostedDatabaseRole,
} from "../../packages/database/src/hosted-database-role";

const material = process.env.CPL_HOSTED_POSTGRES_TEST_CONFIG_JSON;
const configPath = process.env.CPL_HOSTED_POSTGRES_TEST_CONFIG;
(material || configPath ? it : it.skip)(
  "company migration creates forced tenant tables without altering historical directory rows",
  async () => {
    const config = JSON.parse(material ?? readFileSync(configPath!, "utf8"));
    for (const value of [config.adminUrl, config.webUrl])
      if (!["127.0.0.1", "localhost"].includes(new URL(value).hostname))
        throw Error("Local isolated PostgreSQL only");
    const name = `cpl_company_schema_test_${randomBytes(6).toString("hex")}`;
    const control = new PgSqlDatabaseAdapter({ connectionString: config.adminUrl, max: 1 });
    let admin: PgSqlDatabaseAdapter | undefined,
      web: PgSqlDatabaseAdapter | undefined,
      created = false;
    const connection = (raw: string) => {
      const url = new URL(raw);
      url.pathname = `/${name}`;
      return url.href;
    };
    try {
      await control.execute(`CREATE DATABASE "${name}"`);
      created = true;
      admin = new PgSqlDatabaseAdapter({ connectionString: connection(config.adminUrl), max: 1 });
      await migrateDatabase(admin);
      await verifyMigrations(admin);
      await configureHostedRuntimeRole(admin, new URL(config.webUrl).username, "web");
      web = new PgSqlDatabaseAdapter({ connectionString: connection(config.webUrl), max: 1 });
      await verifyHostedDatabaseRole(web, "web");
      const protections = await admin.query<{ count: number; protected: boolean }>(
        "SELECT count(*)::integer AS count,bool_and(relrowsecurity AND relforcerowsecurity) AS protected FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN('cpl_catalog_items','cpl_catalog_versions','cpl_directory_current','cpl_directory_versions','cpl_company_setting_versions','cpl_company_mutations')",
      );
      expect(protections.rows[0]).toEqual({ count: 6, protected: true });
      expect((await web.query("SELECT * FROM cpl_catalog_items")).rows).toEqual([]);
      expect((await web.query("SELECT * FROM cpl_directory_current")).rows).toEqual([]);
      const triggers = await admin.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM pg_trigger WHERE NOT tgisinternal AND tgname='immutable_record' AND tgrelid IN('cpl_catalog_versions'::regclass,'cpl_directory_versions'::regclass,'cpl_company_setting_versions'::regclass,'cpl_company_mutations'::regclass)",
      );
      expect(triggers.rows[0]?.count).toBe(4);
    } finally {
      await web?.close();
      await admin?.close();
      if (created) await control.execute(`DROP DATABASE "${name}" WITH(FORCE)`);
      await control.close();
    }
  },
  180000,
);
