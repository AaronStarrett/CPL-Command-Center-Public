import { getServerRuntime } from "@bea/database";
import { AuthenticationUnavailableError } from "@bea/security";
import { NextRequest, NextResponse } from "next/server";

import { correlationHeaders, requestCorrelationId, webRouteLogger } from "@/app/api/route-helpers";
import { getDemoPersona } from "@/lib/auth/personas";
import { DEMO_SESSION_COOKIE } from "@/lib/auth/session-store";
import { apiError, apiException } from "@/lib/api-response";
import {
  browserRedirectOrigin,
  isSameOriginRequest,
  isStrictSameOriginMutation,
} from "@/lib/request-security";
import { safeReturnPath } from "@/lib/safe-return-path";

export async function POST(request: NextRequest) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/auth/switch-persona", "POST");
  let appBaseUrl: string | undefined;

  try {
    const runtime = await getServerRuntime();
    appBaseUrl = runtime.environment.appBaseUrl;
    const originAllowed =
      runtime.authentication.kind === "local-owner"
        ? isStrictSameOriginMutation(request, appBaseUrl)
        : isSameOriginRequest(request, appBaseUrl);
    if (!originAllowed) {
      await runtime.repository.record({
        eventType: "authentication.persona-switch-denied",
        action: "demo.switch-persona",
        outcome: "denied",
        correlationId,
        metadata: { reason: "cross-origin-request" },
      });
      logger.warn({}, "Cross-origin persona switch rejected");
      return apiError(
        "cross-origin-request-rejected",
        "Cross-origin persona switch was rejected.",
        403,
        correlationId,
      );
    }
    if (runtime.authentication.kind !== "demo" || !runtime.environment.demoAuthEnabled) {
      await runtime.repository.record({
        eventType: "authentication.persona-switch-denied",
        action: "authentication.switch-persona",
        outcome: "denied",
        correlationId,
        metadata: { reason: "provider-does-not-support-personas" },
      });
      return apiError(
        "persona-switch-unavailable",
        "Persona switching is unavailable for this authentication provider.",
        404,
        correlationId,
      );
    }

    const formData = await request.formData();
    const redirectOrigin = browserRedirectOrigin(request, appBaseUrl);
    const personaId = String(formData.get("personaId") ?? "");
    const returnTo = safeReturnPath(formData.get("returnTo"), "/account", redirectOrigin);
    const currentToken = request.cookies.get(DEMO_SESSION_COOKIE)?.value;
    const persona = getDemoPersona(personaId);

    if (!currentToken || !persona) {
      await runtime.repository.record({
        eventType: "authentication.persona-switch-denied",
        action: "demo.switch-persona",
        outcome: "denied",
        correlationId,
        metadata: { reason: currentToken ? "invalid-persona-id" : "missing-session" },
      });
      const response = NextResponse.redirect(
        new URL("/sign-in?reason=expired", redirectOrigin),
        303,
      );
      response.cookies.delete(DEMO_SESSION_COOKIE);
      response.headers.set("X-Correlation-ID", correlationId);
      return response;
    }

    const result = await runtime.authentication.switchPersona(
      currentToken,
      persona.key,
      correlationId,
    );
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
    logger.info({ userId: result.user.id }, "Demo persona switch completed");
    return response;
  } catch (error) {
    if (error instanceof AuthenticationUnavailableError && appBaseUrl) {
      logger.warn({}, "Demo persona switch denied for invalid or expired session");
      const response = NextResponse.redirect(
        new URL("/sign-in?reason=expired", browserRedirectOrigin(request, appBaseUrl)),
        303,
      );
      response.cookies.delete(DEMO_SESSION_COOKIE);
      response.headers.set("X-Correlation-ID", correlationId);
      return response;
    }
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Demo persona switch failed",
    );
    return apiException(error, 500, correlationId, false);
  }
}
