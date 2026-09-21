import type { AuditSink, EntityId, RoleId } from "@bea/domain";

export { DEMO_ROLE_IDS, type RoleId } from "@bea/domain";

export const PERMISSIONS = {
  HOME_VIEW: "home.view",
  COMPANIES_VIEW: "companies.view",
  COMPANIES_MANAGE: "companies.manage",
  CONTACTS_VIEW: "contacts.view",
  CONTACTS_MANAGE: "contacts.manage",
  LEADS_VIEW: "leads.view",
  LEADS_MANAGE: "leads.manage",
  LEADS_REVIEW: "leads.review",
  LEADS_DISQUALIFY: "leads.disqualify",
  PROPOSALS_VIEW: "proposals.view",
  PROPOSALS_CREATE: "proposals.create",
  PROPOSALS_EDIT: "proposals.edit",
  PROPOSALS_SUBMIT: "proposals.submit",
  PROPOSALS_REVIEW: "proposals.review",
  PROPOSALS_APPROVE: "proposals.approve",
  PROPOSALS_CANCEL: "proposals.cancel",
  PROPOSALS_OVERRIDE_REQUEST: "proposals.override.request",
  PROPOSALS_OVERRIDE_APPROVE: "proposals.override.approve",
  PROPOSALS_DELIVERY_PLAN: "proposals.delivery.plan",
  PROPOSALS_WORK_VIEW: "proposals.work.view",
  PROPOSALS_WORK_CLAIM: "proposals.work.claim",
  SERVICE_CATALOG_VIEW: "service_catalog.view",
  SERVICE_CATALOG_MANAGE: "service_catalog.manage",
  SERVICE_CATALOG_PUBLISH: "service_catalog.publish",
  COMMERCIAL_POLICY_VIEW: "commercial_policy.view",
  COMMERCIAL_POLICY_MANAGE: "commercial_policy.manage",
  PROJECTS_VIEW: "projects.view",
  TASKS_VIEW: "tasks.view",
  TASKS_VIEW_ALL: "tasks.view-all",
  TASKS_MANAGE: "tasks.manage",
  ACTIVITIES_VIEW: "activities.view",
  NOTIFICATIONS_VIEW: "notifications.view",
  NOTIFICATIONS_MANAGE: "notifications.manage",
  SEARCH_VIEW: "search.view",
  AI_COMMAND_VIEW: "ai-command.view",
  AI_COMMAND_RUN: "ai-command.run",
  TASK_ACTION_EXECUTE: "ai-command.task-action.execute",
  AI_INTEGRATION_HEALTH_VIEW: "ai-command.integration-health.view",
  WORKFLOW_VIEW: "workflow.view",
  COMMUNICATIONS_VIEW: "communications.view",
  DOCUMENTS_VIEW: "documents.view",
  ASK_BEA_VIEW: "ask-bea.view",
  REPORTS_VIEW: "reports.view",
  AUTOMATIONS_VIEW: "automations.view",
  INTEGRATIONS_VIEW: "integrations.view",
  INTEGRATIONS_MANAGE: "integrations.manage",
  ADMINISTRATION_VIEW: "administration.view",
  USERS_MANAGE: "users.manage",
  AUDIT_VIEW: "audit.view",
  SETTINGS_MANAGE: "settings.manage",
  EXECUTIVE_PROFILE_USE: "executive-profile.use",
  EXECUTIVE_PROFILE_VIEW: "executive-profile.view",
  EXECUTIVE_PROFILE_MANAGE: "executive-profile.manage",
  FOUNDATION_WORKFLOW_RUN: "automation.foundation.run",
  OPERATIONS_BOARD_VIEW: "operations.board.view",
  INSPECTIONS_VIEW: "inspections.view",
  INSPECTIONS_SUBMIT: "inspections.submit",
  INSPECTIONS_CORRECT: "inspections.correct",
  REPORTS_REVIEW: "reports.review",
  REPORTS_APPROVE: "reports.approve",
  REPORTS_DELIVER: "reports.deliver",
  EXCEPTIONS_VIEW: "exceptions.view",
  EXCEPTIONS_MANAGE: "exceptions.manage",
  AUTOMATIONS_OPERATE: "automations.operate",
  PROJECTS_MANAGE: "projects.manage",
  DIGITAL_WORKFORCE_VIEW: "digital-workforce.view",
  DIGITAL_WORKFORCE_MANAGE: "digital-workforce.manage",
  DIGITAL_WORKFORCE_PUBLISH: "digital-workforce.publish",
  DIGITAL_WORKFORCE_RUN: "digital-workforce.run",
  DIGITAL_WORKFORCE_CANCEL: "digital-workforce.cancel",
  DIGITAL_WORKFORCE_APPROVE: "digital-workforce.approve",
  DIGITAL_WORKFORCE_AUDIT: "digital-workforce.audit",
  CONFIGURATION_VIEW: "configuration.view",
  CONFIGURATION_DRAFT: "configuration.draft",
  CONFIGURATION_VALIDATE: "configuration.validate",
  CONFIGURATION_PUBLISH: "configuration.publish",
  CONFIGURATION_ACTIVATE: "configuration.activate",
  CONFIGURATION_ARCHIVE: "configuration.archive",
  CONFIGURATION_MAPPING_EDIT: "configuration.mapping.edit",
  CONFIGURATION_DRY_RUN: "configuration.dry-run",
  CONFIGURATION_POLICY_APPROVE: "configuration.policy.approve",
  WORK_VIEW: "work.view",
  WORK_CLAIM: "work.claim",
  WORK_UPDATE: "work.update",
  WORK_REASSIGN: "work.reassign",
  WORK_MANAGE: "work.manage",
  WORK_AUDIT: "work.audit",
  WORK_NOTIFICATIONS_VIEW: "work.notifications.view",
  WORK_SCHEDULES_VIEW: "work.schedules.view",
  WORK_SCHEDULES_MANAGE: "work.schedules.manage",
  WORK_RECONCILE: "work.reconcile",
  ORCHESTRATION_POLICY_VIEW: "orchestration.policy.view",
  ORCHESTRATION_POLICY_MANAGE: "orchestration.policy.manage",
  ORCHESTRATION_POLICY_ACTIVATE: "orchestration.policy.activate",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const allPermissions = Object.freeze(Object.values(PERMISSIONS)) as readonly Permission[];

export const ROLE_PERMISSION_MATRIX: Readonly<Record<RoleId, readonly Permission[]>> = {
  "owner-admin": allPermissions,
  sales: [
    PERMISSIONS.HOME_VIEW,
    PERMISSIONS.COMPANIES_VIEW,
    PERMISSIONS.COMPANIES_MANAGE,
    PERMISSIONS.CONTACTS_VIEW,
    PERMISSIONS.CONTACTS_MANAGE,
    PERMISSIONS.LEADS_VIEW,
    PERMISSIONS.LEADS_MANAGE,
    PERMISSIONS.LEADS_REVIEW,
    PERMISSIONS.LEADS_DISQUALIFY,
    PERMISSIONS.PROPOSALS_VIEW,
    PERMISSIONS.PROPOSALS_CREATE,
    PERMISSIONS.PROPOSALS_EDIT,
    PERMISSIONS.PROPOSALS_SUBMIT,
    PERMISSIONS.PROPOSALS_OVERRIDE_REQUEST,
    PERMISSIONS.PROPOSALS_DELIVERY_PLAN,
    PERMISSIONS.PROPOSALS_WORK_VIEW,
    PERMISSIONS.PROPOSALS_WORK_CLAIM,
    PERMISSIONS.TASKS_VIEW,
    PERMISSIONS.TASKS_MANAGE,
    PERMISSIONS.ACTIVITIES_VIEW,
    PERMISSIONS.NOTIFICATIONS_VIEW,
    PERMISSIONS.NOTIFICATIONS_MANAGE,
    PERMISSIONS.SEARCH_VIEW,
    PERMISSIONS.AI_COMMAND_VIEW,
    PERMISSIONS.AI_COMMAND_RUN,
    PERMISSIONS.TASK_ACTION_EXECUTE,
    PERMISSIONS.COMMUNICATIONS_VIEW,
    PERMISSIONS.DOCUMENTS_VIEW,
    PERMISSIONS.OPERATIONS_BOARD_VIEW,
    PERMISSIONS.INSPECTIONS_VIEW,
    PERMISSIONS.REPORTS_VIEW,
    PERMISSIONS.DIGITAL_WORKFORCE_VIEW,
    PERMISSIONS.DIGITAL_WORKFORCE_RUN,
  ],
  operations: [
    PERMISSIONS.HOME_VIEW,
    PERMISSIONS.COMPANIES_VIEW,
    PERMISSIONS.COMPANIES_MANAGE,
    PERMISSIONS.CONTACTS_VIEW,
    PERMISSIONS.CONTACTS_MANAGE,
    PERMISSIONS.PROJECTS_VIEW,
    PERMISSIONS.PROJECTS_MANAGE,
    PERMISSIONS.TASKS_VIEW,
    PERMISSIONS.TASKS_MANAGE,
    PERMISSIONS.ACTIVITIES_VIEW,
    PERMISSIONS.NOTIFICATIONS_VIEW,
    PERMISSIONS.NOTIFICATIONS_MANAGE,
    PERMISSIONS.SEARCH_VIEW,
    PERMISSIONS.AI_COMMAND_VIEW,
    PERMISSIONS.AI_COMMAND_RUN,
    PERMISSIONS.TASK_ACTION_EXECUTE,
    PERMISSIONS.WORKFLOW_VIEW,
    PERMISSIONS.COMMUNICATIONS_VIEW,
    PERMISSIONS.DOCUMENTS_VIEW,
    PERMISSIONS.AUTOMATIONS_VIEW,
    PERMISSIONS.AUTOMATIONS_OPERATE,
    PERMISSIONS.FOUNDATION_WORKFLOW_RUN,
    PERMISSIONS.OPERATIONS_BOARD_VIEW,
    PERMISSIONS.INSPECTIONS_VIEW,
    PERMISSIONS.INSPECTIONS_SUBMIT,
    PERMISSIONS.INSPECTIONS_CORRECT,
    PERMISSIONS.REPORTS_VIEW,
    PERMISSIONS.REPORTS_REVIEW,
    PERMISSIONS.REPORTS_APPROVE,
    PERMISSIONS.EXCEPTIONS_VIEW,
    PERMISSIONS.EXCEPTIONS_MANAGE,
    PERMISSIONS.DIGITAL_WORKFORCE_VIEW,
    PERMISSIONS.DIGITAL_WORKFORCE_RUN,
    PERMISSIONS.CONFIGURATION_VIEW,
    PERMISSIONS.CONFIGURATION_DRY_RUN,
    PERMISSIONS.WORK_VIEW,
    PERMISSIONS.WORK_CLAIM,
    PERMISSIONS.WORK_UPDATE,
    PERMISSIONS.WORK_NOTIFICATIONS_VIEW,
    PERMISSIONS.PROPOSALS_VIEW,
  ],
  "executive-readonly": [
    PERMISSIONS.HOME_VIEW,
    PERMISSIONS.COMPANIES_VIEW,
    PERMISSIONS.CONTACTS_VIEW,
    PERMISSIONS.TASKS_VIEW,
    PERMISSIONS.TASKS_VIEW_ALL,
    PERMISSIONS.ACTIVITIES_VIEW,
    PERMISSIONS.NOTIFICATIONS_VIEW,
    PERMISSIONS.SEARCH_VIEW,
    PERMISSIONS.AI_COMMAND_VIEW,
    PERMISSIONS.AI_COMMAND_RUN,
    PERMISSIONS.REPORTS_VIEW,
    PERMISSIONS.OPERATIONS_BOARD_VIEW,
    PERMISSIONS.INSPECTIONS_VIEW,
    PERMISSIONS.EXCEPTIONS_VIEW,
    PERMISSIONS.DIGITAL_WORKFORCE_VIEW,
    PERMISSIONS.DIGITAL_WORKFORCE_RUN,
    PERMISSIONS.CONFIGURATION_VIEW,
    PERMISSIONS.WORK_VIEW,
    PERMISSIONS.WORK_NOTIFICATIONS_VIEW,
    PERMISSIONS.WORK_SCHEDULES_VIEW,
    PERMISSIONS.PROPOSALS_VIEW,
  ],
  "integration-admin": [
    PERMISSIONS.HOME_VIEW,
    PERMISSIONS.SEARCH_VIEW,
    PERMISSIONS.AI_COMMAND_VIEW,
    PERMISSIONS.AI_COMMAND_RUN,
    PERMISSIONS.AI_INTEGRATION_HEALTH_VIEW,
    PERMISSIONS.INTEGRATIONS_VIEW,
    PERMISSIONS.INTEGRATIONS_MANAGE,
    PERMISSIONS.ADMINISTRATION_VIEW,
    PERMISSIONS.SETTINGS_MANAGE,
    PERMISSIONS.CONFIGURATION_VIEW,
    PERMISSIONS.CONFIGURATION_DRAFT,
    PERMISSIONS.CONFIGURATION_VALIDATE,
    PERMISSIONS.CONFIGURATION_MAPPING_EDIT,
    PERMISSIONS.CONFIGURATION_DRY_RUN,
    PERMISSIONS.WORK_VIEW,
    PERMISSIONS.WORK_CLAIM,
    PERMISSIONS.WORK_UPDATE,
    PERMISSIONS.WORK_NOTIFICATIONS_VIEW,
    PERMISSIONS.WORK_SCHEDULES_VIEW,
    PERMISSIONS.WORK_SCHEDULES_MANAGE,
    PERMISSIONS.PROPOSALS_VIEW,
    PERMISSIONS.SERVICE_CATALOG_VIEW,
    PERMISSIONS.SERVICE_CATALOG_MANAGE,
    PERMISSIONS.COMMERCIAL_POLICY_VIEW,
    PERMISSIONS.COMMERCIAL_POLICY_MANAGE,
  ],
};

export type AuthorizationDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: "unauthenticated" | "permission-not-granted" | "invalid-requirement";
    };

export type TaskReadScope = "none" | "assigned" | "all";

export interface AuthorizationSubject {
  readonly roleIds: readonly RoleId[];
  readonly userId?: EntityId;
}

export function roleHasPermission(roleId: RoleId, permission: Permission): boolean {
  return ROLE_PERMISSION_MATRIX[roleId].includes(permission);
}

export function authorize(
  subject: AuthorizationSubject,
  permission: Permission | undefined,
): AuthorizationDecision {
  if (!permission) {
    return { allowed: false, reason: "invalid-requirement" };
  }
  if (subject.roleIds.length === 0) {
    return { allowed: false, reason: "unauthenticated" };
  }
  return subject.roleIds.some((roleId) => roleHasPermission(roleId, permission))
    ? { allowed: true }
    : { allowed: false, reason: "permission-not-granted" };
}

export function authorizeAll(
  subject: AuthorizationSubject,
  permissions: readonly Permission[],
): AuthorizationDecision {
  if (permissions.length === 0) {
    return { allowed: false, reason: "invalid-requirement" };
  }
  for (const permission of permissions) {
    const decision = authorize(subject, permission);
    if (!decision.allowed) {
      return decision;
    }
  }
  return { allowed: true };
}

export function resolveTaskReadScope(subject: AuthorizationSubject): TaskReadScope {
  if (!authorize(subject, PERMISSIONS.TASKS_VIEW).allowed) return "none";
  return authorize(subject, PERMISSIONS.TASKS_VIEW_ALL).allowed ||
    authorize(subject, PERMISSIONS.TASKS_MANAGE).allowed
    ? "all"
    : "assigned";
}

export class AccessDeniedError extends Error {
  readonly code = "ACCESS_DENIED";

  constructor(readonly reason: Exclude<AuthorizationDecision, { allowed: true }>["reason"]) {
    super("You do not have permission to perform this action.");
    this.name = "AccessDeniedError";
  }
}

export async function requireAuthorization(input: {
  subject: AuthorizationSubject;
  permission: Permission;
  audit?: AuditSink;
  action: string;
  resourceType?: string;
  resourceId?: EntityId;
  correlationId?: string;
}): Promise<void> {
  const decision = authorize(input.subject, input.permission);
  if (decision.allowed) {
    return;
  }

  if (input.audit) {
    await input.audit.record({
      eventType: "authorization.denied",
      action: input.action,
      outcome: "denied",
      actorUserId: input.subject.userId ?? null,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      correlationId: input.correlationId ?? null,
      metadata: { permission: input.permission, reason: decision.reason },
    });
  }
  throw new AccessDeniedError(decision.reason);
}
