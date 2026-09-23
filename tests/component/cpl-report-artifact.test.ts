// @vitest-environment node
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlCplReportRepository } from "@bea/database/hosted";
const pdf = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@bea/artifacts/cpl-report-pdf", () => ({
  renderCplReportPdf: pdf.render,
  CPL_REPORT_PDF_RENDERER_VERSION: "test-renderer-v1",
}));
import { approveCplReport } from "../../apps/web/lib/cpl-report-artifact";
const bytes = new Uint8Array([137, 80, 78, 71]),
  pdfBytes = new Uint8Array([37, 80, 68, 70]);
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const scope = {
  sessionToken: "reviewer-session",
  organizationId: "org",
  projectId: "project",
  reportId: "report",
  expectedRevision: 8,
  idempotencyKey: "stable-approval-key",
};
function fixture() {
  const reference = {
    organizationId: "org",
    objectId: "derived-photo",
    sha256: digest(bytes),
    byteLength: bytes.length,
  };
  const projection = {
    reference: "R-001",
    version: 3,
    approvedAt: "2026-09-23T16:00:00.000Z",
    title: "Fictional report",
    scope: "Recorded scope",
    limitations: "Visible example only",
    summary: "Human summary",
    conclusion: "Human conclusion",
    sections: [],
    sectionOrder: ["visits"],
    company: {
      businessName: "Fictional",
      email: "",
      phone: "",
      address: "",
      logoDataUrl: null,
      accentColor: "#123456",
      brandingVersion: 1,
    },
    project: {
      reference: "P-001",
      name: "Fictional project",
      customerName: "Example",
      siteName: "Example site",
      siteAddress: "",
    },
    visits: [
      {
        title: "Visit",
        date: "2026-09-21",
        timeZone: "America/Indiana/Indianapolis",
        personnel: ["Synthetic owner"],
        observations: [
          {
            title: "Example",
            category: "",
            priority: "",
            location: "",
            description: "Recorded description",
            followUp: "",
            revision: 2,
            photos: [
              {
                photoId: "photo",
                caption: "Correct caption",
                layout: "large",
                sha256: reference.sha256,
                annotations: { coordinateSpace: "upright-normalized-v1", shapes: [] },
              },
            ],
          },
        ],
      },
    ],
  };
  const prepared = {
    status: "prepared",
    attemptId: "attempt",
    artifactObjectId: "approved-pdf",
    approvedAt: projection.approvedAt,
    sourceHash: "c".repeat(64),
    projection,
    photoReferences: [{ photoId: "photo", reference }],
  };
  const artifact = {
    reportId: "report",
    version: 3,
    reference: {
      organizationId: "org",
      objectId: "approved-pdf",
      sha256: digest(pdfBytes),
      byteLength: pdfBytes.length,
    },
  };
  const repository = {
    prepareApproval: vi.fn().mockResolvedValue(prepared),
    completeApproval: vi.fn().mockResolvedValue(artifact),
  };
  const storage = {
    getVerified: vi.fn().mockResolvedValue(bytes),
    putImmutable: vi.fn().mockResolvedValue({ ...artifact.reference, created: true }),
  };
  return {
    prepared,
    projection,
    artifact,
    repository,
    storage,
    run: () => approveCplReport(repository as unknown as SqlCplReportRepository, scope, storage),
  };
}
describe("report artifact approval orchestration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    pdf.render.mockResolvedValue(pdfBytes);
  });
  it("stores the exact rendered PDF before the final authorized approval write", async () => {
    const f = fixture();
    expect(await f.run()).toEqual(f.artifact);
    expect(pdf.render).toHaveBeenCalledWith(
      expect.objectContaining({ version: 3, approvedAt: f.projection.approvedAt }),
    );
    expect(f.storage.putImmutable).toHaveBeenCalledWith({
      organizationId: "org",
      objectId: "approved-pdf",
      sha256: digest(pdfBytes),
      bytes: pdfBytes,
    });
    expect(f.repository.completeApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionToken: scope.sessionToken,
        organizationId: "org",
        projectId: "project",
        reportId: "report",
        attemptId: "attempt",
        sha256: digest(pdfBytes),
        byteLength: pdfBytes.length,
        rendererVersion: "test-renderer-v1",
      }),
    );
    expect(f.repository.completeApproval.mock.invocationCallOrder[0]).toBeGreaterThan(
      f.storage.putImmutable.mock.invocationCallOrder[0]!,
    );
  });
  it("does not touch files before approval preparation authorizes the reviewer and reviewed revision", async () => {
    const f = fixture();
    f.repository.prepareApproval.mockRejectedValue({ code: "CPL_ACCESS_DENIED" });
    await expect(f.run()).rejects.toEqual({ code: "CPL_ACCESS_DENIED" });
    expect(f.storage.getVerified).not.toHaveBeenCalled();
    expect(pdf.render).not.toHaveBeenCalled();
    expect(f.repository.completeApproval).not.toHaveBeenCalled();
  });
  it("leaves a failed render in review without storing or approving an artifact", async () => {
    const f = fixture();
    pdf.render.mockRejectedValue({ code: "CPL_REPORT_PDF_UNSUPPORTED_CHARACTER" });
    await expect(f.run()).rejects.toEqual({ code: "CPL_REPORT_PDF_UNSUPPORTED_CHARACTER" });
    expect(f.storage.putImmutable).not.toHaveBeenCalled();
    expect(f.repository.completeApproval).not.toHaveBeenCalled();
  });
  it("does not approve after a storage interruption and safely retries the same prepared artifact", async () => {
    const f = fixture();
    f.storage.putImmutable.mockRejectedValueOnce({ code: "CPL_EVIDENCE_STORAGE_UNAVAILABLE" });
    await expect(f.run()).rejects.toEqual({ code: "CPL_EVIDENCE_STORAGE_UNAVAILABLE" });
    expect(f.repository.completeApproval).not.toHaveBeenCalled();
    await f.run();
    expect(f.storage.putImmutable.mock.calls[0]).toEqual(f.storage.putImmutable.mock.calls[1]);
    expect(f.repository.completeApproval).toHaveBeenCalledTimes(1);
  });
  it.each(["CPL_REPORT_SOURCES_STALE", "CPL_REPORT_VERSION_CONFLICT", "CPL_ACCESS_DENIED"])(
    "propagates final %s after rendering without claiming approval",
    async (code) => {
      const f = fixture();
      f.repository.completeApproval.mockRejectedValue({ code });
      await expect(f.run()).rejects.toEqual({ code });
      expect(f.storage.putImmutable).toHaveBeenCalledTimes(1);
    },
  );
  it("uses the stored artifact after a lost success response without rendering a replacement", async () => {
    const f = fixture();
    f.repository.prepareApproval.mockResolvedValue({
      status: "completed",
      artifact: f.artifact,
      version: { version: 3 },
    });
    f.storage.getVerified.mockResolvedValue(pdfBytes);
    expect(await f.run()).toEqual(f.artifact);
    expect(f.storage.getVerified).toHaveBeenCalledWith(f.artifact.reference);
    expect(pdf.render).not.toHaveBeenCalled();
    expect(f.storage.putImmutable).not.toHaveBeenCalled();
    expect(f.repository.completeApproval).not.toHaveBeenCalled();
  });
  it("refuses a mismatched frozen image hash before PDF generation", async () => {
    const f = fixture();
    f.projection.visits[0]!.observations[0]!.photos[0]!.sha256 = "d".repeat(64);
    await expect(f.run()).rejects.toThrow("CPL_REPORT_SOURCE_REFERENCE_INVALID");
    expect(pdf.render).not.toHaveBeenCalled();
    expect(f.repository.completeApproval).not.toHaveBeenCalled();
  });
});
