import {
  parseExactHttpOrigin,
  selectTrustedRequestOrigin,
  trustedRequestOrigins,
} from "@bea/config";

function trustedOriginsForRequest(trustedBaseUrl?: string): readonly string[] {
  const appBaseUrl = trustedBaseUrl || process.env.APP_BASE_URL;
  if (!appBaseUrl) return [];
  try {
    return trustedRequestOrigins({
      appBaseUrl,
      ...(process.env.BEA_DEPLOYMENT_PROFILE
        ? { deploymentProfile: process.env.BEA_DEPLOYMENT_PROFILE }
        : {}),
      ...(process.env.BEA_OWNER_EVALUATION_PUBLIC_ORIGIN
        ? { ownerEvaluationPublicOrigin: process.env.BEA_OWNER_EVALUATION_PUBLIC_ORIGIN }
        : {}),
    });
  } catch {
    try {
      return [parseExactHttpOrigin(appBaseUrl, "APP_BASE_URL")];
    } catch {
      return [];
    }
  }
}

export function browserRedirectOrigin(request: Request, appBaseUrl: string): string {
  return selectTrustedRequestOrigin(request, {
    appBaseUrl,
    ...(process.env.BEA_DEPLOYMENT_PROFILE
      ? { deploymentProfile: process.env.BEA_DEPLOYMENT_PROFILE }
      : {}),
    ...(process.env.BEA_OWNER_EVALUATION_PUBLIC_ORIGIN
      ? { ownerEvaluationPublicOrigin: process.env.BEA_OWNER_EVALUATION_PUBLIC_ORIGIN }
      : {}),
  });
}

export function isSameOriginRequest(
  request: Request,
  trustedBaseUrl = process.env.APP_BASE_URL,
): boolean {
  const suppliedOrigin = request.headers.get("origin");
  if (!suppliedOrigin) return true;

  let normalizedSuppliedOrigin: string;
  try {
    const parsed = new URL(suppliedOrigin);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return false;
    }
    normalizedSuppliedOrigin = parsed.origin;
  } catch {
    return false;
  }

  const trusted = trustedOriginsForRequest(trustedBaseUrl);
  if (trusted.length > 0) return trusted.includes(normalizedSuppliedOrigin);

  try {
    return normalizedSuppliedOrigin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export function isStrictSameOriginMutation(request: Request, expectedOrigin: string): boolean {
  const origin = request.headers.get("origin")?.trim();
  if (!origin || !isSameOriginRequest(request, expectedOrigin)) return false;
  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  return fetchSite === undefined || fetchSite === "same-origin";
}

export const MAX_JSON_MUTATION_BYTES = 64 * 1024;

export interface RequestTransportFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly status: 400 | 411 | 413 | 415;
}

export type RequestTransportValidation =
  { readonly ok: true; readonly contentLength: number } | RequestTransportFailure;

function contentLength(request: Request): number | null | "invalid" {
  const supplied = request.headers.get("content-length")?.trim();
  if (supplied === undefined) return null;
  if (!/^(?:0|[1-9][0-9]{0,9})$/u.test(supplied)) return "invalid";
  const parsed = Number(supplied);
  return Number.isSafeInteger(parsed) ? parsed : "invalid";
}

/**
 * Validates a JSON mutation before any route buffers/parses its body. Chunked or
 * ambiguous bodies fail closed so an upstream proxy cannot bypass the byte cap.
 */
export function validateBoundedJsonMutation(
  request: Request,
  maximumBytes = MAX_JSON_MUTATION_BYTES,
): RequestTransportValidation {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("The JSON mutation byte limit must be a positive safe integer.");
  }
  if (request.headers.has("transfer-encoding")) {
    return {
      ok: false,
      code: "ambiguous-request-body",
      message: "The request body must use a finite Content-Length.",
      status: 400,
    };
  }
  const length = contentLength(request);
  if (length === null) {
    return {
      ok: false,
      code: "content-length-required",
      message: "A finite Content-Length is required.",
      status: 411,
    };
  }
  if (length === "invalid" || length < 1) {
    return {
      ok: false,
      code: "invalid-content-length",
      message: "The request Content-Length is invalid.",
      status: 400,
    };
  }
  if (length > maximumBytes) {
    return {
      ok: false,
      code: "request-body-too-large",
      message: "The request body exceeds the allowed size.",
      status: 413,
    };
  }
  const mediaType = request.headers.get("content-type")?.trim().toLowerCase();
  if (!mediaType || !/^application\/json(?:\s*;\s*charset=utf-8)?$/u.test(mediaType)) {
    return {
      ok: false,
      code: "unsupported-content-type",
      message: "The request Content-Type must be application/json.",
      status: 415,
    };
  }
  return { ok: true, contentLength: length };
}

export function hasJsonMutationBody(request: Request): boolean {
  if (request.headers.has("transfer-encoding")) return true;
  const length = contentLength(request);
  return typeof length === "number" && length > 0;
}

export function validateBodylessMutation(request: Request): RequestTransportValidation {
  if (request.headers.has("transfer-encoding")) {
    return {
      ok: false,
      code: "unexpected-request-body",
      message: "This action does not accept a request body.",
      status: 400,
    };
  }
  const length = contentLength(request);
  if (length === "invalid") {
    return {
      ok: false,
      code: "invalid-content-length",
      message: "The request Content-Length is invalid.",
      status: 400,
    };
  }
  if (length !== null && length !== 0) {
    return {
      ok: false,
      code: "unexpected-request-body",
      message: "This action does not accept a request body.",
      status: 400,
    };
  }
  // Node/undici exposes empty POST bodies as a ReadableStream even when
  // Content-Length is 0. Browser fetch("POST") for Verify/Test does the same.
  if (length === 0) {
    return { ok: true, contentLength: 0 };
  }
  if (request.body !== null) {
    return {
      ok: false,
      code: "unexpected-request-body",
      message: "This action does not accept a request body.",
      status: 400,
    };
  }
  return { ok: true, contentLength: 0 };
}
