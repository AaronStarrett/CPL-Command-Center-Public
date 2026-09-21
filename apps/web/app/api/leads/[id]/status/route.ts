import { getServerRuntime, type BeaServerRuntime } from "@bea/database";
import { isLeadStatus } from "@bea/domain";
import { PERMISSIONS, type Permission } from "@bea/security";
import { NextRequest } from "next/server";

import { requestCorrelationId, requestSession, webRouteLogger } from "@/app/api/route-helpers";
import { apiError, apiException, apiJson } from "@/lib/api-response";
import { canIncludeApiDiagnostics } from "@/lib/diagnostics-authorization";
import { leadMutationErrorStatus, optionalLeadString } from "@/lib/lead-api";
import { isSameOriginRequest } from "@/lib/request-security";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/leads/[id]/status", "POST");
  let runtime: BeaServerRuntime | undefined;
  let authenticatedUserId: string | undefined;
  try {
    runtime = await getServerRuntime();
    const session = await requestSession(request);
    authenticatedUserId = session?.personaId;
    if (!isSameOriginRequest(request, runtime.environment.appBaseUrl)) {
      return apiError(
        "cross-origin-request-rejected",
        "Cross-origin lead review was rejected.",
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
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError("invalid-json", "The request body must be valid JSON.", 400, correlationId);
    }
    if (!body || typeof body !== "object") {
      return apiError("invalid-lead", "Lead review details are required.", 400, correlationId);
    }
    const input = body as Record<string, unknown>;
    const toStatus = typeof input.toStatus === "string" ? input.toStatus : "";
    if (!isLeadStatus(toStatus)) {
      return apiError("invalid-lead", "A valid review status is required.", 400, correlationId);
    }
    const permission: Permission =
      toStatus === "disqualified" ? PERMISSIONS.LEADS_DISQUALIFY : PERMISSIONS.LEADS_REVIEW;
    const decision = await runtime.authorization.authorizeUser(session.personaId, permission);
    if (!decision.allowed) {
      await runtime.repository.record({
        eventType: "authorization.denied",
        action: "lead.transition",
        outcome: "denied",
        actorUserId: session.personaId,
        resourceType: "lead",
        correlationId,
        metadata: { permission, reason: decision.reason, toStatus },
      });
      return apiError(
        "permission-not-granted",
        "The current role cannot change this lead status.",
        403,
        correlationId,
      );
    }
    const expectedVersion =
      typeof input.expectedVersion === "number" ? input.expectedVersion : Number.NaN;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      return apiError("invalid-lead", "A current lead version is required.", 400, correlationId);
    }
    const reason = optionalLeadString(input.reason, 4_000);
    if (reason === undefined) {
      return apiError("invalid-lead", "The review reason is invalid.", 400, correlationId);
    }
    const { id } = await context.params;
    const record = await runtime.leads.transitionStatus({
      leadId: id,
      toStatus,
      reason,
      expectedVersion,
      actorUserId: session.personaId,
      correlationId,
    });
    if (runtime.environment.appMode === "demo") {
      await runtime.workControl.processPendingEvents();
    }
    logger.info(
      { userId: session.personaId, leadId: record.lead.id, toStatus },
      "Phase 2.0 lead status changed",
    );
    return apiJson({ lead: record }, correlationId);
  } catch (error) {
    const mapped = leadMutationErrorStatus(error);
    if (mapped) return apiError(mapped.code, mapped.message, mapped.status, correlationId);
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Lead status change failed",
    );
    const diagnosticsAllowed = await canIncludeApiDiagnostics(runtime, authenticatedUserId);
    return apiException(error, 500, correlationId, diagnosticsAllowed);
  }
}
