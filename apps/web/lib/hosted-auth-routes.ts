import "server-only";
import { withHostedSessionRuntime } from "./hosted-session-http";

import { NextResponse } from "next/server";
import {
  assertHostedOrigin,
  CplHostedAuthenticationError,
  CPL_HOSTED_OIDC_DIAGNOSTIC_CODES,
  CPL_HOSTED_CSRF_COOKIE,
  CPL_HOSTED_OAUTH_COOKIE,
  CPL_HOSTED_SESSION_COOKIE,
  hostedStepUpRequired,
  hostedTokenHash,
  hasLocalDevelopmentConfiguration,
  assertLocalDevelopmentRequest,
  CPL_LOCAL_SESSION_COOKIE,
  CPL_LOCAL_CSRF_COOKIE,
  signLocalSessionCookie,
  cplLocalPersona,
  CPL_LOCAL_PERSONAS,
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

type LocalEntryStage =
  | "request_guard"
  | "request_body"
  | "guarded_runtime"
  | "session_issuance"
  | "session_cookie"
  | "persona_read"
  | "entry_readiness";
/** Correlation is generated here, never taken from request headers. Log only a
 * closed stage/category: no error message, SQL, URL, body, session or identity. */
function localEntryFailure(
  error: unknown,
  correlationId: string,
  stage: LocalEntryStage,
): NextResponse {
  const known = error instanceof CplHostedAuthenticationError;
  const allowed = new Set([
    "CPL_INVALID_AUTH_REQUEST",
    "CPL_AUTH_REQUEST_TOO_LARGE",
    "CPL_LOCAL_DEVELOPMENT_REFUSED",
    "CPL_LOCAL_SCHEMA_EXPECTATION_MISSING",
    "CPL_LOCAL_DATABASE_UNAVAILABLE",
    "CPL_LOCAL_SCHEMA_NOT_READY",
    "CPL_LOCAL_SESSION_PREREQUISITES_UNAVAILABLE",
    "CPL_LOCAL_PERSONA_UNAVAILABLE",
    "CPL_AUTH_RATE_LIMITED",
    "CPL_HOSTED_AUTH_UNAVAILABLE",
    "CPL_SESSION_REQUIRED",
    "CPL_AUTHENTICATION_REQUIRED",
    "CPL_ORGANIZATION_ACCESS_DENIED",
  ]);
  const code = known && allowed.has(error.code) ? error.code : "CPL_HOSTED_AUTH_UNAVAILABLE";
  const safeCategory =
    error instanceof Error && error.message === "CPL_HOSTED_DATABASE_ROLE_REFUSED"
      ? "restricted_role_refused"
      : error &&
          typeof error === "object" &&
          "code" in error &&
          ["42P01", "42703"].includes(String(error.code))
        ? "schema_contract_missing"
        : code === "CPL_LOCAL_DEVELOPMENT_REFUSED"
          ? "local_boundary_or_persona_refused"
          : "entry_operation_failed";
  console.error(
    JSON.stringify({
      event: "cpl.local.entry.failure",
      correlationId,
      stage,
      code,
      category: safeCategory,
    }),
  );
  const response = secureResponse(
    NextResponse.json(
      { ok: false, code, correlationId },
      { status: known && allowed.has(error.code) ? error.status : 503 },
    ),
  );
  response.headers.set("X-CPL-Correlation-ID", correlationId);
  return response;
}

function sessionResponse(
  result: CplHostedSignInResult,
  response: NextResponse = NextResponse.json({ ok: true }),
) {
  const local = hasLocalDevelopmentConfiguration();
  const options = {
    secure: !local,
    path: "/",
    expires: new Date(result.session.expiresAt),
    priority: "high" as const,
  };
  response.cookies.set(
    local ? CPL_LOCAL_SESSION_COOKIE : CPL_HOSTED_SESSION_COOKIE,
    local ? signLocalSessionCookie(result.sessionToken) : result.sessionToken,
    {
      ...options,
      httpOnly: true,
      sameSite: "lax",
    },
  );
  response.cookies.set(local ? CPL_LOCAL_CSRF_COOKIE : CPL_HOSTED_CSRF_COOKIE, result.csrfToken, {
    ...options,
    httpOnly: false,
    sameSite: "strict",
  });
  return secureResponse(response);
}

function clearCookie(response: NextResponse, name: string, httpOnly = true) {
  const local = hasLocalDevelopmentConfiguration();
  if (local && name === CPL_HOSTED_SESSION_COOKIE) name = CPL_LOCAL_SESSION_COOKIE;
  if (local && name === CPL_HOSTED_CSRF_COOKIE) name = CPL_LOCAL_CSRF_COOKIE;
  response.cookies.set(name, "", {
    secure: !local,
    httpOnly,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

function requireHostedIdentityProvider() {
  if (hasLocalDevelopmentConfiguration())
    throw new CplHostedAuthenticationError("CPL_HOSTED_AUTH_UNAVAILABLE", 404);
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
    requireHostedIdentityProvider();
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
    requireHostedIdentityProvider();
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
    // A callback failure must be diagnosable without logging its URL, state,
    // authorization code, cookies, provider response, identity, or error stack.
    const callbackCodes = new Set([
      "CPL_AUTHENTICATION_REQUIRED",
      "CPL_OAUTH_CALLBACK_REJECTED",
      "CPL_OAUTH_STATE_REJECTED",
      "CPL_IDENTITY_ASSERTION_REJECTED",
      "CPL_OIDC_ASSERTION_REJECTED",
      "CPL_HOSTED_AUTH_NOT_CONFIGURED",
      "CPL_HOSTED_AUTH_UNAVAILABLE",
    ]);
    const known = error instanceof CplHostedAuthenticationError;
    console.warn(
      JSON.stringify({
        event: "cpl_google_callback_rejected",
        code: known && callbackCodes.has(error.code) ? error.code : "CPL_HOSTED_AUTH_UNAVAILABLE",
        diagnosticCode:
          known &&
          error.diagnosticCode &&
          CPL_HOSTED_OIDC_DIAGNOSTIC_CODES.includes(error.diagnosticCode)
            ? error.diagnosticCode
            : null,
      }),
    );
    const response = errorResponse(error);
    clearCookie(response, CPL_HOSTED_OAUTH_COOKIE);
    return response;
  }
}

export async function hostedSession(request: Request): Promise<NextResponse> {
  try {
    const local = hasLocalDevelopmentConfiguration();
    if (local) assertLocalDevelopmentRequest(request);
    const descriptor = local ? { authenticationMode: "local-development", synthetic: true } : {};
    if (!local && !hostedAuthConfigurationStatus().configured)
      return secureResponse(
        NextResponse.json(
          { authenticated: false, code: "CPL_HOSTED_AUTH_NOT_CONFIGURED" },
          { status: 503 },
        ),
      );
    const sessionToken = await hostedCookie(CPL_HOSTED_SESSION_COOKIE, request);
    if (!sessionToken)
      return secureResponse(NextResponse.json({ authenticated: false, ...descriptor }));
    return await withHostedSessionRuntime(
      async (runtime) => {
        const session = await runtime.auth.readSession(sessionToken);
        if (!session)
          return secureResponse(NextResponse.json({ authenticated: false, ...descriptor }));
        const csrfToken = await hostedCookie(CPL_HOSTED_CSRF_COOKIE, request);
        if (
          !csrfToken ||
          !/^[A-Za-z0-9_-]{43}$/u.test(csrfToken) ||
          hostedTokenHash(csrfToken) !== session.csrfTokenHash
        )
          return secureResponse(
            NextResponse.json({
              authenticated: false,
              code: "CPL_SESSION_COOKIES_INCOMPLETE",
              ...descriptor,
            }),
          );
        return secureResponse(
          NextResponse.json({
            authenticated: true,
            ...descriptor,
            ...(local
              ? {
                  localPersonaKey: CPL_LOCAL_PERSONAS.find(
                    (persona) =>
                      persona.subject === session.subject && persona.email === session.email,
                  )?.key,
                }
              : {}),
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
      },
      { request },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function hostedRenew(request: Request): Promise<NextResponse> {
  try {
    return await withHostedRuntime(
      async (runtime) => {
        const { sessionToken } = await requireHostedMutation(runtime, request);
        return sessionResponse(await runtime.auth.renew(sessionToken));
      },
      { request },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function hostedLogout(request: Request): Promise<NextResponse> {
  try {
    return await withHostedRuntime(
      async (runtime) => {
        const { sessionToken } = await requireHostedMutation(runtime, request);
        await runtime.auth.signOut(sessionToken);
        const response = secureResponse(NextResponse.json({ ok: true }));
        clearCookie(response, CPL_HOSTED_SESSION_COOKIE);
        clearCookie(response, CPL_HOSTED_CSRF_COOKIE, false);
        clearCookie(response, CPL_HOSTED_OAUTH_COOKIE);
        return response;
      },
      { request },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function hostedPasskeyOptions(
  request: Request,
  kind: "registration" | "authentication",
): Promise<NextResponse> {
  try {
    requireHostedIdentityProvider();
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
    requireHostedIdentityProvider();
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

export async function localDevelopmentStatus(request: Request): Promise<NextResponse> {
  if (!hasLocalDevelopmentConfiguration())
    return secureResponse(NextResponse.json({ ok: false }, { status: 404 }));
  const correlationId = crypto.randomUUID();
  let stage: LocalEntryStage = "request_guard";
  try {
    assertLocalDevelopmentRequest(request);
    stage = "guarded_runtime";
    return await withHostedRuntime(
      async (runtime) => {
        const { localDevelopmentEntryReadiness } = await import("./local-development-auth");
        stage = "entry_readiness";
        await localDevelopmentEntryReadiness(runtime);
        return secureResponse(NextResponse.json({ development: true, ready: true }));
      },
      { request },
    );
  } catch (error) {
    return localEntryFailure(error, correlationId, stage);
  }
}

export async function localDevelopmentSignIn(request: Request): Promise<NextResponse> {
  if (!hasLocalDevelopmentConfiguration())
    return secureResponse(NextResponse.json({ ok: false }, { status: 404 }));
  const correlationId = crypto.randomUUID();
  let stage: LocalEntryStage = "request_guard";
  try {
    assertLocalDevelopmentRequest(request);
    stage = "request_body";
    const body = await boundedJson(request);
    if (Object.keys(body).some((key) => key !== "personaKey"))
      throw new CplHostedAuthenticationError("CPL_INVALID_AUTH_REQUEST", 400);
    const persona = cplLocalPersona(
      body.personaKey === undefined ? "legacy-owner" : body.personaKey,
    );
    if (!persona) throw new CplHostedAuthenticationError("CPL_INVALID_AUTH_REQUEST", 400);
    stage = "guarded_runtime";
    return await withHostedRuntime(
      async (runtime) => {
        const { issueLocalDevelopmentSession, localDevelopmentEntryReadiness } =
          await import("./local-development-auth");
        stage = "entry_readiness";
        await localDevelopmentEntryReadiness(runtime, persona.key);
        const previous = await hostedCookie(CPL_HOSTED_SESSION_COOKIE, request);
        stage = "session_issuance";
        const result = await issueLocalDevelopmentSession(runtime, request, previous, persona.key);
        stage = "session_cookie";
        return sessionResponse(
          result,
          NextResponse.json({ ok: true, authenticationMode: "local-development", synthetic: true }),
        );
      },
      { request },
    );
  } catch (error) {
    return localEntryFailure(error, correlationId, stage);
  }
}

export async function localDevelopmentConfig(request: Request): Promise<NextResponse> {
  if (!hasLocalDevelopmentConfiguration())
    return secureResponse(NextResponse.json({ ok: false }, { status: 404 }));
  const correlationId = crypto.randomUUID();
  let stage: LocalEntryStage = "request_guard";
  try {
    assertLocalDevelopmentRequest(request);
    stage = "guarded_runtime";
    return await withHostedRuntime(
      async (runtime) => {
        const { listLocalDevelopmentPersonas } = await import("./local-development-auth");
        stage = "persona_read";
        return secureResponse(
          NextResponse.json({
            authenticationMode: "local-development",
            synthetic: true,
            personas: await listLocalDevelopmentPersonas(runtime),
          }),
        );
      },
      { request },
    );
  } catch (error) {
    return localEntryFailure(error, correlationId, stage);
  }
}
