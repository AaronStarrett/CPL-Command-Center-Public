import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { apiError, apiJson } from "@/lib/api-response";
import { aiCommandApiError, requireAiApiContext } from "@/lib/ai-command-api";
import { loadAiCommandWorkspaceView } from "@/lib/ai-command-workspace";
import { parseAiCommandWorkspacePath } from "@/lib/ai-command-workspace-paths";
import { validateBoundedJsonMutation } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function POST(request: NextRequest) {
  const context = await requireAiApiContext(request, {
    route: "/api/ai-command/workspace",
    action: "ai-command.workspace.open",
    permission: PERMISSIONS.AI_COMMAND_VIEW,
    mutation: true,
  });
  if (!context.ok) return context.response;
  const transport = validateBoundedJsonMutation(request, 2_048);
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
        "Workspace navigation must be valid JSON.",
        400,
        context.correlationId,
      );
    }
    const input = record(body);
    const path = typeof input?.path === "string" ? input.path : "";
    if (
      !input ||
      Object.keys(input).some((key) => key !== "path") ||
      !parseAiCommandWorkspacePath(path)
    ) {
      return apiError(
        "invalid-workspace-path",
        "That record cannot open inside AI Command.",
        400,
        context.correlationId,
      );
    }
    const view = await loadAiCommandWorkspaceView({
      runtime: context.runtime,
      userId: context.userId,
      path,
    });
    return apiJson(view, context.correlationId);
  } catch (error) {
    return aiCommandApiError(error, context.correlationId);
  }
}
