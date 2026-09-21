import { getServerRuntime, type BeaServerRuntime } from "@bea/database";
import { isLeadSourceType, type LeadSourceType } from "@bea/domain";
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

export async function POST(request: NextRequest) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/leads", "POST");
  let runtime: BeaServerRuntime | undefined;
  let authenticatedUserId: string | undefined;
  try {
    runtime = await getServerRuntime();
    const session = await requestSession(request);
    authenticatedUserId = session?.personaId;
    if (!isSameOriginRequest(request, runtime.environment.appBaseUrl)) {
      return apiError(
        "cross-origin-request-rejected",
        "Cross-origin lead creation was rejected.",
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
        action: "lead.create",
        outcome: "denied",
        actorUserId: session.personaId,
        resourceType: "lead",
        correlationId,
        metadata: { permission: PERMISSIONS.LEADS_MANAGE, reason: decision.reason },
      });
      return apiError(
        "permission-not-granted",
        "The current role cannot create leads.",
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
    if (!body || typeof body !== "object") {
      return apiError("invalid-lead", "Lead details are required.", 400, correlationId);
    }
    const input = body as Record<string, unknown>;
    const sourceType = typeof input.sourceType === "string" ? input.sourceType : "";
    if (!isLeadSourceType(sourceType)) {
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
    if (
      !opportunityName ||
      !requestSummary ||
      sourceDetails === undefined ||
      requestedService === undefined ||
      receivedAt === undefined ||
      siteName === undefined ||
      siteAddressLine1 === undefined ||
      siteAddressLine2 === undefined ||
      siteCity === undefined ||
      siteRegion === undefined ||
      sitePostalCode === undefined ||
      siteCountry === undefined ||
      desiredDeadlineAt === undefined ||
      requestedVisitAt === undefined ||
      reviewerUserId === undefined ||
      parties === undefined
    ) {
      return apiError(
        "invalid-lead",
        "Lead fields are invalid or exceed their allowed length.",
        400,
        correlationId,
      );
    }
    const record = await runtime.leads.createLead({
      sourceType: sourceType as LeadSourceType,
      sourceDetails,
      receivedAt,
      opportunityName,
      requestSummary,
      requestedService,
      siteName,
      siteAddressLine1,
      siteAddressLine2,
      siteCity,
      siteRegion,
      sitePostalCode,
      siteCountry,
      desiredDeadlineAt,
      requestedVisitAt,
      reviewerUserId,
      parties,
      createdByUserId: session.personaId,
      correlationId,
    });
    logger.info({ userId: session.personaId, leadId: record.lead.id }, "Phase 2.0 lead created");
    return apiJson({ lead: record }, correlationId, { status: 201 });
  } catch (error) {
    const mapped = leadMutationErrorStatus(error);
    if (mapped) return apiError(mapped.code, mapped.message, mapped.status, correlationId);
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Lead creation failed",
    );
    const diagnosticsAllowed = await canIncludeApiDiagnostics(runtime, authenticatedUserId);
    return apiException(error, 500, correlationId, diagnosticsAllowed);
  }
}
