"use client";

import { Alert, Badge, Button, ConfirmationDialog, useMotionPreferences } from "@bea/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type UIEvent,
  type WheelEvent,
} from "react";

import styles from "@/components/ai-command.module.css";
import { OpenAiAdministrationPanel } from "@/components/openai-administration-panel";
import { WorkspaceRenderer } from "@/components/workspace-renderer";
import {
  AI_COMMAND_CLIENT_ENDPOINTS,
  consumeAiCommandEventStream,
  validateAiToolProposal,
  type AiCommandInputMode,
  type AiCommandStreamEvent,
  type AiRealtimeUiSnapshot,
} from "@/lib/ai-command-client";
import type { AiCommandErrorBody, AiCommandSnapshot } from "@/lib/ai-command-contracts";
import {
  isAiCommandWorkspacePath,
  parseAiCommandWorkspacePath,
} from "@/lib/ai-command-workspace-paths";
import { parsePresentationFromPayload, isFollowUpAboutSelection } from "@bea/ai/presentation";
import type { AiSafeWorkspaceSelection } from "@bea/domain";
import {
  BROWSER_VOICE_LIVE_MODE,
  BROWSER_VOICE_TEST_MODE,
  createBrowserRealtimeVoiceAdapter,
  type BrowserRealtimeVoiceAdapter,
  type BrowserRealtimeVoiceAdapterOptions,
  type BrowserVoiceSnapshot,
} from "@/lib/browser-realtime-voice";
import {
  createPresentationNarrationController,
  isRealtimeVoiceConnected,
  type PresentationNarrationController,
} from "@/lib/presentation-narration-controller";
import { attachProgrammaticScroll, isProgrammaticScrollActive } from "@/lib/programmatic-scroll";
import { safeInternalHref } from "@/lib/safe-return-path";
import { useHydrated } from "@/lib/use-hydrated";

export type AiOrbState =
  | "idle"
  | "connecting"
  | "listening"
  | "user-speaking"
  | "transcribing"
  | "researching"
  | "thinking"
  | "presenting"
  | "speaking"
  | "awaiting-confirmation"
  | "executing"
  | "success"
  | "error"
  | "interrupted"
  | "disconnected"
  | "offline";

export type AiInteractionMode = "voice" | "type";

export const AI_ORB_STATE_LABELS: Readonly<Record<AiOrbState, string>> = {
  idle: "Ready",
  connecting: "Connecting",
  listening: "Listening",
  "user-speaking": "User speaking",
  transcribing: "Preparing transcript",
  researching: "Researching",
  thinking: "Thinking",
  presenting: "Presenting",
  speaking: "Speaking",
  "awaiting-confirmation": "Awaiting confirmation",
  executing: "Executing approved action",
  success: "Action complete",
  error: "Action could not be completed",
  interrupted: "Interrupted",
  disconnected: "Disconnected",
  offline: "Offline or unavailable",
};

const DEFAULT_AI_PANE_PERCENT = 36;
const MIN_AI_PANE_PERCENT = 28;
const MAX_AI_PANE_PERCENT = 55;
const KEYBOARD_RESIZE_STEP = 2;
const KEYBOARD_RESIZE_LARGE_STEP = 5;
const WORKSPACE_EXIT_MS = 160;
const CONFIRM_FOCUS_SETTLE_MS = 220;
const VOICE_LISTENING_MS = 2_000;
const VOICE_TRANSCRIBING_MS = 350;
const TRANSCRIPT_NEAR_BOTTOM_PX = 72;
// 500ms parent enter and the longest 420ms + four 54ms child stagger both finish by 636ms.
const WORKSPACE_ENTER_SETTLE_MS = 680;
const ARTIFACT_UPLOAD_ACCEPT =
  ".pdf,.csv,.xlsx,.txt,.docx,.png,.jpg,.jpeg,.webp,application/pdf,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/png,image/jpeg,image/webp";
const STORED_ARTIFACT_ID_PATTERN = /^art_[a-f0-9]{32}$/u;
const UPLOAD_RENDERERS = new Set(["pdf", "image", "data"]);
const BUILT_IN_PROVIDER_TOOL_NAMES = new Set([
  "web_search",
  "code_interpreter",
  "image_generation",
]);
const REGISTERED_BEA_TOOL_NAMES = new Set([
  "bea_research",
  "bea_analyze",
  "bea_create_chart",
  "bea_create_table",
  "bea_create_board",
  "bea_create_pdf",
  "bea_create_image",
  "bea_open_artifact",
  "bea_list_artifacts",
  "bea_download_artifact",
  "bea_revise_artifact",
]);
const PROVIDER_TOOL_STATUSES = new Set([
  "proposed",
  "validated",
  "rejected",
  "completed",
  "failed",
]);
const LIVE_STREAM_FALLBACK_BLOCKED_MESSAGE =
  "The live OpenAI response route is unavailable. No test-provider fallback was used.";

type WorkspaceTransition = "settled" | "processing" | "exiting" | "entering";
interface OptimisticMessage {
  readonly content: string;
  readonly createdAt: string;
  readonly generation: number;
}

interface AiRequestReservation {
  readonly requestId: string;
  readonly generation: number;
}

interface StreamingAssistantMessage {
  readonly citations: readonly Record<string, unknown>[];
  readonly content: string;
  readonly fileSources: readonly Record<string, unknown>[];
  readonly generatedArtifacts: readonly Record<string, unknown>[];
  readonly generation: number;
  readonly status: "starting" | "streaming" | "partial" | "cancelled" | "completed" | "error";
  readonly toolCalls: readonly Record<string, unknown>[];
}

interface ValidatedToolProposal {
  readonly id: string;
  readonly name: string;
  readonly source: "application" | "provider";
  readonly status: "validating" | "validated" | "rejected" | "proposed" | "completed" | "failed";
}

interface PendingUpload {
  readonly artifactId: string;
  readonly filename: string;
  readonly manifest: Record<string, unknown>;
  readonly mediaType: string;
  readonly size: number;
}

function clampPanePercent(value: number): number {
  return Math.min(MAX_AI_PANE_PERCENT, Math.max(MIN_AI_PANE_PERCENT, value));
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function usesPdfWorkspaceScroller(artifact: AiCommandSnapshot["artifact"]): boolean {
  const payload = artifact.payload as Record<string, unknown>;
  const renderer = typeof payload.renderer === "string" ? payload.renderer : "";
  const mimeType =
    typeof payload.mimeType === "string"
      ? payload.mimeType
      : isRecord(payload.file) && typeof payload.file.mimeType === "string"
        ? payload.file.mimeType
        : "";
  return renderer === "pdf" || renderer === "pdf-preview" || mimeType === "application/pdf";
}

function safeMessageHref(value: unknown): string | null {
  const internal = safeInternalHref(value);
  if (internal) return internal;
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function snapshotWorkspacePath(artifact: AiCommandSnapshot["artifact"]): string {
  const payload = artifact.payload as Record<string, unknown>;
  const record = isRecord(payload.record) ? payload.record : payload;
  const recordHref = typeof record.href === "string" ? record.href : "";
  const parsed = parseAiCommandWorkspacePath(recordHref);
  if (parsed) return parsed.path;
  const firstLink = artifact.links.find((link) => isAiCommandWorkspacePath(link.href));
  if (firstLink) return parseAiCommandWorkspacePath(firstLink.href)?.path ?? firstLink.href;
  switch (artifact.type) {
    case "company-list":
      return "/companies";
    case "company-detail":
      return "/companies";
    case "contact-list":
      return "/contacts";
    case "contact-detail":
      return "/contacts";
    case "lead-list":
      return "/leads";
    case "lead-detail":
      return "/leads";
    case "task-list":
      return "/tasks";
    case "task-detail":
      return "/tasks";
    case "activity-timeline":
      return "/activities";
    case "notification-list":
      return "/notifications";
    case "workflow-run-list":
    case "workflow-run-detail":
      return "/workflow-runs";
    case "integration-health-summary":
    case "integration-detail":
      return "/integrations";
    default:
      return "";
  }
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1_000))} KB`;
  return `${(bytes / 1_000_000).toFixed(bytes >= 10_000_000 ? 0 : 1)} MB`;
}

async function readSnapshot(response: Response): Promise<AiCommandSnapshot> {
  const body = (await response.json()) as AiCommandSnapshot | AiCommandErrorBody;
  if (!response.ok || !("conversation" in body)) {
    throw new Error(
      "error" in body && body.error?.message
        ? body.error.message
        : `AI Command request failed with status ${response.status}.`,
    );
  }
  return body;
}

async function readReservation(response: Response): Promise<AiRequestReservation> {
  const body = (await response.json()) as
    AiRequestReservation | AiCommandErrorBody | Record<string, unknown>;
  if (
    !response.ok ||
    !("requestId" in body) ||
    typeof body.requestId !== "string" ||
    !("generation" in body) ||
    typeof body.generation !== "number" ||
    !Number.isSafeInteger(body.generation) ||
    body.generation < 1
  ) {
    throw new Error(
      "error" in body &&
        typeof body.error === "object" &&
        body.error !== null &&
        "message" in body.error &&
        typeof body.error.message === "string"
        ? body.error.message
        : `AI Command request reservation failed with status ${response.status}.`,
    );
  }
  return { requestId: body.requestId, generation: body.generation };
}

function replaceConversationUrl(conversationId: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("conversation", conversationId);
  window.history.replaceState(null, "", url);
}

function providerText(provider: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = provider[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function requiresDeterministicJsonRoute(message: string): boolean {
  const normalized = message.replace(/\s+/gu, " ").trim();
  return (
    /\bcreate\b.*\btask\b/iu.test(normalized) ||
    /\b(?:what can i do|help|capabilities)\b/iu.test(normalized) ||
    /\b(?:today'?s priorities|priorities today|command center summary)\b/iu.test(normalized) ||
    /\b(?:overdue tasks?|open tasks?|unread notifications?|recent activity)\b/iu.test(normalized) ||
    /\b(?:connector|integration) health\b/iu.test(normalized) ||
    /\b(?:systems?|connectors?|integrations?)\b.*\b(?:not connected|disconnected)\b/iu.test(
      normalized,
    ) ||
    /\b(?:open|show|recent|latest)\b.*\bworkflow runs?\b/iu.test(normalized) ||
    /(?:show|list|find)\s+contacts\s+(?:for|at|with)\s+/iu.test(normalized) ||
    /\b(?:show|list)\s+(?:all\s+)?companies\b/iu.test(normalized) ||
    /^(?:open|show)\s+(?:company\s+)?/iu.test(normalized) ||
    /\b(?:show|list|open)\b.*\b(?:lead review queue|review queue|leads)\b/iu.test(normalized) ||
    /\b(?:leads? that (?:still )?need (?:information|info)|blocked leads)\b/iu.test(normalized) ||
    /(?:open|show|summarize|retrieve)\s+lead\s+/iu.test(normalized) ||
    /(?:what is missing|missing information)\s+(?:on|for|about)\s+(?:lead\s+)?/iu.test(
      normalized,
    ) ||
    /\b(?:search the (?:public )?web|web search|latest information relevant|research the latest information)\b/iu.test(
      normalized,
    ) ||
    /\b(?:explain this|tell me more|why does this matter|what does this (?:source|mean)|compare this|what would you recommend|how does this affect|this (?:one|source|lead)|full record)\b/iu.test(
      normalized,
    )
  );
}

export function MotionAiCommandWorkspace({
  initialSnapshot,
  browserMediaTestMode = false,
  createVoiceAdapter = createBrowserRealtimeVoiceAdapter,
}: {
  initialSnapshot: AiCommandSnapshot;
  browserMediaTestMode?: boolean;
  createVoiceAdapter?: (options: BrowserRealtimeVoiceAdapterOptions) => BrowserRealtimeVoiceAdapter;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const { pageVisible, profile: motionProfile } = useMotionPreferences();
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [displayedArtifact, setDisplayedArtifact] = useState(initialSnapshot.artifact);
  const displayedArtifactUsesPdfScroller = usesPdfWorkspaceScroller(displayedArtifact);
  const [workspaceTransition, setWorkspaceTransition] = useState<WorkspaceTransition>("settled");
  const [composer, setComposer] = useState("");
  const [composerInputMode, setComposerInputMode] = useState<AiCommandInputMode>("text");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [activePanel, setActivePanel] = useState<"conversation" | "workspace">("conversation");
  const [interactionMode, setInteractionMode] = useState<AiInteractionMode>("type");
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [voiceState, setVoiceState] = useState<"idle" | "listening" | "transcribing" | "review">(
    "idle",
  );
  const [voiceTranscript, setVoiceTranscript] = useState("");
  const [speakResponses, setSpeakResponses] = useState(
    initialSnapshot.provider.speakResponses !== false,
  );
  const [voicePreferenceBusy, setVoicePreferenceBusy] = useState(false);
  const [confirmActionId, setConfirmActionId] = useState<string>();
  const [actionSucceeded, setActionSucceeded] = useState(false);
  const [responding, setResponding] = useState(false);
  const [online, setOnline] = useState(true);
  const [optimisticMessage, setOptimisticMessage] = useState<OptimisticMessage>();
  const [streamingAssistant, setStreamingAssistant] = useState<StreamingAssistantMessage>();
  const [validatedTools, setValidatedTools] = useState<readonly ValidatedToolProposal[]>([]);
  const [webSearchEnabled, setWebSearchEnabled] = useState(
    initialSnapshot.provider.webSearchDefault === true,
  );
  const [codeAnalysisEnabled, setCodeAnalysisEnabled] = useState(false);
  const [imageGenerationEnabled, setImageGenerationEnabled] = useState(false);
  const [confirmImageGeneration, setConfirmImageGeneration] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [pendingUpload, setPendingUpload] = useState<PendingUpload>();
  const [realtimeUi, setRealtimeUi] = useState<AiRealtimeUiSnapshot>({
    state: "idle",
    transcript: "",
    muted: false,
  });
  const [browserVoice, setBrowserVoice] = useState<BrowserVoiceSnapshot>();
  const [workspaceSelection, setWorkspaceSelection] = useState<AiSafeWorkspaceSelection | null>(
    null,
  );
  const workspaceSelectionRef = useRef<AiSafeWorkspaceSelection | null>(null);
  const selectionPersistGenerationRef = useRef(0);
  const [autoFollow, setAutoFollow] = useState(true);
  const narrationActiveRef = useRef(false);
  const [narrationActive, setNarrationActive] = useState(false);
  const [needsVoiceToHearBriefing, setNeedsVoiceToHearBriefing] = useState(false);
  const [selectionPersistError, setSelectionPersistError] = useState<string>();
  const [activeVisualElementId, setActiveVisualElementId] = useState<string | null>(null);
  const [aiPanePercent, setAiPanePercent] = useState(DEFAULT_AI_PANE_PERCENT);
  const [resizing, setResizing] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const workspaceBodyRef = useRef<HTMLDivElement>(null);
  const commandRef = useRef<HTMLDivElement>(null);
  const orbRef = useRef<HTMLDivElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadControllerRef = useRef<AbortController | undefined>(undefined);
  const uploadGenerationRef = useRef(0);
  const activeConversationIdRef = useRef(initialSnapshot.conversation.id);
  const voiceTimerRef = useRef<number | undefined>(undefined);
  const narrationTimerRef = useRef<number | undefined>(undefined);
  const programmaticWorkspaceScrollRef = useRef(false);
  const programmaticScrollGenerationRef = useRef(0);
  const programmaticScrollTokenRef = useRef<number | null>(null);
  const programmaticScrollSessionRef = useRef<{ cancel: () => void } | null>(null);
  const scrollToNarrationElementRef = useRef<(visualElementId: string) => void>(() => undefined);
  const presentationRunRef = useRef<string | null>(null);
  const narrationControllerRef = useRef<PresentationNarrationController | undefined>(undefined);
  const speakResponsesRef = useRef(speakResponses);
  const voiceWasConnectedRef = useRef(false);
  const needsVoiceRef = useRef(false);
  const autoFollowRef = useRef(true);
  const voiceSessionRef = useRef(false);
  const browserVoiceAdapterRef = useRef<BrowserRealtimeVoiceAdapter | undefined>(undefined);
  const refreshVoiceConversationRef =
    useRef<(conversationId: string) => Promise<void>>(refreshVoiceConversation);
  const voiceRefreshControllerRef = useRef<AbortController | undefined>(undefined);
  const respondingTimerRef = useRef<number | undefined>(undefined);
  const confirmFocusTimerRef = useRef<number | undefined>(undefined);
  const workspaceTimersRef = useRef<number[]>([]);
  const requestControllerRef = useRef<AbortController | undefined>(undefined);
  const requestGenerationRef = useRef(0);
  const reservationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const mountedRef = useRef(true);
  const displayedArtifactRef = useRef(initialSnapshot.artifact);
  const renderedConversationIdRef = useRef(initialSnapshot.conversation.id);
  const transcriptNearBottomRef = useRef(true);
  const transcriptScrollPositionsRef = useRef(new Map<string, number>());
  const workspaceScrollPositionsRef = useRef(new Map<string, number>());
  const transcriptRestoreFrameRef = useRef<number | undefined>(undefined);
  const workspaceRestoreFrameRef = useRef<number | undefined>(undefined);
  const workspaceStatusRef = useRef<HTMLParagraphElement>(null);
  const splitPercentRef = useRef(DEFAULT_AI_PANE_PERCENT);
  const resizeFrameRef = useRef<number | undefined>(undefined);
  const resizePendingRef = useRef<number | undefined>(undefined);
  const splitBoundsRef = useRef<{ readonly left: number; readonly width: number } | undefined>(
    undefined,
  );
  const orbTiltFrameRef = useRef<number | undefined>(undefined);
  const orbTiltPendingRef = useRef<{ readonly x: number; readonly y: number } | undefined>(
    undefined,
  );
  const orbBoundsRef = useRef<
    | {
        readonly left: number;
        readonly top: number;
        readonly width: number;
        readonly height: number;
      }
    | undefined
  >(undefined);
  const splitStorageKey = `bea:ai-pane-percent:v1:${initialSnapshot.actingUser.id}`;
  const interactionStorageKey = `bea:ai-interaction-mode:v1:${initialSnapshot.actingUser.id}`;
  const [workspaceHistory, setWorkspaceHistory] = useState<
    readonly { readonly path: string; readonly artifact: AiCommandSnapshot["artifact"] }[]
  >([
    { path: snapshotWorkspacePath(initialSnapshot.artifact), artifact: initialSnapshot.artifact },
  ]);
  const [workspaceHistoryIndex, setWorkspaceHistoryIndex] = useState(0);
  const workspaceHistoryIndexRef = useRef(0);

  useEffect(() => {
    speakResponsesRef.current = speakResponses;
  }, [speakResponses]);

  useEffect(() => {
    const packet = parsePresentationFromPayload(initialSnapshot.artifact.payload);
    if (!packet) return;
    presentationRunRef.current = packet.presentationRunId;
    autoFollowRef.current = packet.autoFollow;
    narrationActiveRef.current = false;
    const needsVoice = packet.narrationSegments.length > 0;
    needsVoiceRef.current = needsVoice;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      workspaceSelectionRef.current = packet.selected ?? null;
      setWorkspaceSelection(packet.selected ?? null);
      setAutoFollow(packet.autoFollow);
      setNarrationActive(false);
      setNeedsVoiceToHearBriefing(needsVoice);
    });
    return () => {
      cancelled = true;
    };
  }, [
    initialSnapshot.conversation.id,
    initialSnapshot.artifact.id,
    initialSnapshot.artifact.payload,
  ]);

  const orbState: AiOrbState = useMemo(() => {
    if (!online) return "offline";
    if (interactionMode === "voice" && browserVoice) {
      if (
        browserVoice.state === "authorizing" ||
        browserVoice.state === "requesting-permission" ||
        browserVoice.state === "connecting" ||
        browserVoice.state === "stopping" ||
        browserVoice.state === "reconnecting"
      )
        return "connecting";
      if (browserVoice.state === "listening" || browserVoice.state === "muted") return "listening";
      if (browserVoice.state === "user-speaking") return "user-speaking";
      if (browserVoice.state === "processing") return "thinking";
      if (browserVoice.state === "assistant-speaking") return "speaking";
      if (browserVoice.state === "interrupted") return "interrupted";
      if (browserVoice.state === "disconnected") return "disconnected";
      if (browserVoice.state === "error") return "error";
    }
    if (error) return "error";
    if (interactionMode === "voice" && voiceState === "listening") return "listening";
    if (interactionMode === "voice" && voiceState === "transcribing") return "transcribing";
    if (busy && confirmActionId) return "executing";
    if (narrationActive) return "presenting";
    if (
      busy &&
      validatedTools.some(
        (tool) =>
          tool.name === "web_search" && (tool.status === "validated" || tool.status === "proposed"),
      )
    ) {
      return "researching";
    }
    if (responding) return "speaking";
    if (busy) return "thinking";
    if (actionSucceeded) return "success";
    if (displayedArtifact.type === "action-preview") return "awaiting-confirmation";
    return "idle";
  }, [
    actionSucceeded,
    browserVoice,
    busy,
    confirmActionId,
    displayedArtifact.type,
    error,
    interactionMode,
    narrationActive,
    online,
    responding,
    validatedTools,
    voiceState,
  ]);

  function clearWorkspaceTimers() {
    for (const timer of workspaceTimersRef.current) window.clearTimeout(timer);
    workspaceTimersRef.current = [];
  }

  function updatePanePercent(nextValue: number, persist = false) {
    if (!Number.isFinite(nextValue)) return;
    const next = Math.round(clampPanePercent(nextValue) * 10) / 10;
    splitPercentRef.current = next;
    setAiPanePercent(next);
    if (persist) window.localStorage.setItem(splitStorageKey, String(next));
  }

  useEffect(() => {
    const liveConnected = snapshot.provider.liveConnected === true;
    const conversationId = snapshot.conversation.id;
    const adapter = createVoiceAdapter(
      liveConnected
        ? {
            mode: "live",
            conversationId,
            onWorkspaceUpdated: () => refreshVoiceConversationRef.current(conversationId),
          }
        : {
            conversationId,
            eventContractOnly: !browserMediaTestMode,
          },
    );
    browserVoiceAdapterRef.current = adapter;
    const controller = createPresentationNarrationController({
      adapter,
      onState(next) {
        narrationActiveRef.current = next.narrationActive;
        setNarrationActive(next.narrationActive);
        setActiveVisualElementId(next.activeVisualElementId);
        setNeedsVoiceToHearBriefing(next.needsVoiceToHearBriefing);
        needsVoiceRef.current = next.needsVoiceToHearBriefing;
        if (next.narrationActive && autoFollowRef.current && next.activeVisualElementId) {
          scrollToNarrationElementRef.current(next.activeVisualElementId);
        }
      },
      onAudit(event) {
        void fetch("/api/ai-command/presentations/lifecycle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: event.type,
            presentationRunId: event.presentationRunId,
            conversationId,
            ...(event.realtimeSessionId ? { realtimeSessionId: event.realtimeSessionId } : {}),
            ...(event.providerResponseId ? { providerResponseId: event.providerResponseId } : {}),
            ...(event.narrationSegmentId && event.type === "narration.segment_completed"
              ? { lastCompletedNarrationSegmentId: event.narrationSegmentId }
              : {}),
            ...(event.visualElementId ? { visualElementId: event.visualElementId } : {}),
          }),
        }).catch(() => undefined);
      },
    });
    narrationControllerRef.current = controller;
    const unsubscribeEvents = adapter.subscribeRealtimeEvents((event) => {
      controller.handleRealtimeEvent(event);
    });
    const unsubscribe = adapter.subscribe((next) => {
      setBrowserVoice(next);
      const connected = isRealtimeVoiceConnected(next);
      if (!connected) {
        if (
          next.state === "idle" ||
          next.state === "disconnected" ||
          next.state === "error" ||
          next.state === "stopping"
        ) {
          if (narrationActiveRef.current) controller.disconnect();
        }
      } else if (
        !voiceWasConnectedRef.current &&
        speakResponsesRef.current &&
        needsVoiceRef.current
      ) {
        const packet = parsePresentationFromPayload(displayedArtifactRef.current.payload);
        if (packet?.narrationSegments.length) {
          controller.start(packet, {
            voiceConnected: true,
            speakResponses: true,
            realtimeSessionId: next.sessionId ?? null,
            mode: liveConnected ? "live" : "test",
          });
        }
      }
      voiceWasConnectedRef.current = connected;
      const state: AiRealtimeUiSnapshot["state"] =
        next.state === "authorizing" ||
        next.state === "requesting-permission" ||
        next.state === "stopping"
          ? "connecting"
          : next.state === "idle"
            ? "idle"
            : next.state;
      setRealtimeUi({ state, transcript: next.transcript, muted: next.muted });
    });
    return () => {
      unsubscribeEvents();
      unsubscribe();
      browserVoiceAdapterRef.current = undefined;
      narrationControllerRef.current = undefined;
      void adapter.dispose();
    };
  }, [
    browserMediaTestMode,
    createVoiceAdapter,
    snapshot.conversation.id,
    snapshot.provider.liveConnected,
  ]);

  useEffect(() => {
    const stored = Number.parseFloat(window.localStorage.getItem(splitStorageKey) ?? "");
    if (!Number.isFinite(stored)) return;
    const frame = window.requestAnimationFrame(() => {
      const next = Math.round(clampPanePercent(stored) * 10) / 10;
      splitPercentRef.current = next;
      setAiPanePercent(next);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [splitStorageKey]);

  useEffect(() => {
    const stored = window.localStorage.getItem(interactionStorageKey);
    if (stored !== "voice" && stored !== "type") return;
    const frame = window.requestAnimationFrame(() => setInteractionMode(stored));
    return () => window.cancelAnimationFrame(frame);
  }, [interactionStorageKey]);

  useEffect(() => {
    const setNetworkState = () => setOnline(window.navigator.onLine);
    setNetworkState();
    window.addEventListener("online", setNetworkState);
    window.addEventListener("offline", setNetworkState);
    return () => {
      window.removeEventListener("online", setNetworkState);
      window.removeEventListener("offline", setNetworkState);
    };
  }, []);

  useEffect(() => {
    const messages = messagesRef.current;
    if (!messages) return;
    const conversationId = snapshot.conversation.id;
    renderedConversationIdRef.current = conversationId;
    const restoredPosition = transcriptScrollPositionsRef.current.get(conversationId);
    transcriptNearBottomRef.current = restoredPosition === undefined;
    setShowJumpToLatest(restoredPosition !== undefined);
    if (transcriptRestoreFrameRef.current !== undefined) {
      window.cancelAnimationFrame(transcriptRestoreFrameRef.current);
    }
    transcriptRestoreFrameRef.current = window.requestAnimationFrame(() => {
      transcriptRestoreFrameRef.current = undefined;
      if (renderedConversationIdRef.current !== conversationId) return;
      messages.scrollTop = restoredPosition ?? messages.scrollHeight;
    });
    return () => {
      if (transcriptRestoreFrameRef.current !== undefined) {
        window.cancelAnimationFrame(transcriptRestoreFrameRef.current);
        transcriptRestoreFrameRef.current = undefined;
      }
    };
  }, [snapshot.conversation.id]);

  useEffect(() => {
    const messages = messagesRef.current;
    if (
      !messages ||
      renderedConversationIdRef.current !== snapshot.conversation.id ||
      !transcriptNearBottomRef.current
    ) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      if (!transcriptNearBottomRef.current) return;
      messages.scrollTop = messages.scrollHeight;
      transcriptScrollPositionsRef.current.delete(snapshot.conversation.id);
      setShowJumpToLatest(false);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [snapshot.conversation.id, snapshot.messages, optimisticMessage, streamingAssistant, busy]);

  useEffect(() => {
    const workspace = workspaceBodyRef.current;
    if (!workspace) return;
    const artifactId = displayedArtifact.id;
    const scrollTop = displayedArtifactUsesPdfScroller
      ? 0
      : (workspaceScrollPositionsRef.current.get(artifactId) ?? 0);
    if (workspaceRestoreFrameRef.current !== undefined) {
      window.cancelAnimationFrame(workspaceRestoreFrameRef.current);
    }
    workspaceRestoreFrameRef.current = window.requestAnimationFrame(() => {
      workspaceRestoreFrameRef.current = undefined;
      if (displayedArtifactRef.current.id !== artifactId) return;
      workspace.scrollTop = scrollTop;
    });
    return () => {
      if (workspaceRestoreFrameRef.current !== undefined) {
        window.cancelAnimationFrame(workspaceRestoreFrameRef.current);
        workspaceRestoreFrameRef.current = undefined;
      }
    };
  }, [displayedArtifact.id, displayedArtifactUsesPdfScroller]);

  useEffect(() => {
    if (pageVisible || (voiceState !== "listening" && voiceState !== "transcribing")) return;
    if (voiceTimerRef.current !== undefined) window.clearTimeout(voiceTimerRef.current);
    voiceTimerRef.current = undefined;
    voiceSessionRef.current = false;
    void browserVoiceAdapterRef.current?.stop("user-cancelled");
    const resetTimer = window.setTimeout(() => {
      voiceSessionRef.current = false;
      setVoiceState("idle");
      setVoiceTranscript("");
      setVoiceOpen(false);
    }, 0);
    return () => window.clearTimeout(resetTimer);
  }, [pageVisible, voiceState]);

  useEffect(() => {
    if (motionProfile !== "reduced") return;
    resetOrbTilt();
    const command = commandRef.current;
    command?.style.removeProperty("--bea-corner-x");
    command?.style.removeProperty("--bea-corner-y");
  }, [motionProfile]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestGenerationRef.current += 1;
      requestControllerRef.current?.abort();
      requestControllerRef.current = undefined;
      uploadGenerationRef.current += 1;
      uploadControllerRef.current?.abort();
      uploadControllerRef.current = undefined;
      voiceRefreshControllerRef.current?.abort();
      voiceRefreshControllerRef.current = undefined;
      if (voiceTimerRef.current !== undefined) window.clearTimeout(voiceTimerRef.current);
      if (respondingTimerRef.current !== undefined) window.clearTimeout(respondingTimerRef.current);
      if (confirmFocusTimerRef.current !== undefined)
        window.clearTimeout(confirmFocusTimerRef.current);
      if (resizeFrameRef.current !== undefined) window.cancelAnimationFrame(resizeFrameRef.current);
      if (orbTiltFrameRef.current !== undefined)
        window.cancelAnimationFrame(orbTiltFrameRef.current);
      if (transcriptRestoreFrameRef.current !== undefined)
        window.cancelAnimationFrame(transcriptRestoreFrameRef.current);
      if (workspaceRestoreFrameRef.current !== undefined)
        window.cancelAnimationFrame(workspaceRestoreFrameRef.current);
      if (narrationTimerRef.current !== undefined) window.clearTimeout(narrationTimerRef.current);
      clearWorkspaceTimers();
    };
  }, []);

  function scrollToNarrationElement(visualElementId: string) {
    const node = workspaceBodyRef.current?.querySelector(
      `[data-visual-element="${visualElementId.replaceAll('"', "")}"]`,
    );
    if (!(node instanceof HTMLElement)) return;
    const generation = programmaticScrollGenerationRef.current + 1;
    programmaticScrollGenerationRef.current = generation;
    programmaticWorkspaceScrollRef.current = true;
    programmaticScrollTokenRef.current = generation;
    programmaticScrollSessionRef.current?.cancel();
    const body = workspaceBodyRef.current;
    programmaticScrollSessionRef.current = attachProgrammaticScroll({
      target: body,
      generation,
      settleMs: motionProfile === "reduced" ? 50 : 1_000,
      schedule: (callback, ms) => window.setTimeout(callback, ms),
      clearSchedule: (handle) => window.clearTimeout(handle),
      onSettle(settledGeneration) {
        if (programmaticScrollTokenRef.current !== settledGeneration) return;
        programmaticScrollTokenRef.current = null;
        programmaticWorkspaceScrollRef.current = false;
        programmaticScrollSessionRef.current = null;
      },
    });
    node.scrollIntoView({
      block: "nearest",
      behavior: motionProfile === "reduced" ? "auto" : "smooth",
    });
  }
  scrollToNarrationElementRef.current = scrollToNarrationElement;

  function applyLocalWorkspaceSelection(selection: AiSafeWorkspaceSelection | null) {
    workspaceSelectionRef.current = selection;
    setWorkspaceSelection(selection);
  }

  function maybeStartNarration(payload: unknown) {
    const packet = parsePresentationFromPayload(payload);
    if (!packet) return;
    const previousRunId = presentationRunRef.current;
    const isNewRun = Boolean(previousRunId && previousRunId !== packet.presentationRunId);
    if (isNewRun) {
      narrationControllerRef.current?.stop();
      programmaticScrollSessionRef.current?.cancel();
      programmaticScrollGenerationRef.current += 1;
      programmaticScrollTokenRef.current = null;
      programmaticWorkspaceScrollRef.current = false;
      applyLocalWorkspaceSelection(packet.selected ?? null);
      autoFollowRef.current = packet.autoFollow;
      setAutoFollow(packet.autoFollow);
    } else if (!previousRunId) {
      autoFollowRef.current = packet.autoFollow;
      setAutoFollow(packet.autoFollow);
      if (packet.selected) applyLocalWorkspaceSelection(packet.selected);
    }
    presentationRunRef.current = packet.presentationRunId;
    const currentNarration = narrationControllerRef.current?.getState();
    if (
      previousRunId === packet.presentationRunId &&
      currentNarration?.presentationRunId === packet.presentationRunId &&
      (currentNarration.narrationActive ||
        currentNarration.status === "requested" ||
        currentNarration.status === "narrating")
    ) {
      return;
    }
    const adapter = browserVoiceAdapterRef.current;
    const voiceConnected = isRealtimeVoiceConnected(adapter?.getSnapshot());
    narrationControllerRef.current?.start(packet, {
      voiceConnected,
      speakResponses: speakResponsesRef.current,
      realtimeSessionId: adapter?.getSnapshot().sessionId ?? null,
      mode: snapshot.provider.liveConnected === true ? "live" : "test",
    });
  }

  function stopNarration() {
    narrationControllerRef.current?.stop();
    if (narrationTimerRef.current !== undefined) window.clearTimeout(narrationTimerRef.current);
    narrationTimerRef.current = undefined;
    narrationActiveRef.current = false;
    setNarrationActive(false);
  }

  function persistWorkspaceSelection(
    selection: AiSafeWorkspaceSelection | null,
    follow: boolean,
    previous: { selection: AiSafeWorkspaceSelection | null; follow: boolean },
  ) {
    const generation = ++selectionPersistGenerationRef.current;
    void fetch("/api/ai-command/presentations/selection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: snapshot.conversation.id,
        selection,
        autoFollow: follow,
      }),
    })
      .then(async (response) => {
        if (generation !== selectionPersistGenerationRef.current) return;
        if (!response.ok) {
          applyLocalWorkspaceSelection(previous.selection);
          autoFollowRef.current = previous.follow;
          setAutoFollow(previous.follow);
          setSelectionPersistError("The selected context could not be saved.");
          return;
        }
        setSelectionPersistError(undefined);
      })
      .catch(() => {
        if (generation !== selectionPersistGenerationRef.current) return;
        applyLocalWorkspaceSelection(previous.selection);
        autoFollowRef.current = previous.follow;
        setAutoFollow(previous.follow);
        setSelectionPersistError("The selected context could not be saved.");
      });
  }

  function handleWorkspaceSelection(selection: AiSafeWorkspaceSelection) {
    const previous = {
      selection: workspaceSelectionRef.current,
      follow: autoFollowRef.current,
    };
    applyLocalWorkspaceSelection(selection);
    autoFollowRef.current = false;
    setAutoFollow(false);
    persistWorkspaceSelection(selection, false, previous);
  }

  function resumeFollowNarration() {
    const previous = {
      selection: workspaceSelectionRef.current,
      follow: autoFollowRef.current,
    };
    autoFollowRef.current = true;
    setAutoFollow(true);
    persistWorkspaceSelection(workspaceSelectionRef.current, true, previous);
    const current =
      narrationControllerRef.current?.currentVisualElementId() ?? activeVisualElementId;
    if (current) scrollToNarrationElement(current);
  }

  function abortUploadForNavigation() {
    uploadGenerationRef.current += 1;
    uploadControllerRef.current?.abort();
    uploadControllerRef.current = undefined;
    setUploadBusy(false);
    setPendingUpload(undefined);
    if (uploadInputRef.current) uploadInputRef.current.value = "";
  }

  function stageSnapshot(next: AiCommandSnapshot, panel: "conversation" | "workspace") {
    const workspace = workspaceBodyRef.current;
    if (workspace && !usesPdfWorkspaceScroller(displayedArtifactRef.current)) {
      workspaceScrollPositionsRef.current.set(displayedArtifactRef.current.id, workspace.scrollTop);
    }
    if (activeConversationIdRef.current !== next.conversation.id) {
      abortUploadForNavigation();
      activeConversationIdRef.current = next.conversation.id;
    }
    setSnapshot(next);
    setValidatedTools([]);
    replaceConversationUrl(next.conversation.id);
    setActivePanel(panel);
    setError(undefined);
    clearWorkspaceTimers();
    recordWorkspaceFrame(next.artifact);

    if (displayedArtifactRef.current.id === next.artifact.id || motionProfile === "reduced") {
      displayedArtifactRef.current = next.artifact;
      setDisplayedArtifact(next.artifact);
      setWorkspaceTransition("settled");
      maybeStartNarration(next.artifact.payload);
      return;
    }

    setWorkspaceTransition("exiting");
    workspaceTimersRef.current.push(
      window.setTimeout(() => {
        displayedArtifactRef.current = next.artifact;
        setDisplayedArtifact(next.artifact);
        setWorkspaceTransition("entering");
        maybeStartNarration(next.artifact.payload);
        workspaceTimersRef.current.push(
          window.setTimeout(() => setWorkspaceTransition("settled"), WORKSPACE_ENTER_SETTLE_MS),
        );
      }, WORKSPACE_EXIT_MS),
    );
  }

  function recordWorkspaceFrame(nextArtifact: AiCommandSnapshot["artifact"], path?: string) {
    const nextPath = path ?? snapshotWorkspacePath(nextArtifact);
    setWorkspaceHistory((current) => {
      const trimmed = current.slice(0, workspaceHistoryIndexRef.current + 1);
      const last = trimmed[trimmed.length - 1];
      if (last && last.artifact.id === nextArtifact.id && last.path === nextPath) return current;
      const next = [...trimmed, { path: nextPath, artifact: nextArtifact }];
      workspaceHistoryIndexRef.current = next.length - 1;
      setWorkspaceHistoryIndex(next.length - 1);
      return next;
    });
  }

  async function openWorkspacePath(path: string) {
    const parsed = parseAiCommandWorkspacePath(path);
    if (!parsed) return false;
    setError(undefined);
    try {
      const response = await fetch(AI_COMMAND_CLIENT_ENDPOINTS.workspace, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: parsed.path }),
      });
      if (response.status === 401) {
        router.replace("/sign-in?reason=expired");
        return true;
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          readonly error?: { readonly message?: string };
        } | null;
        setError(body?.error?.message ?? "That record could not open in the workspace.");
        return true;
      }
      const body = (await response.json()) as {
        readonly artifact?: AiCommandSnapshot["artifact"];
        readonly path?: string;
      };
      if (!body.artifact) return true;
      displayedArtifactRef.current = body.artifact;
      setDisplayedArtifact(body.artifact);
      recordWorkspaceFrame(body.artifact, typeof body.path === "string" ? body.path : parsed.path);
      setActivePanel("workspace");
      return true;
    } catch {
      setError("That record could not open in the workspace.");
      return true;
    }
  }

  function workspaceBack() {
    const index = workspaceHistoryIndexRef.current - 1;
    const frame = workspaceHistory[index];
    if (!frame) return;
    workspaceHistoryIndexRef.current = index;
    setWorkspaceHistoryIndex(index);
    displayedArtifactRef.current = frame.artifact;
    setDisplayedArtifact(frame.artifact);
  }

  function workspaceForward() {
    const index = workspaceHistoryIndexRef.current + 1;
    const frame = workspaceHistory[index];
    if (!frame) return;
    workspaceHistoryIndexRef.current = index;
    setWorkspaceHistoryIndex(index);
    displayedArtifactRef.current = frame.artifact;
    setDisplayedArtifact(frame.artifact);
  }

  function handleInternalWorkspaceClick(event: MouseEvent<HTMLElement>) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("[data-open-full-page]")) return;
    const anchor = target.closest("a");
    if (!(anchor instanceof HTMLAnchorElement)) return;
    const href = anchor.getAttribute("href");
    if (typeof href !== "string" || !isAiCommandWorkspacePath(href)) return;
    event.preventDefault();
    event.stopPropagation();
    void openWorkspacePath(href);
  }

  async function refreshVoiceConversation(conversationId: string) {
    if (!mountedRef.current || activeConversationIdRef.current !== conversationId) return;
    voiceRefreshControllerRef.current?.abort();
    const controller = new AbortController();
    voiceRefreshControllerRef.current = controller;
    try {
      const response = await fetch(
        `${AI_COMMAND_CLIENT_ENDPOINTS.conversation}?conversation=${encodeURIComponent(conversationId)}`,
        { signal: controller.signal },
      );
      if (
        controller.signal.aborted ||
        !mountedRef.current ||
        activeConversationIdRef.current !== conversationId
      ) {
        return;
      }
      if (response.status === 401) {
        await browserVoiceAdapterRef.current?.dispose();
        router.replace("/sign-in?reason=expired");
        return;
      }
      const next = await readSnapshot(response);
      if (
        controller.signal.aborted ||
        !mountedRef.current ||
        activeConversationIdRef.current !== conversationId
      ) {
        return;
      }
      if (displayedArtifactRef.current.id !== next.artifact.id) {
        stageSnapshot(next, "workspace");
      } else {
        setSnapshot(next);
        setError(undefined);
      }
    } catch (caught) {
      if (!isAbortError(caught) && mountedRef.current) {
        setError("The live voice conversation update could not be loaded.");
      }
    } finally {
      if (voiceRefreshControllerRef.current === controller) {
        voiceRefreshControllerRef.current = undefined;
      }
    }
  }

  function stageUploadedArtifact(next: AiCommandSnapshot["artifact"]) {
    setActivePanel("workspace");
    setError(undefined);
    clearWorkspaceTimers();
    if (motionProfile === "reduced") {
      displayedArtifactRef.current = next;
      setDisplayedArtifact(next);
      setWorkspaceTransition("settled");
      return;
    }
    setWorkspaceTransition("exiting");
    workspaceTimersRef.current.push(
      window.setTimeout(() => {
        displayedArtifactRef.current = next;
        setDisplayedArtifact(next);
        setWorkspaceTransition("entering");
        workspaceTimersRef.current.push(
          window.setTimeout(() => setWorkspaceTransition("settled"), WORKSPACE_ENTER_SETTLE_MS),
        );
      }, WORKSPACE_EXIT_MS),
    );
  }

  function beginRequest(): { controller: AbortController; generation: number } {
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    const generation = requestGenerationRef.current + 1;
    requestControllerRef.current = controller;
    requestGenerationRef.current = generation;
    setBusy(true);
    setError(undefined);
    setConfirmActionId(undefined);
    setActionSucceeded(false);
    setWorkspaceTransition("processing");
    return { controller, generation };
  }

  function currentRequest(generation: number): boolean {
    return mountedRef.current && requestGenerationRef.current === generation;
  }

  function finishRequest(generation: number) {
    if (!currentRequest(generation)) return;
    requestControllerRef.current = undefined;
    setBusy(false);
  }

  function reserveMessageRequest(conversationId: string, signal: AbortSignal): Promise<Response> {
    const queued = reservationQueueRef.current.then(() => {
      if (!mountedRef.current || signal.aborted) {
        throw new DOMException("AI Command request was superseded.", "AbortError");
      }
      return fetch("/api/ai-command/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId }),
        signal,
      });
    });
    reservationQueueRef.current = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  function supersedeDisplayedActionPreview() {
    if (!mountedRef.current) return;
    const current = displayedArtifactRef.current;
    if (current.type !== "action-preview") return;
    const superseded = {
      ...current,
      payload: { ...current.payload, executable: false, superseded: true },
    };
    displayedArtifactRef.current = superseded;
    setDisplayedArtifact(superseded);
    setConfirmActionId(undefined);
  }

  function supportsEventStream(): boolean {
    const currentProvider = snapshot.provider as unknown as Record<string, unknown>;
    const mode = providerText(currentProvider, "mode")?.toLowerCase();
    return (
      mode === "demo" ||
      mode === "openai" ||
      mode === "hybrid" ||
      currentProvider.streaming === true
    );
  }

  function canUseWebSearch(): boolean {
    const currentProvider = snapshot.provider as unknown as Record<string, unknown>;
    const mode = providerText(currentProvider, "mode")?.toLowerCase();
    if (currentProvider.webSearchAllowed === false) return false;
    return currentProvider.webSearchAllowed === true || mode === "demo";
  }

  function isDemoProvider(): boolean {
    const currentProvider = snapshot.provider as unknown as Record<string, unknown>;
    const mode = providerText(currentProvider, "mode")?.toLowerCase();
    const status = providerText(currentProvider, "status")?.toLowerCase();
    if (mode === "openai" || mode === "hybrid" || currentProvider.liveConnected === true)
      return false;
    return (
      mode === "demo" ||
      mode === "simulated" ||
      status === "simulated" ||
      currentProvider.simulated === true
    );
  }

  function deterministicFallbackAllowed(): boolean {
    const currentProvider = snapshot.provider as unknown as Record<string, unknown>;
    return currentProvider.simulated === true && isDemoProvider();
  }

  function providerAllows(name: "codeInterpreterAllowed" | "imageGenerationAllowed"): boolean {
    const currentProvider = snapshot.provider as unknown as Record<string, unknown>;
    return currentProvider[name] === true;
  }

  async function uploadArtifact(file: File) {
    const maximumBytes =
      typeof snapshot.provider.maxUploadBytes === "number" &&
      Number.isFinite(snapshot.provider.maxUploadBytes)
        ? snapshot.provider.maxUploadBytes
        : 12 * 1024 * 1024;
    if (file.size < 1 || file.size > maximumBytes) {
      setError(`The selected file must be between 1 byte and ${formatFileSize(maximumBytes)}.`);
      if (uploadInputRef.current) uploadInputRef.current.value = "";
      return;
    }
    uploadControllerRef.current?.abort();
    const controller = new AbortController();
    const generation = uploadGenerationRef.current + 1;
    const conversationId = snapshot.conversation.id;
    uploadGenerationRef.current = generation;
    uploadControllerRef.current = controller;
    const isCurrentUpload = () =>
      mountedRef.current &&
      !controller.signal.aborted &&
      uploadGenerationRef.current === generation &&
      activeConversationIdRef.current === conversationId;
    setUploadBusy(true);
    setError(undefined);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("conversationId", conversationId);
      const response = await fetch("/api/artifacts/upload", {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      if (!isCurrentUpload()) return;
      if (response.status === 401) {
        router.replace("/sign-in?reason=expired");
        return;
      }
      if (!response.ok) {
        const body = (await response
          .clone()
          .json()
          .catch(() => null)) as unknown;
        const message =
          isRecord(body) && isRecord(body.error) && typeof body.error.message === "string"
            ? body.error.message
            : `Artifact upload failed with status ${response.status}.`;
        if (!isCurrentUpload()) return;
        throw new Error(message);
      }
      const body = (await response.json()) as unknown;
      if (!isCurrentUpload()) return;
      if (
        !isRecord(body) ||
        body.ok !== true ||
        !isRecord(body.artifact) ||
        !isRecord(body.manifest)
      ) {
        throw new Error("The upload response did not contain a controlled artifact manifest.");
      }
      const artifactId = typeof body.artifact.id === "string" ? body.artifact.id : "";
      const filename = typeof body.artifact.filename === "string" ? body.artifact.filename : "";
      const mediaType = typeof body.artifact.mimeType === "string" ? body.artifact.mimeType : "";
      const size = typeof body.artifact.size === "number" ? body.artifact.size : Number.NaN;
      const renderer = typeof body.manifest.renderer === "string" ? body.manifest.renderer : "";
      const workspaceArtifactId =
        typeof body.workspaceArtifactId === "string" ? body.workspaceArtifactId : "";
      if (
        !STORED_ARTIFACT_ID_PATTERN.test(artifactId) ||
        !workspaceArtifactId ||
        !filename ||
        !mediaType ||
        !Number.isFinite(size) ||
        body.manifest.schemaVersion !== 1 ||
        !UPLOAD_RENDERERS.has(renderer)
      ) {
        throw new Error("The upload response failed controlled artifact validation.");
      }
      const manifest = body.manifest;
      setPendingUpload({ artifactId, filename, manifest, mediaType, size });
      stageUploadedArtifact({
        id: workspaceArtifactId,
        type: "empty",
        title: typeof manifest.title === "string" ? manifest.title : filename,
        subtitle: typeof manifest.summary === "string" ? manifest.summary : "Restricted upload",
        state: "ready",
        payload: manifest as AiCommandSnapshot["artifact"]["payload"],
        sources: [],
        links: [],
        requiredPermissions: ["documents.view", "ai-command.view"],
        createdAt:
          typeof body.artifact.createdAt === "string"
            ? body.artifact.createdAt
            : new Date().toISOString(),
        errorCode: null,
      });
    } catch (caught) {
      if (!isAbortError(caught) && isCurrentUpload()) {
        setError(caught instanceof Error ? caught.message : "Artifact upload could not complete.");
      }
    } finally {
      if (uploadGenerationRef.current === generation) {
        if (uploadControllerRef.current === controller) uploadControllerRef.current = undefined;
        setUploadBusy(false);
        if (uploadInputRef.current) uploadInputRef.current.value = "";
      }
    }
  }

  function updateToolStatus(next: ValidatedToolProposal) {
    setValidatedTools((current) => [...current.filter((item) => item.id !== next.id), next]);
  }

  function currentToolValidation(
    generation: number,
    conversationId: string,
    signal: AbortSignal,
  ): boolean {
    return (
      !signal.aborted &&
      currentRequest(generation) &&
      activeConversationIdRef.current === conversationId
    );
  }

  function forwardToolProposal(
    toolCall: Record<string, unknown>,
    signal: AbortSignal,
    generation: number,
    conversationId: string,
  ) {
    if (!currentToolValidation(generation, conversationId, signal)) return;
    const id = typeof toolCall.id === "string" ? toolCall.id : "";
    const name = typeof toolCall.name === "string" ? toolCall.name : "";
    if (!id || !name) return;
    if (BUILT_IN_PROVIDER_TOOL_NAMES.has(name)) {
      const status =
        typeof toolCall.status === "string" && PROVIDER_TOOL_STATUSES.has(toolCall.status)
          ? (toolCall.status as "proposed" | "validated" | "rejected" | "completed" | "failed")
          : "proposed";
      updateToolStatus({ id, name, source: "provider", status });
      return;
    }
    if (!REGISTERED_BEA_TOOL_NAMES.has(name)) {
      updateToolStatus({ id, name, source: "application", status: "rejected" });
      return;
    }
    updateToolStatus({ id, name, source: "application", status: "validating" });
    void validateAiToolProposal(
      { callId: id, name, arguments: toolCall.arguments ?? {} },
      signal,
    ).then(
      (body) => {
        if (!currentToolValidation(generation, conversationId, signal)) return;
        updateToolStatus({
          id,
          name,
          source: "application",
          status: body.validation.status,
        });
      },
      () => {
        if (!currentToolValidation(generation, conversationId, signal)) return;
        updateToolStatus({ id, name, source: "application", status: "rejected" });
      },
    );
  }

  function applyStreamEvent(event: AiCommandStreamEvent, generation: number, signal: AbortSignal) {
    if (!currentRequest(generation)) return;
    if (event.type === "response.started") {
      setStreamingAssistant((current) => ({
        citations: current?.citations ?? [],
        content: current?.content ?? "",
        fileSources: current?.fileSources ?? [],
        generatedArtifacts: current?.generatedArtifacts ?? [],
        generation,
        status: "streaming",
        toolCalls: current?.toolCalls ?? [],
      }));
      return;
    }
    if (event.type === "response.output_text.delta") {
      setResponding(true);
      setStreamingAssistant((current) => ({
        citations: current?.citations ?? [],
        content: `${current?.content ?? ""}${event.delta}`,
        fileSources: current?.fileSources ?? [],
        generatedArtifacts: current?.generatedArtifacts ?? [],
        generation,
        status: "streaming",
        toolCalls: current?.toolCalls ?? [],
      }));
      return;
    }
    if (event.type === "response.citation") {
      setStreamingAssistant((current) =>
        current ? { ...current, citations: [...current.citations, event.citation] } : current,
      );
      return;
    }
    if (event.type === "response.file_source") {
      setStreamingAssistant((current) =>
        current ? { ...current, fileSources: [...current.fileSources, event.source] } : current,
      );
      return;
    }
    if (event.type === "response.tool_call") {
      setStreamingAssistant((current) =>
        current ? { ...current, toolCalls: [...current.toolCalls, event.toolCall] } : current,
      );
      forwardToolProposal(event.toolCall, signal, generation, activeConversationIdRef.current);
      return;
    }
    if (event.type === "response.generated_artifact") {
      setActivePanel("workspace");
      setStreamingAssistant((current) =>
        current
          ? {
              ...current,
              generatedArtifacts: [...current.generatedArtifacts, event.artifact],
            }
          : current,
      );
      return;
    }
    if (event.type === "response.completed") {
      setStreamingAssistant((current) => (current ? { ...current, status: "completed" } : current));
      setResponding(false);
      return;
    }
    if (event.type === "response.cancelled") {
      setStreamingAssistant((current) =>
        current ? { ...current, status: current.content ? "partial" : "cancelled" } : current,
      );
      setResponding(false);
      setWorkspaceTransition("settled");
    }
  }

  async function sendFallbackMessage(
    trimmed: string,
    reservation: AiRequestReservation,
    active: {
      readonly controller: AbortController;
      readonly generation: number;
    },
  ) {
    if (!deterministicFallbackAllowed()) {
      throw new Error(LIVE_STREAM_FALLBACK_BLOCKED_MESSAGE);
    }
    const response = await fetch(AI_COMMAND_CLIENT_ENDPOINTS.messageFallback, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: snapshot.conversation.id,
        message: trimmed,
        requestId: reservation.requestId,
        generation: reservation.generation,
        ...(workspaceSelection && isFollowUpAboutSelection(trimmed) ? { workspaceSelection } : {}),
      }),
      signal: active.controller.signal,
    });
    if (!currentRequest(active.generation)) return;
    if (response.status === 401) {
      setOptimisticMessage(undefined);
      router.replace("/sign-in?reason=expired");
      return;
    }
    const next = await readSnapshot(response);
    if (!currentRequest(active.generation)) return;
    setOptimisticMessage(undefined);
    setStreamingAssistant(undefined);
    stageSnapshot(next, "workspace");
    setResponding(true);
    if (respondingTimerRef.current !== undefined) window.clearTimeout(respondingTimerRef.current);
    respondingTimerRef.current = window.setTimeout(() => {
      setResponding(false);
      respondingTimerRef.current = undefined;
    }, 900);
  }

  async function refreshStreamedConversation(active: {
    readonly controller: AbortController;
    readonly generation: number;
  }) {
    const response = await fetch(
      `${AI_COMMAND_CLIENT_ENDPOINTS.conversation}?conversation=${encodeURIComponent(snapshot.conversation.id)}`,
      { signal: active.controller.signal },
    );
    if (!currentRequest(active.generation)) return;
    if (response.status === 401) {
      router.replace("/sign-in?reason=expired");
      return;
    }
    const next = await readSnapshot(response);
    if (!currentRequest(active.generation)) return;
    setOptimisticMessage(undefined);
    setStreamingAssistant(undefined);
    stageSnapshot(next, "workspace");
  }

  async function sendMessage(message: string, inputMode: AiCommandInputMode = "text") {
    const trimmed = message.trim();
    if (!trimmed) return;
    if (!demoProvider && !providerIsLive) {
      setError(
        snapshot.permissions.canConfigureOpenAi
          ? "OpenAI setup required. Use Connect OpenAI in the workspace to save and test a project API key."
          : "The AI provider is unavailable. An authorized administrator must complete OpenAI setup.",
      );
      setActivePanel("workspace");
      return;
    }
    const pendingDemoUpload = isDemoProvider() ? pendingUpload : undefined;
    const demoTools: ("web_search" | "code_interpreter" | "image_generation")[] = [];
    if (canUseWebSearch() && webSearchEnabled) demoTools.push("web_search");
    if (isDemoProvider() && providerAllows("codeInterpreterAllowed") && codeAnalysisEnabled) {
      demoTools.push("code_interpreter");
    }
    if (isDemoProvider() && providerAllows("imageGenerationAllowed") && imageGenerationEnabled) {
      demoTools.push("image_generation");
      setImageGenerationEnabled(false);
    }
    const active = beginRequest();
    if (
      narrationActiveRef.current ||
      browserVoiceAdapterRef.current?.getSnapshot().state === "assistant-speaking"
    ) {
      narrationControllerRef.current?.interrupt("typed");
    }
    setOptimisticMessage({
      content: trimmed,
      createdAt: new Date().toISOString(),
      generation: active.generation,
    });
    setComposer("");
    setComposerInputMode("text");
    try {
      const reservationResponse = await reserveMessageRequest(
        snapshot.conversation.id,
        active.controller.signal,
      );
      if (reservationResponse.status === 401) {
        if (currentRequest(active.generation)) {
          setOptimisticMessage(undefined);
          router.replace("/sign-in?reason=expired");
        }
        return;
      }
      if (reservationResponse.ok) supersedeDisplayedActionPreview();
      const reservation = await readReservation(reservationResponse);
      if (!currentRequest(active.generation)) return;
      const fallbackAllowed = deterministicFallbackAllowed();
      if (!supportsEventStream()) {
        if (!fallbackAllowed) throw new Error(LIVE_STREAM_FALLBACK_BLOCKED_MESSAGE);
        await sendFallbackMessage(trimmed, reservation, active);
        return;
      }
      if (
        fallbackAllowed &&
        requiresDeterministicJsonRoute(trimmed) &&
        demoTools.length === 0 &&
        pendingDemoUpload === undefined
      ) {
        await sendFallbackMessage(trimmed, reservation, active);
        return;
      }
      setStreamingAssistant({
        citations: [],
        content: "",
        fileSources: [],
        generatedArtifacts: [],
        generation: active.generation,
        status: "starting",
        toolCalls: [],
      });
      setValidatedTools([]);
      let pendingDemoUploadAccepted = false;
      const response = await fetch(AI_COMMAND_CLIENT_ENDPOINTS.stream, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: snapshot.conversation.id,
          message: trimmed,
          requestId: reservation.requestId,
          generation: reservation.generation,
          inputMode,
          webSearch: demoTools.includes("web_search"),
          builtInTools: demoTools,
          confirmHighCostTools: demoTools.includes("image_generation"),
          ...(pendingDemoUpload ? { inputArtifactIds: [pendingDemoUpload.artifactId] } : {}),
          ...(workspaceSelection && isFollowUpAboutSelection(trimmed)
            ? { workspaceSelection }
            : {}),
        }),
        signal: active.controller.signal,
      });
      if (!currentRequest(active.generation)) return;
      if (response.status === 401) {
        setOptimisticMessage(undefined);
        router.replace("/sign-in?reason=expired");
        return;
      }
      if ([404, 405, 501].includes(response.status)) {
        setStreamingAssistant(undefined);
        if (!fallbackAllowed) throw new Error(LIVE_STREAM_FALLBACK_BLOCKED_MESSAGE);
        await sendFallbackMessage(trimmed, reservation, active);
        return;
      }
      let completed = false;
      let cancelled = false;
      await consumeAiCommandEventStream(
        response,
        (event) => {
          if (
            event.type === "response.started" &&
            pendingDemoUpload &&
            !pendingDemoUploadAccepted
          ) {
            pendingDemoUploadAccepted = true;
            setPendingUpload((current) =>
              current?.artifactId === pendingDemoUpload.artifactId ? undefined : current,
            );
          }
          applyStreamEvent(event, active.generation, active.controller.signal);
          if (event.type === "response.completed") completed = true;
          if (event.type === "response.cancelled") cancelled = true;
          if (event.type === "response.error") {
            setStreamingAssistant((current) =>
              current ? { ...current, status: current.content ? "partial" : "error" } : current,
            );
            throw new Error(`${event.safeMessage} [${event.code}]`);
          }
        },
        active.controller.signal,
      );
      if (!currentRequest(active.generation)) return;
      setOptimisticMessage(undefined);
      if (completed) await refreshStreamedConversation(active);
      else if (!cancelled) throw new Error("The AI Command stream ended before completion.");
    } catch (caught) {
      if (isAbortError(caught) && currentRequest(active.generation)) {
        setOptimisticMessage(undefined);
        setStreamingAssistant((current) =>
          current ? { ...current, status: current.content ? "partial" : "cancelled" } : current,
        );
        setResponding(false);
        setWorkspaceTransition("settled");
      } else if (currentRequest(active.generation)) {
        setOptimisticMessage(undefined);
        setStreamingAssistant((current) =>
          current ? { ...current, status: current.content ? "partial" : "error" } : current,
        );
        setError(caught instanceof Error ? caught.message : "The assistant request failed.");
        setWorkspaceTransition("settled");
      }
    } finally {
      finishRequest(active.generation);
    }
  }

  async function createConversation() {
    if (busy) return;
    await stopVoiceForNavigation();
    abortUploadForNavigation();
    const active = beginRequest();
    try {
      const response = await fetch("/api/ai-command/conversations", {
        method: "POST",
        signal: active.controller.signal,
      });
      if (!currentRequest(active.generation)) return;
      if (response.status === 401) {
        router.replace("/sign-in?reason=expired");
        return;
      }
      const next = await readSnapshot(response);
      if (!currentRequest(active.generation)) return;
      stageSnapshot(next, "conversation");
    } catch (caught) {
      if (!isAbortError(caught) && currentRequest(active.generation)) {
        setError(
          caught instanceof Error ? caught.message : "A new conversation could not be created.",
        );
        setWorkspaceTransition("settled");
      }
    } finally {
      finishRequest(active.generation);
    }
  }

  async function openConversation(conversationId: string) {
    if (busy || conversationId === snapshot.conversation.id) return;
    await stopVoiceForNavigation();
    abortUploadForNavigation();
    const active = beginRequest();
    try {
      const response = await fetch(
        `/api/ai-command/conversations?conversation=${encodeURIComponent(conversationId)}`,
        { signal: active.controller.signal },
      );
      if (!currentRequest(active.generation)) return;
      if (response.status === 401) {
        router.replace("/sign-in?reason=expired");
        return;
      }
      const next = await readSnapshot(response);
      if (!currentRequest(active.generation)) return;
      stageSnapshot(next, "conversation");
    } catch (caught) {
      if (!isAbortError(caught) && currentRequest(active.generation)) {
        setError(
          caught instanceof Error ? caught.message : "The conversation could not be opened.",
        );
        setWorkspaceTransition("settled");
      }
    } finally {
      finishRequest(active.generation);
    }
  }

  async function confirmAction() {
    if (!confirmActionId || busy || workspaceTransition !== "settled") return;
    const actionId = confirmActionId;
    const active = beginRequest();
    setConfirmActionId(actionId);
    try {
      const response = await fetch(
        `/api/ai-command/actions/${encodeURIComponent(actionId)}/confirm`,
        { method: "POST", signal: active.controller.signal },
      );
      if (!currentRequest(active.generation)) return;
      if (response.status === 401) {
        router.replace("/sign-in?reason=expired");
        return;
      }
      const next = await readSnapshot(response);
      if (!currentRequest(active.generation)) return;
      stageSnapshot(next, "workspace");
      setActionSucceeded(true);
      if (confirmFocusTimerRef.current !== undefined)
        window.clearTimeout(confirmFocusTimerRef.current);
      confirmFocusTimerRef.current = window.setTimeout(
        () => {
          workspaceStatusRef.current?.focus();
          confirmFocusTimerRef.current = undefined;
        },
        motionProfile === "reduced" ? 0 : CONFIRM_FOCUS_SETTLE_MS,
      );
    } catch (caught) {
      if (!isAbortError(caught) && currentRequest(active.generation)) {
        setError(caught instanceof Error ? caught.message : "The task action failed.");
        setWorkspaceTransition("settled");
      }
    } finally {
      finishRequest(active.generation);
      if (currentRequest(active.generation)) setConfirmActionId(undefined);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendMessage(composer, composerInputMode);
  }

  function stopGeneration() {
    if (!busy || confirmActionId) return;
    requestControllerRef.current?.abort();
    setResponding(false);
    setWorkspaceTransition("settled");
    setStreamingAssistant((current) =>
      current ? { ...current, status: current.content ? "partial" : "cancelled" } : current,
    );
  }

  function simulateVoice() {
    if (voiceTimerRef.current !== undefined) window.clearTimeout(voiceTimerRef.current);
    voiceSessionRef.current = true;
    setVoiceOpen(true);
    setVoiceState("listening");
    setVoiceTranscript("");
    void browserVoiceAdapterRef.current?.start();
    voiceTimerRef.current = window.setTimeout(() => {
      setVoiceState("transcribing");
      voiceTimerRef.current = window.setTimeout(() => {
        setVoiceTranscript("Show open tasks");
        setVoiceState("review");
        voiceTimerRef.current = undefined;
      }, VOICE_TRANSCRIBING_MS);
    }, VOICE_LISTENING_MS);
  }

  function cancelVoice() {
    if (voiceTimerRef.current !== undefined) window.clearTimeout(voiceTimerRef.current);
    voiceTimerRef.current = undefined;
    narrationControllerRef.current?.stop();
    const adapter = browserVoiceAdapterRef.current;
    if (adapter) {
      void adapter.stop("user-cancelled");
    }
    setVoiceState("idle");
    setVoiceTranscript("");
    setVoiceOpen(false);
    setRealtimeUi({ state: "idle", transcript: "", muted: false });
    voiceSessionRef.current = false;
    stopNarration();
  }

  function startBrowserVoiceTest() {
    if (!browserMediaTestMode || !browserVoiceAdapterRef.current) return;
    if (voiceTimerRef.current !== undefined) window.clearTimeout(voiceTimerRef.current);
    voiceTimerRef.current = undefined;
    setVoiceOpen(true);
    setVoiceState("idle");
    setVoiceTranscript("");
    void browserVoiceAdapterRef.current.start();
  }

  function stopBrowserVoiceTest() {
    narrationControllerRef.current?.stop();
    void browserVoiceAdapterRef.current?.stop("user-stopped");
  }

  function startLiveVoice() {
    const adapter = browserVoiceAdapterRef.current;
    if (!providerIsLive || !adapter) return;
    voiceSessionRef.current = true;
    setVoiceOpen(true);
    setError(undefined);
    void adapter.start().then((next) => {
      if (next.state === "error" && next.safeError) setError(next.safeError);
    });
  }

  function stopLiveVoice() {
    narrationControllerRef.current?.stop();
    void browserVoiceAdapterRef.current?.stop("user-stopped");
  }

  function toggleLiveVoiceMute() {
    const adapter = browserVoiceAdapterRef.current;
    if (!adapter) return;
    adapter.setMuted(!browserVoice?.muted);
  }

  async function updateSpeakResponses(next: boolean) {
    if (voicePreferenceBusy) return;
    setVoicePreferenceBusy(true);
    setError(undefined);
    try {
      const response = await fetch(AI_COMMAND_CLIENT_ENDPOINTS.realtimePreference, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ speakResponses: next }),
      });
      if (response.status === 401) {
        router.replace("/sign-in?reason=expired");
        return;
      }
      const body = (await response.json().catch(() => null)) as {
        readonly preference?: { readonly speakResponses?: unknown };
        readonly error?: AiCommandErrorBody["error"];
      } | null;
      if (!response.ok || body?.preference?.speakResponses !== next) {
        throw new Error(
          body && typeof body.error?.message === "string"
            ? body.error.message
            : "The voice response preference could not be saved.",
        );
      }
      setSpeakResponses(next);
      setSnapshot((current) => ({
        ...current,
        provider: { ...current.provider, speakResponses: next },
      }));
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The voice response preference could not be saved.",
      );
    } finally {
      setVoicePreferenceBusy(false);
    }
  }

  async function stopVoiceForNavigation() {
    voiceRefreshControllerRef.current?.abort();
    voiceRefreshControllerRef.current = undefined;
    await browserVoiceAdapterRef.current?.stop("component-unmount");
    setVoiceOpen(false);
  }

  function handleTranscriptScroll(event: UIEvent<HTMLDivElement>) {
    const messages = event.currentTarget;
    const distanceFromBottom = Math.max(
      0,
      messages.scrollHeight - messages.clientHeight - messages.scrollTop,
    );
    const nearBottom = distanceFromBottom <= TRANSCRIPT_NEAR_BOTTOM_PX;
    transcriptNearBottomRef.current = nearBottom;
    const conversationId = renderedConversationIdRef.current;
    if (nearBottom) transcriptScrollPositionsRef.current.delete(conversationId);
    else transcriptScrollPositionsRef.current.set(conversationId, messages.scrollTop);
    setShowJumpToLatest(!nearBottom);
  }

  function jumpToLatest() {
    const messages = messagesRef.current;
    if (!messages) return;
    transcriptNearBottomRef.current = true;
    transcriptScrollPositionsRef.current.delete(renderedConversationIdRef.current);
    messages.scrollTop = messages.scrollHeight;
    setShowJumpToLatest(false);
  }

  function pauseAutoFollowFromManualWorkspaceIntent(options?: { readonly persist?: boolean }) {
    if (!autoFollowRef.current || !narrationActiveRef.current) return;
    const previous = { selection: workspaceSelectionRef.current, follow: autoFollowRef.current };
    autoFollowRef.current = false;
    setAutoFollow(false);
    if (options?.persist === false) return;
    persistWorkspaceSelection(workspaceSelectionRef.current, false, previous);
  }

  function handleWorkspaceScroll(event: UIEvent<HTMLDivElement>) {
    if (usesPdfWorkspaceScroller(displayedArtifactRef.current)) return;
    workspaceScrollPositionsRef.current.set(
      displayedArtifactRef.current.id,
      event.currentTarget.scrollTop,
    );
    if (
      isProgrammaticScrollActive({
        token: programmaticScrollTokenRef.current,
        flag: programmaticWorkspaceScrollRef.current,
      })
    ) {
      return;
    }
    pauseAutoFollowFromManualWorkspaceIntent();
  }

  function handleWorkspaceWheel(event: WheelEvent<HTMLDivElement>) {
    if (event.deltaY === 0 && event.deltaX === 0) return;
    pauseAutoFollowFromManualWorkspaceIntent();
  }

  function handleWorkspaceKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "].includes(event.key)) {
      pauseAutoFollowFromManualWorkspaceIntent();
    }
  }

  function selectInteractionMode(next: AiInteractionMode) {
    if (next === interactionMode) return;
    if (next === "type") {
      cancelVoice();
    }
    setInteractionMode(next);
    window.localStorage.setItem(interactionStorageKey, next);
    if (next === "voice") {
      setVoiceOpen(false);
      setVoiceState("idle");
    }
  }

  function toggleVoice() {
    if (voiceOpen) {
      cancelVoice();
      return;
    }
    if (providerIsLive) {
      setVoiceOpen(true);
      setRealtimeUi({ state: "disconnected", transcript: "", muted: false });
      return;
    }
    if (!demoProvider) {
      setError(
        snapshot.permissions.canConfigureOpenAi
          ? "Voice setup required. Connect OpenAI and validate a compatible Realtime model and voice first."
          : "Voice is unavailable until an authorized administrator completes OpenAI setup.",
      );
      setActivePanel("workspace");
      return;
    }
    simulateVoice();
  }

  function resetOrbTilt() {
    if (orbTiltFrameRef.current !== undefined) window.cancelAnimationFrame(orbTiltFrameRef.current);
    orbTiltFrameRef.current = undefined;
    orbTiltPendingRef.current = undefined;
    orbBoundsRef.current = undefined;
    const orb = orbRef.current;
    if (!orb) return;
    orb.style.setProperty("--bea-orb-tilt-x", "0deg");
    orb.style.setProperty("--bea-orb-tilt-y", "0deg");
    orb.style.setProperty("--bea-orb-parallax-x", "0rem");
    orb.style.setProperty("--bea-orb-parallax-y", "0rem");
  }

  function moveSplit(event: PointerEvent<HTMLDivElement>) {
    const bounds = splitBoundsRef.current;
    if (!bounds) return;
    if (bounds.width <= 0 || !Number.isFinite(event.clientX)) return;
    resizePendingRef.current = ((event.clientX - bounds.left) / bounds.width) * 100;
    if (resizeFrameRef.current !== undefined) return;
    resizeFrameRef.current = window.requestAnimationFrame(() => {
      resizeFrameRef.current = undefined;
      if (resizePendingRef.current !== undefined) updatePanePercent(resizePendingRef.current);
    });
  }

  function finishSplitResize(event: PointerEvent<HTMLDivElement>) {
    if (!splitBoundsRef.current) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (resizePendingRef.current !== undefined) updatePanePercent(resizePendingRef.current, true);
    resizePendingRef.current = undefined;
    splitBoundsRef.current = undefined;
    setResizing(false);
  }

  function resizeWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? KEYBOARD_RESIZE_LARGE_STEP : KEYBOARD_RESIZE_STEP;
    let next: number | undefined;
    if (event.key === "ArrowLeft") next = aiPanePercent - step;
    if (event.key === "ArrowRight") next = aiPanePercent + step;
    if (event.key === "Home") next = MIN_AI_PANE_PERCENT;
    if (event.key === "End") next = MAX_AI_PANE_PERCENT;
    if (event.key === "Enter" || event.key === "0") next = DEFAULT_AI_PANE_PERCENT;
    if (next === undefined) return;
    event.preventDefault();
    updatePanePercent(next, true);
  }

  const provider = snapshot.provider as unknown as Record<string, unknown>;
  const providerMode = providerText(provider, "mode")?.toLowerCase();
  const providerStatus = providerText(provider, "providerStatus", "status")?.toUpperCase();
  const realtimeModel = providerText(provider, "realtimeModel");
  const providerVoice = providerText(provider, "voice");
  const providerIsLive = provider.liveConnected === true;
  const liveVoiceConnected =
    browserVoice?.mode === BROWSER_VOICE_LIVE_MODE && browserVoice.providerConnected;
  const providerLiveMode = providerMode === "openai" || providerMode === "hybrid";
  const webSearchAvailable = canUseWebSearch();
  const demoProvider = isDemoProvider();
  const showOpenAiSetup =
    !demoProvider && !providerIsLive && snapshot.permissions.canConfigureOpenAi === true;
  const workspaceTitle = showOpenAiSetup ? "Connect OpenAI" : displayedArtifact.title;
  const workspaceSubtitle = showOpenAiSetup ? "OpenAI setup required" : displayedArtifact.subtitle;
  const workspaceState = showOpenAiSetup ? "setup required" : displayedArtifact.state;
  const workspaceUsesPdfScroller = !showOpenAiSetup && displayedArtifactUsesPdfScroller;
  const codeAnalysisVisible = provider.codeInterpreterAllowed === true;
  const imageGenerationVisible = provider.imageGenerationAllowed === true;
  const providerBadge = providerIsLive
    ? "CONNECTED"
    : providerLiveMode
      ? providerStatus === "CONFIGURED_NOT_TESTED"
        ? "CONFIGURED — NOT TESTED"
        : providerStatus === "CONNECTION_FAILED" || providerStatus === "BLOCKED"
          ? "CONNECTION FAILED"
          : providerStatus === "DISABLED"
            ? "DISABLED"
            : "SETUP REQUIRED"
      : demoProvider
        ? "TEST-ONLY"
        : "SETUP REQUIRED";
  const artifactPayload = displayedArtifact.payload as Record<string, unknown>;
  const liveWebSearchUsed =
    providerIsLive &&
    (validatedTools.some(
      (tool) =>
        tool.name === "web_search" && tool.source === "provider" && tool.status === "completed",
    ) ||
      (typeof artifactPayload.disclosure === "string" &&
        artifactPayload.disclosure.startsWith("OpenAI web-search")));
  const workspaceStatus = showOpenAiSetup
    ? "OpenAI setup is required before live AI requests can run."
    : streamingAssistant?.generatedArtifacts.length
      ? "A generated artifact is being prepared and will persist after completion."
      : workspaceTransition === "processing"
        ? "Preparing authorized workspace update. Current results remain available."
        : workspaceTransition === "exiting"
          ? "New workspace results are ready."
          : workspaceTransition === "entering"
            ? "Workspace updated."
            : `${displayedArtifact.title} is ready.`;
  const splitStyle = {
    "--bea-ai-pane-percent": `${aiPanePercent}%`,
  } as CSSProperties;

  return (
    <div
      ref={commandRef}
      className={styles.command}
      data-testid="ai-command-workspace"
      data-browser-media-test-mode={browserMediaTestMode}
      data-browser-voice-state={browserVoice?.state ?? "disabled"}
      data-interaction-mode={interactionMode}
      data-voice-session={
        interactionMode === "voice" &&
        (voiceOpen || voiceSessionRef.current || isRealtimeVoiceConnected(browserVoice))
          ? "active"
          : "idle"
      }
      data-narration-active={narrationActive ? "true" : "false"}
      data-needs-voice={needsVoiceToHearBriefing ? "true" : "false"}
      data-auto-follow={autoFollow ? "true" : "false"}
      data-resizing={resizing}
      style={splitStyle}
      onPointerMove={(event) => {
        if (motionProfile === "reduced" || event.pointerType === "touch") return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (bounds.width <= 0 || bounds.height <= 0) return;
        const normalizedX = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
        const normalizedY = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
        event.currentTarget.style.setProperty(
          "--bea-corner-x",
          `${(normalizedX * 100).toFixed(1)}%`,
        );
        event.currentTarget.style.setProperty(
          "--bea-corner-y",
          `${(normalizedY * 100).toFixed(1)}%`,
        );
      }}
      onPointerLeave={(event) => {
        event.currentTarget.style.removeProperty("--bea-corner-x");
        event.currentTarget.style.removeProperty("--bea-corner-y");
      }}
    >
      <div
        className={`bea-ai-panel-switch ${styles.panelSwitch}`}
        role="tablist"
        aria-label="AI Command panels"
      >
        <button
          id="bea-ai-conversation-tab"
          type="button"
          role="tab"
          aria-selected={activePanel === "conversation"}
          aria-controls="bea-ai-conversation-panel"
          tabIndex={activePanel === "conversation" ? 0 : -1}
          onClick={() => setActivePanel("conversation")}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const target = event.key === "Home" ? "conversation" : "workspace";
            setActivePanel(target);
            document.getElementById(`bea-ai-${target}-tab`)?.focus();
          }}
        >
          Conversation
        </button>
        <button
          id="bea-ai-workspace-tab"
          type="button"
          role="tab"
          aria-selected={activePanel === "workspace"}
          aria-controls="bea-ai-workspace-panel"
          tabIndex={activePanel === "workspace" ? 0 : -1}
          onClick={() => setActivePanel("workspace")}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const target = event.key === "End" ? "workspace" : "conversation";
            setActivePanel(target);
            document.getElementById(`bea-ai-${target}-tab`)?.focus();
          }}
        >
          Workspace
        </button>
      </div>

      <section
        id="bea-ai-conversation-panel"
        className={`bea-floating-surface ${styles.panel} ${styles.conversation}`}
        data-testid="ai-conversation-panel"
        data-primary-glass-tile="conversation"
        data-mobile-active={activePanel === "conversation"}
        data-interaction-mode={interactionMode}
        data-voice-active={
          interactionMode === "voice" &&
          (voiceOpen || voiceState !== "idle" || isRealtimeVoiceConnected(browserVoice))
        }
        data-provider-mode={providerMode ?? "unavailable"}
        role="tabpanel"
        aria-labelledby="bea-ai-conversation-tab"
        onClick={handleInternalWorkspaceClick}
      >
        <div className={styles.modeBar} data-testid="ai-interaction-mode">
          <div className={styles.modeToggle} role="group" aria-label="AI Command interaction mode">
            <button
              type="button"
              data-testid="ai-interaction-mode-voice"
              aria-pressed={interactionMode === "voice"}
              onClick={() => selectInteractionMode("voice")}
            >
              Voice
            </button>
            <button
              type="button"
              data-testid="ai-interaction-mode-type"
              aria-pressed={interactionMode === "type"}
              onClick={() => selectInteractionMode("type")}
            >
              Type
            </button>
          </div>
          <div className={styles.overlayControls} data-testid="ai-command-overlay-controls">
            <details className={styles.history}>
              <summary aria-label="Open conversation history">
                <span aria-hidden="true">↺</span>
              </summary>
              <div className={styles.historyPanel}>
                <label htmlFor="bea-conversation-select">Saved conversations</label>
                <select
                  id="bea-conversation-select"
                  aria-label="Saved conversations"
                  value={snapshot.conversation.id}
                  disabled={busy}
                  onChange={(event) => void openConversation(event.target.value)}
                >
                  {snapshot.conversations.map((conversation) => (
                    <option value={conversation.id} key={conversation.id}>
                      {conversation.title}
                    </option>
                  ))}
                </select>
                <Button
                  size="small"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void createConversation()}
                >
                  New conversation
                </Button>
              </div>
            </details>

            <details className={styles.options} data-testid="ai-command-progressive-controls">
              <summary
                aria-label="Open advanced AI controls"
                data-testid="ai-command-options-trigger"
              >
                <span aria-hidden="true">•••</span>
              </summary>
              <div className={styles.optionsPanel}>
                <div className={styles.optionsHeading}>
                  <strong>AI controls</strong>
                  <Badge tone={providerIsLive ? "success" : "warning"}>{providerBadge}</Badge>
                </div>
                <dl className={styles.optionsMeta}>
                  <div>
                    <dt>Text model</dt>
                    <dd>{snapshot.provider.textModel ?? snapshot.provider.model}</dd>
                  </div>
                  {realtimeModel ? (
                    <div>
                      <dt>Realtime</dt>
                      <dd>{realtimeModel}</dd>
                    </div>
                  ) : null}
                  {providerVoice ? (
                    <div>
                      <dt>Voice</dt>
                      <dd>{providerVoice}</dd>
                    </div>
                  ) : null}
                </dl>
                <div className={styles.optionsActions}>
                  {webSearchAvailable ? (
                    <button
                      className={styles.trayToggle}
                      type="button"
                      data-testid="ai-web-search-toggle"
                      aria-pressed={webSearchEnabled}
                      onClick={() => setWebSearchEnabled((current) => !current)}
                    >
                      Web search
                    </button>
                  ) : null}
                  {codeAnalysisVisible ? (
                    <button
                      className={styles.trayToggle}
                      type="button"
                      data-testid="ai-code-interpreter-toggle"
                      aria-pressed={codeAnalysisEnabled}
                      disabled={!demoProvider}
                      onClick={() => setCodeAnalysisEnabled((current) => !current)}
                    >
                      Code analysis
                    </button>
                  ) : null}
                  {imageGenerationVisible ? (
                    <button
                      className={styles.trayToggle}
                      type="button"
                      data-testid="ai-image-generation-toggle"
                      aria-pressed={imageGenerationEnabled}
                      disabled={!demoProvider}
                      onClick={() => {
                        if (imageGenerationEnabled) setImageGenerationEnabled(false);
                        else setConfirmImageGeneration(true);
                      }}
                    >
                      Generate image
                    </button>
                  ) : null}
                </div>
                {codeAnalysisVisible || imageGenerationVisible ? (
                  <small data-testid="ai-provider-tool-safety">
                    {demoProvider
                      ? "Deterministic Demo Mode only: no paid provider or external network call."
                      : "Live provider code and image invocation is blocked pending explicit owner authorization."}
                  </small>
                ) : null}
                {snapshot.permissions.canUploadArtifact ? (
                  <div className={styles.optionsFiles} data-testid="ai-upload-control">
                    <label className={styles.uploadButton} htmlFor="bea-ai-artifact-upload">
                      {uploadBusy ? "Validating…" : "Choose restricted file"}
                    </label>
                    <input
                      ref={uploadInputRef}
                      id="bea-ai-artifact-upload"
                      className="bea-visually-hidden"
                      data-testid="ai-artifact-upload-input"
                      type="file"
                      accept={ARTIFACT_UPLOAD_ACCEPT}
                      disabled={uploadBusy}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void uploadArtifact(file);
                      }}
                    />
                    {pendingUpload ? (
                      <div className={styles.uploadChip} data-testid="ai-uploaded-artifact">
                        <span>
                          <strong>{pendingUpload.filename}</strong>
                          <small>{formatFileSize(pendingUpload.size)}</small>
                        </span>
                        <button
                          type="button"
                          data-testid="ai-remove-upload-chip"
                          onClick={() => setPendingUpload(undefined)}
                        >
                          Dismiss
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {snapshot.permissions.canConfigureOpenAi ? (
                  <>
                    <Link href="/integrations/ai" className={styles.optionsLink} prefetch={false}>
                      {providerIsLive ? "OpenAI configuration" : "Connect OpenAI"}
                    </Link>
                    <Link
                      href="/integrations/ai/owner-acceptance"
                      className={styles.optionsLink}
                      prefetch={false}
                    >
                      Owner Live Acceptance
                    </Link>
                  </>
                ) : null}
              </div>
            </details>
          </div>
        </div>

        <header className={styles.orbLayer} hidden={interactionMode !== "voice"}>
          <div
            ref={orbRef}
            className={`bea-ai-orb ${styles.orb}`}
            data-state={orbState}
            data-browser-voice-state={browserVoice?.state ?? "disabled"}
            data-testid="bea-ai-orb"
            data-orb-layer="outer-glass"
          >
            <span className="bea-ai-orb__shell" data-orb-layer="outer-glass" aria-hidden="true" />
            <span className="bea-ai-orb__glow" data-orb-layer="internal-glow" aria-hidden="true" />
            <span className="bea-ai-orb__halo" aria-hidden="true" />
            <span className="bea-ai-orb__ring bea-ai-orb__ring--outer" aria-hidden="true" />
            <span className="bea-ai-orb__ring bea-ai-orb__ring--inner" aria-hidden="true" />
            <span className="bea-ai-orb__core" data-orb-layer="core-mark" aria-hidden="true">
              <span />
            </span>
            <span className="bea-ai-orb__particles" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
            </span>
            <span
              className="bea-ai-orb__highlight"
              data-orb-layer="foreground-highlight"
              aria-hidden="true"
            />
          </div>
          <div className={styles.identityCopy}>
            <p
              className={styles.identityState}
              role="status"
              aria-live="polite"
              data-testid="ai-orb-state"
            >
              {AI_ORB_STATE_LABELS[orbState]}
            </p>
            <span className="bea-visually-hidden">
              {snapshot.assistant.subtitle}. The code-native AI presence is not the official company
              logo.
            </span>
          </div>
        </header>

        {interactionMode === "voice" ? (
          <div className={styles.voiceStage} data-testid="ai-voice-stage">
            <div
              id="bea-ai-voice-panel"
              className={`bea-ai-voice-panel ${styles.voicePanel}`}
              data-testid="ai-voice-panel"
              data-browser-voice-state={browserVoice?.state ?? "disabled"}
              data-voice-mode={
                providerIsLive
                  ? "openai-realtime"
                  : browserMediaTestMode
                    ? "test-available"
                    : demoProvider
                      ? "simulated"
                      : "disconnected"
              }
            >
              {providerIsLive ? (
                <div className="bea-stack" data-testid="ai-realtime-status">
                  <Badge tone={liveVoiceConnected ? "success" : "warning"}>
                    {liveVoiceConnected ? BROWSER_VOICE_LIVE_MODE : "Realtime ready to start"}
                  </Badge>
                  <p>
                    Start requests microphone permission and a short-lived backend-authorized WebRTC
                    session. Raw audio is not persisted. Live API activity may incur charges.
                  </p>
                  <dl>
                    <div>
                      <dt>State</dt>
                      <dd>{realtimeUi.state}</dd>
                    </div>
                    {realtimeModel ? (
                      <div>
                        <dt>Model</dt>
                        <dd>{realtimeModel}</dd>
                      </div>
                    ) : null}
                    {providerVoice ? (
                      <div>
                        <dt>Voice</dt>
                        <dd>{providerVoice}</dd>
                      </div>
                    ) : null}
                  </dl>
                  <Button
                    size="small"
                    variant="ghost"
                    role="switch"
                    aria-checked={speakResponses}
                    data-testid="bea-speak-responses-toggle"
                    disabled={voicePreferenceBusy}
                    onClick={() => void updateSpeakResponses(!speakResponses)}
                  >
                    Speak responses: {speakResponses ? "On" : "Off"}
                  </Button>
                  <small>
                    Voice-started sessions default to spoken replies. This saved preference applies
                    to the next Realtime authorization.
                  </small>
                  <div className="bea-cluster">
                    <Button
                      size="small"
                      data-testid="bea-live-voice-start"
                      disabled={
                        !browserVoice ||
                        [
                          "authorizing",
                          "requesting-permission",
                          "connecting",
                          "listening",
                          "user-speaking",
                          "processing",
                          "assistant-speaking",
                          "muted",
                          "reconnecting",
                          "stopping",
                        ].includes(browserVoice.state)
                      }
                      onClick={startLiveVoice}
                    >
                      Start live voice
                    </Button>
                    <Button
                      size="small"
                      variant="ghost"
                      data-testid="bea-live-voice-stop"
                      disabled={!liveVoiceConnected}
                      onClick={stopLiveVoice}
                    >
                      Stop
                    </Button>
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={!liveVoiceConnected}
                      aria-pressed={browserVoice?.muted ?? false}
                      onClick={toggleLiveVoiceMute}
                    >
                      {browserVoice?.muted ? "Unmute" : "Mute"}
                    </Button>
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={!liveVoiceConnected}
                      onClick={() => {
                        narrationControllerRef.current?.interrupt("vad");
                        browserVoiceAdapterRef.current?.interrupt();
                      }}
                    >
                      Interrupt
                    </Button>
                    {browserVoice?.state === "error" || browserVoice?.state === "disconnected" ? (
                      <Button
                        size="small"
                        variant="ghost"
                        onClick={() => void browserVoiceAdapterRef.current?.reconnect()}
                      >
                        Reconnect
                      </Button>
                    ) : null}
                    <Button size="small" variant="ghost" onClick={cancelVoice}>
                      Close
                    </Button>
                  </div>
                  {browserVoice?.interactionMode === "push_to_talk" && liveVoiceConnected ? (
                    <Button
                      size="small"
                      variant="secondary"
                      onPointerDown={() => {
                        narrationControllerRef.current?.interrupt("push-to-talk");
                        browserVoiceAdapterRef.current?.beginPushToTalk();
                      }}
                      onPointerUp={() => browserVoiceAdapterRef.current?.endPushToTalk()}
                      onPointerCancel={() => browserVoiceAdapterRef.current?.endPushToTalk()}
                      onKeyDown={(event) => {
                        if (event.key === " " || event.key === "Enter") {
                          event.preventDefault();
                          browserVoiceAdapterRef.current?.beginPushToTalk();
                        }
                      }}
                      onKeyUp={(event) => {
                        if (event.key === " " || event.key === "Enter") {
                          event.preventDefault();
                          browserVoiceAdapterRef.current?.endPushToTalk();
                        }
                      }}
                    >
                      Hold to talk
                    </Button>
                  ) : null}
                  <output
                    className="bea-visually-hidden"
                    data-testid="bea-live-voice-transcript"
                    aria-live="polite"
                  >
                    {realtimeUi.transcript || "Live transcript will appear here."}
                  </output>
                  <output
                    data-testid="bea-live-voice-status"
                    data-state={browserVoice?.state ?? "idle"}
                    data-state-history={browserVoice?.stateHistory.join(",") ?? "idle"}
                    data-microphone-active={browserVoice?.microphoneActive ?? false}
                    data-all-tracks-ended={browserVoice?.allTracksEnded ?? true}
                    data-all-peers-closed={browserVoice?.allPeerConnectionsClosed ?? true}
                    data-audio-references-released={browserVoice?.audioReferencesReleased ?? true}
                    data-active-timers={browserVoice?.activeTimerCount ?? 0}
                    data-active-listeners={browserVoice?.activeListenerCount ?? 0}
                    data-standard-api-key-exposed={browserVoice?.standardApiKeyExposed ?? false}
                    data-realtime-credential-retained={
                      browserVoice?.realtimeCredentialRetained ?? false
                    }
                    data-tool-calls-completed={browserVoice?.toolCallsCompleted ?? 0}
                    data-cleanup-complete={browserVoice?.cleanupComplete ?? true}
                    aria-live="polite"
                  >
                    Live voice state: {browserVoice?.state ?? "idle"}.
                  </output>
                  {browserVoice?.safeError ? (
                    <Alert tone="danger" title="Live Realtime voice unavailable">
                      {browserVoice.safeError}
                    </Alert>
                  ) : null}
                </div>
              ) : (
                <>
                  {voiceState === "listening" || voiceState === "transcribing" ? (
                    <div className="bea-cluster" role="status">
                      <Badge tone="warning">
                        {voiceState === "listening" ? "Listening" : "Preparing transcript"}
                      </Badge>
                      <Button
                        className="bea-ai-voice-cancel"
                        size="small"
                        variant="ghost"
                        onClick={cancelVoice}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : null}
                  {voiceState === "review" ? (
                    <div className="bea-stack" data-testid="ai-voice-transcript">
                      <label htmlFor="bea-voice-transcript">
                        Review and correct simulated transcript
                      </label>
                      <textarea
                        id="bea-voice-transcript"
                        className="bea-textarea"
                        value={voiceTranscript}
                        onChange={(event) => setVoiceTranscript(event.target.value)}
                      />
                      <div className="bea-cluster">
                        <Button
                          size="small"
                          onClick={() => {
                            const transcript = voiceTranscript;
                            selectInteractionMode("type");
                            setComposer(transcript);
                            setComposerInputMode("simulated_voice");
                          }}
                        >
                          Use transcript
                        </Button>
                        <Button size="small" variant="ghost" onClick={cancelVoice}>
                          Discard
                        </Button>
                      </div>
                    </div>
                  ) : null}
                  {browserMediaTestMode ? (
                    <section
                      className="bea-stack"
                      data-testid="bea-browser-voice-test"
                      data-state={browserVoice?.state ?? "idle"}
                      aria-label="Browser microphone TEST MODE"
                    >
                      <div className="bea-cluster">
                        <Badge tone="warning">{BROWSER_VOICE_TEST_MODE}</Badge>
                        <strong>Local browser microphone and WebRTC loopback</strong>
                      </div>
                      <p>
                        This fail-closed test requests an audited simulated authorization, then uses
                        this browser&apos;s microphone API and an in-process peer loopback. It makes
                        no external provider call and persists no audio.
                      </p>
                      <div className="bea-cluster">
                        <Button
                          size="small"
                          data-testid="bea-voice-start"
                          disabled={
                            browserVoice?.state === "authorizing" ||
                            browserVoice?.state === "requesting-permission" ||
                            browserVoice?.state === "connecting" ||
                            browserVoice?.state === "listening" ||
                            browserVoice?.state === "user-speaking" ||
                            browserVoice?.state === "stopping"
                          }
                          onClick={startBrowserVoiceTest}
                        >
                          Start browser media test
                        </Button>
                        <Button
                          size="small"
                          variant="ghost"
                          data-testid="bea-voice-stop"
                          disabled={
                            !browserVoice ||
                            browserVoice.state === "idle" ||
                            browserVoice.state === "error" ||
                            browserVoice.state === "stopping"
                          }
                          onClick={stopBrowserVoiceTest}
                        >
                          Stop browser media test
                        </Button>
                      </div>
                      <output
                        data-testid="bea-voice-status"
                        data-state={browserVoice?.state ?? "idle"}
                        data-state-history={browserVoice?.stateHistory.join(",") ?? "idle"}
                        data-authorization-requests={browserVoice?.authorizationRequests ?? 0}
                        data-cycles-started={browserVoice?.cyclesStarted ?? 0}
                        data-cycles-completed={browserVoice?.cyclesCompleted ?? 0}
                        data-track-state={browserVoice?.localAudioTrackState ?? "none"}
                        data-microphone-active={browserVoice?.microphoneActive ?? false}
                        data-all-tracks-ended={browserVoice?.allTracksEnded ?? true}
                        data-peer-states={browserVoice?.peerConnectionStates.join(",") ?? ""}
                        data-all-peers-closed={browserVoice?.allPeerConnectionsClosed ?? true}
                        data-audio-element-state={browserVoice?.audioElementState ?? "none"}
                        data-audio-references-released={
                          browserVoice?.audioReferencesReleased ?? true
                        }
                        data-active-timers={browserVoice?.activeTimerCount ?? 0}
                        data-active-listeners={browserVoice?.activeListenerCount ?? 0}
                        data-active-animation-frames={browserVoice?.activeAnimationFrameCount ?? 0}
                        data-raw-audio-persisted={browserVoice?.rawAudioPersisted ?? false}
                        data-external-provider-calls={browserVoice?.externalProviderCalls ?? 0}
                        data-standard-api-key-exposed={browserVoice?.standardApiKeyExposed ?? false}
                        data-realtime-credential-retained={
                          browserVoice?.realtimeCredentialRetained ?? false
                        }
                        data-cleanup-complete={browserVoice?.cleanupComplete ?? true}
                        data-stop-reason={browserVoice?.stopReason ?? "none"}
                        aria-live="polite"
                      >
                        Browser voice state: {browserVoice?.state ?? "idle"}.
                      </output>
                      {browserVoice?.safeError ? (
                        <Alert tone="danger" title="Browser voice TEST MODE unavailable">
                          {browserVoice.safeError}
                        </Alert>
                      ) : null}
                    </section>
                  ) : null}
                </>
              )}
            </div>
            {!liveVoiceConnected && providerIsLive ? (
              <p>Start voice to begin. The microphone stays off until you start it.</p>
            ) : null}
            {!providerIsLive && !demoProvider && !browserMediaTestMode ? (
              <p>OpenAI must be connected before Voice Mode can start.</p>
            ) : null}
            {!providerIsLive && demoProvider ? (
              <div className="bea-cluster">
                <Button size="small" data-testid="bea-start-voice" onClick={toggleVoice}>
                  Start Voice
                </Button>
                <p>Start voice to begin.</p>
              </div>
            ) : null}
          </div>
        ) : null}

        <div
          className={styles.transcriptViewport}
          data-transcript-region="single-scroll-owner"
          hidden={interactionMode !== "type"}
          onClick={handleInternalWorkspaceClick}
        >
          <div
            id="bea-ai-message-scroller"
            ref={messagesRef}
            className={`bea-ai-messages ${styles.messages}`}
            data-testid="ai-message-scroller"
            data-auto-follow={showJumpToLatest ? "paused" : "following"}
            aria-label="Conversation history"
            aria-live="polite"
            aria-relevant="additions"
            tabIndex={0}
            onScroll={handleTranscriptScroll}
          >
            {snapshot.messages.map((message) => (
              <article
                className={`bea-ai-message bea-ai-message--${message.role} ${styles.message}`}
                data-role={message.role}
                key={message.id}
              >
                <header>
                  <strong>{message.role === "user" ? "You" : "Ask BEA"}</strong>
                  <time dateTime={message.createdAt}>
                    {new Date(message.createdAt).toLocaleTimeString("en-US", {
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </time>
                </header>
                <p>{message.content}</p>
                {message.links.length > 0 ? (
                  <ul className="bea-ai-message-links">
                    {message.links.map((link) => {
                      const href = safeMessageHref(link.href);
                      return (
                        <li key={`${message.id}:${link.href}`}>
                          {href ? (
                            <a
                              href={href}
                              {...(href.startsWith("https://")
                                ? { target: "_blank", rel: "noreferrer noopener" }
                                : {})}
                            >
                              {link.label}
                            </a>
                          ) : (
                            <span>{link.label}</span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
                {message.provider === "simulated" ? (
                  <span className="bea-ai-message-provider">
                    Simulated · {message.executionMs ?? 0} ms
                  </span>
                ) : null}
              </article>
            ))}
            {optimisticMessage ? (
              <article
                className={`bea-ai-message bea-ai-message--user bea-ai-message--optimistic ${styles.message}`}
                data-role="user"
                data-testid="optimistic-user-message"
                data-request-generation={optimisticMessage.generation}
              >
                <header>
                  <strong>You</strong>
                  <time dateTime={optimisticMessage.createdAt}>
                    {new Date(optimisticMessage.createdAt).toLocaleTimeString("en-US", {
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </time>
                </header>
                <p>{optimisticMessage.content}</p>
                <span className="bea-ai-message-provider">Sending…</span>
              </article>
            ) : null}
            {streamingAssistant ? (
              <article
                className={`bea-ai-message bea-ai-message--assistant ${styles.message}`}
                data-role="assistant"
                data-stream-status={streamingAssistant.status}
                data-testid="streaming-assistant-message"
                aria-busy={
                  streamingAssistant.status === "starting" ||
                  streamingAssistant.status === "streaming"
                }
              >
                <header>
                  <strong>Ask BEA</strong>
                  <span>{streamingAssistant.status}</span>
                </header>
                <p>{streamingAssistant.content || "Starting response…"}</p>
                {streamingAssistant.citations.length > 0 ? (
                  <ul aria-label="Streaming citations">
                    {streamingAssistant.citations.map((citation, index) => (
                      <li key={typeof citation.id === "string" ? citation.id : `citation-${index}`}>
                        {safeMessageHref(citation.url) ? (
                          <a
                            href={safeMessageHref(citation.url) ?? undefined}
                            target="_blank"
                            rel="noreferrer noopener"
                          >
                            {typeof citation.title === "string"
                              ? citation.title
                              : `Citation ${index + 1}`}
                          </a>
                        ) : typeof citation.title === "string" ? (
                          citation.title
                        ) : (
                          `Citation ${index + 1}`
                        )}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {streamingAssistant.fileSources.length > 0 ? (
                  <ul aria-label="Streaming organizational file sources">
                    {streamingAssistant.fileSources.map((source, index) => (
                      <li key={typeof source.id === "string" ? source.id : `file-source-${index}`}>
                        <strong>
                          {typeof source.filename === "string"
                            ? source.filename
                            : `Organizational file ${index + 1}`}
                        </strong>
                        {typeof source.excerpt === "string" && source.excerpt.trim() ? (
                          <span>{` — ${source.excerpt.slice(0, 1_000)}`}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {validatedTools.length > 0 ? (
                  <ul aria-label="Validated tool proposals">
                    {validatedTools.map((tool) => (
                      <li data-tool-source={tool.source} key={tool.id}>
                        {tool.name} · {tool.source === "provider" ? "provider " : ""}
                        {tool.status}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </article>
            ) : null}
            {busy && !confirmActionId ? (
              <div className="bea-ai-processing" role="status">
                <span className="bea-spinner bea-spinner--dark" aria-hidden="true" />
                {streamingAssistant
                  ? "Streaming the assistant response…"
                  : "Querying authorized records…"}
              </div>
            ) : null}
          </div>
          {showJumpToLatest ? (
            <button
              className={styles.jumpToLatest}
              type="button"
              data-testid="ai-jump-to-latest"
              aria-label="Jump to latest message"
              aria-controls="bea-ai-message-scroller"
              title="Jump to latest message"
              onClick={jumpToLatest}
            >
              <span aria-hidden="true">↓</span>
            </button>
          ) : null}
        </div>

        {error ? (
          <div className={styles.error}>
            <Alert tone="danger" title="AI Command unavailable">
              {error}
            </Alert>
          </div>
        ) : null}
        {selectionPersistError ? (
          <div className={styles.error}>
            <Alert tone="danger" title="Selection not saved">
              {selectionPersistError}
            </Alert>
          </div>
        ) : null}

        <form
          className={styles.composer}
          data-testid="ai-command-composer"
          hidden={interactionMode !== "type"}
          onSubmit={submit}
        >
          <label className="bea-visually-hidden" htmlFor="bea-ai-message">
            Message BEA AI Command
          </label>
          <textarea
            id="bea-ai-message"
            className={`bea-textarea ${styles.composerInput}`}
            rows={1}
            value={composer}
            disabled={!hydrated}
            maxLength={2000}
            placeholder="Ask BEA…"
            onChange={(event) => {
              setComposer(event.target.value);
              setComposerInputMode("text");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendMessage(composer, composerInputMode);
              }
            }}
          />
          <div className={styles.composerActions}>
            {busy && !confirmActionId ? (
              <Button
                type="button"
                variant="ghost"
                data-testid="ai-stop-generation"
                onClick={stopGeneration}
              >
                Stop
              </Button>
            ) : null}
            <Button type="submit" disabled={!composer.trim() || (!demoProvider && !providerIsLive)}>
              {busy ? "Send another" : "Send"}
            </Button>
          </div>
        </form>
      </section>

      <div
        className={styles.divider}
        data-testid="ai-pane-divider"
        role="separator"
        aria-label="Resize AI Command panes"
        aria-orientation="vertical"
        aria-valuemin={MIN_AI_PANE_PERCENT}
        aria-valuemax={MAX_AI_PANE_PERCENT}
        aria-valuenow={Math.round(aiPanePercent)}
        aria-valuetext={`${Math.round(aiPanePercent)}% conversation, ${Math.round(100 - aiPanePercent)}% workspace`}
        tabIndex={0}
        title="Drag to resize. Arrow keys adjust, Enter resets."
        onPointerDown={(event) => {
          const bounds = commandRef.current?.getBoundingClientRect();
          if (!bounds || bounds.width <= 0) return;
          splitBoundsRef.current = { left: bounds.left, width: bounds.width };
          event.currentTarget.setPointerCapture(event.pointerId);
          setResizing(true);
        }}
        onPointerMove={moveSplit}
        onPointerUp={finishSplitResize}
        onPointerCancel={finishSplitResize}
        onDoubleClick={() => updatePanePercent(DEFAULT_AI_PANE_PERCENT, true)}
        onKeyDown={resizeWithKeyboard}
      >
        <span aria-hidden="true" />
      </div>

      <section
        id="bea-ai-workspace-panel"
        className={`bea-floating-surface ${styles.panel} ${styles.workspace}`}
        data-testid="ai-workspace-panel"
        data-primary-glass-tile="workspace"
        data-mobile-active={activePanel === "workspace"}
        data-transition={workspaceTransition}
        role="tabpanel"
        aria-labelledby="bea-ai-workspace-tab"
        onClick={handleInternalWorkspaceClick}
      >
        <header className={styles.workspaceHeader} data-testid="ai-workspace-header">
          <div>
            <div className={styles.workspaceNav} data-testid="ai-workspace-nav">
              <Button
                type="button"
                size="small"
                variant="ghost"
                data-testid="ai-workspace-back"
                disabled={workspaceHistoryIndex <= 0}
                onClick={workspaceBack}
              >
                Back
              </Button>
              <Button
                type="button"
                size="small"
                variant="ghost"
                data-testid="ai-workspace-forward"
                disabled={workspaceHistoryIndex >= workspaceHistory.length - 1}
                onClick={workspaceForward}
              >
                Forward
              </Button>
              {(() => {
                const fullPage = displayedArtifact.links.find((link) =>
                  isAiCommandWorkspacePath(link.href),
                );
                return fullPage ? (
                  <Link
                    href={fullPage.href}
                    className={styles.optionsLink}
                    data-open-full-page="true"
                    prefetch={false}
                  >
                    Open full page
                  </Link>
                ) : null;
              })()}
            </div>
            <h2>{workspaceTitle}</h2>
            {workspaceSubtitle ? <p>{workspaceSubtitle}</p> : null}
          </div>
          <div className={styles.workspaceHeaderActions}>
            <Badge tone={liveWebSearchUsed ? "success" : "info"}>
              {liveWebSearchUsed
                ? "Live web sources"
                : workspaceTransition === "processing"
                  ? "Tool running"
                  : workspaceState}
            </Badge>
            {!autoFollow ? (
              <Button
                type="button"
                variant="ghost"
                data-testid="follow-narration"
                onClick={resumeFollowNarration}
              >
                Follow narration
              </Button>
            ) : null}
            {narrationActive ? (
              <Button
                type="button"
                variant="ghost"
                data-testid="pause-narration"
                onClick={() => narrationControllerRef.current?.pause()}
              >
                Pause narration
              </Button>
            ) : null}
            {needsVoiceToHearBriefing ? (
              <Button
                type="button"
                variant="ghost"
                data-testid="start-voice-to-hear"
                onClick={() => {
                  selectInteractionMode("voice");
                  if (providerIsLive) startLiveVoice();
                  else if (browserMediaTestMode) startBrowserVoiceTest();
                  else if (demoProvider) simulateVoice();
                }}
              >
                Start voice to hear this briefing
              </Button>
            ) : null}
          </div>
          <p
            ref={workspaceStatusRef}
            className="bea-visually-hidden"
            data-testid="ai-workspace-status"
            role="status"
            aria-live="polite"
            tabIndex={-1}
          >
            {workspaceStatus}
          </p>
        </header>
        <div
          ref={workspaceBodyRef}
          className={styles.workspaceBody}
          data-testid="ai-workspace-scroller"
          data-scroll-owner={workspaceUsesPdfScroller ? "pdf" : "workspace"}
          aria-label={workspaceUsesPdfScroller ? undefined : `${workspaceTitle} workspace content`}
          tabIndex={workspaceUsesPdfScroller ? -1 : 0}
          onScroll={handleWorkspaceScroll}
          onWheel={handleWorkspaceWheel}
          onKeyDown={handleWorkspaceKeyDown}
          onPointerDown={(event) => {
            if (
              event.pointerType !== "touch" &&
              event.pointerType !== "pen" &&
              event.pointerType !== "mouse"
            ) {
              return;
            }
            const target = event.target;
            if (target instanceof Element && target.closest("[data-workspace-select]")) {
              return;
            }
            pauseAutoFollowFromManualWorkspaceIntent();
          }}
        >
          <div className={styles.workspaceStage} data-transition={workspaceTransition}>
            {showOpenAiSetup ? (
              <OpenAiAdministrationPanel compact />
            ) : (
              <WorkspaceRenderer
                key={displayedArtifact.id}
                artifact={displayedArtifact}
                titleRenderedByParent
                canExecuteTaskAction={
                  snapshot.permissions.canExecuteTaskAction &&
                  !busy &&
                  workspaceTransition === "settled"
                }
                activeVisualElementId={activeVisualElementId}
                selectedElementId={workspaceSelection?.elementId ?? null}
                autoFollow={autoFollow}
                narrationActive={narrationActive}
                onSelectWorkspaceItem={handleWorkspaceSelection}
                onConfirmAction={(actionId) => {
                  if (workspaceTransition === "settled") setConfirmActionId(actionId);
                }}
              />
            )}
          </div>
        </div>
      </section>

      <ConfirmationDialog
        open={Boolean(confirmActionId)}
        title="Create this internal task?"
        description="The server will revalidate your permission and the exact preview payload. A verified database result, activity, and audit event will be returned."
        confirmLabel="Confirm and create task"
        busy={busy}
        onCancel={() => setConfirmActionId(undefined)}
        onConfirm={() => void confirmAction()}
      />
      {demoProvider ? (
        <ConfirmationDialog
          open={confirmImageGeneration}
          title="Enable simulated image generation for one request?"
          description="This selects the deterministic Demo Mode image fixture for the next message. It makes no paid provider or external network call. Live provider image generation remains blocked."
          confirmLabel="Use simulated image generation"
          onCancel={() => setConfirmImageGeneration(false)}
          onConfirm={() => {
            setImageGenerationEnabled(true);
            setConfirmImageGeneration(false);
          }}
        />
      ) : null}
    </div>
  );
}
