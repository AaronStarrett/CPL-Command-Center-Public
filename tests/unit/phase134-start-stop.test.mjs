import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createSupervisorEnvironment,
  decideStartFromTrackedState,
  startProduction,
} from "../../scripts/phase134/production-start.mjs";
import { decideStopFromTrackedState } from "../../scripts/phase134/production-stop.mjs";
import { createProductionPaths } from "../../scripts/phase134/production-paths.mjs";

const metadata = { supervisorPid: 42, ports: {} };

describe("Phase 1.3.4 Start/Stop contracts", () => {
  it("injects exact production modes and protected values without inheriting Demo or OpenAI overrides", () => {
    const environment = createSupervisorEnvironment(
      {
        appBaseUrl: "https://bea.localhost:3443",
        deploymentProfile: "local-live",
        database: { tlsMode: "prefer" },
        authentication: { provider: "local-owner" },
        ports: { workerHealth: 3211 },
      },
      {
        sessionSecret: "s".repeat(86),
        databaseUrl: "postgresql://user:password@127.0.0.1:5433/bea",
        httpsPfxPassword: "p".repeat(48),
        controlToken: "a".repeat(64),
        openAiApiKey: "must-not-enter-supervisor-environment",
      },
      {
        configFile: "C:\\BEA\\config\\production.json",
        runtimeMetadataFile: "C:\\BEA\\runtime\\production-process.json",
        secretFile: "C:\\BEA\\secrets\\production-secrets.dpapi.json",
      },
      { PATH: "C:\\BEA\\toolchain" },
    );
    expect(environment).toMatchObject({
      APP_MODE: "production",
      BEA_RUNTIME_MODE: "production",
      NODE_ENV: "production",
      BEA_DISABLE_ENV_FILE: "true",
      DEMO_AUTH_ENABLED: "false",
      DATABASE_DRIVER: "postgres",
      WORKER_QUEUE_ADAPTER: "pg-boss",
      WORKER_MODE: "serve",
      BEA_AUTH_PROVIDER: "local-owner",
    });
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(environment.DATABASE_URL).toContain("sslmode=prefer");
    expect(JSON.stringify(environment)).not.toContain("must-not-enter-supervisor-environment");
  });

  it("starts only from absent or validated-stale metadata", () => {
    expect(decideStartFromTrackedState({ exists: false }, false)).toEqual({ action: "start" });
    expect(decideStartFromTrackedState({ exists: true, metadata }, false)).toEqual({
      action: "remove-stale",
      metadata,
    });
    expect(decideStartFromTrackedState({ exists: true, metadata }, true)).toEqual({
      action: "authenticate",
      metadata,
    });
    expect(decideStartFromTrackedState({ exists: true, issues: ["invalid"] }, false)).toEqual({
      action: "block",
      message: "invalid",
    });
  });

  it("stops only through authenticated live metadata and treats absent/stale state honestly", () => {
    expect(decideStopFromTrackedState({ exists: false }, false)).toEqual({
      action: "already-stopped",
    });
    expect(decideStopFromTrackedState({ exists: true, metadata }, false)).toEqual({
      action: "clean-stale",
      metadata,
    });
    expect(decideStopFromTrackedState({ exists: true, metadata }, true)).toEqual({
      action: "authenticate-stop",
      metadata,
    });
  });

  it("leaves the lifetime lock owned by the supervisor after readiness", async () => {
    const localAppData = mkdtempSync(join(tmpdir(), "bea-start-lifetime-lock-"));
    const paths = createProductionPaths({ localAppData });
    const supervisorPid = 4242;
    let metadataReads = 0;
    const config = {
      appBaseUrl: "https://bea.localhost:3443",
      deploymentProfile: "local-live",
      database: { tlsMode: "prefer" },
      authentication: { provider: "local-owner" },
      ports: { workerHealth: 3211 },
    };
    const result = await startProduction(
      { noOpen: true },
      {
        paths,
        platform: "win32",
        nodeVersion: "v24.19.0",
        assertBoundary: () => undefined,
        readConfig: () => config,
        readSecrets: () => ({
          sessionSecret: "s".repeat(86),
          databaseUrl: "postgresql://bea:secret@127.0.0.1:5433/bea",
          httpsPfxPassword: "p".repeat(48),
          controlToken: "a".repeat(64),
        }),
        readMetadata: () => {
          metadataReads += 1;
          return metadataReads === 1
            ? { exists: false }
            : { exists: true, metadata: { supervisorPid } };
        },
        collectDoctor: async () => ({ startBlockers: [] }),
        spawn: (_command, _arguments, options) => {
          writeFileSync(paths.runtimeLockFile, "supervisor-owned-lifetime-lock\n");
          expect(options.env.BEA_PRODUCTION_LOCK_PATH).toBe(paths.runtimeLockFile);
          return { pid: supervisorPid, unref() {} };
        },
        processIsAlive: () => true,
        controlRequest: async () => ({ ok: true, body: { state: "ready" } }),
        waitFor: async (check) => check(),
      },
    );
    expect(result).toEqual({ outcome: "PASS", supervisorPid });
    expect(existsSync(paths.runtimeLockFile)).toBe(true);
  });
});
