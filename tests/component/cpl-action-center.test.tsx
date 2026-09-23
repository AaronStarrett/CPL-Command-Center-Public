import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CplAutomationWorkspace,
  CplAutomationExecutionDetail,
} from "@bea/domain/cpl-automation";
import type { CommercialRequest } from "../../apps/web/app/workspace/commercial-ui";
import { ActionCenter } from "../../apps/web/app/workspace/action-center";

const org = "10000000-0000-4000-8000-000000000034",
  member = "20000000-0000-4000-8000-000000000034",
  taskId = "30000000-0000-4000-8000-000000000034",
  executionId = "40000000-0000-4000-8000-000000000034",
  eventId = "50000000-0000-4000-8000-000000000034",
  leadId = "60000000-0000-4000-8000-000000000034",
  templateId = "70000000-0000-4000-8000-000000000034";
const now = "2026-09-23T12:00:00.000Z",
  base = "/api/cpl-automation";
function fixtures(): { data: CplAutomationWorkspace; detail: CplAutomationExecutionDetail } {
  const detail: CplAutomationExecutionDetail = {
    id: executionId,
    organizationId: org,
    revision: 3,
    event: {
      id: eventId,
      organizationId: org,
      type: "lead.ready",
      sourceKind: "lead",
      sourceId: leadId,
      sourceVersion: 4,
      projectId: null,
      actorIdentityId: member,
      occurredAt: now,
      origin: "human",
      causationExecutionId: null,
    },
    recipeId: templateId,
    recipeVersion: 2,
    recipeName: "Prepare fictional proposal",
    status: "failed",
    attempts: 1,
    maxAttempts: 3,
    nextRetryAt: null,
    lastErrorCode: "CPL_AUTOMATION_TEMPLATE_UNAVAILABLE",
    createdAt: now,
    updatedAt: now,
    results: [],
    availableActions: { canRetry: true, canCancel: true, canReplay: true },
    attemptHistory: [
      {
        attempt: 1,
        startedAt: now,
        finishedAt: now,
        status: "failed",
        errorCode: "CPL_AUTOMATION_TEMPLATE_UNAVAILABLE",
      },
    ],
  };
  const data: CplAutomationWorkspace = {
    recipes: [],
    executions: [detail],
    tasks: [
      {
        id: taskId,
        organizationId: org,
        revision: 2,
        executionId,
        title: "Review confirmed request",
        reason: "Ready lead needs a proposal",
        group: "next_actions",
        customerName: "Fictional customer",
        projectName: null,
        nextAction: "Open the lead and review scope",
        isMine: true,
        target: { kind: "lead", id: leadId, projectId: null, version: 4 },
        owner: { kind: "person", identityId: member, role: null },
        dueAt: now,
        status: "open",
        resolutionReason: null,
        createdAt: now,
        updatedAt: now,
        availableActions: { canAssign: true, canStart: true, canComplete: false, canDismiss: true },
      },
    ],
    counts: {
      openTasks: 123,
      myTasks: 7,
      reviews: 8,
      missingInformation: 9,
      delivery: 10,
      closeout: 11,
      failedExecutions: 1,
      queuedExecutions: 2,
      succeededExecutions: 3,
    },
    currentIdentityId: member,
    members: [{ identityId: member, displayName: "Synthetic manager", role: "manager" }],
    proposalTemplates: [{ id: templateId, name: "Fictional site proposal", version: 3 }],
    reportTemplates: [],
    permissions: { canConfigure: true, canOperate: true, canAssign: true, canViewExecutions: true },
    listLimit: 100,
  };
  return { data, detail };
}
describe("company Action Center", () => {
  let data: CplAutomationWorkspace, detail: CplAutomationExecutionDetail;
  let handler: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    ({ data, detail } = fixtures());
    handler = vi.fn(async (path: string, body?: Record<string, unknown>) => {
      if (path === `${base}/workspace`) return structuredClone(data);
      if (path === `${base}/executions/${executionId}`) return structuredClone(detail);
      if (path === `${base}/tasks/${taskId}`) {
        data.tasks[0] = {
          ...data.tasks[0]!,
          revision: 3,
          status: body?.action === "dismiss" ? "dismissed" : "in_progress",
          resolutionReason: typeof body?.reason === "string" ? body.reason : null,
        };
        return structuredClone(data.tasks[0]);
      }
      if (path === `${base}/recipes`) return {};
      if (path.endsWith("/retry") || path.endsWith("/replay") || path.endsWith("/cancel"))
        return detail;
      throw new Error(`Unexpected ${path}`);
    });
  });
  function mount() {
    const onOpen = vi.fn(),
      onDirty = vi.fn();
    render(
      <ActionCenter
        organizationId={org}
        request={handler as CommercialRequest}
        onDirty={onDirty}
        onBusy={vi.fn()}
        onOpen={onOpen}
      />,
    );
    return { onOpen, onDirty };
  }
  it("uses server totals and typed record navigation rather than loaded-list counts", async () => {
    const { onOpen } = mount();
    const mine = await screen.findByRole("button", { name: "My actions 7" });
    expect(mine).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Missing information 9" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All open actions · 123" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Review confirmed request/ }));
    expect(await screen.findByText("Open the lead and review scope")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open related record" }));
    expect(onOpen).toHaveBeenCalledWith(data.tasks[0]!.target);
  });
  it("requires dismissal reason and never exposes a prohibited completion action", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Review confirmed request/ }));
    expect(screen.queryByRole("button", { name: "Complete action" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss with reason" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/^Action reason/), {
      target: { value: "Superseded by a reviewed request" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss with reason" }));
    await waitFor(() =>
      expect(handler).toHaveBeenCalledWith(
        `${base}/tasks/${taskId}`,
        expect.objectContaining({
          action: "dismiss",
          expectedRevision: 2,
          reason: "Superseded by a reviewed request",
          idempotencyKey: expect.any(String),
        }),
      ),
    );
  });
  it("retains a stale reason and defers navigation until explicit discard", async () => {
    handler.mockImplementation(async (path: string, body?: unknown) => {
      if (path === `${base}/workspace`) return structuredClone(data);
      if (body)
        throw Object.assign(new Error("conflict"), { code: "CPL_AUTOMATION_VERSION_CONFLICT" });
      return detail;
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Review confirmed request/ }));
    fireEvent.change(screen.getByLabelText(/^Action reason/), {
      target: { value: "Keep this review note" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss with reason" }));
    await screen.findByText(/This record changed elsewhere/);
    expect(screen.getByLabelText(/^Action reason/)).toHaveValue("Keep this review note");
    fireEvent.click(screen.getByRole("button", { name: "Recipes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText(/^Action reason/)).toHaveValue("Keep this review note");
    expect(screen.queryByLabelText("Recipe name")).not.toBeInTheDocument();
  });
  it("requires both pinned template authorization and enabled configuration review", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Recipes" }));
    fireEvent.change(screen.getByLabelText("Recipe name"), {
      target: { value: "Prepare lead handoff" },
    });
    fireEvent.change(screen.getByLabelText(/^Action title/), {
      target: { value: "Review prepared scope" },
    });
    fireEvent.click(screen.getByLabelText(/Also prepare a linked proposal draft/));
    fireEvent.change(screen.getByLabelText("Approved template for automatic drafts"), {
      target: { value: `${templateId}:3` },
    });
    fireEvent.click(screen.getByLabelText(/I authorize this exact template version/));
    fireEvent.click(screen.getByLabelText("Enable this recipe for future matching events"));
    expect(screen.getByRole("button", { name: "Save recipe version" })).toBeDisabled();
    fireEvent.click(
      screen.getByLabelText(/I reviewed the action, ownership, deadline and template/),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save recipe version" }));
    await waitFor(() =>
      expect(handler).toHaveBeenCalledWith(
        `${base}/recipes`,
        expect.objectContaining({
          expectedVersion: 0,
          input: expect.objectContaining({
            enabled: true,
            prepareDraft: true,
            templateId,
            templateVersion: 3,
            templateApprovedForAutomation: true,
          }),
        }),
      ),
    );
    expect(
      handler.mock.calls.find(([p]) => p === `${base}/recipes`)![1] as Record<string, unknown>,
    ).not.toHaveProperty("backfill");
  });
  it("keeps the same recipe key after successful write and failed readback", async () => {
    let written = false,
      failRead = true;
    handler.mockImplementation(async (path: string, body?: unknown) => {
      if (path === `${base}/recipes`) {
        written = true;
        return {};
      }
      if (path === `${base}/workspace`) {
        if (written && failRead) {
          failRead = false;
          throw new Error("readback unavailable");
        }
        return structuredClone(data);
      }
      return body;
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Recipes" }));
    fireEvent.change(screen.getByLabelText("Recipe name"), {
      target: { value: "Manual follow-up" },
    });
    fireEvent.change(screen.getByLabelText(/^Action title/), { target: { value: "Check scope" } });
    fireEvent.click(screen.getByRole("button", { name: "Save recipe version" }));
    await screen.findByText("readback unavailable");
    expect(screen.getByLabelText("Recipe name")).toHaveValue("Manual follow-up");
    fireEvent.click(screen.getByRole("button", { name: "Save recipe version" }));
    await screen.findByText(/Recipe version saved/);
    const writes = handler.mock.calls.filter(([path]) => path === `${base}/recipes`);
    expect(writes).toHaveLength(2);
    expect(writes[0]![1]).toEqual(writes[1]![1]);
  });
  it("replays the captured event with reason without requesting new business records", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Execution history" }));
    fireEvent.click(screen.getByRole("button", { name: /Prepare fictional proposal/ }));
    await screen.findByLabelText("Execution action reason");
    expect(screen.getByRole("button", { name: "Replay recorded event safely" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Execution action reason"), {
      target: { value: "Reconcile recorded partial success" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Replay recorded event safely" }));
    await waitFor(() =>
      expect(handler).toHaveBeenCalledWith(`${base}/events/${eventId}/replay`, {
        reason: "Reconcile recorded partial success",
        idempotencyKey: expect.any(String),
      }),
    );
    expect(handler.mock.calls.some(([path]) => String(path).includes("/cpl-commercial/"))).toBe(
      false,
    );
  });
  it("describes recorded proposal and follow-up results without claiming approval or sending", async () => {
    detail.results = [
      {
        step: "handoff",
        target: { kind: "proposal", id: templateId, projectId: null, version: 1 },
        completedAt: now,
      },
      {
        step: "task",
        target: { kind: "proposal", id: templateId, projectId: null, version: 1 },
        completedAt: now,
      },
    ];
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Execution history" }));
    fireEvent.click(await screen.findByRole("button", { name: /Prepare fictional proposal/ }));
    expect(await screen.findByText("Proposal draft prepared")).toBeVisible();
    expect(screen.getByText("Follow-up action recorded")).toBeVisible();
    expect(screen.queryByText("Approved automatically")).not.toBeInTheDocument();
  });
  it("refuses cross-company response rows before exposing the action", async () => {
    data.tasks[0]!.organizationId = "90000000-0000-4000-8000-000000000034";
    mount();
    await screen.findByText("The response did not match the selected company.");
    expect(screen.queryByText("Review confirmed request")).not.toBeInTheDocument();
  });
  it("shows recipe settings read only when configuration permission is absent", async () => {
    data.permissions.canConfigure = false;
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Recipes" }));
    expect(screen.getByLabelText("Recipe name")).toBeDisabled();
    expect(screen.getByRole("button", { name: "New internal recipe" })).toBeDisabled();
    expect(
      within(screen.getByRole("region", { name: "Action Center" })).queryByText(
        "Approved automatically",
      ),
    ).not.toBeInTheDocument();
  });
  it("requires a completion reason even for an authorized action", async () => {
    data.tasks[0]!.availableActions.canComplete = true;
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Review confirmed request/ }));
    expect(screen.getByRole("button", { name: "Complete action" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/^Action reason/), {
      target: { value: "Confirmed through the linked record" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Complete action" }));
    await waitFor(() =>
      expect(handler).toHaveBeenCalledWith(
        `${base}/tasks/${taskId}`,
        expect.objectContaining({
          action: "complete",
          expectedRevision: 2,
          reason: "Confirmed through the linked record",
        }),
      ),
    );
  });
  it("opens source-attention records without inventing a related execution", async () => {
    data.tasks[0]!.executionId = null;
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Review confirmed request/ }));
    expect(screen.getByRole("button", { name: "Open related record" })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "View related execution" }),
    ).not.toBeInTheDocument();
  });
});
