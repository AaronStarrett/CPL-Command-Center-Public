import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const start = readFileSync(join(process.cwd(), "Start-BEA-Owner-Acceptance.cmd"), "utf8");
const stop = readFileSync(join(process.cwd(), "Stop-BEA-Owner-Acceptance.cmd"), "utf8");
const preflight = readFileSync(
  join(process.cwd(), "scripts/phase21/owner-acceptance-preflight.mjs"),
  "utf8",
);
const policy = readFileSync(
  join(process.cwd(), "scripts/phase21/owner-acceptance-package-policy.mjs"),
  "utf8",
);

describe("Owner Evaluation launcher contract", () => {
  it("starts Owner Evaluation without PostgreSQL or an environment key", () => {
    expect(start).toContain("scripts\\owner-evaluation-start.mjs");
    expect(start).not.toContain("Start-BEA.cmd");
    expect(start).not.toMatch(/OPENAI_API_KEY=/u);
    expect(start).toMatch(/pause/iu);
    expect(start).toContain("PostgreSQL is not required");
    expect(preflight).toContain("PostgreSQL is not required for Owner Evaluation");
    expect(preflight).not.toContain("BEA-Doctor.cmd");
  });

  it("stops only exact Owner Evaluation children", () => {
    expect(stop).toContain("scripts\\owner-evaluation-stop.mjs");
    expect(stop).not.toContain("Stop-BEA.cmd");
    expect(stop).not.toMatch(/taskkill|Stop-Process|Get-Process|wmic/iu);
  });

  it("does not instruct the owner to configure OPENAI_API_KEY in a file", () => {
    expect(policy).not.toMatch(/set OPENAI_API_KEY/u);
    expect(policy).toContain("Connect OpenAI inside the application");
  });
});
