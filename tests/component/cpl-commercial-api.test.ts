// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const stubs = vi.hoisted(() => ({
  session: vi.fn(),
  mutation: vi.fn(),
  authorize: vi.fn(),
  render: vi.fn(),
  readWorkspace: vi.fn(),
  getProject: vi.fn(),
  getProposal: vi.fn(),
  previewProject: vi.fn(),
  getCustomerPreview: vi.fn(),
  getPdfArtifact: vi.fn(),
  createProposal: vi.fn(),
  createTemplate: vi.fn(),
  saveBranding: vi.fn(),
  getApprovedPdf: vi.fn(),
  recordArtifact: vi.fn(),
  saveProposal: vi.fn(),
  submitProposal: vi.fn(),
  reviewProposal: vi.fn(),
  reviseProposal: vi.fn(),
  recordOutcome: vi.fn(),
  createProject: vi.fn(),
}));
vi.mock("@/lib/hosted-auth", () => ({
  withHostedRuntime: async (operation: (runtime: unknown) => Promise<unknown>) =>
    operation({ database: {}, tenants: { authorize: stubs.authorize } }),
  requireHostedSession: stubs.session,
  requireHostedMutation: stubs.mutation,
}));
vi.mock("@bea/artifacts/proposal-pdf", () => ({
  renderCplProposalPdf: stubs.render,
  CPL_PROPOSAL_PDF_RENDERER_VERSION: "cpl-proposal-pdf-v1",
}));
vi.mock("@bea/database/hosted", () => ({
  SqlCplCommercialRepository: class {
    readWorkspace = stubs.readWorkspace;
    getProject = stubs.getProject;
    getProposal = stubs.getProposal;
    previewProject = stubs.previewProject;
    getCustomerPreview = stubs.getCustomerPreview;
    getPdfArtifact = stubs.getPdfArtifact;
    createProposal = stubs.createProposal;
    createTemplate = stubs.createTemplate;
    saveBranding = stubs.saveBranding;
    getApprovedPdf = stubs.getApprovedPdf;
    recordArtifact = stubs.recordArtifact;
    saveProposal = stubs.saveProposal;
    submitProposal = stubs.submitProposal;
    reviewProposal = stubs.reviewProposal;
    reviseProposal = stubs.reviseProposal;
    recordOutcome = stubs.recordOutcome;
    createProject = stubs.createProject;
  },
}));
import { GET, POST } from "../../apps/web/app/api/cpl-commercial/[...path]/route";
const selected = {
  sessionToken: "server-only-synthetic-session",
  organizationId: "server-company",
};
const proposalId = "123e4567-e89b-12d3-a456-426614174000";
function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://127.0.0.1:3400/api/cpl-commercial/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      "x-cpl-organization": selected.organizationId,
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const context = (...path: string[]) => ({ params: Promise.resolve({ path }) });
describe("commercial product HTTP security and artifact boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    const session = {
      sessionToken: selected.sessionToken,
      session: { selectedOrganizationId: selected.organizationId },
    };
    stubs.session.mockResolvedValue(session);
    stubs.mutation.mockResolvedValue(session);
    stubs.readWorkspace.mockResolvedValue({ proposals: [], templates: [], projects: [] });
    stubs.getApprovedPdf.mockResolvedValue({
      reference: "PROP-TEST-1",
      version: 2,
      content: { title: "Public scope" },
    });
    stubs.render.mockResolvedValue(new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]));
    stubs.recordArtifact.mockResolvedValue({ id: "artifact", version: 2 });
    stubs.getProposal.mockResolvedValue({ id: proposalId });
  });
  it("requires the displayed context on workspace reads and never trusts a forged tenant", async () => {
    expect((await GET(request("workspace"), context("workspace"))).status).toBe(200);
    expect(stubs.readWorkspace).toHaveBeenCalledWith(selected);
    expect(
      (
        await GET(
          request("workspace", undefined, { "x-cpl-organization": "attacker" }),
          context("workspace"),
        )
      ).status,
    ).toBe(409);
    expect(stubs.readWorkspace).toHaveBeenCalledTimes(1);
  });
  it("rejects unauthenticated reads without exposing failure detail", async () => {
    stubs.session.mockRejectedValue({
      code: "CPL_AUTHENTICATION_REQUIRED",
      message: "sensitive diagnostic",
    });
    const response = await GET(request("workspace"), context("workspace"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "CPL_AUTHENTICATION_REQUIRED" });
    expect(stubs.readWorkspace).not.toHaveBeenCalled();
  });
  it("rejects CSRF before any commercial action", async () => {
    stubs.mutation.mockRejectedValue({ code: "CPL_CSRF_REJECTED" });
    const response = await POST(
      request(`proposals/${proposalId}/project`, { idempotencyKey: "stable-key-1" }),
      context("proposals", proposalId, "project"),
    );
    expect(response.status).toBe(403);
    expect(stubs.createProject).not.toHaveBeenCalled();
  });
  it("refuses caller-supplied organization, session and artifact bytes", async () => {
    for (const forged of [
      { organizationId: "forged" },
      { sessionToken: "forged" },
      { bytes: "forged-pdf" },
      { sha256: "forged-hash" },
    ]) {
      expect(
        (
          await POST(
            request(`proposals/${proposalId}/pdf`, { version: 2, ...forged }),
            context("proposals", proposalId, "pdf"),
          )
        ).status,
      ).toBe(400);
    }
    expect(stubs.render).not.toHaveBeenCalled();
    expect(stubs.recordArtifact).not.toHaveBeenCalled();
  });
  it("never renders a final artifact when approval is missing", async () => {
    stubs.getApprovedPdf.mockRejectedValue({ code: "CPL_PROPOSAL_NOT_APPROVED" });
    const response = await POST(
      request(`proposals/${proposalId}/pdf`, { version: 2 }),
      context("proposals", proposalId, "pdf"),
    );
    expect(response.status).toBe(409);
    expect(stubs.render).not.toHaveBeenCalled();
    expect(stubs.recordArtifact).not.toHaveBeenCalled();
  });
  it("records only renderer-produced bytes against the approved version and projection hash", async () => {
    const response = await POST(
      request(`proposals/${proposalId}/pdf`, { version: 2 }),
      context("proposals", proposalId, "pdf"),
    );
    expect(response.status).toBe(201);
    expect(stubs.getApprovedPdf).toHaveBeenCalledWith({ ...selected, proposalId, version: 2 });
    expect(stubs.recordArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        ...selected,
        proposalId,
        version: 2,
        bytes: new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]),
        rendererVersion: "cpl-proposal-pdf-v1",
        projectionSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    );
    expect(stubs.authorize).toHaveBeenCalledWith({
      ...selected,
      permission: "commercial:write",
      module: "proposal-builder",
    });
  });
  it("does not claim generation if approval or access is revoked before storage", async () => {
    stubs.recordArtifact.mockRejectedValue({ code: "CPL_ACCESS_DENIED" });
    expect(
      (
        await POST(
          request(`proposals/${proposalId}/pdf`, { version: 2 }),
          context("proposals", proposalId, "pdf"),
        )
      ).status,
    ).toBe(403);
  });
  it("downloads stored bytes without rerendering or interpreting a GET as generation", async () => {
    const bytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);
    stubs.getPdfArtifact.mockResolvedValue({ bytes, metadata: { sha256: "f".repeat(64) } });
    const response = await GET(
      request(`proposals/${proposalId}/pdf?version=2&organization=server-company`, undefined, {
        "x-cpl-organization": "",
      }),
      context("proposals", proposalId, "pdf"),
    );
    expect(response.status).toBe(409);
    const queryOnly = new Request(
      `http://127.0.0.1:3400/api/cpl-commercial/proposals/${proposalId}/pdf?version=2&organization=server-company`,
    );
    const valid = await GET(queryOnly, context("proposals", proposalId, "pdf"));
    expect(valid.status).toBe(200);
    expect(new Uint8Array(await valid.arrayBuffer())).toEqual(bytes);
    expect(valid.headers.get("Content-Type")).toBe("application/pdf");
    expect(valid.headers.get("Cache-Control")).toContain("no-store");
    expect(valid.headers.get("X-Artifact-SHA256")).toBe("f".repeat(64));
    expect(valid.headers.get("Content-Disposition")).toContain("-v2.pdf");
    expect(stubs.render).not.toHaveBeenCalled();
    expect(stubs.recordArtifact).not.toHaveBeenCalled();
  });
  it("refuses download without explicit version or with ambiguous organization", async () => {
    for (const suffix of [
      "",
      "?version=0",
      "?version=2&version=3",
      "?version=2&organization=server-company&organization=server-company",
    ]) {
      expect(
        (
          await GET(
            request(`proposals/${proposalId}/pdf${suffix}`),
            context("proposals", proposalId, "pdf"),
          )
        ).status,
      ).toBeGreaterThanOrEqual(400);
    }
    expect(stubs.getPdfArtifact).not.toHaveBeenCalled();
  });
  it("allows a reviewer decision without incorrectly requiring general record-write permission", async () => {
    stubs.reviewProposal.mockResolvedValue({ state: "approved" });
    const response = await POST(
      request(`proposals/${proposalId}/review`, {
        expectedRevision: 3,
        decision: "approve",
        note: "Scope reviewed",
      }),
      context("proposals", proposalId, "review"),
    );
    expect(response.status).toBe(200);
    expect(stubs.authorize).not.toHaveBeenCalled();
    expect(stubs.reviewProposal).toHaveBeenCalledWith({
      ...selected,
      proposalId,
      expectedRevision: 3,
      decision: "approve",
      reason: "Scope reviewed",
    });
  });
  it("requires optimistic revisions and restricts action choices", async () => {
    expect(
      (
        await POST(
          request(`proposals/${proposalId}/submit`, {}),
          context("proposals", proposalId, "submit"),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await POST(
          request(`proposals/${proposalId}/review`, {
            expectedRevision: 3,
            decision: "skip_approval",
          }),
          context("proposals", proposalId, "review"),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await POST(
          request(`proposals/${proposalId}/outcome`, { expectedRevision: 3, outcome: "sent" }),
          context("proposals", proposalId, "outcome"),
        )
      ).status,
    ).toBe(400);
  });
  it("preserves omitted private notes while allowing an explicit clear", async () => {
    stubs.saveProposal.mockResolvedValue({ state: "draft" });
    for (const extra of [{}, { internalNotes: "" }])
      expect(
        (
          await POST(
            request(`proposals/${proposalId}/save`, {
              expectedRevision: 2,
              content: { title: "Updated" },
              ...extra,
            }),
            context("proposals", proposalId, "save"),
          )
        ).status,
      ).toBe(200);
    expect(stubs.saveProposal.mock.calls[0]![0]).not.toHaveProperty("internalNotes");
    expect(stubs.saveProposal.mock.calls[1]![0]).toHaveProperty("internalNotes", "");
  });
  it("preserves structured loss reasons separately from notes and refuses unknown codes", async () => {
    stubs.recordOutcome.mockResolvedValue({ state: "lost" });
    const input = {
      expectedRevision: 3,
      outcome: "lost",
      reasonCode: "timing",
      note: "Customer postponed the work",
      idempotencyKey: "outcome-key-001",
    };
    expect(
      (
        await POST(
          request(`proposals/${proposalId}/outcome`, input),
          context("proposals", proposalId, "outcome"),
        )
      ).status,
    ).toBe(200);
    expect(stubs.recordOutcome).toHaveBeenCalledWith({
      ...selected,
      proposalId,
      ...input,
      reason: "",
    });
    expect(
      (
        await POST(
          request(`proposals/${proposalId}/outcome`, { ...input, reasonCode: "unknown" }),
          context("proposals", proposalId, "outcome"),
        )
      ).status,
    ).toBe(400);
    expect(stubs.recordOutcome).toHaveBeenCalledTimes(1);
  });
  it("preserves reason-only compatibility without injecting an empty note", async () => {
    stubs.recordOutcome.mockResolvedValue({ state: "withdrawn" });
    const input = {
      expectedRevision: 3,
      outcome: "withdrawn",
      reason: "Scope no longer needed",
      idempotencyKey: "withdrawn-key-001",
    };
    expect(
      (
        await POST(
          request(`proposals/${proposalId}/outcome`, input),
          context("proposals", proposalId, "outcome"),
        )
      ).status,
    ).toBe(200);
    expect(stubs.recordOutcome).toHaveBeenCalledWith({ ...selected, proposalId, ...input });
    expect(stubs.recordOutcome.mock.calls[0]![0]).not.toHaveProperty("note");
  });
  it("preserves the project idempotency key and binds the request to its server tenant", async () => {
    stubs.createProject.mockResolvedValue({ id: "one-project" });
    for (let i = 0; i < 2; i++)
      expect(
        (
          await POST(
            request(`proposals/${proposalId}/project`, {
              idempotencyKey: "deliberate-award-project",
            }),
            context("proposals", proposalId, "project"),
          )
        ).status,
      ).toBe(201);
    expect(stubs.createProject).toHaveBeenNthCalledWith(1, {
      ...selected,
      proposalId,
      idempotencyKey: "deliberate-award-project",
    });
    expect(stubs.createProject).toHaveBeenNthCalledWith(2, {
      ...selected,
      proposalId,
      idempotencyKey: "deliberate-award-project",
    });
  });
  it("accepts initial branding revision zero without accepting negative or forged revisions", async () => {
    stubs.saveBranding.mockResolvedValue({ revision: 1 });
    expect(
      (
        await POST(
          request("branding", {
            input: { businessName: "Synthetic company" },
            expectedRevision: 0,
          }),
          context("branding"),
        )
      ).status,
    ).toBe(200);
    expect(
      (await POST(request("branding", { input: {}, expectedRevision: -1 }), context("branding")))
        .status,
    ).toBe(400);
    expect(stubs.saveBranding).toHaveBeenCalledTimes(1);
  });
  it("sanitizes unexpected backend failures and returns useful PDF validation codes", async () => {
    stubs.getProposal.mockRejectedValue(new Error("postgresql: hidden connection"));
    const response = await GET(
      request(`proposals/${proposalId}`),
      context("proposals", proposalId),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "CPL_WORKSPACE_UNAVAILABLE" });
    stubs.render.mockRejectedValue({ code: "CPL_PROPOSAL_PDF_UNSUPPORTED_CHARACTER" });
    const pdf = await POST(
      request(`proposals/${proposalId}/pdf`, { version: 2 }),
      context("proposals", proposalId, "pdf"),
    );
    expect(pdf.status).toBe(400);
    expect(await pdf.json()).toEqual({ code: "CPL_PROPOSAL_PDF_UNSUPPORTED_CHARACTER" });
  });
});
