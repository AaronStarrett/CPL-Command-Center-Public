import { describe, expect, it } from "vitest";

import {
  PHASE1_3_5_INTENDED_FILES,
  assertExactPhase1_3_5Paths,
  reconcilePhase1_3_5Paths,
} from "../../scripts/phase1-3-5-intended-files.mjs";
import {
  PHASE1_3_5_GATE_DEFINITIONS,
  assertPhase1_3_5Toolchain,
  createPhase1_3_5Environment,
  phase1_3_5FailurePrefix,
  phase1_3_5ExternalEvidenceDefaults,
} from "../../scripts/verify-phase1-3-5.mjs";

describe("Phase 1.3.5 verifier contract", () => {
  it("preserves the ordered original and course-correction gates", () => {
    expect(PHASE1_3_5_GATE_DEFINITIONS).toHaveLength(44);
    expect(PHASE1_3_5_GATE_DEFINITIONS.map(([number]) => number)).toEqual(
      Array.from({ length: 44 }, (_, index) => index + 1),
    );
    expect(PHASE1_3_5_GATE_DEFINITIONS[0]?.[1]).toBe("Repository boundary");
    expect(PHASE1_3_5_GATE_DEFINITIONS[29]?.[1]).toBe(
      "No unintended process or cloud-resource change",
    );
  });

  it("requires the exact pinned toolchain", () => {
    expect(() => assertPhase1_3_5Toolchain("v24.19.0", "11.19.0")).not.toThrow();
    expect(() => assertPhase1_3_5Toolchain("v20.12.2", "11.19.0")).toThrow();
    expect(() => assertPhase1_3_5Toolchain("v24.19.0", "11.9.0")).toThrow();
  });

  it("clears provider and publication credentials from child commands", () => {
    const environment = createPhase1_3_5Environment({
      PATH: "C:\\Windows\\System32",
      OPENAI_API_KEY: "must-not-flow",
      DATABASE_URL: "must-not-flow",
      GITHUB_TOKEN: "must-not-flow",
      R2_SECRET_ACCESS_KEY: "must-not-flow",
    });
    expect(environment.OPENAI_API_KEY).toBe("");
    expect(environment.DATABASE_URL).toBe("");
    expect(environment.GITHUB_TOKEN).toBe("");
    expect(environment.R2_SECRET_ACCESS_KEY).toBe("");
    expect(environment.APP_MODE).toBe("demo");
    expect(environment.CI).toBe("true");
  });

  it("fails closed on missing, unexpected, duplicate, or prohibited paths", () => {
    expect(() => assertExactPhase1_3_5Paths(PHASE1_3_5_INTENDED_FILES)).not.toThrow();
    expect(reconcilePhase1_3_5Paths(PHASE1_3_5_INTENDED_FILES.slice(1)).missing).toHaveLength(1);
    expect(
      reconcilePhase1_3_5Paths([...PHASE1_3_5_INTENDED_FILES, ".data/runtime.db"]).forbidden,
    ).toEqual([".data/runtime.db"]);
  });

  it("keeps external evidence distinct from local verification", () => {
    expect(phase1_3_5ExternalEvidenceDefaults()).toEqual({
      publication: "NOT_RUN",
      containerBuilds: "NOT_RUN_LOCAL_CI_REQUIRED",
      safeCleanup: "NOT_RUN",
      cloudDeployment: "NOT_RUN",
      providerConnections: "NOT_CONNECTED",
      dataMigration: "NOT_RUN",
      ownerAcceptance: "NOT_RUN",
    });
  });

  it("labels publication and local failures as separate evidence classes", () => {
    expect(phase1_3_5FailurePrefix("--local")).toBe("PHASE1_3_5_LOCAL_VERIFICATION=FAIL ");
    expect(phase1_3_5FailurePrefix("--publication")).toBe("PHASE1_3_5_PUBLICATION=FAIL ");
  });
});
