import type { EntityId, IsoDateTime, JsonObject, VersionedEntity } from "./entities.js";
import type { AiWorkloadRouteKey } from "./ai-routing.js";
import type { RoleId } from "./personas.js";
import type { TenantOwned } from "./tenancy.js";

export const DIGITAL_WORKFORCE_CONTRACT_VERSION = "phase2.3-v1";
export const DIGITAL_WORKFORCE_HIERARCHY_MAX_DEPTH = 4;
export const DIGITAL_AGENT_LABEL = "Digital Agent";

export const DIGITAL_DEPARTMENT_STATUSES = ["active", "paused", "archived"] as const;
export type DigitalDepartmentStatus = (typeof DIGITAL_DEPARTMENT_STATUSES)[number];

export const DIGITAL_TEAM_STATUSES = ["active", "paused", "archived"] as const;
export type DigitalTeamStatus = (typeof DIGITAL_TEAM_STATUSES)[number];

export const DIGITAL_AGENT_STATUSES = ["draft", "active", "paused", "archived"] as const;
export type DigitalAgentStatus = (typeof DIGITAL_AGENT_STATUSES)[number];

export const DIGITAL_AGENT_VERSION_LIFECYCLES = [
  "draft",
  "published",
  "superseded",
  "retired",
] as const;
export type DigitalAgentVersionLifecycle = (typeof DIGITAL_AGENT_VERSION_LIFECYCLES)[number];

export const DIGITAL_AGENT_AVATARS = [
  "executive",
  "manager",
  "specialist-research",
  "specialist-document",
  "specialist-lead",
  "specialist-operations",
  "specialist-schedule",
  "specialist-knowledge",
  "specialist-proposal",
] as const;
export type DigitalAgentAvatar = (typeof DIGITAL_AGENT_AVATARS)[number];

export const DIGITAL_WORKFORCE_MODEL_PROFILES = [
  "executive-premium",
  "balanced",
  "fast",
  "public-research",
  "realtime-voice",
] as const;
export type DigitalWorkforceModelProfile = (typeof DIGITAL_WORKFORCE_MODEL_PROFILES)[number];

export const DIGITAL_WORKFORCE_TOOL_EFFECTS = [
  "read",
  "prepare",
  "preview",
  "execute-with-approval",
] as const;
export type DigitalWorkforceToolEffect = (typeof DIGITAL_WORKFORCE_TOOL_EFFECTS)[number];

export const DIGITAL_WORKFORCE_REGISTERED_TOOLS = [
  "bea_query_records",
  "search_web",
  "bea_connector_health",
  "bea_workflow_history",
  "bea_preview_task",
  "bea_show_workspace",
  "bea_create_pdf",
  "bea_revise_artifact",
  "bea_open_artifact",
  "bea_list_artifacts",
  "bea_download_artifact",
  "bea_delegate_to_agent",
  "bea_get_agent",
  "bea_list_agents",
  "bea_get_agent_run",
  "bea_cancel_agent_run",
  "bea_show_agent_run",
  "bea_show_digital_workforce",
] as const;
export type DigitalWorkforceRegisteredTool = (typeof DIGITAL_WORKFORCE_REGISTERED_TOOLS)[number];

export const DIGITAL_WORKFORCE_DATA_SCOPES = [
  "all-authorized-records",
  "leads",
  "companies",
  "contacts",
  "tasks",
  "activities",
  "notifications",
  "workflow-history",
  "integration-health",
  "research-presentations",
  "artifacts",
  "specific-record-ids",
  "current-conversation",
  "current-selected-record",
] as const;
export type DigitalWorkforceDataScope = (typeof DIGITAL_WORKFORCE_DATA_SCOPES)[number];

export const DIGITAL_WORKFORCE_KNOWLEDGE_SCOPES = [
  "public-web",
  "current-conversation",
  "authorized-bea-records",
  "organizational-file-search",
  "knowledge-collection",
] as const;
export type DigitalWorkforceKnowledgeScope = (typeof DIGITAL_WORKFORCE_KNOWLEDGE_SCOPES)[number];

export const DIGITAL_WORKFORCE_KNOWLEDGE_CONNECTION_STATES = [
  "connected",
  "not-connected",
  "not-available-in-this-phase",
] as const;
export type DigitalWorkforceKnowledgeConnectionState =
  (typeof DIGITAL_WORKFORCE_KNOWLEDGE_CONNECTION_STATES)[number];

export const DIGITAL_WORKFORCE_MEMORY_POLICIES = [
  "none",
  "run-only",
  "conversation-linked",
  "summarized-result-history",
] as const;
export type DigitalWorkforceMemoryPolicy = (typeof DIGITAL_WORKFORCE_MEMORY_POLICIES)[number];

export const DIGITAL_WORKFORCE_APPROVAL_POLICIES = [
  "read-only-no-approval",
  "confirmation-required",
  "owner-approval-required",
  "designated-role-approval-required",
  "always-blocked",
] as const;
export type DigitalWorkforceApprovalPolicy = (typeof DIGITAL_WORKFORCE_APPROVAL_POLICIES)[number];

export const DIGITAL_AGENT_RUN_STATUSES = [
  "draft",
  "validating",
  "queued",
  "planning",
  "running",
  "waiting_for_handoff",
  "waiting_for_approval",
  "synthesizing",
  "completed",
  "partially_completed",
  "failed",
  "cancelled",
  "expired",
  "budget_exceeded",
] as const;
export type DigitalAgentRunStatus = (typeof DIGITAL_AGENT_RUN_STATUSES)[number];

export const DIGITAL_AGENT_STEP_TYPES = [
  "retrieve_records",
  "analyze_records",
  "public_research",
  "prepare_handoff",
  "accept_handoff",
  "generate_artifact",
  "synthesize",
  "prepare_action",
  "await_approval",
  "complete",
] as const;
export type DigitalAgentStepType = (typeof DIGITAL_AGENT_STEP_TYPES)[number];

export const DIGITAL_AGENT_STEP_STATUSES = [
  "queued",
  "claimed",
  "running",
  "completed",
  "failed",
  "cancelled",
  "skipped",
  "blocked",
] as const;
export type DigitalAgentStepStatus = (typeof DIGITAL_AGENT_STEP_STATUSES)[number];

export const DIGITAL_HANDOFF_STATUSES = [
  "proposed",
  "validated",
  "accepted",
  "running",
  "returned",
  "reviewed",
  "completed",
  "rejected",
  "failed",
  "cancelled",
  "expired",
] as const;
export type DigitalHandoffStatus = (typeof DIGITAL_HANDOFF_STATUSES)[number];

export const DIGITAL_WORKFORCE_NOTIFICATION_TYPES = [
  "agent-draft-ready",
  "agent-published",
  "run-started",
  "approval-required",
  "handoff-failed",
  "run-partially-completed",
  "run-completed",
  "run-failed",
  "budget-exceeded",
] as const;
export type DigitalWorkforceNotificationType =
  (typeof DIGITAL_WORKFORCE_NOTIFICATION_TYPES)[number];

export const DIGITAL_WORKFORCE_PAUSE_BEHAVIOR = "finish-current-safe-step" as const;
export type DigitalWorkforcePauseBehavior = typeof DIGITAL_WORKFORCE_PAUSE_BEHAVIOR;

export const EXECUTIVE_TEAM_WORKFLOW_GOAL =
  "Review the leads that still need information, research current public guidance relevant to field water-penetration testing, and create a concise BEA executive briefing with recommendations.";

export const DEFAULT_DIGITAL_WORKFORCE_RUNTIME_POLICY = Object.freeze({
  maximumDurationMs: 10 * 60_000,
  maximumSteps: 20,
  maximumHandoffs: 8,
  maximumHandoffDepth: 3,
  maximumParallelAgents: 3,
  maximumRetriesPerStep: 1,
  maximumProviderCalls: 8,
  maximumWebSearches: 2,
  maximumPdfGenerations: 2,
  maximumInputTokens: 24_000,
  maximumOutputTokens: 8_000,
  maximumEstimatedCostUsd: 3,
  maximumArtifactBytes: 8 * 1024 * 1024,
  pauseBehavior: DIGITAL_WORKFORCE_PAUSE_BEHAVIOR,
  emergencyStopCancelsImmediately: true,
});

export type DigitalWorkforceRuntimePolicy = typeof DEFAULT_DIGITAL_WORKFORCE_RUNTIME_POLICY;

export const DIGITAL_WORKFORCE_MODEL_PROFILE_ROUTES: Readonly<
  Record<DigitalWorkforceModelProfile, AiWorkloadRouteKey>
> = Object.freeze({
  "executive-premium": "executive_conversation",
  balanced: "document_report_drafting",
  fast: "fast_general_conversation",
  "public-research": "public_web_research",
  "realtime-voice": "realtime_voice",
});

export const SEEDED_DIGITAL_WORKFORCE_IDS = Object.freeze({
  departments: {
    executiveOffice: "81000000-0000-4000-8000-000000000001",
    revenue: "81000000-0000-4000-8000-000000000002",
    research: "81000000-0000-4000-8000-000000000003",
    operations: "81000000-0000-4000-8000-000000000004",
    documents: "81000000-0000-4000-8000-000000000005",
  },
  teams: {
    executivePartnership: "82000000-0000-4000-8000-000000000001",
    clientDevelopment: "82000000-0000-4000-8000-000000000002",
    publicResearch: "82000000-0000-4000-8000-000000000003",
    beaKnowledge: "82000000-0000-4000-8000-000000000004",
    projectReadiness: "82000000-0000-4000-8000-000000000005",
    scheduling: "82000000-0000-4000-8000-000000000006",
    executiveDocuments: "82000000-0000-4000-8000-000000000007",
  },
  agents: {
    andrewExecutive: "83000000-0000-4000-8000-000000000001",
    revenueManager: "83000000-0000-4000-8000-000000000002",
    leadReview: "83000000-0000-4000-8000-000000000003",
    proposalPrep: "83000000-0000-4000-8000-000000000004",
    researchManager: "83000000-0000-4000-8000-000000000005",
    publicResearch: "83000000-0000-4000-8000-000000000006",
    beaKnowledge: "83000000-0000-4000-8000-000000000007",
    operationsManager: "83000000-0000-4000-8000-000000000008",
    projectReadiness: "83000000-0000-4000-8000-000000000009",
    scheduling: "83000000-0000-4000-8000-000000000010",
    documentManager: "83000000-0000-4000-8000-000000000011",
    executiveDocument: "83000000-0000-4000-8000-000000000012",
  },
  versions: {
    andrewExecutive: "84000000-0000-4000-8000-000000000001",
    revenueManager: "84000000-0000-4000-8000-000000000002",
    leadReview: "84000000-0000-4000-8000-000000000003",
    proposalPrep: "84000000-0000-4000-8000-000000000004",
    researchManager: "84000000-0000-4000-8000-000000000005",
    publicResearch: "84000000-0000-4000-8000-000000000006",
    beaKnowledge: "84000000-0000-4000-8000-000000000007",
    operationsManager: "84000000-0000-4000-8000-000000000008",
    projectReadiness: "84000000-0000-4000-8000-000000000009",
    scheduling: "84000000-0000-4000-8000-000000000010",
    documentManager: "84000000-0000-4000-8000-000000000011",
    executiveDocument: "84000000-0000-4000-8000-000000000012",
  },
});

export interface DigitalWorkforceRuntimeLimits {
  readonly maximumDurationMs: number;
  readonly maximumSteps: number;
  readonly maximumHandoffs: number;
  readonly maximumHandoffDepth: number;
  readonly maximumParallelAgents: number;
  readonly maximumRetriesPerStep: number;
  readonly maximumProviderCalls: number;
  readonly maximumWebSearches: number;
  readonly maximumPdfGenerations: number;
  readonly maximumInputTokens: number;
  readonly maximumOutputTokens: number;
  readonly maximumEstimatedCostUsd: number;
  readonly maximumArtifactBytes: number;
  readonly pauseBehavior: DigitalWorkforcePauseBehavior;
  readonly emergencyStopCancelsImmediately: boolean;
}

export interface DigitalWorkforceToolGrant {
  readonly toolName: DigitalWorkforceRegisteredTool;
  readonly enabled: boolean;
  readonly allowedEffect: DigitalWorkforceToolEffect;
  readonly approvalRequired: boolean;
  readonly maximumCallsPerRun: number;
  readonly toolPolicyVersion: string;
}

export interface DigitalWorkforceDataScopeGrant {
  readonly scope: DigitalWorkforceDataScope;
  readonly enabled: boolean;
  readonly recordIds: readonly EntityId[];
}

export interface DigitalWorkforceKnowledgeScopeGrant {
  readonly scope: DigitalWorkforceKnowledgeScope;
  readonly connectionState: DigitalWorkforceKnowledgeConnectionState;
  readonly collectionId: string | null;
  readonly disclosure: string;
}

export interface DigitalWorkforceModelAssignment {
  readonly profile: DigitalWorkforceModelProfile;
  readonly provider: "openai";
  readonly primaryModel: string;
  readonly fallbackModel: string | null;
  readonly routeKey: AiWorkloadRouteKey;
  readonly reasoningEffort: "none" | "low" | "medium" | "high";
  readonly requiredCapabilities: readonly string[];
  readonly costClass: "low" | "standard" | "high";
  readonly capabilityEvidenceVersion: string | null;
  readonly verifiedAt: IsoDateTime | null;
}

export interface DigitalWorkforceDepartment extends VersionedEntity {
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly status: DigitalDepartmentStatus;
  readonly displayOrder: number;
  readonly parentDepartmentId: EntityId | null;
  readonly createdByUserId: EntityId;
}

export interface DigitalWorkforceTeam extends VersionedEntity {
  readonly departmentId: EntityId;
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly status: DigitalTeamStatus;
  readonly teamLeadAgentId: EntityId | null;
  readonly displayOrder: number;
  readonly createdByUserId: EntityId;
}

export interface DigitalWorkforceAgentIdentity extends VersionedEntity {
  readonly slug: string;
  readonly displayName: string;
  readonly roleTitle: string;
  readonly shortDescription: string;
  readonly departmentId: EntityId;
  readonly teamId: EntityId;
  readonly supportedHumanUserId: EntityId | null;
  readonly currentPublishedVersionId: EntityId | null;
  readonly status: DigitalAgentStatus;
  readonly avatar: DigitalAgentAvatar;
  readonly createdByUserId: EntityId;
}

export interface DigitalWorkforceAgentVersion extends VersionedEntity {
  readonly agentId: EntityId;
  readonly versionNumber: number;
  readonly lifecycle: DigitalAgentVersionLifecycle;
  readonly persona: string;
  readonly roleDefinition: string;
  readonly goals: readonly string[];
  readonly successCriteria: readonly string[];
  readonly departmentId: EntityId;
  readonly teamId: EntityId;
  readonly supervisorAgentId: EntityId | null;
  readonly preferredHandoffAgentIds: readonly EntityId[];
  readonly availableToRoleIds: readonly RoleId[];
  readonly modelAssignment: DigitalWorkforceModelAssignment;
  readonly toolGrants: readonly DigitalWorkforceToolGrant[];
  readonly dataScopes: readonly DigitalWorkforceDataScopeGrant[];
  readonly knowledgeScopes: readonly DigitalWorkforceKnowledgeScopeGrant[];
  readonly memoryPolicy: DigitalWorkforceMemoryPolicy;
  readonly approvalPolicy: DigitalWorkforceApprovalPolicy;
  readonly designatedApproverRoleId: RoleId | null;
  readonly escalationInstructions: string;
  readonly runtimePolicy: DigitalWorkforceRuntimeLimits;
  readonly configurationHash: string;
  readonly createdByUserId: EntityId;
  readonly publishedByUserId: EntityId | null;
  readonly publishedAt: IsoDateTime | null;
}

export interface DigitalWorkforceExecutionPlanStep {
  readonly key: string;
  readonly stepType: DigitalAgentStepType;
  readonly agentId: EntityId;
  readonly agentVersionId: EntityId;
  readonly dependsOn: readonly string[];
  readonly parallelGroup: string | null;
  readonly assignedWhy: string;
}

export interface DigitalWorkforceExecutionPlan {
  readonly planVersion: typeof DIGITAL_WORKFORCE_CONTRACT_VERSION;
  readonly rootAgentId: EntityId;
  readonly rootAgentVersionId: EntityId;
  readonly goal: string;
  readonly steps: readonly DigitalWorkforceExecutionPlanStep[];
}

export interface DigitalAgentRun extends VersionedEntity {
  readonly initiatingUserId: EntityId;
  readonly conversationId: EntityId | null;
  readonly initiatingMessageId: EntityId | null;
  readonly rootAgentId: EntityId;
  readonly rootAgentVersionId: EntityId;
  readonly goal: string;
  readonly normalizedRequest: string;
  readonly executionPlan: DigitalWorkforceExecutionPlan | null;
  readonly status: DigitalAgentRunStatus;
  readonly currentStepKey: string | null;
  readonly idempotencyKey: string;
  readonly sourceRecordIds: readonly EntityId[];
  readonly sourceArtifactIds: readonly EntityId[];
  readonly sourcePresentationIds: readonly EntityId[];
  readonly outputArtifactIds: readonly EntityId[];
  readonly estimatedCostUsd: number;
  readonly actualCostUsd: number | null;
  readonly providerCallCount: number;
  readonly webSearchCount: number;
  readonly pdfGenerationCount: number;
  readonly startedAt: IsoDateTime | null;
  readonly completedAt: IsoDateTime | null;
  readonly expiresAt: IsoDateTime | null;
  readonly claimedAt: IsoDateTime | null;
  readonly claimOwner: string | null;
  readonly cancellationRequested: boolean;
  readonly cancelledByUserId: EntityId | null;
  readonly cancellationReason: string | null;
  readonly safeError: string | null;
  readonly executiveSummary: string | null;
  readonly correlationId: string;
}

export interface DigitalAgentRunStep extends VersionedEntity {
  readonly runId: EntityId;
  readonly stepKey: string;
  readonly stepType: DigitalAgentStepType;
  readonly agentId: EntityId;
  readonly agentVersionId: EntityId;
  readonly status: DigitalAgentStepStatus;
  readonly idempotencyKey: string;
  readonly sequence: number;
  readonly parallelGroup: string | null;
  readonly assignedWhy: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly fallbackModelUsed: string | null;
  readonly toolNames: readonly string[];
  readonly authorizedRecordIds: readonly EntityId[];
  readonly citationIds: readonly EntityId[];
  readonly artifactIds: readonly EntityId[];
  readonly usageJson: JsonObject;
  readonly resultJson: JsonObject;
  readonly safeError: string | null;
  readonly retryCount: number;
  readonly startedAt: IsoDateTime | null;
  readonly finishedAt: IsoDateTime | null;
}

export interface DigitalWorkforceHandoffPacket {
  readonly reason: string;
  readonly requestedDeliverable: string;
  readonly boundedContextSummary: string;
  readonly knownFacts: readonly string[];
  readonly uncertainties: readonly string[];
  readonly authorizedRecordIds: readonly EntityId[];
  readonly authorizedPresentationIds: readonly EntityId[];
  readonly authorizedArtifactIds: readonly EntityId[];
  readonly citationIds: readonly EntityId[];
  readonly allowedTools: readonly DigitalWorkforceRegisteredTool[];
  readonly outputSchema: string;
  readonly budgetAllocationUsd: number;
}

export interface DigitalWorkforceHandoff extends VersionedEntity {
  readonly runId: EntityId;
  readonly parentStepId: EntityId | null;
  readonly fromAgentId: EntityId;
  readonly fromAgentVersionId: EntityId;
  readonly toAgentId: EntityId;
  readonly toAgentVersionId: EntityId;
  readonly depth: number;
  readonly status: DigitalHandoffStatus;
  readonly packet: DigitalWorkforceHandoffPacket;
  readonly returnedResult: JsonObject | null;
  readonly safeFailure: string | null;
  readonly approvalRequired: boolean;
  readonly expiresAt: IsoDateTime | null;
}

export interface DigitalWorkforceRunEvent {
  readonly id: EntityId;
  readonly runId: EntityId;
  readonly sequence: number;
  readonly eventType: string;
  readonly agentId: EntityId | null;
  readonly stepId: EntityId | null;
  readonly handoffId: EntityId | null;
  readonly narration: string | null;
  readonly metadata: JsonObject;
  readonly createdAt: IsoDateTime;
}

export interface DigitalWorkforceEffectivePermissions {
  readonly initiatingUserId: EntityId;
  readonly agentId: EntityId;
  readonly agentVersionId: EntityId;
  readonly humanPermissions: readonly string[];
  readonly grantedTools: readonly DigitalWorkforceRegisteredTool[];
  readonly grantedDataScopes: readonly DigitalWorkforceDataScope[];
  readonly grantedKnowledgeScopes: readonly DigitalWorkforceKnowledgeScope[];
  readonly approvalPolicy: DigitalWorkforceApprovalPolicy;
  readonly deniedReasons: readonly string[];
}

export interface DigitalWorkforceOrganizationNode {
  readonly agentId: EntityId;
  readonly displayName: string;
  readonly roleTitle: string;
  readonly slug: string;
  readonly avatar: DigitalAgentAvatar;
  readonly status: DigitalAgentStatus;
  readonly departmentId: EntityId;
  readonly departmentName: string;
  readonly teamId: EntityId;
  readonly teamName: string;
  readonly supervisorAgentId: EntityId | null;
  readonly supportedHumanUserId: EntityId | null;
  readonly supportedHumanDisplayName: string | null;
  readonly publishedVersionId: EntityId | null;
  readonly modelProfile: DigitalWorkforceModelProfile | null;
  readonly modelId: string | null;
  readonly currentRunId: EntityId | null;
  readonly currentRunStatus: DigitalAgentRunStatus | null;
  readonly workingState: "working" | "idle" | "paused" | "archived" | "draft";
  readonly directReportCount: number;
  readonly digitalAgentLabel: typeof DIGITAL_AGENT_LABEL;
}

export const WORKSPACE_DIGITAL_WORKFORCE_ARTIFACT_TYPES = [
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
export type WorkspaceDigitalWorkforceArtifactType =
  (typeof WORKSPACE_DIGITAL_WORKFORCE_ARTIFACT_TYPES)[number];

export type AgentHierarchyLevel =
  "ceo-executive" | "department-manager" | "team-manager" | "specialist";

export interface DigitalAgentProfile extends VersionedEntity, TenantOwned {
  readonly name: string;
  readonly title: string;
  readonly hierarchyLevel: AgentHierarchyLevel;
  readonly persona: string;
  readonly biography: string;
  readonly expertise: readonly string[];
  readonly behaviorDocumentIds: readonly EntityId[];
  readonly exampleWorkArtifactIds: readonly EntityId[];
  readonly systemInstructions: string;
  readonly goalIds: readonly EntityId[];
  readonly toolKeys: readonly string[];
  readonly connectorPermissionIds: readonly EntityId[];
  readonly knowledgeScopeIds: readonly EntityId[];
  readonly memoryPolicyId: EntityId;
  readonly modelRoutingProfileId: EntityId;
  readonly approvalPolicyId: EntityId;
  readonly escalationPolicyId: EntityId;
  readonly teamId: EntityId;
  readonly departmentId: EntityId;
  readonly managerAgentId: EntityId | null;
  readonly directReportAgentIds: readonly EntityId[];
  readonly evaluationCriteria: readonly string[];
}

export interface DigitalWorkforceGoal extends VersionedEntity, TenantOwned {
  readonly ownerAgentId: EntityId;
  readonly title: string;
  readonly successCriteria: readonly string[];
  readonly status: "draft" | "active" | "achieved" | "cancelled";
}

export interface DelegatedAgentTask extends VersionedEntity, TenantOwned {
  readonly parentTaskId: EntityId | null;
  readonly requestedByActorId: EntityId;
  readonly delegatedByAgentId: EntityId;
  readonly assignedManagerAgentId: EntityId;
  readonly assignedSpecialistAgentIds: readonly EntityId[];
  readonly goalId: EntityId;
  readonly instructions: string;
  readonly sourceReferences: readonly string[];
  readonly status:
    | "queued"
    | "assigned"
    | "in_progress"
    | "under_review"
    | "correction_requested"
    | "completed"
    | "cancelled";
  readonly approvalRequired: boolean;
  readonly dueAt: IsoDateTime | null;
}

export interface AgentHandoff extends VersionedEntity, TenantOwned {
  readonly taskId: EntityId;
  readonly fromAgentId: EntityId;
  readonly toAgentId: EntityId;
  readonly reason: string;
  readonly contextReferences: readonly string[];
  readonly acceptedAt: IsoDateTime | null;
}

export interface AgentReviewRecord extends VersionedEntity, TenantOwned {
  readonly taskId: EntityId;
  readonly reviewerAgentId: EntityId;
  readonly subjectAgentIds: readonly EntityId[];
  readonly sourceVerification: "not_run" | "pass" | "fail";
  readonly completeness: "not_run" | "pass" | "fail";
  readonly quality: "not_run" | "pass" | "fail";
  readonly decision: "accept" | "request_correction" | "escalate";
  readonly findings: readonly string[];
  readonly evidenceReferences: readonly string[];
}

export interface AgentPerformanceRecord extends VersionedEntity, TenantOwned {
  readonly agentId: EntityId;
  readonly taskId: EntityId;
  readonly measuredAt: IsoDateTime;
  readonly metrics: JsonObject;
  readonly reviewerActorId: EntityId;
}

export interface DelegationAuditTrail extends TenantOwned {
  readonly requestId: EntityId;
  readonly rootTaskId: EntityId;
  readonly eventIds: readonly EntityId[];
  readonly sourceReferences: readonly string[];
  readonly finalArtifactReferences: readonly string[];
  readonly completedAt: IsoDateTime | null;
}

export interface DigitalWorkforceOrchestrator {
  planDelegation(task: DelegatedAgentTask): Promise<{
    readonly proposedManagerAgentId: EntityId;
    readonly proposedSpecialistAgentIds: readonly EntityId[];
    readonly ownerApprovalRequired: boolean;
  }>;
  requestCorrection(review: AgentReviewRecord): Promise<DelegatedAgentTask>;
  synthesize(
    rootTaskId: EntityId,
    completedTaskIds: readonly EntityId[],
  ): Promise<{ readonly artifactReference: string; readonly auditTrailId: EntityId }>;
}
