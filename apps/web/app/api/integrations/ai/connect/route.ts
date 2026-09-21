import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { apiError, apiJson } from "@/lib/api-response";
import { requireAiApiContext } from "@/lib/ai-command-api";
import { connectOpenAiAndDiscover } from "@/lib/openai-administration";
import { openAiApiError } from "@/lib/openai-api";
import { validateBoundedJsonMutation } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const permissions = [PERMISSIONS.INTEGRATIONS_MANAGE, PERMISSIONS.SETTINGS_MANAGE] as const;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function POST(request: NextRequest) {
  const context = await requireAiApiContext(request, {
    route: "/api/integrations/ai/connect",
    action: "openai.connect",
    permissions,
    strictMutation: true,
    rateLimit: { key: "openai.connect", limit: 5, windowSeconds: 300 },
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
        "OpenAI connection must be valid JSON.",
        400,
        context.correlationId,
      );
    }
    const input = record(body);
    if (!input) {
      return apiError(
        "invalid-openai-connect-request",
        "OpenAI connection is invalid.",
        400,
        context.correlationId,
      );
    }
    const keys = Object.keys(input);
    if (input.useExistingCredential === true) {
      if (keys.some((key) => key !== "useExistingCredential")) {
        return apiError(
          "invalid-openai-connect-request",
          "OpenAI connection is invalid.",
          400,
          context.correlationId,
        );
      }
      const administration = await connectOpenAiAndDiscover({
        runtime: context.runtime,
        actorUserId: context.userId,
        correlationId: context.correlationId,
        useExistingCredential: true,
      });
      return apiJson(administration, context.correlationId);
    }
    if (keys.some((key) => key !== "apiKey") || typeof input.apiKey !== "string") {
      return apiError(
        "invalid-openai-connect-request",
        "OpenAI connection is invalid.",
        400,
        context.correlationId,
      );
    }
    const administration = await connectOpenAiAndDiscover({
      runtime: context.runtime,
      actorUserId: context.userId,
      correlationId: context.correlationId,
      apiKey: input.apiKey,
    });
    return apiJson(administration, context.correlationId);
  } catch (error) {
    return openAiApiError(error, context.correlationId);
  }
}
