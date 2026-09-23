import {
  createGuardedDriver,
  exactKeys,
  LIMITS,
  TransportError,
} from "./guarded-session-driver.mjs";
export const DEADLINE_SQL =
  "SELECT (extract(epoch FROM set_config('statement_timeout','15000ms',true)::interval)*1000)::integer AS statement_timeout_ms, (extract(epoch FROM set_config('idle_in_transaction_session_timeout','15000ms',true)::interval)*1000)::integer AS idle_timeout_ms";
export const READ_SQL = "SELECT cpl_session_http.read_v1($1::text,$2::timestamptz) AS result";
export const PASSKEY_SQL =
  "SELECT cpl_session_http.read_with_passkey_v1($1::text,$2::timestamptz) AS result";
const sessionKeys = [
  "id",
  "identityId",
  "issuer",
  "subject",
  "email",
  "displayName",
  "createdAt",
  "authenticatedAt",
  "expiresAt",
  "absoluteExpiresAt",
  "mfaVerifiedAt",
  "selectedOrganizationId",
  "csrfTokenHash",
  "platformAdministrator",
];
const uuid = (value) =>
  typeof value === "string" && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const refuse = (outcome = "NOT_SENT") => {
  throw new TransportError("CPL_NEON_SESSION_CONTRACT_REFUSED", outcome);
};
function iso(value) {
  if (typeof value !== "string" || value.length > 40 || !Number.isFinite(Date.parse(value)))
    refuse("UNKNOWN");
  return new Date(value).toISOString();
}
function session(value) {
  if (
    !exactKeys(value, sessionKeys) ||
    !uuid(value.id) ||
    !uuid(value.identityId) ||
    (value.selectedOrganizationId !== null && !uuid(value.selectedOrganizationId)) ||
    typeof value.platformAdministrator !== "boolean" ||
    typeof value.csrfTokenHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.csrfTokenHash)
  )
    refuse("UNKNOWN");
  // Persisted TEXT columns have no matching length constraints. The transport's
  // total response byte limit bounds decoding without inventing DTO field caps.
  for (const key of ["issuer", "subject", "email", "displayName"])
    if (typeof value[key] !== "string") refuse("UNKNOWN");
  const result = Object.fromEntries(sessionKeys.map((key) => [key, value[key]]));
  for (const key of ["createdAt", "authenticatedAt", "expiresAt", "absoluteExpiresAt"])
    result[key] = iso(value[key]);
  result.mfaVerifiedAt = value.mfaVerifiedAt === null ? null : iso(value.mfaVerifiedAt);
  return Object.freeze(result);
}
export function mapSessionResult(withPasskey, results) {
  if (
    !Array.isArray(results) ||
    results.length !== 2 ||
    results.some(
      (row) =>
        !row ||
        row.command !== "SELECT" ||
        row.rowCount !== 1 ||
        !Array.isArray(row.rows) ||
        row.rows.length !== 1,
    )
  )
    refuse("UNKNOWN");
  const deadlines = results[0].rows[0];
  if (
    !exactKeys(deadlines, ["statement_timeout_ms", "idle_timeout_ms"]) ||
    deadlines.statement_timeout_ms !== 15000 ||
    deadlines.idle_timeout_ms !== 15000 ||
    !exactKeys(results[1].rows[0], ["result"])
  )
    refuse("UNKNOWN");
  const result = results[1].rows[0].result;
  if (result === null) return null;
  if (!withPasskey) return session(result);
  if (!exactKeys(result, ["session", "hasPasskey"]) || typeof result.hasPasskey !== "boolean")
    refuse("UNKNOWN");
  return Object.freeze({
    session: session(result.session),
    hasPasskey: result.hasPasskey,
  });
}
export function sessionReadTransport(value) {
  if (value === undefined || value === "hyperdrive") return "hyperdrive";
  if (value === "neon-http") return "neon-http";
  refuse();
}
/** One immutable SDK facade per isolate/configuration. No connected DB pool or authorization result is cached. */
export function createSessionTransport(configuration) {
  if (configuration?.policy?.role !== "cpl_web_runtime") refuse();
  const driver = createGuardedDriver(configuration);
  return Object.freeze({
    invocation({ timeoutMs = LIMITS.timeoutMs } = {}) {
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > LIMITS.timeoutMs) refuse();
      let state = "new",
        tokenHash,
        closed = false,
        requests = 0;
      const read = async (withPasskey, hash, now) => {
        if (
          closed ||
          (withPasskey ? state !== "first-complete" || hash !== tokenHash : state !== "new") ||
          typeof hash !== "string" ||
          !/^[a-f0-9]{64}$/.test(hash) ||
          typeof now !== "string" ||
          !Number.isFinite(Date.parse(now)) ||
          new Date(now).toISOString() !== now
        )
          refuse();
        state = "pending";
        tokenHash = hash;
        if (++requests > 2) refuse();
        try {
          const results = await driver.transaction(
            [
              { query: DEADLINE_SQL, params: [] },
              {
                query: withPasskey ? PASSKEY_SQL : READ_SQL,
                params: [hash, now],
              },
            ],
            { timeoutMs },
          );
          if (closed) refuse("UNKNOWN");
          const value = mapSessionResult(withPasskey, results);
          state = withPasskey || value === null ? "done" : "first-complete";
          return value;
        } catch (error) {
          state = "failed";
          throw error;
        }
      };
      return Object.freeze({
        readSession: (hash, now) => read(false, hash, now),
        readSessionWithPasskey: (hash, now) => read(true, hash, now),
        close() {
          closed = true;
          state = "closed";
        },
        status: () => Object.freeze({ state, requests }),
      });
    },
  });
}
