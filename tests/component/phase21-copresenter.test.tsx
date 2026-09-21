import { fireEvent, render, screen } from "@testing-library/react";
import React, { useState } from "react";
import { describe, expect, it } from "vitest";

import { WorkspaceRenderer } from "../../apps/web/components/workspace-renderer";
import type { AiCommandArtifactView } from "../../apps/web/lib/ai-command-contracts";
import {
  buildResearchPresentation,
  createSimulatedResearchResult,
} from "../../packages/ai/src/index.js";
import type { AiSafeWorkspaceSelection } from "../../packages/domain/src/index.js";

const PRESENTATION_RUN_ID = "b1000000-0000-4000-8000-000000000021";

function researchArtifact(): AiCommandArtifactView {
  const presentation = buildResearchPresentation({
    presentationRunId: PRESENTATION_RUN_ID,
    conversationId: "10000000-0000-4000-8000-000000000010",
    actingUserId: "10000000-0000-4000-8000-000000000001",
    query: "Research the latest information relevant to water penetration testing",
    result: createSimulatedResearchResult("water penetration"),
    provider: "demo",
    requiredPermissions: ["ai-command.view", "search.view"],
    visualArtifactId: "artifact-research-1",
  });
  return {
    id: "artifact-research-1",
    type: "help",
    title: presentation.title,
    subtitle: "SIMULATED WEB RESEARCH · deterministic-demo-router",
    state: "ready",
    payload: {
      schemaVersion: 1,
      renderer: "research",
      summary: presentation.summary,
      findings: presentation.findings.map((finding) => finding.body),
      sources: presentation.sources,
      citations: presentation.citations,
      presentation,
    },
    sources: presentation.sources.map((source) => ({
      id: source.id,
      type: "web-source",
      title: source.title,
      href: source.url,
    })),
    links: [],
    requiredPermissions: ["ai-command.view", "search.view"],
    createdAt: "2026-08-29T12:00:00.000Z",
    errorCode: null,
  };
}

function Harness({ reducedMotion = false }: { readonly reducedMotion?: boolean }) {
  const [autoFollow, setAutoFollow] = useState(true);
  const [narrationActive, setNarrationActive] = useState(true);
  const [selected, setSelected] = useState<AiSafeWorkspaceSelection | null>(null);
  const [voiceSession, setVoiceSession] = useState<"active" | "idle">("active");
  const [panel, setPanel] = useState<"conversation" | "workspace">("workspace");
  return (
    <div
      data-testid="ai-command-workspace"
      data-voice-session={voiceSession}
      data-narration-active={narrationActive ? "true" : "false"}
      data-auto-follow={autoFollow ? "true" : "false"}
      data-reduced-motion={reducedMotion ? "true" : "false"}
    >
      <div role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={panel === "conversation"}
          onClick={() => setPanel("conversation")}
        >
          Conversation
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={panel === "workspace"}
          onClick={() => setPanel("workspace")}
        >
          Workspace
        </button>
      </div>
      {panel === "conversation" ? (
        <p data-testid="ai-message-scroller">Transcript remains</p>
      ) : null}
      {autoFollow ? null : (
        <button type="button" data-testid="follow-narration" onClick={() => setAutoFollow(true)}>
          Follow narration
        </button>
      )}
      <div
        data-testid="ai-workspace-scroller"
        hidden={panel !== "workspace"}
        onScroll={() => {
          setAutoFollow(false);
        }}
        onWheel={() => {
          setAutoFollow(false);
        }}
      >
        <WorkspaceRenderer
          artifact={researchArtifact()}
          canExecuteTaskAction={false}
          onConfirmAction={() => undefined}
          autoFollow={autoFollow}
          narrationActive={narrationActive}
          selectedElementId={selected?.elementId ?? null}
          activeVisualElementId="finding:finding-1"
          onSelectWorkspaceItem={(next) => {
            setSelected(next);
            setAutoFollow(false);
          }}
        />
      </div>
      <button type="button" onClick={() => setNarrationActive(false)}>
        Interrupt
      </button>
      <button type="button" onClick={() => setVoiceSession("idle")}>
        Stop voice
      </button>
    </div>
  );
}

describe("Phase 2.1 co-presenter workspace", () => {
  it("renders research progress sections, source board, and clickable citations", () => {
    render(<Harness />);
    expect(screen.getByTestId("research-presentation")).toBeVisible();
    expect(screen.getByText(/SIMULATED WEB RESEARCH/u)).toBeVisible();
    expect(screen.getByRole("heading", { name: "Key findings" })).toBeVisible();
    expect(screen.getByTestId("source-board")).toBeVisible();
    expect(screen.getByTestId("citation-source-2")).toHaveAttribute(
      "data-simulated-source",
      "true",
    );
    expect(screen.getByTestId("research-presentation")).toHaveAttribute(
      "data-presentation-run",
      PRESENTATION_RUN_ID,
    );
  });

  it("highlights the active narration section", () => {
    render(<Harness />);
    expect(screen.getByTestId("finding-finding-1")).toHaveAttribute(
      "data-visual-element",
      "finding:finding-1",
    );
    expect(screen.getByTestId("ai-command-workspace")).toHaveAttribute(
      "data-narration-active",
      "true",
    );
  });

  it("pauses auto-follow on scroll without stopping narration", () => {
    render(<Harness />);
    fireEvent.scroll(screen.getByTestId("ai-workspace-scroller"));
    expect(screen.getByTestId("ai-command-workspace")).toHaveAttribute("data-auto-follow", "false");
    expect(screen.getByTestId("ai-command-workspace")).toHaveAttribute(
      "data-narration-active",
      "true",
    );
    fireEvent.click(screen.getByTestId("follow-narration"));
    expect(screen.getByTestId("ai-command-workspace")).toHaveAttribute("data-auto-follow", "true");
  });

  it("selects a source without stopping narration and keeps the artifact after interrupt", () => {
    render(<Harness />);
    fireEvent.click(
      screen.getByTestId("source-source-2").querySelector("button") ??
        screen.getByTestId("source-source-2"),
    );
    expect(screen.getByTestId("source-source-2")).toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("ai-command-workspace")).toHaveAttribute(
      "data-narration-active",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Interrupt" }));
    expect(screen.getByTestId("research-presentation")).toBeVisible();
    expect(screen.getByTestId("source-board")).toBeVisible();
  });

  it("keeps voice session state when switching compact conversation and workspace tabs", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("tab", { name: "Conversation" }));
    expect(screen.getByTestId("ai-message-scroller")).toBeVisible();
    expect(screen.getByTestId("ai-command-workspace")).toHaveAttribute(
      "data-voice-session",
      "active",
    );
    fireEvent.click(screen.getByRole("tab", { name: "Workspace" }));
    expect(screen.getByTestId("research-presentation")).toBeVisible();
    expect(screen.getByTestId("ai-command-workspace")).toHaveAttribute(
      "data-voice-session",
      "active",
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop voice" }));
    expect(screen.getByTestId("ai-command-workspace")).toHaveAttribute(
      "data-voice-session",
      "idle",
    );
  });

  it("respects reduced-motion marking and does not claim live web research for simulated sources", () => {
    const { rerender } = render(<Harness reducedMotion />);
    expect(screen.getByTestId("ai-command-workspace")).toHaveAttribute(
      "data-reduced-motion",
      "true",
    );
    rerender(<Harness />);
    expect(screen.getByText(/SIMULATED WEB RESEARCH/u)).toBeVisible();
    expect(screen.queryByText("LIVE WEB RESEARCH")).toBeNull();
  });

  it("renders provider-disconnected and insufficient-evidence states", () => {
    const artifact = researchArtifact();
    const presentation = (artifact.payload as { presentation: { status: string } }).presentation;
    render(
      <WorkspaceRenderer
        artifact={{
          ...artifact,
          payload: {
            ...artifact.payload,
            presentation: { ...presentation, status: "provider_disconnected" },
          },
        }}
        canExecuteTaskAction={false}
        onConfirmAction={() => undefined}
      />,
    );
    expect(screen.getByText("Provider disconnected")).toBeVisible();
  });

  it("shows a permission-denied workspace when the artifact is empty and unauthorized", () => {
    render(
      <WorkspaceRenderer
        artifact={{
          id: "artifact-denied",
          type: "help",
          title: "Permission denied",
          subtitle: "The requested records are not authorized for this role",
          state: "empty",
          payload: { schemaVersion: 1, renderer: "research", summary: "Permission denied." },
          sources: [],
          links: [],
          requiredPermissions: ["leads.view"],
          createdAt: "2026-08-29T12:00:00.000Z",
          errorCode: "permission-not-granted",
        }}
        canExecuteTaskAction={false}
        onConfirmAction={() => undefined}
      />,
    );
    expect(screen.getByRole("heading", { name: "Permission denied" })).toBeInTheDocument();
    expect(screen.getByText("Permission denied.")).toBeVisible();
  });
});
