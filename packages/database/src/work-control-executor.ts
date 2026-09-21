import { randomUUID } from "node:crypto";
import type {
  JsonObject,
  OperationalWorkItem,
  OperationsEventType,
  ReconciliationDecision,
  WorkItemKind,
  WorkItemStatus,
  WorkPolicyPreview,
  WorkRoutingBlueprint,
} from "@bea/domain";
import {
  assertWorkItemTransition,
  average,
  buildExternalTriggerProvisioningPlan,
  buildWorkItemCycleIdentity,
  buildWorkProjectionIdempotencyKey,
  CRITICAL_WORK_ITEM_KINDS,
  decideReconciliation,
  decideWorkAssignment,
  DEMO_PERSONAS,
  DEMO_ROLE_IDS,
  EMAIL_DRY_RUN_DISCLOSURE,
  ESCALATION_CATCH_UP_MODE,
  escalationDueAt,
  isKnownWorkRoleKey,
  isOpenWorkItemStatus,
  isTerminalWorkItemStatus,
  nextEscalationLevel,
  notificationShouldBeSuppressed,
  percentile,
  PRODUCTION_ORCHESTRATION_POLICY_PAYLOAD,
  PROJECTION_MAX_ATTEMPTS,
  projectionRetryDelayMs,
  reminderDueAt,
  safeWorkNotificationBody,
  sanitizeProjectionError,
  SCHEDULE_MAX_ATTEMPTS,
  scheduleRetryDelayMs,
  schedulerCatchUpDue,
  SEEDED_WORK_CONTROL_IDS,
  selectReminderAnchor,
  shouldSuppressTimedAction,
  skippedEscalationLevels,
  SYNTHETIC_ESCALATION_RULES,
  SYNTHETIC_ORCHESTRATION_POLICY_PAYLOAD,
  SYNTHETIC_REMINDER_RULES,
  SYNTHETIC_WORK_ROUTING_BLUEPRINTS,
  TEAMS_DRY_RUN_DISCLOSURE,
  userMayClaimWorkItem,
  WORK_CONTROL_CODE_DEFINED_POLICY,
  WORK_CONTROL_PRODUCTION_UNCONFIGURED,
  WORK_CONTROL_SYNTHETIC_DISCLOSURE,
  WORK_ITEM_KIND_LABELS,
  WORK_ITEM_REFERENCE_PREFIX,
  WorkItemClaimError,
  WorkItemManualCompletionError,
  WorkItemTransitionError,
  WorkProjectionError,
  WorkProjectionNotFoundError,
  WorkProjectionRetryConflictError,
  WorkReassignmentError,
  createCycleIdentityIncompleteError,
  isAutomationFailureWorkEvent,
  resolveWorkCycleIdentities,
  workItemIsAtRisk,
  workItemIsOverdue,
} from "@bea/domain";
import type { DatabaseAdapter, SqlExecutor } from "./adapter.js";
import { iso, jsonValue, mapInspection, nullableString } from "./operations-repository.js";
import {
  insertAutomationEvent,
  nextOperationsReference,
  recordAuditAndActivity,
} from "./operations-repository.js";
import {
  completeDomainContext,
  emptyScheduleEvaluationCounts,
  extractPayloadContext,
  isTerminalAggregateCancellation,
  isVersionSupersessionEvent,
  OPEN_WORK_STATUSES_SQL,
  payloadString,
  tallyScheduleOutcome,
  workEventIdentityFrom,
  type DomainContext,
  type ScheduleEvaluationCounts,
  type ScheduleEvaluationOutcome,
} from "./work-control-projection.js";
import {
  mapOperationalWorkItem,
  mapScheduledAction,
  SqlWorkControlRepository,
} from "./work-control-repository.js";

type Row = Record<string, unknown>;

function queryRows<T extends Row>(
  result: { readonly rows?: readonly T[] } | null | undefined,
): readonly T[] {
  return result?.rows ?? [];
}

type AssociationTable =
  | "projects"
  | "inspections"
  | "inspection_submissions"
  | "inspection_reports"
  | "report_versions"
  | "exception_cases"
  | "delivery_authorizations"
  | "report_deliveries"
  | "automation_jobs"
  | "scheduled_automation_actions"
  | "automation_events"
  | "leads"
  | "proposals"
  | "proposal_versions"
  | "service_catalog_versions"
  | "proposal_pricing_overrides";

async function existingId(
  executor: SqlExecutor,
  table: AssociationTable,
  id: string | null | undefined,
): Promise<string | null> {
  if (!id) return null;
  const result = await executor.query<Row>(`SELECT 1 FROM ${table} WHERE id=$1 LIMIT 1`, [id]);
  return result.rows[0] ? id : null;
}

function emptyProjectionBatchResult(): {
  processed: number;
  ignored: number;
  failed: number;
  deadLettered: number;
  failureRecordingErrors: number;
  skippedNotDue: number;
} {
  return {
    processed: 0,
    ignored: 0,
    failed: 0,
    deadLettered: 0,
    failureRecordingErrors: 0,
    skippedNotDue: 0,
  };
}

const RELEVANT_EVENT_TYPES = new Set<string>([
  ...SYNTHETIC_WORK_ROUTING_BLUEPRINTS.flatMap((item) => [
    ...item.triggerEventTypes,
    ...item.completionEventTypes,
    ...item.cancellationEventTypes,
  ]),
  "work.reconciled",
]);

export interface WorkControlDependencies {
  readonly database: DatabaseAdapter;
  readonly now?: () => Date;
  readonly beforeProjectFailureWork?: (input: {
    readonly sourceEventId: string;
    readonly notificationEventId: string;
  }) => Promise<void> | void;
  readonly beforeScheduleEffect?: (input: { readonly scheduleId: string }) => Promise<void> | void;
  readonly onIsolatedProjectionError?: (input: {
    readonly eventId: string;
    readonly eventType: string;
    readonly code: string;
  }) => void;
}

export interface ProjectionBatchResult {
  readonly processed: number;
  readonly ignored: number;
  readonly failed: number;
  readonly deadLettered: number;
  readonly failureRecordingErrors: number;
  readonly skippedNotDue: number;
}

export interface WorkActor {
  readonly userId: string;
  readonly roleKeys: readonly string[];
  readonly correlationId: string;
  readonly expectedVersion?: number;
}

export interface WorkMetricsSnapshot {
  readonly synthetic: true;
  readonly disclosure: typeof WORK_CONTROL_SYNTHETIC_DISCLOSURE;
  readonly open: number;
  readonly dueSoon: number;
  readonly overdue: number;
  readonly blocked: number;
  readonly escalated: number;
  readonly unassigned: number;
  readonly averageAgeMs: number | null;
  readonly p50AgeMs: number | null;
  readonly p90AgeMs: number | null;
  readonly timeToAcknowledgeMs: number | null;
  readonly timeToBeginMs: number | null;
  readonly timeToCompleteMs: number | null;
  readonly openCountByKind: Readonly<Record<string, number>>;
  readonly humanWaitingMsByKind: Readonly<Record<string, number>>;
  readonly openByRoleCount: Readonly<Record<string, number>>;
  readonly openByAssigneeCount: Readonly<Record<string, number>>;
  readonly reportDelayCountByBucket: Readonly<Record<string, number>>;
  readonly reportDelayMsByBucket: Readonly<Record<string, number>>;
}

export interface ReconciliationRunResult {
  readonly id: string;
  readonly mode: "dry_run" | "execute";
  readonly createdMissing: number;
  readonly plannedCreatedMissing: number;
  readonly actualCreatedMissing: number;
  readonly duplicateSuppressed: number;
  readonly completedStale: number;
  readonly cancelledSuperseded: number;
  readonly unchanged: number;
  readonly details: readonly ReconciliationDecision[];
}

function blueprintForKind(kind: WorkItemKind): WorkRoutingBlueprint {
  const blueprint = SYNTHETIC_WORK_ROUTING_BLUEPRINTS.find((item) => item.workItemKind === kind);
  if (!blueprint) {
    throw new Error(`Synthetic work-routing blueprint is missing for ${kind}.`);
  }
  return blueprint;
}

function deepLinkFor(blueprint: WorkRoutingBlueprint, context: DomainContext): string {
  return blueprint.deepLinkTemplate
    .replace("{inspectionId}", context.inspectionId ?? "")
    .replace("{reportId}", context.reportId ?? "")
    .replace("{leadId}", context.leadId ?? "")
    .replace("{proposalId}", context.proposalId ?? "");
}

function hasOwnerPrivilege(roleKeys: readonly string[]): boolean {
  return roleKeys.includes(DEMO_ROLE_IDS.OWNER_ADMIN);
}

function emptyDelayBuckets(): Record<string, number> {
  return {
    awaiting_submission: 0,
    correction: 0,
    technical_review: 0,
    delivery_authorization: 0,
    delivery_failure: 0,
    system_processing: 0,
  };
}

export class WorkControlPlane {
  readonly repository: SqlWorkControlRepository;
  private readonly now: () => Date;

  constructor(private readonly dependencies: WorkControlDependencies) {
    this.repository = new SqlWorkControlRepository(dependencies.database);
    this.now = dependencies.now ?? (() => new Date());
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  async processPendingEvents(limit = 80): Promise<ProjectionBatchResult> {
    const now = this.stamp();
    const counts = emptyProjectionBatchResult();
    const skippedNotDue = queryRows(
      await this.dependencies.database.query<Row>(
        `SELECT COUNT(*)::text AS n FROM automation_events
          WHERE processing_status='failed'
            AND COALESCE(projection_retryable, TRUE)
            AND projection_next_retry_at IS NOT NULL
            AND projection_next_retry_at>$1::timestamptz`,
        [now],
      ),
    );
    counts.skippedNotDue = Number(skippedNotDue[0]?.n ?? 0);
    const pendingRows = queryRows(
      await this.dependencies.database.query<Row>(
        `SELECT * FROM automation_events
          WHERE processing_status='pending'
             OR (
               processing_status='failed'
               AND COALESCE(projection_retryable, TRUE)
               AND (projection_next_retry_at IS NULL OR projection_next_retry_at<=$2::timestamptz)
             )
          ORDER BY occurred_at, recorded_at
          LIMIT $1`,
        [limit, now],
      ),
    );
    for (const row of pendingRows) {
      try {
        const outcome = await this.processEventRow(row);
        if (outcome === "ignored") counts.ignored += 1;
        else if (outcome === "processed") counts.processed += 1;
      } catch (error) {
        try {
          const failureOutcome = await this.recordProjectionFailure(row, error);
          if (failureOutcome === "dead_lettered") counts.deadLettered += 1;
          else if (failureOutcome === "failure_recording_error") counts.failureRecordingErrors += 1;
          else counts.failed += 1;
        } catch (recordingError) {
          counts.failureRecordingErrors += 1;
          this.dependencies.onIsolatedProjectionError?.({
            eventId: String(row.id),
            eventType: String(row.event_type),
            code: "FAILURE_RECORDING_ERROR",
          });
          void recordingError;
        }
      }
    }
    return counts;
  }

  async processEventById(eventId: string): Promise<void> {
    const result = await this.dependencies.database.query<Row>(
      "SELECT * FROM automation_events WHERE id=$1",
      [eventId],
    );
    if (!result.rows[0]) return;
    try {
      await this.processEventRow(result.rows[0]);
    } catch (error) {
      try {
        await this.recordProjectionFailure(result.rows[0], error);
      } catch (recordingError) {
        this.dependencies.onIsolatedProjectionError?.({
          eventId,
          eventType: String(result.rows[0].event_type),
          code: "FAILURE_RECORDING_ERROR",
        });
        void recordingError;
      }
      throw error;
    }
  }

  async retryProjectionEvent(eventId: string, actor: WorkActor): Promise<void> {
    const now = this.stamp();
    await this.dependencies.database.transaction(async (transaction) => {
      const locked = await transaction.query<Row>(
        "SELECT * FROM automation_events WHERE id=$1 FOR UPDATE",
        [eventId],
      );
      const event = locked.rows[0];
      if (!event) throw new WorkProjectionNotFoundError();
      const status = String(event.processing_status);
      if (status !== "failed" && status !== "dead_lettered") {
        throw new WorkProjectionRetryConflictError();
      }
      await transaction.query(
        `UPDATE automation_events
            SET processing_status='failed',
                projection_retryable=TRUE,
                projection_next_retry_at=$2,
                projection_dead_lettered_at=NULL
          WHERE id=$1`,
        [eventId, now],
      );
      await insertAutomationEvent(transaction, {
        eventType: "automation.projection_retry_requested",
        aggregateType: String(event.aggregate_type),
        aggregateId: String(event.aggregate_id),
        correlationId: actor.correlationId,
        actorType: "user",
        actorId: actor.userId,
        payload: {
          sourceEventId: eventId,
          jobId: payloadString(jsonValue(event.payload, {}), "jobId"),
        },
        occurredAt: now,
      });
    });
  }

  private async processEventRow(row: Row): Promise<"processed" | "ignored" | "skipped"> {
    const eventId = String(row.id);
    const eventType = String(row.event_type) as OperationsEventType;
    return this.dependencies.database.transaction(async (transaction) => {
      const locked = await transaction.query<Row>(
        "SELECT * FROM automation_events WHERE id=$1 FOR UPDATE",
        [eventId],
      );
      const event = locked.rows[0];
      if (!event) return "skipped";
      const status = String(event.processing_status);
      if (status !== "pending" && status !== "failed") return "skipped";
      if (!RELEVANT_EVENT_TYPES.has(eventType)) {
        await transaction.query(
          "UPDATE automation_events SET processing_status='ignored' WHERE id=$1",
          [eventId],
        );
        return "ignored";
      }
      const context = await this.loadContext(transaction, event);
      const payload = jsonValue<JsonObject>(event.payload, {});
      if (isTerminalAggregateCancellation(eventType) && context.inspectionId) {
        await this.cancelOpenWorkForInspection(transaction, event, context.inspectionId);
      }
      if (isVersionSupersessionEvent(eventType) && context.requestedRevisionVersionId) {
        await this.cancelOpenWorkForSupersededVersion(
          transaction,
          event,
          context.requestedRevisionVersionId,
        );
      }
      for (const blueprint of SYNTHETIC_WORK_ROUTING_BLUEPRINTS) {
        if (blueprint.triggerEventTypes.includes(eventType)) {
          await this.createFromBlueprint(transaction, blueprint, event, context, payload, "create");
        }
        if (blueprint.completionEventTypes.includes(eventType)) {
          await this.closeFromBlueprint(transaction, blueprint, event, context, "complete");
        }
        if (
          blueprint.cancellationEventTypes.includes(eventType) &&
          !isTerminalAggregateCancellation(eventType)
        ) {
          await this.closeFromBlueprint(transaction, blueprint, event, context, "cancel");
        }
      }
      await this.closeProjectionFailureWork(transaction, eventId, event);
      await transaction.query(
        `UPDATE automation_events
            SET processing_status='processed',
                projection_next_retry_at=NULL,
                projection_retryable=NULL
          WHERE id=$1`,
        [eventId],
      );
      return "processed";
    });
  }

  private async loadContext(executor: SqlExecutor, event: Row): Promise<DomainContext> {
    const payload = jsonValue<JsonObject>(event.payload, {});
    const context = extractPayloadContext(
      {
        aggregate_type: event.aggregate_type,
        aggregate_id: event.aggregate_id,
        id: event.id,
        event_type: event.event_type,
      },
      payload,
    );
    const aggregateType = String(event.aggregate_type);
    const aggregateId = String(event.aggregate_id);
    const eventType = String(event.event_type);
    const skipRequiredAggregate = isAutomationFailureWorkEvent(eventType);
    if (aggregateType === "inspection") {
      const inspection = await executor.query<Row>("SELECT * FROM inspections WHERE id=$1", [
        aggregateId,
      ]);
      if (inspection.rows[0]) {
        context.projectId = String(inspection.rows[0].project_id);
        context.inspectorUserId =
          nullableString(inspection.rows[0].inspector_user_id) ?? context.inspectorUserId;
        context.reviewerUserId =
          nullableString(inspection.rows[0].reviewer_user_id) ?? context.reviewerUserId;
      } else if (!skipRequiredAggregate) {
        throw new WorkProjectionError(
          "INSPECTION_UNAVAILABLE",
          "Inspection aggregate is not available for projection.",
          true,
        );
      }
    }
    if (aggregateType === "report") {
      const report = await executor.query<Row>("SELECT * FROM inspection_reports WHERE id=$1", [
        aggregateId,
      ]);
      if (report.rows[0]) {
        context.inspectionId = String(report.rows[0].inspection_id);
        context.projectId = String(report.rows[0].project_id);
      } else if (!skipRequiredAggregate) {
        throw new WorkProjectionError(
          "REPORT_UNAVAILABLE",
          "Report aggregate is not available for projection.",
          true,
        );
      }
    }
    if (aggregateType === "exception") {
      const exception = await executor.query<Row>("SELECT * FROM exception_cases WHERE id=$1", [
        aggregateId,
      ]);
      if (exception.rows[0]) {
        context.inspectionId =
          nullableString(exception.rows[0].inspection_id) ?? context.inspectionId;
        context.reportId = nullableString(exception.rows[0].report_id) ?? context.reportId;
        context.projectId = nullableString(exception.rows[0].project_id) ?? context.projectId;
        context.exceptionOwnerUserId =
          nullableString(exception.rows[0].owner_user_id) ?? context.exceptionOwnerUserId;
      }
    }
    if (context.inspectionId && !context.projectId) {
      const inspection = await executor.query<Row>(
        "SELECT project_id, inspector_user_id, reviewer_user_id FROM inspections WHERE id=$1",
        [context.inspectionId],
      );
      context.projectId = nullableString(inspection.rows[0]?.project_id);
      context.inspectorUserId =
        nullableString(inspection.rows[0]?.inspector_user_id) ?? context.inspectorUserId;
      context.reviewerUserId =
        nullableString(inspection.rows[0]?.reviewer_user_id) ?? context.reviewerUserId;
    }
    if (context.exceptionId && !context.exceptionOwnerUserId) {
      const exception = await executor.query<Row>(
        "SELECT owner_user_id FROM exception_cases WHERE id=$1",
        [context.exceptionId],
      );
      context.exceptionOwnerUserId = nullableString(exception.rows[0]?.owner_user_id);
    }
    if (aggregateType === "lead") {
      const lead = await executor.query<Row>("SELECT id, reviewer_user_id FROM leads WHERE id=$1", [
        aggregateId,
      ]);
      if (lead.rows[0]) {
        context.leadId = String(lead.rows[0].id);
        context.preparerUserId =
          nullableString(lead.rows[0].reviewer_user_id) ?? context.preparerUserId;
      } else if (!skipRequiredAggregate) {
        throw new WorkProjectionError(
          "LEAD_UNAVAILABLE",
          "Lead aggregate is not available for projection.",
          true,
        );
      }
    }
    if (aggregateType === "proposal" || context.proposalId) {
      const proposalId = context.proposalId ?? (aggregateType === "proposal" ? aggregateId : null);
      if (proposalId) {
        const proposal = await executor.query<Row>(
          `SELECT id, lead_id, assigned_preparer_user_id, assigned_reviewer_user_id, catalog_version_id
             FROM proposals WHERE id=$1`,
          [proposalId],
        );
        if (proposal.rows[0]) {
          context.proposalId = String(proposal.rows[0].id);
          context.leadId = nullableString(proposal.rows[0].lead_id) ?? context.leadId;
          context.preparerUserId =
            nullableString(proposal.rows[0].assigned_preparer_user_id) ?? context.preparerUserId;
          context.reviewerUserId =
            nullableString(proposal.rows[0].assigned_reviewer_user_id) ?? context.reviewerUserId;
          context.catalogVersionId =
            nullableString(proposal.rows[0].catalog_version_id) ?? context.catalogVersionId;
        } else if (aggregateType === "proposal" && !skipRequiredAggregate) {
          throw new WorkProjectionError(
            "PROPOSAL_UNAVAILABLE",
            "Proposal aggregate is not available for projection.",
            true,
          );
        }
      }
    }
    return context;
  }

  private async insertReceipt(
    executor: SqlExecutor,
    input: {
      readonly sourceEventId: string;
      readonly blueprint: WorkRoutingBlueprint;
      readonly cycleIdentity: string;
      readonly actionType: string;
      readonly workItemId: string | null;
      readonly correlationId: string;
      readonly causationId: string | null;
      readonly result: string;
    },
  ): Promise<boolean> {
    const idempotencyKey = buildWorkProjectionIdempotencyKey({
      sourceEventId: input.sourceEventId,
      blueprintKey: input.blueprint.blueprintKey,
      blueprintVersion: input.blueprint.blueprintVersion,
      cycleIdentity: input.cycleIdentity,
      actionType: input.actionType,
    });
    const inserted = await executor.query<Row>(
      `INSERT INTO event_projection_receipts
       (id,source_event_id,blueprint_key,blueprint_version,cycle_identity,action_type,work_item_id,idempotency_key,correlation_id,causation_id,result)
       VALUES ($1,$2,$3,$4,$5,$6,$7::uuid,$8,$9,$10,$11)
       ON CONFLICT (source_event_id, blueprint_key, blueprint_version, cycle_identity, action_type)
       DO NOTHING
       RETURNING id`,
      [
        randomUUID(),
        input.sourceEventId,
        input.blueprint.blueprintKey,
        input.blueprint.blueprintVersion,
        input.cycleIdentity,
        input.actionType,
        input.workItemId,
        idempotencyKey,
        input.correlationId,
        input.causationId,
        input.result,
      ],
    );
    return Boolean(inserted.rows[0]);
  }

  private async createFromBlueprint(
    executor: SqlExecutor,
    blueprint: WorkRoutingBlueprint,
    event: Row,
    context: DomainContext,
    payload: JsonObject,
    actionType: string,
  ): Promise<{
    readonly item: OperationalWorkItem | null;
    readonly inserted: boolean;
    readonly duplicateSuppressed: boolean;
  }> {
    const eventType = String(event.event_type);
    const identity = workEventIdentityFrom(eventType, String(event.id), context);
    const resolution = resolveWorkCycleIdentities({
      blueprint,
      action: "create",
      identity,
    })[0];
    if (!resolution) {
      return { item: null, inserted: false, duplicateSuppressed: false };
    }
    if (resolution.kind === "malformed_missing_identity") {
      throw createCycleIdentityIncompleteError(resolution);
    }
    if (resolution.kind === "not_applicable") {
      await this.insertReceipt(executor, {
        sourceEventId: String(event.id),
        blueprint,
        cycleIdentity: `not_applicable:${blueprint.blueprintKey}`,
        actionType,
        workItemId: null,
        correlationId: String(event.correlation_id),
        causationId: nullableString(event.causation_id),
        result: "not_applicable",
      });
      return { item: null, inserted: false, duplicateSuppressed: false };
    }
    const cycleIdentity = resolution.cycleIdentity;
    const sourceEventId = String(event.id);
    const correlationId = String(event.correlation_id);
    const existingOpen = await executor.query<Row>(
      `SELECT * FROM operational_work_items
        WHERE work_item_kind=$1 AND cycle_identity=$2
          AND status IN (${OPEN_WORK_STATUSES_SQL})
        ORDER BY created_at DESC LIMIT 1`,
      [blueprint.workItemKind, cycleIdentity],
    );
    const existingAny =
      existingOpen.rows[0] ??
      (
        await executor.query<Row>(
          `SELECT * FROM operational_work_items
            WHERE work_item_kind=$1 AND cycle_identity=$2
            ORDER BY created_at DESC LIMIT 1`,
          [blueprint.workItemKind, cycleIdentity],
        )
      ).rows[0];
    if (existingOpen.rows[0] || (existingAny && blueprint.workItemKind !== "automation_failure")) {
      const duplicate = existingOpen.rows[0] ?? existingAny;
      if (!duplicate) {
        return { item: null, inserted: false, duplicateSuppressed: false };
      }
      await this.insertReceipt(executor, {
        sourceEventId,
        blueprint,
        cycleIdentity,
        actionType,
        workItemId: String(duplicate.id),
        correlationId,
        causationId: nullableString(event.causation_id),
        result: "duplicate_suppressed",
      });
      return {
        item: mapOperationalWorkItem(duplicate),
        inserted: false,
        duplicateSuppressed: true,
      };
    }
    const assignedUserId =
      blueprint.workItemKind === "report_technical_review" ||
      blueprint.workItemKind === "proposal_review" ||
      blueprint.workItemKind === "proposal_pricing_override"
        ? context.reviewerUserId
        : blueprint.workItemKind === "inspection_correction"
          ? (context.exceptionOwnerUserId ?? context.inspectorUserId)
          : blueprint.workItemKind.startsWith("proposal_")
            ? context.preparerUserId
            : context.inspectorUserId;
    const assignment = decideWorkAssignment({
      blueprint,
      domainAssigneeUserId: assignedUserId,
    });
    const now = iso(event.occurred_at);
    const dueAt = new Date(Date.parse(now) + blueprint.dueOffsetMs).toISOString();
    const reference = await nextOperationsReference(
      executor,
      "bea_work_item_reference_seq",
      WORK_ITEM_REFERENCE_PREFIX,
    );
    const id = randomUUID();
    const reason = `${blueprint.title} because ${String(event.event_type)} occurred. ${WORK_CONTROL_SYNTHETIC_DISCLOSURE}`;
    const idempotencyKey = buildWorkProjectionIdempotencyKey({
      sourceEventId,
      blueprintKey: blueprint.blueprintKey,
      blueprintVersion: blueprint.blueprintVersion,
      cycleIdentity,
      actionType,
    });
    const associations = await this.resolveWorkItemAssociations(executor, context, event);
    if (blueprint.workItemKind === "automation_failure") {
      await this.dependencies.beforeProjectFailureWork?.({
        sourceEventId: context.projectionEventId ?? sourceEventId,
        notificationEventId: sourceEventId,
      });
    }
    const inserted = await executor.query<Row>(
      `INSERT INTO operational_work_items
       (id,reference,work_item_kind,status,priority,queue_key,assigned_role_key,assigned_user_id,
        project_id,inspection_id,submission_id,report_id,report_version_id,exception_id,
        delivery_authorization_id,job_id,delivery_id,requested_revision_version_id,scheduled_action_id,
        failure_source_type,failure_source_id,
        source_event_id,source_aggregate_type,source_aggregate_id,policy_key,policy_version,
        idempotency_key,cycle_identity,title,reason,required_action,deep_link,available_at,due_at,
        synthetic,correlation_id,causation_id,created_at,updated_at,version,
        lead_id,proposal_id,proposal_version_id,catalog_version_id,pricing_override_id)
       VALUES
       ($1,$2,$3,'open',$4,$5,$6,$7::uuid,$8::uuid,$9::uuid,$10::uuid,$11::uuid,$12::uuid,$13::uuid,$14::uuid,$15::uuid,$16::uuid,$17::uuid,$18::uuid,$19,$20::uuid,$21::uuid,$22,$23,$24,1,$25,$26,$27,$28,$29,$30,$31::timestamptz,$32::timestamptz,TRUE,$33,$34,$31::timestamptz,$31::timestamptz,1,$35::uuid,$36::uuid,$37::uuid,$38::uuid,$39::uuid)
       ON CONFLICT (work_item_kind, cycle_identity) WHERE status IN (${OPEN_WORK_STATUSES_SQL})
       DO NOTHING
       RETURNING *`,
      [
        id,
        reference,
        blueprint.workItemKind,
        blueprint.priority,
        assignment.queueKey,
        assignment.assignedRoleKey,
        assignment.assignedUserId,
        associations.projectId,
        associations.inspectionId,
        associations.submissionId,
        associations.reportId,
        associations.reportVersionId,
        associations.exceptionId,
        associations.deliveryAuthorizationId,
        associations.jobId,
        associations.deliveryId,
        associations.requestedRevisionVersionId,
        associations.scheduledActionId,
        associations.failureSourceType,
        associations.failureSourceId,
        associations.sourceEventId,
        payloadString(jsonValue(event.payload, {}), "originalAggregateType") ??
          String(event.aggregate_type),
        payloadString(jsonValue(event.payload, {}), "originalAggregateId") ??
          String(event.aggregate_id),
        SYNTHETIC_ORCHESTRATION_POLICY_PAYLOAD.policyKey,
        idempotencyKey,
        cycleIdentity,
        blueprint.title,
        reason,
        blueprint.requiredAction,
        deepLinkFor(blueprint, context),
        now,
        dueAt,
        correlationId,
        sourceEventId,
        associations.leadId,
        associations.proposalId,
        associations.proposalVersionId,
        associations.catalogVersionId,
        associations.pricingOverrideId,
      ],
    );
    if (!inserted.rows[0]) {
      const winner = await executor.query<Row>(
        `SELECT * FROM operational_work_items
          WHERE work_item_kind=$1 AND cycle_identity=$2
          ORDER BY created_at DESC LIMIT 1`,
        [blueprint.workItemKind, cycleIdentity],
      );
      await this.insertReceipt(executor, {
        sourceEventId,
        blueprint,
        cycleIdentity,
        actionType,
        workItemId: winner.rows[0] ? String(winner.rows[0].id) : null,
        correlationId,
        causationId: nullableString(event.causation_id),
        result: "duplicate_suppressed",
      });
      return {
        item: winner.rows[0] ? mapOperationalWorkItem(winner.rows[0]) : null,
        inserted: false,
        duplicateSuppressed: true,
      };
    }
    const item = mapOperationalWorkItem(inserted.rows[0] as Row);
    await executor.query(
      `INSERT INTO work_item_assignments
       (id,work_item_id,assigned_user_id,assigned_role_key,action,actor_user_id,reason,correlation_id)
       VALUES ($1,$2,$3::uuid,$4,'created',NULL,$5,$6)`,
      [
        randomUUID(),
        item.id,
        assignment.assignedUserId,
        assignment.assignedRoleKey,
        "Created from domain event.",
        correlationId,
      ],
    );
    await this.appendWorkEvent(executor, {
      workItemId: item.id,
      eventType: "work_item.created",
      fromStatus: null,
      toStatus: "open",
      payload: {
        sourceEventType: String(event.event_type),
        blueprintKey: blueprint.blueprintKey,
      },
      correlationId,
      causationId: sourceEventId,
    });
    await insertAutomationEvent(executor, {
      eventType: "work_item.created",
      aggregateType: "work_item",
      aggregateId: item.id,
      correlationId,
      causationId: sourceEventId,
      actorType: "system",
      actorId: null,
      payload: {
        kind: item.workItemKind,
        reference: item.reference,
        cycleIdentity,
        synthetic: true,
      },
      occurredAt: now,
    });
    await this.scheduleThresholds(executor, item, now);
    await this.insertReceipt(executor, {
      sourceEventId,
      blueprint,
      cycleIdentity,
      actionType,
      workItemId: item.id,
      correlationId,
      causationId: nullableString(event.causation_id),
      result: "created",
    });
    void payload;
    return { item, inserted: true, duplicateSuppressed: false };
  }

  private async resolveWorkItemAssociations(
    executor: SqlExecutor,
    context: DomainContext,
    event: Row,
  ): Promise<{
    readonly projectId: string | null;
    readonly inspectionId: string | null;
    readonly submissionId: string | null;
    readonly reportId: string | null;
    readonly reportVersionId: string | null;
    readonly exceptionId: string | null;
    readonly deliveryAuthorizationId: string | null;
    readonly jobId: string | null;
    readonly deliveryId: string | null;
    readonly requestedRevisionVersionId: string | null;
    readonly scheduledActionId: string | null;
    readonly failureSourceType: string | null;
    readonly failureSourceId: string | null;
    readonly sourceEventId: string | null;
    readonly leadId: string | null;
    readonly proposalId: string | null;
    readonly proposalVersionId: string | null;
    readonly catalogVersionId: string | null;
    readonly pricingOverrideId: string | null;
  }> {
    const originalSourceEventId = await existingId(
      executor,
      "automation_events",
      context.projectionEventId ?? String(event.id),
    );
    return {
      projectId: await existingId(executor, "projects", context.projectId),
      inspectionId: await existingId(executor, "inspections", context.inspectionId),
      submissionId: await existingId(executor, "inspection_submissions", context.submissionId),
      reportId: await existingId(executor, "inspection_reports", context.reportId),
      reportVersionId: await existingId(executor, "report_versions", context.reportVersionId),
      exceptionId: await existingId(executor, "exception_cases", context.exceptionId),
      deliveryAuthorizationId: await existingId(
        executor,
        "delivery_authorizations",
        context.deliveryAuthorizationId,
      ),
      jobId: await existingId(executor, "automation_jobs", context.jobId),
      deliveryId: await existingId(executor, "report_deliveries", context.deliveryId),
      requestedRevisionVersionId: await existingId(
        executor,
        "report_versions",
        context.requestedRevisionVersionId,
      ),
      scheduledActionId: await existingId(
        executor,
        "scheduled_automation_actions",
        context.scheduledActionId,
      ),
      failureSourceType: context.failureSourceType,
      failureSourceId: context.failureSourceId,
      sourceEventId:
        originalSourceEventId ??
        (await existingId(executor, "automation_events", String(event.id))),
      leadId: await existingId(executor, "leads", context.leadId),
      proposalId: await existingId(executor, "proposals", context.proposalId),
      proposalVersionId: await existingId(executor, "proposal_versions", context.proposalVersionId),
      catalogVersionId: await existingId(
        executor,
        "service_catalog_versions",
        context.catalogVersionId,
      ),
      pricingOverrideId: await existingId(
        executor,
        "proposal_pricing_overrides",
        context.pricingOverrideId,
      ),
    };
  }

  private async closeFromBlueprint(
    executor: SqlExecutor,
    blueprint: WorkRoutingBlueprint,
    event: Row,
    context: DomainContext,
    action: "complete" | "cancel",
  ): Promise<void> {
    const eventType = String(event.event_type);
    const sourceEventId = String(event.id);
    const identity = workEventIdentityFrom(eventType, sourceEventId, context);
    const resolutions = resolveWorkCycleIdentities({
      blueprint,
      action,
      identity,
    });
    for (const resolution of resolutions) {
      if (resolution.kind === "malformed_missing_identity") {
        throw createCycleIdentityIncompleteError(resolution);
      }
      if (resolution.kind === "not_applicable") {
        await this.insertReceipt(executor, {
          sourceEventId,
          blueprint,
          cycleIdentity: `not_applicable:${blueprint.blueprintKey}`,
          actionType: action,
          workItemId: null,
          correlationId: String(event.correlation_id),
          causationId: nullableString(event.causation_id),
          result: "not_applicable",
        });
        continue;
      }
      const cycleIdentity = resolution.cycleIdentity;
      const correlationId = String(event.correlation_id);
      const open = await executor.query<Row>(
        `SELECT * FROM operational_work_items
          WHERE work_item_kind=$1
            AND cycle_identity=$2
            AND status IN (${OPEN_WORK_STATUSES_SQL})
          ORDER BY created_at`,
        [blueprint.workItemKind, cycleIdentity],
      );
      if (open.rows.length === 0) {
        continue;
      }
      const now = iso(event.occurred_at);
      for (const row of open.rows) {
        const item = mapOperationalWorkItem(row);
        const next: WorkItemStatus = action === "complete" ? "completed" : "cancelled";
        try {
          assertWorkItemTransition(item.status, next);
        } catch {
          continue;
        }
        await this.applyStatus(executor, item, next, {
          actorUserId: null,
          correlationId,
          causationId: sourceEventId,
          completionEventType: String(event.event_type),
          completionEventId: sourceEventId,
          now,
        });
        await this.insertReceipt(executor, {
          sourceEventId,
          blueprint,
          cycleIdentity: item.cycleIdentity,
          actionType: action,
          workItemId: item.id,
          correlationId,
          causationId: nullableString(event.causation_id),
          result: action === "complete" ? "completed" : "cancelled",
        });
      }
    }
  }

  private async cancelOpenWorkForInspection(
    executor: SqlExecutor,
    event: Row,
    inspectionId: string,
  ): Promise<void> {
    const open = await executor.query<Row>(
      `SELECT * FROM operational_work_items
        WHERE inspection_id=$1 AND status IN (${OPEN_WORK_STATUSES_SQL})
        ORDER BY created_at`,
      [inspectionId],
    );
    const now = iso(event.occurred_at);
    for (const row of open.rows) {
      const item = mapOperationalWorkItem(row);
      try {
        assertWorkItemTransition(item.status, "cancelled");
      } catch {
        continue;
      }
      await this.applyStatus(executor, item, "cancelled", {
        actorUserId: null,
        correlationId: String(event.correlation_id),
        causationId: String(event.id),
        completionEventType: String(event.event_type),
        completionEventId: String(event.id),
        now,
      });
    }
  }

  private async cancelOpenWorkForSupersededVersion(
    executor: SqlExecutor,
    event: Row,
    reportVersionId: string,
  ): Promise<void> {
    const open = await executor.query<Row>(
      `SELECT * FROM operational_work_items
        WHERE report_version_id=$1
          AND work_item_kind IN ('report_technical_review','report_delivery_authorization')
          AND status IN (${OPEN_WORK_STATUSES_SQL})
        ORDER BY created_at`,
      [reportVersionId],
    );
    const now = iso(event.occurred_at);
    for (const row of open.rows) {
      const item = mapOperationalWorkItem(row);
      try {
        assertWorkItemTransition(item.status, "cancelled");
      } catch {
        continue;
      }
      await this.applyStatus(executor, item, "cancelled", {
        actorUserId: null,
        correlationId: String(event.correlation_id),
        causationId: String(event.id),
        completionEventType: "report.version_superseded",
        completionEventId: String(event.id),
        now,
      });
    }
  }

  private async closeProjectionFailureWork(
    executor: SqlExecutor,
    eventId: string,
    event: Row,
  ): Promise<void> {
    const cycleIdentity = buildWorkItemCycleIdentity({
      kind: "automation_failure",
      projectionEventId: eventId,
    });
    const open = await executor.query<Row>(
      `SELECT * FROM operational_work_items
        WHERE work_item_kind='automation_failure' AND cycle_identity=$1
          AND status IN (${OPEN_WORK_STATUSES_SQL})`,
      [cycleIdentity],
    );
    if (!open.rows[0]) return;
    const item = mapOperationalWorkItem(open.rows[0]);
    await this.applyStatus(executor, item, "completed", {
      actorUserId: null,
      correlationId: String(event.correlation_id),
      causationId: eventId,
      completionEventType: "automation.projection_succeeded",
      completionEventId: eventId,
      now: iso(event.occurred_at),
    });
  }

  private async recordProjectionFailure(
    row: Row,
    error: unknown,
  ): Promise<"failed" | "dead_lettered" | "failure_recording_error"> {
    const eventId = String(row.id);
    try {
      const persisted = await this.persistTerminalProjectionFailure(row, error);
      if (!persisted) return "failed";
      if (persisted.deadLettered) {
        try {
          const notificationId = await this.enqueueProjectionDeadLetterNotification(persisted);
          if (notificationId) {
            try {
              await this.processEventRow({
                id: notificationId,
                event_type: "automation.projection_dead_lettered",
                processing_status: "pending",
              });
            } catch (projectionError) {
              try {
                const notification = await this.dependencies.database.query<Row>(
                  "SELECT * FROM automation_events WHERE id=$1",
                  [notificationId],
                );
                if (notification.rows[0]) {
                  await this.persistTerminalProjectionFailure(
                    notification.rows[0],
                    projectionError,
                  );
                }
              } catch {
                this.dependencies.onIsolatedProjectionError?.({
                  eventId: notificationId,
                  eventType: "automation.projection_dead_lettered",
                  code: "FAILURE_WORK_PROJECTION_FAILED",
                });
              }
            }
          }
        } catch (enqueueError) {
          this.dependencies.onIsolatedProjectionError?.({
            eventId,
            eventType: String(row.event_type),
            code: "DEAD_LETTER_NOTIFICATION_FAILED",
          });
          void enqueueError;
        }
        return "dead_lettered";
      }
      return "failed";
    } catch (recordingError) {
      this.dependencies.onIsolatedProjectionError?.({
        eventId,
        eventType: String(row.event_type),
        code: "FAILURE_RECORDING_ERROR",
      });
      void recordingError;
      return "failure_recording_error";
    }
  }

  private async persistTerminalProjectionFailure(
    row: Row,
    error: unknown,
  ): Promise<{
    readonly eventId: string;
    readonly deadLettered: boolean;
    readonly eventType: string;
    readonly aggregateType: string;
    readonly aggregateId: string;
    readonly correlationId: string;
    readonly payload: JsonObject;
    readonly code: string;
    readonly message: string;
  } | null> {
    const eventId = String(row.id);
    const now = this.stamp();
    const safe = sanitizeProjectionError(error);
    return this.dependencies.database.transaction(async (transaction) => {
      const locked = await transaction.query<Row>(
        "SELECT * FROM automation_events WHERE id=$1 FOR UPDATE",
        [eventId],
      );
      const event = locked.rows[0];
      if (!event) return null;
      const status = String(event.processing_status);
      if (status === "processed" || status === "ignored") return null;
      if (status === "dead_lettered") {
        return {
          eventId,
          deadLettered: true,
          eventType: String(event.event_type),
          aggregateType: String(event.aggregate_type),
          aggregateId: String(event.aggregate_id),
          correlationId: String(event.correlation_id),
          payload: jsonValue(event.payload, {}),
          code: safe.code,
          message: safe.message,
        };
      }
      const priorAttempts = Number(event.projection_attempt_count ?? 0);
      const attempt = priorAttempts + 1;
      const dead = !safe.retryable || attempt >= PROJECTION_MAX_ATTEMPTS;
      const nextStatus = dead ? "dead_lettered" : "failed";
      const nextRetry = dead
        ? null
        : new Date(Date.parse(now) + projectionRetryDelayMs(attempt)).toISOString();
      await transaction.query(
        `UPDATE automation_events
            SET processing_status=$2,
                projection_attempt_count=$3,
                projection_first_failed_at=COALESCE(projection_first_failed_at,$4::timestamptz),
                projection_last_failed_at=$4::timestamptz,
                projection_next_retry_at=$5::timestamptz,
                projection_error_code=$6,
                projection_error_message=$7,
                projection_retryable=$8,
                projection_dead_lettered_at=$9::timestamptz
          WHERE id=$1`,
        [
          eventId,
          nextStatus,
          attempt,
          now,
          nextRetry,
          safe.code,
          safe.message,
          safe.retryable && !dead,
          dead ? now : null,
        ],
      );
      await transaction.query(
        `INSERT INTO event_projection_failures
         (id,source_event_id,event_type,aggregate_type,aggregate_id,correlation_id,attempt_number,error_code,error_message,retryable,terminal,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz)
         ON CONFLICT (source_event_id, attempt_number) DO NOTHING`,
        [
          randomUUID(),
          eventId,
          String(event.event_type),
          String(event.aggregate_type),
          String(event.aggregate_id),
          String(event.correlation_id),
          attempt,
          safe.code,
          safe.message,
          safe.retryable,
          dead,
          now,
        ],
      );
      return {
        eventId,
        deadLettered: dead,
        eventType: String(event.event_type),
        aggregateType: String(event.aggregate_type),
        aggregateId: String(event.aggregate_id),
        correlationId: String(event.correlation_id),
        payload: jsonValue(event.payload, {}),
        code: safe.code,
        message: safe.message,
      };
    });
  }

  private async enqueueProjectionDeadLetterNotification(input: {
    readonly eventId: string;
    readonly eventType: string;
    readonly aggregateType: string;
    readonly aggregateId: string;
    readonly correlationId: string;
    readonly payload: JsonObject;
    readonly code: string;
    readonly message: string;
  }): Promise<string | null> {
    const existing = await this.dependencies.database.query<Row>(
      `SELECT id FROM automation_events
        WHERE event_type='automation.projection_dead_lettered'
          AND payload->>'sourceEventId'=$1
        ORDER BY recorded_at
        LIMIT 1`,
      [input.eventId],
    );
    if (existing.rows[0]) return String(existing.rows[0].id);
    const now = this.stamp();
    const inserted = await this.dependencies.database.transaction(async (transaction) => {
      const again = await transaction.query<Row>(
        `SELECT id FROM automation_events
          WHERE event_type='automation.projection_dead_lettered'
            AND payload->>'sourceEventId'=$1
          LIMIT 1`,
        [input.eventId],
      );
      if (again.rows[0]) return String(again.rows[0].id);
      const event = await insertAutomationEvent(transaction, {
        eventType: "automation.projection_dead_lettered",
        aggregateType: "projection",
        aggregateId: input.eventId,
        correlationId: input.correlationId,
        causationId: input.eventId,
        actorType: "system",
        actorId: null,
        payload: {
          sourceEventId: input.eventId,
          projectionEventId: input.eventId,
          originalEventType: input.eventType,
          originalAggregateType: input.aggregateType,
          originalAggregateId: input.aggregateId,
          errorCode: input.code,
          inspectionId:
            input.aggregateType === "inspection"
              ? input.aggregateId
              : payloadString(input.payload, "inspectionId"),
          reportId:
            input.aggregateType === "report"
              ? input.aggregateId
              : payloadString(input.payload, "reportId"),
        },
        occurredAt: now,
      });
      return event.id;
    });
    return inserted;
  }

  private async applyStatus(
    executor: SqlExecutor,
    item: OperationalWorkItem,
    next: WorkItemStatus,
    input: {
      readonly actorUserId: string | null;
      readonly correlationId: string;
      readonly causationId: string | null;
      readonly completionEventType?: string | null;
      readonly completionEventId?: string | null;
      readonly blockedReason?: string | null;
      readonly now: string;
    },
  ): Promise<OperationalWorkItem> {
    assertWorkItemTransition(item.status, next);
    const acknowledgedAt = next === "acknowledged" ? input.now : item.acknowledgedAt;
    const startedAt = next === "in_progress" ? (item.startedAt ?? input.now) : item.startedAt;
    const blockedAt =
      next === "blocked" ? input.now : next === "in_progress" ? null : item.blockedAt;
    const completedAt = next === "completed" ? input.now : item.completedAt;
    const cancelledAt = next === "cancelled" ? input.now : item.cancelledAt;
    const blockedReason =
      next === "blocked"
        ? (input.blockedReason ?? item.blockedReason)
        : next === "in_progress"
          ? null
          : item.blockedReason;
    const updated = await executor.query<Row>(
      `UPDATE operational_work_items
          SET status=$2,
              acknowledged_at=$3,
              started_at=$4,
              blocked_at=$5,
              completed_at=$6,
              cancelled_at=$7,
              blocked_reason=$8,
              completion_event_type=COALESCE($9, completion_event_type),
              completion_event_id=COALESCE($10, completion_event_id),
              updated_at=$11,
              version=version+1
        WHERE id=$1
        RETURNING *`,
      [
        item.id,
        next,
        acknowledgedAt,
        startedAt,
        blockedAt,
        completedAt,
        cancelledAt,
        blockedReason,
        input.completionEventType ?? null,
        input.completionEventId ?? null,
        input.now,
      ],
    );
    const live = mapOperationalWorkItem(updated.rows[0] as Row);
    await this.appendWorkEvent(executor, {
      workItemId: item.id,
      eventType:
        next === "completed"
          ? "work_item.completed"
          : next === "cancelled"
            ? "work_item.cancelled"
            : next === "blocked"
              ? "work_item.blocked"
              : next === "acknowledged"
                ? "work_item.acknowledged"
                : "work_item.started",
      fromStatus: item.status,
      toStatus: next,
      actorUserId: input.actorUserId,
      payload: {
        ...(blockedReason ? { blockedReason } : {}),
        ...(input.completionEventType ? { completionEventType: input.completionEventType } : {}),
      },
      correlationId: input.correlationId,
      causationId: input.causationId,
    });
    if (isTerminalWorkItemStatus(next)) {
      await executor.query(
        `UPDATE work_item_escalations SET resolved_at=$2 WHERE work_item_id=$1 AND resolved_at IS NULL`,
        [item.id, input.now],
      );
      await executor.query(
        `UPDATE scheduled_automation_actions
            SET status='cancelled', last_result='work_item_terminal', updated_at=$2
          WHERE work_item_id=$1 AND status IN ('pending','due','paused')`,
        [item.id, input.now],
      );
      await insertAutomationEvent(executor, {
        eventType: next === "completed" ? "work_item.completed" : "work_item.cancelled",
        aggregateType: "work_item",
        aggregateId: item.id,
        correlationId: input.correlationId,
        causationId: input.causationId,
        actorType: input.actorUserId ? "user" : "system",
        actorId: input.actorUserId,
        payload: { kind: item.workItemKind, reference: item.reference },
        occurredAt: input.now,
      });
      await recordAuditAndActivity(executor, {
        eventType: next === "completed" ? "work_item.completed" : "work_item.cancelled",
        action: `work.${next}`,
        actorUserId: input.actorUserId,
        resourceType: "operational_work_item",
        resourceId: item.id,
        correlationId: input.correlationId,
        metadata: { kind: item.workItemKind, cycleIdentity: item.cycleIdentity },
        summary: `${item.reference} ${next}`,
        inspectionId: item.inspectionId,
        reportId: item.reportId,
        now: input.now,
      });
    }
    return live;
  }

  private async appendWorkEvent(
    executor: SqlExecutor,
    input: {
      readonly workItemId: string;
      readonly eventType: string;
      readonly fromStatus: string | null;
      readonly toStatus: string | null;
      readonly actorUserId?: string | null;
      readonly payload: JsonObject;
      readonly correlationId: string;
      readonly causationId: string | null;
    },
  ): Promise<void> {
    await executor.query(
      `INSERT INTO work_item_events
       (id,work_item_id,event_type,from_status,to_status,actor_user_id,payload,correlation_id,causation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
      [
        randomUUID(),
        input.workItemId,
        input.eventType,
        input.fromStatus,
        input.toStatus,
        input.actorUserId ?? null,
        JSON.stringify(input.payload),
        input.correlationId,
        input.causationId,
      ],
    );
  }

  private async scheduleThresholds(
    executor: SqlExecutor,
    item: OperationalWorkItem,
    now: string,
  ): Promise<void> {
    if (!item.dueAt) return;
    for (const rule of SYNTHETIC_REMINDER_RULES) {
      const anchor = selectReminderAnchor({
        relativeTo: rule.relativeTo,
        availableAt: item.availableAt,
        dueAt: item.dueAt,
      });
      if (!anchor) continue;
      const scheduledFor = reminderDueAt(anchor, rule.offsetMs);
      await this.insertSchedule(executor, {
        scheduleKey: `work.reminder:${item.id}:${rule.thresholdKey}`,
        actionType: "work.reminder",
        workItemId: item.id,
        scheduledFor,
        idempotencyKey: `reminder:${item.id}:${rule.thresholdKey}:v1`,
        correlationId: item.correlationId,
        now,
        payload: { thresholdKey: rule.thresholdKey },
      });
    }
    for (const rule of SYNTHETIC_ESCALATION_RULES) {
      const scheduledFor = escalationDueAt({
        availableAt: item.availableAt,
        dueAt: item.dueAt,
        ratioOfDueWindow: rule.ratioOfDueWindow,
      });
      if (!scheduledFor) continue;
      await this.insertSchedule(executor, {
        scheduleKey: `work.escalation:${item.id}:${rule.level}`,
        actionType: "work.escalation",
        workItemId: item.id,
        scheduledFor,
        idempotencyKey: `escalation:${item.id}:${rule.level}:v1`,
        correlationId: item.correlationId,
        now,
        payload: { level: rule.level },
      });
    }
  }

  private async insertSchedule(
    executor: SqlExecutor,
    input: {
      readonly scheduleKey: string;
      readonly actionType: "work.reminder" | "work.escalation" | "work.reconcile";
      readonly workItemId: string | null;
      readonly scheduledFor: string;
      readonly idempotencyKey: string;
      readonly correlationId: string;
      readonly now: string;
      readonly payload: JsonObject;
    },
  ): Promise<void> {
    await executor.query(
      `INSERT INTO scheduled_automation_actions
       (id,schedule_key,policy_version,action_type,work_item_id,scheduled_for,status,idempotency_key,correlation_id,payload,created_at,updated_at,version,max_attempts)
       VALUES ($1,$2,1,$3,$4::uuid,$5::timestamptz,'pending',$6,$7,$8::jsonb,$9::timestamptz,$9::timestamptz,1,$10)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        randomUUID(),
        input.scheduleKey,
        input.actionType,
        input.workItemId,
        input.scheduledFor,
        input.idempotencyKey,
        input.correlationId,
        JSON.stringify(input.payload),
        input.now,
        SCHEDULE_MAX_ATTEMPTS,
      ],
    );
  }

  async claimWorkItem(workItemId: string, actor: WorkActor): Promise<OperationalWorkItem> {
    const now = this.stamp();
    return this.dependencies.database.transaction(async (transaction) => {
      const locked = await transaction.query<Row>(
        this.dependencies.database.kind === "postgres"
          ? "SELECT * FROM operational_work_items WHERE id=$1 FOR UPDATE SKIP LOCKED"
          : "SELECT * FROM operational_work_items WHERE id=$1 FOR UPDATE",
        [workItemId],
      );
      if (!locked.rows[0]) {
        throw new WorkItemClaimError("The work item is not available to claim.");
      }
      const item = mapOperationalWorkItem(locked.rows[0]);
      if (actor.expectedVersion && actor.expectedVersion !== item.version) {
        throw new WorkItemClaimError("The work item changed before the claim could be saved.");
      }
      if (!isOpenWorkItemStatus(item.status)) {
        throw new WorkItemClaimError("Terminal work items cannot be claimed.");
      }
      const eligibility = userMayClaimWorkItem({
        actorUserId: actor.userId,
        actorRoleKeys: actor.roleKeys,
        assignedUserId: item.assignedUserId,
        assignedRoleKey: item.assignedRoleKey,
        claimedUserId: item.claimedUserId,
        workItemKind: item.workItemKind,
        hasOwnerPrivilege: hasOwnerPrivilege(actor.roleKeys),
      });
      if (!eligibility.allowed) {
        throw new WorkItemClaimError(`Claim refused: ${eligibility.reason}.`);
      }
      if (item.claimedUserId && item.claimedUserId !== actor.userId) {
        throw new WorkItemClaimError("The work item is already claimed.");
      }
      const updated = await transaction.query<Row>(
        `UPDATE operational_work_items
            SET claimed_user_id=$2,
                claimed_at=$3,
                updated_at=$3,
                version=version+1
          WHERE id=$1 AND (claimed_user_id IS NULL OR claimed_user_id=$2)
            AND status IN ('open','acknowledged','in_progress','blocked')
          RETURNING *`,
        [item.id, actor.userId, now],
      );
      if (!updated.rows[0]) {
        throw new WorkItemClaimError("Another user claimed this work item.");
      }
      const live = mapOperationalWorkItem(updated.rows[0]);
      await transaction.query(
        `INSERT INTO work_item_assignments
         (id,work_item_id,assigned_user_id,assigned_role_key,claimed_user_id,action,actor_user_id,reason,correlation_id)
         VALUES ($1,$2,$3,$4,$5,'claimed',$5,'Atomic role-queue claim.',$6)`,
        [
          randomUUID(),
          live.id,
          live.assignedUserId,
          live.assignedRoleKey,
          actor.userId,
          actor.correlationId,
        ],
      );
      await this.appendWorkEvent(transaction, {
        workItemId: live.id,
        eventType: "work_item.claimed",
        fromStatus: item.status,
        toStatus: live.status,
        actorUserId: actor.userId,
        payload: { reason: eligibility.reason },
        correlationId: actor.correlationId,
        causationId: null,
      });
      await insertAutomationEvent(transaction, {
        eventType: "work_item.claimed",
        aggregateType: "work_item",
        aggregateId: live.id,
        correlationId: actor.correlationId,
        actorType: "user",
        actorId: actor.userId,
        payload: { reference: live.reference },
        occurredAt: now,
      });
      await recordAuditAndActivity(transaction, {
        eventType: "work_item.claimed",
        action: "work.claim",
        actorUserId: actor.userId,
        resourceType: "operational_work_item",
        resourceId: live.id,
        correlationId: actor.correlationId,
        metadata: { kind: live.workItemKind },
        summary: `${live.reference} claimed`,
        inspectionId: live.inspectionId,
        reportId: live.reportId,
        now,
      });
      return live;
    });
  }

  async releaseClaim(workItemId: string, actor: WorkActor): Promise<OperationalWorkItem> {
    const now = this.stamp();
    return this.dependencies.database.transaction(async (transaction) => {
      const item = await this.lockWorkItem(transaction, workItemId, actor.expectedVersion);
      if (item.claimedUserId !== actor.userId && !hasOwnerPrivilege(actor.roleKeys)) {
        throw new WorkItemClaimError("Only the claimant or Owner can release this claim.");
      }
      const updated = await transaction.query<Row>(
        `UPDATE operational_work_items
            SET claimed_user_id=NULL, claimed_at=NULL, updated_at=$2, version=version+1
          WHERE id=$1 RETURNING *`,
        [item.id, now],
      );
      const live = mapOperationalWorkItem(updated.rows[0] as Row);
      await transaction.query(
        `INSERT INTO work_item_assignments
         (id,work_item_id,assigned_user_id,assigned_role_key,action,actor_user_id,reason,correlation_id)
         VALUES ($1,$2,$3,$4,'released',$5,'Claim released.',$6)`,
        [
          randomUUID(),
          live.id,
          live.assignedUserId,
          live.assignedRoleKey,
          actor.userId,
          actor.correlationId,
        ],
      );
      await this.appendWorkEvent(transaction, {
        workItemId: live.id,
        eventType: "work_item.released",
        fromStatus: item.status,
        toStatus: live.status,
        actorUserId: actor.userId,
        payload: {},
        correlationId: actor.correlationId,
        causationId: null,
      });
      return live;
    });
  }

  async acknowledgeWorkItem(workItemId: string, actor: WorkActor): Promise<OperationalWorkItem> {
    return this.transitionOwned(workItemId, actor, "acknowledged");
  }

  async startWorkItem(workItemId: string, actor: WorkActor): Promise<OperationalWorkItem> {
    return this.transitionOwned(workItemId, actor, "in_progress");
  }

  async blockWorkItem(
    workItemId: string,
    actor: WorkActor,
    reason: string,
  ): Promise<OperationalWorkItem> {
    const trimmed = reason.trim();
    if (!trimmed) throw new WorkItemTransitionError("open", "blocked");
    return this.transitionOwned(workItemId, actor, "blocked", trimmed);
  }

  async unblockWorkItem(workItemId: string, actor: WorkActor): Promise<OperationalWorkItem> {
    return this.transitionOwned(workItemId, actor, "in_progress");
  }

  async reassignWorkItem(
    workItemId: string,
    actor: WorkActor,
    input: { readonly assignedUserId: string | null; readonly assignedRoleKey: string | null },
  ): Promise<OperationalWorkItem> {
    if (!hasOwnerPrivilege(actor.roleKeys)) {
      throw new WorkItemClaimError("Only Owner may reassign operational work.");
    }
    const now = this.stamp();
    return this.dependencies.database.transaction(async (transaction) => {
      const item = await this.lockWorkItem(transaction, workItemId, actor.expectedVersion);
      if (!isOpenWorkItemStatus(item.status)) {
        throw new WorkItemClaimError("Terminal work items cannot be reassigned.");
      }
      if (input.assignedRoleKey && !isKnownWorkRoleKey(input.assignedRoleKey)) {
        throw new WorkReassignmentError("assignedRoleKey must be a known role.");
      }
      if (input.assignedUserId) {
        const user = await transaction.query<Row>("SELECT id, status FROM users WHERE id=$1", [
          input.assignedUserId,
        ]);
        if (!user.rows[0] || String(user.rows[0].status) !== "active") {
          throw new WorkReassignmentError("assignedUserId must be an active user.");
        }
      }
      const updated = await transaction.query<Row>(
        `UPDATE operational_work_items
            SET assigned_user_id=$2, assigned_role_key=$3, claimed_user_id=NULL, claimed_at=NULL,
                updated_at=$4, version=version+1
          WHERE id=$1 RETURNING *`,
        [item.id, input.assignedUserId, input.assignedRoleKey, now],
      );
      const live = mapOperationalWorkItem(updated.rows[0] as Row);
      await transaction.query(
        `INSERT INTO work_item_assignments
         (id,work_item_id,assigned_user_id,assigned_role_key,action,actor_user_id,reason,correlation_id)
         VALUES ($1,$2,$3,$4,'reassigned',$5,'Owner reassignment.',$6)`,
        [
          randomUUID(),
          live.id,
          live.assignedUserId,
          live.assignedRoleKey,
          actor.userId,
          actor.correlationId,
        ],
      );
      await this.appendWorkEvent(transaction, {
        workItemId: live.id,
        eventType: "work_item.reassigned",
        fromStatus: item.status,
        toStatus: live.status,
        actorUserId: actor.userId,
        payload: { assignedUserId: input.assignedUserId, assignedRoleKey: input.assignedRoleKey },
        correlationId: actor.correlationId,
        causationId: null,
      });
      return live;
    });
  }

  refuseManualCompletion(kind: WorkItemKind): never {
    if (CRITICAL_WORK_ITEM_KINDS.includes(kind)) {
      throw new WorkItemManualCompletionError(kind);
    }
    throw new WorkItemManualCompletionError(kind);
  }

  private async transitionOwned(
    workItemId: string,
    actor: WorkActor,
    next: WorkItemStatus,
    blockedReason?: string,
  ): Promise<OperationalWorkItem> {
    const now = this.stamp();
    return this.dependencies.database.transaction(async (transaction) => {
      const item = await this.lockWorkItem(transaction, workItemId, actor.expectedVersion);
      const eligibility = userMayClaimWorkItem({
        actorUserId: actor.userId,
        actorRoleKeys: actor.roleKeys,
        assignedUserId: item.assignedUserId,
        assignedRoleKey: item.assignedRoleKey,
        claimedUserId: item.claimedUserId,
        workItemKind: item.workItemKind,
        hasOwnerPrivilege: hasOwnerPrivilege(actor.roleKeys),
      });
      if (!eligibility.allowed) {
        throw new WorkItemClaimError(`Update refused: ${eligibility.reason}.`);
      }
      return this.applyStatus(transaction, item, next, {
        actorUserId: actor.userId,
        correlationId: actor.correlationId,
        causationId: null,
        blockedReason: blockedReason ?? null,
        now,
      });
    });
  }

  private async lockWorkItem(
    executor: SqlExecutor,
    workItemId: string,
    expectedVersion?: number,
  ): Promise<OperationalWorkItem> {
    const result = await executor.query<Row>(
      "SELECT * FROM operational_work_items WHERE id=$1 FOR UPDATE",
      [workItemId],
    );
    if (!result.rows[0]) throw new WorkItemClaimError("Work item was not found.");
    const item = mapOperationalWorkItem(result.rows[0]);
    if (expectedVersion && expectedVersion !== item.version) {
      throw new WorkItemClaimError("The work item changed before the update could be saved.");
    }
    return item;
  }

  async evaluateDueSchedules(): Promise<ScheduleEvaluationCounts> {
    const nowDate = this.now();
    const now = nowDate.toISOString();
    const dueRows = queryRows(
      await this.dependencies.database.query<Row>(
        `SELECT * FROM scheduled_automation_actions
          WHERE (
            status IN ('pending','due') AND scheduled_for<=$1
          ) OR (
            status='failed' AND next_run_at IS NOT NULL AND next_run_at<=$1
            AND attempt_count < max_attempts
          )
          ORDER BY scheduled_for
          LIMIT 80`,
        [now],
      ),
    );
    let counts = emptyScheduleEvaluationCounts();
    for (const row of dueRows) {
      const schedule = mapScheduledAction(row);
      if (
        schedule.status !== "failed" &&
        !schedulerCatchUpDue({
          scheduledFor: schedule.scheduledFor,
          now: nowDate,
          status: schedule.status,
        })
      ) {
        continue;
      }
      const outcome = await this.evaluateSchedule(schedule.id);
      counts = tallyScheduleOutcome(counts, outcome);
    }
    return counts;
  }

  async evaluateSchedule(scheduleId: string): Promise<ScheduleEvaluationOutcome> {
    const now = this.stamp();
    try {
      return await this.dependencies.database.transaction(async (transaction) => {
        const locked = await transaction.query<Row>(
          this.dependencies.database.kind === "postgres"
            ? "SELECT * FROM scheduled_automation_actions WHERE id=$1 FOR UPDATE SKIP LOCKED"
            : "SELECT * FROM scheduled_automation_actions WHERE id=$1 FOR UPDATE",
          [scheduleId],
        );
        if (!locked.rows[0]) return "unavailable";
        const schedule = mapScheduledAction(locked.rows[0]);
        if (
          schedule.status === "succeeded" ||
          schedule.status === "cancelled" ||
          schedule.status === "paused"
        ) {
          return "already_processed";
        }
        const wasFailed = schedule.status === "failed";
        const payload = jsonValue<JsonObject>((locked.rows[0] as Row).payload ?? {}, {});
        if (schedule.actionType === "work.reconcile") {
          await this.reconcileOnExecutor(transaction, {
            mode: "execute",
            actorUserId: null,
            correlationId: schedule.correlationId,
            now,
          });
          const nextRun = new Date(Date.parse(now) + 15 * 60 * 1000).toISOString();
          await transaction.query(
            `UPDATE scheduled_automation_actions
                SET status='pending', last_evaluated_at=$2, next_run_at=$3, scheduled_for=$3,
                    attempt_count=attempt_count+1, last_result='reconciled', updated_at=$2, version=version+1
              WHERE id=$1`,
            [schedule.id, now, nextRun],
          );
          return "claimed_and_executed";
        }
        if (!schedule.workItemId) {
          await this.markSchedule(transaction, schedule.id, "cancelled", "missing_work_item", now);
          return "unavailable";
        }
        const itemRow = await transaction.query<Row>(
          "SELECT * FROM operational_work_items WHERE id=$1 FOR UPDATE",
          [schedule.workItemId],
        );
        if (!itemRow.rows[0]) {
          await this.markSchedule(transaction, schedule.id, "cancelled", "work_item_missing", now);
          return "unavailable";
        }
        const item = mapOperationalWorkItem(itemRow.rows[0]);
        const sla = await this.loadSlaPause(transaction, item.inspectionId);
        if (
          shouldSuppressTimedAction({
            status: item.status,
            slaPaused: sla.paused,
            pauseReason: sla.pauseReason,
          })
        ) {
          await this.markSchedule(transaction, schedule.id, "cancelled", "suppressed", now);
          return "suppressed";
        }
        let effect: "inserted" | "duplicate" | "skipped" = "skipped";
        await this.dependencies.beforeScheduleEffect?.({ scheduleId: schedule.id });
        if (schedule.actionType === "work.reminder") {
          effect = await this.createReminder(
            transaction,
            item,
            typeof payload.thresholdKey === "string" ? payload.thresholdKey : "",
            now,
          );
        } else if (schedule.actionType === "work.escalation") {
          effect = await this.createEscalation(transaction, item, now);
        }
        if (effect === "skipped") {
          await this.markSchedule(transaction, schedule.id, "succeeded", "catch_up_skip", now);
          return "already_processed";
        }
        await this.markSchedule(
          transaction,
          schedule.id,
          "succeeded",
          effect === "duplicate" ? "duplicate_suppressed" : "evaluated_once",
          now,
        );
        if (wasFailed) {
          await insertAutomationEvent(transaction, {
            eventType: "automation.schedule_succeeded",
            aggregateType: "schedule",
            aggregateId: schedule.id,
            correlationId: schedule.correlationId,
            actorType: "system",
            actorId: null,
            payload: { scheduleId: schedule.id, scheduledActionId: schedule.id },
            occurredAt: now,
          });
        }
        return effect === "duplicate" ? "duplicate_suppressed" : "claimed_and_executed";
      });
    } catch (error) {
      return this.recordScheduleFailure(scheduleId, error, now);
    }
  }

  private async recordScheduleFailure(
    scheduleId: string,
    error: unknown,
    now: string,
  ): Promise<ScheduleEvaluationOutcome> {
    const safe = sanitizeProjectionError(error);
    const outcome = await this.dependencies.database.transaction(async (transaction) => {
      const locked = await transaction.query<Row>(
        "SELECT * FROM scheduled_automation_actions WHERE id=$1 FOR UPDATE",
        [scheduleId],
      );
      if (!locked.rows[0]) return "unavailable" as const;
      const schedule = mapScheduledAction(locked.rows[0]);
      if (
        schedule.status === "succeeded" ||
        schedule.status === "cancelled" ||
        schedule.status === "paused"
      ) {
        return "already_processed" as const;
      }
      const attempts = schedule.attemptCount + 1;
      const maxAttempts = schedule.maxAttempts ?? SCHEDULE_MAX_ATTEMPTS;
      if (attempts >= maxAttempts) {
        await this.markSchedule(transaction, schedule.id, "failed", safe.message, now);
        return "failed" as const;
      }
      const nextRun = new Date(Date.parse(now) + scheduleRetryDelayMs(attempts)).toISOString();
      await transaction.query(
        `UPDATE scheduled_automation_actions
            SET status='failed', last_evaluated_at=$2, next_run_at=$3, scheduled_for=$3,
                attempt_count=$4, last_result=$5, updated_at=$2, version=version+1
          WHERE id=$1`,
        [schedule.id, now, nextRun, attempts, safe.message],
      );
      return "retry_scheduled" as const;
    });
    if (outcome === "failed") {
      try {
        const notificationId = await this.enqueueScheduleDeadLetterNotification(scheduleId, safe);
        if (notificationId) {
          try {
            await this.processEventRow({
              id: notificationId,
              event_type: "automation.schedule_dead_lettered",
              processing_status: "pending",
            });
          } catch (projectionError) {
            try {
              const notification = await this.dependencies.database.query<Row>(
                "SELECT * FROM automation_events WHERE id=$1",
                [notificationId],
              );
              if (notification.rows[0]) {
                await this.persistTerminalProjectionFailure(notification.rows[0], projectionError);
              }
            } catch {
              this.dependencies.onIsolatedProjectionError?.({
                eventId: notificationId,
                eventType: "automation.schedule_dead_lettered",
                code: "SCHEDULE_FAILURE_WORK_PROJECTION_FAILED",
              });
            }
          }
        }
      } catch {
        this.dependencies.onIsolatedProjectionError?.({
          eventId: scheduleId,
          eventType: "automation.schedule_dead_lettered",
          code: "SCHEDULE_DEAD_LETTER_NOTIFICATION_FAILED",
        });
      }
    }
    return outcome;
  }

  private async enqueueScheduleDeadLetterNotification(
    scheduleId: string,
    safe: { readonly code: string; readonly message: string },
  ): Promise<string | null> {
    const existing = await this.dependencies.database.query<Row>(
      `SELECT id FROM automation_events
        WHERE event_type='automation.schedule_dead_lettered'
          AND (aggregate_id=$1::uuid OR payload->>'scheduleId'=$2)
        ORDER BY recorded_at
        LIMIT 1`,
      [scheduleId, scheduleId],
    );
    if (existing.rows[0]) return String(existing.rows[0].id);
    const schedule = await this.dependencies.database.query<Row>(
      "SELECT * FROM scheduled_automation_actions WHERE id=$1",
      [scheduleId],
    );
    if (!schedule.rows[0]) return null;
    const mapped = mapScheduledAction(schedule.rows[0]);
    const now = this.stamp();
    const event = await insertAutomationEvent(this.dependencies.database, {
      eventType: "automation.schedule_dead_lettered",
      aggregateType: "schedule",
      aggregateId: scheduleId,
      correlationId: mapped.correlationId,
      actorType: "system",
      actorId: null,
      payload: {
        scheduleId,
        scheduledActionId: scheduleId,
        scheduleKey: mapped.scheduleKey,
        errorCode: safe.code,
      },
      occurredAt: now,
    });
    return event.id;
  }

  private async markSchedule(
    executor: SqlExecutor,
    id: string,
    status: string,
    result: string,
    now: string,
  ): Promise<void> {
    await executor.query(
      `UPDATE scheduled_automation_actions
          SET status=$2, last_evaluated_at=$3, last_result=$4, attempt_count=attempt_count+1,
              updated_at=$3, version=version+1
        WHERE id=$1`,
      [id, status, now, result],
    );
  }

  private async loadSlaPause(
    executor: SqlExecutor,
    inspectionId: string | null,
  ): Promise<{ readonly paused: boolean; readonly pauseReason: string | null }> {
    if (!inspectionId) return { paused: false, pauseReason: null };
    const result = await executor.query<Row>(
      "SELECT status, pause_reason FROM sla_clocks WHERE inspection_id=$1 LIMIT 1",
      [inspectionId],
    );
    const row = result.rows[0];
    return {
      paused: String(row?.status ?? "") === "paused",
      pauseReason: nullableString(row?.pause_reason),
    };
  }

  private async createReminder(
    executor: SqlExecutor,
    item: OperationalWorkItem,
    thresholdKey: string,
    now: string,
  ): Promise<"inserted" | "duplicate" | "skipped"> {
    if (!thresholdKey) return "skipped";
    const inserted = await executor.query<Row>(
      `INSERT INTO work_item_reminders (id,work_item_id,threshold_key,policy_version,scheduled_for,created_at,synthetic)
       VALUES ($1,$2,$3,1,$4::timestamptz,$4::timestamptz,TRUE)
       ON CONFLICT (work_item_id, threshold_key, policy_version) DO NOTHING
       RETURNING *`,
      [randomUUID(), item.id, thresholdKey, now],
    );
    if (!inserted.rows[0]) return "duplicate";
    const reminderId = String(inserted.rows[0].id);
    await executor.query(
      `UPDATE operational_work_items
          SET last_reminder_at=$2, reminder_count=reminder_count+1, updated_at=$2, version=version+1
        WHERE id=$1`,
      [item.id, now],
    );
    await insertAutomationEvent(executor, {
      eventType: "work_item.reminder_created",
      aggregateType: "work_item",
      aggregateId: item.id,
      correlationId: item.correlationId,
      actorType: "system",
      actorId: null,
      payload: { thresholdKey, reference: item.reference, synthetic: true },
      occurredAt: now,
    });
    const rule = SYNTHETIC_REMINDER_RULES.find(
      (itemRule) => itemRule.thresholdKey === thresholdKey,
    );
    const channels = rule?.channels ?? ["in_app"];
    for (const channel of channels) {
      await this.enqueueNotification(executor, {
        workItem: item,
        reminderId,
        channel,
        thresholdKey,
        now,
      });
    }
    return "inserted";
  }

  private async createEscalation(
    executor: SqlExecutor,
    item: OperationalWorkItem,
    now: string,
  ): Promise<"inserted" | "duplicate" | "skipped"> {
    const next = nextEscalationLevel(
      item.escalationLevel,
      item.availableAt,
      item.dueAt,
      this.now(),
    );
    if (!next) return "skipped";
    const skipped = skippedEscalationLevels(item.escalationLevel, next);
    const rule = SYNTHETIC_ESCALATION_RULES.find((itemRule) => itemRule.level === next);
    const reason =
      skipped.length > 0
        ? `Synthetic SLA catch-up jumped to ${next} (${ESCALATION_CATCH_UP_MODE}). Lower levels ${skipped.join(", ")} were skipped and were not sent. ${WORK_CONTROL_SYNTHETIC_DISCLOSURE}`
        : `Synthetic ${next} threshold crossed. ${WORK_CONTROL_SYNTHETIC_DISCLOSURE}`;
    const inserted = await executor.query<Row>(
      `INSERT INTO work_item_escalations
       (id,work_item_id,escalation_level,reason,created_at,policy_version,owner_visible,cycle_identity)
       VALUES ($1,$2,$3,$4,$5::timestamptz,1,$6,$7)
       ON CONFLICT (work_item_id, escalation_level, cycle_identity) DO NOTHING
       RETURNING *`,
      [randomUUID(), item.id, next, reason, now, rule?.ownerVisible ?? false, item.cycleIdentity],
    );
    if (!inserted.rows[0]) return "duplicate";
    await executor.query(
      `UPDATE operational_work_items SET escalation_level=$2, updated_at=$3, version=version+1 WHERE id=$1`,
      [item.id, next, now],
    );
    const eventType =
      next === "watch"
        ? "work_item.escalation_watch"
        : next === "at_risk"
          ? "work_item.escalation_at_risk"
          : next === "breached"
            ? "work_item.escalation_breached"
            : "work_item.escalation_critical";
    await insertAutomationEvent(executor, {
      eventType,
      aggregateType: "work_item",
      aggregateId: item.id,
      correlationId: item.correlationId,
      actorType: "system",
      actorId: null,
      payload: {
        level: next,
        reference: item.reference,
        synthetic: true,
        catchUpMode: ESCALATION_CATCH_UP_MODE,
        skippedLowerLevels: [...skipped],
        skippedLevelsNotSent: true,
      },
      occurredAt: now,
    });
    await this.enqueueNotification(executor, {
      workItem: { ...item, escalationLevel: next },
      escalationId: String(inserted.rows[0].id),
      channel: "in_app",
      thresholdKey: next,
      now,
    });
    return "inserted";
  }

  private async enqueueNotification(
    executor: SqlExecutor,
    input: {
      readonly workItem: OperationalWorkItem;
      readonly reminderId?: string;
      readonly escalationId?: string;
      readonly channel: "in_app" | "email_dry_run" | "teams_dry_run";
      readonly thresholdKey: string;
      readonly now: string;
    },
  ): Promise<void> {
    const idempotencyKey = [input.workItem.id, input.channel, input.thresholdKey, "v1"].join(":");
    const suppression = notificationShouldBeSuppressed({
      workItemStatus: input.workItem.status,
      alreadyExists: false,
      slaPaused: false,
      pauseReason: null,
    });
    const status = suppression.suppressed
      ? "suppressed"
      : input.channel === "in_app"
        ? "delivered_in_app"
        : "rendered_dry_run";
    const adapterResult =
      input.channel === "email_dry_run"
        ? EMAIL_DRY_RUN_DISCLOSURE
        : input.channel === "teams_dry_run"
          ? TEAMS_DRY_RUN_DISCLOSURE
          : "IN_APP_DELIVERED";
    const subject =
      input.channel === "email_dry_run"
        ? `${EMAIL_DRY_RUN_DISCLOSURE}: ${input.workItem.reference}`
        : input.channel === "teams_dry_run"
          ? `${TEAMS_DRY_RUN_DISCLOSURE}: ${input.workItem.reference}`
          : input.workItem.title;
    const body = safeWorkNotificationBody({
      reference: input.workItem.reference,
      title: input.workItem.title,
      requiredAction: input.workItem.requiredAction,
      dueAt: input.workItem.dueAt,
      deepLink: input.workItem.deepLink,
      synthetic: true,
    });
    await executor.query(
      `INSERT INTO notification_outbox
       (id,work_item_id,reminder_id,escalation_id,channel,recipient_user_id,recipient_role_key,recipient_placeholder,
        subject,body,deep_link,status,suppression_reason,adapter_result,idempotency_key,policy_version,correlation_id,
        created_at,available_at,processed_at)
       VALUES ($1,$2,$3::uuid,$4::uuid,$5,$6::uuid,$7,$8,$9,$10,$11,$12,$13,$14,$15,1,$16,$17::timestamptz,$17::timestamptz,$17::timestamptz)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        randomUUID(),
        input.workItem.id,
        input.reminderId ?? null,
        input.escalationId ?? null,
        input.channel,
        input.workItem.assignedUserId ?? input.workItem.claimedUserId,
        input.workItem.assignedRoleKey,
        DEMO_PERSONAS[2].email,
        subject,
        body,
        input.workItem.deepLink,
        status,
        suppression.reason,
        adapterResult,
        idempotencyKey,
        input.workItem.correlationId,
        input.now,
      ],
    );
  }

  async reconcile(input: {
    readonly mode: "dry_run" | "execute";
    readonly actorUserId: string | null;
    readonly correlationId: string;
  }): Promise<ReconciliationRunResult> {
    return this.dependencies.database.transaction((transaction) =>
      this.reconcileOnExecutor(transaction, { ...input, now: this.stamp() }),
    );
  }

  private async reconcileOnExecutor(
    executor: SqlExecutor,
    input: {
      readonly mode: "dry_run" | "execute";
      readonly actorUserId: string | null;
      readonly correlationId: string;
      readonly now: string;
    },
  ): Promise<ReconciliationRunResult> {
    const details: ReconciliationDecision[] = [];
    const required = new Set<string>();
    let actualCreatedMissing = 0;
    let duplicateSuppressed = 0;
    type CycleCase = {
      readonly kind: WorkItemKind;
      readonly required: boolean;
      readonly domainComplete: boolean;
      readonly domainCancelled: boolean;
      readonly cycleIdentity: string;
      readonly context: DomainContext;
    };
    const consider = async (item: CycleCase) => {
      if (item.cycleIdentity.includes(":unknown")) {
        details.push({
          action: "noop",
          kind: item.kind,
          reason: "Exact cycle identity is incomplete; reconciliation will not guess.",
          cycleIdentity: item.cycleIdentity,
        });
        return;
      }
      if (item.required) required.add(`${item.kind}|${item.cycleIdentity}`);
      const open = await executor.query<Row>(
        `SELECT * FROM operational_work_items
          WHERE work_item_kind=$1 AND cycle_identity=$2
            AND status IN (${OPEN_WORK_STATUSES_SQL})
          LIMIT 1`,
        [item.kind, item.cycleIdentity],
      );
      const decision = decideReconciliation({
        kind: item.kind,
        required: item.required,
        domainComplete: item.domainComplete,
        domainCancelled: item.domainCancelled,
        openWorkItem: Boolean(open.rows[0]),
        cycleIdentity: item.cycleIdentity,
      });
      details.push(decision);
      if (input.mode === "dry_run" || decision.action === "noop") return;
      if (decision.action === "create_missing") {
        const event = await insertAutomationEvent(executor, {
          eventType: "work.reconciled",
          aggregateType: item.context.scheduledActionId
            ? "schedule"
            : item.context.projectionEventId
              ? "projection"
              : item.context.inspectionId
                ? "inspection"
                : item.context.jobId
                  ? "job"
                  : "work",
          aggregateId:
            item.context.scheduledActionId ??
            item.context.projectionEventId ??
            item.context.inspectionId ??
            item.context.jobId ??
            item.context.reportId ??
            randomUUID(),
          correlationId: input.correlationId,
          actorType: "system",
          actorId: input.actorUserId,
          payload: {
            kind: item.kind,
            cycleIdentity: item.cycleIdentity,
            mode: input.mode,
            inspectionId: item.context.inspectionId,
            reportId: item.context.reportId,
            reportVersionId: item.context.reportVersionId,
            requestedRevisionVersionId: item.context.requestedRevisionVersionId,
            exceptionId: item.context.exceptionId,
            submissionId: item.context.submissionId,
            deliveryId: item.context.deliveryId,
            deliveryAuthorizationId: item.context.deliveryAuthorizationId,
            jobId: item.context.jobId,
            projectionEventId: item.context.projectionEventId,
            scheduleId: item.context.scheduledActionId,
            scheduledActionId: item.context.scheduledActionId,
            failureSourceType: item.context.failureSourceType,
            failureSourceId: item.context.failureSourceId,
          },
          occurredAt: input.now,
        });
        const created = await this.createFromBlueprint(
          executor,
          blueprintForKind(item.kind),
          {
            id: event.id,
            event_type: event.eventType,
            aggregate_type: event.aggregateType,
            aggregate_id: event.aggregateId,
            correlation_id: event.correlationId,
            causation_id: event.causationId,
            occurred_at: event.occurredAt,
            payload: event.payload,
          },
          item.context,
          event.payload as JsonObject,
          "reconcile.create",
        );
        if (created.inserted) actualCreatedMissing += 1;
        else if (created.duplicateSuppressed) duplicateSuppressed += 1;
        await executor.query(
          "UPDATE automation_events SET processing_status='processed' WHERE id=$1",
          [event.id],
        );
      }
      if (
        (decision.action === "complete_stale" || decision.action === "cancel_superseded") &&
        open.rows[0]
      ) {
        const live = mapOperationalWorkItem(open.rows[0] as Row);
        await this.applyStatus(
          executor,
          live,
          decision.action === "complete_stale" ? "completed" : "cancelled",
          {
            actorUserId: input.actorUserId,
            correlationId: input.correlationId,
            causationId: null,
            completionEventType: "work.reconciled",
            now: input.now,
          },
        );
      }
    };

    const inspections = await executor.query<Row>("SELECT * FROM inspections ORDER BY created_at");
    const reports = await executor.query<Row>(
      "SELECT * FROM inspection_reports ORDER BY created_at",
    );
    const exceptions = await executor.query<Row>(
      "SELECT * FROM exception_cases WHERE status IN ('open','assigned','in_progress')",
    );
    const deadJobs = await executor.query<Row>(
      "SELECT * FROM automation_jobs WHERE status='dead_letter'",
    );
    const deadProjections = await executor.query<Row>(
      `SELECT * FROM automation_events
        WHERE processing_status='dead_lettered'
          AND event_type NOT IN ('automation.projection_dead_lettered','automation.schedule_dead_lettered')`,
    );
    const deadSchedules = await executor.query<Row>(
      `SELECT * FROM scheduled_automation_actions
        WHERE status='failed' AND attempt_count >= max_attempts`,
    );
    const pendingSupported = await executor.query<Row>(
      `SELECT id, event_type FROM automation_events
        WHERE processing_status IN ('pending','failed')`,
    );

    for (const row of inspections.rows) {
      const inspection = mapInspection(row);
      const report = reports.rows.find((item) => String(item.inspection_id) === inspection.id);
      const inspectionContext = completeDomainContext({
        inspectionId: inspection.id,
        projectId: inspection.projectId,
        inspectorUserId: inspection.inspectorUserId,
        reviewerUserId: inspection.reviewerUserId,
        reportId: report ? String(report.id) : null,
      });
      await consider({
        kind: "inspection_readiness",
        required: ["draft", "scheduled"].includes(inspection.status),
        domainComplete: !["draft", "scheduled"].includes(inspection.status),
        domainCancelled: inspection.status === "cancelled",
        cycleIdentity: buildWorkItemCycleIdentity({
          kind: "inspection_readiness",
          inspectionId: inspection.id,
        }),
        context: inspectionContext,
      });
      await consider({
        kind: "inspection_submission",
        required: inspection.status === "completed",
        domainComplete: [
          "submitted",
          "validating",
          "needs_correction",
          "validated",
          "reporting",
          "complete",
        ].includes(inspection.status),
        domainCancelled: inspection.status === "cancelled",
        cycleIdentity: buildWorkItemCycleIdentity({
          kind: "inspection_submission",
          inspectionId: inspection.id,
        }),
        context: inspectionContext,
      });
      const inspectionExceptions = exceptions.rows.filter(
        (item) => nullableString(item.inspection_id) === inspection.id,
      );
      for (const exception of inspectionExceptions) {
        const exceptionId = String(exception.id);
        await consider({
          kind: "inspection_correction",
          required: true,
          domainComplete: false,
          domainCancelled: inspection.status === "cancelled",
          cycleIdentity: buildWorkItemCycleIdentity({
            kind: "inspection_correction",
            inspectionId: inspection.id,
            exceptionId,
          }),
          context: completeDomainContext({
            ...inspectionContext,
            exceptionId,
            exceptionIds: [exceptionId],
            exceptionOwnerUserId: nullableString(exception.owner_user_id),
          }),
        });
      }
      if (report) {
        const reportStatus = String(report.status);
        const versionRow = await executor.query<Row>(
          `SELECT id FROM report_versions
            WHERE report_id=$1 AND version_number=$2
            LIMIT 1`,
          [String(report.id), Number(report.current_version_number)],
        );
        const reportVersionId = versionRow.rows[0] ? String(versionRow.rows[0].id) : null;
        const reportContext = completeDomainContext({
          ...inspectionContext,
          reportId: String(report.id),
          reportVersionId,
          requestedRevisionVersionId: reportVersionId,
        });
        await consider({
          kind: "report_technical_review",
          required: reportStatus === "in_review" || reportStatus === "draft_ready",
          domainComplete: !["awaiting_data", "assembling", "draft_ready", "in_review"].includes(
            reportStatus,
          ),
          domainCancelled: reportStatus === "cancelled" || inspection.status === "cancelled",
          cycleIdentity: buildWorkItemCycleIdentity({
            kind: "report_technical_review",
            reportId: String(report.id),
            reportVersionId,
          }),
          context: reportContext,
        });
        await consider({
          kind: "report_revision",
          required: reportStatus === "revision_required",
          domainComplete: reportStatus !== "revision_required",
          domainCancelled: reportStatus === "cancelled",
          cycleIdentity: buildWorkItemCycleIdentity({
            kind: "report_revision",
            reportId: String(report.id),
            reportVersionId,
            requestedRevisionVersionId: reportVersionId,
          }),
          context: reportContext,
        });
        const authorization = reportVersionId
          ? await executor.query<Row>(
              `SELECT id FROM delivery_authorizations
                WHERE report_id=$1 AND report_version_id=$2
                ORDER BY created_at DESC LIMIT 1`,
              [String(report.id), reportVersionId],
            )
          : { rows: [] as Row[] };
        await consider({
          kind: "report_delivery_authorization",
          required: reportStatus === "ready_for_delivery",
          domainComplete: ["delivering", "delivered", "delivery_failed"].includes(reportStatus),
          domainCancelled: reportStatus === "cancelled",
          cycleIdentity: buildWorkItemCycleIdentity({
            kind: "report_delivery_authorization",
            reportId: String(report.id),
            reportVersionId,
          }),
          context: completeDomainContext({
            ...reportContext,
            deliveryAuthorizationId: authorization.rows[0]
              ? String(authorization.rows[0].id)
              : null,
          }),
        });
        const failedDeliveries = await executor.query<Row>(
          `SELECT id, report_version_id FROM report_deliveries
            WHERE report_id=$1 AND status='failed'`,
          [String(report.id)],
        );
        for (const delivery of failedDeliveries.rows) {
          await consider({
            kind: "delivery_reconciliation",
            required: true,
            domainComplete: reportStatus === "delivered",
            domainCancelled: reportStatus === "cancelled",
            cycleIdentity: buildWorkItemCycleIdentity({
              kind: "delivery_reconciliation",
              reportId: String(report.id),
              deliveryId: String(delivery.id),
            }),
            context: completeDomainContext({
              ...reportContext,
              reportVersionId: nullableString(delivery.report_version_id) ?? reportVersionId,
              deliveryId: String(delivery.id),
            }),
          });
        }
      }
    }

    const proposals = await executor.query<Row>("SELECT * FROM proposals ORDER BY created_at");
    const leads = await executor.query<Row>("SELECT * FROM leads ORDER BY created_at");
    for (const row of proposals.rows) {
      const proposalId = String(row.id);
      const status = String(row.status);
      const leadId = String(row.lead_id);
      const versionIdRow = await executor.query<Row>(
        `SELECT id FROM proposal_versions WHERE proposal_id=$1 AND version_number=$2 LIMIT 1`,
        [proposalId, Number(row.current_version_number)],
      );
      const proposalVersionId = versionIdRow.rows[0] ? String(versionIdRow.rows[0].id) : null;
      const cycle = Number(row.information_cycle_number ?? 0);
      const proposalContext = completeDomainContext({
        proposalId,
        leadId,
        catalogVersionId: String(row.catalog_version_id),
        proposalVersionId,
        preparerUserId: nullableString(row.assigned_preparer_user_id),
        reviewerUserId: nullableString(row.assigned_reviewer_user_id),
        informationCycleNumber: cycle > 0 ? cycle : null,
      });
      await consider({
        kind: "proposal_information",
        required: status === "needs_information" && cycle > 0,
        domainComplete: status !== "needs_information",
        domainCancelled: status === "cancelled" || status === "superseded",
        cycleIdentity: buildWorkItemCycleIdentity({
          kind: "proposal_information",
          proposalId,
          informationCycleNumber: cycle > 0 ? cycle : null,
        }),
        context: proposalContext,
      });
      await consider({
        kind: "proposal_review",
        required: status === "in_review" && Boolean(proposalVersionId),
        domainComplete: status !== "in_review",
        domainCancelled: status === "cancelled" || status === "superseded",
        cycleIdentity: buildWorkItemCycleIdentity({
          kind: "proposal_review",
          proposalId,
          proposalVersionId,
        }),
        context: proposalContext,
      });
      await consider({
        kind: "proposal_revision",
        required: status === "revision_required" && Boolean(proposalVersionId),
        domainComplete: status !== "revision_required",
        domainCancelled: status === "cancelled" || status === "superseded",
        cycleIdentity: buildWorkItemCycleIdentity({
          kind: "proposal_revision",
          proposalId,
          proposalVersionId,
        }),
        context: proposalContext,
      });
      await consider({
        kind: "proposal_delivery_preparation",
        required:
          (status === "approved" || status === "ready_for_delivery") && Boolean(proposalVersionId),
        domainComplete: status === "ready_for_delivery",
        domainCancelled: status === "cancelled" || status === "superseded",
        cycleIdentity: buildWorkItemCycleIdentity({
          kind: "proposal_delivery_preparation",
          proposalId,
          proposalVersionId,
        }),
        context: proposalContext,
      });
    }
    for (const lead of leads.rows) {
      const leadId = String(lead.id);
      const leadStatus = String(lead.status);
      const hasActiveProposal = proposals.rows.some(
        (row) =>
          String(row.lead_id) === leadId &&
          String(row.status) !== "cancelled" &&
          String(row.status) !== "superseded",
      );
      await consider({
        kind: "proposal_preparation",
        required: leadStatus === "ready_for_proposal" && !hasActiveProposal,
        domainComplete: hasActiveProposal || leadStatus !== "ready_for_proposal",
        domainCancelled: leadStatus === "disqualified",
        cycleIdentity: buildWorkItemCycleIdentity({
          kind: "proposal_preparation",
          leadId,
        }),
        context: completeDomainContext({
          leadId,
          preparerUserId: nullableString(lead.reviewer_user_id),
        }),
      });
    }

    for (const job of deadJobs.rows) {
      const jobId = String(job.id);
      await consider({
        kind: "automation_failure",
        required: true,
        domainComplete: false,
        domainCancelled: false,
        cycleIdentity: buildWorkItemCycleIdentity({
          kind: "automation_failure",
          jobId,
          failureSourceType: "job",
          failureSourceId: jobId,
        }),
        context: completeDomainContext({
          jobId,
          failureSourceType: "job",
          failureSourceId: jobId,
          inspectionId:
            String(job.aggregate_type) === "inspection" ? String(job.aggregate_id) : null,
          reportId: String(job.aggregate_type) === "report" ? String(job.aggregate_id) : null,
        }),
      });
    }
    for (const event of deadProjections.rows) {
      const projectionEventId = String(event.id);
      await consider({
        kind: "automation_failure",
        required: true,
        domainComplete: false,
        domainCancelled: false,
        cycleIdentity: buildWorkItemCycleIdentity({
          kind: "automation_failure",
          projectionEventId,
          failureSourceType: "projection",
          failureSourceId: projectionEventId,
        }),
        context: completeDomainContext({
          projectionEventId,
          failureSourceType: "projection",
          failureSourceId: projectionEventId,
          inspectionId:
            String(event.aggregate_type) === "inspection" ? String(event.aggregate_id) : null,
          reportId: String(event.aggregate_type) === "report" ? String(event.aggregate_id) : null,
        }),
      });
    }
    for (const schedule of deadSchedules.rows) {
      const scheduledActionId = String(schedule.id);
      await consider({
        kind: "automation_failure",
        required: true,
        domainComplete: false,
        domainCancelled: false,
        cycleIdentity: buildWorkItemCycleIdentity({
          kind: "automation_failure",
          scheduledActionId,
          failureSourceType: "schedule",
          failureSourceId: scheduledActionId,
        }),
        context: completeDomainContext({
          scheduledActionId,
          failureSourceType: "schedule",
          failureSourceId: scheduledActionId,
        }),
      });
    }

    const openItems = await executor.query<Row>(
      `SELECT * FROM operational_work_items WHERE status IN (${OPEN_WORK_STATUSES_SQL})`,
    );
    for (const row of openItems.rows) {
      const item = mapOperationalWorkItem(row);
      if (required.has(`${item.workItemKind}|${item.cycleIdentity}`)) continue;
      const already = details.some(
        (decision) =>
          decision.kind === item.workItemKind && decision.cycleIdentity === item.cycleIdentity,
      );
      if (already) continue;
      const inspection = inspections.rows.find(
        (candidate) => String(candidate.id) === item.inspectionId,
      );
      const report = reports.rows.find((candidate) => String(candidate.id) === item.reportId);
      const cancelled =
        String(inspection?.status ?? "") === "cancelled" ||
        String(report?.status ?? "") === "cancelled";
      const superseded =
        Boolean(item.reportVersionId) &&
        Boolean(report) &&
        item.reportVersionId !==
          (
            await executor.query<Row>(
              `SELECT id FROM report_versions WHERE report_id=$1 AND version_number=$2 LIMIT 1`,
              [String(report?.id), Number(report?.current_version_number ?? 0)],
            )
          ).rows[0]?.id;
      const exceptionResolved =
        item.workItemKind === "inspection_correction" &&
        item.exceptionId &&
        !(
          await executor.query<Row>(
            `SELECT id FROM exception_cases
            WHERE id=$1 AND status IN ('open','assigned','in_progress')`,
            [item.exceptionId],
          )
        ).rows[0];
      const jobTerminal = item.jobId
        ? await executor.query<Row>("SELECT status FROM automation_jobs WHERE id=$1", [item.jobId])
        : { rows: [] as Row[] };
      const jobStatus = jobTerminal.rows[0] ? String(jobTerminal.rows[0].status) : null;
      const decision = decideReconciliation({
        kind: item.workItemKind,
        required: false,
        domainComplete: Boolean(exceptionResolved) || jobStatus === "succeeded",
        domainCancelled: cancelled || Boolean(superseded) || jobStatus === "cancelled",
        openWorkItem: true,
        cycleIdentity: item.cycleIdentity,
      });
      details.push(decision);
      if (input.mode === "dry_run" || decision.action === "noop") continue;
      if (decision.action === "complete_stale" || decision.action === "cancel_superseded") {
        await this.applyStatus(
          executor,
          item,
          decision.action === "complete_stale" ? "completed" : "cancelled",
          {
            actorUserId: input.actorUserId,
            correlationId: input.correlationId,
            causationId: null,
            completionEventType: "work.reconciled",
            now: input.now,
          },
        );
      }
    }

    for (const pending of pendingSupported.rows) {
      if (!RELEVANT_EVENT_TYPES.has(String(pending.event_type))) continue;
      details.push({
        action: "noop",
        kind: "automation_failure",
        reason: `Supported event ${String(pending.event_type)} ${String(pending.id)} is pending or retryable and has not been ignored.`,
        cycleIdentity: `event:${String(pending.id)}`,
      });
    }

    const plannedCreatedMissing = details.filter((item) => item.action === "create_missing").length;
    const completedStale = details.filter((item) => item.action === "complete_stale").length;
    const cancelledSuperseded = details.filter(
      (item) => item.action === "cancel_superseded",
    ).length;
    const unchanged = details.filter((item) => item.action === "noop").length;
    const createdMissing = input.mode === "execute" ? actualCreatedMissing : plannedCreatedMissing;
    const runId = randomUUID();
    if (input.mode === "execute") {
      await executor.query(
        `INSERT INTO reconciliation_runs
         (id,mode,status,actor_user_id,created_missing,completed_stale,cancelled_superseded,unchanged,details,correlation_id,started_at,finished_at)
         VALUES ($1,$2,'succeeded',$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$10)`,
        [
          runId,
          input.mode,
          input.actorUserId,
          createdMissing,
          completedStale,
          cancelledSuperseded,
          unchanged,
          JSON.stringify(details),
          input.correlationId,
          input.now,
        ],
      );
    }
    return {
      id: runId,
      mode: input.mode,
      createdMissing,
      plannedCreatedMissing,
      actualCreatedMissing: input.mode === "execute" ? actualCreatedMissing : 0,
      duplicateSuppressed: input.mode === "execute" ? duplicateSuppressed : 0,
      completedStale,
      cancelledSuperseded,
      unchanged,
      details,
    };
  }

  async metrics(
    now = this.now(),
    options: { readonly kinds?: readonly string[] } = {},
  ): Promise<WorkMetricsSnapshot> {
    const items = (await this.repository.listWorkItems({ limit: 500 })).filter((item) =>
      options.kinds ? options.kinds.includes(item.workItemKind) : true,
    );
    const open = items.filter((item) => isOpenWorkItemStatus(item.status));
    const ages = open.map((item) => Math.max(0, now.getTime() - Date.parse(item.availableAt)));
    const dueSoon = open.filter((item) =>
      workItemIsAtRisk(item.dueAt, item.availableAt, now),
    ).length;
    const overdue = open.filter((item) => workItemIsOverdue(item.dueAt, now)).length;
    const openCountByKind: Record<string, number> = {};
    const humanWaitingMsByKind: Record<string, number> = {};
    const openByRoleCount: Record<string, number> = {};
    const openByAssigneeCount: Record<string, number> = {};
    const reportDelayCountByBucket = emptyDelayBuckets();
    const reportDelayMsByBucket = emptyDelayBuckets();
    const bucketFor = (kind: string): string | null => {
      if (kind === "inspection_submission") return "awaiting_submission";
      if (kind === "inspection_correction") return "correction";
      if (kind === "report_technical_review") return "technical_review";
      if (kind === "report_delivery_authorization") return "delivery_authorization";
      if (kind === "delivery_reconciliation") return "delivery_failure";
      return null;
    };
    for (const item of open) {
      const ageMs = Math.max(0, now.getTime() - Date.parse(item.availableAt));
      openCountByKind[item.workItemKind] = (openCountByKind[item.workItemKind] ?? 0) + 1;
      humanWaitingMsByKind[item.workItemKind] =
        (humanWaitingMsByKind[item.workItemKind] ?? 0) + ageMs;
      const role = item.assignedRoleKey ?? "unassigned";
      openByRoleCount[role] = (openByRoleCount[role] ?? 0) + 1;
      const assignee = item.assignedUserId ?? item.claimedUserId ?? "unassigned";
      openByAssigneeCount[assignee] = (openByAssigneeCount[assignee] ?? 0) + 1;
      const bucket = bucketFor(item.workItemKind);
      if (bucket) {
        reportDelayCountByBucket[bucket] = (reportDelayCountByBucket[bucket] ?? 0) + 1;
        reportDelayMsByBucket[bucket] = (reportDelayMsByBucket[bucket] ?? 0) + ageMs;
      }
    }
    const ack = items
      .filter((item) => item.acknowledgedAt)
      .map((item) => Date.parse(item.acknowledgedAt!) - Date.parse(item.availableAt));
    const begin = items
      .filter((item) => item.startedAt)
      .map((item) => Date.parse(item.startedAt!) - Date.parse(item.availableAt));
    const complete = items
      .filter((item) => item.completedAt)
      .map((item) => Date.parse(item.completedAt!) - Date.parse(item.availableAt));
    return {
      synthetic: true,
      disclosure: WORK_CONTROL_SYNTHETIC_DISCLOSURE,
      open: open.length,
      dueSoon,
      overdue,
      blocked: open.filter((item) => item.status === "blocked").length,
      escalated: open.filter((item) => item.escalationLevel !== "none").length,
      unassigned: open.filter((item) => !item.assignedUserId && !item.claimedUserId).length,
      averageAgeMs: average(ages),
      p50AgeMs: percentile(ages, 0.5),
      p90AgeMs: percentile(ages, 0.9),
      timeToAcknowledgeMs: average(ack),
      timeToBeginMs: average(begin),
      timeToCompleteMs: average(complete),
      openCountByKind,
      humanWaitingMsByKind,
      openByRoleCount,
      openByAssigneeCount,
      reportDelayCountByBucket,
      reportDelayMsByBucket,
    };
  }

  triggerProvisioningPlan() {
    return buildExternalTriggerProvisioningPlan();
  }

  inspectPolicy(): WorkPolicyPreview {
    return {
      action: "inspect-policy",
      durableTransitionOccurred: false,
      codeDefinedSyntheticRoutingActive: true,
      productionPolicyUnconfigured: true,
      productionActivationBlocked: true,
      executorSource: WORK_CONTROL_CODE_DEFINED_POLICY,
      disclosure: WORK_CONTROL_SYNTHETIC_DISCLOSURE,
      productionDisclosure: WORK_CONTROL_PRODUCTION_UNCONFIGURED,
    };
  }

  validatePolicyPreview(): WorkPolicyPreview {
    return { ...this.inspectPolicy(), action: "validate-policy-preview" };
  }

  activationReadinessPreview(): WorkPolicyPreview {
    return { ...this.inspectPolicy(), action: "activation-readiness-preview" };
  }

  async retryAutomationJob(jobId: string, actor: WorkActor): Promise<void> {
    const now = this.stamp();
    await this.dependencies.database.transaction(async (transaction) => {
      const updated = await transaction.query<Row>(
        `UPDATE automation_jobs
            SET status='pending',
                claimed_at=NULL,
                claimed_by=NULL,
                lease_expires_at=NULL,
                available_at=$2,
                finished_at=NULL,
                updated_at=$2,
                version=version+1
          WHERE id=$1 AND status='dead_letter'
          RETURNING *`,
        [jobId, now],
      );
      if (!updated.rows[0]) {
        throw new WorkItemClaimError("Dead-letter job was not found.");
      }
      await insertAutomationEvent(transaction, {
        eventType: "automation.job_retry_requested",
        aggregateType: "job",
        aggregateId: jobId,
        correlationId: actor.correlationId,
        actorType: "user",
        actorId: actor.userId,
        payload: { jobId, jobType: String(updated.rows[0].job_type) },
        occurredAt: now,
      });
      await insertAutomationEvent(transaction, {
        eventType: "automation.job_requeued",
        aggregateType: "job",
        aggregateId: jobId,
        correlationId: actor.correlationId,
        actorType: "user",
        actorId: actor.userId,
        payload: { jobId, jobType: String(updated.rows[0].job_type) },
        occurredAt: now,
      });
    });
    await this.processPendingEvents();
  }

  async cancelAutomationJob(jobId: string, actor: WorkActor): Promise<void> {
    const now = this.stamp();
    await this.dependencies.database.transaction(async (transaction) => {
      const updated = await transaction.query<Row>(
        `UPDATE automation_jobs
            SET status='cancelled', finished_at=$2, updated_at=$2, version=version+1
          WHERE id=$1 AND status='dead_letter'
          RETURNING *`,
        [jobId, now],
      );
      if (!updated.rows[0]) {
        throw new WorkItemClaimError("Dead-letter job was not found.");
      }
      await insertAutomationEvent(transaction, {
        eventType: "automation.job_cancelled",
        aggregateType: "job",
        aggregateId: jobId,
        correlationId: actor.correlationId,
        actorType: "user",
        actorId: actor.userId,
        payload: { jobId, jobType: String(updated.rows[0].job_type) },
        occurredAt: now,
      });
    });
    await this.processPendingEvents();
  }

  async driveStartup(): Promise<void> {
    await this.processPendingEvents();
    await this.evaluateDueSchedules();
    await this.reconcile({
      mode: "execute",
      actorUserId: null,
      correlationId: "work-control-startup",
    });
  }

  async drivePoll(claimOwner: string): Promise<void> {
    void claimOwner;
    await this.processPendingEvents();
    await this.evaluateDueSchedules();
  }

  productionPolicyDisclosure(): string {
    return `${WORK_CONTROL_PRODUCTION_UNCONFIGURED} Payload: ${JSON.stringify(PRODUCTION_ORCHESTRATION_POLICY_PAYLOAD)}`;
  }
}

export function emptyTurnaroundWorkProjection() {
  return {
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
    systemProcessingMs: 0,
  };
}

export { WORK_ITEM_KIND_LABELS, SEEDED_WORK_CONTROL_IDS };
