import { getServerRuntime, type BeaServerRuntime } from "@bea/database";
import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { requestCorrelationId, requestSession, webRouteLogger } from "@/app/api/route-helpers";
import { apiError, apiException, apiJson } from "@/lib/api-response";
import { canIncludeApiDiagnostics } from "@/lib/diagnostics-authorization";
import { isSameOriginRequest } from "@/lib/request-security";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/tasks/[id]/complete", "POST");
  let runtime: BeaServerRuntime | undefined;
  let authenticatedUserId: string | undefined;
  try {
    runtime = await getServerRuntime();
    const session = await requestSession(request);
    authenticatedUserId = session?.personaId;
    if (!isSameOriginRequest(request, runtime.environment.appBaseUrl)) {
      return apiError(
        "cross-origin-request-rejected",
        "Cross-origin task completion was rejected.",
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
      PERMISSIONS.TASKS_MANAGE,
    );
    if (!decision.allowed) {
      await runtime.repository.record({
        eventType: "authorization.denied",
        action: "task.complete",
        outcome: "denied",
        actorUserId: session.personaId,
        resourceType: "task",
        correlationId,
        metadata: { permission: PERMISSIONS.TASKS_MANAGE, reason: decision.reason },
      });
      return apiError(
        "permission-not-granted",
        "The current role cannot complete tasks.",
        403,
        correlationId,
      );
    }
    const { id } = await context.params;
    const task = await runtime.phase1.getTask(id);
    if (!task)
      return apiError("task-not-found", "The requested task does not exist.", 404, correlationId);
    const result = await runtime.phase1.completeTask({
      taskId: task.id,
      actorUserId: session.personaId,
      correlationId,
      expectedVersion: task.version,
    });
    logger.info(
      { userId: session.personaId, taskId: task.id, reused: result.reused },
      "Phase 1 task completed",
    );
    return apiJson(result, correlationId);
  } catch (error) {
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Task completion failed",
    );
    const diagnosticsAllowed = await canIncludeApiDiagnostics(runtime, authenticatedUserId);
    return apiException(error, 500, correlationId, diagnosticsAllowed);
  }
}
