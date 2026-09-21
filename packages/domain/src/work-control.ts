import type { EntityId, IsoDateTime, JsonObject, VersionedEntity } from "./entities.js";
import type { OperationsEventType } from "./operations.js";
import { buildIdempotencyKey } from "./operations.js";
import type { RoleId } from "./personas.js";
import { DEMO_ROLE_IDS } from "./personas.js";

export const WORK_CONTROL_CONTRACT_VERSION = "phase-3.2a.2";
export const WORK_CONTROL_SYNTHETIC_DISCLOSURE =
  "SYNTHETIC OPERATIONAL POLICY — NOT CONFIRMED BEA ROUTING, SLA, REMINDER, OR ESCALATION POLICY.";
export const WORK_CONTROL_PRODUCTION_UNCONFIGURED =
  "BEA PRODUCTION POLICY: UNCONFIGURED. Activation is blocked until Owner confirms Thursday routing and timing answers.";
export const WORK_CONTROL_CODE_DEFINED_POLICY =
  "CODE-DEFINED SYNTHETIC POLICY WITH DURABLE METADATA. The executor loads SYNTHETIC_WORK_ROUTING_BLUEPRINTS from code. Database policy rows are metadata only. No durable policy transition occurs from inspect or preview actions. Production policy remains unconfigured and blocked.";
export const PROJECTION_MAX_ATTEMPTS = 5;
export const SCHEDULE_MAX_ATTEMPTS = 5;
export const ESCALATION_CATCH_UP_MODE = "highest_currently_due" as const;
export const KNOWN_WORK_ROLE_KEYS: readonly RoleId[] = Object.values(DEMO_ROLE_IDS);
export const EMAIL_DRY_RUN_DISCLOSURE = "EMAIL DRY-RUN — NO MESSAGE SENT";
export const TEAMS_DRY_RUN_DISCLOSURE = "TEAMS DRY-RUN — NO MESSAGE POSTED";
export const SYNTHETIC_NOTIFICATION_RECIPIENT = "operations@example.invalid";

export const WORK_ITEM_KINDS = [
  "inspection_readiness",
  "inspection_submission",
  "inspection_correction",
  "report_technical_review",
  "report_revision",
  "report_delivery_authorization",
  "delivery_reconciliation",
  "automation_failure",
  "sla_escalation",
  "proposal_preparation",
  "proposal_information",
  "proposal_review",
  "proposal_revision",
  "proposal_pricing_override",
  "proposal_delivery_preparation",
] as const;
export type WorkItemKind = (typeof WORK_ITEM_KINDS)[number];

export const WORK_ITEM_STATUSES = [
  "open",
  "acknowledged",
  "in_progress",
  "blocked",
  "completed",
  "cancelled",
] as const;
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

export const WORK_ITEM_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type WorkItemPriority = (typeof WORK_ITEM_PRIORITIES)[number];

export const WORK_ITEM_QUEUE_KEYS = [
  "inspection.readiness",
  "inspection.submission",
  "inspection.correction",
  "report.technical-review",
  "report.revision",
  "report.delivery-authorization",
  "delivery.reconciliation",
  "automation.failure",
  "sla.escalation",
  "proposal.preparation",
  "proposal.information",
  "proposal.review",
  "proposal.revision",
  "proposal.pricing-override",
  "proposal.delivery-preparation",
  "unassigned",
] as const;
export type WorkItemQueueKey = (typeof WORK_ITEM_QUEUE_KEYS)[number];

export const WORK_ITEM_ASSIGNMENT_STRATEGIES = [
  "explicit_user",
  "role_queue",
  "domain_assignee_then_role",
] as const;
export type WorkItemAssignmentStrategy = (typeof WORK_ITEM_ASSIGNMENT_STRATEGIES)[number];

export const WORK_ITEM_ESCALATION_LEVELS = [
  "none",
  "watch",
  "at_risk",
  "breached",
  "critical",
] as const;
export type WorkItemEscalationLevel = (typeof WORK_ITEM_ESCALATION_LEVELS)[number];

export const NOTIFICATION_CHANNELS = ["in_app", "email_dry_run", "teams_dry_run"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_STATUSES = [
  "planned",
  "queued",
  "delivered_in_app",
  "rendered_dry_run",
  "suppressed",
  "failed",
  "cancelled",
] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const SCHEDULE_ACTION_TYPES = [
  "work.reminder",
  "work.escalation",
  "work.reconcile",
  "work.project-events",
] as const;
export type ScheduleActionType = (typeof SCHEDULE_ACTION_TYPES)[number];

export const SCHEDULE_STATUSES = [
  "pending",
  "due",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "paused",
  "disabled",
] as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];

export const ORCHESTRATION_POLICY_STATUSES = [
  "draft",
  "validated",
  "published",
  "active",
  "superseded",
  "archived",
] as const;
export type OrchestrationPolicyStatus = (typeof ORCHESTRATION_POLICY_STATUSES)[number];

export const WORK_TRIGGER_STATUSES = [
  "active_internal",
  "configuration_required",
  "ready_for_dry_run",
  "activation_blocked",
  "disabled",
  "degraded",
  "error",
] as const;
export type WorkTriggerStatus = (typeof WORK_TRIGGER_STATUSES)[number];

export const WORK_REMINDER_RELATIVE_FIELDS = [
  "available_at",
  "due_at",
  "inspection.completed_at",
  "report.draft_created_at",
  "report.ready_for_delivery_at",
] as const;
export type WorkReminderRelativeField = (typeof WORK_REMINDER_RELATIVE_FIELDS)[number];

export const CRITICAL_WORK_ITEM_KINDS: readonly WorkItemKind[] = WORK_ITEM_KINDS;

export const WORK_ITEM_STATUS_TRANSITIONS: Readonly<
  Record<WorkItemStatus, readonly WorkItemStatus[]>
> = {
  open: ["acknowledged", "in_progress", "blocked", "completed", "cancelled"],
  acknowledged: ["in_progress", "blocked", "completed", "cancelled"],
  in_progress: ["blocked", "completed", "cancelled"],
  blocked: ["in_progress", "completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export const WORK_ITEM_KIND_QUEUE: Readonly<Record<WorkItemKind, WorkItemQueueKey>> = {
  inspection_readiness: "inspection.readiness",
  inspection_submission: "inspection.submission",
  inspection_correction: "inspection.correction",
  report_technical_review: "report.technical-review",
  report_revision: "report.revision",
  report_delivery_authorization: "report.delivery-authorization",
  delivery_reconciliation: "delivery.reconciliation",
  automation_failure: "automation.failure",
  sla_escalation: "sla.escalation",
  proposal_preparation: "proposal.preparation",
  proposal_information: "proposal.information",
  proposal_review: "proposal.review",
  proposal_revision: "proposal.revision",
  proposal_pricing_override: "proposal.pricing-override",
  proposal_delivery_preparation: "proposal.delivery-preparation",
};

export const WORK_ITEM_KIND_LABELS: Readonly<Record<WorkItemKind, string>> = {
  inspection_readiness: "Inspection readiness",
  inspection_submission: "Inspection submission",
  inspection_correction: "Inspection correction",
  report_technical_review: "Technical review",
  report_revision: "Report revision",
  report_delivery_authorization: "Delivery authorization",
  delivery_reconciliation: "Delivery reconciliation",
  automation_failure: "Automation failure",
  sla_escalation: "SLA escalation",
  proposal_preparation: "Proposal preparation",
  proposal_information: "Proposal information",
  proposal_review: "Proposal review",
  proposal_revision: "Proposal revision",
  proposal_pricing_override: "Pricing override review",
  proposal_delivery_preparation: "Proposal delivery preparation",
};

export const WORK_ITEM_REQUIRED_ACTIONS: Readonly<Record<WorkItemKind, string>> = {
  inspection_readiness: "Mark the inspection ready through the protected inspection command.",
  inspection_submission: "Submit the inspection package through the protected inspection command.",
  inspection_correction: "Submit a corrected inspection package through the protected command.",
  report_technical_review:
    "Approve, request revision, or return the report through reports.review.",
  report_revision: "Submit a corrected package that produces the next report version.",
  report_delivery_authorization:
    "Authorize delivery through the Owner-only reports.deliver command.",
  delivery_reconciliation: "Retry or reconcile the failed delivery through the protected command.",
  automation_failure: "Inspect the dead-lettered job and retry or cancel it safely.",
  sla_escalation: "Act on the blocked human gate that is delaying report turnaround.",
  proposal_preparation:
    "Create a proposal draft from the ready lead through the protected proposal command.",
  proposal_information:
    "Complete required proposal information through the protected proposal command.",
  proposal_review:
    "Approve or request revision of the exact proposal version through proposals.approve.",
  proposal_revision: "Submit a new proposal version through the protected proposal command.",
  proposal_pricing_override:
    "Approve or reject the exact pricing override through proposals.override.approve.",
  proposal_delivery_preparation:
    "Generate the no-write delivery manifest through proposals.delivery.plan. No message is sent.",
};

export const OWNER_ONLY_WORK_ITEM_KINDS: readonly WorkItemKind[] = [
  "report_delivery_authorization",
  "proposal_review",
  "proposal_pricing_override",
];

export class WorkItemTransitionError extends Error {
  readonly code = "WORK_ITEM_TRANSITION_INVALID";

  constructor(
    readonly fromStatus: string,
    readonly toStatus: string,
  ) {
    super(`Work item status cannot move from ${fromStatus} to ${toStatus}.`);
    this.name = "WorkItemTransitionError";
  }
}

export class WorkItemManualCompletionError extends Error {
  readonly code = "WORK_ITEM_MANUAL_COMPLETION_REFUSED";

  constructor(kind: WorkItemKind) {
    super(
      `Critical workflow work item ${kind} cannot be completed manually. Complete the protected domain action.`,
    );
    this.name = "WorkItemManualCompletionError";
  }
}

export class WorkItemClaimError extends Error {
  readonly code = "WORK_ITEM_CLAIM_REFUSED";

  constructor(message: string) {
    super(message);
    this.name = "WorkItemClaimError";
  }
}

export class WorkProjectionError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly safeMessage: string;
  readonly eventType?: string | undefined;
  readonly blueprintKey?: string | undefined;
  readonly workItemKind?: string | undefined;
  readonly projectionAction?: string | undefined;
  readonly missingFields?: readonly string[] | undefined;
  readonly eventId?: string | undefined;
  readonly remediation?: string | undefined;

  constructor(
    code: string,
    message: string,
    retryable = true,
    details?: {
      readonly eventType?: string;
      readonly blueprintKey?: string;
      readonly workItemKind?: string;
      readonly projectionAction?: string;
      readonly missingFields?: readonly string[];
      readonly eventId?: string;
      readonly remediation?: string;
    },
  ) {
    super(message);
    this.name = "WorkProjectionError";
    this.code = code;
    this.retryable = retryable;
    this.safeMessage = message;
    this.eventType = details?.eventType;
    this.blueprintKey = details?.blueprintKey;
    this.workItemKind = details?.workItemKind;
    this.projectionAction = details?.projectionAction;
    this.missingFields = details?.missingFields;
    this.eventId = details?.eventId;
    this.remediation = details?.remediation;
  }
}

export class WorkReassignmentError extends Error {
  readonly code = "WORK_ITEM_REASSIGN_REFUSED";

  constructor(message: string) {
    super(message);
    this.name = "WorkReassignmentError";
  }
}

export function isKnownWorkRoleKey(value: string | null | undefined): value is RoleId {
  return Boolean(value && (KNOWN_WORK_ROLE_KEYS as readonly string[]).includes(value));
}

export function cycleIdentityIsExact(cycleIdentity: string): boolean {
  return Boolean(cycleIdentity) && !cycleIdentity.includes(":unknown");
}

export function projectionRetryDelayMs(attemptNumber: number): number {
  const bounded = Math.max(1, Math.min(attemptNumber, 12));
  return Math.min(5 * 60 * 1000, 1000 * 2 ** (bounded - 1));
}

export function scheduleRetryDelayMs(attemptNumber: number): number {
  return projectionRetryDelayMs(attemptNumber);
}

export function sanitizeProjectionError(error: unknown): {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
} {
  if (error instanceof WorkProjectionError) {
    return { code: error.code, message: error.safeMessage, retryable: error.retryable };
  }
  const raw = error instanceof Error ? error.message : "projection_failed";
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code ?? "PROJECTION_FAILED")
      : "PROJECTION_FAILED";
  const message = raw
    .replace(/password=[^ \t]+/giu, "password=[redacted]")
    .replace(/Bearer [A-Za-z0-9._-]+/gu, "Bearer [redacted]")
    .replace(/-----BEGIN[\s\S]+?-----END [A-Z ]+-----/gu, "[redacted-pem]")
    .replace(/\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)\b[\s\S]{0,240}/giu, "[sql-redacted]")
    .slice(0, 280);
  return {
    code: code.slice(0, 80),
    message: message || "Projection failed.",
    retryable: true,
  };
}

export function skippedEscalationLevels(
  current: WorkItemEscalationLevel,
  selected: Exclude<WorkItemEscalationLevel, "none">,
): readonly Exclude<WorkItemEscalationLevel, "none">[] {
  const order: Exclude<WorkItemEscalationLevel, "none">[] = [
    "watch",
    "at_risk",
    "breached",
    "critical",
  ];
  const currentRank = { none: -1, watch: 0, at_risk: 1, breached: 2, critical: 3 }[current];
  const selectedRank = { watch: 0, at_risk: 1, breached: 2, critical: 3 }[selected];
  return order.filter((_, index) => index > currentRank && index < selectedRank);
}

export function assertWorkItemTransition(from: WorkItemStatus, to: WorkItemStatus): void {
  if (!WORK_ITEM_STATUS_TRANSITIONS[from].includes(to)) {
    throw new WorkItemTransitionError(from, to);
  }
}

export function isOpenWorkItemStatus(status: WorkItemStatus): boolean {
  return (
    status === "open" ||
    status === "acknowledged" ||
    status === "in_progress" ||
    status === "blocked"
  );
}

export function isTerminalWorkItemStatus(status: WorkItemStatus): boolean {
  return status === "completed" || status === "cancelled";
}

export function workItemIsOverdue(dueAt: string | null, now: Date): boolean {
  if (!dueAt) return false;
  return Date.parse(dueAt) < now.getTime();
}

export function workItemIsAtRisk(
  dueAt: string | null,
  availableAt: string,
  now: Date,
  atRiskRatio = 0.9,
): boolean {
  if (!dueAt) return false;
  const start = Date.parse(availableAt);
  const due = Date.parse(dueAt);
  if (!Number.isFinite(start) || !Number.isFinite(due) || due <= start) {
    return workItemIsOverdue(dueAt, now);
  }
  const threshold = start + (due - start) * atRiskRatio;
  return now.getTime() >= threshold && now.getTime() < due;
}

export function buildWorkProjectionIdempotencyKey(input: {
  readonly sourceEventId: string;
  readonly blueprintKey: string;
  readonly blueprintVersion: number;
  readonly cycleIdentity: string;
  readonly actionType: string;
}): string {
  return buildIdempotencyKey([
    input.sourceEventId,
    input.blueprintKey,
    String(input.blueprintVersion),
    input.cycleIdentity,
    input.actionType,
  ]);
}

export function buildWorkItemCycleIdentity(input: {
  readonly kind: WorkItemKind;
  readonly inspectionId?: string | null;
  readonly reportId?: string | null;
  readonly reportVersionId?: string | null;
  readonly exceptionId?: string | null;
  readonly submissionId?: string | null;
  readonly deliveryId?: string | null;
  readonly deliveryAuthorizationId?: string | null;
  readonly jobId?: string | null;
  readonly requestedRevisionVersionId?: string | null;
  readonly projectionEventId?: string | null;
  readonly scheduledActionId?: string | null;
  readonly failureSourceType?: "job" | "projection" | "schedule" | null;
  readonly failureSourceId?: string | null;
  readonly revisionCycle?: number;
  readonly leadId?: string | null;
  readonly proposalId?: string | null;
  readonly proposalVersionId?: string | null;
  readonly catalogVersionId?: string | null;
  readonly pricingOverrideId?: string | null;
  readonly informationCycleNumber?: number | null;
}): string {
  const id = (value: string | null | undefined) => value?.trim() || "unknown";
  switch (input.kind) {
    case "inspection_readiness":
      return `inspection:${id(input.inspectionId)}:readiness`;
    case "inspection_submission":
      return `inspection:${id(input.inspectionId)}:submission`;
    case "inspection_correction":
      return `inspection:${id(input.inspectionId)}:correction:${id(input.exceptionId)}`;
    case "report_technical_review":
      return `report:${id(input.reportId)}:review:${id(input.reportVersionId)}`;
    case "report_revision":
      return `report:${id(input.reportId)}:revision:${id(input.requestedRevisionVersionId ?? input.reportVersionId)}`;
    case "report_delivery_authorization":
      return `report:${id(input.reportId)}:delivery-auth:${id(input.reportVersionId)}`;
    case "delivery_reconciliation":
      return `report:${id(input.reportId)}:reconciliation:${id(input.deliveryId)}`;
    case "automation_failure": {
      const sourceType =
        input.failureSourceType ??
        (input.scheduledActionId ? "schedule" : input.projectionEventId ? "projection" : "job");
      const sourceId =
        input.failureSourceId ??
        (sourceType === "schedule"
          ? input.scheduledActionId
          : sourceType === "projection"
            ? input.projectionEventId
            : input.jobId);
      if (sourceType === "projection") return `projection:${id(sourceId)}:dead-letter`;
      if (sourceType === "schedule") return `schedule:${id(sourceId)}:dead-letter`;
      return `job:${id(sourceId)}:dead-letter`;
    }
    case "sla_escalation":
      return `inspection:${id(input.inspectionId)}:sla:${input.revisionCycle ?? 1}`;
    case "proposal_preparation":
      return `lead:${id(input.leadId)}:proposal-preparation`;
    case "proposal_information":
      return `proposal:${id(input.proposalId)}:information:${input.informationCycleNumber ?? "unknown"}`;
    case "proposal_review":
      return `proposal:${id(input.proposalId)}:review:${id(input.proposalVersionId)}`;
    case "proposal_revision":
      return `proposal:${id(input.proposalId)}:revision:${id(input.proposalVersionId)}`;
    case "proposal_pricing_override":
      return `proposal:${id(input.proposalId)}:override:${id(input.pricingOverrideId)}`;
    case "proposal_delivery_preparation":
      return `proposal:${id(input.proposalId)}:delivery:${id(input.proposalVersionId)}`;
    default: {
      const exhaustive: never = input.kind;
      return exhaustive;
    }
  }
}

export type WorkProjectionAction = "create" | "complete" | "cancel";

export function cycleIdentityForBlueprintAction(input: {
  readonly kind: WorkItemKind;
  readonly action: WorkProjectionAction;
  readonly inspectionId?: string | null;
  readonly reportId?: string | null;
  readonly reportVersionId?: string | null;
  readonly requestedRevisionVersionId?: string | null;
  readonly exceptionId?: string | null;
  readonly submissionId?: string | null;
  readonly deliveryId?: string | null;
  readonly deliveryAuthorizationId?: string | null;
  readonly jobId?: string | null;
  readonly projectionEventId?: string | null;
  readonly scheduledActionId?: string | null;
  readonly failureSourceType?: "job" | "projection" | "schedule" | null;
  readonly failureSourceId?: string | null;
  readonly leadId?: string | null;
  readonly proposalId?: string | null;
  readonly proposalVersionId?: string | null;
  readonly catalogVersionId?: string | null;
  readonly pricingOverrideId?: string | null;
  readonly informationCycleNumber?: number | null;
}): string {
  const revisionVersionId =
    input.kind === "report_revision" && input.action !== "create"
      ? (input.requestedRevisionVersionId ?? input.reportVersionId)
      : input.kind === "report_revision"
        ? (input.reportVersionId ?? input.requestedRevisionVersionId)
        : input.reportVersionId;
  return buildWorkItemCycleIdentity({
    kind: input.kind,
    inspectionId: input.inspectionId ?? null,
    reportId: input.reportId ?? null,
    reportVersionId: revisionVersionId ?? null,
    requestedRevisionVersionId:
      input.kind === "report_revision"
        ? (input.requestedRevisionVersionId ?? input.reportVersionId ?? null)
        : (input.requestedRevisionVersionId ?? null),
    exceptionId: input.exceptionId ?? null,
    submissionId: input.submissionId ?? null,
    deliveryId: input.deliveryId ?? null,
    deliveryAuthorizationId: input.deliveryAuthorizationId ?? null,
    jobId: input.jobId ?? null,
    projectionEventId: input.projectionEventId ?? null,
    scheduledActionId: input.scheduledActionId ?? null,
    failureSourceType: input.failureSourceType ?? null,
    failureSourceId: input.failureSourceId ?? null,
    leadId: input.leadId ?? null,
    proposalId: input.proposalId ?? null,
    proposalVersionId: input.proposalVersionId ?? null,
    catalogVersionId: input.catalogVersionId ?? null,
    pricingOverrideId: input.pricingOverrideId ?? null,
    informationCycleNumber: input.informationCycleNumber ?? null,
  });
}

export interface WorkRoutingBlueprint {
  readonly blueprintKey: string;
  readonly blueprintVersion: number;
  readonly triggerEventTypes: readonly OperationsEventType[];
  readonly workItemKind: WorkItemKind;
  readonly queueKey: WorkItemQueueKey;
  readonly assignmentStrategy: WorkItemAssignmentStrategy;
  readonly assignedRoleKey: RoleId;
  readonly dueOffsetMs: number;
  readonly priority: WorkItemPriority;
  readonly completionEventTypes: readonly OperationsEventType[];
  readonly cancellationEventTypes: readonly OperationsEventType[];
  readonly title: string;
  readonly requiredAction: string;
  readonly deepLinkTemplate: string;
  readonly synthetic: true;
  readonly triggerStatus: WorkTriggerStatus;
}

export const SYNTHETIC_WORK_ROUTING_BLUEPRINTS: readonly WorkRoutingBlueprint[] = [
  {
    blueprintKey: "work.inspection-readiness",
    blueprintVersion: 1,
    triggerEventTypes: ["inspection.created", "inspection.scheduled"],
    workItemKind: "inspection_readiness",
    queueKey: "inspection.readiness",
    assignmentStrategy: "domain_assignee_then_role",
    assignedRoleKey: DEMO_ROLE_IDS.OPERATIONS,
    dueOffsetMs: 4 * 60 * 60 * 1000,
    priority: "normal",
    completionEventTypes: ["inspection.ready"],
    cancellationEventTypes: ["inspection.cancelled"],
    title: "Prepare inspection readiness",
    requiredAction: WORK_ITEM_REQUIRED_ACTIONS.inspection_readiness,
    deepLinkTemplate: "/inspections/{inspectionId}",
    synthetic: true,
    triggerStatus: "active_internal",
  },
  {
    blueprintKey: "work.inspection-submission",
    blueprintVersion: 1,
    triggerEventTypes: ["inspection.completed"],
    workItemKind: "inspection_submission",
    queueKey: "inspection.submission",
    assignmentStrategy: "domain_assignee_then_role",
    assignedRoleKey: DEMO_ROLE_IDS.OPERATIONS,
    dueOffsetMs: 2 * 60 * 60 * 1000,
    priority: "high",
    completionEventTypes: ["inspection.submitted"],
    cancellationEventTypes: ["inspection.cancelled"],
    title: "Submit inspection package",
    requiredAction: WORK_ITEM_REQUIRED_ACTIONS.inspection_submission,
    deepLinkTemplate: "/inspections/{inspectionId}",
    synthetic: true,
    triggerStatus: "active_internal",
  },
  {
    blueprintKey: "work.inspection-correction",
    blueprintVersion: 1,
    triggerEventTypes: [
      "inspection.validation_failed",
      "exception.created",
      "report.returned_to_inspector",
    ],
    workItemKind: "inspection_correction",
    queueKey: "inspection.correction",
    assignmentStrategy: "domain_assignee_then_role",
    assignedRoleKey: DEMO_ROLE_IDS.OPERATIONS,
    dueOffsetMs: 4 * 60 * 60 * 1000,
    priority: "urgent",
    completionEventTypes: ["exception.resolved", "inspection.submitted", "inspection.validated"],
    cancellationEventTypes: ["inspection.cancelled"],
    title: "Correct inspection package",
    requiredAction: WORK_ITEM_REQUIRED_ACTIONS.inspection_correction,
    deepLinkTemplate: "/inspections/{inspectionId}",
    synthetic: true,
    triggerStatus: "active_internal",
  },
  {
    blueprintKey: "work.report-technical-review",
    blueprintVersion: 1,
    triggerEventTypes: ["report.review_requested", "report.draft_created"],
    workItemKind: "report_technical_review",
    queueKey: "report.technical-review",
    assignmentStrategy: "domain_assignee_then_role",
    assignedRoleKey: DEMO_ROLE_IDS.OPERATIONS,
    dueOffsetMs: 8 * 60 * 60 * 1000,
    priority: "high",
    completionEventTypes: [
      "report.approved",
      "report.revision_requested",
      "report.returned_to_inspector",
    ],
    cancellationEventTypes: ["inspection.cancelled"],
    title: "Complete technical review",
    requiredAction: WORK_ITEM_REQUIRED_ACTIONS.report_technical_review,
    deepLinkTemplate: "/reports/{reportId}",
    synthetic: true,
    triggerStatus: "active_internal",
  },
  {
    blueprintKey: "work.report-revision",
    blueprintVersion: 1,
    triggerEventTypes: ["report.revision_requested"],
    workItemKind: "report_revision",
    queueKey: "report.revision",
    assignmentStrategy: "domain_assignee_then_role",
    assignedRoleKey: DEMO_ROLE_IDS.OPERATIONS,
    dueOffsetMs: 8 * 60 * 60 * 1000,
    priority: "high",
    completionEventTypes: ["report.draft_created", "report.review_requested"],
    cancellationEventTypes: ["inspection.cancelled"],
    title: "Revise report package",
    requiredAction: WORK_ITEM_REQUIRED_ACTIONS.report_revision,
    deepLinkTemplate: "/inspections/{inspectionId}",
    synthetic: true,
    triggerStatus: "active_internal",
  },
  {
    blueprintKey: "work.report-delivery-authorization",
    blueprintVersion: 1,
    triggerEventTypes: ["report.ready_for_delivery"],
    workItemKind: "report_delivery_authorization",
    queueKey: "report.delivery-authorization",
    assignmentStrategy: "role_queue",
    assignedRoleKey: DEMO_ROLE_IDS.OWNER_ADMIN,
    dueOffsetMs: 2 * 60 * 60 * 1000,
    priority: "urgent",
    completionEventTypes: ["report.delivery_requested"],
    cancellationEventTypes: ["report.delivery_authorization_revoked", "inspection.cancelled"],
    title: "Authorize report delivery",
    requiredAction: WORK_ITEM_REQUIRED_ACTIONS.report_delivery_authorization,
    deepLinkTemplate: "/reports/{reportId}",
    synthetic: true,
    triggerStatus: "active_internal",
  },
  {
    blueprintKey: "work.delivery-reconciliation",
    blueprintVersion: 1,
    triggerEventTypes: ["report.delivery_failed"],
    workItemKind: "delivery_reconciliation",
    queueKey: "delivery.reconciliation",
    assignmentStrategy: "role_queue",
    assignedRoleKey: DEMO_ROLE_IDS.OWNER_ADMIN,
    dueOffsetMs: 60 * 60 * 1000,
    priority: "urgent",
    completionEventTypes: ["report.delivered"],
    cancellationEventTypes: ["inspection.cancelled"],
    title: "Reconcile failed delivery",
    requiredAction: WORK_ITEM_REQUIRED_ACTIONS.delivery_reconciliation,
    deepLinkTemplate: "/reports/{reportId}",
    synthetic: true,
    triggerStatus: "active_internal",
  },
  {
    blueprintKey: "work.automation-failure",
    blueprintVersion: 1,
    triggerEventTypes: [
      "automation.job_dead_letter",
      "automation.projection_dead_lettered",
      "automation.schedule_dead_lettered",
    ],
    workItemKind: "automation_failure",
    queueKey: "automation.failure",
    assignmentStrategy: "role_queue",
    assignedRoleKey: DEMO_ROLE_IDS.INTEGRATION_ADMIN,
    dueOffsetMs: 60 * 60 * 1000,
    priority: "high",
    completionEventTypes: [
      "automation.job_succeeded",
      "automation.job_cancelled",
      "automation.job_resolved",
      "automation.projection_succeeded",
      "automation.projection_cancelled",
      "automation.schedule_succeeded",
      "automation.schedule_cancelled",
      "automation.schedule_resolved",
    ],
    cancellationEventTypes: [
      "automation.job_cancelled",
      "automation.projection_cancelled",
      "automation.schedule_cancelled",
    ],
    title: "Resolve automation dead letter",
    requiredAction: WORK_ITEM_REQUIRED_ACTIONS.automation_failure,
    deepLinkTemplate: "/automations",
    synthetic: true,
    triggerStatus: "active_internal",
  },
  {
    blueprintKey: "work.proposal-preparation",
    blueprintVersion: 1,
    triggerEventTypes: ["lead.ready_for_proposal"],
    workItemKind: "proposal_preparation",
    queueKey: "proposal.preparation",
    assignmentStrategy: "domain_assignee_then_role",
    assignedRoleKey: DEMO_ROLE_IDS.SALES,
    dueOffsetMs: 8 * 60 * 60 * 1000,
    priority: "high",
    completionEventTypes: ["proposal.created"],
    cancellationEventTypes: ["lead.disqualified", "lead.needs_info"],
    title: "Prepare proposal",
    requiredAction: WORK_ITEM_REQUIRED_ACTIONS.proposal_preparation,
    deepLinkTemplate: "/leads/{leadId}",
    synthetic: true,
    triggerStatus: "active_internal",
  },
  {
    blueprintKey: "work.proposal-information",
    blueprintVersion: 1,
    triggerEventTypes: ["proposal.readiness_failed", "proposal.needs_information"],
    workItemKind: "proposal_information",
    queueKey: "proposal.information",
    assignmentStrategy: "domain_assignee_then_role",
    assignedRoleKey: DEMO_ROLE_IDS.SALES,
    dueOffsetMs: 8 * 60 * 60 * 1000,
    priority: "high",
    completionEventTypes: ["proposal.ready_for_review", "proposal.submitted_for_review"],
    cancellationEventTypes: ["proposal.cancelled"],
    title: "Complete proposal information",
    requiredAction: WORK_ITEM_REQUIRED_ACTIONS.proposal_information,
    deepLinkTemplate: "/proposals/{proposalId}",
    synthetic: true,
    triggerStatus: "active_internal",
  },
  {
    blueprintKey: "work.proposal-review",
    blueprintVersion: 1,
    triggerEventTypes: ["proposal.submitted_for_review"],
    workItemKind: "proposal_review",
    queueKey: "proposal.review",
    assignmentStrategy: "domain_assignee_then_role",
    assignedRoleKey: DEMO_ROLE_IDS.OWNER_ADMIN,
    dueOffsetMs: 8 * 60 * 60 * 1000,
    priority: "urgent",
    completionEventTypes: ["proposal.approved", "proposal.revision_requested"],
    cancellationEventTypes: ["proposal.cancelled"],
    title: "Review proposal version",
    requiredAction: WORK_ITEM_REQUIRED_ACTIONS.proposal_review,
    deepLinkTemplate: "/proposals/{proposalId}",
    synthetic: true,
    triggerStatus: "active_internal",
  },
  {
    blueprintKey: "work.proposal-revision",
    blueprintVersion: 1,
    triggerEventTypes: ["proposal.revision_requested"],
    workItemKind: "proposal_revision",
    queueKey: "proposal.revision",
    assignmentStrategy: "domain_assignee_then_role",
    assignedRoleKey: DEMO_ROLE_IDS.SALES,
    dueOffsetMs: 8 * 60 * 60 * 1000,
    priority: "high",
    completionEventTypes: ["proposal.submitted_for_review"],
    cancellationEventTypes: ["proposal.cancelled"],
    title: "Revise exact proposal version",
    requiredAction: WORK_ITEM_REQUIRED_ACTIONS.proposal_revision,
    deepLinkTemplate: "/proposals/{proposalId}",
    synthetic: true,
    triggerStatus: "active_internal",
  },
  {
    blueprintKey: "work.proposal-pricing-override",
    blueprintVersion: 1,
    triggerEventTypes: ["proposal.pricing_override_requested"],
    workItemKind: "proposal_pricing_override",
    queueKey: "proposal.pricing-override",
    assignmentStrategy: "domain_assignee_then_role",
    assignedRoleKey: DEMO_ROLE_IDS.OWNER_ADMIN,
    dueOffsetMs: 4 * 60 * 60 * 1000,
    priority: "high",
    completionEventTypes: [
      "proposal.pricing_override_approved",
      "proposal.pricing_override_rejected",
    ],
    cancellationEventTypes: ["proposal.cancelled"],
    title: "Review pricing override",
    requiredAction: WORK_ITEM_REQUIRED_ACTIONS.proposal_pricing_override,
    deepLinkTemplate: "/proposals/{proposalId}",
    synthetic: true,
    triggerStatus: "active_internal",
  },
  {
    blueprintKey: "work.proposal-delivery-preparation",
    blueprintVersion: 1,
    triggerEventTypes: ["proposal.approved"],
    workItemKind: "proposal_delivery_preparation",
    queueKey: "proposal.delivery-preparation",
    assignmentStrategy: "domain_assignee_then_role",
    assignedRoleKey: DEMO_ROLE_IDS.SALES,
    dueOffsetMs: 4 * 60 * 60 * 1000,
    priority: "normal",
    completionEventTypes: ["proposal.delivery_manifest_created"],
    cancellationEventTypes: ["proposal.cancelled"],
    title: "Prepare external delivery",
    requiredAction: WORK_ITEM_REQUIRED_ACTIONS.proposal_delivery_preparation,
    deepLinkTemplate: "/proposals/{proposalId}",
    synthetic: true,
    triggerStatus: "active_internal",
  },
];

export interface WorkReminderRule {
  readonly thresholdKey: string;
  readonly relativeTo: WorkReminderRelativeField;
  readonly offsetMs: number;
  readonly audience: "assignee" | "role_queue" | "owner";
  readonly channels: readonly NotificationChannel[];
  readonly maximumCount: 1;
  readonly synthetic: true;
}

export const SYNTHETIC_REMINDER_RULES: readonly WorkReminderRule[] = [
  {
    thresholdKey: "due_soon",
    relativeTo: "due_at",
    offsetMs: -60 * 60 * 1000,
    audience: "assignee",
    channels: ["in_app", "email_dry_run"],
    maximumCount: 1,
    synthetic: true,
  },
  {
    thresholdKey: "due_now",
    relativeTo: "due_at",
    offsetMs: 0,
    audience: "assignee",
    channels: ["in_app", "email_dry_run", "teams_dry_run"],
    maximumCount: 1,
    synthetic: true,
  },
  {
    thresholdKey: "overdue",
    relativeTo: "due_at",
    offsetMs: 60 * 60 * 1000,
    audience: "role_queue",
    channels: ["in_app", "email_dry_run"],
    maximumCount: 1,
    synthetic: true,
  },
  {
    thresholdKey: "overdue_second",
    relativeTo: "due_at",
    offsetMs: 2 * 60 * 60 * 1000,
    audience: "owner",
    channels: ["in_app", "teams_dry_run"],
    maximumCount: 1,
    synthetic: true,
  },
];

export interface WorkEscalationRule {
  readonly level: Exclude<WorkItemEscalationLevel, "none">;
  readonly ratioOfDueWindow: number;
  readonly ownerVisible: boolean;
}

export const SYNTHETIC_ESCALATION_RULES: readonly WorkEscalationRule[] = [
  { level: "watch", ratioOfDueWindow: 0.5, ownerVisible: false },
  { level: "at_risk", ratioOfDueWindow: 0.9, ownerVisible: false },
  { level: "breached", ratioOfDueWindow: 1, ownerVisible: true },
  { level: "critical", ratioOfDueWindow: 2, ownerVisible: true },
];

export function reminderDueAt(anchor: string, offsetMs: number): string {
  return new Date(Date.parse(anchor) + offsetMs).toISOString();
}

export function selectReminderAnchor(input: {
  readonly relativeTo: WorkReminderRelativeField;
  readonly availableAt: string;
  readonly dueAt: string | null;
  readonly inspectionCompletedAt?: string | null;
  readonly reportDraftCreatedAt?: string | null;
  readonly reportReadyForDeliveryAt?: string | null;
}): string | null {
  switch (input.relativeTo) {
    case "available_at":
      return input.availableAt;
    case "due_at":
      return input.dueAt;
    case "inspection.completed_at":
      return input.inspectionCompletedAt ?? null;
    case "report.draft_created_at":
      return input.reportDraftCreatedAt ?? null;
    case "report.ready_for_delivery_at":
      return input.reportReadyForDeliveryAt ?? null;
    default: {
      const exhaustive: never = input.relativeTo;
      return exhaustive;
    }
  }
}

export function escalationDueAt(input: {
  readonly availableAt: string;
  readonly dueAt: string | null;
  readonly ratioOfDueWindow: number;
}): string | null {
  if (!input.dueAt) return null;
  const start = Date.parse(input.availableAt);
  const due = Date.parse(input.dueAt);
  if (!Number.isFinite(start) || !Number.isFinite(due)) return null;
  const windowMs = Math.max(due - start, 60_000);
  return new Date(start + windowMs * input.ratioOfDueWindow).toISOString();
}

export function nextEscalationLevel(
  current: WorkItemEscalationLevel,
  availableAt: string,
  dueAt: string | null,
  now: Date,
): Exclude<WorkItemEscalationLevel, "none"> | null {
  const rank: Record<WorkItemEscalationLevel, number> = {
    none: 0,
    watch: 1,
    at_risk: 2,
    breached: 3,
    critical: 4,
  };
  let selected: Exclude<WorkItemEscalationLevel, "none"> | null = null;
  for (const rule of SYNTHETIC_ESCALATION_RULES) {
    const due = escalationDueAt({
      availableAt,
      dueAt,
      ratioOfDueWindow: rule.ratioOfDueWindow,
    });
    if (due && Date.parse(due) <= now.getTime() && rank[rule.level] > rank[current]) {
      selected = rule.level;
    }
  }
  return selected;
}

export function shouldSuppressTimedAction(input: {
  readonly status: WorkItemStatus;
  readonly slaPaused: boolean;
  readonly pauseReason: string | null;
}): boolean {
  if (isTerminalWorkItemStatus(input.status)) return true;
  return input.slaPaused && input.pauseReason === "customer_caused";
}

export function notificationShouldBeSuppressed(input: {
  readonly workItemStatus: WorkItemStatus;
  readonly alreadyExists: boolean;
  readonly slaPaused: boolean;
  readonly pauseReason: string | null;
}): { readonly suppressed: boolean; readonly reason: string | null } {
  if (input.alreadyExists) {
    return { suppressed: true, reason: "duplicate_threshold" };
  }
  if (isTerminalWorkItemStatus(input.workItemStatus)) {
    return { suppressed: true, reason: "work_item_terminal" };
  }
  if (input.slaPaused && input.pauseReason === "customer_caused") {
    return { suppressed: true, reason: "sla_paused_customer_caused" };
  }
  return { suppressed: false, reason: null };
}

export interface WorkAssignmentDecision {
  readonly assignedUserId: string | null;
  readonly assignedRoleKey: RoleId;
  readonly queueKey: WorkItemQueueKey;
  readonly strategy: WorkItemAssignmentStrategy;
}

export function decideWorkAssignment(input: {
  readonly blueprint: WorkRoutingBlueprint;
  readonly domainAssigneeUserId?: string | null;
  readonly configuredUserId?: string | null;
}): WorkAssignmentDecision {
  if (input.blueprint.assignmentStrategy === "role_queue") {
    return {
      assignedUserId: null,
      assignedRoleKey: input.blueprint.assignedRoleKey,
      queueKey: input.blueprint.queueKey,
      strategy: "role_queue",
    };
  }
  if (input.blueprint.assignmentStrategy === "explicit_user" && input.configuredUserId) {
    return {
      assignedUserId: input.configuredUserId,
      assignedRoleKey: input.blueprint.assignedRoleKey,
      queueKey: input.blueprint.queueKey,
      strategy: "explicit_user",
    };
  }
  if (input.domainAssigneeUserId) {
    return {
      assignedUserId: input.domainAssigneeUserId,
      assignedRoleKey: input.blueprint.assignedRoleKey,
      queueKey: input.blueprint.queueKey,
      strategy: "domain_assignee_then_role",
    };
  }
  if (input.configuredUserId) {
    return {
      assignedUserId: input.configuredUserId,
      assignedRoleKey: input.blueprint.assignedRoleKey,
      queueKey: input.blueprint.queueKey,
      strategy: "explicit_user",
    };
  }
  return {
    assignedUserId: null,
    assignedRoleKey: input.blueprint.assignedRoleKey,
    queueKey: input.blueprint.queueKey,
    strategy: "role_queue",
  };
}

export function userMayClaimWorkItem(input: {
  readonly actorUserId: string;
  readonly actorRoleKeys: readonly string[];
  readonly assignedUserId: string | null;
  readonly assignedRoleKey: string | null;
  readonly claimedUserId: string | null;
  readonly workItemKind: WorkItemKind;
  readonly hasOwnerPrivilege: boolean;
}): { readonly allowed: boolean; readonly reason: string } {
  if (
    input.claimedUserId &&
    input.claimedUserId !== input.actorUserId &&
    !input.hasOwnerPrivilege
  ) {
    return { allowed: false, reason: "already_claimed" };
  }
  if (
    OWNER_ONLY_WORK_ITEM_KINDS.includes(input.workItemKind) &&
    !input.actorRoleKeys.includes(DEMO_ROLE_IDS.OWNER_ADMIN)
  ) {
    return { allowed: false, reason: "owner_only_delivery_authorization" };
  }
  if (input.assignedUserId && input.assignedUserId === input.actorUserId) {
    return { allowed: true, reason: "explicit_assignee" };
  }
  if (input.assignedUserId && !input.hasOwnerPrivilege) {
    return { allowed: false, reason: "assigned_to_another_user" };
  }
  if (
    input.assignedRoleKey &&
    (input.actorRoleKeys.includes(input.assignedRoleKey) || input.hasOwnerPrivilege)
  ) {
    return { allowed: true, reason: "role_queue" };
  }
  if (input.hasOwnerPrivilege) {
    return { allowed: true, reason: "owner_override" };
  }
  return { allowed: false, reason: "not_eligible" };
}

export type ReconciliationActionType =
  "create_missing" | "complete_stale" | "cancel_superseded" | "noop";

export interface ReconciliationDecision {
  readonly action: ReconciliationActionType;
  readonly kind: WorkItemKind;
  readonly reason: string;
  readonly cycleIdentity: string;
}

export function decideReconciliation(input: {
  readonly kind: WorkItemKind;
  readonly required: boolean;
  readonly domainComplete: boolean;
  readonly domainCancelled: boolean;
  readonly openWorkItem: boolean;
  readonly cycleIdentity: string;
}): ReconciliationDecision {
  if (input.domainCancelled && input.openWorkItem) {
    return {
      action: "cancel_superseded",
      kind: input.kind,
      reason: "Official domain record is cancelled or superseded.",
      cycleIdentity: input.cycleIdentity,
    };
  }
  if (input.domainComplete && input.openWorkItem) {
    return {
      action: "complete_stale",
      kind: input.kind,
      reason: "Official domain action already occurred.",
      cycleIdentity: input.cycleIdentity,
    };
  }
  if (input.required && !input.domainComplete && !input.domainCancelled && !input.openWorkItem) {
    return {
      action: "create_missing",
      kind: input.kind,
      reason: "Required open work item is missing for current domain state.",
      cycleIdentity: input.cycleIdentity,
    };
  }
  return {
    action: "noop",
    kind: input.kind,
    reason: "Projection matches official domain state.",
    cycleIdentity: input.cycleIdentity,
  };
}

export function schedulerCatchUpDue(input: {
  readonly scheduledFor: string;
  readonly now: Date;
  readonly status: ScheduleStatus;
}): boolean {
  if (input.status === "paused" || input.status === "disabled" || input.status === "cancelled") {
    return false;
  }
  if (input.status === "succeeded") return false;
  return Date.parse(input.scheduledFor) <= input.now.getTime();
}

export function percentile(values: readonly number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index] ?? null;
}

export function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export interface OperationalWorkItem extends VersionedEntity {
  reference: string;
  workItemKind: WorkItemKind;
  status: WorkItemStatus;
  priority: WorkItemPriority;
  queueKey: WorkItemQueueKey;
  assignedRoleKey: string | null;
  assignedUserId: EntityId | null;
  claimedUserId: EntityId | null;
  claimedAt: IsoDateTime | null;
  projectId: EntityId | null;
  inspectionId: EntityId | null;
  submissionId: EntityId | null;
  reportId: EntityId | null;
  reportVersionId: EntityId | null;
  requestedRevisionVersionId: EntityId | null;
  exceptionId: EntityId | null;
  deliveryAuthorizationId: EntityId | null;
  deliveryId: EntityId | null;
  jobId: EntityId | null;
  scheduledActionId: EntityId | null;
  failureSourceType: "job" | "projection" | "schedule" | null;
  failureSourceId: EntityId | null;
  leadId: EntityId | null;
  proposalId: EntityId | null;
  proposalVersionId: EntityId | null;
  catalogVersionId: EntityId | null;
  pricingOverrideId: EntityId | null;
  sourceEventId: EntityId | null;
  sourceAggregateType: string;
  sourceAggregateId: EntityId;
  policyKey: string;
  policyVersion: number;
  configurationReleaseId: EntityId | null;
  idempotencyKey: string;
  cycleIdentity: string;
  title: string;
  reason: string;
  requiredAction: string;
  deepLink: string;
  availableAt: IsoDateTime;
  dueAt: IsoDateTime | null;
  acknowledgedAt: IsoDateTime | null;
  startedAt: IsoDateTime | null;
  blockedAt: IsoDateTime | null;
  completedAt: IsoDateTime | null;
  cancelledAt: IsoDateTime | null;
  blockedReason: string | null;
  completionEventType: string | null;
  completionEventId: EntityId | null;
  escalationLevel: WorkItemEscalationLevel;
  lastReminderAt: IsoDateTime | null;
  reminderCount: number;
  synthetic: boolean;
  correlationId: string;
  causationId: string | null;
}

export interface WorkItemReminder {
  readonly id: EntityId;
  readonly workItemId: EntityId;
  readonly thresholdKey: string;
  readonly policyVersion: number;
  readonly scheduledFor: IsoDateTime;
  readonly createdAt: IsoDateTime;
  readonly synthetic: boolean;
}

export interface WorkItemEscalation {
  readonly id: EntityId;
  readonly workItemId: EntityId;
  readonly escalationLevel: Exclude<WorkItemEscalationLevel, "none">;
  readonly reason: string;
  readonly createdAt: IsoDateTime;
  readonly resolvedAt: IsoDateTime | null;
  readonly policyVersion: number;
  readonly ownerVisible: boolean;
}

export interface NotificationOutboxRecord {
  readonly id: EntityId;
  readonly workItemId: EntityId | null;
  readonly reminderId: EntityId | null;
  readonly escalationId: EntityId | null;
  readonly channel: NotificationChannel;
  readonly recipientUserId: EntityId | null;
  readonly recipientRoleKey: string | null;
  readonly recipientPlaceholder: string;
  readonly subject: string;
  readonly body: string;
  readonly deepLink: string;
  readonly status: NotificationStatus;
  readonly suppressionReason: string | null;
  readonly adapterResult: string | null;
  readonly idempotencyKey: string;
  readonly policyVersion: number;
  readonly correlationId: string;
  readonly createdAt: IsoDateTime;
  readonly availableAt: IsoDateTime;
  readonly processedAt: IsoDateTime | null;
}

export interface ScheduledAutomationAction {
  readonly id: EntityId;
  readonly scheduleKey: string;
  readonly policyVersion: number;
  readonly actionType: ScheduleActionType;
  readonly workItemId: EntityId | null;
  readonly aggregateType: string | null;
  readonly aggregateId: EntityId | null;
  readonly scheduledFor: IsoDateTime;
  readonly lastEvaluatedAt: IsoDateTime | null;
  readonly nextRunAt: IsoDateTime | null;
  readonly status: ScheduleStatus;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly attemptCount: number;
  readonly maxAttempts?: number;
  readonly lastResult: string | null;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

export interface WorkPolicyPreview {
  readonly action: "inspect-policy" | "validate-policy-preview" | "activation-readiness-preview";
  readonly durableTransitionOccurred: false;
  readonly codeDefinedSyntheticRoutingActive: true;
  readonly productionPolicyUnconfigured: true;
  readonly productionActivationBlocked: true;
  readonly executorSource: typeof WORK_CONTROL_CODE_DEFINED_POLICY;
  readonly disclosure: typeof WORK_CONTROL_SYNTHETIC_DISCLOSURE;
  readonly productionDisclosure: typeof WORK_CONTROL_PRODUCTION_UNCONFIGURED;
}

export interface OrchestrationPolicyVersion {
  readonly id: EntityId;
  readonly policyKey: string;
  readonly policyVersion: number;
  readonly status: OrchestrationPolicyStatus;
  readonly synthetic: boolean;
  readonly productionReady: boolean;
  readonly serviceContextKey: string;
  readonly disclosure: string;
  readonly payload: JsonObject;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

export interface ExternalTriggerProvisioningPlan {
  readonly synthetic: true;
  readonly liveConnection: false;
  readonly status: "configuration_required" | "activation_blocked";
  readonly items: readonly {
    readonly source: string;
    readonly mechanism: string;
    readonly resourceSelection: string;
    readonly permissions: readonly string[];
    readonly reconciliationSchedule: string;
    readonly internalEvent: OperationsEventType;
    readonly disclosure: string;
  }[];
}

export function buildExternalTriggerProvisioningPlan(): ExternalTriggerProvisioningPlan {
  return {
    synthetic: true,
    liveConnection: false,
    status: "activation_blocked",
    items: [
      {
        source: "Outlook inbox",
        mechanism: "Future Graph webhook or mailbox polling after Microsoft 365 connection",
        resourceSelection: "Owner-selected mailbox / folder. NOT SELECTED.",
        permissions: ["Mail.Read", "Mail.ReadWrite"],
        reconciliationSchedule: "Recurring internal catch-up after mailbox delta",
        internalEvent: "inspection.submitted",
        disclosure: "LIVE CONNECTION: NOT RUN. No subscription is installed.",
      },
      {
        source: "SharePoint library",
        mechanism: "Future Graph webhook or drive-item polling",
        resourceSelection: "Owner-selected library / folder. NOT SELECTED.",
        permissions: ["Sites.Read.All", "Files.Read.All"],
        reconciliationSchedule: "Recurring internal catch-up after drive delta",
        internalEvent: "inspection.submitted",
        disclosure: "LIVE CONNECTION: NOT RUN. No SharePoint file is created.",
      },
      {
        source: "Calendar reminder",
        mechanism: "Future Graph calendar subscription",
        resourceSelection: "Owner-selected calendar. NOT SELECTED.",
        permissions: ["Calendars.ReadWrite"],
        reconciliationSchedule: "Internal scheduler remains the system of record",
        internalEvent: "work_item.reminder_due",
        disclosure: "LIVE CONNECTION: NOT RUN. No calendar event is created.",
      },
    ],
  };
}

export function safeWorkNotificationBody(input: {
  readonly reference: string;
  readonly title: string;
  readonly requiredAction: string;
  readonly dueAt: string | null;
  readonly deepLink: string;
  readonly synthetic: boolean;
}): string {
  const due = input.dueAt ? ` Due ${input.dueAt}.` : "";
  const synthetic = input.synthetic ? ` ${WORK_CONTROL_SYNTHETIC_DISCLOSURE}` : "";
  return `${input.reference}: ${input.title}. ${input.requiredAction}${due} Open ${input.deepLink}.${synthetic} This message never includes raw inspection source, signatures, credentials, or report contents.`;
}

export const SYNTHETIC_ORCHESTRATION_POLICY_PAYLOAD = {
  policyKey: "bea.synthetic-operational-orchestration",
  policyVersion: 1,
  routing: SYNTHETIC_WORK_ROUTING_BLUEPRINTS.map((item) => item.blueprintKey),
  dueOffsetsMs: Object.fromEntries(
    SYNTHETIC_WORK_ROUTING_BLUEPRINTS.map((item) => [item.workItemKind, item.dueOffsetMs]),
  ),
  reminderRules: SYNTHETIC_REMINDER_RULES,
  escalationRules: SYNTHETIC_ESCALATION_RULES,
  suppression: {
    pauseReason: "customer_caused",
    suppressReminders: true,
    suppressEscalations: true,
  },
  reconciliationCadenceMs: 15 * 60 * 1000,
  synthetic: true,
} as const;

export const PRODUCTION_ORCHESTRATION_POLICY_PAYLOAD = {
  policyKey: "bea.production-operational-orchestration",
  policyVersion: 1,
  routing: [],
  dueOffsetsMs: {},
  reminderRules: [],
  escalationRules: [],
  suppression: {},
  reconciliationCadenceMs: null,
  synthetic: false,
  productionReady: false,
  unconfigured: true,
} as const;

export const SEEDED_WORK_CONTROL_IDS = {
  syntheticPolicy: "d1000000-0000-4000-8000-000000000001",
  productionPolicy: "d1000000-0000-4000-8000-000000000002",
  labCorrectionWork: "d2000000-0000-4000-8000-000000000001",
  labDeliveryWork: "d2000000-0000-4000-8000-000000000002",
  labEscalatedWork: "d2000000-0000-4000-8000-000000000003",
  labNotificationEmail: "d3000000-0000-4000-8000-000000000001",
  labNotificationTeams: "d3000000-0000-4000-8000-000000000002",
  recurringReconcile: "d4000000-0000-4000-8000-000000000001",
  labCorrectionInspection: "d2100000-0000-4000-8000-000000000001",
  labDeliveryInspection: "d2100000-0000-4000-8000-000000000002",
  labEscalatedInspection: "d2100000-0000-4000-8000-000000000003",
  labDeliveryReport: "d2200000-0000-4000-8000-000000000001",
  labEscalatedReport: "d2200000-0000-4000-8000-000000000002",
  labDeliveryVersion: "d2300000-0000-4000-8000-000000000001",
  labEscalatedVersion: "d2300000-0000-4000-8000-000000000002",
  labException: "d2400000-0000-4000-8000-000000000001",
  labEscalation: "d2500000-0000-4000-8000-000000000001",
  labReminder: "d2600000-0000-4000-8000-000000000001",
  labAutomationJob: "d2700000-0000-4000-8000-000000000001",
  labAutomationWork: "d2000000-0000-4000-8000-000000000004",
  labDeliverySubmission: "d2800000-0000-4000-8000-000000000001",
  labEscalatedSubmission: "d2800000-0000-4000-8000-000000000002",
} as const;
