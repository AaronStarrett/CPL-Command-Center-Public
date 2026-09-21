import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  HOSTED_ACTIONS_PARKED_MARKER,
  HOSTED_WORKFLOW_PATHS,
  extractCommentedOriginalWorkflow,
  hostedActionsParkingFindings,
  inspectHostedWorkflow,
} from "../../scripts/hosted-actions-parked.mjs";
import { PRECOMMIT_STEPS, buildPrecommitSteps } from "../../scripts/pre-commit-verify.mjs";
import {
  REQUIRED_DEPLOYMENT_FILES,
  validateDeploymentScaffolding,
} from "../../scripts/validate-deployment-scaffolding.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("hosted GitHub Actions parking and local pre-commit gate", () => {
  it("keeps every workflow parked without automatic triggers", () => {
    expect(hostedActionsParkingFindings(repositoryRoot)).toEqual([]);
    for (const relativePath of HOSTED_WORKFLOW_PATHS) {
      const contents = readFileSync(path.join(repositoryRoot, relativePath), "utf8");
      const inspection = inspectHostedWorkflow(contents);
      expect(contents).toContain(HOSTED_ACTIONS_PARKED_MARKER);
      expect(inspection.parked).toBe(true);
      expect(inspection.invalidYaml).toBe(false);
      expect(inspection.automaticTriggers).toEqual([]);
      expect(inspection.active?.on).toEqual({ workflow_dispatch: null });
    }
  });

  it("preserves the original CI and deploy contracts in commented bodies", () => {
    const ci = inspectHostedWorkflow(
      readFileSync(path.join(repositoryRoot, ".github/workflows/ci.yml"), "utf8"),
    );
    const deploy = inspectHostedWorkflow(
      readFileSync(path.join(repositoryRoot, ".github/workflows/deploy-manual.yml"), "utf8"),
    );
    expect(
      ["quality", "secrets", "dependency-audit", "containers", "deployment-contracts"].every(
        (job) => ci.original?.jobs?.[job],
      ),
    ).toBe(true);
    expect(ci.originalText).toContain("docker image inspect");
    expect(ci.originalText).toContain("credential-free two-container liveness smoke");
    expect(JSON.stringify(deploy.original)).toContain("DEPLOYMENT_ADAPTER_NOT_IMPLEMENTED");
    expect(JSON.stringify(deploy.original)).toContain("DEPLOYMENT_EXECUTION=NOT_RUN");
    expect(
      extractCommentedOriginalWorkflow(
        readFileSync(path.join(repositoryRoot, ".github/workflows/ci.yml"), "utf8"),
      ),
    ).toContain("name: Phase 1.3.5 repository and cloud readiness");
  });

  it("defines the local credential-free pre-commit suite", () => {
    const linuxLabels = [
      "repository-boundary",
      "source-integrity",
      "format-check",
      "lint",
      "typecheck",
      "phase135-and-parking-contracts",
      "verify-phase2.0",
      "verify-phase2.1",
      "verify-phase2.2",
      "verify-phase2.3",
      "verify-phase3.0",
      "verify-phase3.1a",
      "verify-phase3.2a",
      "verify-phase3.3a",
      "verify-phase3.4a",
      "secret-scan",
      "inventory",
    ];
    expect(buildPrecommitSteps("linux").map(([label]) => label)).toEqual(linuxLabels);
    expect(buildPrecommitSteps("win32").map(([label]) => label)).toEqual([
      ...linuxLabels.slice(0, 6),
      "phase135-local-storage-audit",
      ...linuxLabels.slice(6),
    ]);
    expect(PRECOMMIT_STEPS.map(([label]) => label)).toEqual(
      buildPrecommitSteps().map(([label]) => label),
    );
    const rule = readFileSync(
      path.join(repositoryRoot, ".cursor/rules/pre-commit-verify.mdc"),
      "utf8",
    );
    expect(rule).toContain("alwaysApply: true");
    expect(rule).toContain("pnpm precommit:verify");
    const packageManifest = JSON.parse(
      readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
    );
    expect(packageManifest.scripts["precommit:verify"]).toBe("node scripts/pre-commit-verify.mjs");
    expect(rule).toContain("Do not use `--no-verify`");
  });

  it("fails deployment validation when a hosted workflow is unparked", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bea-hosted-actions-"));
    try {
      for (const relativePath of REQUIRED_DEPLOYMENT_FILES) {
        const destination = path.join(root, relativePath);
        mkdirSync(path.dirname(destination), { recursive: true });
        copyFileSync(path.join(repositoryRoot, relativePath), destination);
      }
      writeFileSync(
        path.join(root, ".github/workflows/ci.yml"),
        [
          "name: restored-ci",
          "on:",
          "  pull_request:",
          "jobs:",
          "  quality:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: true",
        ].join("\n"),
      );
      const result = validateDeploymentScaffolding(root);
      expect(result.ok).toBe(false);
      expect(result.findings).toContain(
        "hosted-actions-must-remain-parked:.github/workflows/ci.yml",
      );
      expect(result.findings).toContain(
        "hosted-actions-automatic-triggers-present:.github/workflows/ci.yml",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
