import { describe, expect, it, vi } from "vitest";

import {
  applyNarrationLifecycleEvent,
  canStartLiveNarration,
  createIdleNarrationState,
  IDLE_NARRATION_STATE,
} from "../../packages/ai/src/narration-lifecycle.js";
import { createPresentationNarrationController } from "../../apps/web/lib/presentation-narration-controller.js";
import {
  attachProgrammaticScroll,
  isProgrammaticScrollActive,
} from "../../apps/web/lib/programmatic-scroll.js";
import {
  buildResearchPresentation,
  createSimulatedResearchResult,
} from "../../packages/ai/src/index.js";
import {
  createBrowserRealtimeVoiceAdapter,
  type BrowserRealtimeVoiceAdapter,
} from "../../apps/web/lib/browser-realtime-voice.js";
import { PHASE21_LIMITS } from "../../packages/ai/src/presentation.js";

const PRESENTATION_RUN_ID = "b1000000-0000-4000-8000-000000000021";

function researchPacket() {
  return buildResearchPresentation({
    presentationRunId: PRESENTATION_RUN_ID,
    conversationId: "10000000-0000-4000-8000-000000000010",
    actingUserId: "10000000-0000-4000-8000-000000000001",
    query: "Research the latest information relevant to water penetration testing",
    result: createSimulatedResearchResult("water penetration"),
    provider: "demo",
    requiredPermissions: ["ai-command.view", "search.view"],
  });
}

function fakeAdapter() {
  const sent: unknown[] = [];
  const interrupts: string[] = [];
  const adapter = {
    sent,
    interrupts,
    requestNarrationSegment(input: unknown) {
      sent.push(input);
      return true;
    },
    interrupt() {
      interrupts.push("interrupt");
      return {} as never;
    },
    clearPendingOutput() {
      interrupts.push("clear");
      return {} as never;
    },
    getSnapshot() {
      return { state: "listening", sessionId: "session-1" } as never;
    },
  };
  return adapter as typeof adapter &
    Pick<
      BrowserRealtimeVoiceAdapter,
      "requestNarrationSegment" | "interrupt" | "clearPendingOutput" | "getSnapshot"
    >;
}

describe("Phase 2.1 audio-locked narration controller", () => {
  it("does not mark narration active for a typed request without connected voice", () => {
    const states: string[] = [];
    const controller = createPresentationNarrationController({
      onState: (state) => states.push(`${state.status}:${String(state.narrationActive)}`),
    });
    const next = controller.start(researchPacket(), {
      voiceConnected: false,
      speakResponses: true,
      mode: "test",
    });
    expect(next.narrationActive).toBe(false);
    expect(next.needsVoiceToHearBriefing).toBe(true);
    expect(
      canStartLiveNarration({ voiceConnected: false, speakResponses: true, packetReady: true }),
    ).toBe(false);
  });

  it("does not mark narration active merely because speakResponses is true", () => {
    const controller = createPresentationNarrationController({
      onState: () => undefined,
    });
    const next = controller.start(researchPacket(), {
      voiceConnected: false,
      speakResponses: true,
      mode: "live",
    });
    expect(next.narrationActive).toBe(false);
    expect(next.status).toBe("idle");
  });

  it("requests packet narration and activates the visual only after actual audio starts", () => {
    const adapter = fakeAdapter();
    const visuals: Array<string | null> = [];
    const controller = createPresentationNarrationController({
      adapter,
      onState: (state) => visuals.push(state.activeVisualElementId),
    });
    const packet = researchPacket();
    controller.start(packet, {
      voiceConnected: true,
      speakResponses: true,
      realtimeSessionId: "session-1",
      mode: "live",
    });
    expect(adapter.sent).toHaveLength(1);
    expect(controller.getState().narrationActive).toBe(false);
    const first = packet.narrationSegments[0]!;
    controller.handleRealtimeEvent({
      type: "response.output_audio.delta",
      providerResponseId: "resp-1",
    });
    expect(controller.getState().narrationActive).toBe(true);
    expect(controller.getState().activeSegmentId).toBe(first.id);
    expect(controller.currentVisualElementId()).toBe(first.visualElementId);
    controller.handleRealtimeEvent({
      type: "response.output_audio.done",
      providerResponseId: "resp-1",
    });
    expect(controller.getState().completedSegmentIds).toContain(first.id);
    expect(adapter.sent).toHaveLength(2);
    expect(JSON.stringify(adapter.sent[0])).toContain(PRESENTATION_RUN_ID);
    expect(JSON.stringify(adapter.sent[0])).toContain(first.id);
    controller.handleRealtimeEvent({ type: "response.output_audio.delta" });
    expect(controller.getState().completedSegmentIds).toContain(first.id);
    expect(controller.getState().narrationActive).toBe(true);
  });

  it("advances only after actual completion and cancels on interruption", () => {
    const adapter = fakeAdapter();
    const controller = createPresentationNarrationController({
      adapter,
      onState: () => undefined,
    });
    const packet = researchPacket();
    controller.start(packet, { voiceConnected: true, speakResponses: true, mode: "live" });
    controller.handleRealtimeEvent({ type: "response.output_audio.delta" });
    controller.interrupt("typed");
    expect(adapter.interrupts).toEqual(["interrupt", "clear"]);
    expect(controller.getState().status).toBe("interrupted");
    expect(controller.getState().narrationActive).toBe(false);
    expect(controller.getState().queuedSegmentIds).toEqual([]);
    expect(controller.getState().completedSegmentIds).not.toContain(
      packet.narrationSegments[2]?.id,
    );
  });

  it("push-to-talk interrupt cancels the in-progress response and clears pending output", () => {
    const adapter = fakeAdapter();
    const controller = createPresentationNarrationController({
      adapter,
      onState: () => undefined,
    });
    const packet = researchPacket();
    controller.start(packet, { voiceConnected: true, speakResponses: true, mode: "live" });
    controller.handleRealtimeEvent({ type: "response.output_audio.delta" });
    controller.interrupt("push-to-talk");
    expect(adapter.interrupts).toEqual(["interrupt", "clear"]);
    expect(controller.getState().status).toBe("interrupted");
    expect(controller.getState().narrationActive).toBe(false);
    expect(controller.getState().queuedSegmentIds).toEqual([]);
  });

  it("does not use character-count timers as live truth", () => {
    const adapter = fakeAdapter();
    const controller = createPresentationNarrationController({
      adapter,
      onState: () => undefined,
      simulatedVisualDelayMs: 1,
    });
    const packet = researchPacket();
    controller.start(packet, { voiceConnected: true, speakResponses: true, mode: "live" });
    expect(controller.getState().activeVisualElementId).toBeNull();
    expect(controller.getState().source).toBe("realtime-audio");
  });

  it("starts BrowserRealtimeVoiceAdapter event-contract-only TEST MODE without microphone capture", async () => {
    const getUserMedia = vi.fn(async () => {
      throw new Error("microphone must not be requested");
    });
    const events: string[] = [];
    const timeouts = new Map<number, () => void>();
    let nextHandle = 1;
    const adapter = createBrowserRealtimeVoiceAdapter({
      eventContractOnly: true,
      environment: {
        authorizeTestSession: async () => ({
          requested: true,
          authorizedUntil: Date.now() + 60_000,
        }),
        getUserMedia,
        requestAnimationFrame: (callback) => {
          callback(0);
          return 1;
        },
        cancelAnimationFrame: () => undefined,
        setTimeout: (callback) => {
          const handle = nextHandle;
          nextHandle += 1;
          timeouts.set(handle, callback);
          return handle;
        },
        clearTimeout: (handle) => {
          timeouts.delete(handle);
        },
      },
      onRealtimeEvent: (event) => events.push(event.type),
      testAudioStartDelayMs: 0,
      testAudioCompleteDelayMs: 0,
    });
    const started = await adapter.start();
    expect(started.state).toBe("listening");
    expect(started.microphoneActive).toBe(false);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(
      adapter.requestNarrationSegment({
        presentationRunId: PRESENTATION_RUN_ID,
        narrationSegmentId: "seg-1",
        visualElementId: "finding-1",
        spokenText: "Approved packet narration",
        instructions: "Speak the approved segment.",
      }),
    ).toBe(true);
    for (const callback of [...timeouts.values()]) callback();
    expect(events).toEqual(
      expect.arrayContaining([
        "response.created",
        "response.output_audio.delta",
        "response.output_audio.done",
        "response.done",
      ]),
    );
    await adapter.dispose();
  });

  it("does not revive an event-contract TEST MODE session after Stop Voice", async () => {
    const timeouts = new Map<number, () => void>();
    let nextHandle = 1;
    const adapter = createBrowserRealtimeVoiceAdapter({
      eventContractOnly: true,
      environment: {
        authorizeTestSession: async () => ({
          requested: true,
          authorizedUntil: Date.now() + 60_000,
        }),
        requestAnimationFrame: (callback) => {
          callback(0);
          return 1;
        },
        cancelAnimationFrame: () => undefined,
        setTimeout: (callback) => {
          const handle = nextHandle;
          nextHandle += 1;
          timeouts.set(handle, callback);
          return handle;
        },
        clearTimeout: (handle) => {
          timeouts.delete(handle);
        },
      },
      testAudioStartDelayMs: 0,
      testAudioCompleteDelayMs: 0,
    });
    await adapter.start();
    expect(adapter.interrupt().state).toBe("interrupted");
    const stopped = await adapter.stop("user-cancelled");
    expect(stopped.state).toBe("idle");
    expect(adapter.interrupt().state).toBe("idle");
    expect(adapter.getSnapshot().state).toBe("idle");
    await adapter.dispose();
  });

  it("maps speech_started while speaking to a real interruption", () => {
    const adapter = fakeAdapter();
    const controller = createPresentationNarrationController({
      adapter,
      onState: () => undefined,
    });
    controller.start(researchPacket(), {
      voiceConnected: true,
      speakResponses: true,
      mode: "live",
    });
    controller.handleRealtimeEvent({ type: "response.output_audio.delta" });
    controller.handleRealtimeEvent({ type: "input_audio_buffer.speech_started" });
    expect(controller.getState().status).toBe("interrupted");
    expect(adapter.interrupts.length).toBeGreaterThan(0);
  });

  it("keeps completed segments when applying lifecycle events without fabricating later ones", () => {
    const started = applyNarrationLifecycleEvent(
      createIdleNarrationState({
        presentationRunId: PRESENTATION_RUN_ID,
        queuedSegmentIds: ["a", "b"],
        source: "realtime-audio",
      }),
      {
        type: "narration.segment_started",
        presentationRunId: PRESENTATION_RUN_ID,
        narrationSegmentId: "a",
        visualElementId: "summary",
        realtimeSessionId: "s",
        providerResponseId: "r",
        source: "realtime-audio",
        at: "2026-08-29T00:00:00.000Z",
      },
    );
    const completed = applyNarrationLifecycleEvent(started, {
      type: "narration.segment_completed",
      presentationRunId: PRESENTATION_RUN_ID,
      narrationSegmentId: "a",
      visualElementId: "summary",
      realtimeSessionId: "s",
      providerResponseId: "r",
      source: "realtime-audio",
      at: "2026-08-29T00:00:01.000Z",
    });
    expect(completed.completedSegmentIds).toEqual(["a"]);
    expect(completed.queuedSegmentIds).toEqual(["b"]);
    expect(IDLE_NARRATION_STATE.narrationActive).toBe(false);
    expect(PHASE21_LIMITS.realtimeSessionMaxAgeMs).toBe(15 * 60_000);
  });

  it("pause cancels actual adapter output instead of a character timer", () => {
    const adapter = fakeAdapter();
    const controller = createPresentationNarrationController({
      adapter,
      onState: () => undefined,
    });
    controller.start(researchPacket(), {
      voiceConnected: true,
      speakResponses: true,
      mode: "live",
    });
    controller.handleRealtimeEvent({ type: "response.output_audio.delta" });
    controller.pause();
    expect(adapter.interrupts).toEqual(["interrupt", "clear"]);
    expect(controller.getState().narrationActive).toBe(false);
  });

  it("stop clears the narration queue without interrupting the adapter", () => {
    const adapter = fakeAdapter();
    const controller = createPresentationNarrationController({
      adapter,
      onState: () => undefined,
    });
    controller.start(researchPacket(), {
      voiceConnected: true,
      speakResponses: true,
      mode: "live",
    });
    controller.handleRealtimeEvent({ type: "response.output_audio.delta" });
    adapter.interrupts.length = 0;
    controller.stop();
    expect(adapter.interrupts).toEqual([]);
    expect(controller.getState().status).toBe("stopped");
    expect(controller.getState().narrationActive).toBe(false);
  });

  it("keeps the programmatic-scroll token until settle, not the next animation frame", () => {
    const timers: Array<{ id: number; cb: () => void }> = [];
    let nextId = 1;
    const target = new EventTarget();
    let settledGeneration: number | null = null;
    const session = attachProgrammaticScroll({
      target,
      generation: 7,
      settleMs: 1_000,
      schedule: (callback) => {
        const id = nextId;
        nextId += 1;
        timers.push({ id, cb: callback });
        return id;
      },
      clearSchedule: (handle) => {
        const index = timers.findIndex((timer) => timer.id === handle);
        if (index >= 0) timers.splice(index, 1);
      },
      onSettle: (generation) => {
        settledGeneration = generation;
      },
    });
    expect(isProgrammaticScrollActive({ token: session.generation, flag: true })).toBe(true);
    expect(settledGeneration).toBeNull();
    target.dispatchEvent(new Event("scrollend"));
    expect(settledGeneration).toBe(7);
    session.cancel();
  });
});
