import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEnvironment } from "../../packages/config/src/environment.js";
import {
  assertApplicationProviderExecutionAllowed,
  assertLegacyRuntimeTestOnly,
  inspectRuntimeConfiguration,
  ProductAiActivationRequiredError,
  ProductRuntimeNotReadyError,
} from "../../packages/config/src/runtime-policy.js";
import {
  createServerRuntime,
  getServerRuntime,
} from "../../packages/database/src/server-runtime.js";
import { runDatabaseCommand } from "../../packages/database/src/cli/database-command.js";
import {
  assertDemoResetAllowed,
  DEMO_RESET_CONFIRMATION,
} from "../../packages/database/src/reset.js";
import { runWorker } from "../../apps/worker/src/runtime.js";
import { seedDatabase, seedDatabaseOnExecutor } from "../../packages/database/src/seed.js";
import type { DatabaseAdapter, SqlExecutor } from "../../packages/database/src/adapter.js";
import { DemoStreamingAiProvider } from "../../packages/ai/src/demo-streaming-provider.js";
import { createDefaultMockProviderRegistry } from "../../packages/integrations/src/defaults.js";
import { DemoAuthenticationAdapter } from "../../packages/security/src/authentication.js";
import type { AuditSink, SessionStore, UserDirectory } from "../../packages/domain/src/index.js";
import { seedWorkControl } from "../../packages/database/src/work-control-seed.js";
import { seedInspectionReportCore } from "../../packages/database/src/operations-seed.js";
import { seedGuidedMeridianExperience } from "../../packages/database/src/guided-demo-seed.js";
import { seedDigitalWorkforce } from "../../packages/database/src/digital-workforce-seed.js";
import { seedConfigurationStudio } from "../../packages/database/src/configuration-seed.js";
import { seedCommercial } from "../../packages/database/src/commercial-seed.js";

const configuredProduction = {
  NODE_ENV: "production",
  APP_MODE: "production",
  APP_BASE_URL: "https://cpl.example.invalid",
  DATABASE_DRIVER: "postgres",
  DATABASE_URL: "postgresql://database.example.invalid/cpl",
  SESSION_SECRET: "isolated-test-fixture-session-secret-only",
  DEMO_AUTH_ENABLED: "false",
} as const;

afterEach(() => vi.unstubAllEnvs());

describe("CPL empty installation and runtime safety", () => {
  it("requires secure configuration instead of seeding a default business", () => {
    expect(() => parseEnvironment({})).toThrow();
    expect(inspectRuntimeConfiguration({})).toMatchObject({
      state: "unconfigured",
      code: "CPL_CONFIGURATION_REQUIRED",
    });
    expect(parseEnvironment(configuredProduction)).toMatchObject({
      appMode: "production",
      authProvider: "microsoft-entra",
      demoAuthEnabled: false,
      databaseDriver: "postgres",
    });
  });

  it.each([undefined, "development", "production"])(
    "rejects synthetic defaults outside NODE_ENV=test (%s)",
    (nodeEnv) => {
      expect(() => parseEnvironment({ NODE_ENV: nodeEnv, APP_MODE: "demo" })).toThrow(
        /isolated NODE_ENV=test/u,
      );
    },
  );

  it("keeps production validation authoritative over the legacy development override", () => {
    expect(() =>
      parseEnvironment({
        NODE_ENV: "production",
        BEA_RUNTIME_MODE: "development",
        APP_MODE: "demo",
      }),
    ).toThrow(/cannot be weakened/u);
    expect(() =>
      parseEnvironment({ ...configuredProduction, BEA_RUNTIME_MODE: "development" }),
    ).toThrow(/cannot be weakened/u);
  });

  it("rejects a synthetic provider or identity configured under production application mode", () => {
    for (const override of [
      { DEMO_AUTH_ENABLED: "true" },
      { BEA_AUTH_PROVIDER: "demo" },
      { BEA_DEPLOYMENT_PROFILE: "owner-evaluation" },
    ]) {
      expect(() => parseEnvironment({ ...configuredProduction, ...override })).toThrow();
    }
  });

  it("preserves synthetic fixtures in an explicit isolated test harness", () => {
    vi.stubEnv("NODE_ENV", "test");
    const environment = { NODE_ENV: "test", APP_MODE: "demo" };
    expect(parseEnvironment(environment)).toMatchObject({ runtimeMode: "test", appMode: "demo" });
    expect(() => assertLegacyRuntimeTestOnly(environment)).not.toThrow();
    expect(inspectRuntimeConfiguration(environment).state).toBe("test");
  });

  it("does not treat valid environment variables as completed product readiness", () => {
    expect(inspectRuntimeConfiguration(configuredProduction)).toMatchObject({
      state: "blocked",
      code: "CPL_PRODUCT_RUNTIME_NOT_READY",
    });
  });

  it("does not reveal values from rejected configuration to the public setup screen", () => {
    const rejectedValue = "private-value-must-not-leak";
    const status = inspectRuntimeConfiguration({
      APP_MODE: rejectedValue,
      SESSION_SECRET: rejectedValue,
    });
    expect(JSON.stringify(status)).not.toContain(rejectedValue);
    expect(
      status.issues.every((issue) => issue.message === "Secure configuration is required."),
    ).toBe(true);
  });

  it("refuses a test environment override inside a real production process", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const spoofed = { NODE_ENV: "test", APP_MODE: "demo" };
    expect(() => assertLegacyRuntimeTestOnly(spoofed)).toThrow(ProductRuntimeNotReadyError);
    expect(inspectRuntimeConfiguration(spoofed).state).toBe("blocked");
    await expect(createServerRuntime({ processEnvironment: spoofed })).rejects.toThrow(
      ProductRuntimeNotReadyError,
    );
  });

  it("rejects non-test server startup before finding a repository or constructing storage", async () => {
    await expect(
      createServerRuntime({
        startDirectory: "/unavailable-repository-must-not-be-read",
        processEnvironment: configuredProduction,
      }),
    ).rejects.toThrow(ProductRuntimeNotReadyError);
  });

  it("cannot reuse a previously cached test runtime in a production process", () => {
    const cache = globalThis as unknown as { __beaServerRuntimePromise?: Promise<unknown> };
    const prior = cache.__beaServerRuntimePromise;
    cache.__beaServerRuntimePromise = Promise.resolve({ testOnly: true });
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(() => getServerRuntime({ processEnvironment: configuredProduction })).toThrow(
        ProductRuntimeNotReadyError,
      );
    } finally {
      if (prior) cache.__beaServerRuntimePromise = prior;
      else delete cache.__beaServerRuntimePromise;
    }
  });

  it("blocks a production worker before any database or queue adapter is constructed", async () => {
    const createDatabase = vi.fn();
    const createQueue = vi.fn();
    await expect(
      runWorker([], configuredProduction, undefined, { createDatabase, createQueue }),
    ).rejects.toThrow(ProductRuntimeNotReadyError);
    expect(createDatabase).not.toHaveBeenCalled();
    expect(createQueue).not.toHaveBeenCalled();
  });

  it.each(["seed", "demo-reset"] as const)(
    "blocks the %s command before storage access outside tests",
    async (command) => {
      const createDatabase = vi.fn();
      await expect(
        runDatabaseCommand(
          command,
          {
            NODE_ENV: "development",
            APP_MODE: "demo",
            DEMO_RESET_CONFIRMATION,
          },
          { createDatabase },
        ),
      ).rejects.toThrow(ProductRuntimeNotReadyError);
      expect(createDatabase).not.toHaveBeenCalled();
    },
  );

  it("rejects even a confirmed development-mode reset", () => {
    expect(() =>
      assertDemoResetAllowed({
        appMode: "demo",
        nodeEnv: "development",
        confirmation: DEMO_RESET_CONFIRMATION,
      }),
    ).toThrow(/isolated NODE_ENV=test/u);
  });

  it("refuses direct fixture seeding before any production database write", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const transaction = vi.fn();
    const query = vi.fn();
    await expect(seedDatabase({ transaction } as unknown as DatabaseAdapter)).rejects.toThrow(
      /isolated NODE_ENV=test/u,
    );
    await expect(seedDatabaseOnExecutor({ query } as unknown as SqlExecutor)).rejects.toThrow(
      /isolated NODE_ENV=test/u,
    );
    expect(transaction).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
  it("keeps provider execution blocked at the zero-budget checkpoint", () => {
    expect(() => assertApplicationProviderExecutionAllowed()).toThrow(
      ProductAiActivationRequiredError,
    );
  });

  it.each([
    ["work control", seedWorkControl],
    ["inspection reports", seedInspectionReportCore],
    ["guided story", seedGuidedMeridianExperience],
    ["digital workforce", seedDigitalWorkforce],
    ["configuration", seedConfigurationStudio],
    ["commercial", seedCommercial],
  ] as const)(
    "refuses the direct %s synthetic seed before database writes",
    async (_name, seed) => {
      vi.stubEnv("NODE_ENV", "production");
      const query = vi.fn();
      await expect(seed({ query } as unknown as SqlExecutor)).rejects.toMatchObject({
        code: "CPL_PRODUCT_RUNTIME_NOT_READY",
      });
      expect(query).not.toHaveBeenCalled();
    },
  );

  it("rejects direct synthetic provider activation and reuse outside the test harness", async () => {
    const provider = new DemoStreamingAiProvider();
    const integrations = createDefaultMockProviderRegistry();
    vi.stubEnv("NODE_ENV", "production");
    expect(() => new DemoStreamingAiProvider()).toThrow(/isolated NODE_ENV=test/u);
    expect(() => createDefaultMockProviderRegistry()).toThrow(/isolated NODE_ENV=test/u);
    await expect(provider.testConnection()).rejects.toThrow(/isolated NODE_ENV=test/u);
    await expect(provider.summarize("synthetic input")).rejects.toThrow(/isolated NODE_ENV=test/u);
    await expect(integrations.healthSummary()).rejects.toThrow(/isolated NODE_ENV=test/u);
  });

  it("refuses direct demo sign-in and session reuse before reading identity storage", async () => {
    const findActiveUserByPersonaKey = vi.fn();
    const findSessionByTokenHash = vi.fn();
    const authentication = new DemoAuthenticationAdapter(
      { appMode: "demo", enabled: true, secureCookies: true, sessionTtlMinutes: 15 },
      { findActiveUserByPersonaKey } as unknown as UserDirectory,
      { findSessionByTokenHash } as unknown as SessionStore,
      {} as AuditSink,
    );
    vi.stubEnv("NODE_ENV", "production");
    await expect(authentication.signIn("owner-administrator")).rejects.toThrow(
      /isolated NODE_ENV=test/u,
    );
    await expect(authentication.readSession("synthetic-session")).rejects.toThrow(
      /isolated NODE_ENV=test/u,
    );
    expect(findActiveUserByPersonaKey).not.toHaveBeenCalled();
    expect(findSessionByTokenHash).not.toHaveBeenCalled();
  });
});
