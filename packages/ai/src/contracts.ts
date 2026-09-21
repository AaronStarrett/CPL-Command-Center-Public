import type {
  AiModelValidationMetadata,
  AiRouteDecisionProvenance,
  IsoDateTime,
  JsonObject,
} from "@bea/domain";

export const MAX_AI_GENERATED_ARTIFACT_BYTES = 25_000_000;

export interface AiProviderIdentity {
  readonly provider: string;
  readonly model: string;
  readonly mode: "mock" | "live";
  readonly requirementStatus: AiProviderRequirementStatus;
  readonly displayName?: string;
}

export type AiProviderRequirementStatus =
  | "SIMULATED"
  | "SETUP_REQUIRED"
  | "CONFIGURED_NOT_TESTED"
  | "TESTING"
  | "CONNECTED"
  | "CONNECTION_FAILED"
  | "DISABLED"
  | "BLOCKED";

export interface AiTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly reasoningTokens?: number;
  readonly cachedInputTokens?: number;
  readonly audioInputTokens?: number;
  readonly audioOutputTokens?: number;
}

export interface AiResponseMetadata extends AiProviderIdentity {
  readonly requestId: string;
  readonly generatedAt: IsoDateTime;
  readonly externalActionPerformed: false;
  readonly providerResponseId?: string;
  readonly correlationId?: string;
  readonly usage?: AiTokenUsage;
}

export interface AiResponse<T> {
  readonly output: T;
  readonly metadata: AiResponseMetadata;
}

export interface StructuredExtractionRequest<T> {
  readonly schemaName: string;
  readonly input: string;
  readonly fixture: T;
}

export interface GroundingSource {
  readonly id: string;
  readonly title: string;
  readonly excerpt: string;
  readonly url?: string;
  readonly domain?: string;
  readonly retrievedAt?: IsoDateTime;
  readonly simulated?: boolean;
}

export interface AiCitation {
  readonly id: string;
  readonly sourceId?: string;
  readonly title: string;
  readonly url: string;
  readonly domain: string;
  readonly startIndex?: number;
  readonly endIndex?: number;
  readonly retrievedAt: IsoDateTime;
  readonly toolCallId?: string;
  readonly simulated: boolean;
}

export interface AiWebSource {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly domain: string;
  readonly retrievedAt: IsoDateTime;
  readonly toolCallId: string;
  readonly simulated: boolean;
}

export interface AiFileSource {
  readonly id: string;
  readonly filename: string;
  readonly fileId: string;
  readonly vectorStoreId?: string;
  readonly score?: number;
  readonly excerpt?: string;
  readonly retrievedAt: IsoDateTime;
  readonly toolCallId: string;
  readonly simulated: boolean;
}

export interface GroundedAnswer {
  readonly answer: string;
  readonly citations: readonly {
    sourceId: string;
    title: string;
    url?: string;
    domain?: string;
  }[];
  readonly grounded: boolean;
}

export interface PlannedAction {
  readonly actionType: string;
  readonly description: string;
  readonly requiresConfirmation: true;
  readonly executable: false;
  readonly parameters: JsonObject;
}

export interface SpeechToTextOutput {
  readonly transcript: string;
  readonly durationSeconds: number;
}

export interface TextToSpeechOutput {
  readonly audioReference: string;
  readonly mimeType: "audio/wav";
  readonly simulated: boolean;
}

export interface AiUsageRecord {
  readonly operation: string;
  readonly provider: string;
  readonly model: string;
  readonly inputUnits: number;
  readonly outputUnits: number;
  readonly estimatedCostUsd: number | null;
  readonly recordedAt: IsoDateTime;
  readonly simulated: boolean;
  readonly requestId?: string;
  readonly providerResponseId?: string;
  readonly usage?: AiTokenUsage;
  readonly realtimeDurationSeconds?: number;
  readonly costStatus?: "unavailable" | "estimated" | "provider_reported";
}

export interface AiProviderHealth {
  readonly status: "healthy" | "unhealthy" | "not_configured";
  readonly requirementStatus: AiProviderRequirementStatus;
  readonly checkedAt: IsoDateTime;
  readonly provider: string;
  readonly model: string;
  readonly safeMessage?: string;
  readonly authenticated?: boolean;
}

export type AiCapabilityState = true | false | "unknown" | "candidate";

export interface AiModelCapabilities {
  readonly responsesText: AiCapabilityState;
  readonly streaming: AiCapabilityState;
  readonly reasoning: AiCapabilityState;
  readonly functionCalling: AiCapabilityState;
  readonly structuredOutputs: AiCapabilityState;
  readonly webSearch: AiCapabilityState;
  readonly fileSearch: AiCapabilityState;
  readonly codeInterpreter: AiCapabilityState;
  readonly imageGeneration: AiCapabilityState;
  readonly imageInput: AiCapabilityState;
  readonly fileInput: AiCapabilityState;
  readonly realtime: AiCapabilityState;
  readonly audioInput: AiCapabilityState;
  readonly audioOutput: AiCapabilityState;
  readonly embeddings: AiCapabilityState;
}

export interface AiModelMetadata {
  readonly id: string;
  readonly provider: string;
  readonly displayName: string;
  readonly available: boolean;
  readonly createdAt?: IsoDateTime;
  readonly ownedBy?: string;
  readonly capabilities: AiModelCapabilities;
  readonly capabilitySource:
    "provider" | "configured" | "demo_fixture" | "unknown" | "registry" | "probe";
  readonly validation: AiModelValidationMetadata;
}

export interface AiRequestOptions {
  readonly requestId: string;
  readonly correlationId: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly userSafetyIdentifier?: string;
  readonly maxOutputTokens?: number;
}

export interface AiToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;
  readonly strict: boolean;
  readonly requiredPermissions: readonly string[];
  readonly effect: "read" | "preview";
}

export interface AiToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: JsonObject;
  readonly status: "proposed" | "validated" | "rejected" | "completed" | "failed";
  readonly providerCallId?: string;
}

export type AiBuiltInToolRequest =
  | { readonly type: "web_search" }
  | {
      readonly type: "file_search";
      readonly vectorStoreIds: readonly string[];
      readonly maxNumResults?: number;
    }
  | {
      readonly type: "code_interpreter";
      readonly container: { readonly type: "auto"; readonly memoryLimit: "4g" };
    }
  | {
      readonly type: "image_generation";
      readonly partialImages?: 1 | 2 | 3;
      readonly quality?: "auto" | "low" | "medium" | "high";
    };

export interface AiInputFileReference {
  readonly type: "input_file";
  readonly fileId?: string;
  readonly fileUrl?: string;
  readonly detail?: "auto" | "low" | "high";
}

/** Server-only upload handoff from an owner-authorized, validated artifact. */
export interface AiAuthorizedInputFileUpload {
  readonly ownerId: string;
  readonly artifactId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly detail?: "auto" | "low" | "high";
}

export interface AiGeneratedArtifactReference {
  readonly id: string;
  readonly kind: "container_file" | "generated_image";
  readonly providerItemId: string;
  readonly containerId?: string;
  readonly fileId?: string;
  readonly filename?: string;
  readonly partialImageIndex?: number;
  readonly simulated: boolean;
  readonly rawBytesPersisted: false;
}

/** Server-only handoff. Never include this object in browser DTOs, logs, audits, or database JSON. */
export interface AiGeneratedArtifactContent {
  readonly artifactId: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly filename?: string;
}

export interface AiGeneratedArtifactContentProvider {
  fetchGeneratedArtifactContent(
    reference: AiGeneratedArtifactReference,
    options: Pick<AiRequestOptions, "signal" | "timeoutMs">,
  ): Promise<AiGeneratedArtifactContent | null>;
}

export interface AiConversationRequest {
  readonly model: string;
  readonly input: string;
  readonly history?: readonly {
    readonly role: "user" | "assistant";
    readonly content: string;
  }[];
  readonly instructions?: string;
  readonly persona?: {
    readonly kind:
      | "executive-business-partner"
      | "sales-support"
      | "operations-coordination"
      | "executive-reporting"
      | "integration-support"
      | "general-support";
    readonly preferredName?: string | null;
  };
  readonly previousResponseId?: string;
  readonly tools?: readonly AiToolDefinition[];
  readonly builtInTools?: readonly AiBuiltInToolRequest[];
  readonly files?: readonly AiInputFileReference[];
  readonly webSearch?: boolean;
  readonly routeDecision?: AiRouteDecisionProvenance;
  readonly options: AiRequestOptions;
}

export interface AiConversationResult {
  readonly responseId: string;
  readonly model: string;
  readonly text: string;
  readonly citations: readonly AiCitation[];
  readonly webSources: readonly AiWebSource[];
  readonly fileSources?: readonly AiFileSource[];
  readonly toolCalls: readonly AiToolCall[];
  readonly generatedArtifacts: readonly AiGeneratedArtifactReference[];
  readonly usage: AiTokenUsage | null;
  readonly completedAt: IsoDateTime;
  readonly simulated: boolean;
  readonly routeDecision?: AiRouteDecisionProvenance;
}

export type AiResponseStreamEvent =
  | {
      readonly type: "response.started";
      readonly requestId: string;
      readonly providerResponseId: string;
      readonly model: string;
      readonly simulated: boolean;
    }
  | { readonly type: "response.output_text.delta"; readonly delta: string }
  | { readonly type: "response.citation"; readonly citation: AiCitation }
  | { readonly type: "response.web_source"; readonly source: AiWebSource }
  | { readonly type: "response.file_source"; readonly source: AiFileSource }
  | { readonly type: "response.tool_call"; readonly toolCall: AiToolCall }
  | {
      readonly type: "response.generated_artifact";
      readonly artifact: AiGeneratedArtifactReference;
    }
  | { readonly type: "response.usage"; readonly usage: AiTokenUsage }
  | { readonly type: "response.completed"; readonly result: AiConversationResult }
  | { readonly type: "response.cancelled"; readonly requestId: string }
  | {
      readonly type: "response.error";
      readonly code: string;
      readonly safeMessage: string;
      readonly retryable: boolean;
    };

export interface AiConnectionTestResult {
  readonly provider: string;
  readonly healthy: boolean;
  readonly authenticated: boolean;
  readonly testedAt: IsoDateTime;
  readonly safeMessage: string;
  readonly modelCount?: number;
}

export interface AiRealtimeSessionConfig {
  readonly model: string;
  readonly voice: string;
  readonly instructions?: string;
  readonly modalities?: readonly ("audio" | "text")[];
  readonly tools?: readonly AiToolDefinition[];
  readonly turnDetection?: "server_vad" | "semantic_vad" | "disabled";
  readonly interactionMode?: "automatic" | "push_to_talk";
  readonly allowInterruption?: boolean;
  readonly inputTranscriptionModel?: string | null;
  readonly outputSpeed?: number;
  readonly maxOutputTokens?: number;
}

export interface AiRealtimeClientAuthorization {
  readonly provider: string;
  readonly clientSecret: string;
  readonly expiresAt: IsoDateTime;
  readonly sessionId?: string;
  readonly model: string;
  readonly voice: string;
  readonly simulated: boolean;
}

export interface AiProvider {
  readonly identity: AiProviderIdentity;
  extract<T>(request: StructuredExtractionRequest<T>): Promise<AiResponse<T>>;
  summarize(input: string): Promise<AiResponse<string>>;
  answer(
    question: string,
    sources: readonly GroundingSource[],
  ): Promise<AiResponse<GroundedAnswer>>;
  embed(input: string): Promise<AiResponse<readonly number[]>>;
  planAction(request: string): Promise<AiResponse<readonly PlannedAction[]>>;
  speechToText(audio: Uint8Array): Promise<AiResponse<SpeechToTextOutput>>;
  textToSpeech(text: string): Promise<AiResponse<TextToSpeechOutput>>;
  usage(): Promise<readonly AiUsageRecord[]>;
  health(): Promise<AiProviderHealth>;
}

/** Provider-neutral contract used by the AI Command runtime. */
export interface AiCommandProvider extends AiProvider {
  readonly providerKey: string;
  generateResponse(request: AiConversationRequest): Promise<AiConversationResult>;
  streamResponse(request: AiConversationRequest): AsyncIterable<AiResponseStreamEvent>;
  listModels(
    options?: Pick<AiRequestOptions, "signal" | "timeoutMs">,
  ): Promise<readonly AiModelMetadata[]>;
  testConnection(
    options?: Pick<AiRequestOptions, "signal" | "timeoutMs" | "userSafetyIdentifier">,
  ): Promise<AiConnectionTestResult>;
  createRealtimeClientAuthorization(
    configuration: AiRealtimeSessionConfig,
    options: AiRequestOptions,
  ): Promise<AiRealtimeClientAuthorization>;
  uploadInputFile(
    input: AiAuthorizedInputFileUpload,
    options: Pick<AiRequestOptions, "signal" | "timeoutMs">,
  ): Promise<AiInputFileReference>;
}
