import type {
  ActionApproval,
  ActionExecution,
  Activity,
  AiModelCacheRecord,
  AiProviderConnectionTest,
  AiRealtimeSessionRecord,
  AiResponseRun,
  AiToolCallRecord,
  AiUsageLedgerRecord,
  AssistantMessage,
  CompanyStatus,
  ContactStatus,
  Conversation,
  AuditOutcome,
  IntegrationConnectionStatus,
  IntegrationMode,
  IntegrationProviderType,
  JsonObject,
  JsonValue,
  GeneratedArtifactRecord,
  AiPresentationStatus,
  RequirementStatus,
  SettingSensitivity,
  StructuredError,
  SuggestedAction,
  TaskPriority,
  TaskStatus,
  WorkspaceArtifact,
  WorkspaceArtifactLink,
  WorkspaceArtifactSource,
  WorkflowStatus,
  LeadPartyRole,
  LeadSourceType,
  LeadStatus,
  ProjectStatus,
  InspectionStatus,
  ReportStatus,
  ReportVersionStatus,
  DeliveryStatus,
  DeliveryAuthorizationStatus,
  DeliveryDestinationKind,
  ExceptionStatus,
  ExceptionKind,
  AutomationJobStatus,
  ConnectorReadinessStatus,
  InspectionSourceChannel,
  EvidenceKind,
  FindingSeverity,
  ReportReviewDecision,
  SlaClockKind,
  SlaClockStatus,
  SlaPauseReason,
  SlaAttribution,
  ActorType,
  BlueprintKey,
  AutomationJobType,
  OperationsEventType,
  InspectionValidationItem,
  ReportRequirementSet,
  DigitalDepartmentStatus,
  DigitalTeamStatus,
  DigitalAgentStatus,
  DigitalAgentAvatar,
  DigitalAgentVersionLifecycle,
  DigitalWorkforceMemoryPolicy,
  DigitalWorkforceApprovalPolicy,
  DigitalAgentRunStatus,
  DigitalAgentStepType,
  DigitalAgentStepStatus,
  DigitalHandoffStatus,
  DigitalWorkforceRuntimeLimits,
  DigitalWorkforceToolGrant,
  DigitalWorkforceDataScopeGrant,
  DigitalWorkforceKnowledgeScopeGrant,
  DigitalWorkforceModelAssignment,
  DigitalWorkforceExecutionPlan,
  DigitalWorkforceHandoffPacket,
} from "@bea/domain";
import { getTableColumns } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow();
const version = () => integer("version").notNull().default(1);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    personaKey: text("persona_key"),
    email: text("email"),
    displayName: text("display_name").notNull(),
    title: text("title"),
    status: text("status").notNull().default("active"),
    createdByUserId: uuid("created_by_user_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [
    uniqueIndex("users_email_uidx").on(table.email),
    uniqueIndex("users_persona_key_uidx").on(table.personaKey),
    index("users_status_idx").on(table.status),
  ],
);

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    status: text("status").notNull().default("active"),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [uniqueIndex("roles_key_uidx").on(table.key)],
);

export const permissions = pgTable(
  "permissions",
  {
    id: uuid("id").primaryKey(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    status: text("status").notNull().default("active"),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [uniqueIndex("permissions_key_uidx").on(table.key)],
);

export const userRoles = pgTable(
  "user_roles",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.roleId] })],
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.roleId, table.permissionId] })],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_uidx").on(table.tokenHash),
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_expires_at_idx").on(table.expiresAt),
  ],
);

export const authIdentities = pgTable(
  "auth_identities",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").$type<"local-owner" | "microsoft-entra">().notNull(),
    subject: text("subject").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [
    uniqueIndex("auth_identities_provider_subject_uidx").on(table.provider, table.subject),
    uniqueIndex("auth_identities_provider_user_uidx").on(table.provider, table.userId),
    index("auth_identities_user_id_idx").on(table.userId),
  ],
);

export const localOwnerCredentials = pgTable(
  "local_owner_credentials",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    recoveryCodeHash: text("recovery_code_hash").notNull(),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true, mode: "string" }),
    passwordChangedAt: timestamp("password_changed_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [
    uniqueIndex("local_owner_credentials_username_uidx").on(table.username),
    index("local_owner_credentials_locked_until_idx").on(table.lockedUntil),
  ],
);

export const workflowDefinitions = pgTable("workflow_definitions", {
  key: text("key").primaryKey(),
  displayName: text("display_name").notNull(),
  definitionVersion: integer("definition_version").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const systemSeedVersions = pgTable("bea_system_seed_versions", {
  id: text("id").primaryKey(),
  checksum: text("checksum").notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey(),
    eventType: text("event_type").notNull(),
    action: text("action").notNull(),
    outcome: text("outcome").$type<AuditOutcome>().notNull(),
    actorUserId: uuid("actor_user_id"),
    resourceType: text("resource_type"),
    resourceId: uuid("resource_id"),
    correlationId: text("correlation_id"),
    metadata: jsonb("metadata").$type<JsonObject>().notNull().default({}),
    createdAt: createdAt(),
  },
  (table) => [
    index("audit_logs_created_at_idx").on(table.createdAt),
    index("audit_logs_actor_user_id_idx").on(table.actorUserId),
    index("audit_logs_correlation_id_idx").on(table.correlationId),
  ],
);

export const featureFlags = pgTable(
  "feature_flags",
  {
    id: uuid("id").primaryKey(),
    key: text("key").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    requirementStatus: text("requirement_status").$type<RequirementStatus>().notNull(),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [uniqueIndex("feature_flags_key_uidx").on(table.key)],
);

export const systemSettings = pgTable(
  "system_settings",
  {
    id: uuid("id").primaryKey(),
    key: text("key").notNull(),
    value: jsonb("value_json").$type<JsonValue>().notNull(),
    description: text("description").notNull(),
    sensitivity: text("sensitivity").$type<SettingSensitivity>().notNull().default("internal"),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [uniqueIndex("system_settings_key_uidx").on(table.key)],
);

export const integrationConnections = pgTable(
  "integration_connections",
  {
    id: uuid("id").primaryKey(),
    providerType: text("provider_type").$type<IntegrationProviderType>().notNull(),
    displayName: text("display_name").notNull(),
    mode: text("mode").$type<IntegrationMode>().notNull(),
    connectionStatus: text("connection_status").$type<IntegrationConnectionStatus>().notNull(),
    requirementStatus: text("requirement_status").$type<RequirementStatus>().notNull(),
    configurationCompleteness: integer("configuration_completeness").notNull().default(0),
    requiredPermissions: jsonb("required_permissions")
      .$type<readonly string[]>()
      .notNull()
      .default([]),
    externalIdentifier: text("external_identifier"),
    lastHealthCheckAt: timestamp("last_health_check_at", { withTimezone: true, mode: "string" }),
    lastSuccessfulSyncAt: timestamp("last_successful_sync_at", {
      withTimezone: true,
      mode: "string",
    }),
    lastFailure: jsonb("last_failure").$type<StructuredError>(),
    lastSuccessfulTestAt: timestamp("last_successful_test_at", {
      withTimezone: true,
      mode: "string",
    }),
    lastFailedTestAt: timestamp("last_failed_test_at", { withTimezone: true, mode: "string" }),
    lastTestEvidenceId: uuid("last_test_evidence_id"),
    activatedAt: timestamp("activated_at", { withTimezone: true, mode: "string" }),
    activatedByUserId: uuid("activated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    testMode: boolean("test_mode").notNull().default(false),
    mockMode: boolean("mock_mode").notNull().default(false),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [uniqueIndex("integration_connections_provider_type_uidx").on(table.providerType)],
);

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey(),
    workflowKey: text("workflow_key").notNull(),
    status: text("status").$type<WorkflowStatus>().notNull(),
    triggerMetadata: jsonb("trigger_metadata").$type<JsonObject>().notNull().default({}),
    correlationId: text("correlation_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "string" }),
    error: jsonb("error").$type<StructuredError>(),
    retryCount: integer("retry_count").notNull().default(0),
    cancellationRequested: boolean("cancellation_requested").notNull().default(false),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [
    uniqueIndex("workflow_runs_idempotency_key_uidx").on(table.idempotencyKey),
    index("workflow_runs_workflow_key_started_at_idx").on(table.workflowKey, table.startedAt),
    index("workflow_runs_correlation_id_idx").on(table.correlationId),
  ],
);

export const workflowStepRuns = pgTable(
  "workflow_step_runs",
  {
    id: uuid("id").primaryKey(),
    workflowRunId: uuid("workflow_run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    stepKey: text("step_key").notNull(),
    sequence: integer("sequence").notNull(),
    status: text("status").$type<WorkflowStatus>().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "string" }),
    result: jsonb("result_json").$type<JsonObject>(),
    error: jsonb("error").$type<StructuredError>(),
    retryCount: integer("retry_count").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [
    uniqueIndex("workflow_step_runs_run_step_uidx").on(table.workflowRunId, table.stepKey),
    index("workflow_step_runs_workflow_run_id_idx").on(table.workflowRunId),
  ],
);

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    industry: text("industry"),
    status: text("status").$type<CompanyStatus>().notNull().default("prospect"),
    website: text("website"),
    phone: text("phone"),
    notes: text("notes"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [
    index("companies_name_idx").on(table.name),
    index("companies_status_idx").on(table.status),
  ],
);

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    jobTitle: text("job_title"),
    email: text("email"),
    phone: text("phone"),
    status: text("status").$type<ContactStatus>().notNull().default("active"),
    notes: text("notes"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [
    index("contacts_company_id_idx").on(table.companyId),
    index("contacts_name_idx").on(table.lastName, table.firstName),
    index("contacts_email_idx").on(table.email),
  ],
);

export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey(),
    reference: text("reference").notNull(),
    sourceType: text("source_type").$type<LeadSourceType>().notNull(),
    sourceDetails: text("source_details"),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "string" }).notNull(),
    opportunityName: text("opportunity_name").notNull(),
    requestSummary: text("request_summary").notNull(),
    requestedService: text("requested_service"),
    siteName: text("site_name"),
    siteAddressLine1: text("site_address_line1"),
    siteAddressLine2: text("site_address_line2"),
    siteCity: text("site_city"),
    siteRegion: text("site_region"),
    sitePostalCode: text("site_postal_code"),
    siteCountry: text("site_country"),
    desiredDeadlineAt: timestamp("desired_deadline_at", { withTimezone: true, mode: "string" }),
    requestedVisitAt: timestamp("requested_visit_at", { withTimezone: true, mode: "string" }),
    reviewerUserId: uuid("reviewer_user_id").references(() => users.id, { onDelete: "set null" }),
    status: text("status").$type<LeadStatus>().notNull(),
    disqualificationReason: text("disqualification_reason"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [
    uniqueIndex("leads_reference_uidx").on(table.reference),
    index("leads_status_idx").on(table.status),
    index("leads_source_type_idx").on(table.sourceType),
    index("leads_reviewer_user_id_idx").on(table.reviewerUserId),
    index("leads_received_at_idx").on(table.receivedAt),
    index("leads_opportunity_name_idx").on(table.opportunityName),
    index("leads_created_by_user_id_idx").on(table.createdByUserId),
  ],
);

export const leadParties = pgTable(
  "lead_parties",
  {
    id: uuid("id").primaryKey(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    role: text("role").$type<LeadPartyRole>().notNull(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    unmatchedCompanyName: text("unmatched_company_name"),
    unmatchedContactName: text("unmatched_contact_name"),
    unmatchedEmail: text("unmatched_email"),
    unmatchedPhone: text("unmatched_phone"),
    notes: text("notes"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [
    uniqueIndex("lead_parties_lead_role_uidx").on(table.leadId, table.role),
    index("lead_parties_lead_id_idx").on(table.leadId),
    index("lead_parties_company_id_idx").on(table.companyId),
    index("lead_parties_contact_id_idx").on(table.contactId),
    index("lead_parties_role_idx").on(table.role),
  ],
);

export const leadStatusEvents = pgTable(
  "lead_status_events",
  {
    id: uuid("id").primaryKey(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    fromStatus: text("from_status").$type<LeadStatus | null>(),
    toStatus: text("to_status").$type<LeadStatus>().notNull(),
    reason: text("reason"),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    correlationId: text("correlation_id"),
    metadata: jsonb("metadata").$type<JsonObject>().notNull().default({}),
    createdAt: createdAt(),
  },
  (table) => [
    index("lead_status_events_lead_id_idx").on(table.leadId, table.createdAt),
    index("lead_status_events_actor_user_id_idx").on(table.actorUserId),
    index("lead_status_events_correlation_id_idx").on(table.correlationId),
  ],
);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").$type<TaskStatus>().notNull().default("open"),
    priority: text("priority").$type<TaskPriority>().notNull().default("normal"),
    assigneeUserId: uuid("assignee_user_id")
      .notNull()
      .references(() => users.id),
    dueAt: timestamp("due_at", { withTimezone: true, mode: "string" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    inspectionId: uuid("inspection_id"),
    reportId: uuid("report_id"),
    exceptionId: uuid("exception_id"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [
    index("tasks_assignee_status_idx").on(table.assigneeUserId, table.status),
    index("tasks_due_at_idx").on(table.dueAt),
    index("tasks_company_id_idx").on(table.companyId),
    index("tasks_contact_id_idx").on(table.contactId),
    index("tasks_lead_id_idx").on(table.leadId),
  ],
);

export const activities = pgTable(
  "activities",
  {
    id: uuid("id").primaryKey(),
    type: text("type").$type<Activity["type"]>().notNull(),
    summary: text("summary").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    inspectionId: uuid("inspection_id"),
    reportId: uuid("report_id"),
    correlationId: text("correlation_id"),
    metadata: jsonb("metadata").$type<JsonObject>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [
    index("activities_created_at_idx").on(table.createdAt),
    index("activities_company_id_idx").on(table.companyId),
    index("activities_contact_id_idx").on(table.contactId),
    index("activities_task_id_idx").on(table.taskId),
    index("activities_lead_id_idx").on(table.leadId),
    index("activities_correlation_id_idx").on(table.correlationId),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    sourceType: text("source_type"),
    sourceId: uuid("source_id"),
    sourceHref: text("source_href"),
    readAt: timestamp("read_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [
    index("notifications_user_created_idx").on(table.userId, table.createdAt),
    index("notifications_user_unread_idx").on(table.userId, table.readAt),
  ],
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    provider: text("provider").$type<Conversation["provider"]>().notNull().default("simulated"),
    model: text("model")
      .$type<Conversation["model"]>()
      .notNull()
      .default("deterministic-demo-router"),
    routerVersion: text("router_version").notNull(),
    status: text("status").$type<Conversation["status"]>().notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [index("conversations_owner_updated_idx").on(table.ownerUserId, table.updatedAt)],
);

export const assistantMessages = pgTable(
  "assistant_messages",
  {
    id: uuid("id").primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").$type<AssistantMessage["role"]>().notNull(),
    content: text("content").notNull(),
    provider: text("provider").$type<AssistantMessage["provider"]>(),
    model: text("model").$type<AssistantMessage["model"]>(),
    providerResponseId: text("provider_response_id"),
    responseStatus: text("response_status")
      .$type<NonNullable<AssistantMessage["responseStatus"]>>()
      .notNull()
      .default("completed"),
    incompleteReason: text("incomplete_reason"),
    routerVersion: text("router_version"),
    executionMs: integer("execution_ms"),
    correlationId: text("correlation_id").notNull(),
    requiredPermissions: jsonb("required_permissions")
      .$type<readonly string[]>()
      .notNull()
      .default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [
    index("assistant_messages_conversation_created_idx").on(table.conversationId, table.createdAt),
    index("assistant_messages_correlation_id_idx").on(table.correlationId),
    index("assistant_messages_provider_response_idx").on(table.providerResponseId),
  ],
);

export const workspaceArtifacts = pgTable(
  "workspace_artifacts",
  {
    id: uuid("id").primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    requestedByUserId: uuid("requested_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<WorkspaceArtifact["type"]>().notNull(),
    title: text("title").notNull(),
    subtitle: text("subtitle"),
    state: text("state").$type<WorkspaceArtifact["state"]>().notNull(),
    payload: jsonb("payload").$type<JsonObject>().notNull().default({}),
    sources: jsonb("sources").$type<readonly WorkspaceArtifactSource[]>().notNull().default([]),
    links: jsonb("links").$type<readonly WorkspaceArtifactLink[]>().notNull().default([]),
    requiredPermissions: jsonb("required_permissions")
      .$type<readonly string[]>()
      .notNull()
      .default([]),
    errorCode: text("error_code"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [
    index("workspace_artifacts_conversation_created_idx").on(table.conversationId, table.createdAt),
    index("workspace_artifacts_requester_idx").on(table.requestedByUserId),
  ],
);

export const suggestedActions = pgTable(
  "suggested_actions",
  {
    id: uuid("id").primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    requestedByUserId: uuid("requested_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    actionType: text("action_type").$type<SuggestedAction["actionType"]>().notNull(),
    status: text("status").$type<SuggestedAction["status"]>().notNull().default("pending"),
    payload: jsonb("payload").$type<JsonObject>().notNull(),
    requiredPermission: text("required_permission").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    correlationId: text("correlation_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [
    uniqueIndex("suggested_actions_idempotency_key_uidx").on(table.idempotencyKey),
    index("suggested_actions_conversation_created_idx").on(table.conversationId, table.createdAt),
    index("suggested_actions_requester_status_idx").on(table.requestedByUserId, table.status),
  ],
);

export const actionApprovals = pgTable(
  "action_approvals",
  {
    id: uuid("id").primaryKey(),
    suggestedActionId: uuid("suggested_action_id")
      .notNull()
      .references(() => suggestedActions.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    decision: text("decision").$type<ActionApproval["decision"]>().notNull(),
    correlationId: text("correlation_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [
    uniqueIndex("action_approvals_suggested_action_uidx").on(table.suggestedActionId),
    index("action_approvals_actor_idx").on(table.actorUserId),
  ],
);

export const actionExecutions = pgTable(
  "action_executions",
  {
    id: uuid("id").primaryKey(),
    suggestedActionId: uuid("suggested_action_id")
      .notNull()
      .references(() => suggestedActions.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    status: text("status").$type<ActionExecution["status"]>().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    result: jsonb("result").$type<JsonObject>().notNull().default({}),
    errorCode: text("error_code"),
    correlationId: text("correlation_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [
    uniqueIndex("action_executions_suggested_action_uidx").on(table.suggestedActionId),
    uniqueIndex("action_executions_idempotency_key_uidx").on(table.idempotencyKey),
    index("action_executions_actor_created_idx").on(table.actorUserId, table.createdAt),
  ],
);

export const aiProviderConnectionTests = pgTable(
  "ai_provider_connection_tests",
  {
    id: uuid("id").primaryKey(),
    provider: text("provider").$type<AiProviderConnectionTest["provider"]>().notNull(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    outcome: text("outcome").$type<AiProviderConnectionTest["outcome"]>().notNull(),
    authenticated: boolean("authenticated").notNull().default(false),
    safeFailureCode: text("safe_failure_code"),
    safeMessage: text("safe_message").notNull(),
    modelCount: integer("model_count"),
    credentialFingerprint: text("credential_fingerprint"),
    correlationId: text("correlation_id").notNull(),
    testedAt: timestamp("tested_at", { withTimezone: true, mode: "string" }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [
    index("ai_provider_connection_tests_provider_tested_idx").on(table.provider, table.testedAt),
  ],
);

export const aiResponseRuns = pgTable(
  "ai_response_runs",
  {
    id: uuid("id").primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    requestedByUserId: uuid("requested_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestId: text("request_id").notNull(),
    provider: text("provider").$type<AiResponseRun["provider"]>().notNull(),
    model: text("model").notNull(),
    providerResponseId: text("provider_response_id"),
    status: text("status").$type<AiResponseRun["status"]>().notNull(),
    correlationId: text("correlation_id").notNull(),
    errorCode: text("error_code"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
    policyProvenance: jsonb("policy_provenance")
      .$type<AiResponseRun["policyProvenance"]>()
      .notNull(),
    routeDecision: jsonb("route_decision").$type<AiResponseRun["routeDecision"]>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [
    uniqueIndex("ai_response_runs_request_id_uidx").on(table.requestId),
    index("ai_response_runs_owner_started_idx").on(table.requestedByUserId, table.startedAt),
    index("ai_response_runs_conversation_started_idx").on(table.conversationId, table.startedAt),
    index("ai_response_runs_provider_response_idx").on(table.provider, table.providerResponseId),
  ],
);

export const aiMessageCitations = pgTable(
  "ai_message_citations",
  {
    id: uuid("id").primaryKey(),
    responseRunId: uuid("response_run_id")
      .notNull()
      .references(() => aiResponseRuns.id, { onDelete: "cascade" }),
    assistantMessageId: uuid("assistant_message_id").references(() => assistantMessages.id, {
      onDelete: "set null",
    }),
    providerItemId: text("provider_item_id"),
    title: text("title").notNull(),
    url: text("url").notNull(),
    domain: text("domain").notNull(),
    startIndex: integer("start_index"),
    endIndex: integer("end_index"),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true, mode: "string" }).notNull(),
    simulated: boolean("simulated").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [index("ai_message_citations_run_idx").on(table.responseRunId)],
);

export const aiToolCalls = pgTable(
  "ai_tool_calls",
  {
    id: uuid("id").primaryKey(),
    responseRunId: uuid("response_run_id")
      .notNull()
      .references(() => aiResponseRuns.id, { onDelete: "cascade" }),
    providerCallId: text("provider_call_id"),
    name: text("name").notNull(),
    arguments: jsonb("arguments").$type<JsonObject>().notNull().default({}),
    status: text("status").$type<AiToolCallRecord["status"]>().notNull(),
    requiredPermissions: jsonb("required_permissions")
      .$type<readonly string[]>()
      .notNull()
      .default([]),
    effect: text("effect").$type<AiToolCallRecord["effect"]>().notNull(),
    errorCode: text("error_code"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [index("ai_tool_calls_run_idx").on(table.responseRunId)],
);

export const aiRealtimeSessions = pgTable(
  "ai_realtime_sessions",
  {
    id: uuid("id").primaryKey(),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "cascade",
    }),
    requestedByUserId: uuid("requested_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").$type<AiRealtimeSessionRecord["provider"]>().notNull(),
    providerSessionId: text("provider_session_id"),
    model: text("model").notNull(),
    voice: text("voice").notNull(),
    status: text("status").$type<AiRealtimeSessionRecord["status"]>().notNull(),
    correlationId: text("correlation_id").notNull(),
    authorizedAt: timestamp("authorized_at", { withTimezone: true, mode: "string" }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
    errorCode: text("error_code"),
    simulated: boolean("simulated").notNull().default(false),
    policyProvenance: jsonb("policy_provenance")
      .$type<AiRealtimeSessionRecord["policyProvenance"]>()
      .notNull(),
    routeDecision: jsonb("route_decision").$type<AiRealtimeSessionRecord["routeDecision"]>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [
    index("ai_realtime_sessions_conversation_authorized_idx").on(
      table.conversationId,
      table.authorizedAt,
    ),
    index("ai_realtime_sessions_owner_authorized_idx").on(
      table.requestedByUserId,
      table.authorizedAt,
    ),
  ],
);

export const aiUsageRecords = pgTable(
  "ai_usage_records",
  {
    id: uuid("id").primaryKey(),
    responseRunId: uuid("response_run_id").references(() => aiResponseRuns.id, {
      onDelete: "set null",
    }),
    realtimeSessionId: uuid("realtime_session_id").references(() => aiRealtimeSessions.id, {
      onDelete: "set null",
    }),
    requestedByUserId: uuid("requested_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").$type<AiUsageLedgerRecord["provider"]>().notNull(),
    model: text("model").notNull(),
    operation: text("operation").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    audioInputTokens: integer("audio_input_tokens").notNull().default(0),
    audioOutputTokens: integer("audio_output_tokens").notNull().default(0),
    realtimeDurationSeconds: integer("realtime_duration_seconds").notNull().default(0),
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 18, scale: 6 }),
    costStatus: text("cost_status").$type<AiUsageLedgerRecord["costStatus"]>().notNull(),
    simulated: boolean("simulated").notNull().default(false),
    recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "string" }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [
    index("ai_usage_records_owner_recorded_idx").on(table.requestedByUserId, table.recordedAt),
  ],
);

export const aiModelCache = pgTable(
  "ai_model_cache",
  {
    id: uuid("id").primaryKey(),
    provider: text("provider").$type<AiModelCacheRecord["provider"]>().notNull(),
    modelId: text("model_id").notNull(),
    available: boolean("available").notNull().default(true),
    ownedBy: text("owned_by"),
    capabilities: jsonb("capabilities").$type<JsonObject>().notNull().default({}),
    capabilitySource: text("capability_source")
      .$type<AiModelCacheRecord["capabilitySource"]>()
      .notNull(),
    validation: jsonb("validation").$type<AiModelCacheRecord["validation"]>().notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "string" }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [
    uniqueIndex("ai_model_cache_provider_model_uidx").on(table.provider, table.modelId),
    index("ai_model_cache_provider_expires_idx").on(table.provider, table.expiresAt),
  ],
);

export const generatedArtifacts = pgTable(
  "generated_artifacts",
  {
    id: uuid("id").primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    responseRunId: uuid("response_run_id").references(() => aiResponseRuns.id, {
      onDelete: "set null",
    }),
    requestedByUserId: uuid("requested_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<GeneratedArtifactRecord["kind"]>().notNull(),
    title: text("title").notNull(),
    status: text("status").$type<GeneratedArtifactRecord["status"]>().notNull(),
    artifactVersion: integer("artifact_version").notNull().default(1),
    provider: text("provider").$type<GeneratedArtifactRecord["provider"]>().notNull(),
    providerItemId: text("provider_item_id"),
    providerContainerId: text("provider_container_id"),
    providerFileId: text("provider_file_id"),
    filename: text("filename"),
    mediaType: text("media_type"),
    storageReference: text("storage_reference"),
    specification: jsonb("specification").$type<JsonObject>().notNull().default({}),
    sourceMetadata: jsonb("source_metadata").$type<JsonObject>().notNull().default({}),
    citationIds: jsonb("citation_ids").$type<readonly string[]>().notNull().default([]),
    fileMetadata: jsonb("file_metadata").$type<JsonObject>().notNull().default({}),
    renderMetadata: jsonb("render_metadata").$type<JsonObject>().notNull().default({}),
    generationMetadata: jsonb("generation_metadata").$type<JsonObject>().notNull().default({}),
    requiredPermissions: jsonb("required_permissions")
      .$type<readonly string[]>()
      .notNull()
      .default([]),
    simulated: boolean("simulated").notNull().default(false),
    errorCode: text("error_code"),
    parentArtifactId: uuid("parent_artifact_id"),
    presentationRunId: uuid("presentation_run_id"),
    reviewStatus: text("review_status").notNull().default("draft_human_review_required"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [
    index("generated_artifacts_owner_created_idx").on(table.requestedByUserId, table.createdAt),
    index("generated_artifacts_conversation_created_idx").on(table.conversationId, table.createdAt),
  ],
);

export const aiModelCapabilityEvidence = pgTable(
  "ai_model_capability_evidence",
  {
    id: uuid("id").primaryKey(),
    provider: text("provider").notNull(),
    modelId: text("model_id").notNull(),
    capability: text("capability").notNull(),
    status: text("status").notNull(),
    verificationMethod: text("verification_method").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "string" }).notNull(),
    providerRequestId: text("provider_request_id"),
    safeFailureCode: text("safe_failure_code"),
    registryVersion: text("registry_version").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [
    uniqueIndex("ai_model_capability_evidence_uidx").on(
      table.provider,
      table.modelId,
      table.capability,
    ),
    index("ai_model_capability_evidence_model_idx").on(table.provider, table.modelId),
  ],
);

export const executiveDocumentSpecifications = pgTable(
  "executive_document_specifications",
  {
    id: uuid("id").primaryKey(),
    artifactId: uuid("artifact_id").references(() => generatedArtifacts.id, {
      onDelete: "set null",
    }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    presentationRunId: uuid("presentation_run_id"),
    requestedByUserId: uuid("requested_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    template: text("template").notNull(),
    title: text("title").notNull(),
    specification: jsonb("specification").$type<JsonObject>().notNull(),
    validationStatus: text("validation_status").notNull(),
    documentVersion: integer("document_version").notNull().default(1),
    parentSpecificationId: uuid("parent_specification_id"),
    reviewStatus: text("review_status").notNull().default("draft_human_review_required"),
    relatedRecordIds: jsonb("related_record_ids").$type<readonly string[]>().notNull().default([]),
    citationIds: jsonb("citation_ids").$type<readonly string[]>().notNull().default([]),
    requiredPermissions: jsonb("required_permissions")
      .$type<readonly string[]>()
      .notNull()
      .default([]),
    errorCode: text("error_code"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [
    index("executive_document_specifications_conversation_idx").on(
      table.conversationId,
      table.createdAt,
    ),
    index("executive_document_specifications_artifact_idx").on(table.artifactId),
  ],
);

export const aiUserVoicePreferences = pgTable("ai_user_voice_preferences", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  speakResponses: boolean("speak_responses").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: version(),
});

export const apiRateLimitWindows = pgTable(
  "api_rate_limit_windows",
  {
    subjectKey: text("subject_key").notNull(),
    routeKey: text("route_key").notNull(),
    windowStartedAt: timestamp("window_started_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    windowSeconds: integer("window_seconds").notNull(),
    requestCount: integer("request_count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.subjectKey, table.routeKey, table.windowStartedAt] }),
    index("api_rate_limit_windows_updated_idx").on(table.updatedAt),
  ],
);

export const aiPresentationRuns = pgTable(
  "ai_presentation_runs",
  {
    id: uuid("id").primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    responseRunId: uuid("response_run_id").references(() => aiResponseRuns.id, {
      onDelete: "set null",
    }),
    realtimeSessionId: uuid("realtime_session_id").references(() => aiRealtimeSessions.id, {
      onDelete: "set null",
    }),
    initiatingUserMessageId: uuid("initiating_user_message_id").references(
      () => assistantMessages.id,
      { onDelete: "set null" },
    ),
    assistantMessageId: uuid("assistant_message_id").references(() => assistantMessages.id, {
      onDelete: "set null",
    }),
    visualArtifactId: uuid("visual_artifact_id").references(() => workspaceArtifacts.id, {
      onDelete: "set null",
    }),
    actingUserId: uuid("acting_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    routeKey: text("route_key").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    providerResponseId: text("provider_response_id"),
    status: text("status").$type<AiPresentationStatus>().notNull(),
    query: text("query").notNull(),
    packet: jsonb("packet").$type<JsonObject>().notNull().default({}),
    selectedContext: jsonb("selected_context").$type<JsonObject | null>(),
    autoFollow: boolean("auto_follow").notNull().default(true),
    simulated: boolean("simulated").notNull().default(false),
    liveWebSearch: boolean("live_web_search").notNull().default(false),
    requiredPermissions: jsonb("required_permissions")
      .$type<readonly string[]>()
      .notNull()
      .default([]),
    usageMetadata: jsonb("usage_metadata").$type<JsonObject>().notNull().default({}),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [
    index("ai_presentation_runs_conversation_started_idx").on(
      table.conversationId,
      table.startedAt,
    ),
    index("ai_presentation_runs_actor_started_idx").on(table.actingUserId, table.startedAt),
    index("ai_presentation_runs_response_run_idx").on(table.responseRunId),
  ],
);

export function getPhase133AiProvenanceSchemaColumns() {
  return {
    tasks: Object.keys(getTableColumns(tasks)),
    aiResponseRuns: Object.keys(getTableColumns(aiResponseRuns)),
    aiRealtimeSessions: Object.keys(getTableColumns(aiRealtimeSessions)),
  } as const;
}

export function getPhase21PresentationSchemaColumns() {
  return {
    aiPresentationRuns: Object.keys(getTableColumns(aiPresentationRuns)),
  } as const;
}

export const digitalWorkforceDepartments = pgTable(
  "digital_workforce_departments",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").$type<DigitalDepartmentStatus>().notNull(),
    displayOrder: integer("display_order").notNull().default(0),
    parentDepartmentId: uuid("parent_department_id"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [
    uniqueIndex("digital_workforce_departments_slug_uidx").on(table.slug),
    index("digital_workforce_departments_status_idx").on(table.status, table.displayOrder),
  ],
);

export const digitalWorkforceTeams = pgTable(
  "digital_workforce_teams",
  {
    id: uuid("id").primaryKey(),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => digitalWorkforceDepartments.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").$type<DigitalTeamStatus>().notNull(),
    teamLeadAgentId: uuid("team_lead_agent_id"),
    displayOrder: integer("display_order").notNull().default(0),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [
    uniqueIndex("digital_workforce_teams_slug_uidx").on(table.slug),
    index("digital_workforce_teams_department_idx").on(table.departmentId, table.displayOrder),
  ],
);

export const digitalWorkforceAgents = pgTable(
  "digital_workforce_agents",
  {
    id: uuid("id").primaryKey(),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    roleTitle: text("role_title").notNull(),
    shortDescription: text("short_description").notNull().default(""),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => digitalWorkforceDepartments.id),
    teamId: uuid("team_id")
      .notNull()
      .references(() => digitalWorkforceTeams.id),
    supportedHumanUserId: uuid("supported_human_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    currentPublishedVersionId: uuid("current_published_version_id"),
    status: text("status").$type<DigitalAgentStatus>().notNull(),
    avatar: text("avatar").$type<DigitalAgentAvatar>().notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [
    uniqueIndex("digital_workforce_agents_slug_uidx").on(table.slug),
    index("digital_workforce_agents_status_idx").on(table.status, table.departmentId, table.teamId),
  ],
);

export const digitalWorkforceAgentVersions = pgTable(
  "digital_workforce_agent_versions",
  {
    id: uuid("id").primaryKey(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => digitalWorkforceAgents.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    lifecycle: text("lifecycle").$type<DigitalAgentVersionLifecycle>().notNull(),
    persona: text("persona").notNull(),
    roleDefinition: text("role_definition").notNull(),
    goals: jsonb("goals").$type<string[]>().notNull().default([]),
    successCriteria: jsonb("success_criteria").$type<string[]>().notNull().default([]),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => digitalWorkforceDepartments.id),
    teamId: uuid("team_id")
      .notNull()
      .references(() => digitalWorkforceTeams.id),
    supervisorAgentId: uuid("supervisor_agent_id").references(() => digitalWorkforceAgents.id, {
      onDelete: "set null",
    }),
    preferredHandoffAgentIds: jsonb("preferred_handoff_agent_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    availableToRoleIds: jsonb("available_to_role_ids").$type<string[]>().notNull().default([]),
    modelAssignment: jsonb("model_assignment").$type<DigitalWorkforceModelAssignment>().notNull(),
    toolGrants: jsonb("tool_grants").$type<DigitalWorkforceToolGrant[]>().notNull().default([]),
    dataScopes: jsonb("data_scopes")
      .$type<DigitalWorkforceDataScopeGrant[]>()
      .notNull()
      .default([]),
    knowledgeScopes: jsonb("knowledge_scopes")
      .$type<DigitalWorkforceKnowledgeScopeGrant[]>()
      .notNull()
      .default([]),
    memoryPolicy: text("memory_policy").$type<DigitalWorkforceMemoryPolicy>().notNull(),
    approvalPolicy: text("approval_policy").$type<DigitalWorkforceApprovalPolicy>().notNull(),
    designatedApproverRoleId: text("designated_approver_role_id"),
    escalationInstructions: text("escalation_instructions").notNull().default(""),
    runtimePolicy: jsonb("runtime_policy").$type<DigitalWorkforceRuntimeLimits>().notNull(),
    configurationHash: text("configuration_hash").notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id),
    publishedByUserId: uuid("published_by_user_id").references(() => users.id),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [
    uniqueIndex("digital_workforce_agent_versions_number_uidx").on(
      table.agentId,
      table.versionNumber,
    ),
    index("digital_workforce_agent_versions_lifecycle_idx").on(table.agentId, table.lifecycle),
  ],
);

export const digitalWorkforceRuns = pgTable(
  "digital_workforce_runs",
  {
    id: uuid("id").primaryKey(),
    initiatingUserId: uuid("initiating_user_id")
      .notNull()
      .references(() => users.id),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    initiatingMessageId: uuid("initiating_message_id").references(() => assistantMessages.id, {
      onDelete: "set null",
    }),
    rootAgentId: uuid("root_agent_id")
      .notNull()
      .references(() => digitalWorkforceAgents.id),
    rootAgentVersionId: uuid("root_agent_version_id")
      .notNull()
      .references(() => digitalWorkforceAgentVersions.id),
    goal: text("goal").notNull(),
    normalizedRequest: text("normalized_request").notNull(),
    executionPlan: jsonb("execution_plan").$type<DigitalWorkforceExecutionPlan>(),
    status: text("status").$type<DigitalAgentRunStatus>().notNull(),
    currentStepKey: text("current_step_key"),
    idempotencyKey: text("idempotency_key").notNull(),
    sourceRecordIds: jsonb("source_record_ids").$type<string[]>().notNull().default([]),
    sourceArtifactIds: jsonb("source_artifact_ids").$type<string[]>().notNull().default([]),
    sourcePresentationIds: jsonb("source_presentation_ids").$type<string[]>().notNull().default([]),
    outputArtifactIds: jsonb("output_artifact_ids").$type<string[]>().notNull().default([]),
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 18, scale: 6 })
      .notNull()
      .default("0"),
    actualCostUsd: numeric("actual_cost_usd", { precision: 18, scale: 6 }),
    providerCallCount: integer("provider_call_count").notNull().default(0),
    webSearchCount: integer("web_search_count").notNull().default(0),
    pdfGenerationCount: integer("pdf_generation_count").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }),
    claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "string" }),
    claimOwner: text("claim_owner"),
    cancellationRequested: boolean("cancellation_requested").notNull().default(false),
    cancelledByUserId: uuid("cancelled_by_user_id").references(() => users.id),
    cancellationReason: text("cancellation_reason"),
    safeError: text("safe_error"),
    executiveSummary: text("executive_summary"),
    correlationId: text("correlation_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [
    uniqueIndex("digital_workforce_runs_idempotency_uidx").on(table.idempotencyKey),
    index("digital_workforce_runs_status_idx").on(table.status, table.createdAt),
    index("digital_workforce_runs_user_idx").on(table.initiatingUserId, table.createdAt),
    index("digital_workforce_runs_root_agent_idx").on(table.rootAgentId, table.createdAt),
  ],
);

export const digitalWorkforceRunSteps = pgTable(
  "digital_workforce_run_steps",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => digitalWorkforceRuns.id, { onDelete: "cascade" }),
    stepKey: text("step_key").notNull(),
    stepType: text("step_type").$type<DigitalAgentStepType>().notNull(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => digitalWorkforceAgents.id),
    agentVersionId: uuid("agent_version_id")
      .notNull()
      .references(() => digitalWorkforceAgentVersions.id),
    status: text("status").$type<DigitalAgentStepStatus>().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    sequence: integer("sequence").notNull(),
    parallelGroup: text("parallel_group"),
    assignedWhy: text("assigned_why").notNull().default(""),
    provider: text("provider"),
    model: text("model"),
    fallbackModelUsed: text("fallback_model_used"),
    toolNames: jsonb("tool_names").$type<string[]>().notNull().default([]),
    authorizedRecordIds: jsonb("authorized_record_ids").$type<string[]>().notNull().default([]),
    citationIds: jsonb("citation_ids").$type<string[]>().notNull().default([]),
    artifactIds: jsonb("artifact_ids").$type<string[]>().notNull().default([]),
    usageJson: jsonb("usage_json").$type<JsonObject>().notNull().default({}),
    resultJson: jsonb("result_json").$type<JsonObject>().notNull().default({}),
    safeError: text("safe_error"),
    retryCount: integer("retry_count").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [
    uniqueIndex("digital_workforce_run_steps_idempotency_uidx").on(table.idempotencyKey),
    uniqueIndex("digital_workforce_run_steps_key_uidx").on(table.runId, table.stepKey),
    index("digital_workforce_run_steps_run_idx").on(table.runId, table.sequence),
  ],
);

export const digitalWorkforceHandoffs = pgTable(
  "digital_workforce_handoffs",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => digitalWorkforceRuns.id, { onDelete: "cascade" }),
    parentStepId: uuid("parent_step_id").references(() => digitalWorkforceRunSteps.id, {
      onDelete: "set null",
    }),
    fromAgentId: uuid("from_agent_id")
      .notNull()
      .references(() => digitalWorkforceAgents.id),
    fromAgentVersionId: uuid("from_agent_version_id")
      .notNull()
      .references(() => digitalWorkforceAgentVersions.id),
    toAgentId: uuid("to_agent_id")
      .notNull()
      .references(() => digitalWorkforceAgents.id),
    toAgentVersionId: uuid("to_agent_version_id")
      .notNull()
      .references(() => digitalWorkforceAgentVersions.id),
    depth: integer("depth").notNull().default(1),
    status: text("status").$type<DigitalHandoffStatus>().notNull(),
    packet: jsonb("packet").$type<DigitalWorkforceHandoffPacket>().notNull(),
    returnedResult: jsonb("returned_result").$type<JsonObject>(),
    safeFailure: text("safe_failure"),
    approvalRequired: boolean("approval_required").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (table) => [
    index("digital_workforce_handoffs_run_idx").on(table.runId, table.createdAt),
    index("digital_workforce_handoffs_status_idx").on(table.status, table.createdAt),
  ],
);

export const digitalWorkforceRunEvents = pgTable(
  "digital_workforce_run_events",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => digitalWorkforceRuns.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    eventType: text("event_type").notNull(),
    agentId: uuid("agent_id").references(() => digitalWorkforceAgents.id, { onDelete: "set null" }),
    stepId: uuid("step_id").references(() => digitalWorkforceRunSteps.id, { onDelete: "set null" }),
    handoffId: uuid("handoff_id").references(() => digitalWorkforceHandoffs.id, {
      onDelete: "set null",
    }),
    narration: text("narration"),
    metadata: jsonb("metadata").$type<JsonObject>().notNull().default({}),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("digital_workforce_run_events_sequence_uidx").on(table.runId, table.sequence),
    index("digital_workforce_run_events_run_idx").on(table.runId, table.createdAt),
  ],
);

export const reportTemplates = pgTable("report_templates", {
  id: uuid("id").primaryKey(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  synthetic: boolean("synthetic").notNull().default(true),
  status: text("status").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: version(),
});

export const reportTemplateVersions = pgTable("report_template_versions", {
  id: uuid("id").primaryKey(),
  templateId: uuid("template_id")
    .notNull()
    .references(() => reportTemplates.id, { onDelete: "cascade" }),
  versionNumber: integer("version_number").notNull(),
  mapping: jsonb("mapping").$type<JsonObject>().notNull().default({}),
  requirements: jsonb("requirements").$type<ReportRequirementSet>().notNull(),
  rendererKey: text("renderer_key").notNull(),
  disclosure: text("disclosure").notNull(),
  createdAt: createdAt(),
});

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey(),
  reference: text("reference").notNull(),
  leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
  companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
  contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  clientName: text("client_name").notNull(),
  siteName: text("site_name").notNull(),
  siteCity: text("site_city"),
  siteRegion: text("site_region"),
  serviceKey: text("service_key").notNull(),
  status: text("status").$type<ProjectStatus>().notNull(),
  acceptedScopeSnapshot: jsonb("accepted_scope_snapshot").$type<JsonObject>().notNull().default({}),
  createdByUserId: uuid("created_by_user_id")
    .notNull()
    .references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: version(),
});

export const inspections = pgTable("inspections", {
  id: uuid("id").primaryKey(),
  reference: text("reference").notNull(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  status: text("status").$type<InspectionStatus>().notNull(),
  inspectorUserId: uuid("inspector_user_id").references(() => users.id, { onDelete: "set null" }),
  reviewerUserId: uuid("reviewer_user_id").references(() => users.id, { onDelete: "set null" }),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: "string" }),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
  submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "string" }),
  serviceKey: text("service_key").notNull(),
  reportTemplateId: uuid("report_template_id")
    .notNull()
    .references(() => reportTemplates.id),
  configurationReleaseId: uuid("configuration_release_id"),
  inspectionType: text("inspection_type"),
  readinessChecklist: jsonb("readiness_checklist").$type<JsonObject>(),
  createdByUserId: uuid("created_by_user_id")
    .notNull()
    .references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: version(),
});

export const inspectionSubmissions = pgTable("inspection_submissions", {
  id: uuid("id").primaryKey(),
  inspectionId: uuid("inspection_id")
    .notNull()
    .references(() => inspections.id, { onDelete: "cascade" }),
  sourceChannel: text("source_channel").$type<InspectionSourceChannel>().notNull(),
  sourceIdempotencyKey: text("source_idempotency_key").notNull(),
  payloadSha256: text("payload_sha256").notNull(),
  rawPayload: jsonb("raw_payload").$type<JsonObject>().notNull(),
  schemaVersion: text("schema_version").notNull(),
  mappingVersion: text("mapping_version").notNull(),
  normalizedPayload: jsonb("normalized_payload").$type<JsonObject>().notNull(),
  configurationReleaseId: uuid("configuration_release_id"),
  sourceLineage: jsonb("source_lineage").$type<JsonObject>(),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  correlationId: text("correlation_id"),
  createdAt: createdAt(),
});

export const inspectionFindings = pgTable("inspection_findings", {
  id: uuid("id").primaryKey(),
  submissionId: uuid("submission_id")
    .notNull()
    .references(() => inspectionSubmissions.id, { onDelete: "cascade" }),
  inspectionId: uuid("inspection_id")
    .notNull()
    .references(() => inspections.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  sectionKey: text("section_key").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  severity: text("severity").$type<FindingSeverity>().notNull(),
  location: text("location"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: createdAt(),
});

export const inspectionEvidence = pgTable("inspection_evidence", {
  id: uuid("id").primaryKey(),
  submissionId: uuid("submission_id")
    .notNull()
    .references(() => inspectionSubmissions.id, { onDelete: "cascade" }),
  inspectionId: uuid("inspection_id")
    .notNull()
    .references(() => inspections.id, { onDelete: "cascade" }),
  findingId: uuid("finding_id").references(() => inspectionFindings.id, { onDelete: "set null" }),
  kind: text("kind").$type<EvidenceKind>().notNull(),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  sha256: text("sha256").notNull(),
  byteLength: integer("byte_length").notNull(),
  storageRef: text("storage_ref").notNull(),
  createdAt: createdAt(),
});

export const inspectionValidationResults = pgTable("inspection_validation_results", {
  id: uuid("id").primaryKey(),
  submissionId: uuid("submission_id")
    .notNull()
    .references(() => inspectionSubmissions.id, { onDelete: "cascade" }),
  inspectionId: uuid("inspection_id")
    .notNull()
    .references(() => inspections.id, { onDelete: "cascade" }),
  passed: boolean("passed").notNull(),
  ruleSetKey: text("rule_set_key").notNull(),
  ruleSetVersion: text("rule_set_version").notNull(),
  blocking: jsonb("blocking").$type<InspectionValidationItem[]>().notNull().default([]),
  optionalItems: jsonb("optional_items").$type<InspectionValidationItem[]>().notNull().default([]),
  createdAt: createdAt(),
});

export const inspectionReports = pgTable("inspection_reports", {
  id: uuid("id").primaryKey(),
  reference: text("reference").notNull(),
  inspectionId: uuid("inspection_id")
    .notNull()
    .references(() => inspections.id, { onDelete: "cascade" }),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  templateId: uuid("template_id")
    .notNull()
    .references(() => reportTemplates.id),
  currentTemplateVersionId: uuid("current_template_version_id")
    .notNull()
    .references(() => reportTemplateVersions.id),
  status: text("status").$type<ReportStatus>().notNull(),
  currentVersionNumber: integer("current_version_number").notNull().default(0),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  configurationReleaseId: uuid("configuration_release_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: version(),
});

export const reportVersions = pgTable("report_versions", {
  id: uuid("id").primaryKey(),
  reportId: uuid("report_id")
    .notNull()
    .references(() => inspectionReports.id, { onDelete: "cascade" }),
  versionNumber: integer("version_number").notNull(),
  status: text("status").$type<ReportVersionStatus>().notNull(),
  inputSnapshot: jsonb("input_snapshot").$type<JsonObject>().notNull(),
  templateVersionId: uuid("template_version_id")
    .notNull()
    .references(() => reportTemplateVersions.id),
  submissionId: uuid("submission_id")
    .notNull()
    .references(() => inspectionSubmissions.id),
  renderedChecksum: text("rendered_checksum"),
  renderedStorageRef: text("rendered_storage_ref"),
  renderedMimeType: text("rendered_mime_type"),
  renderedContent: text("rendered_content"),
  reviewerUserId: uuid("reviewer_user_id").references(() => users.id, { onDelete: "set null" }),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "string" }),
  reviewDecision: text("review_decision").$type<ReportReviewDecision>(),
  reviewComment: text("review_comment"),
  configurationReleaseId: uuid("configuration_release_id"),
  createdAt: createdAt(),
});

export const reportReviewComments = pgTable("report_review_comments", {
  id: uuid("id").primaryKey(),
  reportVersionId: uuid("report_version_id")
    .notNull()
    .references(() => reportVersions.id, { onDelete: "cascade" }),
  authorUserId: uuid("author_user_id")
    .notNull()
    .references(() => users.id),
  sectionKey: text("section_key"),
  findingId: uuid("finding_id"),
  body: text("body").notNull(),
  createdAt: createdAt(),
});

export const reportDeliveries = pgTable("report_deliveries", {
  id: uuid("id").primaryKey(),
  reportId: uuid("report_id")
    .notNull()
    .references(() => inspectionReports.id, { onDelete: "cascade" }),
  reportVersionId: uuid("report_version_id")
    .notNull()
    .references(() => reportVersions.id, { onDelete: "cascade" }),
  idempotencyKey: text("idempotency_key").notNull(),
  adapterKey: text("adapter_key").notNull(),
  status: text("status").$type<DeliveryStatus>().notNull(),
  recipients: jsonb("recipients").$type<string[]>().notNull().default([]),
  subject: text("subject").notNull(),
  artifactChecksum: text("artifact_checksum"),
  externalMessageId: text("external_message_id"),
  attemptedAt: timestamp("attempted_at", { withTimezone: true, mode: "string" }),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "string" }),
  error: jsonb("error").$type<JsonObject>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: version(),
});

export const deliveryAuthorizations = pgTable("delivery_authorizations", {
  id: uuid("id").primaryKey(),
  reportId: uuid("report_id")
    .notNull()
    .references(() => inspectionReports.id, { onDelete: "cascade" }),
  reportVersionId: uuid("report_version_id")
    .notNull()
    .references(() => reportVersions.id, { onDelete: "cascade" }),
  artifactChecksum: text("artifact_checksum").notNull(),
  recipients: jsonb("recipients").$type<string[]>().notNull().default([]),
  destinationKind: text("destination_kind").$type<DeliveryDestinationKind>().notNull(),
  authorizingUserId: uuid("authorizing_user_id")
    .notNull()
    .references(() => users.id),
  authorizedAt: timestamp("authorized_at", { withTimezone: true, mode: "string" }).notNull(),
  status: text("status").$type<DeliveryAuthorizationStatus>().notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "string" }),
  consumedByJobId: uuid("consumed_by_job_id"),
  reservedToken: text("reserved_token"),
  reservedAt: timestamp("reserved_at", { withTimezone: true, mode: "string" }),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
  revokedByUserId: uuid("revoked_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: version(),
});

export const exceptionCases = pgTable("exception_cases", {
  id: uuid("id").primaryKey(),
  reference: text("reference").notNull(),
  kind: text("kind").$type<ExceptionKind>().notNull(),
  status: text("status").$type<ExceptionStatus>().notNull(),
  severity: text("severity").notNull(),
  title: text("title").notNull(),
  detail: text("detail").notNull(),
  inspectionId: uuid("inspection_id").references(() => inspections.id, { onDelete: "set null" }),
  reportId: uuid("report_id").references(() => inspectionReports.id, { onDelete: "set null" }),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  deliveryId: uuid("delivery_id").references(() => reportDeliveries.id, { onDelete: "set null" }),
  jobId: uuid("job_id"),
  ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
  slaAttribution: text("sla_attribution").$type<SlaAttribution>().notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "string" }),
  resolution: text("resolution"),
  resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  resolvedByActorType: text("resolved_by_actor_type").$type<ActorType>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: version(),
});

export const slaClocks = pgTable("sla_clocks", {
  id: uuid("id").primaryKey(),
  reportId: uuid("report_id").references(() => inspectionReports.id, { onDelete: "set null" }),
  inspectionId: uuid("inspection_id")
    .notNull()
    .references(() => inspections.id, { onDelete: "cascade" }),
  clockKind: text("clock_kind").$type<SlaClockKind>().notNull(),
  targetMinutes: integer("target_minutes").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
  pausedAt: timestamp("paused_at", { withTimezone: true, mode: "string" }),
  pauseReason: text("pause_reason").$type<SlaPauseReason>(),
  pausedTotalMs: integer("paused_total_ms").notNull().default(0),
  stoppedAt: timestamp("stopped_at", { withTimezone: true, mode: "string" }),
  status: text("status").$type<SlaClockStatus>().notNull(),
  slaPolicyKey: text("sla_policy_key"),
  slaPolicyVersion: integer("sla_policy_version"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: version(),
});

export const slaStageIntervals = pgTable("sla_stage_intervals", {
  id: uuid("id").primaryKey(),
  clockId: uuid("clock_id")
    .notNull()
    .references(() => slaClocks.id, { onDelete: "cascade" }),
  stageKey: text("stage_key").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true, mode: "string" }),
  durationMs: integer("duration_ms"),
  attribution: text("attribution").$type<SlaAttribution>().notNull(),
});

export const automationEvents = pgTable("automation_events", {
  id: uuid("id").primaryKey(),
  eventType: text("event_type").$type<OperationsEventType>().notNull(),
  schemaVersion: text("schema_version").notNull(),
  aggregateType: text("aggregate_type").notNull(),
  aggregateId: uuid("aggregate_id").notNull(),
  correlationId: text("correlation_id").notNull(),
  causationId: text("causation_id"),
  occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" }).notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "string" }).notNull(),
  actorType: text("actor_type").$type<ActorType>().notNull(),
  actorId: uuid("actor_id"),
  payload: jsonb("payload").$type<JsonObject>().notNull().default({}),
  processingStatus: text("processing_status").notNull(),
});

export const automationJobs = pgTable("automation_jobs", {
  id: uuid("id").primaryKey(),
  jobType: text("job_type").$type<AutomationJobType>().notNull(),
  blueprintKey: text("blueprint_key").$type<BlueprintKey>().notNull(),
  blueprintVersion: integer("blueprint_version").notNull(),
  aggregateType: text("aggregate_type").notNull(),
  aggregateId: uuid("aggregate_id").notNull(),
  eventId: uuid("event_id").references(() => automationEvents.id, { onDelete: "set null" }),
  idempotencyKey: text("idempotency_key").notNull(),
  status: text("status").$type<AutomationJobStatus>().notNull(),
  attemptCount: integer("attempt_count").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  availableAt: timestamp("available_at", { withTimezone: true, mode: "string" }).notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "string" }),
  claimedBy: text("claimed_by"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "string" }),
  finishedAt: timestamp("finished_at", { withTimezone: true, mode: "string" }),
  lastError: jsonb("last_error").$type<JsonObject>(),
  payload: jsonb("payload").$type<JsonObject>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: version(),
});

export const automationBlueprints = pgTable("automation_blueprints", {
  id: uuid("id").primaryKey(),
  key: text("key").$type<BlueprintKey>().notNull(),
  displayName: text("display_name").notNull(),
  blueprintVersion: integer("blueprint_version").notNull(),
  status: text("status").notNull(),
  triggerEventType: text("trigger_event_type").$type<OperationsEventType>().notNull(),
  actions: jsonb("actions").$type<string[]>().notNull().default([]),
  parameters: jsonb("parameters").$type<JsonObject>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: version(),
});

export const guidedDemoRuns = pgTable(
  "guided_demo_runs",
  {
    id: uuid("id").primaryKey(),
    scenarioKey: text("scenario_key").notNull(),
    scenarioVersion: text("scenario_version").notNull(),
    status: text("status").notNull(),
    machineState: text("machine_state").notNull(),
    pausedFromState: text("paused_from_state"),
    currentStageKey: text("current_stage_key"),
    currentGateKey: text("current_gate_key"),
    speedMode: text("speed_mode").notNull().default("normal"),
    recordBindings: jsonb("record_bindings").$type<JsonObject>().notNull(),
    currentActivity: text("current_activity"),
    currentActivityIndex: integer("current_activity_index").notNull().default(0),
    currentBlocker: text("current_blocker"),
    failureArmed: boolean("failure_armed").notNull().default(false),
    presentationMode: boolean("presentation_mode").notNull().default(false),
    startedByUserId: uuid("started_by_user_id"),
    optimisticVersion: integer("optimistic_version").notNull().default(1),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
    pausedAt: timestamp("paused_at", { withTimezone: true, mode: "string" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("guided_demo_runs_status_idx").on(table.status)],
);

export const guidedDemoStageStates = pgTable(
  "guided_demo_stage_states",
  {
    id: uuid("id").primaryKey(),
    demoRunId: uuid("demo_run_id")
      .notNull()
      .references(() => guidedDemoRuns.id, { onDelete: "cascade" }),
    stageKey: text("stage_key").notNull(),
    stageOrder: integer("stage_order").notNull(),
    status: text("status").notNull(),
    backingType: text("backing_type").notNull(),
    ownerRoleKey: text("owner_role_key").notNull(),
    currentActivity: text("current_activity"),
    inputSummary: jsonb("input_summary").$type<JsonObject>().notNull(),
    outputSummary: jsonb("output_summary").$type<JsonObject>().notNull(),
    linkedRecords: jsonb("linked_records").$type<JsonObject>().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
    failedAt: timestamp("failed_at", { withTimezone: true, mode: "string" }),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("guided_demo_stage_states_run_stage_uidx").on(table.demoRunId, table.stageKey),
  ],
);

export const guidedDemoEvents = pgTable(
  "guided_demo_events",
  {
    id: uuid("id").primaryKey(),
    demoRunId: uuid("demo_run_id")
      .notNull()
      .references(() => guidedDemoRuns.id, { onDelete: "cascade" }),
    sequenceNumber: integer("sequence_number").notNull(),
    stageKey: text("stage_key"),
    eventKind: text("event_kind").notNull(),
    plainLanguageMessage: text("plain_language_message").notNull(),
    actorUserId: uuid("actor_user_id"),
    safeMetadata: jsonb("safe_metadata").$type<JsonObject>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("guided_demo_events_run_sequence_uidx").on(table.demoRunId, table.sequenceNumber),
  ],
);

export const guidedDemoDecisions = pgTable(
  "guided_demo_decisions",
  {
    id: uuid("id").primaryKey(),
    demoRunId: uuid("demo_run_id")
      .notNull()
      .references(() => guidedDemoRuns.id, { onDelete: "cascade" }),
    decisionKey: text("decision_key").notNull(),
    stageKey: text("stage_key").notNull(),
    actorUserId: uuid("actor_user_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    outcome: text("outcome").notNull(),
    safeMetadata: jsonb("safe_metadata").$type<JsonObject>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("guided_demo_decisions_run_idempotency_uidx").on(
      table.demoRunId,
      table.idempotencyKey,
    ),
  ],
);

export const connectorReadiness = pgTable("connector_readiness", {
  id: uuid("id").primaryKey(),
  integrationConnectionId: uuid("integration_connection_id").references(
    () => integrationConnections.id,
    { onDelete: "set null" },
  ),
  providerType: text("provider_type").notNull(),
  displayName: text("display_name").notNull(),
  readinessStatus: text("readiness_status").$type<ConnectorReadinessStatus>().notNull(),
  lastDryRunAt: timestamp("last_dry_run_at", { withTimezone: true, mode: "string" }),
  lastActivationAt: timestamp("last_activation_at", { withTimezone: true, mode: "string" }),
  lastSuccessfulSyncAt: timestamp("last_successful_sync_at", {
    withTimezone: true,
    mode: "string",
  }),
  lastError: jsonb("last_error").$type<JsonObject>(),
  subscriptionStatus: text("subscription_status"),
  subscriptionExpiresAt: timestamp("subscription_expires_at", {
    withTimezone: true,
    mode: "string",
  }),
  requiredAction: text("required_action"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: version(),
});

export const configurationReleases = pgTable("configuration_releases", {
  id: uuid("id").primaryKey(),
  familyKey: text("family_key").notNull(),
  displayName: text("display_name").notNull(),
  versionNumber: integer("version_number").notNull(),
  status: text("status").notNull(),
  synthetic: boolean("synthetic").notNull().default(true),
  productionReady: boolean("production_ready").notNull().default(false),
  serviceContextKey: text("service_context_key").notNull(),
  description: text("description").notNull(),
  disclosure: text("disclosure").notNull(),
  parentReleaseId: uuid("parent_release_id"),
  checksum: text("checksum"),
  createdByUserId: uuid("created_by_user_id")
    .notNull()
    .references(() => users.id),
  validatedAt: timestamp("validated_at", { withTimezone: true, mode: "string" }),
  publishedAt: timestamp("published_at", { withTimezone: true, mode: "string" }),
  activatedAt: timestamp("activated_at", { withTimezone: true, mode: "string" }),
  archivedAt: timestamp("archived_at", { withTimezone: true, mode: "string" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: version(),
});

export const configurationArtifacts = pgTable("configuration_artifacts", {
  id: uuid("id").primaryKey(),
  releaseId: uuid("release_id")
    .notNull()
    .references(() => configurationReleases.id, { onDelete: "cascade" }),
  artifactKind: text("artifact_kind").notNull(),
  artifactKey: text("artifact_key").notNull(),
  payload: jsonb("payload").$type<JsonObject>().notNull(),
  checksum: text("checksum").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export function getPhase23DigitalWorkforceSchemaColumns() {
  return {
    digitalWorkforceDepartments: Object.keys(getTableColumns(digitalWorkforceDepartments)),
    digitalWorkforceTeams: Object.keys(getTableColumns(digitalWorkforceTeams)),
    digitalWorkforceAgents: Object.keys(getTableColumns(digitalWorkforceAgents)),
    digitalWorkforceAgentVersions: Object.keys(getTableColumns(digitalWorkforceAgentVersions)),
    digitalWorkforceRuns: Object.keys(getTableColumns(digitalWorkforceRuns)),
    digitalWorkforceRunSteps: Object.keys(getTableColumns(digitalWorkforceRunSteps)),
    digitalWorkforceHandoffs: Object.keys(getTableColumns(digitalWorkforceHandoffs)),
    digitalWorkforceRunEvents: Object.keys(getTableColumns(digitalWorkforceRunEvents)),
  } as const;
}

export const schema = {
  users,
  roles,
  permissions,
  userRoles,
  rolePermissions,
  sessions,
  authIdentities,
  localOwnerCredentials,
  workflowDefinitions,
  systemSeedVersions,
  auditLogs,
  featureFlags,
  systemSettings,
  integrationConnections,
  workflowRuns,
  workflowStepRuns,
  companies,
  contacts,
  leads,
  leadParties,
  leadStatusEvents,
  tasks,
  activities,
  notifications,
  conversations,
  assistantMessages,
  workspaceArtifacts,
  suggestedActions,
  actionApprovals,
  actionExecutions,
  aiProviderConnectionTests,
  aiResponseRuns,
  aiMessageCitations,
  aiToolCalls,
  aiRealtimeSessions,
  aiUsageRecords,
  aiModelCache,
  aiUserVoicePreferences,
  generatedArtifacts,
  aiModelCapabilityEvidence,
  executiveDocumentSpecifications,
  aiPresentationRuns,
  apiRateLimitWindows,
  digitalWorkforceDepartments,
  digitalWorkforceTeams,
  digitalWorkforceAgents,
  digitalWorkforceAgentVersions,
  digitalWorkforceRuns,
  digitalWorkforceRunSteps,
  digitalWorkforceHandoffs,
  digitalWorkforceRunEvents,
  reportTemplates,
  reportTemplateVersions,
  projects,
  inspections,
  inspectionSubmissions,
  inspectionFindings,
  inspectionEvidence,
  inspectionValidationResults,
  inspectionReports,
  reportVersions,
  reportDeliveries,
  deliveryAuthorizations,
  exceptionCases,
  slaClocks,
  slaStageIntervals,
  automationEvents,
  automationJobs,
  automationBlueprints,
  connectorReadiness,
  guidedDemoRuns,
  guidedDemoStageStates,
  guidedDemoEvents,
  guidedDemoDecisions,
};
