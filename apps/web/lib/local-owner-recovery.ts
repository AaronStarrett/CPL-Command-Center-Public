import type { BeaServerRuntime } from "@bea/database";
import {
  LocalOwnerAuthenticationAdapter,
  LocalOwnerAuthenticationError,
  LocalOwnerPasswordPolicyError,
} from "@bea/security";

import { isStrictSameOriginMutation } from "./request-security";

const MAX_RECOVERY_FORM_BYTES = 8_192;

export type LocalOwnerRecoveryRuntime = Pick<
  BeaServerRuntime,
  "environment" | "authentication" | "repository" | "ai"
>;

function errorResponse(
  code: string,
  message: string,
  status: number,
  correlationId: string,
): Response {
  return new Response(JSON.stringify({ error: { code, message, correlationId } }), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Correlation-ID": correlationId,
    },
  });
}

function boundedRecoveryForm(request: Request): boolean {
  if (request.headers.has("transfer-encoding")) return false;
  const contentLength = request.headers.get("content-length")?.trim();
  if (!contentLength || !/^[1-9][0-9]{0,5}$/u.test(contentLength)) return false;
  const bytes = Number(contentLength);
  if (!Number.isSafeInteger(bytes) || bytes > MAX_RECOVERY_FORM_BYTES) return false;
  const contentType = request.headers.get("content-type")?.trim().toLowerCase();
  return (
    contentType === "application/x-www-form-urlencoded" ||
    contentType === "application/x-www-form-urlencoded;charset=utf-8" ||
    contentType === "application/x-www-form-urlencoded; charset=utf-8"
  );
}

function genericRecoveryFailure(appBaseUrl: string, correlationId: string): Response {
  const failedUrl = new URL("/recover", appBaseUrl);
  failedUrl.searchParams.set("status", "failed");
  return new Response(null, {
    status: 303,
    headers: {
      "Cache-Control": "no-store",
      Location: failedUrl.href,
      "X-Correlation-ID": correlationId,
    },
  });
}

function recoverySuccess(recoveryCode: string, correlationId: string): Response {
  const safeRecoveryCode = recoveryCode.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  const body = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Recovery complete</title></head>
<body>
  <main>
    <h1>Local Owner recovery complete</h1>
    <p>All prior sessions were revoked. Store this replacement recovery code now; it will not be shown again.</p>
    <p><code id="replacement-recovery-code">${safeRecoveryCode}</code></p>
    <p><a href="/sign-in">Continue to sign-in</a></p>
  </main>
</body>
</html>`;
  return new Response(body, {
    status: 200,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "Content-Security-Policy":
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Correlation-ID": correlationId,
    },
  });
}

export async function handleLocalOwnerRecovery(
  request: Request,
  runtime: LocalOwnerRecoveryRuntime,
  correlationId: string,
): Promise<Response> {
  const appBaseUrl = runtime.environment.appBaseUrl;
  if (
    runtime.environment.deploymentProfile !== "local-live" ||
    runtime.environment.authProvider !== "local-owner" ||
    !(runtime.authentication instanceof LocalOwnerAuthenticationAdapter)
  ) {
    return errorResponse(
      "local-owner-recovery-unavailable",
      "Local Owner recovery is unavailable.",
      404,
      correlationId,
    );
  }
  if (!isStrictSameOriginMutation(request, appBaseUrl)) {
    await runtime.repository.record({
      eventType: "authentication.recovery-denied",
      action: "local-owner.recover",
      outcome: "denied",
      correlationId,
      metadata: { reason: "cross-origin-request" },
    });
    return errorResponse(
      "cross-origin-request-rejected",
      "The recovery request was rejected.",
      403,
      correlationId,
    );
  }
  if (!boundedRecoveryForm(request)) {
    await runtime.repository.record({
      eventType: "authentication.recovery-denied",
      action: "local-owner.recover",
      outcome: "denied",
      correlationId,
      metadata: { reason: "invalid-request-envelope" },
    });
    return errorResponse(
      "invalid-recovery-request",
      "The recovery request could not be accepted.",
      400,
      correlationId,
    );
  }
  const rateLimit = await runtime.ai.persistence.consumeRateLimit({
    subjectKey: "authentication:local-owner:loopback",
    routeKey: "local-owner.recover",
    limit: 5,
    windowSeconds: 900,
  });
  if (!rateLimit.allowed) {
    await runtime.repository.record({
      eventType: "authentication.recovery-denied",
      action: "local-owner.recover",
      outcome: "denied",
      correlationId,
      metadata: { reason: "rate-limited", resetAt: rateLimit.resetAt },
    });
    const response = genericRecoveryFailure(appBaseUrl, correlationId);
    response.headers.set(
      "Retry-After",
      String(Math.max(1, Math.ceil((Date.parse(rateLimit.resetAt) - Date.now()) / 1_000))),
    );
    return response;
  }

  const form = await request.formData();
  const username = String(form.get("username") ?? "");
  const recoveryCode = String(form.get("recoveryCode") ?? "");
  const newPassword = String(form.get("newPassword") ?? "");
  const confirmPassword = String(form.get("confirmPassword") ?? "");
  const invalidShape =
    Buffer.byteLength(username, "utf8") > 256 ||
    Buffer.byteLength(recoveryCode, "utf8") > 256 ||
    Buffer.byteLength(newPassword, "utf8") > 1_024 ||
    Buffer.byteLength(confirmPassword, "utf8") > 1_024 ||
    newPassword !== confirmPassword;
  if (invalidShape) {
    await runtime.repository.record({
      eventType: "authentication.recovery-denied",
      action: "local-owner.recover",
      outcome: "denied",
      correlationId,
      metadata: { reason: "invalid-request-fields" },
    });
    return genericRecoveryFailure(appBaseUrl, correlationId);
  }
  try {
    const result = await runtime.authentication.recoverOwner(
      username,
      recoveryCode,
      newPassword,
      correlationId,
    );
    return recoverySuccess(result.recoveryCode, correlationId);
  } catch (error) {
    if (
      error instanceof LocalOwnerAuthenticationError ||
      error instanceof LocalOwnerPasswordPolicyError
    ) {
      return genericRecoveryFailure(appBaseUrl, correlationId);
    }
    throw error;
  }
}
