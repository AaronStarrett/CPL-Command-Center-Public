// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const s = vi.hoisted(() => ({
  session: vi.fn(),
  mutation: vi.fn(),
  storage: vi.fn(),
  getVerified: vi.fn(),
  approve: vi.fn(),
  getProjectWorkspace: vi.fn(),
  getReport: vi.fn(),
  getCustomerPreview: vi.fn(),
  getArtifact: vi.fn(),
  saveTemplate: vi.fn(),
  saveBranding: vi.fn(),
  createReport: vi.fn(),
  saveReport: vi.fn(),
  refreshSources: vi.fn(),
  submitReport: vi.fn(),
  requestChanges: vi.fn(),
  reviseReport: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/hosted-auth", () => ({
  withHostedRuntime: async (operation: (runtime: unknown) => Promise<unknown>) =>
    operation({ tenants: {} }),
  requireHostedSession: s.session,
  requireHostedMutation: s.mutation,
}));
vi.mock("@bea/database/hosted", () => ({
  SqlCplReportRepository: class {
    getProjectWorkspace = s.getProjectWorkspace;
    getReport = s.getReport;
    getCustomerPreview = s.getCustomerPreview;
    getArtifact = s.getArtifact;
    saveTemplate = s.saveTemplate;
    saveBranding = s.saveBranding;
    createReport = s.createReport;
    saveReport = s.saveReport;
    refreshSources = s.refreshSources;
    submitReport = s.submitReport;
    requestChanges = s.requestChanges;
    reviseReport = s.reviseReport;
  },
}));
vi.mock("@/lib/cpl-evidence-runtime", () => ({ cplEvidenceStorage: s.storage }));
vi.mock("@/lib/cpl-report-artifact", () => ({ approveCplReport: s.approve }));
import { GET, POST } from "../../apps/web/app/api/cpl-reports/[...path]/route";
const organizationId = "123e4567-e89b-12d3-a456-426614174000",
  projectId = "123e4567-e89b-12d3-a456-426614174001",
  reportId = "123e4567-e89b-12d3-a456-426614174002";
const base = ["projects", projectId, "reports", reportId],
  scope = { sessionToken: "private-session", organizationId, projectId, reportId };
const context = (path: string[]) => ({ params: Promise.resolve({ path }) });
function request(path: string[], body?: unknown, query = "", headers: Record<string, string> = {}) {
  return new Request("http://127.0.0.1:3400/api/cpl-reports/" + path.join("/") + query, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      "x-cpl-organization": organizationId,
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
describe("report HTTP approval and artifact boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    const session = {
      sessionToken: scope.sessionToken,
      session: { selectedOrganizationId: organizationId },
    };
    s.session.mockResolvedValue(session);
    s.mutation.mockResolvedValue(session);
    s.storage.mockResolvedValue({ getVerified: s.getVerified });
    s.getReport.mockResolvedValue({ id: reportId, state: "approved", revision: 7 });
    s.getArtifact.mockResolvedValue({
      version: 3,
      reference: {
        organizationId,
        objectId: "private-object",
        sha256: "a".repeat(64),
        byteLength: 4,
      },
    });
    s.getVerified.mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
    s.getCustomerPreview.mockResolvedValue({
      approvalState: "approved",
      version: 3,
      projection: { title: "Fictional report" },
    });
  });
  it("rejects absent sessions and CSRF before loading or creating PDFs", async () => {
    s.session.mockRejectedValue({ code: "CPL_AUTHENTICATION_REQUIRED" });
    expect(
      (await GET(request([...base, "pdf"], undefined, "?version=3"), context([...base, "pdf"])))
        .status,
    ).toBe(401);
    s.mutation.mockRejectedValue({ code: "CPL_CSRF_REJECTED" });
    expect(
      (
        await POST(
          request([...base, "approve"], { expectedRevision: 6, idempotencyKey: "approve-key" }),
          context([...base, "approve"]),
        )
      ).status,
    ).toBe(403);
    expect(s.storage).not.toHaveBeenCalled();
    expect(s.approve).not.toHaveBeenCalled();
  });
  it("requires exact project/report authorization before reading any stored PDF", async () => {
    s.getArtifact.mockRejectedValue({ code: "CPL_RECORD_NOT_FOUND" });
    expect(
      (await GET(request([...base, "pdf"], undefined, "?version=3"), context([...base, "pdf"])))
        .status,
    ).toBe(404);
    expect(s.getArtifact).toHaveBeenCalledWith({ ...scope, version: 3 });
    expect(s.storage).not.toHaveBeenCalled();
  });
  it("downloads immutable bytes for the requested approved version only", async () => {
    const response = await GET(
      request([...base, "pdf"], undefined, "?version=3"),
      context([...base, "pdf"]),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("x-cpl-report-version")).toBe("3");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(s.getVerified).toHaveBeenCalledWith(
      expect.objectContaining({ objectId: "private-object" }),
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([37, 80, 68, 70]));
    expect(s.approve).not.toHaveBeenCalled();
  });
  it("never accepts artifact references or client approval authority in a mutation", async () => {
    for (const forged of [
      { approved: true },
      { organizationId: "other" },
      { objectId: "forged" },
      { sha256: "b".repeat(64) },
    ])
      expect(
        (
          await POST(
            request([...base, "approve"], {
              expectedRevision: 6,
              idempotencyKey: "approve-key",
              ...forged,
            }),
            context([...base, "approve"]),
          )
        ).status,
      ).toBe(400);
    expect(s.approve).not.toHaveBeenCalled();
  });
  it("passes optimistic revision into approval and reads final detail only on success", async () => {
    const input = { expectedRevision: 6, idempotencyKey: "approve-key" };
    expect(
      (await POST(request([...base, "approve"], input), context([...base, "approve"]))).status,
    ).toBe(200);
    expect(s.approve).toHaveBeenCalledWith(
      expect.anything(),
      { ...scope, ...input },
      expect.anything(),
    );
    expect(s.getReport).toHaveBeenCalledWith(scope);
    s.approve.mockRejectedValue({ code: "CPL_REPORT_SOURCES_CHANGED" });
    s.getReport.mockClear();
    expect(
      (await POST(request([...base, "approve"], input), context([...base, "approve"]))).status,
    ).toBe(409);
    expect(s.getReport).not.toHaveBeenCalled();
  });
  it("uses the safe customer projection for an explicitly selected historical version", async () => {
    const response = await GET(
      request([...base, "preview"], undefined, "?version=3"),
      context([...base, "preview"]),
    );
    expect(await response.json()).toEqual({
      approvalState: "approved",
      version: 3,
      projection: { title: "Fictional report" },
    });
    expect(s.getCustomerPreview).toHaveBeenCalledWith({ ...scope, version: 3 });
    expect(s.getReport).not.toHaveBeenCalled();
  });
  it("permits explicit source reconciliation with corrected selection while retaining the revision precondition", async () => {
    const input = { title: "Corrected selection", visits: [] };
    s.refreshSources.mockResolvedValue({ revision: 8, sourcesStale: false });
    const response = await POST(
      request([...base, "sources"], {
        expectedRevision: 7,
        idempotencyKey: "explicit-reconcile-key",
        input,
      }),
      context([...base, "sources"]),
    );
    expect(response.status).toBe(200);
    expect(s.refreshSources).toHaveBeenCalledWith({
      ...scope,
      expectedRevision: 7,
      idempotencyKey: "explicit-reconcile-key",
      input,
    });
    expect(s.saveReport).not.toHaveBeenCalled();
  });
  it("rejects missing, duplicate, malformed versions and a stale tenant context", async () => {
    for (const query of ["", "?version=1&version=3", "?version=-1", "?version=NaN"])
      expect(
        (await GET(request([...base, "pdf"], undefined, query), context([...base, "pdf"]))).status,
      ).toBe(400);
    expect(
      (
        await GET(
          request([...base, "pdf"], undefined, "?version=3", { "x-cpl-organization": "other" }),
          context([...base, "pdf"]),
        )
      ).status,
    ).toBe(409);
    expect(s.getArtifact).not.toHaveBeenCalled();
  });
});
