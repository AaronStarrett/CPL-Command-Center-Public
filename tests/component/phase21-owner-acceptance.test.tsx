import { render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OwnerLiveAcceptanceCenter } from "../../apps/web/components/owner-live-acceptance-center";
import type { OwnerLiveAcceptanceView } from "../../apps/web/lib/owner-live-acceptance-client";

function view(overrides: Partial<OwnerLiveAcceptanceView> = {}): OwnerLiveAcceptanceView {
  return {
    contractVersion: "phase2.1-owner-acceptance-v1",
    applicationVersion: "phase-2.1",
    gitSha: "deadbeef",
    ownerLiveStatus: "NOT_RUN",
    physicalConfirmable: false,
    physicalConfirmationReason:
      "Cloud, CI, and automated tests cannot mark physical Owner Live observations PASS.",
    provider: "demo",
    selectedModel: "gpt-safe-text",
    realtimeModel: "gpt-safe-realtime",
    connectionStatus: "not_configured",
    providerStatus: "SETUP_REQUIRED",
    apiKeyFingerprint: null,
    lastTestLatencyMs: null,
    syntheticDataDisclosure: "synthetic BEA demonstration data",
    externalIntegrations: "NOT CONNECTED",
    technicalEvidence: [
      {
        id: "connection_test",
        label: "Connection test",
        serverEvidence: "NOT_RUN",
        ownerLiveStatus: "NOT_RUN",
      },
    ],
    physicalObservations: [
      {
        id: "heard_ai_speak",
        label: "I heard the AI speak",
        status: "NOT_RUN",
        confirmedAt: null,
        actorUserId: null,
      },
    ],
    chargeableCallWarning: "This page does not call OpenAI when it loads.",
    ...overrides,
  };
}

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Phase 2.1 owner live acceptance center", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("loads setup steps without firing chargeable OpenAI routes", async () => {
    vi.mocked(fetch).mockResolvedValue(response(view()));
    render(
      <OwnerLiveAcceptanceCenter
        administration={<div data-testid="openai-administration-stub" />}
      />,
    );
    expect(await screen.findByTestId("owner-live-acceptance-center")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "OpenAI Provider", exact: true }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Model Discovery" })).toBeInTheDocument();
    expect(screen.getByText("Refresh models")).toBeInTheDocument();
    expect(screen.getByText("Start live voice")).toBeInTheDocument();
    expect(screen.getByTestId("owner-acceptance-copy-test-a-lead-review")).toBeInTheDocument();
    expect(screen.getByTestId("owner-acceptance-confirm-heard_ai_speak")).toBeDisabled();
    expect(screen.getByText("I heard the AI speak")).toBeInTheDocument();
    expect(screen.getAllByText("NOT_RUN").length).toBeGreaterThan(0);
    const urls = vi.mocked(fetch).mock.calls.map((entry) => String(entry[0]));
    expect(urls.every((url) => !url.includes("/api/integrations/ai/test"))).toBe(true);
    expect(urls.every((url) => !url.includes("/api/integrations/ai/models"))).toBe(true);
    expect(urls.every((url) => !url.includes("/api/integrations/ai/secret"))).toBe(true);
  });

  it("does not let Cloud mark a physical observation PASS from the loaded demo state", async () => {
    vi.mocked(fetch).mockResolvedValue(response(view()));
    render(
      <OwnerLiveAcceptanceCenter
        administration={<div data-testid="openai-administration-stub" />}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("owner-acceptance-physical")).toHaveTextContent("NOT_RUN"),
    );
    expect(screen.queryByText("CONFIRMED")).not.toBeInTheDocument();
  });
});
