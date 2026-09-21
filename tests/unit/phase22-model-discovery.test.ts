import { describe, expect, it, vi } from "vitest";

import { ModelCapabilityRegistry } from "../../packages/ai/src/capabilities.js";
import { listOpenAiModels } from "../../packages/ai/src/openai/models.js";
import { applyCapabilityEvidence } from "../../packages/ai/src/openai/capability-probes.js";
import { mergeUnknownWithFamily } from "../../packages/ai/src/openai/model-family-registry.js";
import {
  assessProgressiveActivation,
  recommendProjectAiRoutingProfile,
} from "../../packages/ai/src/progressive-activation.js";
import { normalizeAiProviderError } from "../../packages/ai/src/provider-errors.js";
import { selectAiRoute } from "../../packages/ai/src/routing.js";
import { createUnconfiguredAiRoutingProfile } from "../../packages/domain/src/ai-routing.js";
import { EnvironmentSecretProvider } from "../../packages/config/src/secrets.js";
import { trustedRequestOrigins } from "../../packages/config/src/trusted-origins.js";
import type { AiModelCapabilities, AiModelMetadata } from "../../packages/ai/src/contracts.js";

const unknownCapabilities = Object.freeze<AiModelCapabilities>({
  responsesText: "unknown",
  streaming: "unknown",
  reasoning: "unknown",
  functionCalling: "unknown",
  structuredOutputs: "unknown",
  webSearch: "unknown",
  fileSearch: "unknown",
  codeInterpreter: "unknown",
  imageGeneration: "unknown",
  imageInput: "unknown",
  fileInput: "unknown",
  realtime: "unknown",
  audioInput: "unknown",
  audioOutput: "unknown",
  embeddings: "unknown",
});

function model(id: string, capabilities: Partial<AiModelCapabilities> = {}): AiModelMetadata {
  return mergeUnknownWithFamily({
    id,
    provider: "openai",
    displayName: id,
    available: true,
    capabilities: { ...unknownCapabilities, ...capabilities },
    capabilitySource: "unknown",
    validation: {
      registryVersion: "test",
      validatedAt: null,
      validationMethod: "unknown",
      evidence: {},
    },
  });
}

describe("Phase 2.2 live model discovery recovery", () => {
  it("labels a Cloud runtime secret as server_runtime without requiring DPAPI", () => {
    const fixtureSecret = ["s", "k", "-", "bea-fixture-runtime-secret-0001"].join("");
    const descriptor = new EnvironmentSecretProvider({
      OPENAI_API_KEY: fixtureSecret,
      BEA_DISABLE_ENV_FILE: "true",
    }).describe();
    expect(descriptor.status).toBe("configured");
    expect(descriptor.source).toBe("server_runtime");
    expect(JSON.stringify(descriptor)).not.toContain("bea-fixture-runtime-secret");
  });

  it("lists returned models even when capabilities start unknown", async () => {
    const listed = await listOpenAiModels(
      {
        models: {
          list: vi.fn(async () => ({
            data: [
              { id: "gpt-5.6-sol", owned_by: "openai" },
              { id: "mal formed" },
              { id: "gpt-4.1" },
            ],
            hasNextPage: () => false,
          })),
        },
        responses: { create: vi.fn() },
        files: { create: vi.fn() },
        realtime: { clientSecrets: { create: vi.fn() } },
        containers: { files: { content: { retrieve: vi.fn() } } },
      } as never,
      new ModelCapabilityRegistry(),
    );
    expect(listed.map((item) => item.id)).toEqual(["gpt-4.1", "gpt-5.6-sol"]);
    expect(listed.every((item) => item.available)).toBe(true);
    expect(listed.find((item) => item.id === "gpt-5.6-sol")?.capabilities.responsesText).toBe(
      "candidate",
    );
  });

  it("maps 401, 403, 429, and timeout to owner-facing messages", () => {
    expect(normalizeAiProviderError({ status: 401 }).safeMessage).toMatch(
      /project key was rejected/u,
    );
    expect(normalizeAiProviderError({ status: 403 }).safeMessage).toMatch(
      /does not have permission/u,
    );
    expect(normalizeAiProviderError({ status: 429 }).safeMessage).toMatch(
      /quota, billing capacity, or is currently rate limited/u,
    );
    expect(normalizeAiProviderError({ name: "APIConnectionTimeoutError" }).safeMessage).toMatch(
      /did not respond before the configured timeout/u,
    );
  });

  it("recommends only project-returned models and keeps ChatGPT-only IDs off API routes", () => {
    const recommended = recommendProjectAiRoutingProfile(createUnconfiguredAiRoutingProfile(), [
      model("chatgpt-latest"),
      model("gpt-5.6-sol", { responsesText: true, streaming: true, reasoning: true }),
      model("gpt-5.6-luna", { responsesText: true, streaming: true }),
    ]);
    expect(recommended.routes.executive_conversation.primaryModel).toBe("gpt-5.6-sol");
    expect(recommended.routes.fast_general_conversation.primaryModel).toBe("gpt-5.6-luna");
    expect(recommended.routes.executive_conversation.primaryModel).not.toBe("chatgpt-latest");
  });

  it("prefers GPT-5.6 and Realtime 2.1 aliases over older families when both are unverified", () => {
    const recommended = recommendProjectAiRoutingProfile(createUnconfiguredAiRoutingProfile(), [
      model("gpt-4.1"),
      model("gpt-4o"),
      model("gpt-5.6-sol"),
      model("gpt-5.6-luna"),
      model("gpt-5.6-terra"),
      model("gpt-realtime"),
      model("gpt-realtime-2.1"),
      model("o1"),
    ]);
    expect(recommended.routes.executive_conversation.primaryModel).toBe("gpt-5.6-sol");
    expect(recommended.routes.fast_general_conversation.primaryModel).toBe("gpt-5.6-luna");
    expect(recommended.routes.complex_reasoning_strategy.primaryModel).toBe("gpt-5.6-sol");
    expect(recommended.routes.public_web_research.primaryModel).toBe("gpt-5.6-terra");
    expect(recommended.routes.realtime_voice.primaryModel).toBe("gpt-realtime-2.1");
  });

  it("treats a verified Web Search Responses call as streaming-ready for research routes", () => {
    const terra = model("gpt-5.6-terra", {
      responsesText: true,
      webSearch: true,
      streaming: "candidate",
    });
    const profile = recommendProjectAiRoutingProfile(createUnconfiguredAiRoutingProfile(), [terra]);
    expect(() =>
      selectAiRoute({
        routeKey: "public_web_research",
        profile: {
          ...profile,
          routes: {
            ...profile.routes,
            public_web_research: {
              ...profile.routes.public_web_research,
              primaryModel: "gpt-5.6-terra",
              enabled: true,
            },
          },
        },
        models: [terra],
        roleKey: "owner-admin",
      }),
    ).not.toThrow();
  });

  it("activates live text without Web Search or Realtime", () => {
    const profile = recommendProjectAiRoutingProfile(createUnconfiguredAiRoutingProfile(), [
      model("gpt-5.6-sol", { responsesText: true, streaming: true, reasoning: true }),
    ]);
    const state = assessProgressiveActivation({
      authenticated: true,
      models: [model("gpt-5.6-sol", { responsesText: true, streaming: true, reasoning: true })],
      profile,
      webSearchEnabled: false,
      realtimeEnabled: false,
      realtimeVoiceSelected: false,
    });
    expect(state.liveTextReady).toBe(true);
    expect(state.researchReady).toBe(false);
    expect(state.realtimeReady).toBe(false);
    expect(() =>
      selectAiRoute({
        routeKey: "executive_conversation",
        profile,
        models: [model("gpt-5.6-sol", { responsesText: true, streaming: true, reasoning: true })],
        roleKey: "owner-admin",
      }),
    ).not.toThrow();
  });

  it("does not treat unknown capabilities as verified activation evidence", () => {
    const unknown = model("mystery-model");
    const profile = {
      ...createUnconfiguredAiRoutingProfile(),
      routes: {
        ...createUnconfiguredAiRoutingProfile().routes,
        executive_conversation: {
          ...createUnconfiguredAiRoutingProfile().routes.executive_conversation,
          primaryModel: "mystery-model",
        },
      },
    };
    const state = assessProgressiveActivation({
      authenticated: true,
      models: [unknown],
      profile,
      webSearchEnabled: false,
      realtimeEnabled: false,
      realtimeVoiceSelected: false,
    });
    expect(state.liveTextReady).toBe(false);
    const probed = applyCapabilityEvidence(
      unknown.capabilities,
      [
        {
          modelId: "mystery-model",
          capability: "responsesText",
          status: "verified",
          verificationMethod: "provider_probe",
          verifiedAt: "2026-08-31T00:00:00.000Z",
          providerRequestId: "resp_safe",
          safeFailureCode: null,
          registryVersion: "test",
        },
        {
          modelId: "mystery-model",
          capability: "streaming",
          status: "verified",
          verificationMethod: "provider_probe",
          verifiedAt: "2026-08-31T00:00:00.000Z",
          providerRequestId: "resp_safe",
          safeFailureCode: null,
          registryVersion: "test",
        },
      ],
      "mystery-model",
    );
    expect(probed.responsesText).toBe(true);
    expect(probed.streaming).toBe(true);
  });

  it("allowlists an exact Owner Evaluation public origin without wildcards", () => {
    const origins = trustedRequestOrigins({
      appBaseUrl: "http://127.0.0.1:3300",
      deploymentProfile: "owner-evaluation",
      ownerEvaluationPublicOrigin: "https://cursor.example",
    });
    expect(origins).toEqual(
      expect.arrayContaining([
        "http://127.0.0.1:3300",
        "http://localhost:3300",
        "https://cursor.example",
      ]),
    );
    expect(origins.join(" ")).not.toContain("*");
  });
});
