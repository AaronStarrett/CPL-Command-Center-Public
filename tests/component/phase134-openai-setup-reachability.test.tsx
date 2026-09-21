import { fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/openai-administration-panel", () => ({
  OpenAiAdministrationPanel: ({ compact = false }: { readonly compact?: boolean }) => (
    <section data-testid="openai-administration-panel" data-compact={String(compact)}>
      <h2>Connect OpenAI</h2>
      <p>Protected owner setup</p>
    </section>
  ),
}));

import { AiCommandWorkspace } from "../../apps/web/components/ai-command-workspace";
import type { AiCommandSnapshot } from "../../apps/web/lib/ai-command-contracts";
import { setTestRouterReplace } from "./stubs/next-navigation";

const routerReplace = vi.fn();

function productionSnapshot(canConfigureOpenAi: boolean): AiCommandSnapshot {
  const conversation = {
    id: "conversation-phase134",
    title: "Existing owner conversation",
    updatedAt: "2026-08-24T12:00:00.000Z",
  };
  return {
    conversation,
    conversations: [conversation],
    messages: [
      {
        id: "message-phase134",
        role: "assistant",
        content: "OpenAI setup is required before live requests can run.",
        createdAt: "2026-08-24T12:00:00.000Z",
        provider: null,
        model: null,
        executionMs: null,
        links: [],
      },
    ],
    artifact: {
      id: "artifact-existing-owner-record",
      type: "help",
      title: "Existing authorized workspace",
      subtitle: "Previously selected owner content",
      state: "ready",
      payload: { commands: ["Review current operations"] },
      sources: [],
      links: [],
      requiredPermissions: ["ai-command.view"],
      createdAt: "2026-08-24T12:00:00.000Z",
      errorCode: null,
    },
    provider: {
      name: "OpenAI (activation required)",
      label: "BEA AI Command",
      mode: "openai",
      status: "SETUP_REQUIRED",
      providerStatus: "SETUP_REQUIRED",
      simulated: false,
      model: "unconfigured",
      routerVersion: "phase1.3-provider-v1",
      liveConnected: false,
      streaming: true,
      webSearchAllowed: false,
      realtimeAllowed: false,
    },
    permissions: {
      canConfigureOpenAi,
      canExecuteTaskAction: false,
      canUploadArtifact: false,
    },
    actingUser: {
      id: "owner-phase134",
      displayName: "Workspace Owner",
      title: "Chief Executive Officer",
    },
    assistant: {
      kind: "executive-business-partner",
      preferredName: "Owner",
      label: "Ask BEA",
      subtitle: "Executive operating partner",
      promptVersion: "phase1.3.4",
      executiveProfileVersion: null,
      brandPolicyVersion: "phase1.3.4",
      artifactTemplateVersion: "phase1.3.4",
    },
  };
}

describe("Phase 1.3.4 OpenAI setup reachability", () => {
  beforeEach(() => {
    routerReplace.mockReset();
    setTestRouterReplace(routerReplace);
    vi.stubGlobal("fetch", vi.fn());
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    window.history.replaceState(null, "", "/ai-command");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("always replaces existing owner workspace content with protected setup while disconnected", () => {
    render(<AiCommandWorkspace initialSnapshot={productionSnapshot(true)} />);

    const workspace = screen.getByTestId("ai-workspace-panel");
    expect(
      within(screen.getByTestId("ai-workspace-header")).getByRole("heading", {
        name: "Connect OpenAI",
      }),
    ).toBeVisible();
    expect(within(workspace).getByText("OpenAI setup required")).toBeVisible();
    expect(within(workspace).getByTestId("openai-administration-panel")).toHaveAttribute(
      "data-compact",
      "true",
    );
    expect(within(workspace).getByTestId("ai-workspace-scroller")).toHaveAttribute(
      "data-scroll-owner",
      "workspace",
    );
    expect(within(workspace).queryByText("Existing authorized workspace")).not.toBeInTheDocument();

    const visibleText = screen.getByTestId("ai-command-workspace").textContent ?? "";
    expect(visibleText).not.toMatch(/demo mode|synthetic|simulated|test-only/iu);
  });

  it("fails closed before any AI request while setup is required", async () => {
    render(<AiCommandWorkspace initialSnapshot={productionSnapshot(true)} />);

    const composer = screen.getByRole("textbox", { name: "Message BEA AI Command" });
    fireEvent.change(composer, { target: { value: "Summarize current priorities" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    expect(await screen.findByText(/OpenAI setup required\. Use Connect OpenAI/iu)).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not expose provider configuration to an account without administration permission", () => {
    render(<AiCommandWorkspace initialSnapshot={productionSnapshot(false)} />);

    expect(screen.queryByTestId("openai-administration-panel")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Connect OpenAI" })).not.toBeInTheDocument();
  });
});
