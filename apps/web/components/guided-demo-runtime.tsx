"use client";

import {
  GUIDED_DEMO_PRESET_VOICE_PHRASE,
  GUIDED_DEMO_STAGE_BY_KEY,
  OWNER_DELIVERY_CHANGE_DEFAULT_REASON,
  SYNTHETIC_DEMONSTRATION_NOTICE,
  type GuidedDemoAction,
  type GuidedDemoDecisionKey,
  type GuidedDemoSnapshot,
  type GuidedDemoSpeedMode,
} from "@bea/domain";
import { Button } from "@bea/ui";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  fetchGuidedDemoSnapshot,
  postDemoCommand,
  postGuidedDemoAction,
  type GuidedDemoEnvelope,
} from "@/lib/guided-demo-client";
import { cueForSnapshot } from "@/lib/guided-demo-presentation";

interface GuidedDemoActionExtra {
  readonly decisionKey?: GuidedDemoDecisionKey;
  readonly comments?: string;
  readonly skipDelay?: boolean;
  readonly speedMode?: GuidedDemoSpeedMode;
}

interface GuidedDemoContextValue {
  readonly envelope: GuidedDemoEnvelope | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly listening: boolean;
  readonly presentationMode: boolean;
  readonly reportOpen: boolean;
  readonly transcript: string | null;
  readonly appMode: "demo" | "production";
  readonly setPresentationMode: (value: boolean) => void;
  readonly setReportOpen: (value: boolean) => void;
  readonly refresh: () => Promise<void>;
  readonly run: (
    action: GuidedDemoAction,
    extra?: GuidedDemoActionExtra,
  ) => Promise<GuidedDemoEnvelope | null>;
  readonly playPresetVoice: () => Promise<void>;
  readonly listenWithMicrophone: () => Promise<void>;
  readonly cancelListening: () => void;
  readonly submitCommand: (text: string) => Promise<void>;
}

const GuidedDemoContext = createContext<GuidedDemoContextValue | null>(null);

function pollDelay(snapshot: GuidedDemoSnapshot | undefined, hidden: boolean): number {
  if (hidden) return 8_000;
  if (!snapshot) return 3_000;
  if (snapshot.status === "running") return 1_000;
  return 3_000;
}

export function GuidedDemoRuntime({
  children,
  displayName,
  appMode,
}: {
  children: ReactNode;
  displayName: string;
  appMode: "demo" | "production";
}) {
  const [envelope, setEnvelope] = useState<GuidedDemoEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(appMode === "demo");
  const [listening, setListening] = useState(false);
  const [presentationMode, setPresentationMode] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [transcript, setTranscript] = useState<string | null>(null);
  const envelopeRef = useRef(envelope);
  const errorRef = useRef(error);
  const recognitionRef = useRef<{ stop: () => void } | null>(null);

  useEffect(() => {
    envelopeRef.current = envelope;
    errorRef.current = error;
  }, [envelope, error]);

  const apply = useCallback((next: GuidedDemoEnvelope) => {
    setEnvelope(next);
    setError(null);
    if (next.command?.openReport) setReportOpen(true);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchGuidedDemoSnapshot();
      apply(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The demonstration could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [apply]);

  const run = useCallback(
    async (action: GuidedDemoAction, extra?: GuidedDemoActionExtra) => {
      const current = envelopeRef.current;
      try {
        const next = await postGuidedDemoAction({
          action,
          expectedVersion: current?.snapshot.optimisticVersion,
          presentationMode,
          ...(extra?.decisionKey ? { decisionKey: extra.decisionKey } : {}),
          ...(extra?.comments ? { comments: extra.comments } : {}),
          ...(extra?.skipDelay ? { skipDelay: true } : {}),
          ...(extra?.speedMode ? { speedMode: extra.speedMode } : {}),
        });
        apply(next);
        return next;
      } catch (caught) {
        setError(
          caught instanceof Error ? caught.message : "The demonstration command was refused.",
        );
        await refresh();
        return null;
      }
    },
    [apply, presentationMode, refresh],
  );

  const submitCommand = useCallback(
    async (text: string) => {
      try {
        const next = await postDemoCommand(text);
        apply(next);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "The simulated command was refused.");
      }
    },
    [apply],
  );

  const cancelListening = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setListening(false);
  }, []);

  const playPresetVoice = useCallback(async () => {
    setListening(true);
    setTranscript(null);
    await new Promise((resolve) => window.setTimeout(resolve, 700));
    setTranscript(GUIDED_DEMO_PRESET_VOICE_PHRASE);
    setListening(false);
    await submitCommand(GUIDED_DEMO_PRESET_VOICE_PHRASE);
  }, [submitCommand]);

  const listenWithMicrophone = useCallback(async () => {
    const SpeechRecognitionCtor =
      (
        window as Window & {
          SpeechRecognition?: new () => {
            lang: string;
            interimResults: boolean;
            onresult:
              ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
            onerror: (() => void) | null;
            onend: (() => void) | null;
            start: () => void;
            stop: () => void;
          };
          webkitSpeechRecognition?: new () => {
            lang: string;
            interimResults: boolean;
            onresult:
              ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
            onerror: (() => void) | null;
            onend: (() => void) | null;
            start: () => void;
            stop: () => void;
          };
        }
      ).SpeechRecognition ??
      (
        window as Window & {
          webkitSpeechRecognition?: new () => {
            lang: string;
            interimResults: boolean;
            onresult:
              ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
            onerror: (() => void) | null;
            onend: (() => void) | null;
            start: () => void;
            stop: () => void;
          };
        }
      ).webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) return;
    const recognition = new SpeechRecognitionCtor();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognitionRef.current = recognition;
    setListening(true);
    setTranscript(null);
    recognition.onresult = (event) => {
      const spoken = event.results[0]?.[0]?.transcript?.trim() ?? "";
      setTranscript(spoken);
      setListening(false);
      if (spoken) void submitCommand(spoken);
    };
    recognition.onerror = () => {
      setListening(false);
      setError(
        "Microphone recognition is optional and may use a browser service. Use Play Preset Voice Demo instead.",
      );
    };
    recognition.onend = () => {
      setListening(false);
      recognitionRef.current = null;
    };
    recognition.start();
  }, [submitCommand]);

  useEffect(() => {
    if (appMode !== "demo") {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      void refresh();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [appMode, refresh]);

  useEffect(() => {
    document.documentElement.dataset.presentationMode = presentationMode ? "true" : "false";
    return () => {
      delete document.documentElement.dataset.presentationMode;
    };
  }, [presentationMode]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") cancelListening();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancelListening]);

  useEffect(() => {
    if (appMode !== "demo") return undefined;
    let cancelled = false;
    let timer: number | undefined;
    async function loop() {
      const currentEnvelope = envelopeRef.current;
      const snapshot = currentEnvelope?.snapshot;
      const hidden = document.visibilityState === "hidden";
      const delay = errorRef.current ? 8_000 : pollDelay(snapshot, hidden);
      timer = window.setTimeout(async () => {
        if (cancelled) return;
        const current = envelopeRef.current;
        const canTick =
          current?.workerHealthy !== false &&
          current?.allowedActions.includes("tick") &&
          current.snapshot.status === "running" &&
          document.visibilityState !== "hidden";
        if (canTick && current) {
          await run("tick", { speedMode: current.snapshot.speedMode });
        } else {
          await refresh();
        }
        if (!cancelled) void loop();
      }, delay);
    }
    void loop();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [appMode, refresh, run]);

  const value = useMemo<GuidedDemoContextValue>(
    () => ({
      envelope,
      error,
      loading,
      listening,
      presentationMode,
      reportOpen,
      transcript,
      setPresentationMode,
      setReportOpen,
      refresh,
      run,
      appMode,
      playPresetVoice,
      listenWithMicrophone,
      cancelListening,
      submitCommand,
    }),
    [
      appMode,
      cancelListening,
      envelope,
      error,
      listenWithMicrophone,
      loading,
      listening,
      playPresetVoice,
      presentationMode,
      refresh,
      reportOpen,
      run,
      submitCommand,
      transcript,
    ],
  );

  return (
    <GuidedDemoContext.Provider value={value}>
      <span className="bea-sr-only">{displayName}</span>
      {children}
    </GuidedDemoContext.Provider>
  );
}

export function useGuidedDemo(): GuidedDemoContextValue {
  const value = useContext(GuidedDemoContext);
  if (!value) {
    return {
      envelope: null,
      error: null,
      loading: false,
      listening: false,
      presentationMode: false,
      reportOpen: false,
      transcript: null,
      appMode: "demo",
      setPresentationMode: () => undefined,
      setReportOpen: () => undefined,
      refresh: async () => undefined,
      run: async () => null,
      playPresetVoice: async () => undefined,
      listenWithMicrophone: async () => undefined,
      cancelListening: () => undefined,
      submitCommand: async () => undefined,
    };
  }
  return value;
}

export function GuidedDemoStatusBar() {
  const { envelope, presentationMode, setPresentationMode, run } = useGuidedDemo();
  const snapshot = envelope?.snapshot;
  const stageTitle = snapshot?.currentStageKey
    ? GUIDED_DEMO_STAGE_BY_KEY[snapshot.currentStageKey].title
    : "Not started";
  const canReset = envelope?.allowedActions.includes("reset") === true;
  return (
    <div className="bea-demo-status-bar" data-testid="guided-demo-status-bar">
      <span className="bea-badge bea-badge--warning">Synthetic Demo</span>
      <span>
        Meridian Demo · {snapshot?.status.replaceAll("_", " ") ?? "unavailable"} · {stageTitle}
      </span>
      <button
        type="button"
        className="bea-button bea-button--ghost bea-button--small"
        data-testid="presentation-mode-toggle"
        aria-pressed={presentationMode}
        onClick={() => setPresentationMode(!presentationMode)}
      >
        Presentation Mode
      </button>
      {canReset ? (
        <Button
          size="small"
          variant="secondary"
          data-testid="reset-meridian-demo"
          onClick={() => void run("reset")}
        >
          Reset story
        </Button>
      ) : null}
    </div>
  );
}

export function DemoActivityFeed({ events }: { events: GuidedDemoSnapshot["recentEvents"] }) {
  return (
    <ol
      className="bea-demo-activity"
      data-testid="demo-activity-feed"
      aria-label="Demonstration activity"
    >
      {events.slice(0, 12).map((event) => (
        <li key={event.id}>
          <strong>{event.plainLanguageMessage}</strong>
          <small>
            {event.stageKey ? GUIDED_DEMO_STAGE_BY_KEY[event.stageKey].title : "Story"} ·{" "}
            {new Date(event.createdAt).toLocaleTimeString("en-US", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </small>
        </li>
      ))}
    </ol>
  );
}

export function HumanDecisionCard() {
  const { envelope, presentationMode, run } = useGuidedDemo();
  const [deliveryReason, setDeliveryReason] = useState(OWNER_DELIVERY_CHANGE_DEFAULT_REASON);
  const snapshot = envelope?.snapshot;
  if (!snapshot || snapshot.status !== "waiting_for_human") return null;
  const gate = snapshot.machineState;
  const decisions = envelope.allowedDecisions;
  const title =
    gate === "waiting_roof_authorization"
      ? "Roof Access Authorization required"
      : gate === "waiting_proposal_approval"
        ? "Proposal review is waiting"
        : gate === "waiting_technical_review"
          ? "Technical review is waiting"
          : "Owner delivery authorization is waiting";
  return (
    <section
      className="bea-decision-card"
      data-testid="human-decision-card"
      aria-labelledby="decision-card-title"
    >
      <p className="bea-eyebrow">Needs your decision</p>
      <h2 id="decision-card-title">{title}</h2>
      <p>{snapshot.currentBlocker ?? snapshot.currentActivity}</p>
      <p>
        Automation paused at{" "}
        {snapshot.currentStageKey
          ? GUIDED_DEMO_STAGE_BY_KEY[snapshot.currentStageKey].title
          : "a gate"}
        . After a valid decision, the workflow continues automatically.
      </p>
      <p className="bea-decision-card__disclosure">{SYNTHETIC_DEMONSTRATION_NOTICE}</p>
      <div className="bea-decision-card__actions">
        {gate === "waiting_roof_authorization" &&
        decisions.includes("add_simulated_authorization") ? (
          <Button
            data-testid="add-simulated-authorization"
            onClick={() =>
              void run("submit_human_decision", {
                decisionKey: "add_simulated_authorization",
              })
            }
          >
            Add Simulated Authorization
          </Button>
        ) : null}
        {gate === "waiting_roof_authorization" &&
        decisions.includes("approve_simulated_management_override") ? (
          <Button
            variant="secondary"
            onClick={() =>
              void run("submit_human_decision", {
                decisionKey: "approve_simulated_management_override",
              })
            }
          >
            Approve Simulated Management Override
          </Button>
        ) : null}
        {gate === "waiting_proposal_approval" && decisions.includes("approve_proposal") ? (
          <Button data-testid="approve-proposal" onClick={() => void run("approve_proposal")}>
            Approve Proposal
          </Button>
        ) : null}
        {gate === "waiting_proposal_approval" && decisions.includes("request_proposal_changes") ? (
          <Button
            variant="secondary"
            data-testid="request-proposal-changes"
            onClick={() => void run("request_proposal_changes")}
          >
            Request Changes
          </Button>
        ) : null}
        {gate === "waiting_technical_review" && decisions.includes("approve_technical_content") ? (
          <Button
            data-testid="approve-technical-content"
            onClick={() => void run("approve_technical_content")}
          >
            Approve Technical Content
          </Button>
        ) : null}
        {gate === "waiting_technical_review" && decisions.includes("request_technical_changes") ? (
          <Button
            variant="secondary"
            data-testid="request-technical-changes"
            onClick={() => void run("request_technical_changes")}
          >
            Request Technical Changes
          </Button>
        ) : null}
        {gate === "waiting_delivery_authorization" &&
        decisions.includes("authorize_demo_delivery") ? (
          <Button
            data-testid="authorize-demo-delivery"
            onClick={() => void run("authorize_demo_delivery")}
          >
            Authorize Demonstration Delivery
          </Button>
        ) : null}
        {gate === "waiting_delivery_authorization" &&
        decisions.includes("request_delivery_changes") ? (
          <>
            <label className="bea-field" htmlFor="delivery-change-reason">
              Delivery change reason
              <textarea
                id="delivery-change-reason"
                data-testid="delivery-change-reason"
                value={
                  presentationMode && !deliveryReason.trim()
                    ? OWNER_DELIVERY_CHANGE_DEFAULT_REASON
                    : deliveryReason
                }
                onChange={(event) => setDeliveryReason(event.target.value)}
              />
            </label>
            <Button
              variant="secondary"
              data-testid="request-delivery-changes"
              onClick={() =>
                void run("request_delivery_changes", {
                  comments:
                    deliveryReason.trim() ||
                    (presentationMode ? OWNER_DELIVERY_CHANGE_DEFAULT_REASON : ""),
                })
              }
            >
              Request Delivery Changes
            </Button>
          </>
        ) : null}
        {envelope.allowedActions.includes("pause") ? (
          <Button variant="ghost" onClick={() => void run("pause")}>
            Pause Story
          </Button>
        ) : null}
      </div>
    </section>
  );
}

export function MeridianDemoController() {
  const { envelope, presentationMode, run } = useGuidedDemo();
  const snapshot = envelope?.snapshot;
  const cue = snapshot ? cueForSnapshot(snapshot) : "";
  const canStart = envelope?.allowedActions.includes("start") === true;
  const speed = snapshot?.speedMode ?? "fast";
  return (
    <div className="bea-demo-controller" data-testid="meridian-demo-controller">
      {canStart && snapshot?.status === "not_started" ? (
        <Button
          data-testid="start-meridian-demo"
          onClick={() => void run("start", { speedMode: speed })}
        >
          Start Meridian Demo
        </Button>
      ) : null}
      {envelope?.allowedActions.includes("run_to_next_decision") &&
      snapshot &&
      snapshot.status !== "completed" &&
      snapshot.status !== "not_started" ? (
        <Button
          variant="secondary"
          data-testid="run-to-next-decision"
          onClick={() => void run("run_to_next_decision", { skipDelay: true, speedMode: speed })}
        >
          Run to Next Decision
        </Button>
      ) : null}
      {envelope?.allowedActions.includes("advance_one_stage") && snapshot?.status === "running" ? (
        <Button
          variant="ghost"
          data-testid="advance-one-stage"
          onClick={() => void run("advance_one_stage")}
        >
          Advance One Stage
        </Button>
      ) : null}
      {envelope?.allowedActions.includes("pause") && snapshot?.status === "running" ? (
        <Button variant="ghost" data-testid="pause-meridian-demo" onClick={() => void run("pause")}>
          Pause
        </Button>
      ) : null}
      {envelope?.allowedActions.includes("resume") && snapshot?.status === "paused" ? (
        <Button data-testid="resume-meridian-demo" onClick={() => void run("resume")}>
          Resume
        </Button>
      ) : null}
      {envelope?.allowedActions.includes("restart") ? (
        <Button
          variant="ghost"
          data-testid="restart-meridian-demo"
          onClick={() => void run("restart")}
        >
          Restart Story
        </Button>
      ) : null}
      {envelope?.allowedActions.includes("tick") || canStart ? (
        <>
          <Button
            variant={speed === "normal" ? "secondary" : "ghost"}
            data-testid="speed-normal"
            onClick={() => void run("tick", { speedMode: "normal" })}
          >
            Normal Speed
          </Button>
          <Button
            variant={speed === "fast" ? "secondary" : "ghost"}
            data-testid="speed-fast"
            onClick={() => void run("tick", { speedMode: "fast" })}
          >
            Fast Demo Speed
          </Button>
        </>
      ) : null}
      {envelope?.allowedActions.includes("inject_failure") ? (
        <Button
          variant="ghost"
          data-testid="inject-report-failure"
          onClick={() => void run("inject_failure")}
        >
          Simulate Report Assembly Failure
        </Button>
      ) : null}
      {snapshot?.machineState === "report_assembly_failed" &&
      envelope?.allowedActions.includes("retry_failure") ? (
        <Button data-testid="retry-report-failure" onClick={() => void run("retry_failure")}>
          Retry Automation
        </Button>
      ) : null}
      {presentationMode ? (
        <>
          <p className="bea-presenter-cue" data-testid="presenter-cue">
            {cue}
          </p>
          <Button
            variant="ghost"
            data-testid="presentation-fullscreen"
            onClick={() => {
              if (document.fullscreenElement) void document.exitFullscreen();
              else void document.documentElement.requestFullscreen();
            }}
          >
            Fullscreen
          </Button>
        </>
      ) : null}
    </div>
  );
}
