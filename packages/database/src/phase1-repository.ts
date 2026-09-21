import { randomUUID } from "node:crypto";
import type {
  ActionApproval,
  ActionExecution,
  Activity,
  AssistantMessage,
  Company,
  CompanyStatus,
  Contact,
  ContactStatus,
  Conversation,
  JsonObject,
  Notification,
  Phase1SearchResult,
  SuggestedAction,
  Task,
  TaskPriority,
  TaskStatus,
  WorkspaceArtifact,
  WorkspaceArtifactLink,
  WorkspaceArtifactSource,
  WorkspaceArtifactState,
  WorkspaceArtifactType,
  WorkflowRun,
  WorkflowStatus,
  WorkflowStepRun,
} from "@bea/domain";
import type { DatabaseAdapter, SqlExecutor } from "./adapter.js";

type Row = Record<string, unknown>;

const TASK_PRIORITIES = new Set<TaskPriority>(["low", "normal", "high", "urgent"]);
const SEARCH_RESULT_TYPES = new Set<Phase1SearchResult["type"]>([
  "company",
  "contact",
  "integration",
  "task",
  "workflow-run",
  "lead",
]);

const AI_COMMAND_REQUEST_RESERVATION_ROUTER_VERSION = "phase1-ai-request-reservation-v1";
const AI_COMMAND_REQUEST_SUPERSEDED_ROUTER_VERSION = "phase1-ai-request-superseded-v1";

export const TASK_ACTION_CONFIRMATION = "CONFIRM_TASK_CREATE" as const;
const PERMISSION_REVALIDATION_MAX_AGE_MS = 5 * 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function json<T>(value: unknown, fallback: T): T {
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

function clampLimit(value: number | undefined, fallback = 50, maximum = 100): number {
  return Math.max(1, Math.min(maximum, Math.trunc(value ?? fallback)));
}

function requiredText(value: string, name: string, maximum = 240): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new Phase1ValidationError(`${name} must contain between 1 and ${maximum} characters.`);
  }
  return normalized;
}

function requiredUuid(value: string, name: string): string {
  const normalized = requiredText(value, name, 36);
  if (!UUID_PATTERN.test(normalized)) {
    throw new Phase1ValidationError(`${name} must be a canonical UUID.`);
  }
  return normalized.toLocaleLowerCase("en-US");
}

function requiredAiCommandGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Phase1ValidationError("AI Command request generation is invalid.");
  }
  return value;
}

function aiCommandReservationContent(generation: number): string {
  return JSON.stringify({ kind: "ai-command-request-reservation", generation });
}

function aiCommandReservationGeneration(row: Row): number | null {
  const content = json<{ readonly kind?: unknown; readonly generation?: unknown }>(row.content, {});
  return content.kind === "ai-command-request-reservation" &&
    typeof content.generation === "number" &&
    Number.isSafeInteger(content.generation) &&
    content.generation >= 1
    ? content.generation
    : null;
}

function optionalText(value: string | null | undefined, maximum = 4_000): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  if (normalized.length > maximum) {
    throw new Phase1ValidationError(`Text must not exceed ${maximum} characters.`);
  }
  return normalized || null;
}

function optionalIso(value: string | null | undefined, name: string): string | null {
  if (value === null || value === undefined) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds))
    throw new Phase1ValidationError(`${name} must be an ISO time.`);
  return new Date(milliseconds).toISOString();
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, "\\$&");
}

function mapCompany(row: Row): Company {
  return {
    id: String(row.id),
    name: String(row.name),
    industry: nullableString(row.industry),
    status: row.status as CompanyStatus,
    website: nullableString(row.website),
    phone: nullableString(row.phone),
    notes: nullableString(row.notes),
    createdByUserId: nullableString(row.created_by_user_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

function mapContact(row: Row): Contact {
  return {
    id: String(row.id),
    companyId: nullableString(row.company_id),
    firstName: String(row.first_name),
    lastName: String(row.last_name),
    jobTitle: nullableString(row.job_title),
    email: nullableString(row.email),
    phone: nullableString(row.phone),
    status: row.status as ContactStatus,
    notes: nullableString(row.notes),
    createdByUserId: nullableString(row.created_by_user_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

function mapTask(row: Row): Task {
  return {
    id: String(row.id),
    title: String(row.title),
    description: nullableString(row.description),
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    assigneeUserId: String(row.assignee_user_id),
    dueAt: nullableIso(row.due_at),
    completedAt: nullableIso(row.completed_at),
    companyId: nullableString(row.company_id),
    contactId: nullableString(row.contact_id),
    leadId: nullableString(row.lead_id),
    createdByUserId: String(row.created_by_user_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

function mapActivity(row: Row): Activity {
  return {
    id: String(row.id),
    type: row.type as Activity["type"],
    summary: String(row.summary),
    actorUserId: nullableString(row.actor_user_id),
    companyId: nullableString(row.company_id),
    contactId: nullableString(row.contact_id),
    taskId: nullableString(row.task_id),
    leadId: nullableString(row.lead_id),
    correlationId: nullableString(row.correlation_id),
    metadata: json(row.metadata, {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

function mapNotification(row: Row): Notification {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    type: String(row.type),
    title: String(row.title),
    body: String(row.body),
    sourceType: nullableString(row.source_type),
    sourceId: nullableString(row.source_id),
    sourceHref: nullableString(row.source_href),
    readAt: nullableIso(row.read_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

function mapConversation(row: Row): Conversation {
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    title: String(row.title),
    provider: row.provider as Conversation["provider"],
    model: row.model as Conversation["model"],
    routerVersion: String(row.router_version),
    status: row.status as Conversation["status"],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

function mapAssistantMessage(row: Row): AssistantMessage {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    role: row.role as AssistantMessage["role"],
    content: String(row.content),
    provider: row.provider as AssistantMessage["provider"],
    model: row.model as AssistantMessage["model"],
    providerResponseId: nullableString(row.provider_response_id),
    responseStatus:
      (row.response_status as NonNullable<AssistantMessage["responseStatus"]> | undefined) ??
      "completed",
    incompleteReason: nullableString(row.incomplete_reason),
    routerVersion: nullableString(row.router_version),
    executionMs:
      row.execution_ms === null || row.execution_ms === undefined ? null : Number(row.execution_ms),
    correlationId: String(row.correlation_id),
    requiredPermissions: json<readonly string[]>(row.required_permissions, []),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

function mapWorkspaceArtifact(row: Row): WorkspaceArtifact {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    requestedByUserId: String(row.requested_by_user_id),
    type: row.type as WorkspaceArtifactType,
    title: String(row.title),
    subtitle: nullableString(row.subtitle),
    state: row.state as WorkspaceArtifactState,
    payload: json(row.payload, {}),
    sources: json<readonly WorkspaceArtifactSource[]>(row.sources, []),
    links: json<readonly WorkspaceArtifactLink[]>(row.links, []),
    requiredPermissions: json<readonly string[]>(row.required_permissions, []),
    errorCode: nullableString(row.error_code),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

function mapSuggestedAction(row: Row): SuggestedAction {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    requestedByUserId: String(row.requested_by_user_id),
    actionType: row.action_type as SuggestedAction["actionType"],
    status: row.status as SuggestedAction["status"],
    payload: json(row.payload, {}),
    requiredPermission: String(row.required_permission),
    idempotencyKey: String(row.idempotency_key),
    correlationId: String(row.correlation_id),
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

function mapActionApproval(row: Row): ActionApproval {
  return {
    id: String(row.id),
    suggestedActionId: String(row.suggested_action_id),
    actorUserId: String(row.actor_user_id),
    decision: row.decision as ActionApproval["decision"],
    correlationId: String(row.correlation_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

function mapActionExecution(row: Row): ActionExecution {
  return {
    id: String(row.id),
    suggestedActionId: String(row.suggested_action_id),
    actorUserId: String(row.actor_user_id),
    status: row.status as ActionExecution["status"],
    idempotencyKey: String(row.idempotency_key),
    result: json(row.result, {}),
    errorCode: nullableString(row.error_code),
    correlationId: String(row.correlation_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

function mapWorkflowRun(row: Row): WorkflowRun {
  return {
    id: String(row.id),
    workflowKey: String(row.workflow_key),
    status: row.status as WorkflowStatus,
    triggerMetadata: json(row.trigger_metadata, {}),
    correlationId: String(row.correlation_id),
    idempotencyKey: String(row.idempotency_key),
    startedAt: iso(row.started_at),
    finishedAt: nullableIso(row.finished_at),
    error: row.error ? json(row.error, null) : null,
    retryCount: Number(row.retry_count),
    cancellationRequested: Boolean(row.cancellation_requested),
    createdByUserId: nullableString(row.created_by_user_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

function mapWorkflowStep(row: Row): WorkflowStepRun {
  return {
    id: String(row.id),
    workflowRunId: String(row.workflow_run_id),
    stepKey: String(row.step_key),
    sequence: Number(row.sequence),
    status: row.status as WorkflowStatus,
    startedAt: iso(row.started_at),
    finishedAt: nullableIso(row.finished_at),
    result: row.result_json ? json(row.result_json, null) : null,
    error: row.error ? json(row.error, null) : null,
    retryCount: Number(row.retry_count),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

export class Phase1RepositoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "Phase1RepositoryError";
  }
}

export class Phase1ValidationError extends Phase1RepositoryError {
  constructor(message: string) {
    super("PHASE1_VALIDATION_FAILED", message);
    this.name = "Phase1ValidationError";
  }
}

export type TaskRelationshipField = "companyId" | "contactId";

export class TaskRelationshipValidationError extends Phase1RepositoryError {
  constructor(
    readonly field: TaskRelationshipField,
    code: "PHASE1_TASK_COMPANY_INVALID" | "PHASE1_TASK_CONTACT_COMPANY_MISMATCH",
    message: string,
  ) {
    super(code, message);
    this.name = "TaskRelationshipValidationError";
  }
}

export class Phase1RecordNotFoundError extends Phase1RepositoryError {
  constructor(recordType: string) {
    super("PHASE1_RECORD_NOT_FOUND", `${recordType} was not found.`);
    this.name = "Phase1RecordNotFoundError";
  }
}

export class Phase1OwnershipError extends Phase1RepositoryError {
  constructor() {
    super("PHASE1_OWNERSHIP_REQUIRED", "The requested workspace record is unavailable.");
    this.name = "Phase1OwnershipError";
  }
}

export class TaskActionExecutionError extends Phase1RepositoryError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "TaskActionExecutionError";
  }
}

export interface ListCompaniesOptions {
  readonly limit?: number;
  readonly status?: CompanyStatus;
  readonly query?: string;
}

export interface ListContactsOptions {
  readonly limit?: number;
  readonly companyId?: string;
  readonly status?: ContactStatus;
  readonly query?: string;
}

export interface ListTasksOptions {
  readonly limit?: number;
  readonly assigneeUserId?: string;
  readonly companyId?: string;
  readonly contactId?: string;
  readonly leadId?: string;
  readonly status?: TaskStatus;
  readonly query?: string;
  readonly overdueOnly?: boolean;
}

export interface CreateTaskInput {
  readonly id?: string;
  readonly title: string;
  readonly description?: string | null;
  readonly priority?: TaskPriority;
  readonly assigneeUserId: string;
  readonly dueAt?: string | null;
  readonly companyId?: string | null;
  readonly contactId?: string | null;
  readonly leadId?: string | null;
  readonly createdByUserId: string;
  readonly correlationId?: string;
  readonly createdAt?: string;
}

export interface CompleteTaskInput {
  readonly taskId: string;
  readonly actorUserId: string;
  readonly correlationId?: string;
  readonly completedAt?: string;
  readonly expectedVersion?: number;
}

export interface ListActivitiesOptions {
  readonly limit?: number;
  readonly companyId?: string;
  readonly contactId?: string;
  readonly taskId?: string;
  readonly leadId?: string;
}

export interface DashboardCounts {
  readonly companies: number;
  readonly contacts: number;
  readonly openTasks: number;
  readonly completedTasks: number;
  readonly overdueTasks: number;
  readonly unreadNotifications: number;
  readonly activeConversations: number;
}

export interface DashboardCountVisibility {
  readonly companies?: boolean;
  readonly contacts?: boolean;
  readonly tasks?: boolean;
  readonly taskScope?: "assigned" | "all";
  readonly notifications?: boolean;
  readonly conversations?: boolean;
}

export interface KeywordSearchOptions {
  readonly limit?: number;
  readonly types?: readonly Phase1SearchResult["type"][];
  readonly taskAssigneeUserId?: string;
}

export interface ListWorkflowRunsOptions {
  readonly limit?: number;
  readonly status?: WorkflowStatus;
}

export interface WorkflowRunDetail {
  readonly run: WorkflowRun;
  readonly steps: readonly WorkflowStepRun[];
}

export interface CreateConversationInput {
  readonly id?: string;
  readonly ownerUserId: string;
  readonly title: string;
  readonly provider?: string;
  readonly model?: string;
  readonly routerVersion?: string;
  readonly createdAt?: string;
}

export interface CreateAssistantMessageInput {
  readonly id?: string;
  readonly conversationId: string;
  readonly ownerUserId: string;
  readonly role: AssistantMessage["role"];
  readonly content: string;
  readonly correlationId: string;
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly providerResponseId?: string | null;
  readonly responseStatus?: NonNullable<AssistantMessage["responseStatus"]>;
  readonly incompleteReason?: string | null;
  readonly routerVersion?: string | null;
  readonly executionMs?: number | null;
  readonly requiredPermissions?: readonly string[];
  readonly createdAt?: string;
}

export interface CreateWorkspaceArtifactInput {
  readonly id?: string;
  readonly conversationId: string;
  readonly requestedByUserId: string;
  readonly type: WorkspaceArtifactType;
  readonly title: string;
  readonly subtitle?: string | null;
  readonly state?: WorkspaceArtifactState;
  readonly payload?: JsonObject;
  readonly sources?: readonly WorkspaceArtifactSource[];
  readonly links?: readonly WorkspaceArtifactLink[];
  readonly requiredPermissions?: readonly string[];
  readonly errorCode?: string | null;
  readonly createdAt?: string;
}

export interface CreateSuggestedActionInput {
  readonly id?: string;
  readonly conversationId: string;
  readonly requestedByUserId: string;
  readonly actionType: "task.create";
  readonly payload: JsonObject;
  readonly requiredPermission: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly expiresAt: string;
  readonly createdAt?: string;
}

export interface SuggestedActionCreationResult {
  readonly action: SuggestedAction;
  readonly reused: boolean;
}

export interface PermissionRevalidation {
  readonly permission: string;
  readonly allowed: true;
  readonly checkedAt: string;
}

export interface ApproveAndExecuteTaskActionInput {
  readonly suggestedActionId: string;
  readonly actorUserId: string;
  readonly confirmation: typeof TASK_ACTION_CONFIRMATION;
  readonly permissionRevalidation: PermissionRevalidation;
  readonly additionalPermissionRevalidations?: readonly PermissionRevalidation[];
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly executedAt?: string;
}

export interface TaskActionExecutionResult {
  readonly action: SuggestedAction;
  readonly approval: ActionApproval;
  readonly execution: ActionExecution;
  readonly task: Task;
  readonly reused: boolean;
}

export interface PresentTaskActionExecutionInput {
  readonly conversationId: string;
  readonly ownerUserId: string;
  readonly expectedConversationVersion: number;
  readonly executionId: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly correlationId: string;
  readonly presentedAt?: string;
}

export type PresentTaskActionExecutionResult =
  { readonly status: "completed" } | { readonly status: "superseded" };

export interface BeginAiCommandRequestInput {
  readonly requestId: string;
  readonly generation: number;
  readonly conversationId: string;
  readonly ownerUserId: string;
  readonly content: string;
  readonly correlationId: string;
  readonly createdAt?: string;
}

export interface ReserveAiCommandRequestInput {
  readonly conversationId: string;
  readonly ownerUserId: string;
  readonly correlationId: string;
  readonly reservedAt?: string;
}

export interface ReserveAiCommandRequestResult {
  readonly requestId: string;
  readonly generation: number;
  readonly supersededActionIds: readonly string[];
}

export type BeginAiCommandRequestResult =
  | {
      readonly status: "accepted";
      readonly requestId: string;
      readonly generation: number;
      readonly userMessage: AssistantMessage;
    }
  | {
      readonly status: "superseded";
      readonly requestId: string;
      readonly generation: number;
    };

export interface FinalizeAiCommandRequestInput {
  readonly conversationId: string;
  readonly ownerUserId: string;
  readonly generation: number;
  readonly assistantMessage: Omit<
    CreateAssistantMessageInput,
    "conversationId" | "ownerUserId" | "role" | "createdAt"
  >;
  readonly workspaceArtifact: Omit<
    CreateWorkspaceArtifactInput,
    "conversationId" | "requestedByUserId" | "createdAt"
  >;
  readonly suggestedAction?: Omit<
    CreateSuggestedActionInput,
    "conversationId" | "requestedByUserId" | "createdAt"
  >;
  readonly finalizedAt?: string;
}

export type FinalizeAiCommandRequestResult =
  | {
      readonly status: "completed";
      readonly assistantMessage: AssistantMessage;
      readonly workspaceArtifact: WorkspaceArtifact;
      readonly suggestedAction: SuggestedAction | null;
    }
  | { readonly status: "superseded" };

interface NormalizedTaskInput {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly priority: TaskPriority;
  readonly assigneeUserId: string;
  readonly dueAt: string | null;
  readonly companyId: string | null;
  readonly contactId: string | null;
  readonly leadId: string | null;
  readonly createdByUserId: string;
  readonly correlationId: string | null;
  readonly createdAt: string;
}

function normalizeTaskInput(input: CreateTaskInput): NormalizedTaskInput {
  const priority = input.priority ?? "normal";
  if (!TASK_PRIORITIES.has(priority)) throw new Phase1ValidationError("Task priority is invalid.");
  return {
    id: input.id ?? randomUUID(),
    title: requiredText(input.title, "Task title"),
    description: optionalText(input.description),
    priority,
    assigneeUserId: requiredText(input.assigneeUserId, "Assignee user ID"),
    dueAt: optionalIso(input.dueAt, "Task due time"),
    companyId: input.companyId ?? null,
    contactId: input.contactId ?? null,
    leadId: input.leadId ?? null,
    createdByUserId: requiredText(input.createdByUserId, "Creator user ID"),
    correlationId: input.correlationId?.trim() || null,
    createdAt: optionalIso(input.createdAt, "Task creation time") ?? new Date().toISOString(),
  };
}

async function insertTask(executor: SqlExecutor, input: NormalizedTaskInput): Promise<Task> {
  const result = await executor.query<Row>(
    `INSERT INTO tasks
     (id,title,description,status,priority,assignee_user_id,due_at,completed_at,company_id,contact_id,lead_id,created_by_user_id,created_at,updated_at,version)
     VALUES ($1,$2,$3,'open',$4,$5,$6,NULL,$7,$8,$9,$10,$11,$11,1)
     RETURNING *`,
    [
      input.id,
      input.title,
      input.description,
      input.priority,
      input.assigneeUserId,
      input.dueAt,
      input.companyId,
      input.contactId,
      input.leadId,
      input.createdByUserId,
      input.createdAt,
    ],
  );
  return mapTask(result.rows[0] as Row);
}

async function requireValidLeadRelationship(
  executor: SqlExecutor,
  leadId: string | null,
): Promise<void> {
  if (!leadId) return;
  const lead = await executor.query<Row>("SELECT id FROM leads WHERE id=$1 FOR SHARE", [leadId]);
  if (!lead.rows[0]) {
    throw new Phase1ValidationError("The linked lead is unavailable.");
  }
}

async function requireValidTaskRelationships(
  executor: SqlExecutor,
  companyId: string | null,
  contactId: string | null,
): Promise<void> {
  if (contactId && !companyId) {
    throw new TaskRelationshipValidationError(
      "contactId",
      "PHASE1_TASK_CONTACT_COMPANY_MISMATCH",
      "Select a company before linking a contact.",
    );
  }
  if (companyId) {
    const company = await executor.query<Row>("SELECT id FROM companies WHERE id=$1 FOR SHARE", [
      companyId,
    ]);
    if (!company.rows[0]) {
      throw new TaskRelationshipValidationError(
        "companyId",
        "PHASE1_TASK_COMPANY_INVALID",
        "The linked company is unavailable.",
      );
    }
  }
  if (contactId && companyId) {
    const contact = await executor.query<Row>(
      "SELECT id FROM contacts WHERE id=$1 AND company_id=$2 FOR SHARE",
      [contactId, companyId],
    );
    if (!contact.rows[0]) {
      throw new TaskRelationshipValidationError(
        "contactId",
        "PHASE1_TASK_CONTACT_COMPANY_MISMATCH",
        "The linked contact is unavailable or does not match the selected company.",
      );
    }
  }
}

async function insertActivity(
  executor: SqlExecutor,
  input: {
    readonly type: Activity["type"];
    readonly summary: string;
    readonly actorUserId: string | null;
    readonly companyId?: string | null;
    readonly contactId?: string | null;
    readonly taskId?: string | null;
    readonly leadId?: string | null;
    readonly correlationId?: string | null;
    readonly metadata?: JsonObject;
    readonly createdAt: string;
  },
): Promise<Activity> {
  const result = await executor.query<Row>(
    `INSERT INTO activities
     (id,type,summary,actor_user_id,company_id,contact_id,task_id,lead_id,correlation_id,metadata,created_at,updated_at,version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$11,1) RETURNING *`,
    [
      randomUUID(),
      input.type,
      input.summary,
      input.actorUserId,
      input.companyId ?? null,
      input.contactId ?? null,
      input.taskId ?? null,
      input.leadId ?? null,
      input.correlationId ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.createdAt,
    ],
  );
  return mapActivity(result.rows[0] as Row);
}

async function insertAudit(
  executor: SqlExecutor,
  input: {
    readonly eventType: string;
    readonly action: string;
    readonly actorUserId: string;
    readonly resourceType: string;
    readonly resourceId: string;
    readonly correlationId?: string | null;
    readonly metadata?: JsonObject;
    readonly createdAt: string;
  },
): Promise<void> {
  await executor.query(
    `INSERT INTO audit_logs
     (id,event_type,action,outcome,actor_user_id,resource_type,resource_id,correlation_id,metadata,created_at)
     VALUES ($1,$2,$3,'succeeded',$4,$5,$6,$7,$8::jsonb,$9)`,
    [
      randomUUID(),
      input.eventType,
      input.action,
      input.actorUserId,
      input.resourceType,
      input.resourceId,
      input.correlationId ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.createdAt,
    ],
  );
}

export class SqlPhase1Repository {
  constructor(private readonly database: DatabaseAdapter) {}

  async listCompanies(options: ListCompaniesOptions = {}): Promise<readonly Company[]> {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (options.status) {
      parameters.push(options.status);
      clauses.push(`status=$${parameters.length}`);
    }
    if (options.query?.trim()) {
      parameters.push(`%${escapeLike(options.query.trim())}%`);
      const parameter = `$${parameters.length}`;
      clauses.push(
        `(name ILIKE ${parameter} ESCAPE '\\' OR COALESCE(industry,'') ILIKE ${parameter} ESCAPE '\\')`,
      );
    }
    parameters.push(clampLimit(options.limit));
    const result = await this.database.query<Row>(
      `SELECT * FROM companies ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY name,id LIMIT $${parameters.length}`,
      parameters,
    );
    return result.rows.map(mapCompany);
  }

  async getCompany(id: string): Promise<Company | null> {
    const result = await this.database.query<Row>("SELECT * FROM companies WHERE id=$1", [id]);
    return result.rows[0] ? mapCompany(result.rows[0]) : null;
  }

  async listContacts(options: ListContactsOptions = {}): Promise<readonly Contact[]> {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (options.companyId) {
      parameters.push(options.companyId);
      clauses.push(`company_id=$${parameters.length}`);
    }
    if (options.status) {
      parameters.push(options.status);
      clauses.push(`status=$${parameters.length}`);
    }
    if (options.query?.trim()) {
      parameters.push(`%${escapeLike(options.query.trim())}%`);
      const parameter = `$${parameters.length}`;
      clauses.push(
        `(first_name ILIKE ${parameter} ESCAPE '\\' OR last_name ILIKE ${parameter} ESCAPE '\\' OR COALESCE(job_title,'') ILIKE ${parameter} ESCAPE '\\' OR COALESCE(email,'') ILIKE ${parameter} ESCAPE '\\')`,
      );
    }
    parameters.push(clampLimit(options.limit));
    const result = await this.database.query<Row>(
      `SELECT * FROM contacts ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY last_name,first_name,id LIMIT $${parameters.length}`,
      parameters,
    );
    return result.rows.map(mapContact);
  }

  async getContact(id: string): Promise<Contact | null> {
    const result = await this.database.query<Row>("SELECT * FROM contacts WHERE id=$1", [id]);
    return result.rows[0] ? mapContact(result.rows[0]) : null;
  }

  async listTasks(options: ListTasksOptions = {}): Promise<readonly Task[]> {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    for (const [column, value] of [
      ["assignee_user_id", options.assigneeUserId],
      ["company_id", options.companyId],
      ["contact_id", options.contactId],
      ["lead_id", options.leadId],
      ["status", options.status],
    ] as const) {
      if (value) {
        parameters.push(value);
        clauses.push(`${column}=$${parameters.length}`);
      }
    }
    if (options.query?.trim()) {
      parameters.push(`%${escapeLike(options.query.trim())}%`);
      const parameter = `$${parameters.length}`;
      clauses.push(
        `(title ILIKE ${parameter} ESCAPE '\\' OR COALESCE(description,'') ILIKE ${parameter} ESCAPE '\\')`,
      );
    }
    if (options.overdueOnly) {
      clauses.push("status='open' AND due_at < CURRENT_TIMESTAMP");
    }
    parameters.push(clampLimit(options.limit));
    const result = await this.database.query<Row>(
      `SELECT * FROM tasks ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
                due_at NULLS LAST,created_at DESC,id
       LIMIT $${parameters.length}`,
      parameters,
    );
    return result.rows.map(mapTask);
  }

  async getTask(id: string): Promise<Task | null> {
    const result = await this.database.query<Row>("SELECT * FROM tasks WHERE id=$1", [id]);
    return result.rows[0] ? mapTask(result.rows[0]) : null;
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    const normalized = normalizeTaskInput(input);
    return this.database.transaction(async (transaction) => {
      await requireValidTaskRelationships(transaction, normalized.companyId, normalized.contactId);
      await requireValidLeadRelationship(transaction, normalized.leadId);
      const task = await insertTask(transaction, normalized);
      await insertActivity(transaction, {
        type: "task.created",
        summary: `Task created: ${task.title}`,
        actorUserId: normalized.createdByUserId,
        companyId: task.companyId,
        contactId: task.contactId,
        taskId: task.id,
        leadId: task.leadId,
        correlationId: normalized.correlationId,
        metadata: { priority: task.priority, assigneeUserId: task.assigneeUserId },
        createdAt: normalized.createdAt,
      });
      await insertAudit(transaction, {
        eventType: "task.created",
        action: "task.create",
        actorUserId: normalized.createdByUserId,
        resourceType: "task",
        resourceId: task.id,
        correlationId: normalized.correlationId,
        metadata: { priority: task.priority, assigneeUserId: task.assigneeUserId },
        createdAt: normalized.createdAt,
      });
      return task;
    });
  }

  async completeTask(input: CompleteTaskInput): Promise<{ task: Task; reused: boolean }> {
    const completedAt =
      optionalIso(input.completedAt, "Task completion time") ?? new Date().toISOString();
    return this.database.transaction(async (transaction) => {
      const currentResult = await transaction.query<Row>(
        "SELECT * FROM tasks WHERE id=$1 FOR UPDATE",
        [input.taskId],
      );
      const currentRow = currentResult.rows[0];
      if (!currentRow) throw new Phase1RecordNotFoundError("Task");
      const current = mapTask(currentRow);
      if (current.status === "completed") return { task: current, reused: true };
      const updatedResult = await transaction.query<Row>(
        `UPDATE tasks SET status='completed',completed_at=$2,updated_at=$2,version=version+1
         WHERE id=$1 AND status='open' AND ($3::integer IS NULL OR version=$3) RETURNING *`,
        [input.taskId, completedAt, input.expectedVersion ?? null],
      );
      const updatedRow = updatedResult.rows[0];
      if (!updatedRow) {
        throw new Phase1RepositoryError(
          "PHASE1_CONCURRENT_UPDATE",
          "Task changed before completion could be recorded.",
        );
      }
      const task = mapTask(updatedRow);
      await insertActivity(transaction, {
        type: "task.completed",
        summary: `Task completed: ${task.title}`,
        actorUserId: input.actorUserId,
        companyId: task.companyId,
        contactId: task.contactId,
        taskId: task.id,
        correlationId: input.correlationId ?? null,
        createdAt: completedAt,
      });
      await insertAudit(transaction, {
        eventType: "task.completed",
        action: "task.complete",
        actorUserId: input.actorUserId,
        resourceType: "task",
        resourceId: task.id,
        correlationId: input.correlationId ?? null,
        createdAt: completedAt,
      });
      return { task, reused: false };
    });
  }

  async listActivities(options: ListActivitiesOptions = {}): Promise<readonly Activity[]> {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    for (const [column, value] of [
      ["company_id", options.companyId],
      ["contact_id", options.contactId],
      ["task_id", options.taskId],
      ["lead_id", options.leadId],
    ] as const) {
      if (value) {
        parameters.push(value);
        clauses.push(`${column}=$${parameters.length}`);
      }
    }
    parameters.push(clampLimit(options.limit));
    const result = await this.database.query<Row>(
      `SELECT * FROM activities ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY created_at DESC,id DESC LIMIT $${parameters.length}`,
      parameters,
    );
    return result.rows.map(mapActivity);
  }

  async listNotifications(options: {
    readonly userId: string;
    readonly limit?: number;
    readonly unreadOnly?: boolean;
  }): Promise<readonly Notification[]> {
    const result = await this.database.query<Row>(
      `SELECT * FROM notifications
       WHERE user_id=$1 ${options.unreadOnly ? "AND read_at IS NULL" : ""}
       ORDER BY created_at DESC,id DESC LIMIT $2`,
      [options.userId, clampLimit(options.limit)],
    );
    return result.rows.map(mapNotification);
  }

  async markNotificationRead(input: {
    readonly notificationId: string;
    readonly userId: string;
    readonly readAt?: string;
  }): Promise<Notification | null> {
    const readAt = optionalIso(input.readAt, "Notification read time") ?? new Date().toISOString();
    const result = await this.database.query<Row>(
      `UPDATE notifications SET read_at=COALESCE(read_at,$3),updated_at=CASE WHEN read_at IS NULL THEN $3 ELSE updated_at END,
       version=CASE WHEN read_at IS NULL THEN version+1 ELSE version END
       WHERE id=$1 AND user_id=$2 RETURNING *`,
      [input.notificationId, input.userId, readAt],
    );
    return result.rows[0] ? mapNotification(result.rows[0]) : null;
  }

  async getDashboardCounts(
    userId: string,
    visibility?: DashboardCountVisibility,
  ): Promise<DashboardCounts> {
    const includeAll = visibility === undefined;
    const includes = (key: keyof DashboardCountVisibility) =>
      includeAll || visibility?.[key] === true;
    const taskAssigneeClause =
      visibility?.taskScope === "all" ? "" : "assignee_user_id=(SELECT user_id FROM viewer) AND ";
    const result = await this.database.query<Row>(
      `WITH viewer AS (SELECT $1::uuid AS user_id)
       SELECT
         ${includes("companies") ? "(SELECT COUNT(*) FROM companies WHERE status <> 'inactive')" : "0"} AS companies,
         ${includes("contacts") ? "(SELECT COUNT(*) FROM contacts WHERE status = 'active')" : "0"} AS contacts,
         ${includes("tasks") ? `(SELECT COUNT(*) FROM tasks WHERE ${taskAssigneeClause}status='open')` : "0"} AS open_tasks,
         ${includes("tasks") ? `(SELECT COUNT(*) FROM tasks WHERE ${taskAssigneeClause}status='completed')` : "0"} AS completed_tasks,
         ${includes("tasks") ? `(SELECT COUNT(*) FROM tasks WHERE ${taskAssigneeClause}status='open' AND due_at < CURRENT_TIMESTAMP)` : "0"} AS overdue_tasks,
         ${includes("notifications") ? "(SELECT COUNT(*) FROM notifications WHERE user_id=(SELECT user_id FROM viewer) AND read_at IS NULL)" : "0"} AS unread_notifications,
         ${includes("conversations") ? "(SELECT COUNT(*) FROM conversations WHERE owner_user_id=(SELECT user_id FROM viewer) AND status='active')" : "0"} AS active_conversations`,
      [requiredText(userId, "Dashboard user ID", 128)],
    );
    const row = result.rows[0] ?? {};
    return {
      companies: Number(row.companies ?? 0),
      contacts: Number(row.contacts ?? 0),
      openTasks: Number(row.open_tasks ?? 0),
      completedTasks: Number(row.completed_tasks ?? 0),
      overdueTasks: Number(row.overdue_tasks ?? 0),
      unreadNotifications: Number(row.unread_notifications ?? 0),
      activeConversations: Number(row.active_conversations ?? 0),
    };
  }

  async searchKeyword(
    query: string,
    options: KeywordSearchOptions = {},
  ): Promise<readonly Phase1SearchResult[]> {
    const normalized = requiredText(query, "Search query", 200);
    const selectedTypes = (options.types ?? []).filter((type) => SEARCH_RESULT_TYPES.has(type));
    if (options.types && selectedTypes.length === 0) return [];
    const parameters: unknown[] = [`%${escapeLike(normalized)}%`];
    let taskAssigneeClause = "";
    if (options.taskAssigneeUserId) {
      parameters.push(requiredText(options.taskAssigneeUserId, "Task assignee ID", 128));
      taskAssigneeClause = ` AND assignee_user_id=$${parameters.length}`;
    }
    let typeClause = "";
    if (selectedTypes.length > 0) {
      const placeholders = selectedTypes.map((type) => {
        parameters.push(type);
        return `$${parameters.length}`;
      });
      typeClause = `WHERE result_type IN (${placeholders.join(",")})`;
    }
    parameters.push(clampLimit(options.limit, 20, 50));
    const result = await this.database.query<Row>(
      `SELECT result_id,result_type,title,subtitle,href FROM (
         SELECT id AS result_id,'company' AS result_type,name AS title,
                COALESCE(industry,status) AS subtitle,'/companies/' || id::text AS href
           FROM companies WHERE name ILIKE $1 ESCAPE '\\' OR COALESCE(industry,'') ILIKE $1 ESCAPE '\\'
         UNION ALL
         SELECT id,'contact',TRIM(first_name || ' ' || last_name),
                COALESCE(job_title,email,'Contact'),'/contacts/' || id::text
           FROM contacts WHERE first_name ILIKE $1 ESCAPE '\\' OR last_name ILIKE $1 ESCAPE '\\' OR COALESCE(job_title,'') ILIKE $1 ESCAPE '\\' OR COALESCE(email,'') ILIKE $1 ESCAPE '\\'
         UNION ALL
         SELECT id,'task',title,COALESCE(description,status),'/tasks/' || id::text
           FROM tasks WHERE (title ILIKE $1 ESCAPE '\\' OR COALESCE(description,'') ILIKE $1 ESCAPE '\\')${taskAssigneeClause}
         UNION ALL
         SELECT id,'integration',display_name,connection_status,
                '/integrations/' || provider_type
           FROM integration_connections WHERE display_name ILIKE $1 ESCAPE '\\' OR provider_type ILIKE $1 ESCAPE '\\'
         UNION ALL
         SELECT id,'workflow-run',workflow_key,status,'/workflow-runs/' || id::text
           FROM workflow_runs WHERE workflow_key ILIKE $1 ESCAPE '\\' OR correlation_id ILIKE $1 ESCAPE '\\'
         UNION ALL
         SELECT id,'lead',opportunity_name,reference || ' · ' || status,'/leads/' || id::text
           FROM leads WHERE reference ILIKE $1 ESCAPE '\\' OR opportunity_name ILIKE $1 ESCAPE '\\' OR request_summary ILIKE $1 ESCAPE '\\' OR COALESCE(requested_service,'') ILIKE $1 ESCAPE '\\' OR COALESCE(source_details,'') ILIKE $1 ESCAPE '\\'
       ) AS search_results(result_id,result_type,title,subtitle,href)
       ${typeClause} ORDER BY result_type,title,result_id LIMIT $${parameters.length}`,
      parameters,
    );
    return result.rows.map((row) => ({
      id: String(row.result_id),
      type: row.result_type as Phase1SearchResult["type"],
      title: String(row.title),
      subtitle: String(row.subtitle),
      href: String(row.href),
    }));
  }

  async listWorkflowRuns(options: ListWorkflowRunsOptions = {}): Promise<readonly WorkflowRun[]> {
    const parameters: unknown[] = [];
    let statusClause = "";
    if (options.status) {
      parameters.push(options.status);
      statusClause = `WHERE status=$${parameters.length}`;
    }
    parameters.push(clampLimit(options.limit, 25));
    const result = await this.database.query<Row>(
      `SELECT * FROM workflow_runs ${statusClause} ORDER BY started_at DESC,id DESC LIMIT $${parameters.length}`,
      parameters,
    );
    return result.rows.map(mapWorkflowRun);
  }

  async getWorkflowRun(id: string): Promise<WorkflowRunDetail | null> {
    const [runResult, stepsResult] = await Promise.all([
      this.database.query<Row>("SELECT * FROM workflow_runs WHERE id=$1", [id]),
      this.database.query<Row>(
        "SELECT * FROM workflow_step_runs WHERE workflow_run_id=$1 ORDER BY sequence,id",
        [id],
      ),
    ]);
    const runRow = runResult.rows[0];
    return runRow
      ? { run: mapWorkflowRun(runRow), steps: stepsResult.rows.map(mapWorkflowStep) }
      : null;
  }

  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    const createdAt =
      optionalIso(input.createdAt, "Conversation creation time") ?? new Date().toISOString();
    const result = await this.database.query<Row>(
      `INSERT INTO conversations
       (id,owner_user_id,title,provider,model,router_version,status,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$7,1) RETURNING *`,
      [
        input.id ?? randomUUID(),
        input.ownerUserId,
        requiredText(input.title, "Conversation title"),
        requiredText(input.provider ?? "simulated", "Conversation provider", 64),
        requiredText(input.model ?? "deterministic-demo-router", "Conversation model", 255),
        requiredText(input.routerVersion ?? "phase1-demo-router-v1", "Router version", 100),
        createdAt,
      ],
    );
    return mapConversation(result.rows[0] as Row);
  }

  async listConversations(ownerUserId: string, limit = 25): Promise<readonly Conversation[]> {
    const result = await this.database.query<Row>(
      "SELECT * FROM conversations WHERE owner_user_id=$1 ORDER BY updated_at DESC,id DESC LIMIT $2",
      [ownerUserId, clampLimit(limit, 25)],
    );
    return result.rows.map(mapConversation);
  }

  async getConversation(id: string, ownerUserId: string): Promise<Conversation | null> {
    const result = await this.database.query<Row>(
      "SELECT * FROM conversations WHERE id=$1 AND owner_user_id=$2",
      [id, ownerUserId],
    );
    return result.rows[0] ? mapConversation(result.rows[0]) : null;
  }

  async archiveConversation(
    id: string,
    ownerUserId: string,
    archivedAt?: string,
  ): Promise<Conversation | null> {
    const timestamp =
      optionalIso(archivedAt, "Conversation archive time") ?? new Date().toISOString();
    const result = await this.database.query<Row>(
      `UPDATE conversations SET status='archived',updated_at=$3,version=version+1
       WHERE id=$1 AND owner_user_id=$2 AND status <> 'archived' RETURNING *`,
      [id, ownerUserId, timestamp],
    );
    if (result.rows[0]) return mapConversation(result.rows[0]);
    return this.getConversation(id, ownerUserId);
  }

  private async requireOwnedConversation(
    executor: SqlExecutor,
    conversationId: string,
    ownerUserId: string,
    lock = false,
  ): Promise<Conversation> {
    const result = await executor.query<Row>(
      `SELECT * FROM conversations WHERE id=$1 AND owner_user_id=$2${lock ? " FOR UPDATE" : ""}`,
      [conversationId, ownerUserId],
    );
    if (!result.rows[0]) throw new Phase1OwnershipError();
    return mapConversation(result.rows[0]);
  }

  async reserveAiCommandRequest(
    input: ReserveAiCommandRequestInput,
  ): Promise<ReserveAiCommandRequestResult> {
    const correlationId = requiredText(input.correlationId, "Message correlation ID", 128);
    const reservedAt =
      optionalIso(input.reservedAt, "AI Command reservation time") ?? new Date().toISOString();
    return this.database.transaction(async (transaction) => {
      const conversation = await this.requireOwnedConversation(
        transaction,
        input.conversationId,
        input.ownerUserId,
        true,
      );
      const generationResult = await transaction.query<Row>(
        `UPDATE conversations SET updated_at=$3,version=version+1
         WHERE id=$1 AND owner_user_id=$2 AND version=$4 RETURNING version`,
        [conversation.id, input.ownerUserId, reservedAt, conversation.version],
      );
      const generation = Number(generationResult.rows[0]?.version);
      if (!Number.isSafeInteger(generation)) {
        throw new Phase1RepositoryError(
          "PHASE1_CONCURRENT_UPDATE",
          "AI Command request generation could not be reserved.",
        );
      }
      const superseded = await transaction.query<Row>(
        `UPDATE suggested_actions SET status='denied',updated_at=$3,version=version+1
         WHERE conversation_id=$1 AND requested_by_user_id=$2 AND status='pending'
         RETURNING id`,
        [conversation.id, input.ownerUserId, reservedAt],
      );
      const requestId = randomUUID();
      await transaction.query(
        `INSERT INTO assistant_messages
         (id,conversation_id,role,content,provider,model,router_version,execution_ms,correlation_id,required_permissions,created_at,updated_at,version)
         VALUES ($1,$2,'system',$3,NULL,NULL,$4,NULL,$5,$6::jsonb,$7,$7,1)`,
        [
          requestId,
          conversation.id,
          aiCommandReservationContent(generation),
          AI_COMMAND_REQUEST_RESERVATION_ROUTER_VERSION,
          correlationId,
          JSON.stringify([]),
          reservedAt,
        ],
      );
      return {
        requestId,
        generation,
        supersededActionIds: superseded.rows.map((row) => String(row.id)),
      };
    });
  }

  async beginAiCommandRequest(
    input: BeginAiCommandRequestInput,
  ): Promise<BeginAiCommandRequestResult> {
    const requestId = requiredUuid(input.requestId, "AI Command request ID");
    const generation = requiredAiCommandGeneration(input.generation);
    const content = requiredText(input.content, "Message content", 20_000);
    const correlationId = requiredText(input.correlationId, "Message correlation ID", 128);
    const createdAt =
      optionalIso(input.createdAt, "Message creation time") ?? new Date().toISOString();
    return this.database.transaction(async (transaction) => {
      const conversation = await this.requireOwnedConversation(
        transaction,
        input.conversationId,
        input.ownerUserId,
        true,
      );
      const reservationResult = await transaction.query<Row>(
        `SELECT * FROM assistant_messages
         WHERE id=$1 AND conversation_id=$2 FOR UPDATE`,
        [requestId, conversation.id],
      );
      const reservation = reservationResult.rows[0];
      if (!reservation) {
        throw new Phase1RepositoryError(
          "PHASE1_REQUEST_RESERVATION_INVALID",
          "AI Command request reservation is invalid.",
        );
      }
      if (
        reservation.role !== "system" ||
        reservation.router_version !== AI_COMMAND_REQUEST_RESERVATION_ROUTER_VERSION
      ) {
        throw new Phase1RepositoryError(
          "PHASE1_REQUEST_REPLAYED",
          "AI Command request reservation has already been consumed.",
        );
      }
      const reservedGeneration = aiCommandReservationGeneration(reservation);
      if (reservedGeneration === null || reservedGeneration !== generation) {
        throw new Phase1RepositoryError(
          "PHASE1_REQUEST_RESERVATION_INVALID",
          "AI Command request reservation generation does not match.",
        );
      }
      if (conversation.version !== generation) {
        await transaction.query(
          `UPDATE assistant_messages
           SET router_version=$2,updated_at=$3,version=version+1
           WHERE id=$1`,
          [requestId, AI_COMMAND_REQUEST_SUPERSEDED_ROUTER_VERSION, createdAt],
        );
        return { status: "superseded", requestId, generation };
      }
      const messageResult = await transaction.query<Row>(
        `UPDATE assistant_messages
         SET role='user',content=$2,router_version=NULL,correlation_id=$3,
             required_permissions='[]'::jsonb,updated_at=$4,version=version+1
         WHERE id=$1 AND role='system' AND router_version=$5 RETURNING *`,
        [
          requestId,
          content,
          correlationId,
          createdAt,
          AI_COMMAND_REQUEST_RESERVATION_ROUTER_VERSION,
        ],
      );
      if (!messageResult.rows[0]) {
        throw new Phase1RepositoryError(
          "PHASE1_REQUEST_REPLAYED",
          "AI Command request reservation has already been consumed.",
        );
      }
      return {
        status: "accepted",
        requestId,
        generation,
        userMessage: mapAssistantMessage(messageResult.rows[0]),
      };
    });
  }

  async finalizeAiCommandRequest(
    input: FinalizeAiCommandRequestInput,
  ): Promise<FinalizeAiCommandRequestResult> {
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
      throw new Phase1ValidationError("AI Command request generation is invalid.");
    }
    const finalizedAt =
      optionalIso(input.finalizedAt, "AI Command finalization time") ?? new Date().toISOString();
    const assistantContent = requiredText(
      input.assistantMessage.content,
      "Message content",
      20_000,
    );
    const assistantCorrelationId = requiredText(
      input.assistantMessage.correlationId,
      "Message correlation ID",
      128,
    );
    const executionMs = input.assistantMessage.executionMs ?? null;
    if (executionMs !== null && (!Number.isInteger(executionMs) || executionMs < 0)) {
      throw new Phase1ValidationError("Message execution time must be a non-negative integer.");
    }
    const artifactTitle = requiredText(input.workspaceArtifact.title, "Artifact title");
    const artifactSubtitle = optionalText(input.workspaceArtifact.subtitle, 500);
    const suggestedAction = input.suggestedAction;
    const actionExpiresAt = suggestedAction
      ? (optionalIso(suggestedAction.expiresAt, "Suggested action expiry time") as string)
      : null;
    if (actionExpiresAt && Date.parse(actionExpiresAt) <= Date.parse(finalizedAt)) {
      throw new Phase1ValidationError("Suggested action expiry must be after creation.");
    }

    return this.database.transaction(async (transaction) => {
      const conversation = await this.requireOwnedConversation(
        transaction,
        input.conversationId,
        input.ownerUserId,
        true,
      );
      if (conversation.version !== input.generation) return { status: "superseded" };

      const messageResult = await transaction.query<Row>(
        `INSERT INTO assistant_messages
         (id,conversation_id,role,content,provider,model,provider_response_id,response_status,incomplete_reason,router_version,execution_ms,correlation_id,required_permissions,created_at,updated_at,version)
         VALUES ($1,$2,'assistant',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$13,1)
         RETURNING *`,
        [
          input.assistantMessage.id ?? randomUUID(),
          conversation.id,
          assistantContent,
          input.assistantMessage.provider ?? "simulated",
          input.assistantMessage.model ?? "deterministic-demo-router",
          input.assistantMessage.providerResponseId ?? null,
          input.assistantMessage.responseStatus ?? "completed",
          input.assistantMessage.incompleteReason ?? null,
          input.assistantMessage.routerVersion ?? "phase1-demo-router-v1",
          executionMs,
          assistantCorrelationId,
          JSON.stringify(input.workspaceArtifact.requiredPermissions ?? []),
          finalizedAt,
        ],
      );
      const artifactResult = await transaction.query<Row>(
        `INSERT INTO workspace_artifacts
         (id,conversation_id,requested_by_user_id,type,title,subtitle,state,payload,sources,links,required_permissions,error_code,created_at,updated_at,version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$13,1)
         RETURNING *`,
        [
          input.workspaceArtifact.id ?? randomUUID(),
          conversation.id,
          input.ownerUserId,
          input.workspaceArtifact.type,
          artifactTitle,
          artifactSubtitle,
          input.workspaceArtifact.state ?? "ready",
          JSON.stringify(input.workspaceArtifact.payload ?? {}),
          JSON.stringify(input.workspaceArtifact.sources ?? []),
          JSON.stringify(input.workspaceArtifact.links ?? []),
          JSON.stringify(input.workspaceArtifact.requiredPermissions ?? []),
          input.workspaceArtifact.errorCode ?? null,
          finalizedAt,
        ],
      );

      let persistedAction: SuggestedAction | null = null;
      if (suggestedAction && actionExpiresAt) {
        const idempotencyKey = requiredText(
          suggestedAction.idempotencyKey,
          "Suggested action idempotency key",
          200,
        );
        const actionInsert = await transaction.query<Row>(
          `INSERT INTO suggested_actions
           (id,conversation_id,requested_by_user_id,action_type,status,payload,required_permission,idempotency_key,correlation_id,expires_at,created_at,updated_at,version)
           VALUES ($1,$2,$3,'task.create','pending',$4::jsonb,$5,$6,$7,$8,$9,$9,1)
           ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
          [
            suggestedAction.id ?? randomUUID(),
            conversation.id,
            input.ownerUserId,
            JSON.stringify(suggestedAction.payload),
            requiredText(suggestedAction.requiredPermission, "Required permission", 120),
            idempotencyKey,
            requiredText(suggestedAction.correlationId, "Suggested action correlation ID", 128),
            actionExpiresAt,
            finalizedAt,
          ],
        );
        if (actionInsert.rows[0]) {
          persistedAction = mapSuggestedAction(actionInsert.rows[0]);
          await insertActivity(transaction, {
            type: "action.previewed",
            summary: "Task creation action previewed.",
            actorUserId: input.ownerUserId,
            correlationId: persistedAction.correlationId,
            metadata: {
              suggestedActionId: persistedAction.id,
              actionType: persistedAction.actionType,
            },
            createdAt: finalizedAt,
          });
        } else {
          const existing = await transaction.query<Row>(
            `SELECT * FROM suggested_actions
             WHERE idempotency_key=$1 AND conversation_id=$2 AND requested_by_user_id=$3`,
            [idempotencyKey, conversation.id, input.ownerUserId],
          );
          if (!existing.rows[0]) {
            throw new Phase1RepositoryError(
              "PHASE1_IDEMPOTENCY_CONFLICT",
              "Suggested action idempotency key belongs to another request.",
            );
          }
          persistedAction = mapSuggestedAction(existing.rows[0]);
        }
      }

      const updated = await transaction.query<Row>(
        `UPDATE conversations SET updated_at=$3,version=version+1
         WHERE id=$1 AND owner_user_id=$2 AND version=$4 RETURNING id`,
        [conversation.id, input.ownerUserId, finalizedAt, input.generation],
      );
      if (!updated.rows[0]) {
        throw new Phase1RepositoryError(
          "PHASE1_CONCURRENT_UPDATE",
          "AI Command response could not be finalized.",
        );
      }
      return {
        status: "completed",
        assistantMessage: mapAssistantMessage(messageResult.rows[0] as Row),
        workspaceArtifact: mapWorkspaceArtifact(artifactResult.rows[0] as Row),
        suggestedAction: persistedAction,
      };
    });
  }

  async markAiCommandFinalizationIncomplete(input: {
    readonly assistantMessageId: string;
    readonly workspaceArtifactId: string;
    readonly ownerUserId: string;
    readonly errorCode: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    const errorCode = requiredText(input.errorCode, "AI Command finalization error", 100);
    await this.database.transaction(async (transaction) => {
      await transaction.query(
        `UPDATE assistant_messages
         SET response_status='incomplete',incomplete_reason=$4,updated_at=$5,version=version+1
         WHERE assistant_messages.id=$1
           AND EXISTS (
             SELECT 1 FROM conversations c
             WHERE c.id=assistant_messages.conversation_id AND c.owner_user_id=$3
           )
           AND EXISTS (
             SELECT 1 FROM workspace_artifacts a
             WHERE a.id=$2 AND a.conversation_id=assistant_messages.conversation_id
               AND a.requested_by_user_id=$3
           )`,
        [input.assistantMessageId, input.workspaceArtifactId, input.ownerUserId, errorCode, now],
      );
      await transaction.query(
        `UPDATE workspace_artifacts
         SET state='failed',error_code=$4,updated_at=$5,version=version+1
         WHERE workspace_artifacts.id=$2
           AND EXISTS (
             SELECT 1 FROM conversations c
             WHERE c.id=workspace_artifacts.conversation_id AND c.owner_user_id=$3
           )
           AND EXISTS (
             SELECT 1 FROM assistant_messages m
             WHERE m.id=$1 AND m.conversation_id=workspace_artifacts.conversation_id
           )`,
        [input.assistantMessageId, input.workspaceArtifactId, input.ownerUserId, errorCode, now],
      );
    });
  }

  async createAssistantMessage(input: CreateAssistantMessageInput): Promise<AssistantMessage> {
    const createdAt =
      optionalIso(input.createdAt, "Message creation time") ?? new Date().toISOString();
    const content = requiredText(input.content, "Message content", 20_000);
    const executionMs = input.executionMs ?? null;
    if (executionMs !== null && (!Number.isInteger(executionMs) || executionMs < 0)) {
      throw new Phase1ValidationError("Message execution time must be a non-negative integer.");
    }
    return this.database.transaction(async (transaction) => {
      await this.requireOwnedConversation(
        transaction,
        input.conversationId,
        input.ownerUserId,
        true,
      );
      const assistantGenerated = input.role === "assistant";
      const result = await transaction.query<Row>(
        `INSERT INTO assistant_messages
         (id,conversation_id,role,content,provider,model,provider_response_id,response_status,incomplete_reason,router_version,execution_ms,correlation_id,required_permissions,created_at,updated_at,version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$14,1) RETURNING *`,
        [
          input.id ?? randomUUID(),
          input.conversationId,
          input.role,
          content,
          assistantGenerated ? (input.provider ?? "simulated") : null,
          assistantGenerated ? (input.model ?? "deterministic-demo-router") : null,
          assistantGenerated ? (input.providerResponseId ?? null) : null,
          input.responseStatus ?? "completed",
          input.incompleteReason ?? null,
          assistantGenerated ? (input.routerVersion ?? "phase1-demo-router-v1") : null,
          executionMs,
          requiredText(input.correlationId, "Message correlation ID", 128),
          JSON.stringify(input.requiredPermissions ?? []),
          createdAt,
        ],
      );
      await transaction.query(
        "UPDATE conversations SET updated_at=$2,version=version+1 WHERE id=$1",
        [input.conversationId, createdAt],
      );
      return mapAssistantMessage(result.rows[0] as Row);
    });
  }

  async listAssistantMessages(
    conversationId: string,
    ownerUserId: string,
    limit = 100,
  ): Promise<readonly AssistantMessage[]> {
    const result = await this.database.query<Row>(
      `SELECT m.* FROM assistant_messages m
       JOIN conversations c ON c.id=m.conversation_id
       WHERE m.conversation_id=$1 AND c.owner_user_id=$2
         AND NOT (
           m.role='system' AND m.router_version IN ($4,$5)
         )
       ORDER BY m.created_at,m.id LIMIT $3`,
      [
        conversationId,
        ownerUserId,
        clampLimit(limit, 100, 250),
        AI_COMMAND_REQUEST_RESERVATION_ROUTER_VERSION,
        AI_COMMAND_REQUEST_SUPERSEDED_ROUTER_VERSION,
      ],
    );
    return result.rows.map(mapAssistantMessage);
  }

  async createWorkspaceArtifact(input: CreateWorkspaceArtifactInput): Promise<WorkspaceArtifact> {
    const createdAt =
      optionalIso(input.createdAt, "Artifact creation time") ?? new Date().toISOString();
    return this.database.transaction(async (transaction) => {
      await this.requireOwnedConversation(
        transaction,
        input.conversationId,
        input.requestedByUserId,
        true,
      );
      const result = await transaction.query<Row>(
        `INSERT INTO workspace_artifacts
         (id,conversation_id,requested_by_user_id,type,title,subtitle,state,payload,sources,links,required_permissions,error_code,created_at,updated_at,version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$13,1) RETURNING *`,
        [
          input.id ?? randomUUID(),
          input.conversationId,
          input.requestedByUserId,
          input.type,
          requiredText(input.title, "Artifact title"),
          optionalText(input.subtitle, 500),
          input.state ?? "ready",
          JSON.stringify(input.payload ?? {}),
          JSON.stringify(input.sources ?? []),
          JSON.stringify(input.links ?? []),
          JSON.stringify(input.requiredPermissions ?? []),
          input.errorCode ?? null,
          createdAt,
        ],
      );
      await transaction.query(
        "UPDATE conversations SET updated_at=$2,version=version+1 WHERE id=$1",
        [input.conversationId, createdAt],
      );
      return mapWorkspaceArtifact(result.rows[0] as Row);
    });
  }

  async listWorkspaceArtifacts(
    conversationId: string,
    ownerUserId: string,
    limit = 50,
  ): Promise<readonly WorkspaceArtifact[]> {
    const result = await this.database.query<Row>(
      `SELECT a.* FROM workspace_artifacts a
       JOIN conversations c ON c.id=a.conversation_id
       WHERE a.conversation_id=$1 AND c.owner_user_id=$2
       ORDER BY a.created_at DESC,a.id DESC LIMIT $3`,
      [conversationId, ownerUserId, clampLimit(limit)],
    );
    return result.rows.map(mapWorkspaceArtifact);
  }

  async getWorkspaceArtifact(id: string, ownerUserId: string): Promise<WorkspaceArtifact | null> {
    const result = await this.database.query<Row>(
      `SELECT a.* FROM workspace_artifacts a
       JOIN conversations c ON c.id=a.conversation_id
       WHERE a.id=$1 AND c.owner_user_id=$2`,
      [id, ownerUserId],
    );
    return result.rows[0] ? mapWorkspaceArtifact(result.rows[0]) : null;
  }

  async createSuggestedAction(
    input: CreateSuggestedActionInput,
  ): Promise<SuggestedActionCreationResult> {
    const createdAt =
      optionalIso(input.createdAt, "Suggested action creation time") ?? new Date().toISOString();
    const expiresAt = optionalIso(input.expiresAt, "Suggested action expiry time") as string;
    if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
      throw new Phase1ValidationError("Suggested action expiry must be after creation.");
    }
    const idempotencyKey = requiredText(
      input.idempotencyKey,
      "Suggested action idempotency key",
      200,
    );
    return this.database.transaction(async (transaction) => {
      await this.requireOwnedConversation(
        transaction,
        input.conversationId,
        input.requestedByUserId,
        true,
      );
      const inserted = await transaction.query<Row>(
        `INSERT INTO suggested_actions
         (id,conversation_id,requested_by_user_id,action_type,status,payload,required_permission,idempotency_key,correlation_id,expires_at,created_at,updated_at,version)
         VALUES ($1,$2,$3,'task.create','pending',$4::jsonb,$5,$6,$7,$8,$9,$9,1)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
        [
          input.id ?? randomUUID(),
          input.conversationId,
          input.requestedByUserId,
          JSON.stringify(input.payload),
          requiredText(input.requiredPermission, "Required permission", 120),
          idempotencyKey,
          requiredText(input.correlationId, "Suggested action correlation ID", 128),
          expiresAt,
          createdAt,
        ],
      );
      if (inserted.rows[0]) {
        const action = mapSuggestedAction(inserted.rows[0]);
        await insertActivity(transaction, {
          type: "action.previewed",
          summary: "Task creation action previewed.",
          actorUserId: input.requestedByUserId,
          correlationId: action.correlationId,
          metadata: { suggestedActionId: action.id, actionType: action.actionType },
          createdAt,
        });
        return { action, reused: false };
      }
      const existing = await transaction.query<Row>(
        `SELECT * FROM suggested_actions
         WHERE idempotency_key=$1 AND conversation_id=$2 AND requested_by_user_id=$3`,
        [idempotencyKey, input.conversationId, input.requestedByUserId],
      );
      if (!existing.rows[0]) {
        throw new Phase1RepositoryError(
          "PHASE1_IDEMPOTENCY_CONFLICT",
          "Suggested action idempotency key belongs to another request.",
        );
      }
      return { action: mapSuggestedAction(existing.rows[0]), reused: true };
    });
  }

  async getSuggestedAction(id: string, requestedByUserId: string): Promise<SuggestedAction | null> {
    const result = await this.database.query<Row>(
      "SELECT * FROM suggested_actions WHERE id=$1 AND requested_by_user_id=$2",
      [id, requestedByUserId],
    );
    return result.rows[0] ? mapSuggestedAction(result.rows[0]) : null;
  }

  async listSuggestedActions(
    conversationId: string,
    requestedByUserId: string,
    limit = 25,
  ): Promise<readonly SuggestedAction[]> {
    const result = await this.database.query<Row>(
      `SELECT * FROM suggested_actions WHERE conversation_id=$1 AND requested_by_user_id=$2
       ORDER BY created_at DESC,id DESC LIMIT $3`,
      [conversationId, requestedByUserId, clampLimit(limit, 25)],
    );
    return result.rows.map(mapSuggestedAction);
  }

  async presentTaskActionExecution(
    input: PresentTaskActionExecutionInput,
  ): Promise<PresentTaskActionExecutionResult> {
    const executionId = requiredUuid(input.executionId, "Action execution ID");
    const taskId = requiredUuid(input.taskId, "Task ID");
    const taskTitle = requiredText(input.taskTitle, "Task title");
    const correlationId = requiredText(input.correlationId, "Message correlation ID", 128);
    const expectedConversationVersion = requiredAiCommandGeneration(
      input.expectedConversationVersion,
    );
    const presentedAt =
      optionalIso(input.presentedAt, "Action presentation time") ?? new Date().toISOString();
    return this.database.transaction(async (transaction) => {
      const conversation = await this.requireOwnedConversation(
        transaction,
        input.conversationId,
        input.ownerUserId,
        true,
      );
      const evidence = await transaction.query<Row>(
        `SELECT e.result,a.conversation_id,a.requested_by_user_id
         FROM action_executions e
         JOIN suggested_actions a ON a.id=e.suggested_action_id
         WHERE e.id=$1 AND e.actor_user_id=$2`,
        [executionId, input.ownerUserId],
      );
      const evidenceRow = evidence.rows[0];
      const executionResult = json<{ readonly taskId?: unknown }>(evidenceRow?.result, {});
      if (
        !evidenceRow ||
        evidenceRow.conversation_id !== conversation.id ||
        evidenceRow.requested_by_user_id !== input.ownerUserId ||
        executionResult.taskId !== taskId
      ) {
        throw new Phase1OwnershipError();
      }
      const [existingMessage, existingArtifact] = await Promise.all([
        transaction.query<Row>("SELECT * FROM assistant_messages WHERE id=$1", [executionId]),
        transaction.query<Row>("SELECT * FROM workspace_artifacts WHERE id=$1", [executionId]),
      ]);
      if (existingMessage.rows[0] || existingArtifact.rows[0]) {
        if (
          existingMessage.rows[0]?.conversation_id === conversation.id &&
          existingMessage.rows[0]?.role === "assistant" &&
          existingArtifact.rows[0]?.conversation_id === conversation.id &&
          existingArtifact.rows[0]?.type === "action-result"
        ) {
          return { status: "completed" };
        }
        throw new Phase1RepositoryError(
          "PHASE1_ACTION_PRESENTATION_CONFLICT",
          "Verified action result presentation conflicts with existing state.",
        );
      }
      if (conversation.version !== expectedConversationVersion) {
        return { status: "superseded" };
      }
      await transaction.query(
        `INSERT INTO assistant_messages
         (id,conversation_id,role,content,provider,model,router_version,execution_ms,correlation_id,required_permissions,created_at,updated_at,version)
         VALUES ($1,$2,'assistant',$3,'simulated','deterministic-demo-router','phase1-demo-router-v1',0,$4,$5::jsonb,$6,$6,1)`,
        [
          executionId,
          conversation.id,
          `Task “${taskTitle}” was created and verified in the database. Activity, approval, execution, and audit evidence were recorded. Repeated confirmation safely restores this same result.`,
          correlationId,
          JSON.stringify(["ai-command.view", "tasks.view"]),
          presentedAt,
        ],
      );
      await transaction.query(
        `INSERT INTO workspace_artifacts
         (id,conversation_id,requested_by_user_id,type,title,subtitle,state,payload,sources,links,required_permissions,error_code,created_at,updated_at,version)
         VALUES ($1,$2,$3,'action-result','Task created','Verified internal database write','ready',$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,NULL,$8,$8,1)`,
        [
          executionId,
          conversation.id,
          input.ownerUserId,
          JSON.stringify({
            taskId,
            executionId,
            message: `Task “${taskTitle}” is persisted exactly once.`,
            href: `/tasks/${taskId}`,
            idempotent: true,
          }),
          JSON.stringify([
            { id: taskId, type: "task", title: taskTitle, href: `/tasks/${taskId}` },
          ]),
          JSON.stringify([{ label: "Open task", href: `/tasks/${taskId}` }]),
          JSON.stringify(["tasks.view"]),
          presentedAt,
        ],
      );
      const updated = await transaction.query<Row>(
        `UPDATE conversations SET updated_at=$3,version=version+1
         WHERE id=$1 AND owner_user_id=$2 AND version=$4 RETURNING id`,
        [conversation.id, input.ownerUserId, presentedAt, expectedConversationVersion],
      );
      if (!updated.rows[0]) {
        throw new Phase1RepositoryError(
          "PHASE1_CONCURRENT_UPDATE",
          "Verified action result presentation could not be finalized.",
        );
      }
      return { status: "completed" };
    });
  }

  private async existingTaskActionExecution(
    executor: SqlExecutor,
    suggestedActionId: string,
    actorUserId: string,
    idempotencyKey: string,
  ): Promise<TaskActionExecutionResult | null> {
    const executionResult = await executor.query<Row>(
      `SELECT e.* FROM action_executions e
       JOIN suggested_actions a ON a.id=e.suggested_action_id
       WHERE a.requested_by_user_id=$1 AND (e.suggested_action_id=$2 OR e.idempotency_key=$3)
       ORDER BY e.created_at LIMIT 1`,
      [actorUserId, suggestedActionId, idempotencyKey],
    );
    const executionRow = executionResult.rows[0];
    if (!executionRow) return null;
    const execution = mapActionExecution(executionRow);
    if (execution.suggestedActionId !== suggestedActionId) {
      throw new TaskActionExecutionError(
        "PHASE1_IDEMPOTENCY_CONFLICT",
        "Execution idempotency key belongs to another action.",
      );
    }
    const taskId = execution.result.taskId;
    if (typeof taskId !== "string") {
      throw new TaskActionExecutionError(
        "PHASE1_EXECUTION_RESULT_INVALID",
        "Prior task execution result is incomplete.",
      );
    }
    const [actionResult, approvalResult, taskResult] = await Promise.all([
      executor.query<Row>("SELECT * FROM suggested_actions WHERE id=$1", [suggestedActionId]),
      executor.query<Row>("SELECT * FROM action_approvals WHERE suggested_action_id=$1", [
        suggestedActionId,
      ]),
      executor.query<Row>("SELECT * FROM tasks WHERE id=$1", [taskId]),
    ]);
    if (!actionResult.rows[0] || !approvalResult.rows[0] || !taskResult.rows[0]) {
      throw new TaskActionExecutionError(
        "PHASE1_EXECUTION_EVIDENCE_INCOMPLETE",
        "Prior task execution evidence is incomplete.",
      );
    }
    return {
      action: mapSuggestedAction(actionResult.rows[0]),
      approval: mapActionApproval(approvalResult.rows[0]),
      execution,
      task: mapTask(taskResult.rows[0]),
      reused: true,
    };
  }

  async approveAndExecuteTaskAction(
    input: ApproveAndExecuteTaskActionInput,
  ): Promise<TaskActionExecutionResult> {
    if (input.confirmation !== TASK_ACTION_CONFIRMATION) {
      throw new TaskActionExecutionError(
        "PHASE1_ACTION_CONFIRMATION_REQUIRED",
        "Exact task action confirmation is required.",
      );
    }
    const executedAt =
      optionalIso(input.executedAt, "Action execution time") ?? new Date().toISOString();
    const permissionRevalidations = [
      input.permissionRevalidation,
      ...(input.additionalPermissionRevalidations ?? []),
    ].map((revalidation) => ({
      ...revalidation,
      checkedAt: optionalIso(revalidation.checkedAt, "Permission revalidation time") as string,
    }));
    for (const revalidation of permissionRevalidations) {
      const revalidationAge = Date.parse(executedAt) - Date.parse(revalidation.checkedAt);
      if (revalidationAge < -30_000 || revalidationAge > PERMISSION_REVALIDATION_MAX_AGE_MS) {
        throw new TaskActionExecutionError(
          "PHASE1_PERMISSION_REVALIDATION_STALE",
          "Permission must be revalidated immediately before execution.",
        );
      }
    }
    const idempotencyKey = requiredText(input.idempotencyKey, "Execution idempotency key", 200);
    return this.database.transaction(async (transaction) => {
      const prior = await this.existingTaskActionExecution(
        transaction,
        input.suggestedActionId,
        input.actorUserId,
        idempotencyKey,
      );
      if (prior) return prior;

      const actionResult = await transaction.query<Row>(
        "SELECT * FROM suggested_actions WHERE id=$1 AND requested_by_user_id=$2 FOR UPDATE",
        [input.suggestedActionId, input.actorUserId],
      );
      if (!actionResult.rows[0]) throw new Phase1OwnershipError();
      let action = mapSuggestedAction(actionResult.rows[0]);
      const afterLock = await this.existingTaskActionExecution(
        transaction,
        input.suggestedActionId,
        input.actorUserId,
        idempotencyKey,
      );
      if (afterLock) return afterLock;
      if (action.status === "denied") {
        throw new TaskActionExecutionError(
          "PHASE1_ACTION_SUPERSEDED",
          "The suggested action was superseded by a newer AI Command request.",
        );
      }
      if (action.status === "failed") {
        throw new TaskActionExecutionError(
          "PHASE1_ACTION_NOT_EXECUTABLE",
          "The suggested action is no longer executable.",
        );
      }
      if (Date.parse(action.expiresAt) <= Date.parse(executedAt)) {
        throw new TaskActionExecutionError(
          "PHASE1_ACTION_EXPIRED",
          "The suggested action expired before confirmation.",
        );
      }
      const requiredPermissions = new Set<string>([
        action.requiredPermission,
        "ai-command.view",
        "tasks.view",
      ]);
      if (typeof action.payload.companyId === "string") {
        requiredPermissions.add("companies.view");
      }
      if (typeof action.payload.contactId === "string") {
        requiredPermissions.add("contacts.view");
      }
      if (typeof action.payload.leadId === "string") {
        requiredPermissions.add("leads.view");
      }
      const declaredPermissions = action.payload.requiredPermissions;
      if (declaredPermissions !== undefined) {
        if (
          !Array.isArray(declaredPermissions) ||
          declaredPermissions.some((permission) => typeof permission !== "string")
        ) {
          throw new TaskActionExecutionError(
            "PHASE1_PERMISSION_REVALIDATION_FAILED",
            "The action permission requirements are invalid.",
          );
        }
        for (const permission of declaredPermissions as readonly string[]) {
          requiredPermissions.add(permission);
        }
      }
      const permissionsRevalidated = [...requiredPermissions].every((permission) =>
        permissionRevalidations.some(
          (revalidation) => revalidation.allowed === true && revalidation.permission === permission,
        ),
      );
      if (!permissionsRevalidated) {
        throw new TaskActionExecutionError(
          "PHASE1_PERMISSION_REVALIDATION_FAILED",
          "Every current permission required by this action must be revalidated.",
        );
      }

      const approvalInsert = await transaction.query<Row>(
        `INSERT INTO action_approvals
         (id,suggested_action_id,actor_user_id,decision,correlation_id,created_at,updated_at,version)
         VALUES ($1,$2,$3,'approved',$4,$5,$5,1)
         ON CONFLICT (suggested_action_id) DO NOTHING RETURNING *`,
        [randomUUID(), action.id, input.actorUserId, input.correlationId, executedAt],
      );
      const approvalResult = approvalInsert.rows[0]
        ? approvalInsert
        : await transaction.query<Row>(
            "SELECT * FROM action_approvals WHERE suggested_action_id=$1",
            [action.id],
          );
      const approval = mapActionApproval(approvalResult.rows[0] as Row);
      if (approval.decision !== "approved" || approval.actorUserId !== input.actorUserId) {
        throw new TaskActionExecutionError(
          "PHASE1_ACTION_APPROVAL_CONFLICT",
          "The action has a conflicting approval decision.",
        );
      }
      const approvedResult = await transaction.query<Row>(
        `UPDATE suggested_actions SET status='approved',updated_at=$2,version=version+1
         WHERE id=$1 AND status='pending' RETURNING *`,
        [action.id, executedAt],
      );
      if (approvedResult.rows[0]) action = mapSuggestedAction(approvedResult.rows[0]);

      const payload = action.payload;
      const payloadPriority = payload.priority;
      const priority: TaskPriority =
        typeof payloadPriority === "string" && TASK_PRIORITIES.has(payloadPriority as TaskPriority)
          ? (payloadPriority as TaskPriority)
          : "normal";
      const taskInput = normalizeTaskInput({
        title: typeof payload.title === "string" ? payload.title : "",
        description: typeof payload.description === "string" ? payload.description : null,
        priority,
        assigneeUserId:
          typeof payload.assigneeUserId === "string" ? payload.assigneeUserId : input.actorUserId,
        dueAt: typeof payload.dueAt === "string" ? payload.dueAt : null,
        companyId: typeof payload.companyId === "string" ? payload.companyId : null,
        contactId: typeof payload.contactId === "string" ? payload.contactId : null,
        leadId: typeof payload.leadId === "string" ? payload.leadId : null,
        createdByUserId: input.actorUserId,
        correlationId: input.correlationId,
        createdAt: executedAt,
      });
      await requireValidTaskRelationships(transaction, taskInput.companyId, taskInput.contactId);
      await requireValidLeadRelationship(transaction, taskInput.leadId);
      const task = await insertTask(transaction, taskInput);
      await insertActivity(transaction, {
        type: "action.approved",
        summary: "Task creation action approved.",
        actorUserId: input.actorUserId,
        taskId: task.id,
        correlationId: input.correlationId,
        metadata: { suggestedActionId: action.id },
        createdAt: executedAt,
      });
      await insertActivity(transaction, {
        type: "task.created",
        summary: `Task created: ${task.title}`,
        actorUserId: input.actorUserId,
        companyId: task.companyId,
        contactId: task.contactId,
        taskId: task.id,
        leadId: task.leadId,
        correlationId: input.correlationId,
        metadata: { source: "confirmed-suggested-action", suggestedActionId: action.id },
        createdAt: executedAt,
      });

      const executionResult = await transaction.query<Row>(
        `INSERT INTO action_executions
         (id,suggested_action_id,actor_user_id,status,idempotency_key,result,error_code,correlation_id,created_at,updated_at,version)
         VALUES ($1,$2,$3,'succeeded',$4,$5::jsonb,NULL,$6,$7,$7,1) RETURNING *`,
        [
          randomUUID(),
          action.id,
          input.actorUserId,
          idempotencyKey,
          JSON.stringify({ taskId: task.id, actionType: action.actionType }),
          input.correlationId,
          executedAt,
        ],
      );
      const execution = mapActionExecution(executionResult.rows[0] as Row);
      const finalActionResult = await transaction.query<Row>(
        `UPDATE suggested_actions SET status='executed',updated_at=$2,version=version+1
         WHERE id=$1 AND status='approved' RETURNING *`,
        [action.id, executedAt],
      );
      action = mapSuggestedAction(finalActionResult.rows[0] as Row);
      await insertActivity(transaction, {
        type: "action.executed",
        summary: "Confirmed task creation action executed.",
        actorUserId: input.actorUserId,
        taskId: task.id,
        correlationId: input.correlationId,
        metadata: { suggestedActionId: action.id, executionId: execution.id },
        createdAt: executedAt,
      });
      await insertAudit(transaction, {
        eventType: "assistant.action-executed",
        action: "assistant.task.create",
        actorUserId: input.actorUserId,
        resourceType: "action-execution",
        resourceId: execution.id,
        correlationId: input.correlationId,
        metadata: {
          suggestedActionId: action.id,
          taskId: task.id,
          permission: action.requiredPermission,
          idempotencyKey,
        },
        createdAt: executedAt,
      });
      return { action, approval, execution, task, reused: false };
    });
  }
}
