import { getServerRuntime, type BeaServerRuntime } from "@bea/database";
import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { requestCorrelationId, requestSession, webRouteLogger } from "@/app/api/route-helpers";
import { apiError, apiException, apiJson } from "@/lib/api-response";
import { canIncludeApiDiagnostics } from "@/lib/diagnostics-authorization";
import { isSameOriginRequest } from "@/lib/request-security";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/notifications/[id]/read", "POST");
  let runtime: BeaServerRuntime | undefined;
  let authenticatedUserId: string | undefined;
  try {
    runtime = await getServerRuntime();
    const session = await requestSession(request);
    authenticatedUserId = session?.personaId;
    if (!isSameOriginRequest(request, runtime.environment.appBaseUrl)) {
      return apiError(
        "cross-origin-request-rejected",
        "Cross-origin notification updates were rejected.",
        403,
        correlationId,
      );
    }
    if (!session)
      return apiError(
        "authentication-required",
        "A valid demo session is required.",
        401,
        correlationId,
      );
    const decision = await runtime.authorization.authorizeUser(
      session.personaId,
      PERMISSIONS.NOTIFICATIONS_MANAGE,
    );
    if (!decision.allowed) {
      await runtime.repository.record({
        eventType: "authorization.denied",
        action: "notification.read",
        outcome: "denied",
        actorUserId: session.personaId,
        resourceType: "notification",
        correlationId,
        metadata: { permission: PERMISSIONS.NOTIFICATIONS_MANAGE, reason: decision.reason },
      });
      return apiError(
        "permission-not-granted",
        "The current role cannot update notifications.",
        403,
        correlationId,
      );
    }
    const { id } = await context.params;
    const notification = await runtime.phase1.markNotificationRead({
      notificationId: id,
      userId: session.personaId,
      readAt: new Date().toISOString(),
    });
    if (!notification)
      return apiError(
        "notification-not-found",
        "The notification is unavailable.",
        404,
        correlationId,
      );
    logger.info({ userId: session.personaId, notificationId: id }, "Notification marked read");
    return apiJson({ notification }, correlationId);
  } catch (error) {
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Notification update failed",
    );
    const diagnosticsAllowed = await canIncludeApiDiagnostics(runtime, authenticatedUserId);
    return apiException(error, 500, correlationId, diagnosticsAllowed);
  }
}
