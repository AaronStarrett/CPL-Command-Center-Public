import type { AiModelCapabilities, AiModelMetadata } from "./contracts.js";
import type { AiModelRoutingProfile, AiWorkloadRouteKey } from "@bea/domain";
import { OWNER_PRIMARY_WORKLOAD_ROUTES } from "@bea/domain";
import { modelSupportsAiRoute } from "./routing.js";
import {
  canonicalOpenAiModelSortKey,
  classifyOpenAiModelFamily,
  isChatGptOnlyModel,
  openAiFamilyRecommendationRank,
} from "./openai/model-family-registry.js";

export type ProgressiveCapabilityLevel = "unavailable" | "candidate" | "verified";

export interface ProgressiveRouteReadiness {
  readonly routeKey: AiWorkloadRouteKey;
  readonly selectedModel: string | null;
  readonly fallbackModel: string | null;
  readonly level: ProgressiveCapabilityLevel;
  readonly verifiedCapabilities: readonly string[];
  readonly unresolvedCapabilities: readonly string[];
  readonly reason: string;
  readonly costClass: string;
}

export interface ProgressiveActivationState {
  readonly liveText: ProgressiveCapabilityLevel | "blocked";
  readonly publicWebResearch: ProgressiveCapabilityLevel | "blocked";
  readonly realtimeVoice: ProgressiveCapabilityLevel | "blocked";
  readonly pdfAndArtifacts: ProgressiveCapabilityLevel | "blocked";
  readonly liveTextReady: boolean;
  readonly researchReady: boolean;
  readonly realtimeReady: boolean;
  readonly activationBlockers: readonly string[];
  readonly routes: readonly ProgressiveRouteReadiness[];
}

function capabilityList(
  capabilities: AiModelCapabilities | null | undefined,
  required: readonly (keyof AiModelCapabilities)[],
  want: true | "candidate",
): readonly string[] {
  if (!capabilities) return [];
  return required.filter((name) => capabilities[name] === want).map(String);
}

function routeLevel(
  model: AiModelMetadata | undefined,
  required: readonly (keyof AiModelCapabilities)[],
): ProgressiveCapabilityLevel {
  if (!model?.available) return "unavailable";
  if (required.every((name) => model.capabilities[name] === true)) return "verified";
  if (required.some((name) => model.capabilities[name] === false)) return "unavailable";
  if (
    required.every(
      (name) => model.capabilities[name] === true || model.capabilities[name] === "candidate",
    )
  ) {
    return "candidate";
  }
  return "candidate";
}

export function assessProgressiveActivation(input: {
  readonly authenticated: boolean;
  readonly models: readonly AiModelMetadata[];
  readonly profile: AiModelRoutingProfile;
  readonly webSearchEnabled: boolean;
  readonly realtimeEnabled: boolean;
  readonly realtimeVoiceSelected: boolean;
}): ProgressiveActivationState {
  const byId = new Map(input.models.map((model) => [model.id, model] as const));
  const routes: ProgressiveRouteReadiness[] = OWNER_PRIMARY_WORKLOAD_ROUTES.map((routeKey) => {
    const policy = input.profile.routes[routeKey];
    const selected = policy.primaryModel ? byId.get(policy.primaryModel) : undefined;
    const required = policy.requiredCapabilities as readonly (keyof AiModelCapabilities)[];
    const level = routeLevel(selected, required);
    return {
      routeKey,
      selectedModel: policy.primaryModel,
      fallbackModel: policy.fallbackModel,
      level,
      verifiedCapabilities: capabilityList(selected?.capabilities, required, true),
      unresolvedCapabilities: required
        .filter((name) => selected?.capabilities[name] !== true)
        .map(String),
      reason: !policy.primaryModel
        ? "No model is assigned."
        : !selected
          ? "The assigned model is not in the current project inventory."
          : level === "verified"
            ? "Required capabilities are verified."
            : level === "candidate"
              ? "The assigned model is a candidate until capability probes complete."
              : "The assigned model is unavailable or unsupported for this route.",
      costClass: policy.costClass,
    };
  });

  const executive = routes.find((route) => route.routeKey === "executive_conversation");
  const research = routes.find((route) => route.routeKey === "public_web_research");
  const realtime = routes.find((route) => route.routeKey === "realtime_voice");
  const pdf = input.profile.routes.pdf_narrative_generation;
  const pdfModel = pdf.primaryModel ? byId.get(pdf.primaryModel) : undefined;
  const pdfLevel = routeLevel(
    pdfModel ?? (executive?.selectedModel ? byId.get(executive.selectedModel) : undefined),
    ["responsesText", "structuredOutputs"],
  );

  const blockers: string[] = [];
  if (!input.authenticated)
    blockers.push("OpenAI has not passed an authenticated connection test.");
  if (executive?.level !== "verified") {
    blockers.push("Live text requires a verified Responses text model on Executive / Premium.");
  }

  const liveTextReady = input.authenticated && executive?.level === "verified";
  const researchReady = liveTextReady && research?.level === "verified" && input.webSearchEnabled;
  const realtimeReady =
    input.authenticated &&
    realtime?.level === "verified" &&
    input.realtimeEnabled &&
    input.realtimeVoiceSelected;

  return {
    liveText: !input.authenticated ? "blocked" : (executive?.level ?? "unavailable"),
    publicWebResearch: !liveTextReady
      ? "blocked"
      : !input.webSearchEnabled
        ? research?.level === "verified"
          ? "candidate"
          : (research?.level ?? "unavailable")
        : (research?.level ?? "unavailable"),
    realtimeVoice: !input.authenticated
      ? "blocked"
      : !input.realtimeEnabled
        ? realtime?.level === "verified"
          ? "candidate"
          : (realtime?.level ?? "unavailable")
        : (realtime?.level ?? "unavailable"),
    pdfAndArtifacts: liveTextReady ? pdfLevel : "blocked",
    liveTextReady,
    researchReady,
    realtimeReady,
    activationBlockers: blockers,
    routes,
  };
}

function comparableModels(
  models: readonly AiModelMetadata[],
  required: readonly (keyof AiModelCapabilities)[],
  routeKey: string,
): readonly AiModelMetadata[] {
  return models
    .filter((model) => model.available && !isChatGptOnlyModel(model.id))
    .filter((model) => {
      const family = classifyOpenAiModelFamily(model.id);
      if (!family.apiRouteAppropriate) return false;
      return required.every((capability) => {
        const state = model.capabilities[capability];
        return state === true || state === "candidate" || state === "unknown";
      });
    })
    .sort((left, right) => {
      const leftVerified = required.every((capability) => left.capabilities[capability] === true);
      const rightVerified = required.every((capability) => right.capabilities[capability] === true);
      if (leftVerified !== rightVerified) return leftVerified ? -1 : 1;
      const rankDelta =
        openAiFamilyRecommendationRank(left.id, routeKey) -
        openAiFamilyRecommendationRank(right.id, routeKey);
      if (rankDelta !== 0) return rankDelta;
      const canonicalDelta =
        canonicalOpenAiModelSortKey(left.id) - canonicalOpenAiModelSortKey(right.id);
      if (canonicalDelta !== 0) return canonicalDelta;
      return left.id.localeCompare(right.id);
    });
}

/**
 * Recommend route models from the connected project's returned inventory only.
 * Verified models outrank family candidates. ChatGPT-only IDs are never assigned
 * to API routes.
 */
export function recommendProjectAiRoutingProfile(
  profile: AiModelRoutingProfile,
  models: readonly AiModelMetadata[],
): AiModelRoutingProfile {
  const routes = Object.fromEntries(
    Object.entries(profile.routes).map(([routeKey, policy]) => {
      const required = policy.requiredCapabilities as readonly (keyof AiModelCapabilities)[];
      const ranked = comparableModels(models, required, routeKey);
      const verified = ranked.filter((model) =>
        modelSupportsAiRoute(model, policy.requiredCapabilities),
      );
      const primary = verified[0] ?? ranked[0];
      const fallback = (verified[0] ? verified[1] : ranked[1]) ?? null;
      return [
        routeKey,
        {
          ...policy,
          primaryModel: primary?.id ?? null,
          fallbackModel: fallback && fallback.id !== primary?.id ? fallback.id : null,
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
