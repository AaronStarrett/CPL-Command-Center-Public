import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { apiError, apiJson } from "@/lib/api-response";
import { requireAiApiContext } from "@/lib/ai-command-api";
import { openAiApiError } from "@/lib/openai-api";
import { validateBoundedJsonMutation } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const context = await requireAiApiContext(request, {
    route: "/api/ai-command/realtime/preferences",
    action: "ai-command.realtime.preferences.read",
    permission: PERMISSIONS.AI_COMMAND_VIEW,
  });
  if (!context.ok) return context.response;
  try {
    const preference = await context.runtime.ai.persistence.getUserVoicePreference(context.userId);
    return apiJson({ preference }, context.correlationId);
  } catch (error) {
    return openAiApiError(error, context.correlationId);
  }
}

export async function PUT(request: NextRequest) {
  const context = await requireAiApiContext(request, {
    route: "/api/ai-command/realtime/preferences",
    action: "ai-command.realtime.preferences.update",
    permission: PERMISSIONS.AI_COMMAND_RUN,
    strictMutation: true,
    rateLimit: { key: "ai-command.realtime.preferences.update", limit: 20, windowSeconds: 60 },
  });
  if (!context.ok) return context.response;
  const transport = validateBoundedJsonMutation(request);
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
        "Voice preference must be valid JSON.",
        400,
        context.correlationId,
      );
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !("speakResponses" in body) ||
      typeof body.speakResponses !== "boolean"
    ) {
      return apiError(
        "invalid-voice-preference",
        "Speak responses must be true or false.",
        400,
        context.correlationId,
      );
    }
    const preference = await context.runtime.ai.persistence.setUserVoicePreference({
      userId: context.userId,
      speakResponses: body.speakResponses,
    });
    await context.runtime.repository.record({
      eventType: "ai-provider.voice-preference-updated",
      action: "ai-command.realtime.preferences.update",
      outcome: "succeeded",
      actorUserId: context.userId,
      resourceType: "ai-user-voice-preference",
      resourceId: preference.id,
      correlationId: context.correlationId,
      metadata: { speakResponses: preference.speakResponses },
    });
    return apiJson({ preference }, context.correlationId);
  } catch (error) {
    return openAiApiError(error, context.correlationId);
  }
}
