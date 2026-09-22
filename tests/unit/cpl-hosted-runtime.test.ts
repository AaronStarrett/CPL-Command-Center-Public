import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  configurations: [] as unknown[],
  rows: [{ unsafe: false }] as unknown[],
  closed: vi.fn(),
  query: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("@bea/database/hosted", async () => ({
  ...(await import("../../packages/database/src/hosted-connection")),
  verifyHostedDatabaseRole: (await import("../../packages/database/src/hosted-database-role"))
    .verifyHostedDatabaseRole,
  PgDatabaseAdapter: class {
    kind = "postgres";
    constructor(configuration: unknown) {
      database.configurations.push(configuration);
    }
    query = async (sql: string) => {
      database.query(sql);
      return { rows: database.rows };
    };
    close = database.closed;
  },
  SqlCplHostedAuthStore: class {},
  SqlCplTenantRepository: class {},
}));
import {
  readHostedAuthConfiguration,
  hostedAuthConfigurationStatus,
  hostedCookie,
  withHostedRuntime,
} from "../../apps/web/lib/hosted-auth";

const configuration = {
  NODE_ENV: "production",
  CPL_HOSTED_ENABLED: "true",
  APP_BASE_URL: "https://command.example.test",
  GOOGLE_CLIENT_ID: "synthetic.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "synthetic-test-secret",
  DATABASE_URL: "postgresql://synthetic:synthetic@db.example.test/cpl?sslmode=require",
};
const safeRole = {
  rolname: "cpl_web",
  purpose: "web",
  rolsuper: false,
  rolbypassrls: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolreplication: false,
  owns_database: false,
  owns_schema: false,
  schema_create: false,
  elevated_membership: false,
  can_change_role_registry: false,
  can_read_legacy_leads: false,
  owns_application_tables: false,
  tenant_tables_protected: true,
};

beforeEach(() => {
  database.rows = [{ ...safeRole }];
  database.configurations.length = 0;
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllEnvs());

describe("Hosted runtime fail-closed configuration", () => {
  it("requires an explicit production enable gate, HTTPS origin, identity credentials and PostgreSQL", () => {
    expect(readHostedAuthConfiguration(configuration)).toMatchObject({
      origin: configuration.APP_BASE_URL,
      databaseUrl: "postgresql://synthetic:synthetic@db.example.test/cpl",
    });
    for (const key of Object.keys(configuration))
      expect(() => readHostedAuthConfiguration({ ...configuration, [key]: "" })).toThrow();
    expect(() => readHostedAuthConfiguration({ ...configuration, NODE_ENV: "test" })).toThrow();
    expect(() =>
      readHostedAuthConfiguration({ ...configuration, APP_BASE_URL: "http://localhost:3000" }),
    ).toThrow();
    expect(() =>
      readHostedAuthConfiguration({
        ...configuration,
        APP_BASE_URL: "https://command.example.test/path",
      }),
    ).toThrow();
    expect(() =>
      readHostedAuthConfiguration({ ...configuration, DATABASE_URL: "file:///tmp/pglite" }),
    ).toThrow();
  });

  it.each([
    "ssl=false",
    "sslmode=disable",
    "sslmode=no-verify",
    "sslcert=certificate.pem",
    "sslkey=private.pem",
    "sslrootcert=ca.pem",
    "uselibpqcompat=true",
    "SSLMODE=disable",
  ])("rejects connection-string TLS override %s", (query) => {
    expect(() =>
      readHostedAuthConfiguration({
        ...configuration,
        DATABASE_URL: `postgresql://synthetic:synthetic@db.example.test/cpl?${query}`,
      }),
    ).toThrow();
  });

  it("returns only missing variable names in readiness", () => {
    const status = hostedAuthConfigurationStatus({ ...configuration, GOOGLE_CLIENT_ID: "" });
    expect(status).toEqual({ enabled: true, configured: false, missing: ["GOOGLE_CLIENT_ID"] });
    expect(JSON.stringify(status)).not.toContain(configuration.GOOGLE_CLIENT_SECRET);
    expect(JSON.stringify(status)).not.toContain(configuration.DATABASE_URL);
  });

  it.each([true, null, undefined])(
    "refuses privileged or indeterminate database role (%s) and always closes its pool",
    async (unsafe) => {
      for (const [key, value] of Object.entries(configuration)) vi.stubEnv(key, value);
      database.rows = [{ ...safeRole, rolbypassrls: unsafe }];
      const operation = vi.fn();
      await expect(withHostedRuntime(operation)).rejects.toThrow(
        "CPL_HOSTED_DATABASE_ROLE_REFUSED",
      );
      expect(operation).not.toHaveBeenCalled();
      expect(database.closed).toHaveBeenCalledTimes(1);
    },
  );

  it("uses a verified TLS connection per invocation and closes even when an operation fails", async () => {
    for (const [key, value] of Object.entries(configuration)) vi.stubEnv(key, value);
    await expect(
      withHostedRuntime(async () => {
        throw new Error("Synthetic operation failure");
      }),
    ).rejects.toThrow("Synthetic operation failure");
    expect(database.configurations[0]).toMatchObject({
      ssl: { rejectUnauthorized: true },
      max: 1,
      connectionTimeoutMillis: 10_000,
    });
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("WITH RECURSIVE inherited"),
    );
    expect(database.closed).toHaveBeenCalledTimes(1);
  });
  it.each(["owns_application_tables", "tenant_tables_protected"])(
    "refuses unsafe RLS capability %s",
    async (capability) => {
      for (const [key, value] of Object.entries(configuration)) vi.stubEnv(key, value);
      database.rows = [{ ...safeRole, [capability]: capability === "owns_application_tables" }];
      const operation = vi.fn();
      await expect(withHostedRuntime(operation)).rejects.toThrow(
        "CPL_HOSTED_DATABASE_ROLE_REFUSED",
      );
      expect(operation).not.toHaveBeenCalled();
      expect(database.closed).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects duplicate session cookies rather than guessing one", async () => {
    const name = "__Host-cpl-session";
    expect(
      await hostedCookie(
        name,
        new Request(configuration.APP_BASE_URL, {
          headers: { cookie: `${name}=first; ${name}=second` },
        }),
      ),
    ).toBeUndefined();
    expect(
      await hostedCookie(
        name,
        new Request(configuration.APP_BASE_URL, {
          headers: { cookie: `unrelated=x; ${name}=only` },
        }),
      ),
    ).toBe("only");
  });
  it.each([
    "",
    "__Host-cpl-session=short",
    `__Host-cpl-session=${"a".repeat(43)}; __Host-cpl-session=${"b".repeat(43)}`,
  ])("rejects an impossible protected session before opening the database (%s)", async (cookie) => {
    for (const [key, value] of Object.entries(configuration)) vi.stubEnv(key, value);
    const operation = vi.fn();
    await expect(
      withHostedRuntime(operation, {
        sessionRequest: new Request(configuration.APP_BASE_URL, { headers: { cookie } }),
      }),
    ).rejects.toThrow("CPL_AUTHENTICATION_REQUIRED");
    expect(database.configurations).toHaveLength(0);
    expect(database.query).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
  });
  it("a plausible cookie never bypasses the live database role verification", async () => {
    for (const [key, value] of Object.entries(configuration)) vi.stubEnv(key, value);
    database.rows = [{ ...safeRole, rolbypassrls: true }];
    const operation = vi.fn();
    await expect(
      withHostedRuntime(operation, {
        sessionRequest: new Request(configuration.APP_BASE_URL, {
          headers: { cookie: `__Host-cpl-session=${"a".repeat(43)}` },
        }),
      }),
    ).rejects.toThrow("CPL_HOSTED_DATABASE_ROLE_REFUSED");
    expect(database.configurations).toHaveLength(1);
    expect(database.closed).toHaveBeenCalledOnce();
    expect(operation).not.toHaveBeenCalled();
  });
});
