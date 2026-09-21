import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { apiError, apiJson } from "@/lib/api-response";
import { reserveAiCommandRequest } from "@/lib/ai-command";
import { aiCommandApiError, requireAiApiContext } from "@/lib/ai-command-api";
import { parseAiCommandReservationBody } from "@/lib/ai-command-request-contract";
import { validateBoundedJsonMutation } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const context = await requireAiApiContext(request, {
    route: "/api/ai-command/requests",
    action: "ai-command.request.reserve",
    permission: PERMISSIONS.AI_COMMAND_RUN,
    strictMutation: true,
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
        "The request body must be valid JSON.",
        400,
        context.correlationId,
      );
    }
    const input = parseAiCommandReservationBody(body);
    if (!input) {
      return apiError(
        "invalid-ai-command-reservation",
        "A conversation ID is required to reserve an AI Command request.",
        400,
        context.correlationId,
      );
    }
    const reservation = await reserveAiCommandRequest({
      userId: context.userId,
      conversationId: input.conversationId,
      correlationId: context.correlationId,
    });
    return apiJson(reservation, context.correlationId, { status: 201 });
  } catch (error) {
    return aiCommandApiError(error, context.correlationId);
  }
}
