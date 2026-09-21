import { describe, expect, it } from "vitest";
import { DeterministicMockAiProvider, MOCK_AI_IDENTITY } from "../../packages/ai/src/index.js";
import { createDefaultMockProviderRegistry } from "../../packages/integrations/src/index.js";
import { FixedClock, SequenceIdGenerator } from "../../packages/testing/src/index.js";

describe("mock providers", () => {
  it("labels every connector result as simulated", async () => {
    const summary = await createDefaultMockProviderRegistry(new FixedClock()).healthSummary();
    expect(summary.total).toBe(15);
    expect(summary.simulated).toBe(15);
    expect(summary.connected).toBe(0);
    expect(
      summary.providers.every(
        (provider) => provider.mockMode && provider.requirementStatus === "SIMULATED",
      ),
    ).toBe(true);
  });
  it("uses a deterministic mock AI identity and performs no external action", async () => {
    const provider = new DeterministicMockAiProvider(
      new FixedClock(),
      new SequenceIdGenerator("ai"),
    );
    const first = await provider.summarize("A  deterministic   fixture");
    const second = await provider.summarize("A  deterministic   fixture");
    expect(provider.identity).toEqual(MOCK_AI_IDENTITY);
    expect(first.output).toBe(second.output);
    expect(first.metadata.externalActionPerformed).toBe(false);
    expect((await provider.usage()).every((record) => record.estimatedCostUsd === 0)).toBe(true);
  });
});
