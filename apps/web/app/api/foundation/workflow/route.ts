import { getServerRuntime, type BeaServerRuntime } from "@bea/database";
import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { requestCorrelationId, requestSession, webRouteLogger } from "@/app/api/route-helpers";
import { apiError, apiException, apiJson } from "@/lib/api-response";
import { canIncludeApiDiagnostics } from "@/lib/diagnostics-authorization";
import { getFoundationSnapshot, runFoundationWorkflow } from "@/lib/foundation";
import { isSameOriginRequest } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/foundation/workflow", "GET");
  let runtime: BeaServerRuntime | undefined;
  let authenticatedUserId: string | undefined;

  try {
    runtime = await getServerRuntime();
    const session = await requestSession(request);
    authenticatedUserId = session?.personaId;
    if (!session) {
      logger.warn({}, "Foundation status request requires authentication");
      return apiError(
        "authentication-required",
        "A valid demo session is required.",
        401,
        correlationId,
      );
    }

    const decision = await runtime.authorization.authorizeUser(
      session.personaId,
      PERMISSIONS.HOME_VIEW,
    );
    if (!decision.allowed) {
      await runtime.repository.record({
        eventType: "authorization.denied",
        action: "foundation.status.read",
        outcome: "denied",
        actorUserId: session.personaId,
        resourceType: "foundation-workflow",
        correlationId,
        metadata: { permission: PERMISSIONS.HOME_VIEW, reason: decision.reason },
      });
      logger.warn({ userId: session.personaId }, "Foundation status permission denied");
      return apiError(
        "permission-not-granted",
        "The current role cannot inspect foundation status.",
        403,
        correlationId,
      );
    }

    const snapshot = await getFoundationSnapshot();
    logger.info({ userId: session.personaId }, "Foundation status returned");
    return apiJson(snapshot, correlationId, { noStore: true });
  } catch (error) {
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Foundation status request failed",
    );
    const diagnosticsAllowed = await canIncludeApiDiagnostics(runtime, authenticatedUserId);
    return apiException(error, 500, correlationId, diagnosticsAllowed);
  }
}

export async function POST(request: NextRequest) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/foundation/workflow", "POST");
  let runtime: BeaServerRuntime | undefined;
  let authenticatedUserId: string | undefined;

  try {
    runtime = await getServerRuntime();
    const session = await requestSession(request);
    authenticatedUserId = session?.personaId;
    if (!isSameOriginRequest(request, runtime.environment.appBaseUrl)) {
      await runtime.repository.record({
        eventType: "authorization.denied",
        action: "foundation.workflow.run",
        outcome: "denied",
        actorUserId: session?.personaId ?? null,
        resourceType: "foundation-workflow",
        correlationId,
        metadata: { reason: "cross-origin-request" },
      });
      logger.warn({}, "Cross-origin foundation workflow request rejected");
      return apiError(
        "cross-origin-request-rejected",
        "Cross-origin workflow execution was rejected.",
        403,
        correlationId,
      );
    }

    if (!session) {
      logger.warn({}, "Foundation workflow request requires authentication");
      return apiError(
        "authentication-required",
        "A valid demo session is required.",
        401,
        correlationId,
      );
    }

    const decision = await runtime.authorization.authorizeUser(
      session.personaId,
      PERMISSIONS.FOUNDATION_WORKFLOW_RUN,
    );
    if (!decision.allowed) {
      await runtime.repository.record({
        eventType: "authorization.denied",
        action: "foundation.workflow.run",
        outcome: "denied",
        actorUserId: session.personaId,
        resourceType: "foundation-workflow",
        correlationId,
        metadata: { permission: PERMISSIONS.FOUNDATION_WORKFLOW_RUN, reason: decision.reason },
      });
      logger.warn({ userId: session.personaId }, "Foundation workflow permission denied");
      return apiError(
        "permission-not-granted",
        "The current role cannot run the foundation workflow.",
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

    if (
      !body ||
      typeof body !== "object" ||
      !("action" in body) ||
      body.action !== "run-foundation-check" ||
      !("idempotencyKey" in body) ||
      typeof body.idempotencyKey !== "string" ||
      body.idempotencyKey.length < 8 ||
      body.idempotencyKey.length > 128
    ) {
      return apiError(
        "unsupported-action",
        "A supported action and valid idempotency key are required.",
        400,
        correlationId,
      );
    }

    const result = await runFoundationWorkflow({
      idempotencyKey: body.idempotencyKey,
      actorUserId: session.personaId,
      correlationId,
    });
    logger.info(
      { userId: session.personaId, workflowRunId: result.run.id, reused: result.reused },
      "Foundation workflow request completed",
    );
    return apiJson(result, correlationId, {
      status: result.run.status === "failed" ? 503 : result.reused ? 200 : 201,
    });
  } catch (error) {
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Foundation workflow request failed",
    );
    const diagnosticsAllowed = await canIncludeApiDiagnostics(runtime, authenticatedUserId);
    return apiException(error, 500, correlationId, diagnosticsAllowed);
  }
}
