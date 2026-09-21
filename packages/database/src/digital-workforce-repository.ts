import { randomUUID } from "node:crypto";
import {
  assertAvatar,
  assertHierarchyAssignment,
  assertSafeBoundedText,
  assertSlug,
  boundedHandoffContext,
  canTransitionDigitalAgentRun,
  canTransitionDigitalHandoff,
  DEFAULT_DIGITAL_WORKFORCE_RUNTIME_POLICY,
  DIGITAL_AGENT_LABEL,
  DigitalWorkforcePolicyError,
  hashAgentVersionConfiguration,
  isApprovalPolicy,
  isMemoryPolicy,
  isTerminalRunStatus,
  nextAgentVersionLifecycle,
  normalizeRuntimePolicy,
  type DigitalAgentRun,
  type DigitalAgentRunStatus,
  type DigitalAgentRunStep,
  type DigitalAgentStatus,
  type DigitalAgentStepStatus,
  type DigitalDepartmentStatus,
  type DigitalHandoffStatus,
  type DigitalTeamStatus,
  type DigitalWorkforceAgentIdentity,
  type DigitalWorkforceAgentVersion,
  type DigitalWorkforceDepartment,
  type DigitalWorkforceExecutionPlan,
  type DigitalWorkforceHandoff,
  type DigitalWorkforceHandoffPacket,
  type DigitalWorkforceOrganizationNode,
  type DigitalWorkforceRunEvent,
  type DigitalWorkforceTeam,
  type RoleId,
} from "@bea/domain";
import type { DatabaseAdapter, SqlExecutor } from "./adapter.js";

type Row = Record<string, unknown>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class DigitalWorkforceValidationError extends Error {
  readonly code = "DIGITAL_WORKFORCE_VALIDATION";
  constructor(message: string) {
    super(message);
    this.name = "DigitalWorkforceValidationError";
  }
}

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

function requiredUuid(value: string, name: string): string {
  const normalized = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new DigitalWorkforceValidationError(`${name} must be a canonical UUID.`);
  }
  return normalized;
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function booleanValue(value: unknown): boolean {
  return value === true || value === "t" || value === "true";
}

function clampLimit(value: number | undefined, fallback = 50, maximum = 100): number {
  return Math.max(1, Math.min(maximum, Math.trunc(value ?? fallback)));
}

function mapDepartment(row: Row): DigitalWorkforceDepartment {
  return {
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    description: String(row.description ?? ""),
    status: String(row.status) as DigitalDepartmentStatus,
    displayOrder: numberValue(row.display_order),
    parentDepartmentId: nullableString(row.parent_department_id),
    createdByUserId: String(row.created_by_user_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: numberValue(row.version),
  };
}

function mapTeam(row: Row): DigitalWorkforceTeam {
  return {
    id: String(row.id),
    departmentId: String(row.department_id),
    name: String(row.name),
    slug: String(row.slug),
    description: String(row.description ?? ""),
    status: String(row.status) as DigitalTeamStatus,
    teamLeadAgentId: nullableString(row.team_lead_agent_id),
    displayOrder: numberValue(row.display_order),
    createdByUserId: String(row.created_by_user_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: numberValue(row.version),
  };
}

function mapAgent(row: Row): DigitalWorkforceAgentIdentity {
  return {
    id: String(row.id),
    slug: String(row.slug),
    displayName: String(row.display_name),
    roleTitle: String(row.role_title),
    shortDescription: String(row.short_description ?? ""),
    departmentId: String(row.department_id),
    teamId: String(row.team_id),
    supportedHumanUserId: nullableString(row.supported_human_user_id),
    currentPublishedVersionId: nullableString(row.current_published_version_id),
    status: String(row.status) as DigitalAgentStatus,
    avatar: assertAvatar(String(row.avatar)),
    createdByUserId: String(row.created_by_user_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: numberValue(row.version),
  };
}

function mapVersion(row: Row): DigitalWorkforceAgentVersion {
  const memoryPolicy = String(row.memory_policy);
  const approvalPolicy = String(row.approval_policy);
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    versionNumber: numberValue(row.version_number),
    lifecycle: String(row.lifecycle) as DigitalWorkforceAgentVersion["lifecycle"],
    persona: String(row.persona),
    roleDefinition: String(row.role_definition),
    goals: json<string[]>(row.goals, []),
    successCriteria: json<string[]>(row.success_criteria, []),
    departmentId: String(row.department_id),
    teamId: String(row.team_id),
    supervisorAgentId: nullableString(row.supervisor_agent_id),
    preferredHandoffAgentIds: json<string[]>(row.preferred_handoff_agent_ids, []),
    availableToRoleIds: json<RoleId[]>(row.available_to_role_ids, []),
    modelAssignment: json(row.model_assignment, {
      profile: "balanced",
      provider: "openai",
      primaryModel: "unconfigured",
      fallbackModel: null,
      routeKey: "document_report_drafting",
      reasoningEffort: "low",
      requiredCapabilities: ["responsesText"],
      costClass: "standard",
      capabilityEvidenceVersion: null,
      verifiedAt: null,
    }),
    toolGrants: json(row.tool_grants, []),
    dataScopes: json(row.data_scopes, []),
    knowledgeScopes: json(row.knowledge_scopes, []),
    memoryPolicy: isMemoryPolicy(memoryPolicy) ? memoryPolicy : "run-only",
    approvalPolicy: isApprovalPolicy(approvalPolicy) ? approvalPolicy : "confirmation-required",
    designatedApproverRoleId: nullableString(row.designated_approver_role_id) as RoleId | null,
    escalationInstructions: String(row.escalation_instructions ?? ""),
    runtimePolicy: normalizeRuntimePolicy(
      json(row.runtime_policy, DEFAULT_DIGITAL_WORKFORCE_RUNTIME_POLICY),
    ),
    configurationHash: String(row.configuration_hash),
    createdByUserId: String(row.created_by_user_id),
    publishedByUserId: nullableString(row.published_by_user_id),
    publishedAt: nullableIso(row.published_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: numberValue(row.version),
  };
}

function mapRun(row: Row): DigitalAgentRun {
  return {
    id: String(row.id),
    initiatingUserId: String(row.initiating_user_id),
    conversationId: nullableString(row.conversation_id),
    initiatingMessageId: nullableString(row.initiating_message_id),
    rootAgentId: String(row.root_agent_id),
    rootAgentVersionId: String(row.root_agent_version_id),
    goal: String(row.goal),
    normalizedRequest: String(row.normalized_request),
    executionPlan: json<DigitalWorkforceExecutionPlan | null>(row.execution_plan, null),
    status: String(row.status) as DigitalAgentRunStatus,
    currentStepKey: nullableString(row.current_step_key),
    idempotencyKey: String(row.idempotency_key),
    sourceRecordIds: json<string[]>(row.source_record_ids, []),
    sourceArtifactIds: json<string[]>(row.source_artifact_ids, []),
    sourcePresentationIds: json<string[]>(row.source_presentation_ids, []),
    outputArtifactIds: json<string[]>(row.output_artifact_ids, []),
    estimatedCostUsd: numberValue(row.estimated_cost_usd),
    actualCostUsd: row.actual_cost_usd === null ? null : numberValue(row.actual_cost_usd),
    providerCallCount: numberValue(row.provider_call_count),
    webSearchCount: numberValue(row.web_search_count),
    pdfGenerationCount: numberValue(row.pdf_generation_count),
    startedAt: nullableIso(row.started_at),
    completedAt: nullableIso(row.completed_at),
    expiresAt: nullableIso(row.expires_at),
    claimedAt: nullableIso(row.claimed_at),
    claimOwner: nullableString(row.claim_owner),
    cancellationRequested: booleanValue(row.cancellation_requested),
    cancelledByUserId: nullableString(row.cancelled_by_user_id),
    cancellationReason: nullableString(row.cancellation_reason),
    safeError: nullableString(row.safe_error),
    executiveSummary: nullableString(row.executive_summary),
    correlationId: String(row.correlation_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: numberValue(row.version),
  };
}

function mapStep(row: Row): DigitalAgentRunStep {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    stepKey: String(row.step_key),
    stepType: row.step_type as DigitalAgentRunStep["stepType"],
    agentId: String(row.agent_id),
    agentVersionId: String(row.agent_version_id),
    status: String(row.status) as DigitalAgentStepStatus,
    idempotencyKey: String(row.idempotency_key),
    sequence: numberValue(row.sequence),
    parallelGroup: nullableString(row.parallel_group),
    assignedWhy: String(row.assigned_why ?? ""),
    provider: nullableString(row.provider),
    model: nullableString(row.model),
    fallbackModelUsed: nullableString(row.fallback_model_used),
    toolNames: json<string[]>(row.tool_names, []),
    authorizedRecordIds: json<string[]>(row.authorized_record_ids, []),
    citationIds: json<string[]>(row.citation_ids, []),
    artifactIds: json<string[]>(row.artifact_ids, []),
    usageJson: json(row.usage_json, {}),
    resultJson: json(row.result_json, {}),
    safeError: nullableString(row.safe_error),
    retryCount: numberValue(row.retry_count),
    startedAt: nullableIso(row.started_at),
    finishedAt: nullableIso(row.finished_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: numberValue(row.version),
  };
}

function mapHandoff(row: Row): DigitalWorkforceHandoff {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    parentStepId: nullableString(row.parent_step_id),
    fromAgentId: String(row.from_agent_id),
    fromAgentVersionId: String(row.from_agent_version_id),
    toAgentId: String(row.to_agent_id),
    toAgentVersionId: String(row.to_agent_version_id),
    depth: numberValue(row.depth),
    status: String(row.status) as DigitalHandoffStatus,
    packet: json<DigitalWorkforceHandoffPacket>(row.packet, {
      reason: "",
      requestedDeliverable: "",
      boundedContextSummary: "",
      knownFacts: [],
      uncertainties: [],
      authorizedRecordIds: [],
      authorizedPresentationIds: [],
      authorizedArtifactIds: [],
      citationIds: [],
      allowedTools: [],
      outputSchema: "phase2.3-v1",
      budgetAllocationUsd: 0,
    }),
    returnedResult: json(row.returned_result, null),
    safeFailure: nullableString(row.safe_failure),
    approvalRequired: booleanValue(row.approval_required),
    expiresAt: nullableIso(row.expires_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: numberValue(row.version),
  };
}

export class SqlDigitalWorkforceRepository {
  constructor(private readonly database: DatabaseAdapter) {}

  async listDepartments(): Promise<readonly DigitalWorkforceDepartment[]> {
    const result = await this.database.query<Row>(
      `SELECT * FROM digital_workforce_departments ORDER BY display_order, name`,
    );
    return result.rows.map(mapDepartment);
  }

  async listTeams(departmentId?: string): Promise<readonly DigitalWorkforceTeam[]> {
    const result = departmentId
      ? await this.database.query<Row>(
          `SELECT * FROM digital_workforce_teams WHERE department_id=$1 ORDER BY display_order, name`,
          [requiredUuid(departmentId, "department ID")],
        )
      : await this.database.query<Row>(
          `SELECT * FROM digital_workforce_teams ORDER BY display_order, name`,
        );
    return result.rows.map(mapTeam);
  }

  async getAgent(id: string): Promise<DigitalWorkforceAgentIdentity | null> {
    const result = await this.database.query<Row>(
      `SELECT * FROM digital_workforce_agents WHERE id=$1`,
      [requiredUuid(id, "agent ID")],
    );
    return result.rows[0] ? mapAgent(result.rows[0]) : null;
  }

  async getAgentBySlug(slug: string): Promise<DigitalWorkforceAgentIdentity | null> {
    const result = await this.database.query<Row>(
      `SELECT * FROM digital_workforce_agents WHERE slug=$1`,
      [assertSlug(slug)],
    );
    return result.rows[0] ? mapAgent(result.rows[0]) : null;
  }

  async getPublishedVersion(agentId: string): Promise<DigitalWorkforceAgentVersion | null> {
    const result = await this.database.query<Row>(
      `SELECT v.* FROM digital_workforce_agent_versions v
       JOIN digital_workforce_agents a ON a.current_published_version_id=v.id
       WHERE a.id=$1`,
      [requiredUuid(agentId, "agent ID")],
    );
    return result.rows[0] ? mapVersion(result.rows[0]) : null;
  }

  async getVersion(id: string): Promise<DigitalWorkforceAgentVersion | null> {
    const result = await this.database.query<Row>(
      `SELECT * FROM digital_workforce_agent_versions WHERE id=$1`,
      [requiredUuid(id, "version ID")],
    );
    return result.rows[0] ? mapVersion(result.rows[0]) : null;
  }

  async listAgentVersions(agentId: string): Promise<readonly DigitalWorkforceAgentVersion[]> {
    const result = await this.database.query<Row>(
      `SELECT * FROM digital_workforce_agent_versions WHERE agent_id=$1
       ORDER BY version_number DESC`,
      [requiredUuid(agentId, "agent ID")],
    );
    return result.rows.map(mapVersion);
  }

  async listAgents(
    options: {
      readonly query?: string;
      readonly status?: DigitalAgentStatus;
      readonly departmentId?: string;
      readonly teamId?: string;
      readonly availableToRoleIds?: readonly RoleId[];
      readonly includeArchived?: boolean;
      readonly limit?: number;
      readonly offset?: number;
    } = {},
  ): Promise<readonly DigitalWorkforceAgentIdentity[]> {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (options.query) {
      parameters.push(`%${options.query.trim().slice(0, 80).replaceAll("%", "\\%")}%`);
      clauses.push(
        `(display_name ILIKE $${parameters.length} OR role_title ILIKE $${parameters.length} OR slug ILIKE $${parameters.length})`,
      );
    }
    if (options.status) {
      parameters.push(options.status);
      clauses.push(`status=$${parameters.length}`);
    } else if (!options.includeArchived) {
      clauses.push(`status <> 'archived'`);
    }
    if (options.departmentId) {
      parameters.push(requiredUuid(options.departmentId, "department ID"));
      clauses.push(`department_id=$${parameters.length}`);
    }
    if (options.teamId) {
      parameters.push(requiredUuid(options.teamId, "team ID"));
      clauses.push(`team_id=$${parameters.length}`);
    }
    parameters.push(clampLimit(options.limit));
    const limitParameter = parameters.length;
    parameters.push(Math.max(0, Math.trunc(options.offset ?? 0)));
    const result = await this.database.query<Row>(
      `SELECT * FROM digital_workforce_agents
       ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY display_name, id
       LIMIT $${limitParameter} OFFSET $${parameters.length}`,
      parameters,
    );
    const agents = result.rows.map(mapAgent);
    if (!options.availableToRoleIds || options.availableToRoleIds.length === 0) return agents;
    const published = await this.database.query<Row>(
      `SELECT agent_id, available_to_role_ids FROM digital_workforce_agent_versions
       WHERE id IN (SELECT current_published_version_id FROM digital_workforce_agents WHERE current_published_version_id IS NOT NULL)`,
    );
    const allowed = new Set<string>();
    for (const row of published.rows) {
      const roles = json<string[]>(row.available_to_role_ids, []);
      if (
        options.availableToRoleIds.some((role) => roles.includes(role) || role === "owner-admin")
      ) {
        allowed.add(String(row.agent_id));
      }
    }
    if (options.availableToRoleIds.includes("owner-admin")) return agents;
    return agents.filter((agent) => allowed.has(agent.id) || agent.status === "draft");
  }

  async listOrganization(
    options: {
      readonly availableToRoleIds?: readonly RoleId[];
    } = {},
  ): Promise<readonly DigitalWorkforceOrganizationNode[]> {
    const agents = await this.listAgents({
      includeArchived: true,
      limit: 200,
      ...(options.availableToRoleIds ? { availableToRoleIds: options.availableToRoleIds } : {}),
    });
    const [departments, teams, versions, activeRuns] = await Promise.all([
      this.listDepartments(),
      this.listTeams(),
      this.database.query<Row>(
        `SELECT * FROM digital_workforce_agent_versions WHERE lifecycle='published'`,
      ),
      this.database.query<Row>(
        `SELECT id, root_agent_id, status FROM digital_workforce_runs
         WHERE status IN ('queued','planning','running','waiting_for_handoff','waiting_for_approval','synthesizing')`,
      ),
    ]);
    const departmentName = new Map(departments.map((item) => [item.id, item.name]));
    const teamName = new Map(teams.map((item) => [item.id, item.name]));
    const versionById = new Map(versions.rows.map((row) => [String(row.id), mapVersion(row)]));
    const runByAgent = new Map(
      activeRuns.rows.map((row) => [
        String(row.root_agent_id),
        { id: String(row.id), status: String(row.status) as DigitalAgentRunStatus },
      ]),
    );
    const users = await this.database.query<Row>(`SELECT id::text AS id, display_name FROM users`);
    const userName = new Map(users.rows.map((row) => [String(row.id), String(row.display_name)]));
    const reportCounts = new Map<string, number>();
    for (const version of versionById.values()) {
      if (!version.supervisorAgentId) continue;
      reportCounts.set(
        version.supervisorAgentId,
        (reportCounts.get(version.supervisorAgentId) ?? 0) + 1,
      );
    }
    return agents.map((agent) => {
      const published = agent.currentPublishedVersionId
        ? versionById.get(agent.currentPublishedVersionId)
        : undefined;
      const run = runByAgent.get(agent.id);
      const workingState =
        agent.status === "archived"
          ? "archived"
          : agent.status === "paused"
            ? "paused"
            : agent.status === "draft"
              ? "draft"
              : run
                ? "working"
                : "idle";
      return {
        agentId: agent.id,
        displayName: agent.displayName,
        roleTitle: agent.roleTitle,
        slug: agent.slug,
        avatar: agent.avatar,
        status: agent.status,
        departmentId: agent.departmentId,
        departmentName: departmentName.get(agent.departmentId) ?? "Unknown department",
        teamId: agent.teamId,
        teamName: teamName.get(agent.teamId) ?? "Unknown team",
        supervisorAgentId: published?.supervisorAgentId ?? null,
        supportedHumanUserId: agent.supportedHumanUserId,
        supportedHumanDisplayName: agent.supportedHumanUserId
          ? (userName.get(agent.supportedHumanUserId) ?? null)
          : null,
        publishedVersionId: agent.currentPublishedVersionId,
        modelProfile: published?.modelAssignment.profile ?? null,
        modelId: published?.modelAssignment.primaryModel ?? null,
        currentRunId: run?.id ?? null,
        currentRunStatus: run?.status ?? null,
        workingState,
        directReportCount: reportCounts.get(agent.id) ?? 0,
        digitalAgentLabel: DIGITAL_AGENT_LABEL,
      };
    });
  }

  async upsertDepartment(input: {
    readonly id?: string;
    readonly name: string;
    readonly slug: string;
    readonly description: string;
    readonly status: DigitalDepartmentStatus;
    readonly displayOrder: number;
    readonly parentDepartmentId?: string | null;
    readonly createdByUserId: string;
  }): Promise<DigitalWorkforceDepartment> {
    const id = input.id ?? randomUUID();
    const result = await this.database.query<Row>(
      `INSERT INTO digital_workforce_departments
       (id,name,slug,description,status,display_order,parent_department_id,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,slug=EXCLUDED.slug,description=EXCLUDED.description,
       status=EXCLUDED.status,display_order=EXCLUDED.display_order,parent_department_id=EXCLUDED.parent_department_id,
       updated_at=CURRENT_TIMESTAMP,version=digital_workforce_departments.version+1
       RETURNING *`,
      [
        id,
        assertSafeBoundedText(input.name, "department name", 120),
        assertSlug(input.slug),
        assertSafeBoundedText(input.description || " ", "department description", 2000).trim(),
        input.status,
        input.displayOrder,
        input.parentDepartmentId,
        requiredUuid(input.createdByUserId, "created by"),
      ],
    );
    return mapDepartment(result.rows[0]!);
  }

  async upsertTeam(input: {
    readonly id?: string;
    readonly departmentId: string;
    readonly name: string;
    readonly slug: string;
    readonly description: string;
    readonly status: DigitalTeamStatus;
    readonly teamLeadAgentId?: string | null;
    readonly displayOrder: number;
    readonly createdByUserId: string;
  }): Promise<DigitalWorkforceTeam> {
    const id = input.id ?? randomUUID();
    const result = await this.database.query<Row>(
      `INSERT INTO digital_workforce_teams
       (id,department_id,name,slug,description,status,team_lead_agent_id,display_order,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1)
       ON CONFLICT (id) DO UPDATE SET department_id=EXCLUDED.department_id,name=EXCLUDED.name,slug=EXCLUDED.slug,
       description=EXCLUDED.description,status=EXCLUDED.status,team_lead_agent_id=EXCLUDED.team_lead_agent_id,
       display_order=EXCLUDED.display_order,updated_at=CURRENT_TIMESTAMP,version=digital_workforce_teams.version+1
       RETURNING *`,
      [
        id,
        requiredUuid(input.departmentId, "department ID"),
        assertSafeBoundedText(input.name, "team name", 120),
        assertSlug(input.slug),
        assertSafeBoundedText(input.description || " ", "team description", 2000).trim(),
        input.status,
        input.teamLeadAgentId ?? null,
        input.displayOrder,
        requiredUuid(input.createdByUserId, "created by"),
      ],
    );
    return mapTeam(result.rows[0]!);
  }

  async createAgentDraft(input: {
    readonly id?: string;
    readonly slug: string;
    readonly displayName: string;
    readonly roleTitle: string;
    readonly shortDescription: string;
    readonly departmentId: string;
    readonly teamId: string;
    readonly supportedHumanUserId?: string | null;
    readonly avatar: string;
    readonly createdByUserId: string;
    readonly version: Omit<
      DigitalWorkforceAgentVersion,
      | "id"
      | "agentId"
      | "versionNumber"
      | "lifecycle"
      | "configurationHash"
      | "createdAt"
      | "updatedAt"
      | "version"
      | "publishedAt"
      | "publishedByUserId"
    > & { readonly id?: string };
  }): Promise<{
    readonly agent: DigitalWorkforceAgentIdentity;
    readonly draft: DigitalWorkforceAgentVersion;
  }> {
    return this.database.transaction(async (transaction) => {
      const relationships = await this.loadRelationships(transaction);
      assertHierarchyAssignment({
        agentId: input.id ?? "00000000-0000-4000-8000-000000000000",
        supervisorAgentId: input.version.supervisorAgentId,
        relationships,
      });
      const agentId = input.id ?? randomUUID();
      const versionId = input.version.id ?? randomUUID();
      const configurationHash = hashAgentVersionConfiguration(input.version);
      const agent = await transaction.query<Row>(
        `INSERT INTO digital_workforce_agents
         (id,slug,display_name,role_title,short_description,department_id,team_id,supported_human_user_id,
          current_published_version_id,status,avatar,created_by_user_id,created_at,updated_at,version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,'draft',$9,$10,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1)
         ON CONFLICT (id) DO UPDATE SET slug=EXCLUDED.slug,display_name=EXCLUDED.display_name,
         role_title=EXCLUDED.role_title,short_description=EXCLUDED.short_description,
         department_id=EXCLUDED.department_id,team_id=EXCLUDED.team_id,
         supported_human_user_id=EXCLUDED.supported_human_user_id,avatar=EXCLUDED.avatar,
         updated_at=CURRENT_TIMESTAMP,version=digital_workforce_agents.version+1
         RETURNING *`,
        [
          agentId,
          assertSlug(input.slug),
          assertSafeBoundedText(input.displayName, "agent name", 160),
          assertSafeBoundedText(input.roleTitle, "role title", 160),
          assertSafeBoundedText(input.shortDescription || "Digital Agent", "description", 2000),
          requiredUuid(input.departmentId, "department ID"),
          requiredUuid(input.teamId, "team ID"),
          input.supportedHumanUserId ?? null,
          assertAvatar(input.avatar),
          requiredUuid(input.createdByUserId, "created by"),
        ],
      );
      const nextNumber = await transaction.query<{ n: string | number }>(
        `SELECT COALESCE(MAX(version_number),0)+1 AS n FROM digital_workforce_agent_versions WHERE agent_id=$1`,
        [agentId],
      );
      const draft = await transaction.query<Row>(
        `INSERT INTO digital_workforce_agent_versions
         (id,agent_id,version_number,lifecycle,persona,role_definition,goals,success_criteria,department_id,team_id,
          supervisor_agent_id,preferred_handoff_agent_ids,available_to_role_ids,model_assignment,tool_grants,data_scopes,
          knowledge_scopes,memory_policy,approval_policy,designated_approver_role_id,escalation_instructions,
          runtime_policy,configuration_hash,created_by_user_id,published_by_user_id,published_at,created_at,updated_at,version)
         VALUES ($1,$2,$3,'draft',$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,
          $16::jsonb,$17,$18,$19,$20,$21::jsonb,$22,$23,NULL,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1)
         ON CONFLICT (agent_id, version_number) DO UPDATE SET persona=EXCLUDED.persona
         RETURNING *`,
        [
          versionId,
          agentId,
          numberValue(nextNumber.rows[0]?.n ?? 1),
          assertSafeBoundedText(input.version.persona, "persona", 8000),
          assertSafeBoundedText(input.version.roleDefinition, "role definition", 4000),
          JSON.stringify(input.version.goals),
          JSON.stringify(input.version.successCriteria),
          requiredUuid(input.version.departmentId, "department ID"),
          requiredUuid(input.version.teamId, "team ID"),
          input.version.supervisorAgentId,
          JSON.stringify(input.version.preferredHandoffAgentIds),
          JSON.stringify(input.version.availableToRoleIds),
          JSON.stringify(input.version.modelAssignment),
          JSON.stringify(input.version.toolGrants),
          JSON.stringify(input.version.dataScopes),
          JSON.stringify(input.version.knowledgeScopes),
          input.version.memoryPolicy,
          input.version.approvalPolicy,
          input.version.designatedApproverRoleId,
          input.version.escalationInstructions,
          JSON.stringify(normalizeRuntimePolicy(input.version.runtimePolicy)),
          configurationHash,
          requiredUuid(input.createdByUserId, "created by"),
        ],
      );
      return { agent: mapAgent(agent.rows[0]!), draft: mapVersion(draft.rows[0]!) };
    });
  }

  async publishAgentVersion(input: {
    readonly agentId: string;
    readonly versionId: string;
    readonly publishedByUserId: string;
    readonly expectedVersion?: number;
  }): Promise<DigitalWorkforceAgentVersion> {
    return this.database.transaction(async (transaction) => {
      const current = await transaction.query<Row>(
        `SELECT * FROM digital_workforce_agent_versions WHERE id=$1 AND agent_id=$2 FOR UPDATE`,
        [requiredUuid(input.versionId, "version ID"), requiredUuid(input.agentId, "agent ID")],
      );
      const version = current.rows[0] ? mapVersion(current.rows[0]) : null;
      if (!version) throw new DigitalWorkforceValidationError("Agent version was not found.");
      const nextLifecycle = nextAgentVersionLifecycle(version.lifecycle, "publish");
      await transaction.query(
        `UPDATE digital_workforce_agent_versions SET lifecycle='superseded', updated_at=CURRENT_TIMESTAMP
         WHERE agent_id=$1 AND lifecycle='published' AND id<>$2`,
        [input.agentId, input.versionId],
      );
      const published = await transaction.query<Row>(
        `UPDATE digital_workforce_agent_versions
         SET lifecycle=$3, published_by_user_id=$4, published_at=CURRENT_TIMESTAMP,
         updated_at=CURRENT_TIMESTAMP, version=version+1
         WHERE id=$1 AND agent_id=$2 AND lifecycle='draft'
         RETURNING *`,
        [
          input.versionId,
          input.agentId,
          nextLifecycle,
          requiredUuid(input.publishedByUserId, "publisher"),
        ],
      );
      if (!published.rows[0]) {
        throw new DigitalWorkforceValidationError("Only draft versions can be published.");
      }
      await transaction.query(
        `UPDATE digital_workforce_agents
         SET current_published_version_id=$2, status='active', updated_at=CURRENT_TIMESTAMP, version=version+1
         WHERE id=$1`,
        [input.agentId, input.versionId],
      );
      return mapVersion(published.rows[0]);
    });
  }

  async setAgentStatus(input: {
    readonly agentId: string;
    readonly status: Exclude<DigitalAgentStatus, "draft">;
    readonly actorUserId: string;
  }): Promise<DigitalWorkforceAgentIdentity> {
    const result = await this.database.query<Row>(
      `UPDATE digital_workforce_agents
       SET status=$2, updated_at=CURRENT_TIMESTAMP, version=version+1
       WHERE id=$1 RETURNING *`,
      [requiredUuid(input.agentId, "agent ID"), input.status],
    );
    if (!result.rows[0]) throw new DigitalWorkforceValidationError("Agent was not found.");
    return mapAgent(result.rows[0]);
  }

  async cloneAgent(input: {
    readonly sourceAgentId: string;
    readonly createdByUserId: string;
    readonly displayName: string;
    readonly slug: string;
  }): Promise<{
    readonly agent: DigitalWorkforceAgentIdentity;
    readonly draft: DigitalWorkforceAgentVersion;
  }> {
    const source = await this.getAgent(input.sourceAgentId);
    const version =
      (source?.currentPublishedVersionId
        ? await this.getVersion(source.currentPublishedVersionId)
        : null) ?? (await this.listAgentVersions(input.sourceAgentId)).at(0);
    if (!source || !version) {
      throw new DigitalWorkforceValidationError("The source agent cannot be cloned.");
    }
    return this.createAgentDraft({
      slug: input.slug,
      displayName: input.displayName,
      roleTitle: source.roleTitle,
      shortDescription: source.shortDescription,
      departmentId: source.departmentId,
      teamId: source.teamId,
      supportedHumanUserId: source.supportedHumanUserId,
      avatar: source.avatar,
      createdByUserId: input.createdByUserId,
      version: {
        persona: version.persona,
        roleDefinition: version.roleDefinition,
        goals: version.goals,
        successCriteria: version.successCriteria,
        departmentId: version.departmentId,
        teamId: version.teamId,
        supervisorAgentId: version.supervisorAgentId,
        preferredHandoffAgentIds: version.preferredHandoffAgentIds,
        availableToRoleIds: version.availableToRoleIds,
        modelAssignment: version.modelAssignment,
        toolGrants: version.toolGrants,
        dataScopes: version.dataScopes,
        knowledgeScopes: version.knowledgeScopes,
        memoryPolicy: version.memoryPolicy,
        approvalPolicy: version.approvalPolicy,
        designatedApproverRoleId: version.designatedApproverRoleId,
        escalationInstructions: version.escalationInstructions,
        runtimePolicy: version.runtimePolicy,
        createdByUserId: input.createdByUserId,
      },
    });
  }

  async createRun(input: {
    readonly id?: string;
    readonly initiatingUserId: string;
    readonly conversationId?: string | null;
    readonly initiatingMessageId?: string | null;
    readonly rootAgentId: string;
    readonly rootAgentVersionId: string;
    readonly goal: string;
    readonly normalizedRequest: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
    readonly expiresAt?: string | null;
  }): Promise<DigitalAgentRun> {
    const existing = await this.database.query<Row>(
      `SELECT * FROM digital_workforce_runs WHERE idempotency_key=$1`,
      [input.idempotencyKey],
    );
    if (existing.rows[0]) return mapRun(existing.rows[0]);
    const agent = await this.getAgent(input.rootAgentId);
    if (!agent || agent.status !== "active" || !agent.currentPublishedVersionId) {
      throw new DigitalWorkforceValidationError(
        "New runs cannot assign a paused, archived, or unpublished agent.",
      );
    }
    if (agent.currentPublishedVersionId !== input.rootAgentVersionId) {
      throw new DigitalWorkforceValidationError(
        "Runs must use the currently published agent version.",
      );
    }
    const inserted = await this.database.query<Row>(
      `INSERT INTO digital_workforce_runs
       (id,initiating_user_id,conversation_id,initiating_message_id,root_agent_id,root_agent_version_id,goal,
        normalized_request,execution_plan,status,current_step_key,idempotency_key,source_record_ids,source_artifact_ids,
        source_presentation_ids,output_artifact_ids,estimated_cost_usd,correlation_id,expires_at,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,'draft',NULL,$9,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,0,$10,$11,
        CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [
        input.id ?? randomUUID(),
        requiredUuid(input.initiatingUserId, "initiating user"),
        input.conversationId ?? null,
        input.initiatingMessageId ?? null,
        requiredUuid(input.rootAgentId, "root agent"),
        requiredUuid(input.rootAgentVersionId, "root version"),
        assertSafeBoundedText(input.goal, "goal", 2000),
        assertSafeBoundedText(input.normalizedRequest, "request", 2000),
        input.idempotencyKey,
        input.correlationId,
        input.expiresAt ?? null,
      ],
    );
    if (inserted.rows[0]) return mapRun(inserted.rows[0]);
    const replay = await this.database.query<Row>(
      `SELECT * FROM digital_workforce_runs WHERE idempotency_key=$1`,
      [input.idempotencyKey],
    );
    return mapRun(replay.rows[0]!);
  }

  async getRun(id: string): Promise<DigitalAgentRun | null> {
    const result = await this.database.query<Row>(
      `SELECT * FROM digital_workforce_runs WHERE id=$1`,
      [requiredUuid(id, "run ID")],
    );
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async listRuns(
    options: {
      readonly initiatingUserId?: string;
      readonly status?: DigitalAgentRunStatus;
      readonly limit?: number;
      readonly offset?: number;
    } = {},
  ): Promise<readonly DigitalAgentRun[]> {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (options.initiatingUserId) {
      parameters.push(requiredUuid(options.initiatingUserId, "user ID"));
      clauses.push(`initiating_user_id=$${parameters.length}`);
    }
    if (options.status) {
      parameters.push(options.status);
      clauses.push(`status=$${parameters.length}`);
    }
    parameters.push(clampLimit(options.limit, 25, 100));
    const limitParameter = parameters.length;
    parameters.push(Math.max(0, Math.trunc(options.offset ?? 0)));
    const result = await this.database.query<Row>(
      `SELECT * FROM digital_workforce_runs
       ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY created_at DESC, id DESC
       LIMIT $${limitParameter} OFFSET $${parameters.length}`,
      parameters,
    );
    return result.rows.map(mapRun);
  }

  async transitionRun(input: {
    readonly runId: string;
    readonly to: DigitalAgentRunStatus;
    readonly currentStepKey?: string | null;
    readonly executionPlan?: DigitalWorkforceExecutionPlan | null;
    readonly safeError?: string | null;
    readonly executiveSummary?: string | null;
    readonly estimatedCostUsd?: number;
    readonly providerCallCount?: number;
    readonly webSearchCount?: number;
    readonly pdfGenerationCount?: number;
    readonly outputArtifactIds?: readonly string[];
    readonly claimOwner?: string | null;
  }): Promise<DigitalAgentRun> {
    return this.database.transaction(async (transaction) => {
      const current = await transaction.query<Row>(
        `SELECT * FROM digital_workforce_runs WHERE id=$1 FOR UPDATE`,
        [requiredUuid(input.runId, "run ID")],
      );
      const run = current.rows[0] ? mapRun(current.rows[0]) : null;
      if (!run) throw new DigitalWorkforceValidationError("Run was not found.");
      if (!canTransitionDigitalAgentRun(run.status, input.to)) {
        throw new DigitalWorkforcePolicyError(
          `Invalid digital workforce run transition ${run.status} → ${input.to}.`,
        );
      }
      const startedAt = run.startedAt ?? (input.to === "running" ? new Date().toISOString() : null);
      const completedAt = isTerminalRunStatus(input.to)
        ? new Date().toISOString()
        : run.completedAt;
      const claimedAt =
        input.claimOwner !== undefined
          ? input.claimOwner
            ? new Date().toISOString()
            : null
          : run.claimedAt;
      const updated = await transaction.query<Row>(
        `UPDATE digital_workforce_runs SET
           status=$2, current_step_key=$3, execution_plan=COALESCE($4::jsonb, execution_plan),
           safe_error=$5, executive_summary=COALESCE($6, executive_summary),
           estimated_cost_usd=COALESCE($7, estimated_cost_usd),
           provider_call_count=COALESCE($8, provider_call_count),
           web_search_count=COALESCE($9, web_search_count),
           pdf_generation_count=COALESCE($10, pdf_generation_count),
           output_artifact_ids=COALESCE($11::jsonb, output_artifact_ids),
           started_at=COALESCE($12, started_at), completed_at=$13,
           claimed_at=$14, claim_owner=COALESCE($15, claim_owner),
           updated_at=CURRENT_TIMESTAMP, version=version+1
         WHERE id=$1 RETURNING *`,
        [
          input.runId,
          input.to,
          input.currentStepKey ?? run.currentStepKey,
          input.executionPlan ? JSON.stringify(input.executionPlan) : null,
          input.safeError ?? run.safeError,
          input.executiveSummary ?? null,
          input.estimatedCostUsd ?? null,
          input.providerCallCount ?? null,
          input.webSearchCount ?? null,
          input.pdfGenerationCount ?? null,
          input.outputArtifactIds ? JSON.stringify(input.outputArtifactIds) : null,
          startedAt,
          completedAt,
          claimedAt,
          input.claimOwner ?? null,
        ],
      );
      return mapRun(updated.rows[0]!);
    });
  }

  async claimRun(input: {
    readonly runId: string;
    readonly claimOwner: string;
    readonly staleAfterMs?: number;
  }): Promise<DigitalAgentRun | null> {
    const staleBefore = new Date(Date.now() - (input.staleAfterMs ?? 5 * 60_000)).toISOString();
    const result = await this.database.query<Row>(
      `UPDATE digital_workforce_runs
       SET claimed_at=CURRENT_TIMESTAMP, claim_owner=$2, status='planning',
           updated_at=CURRENT_TIMESTAMP, version=version+1
       WHERE id=$1 AND (
         status IN ('queued','draft','validating')
         OR (status IN ('planning','running') AND (claimed_at IS NULL OR claimed_at < $3::timestamptz))
       )
       RETURNING *`,
      [requiredUuid(input.runId, "run ID"), input.claimOwner, staleBefore],
    );
    return result.rows[0] ? mapRun(result.rows[0]) : this.getRun(input.runId);
  }

  async requestCancellation(input: {
    readonly runId: string;
    readonly cancelledByUserId: string;
    readonly reason: string;
  }): Promise<DigitalAgentRun> {
    const result = await this.database.query<Row>(
      `UPDATE digital_workforce_runs
       SET cancellation_requested=TRUE, cancelled_by_user_id=$2, cancellation_reason=$3,
           updated_at=CURRENT_TIMESTAMP, version=version+1
       WHERE id=$1 RETURNING *`,
      [
        requiredUuid(input.runId, "run ID"),
        requiredUuid(input.cancelledByUserId, "cancelled by"),
        assertSafeBoundedText(input.reason, "cancellation reason", 500),
      ],
    );
    if (!result.rows[0]) throw new DigitalWorkforceValidationError("Run was not found.");
    return mapRun(result.rows[0]);
  }

  async upsertStep(
    input: Omit<DigitalAgentRunStep, "createdAt" | "updatedAt" | "version"> & {
      readonly id?: string;
    },
  ): Promise<DigitalAgentRunStep> {
    const existing = await this.database.query<Row>(
      `SELECT * FROM digital_workforce_run_steps WHERE idempotency_key=$1`,
      [input.idempotencyKey],
    );
    if (existing.rows[0] && String(existing.rows[0].status) !== "queued") {
      return mapStep(existing.rows[0]);
    }
    const result = await this.database.query<Row>(
      `INSERT INTO digital_workforce_run_steps
       (id,run_id,step_key,step_type,agent_id,agent_version_id,status,idempotency_key,sequence,parallel_group,
        assigned_why,provider,model,fallback_model_used,tool_names,authorized_record_ids,citation_ids,artifact_ids,
        usage_json,result_json,safe_error,retry_count,started_at,finished_at,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb,
        $19::jsonb,$20::jsonb,$21,$22,$23,$24,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1)
       ON CONFLICT (run_id, step_key) DO UPDATE SET
         status=EXCLUDED.status, provider=EXCLUDED.provider, model=EXCLUDED.model,
         fallback_model_used=EXCLUDED.fallback_model_used, tool_names=EXCLUDED.tool_names,
         authorized_record_ids=EXCLUDED.authorized_record_ids, citation_ids=EXCLUDED.citation_ids,
         artifact_ids=EXCLUDED.artifact_ids, usage_json=EXCLUDED.usage_json, result_json=EXCLUDED.result_json,
         safe_error=EXCLUDED.safe_error, retry_count=EXCLUDED.retry_count, started_at=EXCLUDED.started_at,
         finished_at=EXCLUDED.finished_at, updated_at=CURRENT_TIMESTAMP, version=digital_workforce_run_steps.version+1
       RETURNING *`,
      [
        input.id ?? randomUUID(),
        input.runId,
        input.stepKey,
        input.stepType,
        input.agentId,
        input.agentVersionId,
        input.status,
        input.idempotencyKey,
        input.sequence,
        input.parallelGroup,
        input.assignedWhy,
        input.provider,
        input.model,
        input.fallbackModelUsed,
        JSON.stringify(input.toolNames),
        JSON.stringify(input.authorizedRecordIds),
        JSON.stringify(input.citationIds),
        JSON.stringify(input.artifactIds),
        JSON.stringify(input.usageJson),
        JSON.stringify(input.resultJson),
        input.safeError,
        input.retryCount,
        input.startedAt,
        input.finishedAt,
      ],
    );
    return mapStep(result.rows[0]!);
  }

  async listSteps(runId: string): Promise<readonly DigitalAgentRunStep[]> {
    const result = await this.database.query<Row>(
      `SELECT * FROM digital_workforce_run_steps WHERE run_id=$1 ORDER BY sequence, id`,
      [requiredUuid(runId, "run ID")],
    );
    return result.rows.map(mapStep);
  }

  async createHandoff(input: {
    readonly id?: string;
    readonly runId: string;
    readonly parentStepId?: string | null;
    readonly fromAgentId: string;
    readonly fromAgentVersionId: string;
    readonly toAgentId: string;
    readonly toAgentVersionId: string;
    readonly depth: number;
    readonly packet: DigitalWorkforceHandoffPacket;
    readonly approvalRequired?: boolean;
    readonly expiresAt?: string | null;
  }): Promise<DigitalWorkforceHandoff> {
    const packet: DigitalWorkforceHandoffPacket = {
      ...input.packet,
      boundedContextSummary: boundedHandoffContext(input.packet.boundedContextSummary),
    };
    const result = await this.database.query<Row>(
      `INSERT INTO digital_workforce_handoffs
       (id,run_id,parent_step_id,from_agent_id,from_agent_version_id,to_agent_id,to_agent_version_id,depth,status,
        packet,returned_result,safe_failure,approval_required,expires_at,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'proposed',$9::jsonb,NULL,NULL,$10,$11,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1)
       RETURNING *`,
      [
        input.id ?? randomUUID(),
        requiredUuid(input.runId, "run ID"),
        input.parentStepId ?? null,
        input.fromAgentId,
        input.fromAgentVersionId,
        input.toAgentId,
        input.toAgentVersionId,
        input.depth,
        JSON.stringify(packet),
        Boolean(input.approvalRequired),
        input.expiresAt ?? null,
      ],
    );
    return mapHandoff(result.rows[0]!);
  }

  async transitionHandoff(input: {
    readonly handoffId: string;
    readonly to: DigitalHandoffStatus;
    readonly returnedResult?: Record<string, unknown> | null;
    readonly safeFailure?: string | null;
  }): Promise<DigitalWorkforceHandoff> {
    const current = await this.database.query<Row>(
      `SELECT * FROM digital_workforce_handoffs WHERE id=$1`,
      [requiredUuid(input.handoffId, "handoff ID")],
    );
    const handoff = current.rows[0] ? mapHandoff(current.rows[0]) : null;
    if (!handoff) throw new DigitalWorkforceValidationError("Handoff was not found.");
    if (!canTransitionDigitalHandoff(handoff.status, input.to)) {
      throw new DigitalWorkforcePolicyError(
        `Invalid handoff transition ${handoff.status} → ${input.to}.`,
      );
    }
    const updated = await this.database.query<Row>(
      `UPDATE digital_workforce_handoffs
       SET status=$2, returned_result=COALESCE($3::jsonb, returned_result), safe_failure=$4,
           updated_at=CURRENT_TIMESTAMP, version=version+1
       WHERE id=$1 RETURNING *`,
      [
        input.handoffId,
        input.to,
        input.returnedResult ? JSON.stringify(input.returnedResult) : null,
        input.safeFailure ?? handoff.safeFailure,
      ],
    );
    return mapHandoff(updated.rows[0]!);
  }

  async listHandoffs(runId: string): Promise<readonly DigitalWorkforceHandoff[]> {
    const result = await this.database.query<Row>(
      `SELECT * FROM digital_workforce_handoffs WHERE run_id=$1 ORDER BY created_at, id`,
      [requiredUuid(runId, "run ID")],
    );
    return result.rows.map(mapHandoff);
  }

  async getHandoff(id: string): Promise<DigitalWorkforceHandoff | null> {
    const result = await this.database.query<Row>(
      `SELECT * FROM digital_workforce_handoffs WHERE id=$1`,
      [requiredUuid(id, "handoff ID")],
    );
    return result.rows[0] ? mapHandoff(result.rows[0]) : null;
  }

  async appendEvent(input: {
    readonly id?: string;
    readonly runId: string;
    readonly eventType: string;
    readonly agentId?: string | null;
    readonly stepId?: string | null;
    readonly handoffId?: string | null;
    readonly narration?: string | null;
    readonly metadata?: Record<string, unknown>;
  }): Promise<DigitalWorkforceRunEvent> {
    const sequence = await this.database.query<{ n: string | number }>(
      `SELECT COALESCE(MAX(sequence),0)+1 AS n FROM digital_workforce_run_events WHERE run_id=$1`,
      [requiredUuid(input.runId, "run ID")],
    );
    const result = await this.database.query<Row>(
      `INSERT INTO digital_workforce_run_events
       (id,run_id,sequence,event_type,agent_id,step_id,handoff_id,narration,metadata,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,CURRENT_TIMESTAMP)
       RETURNING *`,
      [
        input.id ?? randomUUID(),
        input.runId,
        numberValue(sequence.rows[0]?.n ?? 1),
        input.eventType,
        input.agentId ?? null,
        input.stepId ?? null,
        input.handoffId ?? null,
        input.narration ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    const row = result.rows[0]!;
    return {
      id: String(row.id),
      runId: String(row.run_id),
      sequence: numberValue(row.sequence),
      eventType: String(row.event_type),
      agentId: nullableString(row.agent_id),
      stepId: nullableString(row.step_id),
      handoffId: nullableString(row.handoff_id),
      narration: nullableString(row.narration),
      metadata: json(row.metadata, {}),
      createdAt: iso(row.created_at),
    };
  }

  async listEvents(runId: string, limit = 200): Promise<readonly DigitalWorkforceRunEvent[]> {
    const result = await this.database.query<Row>(
      `SELECT * FROM digital_workforce_run_events WHERE run_id=$1 ORDER BY sequence LIMIT $2`,
      [requiredUuid(runId, "run ID"), clampLimit(limit, 100, 500)],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      runId: String(row.run_id),
      sequence: numberValue(row.sequence),
      eventType: String(row.event_type),
      agentId: nullableString(row.agent_id),
      stepId: nullableString(row.step_id),
      handoffId: nullableString(row.handoff_id),
      narration: nullableString(row.narration),
      metadata: json(row.metadata, {}),
      createdAt: iso(row.created_at),
    }));
  }

  async createNotification(input: {
    readonly id?: string;
    readonly userId: string;
    readonly type: string;
    readonly title: string;
    readonly body: string;
    readonly sourceType?: string | null;
    readonly sourceId?: string | null;
    readonly href?: string | null;
  }): Promise<void> {
    await this.database.query(
      `INSERT INTO notifications
       (id,user_id,type,title,body,source_type,source_id,source_href,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1)
       ON CONFLICT (id) DO NOTHING`,
      [
        input.id ?? randomUUID(),
        requiredUuid(input.userId, "user ID"),
        input.type,
        assertSafeBoundedText(input.title, "notification title", 160),
        assertSafeBoundedText(input.body, "notification body", 2000),
        input.sourceType ?? null,
        input.sourceId ?? null,
        input.href ?? null,
      ],
    );
  }

  async countHistoricalScale(): Promise<{
    readonly agents: number;
    readonly departments: number;
    readonly teams: number;
    readonly runs: number;
    readonly events: number;
  }> {
    const result = await this.database.query<{
      agents: string | number;
      departments: string | number;
      teams: string | number;
      runs: string | number;
      events: string | number;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM digital_workforce_agents) AS agents,
         (SELECT COUNT(*) FROM digital_workforce_departments) AS departments,
         (SELECT COUNT(*) FROM digital_workforce_teams) AS teams,
         (SELECT COUNT(*) FROM digital_workforce_runs) AS runs,
         (SELECT COUNT(*) FROM digital_workforce_run_events) AS events`,
    );
    const row = result.rows[0];
    return {
      agents: numberValue(row?.agents),
      departments: numberValue(row?.departments),
      teams: numberValue(row?.teams),
      runs: numberValue(row?.runs),
      events: numberValue(row?.events),
    };
  }

  private async loadRelationships(executor: SqlExecutor): Promise<Record<string, string | null>> {
    const result = await executor.query<Row>(
      `SELECT agent_id, supervisor_agent_id FROM digital_workforce_agent_versions
       WHERE lifecycle IN ('published','draft')`,
    );
    const relationships: Record<string, string | null> = {};
    for (const row of result.rows) {
      relationships[String(row.agent_id)] = nullableString(row.supervisor_agent_id);
    }
    return relationships;
  }
}
