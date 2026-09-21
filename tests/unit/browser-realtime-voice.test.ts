import { describe, expect, it, vi } from "vitest";

import {
  authorizeBrowserVoiceTestSession,
  createBrowserRealtimeVoiceAdapter,
  createBrowserVoiceTestAuthorizer,
  type BrowserVoiceEnvironment,
  type BrowserVoiceSignalingBoundary,
} from "../../apps/web/lib/browser-realtime-voice.js";

const CONVERSATION_ID = "10000000-0000-4000-8000-000000000010";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

class FakeTrack extends EventTarget {
  readonly kind = "audio";
  readyState: MediaStreamTrackState = "live";

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

  constructor(readonly replacement?: ReturnType<typeof deferred<void>>) {}

  replaceTrack() {
    this.replaceCalls += 1;
    return this.replacement?.promise ?? Promise.resolve();
  }
}

class FakePeerConnection extends EventTarget {
  connectionState: RTCPeerConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "complete";
  readonly sender: FakeSender;
  readonly addedTracks: FakeTrack[] = [];

  constructor(replacement?: ReturnType<typeof deferred<void>>) {
    super();
    this.sender = new FakeSender(replacement);
  }

  addTrack(track: FakeTrack) {
    this.addedTracks.push(track);
    return this.sender;
  }

  getSenders() {
    return [this.sender];
  }

  connect() {
    this.connectionState = "connected";
    this.dispatchEvent(new Event("connectionstatechange"));
  }

  fail() {
    this.connectionState = "failed";
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

  pause() {
    this.paused = true;
  }

  play() {
    return Promise.resolve();
  }

  remove() {
    this.removed = true;
  }
}

class FakeAnalyser {
  fftSize = 256;
  speaking = true;
  disconnected = false;

  getByteTimeDomainData(samples: Uint8Array) {
    samples.fill(this.speaking ? 180 : 128);
  }

  disconnect() {
    this.disconnected = true;
  }
}

class FakeAudioSource {
  disconnected = false;
  connect() {}
  disconnect() {
    this.disconnected = true;
  }
}

class FakeAudioContext {
  state: AudioContextState = "suspended";
  resumeCalls = 0;
  closeCalls = 0;
  readonly analyser = new FakeAnalyser();
  readonly source = new FakeAudioSource();

  constructor(
    readonly resumeResult?: ReturnType<typeof deferred<void>>,
    readonly closeResult?: ReturnType<typeof deferred<void>>,
  ) {}

  resume() {
    this.resumeCalls += 1;
    if (this.resumeResult) return this.resumeResult.promise;
    this.state = "running";
    return Promise.resolve();
  }

  createMediaStreamSource() {
    return this.source;
  }

  createAnalyser() {
    return this.analyser;
  }

  close() {
    this.closeCalls += 1;
    if (this.closeResult) return this.closeResult.promise;
    this.state = "closed";
    return Promise.resolve();
  }
}

interface HarnessOptions {
  readonly authorize?: BrowserVoiceEnvironment["authorizeTestSession"];
  readonly audioClose?: ReturnType<typeof deferred<void>>;
  readonly audioResume?: ReturnType<typeof deferred<void>>;
  readonly getUserMedia?: BrowserVoiceEnvironment["getUserMedia"];
  readonly senderReplacement?: ReturnType<typeof deferred<void>>;
  readonly signalingBoundary?: BrowserVoiceSignalingBoundary;
}

function harness(options: HarnessOptions = {}) {
  const localTrack = new FakeTrack();
  const remoteTrack = new FakeTrack();
  let activeLocalTrack = localTrack;
  let activeRemoteTrack = remoteTrack;
  const peers: FakePeerConnection[] = [];
  const audio = new FakeAudioElement();
  const audioContext = new FakeAudioContext(options.audioResume, options.audioClose);
  const page = new EventTarget();
  const animationFrames = new Map<number, FrameRequestCallback>();
  const timeouts = new Map<number, () => void>();
  let nextHandle = 1;
  const clearTestAuthorization = vi.fn();
  const environment: BrowserVoiceEnvironment = {
    authorizeTestSession:
      options.authorize ??
      (() => Promise.resolve({ requested: true, authorizedUntil: Date.now() + 60_000 })),
    clearTestAuthorization,
    getUserMedia:
      options.getUserMedia ??
      (() => {
        if (activeLocalTrack.readyState === "ended") activeLocalTrack = new FakeTrack();
        return Promise.resolve(new FakeStream([activeLocalTrack]) as unknown as MediaStream);
      }),
    createPeerConnection: () => {
      const peer = new FakePeerConnection(options.senderReplacement);
      peers.push(peer);
      return peer as unknown as RTCPeerConnection;
    },
    createMediaStream: (tracks = []) =>
      new FakeStream([...tracks] as unknown as FakeTrack[]) as unknown as MediaStream,
    createAudioElement: () => audio as unknown as HTMLAudioElement,
    createAudioContext: () => audioContext as unknown as AudioContext,
    appendAudioElement: vi.fn(),
    requestAnimationFrame: (callback) => {
      const handle = nextHandle++;
      animationFrames.set(handle, callback);
      return handle;
    },
    cancelAnimationFrame: (handle) => void animationFrames.delete(handle),
    setTimeout: (callback) => {
      const handle = nextHandle++;
      timeouts.set(handle, callback);
      return handle;
    },
    clearTimeout: (handle) => void timeouts.delete(handle),
    pageLifecycleTarget: page,
  };
  const signalingBoundary: BrowserVoiceSignalingBoundary =
    options.signalingBoundary ??
    ({
      mode: "local-loopback",
      async negotiate(context) {
        const inbound = environment.createPeerConnection!() as unknown as FakePeerConnection;
        context.registerPeerConnection(inbound as unknown as RTCPeerConnection);
        if (activeRemoteTrack.readyState === "ended") activeRemoteTrack = new FakeTrack();
        context.registerRemoteStream(new FakeStream([activeRemoteTrack]) as unknown as MediaStream);
        (context.outboundPeerConnection as unknown as FakePeerConnection).connect();
        inbound.connect();
      },
    } satisfies BrowserVoiceSignalingBoundary);
  return {
    adapter: createBrowserRealtimeVoiceAdapter({
      environment,
      signalingBoundary,
      connectionTimeoutMs: 25,
    }),
    animationFrames,
    audio,
    audioContext,
    clearTestAuthorization,
    environment,
    localTrack,
    page,
    peers,
    remoteTrack,
    runAnimationFrame() {
      const entry = animationFrames.entries().next().value as
        [number, FrameRequestCallback] | undefined;
      if (!entry) return;
      animationFrames.delete(entry[0]);
      entry[1](0);
    },
    timeouts,
  };
}

function demoAuthorization(expiresAt: string) {
  return {
    authorization: {
      provider: "demo",
      clientSecret: "demo-no-network-12345678-1234-4123-8123-123456789abc",
      expiresAt,
      sessionId: "demo-session-12345678-1234-4123-8123-123456789abc",
      beaSessionId: "20000000-0000-4000-8000-000000000020",
      model: "gpt-realtime-test",
      voice: "alloy-test",
      interactionMode: "automatic",
      allowInterruption: true,
      simulated: true,
      webrtcEndpoint: null,
    },
  };
}

describe("browser Realtime voice adapter", () => {
  it("authorizes before capture, attaches real media through the shared path, analyzes speech, and cleans every resource", async () => {
    const order: string[] = [];
    const test = harness({
      authorize: async () => {
        order.push("authorize");
        return { requested: true, authorizedUntil: Date.now() + 60_000 };
      },
      getUserMedia: async (constraints) => {
        order.push("getUserMedia");
        expect(constraints).toEqual({ audio: true });
        return new FakeStream([test.localTrack]) as unknown as MediaStream;
      },
    });

    const active = await test.adapter.start();
    expect(order).toEqual(["authorize", "getUserMedia"]);
    expect(active.stateHistory).toEqual([
      "idle",
      "authorizing",
      "requesting-permission",
      "connecting",
      "listening",
    ]);
    expect(active).toMatchObject({
      localAudioTrackState: "live",
      microphoneActive: true,
      signalingMode: "local-loopback",
      audioElementState: "attached",
      rawAudioPersisted: false,
      externalProviderCalls: 0,
      standardApiKeyExposed: false,
      realtimeCredentialRetained: false,
    });
    expect(test.peers).toHaveLength(2);
    expect(test.peers[0]?.addedTracks).toEqual([test.localTrack]);
    expect(test.peers.map((peer) => peer.connectionState)).toEqual(["connected", "connected"]);
    expect(test.audioContext.resumeCalls).toBeGreaterThan(0);

    test.runAnimationFrame();
    expect(test.adapter.getSnapshot().state).toBe("user-speaking");
    const stopped = await test.adapter.stop();
    expect(test.localTrack.readyState).toBe("ended");
    expect(test.remoteTrack.readyState).toBe("ended");
    expect(test.peers.map((peer) => peer.connectionState)).toEqual(["closed", "closed"]);
    expect(test.audio).toMatchObject({ paused: true, removed: true, srcObject: null });
    expect(stopped).toMatchObject({
      state: "idle",
      localAudioTrackState: "ended",
      allTracksEnded: true,
      allPeerConnectionsClosed: true,
      audioElementState: "released",
      audioReferencesReleased: true,
      activeTimerCount: 0,
      activeListenerCount: 0,
      activeAnimationFrameCount: 0,
      cleanupComplete: true,
    });
  });

  it("emulates Realtime narration events without microphone capture in event-contract-only TEST MODE", async () => {
    const getUserMedia = vi.fn(async () => {
      throw new Error("microphone must not be requested");
    });
    const events: string[] = [];
    const test = harness({ getUserMedia });
    const adapter = createBrowserRealtimeVoiceAdapter({
      environment: test.environment,
      signalingBoundary: {
        mode: "local-loopback",
        negotiate: async () => {
          throw new Error("WebRTC must not run for event-contract-only TEST MODE.");
        },
      },
      eventContractOnly: true,
      onRealtimeEvent: (event) => events.push(event.type),
      testAudioStartDelayMs: 0,
      testAudioCompleteDelayMs: 0,
    });
    const started = await adapter.start();
    expect(started.state).toBe("listening");
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(started.microphoneActive).toBe(false);
    expect(
      adapter.requestNarrationSegment({
        presentationRunId: "b1000000-0000-4000-8000-000000000021",
        narrationSegmentId: "seg-1",
        visualElementId: "finding-1",
        spokenText: "Hello",
        instructions: "Speak the approved segment.",
      }),
    ).toBe(true);
    for (const callback of [...test.timeouts.values()]) callback();
    expect(events).toEqual(
      expect.arrayContaining([
        "response.created",
        "response.output_audio.delta",
        "response.output_audio.done",
        "response.done",
      ]),
    );
  });

  it("stops tracks and closes peers synchronously before sender detachment settles", async () => {
    const replacement = deferred<void>();
    const test = harness({ senderReplacement: replacement });
    await test.adapter.start();

    const stopping = test.adapter.stop();
    expect(test.localTrack.readyState).toBe("ended");
    expect(test.remoteTrack.readyState).toBe("ended");
    expect(test.peers.map((peer) => peer.connectionState)).toEqual(["closed", "closed"]);
    replacement.resolve();
    await stopping;
  });

  it("resolves stop and dispose even when sender detachment and AudioContext close never settle", async () => {
    const replacement = deferred<void>();
    const audioClose = deferred<void>();
    const test = harness({ senderReplacement: replacement, audioClose });
    await test.adapter.start();

    await test.adapter.stop();
    await test.adapter.dispose();
    expect(test.adapter.getSnapshot()).toMatchObject({
      state: "idle",
      cleanupComplete: true,
      activeListenerCount: 0,
      activeTimerCount: 0,
      activeAnimationFrameCount: 0,
      allTracksEnded: true,
      allPeerConnectionsClosed: true,
    });
  });

  it("wakes a hung AudioContext resume on cancellation and does not strand start", async () => {
    const audioResume = deferred<void>();
    const test = harness({ audioResume });
    const starting = test.adapter.start();
    for (let turn = 0; turn < 12 && test.adapter.getSnapshot().state !== "listening"; turn += 1) {
      await Promise.resolve();
    }
    expect(test.adapter.getSnapshot().state).toBe("listening");
    await test.adapter.stop("user-cancelled");
    await starting;
    expect(test.adapter.getSnapshot()).toMatchObject({
      state: "idle",
      cleanupComplete: true,
      activeListenerCount: 0,
      activeTimerCount: 0,
    });
  });

  it("cancels while authorization is pending without ever requesting microphone access", async () => {
    const authorization = deferred<{ requested: boolean; authorizedUntil: number }>();
    const getUserMedia = vi.fn();
    const test = harness({ authorize: () => authorization.promise, getUserMedia });
    const starting = test.adapter.start();
    expect(test.adapter.getSnapshot().state).toBe("authorizing");
    await test.adapter.stop("user-cancelled");
    authorization.resolve({ requested: true, authorizedUntil: Date.now() + 60_000 });
    await starting;

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(test.adapter.getSnapshot()).toMatchObject({
      state: "idle",
      stopReason: "user-cancelled",
      activeListenerCount: 0,
      activeTimerCount: 0,
    });
  });

  it("handles pagehide during pending authorization and ignores the late completion", async () => {
    const authorization = deferred<{ requested: boolean; authorizedUntil: number }>();
    const getUserMedia = vi.fn();
    const test = harness({ authorize: () => authorization.promise, getUserMedia });
    const starting = test.adapter.start();
    expect(test.adapter.getSnapshot().state).toBe("authorizing");

    test.page.dispatchEvent(new Event("pagehide"));
    expect(test.adapter.getSnapshot()).toMatchObject({
      state: "idle",
      stopReason: "pagehide",
      cleanupComplete: true,
      activeListenerCount: 0,
      activeTimerCount: 0,
      activeAnimationFrameCount: 0,
    });
    authorization.resolve({ requested: true, authorizedUntil: Date.now() + 60_000 });
    await starting;

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(test.clearTestAuthorization).toHaveBeenCalledTimes(1);
    expect(test.adapter.getSnapshot()).toMatchObject({
      state: "idle",
      authorizationRequests: 0,
      allTracksEnded: true,
      allPeerConnectionsClosed: true,
      audioReferencesReleased: true,
      activeListenerCount: 0,
      activeTimerCount: 0,
      activeAnimationFrameCount: 0,
    });
  });

  it("closes late peers and tracks when delayed signaling completes after pagehide", async () => {
    const negotiation = deferred<void>();
    const lateRemoteTrack = new FakeTrack();
    let latePeer: FakePeerConnection | undefined;
    const signalingBoundary: BrowserVoiceSignalingBoundary = {
      mode: "local-loopback",
      async negotiate(context) {
        await negotiation.promise;
        latePeer = context.createPeerConnection() as unknown as FakePeerConnection;
        context.registerPeerConnection(latePeer as unknown as RTCPeerConnection);
        context.registerRemoteStream(new FakeStream([lateRemoteTrack]) as unknown as MediaStream);
      },
    };
    const test = harness({ signalingBoundary });
    const starting = test.adapter.start();
    for (let turn = 0; turn < 12 && test.adapter.getSnapshot().state !== "connecting"; turn += 1) {
      await Promise.resolve();
    }
    expect(test.adapter.getSnapshot().state).toBe("connecting");

    test.page.dispatchEvent(new Event("pagehide"));
    expect(test.localTrack.readyState).toBe("ended");
    expect(test.peers.every((peer) => peer.connectionState === "closed")).toBe(true);
    negotiation.resolve();
    await starting;

    expect(latePeer?.connectionState).toBe("closed");
    expect(lateRemoteTrack.readyState).toBe("ended");
    expect(test.adapter.getSnapshot()).toMatchObject({
      state: "idle",
      stopReason: "pagehide",
      cleanupComplete: true,
      allTracksEnded: true,
      allPeerConnectionsClosed: true,
      audioReferencesReleased: true,
      activeListenerCount: 0,
      activeTimerCount: 0,
      activeAnimationFrameCount: 0,
    });
  });

  it.each([
    ["NotAllowedError", "microphone-permission-denied"],
    ["NotFoundError", "microphone-device-unavailable"],
  ] as const)("maps %s safely and releases the failed cycle", async (name, errorCode) => {
    const test = harness({
      getUserMedia: () => Promise.reject(new DOMException("browser detail", name)),
    });
    const failed = await test.adapter.start();
    expect(failed).toMatchObject({
      state: "error",
      errorCode,
      cleanupComplete: true,
      activeListenerCount: 0,
      activeTimerCount: 0,
    });
    expect(failed.safeError).not.toContain("browser detail");
  });

  it("cleans up peer failure, unexpected track end, pagehide, and component disposal idempotently", async () => {
    for (const trigger of ["peer", "track", "pagehide", "dispose"] as const) {
      const test = harness();
      await test.adapter.start();
      if (trigger === "peer") test.peers[0]?.fail();
      if (trigger === "track") test.localTrack.end();
      if (trigger === "pagehide") test.page.dispatchEvent(new Event("pagehide"));
      if (trigger === "dispose") await test.adapter.dispose();
      await Promise.resolve();
      await Promise.resolve();
      if (test.adapter.getSnapshot().state !== "idle" && trigger !== "peer") {
        await test.adapter.stop();
      }
      const final = test.adapter.getSnapshot();
      expect(final.allTracksEnded).toBe(true);
      expect(final.allPeerConnectionsClosed).toBe(true);
      expect(final.activeListenerCount).toBe(0);
      expect(final.activeTimerCount).toBe(0);
      expect(final.activeAnimationFrameCount).toBe(0);
      expect(test.localTrack.readyState).toBe("ended");
      expect(test.peers.every((peer) => peer.connectionState === "closed")).toBe(true);
      if (trigger === "peer") expect(final.errorCode).toBe("peer-connection-failed");
      if (trigger === "pagehide" || trigger === "dispose") {
        expect(test.clearTestAuthorization).toHaveBeenCalledTimes(1);
      } else {
        expect(test.clearTestAuthorization).not.toHaveBeenCalled();
      }
    }
  });

  it("reuses one nonsecret authorization marker across repeated cycles without leaks", async () => {
    let checks = 0;
    const test = harness({
      authorize: async () => ({ requested: checks++ === 0, authorizedUntil: Date.now() + 60_000 }),
    });
    for (let cycle = 0; cycle < 8; cycle += 1) {
      await test.adapter.start();
      test.runAnimationFrame();
      await test.adapter.stop();
    }
    expect(test.adapter.getSnapshot()).toMatchObject({
      authorizationRequests: 1,
      cyclesStarted: 8,
      cyclesCompleted: 8,
      activeListenerCount: 0,
      activeTimerCount: 0,
      activeAnimationFrameCount: 0,
      realtimeCredentialRetained: false,
    });
  });
});

describe("browser voice TEST MODE authorization", () => {
  it("accepts only the short-lived simulated null-endpoint contract", async () => {
    const now = Date.parse("2026-08-20T14:00:00.000Z");
    const request = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(demoAuthorization("2026-08-20T14:01:00.000Z")), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    await expect(
      authorizeBrowserVoiceTestSession(
        CONVERSATION_ID,
        new AbortController().signal,
        request,
        () => now,
      ),
    ).resolves.toBe(Date.parse("2026-08-20T14:01:00.000Z"));
    expect(request).toHaveBeenCalledWith(
      "/api/ai-command/realtime/client-secret",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ conversationId: CONVERSATION_ID }),
      }),
    );
  });

  it("rejects an invalid conversation binding before requesting authorization", async () => {
    const request = vi.fn();
    await expect(
      authorizeBrowserVoiceTestSession("not-a-conversation", new AbortController().signal, request),
    ).rejects.toHaveProperty("name", "BrowserVoiceTestAuthorizationError");
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    { provider: "openai" },
    { simulated: false },
    { webrtcEndpoint: "https://api.openai.com/v1/realtime/calls" },
    { clientSecret: "sk-standard-key-shaped" },
    { standardApiKey: "sk-standard-key-shaped" },
    { beaSessionId: "not-a-session-id" },
    { interactionMode: "unrestricted" },
    { allowInterruption: "yes" },
    { expiresAt: "2026-08-20T14:10:00.000Z" },
  ])("rejects unsafe authorization variant %# before media capture", async (override) => {
    const body = demoAuthorization("2026-08-20T14:01:00.000Z");
    Object.assign(body.authorization, override);
    const request = vi.fn(() => Promise.resolve(Response.json(body)));
    await expect(
      authorizeBrowserVoiceTestSession(CONVERSATION_ID, new AbortController().signal, request, () =>
        Date.parse("2026-08-20T14:00:00.000Z"),
      ),
    ).rejects.toHaveProperty("name", "BrowserVoiceTestAuthorizationError");
  });

  it.each([
    ["network", () => Promise.reject(new Error("raw socket failure sk-should-not-leak"))],
    ["parse", () => Promise.resolve(new Response("{not-json", { status: 200 }))],
  ] as const)(
    "maps %s authorization failure to one safe UI error before capture",
    async (_case, request) => {
      const getUserMedia = vi.fn();
      const test = harness({
        authorize: async (signal) => {
          await authorizeBrowserVoiceTestSession(CONVERSATION_ID, signal, request as typeof fetch);
          return { requested: true, authorizedUntil: Date.now() + 60_000 };
        },
        getUserMedia,
      });
      const failed = await test.adapter.start();
      expect(failed).toMatchObject({
        state: "error",
        errorCode: "test-authorization-rejected",
        safeError:
          "The audited Demo authorization required for browser voice TEST MODE was rejected.",
      });
      expect(JSON.stringify(failed)).not.toContain("raw socket");
      expect(JSON.stringify(failed)).not.toContain("sk-should-not-leak");
      expect(getUserMedia).not.toHaveBeenCalled();
    },
  );

  it("caches only the nonsecret expiry marker and clears it on lifecycle teardown", async () => {
    let now = Date.parse("2026-08-20T14:00:00.000Z");
    const request = vi.fn(() =>
      Promise.resolve(Response.json(demoAuthorization("2026-08-20T14:01:00.000Z"))),
    );
    const authorizer = createBrowserVoiceTestAuthorizer(CONVERSATION_ID, request, () => now);
    const signal = new AbortController().signal;
    await expect(authorizer.authorize(signal)).resolves.toMatchObject({ requested: true });
    await expect(authorizer.authorize(signal)).resolves.toMatchObject({ requested: false });
    expect(request).toHaveBeenCalledTimes(1);
    authorizer.clear();
    now += 1;
    await expect(authorizer.authorize(signal)).resolves.toMatchObject({ requested: true });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
