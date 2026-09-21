import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  GUIDED_DEMO_FEATURE_FLAG_KEY,
  GUIDED_DEMO_HUMAN_GATE_STATES,
  GUIDED_DEMO_PRESET_VOICE_PHRASE,
  GUIDED_DEMO_SCENARIO_KEY,
  GUIDED_DEMO_SCENARIO_VERSION,
  GUIDED_DEMO_SIMULATED_COMMAND_LABEL,
  GUIDED_DEMO_STAGES,
  GUIDED_DEMO_STATUS_COLORS,
  GUIDED_DEMO_TRANSITIONS,
  MERIDIAN_FINDINGS,
  OWNER_DELIVERY_CHANGE_DEFAULT_REASON,
  assertGuidedDemoReportConsistency,
  assertGuidedDemoTransition,
  GuidedDemoIntegrityError,
  gateKeyForState,
  guidedDemoRoleCanPerform,
  isAutomatedProcessingState,
  isGuidedDemoAction,
  isHumanGateState,
  mapGuidedDemoCommandResponse,
  meridianInspectionPayload,
  meridianReportWorkspaceDocument,
  normalizeOwnerDeliveryChangeReason,
  nodeStatusForMachineState,
  normalizeGuidedDemoCommand,
  presentationCueForState,
  reducedMotionConfiguration,
  routeGuidedDemoCommand,
  runStatusForMachineState,
  semanticColorForNodeStatus,
  stageKeyForMachineState,
  activityCopyForStageCompletion,
  GuidedDemoConflictError,
} from "../../packages/domain/src/index.js";

describe("Phase 3.4A guided demo domain", () => {
  it("registers the Meridian scenario, twelve stages, and backing types", () => {
    expect(GUIDED_DEMO_SCENARIO_KEY).toBe("meridian-commerce-center");
    expect(GUIDED_DEMO_SCENARIO_VERSION).toBe("phase34a-v1");
    expect(GUIDED_DEMO_FEATURE_FLAG_KEY).toBe("guided-meridian-demo");
    expect(GUIDED_DEMO_STAGES).toHaveLength(12);
    expect(GUIDED_DEMO_STAGES.map((stage) => stage.key)).toEqual([
      "lead_intake",
      "information_check",
      "proposal",
      "customer_decision",
      "project_setup",
      "inspection",
      "data_validation",
      "report_assembly",
      "technical_review",
      "executive_approval",
      "client_delivery",
      "billing_closeout",
    ]);
    expect(GUIDED_DEMO_STAGES.find((stage) => stage.key === "customer_decision")?.backingType).toBe(
      "guided_demonstration",
    );
    expect(GUIDED_DEMO_STAGES.find((stage) => stage.key === "client_delivery")?.backingType).toBe(
      "local_test_no_write",
    );
    expect(GUIDED_DEMO_STAGES.find((stage) => stage.key === "proposal")?.backingType).toBe(
      "runtime_backed",
    );
  });

  it("allows only explicit story transitions and the documented loops", () => {
    expect(GUIDED_DEMO_TRANSITIONS.waiting_proposal_approval).toEqual(
      expect.arrayContaining(["proposal_revision_processing", "customer_decision_processing"]),
    );
    expect(GUIDED_DEMO_TRANSITIONS.waiting_technical_review).toEqual(
      expect.arrayContaining(["report_revision_processing", "waiting_delivery_authorization"]),
    );
    expect(GUIDED_DEMO_TRANSITIONS.report_assembly_failed).toEqual(
      expect.arrayContaining(["report_assembly_processing"]),
    );
    expect(() =>
      assertGuidedDemoTransition("waiting_proposal_approval", "waiting_technical_review"),
    ).toThrow(GuidedDemoConflictError);
    expect(() =>
      assertGuidedDemoTransition("not_started", "waiting_delivery_authorization"),
    ).toThrow(GuidedDemoConflictError);
    assertGuidedDemoTransition("waiting_roof_authorization", "proposal_processing");
    assertGuidedDemoTransition("waiting_proposal_approval", "proposal_revision_processing");
    assertGuidedDemoTransition("proposal_revision_processing", "waiting_proposal_approval");
    assertGuidedDemoTransition("waiting_technical_review", "report_revision_processing");
    assertGuidedDemoTransition("report_revision_processing", "waiting_technical_review");
    assertGuidedDemoTransition("report_assembly_failed", "report_assembly_processing");
  });

  it("maps machine states to run status, stage, gates, and node appearance", () => {
    expect(runStatusForMachineState("waiting_roof_authorization")).toBe("waiting_for_human");
    expect(runStatusForMachineState("report_assembly_failed")).toBe("failed");
    expect(runStatusForMachineState("lead_intake_processing")).toBe("running");
    expect(stageKeyForMachineState("waiting_delivery_authorization")).toBe("executive_approval");
    expect(gateKeyForState("waiting_roof_authorization")).toBe("add_simulated_authorization");
    expect(isHumanGateState("waiting_proposal_approval")).toBe(true);
    expect(GUIDED_DEMO_HUMAN_GATE_STATES).toHaveLength(4);
    expect(isAutomatedProcessingState("proposal_processing")).toBe(true);
    expect(isAutomatedProcessingState("waiting_technical_review")).toBe(false);
    expect(
      nodeStatusForMachineState("information_check", "waiting_roof_authorization", ["lead_intake"]),
    ).toBe("human_decision_required");
    expect(
      nodeStatusForMachineState("lead_intake", "waiting_roof_authorization", ["lead_intake"]),
    ).toBe("completed");
    expect(nodeStatusForMachineState("report_assembly", "report_assembly_failed", [])).toBe(
      "failed",
    );
    expect(nodeStatusForMachineState("proposal", "proposal_processing", ["lead_intake"])).toBe(
      "processing",
    );
    expect(semanticColorForNodeStatus("processing")).toBe("processing-green");
    expect(semanticColorForNodeStatus("human_decision_required")).toBe("human-gate-amber");
    expect(semanticColorForNodeStatus("failed")).toBe("failure-red");
    expect(GUIDED_DEMO_STATUS_COLORS.completed.label).toBe("Completed");
  });

  it("normalizes the preset voice phrase and routes deterministic commands", () => {
    expect(normalizeGuidedDemoCommand(`  ${GUIDED_DEMO_PRESET_VOICE_PHRASE}  `)).toBe(
      "show me the meridian commerce center inspection report",
    );
    expect(routeGuidedDemoCommand("Show the Meridian Commerce Center report.")).toBe(
      "open_meridian_report",
    );
    expect(routeGuidedDemoCommand("Open the Meridian Commerce Center inspection report.")).toBe(
      "open_meridian_report",
    );
    expect(routeGuidedDemoCommand("Let me see the Meridian report.")).toBe("open_meridian_report");
    expect(routeGuidedDemoCommand("Where is the Meridian Commerce Center report?")).toBe(
      "open_meridian_report",
    );
    expect(routeGuidedDemoCommand("What is waiting on me?")).toBe("show_current_blocker");
    expect(routeGuidedDemoCommand("Where is the workflow?")).toBe("show_workflow");
    expect(routeGuidedDemoCommand("What happens after I approve?")).toBe("explain_next_step");
    expect(routeGuidedDemoCommand("Write a poem about roofs.")).toBe("unsupported_demo_command");
    expect(isGuidedDemoAction("start")).toBe(true);
    expect(isGuidedDemoAction("delete_everything")).toBe(false);
  });

  it("maps AI responses from story state without claiming an external model", () => {
    const beforeReport = mapGuidedDemoCommandResponse({
      intent: "open_meridian_report",
      machineState: "waiting_roof_authorization",
      currentStageTitle: "Information Check",
      reportReference: null,
      reportVersionNumber: null,
    });
    expect(beforeReport.simulated).toBe(true);
    expect(beforeReport.label).toBe(GUIDED_DEMO_SIMULATED_COMMAND_LABEL);
    expect(beforeReport.openReport).toBe(false);
    expect(beforeReport.message).toContain("has not been assembled yet");
    expect(beforeReport.message).toContain("Information Check");

    const facts = {
      reportId: "r1",
      reportReference: "BEA-RP-000100",
      versionId: "v1",
      versionNumber: 1,
      reportStatus: "in_review",
      findingCount: 3,
      highPriorityCount: 2,
      mediumPriorityCount: 1,
      technicallyApproved: false,
      deliveryConfirmed: false,
      deliveryAuthorizationStatus: null,
      inspectionId: "i1",
    };
    const inReview = mapGuidedDemoCommandResponse({
      intent: "open_meridian_report",
      machineState: "waiting_technical_review",
      currentStageTitle: "Technical Review",
      reportReference: "BEA-RP-000100",
      reportVersionNumber: 1,
      workspace: facts,
    });
    expect(inReview.openReport).toBe(true);
    expect(inReview.message).toContain("BEA-RP-000100");
    expect(inReview.message).toContain("Version 1");
    expect(inReview.message).toContain("3 findings: 2 high priority and 1 medium priority");
    expect(inReview.message).toContain("Technical review is waiting");
    expect(inReview.sources.map((source) => source.label)).toEqual(
      expect.arrayContaining([
        "Report",
        "Inspection",
        "Findings",
        "Review History",
        "Delivery Status",
      ]),
    );
    expect(inReview.sources.find((source) => source.key === "report")?.recordId).toBe("r1");

    const ready = mapGuidedDemoCommandResponse({
      intent: "open_meridian_report",
      machineState: "waiting_delivery_authorization",
      currentStageTitle: "Executive Approval",
      reportReference: "BEA-RP-000100",
      reportVersionNumber: 2,
      workspace: { ...facts, versionNumber: 2, versionId: "v2", technicallyApproved: true },
    });
    expect(ready.message).toContain("ready for Owner delivery authorization");
    expect(ready.message).toContain("No delivery has occurred");

    const delivered = mapGuidedDemoCommandResponse({
      intent: "open_meridian_report",
      machineState: "completed",
      currentStageTitle: "Billing & Closeout",
      reportReference: "BEA-RP-000100",
      reportVersionNumber: 2,
      workspace: {
        ...facts,
        versionNumber: 2,
        versionId: "v2",
        technicallyApproved: true,
        deliveryConfirmed: true,
      },
    });
    expect(delivered.message).toContain("local demonstration delivery adapter");
    expect(delivered.message).toContain("No real email was sent");

    const unavailable = mapGuidedDemoCommandResponse({
      intent: "open_meridian_report",
      machineState: "waiting_technical_review",
      currentStageTitle: "Technical Review",
      reportReference: "BEA-RP-000100",
      reportVersionNumber: 1,
      workspaceUnavailable: true,
    });
    expect(unavailable.openReport).toBe(true);
    expect(unavailable.message).toContain("Stored Report content is unavailable");
    expect(unavailable.message).not.toMatch(/three findings/i);
  });

  it("keeps reduced-motion configuration informational and preserves status meaning", () => {
    expect(reducedMotionConfiguration(true)).toEqual({
      packetTravel: false,
      pulse: false,
      useShortFade: true,
    });
    expect(reducedMotionConfiguration(false).packetTravel).toBe(true);
    expect(presentationCueForState("waiting_roof_authorization")).toContain("missing");
  });

  it("enforces role boundaries for demonstration commands", () => {
    expect(guidedDemoRoleCanPerform("executive-readonly", "start")).toBe(false);
    expect(guidedDemoRoleCanPerform("sales", "approve_proposal")).toBe(false);
    expect(guidedDemoRoleCanPerform("operations", "authorize_demo_delivery")).toBe(false);
    expect(guidedDemoRoleCanPerform("operations", "request_delivery_changes")).toBe(false);
    expect(guidedDemoRoleCanPerform("sales", "request_delivery_changes")).toBe(false);
    expect(guidedDemoRoleCanPerform("integration-admin", "request_delivery_changes")).toBe(false);
    expect(
      guidedDemoRoleCanPerform("owner-admin", "submit_human_decision", "request_delivery_changes"),
    ).toBe(true);
    expect(isGuidedDemoAction("request_delivery_changes")).toBe(true);
    expect(guidedDemoRoleCanPerform("integration-admin", "start")).toBe(false);
    expect(guidedDemoRoleCanPerform("owner-admin", "start")).toBe(true);
    expect(
      guidedDemoRoleCanPerform("operations", "submit_human_decision", "approve_technical_content"),
    ).toBe(true);
    expect(
      guidedDemoRoleCanPerform("sales", "submit_human_decision", "add_simulated_authorization"),
    ).toBe(true);
  });

  it("builds a twelve-photo, three-finding synthetic inspection payload", async () => {
    expect(MERIDIAN_FINDINGS).toHaveLength(3);
    expect(MERIDIAN_FINDINGS.filter((item) => item.priority === "High")).toHaveLength(2);
    const payload = meridianInspectionPayload("2026-09-03T12:00:00.000Z");
    expect(payload.clientName).toBe("Meridian Property Group");
    expect(Array.isArray(payload.findings) && payload.findings).toHaveLength(3);
    expect(
      Array.isArray(payload.evidence) &&
        payload.evidence.filter(
          (item) => item && typeof item === "object" && "kind" in item && item.kind === "photo",
        ),
    ).toHaveLength(12);
    expect(payload.workspaceDocument && typeof payload.workspaceDocument === "object").toBe(true);
    const first = meridianReportWorkspaceDocument(1);
    const second = meridianReportWorkspaceDocument(2, {
      reviewComment: "Clarify the recommended repair priority before release.",
    });
    expect(first.versionMarker).toContain("ORIGINAL ASSESSMENT");
    expect(second.versionMarker).toContain("REVIEW UPDATE — Version 2");
    expect(second.reviewUpdate).toContain("Clarify the recommended repair priority");
    expect(second.findings[0]?.recommendation).not.toBe(first.findings[0]?.recommendation);
    const viewer = await readFile(
      new URL("../../apps/web/components/meridian-report-workspace.tsx", import.meta.url),
      "utf8",
    );
    const presentation = await readFile(
      new URL("../../apps/web/lib/guided-demo-presentation.ts", import.meta.url),
      "utf8",
    );
    expect(viewer).not.toMatch(/MERIDIAN_FINDINGS|MERIDIAN_EVIDENCE_LABELS/);
    expect(presentation).not.toMatch(/MERIDIAN_FINDINGS|MERIDIAN_EVIDENCE_LABELS/);
    expect(normalizeOwnerDeliveryChangeReason("", true)).toBe(OWNER_DELIVERY_CHANGE_DEFAULT_REASON);
    expect(normalizeOwnerDeliveryChangeReason("   ", false)).toBe("");
    expect(() =>
      assertGuidedDemoReportConsistency({
        machineState: "waiting_delivery_authorization",
        reportId: "r1",
        boundReportVersionId: "v1",
        reportStatus: "in_review",
        currentVersionId: "v1",
        currentVersionReviewDecision: "approve",
        technicallyApproved: true,
        activeDeliveryAuthorizationId: null,
        confirmedDeliveryVersionId: null,
      }),
    ).toThrow(GuidedDemoIntegrityError);
  });

  it("generates plain-English activity copy and pause-safe informational cues", () => {
    expect(activityCopyForStageCompletion("lead_intake", "lead_intake_processing")).toEqual(
      expect.arrayContaining(["Website inquiry received", "Lead Command Record created"]),
    );
    expect(
      activityCopyForStageCompletion("information_check", "waiting_roof_authorization"),
    ).toEqual(
      expect.arrayContaining([
        "Roof Access Authorization missing",
        "Automation paused for human input",
      ]),
    );
    expect(activityCopyForStageCompletion("proposal", "proposal_revision_processing")).toEqual([
      "Applying requested commercial changes",
    ]);
    expect(activityCopyForStageCompletion("report_assembly", "report_revision_processing")).toEqual(
      ["Report Version 2 assembled"],
    );
    expect(activityCopyForStageCompletion("client_delivery", "delivery_processing")).toEqual(
      expect.arrayContaining(["No-send delivery confirmed"]),
    );
  });
});
