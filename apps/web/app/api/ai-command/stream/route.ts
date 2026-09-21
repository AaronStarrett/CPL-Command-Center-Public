import { AiProviderError, type AiResponseStreamEvent } from "@bea/ai";
import { DemoArtifactRunnerError } from "@bea/artifacts";
import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { requireAiApiContext } from "@/lib/ai-command-api";
import { parseAiCommandMessageBody } from "@/lib/ai-command-request-contract";
import { processAiCommandStream } from "@/lib/ai-command-stream";
import { OpenAiAdministrationError } from "@/lib/openai-administration";
import { isPhase133ProductionPresentationTest } from "@/lib/phase133-production-presentation-test";
import { validateBoundedJsonMutation } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BUILT_IN_TOOL_NAMES = new Set(["web_search", "code_interpreter", "image_generation"]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalBoolean(value: unknown, fallback: boolean): boolean | null {
  return value === undefined ? fallback : typeof value === "boolean" ? value : null;
}

function builtInTools(
  value: unknown,
): ("web_search" | "code_interpreter" | "image_generation")[] | null {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 3 ||
    value.some((item) => typeof item !== "string" || !BUILT_IN_TOOL_NAMES.has(item))
  ) {
    return null;
  }
  const unique = [...new Set(value)] as ("web_search" | "code_interpreter" | "image_generation")[];
  return unique.length === value.length ? unique : null;
}

function inputArtifactIds(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 5 ||
    value.some((item) => typeof item !== "string" || !/^art_[a-f0-9]{32}$/u.test(item))
  ) {
    return null;
  }
  const unique = [...new Set(value as string[])];
  return unique.length === value.length ? unique : null;
}

function encodeEvent(event: AiResponseStreamEvent): Uint8Array {
  return new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function safeStreamError(error: unknown): AiResponseStreamEvent {
  if (error instanceof AiProviderError) {
    return {
      type: "response.error",
      code: error.code,
      safeMessage: error.safeMessage,
      retryable: error.retryable,
    };
  }
  if (error instanceof OpenAiAdministrationError) {
    return {
      type: "response.error",
      code: error.code,
      safeMessage: error.message,
      retryable: false,
    };
  }
  if (error instanceof DemoArtifactRunnerError) {
    return {
      type: "response.error",
      code: error.code,
      safeMessage: error.message,
      retryable: false,
    };
  }
  return {
    type: "response.error",
    code: "AI_COMMAND_STREAM_FAILED",
    safeMessage: "AI Command could not complete this streamed request.",
    retryable: false,
  };
}

async function consumePolicyLimit(input: {
  readonly context: Extract<Awaited<ReturnType<typeof requireAiApiContext>>, { ok: true }>;
  readonly subjectKey: string;
  readonly routeKey: string;
  readonly limit: number;
  readonly windowSeconds: number;
}) {
  const decision = await input.context.runtime.ai.persistence.consumeRateLimit({
    subjectKey: input.subjectKey,
    routeKey: input.routeKey,
    limit: input.limit,
    windowSeconds: input.windowSeconds,
  });
  if (decision.allowed) return null;
  await input.context.runtime.repository.record({
    eventType: "rate-limit.denied",
    action: "ai-command.stream",
    outcome: "denied",
    actorUserId: input.context.userId,
    resourceType: "ai-provider",
    correlationId: input.context.correlationId,
    metadata: { routeKey: input.routeKey, limit: input.limit, resetAt: decision.resetAt },
  });
  const response = apiError(
    "rate-limit-exceeded",
    "This AI capability is temporarily rate limited.",
    429,
    input.context.correlationId,
  );
  response.headers.set(
    "Retry-After",
    String(Math.max(1, Math.ceil((Date.parse(decision.resetAt) - Date.now()) / 1_000))),
  );
  return response;
}

export async function POST(request: NextRequest) {
  const context = await requireAiApiContext(request, {
    route: "/api/ai-command/stream",
    action: "ai-command.stream",
    permission: PERMISSIONS.AI_COMMAND_RUN,
    strictMutation: true,
    rateLimit: { key: "ai-command.stream.hard-ceiling", limit: 1_000, windowSeconds: 60 },
  });
  if (!context.ok) return context.response;
  if (isPhase133ProductionPresentationTest()) {
    return apiError(
      "test-provider-unavailable",
      "Live AI streaming is unavailable in the Phase 1.3.3 TEST-ONLY presentation harness.",
      404,
      context.correlationId,
    );
  }

  const transport = validateBoundedJsonMutation(request);
  if (!transport.ok) {
    return apiError(transport.code, transport.message, transport.status, context.correlationId);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(
      "invalid-json",
      "The request body must be valid JSON.",
      400,
      context.correlationId,
    );
  }
  const message = parseAiCommandMessageBody(body);
  const value = record(body);
  const tools = builtInTools(value?.builtInTools);
  const webSearch = optionalBoolean(value?.webSearch, false);
  const confirmHighCostTools = optionalBoolean(value?.confirmHighCostTools, false);
  const inputMode = value?.inputMode === undefined ? "text" : value.inputMode;
  const artifacts = inputArtifactIds(value?.inputArtifactIds);
  if (
    !message ||
    !value ||
    !tools ||
    webSearch === null ||
    confirmHighCostTools === null ||
    (inputMode !== "text" && inputMode !== "simulated_voice") ||
    !artifacts
  ) {
    return apiError(
      "invalid-ai-command-stream-request",
      "A valid reservation, message, generation, and allowlisted tool selection are required.",
      400,
      context.correlationId,
    );
  }

  const settings = await context.runtime.ai.persistence.getProviderSettings();
  const effectiveWebSearch = value.webSearch === undefined ? settings.webSearchDefault : webSearch;
  const policies = [
    {
      subjectKey: `user:${context.userId}`,
      routeKey: "ai-command.stream.user",
      limit: settings.perUserRequestsPerMinute,
      windowSeconds: 60,
    },
    {
      subjectKey: `conversation:${context.userId}:${message.conversationId}`,
      routeKey: "ai-command.stream.conversation",
      limit: settings.perConversationRequestsPerMinute,
      windowSeconds: 60,
    },
    {
      subjectKey: `user:${context.userId}`,
      routeKey: "ai-command.stream.daily",
      limit: settings.dailyRequestLimit,
      windowSeconds: 86_400,
    },
  ] as const;
  for (const policy of policies) {
    const limited = await consumePolicyLimit({ context, ...policy });
    if (limited) return limited;
  }

  const streamAbortController = new AbortController();
  const abortFromRequest = () => streamAbortController.abort(request.signal.reason);
  if (request.signal.aborted) abortFromRequest();
  else request.signal.addEventListener("abort", abortFromRequest, { once: true });
  const eventIterator = processAiCommandStream({
    runtime: context.runtime,
    userId: context.userId,
    conversationId: message.conversationId,
    message: message.message,
    requestId: message.requestId,
    generation: message.generation,
    correlationId: context.correlationId,
    webSearch: effectiveWebSearch,
    builtInTools: tools,
    confirmHighCostTools,
    inputMode,
    inputArtifactIds: artifacts,
    signal: streamAbortController.signal,
    ...(message.workspaceSelection === undefined
      ? {}
      : { workspaceSelection: message.workspaceSelection }),
  })[Symbol.asyncIterator]();
  let finished = false;
  const removeRequestAbortListener = () =>
    request.signal.removeEventListener("abort", abortFromRequest);

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      try {
        const next = await eventIterator.next();
        if (finished) return;
        if (next.done) {
          finished = true;
          removeRequestAbortListener();
          controller.close();
          return;
        }
        controller.enqueue(encodeEvent(next.value));
      } catch (error) {
        if (finished) return;
        finished = true;
        removeRequestAbortListener();
        if (!streamAbortController.signal.aborted) streamAbortController.abort(error);
        controller.enqueue(encodeEvent(safeStreamError(error)));
        controller.close();
        try {
          await eventIterator.return?.();
        } catch {
          // The safe terminal SSE event is authoritative even if iterator cleanup also fails.
        }
      }
    },
    async cancel(reason) {
      if (finished) return;
      finished = true;
      removeRequestAbortListener();
      if (!streamAbortController.signal.aborted) streamAbortController.abort(reason);
      try {
        await eventIterator.return?.();
      } catch {
        // Cancellation remains fail-closed and never exposes provider cleanup details.
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Cache-Control": "no-cache, no-store, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
      "X-Correlation-ID": context.correlationId,
    },
  });
}
