import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AiProviderRegistry,
  DemoStreamingAiProvider,
  UNKNOWN_MODEL_CAPABILITIES,
  type AiCommandProvider,
} from "../../packages/ai/src/index.js";
import {
  connectionEvidenceMatchesCredential,
  DEFAULT_AI_PROVIDER_SETTINGS,
  type BeaServerRuntime,
  type RecordConnectionTestInput,
} from "../../packages/database/src/index.js";
import {
  activateOpenAiProvider,
  authorizeLiveOwnerTools,
  authorizeLiveRealtimeOwner,
  configureOpenAiSecret,
  disconnectOpenAi,
  isDeterministicDemoAiCommandAllowed,
  mergeModelCapabilityEvidence,
  parseAiProviderSettings,
  readOpenAiAdministration,
  refreshOpenAiModels,
  requireLiveOwnerAuthorization,
  resolveAiCommandProvider,
  testOpenAiConnection,
  updateAiProviderSettings,
} from "../../apps/web/lib/openai-administration.js";
import { getAiIntegrationHealthWithRuntime } from "../../apps/web/lib/integrations.js";

vi.mock("server-only", () => ({}));

function provider(model: string): AiCommandProvider {
  return {
    providerKey: "openai",
    identity: {
      provider: "openai",
      displayName: "OpenAI",
      model,
      mode: "live",
      requirementStatus: "CONNECTED",
    },
  } as AiCommandProvider;
}

function modelRecord(modelId: string, capabilities = UNKNOWN_MODEL_CAPABILITIES) {
  return {
    id: `cache-${modelId}`,
    provider: "openai" as const,
    modelId,
    available: true,
    ownedBy: "openai",
    capabilities,
    capabilitySource: "unknown" as const,
    fetchedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
  };
}

function discoveredModel(modelId: string) {
  return {
    id: modelId,
    provider: "openai",
    displayName: modelId,
    available: true,
    ownedBy: "openai",
    capabilities: UNKNOWN_MODEL_CAPABILITIES,
    capabilitySource: "provider" as const,
  };
}

function runtimeFixture(input: {
  readonly mode?: "demo" | "openai" | "hybrid";
  readonly models: readonly ReturnType<typeof modelRecord>[];
  readonly createProvider?: (model: string) => Promise<AiCommandProvider>;
  readonly overrides?: Record<string, unknown>;
  readonly persistedActive?: boolean;
  readonly appMode?: "demo" | "production";
  readonly secretFingerprint?: string | null;
  readonly evidenceFingerprint?: string | null;
  readonly latestFailureCode?: "OPENAI_KEY_REPLACED" | "OPENAI_DISCONNECTED";
}) {
  const appMode = input.appMode ?? "demo";
  const secretFingerprint =
    input.secretFingerprint === undefined ? "sha256:000000000001" : input.secretFingerprint;
  const evidenceFingerprint =
    input.evidenceFingerprint === undefined ? secretFingerprint : input.evidenceFingerprint;
  const selected = input.models[0]?.modelId ?? "gpt-selected";
  const settings = {
    ...DEFAULT_AI_PROVIDER_SETTINGS,
    mode: input.mode ?? "demo",
    defaultTextModel: selected,
    defaultRealtimeModel: selected,
    modelCapabilityOverrides: input.overrides ?? {},
  };
  const registry = new AiProviderRegistry(new DemoStreamingAiProvider());
  const replaceModelCache = vi.fn(async () => undefined);
  const recordConnectionTest = vi.fn(async (record: RecordConnectionTestInput) => ({
    id: "90000000-0000-4000-8000-000000000002",
    provider: "openai" as const,
    actorUserId: "10000000-0000-4000-8000-000000000001",
    outcome: record.outcome,
    authenticated: record.authenticated,
    safeFailureCode: record.safeFailureCode ?? null,
    safeMessage: record.safeMessage,
    modelCount: record.modelCount ?? null,
    latencyMs: record.latencyMs ?? null,
    credentialFingerprint: record.credentialFingerprint ?? null,
    correlationId: record.correlationId,
    testedAt: record.testedAt ?? new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
  }));
  const latestTest = {
    id: "90000000-0000-4000-8000-000000000001",
    provider: "openai" as const,
    actorUserId: "10000000-0000-4000-8000-000000000001",
    outcome: input.latestFailureCode ? ("failed" as const) : ("succeeded" as const),
    authenticated: !input.latestFailureCode,
    safeFailureCode: input.latestFailureCode ?? null,
    safeMessage: input.latestFailureCode
      ? "Administrative invalidation fixture."
      : "Authenticated fixture.",
    modelCount: input.models.length,
    latencyMs: 24,
    credentialFingerprint: evidenceFingerprint,
    correlationId: "connection-fixture",
    testedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
  };
  const persistence = {
    getProviderSettings: vi.fn(async () => settings),
    getProviderSettingsSnapshot: vi.fn(async () => ({ settings, version: 7 })),
    latestConnectionTest: vi.fn(async () => latestTest),
    latestConnectionTestByOutcome: vi.fn(async (_provider, outcome) =>
      outcome === latestTest.outcome ? latestTest : null,
    ),
    listCachedModels: vi.fn(async () => input.models),
    replaceModelCache,
    recordConnectionTest,
    activateOpenAiAtomically: vi.fn(async () => true),
    activateDemo: vi.fn(async () => undefined),
  };
  const createOpenAiProvider = vi.fn(async (options: { defaultModel: string }) =>
    input.createProvider
      ? input.createProvider(options.defaultModel)
      : Promise.resolve(provider(options.defaultModel)),
  );
  const settingSet = vi.fn(async () => undefined);
  const secretStatus = vi.fn(() => ({
    openAiApiKey: secretFingerprint === null ? "not_configured" : "configured",
    windowsProtectedStorageAvailable: true,
  }));
  const describeOpenAiApiKey = vi.fn(() => ({
    status: secretFingerprint === null ? ("not_configured" as const) : ("configured" as const),
    source: secretFingerprint === null ? ("none" as const) : ("environment" as const),
    fingerprint: secretFingerprint,
    protectedStorageAvailable: true,
  }));
  const storeOpenAiApiKey = vi.fn(() => ({
    status: "configured" as const,
    source: "windows_protected" as const,
    fingerprint: "sha256:000000000002",
    protectedStorageAvailable: true,
  }));
  const deleteProtectedOpenAiApiKey = vi.fn(() => ({
    status: "not_configured" as const,
    source: "none" as const,
    fingerprint: null,
    protectedStorageAvailable: true,
  }));
  const auditRecord = vi.fn(async () => ({
    id: "70000000-0000-4000-8000-000000000001",
  }));
  const listIntegrationConnections = vi.fn(async () =>
    input.persistedActive
      ? [
          {
            providerType: "ai",
            mode: "live",
            connectionStatus: "connected",
            requirementStatus: "CONNECTED",
            mockMode: false,
          },
        ]
      : [],
  );
  const runtime = {
    environment: {
      appMode,
      runtimeMode: appMode === "production" ? "production" : "test",
    },
    ai: {
      registry,
      persistence,
      secrets: {
        status: secretStatus,
        describeOpenAiApiKey,
        storeOpenAiApiKey,
        deleteProtectedOpenAiApiKey,
      },
      createOpenAiProvider,
    },
    settings: { set: settingSet },
    repository: { record: auditRecord, listIntegrationConnections },
  } as unknown as BeaServerRuntime;
  return {
    runtime,
    registry,
    persistence,
    createOpenAiProvider,
    settingSet,
    auditRecord,
    listIntegrationConnections,
    replaceModelCache,
    recordConnectionTest,
    secretStatus,
    describeOpenAiApiKey,
    storeOpenAiApiKey,
    deleteProtectedOpenAiApiKey,
    settings,
  };
}

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

describe.sequential("deterministic Demo provider eligibility", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows deterministic AI Command only when Demo settings and the active provider agree", async () => {
    const fixture = runtimeFixture({ mode: "demo", models: [] });

    await expect(isDeterministicDemoAiCommandAllowed(fixture.runtime)).resolves.toBe(true);
    expect(fixture.persistence.getProviderSettings).toHaveBeenCalledTimes(1);
    expect(fixture.registry.active().providerKey).toBe("demo");
  });

  it.each(["openai", "hybrid"] as const)(
    "denies deterministic AI Command when persisted mode is %s",
    async (mode) => {
      const fixture = runtimeFixture({ mode, models: [modelRecord(`gpt-${mode}`)] });
      fixture.registry.register(provider(`gpt-${mode}`));
      fixture.registry.activate("openai");

      await expect(isDeterministicDemoAiCommandAllowed(fixture.runtime)).resolves.toBe(false);
      expect(fixture.registry.active().providerKey).toBe("openai");
    },
  );

  it("denies a stale active OpenAI provider even when persisted settings still say Demo", async () => {
    const fixture = runtimeFixture({ mode: "demo", models: [modelRecord("gpt-stale-active")] });
    fixture.registry.register(provider("gpt-stale-active"));
    fixture.registry.activate("openai");

    await expect(isDeterministicDemoAiCommandAllowed(fixture.runtime)).resolves.toBe(false);
  });

  it("short-circuits production before persistence or provider state is read", async () => {
    const fixture = runtimeFixture({ appMode: "production", mode: "demo", models: [] });
    const active = vi.spyOn(fixture.registry, "active");

    await expect(isDeterministicDemoAiCommandAllowed(fixture.runtime)).resolves.toBe(false);
    expect(fixture.persistence.getProviderSettings).not.toHaveBeenCalled();
    expect(active).not.toHaveBeenCalled();
  });

  it("short-circuits the exact production-presentation authority before server state is read", async () => {
    const fixture = runtimeFixture({ mode: "demo", models: [] });
    const active = vi.spyOn(fixture.registry, "active");
    enablePhase133PresentationEnvironment();

    await expect(isDeterministicDemoAiCommandAllowed(fixture.runtime)).resolves.toBe(false);
    expect(fixture.persistence.getProviderSettings).not.toHaveBeenCalled();
    expect(active).not.toHaveBeenCalled();
  });
});

describe.sequential("Phase 1.3.3 TEST-ONLY presentation server boundary", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a setup-required snapshot without resolving canonical protected-secret evidence", async () => {
    const fixture = runtimeFixture({
      appMode: "demo",
      mode: "openai",
      persistedActive: true,
      models: [modelRecord("gpt-presentation-canonical")],
    });
    fixture.registry.register(provider("gpt-presentation-canonical"));
    fixture.registry.activate("openai");
    enablePhase133PresentationEnvironment();

    await expect(readOpenAiAdministration(fixture.runtime)).resolves.toMatchObject({
      apiKeyStatus: "not_configured",
      apiKeySource: "none",
      apiKeyFingerprint: null,
      protectedStorageAvailable: false,
      connectionStatus: "not_configured",
      liveConnected: false,
      providerStatus: "SETUP_REQUIRED",
      lastTest: null,
      lastSuccessfulTest: null,
      lastFailedTest: null,
      cachedModels: [],
    });
    expect(fixture.secretStatus).not.toHaveBeenCalled();
    expect(fixture.describeOpenAiApiKey).not.toHaveBeenCalled();
    expect(fixture.createOpenAiProvider).not.toHaveBeenCalled();
  });

  it("denies every live administration path before secret provider audit or settings access", async () => {
    const fixture = runtimeFixture({
      appMode: "demo",
      mode: "openai",
      persistedActive: true,
      models: [modelRecord("gpt-presentation-blocked")],
    });
    enablePhase133PresentationEnvironment();
    const input = {
      runtime: fixture.runtime,
      actorUserId: "10000000-0000-4000-8000-000000000001",
      correlationId: "presentation-boundary",
    } as const;
    const operations = [
      () =>
        configureOpenAiSecret({
          ...input,
          apiKey: "presentation-test-value-never-stored",
        }),
      () => disconnectOpenAi(input),
      () => testOpenAiConnection(input),
      () => refreshOpenAiModels(input),
      () => updateAiProviderSettings({ ...input, value: { mode: "openai" } }),
      () => activateOpenAiProvider(input),
      () => resolveAiCommandProvider(fixture.runtime),
      () => authorizeLiveOwnerTools({ ...input, capabilities: ["input_file"] }),
      () => authorizeLiveRealtimeOwner(input),
    ];

    for (const operation of operations) {
      await expect(operation()).rejects.toMatchObject({
        code: "PHASE133_PRESENTATION_TEST_LIVE_OPERATION_BLOCKED",
        status: 409,
      });
    }
    expect(fixture.secretStatus).not.toHaveBeenCalled();
    expect(fixture.describeOpenAiApiKey).not.toHaveBeenCalled();
    expect(fixture.storeOpenAiApiKey).not.toHaveBeenCalled();
    expect(fixture.deleteProtectedOpenAiApiKey).not.toHaveBeenCalled();
    expect(fixture.createOpenAiProvider).not.toHaveBeenCalled();
    expect(fixture.persistence.getProviderSettings).not.toHaveBeenCalled();
    expect(fixture.persistence.getProviderSettingsSnapshot).not.toHaveBeenCalled();
    expect(fixture.persistence.listCachedModels).not.toHaveBeenCalled();
    expect(fixture.persistence.recordConnectionTest).not.toHaveBeenCalled();
    expect(fixture.persistence.activateOpenAiAtomically).not.toHaveBeenCalled();
    expect(fixture.settingSet).not.toHaveBeenCalled();
    expect(fixture.auditRecord).not.toHaveBeenCalled();
  });
});

describe("OpenAI administration capability evidence and activation", () => {
  it("records authenticated model discovery with latency and refreshes the bounded cache", async () => {
    const liveProvider = {
      ...provider("gpt-connected"),
      testConnection: vi.fn(async () => ({
        provider: "openai" as const,
        healthy: true,
        authenticated: true,
        testedAt: new Date().toISOString(),
        safeMessage: "OpenAI connection succeeded.",
      })),
      listModels: vi.fn(async () => [discoveredModel("gpt-connected")]),
    } as AiCommandProvider;
    const fixture = runtimeFixture({
      models: [modelRecord("gpt-connected")],
      createProvider: async () => liveProvider,
    });

    await testOpenAiConnection({
      runtime: fixture.runtime,
      actorUserId: "10000000-0000-4000-8000-000000000001",
      correlationId: "connection-success",
    });

    expect(fixture.recordConnectionTest).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "succeeded",
        authenticated: true,
        modelCount: 1,
        latencyMs: expect.any(Number),
        credentialFingerprint: "sha256:000000000001",
      }),
    );
    expect(fixture.replaceModelCache).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        models: [expect.objectContaining({ modelId: "gpt-connected", available: true })],
      }),
    );
  });

  it("fails closed when the credential rotates during an otherwise successful connection test", async () => {
    const liveProvider = {
      ...provider("gpt-rotated-during-test"),
      testConnection: vi.fn(async () => ({
        provider: "openai" as const,
        healthy: true,
        authenticated: true,
        testedAt: new Date().toISOString(),
        safeMessage: "OpenAI connection succeeded.",
      })),
      listModels: vi.fn(async () => [discoveredModel("gpt-rotated-during-test")]),
    } as AiCommandProvider;
    const fixture = runtimeFixture({
      models: [modelRecord("gpt-rotated-during-test")],
      createProvider: async () => liveProvider,
    });
    vi.spyOn(fixture.runtime.ai.secrets, "describeOpenAiApiKey")
      .mockReturnValueOnce({
        status: "configured",
        source: "environment",
        fingerprint: "sha256:000000000001",
        protectedStorageAvailable: true,
      })
      .mockReturnValueOnce({
        status: "configured",
        source: "environment",
        fingerprint: "sha256:000000000002",
        protectedStorageAvailable: true,
      });

    await testOpenAiConnection({
      runtime: fixture.runtime,
      actorUserId: "10000000-0000-4000-8000-000000000001",
      correlationId: "connection-credential-rotated",
    });

    expect(fixture.recordConnectionTest).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        authenticated: false,
        credentialFingerprint: null,
        safeMessage: expect.stringContaining("credential changed"),
      }),
    );
    expect(fixture.replaceModelCache).not.toHaveBeenCalled();
  });

  it("records a safe categorized connection failure without raw provider detail", async () => {
    const privateDetail = "phase13-private-provider-detail-0001";
    const liveProvider = {
      ...provider("gpt-auth-failure"),
      testConnection: vi.fn(async () => ({
        provider: "openai" as const,
        healthy: false,
        authenticated: false,
        testedAt: new Date().toISOString(),
        safeMessage: "OpenAI authentication failed.",
        rawDetail: privateDetail,
      })),
    } as AiCommandProvider;
    const fixture = runtimeFixture({
      models: [modelRecord("gpt-auth-failure")],
      createProvider: async () => liveProvider,
    });

    await testOpenAiConnection({
      runtime: fixture.runtime,
      actorUserId: "10000000-0000-4000-8000-000000000001",
      correlationId: "connection-auth-failure",
    });

    expect(fixture.recordConnectionTest).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        authenticated: false,
        safeFailureCode: "OPENAI_AUTHENTICATION_FAILED",
        safeMessage: "OpenAI authentication failed.",
        latencyMs: expect.any(Number),
      }),
    );
    expect(JSON.stringify(fixture.recordConnectionTest.mock.calls)).not.toContain(privateDetail);
    expect(fixture.replaceModelCache).not.toHaveBeenCalled();
  });

  it("invalidates activation when a protected key is replaced or disconnected", async () => {
    const fixture = runtimeFixture({
      mode: "hybrid",
      models: [modelRecord("gpt-secret-lifecycle")],
    });
    const secret = "phase13-backend-secret-value-0000001";

    await configureOpenAiSecret({
      runtime: fixture.runtime,
      actorUserId: "10000000-0000-4000-8000-000000000001",
      correlationId: "secret-replace",
      apiKey: secret,
    });
    expect(fixture.storeOpenAiApiKey).toHaveBeenCalledWith(secret);
    expect(fixture.settingSet).toHaveBeenCalledWith(
      expect.objectContaining({ value: expect.objectContaining({ mode: "demo" }) }),
    );
    expect(fixture.recordConnectionTest).toHaveBeenCalledWith(
      expect.objectContaining({
        safeFailureCode: "OPENAI_KEY_REPLACED",
        credentialFingerprint: "sha256:000000000002",
      }),
    );
    expect(JSON.stringify(fixture.auditRecord.mock.calls)).not.toContain(secret);

    await disconnectOpenAi({
      runtime: fixture.runtime,
      actorUserId: "10000000-0000-4000-8000-000000000001",
      correlationId: "secret-disconnect",
    });
    expect(fixture.deleteProtectedOpenAiApiKey).toHaveBeenCalledTimes(1);
    expect(fixture.recordConnectionTest).toHaveBeenCalledWith(
      expect.objectContaining({
        safeFailureCode: "OPENAI_DISCONNECTED",
        credentialFingerprint: null,
      }),
    );
  });

  it("leaves provider evidence and model cache unchanged when required audit persistence fails", async () => {
    const liveProvider = {
      ...provider("gpt-audited"),
      testConnection: vi.fn(async () => ({
        provider: "openai",
        healthy: true,
        authenticated: true,
        testedAt: new Date().toISOString(),
        safeMessage: "Authenticated.",
        modelCount: 1,
      })),
      listModels: vi.fn(async () => [discoveredModel("gpt-audited")]),
    } as AiCommandProvider;
    const fixture = runtimeFixture({
      models: [modelRecord("gpt-audited")],
      createProvider: async () => liveProvider,
    });
    fixture.auditRecord.mockRejectedValue(new Error("synthetic required audit failure"));

    await expect(
      testOpenAiConnection({
        runtime: fixture.runtime,
        actorUserId: "10000000-0000-4000-8000-000000000001",
        correlationId: "connection-audit-failure",
      }),
    ).rejects.toThrow("synthetic required audit failure");
    expect(fixture.replaceModelCache).not.toHaveBeenCalled();
    expect(fixture.recordConnectionTest).not.toHaveBeenCalled();

    await expect(
      refreshOpenAiModels({
        runtime: fixture.runtime,
        actorUserId: "10000000-0000-4000-8000-000000000001",
        correlationId: "model-refresh-audit-failure",
      }),
    ).rejects.toThrow("synthetic required audit failure");
    expect(fixture.replaceModelCache).not.toHaveBeenCalled();
  });

  it("blocks activation when required model capabilities remain unknown", async () => {
    const fixture = runtimeFixture({ models: [modelRecord("gpt-unknown")] });
    await expect(
      activateOpenAiProvider({
        runtime: fixture.runtime,
        actorUserId: "10000000-0000-4000-8000-000000000001",
        correlationId: "unknown-capabilities",
      }),
    ).rejects.toMatchObject({ code: "OPENAI_MODEL_INCOMPATIBLE" });
    expect(fixture.createOpenAiProvider).not.toHaveBeenCalled();
    expect(fixture.registry.active().providerKey).toBe("demo");
  });

  it("allows only an explicitly administrator-verified compatible cached model", async () => {
    const fixture = runtimeFixture({
      models: [modelRecord("gpt-verified")],
      overrides: {
        "gpt-verified": {
          responsesText: true,
          streaming: true,
          functionCalling: true,
          structuredOutputs: true,
        },
      },
    });
    await activateOpenAiProvider({
      runtime: fixture.runtime,
      actorUserId: "10000000-0000-4000-8000-000000000001",
      correlationId: "verified-capabilities",
    });
    expect(fixture.persistence.activateOpenAiAtomically).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ mode: "openai" }),
        credentialFingerprint: "sha256:000000000001",
        expectedSettingsVersion: 7,
        authorizationAuditId: "70000000-0000-4000-8000-000000000001",
      }),
    );
    expect(fixture.registry.active()).toMatchObject({
      providerKey: "openai",
      identity: { model: "gpt-verified" },
    });
    expect(fixture.settingSet).not.toHaveBeenCalled();
  });
});

describe("OpenAI administration model validation and provider replacement", () => {
  it.each(["demo", "hybrid"] as const)(
    "rejects production %s mode before provider, audit, or settings mutation",
    async (mode) => {
      const fixture = runtimeFixture({
        appMode: "production",
        mode: "openai",
        models: [modelRecord("gpt-production")],
      });
      fixture.registry.register(provider("gpt-production"));
      fixture.registry.activate("openai");

      await expect(
        updateAiProviderSettings({
          runtime: fixture.runtime,
          actorUserId: "10000000-0000-4000-8000-000000000001",
          correlationId: `production-${mode}-rejected`,
          value: { mode },
        }),
      ).rejects.toMatchObject({ code: "PRODUCTION_OPENAI_MODE_REQUIRED", status: 409 });

      expect(fixture.persistence.listCachedModels).not.toHaveBeenCalled();
      expect(fixture.createOpenAiProvider).not.toHaveBeenCalled();
      expect(fixture.auditRecord).not.toHaveBeenCalled();
      expect(fixture.settingSet).not.toHaveBeenCalled();
      expect(fixture.registry.active().identity.model).toBe("gpt-production");
    },
  );

  it("rejects capability verification for a model absent from refreshed cache", async () => {
    const fixture = runtimeFixture({ models: [modelRecord("gpt-cached")] });
    await expect(
      updateAiProviderSettings({
        runtime: fixture.runtime,
        actorUserId: "10000000-0000-4000-8000-000000000001",
        correlationId: "uncached-override",
        value: {
          modelCapabilityOverrides: { "gpt-not-cached": { streaming: true } },
        },
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_OVERRIDE_MODEL_UNVERIFIED" });
    expect(fixture.settingSet).not.toHaveBeenCalled();
  });

  it("rebuilds an active provider when selected model or verified overrides change", async () => {
    const oldModel = modelRecord("gpt-old");
    const newModel = modelRecord("gpt-new");
    const fixture = runtimeFixture({ mode: "openai", models: [oldModel, newModel] });
    fixture.registry.register(provider("gpt-old"));
    fixture.registry.activate("openai");
    const updated = await updateAiProviderSettings({
      runtime: fixture.runtime,
      actorUserId: "10000000-0000-4000-8000-000000000001",
      correlationId: "provider-replacement",
      value: {
        defaultTextModel: "gpt-new",
        defaultRealtimeModel: "gpt-new",
        modelCapabilityOverrides: {
          "gpt-new": {
            responsesText: true,
            streaming: true,
            functionCalling: true,
            structuredOutputs: true,
          },
        },
      },
    });
    expect(updated.defaultTextModel).toBe("gpt-new");
    expect(fixture.registry.active().identity.model).toBe("gpt-new");
    expect(fixture.createOpenAiProvider).toHaveBeenCalledWith(
      expect.objectContaining({ defaultModel: "gpt-new", connectionEvidenceVerified: true }),
    );
    expect(fixture.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "ai-provider.capabilities-attested" }),
    );
  });

  it("leaves current provider and settings unchanged when replacement construction fails", async () => {
    const fixture = runtimeFixture({
      mode: "openai",
      models: [modelRecord("gpt-old"), modelRecord("gpt-new")],
      createProvider: async () => {
        throw new Error("synthetic provider construction failure");
      },
    });
    fixture.registry.register(provider("gpt-old"));
    fixture.registry.activate("openai");
    await expect(
      updateAiProviderSettings({
        runtime: fixture.runtime,
        actorUserId: "10000000-0000-4000-8000-000000000001",
        correlationId: "provider-replacement-failure",
        value: { defaultTextModel: "gpt-new", defaultRealtimeModel: "gpt-new" },
      }),
    ).rejects.toThrow("synthetic provider construction failure");
    expect(fixture.settingSet).not.toHaveBeenCalled();
    expect(fixture.registry.active().identity.model).toBe("gpt-old");
  });

  it("leaves current provider and settings unchanged when capability audit persistence fails", async () => {
    const fixture = runtimeFixture({
      mode: "openai",
      models: [modelRecord("gpt-old"), modelRecord("gpt-new")],
    });
    fixture.registry.register(provider("gpt-old"));
    fixture.registry.activate("openai");
    fixture.auditRecord.mockRejectedValueOnce(new Error("synthetic capability audit failure"));

    await expect(
      updateAiProviderSettings({
        runtime: fixture.runtime,
        actorUserId: "10000000-0000-4000-8000-000000000001",
        correlationId: "capability-audit-failure",
        value: {
          defaultTextModel: "gpt-new",
          defaultRealtimeModel: "gpt-new",
          modelCapabilityOverrides: {
            "gpt-new": { responsesText: true },
          },
        },
      }),
    ).rejects.toThrow("synthetic capability audit failure");
    expect(fixture.settingSet).not.toHaveBeenCalled();
    expect(fixture.registry.active().identity.model).toBe("gpt-old");
  });

  it("rejects a live manual model selection absent from current refreshed cache", async () => {
    const fixture = runtimeFixture({ mode: "openai", models: [modelRecord("gpt-cached")] });
    await expect(
      updateAiProviderSettings({
        runtime: fixture.runtime,
        actorUserId: "10000000-0000-4000-8000-000000000001",
        correlationId: "manual-model-missing",
        value: { defaultTextModel: "gpt-manual-not-refreshed" },
      }),
    ).rejects.toMatchObject({ code: "OPENAI_MODEL_NOT_REFRESHED" });
  });
});

describe("OpenAI credential-bound evidence and truthful invalidation status", () => {
  it.each([
    {
      code: "OPENAI_KEY_REPLACED" as const,
      secretFingerprint: "sha256:000000000001",
      providerStatus: "CONFIGURED_NOT_TESTED",
      connectionStatus: "configured_not_tested",
    },
    {
      code: "OPENAI_DISCONNECTED" as const,
      secretFingerprint: null,
      providerStatus: "DISABLED",
      connectionStatus: "disabled",
    },
  ])("maps $code before generic failed-test status", async (expected) => {
    const fixture = runtimeFixture({
      appMode: "production",
      mode: "openai",
      models: [modelRecord("gpt-invalidation")],
      latestFailureCode: expected.code,
      secretFingerprint: expected.secretFingerprint,
    });

    await expect(readOpenAiAdministration(fixture.runtime)).resolves.toMatchObject({
      providerStatus: expected.providerStatus,
      connectionStatus: expected.connectionStatus,
      liveConnected: false,
      lastTest: { safeFailureCode: expected.code },
    });
  });

  it("does not label a tested but not yet activated provider as disabled", async () => {
    const fixture = runtimeFixture({
      appMode: "production",
      mode: "openai",
      persistedActive: false,
      models: [modelRecord("gpt-5.6-sol")],
    });
    await expect(readOpenAiAdministration(fixture.runtime)).resolves.toMatchObject({
      providerStatus: "CONFIGURED_NOT_TESTED",
      connectionStatus: "configured_not_tested",
      liveConnected: false,
    });
  });

  it("does not read a rotated credential as connected from stale successful evidence", async () => {
    const fixture = runtimeFixture({
      appMode: "production",
      mode: "openai",
      persistedActive: true,
      models: [modelRecord("gpt-rotated")],
      secretFingerprint: "sha256:000000000002",
      evidenceFingerprint: "sha256:000000000001",
    });
    fixture.registry.register(provider("gpt-rotated"));
    fixture.registry.activate("openai");

    await expect(readOpenAiAdministration(fixture.runtime)).resolves.toMatchObject({
      providerStatus: "CONFIGURED_NOT_TESTED",
      connectionStatus: "configured_not_tested",
      liveConnected: false,
    });
  });

  it("rejects activation and provider resolution when evidence belongs to another credential", async () => {
    const fixture = runtimeFixture({
      appMode: "production",
      mode: "openai",
      persistedActive: true,
      models: [modelRecord("gpt-stale-evidence")],
      overrides: {
        "gpt-stale-evidence": {
          responsesText: true,
          streaming: true,
          functionCalling: true,
          structuredOutputs: true,
        },
      },
      secretFingerprint: "sha256:000000000002",
      evidenceFingerprint: "sha256:000000000001",
    });

    await expect(
      activateOpenAiProvider({
        runtime: fixture.runtime,
        actorUserId: "10000000-0000-4000-8000-000000000001",
        correlationId: "stale-credential-activation",
      }),
    ).rejects.toMatchObject({ code: "OPENAI_CREDENTIAL_EVIDENCE_STALE" });
    await expect(resolveAiCommandProvider(fixture.runtime)).rejects.toMatchObject({
      code: "OPENAI_NOT_ACTIVE",
    });

    expect(fixture.createOpenAiProvider).not.toHaveBeenCalled();
    expect(fixture.auditRecord).not.toHaveBeenCalled();
    expect(fixture.persistence.activateOpenAiAtomically).not.toHaveBeenCalled();
  });

  it("requires an exact non-null fingerprint for production rehydration evidence", () => {
    const evidence = { credentialFingerprint: "sha256:000000000001" };
    expect(connectionEvidenceMatchesCredential(evidence, "sha256:000000000001")).toBe(true);
    expect(connectionEvidenceMatchesCredential(evidence, "sha256:000000000002")).toBe(false);
    expect(connectionEvidenceMatchesCredential(evidence, null)).toBe(false);
    expect(connectionEvidenceMatchesCredential(null, "sha256:000000000001")).toBe(false);
  });
});

describe("OpenAI administration strict settings and truthful audit", () => {
  it("merges only explicit administrator capability evidence into cockpit policy", () => {
    expect(
      mergeModelCapabilityEvidence(
        { webSearch: "unknown", imageGeneration: false },
        { webSearch: true },
      ),
    ).toEqual({ webSearch: true, imageGeneration: false });
    expect(mergeModelCapabilityEvidence({ webSearch: false }, [])).toEqual({
      webSearch: false,
    });
  });

  it("blocks direct live Realtime file code and image work without durable owner authorization", () => {
    for (const capability of [
      "realtime",
      "input_file",
      "code_interpreter",
      "image_generation",
    ] as const) {
      expect(() => requireLiveOwnerAuthorization("openai", capability)).toThrow(
        "blocked pending explicit owner authorization",
      );
      expect(() => requireLiveOwnerAuthorization("demo", capability)).not.toThrow();
    }
  });

  it("rejects arrays inherited objects and arbitrary setting fields", () => {
    expect(() => parseAiProviderSettings([])).toThrow("Provider settings must be an object");
    const inherited = Object.create({ webSearchAllowed: true }) as Record<string, unknown>;
    inherited.defaultVoice = "alloy";
    expect(() => parseAiProviderSettings(inherited)).toThrow("Provider settings must be an object");
    expect(() => parseAiProviderSettings({ arbitraryExtra: true })).toThrow("unsupported field");
    expect(() => parseAiProviderSettings(JSON.parse('{"__proto__":true}'))).toThrow(
      "unsupported field",
    );
  });

  it("audits only changed administrator-attested capability states", async () => {
    const fixture = runtimeFixture({ models: [modelRecord("gpt-attested")] });
    await updateAiProviderSettings({
      runtime: fixture.runtime,
      actorUserId: "10000000-0000-4000-8000-000000000001",
      correlationId: "capability-attestation",
      value: {
        modelCapabilityOverrides: {
          "gpt-attested": { responsesText: true },
        },
      },
    });
    expect(fixture.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "ai-provider.capabilities-attested",
        metadata: {
          provider: "openai",
          changes: [
            {
              modelId: "gpt-attested",
              capability: "responsesText",
              previousState: "unset",
              state: true,
            },
          ],
        },
      }),
    );
  });

  it("does not mutate activation state when the durable authorization audit persistently fails", async () => {
    const fixture = runtimeFixture({
      models: [modelRecord("gpt-authorized")],
      overrides: {
        "gpt-authorized": {
          responsesText: true,
          streaming: true,
          functionCalling: true,
          structuredOutputs: true,
        },
      },
    });
    fixture.auditRecord.mockRejectedValue(new Error("synthetic durable audit failure"));
    await expect(
      activateOpenAiProvider({
        runtime: fixture.runtime,
        actorUserId: "10000000-0000-4000-8000-000000000001",
        correlationId: "activation-authorization-failure",
      }),
    ).rejects.toThrow("synthetic durable audit failure");
    expect(fixture.persistence.activateOpenAiAtomically).not.toHaveBeenCalled();
    expect(fixture.persistence.activateDemo).not.toHaveBeenCalled();
    expect(fixture.settingSet).not.toHaveBeenCalled();
    expect(fixture.auditRecord).toHaveBeenCalledTimes(1);
    expect(fixture.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "ai-provider.activation-authorized",
        outcome: "allowed",
      }),
    );
    expect(fixture.registry.active().providerKey).toBe("demo");
  });

  it("keeps the runtime in Demo when the atomic durable activation transaction fails", async () => {
    const fixture = runtimeFixture({
      models: [modelRecord("gpt-atomic")],
      overrides: {
        "gpt-atomic": {
          responsesText: true,
          streaming: true,
          functionCalling: true,
          structuredOutputs: true,
        },
      },
    });
    fixture.persistence.activateOpenAiAtomically.mockRejectedValue(
      new Error("synthetic activation transaction rollback"),
    );

    await expect(
      activateOpenAiProvider({
        runtime: fixture.runtime,
        actorUserId: "10000000-0000-4000-8000-000000000001",
        correlationId: "activation-transaction-failure",
      }),
    ).rejects.toThrow("synthetic activation transaction rollback");

    expect(fixture.persistence.activateOpenAiAtomically).toHaveBeenCalledTimes(1);
    expect(fixture.persistence.activateDemo).not.toHaveBeenCalled();
    expect(fixture.settingSet).not.toHaveBeenCalled();
    expect(fixture.registry.active().providerKey).toBe("demo");
  });
});

describe("AI integration health truthfulness", () => {
  it("reports Demo simulated unverified OpenAI blocked and active OpenAI connected", async () => {
    const demo = runtimeFixture({ models: [modelRecord("gpt-demo")] });
    await expect(getAiIntegrationHealthWithRuntime(demo.runtime)).resolves.toMatchObject({
      connectionStatus: "simulated",
      requirementStatus: "SIMULATED",
      mockMode: true,
    });

    const unverified = runtimeFixture({
      mode: "openai",
      persistedActive: true,
      models: [modelRecord("gpt-live")],
    });
    await expect(getAiIntegrationHealthWithRuntime(unverified.runtime)).resolves.toMatchObject({
      requirementStatus: "BLOCKED",
    });

    const verified = runtimeFixture({
      mode: "openai",
      persistedActive: true,
      models: [modelRecord("gpt-live")],
    });
    verified.registry.register(provider("gpt-live"));
    verified.registry.activate("openai");
    await expect(getAiIntegrationHealthWithRuntime(verified.runtime)).resolves.toMatchObject({
      connectionStatus: "connected",
      requirementStatus: "CONNECTED",
      mockMode: false,
    });
  });
});
