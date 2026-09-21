import { type BeaServerRuntime } from "@bea/database";
import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { requestCorrelationId, requestSession, webRouteLogger } from "@/app/api/route-helpers";
import { apiError, apiException, apiJson } from "@/lib/api-response";
import { canIncludeApiDiagnostics } from "@/lib/diagnostics-authorization";
import { getOperationsServerRuntime, operationsMutationErrorStatus } from "@/lib/operations-api";
import { actorCanSeeWorkKind } from "@/lib/work-access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/work/[id]", "GET");
  let runtime: BeaServerRuntime | undefined;
  let authenticatedUserId: string | undefined;
  try {
    runtime = await getOperationsServerRuntime();
    const session = await requestSession(request);
    authenticatedUserId = session?.personaId;
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
      PERMISSIONS.WORK_VIEW,
    );
    const commercial = await runtime.authorization.authorizeUser(
      session.personaId,
      PERMISSIONS.PROPOSALS_WORK_VIEW,
    );
    if (!decision.allowed && !commercial.allowed) {
      return apiError(
        "permission-not-granted",
        "The current role cannot view operational work.",
        403,
        correlationId,
      );
    }
    const { id } = await context.params;
    const item = await runtime.workControl.repository.getWorkItem(id);
    if (!item) {
      return apiError("operations-not-found", "Work item was not found.", 404, correlationId);
    }
    if (!decision.allowed && !actorCanSeeWorkKind(item.workItemKind, { hasFullWorkView: false })) {
      return apiError("operations-not-found", "Work item was not found.", 404, correlationId);
    }
    const [assignments, events, reminders, escalations] = await Promise.all([
      runtime.workControl.repository.listAssignments(id),
      runtime.workControl.repository.listWorkItemEvents(id),
      runtime.workControl.repository.listReminders(id),
      runtime.workControl.repository.listEscalations(id),
    ]);
    return apiJson(
      { item, assignments, events, reminders, escalations, synthetic: item.synthetic },
      correlationId,
    );
  } catch (error) {
    const mapped = operationsMutationErrorStatus(error);
    if (mapped) return apiError(mapped.code, mapped.message, mapped.status, correlationId);
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Work item read failed",
    );
    const diagnosticsAllowed = await canIncludeApiDiagnostics(runtime, authenticatedUserId);
    return apiException(error, 500, correlationId, diagnosticsAllowed);
  }
}
