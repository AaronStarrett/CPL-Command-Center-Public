import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoArtifactRunnerError } from "../../packages/artifacts/src/runner";
import { PERMISSIONS } from "../../packages/security/src/rbac";

const mocks = vi.hoisted(() => ({
  requireAiApiContext: vi.fn(),
  readOpenAiAdministration: vi.fn(),
  configureOpenAiSecret: vi.fn(),
  disconnectOpenAi: vi.fn(),
  updateAiProviderSettings: vi.fn(),
  refreshOpenAiModels: vi.fn(),
  isDeterministicDemoAiCommandAllowed: vi.fn(),
  processAiCommandMessage: vi.fn(),
  processAiCommandStream: vi.fn(),
  requireLiveOwnerAuthorization: vi.fn(),
  resolveAiCommandProvider: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/ai-command-api", () => ({
  requireAiApiContext: mocks.requireAiApiContext,
}));
vi.mock("@/lib/ai-command", () => ({
  normalizeAiCommandRequestGeneration: (value: unknown) => value,
  normalizeAiCommandRequestId: (value: unknown) => value,
  processAiCommandMessage: mocks.processAiCommandMessage,
}));
vi.mock("@/lib/openai-administration", () => ({
  OpenAiAdministrationError: class OpenAiAdministrationError extends Error {},
  configureOpenAiSecret: mocks.configureOpenAiSecret,
  disconnectOpenAi: mocks.disconnectOpenAi,
  readOpenAiAdministration: mocks.readOpenAiAdministration,
  updateAiProviderSettings: mocks.updateAiProviderSettings,
  refreshOpenAiModels: mocks.refreshOpenAiModels,
  isDeterministicDemoAiCommandAllowed: mocks.isDeterministicDemoAiCommandAllowed,
  requireLiveOwnerAuthorization: mocks.requireLiveOwnerAuthorization,
  resolveAiCommandProvider: mocks.resolveAiCommandProvider,
  safeModelDtos: (models: unknown) => models,
}));
vi.mock("@/lib/openai-api", () => ({
  openAiApiError: () => new Response("safe provider error", { status: 500 }),
}));
vi.mock("@/lib/ai-command-stream", () => ({
  processAiCommandStream: mocks.processAiCommandStream,
}));

import {
  GET as getSettings,
  PUT as putSettings,
} from "../../apps/web/app/api/integrations/ai/settings/route";
import {
  GET as getModels,
  POST as refreshModels,
} from "../../apps/web/app/api/integrations/ai/models/route";
import { POST as postLegacyMessage } from "../../apps/web/app/api/ai-command/messages/route";
import { POST as streamAiCommand } from "../../apps/web/app/api/ai-command/stream/route";
import { POST as authorizeRealtime } from "../../apps/web/app/api/ai-command/realtime/client-secret/route";
import {
  DELETE as deleteSecret,
  PUT as putSecret,
} from "../../apps/web/app/api/integrations/ai/secret/route";

describe("OpenAI administration route transport contracts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    const runtime = {
      environment: { appMode: "demo", runtimeMode: "test" },
      ai: {
        persistence: {
          consumeRateLimit: vi.fn(async () => ({
            allowed: true,
            limit: 100,
            remaining: 99,
            resetAt: new Date(Date.now() + 60_000).toISOString(),
          })),
          getProviderSettings: vi.fn(async () => ({
            mode: "demo",
            dailyRequestLimit: 100,
            perConversationRequestsPerMinute: 10,
            perUserRequestsPerMinute: 20,
            webSearchDefault: false,
          })),
          listCachedModels: vi.fn(async () => []),
        },
        registry: {
          active: vi.fn(() => ({ providerKey: "demo" })),
        },
      },
    };
    mocks.requireAiApiContext.mockResolvedValue({
      ok: true,
      runtime,
      userId: "10000000-0000-4000-8000-000000000001",
      correlationId: "route-transport-fixture",
    });
    mocks.readOpenAiAdministration.mockResolvedValue({
      settings: { mode: "demo" },
      liveConnected: false,
      apiKeyStatus: "not_configured",
      cachedModels: [],
    });
    mocks.updateAiProviderSettings.mockResolvedValue({ mode: "demo" });
    mocks.refreshOpenAiModels.mockResolvedValue([]);
    mocks.configureOpenAiSecret.mockResolvedValue(undefined);
    mocks.disconnectOpenAi.mockResolvedValue(undefined);
    mocks.isDeterministicDemoAiCommandAllowed.mockImplementation(async (candidateRuntime) => {
      const environment = candidateRuntime.environment;
      if (environment.appMode !== "demo" || environment.runtimeMode === "production") return false;
      const settings = await candidateRuntime.ai.persistence.getProviderSettings();
      return (
        settings.mode === "demo" && candidateRuntime.ai.registry.active().providerKey === "demo"
      );
    });
    mocks.processAiCommandStream.mockImplementation(async function* () {
      yield {
        type: "response.completed",
        requestId: "route-stream-request",
        responseId: "route-stream-response",
        model: "demo-bea-command-v1",
        provider: "demo",
        outputText: "Done.",
        citations: [],
        toolCalls: [],
        generatedArtifacts: [],
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          estimatedCostUsd: 0,
          costStatus: "simulated",
        },
      };
    });
  });

  it("keeps GET routes unguarded and applies bounded transport only to mutations", async () => {
    const settingsGet = await getSettings(
      new Request("https://bea.example/api/integrations/ai/settings") as never,
    );
    expect(settingsGet.status).toBe(200);
    expect(mocks.readOpenAiAdministration).toHaveBeenCalledTimes(1);

    const modelsGet = await getModels(
      new Request("https://bea.example/api/integrations/ai/models") as never,
    );
    expect(modelsGet.status).toBe(200);

    const missingLength = await putSettings(
      new Request("https://bea.example/api/integrations/ai/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
      }) as never,
    );
    expect(missingLength.status).toBe(411);
    expect(mocks.updateAiProviderSettings).not.toHaveBeenCalled();

    const bodyOnRefresh = await refreshModels(
      new Request("https://bea.example/api/integrations/ai/models", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": "2" },
        body: "{}",
      }) as never,
    );
    expect(bodyOnRefresh.status).toBe(400);
    expect(mocks.refreshOpenAiModels).not.toHaveBeenCalled();
  });

  it("hides the deterministic JSON fallback from authorized production requests", async () => {
    mocks.requireAiApiContext.mockResolvedValueOnce({
      ok: true,
      runtime: {
        environment: { appMode: "production", runtimeMode: "test" },
      },
      userId: "10000000-0000-4000-8000-000000000001",
      correlationId: "production-fallback-denial",
    });
    const body = JSON.stringify({
      conversationId: "10000000-0000-4000-8000-000000000010",
      message: "Show open tasks",
      requestId: "20000000-0000-4000-8000-000000000020",
      generation: 1,
    });
    const response = await postLegacyMessage(
      new Request("https://bea.example/api/ai-command/messages", {
        method: "POST",
        headers: {
          "Content-Length": String(new TextEncoder().encode(body).length),
          "Content-Type": "application/json",
        },
        body,
      }) as never,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "test-provider-unavailable" },
    });
    expect(mocks.processAiCommandMessage).not.toHaveBeenCalled();
  });

  it.each(["openai", "hybrid"] as const)(
    "hides the deterministic JSON fallback when Demo app mode has selected %s",
    async (mode) => {
      const runtime = {
        environment: { appMode: "demo", runtimeMode: "test" },
        ai: {
          persistence: { getProviderSettings: vi.fn(async () => ({ mode })) },
          registry: { active: vi.fn(() => ({ providerKey: "openai" })) },
        },
      };
      mocks.requireAiApiContext.mockResolvedValueOnce({
        ok: true,
        runtime,
        userId: "10000000-0000-4000-8000-000000000001",
        correlationId: `${mode}-fallback-denial`,
      });
      const body = JSON.stringify({
        conversationId: "10000000-0000-4000-8000-000000000010",
        message: "Show open tasks",
        requestId: "20000000-0000-4000-8000-000000000020",
        generation: 1,
      });
      const response = await postLegacyMessage(
        new Request("https://bea.example/api/ai-command/messages", {
          method: "POST",
          headers: {
            "Content-Length": String(new TextEncoder().encode(body).length),
            "Content-Type": "application/json",
          },
          body,
        }) as never,
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "test-provider-unavailable" },
      });
      expect(mocks.isDeterministicDemoAiCommandAllowed).toHaveBeenCalledWith(runtime);
      expect(mocks.processAiCommandMessage).not.toHaveBeenCalled();
    },
  );

  it("blocks the exact production-presentation stream before creating provider work", async () => {
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

    const response = await streamAiCommand(
      new Request("https://bea.example/api/ai-command/stream", { method: "POST" }) as never,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "test-provider-unavailable" },
    });
    expect(mocks.processAiCommandStream).not.toHaveBeenCalled();
  });

  it("requires the established execution and administration permissions for Realtime authorization", async () => {
    mocks.requireAiApiContext.mockResolvedValueOnce({
      ok: false,
      response: new Response("permission denied", { status: 403 }),
    });

    const response = await authorizeRealtime(
      new Request("https://bea.example/api/ai-command/realtime/client-secret", {
        method: "POST",
      }) as never,
    );

    expect(response.status).toBe(403);
    expect(mocks.requireAiApiContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        permissions: [
          PERMISSIONS.AI_COMMAND_RUN,
          PERMISSIONS.INTEGRATIONS_MANAGE,
          PERMISSIONS.SETTINGS_MANAGE,
        ],
      }),
    );
  });

  it("protects key replacement and disconnect behind dual administration permission", async () => {
    const secret = "phase13-route-secret-value-0000001";
    const body = JSON.stringify({ apiKey: secret });
    const saved = await putSecret(
      new Request("https://bea.example/api/integrations/ai/secret", {
        method: "PUT",
        headers: {
          "Content-Length": String(new TextEncoder().encode(body).length),
          "Content-Type": "application/json",
        },
        body,
      }) as never,
    );

    expect(saved.status).toBe(200);
    expect(mocks.requireAiApiContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "openai.secret.replace",
        permissions: [PERMISSIONS.INTEGRATIONS_MANAGE, PERMISSIONS.SETTINGS_MANAGE],
        strictMutation: true,
      }),
    );
    expect(mocks.configureOpenAiSecret).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: secret }),
    );
    expect(await saved.text()).not.toContain(secret);

    const deleted = await deleteSecret(
      new Request("https://bea.example/api/integrations/ai/secret", { method: "DELETE" }) as never,
    );
    expect(deleted.status).toBe(200);
    expect(mocks.disconnectOpenAi).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: "10000000-0000-4000-8000-000000000001" }),
    );
  });

  it("rejects malformed or overbroad secret mutations before secret storage", async () => {
    const extraFieldBody = JSON.stringify({
      apiKey: "phase13-route-secret-value-0000002",
      mode: "openai",
    });
    const response = await putSecret(
      new Request("https://bea.example/api/integrations/ai/secret", {
        method: "PUT",
        headers: {
          "Content-Length": String(new TextEncoder().encode(extraFieldBody).length),
          "Content-Type": "application/json",
        },
        body: extraFieldBody,
      }) as never,
    );

    expect(response.status).toBe(400);
    expect(mocks.configureOpenAiSecret).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("phase13-route-secret-value-0000002");
  });

  it("surfaces only allowlisted Demo artifact runner failures through the SSE route", async () => {
    mocks.processAiCommandStream.mockImplementation(async function* () {
      throw new DemoArtifactRunnerError(
        "DEMO_ARTIFACT_PERSISTENCE_FAILED",
        "Artifact generation could not be persisted.",
      );
    });
    const body = JSON.stringify({
      conversationId: "10000000-0000-4000-8000-000000000010",
      generation: 1,
      inputMode: "text",
      message: "Research synthetic envelope sources",
      requestId: "route-stream-request",
    });
    const response = await streamAiCommand(
      new Request("https://bea.example/api/ai-command/stream", {
        method: "POST",
        headers: {
          "Content-Length": String(new TextEncoder().encode(body).length),
          "Content-Type": "application/json",
        },
        body,
      }) as never,
    );

    expect(response.status).toBe(200);
    const eventStream = await response.text();
    expect(eventStream).toContain('"code":"DEMO_ARTIFACT_PERSISTENCE_FAILED"');
    expect(eventStream).toContain('"safeMessage":"Artifact generation could not be persisted."');
    expect(eventStream).not.toContain("AI_COMMAND_STREAM_FAILED");
  });

  it("pulls one SSE event at a time and aborts provider work when the reader cancels", async () => {
    let produced = 0;
    let cleanedUp = false;
    let cancellationObserved = false;
    mocks.processAiCommandStream.mockImplementation(async function* (input) {
      try {
        while (produced < 20) {
          produced += 1;
          yield { type: "response.output_text.delta", delta: `chunk-${produced}` };
        }
      } finally {
        cleanedUp = true;
        cancellationObserved = input.signal.aborted;
      }
    });
    const body = JSON.stringify({
      conversationId: "10000000-0000-4000-8000-000000000010",
      generation: 1,
      inputMode: "text",
      message: "Research synthetic envelope sources",
      requestId: "route-stream-backpressure-request",
    });
    const response = await streamAiCommand(
      new Request("https://bea.example/api/ai-command/stream", {
        method: "POST",
        headers: {
          "Content-Length": String(new TextEncoder().encode(body).length),
          "Content-Type": "application/json",
        },
        body,
      }) as never,
    );
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    await vi.waitFor(() => expect(produced).toBe(1));
    await Promise.resolve();
    await Promise.resolve();
    expect(produced).toBe(1);

    const first = await reader!.read();
    expect(new TextDecoder().decode(first.value)).toContain("chunk-1");
    await reader!.cancel("consumer stopped");

    expect(produced).toBeLessThan(20);
    expect(cleanedUp).toBe(true);
    expect(cancellationObserved).toBe(true);
  });
});
