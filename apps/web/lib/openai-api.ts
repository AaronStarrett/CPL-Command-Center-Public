import "server-only";

import { apiError } from "@/lib/api-response";
import { OpenAiAdministrationError } from "@/lib/openai-administration";

export function openAiApiError(error: unknown, correlationId: string) {
  if (error instanceof OpenAiAdministrationError) {
    return apiError(
      error.code.toLowerCase().replaceAll("_", "-"),
      error.message,
      error.status,
      correlationId,
    );
  }
  return apiError(
    "openai-provider-request-failed",
    "The OpenAI provider request failed without changing provider activation.",
    500,
    correlationId,
  );
}
