import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommandCenterExperience } from "../../apps/web/components/command-center-experience";
import { CompanyDetailsExperience } from "../../apps/web/components/company-details-experience";
import { AutomationFlowCanvas } from "../../apps/web/components/automation-flow-canvas";
import {
  GuidedDemoRuntime,
  GuidedDemoStatusBar,
} from "../../apps/web/components/guided-demo-runtime";
import { MeridianReportWorkspace } from "../../apps/web/components/meridian-report-workspace";
import { DesktopNavigation } from "../../apps/web/components/navigation";
import type { GuidedDemoEnvelope } from "../../apps/web/lib/guided-demo-client";
import {
  GUIDED_DEMO_PRESET_VOICE_PHRASE,
  GUIDED_DEMO_SCENARIO_KEY,
  GUIDED_DEMO_SCENARIO_VERSION,
  GUIDED_DEMO_SIMULATED_COMMAND_LABEL,
  GUIDED_DEMO_STAGES,
  SYNTHETIC_DEMONSTRATION_NOTICE,
  meridianReportWorkspaceDocument,
  type GuidedMeridianReportView,
} from "../../packages/domain/src/index.js";
import { setTestPathname } from "./stubs/next-navigation";

function stageStates(
  statusByKey: Partial<Record<(typeof GUIDED_DEMO_STAGES)[number]["key"], string>>,
) {
  return GUIDED_DEMO_STAGES.map((stage) => ({
    stageKey: stage.key,
    stageOrder: stage.order,
    status: statusByKey[stage.key] ?? "waiting",
    backingType: stage.backingType,
    ownerRoleKey: stage.ownerRoleKey,
    currentActivity: stage.activities[0] ?? null,
    inputSummary: {},
    outputSummary: {},
    linkedRecords: {},
    startedAt: null,
    completedAt: null,
    failedAt: null,
  }));
}

function sampleWorkspace(
  versionNumber = 1,
  overrides: Partial<GuidedMeridianReportView> = {},
): GuidedMeridianReportView {
  const document = meridianReportWorkspaceDocument(versionNumber);
  return {
    reportId: "r1",
    reportReference: "BEA-RP-000100",
    reportStatus: "in_review",
    versionId: `v${versionNumber}`,
    versionNumber,
    versionStatus: "in_review",
    inspectionId: "i1",
    inspectionReference: "BEA-IN-000100",
    inspectionCompletedAt: "2026-09-03T12:00:00.000Z",
    projectId: "p1",
    projectReference: "BEA-PR-000100",
    projectName: document.project,
    clientName: document.client,
    contactName: document.contactName,
    contactTitle: document.contactTitle,
    title: document.title,
    versionMarker: document.versionMarker,
    syntheticNotice: document.syntheticNotice,
    executiveSummary: document.executiveSummary,
    propertyDetails: document.propertyDetails,
    scope: document.scope,
    documentsReviewed: [...document.documentsReviewed],
    observedConditions: document.observedConditions,
    findings: document.findings.map((finding, index) => ({
      id: `finding-${index + 1}`,
      code: finding.code,
      title: finding.title,
      priority: finding.priority,
      observation: finding.observation,
      recommendation: finding.recommendation,
      evidenceIds: [`evidence-${index + 1}`],
    })),
    evidence: document.evidence.map((item, index) => ({
      id: `evidence-${index + 1}`,
      label: item.label,
      caption: item.caption,
      filename: item.filename,
      findingCode: item.findingCode,
      storageRef: `synthetic://meridian/inspection/${versionNumber}/${index + 1}`,
      kind: "photo",
    })),
    recommendations: document.recommendations,
    repairPriorities: document.repairPriorities.map((item) => ({ ...item })),
    limitations: document.limitations,
    reviewUpdate: document.reviewUpdate,
    reviewHistory: [
      {
        versionId: `v${versionNumber}`,
        versionNumber,
        decision: null,
        comment: null,
        reviewedAt: null,
        reviewerUserId: null,
        historical: false,
      },
    ],
    approvalStatus: `Version ${versionNumber} is awaiting technical review.`,
    technicallyApproved: false,
    deliveryAuthorizationStatus: null,
    deliveryStatus: "Delivery is not authorized for this Report version.",
    deliveryConfirmed: false,
    recipient: "elena.torres@meridian-property.invalid",
    artifactChecksum: "abc123def456",
    artifactFilename: `BEA-RP-000100-v${versionNumber}.pdf`,
    artifactStorageRef: "synthetic://report/BEA-RP-000100",
    findingCount: 3,
    highPriorityCount: 2,
    mediumPriorityCount: 1,
    evidenceCount: 12,
    sources: [
      { key: "report", label: "Report", sectionId: "cover", recordId: "r1" },
      { key: "inspection", label: "Inspection", sectionId: "property", recordId: "i1" },
      { key: "findings", label: "Findings", sectionId: "findings", recordId: `v${versionNumber}` },
      {
        key: "review",
        label: "Review History",
        sectionId: "review-history",
        recordId: `v${versionNumber}`,
      },
      { key: "delivery", label: "Delivery Status", sectionId: "delivery-status", recordId: "r1" },
      { key: "flow", label: "Automation Flow", href: "/automation-flow" },
    ],
    ...overrides,
  };
}

function envelope(
  overrides: Partial<GuidedDemoEnvelope> = {},
  machineState = "not_started",
): GuidedDemoEnvelope {
  const snapshot = {
    id: "d3400000-0000-4000-8000-000000000001",
    scenarioKey: GUIDED_DEMO_SCENARIO_KEY,
    scenarioVersion: GUIDED_DEMO_SCENARIO_VERSION,
    status:
      machineState === "waiting_roof_authorization" ||
      machineState === "waiting_proposal_approval" ||
      machineState === "waiting_technical_review" ||
      machineState === "waiting_delivery_authorization"
        ? "waiting_for_human"
        : machineState === "not_started"
          ? "not_started"
          : machineState === "completed"
            ? "completed"
            : "running",
    machineState,
    pausedFromState: null,
    currentStageKey: machineState === "not_started" ? null : "information_check",
    currentGateKey:
      machineState === "waiting_roof_authorization" ? "add_simulated_authorization" : null,
    speedMode: "fast",
    currentActivity:
      machineState === "waiting_roof_authorization" ? "Roof Access Authorization required" : null,
    currentActivityIndex: 0,
    currentBlocker:
      machineState === "waiting_roof_authorization" ? "Roof Access Authorization is missing" : null,
    failureArmed: false,
    presentationMode: false,
    recordBindings: {},
    optimisticVersion: 1,
    startedByUserId: null,
    startedAt: null,
    pausedAt: null,
    completedAt: null,
    archivedAt: null,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    stages: stageStates(
      machineState === "waiting_roof_authorization"
        ? { lead_intake: "completed", information_check: "human_decision_required" }
        : {},
    ),
    recentEvents: [
      {
        id: "evt-1",
        sequenceNumber: 1,
        stageKey: "lead_intake",
        eventKind: "demo.started",
        plainLanguageMessage: "Website inquiry received",
        actorUserId: null,
        safeMetadata: {},
        createdAt: "2026-09-03T00:00:00.000Z",
      },
    ],
    ...((overrides.snapshot as object) ?? {}),
  };
  return {
    snapshot: snapshot as GuidedDemoEnvelope["snapshot"],
    demoAvailable: true,
    productionMode: false,
    roleKey: "owner-admin",
    displayName: "Workspace Owner",
    allowedActions: [
      "start",
      "reset",
      "run_to_next_decision",
      "tick",
      "submit_human_decision",
      "approve_proposal",
      "inject_failure",
    ],
    allowedDecisions: [
      "add_simulated_authorization",
      "approve_simulated_management_override",
      "approve_proposal",
      "request_proposal_changes",
      "approve_technical_content",
      "request_technical_changes",
      "authorize_demo_delivery",
      "request_delivery_changes",
    ],
    presentationCue: "The system found a required authorization is missing",
    workerHealthy: true,
    report: null,
    proposal: null,
    command: null,
    ...overrides,
  } as GuidedDemoEnvelope;
}

let current: GuidedDemoEnvelope;

afterEach(() => {
  cleanup();
  setTestPathname("/command-center");
  vi.unstubAllGlobals();
});

beforeEach(() => {
  current = envelope();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/command-center/demo-command")) {
        current = {
          ...current,
          command: {
            intent: "open_meridian_report",
            simulated: true,
            label: GUIDED_DEMO_SIMULATED_COMMAND_LABEL,
            message:
              "The Meridian Commerce Center report has not been assembled yet. The workflow is currently at Information Check.",
            openReport: false,
            sources: [{ key: "flow", label: "Automation Flow", href: "/automation-flow" }],
          },
        };
        return new Response(JSON.stringify(current), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/guided-demo/meridian") && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as {
          action?: string;
          decisionKey?: string;
        };
        if (body.action === "start" || body.action === "run_to_next_decision") {
          current = envelope({}, "waiting_roof_authorization");
        }
        if (body.action === "submit_human_decision") {
          current = envelope({
            snapshot: {
              ...current.snapshot,
              status: "running",
              machineState: "proposal_processing",
              currentBlocker: null,
            } as never,
          });
        }
        if (body.action === "reset") {
          current = envelope();
        }
        return new Response(JSON.stringify(current), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(current), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

function renderDemo(child: React.ReactNode) {
  return render(
    <GuidedDemoRuntime displayName="Workspace Owner" appMode="demo">
      <GuidedDemoStatusBar />
      {child}
    </GuidedDemoRuntime>,
  );
}

describe("Phase 3.4A simplified experience", () => {
  it("keeps exactly three primary navigation entries and a More drawer", async () => {
    const user = userEvent.setup();
    setTestPathname("/command-center");
    render(
      <DesktopNavigation
        primary={[
          {
            href: "/command-center",
            label: "Command Center",
            shortLabel: "C",
            permission: "home.view",
          },
          {
            href: "/automation-flow",
            label: "Automation Flow",
            shortLabel: "A",
            permission: "home.view",
          },
          {
            href: "/company-details",
            label: "Company Details",
            shortLabel: "D",
            permission: "home.view",
          },
        ]}
        secondary={[{ href: "/leads", label: "Leads", shortLabel: "L", permission: "leads.view" }]}
      />,
    );
    const navigation = screen.getByRole("navigation", { name: "Command Center navigation" });
    expect(within(navigation).getByRole("link", { name: "Command Center" })).toBeVisible();
    expect(within(navigation).getByRole("link", { name: "Automation Flow" })).toBeVisible();
    expect(within(navigation).getByRole("link", { name: "Company Details" })).toBeVisible();
    expect(within(navigation).queryByRole("link", { name: "Leads" })).toBeNull();
    await user.click(within(navigation).getByRole("button", { name: "More" }));
    expect(within(navigation).getByRole("link", { name: "Leads" })).toBeVisible();
  });

  it("renders Command Center idle state with orb and start action", async () => {
    renderDemo(<CommandCenterExperience />);
    await waitFor(() => expect(screen.getByTestId("start-meridian-demo")).toBeVisible());
    expect(screen.getByRole("heading", { name: /Good day, Workspace Owner/u })).toBeVisible();
    expect(screen.getByTestId("bea-orb")).toBeVisible();
    expect(screen.getByText(SYNTHETIC_DEMONSTRATION_NOTICE)).toBeVisible();
    expect(screen.getByText(GUIDED_DEMO_SIMULATED_COMMAND_LABEL)).toBeVisible();
    expect(screen.getByRole("button", { name: GUIDED_DEMO_PRESET_VOICE_PHRASE })).toBeVisible();
  });

  it("shows the human-gate decision card when Roof Access Authorization is missing", async () => {
    current = envelope({}, "waiting_roof_authorization");
    renderDemo(<CommandCenterExperience />);
    await waitFor(() => expect(screen.getByTestId("human-decision-card")).toBeVisible());
    expect(screen.getByText("Meridian Commerce Center needs your decision")).toBeVisible();
    expect(screen.getByTestId("add-simulated-authorization")).toBeVisible();
  });

  it("plays the preset voice transcript without an external model", async () => {
    const user = userEvent.setup();
    renderDemo(<CommandCenterExperience />);
    await waitFor(() => expect(screen.getByTestId("play-preset-voice-demo")).toBeVisible());
    await user.click(screen.getByTestId("play-preset-voice-demo"));
    expect(screen.getByTestId("bea-orb")).toHaveAttribute("data-state", "listening");
    await waitFor(() =>
      expect(screen.getByTestId("voice-transcript")).toHaveTextContent(
        GUIDED_DEMO_PRESET_VOICE_PHRASE,
      ),
    );
    await waitFor(() => expect(screen.getByTestId("simulated-command-response")).toBeVisible());
  });

  it("renders automation flow nodes, spinner treatment, and the detail drawer", async () => {
    const user = userEvent.setup();
    current = envelope(
      {
        snapshot: {
          ...envelope({}, "lead_intake_processing").snapshot,
          status: "running",
          machineState: "lead_intake_processing",
          currentStageKey: "lead_intake",
          stages: stageStates({ lead_intake: "processing" }),
        } as GuidedDemoEnvelope["snapshot"],
      },
      "lead_intake_processing",
    );
    renderDemo(<AutomationFlowCanvas />);
    await waitFor(() => expect(screen.getByTestId("flow-node-lead_intake")).toBeVisible());
    expect(screen.getByTestId("flow-node-lead_intake")).toHaveAttribute(
      "data-status",
      "processing",
    );
    await user.click(screen.getByTestId("flow-node-lead_intake"));
    expect(screen.getByTestId("node-detail-drawer")).toBeVisible();
    expect(screen.getByText("RUNTIME-BACKED")).toBeVisible();
    await user.click(screen.getByTestId("workflow-list-fallback"));
    expect(screen.getByTestId("workflow-list")).toBeVisible();
  });

  it("renders Company Details readiness without calling integrations healthy", async () => {
    renderDemo(<CompanyDetailsExperience />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Cyber Pirate Labs" })).toBeVisible(),
    );
    expect(screen.getByTestId("integration-readiness")).toHaveTextContent("Outlook: Not connected");
    expect(screen.getByTestId("integration-readiness")).toHaveTextContent("Teams: Not connected");
    expect(screen.getByText("Production Service Catalog: Unconfigured")).toBeVisible();
    expect(screen.getByTestId("automation-coverage")).toHaveTextContent("GUIDED DEMONSTRATION");
    expect(screen.getByTestId("automation-coverage")).toHaveTextContent("LOCAL TEST / NO-WRITE");
  });

  it("opens the report workspace with source chips and findings", async () => {
    current = envelope(
      {
        report: {
          id: "r1",
          reference: "BEA-RP-000100",
          versionNumber: 1,
          status: "in_review",
          versionId: "v1",
          checksumSummary: "abc123",
          workspace: sampleWorkspace(),
          workspaceError: null,
        },
        command: {
          intent: "open_meridian_report",
          simulated: true,
          label: GUIDED_DEMO_SIMULATED_COMMAND_LABEL,
          message: "I found Meridian Commerce Center Report BEA-RP-000100, Version 1.",
          openReport: true,
          sources: [
            { key: "findings", label: "Findings", sectionId: "findings" },
            { key: "flow", label: "Automation Flow", href: "/automation-flow" },
          ],
        },
      },
      "waiting_technical_review",
    );
    renderDemo(<MeridianReportWorkspace onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId("finding-F-1")).toBeVisible());
    expect(screen.getByTestId("finding-F-2")).toBeVisible();
    expect(screen.getByTestId("finding-F-3")).toBeVisible();
    expect(screen.getByTestId("source-chip-findings")).toHaveAttribute("data-record-id", "v1");
    expect(screen.getByTestId("report-version-marker")).toHaveTextContent("ORIGINAL ASSESSMENT");
    expect(screen.getByTestId("report-review-history")).toBeVisible();
    expect(screen.getByTestId("report-delivery-status")).toHaveTextContent("not authorized");
    expect(screen.getByTestId("synthetic-photo-grid").querySelectorAll("figure")).toHaveLength(12);
    expect(screen.getByTestId("finding-F-1")).toHaveTextContent(
      "Roof Membrane Puncture Near RTU-4",
    );
  });

  it("renders Version 2 review-update text from the stored projection", async () => {
    current = envelope(
      {
        report: {
          id: "r1",
          reference: "BEA-RP-000100",
          versionNumber: 2,
          status: "in_review",
          versionId: "v2",
          checksumSummary: "def456",
          workspace: sampleWorkspace(2, {
            reviewHistory: [
              {
                versionId: "v1",
                versionNumber: 1,
                decision: "approve",
                comment: null,
                reviewedAt: "2026-09-03T12:00:00.000Z",
                reviewerUserId: "ops",
                historical: true,
              },
              {
                versionId: "v2",
                versionNumber: 2,
                decision: "request_revision",
                comment: "Clarify the recommended repair priority before release.",
                reviewedAt: "2026-09-03T12:05:00.000Z",
                reviewerUserId: "owner",
                historical: false,
              },
            ],
          }),
          workspaceError: null,
        },
      },
      "waiting_technical_review",
    );
    renderDemo(<MeridianReportWorkspace onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId("report-version-marker")).toBeVisible());
    expect(screen.getByTestId("report-version-marker")).toHaveTextContent(
      "REVIEW UPDATE — Version 2",
    );
    expect(screen.getByTestId("report-review-update")).toBeVisible();
    expect(screen.getByTestId("finding-F-1")).toHaveTextContent("Review update");
    expect(screen.getByTestId("report-review-history")).toHaveTextContent("historical");
    expect(screen.getByTestId("report-review-history")).toHaveTextContent(
      "Clarify the recommended repair priority",
    );
  });

  it("shows a controlled unavailable state instead of hardcoded findings", async () => {
    current = envelope(
      {
        report: {
          id: "r1",
          reference: "BEA-RP-000100",
          versionNumber: 1,
          status: "in_review",
          versionId: "v1",
          checksumSummary: null,
          workspace: null,
          workspaceError:
            "The stored Report workspace snapshot is missing for this demonstration run.",
        },
      },
      "waiting_technical_review",
    );
    renderDemo(<MeridianReportWorkspace onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId("stored-report-unavailable")).toBeVisible());
    expect(screen.queryByTestId("finding-F-1")).toBeNull();
    expect(screen.queryByTestId("human-decision-card")).toBeNull();
    expect(screen.queryByTestId("approve-technical-content")).toBeNull();
    expect(screen.getByRole("link", { name: "Return to Automation Flow" })).toBeVisible();
  });

  it("shows Request Delivery Changes only at the Owner gate", async () => {
    current = envelope(
      {
        roleKey: "owner-admin",
        allowedDecisions: ["authorize_demo_delivery", "request_delivery_changes"],
        report: {
          id: "r1",
          reference: "BEA-RP-000100",
          versionNumber: 1,
          status: "ready_for_delivery",
          versionId: "v1",
          checksumSummary: "abc123",
          workspace: sampleWorkspace(1, {
            reportStatus: "ready_for_delivery",
            technicallyApproved: true,
          }),
          workspaceError: null,
        },
      },
      "waiting_delivery_authorization",
    );
    current.snapshot = {
      ...current.snapshot,
      status: "waiting_for_human",
      machineState: "waiting_delivery_authorization",
    };
    renderDemo(<MeridianReportWorkspace onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId("request-delivery-changes")).toBeVisible());
    expect(screen.getByTestId("delivery-change-reason")).toBeVisible();
    expect(screen.queryByTestId("request-technical-changes")).toBeNull();
  });

  it("shows presenter cue in Presentation Mode", async () => {
    const user = userEvent.setup();
    current = envelope({}, "waiting_roof_authorization");
    renderDemo(<CommandCenterExperience />);
    await waitFor(() => expect(screen.getByTestId("presentation-mode-toggle")).toBeVisible());
    await user.click(screen.getByTestId("presentation-mode-toggle"));
    expect(screen.getByTestId("presenter-cue")).toBeVisible();
  });

  it("denies the guided demonstration in production mode", async () => {
    render(
      <GuidedDemoRuntime displayName="Workspace Owner" appMode="production">
        <GuidedDemoStatusBar />
        <CommandCenterExperience />
      </GuidedDemoRuntime>,
    );
    await waitFor(() => expect(screen.getByTestId("guided-demo-unavailable")).toBeVisible());
    expect(screen.queryByTestId("start-meridian-demo")).toBeNull();
  });
});
