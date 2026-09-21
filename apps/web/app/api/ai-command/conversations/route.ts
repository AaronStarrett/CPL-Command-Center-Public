import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { apiJson } from "@/lib/api-response";
import { createAiCommandConversation, getAiCommandSnapshot } from "@/lib/ai-command";
import { aiCommandApiError, requireAiApiContext } from "@/lib/ai-command-api";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const context = await requireAiApiContext(request, {
    route: "/api/ai-command/conversations",
    action: "ai-command.conversation.read",
    permission: PERMISSIONS.AI_COMMAND_VIEW,
  });
  if (!context.ok) return context.response;
  try {
    const conversationId = request.nextUrl.searchParams.get("conversation") ?? undefined;
    return apiJson(
      await getAiCommandSnapshot(context.userId, conversationId),
      context.correlationId,
    );
  } catch (error) {
    return aiCommandApiError(error, context.correlationId);
  }
}

export async function POST(request: NextRequest) {
  const context = await requireAiApiContext(request, {
    route: "/api/ai-command/conversations",
    action: "ai-command.conversation.create",
    permission: PERMISSIONS.AI_COMMAND_RUN,
    mutation: true,
  });
  if (!context.ok) return context.response;
  try {
    return apiJson(await createAiCommandConversation(context.userId), context.correlationId, {
      status: 201,
    });
  } catch (error) {
    return aiCommandApiError(error, context.correlationId);
  }
}
