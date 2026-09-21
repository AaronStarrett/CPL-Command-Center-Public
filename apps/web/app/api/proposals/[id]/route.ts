import { type BeaServerRuntime } from "@bea/database";
import {
  COMMERCIAL_PRODUCTION_UNCONFIGURED,
  COMMERCIAL_SYNTHETIC_DISCLOSURE,
  PROPOSAL_EMAIL_DRY_RUN_DISCLOSURE,
  PROPOSAL_REVIEW_DECISIONS,
  type ProposalReviewDecision,
} from "@bea/domain";
import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { requestCorrelationId, requestSession, webRouteLogger } from "@/app/api/route-helpers";
import { apiError, apiException, apiJson } from "@/lib/api-response";
import {
  CommercialInputError,
  boundedCommercialText,
  parseCommercialStringArray,
  parseOptionalNumber,
  permissionForProposalAction,
} from "@/lib/commercial-access";
import { canIncludeApiDiagnostics } from "@/lib/diagnostics-authorization";
import { getOperationsServerRuntime, operationsMutationErrorStatus } from "@/lib/operations-api";
import { isSameOriginRequest } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asLines(
  value: unknown,
): readonly { readonly serviceKey: string; readonly quantityScaled: number }[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new CommercialInputError("Proposal lines must be an array.");
  }
  return value.map((entry) => {
    const row = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const serviceKey = asString(row.serviceKey);
    if (!serviceKey) {
      throw new CommercialInputError("Each proposal line requires a service key.");
    }
    const quantityScaled = parseOptionalNumber(row.quantityScaled, "Line quantity");
    if (quantityScaled === undefined) {
      throw new CommercialInputError("Each proposal line requires a quantity.");
    }
    return { serviceKey, quantityScaled };
  });
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/proposals/[id]", "GET");
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
    const { id } = await context.params;
    const inspected = await runtime.commercial.inspectProposal(id);
    const workItems = await runtime.workControl.repository.listWorkItems({
      proposalId: id,
      limit: 50,
    });
    const [audit, statusEvents] = await Promise.all([
      runtime.commercial.repository.listAudit(id),
      runtime.commercial.repository.listStatusEvents(id),
    ]);
    return apiJson(
      {
        ...inspected,
        workItems,
        audit,
        statusEvents,
        synthetic: true,
        disclosure: COMMERCIAL_SYNTHETIC_DISCLOSURE,
        productionConfigured: false,
        productionLabel: COMMERCIAL_PRODUCTION_UNCONFIGURED,
        noSendDisclosure: PROPOSAL_EMAIL_DRY_RUN_DISCLOSURE,
      },
      correlationId,
    );
  } catch (error) {
    const mapped = operationsMutationErrorStatus(error);
    if (mapped) return apiError(mapped.code, mapped.message, mapped.status, correlationId);
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Proposal detail failed",
    );
    const diagnosticsAllowed = await canIncludeApiDiagnostics(runtime, authenticatedUserId);
    return apiException(error, 500, correlationId, diagnosticsAllowed);
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/proposals/[id]", "POST");
  let runtime: BeaServerRuntime | undefined;
  let authenticatedUserId: string | undefined;
  try {
    runtime = await getOperationsServerRuntime();
    const session = await requestSession(request);
    authenticatedUserId = session?.personaId;
    if (!isSameOriginRequest(request, runtime.environment.appBaseUrl)) {
      return apiError(
        "cross-origin-request-rejected",
        "Cross-origin proposal mutation was rejected.",
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
    const action = asString(input.action);
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
    const { id } = await context.params;
    const expectedVersion =
      typeof input.expectedVersion === "number" ? input.expectedVersion : Number.NaN;
    const actor = {
      proposalId: id,
      actorUserId: session.personaId,
      correlationId,
      expectedVersion,
    };
    if (action !== "preview" && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
      return apiError(
        "invalid-proposal",
        "A current proposal version is required.",
        400,
        correlationId,
      );
    }
    if (action === "update-draft") {
      const deliverables = parseCommercialStringArray(input.deliverables, "Deliverables");
      const assumptions = parseCommercialStringArray(input.assumptions, "Assumptions");
      const exclusions = parseCommercialStringArray(input.exclusions, "Exclusions");
      const record = await runtime.commercial.updateDraft({
        ...actor,
        ...(asString(input.opportunityName)
          ? { opportunityName: asString(input.opportunityName) }
          : {}),
        ...(input.assignedReviewerUserId !== undefined
          ? { assignedReviewerUserId: asString(input.assignedReviewerUserId) || null }
          : {}),
        ...(input.scopeText !== undefined
          ? { scopeText: boundedCommercialText(input.scopeText, "Scope") }
          : {}),
        ...(deliverables ? { deliverables } : {}),
        ...(assumptions ? { assumptions } : {}),
        ...(exclusions ? { exclusions } : {}),
        ...(input.scheduleText !== undefined
          ? {
              scheduleText:
                input.scheduleText === null
                  ? null
                  : boundedCommercialText(input.scheduleText, "Schedule"),
            }
          : {}),
        ...(asLines(input.lines) ? { lines: asLines(input.lines) } : {}),
      });
      return apiJson({ record, synthetic: true }, correlationId);
    }
    if (action === "refresh-from-lead") {
      const refreshed = await runtime.commercial.refreshDraftFromLead(actor);
      return apiJson({ ...refreshed, synthetic: true }, correlationId);
    }
    if (action === "submit-for-review") {
      const record = await runtime.commercial.submitForReview(actor);
      return apiJson({ record, synthetic: true }, correlationId);
    }
    if (action === "review") {
      const decisionValue = asString(input.decision);
      if (!PROPOSAL_REVIEW_DECISIONS.includes(decisionValue as ProposalReviewDecision)) {
        return apiError("invalid-proposal", "A review decision is required.", 400, correlationId);
      }
      const proposalVersionId = asString(input.proposalVersionId);
      if (!proposalVersionId) {
        return apiError(
          "invalid-proposal",
          "An exact proposal version is required.",
          400,
          correlationId,
        );
      }
      const record = await runtime.commercial.reviewProposal({
        ...actor,
        proposalVersionId,
        decision: decisionValue as ProposalReviewDecision,
        comments: asString(input.comments),
        requestedSections:
          parseCommercialStringArray(input.requestedSections, "Requested sections") ?? [],
        ...(asString(input.ownerApprovalOverrideReason)
          ? { ownerApprovalOverrideReason: asString(input.ownerApprovalOverrideReason) }
          : {}),
      });
      return apiJson({ record, synthetic: true }, correlationId);
    }
    if (action === "request-override") {
      const lineKey = asString(input.lineKey);
      if (!lineKey) {
        return apiError("invalid-proposal", "A line key is required.", 400, correlationId);
      }
      const proposedAmountMinor = parseOptionalNumber(
        input.proposedAmountMinor,
        "Proposed override amount",
      );
      if (proposedAmountMinor === undefined) {
        return apiError(
          "invalid-proposal",
          "A proposed override amount is required.",
          400,
          correlationId,
        );
      }
      const record = await runtime.commercial.requestOverride({
        ...actor,
        lineKey,
        proposedAmountMinor,
        reason: asString(input.reason),
      });
      return apiJson({ record, synthetic: true }, correlationId);
    }
    if (action === "decide-override") {
      const record = await runtime.commercial.decideOverride({
        ...actor,
        overrideId: asString(input.overrideId),
        approve: input.approve === true,
      });
      return apiJson({ record, synthetic: true }, correlationId);
    }
    if (action === "delivery-manifest") {
      const proposalVersionId = asString(input.proposalVersionId);
      if (!proposalVersionId) {
        return apiError(
          "invalid-proposal",
          "An exact proposal version is required.",
          400,
          correlationId,
        );
      }
      const record = await runtime.commercial.generateDeliveryManifest({
        ...actor,
        proposalVersionId,
      });
      return apiJson(
        {
          record,
          synthetic: true,
          liveWrites: false,
          noSendDisclosure: PROPOSAL_EMAIL_DRY_RUN_DISCLOSURE,
        },
        correlationId,
      );
    }
    if (action === "cancel") {
      const record = await runtime.commercial.cancelProposal(actor);
      return apiJson({ record, synthetic: true }, correlationId);
    }
    if (action === "preview") {
      const preview = await runtime.commercial.previewDocument({
        proposalId: id,
        ...(asString(input.proposalVersionId)
          ? { proposalVersionId: asString(input.proposalVersionId) }
          : {}),
      });
      return apiJson(
        {
          document: preview.document,
          previewKind: preview.previewKind,
          checksumSha256: preview.pdf.checksumSha256,
          pageCount: preview.pdf.pageCount,
          renderer: preview.pdf.renderer,
          synthetic: true,
          disclosure: COMMERCIAL_SYNTHETIC_DISCLOSURE,
        },
        correlationId,
      );
    }
    return apiError("unknown-action", "The proposal action is not recognized.", 400, correlationId);
  } catch (error) {
    if (error instanceof CommercialInputError) {
      return apiError(error.errorCode, error.message, error.status, correlationId);
    }
    const mapped = operationsMutationErrorStatus(error);
    if (mapped) return apiError(mapped.code, mapped.message, mapped.status, correlationId);
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Proposal mutation failed",
    );
    const diagnosticsAllowed = await canIncludeApiDiagnostics(runtime, authenticatedUserId);
    return apiException(error, 500, correlationId, diagnosticsAllowed);
  }
}
