import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BEA_GENERATED_ARTIFACT_TOOLS,
  BEA_REALTIME_TOOL_NAMES,
  BEA_REALTIME_TOOLS,
  DemoStreamingAiProvider,
  ModelCapabilityRegistry,
  MAX_AI_GENERATED_ARTIFACT_BYTES,
  OpenAiProvider,
  createOpenAiRealtimeClientAuthorization,
  createOpenAiResponse,
  listOpenAiModels,
  normalizeAiProviderError,
  streamOpenAiResponse,
  uploadOpenAiInputFile,
  type AiConversationRequest,
  type OpenAiSdkClient,
} from "../index.js";
import { extractOpenAiResponseMetadata, normalizeOpenAiUsage } from "./web-search.js";

const keyShapedSentinel = ["s", "k", "-", "raw"].join("");
const logSecretSentinel = `SENTINEL_SECRET_LOG=${["s", "k", "-", "never-persist"].join("")}`;
const providerPayloadSecretSentinel = `SENTINEL_PROVIDER_SECRET_${["s", "k", "-", "never-leave-ai"].join("")}`;

function sdkClient(overrides: Partial<OpenAiSdkClient> = {}): OpenAiSdkClient {
  return {
    responses: { create: vi.fn(async () => ({})) },
    models: { list: vi.fn(async () => ({ data: [] })) },
    files: { create: vi.fn(async () => ({ id: "file_fixture" })) },
    realtime: {
      clientSecrets: {
        create: vi.fn(async () => ({ value: "ek_fixture", expires_at: 1_800_000_000 })),
      },
    },
    containers: {
      files: {
        content: {
          retrieve: vi.fn(async () => new Response(new Uint8Array([1]))),
        },
      },
    },
    ...overrides,
  } as OpenAiSdkClient;
}

function request(overrides: Partial<AiConversationRequest> = {}): AiConversationRequest {
  return {
    model: "gpt-fixture",
    input: "Review the synthetic fixture",
    options: {
      requestId: "request_fixture",
      correlationId: "correlation_fixture",
      userSafetyIdentifier: "f".repeat(64),
      timeoutMs: 12_000,
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("OpenAI provider safe error normalization", () => {
  it.each([
    [
      { name: "APIConnectionTimeoutError", message: `secret bearer ${keyShapedSentinel}` },
      "timeout",
      true,
    ],
    [{ name: "AbortError", message: `secret bearer ${keyShapedSentinel}` }, "cancelled", false],
    [{ status: 401, message: `secret bearer ${keyShapedSentinel}` }, "authentication", false],
    [
      { status: 429, code: "insufficient_quota", message: `secret bearer ${keyShapedSentinel}` },
      "quota",
      false,
    ],
    [
      { status: 429, code: "rate_limit_exceeded", message: `secret bearer ${keyShapedSentinel}` },
      "rate_limit",
      true,
    ],
    [
      {
        name: "APIConnectionError",
        code: "ECONNRESET",
        message: `secret bearer ${keyShapedSentinel}`,
      },
      "unavailable",
      true,
    ],
    [{ status: 503, message: `secret bearer ${keyShapedSentinel}` }, "unavailable", true],
  ])(
    "normalizes timeout cancel auth quota rate network and unavailable without raw causes",
    (failure, code, retryable) => {
      const normalized = normalizeAiProviderError(failure);
      expect(normalized).toMatchObject({ code, retryable });
      expect(normalized.message).not.toContain(keyShapedSentinel);
      expect(normalized).not.toHaveProperty("cause");
    },
  );
});

describe("OpenAI model discovery and fail-closed capabilities", () => {
  it("bounds pagination, rejects malformed metadata, deduplicates IDs, and guards dates", async () => {
    const values: unknown[] = [
      { id: "gpt-valid", created: 1_700_000_000, owned_by: "openai\u0000fixture" },
      { id: "gpt-valid", created: Number.POSITIVE_INFINITY },
      { id: "bad control\u0000id" },
      { id: "x".repeat(300) },
      ["array-model-must-not-be-record"],
      ...Array.from({ length: 700 }, (_, index) => ({ id: `gpt-${index}` })),
    ];
    const page = {
      async *[Symbol.asyncIterator]() {
        for (const value of values) yield value;
      },
    };
    const models = await listOpenAiModels(
      sdkClient({ models: { list: vi.fn(async () => page) } }),
      new ModelCapabilityRegistry([
        { provider: "openai", model: "gpt-valid", capabilities: { responsesText: true } },
      ]),
    );
    expect(models.length).toBeGreaterThan(490);
    expect(models.length).toBeLessThanOrEqual(500);
    expect(models.find((model) => model.id === "gpt-valid")).toMatchObject({
      capabilities: { responsesText: true, streaming: "unknown" },
      capabilitySource: "configured",
    });
    expect(models.some((model) => model.id.includes("\u0000") || model.id.length > 255)).toBe(
      false,
    );
    expect(new ModelCapabilityRegistry().supports("openai", "unknown-model", "streaming")).toBe(
      false,
    );
  });
});

describe("OpenAI Responses streaming web citations and generated files", () => {
  it("constructs current Responses tools and sanitizes sources citations files usage and provider fields", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    let capturedOptions: unknown;
    const rawResponse = {
      id: "bad\u0000response-id",
      model: "bad\u0000model",
      output_text: "Synthetic answer",
      output: [
        {
          type: "function_call",
          id: "fn_1",
          call_id: "call_1",
          name: "bea_research",
          arguments: "[]",
        },
        {
          type: "web_search_call",
          id: "ws_1",
          status: "completed",
          action: {
            type: "search",
            query: "synthetic envelope market",
            sources: [
              { title: "Safe source", url: "https://example.invalid/source" },
              { title: "Downgrade", url: "http://example.invalid/insecure" },
              { title: "Script", url: "javascript:alert(1)" },
            ],
          },
        },
        {
          type: "code_interpreter_call",
          id: "ci_1",
          status: "completed",
          container_id: "container_1",
          outputs: [
            { type: "logs", logs: logSecretSentinel },
            { type: "image", url: "https://example.invalid/container-image" },
            { type: "file", file_id: "file_1", filename: "analysis.csv" },
          ],
        },
        {
          type: "message",
          id: "message_1",
          content: [
            {
              type: "output_text",
              text: "Synthetic answer",
              annotations: [
                {
                  type: "url_citation",
                  start_index: 0,
                  end_index: 9,
                  title: "Safe source",
                  url: "https://example.invalid/source",
                },
                {
                  type: "url_citation",
                  start_index: -1,
                  end_index: 999,
                  title: "Unsafe",
                  url: "javascript:alert(1)",
                },
                {
                  type: "container_file_citation",
                  container_id: "container_1",
                  file_id: "file_1",
                  filename: "analysis.csv",
                },
              ],
            },
          ],
        },
      ],
      usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
    };
    const client = sdkClient({
      responses: {
        create: vi.fn(async (body, options) => {
          capturedBody = body;
          capturedOptions = options;
          return rawResponse;
        }),
      },
    });
    const result = await createOpenAiResponse(
      client,
      request({
        history: [{ role: "assistant", content: "Authorized history" }],
        previousResponseId: "bad\u0000previous-id",
        tools: BEA_GENERATED_ARTIFACT_TOOLS,
        builtInTools: [
          { type: "web_search" },
          { type: "code_interpreter", container: { type: "auto", memoryLimit: "4g" } },
          { type: "image_generation", partialImages: 2, quality: "low" },
        ],
      }),
    );
    expect(capturedBody).not.toHaveProperty("previous_response_id");
    expect(capturedBody?.input).toEqual([
      { role: "assistant", content: "Authorized history" },
      { role: "user", content: "Review the synthetic fixture" },
    ]);
    expect(capturedBody?.include).toEqual([
      "web_search_call.action.sources",
      "code_interpreter_call.outputs",
    ]);
    expect(capturedBody?.tools).toEqual(
      expect.arrayContaining([
        { type: "web_search" },
        { type: "code_interpreter", container: { type: "auto", memory_limit: "4g" } },
        { type: "image_generation", partial_images: 2, quality: "low" },
      ]),
    );
    expect(capturedBody?.safety_identifier).toBe("f".repeat(64));
    expect(capturedOptions).toMatchObject({
      timeout: 12_000,
      headers: { "OpenAI-Safety-Identifier": "f".repeat(64) },
    });
    expect(result).toMatchObject({
      responseId: "openai-response-request_fixture",
      model: "gpt-fixture",
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
    });
    expect(result.webSources).toHaveLength(1);
    expect(result.citations).toHaveLength(1);
    expect(result.generatedArtifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "container_file",
          containerId: "container_1",
          fileId: "file_1",
        }),
      ]),
    );
    expect(result.toolCalls.find((call) => call.id === "call_1")).toMatchObject({
      arguments: {},
      status: "rejected",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(logSecretSentinel);
    expect(serialized).not.toContain("javascript:");
    expect(serialized).not.toContain("http://example.invalid");
  });

  it("emits only schema-valid registered arguments and credential-safe built-in metadata", () => {
    const validArguments = {
      title: "Synthetic comparison",
      sourceArtifactId: "art_synthetic_source",
      chartType: "bar",
      xField: "category",
      yFields: ["value"],
    };
    const metadata = extractOpenAiResponseMetadata({
      id: "resp_secret_boundary",
      output: [
        {
          type: "function_call",
          id: "fn_valid",
          call_id: "call_valid",
          name: "bea_create_chart",
          arguments: JSON.stringify(validArguments),
        },
        {
          type: "function_call",
          id: "fn_unknown",
          call_id: "call_unknown",
          name: "unknown_provider_tool",
          arguments: JSON.stringify({ nested: { secret: providerPayloadSecretSentinel } }),
        },
        {
          type: "function_call",
          id: "fn_invalid",
          call_id: "call_invalid",
          name: "bea_research",
          arguments: JSON.stringify({
            title: "Synthetic research",
            query: "synthetic envelope",
            secret: providerPayloadSecretSentinel,
          }),
        },
        {
          type: "function_call",
          id: "fn_malformed",
          call_id: "call_malformed",
          name: "bea_research",
          arguments: `{"title":"${providerPayloadSecretSentinel}"`,
        },
        {
          type: "function_call",
          id: "fn_oversized",
          call_id: "call_oversized",
          name: "bea_research",
          arguments: JSON.stringify({
            title: "Synthetic research",
            query: "x".repeat(65_536),
            secret: providerPayloadSecretSentinel,
          }),
        },
        {
          type: "web_search_call",
          id: "ws_secret_boundary",
          status: "completed",
          action: {
            type: "search",
            query: providerPayloadSecretSentinel,
            sources: [
              {
                title: "Ordinary source",
                url: `https://example.invalid/public?page=2#${providerPayloadSecretSentinel}`,
              },
              {
                title: "Credential query",
                url: `https://example.invalid/private?access_token=${providerPayloadSecretSentinel}`,
              },
              {
                title: "Credential value under an ordinary key",
                url: `https://example.invalid/private?page=${providerPayloadSecretSentinel}`,
              },
              {
                title: "Credential value in a path",
                url: `https://example.invalid/private/${providerPayloadSecretSentinel}/source`,
              },
              {
                title: "Oversized source URL",
                url: `https://example.invalid/${"x".repeat(1_100)}`,
              },
              {
                title: "Excessive source query",
                url: `https://example.invalid/query?${Array.from({ length: 33 }, (_, index) => `p${index}=safe`).join("&")}`,
              },
              {
                title: "Credential userinfo",
                url: `https://${providerPayloadSecretSentinel}:password@example.invalid/private`,
              },
            ],
          },
        },
        {
          type: "message",
          id: "message_secret_boundary",
          content: [
            {
              type: "output_text",
              text: "Synthetic source",
              annotations: [
                {
                  type: "url_citation",
                  title: "Ordinary citation",
                  url: `https://example.invalid/citation?page=2#${providerPayloadSecretSentinel}`,
                },
                {
                  type: "url_citation",
                  title: "Credential citation",
                  url: `https://example.invalid/private?api_key=${providerPayloadSecretSentinel}`,
                },
                {
                  type: "url_citation",
                  title: "Credential citation value under an ordinary key",
                  url: `https://example.invalid/private?page=${providerPayloadSecretSentinel}`,
                },
                {
                  type: "url_citation",
                  title: "Credential citation value in a path",
                  url: `https://example.invalid/private/${providerPayloadSecretSentinel}/citation`,
                },
              ],
            },
          ],
        },
      ],
    });

    expect(metadata.toolCalls.find((call) => call.id === "call_valid")).toMatchObject({
      arguments: validArguments,
      status: "proposed",
    });
    for (const id of ["call_unknown", "call_invalid", "call_malformed", "call_oversized"]) {
      expect(metadata.toolCalls.find((call) => call.id === id)).toMatchObject({
        arguments: {},
        status: "rejected",
      });
    }
    expect(metadata.toolCalls.find((call) => call.id === "ws_secret_boundary")?.arguments).toEqual({
      action: {
        type: "search",
        sources: [
          {
            title: "Ordinary source",
            url: "https://example.invalid/public?page=2",
            domain: "example.invalid",
          },
        ],
      },
    });
    expect(metadata.webSources.map((source) => source.url)).toEqual([
      "https://example.invalid/public?page=2",
    ]);
    expect(metadata.citations.map((citation) => citation.url)).toEqual([
      "https://example.invalid/citation?page=2",
    ]);
    expect(JSON.stringify(metadata)).not.toContain(providerPayloadSecretSentinel);
  });

  it("streams deltas usage and completion and maps abort timeout safely", async () => {
    async function* completedStream() {
      yield { type: "response.created", response: { id: "resp_1", model: "gpt-fixture" } };
      yield { type: "response.output_text.delta", delta: "Synthetic" };
      yield {
        type: "response.completed",
        response: {
          id: "resp_1",
          model: "gpt-fixture",
          output_text: "Synthetic",
          output: [],
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      };
    }
    const events = [];
    for await (const event of streamOpenAiResponse(
      sdkClient({ responses: { create: vi.fn(async () => completedStream()) } }),
      request(),
    ))
      events.push(event);
    expect(events.map((event) => event.type)).toEqual([
      "response.started",
      "response.output_text.delta",
      "response.usage",
      "response.completed",
    ]);

    async function* abortedStream() {
      yield { type: "response.output_text.delta", delta: "partial" };
      throw Object.assign(new Error("raw secret"), { name: "AbortError" });
    }
    const aborted = [];
    for await (const event of streamOpenAiResponse(
      sdkClient({ responses: { create: vi.fn(async () => abortedStream()) } }),
      request(),
    ))
      aborted.push(event);
    expect(aborted.at(-1)).toEqual({ type: "response.cancelled", requestId: "request_fixture" });
    expect(normalizeAiProviderError({ name: "APIConnectionTimeoutError" }).code).toBe("timeout");
  });

  it("bounds adversarial streamed text cumulatively and per delta", async () => {
    async function* adversarialStream() {
      yield {
        type: "response.created",
        response: { id: "resp_bounded_stream", model: "gpt-fixture" },
      };
      yield { type: "response.output_text.delta", delta: "a".repeat(12_000) };
      yield { type: "response.output_text.delta", delta: "b".repeat(12_000) };
      yield { type: "response.output_text.delta", delta: providerPayloadSecretSentinel };
      yield {
        type: "response.completed",
        response: {
          id: "resp_bounded_stream",
          model: "gpt-fixture",
          output_text: "a".repeat(20_000),
          output: [],
        },
      };
    }

    const events = [];
    for await (const event of streamOpenAiResponse(
      sdkClient({ responses: { create: vi.fn(async () => adversarialStream()) } }),
      request(),
    ))
      events.push(event);
    const deltas = events.flatMap((event) =>
      event.type === "response.output_text.delta" ? [event.delta] : [],
    );

    expect(deltas.every((delta) => delta.length <= 4_096)).toBe(true);
    expect(deltas.join("")).toBe(`${"a".repeat(12_000)}${"b".repeat(8_000)}`);
    expect(deltas.join("")).toHaveLength(20_000);
    expect(JSON.stringify(events)).not.toContain(providerPayloadSecretSentinel);
  });

  it("drops excess partial-image events and keeps serialized stream output bounded", async () => {
    const rawPartialImage = `${providerPayloadSecretSentinel}${"A".repeat(100_000)}`;
    const maximumLengthItemId = "i".repeat(200);

    async function* adversarialPartialImageStream() {
      yield {
        type: "response.created",
        response: { id: "resp_bounded_images", model: "gpt-fixture" },
      };
      for (let index = 0; index < 1_000; index += 1) {
        yield {
          type: "response.image_generation_call.partial_image",
          item_id: maximumLengthItemId,
          partial_image_index: index,
          partial_image_b64: rawPartialImage,
        };
      }
      yield {
        type: "response.completed",
        response: {
          id: "resp_bounded_images",
          model: "gpt-fixture",
          output_text: "",
          output: [],
        },
      };
    }

    const events = [];
    for await (const event of streamOpenAiResponse(
      sdkClient({
        responses: { create: vi.fn(async () => adversarialPartialImageStream()) },
      }),
      request(),
    ))
      events.push(event);
    const partialArtifacts = events.flatMap((event) =>
      event.type === "response.generated_artifact" ? [event.artifact] : [],
    );
    const serialized = JSON.stringify(events);

    expect(partialArtifacts).toHaveLength(32);
    expect(partialArtifacts.map((artifact) => artifact.partialImageIndex)).toEqual(
      Array.from({ length: 32 }, (_, index) => index),
    );
    expect(events.at(-1)?.type).toBe("response.completed");
    expect(serialized).not.toContain(providerPayloadSecretSentinel);
    expect(new TextEncoder().encode(serialized).length).toBeLessThan(24 * 1_024);
  });

  it("bounds adversarial provider collections text and token usage metadata", () => {
    const annotations = Array.from({ length: 1_000 }, (_, index) => ({
      type: "url_citation",
      start_index: 0,
      end_index: 1,
      title: `Source ${index}`,
      url: `https://example.invalid/source-${index}`,
    }));
    const functionCalls = Array.from({ length: 300 }, (_, index) => ({
      type: "function_call",
      id: `fn_${index}`,
      call_id: `call_${index}`,
      name: "bea_research",
      arguments: "{}",
    }));
    const metadata = extractOpenAiResponseMetadata({
      id: "resp_bounded",
      output_text: "x".repeat(100_000),
      output: [
        {
          type: "message",
          id: "message_bounded",
          content: [{ type: "output_text", text: "x", annotations }],
        },
        ...functionCalls,
      ],
      usage: {
        input_tokens: -1,
        output_tokens: Number.POSITIVE_INFINITY,
        total_tokens: 1.5,
        output_tokens_details: { reasoning_tokens: Number.NaN },
        input_tokens_details: { cached_tokens: 1_000_000_001 },
      },
    });
    expect(metadata.text).toHaveLength(20_000);
    expect(metadata.citations.length).toBeLessThanOrEqual(64);
    expect(metadata.toolCalls.length).toBeLessThanOrEqual(32);
    expect(new TextEncoder().encode(JSON.stringify(metadata)).length).toBeLessThan(192 * 1_024);
    expect(metadata.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect(normalizeOpenAiUsage({ input_tokens: 2, output_tokens: 3 })).toEqual({
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 5,
    });
  });
});

describe("OpenAI Realtime client secret and Files API contracts", () => {
  it("mints current short-lived Realtime config with allowlisted tools and no standard key DTO", async () => {
    let captured: unknown;
    let capturedOptions: unknown;
    const authorization = await createOpenAiRealtimeClientAuthorization(
      sdkClient({
        realtime: {
          clientSecrets: {
            create: vi.fn(async (body, options) => {
              captured = body;
              capturedOptions = options;
              return {
                value: "ek_short_lived",
                expires_at: 1_800_000_000,
                session: { id: "sess_1" },
              };
            }),
          },
        },
      }),
      {
        model: "gpt-realtime",
        voice: "marin",
        modalities: ["audio"],
        tools: BEA_REALTIME_TOOLS,
        turnDetection: "semantic_vad",
        interactionMode: "automatic",
        allowInterruption: false,
        inputTranscriptionModel: "gpt-4o-mini-transcribe",
        outputSpeed: 1.25,
        maxOutputTokens: 1024,
      },
      request().options,
    );
    expect(captured).toMatchObject({
      expires_after: { anchor: "created_at", seconds: 60 },
      session: {
        type: "realtime",
        model: "gpt-realtime",
        audio: {
          input: {
            turn_detection: {
              type: "semantic_vad",
              create_response: true,
              interrupt_response: false,
            },
            transcription: { model: "gpt-4o-mini-transcribe" },
          },
          output: { voice: "marin", speed: 1.25 },
        },
        max_output_tokens: 1024,
        tool_choice: "auto",
      },
    });
    expect(capturedOptions).toMatchObject({
      headers: { "OpenAI-Safety-Identifier": "f".repeat(64) },
    });
    expect(
      (captured as { session: { tools: readonly { name: string }[] } }).session.tools.map(
        (tool) => tool.name,
      ),
    ).toEqual([
      BEA_REALTIME_TOOL_NAMES.SEARCH_WEB,
      BEA_REALTIME_TOOL_NAMES.QUERY_RECORDS,
      BEA_REALTIME_TOOL_NAMES.CONNECTOR_HEALTH,
      BEA_REALTIME_TOOL_NAMES.WORKFLOW_HISTORY,
      BEA_REALTIME_TOOL_NAMES.PREVIEW_TASK,
      BEA_REALTIME_TOOL_NAMES.SHOW_WORKSPACE,
      BEA_REALTIME_TOOL_NAMES.CREATE_PDF,
      BEA_REALTIME_TOOL_NAMES.OPEN_ARTIFACT,
      BEA_REALTIME_TOOL_NAMES.LIST_ARTIFACTS,
      BEA_REALTIME_TOOL_NAMES.DOWNLOAD_ARTIFACT,
      BEA_REALTIME_TOOL_NAMES.REVISE_ARTIFACT,
      BEA_REALTIME_TOOL_NAMES.LIST_AGENTS,
      BEA_REALTIME_TOOL_NAMES.GET_AGENT,
      BEA_REALTIME_TOOL_NAMES.SHOW_DIGITAL_WORKFORCE,
      BEA_REALTIME_TOOL_NAMES.GET_AGENT_RUN,
      BEA_REALTIME_TOOL_NAMES.SHOW_AGENT_RUN,
      BEA_REALTIME_TOOL_NAMES.DELEGATE_TO_AGENT,
      BEA_REALTIME_TOOL_NAMES.CANCEL_AGENT_RUN,
    ]);
    expect(authorization).toEqual({
      provider: "openai",
      clientSecret: "ek_short_lived",
      expiresAt: new Date(1_800_000_000 * 1000).toISOString(),
      sessionId: "sess_1",
      model: "gpt-realtime",
      voice: "marin",
      simulated: false,
    });
    expect(JSON.stringify(authorization)).not.toMatch(
      new RegExp(`api.?key|${["s", "k", "-"].join("")}`, "iu"),
    );
  });

  it("rejects a standard credential returned from the Realtime client-secret boundary", async () => {
    await expect(
      createOpenAiRealtimeClientAuthorization(
        sdkClient({
          realtime: {
            clientSecrets: {
              create: vi.fn(async () => ({
                value: "standard-api-key-sentinel-must-never-reach-browser",
                expires_at: 1_800_000_000,
              })),
            },
          },
        }),
        { model: "gpt-realtime", voice: "marin", modalities: ["audio"] },
        request().options,
      ),
    ).rejects.toMatchObject({
      code: "unavailable",
      safeMessage: "OpenAI did not return valid short-lived Realtime authorization.",
    });
  });

  it("uploads authorized server bytes with Files purpose user_data and returns only a file reference", async () => {
    let captured: { readonly purpose: string; readonly file: File } | undefined;
    const reference = await uploadOpenAiInputFile(
      sdkClient({
        files: {
          create: vi.fn(async (body) => {
            captured = body;
            return { id: "file_user_data_1", bytes: "raw provider payload must be omitted" };
          }),
        },
      }),
      {
        ownerId: "owner-1",
        artifactId: "artifact-1",
        filename: "synthetic.csv",
        mimeType: "text/csv",
        bytes: new TextEncoder().encode("name,value\nfixture,1"),
        detail: "high",
      },
      { timeoutMs: 5_000 },
    );
    expect(captured?.purpose).toBe("user_data");
    expect(captured?.file).toMatchObject({ name: "synthetic.csv", type: "text/csv" });
    expect(reference).toEqual({ type: "input_file", fileId: "file_user_data_1", detail: "high" });
    expect(JSON.stringify(reference)).not.toContain("fixture,1");
  });
});

describe("OpenAI generated image ephemeral content handoff", () => {
  it("keeps image base64 out of DTOs and allows one bounded server-only retrieval", async () => {
    const provider = new OpenAiProvider({
      client: sdkClient({
        responses: {
          create: vi.fn(async () => ({
            id: "resp_image",
            model: "gpt-fixture",
            output_text: "Image generated",
            output: [
              { type: "image_generation_call", id: "image_1", status: "completed", result: "AQID" },
            ],
          })),
        },
      }),
      defaultModel: "gpt-fixture",
      connectionEvidenceVerified: true,
    });
    const result = await provider.generateResponse(request());
    const image = result.generatedArtifacts[0];
    if (!image) throw new Error("Expected generated image reference.");
    expect(JSON.stringify(result)).not.toContain("AQID");
    await expect(provider.fetchGeneratedArtifactContent(image, {})).resolves.toMatchObject({
      artifactId: image.id,
      mediaType: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
    });
    await expect(provider.fetchGeneratedArtifactContent(image, {})).resolves.toBeNull();
  });

  it("expires unconsumed generated image bytes after five minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    const provider = new OpenAiProvider({
      client: sdkClient({
        responses: {
          create: vi.fn(async () => ({
            id: "resp_expiring",
            model: "gpt-fixture",
            output_text: "Image generated",
            output: [
              {
                type: "image_generation_call",
                id: "image_expiring",
                status: "completed",
                result: "AQID",
              },
            ],
          })),
        },
      }),
      defaultModel: "gpt-fixture",
    });
    const result = await provider.generateResponse(request());
    vi.advanceTimersByTime(300_001);
    await expect(
      provider.fetchGeneratedArtifactContent(result.generatedArtifacts[0]!, {}),
    ).resolves.toBeNull();
  });

  it("cancels and releases an oversized streaming container-file response before concatenation", async () => {
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const read = vi.fn(async () => ({
      done: false as const,
      value: new Uint8Array(MAX_AI_GENERATED_ARTIFACT_BYTES + 1),
    }));
    const response = {
      body: { getReader: () => ({ cancel, read, releaseLock }) },
      headers: new Headers({ "content-type": "text/csv" }),
    } as unknown as Response;
    const provider = new OpenAiProvider({
      client: sdkClient({
        containers: {
          files: { content: { retrieve: vi.fn(async () => response) } },
        },
      }),
      defaultModel: "gpt-fixture",
    });
    await expect(
      provider.fetchGeneratedArtifactContent(
        {
          id: "container-file-1",
          kind: "container_file",
          providerItemId: "ci_1",
          containerId: "container_1",
          fileId: "file_1",
          filename: "analysis.csv",
          simulated: false,
          rawBytesPersisted: false,
        },
        {},
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("caps the legacy in-memory usage ledger to the newest 500 records", async () => {
    const provider = new OpenAiProvider({
      client: sdkClient({
        responses: {
          create: vi.fn(async () => ({
            id: "resp_usage",
            model: "gpt-fixture",
            output_text: "Synthetic",
            output: [],
          })),
        },
      }),
      defaultModel: "gpt-fixture",
    });
    for (let index = 0; index < 501; index += 1) {
      await provider.generateResponse(
        request({
          options: {
            ...request().options,
            requestId: `request_usage_${index}`,
          },
        }),
      );
    }
    const usage = await provider.usage();
    expect(usage).toHaveLength(500);
    expect(usage[0]?.requestId).toBe("request_usage_1");
    expect(usage.at(-1)?.requestId).toBe("request_usage_500");
  });
});

describe("Demo provider no-network parity", () => {
  it("aligns every file-backed tool proposal with document and research permissions", () => {
    for (const tool of BEA_GENERATED_ARTIFACT_TOOLS) {
      expect(tool.requiredPermissions).toContain("documents.view");
      if (tool.name === "bea_research") {
        expect(tool.requiredPermissions).toEqual(
          expect.arrayContaining(["ai-command.run", "search.view"]),
        );
      }
    }
  });

  it("streams simulated web citations and schema-valid artifact proposals without a key", async () => {
    const provider = new DemoStreamingAiProvider();
    const result = await provider.generateResponse(
      request({
        input: "Research and chart the synthetic envelope fixture",
        webSearch: true,
        tools: BEA_GENERATED_ARTIFACT_TOOLS,
      }),
    );
    expect(result).toMatchObject({ simulated: true, model: "gpt-fixture" });
    expect(result.citations).toHaveLength(1);
    expect(result.webSources).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ name: "bea_create_chart", status: "proposed" });
    expect(result.toolCalls[0]?.arguments).toMatchObject({
      chartType: "bar",
      sourceArtifactId: "art_demo_source_data",
    });
  });
});
