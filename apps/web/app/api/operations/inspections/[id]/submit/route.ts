import {
  completeSyntheticSubmissionPayload,
  getServerRuntime,
  incompleteSyntheticSubmissionPayload,
  type BeaServerRuntime,
} from "@bea/database";
import type { JsonObject } from "@bea/domain";
import { PERMISSIONS, type Permission } from "@bea/security";
import { NextRequest } from "next/server";

import { requestCorrelationId, requestSession, webRouteLogger } from "@/app/api/route-helpers";
import { apiError, apiException, apiJson } from "@/lib/api-response";
import { canIncludeApiDiagnostics } from "@/lib/diagnostics-authorization";
import { operationsMutationErrorStatus } from "@/lib/operations-api";
import { isSameOriginRequest } from "@/lib/request-security";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/operations/inspections/[id]/submit", "POST");
  let runtime: BeaServerRuntime | undefined;
  let authenticatedUserId: string | undefined;
  try {
    runtime = await getServerRuntime();
    const session = await requestSession(request);
    authenticatedUserId = session?.personaId;
    if (!isSameOriginRequest(request, runtime.environment.appBaseUrl)) {
      return apiError(
        "cross-origin-request-rejected",
        "Cross-origin inspection submission was rejected.",
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
        "invalid-operations",
        "Inspection submission details are required.",
        400,
        correlationId,
      );
    }
    const input = body as Record<string, unknown>;
    const { id } = await context.params;
    const inspection = await runtime.operations.repository.getInspection(id);
    if (!inspection) {
      return apiError("operations-not-found", "Inspection was not found.", 404, correlationId);
    }
    const permission: Permission =
      inspection.status === "needs_correction"
        ? PERMISSIONS.INSPECTIONS_CORRECT
        : PERMISSIONS.INSPECTIONS_SUBMIT;
    const decision = await runtime.authorization.authorizeUser(session.personaId, permission);
    if (!decision.allowed) {
      await runtime.repository.record({
        eventType: "authorization.denied",
        action: "inspection.submit",
        outcome: "denied",
        actorUserId: session.personaId,
        resourceType: "inspection",
        resourceId: id,
        correlationId,
        metadata: { permission, reason: decision.reason },
      });
      return apiError(
        "permission-not-granted",
        "The current role cannot submit this inspection.",
        403,
        correlationId,
      );
    }
    const fixture =
      input.fixture === "incomplete"
        ? "incomplete"
        : input.fixture === "complete"
          ? "complete"
          : null;
    let payload: JsonObject | null =
      fixture === "complete"
        ? completeSyntheticSubmissionPayload()
        : fixture === "incomplete"
          ? incompleteSyntheticSubmissionPayload()
          : input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
            ? (input.payload as JsonObject)
            : null;
    if (payload && fixture) {
      if (inspection.completedAt) {
        payload = { ...payload, completedAt: inspection.completedAt };
      }
      if (inspection.status === "needs_correction") {
        payload = { ...payload, correctionSubmittedAt: new Date().toISOString() };
      }
    }
    if (!payload) {
      return apiError(
        "invalid-operations",
        "A submission payload or labeled synthetic fixture is required.",
        400,
        correlationId,
      );
    }
    const sourceIdempotencyKey =
      typeof input.sourceIdempotencyKey === "string" && input.sourceIdempotencyKey.trim()
        ? input.sourceIdempotencyKey.trim()
        : `${fixture ?? "direct"}:${id}:${correlationId}`;
    const sourceChannel =
      typeof input.sourceChannel === "string" && input.sourceChannel.trim()
        ? input.sourceChannel.trim()
        : "direct_entry";
    const result = await runtime.operations.submitInspection({
      inspectionId: id,
      sourceChannel,
      sourceIdempotencyKey,
      payload,
      actorUserId: session.personaId,
      correlationId,
    });
    logger.info(
      {
        userId: session.personaId,
        inspectionId: id,
        duplicate: result.duplicate,
        fixture,
      },
      "Inspection submission recorded",
    );
    return apiJson(
      {
        ...result,
        synthetic: runtime.environment.appMode === "demo",
      },
      correlationId,
      { status: result.duplicate ? 200 : 201 },
    );
  } catch (error) {
    const mapped = operationsMutationErrorStatus(error);
    if (mapped) return apiError(mapped.code, mapped.message, mapped.status, correlationId);
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Inspection submission failed",
    );
    const diagnosticsAllowed = await canIncludeApiDiagnostics(runtime, authenticatedUserId);
    return apiException(error, 500, correlationId, diagnosticsAllowed);
  }
}
