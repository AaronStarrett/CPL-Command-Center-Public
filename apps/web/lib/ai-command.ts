import "server-only";

import { randomUUID } from "node:crypto";

import {
  DEMO_ROUTER_VERSION,
  answerFromSelectedContext,
  applyWorkspaceSelection,
  authorizeWorkspaceSelection,
  buildLeadPresentation,
  buildResearchPresentation,
  buildSelectedEvidenceContext,
  createSimulatedResearchResult,
  isFollowUpAboutSelection,
  isProtectedAssistantPolicyRequest,
  parsePresentationFromPayload,
  parseSafeWorkspaceSelection,
  presentationPacketFromStoredRun,
  researchWorkspacePayload,
  researchWorkspaceSubtitle,
  resolveDemoDueDate,
  routeDemoCommand,
} from "@bea/ai";
import {
  getServerRuntime,
  Phase1ValidationError,
  Phase1OwnershipError,
  TASK_ACTION_CONFIRMATION,
  type BeaServerRuntime,
  type CreateSuggestedActionInput,
  type CreateWorkspaceArtifactInput,
} from "@bea/database";
import {
  DEMO_PERSONAS,
  type AssistantMessage,
  type Company,
  type Contact,
  type JsonObject,
  type Lead,
  type LeadReadinessResult,
  type Phase1SearchResult,
  type SuggestedAction,
  type Task,
  type WorkspaceArtifact,
  type WorkspaceArtifactLink,
  type WorkspaceArtifactSource,
} from "@bea/domain";
import { createCorrelationId } from "@bea/observability";
import {
  AccessDeniedError,
  PERMISSIONS,
  requireCredentialSafeContent,
  type Permission,
} from "@bea/security";

import { requiresLiveOpenAiProvider } from "@bea/config";
import { routeDigitalWorkforceIntent } from "./digital-workforce-command";
import type {
  AiCommandArtifactView,
  AiCommandMessageView,
  AiCommandSnapshot,
} from "./ai-command-contracts";
import { getAssistantPolicyContext } from "./assistant-policy";
import {
  isDeterministicDemoAiCommandAllowed,
  mergeModelCapabilityEvidence,
  readOpenAiAdministration,
  OpenAiAdministrationError,
} from "./openai-administration";

const HELP_COMMANDS = [
  "Show me today's priorities",
  "Show open tasks",
  "Show overdue tasks",
  "Show unread notifications",
  "Show recent activity",
  "Show all companies",
  "Open [company name]",
  "Show contacts for [company name]",
  "Search for [term]",
  "Show connector health",
  "Which systems are not connected?",
  "Show recent workflow runs",
  "Open the latest workflow run",
  "Create an internal follow-up task",
  "Show leads",
  "Show me the leads that still need information",
  "Open lead [reference or opportunity]",
  "What is missing on lead [reference]",
  "Research the latest information relevant to water penetration testing",
  "Show me my digital workforce",
  "Show the company agent hierarchy",
  "Which agents are working right now?",
  "Show the latest handoff",
  "Have the executive team review the blocked leads",
] as const;

interface AssistantTurn {
  readonly content: string;
  readonly artifact: Omit<
    CreateWorkspaceArtifactInput,
    "conversationId" | "requestedByUserId" | "createdAt"
  >;
  readonly suggestedAction?: Omit<
    CreateSuggestedActionInput,
    "conversationId" | "requestedByUserId" | "createdAt"
  >;
}

const AI_COMMAND_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function normalizeAiCommandRequestId(value: unknown): string {
  const requestId = typeof value === "string" ? value.trim() : "";
  if (requestId.length !== 36 || !AI_COMMAND_REQUEST_ID_PATTERN.test(requestId)) {
    throw new Phase1ValidationError("AI Command request ID must be a canonical UUID.");
  }
  return requestId.toLocaleLowerCase("en-US");
}

export function normalizeAiCommandRequestGeneration(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Phase1ValidationError("AI Command request generation is invalid.");
  }
  return value;
}

function source(id: string, type: string, title: string, href: string): WorkspaceArtifactSource {
  return { id, type, title, href };
}

function link(label: string, href: string): WorkspaceArtifactLink {
  return { label, href };
}

function taskItem(task: Task): JsonObject {
  return {
    id: task.id,
    title: task.title,
    subtitle: task.description ?? "Internal task",
    status: task.status,
    priority: task.priority,
    dueAt: task.dueAt,
    dueLabel: task.dueAt ? new Date(task.dueAt).toLocaleDateString("en-US") : null,
    href: `/tasks/${task.id}`,
  };
}

function companyItem(company: Company): JsonObject {
  return {
    id: company.id,
    title: company.name,
    subtitle: company.industry ?? "Building-envelope organization",
    status: company.status,
    href: `/companies/${company.id}`,
  };
}

function contactItem(contact: Contact): JsonObject {
  const name = `${contact.firstName} ${contact.lastName}`;
  return {
    id: contact.id,
    title: name,
    subtitle: contact.jobTitle ?? contact.email ?? "Contact",
    status: contact.status,
    companyId: contact.companyId,
    href: `/contacts/${contact.id}`,
  };
}

function leadItem(lead: Lead, readiness: LeadReadinessResult): JsonObject {
  return {
    id: lead.id,
    title: lead.opportunityName,
    subtitle: `${lead.reference} · ${lead.sourceType} · ${lead.status}`,
    status: lead.status,
    href: `/leads/${lead.id}`,
    readyForProposal: readiness.readyForProposal,
    blocking: readiness.blocking.length,
  };
}

function artifactView(artifact: WorkspaceArtifact): AiCommandArtifactView {
  return {
    id: artifact.id,
    type: artifact.type,
    title: artifact.title,
    subtitle: artifact.subtitle,
    state: artifact.state,
    payload: artifact.payload,
    sources: artifact.sources,
    links: artifact.links,
    requiredPermissions: artifact.requiredPermissions,
    createdAt: artifact.createdAt,
    errorCode: artifact.errorCode,
  };
}

function messageViews(
  messages: readonly AssistantMessage[],
  artifact: WorkspaceArtifact,
  redactedAssistantMessageIds: ReadonlySet<string>,
): readonly AiCommandMessageView[] {
  const lastAssistantId = [...messages]
    .reverse()
    .find((message) => message.role === "assistant")?.id;
  return messages.map((message) => {
    const redacted = redactedAssistantMessageIds.has(message.id);
    return {
      id: message.id,
      role: message.role,
      content: redacted
        ? "This persisted assistant response is hidden because its current permissions are not granted."
        : message.content,
      createdAt: message.createdAt,
      provider: message.provider,
      model: message.model,
      providerResponseId: message.providerResponseId,
      responseStatus: message.responseStatus,
      executionMs: message.executionMs,
      links: !redacted && message.id === lastAssistantId ? artifact.links : [],
    };
  });
}

async function can(runtime: BeaServerRuntime, userId: string, permission: Permission) {
  return (await runtime.authorization.authorizeUser(userId, permission)).allowed;
}

const knownPermissions = new Set<string>(Object.values(PERMISSIONS));

async function assistantMessagesDeniedByCurrentPermissions(
  runtime: BeaServerRuntime,
  userId: string,
  messages: readonly AssistantMessage[],
): Promise<ReadonlySet<string>> {
  const permissionDecisions = new Map<string, boolean>();
  const requestedPermissions = new Set(
    messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => [...message.requiredPermissions]),
  );
  await Promise.all(
    [...requestedPermissions].map(async (permission) => {
      permissionDecisions.set(
        permission,
        knownPermissions.has(permission) && (await can(runtime, userId, permission as Permission)),
      );
    }),
  );
  return new Set(
    messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          (message.requiredPermissions.length === 0 ||
            message.requiredPermissions.some(
              (permission) => permissionDecisions.get(permission) !== true,
            )),
      )
      .map((message) => message.id),
  );
}

function taskActionPermissions(action: SuggestedAction): readonly Permission[] {
  const permissions = new Set<Permission>([
    PERMISSIONS.AI_COMMAND_VIEW,
    PERMISSIONS.TASKS_VIEW,
    PERMISSIONS.TASK_ACTION_EXECUTE,
  ]);
  if (typeof action.payload.companyId === "string") permissions.add(PERMISSIONS.COMPANIES_VIEW);
  if (typeof action.payload.contactId === "string") permissions.add(PERMISSIONS.CONTACTS_VIEW);
  const declared = action.payload.requiredPermissions;
  if (declared !== undefined) {
    if (
      !Array.isArray(declared) ||
      declared.some(
        (permission) => typeof permission !== "string" || !knownPermissions.has(permission),
      )
    ) {
      throw new Phase1ValidationError("Suggested action permission requirements are invalid.");
    }
    for (const permission of declared) permissions.add(permission as Permission);
  }
  if (!knownPermissions.has(action.requiredPermission)) {
    throw new Phase1ValidationError("Suggested action permission requirements are invalid.");
  }
  permissions.add(action.requiredPermission as Permission);
  return [...permissions];
}

async function artifactForCurrentPermissions(
  runtime: BeaServerRuntime,
  userId: string,
  artifact: WorkspaceArtifact,
): Promise<WorkspaceArtifact> {
  const permissions = artifact.requiredPermissions.filter((permission): permission is Permission =>
    knownPermissions.has(permission),
  );
  const decisions = await Promise.all(
    permissions.map((permission) => can(runtime, userId, permission)),
  );
  const allowed =
    permissions.length === artifact.requiredPermissions.length &&
    permissions.length > 0 &&
    decisions.every(Boolean);
  if (allowed) return artifact;
  return {
    ...artifact,
    type: "empty",
    title: "Workspace access changed",
    subtitle: "The persisted artifact is hidden because its permissions are not currently granted.",
    state: "empty",
    payload: { items: [] },
    sources: [],
    links: [],
    requiredPermissions: [PERMISSIONS.AI_COMMAND_VIEW],
    errorCode: "ARTIFACT_PERMISSION_NOT_GRANTED",
  };
}

async function artifactForCurrentActionState(
  runtime: BeaServerRuntime,
  userId: string,
  artifact: WorkspaceArtifact,
): Promise<WorkspaceArtifact> {
  if (artifact.type !== "action-preview") return artifact;
  const actionId = artifact.payload.actionId;
  const action =
    typeof actionId === "string" ? await runtime.phase1.getSuggestedAction(actionId, userId) : null;
  if (action?.status === "pending") return artifact;
  return {
    ...artifact,
    title: "Action preview superseded",
    subtitle: "A newer AI Command request replaced this preview. It cannot be executed.",
    state: "empty",
    payload: { ...artifact.payload, executable: false, superseded: true },
    sources: [],
    links: [],
    errorCode: "ACTION_PREVIEW_SUPERSEDED",
  };
}

async function createConversation(runtime: BeaServerRuntime, userId: string) {
  const correlationId = createCorrelationId();
  const administration = await readOpenAiAdministration(runtime, userId);
  const connected = administration.liveConnected;
  const explicitDemo = await isDeterministicDemoAiCommandAllowed(runtime);
  const assistantPolicy = await getAssistantPolicyContext(runtime, userId);
  const conversation = await runtime.phase1.createConversation({
    ownerUserId: userId,
    title: "New AI Command conversation",
    provider: connected || !explicitDemo ? "openai" : "simulated",
    model:
      connected || !explicitDemo
        ? administration.settings.defaultTextModel
        : "deterministic-demo-router",
    routerVersion: connected || !explicitDemo ? "phase1.3-provider-v1" : DEMO_ROUTER_VERSION,
  });
  await runtime.phase1.createAssistantMessage({
    conversationId: conversation.id,
    ownerUserId: userId,
    role: "assistant",
    content:
      assistantPolicy.persona.kind === "executive-business-partner"
        ? `Owner, I am your BEA Executive Business Partner. I can help you assess priorities, evaluate operating decisions, and prepare permission-checked actions and branded artifacts. ${connected ? "OpenAI is connected for authorized work." : explicitDemo ? "This session is using the deterministic demo provider." : "OpenAI setup required. Connect and test OpenAI before sending a request."}`
        : `I am ${assistantPolicy.persona.label}. I can query authorized BEA records and prepare permission-checked actions. ${connected ? "OpenAI is connected for authorized work." : explicitDemo ? "This session is using the deterministic demo provider." : "OpenAI is unavailable until an authorized administrator completes setup."}`,
    correlationId,
    provider: connected || !explicitDemo ? "openai" : "simulated",
    model:
      connected || !explicitDemo
        ? administration.settings.defaultTextModel
        : "deterministic-demo-router",
    routerVersion: connected || !explicitDemo ? "phase1.3-provider-v1" : DEMO_ROUTER_VERSION,
    executionMs: 0,
    requiredPermissions: [PERMISSIONS.AI_COMMAND_VIEW],
  });
  await runtime.phase1.createWorkspaceArtifact({
    conversationId: conversation.id,
    requestedByUserId: userId,
    type: explicitDemo ? "help" : "empty",
    title: explicitDemo ? "AI Command capabilities" : "Connect OpenAI",
    subtitle: explicitDemo ? "Deterministic, permission-aware Demo Mode" : "OpenAI setup required",
    payload: explicitDemo
      ? { commands: [...HELP_COMMANDS] }
      : {
          providerStatus: administration.providerStatus,
          actionable: true,
          componentStatus: {
            openAiText: administration.liveConnected ? "Connected" : "Setup required",
            webSearch:
              administration.liveConnected && administration.settings.webSearchAllowed
                ? "Enabled"
                : "Disabled",
            fileSearch:
              administration.liveConnected && administration.vectorStoreIds.length > 0
                ? `${administration.vectorStoreIds.length} connected store${administration.vectorStoreIds.length === 1 ? "" : "s"}`
                : "Not configured",
            voice:
              administration.liveConnected && administration.settings.realtimeAllowed
                ? "Connected"
                : "Setup required",
            beaData: "Not connected",
            businessIntegrations: "Not connected",
          },
        },
    requiredPermissions: [PERMISSIONS.AI_COMMAND_VIEW],
  });
  return conversation;
}

export async function createAiCommandConversation(userId: string): Promise<AiCommandSnapshot> {
  const runtime = await getServerRuntime();
  const conversation = await createConversation(runtime, userId);
  return buildSnapshot(runtime, userId, conversation.id);
}

async function buildSnapshot(
  runtime: BeaServerRuntime,
  userId: string,
  requestedConversationId?: string,
): Promise<AiCommandSnapshot> {
  const conversations = await runtime.phase1.listConversations(userId, 20);
  let conversation = requestedConversationId
    ? await runtime.phase1.getConversation(requestedConversationId, userId)
    : conversations[0];
  if (requestedConversationId && !conversation) throw new Phase1OwnershipError();
  conversation ??= await createConversation(runtime, userId);

  let [messages, artifacts] = await Promise.all([
    runtime.phase1.listAssistantMessages(conversation.id, userId, 200),
    runtime.phase1.listWorkspaceArtifacts(conversation.id, userId, 1),
  ]);
  if (messages.length === 0 || artifacts.length === 0) {
    const restored = await runtime.phase1.getConversation(conversation.id, userId);
    if (!restored) throw new Phase1OwnershipError();
    if (messages.length === 0) {
      await runtime.phase1.createAssistantMessage({
        conversationId: conversation.id,
        ownerUserId: userId,
        role: "assistant",
        content: (await isDeterministicDemoAiCommandAllowed(runtime))
          ? "This persisted conversation is ready for another deterministic demo request."
          : "OpenAI setup required. Connect and test OpenAI before sending a request.",
        correlationId: createCorrelationId(),
        routerVersion: DEMO_ROUTER_VERSION,
        executionMs: 0,
        requiredPermissions: [PERMISSIONS.AI_COMMAND_VIEW],
      });
    }
    if (artifacts.length === 0) {
      await runtime.phase1.createWorkspaceArtifact({
        conversationId: conversation.id,
        requestedByUserId: userId,
        type: "empty",
        title: "Workspace ready",
        subtitle: "Ask a supported question to display authorized records.",
        payload: { items: [] },
        requiredPermissions: [PERMISSIONS.AI_COMMAND_VIEW],
      });
    }
    [messages, artifacts] = await Promise.all([
      runtime.phase1.listAssistantMessages(conversation.id, userId, 200),
      runtime.phase1.listWorkspaceArtifacts(conversation.id, userId, 1),
    ]);
  }
  const persistedArtifact = artifacts[0];
  if (!persistedArtifact) throw new Error("AI Command workspace state is unavailable.");
  const permittedArtifact = await artifactForCurrentPermissions(runtime, userId, persistedArtifact);
  const artifact = await artifactForCurrentActionState(runtime, userId, permittedArtifact);
  const actingUser = await runtime.repository.findActiveUserById(userId);
  if (!actingUser) throw new Phase1OwnershipError();
  const refreshedConversations = await runtime.phase1.listConversations(userId, 20);
  const redactedAssistantMessageIds = await assistantMessagesDeniedByCurrentPermissions(
    runtime,
    userId,
    messages,
  );
  const administration = await readOpenAiAdministration(runtime, userId);
  const assistantPolicy = await getAssistantPolicyContext(runtime, userId);
  const configuredTextModel = administration.cachedModels.find(
    (model) => model.modelId === administration.settings.defaultTextModel,
  );
  const configuredOverride =
    administration.settings.modelCapabilityOverrides[administration.settings.defaultTextModel];
  const configuredTextCapabilities = mergeModelCapabilityEvidence(
    configuredTextModel?.capabilities,
    configuredOverride,
  );
  const demoProviderActive = await isDeterministicDemoAiCommandAllowed(runtime);
  const liveProviderSelected =
    requiresLiveOpenAiProvider(runtime.environment) ||
    runtime.environment.appMode === "production" ||
    administration.settings.mode === "openai" ||
    administration.settings.mode === "hybrid";
  const providerState = {
    name: administration.liveConnected
      ? "OpenAI"
      : liveProviderSelected
        ? "OpenAI (activation required)"
        : "BEA deterministic demo assistant",
    label: "BEA AI Command",
    mode: administration.settings.mode,
    status: administration.providerStatus,
    providerStatus: administration.providerStatus,
    simulated: demoProviderActive,
    model: liveProviderSelected
      ? administration.settings.defaultTextModel
      : "deterministic-demo-router",
    textModel: administration.settings.defaultTextModel,
    realtimeModel: administration.settings.defaultRealtimeModel,
    voice: administration.settings.defaultVoice,
    routerVersion: liveProviderSelected ? "phase1.3-provider-v1" : DEMO_ROUTER_VERSION,
    liveConnected: administration.liveConnected,
    streaming: true,
    webSearchAllowed:
      demoProviderActive ||
      (administration.settings.webSearchAllowed && configuredTextCapabilities.webSearch === true),
    webSearchDefault:
      administration.settings.webSearchDefault &&
      (demoProviderActive ||
        (administration.settings.webSearchAllowed &&
          configuredTextCapabilities.webSearch === true)),
    codeInterpreterAllowed:
      demoProviderActive ||
      (administration.settings.codeInterpreterAllowed &&
        configuredTextCapabilities.codeInterpreter === true),
    imageGenerationAllowed:
      demoProviderActive ||
      (administration.settings.imageGenerationAllowed &&
        configuredTextCapabilities.imageGeneration === true),
    pdfGenerationAllowed: demoProviderActive || administration.settings.pdfGenerationAllowed,
    realtimeAllowed: administration.settings.realtimeAllowed,
    speakResponses: administration.voicePreference?.speakResponses ?? true,
    maxUploadBytes: administration.settings.maxUploadBytes,
    textModelCapabilities: configuredTextCapabilities,
  };

  return {
    conversation: {
      id: conversation.id,
      title: conversation.title,
      updatedAt: conversation.updatedAt,
    },
    conversations: refreshedConversations.map((item) => ({
      id: item.id,
      title: item.title,
      updatedAt: item.updatedAt,
    })),
    messages: messageViews(messages, artifact, redactedAssistantMessageIds),
    artifact: artifactView(artifact),
    provider: providerState,
    permissions: {
      canConfigureOpenAi:
        (await can(runtime, userId, PERMISSIONS.INTEGRATIONS_VIEW)) &&
        (await can(runtime, userId, PERMISSIONS.INTEGRATIONS_MANAGE)) &&
        (await can(runtime, userId, PERMISSIONS.SETTINGS_MANAGE)),
      canExecuteTaskAction: await can(runtime, userId, PERMISSIONS.TASK_ACTION_EXECUTE),
      canUploadArtifact:
        (await can(runtime, userId, PERMISSIONS.DOCUMENTS_VIEW)) &&
        (await can(runtime, userId, PERMISSIONS.AI_COMMAND_RUN)),
    },
    actingUser: {
      id: actingUser.id,
      displayName: actingUser.displayName,
      title: actingUser.title ?? "BEA user",
    },
    assistant: assistantPolicy.persona,
  };
}

export async function getAiCommandSnapshot(
  userId: string,
  conversationId?: string,
): Promise<AiCommandSnapshot> {
  return getAiCommandSnapshotWithRuntime(await getServerRuntime(), userId, conversationId);
}

export async function getAiCommandSnapshotWithRuntime(
  runtime: BeaServerRuntime,
  userId: string,
  conversationId?: string,
): Promise<AiCommandSnapshot> {
  return buildSnapshot(runtime, userId, conversationId);
}

function listArtifact(input: {
  type: CreateWorkspaceArtifactInput["type"];
  title: string;
  subtitle: string;
  items: readonly JsonObject[];
  permission: Permission;
  additionalPermissions?: readonly Permission[];
  sources?: readonly WorkspaceArtifactSource[];
  presentation?: JsonObject;
}): AssistantTurn["artifact"] {
  const links = input.items.flatMap((item) => {
    const href = item.href;
    const title = item.title;
    return typeof href === "string" && typeof title === "string"
      ? [link(`Open ${title}`, href)]
      : [];
  });
  return {
    type: input.type,
    title: input.title,
    subtitle: input.subtitle,
    state: input.items.length > 0 ? "ready" : "empty",
    payload: {
      items: [...input.items],
      ...(input.presentation ? { presentation: input.presentation } : {}),
    },
    sources: input.sources ?? [],
    links: links.slice(0, 10),
    requiredPermissions: [input.permission, ...(input.additionalPermissions ?? [])],
  };
}

async function exactCompany(runtime: BeaServerRuntime, name: string): Promise<Company | null> {
  const companies = await runtime.phase1.listCompanies({ query: name, limit: 20 });
  return (
    companies.find(
      (company) => company.name.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US"),
    ) ?? null
  );
}

async function resolveAuthorizedLead(runtime: BeaServerRuntime, term: string) {
  const normalized = term.trim();
  if (!normalized) return null;
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(normalized)
  ) {
    const byId = await runtime.leads.getLead(normalized);
    if (byId) return byId;
  }
  const byReference = await runtime.leads.getLeadByReference(normalized);
  if (byReference) return byReference;
  const listed = await runtime.leads.listLeads({ query: normalized, limit: 20 });
  return (
    listed.find(
      (item) =>
        item.lead.opportunityName.toLocaleLowerCase("en-US") ===
          normalized.toLocaleLowerCase("en-US") ||
        item.lead.reference.toLocaleLowerCase("en-US") === normalized.toLocaleLowerCase("en-US"),
    ) ??
    listed[0] ??
    null
  );
}

function leadMissingSummary(readiness: LeadReadinessResult): string {
  if (readiness.readyForProposal) {
    return "Deterministic review-readiness is satisfied. This is not commercial authorization, billing approval, or scheduling.";
  }
  const blocking = readiness.blocking.map((item) => item.message).join(" ");
  return `Blocking missing information: ${blocking}`;
}

async function allowedSearchTypes(runtime: BeaServerRuntime, userId: string) {
  const pairs: readonly [Phase1SearchResult["type"], Permission][] = [
    ["company", PERMISSIONS.COMPANIES_VIEW],
    ["contact", PERMISSIONS.CONTACTS_VIEW],
    ["task", PERMISSIONS.TASKS_VIEW],
    ["lead", PERMISSIONS.LEADS_VIEW],
    ["integration", PERMISSIONS.INTEGRATIONS_VIEW],
    ["workflow-run", PERMISSIONS.WORKFLOW_VIEW],
  ];
  const decisions = await Promise.all(
    pairs.map(([, permission]) => can(runtime, userId, permission)),
  );
  return pairs.filter((_, index) => decisions[index]).map(([type]) => type);
}

async function routeReadIntent(
  runtime: BeaServerRuntime,
  userId: string,
  input: string,
  conversationId: string,
): Promise<AssistantTurn> {
  const intent = routeDemoCommand(input);
  const workforce = await routeDigitalWorkforceIntent(runtime, userId, conversationId, intent);
  if (workforce) return workforce;

  if (intent.type === "command-center-summary") {
    const [canViewTasks, canViewNotifications, canViewCompanies, canViewContacts, taskReadScope] =
      await Promise.all([
        can(runtime, userId, PERMISSIONS.TASKS_VIEW),
        can(runtime, userId, PERMISSIONS.NOTIFICATIONS_VIEW),
        can(runtime, userId, PERMISSIONS.COMPANIES_VIEW),
        can(runtime, userId, PERMISSIONS.CONTACTS_VIEW),
        runtime.authorization.taskReadScopeForUser(userId),
      ]);
    const counts = await runtime.phase1.getDashboardCounts(userId, {
      tasks: canViewTasks,
      taskScope: taskReadScope === "all" ? "all" : "assigned",
      notifications: canViewNotifications,
      companies: canViewCompanies,
      contacts: canViewContacts,
    });
    const metrics = [
      ...(canViewTasks
        ? [
            {
              label: "Open tasks",
              value: counts.openTasks,
              href: `/tasks?status=open&scope=${taskReadScope === "all" ? "all" : "mine"}`,
            },
            {
              label: "Overdue tasks",
              value: counts.overdueTasks,
              href: `/tasks?status=open&overdue=true&scope=${taskReadScope === "all" ? "all" : "mine"}`,
            },
          ]
        : []),
      ...(canViewNotifications
        ? [
            {
              label: "Unread notifications",
              value: counts.unreadNotifications,
              href: "/notifications?view=unread",
            },
          ]
        : []),
      ...(canViewCompanies
        ? [{ label: "Companies", value: counts.companies, href: "/companies" }]
        : []),
      ...(canViewContacts
        ? [{ label: "Contacts", value: counts.contacts, href: "/contacts" }]
        : []),
    ];
    return {
      content:
        metrics.length > 0
          ? `Today's authorized demo summary includes ${metrics.length} permission-filtered operational metric${metrics.length === 1 ? "" : "s"}.`
          : "No Phase 1 operational metrics are authorized for the current role.",
      artifact: {
        type: "command-center-summary",
        title: "Today's priorities",
        subtitle: "Live counts from the local Phase 1 demo database",
        state: metrics.length > 0 ? "ready" : "empty",
        payload: { metrics },
        requiredPermissions: [
          PERMISSIONS.HOME_VIEW,
          ...(canViewTasks ? [PERMISSIONS.TASKS_VIEW] : []),
          ...(canViewNotifications ? [PERMISSIONS.NOTIFICATIONS_VIEW] : []),
          ...(canViewCompanies ? [PERMISSIONS.COMPANIES_VIEW] : []),
          ...(canViewContacts ? [PERMISSIONS.CONTACTS_VIEW] : []),
        ],
      },
    };
  }

  if (intent.type === "open-tasks" || intent.type === "overdue-tasks") {
    const permitted = await can(runtime, userId, PERMISSIONS.TASKS_VIEW);
    if (!permitted) throw new AccessDeniedError("permission-not-granted");
    const taskReadScope = await runtime.authorization.taskReadScopeForUser(userId);
    const tasks = await runtime.phase1.listTasks({
      status: "open",
      limit: 100,
      overdueOnly: intent.type === "overdue-tasks",
      ...(taskReadScope !== "all" ? { assigneeUserId: userId } : {}),
    });
    const filtered = tasks;
    const label = intent.type === "overdue-tasks" ? "overdue" : "open";
    return {
      content: `I found ${filtered.length} ${label} task${filtered.length === 1 ? "" : "s"} in the authorized demo database.`,
      artifact: listArtifact({
        type: "task-list",
        title: `${label[0]?.toUpperCase()}${label.slice(1)} tasks`,
        subtitle: "Database-backed internal tasks",
        items: filtered.map(taskItem),
        sources: filtered.map((task) => source(task.id, "task", task.title, `/tasks/${task.id}`)),
        permission: PERMISSIONS.TASKS_VIEW,
      }),
    };
  }

  if (intent.type === "unread-notifications") {
    if (!(await can(runtime, userId, PERMISSIONS.NOTIFICATIONS_VIEW))) {
      throw new AccessDeniedError("permission-not-granted");
    }
    const notifications = await runtime.phase1.listNotifications({
      userId,
      unreadOnly: true,
      limit: 50,
    });
    return {
      content: `You have ${notifications.length} unread demo notification${notifications.length === 1 ? "" : "s"}.`,
      artifact: listArtifact({
        type: "notification-list",
        title: "Unread notifications",
        subtitle: "Only notifications owned by the acting user",
        items: notifications.map((notification) => ({
          id: notification.id,
          title: notification.title,
          subtitle: notification.body,
          status: "unread",
          href: notification.sourceHref ?? "/notifications",
        })),
        permission: PERMISSIONS.NOTIFICATIONS_VIEW,
      }),
    };
  }

  if (intent.type === "recent-activity") {
    if (!(await can(runtime, userId, PERMISSIONS.ACTIVITIES_VIEW))) {
      throw new AccessDeniedError("permission-not-granted");
    }
    const activities = await runtime.phase1.listActivities({ limit: 30 });
    return {
      content: `I found ${activities.length} recent authorized activity event${activities.length === 1 ? "" : "s"}.`,
      artifact: listArtifact({
        type: "activity-timeline",
        title: "Recent activity",
        subtitle: "Normalized Phase 1 activity timeline",
        items: activities.map((activity) => ({
          id: activity.id,
          title: activity.summary,
          subtitle: new Date(activity.createdAt).toLocaleString("en-US"),
          status: activity.type,
          href: activity.taskId
            ? `/tasks/${activity.taskId}`
            : activity.leadId
              ? `/leads/${activity.leadId}`
              : activity.companyId
                ? `/companies/${activity.companyId}`
                : activity.contactId
                  ? `/contacts/${activity.contactId}`
                  : "/activities",
        })),
        permission: PERMISSIONS.ACTIVITIES_VIEW,
      }),
    };
  }

  if (intent.type === "company-list") {
    if (!(await can(runtime, userId, PERMISSIONS.COMPANIES_VIEW))) {
      throw new AccessDeniedError("permission-not-granted");
    }
    const companies = await runtime.phase1.listCompanies({ limit: 100 });
    return {
      content: `I found ${companies.length} synthetic compan${companies.length === 1 ? "y" : "ies"} in the demo database.`,
      artifact: listArtifact({
        type: "company-list",
        title: "Companies",
        subtitle: "Synthetic Phase 1 organizations",
        items: companies.map(companyItem),
        sources: companies.map((company) =>
          source(company.id, "company", company.name, `/companies/${company.id}`),
        ),
        permission: PERMISSIONS.COMPANIES_VIEW,
      }),
    };
  }

  if (intent.type === "company-open" && intent.companyName) {
    if (!(await can(runtime, userId, PERMISSIONS.COMPANIES_VIEW))) {
      throw new AccessDeniedError("permission-not-granted");
    }
    const company = await exactCompany(runtime, intent.companyName);
    if (!company) {
      return {
        content: `No authorized company matched “${intent.companyName}”.`,
        artifact: listArtifact({
          type: "company-list",
          title: "Company not found",
          subtitle: "No authorized database record matched",
          items: [],
          permission: PERMISSIONS.COMPANIES_VIEW,
        }),
      };
    }
    const [canViewContacts, canViewTasks, taskReadScope] = await Promise.all([
      can(runtime, userId, PERMISSIONS.CONTACTS_VIEW),
      can(runtime, userId, PERMISSIONS.TASKS_VIEW),
      runtime.authorization.taskReadScopeForUser(userId),
    ]);
    const [contacts, tasks] = await Promise.all([
      canViewContacts
        ? runtime.phase1.listContacts({ companyId: company.id, limit: 100 })
        : Promise.resolve([]),
      canViewTasks
        ? runtime.phase1.listTasks({
            companyId: company.id,
            limit: 100,
            ...(taskReadScope !== "all" ? { assigneeUserId: userId } : {}),
          })
        : Promise.resolve([]),
    ]);
    const relatedSummary = [
      canViewContacts ? `${contacts.length} related contacts` : null,
      canViewTasks ? `${tasks.length} related tasks` : null,
    ].filter((value): value is string => value !== null);
    return {
      content:
        relatedSummary.length > 0
          ? `I opened ${company.name}, with ${relatedSummary.join(" and ")}.`
          : `I opened ${company.name}. Related contact and task counts are not authorized for this role.`,
      artifact: {
        type: "company-detail",
        title: company.name,
        subtitle: "Company detail from the local demo database",
        payload: {
          record: {
            status: company.status,
            industry: company.industry,
            website: company.website,
            phone: company.phone,
            ...(canViewContacts ? { contacts: contacts.length } : {}),
            ...(canViewTasks ? { relatedTasks: tasks.length } : {}),
          },
        },
        sources: [source(company.id, "company", company.name, `/companies/${company.id}`)],
        links: [link("Open company record", `/companies/${company.id}`)],
        requiredPermissions: [
          PERMISSIONS.COMPANIES_VIEW,
          ...(canViewContacts ? [PERMISSIONS.CONTACTS_VIEW] : []),
          ...(canViewTasks ? [PERMISSIONS.TASKS_VIEW] : []),
        ],
      },
    };
  }

  if (intent.type === "company-contacts" && intent.companyName) {
    const [canViewContacts, canViewCompanies] = await Promise.all([
      can(runtime, userId, PERMISSIONS.CONTACTS_VIEW),
      can(runtime, userId, PERMISSIONS.COMPANIES_VIEW),
    ]);
    if (!canViewContacts || !canViewCompanies) {
      throw new AccessDeniedError("permission-not-granted");
    }
    const company = await exactCompany(runtime, intent.companyName);
    const contacts = company
      ? await runtime.phase1.listContacts({ companyId: company.id, limit: 100 })
      : [];
    return {
      content: company
        ? `I found ${contacts.length} contact${contacts.length === 1 ? "" : "s"} for ${company.name}.`
        : `No authorized company matched “${intent.companyName}”.`,
      artifact: listArtifact({
        type: "contact-list",
        title: company ? `Contacts for ${company.name}` : "Contacts not found",
        subtitle: "Database-backed company relationships",
        items: contacts.map(contactItem),
        sources: contacts.map((contact) =>
          source(
            contact.id,
            "contact",
            `${contact.firstName} ${contact.lastName}`,
            `/contacts/${contact.id}`,
          ),
        ),
        permission: PERMISSIONS.CONTACTS_VIEW,
        additionalPermissions: [PERMISSIONS.COMPANIES_VIEW],
      }),
    };
  }

  if (intent.type === "lead-list") {
    if (!(await can(runtime, userId, PERMISSIONS.LEADS_VIEW))) {
      throw new AccessDeniedError("permission-not-granted");
    }
    const leads = await runtime.leads.listLeads({ limit: 100 });
    return {
      content: `I found ${leads.length} authorized lead record${leads.length === 1 ? "" : "s"} in the current environment.`,
      artifact: listArtifact({
        type: "lead-list",
        title: "Lead review queue",
        subtitle:
          "Lead records in the current environment · website, Outlook, and telephone connectors are not connected",
        items: leads.map((item) => leadItem(item.lead, item.readiness)),
        sources: leads.map((item) =>
          source(item.lead.id, "lead", item.lead.opportunityName, `/leads/${item.lead.id}`),
        ),
        permission: PERMISSIONS.LEADS_VIEW,
      }),
    };
  }

  if (intent.type === "lead-needs-info-list") {
    if (!(await can(runtime, userId, PERMISSIONS.LEADS_VIEW))) {
      throw new AccessDeniedError("permission-not-granted");
    }
    const leads = await runtime.leads.listLeads({ limit: 100 });
    const blocked = leads.filter((item) => item.readiness.blocking.length > 0);
    const presentation = buildLeadPresentation({
      conversationId,
      actingUserId: userId,
      query: input,
      leads: blocked.map((item) => ({
        id: item.lead.id,
        reference: item.lead.reference,
        opportunityName: item.lead.opportunityName,
        status: item.lead.status,
        blocking: item.readiness.blocking.map((gap) => gap.message),
      })),
      provider: "demo",
      model: "deterministic-demo-router",
      requiredPermissions: [PERMISSIONS.LEADS_VIEW],
    });
    const content = `${presentation.summary} ${presentation.suggestedNextStep} These are authorized records in the current environment, not live connected CRM data.`;
    return {
      content,
      artifact: listArtifact({
        type: "lead-list",
        title: presentation.title,
        subtitle: "Demonstration BEA records · not live business data",
        items: blocked.map((item) => leadItem(item.lead, item.readiness)),
        sources: blocked.map((item) =>
          source(item.lead.id, "lead", item.lead.opportunityName, `/leads/${item.lead.id}`),
        ),
        permission: PERMISSIONS.LEADS_VIEW,
        presentation: presentation as unknown as JsonObject,
      }),
    };
  }

  if (intent.type === "research-presentation") {
    if (!(await can(runtime, userId, PERMISSIONS.SEARCH_VIEW))) {
      throw new AccessDeniedError("permission-not-granted");
    }
    const result = createSimulatedResearchResult(input);
    const presentation = buildResearchPresentation({
      conversationId,
      actingUserId: userId,
      query: input,
      result,
      provider: "demo",
      requiredPermissions: [PERMISSIONS.AI_COMMAND_VIEW, PERMISSIONS.SEARCH_VIEW],
    });
    return {
      content: `${presentation.summary} ${presentation.narrationSegments
        .map((segment) => segment.spokenText)
        .slice(0, 2)
        .join(" ")} ${presentation.suggestedNextStep}`,
      artifact: {
        type: "help",
        title: presentation.title,
        subtitle: researchWorkspaceSubtitle(presentation),
        state: presentation.sources.length > 0 ? "ready" : "empty",
        payload: researchWorkspacePayload(presentation) as JsonObject,
        sources: presentation.sources.map((sourceItem) =>
          source(sourceItem.id, "web-source", sourceItem.title, sourceItem.url),
        ),
        links: presentation.sources.map((sourceItem) =>
          link(`Source ${sourceItem.number}`, sourceItem.url),
        ),
        requiredPermissions: [PERMISSIONS.AI_COMMAND_VIEW, PERMISSIONS.SEARCH_VIEW],
      },
    };
  }

  if ((intent.type === "lead-open" || intent.type === "lead-missing-info") && intent.leadTerm) {
    if (!(await can(runtime, userId, PERMISSIONS.LEADS_VIEW))) {
      throw new AccessDeniedError("permission-not-granted");
    }
    const match = await resolveAuthorizedLead(runtime, intent.leadTerm);
    if (!match) {
      return {
        content: `No authorized lead matched “${intent.leadTerm}”.`,
        artifact: listArtifact({
          type: "lead-list",
          title: "Lead not found",
          subtitle: "No authorized database record matched",
          items: [],
          permission: PERMISSIONS.LEADS_VIEW,
        }),
      };
    }
    const missing = leadMissingSummary(match.readiness);
    return {
      content:
        intent.type === "lead-missing-info"
          ? `${match.lead.reference} ${match.lead.opportunityName}. ${missing}`
          : `I opened ${match.lead.reference} ${match.lead.opportunityName}. ${missing} I did not change status or create a proposal.`,
      artifact: {
        type: "lead-detail",
        title: match.lead.opportunityName,
        subtitle: `${match.lead.reference} · authorized lead record · website, Outlook, and telephone connectors are not connected`,
        payload: {
          record: {
            status: match.lead.status,
            sourceType: match.lead.sourceType,
            receivedAt: match.lead.receivedAt,
            requestedService: match.lead.requestedService,
            requestSummary: match.lead.requestSummary,
            readyForProposal: match.readiness.readyForProposal,
            blocking: match.readiness.blocking.map((item) => item.message),
            optional: match.readiness.optional.map((item) => item.message),
          },
        },
        sources: [
          source(match.lead.id, "lead", match.lead.opportunityName, `/leads/${match.lead.id}`),
        ],
        links: [link("Open lead record", `/leads/${match.lead.id}`)],
        requiredPermissions: [PERMISSIONS.LEADS_VIEW],
      },
    };
  }

  if (intent.type === "search" && intent.term) {
    if (!(await can(runtime, userId, PERMISSIONS.SEARCH_VIEW))) {
      throw new AccessDeniedError("permission-not-granted");
    }
    const types = await allowedSearchTypes(runtime, userId);
    const taskReadScope = await runtime.authorization.taskReadScopeForUser(userId);
    const results = await runtime.phase1.searchKeyword(intent.term, {
      types,
      limit: 50,
      ...(taskReadScope !== "all" && types.includes("task") ? { taskAssigneeUserId: userId } : {}),
    });
    return {
      content: `Permission-aware keyword search returned ${results.length} result${results.length === 1 ? "" : "s"} for “${intent.term}”.`,
      artifact: listArtifact({
        type: "search-results",
        title: `Search: ${intent.term}`,
        subtitle: "Unauthorized entity types were excluded before the database query",
        items: results.map((result) => ({
          id: result.id,
          title: result.title,
          subtitle: `${result.type} · ${result.subtitle}`,
          href: result.href,
          status: result.type,
        })),
        sources: results.map((result) => source(result.id, result.type, result.title, result.href)),
        permission: PERMISSIONS.SEARCH_VIEW,
        additionalPermissions: [
          ...new Set(
            results.map((result) => {
              const permissionByType: Record<Phase1SearchResult["type"], Permission> = {
                company: PERMISSIONS.COMPANIES_VIEW,
                contact: PERMISSIONS.CONTACTS_VIEW,
                task: PERMISSIONS.TASKS_VIEW,
                lead: PERMISSIONS.LEADS_VIEW,
                integration: PERMISSIONS.INTEGRATIONS_VIEW,
                "workflow-run": PERMISSIONS.WORKFLOW_VIEW,
              };
              return permissionByType[result.type];
            }),
          ),
        ],
      }),
    };
  }

  if (intent.type === "integration-health" || intent.type === "disconnected-systems") {
    if (!(await can(runtime, userId, PERMISSIONS.AI_INTEGRATION_HEALTH_VIEW))) {
      throw new AccessDeniedError("permission-not-granted");
    }
    const connections = await runtime.repository.listIntegrationConnections();
    const filtered =
      intent.type === "disconnected-systems"
        ? connections.filter((connection) => connection.connectionStatus !== "connected")
        : connections;
    return {
      content: `All ${connections.length} provider entries are simulated and none is live-connected. No external system was contacted.`,
      artifact: listArtifact({
        type: "integration-health-summary",
        title:
          intent.type === "disconnected-systems" ? "Systems not connected" : "Connector health",
        subtitle: "SIMULATED provider registry — zero live connections",
        items: filtered.map((connection) => ({
          id: connection.id,
          title: connection.displayName,
          subtitle: `${connection.providerType} · ${connection.requirementStatus}`,
          status: connection.connectionStatus,
          href: `/integrations/${encodeURIComponent(connection.providerType)}`,
        })),
        permission: PERMISSIONS.AI_INTEGRATION_HEALTH_VIEW,
      }),
    };
  }

  if (intent.type === "workflow-run-list" || intent.type === "workflow-run-latest") {
    if (!(await can(runtime, userId, PERMISSIONS.WORKFLOW_VIEW))) {
      throw new AccessDeniedError("permission-not-granted");
    }
    const runs = await runtime.phase1.listWorkflowRuns({
      limit: intent.type === "workflow-run-latest" ? 1 : 25,
    });
    const items = runs.map((run) => ({
      id: run.id,
      title: run.workflowKey,
      subtitle: new Date(run.startedAt).toLocaleString("en-US"),
      status: run.status,
      href: `/workflow-runs/${run.id}`,
    }));
    return {
      content: `I found ${runs.length} authorized persisted workflow run${runs.length === 1 ? "" : "s"}.`,
      artifact:
        intent.type === "workflow-run-latest" && items[0]
          ? {
              type: "workflow-run-detail",
              title: "Latest workflow run",
              subtitle: "Persisted local workflow evidence",
              state: "ready",
              payload: { record: items[0] },
              sources: runs.map((run) =>
                source(run.id, "workflow-run", run.workflowKey, `/workflow-runs/${run.id}`),
              ),
              links: [link("Open workflow run", items[0].href)],
              requiredPermissions: [PERMISSIONS.WORKFLOW_VIEW],
            }
          : listArtifact({
              type: "workflow-run-list",
              title:
                intent.type === "workflow-run-latest"
                  ? "Latest workflow run"
                  : "Recent workflow runs",
              subtitle: "Persisted local workflow evidence",
              items,
              sources: runs.map((run) =>
                source(run.id, "workflow-run", run.workflowKey, `/workflow-runs/${run.id}`),
              ),
              permission: PERMISSIONS.WORKFLOW_VIEW,
            }),
    };
  }

  if (intent.type === "help") {
    return {
      content:
        "I can query authorized Phase 1 records and Phase 2.0 leads, explain deterministic missing-information results, and prepare one confirmation-gated internal task. I cannot create or change a lead, change lead status, send email, or create a proposal. Live AI, voice, semantic retrieval, and external actions are not connected.",
      artifact: {
        type: "help",
        title: "AI Command capabilities",
        subtitle: "Implemented interface · simulated provider · no live connection",
        payload: { commands: [...HELP_COMMANDS] },
        requiredPermissions: [PERMISSIONS.AI_COMMAND_VIEW],
      },
    };
  }

  return {
    content:
      "That capability is not implemented in the Phase 1 deterministic demo. I did not contact a live model or perform an action. Try one of the supported commands in the workspace.",
    artifact: {
      type: "help",
      title: "Capability planned",
      subtitle: "This request is outside the supported Phase 1 command set",
      payload: { commands: [...HELP_COMMANDS], unsupportedRequest: input },
      requiredPermissions: [PERMISSIONS.AI_COMMAND_VIEW],
    },
  };
}

function taskRelationshipErrorTurn(
  field: "companyId" | "contactId",
  title: string,
  message: string,
): AssistantTurn {
  return {
    content: `${message} No action preview or task was created.`,
    artifact: {
      type: "error",
      title,
      subtitle: "Correct the company and contact relationship, then try again",
      state: "failed",
      payload: { field, message, actionable: false },
      requiredPermissions: [PERMISSIONS.AI_COMMAND_VIEW],
      errorCode: "TASK_RELATIONSHIP_INVALID",
    },
  };
}

async function routeTaskPreview(
  runtime: BeaServerRuntime,
  userId: string,
  conversationId: string,
  input: string,
  correlationId: string,
  requestId: string,
  generation: number,
): Promise<AssistantTurn> {
  const intent = routeDemoCommand(input);
  if (intent.type !== "create-task" || !intent.taskDraft)
    return routeReadIntent(runtime, userId, input, conversationId);
  await runtime.authorization.requireUser({
    userId,
    permission: PERMISSIONS.TASKS_VIEW,
    action: "ai-command.task.preview",
    resourceType: "conversation",
    resourceId: conversationId,
    correlationId,
  });
  const draft = intent.taskDraft;
  if (!draft.title) {
    return {
      content:
        "Please provide a task title. You may also include a description, assignee, due date, company, or contact. No task has been created.",
      artifact: {
        type: "help",
        title: "Task title required",
        subtitle: "No action preview or write was created",
        payload: {
          commands: [
            'Create an internal task titled "Review field notes" assigned to Operations due tomorrow',
          ],
        },
        requiredPermissions: [PERMISSIONS.AI_COMMAND_VIEW],
      },
    };
  }

  const persona = draft.assignee
    ? DEMO_PERSONAS.find((candidate) => {
        const term = draft.assignee?.toLocaleLowerCase("en-US") ?? "";
        return (
          candidate.displayName.toLocaleLowerCase("en-US").includes(term) ||
          candidate.title.toLocaleLowerCase("en-US").includes(term)
        );
      })
    : undefined;
  const [canViewCompanies, canViewContacts, canViewLeads] = await Promise.all([
    can(runtime, userId, PERMISSIONS.COMPANIES_VIEW),
    can(runtime, userId, PERMISSIONS.CONTACTS_VIEW),
    can(runtime, userId, PERMISSIONS.LEADS_VIEW),
  ]);
  let company: Company | null = null;
  if (draft.companyName) {
    if (!canViewCompanies) {
      return taskRelationshipErrorTurn(
        "companyId",
        "Company unavailable",
        "The requested company is not available to the acting role.",
      );
    }
    company = await exactCompany(runtime, draft.companyName);
    if (!company) {
      return taskRelationshipErrorTurn(
        "companyId",
        "Company not found",
        `No exact company match was found for “${draft.companyName}”.`,
      );
    }
  }

  let contact: Contact | null = null;
  if (draft.contactName) {
    if (!company) {
      return taskRelationshipErrorTurn(
        "contactId",
        "Select a company first",
        "A company is required before a contact can be linked.",
      );
    }
    if (!canViewContacts) {
      return taskRelationshipErrorTurn(
        "contactId",
        "Contact unavailable",
        "The requested contact is not available to the acting role.",
      );
    }
    const contacts = await runtime.phase1.listContacts({
      companyId: company.id,
      query: draft.contactName,
      limit: 20,
    });
    contact =
      contacts.find(
        (item) =>
          `${item.firstName} ${item.lastName}`.toLocaleLowerCase("en-US") ===
          draft.contactName?.toLocaleLowerCase("en-US"),
      ) ?? null;
    if (!contact) {
      return taskRelationshipErrorTurn(
        "contactId",
        "Contact does not match company",
        `No exact contact match for “${draft.contactName}” belongs to ${company.name}.`,
      );
    }
  }

  let leadId: string | null = null;
  let leadLabel: string | null = null;
  if (draft.leadTerm) {
    if (!canViewLeads) {
      return {
        content:
          "The requested lead is not available to the acting role. No action preview or task was created.",
        artifact: {
          type: "error",
          title: "Lead unavailable",
          subtitle: "Correct the lead reference, then try again",
          state: "failed",
          payload: {
            message: "The requested lead is not available to the acting role.",
            actionable: false,
          },
          requiredPermissions: [PERMISSIONS.AI_COMMAND_VIEW],
          errorCode: "LEAD_UNAUTHORIZED",
        },
      };
    }
    const leadMatch = await resolveAuthorizedLead(runtime, draft.leadTerm);
    if (!leadMatch) {
      return {
        content: `No authorized lead matched “${draft.leadTerm}”. No action preview or task was created.`,
        artifact: {
          type: "error",
          title: "Lead not found",
          subtitle: "Correct the lead reference, then try again",
          state: "failed",
          payload: {
            message: `No authorized lead matched “${draft.leadTerm}”.`,
            actionable: false,
          },
          requiredPermissions: [PERMISSIONS.AI_COMMAND_VIEW],
          errorCode: "LEAD_NOT_FOUND",
        },
      };
    }
    leadId = leadMatch.lead.id;
    leadLabel = `${leadMatch.lead.reference} ${leadMatch.lead.opportunityName}`;
  }
  const dueAt = resolveDemoDueDate(draft.dueDate);
  const actionId = randomUUID();
  const artifactPermissions: Permission[] = [
    PERMISSIONS.AI_COMMAND_VIEW,
    PERMISSIONS.TASKS_VIEW,
    ...(company ? [PERMISSIONS.COMPANIES_VIEW] : []),
    ...(contact ? [PERMISSIONS.CONTACTS_VIEW] : []),
    ...(leadId ? [PERMISSIONS.LEADS_VIEW] : []),
  ];
  const requiredPermissions: Permission[] = [
    ...artifactPermissions,
    PERMISSIONS.TASK_ACTION_EXECUTE,
  ];
  const actionPayload: JsonObject = {
    actionLevel: 3,
    requestId,
    previewConversationVersion: generation + 1,
    requiredPermissions,
    title: draft.title,
    description: draft.description,
    priority: "normal",
    assigneeUserId: persona?.id ?? userId,
    dueAt,
    companyId: company?.id ?? null,
    contactId: contact?.id ?? null,
    leadId,
  };
  const suggestedAction: AssistantTurn["suggestedAction"] = {
    id: actionId,
    actionType: "task.create",
    payload: actionPayload,
    requiredPermission: PERMISSIONS.TASK_ACTION_EXECUTE,
    idempotencyKey: `ai-task-preview:${requestId}`,
    correlationId,
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  };
  const canExecute = await can(runtime, userId, PERMISSIONS.TASK_ACTION_EXECUTE);
  const actingUser = await runtime.repository.findActiveUserById(userId);
  return {
    content:
      "I prepared an internal task preview from authorized demo context. Review the exact fields and explicitly confirm if your role permits execution. No task has been created yet.",
    artifact: {
      type: "action-preview",
      title: "Create internal task",
      subtitle: "Action Level 3 · explicit confirmation required",
      payload: {
        actionId,
        executable: canExecute,
        requiredPermission: suggestedAction.requiredPermission,
        actingUser: actingUser?.displayName ?? userId,
        fields: {
          title: draft.title,
          description: draft.description,
          assignee: persona?.displayName ?? actingUser?.displayName ?? userId,
          dueAt,
          company: company?.name ?? null,
          contact: contact ? `${contact.firstName} ${contact.lastName}` : null,
          lead: leadLabel,
          priority: "normal",
        },
      },
      sources: [
        ...(company
          ? [source(company.id, "company", company.name, `/companies/${company.id}`)]
          : []),
        ...(contact
          ? [
              source(
                contact.id,
                "contact",
                `${contact.firstName} ${contact.lastName}`,
                `/contacts/${contact.id}`,
              ),
            ]
          : []),
        ...(leadId && leadLabel ? [source(leadId, "lead", leadLabel, `/leads/${leadId}`)] : []),
      ],
      links: [],
      requiredPermissions: artifactPermissions,
    },
    suggestedAction,
  };
}

export interface ProcessAiCommandMessageInput {
  userId: string;
  conversationId: string;
  message: string;
  requestId: string;
  generation: number;
  correlationId?: string;
  workspaceSelection?: unknown;
}

export interface ReserveAiCommandRequestInput {
  userId: string;
  conversationId: string;
  correlationId?: string;
}

export interface AiCommandRequestReservation {
  requestId: string;
  generation: number;
}

function personalizeInternalTurn(
  assistant: Awaited<ReturnType<typeof getAssistantPolicyContext>>,
  request: string,
  content: string,
): string {
  if (assistant.persona.kind !== "executive-business-partner") return content;
  const preferredName = assistant.persona.preferredName ?? "Owner";
  if (isProtectedAssistantPolicyRequest(request)) {
    return `${preferredName}, I can’t reveal or disable protected instructions or private profile data. I can still help with the authorized business objective.`;
  }
  if (/cycl|bike|trail|mountain biking|outdoor recreation/iu.test(request)) {
    return `${preferredName}, I can use your approved cycling and outdoor-recreation context when it is relevant. ${content}`;
  }
  return `${preferredName}, my recommendation is to turn this authorized view into one clear owner and next checkpoint. ${content}`;
}

export async function reserveAiCommandRequest(
  input: ReserveAiCommandRequestInput,
): Promise<AiCommandRequestReservation> {
  return reserveAiCommandRequestWithRuntime(await getServerRuntime(), input);
}

export async function reserveAiCommandRequestWithRuntime(
  runtime: BeaServerRuntime,
  input: ReserveAiCommandRequestInput,
): Promise<AiCommandRequestReservation> {
  const reservation = await runtime.phase1.reserveAiCommandRequest({
    conversationId: input.conversationId,
    ownerUserId: input.userId,
    correlationId: input.correlationId ?? createCorrelationId(),
  });
  return { requestId: reservation.requestId, generation: reservation.generation };
}

export async function processAiCommandMessage(
  input: ProcessAiCommandMessageInput,
): Promise<AiCommandSnapshot> {
  const runtime = await getServerRuntime();
  if (!(await isDeterministicDemoAiCommandAllowed(runtime))) {
    throw new Phase1ValidationError(
      "The deterministic AI Command fallback is available only in explicit Demo Mode.",
    );
  }
  return processAiCommandMessageWithRuntime(runtime, input);
}

export async function processAiCommandMessageWithRuntime(
  runtime: BeaServerRuntime,
  input: ProcessAiCommandMessageInput,
): Promise<AiCommandSnapshot> {
  const conversation = await runtime.phase1.getConversation(input.conversationId, input.userId);
  if (!conversation) throw new Phase1OwnershipError();
  const normalized = input.message.replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > 2_000) {
    throw new Error("AI Command messages must contain between 1 and 2,000 characters.");
  }
  requireCredentialSafeContent(normalized);
  const correlationId = input.correlationId ?? createCorrelationId();
  const requestId = normalizeAiCommandRequestId(input.requestId);
  const generation = normalizeAiCommandRequestGeneration(input.generation);
  const request = await runtime.phase1.beginAiCommandRequest({
    requestId,
    generation,
    conversationId: conversation.id,
    ownerUserId: input.userId,
    content: normalized,
    correlationId,
  });
  if (request.status === "superseded") {
    return buildSnapshot(runtime, input.userId, conversation.id);
  }
  const startedAt = performance.now();
  const assistantPolicy = await getAssistantPolicyContext(runtime, input.userId);
  const selection = parseSafeWorkspaceSelection(input.workspaceSelection);
  const latestPresentation = await runtime.ai.persistence.getLatestPresentationRunForConversation(
    conversation.id,
    input.userId,
  );
  const latestPacket = latestPresentation
    ? presentationPacketFromStoredRun(latestPresentation.packet)
    : null;
  let turn: AssistantTurn;
  if (
    selection?.kind === "lead" &&
    selection.recordId &&
    /\b(?:full record|open (?:the )?(?:full )?record|show me (?:the )?(?:full )?record)\b/iu.test(
      normalized,
    )
  ) {
    turn = await routeReadIntent(
      runtime,
      input.userId,
      `Open lead ${selection.recordId}`,
      conversation.id,
    );
  } else if (selection && latestPacket && isFollowUpAboutSelection(normalized)) {
    const authorized = authorizeWorkspaceSelection({
      latest: latestPacket,
      selection,
      conversationOwnerUserId: conversation.ownerUserId,
      actingUserId: input.userId,
      permissionsAllowed: true,
      runVisualArtifactId: latestPresentation?.visualArtifactId,
    });
    if (!authorized.ok || !authorized.selection) {
      throw new OpenAiAdministrationError(
        authorized.ok ? "PRESENTATION_SELECTION_MISMATCH" : authorized.code,
        authorized.ok ? 409 : authorized.status,
        authorized.ok
          ? "The workspace selection is not part of this presentation."
          : authorized.message,
      );
    }
    const evidence = buildSelectedEvidenceContext(latestPacket, authorized.selection);
    if (!evidence) {
      throw new OpenAiAdministrationError(
        "PRESENTATION_SELECTION_MISMATCH",
        409,
        "The workspace selection is not part of this presentation.",
      );
    }
    const selectedPacket = applyWorkspaceSelection(latestPacket, authorized.selection);
    const answer = answerFromSelectedContext(selectedPacket, authorized.selection, normalized);
    turn =
      selectedPacket.routeKey === "record_retrieval"
        ? {
            content: answer,
            artifact: listArtifact({
              type: "lead-list",
              title: selectedPacket.title,
              subtitle: "Demonstration BEA records · not live business data",
              items: selectedPacket.findings.map((finding) => {
                const recordId = finding.id.startsWith("lead-")
                  ? finding.id.slice("lead-".length)
                  : finding.id;
                return {
                  id: recordId,
                  title: finding.title,
                  subtitle: finding.body,
                  href: `/leads/${recordId}`,
                };
              }),
              sources: selectedPacket.sources.map((sourceItem) =>
                source(sourceItem.id, "lead", sourceItem.title, `/leads/${sourceItem.id}`),
              ),
              permission: PERMISSIONS.LEADS_VIEW,
              presentation: selectedPacket as unknown as JsonObject,
            }),
          }
        : {
            content: answer,
            artifact: {
              type: "help",
              title: selectedPacket.title,
              subtitle: selectedPacket.liveWebSearch
                ? `LIVE WEB RESEARCH · ${selectedPacket.model}`
                : "SIMULATED WEB RESEARCH · not live web research",
              state: "ready",
              payload: {
                ...researchWorkspacePayload(selectedPacket),
                presentation: selectedPacket as unknown as JsonObject,
              },
              sources: selectedPacket.sources.map((sourceItem) =>
                source(
                  sourceItem.id,
                  sourceItem.domain === "command-center" ? "lead" : "web-source",
                  sourceItem.title,
                  sourceItem.url,
                ),
              ),
              links: selectedPacket.sources
                .slice(0, 10)
                .map((sourceItem) => link(`Source ${sourceItem.number}`, sourceItem.url)),
              requiredPermissions: [...selectedPacket.requiredPermissions],
            },
          };
  } else {
    const intent = routeDemoCommand(normalized);
    turn =
      intent.type === "create-task"
        ? await routeTaskPreview(
            runtime,
            input.userId,
            conversation.id,
            normalized,
            correlationId,
            request.requestId,
            request.generation,
          )
        : await routeReadIntent(runtime, input.userId, normalized, conversation.id);
  }
  const executionMs = Math.max(0, Math.round(performance.now() - startedAt));
  await runtime.phase1.finalizeAiCommandRequest({
    conversationId: conversation.id,
    ownerUserId: input.userId,
    generation: request.generation,
    assistantMessage: {
      content: personalizeInternalTurn(assistantPolicy, normalized, turn.content),
      correlationId,
      routerVersion: DEMO_ROUTER_VERSION,
      executionMs,
    },
    workspaceArtifact: turn.artifact,
    suggestedAction: turn.suggestedAction,
  });
  const snapshot = await buildSnapshot(runtime, input.userId, conversation.id);
  await persistPresentationPacketWithRuntime(runtime, {
    userId: input.userId,
    conversationId: conversation.id,
    payload: snapshot.artifact.payload,
    visualArtifactId: snapshot.artifact.id,
    assistantMessageId: snapshot.messages.at(-1)?.id ?? null,
    initiatingUserMessageId:
      [...snapshot.messages].reverse().find((message) => message.role === "user")?.id ?? null,
  });
  return snapshot;
}

export async function persistPresentationPacketWithRuntime(
  runtime: BeaServerRuntime,
  input: {
    readonly userId: string;
    readonly conversationId: string;
    readonly payload: unknown;
    readonly visualArtifactId: string;
    readonly assistantMessageId?: string | null;
    readonly responseRunId?: string | null;
    readonly realtimeSessionId?: string | null;
    readonly initiatingUserMessageId?: string | null;
  },
): Promise<void> {
  const packet = parsePresentationFromPayload(input.payload);
  if (!packet) return;
  const latestPresentation = await runtime.ai.persistence.getLatestPresentationRunForConversation(
    input.conversationId,
    input.userId,
  );
  const persisted = {
    ...packet,
    conversationId: input.conversationId,
    visualArtifactId: input.visualArtifactId,
    assistantMessageId: input.assistantMessageId ?? packet.assistantMessageId,
    initiatingUserMessageId: input.initiatingUserMessageId ?? packet.initiatingUserMessageId,
    responseRunId: input.responseRunId ?? null,
    realtimeSessionId: input.realtimeSessionId ?? null,
  };
  if (latestPresentation?.id === packet.presentationRunId) {
    await runtime.ai.persistence.updatePresentationSelection({
      id: packet.presentationRunId,
      actingUserId: input.userId,
      selectedContext: (packet.selected ?? null) as unknown as JsonObject | null,
      autoFollow: packet.autoFollow,
      status: packet.status,
    });
    await runtime.ai.persistence.updatePresentationRunLifecycle({
      id: packet.presentationRunId,
      actingUserId: input.userId,
      realtimeSessionId: input.realtimeSessionId,
      initiatingUserMessageId: input.initiatingUserMessageId,
      assistantMessageId: input.assistantMessageId,
      responseRunId: input.responseRunId,
      visualArtifactId: input.visualArtifactId,
      providerResponseId: packet.providerResponseId,
      lastCompletedNarrationSegmentId: packet.lastCompletedNarrationSegmentId ?? null,
      packet: persisted as unknown as JsonObject,
    });
    return;
  }
  await runtime.ai.persistence.recordPresentationRun({
    id: packet.presentationRunId,
    conversationId: input.conversationId,
    actingUserId: input.userId,
    routeKey: packet.routeKey,
    provider: packet.provider,
    model: packet.model,
    providerResponseId: packet.providerResponseId,
    status: packet.status,
    query: packet.query,
    packet: persisted as unknown as JsonObject,
    selectedContext: (packet.selected ?? null) as unknown as JsonObject | null,
    autoFollow: packet.autoFollow,
    simulated: packet.simulated,
    liveWebSearch: packet.liveWebSearch,
    requiredPermissions: packet.requiredPermissions,
    usageMetadata: (packet.usage ?? {}) as JsonObject,
    errorCode: packet.error?.code ?? null,
    errorMessage: packet.error?.safeMessage ?? null,
    startedAt: packet.startedAt,
    completedAt: packet.completedAt,
    visualArtifactId: input.visualArtifactId,
    responseRunId: input.responseRunId ?? null,
    realtimeSessionId: input.realtimeSessionId ?? null,
    initiatingUserMessageId: input.initiatingUserMessageId ?? packet.initiatingUserMessageId,
    assistantMessageId: input.assistantMessageId ?? null,
  });
}

export async function confirmAiTaskAction(input: {
  userId: string;
  actionId: string;
  correlationId?: string;
}): Promise<AiCommandSnapshot> {
  return confirmAiTaskActionWithRuntime(await getServerRuntime(), input);
}

export async function confirmAiTaskActionWithRuntime(
  runtime: BeaServerRuntime,
  input: {
    userId: string;
    actionId: string;
    correlationId?: string;
  },
): Promise<AiCommandSnapshot> {
  const correlationId = input.correlationId ?? createCorrelationId();
  const action = await runtime.phase1.getSuggestedAction(input.actionId, input.userId);
  if (!action) throw new Phase1OwnershipError();
  const conversation = await runtime.phase1.getConversation(action.conversationId, input.userId);
  if (!conversation) throw new Phase1OwnershipError();
  const previewConversationVersion = action.payload.previewConversationVersion;
  const expectedConversationVersion =
    typeof previewConversationVersion === "number" &&
    Number.isSafeInteger(previewConversationVersion) &&
    previewConversationVersion >= 1
      ? previewConversationVersion
      : conversation.version;
  const requiredPermissions = taskActionPermissions(action);
  const authorizationDecisions = await Promise.all(
    requiredPermissions.map(async (permission) => ({
      permission,
      decision: await runtime.authorization.authorizeUser(input.userId, permission),
    })),
  );
  const denied = authorizationDecisions.find(({ decision }) => !decision.allowed);
  if (denied && !denied.decision.allowed) {
    await runtime.repository.record({
      eventType: "authorization.denied",
      action: "ai-command.task-action.execute",
      outcome: "denied",
      actorUserId: input.userId,
      resourceType: "suggested-action",
      resourceId: action.id,
      correlationId,
      metadata: { permission: denied.permission, reason: denied.decision.reason },
    });
    throw new AccessDeniedError(denied.decision.reason);
  }
  const checkedAt = new Date().toISOString();
  const permissionRevalidations = requiredPermissions.map((permission) => ({
    permission,
    allowed: true as const,
    checkedAt,
  }));
  const taskActionRevalidation = permissionRevalidations.find(
    ({ permission }) => permission === PERMISSIONS.TASK_ACTION_EXECUTE,
  );
  if (!taskActionRevalidation) {
    throw new Phase1ValidationError("Task action execution permission is required.");
  }
  const result = await runtime.phase1.approveAndExecuteTaskAction({
    suggestedActionId: action.id,
    actorUserId: input.userId,
    confirmation: TASK_ACTION_CONFIRMATION,
    permissionRevalidation: taskActionRevalidation,
    additionalPermissionRevalidations: permissionRevalidations.filter(
      ({ permission }) => permission !== PERMISSIONS.TASK_ACTION_EXECUTE,
    ),
    idempotencyKey: `ai-task-execution:${action.id}`,
    correlationId,
    executedAt: checkedAt,
  });
  await runtime.phase1.presentTaskActionExecution({
    conversationId: action.conversationId,
    ownerUserId: input.userId,
    expectedConversationVersion,
    executionId: result.execution.id,
    taskId: result.task.id,
    taskTitle: result.task.title,
    correlationId: result.execution.correlationId,
  });
  return buildSnapshot(runtime, input.userId, action.conversationId);
}
