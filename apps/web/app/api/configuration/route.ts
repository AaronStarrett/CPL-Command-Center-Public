import { type BeaServerRuntime, projectStagingRun } from "@bea/database";
import {
  isConfigurationArtifactKind,
  MAX_STAGING_SOURCE_BYTES,
  type JsonObject,
} from "@bea/domain";
import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { requestCorrelationId, requestSession, webRouteLogger } from "@/app/api/route-helpers";
import { apiError, apiException, apiJson } from "@/lib/api-response";
import { permissionForConfigurationAction } from "@/lib/configuration-access";
import { canIncludeApiDiagnostics } from "@/lib/diagnostics-authorization";
import { getOperationsServerRuntime, operationsMutationErrorStatus } from "@/lib/operations-api";
import { isSameOriginRequest, validateBoundedJsonMutation } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

export async function GET(request: NextRequest) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/configuration", "GET");
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
      PERMISSIONS.CONFIGURATION_VIEW,
    );
    if (!decision.allowed) {
      return apiError(
        "permission-not-granted",
        "The current role cannot view configuration.",
        403,
        correlationId,
      );
    }
    const view = request.nextUrl.searchParams.get("view") ?? "readiness";
    const releaseId = request.nextUrl.searchParams.get("releaseId");
    if (view === "readiness") {
      const [releases, readiness, intake, connectors] = await Promise.all([
        runtime.configuration.repository.listReleases(),
        runtime.configuration.repository.listReadinessItems(),
        runtime.configuration.repository.listIntakeItems(),
        runtime.operations.repository.listConnectorReadiness(),
      ]);
      return apiJson(
        {
          releases,
          readiness,
          intake,
          connectors,
          synthetic: true,
          productionConfigured: false,
        },
        correlationId,
      );
    }
    if (view === "releases") {
      const releases = await runtime.configuration.repository.listReleases();
      return apiJson({ releases, synthetic: true }, correlationId);
    }
    if (view === "release") {
      if (!releaseId) {
        return apiError("invalid-configuration", "A release id is required.", 400, correlationId);
      }
      const release = await runtime.configuration.repository.getRelease(releaseId);
      if (!release) {
        return apiError(
          "operations-not-found",
          "Configuration release was not found.",
          404,
          correlationId,
        );
      }
      const [artifacts, validationRuns, audit] = await Promise.all([
        runtime.configuration.repository.listArtifacts(releaseId),
        runtime.configuration.repository.listValidationRuns(releaseId),
        runtime.configuration.repository.listAudit(releaseId),
      ]);
      return apiJson(
        { release, artifacts, validationRuns, audit, synthetic: release.synthetic },
        correlationId,
      );
    }
    if (view === "intake") {
      const [intake, packet] = await Promise.all([
        runtime.configuration.repository.listIntakeItems(),
        runtime.configuration.exportIntake(),
      ]);
      return apiJson({ intake, packet, synthetic: true }, correlationId);
    }
    if (view === "staging") {
      const includeSensitive = (
        await runtime.authorization.authorizeUser(
          session.personaId,
          PERMISSIONS.CONFIGURATION_MAPPING_EDIT,
        )
      ).allowed;
      const stagingId = request.nextUrl.searchParams.get("stagingId");
      if (stagingId) {
        const run = await runtime.configuration.repository.getStagingRun(stagingId);
        if (!run) {
          return apiError("operations-not-found", "Staging run was not found.", 404, correlationId);
        }
        return apiJson(
          { staging: projectStagingRun(run, includeSensitive), synthetic: true },
          correlationId,
        );
      }
      const staging = await runtime.configuration.repository.listStagingRuns();
      return apiJson(
        {
          staging: staging.map((run) => projectStagingRun(run, includeSensitive)),
          synthetic: true,
        },
        correlationId,
      );
    }
    return apiError(
      "unknown-configuration-view",
      "Unknown configuration view. The request did not fall through to another handler.",
      400,
      correlationId,
    );
  } catch (error) {
    const mapped = operationsMutationErrorStatus(error);
    if (mapped) return apiError(mapped.code, mapped.message, mapped.status, correlationId);
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Configuration read failed",
    );
    const diagnosticsAllowed = await canIncludeApiDiagnostics(runtime, authenticatedUserId);
    return apiException(error, 500, correlationId, diagnosticsAllowed);
  }
}

export async function POST(request: NextRequest) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/configuration", "POST");
  let runtime: BeaServerRuntime | undefined;
  let authenticatedUserId: string | undefined;
  try {
    runtime = await getOperationsServerRuntime();
    const session = await requestSession(request);
    authenticatedUserId = session?.personaId;
    if (!isSameOriginRequest(request, runtime.environment.appBaseUrl)) {
      return apiError(
        "cross-origin-request-rejected",
        "Cross-origin configuration mutation was rejected.",
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
    const transport = validateBoundedJsonMutation(request, MAX_STAGING_SOURCE_BYTES + 65_536);
    if (!transport.ok) {
      return apiError(transport.code, transport.message, transport.status, correlationId);
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError("invalid-json", "The request body must be valid JSON.", 400, correlationId);
    }
    if (!body || typeof body !== "object") {
      return apiError(
        "invalid-configuration",
        "Configuration details are required.",
        400,
        correlationId,
      );
    }
    const input = body as Record<string, unknown>;
    const action = asString(input.action).trim();
    const mappedAction = permissionForConfigurationAction(action, {
      intakeStatus: asString(input.status),
    });
    if (!mappedAction) {
      return apiError(
        "unknown-configuration-action",
        "Unknown configuration action. The request did not fall through to another handler.",
        400,
        correlationId,
      );
    }
    const decision = await runtime.authorization.authorizeUser(
      session.personaId,
      mappedAction.permission,
    );
    if (!decision.allowed) {
      await runtime.repository.record({
        eventType: "authorization.denied",
        action: mappedAction.auditAction,
        outcome: "denied",
        actorUserId: session.personaId,
        resourceType: "configuration_release",
        resourceId: asString(input.releaseId) || null,
        correlationId,
        metadata: { permission: mappedAction.permission, reason: decision.reason },
      });
      return apiError("permission-not-granted", mappedAction.denyMessage, 403, correlationId);
    }

    const actorUserId = session.personaId;
    if (action === "create-draft") {
      const release = await runtime.configuration.createDraft({
        familyKey: asString(input.familyKey),
        displayName: asString(input.displayName),
        serviceContextKey: asString(input.serviceContextKey),
        description: asString(input.description),
        synthetic: input.synthetic !== false,
        actorUserId,
        correlationId,
      });
      return apiJson({ release, synthetic: release.synthetic }, correlationId, { status: 201 });
    }
    if (action === "clone") {
      const release = await runtime.configuration.cloneRelease({
        releaseId: asString(input.releaseId),
        actorUserId,
        correlationId,
      });
      return apiJson({ release, synthetic: release.synthetic }, correlationId, { status: 201 });
    }
    if (action === "update-artifact") {
      const kind = asString(input.kind);
      if (!isConfigurationArtifactKind(kind)) {
        return apiError(
          "invalid-configuration",
          "A controlled artifact kind is required.",
          400,
          correlationId,
        );
      }
      const release = await runtime.configuration.updateDraftArtifact({
        releaseId: asString(input.releaseId),
        kind,
        artifactKey: asString(input.artifactKey) || kind,
        payload: asObject(input.payload),
        expectedVersion: typeof input.expectedVersion === "number" ? input.expectedVersion : 0,
        actorUserId,
        correlationId,
      });
      return apiJson({ release, synthetic: release.synthetic }, correlationId);
    }
    if (action === "validate") {
      const result = await runtime.configuration.validateRelease({
        releaseId: asString(input.releaseId),
        actorUserId,
        correlationId,
      });
      return apiJson(result, correlationId);
    }
    if (action === "publish") {
      const release = await runtime.configuration.publishRelease({
        releaseId: asString(input.releaseId),
        actorUserId,
        correlationId,
      });
      return apiJson({ release, synthetic: release.synthetic }, correlationId);
    }
    if (action === "activate" || action === "rollback") {
      const release = await runtime.configuration.activateRelease({
        releaseId: asString(input.releaseId),
        actorUserId,
        correlationId,
        rollback: action === "rollback",
      });
      return apiJson({ release, synthetic: release.synthetic }, correlationId);
    }
    if (action === "archive") {
      const release = await runtime.configuration.archiveRelease({
        releaseId: asString(input.releaseId),
        actorUserId,
        correlationId,
      });
      return apiJson({ release, synthetic: release.synthetic }, correlationId);
    }
    if (action === "compare-releases") {
      const comparison = await runtime.configuration.compareReleases(
        asString(input.leftReleaseId),
        asString(input.rightReleaseId),
      );
      return apiJson(comparison, correlationId);
    }
    if (action === "dry-run-mapping") {
      const result = await runtime.configuration.dryRunMapping({
        releaseId: asString(input.releaseId),
        sourceType: asString(input.sourceType) || "json",
        raw: asString(input.raw),
        actorUserId,
        correlationId,
      });
      return apiJson({ ...result, inspectionCreated: false, synthetic: true }, correlationId);
    }
    if (action === "preview-report" || action === "replay-synthetic") {
      const result = await runtime.configuration.previewReport({
        releaseId: asString(input.releaseId),
        sourceType: asString(input.sourceType) || "json",
        raw: asString(input.raw),
      });
      return apiJson(
        {
          mapping: result.mapping,
          validation: result.validation,
          document: result.document,
          filename: result.rendered.filename,
          checksumSha256: result.rendered.checksumSha256,
          mimeType: result.rendered.mimeType,
          liveWrites: false,
          synthetic: true,
        },
        correlationId,
      );
    }
    if (action === "connector-dry-run") {
      const manifest = await runtime.configuration.connectorDryRun({
        releaseId: asString(input.releaseId),
        inspectionReference: asString(input.inspectionReference) || "BEA-IN-DRY",
        reportReference: asString(input.reportReference) || "BEA-RP-DRY",
        projectReference: asString(input.projectReference) || "BEA-PR-DRY",
        filename: asString(input.filename) || "synthetic-report.pdf",
        actorUserId,
        correlationId,
      });
      return apiJson({ manifest, liveWrites: false, synthetic: true }, correlationId);
    }
    if (action === "export-intake") {
      const packet = await runtime.configuration.exportIntake();
      return apiJson({ packet, synthetic: true }, correlationId);
    }
    if (action === "sla-preview") {
      const preview = await runtime.configuration.slaPreview(
        asString(input.releaseId),
        asString(input.startedAt) || new Date().toISOString(),
        asString(input.owner) || "Unassigned",
      );
      return apiJson({ preview, synthetic: true }, correlationId);
    }
    if (action === "create-inspection") {
      const inspection = await runtime.configuration.createInspection({
        projectId: asString(input.projectId),
        configurationReleaseId: asString(input.configurationReleaseId),
        inspectionType: asString(input.inspectionType),
        inspectorUserId: asString(input.inspectorUserId) || null,
        scheduledAt: asString(input.scheduledAt) || null,
        actorUserId,
        correlationId,
      });
      return apiJson({ inspection, synthetic: true }, correlationId, { status: 201 });
    }
    if (action === "update-inspection-setup") {
      const setupAction = asString(input.setupAction);
      if (
        setupAction !== "ready" &&
        setupAction !== "start" &&
        setupAction !== "complete" &&
        setupAction !== "checklist"
      ) {
        return apiError(
          "invalid-configuration",
          "A controlled inspection setup action is required.",
          400,
          correlationId,
        );
      }
      const inspection = await runtime.configuration.updateInspectionSetup({
        inspectionId: asString(input.inspectionId),
        action: setupAction,
        checklistKey: asString(input.checklistKey) || undefined,
        checklistStatus:
          asString(input.checklistStatus) === "complete" ||
          asString(input.checklistStatus) === "blocked" ||
          asString(input.checklistStatus) === "pending"
            ? (asString(input.checklistStatus) as "pending" | "complete" | "blocked")
            : undefined,
        actorUserId,
        correlationId,
      });
      return apiJson({ inspection, synthetic: true }, correlationId);
    }
    if (action === "commit-staged-inspection") {
      const committed = await runtime.configuration.commitStagedInspection({
        inspectionId: asString(input.inspectionId),
        sourceType: asString(input.sourceType) || "json",
        raw: asString(input.raw),
        actorUserId,
        correlationId,
      });
      return apiJson(
        {
          duplicate: committed.duplicate,
          newSubmissionCreated: committed.newSubmissionCreated,
          submissionId: committed.submissionId,
          inspectionId: committed.inspectionId,
          staging: committed.staging,
          mapping: committed.mapping,
          validation: committed.validation,
          synthetic: true,
        },
        correlationId,
        { status: committed.duplicate || !committed.newSubmissionCreated ? 200 : 201 },
      );
    }
    if (action === "reconcile-staging") {
      const staging = await runtime.configuration.reconcileStaging({
        stagingId: asString(input.stagingId),
        actorUserId,
        correlationId,
      });
      return apiJson({ staging, synthetic: true }, correlationId);
    }
    if (action === "retry-staging") {
      const retried = await runtime.configuration.retryStagingCommit({
        stagingId: asString(input.stagingId),
        actorUserId,
        correlationId,
      });
      return apiJson({ ...retried, synthetic: true }, correlationId);
    }
    if (action === "update-intake") {
      const item = await runtime.configuration.updateIntakeItem({
        itemId: asString(input.itemId),
        status: asString(input.status),
        answer: asString(input.answer) || null,
        notes: asString(input.notes) || null,
        expectedVersion: typeof input.expectedVersion === "number" ? input.expectedVersion : 0,
        actorUserId,
        correlationId,
      });
      return apiJson({ item, synthetic: true }, correlationId);
    }
    return apiError(
      "unknown-configuration-action",
      "Unknown configuration action. The request did not fall through to another handler.",
      400,
      correlationId,
    );
  } catch (error) {
    const mapped = operationsMutationErrorStatus(error);
    if (mapped) return apiError(mapped.code, mapped.message, mapped.status, correlationId);
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Configuration mutation failed",
    );
    const diagnosticsAllowed = await canIncludeApiDiagnostics(runtime, authenticatedUserId);
    return apiException(error, 500, correlationId, diagnosticsAllowed);
  }
}
