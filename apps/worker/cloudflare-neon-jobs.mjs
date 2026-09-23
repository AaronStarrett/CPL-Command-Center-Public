import {
  createGuardedDriver,
  exactKeys,
  LIMITS,
  TransportError,
} from "./cloudflare-neon-guard.mjs";

export const DEADLINE_SQL =
  "SELECT (extract(epoch FROM set_config('statement_timeout','4000ms',true)::interval)*1000)::integer AS statement_timeout_ms, (extract(epoch FROM set_config('idle_in_transaction_session_timeout','4000ms',true)::interval)*1000)::integer AS idle_timeout_ms";
export const STAGE_SQL = Object.freeze({
  claim: "SELECT cpl_jobs_http.claim_v1($1::text,$2::uuid) AS result",
  process: "SELECT cpl_jobs_http.process_v1($1::jsonb,$2::uuid) AS result",
  retry: "SELECT cpl_jobs_http.retry_v1($1::jsonb,$2::uuid,$3::text) AS result",
});
const claimKeys = [
  "id",
  "organizationId",
  "proposalId",
  "proposalVersion",
  "issuedByIdentityId",
  "issuedMembershipVersion",
  "attempts",
  "maxAttempts",
];
const idKeys = ["id", "organizationId", "proposalId", "issuedByIdentityId"];
const integerKeys = ["proposalVersion", "issuedMembershipVersion", "attempts", "maxAttempts"];
const retryCodes = new Set([
  "CPL_JOB_AUTHORIZATION_REVOKED",
  "CPL_RECORD_NOT_FOUND",
  "CPL_JOB_PROCESSING_FAILED",
]);
const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const refuse = (outcome = "NOT_SENT") => {
  throw new TransportError("CPL_NEON_JOBS_CONTRACT_REFUSED", outcome);
};

function validateClaim(value) {
  if (
    !exactKeys(value, claimKeys) ||
    idKeys.some((key) => !uuid(value[key])) ||
    integerKeys.some(
      (key) => !Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > 2_147_483_647,
    ) ||
    value.maxAttempts > 3 ||
    value.attempts > value.maxAttempts
  )
    refuse("UNKNOWN");
  return Object.freeze(Object.fromEntries(claimKeys.map((key) => [key, value[key]])));
}

export function mapStageResult(stage, results) {
  if (
    !Array.isArray(results) ||
    results.length !== 2 ||
    results.some(
      (result) =>
        !result ||
        result.command !== "SELECT" ||
        result.rowCount !== 1 ||
        !Array.isArray(result.rows) ||
        result.rows.length !== 1,
    )
  )
    refuse("UNKNOWN");
  const deadlines = results[0].rows[0];
  if (
    !exactKeys(deadlines, ["statement_timeout_ms", "idle_timeout_ms"]) ||
    deadlines.statement_timeout_ms !== 4000 ||
    deadlines.idle_timeout_ms !== 4000 ||
    !exactKeys(results[1].rows[0], ["result"])
  )
    refuse("UNKNOWN");
  const result = results[1].rows[0].result;
  if (stage === "claim") {
    if (exactKeys(result, ["status"]) && result.status === "empty")
      return Object.freeze({ status: "empty" });
    if (exactKeys(result, ["status", "id"]) && result.status === "exhausted" && uuid(result.id))
      return Object.freeze({ status: "exhausted", id: result.id });
    if (exactKeys(result, ["status", "claim"]) && result.status === "claimed")
      return Object.freeze({
        status: "claimed",
        claim: validateClaim(result.claim),
      });
  } else if (
    stage === "process" &&
    exactKeys(result, ["status"]) &&
    ["completed", "superseded"].includes(result.status)
  ) {
    return Object.freeze({ status: result.status });
  } else if (
    stage === "retry" &&
    exactKeys(result, ["status"]) &&
    ["queued", "failed"].includes(result.status)
  ) {
    return Object.freeze({ status: result.status });
  }
  refuse("UNKNOWN");
}

/** No interactive transaction emulation. Each explicit stage owns one committed batch.
 * SQL functions must enforce the complete role/deadline contract before application work.
 */
export function createJobsTransport(configuration) {
  const driver = createGuardedDriver(configuration);
  return Object.freeze({
    invocation({ owner, leaseToken, timeoutMs = LIMITS.timeoutMs }) {
      if (
        typeof owner !== "string" ||
        !/^[A-Za-z0-9._:-]{1,120}$/.test(owner) ||
        !uuid(leaseToken) ||
        !Number.isInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > LIMITS.timeoutMs
      )
        refuse();
      let state = "new";
      let claim;
      let retryCode;
      let requests = 0;
      const run = async (stage, params) => {
        if (++requests > LIMITS.requests) refuse();
        const results = await driver.transaction(
          [
            { query: DEADLINE_SQL, params: [] },
            { query: STAGE_SQL[stage], params },
          ],
          { timeoutMs },
        );
        return mapStageResult(stage, results);
      };
      return Object.freeze({
        async claim() {
          if (state !== "new") refuse();
          state = "claiming";
          try {
            const result = await run("claim", [owner, leaseToken]);
            claim = result.claim;
            state = result.status === "claimed" ? "claimed" : "done";
            return result;
          } catch (error) {
            state = "stopped";
            throw error;
          }
        },
        async process() {
          if (state !== "claimed") refuse();
          state = "processing";
          try {
            const result = await run("process", [JSON.stringify(claim), leaseToken]);
            state = "done";
            return result;
          } catch (error) {
            state = "stopped";
            if (
              error instanceof TransportError &&
              error.outcome === "SERVER_REPORTED_ERROR" &&
              error.sqlstate &&
              (error.databaseCode === null || retryCodes.has(error.databaseCode))
            ) {
              retryCode = error.databaseCode ?? "CPL_JOB_PROCESSING_FAILED";
              state = "retryable";
            }
            throw error;
          }
        },
        async retry() {
          if (state !== "retryable") refuse();
          state = "retrying";
          try {
            const result = await run("retry", [JSON.stringify(claim), leaseToken, retryCode]);
            state = "done";
            return result;
          } catch (error) {
            state = "stopped";
            throw error;
          }
        },
        status() {
          return Object.freeze({ state, requests });
        },
      });
    },
  });
}
