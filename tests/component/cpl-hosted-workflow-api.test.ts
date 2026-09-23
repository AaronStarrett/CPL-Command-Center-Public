// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const stubs = vi.hoisted(() => ({
  session: vi.fn(),
  mutation: vi.fn(),
  authorize: vi.fn(),
  listLeads: vi.fn(),
  listProposals: vi.fn(),
  listJobs: vi.fn(),
  workspace: vi.fn(),
  createLead: vi.fn(),
  updateLead: vi.fn(),
  evidence: vi.fn(),
  directory: vi.fn(),
  createDirectory: vi.fn(),
  getLead: vi.fn(),
  getProposal: vi.fn(),
  createProposal: vi.fn(),
  updateProposal: vi.fn(),
  download: vi.fn(),
  organizations: vi.fn(),
  createOrganization: vi.fn(),
  select: vi.fn(),
}));
vi.mock("@/lib/hosted-auth", () => ({
  withHostedRuntime: async (operation: (runtime: unknown) => Promise<unknown>) =>
    operation({
      database: {},
      tenants: {
        listOrganizations: stubs.organizations,
        createEnabledOrganization: stubs.createOrganization,
        authorize: stubs.authorize,
      },
      auth: { selectOrganization: stubs.select },
    }),
  requireHostedSession: stubs.session,
  requireHostedMutation: stubs.mutation,
}));
vi.mock("@bea/database/hosted", () => ({
  SqlCplWorkflowRepository: class {
    listLeads = stubs.listLeads;
    listProposalDrafts = stubs.listProposals;
    listJobs = stubs.listJobs;
    readWorkspace = stubs.workspace;
    createLead = stubs.createLead;
    updateLead = stubs.updateLead;
    appendLeadEvidence = stubs.evidence;
    getIntakeDirectory = stubs.directory;
    createDirectoryEntry = stubs.createDirectory;
    getLead = stubs.getLead;
    getProposalDraft = stubs.getProposal;
    createProposalDraft = stubs.createProposal;
    updateProposalDraft = stubs.updateProposal;
    downloadProposal = stubs.download;
  },
}));
import { GET, POST, PATCH } from "../../apps/web/app/api/cpl/[...path]/route";
const selected = { sessionToken: "server-session", organizationId: "server-selected-organization" };
function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://cpl.example.invalid/api/cpl/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CPL-Organization": selected.organizationId,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const context = (...path: string[]) => ({ params: Promise.resolve({ path }) });
describe("hosted workflow HTTP boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    stubs.session.mockResolvedValue({
      sessionToken: "server-session",
      session: { selectedOrganizationId: "server-selected-organization" },
    });
    stubs.mutation.mockResolvedValue({
      sessionToken: "server-session",
      session: { selectedOrganizationId: selected.organizationId },
    });
    stubs.authorize.mockResolvedValue({});
    stubs.listLeads.mockResolvedValue([]);
    stubs.listProposals.mockResolvedValue([]);
    stubs.listJobs.mockResolvedValue([]);
    stubs.workspace.mockResolvedValue({ leads: [], proposals: [], jobs: [] });
    stubs.organizations.mockResolvedValue([]);
    stubs.createLead.mockResolvedValue({ id: "lead-one" });
    stubs.updateLead.mockResolvedValue({ id: "lead-one", version: 2 });
    stubs.evidence.mockResolvedValue({ id: "lead-one", version: 3 });
    stubs.directory.mockResolvedValue({ customers: [], contacts: [], sites: [], members: [] });
    stubs.createDirectory.mockResolvedValue({ id: "customer-one", name: "Fictional company" });
  });
  it("captures incomplete structured intake without inventing contact data", async () => {
    const response = await POST(
      request("leads", {
        title: "Phone inquiry",
        sourceType: "phone",
        sourceReference: "Caller note",
        idempotencyKey: "capture-1",
      }),
      context("leads"),
    );
    expect(response.status).toBe(201);
    expect(stubs.createLead).toHaveBeenCalledWith({
      ...selected,
      title: "Phone inquiry",
      sourceType: "phone",
      sourceReference: "Caller note",
      idempotencyKey: "capture-1",
    });
  });
  it("binds optimistic corrections to the displayed server-selected tenant", async () => {
    const response = await PATCH(
      request("leads/id", { expectedVersion: 1, nextAction: "Call customer" }),
      context("leads", "id"),
    );
    expect(response.status).toBe(200);
    expect(stubs.updateLead).toHaveBeenCalledWith({
      ...selected,
      leadId: "id",
      expectedVersion: 1,
      nextAction: "Call customer",
    });
    const rejected = await PATCH(
      request("leads/id", { expectedVersion: 1, organizationId: "forged" }),
      context("leads", "id"),
    );
    expect(rejected.status).toBe(400);
    expect(stubs.updateLead).toHaveBeenCalledTimes(1);
  });
  it("rejects correction without version, with stale organization, or without CSRF", async () => {
    expect(
      (await PATCH(request("leads/id", { nextAction: "Call" }), context("leads", "id"))).status,
    ).toBe(400);
    expect(
      (
        await PATCH(
          request("leads/id", { expectedVersion: 1 }, { "X-CPL-Organization": "stale" }),
          context("leads", "id"),
        )
      ).status,
    ).toBe(409);
    stubs.mutation.mockRejectedValue({ code: "CPL_CSRF_REJECTED" });
    expect(
      (
        await PATCH(
          request("leads/id", { expectedVersion: 1, status: "ready_for_proposal" }),
          context("leads", "id"),
        )
      ).status,
    ).toBe(403);
    expect(stubs.updateLead).not.toHaveBeenCalled();
  });
  it("exposes controlled lead conflict codes without exception messages", async () => {
    stubs.updateLead.mockRejectedValue({
      code: "CPL_LEAD_VERSION_CONFLICT",
      message: "private SQL",
    });
    const response = await PATCH(
      request("leads/id", { expectedVersion: 1, notes: "Correction" }),
      context("leads", "id"),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "CPL_LEAD_VERSION_CONFLICT" });
  });
  it("appends evidence through a bounded explicit endpoint with server authority", async () => {
    const response = await POST(
      request("leads/id/evidence", {
        expectedVersion: 2,
        idempotencyKey: "evidence-1",
        label: "Original email",
        reference: "message:fictional",
        note: "Untrusted source text",
      }),
      context("leads", "id", "evidence"),
    );
    expect(response.status).toBe(201);
    expect(stubs.evidence).toHaveBeenCalledWith({
      ...selected,
      leadId: "id",
      expectedVersion: 2,
      idempotencyKey: "evidence-1",
      label: "Original email",
      reference: "message:fictional",
      note: "Untrusted source text",
    });
  });
  it("reads only the selected tenant directory and refuses role/provenance spoofing", async () => {
    expect((await GET(request("directory"), context("directory"))).status).toBe(200);
    expect(stubs.directory).toHaveBeenCalledWith(selected);
    const result = await POST(
      request("directory", {
        kind: "customer",
        name: "Fictional company",
        actorIdentityId: "forged",
        idempotencyKey: "directory-1",
      }),
      context("directory"),
    );
    expect(result.status).toBe(400);
    expect(stubs.createDirectory).not.toHaveBeenCalled();
  });
  it("rejects a body-supplied tenant instead of selecting it", async () => {
    const result = await POST(
      request("leads", {
        organizationId: "victim",
        title: "Fictional lead",
        contactName: "Example",
        idempotencyKey: "retry",
      }),
      context("leads"),
    );
    expect(result.status).toBe(400);
    expect(stubs.createLead).not.toHaveBeenCalled();
  });
  it("uses only the server-selected organization for a valid write", async () => {
    const result = await POST(
      request("leads", {
        title: "Fictional lead",
        contactName: "Example",
        details: "Manual request",
        idempotencyKey: "retry",
      }),
      context("leads"),
    );
    expect(result.status).toBe(201);
    expect(stubs.createLead).toHaveBeenCalledWith({
      ...selected,
      title: "Fictional lead",
      contactName: "Example",
      details: "Manual request",
      idempotencyKey: "retry",
    });
  });
  it("stops before repository writes when CSRF verification fails", async () => {
    stubs.mutation.mockRejectedValue({ code: "CPL_CSRF_REJECTED" });
    const result = await POST(request("leads", { title: "Fictional" }), context("leads"));
    expect(result.status).toBe(403);
    expect(stubs.authorize).not.toHaveBeenCalled();
    expect(stubs.createLead).not.toHaveBeenCalled();
  });
  it("rejects unauthenticated reads without consulting records", async () => {
    stubs.session.mockRejectedValue({ code: "CPL_AUTHENTICATION_REQUIRED" });
    const result = await GET(request("leads/other-tenant-id"), context("leads", "other-tenant-id"));
    expect(result.status).toBe(401);
    expect(stubs.getLead).not.toHaveBeenCalled();
    expect(result.headers.get("cache-control")).toContain("no-store");
  });
  it("propagates inaccessible record IDs as private 404 responses", async () => {
    stubs.getLead.mockRejectedValue({ code: "CPL_RECORD_NOT_FOUND" });
    const result = await GET(request("leads/cross-tenant"), context("leads", "cross-tenant"));
    expect(stubs.getLead).toHaveBeenCalledWith({ ...selected, leadId: "cross-tenant" });
    expect(result.status).toBe(404);
    expect(await result.json()).toEqual({ code: "CPL_RECORD_NOT_FOUND" });
  });
  it("does not expose database or credential details on failure", async () => {
    stubs.getLead.mockRejectedValue(new Error("private database location and credentials"));
    const result = await GET(request("leads/id"), context("leads", "id"));
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain("credentials");
  });
  it("caps incoming bodies before attempting a write", async () => {
    const result = await POST(request("leads", { title: "a".repeat(70000) }), context("leads"));
    expect(result.status).toBe(400);
    expect(stubs.createLead).not.toHaveBeenCalled();
  });
  it("serves only authorized prepared content as a private immediate attachment", async () => {
    stubs.download.mockResolvedValue({
      content: "# Fictional proposal",
      contentType: "text/markdown; charset=utf-8",
      fileName: "draft.md",
      sha256: "digest",
    });
    const result = await GET(
      request("proposals/id/download"),
      context("proposals", "id", "download"),
    );
    expect(result.status).toBe(200);
    expect(result.headers.get("content-disposition")).toBe('attachment; filename="draft.md"');
    expect(result.headers.get("cache-control")).toContain("no-store");
    expect(stubs.download).toHaveBeenCalledWith({ ...selected, proposalId: "id" });
  });
  it("rejects stale or absent version preconditions", async () => {
    const result = await POST(
      request("proposals/id", { title: "Manual", content: "Content" }),
      context("proposals", "id"),
    );
    expect(result.status).toBe(400);
    expect(stubs.updateProposal).not.toHaveBeenCalled();
  });
  it.each(["", "other-tab-organization"])(
    "refuses a missing or stale displayed organization (%s) before a record write",
    async (expected) => {
      const result = await POST(
        request(
          "leads",
          { title: "Fictional", contactName: "Example", idempotencyKey: "retry" },
          { "X-CPL-Organization": expected },
        ),
        context("leads"),
      );
      expect(result.status).toBe(409);
      expect(await result.json()).toEqual({ code: "CPL_ORGANIZATION_CONTEXT_CHANGED" });
      expect(stubs.createLead).not.toHaveBeenCalled();
      expect(stubs.authorize).not.toHaveBeenCalled();
    },
  );
  it("keeps one server organization snapshot throughout a workspace aggregate", async () => {
    stubs.session.mockResolvedValueOnce({
      sessionToken: selected.sessionToken,
      session: { selectedOrganizationId: selected.organizationId },
    });
    stubs.session.mockResolvedValue({
      sessionToken: selected.sessionToken,
      session: { selectedOrganizationId: "concurrently-selected-other-org" },
    });
    stubs.workspace.mockResolvedValue({
      leads: [{ id: "lead-a", organizationId: selected.organizationId }],
      proposals: [],
      jobs: [],
    });
    const result = await GET(
      request("workspace", undefined, { "X-CPL-Organization": "" }),
      context("workspace"),
    );
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      currentOrganizationId: selected.organizationId,
      leads: [{ organizationId: selected.organizationId }],
    });
    expect(stubs.session).toHaveBeenCalledTimes(1);
    expect(stubs.workspace).toHaveBeenCalledWith(selected);
    expect(stubs.authorize).not.toHaveBeenCalled();
    for (const list of [stubs.listLeads, stubs.listProposals, stubs.listJobs])
      expect(list).not.toHaveBeenCalled();
  });
  it("returns the same empty aggregate without reading records when no organization is selected", async () => {
    stubs.session.mockResolvedValue({
      sessionToken: selected.sessionToken,
      session: { selectedOrganizationId: null },
    });
    stubs.organizations.mockResolvedValue([{ id: selected.organizationId }]);
    const result = await GET(request("workspace"), context("workspace"));
    expect(await result.json()).toEqual({
      organizations: [{ id: selected.organizationId }],
      currentOrganizationId: null,
      leads: [],
      proposals: [],
      jobs: [],
    });
    expect(stubs.workspace).not.toHaveBeenCalled();
  });
  it.each(["CPL_ACCESS_DENIED", "CPL_MODULE_DISABLED", "CPL_WORKSPACE_UNAVAILABLE"])(
    "returns no partial records when the composite rejects %s",
    async (code) => {
      stubs.workspace.mockRejectedValue({ code });
      const result = await GET(request("workspace"), context("workspace"));
      expect(result.status).toBe(code === "CPL_WORKSPACE_UNAVAILABLE" ? 503 : 403);
      expect(await result.json()).toEqual({ code });
      expect(result.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    },
  );
  it("checks download query context against the server selection without selecting it", async () => {
    stubs.download.mockResolvedValue({
      content: "# Draft",
      contentType: "text/markdown",
      fileName: "draft.md",
      sha256: "digest",
    });
    const valid = request(`proposals/id/download?organization=${selected.organizationId}`);
    valid.headers.delete("X-CPL-Organization");
    expect((await GET(valid, context("proposals", "id", "download"))).status).toBe(200);
    expect(stubs.download).toHaveBeenCalledWith({ ...selected, proposalId: "id" });
    stubs.download.mockClear();
    const invalid = request("proposals/id/download?organization=other-tab-organization");
    invalid.headers.delete("X-CPL-Organization");
    const result = await GET(invalid, context("proposals", "id", "download"));
    expect(result.status).toBe(409);
    expect(stubs.download).not.toHaveBeenCalled();
    expect(stubs.select).not.toHaveBeenCalled();
  });
  it("rejects duplicate download contexts and stale record reads", async () => {
    const download = request(
      `proposals/id/download?organization=${selected.organizationId}&organization=${selected.organizationId}`,
    );
    expect((await GET(download, context("proposals", "id", "download"))).status).toBe(409);
    expect(
      (
        await GET(
          request("leads/id", undefined, { "X-CPL-Organization": "other-org" }),
          context("leads", "id"),
        )
      ).status,
    ).toBe(409);
    expect(stubs.download).not.toHaveBeenCalled();
    expect(stubs.getLead).not.toHaveBeenCalled();
  });
});
