import { PERMISSIONS, requireCredentialSafeContent } from "@bea/security";
import { PHASE21_LIMITS, realtimeSessionWithinMaxAge } from "@bea/ai";
import { NextRequest } from "next/server";

import { apiError, apiJson } from "@/lib/api-response";
import { requireAiApiContext } from "@/lib/ai-command-api";
import { OpenAiAdministrationError } from "@/lib/openai-administration";
import { openAiApiError } from "@/lib/openai-api";
import { validateBoundedJsonMutation } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const SAFE_ERROR_CODE = /^[A-Z0-9][A-Z0-9_:-]{0,99}$/u;
const EVENT_TYPES = new Set([
  "connected",
  "transcript",
  "usage",
  "completed",
  "failed",
  "cancelled",
]);
const COMMON_KEYS = new Set([
  "conversationId",
  "errorCode",
  "itemId",
  "providerSessionId",
  "role",
  "sessionId",
  "text",
  "type",
  "usage",
]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedInteger(value: unknown, maximum = 1_000_000_000): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum
    ? (value as number)
    : null;
}

function parseUsage(value: unknown) {
  const input = record(value);
  if (!input) return null;
  const keys = new Set([
    "audioInputTokens",
    "audioOutputTokens",
    "cachedInputTokens",
    "durationSeconds",
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
  ]);
  if (Object.keys(input).some((key) => !keys.has(key))) return null;
  const usage = {
    inputTokens: boundedInteger(input.inputTokens),
    outputTokens: boundedInteger(input.outputTokens),
    reasoningTokens: boundedInteger(input.reasoningTokens),
    cachedInputTokens: boundedInteger(input.cachedInputTokens),
    audioInputTokens: boundedInteger(input.audioInputTokens),
    audioOutputTokens: boundedInteger(input.audioOutputTokens),
    durationSeconds: boundedInteger(input.durationSeconds, 7_200),
  };
  return Object.values(usage).some((item) => item === null)
    ? null
    : (usage as { readonly [Key in keyof typeof usage]: number });
}

export async function POST(request: NextRequest) {
  const context = await requireAiApiContext(request, {
    route: "/api/ai-command/realtime/events",
    action: "ai-command.realtime.event",
    permissions: [PERMISSIONS.AI_COMMAND_RUN],
    strictMutation: true,
    rateLimit: { key: "ai-command.realtime.event", limit: 180, windowSeconds: 60 },
  });
  if (!context.ok) return context.response;
  const transport = validateBoundedJsonMutation(request, 32_768);
  if (!transport.ok) {
    return apiError(transport.code, transport.message, transport.status, context.correlationId);
  }

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(
        "invalid-json",
        "The Realtime event must be valid JSON.",
        400,
        context.correlationId,
      );
    }
    const input = record(body);
    if (
      !input ||
      Object.keys(input).some((key) => !COMMON_KEYS.has(key)) ||
      typeof input.type !== "string" ||
      !EVENT_TYPES.has(input.type) ||
      typeof input.sessionId !== "string" ||
      !UUID.test(input.sessionId) ||
      typeof input.conversationId !== "string" ||
      !UUID.test(input.conversationId)
    ) {
      throw new OpenAiAdministrationError(
        "INVALID_REALTIME_EVENT",
        400,
        "The Realtime event is invalid.",
      );
    }
    const [session, conversation] = await Promise.all([
      context.runtime.ai.persistence.getRealtimeSessionForUser(input.sessionId, context.userId),
      context.runtime.phase1.getConversation(input.conversationId, context.userId),
    ]);
    if (
      !session ||
      !conversation ||
      session.conversationId !== conversation.id ||
      session.provider !== "openai" ||
      session.simulated
    ) {
      throw new OpenAiAdministrationError(
        "REALTIME_SESSION_UNAVAILABLE",
        404,
        "The Realtime session is unavailable.",
      );
    }
    if (
      !realtimeSessionWithinMaxAge({
        authorizedAt: session.authorizedAt,
        nowMs: Date.now(),
        maxAgeMs: PHASE21_LIMITS.realtimeSessionMaxAgeMs,
      })
    ) {
      await context.runtime.ai.persistence.transitionRealtimeSession({
        id: session.id,
        requestedByUserId: context.userId,
        status: "failed",
        errorCode: "REALTIME_SESSION_EXPIRED",
        completedAt: new Date().toISOString(),
      });
      throw new OpenAiAdministrationError(
        "REALTIME_SESSION_EXPIRED",
        409,
        "The Realtime session reached the application maximum duration.",
      );
    }

    if (input.type === "connected") {
      const providerSessionId =
        typeof input.providerSessionId === "string" ? input.providerSessionId : null;
      if (
        Object.keys(input).some(
          (key) => !["conversationId", "providerSessionId", "sessionId", "type"].includes(key),
        ) ||
        (input.providerSessionId !== undefined &&
          (typeof input.providerSessionId !== "string" ||
            !PROVIDER_ID.test(input.providerSessionId))) ||
        (session.providerSessionId !== null && providerSessionId !== session.providerSessionId) ||
        Date.now() > Date.parse(session.expiresAt) + 15_000
      ) {
        throw new OpenAiAdministrationError(
          "INVALID_REALTIME_CONNECTED_EVENT",
          400,
          "The Realtime connection event is invalid.",
        );
      }
      if (providerSessionId !== null) requireCredentialSafeContent(providerSessionId);
      const updated = await context.runtime.ai.persistence.transitionRealtimeSession({
        id: session.id,
        requestedByUserId: context.userId,
        status: "connected",
        providerSessionId,
      });
      if (!updated) {
        throw new OpenAiAdministrationError(
          "REALTIME_SESSION_STATE_CONFLICT",
          409,
          "The Realtime session can no longer connect.",
        );
      }
      await context.runtime.repository.record({
        eventType: "ai-provider.realtime-connected",
        action: "ai-command.realtime.connect",
        outcome: "succeeded",
        actorUserId: context.userId,
        resourceType: "ai-realtime-session",
        resourceId: session.id,
        correlationId: context.correlationId,
        metadata: { conversationId: conversation.id, model: session.model, voice: session.voice },
      });
      return apiJson({ status: updated.status }, context.correlationId);
    }

    if (
      session.status !== "connected" &&
      !["completed", "failed", "cancelled"].includes(input.type)
    ) {
      throw new OpenAiAdministrationError(
        "REALTIME_SESSION_NOT_CONNECTED",
        409,
        "The Realtime session is not connected.",
      );
    }

    if (input.type === "transcript") {
      if (
        Object.keys(input).some(
          (key) => !["conversationId", "itemId", "role", "sessionId", "text", "type"].includes(key),
        ) ||
        (input.role !== "user" && input.role !== "assistant") ||
        typeof input.itemId !== "string" ||
        !PROVIDER_ID.test(input.itemId) ||
        typeof input.text !== "string"
      ) {
        throw new OpenAiAdministrationError(
          "INVALID_REALTIME_TRANSCRIPT",
          400,
          "The Realtime transcript event is invalid.",
        );
      }
      const text = input.text.replace(/\s+/gu, " ").trim();
      if (!text || text.length > 20_000) {
        throw new OpenAiAdministrationError(
          "INVALID_REALTIME_TRANSCRIPT",
          400,
          "The Realtime transcript event is invalid.",
        );
      }
      requireCredentialSafeContent(text);
      await context.runtime.phase1.createAssistantMessage({
        conversationId: conversation.id,
        ownerUserId: context.userId,
        role: input.role,
        content: text,
        correlationId: context.correlationId,
        provider: input.role === "assistant" ? "openai" : null,
        model: input.role === "assistant" ? session.model : null,
        providerResponseId: input.role === "assistant" ? input.itemId : null,
        routerVersion: input.role === "assistant" ? "phase1.3-realtime-v1" : null,
        executionMs: 0,
        requiredPermissions: [PERMISSIONS.AI_COMMAND_VIEW],
      });
      await context.runtime.repository.record({
        eventType: "ai-provider.realtime-transcript-persisted",
        action: "ai-command.realtime.transcript",
        outcome: "succeeded",
        actorUserId: context.userId,
        resourceType: "ai-realtime-session",
        resourceId: session.id,
        correlationId: context.correlationId,
        metadata: {
          conversationId: conversation.id,
          role: input.role,
          characterCount: text.length,
        },
      });
      return apiJson({ status: "persisted" }, context.correlationId);
    }

    if (input.type === "usage") {
      if (
        Object.keys(input).some(
          (key) => !["conversationId", "sessionId", "type", "usage"].includes(key),
        )
      ) {
        throw new OpenAiAdministrationError(
          "INVALID_REALTIME_USAGE",
          400,
          "The Realtime usage event is invalid.",
        );
      }
      const usage = parseUsage(input.usage);
      if (!usage) {
        throw new OpenAiAdministrationError(
          "INVALID_REALTIME_USAGE",
          400,
          "The Realtime usage event is invalid.",
        );
      }
      const usageId = await context.runtime.ai.persistence.recordUsage({
        responseRunId: null,
        realtimeSessionId: session.id,
        requestedByUserId: context.userId,
        provider: "openai",
        model: session.model,
        operation: "realtime.voice",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        cachedInputTokens: usage.cachedInputTokens,
        audioInputTokens: usage.audioInputTokens,
        audioOutputTokens: usage.audioOutputTokens,
        realtimeDurationSeconds: usage.durationSeconds,
        estimatedCostUsd: null,
        costStatus: "unavailable",
        simulated: false,
        recordedAt: new Date().toISOString(),
      });
      return apiJson({ status: "recorded", usageId }, context.correlationId);
    }

    if (
      Object.keys(input).some(
        (key) => !["conversationId", "errorCode", "sessionId", "type"].includes(key),
      ) ||
      (input.type === "failed" &&
        (typeof input.errorCode !== "string" || !SAFE_ERROR_CODE.test(input.errorCode))) ||
      (input.type !== "failed" && input.errorCode !== undefined)
    ) {
      throw new OpenAiAdministrationError(
        "INVALID_REALTIME_TERMINAL_EVENT",
        400,
        "The Realtime terminal event is invalid.",
      );
    }
    const status = input.type as "completed" | "failed" | "cancelled";
    const updated = await context.runtime.ai.persistence.transitionRealtimeSession({
      id: session.id,
      requestedByUserId: context.userId,
      status,
      errorCode: typeof input.errorCode === "string" ? input.errorCode : null,
    });
    if (!updated) {
      throw new OpenAiAdministrationError(
        "REALTIME_SESSION_STATE_CONFLICT",
        409,
        "The Realtime session is already closed.",
      );
    }
    await context.runtime.repository.record({
      eventType: `ai-provider.realtime-${status}`,
      action: "ai-command.realtime.complete",
      outcome: status === "failed" ? "failed" : "succeeded",
      actorUserId: context.userId,
      resourceType: "ai-realtime-session",
      resourceId: session.id,
      correlationId: context.correlationId,
      metadata: { conversationId: conversation.id, status },
    });
    return apiJson({ status: updated.status }, context.correlationId);
  } catch (error) {
    return openAiApiError(error, context.correlationId);
  }
}
