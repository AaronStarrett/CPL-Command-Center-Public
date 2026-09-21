import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { apiError, apiJson } from "@/lib/api-response";
import {
  normalizeAiCommandRequestGeneration,
  normalizeAiCommandRequestId,
  processAiCommandMessage,
} from "@/lib/ai-command";
import { aiCommandApiError, requireAiApiContext } from "@/lib/ai-command-api";
import { parseAiCommandMessageBody } from "@/lib/ai-command-request-contract";
import { isDeterministicDemoAiCommandAllowed } from "@/lib/openai-administration";
import { validateBoundedJsonMutation } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const context = await requireAiApiContext(request, {
    route: "/api/ai-command/messages",
    action: "ai-command.message.create",
    permission: PERMISSIONS.AI_COMMAND_RUN,
    strictMutation: true,
  });
  if (!context.ok) return context.response;
  if (!(await isDeterministicDemoAiCommandAllowed(context.runtime))) {
    return apiError(
      "test-provider-unavailable",
      "The deterministic AI Command fallback is available only in explicit Demo Mode.",
      404,
      context.correlationId,
    );
  }
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
        "The request body must be valid JSON.",
        400,
        context.correlationId,
      );
    }
    const input = parseAiCommandMessageBody(body);
    if (!input) {
      return apiError(
        "invalid-ai-command-message",
        "A valid reservation, conversation ID, and message of 1 to 2,000 characters are required.",
        400,
        context.correlationId,
      );
    }
    const requestId = normalizeAiCommandRequestId(input.requestId);
    const generation = normalizeAiCommandRequestGeneration(input.generation);
    const snapshot = await processAiCommandMessage({
      userId: context.userId,
      conversationId: input.conversationId,
      message: input.message,
      requestId,
      generation,
      correlationId: context.correlationId,
      ...(input.workspaceSelection === undefined
        ? {}
        : { workspaceSelection: input.workspaceSelection }),
    });
    return apiJson(snapshot, context.correlationId, { status: 201 });
  } catch (error) {
    return aiCommandApiError(error, context.correlationId);
  }
}
