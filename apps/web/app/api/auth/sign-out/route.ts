import { getServerRuntime } from "@bea/database";
import { NextRequest, NextResponse } from "next/server";

import { correlationHeaders, requestCorrelationId, webRouteLogger } from "@/app/api/route-helpers";
import { sessionCookieName } from "@/lib/auth/session-store";
import { apiError, apiException } from "@/lib/api-response";
import { isSameOriginRequest, isStrictSameOriginMutation } from "@/lib/request-security";

export async function POST(request: NextRequest) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/auth/sign-out", "POST");

  try {
    const runtime = await getServerRuntime();
    const appBaseUrl = runtime.environment.appBaseUrl;
    const provider = runtime.authentication.kind;
    const originAllowed =
      provider === "local-owner"
        ? isStrictSameOriginMutation(request, appBaseUrl)
        : isSameOriginRequest(request, appBaseUrl);
    if (!originAllowed) {
      await runtime.repository.record({
        eventType: "authentication.sign-out-denied",
        action: `${provider}.sign-out`,
        outcome: "denied",
        correlationId,
        metadata: { reason: "cross-origin-request" },
      });
      logger.warn({ provider }, "Cross-origin sign-out rejected");
      return apiError(
        "cross-origin-request-rejected",
        "Cross-origin sign-out was rejected.",
        403,
        correlationId,
      );
    }

    const cookieName = sessionCookieName(runtime.environment.authProvider);
    const token = cookieName ? request.cookies.get(cookieName)?.value : undefined;
    const signedOut = token ? await runtime.authentication.signOut(token, correlationId) : false;
    if (!signedOut) {
      await runtime.repository.record({
        eventType: "authentication.sign-out-denied",
        action: `${provider}.sign-out`,
        outcome: "denied",
        correlationId,
        metadata: { reason: "missing-or-invalid-session" },
      });
    }

    const response = NextResponse.redirect(new URL("/sign-in?reason=signed-out", appBaseUrl), 303);
    if (cookieName) response.cookies.delete(cookieName);
    for (const [key, value] of Object.entries(correlationHeaders(correlationId))) {
      response.headers.set(key, value);
    }
    logger.info({ signedOut, provider }, "Sign-out completed");
    return response;
  } catch (error) {
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Sign-out failed",
    );
    return apiException(error, 500, correlationId, false);
  }
}
