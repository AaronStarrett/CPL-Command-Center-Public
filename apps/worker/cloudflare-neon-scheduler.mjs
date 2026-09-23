import { randomUUID } from "node:crypto";
import { createJobsTransport } from "./cloudflare-neon-jobs.mjs";

// Review and database catalog acceptance must bind this exact migration before activation.
export const JOBS_HTTP_CONTRACT =
  "530371055b3db1562bbec76bf245e0c5eb26da8ab643db466b4fa7671bcb5560";
export const HOSTED_HTTP_JOB_LIMIT = 1;
function configuration(environment) {
  if (
    environment.CPL_JOBS_TRANSPORT !== "neon-http" ||
    environment.CPL_JOBS_HTTP_CONTRACT !== JOBS_HTTP_CONTRACT ||
    environment.CPL_WEB_DB !== undefined ||
    typeof environment.CPL_NEON_JOBS_HOST !== "string" ||
    typeof environment.CPL_NEON_JOBS_DATABASE !== "string" ||
    typeof environment.CPL_WORKER_DATABASE_URL !== "string"
  )
    throw new Error("CPL_HOSTED_JOBS_HTTP_CONFIGURATION_REFUSED");
  return Object.freeze({
    connectionString: environment.CPL_WORKER_DATABASE_URL,
    policy: Object.freeze({
      host: environment.CPL_NEON_JOBS_HOST,
      database: environment.CPL_NEON_JOBS_DATABASE,
      role: "cpl_worker_runtime",
    }),
  });
}

/** One SDK configuration per isolate; every invocation has its own immutable claim/lease state. */
export function createNeonHttpScheduledHandler({
  loadDriver = () => import("@neondatabase/serverless"),
  createTransport = createJobsTransport,
  fetchImplementation = (...args) => globalThis.fetch(...args),
  identifier = randomUUID,
  logger = console,
} = {}) {
  let pendingFactory, selectedConfiguration;
  const factory = (environment) => {
    const current = configuration(environment);
    if (
      selectedConfiguration &&
      (selectedConfiguration.connectionString !== current.connectionString ||
        selectedConfiguration.policy.host !== current.policy.host ||
        selectedConfiguration.policy.database !== current.policy.database)
    )
      throw new Error("CPL_HOSTED_JOBS_HTTP_CONFIGURATION_REFUSED");
    if (!pendingFactory) {
      selectedConfiguration = current;
      pendingFactory = loadDriver().then((driver) =>
        createTransport({
          driver,
          version: "1.1.0",
          ...current,
          fetchImplementation,
        }),
      );
    }
    return pendingFactory;
  };
  return async function scheduled(_controller, environment) {
    try {
      const transport = await factory(environment);
      const invocation = transport.invocation({
        owner: `cloudflare:${identifier()}`,
        leaseToken: identifier(),
      });
      const result = { claimed: 0, completed: 0, retried: 0, failed: 0 };
      const claim = await invocation.claim();
      if (claim.status !== "empty") {
        result.claimed = 1;
        if (claim.status === "exhausted") result.failed = 1;
        else {
          try {
            await invocation.process();
            result.completed = 1;
          } catch (error) {
            // No transport fallback or blind replay after uncertain commit/abort.
            if (invocation.status().state !== "retryable") throw error;
            const retry = await invocation.retry();
            if (retry.status === "failed") result.failed = 1;
            else result.retried = 1;
          }
        }
      }
      logger.info(JSON.stringify({ code: "CPL_HOSTED_JOBS_COMPLETE", ...result }));
      return result;
    } catch {
      logger.error(JSON.stringify({ code: "CPL_HOSTED_JOBS_FAILED" }));
      throw new Error("CPL_HOSTED_JOBS_FAILED");
    }
  };
}
