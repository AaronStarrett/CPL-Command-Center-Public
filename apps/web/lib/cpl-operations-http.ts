import { commercialJson } from "./cpl-commercial-http";

const common = new Set([
  "CPL_INVALID_INPUT",
  "CPL_FIELD_INVALID_INPUT",
  "CPL_EXECUTION_INVALID_INPUT",
  "CPL_INVALID_IDEMPOTENCY_KEY",
  "CPL_ACCESS_DENIED",
  "CPL_SESSION_REQUIRED",
  "CPL_AUTHENTICATION_REQUIRED",
  "CPL_ORGANIZATION_ACCESS_DENIED",
  "CPL_CSRF_REJECTED",
  "CPL_RECENT_MFA_REQUIRED",
  "CPL_ORGANIZATION_REQUIRED",
  "CPL_ORGANIZATION_CONTEXT_CHANGED",
  "CPL_MODULE_DISABLED",
  "CPL_RECORD_NOT_FOUND",
  "CPL_IDEMPOTENCY_CONFLICT",
  "CPL_AUTH_RATE_LIMITED",
  "CPL_ALLOWANCE_EXHAUSTED",
]);

/** Public failures are bounded domain codes, never SQL messages, stack traces,
 * queued payloads, recipient details or private source snapshots. */
export function cplOperationsFailure(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "";
  if (
    !common.has(code) &&
    !/^CPL_(?:AUTOMATION|DELIVERY|CLOSEOUT|REPORT|EVIDENCE)_[A-Z_]{1,80}$/u.test(code)
  )
    return commercialJson({ code: "CPL_WORKSPACE_UNAVAILABLE" }, 503);
  const status =
    code.includes("SCHEMA_UNSAFE") || code.startsWith("CPL_EVIDENCE_")
      ? 503
      : code === "CPL_AUTH_RATE_LIMITED"
        ? 429
        : code.endsWith("NOT_FOUND")
          ? 404
          : ["CPL_SESSION_REQUIRED", "CPL_AUTHENTICATION_REQUIRED"].includes(code)
            ? 401
            : code.includes("INVALID_STATE")
              ? 409
              : code.includes("INVALID") || code === "CPL_INVALID_INPUT"
                ? 400
                : code.includes("CONFLICT") ||
                    code.includes("STALE") ||
                    code.includes("IMMUTABLE") ||
                    code.endsWith("NOT_READY") ||
                    code.endsWith("WITHDRAWN") ||
                    code.endsWith("UNAVAILABLE") ||
                    code.endsWith("CHANGED") ||
                    code.endsWith("SUPERSEDED") ||
                    code.endsWith("REQUIRED") ||
                    code.endsWith("LIMIT") ||
                    code === "CPL_ORGANIZATION_CONTEXT_CHANGED"
                  ? 409
                  : 403;
  return commercialJson({ code }, status);
}
