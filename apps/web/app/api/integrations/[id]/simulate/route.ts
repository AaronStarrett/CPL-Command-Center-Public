import { getServerRuntime, type BeaServerRuntime } from "@bea/database";
import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { requestCorrelationId, requestSession, webRouteLogger } from "@/app/api/route-helpers";
import { apiError, apiException, apiJson } from "@/lib/api-response";
import { canIncludeApiDiagnostics } from "@/lib/diagnostics-authorization";
import { getIntegrationHealth } from "@/lib/integrations";
import { isSameOriginRequest } from "@/lib/request-security";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/integrations/[id]/simulate", "POST");
  let runtime: BeaServerRuntime | undefined;
  let authenticatedUserId: string | undefined;

  try {
    runtime = await getServerRuntime();
    if (runtime.environment.runtimeMode === "production") {
      logger.warn({}, "Test-only integration simulation rejected in production");
      return apiError(
        "test-provider-unavailable",
        "Integration simulation is unavailable in production.",
        404,
        correlationId,
      );
    }
    const session = await requestSession(request);
    authenticatedUserId = session?.personaId;
    if (!isSameOriginRequest(request, runtime.environment.appBaseUrl)) {
      await runtime.repository.record({
        eventType: "authorization.denied",
        action: "integration.simulate",
        outcome: "denied",
        actorUserId: session?.personaId ?? null,
        resourceType: "integration-provider",
        correlationId,
        metadata: { reason: "cross-origin-request" },
      });
      logger.warn({}, "Cross-origin integration simulation rejected");
      return apiError(
        "cross-origin-request-rejected",
        "Cross-origin simulation was rejected.",
        403,
        correlationId,
      );
    }

    if (!session) {
      logger.warn({}, "Integration simulation requires authentication");
      return apiError(
        "authentication-required",
        "A valid demo session is required.",
        401,
        correlationId,
      );
    }

    const decision = await runtime.authorization.authorizeUser(
      session.personaId,
      PERMISSIONS.INTEGRATIONS_MANAGE,
    );
    if (!decision.allowed) {
      await runtime.repository.record({
        eventType: "authorization.denied",
        action: "integration.simulate",
        outcome: "denied",
        actorUserId: session.personaId,
        resourceType: "integration-provider",
        correlationId,
        metadata: { permission: PERMISSIONS.INTEGRATIONS_MANAGE, reason: decision.reason },
      });
      logger.warn({ userId: session.personaId }, "Integration simulation permission denied");
      return apiError(
        "permission-not-granted",
        "The current role cannot run integration simulations.",
        403,
        correlationId,
      );
    }

    const { id } = await context.params;
    const health = await getIntegrationHealth(id);
    if (!health) {
      return apiError(
        "integration-not-found",
        "The requested integration provider does not exist.",
        404,
        correlationId,
      );
    }

    await runtime.repository.record({
      eventType: "integration.simulated",
      action: "integration.simulate",
      outcome: "succeeded",
      actorUserId: session.personaId,
      resourceType: "integration-provider",
      correlationId,
      metadata: { providerType: health.providerType, externalCalls: 0 },
    });
    logger.info(
      { userId: session.personaId, providerType: health.providerType, externalCalls: 0 },
      "Integration simulation completed",
    );

    return apiJson(
      {
        providerType: health.providerType,
        mode: health.mode,
        outcome: "completed",
        connectionStatus: health.connectionStatus,
        requirementStatus: health.requirementStatus,
        externalCalls: 0,
        completedAt: health.checkedAt,
      },
      correlationId,
    );
  } catch (error) {
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Integration simulation failed",
    );
    const diagnosticsAllowed = await canIncludeApiDiagnostics(runtime, authenticatedUserId);
    return apiException(error, 500, correlationId, diagnosticsAllowed);
  }
}
