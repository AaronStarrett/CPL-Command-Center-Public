import { getServerRuntime, type BeaServerRuntime } from "@bea/database";
import { PERMISSIONS } from "@bea/security";
import { NextRequest, NextResponse } from "next/server";

import { requestCorrelationId, requestSession, webRouteLogger } from "@/app/api/route-helpers";
import { apiError, apiException } from "@/lib/api-response";
import { canIncludeApiDiagnostics } from "@/lib/diagnostics-authorization";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/operations/reports/[id]/artifact", "GET");
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
      PERMISSIONS.REPORTS_VIEW,
    );
    if (!decision.allowed) {
      return apiError(
        "permission-not-granted",
        "The current role cannot view report artifacts.",
        403,
        correlationId,
      );
    }
    const { id } = await context.params;
    const report = await runtime.operations.repository.getReport(id);
    if (!report) {
      return apiError("operations-not-found", "Report was not found.", 404, correlationId);
    }
    const versions = await runtime.operations.repository.listReportVersions(report.id);
    const current =
      versions.find((version) => version.versionNumber === report.currentVersionNumber) ??
      versions.at(-1);
    if (!current) {
      return apiError("operations-not-found", "Report version was not found.", 404, correlationId);
    }
    const artifact = await runtime.operations.repository.getRenderedArtifact(current.id);
    if (!artifact) {
      return apiError(
        "operations-not-found",
        "No rendered artifact is available for this report version.",
        404,
        correlationId,
      );
    }
    return new NextResponse(Buffer.from(artifact.bytes), {
      status: 200,
      headers: {
        "Content-Type": artifact.mimeType,
        "Content-Disposition": `inline; filename="${report.reference}.pdf"`,
        "X-Correlation-ID": correlationId,
        "Cache-Control": "no-store",
        "X-Frame-Options": "SAMEORIGIN",
        "Content-Security-Policy": "frame-ancestors 'self'",
        ...(artifact.checksum ? { "X-Artifact-Checksum": artifact.checksum } : {}),
      },
    });
  } catch (error) {
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Report artifact read failed",
    );
    const diagnosticsAllowed = await canIncludeApiDiagnostics(runtime, authenticatedUserId);
    return apiException(error, 500, correlationId, diagnosticsAllowed);
  }
}
