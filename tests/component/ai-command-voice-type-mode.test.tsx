import { fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AiCommandWorkspace } from "../../apps/web/components/ai-command-workspace";
import type {
  AiCommandArtifactView,
  AiCommandSnapshot,
} from "../../apps/web/lib/ai-command-contracts";
import { setTestRouterReplace } from "./stubs/next-navigation";

const navigation = { replace: vi.fn() };

function artifact(overrides: Partial<AiCommandArtifactView> = {}): AiCommandArtifactView {
  return {
    id: "artifact-mode",
    type: "company-list",
    title: "Companies",
    subtitle: "Synthetic BEA records",
    state: "ready",
    payload: {
      items: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          title: "Northstar Envelope",
          href: "/companies/11111111-1111-4111-8111-111111111111",
        },
      ],
    },
    sources: [],
    links: [{ label: "View companies", href: "/companies" }],
    requiredPermissions: ["companies.view"],
    createdAt: "2026-08-30T12:00:00.000Z",
    errorCode: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<AiCommandSnapshot> = {}): AiCommandSnapshot {
  const conversation = {
    id: "conversation-mode",
    title: "Mode test",
    updatedAt: "2026-08-30T12:00:00.000Z",
  };
  return {
    conversation,
    conversations: [conversation],
    messages: [
      {
        id: "message-1",
        role: "user",
        content: "Show companies",
        createdAt: "2026-08-30T12:00:00.000Z",
        provider: "openai",
        executionMs: 12,
        links: [],
      },
      {
        id: "message-2",
        role: "assistant",
        content: "Here are the companies.",
        createdAt: "2026-08-30T12:01:00.000Z",
        provider: "openai",
        executionMs: 40,
        links: [{ label: "View companies", href: "/companies" }],
      },
    ],
    artifact: artifact(),
    provider: {
      name: "OpenAI",
      mode: "CONNECTED",
      model: "gpt-test",
      routerVersion: "phase21",
      liveConnected: true,
      simulated: false,
      speakResponses: true,
    },
    permissions: { canExecuteTaskAction: true, canConfigureOpenAi: true },
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

describe("AI Command Voice and Type modes", () => {
  beforeEach(() => {
    navigation.replace.mockReset();
    setTestRouterReplace(navigation.replace);
    vi.stubGlobal("fetch", vi.fn());
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders Type Mode without the orb and with the composer", () => {
    render(<AiCommandWorkspace initialSnapshot={snapshot()} />);
    expect(screen.getByTestId("ai-interaction-mode-type")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("ai-command-composer")).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("ai-message-scroller")).toBeVisible();
    expect(screen.queryByTestId("bea-ai-orb")).not.toBeVisible();
    expect(screen.queryByTestId("bea-composer-voice")).toBeNull();
  });

  it("renders Voice Mode with the orb and without the transcript or composer", () => {
    render(<AiCommandWorkspace initialSnapshot={snapshot()} />);
    fireEvent.click(screen.getByTestId("ai-interaction-mode-voice"));
    expect(screen.getByTestId("ai-interaction-mode-voice")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("bea-ai-orb")).toBeVisible();
    expect(screen.getByTestId("ai-voice-stage")).toBeInTheDocument();
    expect(screen.getByTestId("ai-command-composer")).toHaveAttribute("hidden");
    expect(screen.queryByRole("heading", { name: "Ask BEA" })).toBeNull();
    expect(screen.queryByTestId("bea-ai-orb-control")).toBeNull();
  });

  it("keeps conversation and workspace when switching modes and stops voice on Type", () => {
    render(<AiCommandWorkspace initialSnapshot={snapshot()} />);
    fireEvent.click(screen.getByTestId("ai-interaction-mode-voice"));
    expect(screen.getByTestId("ai-command-workspace")).toHaveAttribute(
      "data-interaction-mode",
      "voice",
    );
    fireEvent.click(screen.getByTestId("ai-interaction-mode-type"));
    expect(screen.getByTestId("ai-command-workspace")).toHaveAttribute(
      "data-interaction-mode",
      "type",
    );
    expect(screen.getByTestId("ai-command-workspace")).toHaveAttribute(
      "data-voice-session",
      "idle",
    );
    expect(screen.getByText("Here are the companies.")).toBeInTheDocument();
    expect(screen.getByTestId("ai-workspace-panel")).toHaveTextContent("Companies");
  });

  it("opens View companies inside the right workspace instead of leaving AI Command", async () => {
    const companyList = artifact({ id: "artifact-companies-workspace", title: "Companies" });
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ artifact: companyList, path: "/companies", parentPath: null }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<AiCommandWorkspace initialSnapshot={snapshot()} />);
    fireEvent.click(screen.getAllByRole("link", { name: "View companies" })[0]!);
    await screen.findByTestId("ai-workspace-back");
    expect(screen.getByTestId("ai-workspace-back")).not.toBeDisabled();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/ai-command/workspace",
      expect.objectContaining({ method: "POST" }),
    );
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("keeps desktop, tablet, and compact mode toggles in the conversation tile", () => {
    render(<AiCommandWorkspace initialSnapshot={snapshot()} />);
    const conversation = screen.getByTestId("ai-conversation-panel");
    expect(within(conversation).getByTestId("ai-interaction-mode-voice")).toBeInTheDocument();
    expect(within(conversation).getByTestId("ai-interaction-mode-type")).toBeInTheDocument();
  });
});
