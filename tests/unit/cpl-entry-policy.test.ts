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
  it("opens only implemented hosted capabilities and preserves legacy isolation", () => {
    for (const route of [
      "/api/leads",
      "/api/proposals",
      "/api/artifacts/secret/download",
      "/api/auth/sign-in",
      "/api/auth/switch-persona",
      "/api/cpl/exports",
      "/api/cpl/credentials",
      "/api/cpl/leads/../legacy",
    ])
      expect(cplEntryDecision(route, "POST", "production", true)).toBe("unavailable");
    for (const route of [
      "/api/cpl/workspace",
      "/api/cpl/leads",
      "/api/cpl/proposals/123e4567-e89b-12d3-a456-426614174000/download",
      "/api/auth/session",
      "/api/auth/google/callback",
    ])
      expect(cplEntryDecision(route, "GET", "production", true)).toBe("allow");
    expect(cplEntryDecision("/", "GET", "production", true)).toBe("workspace");
    expect(cplEntryDecision("/workspace", "GET", "production", true)).toBe("allow");
    expect(cplEntryDecision("/workspace", "POST", "production", true)).toBe("unavailable");
  });
});
