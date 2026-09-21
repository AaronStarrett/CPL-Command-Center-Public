import { beforeEach, describe, expect, it, vi } from "vitest";

import { createUnconfiguredAiRoutingProfile } from "../../packages/domain/src/index";
import { PERMISSIONS } from "../../packages/security/src/rbac";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const CONVERSATION_ID = "10000000-0000-4000-8000-000000000010";
const OTHER_CONVERSATION_ID = "10000000-0000-4000-8000-000000000011";
const SESSION_ID = "20000000-0000-4000-8000-000000000020";
const POLICY_PROVENANCE = {
  personaPromptVersion: "bea-executive-business-partner-v1",
  assistantRoleVersion: "bea-role-assistant-v1",
  executiveProfileVersion: "andrew-executive-profile-v1",
  artifactBrandPolicyVersion: "bea-artifact-brand-v1",
  artifactTemplateVersion: "bea-artifact-template-v1",
} as const;
const SESSION_ROUTE_DECISION = {
  profileVersion: "phase1.3.3-v1",
  routeKey: "realtime_voice",
  selectedModel: "gpt-realtime-test",
  primaryModel: "gpt-realtime-test",
  fallbackModel: "gpt-realtime-fallback",
  usedFallback: false,
  fallbackReason: null,
  requiredCapabilities: ["realtime", "audioInput", "audioOutput"],
  reasoningEffort: "none",
  toolAllowlist: [
    "search_web",
    "bea_query_records",
    "bea_connector_health",
    "bea_workflow_history",
    "bea_preview_task",
    "bea_show_workspace",
  ],
  decidedAt: "2026-08-23T12:00:00.000Z",
} as const;

const mocks = vi.hoisted(() => ({
  authorizeLiveRealtimeOwner: vi.fn(),
  authorizeLiveVoiceWebSearch: vi.fn(),
  createRealtimeClientAuthorization: vi.fn(),
  getAiCommandSnapshotWithRuntime: vi.fn(),
  getAssistantPolicyContext: vi.fn(),
  processAiCommandMessageWithRuntime: vi.fn(),
  processAiCommandStream: vi.fn(),
  requireAiApiContext: vi.fn(),
  requireLiveOwnerAuthorization: vi.fn(),
  reserveAiCommandRequestWithRuntime: vi.fn(),
  resolveAiCommandProvider: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/assistant-policy", () => ({
  getAssistantPolicyContext: mocks.getAssistantPolicyContext,
}));
vi.mock("@/lib/ai-command-api", () => ({
  requireAiApiContext: mocks.requireAiApiContext,
}));
vi.mock("@/lib/openai-administration", () => ({
  OpenAiAdministrationError: class OpenAiAdministrationError extends Error {
    constructor(
      readonly code: string,
      readonly status: number,
      readonly safeMessage: string,
    ) {
      super(safeMessage);
    }
  },
  authorizeLiveRealtimeOwner: mocks.authorizeLiveRealtimeOwner,
  requireLiveOwnerAuthorization: mocks.requireLiveOwnerAuthorization,
  resolveAiCommandProvider: mocks.resolveAiCommandProvider,
}));
vi.mock("@/lib/openai-api", () => ({
  openAiApiError: (error: unknown, correlationId: string) => {
    const input = error as {
      readonly code?: string;
      readonly safeMessage?: string;
      readonly status?: number;
    };
    return new Response(
      JSON.stringify({
        error: {
          code: input.code ?? "OPENAI_REQUEST_FAILED",
          message: input.safeMessage ?? "The OpenAI operation failed safely.",
          correlationId,
        },
      }),
      { status: input.status ?? 500, headers: { "Content-Type": "application/json" } },
    );
  },
}));
vi.mock("@/lib/ai-command", () => ({
  getAiCommandSnapshotWithRuntime: mocks.getAiCommandSnapshotWithRuntime,
  processAiCommandMessageWithRuntime: mocks.processAiCommandMessageWithRuntime,
  reserveAiCommandRequestWithRuntime: mocks.reserveAiCommandRequestWithRuntime,
}));
vi.mock("@/lib/ai-command-stream", () => ({
  authorizeLiveVoiceWebSearch: mocks.authorizeLiveVoiceWebSearch,
  processAiCommandStream: mocks.processAiCommandStream,
}));

import { POST as authorizeRealtime } from "../../apps/web/app/api/ai-command/realtime/client-secret/route";
import { POST as recordRealtimeEvent } from "../../apps/web/app/api/ai-command/realtime/events/route";
import { POST as executeRealtimeTool } from "../../apps/web/app/api/ai-command/realtime/tools/execute/route";

function mutation(url: string, value: Record<string, unknown>): Request {
  const body = JSON.stringify(value);
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Length": String(new TextEncoder().encode(body).length),
      "Content-Type": "application/json",
      Origin: "https://bea.example",
    },
    body,
  });
}

function session(status: "authorized" | "connected" = "connected") {
  return {
    id: SESSION_ID,
    conversationId: CONVERSATION_ID,
    requestedByUserId: USER_ID,
    provider: "openai",
    providerSessionId: null,
    model: "gpt-realtime-test",
    voice: "coral",
    status,
    correlationId: "realtime-session-fixture",
    authorizedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    completedAt: null,
    errorCode: null,
    simulated: false,
    policyProvenance: POLICY_PROVENANCE,
    routeDecision: SESSION_ROUTE_DECISION,
  };
}

function sourceSnapshot(artifactType = "source-board") {
  return {
    messages: [
      {
        id: "message-result",
        role: "assistant",
        content: "Verified current guidance with persisted sources.",
      },
    ],
    artifact: {
      type: artifactType,
      title: artifactType === "action-preview" ? "Task preview" : "Sources",
      subtitle: "Authorized Realtime tool result",
      state: "ready",
      payload: { summary: "Bounded result" },
      sources: [{ title: "Official guidance", url: "https://example.com/guidance" }],
      links: [{ label: "Open source", href: "https://example.com/guidance" }],
    },
  };
}

describe("Realtime route transport and authorization", () => {
  let runtime: {
    readonly ai: { readonly persistence: Record<string, ReturnType<typeof vi.fn>> };
    readonly authorization: { readonly requireUser: ReturnType<typeof vi.fn> };
    readonly phase1: Record<string, ReturnType<typeof vi.fn>>;
    readonly repository: { readonly record: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    const baseRoutingProfile = createUnconfiguredAiRoutingProfile();
    const routingProfile = {
      ...baseRoutingProfile,
      routes: {
        ...baseRoutingProfile.routes,
        realtime_voice: {
          ...baseRoutingProfile.routes.realtime_voice,
          primaryModel: "gpt-realtime-test",
          fallbackModel: "gpt-realtime-fallback",
          toolAllowlist: ["bea_query_records", "bea_preview_task"],
        },
      },
    };
    runtime = {
      ai: {
        persistence: {
          consumeRateLimit: vi.fn(async () => ({
            allowed: true,
            limit: 20,
            remaining: 19,
            resetAt: new Date(Date.now() + 60_000).toISOString(),
          })),
          getProviderSettings: vi.fn(async () => ({
            realtimeAllowed: true,
            defaultRealtimeModel: "gpt-realtime-test",
            defaultVoice: "coral",
            modelCapabilityOverrides: {},
            inputTranscriptionModel: null,
            realtimeSessionInstructions: "You are the BEA voice assistant.",
            realtimeTurnDetection: "server_vad",
            realtimeInteractionMode: "automatic",
            realtimeAllowInterruption: true,
            realtimeOutputSpeed: 1,
            realtimeMaxOutputTokens: 512,
            requestTimeoutMs: 10_000,
            routingProfile,
          })),
          getUserVoicePreference: vi.fn(async () => ({
            id: USER_ID,
            userId: USER_ID,
            speakResponses: true,
            createdAt: "2026-08-23T00:00:00.000Z",
            updatedAt: "2026-08-23T00:00:00.000Z",
            version: 1,
          })),
          getRealtimeSessionForUser: vi.fn(async () => session()),
          listCachedModels: vi.fn(async () => [
            {
              modelId: "gpt-realtime-test",
              available: true,
              capabilities: { realtime: true, audioInput: true, audioOutput: true },
            },
          ]),
          recordRealtimeSession: vi.fn(async () => SESSION_ID),
          countActiveRealtimeSessionsForUser: vi.fn(async () => 0),
          recordUsage: vi.fn(async () => "30000000-0000-4000-8000-000000000030"),
          transitionRealtimeSession: vi.fn(async (input) => session(input.status)),
        },
      },
      authorization: { requireUser: vi.fn(async () => undefined) },
      phase1: {
        createAssistantMessage: vi.fn(async () => ({ id: "message-realtime" })),
        getConversation: vi.fn(async () => ({ id: CONVERSATION_ID, ownerUserId: USER_ID })),
      },
      repository: {
        findActiveUserById: vi.fn(async () => ({ roleIds: ["owner-admin"] })),
        record: vi.fn(async () => ({ id: "audit-realtime" })),
      },
    };
    mocks.requireAiApiContext.mockResolvedValue({
      ok: true,
      runtime,
      userId: USER_ID,
      correlationId: "realtime-route-fixture",
    });
    mocks.authorizeLiveRealtimeOwner.mockResolvedValue({ ownerEvidence: true });
    mocks.getAssistantPolicyContext.mockResolvedValue({
      internalInstructions: "PRIVATE OWNER PROFILE SENTINEL",
      providerInstructions: "PUBLIC EXECUTIVE PERSONA",
      provenance: POLICY_PROVENANCE,
    });
    mocks.createRealtimeClientAuthorization.mockResolvedValue({
      provider: "openai",
      clientSecret: "ek_realtime_ephemeral_test_1234567890",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      sessionId: "sess_realtime_test",
      model: "gpt-realtime-test",
      voice: "coral",
      simulated: false,
    });
    mocks.reserveAiCommandRequestWithRuntime.mockResolvedValue({
      generation: 3,
      requestId: "40000000-0000-4000-8000-000000000040",
    });
    mocks.authorizeLiveVoiceWebSearch.mockResolvedValue({ oneTimeEvidence: true });
    mocks.getAiCommandSnapshotWithRuntime.mockResolvedValue(sourceSnapshot());
    mocks.processAiCommandMessageWithRuntime.mockResolvedValue(sourceSnapshot());
    mocks.processAiCommandStream.mockImplementation(async function* () {
      yield {
        type: "response.completed",
        result: { id: "response-result", outputText: "Verified current guidance." },
      };
    });
    mocks.resolveAiCommandProvider.mockResolvedValue({
      providerKey: "openai",
      createRealtimeClientAuthorization: mocks.createRealtimeClientAuthorization,
    });
  });

  it("mints only a short-lived browser credential after owner evidence and model verification", async () => {
    const response = await authorizeRealtime(
      mutation("https://bea.example/api/ai-command/realtime/client-secret", {
        conversationId: CONVERSATION_ID,
      }) as never,
    );
    const body = (await response.json()) as { authorization: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(body.authorization).toMatchObject({
      provider: "openai",
      beaSessionId: SESSION_ID,
      model: "gpt-realtime-test",
      voice: "coral",
      simulated: false,
      interactionMode: "automatic",
      allowInterruption: true,
      webrtcEndpoint: "https://api.openai.com/v1/realtime/calls",
    });
    expect(JSON.stringify(body)).not.toMatch(/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/u);
    expect(mocks.authorizeLiveRealtimeOwner).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: USER_ID, runtime }),
    );
    expect(mocks.requireLiveOwnerAuthorization).toHaveBeenCalledWith("openai", "realtime", {
      ownerEvidence: true,
    });
    expect(mocks.createRealtimeClientAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        instructions: expect.stringContaining("PUBLIC EXECUTIVE PERSONA"),
        model: "gpt-realtime-test",
        tools: [
          expect.objectContaining({ name: "bea_query_records" }),
          expect.objectContaining({ name: "bea_preview_task" }),
        ],
      }),
      expect.anything(),
    );
    expect(mocks.createRealtimeClientAuthorization.mock.calls[0]?.[0]?.instructions).not.toContain(
      "PRIVATE OWNER PROFILE SENTINEL",
    );
    expect(runtime.ai.persistence.recordRealtimeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        requestedByUserId: USER_ID,
        provider: "openai",
        status: "authorized",
        simulated: false,
        policyProvenance: POLICY_PROVENANCE,
        routeDecision: expect.objectContaining({
          routeKey: "realtime_voice",
          selectedModel: "gpt-realtime-test",
          usedFallback: false,
          toolAllowlist: ["bea_query_records", "bea_preview_task"],
        }),
      }),
    );
  });

  it("keeps the synthetic demo voice provider-bound while rejecting it for OpenAI", async () => {
    const currentSettings = await runtime.ai.persistence.getProviderSettings();
    runtime.ai.persistence.getProviderSettings.mockResolvedValue({
      ...currentSettings,
      defaultRealtimeModel: "deterministic-demo-router",
      defaultVoice: "demo",
      routingProfile: createUnconfiguredAiRoutingProfile(),
    });

    const rejected = await authorizeRealtime(
      mutation("https://bea.example/api/ai-command/realtime/client-secret", {
        conversationId: CONVERSATION_ID,
      }) as never,
    );
    expect(rejected.status).toBe(400);
    expect(mocks.createRealtimeClientAuthorization).not.toHaveBeenCalled();

    const createDemoAuthorization = vi.fn(async () => ({
      provider: "demo",
      clientSecret: "demo-no-network-40000000-0000-4000-8000-000000000040",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      sessionId: "demo-session-40000000-0000-4000-8000-000000000040",
      model: "deterministic-demo-router",
      voice: "demo",
      simulated: true,
    }));
    mocks.resolveAiCommandProvider.mockResolvedValueOnce({
      providerKey: "demo",
      listModels: vi.fn(async () => [
        {
          id: "deterministic-demo-router",
          provider: "demo",
          displayName: "Deterministic Demo Router",
          available: true,
          capabilities: { realtime: true, audioInput: true, audioOutput: true },
          capabilitySource: "built_in",
          validation: "verified",
        },
      ]),
      createRealtimeClientAuthorization: createDemoAuthorization,
    });

    const accepted = await authorizeRealtime(
      mutation("https://bea.example/api/ai-command/realtime/client-secret", {
        conversationId: CONVERSATION_ID,
      }) as never,
    );
    const body = (await accepted.json()) as { authorization?: Record<string, unknown> };
    expect(accepted.status).toBe(200);
    expect(body.authorization).toMatchObject({
      provider: "demo",
      model: "deterministic-demo-router",
      voice: "demo",
      simulated: true,
      webrtcEndpoint: null,
    });
    expect(createDemoAuthorization).toHaveBeenCalledTimes(1);
    expect(mocks.authorizeLiveRealtimeOwner).not.toHaveBeenCalled();
    expect(mocks.requireLiveOwnerAuthorization).toHaveBeenLastCalledWith(
      "demo",
      "realtime",
      undefined,
    );
  });

  it("uses the verified Realtime fallback and persists the exact selected route policy", async () => {
    runtime.ai.persistence.listCachedModels.mockResolvedValueOnce([
      {
        modelId: "gpt-realtime-test",
        available: false,
        capabilities: { realtime: true, audioInput: true, audioOutput: true },
      },
      {
        modelId: "gpt-realtime-fallback",
        available: true,
        capabilities: { realtime: true, audioInput: true, audioOutput: true },
      },
    ]);
    mocks.createRealtimeClientAuthorization.mockResolvedValueOnce({
      provider: "openai",
      clientSecret: "ek_realtime_ephemeral_fallback_1234567890",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      sessionId: "sess_realtime_fallback",
      model: "gpt-realtime-fallback",
      voice: "coral",
      simulated: false,
    });

    const response = await authorizeRealtime(
      mutation("https://bea.example/api/ai-command/realtime/client-secret", {
        conversationId: CONVERSATION_ID,
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(mocks.createRealtimeClientAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-realtime-fallback",
        tools: [
          expect.objectContaining({ name: "bea_query_records" }),
          expect.objectContaining({ name: "bea_preview_task" }),
        ],
      }),
      expect.anything(),
    );
    expect(runtime.ai.persistence.recordRealtimeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-realtime-fallback",
        policyProvenance: POLICY_PROVENANCE,
        routeDecision: expect.objectContaining({
          routeKey: "realtime_voice",
          selectedModel: "gpt-realtime-fallback",
          primaryModel: "gpt-realtime-test",
          fallbackModel: "gpt-realtime-fallback",
          usedFallback: true,
          fallbackReason: "primary_incompatible",
          toolAllowlist: ["bea_query_records", "bea_preview_task"],
        }),
      }),
    );
  });

  it("fails closed before provider authorization when no compatible Realtime route model exists", async () => {
    runtime.ai.persistence.listCachedModels.mockResolvedValueOnce([
      {
        modelId: "gpt-realtime-test",
        available: false,
        capabilities: { realtime: true, audioInput: true, audioOutput: true },
      },
    ]);

    const response = await authorizeRealtime(
      mutation("https://bea.example/api/ai-command/realtime/client-secret", {
        conversationId: CONVERSATION_ID,
      }) as never,
    );

    expect(response.status).not.toBe(200);
    expect(mocks.createRealtimeClientAuthorization).not.toHaveBeenCalled();
    expect(runtime.ai.persistence.recordRealtimeSession).not.toHaveBeenCalled();
  });

  it("rejects a non-ephemeral provider credential before any browser response or session record", async () => {
    mocks.resolveAiCommandProvider.mockResolvedValueOnce({
      providerKey: "openai",
      createRealtimeClientAuthorization: vi.fn(async () => ({
        provider: "openai",
        clientSecret: "standard-api-key-sentinel-must-never-reach-browser",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        model: "gpt-realtime-test",
        voice: "coral",
        simulated: false,
      })),
    });
    const response = await authorizeRealtime(
      mutation("https://bea.example/api/ai-command/realtime/client-secret", {
        conversationId: CONVERSATION_ID,
      }) as never,
    );

    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(
      "standard-api-key-sentinel-must-never-reach-browser",
    );
    expect(runtime.ai.persistence.recordRealtimeSession).not.toHaveBeenCalled();
  });

  it("preserves the provider-management RBAC boundary for Realtime authorization", async () => {
    mocks.requireAiApiContext.mockResolvedValueOnce({
      ok: false,
      response: new Response("permission denied", { status: 403 }),
    });

    const response = await authorizeRealtime(
      mutation("https://bea.example/api/ai-command/realtime/client-secret", {
        conversationId: CONVERSATION_ID,
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
        strictMutation: true,
      }),
    );
  });

  it("rejects route-excluded roles before conversation validation or lookup", async () => {
    const currentSettings = await runtime.ai.persistence.getProviderSettings();
    runtime.ai.persistence.getProviderSettings.mockResolvedValue({
      ...currentSettings,
      routingProfile: {
        ...currentSettings.routingProfile,
        routes: {
          ...currentSettings.routingProfile.routes,
          realtime_voice: {
            ...currentSettings.routingProfile.routes.realtime_voice,
            roleAvailability: ["owner-admin"],
          },
        },
      },
    });
    runtime.repository.findActiveUserById.mockResolvedValueOnce({ roleIds: ["sales"] });

    const response = await authorizeRealtime(
      mutation("https://bea.example/api/ai-command/realtime/client-secret", {}) as never,
    );
    const body = (await response.json()) as { error?: { code?: string } };

    expect(response.status).toBe(403);
    expect(body.error?.code).toBe("REALTIME_ROLE_UNAVAILABLE");
    expect(runtime.phase1.getConversation).not.toHaveBeenCalled();
    expect(runtime.ai.persistence.listCachedModels).not.toHaveBeenCalled();
    expect(mocks.createRealtimeClientAuthorization).not.toHaveBeenCalled();
  });

  it("denies a second Realtime session while one is actually active", async () => {
    runtime.ai.persistence.countActiveRealtimeSessionsForUser.mockResolvedValueOnce(1);

    const response = await authorizeRealtime(
      mutation("https://bea.example/api/ai-command/realtime/client-secret", {
        conversationId: CONVERSATION_ID,
      }) as never,
    );
    const body = (await response.json()) as { error?: { code?: string; message?: string } };

    expect(response.status).toBe(429);
    expect(body.error?.code).toBe("REALTIME_SESSION_LIMIT");
    expect(body.error?.message).toMatch(/already active/iu);
    expect(mocks.createRealtimeClientAuthorization).not.toHaveBeenCalled();
    expect(runtime.ai.persistence.recordRealtimeSession).not.toHaveBeenCalled();
  });

  it("persists owned transcripts, usage, and terminal lifecycle without raw audio or cost claims", async () => {
    const transcript = await recordRealtimeEvent(
      mutation("https://bea.example/api/ai-command/realtime/events", {
        type: "transcript",
        sessionId: SESSION_ID,
        conversationId: CONVERSATION_ID,
        role: "assistant",
        itemId: "item_assistant_1",
        text: "  Verified   guidance is ready. ",
      }) as never,
    );
    expect(transcript.status).toBe(200);
    expect(runtime.phase1.createAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        ownerUserId: USER_ID,
        role: "assistant",
        content: "Verified guidance is ready.",
        provider: "openai",
        model: "gpt-realtime-test",
        providerResponseId: "item_assistant_1",
      }),
    );

    const usage = await recordRealtimeEvent(
      mutation("https://bea.example/api/ai-command/realtime/events", {
        type: "usage",
        sessionId: SESSION_ID,
        conversationId: CONVERSATION_ID,
        usage: {
          inputTokens: 12,
          outputTokens: 7,
          reasoningTokens: 1,
          cachedInputTokens: 2,
          audioInputTokens: 5,
          audioOutputTokens: 4,
          durationSeconds: 9,
        },
      }) as never,
    );
    expect(usage.status).toBe(200);
    expect(runtime.ai.persistence.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        realtimeSessionId: SESSION_ID,
        operation: "realtime.voice",
        audioInputTokens: 5,
        audioOutputTokens: 4,
        realtimeDurationSeconds: 9,
        estimatedCostUsd: null,
        costStatus: "unavailable",
        simulated: false,
      }),
    );
    expect(JSON.stringify(runtime.ai.persistence.recordUsage.mock.calls)).not.toContain(
      "audioData",
    );

    const completed = await recordRealtimeEvent(
      mutation("https://bea.example/api/ai-command/realtime/events", {
        type: "completed",
        sessionId: SESSION_ID,
        conversationId: CONVERSATION_ID,
      }) as never,
    );
    expect(completed.status).toBe(200);
    expect(runtime.ai.persistence.transitionRealtimeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: SESSION_ID,
        requestedByUserId: USER_ID,
        status: "completed",
      }),
    );
  });

  it("rejects cross-owner Realtime events before transcript, usage, or audit persistence", async () => {
    runtime.phase1.getConversation.mockResolvedValueOnce(null);
    const response = await recordRealtimeEvent(
      mutation("https://bea.example/api/ai-command/realtime/events", {
        type: "transcript",
        sessionId: SESSION_ID,
        conversationId: CONVERSATION_ID,
        role: "user",
        itemId: "item_user_1",
        text: "This must not cross the ownership boundary.",
      }) as never,
    );

    expect(response.status).toBe(404);
    expect(runtime.phase1.createAssistantMessage).not.toHaveBeenCalled();
    expect(runtime.ai.persistence.recordUsage).not.toHaveBeenCalled();
    expect(runtime.repository.record).not.toHaveBeenCalled();
  });

  it("rejects a same-owner event when its conversation differs from the authorized session", async () => {
    runtime.phase1.getConversation.mockResolvedValueOnce({
      id: OTHER_CONVERSATION_ID,
      ownerUserId: USER_ID,
    });
    const response = await recordRealtimeEvent(
      mutation("https://bea.example/api/ai-command/realtime/events", {
        type: "transcript",
        sessionId: SESSION_ID,
        conversationId: OTHER_CONVERSATION_ID,
        role: "user",
        itemId: "item_wrong_conversation",
        text: "This must remain bound to its originating conversation.",
      }) as never,
    );

    expect(response.status).toBe(404);
    expect(runtime.phase1.createAssistantMessage).not.toHaveBeenCalled();
    expect(runtime.ai.persistence.recordUsage).not.toHaveBeenCalled();
    expect(runtime.repository.record).not.toHaveBeenCalled();
  });

  it("rejects a browser-substituted provider session identifier", async () => {
    runtime.ai.persistence.getRealtimeSessionForUser.mockResolvedValueOnce({
      ...session("authorized"),
      providerSessionId: "sess_expected",
    });
    const response = await recordRealtimeEvent(
      mutation("https://bea.example/api/ai-command/realtime/events", {
        type: "connected",
        sessionId: SESSION_ID,
        conversationId: CONVERSATION_ID,
        providerSessionId: "sess_substituted",
      }) as never,
    );

    expect(response.status).toBe(400);
    expect(runtime.ai.persistence.transitionRealtimeSession).not.toHaveBeenCalled();
  });
});

describe("Realtime registered tool route", () => {
  let runtime: {
    readonly ai: { readonly persistence: Record<string, ReturnType<typeof vi.fn>> };
    readonly authorization: { readonly requireUser: ReturnType<typeof vi.fn> };
    readonly phase1: Record<string, ReturnType<typeof vi.fn>>;
    readonly repository: { readonly record: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    runtime = {
      ai: {
        persistence: {
          consumeRateLimit: vi.fn(async () => ({ allowed: true, remaining: 19 })),
          getRealtimeSessionForUser: vi.fn(async () => session()),
          transitionRealtimeSession: vi.fn(async () => session("failed")),
        },
      },
      authorization: { requireUser: vi.fn(async () => undefined) },
      phase1: {
        getConversation: vi.fn(async () => ({ id: CONVERSATION_ID, ownerUserId: USER_ID })),
      },
      repository: { record: vi.fn(async () => ({ id: "audit-tool" })) },
    };
    mocks.requireAiApiContext.mockResolvedValue({
      ok: true,
      runtime,
      userId: USER_ID,
      correlationId: "realtime-tool-fixture",
    });
    mocks.reserveAiCommandRequestWithRuntime.mockResolvedValue({
      generation: 4,
      requestId: "40000000-0000-4000-8000-000000000040",
    });
    mocks.authorizeLiveVoiceWebSearch.mockResolvedValue({ oneTimeEvidence: true });
    mocks.getAiCommandSnapshotWithRuntime.mockResolvedValue(sourceSnapshot());
    mocks.processAiCommandMessageWithRuntime.mockResolvedValue(sourceSnapshot());
    mocks.processAiCommandStream.mockImplementation(async function* () {
      yield {
        type: "response.completed",
        result: { id: "response-result", outputText: "Verified current guidance." },
      };
    });
  });

  it("routes voice search through the one-time server authorization and web_search only", async () => {
    const response = await executeRealtimeTool(
      mutation("https://bea.example/api/ai-command/realtime/tools/execute", {
        sessionId: SESSION_ID,
        conversationId: CONVERSATION_ID,
        callId: "call_search_1",
        name: "search_web",
        arguments: { query: "latest building-envelope inspection guidance" },
      }) as never,
    );
    const body = (await response.json()) as { output: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(body.output).toMatchObject({
      summary: "Verified current guidance with persisted sources.",
      actionConfirmationRequired: false,
      workspaceUpdated: true,
      workspace: expect.objectContaining({ type: "source-board", title: "Sources" }),
    });
    expect(mocks.authorizeLiveVoiceWebSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime,
        userId: USER_ID,
        conversationId: CONVERSATION_ID,
      }),
    );
    expect(mocks.processAiCommandStream).toHaveBeenCalledWith(
      expect.objectContaining({
        inputMode: "live_voice",
        webSearch: true,
        builtInTools: ["web_search"],
        confirmHighCostTools: false,
        liveVoiceWebSearchAuthorization: { oneTimeEvidence: true },
      }),
    );
    expect(runtime.authorization.requireUser).toHaveBeenCalledWith(
      expect.objectContaining({ permission: PERMISSIONS.SEARCH_VIEW }),
    );
    expect(mocks.requireAiApiContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ permissions: [PERMISSIONS.AI_COMMAND_RUN] }),
    );
    expect(JSON.stringify(runtime.repository.record.mock.calls)).not.toContain(
      "latest building-envelope inspection guidance",
    );
  });

  it("keeps voice task requests on the existing confirmation-gated preview path", async () => {
    mocks.processAiCommandMessageWithRuntime.mockResolvedValueOnce(
      sourceSnapshot("action-preview"),
    );
    const response = await executeRealtimeTool(
      mutation("https://bea.example/api/ai-command/realtime/tools/execute", {
        sessionId: SESSION_ID,
        conversationId: CONVERSATION_ID,
        callId: "call_preview_1",
        name: "bea_preview_task",
        arguments: { request: "Prepare a follow-up task preview" },
      }) as never,
    );
    const body = (await response.json()) as {
      output: { readonly actionConfirmationRequired: boolean };
    };

    expect(response.status).toBe(200);
    expect(body.output.actionConfirmationRequired).toBe(true);
    expect(mocks.processAiCommandMessageWithRuntime).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({ message: "Prepare a follow-up task preview" }),
    );
    expect(mocks.processAiCommandStream).not.toHaveBeenCalled();
  });

  it("rejects unknown or malformed tools before permission checks and business execution", async () => {
    const response = await executeRealtimeTool(
      mutation("https://bea.example/api/ai-command/realtime/tools/execute", {
        sessionId: SESSION_ID,
        conversationId: CONVERSATION_ID,
        callId: "call_arbitrary_1",
        name: "credential-sentinel-never-audit-this-unregistered-tool",
        arguments: { url: "https://example.com" },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect(runtime.authorization.requireUser).not.toHaveBeenCalled();
    expect(mocks.processAiCommandStream).not.toHaveBeenCalled();
    expect(mocks.processAiCommandMessageWithRuntime).not.toHaveBeenCalled();
    expect(JSON.stringify(runtime.repository.record.mock.calls)).not.toContain(
      "credential-sentinel-never-audit-this-unregistered-tool",
    );
  });

  it("rejects same-owner conversation substitution before tool permissions or execution", async () => {
    runtime.phase1.getConversation.mockResolvedValueOnce({
      id: OTHER_CONVERSATION_ID,
      ownerUserId: USER_ID,
    });
    const response = await executeRealtimeTool(
      mutation("https://bea.example/api/ai-command/realtime/tools/execute", {
        sessionId: SESSION_ID,
        conversationId: OTHER_CONVERSATION_ID,
        callId: "call_wrong_conversation",
        name: "bea_preview_task",
        arguments: { request: "This must not execute against another conversation" },
      }) as never,
    );

    expect(response.status).toBe(404);
    expect(runtime.authorization.requireUser).not.toHaveBeenCalled();
    expect(runtime.ai.persistence.consumeRateLimit).not.toHaveBeenCalled();
    expect(mocks.processAiCommandMessageWithRuntime).not.toHaveBeenCalled();
    expect(runtime.repository.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "ai-provider.realtime-tool-failed",
        metadata: { tool: "bea_preview_task" },
      }),
    );
  });

  it("rejects a registered tool omitted from the persisted selected-route allowlist", async () => {
    runtime.ai.persistence.getRealtimeSessionForUser.mockResolvedValueOnce({
      ...session(),
      routeDecision: {
        ...SESSION_ROUTE_DECISION,
        toolAllowlist: ["bea_preview_task"],
      },
    });
    const response = await executeRealtimeTool(
      mutation("https://bea.example/api/ai-command/realtime/tools/execute", {
        sessionId: SESSION_ID,
        conversationId: CONVERSATION_ID,
        callId: "call_disallowed_search",
        name: "search_web",
        arguments: { query: "This registered tool was not selected for the route" },
      }) as never,
    );

    expect(response.status).toBe(403);
    expect(runtime.authorization.requireUser).not.toHaveBeenCalled();
    expect(runtime.ai.persistence.consumeRateLimit).not.toHaveBeenCalled();
    expect(mocks.processAiCommandStream).not.toHaveBeenCalled();
    expect(runtime.repository.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "ai-provider.realtime-tool-failed",
        metadata: { tool: "search_web" },
      }),
    );
  });

  it("rejects exact-target workspace retrieval for unsupported record types", async () => {
    const response = await executeRealtimeTool(
      mutation("https://bea.example/api/ai-command/realtime/tools/execute", {
        sessionId: SESSION_ID,
        conversationId: CONVERSATION_ID,
        callId: "call_show_task",
        name: "bea_show_workspace",
        arguments: { target: "task", id: "a1000000-0000-4000-8000-000000000001" },
      }) as never,
    );
    expect(response.status).toBe(400);
    expect(mocks.processAiCommandMessageWithRuntime).not.toHaveBeenCalled();
  });

  it("rejects Realtime tool calls after the application session maximum", async () => {
    runtime.ai.persistence.getRealtimeSessionForUser.mockResolvedValueOnce({
      ...session(),
      authorizedAt: new Date(Date.now() - 16 * 60_000).toISOString(),
    });
    const response = await executeRealtimeTool(
      mutation("https://bea.example/api/ai-command/realtime/tools/execute", {
        sessionId: SESSION_ID,
        conversationId: CONVERSATION_ID,
        callId: "call_expired",
        name: "bea_preview_task",
        arguments: { request: "This session is too old" },
      }) as never,
    );
    expect(response.status).toBe(409);
    expect(runtime.ai.persistence.transitionRealtimeSession).toHaveBeenCalled();
    expect(mocks.processAiCommandMessageWithRuntime).not.toHaveBeenCalled();
  });
});
