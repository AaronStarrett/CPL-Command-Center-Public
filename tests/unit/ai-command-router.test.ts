import { describe, expect, it } from "vitest";

import { resolveDemoDueDate, routeDemoCommand } from "../../packages/ai/src/index.js";

describe("deterministic AI Command router", () => {
  it.each([
    ["Show me today's priorities.", "command-center-summary"],
    ["Show open tasks", "open-tasks"],
    ["Which tasks are overdue?", "overdue-tasks"],
    ["Show unread notifications", "unread-notifications"],
    ["Show recent activity", "recent-activity"],
    ["Show all companies", "company-list"],
    ["Show connector health", "integration-health"],
    ["Which systems are not connected?", "disconnected-systems"],
    ["Show recent workflow runs", "workflow-run-list"],
    ["Open the latest workflow run", "workflow-run-latest"],
    ["What can I do here?", "help"],
  ] as const)("routes %s", (input, expected) => {
    expect(routeDemoCommand(input).type).toBe(expected);
  });

  it("extracts company and search terms", () => {
    expect(routeDemoCommand("Open Northstar Facilities")).toMatchObject({
      type: "company-open",
      companyName: "Northstar Facilities",
    });
    expect(routeDemoCommand("Show contacts for Northstar Facilities")).toMatchObject({
      type: "company-contacts",
      companyName: "Northstar Facilities",
    });
    expect(routeDemoCommand("Search for roof assessment")).toMatchObject({
      type: "search",
      term: "roof assessment",
    });
    expect(routeDemoCommand("Show leads")).toMatchObject({ type: "lead-list" });
    expect(routeDemoCommand("Open the lead review queue")).toMatchObject({ type: "lead-list" });
    expect(routeDemoCommand("Show me the leads that still need information")).toMatchObject({
      type: "lead-needs-info-list",
    });
    expect(
      routeDemoCommand("Research the latest information relevant to water penetration testing"),
    ).toMatchObject({ type: "research-presentation" });
    expect(routeDemoCommand("Research synthetic envelope sources").type).not.toBe(
      "research-presentation",
    );
    expect(routeDemoCommand("Open lead BEA-LD-000003")).toMatchObject({
      type: "lead-open",
      leadTerm: "BEA-LD-000003",
    });
    expect(routeDemoCommand("What is missing on lead BEA-LD-000001")).toMatchObject({
      type: "lead-missing-info",
      leadTerm: "BEA-LD-000001",
    });
  });

  it("extracts a confirmation-gated task draft without executing it", () => {
    expect(
      routeDemoCommand(
        'Create an internal task titled "Review field notes" assigned to Operations due tomorrow for company Northstar Facilities',
      ),
    ).toMatchObject({
      type: "create-task",
      taskDraft: {
        title: "Review field notes",
        assignee: "Operations",
        dueDate: "tomorrow",
        companyName: "Northstar Facilities",
      },
    });
  });

  it("provides the deterministic exact-demo follow-up title", () => {
    expect(routeDemoCommand("Create an internal follow-up task.").taskDraft?.title).toBe(
      "Internal follow-up task",
    );
  });

  it("captures a confirmation-gated follow-up task for a lead without executing it", () => {
    expect(
      routeDemoCommand("Create an internal follow-up task for lead BEA-LD-000003"),
    ).toMatchObject({
      type: "create-task",
      taskDraft: {
        title: "Internal follow-up task",
        leadTerm: "BEA-LD-000003",
      },
    });
  });

  it("resolves supported dates against an injected clock", () => {
    expect(resolveDemoDueDate("tomorrow", new Date("2026-08-18T09:00:00-04:00"))).toBe(
      "2026-08-19T17:00:00.000Z",
    );
    expect(resolveDemoDueDate("2026-09-01", new Date("2026-08-18T09:00:00-04:00"))).toBe(
      "2026-09-01T17:00:00.000Z",
    );
  });

  it("responds honestly through the unsupported route", () => {
    expect(routeDemoCommand("Draft and send a proposal").type).toBe("unsupported");
  });
});
