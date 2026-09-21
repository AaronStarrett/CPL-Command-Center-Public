import "server-only";

import type {
  AiCommandProvider,
  AiModelCapabilities,
  AiModelMetadata,
  ModelCapabilityOverride,
} from "@bea/ai";
import {
  assessProgressiveActivation,
  listOpenAiVoices,
  mergeUnknownWithFamily,
  MAX_AI_GENERATED_ARTIFACT_BYTES,
  OPENAI_CAPABILITY_REGISTRY_VERSION,
  applyCapabilityEvidence,
  probeOpenAiRouteCandidates,
  productionRejectsDemoFallback,
  recommendProjectAiRoutingProfile,
  UnavailableOpenAiProvider,
} from "@bea/ai";
import { MAXIMUM_ARTIFACT_UPLOAD_BYTES } from "@bea/artifacts";
import { isOwnerEvaluationRuntime, requiresLiveOpenAiProvider, validOpenAiKey } from "@bea/config";
import type { BeaServerRuntime } from "@bea/database";
import {
  AI_PROVIDER_SETTINGS_KEY,
  connectionEvidenceMatchesCredential,
  DEFAULT_AI_PROVIDER_SETTINGS,
} from "@bea/database";
import type {
  AiProviderConnectionTest,
  AiProviderSettings,
  AiModelRoutingProfile,
  AiRoutingCapability,
  JsonObject,
  JsonValue,
} from "@bea/domain";
import { AI_ROUTING_PROFILE_VERSION, AI_WORKLOAD_ROUTE_KEYS } from "@bea/domain";
import { PERMISSIONS } from "@bea/security";

import { isPhase133ProductionPresentationTest } from "./phase133-production-presentation-test";

export const OPENAI_ACTIVATION_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function isLiveMode(mode: AiProviderSettings["mode"]): mode is "openai" | "hybrid" {
  return mode === "openai" || mode === "hybrid";
}

export class OpenAiAdministrationError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OpenAiAdministrationError";
  }
}

/**
 * The Phase 1.3.3 production-presentation browser is an exact-authority TEST-ONLY surface.
 * Keep this check ahead of every secret, provider, network, audit, or settings operation so a
 * canonical protected credential can never turn that presentation surface into a live runtime.
 */
export function requireOpenAiLiveAdministrationAllowed(): void {
  if (!isPhase133ProductionPresentationTest()) return;
  throw new OpenAiAdministrationError(
    "PHASE133_PRESENTATION_TEST_LIVE_OPERATION_BLOCKED",
    409,
    "Live OpenAI administration is unavailable in the Phase 1.3.3 TEST-ONLY presentation harness.",
  );
}

/**
 * Deterministic AI Command execution is a fail-closed Demo-only capability. Both persisted
 * settings and the active provider must agree so a selected OpenAI/Hybrid provider can never
 * downgrade to a synthetic response path.
 */
export async function isDeterministicDemoAiCommandAllowed(
  runtime: BeaServerRuntime,
): Promise<boolean> {
  if (
    requiresLiveOpenAiProvider(runtime.environment) ||
    runtime.environment.runtimeMode === "production" ||
    isPhase133ProductionPresentationTest()
  ) {
    return false;
  }
  if (runtime.environment.appMode !== "demo") {
    return false;
  }
  try {
    const settings = await runtime.ai.persistence.getProviderSettings();
    return settings.mode === "demo" && runtime.ai.registry.active().providerKey === "demo";
  } catch {
    return false;
  }
}

export type LiveOwnerAuthorizationCapability =
  "code_interpreter" | "image_generation" | "input_file" | "realtime";

const REALTIME_OWNER_AUTHORIZATION = Symbol("bea-realtime-owner-authorization");
const LIVE_TOOL_OWNER_AUTHORIZATION = Symbol("bea-live-tool-owner-authorization");

type LiveRealtimeOwnerAuthorization = Readonly<{
  [REALTIME_OWNER_AUTHORIZATION]: true;
  actorUserId: string;
  correlationId: string;
}>;

type LiveToolOwnerAuthorization = Readonly<{
  [LIVE_TOOL_OWNER_AUTHORIZATION]: true;
  actorUserId: string;
  correlationId: string;
  capabilities: readonly Exclude<LiveOwnerAuthorizationCapability, "realtime">[];
}>;

/** Owner-only, request-scoped authorization for paid tools and external file transmission. */
export async function authorizeLiveOwnerTools(input: {
  readonly runtime: BeaServerRuntime;
  readonly actorUserId: string;
  readonly correlationId: string;
  readonly capabilities: readonly Exclude<LiveOwnerAuthorizationCapability, "realtime">[];
}): Promise<LiveToolOwnerAuthorization> {
  requireOpenAiLiveAdministrationAllowed();
  const user = await input.runtime.repository.findActiveUserById(input.actorUserId);
  if (!user?.roleIds.includes("owner-admin")) {
    throw new OpenAiAdministrationError(
      "LIVE_TOOL_OWNER_AUTHORIZATION_REQUIRED",
      403,
      "Only the Owner can authorize this live provider operation.",
    );
  }
  for (const permission of [
    PERMISSIONS.AI_COMMAND_RUN,
    PERMISSIONS.DOCUMENTS_VIEW,
    PERMISSIONS.SETTINGS_MANAGE,
  ] as const) {
    await input.runtime.authorization.requireUser({
      userId: input.actorUserId,
      permission,
      action: "ai-command.live-tool.authorize",
      resourceType: "ai-provider",
      correlationId: input.correlationId,
    });
  }
  const capabilities = [...new Set(input.capabilities)];
  await input.runtime.repository.record({
    eventType: "ai-provider.live-tool-owner-authorized",
    action: "ai-command.live-tool.authorize",
    outcome: "succeeded",
    actorUserId: input.actorUserId,
    resourceType: "ai-provider",
    resourceId: null,
    correlationId: input.correlationId,
    metadata: { provider: "openai", capabilities, requestScoped: true },
  });
  return Object.freeze({
    [LIVE_TOOL_OWNER_AUTHORIZATION]: true as const,
    actorUserId: input.actorUserId,
    correlationId: input.correlationId,
    capabilities,
  });
}

/**
 * Mint server-only, request-scoped Realtime evidence after independently rechecking the complete
 * owner permission set and current authenticated provider activation. A browser boolean cannot
 * construct this token.
 */
export async function authorizeLiveRealtimeOwner(input: {
  readonly runtime: BeaServerRuntime;
  readonly actorUserId: string;
  readonly correlationId: string;
}): Promise<LiveRealtimeOwnerAuthorization> {
  requireOpenAiLiveAdministrationAllowed();
  for (const permission of [PERMISSIONS.AI_COMMAND_RUN] as const) {
    await input.runtime.authorization.requireUser({
      userId: input.actorUserId,
      permission,
      action: "ai-command.realtime.authorize",
      resourceType: "ai-provider",
      correlationId: input.correlationId,
    });
  }
  const administration = await readOpenAiAdministration(input.runtime);
  if (!administration.liveConnected) {
    throw new OpenAiAdministrationError(
      "LIVE_REALTIME_CONNECTION_REQUIRED",
      409,
      "OpenAI must have current authenticated activation before Realtime can start.",
    );
  }
  await input.runtime.repository.record({
    eventType: "ai-provider.realtime-owner-authorized",
    action: "ai-command.realtime.authorize",
    outcome: "succeeded",
    actorUserId: input.actorUserId,
    resourceType: "ai-provider",
    resourceId: null,
    correlationId: input.correlationId,
    metadata: { provider: "openai", permissionCount: 1, requestScoped: true },
  });
  return Object.freeze({
    [REALTIME_OWNER_AUTHORIZATION]: true as const,
    actorUserId: input.actorUserId,
    correlationId: input.correlationId,
  });
}

/** Explicit server boundary: a browser boolean or direct API call cannot authorize paid/external work. */
export function requireLiveOwnerAuthorization(
  providerKey: string,
  capability: LiveOwnerAuthorizationCapability,
  authorization?: LiveRealtimeOwnerAuthorization | LiveToolOwnerAuthorization,
): void {
  if (providerKey !== "openai") return;
  if (
    capability === "realtime" &&
    authorization &&
    REALTIME_OWNER_AUTHORIZATION in authorization &&
    authorization[REALTIME_OWNER_AUTHORIZATION] === true
  ) {
    return;
  }
  if (
    authorization &&
    LIVE_TOOL_OWNER_AUTHORIZATION in authorization &&
    authorization[LIVE_TOOL_OWNER_AUTHORIZATION] === true &&
    authorization.capabilities.includes(
      capability as Exclude<LiveOwnerAuthorizationCapability, "realtime">,
    )
  ) {
    return;
  }
  const policy = {
    code_interpreter: {
      code: "LIVE_HIGH_COST_TOOL_OWNER_AUTHORIZATION_REQUIRED",
      message: "Live Code Interpreter is blocked pending explicit owner authorization.",
    },
    image_generation: {
      code: "LIVE_HIGH_COST_TOOL_OWNER_AUTHORIZATION_REQUIRED",
      message: "Live image generation is blocked pending explicit owner authorization.",
    },
    input_file: {
      code: "LIVE_INPUT_FILE_OWNER_AUTHORIZATION_REQUIRED",
      message:
        "Sending stored artifacts to a live provider is blocked pending explicit owner authorization.",
    },
    realtime: {
      code: "LIVE_REALTIME_OWNER_AUTHORIZATION_REQUIRED",
      message: "Live Realtime authorization is blocked pending explicit owner authorization.",
    },
  } as const;
  throw new OpenAiAdministrationError(policy[capability].code, 403, policy[capability].message);
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function mergeModelCapabilityEvidence(
  discovered: unknown,
  administratorOverride: unknown,
): Partial<AiModelCapabilities> {
  return {
    ...(record(discovered) ?? {}),
    ...(record(administratorOverride) ?? {}),
  } as Partial<AiModelCapabilities>;
}

function hasVerifiedCapabilities(
  value: unknown,
  required: readonly (keyof AiModelCapabilities)[],
): boolean {
  const capabilities = record(value);
  return capabilities !== null && required.every((name) => capabilities[name] === true);
}

function requiredModelId(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/u.test(value)) {
    throw new OpenAiAdministrationError(
      "INVALID_MODEL_ID",
      400,
      "The selected model ID is invalid.",
    );
  }
  return value;
}

function requiredVoice(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)) {
    throw new OpenAiAdministrationError("INVALID_VOICE", 400, "The selected voice is invalid.");
  }
  return value;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new OpenAiAdministrationError(
      "INVALID_PROVIDER_SETTING",
      400,
      "A provider toggle is invalid.",
    );
  }
  return value;
}

function integerValue(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new OpenAiAdministrationError(
      "INVALID_PROVIDER_SETTING",
      400,
      "A provider limit is invalid.",
    );
  }
  return value as number;
}

function numberValue(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new OpenAiAdministrationError(
      "INVALID_PROVIDER_SETTING",
      400,
      "A provider numeric setting is invalid.",
    );
  }
  return value;
}

function enumValue<T extends string>(value: unknown, fallback: T, allowed: readonly T[]): T {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new OpenAiAdministrationError(
      "INVALID_PROVIDER_SETTING",
      400,
      "A provider selection is invalid.",
    );
  }
  return value as T;
}

function boundedText(value: unknown, fallback: string, maximum: number): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string")
    throw new OpenAiAdministrationError(
      "INVALID_PROVIDER_SETTING",
      400,
      "A provider text setting is invalid.",
    );
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized || normalized.length > maximum)
    throw new OpenAiAdministrationError(
      "INVALID_PROVIDER_SETTING",
      400,
      "A provider text setting is invalid.",
    );
  return normalized;
}

function safeConnectionTestFailure(error: unknown): string {
  if (!(error instanceof Error)) return "OpenAI connection test failed.";
  const allowlisted = new Set([
    "Live OpenAI requires Node.js 22 or newer. Demo Mode remains available.",
    "OpenAI API key is not configured.",
    "OpenAI is not configured with a valid server-side API key.",
  ]);
  return allowlisted.has(error.message) ? error.message : "OpenAI connection test failed.";
}

function safeConnectionFailureCode(message: string): string {
  if (message.includes("project key was rejected")) return "OPENAI_KEY_REJECTED";
  if (message.includes("does not have permission")) return "OPENAI_PERMISSION_DENIED";
  if (message.includes("authentication failed")) return "OPENAI_AUTHENTICATION_FAILED";
  if (
    message.includes("quota") ||
    message.includes("billing") ||
    message.includes("rate limited")
  ) {
    return "OPENAI_QUOTA_OR_BILLING_LIMIT";
  }
  if (message.includes("did not respond") || message.includes("timed out")) return "OPENAI_TIMEOUT";
  if (message.includes("returned no models")) return "OPENAI_ZERO_MODELS";
  if (message.includes("rejected the request")) return "OPENAI_PERMISSION_OR_MODEL_UNAVAILABLE";
  if (message.includes("temporarily unavailable")) return "OPENAI_UNAVAILABLE";
  if (message.includes("has not been verified")) return "OPENAI_CAPABILITY_UNVERIFIED";
  return "OPENAI_CONNECTION_TEST_FAILED";
}

function ownerFacingConnectionMessage(message: string): string {
  const code = safeConnectionFailureCode(message);
  if (code === "OPENAI_KEY_REJECTED") return "The OpenAI project key was rejected.";
  if (code === "OPENAI_PERMISSION_DENIED") {
    return "The OpenAI project key does not have permission for this operation or project.";
  }
  if (code === "OPENAI_QUOTA_OR_BILLING_LIMIT") {
    return "The OpenAI project has no available quota, billing capacity, or is currently rate limited.";
  }
  if (code === "OPENAI_TIMEOUT") return "OpenAI did not respond before the configured timeout.";
  if (code === "OPENAI_ZERO_MODELS") {
    return "The credential authenticated, but OpenAI returned no models for this project.";
  }
  if (code === "OPENAI_CAPABILITY_UNVERIFIED") {
    return "The model exists, but the required BEA capability has not been verified.";
  }
  return message;
}

const capabilityKeys = new Set<keyof AiModelCapabilities>([
  "responsesText",
  "streaming",
  "reasoning",
  "functionCalling",
  "structuredOutputs",
  "webSearch",
  "fileSearch",
  "codeInterpreter",
  "imageGeneration",
  "imageInput",
  "fileInput",
  "realtime",
  "audioInput",
  "audioOutput",
  "embeddings",
]);

const providerSettingKeys = new Set([
  "mode",
  "defaultTextModel",
  "defaultRealtimeModel",
  "defaultVoice",
  "webSearchAllowed",
  "webSearchDefault",
  "codeInterpreterAllowed",
  "imageGenerationAllowed",
  "pdfGenerationAllowed",
  "realtimeAllowed",
  "requestTimeoutMs",
  "modelCacheTtlSeconds",
  "dailyRequestLimit",
  "perUserRequestsPerMinute",
  "perConversationRequestsPerMinute",
  "maxUploadBytes",
  "maxGeneratedFileBytes",
  "maxResearchDurationSeconds",
  "codeInterpreterMaxContainerSeconds",
  "imageQuality",
  "defaultChartType",
  "defaultPdfTemplate",
  "artifactRetentionDays",
  "monthlyCostLimitUsd",
  "highCostConfirmationThresholdUsd",
  "realtimeTurnDetection",
  "realtimeInteractionMode",
  "realtimeAllowInterruption",
  "inputTranscriptionModel",
  "realtimeOutputSpeed",
  "realtimeSessionInstructions",
  "realtimeMaxOutputTokens",
  "modelCapabilityOverrides",
  "routingProfile",
]);

const routingCapabilities = new Set<AiRoutingCapability>([
  "responsesText",
  "streaming",
  "reasoning",
  "functionCalling",
  "structuredOutputs",
  "webSearch",
  "fileSearch",
  "codeInterpreter",
  "imageGeneration",
  "imageInput",
  "fileInput",
  "realtime",
  "audioInput",
  "audioOutput",
  "embeddings",
]);

function routingProfileValue(
  value: unknown,
  fallback: AiModelRoutingProfile,
): AiModelRoutingProfile {
  if (value === undefined) return fallback;
  const profile = record(value);
  const routes = record(profile?.routes);
  if (profile?.version !== AI_ROUTING_PROFILE_VERSION || !routes) {
    throw new OpenAiAdministrationError(
      "INVALID_ROUTING_PROFILE",
      400,
      "The AI workload-routing profile is invalid.",
    );
  }
  if (
    Object.keys(routes).length !== AI_WORKLOAD_ROUTE_KEYS.length ||
    Object.keys(routes).some(
      (key) => !AI_WORKLOAD_ROUTE_KEYS.includes(key as (typeof AI_WORKLOAD_ROUTE_KEYS)[number]),
    )
  ) {
    throw new OpenAiAdministrationError(
      "INVALID_ROUTING_PROFILE",
      400,
      "All supported workload routes must be supplied exactly once.",
    );
  }
  for (const routeKey of AI_WORKLOAD_ROUTE_KEYS) {
    const route = record(routes[routeKey]);
    const modelValid = (candidate: unknown): boolean =>
      candidate === null ||
      (typeof candidate === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/u.test(candidate));
    if (
      !route ||
      route.routeKey !== routeKey ||
      !modelValid(route.primaryModel) ||
      !modelValid(route.fallbackModel) ||
      !Array.isArray(route.requiredCapabilities) ||
      route.requiredCapabilities.length > 16 ||
      route.requiredCapabilities.some(
        (capability) =>
          typeof capability !== "string" ||
          !routingCapabilities.has(capability as AiRoutingCapability),
      ) ||
      !["none", "low", "medium", "high"].includes(String(route.reasoningEffort)) ||
      !Number.isSafeInteger(route.maxOutputTokens) ||
      Number(route.maxOutputTokens) < 1 ||
      Number(route.maxOutputTokens) > 128_000 ||
      !Number.isSafeInteger(route.timeoutMs) ||
      Number(route.timeoutMs) < 1_000 ||
      Number(route.timeoutMs) > 600_000 ||
      !Array.isArray(route.toolAllowlist) ||
      route.toolAllowlist.length > 32 ||
      route.toolAllowlist.some(
        (tool) => typeof tool !== "string" || !/^[a-z][a-z0-9_.-]{0,99}$/u.test(tool),
      ) ||
      !["low", "standard", "high"].includes(String(route.costClass)) ||
      (route.maximumEstimatedCostUsd !== null &&
        (typeof route.maximumEstimatedCostUsd !== "number" ||
          !Number.isFinite(route.maximumEstimatedCostUsd) ||
          route.maximumEstimatedCostUsd < 0 ||
          route.maximumEstimatedCostUsd > 10_000)) ||
      !Array.isArray(route.roleAvailability) ||
      route.roleAvailability.length > 32 ||
      route.roleAvailability.some(
        (role) => typeof role !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(role),
      ) ||
      typeof route.enabled !== "boolean"
    ) {
      throw new OpenAiAdministrationError(
        "INVALID_ROUTING_PROFILE",
        400,
        `The ${routeKey} workload route is invalid.`,
      );
    }
    if (route.primaryModel !== null && route.primaryModel === route.fallbackModel) {
      throw new OpenAiAdministrationError(
        "INVALID_ROUTING_PROFILE",
        400,
        `The ${routeKey} fallback must differ from its primary model.`,
      );
    }
  }
  const assignments = profile.vectorStoreAssignments;
  if (
    !Array.isArray(assignments) ||
    assignments.length > 50 ||
    assignments.some((assignmentValue) => {
      const assignment = record(assignmentValue);
      return (
        !assignment ||
        typeof assignment.vectorStoreId !== "string" ||
        !/^vs_[A-Za-z0-9_-]{1,200}$/u.test(assignment.vectorStoreId) ||
        typeof assignment.displayName !== "string" ||
        assignment.displayName.trim().length < 1 ||
        assignment.displayName.length > 200 ||
        !Array.isArray(assignment.allowedRoleKeys) ||
        assignment.allowedRoleKeys.length > 32 ||
        assignment.allowedRoleKeys.some(
          (role) => typeof role !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(role),
        ) ||
        typeof assignment.enabled !== "boolean"
      );
    })
  ) {
    throw new OpenAiAdministrationError(
      "INVALID_VECTOR_STORE_ASSIGNMENTS",
      400,
      "The File Search vector-store assignments are invalid.",
    );
  }
  return JSON.parse(JSON.stringify(value)) as AiModelRoutingProfile;
}

function capabilityOverrides(value: unknown, fallback: JsonObject): JsonObject {
  if (value === undefined) return fallback;
  const overrides = record(value);
  if (!overrides || Object.keys(overrides).length > 100) {
    throw new OpenAiAdministrationError(
      "INVALID_CAPABILITY_OVERRIDES",
      400,
      "Model capability overrides are invalid.",
    );
  }
  for (const [model, capabilityValue] of Object.entries(overrides)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/u.test(model)) {
      throw new OpenAiAdministrationError(
        "INVALID_CAPABILITY_OVERRIDES",
        400,
        "A capability model ID is invalid.",
      );
    }
    const capabilities = record(capabilityValue);
    if (!capabilities)
      throw new OpenAiAdministrationError(
        "INVALID_CAPABILITY_OVERRIDES",
        400,
        "A capability override is invalid.",
      );
    for (const [key, state] of Object.entries(capabilities)) {
      if (
        !capabilityKeys.has(key as keyof AiModelCapabilities) ||
        (state !== true && state !== false && state !== "unknown")
      ) {
        throw new OpenAiAdministrationError(
          "INVALID_CAPABILITY_OVERRIDES",
          400,
          "A capability state is invalid.",
        );
      }
    }
  }
  return overrides as JsonObject;
}

export function parseAiProviderSettings(
  value: unknown,
  current: AiProviderSettings = DEFAULT_AI_PROVIDER_SETTINGS,
): AiProviderSettings {
  const input = record(value);
  if (!input)
    throw new OpenAiAdministrationError(
      "INVALID_PROVIDER_SETTINGS",
      400,
      "Provider settings must be an object.",
    );
  if (
    Object.keys(input).some((key) => /(?:api.?key|secret|credential|access.?token)/iu.test(key))
  ) {
    throw new OpenAiAdministrationError(
      "SECRET_SETTING_REJECTED",
      400,
      "Provider secrets must be configured only through the server secret source.",
    );
  }
  if (Object.keys(input).some((key) => !providerSettingKeys.has(key))) {
    throw new OpenAiAdministrationError(
      "UNKNOWN_PROVIDER_SETTING",
      400,
      "Provider settings contain an unsupported field.",
    );
  }
  const mode = input.mode === undefined ? current.mode : input.mode;
  if (mode !== "demo" && mode !== "openai" && mode !== "hybrid") {
    throw new OpenAiAdministrationError(
      "INVALID_PROVIDER_MODE",
      400,
      "Provider mode must be Demo, OpenAI, or Hybrid.",
    );
  }
  const monthlyCost = input.monthlyCostLimitUsd;
  if (
    monthlyCost !== undefined &&
    monthlyCost !== null &&
    (typeof monthlyCost !== "number" ||
      !Number.isFinite(monthlyCost) ||
      monthlyCost < 0 ||
      monthlyCost > 1_000_000)
  ) {
    throw new OpenAiAdministrationError(
      "INVALID_COST_LIMIT",
      400,
      "The monthly cost-limit seam is invalid.",
    );
  }
  const highCostThreshold = input.highCostConfirmationThresholdUsd;
  if (
    highCostThreshold !== undefined &&
    highCostThreshold !== null &&
    (typeof highCostThreshold !== "number" ||
      !Number.isFinite(highCostThreshold) ||
      highCostThreshold < 0 ||
      highCostThreshold > 1_000_000)
  ) {
    throw new OpenAiAdministrationError(
      "INVALID_COST_LIMIT",
      400,
      "The high-cost confirmation seam is invalid.",
    );
  }
  const transcriptionModel = input.inputTranscriptionModel;
  const resolvedTranscriptionModel =
    transcriptionModel === undefined
      ? current.inputTranscriptionModel
      : transcriptionModel === null
        ? null
        : requiredModelId(transcriptionModel, current.inputTranscriptionModel ?? "");
  return {
    mode,
    defaultTextModel: requiredModelId(input.defaultTextModel, current.defaultTextModel),
    defaultRealtimeModel: requiredModelId(input.defaultRealtimeModel, current.defaultRealtimeModel),
    defaultVoice: requiredVoice(input.defaultVoice, current.defaultVoice),
    webSearchAllowed: booleanValue(input.webSearchAllowed, current.webSearchAllowed),
    webSearchDefault: booleanValue(input.webSearchDefault, current.webSearchDefault),
    codeInterpreterAllowed: booleanValue(
      input.codeInterpreterAllowed,
      current.codeInterpreterAllowed,
    ),
    imageGenerationAllowed: booleanValue(
      input.imageGenerationAllowed,
      current.imageGenerationAllowed,
    ),
    pdfGenerationAllowed: booleanValue(input.pdfGenerationAllowed, current.pdfGenerationAllowed),
    realtimeAllowed: booleanValue(input.realtimeAllowed, current.realtimeAllowed),
    requestTimeoutMs: integerValue(
      input.requestTimeoutMs,
      current.requestTimeoutMs,
      1_000,
      120_000,
    ),
    modelCacheTtlSeconds: integerValue(
      input.modelCacheTtlSeconds,
      current.modelCacheTtlSeconds,
      60,
      86_400,
    ),
    dailyRequestLimit: integerValue(input.dailyRequestLimit, current.dailyRequestLimit, 1, 100_000),
    perUserRequestsPerMinute: integerValue(
      input.perUserRequestsPerMinute,
      current.perUserRequestsPerMinute,
      1,
      1_000,
    ),
    perConversationRequestsPerMinute: integerValue(
      input.perConversationRequestsPerMinute,
      current.perConversationRequestsPerMinute,
      1,
      1_000,
    ),
    maxUploadBytes: integerValue(
      input.maxUploadBytes,
      current.maxUploadBytes,
      1_024,
      MAXIMUM_ARTIFACT_UPLOAD_BYTES,
    ),
    maxGeneratedFileBytes: integerValue(
      input.maxGeneratedFileBytes,
      current.maxGeneratedFileBytes,
      1_024,
      MAX_AI_GENERATED_ARTIFACT_BYTES,
    ),
    maxResearchDurationSeconds: integerValue(
      input.maxResearchDurationSeconds,
      current.maxResearchDurationSeconds,
      10,
      3_600,
    ),
    codeInterpreterMaxContainerSeconds: integerValue(
      input.codeInterpreterMaxContainerSeconds,
      current.codeInterpreterMaxContainerSeconds,
      10,
      3_600,
    ),
    imageQuality: enumValue(input.imageQuality, current.imageQuality, [
      "auto",
      "low",
      "medium",
      "high",
    ]),
    defaultChartType: enumValue(input.defaultChartType, current.defaultChartType, [
      "line",
      "bar",
      "stacked_bar",
      "area",
      "pie_or_donut",
      "scatter",
      "timeline",
      "single_metric",
      "comparison",
    ]),
    defaultPdfTemplate: boundedText(input.defaultPdfTemplate, current.defaultPdfTemplate, 100),
    artifactRetentionDays: integerValue(
      input.artifactRetentionDays,
      current.artifactRetentionDays,
      1,
      90,
    ),
    monthlyCostLimitUsd: monthlyCost === undefined ? current.monthlyCostLimitUsd : monthlyCost,
    highCostConfirmationThresholdUsd:
      highCostThreshold === undefined
        ? current.highCostConfirmationThresholdUsd
        : highCostThreshold,
    realtimeTurnDetection: enumValue(input.realtimeTurnDetection, current.realtimeTurnDetection, [
      "server_vad",
      "semantic_vad",
      "disabled",
    ]),
    realtimeInteractionMode: enumValue(
      input.realtimeInteractionMode,
      current.realtimeInteractionMode,
      ["automatic", "push_to_talk"],
    ),
    realtimeAllowInterruption: booleanValue(
      input.realtimeAllowInterruption,
      current.realtimeAllowInterruption,
    ),
    inputTranscriptionModel: resolvedTranscriptionModel,
    realtimeOutputSpeed: numberValue(
      input.realtimeOutputSpeed,
      current.realtimeOutputSpeed,
      0.25,
      1.5,
    ),
    realtimeSessionInstructions: boundedText(
      input.realtimeSessionInstructions,
      current.realtimeSessionInstructions,
      4_000,
    ),
    realtimeMaxOutputTokens: integerValue(
      input.realtimeMaxOutputTokens,
      current.realtimeMaxOutputTokens,
      1,
      4_096,
    ),
    modelCapabilityOverrides: capabilityOverrides(
      input.modelCapabilityOverrides,
      current.modelCapabilityOverrides,
    ),
    routingProfile: routingProfileValue(input.routingProfile, current.routingProfile),
  };
}

function asJsonValue(settings: AiProviderSettings): JsonValue {
  return JSON.parse(JSON.stringify(settings)) as JsonValue;
}

function overridesFrom(settings: AiProviderSettings): readonly ModelCapabilityOverride[] {
  return Object.entries(settings.modelCapabilityOverrides).flatMap(([model, value]) => {
    const capabilities = record(value);
    return capabilities
      ? [
          {
            provider: "openai",
            model,
            capabilities: capabilities as Partial<AiModelCapabilities>,
          },
        ]
      : [];
  });
}

function modelDto(model: AiModelMetadata) {
  return {
    id: model.id,
    provider: model.provider,
    displayName: model.displayName,
    available: model.available,
    capabilities: model.capabilities,
    capabilitySource: model.capabilitySource,
    validation: model.validation,
  };
}

export async function readOpenAiAdministration(runtime: BeaServerRuntime, userId?: string) {
  const presentationTest = isPhase133ProductionPresentationTest();
  const [settings, lastTest, lastSuccessfulTest, lastFailedTest, cachedModels, connections] =
    await Promise.all([
      runtime.ai.persistence.getProviderSettings(),
      runtime.ai.persistence.latestConnectionTest("openai"),
      runtime.ai.persistence.latestConnectionTestByOutcome("openai", "succeeded"),
      runtime.ai.persistence.latestConnectionTestByOutcome("openai", "failed"),
      runtime.ai.persistence.listCachedModels("openai"),
      runtime.repository.listIntegrationConnections(),
    ]);
  const secret = presentationTest
    ? ({
        status: "not_configured",
        source: "none",
        fingerprint: null,
        protectedStorageAvailable: false,
      } as const)
    : runtime.ai.secrets.describeOpenAiApiKey();
  const voicePreference = userId
    ? await runtime.ai.persistence.getUserVoicePreference(userId)
    : null;
  const visibleCachedModels = presentationTest ? [] : cachedModels;
  const recommendationModels: AiModelMetadata[] = visibleCachedModels.map((model) =>
    mergeUnknownWithFamily({
      id: model.modelId,
      provider: model.provider,
      displayName: model.modelId,
      available: model.available,
      ...(model.ownedBy === null ? {} : { ownedBy: model.ownedBy }),
      capabilities: {
        ...(model.capabilities as unknown as AiModelCapabilities),
        ...(record(settings.modelCapabilityOverrides[model.modelId]) ?? {}),
      },
      capabilitySource: model.capabilitySource,
      validation: model.validation,
    }),
  );
  const recommendedRoutingProfile = recommendProjectAiRoutingProfile(
    settings.routingProfile,
    recommendationModels,
  );
  const secretStatus = secret.status;
  const lastTestMatchesCredential = connectionEvidenceMatchesCredential(
    lastTest,
    secret.fingerprint,
  );
  const evidenceCurrent =
    lastTest?.outcome === "succeeded" &&
    lastTest.authenticated &&
    lastTestMatchesCredential &&
    Date.now() - Date.parse(lastTest.testedAt) <= OPENAI_ACTIVATION_EVIDENCE_MAX_AGE_MS;
  const administrativeInvalidationCode =
    !presentationTest && lastTest?.outcome === "failed" ? lastTest.safeFailureCode : null;
  const connection = connections.find((candidate) => candidate.providerType === "ai");
  const persistedActive =
    !presentationTest &&
    connection?.mode === "live" &&
    connection.connectionStatus === "connected" &&
    connection.requirementStatus === "CONNECTED" &&
    !connection.mockMode;
  const registryConsistent =
    !presentationTest &&
    runtime.ai.registry.has("openai") &&
    runtime.ai.registry.active().providerKey === "openai" &&
    runtime.ai.registry.active().identity.model === settings.defaultTextModel;
  const liveConnected =
    isLiveMode(settings.mode) &&
    secretStatus === "configured" &&
    evidenceCurrent &&
    persistedActive &&
    registryConsistent;
  const providerStatus = presentationTest
    ? ("SETUP_REQUIRED" as const)
    : isOwnerEvaluationRuntime(runtime.environment) || runtime.environment.appMode === "production"
      ? administrativeInvalidationCode === "OPENAI_DISCONNECTED"
        ? ("DISABLED" as const)
        : administrativeInvalidationCode === "OPENAI_KEY_REPLACED"
          ? ("CONFIGURED_NOT_TESTED" as const)
          : !isLiveMode(settings.mode)
            ? ("SETUP_REQUIRED" as const)
            : secretStatus === "not_configured"
              ? ("SETUP_REQUIRED" as const)
              : secretStatus === "invalid"
                ? ("CONNECTION_FAILED" as const)
                : liveConnected
                  ? ("CONNECTED" as const)
                  : lastTestMatchesCredential && lastTest?.outcome === "failed"
                    ? ("CONNECTION_FAILED" as const)
                    : ("CONFIGURED_NOT_TESTED" as const)
      : runtime.environment.appMode === "demo"
        ? ("SIMULATED" as const)
        : administrativeInvalidationCode === "OPENAI_DISCONNECTED"
          ? ("DISABLED" as const)
          : administrativeInvalidationCode === "OPENAI_KEY_REPLACED"
            ? ("CONFIGURED_NOT_TESTED" as const)
            : !isLiveMode(settings.mode)
              ? ("DISABLED" as const)
              : secretStatus === "not_configured"
                ? ("SETUP_REQUIRED" as const)
                : secretStatus === "invalid"
                  ? ("CONNECTION_FAILED" as const)
                  : liveConnected
                    ? ("CONNECTED" as const)
                    : lastTestMatchesCredential && lastTest?.outcome === "failed"
                      ? ("CONNECTION_FAILED" as const)
                      : ("CONFIGURED_NOT_TESTED" as const);
  const progressiveActivation = assessProgressiveActivation({
    authenticated: Boolean(evidenceCurrent),
    models: recommendationModels,
    profile: settings.routingProfile,
    webSearchEnabled: settings.webSearchAllowed && settings.webSearchDefault,
    realtimeEnabled: settings.realtimeAllowed,
    realtimeVoiceSelected: Boolean(settings.defaultVoice),
  });
  const availableModels = visibleCachedModels.filter((model) => model.available);
  const lastSafeError = lastFailedTest?.safeFailureCode ?? lastTest?.safeFailureCode ?? null;
  const diagnostics = {
    credentialSource:
      secret.source === "windows_protected"
        ? "Windows protected key"
        : secret.source === "server_runtime" || secret.source === "environment"
          ? "Server runtime credential"
          : "Not configured",
    credentialConfigured: secretStatus === "configured",
    authenticatedTest:
      lastTestMatchesCredential && lastTest
        ? lastTest.authenticated
          ? "pass"
          : "fail"
        : "not_run",
    modelListRequest:
      lastTestMatchesCredential && lastTest
        ? lastTest.outcome === "succeeded" || lastTest.modelCount !== null
          ? lastTest.safeFailureCode === "OPENAI_ZERO_MODELS" || (lastTest.modelCount ?? 0) >= 0
            ? lastTest.authenticated
              ? "pass"
              : "fail"
            : "fail"
          : "fail"
        : "not_run",
    modelsReturned: lastTest?.modelCount ?? availableModels.length,
    modelsCached: visibleCachedModels.length,
    responsesCandidates: recommendationModels.filter(
      (model) =>
        model.available &&
        (model.capabilities.responsesText === true ||
          model.capabilities.responsesText === "candidate"),
    ).length,
    webSearchCandidates: recommendationModels.filter(
      (model) =>
        model.available &&
        (model.capabilities.webSearch === true || model.capabilities.webSearch === "candidate"),
    ).length,
    realtimeCandidates: recommendationModels.filter(
      (model) =>
        model.available &&
        (model.capabilities.realtime === true || model.capabilities.realtime === "candidate"),
    ).length,
    selectedRouteModels: {
      executive: settings.routingProfile.routes.executive_conversation.primaryModel,
      fast: settings.routingProfile.routes.fast_general_conversation.primaryModel,
      balanced: settings.routingProfile.routes.complex_reasoning_strategy.primaryModel,
      webSearch: settings.routingProfile.routes.public_web_research.primaryModel,
      realtime: settings.routingProfile.routes.realtime_voice.primaryModel,
    },
    activationBlockers: progressiveActivation.activationBlockers,
    lastSafeErrorCode: lastSafeError,
    correlationId: lastTest?.correlationId ?? null,
    lastTestTime: lastTest?.testedAt ?? null,
    providerLatencyMs: lastTest?.latencyMs ?? null,
    zeroModels:
      Boolean(lastTest?.authenticated) && (lastTest?.modelCount ?? availableModels.length) === 0,
  } as const;
  return {
    settings,
    apiKeyStatus: secretStatus,
    apiKeySource: secret.source,
    apiKeyFingerprint: secret.fingerprint,
    protectedStorageAvailable: secret.protectedStorageAvailable,
    serverCredentialAvailable:
      secretStatus === "configured" &&
      (secret.source === "server_runtime" || secret.source === "environment"),
    connectionStatus: presentationTest
      ? "not_configured"
      : administrativeInvalidationCode === "OPENAI_DISCONNECTED"
        ? "disabled"
        : administrativeInvalidationCode === "OPENAI_KEY_REPLACED"
          ? "configured_not_tested"
          : liveConnected
            ? "connected"
            : secretStatus === "invalid"
              ? "invalid"
              : lastTestMatchesCredential && lastTest?.outcome === "failed"
                ? "connection_failed"
                : secretStatus === "configured"
                  ? "configured_not_tested"
                  : "not_configured",
    liveConnected,
    providerStatus,
    capabilityRegistryVersion: OPENAI_CAPABILITY_REGISTRY_VERSION,
    routingProfile: settings.routingProfile,
    recommendedRoutingProfile,
    progressiveActivation,
    diagnostics,
    vectorStoreIds: settings.routingProfile.vectorStoreAssignments
      .filter((assignment) => assignment.enabled)
      .map((assignment) => assignment.vectorStoreId),
    voiceCatalog: listOpenAiVoices(),
    voicePreference,
    lastTest: presentationTest ? null : lastTest,
    lastSuccessfulTest: presentationTest ? null : lastSuccessfulTest,
    lastFailedTest: presentationTest ? null : lastFailedTest,
    cachedModels: visibleCachedModels,
    billingNotice: "OpenAI API billing is separate from ChatGPT subscriptions.",
  };
}

export async function updateAiProviderSettings(input: {
  readonly runtime: BeaServerRuntime;
  readonly actorUserId: string;
  readonly correlationId: string;
  readonly value: unknown;
}): Promise<AiProviderSettings> {
  requireOpenAiLiveAdministrationAllowed();
  const current = await input.runtime.ai.persistence.getProviderSettings();
  const settings = parseAiProviderSettings(input.value, current);
  if (input.runtime.environment.appMode === "production" && settings.mode !== "openai") {
    throw new OpenAiAdministrationError(
      "PRODUCTION_OPENAI_MODE_REQUIRED",
      409,
      "Production provider settings must remain in OpenAI mode.",
    );
  }
  if (isOwnerEvaluationRuntime(input.runtime.environment) && settings.mode === "demo") {
    throw new OpenAiAdministrationError(
      "OWNER_EVALUATION_OPENAI_REQUIRED",
      409,
      "Owner Evaluation cannot use a canned Demo AI provider. Connect OpenAI first.",
    );
  }
  const cachedModels = await input.runtime.ai.persistence.listCachedModels("openai");
  const cachedModelIds = new Set(
    cachedModels.filter((model) => model.available).map((model) => model.modelId),
  );
  const overrideModelIds = Object.keys(settings.modelCapabilityOverrides);
  const capabilityChanges = [
    ...new Set([...Object.keys(current.modelCapabilityOverrides), ...overrideModelIds]),
  ].flatMap((modelId) => {
    const before = record(current.modelCapabilityOverrides[modelId]);
    const after = record(settings.modelCapabilityOverrides[modelId]);
    return [...capabilityKeys].flatMap((capability) => {
      const previousState = before?.[capability];
      const state = after?.[capability];
      return previousState === state
        ? []
        : [
            {
              modelId,
              capability,
              previousState:
                previousState === true || previousState === false || previousState === "unknown"
                  ? previousState
                  : "unset",
              state: state === true || state === false || state === "unknown" ? state : "unset",
            },
          ];
    });
  });
  if (overrideModelIds.some((modelId) => !cachedModelIds.has(modelId))) {
    throw new OpenAiAdministrationError(
      "CAPABILITY_OVERRIDE_MODEL_UNVERIFIED",
      409,
      "Capability verification is allowed only for a currently refreshed provider model.",
    );
  }
  if (
    isLiveMode(current.mode) &&
    [
      settings.defaultTextModel,
      settings.defaultRealtimeModel,
      ...(settings.inputTranscriptionModel ? [settings.inputTranscriptionModel] : []),
    ].some((modelId) => !cachedModelIds.has(modelId))
  ) {
    throw new OpenAiAdministrationError(
      "OPENAI_MODEL_NOT_REFRESHED",
      409,
      "Live OpenAI model selections must exist in the current refreshed model cache.",
    );
  }
  if (!isLiveMode(current.mode) && isLiveMode(settings.mode)) {
    throw new OpenAiAdministrationError(
      "OPENAI_ACTIVATION_REQUIRED",
      409,
      "OpenAI and Hybrid modes can be enabled only through the evidence-gated activation action.",
    );
  }
  const replacementProvider =
    isLiveMode(current.mode) && isLiveMode(settings.mode)
      ? await input.runtime.ai.createOpenAiProvider({
          defaultModel: settings.defaultTextModel,
          capabilityOverrides: overridesFrom(settings),
          timeoutMs: settings.requestTimeoutMs,
          maxRetries: 1,
          connectionEvidenceVerified: true,
        })
      : null;
  if (capabilityChanges.length > 0) {
    await input.runtime.repository.record({
      eventType: "ai-provider.capabilities-attested",
      action: "openai.capabilities.attest",
      outcome: "succeeded",
      actorUserId: input.actorUserId,
      resourceType: "integration-provider",
      resourceId: null,
      correlationId: input.correlationId,
      metadata: {
        provider: "openai",
        changes: capabilityChanges,
      },
    });
  }
  await input.runtime.settings.set({
    key: AI_PROVIDER_SETTINGS_KEY,
    value: asJsonValue(settings),
    actorUserId: input.actorUserId,
    correlationId: input.correlationId,
  });
  if (settings.mode === "demo") {
    input.runtime.ai.registry.activate("demo");
    await input.runtime.ai.persistence.activateDemo(input.actorUserId);
  }
  if (replacementProvider) {
    if (input.runtime.ai.registry.has("openai")) {
      input.runtime.ai.registry.replace(replacementProvider);
    } else {
      input.runtime.ai.registry.register(replacementProvider);
    }
    input.runtime.ai.registry.activate("openai");
  }
  return settings;
}

async function cacheModels(
  runtime: BeaServerRuntime,
  settings: AiProviderSettings,
  models: readonly AiModelMetadata[],
): Promise<void> {
  const fetchedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + settings.modelCacheTtlSeconds * 1000).toISOString();
  await runtime.ai.persistence.replaceModelCache({
    provider: "openai",
    models: models.map((model) => ({
      provider: "openai",
      modelId: model.id,
      available: model.available,
      ownedBy: model.ownedBy ?? null,
      capabilities: JSON.parse(JSON.stringify(model.capabilities)) as JsonObject,
      capabilitySource: model.capabilitySource,
      validation: model.validation,
      fetchedAt,
      expiresAt,
    })),
  });
}

export async function testOpenAiConnection(input: {
  readonly runtime: BeaServerRuntime;
  readonly actorUserId: string;
  readonly correlationId: string;
}): Promise<AiProviderConnectionTest> {
  requireOpenAiLiveAdministrationAllowed();
  const startedAt = performance.now();
  const settings = await input.runtime.ai.persistence.getProviderSettings();
  const credentialBeforeTest = input.runtime.ai.secrets.describeOpenAiApiKey();
  let outcome: Awaited<ReturnType<AiCommandProvider["testConnection"]>>;
  let discoveredModels: readonly AiModelMetadata[] | null = null;
  try {
    const provider = await input.runtime.ai.createOpenAiProvider({
      defaultModel: settings.defaultTextModel,
      capabilityOverrides: overridesFrom(settings),
      timeoutMs: settings.requestTimeoutMs,
      maxRetries: 0,
    });
    outcome = await provider.testConnection({ timeoutMs: settings.requestTimeoutMs });
    if (outcome.healthy && outcome.authenticated) {
      discoveredModels = await provider.listModels({ timeoutMs: settings.requestTimeoutMs });
    }
  } catch (error) {
    outcome = {
      provider: "openai",
      healthy: false,
      authenticated: false,
      testedAt: new Date().toISOString(),
      safeMessage: safeConnectionTestFailure(error),
    };
  }
  const credentialAfterTest = input.runtime.ai.secrets.describeOpenAiApiKey();
  const credentialFingerprint =
    credentialBeforeTest.status === "configured" &&
    credentialAfterTest.status === "configured" &&
    credentialBeforeTest.fingerprint !== null &&
    credentialBeforeTest.fingerprint === credentialAfterTest.fingerprint
      ? credentialBeforeTest.fingerprint
      : null;
  if (outcome.healthy && outcome.authenticated && credentialFingerprint === null) {
    outcome = {
      ...outcome,
      healthy: false,
      authenticated: false,
      safeMessage: "The OpenAI credential changed during connection testing. Run the test again.",
    };
    discoveredModels = null;
  }
  const connectionOutcome = outcome.healthy && outcome.authenticated ? "succeeded" : "failed";
  const modelCount = outcome.modelCount ?? discoveredModels?.length;
  const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
  await input.runtime.repository.record({
    eventType: "ai-provider.connection-tested",
    action: "openai.connection.test",
    outcome: connectionOutcome,
    actorUserId: input.actorUserId,
    resourceType: "integration-provider",
    resourceId: null,
    correlationId: input.correlationId,
    metadata: {
      provider: "openai",
      authenticated: outcome.authenticated,
      latencyMs,
      ...(modelCount === undefined ? {} : { modelCount }),
    },
  });
  if (discoveredModels !== null) {
    await cacheModels(input.runtime, settings, discoveredModels);
  }
  return input.runtime.ai.persistence.recordConnectionTest({
    provider: "openai",
    actorUserId: input.actorUserId,
    outcome: connectionOutcome,
    authenticated: outcome.authenticated,
    ...(!outcome.healthy
      ? { safeFailureCode: safeConnectionFailureCode(outcome.safeMessage) }
      : {}),
    safeMessage: outcome.safeMessage,
    ...(modelCount === undefined ? {} : { modelCount }),
    latencyMs,
    credentialFingerprint,
    correlationId: input.correlationId,
    testedAt: outcome.testedAt,
  });
}

export async function refreshOpenAiModels(input: {
  readonly runtime: BeaServerRuntime;
  readonly actorUserId: string;
  readonly correlationId: string;
}): Promise<readonly AiModelMetadata[]> {
  requireOpenAiLiveAdministrationAllowed();
  const settings = await input.runtime.ai.persistence.getProviderSettings();
  const provider = await input.runtime.ai.createOpenAiProvider({
    defaultModel: settings.defaultTextModel,
    capabilityOverrides: overridesFrom(settings),
    timeoutMs: settings.requestTimeoutMs,
    maxRetries: 1,
  });
  const models = await provider.listModels({ timeoutMs: settings.requestTimeoutMs });
  await input.runtime.repository.record({
    eventType: "ai-provider.models-refreshed",
    action: "openai.models.refresh",
    outcome: "succeeded",
    actorUserId: input.actorUserId,
    resourceType: "integration-provider",
    correlationId: input.correlationId,
    metadata: { provider: "openai", modelCount: models.length },
  });
  await cacheModels(input.runtime, settings, models);
  return models;
}

async function invalidateOpenAiActivation(input: {
  readonly runtime: BeaServerRuntime;
  readonly actorUserId: string;
  readonly correlationId: string;
  readonly failureCode: "OPENAI_KEY_REPLACED" | "OPENAI_DISCONNECTED";
  readonly safeMessage: string;
  readonly auditAction: "openai.secret.replace" | "openai.disconnect";
  readonly credentialFingerprint: string | null;
}): Promise<void> {
  const current = await input.runtime.ai.persistence.getProviderSettings();
  const liveOnly = requiresLiveOpenAiProvider(input.runtime.environment);
  if (liveOnly) {
    input.runtime.ai.registry.replace(
      new UnavailableOpenAiProvider(
        input.failureCode === "OPENAI_DISCONNECTED" ? "SETUP_REQUIRED" : "CONFIGURED_NOT_TESTED",
      ),
    );
  } else if (input.runtime.environment.appMode === "demo") {
    input.runtime.ai.registry.activate("demo");
  } else {
    input.runtime.ai.registry.replace(
      new UnavailableOpenAiProvider(
        input.failureCode === "OPENAI_DISCONNECTED" ? "SETUP_REQUIRED" : "CONFIGURED_NOT_TESTED",
      ),
    );
  }
  const settings = {
    ...current,
    mode: liveOnly ? ("openai" as const) : ("demo" as const),
  };
  await input.runtime.settings.set({
    key: AI_PROVIDER_SETTINGS_KEY,
    value: asJsonValue(settings),
    actorUserId: input.actorUserId,
    correlationId: input.correlationId,
  });
  if (liveOnly) {
    await input.runtime.ai.persistence.deactivateOpenAiProduction({
      actorUserId: input.actorUserId,
      configured: input.failureCode !== "OPENAI_DISCONNECTED",
    });
  } else if (input.runtime.environment.appMode === "demo") {
    await input.runtime.ai.persistence.activateDemo(input.actorUserId);
  } else {
    await input.runtime.ai.persistence.deactivateOpenAiProduction({
      actorUserId: input.actorUserId,
      configured: input.failureCode !== "OPENAI_DISCONNECTED",
    });
  }
  await input.runtime.ai.persistence.recordConnectionTest({
    provider: "openai",
    actorUserId: input.actorUserId,
    outcome: "failed",
    authenticated: false,
    safeFailureCode: input.failureCode,
    safeMessage: input.safeMessage,
    latencyMs: 0,
    credentialFingerprint: input.credentialFingerprint,
    correlationId: input.correlationId,
  });
  await input.runtime.repository.record({
    eventType:
      input.auditAction === "openai.disconnect"
        ? "ai-provider.disconnected"
        : "ai-provider.secret-replaced",
    action: input.auditAction,
    outcome: "succeeded",
    actorUserId: input.actorUserId,
    resourceType: "integration-provider",
    resourceId: null,
    correlationId: input.correlationId,
    metadata: { provider: "openai", activationInvalidated: true },
  });
}

export async function configureOpenAiSecret(input: {
  readonly runtime: BeaServerRuntime;
  readonly actorUserId: string;
  readonly correlationId: string;
  readonly apiKey: unknown;
}): Promise<void> {
  requireOpenAiLiveAdministrationAllowed();
  if (typeof input.apiKey !== "string" || !validOpenAiKey(input.apiKey.trim())) {
    throw new OpenAiAdministrationError(
      "INVALID_OPENAI_API_KEY",
      400,
      "Enter a valid OpenAI API key without whitespace.",
    );
  }
  if (!input.runtime.ai.secrets.status().windowsProtectedStorageAvailable) {
    throw new OpenAiAdministrationError(
      "PROTECTED_SECRET_STORAGE_UNAVAILABLE",
      409,
      "Windows protected storage is unavailable. Save the OpenAI key inside the application on Windows Owner Evaluation. Do not paste the key into a file, terminal, or environment variable.",
    );
  }
  let credentialFingerprint: string | null;
  try {
    credentialFingerprint = input.runtime.ai.secrets.storeOpenAiApiKey(
      input.apiKey.trim(),
    ).fingerprint;
  } catch {
    throw new OpenAiAdministrationError(
      "PROTECTED_SECRET_STORAGE_FAILED",
      500,
      "The OpenAI API key could not be saved in Windows protected storage.",
    );
  }
  await invalidateOpenAiActivation({
    runtime: input.runtime,
    actorUserId: input.actorUserId,
    correlationId: input.correlationId,
    failureCode: "OPENAI_KEY_REPLACED",
    safeMessage: "The OpenAI API key was replaced. Run a new authenticated connection test.",
    auditAction: "openai.secret.replace",
    credentialFingerprint,
  });
}

export async function disconnectOpenAi(input: {
  readonly runtime: BeaServerRuntime;
  readonly actorUserId: string;
  readonly correlationId: string;
}): Promise<void> {
  requireOpenAiLiveAdministrationAllowed();
  let credentialFingerprint: string | null;
  try {
    credentialFingerprint = input.runtime.ai.secrets.deleteProtectedOpenAiApiKey().fingerprint;
  } catch {
    throw new OpenAiAdministrationError(
      "PROTECTED_SECRET_DELETE_FAILED",
      500,
      "The protected OpenAI API key could not be deleted.",
    );
  }
  await invalidateOpenAiActivation({
    runtime: input.runtime,
    actorUserId: input.actorUserId,
    correlationId: input.correlationId,
    failureCode: "OPENAI_DISCONNECTED",
    safeMessage:
      "OpenAI was disconnected. Environment-managed configuration, if present, remains owner-managed.",
    auditAction: "openai.disconnect",
    credentialFingerprint,
  });
}

export async function activateOpenAiProvider(input: {
  readonly runtime: BeaServerRuntime;
  readonly actorUserId: string;
  readonly correlationId: string;
  readonly mode?: "openai" | "hybrid";
}): Promise<void> {
  requireOpenAiLiveAdministrationAllowed();
  const secret = input.runtime.ai.secrets.describeOpenAiApiKey();
  if (secret.status !== "configured" || secret.fingerprint === null) {
    throw new OpenAiAdministrationError(
      "OPENAI_KEY_NOT_CONFIGURED",
      409,
      "A valid server-side OpenAI API key is required.",
    );
  }
  const [settingsSnapshot, evidence, models] = await Promise.all([
    input.runtime.ai.persistence.getProviderSettingsSnapshot(),
    input.runtime.ai.persistence.latestConnectionTest("openai"),
    input.runtime.ai.persistence.listCachedModels("openai"),
  ]);
  const settings = settingsSnapshot.settings;
  if (
    !evidence ||
    evidence.outcome !== "succeeded" ||
    !evidence.authenticated ||
    Date.now() - Date.parse(evidence.testedAt) > OPENAI_ACTIVATION_EVIDENCE_MAX_AGE_MS
  ) {
    throw new OpenAiAdministrationError(
      "OPENAI_TEST_REQUIRED",
      409,
      "A recent successful authenticated connection test is required.",
    );
  }
  if (!connectionEvidenceMatchesCredential(evidence, secret.fingerprint)) {
    throw new OpenAiAdministrationError(
      "OPENAI_CREDENTIAL_EVIDENCE_STALE",
      409,
      "Run a new authenticated connection test for the current OpenAI credential.",
    );
  }
  const selectedModel = models.find(
    (model) => model.modelId === settings.defaultTextModel && model.available,
  );
  const selectedCapabilities = selectedModel
    ? {
        ...selectedModel.capabilities,
        ...(record(settings.modelCapabilityOverrides[selectedModel.modelId]) ?? {}),
      }
    : null;
  if (
    !selectedModel ||
    !hasVerifiedCapabilities(selectedCapabilities, ["responsesText", "streaming"])
  ) {
    throw new OpenAiAdministrationError(
      "OPENAI_MODEL_INCOMPATIBLE",
      409,
      "The selected text model is unavailable or its required Responses capabilities are not verified.",
    );
  }
  const provider = await input.runtime.ai.createOpenAiProvider({
    defaultModel: settings.defaultTextModel,
    capabilityOverrides: overridesFrom(settings),
    timeoutMs: settings.requestTimeoutMs,
    maxRetries: 1,
    connectionEvidenceVerified: true,
  });
  const updatedSettings = {
    ...settings,
    mode:
      requiresLiveOpenAiProvider(input.runtime.environment) || input.mode === "openai"
        ? ("openai" as const)
        : (input.mode ?? ("openai" as const)),
  };
  const authorizationAudit = await input.runtime.repository.record({
    eventType: "ai-provider.activation-authorized",
    action: "openai.activate",
    outcome: "allowed",
    actorUserId: input.actorUserId,
    resourceType: "integration-provider",
    correlationId: input.correlationId,
    metadata: {
      provider: "openai",
      evidenceId: evidence.id,
      credentialFingerprint: secret.fingerprint,
      model: settings.defaultTextModel,
      operatingMode: updatedSettings.mode,
    },
  });
  try {
    if (input.runtime.ai.registry.has("openai")) input.runtime.ai.registry.replace(provider);
    else input.runtime.ai.registry.register(provider);
    const activated = await input.runtime.ai.persistence.activateOpenAiAtomically({
      actorUserId: input.actorUserId,
      evidenceId: evidence.id,
      credentialFingerprint: secret.fingerprint,
      settings: updatedSettings,
      expectedSettingsVersion: settingsSnapshot.version,
      correlationId: input.correlationId,
      authorizationAuditId: authorizationAudit.id,
    });
    if (!activated) {
      throw new OpenAiAdministrationError(
        "OPENAI_ACTIVATION_FAILED",
        409,
        "OpenAI activation evidence was rejected.",
      );
    }
    input.runtime.ai.registry.activate("openai");
  } catch (error) {
    if (
      requiresLiveOpenAiProvider(input.runtime.environment) ||
      input.runtime.environment.appMode !== "demo"
    ) {
      input.runtime.ai.registry.replace(new UnavailableOpenAiProvider("CONNECTION_FAILED"));
    } else {
      input.runtime.ai.registry.activate("demo");
    }
    throw error;
  }
}

export async function connectOpenAiAndDiscover(input: {
  readonly runtime: BeaServerRuntime;
  readonly actorUserId: string;
  readonly correlationId: string;
  readonly apiKey?: unknown;
  readonly useExistingCredential?: boolean;
}): Promise<Awaited<ReturnType<typeof readOpenAiAdministration>>> {
  if (input.useExistingCredential) {
    const existing = input.runtime.ai.secrets.describeOpenAiApiKey();
    if (existing.status !== "configured") {
      throw new OpenAiAdministrationError(
        "OPENAI_KEY_NOT_CONFIGURED",
        409,
        "A server runtime credential is not available. Save a project key on Windows Owner Evaluation or provide OPENAI_API_KEY to the Cloud runtime.",
      );
    }
  } else {
    await configureOpenAiSecret({
      runtime: input.runtime,
      actorUserId: input.actorUserId,
      correlationId: input.correlationId,
      apiKey: input.apiKey,
    });
  }
  const test = await testOpenAiConnection({
    runtime: input.runtime,
    actorUserId: input.actorUserId,
    correlationId: input.correlationId,
  });
  if (!test.authenticated) {
    throw new OpenAiAdministrationError(
      "OPENAI_CONNECTION_FAILED",
      409,
      ownerFacingConnectionMessage(
        test.safeMessage ||
          "OpenAI connection test failed. The key was stored but is not connected.",
      ),
    );
  }
  const models = await input.runtime.ai.persistence.listCachedModels("openai");
  const current = await input.runtime.ai.persistence.getProviderSettings();
  const recommendationModels: AiModelMetadata[] = models.map((model) =>
    mergeUnknownWithFamily({
      id: model.modelId,
      provider: model.provider,
      displayName: model.modelId,
      available: model.available,
      ...(model.ownedBy === null ? {} : { ownedBy: model.ownedBy }),
      capabilities: {
        ...(model.capabilities as unknown as AiModelCapabilities),
        ...(record(current.modelCapabilityOverrides[model.modelId]) ?? {}),
      },
      capabilitySource: model.capabilitySource,
      validation: model.validation,
    }),
  );
  const recommended = recommendProjectAiRoutingProfile(
    current.routingProfile,
    recommendationModels,
  );
  const executiveModel = recommended.routes.executive_conversation.primaryModel;
  const realtimeModel = recommended.routes.realtime_voice.primaryModel;
  const researchEnabled = Boolean(recommended.routes.public_web_research.primaryModel);
  const realtimeAllowed = Boolean(realtimeModel);
  const nextSettings: AiProviderSettings = {
    ...current,
    defaultTextModel: executiveModel ?? current.defaultTextModel,
    defaultRealtimeModel: realtimeModel ?? current.defaultRealtimeModel,
    routingProfile: recommended,
    webSearchAllowed: current.webSearchAllowed || researchEnabled,
    webSearchDefault: current.webSearchDefault,
    realtimeAllowed: current.realtimeAllowed || realtimeAllowed,
    pdfGenerationAllowed: true,
  };
  await input.runtime.settings.set({
    key: AI_PROVIDER_SETTINGS_KEY,
    value: asJsonValue(nextSettings),
    actorUserId: input.actorUserId,
    correlationId: input.correlationId,
  });
  const executive = recommendationModels.find((model) => model.id === executiveModel);
  const textVerified =
    executive !== undefined &&
    executive.available &&
    executive.capabilities.responsesText === true &&
    executive.capabilities.streaming === true;
  if (textVerified) {
    try {
      await activateOpenAiProvider({
        runtime: input.runtime,
        actorUserId: input.actorUserId,
        correlationId: input.correlationId,
        mode: "openai",
      });
    } catch (error) {
      if (
        error instanceof OpenAiAdministrationError &&
        error.code === "OPENAI_MODEL_INCOMPATIBLE"
      ) {
        return readOpenAiAdministration(input.runtime);
      }
      throw error;
    }
  }
  return readOpenAiAdministration(input.runtime);
}

export async function verifyOpenAiSelectedModels(input: {
  readonly runtime: BeaServerRuntime;
  readonly actorUserId: string;
  readonly correlationId: string;
}): Promise<Awaited<ReturnType<typeof readOpenAiAdministration>>> {
  requireOpenAiLiveAdministrationAllowed();
  const settings = await input.runtime.ai.persistence.getProviderSettings();
  const cached = await input.runtime.ai.persistence.listCachedModels("openai");
  const models: AiModelMetadata[] = cached.map((model) =>
    mergeUnknownWithFamily({
      id: model.modelId,
      provider: model.provider,
      displayName: model.modelId,
      available: model.available,
      ...(model.ownedBy === null ? {} : { ownedBy: model.ownedBy }),
      capabilities: {
        ...(model.capabilities as unknown as AiModelCapabilities),
        ...(record(settings.modelCapabilityOverrides[model.modelId]) ?? {}),
      },
      capabilitySource: model.capabilitySource,
      validation: model.validation,
    }),
  );
  const recommended = recommendProjectAiRoutingProfile(settings.routingProfile, models);
  const provider = await input.runtime.ai.createOpenAiProvider({
    defaultModel:
      recommended.routes.executive_conversation.primaryModel ?? settings.defaultTextModel,
    capabilityOverrides: overridesFrom(settings),
    timeoutMs: Math.min(settings.requestTimeoutMs, 30_000),
    maxRetries: 0,
  });
  const probe = provider as typeof provider & {
    probeSelectedCapabilities?: (value: {
      readonly models: readonly AiModelMetadata[];
      readonly assignedModelIds: readonly (string | null | undefined)[];
    }) => Promise<readonly import("@bea/ai").CapabilityEvidenceRecord[]>;
  };
  const assigned = [
    recommended.routes.executive_conversation.primaryModel,
    recommended.routes.fast_general_conversation.primaryModel,
    recommended.routes.public_web_research.primaryModel,
    recommended.routes.realtime_voice.primaryModel,
  ];
  const evidenceRecords = probe.probeSelectedCapabilities
    ? await probe.probeSelectedCapabilities({ models, assignedModelIds: assigned })
    : await probeOpenAiRouteCandidates({
        client: (provider as unknown as { client: import("@bea/ai").OpenAiSdkClient }).client,
        models,
        assignedModelIds: assigned,
      });
  const overrides = { ...settings.modelCapabilityOverrides };
  for (const model of models) {
    const updated = applyCapabilityEvidence(model.capabilities, evidenceRecords, model.id);
    const attested = Object.fromEntries(
      Object.entries(updated).filter(([, state]) => state === true || state === false),
    );
    if (Object.keys(attested).length > 0) {
      overrides[model.id] = {
        ...(record(overrides[model.id]) ?? {}),
        ...attested,
      };
    }
  }
  await cacheModels(
    input.runtime,
    settings,
    models.map((model) => ({
      ...model,
      capabilities: applyCapabilityEvidence(model.capabilities, evidenceRecords, model.id),
      capabilitySource: evidenceRecords.some((record) => record.modelId === model.id)
        ? "probe"
        : model.capabilitySource,
    })),
  );
  await input.runtime.settings.set({
    key: AI_PROVIDER_SETTINGS_KEY,
    value: asJsonValue({
      ...settings,
      routingProfile: recommended,
      defaultTextModel:
        recommended.routes.executive_conversation.primaryModel ?? settings.defaultTextModel,
      defaultRealtimeModel:
        recommended.routes.realtime_voice.primaryModel ?? settings.defaultRealtimeModel,
      modelCapabilityOverrides: overrides,
    }),
    actorUserId: input.actorUserId,
    correlationId: input.correlationId,
  });
  await input.runtime.repository.record({
    eventType: "ai-provider.capabilities-probed",
    action: "openai.capabilities.verify",
    outcome: "succeeded",
    actorUserId: input.actorUserId,
    resourceType: "integration-provider",
    correlationId: input.correlationId,
    metadata: {
      provider: "openai",
      evidenceCount: evidenceRecords.length,
      modelIds: [...new Set(evidenceRecords.map((record) => record.modelId))],
    },
  });
  await input.runtime.ai.persistence.upsertCapabilityEvidence(evidenceRecords);
  const refreshed = await readOpenAiAdministration(input.runtime);
  if (refreshed.progressiveActivation.liveTextReady && !refreshed.liveConnected) {
    try {
      await activateOpenAiProvider({
        runtime: input.runtime,
        actorUserId: input.actorUserId,
        correlationId: input.correlationId,
        mode: "openai",
      });
      return readOpenAiAdministration(input.runtime);
    } catch (error) {
      if (
        error instanceof OpenAiAdministrationError &&
        error.code === "OPENAI_MODEL_INCOMPATIBLE"
      ) {
        return refreshed;
      }
      throw error;
    }
  }
  return refreshed;
}

export async function resolveAiCommandProvider(
  runtime: BeaServerRuntime,
): Promise<AiCommandProvider> {
  requireOpenAiLiveAdministrationAllowed();
  const settings = await runtime.ai.persistence.getProviderSettings();
  if (!isLiveMode(settings.mode)) {
    if (
      runtime.environment.appMode === "demo" &&
      !requiresLiveOpenAiProvider(runtime.environment) &&
      !productionRejectsDemoFallback(
        runtime.environment.appMode,
        "demo",
        runtime.environment.deploymentProfile,
      )
    ) {
      return runtime.ai.registry.activate("demo");
    }
    throw new OpenAiAdministrationError(
      "OPENAI_SETUP_REQUIRED",
      409,
      "OpenAI is not connected. Connect OpenAI before using AI Command.",
    );
  }
  const secret = runtime.ai.secrets.describeOpenAiApiKey();
  if (secret.status !== "configured" || secret.fingerprint === null) {
    throw new OpenAiAdministrationError(
      "OPENAI_NOT_ACTIVE",
      409,
      "OpenAI setup required. Configure and test a server-side project API key.",
    );
  }
  const [evidence, connections] = await Promise.all([
    runtime.ai.persistence.latestConnectionTest("openai"),
    runtime.repository.listIntegrationConnections(),
  ]);
  const connection = connections.find((candidate) => candidate.providerType === "ai");
  if (
    !evidence ||
    evidence.outcome !== "succeeded" ||
    !evidence.authenticated ||
    !connectionEvidenceMatchesCredential(evidence, secret.fingerprint) ||
    Date.now() - Date.parse(evidence.testedAt) > OPENAI_ACTIVATION_EVIDENCE_MAX_AGE_MS ||
    connection?.mode !== "live" ||
    connection.connectionStatus !== "connected" ||
    connection.requirementStatus !== "CONNECTED" ||
    connection.mockMode
  ) {
    throw new OpenAiAdministrationError(
      "OPENAI_NOT_ACTIVE",
      409,
      "OpenAI is not active. Run a current connection test and activate the verified configuration.",
    );
  }
  if (
    !runtime.ai.registry.has("openai") ||
    runtime.ai.registry.get("openai").identity.model !== settings.defaultTextModel
  ) {
    const provider = await runtime.ai.createOpenAiProvider({
      defaultModel: settings.defaultTextModel,
      capabilityOverrides: overridesFrom(settings),
      timeoutMs: settings.requestTimeoutMs,
      maxRetries: 1,
      connectionEvidenceVerified: true,
    });
    if (runtime.ai.registry.has("openai")) runtime.ai.registry.replace(provider);
    else runtime.ai.registry.register(provider);
  }
  return runtime.ai.registry.activate("openai");
}

export function safeModelDtos(models: readonly AiModelMetadata[]) {
  return models.map(modelDto);
}
