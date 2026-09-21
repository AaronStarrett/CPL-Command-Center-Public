import { describe, expect, it, vi } from "vitest";

import {
  AI_COMMAND_STREAM_LIMITS,
  consumeAiCommandEventStream,
  validateAiToolProposal,
  type AiCommandStreamEvent,
} from "../../apps/web/lib/ai-command-client.js";

const encoder = new TextEncoder();

function streamResponse(chunks: readonly string[], onCancel?: (reason: unknown) => void): Response {
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index];
        if (chunk === undefined) {
          controller.close();
          return;
        }
        index += 1;
        controller.enqueue(encoder.encode(chunk));
      },
      cancel(reason) {
        onCancel?.(reason);
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8" },
    },
  );
}

describe("AI Command client stream contract", () => {
  it("parses exact SSE events when CRLF is split across stream chunks", async () => {
    const payload = [
      "event: response.started\r\n",
      'data: {"type":"response.started","requestId":"request-1","providerResponseId":"provider-1","model":"gpt-test","simulated":true}\r\n\r\n',
      "event: response.output_text.delta\r\n",
      'data: {"type":"response.output_text.delta","delta":"Hello"}\r\n\r\n',
      "event: response.completed\r\n",
      'data: {"type":"response.completed","result":{"conversationId":"conversation-1"}}\r\n\r\n',
    ].join("");
    const firstBoundary = payload.indexOf("\r\n") + 1;
    const secondBoundary = payload.indexOf("\r\n\r\n") + 3;
    const events: AiCommandStreamEvent[] = [];

    await consumeAiCommandEventStream(
      streamResponse([
        payload.slice(0, firstBoundary),
        payload.slice(firstBoundary, secondBoundary),
        payload.slice(secondBoundary),
      ]),
      (event) => events.push(event),
    );

    expect(events.map((event) => event.type)).toEqual([
      "response.started",
      "response.output_text.delta",
      "response.completed",
    ]);
    expect(events[1]).toEqual({
      type: "response.output_text.delta",
      delta: "Hello",
    });
  });

  it("ignores unknown, mismatched, and malformed stream event shapes", async () => {
    const events: AiCommandStreamEvent[] = [];
    const response = streamResponse([
      [
        'event: arbitrary.script\ndata: {"type":"arbitrary.script","html":"<script />"}\n\n',
        'event: response.citation\ndata: {"type":"response.output_text.delta","delta":"mismatch"}\n\n',
        'event: response.started\ndata: {"type":"response.started","requestId":"missing-fields"}\n\n',
        'event: response.citation\ndata: {"type":"response.citation","citation":"not-an-object"}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"safe"}\n\n',
      ].join(""),
    ]);

    await consumeAiCommandEventStream(response, (event) => events.push(event));

    expect(events).toEqual([{ type: "response.output_text.delta", delta: "safe" }]);
  });

  it("rejects an oversized individual SSE frame", async () => {
    const response = streamResponse([
      `event: response.output_text.delta\ndata: ${"x".repeat(
        AI_COMMAND_STREAM_LIMITS.frameCharacters + 1,
      )}\n\n`,
    ]);

    await expect(consumeAiCommandEventStream(response, vi.fn())).rejects.toThrow("oversized event");
  });

  it("rejects a stream that exceeds the bounded total byte budget", async () => {
    const response = streamResponse(["x".repeat(AI_COMMAND_STREAM_LIMITS.totalBytes + 1)]);

    await expect(consumeAiCommandEventStream(response, vi.fn())).rejects.toThrow(
      "safe response limit",
    );
  });

  it("cancels the active reader before releasing it when the request is aborted", async () => {
    const cancelled = vi.fn();
    const controller = new AbortController();
    const events: AiCommandStreamEvent[] = [];
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(
            encoder.encode(
              'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n',
            ),
          );
        },
        cancel: cancelled,
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
    const consumption = consumeAiCommandEventStream(
      response,
      (event) => events.push(event),
      controller.signal,
    );
    await vi.waitFor(() => expect(events).toHaveLength(1));

    controller.abort();

    await expect(consumption).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(cancelled.mock.calls[0]?.[0]).toMatchObject({ name: "AbortError" });
  });

  it("forwards registered BEA proposals only to the validation-only internal endpoint", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          validation: {
            callId: "call-1",
            name: "bea_research",
            status: "validated",
            effect: "read",
            requiredPermissions: ["ai-command.run"],
            executable: false,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    await expect(
      validateAiToolProposal(
        {
          callId: "call-1",
          name: "bea_research",
          arguments: { title: "BEA research", query: "Synthetic envelope" },
        },
        undefined,
        fetchImplementation,
      ),
    ).resolves.toEqual({
      validation: {
        callId: "call-1",
        name: "bea_research",
        status: "validated",
        effect: "read",
        requiredPermissions: ["ai-command.run"],
        executable: false,
      },
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      "/api/ai-command/tools/validate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          callId: "call-1",
          name: "bea_research",
          arguments: { title: "BEA research", query: "Synthetic envelope" },
        }),
      }),
    );
  });

  it("rejects obsolete or mismatched tool-validation response shapes", async () => {
    const legacyFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ accepted: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const mismatchedFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          validation: {
            callId: "different-call",
            name: "bea_research",
            status: "validated",
            effect: "read",
            requiredPermissions: [],
            executable: false,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
    const proposal = {
      callId: "call-1",
      name: "bea_research",
      arguments: { title: "BEA research", query: "Synthetic envelope" },
    };

    await expect(validateAiToolProposal(proposal, undefined, legacyFetch)).rejects.toThrow(
      "could not be validated",
    );
    await expect(validateAiToolProposal(proposal, undefined, mismatchedFetch)).rejects.toThrow(
      "could not be validated",
    );
  });
});
