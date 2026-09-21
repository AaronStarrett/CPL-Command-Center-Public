import { PHASE21_LIMITS } from "@bea/ai/presentation";

export const BROWSER_VOICE_TEST_MODE = "TEST MODE" as const;
export const BROWSER_VOICE_LIVE_MODE = "LIVE — OPENAI REALTIME" as const;
export const BROWSER_VOICE_AUTHORIZATION_ENDPOINT =
  "/api/ai-command/realtime/client-secret" as const;
export const BROWSER_VOICE_EVENTS_ENDPOINT = "/api/ai-command/realtime/events" as const;
export const BROWSER_VOICE_TOOL_ENDPOINT = "/api/ai-command/realtime/tools/execute" as const;

export type BrowserVoiceState =
  | "idle"
  | "authorizing"
  | "requesting-permission"
  | "connecting"
  | "listening"
  | "user-speaking"
  | "processing"
  | "assistant-speaking"
  | "interrupted"
  | "muted"
  | "reconnecting"
  | "disconnected"
  | "stopping"
  | "error";

export type BrowserVoiceErrorCode =
  | "browser-media-unsupported"
  | "live-authorization-rejected"
  | "live-session-rejected"
  | "test-authorization-rejected"
  | "microphone-permission-denied"
  | "microphone-device-unavailable"
  | "peer-connection-failed";

export type BrowserVoiceStopReason =
  | "component-unmount"
  | "pagehide"
  | "peer-connection-failed"
  | "start-failed"
  | "track-ended"
  | "user-cancelled"
  | "user-stopped"
  | "session-expired";

export interface BrowserVoiceSnapshot {
  readonly mode: typeof BROWSER_VOICE_TEST_MODE | typeof BROWSER_VOICE_LIVE_MODE;
  readonly state: BrowserVoiceState;
  readonly stateHistory: readonly BrowserVoiceState[];
  readonly signalingMode: string;
  readonly authorizationRequests: number;
  readonly errorCode?: BrowserVoiceErrorCode;
  readonly safeError?: string;
  readonly stopReason?: BrowserVoiceStopReason;
  readonly cyclesStarted: number;
  readonly cyclesCompleted: number;
  readonly localAudioTrackState: "none" | "live" | "ended";
  readonly allTracksEnded: boolean;
  readonly microphoneActive: boolean;
  readonly peerConnectionStates: readonly string[];
  readonly allPeerConnectionsClosed: boolean;
  readonly audioElementState: "none" | "attached" | "released";
  readonly audioReferencesReleased: boolean;
  readonly activeTimerCount: number;
  readonly activeListenerCount: number;
  readonly activeAnimationFrameCount: number;
  readonly transcript: string;
  readonly muted: boolean;
  readonly interactionMode: "automatic" | "push_to_talk";
  readonly toolCallsCompleted: number;
  readonly providerConnected: boolean;
  readonly sessionId?: string;
  readonly rawAudioPersisted: false;
  readonly externalProviderCalls: number;
  readonly standardApiKeyExposed: false;
  readonly realtimeCredentialRetained: false;
  readonly cleanupComplete: boolean;
}

export interface BrowserVoiceAuthorizationResult {
  readonly requested: boolean;
  readonly authorizedUntil: number;
  readonly liveAuthorization?: BrowserVoiceLiveAuthorization;
}

export interface BrowserVoiceLiveAuthorization {
  readonly clientSecret: string;
  readonly expiresAt: number;
  readonly providerSessionId?: string;
  readonly beaSessionId: string;
  readonly model: string;
  readonly voice: string;
  readonly webrtcEndpoint: "https://api.openai.com/v1/realtime/calls";
  readonly interactionMode: "automatic" | "push_to_talk";
  readonly allowInterruption: boolean;
}

export interface BrowserVoiceEnvironment {
  readonly authorizeTestSession: (signal: AbortSignal) => Promise<BrowserVoiceAuthorizationResult>;
  readonly authorizeLiveSession?: (signal: AbortSignal) => Promise<BrowserVoiceAuthorizationResult>;
  readonly clearTestAuthorization?: () => void;
  readonly getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  readonly createPeerConnection?: () => RTCPeerConnection;
  readonly createMediaStream?: (tracks?: readonly MediaStreamTrack[]) => MediaStream;
  readonly createAudioElement?: () => HTMLAudioElement;
  readonly createAudioContext?: () => AudioContext | undefined;
  readonly appendAudioElement?: (element: HTMLAudioElement) => void;
  readonly requestAnimationFrame: (callback: FrameRequestCallback) => number;
  readonly cancelAnimationFrame: (handle: number) => void;
  readonly setTimeout: (callback: () => void, milliseconds: number) => number;
  readonly clearTimeout: (handle: number) => void;
  readonly pageLifecycleTarget?: EventTarget;
}

type RemoveListener = () => void;

export interface BrowserVoiceNegotiationContext {
  readonly outboundPeerConnection: RTCPeerConnection;
  readonly localStream: MediaStream;
  readonly signal: AbortSignal;
  readonly authorization: BrowserVoiceAuthorizationResult;
  readonly createPeerConnection: () => RTCPeerConnection;
  readonly createMediaStream: (tracks?: readonly MediaStreamTrack[]) => MediaStream;
  readonly registerPeerConnection: (peerConnection: RTCPeerConnection) => void;
  readonly registerRemoteStream: (stream: MediaStream) => void;
  readonly registerDataChannel: (dataChannel: RTCDataChannel) => void;
  readonly recordExternalProviderCall: () => void;
  readonly listen: (target: EventTarget, type: string, listener: EventListener) => RemoveListener;
  readonly waitForIceGathering: (peerConnection: RTCPeerConnection) => Promise<void>;
}

/**
 * Capture and addTrack happen before this injectable boundary. Both the repository-controlled
 * loopback and direct OpenAI WebRTC negotiation therefore exercise the same cleanup path.
 */
export interface BrowserVoiceSignalingBoundary {
  readonly mode: "local-loopback" | "openai-direct-webrtc";
  negotiate(context: BrowserVoiceNegotiationContext): Promise<void>;
}

export interface NarrationSegmentRequest {
  readonly presentationRunId: string;
  readonly narrationSegmentId: string;
  readonly visualElementId: string;
  readonly spokenText: string;
  readonly instructions: string;
}

export interface RealtimeLifecycleListenerEvent {
  readonly type: string;
  readonly providerResponseId?: string | null;
  readonly sessionId?: string | null;
}

export interface BrowserRealtimeVoiceAdapter {
  readonly start: () => Promise<BrowserVoiceSnapshot>;
  readonly stop: (reason?: BrowserVoiceStopReason) => Promise<BrowserVoiceSnapshot>;
  readonly dispose: () => Promise<void>;
  readonly setMuted: (muted: boolean) => BrowserVoiceSnapshot;
  readonly interrupt: () => BrowserVoiceSnapshot;
  readonly clearPendingOutput: () => BrowserVoiceSnapshot;
  readonly requestNarrationSegment: (input: NarrationSegmentRequest) => boolean;
  readonly reconnect: () => Promise<BrowserVoiceSnapshot>;
  readonly beginPushToTalk: () => BrowserVoiceSnapshot;
  readonly endPushToTalk: () => BrowserVoiceSnapshot;
  readonly getSnapshot: () => BrowserVoiceSnapshot;
  readonly subscribe: (listener: (snapshot: BrowserVoiceSnapshot) => void) => () => void;
  readonly subscribeRealtimeEvents: (
    listener: (event: RealtimeLifecycleListenerEvent) => void,
  ) => () => void;
}

export interface BrowserRealtimeVoiceAdapterOptions {
  readonly environment?: BrowserVoiceEnvironment;
  readonly signalingBoundary?: BrowserVoiceSignalingBoundary;
  readonly connectionTimeoutMs?: number;
  readonly speakingThreshold?: number;
  readonly mode?: "test" | "live";
  /**
   * Demo co-presenter TEST MODE may emulate the Realtime audio-event contract
   * without microphone capture or WebRTC. Gate 30 local-loopback and live
   * OpenAI sessions still require capture.
   */
  readonly eventContractOnly?: boolean;
  readonly conversationId?: string;
  readonly request?: typeof fetch;
  readonly onWorkspaceUpdated?: () => void | Promise<void>;
  readonly now?: () => number;
  readonly sessionMaxAgeMs?: number;
  readonly onRealtimeEvent?: (event: RealtimeLifecycleListenerEvent) => void;
  readonly testAudioStartDelayMs?: number;
  readonly testAudioCompleteDelayMs?: number;
}

const MAX_STATE_HISTORY = 32;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_SPEAKING_THRESHOLD = 0.025;
const MAX_AUTHORIZATION_RESPONSE_CHARACTERS = 16 * 1024;
const MAX_REALTIME_EVENT_CHARACTERS = 1_048_576;
const MAX_REALTIME_TOOL_RESPONSE_CHARACTERS = 64 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const LIVE_REALTIME_TOOL_NAMES = new Set([
  "search_web",
  "bea_query_records",
  "bea_connector_health",
  "bea_workflow_history",
  "bea_preview_task",
  "bea_show_workspace",
  "bea_create_pdf",
  "bea_open_artifact",
  "bea_list_artifacts",
  "bea_download_artifact",
  "bea_revise_artifact",
  "bea_list_agents",
  "bea_get_agent",
  "bea_show_digital_workforce",
  "bea_get_agent_run",
  "bea_show_agent_run",
  "bea_delegate_to_agent",
  "bea_cancel_agent_run",
]);
const DEMO_SECRET_PATTERN =
  /^demo-no-network-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEMO_SESSION_PATTERN =
  /^demo-session-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const AUTHORIZATION_KEYS = new Set([
  "allowInterruption",
  "beaSessionId",
  "clientSecret",
  "expiresAt",
  "interactionMode",
  "model",
  "provider",
  "sessionId",
  "simulated",
  "speakResponses",
  "voice",
  "webrtcEndpoint",
]);

class BrowserVoiceTestAuthorizationError extends Error {
  override readonly name = "BrowserVoiceTestAuthorizationError";
}

class BrowserVoiceLiveAuthorizationError extends Error {
  override readonly name = "BrowserVoiceLiveAuthorizationError";
}

class BrowserVoiceLiveSessionError extends Error {
  override readonly name = "BrowserVoiceLiveSessionError";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Authorizes only the audited Demo provider contract. The response and its synthetic secret stay
 * inside this stack frame and are discarded before microphone capture or SDP creation begins.
 */
export async function authorizeBrowserVoiceTestSession(
  conversationId: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<number> {
  if (!UUID_PATTERN.test(conversationId)) throw new BrowserVoiceTestAuthorizationError();
  try {
    const response = await request(BROWSER_VOICE_AUTHORIZATION_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId }),
      signal,
    });
    if (!response.ok) throw new BrowserVoiceTestAuthorizationError();
    const responseText = await response.text();
    if (responseText.length > MAX_AUTHORIZATION_RESPONSE_CHARACTERS) {
      throw new BrowserVoiceTestAuthorizationError();
    }
    const body = record(JSON.parse(responseText) as unknown);
    const authorization = record(body?.authorization);
    const expiresAt =
      typeof authorization?.expiresAt === "string"
        ? Date.parse(authorization.expiresAt)
        : Number.NaN;
    const clientSecret =
      typeof authorization?.clientSecret === "string" ? authorization.clientSecret : "";
    const issuedAt = now();
    assertNotAborted(signal);
    if (
      !body ||
      Object.keys(body).length !== 1 ||
      !authorization ||
      Object.keys(authorization).some((key) => !AUTHORIZATION_KEYS.has(key)) ||
      authorization?.simulated !== true ||
      authorization.provider !== "demo" ||
      authorization.webrtcEndpoint !== null ||
      !DEMO_SECRET_PATTERN.test(clientSecret) ||
      typeof authorization.sessionId !== "string" ||
      !DEMO_SESSION_PATTERN.test(authorization.sessionId) ||
      typeof authorization.beaSessionId !== "string" ||
      !UUID_PATTERN.test(authorization.beaSessionId) ||
      typeof authorization.model !== "string" ||
      !authorization.model.trim() ||
      typeof authorization.voice !== "string" ||
      !authorization.voice.trim() ||
      (authorization.interactionMode !== "automatic" &&
        authorization.interactionMode !== "push_to_talk") ||
      typeof authorization.allowInterruption !== "boolean" ||
      (authorization.speakResponses !== undefined &&
        typeof authorization.speakResponses !== "boolean") ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= issuedAt ||
      expiresAt > issuedAt + 120_000
    ) {
      throw new BrowserVoiceTestAuthorizationError();
    }
    return expiresAt;
  } catch (error) {
    if (
      signal.aborted ||
      (error instanceof DOMException && error.name === "AbortError") ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      throw abortError();
    }
    if (error instanceof BrowserVoiceTestAuthorizationError) throw error;
    throw new BrowserVoiceTestAuthorizationError();
  }
}

export function createBrowserVoiceTestAuthorizer(
  conversationId: string,
  request: typeof fetch = fetch,
  now: () => number = Date.now,
): {
  readonly authorize: (signal: AbortSignal) => Promise<BrowserVoiceAuthorizationResult>;
  readonly clear: () => void;
} {
  let authorizedUntil = 0;
  return {
    async authorize(signal) {
      const current = now();
      if (authorizedUntil > current) return { requested: false, authorizedUntil };
      authorizedUntil = 0;
      const expiresAt = await authorizeBrowserVoiceTestSession(
        conversationId,
        signal,
        request,
        now,
      );
      assertNotAborted(signal);
      authorizedUntil = expiresAt;
      return { requested: true, authorizedUntil };
    },
    clear() {
      authorizedUntil = 0;
    },
  };
}

export async function authorizeBrowserVoiceLiveSession(
  conversationId: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<BrowserVoiceLiveAuthorization> {
  if (!UUID_PATTERN.test(conversationId)) throw new BrowserVoiceLiveAuthorizationError();
  try {
    const response = await request(BROWSER_VOICE_AUTHORIZATION_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId }),
      signal,
    });
    if (!response.ok) throw new BrowserVoiceLiveAuthorizationError();
    const responseText = await response.text();
    if (responseText.length > MAX_AUTHORIZATION_RESPONSE_CHARACTERS) {
      throw new BrowserVoiceLiveAuthorizationError();
    }
    const body = record(JSON.parse(responseText) as unknown);
    const authorization = record(body?.authorization);
    const expiresAt =
      typeof authorization?.expiresAt === "string"
        ? Date.parse(authorization.expiresAt)
        : Number.NaN;
    const issuedAt = now();
    assertNotAborted(signal);
    if (
      !body ||
      Object.keys(body).length !== 1 ||
      !authorization ||
      Object.keys(authorization).some((key) => !AUTHORIZATION_KEYS.has(key)) ||
      authorization.provider !== "openai" ||
      authorization.simulated !== false ||
      authorization.webrtcEndpoint !== "https://api.openai.com/v1/realtime/calls" ||
      typeof authorization.clientSecret !== "string" ||
      !authorization.clientSecret.startsWith("ek_") ||
      authorization.clientSecret.length < 20 ||
      authorization.clientSecret.length > 4_096 ||
      /\s/u.test(authorization.clientSecret) ||
      typeof authorization.beaSessionId !== "string" ||
      !UUID_PATTERN.test(authorization.beaSessionId) ||
      (authorization.sessionId !== undefined &&
        (typeof authorization.sessionId !== "string" ||
          !PROVIDER_ID_PATTERN.test(authorization.sessionId))) ||
      typeof authorization.model !== "string" ||
      !PROVIDER_ID_PATTERN.test(authorization.model) ||
      typeof authorization.voice !== "string" ||
      !PROVIDER_ID_PATTERN.test(authorization.voice) ||
      (authorization.interactionMode !== "automatic" &&
        authorization.interactionMode !== "push_to_talk") ||
      typeof authorization.allowInterruption !== "boolean" ||
      (authorization.speakResponses !== undefined &&
        typeof authorization.speakResponses !== "boolean") ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= issuedAt ||
      expiresAt > issuedAt + 120_000
    ) {
      throw new BrowserVoiceLiveAuthorizationError();
    }
    return {
      clientSecret: authorization.clientSecret,
      expiresAt,
      ...(typeof authorization.sessionId === "string"
        ? { providerSessionId: authorization.sessionId }
        : {}),
      beaSessionId: authorization.beaSessionId,
      model: authorization.model,
      voice: authorization.voice,
      webrtcEndpoint: authorization.webrtcEndpoint,
      interactionMode: authorization.interactionMode,
      allowInterruption: authorization.allowInterruption,
    };
  } catch (error) {
    if (
      signal.aborted ||
      (error instanceof DOMException && error.name === "AbortError") ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      throw abortError();
    }
    if (error instanceof BrowserVoiceLiveAuthorizationError) throw error;
    throw new BrowserVoiceLiveAuthorizationError();
  }
}

export function createBrowserVoiceLiveAuthorizer(
  conversationId: string,
  request: typeof fetch = fetch,
  now: () => number = Date.now,
): (signal: AbortSignal) => Promise<BrowserVoiceAuthorizationResult> {
  return async (signal) => {
    const liveAuthorization = await authorizeBrowserVoiceLiveSession(
      conversationId,
      signal,
      request,
      now,
    );
    return {
      requested: true,
      authorizedUntil: liveAuthorization.expiresAt,
      liveAuthorization,
    };
  };
}

function defaultEnvironment(options: BrowserRealtimeVoiceAdapterOptions): BrowserVoiceEnvironment {
  const audioContextConstructor =
    window.AudioContext ??
    (window as unknown as { readonly webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  const request = options.request ?? fetch;
  const authorizer = createBrowserVoiceTestAuthorizer(options.conversationId ?? "", request);
  const liveAuthorizer =
    options.mode === "live" && options.conversationId
      ? createBrowserVoiceLiveAuthorizer(options.conversationId, request)
      : undefined;
  return {
    authorizeTestSession: authorizer.authorize,
    ...(liveAuthorizer ? { authorizeLiveSession: liveAuthorizer } : {}),
    clearTestAuthorization: authorizer.clear,
    getUserMedia: window.navigator.mediaDevices?.getUserMedia.bind(window.navigator.mediaDevices),
    createPeerConnection:
      typeof window.RTCPeerConnection === "function"
        ? () => new window.RTCPeerConnection({ iceServers: [] })
        : undefined,
    createMediaStream:
      typeof window.MediaStream === "function"
        ? (tracks = []) => new window.MediaStream([...tracks])
        : undefined,
    createAudioElement: () => window.document.createElement("audio"),
    createAudioContext: audioContextConstructor
      ? () => new audioContextConstructor()
      : () => undefined,
    appendAudioElement: (element) => window.document.body.append(element),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    pageLifecycleTarget: window,
  };
}

function abortError(): DOMException {
  return new DOMException("The browser voice operation was cancelled.", "AbortError");
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function classifyStartError(error: unknown): {
  readonly code: BrowserVoiceErrorCode;
  readonly message: string;
} {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  if (error instanceof Error && error.name === "BrowserVoiceLiveAuthorizationError") {
    return {
      code: "live-authorization-rejected",
      message:
        "Live Realtime authorization was rejected. Verify the connected provider, model, voice, and owner permissions.",
    };
  }
  if (error instanceof Error && error.name === "BrowserVoiceLiveSessionError") {
    return {
      code: "live-session-rejected",
      message: "The OpenAI Realtime WebRTC session could not be established.",
    };
  }
  if (error instanceof Error && error.name === "BrowserVoiceTestAuthorizationError") {
    return {
      code: "test-authorization-rejected",
      message: "The audited Demo authorization required for browser voice TEST MODE was rejected.",
    };
  }
  if (name === "NotAllowedError" || name === "SecurityError") {
    return {
      code: "microphone-permission-denied",
      message: "Microphone permission was denied for browser voice TEST MODE.",
    };
  }
  if (
    name === "NotFoundError" ||
    name === "DevicesNotFoundError" ||
    name === "NotReadableError" ||
    name === "TrackStartError" ||
    name === "OverconstrainedError"
  ) {
    return {
      code: "microphone-device-unavailable",
      message: "No usable microphone device is available for browser voice TEST MODE.",
    };
  }
  return {
    code: "peer-connection-failed",
    message: "The local browser voice loopback could not be established.",
  };
}

/** This is the single local-track attachment seam used before any signaling boundary. */
export function attachRealtimeAudioTrack(
  peerConnection: RTCPeerConnection,
  track: MediaStreamTrack,
  stream: MediaStream,
): RTCRtpSender {
  return peerConnection.addTrack(track, stream);
}

export const LOCAL_LOOPBACK_SIGNALING: BrowserVoiceSignalingBoundary = {
  mode: "local-loopback",
  async negotiate(context) {
    const inbound = context.createPeerConnection();
    context.registerPeerConnection(inbound);
    context.listen(inbound, "track", ((event: Event) => {
      const trackEvent = event as RTCTrackEvent;
      const stream =
        trackEvent.streams[0] ??
        context.createMediaStream(trackEvent.track ? [trackEvent.track] : []);
      context.registerRemoteStream(stream);
    }) as EventListener);

    const offer = await context.outboundPeerConnection.createOffer();
    assertNotAborted(context.signal);
    await context.outboundPeerConnection.setLocalDescription(offer);
    await context.waitForIceGathering(context.outboundPeerConnection);
    assertNotAborted(context.signal);
    const gatheredOffer = context.outboundPeerConnection.localDescription;
    if (!gatheredOffer) throw new Error("Local loopback offer was not available.");
    await inbound.setRemoteDescription(gatheredOffer);
    const answer = await inbound.createAnswer();
    assertNotAborted(context.signal);
    await inbound.setLocalDescription(answer);
    await context.waitForIceGathering(inbound);
    assertNotAborted(context.signal);
    const gatheredAnswer = inbound.localDescription;
    if (!gatheredAnswer) throw new Error("Local loopback answer was not available.");
    await context.outboundPeerConnection.setRemoteDescription(gatheredAnswer);
  },
};

export function createOpenAiRealtimeSignalingBoundary(
  request: typeof fetch = fetch,
): BrowserVoiceSignalingBoundary {
  return {
    mode: "openai-direct-webrtc",
    async negotiate(context) {
      const authorization = context.authorization.liveAuthorization;
      if (!authorization) throw new BrowserVoiceLiveSessionError();
      const dataChannel = context.outboundPeerConnection.createDataChannel("oai-events");
      context.registerDataChannel(dataChannel);
      context.listen(context.outboundPeerConnection, "track", ((event: Event) => {
        const trackEvent = event as RTCTrackEvent;
        const stream =
          trackEvent.streams[0] ??
          context.createMediaStream(trackEvent.track ? [trackEvent.track] : []);
        context.registerRemoteStream(stream);
      }) as EventListener);

      const offer = await context.outboundPeerConnection.createOffer();
      assertNotAborted(context.signal);
      await context.outboundPeerConnection.setLocalDescription(offer);
      await context.waitForIceGathering(context.outboundPeerConnection);
      assertNotAborted(context.signal);
      const gatheredOffer = context.outboundPeerConnection.localDescription;
      if (
        !gatheredOffer?.sdp ||
        gatheredOffer.type !== "offer" ||
        gatheredOffer.sdp.length < 10 ||
        gatheredOffer.sdp.length > MAX_REALTIME_EVENT_CHARACTERS ||
        !gatheredOffer.sdp.startsWith("v=0") ||
        gatheredOffer.sdp.includes("\0")
      ) {
        throw new BrowserVoiceLiveSessionError();
      }
      context.recordExternalProviderCall();
      const response = await request(authorization.webrtcEndpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authorization.clientSecret}`,
          "Content-Type": "application/sdp",
        },
        body: gatheredOffer.sdp,
        signal: context.signal,
        redirect: "error",
      });
      if (!response.ok) throw new BrowserVoiceLiveSessionError();
      const answerSdp = await response.text();
      if (
        answerSdp.length < 10 ||
        answerSdp.length > MAX_REALTIME_EVENT_CHARACTERS ||
        !answerSdp.startsWith("v=0") ||
        answerSdp.includes("\0")
      ) {
        throw new BrowserVoiceLiveSessionError();
      }
      assertNotAborted(context.signal);
      await context.outboundPeerConnection.setRemoteDescription({
        type: "answer",
        sdp: answerSdp,
      });
    },
  };
}

export function createBrowserRealtimeVoiceAdapter(
  options: BrowserRealtimeVoiceAdapterOptions = {},
): BrowserRealtimeVoiceAdapter {
  const liveMode = options.mode === "live";
  const eventContractOnly = options.eventContractOnly === true && !liveMode;
  const request = options.request ?? fetch;
  const environment = options.environment ?? defaultEnvironment(options);
  const signalingBoundary =
    options.signalingBoundary ??
    (liveMode ? createOpenAiRealtimeSignalingBoundary(request) : LOCAL_LOOPBACK_SIGNALING);
  const connectionTimeoutMs = options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
  const speakingThreshold = options.speakingThreshold ?? DEFAULT_SPEAKING_THRESHOLD;
  const subscribers = new Set<(snapshot: BrowserVoiceSnapshot) => void>();
  const realtimeListeners = new Set<(event: RealtimeLifecycleListenerEvent) => void>();
  const sessionMaxAgeMs = options.sessionMaxAgeMs ?? PHASE21_LIMITS.realtimeSessionMaxAgeMs;
  const currentTimeMs = options.now ?? Date.now;
  const testAudioStartDelayMs = options.testAudioStartDelayMs ?? (eventContractOnly ? 80 : 12);
  const testAudioCompleteDelayMs =
    options.testAudioCompleteDelayMs ?? (eventContractOnly ? 2_400 : 28);
  const pendingNarrationTimers = new Set<number>();
  const listeners = new Set<RemoveListener>();
  const timers = new Set<number>();
  const peerConnections = new Set<RTCPeerConnection>();
  const dataChannels = new Set<RTCDataChannel>();
  const ownedTracks = new Set<MediaStreamTrack>();
  const remoteStreams = new Set<MediaStream>();
  let localStream: MediaStream | undefined;
  let audioElement: HTMLAudioElement | undefined;
  let activeDataChannel: RTCDataChannel | undefined;
  let audioContext: AudioContext | undefined;
  let audioSource: MediaStreamAudioSourceNode | undefined;
  let analyser: AnalyserNode | undefined;
  let animationFrame: number | undefined;
  let operation = 0;
  let operationAbortController: AbortController | undefined;
  let cleanupPromise: Promise<BrowserVoiceSnapshot> | undefined;
  let disposed = false;
  let stateHistory: BrowserVoiceState[] = ["idle"];
  let state: BrowserVoiceState = "idle";
  let errorCode: BrowserVoiceErrorCode | undefined;
  let safeError: string | undefined;
  let stopReason: BrowserVoiceStopReason | undefined;
  let authorizationRequests = 0;
  let cyclesStarted = 0;
  let cyclesCompleted = 0;
  let localAudioTrackState: BrowserVoiceSnapshot["localAudioTrackState"] = "none";
  let lastPeerConnectionStates: string[] = [];
  let audioElementState: BrowserVoiceSnapshot["audioElementState"] = "none";
  let cleanupComplete = true;
  let transcript = "";
  let userTranscript = "";
  let assistantTranscript = "";
  let muted = false;
  let interactionMode: BrowserVoiceSnapshot["interactionMode"] = "automatic";
  let allowInterruption = true;
  let toolCallsCompleted = 0;
  let externalProviderCalls = 0;
  let providerConnected = false;
  let liveSession:
    | {
        readonly beaSessionId: string;
        readonly providerSessionId?: string;
        readonly model: string;
        readonly voice: string;
        readonly startedAt: number;
      }
    | undefined;
  let terminalEventReported = false;
  const handledToolCalls = new Set<string>();
  const reportedTranscripts = new Set<string>();
  const reportedUsageResponses = new Set<string>();
  const pendingRequestControllers = new Set<AbortController>();
  let sessionExpiryHandle: number | undefined;
  let testNarrationSequence = 0;

  function notifyRealtime(event: RealtimeLifecycleListenerEvent): void {
    options.onRealtimeEvent?.(event);
    for (const listener of realtimeListeners) listener(event);
  }

  function clearPendingNarrationTimers(): void {
    for (const handle of [...pendingNarrationTimers]) {
      clearScheduled(handle);
      pendingNarrationTimers.delete(handle);
    }
  }

  function snapshot(): BrowserVoiceSnapshot {
    const currentPeerStates =
      peerConnections.size > 0
        ? [...peerConnections].map((peerConnection) => peerConnection.connectionState)
        : lastPeerConnectionStates;
    return Object.freeze({
      mode: liveMode ? BROWSER_VOICE_LIVE_MODE : BROWSER_VOICE_TEST_MODE,
      state,
      stateHistory: Object.freeze([...stateHistory]),
      signalingMode: signalingBoundary.mode,
      authorizationRequests,
      ...(errorCode ? { errorCode } : {}),
      ...(safeError ? { safeError } : {}),
      ...(stopReason ? { stopReason } : {}),
      cyclesStarted,
      cyclesCompleted,
      localAudioTrackState,
      allTracksEnded: ownedTracks.size === 0 && localAudioTrackState !== "live",
      microphoneActive: [...ownedTracks].some((track) => track.readyState === "live"),
      peerConnectionStates: Object.freeze([...currentPeerStates]),
      allPeerConnectionsClosed:
        peerConnections.size === 0 &&
        currentPeerStates.every((peerState) => peerState === "closed"),
      audioElementState,
      audioReferencesReleased: audioElement === undefined && audioElementState !== "attached",
      activeTimerCount: timers.size,
      activeListenerCount: listeners.size,
      activeAnimationFrameCount: animationFrame === undefined ? 0 : 1,
      transcript,
      muted,
      interactionMode,
      toolCallsCompleted,
      providerConnected,
      ...(liveSession ? { sessionId: liveSession.beaSessionId } : {}),
      rawAudioPersisted: false,
      externalProviderCalls,
      standardApiKeyExposed: false,
      realtimeCredentialRetained: false,
      cleanupComplete,
    });
  }

  function publish(): BrowserVoiceSnapshot {
    const next = snapshot();
    for (const subscriber of subscribers) subscriber(next);
    if (typeof window !== "undefined") {
      Object.defineProperty(window, "__BEA_BROWSER_VOICE_TEST_DIAGNOSTICS__", {
        configurable: true,
        enumerable: false,
        writable: false,
        value: next,
      });
    }
    return next;
  }

  function transition(next: BrowserVoiceState): BrowserVoiceSnapshot {
    if (state !== next) {
      state = next;
      stateHistory = [...stateHistory, next].slice(-MAX_STATE_HISTORY);
    }
    return publish();
  }

  function refreshTranscript(): void {
    transcript = [
      userTranscript ? `You: ${userTranscript}` : "",
      assistantTranscript ? `BEA: ${assistantTranscript}` : "",
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 40_000);
    publish();
  }

  async function postLiveJson(
    endpoint: string,
    body: Record<string, unknown>,
    options: { readonly keepalive?: boolean; readonly maximumCharacters?: number } = {},
  ): Promise<Record<string, unknown>> {
    const controller = options.keepalive ? undefined : new AbortController();
    if (controller) pendingRequestControllers.add(controller);
    try {
      const response = await request(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        ...(controller ? { signal: controller.signal } : {}),
        ...(options.keepalive ? { keepalive: true } : {}),
      });
      const responseText = await response.text();
      if (
        responseText.length > (options.maximumCharacters ?? MAX_REALTIME_TOOL_RESPONSE_CHARACTERS)
      ) {
        throw new Error("Realtime backend response exceeded its safe limit.");
      }
      const parsed = record(JSON.parse(responseText) as unknown);
      if (!response.ok || !parsed) throw new Error("Realtime backend request failed.");
      return parsed;
    } finally {
      if (controller) pendingRequestControllers.delete(controller);
    }
  }

  async function reportLiveEvent(
    type: "connected" | "transcript" | "usage" | "completed" | "failed" | "cancelled",
    fields: Record<string, unknown> = {},
    keepalive = false,
  ): Promise<void> {
    const session = liveSession;
    if (!liveMode || !session || !options.conversationId) return;
    await postLiveJson(
      BROWSER_VOICE_EVENTS_ENDPOINT,
      {
        type,
        sessionId: session.beaSessionId,
        conversationId: options.conversationId,
        ...fields,
      },
      { keepalive, maximumCharacters: 16_384 },
    );
  }

  function reportTranscript(role: "user" | "assistant", itemId: string, text: string): void {
    const normalized = text.replace(/\s+/gu, " ").trim().slice(0, 20_000);
    const key = `${role}:${itemId}`;
    if (!normalized || !PROVIDER_ID_PATTERN.test(itemId) || reportedTranscripts.has(key)) return;
    reportedTranscripts.add(key);
    if (role === "user") {
      userTranscript = normalized;
      assistantTranscript = "";
    } else {
      assistantTranscript = normalized;
    }
    refreshTranscript();
    void reportLiveEvent("transcript", { role, itemId, text: normalized })
      .then(() => options.onWorkspaceUpdated?.())
      .catch(() => {
        safeError = "Live voice continued, but a transcript could not be persisted.";
        publish();
      });
  }

  function sendDataChannelEvent(value: Record<string, unknown>): boolean {
    const channel = activeDataChannel;
    if (!channel || channel.readyState !== "open") return false;
    try {
      channel.send(JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  async function executeRealtimeTool(
    name: string,
    callId: string,
    argumentsText: string,
  ): Promise<void> {
    if (
      !liveSession ||
      !options.conversationId ||
      !LIVE_REALTIME_TOOL_NAMES.has(name) ||
      !PROVIDER_ID_PATTERN.test(callId) ||
      handledToolCalls.has(callId) ||
      argumentsText.length > 8_192
    ) {
      return;
    }
    let argumentsValue: Record<string, unknown> | undefined;
    try {
      argumentsValue = record(JSON.parse(argumentsText) as unknown);
    } catch {
      // The server remains authoritative; malformed arguments receive a safe function result.
    }
    if (!argumentsValue) return;
    handledToolCalls.add(callId);
    transition("processing");
    try {
      const result = await postLiveJson(BROWSER_VOICE_TOOL_ENDPOINT, {
        sessionId: liveSession.beaSessionId,
        conversationId: options.conversationId,
        callId,
        name,
        arguments: argumentsValue,
      });
      if (result.callId !== callId || !record(result.output)) {
        throw new Error("Realtime tool response was invalid.");
      }
      if (
        !sendDataChannelEvent({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: callId,
            output: JSON.stringify(result.output),
          },
        })
      ) {
        throw new Error("Realtime tool result could not be returned.");
      }
      const output = record(result.output);
      const suppressAutomatic =
        output?.suppressAutomaticSpokenResponse === true || output?.authoritativeNarration === true;
      if (!suppressAutomatic && !sendDataChannelEvent({ type: "response.create" })) {
        throw new Error("Realtime tool result could not be returned.");
      }
      toolCallsCompleted += 1;
      await options.onWorkspaceUpdated?.();
      publish();
    } catch {
      safeError = "An authorized Realtime tool could not complete.";
      sendDataChannelEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify({ error: "The authorized BEA tool could not complete." }),
        },
      });
      sendDataChannelEvent({ type: "response.create" });
      transition("error");
    }
  }

  function usageValue(value: unknown): number {
    return Number.isSafeInteger(value) && (value as number) >= 0
      ? Math.min(1_000_000_000, value as number)
      : 0;
  }

  function reportRealtimeUsage(event: Record<string, unknown>): void {
    const response = record(event.response);
    const responseId = typeof response?.id === "string" ? response.id : "";
    if (!responseId || reportedUsageResponses.has(responseId)) return;
    reportedUsageResponses.add(responseId);
    const usage = record(response?.usage);
    const inputDetails = record(usage?.input_token_details);
    const outputDetails = record(usage?.output_token_details);
    const durationSeconds = liveSession
      ? Math.max(0, Math.min(7_200, Math.round((Date.now() - liveSession.startedAt) / 1_000)))
      : 0;
    void reportLiveEvent("usage", {
      usage: {
        inputTokens: usageValue(usage?.input_tokens),
        outputTokens: usageValue(usage?.output_tokens),
        reasoningTokens: usageValue(outputDetails?.reasoning_tokens),
        cachedInputTokens: usageValue(inputDetails?.cached_tokens),
        audioInputTokens: usageValue(inputDetails?.audio_tokens),
        audioOutputTokens: usageValue(outputDetails?.audio_tokens),
        durationSeconds,
      },
    }).catch(() => {
      safeError = "Live voice continued, but usage metadata could not be recorded.";
      publish();
    });
  }

  async function handleRealtimeServerEvent(raw: unknown): Promise<void> {
    if (typeof raw !== "string" || raw.length > MAX_REALTIME_EVENT_CHARACTERS) return;
    if (/"type"\s*:\s*"response\.output_audio\.delta"/u.test(raw)) {
      transition("assistant-speaking");
      notifyRealtime({
        type: "response.output_audio.delta",
        sessionId: liveSession?.beaSessionId ?? null,
      });
      return;
    }
    let event: Record<string, unknown> | undefined;
    try {
      event = record(JSON.parse(raw) as unknown);
    } catch {
      return;
    }
    if (!event || typeof event.type !== "string") return;
    const response = record(event.response);
    const providerResponseId =
      typeof response?.id === "string"
        ? response.id
        : typeof event.response_id === "string"
          ? event.response_id
          : null;
    notifyRealtime({
      type: event.type,
      providerResponseId,
      sessionId: liveSession?.beaSessionId ?? null,
    });
    if (event.type === "input_audio_buffer.speech_started") {
      if (state === "assistant-speaking" && allowInterruption) {
        sendDataChannelEvent({ type: "response.cancel" });
        sendDataChannelEvent({ type: "output_audio_buffer.clear" });
        clearPendingNarrationTimers();
        transition("interrupted");
      } else {
        transition(state === "assistant-speaking" ? "interrupted" : "user-speaking");
      }
      return;
    }
    if (event.type === "input_audio_buffer.speech_stopped" || event.type === "response.created") {
      transition("processing");
      return;
    }
    if (
      event.type === "response.output_audio_transcript.delta" ||
      event.type === "response.output_text.delta"
    ) {
      if (typeof event.delta === "string") {
        assistantTranscript = `${assistantTranscript}${event.delta}`.slice(0, 20_000);
        refreshTranscript();
      }
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.completed") {
      if (typeof event.item_id === "string" && typeof event.transcript === "string") {
        reportTranscript("user", event.item_id, event.transcript);
      }
      return;
    }
    if (event.type === "response.output_audio_transcript.done") {
      if (typeof event.item_id === "string" && typeof event.transcript === "string") {
        reportTranscript("assistant", event.item_id, event.transcript);
      }
      return;
    }
    if (event.type === "response.output_text.done") {
      if (typeof event.item_id === "string" && typeof event.text === "string") {
        reportTranscript("assistant", event.item_id, event.text);
      }
      return;
    }
    if (event.type === "response.function_call_arguments.done") {
      if (
        typeof event.name === "string" &&
        typeof event.call_id === "string" &&
        typeof event.arguments === "string"
      ) {
        await executeRealtimeTool(event.name, event.call_id, event.arguments);
      }
      return;
    }
    if (event.type === "response.done") {
      const response = record(event.response);
      const output = Array.isArray(response?.output) ? response.output : [];
      for (const itemValue of output) {
        const item = record(itemValue);
        if (
          item?.type === "function_call" &&
          typeof item.name === "string" &&
          typeof item.call_id === "string" &&
          typeof item.arguments === "string"
        ) {
          await executeRealtimeTool(item.name, item.call_id, item.arguments);
        }
        if (
          item?.type === "message" &&
          item.role === "assistant" &&
          typeof item.id === "string" &&
          Array.isArray(item.content)
        ) {
          const completedText = item.content
            .flatMap((contentValue) => {
              const content = record(contentValue);
              if (content?.type === "output_text" && typeof content.text === "string") {
                return [content.text];
              }
              if (content?.type === "audio" && typeof content.transcript === "string") {
                return [content.transcript];
              }
              return [];
            })
            .join("");
          reportTranscript("assistant", item.id, completedText);
        }
      }
      reportRealtimeUsage(event);
      if (!output.some((item) => record(item)?.type === "function_call")) {
        transition(muted ? "muted" : "listening");
      }
      return;
    }
    if (event.type === "response.output_audio.done") {
      transition(muted ? "muted" : "listening");
      return;
    }
    if (event.type === "error") {
      await failActiveSession("live-session-rejected", "OpenAI Realtime reported a session error.");
    }
  }

  function listen(target: EventTarget, type: string, listener: EventListener): RemoveListener {
    target.addEventListener(type, listener);
    let active = true;
    const remove = () => {
      if (!active) return;
      active = false;
      target.removeEventListener(type, listener);
      listeners.delete(remove);
    };
    listeners.add(remove);
    publish();
    return remove;
  }

  function schedule(callback: () => void, milliseconds: number): number {
    const handle = environment.setTimeout(() => {
      timers.delete(handle);
      callback();
    }, milliseconds);
    timers.add(handle);
    publish();
    return handle;
  }

  function clearScheduled(handle: number): void {
    environment.clearTimeout(handle);
    timers.delete(handle);
  }

  function registerPeerConnection(peerConnection: RTCPeerConnection): void {
    peerConnections.add(peerConnection);
    const onConnectionStateChange = () => {
      publish();
      if (
        peerConnection.connectionState === "failed" &&
        !operationAbortController?.signal.aborted
      ) {
        void failActiveSession(
          "peer-connection-failed",
          liveMode
            ? "The OpenAI Realtime peer connection failed."
            : "The local browser voice loopback connection failed.",
        );
      }
    };
    listen(peerConnection, "connectionstatechange", onConnectionStateChange);
  }

  function registerTrack(track: MediaStreamTrack): void {
    ownedTracks.add(track);
    const onEnded = () => {
      if (localStream?.getAudioTracks().includes(track)) localAudioTrackState = "ended";
      publish();
      if (!operationAbortController?.signal.aborted) void stop("track-ended");
    };
    listen(track, "ended", onEnded);
  }

  function registerRemoteStream(stream: MediaStream): void {
    remoteStreams.add(stream);
    for (const track of stream.getTracks()) registerTrack(track);
    if (!environment.createAudioElement) return;
    if (!audioElement) {
      audioElement = environment.createAudioElement();
      audioElement.autoplay = true;
      audioElement.muted = !liveMode;
      audioElement.setAttribute("playsinline", "");
      audioElement.dataset.beaVoiceMode = liveMode ? "openai-realtime" : "local-loopback";
      audioElement.hidden = true;
      environment.appendAudioElement?.(audioElement);
    }
    audioElement.srcObject = stream;
    audioElementState = "attached";
    void audioElement.play().catch(() => undefined);
    publish();
  }

  function registerDataChannel(dataChannel: RTCDataChannel): void {
    dataChannels.add(dataChannel);
    activeDataChannel = dataChannel;
    listen(dataChannel, "message", ((event: Event) => {
      void handleRealtimeServerEvent((event as MessageEvent<unknown>).data);
    }) as EventListener);
    listen(dataChannel, "open", () => publish());
    listen(dataChannel, "close", () => {
      publish();
      if (!operationAbortController?.signal.aborted && state !== "idle" && state !== "stopping") {
        void failActiveSession(
          "peer-connection-failed",
          "The OpenAI Realtime data channel closed unexpectedly.",
        );
      }
    });
    listen(dataChannel, "error", () => {
      if (!operationAbortController?.signal.aborted) {
        void failActiveSession(
          "peer-connection-failed",
          "The OpenAI Realtime data channel failed.",
        );
      }
    });
    publish();
  }

  function waitForDataChannelOpen(signal: AbortSignal): Promise<void> {
    if (!liveMode) return Promise.resolve();
    const channel = activeDataChannel;
    if (!channel) return Promise.reject(new BrowserVoiceLiveSessionError());
    if (channel.readyState === "open") return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      let timeout = 0;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        removeOpen();
        removeClose();
        removeAbort();
        clearScheduled(timeout);
        if (error) reject(error);
        else resolve();
      };
      const removeOpen = listen(channel, "open", () => finish());
      const removeClose = listen(channel, "close", () =>
        finish(new BrowserVoiceLiveSessionError()),
      );
      const removeAbort = listen(signal, "abort", () => finish(abortError()));
      timeout = schedule(() => finish(new BrowserVoiceLiveSessionError()), connectionTimeoutMs);
    });
  }

  function waitForIceGathering(
    peerConnection: RTCPeerConnection,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError());
    if (peerConnection.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      let timeout = 0;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        removeStateListener();
        removeAbortListener();
        clearScheduled(timeout);
        if (error) reject(error);
        else resolve();
      };
      const removeStateListener = listen(peerConnection, "icegatheringstatechange", () => {
        if (peerConnection.iceGatheringState === "complete") finish();
      });
      const removeAbortListener = listen(signal, "abort", () => finish(abortError()));
      timeout = schedule(
        () => finish(new Error("Local loopback ICE gathering timed out.")),
        connectionTimeoutMs,
      );
    });
  }

  function waitForConnected(signal: AbortSignal): Promise<void> {
    const requiredPeerConnections = liveMode ? 1 : 2;
    const connected = () =>
      peerConnections.size >= requiredPeerConnections &&
      [...peerConnections].every((peerConnection) =>
        ["connected", "completed"].includes(peerConnection.connectionState),
      );
    if (connected()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      let timeout = 0;
      const removers: RemoveListener[] = [];
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        for (const remove of removers) remove();
        clearScheduled(timeout);
        if (error) reject(error);
        else resolve();
      };
      const onState = () => {
        if (
          [...peerConnections].some((peerConnection) => peerConnection.connectionState === "failed")
        ) {
          finish(new Error("Browser voice peer connection failed."));
        } else if (connected()) finish();
      };
      for (const peerConnection of peerConnections) {
        removers.push(listen(peerConnection, "connectionstatechange", onState));
      }
      removers.push(listen(signal, "abort", () => finish(abortError())));
      timeout = schedule(
        () => finish(new Error("Browser voice connection timed out.")),
        connectionTimeoutMs,
      );
      onState();
    });
  }

  async function startSpeechAnalysis(stream: MediaStream, signal: AbortSignal): Promise<void> {
    audioContext ??= environment.createAudioContext?.();
    if (!audioContext) return;
    let resumeTimeout = 0;
    const resume =
      audioContext.state === "suspended"
        ? audioContext.resume().catch(() => undefined)
        : Promise.resolve();
    let removeAbortListener: RemoveListener | undefined;
    try {
      await Promise.race([
        resume,
        new Promise<void>((resolve) => {
          resumeTimeout = schedule(resolve, 1_000);
        }),
        new Promise<never>((_resolve, reject) => {
          removeAbortListener = listen(signal, "abort", () => reject(abortError()));
        }),
      ]);
    } finally {
      removeAbortListener?.();
      clearScheduled(resumeTimeout);
    }
    assertNotAborted(signal);
    audioSource = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    audioSource.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const inspect = () => {
      if (!analyser || operationAbortController?.signal.aborted) {
        animationFrame = undefined;
        publish();
        return;
      }
      analyser.getByteTimeDomainData(samples);
      let energy = 0;
      for (const sample of samples) {
        const normalized = (sample - 128) / 128;
        energy += normalized * normalized;
      }
      const rms = Math.sqrt(energy / samples.length);
      transition(rms >= speakingThreshold ? "user-speaking" : "listening");
      animationFrame = environment.requestAnimationFrame(inspect);
      publish();
    };
    animationFrame = environment.requestAnimationFrame(inspect);
    publish();
  }

  function releaseResources(
    reason: BrowserVoiceStopReason,
    finalState: "error" | "idle",
  ): Promise<BrowserVoiceSnapshot> {
    if (cleanupPromise) return cleanupPromise;
    cleanupComplete = false;
    stopReason = reason;
    if (liveMode && liveSession && !terminalEventReported) {
      terminalEventReported = true;
      const failed =
        finalState === "error" ||
        reason === "peer-connection-failed" ||
        reason === "start-failed" ||
        reason === "track-ended";
      const terminalType = failed
        ? "failed"
        : reason === "user-cancelled"
          ? "cancelled"
          : "completed";
      void reportLiveEvent(
        terminalType,
        failed ? { errorCode: "REALTIME_SESSION_FAILED" } : {},
        true,
      ).catch(() => undefined);
    }
    if (reason === "component-unmount" || reason === "pagehide") {
      environment.clearTestAuthorization?.();
    }
    if (finalState === "idle") transition("stopping");
    operationAbortController?.abort();
    operationAbortController = undefined;
    for (const controller of pendingRequestControllers) controller.abort();
    pendingRequestControllers.clear();
    if (animationFrame !== undefined) {
      environment.cancelAnimationFrame(animationFrame);
      animationFrame = undefined;
    }
    for (const handle of [...timers]) clearScheduled(handle);
    pendingNarrationTimers.clear();
    if (sessionExpiryHandle !== undefined) {
      clearScheduled(sessionExpiryHandle);
      sessionExpiryHandle = undefined;
    }
    for (const remove of [...listeners]) remove();
    try {
      audioSource?.disconnect();
    } catch {}
    try {
      analyser?.disconnect();
    } catch {}
    audioSource = undefined;
    analyser = undefined;
    const closingAudioContext = audioContext;
    audioContext = undefined;
    if (closingAudioContext) {
      try {
        void closingAudioContext.close().catch(() => undefined);
      } catch {}
    }
    if (audioElement) {
      try {
        audioElement.pause();
        audioElement.srcObject = null;
        audioElement.removeAttribute("src");
        audioElement.load();
        audioElement.remove();
      } catch {}
      audioElement = undefined;
      audioElementState = "released";
    }
    for (const dataChannel of dataChannels) {
      try {
        dataChannel.close();
      } catch {}
    }
    dataChannels.clear();
    activeDataChannel = undefined;
    for (const peerConnection of peerConnections) {
      for (const sender of peerConnection.getSenders()) {
        try {
          void sender.replaceTrack(null).catch(() => undefined);
        } catch {}
      }
    }
    for (const track of ownedTracks) {
      try {
        track.stop();
      } catch {}
    }
    localAudioTrackState = localAudioTrackState === "none" ? "none" : "ended";
    ownedTracks.clear();
    localStream = undefined;
    remoteStreams.clear();
    for (const peerConnection of peerConnections) {
      try {
        peerConnection.close();
      } catch {}
    }
    lastPeerConnectionStates = [...peerConnections].map(() => "closed");
    peerConnections.clear();
    providerConnected = false;
    liveSession = undefined;
    muted = false;
    cyclesCompleted = Math.min(cyclesStarted, cyclesCompleted + 1);
    cleanupComplete = true;
    const finalSnapshot = transition(
      finalState === "idle" && liveMode ? "disconnected" : finalState,
    );
    const pending = Promise.resolve(finalSnapshot);
    cleanupPromise = pending;
    void pending.finally(() => {
      if (cleanupPromise === pending) cleanupPromise = undefined;
    });
    return pending;
  }

  async function failActiveSession(
    code: BrowserVoiceErrorCode,
    message: string,
  ): Promise<BrowserVoiceSnapshot> {
    operation += 1;
    errorCode = code;
    safeError = message;
    return releaseResources("peer-connection-failed", "error");
  }

  async function start(): Promise<BrowserVoiceSnapshot> {
    if (disposed) return snapshot();
    if (
      state === "authorizing" ||
      state === "requesting-permission" ||
      state === "connecting" ||
      state === "listening" ||
      state === "user-speaking" ||
      state === "processing" ||
      state === "assistant-speaking" ||
      state === "interrupted" ||
      state === "muted" ||
      state === "reconnecting"
    ) {
      return snapshot();
    }
    if (cleanupPromise) await cleanupPromise;
    const startOperation = operation + 1;
    operation = startOperation;
    operationAbortController = new AbortController();
    const signal = operationAbortController.signal;
    errorCode = undefined;
    safeError = undefined;
    stopReason = undefined;
    cleanupComplete = false;
    localAudioTrackState = "none";
    lastPeerConnectionStates = [];
    audioElementState = "none";
    stateHistory = ["idle"];
    transcript = "";
    userTranscript = "";
    assistantTranscript = "";
    muted = false;
    interactionMode = "automatic";
    allowInterruption = true;
    toolCallsCompleted = 0;
    externalProviderCalls = 0;
    providerConnected = false;
    liveSession = undefined;
    terminalEventReported = false;
    handledToolCalls.clear();
    reportedTranscripts.clear();
    reportedUsageResponses.clear();
    cyclesStarted += 1;
    transition("authorizing");
    if (environment.pageLifecycleTarget) {
      listen(environment.pageLifecycleTarget, "pagehide", () => void stop("pagehide"));
    }
    try {
      if (eventContractOnly) {
        liveSession = {
          beaSessionId: "10000000-0000-4000-8000-000000000021",
          model: "deterministic-demo-router",
          voice: "demo",
          startedAt: currentTimeMs(),
        };
        transition("listening");
        const authorizedAtMs = currentTimeMs();
        sessionExpiryHandle = schedule(() => {
          if (currentTimeMs() - authorizedAtMs >= sessionMaxAgeMs) void expireSession();
        }, sessionMaxAgeMs);
        return publish();
      }
      audioContext = environment.createAudioContext?.();
      if (audioContext?.state === "suspended") {
        void audioContext.resume().catch(() => undefined);
      }
      const authorizeSession = liveMode
        ? environment.authorizeLiveSession
        : environment.authorizeTestSession;
      if (!authorizeSession) throw new BrowserVoiceLiveAuthorizationError();
      let authorization = await authorizeSession(signal);
      if (operation !== startOperation || signal.aborted) return snapshot();
      if (authorization.requested) authorizationRequests += 1;
      if (liveMode) {
        const liveAuthorization = authorization.liveAuthorization;
        if (!liveAuthorization) throw new BrowserVoiceLiveAuthorizationError();
        interactionMode = liveAuthorization.interactionMode;
        allowInterruption = liveAuthorization.allowInterruption;
        liveSession = {
          beaSessionId: liveAuthorization.beaSessionId,
          ...(liveAuthorization.providerSessionId
            ? { providerSessionId: liveAuthorization.providerSessionId }
            : {}),
          model: liveAuthorization.model,
          voice: liveAuthorization.voice,
          startedAt: Date.now(),
        };
      }
      publish();
      assertNotAborted(signal);
      if (
        !environment.getUserMedia ||
        !environment.createPeerConnection ||
        !environment.createMediaStream
      ) {
        errorCode = "browser-media-unsupported";
        safeError = liveMode
          ? "This browser does not provide the media APIs required for live Realtime voice."
          : "This browser does not provide the media APIs required for voice TEST MODE.";
        operation += 1;
        return releaseResources("start-failed", "error");
      }
      transition("requesting-permission");
      const captured = await environment.getUserMedia({ audio: true });
      if (operation !== startOperation || signal.aborted) {
        for (const track of captured.getTracks()) track.stop();
        localAudioTrackState = "ended";
        return publish();
      }
      localStream = captured;
      const audioTracks = captured.getAudioTracks();
      const liveAudioTracks = audioTracks.filter((track) => track.readyState === "live");
      if (liveAudioTracks.length === 0) {
        throw new DOMException("No audio track was returned.", "NotFoundError");
      }
      for (const track of captured.getTracks()) registerTrack(track);
      if (liveMode && interactionMode === "push_to_talk") {
        for (const track of liveAudioTracks) track.enabled = false;
        muted = true;
      }
      localAudioTrackState = "live";
      const outbound = environment.createPeerConnection();
      registerPeerConnection(outbound);
      for (const track of liveAudioTracks) attachRealtimeAudioTrack(outbound, track, captured);
      transition("connecting");
      await signalingBoundary.negotiate({
        outboundPeerConnection: outbound,
        localStream: captured,
        signal,
        authorization,
        createPeerConnection: environment.createPeerConnection,
        createMediaStream: environment.createMediaStream,
        registerPeerConnection(peerConnection) {
          if (operation !== startOperation || signal.aborted) {
            try {
              peerConnection.close();
            } catch {}
            return;
          }
          registerPeerConnection(peerConnection);
        },
        registerRemoteStream(stream) {
          if (operation !== startOperation || signal.aborted) {
            for (const track of stream.getTracks()) {
              try {
                track.stop();
              } catch {}
            }
            return;
          }
          registerRemoteStream(stream);
        },
        registerDataChannel(dataChannel) {
          if (operation !== startOperation || signal.aborted) {
            try {
              dataChannel.close();
            } catch {}
            return;
          }
          registerDataChannel(dataChannel);
        },
        recordExternalProviderCall() {
          externalProviderCalls += 1;
          publish();
        },
        listen(target, type, listener) {
          if (operation !== startOperation || signal.aborted) return () => undefined;
          return listen(target, type, listener);
        },
        waitForIceGathering: (peerConnection) => waitForIceGathering(peerConnection, signal),
      });
      authorization = {
        requested: authorization.requested,
        authorizedUntil: authorization.authorizedUntil,
      };
      assertNotAborted(signal);
      await waitForConnected(signal);
      assertNotAborted(signal);
      await waitForDataChannelOpen(signal);
      assertNotAborted(signal);
      if (liveMode) {
        try {
          await reportLiveEvent("connected", {
            ...(liveSession?.providerSessionId
              ? { providerSessionId: liveSession.providerSessionId }
              : {}),
          });
        } catch {
          throw new BrowserVoiceLiveSessionError();
        }
        providerConnected = true;
      }
      transition(muted ? "muted" : "listening");
      const authorizedAtMs = currentTimeMs();
      sessionExpiryHandle = schedule(() => {
        if (currentTimeMs() - authorizedAtMs >= sessionMaxAgeMs) void expireSession();
      }, sessionMaxAgeMs);
      if (!liveMode) await startSpeechAnalysis(captured, signal);
      return publish();
    } catch (error) {
      if (operation !== startOperation || signal.aborted) return snapshot();
      const failure = classifyStartError(error);
      errorCode = failure.code;
      safeError = failure.message;
      operation += 1;
      return releaseResources("start-failed", "error");
    }
  }

  async function stop(
    reason: BrowserVoiceStopReason = "user-stopped",
  ): Promise<BrowserVoiceSnapshot> {
    if (cleanupPromise) return cleanupPromise;
    operation += 1;
    if ((state === "idle" || state === "disconnected") && cleanupComplete) {
      stopReason = reason;
      return publish();
    }
    return releaseResources(reason, "idle");
  }

  function setMuted(nextMuted: boolean): BrowserVoiceSnapshot {
    muted = nextMuted;
    for (const track of localStream?.getAudioTracks() ?? []) track.enabled = !nextMuted;
    if (providerConnected) transition(nextMuted ? "muted" : "listening");
    return publish();
  }

  async function expireSession(): Promise<BrowserVoiceSnapshot> {
    operation += 1;
    notifyRealtime({
      type: "session.expired",
      sessionId: liveSession?.beaSessionId ?? null,
    });
    errorCode = liveMode ? "live-session-rejected" : "peer-connection-failed";
    safeError = "The Realtime session reached the application maximum duration.";
    return releaseResources("session-expired", "idle");
  }

  function requestNarrationSegment(input: NarrationSegmentRequest): boolean {
    if (liveMode) {
      if (!providerConnected) return false;
      return sendDataChannelEvent({
        type: "response.create",
        response: {
          modalities: ["audio"],
          instructions: input.instructions.slice(0, 4_000),
          metadata: {
            presentationRunId: input.presentationRunId,
            narrationSegmentId: input.narrationSegmentId,
            visualElementId: input.visualElementId,
          },
        },
      });
    }
    const connected =
      state === "listening" ||
      state === "processing" ||
      state === "assistant-speaking" ||
      state === "interrupted" ||
      state === "muted" ||
      state === "user-speaking";
    if (!connected) return false;
    testNarrationSequence += 1;
    const responseId = `test-narration-${testNarrationSequence}`;
    const startHandle = schedule(() => {
      pendingNarrationTimers.delete(startHandle);
      void handleRealtimeServerEvent(
        JSON.stringify({
          type: "response.created",
          response: { id: responseId },
        }),
      );
      void handleRealtimeServerEvent(
        JSON.stringify({
          type: "response.output_audio.delta",
          response_id: responseId,
          delta: "AA==",
        }),
      );
    }, testAudioStartDelayMs);
    pendingNarrationTimers.add(startHandle);
    const doneHandle = schedule(() => {
      pendingNarrationTimers.delete(doneHandle);
      void handleRealtimeServerEvent(
        JSON.stringify({
          type: "response.output_audio.done",
          response_id: responseId,
        }),
      );
      void handleRealtimeServerEvent(
        JSON.stringify({
          type: "response.done",
          response: { id: responseId, output: [] },
        }),
      );
    }, testAudioCompleteDelayMs);
    pendingNarrationTimers.add(doneHandle);
    return true;
  }

  function clearPendingOutput(): BrowserVoiceSnapshot {
    clearPendingNarrationTimers();
    sendDataChannelEvent({ type: "output_audio_buffer.clear" });
    notifyRealtime({
      type: "output_audio_buffer.cleared",
      sessionId: liveSession?.beaSessionId ?? null,
    });
    return publish();
  }

  function sessionAllowsInterrupt(): boolean {
    return (
      state === "listening" ||
      state === "user-speaking" ||
      state === "processing" ||
      state === "assistant-speaking" ||
      state === "interrupted" ||
      state === "muted"
    );
  }

  function interrupt(): BrowserVoiceSnapshot {
    if (!sessionAllowsInterrupt()) return publish();
    clearPendingNarrationTimers();
    sendDataChannelEvent({ type: "response.cancel" });
    sendDataChannelEvent({ type: "output_audio_buffer.clear" });
    notifyRealtime({
      type: "response.cancelled",
      sessionId: liveSession?.beaSessionId ?? null,
    });
    notifyRealtime({
      type: "output_audio_buffer.cleared",
      sessionId: liveSession?.beaSessionId ?? null,
    });
    return transition("interrupted");
  }

  async function reconnect(): Promise<BrowserVoiceSnapshot> {
    if (disposed || !liveMode) return snapshot();
    transition("reconnecting");
    await stop("user-stopped");
    return start();
  }

  function beginPushToTalk(): BrowserVoiceSnapshot {
    if (!liveMode || !providerConnected || interactionMode !== "push_to_talk") return snapshot();
    clearPendingNarrationTimers();
    sendDataChannelEvent({ type: "response.cancel" });
    sendDataChannelEvent({ type: "output_audio_buffer.clear" });
    notifyRealtime({
      type: "response.cancelled",
      sessionId: liveSession?.beaSessionId ?? null,
    });
    notifyRealtime({
      type: "output_audio_buffer.cleared",
      sessionId: liveSession?.beaSessionId ?? null,
    });
    for (const track of localStream?.getAudioTracks() ?? []) track.enabled = true;
    muted = false;
    return transition("user-speaking");
  }

  function endPushToTalk(): BrowserVoiceSnapshot {
    if (!liveMode || !providerConnected || interactionMode !== "push_to_talk") return snapshot();
    for (const track of localStream?.getAudioTracks() ?? []) track.enabled = false;
    muted = true;
    sendDataChannelEvent({ type: "input_audio_buffer.commit" });
    sendDataChannelEvent({ type: "response.create" });
    return transition("processing");
  }

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    await stop("component-unmount");
    subscribers.clear();
    realtimeListeners.clear();
  }

  return {
    start,
    stop,
    dispose,
    setMuted,
    interrupt,
    clearPendingOutput,
    requestNarrationSegment,
    reconnect,
    beginPushToTalk,
    endPushToTalk,
    getSnapshot: snapshot,
    subscribe(listener) {
      subscribers.add(listener);
      listener(snapshot());
      return () => subscribers.delete(listener);
    },
    subscribeRealtimeEvents(listener) {
      realtimeListeners.add(listener);
      return () => realtimeListeners.delete(listener);
    },
  };
}
