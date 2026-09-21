import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/application-pdf-viewer", () => ({
  ApplicationPdfViewer: ({ title }: { readonly title: string }) => (
    <div data-testid="application-pdf-viewer" data-state="ready">
      <div data-testid="workspace-pdf-scroller" data-scroll-owner="pdf" tabIndex={0}>
        {title}
      </div>
    </div>
  ),
}));

import { AiCommandWorkspace } from "../../apps/web/components/ai-command-workspace";
import type {
  AiCommandArtifactView,
  AiCommandSnapshot,
} from "../../apps/web/lib/ai-command-contracts";
import { setTestRouterReplace } from "./stubs/next-navigation";

const conversations = [
  { id: "conversation-1", title: "First conversation", updatedAt: "2026-08-22T12:00:00.000Z" },
  { id: "conversation-2", title: "Second conversation", updatedAt: "2026-08-22T13:00:00.000Z" },
] as const;

function artifact(id: string, title: string, payload: AiCommandArtifactView["payload"] = {}) {
  return {
    id,
    type: "help",
    title,
    subtitle: "Deterministic Phase 1.3.3 fixture",
    state: "ready",
    payload,
    sources: [],
    links: [],
    requiredPermissions: ["ai-command.view"],
    createdAt: "2026-08-22T12:00:00.000Z",
    errorCode: null,
  } satisfies AiCommandArtifactView;
}

function snapshot(
  conversationIndex = 0,
  artifactOverride = artifact(
    `artifact-${conversationIndex + 1}`,
    `Artifact ${conversationIndex + 1}`,
  ),
): AiCommandSnapshot {
  const conversation = conversations[conversationIndex] ?? conversations[0];
  return {
    conversation,
    conversations,
    messages: Array.from({ length: 8 }, (_, index) => ({
      id: `${conversation.id}-message-${index}`,
      role: index % 2 === 0 ? ("assistant" as const) : ("user" as const),
      content: `Conversation ${conversationIndex + 1} message ${index + 1}`,
      createdAt: `2026-08-22T12:${String(index).padStart(2, "0")}:00.000Z`,
      provider: "simulated",
      model: null,
      executionMs: 0,
      links: [],
    })),
    artifact: artifactOverride,
    provider: {
      name: "BEA deterministic demo assistant",
      mode: "SIMULATED",
      model: "deterministic-demo-router",
      routerVersion: "phase133-test-router",
      liveConnected: false,
      simulated: true,
    },
    permissions: { canExecuteTaskAction: true },
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
      promptVersion: "phase133-test-prompt",
      executiveProfileVersion: "phase133-test-profile",
      brandPolicyVersion: "bea-artifact-brand-v1",
      artifactTemplateVersion: "bea-artifact-template-v1",
    },
  };
}

function jsonResponse(value: AiCommandSnapshot, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function setScrollMetrics(element: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperties(element, {
    clientHeight: { configurable: true, get: () => clientHeight },
    scrollHeight: { configurable: true, get: () => scrollHeight },
    scrollTop: { configurable: true, value: 0, writable: true },
  });
}

beforeEach(() => {
  setTestRouterReplace(vi.fn());
  window.localStorage.clear();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Phase 1.3.3 cockpit scroll ownership", () => {
  it("pauses auto-follow after manual transcript scrolling and exposes a focus-neutral jump", async () => {
    const current = snapshot(0);
    const next: AiCommandSnapshot = {
      ...current,
      messages: [
        ...current.messages,
        {
          id: "conversation-1-message-latest",
          role: "assistant",
          content: "Latest deterministic response",
          createdAt: "2026-08-22T12:20:00.000Z",
          provider: "simulated",
          model: null,
          executionMs: 1,
          links: [],
        },
      ],
    };
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            generation: 1,
            requestId: "a1100000-0000-4000-8000-000000000001",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(jsonResponse(next, 201));

    render(<AiCommandWorkspace initialSnapshot={snapshot()} />);
    const scroller = screen.getByTestId("ai-message-scroller");
    setScrollMetrics(scroller, 1_200, 320);
    await new Promise<void>((resolveFrame) => window.requestAnimationFrame(() => resolveFrame()));
    scroller.scrollTop = 180;
    scroller.focus();
    fireEvent.scroll(scroller);

    const jump = await screen.findByRole("button", { name: "Jump to latest message" });
    expect(document.activeElement).toBe(scroller);
    expect(scroller).toHaveAttribute("data-auto-follow", "paused");

    const composer = screen.getByRole("textbox", { name: "Message BEA AI Command" });
    fireEvent.change(composer, { target: { value: "Show all companies" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await screen.findByText("Latest deterministic response");
    expect(scroller.scrollTop).toBe(180);
    expect(jump).toBeInTheDocument();

    fireEvent.click(jump);
    expect(scroller.scrollTop).toBe(1_200);
    expect(scroller).toHaveAttribute("data-auto-follow", "following");
    expect(screen.queryByTestId("ai-jump-to-latest")).not.toBeInTheDocument();
  });

  it("resets a new workspace artifact to top and restores each normal artifact position", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(snapshot(1)))
      .mockResolvedValueOnce(jsonResponse(snapshot(0)));
    render(<AiCommandWorkspace initialSnapshot={snapshot(0)} />);

    const workspace = screen.getByTestId("ai-workspace-scroller");
    setScrollMetrics(workspace, 2_000, 500);
    workspace.scrollTop = 340;
    fireEvent.scroll(workspace);

    const history = screen.getByRole("combobox", { name: "Saved conversations" });
    fireEvent.change(history, { target: { value: "conversation-2" } });
    await screen.findByRole("heading", { name: "Artifact 2" });
    await waitFor(() => expect(workspace.scrollTop).toBe(0));

    workspace.scrollTop = 690;
    fireEvent.scroll(workspace);
    fireEvent.change(history, { target: { value: "conversation-1" } });
    await screen.findByRole("heading", { name: "Artifact 1" });
    await waitFor(() => expect(workspace.scrollTop).toBe(340));
    expect(workspace).toHaveAttribute("data-scroll-owner", "workspace");
  });

  it("keeps decorative orb layers inert and hands PDF scrolling to the PDF viewer", () => {
    const pdf = artifact("artifact-pdf", "Authorized PDF", {
      renderer: "pdf-preview",
      src: "/api/artifacts/report/preview",
    });
    render(<AiCommandWorkspace initialSnapshot={snapshot(0, pdf)} />);

    fireEvent.click(screen.getByTestId("ai-interaction-mode-voice"));
    const orb = screen.getByTestId("bea-ai-orb");
    expect(orb.tagName).toBe("DIV");
    expect(orb).toHaveAttribute("data-orb-layer", "outer-glass");
    expect(orb.querySelector('[data-orb-layer="internal-glow"]')).not.toBeNull();
    expect(orb.querySelector('[data-orb-layer="core-mark"]')).not.toBeNull();
    expect(orb.querySelector('[data-orb-layer="foreground-highlight"]')).not.toBeNull();
    expect(orb.querySelector(".bea-ai-orb__mic")).toBeNull();
    expect(screen.getAllByTestId("ai-message-scroller")).toHaveLength(1);
    expect(screen.getByTestId("ai-workspace-scroller")).toHaveAttribute("data-scroll-owner", "pdf");
    expect(screen.getByTestId("workspace-pdf-scroller")).toHaveAttribute(
      "data-scroll-owner",
      "pdf",
    );

    const moduleCss = readFileSync(
      resolve(process.cwd(), "apps/web/components/ai-command.module.css"),
      "utf8",
    );
    expect(moduleCss).toMatch(/\.orbLayer \.orb\s*\{[\s\S]*?pointer-events:\s*none;/u);
    expect(moduleCss).toMatch(
      /\.conversation\[data-interaction-mode="voice"\] \.orbLayer\s*\{[\s\S]*?position:\s*relative;/u,
    );
    expect(moduleCss).toMatch(/\.messages\s*\{[\s\S]*?align-content:\s*safe end;/u);
    expect(moduleCss).toMatch(/\.tableWrap\s*\{[\s\S]*?overflow-y:\s*clip;/u);
  });

  it("persists the default-on spoken-response preference from live voice controls", async () => {
    const current = snapshot();
    const live: AiCommandSnapshot = {
      ...current,
      provider: {
        ...current.provider,
        name: "OpenAI",
        mode: "openai",
        status: "CONNECTED",
        providerStatus: "CONNECTED",
        liveConnected: true,
        realtimeAllowed: true,
        realtimeModel: "gpt-realtime-test",
        voice: "marin",
        speakResponses: true,
      },
    };
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          preference: {
            userId: live.actingUser.id,
            speakResponses: false,
            version: 2,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    render(<AiCommandWorkspace initialSnapshot={live} />);
    fireEvent.click(screen.getByTestId("ai-interaction-mode-voice"));
    const preference = screen.getByRole("switch", { name: "Speak responses: On" });
    expect(preference).toHaveAttribute("aria-checked", "true");
    fireEvent.click(preference);

    await screen.findByRole("switch", { name: "Speak responses: Off" });
    expect(fetch).toHaveBeenCalledWith(
      "/api/ai-command/realtime/preferences",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ speakResponses: false }),
      }),
    );
  });
});
