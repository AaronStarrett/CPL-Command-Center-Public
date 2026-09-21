import { describe, expect, it } from "vitest";
import { cplEntryDecision } from "../../apps/web/lib/cpl-entry-policy";
describe("CPL product entry gate", () => {
  it.each(["production", "development", undefined])("protects customer routes in %s", (env) => {
    expect(cplEntryDecision("/setup", "GET", env)).toBe("allow");
    expect(cplEntryDecision("/brand/cpl-logo.png", "GET", env)).toBe("allow");
    for (const route of [
      "/",
      "/sign-in",
      "/ai-command",
      "/command-center",
      "/proposals",
      "/guided-demo",
    ])
      expect(cplEntryDecision(route, "GET", env)).toBe("setup");
    for (const route of [
      "/api/auth/switch-persona",
      "/api/guided-demo/meridian",
      "/api/proposals",
      "/api/health",
      "/setup",
    ])
      expect(cplEntryDecision(route, "POST", env)).toBe("unavailable");
    expect(cplEntryDecision("/api/artifacts/secret/download", "GET", env)).toBe("unavailable");
    expect(cplEntryDecision("/setup", "DELETE", env)).toBe("unavailable");
  });
  it("permits isolated automated test fixtures", () => {
    expect(cplEntryDecision("/api/proposals", "POST", "test")).toBe("allow");
  });
});
