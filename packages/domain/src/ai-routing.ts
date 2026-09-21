import type { IsoDateTime, JsonObject, VersionedEntity } from "./entities.js";

export const AI_ROUTING_PROFILE_VERSION = "phase1.3.3-v1";

export const OWNER_PRIMARY_WORKLOAD_ROUTES = [
  "executive_conversation",
  "fast_general_conversation",
  "complex_reasoning_strategy",
  "public_web_research",
  "realtime_voice",
] as const;

export type OwnerPrimaryWorkloadRoute = (typeof OWNER_PRIMARY_WORKLOAD_ROUTES)[number];

export const AI_WORKLOAD_ROUTE_KEYS = [
  "executive_conversation",
  "fast_general_conversation",
  "complex_reasoning_strategy",
  "public_web_research",
  "organizational_file_search",
  "document_report_drafting",
  "pdf_narrative_generation",
  "data_analysis_chart_preparation",
  "image_generation",
  "vision_image_understanding",
  "realtime_voice",
  "embeddings_indexing",
] as const;

export type AiWorkloadRouteKey = (typeof AI_WORKLOAD_ROUTE_KEYS)[number];

export type AiRoutingCapability =
  | "responsesText"
  | "streaming"
  | "reasoning"
  | "functionCalling"
  | "structuredOutputs"
  | "webSearch"
  | "fileSearch"
  | "codeInterpreter"
  | "imageGeneration"
  | "imageInput"
  | "fileInput"
  | "realtime"
  | "audioInput"
  | "audioOutput"
  | "embeddings";

export type AiReasoningEffort = "none" | "low" | "medium" | "high";
export type AiRouteCostClass = "low" | "standard" | "high";

export const AI_ROUTE_PROFILE_LABELS: Readonly<
  Record<AiWorkloadRouteKey, { readonly profileLabel: string; readonly description: string }>
> = Object.freeze({
  executive_conversation: {
    profileLabel: "Executive / Premium",
    description: "Role-aware executive conversation with the application-owned BEA persona.",
  },
  fast_general_conversation: {
    profileLabel: "Fast",
    description: "Short, low-latency general conversation.",
  },
  complex_reasoning_strategy: {
    profileLabel: "Balanced",
    description: "Strategy, scenarios, and complex tradeoffs.",
  },
  public_web_research: {
    profileLabel: "Public Web Research",
    description: "Authorized public web research with cited sources.",
  },
  organizational_file_search: {
    profileLabel: "Balanced",
    description: "Search administrator-assigned organizational files.",
  },
  document_report_drafting: {
    profileLabel: "Executive / Premium",
    description: "Structured reports, memos, and drafts.",
  },
  pdf_narrative_generation: {
    profileLabel: "Balanced",
    description: "Narrative supplied to the BEA PDF composer.",
  },
  data_analysis_chart_preparation: {
    profileLabel: "Executive / Premium",
    description: "Data analysis and chart preparation.",
  },
  image_generation: {
    profileLabel: "Executive / Premium",
    description: "Illustration and image generation when authorized.",
  },
  vision_image_understanding: {
    profileLabel: "Balanced",
    description: "Image understanding with Responses text.",
  },
  realtime_voice: {
    profileLabel: "Realtime Voice",
    description: "Live speech-to-speech conversation with registered tools.",
  },
  embeddings_indexing: {
    profileLabel: "Fast",
    description: "Future approved indexing. Execution remains deferred.",
  },
});

export interface AiModelRoutePolicy {
  readonly routeKey: AiWorkloadRouteKey;
  readonly primaryModel: string | null;
  readonly fallbackModel: string | null;
  readonly requiredCapabilities: readonly AiRoutingCapability[];
  readonly reasoningEffort: AiReasoningEffort;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  readonly toolAllowlist: readonly string[];
  readonly costClass: AiRouteCostClass;
  readonly maximumEstimatedCostUsd: number | null;
  readonly roleAvailability: readonly string[];
  readonly enabled: boolean;
}

export interface AiModelRoutingProfile {
  readonly version: typeof AI_ROUTING_PROFILE_VERSION;
  readonly routes: Readonly<Record<AiWorkloadRouteKey, AiModelRoutePolicy>>;
  readonly vectorStoreAssignments: readonly AiVectorStoreAssignment[];
  readonly updatedAt: IsoDateTime | null;
  readonly updatedByUserId: string | null;
}

export interface AiRouteDecisionProvenance {
  readonly profileVersion: string;
  readonly routeKey: AiWorkloadRouteKey;
  readonly selectedModel: string;
  readonly primaryModel: string | null;
  readonly fallbackModel: string | null;
  readonly usedFallback: boolean;
  readonly fallbackReason: string | null;
  readonly requiredCapabilities: readonly AiRoutingCapability[];
  readonly reasoningEffort: AiReasoningEffort;
  readonly toolAllowlist: readonly string[];
  readonly decidedAt: IsoDateTime;
}

export interface AiVectorStoreAssignment {
  readonly vectorStoreId: string;
  readonly displayName: string;
  readonly allowedRoleKeys: readonly string[];
  readonly enabled: boolean;
}

export interface AiUserVoicePreference extends VersionedEntity {
  readonly userId: string;
  readonly speakResponses: boolean;
  readonly updatedAt: IsoDateTime;
}

export interface AiModelValidationMetadata {
  readonly registryVersion: string;
  readonly validatedAt: IsoDateTime | null;
  readonly validationMethod:
    "registry" | "models_api" | "provider_probe" | "administrator" | "unknown";
  readonly evidence: JsonObject;
}

const ALL_AI_ROLES = Object.freeze([
  "owner-admin",
  "integration-admin",
  "executive-readonly",
  "sales",
  "operations",
]);

function route(
  routeKey: AiWorkloadRouteKey,
  requiredCapabilities: readonly AiRoutingCapability[],
  options: Partial<Omit<AiModelRoutePolicy, "routeKey" | "requiredCapabilities">> = {},
): AiModelRoutePolicy {
  return Object.freeze({
    routeKey,
    primaryModel: null,
    fallbackModel: null,
    requiredCapabilities,
    reasoningEffort: "none",
    maxOutputTokens: 2_048,
    timeoutMs: 30_000,
    toolAllowlist: [],
    costClass: "standard",
    maximumEstimatedCostUsd: null,
    roleAvailability: ALL_AI_ROLES,
    enabled: true,
    ...options,
  });
}

/** Model IDs intentionally remain unset until live discovery and capability validation. */
export function createUnconfiguredAiRoutingProfile(): AiModelRoutingProfile {
  return Object.freeze({
    version: AI_ROUTING_PROFILE_VERSION,
    routes: Object.freeze({
      executive_conversation: route("executive_conversation", ["responsesText", "streaming"], {
        reasoningEffort: "medium",
      }),
      fast_general_conversation: route(
        "fast_general_conversation",
        ["responsesText", "streaming"],
        { costClass: "low" },
      ),
      complex_reasoning_strategy: route(
        "complex_reasoning_strategy",
        ["responsesText", "streaming", "reasoning"],
        { reasoningEffort: "high", maxOutputTokens: 8_192, timeoutMs: 120_000, costClass: "high" },
      ),
      public_web_research: route(
        "public_web_research",
        ["responsesText", "streaming", "webSearch"],
        { toolAllowlist: ["web_search"], maxOutputTokens: 6_144, timeoutMs: 180_000 },
      ),
      organizational_file_search: route(
        "organizational_file_search",
        ["responsesText", "streaming", "fileSearch"],
        { toolAllowlist: ["file_search"], maxOutputTokens: 6_144, timeoutMs: 120_000 },
      ),
      document_report_drafting: route(
        "document_report_drafting",
        ["responsesText", "streaming", "structuredOutputs"],
        { maxOutputTokens: 12_288, timeoutMs: 120_000 },
      ),
      pdf_narrative_generation: route(
        "pdf_narrative_generation",
        ["responsesText", "streaming", "structuredOutputs"],
        { toolAllowlist: ["bea_create_pdf"], maxOutputTokens: 12_288, timeoutMs: 120_000 },
      ),
      data_analysis_chart_preparation: route(
        "data_analysis_chart_preparation",
        ["responsesText", "codeInterpreter", "structuredOutputs"],
        {
          toolAllowlist: ["code_interpreter", "bea_create_chart"],
          timeoutMs: 300_000,
          costClass: "high",
        },
      ),
      image_generation: route("image_generation", ["imageGeneration"], {
        toolAllowlist: ["image_generation"],
        timeoutMs: 180_000,
        costClass: "high",
      }),
      vision_image_understanding: route(
        "vision_image_understanding",
        ["responsesText", "imageInput"],
        { maxOutputTokens: 4_096, timeoutMs: 90_000 },
      ),
      realtime_voice: route("realtime_voice", ["realtime", "audioInput", "audioOutput"], {
        maxOutputTokens: 2_048,
        timeoutMs: 30_000,
        toolAllowlist: [
          "search_web",
          "bea_query_records",
          "bea_connector_health",
          "bea_workflow_history",
          "bea_preview_task",
          "bea_show_workspace",
          "bea_create_pdf",
          "bea_open_artifact",
          "bea_list_artifacts",
          "bea_download_artifact",
          "bea_revise_artifact",
          "bea_list_agents",
          "bea_get_agent",
          "bea_show_digital_workforce",
          "bea_get_agent_run",
          "bea_show_agent_run",
          "bea_delegate_to_agent",
          "bea_cancel_agent_run",
        ],
      }),
      embeddings_indexing: route("embeddings_indexing", ["embeddings"], {
        costClass: "low",
        maxOutputTokens: 1,
        timeoutMs: 60_000,
      }),
    }),
    vectorStoreAssignments: Object.freeze([]),
    updatedAt: null,
    updatedByUserId: null,
  });
}
