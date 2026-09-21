"use client";

import {
  GUIDED_DEMO_PRESET_VOICE_PHRASE,
  GUIDED_DEMO_SIMULATED_COMMAND_LABEL,
  GUIDED_DEMO_STAGE_BY_KEY,
  SYNTHETIC_DEMONSTRATION_NOTICE,
} from "@bea/domain";
import { Button, useMotionPreferences } from "@bea/ui";
import { useSyncExternalStore } from "react";

import {
  DemoActivityFeed,
  HumanDecisionCard,
  MeridianDemoController,
  useGuidedDemo,
} from "@/components/guided-demo-runtime";
import { MeridianReportWorkspace } from "@/components/meridian-report-workspace";
import styles from "@/components/phase34a.module.css";

const SUGGESTED = [
  GUIDED_DEMO_PRESET_VOICE_PHRASE,
  "What is waiting on me?",
  "Where is the workflow?",
  "What happens after I approve?",
] as const;

export function CommandCenterExperience() {
  const {
    envelope,
    error,
    listening,
    reportOpen,
    transcript,
    appMode,
    playPresetVoice,
    listenWithMicrophone,
    cancelListening,
    submitCommand,
    setReportOpen,
  } = useGuidedDemo();
  const motion = useMotionPreferences();
  const snapshot = envelope?.snapshot;
  const greetingName = envelope?.displayName ?? "Owner";
  const split = reportOpen && Boolean(envelope?.report || envelope?.command?.openReport);
  const gate = snapshot?.status === "waiting_for_human";
  const microphoneAvailable = useSyncExternalStore(
    () => () => undefined,
    () => "SpeechRecognition" in window || "webkitSpeechRecognition" in window,
    () => false,
  );

  return (
    <div
      className={styles.commandPage}
      data-page="command-center"
      data-split={split ? "true" : "false"}
      data-listening={listening ? "true" : "false"}
      data-reduced={motion.profile === "reduced" ? "true" : "false"}
    >
      <p className={styles.notice}>{SYNTHETIC_DEMONSTRATION_NOTICE}</p>
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      {appMode === "production" || envelope?.productionMode ? (
        <section className={styles.empty} data-testid="guided-demo-unavailable">
          <h1>Guided demonstration unavailable</h1>
          <p>The Meridian story is demo-only and is not available in this runtime.</p>
        </section>
      ) : null}
      {envelope && envelope.workerHealthy === false ? (
        <section className={styles.empty} data-testid="worker-unavailable">
          <h1>Automation worker is unavailable. The demonstration has paused safely.</h1>
          <p>
            Retry the health check from the demonstration controls. Do not continue as if work is
            running.
          </p>
        </section>
      ) : null}
      <div className={styles.commandSplit}>
        <section className={styles.conversation} aria-labelledby="command-heading">
          <p className={styles.eyebrow}>Command Center</p>
          <h1 id="command-heading">Good day, {greetingName}.</h1>
          <p className={styles.prompt}>What would you like to review?</p>
          <div
            className={styles.orb}
            data-testid="bea-orb"
            data-state={listening ? "listening" : split ? "docked" : "idle"}
            aria-label={listening ? "Listening" : "BEA command orb"}
          >
            <span className={styles.orbCore} />
            {listening ? <span className={styles.listeningLabel}>Listening…</span> : null}
          </div>
          <p className={styles.simulated}>{GUIDED_DEMO_SIMULATED_COMMAND_LABEL}</p>
          {snapshot ? (
            <p data-testid="command-center-status">
              {gate
                ? "Meridian Commerce Center needs your decision"
                : snapshot.status === "not_started"
                  ? "Meridian Commerce Center is ready to start."
                  : `Currently at ${snapshot.currentStageKey ? GUIDED_DEMO_STAGE_BY_KEY[snapshot.currentStageKey].title : "Not started"}. ${snapshot.currentActivity ?? ""}`}
            </p>
          ) : null}
          {gate && !split ? <HumanDecisionCard /> : null}
          <MeridianDemoController />
          <div className={styles.commands}>
            {SUGGESTED.map((command) => (
              <button
                key={command}
                type="button"
                className={styles.chip}
                onClick={() => void submitCommand(command)}
              >
                {command}
              </button>
            ))}
          </div>
          <div className={styles.voiceRow}>
            <Button data-testid="play-preset-voice-demo" onClick={() => void playPresetVoice()}>
              Play Preset Voice Demo
            </Button>
            {microphoneAvailable ? (
              <Button
                variant="secondary"
                data-testid="use-microphone"
                onClick={() => (listening ? cancelListening() : void listenWithMicrophone())}
              >
                {listening ? "Stop microphone" : "Use Microphone"}
              </Button>
            ) : null}
          </div>
          <p className={styles.notice}>
            Microphone recognition is optional and may use a browser service. The preset path is
            simulated and does not require a microphone.
          </p>
          {transcript ? <blockquote data-testid="voice-transcript">{transcript}</blockquote> : null}
          {envelope?.command ? (
            <div className={styles.response} data-testid="simulated-command-response">
              <p>{envelope.command.message}</p>
            </div>
          ) : null}
          {snapshot ? <DemoActivityFeed events={snapshot.recentEvents} /> : null}
        </section>
        {split ? <MeridianReportWorkspace onClose={() => setReportOpen(false)} /> : null}
      </div>
    </div>
  );
}
