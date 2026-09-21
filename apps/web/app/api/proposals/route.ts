import { type BeaServerRuntime } from "@bea/database";
import { COMMERCIAL_PRODUCTION_UNCONFIGURED, COMMERCIAL_SYNTHETIC_DISCLOSURE } from "@bea/domain";
import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { requestCorrelationId, requestSession, webRouteLogger } from "@/app/api/route-helpers";
import { apiError, apiException, apiJson } from "@/lib/api-response";
import { permissionForProposalAction } from "@/lib/commercial-access";
import { canIncludeApiDiagnostics } from "@/lib/diagnostics-authorization";
import { getOperationsServerRuntime, operationsMutationErrorStatus } from "@/lib/operations-api";
import { isSameOriginRequest } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function GET(request: NextRequest) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/proposals", "GET");
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
      PERMISSIONS.PROPOSALS_VIEW,
    );
    if (!decision.allowed) {
      await runtime.repository.record({
        eventType: "authorization.denied",
        action: "proposal.read",
        outcome: "denied",
        actorUserId: session.personaId,
        resourceType: "proposal",
        correlationId,
        metadata: { permission: PERMISSIONS.PROPOSALS_VIEW, reason: decision.reason },
      });
      return apiError(
        "permission-not-granted",
        "The current role cannot view proposals.",
        403,
        correlationId,
      );
    }
    if (runtime.environment.appMode === "demo") {
      await runtime.workControl.processPendingEvents();
    }
    const search = request.nextUrl.searchParams.get("q") ?? undefined;
    const status = request.nextUrl.searchParams.get("status") ?? undefined;
    const leadId = request.nextUrl.searchParams.get("leadId") ?? undefined;
    const [items, metrics] = await Promise.all([
      runtime.commercial.repository.listProposals({
        ...(search ? { search } : {}),
        ...(status ? { status: status as never } : {}),
        ...(leadId ? { leadId } : {}),
      }),
      runtime.commercial.repository.metrics(),
    ]);
    return apiJson(
      {
        items,
        metrics,
        synthetic: true,
        disclosure: COMMERCIAL_SYNTHETIC_DISCLOSURE,
        productionConfigured: false,
        productionLabel: COMMERCIAL_PRODUCTION_UNCONFIGURED,
      },
      correlationId,
    );
  } catch (error) {
    const mapped = operationsMutationErrorStatus(error);
    if (mapped) return apiError(mapped.code, mapped.message, mapped.status, correlationId);
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Proposal list failed",
    );
    const diagnosticsAllowed = await canIncludeApiDiagnostics(runtime, authenticatedUserId);
    return apiException(error, 500, correlationId, diagnosticsAllowed);
  }
}

export async function POST(request: NextRequest) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/proposals", "POST");
  let runtime: BeaServerRuntime | undefined;
  let authenticatedUserId: string | undefined;
  try {
    runtime = await getOperationsServerRuntime();
    const session = await requestSession(request);
    authenticatedUserId = session?.personaId;
    if (!isSameOriginRequest(request, runtime.environment.appBaseUrl)) {
      return apiError(
        "cross-origin-request-rejected",
        "Cross-origin proposal creation was rejected.",
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
      return apiError(
        "invalid-proposal",
        "Proposal action details are required.",
        400,
        correlationId,
      );
    }
    const input = body as Record<string, unknown>;
    const action = asString(input.action) || "create-from-lead";
    const mapped = permissionForProposalAction(action);
    if (!mapped) {
      return apiError(
        "unknown-action",
        "The proposal action is not recognized.",
        400,
        correlationId,
      );
    }
    const decision = await runtime.authorization.authorizeUser(
      session.personaId,
      mapped.permission,
    );
    if (!decision.allowed) {
      await runtime.repository.record({
        eventType: "authorization.denied",
        action: mapped.auditAction,
        outcome: "denied",
        actorUserId: session.personaId,
        resourceType: "proposal",
        correlationId,
        metadata: { permission: mapped.permission, reason: decision.reason },
      });
      return apiError("permission-not-granted", mapped.denyMessage, 403, correlationId);
    }
    if (action !== "create-from-lead") {
      return apiError(
        "unknown-action",
        "The proposal action is not recognized.",
        400,
        correlationId,
      );
    }
    const leadId = asString(input.leadId);
    if (!leadId) {
      return apiError("invalid-proposal", "A lead id is required.", 400, correlationId);
    }
    const created = await runtime.commercial.createProposalFromLead({
      leadId,
      actorUserId: session.personaId,
      correlationId,
      ...(asString(input.catalogVersionId)
        ? { catalogVersionId: asString(input.catalogVersionId) }
        : {}),
    });
    logger.info(
      {
        userId: session.personaId,
        proposalId: created.record.proposal.id,
        alreadyExisted: created.alreadyExisted,
      },
      "Phase 3.3A proposal created from lead",
    );
    return apiJson(
      {
        record: created.record,
        alreadyExisted: created.alreadyExisted,
        synthetic: true,
        disclosure: COMMERCIAL_SYNTHETIC_DISCLOSURE,
      },
      correlationId,
    );
  } catch (error) {
    const mapped = operationsMutationErrorStatus(error);
    if (mapped) return apiError(mapped.code, mapped.message, mapped.status, correlationId);
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Proposal creation failed",
    );
    const diagnosticsAllowed = await canIncludeApiDiagnostics(runtime, authenticatedUserId);
    return apiException(error, 500, correlationId, diagnosticsAllowed);
  }
}
