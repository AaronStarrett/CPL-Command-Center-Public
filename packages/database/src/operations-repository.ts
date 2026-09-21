import { createHash, randomUUID } from "node:crypto";
import type {
  ActorType,
  AutomationBlueprint,
  AutomationEvent,
  AutomationJob,
  AutomationJobStatus,
  AutomationJobType,
  BlueprintKey,
  ConnectorReadinessRecord,
  DeliveryAuthorization,
  ExceptionCase,
  Inspection,
  InspectionEvidence,
  InspectionFinding,
  InspectionReport,
  InspectionSubmission,
  InspectionValidationItem,
  InspectionValidationResult,
  JsonObject,
  NormalizedInspectionPayload,
  OperationsEventType,
  Project,
  ReportDelivery,
  ReportRequirementSet,
  ReportReviewComment,
  ReportTemplateVersion,
  ReportVersion,
  SlaClock,
  SlaStageInterval,
  TurnaroundBoardItem,
  TurnaroundBoardWorkProjection,
  TurnaroundMetrics,
} from "@bea/domain";
import {
  DEFAULT_REPORT_SLA_TARGET_MINUTES,
  DEFAULT_SLA_CLOCK_KIND,
  elapsedMs,
  pausedDurationMs,
  slaElapsedMs,
  slaRemainingMs,
} from "@bea/domain";
import type { DatabaseAdapter, SqlExecutor } from "./adapter.js";

type Row = Record<string, unknown>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

export function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

export function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function jsonValue<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

export function hashJson(value: JsonObject): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function requiredUuid(value: string, name: string): string {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (!UUID_PATTERN.test(normalized)) {
    throw new Error(`${name} must be a canonical UUID.`);
  }
  return normalized;
}

export async function nextOperationsReference(
  executor: SqlExecutor,
  sequence:
    | "bea_project_reference_seq"
    | "bea_inspection_reference_seq"
    | "bea_report_reference_seq"
    | "bea_exception_reference_seq"
    | "bea_work_item_reference_seq",
  prefix: string,
): Promise<string> {
  const result = await executor.query<{ value: string | number }>(
    `SELECT nextval('${sequence}') AS value`,
  );
  const sequenceValue = Number(result.rows[0]?.value ?? 0);
  return `${prefix}${String(sequenceValue).padStart(6, "0")}`;
}

export function mapProject(row: Row): Project {
  return {
    id: String(row.id),
    reference: String(row.reference),
    leadId: nullableString(row.lead_id),
    companyId: nullableString(row.company_id),
    contactId: nullableString(row.contact_id),
    name: String(row.name),
    clientName: String(row.client_name),
    siteName: String(row.site_name),
    siteCity: nullableString(row.site_city),
    siteRegion: nullableString(row.site_region),
    serviceKey: String(row.service_key),
    status: row.status as Project["status"],
    acceptedScopeSnapshot: jsonValue(row.accepted_scope_snapshot, {}),
    createdByUserId: String(row.created_by_user_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

export function mapInspection(row: Row): Inspection {
  return {
    id: String(row.id),
    reference: String(row.reference),
    projectId: String(row.project_id),
    status: row.status as Inspection["status"],
    inspectorUserId: nullableString(row.inspector_user_id),
    reviewerUserId: nullableString(row.reviewer_user_id),
    scheduledAt: nullableIso(row.scheduled_at),
    startedAt: nullableIso(row.started_at),
    completedAt: nullableIso(row.completed_at),
    submittedAt: nullableIso(row.submitted_at),
    serviceKey: String(row.service_key),
    reportTemplateId: String(row.report_template_id),
    configurationReleaseId: nullableString(row.configuration_release_id),
    inspectionType: nullableString(row.inspection_type),
    readinessChecklist: jsonValue(row.readiness_checklist, null),
    createdByUserId: String(row.created_by_user_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

export function mapSubmission(row: Row): InspectionSubmission {
  return {
    id: String(row.id),
    inspectionId: String(row.inspection_id),
    sourceChannel: row.source_channel as InspectionSubmission["sourceChannel"],
    sourceIdempotencyKey: String(row.source_idempotency_key),
    payloadSha256: String(row.payload_sha256),
    rawPayload: jsonValue(row.raw_payload, {}),
    schemaVersion: String(row.schema_version),
    mappingVersion: String(row.mapping_version),
    normalizedPayload: jsonValue(row.normalized_payload, {}),
    configurationReleaseId: nullableString(row.configuration_release_id),
    sourceLineage: jsonValue(row.source_lineage, null),
    actorUserId: nullableString(row.actor_user_id),
    correlationId: nullableString(row.correlation_id),
    createdAt: iso(row.created_at),
  };
}

export function mapFinding(row: Row): InspectionFinding {
  return {
    id: String(row.id),
    submissionId: String(row.submission_id),
    inspectionId: String(row.inspection_id),
    code: String(row.code),
    sectionKey: String(row.section_key),
    title: String(row.title),
    description: String(row.description),
    severity: row.severity as InspectionFinding["severity"],
    location: nullableString(row.location),
    sortOrder: Number(row.sort_order),
    createdAt: iso(row.created_at),
  };
}

export function mapEvidence(row: Row): InspectionEvidence {
  return {
    id: String(row.id),
    submissionId: String(row.submission_id),
    inspectionId: String(row.inspection_id),
    findingId: nullableString(row.finding_id),
    kind: row.kind as InspectionEvidence["kind"],
    filename: String(row.filename),
    contentType: String(row.content_type),
    sha256: String(row.sha256),
    byteLength: Number(row.byte_length),
    storageRef: String(row.storage_ref),
    createdAt: iso(row.created_at),
  };
}

export function mapReport(row: Row): InspectionReport {
  return {
    id: String(row.id),
    reference: String(row.reference),
    inspectionId: String(row.inspection_id),
    projectId: String(row.project_id),
    templateId: String(row.template_id),
    currentTemplateVersionId: String(row.current_template_version_id),
    configurationReleaseId: nullableString(row.configuration_release_id),
    status: row.status as InspectionReport["status"],
    currentVersionNumber: Number(row.current_version_number),
    createdByUserId: nullableString(row.created_by_user_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

export function mapReportVersion(row: Row): ReportVersion {
  return {
    id: String(row.id),
    reportId: String(row.report_id),
    versionNumber: Number(row.version_number),
    status: row.status as ReportVersion["status"],
    inputSnapshot: jsonValue(row.input_snapshot, {}),
    templateVersionId: String(row.template_version_id),
    submissionId: String(row.submission_id),
    configurationReleaseId: nullableString(row.configuration_release_id),
    renderedChecksum: nullableString(row.rendered_checksum),
    renderedStorageRef: nullableString(row.rendered_storage_ref),
    renderedMimeType: nullableString(row.rendered_mime_type),
    reviewerUserId: nullableString(row.reviewer_user_id),
    reviewedAt: nullableIso(row.reviewed_at),
    reviewDecision: (row.review_decision as ReportVersion["reviewDecision"]) ?? null,
    reviewComment: nullableString(row.review_comment),
    createdAt: iso(row.created_at),
  };
}

export function mapDelivery(row: Row): ReportDelivery {
  return {
    id: String(row.id),
    reportId: String(row.report_id),
    reportVersionId: String(row.report_version_id),
    idempotencyKey: String(row.idempotency_key),
    adapterKey: String(row.adapter_key),
    status: row.status as ReportDelivery["status"],
    recipients: jsonValue(row.recipients, []),
    subject: String(row.subject),
    artifactChecksum: nullableString(row.artifact_checksum),
    externalMessageId: nullableString(row.external_message_id),
    attemptedAt: nullableIso(row.attempted_at),
    confirmedAt: nullableIso(row.confirmed_at),
    error: jsonValue(row.error, null),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

export function mapDeliveryAuthorization(row: Row): DeliveryAuthorization {
  return {
    id: String(row.id),
    reportId: String(row.report_id),
    reportVersionId: String(row.report_version_id),
    artifactChecksum: String(row.artifact_checksum),
    recipients: jsonValue(row.recipients, []),
    destinationKind: row.destination_kind as DeliveryAuthorization["destinationKind"],
    authorizingUserId: String(row.authorizing_user_id),
    authorizedAt: iso(row.authorized_at),
    status: row.status as DeliveryAuthorization["status"],
    consumedAt: nullableIso(row.consumed_at),
    consumedByJobId: nullableString(row.consumed_by_job_id),
    reservedToken: nullableString(row.reserved_token),
    reservedAt: nullableIso(row.reserved_at),
    revokedAt: nullableIso(row.revoked_at),
    revokedByUserId: nullableString(row.revoked_by_user_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

export function mapStageInterval(row: Row): SlaStageInterval {
  return {
    id: String(row.id),
    clockId: String(row.clock_id),
    stageKey: String(row.stage_key),
    startedAt: iso(row.started_at),
    endedAt: nullableIso(row.ended_at),
    durationMs:
      row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    attribution: row.attribution as SlaStageInterval["attribution"],
  };
}

export function mapException(row: Row): ExceptionCase {
  return {
    id: String(row.id),
    reference: String(row.reference),
    kind: row.kind as ExceptionCase["kind"],
    status: row.status as ExceptionCase["status"],
    severity: row.severity as ExceptionCase["severity"],
    title: String(row.title),
    detail: String(row.detail),
    inspectionId: nullableString(row.inspection_id),
    reportId: nullableString(row.report_id),
    projectId: nullableString(row.project_id),
    deliveryId: nullableString(row.delivery_id),
    jobId: nullableString(row.job_id),
    ownerUserId: nullableString(row.owner_user_id),
    ownerDisplayName: nullableString(row.owner_display_name),
    slaAttribution: row.sla_attribution as ExceptionCase["slaAttribution"],
    resolvedAt: nullableIso(row.resolved_at),
    resolution: nullableString(row.resolution),
    resolvedByUserId: nullableString(row.resolved_by_user_id),
    resolvedByActorType:
      (row.resolved_by_actor_type as ExceptionCase["resolvedByActorType"]) ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

export function mapSlaClock(row: Row): SlaClock {
  return {
    id: String(row.id),
    reportId: nullableString(row.report_id),
    inspectionId: String(row.inspection_id),
    clockKind: row.clock_kind as SlaClock["clockKind"],
    targetMinutes: Number(row.target_minutes),
    startedAt: iso(row.started_at),
    pausedAt: nullableIso(row.paused_at),
    pauseReason: (row.pause_reason as SlaClock["pauseReason"]) ?? null,
    pausedTotalMs: Number(row.paused_total_ms ?? 0),
    stoppedAt: nullableIso(row.stopped_at),
    status: row.status as SlaClock["status"],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

export function mapEvent(row: Row): AutomationEvent {
  return {
    id: String(row.id),
    eventType: row.event_type as OperationsEventType,
    schemaVersion: String(row.schema_version),
    aggregateType: String(row.aggregate_type),
    aggregateId: String(row.aggregate_id),
    correlationId: String(row.correlation_id),
    causationId: nullableString(row.causation_id),
    occurredAt: iso(row.occurred_at),
    recordedAt: iso(row.recorded_at),
    actorType: row.actor_type as ActorType,
    actorId: nullableString(row.actor_id),
    payload: jsonValue(row.payload, {}),
    processingStatus: row.processing_status as AutomationEvent["processingStatus"],
    projectionAttemptCount: Number(row.projection_attempt_count ?? 0),
    projectionFirstFailedAt: nullableIso(row.projection_first_failed_at),
    projectionLastFailedAt: nullableIso(row.projection_last_failed_at),
    projectionNextRetryAt: nullableIso(row.projection_next_retry_at),
    projectionErrorCode: nullableString(row.projection_error_code),
    projectionErrorMessage: nullableString(row.projection_error_message),
    projectionRetryable:
      row.projection_retryable === null || row.projection_retryable === undefined
        ? null
        : row.projection_retryable === true ||
          row.projection_retryable === "t" ||
          row.projection_retryable === 1 ||
          row.projection_retryable === "1",
    projectionDeadLetteredAt: nullableIso(row.projection_dead_lettered_at),
  };
}

export function mapJob(row: Row): AutomationJob {
  return {
    id: String(row.id),
    jobType: row.job_type as AutomationJobType,
    blueprintKey: row.blueprint_key as BlueprintKey,
    blueprintVersion: Number(row.blueprint_version),
    aggregateType: String(row.aggregate_type),
    aggregateId: String(row.aggregate_id),
    eventId: nullableString(row.event_id),
    idempotencyKey: String(row.idempotency_key),
    status: row.status as AutomationJobStatus,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    availableAt: iso(row.available_at),
    claimedAt: nullableIso(row.claimed_at),
    claimedBy: nullableString(row.claimed_by),
    leaseExpiresAt: nullableIso(row.lease_expires_at),
    finishedAt: nullableIso(row.finished_at),
    lastError: jsonValue(row.last_error, null),
    payload: jsonValue(row.payload, {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

export function mapBlueprint(row: Row): AutomationBlueprint {
  return {
    id: String(row.id),
    key: row.key as BlueprintKey,
    displayName: String(row.display_name),
    blueprintVersion: Number(row.blueprint_version),
    status: row.status as AutomationBlueprint["status"],
    triggerEventType: row.trigger_event_type as OperationsEventType,
    actions: jsonValue(row.actions, []),
    parameters: jsonValue(row.parameters, {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

export function mapConnector(row: Row): ConnectorReadinessRecord {
  return {
    id: String(row.id),
    integrationConnectionId: nullableString(row.integration_connection_id),
    providerType: String(row.provider_type),
    displayName: String(row.display_name),
    readinessStatus: row.readiness_status as ConnectorReadinessRecord["readinessStatus"],
    lastDryRunAt: nullableIso(row.last_dry_run_at),
    lastActivationAt: nullableIso(row.last_activation_at),
    lastSuccessfulSyncAt: nullableIso(row.last_successful_sync_at),
    lastError: jsonValue(row.last_error, null),
    subscriptionStatus: nullableString(row.subscription_status),
    subscriptionExpiresAt: nullableIso(row.subscription_expires_at),
    requiredAction: nullableString(row.required_action),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

export function mapTemplateVersion(row: Row): ReportTemplateVersion {
  return {
    id: String(row.id),
    templateId: String(row.template_id),
    versionNumber: Number(row.version_number),
    mapping: jsonValue(row.mapping, {}),
    requirements: jsonValue(row.requirements, {
      minFindings: 1,
      minEvidence: 1,
      requireSignature: true,
      requireInspectorName: true,
      requireClientName: true,
      requireSiteName: true,
      requireCompletedAt: true,
      requireAttestation: true,
    } satisfies ReportRequirementSet),
    rendererKey: String(row.renderer_key),
    disclosure: String(row.disclosure),
    createdAt: iso(row.created_at),
  };
}

export class SqlOperationsRepository {
  constructor(private readonly database: DatabaseAdapter) {}

  async getProject(id: string): Promise<Project | null> {
    const result = await this.database.query<Row>("SELECT * FROM projects WHERE id=$1", [id]);
    return result.rows[0] ? mapProject(result.rows[0]) : null;
  }

  async listProjects(): Promise<readonly Project[]> {
    const result = await this.database.query<Row>(
      "SELECT * FROM projects ORDER BY created_at DESC",
    );
    return result.rows.map(mapProject);
  }

  async getInspection(id: string): Promise<Inspection | null> {
    const result = await this.database.query<Row>("SELECT * FROM inspections WHERE id=$1", [id]);
    return result.rows[0] ? mapInspection(result.rows[0]) : null;
  }

  async listInspections(): Promise<readonly Inspection[]> {
    const result = await this.database.query<Row>(
      "SELECT * FROM inspections ORDER BY created_at DESC",
    );
    return result.rows.map(mapInspection);
  }

  async getLatestSubmission(inspectionId: string): Promise<InspectionSubmission | null> {
    const result = await this.database.query<Row>(
      "SELECT * FROM inspection_submissions WHERE inspection_id=$1 ORDER BY created_at DESC LIMIT 1",
      [inspectionId],
    );
    return result.rows[0] ? mapSubmission(result.rows[0]) : null;
  }

  async getSubmission(id: string): Promise<InspectionSubmission | null> {
    const result = await this.database.query<Row>(
      "SELECT * FROM inspection_submissions WHERE id=$1",
      [id],
    );
    return result.rows[0] ? mapSubmission(result.rows[0]) : null;
  }

  async listReports(): Promise<readonly InspectionReport[]> {
    const result = await this.database.query<Row>(
      "SELECT * FROM inspection_reports ORDER BY created_at DESC",
    );
    return result.rows.map(mapReport);
  }

  async listTimeline(inspectionId: string): Promise<readonly AutomationEvent[]> {
    const result = await this.database.query<Row>(
      `SELECT * FROM automation_events
        WHERE (aggregate_type='inspection' AND aggregate_id=$1)
           OR (aggregate_type='report' AND aggregate_id IN (SELECT id FROM inspection_reports WHERE inspection_id=$1))
           OR (aggregate_type='exception' AND aggregate_id IN (SELECT id FROM exception_cases WHERE inspection_id=$1))
        ORDER BY occurred_at, recorded_at`,
      [inspectionId],
    );
    return result.rows.map(mapEvent);
  }

  async listJobsForInspection(inspectionId: string): Promise<readonly AutomationJob[]> {
    const result = await this.database.query<Row>(
      `SELECT * FROM automation_jobs
        WHERE aggregate_id=$1
           OR aggregate_id IN (SELECT id FROM inspection_reports WHERE inspection_id=$1)
        ORDER BY created_at`,
      [inspectionId],
    );
    return result.rows.map(mapJob);
  }

  async listExceptionsForInspection(inspectionId: string): Promise<readonly ExceptionCase[]> {
    const result = await this.database.query<Row>(
      `SELECT exception_cases.*, users.display_name AS owner_display_name
         FROM exception_cases
         LEFT JOIN users ON users.id = exception_cases.owner_user_id
        WHERE exception_cases.inspection_id=$1
        ORDER BY exception_cases.created_at DESC`,
      [inspectionId],
    );
    return result.rows.map(mapException);
  }

  async getSubmissionByIdempotency(
    inspectionId: string,
    key: string,
  ): Promise<InspectionSubmission | null> {
    const result = await this.database.query<Row>(
      "SELECT * FROM inspection_submissions WHERE inspection_id=$1 AND source_idempotency_key=$2",
      [inspectionId, key],
    );
    return result.rows[0] ? mapSubmission(result.rows[0]) : null;
  }

  async getSubmissionByHash(
    inspectionId: string,
    hash: string,
  ): Promise<InspectionSubmission | null> {
    const result = await this.database.query<Row>(
      "SELECT * FROM inspection_submissions WHERE inspection_id=$1 AND payload_sha256=$2",
      [inspectionId, hash],
    );
    return result.rows[0] ? mapSubmission(result.rows[0]) : null;
  }

  async listFindings(submissionId: string): Promise<readonly InspectionFinding[]> {
    const result = await this.database.query<Row>(
      "SELECT * FROM inspection_findings WHERE submission_id=$1 ORDER BY sort_order, created_at",
      [submissionId],
    );
    return result.rows.map(mapFinding);
  }

  async listEvidence(submissionId: string): Promise<readonly InspectionEvidence[]> {
    const result = await this.database.query<Row>(
      "SELECT * FROM inspection_evidence WHERE submission_id=$1 ORDER BY created_at",
      [submissionId],
    );
    return result.rows.map(mapEvidence);
  }

  async latestValidation(inspectionId: string): Promise<InspectionValidationResult | null> {
    const result = await this.database.query<Row>(
      "SELECT * FROM inspection_validation_results WHERE inspection_id=$1 ORDER BY created_at DESC LIMIT 1",
      [inspectionId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      submissionId: String(row.submission_id),
      inspectionId: String(row.inspection_id),
      passed: row.passed === true || row.passed === "t",
      ruleSetKey: String(row.rule_set_key),
      ruleSetVersion: String(row.rule_set_version),
      blocking: jsonValue<InspectionValidationItem[]>(row.blocking, []),
      optional: jsonValue<InspectionValidationItem[]>(row.optional_items, []),
      createdAt: iso(row.created_at),
    };
  }

  async getReportByInspection(inspectionId: string): Promise<InspectionReport | null> {
    const result = await this.database.query<Row>(
      "SELECT * FROM inspection_reports WHERE inspection_id=$1",
      [inspectionId],
    );
    return result.rows[0] ? mapReport(result.rows[0]) : null;
  }

  async getReport(id: string): Promise<InspectionReport | null> {
    const result = await this.database.query<Row>("SELECT * FROM inspection_reports WHERE id=$1", [
      id,
    ]);
    return result.rows[0] ? mapReport(result.rows[0]) : null;
  }

  async listReportVersions(reportId: string): Promise<readonly ReportVersion[]> {
    const result = await this.database.query<Row>(
      "SELECT * FROM report_versions WHERE report_id=$1 ORDER BY version_number",
      [reportId],
    );
    return result.rows.map(mapReportVersion);
  }

  async listReviewComments(reportVersionId: string): Promise<readonly ReportReviewComment[]> {
    const result = await this.database.query<Row>(
      `SELECT * FROM report_review_comments
        WHERE report_version_id=$1
        ORDER BY created_at`,
      [reportVersionId],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      reportVersionId: String(row.report_version_id),
      authorUserId: String(row.author_user_id),
      sectionKey: nullableString(row.section_key),
      findingId: nullableString(row.finding_id),
      body: String(row.body),
      createdAt: iso(row.created_at),
    }));
  }

  async getReportVersion(id: string): Promise<ReportVersion | null> {
    const result = await this.database.query<Row>("SELECT * FROM report_versions WHERE id=$1", [
      id,
    ]);
    return result.rows[0] ? mapReportVersion(result.rows[0]) : null;
  }

  async getRenderedArtifact(versionId: string): Promise<{
    readonly bytes: Uint8Array;
    readonly mimeType: string;
    readonly checksum: string | null;
  } | null> {
    const result = await this.database.query<Row>(
      "SELECT rendered_content, rendered_mime_type, rendered_checksum FROM report_versions WHERE id=$1",
      [versionId],
    );
    const row = result.rows[0];
    if (!row || row.rendered_content === null || row.rendered_content === undefined) return null;
    return {
      bytes: Uint8Array.from(Buffer.from(String(row.rendered_content), "base64")),
      mimeType: String(row.rendered_mime_type ?? "application/pdf"),
      checksum: nullableString(row.rendered_checksum),
    };
  }

  async listDeliveries(reportId: string): Promise<readonly ReportDelivery[]> {
    const result = await this.database.query<Row>(
      "SELECT * FROM report_deliveries WHERE report_id=$1 ORDER BY created_at",
      [reportId],
    );
    return result.rows.map(mapDelivery);
  }

  async getException(id: string): Promise<ExceptionCase | null> {
    const result = await this.database.query<Row>(
      `SELECT exception_cases.*, users.display_name AS owner_display_name
         FROM exception_cases
         LEFT JOIN users ON users.id = exception_cases.owner_user_id
        WHERE exception_cases.id=$1`,
      [id],
    );
    return result.rows[0] ? mapException(result.rows[0]) : null;
  }

  async listExceptions(status?: ExceptionCase["status"]): Promise<readonly ExceptionCase[]> {
    const result = status
      ? await this.database.query<Row>(
          `SELECT exception_cases.*, users.display_name AS owner_display_name
             FROM exception_cases
             LEFT JOIN users ON users.id = exception_cases.owner_user_id
            WHERE exception_cases.status=$1
            ORDER BY exception_cases.created_at DESC`,
          [status],
        )
      : await this.database.query<Row>(
          `SELECT exception_cases.*, users.display_name AS owner_display_name
             FROM exception_cases
             LEFT JOIN users ON users.id = exception_cases.owner_user_id
            ORDER BY exception_cases.created_at DESC`,
        );
    return result.rows.map(mapException);
  }

  async listEvents(
    aggregateType: string,
    aggregateId: string,
  ): Promise<readonly AutomationEvent[]> {
    const result = await this.database.query<Row>(
      "SELECT * FROM automation_events WHERE aggregate_type=$1 AND aggregate_id=$2 ORDER BY occurred_at, recorded_at",
      [aggregateType, aggregateId],
    );
    return result.rows.map(mapEvent);
  }

  async listJobs(aggregateId?: string): Promise<readonly AutomationJob[]> {
    const result = aggregateId
      ? await this.database.query<Row>(
          "SELECT * FROM automation_jobs WHERE aggregate_id=$1 ORDER BY created_at",
          [aggregateId],
        )
      : await this.database.query<Row>("SELECT * FROM automation_jobs ORDER BY created_at DESC");
    return result.rows.map(mapJob);
  }

  async listBlueprints(): Promise<readonly AutomationBlueprint[]> {
    const result = await this.database.query<Row>(
      "SELECT * FROM automation_blueprints ORDER BY key, blueprint_version",
    );
    return result.rows.map(mapBlueprint);
  }

  async listConnectorReadiness(): Promise<readonly ConnectorReadinessRecord[]> {
    const result = await this.database.query<Row>(
      "SELECT * FROM connector_readiness ORDER BY display_name",
    );
    return result.rows.map(mapConnector);
  }

  async getActiveTemplateVersion(templateId: string): Promise<ReportTemplateVersion | null> {
    const result = await this.database.query<Row>(
      "SELECT * FROM report_template_versions WHERE template_id=$1 ORDER BY version_number DESC LIMIT 1",
      [templateId],
    );
    return result.rows[0] ? mapTemplateVersion(result.rows[0]) : null;
  }

  async getSlaClock(inspectionId: string): Promise<SlaClock | null> {
    const result = await this.database.query<Row>(
      "SELECT * FROM sla_clocks WHERE inspection_id=$1",
      [inspectionId],
    );
    return result.rows[0] ? mapSlaClock(result.rows[0]) : null;
  }

  async listStageIntervals(clockId: string): Promise<readonly SlaStageInterval[]> {
    const result = await this.database.query<Row>(
      "SELECT * FROM sla_stage_intervals WHERE clock_id=$1 ORDER BY started_at",
      [clockId],
    );
    return result.rows.map(mapStageInterval);
  }

  async listDeliveryAuthorizations(reportId: string): Promise<readonly DeliveryAuthorization[]> {
    const result = await this.database.query<Row>(
      "SELECT * FROM delivery_authorizations WHERE report_id=$1 ORDER BY authorized_at",
      [reportId],
    );
    return result.rows.map(mapDeliveryAuthorization);
  }

  async getActiveDeliveryAuthorization(reportId: string): Promise<DeliveryAuthorization | null> {
    const result = await this.database.query<Row>(
      "SELECT * FROM delivery_authorizations WHERE report_id=$1 AND status='active' ORDER BY authorized_at DESC LIMIT 1",
      [reportId],
    );
    return result.rows[0] ? mapDeliveryAuthorization(result.rows[0]) : null;
  }

  async getConfirmedDelivery(reportId: string): Promise<ReportDelivery | null> {
    const result = await this.database.query<Row>(
      `SELECT * FROM report_deliveries
        WHERE report_id=$1 AND status='delivered' AND confirmed_at IS NOT NULL
        ORDER BY confirmed_at DESC LIMIT 1`,
      [reportId],
    );
    return result.rows[0] ? mapDelivery(result.rows[0]) : null;
  }

  async listTurnaroundBoard(): Promise<readonly TurnaroundBoardItem[]> {
    const result = await this.database.query<Row>(
      `SELECT i.*,
              p.id AS project_row_id, p.reference AS project_reference, p.lead_id AS project_lead_id,
              p.company_id AS project_company_id, p.contact_id AS project_contact_id, p.name AS project_name,
              p.client_name, p.site_name AS project_site_name, p.site_city AS project_site_city,
              p.site_region AS project_site_region, p.service_key AS project_service_key, p.status AS project_status,
              p.accepted_scope_snapshot, p.created_by_user_id AS project_created_by,
              p.created_at AS project_created_at, p.updated_at AS project_updated_at, p.version AS project_version,
              r.id AS report_row_id, r.reference AS report_reference, r.status AS report_status,
              r.current_version_number, r.template_id AS report_template_id,
              r.current_template_version_id, r.created_by_user_id AS report_created_by,
              r.created_at AS report_created_at, r.updated_at AS report_updated_at, r.version AS report_version,
              s.id AS sla_id, s.report_id AS sla_report_id, s.clock_kind, s.target_minutes, s.started_at AS sla_started_at,
              s.paused_at, s.pause_reason, s.paused_total_ms, s.stopped_at, s.status AS sla_status, s.created_at AS sla_created_at,
              s.updated_at AS sla_updated_at, s.version AS sla_version,
              e.id AS exception_id, e.reference AS exception_reference, e.kind AS exception_kind,
              e.status AS exception_status, e.severity AS exception_severity, e.title AS exception_title,
              e.detail AS exception_detail, e.owner_user_id AS exception_owner, e.sla_attribution,
              e.resolved_at, e.resolution, e.resolved_by_user_id, e.resolved_by_actor_type,
              e.created_at AS exception_created_at, e.updated_at AS exception_updated_at,
              e.version AS exception_version,
              iu.display_name AS inspector_name, ru.display_name AS reviewer_name,
              eu.display_name AS exception_owner_name,
              d.confirmed_at AS confirmed_delivery_at
         FROM inspections i
         JOIN projects p ON p.id = i.project_id
         LEFT JOIN inspection_reports r ON r.inspection_id = i.id
         LEFT JOIN sla_clocks s ON s.inspection_id = i.id
         LEFT JOIN LATERAL (
           SELECT * FROM exception_cases ex
           WHERE ex.inspection_id = i.id AND ex.status IN ('open','assigned','in_progress')
           ORDER BY ex.created_at DESC LIMIT 1
         ) e ON TRUE
         LEFT JOIN LATERAL (
           SELECT confirmed_at FROM report_deliveries rd
           WHERE rd.report_id = r.id AND rd.status='delivered' AND rd.confirmed_at IS NOT NULL
           ORDER BY rd.confirmed_at DESC LIMIT 1
         ) d ON TRUE
         LEFT JOIN users iu ON iu.id = i.inspector_user_id
         LEFT JOIN users ru ON ru.id = i.reviewer_user_id
         LEFT JOIN users eu ON eu.id = e.owner_user_id
        ORDER BY COALESCE(i.completed_at, i.created_at)`,
    );
    const now = new Date().toISOString();
    const clockIds = result.rows
      .map((row) => nullableString(row.sla_id))
      .filter((id): id is string => Boolean(id));
    const stageRows =
      clockIds.length > 0
        ? await this.database.query<Row>(
            `SELECT * FROM sla_stage_intervals WHERE clock_id IN (${clockIds.map((_, index) => `$${index + 1}`).join(",")})`,
            clockIds,
          )
        : { rows: [] as Row[] };
    const durationsByClock = stageDurationsByClock(stageRows.rows, now);
    const inspectionIds = result.rows.map((row) => String(row.id));
    const workByInspection = new Map<string, TurnaroundBoardWorkProjection>();
    if (inspectionIds.length > 0) {
      const placeholders = inspectionIds.map((_, index) => `$${index + 1}`).join(",");
      const workRows = await this.database.query<Row>(
        `SELECT w.*, u.display_name AS assigned_user_name
           FROM operational_work_items w
           LEFT JOIN users u ON u.id = COALESCE(w.claimed_user_id, w.assigned_user_id)
          WHERE w.inspection_id IN (${placeholders})
            AND w.status IN ('open','acknowledged','in_progress','blocked')
          ORDER BY w.inspection_id, w.due_at NULLS LAST, w.created_at`,
        inspectionIds,
      );
      for (const row of workRows.rows) {
        const inspectionId = String(row.inspection_id);
        if (workByInspection.has(inspectionId)) continue;
        const availableAt = iso(row.available_at);
        const ageMs = Math.max(0, Date.parse(now) - Date.parse(availableAt));
        workByInspection.set(inspectionId, {
          workItemId: String(row.id),
          reference: String(row.reference),
          kind: String(row.work_item_kind),
          status: String(row.status),
          queueKey: String(row.queue_key),
          assignedRoleKey: nullableString(row.assigned_role_key),
          assignedUserId:
            nullableString(row.claimed_user_id) ?? nullableString(row.assigned_user_id),
          assignedUserName: nullableString(row.assigned_user_name),
          ageMs,
          dueAt: nullableIso(row.due_at),
          reminderState:
            Number(row.reminder_count ?? 0) > 0 ? `${row.reminder_count} reminder(s)` : "none",
          escalationLevel: String(row.escalation_level),
          blockedReason: nullableString(row.blocked_reason),
          requiredAction: String(row.required_action),
          humanWaitingMs: ageMs,
          systemProcessingMs: 0,
        });
      }
    }
    return result.rows.map((row) => {
      const inspection = mapInspection(row);
      const project = mapProject({
        id: row.project_id,
        reference: row.project_reference,
        lead_id: row.project_lead_id,
        company_id: row.project_company_id,
        contact_id: row.project_contact_id,
        name: row.project_name,
        client_name: row.client_name,
        site_name: row.project_site_name,
        site_city: row.project_site_city,
        site_region: row.project_site_region,
        service_key: row.project_service_key,
        status: row.project_status,
        accepted_scope_snapshot: row.accepted_scope_snapshot,
        created_by_user_id: row.project_created_by,
        created_at: row.project_created_at,
        updated_at: row.project_updated_at,
        version: row.project_version,
      });
      const report = row.report_row_id
        ? mapReport({
            id: row.report_row_id,
            reference: row.report_reference,
            inspection_id: inspection.id,
            project_id: project.id,
            template_id: row.report_template_id,
            current_template_version_id: row.current_template_version_id,
            status: row.report_status,
            current_version_number: row.current_version_number,
            created_by_user_id: row.report_created_by,
            created_at: row.report_created_at,
            updated_at: row.report_updated_at,
            version: row.report_version,
          })
        : null;
      const sla = row.sla_id
        ? mapSlaClock({
            id: row.sla_id,
            report_id: row.sla_report_id,
            inspection_id: inspection.id,
            clock_kind: row.clock_kind,
            target_minutes: row.target_minutes,
            started_at: row.sla_started_at,
            paused_at: row.paused_at,
            pause_reason: row.pause_reason,
            paused_total_ms: row.paused_total_ms,
            stopped_at: row.stopped_at,
            status: row.sla_status,
            created_at: row.sla_created_at,
            updated_at: row.sla_updated_at,
            version: row.sla_version,
          })
        : null;
      const exception = row.exception_id
        ? mapException({
            id: row.exception_id,
            reference: row.exception_reference,
            kind: row.exception_kind,
            status: row.exception_status,
            severity: row.exception_severity,
            title: row.exception_title,
            detail: row.exception_detail,
            inspection_id: inspection.id,
            report_id: report?.id ?? null,
            project_id: project.id,
            delivery_id: null,
            job_id: null,
            owner_user_id: row.exception_owner,
            owner_display_name: row.exception_owner_name,
            sla_attribution: row.sla_attribution,
            resolved_at: row.resolved_at,
            resolution: row.resolution,
            resolved_by_user_id: row.resolved_by_user_id,
            resolved_by_actor_type: row.resolved_by_actor_type,
            created_at: row.exception_created_at,
            updated_at: row.exception_updated_at,
            version: row.exception_version,
          })
        : null;
      const metrics = computeMetrics(inspection, report, sla, now, {
        confirmedDeliveryAt: nullableIso(row.confirmed_delivery_at),
        stageDurations: sla ? (durationsByClock.get(sla.id) ?? {}) : {},
      });
      const work =
        workByInspection.get(inspection.id) ??
        ({
          workItemId: null,
          reference: null,
          kind: null,
          status: null,
          queueKey: null,
          assignedRoleKey: null,
          assignedUserId: null,
          assignedUserName: null,
          ageMs: null,
          dueAt: null,
          reminderState: null,
          escalationLevel: null,
          blockedReason: null,
          requiredAction: null,
          humanWaitingMs: 0,
          systemProcessingMs: metrics.slaElapsedMs ?? 0,
        } satisfies TurnaroundBoardWorkProjection);
      const stageDurations = sla ? (durationsByClock.get(sla.id) ?? {}) : {};
      const humanWaitingMs = Object.entries(stageDurations)
        .filter(([key]) =>
          /technical_decision|delivery_authorized|submission_received|correction/u.test(key),
        )
        .reduce((sum, [, value]) => sum + value, 0);
      const systemProcessingMs = Object.entries(stageDurations)
        .filter(([key]) => /validation|render|deliver/u.test(key))
        .reduce((sum, [, value]) => sum + value, 0);
      return {
        inspection,
        project,
        report,
        sla,
        exception,
        inspectorName: nullableString(row.inspector_name),
        currentOwner:
          work.assignedUserName ??
          (work.assignedRoleKey ? work.assignedRoleKey : null) ??
          nullableString(row.exception_owner_name) ??
          nullableString(row.inspector_name) ??
          nullableString(row.reviewer_name),
        nextAction:
          work.requiredAction ??
          nextActionFor(inspection.status, report?.status ?? null, exception),
        metrics,
        work: {
          ...work,
          humanWaitingMs: work.workItemId ? work.humanWaitingMs : humanWaitingMs,
          systemProcessingMs: work.workItemId ? work.systemProcessingMs : systemProcessingMs,
        },
      };
    });
  }
}

export function computeMetrics(
  inspection: Inspection,
  report: InspectionReport | null,
  sla: SlaClock | null,
  now: string,
  extras: {
    readonly confirmedDeliveryAt?: string | null;
    readonly stageDurations?: Readonly<Record<string, number>>;
  } = {},
): TurnaroundMetrics {
  const confirmedDeliveryAt = extras.confirmedDeliveryAt ?? null;
  const completedAt = inspection.completedAt;
  const currentStageKey = report?.status ?? inspection.status;
  const stageStart = report?.updatedAt ?? inspection.updatedAt;
  const pauseMs = sla
    ? pausedDurationMs({
        pausedAt: sla.pausedAt,
        pausedTotalMs: sla.pausedTotalMs,
        now,
        status: sla.status,
      })
    : 0;
  return {
    inspectionCompletedAt: completedAt,
    reportDeliveredAt: confirmedDeliveryAt,
    confirmedDeliveryAt,
    totalTurnaroundMs:
      completedAt && confirmedDeliveryAt ? elapsedMs(completedAt, confirmedDeliveryAt) : null,
    currentAgeMs: completedAt ? elapsedMs(completedAt, now) : 0,
    currentStageKey,
    currentStageAgeMs: elapsedMs(stageStart, now),
    slaTargetMinutes: sla?.targetMinutes ?? DEFAULT_REPORT_SLA_TARGET_MINUTES,
    slaElapsedMs: sla
      ? slaElapsedMs({
          startedAt: sla.startedAt,
          now,
          pausedAt: sla.pausedAt,
          pausedTotalMs: sla.pausedTotalMs,
          stoppedAt: sla.stoppedAt,
          status: sla.status,
        })
      : null,
    slaRemainingMs: sla
      ? slaRemainingMs({
          startedAt: sla.startedAt,
          now,
          targetMinutes: sla.targetMinutes,
          pausedAt: sla.pausedAt,
          pausedTotalMs: sla.pausedTotalMs,
          stoppedAt: sla.stoppedAt,
          status: sla.status,
        })
      : null,
    slaStatus: sla?.status ?? "not_started",
    pauseReason: sla?.pauseReason ?? null,
    pausedDurationMs: pauseMs,
    stageDurations: extras.stageDurations ?? {},
  };
}

export function durationsFromIntervals(
  intervals: readonly SlaStageInterval[],
  now: string,
): Record<string, number> {
  const current: Record<string, number> = {};
  for (const interval of intervals) {
    const duration = interval.durationMs ?? elapsedMs(interval.startedAt, interval.endedAt ?? now);
    current[interval.stageKey] = (current[interval.stageKey] ?? 0) + duration;
  }
  return current;
}

export function stageDurationsByClock(
  rows: readonly Row[],
  now: string,
): Map<string, Record<string, number>> {
  const durations = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const interval = mapStageInterval(row);
    const current = durations.get(interval.clockId) ?? {};
    const duration =
      interval.durationMs ??
      (interval.endedAt
        ? elapsedMs(interval.startedAt, interval.endedAt)
        : elapsedMs(interval.startedAt, now));
    current[interval.stageKey] = (current[interval.stageKey] ?? 0) + duration;
    durations.set(interval.clockId, current);
  }
  return durations;
}

export function nextActionFor(
  inspectionStatus: Inspection["status"],
  reportStatus: InspectionReport["status"] | null,
  exception: ExceptionCase | null,
): string {
  if (exception && exception.status !== "resolved" && exception.status !== "cancelled") {
    return "Resolve exception";
  }
  if (inspectionStatus === "completed") return "Submit inspection data";
  if (inspectionStatus === "needs_correction") return "Correct missing inspection data";
  if (inspectionStatus === "validating") return "Wait for validation";
  if (reportStatus === "in_review" || reportStatus === "draft_ready") return "Review report";
  if (reportStatus === "revision_required") return "Revise report";
  if (reportStatus === "approved" || reportStatus === "rendering_final")
    return "Wait for final rendering";
  if (reportStatus === "ready_for_delivery") return "Authorize client delivery";
  if (reportStatus === "delivering") return "Wait for confirmed delivery";
  if (reportStatus === "delivery_failed") return "Retry failed delivery";
  if (reportStatus === "delivered") return "None";
  return "Wait for automation";
}

export async function insertAutomationEvent(
  executor: SqlExecutor,
  input: {
    readonly eventType: OperationsEventType;
    readonly aggregateType: string;
    readonly aggregateId: string;
    readonly correlationId: string;
    readonly causationId?: string | null;
    readonly actorType: ActorType;
    readonly actorId: string | null;
    readonly payload: JsonObject;
    readonly occurredAt: string;
  },
): Promise<AutomationEvent> {
  const id = randomUUID();
  const result = await executor.query<Row>(
    `INSERT INTO automation_events
     (id,event_type,schema_version,aggregate_type,aggregate_id,correlation_id,causation_id,occurred_at,recorded_at,actor_type,actor_id,payload,processing_status)
     VALUES ($1,$2,'1',$3,$4,$5,$6,$7,$7,$8,$9,$10::jsonb,'pending')
     RETURNING *`,
    [
      id,
      input.eventType,
      input.aggregateType,
      input.aggregateId,
      input.correlationId,
      input.causationId ?? null,
      input.occurredAt,
      input.actorType,
      input.actorId,
      JSON.stringify(input.payload),
    ],
  );
  return mapEvent(result.rows[0] as Row);
}

export async function enqueueAutomationJob(
  executor: SqlExecutor,
  input: {
    readonly jobType: AutomationJobType;
    readonly blueprintKey: BlueprintKey;
    readonly blueprintVersion: number;
    readonly aggregateType: string;
    readonly aggregateId: string;
    readonly eventId: string | null;
    readonly idempotencyKey: string;
    readonly payload: JsonObject;
    readonly now: string;
    readonly maxAttempts?: number;
  },
): Promise<AutomationJob> {
  const result = await executor.query<Row>(
    `INSERT INTO automation_jobs
     (id,job_type,blueprint_key,blueprint_version,aggregate_type,aggregate_id,event_id,idempotency_key,status,attempt_count,max_attempts,available_at,payload,created_at,updated_at,version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',0,$9,$10,$11::jsonb,$10,$10,1)
     ON CONFLICT (idempotency_key) DO UPDATE SET
       status = CASE WHEN automation_jobs.status IN ('failed','dead_letter','pending') THEN 'pending' ELSE automation_jobs.status END,
       available_at = CASE WHEN automation_jobs.status IN ('failed','dead_letter','pending') THEN EXCLUDED.available_at ELSE automation_jobs.available_at END,
       last_error = CASE WHEN automation_jobs.status IN ('failed','dead_letter','pending') THEN NULL ELSE automation_jobs.last_error END,
       finished_at = CASE WHEN automation_jobs.status IN ('failed','dead_letter','pending') THEN NULL ELSE automation_jobs.finished_at END,
       claimed_at = CASE WHEN automation_jobs.status IN ('failed','dead_letter','pending') THEN NULL ELSE automation_jobs.claimed_at END,
       claimed_by = CASE WHEN automation_jobs.status IN ('failed','dead_letter','pending') THEN NULL ELSE automation_jobs.claimed_by END,
       lease_expires_at = CASE WHEN automation_jobs.status IN ('failed','dead_letter','pending') THEN NULL ELSE automation_jobs.lease_expires_at END,
       payload = CASE WHEN automation_jobs.status IN ('failed','dead_letter','pending') THEN EXCLUDED.payload ELSE automation_jobs.payload END,
       updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [
      randomUUID(),
      input.jobType,
      input.blueprintKey,
      input.blueprintVersion,
      input.aggregateType,
      input.aggregateId,
      input.eventId,
      input.idempotencyKey,
      input.maxAttempts ?? 3,
      input.now,
      JSON.stringify(input.payload),
    ],
  );
  return mapJob(result.rows[0] as Row);
}

export async function recordAuditAndActivity(
  executor: SqlExecutor,
  input: {
    readonly eventType: string;
    readonly action: string;
    readonly actorUserId: string | null;
    readonly resourceType: string;
    readonly resourceId: string;
    readonly correlationId: string;
    readonly metadata: JsonObject;
    readonly summary: string;
    readonly inspectionId?: string | null;
    readonly reportId?: string | null;
    readonly proposalId?: string | null;
    readonly now: string;
  },
): Promise<void> {
  await executor.query(
    `INSERT INTO audit_logs (id,event_type,action,outcome,actor_user_id,resource_type,resource_id,correlation_id,metadata,created_at)
     VALUES ($1,$2,$3,'succeeded',$4,$5,$6,$7,$8::jsonb,$9)`,
    [
      randomUUID(),
      input.eventType,
      input.action,
      input.actorUserId,
      input.resourceType,
      input.resourceId,
      input.correlationId,
      JSON.stringify(input.metadata),
      input.now,
    ],
  );
  await executor.query(
    `INSERT INTO activities (id,type,summary,actor_user_id,inspection_id,report_id,proposal_id,correlation_id,metadata,created_at,updated_at,version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$10,1)`,
    [
      randomUUID(),
      input.eventType,
      input.summary,
      input.actorUserId,
      input.inspectionId ?? null,
      input.reportId ?? null,
      input.proposalId ?? null,
      input.correlationId,
      JSON.stringify(input.metadata),
      input.now,
    ],
  );
}

export { DEFAULT_REPORT_SLA_TARGET_MINUTES, DEFAULT_SLA_CLOCK_KIND };

export type { NormalizedInspectionPayload };
