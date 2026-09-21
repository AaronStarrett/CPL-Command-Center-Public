import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  PHASE1_3_3_INTENDED_FILES,
  assertExactPhase1_3_3StagedPaths,
  findForbiddenPhase1_3_3Paths,
  normalizePhase1_3_3Path,
  reconcilePhase1_3_3StagedPaths,
} from "../../scripts/phase1-3-3-intended-files.mjs";
import {
  PHASE1_3_3_GATE_DEFINITIONS,
  PHASE1_3_3_STARTING_COMMIT,
  PHASE1_3_3_VERIFIED_NODE_VERSION,
  PHASE1_3_3_VERIFIED_PNPM_VERSION,
  assertPhase1_3_3StagedState,
  assertPhase1_3_3StartingState,
  assertPhase1_3_3ToolchainVersions,
  createPhase1_3_3VerificationEnvironment,
  inspectPhase1_3_3StagedState,
  phase1_3_3SafetyOutcomes,
} from "../../scripts/verify-phase1-3-3.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

function source(relativePath) {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

describe("Phase 1.3.3 deterministic verifier contract", () => {
  it("defines the exact 38 ordered quality-gate categories", () => {
    expect(PHASE1_3_3_GATE_DEFINITIONS).toHaveLength(38);
    expect(PHASE1_3_3_GATE_DEFINITIONS.map(([number]) => number)).toEqual(
      Array.from({ length: 38 }, (_, index) => index + 1),
    );
    expect(PHASE1_3_3_GATE_DEFINITIONS.map(([, name]) => name)).toEqual([
      "Repository boundary",
      "Starting commit",
      "Source integrity",
      "Format",
      "Format check",
      "Lint",
      "Typecheck",
      "Left-scroll unit/component tests",
      "Orb fade/translucency tests",
      "Right-scroll renderer tests",
      "Long-content browser tests",
      "Production-mode tests",
      "Test-provider isolation",
      "Secret-store tests",
      "Connection-wizard tests",
      "Model-discovery tests",
      "Capability-registry tests",
      "Model-routing tests",
      "File Search route tests",
      "Document/PDF route tests",
      "Data/chart route tests",
      "Image-generation route tests",
      "Realtime model/voice tests",
      "Voice spoken-response tests",
      "Persona preservation tests",
      "Artifact-brand preservation tests",
      "Production build",
      "Production browser acceptance",
      "Realtime fake-media acceptance",
      "PDF.js regression",
      "Task-action regression",
      "Windows Doctor",
      "Start-BEA",
      "Stop-BEA",
      "Dependency audit",
      "Secret scan",
      "Inventory reconciliation",
      "Git status",
    ]);
  });

  it("fails closed on any drift from the exact toolchain checkpoint or branch", () => {
    expect(PHASE1_3_3_VERIFIED_NODE_VERSION).toBe("24.19.0");
    expect(PHASE1_3_3_VERIFIED_PNPM_VERSION).toBe("11.19.0");
    expect(PHASE1_3_3_STARTING_COMMIT).toBe("6a67c6da5a6a765a79cc49d134158c644768a3b4");
    expect(() => assertPhase1_3_3ToolchainVersions("24.19.0", "11.19.0")).not.toThrow();
    expect(() => assertPhase1_3_3ToolchainVersions("20.12.2", "11.19.0")).toThrow(
      /exact Node 24\.19\.0/u,
    );
    expect(() => assertPhase1_3_3ToolchainVersions("24.19.0", "11.18.0")).toThrow(
      /exact pnpm 11\.19\.0/u,
    );
    expect(() => assertPhase1_3_3StartingState(PHASE1_3_3_STARTING_COMMIT, "main")).not.toThrow();
    expect(() => assertPhase1_3_3StartingState("f".repeat(40), "main")).toThrow(/starting HEAD/u);
    expect(() =>
      assertPhase1_3_3StartingState(PHASE1_3_3_STARTING_COMMIT, "feature/interim"),
    ).toThrow(/requires branch main/u);
  });

  it("spawns commands from a strict safe allowlist and clears ambient runtime controls", () => {
    const environment = createPhase1_3_3VerificationEnvironment({
      BEA_RUNTIME_MODE: "production",
      DATABASE_URL: "must-not-propagate",
      HOME: "must-not-propagate",
      NODE_OPTIONS: "--require hostile.js",
      OPENAI_API_KEY: "must-not-propagate",
      PATH: "C:\\verified-bin",
      SESSION_SECRET: "must-not-propagate",
      UNRELATED_SECRET: "must-not-propagate",
    });
    expect(environment).toMatchObject({
      APP_BASE_URL: "http://127.0.0.1:3134",
      APP_MODE: "demo",
      BEA_DISABLE_ENV_FILE: "true",
      BEA_RUNTIME_MODE: "",
      NODE_ENV: "test",
      OPENAI_API_KEY: "",
      PATH: "C:\\verified-bin",
      WORKER_HEALTH_PORT: "3135",
    });
    expect(environment).not.toHaveProperty("DATABASE_URL");
    expect(environment).not.toHaveProperty("HOME");
    expect(environment).not.toHaveProperty("SESSION_SECRET");
    expect(environment).not.toHaveProperty("UNRELATED_SECRET");
    expect(environment.NODE_OPTIONS).toBe("--trace-warnings");
  });

  it("normalizes and reconciles one exact staged-path manifest", () => {
    expect(new Set(PHASE1_3_3_INTENDED_FILES).size).toBe(PHASE1_3_3_INTENDED_FILES.length);
    expect(normalizePhase1_3_3Path(".\\tests\\unit\\phase133-verifier.test.mjs")).toBe(
      "tests/unit/phase133-verifier.test.mjs",
    );
    expect(findForbiddenPhase1_3_3Paths(PHASE1_3_3_INTENDED_FILES)).toEqual([]);
    expect(reconcilePhase1_3_3StagedPaths(PHASE1_3_3_INTENDED_FILES)).toEqual({
      duplicates: [],
      forbidden: [],
      missing: [],
      unexpected: [],
    });
    expect(() => assertExactPhase1_3_3StagedPaths(PHASE1_3_3_INTENDED_FILES)).not.toThrow();

    const missing = PHASE1_3_3_INTENDED_FILES.slice(1);
    expect(() => assertExactPhase1_3_3StagedPaths(missing)).toThrow(/missing=/u);
    expect(() =>
      assertExactPhase1_3_3StagedPaths([...PHASE1_3_3_INTENDED_FILES, ".data/runtime.log"]),
    ).toThrow(/forbidden=.*\.data\/runtime\.log/u);
    expect(() =>
      assertExactPhase1_3_3StagedPaths([
        ...PHASE1_3_3_INTENDED_FILES,
        PHASE1_3_3_INTENDED_FILES[0],
      ]),
    ).toThrow(/duplicates=/u);
  });

  it("parses staged state without shell use and rejects unstaged or untracked paths", () => {
    const calls = [];
    const state = inspectPhase1_3_3StagedState((command, arguments_) => {
      calls.push([command, arguments_]);
      const joined = arguments_.join(" ");
      if (joined.includes("diff --cached --name-only -z")) {
        return `${PHASE1_3_3_INTENDED_FILES.join("\0")}\0`;
      }
      return "";
    });
    expect(state).toEqual({
      stagedPaths: PHASE1_3_3_INTENDED_FILES,
      unstagedPaths: [],
      untrackedPaths: [],
      whitespace: "",
    });
    expect(calls).toHaveLength(4);
    expect(calls.every(([command]) => command === "git")).toBe(true);
    expect(calls.every(([, arguments_]) => arguments_[0] === "-c")).toBe(true);
    expect(() => assertPhase1_3_3StagedState(state)).not.toThrow();
    expect(() =>
      assertPhase1_3_3StagedState({ ...state, unstagedPaths: ["package.json"] }),
    ).toThrow(/unstaged paths/u);
    expect(() =>
      assertPhase1_3_3StagedState({ ...state, untrackedPaths: ["unexpected.txt"] }),
    ).toThrow(/untracked paths/u);
  });

  it("keeps the aggregate non-operational and records explicit safe launcher outcomes", () => {
    const verifier = source("scripts/verify-phase1-3-3.mjs");
    expect(phase1_3_3SafetyOutcomes()).toEqual({
      doctor: "BLOCKED_READ_ONLY",
      liveProviderAcceptance: "NOT_RUN",
      ownerAcceptance: "NOT_RUN",
      productionStart: "BLOCKED_NOT_RUN",
      productionStop: "ALREADY_STOPPED_STATIC_CONTRACT",
    });
    expect(verifier).not.toMatch(/db:migrate|db:seed|Start-BEA-Demo|Stop-BEA-Demo/iu);
    expect(verifier).toContain('"BEA_PRODUCTION_START=BLOCKED"');
    expect(verifier).toContain("Expected BLOCKED/NOT RUN result");
    expect(verifier).toContain(
      "Pure fail-closed ALREADY_STOPPED decision produced BEA_PRODUCTION_STOP=ALREADY_STOPPED",
    );
    expect(verifier).not.toMatch(/commandGate\(34,|expectedCommandGate\(34,/u);
  });

  it("checks the exact staged manifest before formatting and repeats it at Gate 38", () => {
    const verifier = source("scripts/verify-phase1-3-3.mjs");
    const sourceGate = verifier.indexOf("commandGate(3");
    const initialManifest = verifier.indexOf("PHASE1_3_3_INITIAL_STAGED_MANIFEST=PASS");
    const formatGate = verifier.indexOf("pnpmGate(4");
    const finalManifest = verifier.indexOf("customGate(\n      38");
    expect(sourceGate).toBeGreaterThan(-1);
    expect(initialManifest).toBeGreaterThan(sourceGate);
    expect(formatGate).toBeGreaterThan(initialManifest);
    expect(finalManifest).toBeGreaterThan(formatGate);
  });

  it("includes the isolated production-presentation browser harness in Gate 28", () => {
    const verifier = source("scripts/verify-phase1-3-3.mjs");
    expect(verifier).toContain("sequenceGate(28");
    expect(verifier).toContain("--config=playwright.phase133-presentation.config.ts");
    expect(verifier).toContain(
      "tests/component/phase133-production-presentation-server-boundary.test.ts",
    );
  });

  it("emits the authoritative PASS marker from only the all-gates-pass branch", () => {
    const verifier = source("scripts/verify-phase1-3-3.mjs");
    expect(verifier.match(/PHASE1_3_3_VERIFICATION=PASS/gu)).toHaveLength(1);
    expect(verifier).toContain(
      'const passed = !terminalError && results.every((result) => result.result === "PASS")',
    );
    expect(verifier).toContain('process.stdout.write("PHASE1_3_3_VERIFICATION=FAIL\\n")');
  });

  it("publishes only the new production and verification package commands", () => {
    const packageManifest = JSON.parse(source("package.json"));
    expect(packageManifest.scripts).toMatchObject({
      "ops:production:doctor": "node scripts/phase133/production-preflight.mjs --check",
      "ops:production:start": "node scripts/phase133/production-start.mjs",
      "ops:production:stop": "node scripts/phase133/production-stop.mjs",
      "verify:phase1.3.3": "node scripts/verify-phase1-3-3.mjs",
    });
  });
});
