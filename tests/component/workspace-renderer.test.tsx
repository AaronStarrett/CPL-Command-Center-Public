import { fireEvent, render, screen } from "@testing-library/react";
import { WORKSPACE_ARTIFACT_TYPES } from "@bea/domain";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/application-pdf-viewer", () => ({
  ApplicationPdfViewer: ({
    downloadHref,
    title,
  }: {
    readonly downloadHref?: string | null;
    readonly title: string;
  }) => (
    <div data-testid="application-pdf-viewer" data-state="ready">
      <div data-testid="workspace-pdf-toolbar" role="toolbar" aria-label="PDF preview controls">
        {downloadHref ? (
          <a href={downloadHref} download>
            Download PDF
          </a>
        ) : null}
      </div>
      <div data-testid="workspace-pdf-scroller">
        <canvas role="img" aria-label={`${title}, page 1`} />
      </div>
    </div>
  ),
}));

beforeEach(() => vi.restoreAllMocks());

import {
  APPLICATION_RENDERER_NAMES,
  NORMALIZED_ARTIFACT_RENDERER_NAMES,
  WorkspaceRenderer,
  applicationRendererRegistry,
  normalizedArtifactRendererRegistry,
  workspaceRendererRegistry,
} from "../../apps/web/components/workspace-renderer";
import type { AiCommandArtifactView } from "../../apps/web/lib/ai-command-contracts";

function artifact(overrides: Partial<AiCommandArtifactView> = {}): AiCommandArtifactView {
  return {
    id: "artifact-1",
    type: "task-list",
    title: "Open tasks",
    subtitle: "Database-backed demo records",
    state: "ready",
    payload: {
      items: [
        {
          id: "task-1",
          title: "Review roof assessment",
          href: "/tasks/task-1",
          status: "open",
        },
      ],
    },
    sources: [
      { id: "task-1", type: "task", title: "Review roof assessment", href: "/tasks/task-1" },
    ],
    links: [],
    requiredPermissions: ["tasks.view"],
    createdAt: "2026-08-18T12:00:00.000Z",
    errorCode: null,
    ...overrides,
  };
}

describe("controlled workspace renderer registry", () => {
  it("registers every allowed artifact type", () => {
    expect(Object.keys(workspaceRendererRegistry).sort()).toEqual(
      [...WORKSPACE_ARTIFACT_TYPES].sort(),
    );
  });

  it("renders records directly in one continuous artifact body", () => {
    const { container } = render(
      <WorkspaceRenderer
        artifact={artifact()}
        canExecuteTaskAction={false}
        onConfirmAction={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Open tasks" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Review roof assessment" })).toHaveLength(1);
    const workspace = screen.getByTestId("workspace-artifact-task-list");
    expect(workspace).toHaveAttribute("data-workspace-surface", "continuous");
    expect(workspace).toHaveAttribute("data-workspace-region", "body");
    expect(workspace).toHaveAttribute("data-workspace-layout", "record");
    expect(workspace.querySelectorAll('[data-workspace-artifact-body="single"]')).toHaveLength(1);
    expect(workspace.querySelectorAll('[data-workspace-provenance="single"]')).toHaveLength(0);
    expect(container.querySelector("header")).toBeNull();
    expect(container.querySelector(".bea-card")).toBeNull();
  });

  it("renders model-looking markup only as text", () => {
    render(
      <WorkspaceRenderer
        artifact={artifact({
          payload: { items: [{ id: "unsafe", title: "<script>danger()</script>" }] },
          sources: [],
        })}
        canExecuteTaskAction={false}
        onConfirmAction={vi.fn()}
      />,
    );

    expect(screen.getByText("<script>danger()</script>")).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
  });

  it("keeps hostile record and source targets inert while preserving internal links", () => {
    const unsafeTargets = [
      "https://evil.example/path",
      "https://owner:private-sentinel@evil.example/path",
      "//evil.example/path",
      "/\\evil.example/path",
      "/%2f%2fevil.example/path",
      "/%5cevil.example/path",
      "/%0d%0a/evil.example/path",
      "/.//evil.example/path",
    ];
    render(
      <WorkspaceRenderer
        artifact={artifact({
          payload: {
            items: [
              { id: "safe", title: "Safe record", href: "/tasks/task-1" },
              ...unsafeTargets.map((href, index) => ({
                id: `unsafe-${index}`,
                title: `Unsafe record ${index + 1}`,
                href,
              })),
            ],
          },
          sources: [
            { id: "safe", type: "task", title: "Safe source", href: "/tasks/task-1" },
            ...unsafeTargets.map((href, index) => ({
              id: `unsafe-${index}`,
              type: "task",
              title: `Unsafe source ${index + 1}`,
              href,
            })),
          ],
        })}
        canExecuteTaskAction={false}
        onConfirmAction={vi.fn()}
      />,
    );

    expect(screen.getByRole("link", { name: "Safe record" })).toHaveAttribute(
      "href",
      "/tasks/task-1",
    );
    expect(screen.queryByRole("link", { name: "Safe source" })).toBeNull();
    for (let index = 1; index <= unsafeTargets.length; index += 1) {
      expect(screen.getByText(`Unsafe record ${index}`).closest("a")).toBeNull();
      expect(screen.getByText(`Unsafe source ${index}`).closest("a")).toBeNull();
    }
    expect(document.body.innerHTML).not.toContain("private-sentinel");
  });

  it("renders every artifact state plus an idempotent action result", () => {
    const { rerender } = render(
      <WorkspaceRenderer
        artifact={artifact()}
        canExecuteTaskAction={false}
        onConfirmAction={vi.fn()}
      />,
    );
    expect(screen.getByTestId("workspace-artifact-renderer")).toHaveAttribute(
      "data-artifact-state",
      "ready",
    );

    rerender(
      <WorkspaceRenderer
        artifact={artifact({ state: "loading" })}
        canExecuteTaskAction={false}
        onConfirmAction={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading authorized workspace data");

    rerender(
      <WorkspaceRenderer
        artifact={artifact({ state: "empty", payload: { items: [] }, sources: [] })}
        canExecuteTaskAction={false}
        onConfirmAction={vi.fn()}
      />,
    );
    expect(screen.getByText("No authorized records matched this request.")).toBeInTheDocument();

    rerender(
      <WorkspaceRenderer
        artifact={artifact({
          type: "error",
          state: "failed",
          payload: { message: "Permission-filtered query failed safely." },
          sources: [],
        })}
        canExecuteTaskAction={false}
        onConfirmAction={vi.fn()}
      />,
    );
    expect(screen.getByText("Workspace unavailable")).toBeInTheDocument();
    expect(screen.getByText("Permission-filtered query failed safely.")).toBeInTheDocument();

    rerender(
      <WorkspaceRenderer
        artifact={artifact({
          type: "action-result",
          title: "Task created",
          payload: {
            message: "The task exists exactly once.",
            href: "/tasks/task-1",
            idempotent: true,
          },
          sources: [],
        })}
        canExecuteTaskAction={false}
        onConfirmAction={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        "Repeated confirmation restores this same verified result without another task.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the created task" })).toHaveAttribute(
      "href",
      "/tasks/task-1",
    );
  });

  it("requires an authorized explicit confirmation control for task writes", () => {
    const onConfirm = vi.fn();
    const preview = artifact({
      type: "action-preview",
      title: "Create internal task",
      payload: {
        actionId: "action-1",
        executable: true,
        actingUser: "Owner Administrator",
        requiredPermission: "ai.action.task.create",
        fields: { title: "Review field notes", assignee: "Operations Coordinator" },
      },
    });
    const { rerender } = render(
      <WorkspaceRenderer
        artifact={preview}
        canExecuteTaskAction={false}
        onConfirmAction={onConfirm}
      />,
    );
    expect(screen.getByText("View-only preview")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review and confirm task" })).toBeNull();

    rerender(
      <WorkspaceRenderer artifact={preview} canExecuteTaskAction onConfirmAction={onConfirm} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Review and confirm task" }));
    expect(onConfirm).toHaveBeenCalledWith("action-1");
  });

  it("renders only allowlisted application renderers with safe markup", async () => {
    expect(Object.keys(applicationRendererRegistry).sort()).toEqual(
      [...APPLICATION_RENDERER_NAMES].sort(),
    );
    const { rerender } = render(
      <WorkspaceRenderer
        artifact={artifact({
          title: "Pipeline trend",
          payload: {
            renderer: "line-chart",
            data: [
              { label: "Week 1", value: 4 },
              { label: "Week 2", value: 9 },
            ],
          },
          sources: [],
        })}
        canExecuteTaskAction={false}
        onConfirmAction={vi.fn()}
      />,
    );

    expect(screen.getByTestId("workspace-artifact-renderer")).toHaveAttribute(
      "data-renderer",
      "line-chart",
    );
    expect(screen.getByRole("img", { name: "Pipeline trend line chart" })).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();

    rerender(
      <WorkspaceRenderer
        artifact={artifact({
          title: "Authorized comparison",
          payload: {
            renderer: "table",
            columns: ["company", "score"],
            rows: [{ company: "Allied Envelope", score: 94 }],
          },
          sources: [],
        })}
        canExecuteTaskAction={false}
        onConfirmAction={vi.fn()}
      />,
    );
    expect(screen.getByRole("columnheader", { name: "company" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Allied Envelope" })).toBeInTheDocument();

    rerender(
      <WorkspaceRenderer
        artifact={artifact({
          title: "Generated brief",
          payload: { renderer: "pdf-preview", src: "/api/artifacts/brief-1/preview" },
          sources: [],
        })}
        canExecuteTaskAction={false}
        onConfirmAction={vi.fn()}
      />,
    );
    expect(screen.getByTestId("application-pdf-viewer")).toHaveAttribute("data-state", "ready");
    expect(
      screen.getByRole("img", { name: "Generated brief preview, page 1" }),
    ).toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("adapts normalized artifact manifests and embeds the controlled PDF viewer", () => {
    expect(Object.keys(normalizedArtifactRendererRegistry).sort()).toEqual(
      [...NORMALIZED_ARTIFACT_RENDERER_NAMES].sort(),
    );
    const manifestBase = {
      artifactId: "manifest-1",
      citations: [
        {
          accessedAt: "2026-08-20T14:00:00.000Z",
          domain: "example.invalid",
          title: "Synthetic source",
          url: "https://example.invalid/source",
        },
      ],
      createdAt: "2026-08-20T14:00:00.000Z",
      disclosure: "Demo Mode synthetic artifact",
      ownerId: "10000000-0000-4000-8000-000000000001",
      schemaVersion: 1,
      summary: "Deterministic artifact fixture.",
      title: "Normalized artifact",
    } as const;
    const { rerender } = render(
      <WorkspaceRenderer
        artifact={artifact({
          title: "Normalized findings chart",
          payload: {
            ...manifestBase,
            chart: {
              provenance: {
                calculationNotes: "Synthetic totals grouped by system.",
                dataStatus: "synthetic",
                sourceMapping: [],
              },
              series: [
                { label: "Roof", value: 4 },
                { label: "Facade", value: 2 },
              ],
              title: "Findings by system",
              type: "bar",
              unit: "findings",
            },
            renderer: "chart",
          },
          sources: [],
        })}
        canExecuteTaskAction={false}
        onConfirmAction={vi.fn()}
      />,
    );
    expect(screen.getByTestId("workspace-artifact-renderer")).toHaveAttribute(
      "data-renderer",
      "chart",
    );
    expect(
      screen.getByRole("img", { name: "Normalized findings chart bar chart" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Synthetic totals grouped by system.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Synthetic source" })).toHaveAttribute(
      "href",
      "https://example.invalid/source",
    );

    rerender(
      <WorkspaceRenderer
        artifact={artifact({
          title: "Normalized PDF",
          payload: {
            ...manifestBase,
            file: {
              filename: "synthetic-report.pdf",
              id: "art_0123456789abcdef0123456789abcdef",
              mimeType: "application/pdf",
              sha256: "a".repeat(64),
              size: 4096,
            },
            renderer: "pdf",
          },
          sources: [],
        })}
        canExecuteTaskAction={false}
        onConfirmAction={vi.fn()}
      />,
    );
    expect(screen.getByTestId("application-pdf-viewer")).toHaveAttribute("data-state", "ready");
    expect(screen.getByTestId("workspace-pdf-toolbar")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-pdf-scroller")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Normalized artifact, page 1" })).toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("link", { name: "Download PDF" })).toHaveAttribute(
      "href",
      "/api/artifacts/art_0123456789abcdef0123456789abcdef/download",
    );

    rerender(
      <WorkspaceRenderer
        artifact={artifact({
          title: "Normalized research",
          payload: {
            ...manifestBase,
            findings: ["Synthetic roof finding", "Synthetic glazing finding"],
            renderer: "research",
          },
          sources: [],
        })}
        canExecuteTaskAction={false}
        onConfirmAction={vi.fn()}
      />,
    );
    expect(screen.getByText("Synthetic roof finding")).toBeInTheDocument();
    expect(screen.getByText("Synthetic glazing finding")).toBeInTheDocument();
  });

  it("renders research once as compact content plus one deduplicated provenance list", () => {
    render(
      <WorkspaceRenderer
        artifact={artifact({
          title: "AI research sources",
          subtitle: "One verified source",
          payload: {
            artifactId: "manifest-research",
            citations: [
              {
                accessedAt: "2026-08-20T14:00:00.000Z",
                domain: "example.invalid",
                title: "Synthetic BEA research fixture",
                url: "https://example.invalid/source",
              },
            ],
            createdAt: "2026-08-20T14:00:00.000Z",
            disclosure: "DEMO MODE - deterministic synthetic sources.",
            ownerId: "10000000-0000-4000-8000-000000000001",
            renderer: "source-board",
            schemaVersion: 1,
            sources: [
              {
                accessedAt: "2026-08-20T14:00:00.000Z",
                domain: "example.invalid",
                title: "Synthetic BEA research fixture",
                url: "https://example.invalid/source",
              },
            ],
            summary: "One verified HTTPS source returned by the provider.",
            title: "AI research sources",
          },
          sources: [],
        })}
        canExecuteTaskAction={false}
        onConfirmAction={vi.fn()}
      />,
    );

    const workspace = screen.getByTestId("workspace-artifact-task-list");
    expect(workspace).toHaveAttribute("data-workspace-layout", "research");
    expect(screen.getAllByText("DEMO MODE - deterministic synthetic sources.")).toHaveLength(1);
    expect(screen.getAllByText("One verified HTTPS source returned by the provider.")).toHaveLength(
      1,
    );
    expect(screen.getAllByRole("link", { name: "Synthetic BEA research fixture" })).toHaveLength(1);
    expect(screen.getAllByRole("heading", { name: "Sources and citations" })).toHaveLength(1);
    expect(screen.getAllByTestId("bea-artifact-brand-frame")).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("exposes direct chart and activity layouts without nested card shells", () => {
    const { container, rerender } = render(
      <WorkspaceRenderer
        artifact={artifact({
          title: "Pipeline trend",
          payload: {
            renderer: "line-chart",
            data: [
              { label: "Week 1", value: 4 },
              { label: "Week 2", value: 9 },
            ],
          },
          sources: [],
        })}
        canExecuteTaskAction={false}
        onConfirmAction={vi.fn()}
      />,
    );

    expect(screen.getByTestId("workspace-artifact-task-list")).toHaveAttribute(
      "data-workspace-layout",
      "chart",
    );
    expect(container.querySelectorAll('[data-workspace-content="chart"]')).toHaveLength(1);
    expect(container.querySelector(".bea-card")).toBeNull();

    rerender(
      <WorkspaceRenderer
        artifact={artifact({
          type: "activity-timeline",
          title: "Recent activity",
          payload: {
            items: [
              {
                href: "/activities",
                id: "activity-1",
                status: "task.updated",
                subtitle: "Aug 23, 2026, 9:15 AM",
                title: "Pricing review updated",
              },
            ],
          },
          sources: [],
        })}
        canExecuteTaskAction={false}
        onConfirmAction={vi.fn()}
      />,
    );

    expect(screen.getByTestId("workspace-artifact-activity-timeline")).toHaveAttribute(
      "data-workspace-layout",
      "activity",
    );
    expect(container.querySelectorAll('[data-workspace-content="activity"]')).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Pricing review updated" })).toHaveAttribute(
      "href",
      "/activities",
    );
    expect(container.querySelector(".bea-card")).toBeNull();
  });

  it("rejects unknown or unsafe application renderer payloads", () => {
    const { rerender } = render(
      <WorkspaceRenderer
        artifact={artifact({
          payload: { renderer: "raw-html", html: "<script>danger()</script>" },
          sources: [],
        })}
        canExecuteTaskAction={false}
        onConfirmAction={vi.fn()}
      />,
    );
    expect(screen.getByText("Unsupported artifact renderer")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-artifact-renderer")).toHaveAttribute(
      "data-renderer",
      "unsupported",
    );
    expect(document.querySelector("script")).toBeNull();

    rerender(
      <WorkspaceRenderer
        artifact={artifact({
          title: "Unsafe preview",
          payload: {
            renderer: "pdf-preview",
            src: "https://owner:private-sentinel@evil.example/report.pdf",
          },
          sources: [],
        })}
        canExecuteTaskAction={false}
        onConfirmAction={vi.fn()}
      />,
    );
    expect(screen.getByText("PDF preview blocked")).toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.body.innerHTML).not.toContain("private-sentinel");
  });

  it("preserves application artifacts, citations, and downloads when reopened", () => {
    const persisted = artifact({
      title: "Research source board",
      payload: {
        renderer: "source-board",
        items: [{ id: "source-1", title: "Official source", href: "https://example.com/source" }],
        citations: [
          { id: "citation-1", title: "Verified citation", href: "https://example.com/citation" },
          {
            id: "citation-unsafe",
            title: "Unsafe citation",
            href: "javascript:danger()",
          },
        ],
        downloads: [{ id: "download-1", label: "Download CSV", href: "/artifacts/a.csv" }],
      },
      sources: [],
    });
    const first = render(
      <WorkspaceRenderer
        artifact={persisted}
        canExecuteTaskAction={false}
        onConfirmAction={vi.fn()}
      />,
    );
    expect(screen.getByRole("link", { name: "Verified citation" })).toHaveAttribute(
      "href",
      "https://example.com/citation",
    );
    expect(screen.getByText("Unsafe citation").closest("a")).toBeNull();
    expect(screen.getByRole("link", { name: "Download CSV" })).toHaveAttribute(
      "href",
      "/artifacts/a.csv",
    );
    first.unmount();

    render(
      <WorkspaceRenderer
        artifact={persisted}
        canExecuteTaskAction={false}
        onConfirmAction={vi.fn()}
      />,
    );
    expect(screen.getByTestId("workspace-artifact-renderer")).toHaveAttribute(
      "data-renderer",
      "source-board",
    );
    expect(screen.getByRole("link", { name: "Official source" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download CSV" })).toBeInTheDocument();
  });
});
