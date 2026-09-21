import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { hostedActionsParkingFindings } from "../../scripts/hosted-actions-parked.mjs";
import { runPrecommitStep } from "../../scripts/pre-commit-verify.mjs";

describe("CPL local cost controls", () => {
  it.each([{ status: null, signal: "SIGTERM" }, { status: null }, { status: 1 }])(
    "fails closed when verification does not complete: %j",
    (result) => {
      expect(() =>
        runPrecommitStep("interrupted", process.execPath, [], {
          environment: {},
          spawnSync: () => result,
        }),
      ).toThrow(/failed/u);
    },
  );
  it("detects an extra unparked workflow and a manually executable parked job", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cpl-cost-"));
    try {
      mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
      const parked = readFileSync(".github/workflows/deploy-manual.yml", "utf8");
      writeFileSync(path.join(root, ".github/workflows/extra.yml"), parked);
      expect(hostedActionsParkingFindings(root, [])).toEqual([]);
      writeFileSync(
        path.join(root, ".github/workflows/extra.yml"),
        parked.replace("if: " + String.fromCharCode(36) + "{{ false }}", "if: true"),
      );
      expect(hostedActionsParkingFindings(root, [])).toContain(
        "hosted-actions-jobs-must-be-disabled:.github/workflows/extra.yml",
      );
      writeFileSync(
        path.join(root, ".github/workflows/unknown.yaml"),
        "name: surprise\non: issues\njobs: {}\n",
      );
      expect(hostedActionsParkingFindings(root, [])).toContain(
        "hosted-actions-automatic-triggers-present:.github/workflows/unknown.yaml",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
