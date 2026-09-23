import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { CplHostedAuthService, CplHostedAuthenticationError } from "@bea/security/hosted";
import type { CplHostedSession } from "@bea/security/hosted";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  source: {},
  readConfiguration: vi.fn(),
  fallback: vi.fn(),
  withSession: vi.fn(),
  status: vi.fn(),
  cookie: vi.fn(),
}));
vi.mock("../../apps/web/lib/hosted-auth", () => ({
  readHostedAuthConfiguration: mocks.readConfiguration,
  withHostedRuntime: mocks.fallback,
  hostedAuthConfigurationStatus: mocks.status,
  hostedCookie: mocks.cookie,
  requireHostedMutation: vi.fn(),
}));
import {
  createHostedSessionRuntime,
  readOnlySessionStore,
  SESSION_HTTP_CONTRACT,
} from "../../apps/web/lib/hosted-session-http.ts";
vi.mock("../../apps/web/lib/hosted-session-http", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  withHostedSessionRuntime: mocks.withSession,
}));
import { hostedSession } from "../../apps/web/lib/hosted-auth-routes.ts";
const time = "2026-09-23T02:00:00.000Z",
  token = "A".repeat(43),
  csrf = "B".repeat(43),
  hash = (v: string) => createHash("sha256").update(v).digest("hex");
const session: CplHostedSession = {
  id: "00000000-0000-4000-8000-000000000001",
  identityId: "00000000-0000-4000-8000-000000000002",
  issuer: "https://accounts.google.com",
  subject: "synthetic",
  email: "synthetic@example.invalid",
  displayName: "Synthetic",
  createdAt: time,
  authenticatedAt: time,
  expiresAt: "2026-09-23T03:00:00.000Z",
  absoluteExpiresAt: "2026-09-23T10:00:00.000Z",
  mfaVerifiedAt: null,
  selectedOrganizationId: null,
  csrfTokenHash: hash(csrf),
  platformAdministrator: false,
};
const config = {
  origin: "https://example.invalid",
  databaseTransport: "hyperdrive" as const,
  databaseUrl: "ignored-platform-binding",
  databaseSsl: false as const,
  googleClientId: "synthetic.apps.googleusercontent.com",
  googleClientSecret: "SYNTHETIC",
};
const environment = {
  CPL_SESSION_READ_TRANSPORT: "neon-http",
  CPL_SESSION_HTTP_CONTRACT: SESSION_HTTP_CONTRACT,
  CPL_NEON_WEB_HOST: "ep-synthetic.us-east-2.aws.neon.tech",
  CPL_NEON_WEB_DATABASE: "neondb",
  DATABASE_URL: "SYNTHETIC-INPUT-ONLY",
};
function reader() {
  return {
    readSession: vi.fn(async () => session),
    readSessionWithPasskey: vi.fn(async () => ({ session, hasPasskey: true })),
    close: vi.fn(),
    status: () => ({ state: "new", requests: 0 }),
  };
}
function setup() {
  const readers: ReturnType<typeof reader>[] = [],
    factory = {
      invocation: () => {
        const r = reader();
        readers.push(r);
        return r;
      },
    },
    createTransport = vi.fn(() => factory),
    loadDriver = vi.fn(async () => ({}));
  let source = { ...environment };
  const runtime = createHostedSessionRuntime({
    source: () => source,
    readConfiguration: () => config,
    fallback: mocks.fallback,
    loadDriver,
    createTransport,
  });
  return {
    runtime,
    readers,
    createTransport,
    loadDriver,
    setSource: (value: typeof source) => {
      source = value;
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.status.mockReturnValue({ configured: true });
  mocks.cookie.mockImplementation(async (name: string) =>
    name === "__Host-cpl-session" ? token : csrf,
  );
});
describe("narrow session runtime", () => {
  it("default selector preserves original runtime without initializing HTTP", async () => {
    const loadDriver = vi.fn();
    const runtime = createHostedSessionRuntime({
      source: () => ({}),
      loadDriver,
    });
    mocks.fallback.mockResolvedValue("original");
    expect(await runtime(async () => "unused")).toBe("original");
    expect(mocks.fallback).toHaveBeenCalledOnce();
    expect(loadDriver).not.toHaveBeenCalled();
  });
  it("unknown selector refuses without fallback", async () => {
    const runtime = createHostedSessionRuntime({
      source: () => ({ CPL_SESSION_READ_TRANSPORT: "typo" }),
    });
    await expect(runtime(async () => "unused")).rejects.toBeInstanceOf(
      CplHostedAuthenticationError,
    );
    expect(mocks.fallback).not.toHaveBeenCalled();
  });
  it("one immutable SDK factory and separate invocation stores even concurrently", async () => {
    const s = setup();
    await Promise.all([
      s.runtime(async (r) => {
        expect(r.auth).toBeInstanceOf(CplHostedAuthService);
        return "a";
      }),
      s.runtime(async () => "b"),
    ]);
    expect(s.loadDriver).toHaveBeenCalledOnce();
    expect(s.createTransport).toHaveBeenCalledOnce();
    expect(s.readers).toHaveLength(2);
    expect(s.readers[0]).not.toBe(s.readers[1]);
    expect(s.readers.every((r) => r.close.mock.calls.length === 1)).toBe(true);
  });
  for (const key of ["DATABASE_URL", "CPL_NEON_WEB_HOST", "CPL_NEON_WEB_DATABASE"] as const)
    it(`${key} rotation fails closed without using old credentials or fallback`, async () => {
      const s = setup();
      await s.runtime(async () => true);
      s.setSource({ ...environment, [key]: environment[key] + "changed" });
      await expect(s.runtime(async () => true)).rejects.toThrow("CPL_HOSTED_AUTH_UNAVAILABLE");
      expect(s.readers).toHaveLength(1);
      expect(mocks.fallback).not.toHaveBeenCalled();
    });
  it("HTTP error never falls back and callback error still closes reader", async () => {
    const s = setup();
    await expect(
      s.runtime(async () => {
        throw Error("CALLBACK_FAILED");
      }),
    ).rejects.toThrow("CALLBACK_FAILED");
    expect(s.readers[0]!.close).toHaveBeenCalledOnce();
    expect(mocks.fallback).not.toHaveBeenCalled();
    const fail = createHostedSessionRuntime({
      source: () => environment,
      readConfiguration: () => config,
      loadDriver: async () => {
        throw Error("SDK_FAILED");
      },
    });
    await expect(fail(async () => true)).rejects.toThrow("SDK_FAILED");
    expect(mocks.fallback).not.toHaveBeenCalled();
  });
  for (const patch of [{ CPL_SESSION_HTTP_CONTRACT: "bad" }, { DATABASE_URL: "" }])
    it("migration contract and origin secret are mandatory before SDK load", async () => {
      const s = setup();
      s.setSource({ ...environment, ...patch });
      await expect(s.runtime(async () => true)).rejects.toThrow("CPL_HOSTED_AUTH_UNAVAILABLE");
      expect(s.loadDriver).not.toHaveBeenCalled();
    });
  it("read-only store refuses every other persistence operation", async () => {
    const r = reader(),
      store = readOnlySessionStore(r);
    for (const name of Object.keys(store).filter(
      (n) => !["readSession", "readSessionWithPasskey"].includes(n),
    ))
      await expect(
        (store as unknown as Record<string, () => Promise<unknown>>)[name]!(),
      ).rejects.toThrow("CPL_HOSTED_AUTH_UNAVAILABLE");
    expect(r.readSession).not.toHaveBeenCalled();
  });
});
describe("unchanged session endpoint freshness and disclosure", () => {
  function routeService({
    first = session,
    second = { session, hasPasskey: true },
    expire = false,
  }: {
    first?: CplHostedSession | null;
    second?: { session: CplHostedSession; hasPasskey: boolean } | null;
    expire?: boolean;
  } = {}) {
    const r = reader();
    let current = Date.parse(time);
    r.readSession.mockImplementation(async () => first as CplHostedSession);
    r.readSessionWithPasskey.mockImplementation(async () => {
      if (expire) current = Date.parse(session.expiresAt);
      return second as { session: CplHostedSession; hasPasskey: boolean };
    });
    const auth = new CplHostedAuthService(
      readOnlySessionStore(r),
      {
        authorizationUrl: () => {
          throw Error("UNUSED");
        },
        exchangeCode: async () => {
          throw Error("UNUSED");
        },
      },
      { appOrigin: config.origin, now: () => new Date(current) },
    );
    mocks.withSession.mockImplementation(async (operation) => operation({ auth }));
    return r;
  }
  it("real service performs first read before CSRF then fresh second read, without credential material", async () => {
    const r = routeService();
    const response = await hostedSession(new Request(config.origin + "/api/auth/session"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      authenticated: true,
      identity: { id: session.identityId },
      session: { hasPasskey: true },
    });
    expect(r.readSession).toHaveBeenCalledExactlyOnceWith(hash(token), time);
    expect(r.readSessionWithPasskey).toHaveBeenCalledExactlyOnceWith(hash(token), time);
    expect(r.readSession.mock.invocationCallOrder[0]).toBeLessThan(
      r.readSessionWithPasskey.mock.invocationCallOrder[0]!,
    );
    expect(response.headers.get("cache-control")).toBe("no-store, private");
  });
  it("CSRF mismatch prevents the second read", async () => {
    const r = routeService();
    mocks.cookie.mockImplementation(async (name: string) =>
      name === "__Host-cpl-session" ? token : "C".repeat(43),
    );
    const response = await hostedSession(new Request(config.origin));
    expect(await response.json()).toEqual({
      authenticated: false,
      code: "CPL_SESSION_COOKIES_INCOMPLETE",
    });
    expect(r.readSessionWithPasskey).not.toHaveBeenCalled();
  });
  it("revocation between reads fails authentication instead of returning the first identity", async () => {
    const r = routeService({ second: null });
    const response = await hostedSession(new Request(config.origin));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      ok: false,
      code: "CPL_AUTHENTICATION_REQUIRED",
    });
    expect(r.readSessionWithPasskey).toHaveBeenCalledOnce();
  });
  it("expiry after second transaction is refused by unchanged service before response", async () => {
    routeService({ expire: true });
    const response = await hostedSession(new Request(config.origin));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      ok: false,
      code: "CPL_AUTHENTICATION_REQUIRED",
    });
  });
  it("NULL first session prevents CSRF and second read", async () => {
    const r = routeService({ first: null });
    const response = await hostedSession(new Request(config.origin));
    expect(await response.json()).toEqual({ authenticated: false });
    expect(r.readSessionWithPasskey).not.toHaveBeenCalled();
  });
});
