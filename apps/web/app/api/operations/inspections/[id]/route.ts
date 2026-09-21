import { getServerRuntime, type BeaServerRuntime } from "@bea/database";
import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { requestCorrelationId, requestSession, webRouteLogger } from "@/app/api/route-helpers";
import { apiError, apiException, apiJson } from "@/lib/api-response";
import { canIncludeApiDiagnostics } from "@/lib/diagnostics-authorization";
import {
  canViewInspectionSensitive,
  projectInspectionSubmission,
  projectReportVersions,
} from "@/lib/operations-access";
import { operationsMutationErrorStatus } from "@/lib/operations-api";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/operations/inspections/[id]", "GET");
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
      PERMISSIONS.INSPECTIONS_VIEW,
    );
    if (!decision.allowed) {
      return apiError(
        "permission-not-granted",
        "The current role cannot view inspections.",
        403,
        correlationId,
      );
    }
    const { id } = await context.params;
    const inspection = await runtime.operations.repository.getInspection(id);
    if (!inspection) {
      return apiError("operations-not-found", "Inspection was not found.", 404, correlationId);
    }
    const [
      project,
      submission,
      validation,
      report,
      sla,
      findings,
      evidence,
      exceptions,
      events,
      jobs,
    ] = await Promise.all([
      runtime.operations.repository.getProject(inspection.projectId),
      runtime.operations.repository.getLatestSubmission(inspection.id),
      runtime.operations.repository.latestValidation(inspection.id),
      runtime.operations.repository.getReportByInspection(inspection.id),
      runtime.operations.repository.getSlaClock(inspection.id),
      runtime.operations.repository
        .getLatestSubmission(inspection.id)
        .then((latest) =>
          latest ? runtime!.operations.repository.listFindings(latest.id) : Promise.resolve([]),
        ),
      runtime.operations.repository
        .getLatestSubmission(inspection.id)
        .then((latest) =>
          latest ? runtime!.operations.repository.listEvidence(latest.id) : Promise.resolve([]),
        ),
      runtime.operations.repository.listExceptionsForInspection(inspection.id),
      runtime.operations.repository.listTimeline(inspection.id),
      runtime.operations.repository.listJobsForInspection(inspection.id),
    ]);
    const versions = report
      ? await runtime.operations.repository.listReportVersions(report.id)
      : [];
    const deliveries = report ? await runtime.operations.repository.listDeliveries(report.id) : [];
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
        inspection,
        project,
        ...projected,
        validation,
        report,
        versions: projectReportVersions({ canViewSensitive, versions }),
        deliveries,
        sla,
        exceptions,
        events,
        jobs,
        synthetic: runtime.environment.appMode === "demo",
      },
      correlationId,
    );
  } catch (error) {
    const mapped = operationsMutationErrorStatus(error);
    if (mapped) return apiError(mapped.code, mapped.message, mapped.status, correlationId);
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Inspection read failed",
    );
    const diagnosticsAllowed = await canIncludeApiDiagnostics(runtime, authenticatedUserId);
    return apiException(error, 500, correlationId, diagnosticsAllowed);
  }
}
