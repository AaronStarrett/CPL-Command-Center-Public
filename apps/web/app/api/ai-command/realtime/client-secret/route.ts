import { createHash, randomUUID } from "node:crypto";

import {
  BEA_REALTIME_TOOLS,
  PHASE21_LIMITS,
  isKnownOpenAiVoice,
  selectAiRoute,
  type AiModelMetadata,
} from "@bea/ai";
import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { apiError, apiJson } from "@/lib/api-response";
import { requireAiApiContext } from "@/lib/ai-command-api";
import { getAssistantPolicyContext } from "@/lib/assistant-policy";
import {
  authorizeLiveRealtimeOwner,
  OpenAiAdministrationError,
  requireLiveOwnerAuthorization,
  resolveAiCommandProvider,
} from "@/lib/openai-administration";
import { openAiApiError } from "@/lib/openai-api";
import { validateBoundedJsonMutation } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SAFE_SELECTION = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/u;
const SAFE_CONVERSATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REQUEST_KEYS = new Set(["conversationId", "model", "voice"]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function selection(value: unknown, fallback: string): string | null {
  if (value === undefined) return fallback;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return SAFE_SELECTION.test(normalized) ? normalized : null;
}

export async function POST(request: NextRequest) {
  const context = await requireAiApiContext(request, {
    route: "/api/ai-command/realtime/client-secret",
    action: "ai-command.realtime.authorize",
    permissions: [
      PERMISSIONS.AI_COMMAND_RUN,
      PERMISSIONS.INTEGRATIONS_MANAGE,
      PERMISSIONS.SETTINGS_MANAGE,
    ],
    strictMutation: true,
    rateLimit: { key: "ai-command.realtime.authorize", limit: 5, windowSeconds: 60 },
  });
  if (!context.ok) return context.response;

  const transport = validateBoundedJsonMutation(request);
  if (!transport.ok) {
    return apiError(transport.code, transport.message, transport.status, context.correlationId);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(
      "invalid-json",
      "Realtime settings must be valid JSON.",
      400,
      context.correlationId,
    );
  }
  const input = record(body);
  if (!input || Object.keys(input).some((key) => !REQUEST_KEYS.has(key))) {
    return apiError(
      "invalid-realtime-request",
      "Realtime settings are invalid.",
      400,
      context.correlationId,
    );
  }

  try {
    const settings = await context.runtime.ai.persistence.getProviderSettings();
    if (!settings.realtimeAllowed) {
      throw new OpenAiAdministrationError(
        "REALTIME_DISABLED",
        403,
        "Realtime is disabled by provider policy.",
      );
    }
    const provider = await resolveAiCommandProvider(context.runtime);
    const voice = selection(input.voice, settings.defaultVoice);
    const providerVoiceAllowed =
      voice !== null &&
      (provider.providerKey === "demo"
        ? voice === "demo" || isKnownOpenAiVoice(voice)
        : isKnownOpenAiVoice(voice));
    if (!voice || voice !== settings.defaultVoice || !providerVoiceAllowed) {
      throw new OpenAiAdministrationError(
        "INVALID_REALTIME_SELECTION",
        400,
        "The Realtime model or voice is invalid.",
      );
    }

    const user = await context.runtime.repository.findActiveUserById(context.userId);
    if (!user) {
      throw new OpenAiAdministrationError(
        "REALTIME_ROLE_UNAVAILABLE",
        403,
        "Realtime voice is not available for your role.",
      );
    }
    const configuredRealtimeRoute = settings.routingProfile.routes.realtime_voice;
    const roleKey = user.roleIds.find((roleId) =>
      configuredRealtimeRoute.roleAvailability.includes(roleId),
    );
    if (!roleKey) {
      throw new OpenAiAdministrationError(
        "REALTIME_ROLE_UNAVAILABLE",
        403,
        "Realtime voice is not available for your role.",
      );
    }
    const conversationId =
      typeof input.conversationId === "string" && SAFE_CONVERSATION_ID.test(input.conversationId)
        ? input.conversationId
        : null;
    if (!conversationId) {
      throw new OpenAiAdministrationError(
        "REALTIME_CONVERSATION_REQUIRED",
        400,
        "A current AI Command conversation is required for Realtime.",
      );
    }
    const conversation = await context.runtime.phase1.getConversation(
      conversationId,
      context.userId,
    );
    if (!conversation) {
      throw new OpenAiAdministrationError(
        "REALTIME_CONVERSATION_UNAVAILABLE",
        404,
        "The AI Command conversation is unavailable.",
      );
    }
    const activeSessions = await context.runtime.ai.persistence.countActiveRealtimeSessionsForUser(
      context.userId,
    );
    if (activeSessions >= PHASE21_LIMITS.realtimeSessionsPerUser) {
      throw new OpenAiAdministrationError(
        "REALTIME_SESSION_LIMIT",
        429,
        "A Realtime voice session is already active. Stop it before starting another.",
      );
    }
    const availableModels =
      provider.providerKey === "demo"
        ? await provider.listModels()
        : await context.runtime.ai.persistence.listCachedModels("openai");
    const models: AiModelMetadata[] = availableModels.map((candidate) => {
      const modelId = "modelId" in candidate ? candidate.modelId : candidate.id;
      const capabilities = {
        ...(candidate.capabilities as AiModelMetadata["capabilities"]),
        ...((record(settings.modelCapabilityOverrides[modelId]) ?? {}) as Partial<
          AiModelMetadata["capabilities"]
        >),
      };
      return "modelId" in candidate
        ? {
            id: candidate.modelId,
            provider: candidate.provider,
            displayName: candidate.modelId,
            available: candidate.available,
            ...(candidate.ownedBy === null ? {} : { ownedBy: candidate.ownedBy }),
            capabilities,
            capabilitySource: candidate.capabilitySource,
            validation: candidate.validation,
          }
        : { ...candidate, capabilities };
    });
    const routingProfile =
      provider.providerKey === "demo" && configuredRealtimeRoute.primaryModel === null
        ? {
            ...settings.routingProfile,
            routes: {
              ...settings.routingProfile.routes,
              realtime_voice: {
                ...configuredRealtimeRoute,
                primaryModel: settings.defaultRealtimeModel,
              },
            },
          }
        : settings.routingProfile;
    const realtimeRoute = routingProfile.routes.realtime_voice;
    const routeDecision = selectAiRoute({
      routeKey: "realtime_voice",
      profile: routingProfile,
      models,
      roleKey,
    });
    const model = selection(input.model, routeDecision.selectedModel);
    if (!model || model !== routeDecision.selectedModel) {
      throw new OpenAiAdministrationError(
        "INVALID_REALTIME_SELECTION",
        400,
        "The Realtime model or voice is invalid.",
      );
    }
    const routeToolAllowlist = new Set(routeDecision.toolAllowlist);
    const realtimeTools = BEA_REALTIME_TOOLS.filter((tool) => routeToolAllowlist.has(tool.name));
    if (settings.inputTranscriptionModel) {
      const transcription = models.find(
        (candidate) => candidate.id === settings.inputTranscriptionModel && candidate.available,
      );
      if (!transcription || transcription.capabilities.audioInput !== true) {
        throw new OpenAiAdministrationError(
          "TRANSCRIPTION_CAPABILITY_UNAVAILABLE",
          409,
          "The selected input-transcription model is not verified for audio input.",
        );
      }
    }

    const realtimeOwnerAuthorization =
      provider.providerKey === "openai"
        ? await authorizeLiveRealtimeOwner({
            runtime: context.runtime,
            actorUserId: context.userId,
            correlationId: context.correlationId,
          })
        : undefined;
    requireLiveOwnerAuthorization(provider.providerKey, "realtime", realtimeOwnerAuthorization);
    const [voicePreference, requestId] = await Promise.all([
      context.runtime.ai.persistence.getUserVoicePreference(context.userId),
      Promise.resolve(randomUUID()),
    ]);
    const assistantPolicy = await getAssistantPolicyContext(context.runtime, context.userId);
    const authorization = await provider.createRealtimeClientAuthorization(
      {
        model,
        voice,
        instructions: `${provider.providerKey === "demo" ? assistantPolicy.internalInstructions : assistantPolicy.providerInstructions}\n${settings.realtimeSessionInstructions}\nRealtime answers should be concise; place detailed reports and sources in the right workspace. Use only registered BEA Realtime tools. Synthetic records remain labeled. Never claim a task was created; task tools produce a confirmation-gated preview only.`,
        modalities: [voicePreference.speakResponses ? "audio" : "text"],
        tools: realtimeTools,
        turnDetection: settings.realtimeTurnDetection,
        interactionMode: settings.realtimeInteractionMode,
        allowInterruption: settings.realtimeAllowInterruption,
        inputTranscriptionModel: settings.inputTranscriptionModel,
        outputSpeed: settings.realtimeOutputSpeed,
        maxOutputTokens: Math.min(settings.realtimeMaxOutputTokens, realtimeRoute.maxOutputTokens),
      },
      {
        requestId,
        correlationId: context.correlationId,
        timeoutMs: realtimeRoute.timeoutMs,
        signal: request.signal,
        userSafetyIdentifier: createHash("sha256")
          .update(`bea-realtime:${context.userId}`)
          .digest("hex"),
      },
    );
    const expiresAt = Date.parse(authorization.expiresAt);
    if (
      (!authorization.simulated &&
        (!authorization.clientSecret.startsWith("ek_") ||
          authorization.clientSecret.length > 4_096 ||
          /\s/u.test(authorization.clientSecret) ||
          authorization.clientSecret.includes("\0"))) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now() ||
      expiresAt > Date.now() + 120_000
    ) {
      throw new OpenAiAdministrationError(
        "INVALID_REALTIME_EXPIRY",
        502,
        "The provider returned invalid short-lived Realtime authorization.",
      );
    }
    const persistedSessionId = await context.runtime.ai.persistence.recordRealtimeSession({
      conversationId: conversation.id,
      requestedByUserId: context.userId,
      provider: authorization.simulated ? "demo" : "openai",
      providerSessionId: authorization.sessionId ?? null,
      model: authorization.model,
      voice: authorization.voice,
      status: "authorized",
      correlationId: context.correlationId,
      authorizedAt: new Date().toISOString(),
      expiresAt: authorization.expiresAt,
      completedAt: null,
      errorCode: null,
      simulated: authorization.simulated,
      policyProvenance: assistantPolicy.provenance,
      routeDecision,
    });
    await context.runtime.repository.record({
      eventType: "ai-provider.realtime-authorized",
      action: "ai-command.realtime.authorize",
      outcome: "succeeded",
      actorUserId: context.userId,
      resourceType: "ai-realtime-session",
      resourceId: persistedSessionId,
      correlationId: context.correlationId,
      metadata: {
        provider: authorization.provider,
        model,
        voice,
        simulated: authorization.simulated,
        policyProvenance: assistantPolicy.provenance,
        routeDecision: {
          ...routeDecision,
          requiredCapabilities: [...routeDecision.requiredCapabilities],
          toolAllowlist: [...routeDecision.toolAllowlist],
        },
        conversationId: conversation.id,
      },
    });
    return apiJson(
      {
        authorization: {
          ...authorization,
          beaSessionId: persistedSessionId,
          interactionMode: settings.realtimeInteractionMode,
          allowInterruption: settings.realtimeAllowInterruption,
          speakResponses: voicePreference.speakResponses,
          webrtcEndpoint: authorization.simulated
            ? null
            : "https://api.openai.com/v1/realtime/calls",
        },
      },
      context.correlationId,
    );
  } catch (error) {
    return openAiApiError(error, context.correlationId);
  }
}
