import { getServerRuntime, type BeaServerRuntime } from "@bea/database";
import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { requestCorrelationId, requestSession, webRouteLogger } from "@/app/api/route-helpers";
import { apiError, apiException, apiJson } from "@/lib/api-response";
import { canIncludeApiDiagnostics } from "@/lib/diagnostics-authorization";

export async function GET(request: NextRequest) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/operations/board", "GET");
  let runtime: BeaServerRuntime | undefined;
  let authenticatedUserId: string | undefined;
  try {
    runtime = await getServerRuntime();
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
      PERMISSIONS.OPERATIONS_BOARD_VIEW,
    );
    if (!decision.allowed) {
      await runtime.repository.record({
        eventType: "authorization.denied",
        action: "operations.board.read",
        outcome: "denied",
        actorUserId: session.personaId,
        resourceType: "operations-board",
        correlationId,
        metadata: { permission: PERMISSIONS.OPERATIONS_BOARD_VIEW, reason: decision.reason },
      });
      return apiError(
        "permission-not-granted",
        "The current role cannot view the turnaround board.",
        403,
        correlationId,
      );
    }
    const items = await runtime.operations.repository.listTurnaroundBoard();
    return apiJson({ items, synthetic: runtime.environment.appMode === "demo" }, correlationId);
  } catch (error) {
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Operations board read failed",
    );
    const diagnosticsAllowed = await canIncludeApiDiagnostics(runtime, authenticatedUserId);
    return apiException(error, 500, correlationId, diagnosticsAllowed);
  }
}
