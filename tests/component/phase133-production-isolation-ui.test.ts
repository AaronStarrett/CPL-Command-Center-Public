import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Phase 1.3.3 production presentation isolation", () => {
  it("omits test personas and the Demo banner from production presentation paths", () => {
    const signIn = source("apps/web/app/sign-in/page.tsx");
    const banner = source("apps/web/components/operating-mode-banner.tsx");

    expect(signIn).toContain("const personas = demoEnabled ? getDemoPersonas() : []");
    expect(signIn).toContain("Production authentication not connected");
    expect(signIn).toContain("This runtime correctly excludes test personas");
    expect(banner).toContain('runtime.environment.runtimeMode === "production"');
    expect(banner).toContain("return null");
  });

  it("fails closed before executing test-only integration and artifact paths", () => {
    const simulateRoute = source("apps/web/app/api/integrations/[id]/simulate/route.ts");
    const messageFallbackRoute = source("apps/web/app/api/ai-command/messages/route.ts");
    const streamRoute = source("apps/web/app/api/ai-command/stream/route.ts");
    const streamProcessor = source("apps/web/lib/ai-command-stream.ts");
    const legacyProcessor = source("apps/web/lib/ai-command.ts");
    const administration = source("apps/web/lib/openai-administration.ts");
    const artifactRunner = source("apps/web/lib/demo-artifact-runner.ts");

    expect(simulateRoute).toContain('runtime.environment.runtimeMode === "production"');
    expect(simulateRoute).toContain("test-provider-unavailable");
    expect(messageFallbackRoute).toContain(
      "await isDeterministicDemoAiCommandAllowed(context.runtime)",
    );
    expect(messageFallbackRoute).toContain("test-provider-unavailable");
    expect(streamRoute).toContain("isPhase133ProductionPresentationTest()");
    expect(streamRoute).toContain("test-provider-unavailable");
    expect(administration).toContain('runtime.environment.appMode !== "demo"');
    expect(administration).toContain('runtime.environment.runtimeMode === "production"');
    expect(administration).toContain("isPhase133ProductionPresentationTest()");
    expect(administration).toContain('settings.mode === "demo"');
    expect(administration).toContain('runtime.ai.registry.active().providerKey === "demo"');
    expect(legacyProcessor).toContain("await isDeterministicDemoAiCommandAllowed(runtime)");
    expect(streamProcessor).toContain("await isDeterministicDemoAiCommandAllowed(input.runtime)");
    expect(
      streamProcessor.indexOf("await isDeterministicDemoAiCommandAllowed(input.runtime)"),
    ).toBeLessThan(
      streamProcessor.indexOf(
        "const snapshot = await processAiCommandMessageWithRuntime(input.runtime",
      ),
    );
    expect(artifactRunner).toContain('runtime.environment.runtimeMode === "production"');
    expect(artifactRunner).toContain("Test-only artifact fixtures are unavailable in production");
  });

  it("allows browser JSON fallback only for a server-labeled simulated provider", () => {
    const cockpit = source("apps/web/components/ai-command-motion-workspace.tsx");

    expect(cockpit).toContain("function deterministicFallbackAllowed()");
    expect(cockpit).toContain("currentProvider.simulated === true && isDemoProvider()");
    expect(cockpit).toContain("No test-provider fallback was used.");
  });

  it("places the real compact OpenAI setup workflow in the authorized right tile", () => {
    const cockpit = source("apps/web/components/ai-command-motion-workspace.tsx");
    const administration = source("apps/web/components/openai-administration-panel.tsx");

    expect(cockpit).toContain("<OpenAiAdministrationPanel compact />");
    expect(cockpit).toContain("snapshot.permissions.canConfigureOpenAi === true");
    expect(administration).toContain("Connect OpenAI");
    expect(administration).toContain('type="password"');
    expect(administration).toContain("Choose models");
    expect(administration).toContain("Owner model routing");
  });
});
