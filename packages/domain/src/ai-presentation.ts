import type { EntityId, IsoDateTime, JsonObject, VersionedEntity } from "./entities.js";
import type { AiWorkloadRouteKey } from "./ai-routing.js";

export const AI_PRESENTATION_CONTRACT_VERSION = "phase2.1-v1";

export const AI_PRESENTATION_STATUSES = [
  "idle",
  "listening",
  "thinking",
  "researching",
  "preparing",
  "ready",
  "narrating",
  "interrupted",
  "insufficient_evidence",
  "failed",
  "provider_disconnected",
] as const;

export type AiPresentationStatus = (typeof AI_PRESENTATION_STATUSES)[number];

export const AI_PRESENTATION_SELECTION_KINDS = [
  "finding",
  "implication",
  "risk",
  "recommendation",
  "source",
  "lead",
  "record",
] as const;

export type AiPresentationSelectionKind = (typeof AI_PRESENTATION_SELECTION_KINDS)[number];

export const AI_PRESENTATION_RECORD_TYPES = [
  "lead",
  "company",
  "contact",
  "task",
  "activity",
  "notification",
  "integration",
  "workflow-run",
] as const;

export type AiPresentationRecordType = (typeof AI_PRESENTATION_RECORD_TYPES)[number];

export type AiPresentationVisualElementId =
  | "summary"
  | `finding:${string}`
  | `implication:${string}`
  | `risk:${string}`
  | `recommendation:${string}`
  | `source:${string}`
  | `lead:${string}`
  | `record:${string}`;

export interface AiSafeWorkspaceSelection {
  readonly presentationRunId: string;
  readonly artifactId: string;
  readonly kind: AiPresentationSelectionKind;
  readonly elementId: string;
  readonly recordType?: AiPresentationRecordType;
  readonly recordId?: string;
}

export interface AiPresentationNarrationSegment {
  readonly id: string;
  readonly order: number;
  readonly visualElementId: AiPresentationVisualElementId;
  readonly spokenText: string;
}

export interface AiPresentationFinding {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly sourceIds: readonly string[];
  readonly citationIds: readonly string[];
}

export interface AiPresentationImplication {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

export interface AiPresentationRisk {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

export interface AiPresentationRecommendation {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

export interface AiPresentationSource {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly domain: string;
  readonly url: string;
  readonly retrievedAt: IsoDateTime;
  readonly supportsFindingIds: readonly string[];
  readonly simulated: boolean;
}

export interface AiPresentationCitation {
  readonly id: string;
  readonly sourceId: string;
  readonly title: string;
  readonly url: string;
  readonly domain: string;
  readonly startIndex?: number;
  readonly endIndex?: number;
  readonly retrievedAt: IsoDateTime;
  readonly simulated: boolean;
}

export interface AiPresentationUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly costClass: "low" | "standard" | "high";
  readonly costStatus: "unavailable" | "estimated" | "provider_reported";
}

export interface AiPresentationPacket {
  readonly contractVersion: typeof AI_PRESENTATION_CONTRACT_VERSION;
  readonly presentationRunId: string;
  readonly conversationId: string;
  readonly initiatingUserMessageId: string | null;
  readonly assistantMessageId: string | null;
  readonly actingUserId: string;
  readonly routeKey: AiWorkloadRouteKey | "record_retrieval";
  readonly provider: string;
  readonly model: string;
  readonly providerResponseId: string | null;
  readonly status: AiPresentationStatus;
  readonly query: string;
  readonly title: string;
  readonly summary: string;
  readonly findings: readonly AiPresentationFinding[];
  readonly implications: readonly AiPresentationImplication[];
  readonly risks: readonly AiPresentationRisk[];
  readonly recommendations: readonly AiPresentationRecommendation[];
  readonly suggestedNextStep: string;
  readonly sources: readonly AiPresentationSource[];
  readonly citations: readonly AiPresentationCitation[];
  readonly visualArtifactId: string | null;
  readonly narrationSegments: readonly AiPresentationNarrationSegment[];
  readonly selected: AiSafeWorkspaceSelection | null;
  readonly autoFollow: boolean;
  readonly startedAt: IsoDateTime;
  readonly completedAt: IsoDateTime | null;
  readonly usage: AiPresentationUsage | null;
  readonly error: { readonly code: string; readonly safeMessage: string } | null;
  readonly simulated: boolean;
  readonly liveWebSearch: boolean;
  readonly beaRecordsLive: boolean;
  readonly requiredPermissions: readonly string[];
  readonly analysisValidated?: boolean;
  readonly lastCompletedNarrationSegmentId?: string | null;
}

export interface AiPresentationRunRecord extends VersionedEntity {
  readonly conversationId: EntityId;
  readonly responseRunId: EntityId | null;
  readonly realtimeSessionId: EntityId | null;
  readonly initiatingUserMessageId: EntityId | null;
  readonly assistantMessageId: EntityId | null;
  readonly visualArtifactId: EntityId | null;
  readonly actingUserId: EntityId;
  readonly routeKey: string;
  readonly provider: string;
  readonly model: string;
  readonly providerResponseId: string | null;
  readonly status: AiPresentationStatus;
  readonly query: string;
  readonly packet: JsonObject;
  readonly selectedContext: JsonObject | null;
  readonly autoFollow: boolean;
  readonly simulated: boolean;
  readonly liveWebSearch: boolean;
  readonly requiredPermissions: readonly string[];
  readonly usageMetadata: JsonObject;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly startedAt: IsoDateTime;
  readonly completedAt: IsoDateTime | null;
}
