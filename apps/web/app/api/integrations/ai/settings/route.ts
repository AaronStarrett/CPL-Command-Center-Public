import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { apiError, apiJson } from "@/lib/api-response";
import { requireAiApiContext } from "@/lib/ai-command-api";
import { readOpenAiAdministration, updateAiProviderSettings } from "@/lib/openai-administration";
import { openAiApiError } from "@/lib/openai-api";
import { validateBoundedJsonMutation } from "@/lib/request-security";

const permissions = [PERMISSIONS.INTEGRATIONS_MANAGE, PERMISSIONS.SETTINGS_MANAGE] as const;
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const context = await requireAiApiContext(request, {
    route: "/api/integrations/ai/settings",
    action: "openai.settings.read",
    permissions,
  });
  if (!context.ok) return context.response;
  try {
    return apiJson(
      await readOpenAiAdministration(context.runtime, context.userId),
      context.correlationId,
    );
  } catch (error) {
    return openAiApiError(error, context.correlationId);
  }
}

export async function PUT(request: NextRequest) {
  const context = await requireAiApiContext(request, {
    route: "/api/integrations/ai/settings",
    action: "openai.settings.update",
    permissions,
    strictMutation: true,
    rateLimit: { key: "openai.settings.update", limit: 20, windowSeconds: 60 },
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
        "Provider settings must be valid JSON.",
        400,
        context.correlationId,
      );
    }
    const settings = await updateAiProviderSettings({
      runtime: context.runtime,
      actorUserId: context.userId,
      correlationId: context.correlationId,
      value: body,
    });
    return apiJson({ settings }, context.correlationId);
  } catch (error) {
    return openAiApiError(error, context.correlationId);
  }
}
