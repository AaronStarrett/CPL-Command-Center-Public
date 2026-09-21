import type {
  JsonObject,
  OperationsEventType,
  WorkEventIdentity,
  WorkFailureSourceType,
} from "@bea/domain";
import { payloadHasOwnKey } from "@bea/domain";

export interface DomainContext {
  inspectionId: string | null;
  projectId: string | null;
  reportId: string | null;
  reportVersionId: string | null;
  requestedRevisionVersionId: string | null;
  submissionId: string | null;
  exceptionId: string | null;
  exceptionIds: readonly string[];
  deliveryId: string | null;
  deliveryAuthorizationId: string | null;
  jobId: string | null;
  projectionEventId: string | null;
  scheduledActionId: string | null;
  failureSourceType: WorkFailureSourceType | null;
  failureSourceId: string | null;
  exceptionIdsPresent: boolean;
  inspectorUserId: string | null;
  reviewerUserId: string | null;
  exceptionOwnerUserId: string | null;
  preparerUserId: string | null;
  leadId: string | null;
  proposalId: string | null;
  proposalVersionId: string | null;
  catalogVersionId: string | null;
  pricingOverrideId: string | null;
  informationCycleNumber: number | null;
}

export const OPEN_WORK_STATUSES_SQL = `'open','acknowledged','in_progress','blocked'`;

export type ScheduleEvaluationOutcome =
  | "claimed_and_executed"
  | "already_processed"
  | "suppressed"
  | "unavailable"
  | "failed"
  | "duplicate_suppressed"
  | "retry_scheduled";

export interface ScheduleEvaluationCounts {
  readonly evaluated: number;
  readonly claimedAndExecuted: number;
  readonly alreadyProcessed: number;
  readonly suppressed: number;
  readonly unavailable: number;
  readonly failed: number;
  readonly duplicateSuppressed: number;
  readonly retryScheduled: number;
}

export function emptyScheduleEvaluationCounts(): ScheduleEvaluationCounts {
  return {
    evaluated: 0,
    claimedAndExecuted: 0,
    alreadyProcessed: 0,
    suppressed: 0,
    unavailable: 0,
    failed: 0,
    duplicateSuppressed: 0,
    retryScheduled: 0,
  };
}

export function tallyScheduleOutcome(
  counts: ScheduleEvaluationCounts,
  outcome: ScheduleEvaluationOutcome,
): ScheduleEvaluationCounts {
  const next = { ...counts };
  if (outcome === "claimed_and_executed") {
    next.claimedAndExecuted += 1;
    next.evaluated += 1;
  } else if (outcome === "already_processed") next.alreadyProcessed += 1;
  else if (outcome === "suppressed") next.suppressed += 1;
  else if (outcome === "unavailable") next.unavailable += 1;
  else if (outcome === "failed") next.failed += 1;
  else if (outcome === "duplicate_suppressed") next.duplicateSuppressed += 1;
  else next.retryScheduled += 1;
  return next;
}

export function payloadString(payload: JsonObject, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value : null;
}

export function payloadNumber(payload: JsonObject, key: string): number | null {
  if (!payloadHasOwnKey(payload, key)) return null;
  const value = payload[key];
  if (typeof value === "number" && Number.isInteger(value) && Number.isSafeInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/u.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

export function payloadStringArray(payload: JsonObject, key: string): readonly string[] {
  const value = payload[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

export function completeDomainContext(partial: Partial<DomainContext> = {}): DomainContext {
  const exceptionId = partial.exceptionId ?? null;
  const exceptionIds = partial.exceptionIds ?? (exceptionId ? [exceptionId] : []);
  return {
    inspectionId: partial.inspectionId ?? null,
    projectId: partial.projectId ?? null,
    reportId: partial.reportId ?? null,
    reportVersionId: partial.reportVersionId ?? null,
    requestedRevisionVersionId: partial.requestedRevisionVersionId ?? null,
    submissionId: partial.submissionId ?? null,
    exceptionId,
    exceptionIds,
    exceptionIdsPresent: partial.exceptionIdsPresent ?? partial.exceptionIds !== undefined,
    deliveryId: partial.deliveryId ?? null,
    deliveryAuthorizationId: partial.deliveryAuthorizationId ?? null,
    jobId: partial.jobId ?? null,
    projectionEventId: partial.projectionEventId ?? null,
    scheduledActionId: partial.scheduledActionId ?? null,
    failureSourceType: partial.failureSourceType ?? null,
    failureSourceId: partial.failureSourceId ?? null,
    inspectorUserId: partial.inspectorUserId ?? null,
    reviewerUserId: partial.reviewerUserId ?? null,
    exceptionOwnerUserId: partial.exceptionOwnerUserId ?? null,
    preparerUserId: partial.preparerUserId ?? null,
    leadId: partial.leadId ?? null,
    proposalId: partial.proposalId ?? null,
    proposalVersionId: partial.proposalVersionId ?? null,
    catalogVersionId: partial.catalogVersionId ?? null,
    pricingOverrideId: partial.pricingOverrideId ?? null,
    informationCycleNumber: partial.informationCycleNumber ?? null,
  };
}

export function extractPayloadContext(
  event: {
    readonly aggregate_type: unknown;
    readonly aggregate_id: unknown;
    readonly id: unknown;
    readonly event_type: unknown;
  },
  payload: JsonObject,
): DomainContext {
  const aggregateType = String(event.aggregate_type);
  const aggregateId = String(event.aggregate_id);
  const eventType = String(event.event_type);
  const exceptionId =
    payloadString(payload, "exceptionId") ?? (aggregateType === "exception" ? aggregateId : null);
  const explicitExceptionIds = payloadHasOwnKey(payload, "exceptionIds")
    ? payloadStringArray(payload, "exceptionIds")
    : [];
  const exceptionIdsPresent = payloadHasOwnKey(payload, "exceptionIds");
  const exceptionIds = [...explicitExceptionIds, ...(exceptionId ? [exceptionId] : [])].filter(
    (id, index, all) => all.indexOf(id) === index,
  );
  const reportVersionId =
    payloadString(payload, "reportVersionId") ?? payloadString(payload, "versionId");
  const requestedRevisionVersionId =
    payloadString(payload, "requestedRevisionVersionId") ??
    payloadString(payload, "previousVersionId");
  const isScheduleEvent =
    aggregateType === "schedule" || eventType.startsWith("automation.schedule_");
  const isProjectionEvent = eventType.startsWith("automation.projection_");
  const scheduledActionId =
    payloadString(payload, "scheduleId") ??
    payloadString(payload, "scheduledActionId") ??
    (isScheduleEvent ? aggregateId : null);
  const projectionEventId =
    payloadString(payload, "sourceEventId") ??
    payloadString(payload, "projectionEventId") ??
    (isProjectionEvent ? aggregateId : null);
  const jobId = isScheduleEvent
    ? null
    : (payloadString(payload, "jobId") ?? (aggregateType === "job" ? aggregateId : null));
  const payloadFailureSource = payloadString(payload, "failureSourceType");
  const payloadFailureSourceId = payloadString(payload, "failureSourceId");
  let failureSourceType: WorkFailureSourceType | null = null;
  let failureSourceId: string | null = null;
  if (isScheduleEvent || payloadFailureSource === "schedule") {
    failureSourceType = "schedule";
    failureSourceId = payloadFailureSourceId ?? scheduledActionId;
  } else if (isProjectionEvent || payloadFailureSource === "projection") {
    failureSourceType = "projection";
    failureSourceId = payloadFailureSourceId ?? projectionEventId;
  } else if (eventType.startsWith("automation.job_") || payloadFailureSource === "job") {
    failureSourceType = "job";
    failureSourceId = payloadFailureSourceId ?? jobId;
  }
  const context: DomainContext = {
    inspectionId: payloadString(payload, "inspectionId"),
    projectId: payloadString(payload, "projectId"),
    reportId: payloadString(payload, "reportId"),
    reportVersionId,
    requestedRevisionVersionId,
    submissionId: payloadString(payload, "submissionId"),
    exceptionId,
    exceptionIds,
    exceptionIdsPresent,
    deliveryId: payloadString(payload, "deliveryId"),
    deliveryAuthorizationId:
      payloadString(payload, "deliveryAuthorizationId") ??
      payloadString(payload, "authorizationId"),
    jobId,
    projectionEventId,
    scheduledActionId,
    failureSourceType,
    failureSourceId,
    inspectorUserId: payloadString(payload, "inspectorUserId"),
    reviewerUserId: payloadString(payload, "reviewerUserId"),
    exceptionOwnerUserId: payloadString(payload, "ownerUserId"),
    preparerUserId: payloadString(payload, "preparerUserId"),
    leadId: payloadString(payload, "leadId"),
    proposalId: payloadString(payload, "proposalId"),
    proposalVersionId: payloadString(payload, "proposalVersionId"),
    catalogVersionId: payloadString(payload, "catalogVersionId"),
    pricingOverrideId:
      payloadString(payload, "pricingOverrideId") ?? payloadString(payload, "overrideId"),
    informationCycleNumber: payloadNumber(payload, "informationCycleNumber"),
  };
  if (aggregateType === "inspection") context.inspectionId = aggregateId;
  if (aggregateType === "report") context.reportId = aggregateId;
  if (aggregateType === "exception") context.exceptionId = aggregateId;
  if (aggregateType === "job" && !isScheduleEvent) context.jobId = aggregateId;
  if (isScheduleEvent) context.scheduledActionId = scheduledActionId ?? aggregateId;
  if (aggregateType === "lead") context.leadId = aggregateId;
  if (aggregateType === "proposal") context.proposalId = aggregateId;
  return context;
}

export function workEventIdentityFrom(
  eventType: string,
  eventId: string,
  context: DomainContext,
): WorkEventIdentity {
  return {
    eventType,
    eventId,
    inspectionId: context.inspectionId,
    reportId: context.reportId,
    reportVersionId: context.reportVersionId,
    requestedRevisionVersionId: context.requestedRevisionVersionId,
    submissionId: context.submissionId,
    exceptionId: context.exceptionId,
    exceptionIds: context.exceptionIds,
    exceptionIdsPresent: context.exceptionIdsPresent,
    deliveryId: context.deliveryId,
    deliveryAuthorizationId: context.deliveryAuthorizationId,
    jobId: context.jobId,
    projectionEventId: context.projectionEventId,
    scheduledActionId: context.scheduledActionId,
    failureSourceType: context.failureSourceType,
    failureSourceId: context.failureSourceId,
    leadId: context.leadId,
    proposalId: context.proposalId,
    proposalVersionId: context.proposalVersionId,
    catalogVersionId: context.catalogVersionId,
    pricingOverrideId: context.pricingOverrideId,
    informationCycleNumber: context.informationCycleNumber,
  };
}

export function isTerminalAggregateCancellation(eventType: OperationsEventType | string): boolean {
  return eventType === "inspection.cancelled";
}

export function isVersionSupersessionEvent(eventType: OperationsEventType | string): boolean {
  return eventType === "report.draft_created";
}
