import type { EntityId, IsoDateTime, JsonObject, VersionedEntity } from "./entities.js";

export const PROJECT_STATUSES = [
  "awarded",
  "initializing",
  "ready",
  "scheduling",
  "fieldwork",
  "reporting",
  "delivered",
  "closeout",
  "closed",
  "cancelled",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const INSPECTION_STATUSES = [
  "draft",
  "scheduled",
  "ready",
  "in_progress",
  "completed",
  "submitted",
  "validating",
  "needs_correction",
  "validated",
  "reporting",
  "complete",
  "cancelled",
] as const;
export type InspectionStatus = (typeof INSPECTION_STATUSES)[number];

export const REPORT_STATUSES = [
  "awaiting_data",
  "assembling",
  "draft_ready",
  "in_review",
  "revision_required",
  "approved",
  "rendering_final",
  "ready_for_delivery",
  "delivering",
  "delivered",
  "delivery_failed",
  "cancelled",
] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_VERSION_STATUSES = [
  "draft",
  "in_review",
  "revision_required",
  "approved",
  "final",
  "superseded",
] as const;
export type ReportVersionStatus = (typeof REPORT_VERSION_STATUSES)[number];

export const DELIVERY_STATUSES = [
  "pending",
  "attempting",
  "delivered",
  "failed",
  "cancelled",
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const DELIVERY_AUTHORIZATION_STATUSES = [
  "active",
  "consumed",
  "revoked",
  "superseded",
  "expired",
] as const;
export type DeliveryAuthorizationStatus = (typeof DELIVERY_AUTHORIZATION_STATUSES)[number];

export const DELIVERY_DESTINATION_KINDS = ["local_test", "client"] as const;
export type DeliveryDestinationKind = (typeof DELIVERY_DESTINATION_KINDS)[number];

export const EXCEPTION_STATUSES = [
  "open",
  "assigned",
  "in_progress",
  "resolved",
  "cancelled",
] as const;
export type ExceptionStatus = (typeof EXCEPTION_STATUSES)[number];

export const EXCEPTION_KINDS = [
  "validation",
  "delivery",
  "connector",
  "mapping",
  "template",
  "state",
  "duplicate",
] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

export const AUTOMATION_JOB_STATUSES = [
  "pending",
  "claimed",
  "succeeded",
  "failed",
  "dead_letter",
  "cancelled",
] as const;
export type AutomationJobStatus = (typeof AUTOMATION_JOB_STATUSES)[number];

export const AUTOMATION_EVENT_PROCESSING_STATUSES = [
  "pending",
  "processed",
  "ignored",
  "failed",
  "dead_lettered",
] as const;
export type AutomationEventProcessingStatus = (typeof AUTOMATION_EVENT_PROCESSING_STATUSES)[number];

export const CONNECTOR_READINESS_STATUSES = [
  "not_connected",
  "authenticating",
  "connected_unverified",
  "configuration_required",
  "ready_for_dry_run",
  "dry_run_validated",
  "activation_blocked",
  "authenticated",
  "ready_for_activation",
  "healthy",
  "degraded",
  "error",
  "auth_expired",
  "disabled",
] as const;
export type ConnectorReadinessStatus = (typeof CONNECTOR_READINESS_STATUSES)[number];

export const INSPECTION_SOURCE_CHANNELS = [
  "direct_entry",
  "webhook",
  "file_import",
  "sharepoint",
  "onedrive",
  "email",
  "field_system",
] as const;
export type InspectionSourceChannel = (typeof INSPECTION_SOURCE_CHANNELS)[number];

export const EVIDENCE_KINDS = ["photo", "document", "signature"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const FINDING_SEVERITIES = ["info", "minor", "major", "critical"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const REPORT_REVIEW_DECISIONS = [
  "approve",
  "request_revision",
  "return_to_inspector",
] as const;
export type ReportReviewDecision = (typeof REPORT_REVIEW_DECISIONS)[number];

export const SLA_CLOCK_KINDS = ["calendar", "business_hours"] as const;
export type SlaClockKind = (typeof SLA_CLOCK_KINDS)[number];

export const SLA_CLOCK_STATUSES = ["running", "paused", "stopped", "breached"] as const;
export type SlaClockStatus = (typeof SLA_CLOCK_STATUSES)[number];

export const SLA_PAUSE_REASONS = [
  "customer_caused",
  "internal_exception",
  "awaiting_human",
] as const;
export type SlaPauseReason = (typeof SLA_PAUSE_REASONS)[number];

export const SLA_ATTRIBUTIONS = [
  "system_processing",
  "human_waiting",
  "connector_waiting",
  "exception",
  "customer_caused",
] as const;
export type SlaAttribution = (typeof SLA_ATTRIBUTIONS)[number];

export const ACTOR_TYPES = ["user", "system", "worker", "connector"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const BLUEPRINT_KEYS = [
  "inspection.submission-validation",
  "report.assembly",
  "report.review",
  "report.delivery",
  "sla.escalation",
  "connector.reconciliation",
] as const;
export type BlueprintKey = (typeof BLUEPRINT_KEYS)[number];

export const AUTOMATION_JOB_TYPES = [
  "inspection.validate",
  "report.assemble",
  "report.render-final",
  "report.deliver",
  "sla.evaluate",
] as const;
export type AutomationJobType = (typeof AUTOMATION_JOB_TYPES)[number];

export const SLA_STAGE_KEYS = [
  "inspection_completed_to_submission_received",
  "submission_received_to_validation_completed",
  "validation_failure_to_corrected_submission",
  "validation_passed_to_report_draft_created",
  "report_draft_created_to_technical_decision",
  "technical_approval_to_final_artifact_rendered",
  "final_artifact_rendered_to_delivery_authorized",
  "delivery_authorized_to_confirmed_delivery",
] as const;
export type SlaStageKey = (typeof SLA_STAGE_KEYS)[number];

export const SLA_STAGE_LABELS: Readonly<Record<SlaStageKey, string>> = {
  inspection_completed_to_submission_received: "Inspection completed → submission received",
  submission_received_to_validation_completed: "Submission received → validation completed",
  validation_failure_to_corrected_submission: "Validation failure → corrected submission",
  validation_passed_to_report_draft_created: "Validation passed → report draft created",
  report_draft_created_to_technical_decision: "Report draft created → technical decision",
  technical_approval_to_final_artifact_rendered: "Technical approval → final artifact rendered",
  final_artifact_rendered_to_delivery_authorized: "Final artifact rendered → delivery authorized",
  delivery_authorized_to_confirmed_delivery: "Delivery authorized → confirmed delivery",
};

export const OPERATIONS_EVENT_TYPES = [
  "inspection.created",
  "inspection.scheduled",
  "inspection.ready",
  "inspection.started",
  "inspection.completed",
  "inspection.submitted",
  "inspection.validation_failed",
  "inspection.validated",
  "inspection.correction_submitted",
  "inspection.cancelled",
  "report.assembly_requested",
  "report.draft_created",
  "report.review_requested",
  "report.revision_requested",
  "report.approved",
  "report.returned_to_inspector",
  "report.final_render_requested",
  "report.ready_for_delivery",
  "report.delivery_requested",
  "report.delivery_authorization_revoked",
  "report.delivered",
  "report.delivery_failed",
  "exception.created",
  "exception.resolved",
  "sla.threshold_crossed",
  "project.status_changed",
  "automation.job_dead_letter",
  "automation.job_retry_requested",
  "automation.job_requeued",
  "automation.job_succeeded",
  "automation.job_cancelled",
  "automation.job_resolved",
  "automation.projection_dead_lettered",
  "automation.projection_succeeded",
  "automation.projection_retry_requested",
  "automation.projection_cancelled",
  "automation.schedule_retry_requested",
  "automation.schedule_requeued",
  "automation.schedule_succeeded",
  "automation.schedule_dead_lettered",
  "automation.schedule_cancelled",
  "automation.schedule_resolved",
  "work_item.created",
  "work_item.claimed",
  "work_item.released",
  "work_item.reassigned",
  "work_item.acknowledged",
  "work_item.started",
  "work_item.blocked",
  "work_item.unblocked",
  "work_item.completed",
  "work_item.cancelled",
  "work_item.reminder_due",
  "work_item.reminder_created",
  "work_item.escalation_watch",
  "work_item.escalation_at_risk",
  "work_item.escalation_breached",
  "work_item.escalation_critical",
  "work_item.escalation_resolved",
  "work.reconciled",
  "lead.ready_for_proposal",
  "lead.disqualified",
  "lead.needs_info",
  "proposal.created",
  "proposal.updated",
  "proposal.readiness_failed",
  "proposal.needs_information",
  "proposal.ready_for_review",
  "proposal.submitted_for_review",
  "proposal.review_started",
  "proposal.revision_requested",
  "proposal.version_created",
  "proposal.pricing_override_requested",
  "proposal.pricing_override_approved",
  "proposal.pricing_override_rejected",
  "proposal.approved",
  "proposal.ready_for_delivery",
  "proposal.delivery_manifest_created",
  "proposal.cancelled",
  "proposal.superseded",
] as const;
export type OperationsEventType = (typeof OPERATIONS_EVENT_TYPES)[number];

export const PROJECT_REFERENCE_PREFIX = "BEA-PR-";
export const INSPECTION_REFERENCE_PREFIX = "BEA-IN-";
export const REPORT_REFERENCE_PREFIX = "BEA-RP-";
export const EXCEPTION_REFERENCE_PREFIX = "BEA-EX-";
export const WORK_ITEM_REFERENCE_PREFIX = "BEA-WK-";

export const OPERATIONS_CONTRACT_VERSION = "phase-3.0.0";
export const SYNTHETIC_REPORT_TEMPLATE_KEY = "bea-synthetic-inspection-report";
export const SYNTHETIC_REPORT_TEMPLATE_VERSION = 1;
export const SYNTHETIC_REPORT_DISCLOSURE =
  "SYNTHETIC FIXTURE — NOT A PRODUCTION BEA REPORT TEMPLATE. Field requirements are configurable placeholders, not confirmed BEA policy.";

export const DEFAULT_REPORT_SLA_TARGET_MINUTES = 24 * 60;
export const DEFAULT_SLA_CLOCK_KIND: SlaClockKind = "calendar";
export const JOB_LEASE_MS = 30_000;
export const DEFAULT_LOCAL_TEST_RECIPIENTS = ["client@example.invalid"] as const;

export function isDeliveryDestinationKind(value: unknown): value is DeliveryDestinationKind {
  return (DELIVERY_DESTINATION_KINDS as readonly string[]).includes(String(value));
}

export function canonicalRecipientList(recipients: readonly unknown[]): string[] {
  const normalized = recipients
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLocaleLowerCase("en-US"))
    .filter((item) => item.length > 0);
  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right, "en-US"));
}

export function sameCanonicalRecipients(
  left: readonly unknown[],
  right: readonly unknown[],
): boolean {
  const canonicalLeft = canonicalRecipientList(left);
  const canonicalRight = canonicalRecipientList(right);
  return (
    canonicalLeft.length === canonicalRight.length &&
    canonicalLeft.every((value, index) => value === canonicalRight[index])
  );
}

export const SYNTHETIC_INSPECTION_COMPLETION_OFFSET_MS = 90 * 60 * 1000;
export const DEFAULT_BUSINESS_HOURS = {
  weekdays: [1, 2, 3, 4, 5] as const,
  startMinute: 8 * 60,
  endMinute: 17 * 60,
  timeZone: "UTC",
} as const;

export const PROJECT_STATUS_TRANSITIONS: Readonly<Record<ProjectStatus, readonly ProjectStatus[]>> =
  {
    awarded: ["initializing", "cancelled"],
    initializing: ["ready", "cancelled"],
    ready: ["scheduling", "fieldwork", "cancelled"],
    scheduling: ["fieldwork", "ready", "cancelled"],
    fieldwork: ["reporting", "scheduling", "cancelled"],
    reporting: ["delivered", "fieldwork", "cancelled"],
    delivered: ["closeout"],
    closeout: ["closed"],
    closed: [],
    cancelled: ["awarded"],
  };

export const INSPECTION_STATUS_TRANSITIONS: Readonly<
  Record<InspectionStatus, readonly InspectionStatus[]>
> = {
  draft: ["scheduled", "ready", "cancelled"],
  scheduled: ["ready", "in_progress", "cancelled"],
  ready: ["in_progress", "scheduled", "cancelled"],
  in_progress: ["completed", "ready", "cancelled"],
  completed: ["submitted", "in_progress", "cancelled"],
  submitted: ["validating"],
  validating: ["needs_correction", "validated"],
  needs_correction: ["submitted", "cancelled"],
  validated: ["reporting"],
  reporting: ["complete", "needs_correction"],
  complete: [],
  cancelled: ["draft"],
};

export const REPORT_STATUS_TRANSITIONS: Readonly<Record<ReportStatus, readonly ReportStatus[]>> = {
  awaiting_data: ["assembling", "cancelled"],
  assembling: ["draft_ready", "awaiting_data", "cancelled"],
  draft_ready: ["in_review", "cancelled"],
  in_review: ["approved", "revision_required", "cancelled"],
  revision_required: ["assembling", "in_review", "cancelled"],
  approved: ["rendering_final", "revision_required", "cancelled"],
  rendering_final: ["ready_for_delivery", "approved"],
  ready_for_delivery: ["delivering", "revision_required"],
  delivering: ["delivered", "delivery_failed", "ready_for_delivery"],
  delivery_failed: ["delivering", "ready_for_delivery", "cancelled"],
  delivered: [],
  cancelled: ["awaiting_data"],
};

export interface Project extends VersionedEntity {
  reference: string;
  leadId: EntityId | null;
  companyId: EntityId | null;
  contactId: EntityId | null;
  name: string;
  clientName: string;
  siteName: string;
  siteCity: string | null;
  siteRegion: string | null;
  serviceKey: string;
  status: ProjectStatus;
  acceptedScopeSnapshot: JsonObject;
  createdByUserId: EntityId;
}

export interface Inspection extends VersionedEntity {
  reference: string;
  projectId: EntityId;
  status: InspectionStatus;
  inspectorUserId: EntityId | null;
  reviewerUserId: EntityId | null;
  scheduledAt: IsoDateTime | null;
  startedAt: IsoDateTime | null;
  completedAt: IsoDateTime | null;
  submittedAt: IsoDateTime | null;
  serviceKey: string;
  reportTemplateId: EntityId;
  configurationReleaseId: EntityId | null;
  inspectionType: string | null;
  readinessChecklist: JsonObject | null;
  createdByUserId: EntityId;
}

export interface InspectionSubmission {
  id: EntityId;
  inspectionId: EntityId;
  sourceChannel: InspectionSourceChannel;
  sourceIdempotencyKey: string;
  payloadSha256: string;
  rawPayload: JsonObject;
  schemaVersion: string;
  mappingVersion: string;
  normalizedPayload: JsonObject;
  configurationReleaseId: EntityId | null;
  sourceLineage: JsonObject | null;
  actorUserId: EntityId | null;
  correlationId: string | null;
  createdAt: IsoDateTime;
}

export interface InspectionFinding {
  id: EntityId;
  submissionId: EntityId;
  inspectionId: EntityId;
  code: string;
  sectionKey: string;
  title: string;
  description: string;
  severity: FindingSeverity;
  location: string | null;
  sortOrder: number;
  createdAt: IsoDateTime;
}

export interface InspectionEvidence {
  id: EntityId;
  submissionId: EntityId;
  inspectionId: EntityId;
  findingId: EntityId | null;
  kind: EvidenceKind;
  filename: string;
  contentType: string;
  sha256: string;
  byteLength: number;
  storageRef: string;
  createdAt: IsoDateTime;
}

export interface InspectionValidationItem {
  readonly code: string;
  readonly severity: "blocking" | "optional";
  readonly message: string;
  readonly path: string;
}

export interface InspectionValidationResult {
  id: EntityId;
  submissionId: EntityId;
  inspectionId: EntityId;
  passed: boolean;
  ruleSetKey: string;
  ruleSetVersion: string;
  blocking: readonly InspectionValidationItem[];
  optional: readonly InspectionValidationItem[];
  createdAt: IsoDateTime;
}

export interface ReportTemplate extends VersionedEntity {
  key: string;
  name: string;
  synthetic: boolean;
  status: "active" | "inactive";
}

export interface ReportTemplateVersion {
  id: EntityId;
  templateId: EntityId;
  versionNumber: number;
  mapping: JsonObject;
  requirements: ReportRequirementSet;
  rendererKey: string;
  disclosure: string;
  createdAt: IsoDateTime;
}

export interface ReportRequirementSet {
  readonly minFindings: number;
  readonly minEvidence: number;
  readonly requireSignature: boolean;
  readonly requireInspectorName: boolean;
  readonly requireClientName: boolean;
  readonly requireSiteName: boolean;
  readonly requireCompletedAt: boolean;
  readonly requireAttestation: boolean;
}

export const DEFAULT_SYNTHETIC_REQUIREMENTS: ReportRequirementSet = {
  minFindings: 1,
  minEvidence: 1,
  requireSignature: true,
  requireInspectorName: true,
  requireClientName: true,
  requireSiteName: true,
  requireCompletedAt: true,
  requireAttestation: true,
};

export interface InspectionReport extends VersionedEntity {
  reference: string;
  inspectionId: EntityId;
  projectId: EntityId;
  templateId: EntityId;
  currentTemplateVersionId: EntityId;
  configurationReleaseId: EntityId | null;
  status: ReportStatus;
  currentVersionNumber: number;
  createdByUserId: EntityId | null;
}

export interface ReportVersion {
  id: EntityId;
  reportId: EntityId;
  versionNumber: number;
  status: ReportVersionStatus;
  inputSnapshot: JsonObject;
  templateVersionId: EntityId;
  submissionId: EntityId;
  configurationReleaseId: EntityId | null;
  renderedChecksum: string | null;
  renderedStorageRef: string | null;
  renderedMimeType: string | null;
  reviewerUserId: EntityId | null;
  reviewedAt: IsoDateTime | null;
  reviewDecision: ReportReviewDecision | null;
  reviewComment: string | null;
  createdAt: IsoDateTime;
}

export interface ReportReviewComment {
  id: EntityId;
  reportVersionId: EntityId;
  authorUserId: EntityId;
  sectionKey: string | null;
  findingId: EntityId | null;
  body: string;
  createdAt: IsoDateTime;
}

export interface ReportDelivery extends VersionedEntity {
  reportId: EntityId;
  reportVersionId: EntityId;
  idempotencyKey: string;
  adapterKey: string;
  status: DeliveryStatus;
  recipients: readonly string[];
  subject: string;
  artifactChecksum: string | null;
  externalMessageId: string | null;
  attemptedAt: IsoDateTime | null;
  confirmedAt: IsoDateTime | null;
  error: JsonObject | null;
}

export interface DeliveryAuthorization extends VersionedEntity {
  reportId: EntityId;
  reportVersionId: EntityId;
  artifactChecksum: string;
  recipients: readonly string[];
  destinationKind: DeliveryDestinationKind;
  authorizingUserId: EntityId;
  authorizedAt: IsoDateTime;
  status: DeliveryAuthorizationStatus;
  consumedAt: IsoDateTime | null;
  consumedByJobId: EntityId | null;
  reservedToken: string | null;
  reservedAt: IsoDateTime | null;
  revokedAt: IsoDateTime | null;
  revokedByUserId: EntityId | null;
}

export interface ExceptionCase extends VersionedEntity {
  reference: string;
  kind: ExceptionKind;
  status: ExceptionStatus;
  severity: "warning" | "error";
  title: string;
  detail: string;
  inspectionId: EntityId | null;
  reportId: EntityId | null;
  projectId: EntityId | null;
  deliveryId: EntityId | null;
  jobId: EntityId | null;
  ownerUserId: EntityId | null;
  ownerDisplayName: string | null;
  slaAttribution: SlaAttribution;
  resolvedAt: IsoDateTime | null;
  resolution: string | null;
  resolvedByUserId: EntityId | null;
  resolvedByActorType: ActorType | null;
}

export interface SlaClock extends VersionedEntity {
  reportId: EntityId | null;
  inspectionId: EntityId;
  clockKind: SlaClockKind;
  targetMinutes: number;
  startedAt: IsoDateTime;
  pausedAt: IsoDateTime | null;
  pauseReason: SlaPauseReason | null;
  pausedTotalMs: number;
  stoppedAt: IsoDateTime | null;
  status: SlaClockStatus;
}

export interface SlaStageInterval {
  id: EntityId;
  clockId: EntityId;
  stageKey: string;
  startedAt: IsoDateTime;
  endedAt: IsoDateTime | null;
  durationMs: number | null;
  attribution: SlaAttribution;
}

export interface AutomationEvent {
  id: EntityId;
  eventType: OperationsEventType;
  schemaVersion: string;
  aggregateType: string;
  aggregateId: EntityId;
  correlationId: string;
  causationId: string | null;
  occurredAt: IsoDateTime;
  recordedAt: IsoDateTime;
  actorType: ActorType;
  actorId: EntityId | null;
  payload: JsonObject;
  processingStatus: AutomationEventProcessingStatus;
  projectionAttemptCount?: number;
  projectionFirstFailedAt?: IsoDateTime | null;
  projectionLastFailedAt?: IsoDateTime | null;
  projectionNextRetryAt?: IsoDateTime | null;
  projectionErrorCode?: string | null;
  projectionErrorMessage?: string | null;
  projectionRetryable?: boolean | null;
  projectionDeadLetteredAt?: IsoDateTime | null;
}

export interface AutomationJob extends VersionedEntity {
  jobType: AutomationJobType;
  blueprintKey: BlueprintKey;
  blueprintVersion: number;
  aggregateType: string;
  aggregateId: EntityId;
  eventId: EntityId | null;
  idempotencyKey: string;
  status: AutomationJobStatus;
  attemptCount: number;
  maxAttempts: number;
  availableAt: IsoDateTime;
  claimedAt: IsoDateTime | null;
  claimedBy: string | null;
  leaseExpiresAt: IsoDateTime | null;
  finishedAt: IsoDateTime | null;
  lastError: JsonObject | null;
  payload: JsonObject;
}

export interface AutomationBlueprint extends VersionedEntity {
  key: BlueprintKey;
  displayName: string;
  blueprintVersion: number;
  status: "draft" | "active" | "paused";
  triggerEventType: OperationsEventType;
  actions: readonly string[];
  parameters: JsonObject;
}

export interface ConnectorReadinessRecord extends VersionedEntity {
  integrationConnectionId: EntityId | null;
  providerType: string;
  displayName: string;
  readinessStatus: ConnectorReadinessStatus;
  lastDryRunAt: IsoDateTime | null;
  lastActivationAt: IsoDateTime | null;
  lastSuccessfulSyncAt: IsoDateTime | null;
  lastError: JsonObject | null;
  subscriptionStatus: string | null;
  subscriptionExpiresAt: IsoDateTime | null;
  requiredAction: string | null;
}

export interface NormalizedInspectionPayload {
  readonly clientName: string | null;
  readonly siteName: string | null;
  readonly inspectorName: string | null;
  readonly completedAt: IsoDateTime | null;
  readonly serviceKey: string | null;
  readonly attestation: boolean;
  readonly summary: string | null;
  readonly findings: readonly NormalizedFindingInput[];
  readonly evidence: readonly NormalizedEvidenceInput[];
}

export interface NormalizedFindingInput {
  readonly code: string;
  readonly sectionKey: string;
  readonly title: string;
  readonly description: string;
  readonly severity: FindingSeverity;
  readonly location: string | null;
}

export interface NormalizedEvidenceInput {
  readonly findingCode: string | null;
  readonly kind: EvidenceKind;
  readonly filename: string;
  readonly contentType: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly storageRef: string;
}

export interface TurnaroundMetrics {
  readonly inspectionCompletedAt: IsoDateTime | null;
  readonly reportDeliveredAt: IsoDateTime | null;
  readonly confirmedDeliveryAt: IsoDateTime | null;
  readonly totalTurnaroundMs: number | null;
  readonly currentAgeMs: number;
  readonly currentStageKey: string;
  readonly currentStageAgeMs: number;
  readonly slaTargetMinutes: number;
  readonly slaElapsedMs: number | null;
  readonly slaRemainingMs: number | null;
  readonly slaStatus: SlaClockStatus | "not_started";
  readonly pauseReason: SlaPauseReason | null;
  readonly pausedDurationMs: number;
  readonly stageDurations: Readonly<Record<string, number>>;
}

export interface TurnaroundBoardWorkProjection {
  readonly workItemId: EntityId | null;
  readonly reference: string | null;
  readonly kind: string | null;
  readonly status: string | null;
  readonly queueKey: string | null;
  readonly assignedRoleKey: string | null;
  readonly assignedUserId: EntityId | null;
  readonly assignedUserName: string | null;
  readonly ageMs: number | null;
  readonly dueAt: IsoDateTime | null;
  readonly reminderState: string | null;
  readonly escalationLevel: string | null;
  readonly blockedReason: string | null;
  readonly requiredAction: string | null;
  readonly humanWaitingMs: number;
  readonly systemProcessingMs: number;
}

export interface TurnaroundBoardItem {
  readonly inspection: Inspection;
  readonly project: Project;
  readonly report: InspectionReport | null;
  readonly sla: SlaClock | null;
  readonly exception: ExceptionCase | null;
  readonly metrics: TurnaroundMetrics;
  readonly inspectorName: string | null;
  readonly currentOwner: string | null;
  readonly nextAction: string;
  readonly work: TurnaroundBoardWorkProjection;
}

export const SEEDED_OPERATIONS_IDS = {
  template: "b3000000-0000-4000-8000-000000000001",
  templateVersion: "b3000000-0000-4000-8000-000000000011",
  happyProject: "b1000000-0000-4000-8000-000000000001",
  blockedProject: "b1000000-0000-4000-8000-000000000002",
  happyInspection: "b2000000-0000-4000-8000-000000000001",
  blockedInspection: "b2000000-0000-4000-8000-000000000002",
} as const;

export class OperationsStatusTransitionError extends Error {
  readonly code = "OPERATIONS_STATUS_TRANSITION_INVALID";

  constructor(
    readonly aggregate: "project" | "inspection" | "report",
    readonly fromStatus: string,
    readonly toStatus: string,
  ) {
    super(`${aggregate} status cannot move from ${fromStatus} to ${toStatus}.`);
    this.name = "OperationsStatusTransitionError";
  }
}

export class OperationsValidationError extends Error {
  readonly code = "OPERATIONS_VALIDATION_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "OperationsValidationError";
  }
}

export class OperationsAuthorizationError extends Error {
  readonly code = "OPERATIONS_AUTHORIZATION_DENIED";

  constructor(message = "You do not have permission to perform this operational action.") {
    super(message);
    this.name = "OperationsAuthorizationError";
  }
}

export class OperationsDuplicateError extends Error {
  readonly code = "OPERATIONS_DUPLICATE_COMMAND";

  constructor(message = "The operational command was already processed.") {
    super(message);
    this.name = "OperationsDuplicateError";
  }
}

export class OperationsNotFoundError extends Error {
  readonly code = "OPERATIONS_RECORD_NOT_FOUND";

  constructor(message = "Operational record was not found.") {
    super(message);
    this.name = "OperationsNotFoundError";
  }
}

export class OperationsConcurrencyError extends Error {
  readonly code = "OPERATIONS_CONCURRENT_UPDATE";

  constructor() {
    super("The operational record changed before the update could be recorded.");
    this.name = "OperationsConcurrencyError";
  }
}

export class DeliveryNotConfirmedError extends Error {
  readonly code = "DELIVERY_NOT_CONFIRMED";

  constructor(message = "Delivery was attempted but not confirmed.") {
    super(message);
    this.name = "DeliveryNotConfirmedError";
  }
}

export function isProjectStatus(value: string): value is ProjectStatus {
  return (PROJECT_STATUSES as readonly string[]).includes(value);
}

export function isInspectionStatus(value: string): value is InspectionStatus {
  return (INSPECTION_STATUSES as readonly string[]).includes(value);
}

export function isReportStatus(value: string): value is ReportStatus {
  return (REPORT_STATUSES as readonly string[]).includes(value);
}

export function isReportReviewDecision(value: string): value is ReportReviewDecision {
  return (REPORT_REVIEW_DECISIONS as readonly string[]).includes(value);
}

export function isInspectionSourceChannel(value: string): value is InspectionSourceChannel {
  return (INSPECTION_SOURCE_CHANNELS as readonly string[]).includes(value);
}

export function isConnectorReadinessHealthy(status: ConnectorReadinessStatus): boolean {
  return status === "healthy";
}

export function formatOperationsReference(prefix: string, sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new OperationsValidationError("Reference sequence must be a positive integer.");
  }
  return `${prefix}${String(sequence).padStart(6, "0")}`;
}

export function isStatusTransitionAllowed<T extends string>(
  map: Readonly<Record<T, readonly T[]>>,
  from: T,
  to: T,
): boolean {
  if (from === to) return false;
  return map[from].includes(to);
}

export function assertProjectStatusTransition(from: ProjectStatus, to: ProjectStatus): void {
  if (!isStatusTransitionAllowed(PROJECT_STATUS_TRANSITIONS, from, to)) {
    throw new OperationsStatusTransitionError("project", from, to);
  }
}

export function assertInspectionStatusTransition(
  from: InspectionStatus,
  to: InspectionStatus,
): void {
  if (!isStatusTransitionAllowed(INSPECTION_STATUS_TRANSITIONS, from, to)) {
    throw new OperationsStatusTransitionError("inspection", from, to);
  }
}

export function assertReportStatusTransition(from: ReportStatus, to: ReportStatus): void {
  if (!isStatusTransitionAllowed(REPORT_STATUS_TRANSITIONS, from, to)) {
    throw new OperationsStatusTransitionError("report", from, to);
  }
}

export function presentText(value: string | null | undefined): boolean {
  return Boolean(value?.trim());
}

export function normalizeInspectionPayload(raw: JsonObject): NormalizedInspectionPayload {
  const findingsRaw = Array.isArray(raw.findings) ? raw.findings : [];
  const evidenceRaw = Array.isArray(raw.evidence) ? raw.evidence : [];
  return {
    clientName: optionalString(raw.clientName),
    siteName: optionalString(raw.siteName),
    inspectorName: optionalString(raw.inspectorName),
    completedAt: optionalString(raw.completedAt),
    serviceKey: optionalString(raw.serviceKey),
    attestation: raw.attestation === true,
    summary: optionalString(raw.summary),
    findings: findingsRaw.flatMap((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const finding = item as JsonObject;
      const severity = String(finding.severity ?? "info");
      return [
        {
          code: optionalString(finding.code) ?? `F-${index + 1}`,
          sectionKey: optionalString(finding.sectionKey) ?? "findings",
          title: optionalString(finding.title) ?? `Finding ${index + 1}`,
          description: optionalString(finding.description) ?? "",
          severity: (FINDING_SEVERITIES as readonly string[]).includes(severity)
            ? (severity as FindingSeverity)
            : "info",
          location: optionalString(finding.location),
        },
      ];
    }),
    evidence: evidenceRaw.flatMap((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const evidence = item as JsonObject;
      const kind = String(evidence.kind ?? "photo");
      return [
        {
          findingCode: optionalString(evidence.findingCode),
          kind: (EVIDENCE_KINDS as readonly string[]).includes(kind)
            ? (kind as EvidenceKind)
            : "photo",
          filename: optionalString(evidence.filename) ?? `evidence-${index + 1}`,
          contentType: optionalString(evidence.contentType) ?? "application/octet-stream",
          sha256: optionalString(evidence.sha256) ?? "",
          byteLength:
            typeof evidence.byteLength === "number" && Number.isFinite(evidence.byteLength)
              ? evidence.byteLength
              : 0,
          storageRef: optionalString(evidence.storageRef) ?? "synthetic://unspecified",
        },
      ];
    }),
  };
}

export function evaluateInspectionCompleteness(
  payload: NormalizedInspectionPayload,
  requirements: ReportRequirementSet = DEFAULT_SYNTHETIC_REQUIREMENTS,
): {
  readonly passed: boolean;
  readonly blocking: readonly InspectionValidationItem[];
  readonly optional: readonly InspectionValidationItem[];
} {
  const blocking: InspectionValidationItem[] = [];
  const optional: InspectionValidationItem[] = [];
  const describedFindings = payload.findings.filter((finding) => presentText(finding.description));
  const hashedEvidence = payload.evidence.filter((item) => /^[a-f0-9]{64}$/iu.test(item.sha256));

  if (requirements.requireClientName && !presentText(payload.clientName)) {
    blocking.push(item("client_name", "Client name is required.", "clientName"));
  }
  if (requirements.requireSiteName && !presentText(payload.siteName)) {
    blocking.push(item("site_name", "Site name is required.", "siteName"));
  }
  if (requirements.requireInspectorName && !presentText(payload.inspectorName)) {
    blocking.push(item("inspector_name", "Inspector name is required.", "inspectorName"));
  }
  if (requirements.requireCompletedAt && !presentText(payload.completedAt)) {
    blocking.push(
      item("completed_at", "Inspection completed timestamp is required.", "completedAt"),
    );
  }
  if (requirements.requireAttestation && payload.attestation !== true) {
    blocking.push(
      item(
        "attestation",
        "Inspector attestation is required before report assembly.",
        "attestation",
      ),
    );
  }
  if (describedFindings.length < requirements.minFindings) {
    blocking.push(
      item(
        "findings",
        `At least ${requirements.minFindings} finding with a description is required.`,
        "findings",
      ),
    );
  }
  if (hashedEvidence.length < requirements.minEvidence) {
    blocking.push(
      item(
        "evidence",
        `At least ${requirements.minEvidence} evidence item with a SHA-256 digest is required.`,
        "evidence",
      ),
    );
  }
  if (requirements.requireSignature) {
    const signature = hashedEvidence.find((item) => item.kind === "signature");
    if (!signature) {
      blocking.push(
        item(
          "signature",
          "A signature evidence item is required by the active rule set.",
          "evidence",
        ),
      );
    }
  }
  if (!presentText(payload.summary)) {
    optional.push({
      code: "summary",
      severity: "optional",
      message: "A narrative summary is useful but not required by the synthetic rule set.",
      path: "summary",
    });
  }
  return { passed: blocking.length === 0, blocking, optional };
}

export function buildIdempotencyKey(parts: readonly string[]): string {
  return parts.map((part) => part.trim()).join(":");
}

export function calculatePercentiles(
  values: readonly number[],
): Readonly<{ p50: number | null; p75: number | null; p90: number | null; worst: number | null }> {
  if (values.length === 0) {
    return { p50: null, p75: null, p90: null, worst: null };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const at = (percentile: number): number => {
    const index = Math.min(sorted.length - 1, Math.ceil((percentile / 100) * sorted.length) - 1);
    return sorted[Math.max(0, index)] ?? sorted[sorted.length - 1]!;
  };
  return {
    p50: at(50),
    p75: at(75),
    p90: at(90),
    worst: sorted[sorted.length - 1] ?? null,
  };
}

export function elapsedMs(from: IsoDateTime, to: IsoDateTime): number {
  return Math.max(0, Date.parse(to) - Date.parse(from));
}

export function pausedDurationMs(input: {
  readonly pausedAt: IsoDateTime | null;
  readonly pausedTotalMs: number;
  readonly now: IsoDateTime;
  readonly status: SlaClockStatus | "not_started";
}): number {
  const current =
    input.status === "paused" && input.pausedAt ? elapsedMs(input.pausedAt, input.now) : 0;
  return Math.max(0, input.pausedTotalMs + current);
}

export function slaElapsedMs(input: {
  readonly startedAt: IsoDateTime;
  readonly now: IsoDateTime;
  readonly targetMinutes?: number;
  readonly pausedAt: IsoDateTime | null;
  readonly pausedTotalMs: number;
  readonly stoppedAt: IsoDateTime | null;
  readonly status: SlaClockStatus | "not_started";
}): number {
  const end = input.stoppedAt ?? input.now;
  return Math.max(
    0,
    elapsedMs(input.startedAt, end) -
      pausedDurationMs({
        pausedAt: input.pausedAt,
        pausedTotalMs: input.pausedTotalMs,
        now: input.now,
        status: input.status,
      }),
  );
}

export function slaRemainingMs(input: {
  readonly startedAt: IsoDateTime;
  readonly now: IsoDateTime;
  readonly targetMinutes: number;
  readonly pausedAt: IsoDateTime | null;
  readonly pausedTotalMs?: number;
  readonly stoppedAt: IsoDateTime | null;
  readonly status?: SlaClockStatus | "not_started";
}): number {
  const used = slaElapsedMs({
    startedAt: input.startedAt,
    now: input.now,
    pausedAt: input.pausedAt,
    pausedTotalMs: input.pausedTotalMs ?? 0,
    stoppedAt: input.stoppedAt,
    status: input.status ?? (input.pausedAt ? "paused" : input.stoppedAt ? "stopped" : "running"),
  });
  return input.targetMinutes * 60_000 - used;
}

export function isSlaStageKey(value: string): value is SlaStageKey {
  return (SLA_STAGE_KEYS as readonly string[]).includes(value);
}

export function syntheticInspectionCompletedAt(now: Date): IsoDateTime {
  return new Date(now.getTime() - SYNTHETIC_INSPECTION_COMPLETION_OFFSET_MS).toISOString();
}

export const PROJECT_STATUS_LABELS: Readonly<Record<ProjectStatus, string>> = {
  awarded: "Awarded",
  initializing: "Initializing",
  ready: "Ready",
  scheduling: "Scheduling",
  fieldwork: "Fieldwork",
  reporting: "Reporting",
  delivered: "Delivered",
  closeout: "Closeout",
  closed: "Closed",
  cancelled: "Cancelled",
};

export const INSPECTION_STATUS_LABELS: Readonly<Record<InspectionStatus, string>> = {
  draft: "Draft",
  scheduled: "Scheduled",
  ready: "Ready",
  in_progress: "In progress",
  completed: "Completed",
  submitted: "Submitted",
  validating: "Validating",
  needs_correction: "Needs correction",
  validated: "Validated",
  reporting: "Reporting",
  complete: "Complete",
  cancelled: "Cancelled",
};

export const REPORT_STATUS_LABELS: Readonly<Record<ReportStatus, string>> = {
  awaiting_data: "Awaiting data",
  assembling: "Assembling",
  draft_ready: "Draft ready",
  in_review: "In review",
  revision_required: "Revision required",
  approved: "Approved",
  rendering_final: "Rendering final",
  ready_for_delivery: "Ready for delivery",
  delivering: "Delivering",
  delivered: "Delivered",
  delivery_failed: "Delivery failed",
  cancelled: "Cancelled",
};

export const CONNECTOR_READINESS_LABELS: Readonly<Record<ConnectorReadinessStatus, string>> = {
  not_connected: "Not connected",
  authenticating: "Authenticating",
  connected_unverified: "Connected, unverified",
  configuration_required: "Configuration required",
  ready_for_dry_run: "Ready for dry-run",
  dry_run_validated: "Dry-run validated",
  activation_blocked: "Activation blocked",
  authenticated: "Authenticated",
  ready_for_activation: "Ready for activation",
  healthy: "Healthy",
  degraded: "Degraded",
  error: "Error",
  auth_expired: "Authentication expired",
  disabled: "Disabled",
};

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function item(code: string, message: string, path: string): InspectionValidationItem {
  return { code, severity: "blocking", message, path };
}
