import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  PHASE1_3_4_BASE_COMMIT,
  PHASE1_3_4_INTENDED_FILES,
  assertExactPhase1_3_4StagedPaths,
  findForbiddenPhase1_3_4Paths,
  normalizePhase1_3_4Path,
  reconcilePhase1_3_4StagedPaths,
} from "../../scripts/phase1-3-4-intended-files.mjs";
import {
  PHASE1_3_4_GATE_DEFINITIONS,
  PHASE1_3_4_STARTING_COMMIT,
  PHASE1_3_4_VERIFIED_NODE_VERSION,
  PHASE1_3_4_VERIFIED_PNPM_VERSION,
  assertPhase1_3_4StagedState,
  assertPhase1_3_4StartingState,
  assertPhase1_3_4ToolchainVersions,
  createPhase1_3_4VerificationEnvironment,
  inspectPhase1_3_4StagedState,
  phase1_3_4ExternalEvidenceDefaults,
} from "../../scripts/verify-phase1-3-4.mjs";

const expectedGateNames = [
  "Repository boundary",
  "Starting commit",
  "Source integrity",
  "Toolchain bootstrap tests",
  "Node checksum tests",
  "pnpm isolation tests",
  "Format",
  "Format check",
  "Lint",
  "Typecheck",
  "Config-store tests",
  "Secret-store tests",
  "HTTPS/certificate tests",
  "Port-management tests",
  "Deployment-profile tests",
  "Local Owner authentication tests",
  "Session-security tests",
  "PostgreSQL adapter tests",
  "Real PostgreSQL integration gate",
  "Production migrations",
  "System-seed/no-demo-data tests",
  "pg-boss tests",
  "Supervisor ownership tests",
  "Start-BEA tests",
  "Stop-BEA tests",
  "Doctor tests",
  "Build-freshness tests",
  "OpenAI setup-required startup test",
  "OpenAI configuration regression",
  "Model-routing regression",
  "Realtime regression",
  "Two-tile UX regression",
  "Conversation/workspace scroll regression",
  "PDF.js regression",
  "Production build",
  "Production browser acceptance",
  "Backup/restore test",
  "Dependency audit",
  "Secret scan",
  "Inventory reconciliation",
  "Git status",
];
const packageScripts = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).scripts;

describe("Phase 1.3.4 authoritative verifier contract", () => {
  it("keeps the exact ordered 41-gate quality ledger", () => {
    expect(PHASE1_3_4_GATE_DEFINITIONS).toEqual(
      expectedGateNames.map((name, index) => [index + 1, name]),
    );
  });

  it("exposes the authoritative verifier through the root package", () => {
    expect(packageScripts["verify:phase1.3.4"]).toBe("node scripts/verify-phase1-3-4.mjs");
  });

  it("requires the exact verified toolchain versions", () => {
    expect(() =>
      assertPhase1_3_4ToolchainVersions(
        `v${PHASE1_3_4_VERIFIED_NODE_VERSION}`,
        PHASE1_3_4_VERIFIED_PNPM_VERSION,
      ),
    ).not.toThrow();
    expect(() => assertPhase1_3_4ToolchainVersions("20.12.2", "11.19.0")).toThrow(
      /exact Node 24\.19\.0/u,
    );
    expect(() => assertPhase1_3_4ToolchainVersions("24.19.0", "11.18.0")).toThrow(
      /exact pnpm 11\.19\.0/u,
    );
  });

  it("retains the starting checkpoint as an ancestor on main", () => {
    expect(() =>
      assertPhase1_3_4StartingState({
        branch: "main",
        startingCommitPresent: true,
        startingCommitIsAncestor: true,
        startingMessage: "feat: activate production AI routing and refine scrollable BEA cockpit",
      }),
    ).not.toThrow();
    expect(PHASE1_3_4_STARTING_COMMIT).toBe("c99b9e6b9b72e14365b722aa9022a431ebabb827");
  });

  it("drops provider/database secrets and keeps external evidence separate", () => {
    const environment = createPhase1_3_4VerificationEnvironment({
      LOCALAPPDATA: "C:\\Users\\owner\\AppData\\Local",
      OPENAI_API_KEY: "must-not-survive",
      DATABASE_URL: "must-not-survive",
      BEA_PHASE134_REAL_POSTGRES_URL: "must-not-survive",
    });
    expect(environment.OPENAI_API_KEY).toBe("");
    expect(environment.DATABASE_URL).toBe("");
    expect(environment.BEA_PHASE134_REAL_POSTGRES_URL).toBeUndefined();
    expect(environment.PATH.split(path.delimiter)[0]).toBe(path.dirname(process.execPath));
    expect(environment.Path).toBe(environment.PATH);
    expect(phase1_3_4ExternalEvidenceDefaults()).toEqual({
      machineConfiguration: "NOT_RUN",
      ownerLiveOpenAi: "NOT_RUN",
      ownerAcceptance: "NOT_RUN",
      browserProfile: "TEST_ONLY",
      realPostgres: "OWNER_PREREQUISITE_REQUIRED",
    });
  });

  it("reconciles the exact 142-path cumulative Phase 1.3.4 intended-files manifest", () => {
    expect(PHASE1_3_4_BASE_COMMIT).toBe(PHASE1_3_4_STARTING_COMMIT);
    expect(PHASE1_3_4_INTENDED_FILES).toHaveLength(142);
    expect(new Set(PHASE1_3_4_INTENDED_FILES).size).toBe(PHASE1_3_4_INTENDED_FILES.length);
    expect(normalizePhase1_3_4Path(".\\tests\\unit\\phase134-verifier.test.mjs")).toBe(
      "tests/unit/phase134-verifier.test.mjs",
    );
    expect(findForbiddenPhase1_3_4Paths(PHASE1_3_4_INTENDED_FILES)).toEqual([]);
    expect(reconcilePhase1_3_4StagedPaths(PHASE1_3_4_INTENDED_FILES)).toEqual({
      duplicates: [],
      forbidden: [],
      missing: [],
      unexpected: [],
    });
    expect(() => assertExactPhase1_3_4StagedPaths(PHASE1_3_4_INTENDED_FILES)).not.toThrow();

    const gitInvocations = [];
    const stagedState = inspectPhase1_3_4StagedState((command, arguments_) => {
      gitInvocations.push([command, ...arguments_]);
      return arguments_.includes(PHASE1_3_4_BASE_COMMIT)
        ? `${PHASE1_3_4_INTENDED_FILES.join("\0")}\0`
        : "";
    });
    expect(gitInvocations[0]).toEqual([
      "git",
      "-c",
      expect.stringContaining("safe.directory="),
      "diff",
      "--cached",
      "--name-only",
      "-z",
      PHASE1_3_4_BASE_COMMIT,
    ]);
    expect(() => assertPhase1_3_4StagedState(stagedState)).not.toThrow();

    expect(() => assertExactPhase1_3_4StagedPaths(PHASE1_3_4_INTENDED_FILES.slice(1))).toThrow(
      /missing=/u,
    );
    expect(() =>
      assertExactPhase1_3_4StagedPaths([
        ...PHASE1_3_4_INTENDED_FILES,
        "logs/phase134-production.log",
      ]),
    ).toThrow(/forbidden=.*logs\/phase134-production\.log/u);
    expect(() =>
      assertExactPhase1_3_4StagedPaths([
        ...PHASE1_3_4_INTENDED_FILES,
        PHASE1_3_4_INTENDED_FILES[0],
      ]),
    ).toThrow(/duplicates=/u);
  });
});
