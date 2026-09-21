import { afterEach, describe, expect, it, vi } from "vitest";

import type { BeaServerRuntime } from "../../packages/database/src/index.js";

import {
  DeterministicMockIntegrationProvider,
  UnavailableIntegrationProvider,
  createUnavailableProviderRegistry,
} from "../../packages/integrations/src/index.js";

vi.mock("server-only", () => ({}));

import { processAiCommandStream } from "../../apps/web/lib/ai-command-stream.js";

const userId = "10000000-0000-4000-8000-000000000001";
const conversationId = "10000000-0000-4000-8000-000000000010";

function streamRuntime(mode: "demo" | "openai" | "hybrid") {
  const beginAiCommandRequest = vi.fn(async () => {
    throw new Error("The deterministic router must not execute for this fixture.");
  });
  const getProviderSettings = vi.fn(async () => ({ mode }));
  const runtime = {
    environment: { appMode: "demo", runtimeMode: "test" },
    phase1: {
      getConversation: vi.fn(async () => ({ id: conversationId })),
      listAssistantMessages: vi.fn(async () => []),
      beginAiCommandRequest,
    },
    ai: {
      persistence: {
        getProviderSettings,
        getLatestPresentationRunForConversation: vi.fn(async () => null),
      },
      registry: {
        active: vi.fn(() => ({ providerKey: mode === "demo" ? "demo" : "openai" })),
      },
      secrets: {
        describeOpenAiApiKey: vi.fn(() => ({
          status: "not_configured",
          source: "none",
          fingerprint: null,
          protectedStorageAvailable: false,
        })),
      },
    },
  } as unknown as BeaServerRuntime;
  return { beginAiCommandRequest, getProviderSettings, runtime };
}

function recognizedCommandStream(runtime: BeaServerRuntime) {
  return processAiCommandStream({
    runtime,
    userId,
    conversationId,
    message: "Show open tasks",
    requestId: "40000000-0000-4000-8000-000000000040",
    generation: 1,
    correlationId: "phase133-provider-isolation",
    webSearch: false,
    builtInTools: [],
    confirmHighCostTools: false,
    inputMode: "text",
    inputArtifactIds: [],
  });
}

describe("Phase 1.3.3 production integration isolation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("registers only fail-closed, non-test providers for an unconfigured production runtime", async () => {
    const providers = createUnavailableProviderRegistry().list();
    expect(providers.length).toBeGreaterThan(0);
    expect(providers.every((provider) => provider instanceof UnavailableIntegrationProvider)).toBe(
      true,
    );
    expect(
      providers.some((provider) => provider instanceof DeterministicMockIntegrationProvider),
    ).toBe(false);

    const health = await Promise.all(providers.map((provider) => provider.health()));
    expect(
      health.every(
        (item) =>
          item.mode === "live" &&
          item.connectionStatus === "not-configured" &&
          item.requirementStatus === "BLOCKED" &&
          !item.mockMode &&
          !item.testMode,
      ),
    ).toBe(true);

    const summary = await createUnavailableProviderRegistry().healthSummary();
    expect(summary.status).toBe("degraded");
    expect(summary.degraded).toBe(summary.total);
    expect(summary.connected).toBe(0);
    expect(summary.simulated).toBe(0);
  });

  it.each(["openai", "hybrid"] as const)(
    "never routes a recognized server stream through deterministic fixtures when %s is selected",
    async (mode) => {
      const fixture = streamRuntime(mode);
      const stream = recognizedCommandStream(fixture.runtime);

      await expect(stream.next()).rejects.toMatchObject({ code: "OPENAI_NOT_ACTIVE", status: 409 });
      expect(fixture.beginAiCommandRequest).not.toHaveBeenCalled();
      expect(fixture.getProviderSettings).toHaveBeenCalled();
    },
  );

  it("never routes an exact production-presentation stream through deterministic fixtures", async () => {
    const presentationEnvironment = {
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
    for (const [key, value] of Object.entries(presentationEnvironment)) vi.stubEnv(key, value);
    const fixture = streamRuntime("demo");
    const stream = recognizedCommandStream(fixture.runtime);

    await expect(stream.next()).rejects.toMatchObject({
      code: "PHASE133_PRESENTATION_TEST_LIVE_OPERATION_BLOCKED",
      status: 409,
    });
    expect(fixture.beginAiCommandRequest).not.toHaveBeenCalled();
  });
});
