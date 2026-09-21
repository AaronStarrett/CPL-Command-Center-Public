import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CplHostedRuntime } from "../../apps/web/lib/hosted-auth";
import {
  CplHostedAuthService,
  CPL_HOSTED_SESSION_COOKIE,
  CPL_HOSTED_CSRF_COOKIE,
  CPL_HOSTED_OAUTH_COOKIE,
} from "../../packages/security/src/hosted-authentication";
import { HostedAuthMemoryStore } from "../fixtures/hosted-auth-memory-store";

const state = vi.hoisted(() => ({
  runtime: null as CplHostedRuntime | null,
  configured: true,
  failure: null as Error | null,
}));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("../../apps/web/lib/hosted-auth", async (original) => ({
  ...(await original<typeof import("../../apps/web/lib/hosted-auth")>()),
  hostedAuthConfigurationStatus: () => ({
    enabled: true,
    configured: state.configured,
    missing: [],
  }),
  withHostedRuntime: async (operation: (runtime: CplHostedRuntime) => Promise<unknown>) => {
    if (state.failure) throw state.failure;
    return operation(state.runtime!);
  },
}));
import {
  hostedGoogleStart,
  hostedGoogleCallback,
  hostedSession,
  hostedRenew,
  hostedLogout,
  hostedPasskeyOptions,
  hostedPasskeyVerify,
} from "../../apps/web/lib/hosted-auth-routes";

const origin = "https://command.example.test";
let store: HostedAuthMemoryStore;
let auth: CplHostedAuthService;
let session: Awaited<ReturnType<CplHostedAuthService["finishSignIn"]>>;
let exchange: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  const now = new Date();
  store = new HostedAuthMemoryStore();
  exchange = vi.fn(async () => ({
    issuer: "https://accounts.google.com" as const,
    subject: "synthetic-subject",
    email: "owner@example.test",
    emailVerified: true as const,
    hostedDomain: "example.test",
    displayName: "Synthetic Owner",
    authenticatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
  }));
  auth = new CplHostedAuthService(
    store,
    {
      authorizationUrl: ({ state: value }) => `https://accounts.google.com/?state=${value}`,
      exchangeCode: exchange,
    },
    { appOrigin: origin },
  );
  state.runtime = { auth, origin } as CplHostedRuntime;
  state.failure = null;
  state.configured = true;
  const begin = await auth.beginSignIn();
  session = await auth.finishSignIn({
    browserBinding: begin.browserBinding,
    state: new URL(begin.authorizationUrl).searchParams.get("state")!,
    code: "synthetic-code",
  });
});

function request(path: string, method = "POST", body?: string, extra: Record<string, string> = {}) {
  return new Request(`${origin}${path}`, {
    method,
    headers: {
      origin,
      "sec-fetch-site": "same-origin",
      "x-cpl-csrf": session.csrfToken,
      cookie: `${CPL_HOSTED_SESSION_COOKIE}=${session.sessionToken}; ${CPL_HOSTED_CSRF_COOKIE}=${session.csrfToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...extra,
    },
    ...(body === undefined ? {} : { body }),
  });
}

describe("Hosted authentication HTTP boundaries", () => {
  it("sets secure host cookies and private responses for the bound OAuth callback", async () => {
    const begin = await hostedGoogleStart(request("/api/auth/google/start"));
    expect(begin.status).toBe(303);
    const binding = begin.cookies.get(CPL_HOSTED_OAUTH_COOKIE)!;
    expect(binding).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 300,
    });
    const oauthState = new URL(begin.headers.get("location")!).searchParams.get("state")!;
    const result = await hostedGoogleCallback(
      request(
        `/api/auth/google/callback?state=${oauthState}&code=synthetic-code`,
        "GET",
        undefined,
        { cookie: `${CPL_HOSTED_OAUTH_COOKIE}=${binding.value}` },
      ),
    );
    expect(result.status).toBe(303);
    expect(result.headers.get("location")).toBe(`${origin}/workspace`);
    expect(result.headers.get("cache-control")).toBe("no-store, private");
    expect(result.headers.get("referrer-policy")).toBe("no-referrer");
    expect(result.cookies.get(CPL_HOSTED_SESSION_COOKIE)).toMatchObject({
      httpOnly: true,
      secure: true,
      path: "/",
      sameSite: "lax",
    });
    expect(result.cookies.get(CPL_HOSTED_CSRF_COOKIE)).toMatchObject({
      httpOnly: false,
      secure: true,
      path: "/",
      sameSite: "strict",
    });
    expect(result.cookies.get(CPL_HOSTED_OAUTH_COOKIE)?.maxAge).toBe(0);
  });

  it("rejects cross-site sign-in initiation and duplicate callback parameters before exchange", async () => {
    expect(
      (
        await hostedGoogleStart(
          request("/api/auth/google/start", "POST", undefined, {
            origin: "https://attacker.example.test",
          }),
        )
      ).status,
    ).toBe(403);
    const result = await hostedGoogleCallback(
      request("/api/auth/google/callback?state=a&state=b&code=c", "GET"),
    );
    expect(result.status).toBe(401);
    expect(result.cookies.get(CPL_HOSTED_OAUTH_COOKIE)?.maxAge).toBe(0);
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it("reports missing configuration safely without treating it as signed-in", async () => {
    state.configured = false;
    const result = await hostedSession(request("/api/auth/session", "GET"));
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({
      authenticated: false,
      code: "CPL_HOSTED_AUTH_NOT_CONFIGURED",
    });
  });

  it("returns only the agreed safe identity/session view and rejects incomplete cookie pairs", async () => {
    const result = await hostedSession(request("/api/auth/session", "GET"));
    expect(await result.json()).toEqual({
      authenticated: true,
      identity: {
        id: session.session.identityId,
        displayName: "Synthetic Owner",
        email: "owner@example.test",
      },
      session: {
        expiresAt: session.session.expiresAt,
        currentOrganizationId: null,
        stepUpRequired: true,
        hasPasskey: false,
      },
      csrfToken: session.csrfToken,
    });
    const incomplete = await hostedSession(
      request("/api/auth/session", "GET", undefined, {
        cookie: `${CPL_HOSTED_SESSION_COOKIE}=${session.sessionToken}`,
      }),
    );
    expect(await incomplete.json()).toMatchObject({ authenticated: false });
    const anonymous = await hostedSession(
      request("/api/auth/session", "GET", undefined, { cookie: "" }),
    );
    expect(await anonymous.json()).toEqual({ authenticated: false });
  });

  it("requires CSRF before issuing passkey options or logging out", async () => {
    const invalid = request("/api/auth/passkeys/register/options", "POST", undefined, {
      "x-cpl-csrf": "",
    });
    expect((await hostedPasskeyOptions(invalid, "registration")).status).toBe(403);
    expect(
      (await hostedLogout(request("/api/auth/logout", "POST", undefined, { "x-cpl-csrf": "" })))
        .status,
    ).toBe(403);
    expect(await auth.readSession(session.sessionToken)).not.toBeNull();
    const options = await hostedPasskeyOptions(
      request("/api/auth/passkeys/register/options"),
      "registration",
    );
    expect(options.status).toBe(200);
    expect(await options.json()).toMatchObject({
      ceremonyToken: expect.any(String),
      options: { authenticatorSelection: { userVerification: "required" } },
    });
  });

  it.each([
    ["oversized", JSON.stringify({ response: "x".repeat(33_000) }), "application/json", 413],
    ["invalid JSON", "{", "application/json", 400],
    ["array", "[]", "application/json", 400],
    [
      "unknown field",
      JSON.stringify({ ceremonyToken: "x".repeat(43), response: { id: "synthetic" }, admin: true }),
      "application/json",
      400,
    ],
    ["wrong content type", "{}", "application/json-malicious", 415],
  ] as const)("bounds the %s verification request", async (_name, body, contentType, expected) => {
    const response = await hostedPasskeyVerify(
      request("/api/auth/passkeys/register/verify", "POST", body, { "content-type": contentType }),
      "registration",
    );
    expect(response.status).toBe(expected);
    expect(await auth.hasPasskey(session.sessionToken)).toBe(false);
  });

  it("renews by rotating both cookies and revokes server-side state on logout", async () => {
    const renewed = await hostedRenew(request("/api/auth/renew"));
    expect(renewed.status).toBe(200);
    const token = renewed.cookies.get(CPL_HOSTED_SESSION_COOKIE)!.value;
    const csrf = renewed.cookies.get(CPL_HOSTED_CSRF_COOKIE)!.value;
    expect(await auth.readSession(session.sessionToken)).toBeNull();
    expect(await auth.readSession(token)).not.toBeNull();
    const loggedOut = await hostedLogout(
      request("/api/auth/logout", "POST", undefined, {
        cookie: `${CPL_HOSTED_SESSION_COOKIE}=${token}; ${CPL_HOSTED_CSRF_COOKIE}=${csrf}`,
        "x-cpl-csrf": csrf,
      }),
    );
    expect(loggedOut.status).toBe(200);
    expect(loggedOut.cookies.get(CPL_HOSTED_SESSION_COOKIE)?.maxAge).toBe(0);
    expect(loggedOut.cookies.get(CPL_HOSTED_CSRF_COOKIE)?.maxAge).toBe(0);
    expect(await auth.readSession(token)).toBeNull();
  });

  it("redacts unexpected database/provider failures", async () => {
    state.failure = new Error("synthetic-sensitive-connection-string");
    const response = await hostedSession(request("/api/auth/session", "GET"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, code: "CPL_HOSTED_AUTH_UNAVAILABLE" });
  });
});
