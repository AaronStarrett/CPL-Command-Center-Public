import { getServerRuntime, type BeaServerRuntime } from "@bea/database";
import { isLeadSourceType } from "@bea/domain";
import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { requestCorrelationId, requestSession, webRouteLogger } from "@/app/api/route-helpers";
import { apiError, apiException, apiJson } from "@/lib/api-response";
import { canIncludeApiDiagnostics } from "@/lib/diagnostics-authorization";
import {
  leadMutationErrorStatus,
  optionalLeadDateTime,
  optionalLeadString,
  parseLeadParties,
} from "@/lib/lead-api";
import { isSameOriginRequest } from "@/lib/request-security";

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/leads/[id]", "PATCH");
  let runtime: BeaServerRuntime | undefined;
  let authenticatedUserId: string | undefined;
  try {
    runtime = await getServerRuntime();
    const session = await requestSession(request);
    authenticatedUserId = session?.personaId;
    if (!isSameOriginRequest(request, runtime.environment.appBaseUrl)) {
      return apiError(
        "cross-origin-request-rejected",
        "Cross-origin lead updates were rejected.",
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
    const decision = await runtime.authorization.authorizeUser(
      session.personaId,
      PERMISSIONS.LEADS_MANAGE,
    );
    if (!decision.allowed) {
      await runtime.repository.record({
        eventType: "authorization.denied",
        action: "lead.update",
        outcome: "denied",
        actorUserId: session.personaId,
        resourceType: "lead",
        correlationId,
        metadata: { permission: PERMISSIONS.LEADS_MANAGE, reason: decision.reason },
      });
      return apiError(
        "permission-not-granted",
        "The current role cannot edit leads.",
        403,
        correlationId,
      );
    }
    const { id } = await context.params;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError("invalid-json", "The request body must be valid JSON.", 400, correlationId);
    }
    if (!body || typeof body !== "object") {
      return apiError("invalid-lead", "Lead details are required.", 400, correlationId);
    }
    const input = body as Record<string, unknown>;
    const expectedVersion =
      typeof input.expectedVersion === "number" ? input.expectedVersion : Number.NaN;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      return apiError("invalid-lead", "A current lead version is required.", 400, correlationId);
    }
    const sourceType =
      input.sourceType === undefined
        ? undefined
        : typeof input.sourceType === "string" && isLeadSourceType(input.sourceType)
          ? input.sourceType
          : undefined;
    if (input.sourceType !== undefined && sourceType === undefined) {
      return apiError("invalid-lead", "A valid intake source is required.", 400, correlationId);
    }
    const opportunityName = optionalLeadString(input.opportunityName, 240);
    const requestSummary = optionalLeadString(input.requestSummary, 4_000);
    const sourceDetails = optionalLeadString(input.sourceDetails, 4_000);
    const requestedService = optionalLeadString(input.requestedService, 240);
    const receivedAt = optionalLeadDateTime(input.receivedAt);
    const siteName = optionalLeadString(input.siteName, 240);
    const siteAddressLine1 = optionalLeadString(input.siteAddressLine1, 240);
    const siteAddressLine2 = optionalLeadString(input.siteAddressLine2, 240);
    const siteCity = optionalLeadString(input.siteCity, 120);
    const siteRegion = optionalLeadString(input.siteRegion, 120);
    const sitePostalCode = optionalLeadString(input.sitePostalCode, 32);
    const siteCountry = optionalLeadString(input.siteCountry, 120);
    const desiredDeadlineAt = optionalLeadDateTime(input.desiredDeadlineAt);
    const requestedVisitAt = optionalLeadDateTime(input.requestedVisitAt);
    const reviewerUserId = optionalLeadString(input.reviewerUserId, 36);
    const parties = parseLeadParties(input.parties);
    const invalidOptional =
      opportunityName === undefined ||
      requestSummary === undefined ||
      Boolean(input.opportunityName !== undefined && !opportunityName) ||
      Boolean(input.requestSummary !== undefined && !requestSummary) ||
      ("sourceDetails" in input && sourceDetails === undefined) ||
      ("requestedService" in input && requestedService === undefined) ||
      ("receivedAt" in input && receivedAt === undefined) ||
      ("siteName" in input && siteName === undefined) ||
      ("siteAddressLine1" in input && siteAddressLine1 === undefined) ||
      ("siteAddressLine2" in input && siteAddressLine2 === undefined) ||
      ("siteCity" in input && siteCity === undefined) ||
      ("siteRegion" in input && siteRegion === undefined) ||
      ("sitePostalCode" in input && sitePostalCode === undefined) ||
      ("siteCountry" in input && siteCountry === undefined) ||
      ("desiredDeadlineAt" in input && desiredDeadlineAt === undefined) ||
      ("requestedVisitAt" in input && requestedVisitAt === undefined) ||
      ("reviewerUserId" in input && reviewerUserId === undefined) ||
      ("parties" in input && parties === undefined);
    if (invalidOptional) {
      return apiError(
        "invalid-lead",
        "Lead fields are invalid or exceed their allowed length.",
        400,
        correlationId,
      );
    }
    const record = await runtime.leads.updateLead({
      leadId: id,
      expectedVersion,
      actorUserId: session.personaId,
      correlationId,
      ...(sourceType ? { sourceType } : {}),
      ...(typeof opportunityName === "string" ? { opportunityName } : {}),
      ...(typeof requestSummary === "string" ? { requestSummary } : {}),
      ...(input.sourceDetails !== undefined ? { sourceDetails } : {}),
      ...(input.requestedService !== undefined ? { requestedService } : {}),
      ...(input.receivedAt !== undefined ? { receivedAt } : {}),
      ...(input.siteName !== undefined ? { siteName } : {}),
      ...(input.siteAddressLine1 !== undefined ? { siteAddressLine1 } : {}),
      ...(input.siteAddressLine2 !== undefined ? { siteAddressLine2 } : {}),
      ...(input.siteCity !== undefined ? { siteCity } : {}),
      ...(input.siteRegion !== undefined ? { siteRegion } : {}),
      ...(input.sitePostalCode !== undefined ? { sitePostalCode } : {}),
      ...(input.siteCountry !== undefined ? { siteCountry } : {}),
      ...(input.desiredDeadlineAt !== undefined ? { desiredDeadlineAt } : {}),
      ...(input.requestedVisitAt !== undefined ? { requestedVisitAt } : {}),
      ...(input.reviewerUserId !== undefined ? { reviewerUserId } : {}),
      ...(parties ? { parties } : {}),
    });
    logger.info({ userId: session.personaId, leadId: record.lead.id }, "Phase 2.0 lead updated");
    return apiJson({ lead: record }, correlationId);
  } catch (error) {
    const mapped = leadMutationErrorStatus(error);
    if (mapped) return apiError(mapped.code, mapped.message, mapped.status, correlationId);
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Lead update failed",
    );
    const diagnosticsAllowed = await canIncludeApiDiagnostics(runtime, authenticatedUserId);
    return apiException(error, 500, correlationId, diagnosticsAllowed);
  }
}
