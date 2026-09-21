import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render, screen, within } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { WorkspaceRenderer } from "../../apps/web/components/workspace-renderer";
import type { AiCommandArtifactView } from "../../apps/web/lib/ai-command-contracts";

function artifact(overrides: Partial<AiCommandArtifactView> = {}): AiCommandArtifactView {
  return {
    id: "phase133-long-artifact",
    type: "audit-summary",
    title: "Phase 1.3.3 long artifact",
    subtitle: "Deterministic component fixture",
    state: "ready",
    payload: {},
    sources: [],
    links: [],
    requiredPermissions: ["ai-command.view"],
    createdAt: "2026-08-22T12:00:00.000Z",
    errorCode: null,
    ...overrides,
  };
}

function renderArtifact(value: AiCommandArtifactView) {
  return render(
    <WorkspaceRenderer
      artifact={value}
      canExecuteTaskAction={false}
      onConfirmAction={vi.fn()}
      titleRenderedByParent
    />,
  );
}

describe("Phase 1.3.3 continuous long workspace renderers", () => {
  it("shows compact production component statuses without synthetic records", () => {
    renderArtifact(
      artifact({
        type: "empty",
        title: "Connect OpenAI",
        subtitle: "OpenAI setup required",
        payload: {
          providerStatus: "SETUP_REQUIRED",
          actionable: true,
          componentStatus: {
            openAiText: "Setup required",
            webSearch: "Disabled",
            fileSearch: "Not configured",
            voice: "Setup required",
            beaData: "Not connected",
            businessIntegrations: "Not connected",
          },
        },
      }),
    );

    expect(screen.getByLabelText("Production component status")).toBeVisible();
    expect(screen.getByText("OpenAI text")).toBeVisible();
    expect(screen.getAllByText("Setup required")).toHaveLength(2);
    expect(
      screen.getByText(/BEA will not substitute provider answers or business records/u),
    ).toBeVisible();
    expect(
      screen.queryByText("No authorized records matched this request."),
    ).not.toBeInTheDocument();
  });

  it.each([
    ["email", "From", "operations@bea.example", "Envelope program status"],
    ["report", "Author", "BEA Operations", "Executive observations"],
    ["document", "Prepared for", "Riverside Medical Center", "Document scope"],
  ] as const)(
    "renders a long %s as semantic sections instead of presentation cards",
    (renderer, metadataLabel, metadataValue, sectionHeading) => {
      const { container } = renderArtifact(
        artifact({
          title: `Long ${renderer}`,
          payload: {
            renderer,
            ...(renderer === "email"
              ? { from: metadataValue, subject: "Riverside envelope handoff" }
              : {}),
            ...(renderer === "report" ? { author: metadataValue } : {}),
            ...(renderer === "document" ? { preparedFor: metadataValue } : {}),
            body: "The first paragraph establishes the authorized operating context.\n\nThe second paragraph keeps the narrative readable without a nested card.",
            sections: [
              {
                heading: sectionHeading,
                paragraphs: [
                  "The first section paragraph records the present condition.",
                  "The second section paragraph records the owner decision.",
                ],
                bullets: ["Confirm scope", "Record owner", "Set checkpoint"],
              },
              {
                heading: "Measured options",
                table: {
                  columns: ["option", "value", "status"],
                  rows: [
                    { option: "Base", value: "$1.2M", status: "review" },
                    { option: "Preferred", value: "$1.4M", status: "recommended" },
                  ],
                },
              },
            ],
          },
        }),
      );

      const longForm = container.querySelector(`[data-long-form-kind="${renderer}"]`);
      expect(longForm).not.toBeNull();
      expect(longForm?.tagName).toBe("ARTICLE");
      expect(within(longForm as HTMLElement).getByText(metadataLabel)).toBeInTheDocument();
      expect(within(longForm as HTMLElement).getByText(metadataValue)).toBeInTheDocument();
      expect(
        within(longForm as HTMLElement).getByRole("heading", { name: sectionHeading }),
      ).toBeInTheDocument();
      expect(within(longForm as HTMLElement).getAllByRole("listitem")).toHaveLength(3);
      expect(within(longForm as HTMLElement).getByRole("table")).toBeInTheDocument();
      expect(longForm?.querySelectorAll("p").length).toBeGreaterThanOrEqual(4);
      expect(container.querySelector(".bea-card")).toBeNull();
      expect(container.querySelectorAll('[data-workspace-artifact-body="single"]')).toHaveLength(1);
    },
  );

  it("renders long research and its source list in one continuous body with one provenance region", () => {
    const findings = Array.from(
      { length: 40 },
      (_, index) => `Authorized research finding ${index + 1}`,
    );
    const sources = Array.from({ length: 18 }, (_, index) => ({
      id: `source-${index + 1}`,
      type: "web",
      title: `Verified source ${index + 1}`,
      href: `https://example.com/source-${index + 1}`,
    }));
    const { container } = renderArtifact(
      artifact({
        title: "Long research",
        payload: {
          renderer: "research-board",
          body: "Research context is presented as prose.\n\nThe evidence remains in the same workspace flow.",
          findings,
          sections: [
            {
              heading: "Research method",
              body: "The method paragraph describes the bounded deterministic fixture.",
            },
          ],
        },
        sources,
      }),
    );

    const workspace = screen.getByTestId("workspace-artifact-audit-summary");
    expect(workspace).toHaveAttribute("data-workspace-layout", "research");
    expect(workspace.querySelector('[data-long-form-kind="research"]')).not.toBeNull();
    expect(screen.getByText("Authorized research finding 40")).toBeInTheDocument();
    expect(screen.getByText("Verified source 18")).toBeInTheDocument();
    expect(container.querySelectorAll('[data-workspace-provenance="single"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-workspace-region="body"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-workspace-content="research-findings"]')).toHaveLength(
      0,
    );
  });

  it("keeps a long record history direct and free of nested workspace scroll containers", () => {
    const items = Array.from({ length: 60 }, (_, index) => ({
      id: `history-${index + 1}`,
      title: `Project history event ${index + 1}`,
      subtitle: `Deterministic history detail ${index + 1}`,
      status: index % 2 === 0 ? "complete" : "open",
    }));
    const { container } = renderArtifact(
      artifact({ type: "search-results", title: "Long project history", payload: { items } }),
    );

    expect(screen.getByText("Project history event 60")).toBeInTheDocument();
    expect(container.querySelectorAll('[data-workspace-content="records"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-scroll-owner="workspace"]')).toHaveLength(0);
    expect(container.querySelectorAll(".bea-ai-record")).toHaveLength(60);
  });

  it("publishes a readable measure and hairline section rhythm for long artifacts", () => {
    const css = readFileSync(
      resolve(process.cwd(), "apps/web/components/ai-command.module.css"),
      "utf8",
    );
    expect(css).toMatch(/\.longForm,[\s\S]*?max-width:\s*72ch;/u);
    expect(css).toMatch(/\.longForm section,[\s\S]*?border-top:\s*1px solid/u);
  });
});
