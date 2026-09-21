import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEMO_PERSONAS, DEMO_ROLE_IDS } from "../../packages/domain/src/index.js";
import { PERMISSIONS } from "../../packages/security/src/index.js";

const OWNER = DEMO_PERSONAS[0].id;
const SALES = DEMO_PERSONAS[1].id;
const OPERATIONS = DEMO_PERSONAS[2].id;
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
  requestCorrelationId: () => "phase31a-http-auth",
  requestSession: mocks.requestSession,
  webRouteLogger: () => ({ error: mocks.loggerError, info: vi.fn() }),
}));

vi.mock("@/lib/diagnostics-authorization", () => ({
  canIncludeApiDiagnostics: vi.fn(async () => false),
}));

import {
  GET as configurationGet,
  POST as configurationPost,
} from "../../apps/web/app/api/configuration/route";

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

function configurationGetRequest(url: string) {
  const parsed = new URL(url);
  return {
    nextUrl: parsed,
    headers: new Headers({ origin: "https://bea.example" }),
    url,
  } as Parameters<typeof configurationGet>[0];
}

function mutation(action: string) {
  const body = JSON.stringify({ action, releaseId: "c1000000-0000-4000-8000-000000000001" });
  return new Request("https://bea.example/api/configuration", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(body).length),
      origin: "https://bea.example",
    },
    body,
  }) as Parameters<typeof configurationPost>[0];
}

describe("Phase 3.1A configuration mutation HTTP authorization", () => {
  const record = vi.fn();
  const activateRelease = vi.fn();
  const createDraft = vi.fn();
  const updateIntakeItem = vi.fn();
  const listStagingRuns = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    activateRelease.mockResolvedValue({ status: "active", synthetic: true });
    createDraft.mockResolvedValue({ id: "draft-1", synthetic: true });
    updateIntakeItem.mockResolvedValue({ id: "intake-1", status: "approved" });
    listStagingRuns.mockResolvedValue([
      {
        id: "stg-1",
        sourceType: "json",
        rawSourceText: "SECRET_RAW_SOURCE",
        rawRepresentation: { source: { secret: true } },
        rawSourceSha256: "abc",
        rawSourceByteLength: 12,
        status: "mapped",
        mappingReport: { canonical: { evidence: [{ sha256: "sig" }] } },
        validationPreview: { passed: true, blocking: [], warnings: [] },
        payloadSha256: "abc",
        sourceIdentity: "id",
        sourceSystemLabel: "lab",
        sourceSchemaVersion: "1",
        sourceTimestamp: null,
        inspectionId: null,
        sourceIdempotencyKey: null,
        lastError: null,
        finalizedAt: null,
        mappingProfileKey: "p",
        configurationReleaseId: "r",
        dryRun: true,
        committedSubmissionId: null,
        actorUserId: OWNER,
        classificationWarnings: [],
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: null,
      },
    ]);
    mocks.getServerRuntime.mockResolvedValue({
      environment: { appMode: "demo", appBaseUrl: "https://bea.example" },
      authorization: {
        authorizeUser: async (userId: string, permission: string) => {
          if (userId === OWNER) return { allowed: true };
          if (userId === INTEGRATION) {
            return {
              allowed: [
                PERMISSIONS.CONFIGURATION_VIEW,
                PERMISSIONS.CONFIGURATION_DRAFT,
                PERMISSIONS.CONFIGURATION_VALIDATE,
                PERMISSIONS.CONFIGURATION_MAPPING_EDIT,
                PERMISSIONS.CONFIGURATION_DRY_RUN,
              ].includes(permission as (typeof PERMISSIONS)[keyof typeof PERMISSIONS]),
            };
          }
          if (userId === OPERATIONS) {
            return {
              allowed: [PERMISSIONS.CONFIGURATION_VIEW, PERMISSIONS.CONFIGURATION_DRY_RUN].includes(
                permission as (typeof PERMISSIONS)[keyof typeof PERMISSIONS],
              ),
            };
          }
          return { allowed: false, reason: "permission-not-granted" };
        },
      },
      repository: { record },
      configuration: {
        activateRelease,
        createDraft,
        updateIntakeItem,
        repository: {
          listStagingRuns,
          getStagingRun: async () => listStagingRuns.mock.results[0]?.value?.[0],
        },
      },
    });
  });

  it("returns 401 when unauthenticated", async () => {
    mocks.requestSession.mockResolvedValue(undefined);
    const response = await configurationPost(mutation("activate"));
    expect(response.status).toBe(401);
  });

  it("returns 403 when sales tries to activate", async () => {
    mocks.requestSession.mockResolvedValue(sessionFor(SALES, DEMO_ROLE_IDS.SALES));
    const response = await configurationPost(mutation("activate"));
    expect(response.status).toBe(403);
    expect(activateRelease).not.toHaveBeenCalled();
  });

  it("returns 403 when integration administrator tries to activate", async () => {
    mocks.requestSession.mockResolvedValue(
      sessionFor(INTEGRATION, DEMO_ROLE_IDS.INTEGRATION_ADMIN),
    );
    const response = await configurationPost(mutation("activate"));
    expect(response.status).toBe(403);
    expect(activateRelease).not.toHaveBeenCalled();
  });

  it("returns 400 for unknown actions without fallthrough", async () => {
    mocks.requestSession.mockResolvedValue(sessionFor(OWNER, DEMO_ROLE_IDS.OWNER_ADMIN));
    const response = await configurationPost(mutation("delete-everything"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("unknown-configuration-action");
  });

  it("returns 403 when integration administrator confirms or approves intake policy", async () => {
    mocks.requestSession.mockResolvedValue(
      sessionFor(INTEGRATION, DEMO_ROLE_IDS.INTEGRATION_ADMIN),
    );
    const body = JSON.stringify({
      action: "update-intake",
      itemId: "intake-1",
      status: "approved",
      expectedVersion: 1,
    });
    const request = new Request("https://bea.example/api/configuration", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(new TextEncoder().encode(body).length),
        origin: "https://bea.example",
      },
      body,
    }) as Parameters<typeof configurationPost>[0];
    const response = await configurationPost(request);
    expect(response.status).toBe(403);
    expect(updateIntakeItem).not.toHaveBeenCalled();
  });

  it("returns 403 when operations requests confirmed intake status", async () => {
    mocks.requestSession.mockResolvedValue(sessionFor(OPERATIONS, DEMO_ROLE_IDS.OPERATIONS));
    const body = JSON.stringify({
      action: "update-intake",
      itemId: "intake-1",
      status: "confirmed",
      expectedVersion: 1,
    });
    const request = new Request("https://bea.example/api/configuration", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(new TextEncoder().encode(body).length),
        origin: "https://bea.example",
      },
      body,
    }) as Parameters<typeof configurationPost>[0];
    const response = await configurationPost(request);
    expect(response.status).toBe(403);
  });

  it("projects staging metadata for operations and raw source for mapping administrators", async () => {
    mocks.requestSession.mockResolvedValue(sessionFor(OPERATIONS, DEMO_ROLE_IDS.OPERATIONS));
    const opsRequest = configurationGetRequest(
      "https://bea.example/api/configuration?view=staging",
    );
    const opsResponse = await configurationGet(opsRequest);
    expect(opsResponse.status).toBe(200);
    const opsBody = (await opsResponse.json()) as {
      staging?: Array<{ rawSourceText?: string | null }>;
    };
    expect(opsBody.staging?.[0]?.rawSourceText).toBeNull();
    mocks.requestSession.mockResolvedValue(
      sessionFor(INTEGRATION, DEMO_ROLE_IDS.INTEGRATION_ADMIN),
    );
    const adminResponse = await configurationGet(
      configurationGetRequest("https://bea.example/api/configuration?view=staging"),
    );
    const adminBody = (await adminResponse.json()) as {
      staging?: Array<{ rawSourceText?: string | null }>;
    };
    expect(adminBody.staging?.[0]?.rawSourceText).toBe("SECRET_RAW_SOURCE");
    mocks.requestSession.mockResolvedValue(sessionFor(SALES, DEMO_ROLE_IDS.SALES));
    const salesResponse = await configurationGet(
      configurationGetRequest("https://bea.example/api/configuration?view=staging"),
    );
    expect(salesResponse.status).toBe(403);
  });

  it("returns 413 when the configuration mutation exceeds the source-text envelope", async () => {
    mocks.requestSession.mockResolvedValue(sessionFor(OWNER, DEMO_ROLE_IDS.OWNER_ADMIN));
    const body = JSON.stringify({ action: "dry-run-mapping", raw: "x" });
    const request = new Request("https://bea.example/api/configuration", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(700_000),
        origin: "https://bea.example",
      },
      body,
    }) as Parameters<typeof configurationPost>[0];
    const response = await configurationPost(request);
    expect(response.status).toBe(413);
  });
});
