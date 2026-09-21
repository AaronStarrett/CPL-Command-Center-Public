"use client";

import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@bea/ui";
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { OpenAiAdministrationPanel } from "@/components/openai-administration-panel";
import styles from "@/components/owner-live-acceptance.module.css";
import {
  OWNER_ACCEPTANCE_GUIDED_TESTS,
  OWNER_ACCEPTANCE_ROUTE_FOCUS,
  OWNER_LIVE_ACCEPTANCE_ENDPOINT,
  type OwnerLiveAcceptanceView,
} from "@/lib/owner-live-acceptance-client";
import { openAiAdministrationError } from "@/lib/openai-administration-client";

function emptyView(): OwnerLiveAcceptanceView {
  return {
    contractVersion: "phase2.1-owner-acceptance-v1",
    applicationVersion: "phase-2.1",
    gitSha: "unknown",
    ownerLiveStatus: "NOT_RUN",
    physicalConfirmable: false,
    physicalConfirmationReason: "Loading owner acceptance state.",
    provider: "demo",
    selectedModel: "",
    realtimeModel: "",
    connectionStatus: "not_configured",
    providerStatus: "SETUP_REQUIRED",
    apiKeyFingerprint: null,
    lastTestLatencyMs: null,
    syntheticDataDisclosure:
      "Records in this runtime are synthetic BEA demonstration data until Owner's real systems are separately authorized.",
    externalIntegrations: "NOT CONNECTED",
    technicalEvidence: [],
    physicalObservations: [],
    chargeableCallWarning:
      "This page does not call OpenAI when it loads. Live actions require an explicit owner click.",
  };
}

export function OwnerLiveAcceptanceCenter({
  administration,
}: {
  readonly administration?: ReactNode;
}) {
  const [view, setView] = useState<OwnerLiveAcceptanceView>(emptyView);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(OWNER_LIVE_ACCEPTANCE_ENDPOINT, {
      headers: { Accept: "application/json" },
      signal,
    });
    if (!response.ok) throw await openAiAdministrationError(response);
    setView((await response.json()) as OwnerLiveAcceptanceView);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(OWNER_LIVE_ACCEPTANCE_ENDPOINT, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw await openAiAdministrationError(response);
        return (await response.json()) as OwnerLiveAcceptanceView;
      })
      .then((next) => {
        setView(next);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : "Owner acceptance could not load.");
      });
    return () => controller.abort();
  }, []);

  async function confirm(observationId: string) {
    setBusyId(observationId);
    setError(null);
    try {
      const response = await fetch(OWNER_LIVE_ACCEPTANCE_ENDPOINT, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ observationId, confirmed: true }),
      });
      if (!response.ok) throw await openAiAdministrationError(response);
      setView((await response.json()) as OwnerLiveAcceptanceView);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Confirmation was rejected.");
    } finally {
      setBusyId(null);
    }
  }

  async function copyPrompt(id: string, prompt: string) {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopiedId(id);
    } catch {
      setCopiedId(id);
    }
  }

  return (
    <div className={styles.panel} data-testid="owner-live-acceptance-center">
      <Alert tone="warning" title="Owner live status: NOT RUN">
        Cursor Cloud and CI did not use a real OpenAI key. Physical observations stay{" "}
        <strong>NOT RUN</strong> until you confirm them after a live session on this computer.
      </Alert>
      <Alert tone="info" title="Synthetic demonstration data">
        {view.syntheticDataDisclosure} External integrations: {view.externalIntegrations}.{" "}
        {view.chargeableCallWarning}
      </Alert>

      <section className={styles.intro}>
        <span className="bea-eyebrow">Guided setup</span>
        <h2>Six steps, then a live demonstration</h2>
        <p>
          Use the existing OpenAI provider panel on this page. The key is never shown after you save
          it. Do not paste it into Cursor, Terminal, PowerShell, or a file.
        </p>
        <div className={styles.grid} data-testid="owner-acceptance-safe-status">
          <div className={styles.item}>
            <span>Provider</span>
            <strong>{view.providerStatus}</strong>
            <small>Fingerprint {view.apiKeyFingerprint ?? "not stored in this view"}</small>
          </div>
          <div className={styles.item}>
            <span>Safe connection latency</span>
            <strong>{view.lastTestLatencyMs ?? "—"} ms</strong>
            <small>Shown only after Test connection succeeds</small>
          </div>
          <div className={styles.item}>
            <span>Application version</span>
            <strong>{view.applicationVersion}</strong>
            <small>{view.gitSha}</small>
          </div>
        </div>
      </section>

      <section className={styles.steps} aria-labelledby="owner-acceptance-steps">
        <h2 id="owner-acceptance-steps">Owner setup steps</h2>
        <article className={styles.step}>
          <span className="bea-eyebrow">Step 1</span>
          <h3>OpenAI Provider</h3>
          <p>
            Enter a project-scoped key in <strong>OpenAI API key</strong>, choose{" "}
            <strong>Save protected key</strong> or <strong>Replace key</strong>, then{" "}
            <strong>Test connection</strong>. Use <strong>Disconnect OpenAI</strong> to remove the
            key. The saved key is never displayed.
          </p>
        </article>
        <article className={styles.step}>
          <span className="bea-eyebrow">Step 2</span>
          <h3>Model Discovery</h3>
          <p>
            Click <strong>Refresh models</strong>. Only models from the authenticated OpenAI project
            appear. Unavailable capabilities stay fail-closed.
          </p>
        </article>
        <article className={styles.step}>
          <span className="bea-eyebrow">Step 3</span>
          <h3>Route configuration</h3>
          <p>
            Configure these routes in the OpenAI provider panel routing table, then{" "}
            <strong>Save settings</strong>. The table shows Primary, Fallback, Tools, Status,
            required capabilities, and cost class.
          </p>
          <ul className={styles.stepList}>
            {OWNER_ACCEPTANCE_ROUTE_FOCUS.map((route) => (
              <li key={route.routeKey}>
                <strong>{route.profileLabel}</strong> — {route.capabilityHint}
              </li>
            ))}
          </ul>
        </article>
        <article className={styles.step}>
          <span className="bea-eyebrow">Step 4</span>
          <h3>Web Search</h3>
          <p>
            Enable the <strong>Web search</strong> tool only after you accept chargeable public-web
            use. Request limits stay visible in the panel. Citations appear only after a real Web
            Search call, not when this page loads.
          </p>
        </article>
        <article className={styles.step}>
          <span className="bea-eyebrow">Step 5</span>
          <h3>Voice</h3>
          <p>
            Select a discovered <strong>Realtime model</strong> and <strong>Realtime voice</strong>,
            then Save settings and <strong>Activate OpenAI</strong>. On AI Command, turn{" "}
            <strong>Speak responses: On</strong>. The microphone is requested only after{" "}
            <strong>Start live voice</strong>. This page does not start the microphone.
          </p>
        </article>
        <article className={styles.step}>
          <span className="bea-eyebrow">Step 6</span>
          <h3>Guided test</h3>
          <p>
            Copy a prompt, open AI Command, and run it yourself. No live call starts from this
            checklist.
          </p>
          <div className={styles.actions}>
            <Button variant="secondary" onClick={() => void load()}>
              Refresh evidence
            </Button>
            <Link className="bea-button bea-button--secondary" href="/ai-command">
              Open AI Command
            </Link>
            <Link className="bea-button bea-button--secondary" href="/integrations/ai">
              Configure OpenAI
            </Link>
          </div>
        </article>
      </section>

      {administration ?? <OpenAiAdministrationPanel />}

      <Card className={styles.guided} data-testid="owner-acceptance-guided-tests">
        <CardHeader>
          <CardTitle>Guided Owner demonstration</CardTitle>
          <p>Expected outcomes are observations, not hardcoded answers.</p>
        </CardHeader>
        <CardContent className={styles.steps}>
          {OWNER_ACCEPTANCE_GUIDED_TESTS.map((test) => (
            <article className={styles.step} key={test.id}>
              <h3>{test.title}</h3>
              <p className={styles.prompt}>{test.prompt}</p>
              <p>{test.expected}</p>
              <div className={styles.actions}>
                <Button
                  variant="secondary"
                  data-testid={`owner-acceptance-copy-${test.id}`}
                  onClick={() => void copyPrompt(test.id, test.prompt)}
                >
                  {copiedId === test.id ? "Prompt copied" : "Copy prompt"}
                </Button>
                <Link className="bea-button bea-button--secondary" href="/ai-command">
                  Open AI Command
                </Link>
              </div>
            </article>
          ))}
          <article className={styles.step}>
            <h3>TEST E — Scroll and click</h3>
            <p>
              While the AI speaks, scroll through findings, confirm voice continues, click a source,
              confirm voice continues, then select <strong>Follow narration</strong> and confirm the
              view returns to the currently spoken section.
            </p>
          </article>
          <article className={styles.step}>
            <h3>TEST F — Stop Voice</h3>
            <p>
              Click <strong>Stop</strong> on AI Command. The response should cancel, output should
              clear, the microphone should release, the Realtime session should stop, and the visual
              evidence should remain.
            </p>
          </article>
        </CardContent>
      </Card>

      <Card data-testid="owner-acceptance-checklist">
        <CardHeader>
          <CardTitle>Owner confirmation checklist</CardTitle>
        </CardHeader>
        <CardContent className={styles.checklist}>
          <p>
            Technical rows are server evidence. They are not owner-live PASS from Cloud. Physical
            rows require your explicit confirmation on Local Live.
          </p>
          <div className={styles.grid} data-testid="owner-acceptance-technical">
            {view.technicalEvidence.map((item) => (
              <div className={styles.item} key={item.id}>
                <span>{item.label}</span>
                <strong>Owner live: {item.ownerLiveStatus}</strong>
                <small>Server evidence: {item.serverEvidence}</small>
              </div>
            ))}
          </div>
          <div className={styles.grid} data-testid="owner-acceptance-physical">
            {view.physicalObservations.map((item) => (
              <div className={styles.item} key={item.id} data-status={item.status}>
                <span>{item.label}</span>
                <Badge tone={item.status === "CONFIRMED" ? "success" : "warning"}>
                  {item.status}
                </Badge>
                <small>
                  {item.confirmedAt
                    ? `Recorded ${new Date(item.confirmedAt).toLocaleString("en-US")}`
                    : view.physicalConfirmationReason}
                </small>
                <Button
                  data-testid={`owner-acceptance-confirm-${item.id}`}
                  disabled={!view.physicalConfirmable || item.status === "CONFIRMED"}
                  busy={busyId === item.id}
                  onClick={() => void confirm(item.id)}
                >
                  I confirm this observation
                </Button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      {error ? (
        <Alert tone="danger" title="Owner acceptance">
          {error}
        </Alert>
      ) : null}
    </div>
  );
}
