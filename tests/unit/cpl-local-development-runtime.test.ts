import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseAdapter } from "../../packages/database/src/adapter";
const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  query: vi.fn(),
  close: vi.fn(),
  construct: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@bea/database/hosted", async (original) => ({
  ...(await original<typeof import("@bea/database/hosted")>()),
  verifyHostedDatabaseRole: mocks.verify,
  PgDatabaseAdapter: class {
    constructor(options: unknown) {
      mocks.construct(options);
    }
    query = mocks.query;
    close = mocks.close;
  },
}));
import {
  verifyLocalDevelopmentDatabase,
  withLocalDevelopmentRuntime,
} from "../../apps/web/lib/local-development-auth";
const row = {
  database_name: "cpl_local_development",
  role_name: "cpl_local_web",
  server_address: "127.0.0.1",
  server_port: 55433,
  purpose: "local-development",
  hosted_owner_exists: false,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.verify.mockResolvedValue(undefined);
  mocks.close.mockResolvedValue(undefined);
  mocks.query.mockResolvedValue({ rows: [row] });
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
const database = { query: mocks.query } as unknown as DatabaseAdapter;
const request = () =>
  new Request("http://127.0.0.1:3400/api/auth/local/status", {
    headers: { host: "127.0.0.1:3400" },
  });
describe("local database confinement", () => {
  it.each([
    { database_name: "production" },
    { role_name: "postgres" },
    { server_address: "192.0.2.1" },
    { server_port: 5432 },
    { purpose: null },
    { hosted_owner_exists: true },
  ])("refuses wrong database marker or origin %j", async (change) => {
    mocks.query.mockResolvedValue({ rows: [{ ...row, ...change }] });
    await expect(verifyLocalDevelopmentDatabase(database)).rejects.toThrow(
      "CPL_LOCAL_DEVELOPMENT_REFUSED",
    );
  });
  it("retains the complete restricted-role/RLS verifier before marker access", async () => {
    mocks.verify.mockRejectedValue(new Error("role denied"));
    await expect(verifyLocalDevelopmentDatabase(database)).rejects.toThrow("role denied");
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("never constructs a pool without a guarded loopback request", async () => {
    await expect(withLocalDevelopmentRuntime(async () => true, undefined)).rejects.toThrow();
    expect(mocks.construct).not.toHaveBeenCalled();
  });
  it("closes the fresh pool when role verification fails", async () => {
    mocks.verify.mockRejectedValue(new Error("role denied"));
    await expect(withLocalDevelopmentRuntime(async () => true, request())).rejects.toThrow();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it("closes the fresh pool when the application operation fails", async () => {
    await expect(
      withLocalDevelopmentRuntime(async () => {
        throw new Error("operation failed");
      }, request()),
    ).rejects.toThrow("operation failed");
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.construct).toHaveBeenCalledWith(
      expect.objectContaining({ max: 1, ssl: false, statement_timeout: 15000 }),
    );
  });
});
