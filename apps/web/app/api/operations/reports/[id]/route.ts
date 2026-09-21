import { type BeaServerRuntime } from "@bea/database";
import { PERMISSIONS, type Permission } from "@bea/security";
import { NextRequest } from "next/server";

import { requestCorrelationId, requestSession, webRouteLogger } from "@/app/api/route-helpers";
import { apiError, apiException, apiJson } from "@/lib/api-response";
import { canIncludeApiDiagnostics } from "@/lib/diagnostics-authorization";
import {
  canViewInspectionSensitive,
  projectInspectionSubmission,
  projectReportVersions,
} from "@/lib/operations-access";
import { getOperationsServerRuntime, operationsMutationErrorStatus } from "@/lib/operations-api";
import { isSameOriginRequest } from "@/lib/request-security";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/operations/reports/[id]", "GET");
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
      PERMISSIONS.REPORTS_VIEW,
    );
    if (!decision.allowed) {
      return apiError(
        "permission-not-granted",
        "The current role cannot view reports.",
        403,
        correlationId,
      );
    }
    const { id } = await context.params;
    const report = await runtime.operations.repository.getReport(id);
    if (!report) {
      return apiError("operations-not-found", "Report was not found.", 404, correlationId);
    }
    const [inspection, project, versions, deliveries, events, jobs] = await Promise.all([
      runtime.operations.repository.getInspection(report.inspectionId),
      runtime.operations.repository.getProject(report.projectId),
      runtime.operations.repository.listReportVersions(report.id),
      runtime.operations.repository.listDeliveries(report.id),
      runtime.operations.repository.listTimeline(report.inspectionId),
      runtime.operations.repository.listJobsForInspection(report.inspectionId),
    ]);
    const submission = await runtime.operations.repository.getLatestSubmission(report.inspectionId);
    const findings = submission
      ? await runtime.operations.repository.listFindings(submission.id)
      : [];
    const evidence = submission
      ? await runtime.operations.repository.listEvidence(submission.id)
      : [];
    const validation = await runtime.operations.repository.latestValidation(report.inspectionId);
    const canViewSensitive = canViewInspectionSensitive({
      roleIds: session.roleIds,
      userId: session.personaId,
    });
    const projected = projectInspectionSubmission({
      canViewSensitive,
      submission,
      findings,
      evidence,
    });
    return apiJson(
      {
        report,
        inspection,
        project,
        versions: projectReportVersions({ canViewSensitive, versions }),
        deliveries,
        events,
        jobs,
        ...projected,
        validation,
        synthetic: runtime.environment.appMode === "demo",
      },
      correlationId,
    );
  } catch (error) {
    const mapped = operationsMutationErrorStatus(error);
    if (mapped) return apiError(mapped.code, mapped.message, mapped.status, correlationId);
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Report read failed",
    );
    const diagnosticsAllowed = await canIncludeApiDiagnostics(runtime, authenticatedUserId);
    return apiException(error, 500, correlationId, diagnosticsAllowed);
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/operations/reports/[id]", "POST");
  let runtime: BeaServerRuntime | undefined;
  let authenticatedUserId: string | undefined;
  try {
    runtime = await getOperationsServerRuntime();
    const session = await requestSession(request);
    authenticatedUserId = session?.personaId;
    if (!isSameOriginRequest(request, runtime.environment.appBaseUrl)) {
      return apiError(
        "cross-origin-request-rejected",
        "Cross-origin report review was rejected.",
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
      return apiError("invalid-operations", "Review details are required.", 400, correlationId);
    }
    const input = body as Record<string, unknown>;
    const { id } = await context.params;
    const action =
      typeof input.action === "string" && input.action.trim() ? input.action.trim() : "";

    async function deny(permission: Permission, message: string, auditAction: string) {
      const decision = await runtime!.authorization.authorizeUser(session!.personaId, permission);
      if (decision.allowed) return null;
      await runtime!.repository.record({
        eventType: "authorization.denied",
        action: auditAction,
        outcome: "denied",
        actorUserId: session!.personaId,
        resourceType: "report",
        resourceId: id,
        correlationId,
        metadata: { permission, reason: decision.reason },
      });
      return apiError("permission-not-granted", message, 403, correlationId);
    }

    if (action === "retry-delivery") {
      const denied = await deny(
        PERMISSIONS.REPORTS_DELIVER,
        "The current role cannot retry report delivery.",
        "report.retry-delivery",
      );
      if (denied) return denied;
      await runtime.operations.retryDelivery({
        reportId: id,
        actorUserId: session.personaId,
        correlationId,
      });
      const report = await runtime.operations.repository.getReport(id);
      return apiJson({ report, synthetic: runtime.environment.appMode === "demo" }, correlationId);
    }
    if (action === "authorize-delivery") {
      const denied = await deny(
        PERMISSIONS.REPORTS_DELIVER,
        "The current role cannot authorize report delivery.",
        "report.authorize-delivery",
      );
      if (denied) return denied;
      const authorized = await runtime.operations.authorizeDelivery({
        reportId: id,
        actorUserId: session.personaId,
        correlationId,
      });
      return apiJson(
        { ...authorized, synthetic: runtime.environment.appMode === "demo" },
        correlationId,
      );
    }
    if (action === "revoke-delivery-authorization") {
      const denied = await deny(
        PERMISSIONS.REPORTS_DELIVER,
        "The current role cannot revoke delivery authorization.",
        "report.revoke-delivery-authorization",
      );
      if (denied) return denied;
      await runtime.operations.revokeDeliveryAuthorization({
        reportId: id,
        actorUserId: session.personaId,
        correlationId,
      });
      const report = await runtime.operations.repository.getReport(id);
      return apiJson({ report, synthetic: runtime.environment.appMode === "demo" }, correlationId);
    }
    const decisionValue =
      action === "technical-approve"
        ? "approve"
        : action === "request-revision"
          ? "request_revision"
          : action === "return-to-inspector"
            ? "return_to_inspector"
            : typeof input.decision === "string"
              ? input.decision
              : "";
    const permission =
      decisionValue === "approve" ? PERMISSIONS.REPORTS_APPROVE : PERMISSIONS.REPORTS_REVIEW;
    const decision = await runtime.authorization.authorizeUser(session.personaId, permission);
    if (!decision.allowed) {
      await runtime.repository.record({
        eventType: "authorization.denied",
        action: "report.review",
        outcome: "denied",
        actorUserId: session.personaId,
        resourceType: "report",
        correlationId,
        metadata: { permission, reason: decision.reason, decision: decisionValue },
      });
      return apiError(
        "permission-not-granted",
        "The current role cannot review this report.",
        403,
        correlationId,
      );
    }
    const reviewed = await runtime.operations.reviewReport({
      reportId: id,
      decision: decisionValue,
      comment: typeof input.comment === "string" ? input.comment : null,
      actorUserId: session.personaId,
      correlationId,
      ...(typeof input.expectedVersion === "number"
        ? { expectedVersion: input.expectedVersion }
        : {}),
    });
    logger.info(
      { userId: session.personaId, reportId: id, decision: decisionValue },
      "Report review recorded",
    );
    return apiJson(
      { ...reviewed, synthetic: runtime.environment.appMode === "demo" },
      correlationId,
    );
  } catch (error) {
    const mapped = operationsMutationErrorStatus(error);
    if (mapped) return apiError(mapped.code, mapped.message, mapped.status, correlationId);
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Report mutation failed",
    );
    const diagnosticsAllowed = await canIncludeApiDiagnostics(runtime, authenticatedUserId);
    return apiException(error, 500, correlationId, diagnosticsAllowed);
  }
}
