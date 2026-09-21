import type {
  AiBuiltInToolRequest,
  AiConversationRequest,
  AiConversationResult,
  AiGeneratedArtifactReference,
  AiResponseStreamEvent,
} from "../contracts.js";
import { MAX_AI_GENERATED_ARTIFACT_BYTES } from "../contracts.js";
import { Buffer } from "node:buffer";
import { normalizeAiProviderError } from "../provider-errors.js";
import type { OpenAiRequestOptions, OpenAiSdkClient } from "./client.js";
import {
  MAX_OPENAI_RESPONSE_TEXT_CHARACTERS,
  asArray,
  asRecord,
  extractOpenAiResponseMetadata,
} from "./web-search.js";

export interface OpenAiBinaryArtifactHandoff {
  readonly artifact: AiGeneratedArtifactReference;
  readonly mediaType: "image/png";
  readonly bytes: Uint8Array;
}

export type OpenAiBinaryArtifactSink = (handoff: OpenAiBinaryArtifactHandoff) => void;

const MAX_OPENAI_STREAM_DELTA_CHARACTERS = 4_096;
const MAX_OPENAI_STREAM_PARTIAL_IMAGE_EVENTS = 32;

function safeProviderIdentifier(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(normalized) ? normalized : fallback;
}

function safeProviderModel(value: unknown, fallback: string): string {
  const safe = (candidate: unknown): string | null => {
    if (typeof candidate !== "string") return null;
    const normalized = candidate.trim();
    return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/u.test(normalized) ? normalized : null;
  };
  return safe(value) ?? safe(fallback) ?? "configured-model";
}

function requestOptions(request: AiConversationRequest): OpenAiRequestOptions {
  return {
    ...(request.options.signal === undefined ? {} : { signal: request.options.signal }),
    ...(request.options.timeoutMs === undefined ? {} : { timeout: request.options.timeoutMs }),
    ...(request.options.userSafetyIdentifier === undefined
      ? {}
      : { headers: { "OpenAI-Safety-Identifier": request.options.userSafetyIdentifier } }),
  };
}

function builtInTool(tool: AiBuiltInToolRequest): Record<string, unknown> {
  if (tool.type === "web_search") return { type: "web_search" };
  if (tool.type === "file_search") {
    const vectorStoreIds = [...new Set(tool.vectorStoreIds)]
      .filter((id) => /^vs_[A-Za-z0-9_-]{1,200}$/u.test(id))
      .slice(0, 10);
    if (vectorStoreIds.length === 0) {
      throw new Error("File Search requires at least one authorized vector store.");
    }
    return {
      type: "file_search",
      vector_store_ids: vectorStoreIds,
      max_num_results: Math.min(50, Math.max(1, tool.maxNumResults ?? 10)),
    };
  }
  if (tool.type === "code_interpreter") {
    return {
      type: "code_interpreter",
      container: { type: "auto", memory_limit: tool.container.memoryLimit },
    };
  }
  return {
    type: "image_generation",
    ...(tool.partialImages === undefined ? {} : { partial_images: tool.partialImages }),
    ...(tool.quality === undefined ? {} : { quality: tool.quality }),
  };
}

function requestBody(request: AiConversationRequest, stream: boolean): Record<string, unknown> {
  const previousResponseId =
    request.previousResponseId === undefined
      ? undefined
      : safeProviderIdentifier(request.previousResponseId, "") || undefined;
  const requestedBuiltIns = [...(request.builtInTools ?? [])];
  if (request.webSearch && !requestedBuiltIns.some((tool) => tool.type === "web_search")) {
    requestedBuiltIns.push({ type: "web_search" });
  }
  const tools: Record<string, unknown>[] = [
    ...requestedBuiltIns.map(builtInTool),
    ...(request.tools ?? []).map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: tool.strict,
    })),
  ];

  const history = previousResponseId ? [] : [...(request.history ?? [])];
  const input = request.files?.length
    ? [
        ...history.map((message) => ({ role: message.role, content: message.content })),
        {
          role: "user",
          content: [
            { type: "input_text", text: request.input },
            ...request.files.map((file) => ({
              type: "input_file",
              ...(file.fileId === undefined ? {} : { file_id: file.fileId }),
              ...(file.fileUrl === undefined ? {} : { file_url: file.fileUrl }),
              ...(file.detail === undefined ? {} : { detail: file.detail }),
            })),
          ],
        },
      ]
    : history.length > 0
      ? [
          ...history.map((message) => ({ role: message.role, content: message.content })),
          { role: "user", content: request.input },
        ]
      : request.input;

  const include: string[] = [];
  if (requestedBuiltIns.some((tool) => tool.type === "web_search")) {
    include.push("web_search_call.action.sources");
  }
  if (requestedBuiltIns.some((tool) => tool.type === "code_interpreter")) {
    include.push("code_interpreter_call.outputs");
  }
  if (requestedBuiltIns.some((tool) => tool.type === "file_search")) {
    include.push("file_search_call.results");
  }

  return {
    model: request.model,
    input,
    stream,
    ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
    ...(previousResponseId === undefined ? {} : { previous_response_id: previousResponseId }),
    ...(request.options.maxOutputTokens === undefined
      ? {}
      : { max_output_tokens: request.options.maxOutputTokens }),
    ...(request.options.userSafetyIdentifier === undefined
      ? {}
      : { safety_identifier: request.options.userSafetyIdentifier }),
    ...(request.routeDecision?.reasoningEffort === undefined ||
    request.routeDecision.reasoningEffort === "none"
      ? {}
      : { reasoning: { effort: request.routeDecision.reasoningEffort } }),
    ...(tools.length === 0 ? {} : { tools }),
    ...(include.length === 0 ? {} : { include }),
  };
}

function responseResult(
  value: unknown,
  request: AiConversationRequest,
  simulated = false,
  binaryArtifactSink?: OpenAiBinaryArtifactSink,
): AiConversationResult {
  const response = asRecord(value) ?? {};
  const metadata = extractOpenAiResponseMetadata(response);
  if (binaryArtifactSink) {
    for (const outputValue of asArray(response.output)) {
      const output = asRecord(outputValue);
      if (
        !output ||
        output.type !== "image_generation_call" ||
        typeof output.id !== "string" ||
        typeof output.result !== "string"
      ) {
        continue;
      }
      const artifact = metadata.generatedArtifacts.find(
        (candidate) =>
          candidate.providerItemId === output.id && candidate.kind === "generated_image",
      );
      if (
        !artifact ||
        output.result.length > 35_000_000 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(output.result)
      ) {
        continue;
      }
      const bytes = Uint8Array.from(Buffer.from(output.result, "base64"));
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_AI_GENERATED_ARTIFACT_BYTES) continue;
      binaryArtifactSink({ artifact, mediaType: "image/png", bytes });
    }
  }
  return {
    responseId: safeProviderIdentifier(
      response.id,
      `openai-response-${safeProviderIdentifier(request.options.requestId, "request")}`,
    ),
    model: safeProviderModel(response.model, request.model),
    text: metadata.text.slice(0, 20_000),
    citations: metadata.citations,
    webSources: metadata.webSources,
    fileSources: metadata.fileSources,
    toolCalls: metadata.toolCalls,
    generatedArtifacts: metadata.generatedArtifacts,
    usage: metadata.usage,
    completedAt: new Date().toISOString(),
    simulated,
    ...(request.routeDecision === undefined ? {} : { routeDecision: request.routeDecision }),
  };
}

export async function createOpenAiResponse(
  client: OpenAiSdkClient,
  request: AiConversationRequest,
  binaryArtifactSink?: OpenAiBinaryArtifactSink,
): Promise<AiConversationResult> {
  try {
    const response = await client.responses.create(
      requestBody(request, false),
      requestOptions(request),
    );
    return responseResult(response, request, false, binaryArtifactSink);
  } catch (error) {
    throw normalizeAiProviderError(error);
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}

function partialImageArtifact(event: Record<string, unknown>): AiGeneratedArtifactReference {
  const itemId = safeProviderIdentifier(event.item_id, "image-generation");
  const index =
    typeof event.partial_image_index === "number" ? event.partial_image_index : undefined;
  // Deliberately omit partial_image_b64. Raw bytes stay ephemeral and outside persistence/audit.
  return {
    id: `${itemId}:partial:${index ?? 0}`,
    kind: "generated_image",
    providerItemId: itemId,
    ...(index === undefined ? {} : { partialImageIndex: index }),
    simulated: false,
    rawBytesPersisted: false,
  };
}

export async function* streamOpenAiResponse(
  client: OpenAiSdkClient,
  request: AiConversationRequest,
  binaryArtifactSink?: OpenAiBinaryArtifactSink,
): AsyncIterable<AiResponseStreamEvent> {
  try {
    const stream = await client.responses.create(
      requestBody(request, true),
      requestOptions(request),
    );
    if (!isAsyncIterable(stream)) throw new Error("OpenAI did not return a response event stream.");

    let started = false;
    let streamedTextCharacters = 0;
    let streamedPartialImageEvents = 0;
    for await (const eventValue of stream) {
      const event = asRecord(eventValue);
      if (!event || typeof event.type !== "string") continue;
      if (event.type === "response.created") {
        const response = asRecord(event.response) ?? {};
        started = true;
        yield {
          type: "response.started",
          requestId: request.options.requestId,
          providerResponseId: safeProviderIdentifier(
            response.id,
            `openai-response-${safeProviderIdentifier(request.options.requestId, "request")}`,
          ),
          model: safeProviderModel(response.model, request.model),
          simulated: false,
        };
        continue;
      }
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        const remaining = MAX_OPENAI_RESPONSE_TEXT_CHARACTERS - streamedTextCharacters;
        const bounded = remaining > 0 ? event.delta.slice(0, remaining) : "";
        for (
          let offset = 0;
          offset < bounded.length;
          offset += MAX_OPENAI_STREAM_DELTA_CHARACTERS
        ) {
          const delta = bounded.slice(offset, offset + MAX_OPENAI_STREAM_DELTA_CHARACTERS);
          streamedTextCharacters += delta.length;
          yield { type: "response.output_text.delta", delta };
        }
        continue;
      }
      if (event.type === "response.image_generation_call.partial_image") {
        if (streamedPartialImageEvents >= MAX_OPENAI_STREAM_PARTIAL_IMAGE_EVENTS) continue;
        streamedPartialImageEvents += 1;
        yield { type: "response.generated_artifact", artifact: partialImageArtifact(event) };
        continue;
      }
      if (event.type === "response.completed") {
        const result = responseResult(event.response, request, false, binaryArtifactSink);
        if (!started) {
          yield {
            type: "response.started",
            requestId: request.options.requestId,
            providerResponseId: result.responseId,
            model: result.model,
            simulated: false,
          };
        }
        for (const citation of result.citations) {
          yield { type: "response.citation", citation };
        }
        for (const source of result.webSources) {
          yield { type: "response.web_source", source };
        }
        for (const source of result.fileSources ?? []) {
          yield { type: "response.file_source", source };
        }
        for (const toolCall of result.toolCalls) {
          yield { type: "response.tool_call", toolCall };
        }
        for (const artifact of result.generatedArtifacts) {
          yield { type: "response.generated_artifact", artifact };
        }
        if (result.usage) yield { type: "response.usage", usage: result.usage };
        yield { type: "response.completed", result };
        return;
      }
      if (event.type === "error" || event.type === "response.failed") {
        const normalized = normalizeAiProviderError(event.error ?? event);
        yield {
          type: "response.error",
          code: normalized.code,
          safeMessage: normalized.safeMessage,
          retryable: normalized.retryable,
        };
        return;
      }
      if (event.type === "response.incomplete") {
        yield {
          type: "response.error",
          code: "incomplete",
          safeMessage: "OpenAI did not complete the response.",
          retryable: true,
        };
        return;
      }
    }
    yield {
      type: "response.error",
      code: "incomplete_stream",
      safeMessage: "The OpenAI response stream ended before completion.",
      retryable: true,
    };
  } catch (error) {
    const normalized = normalizeAiProviderError(error);
    if (normalized.code === "cancelled" || request.options.signal?.aborted) {
      yield { type: "response.cancelled", requestId: request.options.requestId };
      return;
    }
    yield {
      type: "response.error",
      code: normalized.code,
      safeMessage: normalized.safeMessage,
      retryable: normalized.retryable,
    };
  }
}
