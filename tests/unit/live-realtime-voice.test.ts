import { describe, expect, it, vi } from "vitest";

import {
  authorizeBrowserVoiceLiveSession,
  createBrowserRealtimeVoiceAdapter,
  createOpenAiRealtimeSignalingBoundary,
  type BrowserVoiceAuthorizationResult,
  type BrowserVoiceEnvironment,
  type BrowserVoiceLiveAuthorization,
  type BrowserVoiceSignalingBoundary,
} from "../../apps/web/lib/browser-realtime-voice.js";

const CONVERSATION_ID = "10000000-0000-4000-8000-000000000010";
const SESSION_ID = "20000000-0000-4000-8000-000000000020";
const CLIENT_SECRET = "ek_realtime_ephemeral_test_1234567890";

function liveAuthorization(
  overrides: Partial<BrowserVoiceLiveAuthorization> = {},
): BrowserVoiceLiveAuthorization {
  return {
    clientSecret: CLIENT_SECRET,
    expiresAt: Date.now() + 60_000,
    providerSessionId: "sess_realtime_test",
    beaSessionId: SESSION_ID,
    model: "gpt-realtime-test",
    voice: "coral",
    webrtcEndpoint: "https://api.openai.com/v1/realtime/calls",
    interactionMode: "automatic",
    allowInterruption: true,
    ...overrides,
  };
}

class FakeTrack extends EventTarget {
  readonly kind = "audio";
  readyState: MediaStreamTrackState = "live";
  enabled = true;

  stop() {
    this.readyState = "ended";
  }

  end() {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}

class FakeStream {
  constructor(readonly tracks: FakeTrack[]) {}

  getTracks() {
    return this.tracks;
  }

  getAudioTracks() {
    return this.tracks;
  }
}

class FakeSender {
  replaceCalls = 0;

  replaceTrack() {
    this.replaceCalls += 1;
    return Promise.resolve();
  }
}

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = "open";
  readonly sent: string[] = [];

  send(value: string) {
    this.sent.push(value);
  }

  message(value: Record<string, unknown>) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }

  close() {
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}

class FakePeerConnection extends EventTarget {
  connectionState: RTCPeerConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "complete";
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  readonly sender = new FakeSender();
  readonly addedTracks: MediaStreamTrack[] = [];
  readonly channels: FakeDataChannel[] = [];

  addTrack(track: MediaStreamTrack) {
    this.addedTracks.push(track);
    return this.sender as unknown as RTCRtpSender;
  }

  getSenders() {
    return [this.sender as unknown as RTCRtpSender];
  }

  createDataChannel() {
    const channel = new FakeDataChannel();
    this.channels.push(channel);
    return channel as unknown as RTCDataChannel;
  }

  createOffer() {
    return Promise.resolve({ type: "offer" as const, sdp: "v=0\r\no=bea-offer" });
  }

  setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description;
    return Promise.resolve();
  }

  setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description;
    return Promise.resolve();
  }

  connect() {
    this.connectionState = "connected";
    this.dispatchEvent(new Event("connectionstatechange"));
  }

  close() {
    this.connectionState = "closed";
    this.dispatchEvent(new Event("connectionstatechange"));
  }
}

class FakeAudioElement {
  autoplay = false;
  muted = false;
  hidden = false;
  srcObject: MediaStream | null = null;
  readonly dataset: Record<string, string> = {};
  paused = false;
  removed = false;

  setAttribute() {}
  removeAttribute() {}
  load() {}
  play() {
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  remove() {
    this.removed = true;
  }
}

interface LiveHarnessOptions {
  readonly interactionMode?: "automatic" | "push_to_talk";
  readonly allowInterruption?: boolean;
  readonly getUserMedia?: BrowserVoiceEnvironment["getUserMedia"];
}

function liveHarness(options: LiveHarnessOptions = {}) {
  const peers: FakePeerConnection[] = [];
  const channels: FakeDataChannel[] = [];
  const localTracks: FakeTrack[] = [];
  const remoteTracks: FakeTrack[] = [];
  const audioElements: FakeAudioElement[] = [];
  const requests: Array<{ endpoint: string; body: Record<string, unknown>; keepalive: boolean }> =
    [];
  const workspaceUpdated = vi.fn();
  const timeouts = new Map<number, () => void>();
  let nextTimer = 1;
  const authorization = liveAuthorization({
    interactionMode: options.interactionMode ?? "automatic",
    allowInterruption: options.allowInterruption ?? true,
  });
  const environment: BrowserVoiceEnvironment = {
    authorizeTestSession: () => Promise.reject(new Error("Demo authorization must not run.")),
    authorizeLiveSession: () =>
      Promise.resolve({
        requested: true,
        authorizedUntil: authorization.expiresAt,
        liveAuthorization: authorization,
      }),
    getUserMedia:
      options.getUserMedia ??
      (() => {
        const track = new FakeTrack();
        localTracks.push(track);
        return Promise.resolve(new FakeStream([track]) as unknown as MediaStream);
      }),
    createPeerConnection: () => {
      const peer = new FakePeerConnection();
      peers.push(peer);
      return peer as unknown as RTCPeerConnection;
    },
    createMediaStream: (tracks = []) =>
      new FakeStream([...tracks] as unknown as FakeTrack[]) as unknown as MediaStream,
    createAudioElement: () => {
      const audio = new FakeAudioElement();
      audioElements.push(audio);
      return audio as unknown as HTMLAudioElement;
    },
    appendAudioElement: vi.fn(),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: vi.fn(),
    setTimeout: (callback) => {
      const handle = nextTimer++;
      timeouts.set(handle, callback);
      return handle;
    },
    clearTimeout: (handle) => void timeouts.delete(handle),
    pageLifecycleTarget: new EventTarget(),
  };
  const signalingBoundary: BrowserVoiceSignalingBoundary = {
    mode: "openai-direct-webrtc",
    async negotiate(context) {
      const channel = new FakeDataChannel();
      channels.push(channel);
      context.registerDataChannel(channel as unknown as RTCDataChannel);
      const remoteTrack = new FakeTrack();
      remoteTracks.push(remoteTrack);
      context.registerRemoteStream(new FakeStream([remoteTrack]) as unknown as MediaStream);
      context.recordExternalProviderCall();
      (context.outboundPeerConnection as unknown as FakePeerConnection).connect();
    },
  };
  const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const endpoint = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({ endpoint, body, keepalive: init?.keepalive === true });
    if (endpoint.endsWith("/tools/execute")) {
      return new Response(
        JSON.stringify({
          callId: body.callId,
          output: {
            summary: "Verified live search result.",
            workspace: { type: "sources", title: "Sources" },
            sources: [{ title: "Official guidance", url: "https://example.com/guidance" }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const adapter = createBrowserRealtimeVoiceAdapter({
    mode: "live",
    conversationId: CONVERSATION_ID,
    environment,
    signalingBoundary,
    request: request as unknown as typeof fetch,
    onWorkspaceUpdated: workspaceUpdated,
    connectionTimeoutMs: 25,
  });
  return {
    adapter,
    audioElements,
    channels,
    localTracks,
    peers,
    remoteTracks,
    request,
    requests,
    timeouts,
    workspaceUpdated,
  };
}

describe("live browser Realtime authorization and signaling", () => {
  it("accepts only the bounded OpenAI ephemeral-session contract", async () => {
    const now = Date.parse("2026-08-21T12:00:00.000Z");
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ conversationId: CONVERSATION_ID });
      return new Response(
        JSON.stringify({
          authorization: {
            provider: "openai",
            clientSecret: CLIENT_SECRET,
            expiresAt: new Date(now + 60_000).toISOString(),
            sessionId: "sess_realtime_test",
            beaSessionId: SESSION_ID,
            model: "gpt-realtime-test",
            voice: "coral",
            simulated: false,
            webrtcEndpoint: "https://api.openai.com/v1/realtime/calls",
            interactionMode: "automatic",
            allowInterruption: true,
            speakResponses: true,
          },
        }),
        { status: 200 },
      );
    });

    await expect(
      authorizeBrowserVoiceLiveSession(
        CONVERSATION_ID,
        new AbortController().signal,
        request as unknown as typeof fetch,
        () => now,
      ),
    ).resolves.toEqual({
      clientSecret: CLIENT_SECRET,
      expiresAt: now + 60_000,
      providerSessionId: "sess_realtime_test",
      beaSessionId: SESSION_ID,
      model: "gpt-realtime-test",
      voice: "coral",
      webrtcEndpoint: "https://api.openai.com/v1/realtime/calls",
      interactionMode: "automatic",
      allowInterruption: true,
    });
    expect(request).toHaveBeenCalledWith(
      "/api/ai-command/realtime/client-secret",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejects overbroad, expired, and conversation-invalid authorization responses", async () => {
    const now = Date.parse("2026-08-21T12:00:00.000Z");
    const response = {
      authorization: {
        provider: "openai",
        clientSecret: CLIENT_SECRET,
        expiresAt: new Date(now - 1).toISOString(),
        beaSessionId: SESSION_ID,
        model: "gpt-realtime-test",
        voice: "coral",
        simulated: false,
        webrtcEndpoint: "https://api.openai.com/v1/realtime/calls",
        interactionMode: "automatic",
        allowInterruption: true,
        standardApiKey: "must-never-be-accepted",
      },
    };
    const request = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));

    await expect(
      authorizeBrowserVoiceLiveSession(
        CONVERSATION_ID,
        new AbortController().signal,
        request as unknown as typeof fetch,
        () => now,
      ),
    ).rejects.toMatchObject({ name: "BrowserVoiceLiveAuthorizationError" });
    const standardKeyRequest = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            authorization: {
              ...response.authorization,
              expiresAt: new Date(now + 60_000).toISOString(),
              clientSecret: "standard-api-key-sentinel-must-never-reach-browser",
              standardApiKey: undefined,
            },
          }),
          { status: 200 },
        ),
    );
    await expect(
      authorizeBrowserVoiceLiveSession(
        CONVERSATION_ID,
        new AbortController().signal,
        standardKeyRequest as unknown as typeof fetch,
        () => now,
      ),
    ).rejects.toMatchObject({ name: "BrowserVoiceLiveAuthorizationError" });
    const invalidSpokenResponseRequest = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            authorization: {
              ...response.authorization,
              expiresAt: new Date(now + 60_000).toISOString(),
              standardApiKey: undefined,
              speakResponses: "yes",
            },
          }),
          { status: 200 },
        ),
    );
    await expect(
      authorizeBrowserVoiceLiveSession(
        CONVERSATION_ID,
        new AbortController().signal,
        invalidSpokenResponseRequest as unknown as typeof fetch,
        () => now,
      ),
    ).rejects.toMatchObject({ name: "BrowserVoiceLiveAuthorizationError" });
    await expect(
      authorizeBrowserVoiceLiveSession(
        "not-a-conversation-id",
        new AbortController().signal,
        request as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ name: "BrowserVoiceLiveAuthorizationError" });
  });

  it("posts SDP only to the exact OpenAI endpoint with the ephemeral credential", async () => {
    const peer = new FakePeerConnection();
    const channelRegistration = vi.fn();
    const externalProviderCall = vi.fn();
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.openai.com/v1/realtime/calls");
      expect(init?.headers).toEqual({
        Authorization: `Bearer ${CLIENT_SECRET}`,
        "Content-Type": "application/sdp",
      });
      expect(init?.body).toBe("v=0\r\no=bea-offer");
      expect(init?.redirect).toBe("error");
      expect(JSON.stringify(init)).not.toContain("sk-");
      return new Response("v=0\r\no=openai-answer", { status: 200 });
    });
    const authorization: BrowserVoiceAuthorizationResult = {
      requested: true,
      authorizedUntil: Date.now() + 60_000,
      liveAuthorization: liveAuthorization(),
    };

    await createOpenAiRealtimeSignalingBoundary(request as unknown as typeof fetch).negotiate({
      outboundPeerConnection: peer as unknown as RTCPeerConnection,
      localStream: new FakeStream([new FakeTrack()]) as unknown as MediaStream,
      signal: new AbortController().signal,
      authorization,
      createPeerConnection: () => peer as unknown as RTCPeerConnection,
      createMediaStream: (tracks = []) =>
        new FakeStream([...tracks] as unknown as FakeTrack[]) as unknown as MediaStream,
      registerPeerConnection: vi.fn(),
      registerRemoteStream: vi.fn(),
      registerDataChannel: channelRegistration,
      recordExternalProviderCall: externalProviderCall,
      listen(target, type, listener) {
        target.addEventListener(type, listener);
        return () => target.removeEventListener(type, listener);
      },
      waitForIceGathering: () => Promise.resolve(),
    });

    expect(channelRegistration).toHaveBeenCalledTimes(1);
    expect(externalProviderCall).toHaveBeenCalledTimes(1);
    expect(peer.remoteDescription).toEqual({ type: "answer", sdp: "v=0\r\no=openai-answer" });
  });
});

describe("live browser Realtime lifecycle", () => {
  it("persists transcripts and usage, executes allowlisted search, interrupts, and cleans up", async () => {
    const test = liveHarness();
    const started = await test.adapter.start();

    expect(started).toMatchObject({
      state: "listening",
      signalingMode: "openai-direct-webrtc",
      providerConnected: true,
      microphoneActive: true,
      audioElementState: "attached",
      standardApiKeyExposed: false,
      realtimeCredentialRetained: false,
      rawAudioPersisted: false,
      externalProviderCalls: 1,
      sessionId: SESSION_ID,
    });
    expect(test.peers[0]?.addedTracks).toHaveLength(1);
    expect(test.audioElements[0]).toMatchObject({ muted: false, autoplay: true });
    expect(test.requests.some(({ body }) => body.type === "connected")).toBe(true);

    const channel = test.channels[0]!;
    channel.message({ type: "input_audio_buffer.speech_started" });
    expect(test.adapter.getSnapshot().state).toBe("user-speaking");
    channel.message({ type: "response.output_audio.delta", delta: "bounded-audio-delta" });
    expect(test.adapter.getSnapshot().state).toBe("assistant-speaking");
    expect(test.adapter.interrupt().state).toBe("interrupted");
    expect(channel.sent.map((value) => JSON.parse(value))).toContainEqual({
      type: "response.cancel",
    });

    channel.message({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_user_1",
      transcript: "Search the web for current envelope guidance.",
    });
    channel.message({
      type: "response.output_audio_transcript.done",
      item_id: "item_assistant_1",
      transcript: "I will verify that guidance.",
    });
    await vi.waitFor(() => {
      expect(test.adapter.getSnapshot().transcript).toContain(
        "You: Search the web for current envelope guidance.",
      );
      expect(test.adapter.getSnapshot().transcript).toContain("BEA: I will verify that guidance.");
      expect(test.requests.filter(({ body }) => body.type === "transcript")).toHaveLength(2);
    });

    channel.message({
      type: "response.function_call_arguments.done",
      name: "search_web",
      call_id: "call_search_1",
      arguments: JSON.stringify({ query: "current envelope guidance" }),
    });
    await vi.waitFor(() => expect(test.adapter.getSnapshot().toolCallsCompleted).toBe(1));
    expect(
      test.requests.some(
        ({ endpoint, body }) => endpoint.endsWith("/tools/execute") && body.name === "search_web",
      ),
    ).toBe(true);
    expect(channel.sent.map((value) => JSON.parse(value))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "conversation.item.create",
          item: expect.objectContaining({ type: "function_call_output", call_id: "call_search_1" }),
        }),
        { type: "response.create" },
      ]),
    );
    expect(test.workspaceUpdated).toHaveBeenCalled();

    channel.message({
      type: "response.done",
      response: {
        id: "resp_realtime_1",
        output: [],
        usage: {
          input_tokens: 12,
          output_tokens: 7,
          input_token_details: { cached_tokens: 2, audio_tokens: 5 },
          output_token_details: { reasoning_tokens: 1, audio_tokens: 4 },
        },
      },
    });
    await vi.waitFor(() =>
      expect(test.requests.some(({ body }) => body.type === "usage")).toBe(true),
    );
    const usage = test.requests.find(({ body }) => body.type === "usage")?.body.usage;
    expect(usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 7,
      cachedInputTokens: 2,
      reasoningTokens: 1,
      audioInputTokens: 5,
      audioOutputTokens: 4,
    });

    expect(test.adapter.setMuted(true).state).toBe("muted");
    expect(test.localTracks[0]?.enabled).toBe(false);
    expect(test.adapter.setMuted(false).state).toBe("listening");
    expect(test.localTracks[0]?.enabled).toBe(true);

    const stopped = await test.adapter.stop();
    await vi.waitFor(() =>
      expect(
        test.requests.some(({ body, keepalive }) => body.type === "completed" && keepalive),
      ).toBe(true),
    );
    expect(stopped).toMatchObject({
      state: "disconnected",
      providerConnected: false,
      microphoneActive: false,
      allTracksEnded: true,
      allPeerConnectionsClosed: true,
      audioElementState: "released",
      audioReferencesReleased: true,
      activeListenerCount: 0,
      activeTimerCount: 0,
      activeAnimationFrameCount: 0,
      cleanupComplete: true,
    });
    expect(test.localTracks[0]?.readyState).toBe("ended");
    expect(test.remoteTracks[0]?.readyState).toBe("ended");
    expect(test.peers[0]?.connectionState).toBe("closed");
    expect(channel.readyState).toBe("closed");
    expect(test.audioElements[0]).toMatchObject({ paused: true, removed: true, srcObject: null });
  });

  it("persists text-only assistant output when spoken responses are disabled", async () => {
    const test = liveHarness();
    await test.adapter.start();
    const channel = test.channels[0];
    expect(channel).toBeDefined();

    channel?.message({ type: "response.output_text.delta", delta: "Text-only response" });
    expect(test.adapter.getSnapshot().transcript).toContain("BEA: Text-only response");
    channel?.message({
      type: "response.output_text.done",
      item_id: "item_assistant_text_1",
      text: "Text-only response completed.",
    });
    await vi.waitFor(() =>
      expect(
        test.requests.some(
          ({ body }) =>
            body.type === "transcript" &&
            body.role === "assistant" &&
            body.itemId === "item_assistant_text_1" &&
            body.text === "Text-only response completed.",
        ),
      ).toBe(true),
    );

    channel?.message({
      type: "response.done",
      response: {
        id: "resp_realtime_text_2",
        output: [
          {
            id: "item_assistant_text_2",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Fallback completed text." }],
          },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(
        test.requests.some(
          ({ body }) =>
            body.type === "transcript" &&
            body.itemId === "item_assistant_text_2" &&
            body.text === "Fallback completed text.",
        ),
      ).toBe(true),
    );

    await test.adapter.stop();
  });

  it("supports push-to-talk and reconnects without retaining prior media", async () => {
    const test = liveHarness({ interactionMode: "push_to_talk" });
    const first = await test.adapter.start();
    expect(first).toMatchObject({ state: "muted", interactionMode: "push_to_talk", muted: true });
    expect(test.localTracks[0]?.enabled).toBe(false);

    expect(test.adapter.beginPushToTalk().state).toBe("user-speaking");
    expect(test.localTracks[0]?.enabled).toBe(true);
    expect(test.adapter.endPushToTalk().state).toBe("processing");
    expect(test.localTracks[0]?.enabled).toBe(false);
    expect(test.channels[0]?.sent.map((value) => JSON.parse(value))).toEqual(
      expect.arrayContaining([
        { type: "response.cancel" },
        { type: "input_audio_buffer.commit" },
        { type: "response.create" },
      ]),
    );

    const reconnected = await test.adapter.reconnect();
    expect(reconnected).toMatchObject({
      state: "muted",
      providerConnected: true,
      cyclesStarted: 2,
      cyclesCompleted: 1,
    });
    expect(test.localTracks).toHaveLength(2);
    expect(test.localTracks[0]?.readyState).toBe("ended");
    expect(test.peers[0]?.connectionState).toBe("closed");
    expect(test.channels[0]?.readyState).toBe("closed");

    const disposed = test.adapter.dispose();
    await disposed;
    expect(test.adapter.getSnapshot()).toMatchObject({
      state: "disconnected",
      cyclesStarted: 2,
      cyclesCompleted: 2,
      microphoneActive: false,
      cleanupComplete: true,
    });
  });

  it("fails closed when microphone permission is denied or no audio device is available", async () => {
    const denied = liveHarness({
      getUserMedia: () =>
        Promise.reject(new DOMException("Permission denied by the browser.", "NotAllowedError")),
    });
    await expect(denied.adapter.start()).resolves.toMatchObject({
      state: "error",
      errorCode: "microphone-permission-denied",
      microphoneActive: false,
      cleanupComplete: true,
    });

    const unavailable = liveHarness({
      getUserMedia: () => Promise.reject(new DOMException("No device.", "NotFoundError")),
    });
    await expect(unavailable.adapter.start()).resolves.toMatchObject({
      state: "error",
      errorCode: "microphone-device-unavailable",
      microphoneActive: false,
      cleanupComplete: true,
    });
  });
});
