import { AsyncLocalStorage } from "node:async_hooks";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostedDatabaseBindings } from "../../packages/database/src/hosted-connection";

const state = vi.hoisted(() => ({
  configurations: [] as { connectionString: string; ssl: unknown }[],
  closed: vi.fn(),
  query: vi.fn(),
  transactions: vi.fn(),
  safeRole: true,
  rolePurpose: "web",
  tenantTablesProtected: true,
  deadline: 15000,
}));
vi.mock("server-only", () => ({}));
vi.mock("@bea/database/hosted", async () => ({
  ...(await import("../../packages/database/src/hosted-connection")),
  ...(await import("../../packages/database/src/hosted-web-role-guard")),
  verifyHostedDatabaseRole: (await import("../../packages/database/src/hosted-database-role"))
    .verifyHostedDatabaseRole,
  PgDatabaseAdapter: class {
    kind = "postgres";
    constructor(readonly configuration: { connectionString: string; ssl: unknown }) {
      state.configurations.push(configuration);
    }
    query = async (sql: string, parameters?: readonly unknown[]) => {
      state.query(this.configuration.connectionString, sql, parameters);
      if (sql.includes("set_config('statement_timeout'"))
        return {
          rows: [{ statement_timeout_ms: state.deadline, idle_timeout_ms: state.deadline }],
          rowCount: 1,
        };
      return {
        rows: [
          {
            rolname: "cpl_web_runtime",
            purpose: state.rolePurpose,
            rolsuper: false,
            rolbypassrls: !state.safeRole,
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
            tenant_tables_protected: state.tenantTablesProtected,
          },
        ],
        rowCount: 1,
      };
    };
    transaction = async (operation: (executor: unknown) => Promise<unknown>) => {
      state.transactions(this.configuration.connectionString);
      return operation({ query: this.query });
    };
    close = async () => state.closed(this.configuration.connectionString);
  },
  SqlCplHostedAuthStore: class {},
  SqlCplTenantRepository: class {},
}));
import {
  hostedAuthConfigurationStatus,
  readHostedAuthConfiguration,
  withHostedRuntime,
} from "../../apps/web/lib/hosted-auth";

const configuration = {
  NODE_ENV: "production",
  CPL_HOSTED_ENABLED: "true",
  CPL_DATABASE_TRANSPORT: "hyperdrive",
  APP_BASE_URL: "https://command.example.test",
  GOOGLE_CLIENT_ID: "synthetic.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "synthetic-test-secret",
};
function binding(character = "a") {
  const host = character.repeat(32) + ".hyperdrive.local";
  const database = "3".repeat(32);
  const user = "1".repeat(32);
  const url = new URL(`postgresql://${host}:5432/${database}?sslmode=disable`);
  url.username = user;
  url.password = "synthetic-platform-capability";
  return {
    host,
    port: 5432,
    database,
    user,
    password: "synthetic-platform-capability",
    connectionString: url.toString(),
  };
}
// Exercise the real OpenNext context reader with request-local storage, as its
// pinned Worker init does; no global connection or binding mock is substituted.
const context = new AsyncLocalStorage<{ env: HostedDatabaseBindings }>();
const symbol = Symbol.for("__cloudflare-context__");
const previousContext = Object.getOwnPropertyDescriptor(globalThis, symbol);
beforeAll(() =>
  Object.defineProperty(globalThis, symbol, {
    configurable: true,
    get: () => context.getStore(),
  }),
);
afterAll(() => {
  if (previousContext) Object.defineProperty(globalThis, symbol, previousContext);
  else Reflect.deleteProperty(globalThis, symbol);
  context.disable();
});
beforeEach(() => {
  vi.clearAllMocks();
  state.configurations.length = 0;
  state.safeRole = true;
  state.rolePurpose = "web";
  state.tenantTablesProtected = true;
  state.deadline = 15000;
  for (const [key, value] of Object.entries(configuration)) vi.stubEnv(key, value);
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic:synthetic@direct.example.test/cpl");
});
afterEach(() => vi.unstubAllEnvs());

describe("Hyperdrive web invocation isolation", () => {
  it("uses the current object binding without a direct database URL", async () => {
    const selected = binding();
    await context.run({ env: { CPL_WEB_DB: selected } }, async () => {
      expect(readHostedAuthConfiguration(configuration)).toMatchObject({
        databaseTransport: "hyperdrive",
        databaseUrl: selected.connectionString,
        databaseSsl: false,
      });
      expect(hostedAuthConfigurationStatus(configuration)).toEqual({
        enabled: true,
        configured: true,
        missing: [],
      });
      await withHostedRuntime(async (runtime) => runtime.database.query("SELECT 1 AS application"));
    });
    expect(state.configurations[0]).toMatchObject({
      connectionString: selected.connectionString,
      ssl: false,
      max: 1,
      query_timeout: 15000,
      statement_timeout: 15000,
      options: "-c statement_timeout=15000 -c idle_in_transaction_session_timeout=15000",
    });
    expect(state.query).toHaveBeenCalledWith(
      selected.connectionString,
      expect.stringContaining("WITH RECURSIVE inherited"),
      undefined,
    );
    expect(state.closed).toHaveBeenCalledExactlyOnceWith(selected.connectionString);
  });

  it("refuses absent request context instead of connecting to an available direct credential", async () => {
    const operation = vi.fn();
    await expect(withHostedRuntime(operation)).rejects.toThrow("CPL_HOSTED_AUTH_NOT_CONFIGURED");
    expect(state.configurations).toHaveLength(0);
    expect(operation).not.toHaveBeenCalled();
    expect(hostedAuthConfigurationStatus()).toEqual({
      enabled: true,
      configured: false,
      missing: ["CPL_WEB_DB"],
    });
  });

  it("refuses a jobs-only invocation and reports readiness without exposing values", async () => {
    const bindings = { CPL_JOBS_DB: binding() };
    await context.run({ env: bindings }, async () => {
      await expect(withHostedRuntime(vi.fn())).rejects.toThrow("CPL_HOSTED_AUTH_NOT_CONFIGURED");
      const status = hostedAuthConfigurationStatus();
      expect(status).toEqual({ enabled: true, configured: false, missing: ["CPL_WEB_DB"] });
      expect(JSON.stringify(status)).not.toContain("synthetic-platform-capability");
      expect(JSON.stringify(status)).not.toContain(configuration.GOOGLE_CLIENT_SECRET);
    });
    expect(state.configurations).toHaveLength(0);
  });

  it("still refuses a privileged role through the actual selected transport and closes", async () => {
    state.safeRole = false;
    const operation = vi.fn();
    await context.run({ env: { CPL_WEB_DB: binding() } }, async () => {
      await expect(
        withHostedRuntime(async (runtime) => {
          await runtime.database.query("SELECT 1 AS application");
          operation();
        }),
      ).rejects.toThrow("CPL_HOSTED_DATABASE_ROLE_REFUSED");
    });
    expect(operation).not.toHaveBeenCalled();
    expect(state.closed).toHaveBeenCalledOnce();
  });

  it.each(["wrong-purpose", "missing-tenant-RLS"])(
    "refuses %s at the origin before application work despite valid frontend credentials",
    async (failure) => {
      if (failure === "wrong-purpose") state.rolePurpose = "worker";
      else state.tenantTablesProtected = false;
      const operation = vi.fn();
      await context.run({ env: { CPL_WEB_DB: binding() } }, async () => {
        await expect(
          withHostedRuntime(async (runtime) => {
            await runtime.database.query("SELECT 1 AS application");
            operation();
          }),
        ).rejects.toThrow("CPL_HOSTED_DATABASE_ROLE_REFUSED");
      });
      expect(state.query).toHaveBeenCalledTimes(2);
      expect(state.query.mock.calls[1]?.[1]).toContain("WITH RECURSIVE inherited");
      expect(operation).not.toHaveBeenCalled();
      expect(state.closed).toHaveBeenCalledOnce();
    },
  );

  it("refuses failed same-transaction deadline setup before role or application work", async () => {
    state.deadline = 0;
    const operation = vi.fn();
    await context.run({ env: { CPL_WEB_DB: binding() } }, async () => {
      await expect(
        withHostedRuntime(async (runtime) => {
          await runtime.database.query("SELECT 1 AS application");
          operation();
        }),
      ).rejects.toThrow("CPL_HYPERDRIVE_SERVER_DEADLINES_REFUSED");
    });
    expect(state.query).toHaveBeenCalledOnce();
    expect(operation).not.toHaveBeenCalled();
    expect(state.closed).toHaveBeenCalledOnce();
  });

  it("keeps overlapping invocation capabilities and pools separate across awaits", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = binding("a");
    const second = binding("b");
    const operations: string[] = [];
    const left = context.run({ env: { CPL_WEB_DB: first } }, () =>
      withHostedRuntime(async (runtime) => {
        await pending;
        operations.push(readHostedAuthConfiguration().databaseUrl);
        await runtime.database.query("SELECT 1 AS left_request");
      }),
    );
    const right = context.run({ env: { CPL_WEB_DB: second } }, () =>
      withHostedRuntime(async (runtime) => {
        operations.push(readHostedAuthConfiguration().databaseUrl);
        await runtime.database.query("SELECT 1 AS right_request");
        release();
      }),
    );
    await Promise.all([left, right]);
    expect(operations).toEqual([second.connectionString, first.connectionString]);
    expect(state.configurations.map((entry) => entry.connectionString)).toEqual([
      first.connectionString,
      second.connectionString,
    ]);
    expect(state.query).toHaveBeenCalledWith(
      first.connectionString,
      "SELECT 1 AS left_request",
      undefined,
    );
    expect(state.query).toHaveBeenCalledWith(
      second.connectionString,
      "SELECT 1 AS right_request",
      undefined,
    );
    expect(state.closed).toHaveBeenCalledTimes(2);
    expect(state.closed).toHaveBeenCalledWith(first.connectionString);
    expect(state.closed).toHaveBeenCalledWith(second.connectionString);
  });

  it("closes the chosen invocation pool when application work fails", async () => {
    await context.run({ env: { CPL_WEB_DB: binding() } }, async () => {
      await expect(
        withHostedRuntime(async () => {
          throw new Error("synthetic application failure");
        }),
      ).rejects.toThrow("synthetic application failure");
    });
    expect(state.closed).toHaveBeenCalledOnce();
  });
});
