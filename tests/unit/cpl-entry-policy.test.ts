import { describe, expect, it } from "vitest";
import { cplEntryDecision } from "../../apps/web/lib/cpl-entry-policy";
describe("CPL product entry gate", () => {
  it("opens source evidence and immutable mapping reads only with a product runtime", () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    for (const route of [
      `/api/cpl-integrations/receipts/${id}/evidence`,
      `/api/cpl-integrations/mappings/${id}`,
    ]) {
      expect(cplEntryDecision(route, "GET", "development", false, true)).toBe("allow");
      expect(cplEntryDecision(route, "GET", "production", true)).toBe("allow");
      expect(cplEntryDecision(route, "GET", "production", false)).toBe("unavailable");
    }
    for (const route of [
      `/api/cpl-integrations/receipts/${id}/evidence/private-file`,
      `/api/cpl-integrations/mappings/${id}/delete`,
      "/api/cpl-integrations/evidence/private-file",
    ])
      expect(cplEntryDecision(route, "GET", "development", false, true)).toBe("unavailable");
  });
  it("opens bounded tenant automation and delivery preparation without provider sending or arbitrary execution", () => {
    const id = "123e4567-e89b-12d3-a456-426614174000",
      project = `/api/cpl-delivery/projects/${id}`,
      pkg = `${project}/packages/${id}`;
    for (const route of [
      "/api/cpl-automation/workspace",
      "/api/cpl-automation/recipes",
      `/api/cpl-automation/tasks/${id}`,
      `/api/cpl-automation/executions/${id}`,
      `/api/cpl-automation/executions/${id}/retry`,
      `/api/cpl-automation/executions/${id}/cancel`,
      `/api/cpl-automation/events/${id}/replay`,
      project,
      `${project}/packages`,
      pkg,
      ...[
        "save",
        "revise",
        "ready",
        "export",
        "record-sent",
        "acknowledge",
        "manifest",
        "message",
        `attachments/${id}`,
      ].map((action) => `${pkg}/${action}`),
      ...["policy", "closeout", "override", "billing-handoff", `reports/${id}/withdraw`].map(
        (action) => `${project}/${action}`,
      ),
    ]) {
      expect(cplEntryDecision(route, "GET", "development", false, true)).toBe("allow");
      expect(cplEntryDecision(route, "POST", "production", false)).toBe("unavailable");
    }
    for (const route of [
      "/api/cpl-automation/run-script",
      "/api/cpl-automation/drain",
      `/api/cpl-automation/executions/${id}/delete`,
      `${pkg}/send`,
      `${pkg}/payment`,
      `${pkg}/attachments/private/path`,
      `${project}/invoice`,
      "/api/cpl-delivery/files",
    ])
      expect(cplEntryDecision(route, "POST", "development", false, true)).toBe("unavailable");
  });
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
  it("opens only implemented execution routes behind the product runtime gate", () => {
    const project = "/api/cpl-execution/projects/123e4567-e89b-12d3-a456-426614174000";
    for (const route of [
      "/api/cpl-execution/agenda",
      project,
      `${project}/visits`,
      `${project}/visits/123e4567-e89b-12d3-a456-426614174001`,
      "/api/cpl-execution/visits/123e4567-e89b-12d3-a456-426614174001",
    ]) {
      expect(cplEntryDecision(route, "POST", "development", false, true)).toBe("allow");
      expect(cplEntryDecision(route, "POST", "production", false)).toBe("unavailable");
    }
    for (const route of [
      "/api/cpl-execution/admin",
      `${project}/delete`,
      "/api/cpl-execution/files/private",
    ])
      expect(cplEntryDecision(route, "GET", "development", false, true)).toBe("unavailable");
  });
  it("permits isolated automated test fixtures", () => {
    expect(cplEntryDecision("/api/proposals", "POST", "test")).toBe("allow");
  });
  it("opens the tenant report lifecycle without opening arbitrary artifacts or delivery", () => {
    const base = "/api/cpl-reports/projects/123e4567-e89b-12d3-a456-426614174000",
      report = `${base}/reports/123e4567-e89b-12d3-a456-426614174001`;
    for (const route of [
      "/api/cpl-reports/templates",
      "/api/cpl-reports/branding",
      base,
      `${base}/reports`,
      report,
      ...["save", "sources", "submit", "review", "revise", "approve", "preview", "pdf"].map(
        (s) => `${report}/${s}`,
      ),
    ]) {
      expect(cplEntryDecision(route, "GET", "development", false, true)).toBe("allow");
      expect(cplEntryDecision(route, "POST", "production", false)).toBe("unavailable");
    }
    for (const route of [
      `${report}/send`,
      `${report}/delete`,
      "/api/cpl-reports/artifacts",
      `${base}/files/private`,
    ])
      expect(cplEntryDecision(route, "GET", "development", false, true)).toBe("unavailable");
  });
  it("limits field access to implemented routes behind the product runtime gate", () => {
    const base =
      "/api/cpl-field/projects/123e4567-e89b-12d3-a456-426614174000/visits/123e4567-e89b-12d3-a456-426614174001";
    for (const route of [
      "/api/cpl-field/templates",
      base,
      ...[
        "template",
        "checklist",
        "observations",
        "reopen",
        "photos",
        "photos/123e4567-e89b-12d3-a456-426614174002",
        "photos/123e4567-e89b-12d3-a456-426614174002/file",
        "photos/123e4567-e89b-12d3-a456-426614174002/retry",
      ].map((s) => `${base}/${s}`),
    ]) {
      expect(cplEntryDecision(route, "GET", "development", false, true)).toBe("allow");
      expect(cplEntryDecision(route, "POST", "production", false)).toBe("unavailable");
    }
    for (const route of [
      "/api/cpl-field/admin",
      `${base}/delete`,
      `${base}/photos/arbitrary/private-path`,
      `${base}/photos/123e4567-e89b-12d3-a456-426614174002/delete`,
    ])
      expect(cplEntryDecision(route, "GET", "development", false, true)).toBe("unavailable");
  });
  it("opens structured tenant commercial routes without opening legacy or arbitrary exports", () => {
    const proposal = "/api/cpl-commercial/proposals/123e4567-e89b-12d3-a456-426614174000";
    for (const route of [
      "/api/cpl-commercial/workspace",
      "/api/cpl-commercial/templates",
      "/api/cpl-commercial/branding",
      proposal,
      ...[
        "save",
        "submit",
        "review",
        "revise",
        "outcome",
        "project",
        "project-preview",
        "customer-preview",
        "pdf",
      ].map((operation) => `${proposal}/${operation}`),
    ]) {
      expect(cplEntryDecision(route, "GET", "development", false, true)).toBe("allow");
      expect(cplEntryDecision(route, "POST", "production", true)).toBe("allow");
      expect(cplEntryDecision(route, "POST", "production", false)).toBe("unavailable");
    }
    for (const route of [
      "/api/cpl-commercial/admin",
      `${proposal}/send`,
      `${proposal}/../secrets`,
      "/api/cpl-commercial/projects",
      "/api/commercial",
      "/api/proposals",
    ]) {
      expect(cplEntryDecision(route, "POST", "development", false, true)).toBe("unavailable");
    }
  });
  it("local development opens real tenant capabilities but never hosted ceremonies or legacy impersonation", () => {
    for (const route of [
      "/workspace",
      "/api/cpl/workspace",
      "/api/auth/local/status",
      "/api/auth/local/sign-in",
      "/api/auth/session",
      "/api/auth/renew",
      "/api/auth/logout",
    ])
      expect(cplEntryDecision(route, "GET", "development", false, true)).toBe("allow");
    for (const route of [
      "/api/auth/google/start",
      "/api/auth/google/callback",
      "/api/auth/passkeys/register/options",
      "/api/auth/switch-persona",
      "/api/proposals",
    ])
      expect(cplEntryDecision(route, "POST", "development", false, true)).toBe("unavailable");
    expect(cplEntryDecision("/api/auth/local/sign-in", "POST", "production", true)).toBe(
      "unavailable",
    );
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
