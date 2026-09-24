import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CPL_EXECUTION_TIME_ZONE,
  cplVisitReadiness,
  type CplAssignedWorkWorkspace,
  type CplVisit,
  type CplVisitInput,
} from "@bea/domain/cpl-execution";
import { AssignedWorkspace } from "../../apps/web/app/workspace/assigned-workspace";
import type { CommercialRequest } from "../../apps/web/app/workspace/commercial-ui";
import type { FieldUpload } from "../../apps/web/app/workspace/field-upload";

const field = vi.hoisted(() => ({ received: vi.fn() }));
vi.mock("../../apps/web/app/workspace/field-workspace", () => ({
  FieldWorkspace: (props: Record<string, unknown>) => {
    field.received(props);
    return <p>Assigned field capture boundary</p>;
  },
}));

const org = "10000000-0000-4000-8000-000000000036";
const projectId = "20000000-0000-4000-8000-000000000036";
const identity = "30000000-0000-4000-8000-000000000036";
const visitId = "40000000-0000-4000-8000-000000000036";
const taskId = "50000000-0000-4000-8000-000000000036";
const assigned = "/api/cpl-execution/assigned";
const progress = `/api/cpl-execution/visits/${visitId}`;
const clone = <T,>(value: T): T => structuredClone(value);
function visit(): CplVisit {
  const input: CplVisitInput = {
    purpose: "Assigned equipment visit",
    serviceType: "Inspection",
    status: "scheduled",
    timeZone: CPL_EXECUTION_TIME_ZONE,
    plannedStartLocal: "2026-10-05T09:00",
    plannedEndLocal: "2026-10-05T11:00",
    plannedStartOffsetMinutes: -240,
    plannedEndOffsetMinutes: -240,
    responsibleIdentityId: identity,
    siteName: "Fictional service site",
    siteAddress: "100 Example Avenue",
    accessInstructions: "Use the approved entrance",
    actualStartAt: null,
    actualEndAt: null,
    completionNote: "",
    cancellationReason: "",
    tasks: [
      {
        id: taskId,
        title: "Check the assigned equipment",
        instructions: "Record the human observation",
        required: true,
        status: "pending",
        note: "Preserved task instruction note",
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
    createdAt: "2026-09-23T12:00:00.000Z",
    updatedAt: "2026-09-23T12:00:00.000Z",
    createdByIdentityId: identity,
    readiness: cplVisitReadiness(input),
  };
}
function workspace(): CplAssignedWorkWorkspace {
  return {
    currentIdentityId: identity,
    items: [
      {
        projectId,
        projectReference: "PRJ-ASSIGNED-EXAMPLE",
        projectName: "Fictional assigned service",
        visit: visit(),
      },
    ],
    truncated: false,
    permissions: { canCompleteAssignedVisits: true },
  };
}
type Save = {
  projectId: string;
  expectedRevision: number;
  idempotencyKey: string;
  input: CplVisitInput;
};

describe("assigned-only field workspace", () => {
  let data: CplAssignedWorkWorkspace;
  const request = vi.fn<(path: string, body?: unknown) => Promise<unknown>>();
  const upload = vi.fn();
  const dirty = vi.fn();
  const busy = vi.fn();
  async function normal(path: string, body?: unknown) {
    if (path === assigned && body === undefined) return clone(data);
    if (path === progress && body) {
      const save = body as Save;
      data.items[0]!.visit = {
        ...data.items[0]!.visit,
        ...clone(save.input),
        revision: save.expectedRevision + 1,
      };
      return clone(data.items[0]!.visit);
    }
    throw new Error(`Unexpected assigned-work request: ${path}`);
  }
  function mount() {
    return render(
      <AssignedWorkspace
        organizationId={org}
        request={request as CommercialRequest}
        upload={upload as FieldUpload}
        onDirty={dirty}
        onBusy={busy}
      />,
    );
  }
  async function selectVisit() {
    fireEvent.click(await screen.findByRole("button", { name: /Fictional assigned service/ }));
  }
  beforeEach(() => {
    data = workspace();
    request.mockReset().mockImplementation(normal);
    upload.mockReset();
    dirty.mockReset();
    busy.mockReset();
    field.received.mockReset();
  });

  it("opens assigned field capture using only the safe project reference and assigned visit", async () => {
    mount();
    await selectVisit();
    fireEvent.click(screen.getByRole("button", { name: "Open assigned fieldwork" }));
    expect(await screen.findByText("Assigned field capture boundary")).toBeVisible();
    expect(request.mock.calls).toEqual([[assigned]]);
    const props = field.received.mock.lastCall![0] as Record<string, unknown>;
    expect(props.project).toEqual({ id: projectId, reference: "PRJ-ASSIGNED-EXAMPLE" });
    expect(props.visit).toEqual(data.items[0]!.visit);
    expect(props.organizationId).toBe(org);
    expect(props.upload).toBe(upload);
    expect(
      screen.queryByText(/Award amount|Proposal pricing|Company directory/u),
    ).not.toBeInTheDocument();
  });

  it("sends the captured revision and actual progress while preserving manager-owned planning fields", async () => {
    const original = clone(data.items[0]!.visit);
    mount();
    await selectVisit();
    fireEvent.change(screen.getByRole("combobox", { name: "Visit progress" }), {
      target: { value: "in_progress" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record actual start now" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Completion note" }), {
      target: { value: "Human progress recorded" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /Check the assigned equipment/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save visit progress" }));
    await waitFor(() =>
      expect(request.mock.calls.filter(([path]) => path === assigned)).toHaveLength(2),
    );
    const sent = request.mock.calls.find(([path]) => path === progress)![1] as Save;
    expect(sent).toMatchObject({
      projectId,
      expectedRevision: 2,
      idempotencyKey: expect.any(String),
    });
    const originalInput = Object.fromEntries(
      Object.entries(original).filter(
        ([key]) =>
          ![
            "id",
            "projectId",
            "organizationId",
            "revision",
            "plannedStartAt",
            "plannedEndAt",
            "createdAt",
            "updatedAt",
            "createdByIdentityId",
            "readiness",
          ].includes(key),
      ),
    );
    expect(sent.input).toEqual({
      ...originalInput,
      status: "in_progress",
      actualStartAt: expect.any(String),
      completionNote: "Human progress recorded",
      tasks: [{ ...original.tasks[0]!, status: "completed" }],
    });
    expect(Number.isFinite(Date.parse(sent.input.actualStartAt!))).toBe(true);
    expect(dirty).toHaveBeenLastCalledWith(false);
  });

  it("retains rejected progress and reuses the idempotency key until the input changes", async () => {
    request.mockImplementation(async (path, body) => {
      if (path === progress)
        throw new Error("This visit changed; refresh and review your progress.");
      return normal(path, body);
    });
    mount();
    await selectVisit();
    fireEvent.change(screen.getByRole("textbox", { name: "Completion note" }), {
      target: { value: "Retain this human entry" },
    });
    for (let i = 0; i < 2; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Save visit progress" }));
      await screen.findByRole("alert");
    }
    let saves = request.mock.calls
      .filter(([path]) => path === progress)
      .map(([, body]) => body as Save);
    expect(saves).toHaveLength(2);
    expect(saves[0]!.idempotencyKey).toBe(saves[1]!.idempotencyKey);
    expect(saves.every((row) => row.expectedRevision === 2)).toBe(true);
    expect(screen.getByRole("textbox", { name: "Completion note" })).toHaveValue(
      "Retain this human entry",
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Completion note" }), {
      target: { value: "Corrected human entry" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save visit progress" }));
    await screen.findByRole("alert");
    saves = request.mock.calls
      .filter(([path]) => path === progress)
      .map(([, body]) => body as Save);
    expect(saves[2]!.idempotencyKey).not.toBe(saves[0]!.idempotencyKey);
    expect(request.mock.calls.filter(([path]) => path === assigned)).toHaveLength(1);
  });

  it.each(["no-permission", "completed", "cancelled"] as const)(
    "does not expose editable progress for %s",
    async (state) => {
      if (state === "no-permission") data.permissions.canCompleteAssignedVisits = false;
      else data.items[0]!.visit.status = state;
      mount();
      await selectVisit();
      expect(screen.getByRole("button", { name: "Save visit progress" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Record actual start now" })).toBeDisabled();
      expect(screen.getByRole("textbox", { name: "Completion note" })).toBeDisabled();
      expect(request.mock.calls).toEqual([[assigned]]);
    },
  );

  it("does not restore an old assignment when an earlier read resolves after a newer refresh", async () => {
    let resolveFirst!: (value: CplAssignedWorkWorkspace) => void;
    const first = new Promise<CplAssignedWorkWorkspace>((resolve) => {
      resolveFirst = resolve;
    });
    let reads = 0;
    request.mockImplementation(async () => (++reads === 1 ? first : { ...data, items: [] }));
    mount();
    await waitFor(() => expect(reads).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "Refresh assigned work" }));
    await screen.findByText(/No visits are currently assigned to you/);
    await act(async () => resolveFirst(data));
    expect(screen.getByText(/No visits are currently assigned to you/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /PRJ-/ })).not.toBeInTheDocument();
  });

  it("requires an unsaved-work decision before refreshing and removes a revoked assignment", async () => {
    mount();
    await selectVisit();
    fireEvent.change(screen.getByRole("textbox", { name: "Completion note" }), {
      target: { value: "Unsaved progress" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh assigned work" }));
    expect(await screen.findByRole("dialog")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("textbox", { name: "Completion note" })).toHaveValue(
      "Unsaved progress",
    );
    expect(request.mock.calls).toHaveLength(1);
    data.items = [];
    fireEvent.click(screen.getByRole("button", { name: "Refresh assigned work" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
    expect(await screen.findByText(/No visits are currently assigned to you/)).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Completion note" })).not.toBeInTheDocument();
    expect(request.mock.calls).toEqual([[assigned], [assigned]]);
  });
});
