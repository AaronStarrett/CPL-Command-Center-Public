import { type BeaServerRuntime } from "@bea/database";
import {
  GuidedDemoUnavailableError,
  isGuidedDemoAction,
  type GuidedDemoAction,
  type GuidedDemoDecisionKey,
  type GuidedDemoSpeedMode,
} from "@bea/domain";
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

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function unauthorized(
  runtime: BeaServerRuntime,
  userId: string | undefined,
  correlationId: string,
) {
  if (!userId) {
    return apiError(
      "authentication-required",
      "A valid demo session is required.",
      401,
      correlationId,
    );
  }
  const decision = await runtime.authorization.authorizeUser(userId, PERMISSIONS.HOME_VIEW);
  if (decision.allowed) return null;
  await runtime.repository.record({
    eventType: "authorization.denied",
    action: "guided-demo.read",
    outcome: "denied",
    actorUserId: userId,
    resourceType: "guided-demo",
    correlationId,
    metadata: { permission: PERMISSIONS.HOME_VIEW, reason: decision.reason },
  });
  return apiError(
    "permission-not-granted",
    "The current role cannot open the Meridian demonstration.",
    403,
    correlationId,
  );
}

export async function GET(request: NextRequest) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/guided-demo/meridian", "GET");
  let runtime: BeaServerRuntime | undefined;
  let authenticatedUserId: string | undefined;
  try {
    runtime = await getOperationsServerRuntime();
    const session = await requestSession(request);
    authenticatedUserId = session?.personaId;
    const denied = await unauthorized(runtime, authenticatedUserId, correlationId);
    if (denied) return denied;
    const snapshot = await runtime.guidedDemo.execute({
      action: "get_snapshot",
      actorUserId: authenticatedUserId!,
      correlationId,
    });
    const envelope = await buildGuidedDemoEnvelope({
      runtime,
      snapshot,
      actorUserId: authenticatedUserId!,
      displayName: session!.displayName,
    });
    return apiJson(envelope, correlationId);
  } catch (error) {
    const mapped = operationsMutationErrorStatus(error);
    if (mapped) return apiError(mapped.code, mapped.message, mapped.status, correlationId);
    logger.error({ err: error, authenticatedUserId }, "Guided demo snapshot failed");
    return apiException(
      error,
      500,
      correlationId,
      await canIncludeApiDiagnostics(runtime, authenticatedUserId),
    );
  }
}

export async function POST(request: NextRequest) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/guided-demo/meridian", "POST");
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
    const denied = await unauthorized(runtime, authenticatedUserId, correlationId);
    if (denied) return denied;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError("invalid-json", "The request body must be valid JSON.", 400, correlationId);
    }
    if (!body || typeof body !== "object") {
      return apiError(
        "invalid-guided-demo",
        "Demonstration action details are required.",
        400,
        correlationId,
      );
    }
    const input = body as Record<string, unknown>;
    const action = asString(input.action);
    if (!isGuidedDemoAction(action)) {
      return apiError(
        "unknown-action",
        "The demonstration action is not recognized.",
        400,
        correlationId,
      );
    }
    const snapshot = await runtime.guidedDemo.execute({
      action: action as GuidedDemoAction,
      actorUserId: authenticatedUserId!,
      correlationId,
      ...(typeof input.expectedVersion === "number"
        ? { expectedVersion: input.expectedVersion }
        : {}),
      ...(typeof input.decisionKey === "string"
        ? { decisionKey: input.decisionKey as GuidedDemoDecisionKey }
        : {}),
      ...(typeof input.comments === "string" ? { comments: input.comments } : {}),
      ...(typeof input.speedMode === "string"
        ? { speedMode: input.speedMode as GuidedDemoSpeedMode }
        : {}),
      ...(typeof input.presentationMode === "boolean"
        ? { presentationMode: input.presentationMode }
        : {}),
      ...(typeof input.commandText === "string" ? { commandText: input.commandText } : {}),
      ...(typeof input.idempotencyKey === "string" ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.skipDelay === true ? { skipDelay: true } : {}),
    });
    const envelope = await buildGuidedDemoEnvelope({
      runtime,
      snapshot,
      actorUserId: authenticatedUserId!,
      displayName: session!.displayName,
    });
    return apiJson(envelope, correlationId);
  } catch (error) {
    if (error instanceof GuidedDemoUnavailableError) {
      return apiError("guided-demo-unavailable", error.message, 404, correlationId);
    }
    const mapped = operationsMutationErrorStatus(error);
    if (mapped) return apiError(mapped.code, mapped.message, mapped.status, correlationId);
    logger.error({ err: error, authenticatedUserId }, "Guided demo mutation failed");
    return apiException(
      error,
      500,
      correlationId,
      await canIncludeApiDiagnostics(runtime, authenticatedUserId),
    );
  }
}
