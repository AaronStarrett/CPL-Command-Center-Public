import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  controlPort,
  createDemoChildEnvironment,
  inspectDemoEnvironment,
  readLocalEnvironment,
  repositoryRoot,
  validateMetadata,
  webPort,
  workerPort,
} from "../../scripts/owner-tools-common.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const expectedRoot = path.resolve(testDirectory, "../..");

function source(relativePath) {
  return readFileSync(path.join(expectedRoot, relativePath), "utf8");
}

describe("Windows owner tooling safety contracts", () => {
  it("keeps all command wrappers boundary-first and independent of PowerShell scripts", () => {
    for (const [file, nodeCommand, entrypoint] of [
      ["BEA-Doctor.cmd", '"%BEA_NODE%"', "scripts\\phase134\\production-doctor.mjs"],
      ["Start-BEA-Demo.cmd", "node", "scripts\\demo-start.mjs"],
      ["Stop-BEA-Demo.cmd", "node", "scripts\\demo-stop.mjs"],
    ]) {
      const text = source(file);
      expect(text).toContain('cd /d "%~dp0"');
      const boundary = text.indexOf(nodeCommand + " scripts\\repository-boundary.mjs");
      const failFast = text.indexOf("if errorlevel 1 exit /b %errorlevel%", boundary);
      const launch = text.indexOf(nodeCommand + " " + entrypoint);
      expect(boundary).toBeGreaterThan(-1);
      expect(failFast).toBeGreaterThan(boundary);
      expect(launch).toBeGreaterThan(failFast);
      expect(text).not.toMatch(/pwsh|powershell|pnpm\.ps1|executionpolicy/iu);
    }
  });

  it("never inspects the owner env file when the authoritative hard-disable is active", () => {
    const previous = process.env.BEA_DISABLE_ENV_FILE;
    process.env.BEA_DISABLE_ENV_FILE = "true";
    let touches = 0;
    const forbiddenAccess = () => {
      touches += 1;
      throw new Error("owner env sentinel touched");
    };
    try {
      const local = readLocalEnvironment({
        fileExists: forbiddenAccess,
        processEnvironment: {},
        readFile: forbiddenAccess,
      });
      const inspection = inspectDemoEnvironment({
        fileExists: forbiddenAccess,
        processEnvironment: {},
        readFile: forbiddenAccess,
      });
      expect(local).toMatchObject({ disabled: true, exists: false });
      expect(inspection).toMatchObject({
        localEnvironmentExists: false,
        localEnvironmentInspectionDisabled: true,
      });
      expect(touches).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.BEA_DISABLE_ENV_FILE;
      else process.env.BEA_DISABLE_ENV_FILE = previous;
    }
  });

  it("forces every owner-launched child into Demo mode without env-file or key propagation", () => {
    const child = createDemoChildEnvironment({
      BEA_DISABLE_ENV_FILE: "false",
      OPENAI_API_KEY: ["sk", "owner", "must", "not", "propagate"].join("-"),
      PATH: process.env.PATH,
    });
    expect(child).toMatchObject({
      APP_MODE: "demo",
      BEA_DISABLE_ENV_FILE: "true",
      OPENAI_API_KEY: "",
    });
  });

  it("always migrates while keeping deterministic seeding conditional", () => {
    const text = source("scripts/demo-start.mjs");
    const initialization = text.indexOf("const shouldSeed");
    const migration = text.indexOf('["db:migrate"]', initialization);
    const seedCondition = text.indexOf("if (shouldSeed)", migration);
    const seed = text.indexOf('["db:seed"]', seedCondition);
    expect(initialization).toBeGreaterThan(-1);
    expect(migration).toBeGreaterThan(initialization);
    expect(seedCondition).toBeGreaterThan(migration);
    expect(seed).toBeGreaterThan(seedCondition);
    expect(text).toContain("report.pnpmCommand");
    expect(text).not.toMatch(/Set-ExecutionPolicy|Install-Module|winget|choco/iu);
  });

  it("tracks an authenticated canonical supervisor identity", () => {
    expect(repositoryRoot.toLocaleLowerCase("en-US")).toBe(expectedRoot.toLocaleLowerCase("en-US"));
    const valid = {
      version: 1,
      repositoryRoot,
      supervisorPid: process.pid,
      controlHost: "127.0.0.1",
      controlPort,
      controlToken: "a".repeat(64),
      webPort,
      workerPort,
      state: "ready",
    };
    expect(validateMetadata(valid)).toMatchObject({ issues: [], metadata: valid });
    expect(validateMetadata({ ...valid, repositoryRoot: "C:\\unrelated" }).issues).not.toEqual([]);
    expect(validateMetadata({ ...valid, controlToken: "not-a-token" }).issues).not.toEqual([]);
    expect(validateMetadata({ ...valid, supervisorPid: -1 }).issues).not.toEqual([]);
  });

  it("stops only supervisor-owned child handles without broad process commands", () => {
    const stop = source("scripts/demo-stop.mjs");
    const supervisor = source("scripts/demo-supervisor.mjs");
    const combined = `${stop}\n${supervisor}`;
    expect(stop).toContain('controlRequest(tracked.metadata, "/stop"');
    expect(supervisor).toContain("terminateExactChild(webChild");
    expect(supervisor).toContain("terminateExactChild(workerChild");
    expect(combined).not.toMatch(/taskkill|Stop-Process|Get-Process|wmic/iu);
  });

  it.skipIf(process.platform !== "win32")(
    "passes the non-mutating owner start prerequisite check through cmd.exe",
    () => {
      const result = spawnSync("cmd.exe", ["/d", "/c", "Start-BEA-Demo.cmd", "--check"], {
        cwd: expectedRoot,
        encoding: "utf8",
        timeout: 60_000,
        windowsHide: true,
      });
      expect([0, 1], `${result.stdout}\n${result.stderr}`).toContain(result.status);
      expect(result.stdout).toMatch(/BEA_DEMO_START_CHECK=(?:PASS|BLOCKED)/u);
      expect(result.stdout).toContain("pnpm.cmd");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("[DEP0190]");
      if (result.status === 1) {
        expect(result.stdout).toContain("is occupied (EADDRINUSE)");
        expect(result.stdout).toContain("BEA_DOCTOR=BLOCKED");
      }
    },
  );
});
