import React, { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cplFieldReadiness,
  type CplFieldWorkspace,
  type CplFieldPhoto,
  type CplFieldTemplateVersion,
  type CplFieldObservationInput,
  type CplFieldPhotoMetadata,
  type CplFieldTemplateInput,
} from "@bea/domain/cpl-field";
import type { CplCommercialProject } from "@bea/domain/cpl-commercial";
import type { CplPhotoAnnotations } from "@bea/artifacts/cpl-photo-annotations";
import { FieldWorkspace } from "../../apps/web/app/workspace/field-workspace";
import { ExecutionWorkspace } from "../../apps/web/app/workspace/execution-workspace";
import type { CplProjectWorkspace } from "@bea/domain/cpl-execution";
import { PhotoAnnotations } from "../../apps/web/app/workspace/field-annotations";
import {
  uploadFieldPhoto,
  type FieldUpload,
  type FieldUploadInput,
} from "../../apps/web/app/workspace/field-upload";
import type { CommercialRequest } from "../../apps/web/app/workspace/commercial-ui";

const org = "10000000-0000-4000-8000-000000000032",
  projectId = "20000000-0000-4000-8000-000000000032",
  visitId = "30000000-0000-4000-8000-000000000032",
  memberId = "40000000-0000-4000-8000-000000000032",
  templateId = "50000000-0000-4000-8000-000000000032",
  sectionId = "60000000-0000-4000-8000-000000000032",
  itemId = "70000000-0000-4000-8000-000000000032",
  photoId = "80000000-0000-4000-8000-000000000032",
  observationId = "90000000-0000-4000-8000-000000000032";
const now = "2026-09-23T12:00:00.000Z",
  base = `/api/cpl-field/projects/${projectId}/visits/${visitId}`;
const copy = <T,>(value: T): T => structuredClone(value);
function template(): CplFieldTemplateVersion {
  return {
    id: templateId,
    organizationId: org,
    version: 1,
    createdAt: now,
    createdByIdentityId: memberId,
    name: "Fictional field checklist",
    description: "Record actual observations",
    sections: [
      {
        id: sectionId,
        title: "Site observations",
        items: [
          {
            id: itemId,
            label: "Recorded condition",
            instructions: "Describe observed conditions",
            type: "text",
            required: true,
            unit: "",
            options: [],
            naReasonRequired: true,
            minimumPhotos: 0,
          },
        ],
      },
    ],
  };
}
function photo(): CplFieldPhoto {
  const derivative = {
    sha256: "a".repeat(64),
    byteLength: 120,
    width: 200,
    height: 100,
    mimeType: "image/png" as const,
    pipelineVersion: "synthetic-test",
  };
  const metadata = {
    caption: "Synthetic facade",
    observationId: null,
    order: 0,
    overview: false,
    reportEligible: false,
    annotations: { coordinateSpace: "upright-normalized-v1" as const, shapes: [] },
    revision: 1,
    createdByIdentityId: memberId,
    createdAt: now,
  };
  return {
    id: photoId,
    organizationId: org,
    projectId,
    visitId,
    revision: 1,
    state: "ready",
    failureCode: null,
    attempts: 1,
    processingExpiresAt: null,
    original: {
      filename: "synthetic.png",
      mimeType: "image/png",
      sha256: "b".repeat(64),
      byteLength: 100,
      width: 200,
      height: 100,
      exifOrientation: 1,
    },
    upright: { width: 200, height: 100 },
    thumbnail: derivative,
    report: derivative,
    metadata,
    revisions: [metadata],
    createdByIdentityId: memberId,
    createdAt: now,
    updatedAt: now,
  };
}
function workspace(): CplFieldWorkspace {
  return {
    projectId,
    revision: 1,
    visit: {
      id: visitId,
      organizationId: org,
      projectId,
      revision: 2,
      purpose: "Envelope survey",
      serviceType: "Inspection",
      status: "in_progress",
      timeZone: "America/Indiana/Indianapolis",
      plannedStartLocal: "2026-09-23T08:00",
      plannedEndLocal: "2026-09-23T10:00",
      plannedStartOffsetMinutes: -240,
      plannedEndOffsetMinutes: -240,
      plannedStartAt: now,
      plannedEndAt: "2026-09-23T14:00:00.000Z",
      responsibleIdentityId: memberId,
      siteName: "Synthetic clinic",
      siteAddress: "Example address",
      accessInstructions: "Internal access",
      actualStartAt: now,
      actualEndAt: null,
      completionNote: "",
      cancellationReason: "",
      tasks: [],
      createdAt: now,
      updatedAt: now,
      createdByIdentityId: memberId,
      readiness: [],
    },
    template: template(),
    templates: [template()],
    answers: [],
    checklistRevisions: [],
    observations: [],
    photos: [],
    events: [],
    readiness: [
      { code: "CPL_FIELD_REQUIRED", field: itemId, message: "Recorded condition: not inspected" },
    ],
    permissions: {
      canManageTemplates: true,
      canAttachTemplate: true,
      canEdit: true,
      canReopen: true,
    },
  };
}
const project = {
  id: projectId,
  organizationId: org,
  reference: "PRJ-FICTIONAL",
  snapshot: {
    version: {
      sourceLead: { fields: { customerName: "Synthetic customer" } },
      content: { scope: "Original awarded inspection scope" },
    },
  },
} as CplCommercialProject;

describe("tenant field workspace", () => {
  let data: CplFieldWorkspace;
  const request = vi.fn<(path: string, body?: unknown) => Promise<unknown>>(),
    upload = vi.fn<(input: FieldUploadInput) => Promise<CplFieldPhoto>>(),
    dirty = vi.fn(),
    busy = vi.fn(),
    openVisit = vi.fn();
  async function normal(path: string, input?: unknown): Promise<unknown> {
    const body = input as Record<string, unknown> | undefined;
    if (path === base) return copy(data);
    if (path === "/api/cpl-field/templates") {
      const created = {
        ...template(),
        ...(body!.input as CplFieldTemplateInput),
        version: Number(body!.expectedVersion) + 1,
      };
      data.templates.push(created);
      return copy(created);
    }
    if (path.endsWith("/retry")) return copy(data.photos[0]);
    if (body && body.expectedRevision !== data.revision)
      throw Object.assign(new Error("stale"), { code: "CPL_FIELD_VERSION_CONFLICT" });
    if (path.endsWith("/checklist"))
      data.answers = copy(body!.answers as CplFieldWorkspace["answers"]);
    else if (path.endsWith("/template"))
      data.template = copy(
        data.templates.find(
          (value) => value.id === body!.templateId && value.version === body!.templateVersion,
        )!,
      );
    else if (path.endsWith("/observations")) {
      const value = {
        ...(body!.input as CplFieldObservationInput),
        revision: 1,
        createdAt: now,
        createdByIdentityId: memberId,
      };
      data.observations = [{ ...value, id: observationId, revisions: [value] }];
    } else if (path.endsWith(`/photos/${photoId}`)) {
      const row = data.photos[0]!;
      row.metadata = {
        ...(body!.input as CplFieldPhotoMetadata),
        revision: row.metadata.revision + 1,
        createdAt: now,
        createdByIdentityId: memberId,
      };
      row.revisions.push(copy(row.metadata));
    } else if (path.endsWith("/reopen"))
      data.visit = {
        ...data.visit,
        status: "in_progress",
        revision: data.visit.revision + 1,
        actualEndAt: null,
      };
    else throw new Error(`Unexpected test endpoint: ${path}`);
    data.revision++;
    data.readiness = cplFieldReadiness(data.template, data.answers, data.photos);
    return copy(data);
  }
  beforeEach(() => {
    data = workspace();
    request.mockReset().mockImplementation(normal);
    upload.mockReset().mockImplementation(async ({ onProgress }) => {
      onProgress(45);
      const value = photo();
      data.photos = [value];
      data.revision++;
      return value;
    });
    dirty.mockReset();
    busy.mockReset();
    openVisit.mockReset();
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
      <FieldWorkspace
        project={project}
        visit={data.visit}
        organizationId={org}
        request={request as CommercialRequest}
        upload={upload as FieldUpload}
        onDirty={dirty}
        onBusy={busy}
        onOpenVisit={openVisit}
      />,
    );
    await screen.findByRole("heading", { name: "Fictional field checklist · v1" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh saved fieldwork" })).toBeEnabled(),
    );
  }
  function mutations() {
    return request.mock.calls.filter(([, body]) => body !== undefined);
  }
  it("guards project navigation around unsaved field evidence and reloads visit progress", async () => {
    const execution = {
      project,
      operations: {
        projectId,
        revision: 1,
        name: "Synthetic execution",
        status: "active",
        ownerIdentityId: memberId,
        teamIdentityIds: [],
        nextAction: "Capture evidence",
        operationalInstructions: "",
        internalNotes: "",
        timeZone: data.visit.timeZone,
        statusReason: "",
        updatedAt: now,
        updatedByIdentityId: memberId,
      },
      members: [{ identityId: memberId, displayName: "Synthetic Field Owner", role: "owner" }],
      visits: [data.visit],
      events: [],
      permissions: { canPlan: true, canCompleteAssignedVisits: false },
      currentIdentityId: memberId,
    } as CplProjectWorkspace;
    request.mockImplementation((path, body) =>
      path === `/api/cpl-execution/projects/${projectId}`
        ? Promise.resolve(copy(execution))
        : normal(path, body),
    );
    render(
      <ExecutionWorkspace
        project={project}
        organizationId={org}
        request={request as CommercialRequest}
        upload={upload as FieldUpload}
        agreement={<p>Preserved agreement</p>}
        onDirty={dirty}
        onBusy={busy}
      />,
    );
    await screen.findByLabelText("Operational project name");
    fireEvent.click(screen.getByRole("button", { name: "Field work", exact: true }));
    fireEvent.change(screen.getByLabelText("Field visit"), { target: { value: visitId } });
    await screen.findByRole("heading", { name: "Fictional field checklist · v1" });
    fireEvent.change(screen.getByLabelText("Recorded condition value"), {
      target: { value: "Keep my evidence" },
    });
    await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(true));
    fireEvent.click(screen.getByRole("button", { name: "Operations", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Recorded condition value")).toHaveValue("Keep my evidence");
    fireEvent.click(screen.getByRole("button", { name: "Operations", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    await screen.findByLabelText("Operational project name");
    await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(false));
    fireEvent.click(screen.getByRole("button", { name: "Field work", exact: true }));
    await screen.findByRole("heading", { name: "Fictional field checklist · v1" });
    fireEvent.click(screen.getByRole("button", { name: "Review visit", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Open visit progress & completion" }));
    await screen.findByRole("form", { name: "Edit visit" });
    expect(
      request.mock.calls.filter(([path]) => path === `/api/cpl-execution/projects/${projectId}`),
    ).toHaveLength(2);
  });
  async function tab(label: string) {
    fireEvent.click(screen.getByRole("button", { name: label, exact: true }));
  }

  it("starts unchecked as not inspected and saves an incomplete draft without inventing success", async () => {
    await open();
    expect(
      within(screen.getByRole("radiogroup", { name: "Recorded condition result" })).getByLabelText(
        "Not inspected",
      ),
    ).toBeChecked();
    fireEvent.change(screen.getByLabelText("Recorded condition value"), {
      target: { value: "Initial note" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save checklist draft" }));
    await screen.findByText(/Checklist draft saved/);
    expect(mutations()[0]![1]).toMatchObject({
      expectedRevision: 1,
      answers: [{ itemId, result: "not_inspected", value: "Initial note" }],
    });
    expect(screen.getByLabelText("Field readiness")).toHaveTextContent("not inspected");
  });
  it("recovers a reserved upload after reload without depending on a lost in-memory file queue", async () => {
    data.photos = [{ ...photo(), state: "reserved", thumbnail: null, report: null, upright: null }];
    request.mockImplementation(async (path, body) => {
      if (path.endsWith("/retry")) {
        data.photos[0] = {
          ...data.photos[0]!,
          state: "failed",
          failureCode: "CPL_PHOTO_ORIGINAL_UNAVAILABLE",
        };
        return copy(data.photos[0]);
      }
      return normal(path, body);
    });
    await open();
    await tab("Photos");
    expect(screen.queryByRole("button", { name: "Upload selected photos" })).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Check original and recover synthetic.png" }),
    );
    await screen.findByText(/The original file is unavailable. Choose the photo again/);
    expect(mutations()[0]).toEqual([
      `${base}/photos/${photoId}/retry`,
      { idempotencyKey: expect.any(String) },
    ]);
    expect(
      screen.queryByRole("link", { name: "Download original synthetic.png" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Choose JPEG or PNG photos · up to 12 MiB each")).toBeEnabled();
  });
  it("supports all four result states and required N/A reasons without blocking draft saves", async () => {
    await open();
    fireEvent.click(screen.getByLabelText("Not applicable"));
    expect(screen.getByLabelText("Field readiness")).toHaveTextContent("explain why");
    fireEvent.change(screen.getByLabelText("Recorded condition note / N/A reason"), {
      target: { value: "No access to this component during this visit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save checklist draft" }));
    await screen.findByText(/Checklist draft saved/);
    expect(mutations()[0]![1]).toMatchObject({
      answers: [
        expect.objectContaining({
          result: "not_applicable",
          note: "No access to this component during this visit",
        }),
      ],
    });
    expect(screen.getByText(/Current checklist requirements are met/)).toBeVisible();
  });
  it("retains stale answers until an explicit reload and uses the fresh revision afterward", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Recorded condition value"), {
      target: { value: "Unsaved assessment" },
    });
    data.revision = 5;
    data.answers = [
      { itemId, result: "complete", value: "Other saved edit", note: "", photoIds: [] },
    ];
    fireEvent.click(screen.getByRole("button", { name: "Save checklist draft" }));
    await screen.findByText(/Field information changed elsewhere/);
    expect(screen.getByLabelText("Recorded condition value")).toHaveValue("Unsaved assessment");
    expect(screen.getByRole("button", { name: "Save checklist draft" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh saved fieldwork" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Recorded condition value")).toHaveValue("Unsaved assessment");
    fireEvent.click(screen.getByRole("button", { name: "Refresh saved fieldwork" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    await screen.findByText(/Saved fieldwork refreshed/);
    expect(screen.getByLabelText("Recorded condition value")).toHaveValue("Other saved edit");
    fireEvent.click(screen.getByRole("button", { name: "Save checklist draft" }));
    await screen.findByText(/Checklist draft saved/);
    expect(mutations().at(-1)![1]).toMatchObject({ expectedRevision: 5 });
  });
  it("keeps human observation fields blank, private by default, and guards navigation", async () => {
    await open();
    await tab("Observations");
    fireEvent.click(screen.getByRole("button", { name: "New observation" }));
    expect(screen.getByLabelText("Priority · human selected")).toHaveValue("");
    expect(screen.getByLabelText("Observation eligible for report selection")).not.toBeChecked();
    fireEvent.change(screen.getByLabelText("Observation title"), {
      target: { value: "Visible sealant gap" },
    });
    await tab("Photos");
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Observation title")).toHaveValue("Visible sealant gap");
    fireEvent.click(screen.getByRole("button", { name: "Save observation" }));
    await screen.findByText(/Observation saved/);
    expect(mutations()[0]![1]).toMatchObject({
      input: {
        title: "Visible sealant gap",
        description: "",
        priority: "",
        category: "",
        reportEligible: false,
      },
    });
  });
  it("uploads ordinary selected files, reports a failure and reuses the same per-file identity", async () => {
    let failed = false;
    upload.mockImplementation(async ({ onProgress }) => {
      if (!failed) {
        failed = true;
        throw new Error("Synthetic transfer interrupted");
      }
      onProgress(100);
      data.photos = [photo()];
      data.revision++;
      return photo();
    });
    await open();
    await tab("Photos");
    const file = new File(["synthetic fixture bytes"], "synthetic.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Choose JPEG or PNG photos · up to 12 MiB each"), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload selected photos" }));
    await screen.findByText("Synthetic transfer interrupted");
    expect(dirty).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry synthetic.png" }));
    await screen.findByRole("button", { name: "Edit photo synthetic.png" });
    expect(upload.mock.calls[0]![0].file).toBe(file);
    expect(upload.mock.calls[0]![0].idempotencyKey).toBe(upload.mock.calls[1]![0].idempotencyKey);
    expect(upload.mock.calls[1]![0]).toMatchObject({ projectId, visitId });
  });
  it("does not claim the original is stored when only its reservation exists", async () => {
    upload.mockImplementation(async () => {
      const value = {
        ...photo(),
        state: "reserved" as const,
        failureCode: "CPL_PHOTO_ORIGINAL_UNAVAILABLE" as const,
        thumbnail: null,
        report: null,
        upright: null,
      };
      data.photos = [value];
      data.revision++;
      return value;
    });
    await open();
    await tab("Photos");
    fireEvent.change(screen.getByLabelText("Choose JPEG or PNG photos · up to 12 MiB each"), {
      target: { files: [new File(["x"], "synthetic.png", { type: "image/png" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload selected photos" }));
    await screen.findByText(/photo record exists but the original file is not confirmed/);
    expect(screen.getByRole("button", { name: "Retry synthetic.png" })).toBeVisible();
    expect(dirty).toHaveBeenLastCalledWith(true);
  });
  it("saves photo captions and normalized annotations while preserving the original hash", async () => {
    data.photos = [photo()];
    await open();
    await tab("Photos");
    fireEvent.click(screen.getByRole("button", { name: "Edit photo synthetic.png" }));
    fireEvent.change(screen.getByLabelText("Photo caption"), {
      target: { value: "Observed corner joint" },
    });
    fireEvent.click(screen.getByLabelText("Photo eligible for report selection"));
    fireEvent.click(screen.getByRole("button", { name: "Add arrow" }));
    fireEvent.change(screen.getByLabelText("Arrow end X (%)"), { target: { value: "75" } });
    fireEvent.click(screen.getByRole("button", { name: "Save photo changes" }));
    await screen.findByText(/Photo metadata and annotation revision saved/);
    expect(mutations()[0]![1]).toMatchObject({
      expectedRevision: 1,
      input: {
        caption: "Observed corner joint",
        reportEligible: true,
        annotations: {
          coordinateSpace: "upright-normalized-v1",
          shapes: [expect.objectContaining({ kind: "arrow", x2: 0.75 })],
        },
      },
    });
    expect(data.photos[0]!.original.sha256).toBe("b".repeat(64));
    expect(data.photos[0]!.revisions).toHaveLength(2);
  });
  it("links ready photos to required checklist fields and preserves exact numeric units", async () => {
    data.template!.sections[0]!.items[0] = {
      ...data.template!.sections[0]!.items[0]!,
      type: "number",
      unit: "mm",
      minimumPhotos: 1,
    };
    data.photos = [photo()];
    await open();
    fireEvent.click(screen.getByLabelText("Complete / pass"));
    fireEvent.change(screen.getByLabelText("Recorded condition value (mm)"), {
      target: { value: "3.25" },
    });
    fireEvent.click(screen.getByLabelText("Synthetic facade · ready"));
    fireEvent.click(screen.getByRole("button", { name: "Save checklist draft" }));
    await screen.findByText(/Checklist draft saved/);
    expect(mutations()[0]![1]).toMatchObject({
      answers: [expect.objectContaining({ value: 3.25, photoIds: [photoId], result: "complete" })],
    });
  });
  it("creates a template version through ordinary fields without changing the visit snapshot", async () => {
    await open();
    await tab("Checklist templates");
    fireEvent.change(screen.getByLabelText("Template version to edit"), {
      target: { value: `${templateId}:1` },
    });
    fireEvent.change(screen.getByLabelText("Field 1.1 label"), {
      target: { value: "Revised observation prompt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save new template version" }));
    await screen.findByText(/Checklist template version saved/);
    expect(mutations()[0]![1]).toMatchObject({
      templateId,
      expectedVersion: 1,
      input: {
        sections: [
          { items: [expect.objectContaining({ label: "Revised observation prompt", id: itemId })] },
        ],
      },
    });
    expect(data.template!.version).toBe(1);
    expect(data.template!.sections[0]!.items[0]!.label).toBe("Recorded condition");
  });
  it("requires an explicit reason and both revisions to reopen completed work", async () => {
    data.visit.status = "completed";
    data.permissions.canEdit = false;
    await open();
    expect(screen.getByRole("button", { name: "Save checklist draft" })).toBeDisabled();
    await tab("Review visit");
    expect(screen.getByRole("button", { name: "Reopen completed visit" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Reason to reopen completed fieldwork"), {
      target: { value: "Add omitted human observation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reopen completed visit" }));
    await screen.findByText(/Completed visit reopened/);
    expect(mutations()[0]![1]).toMatchObject({
      expectedRevision: 1,
      expectedVisitRevision: 2,
      reason: "Add omitted human observation",
      idempotencyKey: expect.any(String),
    });
  });
});

describe("accessible normalized photo annotations", () => {
  it("creates all supported shapes with labeled keyboard controls and keeps text inert", () => {
    const changed = vi.fn();
    function Harness() {
      const [value, setValue] = useState<CplPhotoAnnotations>({
        coordinateSpace: "upright-normalized-v1",
        shapes: [],
      });
      return (
        <PhotoAnnotations
          value={value}
          src="/synthetic-authorized-photo"
          width={400}
          height={200}
          disabled={false}
          onChange={(next) => {
            changed(next);
            setValue(next);
          }}
        />
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Add rectangle" }));
    fireEvent.change(screen.getByLabelText("Annotation width (%)"), { target: { value: "40" } });
    fireEvent.click(screen.getByRole("button", { name: "Add circle / oval" }));
    fireEvent.click(screen.getByRole("button", { name: "Add arrow" }));
    fireEvent.click(screen.getByRole("button", { name: "Add text label" }));
    fireEvent.change(screen.getByLabelText("Annotation label text"), {
      target: { value: "<script>inert note</script>" },
    });
    const value = changed.mock.calls.at(-1)![0] as CplPhotoAnnotations;
    expect(value.coordinateSpace).toBe("upright-normalized-v1");
    expect(value.shapes.map((shape) => shape.kind)).toEqual([
      "rectangle",
      "ellipse",
      "arrow",
      "label",
    ]);
    expect(value.shapes[0]).toMatchObject({ width: 0.4 });
    expect(document.querySelector("svg script")).toBeNull();
    expect(screen.getByText("<script>inert note</script>")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Remove selected annotation" }));
    expect(changed.mock.calls.at(-1)![0].shapes).toHaveLength(3);
  });
});

describe("scoped binary photo transport", () => {
  function fake() {
    const xhr = {
      open: vi.fn(),
      setRequestHeader: vi.fn(),
      send: vi.fn(),
      abort: vi.fn(),
      withCredentials: false,
      timeout: 0,
      status: 201,
      responseText: "{}",
      upload: {
        onprogress: null as
          null | ((event: { lengthComputable: boolean; loaded: number; total: number }) => void),
      },
      onload: null as null | (() => void),
      onerror: null as null | (() => void),
      ontimeout: null as null | (() => void),
      onabort: null as null | (() => void),
    };
    xhr.abort.mockImplementation(() => xhr.onabort?.());
    return xhr;
  }
  it("sends raw bytes with current scoped headers and real upload progress", async () => {
    const xhr = fake(),
      file = new File(["synthetic bytes"], "photo name.png", { type: "image/png" }),
      progress = vi.fn(),
      controller = new AbortController();
    const promise = uploadFieldPhoto(
      {
        projectId,
        visitId,
        file,
        idempotencyKey: "upload-key",
        signal: controller.signal,
        onProgress: progress,
      },
      { organizationId: org, csrfToken: "synthetic-csrf" },
      () => xhr as unknown as XMLHttpRequest,
    );
    expect(xhr.open).toHaveBeenCalledWith("POST", `${base}/photos`);
    expect(xhr.send).toHaveBeenCalledExactlyOnceWith(file);
    expect(xhr.withCredentials).toBe(true);
    expect(xhr.setRequestHeader).toHaveBeenCalledWith("X-CPL-Filename", "photo%20name.png");
    expect(xhr.setRequestHeader).toHaveBeenCalledWith("X-CPL-Organization", org);
    expect(xhr.setRequestHeader).toHaveBeenCalledWith("X-CPL-CSRF", "synthetic-csrf");
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
    expect(progress).toHaveBeenLastCalledWith(50);
    xhr.responseText = JSON.stringify(photo());
    xhr.onload?.();
    await expect(promise).resolves.toMatchObject({ id: photoId });
  });
  it("rejects unsupported image formats before opening a request and aborts active transfers", async () => {
    const xhr = fake(),
      create = vi.fn(() => xhr as unknown as XMLHttpRequest),
      controller = new AbortController();
    await expect(
      uploadFieldPhoto(
        {
          projectId,
          visitId,
          file: new File(["x"], "unsupported.gif", { type: "image/gif" }),
          idempotencyKey: "same",
          signal: controller.signal,
          onProgress: vi.fn(),
        },
        { organizationId: org, csrfToken: "synthetic" },
        create,
      ),
    ).rejects.toMatchObject({ code: "CPL_FIELD_PHOTO_TYPE_INVALID" });
    expect(create).not.toHaveBeenCalled();
    const promise = uploadFieldPhoto(
      {
        projectId,
        visitId,
        file: new File(["x"], "synthetic.png", { type: "image/png" }),
        idempotencyKey: "same",
        signal: controller.signal,
        onProgress: vi.fn(),
      },
      { organizationId: org, csrfToken: "synthetic" },
      create,
    );
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "CPL_FIELD_UPLOAD_ABORTED" });
    expect(xhr.abort).toHaveBeenCalledOnce();
  });
});
