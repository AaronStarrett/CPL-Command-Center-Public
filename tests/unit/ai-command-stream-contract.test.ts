import { describe, expect, it, vi } from "vitest";

import { routeDemoCommand, type AiConversationResult } from "../../packages/ai/src/index.js";

vi.mock("server-only", () => ({}));

import {
  compactAiCommandCompletionResult,
  processAiCommandStream,
  shouldUseInternalDemoRouter,
} from "../../apps/web/lib/ai-command-stream.js";

describe("AI Command terminal stream frame contract", () => {
  it("routes staged Demo artifacts through the provider file-analysis seam", () => {
    const internalIntent = routeDemoCommand("Show open tasks");

    expect(shouldUseInternalDemoRouter(internalIntent, [])).toBe(true);
    expect(shouldUseInternalDemoRouter(internalIntent, ["art_owner_fixture"])).toBe(false);
    expect(shouldUseInternalDemoRouter(routeDemoCommand("Analyze the attached file"), [])).toBe(
      false,
    );
  });

  it("keeps the terminal SSE completion frame compact after detailed events", () => {
    const repeated = Array.from({ length: 100 }, (_, index) => ({
      id: `item-${index}`,
      title: `Source ${index}`,
      url: `https://example.invalid/${"x".repeat(1_000)}-${index}`,
      domain: "example.invalid",
      retrievedAt: "2026-08-20T18:00:00.000Z",
      simulated: false,
    }));
    const result = compactAiCommandCompletionResult({
      responseId: "response-terminal-frame",
      model: "gpt-fixture",
      text: "x".repeat(20_000),
      citations: repeated,
      webSources: repeated,
      toolCalls: repeated.map((item) => ({
        id: item.id,
        name: "bea_research",
        arguments: { title: item.title },
        status: "proposed" as const,
      })),
      generatedArtifacts: repeated.map((item) => ({
        id: item.id,
        kind: "generated_image" as const,
        providerItemId: item.id,
        simulated: false,
        rawBytesPersisted: false,
      })),
      usage: null,
      completedAt: "2026-08-20T18:00:00.000Z",
      simulated: false,
    } satisfies AiConversationResult);
    const event = { type: "response.completed", result };

    expect(result).toMatchObject({
      citations: [],
      webSources: [],
      toolCalls: [],
      generatedArtifacts: [],
    });
    expect(new TextEncoder().encode(JSON.stringify(event)).length).toBeLessThan(256 * 1_024);
  });

  it("fails closed when an internal caller presents live_voice without server-minted evidence", async () => {
    const stream = processAiCommandStream({
      runtime: {
        phase1: {
          getConversation: vi.fn(async () => ({
            id: "10000000-0000-4000-8000-000000000010",
          })),
        },
      } as never,
      userId: "10000000-0000-4000-8000-000000000001",
      conversationId: "10000000-0000-4000-8000-000000000010",
      message: "Search the web for current guidance",
      requestId: "40000000-0000-4000-8000-000000000040",
      generation: 1,
      correlationId: "live-voice-missing-evidence",
      webSearch: true,
      builtInTools: ["web_search"],
      confirmHighCostTools: false,
      inputMode: "live_voice",
      inputArtifactIds: [],
      liveVoiceWebSearchAuthorization: { browserClaim: true },
    });

    await expect(stream.next()).rejects.toMatchObject({
      code: "REALTIME_WEB_SEARCH_NOT_AUTHORIZED",
      status: 403,
    });
  });
});
