import {
  NARRATION_LIFECYCLE_EVENT_TYPES,
  presentationPacketFromStoredRun,
  PHASE21_LIMITS,
  type NarrationLifecycleEventType,
} from "@bea/ai";
import type { AiPresentationStatus, JsonObject } from "@bea/domain";
import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { apiError, apiJson } from "@/lib/api-response";
import { requireAiApiContext } from "@/lib/ai-command-api";
import { OpenAiAdministrationError } from "@/lib/openai-administration";
import { openAiApiError } from "@/lib/openai-api";
import { validateBoundedJsonMutation } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REQUEST_KEYS = new Set([
  "conversationId",
  "lastCompletedNarrationSegmentId",
  "presentationRunId",
  "providerResponseId",
  "realtimeSessionId",
  "type",
  "visualElementId",
]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function statusForEvent(type: NarrationLifecycleEventType): AiPresentationStatus | undefined {
  if (type === "narration.started" || type === "narration.segment_started") return "narrating";
  if (type === "narration.interrupted") return "interrupted";
  if (type === "narration.failed") return "failed";
  if (type === "narration.completed" || type === "narration.stopped") return "ready";
  return undefined;
}

export async function POST(request: NextRequest) {
  const context = await requireAiApiContext(request, {
    route: "/api/ai-command/presentations/lifecycle",
    action: "ai-command.presentation.lifecycle",
    permission: PERMISSIONS.AI_COMMAND_RUN,
    strictMutation: true,
    rateLimit: { key: "ai-command.presentation.lifecycle", limit: 180, windowSeconds: 60 },
  });
  if (!context.ok) return context.response;
  const transport = validateBoundedJsonMutation(request, 8_192);
  if (!transport.ok) {
    return apiError(transport.code, transport.message, transport.status, context.correlationId);
  }

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new OpenAiAdministrationError(
        "INVALID_PRESENTATION_LIFECYCLE",
        400,
        "The presentation lifecycle event must be valid JSON.",
      );
    }
    const input = record(body);
    if (
      !input ||
      Object.keys(input).some((key) => !REQUEST_KEYS.has(key)) ||
      typeof input.type !== "string" ||
      !(NARRATION_LIFECYCLE_EVENT_TYPES as readonly string[]).includes(input.type) ||
      typeof input.presentationRunId !== "string" ||
      !UUID.test(input.presentationRunId) ||
      typeof input.conversationId !== "string" ||
      !UUID.test(input.conversationId)
    ) {
      throw new OpenAiAdministrationError(
        "INVALID_PRESENTATION_LIFECYCLE",
        400,
        "The presentation lifecycle event is invalid.",
      );
    }
    const conversation = await context.runtime.phase1.getConversation(
      input.conversationId,
      context.userId,
    );
    const latest = await context.runtime.ai.persistence.getLatestPresentationRunForConversation(
      input.conversationId,
      context.userId,
    );
    const packet = latest ? presentationPacketFromStoredRun(latest.packet) : null;
    if (!conversation || !latest || !packet || latest.id !== input.presentationRunId) {
      throw new OpenAiAdministrationError(
        "PRESENTATION_UNAVAILABLE",
        404,
        "The presentation is unavailable.",
      );
    }
    const type = input.type as NarrationLifecycleEventType;
    const status = statusForEvent(type);
    const completedSegmentId =
      type === "narration.segment_completed" &&
      typeof input.lastCompletedNarrationSegmentId === "string"
        ? input.lastCompletedNarrationSegmentId
        : undefined;
    let realtimeSessionId: string | undefined;
    if (typeof input.realtimeSessionId === "string" && UUID.test(input.realtimeSessionId)) {
      const session = await context.runtime.ai.persistence.getRealtimeSessionForUser(
        input.realtimeSessionId,
        context.userId,
      );
      if (session) {
        const age = Date.now() - Date.parse(session.authorizedAt);
        if (!Number.isFinite(age) || age > PHASE21_LIMITS.realtimeSessionMaxAgeMs) {
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
        realtimeSessionId = session.id;
      }
    }
    const packetPatch = {
      status: status ?? packet.status,
      ...(completedSegmentId ? { lastCompletedNarrationSegmentId: completedSegmentId } : {}),
    } as unknown as JsonObject;
    await context.runtime.ai.persistence.updatePresentationRunLifecycle({
      id: latest.id,
      actingUserId: context.userId,
      status,
      realtimeSessionId,
      providerResponseId:
        typeof input.providerResponseId === "string" ? input.providerResponseId : undefined,
      lastCompletedNarrationSegmentId: completedSegmentId,
      packet: packetPatch,
    });
    await context.runtime.repository.record({
      eventType: `ai-command.${type.replace(".", "-")}`,
      action: "ai-command.presentation.lifecycle",
      outcome: type === "narration.failed" ? "failed" : "succeeded",
      actorUserId: context.userId,
      resourceType: "ai-presentation-run",
      resourceId: latest.id,
      correlationId: context.correlationId,
      metadata: {
        type,
        conversationId: conversation.id,
        lastCompletedNarrationSegmentId: completedSegmentId ?? null,
        realtimeSessionId: realtimeSessionId ?? null,
        providerResponseId:
          typeof input.providerResponseId === "string" ? input.providerResponseId : null,
      },
    });
    return apiJson({ presentationRunId: latest.id, type }, context.correlationId);
  } catch (error) {
    return openAiApiError(error, context.correlationId);
  }
}
