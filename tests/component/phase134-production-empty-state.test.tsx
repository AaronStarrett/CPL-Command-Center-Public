import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { WorkspaceRenderer } from "../../apps/web/components/workspace-renderer";
import type { AiCommandArtifactView } from "../../apps/web/lib/ai-command-contracts";
import {
  createRuntimePresentation,
  providerHealthPresentation,
} from "../../apps/web/lib/production-presentation";

function setupRequiredArtifact(): AiCommandArtifactView {
  return {
    id: "phase134-setup-required",
    type: "empty",
    title: "Connect OpenAI",
    subtitle: "OpenAI setup required",
    state: "empty",
    payload: {
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
    sources: [],
    links: [],
    requiredPermissions: ["ai-command.view"],
    createdAt: "2026-08-24T12:00:00.000Z",
    errorCode: null,
  };
}

describe("Phase 1.3.4 production empty presentation", () => {
  it("provides Local Live copy with no development-only labels", () => {
    const presentation = createRuntimePresentation(
      { appMode: "production", runtimeMode: "production" },
      "local-live",
    );

    expect(presentation.profileLabel).toBe("Local Live Production");
    expect(presentation.production).toBe(true);
    expect(presentation.localLive).toBe(true);
    expect(JSON.stringify(presentation)).not.toMatch(
      /demo(?: mode| administration| identity| email| data)?|synthetic|simulat|test-only|persona/iu,
    );
  });

  it("maps disconnected production providers to unavailable instead of simulated", () => {
    expect(providerHealthPresentation("not-configured", true)).toBe("unavailable");
    expect(providerHealthPresentation("connection-failed", true)).toBe("degraded");
    expect(providerHealthPresentation("connected", true)).toBe("healthy");
    expect(providerHealthPresentation("not-configured", false)).toBe("simulated");
  });

  it("renders an honest setup-required state without substitute-content terminology", () => {
    render(
      <WorkspaceRenderer
        artifact={setupRequiredArtifact()}
        canExecuteTaskAction={false}
        onConfirmAction={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/BEA will not substitute provider answers or business records/iu),
    ).toBeVisible();
    expect(screen.getAllByText("Setup required")).toHaveLength(2);
    const visibleText = screen.getByTestId("workspace-artifact-empty").textContent ?? "";
    expect(visibleText).not.toMatch(/demo mode|synthetic|simulated|test-only/iu);
  });
});
