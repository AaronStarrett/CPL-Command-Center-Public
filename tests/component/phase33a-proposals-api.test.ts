import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEMO_PERSONAS,
  DEMO_ROLE_IDS,
  PROPOSAL_EMAIL_DRY_RUN_DISCLOSURE,
  CommercialCatalogValidationError,
  CommercialConcurrencyError,
  CommercialNotFoundError,
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
  requestCorrelationId: () => "phase33a-http-auth",
  requestSession: mocks.requestSession,
  webRouteLogger: () => ({ error: mocks.loggerError, info: vi.fn() }),
}));

vi.mock("@/lib/diagnostics-authorization", () => ({
  canIncludeApiDiagnostics: vi.fn(async () => false),
}));

import { GET as proposalsGet, POST as proposalsPost } from "../../apps/web/app/api/proposals/route";
import {
  GET as proposalGet,
  POST as proposalPost,
} from "../../apps/web/app/api/proposals/[id]/route";
import { POST as catalogPost } from "../../apps/web/app/api/catalog/route";

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

function mutation(url: string, action: string, extra: Record<string, unknown> = {}) {
  const body = JSON.stringify({ action, expectedVersion: 1, ...extra });
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(body).length),
      origin: "https://bea.example",
    },
    body,
  });
}

describe("Phase 3.3A proposal HTTP authorization", () => {
  const createProposalFromLead = vi.fn();
  const updateDraft = vi.fn();
  const submitForReview = vi.fn();
  const reviewProposal = vi.fn();
  const generateDeliveryManifest = vi.fn();
  const inspectProposal = vi.fn();
  const updateCatalogDraft = vi.fn();
  const listProposals = vi.fn();
  const metrics = vi.fn();
  const processPendingEvents = vi.fn();
  const listWorkItems = vi.fn();
  const listAudit = vi.fn();
  const listStatusEvents = vi.fn();
  const record = vi.fn();
  const decideOverride = vi.fn();

  function runtimeFor(userId: string) {
    return {
      environment: { appMode: "demo", appBaseUrl: "https://bea.example" },
      authorization: {
        authorizeUser: async (_id: string, permission: string) => {
          if (userId === OWNER) return { allowed: true };
          if (userId === SALES) {
            return {
              allowed: [
                PERMISSIONS.PROPOSALS_VIEW,
                PERMISSIONS.PROPOSALS_CREATE,
                PERMISSIONS.PROPOSALS_EDIT,
                PERMISSIONS.PROPOSALS_SUBMIT,
                PERMISSIONS.PROPOSALS_OVERRIDE_REQUEST,
                PERMISSIONS.PROPOSALS_DELIVERY_PLAN,
                PERMISSIONS.PROPOSALS_WORK_VIEW,
                PERMISSIONS.PROPOSALS_WORK_CLAIM,
              ].includes(permission as (typeof PERMISSIONS)[keyof typeof PERMISSIONS]),
            };
          }
          if (userId === INTEGRATION) {
            return {
              allowed: [
                PERMISSIONS.PROPOSALS_VIEW,
                PERMISSIONS.SERVICE_CATALOG_VIEW,
                PERMISSIONS.SERVICE_CATALOG_MANAGE,
                PERMISSIONS.COMMERCIAL_POLICY_VIEW,
                PERMISSIONS.COMMERCIAL_POLICY_MANAGE,
              ].includes(permission as (typeof PERMISSIONS)[keyof typeof PERMISSIONS]),
            };
          }
          if (userId === EXECUTIVE || userId === OPERATIONS) {
            return { allowed: permission === PERMISSIONS.PROPOSALS_VIEW };
          }
          return { allowed: false, reason: "permission-not-granted" };
        },
      },
      repository: {
        record,
        findActiveUserById: async (id: string) => ({ id, roleIds: [] }),
      },
      workControl: {
        processPendingEvents,
        repository: { listWorkItems },
      },
      commercial: {
        createProposalFromLead,
        updateDraft,
        submitForReview,
        reviewProposal,
        generateDeliveryManifest,
        inspectProposal,
        updateCatalogDraft,
        decideOverride,
        repository: { listProposals, metrics, listAudit, listStatusEvents },
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    listProposals.mockResolvedValue([]);
    metrics.mockResolvedValue({ total: 0, readyForDelivery: 0, byStatus: {}, synthetic: true });
    inspectProposal.mockResolvedValue({
      record: { proposal: { id: "p1" }, versions: [], lines: [], overrides: [], manifests: [] },
      readiness: { readyForReview: false, blocking: [], warnings: [], items: [] },
      pricing: { totalMinor: 0, currency: "USD" },
    });
    listWorkItems.mockResolvedValue([]);
    listAudit.mockResolvedValue([]);
    listStatusEvents.mockResolvedValue([]);
    createProposalFromLead.mockResolvedValue({
      record: { proposal: { id: "p1" } },
      alreadyExisted: false,
    });
    reviewProposal.mockResolvedValue({ proposal: { id: "p1", status: "approved" } });
    generateDeliveryManifest.mockResolvedValue({ proposal: { id: "p1" } });
    decideOverride.mockResolvedValue({ proposal: { id: "p1" } });
  });

  it("returns 401 without a session", async () => {
    mocks.getServerRuntime.mockResolvedValue(runtimeFor(SALES));
    mocks.requestSession.mockResolvedValue(null);
    const response = await proposalsGet(
      new Request("https://bea.example/api/proposals") as Parameters<typeof proposalsGet>[0],
    );
    expect(response.status).toBe(401);
  });

  it("returns 403 when Sales approves", async () => {
    mocks.getServerRuntime.mockResolvedValue(runtimeFor(SALES));
    mocks.requestSession.mockResolvedValue(sessionFor(SALES, DEMO_ROLE_IDS.SALES));
    const response = await proposalPost(
      mutation("https://bea.example/api/proposals/p1", "review", {
        decision: "approve",
        proposalVersionId: "v1",
      }) as Parameters<typeof proposalPost>[0],
      { params: Promise.resolve({ id: "p1" }) },
    );
    expect(response.status).toBe(403);
    expect(reviewProposal).not.toHaveBeenCalled();
  });

  it("returns 403 when Integration Administrator approves", async () => {
    mocks.getServerRuntime.mockResolvedValue(runtimeFor(INTEGRATION));
    mocks.requestSession.mockResolvedValue(
      sessionFor(INTEGRATION, DEMO_ROLE_IDS.INTEGRATION_ADMIN),
    );
    const response = await proposalPost(
      mutation("https://bea.example/api/proposals/p1", "review", {
        decision: "approve",
        proposalVersionId: "v1",
      }) as Parameters<typeof proposalPost>[0],
      { params: Promise.resolve({ id: "p1" }) },
    );
    expect(response.status).toBe(403);
  });

  it("returns 403 when Executive mutates", async () => {
    mocks.getServerRuntime.mockResolvedValue(runtimeFor(EXECUTIVE));
    mocks.requestSession.mockResolvedValue(sessionFor(EXECUTIVE, DEMO_ROLE_IDS.EXECUTIVE_READONLY));
    const response = await proposalPost(
      mutation("https://bea.example/api/proposals/p1", "update-draft", {
        scopeText: "nope",
      }) as Parameters<typeof proposalPost>[0],
      { params: Promise.resolve({ id: "p1" }) },
    );
    expect(response.status).toBe(403);
    expect(updateDraft).not.toHaveBeenCalled();
  });

  it("returns 400 for unknown actions", async () => {
    mocks.getServerRuntime.mockResolvedValue(runtimeFor(OWNER));
    mocks.requestSession.mockResolvedValue(sessionFor(OWNER, DEMO_ROLE_IDS.OWNER_ADMIN));
    const response = await proposalPost(
      mutation("https://bea.example/api/proposals/p1", "send-email") as Parameters<
        typeof proposalPost
      >[0],
      { params: Promise.resolve({ id: "p1" }) },
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("unknown-action");
  });

  it("returns no-send disclosure on delivery dry-run", async () => {
    mocks.getServerRuntime.mockResolvedValue(runtimeFor(OWNER));
    mocks.requestSession.mockResolvedValue(sessionFor(OWNER, DEMO_ROLE_IDS.OWNER_ADMIN));
    const response = await proposalPost(
      mutation("https://bea.example/api/proposals/p1", "delivery-manifest", {
        proposalVersionId: "v1",
      }) as Parameters<typeof proposalPost>[0],
      { params: Promise.resolve({ id: "p1" }) },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      liveWrites?: boolean;
      noSendDisclosure?: string;
    };
    expect(body.liveWrites).toBe(false);
    expect(body.noSendDisclosure).toBe(PROPOSAL_EMAIL_DRY_RUN_DISCLOSURE);
  });

  it("lets Sales create from a lead", async () => {
    mocks.getServerRuntime.mockResolvedValue(runtimeFor(SALES));
    mocks.requestSession.mockResolvedValue(sessionFor(SALES, DEMO_ROLE_IDS.SALES));
    const response = await proposalsPost(
      mutation("https://bea.example/api/proposals", "create-from-lead", {
        leadId: "lead-1",
      }) as Parameters<typeof proposalsPost>[0],
    );
    expect(response.status).toBe(200);
    expect(createProposalFromLead).toHaveBeenCalled();
  });

  it("includes no-send disclosure on proposal detail", async () => {
    mocks.getServerRuntime.mockResolvedValue(runtimeFor(SALES));
    mocks.requestSession.mockResolvedValue(sessionFor(SALES, DEMO_ROLE_IDS.SALES));
    const response = await proposalGet(
      new Request("https://bea.example/api/proposals/p1") as Parameters<typeof proposalGet>[0],
      { params: Promise.resolve({ id: "p1" }) },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { noSendDisclosure?: string };
    expect(body.noSendDisclosure).toBe(PROPOSAL_EMAIL_DRY_RUN_DISCLOSURE);
  });

  it("returns 403 when Integration Administrator publishes a catalog", async () => {
    mocks.getServerRuntime.mockResolvedValue(runtimeFor(INTEGRATION));
    mocks.requestSession.mockResolvedValue(
      sessionFor(INTEGRATION, DEMO_ROLE_IDS.INTEGRATION_ADMIN),
    );
    const response = await catalogPost(
      mutation("https://bea.example/api/catalog", "publish", {
        catalogVersionId: "cat-1",
      }) as Parameters<typeof catalogPost>[0],
    );
    expect(response.status).toBe(403);
  });

  it("returns 400 for a malformed catalog package before persistence", async () => {
    mocks.getServerRuntime.mockResolvedValue(runtimeFor(OWNER));
    mocks.requestSession.mockResolvedValue(sessionFor(OWNER, DEMO_ROLE_IDS.OWNER_ADMIN));
    updateCatalogDraft.mockRejectedValue(
      new CommercialCatalogValidationError([
        {
          code: "items",
          message: "Catalog items must be an array.",
          blocking: true,
          path: "items",
        },
      ]),
    );
    const response = await catalogPost(
      mutation("https://bea.example/api/catalog", "update-package", {
        catalogVersionId: "cat-1",
        pack: { catalogKey: "synthetic-envelope-advisory", items: "not-an-array" },
      }) as Parameters<typeof catalogPost>[0],
    );
    expect(response.status).toBe(400);
    expect(updateCatalogDraft).toHaveBeenCalled();
  });

  it("lets Sales generate a no-send delivery manifest", async () => {
    mocks.getServerRuntime.mockResolvedValue(runtimeFor(SALES));
    mocks.requestSession.mockResolvedValue(sessionFor(SALES, DEMO_ROLE_IDS.SALES));
    const response = await proposalPost(
      mutation("https://bea.example/api/proposals/p1", "delivery-manifest", {
        proposalVersionId: "v1",
      }) as Parameters<typeof proposalPost>[0],
      { params: Promise.resolve({ id: "p1" }) },
    );
    expect(response.status).toBe(200);
    expect(generateDeliveryManifest).toHaveBeenCalled();
  });

  it("returns 403 when Sales decides an override", async () => {
    mocks.getServerRuntime.mockResolvedValue(runtimeFor(SALES));
    mocks.requestSession.mockResolvedValue(sessionFor(SALES, DEMO_ROLE_IDS.SALES));
    const response = await proposalPost(
      mutation("https://bea.example/api/proposals/p1", "decide-override", {
        overrideId: "ovr-1",
        approve: true,
      }) as Parameters<typeof proposalPost>[0],
      { params: Promise.resolve({ id: "p1" }) },
    );
    expect(response.status).toBe(403);
    expect(decideOverride).not.toHaveBeenCalled();
  });

  it("returns 403 when Operations decides an override", async () => {
    mocks.getServerRuntime.mockResolvedValue(runtimeFor(OPERATIONS));
    mocks.requestSession.mockResolvedValue(sessionFor(OPERATIONS, DEMO_ROLE_IDS.OPERATIONS));
    const response = await proposalPost(
      mutation("https://bea.example/api/proposals/p1", "decide-override", {
        overrideId: "ovr-1",
        approve: true,
      }) as Parameters<typeof proposalPost>[0],
      { params: Promise.resolve({ id: "p1" }) },
    );
    expect(response.status).toBe(403);
    expect(decideOverride).not.toHaveBeenCalled();
  });

  it("returns 403 when Integration Administrator decides an override", async () => {
    mocks.getServerRuntime.mockResolvedValue(runtimeFor(INTEGRATION));
    mocks.requestSession.mockResolvedValue(
      sessionFor(INTEGRATION, DEMO_ROLE_IDS.INTEGRATION_ADMIN),
    );
    const response = await proposalPost(
      mutation("https://bea.example/api/proposals/p1", "decide-override", {
        overrideId: "ovr-1",
        approve: true,
      }) as Parameters<typeof proposalPost>[0],
      { params: Promise.resolve({ id: "p1" }) },
    );
    expect(response.status).toBe(403);
    expect(decideOverride).not.toHaveBeenCalled();
  });

  it("returns 403 when Executive Read-only decides an override", async () => {
    mocks.getServerRuntime.mockResolvedValue(runtimeFor(EXECUTIVE));
    mocks.requestSession.mockResolvedValue(sessionFor(EXECUTIVE, DEMO_ROLE_IDS.EXECUTIVE_READONLY));
    const response = await proposalPost(
      mutation("https://bea.example/api/proposals/p1", "decide-override", {
        overrideId: "ovr-1",
        approve: true,
      }) as Parameters<typeof proposalPost>[0],
      { params: Promise.resolve({ id: "p1" }) },
    );
    expect(response.status).toBe(403);
    expect(decideOverride).not.toHaveBeenCalled();
  });

  it("lets Owner decide an override after the HTTP permission check", async () => {
    mocks.getServerRuntime.mockResolvedValue(runtimeFor(OWNER));
    mocks.requestSession.mockResolvedValue(sessionFor(OWNER, DEMO_ROLE_IDS.OWNER_ADMIN));
    const response = await proposalPost(
      mutation("https://bea.example/api/proposals/p1", "decide-override", {
        overrideId: "ovr-1",
        approve: true,
      }) as Parameters<typeof proposalPost>[0],
      { params: Promise.resolve({ id: "p1" }) },
    );
    expect(response.status).toBe(200);
    expect(decideOverride).toHaveBeenCalled();
  });

  it("returns 403 for a cross-origin decide-override request", async () => {
    mocks.getServerRuntime.mockResolvedValue(runtimeFor(OWNER));
    mocks.requestSession.mockResolvedValue(sessionFor(OWNER, DEMO_ROLE_IDS.OWNER_ADMIN));
    const body = JSON.stringify({
      action: "decide-override",
      expectedVersion: 1,
      overrideId: "ovr-1",
      approve: true,
    });
    const response = await proposalPost(
      new Request("https://bea.example/api/proposals/p1", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(new TextEncoder().encode(body).length),
          origin: "https://evil.example",
        },
        body,
      }) as Parameters<typeof proposalPost>[0],
      { params: Promise.resolve({ id: "p1" }) },
    );
    expect(response.status).toBe(403);
    const payload = (await response.json()) as { error?: { code?: string } };
    expect(payload.error?.code).toBe("cross-origin-request-rejected");
    expect(decideOverride).not.toHaveBeenCalled();
  });

  it("returns a controlled 404 for an unknown override", async () => {
    mocks.getServerRuntime.mockResolvedValue(runtimeFor(OWNER));
    mocks.requestSession.mockResolvedValue(sessionFor(OWNER, DEMO_ROLE_IDS.OWNER_ADMIN));
    decideOverride.mockRejectedValueOnce(
      new CommercialNotFoundError("Pricing override was not found."),
    );
    const response = await proposalPost(
      mutation("https://bea.example/api/proposals/p1", "decide-override", {
        overrideId: "missing",
        approve: true,
      }) as Parameters<typeof proposalPost>[0],
      { params: Promise.resolve({ id: "p1" }) },
    );
    expect(response.status).toBe(404);
    const payload = (await response.json()) as { error?: { code?: string } };
    expect(payload.error?.code).toBe("proposal-not-found");
  });

  it("returns a controlled 409 for a stale proposal expectedVersion", async () => {
    mocks.getServerRuntime.mockResolvedValue(runtimeFor(OWNER));
    mocks.requestSession.mockResolvedValue(sessionFor(OWNER, DEMO_ROLE_IDS.OWNER_ADMIN));
    decideOverride.mockRejectedValueOnce(new CommercialConcurrencyError());
    const response = await proposalPost(
      mutation("https://bea.example/api/proposals/p1", "decide-override", {
        overrideId: "ovr-1",
        approve: true,
      }) as Parameters<typeof proposalPost>[0],
      { params: Promise.resolve({ id: "p1" }) },
    );
    expect(response.status).toBe(409);
    const payload = (await response.json()) as { error?: { code?: string } };
    expect(payload.error?.code).toBe("proposal-conflict");
  });
});
