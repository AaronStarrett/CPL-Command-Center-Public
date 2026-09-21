import type { EntityId, IsoDateTime, JsonObject, VersionedEntity } from "./entities.js";

export type CompanyStatus = "active" | "inactive" | "prospect";
export type ContactStatus = "active" | "inactive";
export type TaskStatus = "open" | "completed";
export type TaskPriority = "low" | "normal" | "high" | "urgent";

export interface Company extends VersionedEntity {
  name: string;
  industry: string | null;
  status: CompanyStatus;
  website: string | null;
  phone: string | null;
  notes: string | null;
  createdByUserId: EntityId | null;
}

export interface Contact extends VersionedEntity {
  companyId: EntityId | null;
  firstName: string;
  lastName: string;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
  status: ContactStatus;
  notes: string | null;
  createdByUserId: EntityId | null;
}

export interface Task extends VersionedEntity {
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeUserId: EntityId;
  dueAt: IsoDateTime | null;
  completedAt: IsoDateTime | null;
  companyId: EntityId | null;
  contactId: EntityId | null;
  leadId: EntityId | null;
  createdByUserId: EntityId;
}

export type ActivityType =
  | "authentication"
  | "company.created"
  | "company.updated"
  | "contact.created"
  | "contact.updated"
  | "lead.created"
  | "lead.updated"
  | "lead.status-changed"
  | "lead.disqualified"
  | "task.created"
  | "task.completed"
  | "action.previewed"
  | "action.approved"
  | "action.executed"
  | "authorization.denied"
  | "workflow";

export interface Activity extends VersionedEntity {
  type: ActivityType;
  summary: string;
  actorUserId: EntityId | null;
  companyId: EntityId | null;
  contactId: EntityId | null;
  taskId: EntityId | null;
  leadId: EntityId | null;
  correlationId: string | null;
  metadata: JsonObject;
}

export interface Notification extends VersionedEntity {
  userId: EntityId;
  type: string;
  title: string;
  body: string;
  sourceType: string | null;
  sourceId: EntityId | null;
  sourceHref: string | null;
  readAt: IsoDateTime | null;
}

export interface Conversation extends VersionedEntity {
  ownerUserId: EntityId;
  title: string;
  provider: string;
  model: string;
  routerVersion: string;
  status: "active" | "archived";
}

export interface AssistantMessage extends VersionedEntity {
  conversationId: EntityId;
  role: "assistant" | "system" | "user";
  content: string;
  provider: string | null;
  model: string | null;
  providerResponseId?: string | null;
  responseStatus?: "streaming" | "completed" | "cancelled" | "failed" | "incomplete";
  incompleteReason?: string | null;
  routerVersion: string | null;
  executionMs: number | null;
  correlationId: string;
  requiredPermissions: readonly string[];
}

export const WORKSPACE_ARTIFACT_TYPES = [
  "command-center-summary",
  "search-results",
  "company-list",
  "company-detail",
  "contact-list",
  "contact-detail",
  "task-list",
  "task-detail",
  "lead-list",
  "lead-detail",
  "activity-timeline",
  "notification-list",
  "integration-health-summary",
  "integration-detail",
  "workflow-run-list",
  "workflow-run-detail",
  "audit-summary",
  "action-preview",
  "action-result",
  "help",
  "empty",
  "error",
  "digital-workforce-organization",
  "digital-workforce-department",
  "digital-workforce-team",
  "digital-workforce-agent-list",
  "digital-workforce-agent-detail",
  "digital-workforce-agent-draft",
  "digital-workforce-run-list",
  "digital-workforce-run-trace",
  "digital-workforce-handoff-list",
  "digital-workforce-handoff-detail",
  "digital-workforce-approval",
  "digital-workforce-error",
  "digital-workforce-artifacts",
] as const;

export type WorkspaceArtifactType = (typeof WORKSPACE_ARTIFACT_TYPES)[number];
export type WorkspaceArtifactState = "ready" | "loading" | "empty" | "failed";

export interface WorkspaceArtifactSource {
  id: EntityId;
  type: string;
  title: string;
  href: string;
  domain?: string;
  retrievedAt?: IsoDateTime;
  providerItemId?: string;
  simulated?: boolean;
}

export interface WorkspaceArtifactLink {
  label: string;
  href: string;
}

export interface WorkspaceArtifact extends VersionedEntity {
  conversationId: EntityId;
  requestedByUserId: EntityId;
  type: WorkspaceArtifactType;
  title: string;
  subtitle: string | null;
  state: WorkspaceArtifactState;
  payload: JsonObject;
  sources: readonly WorkspaceArtifactSource[];
  links: readonly WorkspaceArtifactLink[];
  requiredPermissions: readonly string[];
  errorCode: string | null;
}

export interface SuggestedAction extends VersionedEntity {
  conversationId: EntityId;
  requestedByUserId: EntityId;
  actionType: "task.create";
  status: "pending" | "approved" | "executed" | "denied" | "failed";
  payload: JsonObject;
  requiredPermission: string;
  idempotencyKey: string;
  correlationId: string;
  expiresAt: IsoDateTime;
}

export interface ActionApproval extends VersionedEntity {
  suggestedActionId: EntityId;
  actorUserId: EntityId;
  decision: "approved" | "denied";
  correlationId: string;
}

export interface ActionExecution extends VersionedEntity {
  suggestedActionId: EntityId;
  actorUserId: EntityId;
  status: "succeeded" | "failed";
  idempotencyKey: string;
  result: JsonObject;
  errorCode: string | null;
  correlationId: string;
}

export interface Phase1SearchResult {
  id: EntityId;
  type: "company" | "contact" | "integration" | "task" | "workflow-run" | "lead";
  title: string;
  subtitle: string;
  href: string;
}
