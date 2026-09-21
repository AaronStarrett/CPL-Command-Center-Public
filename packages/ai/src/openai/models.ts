import type { AiModelMetadata, AiRequestOptions } from "../contracts.js";
import { ModelCapabilityRegistry } from "../capabilities.js";
import { normalizeAiProviderError } from "../provider-errors.js";
import type { OpenAiModelPage, OpenAiSdkClient } from "./client.js";
import {
  applyOpenAiFamilyCandidates,
  classifyOpenAiModelFamily,
  familyRegistryValidation,
} from "./model-family-registry.js";

const MAX_MODEL_PAGES = 20;
const MAX_MODELS = 500;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/u;
const MAX_DATE_SECONDS = 8_640_000_000_000;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeModel(
  value: unknown,
  capabilities: ModelCapabilityRegistry,
): AiModelMetadata | null {
  const model = record(value);
  if (!model || typeof model.id !== "string") return null;
  const id = model.id.trim();
  if (!MODEL_ID_PATTERN.test(id)) return null;
  const created =
    typeof model.created === "number" &&
    Number.isSafeInteger(model.created) &&
    model.created >= 0 &&
    model.created <= MAX_DATE_SECONDS
      ? model.created
      : null;
  const ownedBy =
    typeof model.owned_by === "string" && model.owned_by.trim().length > 0
      ? model.owned_by
          .replace(/[\u0000-\u001f\u007f]/gu, " ")
          .trim()
          .slice(0, 200)
      : null;
  const capabilitySet = applyOpenAiFamilyCandidates(capabilities.resolve("openai", id), id);
  const family = classifyOpenAiModelFamily(id);
  const allUnknown = Object.values(capabilitySet).every((state) => state === "unknown");
  const hasCandidate = Object.values(capabilitySet).some((state) => state === "candidate");
  return {
    id,
    provider: "openai",
    displayName: family.displayName === "Unknown family" ? id : `${id}`,
    available: true,
    ...(created === null ? {} : { createdAt: new Date(created * 1000).toISOString() }),
    ...(ownedBy === null ? {} : { ownedBy }),
    capabilities: capabilitySet,
    capabilitySource: hasCandidate ? "registry" : allUnknown ? "unknown" : "configured",
    validation: hasCandidate ? familyRegistryValidation() : capabilities.validation("openai", id),
  };
}

export function isSafeOpenAiModelId(modelId: string): boolean {
  return MODEL_ID_PATTERN.test(modelId.trim());
}

/** Validates that a manually entered model ID is live-accessible; capabilities remain fail closed. */
export async function validateOpenAiModelId(
  client: OpenAiSdkClient,
  capabilities: ModelCapabilityRegistry,
  modelId: string,
  options: Pick<AiRequestOptions, "signal" | "timeoutMs"> = {},
): Promise<AiModelMetadata | null> {
  const normalized = modelId.trim();
  if (!isSafeOpenAiModelId(normalized)) return null;
  const models = await listOpenAiModels(client, capabilities, options);
  return models.find((model) => model.id === normalized) ?? null;
}

async function collectPages(first: OpenAiModelPage): Promise<readonly unknown[]> {
  if (typeof first[Symbol.asyncIterator] === "function") {
    const values: unknown[] = [];
    for await (const item of first as AsyncIterable<unknown>) {
      values.push(item);
      if (values.length >= MAX_MODELS) break;
    }
    return values;
  }

  const values: unknown[] = [];
  let page: OpenAiModelPage | null = first;
  let pageCount = 0;
  while (page && pageCount < MAX_MODEL_PAGES && values.length < MAX_MODELS) {
    pageCount += 1;
    values.push(...(page.data ?? []).slice(0, MAX_MODELS - values.length));
    if (!page.hasNextPage?.() || !page.getNextPage) break;
    page = await page.getNextPage();
  }
  return values;
}

export async function listOpenAiModels(
  client: OpenAiSdkClient,
  capabilities: ModelCapabilityRegistry,
  options: Pick<AiRequestOptions, "signal" | "timeoutMs"> = {},
): Promise<readonly AiModelMetadata[]> {
  try {
    const page = await client.models.list(
      {},
      {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      },
    );
    const byId = new Map<string, AiModelMetadata>();
    for (const candidate of await collectPages(page)) {
      const model = normalizeModel(candidate, capabilities);
      if (model) byId.set(model.id, model);
    }
    return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
  } catch (error) {
    throw normalizeAiProviderError(error);
  }
}
