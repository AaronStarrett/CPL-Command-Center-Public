import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { apiError, apiJson } from "@/lib/api-response";
import { requireAiApiContext } from "@/lib/ai-command-api";
import {
  configureOpenAiSecret,
  disconnectOpenAi,
  readOpenAiAdministration,
} from "@/lib/openai-administration";
import { openAiApiError } from "@/lib/openai-api";
import { validateBodylessMutation, validateBoundedJsonMutation } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const permissions = [PERMISSIONS.INTEGRATIONS_MANAGE, PERMISSIONS.SETTINGS_MANAGE] as const;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function PUT(request: NextRequest) {
  const context = await requireAiApiContext(request, {
    route: "/api/integrations/ai/secret",
    action: "openai.secret.replace",
    permissions,
    strictMutation: true,
    rateLimit: { key: "openai.secret.replace", limit: 5, windowSeconds: 300 },
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
        "OpenAI secret configuration must be valid JSON.",
        400,
        context.correlationId,
      );
    }
    const input = record(body);
    if (!input || Object.keys(input).some((key) => key !== "apiKey")) {
      return apiError(
        "invalid-openai-secret-request",
        "OpenAI secret configuration is invalid.",
        400,
        context.correlationId,
      );
    }
    await configureOpenAiSecret({
      runtime: context.runtime,
      actorUserId: context.userId,
      correlationId: context.correlationId,
      apiKey: input.apiKey,
    });
    return apiJson(await readOpenAiAdministration(context.runtime), context.correlationId);
  } catch (error) {
    return openAiApiError(error, context.correlationId);
  }
}

export async function DELETE(request: NextRequest) {
  const context = await requireAiApiContext(request, {
    route: "/api/integrations/ai/secret",
    action: "openai.disconnect",
    permissions,
    strictMutation: true,
    rateLimit: { key: "openai.disconnect", limit: 5, windowSeconds: 300 },
  });
  if (!context.ok) return context.response;
  const transport = validateBodylessMutation(request);
  if (!transport.ok) {
    return apiError(transport.code, transport.message, transport.status, context.correlationId);
  }
  try {
    await disconnectOpenAi({
      runtime: context.runtime,
      actorUserId: context.userId,
      correlationId: context.correlationId,
    });
    return apiJson(await readOpenAiAdministration(context.runtime), context.correlationId);
  } catch (error) {
    return openAiApiError(error, context.correlationId);
  }
}
