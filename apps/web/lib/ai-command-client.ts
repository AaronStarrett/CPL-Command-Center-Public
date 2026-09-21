export const AI_COMMAND_CLIENT_ENDPOINTS = {
  conversation: "/api/ai-command/conversations",
  messageFallback: "/api/ai-command/messages",
  realtimeAuthorization: "/api/ai-command/realtime/client-secret",
  realtimePreference: "/api/ai-command/realtime/preferences",
  requestReservation: "/api/ai-command/requests",
  stream: "/api/ai-command/stream",
  toolValidation: "/api/ai-command/tools/validate",
  workspace: "/api/ai-command/workspace",
} as const;

export type AiCommandInputMode = "text" | "simulated_voice";

export type AiCommandStreamEvent =
  | {
      readonly type: "response.started";
      readonly requestId: string;
      readonly providerResponseId: string;
      readonly model: string;
      readonly simulated: boolean;
    }
  | { readonly type: "response.output_text.delta"; readonly delta: string }
  | {
      readonly type: "response.citation";
      readonly citation: Record<string, unknown>;
    }
  | {
      readonly type: "response.file_source";
      readonly source: Record<string, unknown>;
    }
  | {
      readonly type: "response.tool_call";
      readonly toolCall: Record<string, unknown>;
    }
  | {
      readonly type: "response.generated_artifact";
      readonly artifact: Record<string, unknown>;
    }
  | { readonly type: "response.usage"; readonly usage: Record<string, unknown> }
  | {
      readonly type: "response.completed";
      readonly result: Record<string, unknown>;
    }
  | { readonly type: "response.cancelled"; readonly requestId: string }
  | {
      readonly type: "response.error";
      readonly code: string;
      readonly safeMessage: string;
      readonly retryable: boolean;
    };

const streamEventTypes = new Set<AiCommandStreamEvent["type"]>([
  "response.started",
  "response.output_text.delta",
  "response.citation",
  "response.file_source",
  "response.tool_call",
  "response.generated_artifact",
  "response.usage",
  "response.completed",
  "response.cancelled",
  "response.error",
]);

export const AI_COMMAND_STREAM_LIMITS = {
  frameCharacters: 256 * 1024,
  totalBytes: 8 * 1024 * 1024,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function validStreamEvent(value: Record<string, unknown>): AiCommandStreamEvent | null {
  switch (value.type) {
    case "response.started":
      return typeof value.requestId === "string" &&
        typeof value.providerResponseId === "string" &&
        typeof value.model === "string" &&
        typeof value.simulated === "boolean"
        ? {
            type: value.type,
            requestId: value.requestId,
            providerResponseId: value.providerResponseId,
            model: value.model,
            simulated: value.simulated,
          }
        : null;
    case "response.output_text.delta":
      return typeof value.delta === "string" ? { type: value.type, delta: value.delta } : null;
    case "response.citation":
      return isRecord(value.citation) ? { type: value.type, citation: value.citation } : null;
    case "response.file_source":
      return isRecord(value.source) ? { type: value.type, source: value.source } : null;
    case "response.tool_call":
      return isRecord(value.toolCall) ? { type: value.type, toolCall: value.toolCall } : null;
    case "response.generated_artifact":
      return isRecord(value.artifact) ? { type: value.type, artifact: value.artifact } : null;
    case "response.usage":
      return isRecord(value.usage) ? { type: value.type, usage: value.usage } : null;
    case "response.completed":
      return isRecord(value.result) ? { type: value.type, result: value.result } : null;
    case "response.cancelled":
      return typeof value.requestId === "string"
        ? { type: value.type, requestId: value.requestId }
        : null;
    case "response.error":
      return typeof value.code === "string" &&
        typeof value.safeMessage === "string" &&
        typeof value.retryable === "boolean"
        ? {
            type: value.type,
            code: value.code,
            safeMessage: value.safeMessage,
            retryable: value.retryable,
          }
        : null;
    default:
      return null;
  }
}

function parseEventFrame(frame: string): AiCommandStreamEvent | null {
  let eventName = "";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0 || data.join("\n") === "[DONE]") return null;
  const parsed = safeJson(data.join("\n"));
  if (!isRecord(parsed) || typeof parsed.type !== "string") return null;
  if (!streamEventTypes.has(parsed.type as AiCommandStreamEvent["type"])) return null;
  if (eventName && eventName !== parsed.type) return null;
  return validStreamEvent(parsed);
}

function normalizeSseBuffer(value: string, final = false): string {
  const preservesTrailingCarriageReturn = !final && value.endsWith("\r");
  const complete = preservesTrailingCarriageReturn ? value.slice(0, -1) : value;
  return (
    complete.replaceAll("\r\n", "\n").replaceAll("\r", "\n") +
    (preservesTrailingCarriageReturn ? "\r" : "")
  );
}

function abortError(): DOMException {
  return new DOMException("AI Command request was cancelled.", "AbortError");
}

export async function consumeAiCommandEventStream(
  response: Response,
  onEvent: (event: AiCommandStreamEvent) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.ok) throw new Error(`AI Command stream failed with status ${response.status}.`);
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    throw new Error("AI Command returned an invalid stream response.");
  }
  if (!response.body) throw new Error("AI Command returned an empty stream response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let totalBytes = 0;
  let abortCancellation: Promise<void> | undefined;
  const cancelForAbort = () => {
    abortCancellation ??= reader.cancel(abortError()).catch(() => undefined);
  };
  signal?.addEventListener("abort", cancelForAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw abortError();
      const next = await reader.read();
      if (signal?.aborted) throw abortError();
      totalBytes += next.value?.byteLength ?? 0;
      if (totalBytes > AI_COMMAND_STREAM_LIMITS.totalBytes) {
        throw new Error("AI Command stream exceeded the safe response limit.");
      }
      buffer = normalizeSseBuffer(
        buffer + decoder.decode(next.value, { stream: !next.done }),
        next.done,
      );
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        if (boundary > AI_COMMAND_STREAM_LIMITS.frameCharacters) {
          throw new Error("AI Command stream contained an oversized event.");
        }
        const event = parseEventFrame(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (event) await onEvent(event);
        boundary = buffer.indexOf("\n\n");
      }
      if (buffer.length > AI_COMMAND_STREAM_LIMITS.frameCharacters) {
        throw new Error("AI Command stream contained an oversized event.");
      }
      if (next.done) break;
    }
    const finalEvent = parseEventFrame(buffer.trim());
    if (finalEvent) await onEvent(finalEvent);
  } catch (caught) {
    if (signal?.aborted) {
      cancelForAbort();
      await abortCancellation;
      throw abortError();
    }
    await reader.cancel(caught).catch(() => undefined);
    throw caught;
  } finally {
    signal?.removeEventListener("abort", cancelForAbort);
    if (signal?.aborted) {
      cancelForAbort();
      await abortCancellation;
    }
    reader.releaseLock();
  }
}

export interface AiToolValidationResult {
  readonly validation: {
    readonly callId: string;
    readonly name: string;
    readonly status: "validated";
    readonly effect: "preview" | "read";
    readonly requiredPermissions: readonly string[];
    readonly executable: false;
  };
}

function readToolValidationResult(
  body: unknown,
  proposal: { readonly callId: string; readonly name: string },
): AiToolValidationResult | null {
  if (!isRecord(body) || !isRecord(body.validation)) return null;
  const validation = body.validation;
  const permissions = validation.requiredPermissions;
  if (
    validation.callId !== proposal.callId ||
    validation.name !== proposal.name ||
    validation.status !== "validated" ||
    (validation.effect !== "read" && validation.effect !== "preview") ||
    validation.executable !== false ||
    !Array.isArray(permissions) ||
    permissions.length > 20 ||
    permissions.some(
      (permission) =>
        typeof permission !== "string" || permission.length < 1 || permission.length > 100,
    )
  ) {
    return null;
  }
  return {
    validation: {
      callId: proposal.callId,
      name: proposal.name,
      status: "validated",
      effect: validation.effect,
      requiredPermissions: permissions as string[],
      executable: false,
    },
  };
}

export async function validateAiToolProposal(
  proposal: { readonly callId: string; readonly name: string; readonly arguments: unknown },
  signal?: AbortSignal,
  fetchImplementation: typeof fetch = fetch,
): Promise<AiToolValidationResult> {
  const response = await fetchImplementation(AI_COMMAND_CLIENT_ENDPOINTS.toolValidation, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(proposal),
    signal,
  });
  const body = (await response.json()) as unknown;
  const result = readToolValidationResult(body, proposal);
  if (!response.ok || !result) {
    throw new Error("The proposed AI tool could not be validated.");
  }
  return result;
}

export type AiRealtimeUiState =
  | "idle"
  | "connecting"
  | "listening"
  | "user-speaking"
  | "processing"
  | "assistant-speaking"
  | "interrupted"
  | "muted"
  | "reconnecting"
  | "disconnected"
  | "error";

/**
 * UI-only Realtime seam. Live microphone capture and WebRTC negotiation require a fresh,
 * explicit owner authorization before a browser controller may be attached here.
 */
export interface AiRealtimeUiSnapshot {
  readonly state: AiRealtimeUiState;
  readonly transcript: string;
  readonly muted: boolean;
}
