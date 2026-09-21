import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseEnvironment, type ServerEnvironment } from "../../packages/config/src/index.js";
import {
  migrateDatabase,
  PgDatabaseAdapter,
  seedSystemDatabase,
  SqlFoundationRepository,
  SqlLocalOwnerAccountStore,
  verifyMigrations,
  verifyProductionDatabase,
  verifySystemSeed,
} from "../../packages/database/src/index.js";
import { LocalOwnerAuthenticationAdapter } from "../../packages/security/src/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runProductionQueueCheck } from "../../apps/worker/src/production-queue-check";
import { runWorker } from "../../apps/worker/src/runtime";
// @ts-expect-error Repository-owned JavaScript operation modules intentionally expose runtime APIs.
import {
  resolvePostgresTools,
  postgresConnectionEnvironment,
  runPostgresTool,
} from "../../scripts/phase134/postgres-tools.mjs";
// @ts-expect-error The external-gate runner is an ESM JavaScript contract exercised here.
import { inspectRealPostgresPrerequisite } from "../../scripts/verify-phase1-3-4-real-postgres.mjs";

const businessTables = [
  "companies",
  "contacts",
  "tasks",
  "activities",
  "notifications",
  "conversations",
  "assistant_messages",
  "workspace_artifacts",
  "suggested_actions",
  "action_approvals",
  "action_executions",
  "workflow_runs",
  "workflow_step_runs",
  "generated_artifacts",
  "projects",
  "inspections",
  "inspection_reports",
] as const;

function quoteIdentifier(value: string): string {
  if (!/^bea_phase134_[a-f0-9]{24}$/u.test(value)) throw new Error("Unsafe test schema name.");
  return `"${value}"`;
}

function scopedDatabaseUrl(base: string, schema: string): string {
  const url = new URL(base);
  url.searchParams.set("options", `-csearch_path=${schema},public`);
  return url.toString();
}

function productionEnvironment(
  databaseUrl: string,
  workerHealthPort: number,
): Record<string, string> {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error("LOCALAPPDATA is required for the Local Live vault contract.");
  return {
    APP_BASE_URL: "https://bea.localhost:3443",
    APP_MODE: "production",
    BEA_AUTH_PROVIDER: "local-owner",
    BEA_DEPLOYMENT_PROFILE: "local-live",
    BEA_DISABLE_ENV_FILE: "true",
    BEA_PRODUCTION_SECRET_PATH: path.join(
      localAppData,
      "BEA",
      "CommandCenter",
      "secrets",
      "production-secrets.dpapi.json",
    ),
    BEA_RUNTIME_MODE: "production",
    DATABASE_DRIVER: "postgres",
    DATABASE_URL: databaseUrl,
    DEMO_AUTH_ENABLED: "false",
    DEMO_DATABASE_PATH: "memory://",
    LOG_LEVEL: "silent",
    NODE_ENV: "production",
    OPENAI_API_KEY: "",
    SESSION_SECRET: "phase134-real-postgres-session-secret-".padEnd(96, "x"),
    SESSION_TTL_MINUTES: "30",
    WORKER_DEMO_DATABASE_PATH: "memory://",
    WORKER_HEALTH_PORT: String(workerHealthPort),
    WORKER_MODE: "serve",
    WORKER_POLL_INTERVAL_MS: "3600000",
    WORKER_QUEUE_ADAPTER: "pg-boss",
  };
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

const realPostgresPrerequisite = inspectRealPostgresPrerequisite(process.env);
const realPostgresDescribe = realPostgresPrerequisite.ready
  ? describe.sequential
  : describe.sequential.skip;

realPostgresDescribe("Phase 1.3.4 disposable real PostgreSQL acceptance", () => {
  let baseDatabase: PgDatabaseAdapter;
  let scopedDatabase: PgDatabaseAdapter | undefined;
  let baseUrl: string;
  let scopedUrl: string;
  let schema: string;
  let pgBossExisted = false;
  let temporaryDirectory: string | undefined;

  beforeAll(async () => {
    if (!realPostgresPrerequisite.ready) return;
    baseUrl = realPostgresPrerequisite.url;
    schema = `bea_phase134_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    baseDatabase = new PgDatabaseAdapter({
      connectionString: baseUrl,
      max: 2,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 15_000,
    });
    const identity = await baseDatabase.query<{
      database_name: string;
      role_name: string;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      ssl: boolean | null;
    }>(
      `SELECT current_database() AS database_name,current_user AS role_name,
              r.rolsuper,r.rolcreatedb,r.rolcreaterole,s.ssl
       FROM pg_roles r
       LEFT JOIN pg_stat_ssl s ON s.pid=pg_backend_pid()
       WHERE r.rolname=current_user`,
    );
    const row = identity.rows[0];
    expect(row?.database_name).toBe(realPostgresPrerequisite.database);
    expect(row?.rolsuper).toBe(false);
    expect(row?.rolcreatedb).toBe(false);
    expect(row?.rolcreaterole).toBe(false);
    const tlsMode = process.env.BEA_PHASE134_REAL_POSTGRES_TLS_MODE ?? "prefer";
    if (tlsMode === "require" || tlsMode === "verify-full") expect(row?.ssl).toBe(true);
    const pgboss = await baseDatabase.query<{ exists: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='pgboss') AS exists",
    );
    pgBossExisted = pgboss.rows[0]?.exists === true;
    if (pgBossExisted) {
      throw new Error(
        "The disposable database already contains a pgboss schema; isolation refused.",
      );
    }
    await baseDatabase.execute(
      `CREATE SCHEMA ${quoteIdentifier(schema)} AUTHORIZATION CURRENT_USER`,
    );
    scopedUrl = scopedDatabaseUrl(baseUrl, schema);
    scopedDatabase = new PgDatabaseAdapter({
      connectionString: scopedUrl,
      max: 4,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 20_000,
    });
  }, 30_000);

  afterAll(async () => {
    await scopedDatabase?.close().catch(() => undefined);
    if (baseDatabase) {
      await baseDatabase
        .execute(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`)
        .catch(() => undefined);
      if (!pgBossExisted) {
        await baseDatabase.execute('DROP SCHEMA IF EXISTS "pgboss" CASCADE').catch(() => undefined);
      }
      await baseDatabase.close().catch(() => undefined);
    }
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }, 30_000);

  it("verifies migrations, system-only data, Local Owner sessions/audit, pg-boss, worker restart, backup, restore, and cleanup scope", async () => {
    if (!scopedDatabase) throw new Error("The isolated PostgreSQL adapter is unavailable.");
    const firstMigration = await migrateDatabase(scopedDatabase);
    expect(firstMigration.applied).not.toHaveLength(0);
    const secondMigration = await migrateDatabase(scopedDatabase);
    expect(secondMigration.applied).toEqual([]);
    expect(secondMigration.alreadyApplied).toHaveLength(firstMigration.applied.length);
    await expect(verifyMigrations(scopedDatabase)).resolves.toMatchObject({
      current: "0026_cpl_hosted_workflow.sql",
    });

    const firstSeed = await seedSystemDatabase(scopedDatabase);
    const secondSeed = await seedSystemDatabase(scopedDatabase);
    expect(firstSeed.applied).toBe(true);
    expect(secondSeed.applied).toBe(false);
    await expect(verifySystemSeed(scopedDatabase)).resolves.toMatchObject({ verified: true });
    for (const table of businessTables) {
      const count = await scopedDatabase.query<{ count: string | number }>(
        `SELECT COUNT(*) AS count FROM ${quoteIdentifier(schema)}."${table}"`,
      );
      expect(Number(count.rows[0]?.count ?? -1), `${table} must stay empty`).toBe(0);
    }

    const repository = new SqlFoundationRepository(scopedDatabase);
    const accounts = new SqlLocalOwnerAccountStore(scopedDatabase);
    const authentication = new LocalOwnerAuthenticationAdapter(
      {
        deploymentProfile: "local-live",
        sessionSecret: "phase134-real-postgres-session-secret-".padEnd(96, "x"),
        sessionTtlMinutes: 30,
      },
      repository,
      accounts,
      repository,
    );
    const provisioned = await authentication.provisionOwner(
      "Owner",
      "Phase 1.3.4 disposable database passphrase only",
      "phase134-real-postgres-provision",
    );
    const signedIn = await authentication.signIn(
      "Owner",
      "Phase 1.3.4 disposable database passphrase only",
      "phase134-real-postgres-sign-in",
    );
    await expect(authentication.readSession(signedIn.sessionToken)).resolves.toMatchObject({
      user: { id: provisioned.userId, displayName: "Workspace Owner" },
    });
    await expect(
      authentication.recoverOwner(
        "Owner",
        provisioned.recoveryCode,
        "Phase 1.3.4 disposable recovered passphrase only",
        "phase134-real-postgres-recovery",
      ),
    ).resolves.toMatchObject({ recoveryCode: expect.stringMatching(/^bea-recovery-/u) });
    await expect(authentication.readSession(signedIn.sessionToken)).resolves.toBeNull();
    const recoveredSignIn = await authentication.signIn(
      "Owner",
      "Phase 1.3.4 disposable recovered passphrase only",
      "phase134-real-postgres-recovered-sign-in",
    );
    await expect(
      authentication.signOut(recoveredSignIn.sessionToken, "phase134-real-postgres-sign-out"),
    ).resolves.toBe(true);
    const audit = await scopedDatabase.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM audit_logs
         WHERE event_type IN ('authentication.local-owner-provisioned','authentication.signed-in',
                              'authentication.recovered','authentication.signed-out')`,
    );
    expect(Number(audit.rows[0]?.count ?? 0)).toBeGreaterThanOrEqual(5);

    const initialPort = await availablePort();
    const rawEnvironment = productionEnvironment(scopedUrl, initialPort);
    const environment: ServerEnvironment = parseEnvironment(rawEnvironment);
    await expect(verifyProductionDatabase(scopedDatabase, environment)).resolves.toMatchObject({
      ownerReady: true,
      demoUsers: 0,
      demoIntegrations: 0,
    });

    await scopedDatabase.close();
    scopedDatabase = undefined;
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), "bea-phase134-pg-"));
    const archive = path.join(temporaryDirectory, "phase134.dump");
    const tlsMode = process.env.BEA_PHASE134_REAL_POSTGRES_TLS_MODE ?? "prefer";
    const tools = resolvePostgresTools({
      database: {
        toolsDirectory: process.env.BEA_PHASE134_POSTGRES_TOOLS_DIRECTORY || null,
      },
    });
    const connectionEnvironment = postgresConnectionEnvironment(baseUrl, tlsMode, process.env);
    const dumped = runPostgresTool(
      tools.pgDump,
      [
        "--format=custom",
        "--compress=9",
        "--no-owner",
        "--no-privileges",
        `--schema=${schema}`,
        "--file",
        archive,
      ],
      connectionEnvironment,
      { cwd: temporaryDirectory },
    );
    expect(dumped.exitCode).toBe(0);
    const archiveStat = await stat(archive);
    expect(archiveStat.size).toBeGreaterThan(0);
    const archiveDigest = createHash("sha256")
      .update(await readFile(archive))
      .digest("hex");
    expect(archiveDigest).toMatch(/^[a-f0-9]{64}$/u);

    await baseDatabase.execute(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    const restored = runPostgresTool(
      tools.pgRestore,
      [
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-privileges",
        "--exit-on-error",
        "--dbname",
        new URL(baseUrl).pathname.slice(1),
        archive,
      ],
      connectionEnvironment,
      { cwd: temporaryDirectory },
    );
    expect(restored.exitCode).toBe(0);
    expect(
      createHash("sha256")
        .update(await readFile(archive))
        .digest("hex"),
    ).toBe(archiveDigest);
    scopedDatabase = new PgDatabaseAdapter(scopedUrl);
    await expect(verifyProductionDatabase(scopedDatabase, environment)).resolves.toMatchObject({
      ownerReady: true,
      demoUsers: 0,
    });

    const queueFirst = await runProductionQueueCheck(rawEnvironment);
    const queueSecond = await runProductionQueueCheck(rawEnvironment);
    expect(queueFirst).toMatchObject({
      healthJobCompleted: true,
      idempotencyVerified: true,
      retryVerified: true,
      failedJobVerified: true,
      gracefulShutdownVerified: true,
    });
    expect(queueSecond.gracefulShutdownVerified).toBe(true);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const workerEnvironment = productionEnvironment(scopedUrl, await availablePort());
      const worker = await runWorker([], workerEnvironment);
      expect(worker).toMatchObject({ mode: "serve", status: "serving" });
      if (worker.mode !== "serve") throw new Error("Production worker did not enter serve mode.");
      const health = await fetch(`http://127.0.0.1:${String(worker.healthPort)}/health`);
      expect(health.ok).toBe(true);
      await worker.close();
    }
  }, 180_000);
});
