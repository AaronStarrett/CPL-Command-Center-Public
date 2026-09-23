// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const s = vi.hoisted(() => ({
  session: vi.fn(),
  mutation: vi.fn(),
  getWorkspace: vi.fn(),
  getExecution: vi.fn(),
  saveRecipe: vi.fn(),
  updateTask: vi.fn(),
  retryExecution: vi.fn(),
  cancelExecution: vi.fn(),
  replayEvent: vi.fn(),
}));
vi.mock("@/lib/hosted-auth", () => ({
  withHostedRuntime: async (operation: (runtime: unknown) => Promise<unknown>) =>
    operation({ tenants: {} }),
  requireHostedSession: s.session,
  requireHostedMutation: s.mutation,
}));
vi.mock("@bea/database/hosted", () => ({
  SqlCplAutomationRepository: class {
    getWorkspace = s.getWorkspace;
    getExecution = s.getExecution;
    saveRecipe = s.saveRecipe;
    updateTask = s.updateTask;
    retryExecution = s.retryExecution;
    cancelExecution = s.cancelExecution;
    replayEvent = s.replayEvent;
  },
}));
import { GET, POST } from "../../apps/web/app/api/cpl-automation/[...path]/route";
const organizationId = "123e4567-e89b-12d3-a456-426614174000",
  id = "123e4567-e89b-12d3-a456-426614174001",
  scope = { organizationId, sessionToken: "synthetic-session" };
const context = (path: string[]) => ({ params: Promise.resolve({ path }) });
function request(
  path: string[],
  value?: unknown,
  headers: Record<string, string> = {},
  query = "",
) {
  return new Request("http://127.0.0.1:3400/api/cpl-automation/" + path.join("/") + query, {
    method: value === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      "x-cpl-organization": organizationId,
      ...headers,
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
}
const edit = {
  expectedRevision: 2,
  idempotencyKey: "fictional-request",
  reason: "Fictional diagnostic retry",
};
describe("tenant automation HTTP authority", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    const session = {
      sessionToken: scope.sessionToken,
      session: { selectedOrganizationId: organizationId },
    };
    s.session.mockResolvedValue(session);
    s.mutation.mockResolvedValue(session);
    for (const name of [
      "getWorkspace",
      "getExecution",
      "saveRecipe",
      "updateTask",
      "retryExecution",
      "cancelExecution",
      "replayEvent",
    ] as const)
      s[name].mockResolvedValue({ saved: true });
  });
  it("requires a session or verified mutation before reading or changing any automation", async () => {
    s.session.mockRejectedValue({ code: "CPL_AUTHENTICATION_REQUIRED" });
    expect((await GET(request(["workspace"]), context(["workspace"]))).status).toBe(401);
    expect(s.getWorkspace).not.toHaveBeenCalled();
    s.mutation.mockRejectedValue({ code: "CPL_CSRF_REJECTED" });
    expect(
      (
        await POST(
          request(["events", id, "replay"], { idempotencyKey: "retry", reason: "test" }),
          context(["events", id, "replay"]),
        )
      ).status,
    ).toBe(403);
    expect(s.replayEvent).not.toHaveBeenCalled();
  });
  it("takes tenant authority from the session and rejects stale or query-supplied company context", async () => {
    for (const [headers, query] of [
      [{ "x-cpl-organization": "other" }, ""],
      [{}, "?organization=" + organizationId],
    ] as const)
      expect(
        (await GET(request(["workspace"], undefined, headers, query), context(["workspace"])))
          .status,
      ).toBe(409);
    expect(s.getWorkspace).not.toHaveBeenCalled();
  });
  it("returns real service counts and permission flags with no-store headers", async () => {
    s.getWorkspace.mockResolvedValue({
      counts: { open: 8 },
      tasks: [],
      permissions: { canConfigure: false },
    });
    const response = await GET(request(["workspace"]), context(["workspace"]));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      counts: { open: 8 },
      tasks: [],
      permissions: { canConfigure: false },
    });
    expect(s.getWorkspace).toHaveBeenCalledWith(scope);
  });
  it("binds execution reads to the current tenant", async () => {
    await GET(request(["executions", id]), context(["executions", id]));
    expect(s.getExecution).toHaveBeenCalledWith({ ...scope, executionId: id });
    s.getExecution.mockRejectedValue({ code: "CPL_RECORD_NOT_FOUND" });
    expect((await GET(request(["executions", id]), context(["executions", id]))).status).toBe(404);
  });
  it("does not accept browser identities, execution results or configuration versions outside the mutation contract", async () => {
    for (const injected of [
      { organizationId: "other" },
      { actorIdentityId: id },
      { executed: true },
      { approvedAt: "now" },
    ])
      expect(
        (
          await POST(
            request(["recipes"], {
              expectedVersion: 0,
              idempotencyKey: "new-recipe",
              input: {},
              ...injected,
            }),
            context(["recipes"]),
          )
        ).status,
      ).toBe(400);
    expect(s.saveRecipe).not.toHaveBeenCalled();
  });
  it("preserves the optimistic recipe version and leaves bounded configuration validation to the domain", async () => {
    const input = {
      expectedVersion: 0,
      idempotencyKey: "new-recipe",
      input: { trigger: "lead.ready", enabled: false },
    };
    await POST(request(["recipes"], input), context(["recipes"]));
    expect(s.saveRecipe).toHaveBeenCalledWith({ ...scope, ...input });
    s.saveRecipe.mockRejectedValue({ code: "CPL_AUTOMATION_VERSION_CONFLICT" });
    expect((await POST(request(["recipes"], input), context(["recipes"]))).status).toBe(409);
  });
  it("allows only task actions and never treats a client approval flag as completion", async () => {
    for (const value of [
      { ...edit, action: "approve" },
      { ...edit, action: "complete", approved: true },
    ])
      expect((await POST(request(["tasks", id], value), context(["tasks", id]))).status).toBe(400);
    await POST(request(["tasks", id], { ...edit, action: "dismiss" }), context(["tasks", id]));
    expect(s.updateTask).toHaveBeenCalledWith({ ...scope, taskId: id, ...edit, action: "dismiss" });
  });
  it("passes retry, cancellation and replay reasons to the authorized service without executing jobs inside HTTP", async () => {
    for (const [action, method] of [
      ["retry", "retryExecution"],
      ["cancel", "cancelExecution"],
    ] as const) {
      await POST(request(["executions", id, action], edit), context(["executions", id, action]));
      expect(s[method]).toHaveBeenCalledWith({ ...scope, executionId: id, ...edit });
    }
    const replay = { idempotencyKey: "replay", reason: "Verify durable identity" };
    await POST(request(["events", id, "replay"], replay), context(["events", id, "replay"]));
    expect(s.replayEvent).toHaveBeenCalledWith({ ...scope, eventId: id, ...replay });
    expect((await POST(request(["drain"], {}), context(["drain"]))).status).toBe(404);
  });
  it("does not disclose database exceptions, secrets or stack traces", async () => {
    s.getWorkspace.mockRejectedValue({
      message: "postgresql://private:secret@localhost/database",
      stack: "private stack",
      code: "23505",
    });
    const response = await GET(request(["workspace"]), context(["workspace"]));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "CPL_WORKSPACE_UNAVAILABLE" });
  });
});
