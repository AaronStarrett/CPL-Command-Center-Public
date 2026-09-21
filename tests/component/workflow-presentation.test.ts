import { describe, expect, it } from "vitest";

import { workflowStepTone } from "../../apps/web/lib/workflow-presentation";

describe("persisted workflow presentation", () => {
  it.each([
    ["succeeded", "success"],
    ["degraded", "warning"],
    ["failed", "danger"],
  ])("maps %s steps to the %s tone", (status, tone) => {
    expect(workflowStepTone(status)).toBe(tone);
  });
});
