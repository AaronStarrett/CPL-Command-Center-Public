import { randomUUID } from "node:crypto";
import { PgSqlDatabaseAdapter } from "../packages/database/src/pg-sql-adapter.js";
import {
  migrateDatabase,
  verifyMigrations,
  loadMigrations,
} from "../packages/database/src/migrations.js";
import {
  configureCplAutomationWorker,
  configureCplIngestionWorker,
  configureHostedRuntimeRole,
  verifyHostedDatabaseRole,
} from "../packages/database/src/hosted-database-role.js";
import { processHostedJobs } from "../packages/database/src/hosted-workflow.js";
import { CPL_MODULE_KEYS } from "../packages/database/src/tenant-repository.js";
import { CPL_LOCAL_PERSONAS } from "../packages/security/src/local-development-personas.js";
import { createCplIntegrationRuntime } from "../packages/database/src/cpl-integration-runtime.js";
import type { CplIntegrationRepositoryOptions } from "../packages/database/src/cpl-integration-ports.js";

type Connections = {
  operatorUrl: string;
  bootstrapUrl: string;
  webUrl: string;
  workerUrl: string;
  expectedDataDirectory: string;
};
function connect(value: string, role: string, name = "cpl_local_development") {
  const url = new URL(value);
  if (
    url.protocol !== "postgresql:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "55433" ||
    url.pathname !== "/" + name ||
    url.username !== role ||
    !/^[a-f0-9]{64}$/u.test(url.password) ||
    url.search ||
    url.hash
  )
    throw new Error("CPL_LOCAL_DATABASE_TARGET_REFUSED");
  return new PgSqlDatabaseAdapter({
    connectionString: value,
    ssl: false,
    max: 2,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
  });
}

/** Operator-only local bootstrap. Never imported by the web app or Worker. */
export async function prepareDevelopmentRuntime(
  connections: Connections,
  integrationEnvironment: Readonly<Record<string, string | undefined>> = {},
) {
  const bootstrap = connect(connections.bootstrapUrl, "cpl_local_operator", "postgres");
  try {
    const settings = (
      await bootstrap.query<{ listen: string; port: string; directory: string }>(
        "SELECT current_setting('listen_addresses') AS listen,current_setting('port') AS port,current_setting('data_directory') AS directory",
      )
    ).rows[0];
    if (
      !settings ||
      settings.listen !== "127.0.0.1" ||
      settings.port !== "55433" ||
      settings.directory.replaceAll("\\", "/").toLowerCase() !==
        connections.expectedDataDirectory.replaceAll("\\", "/").toLowerCase()
    )
      throw new Error("CPL_LOCAL_CLUSTER_BOUNDARY_REFUSED");
    const target = await bootstrap.query(
      "SELECT datname FROM pg_database WHERE datname='cpl_local_development'",
    );
    if (!target.rows.length) await bootstrap.execute("CREATE DATABASE cpl_local_development");
  } finally {
    await bootstrap.close();
  }
  const admin = connect(connections.operatorUrl, "cpl_local_operator");
  const web = connect(connections.webUrl, "cpl_local_web");
  const worker = connect(connections.workerUrl, "cpl_local_worker");
  let ready = false;
  let ingestion: CplIntegrationRepositoryOptions = { providerMode: "disabled" };
  let expectedSchema: { id: string; checksum: string }[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;
  let stopPromise: Promise<void> | undefined;
  try {
    await migrateDatabase(admin);
    await verifyMigrations(admin);
    expectedSchema = (await loadMigrations()).map(({ id, checksum }) => ({ id, checksum }));
    for (const [role, purpose, value] of [
      ["cpl_local_web", "web", connections.webUrl],
      ["cpl_local_worker", "worker", connections.workerUrl],
    ] as const) {
      if (!(await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rows.length) {
        const password = new URL(value).password;
        await admin.execute(
          `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
        );
      }
      await configureHostedRuntimeRole(admin, role, purpose);
    }
    // The local runner explicitly opts into tenant recipe jobs after baseline
    // grants. Hosted HTTP workers retain their existing capability boundary.
    await configureCplAutomationWorker(admin, "cpl_local_worker");
    await configureCplIngestionWorker(admin, "cpl_local_worker");
    await admin.execute(
      "CREATE TABLE IF NOT EXISTS cpl_local_development_marker(singleton BOOLEAN PRIMARY KEY CHECK(singleton), purpose TEXT NOT NULL CHECK(purpose='local-development')); INSERT INTO cpl_local_development_marker VALUES(TRUE,'local-development') ON CONFLICT DO NOTHING; REVOKE ALL ON cpl_local_development_marker FROM PUBLIC; GRANT SELECT ON cpl_local_development_marker TO cpl_local_web,cpl_local_worker;",
    );
    await admin.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO cpl_identities(id,issuer,subject,display_name,email,email_verified,hosted_domain) VALUES($1,'https://local.cpl.invalid','local-owner','Local development owner','local-owner@cpl.invalid',TRUE,NULL) ON CONFLICT(issuer,subject) DO NOTHING",
        [randomUUID()],
      );
      const identity = (
        await tx.query<{
          id: string;
          status: string;
          email: string;
          email_verified: boolean;
          hosted_domain: string | null;
        }>(
          "SELECT id,status,email,email_verified,hosted_domain FROM cpl_identities WHERE issuer='https://local.cpl.invalid' AND subject='local-owner'",
        )
      ).rows[0]!;
      if (
        identity.status !== "active" ||
        identity.email !== "local-owner@cpl.invalid" ||
        !identity.email_verified ||
        identity.hosted_domain !== null
      )
        throw new Error("CPL_LOCAL_FIXTURE_REFUSED");
      await tx.query(
        "INSERT INTO cpl_platform_administrators(identity_id,status) VALUES($1,'active') ON CONFLICT DO NOTHING",
        [identity.id],
      );
      if (
        !(
          await tx.query(
            "SELECT identity_id FROM cpl_platform_administrators WHERE identity_id=$1 AND status='active'",
            [identity.id],
          )
        ).rows.length
      )
        throw new Error("CPL_LOCAL_FIXTURE_SUSPENDED");
      // Fixed local identities are operator-created after the exact cluster/role
      // checks above. This never enrolls a real provider user or grants company
      // membership. Existing statuses and profile data are deliberately retained.
      for (const persona of CPL_LOCAL_PERSONAS) {
        if (persona.key === "legacy-owner") continue;
        const inserted = await tx.query<{ id: string }>(
          "INSERT INTO cpl_identities(id,issuer,subject,display_name,email,email_verified,hosted_domain) VALUES($1,'https://local.cpl.invalid',$2,$3,$4,TRUE,NULL) ON CONFLICT(issuer,subject) DO NOTHING RETURNING id",
          [randomUUID(), persona.subject, persona.label, persona.email],
        );
        const fixture = (
          await tx.query<{
            id: string;
            email: string;
            email_verified: boolean;
            hosted_domain: string | null;
          }>(
            "SELECT id,email,email_verified,hosted_domain FROM cpl_identities WHERE issuer='https://local.cpl.invalid' AND subject=$1",
            [persona.subject],
          )
        ).rows[0];
        if (
          !fixture ||
          fixture.email !== persona.email ||
          !fixture.email_verified ||
          fixture.hosted_domain !== null
        )
          throw new Error("CPL_LOCAL_FIXTURE_REFUSED");
        if (inserted.rows.length)
          await tx.query(
            "INSERT INTO cpl_auth_audit_events(id,identity_id,action) VALUES($1,$2,'local-development.synthetic-identity-created')",
            [randomUUID(), fixture.id],
          );
        if (persona.platformOperator) {
          const granted = await tx.query(
            "INSERT INTO cpl_platform_administrators(identity_id,status) VALUES($1,'active') ON CONFLICT DO NOTHING RETURNING identity_id",
            [fixture.id],
          );
          if (granted.rows.length)
            await tx.query(
              "INSERT INTO cpl_auth_audit_events(id,identity_id,action) VALUES($1,$2,'local-development.synthetic-platform-operator-created')",
              [randomUUID(), fixture.id],
            );
        }
      }
      // Initial synthetic workspace only. Subsequent launches never reset owner edits.
      const present = await tx.query(
        "SELECT id FROM cpl_organizations WHERE slug='cpl-development'",
      );
      if (!present.rows.length) {
        const organizationId = randomUUID();
        await tx.query(
          "INSERT INTO cpl_organizations(id,slug,display_name) VALUES($1,'cpl-development','CPL Development · Synthetic')",
          [organizationId],
        );
        await tx.query(
          "INSERT INTO cpl_memberships(organization_id,identity_id,role) VALUES($1,$2,'owner')",
          [organizationId, identity.id],
        );
        for (const key of CPL_MODULE_KEYS) {
          const enabled = [
            "intake-job-tracker",
            "proposal-builder",
            "award-to-project-launcher",
            "field-report-assembler",
          ].includes(key);
          await tx.query(
            "INSERT INTO cpl_module_entitlements(organization_id,module_key,enabled,usage_limit) VALUES($1,$2,$3,$4)",
            [organizationId, key, enabled, enabled ? null : 0],
          );
        }
        await tx.query(
          "INSERT INTO cpl_tenant_audit_events(id,organization_id,actor_identity_id,action,resource_id) VALUES($1,$2,$3,'local-development.workspace-seeded',$4)",
          [randomUUID(), organizationId, identity.id, organizationId],
        );
      }
    });
    await verifyHostedDatabaseRole(web, "web");
    await verifyHostedDatabaseRole(worker, "worker");
    ingestion = await createCplIntegrationRuntime({
      database: worker,
      origin: "http://127.0.0.1:3400",
      environment: integrationEnvironment,
    });
    ready = true;
  } finally {
    await admin.close();
    await web.close();
    if (!ready) await worker.close();
  }
  let lastJobState = "idle";
  const cycle = () => {
    if (stopped) return;
    running = (async () => {
      try {
        const result = await processHostedJobs(worker, {
          claimOwner: "local-development",
          limit: 1,
          ingestion,
        });
        lastJobState = result.failed
          ? "failed"
          : result.retried
            ? "retrying"
            : result.skipped
              ? "skipped"
              : result.completed
                ? "completed"
                : "idle";
      } catch {
        lastJobState = "retrying";
      } finally {
        if (!stopped) timer = setTimeout(cycle, 2_000);
      }
    })();
  };
  return {
    expectedSchema,
    startJobs: () => {
      if (!running && !stopped) cycle();
    },
    stopJobs: () => {
      stopPromise ??= (async () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        await running;
        await worker.close();
      })();
      return stopPromise;
    },
    status: () => ({ database: "local-postgresql", synthetic: true, jobs: lastJobState }),
  };
}
