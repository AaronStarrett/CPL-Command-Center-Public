import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEMO_PERSONAS,
  DEMO_ROLE_IDS,
  GuidedDemoAuthorizationError,
  GuidedDemoConcurrencyError,
  GuidedDemoConflictError,
  GuidedDemoUnavailableError,
  GuidedDemoValidationError,
} from "../../packages/domain/src/index.js";
import { PERMISSIONS } from "../../packages/security/src/index.js";

const OWNER = DEMO_PERSONAS[0].id;
const SALES = DEMO_PERSONAS[1].id;
const OPERATIONS = DEMO_PERSONAS[2].id;
const EXECUTIVE = DEMO_PERSONAS[3].id;
const INTEGRATION = DEMO_PERSONAS[4].id;

const mocks = vi.hoisted(() => ({
  getServerRuntime: vi.fn(),
  requestSession: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/operations-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../apps/web/lib/operations-api")>();
  return {
    ...actual,
    getOperationsServerRuntime: mocks.getServerRuntime,
  };
});

vi.mock("@/app/api/route-helpers", () => ({
  requestCorrelationId: () => "phase34a-http-auth",
  requestSession: mocks.requestSession,
  webRouteLogger: () => ({ error: mocks.loggerError, info: vi.fn() }),
}));

vi.mock("@/lib/diagnostics-authorization", () => ({
  canIncludeApiDiagnostics: vi.fn(async () => false),
}));

vi.mock("@/lib/guided-demo-server", () => ({
  buildGuidedDemoEnvelope: vi.fn(
    async ({ snapshot, displayName }: { snapshot: unknown; displayName: string }) => ({
      snapshot,
      demoAvailable: true,
      productionMode: false,
      roleKey: "owner-admin",
      displayName,
      allowedActions: ["start"],
      allowedDecisions: [],
      presentationCue: "cue",
      workerHealthy: true,
      report: null,
      proposal: null,
      command: null,
    }),
  ),
}));

import { GET, POST } from "../../apps/web/app/api/guided-demo/meridian/route";
import { POST as commandPost } from "../../apps/web/app/api/command-center/demo-command/route";

function sessionFor(userId: string, roleId: string) {
  return {
    provider: "demo" as const,
    personaId: userId,
    personaKey: "persona",
    displayName: "Workspace Owner",
    email: null,
    title: "Owner",
    roleIds: [roleId],
    createdAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-09-02T00:00:00.000Z",
  };
}

function mutation(url: string, body: Record<string, unknown>) {
  const encoded = JSON.stringify(body);
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(encoded).length),
      origin: "https://bea.example",
    },
    body: encoded,
  });
}

describe("Phase 3.4A guided demo HTTP authorization", () => {
  const execute = vi.fn();
  const routeCommand = vi.fn();
  const record = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    execute.mockResolvedValue({ id: "run-1", status: "not_started" });
    routeCommand.mockResolvedValue({
      snapshot: { id: "run-1" },
      response: { intent: "unsupported_demo_command", message: "unsupported" },
    });
    mocks.getServerRuntime.mockResolvedValue({
      environment: { appMode: "demo", appBaseUrl: "https://bea.example" },
      authorization: {
        authorizeUser: async (_userId: string, permission: string) => ({
          allowed: permission === PERMISSIONS.HOME_VIEW,
        }),
      },
      repository: { record },
      guidedDemo: { execute, routeCommand },
    });
  });

  it("rejects unauthenticated and unknown actions", async () => {
    mocks.requestSession.mockResolvedValue(null);
    const get = await GET(new Request("https://bea.example/api/guided-demo/meridian") as never);
    expect(get.status).toBe(401);
    mocks.requestSession.mockResolvedValue(sessionFor(OWNER, DEMO_ROLE_IDS.OWNER_ADMIN));
    const unknown = await POST(
      mutation("https://bea.example/api/guided-demo/meridian", {
        action: "delete_everything",
      }) as never,
    );
    expect(unknown.status).toBe(400);
    const body = (await unknown.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unknown-action");
  });

  it("maps production unavailability to 404", async () => {
    mocks.requestSession.mockResolvedValue(sessionFor(OWNER, DEMO_ROLE_IDS.OWNER_ADMIN));
    execute.mockRejectedValue(new GuidedDemoUnavailableError());
    const response = await POST(
      mutation("https://bea.example/api/guided-demo/meridian", { action: "start" }) as never,
    );
    expect(response.status).toBe(404);
  });

  it("denies executive mutation through the service authorization path", async () => {
    mocks.requestSession.mockResolvedValue(sessionFor(EXECUTIVE, DEMO_ROLE_IDS.EXECUTIVE_READONLY));
    const { GuidedDemoAuthorizationError } = await import("../../packages/domain/src/index.js");
    execute.mockRejectedValue(new GuidedDemoAuthorizationError());
    const response = await POST(
      mutation("https://bea.example/api/guided-demo/meridian", { action: "start" }) as never,
    );
    expect(response.status).toBe(403);
  });

  it("routes the deterministic command without an external provider", async () => {
    mocks.requestSession.mockResolvedValue(sessionFor(OWNER, DEMO_ROLE_IDS.OWNER_ADMIN));
    const response = await commandPost(
      mutation("https://bea.example/api/command-center/demo-command", {
        commandText: "Show me the Meridian Commerce Center inspection report.",
      }) as never,
    );
    expect(response.status).toBe(200);
    expect(routeCommand).toHaveBeenCalled();
  });

  it("accepts Owner delivery-change requests and forwards the reason and expected version", async () => {
    mocks.requestSession.mockResolvedValue(sessionFor(OWNER, DEMO_ROLE_IDS.OWNER_ADMIN));
    execute.mockResolvedValue({
      id: "run-1",
      status: "waiting_for_human",
      machineState: "waiting_technical_review",
    });
    const response = await POST(
      mutation("https://bea.example/api/guided-demo/meridian", {
        action: "request_delivery_changes",
        comments: "Clarify the recommended repair priority before release.",
        expectedVersion: 12,
      }) as never,
    );
    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "request_delivery_changes",
        comments: "Clarify the recommended repair priority before release.",
        expectedVersion: 12,
        actorUserId: OWNER,
      }),
    );
  });

  it("maps denied delivery-gate mutations to 403 for non-Owner roles", async () => {
    const denied = [
      [OPERATIONS, DEMO_ROLE_IDS.OPERATIONS],
      [SALES, DEMO_ROLE_IDS.SALES],
      [INTEGRATION, DEMO_ROLE_IDS.INTEGRATION_ADMIN],
      [EXECUTIVE, DEMO_ROLE_IDS.EXECUTIVE_READONLY],
    ] as const;
    for (const [userId, roleId] of denied) {
      mocks.requestSession.mockResolvedValue(sessionFor(userId, roleId));
      execute.mockRejectedValueOnce(
        new GuidedDemoAuthorizationError("The current role cannot mutate the Owner delivery gate."),
      );
      const response = await POST(
        mutation("https://bea.example/api/guided-demo/meridian", {
          action: "request_delivery_changes",
          comments: "Unauthorized delivery-gate mutation.",
          expectedVersion: 4,
        }) as never,
      );
      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("permission-not-granted");
    }
  });

  it("maps an empty delivery-change reason to 400", async () => {
    mocks.requestSession.mockResolvedValue(sessionFor(OWNER, DEMO_ROLE_IDS.OWNER_ADMIN));
    execute.mockRejectedValue(
      new GuidedDemoValidationError("A nonempty delivery-change reason is required."),
    );
    const response = await POST(
      mutation("https://bea.example/api/guided-demo/meridian", {
        action: "request_delivery_changes",
        comments: "   ",
        expectedVersion: 4,
      }) as never,
    );
    expect(response.status).toBe(400);
  });

  it("maps a stale expectedVersion to 409", async () => {
    mocks.requestSession.mockResolvedValue(sessionFor(OWNER, DEMO_ROLE_IDS.OWNER_ADMIN));
    execute.mockRejectedValue(new GuidedDemoConcurrencyError());
    const response = await POST(
      mutation("https://bea.example/api/guided-demo/meridian", {
        action: "request_delivery_changes",
        comments: "Stale browser",
        expectedVersion: 1,
      }) as never,
    );
    expect(response.status).toBe(409);
  });

  it("maps a technical-change request at the Owner gate to 409", async () => {
    mocks.requestSession.mockResolvedValue(sessionFor(OWNER, DEMO_ROLE_IDS.OWNER_ADMIN));
    execute.mockRejectedValue(
      new GuidedDemoConflictError(
        "Request Delivery Changes is required at the Owner delivery gate.",
      ),
    );
    const response = await POST(
      mutation("https://bea.example/api/guided-demo/meridian", {
        action: "request_technical_changes",
        expectedVersion: 8,
      }) as never,
    );
    expect(response.status).toBe(409);
  });
});
