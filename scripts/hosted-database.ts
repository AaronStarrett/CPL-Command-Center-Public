/** Explicit operator-only provisioning. The application never imports or invokes
 * migrations. Supply credentials through the process environment, never arguments. */
import { PgDatabaseAdapter } from "../packages/database/src/pg-adapter.js";
import { migrateDatabase, verifyMigrations } from "../packages/database/src/migrations.js";
import {
  configureHostedRuntimeRole,
  verifyHostedDatabaseRole,
} from "../packages/database/src/hosted-database-role.js";
import { assertRepositoryBoundary } from "./repository-boundary.mjs";

function connection(value: string | undefined) {
  if (!value) throw new Error("CPL_DATABASE_OPERATOR_SECRET_MISSING");
  const url = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.password ||
    !url.username ||
    !url.hostname ||
    !url.pathname.slice(1)
  )
    throw new Error("CPL_DATABASE_OPERATOR_SECRET_INVALID");
  for (const key of url.searchParams.keys()) {
    if (key.toLowerCase().startsWith("ssl") || key.toLowerCase() === "uselibpqcompat")
      url.searchParams.delete(key);
  }
  return {
    url,
    configuration: {
      connectionString: url.toString(),
      ssl: { rejectUnauthorized: true },
      max: 1,
      connectionTimeoutMillis: 15_000,
      query_timeout: 60_000,
      statement_timeout: 55_000,
    },
  };
}
async function main() {
  assertRepositoryBoundary();
  if (process.argv[2] !== "provision-empty")
    throw new Error("CPL_DATABASE_OPERATOR_EXPLICIT_COMMAND_REQUIRED");
  const migrator = connection(process.env.CPL_MIGRATION_DATABASE_URL);
  const runtime = connection(process.env.CPL_WEB_DATABASE_URL);
  const scheduler = connection(process.env.CPL_WORKER_DATABASE_URL);
  for (const supplied of [runtime, scheduler]) {
    if (
      supplied.url.hostname !== migrator.url.hostname ||
      supplied.url.port !== migrator.url.port ||
      supplied.url.pathname !== migrator.url.pathname
    )
      throw new Error("CPL_DATABASE_OPERATOR_TARGET_MISMATCH");
  }
  if (runtime.url.username !== "cpl_web_runtime" || scheduler.url.username !== "cpl_worker_runtime")
    throw new Error("CPL_DATABASE_OPERATOR_ROLE_MISMATCH");
  const admin = new PgDatabaseAdapter(migrator.configuration);
  let web: PgDatabaseAdapter | undefined, worker: PgDatabaseAdapter | undefined;
  try {
    const current = await admin.query<{ name: string }>(
      "SELECT tablename AS name FROM pg_tables WHERE schemaname='public'",
    );
    // A resumable run may contain only our migration chain and empty application data.
    if (current.rows.length && !current.rows.some((row) => row.name === "bea_schema_migrations"))
      throw new Error("CPL_DATABASE_OPERATOR_NOT_EMPTY");
    if (current.rows.length) {
      for (const table of [
        "cpl_identities",
        "cpl_organizations",
        "cpl_workflow_leads",
        "cpl_proposal_drafts",
        "leads",
      ]) {
        if (
          current.rows.some((row) => row.name === table) &&
          Number(
            (await admin.query<{ count: string }>(`SELECT count(*) FROM ${table}`)).rows[0]?.count,
          ) !== 0
        )
          throw new Error("CPL_DATABASE_OPERATOR_NOT_EMPTY");
      }
    }
    const migrations = await migrateDatabase(admin);
    for (const [supplied, purpose] of [
      [runtime, "web"],
      [scheduler, "worker"],
    ] as const) {
      const name = supplied.url.username;
      const present = await admin.query("SELECT rolname FROM pg_roles WHERE rolname=$1", [name]);
      if (!present.rows.length) {
        const password = decodeURIComponent(supplied.url.password);
        if (!/^[a-f0-9]{64}$/u.test(password))
          throw new Error("CPL_DATABASE_OPERATOR_GENERATED_PASSWORD_REQUIRED");
        await admin.execute(
          `CREATE ROLE "${name}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
        );
      }
      await configureHostedRuntimeRole(admin, name, purpose);
    }
    web = new PgDatabaseAdapter(runtime.configuration);
    worker = new PgDatabaseAdapter(scheduler.configuration);
    await verifyHostedDatabaseRole(web, "web");
    await verifyHostedDatabaseRole(worker, "worker");
    const state = await verifyMigrations(admin);
    const counts: Record<string, number> = {};
    for (const table of [
      "cpl_identities",
      "cpl_organizations",
      "cpl_memberships",
      "cpl_workflow_leads",
      "cpl_proposal_drafts",
      "cpl_workflow_jobs",
      "cpl_platform_owner_binding",
      "leads",
    ])
      counts[table] = Number(
        (await admin.query<{ count: string }>(`SELECT count(*) FROM ${table}`)).rows[0]?.count,
      );
    if (Object.values(counts).some(Boolean)) throw new Error("CPL_DATABASE_OPERATOR_NOT_EMPTY");
    process.stdout.write(
      JSON.stringify({
        status: "PASS",
        action: "hosted-empty-database-provisioned",
        version: (await admin.query<{ server_version: string }>("SHOW server_version")).rows[0]
          ?.server_version,
        migration: state.current,
        applied: migrations.applied.length,
        roles: {
          web: "NOSUPERUSER NOBYPASSRLS non-owner",
          worker: "NOSUPERUSER NOBYPASSRLS non-owner distinct login",
        },
        emptyRecordCounts: counts,
      }) + "\n",
    );
  } finally {
    await Promise.all([web?.close(), worker?.close(), admin.close()]);
  }
}
main().catch(() => {
  process.stderr.write(
    JSON.stringify({
      status: "FAIL",
      code: "CPL_HOSTED_DATABASE_PROVISIONING_FAILED",
      detail:
        "Connection and SQL details withheld. Credentials remain private; investigate using the operator connection.",
    }) + "\n",
  );
  process.exitCode = 1;
});
