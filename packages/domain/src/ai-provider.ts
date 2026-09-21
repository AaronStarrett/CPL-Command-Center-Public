import type { EntityId, IsoDateTime, JsonObject, VersionedEntity } from "./entities.js";
import type { AssistantPolicyProvenance } from "./executive-profile.js";
import type {
  AiModelRoutingProfile,
  AiModelValidationMetadata,
  AiRouteDecisionProvenance,
} from "./ai-routing.js";

export type AiProviderKey = "demo" | "openai";
export type AiProviderMode = "demo" | "openai" | "hybrid";
export type ArtifactProviderKey = AiProviderKey | "application";

export interface AiProviderSettings {
  readonly mode: AiProviderMode;
  readonly defaultTextModel: string;
  readonly defaultRealtimeModel: string;
  readonly defaultVoice: string;
  readonly webSearchAllowed: boolean;
  readonly webSearchDefault: boolean;
  readonly codeInterpreterAllowed: boolean;
  readonly imageGenerationAllowed: boolean;
  readonly pdfGenerationAllowed: boolean;
  readonly realtimeAllowed: boolean;
  readonly requestTimeoutMs: number;
  readonly modelCacheTtlSeconds: number;
  readonly dailyRequestLimit: number;
  readonly perUserRequestsPerMinute: number;
  readonly perConversationRequestsPerMinute: number;
  readonly maxUploadBytes: number;
  readonly maxGeneratedFileBytes: number;
  readonly maxResearchDurationSeconds: number;
  readonly codeInterpreterMaxContainerSeconds: number;
  readonly imageQuality: "auto" | "low" | "medium" | "high";
  readonly defaultChartType:
    | "line"
    | "bar"
    | "stacked_bar"
    | "area"
    | "pie_or_donut"
    | "scatter"
    | "timeline"
    | "single_metric"
    | "comparison";
  readonly defaultPdfTemplate: string;
  readonly artifactRetentionDays: number;
  readonly monthlyCostLimitUsd: number | null;
  readonly highCostConfirmationThresholdUsd: number | null;
  readonly realtimeTurnDetection: "server_vad" | "semantic_vad" | "disabled";
  readonly realtimeInteractionMode: "automatic" | "push_to_talk";
  readonly realtimeAllowInterruption: boolean;
  readonly inputTranscriptionModel: string | null;
  readonly realtimeOutputSpeed: number;
  readonly realtimeSessionInstructions: string;
  readonly realtimeMaxOutputTokens: number;
  readonly modelCapabilityOverrides: JsonObject;
  readonly routingProfile: AiModelRoutingProfile;
}

export interface AiProviderConnectionTest extends VersionedEntity {
  provider: AiProviderKey;
  actorUserId: EntityId;
  outcome: "succeeded" | "failed";
  authenticated: boolean;
  safeFailureCode: string | null;
  safeMessage: string;
  modelCount: number | null;
  latencyMs: number | null;
  credentialFingerprint: string | null;
  correlationId: string;
  testedAt: IsoDateTime;
}

export interface AiResponseRun extends VersionedEntity {
  conversationId: EntityId;
  requestedByUserId: EntityId;
  requestId: string;
  provider: AiProviderKey;
  model: string;
  providerResponseId: string | null;
  status: "started" | "completed" | "cancelled" | "failed" | "incomplete";
  correlationId: string;
  errorCode: string | null;
  startedAt: IsoDateTime;
  completedAt: IsoDateTime | null;
  policyProvenance: AssistantPolicyProvenance;
  routeDecision: AiRouteDecisionProvenance | null;
}

export interface AiMessageCitationRecord extends VersionedEntity {
  responseRunId: EntityId;
  assistantMessageId: EntityId | null;
  providerItemId: string | null;
  title: string;
  url: string;
  domain: string;
  startIndex: number | null;
  endIndex: number | null;
  retrievedAt: IsoDateTime;
  simulated: boolean;
}

export interface AiToolCallRecord extends VersionedEntity {
  responseRunId: EntityId;
  providerCallId: string | null;
  name: string;
  arguments: JsonObject;
  status: "proposed" | "validated" | "rejected" | "completed" | "failed";
  requiredPermissions: readonly string[];
  effect: "read" | "preview";
  errorCode: string | null;
}

export interface AiUsageLedgerRecord extends VersionedEntity {
  responseRunId: EntityId | null;
  realtimeSessionId: EntityId | null;
  requestedByUserId: EntityId;
  provider: AiProviderKey;
  model: string;
  operation: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  audioInputTokens: number;
  audioOutputTokens: number;
  realtimeDurationSeconds: number;
  estimatedCostUsd: string | null;
  costStatus: "unavailable" | "estimated" | "provider_reported";
  simulated: boolean;
  recordedAt: IsoDateTime;
}

export interface AiModelCacheRecord extends VersionedEntity {
  provider: AiProviderKey;
  modelId: string;
  available: boolean;
  ownedBy: string | null;
  capabilities: JsonObject;
  capabilitySource: "provider" | "configured" | "demo_fixture" | "unknown" | "registry" | "probe";
  validation: AiModelValidationMetadata;
  fetchedAt: IsoDateTime;
  expiresAt: IsoDateTime;
}

export interface AiRealtimeSessionRecord extends VersionedEntity {
  conversationId: EntityId | null;
  requestedByUserId: EntityId;
  provider: AiProviderKey;
  providerSessionId: string | null;
  model: string;
  voice: string;
  status: "authorized" | "connected" | "completed" | "failed" | "cancelled";
  correlationId: string;
  authorizedAt: IsoDateTime;
  expiresAt: IsoDateTime;
  completedAt: IsoDateTime | null;
  errorCode: string | null;
  simulated: boolean;
  policyProvenance: AssistantPolicyProvenance;
  routeDecision: AiRouteDecisionProvenance | null;
}

export interface GeneratedArtifactRecord extends VersionedEntity {
  conversationId: EntityId;
  responseRunId: EntityId | null;
  requestedByUserId: EntityId;
  kind:
    | "research_report"
    | "source_board"
    | "chart"
    | "graph"
    | "table"
    | "metric_summary"
    | "timeline"
    | "comparison"
    | "pdf"
    | "image"
    | "data_file"
    | "text_document"
    | "analysis_result"
    | "web_search_result"
    | "code_interpreter_output"
    | "research_presentation";
  title: string;
  status: "preparing" | "generating" | "ready" | "partial" | "failed" | "expired" | "archived";
  artifactVersion: number;
  provider: ArtifactProviderKey;
  providerItemId: string | null;
  providerContainerId: string | null;
  providerFileId: string | null;
  filename: string | null;
  mediaType: string | null;
  storageReference: string | null;
  specification: JsonObject;
  sourceMetadata: JsonObject;
  citationIds: readonly string[];
  fileMetadata: JsonObject;
  renderMetadata: JsonObject;
  generationMetadata: JsonObject;
  requiredPermissions: readonly string[];
  simulated: boolean;
  errorCode: string | null;
  policyProvenance: AssistantPolicyProvenance;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: IsoDateTime;
}
