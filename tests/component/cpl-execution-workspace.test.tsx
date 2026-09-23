import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CplCommercialProject } from "@bea/domain/cpl-commercial";
import {
  CPL_EXECUTION_TIME_ZONE,
  cplVisitReadiness,
  type CplProjectWorkspace,
  type CplVisit,
  type CplVisitInput,
} from "@bea/domain/cpl-execution";
import { ExecutionWorkspace } from "../../apps/web/app/workspace/execution-workspace";
import type { CommercialRequest } from "../../apps/web/app/workspace/commercial-ui";

const org = "10000000-0000-4000-8000-000000000031";
const projectId = "20000000-0000-4000-8000-000000000031";
const memberId = "30000000-0000-4000-8000-000000000031";
const visitId = "40000000-0000-4000-8000-000000000031";
const taskId = "50000000-0000-4000-8000-000000000031";
const now = "2026-09-23T12:00:00.000Z";
const base = "/api/cpl-execution";
const copy = <T,>(value: T): T => structuredClone(value);
function project() {
  return {
    id: projectId,
    organizationId: org,
    reference: "PRJ-EXAMPLE",
    snapshot: {
      version: {
        content: {
          title: "Awarded inspection",
          accessInstructions: "Original access instructions",
        },
        sourceLead: {
          fields: {
            requestedService: "Inspection",
            customerName: "Fictional clinic",
            siteName: "Clinic roof",
            siteAddress: "Example address",
          },
        },
      },
    },
  } as CplCommercialProject;
}
function savedVisit(): CplVisit {
  const input: CplVisitInput = {
    purpose: "Roof survey",
    serviceType: "Inspection",
    status: "scheduled",
    timeZone: CPL_EXECUTION_TIME_ZONE,
    plannedStartLocal: "2026-10-05T09:00",
    plannedEndLocal: "2026-10-05T11:00",
    plannedStartOffsetMinutes: -240,
    plannedEndOffsetMinutes: -240,
    responsibleIdentityId: memberId,
    siteName: "Clinic roof",
    siteAddress: "Example address",
    accessInstructions: "Private site access",
    actualStartAt: null,
    actualEndAt: null,
    completionNote: "",
    cancellationReason: "",
    tasks: [
      {
        id: taskId,
        title: "Confirm access",
        instructions: "Contact site representative",
        required: true,
        status: "pending",
        note: "",
      },
    ],
  };
  return {
    ...input,
    id: visitId,
    projectId,
    organizationId: org,
    revision: 2,
    plannedStartAt: "2026-10-05T13:00:00.000Z",
    plannedEndAt: "2026-10-05T15:00:00.000Z",
    createdAt: now,
    updatedAt: now,
    createdByIdentityId: memberId,
    readiness: cplVisitReadiness(input),
  };
}
function workspace(): CplProjectWorkspace {
  return {
    project: project(),
    operations: {
      projectId,
      revision: 0,
      name: "Awarded inspection",
      status: "active",
      ownerIdentityId: memberId,
      teamIdentityIds: [memberId],
      nextAction: "Schedule access",
      operationalInstructions: "Confirm arrival with the site",
      internalNotes: "Private team note",
      timeZone: CPL_EXECUTION_TIME_ZONE,
      statusReason: "",
      updatedAt: null,
      updatedByIdentityId: null,
    },
    members: [{ identityId: memberId, displayName: "Development Owner", role: "owner" }],
    visits: [savedVisit()],
    events: [],
    permissions: { canPlan: true, canCompleteAssignedVisits: false },
    currentIdentityId: memberId,
  };
}
describe("CPL project execution workspace", () => {
  let data: CplProjectWorkspace;
  const request = vi.fn<(path: string, body?: unknown) => Promise<unknown>>();
  const dirty = vi.fn();
  const busy = vi.fn();
  const openProject = vi.fn();
  async function normal(path: string, body?: unknown): Promise<unknown> {
    if (path === `${base}/projects/${projectId}`) {
      if (body)
        data.operations = {
          ...data.operations,
          ...(body as { input: CplProjectWorkspace["operations"] }).input,
          revision: data.operations.revision + 1,
        };
      return copy(data);
    }
    if (path === `${base}/projects/${projectId}/visits` || path === `${base}/visits/${visitId}`) {
      const input = (body as { input: CplVisitInput }).input;
      const value: CplVisit = {
        ...savedVisit(),
        ...copy(input),
        id: path.endsWith("/visits") ? "40000000-0000-4000-8000-000000000032" : visitId,
        revision: path.endsWith("/visits") ? 1 : 3,
        readiness: cplVisitReadiness(input),
      };
      data.visits = [...data.visits.filter((item) => item.id !== value.id), value];
      return copy(value);
    }
    if (path.startsWith(`${base}/agenda?`))
      return {
        from: now,
        to: now,
        truncated: false,
        items: data.visits.map((visit) => ({
          visit: copy(visit),
          projectName: data.operations.name,
          projectReference: data.project.reference,
        })),
      };
    throw new Error(`Unexpected test request: ${path}`);
  }
  beforeEach(() => {
    data = workspace();
    request.mockReset().mockImplementation(normal);
    dirty.mockReset();
    busy.mockReset();
    openProject.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(window, "confirm").mockImplementation(() => false);
    vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute("open", "");
    });
    vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (
      this: HTMLDialogElement,
    ) {
      this.removeAttribute("open");
    });
  });
  afterEach(() => {
    expect(console.error).not.toHaveBeenCalled();
    expect(window.confirm).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
  async function open() {
    render(
      <ExecutionWorkspace
        project={project()}
        organizationId={org}
        request={request as CommercialRequest}
        onDirty={dirty}
        onBusy={busy}
        onOpenProject={openProject}
        agreement={<p>Original awarded scope · immutable example</p>}
      />,
    );
    await screen.findByLabelText("Operational project name");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh saved project" })).toBeEnabled(),
    );
  }
  async function edit() {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Visits", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Open visit Roof survey" }));
  }
  const mutations = () => request.mock.calls.filter(([, body]) => body !== undefined);

  it("keeps delivery edits guarded when returning to project operations", async () => {
    const deliveryBase = `/api/cpl-delivery/projects/${projectId}`;
    request.mockImplementation((path, body) =>
      path === deliveryBase
        ? Promise.resolve({
            project: {
              id: projectId,
              reference: "PRJ-EXAMPLE",
              name: "Awarded inspection",
              customerName: "Fictional clinic",
              contactName: "Example",
              contactEmail: "contact@example.invalid",
              serviceKey: "Inspection",
            },
            approvedReports: [],
            packages: [],
            policies: [],
            readiness: {},
            permissions: {
              canWrite: true,
              canConfirm: true,
              canConfigure: true,
              canOverride: true,
              canWithdrawApproval: true,
            },
          })
        : normal(path, body),
    );
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Delivery & readiness", exact: true }));
    fireEvent.click(await screen.findByRole("button", { name: "New delivery package" }));
    fireEvent.change(screen.getByLabelText("Customer name"), {
      target: { value: "Unsaved package customer" },
    });
    await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(true));
    fireEvent.click(screen.getByRole("button", { name: "Operations", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Customer name")).toHaveValue("Unsaved package customer");
    fireEvent.click(screen.getByRole("button", { name: "Operations", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    await screen.findByLabelText("Operational project name");
    await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(false));
    expect(mutations()).toHaveLength(0);
  });

  it("keeps project operations separate from the preserved award and saves the exact revision", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Operational project name"), {
      target: { value: "Delivery coordination" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save project operations" }));
    await screen.findByText(/Project operations saved/);
    expect(mutations()[0]![1]).toMatchObject({
      expectedRevision: 0,
      idempotencyKey: expect.any(String),
      input: { name: "Delivery coordination", teamIdentityIds: [memberId] },
    });
    expect(mutations()[0]![1]).not.toHaveProperty("snapshot");
    fireEvent.click(screen.getByRole("button", { name: "Awarded agreement" }));
    expect(screen.getByText("Original awarded scope · immutable example")).toBeVisible();
  });
  it("sends Indianapolis wall times unchanged and preserves the existing visit when creating another", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Visits", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "New visit", exact: true }));
    expect(screen.getByLabelText("Visit site")).toHaveValue("Clinic roof");
    fireEvent.change(screen.getByLabelText("Visit purpose"), {
      target: { value: "Window survey" },
    });
    fireEvent.change(screen.getByLabelText("Planned start · visit timezone"), {
      target: { value: "2026-10-06T09:00" },
    });
    fireEvent.change(screen.getByLabelText("Planned end · visit timezone"), {
      target: { value: "2026-10-06T10:00" },
    });
    fireEvent.change(screen.getByLabelText("Visit status"), { target: { value: "scheduled" } });
    fireEvent.click(screen.getByRole("button", { name: "Save visit" }));
    await screen.findByText(/Visit saved/);
    expect(mutations()[0]![1]).toMatchObject({
      input: {
        plannedStartLocal: "2026-10-06T09:00",
        plannedEndLocal: "2026-10-06T10:00",
        plannedStartOffsetMinutes: null,
        plannedEndOffsetMinutes: null,
        timeZone: CPL_EXECUTION_TIME_ZONE,
        responsibleIdentityId: memberId,
      },
    });
    expect(data.visits).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Open visit Roof survey" })).toBeVisible();
  });
  it("clears inherited UTC offsets when rescheduling across daylight saving", async () => {
    await edit();
    fireEvent.change(screen.getByLabelText("Planned start · visit timezone"), {
      target: { value: "2026-11-09T09:00" },
    });
    fireEvent.change(screen.getByLabelText("Planned end · visit timezone"), {
      target: { value: "2026-11-09T11:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save visit" }));
    await screen.findByText(/Visit saved/);
    expect(mutations()[0]![1]).toMatchObject({
      expectedRevision: 2,
      input: { plannedStartOffsetMinutes: null, plannedEndOffsetMinutes: null },
    });
  });
  it("retains edits and the same idempotency key after a lost response", async () => {
    let fail = true;
    request.mockImplementation(async (path, body) => {
      if (body && fail) {
        fail = false;
        throw new Error("Connection interrupted");
      }
      return normal(path, body);
    });
    await edit();
    fireEvent.change(screen.getByLabelText("Visit purpose"), {
      target: { value: "Updated survey" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save visit" }));
    await screen.findByText("Connection interrupted");
    expect(screen.getByLabelText("Visit purpose")).toHaveValue("Updated survey");
    fireEvent.click(screen.getByRole("button", { name: "Save visit" }));
    await screen.findByText(/Visit saved/);
    expect(mutations()[0]![1]).toEqual(mutations()[1]![1]);
  });
  it("keeps the retry key when the mutation succeeds but scoped readback fails", async () => {
    let wrote = false,
      failed = false;
    request.mockImplementation(async (path, body) => {
      if (body) wrote = true;
      if (!body && wrote && !failed) {
        failed = true;
        throw new Error("Readback interrupted");
      }
      return normal(path, body);
    });
    await edit();
    fireEvent.change(screen.getByLabelText("Visit purpose"), {
      target: { value: "Retry readback" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save visit" }));
    await screen.findByText("Readback interrupted");
    expect(dirty).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Save visit" }));
    await screen.findByText(/Visit saved/);
    expect(mutations()[0]![1]).toEqual(mutations()[1]![1]);
  });
  it("retains stale input and refuses resave until an explicit guarded reload", async () => {
    request.mockImplementation(async (path, body) => {
      if (body) throw Object.assign(new Error("stale"), { code: "CPL_EXECUTION_VERSION_CONFLICT" });
      return normal(path, body);
    });
    await edit();
    fireEvent.change(screen.getByLabelText("Visit purpose"), {
      target: { value: "Pending title" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save visit" }));
    await screen.findByText(/This record changed elsewhere/);
    expect(screen.getByLabelText("Visit purpose")).toHaveValue("Pending title");
    expect(screen.getByRole("button", { name: "Save visit" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh saved project" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Visit purpose")).toHaveValue("Pending title");
    fireEvent.click(screen.getByRole("button", { name: "Refresh saved project" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    await screen.findByText(/Saved project refreshed/);
    expect(screen.getByLabelText("Visit purpose")).toHaveValue("Roof survey");
  });
  it("guards visit navigation without a browser confirmation dialog", async () => {
    await edit();
    fireEvent.change(screen.getByLabelText("Visit completion note"), {
      target: { value: "Unsaved field note" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Agenda", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Visit completion note")).toHaveValue("Unsaved field note");
    fireEvent.click(screen.getByRole("button", { name: "Agenda", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByLabelText("Agenda from")).toBeVisible();
    expect(mutations()).toHaveLength(0);
  });
  it("starts tasks pending and records human-chosen completion without inventing actual times", async () => {
    await edit();
    expect(screen.getByLabelText("Task 1 status")).toHaveValue("pending");
    expect(screen.getByLabelText("Visit readiness")).toHaveTextContent(
      "Complete required task: Confirm access",
    );
    fireEvent.change(screen.getByLabelText("Task 1 status"), { target: { value: "completed" } });
    fireEvent.change(screen.getByLabelText("Visit status"), { target: { value: "completed" } });
    fireEvent.change(screen.getByLabelText("Visit completion note"), {
      target: { value: "Site work completed by owner" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record actual start now" }));
    fireEvent.click(screen.getByRole("button", { name: "Record actual finish now" }));
    fireEvent.click(screen.getByRole("button", { name: "Save visit" }));
    await screen.findByText(/Visit saved/);
    expect(mutations()[0]![1]).toMatchObject({
      input: {
        status: "completed",
        actualStartAt: expect.stringMatching(/Z$/),
        actualEndAt: expect.stringMatching(/Z$/),
        tasks: [expect.objectContaining({ id: taskId, status: "completed" })],
      },
    });
    expect(screen.getByRole("button", { name: "Save visit" })).toBeDisabled();
  });
  it("cancels one visit with its reason while preserving project status", async () => {
    await edit();
    fireEvent.change(screen.getByLabelText("Visit status"), { target: { value: "cancelled" } });
    fireEvent.change(screen.getByLabelText("Visit cancellation reason"), {
      target: { value: "Customer requested another date" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save visit" }));
    await screen.findByText(/Visit saved/);
    expect(mutations()[0]![0]).toBe(`${base}/visits/${visitId}`);
    expect(data.operations.status).toBe("active");
    expect(mutations()[0]![1]).toMatchObject({
      input: { cancellationReason: "Customer requested another date" },
    });
  });
  it("respects role permissions while allowing assigned field progress", async () => {
    data.permissions = { canPlan: false, canCompleteAssignedVisits: true };
    await edit();
    expect(screen.getByLabelText("Visit purpose")).toBeDisabled();
    expect(screen.getByLabelText("Responsible member")).toBeDisabled();
    expect(screen.getByLabelText("Task 1 title")).toBeDisabled();
    expect(screen.getByLabelText("Task 1 status")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Add visit task" })).toBeDisabled();
    expect(screen.getByLabelText("Visit completion note")).toBeEnabled();
  });
  it("makes completed visits read only and blocks new visits on a held project", async () => {
    data.operations.status = "on_hold";
    data.visits[0]!.status = "completed";
    await edit();
    expect(screen.getByRole("button", { name: "New visit", exact: true })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save visit" })).toBeDisabled();
    expect(screen.getByLabelText("Visit purpose")).toBeDisabled();
  });
  it("shows concrete conflict details and keeps the conflicting entries for correction", async () => {
    request.mockImplementation(async (path, body) => {
      if (body)
        throw Object.assign(new Error("conflict"), {
          code: "CPL_EXECUTION_SCHEDULE_CONFLICT",
          conflicts: [
            {
              visitId: "other",
              projectId,
              purpose: "Existing facade visit",
              plannedStartAt: "2026-10-05T13:00:00Z",
              plannedEndAt: "2026-10-05T14:00:00Z",
              timeZone: CPL_EXECUTION_TIME_ZONE,
            },
          ],
        });
      return normal(path, body);
    });
    await edit();
    fireEvent.click(screen.getByRole("button", { name: "Save visit" }));
    await screen.findByText(/Existing facade visit/);
    expect(screen.getByLabelText("Planned start · visit timezone")).toHaveValue("2026-10-05T09:00");
    expect(screen.getByRole("button", { name: "Save visit" })).toBeEnabled();
  });
  it("loads the real company agenda with timezone-bound date filters", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Agenda", exact: true }));
    fireEvent.change(screen.getByLabelText("Agenda from"), { target: { value: "2026-10-05" } });
    fireEvent.change(screen.getByLabelText("Agenda through"), { target: { value: "2026-10-05" } });
    fireEvent.click(screen.getByRole("button", { name: "Load agenda" }));
    await screen.findByRole("button", { name: "Open visit Roof survey" });
    const call = request.mock.calls.find(([path]) => path.startsWith(`${base}/agenda?`))!;
    expect(decodeURIComponent(call[0])).toContain(
      "from=2026-10-05T04:00:00.000Z&to=2026-10-06T04:00:00.000Z",
    );
    expect(mutations()).toHaveLength(0);
  });
  it("rejects a mismatched project response without exposing operational fields", async () => {
    data.project.organizationId = "different-company";
    render(
      <ExecutionWorkspace
        project={project()}
        organizationId={org}
        request={request as CommercialRequest}
        onDirty={dirty}
        onBusy={busy}
        agreement={<p>Award</p>}
      />,
    );
    await screen.findByText(/The selected project changed/);
    expect(screen.queryByLabelText("Operational project name")).not.toBeInTheDocument();
  });
});
