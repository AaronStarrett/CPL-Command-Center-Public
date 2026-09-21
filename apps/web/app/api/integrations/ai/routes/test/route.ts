import { selectAiRoute, type AiModelCapabilities, type AiModelMetadata } from "@bea/ai";
import { AI_WORKLOAD_ROUTE_KEYS, type AiWorkloadRouteKey } from "@bea/domain";
import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { apiError, apiJson } from "@/lib/api-response";
import { requireAiApiContext } from "@/lib/ai-command-api";
import { requireOpenAiLiveAdministrationAllowed } from "@/lib/openai-administration";
import { openAiApiError } from "@/lib/openai-api";
import { validateBoundedJsonMutation } from "@/lib/request-security";

const permissions = [PERMISSIONS.INTEGRATIONS_MANAGE, PERMISSIONS.SETTINGS_MANAGE] as const;
const routeKeys = new Set<string>(AI_WORKLOAD_ROUTE_KEYS);
export const dynamic = "force-dynamic";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function POST(request: NextRequest) {
  const context = await requireAiApiContext(request, {
    route: "/api/integrations/ai/routes/test",
    action: "openai.routing.test",
    permissions,
    strictMutation: true,
    rateLimit: { key: "openai.routing.test", limit: 30, windowSeconds: 60 },
  });
  if (!context.ok) return context.response;
  const transport = validateBoundedJsonMutation(request);
  if (!transport.ok) {
    return apiError(transport.code, transport.message, transport.status, context.correlationId);
  }
  try {
    requireOpenAiLiveAdministrationAllowed();
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(
        "invalid-json",
        "Route validation must be valid JSON.",
        400,
        context.correlationId,
      );
    }
    const value = record(body);
    const routeKey = value.routeKey;
    if (
      Object.keys(value).length !== 1 ||
      typeof routeKey !== "string" ||
      !routeKeys.has(routeKey)
    ) {
      return apiError(
        "invalid-route-key",
        "A recognized workload route is required.",
        400,
        context.correlationId,
      );
    }

    const [settings, cachedModels, user] = await Promise.all([
      context.runtime.ai.persistence.getProviderSettings(),
      context.runtime.ai.persistence.listCachedModels("openai"),
      context.runtime.repository.findActiveUserById(context.userId),
    ]);
    if (!user) {
      return apiError(
        "authentication-required",
        "The active user is unavailable.",
        401,
        context.correlationId,
      );
    }
    const policy = settings.routingProfile.routes[routeKey as AiWorkloadRouteKey];
    const roleKey = user.roleIds.find((roleId) => policy.roleAvailability.includes(roleId)) ?? "";
    const models: AiModelMetadata[] = cachedModels.map((model) => ({
      id: model.modelId,
      provider: model.provider,
      displayName: model.modelId,
      available: model.available,
      ...(model.ownedBy ? { ownedBy: model.ownedBy } : {}),
      capabilities: {
        ...record(model.capabilities),
        ...record(settings.modelCapabilityOverrides[model.modelId]),
      } as unknown as AiModelCapabilities,
      capabilitySource: model.capabilitySource,
      validation: model.validation,
    }));
    const decision = selectAiRoute({
      routeKey: routeKey as AiWorkloadRouteKey,
      profile: settings.routingProfile,
      models,
      roleKey,
    });
    await context.runtime.repository.record({
      eventType: "ai-provider.route-validated",
      action: "openai.routing.test",
      outcome: "succeeded",
      actorUserId: context.userId,
      resourceType: "ai-routing-profile",
      resourceId: routeKey,
      correlationId: context.correlationId,
      metadata: {
        routeKey,
        selectedModel: decision.selectedModel,
        usedFallback: decision.usedFallback,
        validation: "configuration-only",
        providerCalled: false,
      },
    });
    return apiJson(
      { decision, validation: "configuration-only", providerCalled: false },
      context.correlationId,
    );
  } catch (error) {
    return openAiApiError(error, context.correlationId);
  }
}
