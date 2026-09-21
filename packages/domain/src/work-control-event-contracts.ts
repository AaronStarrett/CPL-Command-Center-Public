import type { JsonObject } from "./entities.js";
import {
  buildWorkItemCycleIdentity,
  cycleIdentityIsExact,
  WorkProjectionError,
  type WorkItemKind,
  type WorkProjectionAction,
  type WorkRoutingBlueprint,
} from "./work-control.js";

export const WORK_FAILURE_SOURCE_TYPES = ["job", "projection", "schedule"] as const;
export type WorkFailureSourceType = (typeof WORK_FAILURE_SOURCE_TYPES)[number];

export type WorkIdentityPresence = "required" | "optional_explicit" | "not_applicable";

export interface EventIdentityFieldContract {
  readonly field: string;
  readonly presence: WorkIdentityPresence;
  readonly aliases?: readonly string[];
  readonly notes: string;
}

export interface EventIdentityContract {
  readonly eventType: string;
  readonly fields: readonly EventIdentityFieldContract[];
}

export interface WorkEventIdentity {
  readonly eventType: string;
  readonly eventId: string;
  readonly inspectionId: string | null;
  readonly reportId: string | null;
  readonly reportVersionId: string | null;
  readonly requestedRevisionVersionId: string | null;
  readonly submissionId: string | null;
  readonly exceptionId: string | null;
  readonly exceptionIds: readonly string[];
  readonly exceptionIdsPresent: boolean;
  readonly deliveryId: string | null;
  readonly deliveryAuthorizationId: string | null;
  readonly jobId: string | null;
  readonly projectionEventId: string | null;
  readonly scheduledActionId: string | null;
  readonly failureSourceType: WorkFailureSourceType | null;
  readonly failureSourceId: string | null;
  readonly leadId: string | null;
  readonly proposalId: string | null;
  readonly proposalVersionId: string | null;
  readonly catalogVersionId: string | null;
  readonly pricingOverrideId: string | null;
  readonly informationCycleNumber: number | null;
}

export type WorkCycleResolution =
  | {
      readonly kind: "exact_cycle";
      readonly cycleIdentity: string;
      readonly identity: WorkEventIdentity;
    }
  | {
      readonly kind: "not_applicable";
      readonly reason: string;
      readonly eventType: string;
      readonly blueprintKey: string;
      readonly workItemKind: WorkItemKind;
      readonly projectionAction: WorkProjectionAction;
      readonly eventId: string;
    }
  | {
      readonly kind: "malformed_missing_identity";
      readonly missingFields: readonly string[];
      readonly eventType: string;
      readonly blueprintKey: string;
      readonly workItemKind: WorkItemKind;
      readonly projectionAction: WorkProjectionAction;
      readonly eventId: string;
      readonly remediation: string;
    };

export class WorkProjectionNotFoundError extends Error {
  readonly code = "WORK_PROJECTION_NOT_FOUND";

  constructor(message = "Projection event was not found.") {
    super(message);
    this.name = "WorkProjectionNotFoundError";
  }
}

export class WorkProjectionRetryConflictError extends Error {
  readonly code = "WORK_PROJECTION_RETRY_CONFLICT";

  constructor(message = "Only failed or dead-lettered projections can be retried.") {
    super(message);
    this.name = "WorkProjectionRetryConflictError";
  }
}

export const EVENT_IDENTITY_CONTRACTS: readonly EventIdentityContract[] = [
  {
    eventType: "inspection.ready",
    fields: [
      {
        field: "inspectionId",
        presence: "required",
        notes: "Usually the inspection aggregate ID.",
      },
    ],
  },
  {
    eventType: "inspection.completed",
    fields: [{ field: "inspectionId", presence: "required", notes: "Inspection aggregate ID." }],
  },
  {
    eventType: "inspection.submitted",
    fields: [
      { field: "inspectionId", presence: "required", notes: "Inspection aggregate ID." },
      {
        field: "submissionId",
        presence: "required",
        notes: "Required for submission-specific projection.",
      },
      {
        field: "exceptionIds",
        presence: "optional_explicit",
        notes: "Must be present when the event can close correction cycles. Empty array is valid.",
      },
    ],
  },
  {
    eventType: "inspection.validation_failed",
    fields: [
      { field: "inspectionId", presence: "required", notes: "Inspection aggregate ID." },
      {
        field: "exceptionId",
        presence: "required",
        aliases: ["exceptionIds"],
        notes: "Exact exception ID is required when correction work is created.",
      },
    ],
  },
  {
    eventType: "inspection.validated",
    fields: [
      { field: "inspectionId", presence: "required", notes: "Inspection aggregate ID." },
      {
        field: "exceptionIds",
        presence: "optional_explicit",
        notes: "Property must be present. Empty array is valid when no correction cycle existed.",
      },
    ],
  },
  {
    eventType: "exception.created",
    fields: [
      {
        field: "exceptionId",
        presence: "required",
        notes: "Normally the exception aggregate ID.",
      },
      {
        field: "inspectionId",
        presence: "required",
        aliases: ["reportId"],
        notes: "inspectionId or reportId according to the exception relationship.",
      },
    ],
  },
  {
    eventType: "exception.resolved",
    fields: [
      {
        field: "exceptionId",
        presence: "required",
        notes: "Normally the exception aggregate ID.",
      },
    ],
  },
  {
    eventType: "report.draft_created",
    fields: [
      { field: "reportId", presence: "required", notes: "Report aggregate ID." },
      {
        field: "reportVersionId",
        presence: "required",
        aliases: ["versionId"],
        notes: "Required to create technical-review work.",
      },
      {
        field: "requestedRevisionVersionId",
        presence: "optional_explicit",
        aliases: ["previousVersionId"],
        notes:
          "May be absent for an initial non-revision draft. Required to close a revision cycle.",
      },
    ],
  },
  {
    eventType: "report.review_requested",
    fields: [
      { field: "reportId", presence: "required", notes: "Report aggregate ID." },
      {
        field: "reportVersionId",
        presence: "required",
        aliases: ["versionId"],
        notes: "Exact version under review.",
      },
      {
        field: "requestedRevisionVersionId",
        presence: "optional_explicit",
        aliases: ["previousVersionId"],
        notes: "Present only when this review closes a prior revision cycle.",
      },
    ],
  },
  {
    eventType: "report.approved",
    fields: [
      { field: "reportId", presence: "required", notes: "Report aggregate ID." },
      {
        field: "reportVersionId",
        presence: "required",
        aliases: ["versionId"],
        notes: "Exact version being approved. Must not infer the current version.",
      },
    ],
  },
  {
    eventType: "report.revision_requested",
    fields: [
      { field: "reportId", presence: "required", notes: "Report aggregate ID." },
      {
        field: "reportVersionId",
        presence: "required",
        aliases: ["requestedRevisionVersionId"],
        notes: "Version that must be revised.",
      },
    ],
  },
  {
    eventType: "report.returned_to_inspector",
    fields: [
      { field: "reportId", presence: "required", notes: "Report aggregate ID." },
      {
        field: "reportVersionId",
        presence: "required",
        aliases: ["versionId"],
        notes: "Exact returned version.",
      },
      {
        field: "exceptionId",
        presence: "required",
        notes: "Required after the correction exception is created.",
      },
    ],
  },
  {
    eventType: "report.ready_for_delivery",
    fields: [
      { field: "reportId", presence: "required", notes: "Report aggregate ID." },
      {
        field: "reportVersionId",
        presence: "required",
        aliases: ["versionId"],
        notes: "Exact version ready for delivery authorization.",
      },
    ],
  },
  {
    eventType: "report.delivery_requested",
    fields: [
      { field: "reportId", presence: "required", notes: "Report aggregate ID." },
      {
        field: "reportVersionId",
        presence: "required",
        aliases: ["versionId"],
        notes: "Exact authorized version. Must not infer the current version.",
      },
      {
        field: "deliveryAuthorizationId",
        presence: "optional_explicit",
        aliases: ["authorizationId"],
        notes: "Present on official delivery requests. Cycle identity is keyed by report version.",
      },
    ],
  },
  {
    eventType: "report.delivery_authorization_revoked",
    fields: [
      { field: "reportId", presence: "required", notes: "Report aggregate ID." },
      {
        field: "reportVersionId",
        presence: "required",
        aliases: ["deliveryAuthorizationId"],
        notes: "Exact version and/or deliveryAuthorizationId according to the cycle contract.",
      },
    ],
  },
  {
    eventType: "report.delivery_failed",
    fields: [
      { field: "reportId", presence: "required", notes: "Report aggregate ID." },
      {
        field: "reportVersionId",
        presence: "required",
        aliases: ["versionId"],
        notes: "Exact failed version.",
      },
      { field: "deliveryId", presence: "required", notes: "Exact failed delivery." },
    ],
  },
  {
    eventType: "report.delivered",
    fields: [
      { field: "reportId", presence: "required", notes: "Report aggregate ID." },
      {
        field: "reportVersionId",
        presence: "required",
        aliases: ["versionId"],
        notes: "Exact delivered version.",
      },
      { field: "deliveryId", presence: "required", notes: "Exact delivery identity." },
    ],
  },
  {
    eventType: "automation.job_dead_letter",
    fields: [
      {
        field: "jobId",
        presence: "required",
        notes: "Must identify an automation job, never a scheduled action.",
      },
    ],
  },
  {
    eventType: "automation.job_retry_requested",
    fields: [{ field: "jobId", presence: "required", notes: "Exact automation job." }],
  },
  {
    eventType: "automation.job_requeued",
    fields: [{ field: "jobId", presence: "required", notes: "Exact automation job." }],
  },
  {
    eventType: "automation.job_succeeded",
    fields: [{ field: "jobId", presence: "required", notes: "Exact automation job." }],
  },
  {
    eventType: "automation.job_cancelled",
    fields: [{ field: "jobId", presence: "required", notes: "Exact automation job." }],
  },
  {
    eventType: "automation.job_resolved",
    fields: [{ field: "jobId", presence: "required", notes: "Exact automation job." }],
  },
  {
    eventType: "automation.projection_dead_lettered",
    fields: [
      {
        field: "sourceEventId",
        presence: "required",
        aliases: ["projectionEventId"],
        notes: "Identifies the original automation event that exhausted projection.",
      },
    ],
  },
  {
    eventType: "automation.projection_retry_requested",
    fields: [
      {
        field: "sourceEventId",
        presence: "required",
        aliases: ["projectionEventId"],
        notes: "Exact original automation event.",
      },
    ],
  },
  {
    eventType: "automation.projection_succeeded",
    fields: [
      {
        field: "sourceEventId",
        presence: "required",
        aliases: ["projectionEventId"],
        notes: "Exact original automation event.",
      },
    ],
  },
  {
    eventType: "automation.projection_cancelled",
    fields: [
      {
        field: "sourceEventId",
        presence: "required",
        aliases: ["projectionEventId"],
        notes: "Exact original automation event.",
      },
    ],
  },
  {
    eventType: "automation.schedule_retry_requested",
    fields: [
      {
        field: "scheduleId",
        presence: "required",
        aliases: ["scheduledActionId"],
        notes: "A schedule ID must not be placed in jobId.",
      },
    ],
  },
  {
    eventType: "automation.schedule_requeued",
    fields: [
      {
        field: "scheduleId",
        presence: "required",
        aliases: ["scheduledActionId"],
        notes: "A schedule ID must not be placed in jobId.",
      },
    ],
  },
  {
    eventType: "automation.schedule_succeeded",
    fields: [
      {
        field: "scheduleId",
        presence: "required",
        aliases: ["scheduledActionId"],
        notes: "A schedule ID must not be placed in jobId.",
      },
    ],
  },
  {
    eventType: "automation.schedule_dead_lettered",
    fields: [
      {
        field: "scheduleId",
        presence: "required",
        aliases: ["scheduledActionId"],
        notes: "A schedule ID must not be placed in jobId.",
      },
    ],
  },
  {
    eventType: "automation.schedule_cancelled",
    fields: [
      {
        field: "scheduleId",
        presence: "required",
        aliases: ["scheduledActionId"],
        notes: "A schedule ID must not be placed in jobId.",
      },
    ],
  },
  {
    eventType: "automation.schedule_resolved",
    fields: [
      {
        field: "scheduleId",
        presence: "required",
        aliases: ["scheduledActionId"],
        notes: "A schedule ID must not be placed in jobId.",
      },
    ],
  },
  {
    eventType: "lead.ready_for_proposal",
    fields: [{ field: "leadId", presence: "required", notes: "Lead aggregate ID." }],
  },
  {
    eventType: "lead.disqualified",
    fields: [{ field: "leadId", presence: "required", notes: "Lead aggregate ID." }],
  },
  {
    eventType: "lead.needs_info",
    fields: [{ field: "leadId", presence: "required", notes: "Lead aggregate ID." }],
  },
  {
    eventType: "proposal.created",
    fields: [
      { field: "proposalId", presence: "required", notes: "Proposal aggregate ID." },
      { field: "leadId", presence: "required", notes: "Source lead ID." },
      { field: "catalogVersionId", presence: "required", notes: "Pinned catalog version." },
    ],
  },
  {
    eventType: "proposal.readiness_failed",
    fields: [
      { field: "proposalId", presence: "required", notes: "Proposal aggregate ID." },
      { field: "leadId", presence: "required", notes: "Source lead ID." },
      {
        field: "informationCycleNumber",
        presence: "required",
        notes: "Exact proposal information cycle. Must not be inferred from latest state.",
      },
    ],
  },
  {
    eventType: "proposal.needs_information",
    fields: [
      { field: "proposalId", presence: "required", notes: "Proposal aggregate ID." },
      {
        field: "informationCycleNumber",
        presence: "required",
        notes: "Exact proposal information cycle. Must not be inferred from latest state.",
      },
    ],
  },
  {
    eventType: "proposal.ready_for_review",
    fields: [
      { field: "proposalId", presence: "required", notes: "Proposal aggregate ID." },
      {
        field: "informationCycleNumber",
        presence: "required",
        notes: "Exact proposal information cycle being closed.",
      },
    ],
  },
  {
    eventType: "proposal.submitted_for_review",
    fields: [
      { field: "proposalId", presence: "required", notes: "Proposal aggregate ID." },
      {
        field: "proposalVersionId",
        presence: "required",
        notes: "Exact frozen version submitted for review.",
      },
      {
        field: "informationCycleNumber",
        presence: "required",
        notes: "Exact proposal information cycle being closed if one is open.",
      },
    ],
  },
  {
    eventType: "proposal.revision_requested",
    fields: [
      { field: "proposalId", presence: "required", notes: "Proposal aggregate ID." },
      {
        field: "proposalVersionId",
        presence: "required",
        notes: "Exact version that remains immutable.",
      },
    ],
  },
  {
    eventType: "proposal.approved",
    fields: [
      { field: "proposalId", presence: "required", notes: "Proposal aggregate ID." },
      {
        field: "proposalVersionId",
        presence: "required",
        notes: "Exact approved version. A later version cannot reuse this approval.",
      },
    ],
  },
  {
    eventType: "proposal.pricing_override_requested",
    fields: [
      { field: "proposalId", presence: "required", notes: "Proposal aggregate ID." },
      {
        field: "overrideId",
        presence: "required",
        aliases: ["pricingOverrideId"],
        notes: "Exact pricing override under review.",
      },
    ],
  },
  {
    eventType: "proposal.pricing_override_approved",
    fields: [
      { field: "proposalId", presence: "required", notes: "Proposal aggregate ID." },
      {
        field: "overrideId",
        presence: "required",
        aliases: ["pricingOverrideId"],
        notes: "Exact override.",
      },
    ],
  },
  {
    eventType: "proposal.pricing_override_rejected",
    fields: [
      { field: "proposalId", presence: "required", notes: "Proposal aggregate ID." },
      {
        field: "overrideId",
        presence: "required",
        aliases: ["pricingOverrideId"],
        notes: "Exact override.",
      },
    ],
  },
  {
    eventType: "proposal.delivery_manifest_created",
    fields: [
      { field: "proposalId", presence: "required", notes: "Proposal aggregate ID." },
      {
        field: "proposalVersionId",
        presence: "required",
        notes: "Approved version for the dry-run.",
      },
    ],
  },
  {
    eventType: "proposal.cancelled",
    fields: [{ field: "proposalId", presence: "required", notes: "Proposal aggregate ID." }],
  },
];

const EVENT_CONTRACT_BY_TYPE = new Map(
  EVENT_IDENTITY_CONTRACTS.map((item) => [item.eventType, item]),
);

export function eventIdentityContractFor(eventType: string): EventIdentityContract | undefined {
  return EVENT_CONTRACT_BY_TYPE.get(eventType);
}

export function payloadHasOwnKey(payload: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(payload, key);
}

export function cycleIdentityIncompleteMessage(input: {
  readonly eventType: string;
  readonly workItemKind: string;
  readonly projectionAction: WorkProjectionAction;
  readonly missingFields: readonly string[];
}): string {
  const missing = input.missingFields.join(", ");
  const verb =
    input.projectionAction === "create"
      ? "create"
      : input.projectionAction === "cancel"
        ? "cancel"
        : "close";
  return `CYCLE_IDENTITY_INCOMPLETE: ${input.eventType} requires ${missing} to ${verb} ${input.workItemKind}.`;
}

export function createCycleIdentityIncompleteError(
  resolution: Extract<WorkCycleResolution, { kind: "malformed_missing_identity" }>,
): WorkProjectionError {
  return new WorkProjectionError(
    "CYCLE_IDENTITY_INCOMPLETE",
    cycleIdentityIncompleteMessage(resolution),
    true,
    {
      eventType: resolution.eventType,
      blueprintKey: resolution.blueprintKey,
      workItemKind: resolution.workItemKind,
      projectionAction: resolution.projectionAction,
      missingFields: resolution.missingFields,
      eventId: resolution.eventId,
      remediation: resolution.remediation,
    },
  );
}

function filled(value: string | null | undefined): value is string {
  return Boolean(value && value.trim() && value.trim() !== "unknown");
}

function identityValue(identity: WorkEventIdentity, field: string): string | null {
  switch (field) {
    case "inspectionId":
      return identity.inspectionId;
    case "reportId":
      return identity.reportId;
    case "reportVersionId":
    case "versionId":
      return identity.reportVersionId;
    case "requestedRevisionVersionId":
    case "previousVersionId":
      return identity.requestedRevisionVersionId;
    case "submissionId":
      return identity.submissionId;
    case "exceptionId":
      return identity.exceptionId;
    case "deliveryId":
      return identity.deliveryId;
    case "deliveryAuthorizationId":
    case "authorizationId":
      return identity.deliveryAuthorizationId;
    case "jobId":
      return identity.jobId;
    case "sourceEventId":
    case "projectionEventId":
      return identity.projectionEventId;
    case "scheduleId":
    case "scheduledActionId":
      return identity.scheduledActionId;
    case "leadId":
      return identity.leadId;
    case "proposalId":
      return identity.proposalId;
    case "proposalVersionId":
      return identity.proposalVersionId;
    case "catalogVersionId":
      return identity.catalogVersionId;
    case "overrideId":
    case "pricingOverrideId":
      return identity.pricingOverrideId;
    case "informationCycleNumber":
      return identity.informationCycleNumber != null && identity.informationCycleNumber > 0
        ? String(identity.informationCycleNumber)
        : null;
    default:
      return null;
  }
}

function malformed(
  input: {
    readonly identity: WorkEventIdentity;
    readonly blueprint: Pick<WorkRoutingBlueprint, "blueprintKey" | "workItemKind">;
    readonly action: WorkProjectionAction;
  },
  missingFields: readonly string[],
): Extract<WorkCycleResolution, { kind: "malformed_missing_identity" }> {
  const unique = [...new Set(missingFields.filter(Boolean))];
  return {
    kind: "malformed_missing_identity",
    missingFields: unique,
    eventType: input.identity.eventType,
    blueprintKey: input.blueprint.blueprintKey,
    workItemKind: input.blueprint.workItemKind,
    projectionAction: input.action,
    eventId: input.identity.eventId,
    remediation: `Correct the source event payload so ${unique.join(", ")} is present, then retry projection.`,
  };
}

function notApplicable(
  input: {
    readonly identity: WorkEventIdentity;
    readonly blueprint: Pick<WorkRoutingBlueprint, "blueprintKey" | "workItemKind">;
    readonly action: WorkProjectionAction;
  },
  reason: string,
): Extract<WorkCycleResolution, { kind: "not_applicable" }> {
  return {
    kind: "not_applicable",
    reason,
    eventType: input.identity.eventType,
    blueprintKey: input.blueprint.blueprintKey,
    workItemKind: input.blueprint.workItemKind,
    projectionAction: input.action,
    eventId: input.identity.eventId,
  };
}

function exact(
  identity: WorkEventIdentity,
  cycleIdentity: string,
): Extract<WorkCycleResolution, { kind: "exact_cycle" }> {
  return { kind: "exact_cycle", cycleIdentity, identity };
}

function requireAndBuild(
  input: {
    readonly identity: WorkEventIdentity;
    readonly blueprint: Pick<WorkRoutingBlueprint, "blueprintKey" | "workItemKind">;
    readonly action: WorkProjectionAction;
  },
  requiredFields: readonly string[],
  cycleIdentity: string,
): WorkCycleResolution {
  const missing = requiredFields.filter((field) => !filled(identityValue(input.identity, field)));
  if (missing.length > 0) return malformed(input, missing);
  if (!cycleIdentityIsExact(cycleIdentity)) return malformed(input, requiredFields);
  return exact(input.identity, cycleIdentity);
}

function failureCycle(identity: WorkEventIdentity): string {
  return buildWorkItemCycleIdentity({
    kind: "automation_failure",
    jobId: identity.jobId,
    projectionEventId: identity.projectionEventId,
    scheduledActionId: identity.scheduledActionId,
    failureSourceType: identity.failureSourceType,
    failureSourceId: identity.failureSourceId,
  });
}

export function resolveWorkCycleIdentity(input: {
  readonly blueprint: Pick<WorkRoutingBlueprint, "blueprintKey" | "workItemKind">;
  readonly action: WorkProjectionAction;
  readonly identity: WorkEventIdentity;
}): WorkCycleResolution {
  const { blueprint, action, identity } = input;
  const eventType = identity.eventType;
  switch (blueprint.workItemKind) {
    case "inspection_readiness":
      return requireAndBuild(
        input,
        ["inspectionId"],
        buildWorkItemCycleIdentity({
          kind: "inspection_readiness",
          inspectionId: identity.inspectionId,
        }),
      );
    case "inspection_submission":
      return requireAndBuild(
        input,
        action === "complete" && eventType === "inspection.submitted"
          ? ["inspectionId", "submissionId"]
          : ["inspectionId"],
        buildWorkItemCycleIdentity({
          kind: "inspection_submission",
          inspectionId: identity.inspectionId,
        }),
      );
    case "inspection_correction": {
      if (
        (eventType === "inspection.validated" || eventType === "inspection.submitted") &&
        action !== "create"
      ) {
        if (!identity.exceptionIdsPresent) return malformed(input, ["exceptionIds"]);
        if (identity.exceptionIds.length === 0) {
          return notApplicable(input, "Explicit empty exceptionIds; no correction cycle applies.");
        }
      }
      return requireAndBuild(
        input,
        ["inspectionId", "exceptionId"],
        buildWorkItemCycleIdentity({
          kind: "inspection_correction",
          inspectionId: identity.inspectionId,
          exceptionId: identity.exceptionId,
        }),
      );
    }
    case "report_technical_review":
      return requireAndBuild(
        input,
        ["reportId", "reportVersionId"],
        buildWorkItemCycleIdentity({
          kind: "report_technical_review",
          reportId: identity.reportId,
          reportVersionId: identity.reportVersionId,
        }),
      );
    case "report_revision": {
      if (
        action !== "create" &&
        (eventType === "report.draft_created" || eventType === "report.review_requested") &&
        !filled(identity.requestedRevisionVersionId)
      ) {
        return notApplicable(input, "Initial report version has no prior revision cycle to close.");
      }
      const revisionId =
        action === "create"
          ? (identity.reportVersionId ?? identity.requestedRevisionVersionId)
          : (identity.requestedRevisionVersionId ?? identity.reportVersionId);
      const required =
        action === "create"
          ? filled(identity.reportVersionId) || filled(identity.requestedRevisionVersionId)
            ? ["reportId"]
            : ["reportId", "reportVersionId"]
          : ["reportId", "requestedRevisionVersionId"];
      return requireAndBuild(
        input,
        action === "create" &&
          !filled(identity.reportVersionId) &&
          !filled(identity.requestedRevisionVersionId)
          ? ["reportId", "reportVersionId"]
          : required,
        buildWorkItemCycleIdentity({
          kind: "report_revision",
          reportId: identity.reportId,
          reportVersionId: revisionId,
          requestedRevisionVersionId:
            identity.requestedRevisionVersionId ?? identity.reportVersionId,
        }),
      );
    }
    case "report_delivery_authorization":
      return requireAndBuild(
        input,
        ["reportId", "reportVersionId"],
        buildWorkItemCycleIdentity({
          kind: "report_delivery_authorization",
          reportId: identity.reportId,
          reportVersionId: identity.reportVersionId,
          deliveryAuthorizationId: identity.deliveryAuthorizationId,
        }),
      );
    case "delivery_reconciliation":
      return requireAndBuild(
        input,
        ["reportId", "reportVersionId", "deliveryId"],
        buildWorkItemCycleIdentity({
          kind: "delivery_reconciliation",
          reportId: identity.reportId,
          deliveryId: identity.deliveryId,
        }),
      );
    case "automation_failure": {
      if (
        identity.failureSourceType === "schedule" ||
        eventType.startsWith("automation.schedule_") ||
        filled(identity.scheduledActionId)
      ) {
        return requireAndBuild(input, ["scheduleId"], failureCycle(identity));
      }
      if (
        identity.failureSourceType === "projection" ||
        eventType.startsWith("automation.projection_") ||
        filled(identity.projectionEventId)
      ) {
        return requireAndBuild(input, ["sourceEventId"], failureCycle(identity));
      }
      return requireAndBuild(input, ["jobId"], failureCycle(identity));
    }
    case "sla_escalation":
      return requireAndBuild(
        input,
        ["inspectionId"],
        buildWorkItemCycleIdentity({
          kind: "sla_escalation",
          inspectionId: identity.inspectionId,
        }),
      );
    case "proposal_preparation":
      return requireAndBuild(
        input,
        ["leadId"],
        buildWorkItemCycleIdentity({
          kind: "proposal_preparation",
          leadId: identity.leadId,
        }),
      );
    case "proposal_information":
      return requireAndBuild(
        input,
        ["proposalId", "informationCycleNumber"],
        buildWorkItemCycleIdentity({
          kind: "proposal_information",
          proposalId: identity.proposalId,
          informationCycleNumber: identity.informationCycleNumber,
        }),
      );
    case "proposal_review":
      return requireAndBuild(
        input,
        ["proposalId", "proposalVersionId"],
        buildWorkItemCycleIdentity({
          kind: "proposal_review",
          proposalId: identity.proposalId,
          proposalVersionId: identity.proposalVersionId,
        }),
      );
    case "proposal_revision": {
      if (action !== "create") {
        if (!filled(identity.requestedRevisionVersionId)) {
          return notApplicable(input, "No prior proposal version is being revised.");
        }
        return requireAndBuild(
          input,
          ["proposalId", "requestedRevisionVersionId"],
          buildWorkItemCycleIdentity({
            kind: "proposal_revision",
            proposalId: identity.proposalId,
            proposalVersionId: identity.requestedRevisionVersionId,
          }),
        );
      }
      return requireAndBuild(
        input,
        ["proposalId", "proposalVersionId"],
        buildWorkItemCycleIdentity({
          kind: "proposal_revision",
          proposalId: identity.proposalId,
          proposalVersionId: identity.proposalVersionId,
        }),
      );
    }
    case "proposal_pricing_override":
      return requireAndBuild(
        input,
        ["proposalId", "overrideId"],
        buildWorkItemCycleIdentity({
          kind: "proposal_pricing_override",
          proposalId: identity.proposalId,
          pricingOverrideId: identity.pricingOverrideId,
        }),
      );
    case "proposal_delivery_preparation":
      return requireAndBuild(
        input,
        ["proposalId", "proposalVersionId"],
        buildWorkItemCycleIdentity({
          kind: "proposal_delivery_preparation",
          proposalId: identity.proposalId,
          proposalVersionId: identity.proposalVersionId,
        }),
      );
    default: {
      const exhaustive: never = blueprint.workItemKind;
      return exhaustive;
    }
  }
}

export function resolveWorkCycleIdentities(input: {
  readonly blueprint: Pick<WorkRoutingBlueprint, "blueprintKey" | "workItemKind">;
  readonly action: WorkProjectionAction;
  readonly identity: WorkEventIdentity;
}): readonly WorkCycleResolution[] {
  const { blueprint, action, identity } = input;
  if (
    blueprint.workItemKind === "inspection_correction" &&
    action !== "create" &&
    (identity.eventType === "inspection.validated" || identity.eventType === "inspection.submitted")
  ) {
    if (!identity.exceptionIdsPresent) {
      return [resolveWorkCycleIdentity(input)];
    }
    if (identity.exceptionIds.length === 0) {
      return [resolveWorkCycleIdentity(input)];
    }
    return identity.exceptionIds.map((exceptionId) =>
      resolveWorkCycleIdentity({
        blueprint,
        action,
        identity: {
          ...identity,
          exceptionId,
          exceptionIds: [exceptionId],
        },
      }),
    );
  }
  return [resolveWorkCycleIdentity(input)];
}

export function isAutomationFailureWorkEvent(eventType: string): boolean {
  return (
    eventType === "automation.job_dead_letter" ||
    eventType === "automation.job_succeeded" ||
    eventType === "automation.job_cancelled" ||
    eventType === "automation.job_resolved" ||
    eventType === "automation.job_retry_requested" ||
    eventType === "automation.job_requeued" ||
    eventType.startsWith("automation.projection_") ||
    eventType.startsWith("automation.schedule_")
  );
}
