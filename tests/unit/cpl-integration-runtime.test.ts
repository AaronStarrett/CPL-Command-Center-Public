import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCplIntegrationRuntime } from "../../packages/database/src/cpl-integration-runtime";
import type { DatabaseAdapter } from "../../packages/database/src/adapter";

const origin = "http://127.0.0.1:3400";
let serialized: string;
const databaseRow = {
  database_name: "cpl_local_development",
  role_name: "cpl_local_web",
  address: "127.0.0.1",
  port: 55433,
  purpose: "local-development",
};
const database = (change = {}) =>
  ({
    kind: "postgres",
    query: vi.fn(async () => ({ rows: [{ ...databaseRow, ...change }] })),
  }) as unknown as DatabaseAdapter;
const environment = (change: Record<string, string | undefined> = {}) => ({
  NODE_ENV: "test",
  CPL_LOCAL_DEVELOPMENT_AUTH: "true",
  CPL_HOSTED_ENABLED: "false",
  CPL_INTEGRATION_PROVIDER_MODE: "local_fixture",
  CPL_LOCAL_INTEGRATION_MATERIAL: serialized,
  ...change,
});
beforeAll(() => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  serialized = JSON.stringify({
    version: 1,
    createdAt: new Date().toISOString(),
    purpose: "synthetic-local-integration-fixture",
    keyVersion: "local-fixture-v1",
    envelopeKey: randomBytes(32).toString("base64url"),
    fixtureSecret: randomBytes(32).toString("base64url"),
    privateJwk: pair.privateKey.export({ format: "jwk" }),
    publicJwk: pair.publicKey.export({ format: "jwk" }),
  });
});
beforeEach(() => vi.stubEnv("NODE_ENV", "test"));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("trusted integration runtime composition (unit database boundary)", () => {
  it("defaults to disabled without reading keys or starting any provider request", async () => {
    const db = database();
    expect(await createCplIntegrationRuntime({ database: db, origin, environment: {} })).toEqual({
      providerMode: "disabled",
    });
    expect(db.query).not.toHaveBeenCalled();
  });
  it.each([
    { database_name: "customer_database" },
    { role_name: "postgres" },
    { role_name: "cpl_local_operator" },
    { address: "192.0.2.1" },
    { port: 5432 },
    { purpose: "production" },
  ])("refuses fixture execution against a mismatched database boundary %j", async (change) => {
    await expect(
      createCplIntegrationRuntime({
        database: database(change),
        origin,
        environment: environment(),
      }),
    ).rejects.toThrow("CPL_INTEGRATION_CONFIGURATION_UNAVAILABLE");
  });
  it.each([
    { NODE_ENV: "production" },
    { CPL_LOCAL_DEVELOPMENT_AUTH: undefined },
    { CPL_HOSTED_ENABLED: "true" },
    { GOOGLE_CLIENT_SECRET: "synthetic-signin-secret" },
    { CPL_GMAIL_CLIENT_SECRET: "synthetic-live-secret" },
    { CPL_LOCAL_INTEGRATION_MATERIAL: "malformed" },
  ])("refuses unsafe or incomplete local composition %j", async (change) => {
    await expect(
      createCplIntegrationRuntime({
        database: database(),
        origin,
        environment: environment(change),
      }),
    ).rejects.toThrow("CPL_INTEGRATION_CONFIGURATION_UNAVAILABLE");
  });
  it("an environment argument cannot enable fixtures inside a production process", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(
      createCplIntegrationRuntime({ database: database(), origin, environment: environment() }),
    ).rejects.toThrow();
  });
  it("rejects a non-loopback application origin and retained fixture material in live mode", async () => {
    await expect(
      createCplIntegrationRuntime({
        database: database(),
        origin: "https://customer.invalid",
        environment: environment(),
      }),
    ).rejects.toThrow();
    await expect(
      createCplIntegrationRuntime({
        database: database(),
        origin,
        environment: environment({ CPL_INTEGRATION_PROVIDER_MODE: "live" }),
      }),
    ).rejects.toThrow();
  });
  it("reconstructs the actual OAuth adapter across requests without any real fetch fallback", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected external network"));
    const runtime = await createCplIntegrationRuntime({
      database: database(),
      origin,
      environment: environment(),
    });
    const organizationId = randomUUID(),
      connectionId = randomUUID(),
      signal = new AbortController().signal;
    const operations: string[] = [];
    const assertCurrent = async (operation: string) => {
      operations.push(operation);
    };
    const first = await runtime.createGmailAdapter!({
      organizationId,
      connectionId,
      signal,
      assertCurrent,
    });
    const nonce = randomBytes(32).toString("base64url"),
      verifier = randomBytes(32).toString("base64url"),
      state = randomBytes(32).toString("base64url");
    const callback = new URL(
      await first.authorizationUrl({ nonce, verifier, state, redirectUri: runtime.redirectUri! }),
    );
    expect(callback.origin).toBe(origin);
    expect(callback.searchParams.get("state")).toBe(state);
    const second = await runtime.createGmailAdapter!({
      organizationId,
      connectionId,
      signal,
      assertCurrent,
    });
    const exchanged = await second.exchangeCode({
      code: callback.searchParams.get("code")!,
      verifier,
      nonce,
      redirectUri: runtime.redirectUri!,
    });
    expect(exchanged.account.email).toMatch(/@example\.invalid$/u);
    expect(operations).toContain("jwks");
    expect(operations).toContain("exchange");
    const labels = await second.listLabels({ accessToken: exchanged.tokens.accessToken });
    expect(labels.length).toBeGreaterThan(0);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("revoked authority is checked before generating even a fixture authorization redirect", async () => {
    const runtime = await createCplIntegrationRuntime({
      database: database(),
      origin,
      environment: environment(),
    });
    const adapter = await runtime.createGmailAdapter!({
      organizationId: randomUUID(),
      connectionId: randomUUID(),
      signal: new AbortController().signal,
      assertCurrent: async () => {
        throw new Error("Authority revoked");
      },
    });
    await expect(
      adapter.authorizationUrl({
        state: "a".repeat(43),
        nonce: "b".repeat(43),
        verifier: "c".repeat(43),
        redirectUri: runtime.redirectUri!,
      }),
    ).rejects.toThrow("Authority revoked");
  });
});
