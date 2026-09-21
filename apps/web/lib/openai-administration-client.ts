import type {
  AiModelCacheRecord,
  AiModelRoutingProfile,
  AiProviderConnectionTest,
  AiProviderSettings,
  AiUserVoicePreference,
} from "@bea/domain";

export const OPENAI_ADMINISTRATION_ENDPOINTS = Object.freeze({
  activate: "/api/integrations/ai/activate",
  connect: "/api/integrations/ai/connect",
  models: "/api/integrations/ai/models",
  preferences: "/api/ai-command/realtime/preferences",
  routeTest: "/api/integrations/ai/routes/test",
  secret: "/api/integrations/ai/secret",
  settings: "/api/integrations/ai/settings",
  test: "/api/integrations/ai/test",
  verify: "/api/integrations/ai/verify",
});

export type OpenAiCapabilityState = true | false | "unknown" | "candidate";

export interface OpenAiModelOption {
  readonly id: string;
  readonly displayName: string;
  readonly available: boolean;
  readonly capabilities: Readonly<Record<string, OpenAiCapabilityState>>;
  readonly capabilitySource:
    "provider" | "configured" | "demo_fixture" | "unknown" | "registry" | "probe";
}

export interface OpenAiAdministrationView {
  readonly settings: AiProviderSettings;
  readonly apiKeyStatus: "not_configured" | "configured" | "invalid";
  readonly apiKeySource: "none" | "environment" | "windows_protected" | "server_runtime";
  readonly apiKeyFingerprint: string | null;
  readonly protectedStorageAvailable: boolean;
  readonly serverCredentialAvailable?: boolean;
  readonly connectionStatus:
    | "connected"
    | "connection_failed"
    | "invalid"
    | "configured_not_tested"
    | "disabled"
    | "not_configured";
  readonly liveConnected: boolean;
  readonly providerStatus:
    | "SIMULATED"
    | "SETUP_REQUIRED"
    | "CONFIGURED_NOT_TESTED"
    | "TESTING"
    | "CONNECTED"
    | "CONNECTION_FAILED"
    | "DISABLED";
  readonly capabilityRegistryVersion: string;
  readonly routingProfile: AiModelRoutingProfile;
  readonly recommendedRoutingProfile: AiModelRoutingProfile;
  readonly vectorStoreIds: readonly string[];
  readonly voiceCatalog: readonly {
    readonly id: string;
    readonly displayName: string;
    readonly description: string;
    readonly source: "built_in" | "approved_custom";
    readonly previewAvailable: boolean;
  }[];
  readonly voicePreference: AiUserVoicePreference | null;
  readonly lastTest: AiProviderConnectionTest | null;
  readonly lastSuccessfulTest: AiProviderConnectionTest | null;
  readonly lastFailedTest: AiProviderConnectionTest | null;
  readonly cachedModels: readonly AiModelCacheRecord[];
  readonly billingNotice: string;
  readonly progressiveActivation?: {
    readonly liveText: string;
    readonly publicWebResearch: string;
    readonly realtimeVoice: string;
    readonly pdfAndArtifacts: string;
    readonly liveTextReady: boolean;
    readonly researchReady: boolean;
    readonly realtimeReady: boolean;
    readonly activationBlockers: readonly string[];
    readonly routes?: readonly {
      readonly routeKey: string;
      readonly selectedModel: string | null;
      readonly fallbackModel: string | null;
      readonly level: string;
      readonly verifiedCapabilities: readonly string[];
      readonly unresolvedCapabilities: readonly string[];
      readonly reason: string;
      readonly costClass: string;
    }[];
  };
  readonly diagnostics?: {
    readonly credentialSource: string;
    readonly credentialConfigured: boolean;
    readonly authenticatedTest: "pass" | "fail" | "not_run";
    readonly modelListRequest: "pass" | "fail" | "not_run";
    readonly modelsReturned: number;
    readonly modelsCached: number;
    readonly responsesCandidates: number;
    readonly webSearchCandidates: number;
    readonly realtimeCandidates: number;
    readonly selectedRouteModels: Readonly<Record<string, string | null>>;
    readonly activationBlockers: readonly string[];
    readonly lastSafeErrorCode: string | null;
    readonly correlationId: string | null;
    readonly lastTestTime: string | null;
    readonly providerLatencyMs: number | null;
    readonly zeroModels: boolean;
  };
}

export const OPENAI_ACTIVATION_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

const textCapabilities = ["responsesText", "streaming"] as const;
const realtimeCapabilities = ["realtime", "audioInput", "audioOutput"] as const;
const transcriptionCapabilities = ["audioInput"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function capabilityState(value: unknown): OpenAiCapabilityState {
  return value === true || value === false || value === "candidate" ? value : "unknown";
}

export function normalizeOpenAiModel(value: unknown): OpenAiModelOption | null {
  if (!isRecord(value)) return null;
  const id =
    typeof value.modelId === "string"
      ? value.modelId.trim()
      : typeof value.id === "string"
        ? value.id.trim()
        : "";
  if (!id || id.length > 255) return null;
  const rawCapabilities = isRecord(value.capabilities) ? value.capabilities : {};
  const capabilities = Object.fromEntries(
    [
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
    ].map((name) => [name, capabilityState(rawCapabilities[name])]),
  ) as Record<string, OpenAiCapabilityState>;
  const source = value.capabilitySource;
  return {
    id,
    displayName:
      typeof value.displayName === "string" && value.displayName.trim()
        ? value.displayName.trim()
        : id,
    available: value.available === true,
    capabilities,
    capabilitySource:
      source === "provider" ||
      source === "configured" ||
      source === "demo_fixture" ||
      source === "unknown" ||
      source === "registry" ||
      source === "probe"
        ? source
        : "unknown",
  };
}

export function normalizeOpenAiModels(values: readonly unknown[]): readonly OpenAiModelOption[] {
  const byId = new Map<string, OpenAiModelOption>();
  for (const value of values) {
    const model = normalizeOpenAiModel(value);
    if (model) byId.set(model.id, model);
  }
  return [...byId.values()].sort((left, right) =>
    left.displayName.localeCompare(right.displayName),
  );
}

export type OpenAiModelPurpose = "text" | "realtime" | "transcription";

export function modelCapabilityWarning(
  model: OpenAiModelOption | undefined,
  purpose: OpenAiModelPurpose,
): string | null {
  if (!model) return "This model is not present in the current provider model cache.";
  if (!model.available) return "The provider reports that this model is unavailable.";
  const required =
    purpose === "text"
      ? textCapabilities
      : purpose === "realtime"
        ? realtimeCapabilities
        : transcriptionCapabilities;
  const falseCapabilities = required.filter((name) => model.capabilities[name] === false);
  if (falseCapabilities.length > 0) {
    return `Verified incompatible: ${falseCapabilities.join(", ")}.`;
  }
  const unknownCapabilities = required.filter((name) => model.capabilities[name] !== true);
  if (unknownCapabilities.length > 0) {
    return `Compatibility is unverified: ${unknownCapabilities.join(", ")}.`;
  }
  return null;
}

export function modelSupportsPurpose(
  model: OpenAiModelOption | undefined,
  purpose: OpenAiModelPurpose,
): boolean {
  return modelCapabilityWarning(model, purpose) === null;
}

export function modelWithCapabilityOverrides(
  model: OpenAiModelOption | undefined,
  overrides: AiProviderSettings["modelCapabilityOverrides"],
): OpenAiModelOption | undefined {
  if (!model) return undefined;
  const value = overrides[model.id];
  if (!isRecord(value)) return model;
  const verified = Object.fromEntries(
    Object.entries(value).map(([name, state]) => [name, capabilityState(state)]),
  );
  return { ...model, capabilities: { ...model.capabilities, ...verified } };
}

export function activationReadiness(
  administration: OpenAiAdministrationView,
  models: readonly OpenAiModelOption[],
  now = Date.now(),
): { readonly ready: boolean; readonly reason: string } {
  if (administration.liveConnected) {
    return { ready: false, reason: "OpenAI is already connected." };
  }
  if (administration.apiKeyStatus !== "configured") {
    return { ready: false, reason: "A valid server-side API key status is required." };
  }
  const test = administration.lastTest;
  if (!test || test.outcome !== "succeeded" || !test.authenticated) {
    return { ready: false, reason: "Run a successful authenticated connection test first." };
  }
  const testedAt = Date.parse(test.testedAt);
  if (!Number.isFinite(testedAt) || now - testedAt > OPENAI_ACTIVATION_EVIDENCE_MAX_AGE_MS) {
    return { ready: false, reason: "Connection-test evidence is older than 24 hours." };
  }
  const selected = modelWithCapabilityOverrides(
    models.find((model) => model.id === administration.settings.defaultTextModel),
    administration.settings.modelCapabilityOverrides,
  );
  const warning = modelCapabilityWarning(selected, "text");
  if (warning) return { ready: false, reason: `Selected text model: ${warning}` };
  return { ready: true, reason: "Server evidence is ready for activation." };
}

export async function openAiAdministrationError(response: Response): Promise<Error> {
  try {
    const body = (await response.clone().json()) as unknown;
    if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") {
      return new Error(body.error.message);
    }
  } catch {
    // Use the bounded status fallback below.
  }
  return new Error(`OpenAI administration request failed with status ${response.status}.`);
}
