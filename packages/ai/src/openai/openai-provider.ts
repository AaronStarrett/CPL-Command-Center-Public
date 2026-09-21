import type {
  AiCommandProvider,
  AiAuthorizedInputFileUpload,
  AiConnectionTestResult,
  AiConversationRequest,
  AiConversationResult,
  AiGeneratedArtifactContent,
  AiGeneratedArtifactContentProvider,
  AiGeneratedArtifactReference,
  AiInputFileReference,
  AiModelMetadata,
  AiProviderHealth,
  AiProviderIdentity,
  AiRealtimeClientAuthorization,
  AiRealtimeSessionConfig,
  AiRequestOptions,
  AiResponse,
  AiResponseStreamEvent,
  AiUsageRecord,
  GroundedAnswer,
  GroundingSource,
  PlannedAction,
  SpeechToTextOutput,
  StructuredExtractionRequest,
  TextToSpeechOutput,
} from "../contracts.js";
import { MAX_AI_GENERATED_ARTIFACT_BYTES } from "../contracts.js";
import { ModelCapabilityRegistry } from "../capabilities.js";
import { AiProviderError, normalizeAiProviderError } from "../provider-errors.js";
import type { OpenAiSdkClient } from "./client.js";
import { listOpenAiModels } from "./models.js";
import { probeOpenAiRouteCandidates, type CapabilityEvidenceRecord } from "./capability-probes.js";
import { uploadOpenAiInputFile } from "./files.js";
import { createOpenAiRealtimeClientAuthorization } from "./realtime.js";
import {
  createOpenAiResponse,
  streamOpenAiResponse,
  type OpenAiBinaryArtifactHandoff,
} from "./responses.js";

export interface OpenAiProviderOptions {
  readonly client: OpenAiSdkClient;
  readonly defaultModel: string;
  readonly capabilityRegistry?: ModelCapabilityRegistry;
  readonly connectionEvidenceVerified?: boolean;
}

const MAX_LEGACY_USAGE_RECORDS = 500;

async function readBoundedResponseBytes(response: Response): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 1 ||
      parsedLength > MAX_AI_GENERATED_ARTIFACT_BYTES
    ) {
      throw new AiProviderError({
        code: "invalid_request",
        provider: "openai",
        retryable: false,
        safeMessage: "The generated artifact exceeds the configured transfer limit.",
      });
    }
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new AiProviderError({
      code: "unavailable",
      provider: "openai",
      retryable: true,
      safeMessage: "The generated artifact content was unavailable.",
    });
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array) || next.value.byteLength === 0) continue;
      if (total + next.value.byteLength > MAX_AI_GENERATED_ARTIFACT_BYTES) {
        try {
          await reader.cancel("generated artifact transfer limit exceeded");
        } catch {
          // The hard local byte bound is already enforced even if provider cancellation fails.
        }
        throw new AiProviderError({
          code: "invalid_request",
          provider: "openai",
          retryable: false,
          safeMessage: "The generated artifact exceeds the configured transfer limit.",
        });
      }
      total += next.value.byteLength;
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) {
    throw new AiProviderError({
      code: "unavailable",
      provider: "openai",
      retryable: true,
      safeMessage: "The generated artifact content was unavailable.",
    });
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class OpenAiProvider implements AiCommandProvider, AiGeneratedArtifactContentProvider {
  readonly providerKey = "openai";
  private readonly client: OpenAiSdkClient;
  private readonly defaultModel: string;
  private readonly capabilities: ModelCapabilityRegistry;
  private readonly usageRecords: AiUsageRecord[] = [];
  private readonly imageContent = new Map<
    string,
    { readonly content: AiGeneratedArtifactContent; readonly createdAt: number }
  >();
  private connected = false;

  constructor(options: OpenAiProviderOptions) {
    this.client = options.client;
    this.defaultModel = options.defaultModel;
    this.capabilities = options.capabilityRegistry ?? new ModelCapabilityRegistry();
    this.connected = options.connectionEvidenceVerified === true;
  }

  get identity(): AiProviderIdentity {
    return {
      provider: "openai",
      displayName: "OpenAI",
      model: this.defaultModel,
      mode: "live",
      requirementStatus: this.connected ? "CONNECTED" : "BLOCKED",
    };
  }

  async generateResponse(request: AiConversationRequest): Promise<AiConversationResult> {
    const result = await createOpenAiResponse(this.client, request, (handoff) =>
      this.rememberImage(handoff),
    );
    this.recordUsage("responses.create", request.options.requestId, result);
    return result;
  }

  async *streamResponse(request: AiConversationRequest): AsyncIterable<AiResponseStreamEvent> {
    for await (const event of streamOpenAiResponse(this.client, request, (handoff) =>
      this.rememberImage(handoff),
    )) {
      if (event.type === "response.completed") {
        this.recordUsage("responses.stream", request.options.requestId, event.result);
      }
      yield event;
    }
  }

  async listModels(
    options: Pick<AiRequestOptions, "signal" | "timeoutMs"> = {},
  ): Promise<readonly AiModelMetadata[]> {
    return listOpenAiModels(this.client, this.capabilities, options);
  }

  async probeSelectedCapabilities(input: {
    readonly models: readonly AiModelMetadata[];
    readonly assignedModelIds: readonly (string | null | undefined)[];
  }): Promise<readonly CapabilityEvidenceRecord[]> {
    return probeOpenAiRouteCandidates({
      client: this.client,
      models: input.models,
      assignedModelIds: input.assignedModelIds,
    });
  }

  async testConnection(
    options: Pick<AiRequestOptions, "signal" | "timeoutMs" | "userSafetyIdentifier"> = {},
  ): Promise<AiConnectionTestResult> {
    try {
      const models = await this.listModels(options);
      this.connected = true;
      return {
        provider: "openai",
        healthy: true,
        authenticated: true,
        testedAt: new Date().toISOString(),
        safeMessage:
          models.length > 0
            ? "OpenAI authentication succeeded."
            : "The credential authenticated, but OpenAI returned no models for this project.",
        modelCount: models.length,
      };
    } catch (error) {
      this.connected = false;
      const normalized = normalizeAiProviderError(error);
      return {
        provider: "openai",
        healthy: false,
        authenticated: false,
        testedAt: new Date().toISOString(),
        safeMessage: normalized.safeMessage,
      };
    }
  }

  async createRealtimeClientAuthorization(
    configuration: AiRealtimeSessionConfig,
    options: AiRequestOptions,
  ): Promise<AiRealtimeClientAuthorization> {
    return createOpenAiRealtimeClientAuthorization(this.client, configuration, options);
  }

  async uploadInputFile(
    input: AiAuthorizedInputFileUpload,
    options: Pick<AiRequestOptions, "signal" | "timeoutMs">,
  ): Promise<AiInputFileReference> {
    return uploadOpenAiInputFile(this.client, input, options);
  }

  async fetchGeneratedArtifactContent(
    reference: AiGeneratedArtifactReference,
    options: Pick<AiRequestOptions, "signal" | "timeoutMs">,
  ): Promise<AiGeneratedArtifactContent | null> {
    if (reference.kind === "generated_image") {
      const entry = this.imageContent.get(reference.id) ?? null;
      if (entry) this.imageContent.delete(reference.id);
      if (!entry || Date.now() - entry.createdAt > 300_000) return null;
      return entry.content;
    }
    if (!reference.containerId || !reference.fileId) return null;
    try {
      const response = await this.client.containers.files.content.retrieve(
        reference.fileId,
        { container_id: reference.containerId },
        {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
        },
      );
      const bytes = await readBoundedResponseBytes(response);
      const responseMediaType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      const mediaType =
        responseMediaType &&
        /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/u.test(responseMediaType)
          ? responseMediaType
          : "application/octet-stream";
      return {
        artifactId: reference.id,
        mediaType,
        bytes,
        ...(reference.filename === undefined ? {} : { filename: reference.filename }),
      };
    } catch (error) {
      throw normalizeAiProviderError(error);
    }
  }

  async summarize(input: string): Promise<AiResponse<string>> {
    const request = this.simpleRequest(
      input,
      "Summarize the provided text accurately and concisely.",
    );
    const result = await this.generateResponse(request);
    return this.wrap(result.text, result);
  }

  async answer(
    question: string,
    sources: readonly GroundingSource[],
  ): Promise<AiResponse<GroundedAnswer>> {
    const sourceText = sources
      .map((source) => `[${source.id}] ${source.title}: ${source.excerpt}`)
      .join("\n");
    const request = this.simpleRequest(`${question}\n\nAuthorized sources:\n${sourceText}`);
    const result = await this.generateResponse(request);
    return this.wrap(
      {
        answer: result.text,
        citations: result.citations.map((citation) => ({
          sourceId: citation.sourceId ?? citation.id,
          title: citation.title,
          url: citation.url,
          domain: citation.domain,
        })),
        grounded: result.citations.length > 0,
      },
      result,
    );
  }

  async extract<T>(request: StructuredExtractionRequest<T>): Promise<AiResponse<T>> {
    const result = await this.generateResponse(
      this.simpleRequest(
        request.input,
        `Return only JSON matching the authorized ${request.schemaName} schema.`,
      ),
    );
    try {
      return this.wrap(JSON.parse(result.text) as T, result);
    } catch {
      throw new AiProviderError({
        code: "invalid_request",
        provider: "openai",
        retryable: false,
        safeMessage: "OpenAI returned invalid structured output.",
      });
    }
  }

  async planAction(input: string): Promise<AiResponse<readonly PlannedAction[]>> {
    const result = await this.generateResponse(this.simpleRequest(input));
    return this.wrap(
      result.toolCalls.map((call) => ({
        actionType: call.name,
        description: `Review proposed ${call.name} action.`,
        requiresConfirmation: true as const,
        executable: false as const,
        parameters: call.arguments,
      })),
      result,
    );
  }

  async embed(): Promise<AiResponse<readonly number[]>> {
    throw this.capabilityError("Embeddings are not exposed by the Responses provider.");
  }

  async speechToText(): Promise<AiResponse<SpeechToTextOutput>> {
    throw this.capabilityError("Speech-to-text is handled by the Realtime provider.");
  }

  async textToSpeech(): Promise<AiResponse<TextToSpeechOutput>> {
    throw this.capabilityError("Text-to-speech is handled by the Realtime provider.");
  }

  async usage(): Promise<readonly AiUsageRecord[]> {
    return [...this.usageRecords];
  }

  async health(): Promise<AiProviderHealth> {
    const result = await this.testConnection();
    return {
      status: result.healthy ? "healthy" : "unhealthy",
      requirementStatus: result.healthy ? "CONNECTED" : "BLOCKED",
      checkedAt: result.testedAt,
      provider: "openai",
      model: this.defaultModel,
      safeMessage: result.safeMessage,
      authenticated: result.authenticated,
    };
  }

  private rememberImage(handoff: OpenAiBinaryArtifactHandoff): void {
    const now = Date.now();
    for (const [id, entry] of this.imageContent) {
      if (now - entry.createdAt > 300_000) this.imageContent.delete(id);
    }
    while (this.imageContent.size >= 8) {
      const oldest = this.imageContent.keys().next().value as string | undefined;
      if (!oldest) break;
      this.imageContent.delete(oldest);
    }
    this.imageContent.set(handoff.artifact.id, {
      content: {
        artifactId: handoff.artifact.id,
        mediaType: handoff.mediaType,
        bytes: handoff.bytes,
      },
      createdAt: now,
    });
  }

  private recordUsage(operation: string, requestId: string, result: AiConversationResult): void {
    this.usageRecords.push({
      operation,
      provider: "openai",
      model: result.model,
      inputUnits: result.usage?.inputTokens ?? 0,
      outputUnits: result.usage?.outputTokens ?? 0,
      estimatedCostUsd: null,
      recordedAt: result.completedAt,
      simulated: false,
      requestId,
      providerResponseId: result.responseId,
      ...(result.usage === null ? {} : { usage: result.usage }),
      costStatus: "unavailable",
    });
    if (this.usageRecords.length > MAX_LEGACY_USAGE_RECORDS) {
      this.usageRecords.splice(0, this.usageRecords.length - MAX_LEGACY_USAGE_RECORDS);
    }
  }

  private simpleRequest(input: string, instructions?: string): AiConversationRequest {
    const requestId = crypto.randomUUID();
    return {
      model: this.defaultModel,
      input,
      ...(instructions === undefined ? {} : { instructions }),
      options: { requestId, correlationId: requestId },
    };
  }

  private wrap<T>(output: T, result: AiConversationResult): AiResponse<T> {
    return {
      output,
      metadata: {
        ...this.identity,
        requestId: result.responseId,
        providerResponseId: result.responseId,
        generatedAt: result.completedAt,
        externalActionPerformed: false,
        ...(result.usage === null ? {} : { usage: result.usage }),
      },
    };
  }

  private capabilityError(safeMessage: string): AiProviderError {
    return new AiProviderError({
      code: "capability_unavailable",
      provider: "openai",
      retryable: false,
      safeMessage,
    });
  }
}
