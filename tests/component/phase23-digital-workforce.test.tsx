import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DigitalWorkforceHierarchy } from "../../apps/web/components/digital-workforce-hierarchy";
import { DigitalWorkforceRunTrace } from "../../apps/web/components/digital-workforce-run-trace";
import { DigitalWorkforceStudio } from "../../apps/web/components/digital-workforce-studio";
import { DigitalWorkforceWizard } from "../../apps/web/components/digital-workforce-wizard";
import { WorkspaceRenderer } from "../../apps/web/components/workspace-renderer";
import type { AiCommandArtifactView } from "../../apps/web/lib/ai-command-contracts";
import {
  DIGITAL_AGENT_LABEL,
  EXECUTIVE_TEAM_WORKFLOW_GOAL,
  SEEDED_DIGITAL_WORKFORCE_IDS,
  type DigitalWorkforceOrganizationNode,
} from "../../packages/domain/src/index.js";

const uiCss = readFileSync(resolve(process.cwd(), "packages/ui/src/styles.css"), "utf8");

const ids = SEEDED_DIGITAL_WORKFORCE_IDS;

function node(
  overrides: Partial<DigitalWorkforceOrganizationNode> &
    Pick<DigitalWorkforceOrganizationNode, "agentId" | "displayName" | "roleTitle" | "slug">,
): DigitalWorkforceOrganizationNode {
  return {
    avatar: "specialist-lead",
    status: "active",
    departmentId: ids.departments.revenue,
    departmentName: "Revenue and Client Development",
    teamId: ids.teams.clientDevelopment,
    teamName: "Client Development",
    supervisorAgentId: ids.agents.revenueManager,
    supportedHumanUserId: null,
    supportedHumanDisplayName: null,
    publishedVersionId: ids.versions.leadReview,
    modelProfile: "fast",
    modelId: "unconfigured",
    currentRunId: null,
    currentRunStatus: null,
    workingState: "idle",
    directReportCount: 0,
    digitalAgentLabel: DIGITAL_AGENT_LABEL,
    ...overrides,
  };
}

const organization: DigitalWorkforceOrganizationNode[] = [
  node({
    agentId: ids.agents.andrewExecutive,
    displayName: "Owner Executive Business Partner",
    roleTitle: "Executive Business Partner — Digital Agent",
    slug: "andrew-executive-business-partner",
    avatar: "executive",
    departmentId: ids.departments.executiveOffice,
    departmentName: "Executive Office",
    teamId: ids.teams.executivePartnership,
    teamName: "Executive Partnership",
    supervisorAgentId: null,
    supportedHumanUserId: "10000000-0000-4000-8000-000000000001",
    supportedHumanDisplayName: "Workspace Owner",
    publishedVersionId: ids.versions.andrewExecutive,
    modelProfile: "executive-premium",
    workingState: "idle",
    directReportCount: 1,
  }),
  node({
    agentId: ids.agents.revenueManager,
    displayName: "Revenue Manager",
    roleTitle: "Department Manager — Digital Agent",
    slug: "revenue-manager",
    avatar: "manager",
    supervisorAgentId: ids.agents.andrewExecutive,
    publishedVersionId: ids.versions.revenueManager,
    modelProfile: "balanced",
    directReportCount: 1,
  }),
  node({
    agentId: ids.agents.leadReview,
    displayName: "Lead Review Specialist",
    roleTitle: "Lead Review Specialist — Digital Agent",
    slug: "lead-review-specialist",
  }),
];

const departments = [
  {
    id: ids.departments.executiveOffice,
    name: "Executive Office",
    slug: "executive-office",
    description: "Executive orchestration",
    status: "active" as const,
    displayOrder: 1,
    parentDepartmentId: null,
    createdByUserId: "10000000-0000-4000-8000-000000000001",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
  },
];

const teams = [
  {
    id: ids.teams.executivePartnership,
    departmentId: ids.departments.executiveOffice,
    name: "Executive Partnership",
    slug: "executive-partnership",
    description: "Executive team",
    status: "active" as const,
    teamLeadAgentId: ids.agents.andrewExecutive,
    displayOrder: 1,
    createdByUserId: "10000000-0000-4000-8000-000000000001",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
  },
];

describe("Phase 2.3 Digital Workforce studio", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders a visible hierarchy with Digital Agent labels and human association disclosure", () => {
    render(
      <DigitalWorkforceHierarchy
        nodes={organization}
        selectedAgentId={ids.agents.andrewExecutive}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByTestId("workforce-hierarchy")).toBeInTheDocument();
    expect(screen.getByText("Owner Executive Business Partner")).toBeInTheDocument();
    expect(screen.getByText("Lead Review Specialist")).toBeInTheDocument();
    expect(screen.getAllByText(DIGITAL_AGENT_LABEL).length).toBeGreaterThan(0);
    expect(screen.getByText(/Supports Workspace Owner \(association only\)/u)).toBeInTheDocument();
    expect(screen.getByText(/Executive Office/u)).toBeInTheDocument();
  });

  it("walks the seven-step wizard and requires explicit publish confirmation", () => {
    render(
      <DigitalWorkforceWizard
        departments={departments}
        teams={teams}
        agents={[
          { id: ids.agents.andrewExecutive, displayName: "Owner Executive Business Partner" },
        ]}
        canPublish
        onCreated={vi.fn()}
      />,
    );
    expect(screen.getByTestId("workforce-wizard")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/digital agent name/i), {
      target: { value: "Field Briefing Specialist" },
    });
    fireEvent.change(screen.getByLabelText(/role title/i), {
      target: { value: "Specialist — Digital Agent" },
    });
    for (let step = 0; step < 6; step += 1) {
      fireEvent.click(screen.getByTestId("workforce-wizard-continue"));
    }
    expect(screen.getByText(/step 7 of 7/i)).toBeInTheDocument();
    const publish = screen.getByTestId("workforce-wizard-publish");
    expect(publish).toBeDisabled();
    fireEvent.click(screen.getByTestId("workforce-publish-confirm"));
    expect(publish).not.toBeDisabled();
    expect(screen.getByTestId("workforce-wizard-save-draft")).toBeInTheDocument();
  });

  it("shows run trace steps, models, handoffs, and empty state", () => {
    const { rerender } = render(
      <DigitalWorkforceRunTrace run={null} steps={[]} handoffs={[]} events={[]} />,
    );
    expect(screen.getByText(/no active digital workforce run/i)).toBeInTheDocument();
    rerender(
      <DigitalWorkforceRunTrace
        run={{
          id: "85000000-0000-4000-8000-000000000001",
          initiatingUserId: "10000000-0000-4000-8000-000000000001",
          conversationId: null,
          initiatingMessageId: null,
          rootAgentId: ids.agents.andrewExecutive,
          rootAgentVersionId: ids.versions.andrewExecutive,
          goal: EXECUTIVE_TEAM_WORKFLOW_GOAL,
          normalizedRequest: EXECUTIVE_TEAM_WORKFLOW_GOAL,
          executionPlan: null,
          status: "running",
          currentStepKey: "lead-review",
          idempotencyKey: "trace-1",
          sourceRecordIds: [],
          sourceArtifactIds: [],
          sourcePresentationIds: [],
          outputArtifactIds: ["86000000-0000-4000-8000-000000000001"],
          estimatedCostUsd: 0.42,
          actualCostUsd: null,
          providerCallCount: 1,
          webSearchCount: 1,
          pdfGenerationCount: 0,
          startedAt: "2026-08-31T00:00:00.000Z",
          completedAt: null,
          expiresAt: null,
          claimedAt: "2026-08-31T00:00:00.000Z",
          claimOwner: "bea-digital-workforce-executor",
          cancellationRequested: false,
          cancelledByUserId: null,
          cancellationReason: null,
          safeError: null,
          executiveSummary: null,
          correlationId: "trace",
          createdAt: "2026-08-31T00:00:00.000Z",
          updatedAt: "2026-08-31T00:00:00.000Z",
          version: 1,
        }}
        steps={[
          {
            id: "87000000-0000-4000-8000-000000000001",
            runId: "85000000-0000-4000-8000-000000000001",
            stepKey: "lead-review",
            stepType: "analyze_records",
            agentId: ids.agents.leadReview,
            agentVersionId: ids.versions.leadReview,
            status: "completed",
            idempotencyKey: "step-1",
            sequence: 1,
            parallelGroup: "discovery",
            assignedWhy: "Lead Review Specialist matches authorized lead readiness analysis.",
            provider: "deterministic",
            model: "deterministic:fast",
            fallbackModelUsed: null,
            toolNames: ["bea_query_records"],
            authorizedRecordIds: [],
            citationIds: [],
            artifactIds: [],
            usageJson: {},
            resultJson: {},
            safeError: null,
            retryCount: 0,
            startedAt: "2026-08-31T00:00:00.000Z",
            finishedAt: "2026-08-31T00:00:01.000Z",
            createdAt: "2026-08-31T00:00:00.000Z",
            updatedAt: "2026-08-31T00:00:00.000Z",
            version: 1,
          },
        ]}
        handoffs={[
          {
            id: "88000000-0000-4000-8000-000000000001",
            runId: "85000000-0000-4000-8000-000000000001",
            parentStepId: null,
            fromAgentId: ids.agents.leadReview,
            fromAgentVersionId: ids.versions.leadReview,
            toAgentId: ids.agents.executiveDocument,
            toAgentVersionId: ids.versions.executiveDocument,
            depth: 1,
            status: "completed",
            packet: {
              reason: "Lead review complete",
              requestedDeliverable: "Include blocked-lead evidence",
              boundedContextSummary: "Needs information",
              knownFacts: [],
              uncertainties: [],
              authorizedRecordIds: [],
              authorizedPresentationIds: [],
              authorizedArtifactIds: [],
              citationIds: [],
              allowedTools: ["bea_create_pdf"],
              outputSchema: "phase2.3-v1",
              budgetAllocationUsd: 0.25,
            },
            returnedResult: {},
            safeFailure: null,
            approvalRequired: false,
            expiresAt: null,
            createdAt: "2026-08-31T00:00:00.000Z",
            updatedAt: "2026-08-31T00:00:00.000Z",
            version: 1,
          },
        ]}
        events={[
          {
            id: "89000000-0000-4000-8000-000000000001",
            runId: "85000000-0000-4000-8000-000000000001",
            sequence: 1,
            eventType: "run.progress",
            agentId: ids.agents.andrewExecutive,
            stepId: null,
            handoffId: null,
            narration: "I've assigned the lead review and public research in parallel.",
            metadata: {},
            createdAt: "2026-08-31T00:00:00.000Z",
          },
        ]}
      />,
    );
    expect(screen.getByTestId("workforce-run-trace")).toBeInTheDocument();
    expect(screen.getByTestId("workforce-step-lead-review")).toHaveTextContent(
      "deterministic:fast",
    );
    expect(screen.getByText(/lead review complete/i)).toBeInTheDocument();
    expect(
      screen.getByText(/assigned the lead review and public research in parallel/i),
    ).toBeInTheDocument();
  });

  it("exposes clone, pause, and executive-run actions and keeps hover lift small", () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ run: { id: "r" } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <DigitalWorkforceStudio
        tab="agents"
        organization={organization}
        departments={departments}
        teams={teams}
        agents={[
          {
            id: ids.agents.leadReview,
            slug: "lead-review-specialist",
            displayName: "Lead Review Specialist",
            roleTitle: "Lead Review Specialist — Digital Agent",
            shortDescription: "Reviews authorized leads.",
            departmentId: ids.departments.revenue,
            teamId: ids.teams.clientDevelopment,
            supportedHumanUserId: null,
            currentPublishedVersionId: ids.versions.leadReview,
            status: "active",
            avatar: "specialist-lead",
            createdByUserId: "10000000-0000-4000-8000-000000000001",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            version: 1,
          },
        ]}
        versionsByAgentId={{}}
        runs={[]}
        selectedAgent={null}
        selectedVersions={[]}
        selectedRun={null}
        selectedSteps={[]}
        selectedHandoffs={[]}
        selectedEvents={[]}
        canManage
        canPublish
        canRun
        canCancel
      />,
    );
    fireEvent.click(screen.getByTestId("workforce-agent-row-lead-review-specialist"));
    expect(screen.getByTestId("workforce-clone-agent")).toBeInTheDocument();
    expect(screen.getByTestId("workforce-pause-agent")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("workforce-tab-active"));
    expect(screen.getByTestId("workforce-start-executive-run")).toBeInTheDocument();
    expect(uiCss).toContain("transform: translateY(-1px)");
    expect(uiCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.bea-workforce-tree-node:hover[\s\S]*transform:\s*none/u,
    );
    expect(uiCss).not.toMatch(/\.bea-workforce-tree-node[\s\S]{0,400}perspective\(/u);
  });

  it("renders a Digital Workforce run-trace artifact in the AI Command workspace", () => {
    const artifact: AiCommandArtifactView = {
      id: "artifact-workforce",
      type: "digital-workforce-run-trace",
      title: "Executive team run",
      subtitle: DIGITAL_AGENT_LABEL,
      state: "ready",
      payload: {
        run: {
          id: "85000000-0000-4000-8000-000000000002",
          goal: EXECUTIVE_TEAM_WORKFLOW_GOAL,
          status: "completed",
          rootAgentId: ids.agents.andrewExecutive,
          estimatedCostUsd: 0.1,
          outputArtifactIds: [],
          executiveSummary: "Briefing ready.",
          safeError: null,
        },
        steps: [],
        handoffs: [],
        events: [],
      },
      sources: [],
      links: [{ label: "Open Digital Workforce", href: "/digital-workforce" }],
      requiredPermissions: ["digital-workforce.view"],
      createdAt: "2026-08-31T00:00:00.000Z",
      errorCode: null,
    };
    render(
      <WorkspaceRenderer
        artifact={artifact}
        canExecuteTaskAction={false}
        onConfirmAction={vi.fn()}
      />,
    );
    expect(screen.getByTestId("workforce-run-trace")).toBeInTheDocument();
    expect(screen.getByText(/briefing ready/i)).toBeInTheDocument();
  });
});
