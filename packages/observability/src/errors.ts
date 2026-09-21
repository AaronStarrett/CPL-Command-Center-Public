import type { JsonObject } from "@bea/domain";

export interface ErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly correlationId: string;
    readonly diagnostics?: JsonObject;
  };
}

interface CodedError extends Error {
  readonly code?: string;
}

function isCodedError(error: unknown): error is CodedError {
  return error instanceof Error;
}

function safeErrorCode(error: unknown): string {
  const candidate = isCodedError(error) ? error.code : undefined;
  return candidate && /^[A-Z][A-Z0-9_]{0,63}$/u.test(candidate) ? candidate : "INTERNAL_ERROR";
}

function safeErrorName(error: Error): string {
  return /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u.test(error.name) ? error.name : "Error";
}

export interface SafeErrorDetails {
  readonly errorName: string;
  readonly errorCode: string;
}

export function toSafeErrorDetails(
  error: unknown,
  fallbackErrorCode = "INTERNAL_ERROR",
): SafeErrorDetails {
  const candidateCode = safeErrorCode(error);
  const validatedFallback = /^[A-Z][A-Z0-9_]{0,63}$/u.test(fallbackErrorCode)
    ? fallbackErrorCode
    : "INTERNAL_ERROR";
  return {
    errorName: error instanceof Error ? safeErrorName(error) : "UnknownError",
    errorCode: candidateCode === "INTERNAL_ERROR" ? validatedFallback : candidateCode,
  };
}

export function toErrorResponse(input: {
  error: unknown;
  correlationId: string;
  includeDiagnostics: boolean;
}): ErrorResponse {
  const code = safeErrorCode(input.error);
  const safeMessage =
    code === "ACCESS_DENIED"
      ? "You do not have permission to perform this action."
      : "The request could not be completed.";
  const diagnostics =
    input.includeDiagnostics && input.error instanceof Error
      ? { errorName: safeErrorName(input.error), errorCode: code }
      : undefined;
  return {
    error: {
      code,
      message: safeMessage,
      correlationId: input.correlationId,
      ...(diagnostics ? { diagnostics } : {}),
    },
  };
}
