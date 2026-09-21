import type {
  AiModelRoutingProfile,
  AiRouteDecisionProvenance,
  AiRoutingCapability,
  AiWorkloadRouteKey,
} from "@bea/domain";
import type { AiConversationRequest, AiModelCapabilities, AiModelMetadata } from "./contracts.js";
import { AiProviderError } from "./provider-errors.js";

export interface AiRouteSelectionInput {
  readonly routeKey: AiWorkloadRouteKey;
  readonly profile: AiModelRoutingProfile;
  readonly models: readonly AiModelMetadata[];
  readonly roleKey: string;
  readonly unavailableModelIds?: readonly string[];
  readonly at?: string;
}

function capabilitySatisfied(
  capabilities: AiModelCapabilities,
  required: AiRoutingCapability,
): boolean {
  if (capabilities[required] === true) return true;
  // A verified Web Search Responses call also proves the Responses text channel.
  if (
    required === "streaming" &&
    capabilities.webSearch === true &&
    capabilities.responsesText === true
  ) {
    return true;
  }
  return false;
}

export function modelSupportsAiRoute(
  model: AiModelMetadata,
  requiredCapabilities: readonly AiRoutingCapability[],
): boolean {
  return (
    model.available &&
    requiredCapabilities.every((capability) => capabilitySatisfied(model.capabilities, capability))
  );
}

export function modelIsRouteCandidate(
  model: AiModelMetadata,
  requiredCapabilities: readonly AiRoutingCapability[],
): boolean {
  return (
    model.available &&
    requiredCapabilities.every((capability) => {
      const state = model.capabilities[capability];
      return state === true || state === "candidate";
    })
  );
}

export function selectAiRoute(input: AiRouteSelectionInput): AiRouteDecisionProvenance {
  const policy = input.profile.routes[input.routeKey];
  if (!policy.enabled) throw routeError("The requested AI workload route is disabled.");
  if (!policy.roleAvailability.includes(input.roleKey)) {
    throw routeError("Your role is not authorized to use this AI workload route.");
  }
  if (!policy.primaryModel) throw routeError("The requested AI workload route is not configured.");

  const models = new Map(input.models.map((model) => [model.id, model] as const));
  const unavailable = new Set(input.unavailableModelIds ?? []);
  const primary = models.get(policy.primaryModel);
  const primaryCompatible =
    primary !== undefined &&
    !unavailable.has(policy.primaryModel) &&
    modelSupportsAiRoute(primary, policy.requiredCapabilities);

  let selectedModel = policy.primaryModel;
  let usedFallback = false;
  let fallbackReason: string | null = null;
  if (!primaryCompatible) {
    if (!policy.fallbackModel) {
      throw routeError("The configured primary model is unavailable or incompatible.");
    }
    const fallback = models.get(policy.fallbackModel);
    if (
      !fallback ||
      unavailable.has(policy.fallbackModel) ||
      !modelSupportsAiRoute(fallback, policy.requiredCapabilities)
    ) {
      throw routeError("No compatible model is available for the requested AI workload route.");
    }
    selectedModel = policy.fallbackModel;
    usedFallback = true;
    fallbackReason = primary ? "primary_incompatible" : "primary_unavailable";
  }

  return {
    profileVersion: input.profile.version,
    routeKey: input.routeKey,
    selectedModel,
    primaryModel: policy.primaryModel,
    fallbackModel: policy.fallbackModel,
    usedFallback,
    fallbackReason,
    requiredCapabilities: policy.requiredCapabilities,
    reasoningEffort: policy.reasoningEffort,
    toolAllowlist: policy.toolAllowlist,
    decidedAt: input.at ?? new Date().toISOString(),
  };
}

export function recommendAiRoutingProfile(
  profile: AiModelRoutingProfile,
  models: readonly AiModelMetadata[],
): AiModelRoutingProfile {
  const routes = Object.fromEntries(
    Object.entries(profile.routes).map(([routeKey, policy]) => {
      const compatible = models
        .filter((model) => modelSupportsAiRoute(model, policy.requiredCapabilities))
        .sort((left, right) => left.id.localeCompare(right.id));
      return [
        routeKey,
        {
          ...policy,
          primaryModel: compatible[0]?.id ?? null,
          fallbackModel: compatible[1]?.id ?? null,
        },
      ];
    }),
  ) as AiModelRoutingProfile["routes"];
  return {
    ...profile,
    routes,
    updatedAt: null,
    updatedByUserId: null,
  };
}

/** Server-owned deterministic intent classification. Models never select themselves. */
export function inferAiWorkloadRoute(
  request: Pick<AiConversationRequest, "input" | "builtInTools" | "files">,
): AiWorkloadRouteKey {
  const builtIns = new Set((request.builtInTools ?? []).map((tool) => tool.type));
  if (builtIns.has("image_generation")) return "image_generation";
  if (builtIns.has("code_interpreter")) return "data_analysis_chart_preparation";
  if (builtIns.has("file_search")) return "organizational_file_search";
  if (builtIns.has("web_search")) return "public_web_research";
  const text = request.input.toLowerCase();
  if (/\b(embed|embedding|index(?:ing)?)\b/u.test(text)) return "embeddings_indexing";
  if (/\b(search|find|look up)\b.*\b(files?|documents?|organizational knowledge)\b/u.test(text)) {
    return "organizational_file_search";
  }
  if (
    /\b(image|illustration|visual)\b.*\b(generate|create|draw)\b|\b(generate|create|draw)\b.*\b(image|illustration|visual)\b/u.test(
      text,
    )
  )
    return "image_generation";
  if ((request.files?.length ?? 0) > 0 && /\b(image|photo|drawing|diagram|vision)\b/u.test(text))
    return "vision_image_understanding";
  if (/\b(pdf)\b/u.test(text)) return "pdf_narrative_generation";
  const presentationIntent = inferAiPresentationIntent(request.input);
  if (presentationIntent === "public_web_research") return "public_web_research";
  if (/\b(chart|graph|spreadsheet|analy[sz]e data|data analysis)\b/u.test(text))
    return "data_analysis_chart_preparation";
  if (/\b(report|proposal|brief|memo|document|draft)\b/u.test(text))
    return "document_report_drafting";
  if (/\b(strategy|strategic|reason|tradeoff|scenario|complex)\b/u.test(text))
    return "complex_reasoning_strategy";
  if (/\b(quick|briefly|fast|short answer)\b/u.test(text)) return "fast_general_conversation";
  return "executive_conversation";
}

export function compatibleModelsForRoute(
  models: readonly AiModelMetadata[],
  requiredCapabilities: readonly AiRoutingCapability[],
): readonly AiModelMetadata[] {
  return models.filter((model) => modelSupportsAiRoute(model, requiredCapabilities));
}

const RECORD_RETRIEVAL_INTENT =
  /\b(?:open|show|summarize|retrieve)\b.*\b(?:lead|project|record|company|contact)\b/iu;
const PUBLIC_WEB_RESEARCH_INTENT =
  /\b(?:research|web search|search the (?:public )?web|search the web|latest (?:public |industry )?information|current public information)\b/iu;

export function inferAiPresentationIntent(
  input: string,
): "public_web_research" | "record_retrieval" | "other" {
  const text = input.replace(/\s+/gu, " ").trim();
  if (!text) return "other";
  const recordIntent = RECORD_RETRIEVAL_INTENT.test(text);
  const researchIntent = PUBLIC_WEB_RESEARCH_INTENT.test(text);
  if (recordIntent && !researchIntent) return "record_retrieval";
  if (researchIntent && !recordIntent) return "public_web_research";
  if (researchIntent) return "public_web_research";
  if (recordIntent) return "record_retrieval";
  return "other";
}

export function productionRejectsDemoFallback(
  appMode: string,
  providerKey: string,
  deploymentProfile?: string,
): boolean {
  return (
    providerKey === "demo" && (appMode === "production" || deploymentProfile === "owner-evaluation")
  );
}

function routeError(safeMessage: string): AiProviderError {
  return new AiProviderError({
    code: "capability_unavailable",
    provider: "openai",
    retryable: false,
    safeMessage,
  });
}
