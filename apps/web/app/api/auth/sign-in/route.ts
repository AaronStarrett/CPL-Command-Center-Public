import { getServerRuntime } from "@bea/database";
import { LocalOwnerAuthenticationError, type SignInResult } from "@bea/security";
import { NextRequest, NextResponse } from "next/server";

import { correlationHeaders, requestCorrelationId, webRouteLogger } from "@/app/api/route-helpers";
import { apiError, apiException } from "@/lib/api-response";
import { getDemoPersona } from "@/lib/auth/personas";
import {
  browserRedirectOrigin,
  isSameOriginRequest,
  isStrictSameOriginMutation,
} from "@/lib/request-security";
import { safeReturnPath } from "@/lib/safe-return-path";

export async function POST(request: NextRequest) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/auth/sign-in", "POST");
  let appBaseUrl: string | undefined;

  try {
    const runtime = await getServerRuntime();
    appBaseUrl = runtime.environment.appBaseUrl;
    const provider = runtime.authentication.kind;
    const originAllowed =
      provider === "local-owner"
        ? isStrictSameOriginMutation(request, appBaseUrl)
        : isSameOriginRequest(request, appBaseUrl);
    if (!originAllowed) {
      await runtime.repository.record({
        eventType: "authentication.sign-in-denied",
        action: `${provider}.sign-in`,
        outcome: "denied",
        correlationId,
        metadata: { reason: "cross-origin-request" },
      });
      logger.warn({ provider }, "Cross-origin sign-in rejected");
      return apiError(
        "cross-origin-request-rejected",
        "Cross-origin sign-in was rejected.",
        403,
        correlationId,
      );
    }
    if (provider === "microsoft-entra") {
      await runtime.repository.record({
        eventType: "authentication.sign-in-denied",
        action: "microsoft-entra.sign-in",
        outcome: "denied",
        correlationId,
        metadata: { reason: "provider-not-connected" },
      });
      logger.warn({}, "Microsoft Entra sign-in is not connected");
      return apiError(
        "authentication-provider-unavailable",
        "The configured authentication provider is not connected.",
        404,
        correlationId,
      );
    }

    const formData = await request.formData();
    const redirectOrigin = browserRedirectOrigin(request, appBaseUrl);
    const returnTo = safeReturnPath(formData.get("returnTo"), "/command-center", redirectOrigin);
    let result: SignInResult;
    if (provider === "demo") {
      if (!runtime.environment.demoAuthEnabled) {
        return apiError(
          "demo-auth-disabled",
          "Demo authentication is disabled.",
          404,
          correlationId,
        );
      }
      const personaId = String(formData.get("personaId") ?? "");
      const persona = getDemoPersona(personaId);
      if (!persona) {
        await runtime.repository.record({
          eventType: "authentication.sign-in-denied",
          action: "demo.sign-in",
          outcome: "denied",
          correlationId,
          metadata: { reason: "invalid-persona-id" },
        });
        logger.warn({}, "Demo sign-in rejected for unknown persona identifier");
        const invalidUrl = new URL("/sign-in", redirectOrigin);
        invalidUrl.searchParams.set("error", "invalid-persona");
        invalidUrl.searchParams.set("returnTo", returnTo);
        const response = NextResponse.redirect(invalidUrl, 303);
        response.headers.set("X-Correlation-ID", correlationId);
        return response;
      }
      result = await runtime.authentication.signIn(persona.key, correlationId);
    } else {
      const rateLimit = await runtime.ai.persistence.consumeRateLimit({
        subjectKey: "authentication:local-owner:loopback",
        routeKey: "local-owner.sign-in",
        limit: 10,
        windowSeconds: 60,
      });
      if (!rateLimit.allowed) {
        await runtime.repository.record({
          eventType: "authentication.sign-in-denied",
          action: "local-owner.sign-in",
          outcome: "denied",
          correlationId,
          metadata: { reason: "rate-limited", resetAt: rateLimit.resetAt },
        });
        const response = apiError(
          "authentication-rate-limited",
          "Sign-in could not be completed.",
          429,
          correlationId,
        );
        response.headers.set(
          "Retry-After",
          String(Math.max(1, Math.ceil((Date.parse(rateLimit.resetAt) - Date.now()) / 1_000))),
        );
        return response;
      }
      const username = String(formData.get("username") ?? "").slice(0, 256);
      const password = String(formData.get("password") ?? "").slice(0, 2_048);
      result = await runtime.authentication.signIn(username, password, correlationId);
    }

    const response = NextResponse.redirect(new URL(returnTo, redirectOrigin), 303);
    response.cookies.set(result.cookie.name, result.sessionToken, {
      httpOnly: result.cookie.httpOnly,
      secure: result.cookie.secure,
      sameSite: result.cookie.sameSite,
      path: result.cookie.path,
      maxAge: result.cookie.maxAgeSeconds,
    });
    for (const [key, value] of Object.entries(correlationHeaders(correlationId))) {
      response.headers.set(key, value);
    }
    logger.info({ userId: result.user.id, provider }, "Sign-in completed");
    return response;
  } catch (error) {
    if (error instanceof LocalOwnerAuthenticationError && appBaseUrl) {
      const deniedUrl = new URL("/sign-in", browserRedirectOrigin(request, appBaseUrl));
      deniedUrl.searchParams.set("error", "invalid-credentials");
      const response = NextResponse.redirect(deniedUrl, 303);
      response.headers.set("X-Correlation-ID", correlationId);
      return response;
    }
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Sign-in failed",
    );
    return apiException(error, 500, correlationId, false);
  }
}
