import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { apiError, apiJson } from "@/lib/api-response";
import { requireAiApiContext } from "@/lib/ai-command-api";
import { testOpenAiConnection } from "@/lib/openai-administration";
import { openAiApiError } from "@/lib/openai-api";
import { validateBodylessMutation } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const context = await requireAiApiContext(request, {
    route: "/api/integrations/ai/test",
    action: "openai.connection.test",
    permissions: [PERMISSIONS.INTEGRATIONS_MANAGE, PERMISSIONS.SETTINGS_MANAGE],
    strictMutation: true,
    rateLimit: { key: "openai.connection.test", limit: 5, windowSeconds: 300 },
  });
  if (!context.ok) return context.response;
  const transport = validateBodylessMutation(request);
  if (!transport.ok) {
    return apiError(transport.code, transport.message, transport.status, context.correlationId);
  }
  try {
    const result = await testOpenAiConnection({
      runtime: context.runtime,
      actorUserId: context.userId,
      correlationId: context.correlationId,
    });
    return apiJson({ result }, context.correlationId, {
      status: result.outcome === "succeeded" ? 200 : 503,
    });
  } catch (error) {
    return openAiApiError(error, context.correlationId);
  }
}
