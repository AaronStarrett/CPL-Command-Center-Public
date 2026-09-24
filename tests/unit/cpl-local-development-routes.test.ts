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
  personas: vi.fn(),
  readiness: vi.fn(),
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
  listLocalDevelopmentPersonas: state.personas,
  localDevelopmentEntryReadiness: state.readiness,
}));
import {
  hostedSession,
  hostedRenew,
  hostedLogout,
  hostedGoogleStart,
  hostedPasskeyOptions,
  localDevelopmentSignIn,
  localDevelopmentStatus,
  localDevelopmentConfig,
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
    mfaVerifiedAt: null,
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
  state.personas.mockResolvedValue([{ key: "legacy-owner", label: "Existing development owner" }]);
  state.readiness.mockResolvedValue({
    ready: true,
    code: "CPL_LOCAL_ENTRY_READY",
    schemaHead: "synthetic",
    personaKeys: ["legacy-owner"],
  });
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
  it("refuses readiness without setting session cookies when schema prerequisites fail", async () => {
    const { CplHostedAuthenticationError } = await import("@bea/security/hosted");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      state.readiness.mockRejectedValueOnce(
        new CplHostedAuthenticationError("CPL_LOCAL_SCHEMA_NOT_READY", 503),
      );
      const response = await localDevelopmentStatus(request("/api/auth/local/status"));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "CPL_LOCAL_SCHEMA_NOT_READY" });
      expect(response.headers.has("set-cookie")).toBe(false);
      expect(state.issue).not.toHaveBeenCalled();
      expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ stage: "entry_readiness" });
    } finally {
      log.mockRestore();
    }
  });
  it("checks the selected persona before issuing an actual session and retains existing cookies on refusal", async () => {
    const { CplHostedAuthenticationError } = await import("@bea/security/hosted");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      state.readiness.mockRejectedValueOnce(
        new CplHostedAuthenticationError("CPL_LOCAL_PERSONA_UNAVAILABLE", 503),
      );
      const response = await localDevelopmentSignIn(
        request("/api/auth/local/sign-in", "POST", JSON.stringify({ personaKey: "owner-alpha" })),
      );
      expect(state.readiness).toHaveBeenCalledWith(state.runtime, "owner-alpha");
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "CPL_LOCAL_PERSONA_UNAVAILABLE" });
      expect(response.headers.has("set-cookie")).toBe(false);
      expect(state.issue).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
  it("retains the oversized-request refusal without issuing a session or logging the body", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await localDevelopmentSignIn(
        request(
          "/api/auth/local/sign-in",
          "POST",
          JSON.stringify({ personaKey: "BODY_CANARY".repeat(4000) }),
        ),
      );
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ code: "CPL_AUTH_REQUEST_TOO_LARGE" });
      expect(state.runtimeCalls).not.toHaveBeenCalled();
      expect(state.issue).not.toHaveBeenCalled();
      expect(JSON.stringify(log.mock.calls)).not.toContain("BODY_CANARY");
    } finally {
      log.mockRestore();
    }
  });
  it("correlates a session failure without logging private exception data or accepting a caller reference", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      state.issue.mockRejectedValueOnce(
        new Error("postgresql://PRIVATE_PASSWORD@private.invalid/SESSION_CANARY"),
      );
      const response = await localDevelopmentSignIn(
        request("/api/auth/local/sign-in", "POST", "{}", {
          "x-cpl-correlation-id": "CALLER_SUPPLIED_CANARY",
        }),
      );
      const body = await response.json();
      expect(response.status).toBe(503);
      expect(Object.keys(body).sort()).toEqual(["code", "correlationId", "ok"]);
      expect(body.correlationId).toMatch(
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
      );
      expect(response.headers.get("X-CPL-Correlation-ID")).toBe(body.correlationId);
      expect(response.headers.get("cache-control")).toBe("no-store, private");
      expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({
        event: "cpl.local.entry.failure",
        correlationId: body.correlationId,
        stage: "session_issuance",
        code: "CPL_HOSTED_AUTH_UNAVAILABLE",
      });
      expect(JSON.stringify(log.mock.calls) + JSON.stringify(body)).not.toMatch(
        /PRIVATE_PASSWORD|private\.invalid|SESSION_CANARY|CALLER_SUPPLIED_CANARY/u,
      );
    } finally {
      log.mockRestore();
    }
  });
  it("classifies missing schema by a bounded SQL code without exposing SQL and does not declare readiness", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      state.runtimeCalls.mockImplementationOnce(() => {
        throw Object.assign(new Error("SELECT PRIVATE_SQL_CANARY"), {
          code: "42P01",
          detail: "PRIVATE_VALUE_CANARY",
        });
      });
      const response = await localDevelopmentStatus(request("/api/auth/local/status"));
      const body = await response.json();
      expect(response.status).toBe(503);
      expect(body.ready).not.toBe(true);
      expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({
        stage: "guarded_runtime",
        category: "schema_contract_missing",
      });
      expect(JSON.stringify(log.mock.calls) + JSON.stringify(body)).not.toMatch(
        /PRIVATE_SQL_CANARY|PRIVATE_VALUE_CANARY/u,
      );
    } finally {
      log.mockRestore();
    }
  });
  it("offers only safe fixed persona labels after runtime validation", async () => {
    const response = await localDevelopmentConfig(request("/api/auth/local/config"));
    expect(await response.json()).toEqual({
      authenticationMode: "local-development",
      synthetic: true,
      personas: [{ key: "legacy-owner", label: "Existing development owner" }],
    });
    expect(state.runtimeCalls).toHaveBeenCalledOnce();
    expect(response.headers.get("cache-control")).toBe("no-store, private");
  });
  it("accepts only a fixed persona key, without role or provider claims", async () => {
    const response = await localDevelopmentSignIn(
      request(
        "/api/auth/local/sign-in",
        "POST",
        JSON.stringify({ personaKey: "platform-operator" }),
      ),
    );
    expect(response.status).toBe(200);
    expect(state.issue).toHaveBeenCalledWith(
      state.runtime,
      expect.any(Request),
      token,
      "platform-operator",
    );
    for (const input of [
      { personaKey: "unregistered" },
      { personaKey: "owner-alpha", role: "owner" },
      { personaKey: 5 },
    ]) {
      expect(
        (
          await localDevelopmentSignIn(
            request("/api/auth/local/sign-in", "POST", JSON.stringify(input)),
          )
        ).status,
      ).toBe(400);
    }
    expect(state.issue).toHaveBeenCalledOnce();
  });
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
      session: { hasPasskey: false, stepUpRequired: true },
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
