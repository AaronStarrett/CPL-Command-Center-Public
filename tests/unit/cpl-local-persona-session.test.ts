import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import type { CplHostedRuntime } from "../../apps/web/lib/hosted-auth";
const mock = vi.hoisted(() => ({
  rate: vi.fn(),
  query: vi.fn(),
  session: vi.fn(),
  organizations: vi.fn(),
  select: vi.fn(),
  platform: [] as { status: string }[],
}));
vi.mock("server-only", () => ({}));
vi.mock("@bea/database/hosted", async (original) => ({
  ...(await original<typeof import("@bea/database/hosted")>()),
  SqlCplHostedAuthStore: class {
    consumeRateLimit = mock.rate;
  },
}));
import {
  issueLocalDevelopmentSession,
  listLocalDevelopmentPersonas,
} from "../../apps/web/lib/local-development-auth";
const runtime = {
  database: {
    query: mock.query,
    transaction: async (fn: (e: { query: typeof mock.query }) => Promise<void>) =>
      fn({ query: mock.query }),
  },
  auth: { requireSession: mock.session, selectOrganization: mock.select },
  tenants: { listOrganizations: mock.organizations },
} as unknown as CplHostedRuntime;
beforeEach(() => {
  vi.resetAllMocks();
  mock.platform = [];
  mock.rate.mockResolvedValue(true);
  mock.organizations.mockResolvedValue([]);
  mock.session.mockResolvedValue({ identityId: "fixture" });
  mock.query.mockImplementation(async (sql: string) => ({
    rows: sql.includes("SELECT i.id")
      ? [{ id: "fixture" }]
      : sql.includes("cpl_platform_administrators")
        ? mock.platform
        : [],
  }));
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
    APP_BASE_URL: "http://127.0.0.1:3400",
    CPL_LOCAL_DATABASE_URL:
      "postgresql://cpl_local_web:synthetic@127.0.0.1:55433/cpl_local_development",
    CPL_LOCAL_SESSION_SECRET: "a".repeat(43),
  }))
    vi.stubEnv(name, value);
});
afterEach(() => vi.unstubAllEnvs());
const request = () =>
  new Request("http://127.0.0.1:3400/api/auth/local/sign-in", {
    method: "POST",
    headers: { host: "127.0.0.1:3400", origin: "http://127.0.0.1:3400" },
  });
describe("fixed local persona session issuance", () => {
  it("issues a random opaque session without claiming MFA and revokes the prior cross-identity token", async () => {
    const result = await issueLocalDevelopmentSession(
      runtime,
      request(),
      "p".repeat(43),
      "owner-alpha",
    );
    expect(result.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.csrfToken).not.toBe(result.sessionToken);
    const insert = mock.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO cpl_sessions"))!;
    expect(insert[0]).toContain("FALSE");
    expect(insert[0]).toContain("NULL");
    expect(insert[1]).not.toContain(result.sessionToken);
    const revoke = mock.query.mock.calls.find(([sql]) => sql.startsWith("UPDATE cpl_sessions"))!;
    expect(revoke[0]).toContain("token_hash=$2");
    expect(revoke[0]).not.toContain("identity_id");
    expect(revoke[1]).not.toContain("p".repeat(43));
    expect(mock.query.mock.calls[0]?.[1]).toEqual([
      "https://local.cpl.invalid",
      "local-owner-alpha",
      "local-owner-alpha@cpl.invalid",
    ]);
  });
  it("refuses an ordinary persona with any unexpected platform row", async () => {
    mock.platform = [{ status: "suspended" }];
    await expect(
      issueLocalDevelopmentSession(runtime, request(), undefined, "member"),
    ).rejects.toThrow("CPL_LOCAL_DEVELOPMENT_REFUSED");
    expect(mock.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO cpl_sessions"))).toBe(
      false,
    );
  });
  it("requires the separate operator active platform record", async () => {
    await expect(
      issueLocalDevelopmentSession(runtime, request(), undefined, "platform-operator"),
    ).rejects.toThrow();
    mock.platform = [{ status: "active" }];
    await expect(
      issueLocalDevelopmentSession(runtime, request(), undefined, "platform-operator"),
    ).resolves.toBeTruthy();
  });
  it("preserves the legacy fixture with its existing row, without inventing MFA", async () => {
    mock.platform = [{ status: "active" }];
    mock.organizations.mockResolvedValue([{ id: "old-company", slug: "cpl-development" }]);
    await issueLocalDevelopmentSession(runtime, request());
    expect(mock.select).toHaveBeenCalledWith(expect.any(String), "old-company");
    expect(
      mock.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO cpl_sessions"))?.[0],
    ).toContain("FALSE");
  });
  it("does not choose among multiple memberships", async () => {
    mock.organizations.mockResolvedValue([
      { id: "a", slug: "a" },
      { id: "b", slug: "b" },
    ]);
    await issueLocalDevelopmentSession(runtime, request(), undefined, "manager");
    expect(mock.select).not.toHaveBeenCalled();
  });
  it("lists only active rows that exactly match a fixed persona pair", async () => {
    mock.query.mockResolvedValue({
      rows: [
        { subject: "local-member", email: "local-member@cpl.invalid" },
        { subject: "local-owner-alpha", email: "arbitrary@example.invalid" },
        { subject: "unregistered", email: "unregistered@cpl.invalid" },
      ],
    });
    expect(await listLocalDevelopmentPersonas(runtime)).toEqual([
      { key: "member", label: "Synthetic team member" },
    ]);
  });
});
