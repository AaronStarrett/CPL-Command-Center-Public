import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CplHostedRuntime } from "../../apps/web/lib/hosted-auth";
import { HostedAuthMemoryStore } from "../fixtures/hosted-auth-memory-store";
import { CplHostedAuthService } from "../../packages/security/src/hosted-authentication";
import { hostedTokenHash } from "../../packages/security/src/google-oidc";
import {
  signLocalSessionCookie,
  verifyLocalSessionCookie,
} from "../../packages/security/src/local-development-auth";
const state = vi.hoisted(() => ({
  runtime: null as CplHostedRuntime | null,
  issue: vi.fn(),
  runtimeCalls: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("../../apps/web/lib/hosted-auth", async (original) => ({
  ...(await original<typeof import("../../apps/web/lib/hosted-auth")>()),
  withHostedRuntime: async (operation: (runtime: CplHostedRuntime) => Promise<unknown>) => {
    state.runtimeCalls();
    return operation(state.runtime!);
  },
}));
vi.mock("../../apps/web/lib/local-development-auth", () => ({
  issueLocalDevelopmentSession: state.issue,
}));
import {
  hostedSession,
  hostedRenew,
  hostedLogout,
  hostedGoogleStart,
  hostedPasskeyOptions,
  localDevelopmentSignIn,
  localDevelopmentStatus,
} from "../../apps/web/lib/hosted-auth-routes";
const origin = "http://127.0.0.1:3400",
  token = "b".repeat(43),
  csrf = "c".repeat(43);
let store: HostedAuthMemoryStore;
beforeEach(() => {
  vi.clearAllMocks();
  for (const name of [
    "DATABASE_URL",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "CPL_HOSTED_ENABLED",
    "CPL_HOSTED_BUILD",
    "CPL_DATABASE_TRANSPORT",
    "CPL_SESSION_READ_TRANSPORT",
  ])
    vi.stubEnv(name, undefined);
  for (const [name, value] of Object.entries({
    NODE_ENV: "test",
    CPL_LOCAL_DEVELOPMENT_AUTH: "true",
    APP_BASE_URL: origin,
    CPL_LOCAL_DATABASE_URL:
      "postgresql://cpl_local_web:synthetic@127.0.0.1:55433/cpl_local_development",
    CPL_LOCAL_SESSION_SECRET: "a".repeat(43),
  }))
    vi.stubEnv(name, value);
  store = new HostedAuthMemoryStore();
  const now = new Date().toISOString();
  const session = {
    id: "synthetic-session",
    identityId: "synthetic-owner",
    issuer: "https://local.cpl.invalid",
    subject: "local-owner",
    email: "local-owner@cpl.invalid",
    displayName: "Local development owner",
    createdAt: now,
    authenticatedAt: now,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    absoluteExpiresAt: new Date(Date.now() + 8 * 3600000).toISOString(),
    mfaVerifiedAt: now,
    selectedOrganizationId: null,
    csrfTokenHash: hostedTokenHash(csrf),
    platformAdministrator: true,
  };
  store.sessions.set(hostedTokenHash(token), session);
  const auth = new CplHostedAuthService(
    store,
    {
      authorizationUrl: () => {
        throw new Error("Google must not run");
      },
      exchangeCode: async () => {
        throw new Error("Google must not run");
      },
    },
    { appOrigin: origin, localDevelopment: true },
  );
  state.runtime = { auth, origin } as CplHostedRuntime;
  state.issue.mockResolvedValue({ sessionToken: token, csrfToken: csrf, session });
});
afterEach(() => vi.unstubAllEnvs());
function request(
  path: string,
  method = "GET",
  body?: string,
  headers: Record<string, string> = {},
) {
  return new Request(origin + path, {
    method,
    headers: {
      host: "127.0.0.1:3400",
      origin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      "x-cpl-csrf": csrf,
      cookie: `cpl_local_session=${signLocalSessionCookie(token)}; cpl_local_csrf=${csrf}`,
      ...headers,
    },
    ...(body === undefined ? {} : { body }),
  });
}
describe("local development HTTP contract", () => {
  it("returns a local descriptor while anonymous without claiming authentication", async () => {
    const response = await hostedSession(
      request("/api/auth/session", "GET", undefined, { cookie: "" }),
    );
    expect(await response.json()).toEqual({
      authenticated: false,
      authenticationMode: "local-development",
      synthetic: true,
    });
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(state.runtimeCalls).not.toHaveBeenCalled();
  });
  it("reports truthful passkey state with signed real session identity", async () => {
    expect(await (await hostedSession(request("/api/auth/session"))).json()).toMatchObject({
      authenticated: true,
      synthetic: true,
      session: { hasPasskey: false, stepUpRequired: false },
    });
  });
  it("tampered local signatures never reach session persistence", async () => {
    const response = await hostedSession(
      request("/api/auth/session", "GET", undefined, {
        cookie: `cpl_local_session=${token}; cpl_local_csrf=${csrf}`,
      }),
    );
    expect(await response.json()).toMatchObject({ authenticated: false });
    expect(state.runtimeCalls).not.toHaveBeenCalled();
  });
  it("issues signed HttpOnly local cookie and separate strict CSRF, no hosted cookie", async () => {
    const response = await localDevelopmentSignIn(request("/api/auth/local/sign-in", "POST", "{}"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      authenticationMode: "local-development",
      synthetic: true,
    });
    expect(response.cookies.get("cpl_local_session")).toMatchObject({
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      path: "/",
    });
    expect(verifyLocalSessionCookie(response.cookies.get("cpl_local_session")?.value)).toBe(token);
    expect(response.cookies.get("cpl_local_csrf")).toMatchObject({
      httpOnly: false,
      sameSite: "strict",
    });
    expect(response.cookies.get("__Host-cpl-session")).toBeUndefined();
  });
  it.each(['{"role":"owner"}', '{"identityId":"arbitrary"}', "[]", "null"])(
    "rejects browser-selected fixture claims %s",
    async (body) => {
      expect(
        (await localDevelopmentSignIn(request("/api/auth/local/sign-in", "POST", body))).status,
      ).toBe(400);
      expect(state.issue).not.toHaveBeenCalled();
    },
  );
  it("refuses cross-origin sign-in before runtime or issuance", async () => {
    expect(
      (
        await localDevelopmentSignIn(
          request("/api/auth/local/sign-in", "POST", "{}", { origin: "https://evil.invalid" }),
        )
      ).status,
    ).toBe(503);
    expect(state.runtimeCalls).not.toHaveBeenCalled();
  });
  it("readiness enters guarded runtime before declaring ready", async () => {
    expect(await (await localDevelopmentStatus(request("/api/auth/local/status"))).json()).toEqual({
      development: true,
      ready: true,
    });
    expect(state.runtimeCalls).toHaveBeenCalledOnce();
  });
  it("local routes are unavailable without local flags", async () => {
    const input = request("/api/auth/local/status");
    for (const name of [
      "CPL_LOCAL_DEVELOPMENT_AUTH",
      "CPL_LOCAL_DATABASE_URL",
      "CPL_LOCAL_SESSION_SECRET",
    ])
      vi.stubEnv(name, undefined);
    expect((await localDevelopmentStatus(input)).status).toBe(404);
    expect((await localDevelopmentSignIn(input)).status).toBe(404);
    expect(state.runtimeCalls).not.toHaveBeenCalled();
  });
  it("retains CSRF for renewal/logout and revokes the real session on logout", async () => {
    expect(
      (
        await hostedLogout(
          request("/api/auth/logout", "POST", undefined, { "x-cpl-csrf": "wrong" }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await hostedRenew(request("/api/auth/renew", "POST", undefined, { "x-cpl-csrf": "wrong" })))
        .status,
    ).toBe(403);
    expect(store.sessions.size).toBe(1);
    const response = await hostedLogout(request("/api/auth/logout", "POST"));
    expect(response.status).toBe(200);
    expect(store.sessions.size).toBe(0);
    expect(response.cookies.get("cpl_local_session")?.maxAge).toBe(0);
  });
  it("does not call Google or fake a passkey ceremony in local mode", async () => {
    expect((await hostedGoogleStart(request("/api/auth/google/start", "POST"))).status).toBe(404);
    expect(
      (
        await hostedPasskeyOptions(
          request("/api/auth/passkeys/register/options", "POST"),
          "registration",
        )
      ).status,
    ).toBe(404);
    expect(state.runtimeCalls).not.toHaveBeenCalled();
  });
});
