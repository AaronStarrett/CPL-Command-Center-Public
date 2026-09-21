"use client";

import {
  GUIDED_DEMO_STAGES,
  GUIDED_DEMO_TRUTH_LABELS,
  SYNTHETIC_DEMONSTRATION_NOTICE,
  type GuidedDemoNodeStatus,
  type GuidedDemoStageKey,
} from "@bea/domain";
import { Button, useMotionPreferences } from "@bea/ui";
import { useEffect, useMemo, useState } from "react";

import {
  DemoActivityFeed,
  HumanDecisionCard,
  MeridianDemoController,
  useGuidedDemo,
} from "@/components/guided-demo-runtime";
import { relatedRecordHref, truthLabelForStage } from "@/lib/guided-demo-presentation";
import styles from "@/components/phase34a.module.css";

const NODE_LAYOUT: Readonly<Record<GuidedDemoStageKey, { x: number; y: number }>> = {
  lead_intake: { x: 24, y: 64 },
  information_check: { x: 292, y: 64 },
  proposal: { x: 560, y: 64 },
  customer_decision: { x: 828, y: 64 },
  project_setup: { x: 24, y: 248 },
  inspection: { x: 292, y: 248 },
  data_validation: { x: 560, y: 248 },
  report_assembly: { x: 24, y: 432 },
  technical_review: { x: 292, y: 432 },
  executive_approval: { x: 560, y: 432 },
  client_delivery: { x: 828, y: 432 },
  billing_closeout: { x: 1096, y: 432 },
};

const EDGES: readonly [GuidedDemoStageKey, GuidedDemoStageKey][] = [
  ["lead_intake", "information_check"],
  ["information_check", "proposal"],
  ["proposal", "customer_decision"],
  ["customer_decision", "project_setup"],
  ["project_setup", "inspection"],
  ["inspection", "data_validation"],
  ["data_validation", "report_assembly"],
  ["report_assembly", "technical_review"],
  ["technical_review", "executive_approval"],
  ["executive_approval", "client_delivery"],
  ["client_delivery", "billing_closeout"],
];

function statusLabel(status: GuidedDemoNodeStatus): string {
  if (status === "human_decision_required") return "Human decision required";
  if (status === "guided_demonstration_only") return "Guided stage";
  return status.replaceAll("_", " ");
}

export function AutomationFlowCanvas() {
  const { envelope, run } = useGuidedDemo();
  const motion = useMotionPreferences();
  const [selected, setSelected] = useState<GuidedDemoStageKey | null>(null);
  const [listView, setListView] = useState(false);
  const [showRoles, setShowRoles] = useState(false);
  const [overview, setOverview] = useState(false);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const snapshot = envelope?.snapshot;
  const selectedDef = selected ? GUIDED_DEMO_STAGES.find((stage) => stage.key === selected) : null;
  const selectedStage = selected
    ? (snapshot?.stages.find((stage) => stage.stageKey === selected) ?? {
        stageKey: selected,
        stageOrder: selectedDef?.order ?? 0,
        status: "waiting" as const,
        backingType: selectedDef?.backingType ?? "guided_demonstration",
        ownerRoleKey: selectedDef?.ownerRoleKey ?? "system",
        currentActivity: selectedDef?.activities[0] ?? null,
        inputSummary: {},
        outputSummary: {},
        linkedRecords: {},
        startedAt: null,
        completedAt: null,
        failedAt: null,
      })
    : null;

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setSelected(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const activeEdge = useMemo(() => {
    if (!snapshot || snapshot.status !== "running" || !snapshot.currentStageKey) return null;
    return EDGES.find((edge) => edge[1] === snapshot.currentStageKey) ?? null;
  }, [snapshot]);

  return (
    <div className={styles.flowPage} data-page="automation-flow">
      <p className={styles.notice}>{SYNTHETIC_DEMONSTRATION_NOTICE}</p>
      <header className={styles.flowHeader}>
        <div>
          <p className={styles.eyebrow}>Automation Flow</p>
          <h1>{overview ? "Process overview" : "Meridian run"}</h1>
        </div>
        <div className={styles.flowTools}>
          <Button variant="secondary" onClick={() => setOverview((value) => !value)}>
            {overview ? "Meridian Run" : "Process Overview"}
          </Button>
          <Button variant="ghost" onClick={() => setShowRoles((value) => !value)}>
            {showRoles ? "Hide roles" : "Show roles"}
          </Button>
          <Button
            variant="ghost"
            data-testid="workflow-list-fallback"
            onClick={() => setListView((value) => !value)}
          >
            {listView ? "Canvas view" : "List view"}
          </Button>
          <Button
            variant="ghost"
            data-testid="fit-workflow"
            onClick={() => {
              setScale(0.82);
              setOffset({ x: 8, y: 0 });
            }}
          >
            Fit Workflow to Screen
          </Button>
          <Button
            variant="ghost"
            data-testid="center-current-stage"
            onClick={() => {
              const current = snapshot?.currentStageKey;
              if (!current) return;
              const layout = NODE_LAYOUT[current];
              setOffset({ x: 180 - layout.x, y: 80 - layout.y });
              setScale(1);
            }}
          >
            Center current stage
          </Button>
          <Button
            variant="ghost"
            data-testid="reset-workflow-view"
            onClick={() => {
              setScale(1);
              setOffset({ x: 0, y: 0 });
            }}
          >
            Reset view
          </Button>
          <Button
            variant="ghost"
            data-testid="zoom-in"
            onClick={() => setScale((value) => Math.min(1.4, value + 0.1))}
          >
            Zoom in
          </Button>
          <Button
            variant="ghost"
            data-testid="zoom-out"
            onClick={() => setScale((value) => Math.max(0.6, value - 0.1))}
          >
            Zoom out
          </Button>
        </div>
      </header>
      <MeridianDemoController />
      <HumanDecisionCard />
      {listView || snapshot === undefined ? (
        <ol
          className={styles.stageList}
          data-testid="workflow-list"
          aria-label="Business workflow stages"
        >
          {(
            snapshot?.stages ??
            GUIDED_DEMO_STAGES.map((stage, index) => ({
              stageKey: stage.key,
              stageOrder: index + 1,
              status: "waiting" as const,
              backingType: stage.backingType,
              ownerRoleKey: stage.ownerRoleKey,
              currentActivity: stage.activities[0] ?? null,
              inputSummary: {},
              outputSummary: {},
              linkedRecords: {},
              startedAt: null,
              completedAt: null,
              failedAt: null,
            }))
          ).map((stage) => {
            const definition = GUIDED_DEMO_STAGES.find((item) => item.key === stage.stageKey)!;
            return (
              <li key={stage.stageKey}>
                <button
                  type="button"
                  data-testid={`workflow-list-stage-${stage.stageKey}`}
                  onClick={() => setSelected(stage.stageKey)}
                >
                  <strong>{definition.title}</strong>
                  <span>{statusLabel(stage.status)}</span>
                  <span>{stage.currentActivity ?? definition.activities[0]}</span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className={styles.canvasWrap} data-testid="automation-flow-canvas">
          <div
            className={styles.canvasStage}
            style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
          >
            <svg
              className={styles.canvas}
              viewBox="0 0 1360 620"
              role="img"
              aria-label="Meridian business workflow"
            >
              {EDGES.map(([from, to]) => {
                const start = NODE_LAYOUT[from];
                const end = NODE_LAYOUT[to];
                const active = activeEdge?.[0] === from && activeEdge[1] === to;
                const completed =
                  snapshot.stages.find((stage) => stage.stageKey === from)?.status === "completed";
                return (
                  <g key={`${from}-${to}`}>
                    <line
                      x1={start.x + 236}
                      y1={start.y + 58}
                      x2={end.x}
                      y2={end.y + 58}
                      className={
                        active
                          ? styles.edgeActive
                          : completed
                            ? styles.edgeComplete
                            : styles.edgeWaiting
                      }
                    />
                    {active && motion.profile === "full" && motion.pageVisible ? (
                      <circle r="7" className={styles.packet} data-testid="data-packet">
                        <animateMotion
                          dur="1.6s"
                          repeatCount="indefinite"
                          path={`M${start.x + 236},${start.y + 58} L${end.x},${end.y + 58}`}
                        />
                      </circle>
                    ) : null}
                  </g>
                );
              })}
            </svg>
            {GUIDED_DEMO_STAGES.map((definition) => {
              const state = snapshot.stages.find((stage) => stage.stageKey === definition.key);
              const layout = NODE_LAYOUT[definition.key];
              const status = overview ? "waiting" : (state?.status ?? "waiting");
              return (
                <button
                  key={definition.key}
                  type="button"
                  className={styles.node}
                  data-status={status}
                  data-stage={definition.key}
                  data-testid={`flow-node-${definition.key}`}
                  style={{ left: layout.x, top: layout.y }}
                  onClick={() => setSelected(definition.key)}
                >
                  <span className={styles.nodeTitle}>{definition.title}</span>
                  <span className={styles.nodeStatus}>{statusLabel(status)}</span>
                  <span className={styles.nodeActivity}>
                    {status === "processing" ? (
                      <span className={styles.spinner} aria-hidden="true" />
                    ) : null}
                    {state?.currentActivity ?? definition.activities[0]}
                  </span>
                  {showRoles ? (
                    <span className={styles.nodeMeta}>{definition.ownerRoleKey}</span>
                  ) : null}
                  <span className={styles.nodeMeta}>
                    {overview
                      ? GUIDED_DEMO_TRUTH_LABELS[definition.backingType]
                      : status === "human_decision_required"
                        ? "Human action"
                        : definition.packetLabel}
                  </span>
                </button>
              );
            })}
            <p className={styles.groupLabel} style={{ left: 24, top: 24 }}>
              Intake & commercial
            </p>
            <p className={styles.groupLabel} style={{ left: 24, top: 208 }}>
              Project & field
            </p>
            <p className={styles.groupLabel} style={{ left: 24, top: 392 }}>
              Reporting & delivery
            </p>
          </div>
        </div>
      )}
      {snapshot ? <DemoActivityFeed events={snapshot.recentEvents} /> : null}
      {selected && selectedDef && selectedStage ? (
        <aside
          className={styles.drawer}
          data-testid="node-detail-drawer"
          aria-label={`${selectedDef.title} details`}
        >
          <header>
            <h2>{selectedDef.title}</h2>
            <button type="button" onClick={() => setSelected(null)} aria-label="Close details">
              Close
            </button>
          </header>
          <p>Status: {statusLabel(selectedStage.status)}</p>
          <p>Current activity: {selectedStage.currentActivity ?? "Waiting"}</p>
          <p>What entered this stage: {selectedDef.packetLabel}</p>
          <p>What the automation did: {selectedDef.activities.join(". ")}</p>
          <p>Current owner: {selectedDef.ownerRoleKey}</p>
          <p>Started: {selectedStage.startedAt ?? "Not started"}</p>
          <p>Completed: {selectedStage.completedAt ?? "In progress"}</p>
          <p>Runtime truth: {GUIDED_DEMO_TRUTH_LABELS[selectedStage.backingType]}</p>
          <p>{selectedDef.truthDetail}</p>
          <p>{truthLabelForStage(selectedDef.key)}</p>
          {relatedRecordHref("lead", snapshot?.recordBindings.leadId) ? (
            <a href={relatedRecordHref("lead", snapshot?.recordBindings.leadId)!}>Open Lead</a>
          ) : null}
          {relatedRecordHref("proposal", snapshot?.recordBindings.proposalId) ? (
            <a href={relatedRecordHref("proposal", snapshot?.recordBindings.proposalId)!}>
              Open Proposal
            </a>
          ) : null}
          {relatedRecordHref("inspection", snapshot?.recordBindings.inspectionId) ? (
            <a href={relatedRecordHref("inspection", snapshot?.recordBindings.inspectionId)!}>
              Open Inspection
            </a>
          ) : null}
          {relatedRecordHref("report", snapshot?.recordBindings.reportId) ? (
            <a href={relatedRecordHref("report", snapshot?.recordBindings.reportId)!}>
              Open Report
            </a>
          ) : null}
          {selectedDef.key === "report_assembly" &&
          envelope?.allowedActions.includes("inject_failure") ? (
            <Button variant="secondary" onClick={() => void run("inject_failure")}>
              Simulate Report Assembly Failure
            </Button>
          ) : null}
        </aside>
      ) : null}
    </div>
  );
}
