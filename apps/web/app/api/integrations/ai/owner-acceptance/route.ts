import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { apiError, apiJson } from "@/lib/api-response";
import { requireAiApiContext } from "@/lib/ai-command-api";
import { requestSession } from "@/app/api/route-helpers";
import {
  confirmOwnerPhysicalObservation,
  readOwnerLiveAcceptance,
} from "@/lib/owner-live-acceptance";
import { openAiApiError } from "@/lib/openai-api";
import { validateBoundedJsonMutation } from "@/lib/request-security";

const permissions = [PERMISSIONS.INTEGRATIONS_MANAGE, PERMISSIONS.SETTINGS_MANAGE] as const;
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const context = await requireAiApiContext(request, {
    route: "/api/integrations/ai/owner-acceptance",
    action: "owner-acceptance.read",
    permissions,
  });
  if (!context.ok) return context.response;
  const session = await requestSession(request);
  if (!session) {
    return apiError(
      "authentication-required",
      "A valid session is required.",
      401,
      context.correlationId,
    );
  }
  try {
    return apiJson(await readOwnerLiveAcceptance(context.runtime, session), context.correlationId);
  } catch (error) {
    return openAiApiError(error, context.correlationId);
  }
}

export async function POST(request: NextRequest) {
  const context = await requireAiApiContext(request, {
    route: "/api/integrations/ai/owner-acceptance",
    action: "owner-acceptance.confirm",
    permissions,
    strictMutation: true,
    rateLimit: { key: "owner-acceptance.confirm", limit: 30, windowSeconds: 60 },
  });
  if (!context.ok) return context.response;
  const transport = validateBoundedJsonMutation(request);
  if (!transport.ok) {
    return apiError(transport.code, transport.message, transport.status, context.correlationId);
  }
  const session = await requestSession(request);
  if (!session) {
    return apiError(
      "authentication-required",
      "A valid session is required.",
      401,
      context.correlationId,
    );
  }
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(
        "invalid-json",
        "Confirmation must be valid JSON.",
        400,
        context.correlationId,
      );
    }
    const payload = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    const view = await confirmOwnerPhysicalObservation({
      runtime: context.runtime,
      session,
      correlationId: context.correlationId,
      observationId: (payload as { observationId?: unknown }).observationId,
      confirmed: (payload as { confirmed?: unknown }).confirmed,
      presentationRunId: (payload as { presentationRunId?: unknown }).presentationRunId,
    });
    return apiJson(view, context.correlationId);
  } catch (error) {
    return openAiApiError(error, context.correlationId);
  }
}
