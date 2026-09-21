import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEMO_PERSONAS, DEMO_ROLE_IDS } from "../../packages/domain/src/index.js";
import { PERMISSIONS } from "../../packages/security/src/index.js";

const OWNER = DEMO_PERSONAS[0].id;
const SALES = DEMO_PERSONAS[1].id;
const OPERATIONS = DEMO_PERSONAS[2].id;

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
  requestCorrelationId: () => "phase30-http-auth",
  requestSession: mocks.requestSession,
  webRouteLogger: () => ({ error: mocks.loggerError, info: vi.fn() }),
}));

vi.mock("@/lib/diagnostics-authorization", () => ({
  canIncludeApiDiagnostics: vi.fn(async () => false),
}));

import { POST as reportPost } from "../../apps/web/app/api/operations/reports/[id]/route";

function sessionFor(userId: string, roleId: string) {
  return {
    provider: "demo" as const,
    personaId: userId,
    personaKey: "persona",
    displayName: "Test",
    email: null,
    title: "Test",
    roleIds: [roleId],
    createdAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-09-02T00:00:00.000Z",
  };
}

function reportMutation(action: string) {
  const body = JSON.stringify({ action });
  return new Request("https://bea.example/api/operations/reports/report-1", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(body).length),
      origin: "https://bea.example",
    },
    body,
  }) as Parameters<typeof reportPost>[0];
}

describe("Phase 3.0 report mutation HTTP authorization", () => {
  const record = vi.fn();
  const authorizeDelivery = vi.fn();
  const reviewReport = vi.fn();
  const retryDelivery = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    authorizeDelivery.mockResolvedValue({
      report: { status: "delivering" },
      authorizationId: "auth-1",
    });
    reviewReport.mockResolvedValue({ report: { status: "ready_for_delivery" } });
    retryDelivery.mockResolvedValue(undefined);
    mocks.getServerRuntime.mockResolvedValue({
      environment: { appMode: "demo", appBaseUrl: "https://bea.example" },
      authorization: {
        authorizeUser: async (userId: string, permission: string) => {
          if (userId === OWNER && permission === PERMISSIONS.REPORTS_DELIVER) {
            return { allowed: true };
          }
          if (userId === OPERATIONS && permission === PERMISSIONS.REPORTS_APPROVE) {
            return { allowed: true };
          }
          if (userId === OPERATIONS && permission === PERMISSIONS.REPORTS_REVIEW) {
            return { allowed: true };
          }
          return { allowed: false, reason: "denied" };
        },
      },
      repository: { record },
      operations: { authorizeDelivery, reviewReport, retryDelivery },
    });
  });

  it("returns 401 for unauthenticated authorize-delivery", async () => {
    mocks.requestSession.mockResolvedValue(undefined);
    const response = await reportPost(reportMutation("authorize-delivery"), {
      params: Promise.resolve({ id: "report-1" }),
    });
    expect(response.status).toBe(401);
    expect(authorizeDelivery).not.toHaveBeenCalled();
  });

  it("returns 403 when sales or operations try to authorize delivery", async () => {
    mocks.requestSession.mockResolvedValue(sessionFor(SALES, DEMO_ROLE_IDS.SALES));
    const sales = await reportPost(reportMutation("authorize-delivery"), {
      params: Promise.resolve({ id: "report-1" }),
    });
    expect(sales.status).toBe(403);
    mocks.requestSession.mockResolvedValue(sessionFor(OPERATIONS, DEMO_ROLE_IDS.OPERATIONS));
    const operations = await reportPost(reportMutation("authorize-delivery"), {
      params: Promise.resolve({ id: "report-1" }),
    });
    expect(operations.status).toBe(403);
    expect(authorizeDelivery).not.toHaveBeenCalled();
  });

  it("returns 403 when sales tries technical approval and 200 when operations approves", async () => {
    mocks.requestSession.mockResolvedValue(sessionFor(SALES, DEMO_ROLE_IDS.SALES));
    const sales = await reportPost(reportMutation("technical-approve"), {
      params: Promise.resolve({ id: "report-1" }),
    });
    expect(sales.status).toBe(403);
    expect(reviewReport).not.toHaveBeenCalled();
    mocks.requestSession.mockResolvedValue(sessionFor(OPERATIONS, DEMO_ROLE_IDS.OPERATIONS));
    const operations = await reportPost(reportMutation("technical-approve"), {
      params: Promise.resolve({ id: "report-1" }),
    });
    expect(operations.status).toBe(200);
    expect(reviewReport).toHaveBeenCalledWith(
      expect.objectContaining({
        reportId: "report-1",
        decision: "approve",
        actorUserId: OPERATIONS,
      }),
    );
  });

  it("allows owner authorize-delivery through the route handler", async () => {
    mocks.requestSession.mockResolvedValue(sessionFor(OWNER, DEMO_ROLE_IDS.OWNER_ADMIN));
    const response = await reportPost(reportMutation("authorize-delivery"), {
      params: Promise.resolve({ id: "report-1" }),
    });
    expect(response.status).toBe(200);
    expect(authorizeDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ reportId: "report-1", actorUserId: OWNER }),
    );
  });
});
