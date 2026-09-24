import { afterEach, describe, expect, it } from "vitest";
import { parseEnvironment } from "../../packages/config/src/index.js";
import {
  type DatabaseAdapter,
  PGliteDatabaseAdapter,
  type SqlExecutor,
  SqlFoundationRepository,
  SqlLocalOwnerAccountStore,
  SYSTEM_SEED_ID,
  migrateDatabase,
  seedSystemDatabase,
  verifyEmptyProductionBootstrap,
  verifyMigrations,
  verifyNoProductionBusinessRecords,
  verifyProductionDatabase,
  verifySystemSeed,
} from "../../packages/database/src/index.js";
import { LocalOwnerAuthenticationAdapter } from "../../packages/security/src/index.js";
import { FixedClock } from "../../packages/testing/src/index.js";

let database: PGliteDatabaseAdapter | undefined;

class PostgreSqlVerificationView implements DatabaseAdapter {
  readonly kind = "postgres" as const;

  constructor(private readonly delegate: DatabaseAdapter) {}

  query<Row extends Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []) {
    return this.delegate.query<Row>(sql, parameters);
  }

  execute(sql: string): Promise<void> {
    return this.delegate.execute(sql);
  }

  transaction<T>(operation: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
    return this.delegate.transaction(operation);
  }

  health() {
    return this.delegate.health();
  }

  async close(): Promise<void> {
    // The owning test closes the delegated database.
  }
}

const localLiveEnvironment = parseEnvironment({
  NODE_ENV: "production",
  APP_MODE: "production",
  BEA_RUNTIME_MODE: "production",
  BEA_DEPLOYMENT_PROFILE: "local-live",
  BEA_AUTH_PROVIDER: "local-owner",
  APP_BASE_URL: "https://bea.localhost:3443",
  DATABASE_DRIVER: "postgres",
  DATABASE_URL: "postgresql://bea.invalid/command_center",
  DEMO_AUTH_ENABLED: "false",
  SESSION_SECRET: "phase134-production-verification-secret-".padEnd(80, "x"),
  WORKER_MODE: "serve",
  WORKER_QUEUE_ADAPTER: "pg-boss",
  WORKER_HEALTH_PORT: "3001",
});

afterEach(async () => {
  await database?.close();
  database = undefined;
});

describe("Phase 1.3.4 production system seed", () => {
  it("is versioned, idempotent, verifiable, and excludes Demo or business records", async () => {
    database = new PGliteDatabaseAdapter("memory://");
    await migrateDatabase(database);

    await expect(verifyMigrations(database)).resolves.toMatchObject({
      current: "0039_cpl_durable_inbound.sql",
    });
    await expect(seedSystemDatabase(database)).resolves.toMatchObject({
      id: SYSTEM_SEED_ID,
      applied: true,
      roles: 5,
      featureFlags: 7,
      workflowDefinitions: 1,
      integrations: 1,
    });
    await expect(seedSystemDatabase(database)).resolves.toMatchObject({
      id: SYSTEM_SEED_ID,
      applied: false,
    });
    await expect(verifySystemSeed(database)).resolves.toMatchObject({
      id: SYSTEM_SEED_ID,
      verified: true,
    });
    await expect(verifyEmptyProductionBootstrap(database)).resolves.toEqual({
      verified: true,
      businessRecordCount: 0,
    });
    await database.query(
      `UPDATE system_settings
       SET value_json=jsonb_set(value_json,'{defaultTextModel}','"gpt-owner-selected"'::jsonb)
       WHERE key='ai.provider.settings'`,
    );
    await database.query(
      `UPDATE integration_connections
       SET connection_status='connected',requirement_status='CONNECTED',configuration_completeness=100
       WHERE provider_type='ai'`,
    );
    await expect(verifySystemSeed(database)).resolves.toMatchObject({ verified: true });

    const counts = await database.query<{
      users: string | number;
      companies: string | number;
      integrations: string | number;
      workflows: string | number;
      demo_mode: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM users) AS users,
         (SELECT COUNT(*) FROM companies) AS companies,
         (SELECT COUNT(*) FROM integration_connections) AS integrations,
         (SELECT COUNT(*) FROM workflow_definitions) AS workflows,
         (SELECT value_json::text FROM system_settings WHERE key='runtime.demo-mode') AS demo_mode`,
    );
    expect(counts.rows[0]).toEqual({
      users: 0,
      companies: 0,
      integrations: 1,
      workflows: 1,
      demo_mode: "false",
    });
  });

  it("fails closed when a seeded system value drifts", async () => {
    database = new PGliteDatabaseAdapter("memory://");
    await migrateDatabase(database);
    await seedSystemDatabase(database);
    await database.query(
      "UPDATE system_settings SET value_json='true'::jsonb WHERE key='runtime.demo-mode'",
    );
    await expect(verifySystemSeed(database)).rejects.toThrow(
      "Production system setting runtime.demo-mode is missing or changed.",
    );
  });

  it("rejects identity state before bootstrap and requires one exact Owner and OpenAI row after setup", async () => {
    database = new PGliteDatabaseAdapter("memory://");
    await migrateDatabase(database);
    await seedSystemDatabase(database);
    const occurredAt = "2026-08-24T12:00:00.000Z";
    const unexpectedUserId = "70000000-0000-4000-8000-000000000001";
    await database.query(
      `INSERT INTO users
       (id,persona_key,email,display_name,title,status,created_at,updated_at,version)
       VALUES ($1,NULL,'unexpected@example.invalid','Unexpected','User','active',$2,$2,1)`,
      [unexpectedUserId, occurredAt],
    );
    await database.query(
      `INSERT INTO auth_identities
       (id,user_id,provider,subject,created_at,updated_at,version)
       VALUES ('70000000-0000-4000-8000-000000000002',$1,'microsoft-entra','unexpected',$2,$2,1)`,
      [unexpectedUserId, occurredAt],
    );
    await database.query(
      `INSERT INTO sessions
       (id,user_id,token_hash,expires_at,revoked_at,last_seen_at,created_at,updated_at,version)
       VALUES ('70000000-0000-4000-8000-000000000003',$1,'unexpected-session-token-hash',
               '2026-08-24T13:00:00.000Z',NULL,$2,$2,$2,1)`,
      [unexpectedUserId, occurredAt],
    );
    await expect(verifyEmptyProductionBootstrap(database)).rejects.toThrow(
      "Production bootstrap found pre-existing identity or session records.",
    );
    await database.query("DELETE FROM users WHERE id=$1", [unexpectedUserId]);
    await expect(verifyEmptyProductionBootstrap(database)).resolves.toEqual({
      verified: true,
      businessRecordCount: 0,
    });

    const repository = new SqlFoundationRepository(database);
    const authentication = new LocalOwnerAuthenticationAdapter(
      {
        deploymentProfile: "local-live",
        sessionSecret: localLiveEnvironment.sessionSecret,
        sessionTtlMinutes: 60,
      },
      repository,
      new SqlLocalOwnerAccountStore(database),
      repository,
      new FixedClock(occurredAt),
    );
    const provisioned = await authentication.provisionOwner(
      "andrew.owner",
      "Production verification passphrase 2026!",
    );
    const productionDatabase = new PostgreSqlVerificationView(database);
    await expect(verifyNoProductionBusinessRecords(productionDatabase)).resolves.toEqual({
      verified: true,
      businessRecordCount: 0,
    });
    await expect(
      verifyProductionDatabase(productionDatabase, localLiveEnvironment),
    ).resolves.toMatchObject({
      ownerProvider: "local-owner",
      ownerReady: true,
      demoUsers: 0,
      demoIntegrations: 0,
    });

    await database.query(
      `INSERT INTO auth_identities
       (id,user_id,provider,subject,created_at,updated_at,version)
       VALUES ('70000000-0000-4000-8000-000000000004',$1,'microsoft-entra','unexpected-owner',$2,$2,1)`,
      [provisioned.userId, occurredAt],
    );
    await expect(
      verifyProductionDatabase(productionDatabase, localLiveEnvironment),
    ).rejects.toThrow("no unexpected users or providers");
    await database.query(
      "DELETE FROM auth_identities WHERE id='70000000-0000-4000-8000-000000000004'",
    );

    await database.query(
      `INSERT INTO users
       (id,persona_key,email,display_name,title,status,created_at,updated_at,version)
       VALUES ($1,NULL,'extra@example.invalid','Extra','User','active',$2,$2,1)`,
      [unexpectedUserId, occurredAt],
    );
    await expect(
      verifyProductionDatabase(productionDatabase, localLiveEnvironment),
    ).rejects.toThrow("no unexpected users or providers");
    await database.query("DELETE FROM users WHERE id=$1", [unexpectedUserId]);

    await database.query(
      `INSERT INTO integration_connections
       (id,provider_type,display_name,mode,connection_status,requirement_status,
        configuration_completeness,required_permissions,test_mode,mock_mode,created_at,updated_at,version)
       VALUES ('70000000-0000-4000-8000-000000000005','crm','Unexpected CRM','live',
               'not-configured','BLOCKED',0,'[]'::jsonb,FALSE,FALSE,$1,$1,1)`,
      [occurredAt],
    );
    await expect(
      verifyProductionDatabase(productionDatabase, localLiveEnvironment),
    ).rejects.toThrow("only the system OpenAI connection");
    await database.query("DELETE FROM integration_connections WHERE provider_type='crm'");

    await database.query(
      `INSERT INTO companies (id,name,status,created_at,updated_at,version)
       VALUES ('70000000-0000-4000-8000-000000000006','Unexpected Company','prospect',$1,$1,1)`,
      [occurredAt],
    );
    await expect(
      verifyProductionDatabase(productionDatabase, localLiveEnvironment),
    ).rejects.toThrow("pre-existing business or assistant records");
  }, 60_000);
});
