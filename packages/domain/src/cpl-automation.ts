/** Bounded internal recipes. No scripts, provider calls or inferred human approvals. */
export const CPL_AUTOMATION_TRIGGERS = [
  "lead.ready",
  "proposal.awarded",
  "fieldwork.submitted",
  "report.approved",
  "delivery.recorded",
] as const;
export type CplAutomationTrigger = (typeof CPL_AUTOMATION_TRIGGERS)[number];
export const CPL_AUTOMATION_ROLES = [
  "owner",
  "admin",
  "manager",
  "reviewer",
  "member",
  "field-user",
] as const;
export type CplAutomationRole = (typeof CPL_AUTOMATION_ROLES)[number];
export type CplActionOwner =
  | { kind: "unassigned"; role: null; identityId: null }
  | { kind: "role"; role: CplAutomationRole; identityId: null }
  | { kind: "person"; role: null; identityId: string };
export interface CplAutomationRecipeInput {
  name: string;
  trigger: CplAutomationTrigger;
  enabled: boolean;
  /** Optional exact service-name filter; no arbitrary expressions. */
  service: string | null;
  /** For lead/field triggers only. Other triggers always prepare their bounded handoff. */
  prepareDraft: boolean;
  templateId: string | null;
  templateVersion: number | null;
  /** Explicit configurator attestation permitting this selected template for automatic draft creation. */
  templateApprovedForAutomation: boolean;
  owner: CplActionOwner;
  /** Elapsed hours after event time, not an invented service-level promise. */
  dueAfterHours: number | null;
  taskTitle: string;
}
export interface CplAutomationRecipe extends CplAutomationRecipeInput {
  id: string;
  organizationId: string;
  version: number;
  configuredByIdentityId: string;
  configuredAt: string;
  authorizedMembershipVersion: number;
  templateAuthorizedAt: string | null;
}
export interface CplBusinessEvent {
  id: string;
  organizationId: string;
  type: CplAutomationTrigger;
  sourceKind: "lead" | "proposal" | "visit" | "report" | "delivery";
  sourceId: string;
  sourceVersion: number;
  projectId: string | null;
  actorIdentityId: string;
  occurredAt: string;
  origin: "human" | "automation";
  causationExecutionId: string | null;
}
export type CplAutomationStatus =
  "queued" | "running" | "succeeded" | "retrying" | "failed" | "skipped" | "cancelled";
export type CplActionTargetKind =
  "lead" | "proposal" | "project" | "visit" | "report" | "package" | "execution";
export interface CplActionTarget {
  kind: CplActionTargetKind;
  id: string;
  projectId: string | null;
  version: number | null;
}
export interface CplAutomationResult {
  step: string;
  target: CplActionTarget;
  completedAt: string;
}
export interface CplAutomationExecution {
  id: string;
  organizationId: string;
  revision: number;
  event: CplBusinessEvent;
  recipeId: string;
  recipeVersion: number;
  recipeName: string;
  status: CplAutomationStatus;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
  results: CplAutomationResult[];
  availableActions: { canRetry: boolean; canCancel: boolean; canReplay: boolean };
}
export interface CplAutomationAttempt {
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "succeeded" | "retrying" | "failed" | "skipped" | "cancelled";
  errorCode: string | null;
}
export interface CplAutomationExecutionDetail extends CplAutomationExecution {
  attemptHistory: CplAutomationAttempt[];
}
export type CplActionTaskStatus =
  "open" | "in_progress" | "completed" | "dismissed" | "cancelled" | "blocked";
export type CplActionTaskGroup =
  | "next_actions"
  | "reviews"
  | "missing_information"
  | "delivery"
  | "closeout"
  | "automation_failures";
export interface CplActionTask {
  id: string;
  organizationId: string;
  revision: number;
  executionId: string | null;
  title: string;
  reason: string;
  group: CplActionTaskGroup;
  customerName: string | null;
  projectName: string | null;
  nextAction: string;
  isMine: boolean;
  target: CplActionTarget;
  owner: CplActionOwner;
  dueAt: string | null;
  status: CplActionTaskStatus;
  resolutionReason: string | null;
  createdAt: string;
  updatedAt: string;
  availableActions: {
    canAssign: boolean;
    canStart: boolean;
    canComplete: boolean;
    canDismiss: boolean;
  };
}
export interface CplAutomationWorkspace {
  recipes: CplAutomationRecipe[];
  executions: CplAutomationExecution[];
  tasks: CplActionTask[];
  /** Whole authorized tenant totals, independent of bounded lists. */
  counts: {
    openTasks: number;
    myTasks: number;
    reviews: number;
    missingInformation: number;
    delivery: number;
    closeout: number;
    failedExecutions: number;
    queuedExecutions: number;
    succeededExecutions: number;
  };
  currentIdentityId: string;
  members: { identityId: string; displayName: string; role: CplAutomationRole }[];
  proposalTemplates: { id: string; name: string; version: number }[];
  reportTemplates: { id: string; name: string; version: number }[];
  permissions: {
    canConfigure: boolean;
    canOperate: boolean;
    canAssign: boolean;
    canViewExecutions: boolean;
  };
  listLimit: number;
}
export class CplAutomationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CplAutomationError";
  }
}
export function cplAutomationFail(code = "CPL_AUTOMATION_INVALID_INPUT"): never {
  throw new CplAutomationError(code);
}
export function cplAutomationId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value)
  )
    cplAutomationFail();
  return value.toLowerCase();
}
export function cplAutomationText(value: unknown, maximum = 240, required = false): string {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    (required && !value.trim())
  )
    cplAutomationFail();
  return value.trim();
}
export function cplAutomationRevision(value: unknown, allowZero = false): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1) ||
    value > 1_000_000
  )
    cplAutomationFail();
  return value;
}
export function cplAutomationReason(value: unknown, required = false): string {
  if (
    typeof value !== "string" ||
    value.length > 2000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ||
    (required && !value.trim())
  )
    cplAutomationFail();
  return value.trim();
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) cplAutomationFail();
  return value as Record<string, unknown>;
}
export function normalizeCplActionOwner(input: unknown): CplActionOwner {
  const value = object(input);
  if (value.kind === "unassigned") return { kind: "unassigned", role: null, identityId: null };
  if (value.kind === "role" && (CPL_AUTOMATION_ROLES as readonly unknown[]).includes(value.role))
    return { kind: "role", role: value.role as CplAutomationRole, identityId: null };
  if (value.kind === "person")
    return { kind: "person", role: null, identityId: cplAutomationId(value.identityId) };
  return cplAutomationFail();
}
export function normalizeCplAutomationRecipe(input: unknown): CplAutomationRecipeInput {
  const value = object(input);
  if (
    !(CPL_AUTOMATION_TRIGGERS as readonly unknown[]).includes(value.trigger) ||
    typeof value.enabled !== "boolean" ||
    typeof value.prepareDraft !== "boolean" ||
    typeof value.templateApprovedForAutomation !== "boolean"
  )
    cplAutomationFail();
  const trigger = value.trigger as CplAutomationTrigger;
  const prepareDraft = value.prepareDraft;
  if (prepareDraft && !["lead.ready", "fieldwork.submitted"].includes(trigger)) cplAutomationFail();
  const templateId = value.templateId == null ? null : cplAutomationId(value.templateId);
  const templateVersion =
    value.templateVersion == null ? null : cplAutomationRevision(value.templateVersion);
  if (prepareDraft && (!templateId || !templateVersion || !value.templateApprovedForAutomation))
    cplAutomationFail("CPL_AUTOMATION_TEMPLATE_AUTHORIZATION_REQUIRED");
  if (
    !prepareDraft &&
    (templateId !== null || templateVersion !== null || value.templateApprovedForAutomation)
  )
    cplAutomationFail();
  const dueAfterHours =
    value.dueAfterHours == null ? null : cplAutomationRevision(value.dueAfterHours, true);
  if (dueAfterHours !== null && dueAfterHours > 8760) cplAutomationFail();
  const service = value.service == null ? null : cplAutomationText(value.service, 240, true);
  return {
    name: cplAutomationText(value.name, 160, true),
    trigger,
    enabled: value.enabled,
    service,
    prepareDraft,
    templateId,
    templateVersion,
    templateApprovedForAutomation: value.templateApprovedForAutomation,
    owner: normalizeCplActionOwner(value.owner),
    dueAfterHours,
    taskTitle: cplAutomationText(value.taskTitle, 240, true),
  };
}
export function cplAutomationDueAt(eventAt: string, hours: number | null): string | null {
  if (hours === null) return null;
  const at = Date.parse(eventAt);
  if (!Number.isFinite(at) || !Number.isSafeInteger(hours) || hours < 0 || hours > 8760)
    cplAutomationFail();
  return new Date(at + hours * 3_600_000).toISOString();
}
