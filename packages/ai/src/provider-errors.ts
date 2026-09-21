export type AiProviderErrorCode =
  | "authentication"
  | "quota"
  | "rate_limit"
  | "timeout"
  | "cancelled"
  | "unavailable"
  | "invalid_request"
  | "capability_unavailable"
  | "configuration"
  | "unknown";

export interface AiProviderErrorOptions {
  readonly code: AiProviderErrorCode;
  readonly provider: string;
  readonly retryable: boolean;
  readonly safeMessage: string;
  readonly status?: number;
  readonly retryAfterSeconds?: number;
}

/** A provider failure whose public surface never contains credentials or raw provider payloads. */
export class AiProviderError extends Error {
  readonly code: AiProviderErrorCode;
  readonly provider: string;
  readonly retryable: boolean;
  readonly safeMessage: string;
  readonly status: number | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(options: AiProviderErrorOptions) {
    // Never retain a raw SDK/provider error: it may contain headers, request bodies, or credentials.
    super(options.safeMessage);
    this.name = "AiProviderError";
    this.code = options.code;
    this.provider = options.provider;
    this.retryable = options.retryable;
    this.safeMessage = options.safeMessage;
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

function numericStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}

function stringCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function stringName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("name" in error)) return undefined;
  return typeof error.name === "string" ? error.name : undefined;
}

export function normalizeAiProviderError(error: unknown, provider = "openai"): AiProviderError {
  if (error instanceof AiProviderError) return error;
  const name = stringName(error);
  const code = stringCode(error);
  if (name === "AbortError" || code === "ABORT_ERR") {
    return new AiProviderError({
      code: "cancelled",
      provider,
      retryable: false,
      safeMessage: "The AI request was cancelled.",
    });
  }

  const status = numericStatus(error);
  if (
    name === "APIConnectionTimeoutError" ||
    code === "ETIMEDOUT" ||
    code === "ECONNABORTED" ||
    code === "request_timeout"
  ) {
    return new AiProviderError({
      code: "timeout",
      provider,
      retryable: true,
      safeMessage: "OpenAI did not respond before the configured timeout.",
      ...(status === undefined ? {} : { status }),
    });
  }
  if (status === 401) {
    return new AiProviderError({
      code: "authentication",
      provider,
      retryable: false,
      safeMessage: "The OpenAI project key was rejected.",
      status,
    });
  }
  if (status === 403) {
    return new AiProviderError({
      code: "authentication",
      provider,
      retryable: false,
      safeMessage: "The OpenAI project key does not have permission for this operation or project.",
      status,
    });
  }
  if (
    code === "insufficient_quota" ||
    code === "billing_hard_limit_reached" ||
    code === "billing_not_active"
  ) {
    return new AiProviderError({
      code: "quota",
      provider,
      retryable: false,
      safeMessage:
        "The OpenAI project has no available quota, billing capacity, or is currently rate limited.",
      ...(status === undefined ? {} : { status }),
    });
  }
  if (status === 429 || code === "rate_limit_exceeded") {
    return new AiProviderError({
      code: "rate_limit",
      provider,
      retryable: true,
      safeMessage:
        "The OpenAI project has no available quota, billing capacity, or is currently rate limited.",
      ...(status === undefined ? {} : { status }),
    });
  }
  if (status === 400 || status === 404 || status === 422) {
    return new AiProviderError({
      code: "invalid_request",
      provider,
      retryable: false,
      safeMessage: "OpenAI rejected the request or selected capability.",
      status,
    });
  }
  if (status !== undefined && status >= 500) {
    return new AiProviderError({
      code: "unavailable",
      provider,
      retryable: true,
      safeMessage: "OpenAI is temporarily unavailable.",
      status,
    });
  }
  if (
    name === "APIConnectionError" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN"
  ) {
    return new AiProviderError({
      code: "unavailable",
      provider,
      retryable: true,
      safeMessage: "OpenAI is temporarily unavailable.",
    });
  }
  return new AiProviderError({
    code: "unknown",
    provider,
    retryable: false,
    safeMessage: "The AI provider request failed.",
    ...(status === undefined ? {} : { status }),
  });
}
