import { randomUUID } from "node:crypto";
import { PgDatabaseAdapter } from "../../packages/database/src/pg-adapter.ts";
import { processHostedJobs } from "../../packages/database/src/hosted-workflow.ts";

export const HOSTED_JOB_LIMIT = 1;

export function workerDatabaseConnectionString(value) {
  try {
    if (typeof value !== "string" || value.length > 8192) throw new Error();
    const database = new URL(value);
    if (
      !["postgres:", "postgresql:"].includes(database.protocol) ||
      !database.hostname ||
      !database.username ||
      !database.password ||
      [...database.searchParams.keys()].some(
        (key) =>
          (key.toLowerCase().startsWith("ssl") && key !== "sslmode") ||
          key.toLowerCase() === "uselibpqcompat",
      ) ||
      (database.searchParams.has("sslmode") &&
        !["require", "verify-full"].includes(database.searchParams.get("sslmode")))
    )
      throw new Error();
    // URL SSL options can replace pg's Pool.ssl. Keep certificate verification
    // explicit and never load local certificate files in a hosted invocation.
    database.searchParams.delete("sslmode");
    return database.toString();
  } catch {
    throw new Error("CPL_WORKER_DATABASE_UNCONFIGURED");
  }
}

/** One invocation owns one short-lived connection pool. Its dedicated role has
 * only the narrowly reviewed job policies, never superuser/BYPASSRLS rights. */
export function createHostedScheduledHandler({
  createDatabase = (configuration) => new PgDatabaseAdapter(configuration),
  processJobs = processHostedJobs,
  claimId = randomUUID,
  logger = console,
} = {}) {
  return async function scheduled(_controller, environment) {
    const connectionString = workerDatabaseConnectionString(environment.CPL_WORKER_DATABASE_URL);
    let database;
    let result;
    let failure;
    try {
      database = createDatabase({
        connectionString,
        ssl: { rejectUnauthorized: true },
        max: 1,
        connectionTimeoutMillis: 5_000,
        query_timeout: 5_000,
        statement_timeout: 4_000,
        idleTimeoutMillis: 1_000,
        allowExitOnIdle: true,
      });
      result = await processJobs(database, {
        claimOwner: `cloudflare:${claimId()}`,
        limit: HOSTED_JOB_LIMIT,
      });
      logger.info({
        code: "CPL_HOSTED_JOBS_COMPLETE",
        claimed: result.claimed,
        completed: result.completed,
        retried: result.retried,
        failed: result.failed,
      });
    } catch {
      // Cloudflare records an invocation failure; durable lease/retry state is
      // owned by PostgreSQL. Never expose connection strings or job contents.
      logger.error({ code: "CPL_HOSTED_JOBS_FAILED" });
      failure = new Error("CPL_HOSTED_JOBS_FAILED");
    } finally {
      try {
        await database?.close();
      } catch {
        logger.error({ code: "CPL_HOSTED_JOBS_CONNECTION_CLOSE_FAILED" });
        failure ??= new Error("CPL_HOSTED_JOBS_CONNECTION_CLOSE_FAILED");
      }
    }
    if (failure) throw failure;
    return result;
  };
}
