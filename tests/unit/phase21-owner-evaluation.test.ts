import { describe, expect, it } from "vitest";

import {
  isOwnerEvaluationRuntime,
  parseEnvironment,
  requiresLiveOpenAiProvider,
  toPublicEnvironment,
} from "../../packages/config/src/index.js";
import { productionRejectsDemoFallback } from "../../packages/ai/src/routing.js";

const ownerEvaluationEnv = {
  NODE_ENV: "test",
  BEA_RUNTIME_MODE: "development",
  APP_MODE: "demo",
  BEA_DEPLOYMENT_PROFILE: "owner-evaluation",
  BEA_AUTH_PROVIDER: "demo",
  DATABASE_DRIVER: "pglite",
  APP_BASE_URL: "http://127.0.0.1:3300",
  DEMO_AUTH_ENABLED: "true",
};

describe("Owner Evaluation runtime contract", () => {
  it("retains the loopback Owner Evaluation fixture only in a test harness", () => {
    const environment = parseEnvironment(ownerEvaluationEnv);
    expect(environment.deploymentProfile).toBe("owner-evaluation");
    expect(isOwnerEvaluationRuntime(environment)).toBe(true);
    expect(requiresLiveOpenAiProvider(environment)).toBe(true);
    expect(toPublicEnvironment(environment)).toMatchObject({
      demoMode: false,
      ownerEvaluation: true,
    });
  });

  it("keeps Owner Evaluation distinct from Preview at the process-environment boundary", () => {
    const environment = parseEnvironment(ownerEvaluationEnv);
    expect(isOwnerEvaluationRuntime(environment)).toBe(true);
    expect(environment.deploymentProfile).not.toBe("demo");
  });

  it("rejects canned Demo AI fallback for Owner Evaluation", () => {
    expect(productionRejectsDemoFallback("demo", "demo", "owner-evaluation")).toBe(true);
    expect(productionRejectsDemoFallback("demo", "demo", "demo")).toBe(false);
    expect(productionRejectsDemoFallback("production", "demo", "local-live")).toBe(true);
  });

  it("does not treat Owner Evaluation as a canned Demo runtime in public environment", () => {
    const environment = parseEnvironment(ownerEvaluationEnv);
    expect(toPublicEnvironment(environment).demoMode).toBe(false);
    expect(toPublicEnvironment(environment).ownerEvaluation).toBe(true);
  });
});
