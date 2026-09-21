import type {
  BrowserRealtimeVoiceAdapter,
  BrowserVoiceSnapshot,
} from "@/lib/browser-realtime-voice";
import type { AiPresentationNarrationSegment, AiPresentationPacket } from "@bea/domain";
import {
  applyNarrationLifecycleEvent,
  boundedNarrationInstructions,
  canStartLiveNarration,
  createIdleNarrationState,
  IDLE_NARRATION_STATE,
  mapRealtimeServerEventToLifecycle,
  narrationSegmentsFromPacket,
  type NarrationControllerState,
  type NarrationLifecycleEvent,
  type NarrationRequestMetadata,
} from "@bea/ai/presentation";

export interface PresentationNarrationController {
  readonly getState: () => NarrationControllerState;
  readonly start: (
    packet: AiPresentationPacket,
    options: NarrationStartOptions,
  ) => NarrationControllerState;
  readonly handleRealtimeEvent: (event: {
    readonly type: string;
    readonly providerResponseId?: string | null;
    readonly sessionId?: string | null;
  }) => NarrationControllerState;
  readonly interrupt: (
    reason?: "vad" | "push-to-talk" | "typed" | "pause" | "stop",
  ) => NarrationControllerState;
  readonly stop: () => NarrationControllerState;
  readonly pause: () => NarrationControllerState;
  readonly disconnect: () => NarrationControllerState;
  readonly currentVisualElementId: () => string | null;
}

export interface NarrationStartOptions {
  readonly voiceConnected: boolean;
  readonly speakResponses: boolean;
  readonly realtimeSessionId?: string | null;
  readonly mode?: "live" | "test" | "simulated-visual-test";
}

function snapshotConnected(snapshot: BrowserVoiceSnapshot | undefined): boolean {
  if (!snapshot) return false;
  return [
    "listening",
    "user-speaking",
    "processing",
    "assistant-speaking",
    "interrupted",
    "muted",
  ].includes(snapshot.state);
}

export function isRealtimeVoiceConnected(snapshot: BrowserVoiceSnapshot | undefined): boolean {
  return snapshotConnected(snapshot);
}

export function createPresentationNarrationController(input: {
  readonly adapter?: Pick<
    BrowserRealtimeVoiceAdapter,
    "requestNarrationSegment" | "interrupt" | "clearPendingOutput" | "getSnapshot"
  >;
  readonly onState: (state: NarrationControllerState) => void;
  readonly onAudit?: (event: NarrationLifecycleEvent) => void;
  readonly now?: () => string;
  readonly simulatedVisualDelayMs?: number;
  readonly schedule?: (callback: () => void, ms: number) => number;
  readonly clearSchedule?: (handle: number) => void;
}): PresentationNarrationController {
  let state: NarrationControllerState = IDLE_NARRATION_STATE;
  let packet: AiPresentationPacket | null = null;
  let pending: NarrationRequestMetadata | null = null;
  let audioStartedForPending = false;
  let simulatedTimer: number | undefined;
  let interrupting = false;
  const now = input.now ?? (() => new Date().toISOString());
  const schedule = input.schedule ?? ((callback, ms) => window.setTimeout(callback, ms));
  const clearSchedule = input.clearSchedule ?? ((handle) => window.clearTimeout(handle));

  function publish(next: NarrationControllerState): NarrationControllerState {
    state = next;
    input.onState(state);
    return state;
  }

  function audit(event: NarrationLifecycleEvent): void {
    input.onAudit?.(event);
  }

  function emit(event: NarrationLifecycleEvent): NarrationControllerState {
    audit(event);
    return publish(applyNarrationLifecycleEvent(state, event));
  }

  function clearSimulated(): void {
    if (simulatedTimer !== undefined) {
      clearSchedule(simulatedTimer);
      simulatedTimer = undefined;
    }
  }

  function requestSegment(segment: AiPresentationNarrationSegment, sessionId: string | null) {
    if (!packet) return false;
    pending = {
      presentationRunId: packet.presentationRunId,
      narrationSegmentId: segment.id,
      visualElementId: segment.visualElementId,
      realtimeSessionId: sessionId,
      providerResponseId: null,
      spokenText: segment.spokenText,
    };
    audioStartedForPending = false;
    const requested: NarrationLifecycleEvent = {
      type: "narration.requested",
      presentationRunId: packet.presentationRunId,
      narrationSegmentId: segment.id,
      visualElementId: segment.visualElementId,
      realtimeSessionId: sessionId,
      providerResponseId: null,
      source: state.source === "simulated-visual-test" ? "simulated-visual-test" : "realtime-audio",
      at: now(),
    };
    emit(requested);
    if (state.source === "simulated-visual-test") return true;
    return (
      input.adapter?.requestNarrationSegment({
        presentationRunId: packet.presentationRunId,
        narrationSegmentId: segment.id,
        visualElementId: segment.visualElementId,
        spokenText: segment.spokenText,
        instructions: boundedNarrationInstructions({
          presentationRunId: packet.presentationRunId,
          segment,
          packetTitle: packet.title,
        }),
      }) ?? false
    );
  }

  function requestNext(sessionId: string | null): void {
    if (!packet || pending) return;
    const remaining = narrationSegmentsFromPacket(packet).filter(
      (segment) => !state.completedSegmentIds.includes(segment.id),
    );
    const next = remaining[0];
    if (!next) {
      emit({
        type: "narration.completed",
        presentationRunId: packet.presentationRunId,
        narrationSegmentId: state.lastCompletedSegmentId,
        visualElementId: state.activeVisualElementId,
        realtimeSessionId: sessionId,
        providerResponseId: state.providerResponseId,
        source: state.source ?? "realtime-audio",
        at: now(),
      });
      return;
    }
    const sent = requestSegment(next, sessionId);
    if (!sent && state.source !== "simulated-visual-test") {
      emit({
        type: "narration.failed",
        presentationRunId: packet.presentationRunId,
        narrationSegmentId: next.id,
        visualElementId: next.visualElementId,
        realtimeSessionId: sessionId,
        providerResponseId: null,
        source: "realtime-audio",
        at: now(),
      });
    }
  }

  function startSimulatedVisual(current: AiPresentationPacket): void {
    clearSimulated();
    const segments = narrationSegmentsFromPacket(current);
    let index = 0;
    const tick = () => {
      const segment = segments[index];
      if (!segment || !packet || packet.presentationRunId !== current.presentationRunId) {
        if (packet && packet.presentationRunId === current.presentationRunId) {
          emit({
            type: "narration.completed",
            presentationRunId: current.presentationRunId,
            narrationSegmentId: state.lastCompletedSegmentId,
            visualElementId: state.activeVisualElementId,
            realtimeSessionId: null,
            providerResponseId: null,
            source: "simulated-visual-test",
            at: now(),
          });
        }
        return;
      }
      emit({
        type: "narration.started",
        presentationRunId: current.presentationRunId,
        narrationSegmentId: segment.id,
        visualElementId: segment.visualElementId,
        realtimeSessionId: null,
        providerResponseId: null,
        source: "simulated-visual-test",
        at: now(),
      });
      emit({
        type: "narration.segment_started",
        presentationRunId: current.presentationRunId,
        narrationSegmentId: segment.id,
        visualElementId: segment.visualElementId,
        realtimeSessionId: null,
        providerResponseId: null,
        source: "simulated-visual-test",
        at: now(),
      });
      index += 1;
      simulatedTimer = schedule(tick, input.simulatedVisualDelayMs ?? 40);
    };
    tick();
  }

  return {
    getState: () => state,
    start(nextPacket, options) {
      clearSimulated();
      packet = nextPacket;
      pending = null;
      audioStartedForPending = false;
      const queued = narrationSegmentsFromPacket(nextPacket).map((segment) => segment.id);
      publish(
        createIdleNarrationState({
          presentationRunId: nextPacket.presentationRunId,
          realtimeSessionId: options.realtimeSessionId ?? null,
          queuedSegmentIds: queued,
          needsVoiceToHearBriefing: !options.voiceConnected,
          source:
            options.mode === "simulated-visual-test" ? "simulated-visual-test" : "realtime-audio",
        }),
      );
      if (options.mode === "simulated-visual-test") {
        startSimulatedVisual(nextPacket);
        return state;
      }
      if (
        !canStartLiveNarration({
          voiceConnected: options.voiceConnected,
          speakResponses: options.speakResponses,
          packetReady: nextPacket.narrationSegments.length > 0,
        })
      ) {
        return publish({
          ...state,
          needsVoiceToHearBriefing:
            !options.voiceConnected && nextPacket.narrationSegments.length > 0,
        });
      }
      requestNext(options.realtimeSessionId ?? null);
      return state;
    },
    handleRealtimeEvent(event) {
      if (!packet || !pending) {
        if (event.type === "input_audio_buffer.speech_started" && state.narrationActive) {
          return this.interrupt("vad");
        }
        return state;
      }
      if (event.type === "input_audio_buffer.speech_started" && state.narrationActive) {
        return this.interrupt("vad");
      }
      const mapped = mapRealtimeServerEventToLifecycle({
        type: event.type,
        presentationRunId: packet.presentationRunId,
        narrationSegmentId: pending.narrationSegmentId,
        visualElementId: pending.visualElementId,
        realtimeSessionId: event.sessionId ?? state.realtimeSessionId,
        providerResponseId: event.providerResponseId ?? pending.providerResponseId,
        now: now(),
      });
      if (!mapped) return state;
      if (mapped.type === "narration.output_active") {
        if (!audioStartedForPending) {
          audioStartedForPending = true;
          emit({
            ...mapped,
            type: "narration.started",
          });
          emit({
            ...mapped,
            type: "narration.segment_started",
          });
        }
        return emit(mapped);
      }
      if (mapped.type === "narration.segment_completed") {
        const completedId = pending.narrationSegmentId;
        pending = null;
        audioStartedForPending = false;
        emit(mapped);
        if (completedId) requestNext(event.sessionId ?? state.realtimeSessionId);
        return state;
      }
      return emit(mapped);
    },
    interrupt(reason = "typed") {
      if (interrupting) return state;
      interrupting = true;
      clearSimulated();
      pending = null;
      audioStartedForPending = false;
      if (
        reason === "typed" ||
        reason === "push-to-talk" ||
        reason === "vad" ||
        reason === "stop" ||
        reason === "pause"
      ) {
        input.adapter?.interrupt();
        input.adapter?.clearPendingOutput();
      }
      try {
        if (!packet) {
          return publish({ ...IDLE_NARRATION_STATE });
        }
        return emit({
          type: reason === "stop" ? "narration.stopped" : "narration.interrupted",
          presentationRunId: packet.presentationRunId,
          narrationSegmentId: state.activeSegmentId,
          visualElementId: state.activeVisualElementId,
          realtimeSessionId: state.realtimeSessionId,
          providerResponseId: state.providerResponseId,
          source: state.source ?? "realtime-audio",
          at: now(),
        });
      } finally {
        interrupting = false;
      }
    },
    stop() {
      return this.disconnect();
    },
    pause() {
      return this.interrupt("pause");
    },
    disconnect() {
      clearSimulated();
      pending = null;
      audioStartedForPending = false;
      if (!packet) return publish(IDLE_NARRATION_STATE);
      return emit({
        type: "narration.stopped",
        presentationRunId: packet.presentationRunId,
        narrationSegmentId: state.activeSegmentId,
        visualElementId: state.activeVisualElementId,
        realtimeSessionId: state.realtimeSessionId,
        providerResponseId: state.providerResponseId,
        source: state.source ?? "realtime-audio",
        at: now(),
      });
    },
    currentVisualElementId: () => state.activeVisualElementId,
  };
}

export { narrationAuditMetadata } from "@bea/ai/presentation";
