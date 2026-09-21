import type {
  AiPresentationNarrationSegment,
  AiPresentationPacket,
  AiPresentationVisualElementId,
} from "@bea/domain";

export const NARRATION_LIFECYCLE_EVENT_TYPES = [
  "narration.requested",
  "narration.started",
  "narration.segment_started",
  "narration.output_active",
  "narration.segment_completed",
  "narration.interrupted",
  "narration.stopped",
  "narration.completed",
  "narration.failed",
] as const;

export type NarrationLifecycleEventType = (typeof NARRATION_LIFECYCLE_EVENT_TYPES)[number];

export const NARRATION_CONTROLLER_STATUSES = [
  "idle",
  "requested",
  "narrating",
  "interrupted",
  "stopped",
  "completed",
  "failed",
] as const;

export type NarrationControllerStatus = (typeof NARRATION_CONTROLLER_STATUSES)[number];

export interface NarrationRequestMetadata {
  readonly presentationRunId: string;
  readonly narrationSegmentId: string;
  readonly visualElementId: AiPresentationVisualElementId;
  readonly realtimeSessionId: string | null;
  readonly providerResponseId: string | null;
  readonly spokenText: string;
}

export interface NarrationLifecycleEvent {
  readonly type: NarrationLifecycleEventType;
  readonly presentationRunId: string;
  readonly narrationSegmentId: string | null;
  readonly visualElementId: AiPresentationVisualElementId | null;
  readonly realtimeSessionId: string | null;
  readonly providerResponseId: string | null;
  readonly source: "realtime-audio" | "simulated-visual-test";
  readonly at: string;
}

export interface NarrationControllerState {
  readonly status: NarrationControllerStatus;
  readonly presentationRunId: string | null;
  readonly realtimeSessionId: string | null;
  readonly providerResponseId: string | null;
  readonly activeSegmentId: string | null;
  readonly activeVisualElementId: AiPresentationVisualElementId | null;
  readonly completedSegmentIds: readonly string[];
  readonly lastCompletedSegmentId: string | null;
  readonly queuedSegmentIds: readonly string[];
  readonly narrationActive: boolean;
  readonly audioOutputActive: boolean;
  readonly source: "realtime-audio" | "simulated-visual-test" | null;
  readonly needsVoiceToHearBriefing: boolean;
}

export const IDLE_NARRATION_STATE: NarrationControllerState = Object.freeze({
  status: "idle",
  presentationRunId: null,
  realtimeSessionId: null,
  providerResponseId: null,
  activeSegmentId: null,
  activeVisualElementId: null,
  completedSegmentIds: Object.freeze([]),
  lastCompletedSegmentId: null,
  queuedSegmentIds: Object.freeze([]),
  narrationActive: false,
  audioOutputActive: false,
  source: null,
  needsVoiceToHearBriefing: false,
});

export function createIdleNarrationState(
  patch: Partial<NarrationControllerState> = {},
): NarrationControllerState {
  return {
    ...IDLE_NARRATION_STATE,
    completedSegmentIds: [
      ...(patch.completedSegmentIds ?? IDLE_NARRATION_STATE.completedSegmentIds),
    ],
    queuedSegmentIds: [...(patch.queuedSegmentIds ?? IDLE_NARRATION_STATE.queuedSegmentIds)],
    ...patch,
  };
}

export function narrationSegmentsFromPacket(
  packet: Pick<AiPresentationPacket, "narrationSegments">,
): readonly AiPresentationNarrationSegment[] {
  return [...packet.narrationSegments].sort((left, right) => left.order - right.order);
}

export function boundedNarrationInstructions(input: {
  readonly presentationRunId: string;
  readonly segment: AiPresentationNarrationSegment;
  readonly packetTitle: string;
}): string {
  return [
    "Speak only this authorized narration segment from the displayed presentation packet.",
    "Do not invent findings, implications, risks, recommendations, sources, IDs, or visual selectors.",
    "You may add a brief natural transition of at most one short sentence that does not add new facts.",
    `Presentation: ${input.packetTitle}`,
    `presentationRunId=${input.presentationRunId}`,
    `narrationSegmentId=${input.segment.id}`,
    `visualElementId=${input.segment.visualElementId}`,
    "Authorized spoken text:",
    input.segment.spokenText.slice(0, 1_200),
  ].join("\n");
}

export function canStartLiveNarration(input: {
  readonly voiceConnected: boolean;
  readonly speakResponses: boolean;
  readonly packetReady: boolean;
}): boolean {
  return input.voiceConnected && input.speakResponses && input.packetReady;
}

export function applyNarrationLifecycleEvent(
  state: NarrationControllerState,
  event: NarrationLifecycleEvent,
): NarrationControllerState {
  if (
    state.presentationRunId &&
    event.presentationRunId !== state.presentationRunId &&
    event.type !== "narration.requested"
  ) {
    return state;
  }
  const completed = new Set(state.completedSegmentIds);
  switch (event.type) {
    case "narration.requested":
      return {
        ...state,
        status: state.narrationActive ? "narrating" : "requested",
        presentationRunId: event.presentationRunId,
        realtimeSessionId: event.realtimeSessionId,
        providerResponseId: event.providerResponseId ?? state.providerResponseId,
        source: event.source,
        audioOutputActive: false,
      };
    case "narration.started":
      return {
        ...state,
        status: "narrating",
        presentationRunId: event.presentationRunId,
        realtimeSessionId: event.realtimeSessionId,
        providerResponseId: event.providerResponseId ?? state.providerResponseId,
        narrationActive: true,
        audioOutputActive: true,
        source: event.source,
      };
    case "narration.segment_started":
      return {
        ...state,
        status: "narrating",
        presentationRunId: event.presentationRunId,
        realtimeSessionId: event.realtimeSessionId,
        providerResponseId: event.providerResponseId ?? state.providerResponseId,
        activeSegmentId: event.narrationSegmentId,
        activeVisualElementId: event.visualElementId,
        narrationActive: true,
        audioOutputActive: true,
        queuedSegmentIds: state.queuedSegmentIds.filter((id) => id !== event.narrationSegmentId),
        source: event.source,
      };
    case "narration.output_active":
      return {
        ...state,
        status: "narrating",
        narrationActive: true,
        audioOutputActive: true,
        providerResponseId: event.providerResponseId ?? state.providerResponseId,
      };
    case "narration.segment_completed": {
      if (event.narrationSegmentId) completed.add(event.narrationSegmentId);
      const remaining = state.queuedSegmentIds.filter((id) => id !== event.narrationSegmentId);
      return {
        ...state,
        completedSegmentIds: [...completed],
        lastCompletedSegmentId: event.narrationSegmentId ?? state.lastCompletedSegmentId,
        activeSegmentId: remaining.length > 0 ? state.activeSegmentId : null,
        narrationActive: remaining.length > 0 ? true : false,
        audioOutputActive: false,
        queuedSegmentIds: remaining,
        providerResponseId: event.providerResponseId ?? state.providerResponseId,
      };
    }
    case "narration.interrupted":
      return {
        ...state,
        status: "interrupted",
        narrationActive: false,
        audioOutputActive: false,
        queuedSegmentIds: [],
        activeSegmentId: null,
      };
    case "narration.stopped":
      return {
        ...state,
        status: "stopped",
        narrationActive: false,
        audioOutputActive: false,
        queuedSegmentIds: [],
        activeSegmentId: null,
        activeVisualElementId: state.activeVisualElementId,
      };
    case "narration.completed":
      return {
        ...state,
        status: "completed",
        narrationActive: false,
        audioOutputActive: false,
        queuedSegmentIds: [],
        activeSegmentId: null,
        lastCompletedSegmentId: event.narrationSegmentId ?? state.lastCompletedSegmentId,
      };
    case "narration.failed":
      return {
        ...state,
        status: "failed",
        narrationActive: false,
        audioOutputActive: false,
        queuedSegmentIds: [],
      };
    default:
      return state;
  }
}

export function mapRealtimeServerEventToLifecycle(input: {
  readonly type: string;
  readonly presentationRunId: string;
  readonly narrationSegmentId: string | null;
  readonly visualElementId: AiPresentationVisualElementId | null;
  readonly realtimeSessionId: string | null;
  readonly providerResponseId: string | null;
  readonly now?: string;
}): NarrationLifecycleEvent | null {
  const at = input.now ?? new Date().toISOString();
  const base = {
    presentationRunId: input.presentationRunId,
    narrationSegmentId: input.narrationSegmentId,
    visualElementId: input.visualElementId,
    realtimeSessionId: input.realtimeSessionId,
    providerResponseId: input.providerResponseId,
    source: "realtime-audio" as const,
    at,
  };
  if (
    input.type === "response.output_audio.delta" ||
    input.type === "response.output_audio.delta.started"
  ) {
    return { type: "narration.output_active", ...base };
  }
  if (
    input.type === "response.output_audio.done" ||
    input.type === "response.done" ||
    input.type === "response.completed"
  ) {
    return { type: "narration.segment_completed", ...base };
  }
  if (
    input.type === "input_audio_buffer.speech_started" ||
    input.type === "response.cancelled" ||
    input.type === "output_audio_buffer.cleared"
  ) {
    return { type: "narration.interrupted", ...base };
  }
  if (input.type === "error" || input.type === "session.expired") {
    return { type: "narration.failed", ...base };
  }
  return null;
}

export function narrationAuditMetadata(event: NarrationLifecycleEvent): Record<string, unknown> {
  return {
    type: event.type,
    presentationRunId: event.presentationRunId,
    narrationSegmentId: event.narrationSegmentId,
    visualElementId: event.visualElementId,
    realtimeSessionId: event.realtimeSessionId,
    providerResponseId: event.providerResponseId,
    source: event.source,
    at: event.at,
  };
}
