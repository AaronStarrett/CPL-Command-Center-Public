import type { AiCapabilityState, AiModelCapabilities, AiModelMetadata } from "../contracts.js";
import { OPENAI_CAPABILITY_REGISTRY_VERSION } from "../capabilities.js";
import { AiProviderError, normalizeAiProviderError } from "../provider-errors.js";
import type { OpenAiSdkClient } from "./client.js";
import {
  classifyOpenAiModelFamily,
  openAiFamilyRecommendationRank,
} from "./model-family-registry.js";

export type CapabilityVerificationStatus = "verified" | "candidate" | "unsupported";

export interface CapabilityEvidenceRecord {
  readonly modelId: string;
  readonly capability: keyof AiModelCapabilities;
  readonly status: CapabilityVerificationStatus;
  readonly verificationMethod: "registry" | "provider_probe";
  readonly verifiedAt: string;
  readonly providerRequestId: string | null;
  readonly safeFailureCode: string | null;
  readonly registryVersion: string;
}

const TEXT_PROBE_INPUT = "Reply with the single word ready.";
const WEB_SEARCH_PROBE_INPUT = "Name one official OpenAI documentation URL.";
const MAX_SHORTLIST = 6;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function evidence(
  modelId: string,
  capability: keyof AiModelCapabilities,
  status: CapabilityVerificationStatus,
  method: "registry" | "provider_probe",
  extra: {
    readonly providerRequestId?: string | null;
    readonly safeFailureCode?: string | null;
  } = {},
): CapabilityEvidenceRecord {
  return {
    modelId,
    capability,
    status,
    verificationMethod: method,
    verifiedAt: new Date().toISOString(),
    providerRequestId: extra.providerRequestId ?? null,
    safeFailureCode: extra.safeFailureCode ?? null,
    registryVersion: OPENAI_CAPABILITY_REGISTRY_VERSION,
  };
}

function safeFailureCode(error: unknown): string {
  const normalized = error instanceof AiProviderError ? error : normalizeAiProviderError(error);
  if (normalized.status === 401) return "OPENAI_KEY_REJECTED";
  if (normalized.status === 403) return "OPENAI_PERMISSION_DENIED";
  if (normalized.code === "quota") return "OPENAI_QUOTA_OR_BILLING_LIMIT";
  if (normalized.code === "rate_limit") return "OPENAI_RATE_LIMITED";
  if (normalized.code === "timeout") return "OPENAI_TIMEOUT";
  return "OPENAI_CAPABILITY_UNVERIFIED";
}

function providerRequestId(value: unknown): string | null {
  const payload = record(value);
  const id = payload?.id;
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(id) ? id : null;
}

export function shortlistCapabilityProbeModels(
  models: readonly AiModelMetadata[],
  assigned: readonly (string | null | undefined)[],
): readonly AiModelMetadata[] {
  const byId = new Map(models.map((model) => [model.id, model] as const));
  const selected: AiModelMetadata[] = [];
  for (const id of assigned) {
    if (!id) continue;
    const model = byId.get(id);
    if (model && !selected.some((entry) => entry.id === model.id)) selected.push(model);
  }
  const ranked = [...models].sort(
    (left, right) =>
      openAiFamilyRecommendationRank(left.id, "executive_conversation") -
      openAiFamilyRecommendationRank(right.id, "executive_conversation"),
  );
  for (const model of ranked) {
    if (selected.length >= MAX_SHORTLIST) break;
    if (!selected.some((entry) => entry.id === model.id)) selected.push(model);
  }
  return selected.slice(0, MAX_SHORTLIST);
}

async function probeResponsesText(
  client: OpenAiSdkClient,
  modelId: string,
): Promise<readonly CapabilityEvidenceRecord[]> {
  try {
    const result = await client.responses.create(
      {
        model: modelId,
        input: TEXT_PROBE_INPUT,
        max_output_tokens: 16,
      },
      { timeout: 20_000 },
    );
    const requestId = providerRequestId(result);
    return [
      evidence(modelId, "responsesText", "verified", "provider_probe", {
        providerRequestId: requestId,
      }),
      evidence(modelId, "streaming", "verified", "provider_probe", {
        providerRequestId: requestId,
      }),
    ];
  } catch (error) {
    return [
      evidence(modelId, "responsesText", "unsupported", "provider_probe", {
        safeFailureCode: safeFailureCode(error),
      }),
    ];
  }
}

async function probeWebSearch(
  client: OpenAiSdkClient,
  modelId: string,
): Promise<readonly CapabilityEvidenceRecord[]> {
  try {
    const result = await client.responses.create(
      {
        model: modelId,
        input: WEB_SEARCH_PROBE_INPUT,
        tools: [{ type: "web_search" }],
        max_output_tokens: 32,
      },
      { timeout: 30_000 },
    );
    const requestId = providerRequestId(result);
    return [
      evidence(modelId, "webSearch", "verified", "provider_probe", {
        providerRequestId: requestId,
      }),
      evidence(modelId, "responsesText", "verified", "provider_probe", {
        providerRequestId: requestId,
      }),
      evidence(modelId, "streaming", "verified", "provider_probe", {
        providerRequestId: requestId,
      }),
    ];
  } catch (error) {
    return [
      evidence(modelId, "webSearch", "unsupported", "provider_probe", {
        safeFailureCode: safeFailureCode(error),
      }),
    ];
  }
}

async function probeRealtime(
  client: OpenAiSdkClient,
  modelId: string,
): Promise<readonly CapabilityEvidenceRecord[]> {
  try {
    const result = await client.realtime.clientSecrets.create(
      {
        expires_after: { anchor: "created_at", seconds: 60 },
        session: {
          type: "realtime",
          model: modelId,
          audio: { output: { voice: "cedar" } },
        },
      },
      { timeout: 20_000 },
    );
    const requestId = providerRequestId(result);
    return [
      evidence(modelId, "realtime", "verified", "provider_probe", { providerRequestId: requestId }),
      evidence(modelId, "audioInput", "verified", "provider_probe", {
        providerRequestId: requestId,
      }),
      evidence(modelId, "audioOutput", "verified", "provider_probe", {
        providerRequestId: requestId,
      }),
    ];
  } catch (error) {
    return [
      evidence(modelId, "realtime", "unsupported", "provider_probe", {
        safeFailureCode: safeFailureCode(error),
      }),
    ];
  }
}

function shouldProbeText(model: AiModelMetadata): boolean {
  const family = classifyOpenAiModelFamily(model.id);
  if (!family.apiRouteAppropriate) return false;
  if (family.family === "gpt-realtime" || family.family === "gpt-realtime-2.1") return false;
  return (
    model.capabilities.responsesText === "candidate" ||
    model.capabilities.responsesText === "unknown" ||
    model.capabilities.responsesText === true
  );
}

function shouldProbeWeb(model: AiModelMetadata): boolean {
  const family = classifyOpenAiModelFamily(model.id);
  return (
    model.capabilities.webSearch === "candidate" ||
    family.preferredRoutes.includes("public_web_research")
  );
}

function shouldProbeRealtime(model: AiModelMetadata): boolean {
  const family = classifyOpenAiModelFamily(model.id);
  return (
    model.capabilities.realtime === "candidate" || family.preferredRoutes.includes("realtime_voice")
  );
}

export async function probeOpenAiRouteCandidates(input: {
  readonly client: OpenAiSdkClient;
  readonly models: readonly AiModelMetadata[];
  readonly assignedModelIds: readonly (string | null | undefined)[];
}): Promise<readonly CapabilityEvidenceRecord[]> {
  const shortlist = shortlistCapabilityProbeModels(input.models, input.assignedModelIds);
  const collected: CapabilityEvidenceRecord[] = [];
  let textProbed = false;
  let webProbed = false;
  let realtimeProbed = false;
  for (const model of shortlist) {
    if (!textProbed && shouldProbeText(model)) {
      collected.push(...(await probeResponsesText(input.client, model.id)));
      textProbed = true;
    }
    if (!webProbed && shouldProbeWeb(model)) {
      collected.push(...(await probeWebSearch(input.client, model.id)));
      webProbed = true;
    }
    if (!realtimeProbed && shouldProbeRealtime(model)) {
      collected.push(...(await probeRealtime(input.client, model.id)));
      realtimeProbed = true;
    }
  }
  return collected;
}

export function applyCapabilityEvidence(
  capabilities: AiModelCapabilities,
  evidenceRecords: readonly CapabilityEvidenceRecord[],
  modelId: string,
): AiModelCapabilities {
  const next: Record<string, AiCapabilityState> = { ...capabilities };
  for (const record of evidenceRecords) {
    if (record.modelId !== modelId) continue;
    next[record.capability] =
      record.status === "verified" ? true : record.status === "unsupported" ? false : "candidate";
    if (record.capability === "webSearch" && record.status === "verified") {
      if (next.responsesText !== false) next.responsesText = true;
      if (next.streaming !== false) next.streaming = true;
    }
  }
  return next as unknown as AiModelCapabilities;
}
