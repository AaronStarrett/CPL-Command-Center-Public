import "server-only";

import { getServerRuntime, type BeaServerRuntime } from "@bea/database";
import type { Permission } from "@bea/security";
import type { NextRequest } from "next/server";

import { requestCorrelationId, requestSession, webRouteLogger } from "@/app/api/route-helpers";
import { apiError } from "@/lib/api-response";
import { isSameOriginRequest, isStrictSameOriginMutation } from "@/lib/request-security";

export type AiApiContext =
  | {
      readonly ok: true;
      readonly runtime: BeaServerRuntime;
      readonly correlationId: string;
      readonly userId: string;
    }
  | { readonly ok: false; readonly response: ReturnType<typeof apiError> };

export async function requireAiApiContext(
  request: NextRequest,
  options: {
    route: string;
    action: string;
    permission?: Permission;
    permissions?: readonly Permission[];
    mutation?: boolean;
    strictMutation?: boolean;
    rateLimit?: { readonly key: string; readonly limit: number; readonly windowSeconds: number };
  },
): Promise<AiApiContext> {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, options.route, request.method);
  const runtime = await getServerRuntime();
  const session = await requestSession(request);

  const originAllowed = options.strictMutation
    ? isStrictSameOriginMutation(request, runtime.environment.appBaseUrl)
    : isSameOriginRequest(request, runtime.environment.appBaseUrl);
  if ((options.mutation || options.strictMutation) && !originAllowed) {
    await runtime.repository.record({
      eventType: "authorization.denied",
      action: options.action,
      outcome: "denied",
      actorUserId: session?.personaId ?? null,
      resourceType: "ai-command",
      correlationId,
      metadata: { reason: "cross-origin-request" },
    });
    logger.warn({}, "Cross-origin AI Command request rejected");
    return {
      ok: false,
      response: apiError(
        "cross-origin-request-rejected",
        "Cross-origin AI Command execution was rejected.",
        403,
        correlationId,
      ),
    };
  }
  if (!session) {
    return {
      ok: false,
      response: apiError(
        "authentication-required",
        "A valid demo session is required.",
        401,
        correlationId,
      ),
    };
  }
  const requiredPermissions =
    options.permissions ?? (options.permission ? [options.permission] : []);
  for (const permission of requiredPermissions) {
    const decision = await runtime.authorization.authorizeUser(session.personaId, permission);
    if (decision.allowed) continue;
    await runtime.repository.record({
      eventType: "authorization.denied",
      action: options.action,
      outcome: "denied",
      actorUserId: session.personaId,
      resourceType: "ai-command",
      correlationId,
      metadata: { permission, reason: decision.reason },
    });
    return {
      ok: false,
      response: apiError(
        "permission-not-granted",
        "The current role cannot use this AI Command capability.",
        403,
        correlationId,
      ),
    };
  }
  if (options.rateLimit) {
    const decision = await runtime.ai.persistence.consumeRateLimit({
      subjectKey: `user:${session.personaId}`,
      routeKey: options.rateLimit.key,
      limit: options.rateLimit.limit,
      windowSeconds: options.rateLimit.windowSeconds,
    });
    if (!decision.allowed) {
      await runtime.repository.record({
        eventType: "rate-limit.denied",
        action: options.action,
        outcome: "denied",
        actorUserId: session.personaId,
        resourceType: "ai-provider",
        correlationId,
        metadata: {
          routeKey: options.rateLimit.key,
          limit: decision.limit,
          resetAt: decision.resetAt,
        },
      });
      const response = apiError(
        "rate-limit-exceeded",
        "This AI capability is temporarily rate limited.",
        429,
        correlationId,
      );
      response.headers.set(
        "Retry-After",
        String(Math.max(1, Math.ceil((Date.parse(decision.resetAt) - Date.now()) / 1000))),
      );
      return { ok: false, response };
    }
  }
  return { ok: true, runtime, correlationId, userId: session.personaId };
}

export function aiCommandApiError(error: unknown, correlationId: string) {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "AI_COMMAND_FAILED";
  const knownClientError =
    code === "ACCESS_DENIED" ||
    code.includes("OWNERSHIP") ||
    code.includes("NOT_FOUND") ||
    code.includes("VALIDATION") ||
    code.includes("SENSITIVE_CONTENT") ||
    code.includes("CONFIRMATION") ||
    code.includes("EXPIRED") ||
    code.includes("IDEMPOTENCY") ||
    code.includes("SUPERSEDED") ||
    code.includes("REQUEST_ID") ||
    code.includes("REQUEST_RESERVATION") ||
    code.includes("REQUEST_REPLAYED") ||
    code.includes("CONCURRENT_UPDATE") ||
    code.includes("COMPANY_INVALID") ||
    code.includes("CONTACT_COMPANY_MISMATCH");
  const status =
    code.includes("REQUEST_REPLAYED") || code.includes("CONCURRENT_UPDATE")
      ? 409
      : code === "ACCESS_DENIED"
        ? 403
        : code.includes("OWNERSHIP")
          ? 404
          : knownClientError
            ? 400
            : 500;
  const message =
    knownClientError && error instanceof Error
      ? error.message
      : "AI Command could not complete the request. No unverified action is being reported.";
  return apiError(code.toLocaleLowerCase("en-US"), message, status, correlationId);
}
