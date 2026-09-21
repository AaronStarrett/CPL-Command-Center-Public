import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AiCommandWorkspace } from "../../apps/web/components/ai-command-workspace";
import type {
  AiCommandArtifactView,
  AiCommandSnapshot,
} from "../../apps/web/lib/ai-command-contracts";
import { setTestRouterReplace } from "./stubs/next-navigation";

const navigation = { replace: vi.fn() };
const moduleCss = readFileSync(
  resolve(process.cwd(), "apps/web/components/ai-command.module.css"),
  "utf8",
);
const phase132Marker =
  "/* Phase 1.3.2: two continuous glass tiles with progressive internal controls. */";
const phase132Css = moduleCss.slice(moduleCss.indexOf(phase132Marker));
const cockpitSource = readFileSync(
  resolve(process.cwd(), "apps/web/components/ai-command-motion-workspace.tsx"),
  "utf8",
);

function artifact(overrides: Partial<AiCommandArtifactView> = {}): AiCommandArtifactView {
  return {
    id: "artifact-phase132",
    type: "help",
    title: "AI Command capabilities",
    subtitle: "Deterministic, permission-aware Demo Mode",
    state: "ready",
    payload: { commands: ["Show open tasks"] },
    sources: [],
    links: [],
    requiredPermissions: ["ai-command.view"],
    createdAt: "2026-08-23T12:00:00.000Z",
    errorCode: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<AiCommandSnapshot> = {}): AiCommandSnapshot {
  const conversation = {
    id: "conversation-phase132",
    title: "Phase 1.3.2 structural conversation",
    updatedAt: "2026-08-23T12:00:00.000Z",
  };
  return {
    conversation,
    conversations: [conversation],
    messages: [
      {
        id: "message-assistant-phase132",
        role: "assistant",
        content: "Owner, the next authorized action is ready for your review.",
        createdAt: "2026-08-23T12:00:00.000Z",
        provider: "simulated",
        model: "deterministic-demo-router",
        executionMs: 4,
        links: [],
      },
      {
        id: "message-user-phase132",
        role: "user",
        content: "Show the supporting workspace.",
        createdAt: "2026-08-23T12:01:00.000Z",
        provider: null,
        model: null,
        executionMs: null,
        links: [],
      },
    ],
    artifact: artifact(),
    provider: {
      name: "BEA deterministic demo assistant",
      mode: "SIMULATED",
      model: "deterministic-demo-router",
      routerVersion: "phase132-test-router-v1",
      liveConnected: false,
      streaming: true,
      webSearchAllowed: true,
    },
    permissions: { canExecuteTaskAction: true, canUploadArtifact: false },
    actingUser: {
      id: "10000000-0000-4000-8000-000000000001",
      displayName: "Workspace Owner",
      title: "Chief Executive Officer",
    },
    assistant: {
      kind: "executive-business-partner",
      preferredName: "Owner",
      label: "BEA Executive Business Partner",
      subtitle: "Your executive partner for BEA operations",
      promptVersion: "bea-executive-business-partner-v1",
      executiveProfileVersion: "andrew-executive-profile-v1",
      brandPolicyVersion: "bea-artifact-brand-v1",
      artifactTemplateVersion: "bea-artifact-template-v1",
    },
    ...overrides,
  };
}

function visibleElements(elements: HTMLElement[]): HTMLElement[] {
  return elements.filter((element) => {
    try {
      expect(element).toBeVisible();
      return true;
    } catch {
      return false;
    }
  });
}

describe("Phase 1.3.2 seamless two-tile structure", () => {
  beforeEach(() => {
    navigation.replace.mockReset();
    setTestRouterReplace(navigation.replace);
    vi.stubGlobal("fetch", vi.fn());
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    window.history.replaceState(null, "", "/ai-command");
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders exactly two primary tiles with one unboxed conversation stream and one composer", () => {
    render(<AiCommandWorkspace initialSnapshot={snapshot()} />);

    const route = screen.getByTestId("ai-command-workspace");
    const primaryTiles = Array.from(
      route.querySelectorAll<HTMLElement>("[data-primary-glass-tile]"),
    );
    expect(primaryTiles).toHaveLength(2);
    expect(primaryTiles.map((tile) => tile.dataset.testid).sort()).toEqual([
      "ai-conversation-panel",
      "ai-workspace-panel",
    ]);

    const conversation = screen.getByTestId("ai-conversation-panel");
    expect(within(conversation).queryByTestId("ai-suggestion-rail")).toBeNull();
    expect(within(conversation).queryAllByTestId("ai-capability-launcher")).toHaveLength(0);
    expect(within(conversation).queryByTestId("ai-tool-controls")).toBeNull();
    expect(within(conversation).queryByTestId("ai-upload-control")).toBeNull();
    expect(within(conversation).queryByTestId("ai-voice-panel")).toBeNull();
    expect(within(conversation).queryByTestId("ai-voice-transcript")).toBeNull();
    expect(within(conversation).queryByText(/^Permission:/u)).toBeNull();
    expect(within(conversation).queryByRole("button", { name: "Lead Intake" })).toBeNull();
    expect(within(conversation).queryByRole("button", { name: "Proposal Builder" })).toBeNull();
    expect(within(conversation).queryByRole("button", { name: "Project Creation" })).toBeNull();
    expect(within(conversation).queryByRole("button", { name: "Market Insights" })).toBeNull();
    expect(within(conversation).getAllByTestId("ai-command-composer")).toHaveLength(1);

    const stream = within(conversation).getByTestId("ai-message-scroller");
    expect(stream).toHaveAttribute("tabindex", "0");
    const messages = Array.from(stream.querySelectorAll<HTMLElement>("article[data-role]"));
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message).not.toHaveClass("bea-card");
      expect(message).not.toHaveClass("bea-floating-surface");
      expect(message.querySelector(".bea-card, .bea-floating-surface")).toBeNull();
      expect(message.closest('[data-testid="ai-message-scroller"]')).toBe(stream);
    }

    const workspace = screen.getByTestId("ai-workspace-panel");
    expect(within(workspace).getAllByTestId("ai-workspace-header")).toHaveLength(1);
    expect(within(workspace).getAllByTestId("ai-workspace-scroller")).toHaveLength(1);
    expect(
      workspace.querySelectorAll(
        '[data-workspace-surface="continuous"][data-workspace-region="body"]',
      ),
    ).toHaveLength(1);
    expect(workspace.querySelectorAll('[data-workspace-artifact-body="single"]')).toHaveLength(1);
    expect(workspace.querySelector(".bea-card, .bea-floating-surface")).toBeNull();
  });

  it("keeps History and provider tools icon-triggered and progressively disclosed", () => {
    render(
      <AiCommandWorkspace
        initialSnapshot={snapshot({
          provider: {
            ...snapshot().provider,
            codeInterpreterAllowed: true,
            imageGenerationAllowed: true,
          },
          permissions: {
            canConfigureOpenAi: true,
            canExecuteTaskAction: true,
            canUploadArtifact: true,
          },
        })}
      />,
    );

    const conversation = screen.getByTestId("ai-conversation-panel");
    expect(
      visibleElements(within(conversation).queryAllByText("History", { selector: "button" })),
    ).toHaveLength(0);
    expect(
      visibleElements(within(conversation).queryAllByText("Web", { selector: "button" })),
    ).toHaveLength(0);

    const progressive = within(conversation).getByTestId("ai-command-progressive-controls");
    const trigger = within(conversation).getByTestId("ai-command-options-trigger");
    expect(progressive.tagName).toBe("DETAILS");
    expect(progressive).not.toHaveAttribute("open");
    expect(trigger).toHaveAccessibleName();
    expect(trigger.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(within(progressive).getByTestId("ai-web-search-toggle")).not.toBeVisible();
    expect(within(progressive).getByTestId("ai-code-interpreter-toggle")).not.toBeVisible();
    expect(within(progressive).getByText("Choose restricted file")).not.toBeVisible();

    fireEvent.click(trigger);

    expect(progressive).toHaveAttribute("open");
    expect(within(progressive).getByTestId("ai-web-search-toggle")).toBeVisible();
    expect(within(progressive).getByTestId("ai-code-interpreter-toggle")).toBeVisible();
    expect(within(progressive).getByText("Choose restricted file")).toBeVisible();
    expect(within(progressive).getByTestId("ai-artifact-upload-input")).toBeInTheDocument();
    expect(within(progressive).getByRole("link", { name: "Connect OpenAI" })).toHaveAttribute(
      "href",
      "/integrations/ai",
    );
  });

  it("keeps OpenAI configuration hidden without the explicit configuration permission", () => {
    render(<AiCommandWorkspace initialSnapshot={snapshot()} />);
    const conversation = screen.getByTestId("ai-conversation-panel");
    fireEvent.click(within(conversation).getByTestId("ai-command-options-trigger"));
    expect(within(conversation).queryByRole("link", { name: "Connect OpenAI" })).toBeNull();
  });

  it("shows simulated transcript review only while active and restores the single composer", () => {
    vi.useFakeTimers();
    render(<AiCommandWorkspace initialSnapshot={snapshot()} />);

    expect(screen.queryByTestId("ai-voice-transcript")).toBeNull();
    fireEvent.click(screen.getByTestId("ai-interaction-mode-voice"));
    fireEvent.click(screen.getByTestId("bea-start-voice"));
    expect(screen.queryByTestId("ai-voice-transcript")).toBeNull();

    act(() => vi.advanceTimersByTime(2_000));
    act(() => vi.advanceTimersByTime(350));

    const transientTranscript = screen.getByTestId("ai-voice-transcript");
    expect(transientTranscript).toBeVisible();
    expect(transientTranscript).not.toHaveClass("bea-card");
    expect(transientTranscript).not.toHaveClass("bea-floating-surface");
    expect(screen.getByTestId("ai-message-scroller")).toBeInTheDocument();
    expect(phase132Css).not.toMatch(
      /\.conversation\[data-voice-active="true"\][\s\S]*?visibility:\s*hidden/u,
    );
    const transcript = within(transientTranscript).getByRole("textbox", {
      name: "Review and correct simulated transcript",
    });
    fireEvent.change(transcript, { target: { value: "Show overdue tasks" } });
    fireEvent.click(within(transientTranscript).getByRole("button", { name: "Use transcript" }));

    expect(screen.queryByTestId("ai-voice-transcript")).toBeNull();
    expect(screen.getAllByTestId("ai-command-composer")).toHaveLength(1);
    expect(screen.getByRole("textbox", { name: "Message BEA AI Command" })).toHaveValue(
      "Show overdue tasks",
    );
  });

  it("renders research once in one workspace header and one continuous artifact body", () => {
    const source = {
      id: "source-phase132",
      type: "web",
      title: "Synthetic BEA research fixture",
      href: "https://example.invalid/phase132-source",
    };
    render(
      <AiCommandWorkspace
        initialSnapshot={snapshot({
          artifact: artifact({
            id: "artifact-research-phase132",
            title: "Envelope market research",
            subtitle: "Compact deterministic research",
            payload: {
              renderer: "source-board",
              summary: "A concise synthetic finding.",
              items: [source],
            },
            sources: [source],
          }),
        })}
      />,
    );

    const workspace = screen.getByTestId("ai-workspace-panel");
    expect(within(workspace).getAllByTestId("ai-workspace-header")).toHaveLength(1);
    expect(within(workspace).getAllByTestId("ai-workspace-scroller")).toHaveLength(1);
    expect(workspace.querySelectorAll('[data-workspace-artifact-body="single"]')).toHaveLength(1);
    expect(workspace.querySelectorAll('[data-workspace-provenance="single"]')).toHaveLength(1);
    const researchTitles = within(workspace).getAllByText("Envelope market research");
    expect(researchTitles).toHaveLength(1);
    expect(researchTitles[0]).not.toHaveClass("bea-visually-hidden");
    expect(
      within(workspace).getAllByRole("link", { name: "Synthetic BEA research fixture" }),
    ).toHaveLength(1);
    expect(workspace.querySelector(".bea-card, .bea-floating-surface")).toBeNull();
  });

  it("mounts the action-confirmation dialog only for the explicit review interval", () => {
    vi.useFakeTimers();
    render(
      <AiCommandWorkspace
        initialSnapshot={snapshot({
          artifact: artifact({
            id: "artifact-action-phase132",
            type: "action-preview",
            title: "Create internal task",
            payload: {
              actionId: "action-phase132",
              executable: true,
              actingUser: "Workspace Owner",
              requiredPermission: "ai.action.task.create",
              fields: { title: "Review field notes", assignee: "Operations Coordinator" },
            },
          }),
        })}
      />,
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review and confirm task" }));
    expect(screen.getByRole("dialog", { name: "Create this internal task?" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("preserves the divider and compact Conversation/Workspace tab contract", () => {
    render(<AiCommandWorkspace initialSnapshot={snapshot()} />);

    expect(screen.getAllByRole("tablist", { name: "AI Command panels" })).toHaveLength(1);
    const conversationTab = screen.getByRole("tab", { name: "Conversation" });
    const workspaceTab = screen.getByRole("tab", { name: "Workspace" });
    const conversationPanel = screen.getByRole("tabpanel", { name: "Conversation" });
    const workspacePanel = screen.getByRole("tabpanel", { name: "Workspace" });
    expect(conversationPanel).toHaveAttribute("data-mobile-active", "true");
    expect(workspacePanel).toHaveAttribute("data-mobile-active", "false");
    expect(screen.getByTestId("ai-pane-divider")).toHaveAttribute("role", "separator");

    fireEvent.click(workspaceTab);
    expect(workspaceTab).toHaveAttribute("aria-selected", "true");
    expect(conversationTab).toHaveAttribute("aria-selected", "false");
    expect(conversationPanel).toHaveAttribute("data-mobile-active", "false");
    expect(workspacePanel).toHaveAttribute("data-mobile-active", "true");

    fireEvent.keyDown(workspaceTab, { key: "ArrowLeft" });
    expect(conversationTab).toHaveFocus();
    expect(conversationTab).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(conversationTab, { key: "ArrowLeft" });
    expect(workspaceTab).toHaveFocus();
    fireEvent.keyDown(workspaceTab, { key: "ArrowRight" });
    expect(conversationTab).toHaveFocus();
    fireEvent.keyDown(conversationTab, { key: "End" });
    expect(workspaceTab).toHaveFocus();
    fireEvent.keyDown(workspaceTab, { key: "Home" });
    expect(conversationTab).toHaveFocus();
  });

  it("limits permanent glass construction to the outer tiles and one scroller per tile", () => {
    expect(moduleCss).toContain(phase132Marker);
    expect(phase132Css).toMatch(
      /\.panel\s*\{[\s\S]*?-webkit-backdrop-filter:\s*blur\(1\.65rem\) saturate\(132%\);[\s\S]*?backdrop-filter:\s*blur\(1\.65rem\) saturate\(132%\);/u,
    );
    expect(phase132Css).toMatch(
      /\.messages \*,\s*\.composer \*\s*\{[\s\S]*?-webkit-backdrop-filter:\s*none !important;[\s\S]*?backdrop-filter:\s*none !important;/u,
    );
    expect(phase132Css).toMatch(
      /\.workspaceBody \*,[\s\S]*?\.workspaceBody :global\(\.bea-card\)\s*\{[\s\S]*?-webkit-backdrop-filter:\s*none !important;[\s\S]*?backdrop-filter:\s*none !important;/u,
    );
    expect(phase132Css).toMatch(
      /\.workspaceBody\s*\{[\s\S]*?overflow-x:\s*hidden;[\s\S]*?overflow-y:\s*auto;/u,
    );
    expect(cockpitSource.match(/data-testid="ai-message-scroller"/gu)).toHaveLength(1);
    expect(cockpitSource.match(/data-testid="ai-workspace-scroller"/gu)).toHaveLength(1);
    expect(cockpitSource).not.toContain('data-testid="ai-suggestion-rail"');
    expect(cockpitSource).not.toContain('data-testid="ai-capability-launcher"');
    expect(cockpitSource).toContain("snapshot.permissions.canConfigureOpenAi");
  });

  it("publishes the dominant orb, wide unboxed messages, fade mask, and bottom composer", () => {
    expect(phase132Css).toMatch(/--bea-orb-diameter:\s*clamp\(15rem,\s*33vh,\s*26\.875rem\);/u);
    expect(phase132Css).toMatch(
      /\.orbLayer \.orb\s*\{[\s\S]*?height:\s*var\(--bea-orb-diameter\);[\s\S]*?width:\s*var\(--bea-orb-diameter\);/u,
    );
    expect(phase132Css).toMatch(
      /\.messages\s*\{[\s\S]*?-webkit-mask-image:\s*linear-gradient\([\s\S]*?mask-image:\s*linear-gradient\(/u,
    );
    expect(phase132Css).toMatch(
      /\.messages \.message\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?border:\s*0;[\s\S]*?box-shadow:\s*none;[\s\S]*?width:\s*min\(92%,\s*48rem\);/u,
    );
    expect(phase132Css).toMatch(
      /\.messages \.message\[data-role="user"\]\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?border:\s*0;[\s\S]*?box-shadow:\s*none;[\s\S]*?width:\s*min\(88%,\s*44rem\);/u,
    );
    expect(phase132Css).toMatch(
      /\.composer\s*\{[\s\S]*?align-self:\s*end;[\s\S]*?border-top:\s*1px solid[\s\S]*?grid-row:\s*2;/u,
    );
  });

  it("keeps decoration click-through, tilt bounded, and narrow views tab-switched", () => {
    expect(phase132Css).toMatch(/\.command::before\s*\{[\s\S]*?pointer-events:\s*none;/u);
    expect(phase132Css).toMatch(/\.panel::before\s*\{[\s\S]*?pointer-events:\s*none;/u);
    expect(phase132Css).toMatch(/\.panel::after\s*\{[\s\S]*?pointer-events:\s*none;/u);
    expect(phase132Css).toMatch(/\.orbLayer\s*\{[\s\S]*?pointer-events:\s*none;/u);
    expect(phase132Css).not.toMatch(
      /\.panel\s*\{[\s\S]*?rotateX\(var\(--bea-tile-rotate-x\)\)[\s\S]*?rotateY\(var\(--bea-tile-rotate-y\)\)/u,
    );
    expect(cockpitSource).toContain("Math.max(0, Math.min(1,");
    expect(cockpitSource).not.toMatch(/\(0\.5 - normalizedY\) \* 1\.4/u);
    expect(cockpitSource).not.toMatch(/\(normalizedX - 0\.5\) \* 1\.4/u);
    expect(cockpitSource).toContain('event.pointerType === "touch"');
    expect(moduleCss).toMatch(
      /@media \(max-width: 64rem\)\s*\{[\s\S]*?\.panelSwitch\s*\{[\s\S]*?display:\s*grid;[\s\S]*?\.panel\s*\{[\s\S]*?display:\s*none;[\s\S]*?\.conversation\[data-mobile-active="true"\],[\s\S]*?\.workspace\[data-mobile-active="true"\]\s*\{[\s\S]*?display:\s*grid;[\s\S]*?\.divider\s*\{[\s\S]*?display:\s*none;/u,
    );
    expect(phase132Css).toMatch(
      /:global\(:root\[data-motion-profile="reduced"\]\) \.panel,[\s\S]*?transform:\s*none !important;/u,
    );
    expect(phase132Css).toMatch(/\.error\s*\{[\s\S]*?grid-row:\s*1;[\s\S]*?z-index:\s*24;/u);
    expect(phase132Css).toMatch(
      /\.workspaceBody :global\(\.bea-ai-artifact-empty\)[\s\S]*?align-content:\s*center;/u,
    );
  });
});
