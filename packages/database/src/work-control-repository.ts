import type {
  JsonObject,
  NotificationOutboxRecord,
  OperationalWorkItem,
  OrchestrationPolicyVersion,
  ReconciliationDecision,
  ScheduledAutomationAction,
  WorkItemEscalation,
  WorkItemKind,
  WorkItemQueueKey,
  WorkItemReminder,
  WorkItemStatus,
  WorkRoutingBlueprint,
} from "@bea/domain";
import type { DatabaseAdapter } from "./adapter.js";
import { iso, jsonValue, nullableIso, nullableString } from "./operations-repository.js";

type Row = Record<string, unknown>;

function bool(value: unknown): boolean {
  return value === true || value === "t" || value === 1 || value === "1";
}

export function mapOperationalWorkItem(row: Row): OperationalWorkItem {
  return {
    id: String(row.id),
    reference: String(row.reference),
    workItemKind: row.work_item_kind as WorkItemKind,
    status: row.status as WorkItemStatus,
    priority: row.priority as OperationalWorkItem["priority"],
    queueKey: row.queue_key as WorkItemQueueKey,
    assignedRoleKey: nullableString(row.assigned_role_key),
    assignedUserId: nullableString(row.assigned_user_id),
    claimedUserId: nullableString(row.claimed_user_id),
    claimedAt: nullableIso(row.claimed_at),
    projectId: nullableString(row.project_id),
    inspectionId: nullableString(row.inspection_id),
    submissionId: nullableString(row.submission_id),
    reportId: nullableString(row.report_id),
    reportVersionId: nullableString(row.report_version_id),
    exceptionId: nullableString(row.exception_id),
    deliveryAuthorizationId: nullableString(row.delivery_authorization_id),
    deliveryId: nullableString(row.delivery_id),
    jobId: nullableString(row.job_id),
    scheduledActionId: nullableString(row.scheduled_action_id),
    failureSourceType: nullableString(row.failure_source_type) as
      OperationalWorkItem["failureSourceType"] | null,
    failureSourceId: nullableString(row.failure_source_id),
    requestedRevisionVersionId: nullableString(row.requested_revision_version_id),
    leadId: nullableString(row.lead_id),
    proposalId: nullableString(row.proposal_id),
    proposalVersionId: nullableString(row.proposal_version_id),
    catalogVersionId: nullableString(row.catalog_version_id),
    pricingOverrideId: nullableString(row.pricing_override_id),
    sourceEventId: nullableString(row.source_event_id),
    sourceAggregateType: String(row.source_aggregate_type),
    sourceAggregateId: String(row.source_aggregate_id),
    policyKey: String(row.policy_key),
    policyVersion: Number(row.policy_version),
    configurationReleaseId: nullableString(row.configuration_release_id),
    idempotencyKey: String(row.idempotency_key),
    cycleIdentity: String(row.cycle_identity),
    title: String(row.title),
    reason: String(row.reason),
    requiredAction: String(row.required_action),
    deepLink: String(row.deep_link),
    availableAt: iso(row.available_at),
    dueAt: nullableIso(row.due_at),
    acknowledgedAt: nullableIso(row.acknowledged_at),
    startedAt: nullableIso(row.started_at),
    blockedAt: nullableIso(row.blocked_at),
    completedAt: nullableIso(row.completed_at),
    cancelledAt: nullableIso(row.cancelled_at),
    blockedReason: nullableString(row.blocked_reason),
    completionEventType: nullableString(row.completion_event_type),
    completionEventId: nullableString(row.completion_event_id),
    escalationLevel: row.escalation_level as OperationalWorkItem["escalationLevel"],
    lastReminderAt: nullableIso(row.last_reminder_at),
    reminderCount: Number(row.reminder_count ?? 0),
    synthetic: bool(row.synthetic),
    correlationId: String(row.correlation_id),
    causationId: nullableString(row.causation_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

export function mapWorkReminder(row: Row): WorkItemReminder {
  return {
    id: String(row.id),
    workItemId: String(row.work_item_id),
    thresholdKey: String(row.threshold_key),
    policyVersion: Number(row.policy_version),
    scheduledFor: iso(row.scheduled_for),
    createdAt: iso(row.created_at),
    synthetic: bool(row.synthetic),
  };
}

export function mapWorkEscalation(row: Row): WorkItemEscalation {
  return {
    id: String(row.id),
    workItemId: String(row.work_item_id),
    escalationLevel: row.escalation_level as WorkItemEscalation["escalationLevel"],
    reason: String(row.reason),
    createdAt: iso(row.created_at),
    resolvedAt: nullableIso(row.resolved_at),
    policyVersion: Number(row.policy_version),
    ownerVisible: bool(row.owner_visible),
  };
}

export function mapNotificationOutbox(row: Row): NotificationOutboxRecord {
  return {
    id: String(row.id),
    workItemId: nullableString(row.work_item_id),
    reminderId: nullableString(row.reminder_id),
    escalationId: nullableString(row.escalation_id),
    channel: row.channel as NotificationOutboxRecord["channel"],
    recipientUserId: nullableString(row.recipient_user_id),
    recipientRoleKey: nullableString(row.recipient_role_key),
    recipientPlaceholder: String(row.recipient_placeholder),
    subject: String(row.subject),
    body: String(row.body),
    deepLink: String(row.deep_link),
    status: row.status as NotificationOutboxRecord["status"],
    suppressionReason: nullableString(row.suppression_reason),
    adapterResult: nullableString(row.adapter_result),
    idempotencyKey: String(row.idempotency_key),
    policyVersion: Number(row.policy_version),
    correlationId: String(row.correlation_id),
    createdAt: iso(row.created_at),
    availableAt: iso(row.available_at),
    processedAt: nullableIso(row.processed_at),
  };
}

export function mapScheduledAction(row: Row): ScheduledAutomationAction {
  return {
    id: String(row.id),
    scheduleKey: String(row.schedule_key),
    policyVersion: Number(row.policy_version),
    actionType: row.action_type as ScheduledAutomationAction["actionType"],
    workItemId: nullableString(row.work_item_id),
    aggregateType: nullableString(row.aggregate_type),
    aggregateId: nullableString(row.aggregate_id),
    scheduledFor: iso(row.scheduled_for),
    lastEvaluatedAt: nullableIso(row.last_evaluated_at),
    nextRunAt: nullableIso(row.next_run_at),
    status: row.status as ScheduledAutomationAction["status"],
    idempotencyKey: String(row.idempotency_key),
    correlationId: String(row.correlation_id),
    attemptCount: Number(row.attempt_count ?? 0),
    maxAttempts: Number(row.max_attempts ?? 5),
    lastResult: nullableString(row.last_result),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function mapOrchestrationPolicy(row: Row): OrchestrationPolicyVersion {
  return {
    id: String(row.id),
    policyKey: String(row.policy_key),
    policyVersion: Number(row.policy_version),
    status: row.status as OrchestrationPolicyVersion["status"],
    synthetic: bool(row.synthetic),
    productionReady: bool(row.production_ready),
    serviceContextKey: String(row.service_context_key),
    disclosure: String(row.disclosure),
    payload: jsonValue(row.payload, {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function mapWorkBlueprint(row: Row): WorkRoutingBlueprint {
  return {
    blueprintKey: String(row.blueprint_key),
    blueprintVersion: Number(row.blueprint_version),
    triggerEventTypes: jsonValue(row.trigger_event_types, []),
    workItemKind: row.work_item_kind as WorkItemKind,
    queueKey: row.queue_key as WorkItemQueueKey,
    assignmentStrategy: row.assignment_strategy as WorkRoutingBlueprint["assignmentStrategy"],
    assignedRoleKey: row.assigned_role_key as WorkRoutingBlueprint["assignedRoleKey"],
    dueOffsetMs: Number(row.due_offset_ms),
    priority: row.priority as WorkRoutingBlueprint["priority"],
    completionEventTypes: jsonValue(row.completion_event_types, []),
    cancellationEventTypes: jsonValue(row.cancellation_event_types, []),
    title: String(row.title),
    requiredAction: String(row.required_action),
    deepLinkTemplate: String(row.deep_link_template),
    synthetic: true,
    triggerStatus: row.trigger_status as WorkRoutingBlueprint["triggerStatus"],
  };
}

export class SqlWorkControlRepository {
  constructor(private readonly database: DatabaseAdapter) {}

  async getWorkItem(id: string): Promise<OperationalWorkItem | null> {
    const result = await this.database.query<Row>(
      "SELECT * FROM operational_work_items WHERE id=$1",
      [id],
    );
    return result.rows[0] ? mapOperationalWorkItem(result.rows[0]) : null;
  }

  async listWorkItems(
    filter: {
      readonly statuses?: readonly WorkItemStatus[];
      readonly kinds?: readonly WorkItemKind[];
      readonly assignedUserId?: string;
      readonly claimedUserId?: string;
      readonly queueKey?: string;
      readonly assignedRoleKey?: string;
      readonly inspectionId?: string;
      readonly proposalId?: string;
      readonly leadId?: string;
      readonly limit?: number;
    } = {},
  ): Promise<readonly OperationalWorkItem[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      clauses.push(sql.replace("?", `$${params.length}`));
    };
    if (filter.statuses && filter.statuses.length > 0) {
      const placeholders = filter.statuses.map((status) => {
        params.push(status);
        return `$${params.length}`;
      });
      clauses.push(`status IN (${placeholders.join(",")})`);
    }
    if (filter.kinds && filter.kinds.length > 0) {
      const placeholders = filter.kinds.map((kind) => {
        params.push(kind);
        return `$${params.length}`;
      });
      clauses.push(`work_item_kind IN (${placeholders.join(",")})`);
    }
    if (filter.assignedUserId) add("assigned_user_id=?", filter.assignedUserId);
    if (filter.claimedUserId) add("claimed_user_id=?", filter.claimedUserId);
    if (filter.queueKey) add("queue_key=?", filter.queueKey);
    if (filter.assignedRoleKey) add("assigned_role_key=?", filter.assignedRoleKey);
    if (filter.inspectionId) add("inspection_id=?", filter.inspectionId);
    if (filter.proposalId) add("proposal_id=?", filter.proposalId);
    if (filter.leadId) add("lead_id=?", filter.leadId);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filter.limit ?? 200;
    params.push(limit);
    const result = await this.database.query<Row>(
      `SELECT * FROM operational_work_items ${where} ORDER BY due_at NULLS LAST, created_at LIMIT $${params.length}`,
      params,
    );
    return result.rows.map(mapOperationalWorkItem);
  }

  async listOpenForInspection(inspectionId: string): Promise<readonly OperationalWorkItem[]> {
    const result = await this.database.query<Row>(
      `SELECT * FROM operational_work_items
        WHERE inspection_id=$1 AND status IN ('open','acknowledged','in_progress','blocked')
        ORDER BY created_at`,
      [inspectionId],
    );
    return result.rows.map(mapOperationalWorkItem);
  }

  async findOpenByCycle(
    kind: WorkItemKind,
    cycleIdentity: string,
  ): Promise<OperationalWorkItem | null> {
    const result = await this.database.query<Row>(
      `SELECT * FROM operational_work_items
        WHERE work_item_kind=$1 AND cycle_identity=$2
          AND status IN ('open','acknowledged','in_progress','blocked')
        LIMIT 1`,
      [kind, cycleIdentity],
    );
    return result.rows[0] ? mapOperationalWorkItem(result.rows[0]) : null;
  }

  async findAnyByCycle(
    kind: WorkItemKind,
    cycleIdentity: string,
  ): Promise<OperationalWorkItem | null> {
    const result = await this.database.query<Row>(
      `SELECT * FROM operational_work_items
        WHERE work_item_kind=$1 AND cycle_identity=$2
        ORDER BY created_at DESC
        LIMIT 1`,
      [kind, cycleIdentity],
    );
    return result.rows[0] ? mapOperationalWorkItem(result.rows[0]) : null;
  }

  async listReminders(workItemId?: string): Promise<readonly WorkItemReminder[]> {
    const result = workItemId
      ? await this.database.query<Row>(
          "SELECT * FROM work_item_reminders WHERE work_item_id=$1 ORDER BY created_at",
          [workItemId],
        )
      : await this.database.query<Row>(
          "SELECT * FROM work_item_reminders ORDER BY created_at DESC LIMIT 100",
        );
    return result.rows.map(mapWorkReminder);
  }

  async listEscalations(workItemId?: string): Promise<readonly WorkItemEscalation[]> {
    const result = workItemId
      ? await this.database.query<Row>(
          "SELECT * FROM work_item_escalations WHERE work_item_id=$1 ORDER BY created_at",
          [workItemId],
        )
      : await this.database.query<Row>(
          "SELECT * FROM work_item_escalations ORDER BY created_at DESC LIMIT 100",
        );
    return result.rows.map(mapWorkEscalation);
  }

  async listNotifications(): Promise<readonly NotificationOutboxRecord[]> {
    const result = await this.database.query<Row>(
      "SELECT * FROM notification_outbox ORDER BY created_at DESC LIMIT 200",
    );
    return result.rows.map(mapNotificationOutbox);
  }

  async listSchedules(): Promise<readonly ScheduledAutomationAction[]> {
    const result = await this.database.query<Row>(
      "SELECT * FROM scheduled_automation_actions ORDER BY scheduled_for",
    );
    return result.rows.map(mapScheduledAction);
  }

  async listPolicies(): Promise<readonly OrchestrationPolicyVersion[]> {
    const result = await this.database.query<Row>(
      "SELECT * FROM orchestration_policy_versions ORDER BY policy_key, policy_version DESC",
    );
    return result.rows.map(mapOrchestrationPolicy);
  }

  async listBlueprints(): Promise<readonly WorkRoutingBlueprint[]> {
    const result = await this.database.query<Row>(
      "SELECT * FROM work_routing_blueprints ORDER BY blueprint_key",
    );
    return result.rows.map(mapWorkBlueprint);
  }

  async listAssignments(workItemId: string): Promise<readonly JsonObject[]> {
    const result = await this.database.query<Row>(
      `SELECT * FROM work_item_assignments WHERE work_item_id=$1 ORDER BY created_at`,
      [workItemId],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      action: String(row.action),
      assignedUserId: nullableString(row.assigned_user_id),
      assignedRoleKey: nullableString(row.assigned_role_key),
      claimedUserId: nullableString(row.claimed_user_id),
      actorUserId: nullableString(row.actor_user_id),
      reason: nullableString(row.reason),
      createdAt: iso(row.created_at),
    }));
  }

  async listWorkItemEvents(workItemId: string): Promise<readonly JsonObject[]> {
    const result = await this.database.query<Row>(
      `SELECT * FROM work_item_events WHERE work_item_id=$1 ORDER BY created_at`,
      [workItemId],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      eventType: String(row.event_type),
      fromStatus: nullableString(row.from_status),
      toStatus: nullableString(row.to_status),
      actorUserId: nullableString(row.actor_user_id),
      payload: jsonValue(row.payload, {}),
      createdAt: iso(row.created_at),
    }));
  }

  async listReconciliationRuns(): Promise<readonly JsonObject[]> {
    const result = await this.database.query<Row>(
      "SELECT * FROM reconciliation_runs ORDER BY started_at DESC LIMIT 50",
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      mode: String(row.mode),
      status: String(row.status),
      createdMissing: Number(row.created_missing),
      completedStale: Number(row.completed_stale),
      cancelledSuperseded: Number(row.cancelled_superseded),
      unchanged: Number(row.unchanged),
      details: jsonValue(row.details, []),
      startedAt: iso(row.started_at),
      finishedAt: nullableIso(row.finished_at),
    }));
  }

  async listProjectionFailures(): Promise<readonly JsonObject[]> {
    const result = await this.database.query<Row>(
      `SELECT f.*, e.processing_status, e.projection_next_retry_at, e.projection_attempt_count,
              e.projection_retryable, e.projection_dead_lettered_at
         FROM event_projection_failures f
         JOIN automation_events e ON e.id=f.source_event_id
        ORDER BY f.created_at DESC
        LIMIT 200`,
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      sourceEventId: String(row.source_event_id),
      eventType: String(row.event_type),
      aggregateType: String(row.aggregate_type),
      aggregateId: String(row.aggregate_id),
      correlationId: String(row.correlation_id),
      attemptNumber: Number(row.attempt_number),
      errorCode: String(row.error_code),
      errorMessage: String(row.error_message),
      retryable: bool(row.retryable),
      terminal: bool(row.terminal),
      processingStatus: String(row.processing_status),
      nextRetryAt: nullableIso(row.projection_next_retry_at),
      attemptCount: Number(row.projection_attempt_count ?? 0),
      createdAt: iso(row.created_at),
    }));
  }

  async listCurrentWorkByInspection(): Promise<ReadonlyMap<string, OperationalWorkItem>> {
    const result = await this.database.query<Row>(
      `SELECT DISTINCT ON (inspection_id) *
         FROM operational_work_items
        WHERE inspection_id IS NOT NULL
          AND status IN ('open','acknowledged','in_progress','blocked')
        ORDER BY inspection_id, due_at NULLS LAST, created_at`,
    );
    const map = new Map<string, OperationalWorkItem>();
    for (const row of result.rows) {
      const item = mapOperationalWorkItem(row);
      if (item.inspectionId) map.set(item.inspectionId, item);
    }
    return map;
  }
}

export type WorkReconciliationPlan = readonly ReconciliationDecision[];
