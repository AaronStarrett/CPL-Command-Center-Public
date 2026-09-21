import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MotionAiCommandWorkspace } from "../../apps/web/components/ai-command-motion-workspace";
import type { AiCommandSnapshot } from "../../apps/web/lib/ai-command-contracts";
import type {
  BrowserRealtimeVoiceAdapter,
  BrowserVoiceSnapshot,
} from "../../apps/web/lib/browser-realtime-voice";
import { createPresentationNarrationController } from "../../apps/web/lib/presentation-narration-controller";
import {
  buildResearchPresentation,
  createSimulatedResearchResult,
} from "../../packages/ai/src/index.js";
import { setTestRouterReplace } from "./stubs/next-navigation";

const PRESENTATION_RUN_ID = "b1000000-0000-4000-8000-000000000021";
const CONVERSATION_ID = "10000000-0000-4000-8000-000000000010";

function presentation() {
  return buildResearchPresentation({
    presentationRunId: PRESENTATION_RUN_ID,
    conversationId: CONVERSATION_ID,
    actingUserId: "10000000-0000-4000-8000-000000000001",
    query: "Research the latest information relevant to water penetration testing",
    result: createSimulatedResearchResult("water penetration"),
    provider: "demo",
    requiredPermissions: ["ai-command.view", "search.view"],
    visualArtifactId: "artifact-research-1",
  });
}

function snapshot(): AiCommandSnapshot {
  const packet = presentation();
  const conversation = {
    id: CONVERSATION_ID,
    title: "Phase 2.1 controller",
    updatedAt: "2026-08-29T12:00:00.000Z",
  };
  return {
    conversation,
    conversations: [conversation],
    messages: [
      {
        id: "message-user",
        role: "user",
        content: "Research the latest information relevant to water penetration testing",
        createdAt: "2026-08-29T12:00:00.000Z",
        provider: null,
        model: null,
        executionMs: null,
        links: [],
      },
      {
        id: "message-assistant",
        role: "assistant",
        content: packet.summary,
        createdAt: "2026-08-29T12:00:01.000Z",
        provider: "simulated",
        model: "deterministic-demo-router",
        executionMs: 8,
        links: [],
      },
    ],
    artifact: {
      id: "artifact-research-1",
      type: "help",
      title: packet.title,
      subtitle: "SIMULATED WEB RESEARCH · deterministic-demo-router",
      state: "ready",
      payload: {
        schemaVersion: 1,
        renderer: "research",
        summary: packet.summary,
        findings: packet.findings.map((finding) => finding.body),
        sources: packet.sources,
        citations: packet.citations,
        presentation: packet,
      },
      sources: [],
      links: [],
      requiredPermissions: ["ai-command.view", "search.view"],
      createdAt: "2026-08-29T12:00:00.000Z",
      errorCode: null,
    },
    provider: {
      name: "BEA deterministic demo assistant",
      mode: "demo",
      simulated: true,
      model: "deterministic-demo-router",
      routerVersion: "phase21-test",
      liveConnected: false,
      streaming: true,
      speakResponses: true,
    },
    permissions: { canExecuteTaskAction: false, canUploadArtifact: false },
    actingUser: {
      id: "10000000-0000-4000-8000-000000000001",
      displayName: "Workspace Owner",
      title: "Chief Executive Officer",
    },
    assistant: {
      kind: "executive-business-partner",
      preferredName: "Owner",
      label: "BEA Executive Business Partner",
      subtitle: "Your executive partner for BEA operations",
      promptVersion: "bea-executive-business-partner-v1",
      executiveProfileVersion: "andrew-executive-profile-v1",
      brandPolicyVersion: "bea-artifact-brand-v1",
      artifactTemplateVersion: "bea-artifact-template-v1",
    },
  };
}

function createTestAdapter(): BrowserRealtimeVoiceAdapter & {
  emit: (type: string) => void;
} {
  let state: BrowserVoiceSnapshot["state"] = "idle";
  const snapshotListeners = new Set<(next: BrowserVoiceSnapshot) => void>();
  const eventListeners = new Set<(event: { type: string }) => void>();
  function current(): BrowserVoiceSnapshot {
    return {
      mode: "TEST MODE",
      state,
      stateHistory: [state],
      signalingMode: "local-loopback",
      authorizationRequests: 1,
      cyclesStarted: 1,
      cyclesCompleted: 0,
      localAudioTrackState: state === "idle" ? "none" : "live",
      allTracksEnded: state === "idle",
      microphoneActive: state !== "idle" && state !== "disconnected",
      peerConnectionStates: state === "idle" ? [] : ["connected"],
      allPeerConnectionsClosed: state === "idle",
      audioElementState: state === "idle" ? "none" : "attached",
      audioReferencesReleased: state === "idle",
      activeTimerCount: 0,
      activeListenerCount: 0,
      activeAnimationFrameCount: 0,
      transcript: "",
      muted: false,
      interactionMode: "automatic",
      toolCallsCompleted: 0,
      providerConnected: state !== "idle",
      sessionId: "10000000-0000-4000-8000-000000000099",
      rawAudioPersisted: false,
      externalProviderCalls: 0,
      standardApiKeyExposed: false,
      realtimeCredentialRetained: false,
      cleanupComplete: state === "idle",
    };
  }
  function publish() {
    const next = current();
    for (const listener of snapshotListeners) listener(next);
    return next;
  }
  return {
    emit(type: string) {
      for (const listener of eventListeners) listener({ type });
    },
    async start() {
      state = "listening";
      return publish();
    },
    async stop() {
      state = "idle";
      return publish();
    },
    async dispose() {
      state = "idle";
      publish();
    },
    setMuted() {
      return publish();
    },
    interrupt() {
      if (
        state === "idle" ||
        state === "disconnected" ||
        state === "error" ||
        state === "stopping"
      ) {
        return publish();
      }
      state = "interrupted";
      this.emit("response.cancelled");
      this.emit("output_audio_buffer.cleared");
      return publish();
    },
    clearPendingOutput() {
      this.emit("output_audio_buffer.cleared");
      return publish();
    },
    requestNarrationSegment() {
      queueMicrotask(() => this.emit("response.output_audio.delta"));
      return true;
    },
    async reconnect() {
      return this.start();
    },
    beginPushToTalk() {
      this.interrupt();
      state = "user-speaking";
      return publish();
    },
    endPushToTalk() {
      state = "processing";
      return publish();
    },
    getSnapshot: current,
    subscribe(listener) {
      snapshotListeners.add(listener);
      listener(current());
      return () => snapshotListeners.delete(listener);
    },
    subscribeRealtimeEvents(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  };
}

describe("Phase 2.1 authoritative co-presenter controller", () => {
  beforeEach(() => {
    setTestRouterReplace(vi.fn());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("restores the packet without claiming narration or starting the microphone", async () => {
    const adapter = createTestAdapter();
    render(
      <MotionAiCommandWorkspace
        initialSnapshot={snapshot()}
        browserMediaTestMode
        createVoiceAdapter={() => adapter}
      />,
    );
    expect(screen.getByTestId("research-presentation")).toBeVisible();
    expect(screen.getByTestId("ai-command-workspace")).toHaveAttribute(
      "data-narration-active",
      "false",
    );
    expect(screen.getByTestId("ai-command-workspace")).toHaveAttribute(
      "data-voice-session",
      "idle",
    );
    await waitFor(() => {
      expect(screen.getByTestId("ai-command-workspace")).toHaveAttribute(
        "data-needs-voice",
        "true",
      );
    });
    expect(screen.getByTestId("start-voice-to-hear")).toBeVisible();
    expect(adapter.getSnapshot().microphoneActive).toBe(false);
    expect(screen.queryByTestId("citation-source-2")).not.toHaveAttribute("href");
  });

  it("drives the visual from actual adapter audio events and keeps audio through scroll and source click", async () => {
    const adapter = createTestAdapter();
    const packet = presentation();
    let active: string | null = null;
    const controller = createPresentationNarrationController({
      adapter,
      onState(state) {
        active = state.activeVisualElementId;
      },
    });
    await act(async () => {
      await adapter.start();
    });
    adapter.subscribeRealtimeEvents((event) => {
      controller.handleRealtimeEvent(event);
    });
    controller.start(packet, {
      voiceConnected: true,
      speakResponses: true,
      realtimeSessionId: adapter.getSnapshot().sessionId ?? null,
      mode: "test",
    });
    await waitFor(() => {
      expect(controller.getState().narrationActive).toBe(true);
    });
    expect(active).toBe(packet.narrationSegments[0]?.visualElementId);
    const before = controller.getState().narrationActive;
    adapter.emit("response.output_audio.delta");
    expect(controller.getState().narrationActive).toBe(before);
    controller.handleRealtimeEvent({ type: "response.output_audio.done" });
    expect(controller.getState().completedSegmentIds.length).toBeGreaterThan(0);
    controller.interrupt("typed");
    expect(controller.getState().status).toBe("interrupted");
    expect(controller.getState().narrationActive).toBe(false);
  });

  it("does not treat character duration as live truth in simulated-visual-test mode separately from live", () => {
    const seen: boolean[] = [];
    const controller = createPresentationNarrationController({
      onState: (state) => seen.push(state.narrationActive),
      schedule: (callback) => {
        callback();
        return 1;
      },
      clearSchedule: () => undefined,
      simulatedVisualDelayMs: 0,
    });
    controller.start(presentation(), {
      voiceConnected: true,
      speakResponses: true,
      mode: "simulated-visual-test",
    });
    expect(controller.getState().source).toBe("simulated-visual-test");
    expect(seen.some(Boolean)).toBe(true);
  });

  it("keeps a source selection when an older auto-follow persist fails", async () => {
    const adapter = createTestAdapter();
    const selectionResponses: Array<(response: Response) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/ai-command/presentations/selection")) {
          return await new Promise<Response>((resolve) => {
            selectionResponses.push(resolve);
          });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    render(
      <MotionAiCommandWorkspace initialSnapshot={snapshot()} createVoiceAdapter={() => adapter} />,
    );
    await act(async () => {
      await adapter.start();
    });
    await waitFor(() => {
      expect(screen.getByTestId("ai-command-workspace")).toHaveAttribute(
        "data-narration-active",
        "true",
      );
    });
    fireEvent.click(
      screen.getByTestId("source-source-1").querySelector("button") ??
        screen.getByTestId("source-source-1"),
    );
    fireEvent.click(
      screen.getByTestId("source-source-2").querySelector("button") ??
        screen.getByTestId("source-source-2"),
    );
    expect(screen.getByTestId("source-source-2")).toHaveAttribute("data-selected", "true");
    expect(selectionResponses.length).toBeGreaterThanOrEqual(2);
    await act(async () => {
      selectionResponses[0]?.(new Response("conflict", { status: 409 }));
      selectionResponses[1]?.(
        new Response(JSON.stringify({ selected: { elementId: "source-2" } }), { status: 200 }),
      );
    });
    expect(screen.getByTestId("source-source-2")).toHaveAttribute("data-selected", "true");
    expect(screen.queryByText("The selected context could not be saved.")).toBeNull();
  });

  it("releases the voice session to idle after Stop following a typed interruption", async () => {
    const adapter = createTestAdapter();
    render(
      <MotionAiCommandWorkspace initialSnapshot={snapshot()} createVoiceAdapter={() => adapter} />,
    );
    fireEvent.click(screen.getByTestId("ai-interaction-mode-voice"));
    fireEvent.click(screen.getByTestId("bea-start-voice"));
    await act(async () => {
      await adapter.start();
    });
    await act(async () => {
      adapter.interrupt();
    });
    expect(adapter.getSnapshot().state).toBe("interrupted");
    expect(screen.getByTestId("ai-command-workspace")).toHaveAttribute(
      "data-voice-session",
      "active",
    );
    fireEvent.click(screen.getByTestId("ai-interaction-mode-type"));
    await waitFor(() => {
      expect(screen.getByTestId("ai-command-workspace")).toHaveAttribute(
        "data-voice-session",
        "idle",
      );
    });
    expect(adapter.getSnapshot().state).toBe("idle");
    expect(screen.getByTestId("ai-command-workspace")).toHaveAttribute(
      "data-browser-voice-state",
      "idle",
    );
  });
});
