import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { apiError, apiJson } from "@/lib/api-response";
import { requireAiApiContext } from "@/lib/ai-command-api";
import { refreshOpenAiModels, safeModelDtos } from "@/lib/openai-administration";
import { openAiApiError } from "@/lib/openai-api";
import { validateBodylessMutation } from "@/lib/request-security";

const permissions = [PERMISSIONS.INTEGRATIONS_MANAGE, PERMISSIONS.SETTINGS_MANAGE] as const;
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const context = await requireAiApiContext(request, {
    route: "/api/integrations/ai/models",
    action: "openai.models.read",
    permissions,
  });
  if (!context.ok) return context.response;
  try {
    return apiJson(
      { models: await context.runtime.ai.persistence.listCachedModels("openai"), source: "cache" },
      context.correlationId,
    );
  } catch (error) {
    return openAiApiError(error, context.correlationId);
  }
}

export async function POST(request: NextRequest) {
  const context = await requireAiApiContext(request, {
    route: "/api/integrations/ai/models",
    action: "openai.models.refresh",
    permissions,
    strictMutation: true,
    rateLimit: { key: "openai.models.refresh", limit: 5, windowSeconds: 300 },
  });
  if (!context.ok) return context.response;
  const transport = validateBodylessMutation(request);
  if (!transport.ok) {
    return apiError(transport.code, transport.message, transport.status, context.correlationId);
  }
  try {
    const models = await refreshOpenAiModels({
      runtime: context.runtime,
      actorUserId: context.userId,
      correlationId: context.correlationId,
    });
    return apiJson({ models: safeModelDtos(models), source: "provider" }, context.correlationId);
  } catch (error) {
    return openAiApiError(error, context.correlationId);
  }
}
