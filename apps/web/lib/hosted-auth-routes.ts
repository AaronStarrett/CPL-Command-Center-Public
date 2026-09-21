import "server-only";

import { NextResponse } from "next/server";
import {
  assertHostedOrigin,
  CplHostedAuthenticationError,
  CPL_HOSTED_CSRF_COOKIE,
  CPL_HOSTED_OAUTH_COOKIE,
  CPL_HOSTED_SESSION_COOKIE,
  hostedStepUpRequired,
  hostedTokenHash,
  type CplHostedSignInResult,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@bea/security/hosted";
import {
  hostedAuthConfigurationStatus,
  hostedCookie,
  requireHostedMutation,
  withHostedRuntime,
} from "./hosted-auth";

function secureResponse(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store, private");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}

function errorResponse(error: unknown): NextResponse {
  const known = error instanceof CplHostedAuthenticationError;
  return secureResponse(
    NextResponse.json(
      { ok: false, code: known ? error.code : "CPL_HOSTED_AUTH_UNAVAILABLE" },
      { status: known ? error.status : 503 },
    ),
  );
}

function sessionResponse(
  result: CplHostedSignInResult,
  response: NextResponse = NextResponse.json({ ok: true }),
) {
  const options = {
    secure: true,
    path: "/",
    expires: new Date(result.session.expiresAt),
    priority: "high" as const,
  };
  response.cookies.set(CPL_HOSTED_SESSION_COOKIE, result.sessionToken, {
    ...options,
    httpOnly: true,
    sameSite: "lax",
  });
  response.cookies.set(CPL_HOSTED_CSRF_COOKIE, result.csrfToken, {
    ...options,
    httpOnly: false,
    sameSite: "strict",
  });
  return secureResponse(response);
}

function clearCookie(response: NextResponse, name: string, httpOnly = true) {
  response.cookies.set(name, "", { secure: true, httpOnly, sameSite: "lax", path: "/", maxAge: 0 });
}

async function boundedJson(request: Request): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|\s*$)/iu.test(request.headers.get("content-type") ?? ""))
    throw new CplHostedAuthenticationError("CPL_INVALID_AUTH_REQUEST", 415);
  if (!request.body) throw new CplHostedAuthenticationError("CPL_INVALID_AUTH_REQUEST", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    length += item.value.byteLength;
    if (length > 32_768) {
      await reader.cancel();
      throw new CplHostedAuthenticationError("CPL_AUTH_REQUEST_TOO_LARGE", 413);
    }
    chunks.push(item.value);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid body");
    return value as Record<string, unknown>;
  } catch {
    throw new CplHostedAuthenticationError("CPL_INVALID_AUTH_REQUEST", 400);
  }
}

export async function hostedGoogleStart(request: Request): Promise<NextResponse> {
  try {
    return await withHostedRuntime(async (runtime) => {
      assertHostedOrigin(request, runtime.origin);
      const result = await runtime.auth.beginSignIn();
      const response = NextResponse.redirect(result.authorizationUrl, 303);
      response.cookies.set(CPL_HOSTED_OAUTH_COOKIE, result.browserBinding, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
        maxAge: 300,
      });
      return secureResponse(response);
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function hostedGoogleCallback(request: Request): Promise<NextResponse> {
  try {
    return await withHostedRuntime(async (runtime) => {
      const url = new URL(request.url);
      const state = url.searchParams.getAll("state");
      const codes = url.searchParams.getAll("code");
      if (state.length !== 1 || codes.length !== 1 || url.searchParams.has("error"))
        throw new CplHostedAuthenticationError("CPL_OAUTH_CALLBACK_REJECTED");
      const prior = await hostedCookie(CPL_HOSTED_SESSION_COOKIE, request);
      const result = await runtime.auth.finishSignIn({
        browserBinding: (await hostedCookie(CPL_HOSTED_OAUTH_COOKIE, request)) ?? "",
        state: state[0]!,
        code: codes[0]!,
        ...(prior ? { previousSessionToken: prior } : {}),
      });
      const response = sessionResponse(
        result,
        NextResponse.redirect(new URL(result.returnTo, runtime.origin), 303),
      );
      clearCookie(response, CPL_HOSTED_OAUTH_COOKIE);
      return response;
    });
  } catch (error) {
    const response = errorResponse(error);
    clearCookie(response, CPL_HOSTED_OAUTH_COOKIE);
    return response;
  }
}

export async function hostedSession(request: Request): Promise<NextResponse> {
  const status = hostedAuthConfigurationStatus();
  if (!status.configured)
    return secureResponse(
      NextResponse.json(
        { authenticated: false, code: "CPL_HOSTED_AUTH_NOT_CONFIGURED" },
        { status: 503 },
      ),
    );
  const sessionToken = await hostedCookie(CPL_HOSTED_SESSION_COOKIE, request);
  if (!sessionToken) return secureResponse(NextResponse.json({ authenticated: false }));
  try {
    return await withHostedRuntime(async (runtime) => {
      const session = await runtime.auth.readSession(sessionToken);
      if (!session) return secureResponse(NextResponse.json({ authenticated: false }));
      const csrfToken = await hostedCookie(CPL_HOSTED_CSRF_COOKIE, request);
      if (
        !csrfToken ||
        !/^[A-Za-z0-9_-]{43}$/u.test(csrfToken) ||
        hostedTokenHash(csrfToken) !== session.csrfTokenHash
      )
        return secureResponse(
          NextResponse.json({ authenticated: false, code: "CPL_SESSION_COOKIES_INCOMPLETE" }),
        );
      return secureResponse(
        NextResponse.json({
          authenticated: true,
          identity: {
            id: session.identityId,
            displayName: session.displayName,
            email: session.email,
          },
          session: {
            expiresAt: session.expiresAt,
            currentOrganizationId: session.selectedOrganizationId,
            stepUpRequired: hostedStepUpRequired(session),
            hasPasskey: await runtime.auth.hasPasskey(sessionToken),
          },
          csrfToken,
        }),
      );
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function hostedRenew(request: Request): Promise<NextResponse> {
  try {
    return await withHostedRuntime(async (runtime) => {
      const { sessionToken } = await requireHostedMutation(runtime, request);
      return sessionResponse(await runtime.auth.renew(sessionToken));
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function hostedLogout(request: Request): Promise<NextResponse> {
  try {
    return await withHostedRuntime(async (runtime) => {
      const { sessionToken } = await requireHostedMutation(runtime, request);
      await runtime.auth.signOut(sessionToken);
      const response = secureResponse(NextResponse.json({ ok: true }));
      clearCookie(response, CPL_HOSTED_SESSION_COOKIE);
      clearCookie(response, CPL_HOSTED_CSRF_COOKIE, false);
      clearCookie(response, CPL_HOSTED_OAUTH_COOKIE);
      return response;
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function hostedPasskeyOptions(
  request: Request,
  kind: "registration" | "authentication",
): Promise<NextResponse> {
  try {
    return await withHostedRuntime(async (runtime) => {
      const { sessionToken } = await requireHostedMutation(runtime, request);
      const options =
        kind === "registration"
          ? await runtime.auth.registrationOptions(sessionToken)
          : await runtime.auth.authenticationOptions(sessionToken);
      return secureResponse(NextResponse.json(options));
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function hostedPasskeyVerify(
  request: Request,
  kind: "registration" | "authentication",
): Promise<NextResponse> {
  try {
    return await withHostedRuntime(async (runtime) => {
      const { sessionToken } = await requireHostedMutation(runtime, request);
      const body = await boundedJson(request);
      if (
        Object.keys(body).some((key) => !["ceremonyToken", "response"].includes(key)) ||
        typeof body.ceremonyToken !== "string" ||
        !body.response ||
        typeof body.response !== "object" ||
        Array.isArray(body.response) ||
        !("id" in body.response) ||
        typeof body.response.id !== "string"
      )
        throw new CplHostedAuthenticationError("CPL_INVALID_AUTH_REQUEST", 400);
      const result =
        kind === "registration"
          ? await runtime.auth.verifyRegistration(
              sessionToken,
              body.ceremonyToken,
              body.response as RegistrationResponseJSON,
            )
          : await runtime.auth.verifyAuthentication(
              sessionToken,
              body.ceremonyToken,
              body.response as AuthenticationResponseJSON,
            );
      return sessionResponse(result);
    });
  } catch (error) {
    return errorResponse(error);
  }
}
