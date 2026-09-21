import { describe, expect, it } from "vitest";

import {
  isAiCommandWorkspacePath,
  parseAiCommandWorkspacePath,
  workspacePathForArtifactType,
} from "../../apps/web/lib/ai-command-workspace-paths.ts";

describe("AI Command in-pane workspace paths", () => {
  it("parses list and detail paths for companies, leads, and related records", () => {
    expect(parseAiCommandWorkspacePath("/companies")).toMatchObject({
      view: "company-list",
      recordId: null,
    });
    expect(
      parseAiCommandWorkspacePath("/companies/11111111-1111-4111-8111-111111111111"),
    ).toMatchObject({
      view: "company-detail",
      parentPath: "/companies",
    });
    expect(parseAiCommandWorkspacePath("/leads")).toMatchObject({ view: "lead-list" });
    expect(isAiCommandWorkspacePath("/companies")).toBe(true);
    expect(isAiCommandWorkspacePath("https://evil.example/companies")).toBe(false);
    expect(isAiCommandWorkspacePath("/sign-in")).toBe(false);
  });

  it("maps artifact types back to workspace paths", () => {
    expect(workspacePathForArtifactType("company-list")).toBe("/companies");
    expect(
      workspacePathForArtifactType("lead-detail", "11111111-1111-4111-8111-111111111111"),
    ).toBe("/leads/11111111-1111-4111-8111-111111111111");
  });
});
