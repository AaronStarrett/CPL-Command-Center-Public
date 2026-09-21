import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpenAiAdministrationPanel } from "../../apps/web/components/openai-administration-panel";
import type { OpenAiAdministrationView } from "../../apps/web/lib/openai-administration-client";
import {
  createUnconfiguredAiRoutingProfile,
  type AiModelRoutingProfile,
  type AiProviderSettings,
} from "@bea/domain";
import { setTestRouterReplace } from "./stubs/next-navigation";

const routerReplace = vi.fn();
const now = "2026-08-23T12:00:00.000Z";

function routingProfile(primaryModel: string | null): AiModelRoutingProfile {
  const base = createUnconfiguredAiRoutingProfile();
  return {
    ...base,
    routes: Object.fromEntries(
      Object.entries(base.routes).map(([routeKey, route]) => [
        routeKey,
        {
          ...route,
          primaryModel,
          fallbackModel: primaryModel ? "gpt-fixture-fallback" : null,
        },
      ]),
    ) as unknown as AiModelRoutingProfile["routes"],
  };
}

function settings(profile = routingProfile(null)): AiProviderSettings {
  return {
    mode: "demo",
    defaultTextModel: "gpt-fixture",
    defaultRealtimeModel: "gpt-fixture",
    defaultVoice: "coral",
    webSearchAllowed: false,
    webSearchDefault: false,
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
    inputTranscriptionModel: null,
    realtimeOutputSpeed: 1,
    realtimeSessionInstructions: "Use registered tools only.",
    realtimeMaxOutputTokens: 2_048,
    modelCapabilityOverrides: {},
    routingProfile: profile,
  };
}

const capabilities = {
  responsesText: true,
  streaming: true,
  reasoning: true,
  functionCalling: true,
  structuredOutputs: true,
  webSearch: true,
  fileSearch: true,
  codeInterpreter: true,
  imageGeneration: true,
  imageInput: true,
  fileInput: true,
  realtime: true,
  audioInput: true,
  audioOutput: true,
  embeddings: true,
} as const;

function administration(
  overrides: Partial<OpenAiAdministrationView> = {},
): OpenAiAdministrationView {
  const currentSettings = settings();
  const recommended = routingProfile("gpt-fixture");
  return {
    settings: currentSettings,
    apiKeyStatus: "not_configured",
    apiKeySource: "none",
    apiKeyFingerprint: null,
    protectedStorageAvailable: true,
    connectionStatus: "not_configured",
    liveConnected: false,
    providerStatus: "SETUP_REQUIRED",
    capabilityRegistryVersion: "phase1.3.3-v1",
    routingProfile: currentSettings.routingProfile,
    recommendedRoutingProfile: recommended,
    vectorStoreIds: [],
    voiceCatalog: [
      {
        id: "coral",
        displayName: "Coral",
        description: "Warm, clear, and conversational.",
        source: "built_in",
        previewAvailable: false,
      },
      {
        id: "sage",
        displayName: "Sage",
        description: "Measured and composed.",
        source: "built_in",
        previewAvailable: true,
      },
    ],
    voicePreference: {
      id: "voice-pref-1",
      userId: "user-1",
      speakResponses: false,
      createdAt: now,
      updatedAt: now,
      version: 1,
    },
    lastTest: null,
    lastSuccessfulTest: null,
    lastFailedTest: null,
    cachedModels: ["gpt-fixture", "gpt-fixture-fallback"].map((modelId) => ({
      id: `cache-${modelId}`,
      provider: "openai" as const,
      modelId,
      available: true,
      ownedBy: "openai",
      capabilities,
      capabilitySource: "provider" as const,
      validation: {
        registryVersion: "phase1.3.3-v1",
        validatedAt: now,
        validationMethod: "models_api" as const,
        evidence: {},
      },
      fetchedAt: now,
      expiresAt: "2026-08-24T12:00:00.000Z",
      createdAt: now,
      updatedAt: now,
      version: 1,
    })),
    billingNotice: "OpenAI API billing is separate from ChatGPT subscriptions.",
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Phase 1.3.3 OpenAI administration UI", () => {
  beforeEach(() => {
    routerReplace.mockReset();
    setTestRouterReplace(routerReplace);
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows the evidence-gated first-run path, 12 routes, approved voices, and read-only speech preference", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(administration()));
    render(<OpenAiAdministrationPanel />);

    const firstRun = await screen.findByTestId("openai-first-run");
    expect(within(firstRun).getByRole("heading", { name: "Connect OpenAI" })).toBeInTheDocument();
    expect(within(firstRun).getAllByRole("listitem")).toHaveLength(6);

    fireEvent.click(screen.getByText("Advanced 12-route matrix"));
    const table = screen.getByRole("table", { name: "OpenAI workload routing" });
    expect(within(table).getAllByRole("row")).toHaveLength(13);
    expect(screen.getByTestId("openai-route-realtime_voice")).toHaveTextContent("Realtime voice");
    expect(screen.getByTestId("openai-route-embeddings_indexing")).toHaveTextContent(
      "Embeddings and indexing",
    );

    expect(screen.getByTestId("openai-voice")).toHaveDisplayValue("Coral");
    expect(screen.getByTestId("openai-voice-description")).toHaveTextContent(
      "Warm, clear, and conversational",
    );
    expect(screen.getByTestId("openai-voice-description")).toHaveTextContent(
      "In-app preview is unavailable",
    );
    expect(screen.getByRole("button", { name: "Preview unavailable" })).toBeDisabled();
    expect(screen.getByTestId("openai-speak-responses-status")).toHaveTextContent("OFF");
    expect(screen.getByTestId("openai-speak-responses-status")).toHaveTextContent("Read-only");
  });

  it("keeps the secure setup path in compact mode while omitting unrelated advanced administration", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(administration()));
    render(<OpenAiAdministrationPanel compact />);

    const panel = await screen.findByTestId("openai-administration-panel");
    expect(panel).toHaveAttribute("data-compact", "true");
    expect(screen.getByRole("heading", { name: "Connect OpenAI" })).toBeInTheDocument();
    expect(screen.getByTestId("openai-api-key")).toHaveAttribute("type", "password");
    expect(screen.getByTestId("openai-test-connection")).toBeInTheDocument();
    expect(screen.getByTestId("openai-refresh-models")).toBeInTheDocument();
    expect(screen.getByTestId("openai-reset-route-recommendations")).toBeInTheDocument();
    expect(screen.getByTestId("openai-realtime-model")).toBeInTheDocument();
    expect(screen.getByTestId("openai-voice")).toBeInTheDocument();
    expect(screen.getByTestId("openai-save-settings")).toBeInTheDocument();
    expect(screen.getByTestId("openai-activate")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("openai-compact-route-list")).getAllByTestId(/^openai-route-/u),
    ).toHaveLength(12);

    expect(
      screen.queryByRole("table", { name: "OpenAI workload routing" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("File Search knowledge sources")).not.toBeInTheDocument();
    expect(screen.queryByTestId("openai-manual-model-controls")).not.toBeInTheDocument();
    expect(screen.queryByTestId("openai-capability-editor")).not.toBeInTheDocument();
    expect(screen.queryByTestId("openai-billing-notice")).not.toBeInTheDocument();
    expect(screen.queryByText("Demo")).not.toBeInTheDocument();
    expect(screen.queryByText(/Hybrid — live AI with synthetic BEA data/u)).not.toBeInTheDocument();
    expect(screen.getByTestId("openai-provider-mode")).toHaveTextContent("OPENAI NOT CONNECTED");
  });

  it("loads all recommended routes as one draft and persists them through the existing transactional save", async () => {
    const user = userEvent.setup();
    const view = administration();
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith("/settings") && init?.method === "PUT") {
        return jsonResponse({ settings: JSON.parse(String(init.body)) });
      }
      return jsonResponse(view);
    });
    render(<OpenAiAdministrationPanel />);

    const primary = await screen.findByLabelText("Primary model for Executive conversation");
    expect(primary).toHaveValue("");
    await user.click(screen.getByTestId("openai-reset-route-recommendations"));
    await waitFor(() => expect(primary).toHaveValue("gpt-fixture"));

    const save = screen.getByTestId("openai-save-settings");
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/integrations/ai/settings",
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    const saveCall = vi
      .mocked(fetch)
      .mock.calls.find(
        ([input, init]) => String(input).endsWith("/settings") && init?.method === "PUT",
      );
    const body = JSON.parse(String(saveCall?.[1]?.body)) as AiProviderSettings;
    expect(Object.keys(body.routingProfile.routes)).toHaveLength(12);
    expect(body.routingProfile.routes.executive_conversation.primaryModel).toBe("gpt-fixture");
    expect(JSON.stringify(body)).not.toMatch(/api.?key|credential|access.?token/iu);
  });

  it("strictly validates vector-store IDs and saves an enabled File Search assignment in the routing profile", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith("/settings") && init?.method === "PUT") {
        return jsonResponse({ settings: JSON.parse(String(init.body)) });
      }
      return jsonResponse(administration());
    });
    render(<OpenAiAdministrationPanel />);

    const id = await screen.findByTestId("openai-vector-store-id");
    fireEvent.change(id, { target: { value: "vs_bad!" } });
    await user.click(screen.getByTestId("openai-add-vector-store"));
    expect(await screen.findByText(/Vector store IDs must start with vs_/u)).toBeInTheDocument();

    fireEvent.change(id, { target: { value: "vs_ops123" } });
    fireEvent.change(screen.getByTestId("openai-vector-store-name"), {
      target: { value: "Operations knowledge" },
    });
    await user.click(screen.getByTestId("openai-add-vector-store"));
    await waitFor(() =>
      expect(screen.getByTestId("openai-vector-store-list")).toHaveTextContent(
        "Operations knowledge",
      ),
    );
    expect(screen.getByTestId("openai-vector-store-list")).toHaveTextContent("vs_ops123");

    const save = screen.getByTestId("openai-save-settings");
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/integrations/ai/settings",
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    const saveCall = vi
      .mocked(fetch)
      .mock.calls.find(
        ([input, init]) => String(input).endsWith("/settings") && init?.method === "PUT",
      );
    const body = JSON.parse(String(saveCall?.[1]?.body)) as AiProviderSettings;
    expect(body.routingProfile.vectorStoreAssignments).toEqual([
      {
        vectorStoreId: "vs_ops123",
        displayName: "Operations knowledge",
        allowedRoleKeys: ["owner-admin", "integration-admin"],
        enabled: true,
      },
    ]);
  });

  it("shows capability warnings, toggles routes, and labels route validation as configuration-only", async () => {
    const configured = routingProfile("gpt-fixture");
    const view = administration({
      settings: settings(configured),
      routingProfile: configured,
      cachedModels: administration().cachedModels.map((model) =>
        model.modelId === "gpt-fixture"
          ? { ...model, capabilities: { ...capabilities, webSearch: "unknown" } }
          : model,
      ),
    });
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith("/routes/test") && init?.method === "POST") {
        return jsonResponse({
          decision: { selectedModel: "gpt-fixture" },
          validation: "configuration-only",
          providerCalled: false,
        });
      }
      return jsonResponse(view);
    });
    render(<OpenAiAdministrationPanel />);

    expect(await screen.findByTestId("openai-route-status-public_web_research")).toHaveTextContent(
      "Unverified capabilities: webSearch",
    );
    const enabled = screen.getByLabelText("Enable Executive conversation");
    const routeTest = screen.getByTestId("openai-test-route-executive_conversation");
    fireEvent.click(enabled);
    expect(screen.getByTestId("openai-route-status-executive_conversation")).toHaveTextContent(
      "Route disabled",
    );
    expect(routeTest).toBeDisabled();
    fireEvent.click(enabled);
    fireEvent.click(routeTest);

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/integrations/ai/routes/test",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ routeKey: "executive_conversation" }),
        }),
      ),
    );
    expect(
      await screen.findByTestId("openai-route-test-result-executive_conversation"),
    ).toHaveTextContent("No provider call was made");
  });
});
