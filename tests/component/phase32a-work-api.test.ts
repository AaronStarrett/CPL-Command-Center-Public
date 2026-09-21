import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEMO_PERSONAS,
  DEMO_ROLE_IDS,
  WorkProjectionNotFoundError,
  WorkProjectionRetryConflictError,
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
  requestCorrelationId: () => "phase32a-http-auth",
  requestSession: mocks.requestSession,
  webRouteLogger: () => ({ error: mocks.loggerError, info: vi.fn() }),
}));

vi.mock("@/lib/diagnostics-authorization", () => ({
  canIncludeApiDiagnostics: vi.fn(async () => false),
}));

import { GET as workGet, POST as workPost } from "../../apps/web/app/api/work/route";
import { GET as workItemGet } from "../../apps/web/app/api/work/[id]/route";

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

function mutation(action: string, extra: Record<string, unknown> = {}) {
  const body = JSON.stringify({ action, workItemId: "work-1", expectedVersion: 1, ...extra });
  return new Request("https://bea.example/api/work", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(body).length),
      origin: "https://bea.example",
    },
    body,
  }) as Parameters<typeof workPost>[0];
}

describe("Phase 3.2A work mutation HTTP authorization", () => {
  const record = vi.fn();
  const claimWorkItem = vi.fn();
  const reconcile = vi.fn();
  const retryProjectionEvent = vi.fn();
  const inspectPolicy = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    claimWorkItem.mockResolvedValue({ id: "work-1", status: "in_progress" });
    reconcile.mockResolvedValue({ createdMissing: 0, completedStale: 0, unchanged: 1 });
    inspectPolicy.mockReturnValue({
      action: "inspect-policy",
      durableTransitionOccurred: false,
      codeDefinedSyntheticRoutingActive: true,
      productionPolicyUnconfigured: true,
      productionActivationBlocked: true,
    });
    retryProjectionEvent.mockResolvedValue(undefined);
    mocks.getServerRuntime.mockResolvedValue({
      environment: { appMode: "demo", appBaseUrl: "https://bea.example" },
      authorization: {
        authorizeUser: async (userId: string, permission: string) => {
          if (userId === OWNER) return { allowed: true };
          if (userId === OPERATIONS) {
            return {
              allowed: [
                PERMISSIONS.WORK_VIEW,
                PERMISSIONS.WORK_CLAIM,
                PERMISSIONS.WORK_UPDATE,
                PERMISSIONS.WORK_NOTIFICATIONS_VIEW,
              ].includes(permission as (typeof PERMISSIONS)[keyof typeof PERMISSIONS]),
            };
          }
          if (userId === EXECUTIVE) {
            return {
              allowed: [
                PERMISSIONS.WORK_VIEW,
                PERMISSIONS.WORK_NOTIFICATIONS_VIEW,
                PERMISSIONS.WORK_SCHEDULES_VIEW,
              ].includes(permission as (typeof PERMISSIONS)[keyof typeof PERMISSIONS]),
            };
          }
          if (userId === INTEGRATION) {
            return {
              allowed: [
                PERMISSIONS.WORK_VIEW,
                PERMISSIONS.WORK_CLAIM,
                PERMISSIONS.WORK_UPDATE,
                PERMISSIONS.INTEGRATIONS_MANAGE,
                PERMISSIONS.WORK_SCHEDULES_VIEW,
              ].includes(permission as (typeof PERMISSIONS)[keyof typeof PERMISSIONS]),
            };
          }
          if (userId === SALES) {
            return {
              allowed: [PERMISSIONS.PROPOSALS_WORK_VIEW, PERMISSIONS.PROPOSALS_WORK_CLAIM].includes(
                permission as (typeof PERMISSIONS)[keyof typeof PERMISSIONS],
              ),
            };
          }
          return { allowed: false, reason: "permission-not-granted" };
        },
      },
      repository: {
        record,
        findActiveUserById: async (id: string) => ({
          id,
          roleIds:
            id === OWNER
              ? [DEMO_ROLE_IDS.OWNER_ADMIN]
              : id === OPERATIONS
                ? [DEMO_ROLE_IDS.OPERATIONS]
                : id === INTEGRATION
                  ? [DEMO_ROLE_IDS.INTEGRATION_ADMIN]
                  : [],
        }),
      },
      workControl: {
        claimWorkItem,
        reconcile,
        retryProjectionEvent,
        inspectPolicy,
        validatePolicyPreview: () => ({
          action: "validate-policy-preview",
          durableTransitionOccurred: false,
          codeDefinedSyntheticRoutingActive: true,
          productionPolicyUnconfigured: true,
          productionActivationBlocked: true,
        }),
        activationReadinessPreview: () => ({
          action: "activation-readiness-preview",
          durableTransitionOccurred: false,
          codeDefinedSyntheticRoutingActive: true,
          productionPolicyUnconfigured: true,
          productionActivationBlocked: true,
        }),
        repository: {
          getWorkItem: async (id: string) => {
            if (id === "prep-1") {
              return { id, workItemKind: "proposal_preparation", status: "open" };
            }
            return { id, workItemKind: "inspection_readiness", status: "open" };
          },
          listWorkItems: async () => [
            {
              id: "prep-1",
              workItemKind: "proposal_preparation",
              queueKey: "proposal.preparation",
            },
            {
              id: "insp-1",
              workItemKind: "inspection_readiness",
              queueKey: "inspection.readiness",
            },
            { id: "rev-1", workItemKind: "proposal_review", queueKey: "proposal.review" },
          ],
          listAssignments: async () => [],
          listWorkItemEvents: async () => [],
          listReminders: async () => [],
          listEscalations: async () => [],
          listNotifications: async () => [],
          listSchedules: async () => [],
          listPolicies: async () => [],
          listBlueprints: async () => [],
          listReconciliationRuns: async () => [],
          listProjectionFailures: async () => [
            {
              id: "fail-1",
              sourceEventId: "event-1",
              eventType: "report.review_requested",
              processingStatus: "failed",
              errorCode: "REPORT_UNAVAILABLE",
              errorMessage: "Report aggregate is not available for projection.",
              attemptCount: 1,
            },
          ],
        },
        triggerProvisioningPlan: () => ({ status: "activation_blocked", items: [] }),
        metrics: async () => ({
          synthetic: true,
          open: 0,
          openCountByKind: {},
          humanWaitingMsByKind: {},
        }),
      },
    });
  });

  it("returns 401 when unauthenticated", async () => {
    mocks.requestSession.mockResolvedValue(undefined);
    const response = await workPost(mutation("claim"));
    expect(response.status).toBe(401);
  });

  it("returns 403 when sales claims technical work", async () => {
    mocks.requestSession.mockResolvedValue(sessionFor(SALES, DEMO_ROLE_IDS.SALES));
    const response = await workPost(mutation("claim"));
    expect(response.status).toBe(403);
    expect(claimWorkItem).not.toHaveBeenCalled();
  });

  it("lets sales claim assigned commercial proposal work", async () => {
    mocks.requestSession.mockResolvedValue(sessionFor(SALES, DEMO_ROLE_IDS.SALES));
    const response = await workPost(mutation("claim", { workItemId: "prep-1" }));
    expect(response.status).toBe(200);
    expect(claimWorkItem).toHaveBeenCalled();
  });

  it("returns 403 when executive mutates work", async () => {
    mocks.requestSession.mockResolvedValue(sessionFor(EXECUTIVE, DEMO_ROLE_IDS.EXECUTIVE_READONLY));
    const response = await workPost(mutation("claim"));
    expect(response.status).toBe(403);
  });

  it("returns 400 for unknown actions without fallthrough", async () => {
    mocks.requestSession.mockResolvedValue(sessionFor(OWNER, DEMO_ROLE_IDS.OWNER_ADMIN));
    const response = await workPost(mutation("complete-manually"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("unknown-action");
  });

  it("allows operations to claim eligible work", async () => {
    mocks.requestSession.mockResolvedValue(sessionFor(OPERATIONS, DEMO_ROLE_IDS.OPERATIONS));
    const response = await workPost(mutation("claim"));
    expect(response.status).toBe(200);
    expect(claimWorkItem).toHaveBeenCalled();
  });

  it("allows authenticated work list reads", async () => {
    mocks.requestSession.mockResolvedValue(sessionFor(OPERATIONS, DEMO_ROLE_IDS.OPERATIONS));
    const request = {
      nextUrl: new URL("https://bea.example/api/work?view=my"),
      headers: new Headers({ origin: "https://bea.example" }),
      url: "https://bea.example/api/work?view=my",
    } as Parameters<typeof workGet>[0];
    const response = await workGet(request);
    expect(response.status).toBe(200);
  });

  it("rejects retired policy mutation actions as unknown", async () => {
    mocks.requestSession.mockResolvedValue(sessionFor(OWNER, DEMO_ROLE_IDS.OWNER_ADMIN));
    expect((await workPost(mutation("validate-policy"))).status).toBe(400);
    expect((await workPost(mutation("activate-policy"))).status).toBe(400);
  });

  it("returns a truthful policy preview without a durable transition", async () => {
    mocks.requestSession.mockResolvedValue(sessionFor(OWNER, DEMO_ROLE_IDS.OWNER_ADMIN));
    const response = await workPost(mutation("validate-policy-preview"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      preview?: { durableTransitionOccurred?: boolean; action?: string };
    };
    expect(body.preview?.durableTransitionOccurred).toBe(false);
    expect(body.preview?.action).toBe("validate-policy-preview");
  });

  it("returns 401 when unauthenticated retry is requested", async () => {
    mocks.requestSession.mockResolvedValue(undefined);
    const response = await workPost(mutation("retry-projection", { eventId: "event-1" }));
    expect(response.status).toBe(401);
    expect(retryProjectionEvent).not.toHaveBeenCalled();
  });

  it("returns 403 when Sales, Executive, or Operations retry a projection", async () => {
    mocks.requestSession.mockResolvedValue(sessionFor(SALES, DEMO_ROLE_IDS.SALES));
    expect((await workPost(mutation("retry-projection", { eventId: "event-1" }))).status).toBe(403);
    mocks.requestSession.mockResolvedValue(sessionFor(EXECUTIVE, DEMO_ROLE_IDS.EXECUTIVE_READONLY));
    expect((await workPost(mutation("retry-projection", { eventId: "event-1" }))).status).toBe(403);
    mocks.requestSession.mockResolvedValue(sessionFor(OPERATIONS, DEMO_ROLE_IDS.OPERATIONS));
    expect((await workPost(mutation("retry-projection", { eventId: "event-1" }))).status).toBe(403);
    expect(retryProjectionEvent).not.toHaveBeenCalled();
  });

  it("allows Owner and Integration Administrator to retry a failed projection", async () => {
    mocks.requestSession.mockResolvedValue(sessionFor(OWNER, DEMO_ROLE_IDS.OWNER_ADMIN));
    expect((await workPost(mutation("retry-projection", { eventId: "event-1" }))).status).toBe(200);
    mocks.requestSession.mockResolvedValue(
      sessionFor(INTEGRATION, DEMO_ROLE_IDS.INTEGRATION_ADMIN),
    );
    expect((await workPost(mutation("retry-projection", { eventId: "event-1" }))).status).toBe(200);
    expect(retryProjectionEvent).toHaveBeenCalledTimes(2);
  });

  it("returns 404 for an unknown projection event and 409 for a processed event", async () => {
    mocks.requestSession.mockResolvedValue(
      sessionFor(INTEGRATION, DEMO_ROLE_IDS.INTEGRATION_ADMIN),
    );
    retryProjectionEvent.mockRejectedValueOnce(new WorkProjectionNotFoundError());
    const missing = await workPost(mutation("retry-projection", { eventId: "missing-event" }));
    expect(missing.status).toBe(404);
    const missingBody = (await missing.json()) as { error?: { code?: string } };
    expect(missingBody.error?.code).toBe("work-projection-not-found");
    retryProjectionEvent.mockRejectedValueOnce(new WorkProjectionRetryConflictError());
    const conflict = await workPost(mutation("retry-projection", { eventId: "processed-event" }));
    expect(conflict.status).toBe(409);
    const conflictBody = (await conflict.json()) as { error?: { code?: string } };
    expect(conflictBody.error?.code).toBe("work-projection-retry-conflict");
  });

  it("rejects cross-origin projection retry", async () => {
    mocks.requestSession.mockResolvedValue(
      sessionFor(INTEGRATION, DEMO_ROLE_IDS.INTEGRATION_ADMIN),
    );
    const body = JSON.stringify({
      action: "retry-projection",
      workItemId: "work-1",
      expectedVersion: 1,
      eventId: "event-1",
    });
    const request = new Request("https://bea.example/api/work", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(new TextEncoder().encode(body).length),
        origin: "https://evil.example",
      },
      body,
    }) as Parameters<typeof workPost>[0];
    const response = await workPost(request);
    expect(response.status).toBe(403);
    const payload = (await response.json()) as { error?: { code?: string } };
    expect(payload.error?.code).toBe("cross-origin-request-rejected");
    expect(retryProjectionEvent).not.toHaveBeenCalled();
  });

  it("exposes failed projections without raw source", async () => {
    mocks.requestSession.mockResolvedValue(
      sessionFor(INTEGRATION, DEMO_ROLE_IDS.INTEGRATION_ADMIN),
    );
    const request = {
      nextUrl: new URL("https://bea.example/api/work?view=projection-failures"),
      headers: new Headers({ origin: "https://bea.example" }),
      url: "https://bea.example/api/work?view=projection-failures",
    } as Parameters<typeof workGet>[0];
    const response = await workGet(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items?: Array<Record<string, unknown>> };
    expect(body.items?.[0]?.processingStatus).toBe("failed");
    expect(JSON.stringify(body)).not.toMatch(/rawPayload|signature|BEGIN /u);
  });

  it("filters Sales work lists to commercial kinds and hides technical detail", async () => {
    mocks.requestSession.mockResolvedValue(sessionFor(SALES, DEMO_ROLE_IDS.SALES));
    const listRequest = {
      nextUrl: new URL("https://bea.example/api/work?view=my"),
      headers: new Headers({ origin: "https://bea.example" }),
      url: "https://bea.example/api/work?view=my",
    } as Parameters<typeof workGet>[0];
    const list = await workGet(listRequest);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { items?: Array<{ workItemKind?: string }> };
    expect(listBody.items?.every((item) => item.workItemKind === "proposal_preparation")).toBe(
      true,
    );
    expect(listBody.items?.some((item) => item.workItemKind === "inspection_readiness")).toBe(
      false,
    );
    expect(listBody.items?.some((item) => item.workItemKind === "proposal_review")).toBe(false);
    const hidden = await workItemGet(
      new Request("https://bea.example/api/work/work-1") as Parameters<typeof workItemGet>[0],
      { params: Promise.resolve({ id: "work-1" }) },
    );
    expect(hidden.status).toBe(404);
    const visible = await workItemGet(
      new Request("https://bea.example/api/work/prep-1") as Parameters<typeof workItemGet>[0],
      { params: Promise.resolve({ id: "prep-1" }) },
    );
    expect(visible.status).toBe(200);
  });
});
