import type {
  AiCitation,
  AiFileSource,
  AiGeneratedArtifactReference,
  AiToolCall,
  AiTokenUsage,
  AiWebSource,
} from "../contracts.js";
import type { JsonObject } from "@bea/domain";
import { validateRegisteredArtifactToolCall } from "../tools.js";

export const MAX_OPENAI_RESPONSE_TEXT_CHARACTERS = 20_000;
const MAX_SAFE_WEB_URL_CHARACTERS = 1_024;
const MAX_SAFE_WEB_URL_QUERY_PARAMETERS = 32;
const MAX_OUTPUT_ITEMS = 200;
const MAX_CONTENT_ITEMS = 200;
const MAX_ANNOTATIONS = 500;
const MAX_CITATIONS = 64;
const MAX_WEB_SOURCES = 32;
const MAX_FILE_SOURCES = 64;
const MAX_TOOL_CALLS = 32;
const MAX_GENERATED_ARTIFACTS = 32;
const MAX_TOKEN_COUNT = 1_000_000_000;

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function safeWebUrl(value: string): { readonly url: string; readonly domain: string } | null {
  if (value.length === 0 || value.length > MAX_SAFE_WEB_URL_CHARACTERS) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) {
      return null;
    }
    const credentialParameter =
      /^(?:access[-_.]?token|api[-_.]?key|auth(?:orization)?|code|credential|key|pass(?:word)?|secret|session(?:id)?|sig(?:nature)?|token|x-(?:amz|goog)-.+)$/iu;
    if ([...url.searchParams.keys()].some((key) => credentialParameter.test(key))) {
      return null;
    }
    if ([...url.searchParams].length > MAX_SAFE_WEB_URL_QUERY_PARAMETERS) return null;
    const credentialValue =
      /(?:^|[^A-Za-z0-9])(?:Bearer\s+[A-Za-z0-9._~-]{8,}|sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})/iu;
    if ([...url.searchParams.values()].some((value) => credentialValue.test(value))) {
      return null;
    }
    if (credentialValue.test(decodeURIComponent(url.pathname))) return null;
    url.hash = "";
    const serialized = url.toString();
    return serialized.length <= MAX_SAFE_WEB_URL_CHARACTERS
      ? { url: serialized, domain: url.hostname }
      : null;
  } catch {
    return null;
  }
}

function safeTitle(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const title = value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 240);
  return title || fallback;
}

function safeFilename(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value
    .replace(/[\\/\u0000-\u001f\u007f]/g, "_")
    .trim()
    .slice(0, 255);
  return name || undefined;
}

export interface OpenAiResponseMetadata {
  readonly text: string;
  readonly citations: readonly AiCitation[];
  readonly webSources: readonly AiWebSource[];
  readonly fileSources: readonly AiFileSource[];
  readonly toolCalls: readonly AiToolCall[];
  readonly generatedArtifacts: readonly AiGeneratedArtifactReference[];
  readonly usage: AiTokenUsage | null;
}

function safeProviderId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(id) ? id : null;
}

function safeShortText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return text ? text.slice(0, maximum) : null;
}

function parseJsonObject(value: unknown): JsonObject {
  if (typeof value !== "string" || value.length > 65_536) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return (asRecord(parsed) as JsonObject | null) ?? {};
  } catch {
    return {};
  }
}

export function normalizeOpenAiUsage(value: unknown): AiTokenUsage | null {
  const usage = asRecord(value);
  if (!usage) return null;
  const tokenCount = (candidate: unknown): number | null =>
    typeof candidate === "number" &&
    Number.isSafeInteger(candidate) &&
    candidate >= 0 &&
    candidate <= MAX_TOKEN_COUNT
      ? candidate
      : null;
  const inputTokens = tokenCount(usage.input_tokens) ?? 0;
  const outputTokens = tokenCount(usage.output_tokens) ?? 0;
  const outputDetails = asRecord(usage.output_tokens_details);
  const inputDetails = asRecord(usage.input_tokens_details);
  const totalTokens = tokenCount(usage.total_tokens);
  const reasoningTokens = tokenCount(outputDetails?.reasoning_tokens);
  const cachedInputTokens = tokenCount(inputDetails?.cached_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: totalTokens ?? Math.min(MAX_TOKEN_COUNT, inputTokens + outputTokens),
    ...(reasoningTokens === null ? {} : { reasoningTokens }),
    ...(cachedInputTokens === null ? {} : { cachedInputTokens }),
  };
}

export function extractOpenAiResponseMetadata(
  responseValue: unknown,
  retrievedAt = new Date().toISOString(),
): OpenAiResponseMetadata {
  const response = asRecord(responseValue) ?? {};
  const responseId = safeProviderId(response.id) ?? "openai-response";
  const citations: AiCitation[] = [];
  const webSources: AiWebSource[] = [];
  const fileSources: AiFileSource[] = [];
  const toolCalls: AiToolCall[] = [];
  const generatedArtifacts: AiGeneratedArtifactReference[] = [];
  const textParts: string[] = [];
  let citationIndex = 0;
  const sourceUrls = new Set<string>();
  const webToolCallIds: string[] = [];
  let textLength = 0;
  const appendText = (value: unknown): void => {
    if (typeof value !== "string" || textLength >= MAX_OPENAI_RESPONSE_TEXT_CHARACTERS) return;
    const bounded = value.slice(0, MAX_OPENAI_RESPONSE_TEXT_CHARACTERS - textLength);
    textParts.push(bounded);
    textLength += bounded.length;
  };

  for (const outputValue of asArray(response.output).slice(0, MAX_OUTPUT_ITEMS)) {
    const output = asRecord(outputValue);
    if (!output) continue;
    const outputId = safeProviderId(output.id) ?? `${responseId}:item`;

    const functionName = safeShortText(output.name, 100);
    if (output.type === "function_call" && functionName && toolCalls.length < MAX_TOOL_CALLS) {
      const validation = validateRegisteredArtifactToolCall(
        functionName,
        parseJsonObject(output.arguments),
      );
      toolCalls.push({
        id: safeProviderId(output.call_id) ?? outputId,
        providerCallId: outputId,
        name: functionName,
        arguments: validation.ok ? validation.arguments : {},
        status: validation.ok ? "proposed" : "rejected",
      });
    }

    for (const builtInName of [
      "web_search",
      "file_search",
      "code_interpreter",
      "image_generation",
    ] as const) {
      if (output.type !== `${builtInName}_call`) continue;
      let builtInArguments: JsonObject = {};
      if (builtInName === "web_search") {
        webToolCallIds.push(outputId);
        const action = asRecord(output.action);
        const safeSources: JsonObject[] = [];
        for (const sourceValue of asArray(action?.sources).slice(0, 100)) {
          const source = asRecord(sourceValue);
          const safeUrl = typeof source?.url === "string" ? safeWebUrl(source.url) : null;
          if (!safeUrl || sourceUrls.has(safeUrl.url) || webSources.length >= MAX_WEB_SOURCES)
            continue;
          sourceUrls.add(safeUrl.url);
          const title = safeTitle(source?.title, safeUrl.domain);
          const normalizedSource: AiWebSource = {
            id: `${responseId}:source:${webSources.length}`,
            title,
            url: safeUrl.url,
            domain: safeUrl.domain,
            retrievedAt,
            toolCallId: outputId,
            simulated: false,
          };
          webSources.push(normalizedSource);
          safeSources.push({ title, url: safeUrl.url, domain: safeUrl.domain });
        }
        const actionType = safeShortText(action?.type, 80);
        builtInArguments = {
          action: {
            ...(actionType === null ? {} : { type: actionType }),
            sources: safeSources,
          },
        };
      }
      if (builtInName === "code_interpreter") {
        const containerId = safeProviderId(output.container_id);
        const outputs: JsonObject[] = [];
        for (const outputValue of asArray(output.outputs).slice(0, 50)) {
          const codeOutput = asRecord(outputValue);
          if (codeOutput?.type === "logs") {
            // Provider logs can contain prompts, credentials, or arbitrary code output. Persist
            // only the fact that a log output occurred, never its raw body.
            outputs.push({ type: "logs" });
          }
          if (codeOutput?.type === "image") {
            outputs.push({ type: "image" });
          }
          if (codeOutput?.type === "file") {
            const fileId = safeProviderId(codeOutput.file_id);
            if (!containerId || !fileId) continue;
            const filename = safeFilename(codeOutput.filename);
            outputs.push({
              type: "file",
              fileId,
              ...(filename === undefined ? {} : { filename }),
            });
            if (
              generatedArtifacts.length < MAX_GENERATED_ARTIFACTS &&
              !generatedArtifacts.some(
                (artifact) =>
                  artifact.kind === "container_file" &&
                  artifact.containerId === containerId &&
                  artifact.fileId === fileId,
              )
            ) {
              generatedArtifacts.push({
                id: `${responseId}:file:${generatedArtifacts.length}`,
                kind: "container_file",
                providerItemId: outputId,
                containerId,
                fileId,
                ...(filename === undefined ? {} : { filename }),
                simulated: false,
                rawBytesPersisted: false,
              });
            }
          }
        }
        builtInArguments = {
          ...(containerId === null ? {} : { containerId }),
          outputs,
        };
      }
      if (builtInName === "file_search") {
        const results: JsonObject[] = [];
        for (const resultValue of asArray(output.results).slice(0, MAX_FILE_SOURCES)) {
          const result = asRecord(resultValue);
          const fileId = safeProviderId(result?.file_id);
          const filename = safeFilename(result?.filename);
          if (!fileId || !filename || fileSources.length >= MAX_FILE_SOURCES) continue;
          const attributes = asRecord(result?.attributes);
          const vectorStoreId = safeProviderId(attributes?.vector_store_id);
          const score =
            typeof result?.score === "number" && Number.isFinite(result.score)
              ? Math.min(1, Math.max(0, result.score))
              : undefined;
          const excerpt = safeShortText(result?.text, 1_000) ?? undefined;
          fileSources.push({
            id: `${responseId}:file-source:${fileSources.length}`,
            filename,
            fileId,
            ...(vectorStoreId === null ? {} : { vectorStoreId }),
            ...(score === undefined ? {} : { score }),
            ...(excerpt === undefined ? {} : { excerpt }),
            retrievedAt,
            toolCallId: outputId,
            simulated: false,
          });
          results.push({
            fileId,
            filename,
            ...(vectorStoreId === null ? {} : { vectorStoreId }),
            ...(score === undefined ? {} : { score }),
          });
        }
        builtInArguments = { results };
      }
      if (toolCalls.length < MAX_TOOL_CALLS) {
        toolCalls.push({
          id: outputId,
          providerCallId: outputId,
          name: builtInName,
          arguments: builtInArguments,
          status:
            output.status === "completed"
              ? "completed"
              : output.status === "failed" || output.status === "incomplete"
                ? "failed"
                : "proposed",
        });
      }
      if (
        builtInName === "image_generation" &&
        generatedArtifacts.length < MAX_GENERATED_ARTIFACTS
      ) {
        // Deliberately omit output.result, which is raw base64 image content.
        generatedArtifacts.push({
          id: `${outputId}:image`,
          kind: "generated_image",
          providerItemId: outputId,
          simulated: false,
          rawBytesPersisted: false,
        });
      }
    }

    for (const contentValue of asArray(output.content).slice(0, MAX_CONTENT_ITEMS)) {
      const content = asRecord(contentValue);
      if (!content || content.type !== "output_text") continue;
      appendText(content.text);
      for (const annotationValue of asArray(content.annotations).slice(0, MAX_ANNOTATIONS)) {
        const annotation = asRecord(annotationValue);
        if (!annotation) continue;
        if (annotation.type === "url_citation" && typeof annotation.url === "string") {
          const safeUrl = safeWebUrl(annotation.url);
          const startIndex =
            typeof annotation.start_index === "number" ? annotation.start_index : undefined;
          const endIndex =
            typeof annotation.end_index === "number" ? annotation.end_index : undefined;
          const validIndices =
            (startIndex === undefined && endIndex === undefined) ||
            (startIndex !== undefined &&
              endIndex !== undefined &&
              Number.isInteger(startIndex) &&
              Number.isInteger(endIndex) &&
              startIndex >= 0 &&
              endIndex >= startIndex &&
              endIndex <= (typeof content.text === "string" ? content.text.length : endIndex));
          if (!safeUrl || !validIndices || citations.length >= MAX_CITATIONS) continue;
          citations.push({
            id: `${responseId}:citation:${citationIndex++}`,
            title: safeTitle(annotation.title, safeUrl.domain),
            url: safeUrl.url,
            domain: safeUrl.domain,
            ...(startIndex === undefined ? {} : { startIndex }),
            ...(endIndex === undefined ? {} : { endIndex }),
            retrievedAt,
            ...(webToolCallIds.length === 1 ? { toolCallId: webToolCallIds[0] } : {}),
            simulated: false,
          });
        }
        if (annotation.type === "container_file_citation") {
          const containerId = safeProviderId(annotation.container_id);
          const fileId = safeProviderId(annotation.file_id);
          if (!containerId || !fileId) continue;
          const filename = safeFilename(annotation.filename);
          if (
            generatedArtifacts.length >= MAX_GENERATED_ARTIFACTS ||
            generatedArtifacts.some(
              (artifact) =>
                artifact.kind === "container_file" &&
                artifact.containerId === containerId &&
                artifact.fileId === fileId,
            )
          ) {
            continue;
          }
          generatedArtifacts.push({
            id: `${responseId}:file:${generatedArtifacts.length}`,
            kind: "container_file",
            providerItemId: outputId,
            containerId,
            fileId,
            ...(filename === undefined ? {} : { filename }),
            simulated: false,
            rawBytesPersisted: false,
          });
        }
      }
    }
  }

  return {
    text: (typeof response.output_text === "string"
      ? response.output_text.slice(0, MAX_OPENAI_RESPONSE_TEXT_CHARACTERS)
      : textParts.join("")
    )
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
      .slice(0, MAX_OPENAI_RESPONSE_TEXT_CHARACTERS),
    citations,
    webSources,
    fileSources,
    toolCalls,
    generatedArtifacts,
    usage: normalizeOpenAiUsage(response.usage),
  };
}
