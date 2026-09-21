import { assertLegacyRuntimeTestOnly } from "@bea/config";
import {
  DEFAULT_DIGITAL_WORKFORCE_RUNTIME_POLICY,
  DIGITAL_WORKFORCE_CONTRACT_VERSION,
  DIGITAL_WORKFORCE_MODEL_PROFILE_ROUTES,
  DEMO_PERSONAS,
  SEEDED_DIGITAL_WORKFORCE_IDS,
  hashAgentVersionConfiguration,
  type DigitalWorkforceAgentVersion,
  type DigitalWorkforceDataScopeGrant,
  type DigitalWorkforceKnowledgeScopeGrant,
  type DigitalWorkforceModelAssignment,
  type DigitalWorkforceModelProfile,
  type DigitalWorkforceRegisteredTool,
  type DigitalWorkforceToolGrant,
  type RoleId,
} from "@bea/domain";
import type { SqlExecutor } from "./adapter.js";

const DEMO_SEED_TIMESTAMP = "2026-01-01T00:00:00.000Z";

const ownerId = DEMO_PERSONAS[0].id;
const ids = SEEDED_DIGITAL_WORKFORCE_IDS;

function modelAssignment(
  profile: DigitalWorkforceModelProfile,
  reasoningEffort: DigitalWorkforceModelAssignment["reasoningEffort"],
  costClass: DigitalWorkforceModelAssignment["costClass"],
  capabilities: readonly string[],
): DigitalWorkforceModelAssignment {
  return {
    profile,
    provider: "openai",
    primaryModel: "unconfigured",
    fallbackModel: "unconfigured",
    routeKey: DIGITAL_WORKFORCE_MODEL_PROFILE_ROUTES[profile],
    reasoningEffort,
    requiredCapabilities: capabilities,
    costClass,
    capabilityEvidenceVersion: null,
    verifiedAt: null,
  };
}

function tool(
  toolName: DigitalWorkforceRegisteredTool,
  allowedEffect: DigitalWorkforceToolGrant["allowedEffect"],
  maximumCallsPerRun: number,
  approvalRequired = false,
): DigitalWorkforceToolGrant {
  return {
    toolName,
    enabled: true,
    allowedEffect,
    approvalRequired,
    maximumCallsPerRun,
    toolPolicyVersion: DIGITAL_WORKFORCE_CONTRACT_VERSION,
  };
}

function data(
  scopes: readonly DigitalWorkforceDataScopeGrant["scope"][],
): DigitalWorkforceDataScopeGrant[] {
  return scopes.map((scope) => ({ scope, enabled: true, recordIds: [] }));
}

function knowledge(
  connected: readonly DigitalWorkforceKnowledgeScopeGrant["scope"][],
  disconnected: readonly {
    readonly scope: DigitalWorkforceKnowledgeScopeGrant["scope"];
    readonly disclosure: string;
  }[],
): DigitalWorkforceKnowledgeScopeGrant[] {
  return [
    ...connected.map((scope) => ({
      scope,
      connectionState: "connected" as const,
      collectionId: null,
      disclosure:
        scope === "public-web"
          ? "Public Web is connected when the owner-authorized OpenAI Web Search route is verified."
          : "Uses the current authorized BEA conversation and structured records.",
    })),
    ...disconnected.map((item) => ({
      scope: item.scope,
      connectionState: "not-connected" as const,
      collectionId: null,
      disclosure: item.disclosure,
    })),
  ];
}

interface SeededAgent {
  readonly id: string;
  readonly versionId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly roleTitle: string;
  readonly shortDescription: string;
  readonly departmentId: string;
  readonly teamId: string;
  readonly supportedHumanUserId: string | null;
  readonly status: "active" | "paused";
  readonly avatar: DigitalWorkforceAgentVersion extends never
    ? never
    : import("@bea/domain").DigitalAgentAvatar;
  readonly supervisorAgentId: string | null;
  readonly preferredHandoffAgentIds: readonly string[];
  readonly availableToRoleIds: readonly RoleId[];
  readonly persona: string;
  readonly roleDefinition: string;
  readonly goals: readonly string[];
  readonly successCriteria: readonly string[];
  readonly model: DigitalWorkforceModelAssignment;
  readonly tools: readonly DigitalWorkforceToolGrant[];
  readonly dataScopes: readonly DigitalWorkforceDataScopeGrant[];
  readonly knowledgeScopes: readonly DigitalWorkforceKnowledgeScopeGrant[];
  readonly approvalPolicy: DigitalWorkforceAgentVersion["approvalPolicy"];
  readonly escalationInstructions: string;
}

const departments = [
  {
    id: ids.departments.executiveOffice,
    name: "Executive Office",
    slug: "executive-office",
    description: "Application-owned executive orchestration for Cyber Pirate Labs.",
    order: 1,
  },
  {
    id: ids.departments.revenue,
    name: "Revenue and Client Development",
    slug: "revenue-client-development",
    description: "Lead review and proposal-preparation Digital Agents.",
    order: 2,
  },
  {
    id: ids.departments.research,
    name: "Research and Knowledge",
    slug: "research-knowledge",
    description: "Public research and authorized BEA record synthesis.",
    order: 3,
  },
  {
    id: ids.departments.operations,
    name: "Operations",
    slug: "operations",
    description: "Project readiness inspection. Scheduling remains not connected.",
    order: 4,
  },
  {
    id: ids.departments.documents,
    name: "Document and Communications",
    slug: "document-communications",
    description: "BEA-branded executive document specialists.",
    order: 5,
  },
] as const;

const teams = [
  {
    id: ids.teams.executivePartnership,
    departmentId: ids.departments.executiveOffice,
    name: "Executive Partnership",
    slug: "executive-partnership",
    lead: ids.agents.andrewExecutive,
    order: 1,
  },
  {
    id: ids.teams.clientDevelopment,
    departmentId: ids.departments.revenue,
    name: "Client Development",
    slug: "client-development",
    lead: ids.agents.revenueManager,
    order: 2,
  },
  {
    id: ids.teams.publicResearch,
    departmentId: ids.departments.research,
    name: "Public Research",
    slug: "public-research",
    lead: ids.agents.researchManager,
    order: 3,
  },
  {
    id: ids.teams.beaKnowledge,
    departmentId: ids.departments.research,
    name: "BEA Knowledge",
    slug: "bea-knowledge",
    lead: ids.agents.researchManager,
    order: 4,
  },
  {
    id: ids.teams.projectReadiness,
    departmentId: ids.departments.operations,
    name: "Project Readiness",
    slug: "project-readiness",
    lead: ids.agents.operationsManager,
    order: 5,
  },
  {
    id: ids.teams.scheduling,
    departmentId: ids.departments.operations,
    name: "Scheduling",
    slug: "scheduling",
    lead: ids.agents.operationsManager,
    order: 6,
  },
  {
    id: ids.teams.executiveDocuments,
    departmentId: ids.departments.documents,
    name: "Executive Documents",
    slug: "executive-documents",
    lead: ids.agents.documentManager,
    order: 7,
  },
] as const;

const agents: readonly SeededAgent[] = [
  {
    id: ids.agents.andrewExecutive,
    versionId: ids.versions.andrewExecutive,
    slug: "andrew-executive-business-partner",
    displayName: "Owner Executive Business Partner",
    roleTitle: "Executive Business Partner — Digital Agent",
    shortDescription: "Top-level executive orchestration Digital Agent. Not a human employee.",
    departmentId: ids.departments.executiveOffice,
    teamId: ids.teams.executivePartnership,
    supportedHumanUserId: ownerId,
    status: "active",
    avatar: "executive",
    supervisorAgentId: null,
    preferredHandoffAgentIds: [
      ids.agents.revenueManager,
      ids.agents.researchManager,
      ids.agents.operationsManager,
      ids.agents.documentManager,
      ids.agents.leadReview,
      ids.agents.publicResearch,
      ids.agents.executiveDocument,
    ],
    availableToRoleIds: ["owner-admin", "executive-readonly"],
    persona:
      "You are the Owner Executive Business Partner Digital Agent for Cyber Pirate Labs. You receive owner goals, create bounded execution plans, delegate to approved Digital Agents, and summarize evidence. You never expand permissions, send email, change calendars, approve commercial work, mutate leads, or execute external system changes.",
    roleDefinition:
      "Executive orchestration Digital Agent. Application-owned identity. Not a security principal.",
    goals: [
      "Turn owner goals into bounded multi-agent plans",
      "Delegate lead review, public research, and document work",
      "Return an evidence-backed executive summary",
    ],
    successCriteria: [
      "Plan uses only active published agents",
      "Handoffs stay inside approved collaborators",
      "Final summary cites records, sources, and artifacts",
    ],
    model: modelAssignment("executive-premium", "medium", "high", ["responsesText", "streaming"]),
    tools: [
      tool("bea_list_agents", "read", 4),
      tool("bea_get_agent", "read", 8),
      tool("bea_get_agent_run", "read", 8),
      tool("bea_show_digital_workforce", "read", 4),
      tool("bea_show_agent_run", "read", 4),
      tool("bea_delegate_to_agent", "preview", 8),
      tool("bea_query_records", "read", 4),
      tool("bea_list_artifacts", "read", 4),
      tool("bea_open_artifact", "read", 4),
      tool("bea_create_pdf", "preview", 1, true),
      tool("bea_preview_task", "preview", 1, true),
      tool("bea_cancel_agent_run", "preview", 1, true),
    ],
    dataScopes: data([
      "leads",
      "companies",
      "contacts",
      "tasks",
      "activities",
      "artifacts",
      "research-presentations",
      "current-conversation",
    ]),
    knowledgeScopes: knowledge(
      ["current-conversation", "authorized-bea-records", "public-web"],
      [
        {
          scope: "organizational-file-search",
          disclosure: "Organizational knowledge sources not connected",
        },
      ],
    ),
    approvalPolicy: "confirmation-required",
    escalationInstructions:
      "Escalate commercial, email, calendar, and permission changes to the owner.",
  },
  {
    id: ids.agents.revenueManager,
    versionId: ids.versions.revenueManager,
    slug: "revenue-client-development-manager",
    displayName: "Revenue and Client Development Manager",
    roleTitle: "Department Manager — Digital Agent",
    shortDescription: "Supervises lead review and proposal-preparation Digital Agents.",
    departmentId: ids.departments.revenue,
    teamId: ids.teams.clientDevelopment,
    supportedHumanUserId: DEMO_PERSONAS[1].id,
    status: "active",
    avatar: "manager",
    supervisorAgentId: ids.agents.andrewExecutive,
    preferredHandoffAgentIds: [
      ids.agents.leadReview,
      ids.agents.proposalPrep,
      ids.agents.andrewExecutive,
    ],
    availableToRoleIds: ["owner-admin", "executive-readonly", "sales"],
    persona:
      "You are a Digital Agent manager for revenue work. You coordinate Lead Review and Proposal Preparation specialists. You do not change lead status or contact clients.",
    roleDefinition: "Revenue department manager Digital Agent.",
    goals: ["Coordinate lead analysis", "Keep proposal work as preparation only"],
    successCriteria: ["Specialists return structured findings", "No lead mutations"],
    model: modelAssignment("balanced", "low", "standard", ["responsesText", "structuredOutputs"]),
    tools: [
      tool("bea_delegate_to_agent", "preview", 4),
      tool("bea_query_records", "read", 4),
      tool("bea_get_agent", "read", 4),
      tool("bea_list_agents", "read", 2),
    ],
    dataScopes: data(["leads", "companies", "contacts", "tasks", "current-conversation"]),
    knowledgeScopes: knowledge(["current-conversation", "authorized-bea-records"], []),
    approvalPolicy: "confirmation-required",
    escalationInstructions: "Escalate blocked commercial work to the executive Digital Agent.",
  },
  {
    id: ids.agents.leadReview,
    versionId: ids.versions.leadReview,
    slug: "lead-review-specialist",
    displayName: "Lead Review Specialist",
    roleTitle: "Lead Review Specialist — Digital Agent",
    shortDescription: "Reads authorized Lead Command Records and deterministic readiness results.",
    departmentId: ids.departments.revenue,
    teamId: ids.teams.clientDevelopment,
    supportedHumanUserId: DEMO_PERSONAS[1].id,
    status: "active",
    avatar: "specialist-lead",
    supervisorAgentId: ids.agents.revenueManager,
    preferredHandoffAgentIds: [
      ids.agents.revenueManager,
      ids.agents.andrewExecutive,
      ids.agents.executiveDocument,
    ],
    availableToRoleIds: ["owner-admin", "executive-readonly", "sales"],
    persona:
      "You are the Lead Review Specialist Digital Agent. You read authorized leads, evaluate deterministic readiness, identify blockers, and prepare follow-up-task previews. You may not change lead status, disqualify leads, create proposals, or contact clients.",
    roleDefinition: "Read-only lead analysis Digital Agent.",
    goals: [
      "Identify blocked leads",
      "Return missing-information evidence",
      "Recommend follow-up priorities",
    ],
    successCriteria: ["Uses deterministic readiness", "Does not mutate leads"],
    model: modelAssignment("fast", "low", "low", ["responsesText", "structuredOutputs"]),
    tools: [
      tool("bea_query_records", "read", 4),
      tool("bea_preview_task", "preview", 1, true),
      tool("bea_get_agent_run", "read", 2),
    ],
    dataScopes: data([
      "leads",
      "companies",
      "contacts",
      "tasks",
      "activities",
      "current-conversation",
    ]),
    knowledgeScopes: knowledge(["current-conversation", "authorized-bea-records"], []),
    approvalPolicy: "read-only-no-approval",
    escalationInstructions: "Hand structured findings to the supervisor or document specialist.",
  },
  {
    id: ids.agents.proposalPrep,
    versionId: ids.versions.proposalPrep,
    slug: "proposal-preparation-specialist",
    displayName: "Proposal Preparation Specialist",
    roleTitle: "Proposal Preparation Specialist — Digital Agent",
    shortDescription:
      "Identifies future Proposal Builder requirements. Proposal Builder is not connected.",
    departmentId: ids.departments.revenue,
    teamId: ids.teams.clientDevelopment,
    supportedHumanUserId: DEMO_PERSONAS[1].id,
    status: "active",
    avatar: "specialist-proposal",
    supervisorAgentId: ids.agents.revenueManager,
    preferredHandoffAgentIds: [ids.agents.revenueManager, ids.agents.executiveDocument],
    availableToRoleIds: ["owner-admin", "executive-readonly", "sales"],
    persona:
      "You are a Digital Agent that prepares an executive brief of information a future Proposal Builder would require. Proposal Builder is not connected. You must not produce a formal proposal.",
    roleDefinition: "Proposal-preparation Digital Agent with Proposal Builder not connected.",
    goals: ["List missing proposal inputs", "Create a preparation brief"],
    successCriteria: ["States Proposal Builder not connected", "Does not fabricate a proposal"],
    model: modelAssignment("balanced", "low", "standard", ["responsesText", "structuredOutputs"]),
    tools: [tool("bea_query_records", "read", 2), tool("bea_create_pdf", "preview", 1, true)],
    dataScopes: data(["leads", "companies", "contacts", "current-conversation"]),
    knowledgeScopes: knowledge(["current-conversation", "authorized-bea-records"], []),
    approvalPolicy: "confirmation-required",
    escalationInstructions: "Proposal Builder not connected. Do not submit commercial documents.",
  },
  {
    id: ids.agents.researchManager,
    versionId: ids.versions.researchManager,
    slug: "research-knowledge-manager",
    displayName: "Research and Knowledge Manager",
    roleTitle: "Department Manager — Digital Agent",
    shortDescription: "Supervises public research and BEA knowledge Digital Agents.",
    departmentId: ids.departments.research,
    teamId: ids.teams.publicResearch,
    supportedHumanUserId: ownerId,
    status: "active",
    avatar: "manager",
    supervisorAgentId: ids.agents.andrewExecutive,
    preferredHandoffAgentIds: [
      ids.agents.publicResearch,
      ids.agents.beaKnowledge,
      ids.agents.andrewExecutive,
    ],
    availableToRoleIds: ["owner-admin", "executive-readonly", "sales", "operations"],
    persona:
      "You coordinate public research and authorized BEA record knowledge. Organizational File Search is not connected.",
    roleDefinition: "Research department manager Digital Agent.",
    goals: ["Delegate bounded public research", "Keep BEA records distinct from public web"],
    successCriteria: ["Citations remain valid", "No fabricated knowledge sources"],
    model: modelAssignment("balanced", "low", "standard", ["responsesText", "webSearch"]),
    tools: [
      tool("bea_delegate_to_agent", "preview", 4),
      tool("bea_query_records", "read", 2),
      tool("bea_list_agents", "read", 2),
    ],
    dataScopes: data(["leads", "artifacts", "research-presentations", "current-conversation"]),
    knowledgeScopes: knowledge(
      ["public-web", "current-conversation", "authorized-bea-records"],
      [
        {
          scope: "organizational-file-search",
          disclosure: "Organizational knowledge sources not connected",
        },
      ],
    ),
    approvalPolicy: "read-only-no-approval",
    escalationInstructions: "Do not treat public information as BEA project data.",
  },
  {
    id: ids.agents.publicResearch,
    versionId: ids.versions.publicResearch,
    slug: "public-research-specialist",
    displayName: "Public Research Specialist",
    roleTitle: "Public Research Specialist — Digital Agent",
    shortDescription: "Performs authorized public Web Search and returns cited findings.",
    departmentId: ids.departments.research,
    teamId: ids.teams.publicResearch,
    supportedHumanUserId: ownerId,
    status: "active",
    avatar: "specialist-research",
    supervisorAgentId: ids.agents.researchManager,
    preferredHandoffAgentIds: [
      ids.agents.researchManager,
      ids.agents.andrewExecutive,
      ids.agents.executiveDocument,
    ],
    availableToRoleIds: ["owner-admin", "executive-readonly", "sales", "operations"],
    persona:
      "You are the Public Research Specialist Digital Agent. You may perform authorized public Web Search, produce cited findings, and distinguish fact, inference, and uncertainty. You may not treat public information as BEA project data, call arbitrary URLs, fabricate citations, or mutate records.",
    roleDefinition: "Public Web Search Digital Agent.",
    goals: ["Return cited public findings", "Label inference and uncertainty"],
    successCriteria: ["Every finding has a citation", "No arbitrary URL fetching"],
    model: modelAssignment("public-research", "low", "standard", ["responsesText", "webSearch"]),
    tools: [tool("search_web", "read", 2), tool("bea_query_records", "read", 1)],
    dataScopes: data(["current-conversation", "research-presentations"]),
    knowledgeScopes: knowledge(
      ["public-web", "current-conversation"],
      [
        {
          scope: "organizational-file-search",
          disclosure: "Organizational knowledge sources not connected",
        },
      ],
    ),
    approvalPolicy: "read-only-no-approval",
    escalationInstructions: "Hand bounded source evidence to the document specialist.",
  },
  {
    id: ids.agents.beaKnowledge,
    versionId: ids.versions.beaKnowledge,
    slug: "bea-knowledge-specialist",
    displayName: "BEA Knowledge Specialist",
    roleTitle: "BEA Knowledge Specialist — Digital Agent",
    shortDescription:
      "Uses current conversation and authorized BEA records. Organizational knowledge is not connected.",
    departmentId: ids.departments.research,
    teamId: ids.teams.beaKnowledge,
    supportedHumanUserId: ownerId,
    status: "active",
    avatar: "specialist-knowledge",
    supervisorAgentId: ids.agents.researchManager,
    preferredHandoffAgentIds: [ids.agents.researchManager, ids.agents.executiveDocument],
    availableToRoleIds: ["owner-admin", "executive-readonly"],
    persona:
      "You may use the current conversation, authorized structured BEA records, and existing artifacts. Organizational knowledge sources are not connected until File Search/RAG is implemented.",
    roleDefinition: "Authorized-record knowledge Digital Agent.",
    goals: ["Summarize authorized BEA records", "Disclose disconnected organizational knowledge"],
    successCriteria: ["Displays Organizational knowledge sources not connected"],
    model: modelAssignment("balanced", "low", "standard", ["responsesText"]),
    tools: [
      tool("bea_query_records", "read", 4),
      tool("bea_list_artifacts", "read", 4),
      tool("bea_open_artifact", "read", 4),
    ],
    dataScopes: data([
      "leads",
      "companies",
      "contacts",
      "tasks",
      "artifacts",
      "current-conversation",
    ]),
    knowledgeScopes: knowledge(
      ["current-conversation", "authorized-bea-records"],
      [
        {
          scope: "organizational-file-search",
          disclosure: "Organizational knowledge sources not connected",
        },
        {
          scope: "knowledge-collection",
          disclosure: "Organizational knowledge sources not connected",
        },
      ],
    ),
    approvalPolicy: "read-only-no-approval",
    escalationInstructions: "Do not fabricate File Search or RAG results.",
  },
  {
    id: ids.agents.operationsManager,
    versionId: ids.versions.operationsManager,
    slug: "operations-manager",
    displayName: "Operations Manager",
    roleTitle: "Department Manager — Digital Agent",
    shortDescription: "Supervises project-readiness and scheduling Digital Agents.",
    departmentId: ids.departments.operations,
    teamId: ids.teams.projectReadiness,
    supportedHumanUserId: DEMO_PERSONAS[2].id,
    status: "active",
    avatar: "manager",
    supervisorAgentId: ids.agents.andrewExecutive,
    preferredHandoffAgentIds: [
      ids.agents.projectReadiness,
      ids.agents.scheduling,
      ids.agents.andrewExecutive,
    ],
    availableToRoleIds: ["owner-admin", "executive-readonly", "operations"],
    persona:
      "You coordinate operations Digital Agents. Project Command Record and scheduling systems are not connected.",
    roleDefinition: "Operations department manager Digital Agent.",
    goals: ["Inspect current record readiness", "Keep disconnected systems labeled"],
    successCriteria: ["No fabricated project or calendar operations"],
    model: modelAssignment("balanced", "low", "standard", ["responsesText"]),
    tools: [tool("bea_delegate_to_agent", "preview", 3), tool("bea_query_records", "read", 3)],
    dataScopes: data(["leads", "tasks", "activities", "current-conversation"]),
    knowledgeScopes: knowledge(["current-conversation", "authorized-bea-records"], []),
    approvalPolicy: "confirmation-required",
    escalationInstructions:
      "Project Command Record not connected. Scheduling system not connected.",
  },
  {
    id: ids.agents.projectReadiness,
    versionId: ids.versions.projectReadiness,
    slug: "project-readiness-specialist",
    displayName: "Project Readiness Specialist",
    roleTitle: "Project Readiness Specialist — Digital Agent",
    shortDescription:
      "Inspects current leads, tasks, and activities. Project Command Record is not connected.",
    departmentId: ids.departments.operations,
    teamId: ids.teams.projectReadiness,
    supportedHumanUserId: DEMO_PERSONAS[2].id,
    status: "active",
    avatar: "specialist-operations",
    supervisorAgentId: ids.agents.operationsManager,
    preferredHandoffAgentIds: [ids.agents.operationsManager, ids.agents.executiveDocument],
    availableToRoleIds: ["owner-admin", "executive-readonly", "operations"],
    persona:
      "You inspect current leads, tasks, activities, and available record context to identify missing prerequisites. Project Command Record is not connected. You must not fabricate project operations.",
    roleDefinition: "Readiness inspection Digital Agent.",
    goals: ["Identify missing prerequisites from current records"],
    successCriteria: ["Displays Project Command Record not connected"],
    model: modelAssignment("fast", "low", "low", ["responsesText"]),
    tools: [tool("bea_query_records", "read", 4)],
    dataScopes: data(["leads", "tasks", "activities", "companies", "current-conversation"]),
    knowledgeScopes: knowledge(["current-conversation", "authorized-bea-records"], []),
    approvalPolicy: "read-only-no-approval",
    escalationInstructions: "Project Command Record not connected.",
  },
  {
    id: ids.agents.scheduling,
    versionId: ids.versions.scheduling,
    slug: "scheduling-specialist",
    displayName: "Scheduling Specialist",
    roleTitle: "Scheduling Specialist — Digital Agent",
    shortDescription: "Paused. Scheduling system is not connected.",
    departmentId: ids.departments.operations,
    teamId: ids.teams.scheduling,
    supportedHumanUserId: DEMO_PERSONAS[2].id,
    status: "paused",
    avatar: "specialist-schedule",
    supervisorAgentId: ids.agents.operationsManager,
    preferredHandoffAgentIds: [ids.agents.operationsManager],
    availableToRoleIds: ["owner-admin", "operations"],
    persona:
      "You are a paused Digital Agent. Scheduling system not connected. Do not fabricate calendars, resources, or confirmed appointments.",
    roleDefinition: "Capability-blocked scheduling Digital Agent.",
    goals: ["Remain paused until a scheduling connector exists"],
    successCriteria: ["Displays Scheduling system not connected"],
    model: modelAssignment("fast", "none", "low", ["responsesText"]),
    tools: [tool("bea_query_records", "read", 1)],
    dataScopes: data(["current-conversation"]),
    knowledgeScopes: knowledge(["current-conversation"], []),
    approvalPolicy: "always-blocked",
    escalationInstructions: "Scheduling system not connected.",
  },
  {
    id: ids.agents.documentManager,
    versionId: ids.versions.documentManager,
    slug: "document-communications-manager",
    displayName: "Document and Communications Manager",
    roleTitle: "Department Manager — Digital Agent",
    shortDescription: "Supervises the executive document Digital Agent.",
    departmentId: ids.departments.documents,
    teamId: ids.teams.executiveDocuments,
    supportedHumanUserId: ownerId,
    status: "active",
    avatar: "manager",
    supervisorAgentId: ids.agents.andrewExecutive,
    preferredHandoffAgentIds: [ids.agents.executiveDocument, ids.agents.andrewExecutive],
    availableToRoleIds: ["owner-admin", "executive-readonly", "sales", "operations"],
    persona:
      "You coordinate BEA-branded executive document generation. Formal proposals, email, and document finalization remain human-gated.",
    roleDefinition: "Document department manager Digital Agent.",
    goals: ["Delegate executive briefing generation"],
    successCriteria: ["Documents remain draft human review required"],
    model: modelAssignment("balanced", "low", "standard", ["responsesText", "structuredOutputs"]),
    tools: [
      tool("bea_delegate_to_agent", "preview", 3),
      tool("bea_list_artifacts", "read", 4),
      tool("bea_create_pdf", "preview", 1, true),
    ],
    dataScopes: data(["artifacts", "research-presentations", "leads", "current-conversation"]),
    knowledgeScopes: knowledge(["current-conversation", "authorized-bea-records"], []),
    approvalPolicy: "confirmation-required",
    escalationInstructions: "Do not email documents or mark them final.",
  },
  {
    id: ids.agents.executiveDocument,
    versionId: ids.versions.executiveDocument,
    slug: "executive-document-specialist",
    displayName: "Executive Document Specialist",
    roleTitle: "Executive Document Specialist — Digital Agent",
    shortDescription: "Creates BEA-branded executive PDFs from authorized evidence.",
    departmentId: ids.departments.documents,
    teamId: ids.teams.executiveDocuments,
    supportedHumanUserId: ownerId,
    status: "active",
    avatar: "specialist-document",
    supervisorAgentId: ids.agents.documentManager,
    preferredHandoffAgentIds: [ids.agents.documentManager, ids.agents.andrewExecutive],
    availableToRoleIds: ["owner-admin", "executive-readonly", "sales", "operations"],
    persona:
      "You are the Executive Document Specialist Digital Agent. You may create Executive Briefing, Lead Review Brief, Research Brief, and Decision Memo PDFs with immutable revisions. You may not create a formal proposal, mark a document final, email a document, or save to arbitrary local paths.",
    roleDefinition: "BEA PDF composer Digital Agent.",
    goals: ["Generate BEA-branded draft PDFs", "Return artifacts to the executive Digital Agent"],
    successCriteria: ["Uses composeBeaPdf", "Remains draft human review required"],
    model: modelAssignment("balanced", "low", "standard", ["responsesText", "structuredOutputs"]),
    tools: [
      tool("bea_create_pdf", "preview", 2, true),
      tool("bea_revise_artifact", "preview", 2, true),
      tool("bea_list_artifacts", "read", 4),
      tool("bea_open_artifact", "read", 4),
      tool("bea_download_artifact", "read", 2),
      tool("bea_query_records", "read", 2),
    ],
    dataScopes: data(["leads", "artifacts", "research-presentations", "current-conversation"]),
    knowledgeScopes: knowledge(
      ["current-conversation", "authorized-bea-records", "public-web"],
      [],
    ),
    approvalPolicy: "confirmation-required",
    escalationInstructions: "Document finalization requires human review.",
  },
];

export async function seedDigitalWorkforce(transaction: SqlExecutor): Promise<{
  readonly departments: number;
  readonly teams: number;
  readonly agents: number;
}> {
  assertLegacyRuntimeTestOnly(process.env);
  for (const department of departments) {
    await transaction.query(
      `INSERT INTO digital_workforce_departments
       (id,name,slug,description,status,display_order,parent_department_id,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,'active',$5,NULL,$6,$7,$7,1)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,slug=EXCLUDED.slug,description=EXCLUDED.description,
       status='active',display_order=EXCLUDED.display_order,updated_at=EXCLUDED.updated_at`,
      [
        department.id,
        department.name,
        department.slug,
        department.description,
        department.order,
        ownerId,
        DEMO_SEED_TIMESTAMP,
      ],
    );
  }
  for (const team of teams) {
    await transaction.query(
      `INSERT INTO digital_workforce_teams
       (id,department_id,name,slug,description,status,team_lead_agent_id,display_order,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,'active',NULL,$6,$7,$8,$8,1)
       ON CONFLICT (id) DO UPDATE SET department_id=EXCLUDED.department_id,name=EXCLUDED.name,slug=EXCLUDED.slug,
       description=EXCLUDED.description,display_order=EXCLUDED.display_order,updated_at=EXCLUDED.updated_at`,
      [
        team.id,
        team.departmentId,
        team.name,
        team.slug,
        `${team.name} Digital Agent team.`,
        team.order,
        ownerId,
        DEMO_SEED_TIMESTAMP,
      ],
    );
  }
  for (const agent of agents) {
    await transaction.query(
      `INSERT INTO digital_workforce_agents
       (id,slug,display_name,role_title,short_description,department_id,team_id,supported_human_user_id,
        current_published_version_id,status,avatar,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$10,$11,$12,$12,1)
       ON CONFLICT (id) DO UPDATE SET slug=EXCLUDED.slug,display_name=EXCLUDED.display_name,role_title=EXCLUDED.role_title,
       short_description=EXCLUDED.short_description,department_id=EXCLUDED.department_id,team_id=EXCLUDED.team_id,
       supported_human_user_id=EXCLUDED.supported_human_user_id,status=EXCLUDED.status,avatar=EXCLUDED.avatar,
       updated_at=EXCLUDED.updated_at`,
      [
        agent.id,
        agent.slug,
        agent.displayName,
        agent.roleTitle,
        agent.shortDescription,
        agent.departmentId,
        agent.teamId,
        agent.supportedHumanUserId,
        agent.status,
        agent.avatar,
        ownerId,
        DEMO_SEED_TIMESTAMP,
      ],
    );
  }
  for (const agent of agents) {
    const configurationHash = hashAgentVersionConfiguration({
      persona: agent.persona,
      roleDefinition: agent.roleDefinition,
      goals: agent.goals,
      successCriteria: agent.successCriteria,
      supervisorAgentId: agent.supervisorAgentId,
      preferredHandoffAgentIds: agent.preferredHandoffAgentIds,
      availableToRoleIds: agent.availableToRoleIds,
      modelAssignment: agent.model,
      toolGrants: agent.tools,
      dataScopes: agent.dataScopes,
      knowledgeScopes: agent.knowledgeScopes,
      memoryPolicy: "run-only",
      approvalPolicy: agent.approvalPolicy,
      runtimePolicy: DEFAULT_DIGITAL_WORKFORCE_RUNTIME_POLICY,
    });
    await transaction.query(
      `INSERT INTO digital_workforce_agent_versions
       (id,agent_id,version_number,lifecycle,persona,role_definition,goals,success_criteria,department_id,team_id,
        supervisor_agent_id,preferred_handoff_agent_ids,available_to_role_ids,model_assignment,tool_grants,data_scopes,
        knowledge_scopes,memory_policy,approval_policy,designated_approver_role_id,escalation_instructions,runtime_policy,
        configuration_hash,created_by_user_id,published_by_user_id,published_at,created_at,updated_at,version)
       VALUES ($1,$2,1,'published',$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,
        $15::jsonb,'run-only',$16,NULL,$17,$18::jsonb,$19,$20,$20,$21,$21,$21,1)
       ON CONFLICT (id) DO UPDATE SET persona=EXCLUDED.persona,role_definition=EXCLUDED.role_definition,goals=EXCLUDED.goals,
       success_criteria=EXCLUDED.success_criteria,supervisor_agent_id=EXCLUDED.supervisor_agent_id,
       preferred_handoff_agent_ids=EXCLUDED.preferred_handoff_agent_ids,available_to_role_ids=EXCLUDED.available_to_role_ids,
       model_assignment=EXCLUDED.model_assignment,tool_grants=EXCLUDED.tool_grants,data_scopes=EXCLUDED.data_scopes,
       knowledge_scopes=EXCLUDED.knowledge_scopes,approval_policy=EXCLUDED.approval_policy,
       escalation_instructions=EXCLUDED.escalation_instructions,runtime_policy=EXCLUDED.runtime_policy,
       configuration_hash=EXCLUDED.configuration_hash,updated_at=EXCLUDED.updated_at`,
      [
        agent.versionId,
        agent.id,
        agent.persona,
        agent.roleDefinition,
        JSON.stringify(agent.goals),
        JSON.stringify(agent.successCriteria),
        agent.departmentId,
        agent.teamId,
        agent.supervisorAgentId,
        JSON.stringify(agent.preferredHandoffAgentIds),
        JSON.stringify(agent.availableToRoleIds),
        JSON.stringify(agent.model),
        JSON.stringify(agent.tools),
        JSON.stringify(agent.dataScopes),
        JSON.stringify(agent.knowledgeScopes),
        agent.approvalPolicy,
        agent.escalationInstructions,
        JSON.stringify(DEFAULT_DIGITAL_WORKFORCE_RUNTIME_POLICY),
        configurationHash,
        ownerId,
        DEMO_SEED_TIMESTAMP,
      ],
    );
    await transaction.query(
      `UPDATE digital_workforce_agents SET current_published_version_id=$2, updated_at=$3 WHERE id=$1`,
      [agent.id, agent.versionId, DEMO_SEED_TIMESTAMP],
    );
  }
  for (const team of teams) {
    await transaction.query(
      `UPDATE digital_workforce_teams SET team_lead_agent_id=$2, updated_at=$3 WHERE id=$1`,
      [team.id, team.lead, DEMO_SEED_TIMESTAMP],
    );
  }
  return { departments: departments.length, teams: teams.length, agents: agents.length };
}
