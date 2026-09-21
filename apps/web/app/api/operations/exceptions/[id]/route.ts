import { getServerRuntime, type BeaServerRuntime } from "@bea/database";
import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { requestCorrelationId, requestSession, webRouteLogger } from "@/app/api/route-helpers";
import { apiError, apiException, apiJson } from "@/lib/api-response";
import { canIncludeApiDiagnostics } from "@/lib/diagnostics-authorization";
import { operationsMutationErrorStatus } from "@/lib/operations-api";
import { isSameOriginRequest } from "@/lib/request-security";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/operations/exceptions/[id]", "POST");
  let runtime: BeaServerRuntime | undefined;
  let authenticatedUserId: string | undefined;
  try {
    runtime = await getServerRuntime();
    const session = await requestSession(request);
    authenticatedUserId = session?.personaId;
    if (!isSameOriginRequest(request, runtime.environment.appBaseUrl)) {
      return apiError(
        "cross-origin-request-rejected",
        "Cross-origin exception mutation was rejected.",
        403,
        correlationId,
      );
    }
    if (!session) {
      return apiError(
        "authentication-required",
        "A valid demo session is required.",
        401,
        correlationId,
      );
    }
    const decision = await runtime.authorization.authorizeUser(
      session.personaId,
      PERMISSIONS.EXCEPTIONS_MANAGE,
    );
    if (!decision.allowed) {
      await runtime.repository.record({
        eventType: "authorization.denied",
        action: "exception.resolve",
        outcome: "denied",
        actorUserId: session.personaId,
        resourceType: "exception",
        correlationId,
        metadata: { permission: PERMISSIONS.EXCEPTIONS_MANAGE, reason: decision.reason },
      });
      return apiError(
        "permission-not-granted",
        "The current role cannot resolve exceptions.",
        403,
        correlationId,
      );
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const { id } = await context.params;
    const exception = await runtime.operations.repository.getException(id);
    if (!exception) {
      return apiError("operations-not-found", "Exception was not found.", 404, correlationId);
    }
    await runtime.operations.resolveException({
      exceptionId: id,
      actorUserId: session.personaId,
      correlationId,
      resolution: typeof input.resolution === "string" ? input.resolution : null,
    });
    const resolved = await runtime.operations.repository.getException(id);
    return apiJson(
      { exception: resolved, synthetic: runtime.environment.appMode === "demo" },
      correlationId,
    );
  } catch (error) {
    const mapped = operationsMutationErrorStatus(error);
    if (mapped) return apiError(mapped.code, mapped.message, mapped.status, correlationId);
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Exception mutation failed",
    );
    const diagnosticsAllowed = await canIncludeApiDiagnostics(runtime, authenticatedUserId);
    return apiException(error, 500, correlationId, diagnosticsAllowed);
  }
}
