import { describe, expect, it, vi } from "vitest";

import {
  createOpenAiResponse,
  inferAiWorkloadRoute,
  listOpenAiVoices,
  ModelCapabilityRegistry,
  OPENAI_CAPABILITY_REGISTRY_VERSION,
  selectAiRoute,
  streamOpenAiResponse,
  UnavailableOpenAiProvider,
  type AiModelCapabilities,
  type AiModelMetadata,
  type OpenAiSdkClient,
} from "../../packages/ai/src/index.js";
import {
  AI_WORKLOAD_ROUTE_KEYS,
  createUnconfiguredAiRoutingProfile,
} from "../../packages/domain/src/index.js";
import {
  getPhase133AiProvenanceSchemaColumns,
  getPhase21PresentationSchemaColumns,
} from "../../packages/database/src/schema.js";

const verifiedCapabilities: AiModelCapabilities = {
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

function model(id: string, available = true): AiModelMetadata {
  return {
    id,
    provider: "openai",
    displayName: id,
    available,
    capabilities: verifiedCapabilities,
    capabilitySource: "configured",
    validation: {
      registryVersion: OPENAI_CAPABILITY_REGISTRY_VERSION,
      validatedAt: "2026-08-23T00:00:00.000Z",
      validationMethod: "administrator",
      evidence: {},
    },
  };
}

describe("Phase 1.3.3 OpenAI production routing", () => {
  it("gives explicit provider-tool intent precedence over ambiguous conversation text", () => {
    expect(
      inferAiWorkloadRoute({
        input: "Help me make something useful.",
        builtInTools: [{ type: "image_generation", partialImages: 1 }],
      }),
    ).toBe("image_generation");
    expect(
      inferAiWorkloadRoute({
        input: "Work through this carefully.",
        builtInTools: [
          { type: "code_interpreter", container: { type: "auto", memoryLimit: "4g" } },
        ],
      }),
    ).toBe("data_analysis_chart_preparation");
    expect(
      inferAiWorkloadRoute({
        input: "Find the answer.",
        builtInTools: [{ type: "web_search" }],
      }),
    ).toBe("public_web_research");
    expect(
      inferAiWorkloadRoute({
        input: "Describe the building shown in this image.",
        files: [{ type: "input_file", fileId: "file_authorized" }],
      }),
    ).toBe("vision_image_understanding");
  });

  it.each(AI_WORKLOAD_ROUTE_KEYS)(
    "selects the configured verified model and exact tool policy for %s",
    (routeKey) => {
      const base = createUnconfiguredAiRoutingProfile();
      const profile = {
        ...base,
        routes: {
          ...base.routes,
          [routeKey]: {
            ...base.routes[routeKey],
            primaryModel: `verified-${routeKey}`,
          },
        },
      };
      const decision = selectAiRoute({
        routeKey,
        profile,
        models: [model(`verified-${routeKey}`)],
        roleKey: "owner-admin",
        at: "2026-08-23T00:00:00.000Z",
      });
      expect(decision).toMatchObject({
        routeKey,
        selectedModel: `verified-${routeKey}`,
        usedFallback: false,
        requiredCapabilities: base.routes[routeKey].requiredCapabilities,
        toolAllowlist: base.routes[routeKey].toolAllowlist,
      });
      expect(base.routes[routeKey]).toMatchObject({
        enabled: true,
        maximumEstimatedCostUsd: null,
        roleAvailability: expect.arrayContaining(["owner-admin", "integration-admin"]),
      });
    },
  );

  it("defines every required workload route and fails closed until models are assigned", () => {
    const profile = createUnconfiguredAiRoutingProfile();
    expect(Object.keys(profile.routes)).toEqual([...AI_WORKLOAD_ROUTE_KEYS]);
    expect(AI_WORKLOAD_ROUTE_KEYS).toHaveLength(12);
    expect(profile.routes.realtime_voice.toolAllowlist).toEqual([
      "search_web",
      "bea_query_records",
      "bea_connector_health",
      "bea_workflow_history",
      "bea_preview_task",
      "bea_show_workspace",
      "bea_create_pdf",
      "bea_open_artifact",
      "bea_list_artifacts",
      "bea_download_artifact",
      "bea_revise_artifact",
      "bea_list_agents",
      "bea_get_agent",
      "bea_show_digital_workforce",
      "bea_get_agent_run",
      "bea_show_agent_run",
      "bea_delegate_to_agent",
      "bea_cancel_agent_run",
    ]);
    expect(() =>
      selectAiRoute({
        routeKey: "executive_conversation",
        profile,
        models: [model("verified-primary")],
        roleKey: "owner-admin",
      }),
    ).toThrow("not configured");
  });

  it("declares AI route and policy provenance on the correct typed database tables", () => {
    const columns = getPhase133AiProvenanceSchemaColumns();
    expect(columns.tasks).not.toContain("routeDecision");
    expect(columns.aiResponseRuns).toEqual(
      expect.arrayContaining(["policyProvenance", "routeDecision"]),
    );
    expect(columns.aiRealtimeSessions).toEqual(
      expect.arrayContaining(["conversationId", "policyProvenance", "routeDecision"]),
    );
  });

  it("adds presentation run persistence without replacing route provenance tables", () => {
    const columns = getPhase21PresentationSchemaColumns();
    expect(columns.aiPresentationRuns).toEqual(
      expect.arrayContaining([
        "conversationId",
        "packet",
        "selectedContext",
        "liveWebSearch",
        "autoFollow",
      ]),
    );
  });

  it("uses only a verified compatible fallback and records the decision", () => {
    const base = createUnconfiguredAiRoutingProfile();
    const profile = {
      ...base,
      routes: {
        ...base.routes,
        executive_conversation: {
          ...base.routes.executive_conversation,
          primaryModel: "primary",
          fallbackModel: "fallback",
        },
      },
    };
    const decision = selectAiRoute({
      routeKey: "executive_conversation",
      profile,
      models: [model("primary", false), model("fallback")],
      roleKey: "owner-admin",
      at: "2026-08-23T00:00:00.000Z",
    });
    expect(decision).toMatchObject({
      routeKey: "executive_conversation",
      selectedModel: "fallback",
      usedFallback: true,
      fallbackReason: "primary_incompatible",
    });
  });

  it("forwards the selected route reasoning policy to the Responses request", async () => {
    const base = createUnconfiguredAiRoutingProfile();
    const profile = {
      ...base,
      routes: {
        ...base.routes,
        complex_reasoning_strategy: {
          ...base.routes.complex_reasoning_strategy,
          primaryModel: "verified-reasoning",
        },
      },
    };
    const routeDecision = selectAiRoute({
      routeKey: "complex_reasoning_strategy",
      profile,
      models: [model("verified-reasoning")],
      roleKey: "owner-admin",
      at: "2026-08-23T00:00:00.000Z",
    });
    const create = vi.fn().mockResolvedValue({
      id: "resp_reasoning",
      model: "verified-reasoning",
      output_text: "Reasoned response.",
      output: [],
    });
    await createOpenAiResponse({ responses: { create } } as unknown as OpenAiSdkClient, {
      model: routeDecision.selectedModel,
      input: "Evaluate the strategic tradeoffs.",
      routeDecision,
      options: { requestId: "request-reasoning", correlationId: "correlation-reasoning" },
    });
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      model: "verified-reasoning",
      reasoning: { effort: "high" },
    });
  });

  it("keeps unknown capabilities fail closed and versioned", () => {
    const registry = new ModelCapabilityRegistry();
    expect(registry.version).toBe(OPENAI_CAPABILITY_REGISTRY_VERSION);
    expect(registry.supports("openai", "unverified-model", "fileSearch")).toBe(false);
    expect(registry.validation("openai", "unverified-model")).toMatchObject({
      validationMethod: "unknown",
      validatedAt: null,
    });
  });

  it("sends bounded authorized vector stores and retains File Search provenance", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "resp_file_search",
      model: "verified-primary",
      output_text: "The approved file contains the requested detail.",
      output: [
        {
          type: "file_search_call",
          id: "fs_1",
          status: "completed",
          results: [
            {
              file_id: "file_approved",
              filename: "approved.pdf",
              score: 0.9,
              text: "Approved excerpt",
              attributes: { vector_store_id: "vs_approved" },
            },
          ],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    });
    const client = { responses: { create } } as unknown as OpenAiSdkClient;
    const result = await createOpenAiResponse(client, {
      model: "verified-primary",
      input: "Search organizational knowledge",
      builtInTools: [{ type: "file_search", vectorStoreIds: ["vs_approved"], maxNumResults: 7 }],
      options: { requestId: "request-1", correlationId: "correlation-1" },
    });
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      tools: [{ type: "file_search", vector_store_ids: ["vs_approved"], max_num_results: 7 }],
      include: ["file_search_call.results"],
    });
    expect(result.fileSources).toEqual([
      expect.objectContaining({
        fileId: "file_approved",
        filename: "approved.pdf",
        vectorStoreId: "vs_approved",
        simulated: false,
      }),
    ]);
  });

  it("delivers bounded File Search provenance through the streaming contract", async () => {
    const completedResponse = {
      id: "resp_file_stream",
      model: "verified-primary",
      output_text: "Grounded answer.",
      output: [
        {
          type: "file_search_call",
          id: "fs_stream_1",
          status: "completed",
          results: [
            {
              file_id: "file_stream_approved",
              filename: "approved-stream.pdf",
              score: 0.75,
              text: "Bounded approved stream excerpt",
              attributes: { vector_store_id: "vs_stream_approved" },
            },
          ],
        },
      ],
    };
    const create = vi.fn().mockResolvedValue(
      (async function* () {
        yield { type: "response.created", response: completedResponse };
        yield { type: "response.completed", response: completedResponse };
      })(),
    );
    const client = { responses: { create } } as unknown as OpenAiSdkClient;
    const events: unknown[] = [];
    for await (const event of streamOpenAiResponse(client, {
      model: "verified-primary",
      input: "Search organizational knowledge",
      builtInTools: [{ type: "file_search", vectorStoreIds: ["vs_stream_approved"] }],
      options: { requestId: "request-stream", correlationId: "correlation-stream" },
    })) {
      events.push(event);
    }
    expect(events).toContainEqual({
      type: "response.file_source",
      source: expect.objectContaining({
        fileId: "file_stream_approved",
        filename: "approved-stream.pdf",
        vectorStoreId: "vs_stream_approved",
      }),
    });
  });

  it("exposes a fail-closed setup provider and a validated API voice default", async () => {
    const provider = new UnavailableOpenAiProvider();
    expect(provider.identity.requirementStatus).toBe("SETUP_REQUIRED");
    await expect(
      provider.generateResponse({
        model: "unconfigured",
        input: "hello",
        options: { requestId: "request-2", correlationId: "correlation-2" },
      }),
    ).rejects.toMatchObject({ code: "configuration", safeMessage: "OpenAI setup required." });
    expect(listOpenAiVoices().find((voice) => voice.id === "marin")).toMatchObject({
      source: "built_in",
      previewAvailable: true,
    });
  });
});
