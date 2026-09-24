import { beforeEach, describe, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  mutation: vi.fn(),
  readWorkspace: vi.fn(),
  readConfiguration: vi.fn(),
  getIntakePolicy: vi.fn(),
  listTemplates: vi.fn(),
  listPolicies: vi.fn(),
  listCatalog: vi.fn(),
  getCatalog: vi.fn(),
  saveCatalog: vi.fn(),
  setCatalogStatus: vi.fn(),
  listDirectory: vi.fn(),
  getDirectory: vi.fn(),
  saveDirectory: vi.fn(),
  setDirectoryStatus: vi.fn(),
  listAudit: vi.fn(),
  saveProfile: vi.fn(),
  saveIntakePolicy: vi.fn(),
  saveCompanyPolicy: vi.fn(),
}));
vi.mock("@bea/database/hosted", () => ({
  SqlCplCompanyRepository: class {
    readWorkspace = mocks.readWorkspace;
    readConfiguration = mocks.readConfiguration;
    getIntakePolicy = mocks.getIntakePolicy;
    listTemplates = mocks.listTemplates;
    listPolicies = mocks.listPolicies;
    listCatalog = mocks.listCatalog;
    getCatalog = mocks.getCatalog;
    saveCatalog = mocks.saveCatalog;
    setCatalogStatus = mocks.setCatalogStatus;
    listDirectory = mocks.listDirectory;
    getDirectory = mocks.getDirectory;
    saveDirectory = mocks.saveDirectory;
    setDirectoryStatus = mocks.setDirectoryStatus;
    listAudit = mocks.listAudit;
    saveProfile = mocks.saveProfile;
    saveIntakePolicy = mocks.saveIntakePolicy;
  },
  SqlCplDeliveryRepository: class {
    saveCompanyPolicy = mocks.saveCompanyPolicy;
  },
}));
vi.mock("../../apps/web/lib/hosted-auth", () => ({
  withHostedRuntime: async (fn: (runtime: unknown) => Promise<unknown>) => fn({ tenants: {} }),
  requireHostedSession: mocks.session,
  requireHostedMutation: mocks.mutation,
}));
import { GET, POST } from "../../apps/web/app/api/cpl-company/[...path]/route";
const org = "10000000-0000-4000-8000-000000000001",
  id = "20000000-0000-4000-8000-000000000001";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({
    sessionToken: "server-token",
    session: { selectedOrganizationId: org },
  });
  mocks.mutation.mockImplementation(() => mocks.session());
  for (const [name, fn] of Object.entries(mocks))
    if (!["session", "mutation"].includes(name)) fn.mockResolvedValue({ ok: true });
});
const context = (path: string) => ({
  params: Promise.resolve({ path: path.split("?")[0]!.split("/") }),
});
const req = (path: string, input?: unknown, headers: Record<string, string> = {}) =>
  new Request("http://127.0.0.1:3400/api/cpl-company/" + path, {
    method: input === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-cpl-organization": org, ...headers },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
describe("company configuration HTTP boundaries", () => {
  it("requires selected server tenant before all company reads", async () => {
    const response = await GET(
      req("workspace", undefined, { "x-cpl-organization": "other" }),
      context("workspace"),
    );
    expect(response.status).toBe(409);
    expect(mocks.readWorkspace).not.toHaveBeenCalled();
  });
  it("maps the safe intake policy read independently of privileged profile", async () => {
    const response = await GET(req("intake-policy"), context("intake-policy"));
    expect(response.status).toBe(200);
    expect(mocks.getIntakePolicy).toHaveBeenCalledWith({
      sessionToken: "server-token",
      organizationId: org,
    });
    expect(mocks.readWorkspace).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("forwards bounded catalog pagination with strict filters", async () => {
    await GET(
      req("catalog?q=inspection&status=archived&limit=25&cursor=opaque"),
      context("catalog"),
    );
    expect(mocks.listCatalog).toHaveBeenCalledWith({
      sessionToken: "server-token",
      organizationId: org,
      q: "inspection",
      status: "archived",
      limit: 25,
      cursor: "opaque",
    });
    for (const suffix of [
      "limit=101",
      "limit=25&limit=50",
      "status=deleted",
      "organizationId=other",
    ])
      expect((await GET(req("catalog?" + suffix), context("catalog"))).status).toBe(400);
  });
  it("validates template and directory kinds before repository calls", async () => {
    expect((await GET(req("templates/private"), context("templates/private"))).status).toBe(400);
    expect((await GET(req("directory/secrets"), context("directory/secrets"))).status).toBe(400);
    expect(mocks.listTemplates).not.toHaveBeenCalled();
    expect(mocks.listDirectory).not.toHaveBeenCalled();
  });
  it("rejects CSRF before profile mutation", async () => {
    mocks.mutation.mockRejectedValue({ code: "CPL_CSRF_REJECTED" });
    expect((await POST(req("profile", {}), context("profile"))).status).toBe(403);
    expect(mocks.saveProfile).not.toHaveBeenCalled();
  });
  it("does not allow actor or organization claims in a record mutation", async () => {
    expect(
      (
        await POST(
          req("catalog", {
            expectedRevision: 0,
            idempotencyKey: "test-123",
            input: {},
            organizationId: org,
          }),
          context("catalog"),
        )
      ).status,
    ).toBe(400);
    expect(mocks.saveCatalog).not.toHaveBeenCalled();
  });
  it("saves catalog with exact server scope and expected revision", async () => {
    await POST(
      req("catalog/" + id, {
        expectedRevision: 3,
        idempotencyKey: "test-123",
        input: { name: "Updated" },
      }),
      context("catalog/" + id),
    );
    expect(mocks.saveCatalog).toHaveBeenCalledWith({
      sessionToken: "server-token",
      organizationId: org,
      itemId: id,
      expectedRevision: 3,
      idempotencyKey: "test-123",
      input: { name: "Updated" },
    });
  });
  it("archives with explicit reason and path identity, retaining service validation", async () => {
    await POST(
      req(`directory/site/${id}/archive`, {
        expectedRevision: 2,
        idempotencyKey: "archive-123",
        reason: "Duplicate retired",
      }),
      context(`directory/site/${id}/archive`),
    );
    expect(mocks.setDirectoryStatus).toHaveBeenCalledWith({
      sessionToken: "server-token",
      organizationId: org,
      kind: "site",
      entryId: id,
      expectedRevision: 2,
      idempotencyKey: "archive-123",
      reason: "Duplicate retired",
      status: "archived",
    });
  });
  it("uses the real organization-level closeout method without dummy project", async () => {
    await POST(
      req("policies", {
        expectedVersion: 0,
        idempotencyKey: "policy-123",
        input: { serviceKey: "*" },
      }),
      context("policies"),
    );
    expect(mocks.saveCompanyPolicy).toHaveBeenCalledWith({
      sessionToken: "server-token",
      organizationId: org,
      expectedVersion: 0,
      idempotencyKey: "policy-123",
      input: { serviceKey: "*" },
    });
  });
  it("keeps audit filters bounded and prevents raw tenant query overrides", async () => {
    await GET(req("audit?action=company.profile&limit=25"), context("audit"));
    expect(mocks.listAudit).toHaveBeenCalledWith({
      sessionToken: "server-token",
      organizationId: org,
      action: "company.profile",
      limit: 25,
    });
    expect((await GET(req("audit?organization=other"), context("audit"))).status).toBe(409);
  });
  it("keeps schema and SQL failures private", async () => {
    mocks.getDirectory.mockRejectedValue({ code: "42501", message: "private database name" });
    const response = await GET(
      req(`directory/customer/${id}`),
      context(`directory/customer/${id}`),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "CPL_WORKSPACE_UNAVAILABLE" });
  });
});
