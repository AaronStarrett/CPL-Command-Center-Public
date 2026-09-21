import { DigitalWorkforceValidationError, type BeaServerRuntime } from "@bea/database";
import { DigitalWorkforcePolicyError } from "@bea/domain";
import { AccessDeniedError, PERMISSIONS, type Permission } from "@bea/security";
import type { NextRequest } from "next/server";

import { requestCorrelationId, requestSession, webRouteLogger } from "@/app/api/route-helpers";
import { apiError, apiException } from "@/lib/api-response";
import { canIncludeApiDiagnostics } from "@/lib/diagnostics-authorization";
import { isSameOriginRequest } from "@/lib/request-security";

export async function digitalWorkforceContext(
  request: NextRequest,
  input: {
    readonly route: string;
    readonly permission: Permission;
    readonly mutation: boolean;
    readonly action: string;
  },
) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, input.route, request.method);
  const runtime = await (await import("@bea/database")).getServerRuntime();
  const session = await requestSession(request);
  if (input.mutation && !isSameOriginRequest(request, runtime.environment.appBaseUrl)) {
    return {
      ok: false as const,
      response: apiError(
        "cross-origin-request-rejected",
        "Cross-origin Digital Workforce mutation was rejected.",
        403,
        correlationId,
      ),
    };
  }
  if (!session) {
    return {
      ok: false as const,
      response: apiError(
        "authentication-required",
        "A valid session is required.",
        401,
        correlationId,
      ),
    };
  }
  const decision = await runtime.authorization.authorizeUser(session.personaId, input.permission);
  if (!decision.allowed) {
    await runtime.repository.record({
      eventType: "authorization.denied",
      action: input.action,
      outcome: "denied",
      actorUserId: session.personaId,
      resourceType: "digital-workforce",
      correlationId,
      metadata: { permission: input.permission, reason: decision.reason },
    });
    return {
      ok: false as const,
      response: apiError(
        "permission-not-granted",
        "The current role cannot use Digital Workforce for this action.",
        403,
        correlationId,
      ),
    };
  }
  return {
    ok: true as const,
    runtime,
    session,
    correlationId,
    logger,
  };
}

export async function digitalWorkforceFailure(
  error: unknown,
  runtime: BeaServerRuntime | undefined,
  userId: string | undefined,
  correlationId: string,
  logger: ReturnType<typeof webRouteLogger>,
) {
  if (error instanceof AccessDeniedError) {
    return apiError("permission-not-granted", error.message, 403, correlationId);
  }
  if (
    error instanceof DigitalWorkforceValidationError ||
    error instanceof DigitalWorkforcePolicyError
  ) {
    return apiError("invalid-digital-workforce", error.message, 400, correlationId);
  }
  logger.error(
    { errorName: error instanceof Error ? error.name : "UnknownError" },
    "Digital Workforce request failed",
  );
  const diagnosticsAllowed = await canIncludeApiDiagnostics(runtime, userId);
  return apiException(error, 500, correlationId, diagnosticsAllowed);
}

export { PERMISSIONS };
