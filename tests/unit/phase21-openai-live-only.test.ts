import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { isDeterministicDemoAiCommandAllowed } from "../../apps/web/lib/openai-administration.js";
import {
  AiProviderRegistry,
  DemoStreamingAiProvider,
  productionRejectsDemoFallback,
} from "../../packages/ai/src/index.js";
import type { BeaServerRuntime } from "../../packages/database/src/index.js";

function runtime(deploymentProfile: "demo" | "owner-evaluation" | "local-live") {
  const registry = new AiProviderRegistry(new DemoStreamingAiProvider());
  return {
    environment: {
      appMode: deploymentProfile === "local-live" ? "production" : "demo",
      runtimeMode: deploymentProfile === "local-live" ? "production" : "development",
      deploymentProfile,
    },
    ai: {
      registry,
      persistence: {
        getProviderSettings: vi.fn(async () => ({ mode: "demo" })),
      },
    },
  } as unknown as BeaServerRuntime;
}

describe("Owner Evaluation live-only OpenAI contract", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("denies canned Demo AI for Owner Evaluation and production", async () => {
    await expect(isDeterministicDemoAiCommandAllowed(runtime("owner-evaluation"))).resolves.toBe(
      false,
    );
    await expect(isDeterministicDemoAiCommandAllowed(runtime("local-live"))).resolves.toBe(false);
    await expect(isDeterministicDemoAiCommandAllowed(runtime("demo"))).resolves.toBe(true);
  });

  it("does not tell the owner to put OPENAI_API_KEY in a file", () => {
    const source = readFileSync(
      join(process.cwd(), "apps/web/lib/openai-administration.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/Configure OPENAI_API_KEY in the ignored local environment/u);
    expect(source).toContain("Do not paste the key into a file, terminal, or environment variable");
    expect(source).toContain("connectOpenAiAndDiscover");
  });

  it("bootstraps Owner Evaluation without a Demo AI registry", () => {
    const runtimeSource = readFileSync(
      join(process.cwd(), "packages/database/src/server-runtime.ts"),
      "utf8",
    );
    expect(runtimeSource).toContain("requiresLiveOpenAiProvider");
    expect(runtimeSource).toContain("adoptOwnerEvaluationOpenAiBoundary");
    expect(runtimeSource).toContain("liveAiRequired");
  });

  it("rejects Demo fallback for Owner Evaluation routing", () => {
    expect(productionRejectsDemoFallback("demo", "demo", "owner-evaluation")).toBe(true);
  });
});
