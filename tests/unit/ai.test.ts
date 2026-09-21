import { describe, expect, it } from "vitest";
import { DeterministicMockAiProvider } from "../../packages/ai/src/index.js";
import { FixedClock, SequenceIdGenerator } from "../../packages/testing/src/index.js";

describe("deterministic mock AI contract", () => {
  it("returns source-bound citations and explicitly declines an ungrounded answer", async () => {
    const provider = new DeterministicMockAiProvider(
      new FixedClock(),
      new SequenceIdGenerator("ai"),
    );
    const grounded = await provider.answer("What is in the source?", [
      { id: "source-1", title: "Synthetic source", excerpt: "Synthetic evidence." },
    ]);
    const ungrounded = await provider.answer("What is missing?", []);

    expect(grounded.output).toMatchObject({
      grounded: true,
      citations: [{ sourceId: "source-1", title: "Synthetic source" }],
    });
    expect(ungrounded.output).toEqual({
      answer: "No authorized grounding sources were supplied, so no answer was generated.",
      citations: [],
      grounded: false,
    });
  });

  it("only plans non-executable confirmation-gated actions and reports simulated health", async () => {
    const provider = new DeterministicMockAiProvider(
      new FixedClock(),
      new SequenceIdGenerator("ai"),
    );
    const plan = await provider.planAction("Review the account");
    const health = await provider.health();

    expect(plan.metadata).toMatchObject({
      mode: "mock",
      requirementStatus: "SIMULATED",
      externalActionPerformed: false,
    });
    expect(plan.output).toEqual([
      expect.objectContaining({
        actionType: "review-only",
        requiresConfirmation: true,
        executable: false,
      }),
    ]);
    expect(health).toMatchObject({
      status: "healthy",
      requirementStatus: "SIMULATED",
      provider: "bea.mock-ai",
    });
  });
});
