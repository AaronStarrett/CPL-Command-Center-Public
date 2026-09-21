import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpenAiAdministrationPanel } from "../../apps/web/components/openai-administration-panel";
import type { OpenAiAdministrationView } from "../../apps/web/lib/openai-administration-client";
import { createUnconfiguredAiRoutingProfile, type AiProviderSettings } from "@bea/domain";
import { setTestRouterReplace } from "./stubs/next-navigation";

const routerReplace = vi.fn();

function settings(): AiProviderSettings {
  return {
    mode: "openai",
    defaultTextModel: "gpt-safe-text",
    defaultRealtimeModel: "gpt-safe-realtime",
    defaultVoice: "coral",
    webSearchAllowed: true,
    webSearchDefault: true,
    codeInterpreterAllowed: false,
    imageGenerationAllowed: false,
    pdfGenerationAllowed: true,
    realtimeAllowed: true,
    requestTimeoutMs: 30_000,
    modelCacheTtlSeconds: 3_600,
    dailyRequestLimit: 100,
    perUserRequestsPerMinute: 10,
    perConversationRequestsPerMinute: 10,
    maxUploadBytes: 10_000_000,
    maxGeneratedFileBytes: 25_000_000,
    maxResearchDurationSeconds: 300,
    codeInterpreterMaxContainerSeconds: 300,
    imageQuality: "medium",
    defaultChartType: "bar",
    defaultPdfTemplate: "standard",
    artifactRetentionDays: 30,
    monthlyCostLimitUsd: null,
    highCostConfirmationThresholdUsd: null,
    realtimeTurnDetection: "server_vad",
    realtimeInteractionMode: "automatic",
    realtimeAllowInterruption: true,
    inputTranscriptionModel: "gpt-safe-transcribe",
    realtimeOutputSpeed: 1,
    realtimeSessionInstructions: "Use registered tools only.",
    realtimeMaxOutputTokens: 2_048,
    modelCapabilityOverrides: {},
    routingProfile: createUnconfiguredAiRoutingProfile(),
  };
}

function administration(
  overrides: Partial<OpenAiAdministrationView> = {},
): OpenAiAdministrationView {
  return {
    settings: settings(),
    apiKeyStatus: "not_configured",
    apiKeySource: "none",
    apiKeyFingerprint: null,
    protectedStorageAvailable: true,
    connectionStatus: "not_configured",
    liveConnected: false,
    providerStatus: "SETUP_REQUIRED",
    capabilityRegistryVersion: "phase1.3.3-v1",
    routingProfile: createUnconfiguredAiRoutingProfile(),
    recommendedRoutingProfile: createUnconfiguredAiRoutingProfile(),
    vectorStoreIds: [],
    voiceCatalog: [
      {
        id: "coral",
        displayName: "Coral",
        description: "Warm, clear, and conversational",
        source: "built_in",
        previewAvailable: true,
      },
    ],
    voicePreference: null,
    lastTest: null,
    lastSuccessfulTest: null,
    lastFailedTest: null,
    cachedModels: [],
    billingNotice: "OpenAI API billing is separate from ChatGPT subscriptions.",
    ...overrides,
  };
}

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("OpenAI owner connection wizard", () => {
  beforeEach(() => {
    routerReplace.mockReset();
    setTestRouterReplace(routerReplace);
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("connects from the key field without a Demo or Hybrid dropdown", async () => {
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith("/connect") && init?.method === "POST") {
        return response(
          administration({
            apiKeyStatus: "configured",
            apiKeySource: "windows_protected",
            apiKeyFingerprint: "sha256:connected0001",
            liveConnected: true,
            connectionStatus: "connected",
            providerStatus: "CONNECTED",
          }),
        );
      }
      return response(administration());
    });
    render(<OpenAiAdministrationPanel />);
    await screen.findByTestId("openai-api-key");
    expect(screen.queryByRole("option", { name: "Demo" })).toBeNull();
    expect(screen.queryByTestId("openai-activation-mode")).toBeNull();
    expect(screen.getByTestId("openai-connection-state")).toHaveTextContent("OPENAI NOT CONNECTED");
    fireEvent.change(screen.getByTestId("openai-api-key"), {
      target: { value: "bea-openai-test-key-20ch" },
    });
    fireEvent.click(screen.getByTestId("openai-save-secret"));
    await screen.findByTestId("openai-ready-status");
    expect(screen.getByTestId("openai-connection-state")).toHaveTextContent("OPENAI CONNECTED");
    const connect = vi
      .mocked(fetch)
      .mock.calls.find(
        ([input, init]) => String(input).endsWith("/connect") && init?.method === "POST",
      );
    expect(connect).toBeDefined();
    expect(JSON.parse(String(connect?.[1]?.body))).toEqual({
      apiKey: "bea-openai-test-key-20ch",
    });
    expect(screen.getByTestId("openai-api-key")).toHaveValue("");
    expect(screen.getByTestId("openai-owner-routes")).toBeInTheDocument();
    expect(screen.getByTestId("openai-owner-capabilities")).toBeInTheDocument();
    expect(screen.getByTestId("openai-owner-web-search")).toBeInTheDocument();
  });

  it("does not cover routing controls with a sticky save footer", async () => {
    vi.mocked(fetch).mockResolvedValue(response(administration({ liveConnected: true })));
    render(<OpenAiAdministrationPanel />);
    await screen.findByTestId("openai-save-settings");
    const css = await import("node:fs").then((fs) =>
      fs.readFileSync("apps/web/components/openai-administration.module.css", "utf8"),
    );
    expect(css).toMatch(/\.footerActions\s*\{[\s\S]*?position:\s*static;/u);
    expect(css).not.toMatch(/\.footerActions\s*\{[\s\S]*?position:\s*sticky;/u);
    expect(screen.getByTestId("openai-save-routing")).toBeInTheDocument();
  });
});
