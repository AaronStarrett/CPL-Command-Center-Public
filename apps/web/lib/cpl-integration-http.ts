import { randomUUID } from "node:crypto";
import { CPL_INTEGRATION_ERROR_CODES } from "@bea/domain/cpl-integrations";
import { administrationFailure, administrationQuery } from "./cpl-administration-http";
import { CommercialInputError } from "./cpl-commercial-http";
import { inboundJson, InboundBodyTimeout } from "./cpl-inbound-http";

export function integrationFailure(error: unknown, anonymous = false) {
  if (error instanceof InboundBodyTimeout) return inboundJson({ code: "CPL_INBOUND_TIMEOUT" }, 408);
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "";
  if ((CPL_INTEGRATION_ERROR_CODES as readonly string[]).includes(code)) {
    const status =
      code === "CPL_INTEGRATION_RATE_LIMITED"
        ? 429
        : /(?:NOT_FOUND|SOURCE_UNAVAILABLE)$/u.test(code)
          ? 404
          : /(?:INVALID|TOO_LARGE)$/u.test(code)
            ? code.endsWith("TOO_LARGE")
              ? 413
              : 400
            : /(?:CONFLICT|STALE|CHANGED|REPLAY_REJECTED)$/u.test(code)
              ? 409
              : /(?:SCHEMA_REQUIRED|PROCESSING_FAILED|PROVIDER_DISABLED)$/u.test(code)
                ? 503
                : 403;
    const publicCode =
      status === 429
        ? "CPL_INBOUND_RATE_LIMITED"
        : status === 409
          ? "CPL_INBOUND_CONFLICT"
          : status === 404
            ? "CPL_INBOUND_UNAVAILABLE"
            : status === 503
              ? "CPL_INBOUND_TEMPORARILY_UNAVAILABLE"
              : "CPL_INBOUND_REJECTED";
    return inboundJson(
      { code: anonymous ? publicCode : code },
      status,
      status === 429 ? { "Retry-After": "60" } : {},
    );
  }
  if (error instanceof CommercialInputError)
    return inboundJson({ code: anonymous ? "CPL_INBOUND_REJECTED" : "CPL_INVALID_INPUT" }, 400);
  if (!anonymous) {
    const failure = administrationFailure(error);
    if (failure.status !== 503) return failure;
  }
  const correlationId = randomUUID();
  // Diagnostic correlation only; never serialize causes, SQL, source content,
  // headers, callback parameters or provider error bodies.
  console.error("CPL_INTEGRATION_REQUEST_FAILED", { correlationId });
  return inboundJson(
    {
      code: anonymous ? "CPL_INBOUND_TEMPORARILY_UNAVAILABLE" : "CPL_INTEGRATION_UNAVAILABLE",
      correlationId,
    },
    503,
  );
}

export function integrationList(request: Request, allowed = ["cursor", "limit", "status"]) {
  const query = administrationQuery(request, allowed);
  if (query.limit !== undefined && !/^(?:[1-9][0-9]?|100)$/u.test(query.limit))
    throw new CommercialInputError();
  return { ...query, ...(query.limit === undefined ? {} : { limit: Number(query.limit) }) };
}

export function integrationCallbackQuery(request: Request) {
  const query = new URL(request.url).searchParams;
  const accepted = ["state", "code", "error", "error_description", "scope", "authuser", "prompt"];
  for (const [key, value] of query) {
    if (!accepted.includes(key) || query.getAll(key).length !== 1 || value.length > 4096)
      throw new CommercialInputError();
  }
  const state = query.get("state"),
    code = query.get("code"),
    error = query.get("error");
  if (!state || state.length > 512 || Boolean(code) === Boolean(error))
    throw new CommercialInputError();
  return { state, ...(code ? { code } : {}), ...(error ? { error } : {}) };
}
