import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_AI_PROVIDER_SETTINGS } from "../../packages/database/src/index";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const mocks = vi.hoisted(() => ({ requireAiApiContext: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/ai-command-api", () => ({
  requireAiApiContext: mocks.requireAiApiContext,
}));

import { POST as activateOpenAi } from "../../apps/web/app/api/integrations/ai/activate/route";
import {
  GET as getOpenAiModels,
  POST as refreshOpenAiModels,
} from "../../apps/web/app/api/integrations/ai/models/route";
import { POST as testOpenAiRoute } from "../../apps/web/app/api/integrations/ai/routes/test/route";
import {
  DELETE as deleteOpenAiSecret,
  PUT as putOpenAiSecret,
} from "../../apps/web/app/api/integrations/ai/secret/route";
import {
  GET as getOpenAiSettings,
  PUT as putOpenAiSettings,
} from "../../apps/web/app/api/integrations/ai/settings/route";
import { POST as testOpenAiConnection } from "../../apps/web/app/api/integrations/ai/test/route";

const phase133PresentationEnvironment = {
  NODE_ENV: "test",
  APP_MODE: "demo",
  BEA_RUNTIME_MODE: "",
  APP_BASE_URL: "http://127.0.0.1:3132",
  BEA_DISABLE_ENV_FILE: "true",
  DATABASE_DRIVER: "pglite",
  DEMO_AUTH_ENABLED: "true",
  DEMO_DATABASE_PATH: "memory://",
  WORKER_QUEUE_ADAPTER: "inline",
  OPENAI_API_KEY: "",
  BEA_PHASE133_PRESENTATION_TEST_MODE: "true",
  BEA_PHASE133_PRESENTATION_TEST_AUTHORITY: "phase1-3-3-production-presentation",
} as const;

function enablePhase133PresentationEnvironment(): void {
  for (const [key, value] of Object.entries(phase133PresentationEnvironment)) {
    vi.stubEnv(key, value);
  }
}

function jsonMutation(url: string, method: "POST" | "PUT", value: object): Request {
  const body = JSON.stringify(value);
  return new Request(url, {
    method,
    headers: {
      "Content-Length": String(new TextEncoder().encode(body).length),
      "Content-Type": "application/json",
    },
    body,
  });
}

function runtimeWithCanonicalCredential() {
  const describeOpenAiApiKey = vi.fn(() => ({
    status: "configured" as const,
    source: "windows_protected" as const,
    fingerprint: "sha256:canonical-protected-evidence",
    protectedStorageAvailable: true,
  }));
  const secretStatus = vi.fn(() => ({
    openAiApiKey: "configured" as const,
    windowsProtectedStorageAvailable: true,
  }));
  const storeOpenAiApiKey = vi.fn();
  const deleteProtectedOpenAiApiKey = vi.fn();
  const createOpenAiProvider = vi.fn();
  const settingsSet = vi.fn();
  const auditRecord = vi.fn();
  const settings = {
    ...DEFAULT_AI_PROVIDER_SETTINGS,
    mode: "openai" as const,
    defaultTextModel: "gpt-canonical-presentation",
    defaultRealtimeModel: "gpt-canonical-presentation",
  };
  const connectionTest = {
    id: "90000000-0000-4000-8000-000000000001",
    provider: "openai" as const,
    actorUserId: USER_ID,
    outcome: "succeeded" as const,
    authenticated: true,
    safeFailureCode: null,
    safeMessage: "Authenticated canonical evidence.",
    modelCount: 1,
    latencyMs: 20,
    credentialFingerprint: "sha256:canonical-protected-evidence",
    correlationId: "canonical-evidence",
    testedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
  };
  const persistence = {
    getProviderSettings: vi.fn(async () => settings),
    getProviderSettingsSnapshot: vi.fn(async () => ({ settings, version: 1 })),
    latestConnectionTest: vi.fn(async () => connectionTest),
    latestConnectionTestByOutcome: vi.fn(async (_provider: string, outcome: string) =>
      outcome === "succeeded" ? connectionTest : null,
    ),
    listCachedModels: vi.fn(async () => [
      {
        provider: "openai",
        modelId: "gpt-canonical-presentation",
        available: true,
        ownedBy: "openai",
        capabilities: {},
        capabilitySource: "provider",
      },
    ]),
    getUserVoicePreference: vi.fn(async () => null),
    recordConnectionTest: vi.fn(),
    replaceModelCache: vi.fn(),
    activateOpenAiAtomically: vi.fn(),
    activateDemo: vi.fn(),
  };
  const listIntegrationConnections = vi.fn(async () => [
    {
      providerType: "ai",
      mode: "live",
      connectionStatus: "connected",
      requirementStatus: "CONNECTED",
      mockMode: false,
    },
  ]);
  const runtime = {
    environment: { appMode: "demo", runtimeMode: "test" },
    ai: {
      persistence,
      secrets: {
        status: secretStatus,
        describeOpenAiApiKey,
        storeOpenAiApiKey,
        deleteProtectedOpenAiApiKey,
      },
      createOpenAiProvider,
      registry: {
        has: vi.fn(() => true),
        active: vi.fn(() => ({
          providerKey: "openai",
          identity: { model: "gpt-canonical-presentation" },
        })),
      },
    },
    settings: { set: settingsSet },
    repository: { listIntegrationConnections, record: auditRecord },
  };
  return {
    runtime,
    persistence,
    describeOpenAiApiKey,
    secretStatus,
    storeOpenAiApiKey,
    deleteProtectedOpenAiApiKey,
    createOpenAiProvider,
    settingsSet,
    auditRecord,
  };
}

describe.sequential("Phase 1.3.3 production-presentation HTTP boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enablePhase133PresentationEnvironment();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("sanitizes settings status and never resolves the canonical DPAPI credential", async () => {
    const fixture = runtimeWithCanonicalCredential();
    mocks.requireAiApiContext.mockResolvedValue({
      ok: true,
      runtime: fixture.runtime,
      userId: USER_ID,
      correlationId: "presentation-status",
    });

    const response = await getOpenAiSettings(
      new Request("http://127.0.0.1:3132/api/integrations/ai/settings") as never,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      apiKeyStatus: "not_configured",
      apiKeySource: "none",
      apiKeyFingerprint: null,
      connectionStatus: "not_configured",
      liveConnected: false,
      providerStatus: "SETUP_REQUIRED",
      lastTest: null,
      cachedModels: [],
    });
    expect(fixture.describeOpenAiApiKey).not.toHaveBeenCalled();
    expect(fixture.secretStatus).not.toHaveBeenCalled();
    expect(fixture.createOpenAiProvider).not.toHaveBeenCalled();

    const models = await getOpenAiModels(
      new Request("http://127.0.0.1:3132/api/integrations/ai/models") as never,
    );
    expect(models.status).toBe(200);
    expect(fixture.describeOpenAiApiKey).not.toHaveBeenCalled();
  });

  it("denies every valid mutation test refresh activation and route-test request before side effects", async () => {
    const fixture = runtimeWithCanonicalCredential();
    mocks.requireAiApiContext.mockResolvedValue({
      ok: true,
      runtime: fixture.runtime,
      userId: USER_ID,
      correlationId: "presentation-denial",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const requests = [
      () =>
        putOpenAiSecret(
          jsonMutation("http://127.0.0.1:3132/api/integrations/ai/secret", "PUT", {
            apiKey: "presentation-test-value-never-stored",
          }) as never,
        ),
      () =>
        deleteOpenAiSecret(
          new Request("http://127.0.0.1:3132/api/integrations/ai/secret", {
            method: "DELETE",
          }) as never,
        ),
      () =>
        testOpenAiConnection(
          new Request("http://127.0.0.1:3132/api/integrations/ai/test", {
            method: "POST",
          }) as never,
        ),
      () =>
        refreshOpenAiModels(
          new Request("http://127.0.0.1:3132/api/integrations/ai/models", {
            method: "POST",
          }) as never,
        ),
      () =>
        putOpenAiSettings(
          jsonMutation("http://127.0.0.1:3132/api/integrations/ai/settings", "PUT", {
            mode: "openai",
          }) as never,
        ),
      () =>
        activateOpenAi(
          new Request("http://127.0.0.1:3132/api/integrations/ai/activate", {
            method: "POST",
          }) as never,
        ),
      () =>
        testOpenAiRoute(
          jsonMutation("http://127.0.0.1:3132/api/integrations/ai/routes/test", "POST", {
            routeKey: "executive_conversation",
          }) as never,
        ),
    ];

    for (const invoke of requests) {
      const response = await invoke();
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "phase133-presentation-test-live-operation-blocked" },
      });
    }
    expect(fixture.describeOpenAiApiKey).not.toHaveBeenCalled();
    expect(fixture.secretStatus).not.toHaveBeenCalled();
    expect(fixture.storeOpenAiApiKey).not.toHaveBeenCalled();
    expect(fixture.deleteProtectedOpenAiApiKey).not.toHaveBeenCalled();
    expect(fixture.createOpenAiProvider).not.toHaveBeenCalled();
    expect(fixture.persistence.getProviderSettings).not.toHaveBeenCalled();
    expect(fixture.persistence.getProviderSettingsSnapshot).not.toHaveBeenCalled();
    expect(fixture.persistence.listCachedModels).not.toHaveBeenCalled();
    expect(fixture.persistence.recordConnectionTest).not.toHaveBeenCalled();
    expect(fixture.persistence.replaceModelCache).not.toHaveBeenCalled();
    expect(fixture.persistence.activateOpenAiAtomically).not.toHaveBeenCalled();
    expect(fixture.settingsSet).not.toHaveBeenCalled();
    expect(fixture.auditRecord).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
