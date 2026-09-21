import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { apiJson } from "@/lib/api-response";
import { confirmAiTaskAction } from "@/lib/ai-command";
import { aiCommandApiError, requireAiApiContext } from "@/lib/ai-command-api";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  contextPromise: { params: Promise<{ id: string }> },
) {
  const context = await requireAiApiContext(request, {
    route: "/api/ai-command/actions/[id]/confirm",
    action: "ai-command.task-action.confirm",
    permission: PERMISSIONS.AI_COMMAND_VIEW,
    mutation: true,
  });
  if (!context.ok) return context.response;
  try {
    const { id } = await contextPromise.params;
    const snapshot = await confirmAiTaskAction({
      userId: context.userId,
      actionId: id,
      correlationId: context.correlationId,
    });
    return apiJson(snapshot, context.correlationId);
  } catch (error) {
    return aiCommandApiError(error, context.correlationId);
  }
}
