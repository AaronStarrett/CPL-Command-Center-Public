import { describe, expect, it } from "vitest";
import {
  cplAutomationDueAt,
  cplAutomationReason,
  normalizeCplAutomationRecipe,
  type CplAutomationRecipeInput,
} from "../../packages/domain/src/cpl-automation";
const recipe: CplAutomationRecipeInput = {
  name: "Fictional ready lead handoff",
  trigger: "lead.ready",
  enabled: true,
  service: null,
  prepareDraft: true,
  templateId: "c19f00be-66c7-4b32-80bc-b99f7efb86a1",
  templateVersion: 1,
  templateApprovedForAutomation: true,
  owner: { kind: "unassigned", identityId: null, role: null },
  dueAfterHours: 24,
  taskTitle: "Review the draft",
};
describe("bounded internal automation recipe contracts", () => {
  it("requires explicit human authorization of a pinned draft template", () => {
    expect(() =>
      normalizeCplAutomationRecipe({ ...recipe, templateApprovedForAutomation: false }),
    ).toThrow("CPL_AUTOMATION_TEMPLATE_AUTHORIZATION_REQUIRED");
    expect(() => normalizeCplAutomationRecipe({ ...recipe, templateVersion: null })).toThrow();
  });
  it("rejects unimplemented triggers and implicit action modes", () => {
    expect(() => normalizeCplAutomationRecipe({ ...recipe, trigger: "email.send" })).toThrow();
    expect(() => normalizeCplAutomationRecipe({ ...recipe, enabled: "true" })).toThrow();
    expect(() =>
      normalizeCplAutomationRecipe({ ...recipe, trigger: "proposal.awarded" }),
    ).toThrow();
  });
  it("rejects stale hidden template settings when draft creation is disabled", () => {
    expect(() => normalizeCplAutomationRecipe({ ...recipe, prepareDraft: false })).toThrow();
  });
  it("normalizes only supported properties and never preserves executable payloads", () => {
    const normalized = normalizeCplAutomationRecipe({
      ...recipe,
      script: "arbitrary()",
      connector: { write: true },
      organizationId: "untrusted",
    });
    expect(normalized).toEqual(recipe);
    expect(Object.hasOwn(normalized, "script")).toBe(false);
  });
  it("bounds due dates and requires valid explicitly typed assignments", () => {
    for (const dueAfterHours of [-1, 8761, 1.5, Infinity])
      expect(() => normalizeCplAutomationRecipe({ ...recipe, dueAfterHours })).toThrow();
    expect(() =>
      normalizeCplAutomationRecipe({ ...recipe, owner: { kind: "role", role: "superadmin" } }),
    ).toThrow();
    expect(() =>
      normalizeCplAutomationRecipe({
        ...recipe,
        owner: { kind: "person", identityId: "not-uuid" },
      }),
    ).toThrow();
  });
  it("defines due times as elapsed UTC hours across daylight saving transitions", () => {
    expect(cplAutomationDueAt("2026-11-01T05:30:00.000Z", 24)).toBe("2026-11-02T05:30:00.000Z");
    expect(cplAutomationDueAt("2026-11-01T05:30:00.000Z", null)).toBeNull();
  });
  it("retains bounded multiline human reasons without accepting controls", () => {
    expect(cplAutomationReason("  Explained first line\nSecond line. ", true)).toBe(
      "Explained first line\nSecond line.",
    );
    expect(() => cplAutomationReason(" \n ", true)).toThrow();
    expect(() => cplAutomationReason("unsafe\0text")).toThrow();
    expect(() => cplAutomationReason("x".repeat(2001))).toThrow();
  });
});
