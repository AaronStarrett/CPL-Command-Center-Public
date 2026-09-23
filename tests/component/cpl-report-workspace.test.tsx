import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CplReportDetail,
  CplReportWorkspace,
  CplReportTemplateVersion,
  CplReportContent,
  CplReportPublicProjection,
} from "@bea/domain/cpl-report";
import type { CplCommercialProject } from "@bea/domain/cpl-commercial";
import type { CommercialRequest } from "../../apps/web/app/workspace/commercial-ui";
import { ReportWorkspace } from "../../apps/web/app/workspace/report-workspace";
import { ExecutionWorkspace } from "../../apps/web/app/workspace/execution-workspace";
import type { CplProjectWorkspace } from "@bea/domain/cpl-execution";

const org = "10000000-0000-4000-8000-000000000033",
  projectId = "20000000-0000-4000-8000-000000000033",
  reportId = "30000000-0000-4000-8000-000000000033",
  templateId = "40000000-0000-4000-8000-000000000033",
  visitId = "50000000-0000-4000-8000-000000000033",
  observationId = "60000000-0000-4000-8000-000000000033",
  photoId = "70000000-0000-4000-8000-000000000033",
  memberId = "80000000-0000-4000-8000-000000000033";
const now = "2026-09-23T16:00:00.000Z",
  base = `/api/cpl-reports/projects/${projectId}`,
  record = `${base}/reports/${reportId}`;
const clone = <T,>(value: T): T => structuredClone(value);
const project = {
  id: projectId,
  organizationId: org,
  reference: "PRJ-FICTIONAL-REPORT",
  snapshot: {
    version: {
      content: { title: "Synthetic report project" },
      sourceLead: { fields: { customerName: "Synthetic clinic", siteName: "Facade" } },
    },
  },
} as CplCommercialProject;
function template(): CplReportTemplateVersion {
  return {
    id: templateId,
    organizationId: org,
    version: 1,
    name: "Fictional service report",
    description: "Human-authored default headings",
    title: "Service findings",
    scope: "Agreed scope",
    summary: "",
    limitations: "",
    conclusion: "",
    sections: [],
    sectionOrder: ["scope", "summary", "limitations", "visits", "conclusion", "sections"],
    createdAt: now,
    createdByIdentityId: memberId,
  };
}
function fixtures() {
  const tmpl = template();
  const content: CplReportContent = {
    title: tmpl.title,
    scope: tmpl.scope,
    summary: "",
    limitations: "",
    conclusion: "",
    sections: [],
    sectionOrder: [...tmpl.sectionOrder],
    visits: [],
  };
  const branding = {
    revision: 1,
    businessName: "Fictional Service Company",
    email: "team@example.invalid",
    phone: "",
    address: "Synthetic address",
    accentColor: "#163B4F",
    logoDataUrl: null,
  };
  const summary = {
    id: reportId,
    organizationId: org,
    projectId,
    reference: "RPT-FICTIONAL",
    revision: 2,
    currentVersion: 1,
    state: "draft" as const,
    title: content.title,
    createdAt: now,
    updatedAt: now,
  };
  const data: CplReportWorkspace = {
    projectId,
    reports: [summary],
    templates: [tmpl],
    branding,
    permissions: { canWrite: true, canReview: true, canConfigure: true },
    sources: [
      {
        visitId,
        title: "Envelope visit",
        status: "completed",
        revision: 2,
        fieldRevision: 8,
        observations: [
          {
            id: observationId,
            revision: 2,
            title: "Visible gap",
            description: "Original field wording",
            followUp: "Human follow-up",
            reportEligible: true,
          },
        ],
        photos: [
          {
            id: photoId,
            caption: "Synthetic sealant detail",
            observationId,
            overview: false,
            reportEligible: true,
            state: "ready",
            metadataRevision: 2,
          },
        ],
      },
    ],
  };
  const detail: CplReportDetail = {
    ...summary,
    versions: [
      {
        version: 1,
        content,
        template: tmpl,
        branding,
        sources: {
          project: {
            reference: project.reference,
            name: "Clinic survey",
            customerName: "Synthetic clinic",
            siteName: "Facade",
            siteAddress: "Synthetic address",
          },
          visits: [],
        },
        sourceHash: "a".repeat(64),
        createdByIdentityId: memberId,
        createdAt: now,
      },
    ],
    artifacts: [],
    events: [],
    sourcesStale: false,
    readiness: [],
    permissions: { ...data.permissions },
  };
  return { data, detail };
}
describe("tenant report workspace", () => {
  let data: CplReportWorkspace, detail: CplReportDetail;
  const request = vi.fn<(path: string, body?: unknown) => Promise<unknown>>(),
    dirty = vi.fn(),
    busy = vi.fn();
  async function normal(path: string, input?: unknown): Promise<unknown> {
    const body = input as Record<string, unknown> | undefined;
    if (path === base) return clone(data);
    if (path === record) return clone(detail);
    if (path === `${base}/reports`) return clone(detail);
    if (path === "/api/cpl-reports/templates") {
      const result = {
        ...template(),
        ...(body!.input as object),
        version: Number(body!.expectedVersion) + 1,
      };
      data.templates.push(result);
      return clone(result);
    }
    if (path === "/api/cpl-reports/branding") {
      data.branding = {
        ...(body!.input as NonNullable<CplReportWorkspace["branding"]>),
        revision: Number(body!.expectedRevision) + 1,
      };
      return clone(data.branding);
    }
    if (path.includes("/preview?")) {
      const version = Number(path.split("=")[1]);
      const saved = detail.versions.find((row) => row.version === version)!;
      const projection: CplReportPublicProjection = {
        reference: detail.reference,
        version,
        approvedAt: now,
        title: "SERVER CUSTOMER TITLE",
        scope: "Only projected customer scope",
        summary: "",
        limitations: "",
        conclusion: "",
        sections: [],
        sectionOrder: ["scope", "visits"],
        company: { ...saved.branding, brandingVersion: saved.branding.revision },
        project: saved.sources.project,
        visits: [
          {
            visitId,
            title: "Customer visit",
            date: "2026-09-23",
            timeZone: "America/Indiana/Indianapolis",
            personnel: ["Synthetic Field Owner"],
            observations: [
              {
                title: "Customer finding",
                category: "",
                priority: "",
                location: "Facade",
                description: "Public observed condition",
                followUp: "",
                revision: 2,
                photos: [
                  {
                    photoId,
                    caption: "Public caption",
                    layout: "large",
                    sha256: "b".repeat(64),
                    width: 200,
                    height: 100,
                    annotations: {
                      coordinateSpace: "upright-normalized-v1",
                      shapes: [
                        {
                          kind: "arrow",
                          x1: 0.1,
                          y1: 0.2,
                          x2: 0.8,
                          y2: 0.9,
                          color: "#D54032",
                          strokeWidth: 0.006,
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      };
      return {
        reportId,
        version,
        approvalState: detail.artifacts.some((item) => item.version === version)
          ? "approved"
          : "unapproved",
        projection,
      };
    }
    if (body?.expectedRevision !== detail.revision)
      throw Object.assign(new Error("stale"), { code: "CPL_REPORT_VERSION_CONFLICT" });
    if (path.endsWith("/save") || path.endsWith("/sources")) {
      detail.currentVersion++;
      const prior = clone(detail.versions.at(-1)!);
      detail.versions.push({
        ...prior,
        version: detail.currentVersion,
        content: body?.input ? clone(body.input as CplReportContent) : prior.content,
      });
      detail.title = detail.versions.at(-1)!.content.title;
      detail.sourcesStale = false;
    } else if (path.endsWith("/submit")) detail.state = "in_review";
    else if (path.endsWith("/review")) detail.state = "changes_requested";
    else if (path.endsWith("/revise")) detail.state = "draft";
    else if (path.endsWith("/approve")) {
      detail.state = "approved";
      detail.artifacts.push({
        reportId,
        version: detail.currentVersion,
        reference: {
          organizationId: org,
          objectId: "synthetic-immutable-object",
          sha256: "c".repeat(64),
          byteLength: 1000,
        },
        rendererVersion: "synthetic-test",
        approvedAt: now,
        approvedByIdentityId: memberId,
        sourceHash: "a".repeat(64),
      });
    } else throw new Error(`Unexpected fixture endpoint ${path}`);
    detail.revision++;
    data.reports = [
      {
        ...data.reports[0]!,
        state: detail.state,
        revision: detail.revision,
        currentVersion: detail.currentVersion,
        title: detail.title,
      },
    ];
    return clone(detail);
  }
  beforeEach(() => {
    ({ data, detail } = fixtures());
    request.mockReset().mockImplementation(normal);
    dirty.mockReset();
    busy.mockReset();
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
      <ReportWorkspace
        project={project}
        organizationId={org}
        request={request as CommercialRequest}
        onDirty={dirty}
        onBusy={busy}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /RPT-FICTIONAL · Service findings/ }),
    );
    await screen.findByLabelText("Report title");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save report version" })).toBeEnabled(),
    );
  }
  const mutations = () => request.mock.calls.filter(([, body]) => body !== undefined);
  it("opens the actual report selected by an action without creating or submitting it", async () => {
    render(
      <ReportWorkspace
        project={project}
        organizationId={org}
        request={request as CommercialRequest}
        onDirty={dirty}
        onBusy={busy}
        initialReportId={reportId}
      />,
    );
    expect(await screen.findByLabelText("Report title")).toHaveValue("Service findings");
    expect(request).toHaveBeenCalledWith(record);
    expect(mutations()).toHaveLength(0);
    await waitFor(() => expect(busy).toHaveBeenLastCalledWith(false));
  });
  it("opens the exact historical report projection from a delivery backlink", async () => {
    const newer = clone(detail.versions[0]!);
    newer.version = 2;
    newer.content.title = "Newer private draft";
    detail.versions.push(newer);
    detail.currentVersion = 2;
    render(
      <ReportWorkspace
        project={project}
        organizationId={org}
        request={request as CommercialRequest}
        onDirty={dirty}
        onBusy={busy}
        initialReportId={reportId}
        initialPreviewVersion={1}
      />,
    );
    expect(await screen.findByRole("heading", { name: "SERVER CUSTOMER TITLE" })).toBeVisible();
    expect(request).toHaveBeenCalledWith(`${record}/preview?version=1`);
    expect(request.mock.calls.some(([path]) => path.endsWith("preview?version=2"))).toBe(false);
    expect(screen.queryByText("Newer private draft")).not.toBeInTheDocument();
    expect(mutations()).toHaveLength(0);
    await waitFor(() => expect(busy).toHaveBeenLastCalledWith(false));
  });
  it("creates only from an explicit selected template version", async () => {
    data.reports = [];
    render(
      <ReportWorkspace
        project={project}
        organizationId={org}
        request={request as CommercialRequest}
        onDirty={dirty}
        onBusy={busy}
      />,
    );
    await screen.findByText("No reports have been created for this project.");
    expect(mutations()).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("New report template version"), {
      target: { value: `${templateId}:1` },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create report", exact: true }));
    await screen.findByText(/Report created from/);
    expect(mutations()[0]).toEqual([
      `${base}/reports`,
      expect.objectContaining({
        templateId,
        templateVersion: 1,
        idempotencyKey: expect.any(String),
      }),
    ]);
  });
  it("saves ordered report-only wording, selected findings and photo layout with revision fencing", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Report summary"), {
      target: { value: "Human report summary" },
    });
    fireEvent.click(screen.getByLabelText(/Include visit: Envelope visit/));
    fireEvent.click(screen.getByLabelText("Include finding: Visible gap"));
    fireEvent.change(screen.getByLabelText("Finding description · Visible gap"), {
      target: { value: "Report-only explanation" },
    });
    fireEvent.click(screen.getByLabelText("Include photo: Synthetic sealant detail"));
    fireEvent.change(screen.getByLabelText("Layout for Synthetic sealant detail"), {
      target: { value: "pair" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Move Summary earlier" }));
    fireEvent.click(screen.getByRole("button", { name: "Save report version" }));
    await screen.findByText(/A new report version was saved/);
    expect(mutations()[0]![1]).toMatchObject({
      expectedRevision: 2,
      input: {
        summary: "Human report summary",
        sectionOrder: ["summary", "scope", "limitations", "visits", "conclusion", "sections"],
        visits: [
          {
            visitId,
            observations: [
              {
                observationId,
                descriptionOverride: "Report-only explanation",
                photos: [{ photoId, layout: "pair" }],
              },
            ],
          },
        ],
      },
    });
    expect(data.sources[0]!.observations[0]!.description).toBe("Original field wording");
  });
  it("retains changed inputs on stale save and requires explicit guarded refresh", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Report title"), {
      target: { value: "Retain this title" },
    });
    detail.revision = 7;
    fireEvent.click(screen.getByRole("button", { name: "Save report version" }));
    await screen.findByText(/saved report changed elsewhere/);
    expect(screen.getByLabelText("Report title")).toHaveValue("Retain this title");
    expect(screen.getByRole("button", { name: "Save report version" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh saved reports" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Report title")).toHaveValue("Retain this title");
    fireEvent.click(screen.getByRole("button", { name: "Refresh saved reports" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    await screen.findByText(/Saved reports refreshed/);
    fireEvent.click(screen.getByRole("button", { name: "Save report version" }));
    await screen.findByText(/A new report version was saved/);
    expect(mutations().at(-1)![1]).toMatchObject({ expectedRevision: 7 });
  });
  it("retains idempotency after a successful save whose readback fails", async () => {
    await open();
    let saved = false,
      failed = false;
    request.mockImplementation(async (path, body) => {
      if (path.endsWith("/save")) {
        if (saved) return clone(detail);
        saved = true;
        return normal(path, body);
      }
      if (path === base && saved && !failed) {
        failed = true;
        throw new Error("Synthetic readback interrupted");
      }
      return normal(path, body);
    });
    fireEvent.change(screen.getByLabelText("Report title"), {
      target: { value: "Retry same saved report" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save report version" }));
    await screen.findByText("Synthetic readback interrupted");
    fireEvent.click(screen.getByRole("button", { name: "Save report version" }));
    await screen.findByText(/A new report version was saved/);
    const calls = mutations().filter(([path]) => path.endsWith("/save"));
    expect(calls[0]![1]).toEqual(calls[1]![1]);
    expect(detail.currentVersion).toBe(2);
  });
  it("requires deliberate source refresh and preserves saved wording", async () => {
    await open();
    detail.sourcesStale = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh saved reports" }));
    await screen.findByText(/Saved reports refreshed/);
    expect(screen.getByRole("button", { name: "Save report version" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Submit saved report for review" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Review source refresh" }));
    expect(mutations()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Keep retained sources" }));
    expect(mutations()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Review source refresh" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh sources into a new version" }));
    await screen.findByText(/Current field sources saved/);
    expect(mutations()[0]).toEqual([
      `${record}/sources`,
      expect.objectContaining({ expectedRevision: 2 }),
    ]);
    expect(screen.getByLabelText("Report title")).toHaveValue("Service findings");
  });
  it("guards revision reasons and approves with the exact API payload only after explicit clearing", async () => {
    await open();
    detail.state = "in_review";
    fireEvent.click(screen.getByRole("button", { name: "Refresh saved reports" }));
    await screen.findByText(/Saved reports refreshed/);
    expect(
      screen.queryByRole("link", { name: /Download approved report PDF/ }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Report revision reason"), {
      target: { value: "Reviewed the selected evidence" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Report versions & history" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Report revision reason")).toHaveValue(
      "Reviewed the selected evidence",
    );
    expect(screen.getByRole("button", { name: "Approve & generate final PDF" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Open report revision" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear report revision reason" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve & generate final PDF" }));
    await screen.findByText(/Report approved and its exact PDF recorded/);
    expect(mutations()[0]![1]).toEqual({
      expectedRevision: 2,
      idempotencyKey: expect.any(String),
    });
    expect(screen.getByRole("link", { name: "Download approved report PDF · v1" })).toHaveAttribute(
      "href",
      `${record}/pdf?version=1&organization=${org}`,
    );
    expect(screen.getByLabelText("Report revision reason")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Open report revision" })).toBeDisabled();
  });
  it("shows only server customer projection with correctly scaled saved annotations", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Customer report preview", exact: true }));
    const preview = await screen.findByRole("article", { name: "Customer report preview" });
    expect(preview).toHaveTextContent("SERVER CUSTOMER TITLE");
    expect(preview).toHaveTextContent("UNAPPROVED DRAFT");
    expect(preview).toHaveTextContent("2026-09-23 · America/Indiana/Indianapolis");
    expect(preview).not.toHaveTextContent("9/22/2026");
    expect(preview).not.toHaveTextContent("Original field wording");
    const image = within(preview).getByRole("img", { name: "Public caption" });
    expect(image).toHaveAttribute("viewBox", "0 0 200 100");
    expect(image.querySelector("line")).toHaveAttribute("x1", "20");
    expect(image.querySelector("line")).toHaveAttribute("y2", "90");
    expect(image.querySelector("image")).toHaveAttribute(
      "href",
      `/api/cpl-field/projects/${projectId}/visits/${visitId}/photos/${photoId}/file?variant=report&organization=${org}`,
    );
  });
  it("keeps failed template-save readback identity and retains original template versions", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Report templates", exact: true }));
    fireEvent.change(screen.getByLabelText("Report template to edit"), {
      target: { value: `${templateId}:1` },
    });
    fireEvent.change(screen.getByLabelText("Report summary"), {
      target: { value: "Updated default" },
    });
    let saved = false,
      failed = false;
    request.mockImplementation(async (path, body) => {
      if (path === "/api/cpl-reports/templates") {
        if (saved) return clone(data.templates.at(-1));
        saved = true;
        return normal(path, body);
      }
      if (path === base && saved && !failed) {
        failed = true;
        throw new Error("Synthetic template readback failed");
      }
      return normal(path, body);
    });
    fireEvent.click(screen.getByRole("button", { name: "Save new report template version" }));
    await screen.findByText("Synthetic template readback failed");
    fireEvent.click(screen.getByRole("button", { name: "Save new report template version" }));
    await screen.findByText(/Report template version saved/);
    const calls = mutations().filter(([path]) => path === "/api/cpl-reports/templates");
    expect(calls[0]![1]).toEqual(calls[1]![1]);
    expect(data.templates).toHaveLength(2);
    expect(detail.versions[0]!.template.version).toBe(1);
  });
  it("obeys server permissions for authoring and company settings", async () => {
    data.permissions = { canWrite: false, canReview: false, canConfigure: false };
    detail.permissions = { ...data.permissions };
    render(
      <ReportWorkspace
        project={project}
        organizationId={org}
        request={request as CommercialRequest}
        onDirty={dirty}
        onBusy={busy}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /RPT-FICTIONAL · Service findings/ }),
    );
    await screen.findByLabelText("Report title");
    expect(screen.getByLabelText("Report title")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save report version" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Report company identity", exact: true }));
    expect(screen.getByLabelText("Report business name")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save report company identity" })).toBeDisabled();
    expect(mutations()).toHaveLength(0);
  });
  it("reconciles now-private findings explicitly while retaining unsaved report wording", async () => {
    detail.versions[0]!.content.visits = [
      {
        visitId,
        observations: [
          {
            observationId,
            titleOverride: null,
            descriptionOverride: "Previously approved wording",
            followUpOverride: null,
            photos: [{ photoId, layout: "large" }],
          },
        ],
        overviewPhotos: [],
      },
    ];
    data.sources[0]!.observations[0]!.reportEligible = false;
    await open();
    detail.sourcesStale = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh saved reports" }));
    await screen.findByText(/Saved reports refreshed/);
    fireEvent.change(screen.getByLabelText("Report summary"), {
      target: { value: "Keep this new reconciliation explanation" },
    });
    const finding = screen.getByLabelText("Include finding: Visible gap · internal only");
    expect(finding).toBeEnabled();
    fireEvent.click(finding);
    expect(screen.getByRole("button", { name: "Save report version" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Review source refresh" }));
    expect(mutations()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Refresh sources into a new version" }));
    await screen.findByText(/Current field sources saved/);
    expect(mutations()[0]![1]).toMatchObject({
      expectedRevision: 2,
      input: {
        summary: "Keep this new reconciliation explanation",
        visits: [{ visitId, observations: [], overviewPhotos: [] }],
      },
    });
    expect(detail.versions[0]!.content.visits[0]!.observations).toHaveLength(1);
    expect(detail.versions[1]!.content.visits[0]!.observations).toHaveLength(0);
  });
  it("keeps historical approved PDFs associated with their exact versions", async () => {
    detail.artifacts = [
      {
        reportId,
        version: 1,
        reference: {
          organizationId: org,
          objectId: "synthetic-object",
          sha256: "c".repeat(64),
          byteLength: 100,
        },
        rendererVersion: "synthetic-test",
        approvedAt: now,
        approvedByIdentityId: memberId,
        sourceHash: "a".repeat(64),
      },
    ];
    detail.versions.push({
      ...clone(detail.versions[0]!),
      version: 2,
      content: { ...clone(detail.versions[0]!.content), title: "New draft revision" },
    });
    detail.currentVersion = 2;
    await open();
    expect(
      screen.queryByRole("link", { name: /Download approved report PDF/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Report versions & history" }));
    expect(screen.getByRole("link", { name: "Download approved PDF version 1" })).toHaveAttribute(
      "href",
      `${record}/pdf?version=1&organization=${org}`,
    );
    expect(
      screen.queryByRole("link", { name: "Download approved PDF version 2" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View report version 1" }));
    await screen.findByRole("article", { name: "Customer report preview" });
    expect(screen.getByRole("link", { name: "Download approved report PDF · v1" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Report builder" }));
    expect(screen.getByLabelText("Report title")).toHaveValue("New draft revision");
    expect(
      screen.queryByRole("link", { name: /Download approved report PDF/ }),
    ).not.toBeInTheDocument();
  });
  it("guards backward navigation to the source field visit", async () => {
    const openField = vi.fn();
    detail.versions[0]!.content.visits = [{ visitId, observations: [], overviewPhotos: [] }];
    render(
      <ReportWorkspace
        project={project}
        organizationId={org}
        request={request as CommercialRequest}
        onDirty={dirty}
        onBusy={busy}
        onOpenField={openField}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /RPT-FICTIONAL · Service findings/ }),
    );
    await screen.findByLabelText("Report title");
    fireEvent.change(screen.getByLabelText("Report title"), {
      target: { value: "Preserve report edits" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open source field visit Envelope visit" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(openField).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Report title")).toHaveValue("Preserve report edits");
    fireEvent.click(screen.getByRole("button", { name: "Open source field visit Envelope visit" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(openField).toHaveBeenCalledWith(visitId);
  });
  it("integrates report edits with the existing project navigation guard", async () => {
    const execution: CplProjectWorkspace = {
      project,
      operations: {
        projectId,
        revision: 1,
        name: "Synthetic project",
        status: "active",
        ownerIdentityId: memberId,
        teamIdentityIds: [],
        nextAction: "Review report",
        operationalInstructions: "",
        internalNotes: "",
        timeZone: "America/Indiana/Indianapolis",
        statusReason: "",
        updatedAt: now,
        updatedByIdentityId: memberId,
      },
      members: [{ identityId: memberId, displayName: "Synthetic Owner", role: "owner" }],
      visits: [],
      events: [],
      permissions: { canPlan: true, canCompleteAssignedVisits: false },
      currentIdentityId: memberId,
    };
    request.mockImplementation((path, body) =>
      path === `/api/cpl-execution/projects/${projectId}`
        ? Promise.resolve(clone(execution))
        : normal(path, body),
    );
    render(
      <ExecutionWorkspace
        project={project}
        organizationId={org}
        request={request as CommercialRequest}
        agreement={<p>Retained award</p>}
        onDirty={dirty}
        onBusy={busy}
      />,
    );
    await screen.findByLabelText("Operational project name");
    fireEvent.click(screen.getByRole("button", { name: "Reports", exact: true }));
    fireEvent.click(
      await screen.findByRole("button", { name: /RPT-FICTIONAL · Service findings/ }),
    );
    await screen.findByLabelText("Report title");
    fireEvent.change(screen.getByLabelText("Report summary"), {
      target: { value: "Unsaved report finding" },
    });
    await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(true));
    fireEvent.click(screen.getByRole("button", { name: "Operations", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Report summary")).toHaveValue("Unsaved report finding");
    fireEvent.click(screen.getByRole("button", { name: "Operations", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    await screen.findByLabelText("Operational project name");
    await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(false));
    expect(mutations()).toHaveLength(0);
  });
});
