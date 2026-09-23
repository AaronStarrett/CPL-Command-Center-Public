// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const stubs = vi.hoisted(() => ({
  session: vi.fn(),
  mutation: vi.fn(),
  getProjectWorkspace: vi.fn(),
  getVisit: vi.fn(),
  readAgenda: vi.fn(),
  saveProject: vi.fn(),
  createVisit: vi.fn(),
  saveVisit: vi.fn(),
}));
vi.mock("@/lib/hosted-auth", () => ({
  withHostedRuntime: async (operation: (runtime: unknown) => Promise<unknown>) =>
    operation({ tenants: {} }),
  requireHostedSession: stubs.session,
  requireHostedMutation: stubs.mutation,
}));
vi.mock("@bea/database/hosted", () => ({
  SqlCplExecutionRepository: class {
    getProjectWorkspace = stubs.getProjectWorkspace;
    getVisit = stubs.getVisit;
    readAgenda = stubs.readAgenda;
    saveProject = stubs.saveProject;
    createVisit = stubs.createVisit;
    saveVisit = stubs.saveVisit;
  },
}));
import { GET, POST } from "../../apps/web/app/api/cpl-execution/[...path]/route";
const organizationId = "123e4567-e89b-12d3-a456-426614174001",
  projectId = "123e4567-e89b-12d3-a456-426614174002",
  visitId = "123e4567-e89b-12d3-a456-426614174003";
const tenant = { sessionToken: "server-only-session", organizationId };
const context = (...path: string[]) => ({ params: Promise.resolve({ path }) });
function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://127.0.0.1:3400/api/cpl-execution/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      "x-cpl-organization": organizationId,
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
describe("execution HTTP trust boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    const session = {
      sessionToken: tenant.sessionToken,
      session: { selectedOrganizationId: organizationId },
    };
    stubs.session.mockResolvedValue(session);
    stubs.mutation.mockResolvedValue(session);
    for (const name of [
      "getProjectWorkspace",
      "getVisit",
      "readAgenda",
      "saveProject",
      "createVisit",
      "saveVisit",
    ] as const)
      stubs[name].mockResolvedValue({ id: projectId });
  });
  it("derives tenant only from current session and rejects a stale company context", async () => {
    expect(
      (await GET(request(`projects/${projectId}`), context("projects", projectId))).status,
    ).toBe(200);
    expect(stubs.getProjectWorkspace).toHaveBeenCalledWith({ ...tenant, projectId });
    expect(
      (
        await GET(
          request(`projects/${projectId}`, undefined, { "x-cpl-organization": "other" }),
          context("projects", projectId),
        )
      ).status,
    ).toBe(409);
    expect(stubs.getProjectWorkspace).toHaveBeenCalledTimes(1);
  });
  it("authenticates and checks CSRF before mutation or reading the supplied parent", async () => {
    stubs.mutation.mockRejectedValue({ code: "CPL_CSRF_REJECTED" });
    expect(
      (
        await POST(
          request(`visits/${visitId}`, {
            projectId,
            expectedRevision: 1,
            idempotencyKey: "safe-retry-key",
            input: {},
          }),
          context("visits", visitId),
        )
      ).status,
    ).toBe(403);
    expect(stubs.saveVisit).not.toHaveBeenCalled();
    stubs.session.mockRejectedValue({ code: "CPL_AUTHENTICATION_REQUIRED" });
    expect(
      (await GET(request(`projects/${projectId}`), context("projects", projectId))).status,
    ).toBe(401);
    expect(stubs.getProjectWorkspace).not.toHaveBeenCalled();
  });
  it("passes parent and optimistic revision as service preconditions without accepting authority fields", async () => {
    const payload = {
      projectId,
      expectedRevision: 2,
      idempotencyKey: "stable-edit-key",
      input: { purpose: "Fictional visit" },
    };
    expect(
      (await POST(request(`visits/${visitId}`, payload), context("visits", visitId))).status,
    ).toBe(200);
    expect(stubs.saveVisit).toHaveBeenCalledWith({ ...tenant, visitId, ...payload });
    for (const forged of [
      { organizationId: "other" },
      { sessionToken: "other" },
      { actorIdentityId: "other" },
    ])
      expect(
        (
          await POST(
            request(`visits/${visitId}`, { ...payload, ...forged }),
            context("visits", visitId),
          )
        ).status,
      ).toBe(400);
    expect(stubs.saveVisit).toHaveBeenCalledTimes(1);
  });
  it("preserves same-tenant conflict detail without exposing internal diagnostics", async () => {
    const conflict = {
      visitId,
      projectId,
      purpose: "Already scheduled",
      plannedStartAt: "2026-10-01T13:00:00Z",
      plannedEndAt: "2026-10-01T14:00:00Z",
      timeZone: "America/Indiana/Indianapolis",
    };
    stubs.createVisit.mockRejectedValue({
      code: "CPL_EXECUTION_SCHEDULE_CONFLICT",
      conflicts: [{ ...conflict, privatePath: "D:/private", internalNotes: "private" }],
      message: "private SQL",
    });
    const response = await POST(
      request(`projects/${projectId}/visits`, { idempotencyKey: "visit-create-key", input: {} }),
      context("projects", projectId, "visits"),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "CPL_EXECUTION_SCHEDULE_CONFLICT",
      conflicts: [conflict],
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("requires unambiguous agenda range and does not expose arbitrary routes or failures", async () => {
    expect(
      (await GET(request("agenda?from=one&from=two&to=three"), context("agenda"))).status,
    ).toBe(400);
    expect(stubs.readAgenda).not.toHaveBeenCalled();
    expect((await GET(request("admin"), context("admin"))).status).toBe(404);
    stubs.getProjectWorkspace.mockRejectedValue(new Error("database secret"));
    const response = await GET(request(`projects/${projectId}`), context("projects", projectId));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "CPL_WORKSPACE_UNAVAILABLE" });
  });
});
