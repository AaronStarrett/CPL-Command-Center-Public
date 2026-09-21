import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { scanOwnerAcceptancePackage } from "../../scripts/phase21/scan-windows-owner-package.mjs";
import {
  CANONICAL_EXTRACTION_PATH,
  START_LAUNCHER,
  STOP_LAUNCHER,
  shouldIncludeRepositoryFile,
} from "../../scripts/phase21/owner-acceptance-package-policy.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Phase 2.1 Windows owner package policy", () => {
  it("excludes secrets, tests, git, and runtime directories from the thin package", () => {
    expect(shouldIncludeRepositoryFile("Start-BEA-Owner-Acceptance.cmd")).toBe(true);
    expect(shouldIncludeRepositoryFile("apps/web/package.json")).toBe(true);
    expect(shouldIncludeRepositoryFile("docs/PHASE_2_1_OWNER_LIVE_RUNBOOK.md")).toBe(true);
    expect(shouldIncludeRepositoryFile("tests/unit/phase21-presentation.test.ts")).toBe(false);
    expect(shouldIncludeRepositoryFile(".github/workflows/ci.yml")).toBe(false);
    expect(shouldIncludeRepositoryFile("node_modules/react/index.js")).toBe(false);
    expect(shouldIncludeRepositoryFile(".env.local")).toBe(false);
    expect(shouldIncludeRepositoryFile(".git/config")).toBe(false);
  });

  it("keeps owner launchers on the canonical path and refuses broad process termination", () => {
    const start = readFileSync(join(process.cwd(), START_LAUNCHER), "utf8");
    const stop = readFileSync(join(process.cwd(), STOP_LAUNCHER), "utf8");
    expect(start).toContain(CANONICAL_EXTRACTION_PATH);
    expect(start).toContain("owner-evaluation-start.mjs");
    expect(start).toContain("owner-acceptance-preflight.mjs");
    expect(start).not.toMatch(/taskkill|Stop-Process|Get-Process|wmic/iu);
    expect(start).not.toMatch(/OPENAI_API_KEY=/u);
    expect(stop).toContain("owner-evaluation-stop.mjs");
    expect(stop).not.toMatch(/taskkill|Stop-Process|Get-Process|wmic/iu);
    expect(stop).not.toMatch(/taskkill/iu);
  });

  it("fails a package scan when prohibited or secret files are present", () => {
    const directory = mkdtempSync(join(tmpdir(), "bea-owner-scan-"));
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, "READ-ME-FIRST.txt"), `${CANONICAL_EXTRACTION_PATH}\n`);
    writeFileSync(join(directory, "PACKAGE-MANIFEST.json"), "{}\n");
    writeFileSync(join(directory, "PACKAGE-CHECKSUMS.txt"), "placeholder\n");
    writeFileSync(join(directory, START_LAUNCHER), "@echo off\n");
    writeFileSync(join(directory, STOP_LAUNCHER), "@echo off\n");
    mkdirSync(join(directory, "node_modules"), { recursive: true });
    writeFileSync(join(directory, "node_modules", "ignored.js"), "module.exports = {};\n");
    const result = scanOwnerAcceptancePackage(directory);
    expect(result.ok).toBe(false);
    expect(result.prohibited.some((item) => item.reason === "PROHIBITED_PACKAGE_ENTRY")).toBe(true);
  });
});
