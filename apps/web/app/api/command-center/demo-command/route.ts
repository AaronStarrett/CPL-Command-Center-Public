import { type BeaServerRuntime } from "@bea/database";
import { GuidedDemoUnavailableError } from "@bea/domain";
import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { requestCorrelationId, requestSession, webRouteLogger } from "@/app/api/route-helpers";
import { apiError, apiException, apiJson } from "@/lib/api-response";
import { canIncludeApiDiagnostics } from "@/lib/diagnostics-authorization";
import { buildGuidedDemoEnvelope } from "@/lib/guided-demo-server";
import { getOperationsServerRuntime, operationsMutationErrorStatus } from "@/lib/operations-api";
import { isSameOriginRequest, validateBoundedJsonMutation } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/command-center/demo-command", "POST");
  let runtime: BeaServerRuntime | undefined;
  let authenticatedUserId: string | undefined;
  try {
    runtime = await getOperationsServerRuntime();
    const session = await requestSession(request);
    authenticatedUserId = session?.personaId;
    if (!isSameOriginRequest(request, runtime.environment.appBaseUrl)) {
      return apiError(
        "cross-origin-request-rejected",
        "Cross-origin demonstration commands were rejected.",
        403,
        correlationId,
      );
    }
    const transport = validateBoundedJsonMutation(request);
    if (!transport.ok) {
      return apiError(transport.code, transport.message, transport.status, correlationId);
    }
    if (!session) {
      return apiError(
        "authentication-required",
        "A valid demo session is required.",
        401,
        correlationId,
      );
    }
    const allowed = await runtime.authorization.authorizeUser(
      session.personaId,
      PERMISSIONS.HOME_VIEW,
    );
    if (!allowed.allowed) {
      return apiError(
        "permission-not-granted",
        "The current role cannot use the simulated command demonstration.",
        403,
        correlationId,
      );
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError("invalid-json", "The request body must be valid JSON.", 400, correlationId);
    }
    const commandText =
      body &&
      typeof body === "object" &&
      typeof (body as { commandText?: unknown }).commandText === "string"
        ? (body as { commandText: string }).commandText
        : "";
    const routed = await runtime.guidedDemo.routeCommand({
      action: "route_command",
      actorUserId: session.personaId,
      correlationId,
      commandText,
    });
    const envelope = await buildGuidedDemoEnvelope({
      runtime,
      snapshot: routed.snapshot,
      actorUserId: session.personaId,
      displayName: session.displayName,
      command: routed.response,
    });
    return apiJson(envelope, correlationId);
  } catch (error) {
    if (error instanceof GuidedDemoUnavailableError) {
      return apiError("guided-demo-unavailable", error.message, 404, correlationId);
    }
    const mapped = operationsMutationErrorStatus(error);
    if (mapped) return apiError(mapped.code, mapped.message, mapped.status, correlationId);
    logger.error({ err: error, authenticatedUserId }, "Simulated command failed");
    return apiException(
      error,
      500,
      correlationId,
      await canIncludeApiDiagnostics(runtime, authenticatedUserId),
    );
  }
}
