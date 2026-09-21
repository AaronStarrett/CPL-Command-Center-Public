import type {
  AiRealtimeClientAuthorization,
  AiRealtimeSessionConfig,
  AiRequestOptions,
} from "../contracts.js";
import { AiProviderError, normalizeAiProviderError } from "../provider-errors.js";
import type { OpenAiSdkClient } from "./client.js";
import { asRecord } from "./web-search.js";

function safeIdentifierHeaders(identifier: string | undefined): Record<string, string> | undefined {
  return identifier === undefined ? undefined : { "OpenAI-Safety-Identifier": identifier };
}

function realtimeTurnDetection(
  configuration: AiRealtimeSessionConfig,
): Record<string, unknown> | null {
  if (
    configuration.turnDetection === "disabled" ||
    configuration.interactionMode === "push_to_talk"
  ) {
    return null;
  }
  return {
    type: configuration.turnDetection ?? "server_vad",
    create_response: true,
    interrupt_response: configuration.allowInterruption ?? true,
  };
}

export async function createOpenAiRealtimeClientAuthorization(
  client: OpenAiSdkClient,
  configuration: AiRealtimeSessionConfig,
  options: AiRequestOptions,
): Promise<AiRealtimeClientAuthorization> {
  if (!configuration.model.trim() || !configuration.voice.trim()) {
    throw new AiProviderError({
      code: "configuration",
      provider: "openai",
      retryable: false,
      safeMessage: "A Realtime model and voice must be selected.",
    });
  }
  const modalities = configuration.modalities ?? ["audio"];
  if (
    modalities.length !== 1 ||
    (modalities[0] !== "audio" && modalities[0] !== "text") ||
    (configuration.outputSpeed !== undefined &&
      (!Number.isFinite(configuration.outputSpeed) ||
        configuration.outputSpeed < 0.25 ||
        configuration.outputSpeed > 1.5)) ||
    (configuration.maxOutputTokens !== undefined &&
      (!Number.isSafeInteger(configuration.maxOutputTokens) ||
        configuration.maxOutputTokens < 1 ||
        configuration.maxOutputTokens > 4_096))
  ) {
    throw new AiProviderError({
      code: "configuration",
      provider: "openai",
      retryable: false,
      safeMessage: "The Realtime session configuration is invalid.",
    });
  }
  try {
    const headers = safeIdentifierHeaders(options.userSafetyIdentifier);
    const value = await client.realtime.clientSecrets.create(
      {
        expires_after: { anchor: "created_at", seconds: 60 },
        session: {
          type: "realtime",
          model: configuration.model,
          ...(configuration.instructions === undefined
            ? {}
            : { instructions: configuration.instructions }),
          audio: {
            input: {
              turn_detection: realtimeTurnDetection(configuration),
              ...(configuration.inputTranscriptionModel
                ? { transcription: { model: configuration.inputTranscriptionModel } }
                : {}),
            },
            output: {
              voice: configuration.voice,
              ...(configuration.outputSpeed === undefined
                ? {}
                : { speed: configuration.outputSpeed }),
            },
          },
          output_modalities: [...modalities],
          ...(configuration.maxOutputTokens === undefined
            ? {}
            : { max_output_tokens: configuration.maxOutputTokens }),
          ...(configuration.tools?.length
            ? {
                tools: configuration.tools.map((tool) => ({
                  type: "function",
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                })),
                tool_choice: "auto",
              }
            : {}),
        },
      },
      {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
        ...(headers === undefined ? {} : { headers }),
      },
    );
    const response = asRecord(value);
    const secret = typeof response?.value === "string" ? response.value : null;
    const expiresAt = typeof response?.expires_at === "number" ? response.expires_at : null;
    const session = asRecord(response?.session);
    if (
      !secret ||
      !secret.startsWith("ek_") ||
      secret.length > 4_096 ||
      /\s/u.test(secret) ||
      secret.includes("\0") ||
      expiresAt === null
    ) {
      throw new AiProviderError({
        code: "unavailable",
        provider: "openai",
        retryable: true,
        safeMessage: "OpenAI did not return valid short-lived Realtime authorization.",
      });
    }
    return {
      provider: "openai",
      clientSecret: secret,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      ...(typeof session?.id === "string" ? { sessionId: session.id } : {}),
      model: configuration.model,
      voice: configuration.voice,
      simulated: false,
    };
  } catch (error) {
    throw normalizeAiProviderError(error);
  }
}
