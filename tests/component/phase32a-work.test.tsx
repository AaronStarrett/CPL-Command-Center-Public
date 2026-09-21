import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EMAIL_DRY_RUN_DISCLOSURE,
  TEAMS_DRY_RUN_DISCLOSURE,
} from "../../packages/domain/src/index.js";
import { WorkItemActions } from "../../apps/web/components/work-item-actions";
import { WorkQueueTable } from "../../apps/web/components/work-queue-table";
import { WorkReconcileActions } from "../../apps/web/components/work-reconcile-actions";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const sampleItem = {
  id: "d2000000-0000-4000-8000-000000000001",
  reference: "BEA-WK-000001",
  workItemKind: "inspection_correction" as const,
  status: "open" as const,
  priority: "urgent" as const,
  queueKey: "inspection.correction" as const,
  assignedRoleKey: "operations",
  assignedUserId: null,
  claimedUserId: null,
  claimedAt: null,
  projectId: null,
  inspectionId: null,
  submissionId: null,
  reportId: null,
  reportVersionId: null,
  exceptionId: null,
  deliveryAuthorizationId: null,
  deliveryId: null,
  jobId: null,
  scheduledActionId: null,
  failureSourceType: null,
  failureSourceId: null,
  requestedRevisionVersionId: null,
  leadId: null,
  proposalId: null,
  proposalVersionId: null,
  catalogVersionId: null,
  pricingOverrideId: null,
  sourceEventId: null,
  sourceAggregateType: "inspection",
  sourceAggregateId: "insp",
  policyKey: "bea.synthetic-operational-orchestration",
  policyVersion: 1,
  configurationReleaseId: null,
  idempotencyKey: "k",
  cycleIdentity: "c",
  title: "Correct inspection package",
  reason: "Validation failed",
  requiredAction: "Submit a corrected inspection package through the protected command.",
  deepLink: "/inspections/insp",
  availableAt: "2026-01-01T00:00:00.000Z",
  dueAt: "2025-12-31T22:00:00.000Z",
  acknowledgedAt: null,
  startedAt: null,
  blockedAt: null,
  completedAt: null,
  cancelledAt: null,
  blockedReason: null,
  completionEventType: null,
  completionEventId: null,
  escalationLevel: "none" as const,
  lastReminderAt: null,
  reminderCount: 0,
  synthetic: true,
  correlationId: "seed",
  causationId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
};

describe("Phase 3.2A work workspace components", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    refresh.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders My Work rows and claim controls", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ item: sampleItem }));
    render(
      <WorkQueueTable
        items={[sampleItem]}
        testId="work-my-queue"
        emptyTitle="empty"
        emptyDescription="none"
      />,
    );
    expect(screen.getByTestId("work-my-queue")).toHaveTextContent("BEA-WK-000001");
    render(
      <WorkItemActions
        workItemId={sampleItem.id}
        expectedVersion={1}
        canClaim
        canUpdate
        canReassign={false}
        ownerOnly={false}
      />,
    );
    fireEvent.click(screen.getByTestId("work-claim"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({
      action: "claim",
    });
  });

  it("shows Owner-only delivery disclosure and dry-run copy", () => {
    render(
      <WorkItemActions
        workItemId="delivery"
        expectedVersion={1}
        canClaim
        canUpdate={false}
        canReassign={false}
        ownerOnly
      />,
    );
    expect(screen.getByTestId("owner-only-work")).toHaveTextContent(
      /Owner-only delivery authorization/i,
    );
    expect(EMAIL_DRY_RUN_DISCLOSURE).toMatch(/NO MESSAGE SENT/);
    expect(TEAMS_DRY_RUN_DISCLOSURE).toMatch(/NO MESSAGE POSTED/);
  });

  it("hides mutation controls for executive read-only presentation", () => {
    render(
      <WorkItemActions
        workItemId="exec"
        expectedVersion={1}
        canClaim={false}
        canUpdate={false}
        canReassign={false}
        ownerOnly={false}
      />,
    );
    expect(screen.queryByTestId("work-claim")).toBeNull();
    expect(screen.queryByTestId("work-reassign")).toBeNull();
  });

  it("requests a reconciliation dry-run", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ result: { createdMissing: 1, completedStale: 0, unchanged: 3 } }),
    );
    render(<WorkReconcileActions canExecute={false} />);
    fireEvent.click(screen.getByTestId("work-reconcile-dry-run"));
    await screen.findByTestId("work-reconcile-result");
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({
      action: "reconcile-dry-run",
    });
    expect(screen.queryByTestId("work-reconcile-execute")).toBeNull();
  });
});
