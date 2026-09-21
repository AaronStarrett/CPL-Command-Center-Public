import { describe, expect, it } from "vitest";
import { EnvironmentValidationError, parseEnvironment } from "../../packages/config/src/index.js";

const localLiveEnvironment = {
  NODE_ENV: "production",
  APP_MODE: "production",
  BEA_DEPLOYMENT_PROFILE: "local-live",
  BEA_AUTH_PROVIDER: "local-owner",
  APP_BASE_URL: "https://bea.localhost:3443",
  DATABASE_DRIVER: "postgres",
  DATABASE_URL: "postgresql://bea.invalid/command_center",
  DEMO_AUTH_ENABLED: "false",
  SESSION_SECRET: "phase134-local-live-session-secret-".padEnd(80, "x"),
  WORKER_MODE: "serve",
  WORKER_QUEUE_ADAPTER: "pg-boss",
  WORKER_HEALTH_PORT: "3001",
} as const;

describe("Phase 1.3.4 Local Live environment", () => {
  it("selects Local Owner only for production HTTPS loopback", () => {
    expect(parseEnvironment(localLiveEnvironment)).toMatchObject({
      runtimeMode: "production",
      appMode: "production",
      deploymentProfile: "local-live",
      authProvider: "local-owner",
      secureCookies: true,
      databaseDriver: "postgres",
      workerMode: "serve",
      workerQueueAdapter: "pg-boss",
      demoAuthEnabled: false,
    });
  });

  it.each([
    ["non-loopback", { APP_BASE_URL: "https://bea.example.com" }],
    ["plaintext", { APP_BASE_URL: "http://bea.localhost:3000" }],
    ["weak session secret", { SESSION_SECRET: "x".repeat(32) }],
    ["Demo authentication", { DEMO_AUTH_ENABLED: "true" }],
    ["one-shot worker", { WORKER_MODE: "once" }],
    ["wrong provider", { BEA_AUTH_PROVIDER: "microsoft-entra" }],
  ])("rejects %s Local Live configuration", (_label, override) => {
    expect(() => parseEnvironment({ ...localLiveEnvironment, ...override })).toThrow(
      EnvironmentValidationError,
    );
  });

  it("defaults production enterprise deployments to Microsoft Entra", () => {
    const environment = parseEnvironment({
      ...localLiveEnvironment,
      BEA_DEPLOYMENT_PROFILE: "enterprise",
      BEA_AUTH_PROVIDER: "microsoft-entra",
      APP_BASE_URL: "https://command-center.example.com",
      SESSION_SECRET: "production-session-secret-32chars",
    });
    expect(environment).toMatchObject({
      deploymentProfile: "enterprise",
      authProvider: "microsoft-entra",
      demoAuthEnabled: false,
    });
  });
});
