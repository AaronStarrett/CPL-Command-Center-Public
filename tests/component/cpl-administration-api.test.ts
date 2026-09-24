import { beforeEach, describe, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  mutation: vi.fn(),
  bootstrap: vi.fn(),
  provisionOrganization: vi.fn(),
  listMembers: vi.fn(),
  listInvitations: vi.fn(),
  changeMember: vi.fn(),
  createInvitation: vi.fn(),
  reissueInvitation: vi.fn(),
  revokeInvitation: vi.fn(),
  acceptInvitation: vi.fn(),
}));
vi.mock("@bea/database/hosted", () => ({
  SqlCplAdministrationRepository: class {
    bootstrap = mocks.bootstrap;
    provisionOrganization = mocks.provisionOrganization;
    listMembers = mocks.listMembers;
    listInvitations = mocks.listInvitations;
    changeMember = mocks.changeMember;
    createInvitation = mocks.createInvitation;
    reissueInvitation = mocks.reissueInvitation;
    revokeInvitation = mocks.revokeInvitation;
    acceptInvitation = mocks.acceptInvitation;
  },
}));
vi.mock("../../apps/web/lib/hosted-auth", () => ({
  withHostedRuntime: async (fn: (runtime: unknown) => Promise<unknown>) => fn({ tenants: {} }),
  requireHostedSession: mocks.session,
  requireHostedMutation: mocks.mutation,
}));
import { GET, POST } from "../../apps/web/app/api/cpl-admin/[...path]/route";
const organization = "10000000-0000-4000-8000-000000000001";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({
    sessionToken: "server-token",
    session: { selectedOrganizationId: organization },
  });
  mocks.mutation.mockImplementation(() => mocks.session());
  for (const [name, fn] of Object.entries(mocks))
    if (!["session", "mutation"].includes(name)) fn.mockResolvedValue({ ok: true });
});
function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request("http://127.0.0.1:3400/api/cpl-admin/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-cpl-organization": organization, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function context(path: string) {
  return { params: Promise.resolve({ path: path.split("?")[0]!.split("/") }) };
}
describe("administration HTTP trust boundaries", () => {
  it("bootstraps a signed-in operator without tenant membership and disables caching", async () => {
    mocks.session.mockResolvedValue({
      sessionToken: "server-token",
      session: { selectedOrganizationId: null },
    });
    const response = await GET(request("bootstrap"), context("bootstrap"));
    expect(response.status).toBe(200);
    expect(mocks.bootstrap).toHaveBeenCalledWith({
      sessionToken: "server-token",
      organizationId: null,
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("refuses bootstrap tenant query spoofing", async () => {
    expect((await GET(request("bootstrap?organization=other"), context("bootstrap"))).status).toBe(
      400,
    );
    expect(mocks.bootstrap).not.toHaveBeenCalled();
  });
  it("uses only selected server tenant and strict list input", async () => {
    await GET(request("members?query=member&status=active&limit=25"), context("members"));
    expect(mocks.listMembers).toHaveBeenCalledWith({
      sessionToken: "server-token",
      organizationId: organization,
      query: "member",
      status: "active",
      limit: 25,
    });
    expect((await GET(request("members?limit=25&limit=100"), context("members"))).status).toBe(400);
  });
  it("denies stale organization before querying members", async () => {
    expect(
      (
        await GET(
          request("members", undefined, { "x-cpl-organization": "other" }),
          context("members"),
        )
      ).status,
    ).toBe(409);
    expect(mocks.listMembers).not.toHaveBeenCalled();
  });
  it("checks mutation CSRF before any provisioning", async () => {
    mocks.mutation.mockRejectedValue({ code: "CPL_CSRF_REJECTED" });
    expect(
      (await POST(request("platform/organizations", {}), context("platform/organizations"))).status,
    ).toBe(403);
    expect(mocks.provisionOrganization).not.toHaveBeenCalled();
  });
  it("rejects provider and tenant claims in company creation", async () => {
    expect(
      (
        await POST(
          request("platform/organizations", { role: "owner", issuer: "fake" }),
          context("platform/organizations"),
        )
      ).status,
    ).toBe(400);
    expect(mocks.provisionOrganization).not.toHaveBeenCalled();
  });
  it("redemption works before company selection, retaining exact authenticated token binding", async () => {
    mocks.mutation.mockResolvedValue({
      sessionToken: "recipient-token",
      session: { selectedOrganizationId: null },
    });
    const input = {
      organizationId: organization,
      invitationToken: "t".repeat(43),
      idempotencyKey: "accept-123",
    };
    expect(
      (await POST(request("invitations/accept", input), context("invitations/accept"))).status,
    ).toBe(200);
    expect(mocks.acceptInvitation).toHaveBeenCalledWith({
      sessionToken: "recipient-token",
      ...input,
    });
  });
  it("does not allow role/body overrides on invitation acceptance", async () => {
    expect(
      (
        await POST(
          request("invitations/accept", {
            organizationId: organization,
            invitationToken: "t".repeat(43),
            idempotencyKey: "accept-123",
            role: "owner",
          }),
          context("invitations/accept"),
        )
      ).status,
    ).toBe(400);
    expect(mocks.acceptInvitation).not.toHaveBeenCalled();
  });
  it("binds invitation actions to the path id", async () => {
    const id = "20000000-0000-4000-8000-000000000002";
    await POST(
      request(`invitations/${id}/revoke`, {
        expectedVersion: 2,
        reason: "Owner request",
        idempotencyKey: "revoke-123",
      }),
      context(`invitations/${id}/revoke`),
    );
    expect(mocks.revokeInvitation).toHaveBeenCalledWith({
      sessionToken: "server-token",
      organizationId: organization,
      input: {
        invitationId: id,
        expectedVersion: 2,
        reason: "Owner request",
        idempotencyKey: "revoke-123",
      },
    });
  });
  it.each([
    ["CPL_LAST_ACTIVE_OWNER", 409],
    ["CPL_ADMIN_STALE_VERSION", 409],
    ["CPL_INVITATION_UNAVAILABLE", 403],
    ["CPL_MEMBER_NOT_FOUND", 404],
  ])("returns safe domain status for %s", async (code, status) => {
    mocks.listMembers.mockRejectedValue({ code, message: "private row detail" });
    const response = await GET(request("members"), context("members"));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ code });
  });
  it("does not expose unexpected SQL/provider errors", async () => {
    mocks.listMembers.mockRejectedValue({ code: "42501", message: "private SQL detail" });
    const response = await GET(request("members"), context("members"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "CPL_WORKSPACE_UNAVAILABLE" });
  });
});
