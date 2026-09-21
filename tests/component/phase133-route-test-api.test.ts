import { beforeEach, describe, expect, it, vi } from "vitest";

import { createUnconfiguredAiRoutingProfile } from "../../packages/domain/src/index";
import { PERMISSIONS } from "../../packages/security/src/rbac";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const mocks = vi.hoisted(() => ({ requireAiApiContext: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/ai-command-api", () => ({
  requireAiApiContext: mocks.requireAiApiContext,
}));
vi.mock("@/lib/openai-api", () => ({
  openAiApiError: (error: unknown) =>
    new Response(
      JSON.stringify({ error: { message: error instanceof Error ? error.message : "failed" } }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    ),
}));

import { POST as testRoute } from "../../apps/web/app/api/integrations/ai/routes/test/route";

function mutation(value: Record<string, unknown>) {
  const body = JSON.stringify(value);
  return new Request("https://bea.example/api/integrations/ai/routes/test", {
    method: "POST",
    headers: {
      "Content-Length": String(new TextEncoder().encode(body).length),
      "Content-Type": "application/json",
    },
    body,
  });
}

const capabilities = {
  responsesText: true,
  streaming: true,
  reasoning: true,
  functionCalling: true,
  structuredOutputs: true,
  webSearch: true,
  fileSearch: true,
  codeInterpreter: true,
  imageGeneration: true,
  imageInput: true,
  fileInput: true,
  realtime: true,
  audioInput: true,
  audioOutput: true,
  embeddings: true,
};

describe("Phase 1.3.3 workload route test API", () => {
  const record = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    const base = createUnconfiguredAiRoutingProfile();
    const routingProfile = {
      ...base,
      routes: {
        ...base.routes,
        executive_conversation: {
          ...base.routes.executive_conversation,
          primaryModel: "primary-unavailable",
          fallbackModel: "fallback-verified",
        },
      },
    };
    record.mockResolvedValue({ id: "audit-route-test" });
    mocks.requireAiApiContext.mockResolvedValue({
      ok: true,
      userId: USER_ID,
      correlationId: "route-test-fixture",
      runtime: {
        ai: {
          persistence: {
            getProviderSettings: vi.fn(async () => ({
              routingProfile,
              modelCapabilityOverrides: {},
            })),
            listCachedModels: vi.fn(async () => [
              {
                provider: "openai",
                modelId: "primary-unavailable",
                available: false,
                ownedBy: "openai",
                capabilities,
                capabilitySource: "configured",
                validation: {
                  registryVersion: "phase1.3.3-test",
                  validatedAt: "2026-08-23T00:00:00.000Z",
                  validationMethod: "administrator",
                  evidence: {},
                },
              },
              {
                provider: "openai",
                modelId: "fallback-verified",
                available: true,
                ownedBy: "openai",
                capabilities,
                capabilitySource: "configured",
                validation: {
                  registryVersion: "phase1.3.3-test",
                  validatedAt: "2026-08-23T00:00:00.000Z",
                  validationMethod: "administrator",
                  evidence: {},
                },
              },
            ]),
          },
        },
        repository: {
          findActiveUserById: vi.fn(async () => ({ roleIds: ["owner-admin"] })),
          record,
        },
      },
    });
  });

  it("validates the configured fallback without making a provider call", async () => {
    const response = await testRoute(mutation({ routeKey: "executive_conversation" }) as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      validation: "configuration-only",
      providerCalled: false,
      decision: {
        routeKey: "executive_conversation",
        selectedModel: "fallback-verified",
        usedFallback: true,
      },
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "openai.routing.test",
        metadata: expect.objectContaining({
          routeKey: "executive_conversation",
          selectedModel: "fallback-verified",
          validation: "configuration-only",
          providerCalled: false,
        }),
      }),
    );
    expect(mocks.requireAiApiContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        permissions: [PERMISSIONS.INTEGRATIONS_MANAGE, PERMISSIONS.SETTINGS_MANAGE],
        strictMutation: true,
      }),
    );
  });

  it("rejects unknown and overbroad route-test requests", async () => {
    const response = await testRoute(
      mutation({ routeKey: "self_selected_route", model: "expensive-model" }) as never,
    );
    expect(response.status).toBe(400);
    expect(record).not.toHaveBeenCalled();
  });
});
