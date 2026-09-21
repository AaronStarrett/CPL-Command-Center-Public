import type { AiCapabilityState, AiModelCapabilities, AiModelMetadata } from "../contracts.js";
import { OPENAI_CAPABILITY_REGISTRY_VERSION, UNKNOWN_MODEL_CAPABILITIES } from "../capabilities.js";

export const OPENAI_MODEL_FAMILY_REGISTRY_VERSION = "2026-08-phase2.2-family-v1";

export type OpenAiModelFamily =
  | "gpt-5.6-sol"
  | "gpt-5.6-terra"
  | "gpt-5.6-luna"
  | "gpt-5.6-flagship"
  | "gpt-realtime-2.1"
  | "gpt-realtime"
  | "gpt-4.1"
  | "gpt-4o"
  | "o-series"
  | "chatgpt-only"
  | "audio-utility"
  | "embedding"
  | "image"
  | "moderation"
  | "unknown";

export type OpenAiCostClass = "low" | "standard" | "high";

export interface OpenAiFamilyProfile {
  readonly family: OpenAiModelFamily;
  readonly displayName: string;
  readonly costClass: OpenAiCostClass;
  readonly apiRouteAppropriate: boolean;
  readonly preferredRoutes: readonly string[];
  readonly candidateCapabilities: Partial<AiModelCapabilities>;
}

const CANDIDATE_TEXT: Partial<AiModelCapabilities> = {
  responsesText: "candidate",
  streaming: "candidate",
  functionCalling: "candidate",
  structuredOutputs: "candidate",
};

const CANDIDATE_REASONING: Partial<AiModelCapabilities> = {
  ...CANDIDATE_TEXT,
  reasoning: "candidate",
};

const CANDIDATE_WEB: Partial<AiModelCapabilities> = {
  ...CANDIDATE_TEXT,
  webSearch: "candidate",
};

const CANDIDATE_REALTIME: Partial<AiModelCapabilities> = {
  realtime: "candidate",
  audioInput: "candidate",
  audioOutput: "candidate",
  functionCalling: "candidate",
};

const FAMILY_PROFILES: Readonly<Record<OpenAiModelFamily, OpenAiFamilyProfile>> = Object.freeze({
  "gpt-5.6-sol": {
    family: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    costClass: "high",
    apiRouteAppropriate: true,
    preferredRoutes: ["executive_conversation", "complex_reasoning_strategy"],
    candidateCapabilities: CANDIDATE_REASONING,
  },
  "gpt-5.6-terra": {
    family: "gpt-5.6-terra",
    displayName: "GPT-5.6 Terra",
    costClass: "standard",
    apiRouteAppropriate: true,
    preferredRoutes: [
      "public_web_research",
      "document_report_drafting",
      "pdf_narrative_generation",
    ],
    candidateCapabilities: CANDIDATE_WEB,
  },
  "gpt-5.6-luna": {
    family: "gpt-5.6-luna",
    displayName: "GPT-5.6 Luna",
    costClass: "low",
    apiRouteAppropriate: true,
    preferredRoutes: ["fast_general_conversation"],
    candidateCapabilities: CANDIDATE_TEXT,
  },
  "gpt-5.6-flagship": {
    family: "gpt-5.6-flagship",
    displayName: "GPT-5.6",
    costClass: "high",
    apiRouteAppropriate: true,
    preferredRoutes: ["executive_conversation", "complex_reasoning_strategy"],
    candidateCapabilities: CANDIDATE_REASONING,
  },
  "gpt-realtime-2.1": {
    family: "gpt-realtime-2.1",
    displayName: "GPT Realtime 2.1",
    costClass: "high",
    apiRouteAppropriate: true,
    preferredRoutes: ["realtime_voice"],
    candidateCapabilities: CANDIDATE_REALTIME,
  },
  "gpt-realtime": {
    family: "gpt-realtime",
    displayName: "GPT Realtime",
    costClass: "high",
    apiRouteAppropriate: true,
    preferredRoutes: ["realtime_voice"],
    candidateCapabilities: CANDIDATE_REALTIME,
  },
  "gpt-4.1": {
    family: "gpt-4.1",
    displayName: "GPT-4.1",
    costClass: "standard",
    apiRouteAppropriate: true,
    preferredRoutes: ["executive_conversation", "public_web_research"],
    candidateCapabilities: CANDIDATE_WEB,
  },
  "gpt-4o": {
    family: "gpt-4o",
    displayName: "GPT-4o",
    costClass: "standard",
    apiRouteAppropriate: true,
    preferredRoutes: ["fast_general_conversation", "public_web_research"],
    candidateCapabilities: { ...CANDIDATE_WEB, audioInput: "candidate", audioOutput: "candidate" },
  },
  "o-series": {
    family: "o-series",
    displayName: "OpenAI reasoning",
    costClass: "high",
    apiRouteAppropriate: true,
    preferredRoutes: ["complex_reasoning_strategy"],
    candidateCapabilities: CANDIDATE_REASONING,
  },
  "chatgpt-only": {
    family: "chatgpt-only",
    displayName: "ChatGPT-only",
    costClass: "standard",
    apiRouteAppropriate: false,
    preferredRoutes: [],
    candidateCapabilities: {},
  },
  "audio-utility": {
    family: "audio-utility",
    displayName: "Audio utility",
    costClass: "low",
    apiRouteAppropriate: false,
    preferredRoutes: [],
    candidateCapabilities: { audioInput: "candidate", audioOutput: "candidate" },
  },
  embedding: {
    family: "embedding",
    displayName: "Embeddings",
    costClass: "low",
    apiRouteAppropriate: true,
    preferredRoutes: ["embeddings_indexing"],
    candidateCapabilities: { embeddings: "candidate" },
  },
  image: {
    family: "image",
    displayName: "Image",
    costClass: "standard",
    apiRouteAppropriate: true,
    preferredRoutes: ["image_generation"],
    candidateCapabilities: { imageGeneration: "candidate" },
  },
  moderation: {
    family: "moderation",
    displayName: "Moderation",
    costClass: "low",
    apiRouteAppropriate: false,
    preferredRoutes: [],
    candidateCapabilities: {},
  },
  unknown: {
    family: "unknown",
    displayName: "Unknown family",
    costClass: "standard",
    apiRouteAppropriate: true,
    preferredRoutes: [],
    candidateCapabilities: {},
  },
});

function normalizedModelId(modelId: string): string {
  return modelId.trim().toLowerCase();
}

export function classifyOpenAiModelFamily(modelId: string): OpenAiFamilyProfile {
  const id = normalizedModelId(modelId);
  if (!id) return FAMILY_PROFILES.unknown;
  if (/chatgpt|gpt-5-chat|gpt-4o-mini-tts|sora/u.test(id) && /chat-latest|chatgpt/u.test(id)) {
    return FAMILY_PROFILES["chatgpt-only"];
  }
  if (/^chatgpt/u.test(id) || /chat-latest$/u.test(id)) return FAMILY_PROFILES["chatgpt-only"];
  if (/moderation/u.test(id)) return FAMILY_PROFILES.moderation;
  if (/embedding|text-embedding/u.test(id)) return FAMILY_PROFILES.embedding;
  if (/dall-e|gpt-image|image-preview/u.test(id)) return FAMILY_PROFILES.image;
  if (/whisper|tts-|gpt-4o-mini-tts|audio-preview/u.test(id) && !/realtime/u.test(id)) {
    return FAMILY_PROFILES["audio-utility"];
  }
  if (/gpt-realtime-2\.1/u.test(id) || /realtime-2\.1/u.test(id)) {
    return FAMILY_PROFILES["gpt-realtime-2.1"];
  }
  if (/realtime/u.test(id)) return FAMILY_PROFILES["gpt-realtime"];
  if (/gpt-5\.6-sol|gpt-5-6-sol|gpt-5\.6-pro/u.test(id)) return FAMILY_PROFILES["gpt-5.6-sol"];
  if (/gpt-5\.6-terra|gpt-5-6-terra/u.test(id)) return FAMILY_PROFILES["gpt-5.6-terra"];
  if (/gpt-5\.6-luna|gpt-5-6-luna/u.test(id)) return FAMILY_PROFILES["gpt-5.6-luna"];
  if (/gpt-5\.6|gpt-5-6|gpt-5\.5|gpt-5(?!.*mini)/u.test(id))
    return FAMILY_PROFILES["gpt-5.6-flagship"];
  if (/^o[134]|o3-mini|o4-mini/u.test(id)) return FAMILY_PROFILES["o-series"];
  if (/gpt-4\.1/u.test(id)) return FAMILY_PROFILES["gpt-4.1"];
  if (/gpt-4o/u.test(id)) return FAMILY_PROFILES["gpt-4o"];
  return FAMILY_PROFILES.unknown;
}

export function isChatGptOnlyModel(modelId: string): boolean {
  return classifyOpenAiModelFamily(modelId).family === "chatgpt-only";
}

export function applyOpenAiFamilyCandidates(
  capabilities: AiModelCapabilities,
  modelId: string,
): AiModelCapabilities {
  const family = classifyOpenAiModelFamily(modelId);
  const next: Record<string, AiCapabilityState> = { ...capabilities };
  for (const [key, state] of Object.entries(family.candidateCapabilities)) {
    if (state === undefined) continue;
    const current = next[key];
    if (current === true || current === false) continue;
    next[key] = state;
  }
  return next as unknown as AiModelCapabilities;
}

const ROUTE_FAMILY_PRIORITY: Readonly<Record<string, readonly OpenAiModelFamily[]>> = {
  executive_conversation: ["gpt-5.6-sol", "gpt-5.6-flagship", "gpt-4.1", "o-series", "gpt-4o"],
  fast_general_conversation: ["gpt-5.6-luna", "gpt-4o", "gpt-4.1", "gpt-5.6-terra", "gpt-5.6-sol"],
  complex_reasoning_strategy: ["gpt-5.6-sol", "gpt-5.6-flagship", "o-series", "gpt-4.1"],
  public_web_research: ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-4.1", "gpt-4o"],
  document_report_drafting: ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-4.1", "gpt-5.6-flagship"],
  pdf_narrative_generation: ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-4.1", "gpt-5.6-flagship"],
  realtime_voice: ["gpt-realtime-2.1", "gpt-realtime"],
};

export const CANONICAL_OPENAI_MODEL_IDS = Object.freeze([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-realtime-2.1",
  "gpt-4.1",
  "gpt-4o",
]);

export function openAiFamilyRecommendationRank(modelId: string, routeKey: string): number {
  const family = classifyOpenAiModelFamily(modelId);
  if (!family.apiRouteAppropriate) return 10_000;
  const routePriority = ROUTE_FAMILY_PRIORITY[routeKey];
  if (routePriority) {
    const index = routePriority.indexOf(family.family);
    if (index >= 0) return index;
  }
  const preferredIndex = family.preferredRoutes.indexOf(routeKey);
  if (preferredIndex >= 0) return 50 + preferredIndex;
  if (family.family === "unknown") return 5_000;
  return 100 + Object.keys(FAMILY_PROFILES).indexOf(family.family);
}

export function canonicalOpenAiModelSortKey(modelId: string): number {
  const id = normalizedModelId(modelId);
  if (CANONICAL_OPENAI_MODEL_IDS.includes(id)) return 0;
  if (/\d{4}-\d{2}-\d{2}/u.test(id)) return 2;
  return 1;
}

export function familyRegistryValidation() {
  return {
    registryVersion: `${OPENAI_CAPABILITY_REGISTRY_VERSION}+${OPENAI_MODEL_FAMILY_REGISTRY_VERSION}`,
    validatedAt: null,
    validationMethod: "registry" as const,
    evidence: { familyRegistryVersion: OPENAI_MODEL_FAMILY_REGISTRY_VERSION },
  };
}

export function mergeUnknownWithFamily(model: AiModelMetadata): AiModelMetadata {
  const capabilities = applyOpenAiFamilyCandidates(model.capabilities, model.id);
  const allUnknown = Object.values(capabilities).every((state) => state === "unknown");
  const hasCandidate = Object.values(capabilities).some((state) => state === "candidate");
  const currentValidation = model.validation ?? {
    registryVersion: OPENAI_CAPABILITY_REGISTRY_VERSION,
    validatedAt: null,
    validationMethod: "unknown" as const,
    evidence: {},
  };
  return {
    ...model,
    capabilities,
    capabilitySource: hasCandidate
      ? "registry"
      : allUnknown
        ? model.capabilitySource
        : model.capabilitySource,
    validation:
      hasCandidate && currentValidation.validationMethod === "unknown"
        ? familyRegistryValidation()
        : currentValidation,
  };
}

export { UNKNOWN_MODEL_CAPABILITIES };
