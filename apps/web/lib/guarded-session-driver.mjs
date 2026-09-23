// A caller supplies the exact origin policy, pinned SDK and bounded fetch capability.
export const DRIVER_VERSION = "1.1.0";
export const LIMITS = Object.freeze({
  requests: 2,
  requestBytes: 8192,
  responseBytes: 32768,
  frames: 128,
  timeoutMs: 20000,
});
const installed = new WeakSet();
const utf8 = new TextEncoder();
const fixedDatabaseCodes = new Set([
  "CPL_HOSTED_DATABASE_ROLE_REFUSED",
  "CPL_HYPERDRIVE_SERVER_DEADLINES_REFUSED",
  "CPL_AUTHENTICATION_REQUIRED",
]);
// Deliberately narrower than a SQLSTATE class: 40003 is completion UNKNOWN.
// These statement/transaction errors abort the fixed atomic batch; live HTTP
// rollback acceptance remains required. Cancellation and shutdown stay UNKNOWN.
const reviewedRollbackStates = new Set(["22012", "40001", "40P01"]);

export class TransportError extends Error {
  constructor(code, outcome = "NOT_SENT", databaseCode = null, sqlstate = null) {
    super(code);
    this.name = "TransportError";
    this.code = code;
    this.outcome = outcome;
    this.databaseCode = databaseCode;
    this.sqlstate = sqlstate;
  }
}
const reject = (code = "CPL_NEON_HTTP_REFUSED", outcome) => {
  throw new TransportError(code, outcome);
};
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export function exactKeys(value, keys) {
  return record(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

export function connectionPolicy(connectionString, policy) {
  try {
    if (
      !exactKeys(policy, ["host", "database", "role"]) ||
      typeof connectionString !== "string" ||
      connectionString.length > 8192 ||
      // eslint-disable-next-line no-control-regex -- Reject credential URL controls before parsing.
      /[\u0000-\u0020\u007f]/.test(connectionString)
    )
      reject();
    if (
      !/^ep-[a-z0-9-]+\.(?:[a-z0-9-]+\.)*neon\.tech$/.test(policy.host) ||
      !/^cpl_[a-z0-9_]{1,58}$/.test(policy.role) ||
      !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}$/.test(policy.database)
    )
      reject();
    const url = new URL(connectionString);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      url.hostname !== policy.host ||
      (url.port !== "" && url.port !== "5432") ||
      url.hash ||
      decodeURIComponent(url.username) !== policy.role ||
      !url.password ||
      decodeURIComponent(url.pathname) !== `/${policy.database}` ||
      [...url.searchParams.keys()].some((key) => key !== "sslmode") ||
      url.searchParams.getAll("sslmode").length !== 1 ||
      !["require", "verify-full"].includes(url.searchParams.get("sslmode"))
    )
      reject();
    // eslint-disable-next-line no-control-regex -- Reject encoded credential controls after decoding.
    if (/[\u0000-\u0020\u007f]/.test(decodeURIComponent(url.password))) reject();
    return Object.freeze({
      endpoint: `https://${policy.host.replace(/^[^.]+\./, "api.")}/sql`,
    });
  } catch {
    reject("CPL_NEON_CONNECTION_REFUSED");
  }
}

async function boundedBody(response, signal) {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > LIMITS.responseBytes))
    reject("CPL_NEON_RESPONSE_REFUSED", "UNKNOWN");
  if (
    !response.body ||
    !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")
  )
    reject("CPL_NEON_RESPONSE_REFUSED", "UNKNOWN");
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const parts = [];
  let length = 0;
  try {
    for (let frames = 0; frames < LIMITS.frames; frames += 1) {
      if (signal.aborted) reject("CPL_NEON_WAIT_ABORTED", "UNKNOWN");
      const item = await reader.read();
      if (item.done) {
        if (signal.aborted) reject("CPL_NEON_WAIT_ABORTED", "UNKNOWN");
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const part of parts) {
          bytes.set(part, offset);
          offset += part.byteLength;
        }
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      }
      if (
        !(item.value instanceof Uint8Array) ||
        (length += item.value.byteLength) > LIMITS.responseBytes
      )
        reject("CPL_NEON_RESPONSE_REFUSED", "UNKNOWN");
      parts.push(item.value);
    }
    reject("CPL_NEON_RESPONSE_REFUSED", "UNKNOWN");
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

function validateRawResults(value) {
  if (!exactKeys(value, ["results"]) || !Array.isArray(value.results) || value.results.length !== 2)
    reject("CPL_NEON_RESPONSE_REFUSED", "UNKNOWN");
  for (const result of value.results) {
    if (
      !record(result) ||
      !Array.isArray(result.rows) ||
      result.rows.length !== 1 ||
      result.rowCount !== 1 ||
      result.command !== "SELECT" ||
      !Array.isArray(result.fields) ||
      result.fields.length < 1 ||
      result.fields.length > 16 ||
      result.rows.some(
        (row) =>
          !Array.isArray(row) ||
          row.length !== result.fields.length ||
          row.some((cell) => cell !== null && typeof cell !== "string"),
      )
    )
      reject("CPL_NEON_RESPONSE_REFUSED", "UNKNOWN");
    const names = new Set();
    for (const field of result.fields) {
      if (
        !record(field) ||
        typeof field.name !== "string" ||
        !/^[a-z_]{1,64}$/.test(field.name) ||
        names.has(field.name) ||
        !Number.isSafeInteger(field.dataTypeID) ||
        field.dataTypeID <= 0
      )
        reject("CPL_NEON_RESPONSE_REFUSED", "UNKNOWN");
      names.add(field.name);
    }
  }
  return value;
}

/** Configures one exclusively owned driver module once. Each invocation gets separate capabilities.
 * Actual-driver artifact/version verification belongs to the reviewed integration launcher.
 */
export function createGuardedDriver({
  driver,
  version,
  connectionString,
  policy,
  fetchImplementation,
}) {
  const { endpoint } = connectionPolicy(connectionString, policy);
  if (
    version !== DRIVER_VERSION ||
    typeof driver?.neon !== "function" ||
    !driver.neonConfig ||
    typeof fetchImplementation !== "function" ||
    installed.has(driver.neonConfig) ||
    driver.neonConfig.fetchFunction !== undefined
  )
    reject("CPL_NEON_DRIVER_REFUSED");
  installed.add(driver.neonConfig);
  const capabilities = new WeakMap();
  const fetchEndpoint = () => endpoint;
  const guardedFetch = async (url, options) => {
    const capability = capabilities.get(options?.signal);
    if (!capability || capability.used || options.signal.aborted)
      reject("CPL_NEON_REQUEST_REFUSED");
    capability.used = true;
    let response;
    try {
      const headers = new Headers(options.headers);
      const names = [...headers.keys()].sort();
      if (
        url !== endpoint ||
        options.method !== "POST" ||
        options.redirect !== "error" ||
        options.credentials !== "omit" ||
        options.cache !== "no-store" ||
        names.join(",") !==
          "neon-array-mode,neon-batch-isolation-level,neon-batch-read-only,neon-connection-string,neon-raw-text-output" ||
        headers.get("neon-connection-string") !== connectionString ||
        headers.get("neon-array-mode") !== "true" ||
        headers.get("neon-raw-text-output") !== "true" ||
        headers.get("neon-batch-isolation-level") !== "ReadCommitted" ||
        headers.get("neon-batch-read-only") !== "true" ||
        typeof options.body !== "string" ||
        utf8.encode(options.body).byteLength > LIMITS.requestBytes ||
        options.body !== capability.body
      )
        reject("CPL_NEON_REQUEST_REFUSED");
      capability.sent = true;
      response = await fetchImplementation(endpoint, options);
      if (options.signal.aborted) reject("CPL_NEON_WAIT_ABORTED", "UNKNOWN");
      if (
        !(response instanceof Response) ||
        response.redirected ||
        (response.url && response.url !== endpoint) ||
        (response.status !== 200 && response.status !== 400)
      )
        reject("CPL_NEON_HTTP_REJECTED", "UNKNOWN");
      const body = await boundedBody(response, options.signal);
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        reject("CPL_NEON_RESPONSE_REFUSED", "UNKNOWN");
      }
      if (response.status === 400) {
        const sqlstate =
          typeof parsed?.code === "string" && /^[A-Z0-9]{5}$/.test(parsed.code)
            ? parsed.code
            : null;
        const databaseCode =
          sqlstate === "P0001" && fixedDatabaseCodes.has(parsed?.message) ? parsed.message : null;
        if (!reviewedRollbackStates.has(sqlstate) && databaseCode === null)
          reject("CPL_NEON_DATABASE_OUTCOME_UNKNOWN", "UNKNOWN");
        capability.databaseError = { sqlstate, databaseCode };
        // Strip provider details before they can become driver Error properties.
        return new Response(
          JSON.stringify({
            message: databaseCode ?? "CPL_NEON_DATABASE_REJECTED",
            code: sqlstate,
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      validateRawResults(parsed);
      capability.responseAccepted = true;
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      if (error instanceof TransportError) throw error;
      throw new TransportError(
        "CPL_NEON_TRANSPORT_FAILED",
        capability.sent ? "UNKNOWN" : "NOT_SENT",
      );
    } finally {
      if (response instanceof Response && response.body && !response.body.locked)
        void response.body.cancel().catch(() => {});
    }
  };
  driver.neonConfig.fetchFunction = guardedFetch;
  driver.neonConfig.fetchEndpoint = fetchEndpoint;

  return Object.freeze({
    async transaction(queries, { timeoutMs = LIMITS.timeoutMs } = {}) {
      if (
        !Number.isInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > LIMITS.timeoutMs ||
        driver.neonConfig.fetchFunction !== guardedFetch ||
        driver.neonConfig.fetchEndpoint !== fetchEndpoint ||
        !Array.isArray(queries) ||
        queries.length !== 2
      )
        reject("CPL_NEON_REQUEST_REFUSED");
      const controller = new AbortController();
      const capability = {
        body: JSON.stringify({ queries }),
        used: false,
        sent: false,
        responseAccepted: false,
        databaseError: null,
      };
      capabilities.set(controller.signal, capability);
      let timer;
      const stopped = new Promise((_, fail) => {
        timer = setTimeout(() => {
          controller.abort();
          fail(
            new TransportError("CPL_NEON_WAIT_ABORTED", capability.sent ? "UNKNOWN" : "NOT_SENT"),
          );
        }, timeoutMs);
      });
      try {
        const sql = driver.neon(connectionString, {
          fullResults: true,
          arrayMode: false,
        });
        const work = sql.transaction(
          queries.map(({ query, params }) => sql.query(query, params)),
          {
            isolationLevel: "ReadCommitted",
            readOnly: true,
            fullResults: true,
            arrayMode: false,
            fetchOptions: {
              signal: controller.signal,
              redirect: "error",
              credentials: "omit",
              cache: "no-store",
            },
          },
        );
        const result = await Promise.race([work, stopped]);
        if (
          !capability.used ||
          !capability.sent ||
          !capability.responseAccepted ||
          controller.signal.aborted
        )
          reject("CPL_NEON_RESPONSE_REFUSED", capability.sent ? "UNKNOWN" : "NOT_SENT");
        return result;
      } catch {
        if (controller.signal.aborted)
          throw new TransportError(
            "CPL_NEON_WAIT_ABORTED",
            capability.sent ? "UNKNOWN" : "NOT_SENT",
          );
        if (capability.databaseError) {
          throw new TransportError(
            "CPL_NEON_DATABASE_REJECTED",
            "SERVER_REPORTED_ERROR",
            capability.databaseError.databaseCode,
            capability.databaseError.sqlstate,
          );
        }
        throw new TransportError(
          "CPL_NEON_TRANSPORT_FAILED",
          capability.sent ? "UNKNOWN" : "NOT_SENT",
        );
      } finally {
        clearTimeout(timer);
        controller.abort();
        capabilities.delete(controller.signal);
      }
    },
  });
}
