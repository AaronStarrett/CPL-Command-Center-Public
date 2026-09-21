import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { apiError, apiJson } from "@/lib/api-response";
import { requireAiApiContext } from "@/lib/ai-command-api";
import { activateOpenAiProvider, readOpenAiAdministration } from "@/lib/openai-administration";
import { openAiApiError } from "@/lib/openai-api";
import {
  validateBodylessMutation,
  validateBoundedJsonMutation,
  hasJsonMutationBody,
} from "@/lib/request-security";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const context = await requireAiApiContext(request, {
    route: "/api/integrations/ai/activate",
    action: "openai.activate",
    permissions: [PERMISSIONS.INTEGRATIONS_MANAGE, PERMISSIONS.SETTINGS_MANAGE],
    strictMutation: true,
    rateLimit: { key: "openai.activate", limit: 5, windowSeconds: 300 },
  });
  if (!context.ok) return context.response;
  const transport = hasJsonMutationBody(request)
    ? validateBoundedJsonMutation(request, 512)
    : validateBodylessMutation(request);
  if (!transport.ok) {
    return apiError(transport.code, transport.message, transport.status, context.correlationId);
  }
  try {
    let mode: "openai" | "hybrid" | undefined;
    if (hasJsonMutationBody(request)) {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return apiError(
          "invalid-json",
          "OpenAI activation must be valid JSON.",
          400,
          context.correlationId,
        );
      }
      if (
        typeof body !== "object" ||
        body === null ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => key !== "mode") ||
        ((body as { mode?: unknown }).mode !== "openai" &&
          (body as { mode?: unknown }).mode !== "hybrid")
      ) {
        return apiError(
          "invalid-operating-mode",
          "Activation mode must be OpenAI or Hybrid.",
          400,
          context.correlationId,
        );
      }
      mode = (body as { mode: "openai" | "hybrid" }).mode;
    }
    await activateOpenAiProvider({
      runtime: context.runtime,
      actorUserId: context.userId,
      correlationId: context.correlationId,
      ...(mode ? { mode } : {}),
    });
    return apiJson(await readOpenAiAdministration(context.runtime), context.correlationId);
  } catch (error) {
    return openAiApiError(error, context.correlationId);
  }
}
