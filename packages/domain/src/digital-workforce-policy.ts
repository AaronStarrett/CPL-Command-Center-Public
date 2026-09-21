import type { RoleId } from "./personas.js";
import {
  DEFAULT_DIGITAL_WORKFORCE_RUNTIME_POLICY,
  DIGITAL_AGENT_AVATARS,
  DIGITAL_AGENT_RUN_STATUSES,
  DIGITAL_AGENT_STEP_TYPES,
  DIGITAL_AGENT_VERSION_LIFECYCLES,
  DIGITAL_HANDOFF_STATUSES,
  DIGITAL_WORKFORCE_APPROVAL_POLICIES,
  DIGITAL_WORKFORCE_CONTRACT_VERSION,
  DIGITAL_WORKFORCE_DATA_SCOPES,
  DIGITAL_WORKFORCE_HIERARCHY_MAX_DEPTH,
  DIGITAL_WORKFORCE_KNOWLEDGE_CONNECTION_STATES,
  DIGITAL_WORKFORCE_KNOWLEDGE_SCOPES,
  DIGITAL_WORKFORCE_MEMORY_POLICIES,
  DIGITAL_WORKFORCE_MODEL_PROFILE_ROUTES,
  DIGITAL_WORKFORCE_MODEL_PROFILES,
  DIGITAL_WORKFORCE_REGISTERED_TOOLS,
  DIGITAL_WORKFORCE_TOOL_EFFECTS,
  type DigitalAgentAvatar,
  type DigitalAgentRunStatus,
  type DigitalAgentStepType,
  type DigitalAgentVersionLifecycle,
  type DigitalHandoffStatus,
  type DigitalWorkforceAgentVersion,
  type DigitalWorkforceApprovalPolicy,
  type DigitalWorkforceDataScope,
  type DigitalWorkforceDataScopeGrant,
  type DigitalWorkforceExecutionPlan,
  type DigitalWorkforceKnowledgeScope,
  type DigitalWorkforceKnowledgeScopeGrant,
  type DigitalWorkforceMemoryPolicy,
  type DigitalWorkforceModelAssignment,
  type DigitalWorkforceModelProfile,
  type DigitalWorkforceRegisteredTool,
  type DigitalWorkforceRuntimeLimits,
  type DigitalWorkforceToolEffect,
  type DigitalWorkforceToolGrant,
} from "./digital-workforce.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MARKUP_PATTERN = /<\/?[a-z][\s\S]*>/iu;
const CREDENTIAL_PATTERNS = [
  /\b(?:password|secret|token|authorization|cookie|credential|api[-_ ]?key)\b\s*[:=]\s*\S{4,}/iu,
  /\bbearer\s+[a-z\d._~+/-]{8,}=*/iu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu,
  /\bsk-[a-z\d_-]{12,}\b/iu,
  /\b(?:sk|pk)_(?:live|test)_[a-z\d]{12,}\b/iu,
];
const INJECTION_PATTERNS = [
  /ignore (?:all|previous|prior) (?:instructions|policy)/iu,
  /you are now (?:unrestricted|jailbroken|the system)/iu,
  /override (?:tool grants|permissions|model routing|handoff policy)/iu,
  /expand (?:your|my) (?:permissions|authority|budget)/iu,
  /select (?:an )?unapproved model/iu,
];

export class DigitalWorkforcePolicyError extends Error {
  readonly code = "DIGITAL_WORKFORCE_POLICY";

  constructor(
    readonly reason: string,
    message = reason,
  ) {
    super(message);
    this.name = "DigitalWorkforcePolicyError";
  }
}

export const DIGITAL_AGENT_RUN_TRANSITIONS: Readonly<
  Record<DigitalAgentRunStatus, readonly DigitalAgentRunStatus[]>
> = Object.freeze({
  draft: ["validating", "cancelled"],
  validating: ["queued", "failed", "cancelled"],
  queued: ["planning", "cancelled", "expired"],
  planning: ["running", "failed", "cancelled", "budget_exceeded"],
  running: [
    "waiting_for_handoff",
    "waiting_for_approval",
    "synthesizing",
    "completed",
    "partially_completed",
    "failed",
    "cancelled",
    "expired",
    "budget_exceeded",
  ],
  waiting_for_handoff: ["running", "failed", "cancelled", "expired", "budget_exceeded"],
  waiting_for_approval: ["running", "cancelled", "failed", "expired"],
  synthesizing: ["completed", "partially_completed", "failed", "cancelled", "budget_exceeded"],
  completed: [],
  partially_completed: [],
  failed: [],
  cancelled: [],
  expired: [],
  budget_exceeded: [],
});

export const DIGITAL_HANDOFF_TRANSITIONS: Readonly<
  Record<DigitalHandoffStatus, readonly DigitalHandoffStatus[]>
> = Object.freeze({
  proposed: ["validated", "rejected", "cancelled", "expired"],
  validated: ["accepted", "rejected", "cancelled", "expired"],
  accepted: ["running", "cancelled", "failed", "expired"],
  running: ["returned", "failed", "cancelled", "expired"],
  returned: ["reviewed", "failed", "cancelled"],
  reviewed: ["completed", "rejected"],
  completed: [],
  rejected: [],
  failed: [],
  cancelled: [],
  expired: [],
});

export function isDigitalWorkforceRegisteredTool(
  value: string,
): value is DigitalWorkforceRegisteredTool {
  return (DIGITAL_WORKFORCE_REGISTERED_TOOLS as readonly string[]).includes(value);
}

export function assertCanonicalUuid(value: string, name: string): string {
  const normalized = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new DigitalWorkforcePolicyError(`${name} must be a canonical UUID.`);
  }
  return normalized;
}

export function assertSafeBoundedText(value: string, name: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new DigitalWorkforcePolicyError(
      `${name} must contain between 1 and ${maximum} characters.`,
    );
  }
  if (MARKUP_PATTERN.test(normalized)) {
    throw new DigitalWorkforcePolicyError(`${name} cannot contain HTML or script markup.`);
  }
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    throw new DigitalWorkforcePolicyError(`${name} cannot contain credential-like content.`);
  }
  return normalized;
}

export function containsPromptInjection(value: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(value));
}

export function assertUntrustedEvidence(value: string, name: string, maximum = 4_000): string {
  const normalized = assertSafeBoundedText(value, name, maximum);
  if (containsPromptInjection(normalized)) {
    throw new DigitalWorkforcePolicyError(
      `${name} is untrusted evidence and cannot contain instruction-override language.`,
    );
  }
  return normalized;
}

export function assertSlug(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SLUG_PATTERN.test(normalized) || normalized.length > 80) {
    throw new DigitalWorkforcePolicyError(
      "Slug must be lowercase hyphenated text up to 80 characters.",
    );
  }
  return normalized;
}

export function assertAvatar(value: string): DigitalAgentAvatar {
  if (!(DIGITAL_AGENT_AVATARS as readonly string[]).includes(value)) {
    throw new DigitalWorkforcePolicyError("Avatar must be a controlled Digital Agent icon.");
  }
  return value as DigitalAgentAvatar;
}

export function canTransitionDigitalAgentRun(
  from: DigitalAgentRunStatus,
  to: DigitalAgentRunStatus,
): boolean {
  return DIGITAL_AGENT_RUN_TRANSITIONS[from].includes(to);
}

export function transitionDigitalAgentRun(
  from: DigitalAgentRunStatus,
  to: DigitalAgentRunStatus,
): DigitalAgentRunStatus {
  if (!canTransitionDigitalAgentRun(from, to)) {
    throw new DigitalWorkforcePolicyError(
      `Invalid digital workforce run transition ${from} → ${to}.`,
    );
  }
  return to;
}

export function canTransitionDigitalHandoff(
  from: DigitalHandoffStatus,
  to: DigitalHandoffStatus,
): boolean {
  return DIGITAL_HANDOFF_TRANSITIONS[from].includes(to);
}

export function transitionDigitalHandoff(
  from: DigitalHandoffStatus,
  to: DigitalHandoffStatus,
): DigitalHandoffStatus {
  if (!canTransitionDigitalHandoff(from, to)) {
    throw new DigitalWorkforcePolicyError(`Invalid handoff transition ${from} → ${to}.`);
  }
  return to;
}

export function assertSelfSupervisionDenied(
  agentId: string,
  supervisorAgentId: string | null,
): void {
  if (supervisorAgentId && supervisorAgentId === agentId) {
    throw new DigitalWorkforcePolicyError("An agent cannot supervise itself.");
  }
}

export function detectHierarchyCycle(
  relationships: Readonly<Record<string, string | null>>,
  agentId: string,
  proposedSupervisorId: string | null,
): boolean {
  if (!proposedSupervisorId) return false;
  if (proposedSupervisorId === agentId) return true;
  const visited = new Set<string>([agentId]);
  let current: string | null = proposedSupervisorId;
  while (current) {
    if (visited.has(current)) return true;
    visited.add(current);
    current = relationships[current] ?? null;
  }
  return false;
}

export function hierarchyDepth(
  relationships: Readonly<Record<string, string | null>>,
  agentId: string,
): number {
  const visited = new Set<string>();
  let depth = 1;
  let current: string | null = relationships[agentId] ?? null;
  while (current) {
    if (visited.has(current)) {
      throw new DigitalWorkforcePolicyError("Hierarchy cycles are forbidden.");
    }
    visited.add(current);
    depth += 1;
    if (depth > DIGITAL_WORKFORCE_HIERARCHY_MAX_DEPTH) {
      throw new DigitalWorkforcePolicyError("Hierarchy depth exceeds the Phase 2.3 bound.");
    }
    current = relationships[current] ?? null;
  }
  return depth;
}

export function assertHierarchyAssignment(input: {
  readonly agentId: string;
  readonly supervisorAgentId: string | null;
  readonly relationships: Readonly<Record<string, string | null>>;
  readonly archivedAgentIds?: ReadonlySet<string>;
}): void {
  assertSelfSupervisionDenied(input.agentId, input.supervisorAgentId);
  if (input.supervisorAgentId && input.archivedAgentIds?.has(input.supervisorAgentId)) {
    throw new DigitalWorkforcePolicyError("Archived agents cannot become new supervisors.");
  }
  if (detectHierarchyCycle(input.relationships, input.agentId, input.supervisorAgentId)) {
    throw new DigitalWorkforcePolicyError("Supervisor hierarchy cycles are forbidden.");
  }
  const nextRelationships = {
    ...input.relationships,
    [input.agentId]: input.supervisorAgentId,
  };
  hierarchyDepth(nextRelationships, input.agentId);
}

export function normalizeRuntimePolicy(
  value: Partial<DigitalWorkforceRuntimeLimits> | null | undefined,
): DigitalWorkforceRuntimeLimits {
  const merged = { ...DEFAULT_DIGITAL_WORKFORCE_RUNTIME_POLICY, ...value };
  const bounded = {
    maximumDurationMs: clamp(merged.maximumDurationMs, 30_000, 30 * 60_000),
    maximumSteps: clamp(merged.maximumSteps, 1, 50),
    maximumHandoffs: clamp(merged.maximumHandoffs, 0, 20),
    maximumHandoffDepth: clamp(
      merged.maximumHandoffDepth,
      1,
      DIGITAL_WORKFORCE_HIERARCHY_MAX_DEPTH,
    ),
    maximumParallelAgents: clamp(merged.maximumParallelAgents, 1, 5),
    maximumRetriesPerStep: clamp(merged.maximumRetriesPerStep, 0, 2),
    maximumProviderCalls: clamp(merged.maximumProviderCalls, 0, 20),
    maximumWebSearches: clamp(merged.maximumWebSearches, 0, 5),
    maximumPdfGenerations: clamp(merged.maximumPdfGenerations, 0, 5),
    maximumInputTokens: clamp(merged.maximumInputTokens, 256, 64_000),
    maximumOutputTokens: clamp(merged.maximumOutputTokens, 128, 16_000),
    maximumEstimatedCostUsd: clamp(merged.maximumEstimatedCostUsd, 0.01, 25),
    maximumArtifactBytes: clamp(merged.maximumArtifactBytes, 16_384, 16 * 1024 * 1024),
    pauseBehavior: DEFAULT_DIGITAL_WORKFORCE_RUNTIME_POLICY.pauseBehavior,
    emergencyStopCancelsImmediately: Boolean(merged.emergencyStopCancelsImmediately),
  } satisfies DigitalWorkforceRuntimeLimits;
  return bounded;
}

export function validateToolGrant(grant: DigitalWorkforceToolGrant): DigitalWorkforceToolGrant {
  if (!isDigitalWorkforceRegisteredTool(grant.toolName)) {
    throw new DigitalWorkforcePolicyError("Unknown tools fail closed.");
  }
  if (!(DIGITAL_WORKFORCE_TOOL_EFFECTS as readonly string[]).includes(grant.allowedEffect)) {
    throw new DigitalWorkforcePolicyError("Tool effect is not permitted.");
  }
  return {
    ...grant,
    maximumCallsPerRun: clamp(grant.maximumCallsPerRun, 0, 20),
    toolPolicyVersion: DIGITAL_WORKFORCE_CONTRACT_VERSION,
  };
}

export function validateDataScopes(
  scopes: readonly DigitalWorkforceDataScopeGrant[],
): readonly DigitalWorkforceDataScopeGrant[] {
  return scopes.map((scope) => {
    if (!(DIGITAL_WORKFORCE_DATA_SCOPES as readonly string[]).includes(scope.scope)) {
      throw new DigitalWorkforcePolicyError("Unknown data scopes fail closed.");
    }
    return {
      ...scope,
      recordIds: scope.recordIds.map((id) => assertCanonicalUuid(id, "record ID")),
    };
  });
}

export function validateKnowledgeScopes(
  scopes: readonly DigitalWorkforceKnowledgeScopeGrant[],
): readonly DigitalWorkforceKnowledgeScopeGrant[] {
  return scopes.map((scope) => {
    if (!(DIGITAL_WORKFORCE_KNOWLEDGE_SCOPES as readonly string[]).includes(scope.scope)) {
      throw new DigitalWorkforcePolicyError("Unknown knowledge scopes fail closed.");
    }
    if (
      !(DIGITAL_WORKFORCE_KNOWLEDGE_CONNECTION_STATES as readonly string[]).includes(
        scope.connectionState,
      )
    ) {
      throw new DigitalWorkforcePolicyError("Knowledge connection state is invalid.");
    }
    if (
      (scope.scope === "organizational-file-search" || scope.scope === "knowledge-collection") &&
      scope.connectionState === "connected"
    ) {
      throw new DigitalWorkforcePolicyError(
        "Organizational File Search and long-term RAG remain NOT CONNECTED in Phase 2.3.",
      );
    }
    return {
      ...scope,
      disclosure: assertSafeBoundedText(scope.disclosure, "knowledge disclosure", 240),
    };
  });
}

export function validateModelAssignment(
  assignment: DigitalWorkforceModelAssignment,
  availableModelIds: ReadonlySet<string>,
): DigitalWorkforceModelAssignment {
  if (!(DIGITAL_WORKFORCE_MODEL_PROFILES as readonly string[]).includes(assignment.profile)) {
    throw new DigitalWorkforcePolicyError("Model profile is not recognized.");
  }
  if (assignment.provider !== "openai") {
    throw new DigitalWorkforcePolicyError(
      "Only the application-owned OpenAI provider is permitted.",
    );
  }
  if (DIGITAL_WORKFORCE_MODEL_PROFILE_ROUTES[assignment.profile] !== assignment.routeKey) {
    throw new DigitalWorkforcePolicyError(
      "Model profile does not match the assigned workload route.",
    );
  }
  if (!availableModelIds.has(assignment.primaryModel)) {
    throw new DigitalWorkforcePolicyError("Primary model is not a verified project model.");
  }
  if (assignment.fallbackModel && !availableModelIds.has(assignment.fallbackModel)) {
    throw new DigitalWorkforcePolicyError("Fallback model is not a verified project model.");
  }
  return assignment;
}

export function hashAgentVersionConfiguration(input: {
  readonly persona: string;
  readonly roleDefinition: string;
  readonly goals: readonly string[];
  readonly successCriteria: readonly string[];
  readonly supervisorAgentId: string | null;
  readonly preferredHandoffAgentIds: readonly string[];
  readonly availableToRoleIds: readonly RoleId[];
  readonly modelAssignment: DigitalWorkforceModelAssignment;
  readonly toolGrants: readonly DigitalWorkforceToolGrant[];
  readonly dataScopes: readonly DigitalWorkforceDataScopeGrant[];
  readonly knowledgeScopes: readonly DigitalWorkforceKnowledgeScopeGrant[];
  readonly memoryPolicy: DigitalWorkforceMemoryPolicy;
  readonly approvalPolicy: DigitalWorkforceApprovalPolicy;
  readonly runtimePolicy: DigitalWorkforceRuntimeLimits;
}): string {
  return sha256Hex(
    JSON.stringify({
      contract: DIGITAL_WORKFORCE_CONTRACT_VERSION,
      ...input,
    }),
  );
}

export function assertPublishedVersionImmutable(
  current: Pick<DigitalWorkforceAgentVersion, "lifecycle" | "configurationHash">,
  nextHash: string,
): void {
  if (current.lifecycle !== "draft" && current.configurationHash !== nextHash) {
    throw new DigitalWorkforcePolicyError("Published agent versions are immutable.");
  }
}

export function nextAgentVersionLifecycle(
  current: DigitalAgentVersionLifecycle,
  action: "publish" | "supersede" | "retire",
): DigitalAgentVersionLifecycle {
  if (action === "publish" && current === "draft") return "published";
  if (action === "supersede" && current === "published") return "superseded";
  if (action === "retire" && (current === "published" || current === "superseded"))
    return "retired";
  throw new DigitalWorkforcePolicyError(`Invalid agent version lifecycle action ${action}.`);
}

export function assertToolGranted(
  grants: readonly DigitalWorkforceToolGrant[],
  toolName: string,
  requiredEffect: DigitalWorkforceToolEffect,
): DigitalWorkforceToolGrant {
  if (!isDigitalWorkforceRegisteredTool(toolName)) {
    throw new DigitalWorkforcePolicyError("Unknown tools fail closed.");
  }
  const grant = grants.find((item) => item.toolName === toolName && item.enabled);
  if (!grant) {
    throw new DigitalWorkforcePolicyError("The agent is not granted that tool.");
  }
  const rank: Record<DigitalWorkforceToolEffect, number> = {
    read: 0,
    prepare: 1,
    preview: 2,
    "execute-with-approval": 3,
  };
  if (rank[requiredEffect] > rank[grant.allowedEffect]) {
    throw new DigitalWorkforcePolicyError("The requested tool effect exceeds the grant.");
  }
  return grant;
}

export function assertDataScopePermits(
  scopes: readonly DigitalWorkforceDataScopeGrant[],
  needed: DigitalWorkforceDataScope,
): void {
  const enabled = scopes.filter((scope) => scope.enabled).map((scope) => scope.scope);
  if (enabled.includes("all-authorized-records")) return;
  if (!enabled.includes(needed)) {
    throw new DigitalWorkforcePolicyError(
      "The agent data scope does not permit that record class.",
    );
  }
}

export function assertKnowledgeScopeConnected(
  scopes: readonly DigitalWorkforceKnowledgeScopeGrant[],
  needed: DigitalWorkforceKnowledgeScope,
): DigitalWorkforceKnowledgeScopeGrant {
  const grant = scopes.find((scope) => scope.scope === needed);
  if (!grant || grant.connectionState !== "connected") {
    throw new DigitalWorkforcePolicyError(
      needed === "public-web"
        ? "Public Web is not connected for this agent."
        : "That knowledge source is NOT CONNECTED.",
    );
  }
  return grant;
}

export function validateExecutionPlan(input: {
  readonly plan: DigitalWorkforceExecutionPlan;
  readonly activePublishedAgents: ReadonlyMap<
    string,
    { readonly versionId: string; readonly supervisorAgentId: string | null }
  >;
  readonly runtimePolicy: DigitalWorkforceRuntimeLimits;
}): DigitalWorkforceExecutionPlan {
  if (input.plan.planVersion !== DIGITAL_WORKFORCE_CONTRACT_VERSION) {
    throw new DigitalWorkforcePolicyError("Execution plan contract version is not accepted.");
  }
  if (input.plan.steps.length === 0 || input.plan.steps.length > input.runtimePolicy.maximumSteps) {
    throw new DigitalWorkforcePolicyError("Execution plan exceeds the configured step limit.");
  }
  const keys = new Set<string>();
  const agentIds = new Set<string>();
  for (const step of input.plan.steps) {
    if (keys.has(step.key))
      throw new DigitalWorkforcePolicyError("Execution plan step keys must be unique.");
    keys.add(step.key);
    if (!(DIGITAL_AGENT_STEP_TYPES as readonly string[]).includes(step.stepType)) {
      throw new DigitalWorkforcePolicyError("Arbitrary model-created step types are not allowed.");
    }
    const published = input.activePublishedAgents.get(step.agentId);
    if (!published || published.versionId !== step.agentVersionId) {
      throw new DigitalWorkforcePolicyError(
        "Every plan agent must exist, be active, and use a published version.",
      );
    }
    agentIds.add(step.agentId);
    for (const dependency of step.dependsOn) {
      if (!keys.has(dependency) && !input.plan.steps.some((item) => item.key === dependency)) {
        throw new DigitalWorkforcePolicyError(
          "Execution plan dependencies must reference plan steps.",
        );
      }
    }
  }
  if (!input.activePublishedAgents.has(input.plan.rootAgentId)) {
    throw new DigitalWorkforcePolicyError("The root agent must be active and published.");
  }
  if (agentIds.size > input.runtimePolicy.maximumParallelAgents + input.plan.steps.length) {
    throw new DigitalWorkforcePolicyError("Execution plan exceeds agent assignment bounds.");
  }
  const parallelGroups = new Map<string, number>();
  for (const step of input.plan.steps) {
    if (!step.parallelGroup) continue;
    parallelGroups.set(step.parallelGroup, (parallelGroups.get(step.parallelGroup) ?? 0) + 1);
  }
  for (const count of parallelGroups.values()) {
    if (count > input.runtimePolicy.maximumParallelAgents) {
      throw new DigitalWorkforcePolicyError("Parallelism exceeds the configured maximum.");
    }
  }
  return input.plan;
}

export function assertHandoffAllowed(input: {
  readonly fromAgentId: string;
  readonly toAgentId: string;
  readonly depth: number;
  readonly existingHandoffCount: number;
  readonly runtimePolicy: DigitalWorkforceRuntimeLimits;
  readonly preferredHandoffAgentIds: readonly string[];
  readonly priorPairs: readonly { readonly fromAgentId: string; readonly toAgentId: string }[];
}): void {
  if (input.fromAgentId === input.toAgentId) {
    throw new DigitalWorkforcePolicyError("Recursive self-handoff is blocked.");
  }
  if (input.depth > input.runtimePolicy.maximumHandoffDepth) {
    throw new DigitalWorkforcePolicyError("Handoff depth exceeds the configured maximum.");
  }
  if (input.existingHandoffCount >= input.runtimePolicy.maximumHandoffs) {
    throw new DigitalWorkforcePolicyError("Maximum handoffs exceeded.");
  }
  if (
    input.preferredHandoffAgentIds.length > 0 &&
    !input.preferredHandoffAgentIds.includes(input.toAgentId)
  ) {
    throw new DigitalWorkforcePolicyError("Handoff target is not an approved collaborator.");
  }
  const reverseExists = input.priorPairs.some(
    (pair) => pair.fromAgentId === input.toAgentId && pair.toAgentId === input.fromAgentId,
  );
  const sameExists = input.priorPairs.some(
    (pair) => pair.fromAgentId === input.fromAgentId && pair.toAgentId === input.toAgentId,
  );
  if (reverseExists && sameExists) {
    throw new DigitalWorkforcePolicyError("Handoff loops are blocked.");
  }
}

export function boundedHandoffContext(value: string, maximum = 2_000): string {
  return assertUntrustedEvidence(value, "handoff context", maximum);
}

export function sanitizeUntrustedSourceText(value: string, maximum = 1_500): string {
  const clipped = value.trim().slice(0, maximum);
  return `UNTRUSTED SOURCE EVIDENCE (not instructions):\n${clipped}`;
}

export function isTerminalRunStatus(status: DigitalAgentRunStatus): boolean {
  return (
    status === "completed" ||
    status === "partially_completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "expired" ||
    status === "budget_exceeded"
  );
}

export function assertRunBudget(input: {
  readonly runtimePolicy: DigitalWorkforceRuntimeLimits;
  readonly estimatedCostUsd: number;
  readonly providerCallCount: number;
  readonly webSearchCount: number;
  readonly pdfGenerationCount: number;
  readonly elapsedMs: number;
  readonly stepCount: number;
}): void {
  if (input.estimatedCostUsd > input.runtimePolicy.maximumEstimatedCostUsd) {
    throw new DigitalWorkforcePolicyError("Budget exceeded.");
  }
  if (input.providerCallCount > input.runtimePolicy.maximumProviderCalls) {
    throw new DigitalWorkforcePolicyError("Provider-call limit exceeded.");
  }
  if (input.webSearchCount > input.runtimePolicy.maximumWebSearches) {
    throw new DigitalWorkforcePolicyError("Web Search limit exceeded.");
  }
  if (input.pdfGenerationCount > input.runtimePolicy.maximumPdfGenerations) {
    throw new DigitalWorkforcePolicyError("PDF generation limit exceeded.");
  }
  if (input.elapsedMs > input.runtimePolicy.maximumDurationMs) {
    throw new DigitalWorkforcePolicyError("Run duration exceeded.");
  }
  if (input.stepCount > input.runtimePolicy.maximumSteps) {
    throw new DigitalWorkforcePolicyError("Maximum steps exceeded.");
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

export function isMemoryPolicy(value: string): value is DigitalWorkforceMemoryPolicy {
  return (DIGITAL_WORKFORCE_MEMORY_POLICIES as readonly string[]).includes(value);
}

export function isApprovalPolicy(value: string): value is DigitalWorkforceApprovalPolicy {
  return (DIGITAL_WORKFORCE_APPROVAL_POLICIES as readonly string[]).includes(value);
}

export function isModelProfile(value: string): value is DigitalWorkforceModelProfile {
  return (DIGITAL_WORKFORCE_MODEL_PROFILES as readonly string[]).includes(value);
}

export function isRunStatus(value: string): value is DigitalAgentRunStatus {
  return (DIGITAL_AGENT_RUN_STATUSES as readonly string[]).includes(value);
}

export function isStepType(value: string): value is DigitalAgentStepType {
  return (DIGITAL_AGENT_STEP_TYPES as readonly string[]).includes(value);
}

export function isHandoffStatus(value: string): value is DigitalHandoffStatus {
  return (DIGITAL_HANDOFF_STATUSES as readonly string[]).includes(value);
}

export function isVersionLifecycle(value: string): value is DigitalAgentVersionLifecycle {
  return (DIGITAL_AGENT_VERSION_LIFECYCLES as readonly string[]).includes(value);
}

export function compareAgentVersions(
  left: DigitalWorkforceAgentVersion,
  right: DigitalWorkforceAgentVersion,
): Readonly<Record<string, boolean>> {
  return {
    persona: left.persona !== right.persona,
    roleDefinition: left.roleDefinition !== right.roleDefinition,
    goals: JSON.stringify(left.goals) !== JSON.stringify(right.goals),
    supervisor: left.supervisorAgentId !== right.supervisorAgentId,
    model: JSON.stringify(left.modelAssignment) !== JSON.stringify(right.modelAssignment),
    tools: JSON.stringify(left.toolGrants) !== JSON.stringify(right.toolGrants),
    dataScopes: JSON.stringify(left.dataScopes) !== JSON.stringify(right.dataScopes),
    knowledgeScopes: JSON.stringify(left.knowledgeScopes) !== JSON.stringify(right.knowledgeScopes),
    approvalPolicy: left.approvalPolicy !== right.approvalPolicy,
    runtimePolicy: JSON.stringify(left.runtimePolicy) !== JSON.stringify(right.runtimePolicy),
  };
}

export interface NaturalLanguageAgentDraftPreview {
  readonly displayName: string;
  readonly roleTitle: string;
  readonly shortDescription: string;
  readonly avatar: DigitalAgentAvatar;
  readonly suggestedDepartmentSlug: string;
  readonly suggestedTeamSlug: string;
  readonly goals: readonly string[];
  readonly successCriteria: readonly string[];
  readonly modelProfile: DigitalWorkforceModelProfile;
  readonly toolNames: readonly DigitalWorkforceRegisteredTool[];
  readonly dataScopes: readonly DigitalWorkforceDataScope[];
  readonly knowledgeScopes: readonly DigitalWorkforceKnowledgeScope[];
  readonly approvalPolicy: DigitalWorkforceApprovalPolicy;
  readonly memoryPolicy: DigitalWorkforceMemoryPolicy;
  readonly warnings: readonly string[];
  readonly publishesAutomatically: false;
}

export function draftAgentConfigurationFromNaturalLanguage(
  request: string,
): NaturalLanguageAgentDraftPreview {
  const normalized = assertSafeBoundedText(request, "agent request", 2_000);
  if (containsPromptInjection(normalized)) {
    throw new DigitalWorkforcePolicyError(
      "Natural-language agent drafts cannot contain instruction-override language.",
    );
  }
  const lower = normalized.toLocaleLowerCase("en-US");
  if (
    /\b(?:unrestricted|computer control|arbitrary (?:code|sql|url)|ignore policy|expand permission)\b/iu.test(
      lower,
    )
  ) {
    throw new DigitalWorkforcePolicyError(
      "Requests for unrestricted tools or expanded permissions are rejected.",
    );
  }
  const research = /\bresearch|web search|citations|standards\b/iu.test(lower);
  const document = /\bdocument|pdf|briefing|memo\b/iu.test(lower);
  const leads = /\blead|readiness|proposal\b/iu.test(lower);
  const tools: DigitalWorkforceRegisteredTool[] = ["bea_list_agents", "bea_get_agent"];
  if (leads) tools.push("bea_query_records", "bea_preview_task");
  if (research) tools.push("search_web");
  if (document) tools.push("bea_create_pdf", "bea_list_artifacts", "bea_open_artifact");
  tools.push("bea_delegate_to_agent");
  const warnings: string[] = [
    "This is a Digital Agent configuration draft. It is not published and cannot run until an owner confirms publication.",
    "Organizational File Search remains not connected.",
    "Email, calendar, Proposal Builder, and Project Command Record remain not connected.",
  ];
  if (!research)
    warnings.push("Public Web Search is not granted unless the request includes research.");
  return {
    displayName: research
      ? "Public Research Specialist Draft"
      : document
        ? "Executive Document Specialist Draft"
        : leads
          ? "Lead Review Specialist Draft"
          : "Guided Digital Agent Draft",
    roleTitle: research
      ? "Public Research Specialist"
      : document
        ? "Executive Document Specialist"
        : leads
          ? "Lead Review Specialist"
          : "Digital Specialist",
    shortDescription: `Digital Agent drafted from an owner request: ${normalized.slice(0, 240)}`,
    avatar: research
      ? "specialist-research"
      : document
        ? "specialist-document"
        : leads
          ? "specialist-lead"
          : "specialist-operations",
    suggestedDepartmentSlug: research
      ? "research-knowledge"
      : document
        ? "document-communications"
        : leads
          ? "revenue-client-development"
          : "executive-office",
    suggestedTeamSlug: research
      ? "public-research"
      : document
        ? "executive-documents"
        : leads
          ? "client-development"
          : "executive-partnership",
    goals: [normalized],
    successCriteria: [
      "Stay inside registered tools and authorized record scopes.",
      "Return structured evidence without expanding permissions.",
    ],
    modelProfile: research ? "public-research" : document ? "balanced" : "fast",
    toolNames: [...new Set(tools)],
    dataScopes: leads
      ? ["leads", "tasks", "current-conversation"]
      : ["current-conversation", "artifacts"],
    knowledgeScopes: research
      ? ["public-web", "current-conversation"]
      : ["current-conversation", "authorized-bea-records"],
    approvalPolicy: "confirmation-required",
    memoryPolicy: "run-only",
    warnings,
    publishesAutomatically: false,
  };
}

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function sha256Hex(message: string): string {
  const encoded = new TextEncoder().encode(message);
  const length = encoded.length;
  const bitLength = length * 8;
  const paddedLength = (((length + 8) >> 6) + 1) << 6;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(encoded);
  bytes[length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 4, bitLength, false);

  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + k[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((value) => value.toString(16).padStart(8, "0"))
    .join("");
}
