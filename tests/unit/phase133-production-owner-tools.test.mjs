import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createProductionChildEnvironment,
  decideNonOperationalProductionStop,
  inspectProductionEnvironment,
  parsePort,
  redactSensitiveText,
  repositoryRoot,
  validateProductionMetadata,
} from "../../scripts/phase133/production-owner-tools.mjs";
import { collectProductionDoctorReport } from "../../scripts/phase133/production-preflight.mjs";

function source(relativePath) {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function completeSyntheticProductionEnvironment() {
  return {
    APP_BASE_URL: "https://bea.invalid",
    APP_MODE: "production",
    BEA_AUTH_PROVIDER: "microsoft-entra",
    BEA_AUTH_READY: "true",
    BEA_DISABLE_ENV_FILE: "true",
    BEA_OPENAI_SETUP_READY: "true",
    BEA_PRODUCTION_CONTROL_PORT: "33443",
    BEA_RUNTIME_MODE: "production",
    DATABASE_DRIVER: "postgres",
    DATABASE_URL: "postgresql://synthetic.invalid/bea",
    DEMO_AUTH_ENABLED: "false",
    NODE_ENV: "production",
    PORT: "31443",
    SESSION_SECRET: "synthetic-session-value-for-tests-only",
    WORKER_HEALTH_PORT: "32443",
    WORKER_MODE: "serve",
    WORKER_QUEUE_ADAPTER: "pg-boss",
  };
}

describe("Phase 1.3.3 production owner-tool safety contracts", () => {
  it("keeps production command wrappers boundary-first and separate from Demo tooling", () => {
    const expectedEntrypoints = new Map([
      ["BEA-Doctor.cmd", "production-doctor.mjs"],
      ["Start-BEA.cmd", "production-start.mjs"],
      ["Stop-BEA.cmd", "production-stop.mjs"],
    ]);
    for (const [file, entrypoint] of expectedEntrypoints) {
      const text = source(file);
      expect(text).toContain('cd /d "%~dp0"');
      expect(text).toContain('call "%~dp0Ensure-BEA-Toolchain.cmd" --check');
      expect(text).toContain(
        'set "BEA_NODE=%LOCALAPPDATA%\\BEA\\CommandCenter\\toolchain\\node-v24.19.0-win-x64\\node.exe"',
      );
      const boundary = text.indexOf('"%BEA_NODE%" scripts\\repository-boundary.mjs');
      const failFast = text.indexOf("if errorlevel 1 exit /b %errorlevel%", boundary);
      const launch = text.indexOf('"%BEA_NODE%" scripts\\phase134\\' + entrypoint);
      expect(boundary).toBeGreaterThan(-1);
      expect(failFast).toBeGreaterThan(boundary);
      expect(launch).toBeGreaterThan(failFast);
      expect(text).not.toMatch(/Start-BEA-Demo|demo-start|demo-stop|pwsh|powershell/iu);
    }
  });

  it("fails closed until every explicit production readiness contract is satisfied", () => {
    const blocked = inspectProductionEnvironment({});
    expect(blocked.blockers.length).toBeGreaterThan(0);
    expect(blocked.profile).toBeUndefined();
    expect(blocked.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Deployment mode", status: "BLOCKED" }),
        expect.objectContaining({ name: "PostgreSQL configuration", status: "BLOCKED" }),
        expect.objectContaining({ name: "OpenAI setup readiness", status: "BLOCKED" }),
      ]),
    );

    const ready = inspectProductionEnvironment(completeSyntheticProductionEnvironment());
    expect(ready.blockers).toEqual([]);
    expect(ready.profile).toEqual({
      appBaseUrl: "https://bea.invalid",
      controlPort: 33_443,
      webPort: 31_443,
      workerPort: 32_443,
    });
  });

  it("constructs a narrow production child environment without ambient test or Demo controls", () => {
    const child = createProductionChildEnvironment({
      ...completeSyntheticProductionEnvironment(),
      BEA_BROWSER_MEDIA_TEST_MODE: "true",
      DEMO_DATABASE_PATH: "C:\\outside",
      NODE_OPTIONS: "--require hostile.js",
      UNRELATED_SECRET: "must-not-propagate",
    });
    expect(child).toMatchObject({
      APP_MODE: "production",
      BEA_DISABLE_ENV_FILE: "true",
      BEA_RUNTIME_MODE: "production",
      DATABASE_DRIVER: "postgres",
      DEMO_AUTH_ENABLED: "false",
      NODE_ENV: "production",
      WORKER_MODE: "serve",
      WORKER_QUEUE_ADAPTER: "pg-boss",
    });
    expect(child).not.toHaveProperty("BEA_BROWSER_MEDIA_TEST_MODE");
    expect(child).not.toHaveProperty("DEMO_DATABASE_PATH");
    expect(child).not.toHaveProperty("NODE_OPTIONS");
    expect(child).not.toHaveProperty("UNRELATED_SECRET");
  });

  it("validates exact owned metadata and rejects unrelated process identities", () => {
    const valid = {
      controlHost: "127.0.0.1",
      controlPort: 33_443,
      controlToken: "a".repeat(64),
      profile: "production",
      repositoryRoot,
      state: "ready",
      supervisorPid: 12_345,
      version: 1,
      webPort: 31_443,
      workerPort: 32_443,
    };
    expect(validateProductionMetadata(valid)).toEqual({ issues: [], metadata: valid });
    expect(
      validateProductionMetadata({ ...valid, repositoryRoot: "C:\\unrelated" }).issues,
    ).not.toEqual([]);
    expect(validateProductionMetadata({ ...valid, controlToken: "invalid" }).issues).not.toEqual(
      [],
    );
    expect(validateProductionMetadata({ ...valid, supervisorPid: -1 }).issues).not.toEqual([]);
    expect(parsePort("65535")).toBe(65_535);
    expect(parsePort("0")).toBeUndefined();
  });

  it("runs the complete Doctor decision model with stubbed ports and process state", async () => {
    let portChecks = 0;
    const report = await collectProductionDoctorReport({
      architecture: "x64",
      assertBoundary: () => ({ current: repositoryRoot, target: repositoryRoot }),
      checkPort: async () => {
        portChecks += 1;
        return { available: true };
      },
      environment: completeSyntheticProductionEnvironment(),
      fileExists: () => true,
      gitCommand: "synthetic-git.exe",
      gitVersionResult: { exitCode: 0, stderr: "", stdout: "git version 2.test" },
      inspectTracked: async () => ({ state: "stopped" }),
      nodeVersion: "v24.19.0",
      platform: "win32",
      pnpmCommand: "synthetic-pnpm.cmd",
      pnpmVersionResult: { exitCode: 0, stderr: "", stdout: "11.19.0" },
    });
    expect(report.blockers).toEqual([]);
    expect(portChecks).toBe(3);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Tracked production runtime", status: "STOPPED" }),
        expect.objectContaining({
          name: "PostgreSQL and pg-boss connectivity",
          status: "NOT RUN",
        }),
        expect.objectContaining({
          name: "External provider and owner acceptance",
          status: "NOT RUN",
        }),
      ]),
    );
  });

  it("does not probe ports when the production profile is invalid", async () => {
    let portChecks = 0;
    const report = await collectProductionDoctorReport({
      architecture: "x64",
      assertBoundary: () => ({ current: repositoryRoot, target: repositoryRoot }),
      checkPort: async () => {
        portChecks += 1;
        return { available: true };
      },
      environment: {},
      fileExists: () => true,
      gitCommand: "synthetic-git.exe",
      gitVersionResult: { exitCode: 0, stderr: "", stdout: "git version 2.test" },
      inspectTracked: async () => ({ state: "stopped" }),
      nodeVersion: "v24.19.0",
      platform: "win32",
      pnpmCommand: "synthetic-pnpm.cmd",
      pnpmVersionResult: { exitCode: 0, stderr: "", stdout: "11.19.0" },
    });
    expect(report.blockers.length).toBeGreaterThan(0);
    expect(portChecks).toBe(0);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "Port availability", status: "NOT RUN" }),
    );
  });

  it("keeps Start-BEA explicitly BLOCKED and NOT RUN instead of activating services", () => {
    const start = source("scripts/phase133/production-start.mjs");
    expect(start).toContain("Production process activation remains NOT RUN");
    expect(start).toContain("no process was started");
    expect(start).toContain("BEA_PRODUCTION_START=BLOCKED");
    expect(start).not.toMatch(/spawn\(|db:migrate|start:web|start:worker|openInDefaultBrowser/iu);
  });

  it("executes the pure Stop-BEA ALREADY_STOPPED decision without process access", () => {
    const decision = decideNonOperationalProductionStop({ state: "stopped" });
    expect(decision).toEqual({
      action: "none",
      exitCode: 0,
      marker: "BEA_PRODUCTION_STOP=ALREADY_STOPPED",
      message: "BEA production runtime is already stopped; no metadata is present.",
      outcome: "ALREADY_STOPPED",
      processAccessRequired: false,
    });
    expect(Object.isFrozen(decision)).toBe(true);
    expect(`${decision.message}\n${decision.marker}`).toContain(
      "BEA_PRODUCTION_STOP=ALREADY_STOPPED",
    );

    for (const tracked of [undefined, {}, { state: "running" }, { state: "stale" }]) {
      expect(decideNonOperationalProductionStop(tracked)).toMatchObject({
        action: "block",
        exitCode: 1,
        marker: "BEA_PRODUCTION_STOP=BLOCKED",
        outcome: "BLOCKED",
        processAccessRequired: false,
      });
    }

    const stop = source("scripts/phase133/production-stop.mjs");
    expect(stop).not.toMatch(/taskkill|Stop-Process|Get-Process|wmic|kill\s+\//iu);
  });

  it("redacts synthetic protected values from owner-tool failures", () => {
    const environment = {
      DATABASE_URL: "synthetic-database-value",
      OPENAI_API_KEY: "synthetic-openai-value",
      SESSION_SECRET: "synthetic-session-value",
    };
    const redacted = redactSensitiveText(Object.values(environment).join(" | "), environment);
    expect(redacted).not.toContain("synthetic-database-value");
    expect(redacted).not.toContain("synthetic-openai-value");
    expect(redacted).not.toContain("synthetic-session-value");
    expect(redacted).toContain("[REDACTED_DATABASE_URL]");
    expect(redacted).toContain("[REDACTED_OPENAI_API_KEY]");
    expect(redacted).toContain("[REDACTED_SESSION_SECRET]");
  });
});
