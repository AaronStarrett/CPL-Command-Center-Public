import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpenAiAdministrationPanel } from "../../apps/web/components/openai-administration-panel";
import type { OpenAiAdministrationView } from "../../apps/web/lib/openai-administration-client";
import { createUnconfiguredAiRoutingProfile, type AiProviderSettings } from "@bea/domain";
import { setTestRouterReplace } from "./stubs/next-navigation";

function settings(): AiProviderSettings {
  return {
    mode: "openai",
    defaultTextModel: "gpt-5.6-sol",
    defaultRealtimeModel: "gpt-realtime",
    defaultVoice: "coral",
    webSearchAllowed: false,
    webSearchDefault: false,
    codeInterpreterAllowed: false,
    imageGenerationAllowed: false,
    pdfGenerationAllowed: true,
    realtimeAllowed: false,
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
    apiKeyStatus: "configured",
    apiKeySource: "server_runtime",
    apiKeyFingerprint: "sha256:bounded",
    protectedStorageAvailable: false,
    serverCredentialAvailable: true,
    connectionStatus: "configured_not_tested",
    liveConnected: false,
    providerStatus: "CONFIGURED_NOT_TESTED",
    capabilityRegistryVersion: "phase2.2-v1",
    routingProfile: createUnconfiguredAiRoutingProfile(),
    recommendedRoutingProfile: createUnconfiguredAiRoutingProfile(),
    vectorStoreIds: [],
    voiceCatalog: [],
    voicePreference: null,
    lastTest: null,
    lastSuccessfulTest: null,
    lastFailedTest: null,
    cachedModels: [
      {
        id: "cache-1",
        provider: "openai",
        modelId: "gpt-5.6-sol",
        available: true,
        ownedBy: "openai",
        capabilities: { responsesText: "candidate", streaming: "candidate" },
        capabilitySource: "registry",
        validation: {
          registryVersion: "test",
          validatedAt: null,
          validationMethod: "unknown",
          evidence: {},
        },
        fetchedAt: "2026-08-31T00:00:00.000Z",
        expiresAt: "2026-08-31T01:00:00.000Z",
        createdAt: "2026-08-31T00:00:00.000Z",
        updatedAt: "2026-08-31T00:00:00.000Z",
        version: 1,
      },
    ],
    billingNotice: "OpenAI API billing is separate from ChatGPT subscriptions.",
    progressiveActivation: {
      liveText: "candidate",
      publicWebResearch: "unavailable",
      realtimeVoice: "unavailable",
      pdfAndArtifacts: "blocked",
      liveTextReady: false,
      researchReady: false,
      realtimeReady: false,
      activationBlockers: [
        "Live text requires a verified Responses text model on Executive / Premium.",
      ],
    },
    diagnostics: {
      credentialSource: "Server runtime credential",
      credentialConfigured: true,
      authenticatedTest: "not_run",
      modelListRequest: "not_run",
      modelsReturned: 1,
      modelsCached: 1,
      responsesCandidates: 1,
      webSearchCandidates: 0,
      realtimeCandidates: 0,
      selectedRouteModels: {},
      activationBlockers: [
        "Live text requires a verified Responses text model on Executive / Premium.",
      ],
      lastSafeErrorCode: null,
      correlationId: "corr-1",
      lastTestTime: null,
      providerLatencyMs: null,
      zeroModels: false,
    },
    ...overrides,
  };
}

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Phase 2.2 OpenAI owner diagnostics", () => {
  beforeEach(() => {
    setTestRouterReplace(vi.fn());
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("discovers models from a server credential without a paste field or DPAPI", async () => {
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith("/connect") && init?.method === "POST") {
        return response(
          administration({
            liveConnected: true,
            connectionStatus: "connected",
            providerStatus: "CONNECTED",
            progressiveActivation: {
              liveText: "verified",
              publicWebResearch: "unavailable",
              realtimeVoice: "unavailable",
              pdfAndArtifacts: "candidate",
              liveTextReady: true,
              researchReady: false,
              realtimeReady: false,
              activationBlockers: [],
            },
          }),
        );
      }
      return response(administration());
    });
    render(<OpenAiAdministrationPanel />);
    expect(await screen.findByText("Server credential available")).toBeInTheDocument();
    expect(screen.queryByTestId("openai-api-key")).toBeNull();
    fireEvent.click(screen.getByTestId("openai-test-discover"));
    const connect = vi
      .mocked(fetch)
      .mock.calls.find(
        ([input, init]) => String(input).endsWith("/connect") && init?.method === "POST",
      );
    expect(JSON.parse(String(connect?.[1]?.body))).toEqual({ useExistingCredential: true });
    expect(JSON.stringify(connect?.[1]?.body)).not.toMatch(/sk-/u);
    expect(screen.getByTestId("openai-status-live-text")).toHaveTextContent("Live text");
    expect(screen.getByTestId("openai-owner-diagnostics")).toBeInTheDocument();
  });

  it("explains a zero-model inventory instead of leaving an empty selector", async () => {
    vi.mocked(fetch).mockResolvedValue(
      response(
        administration({
          cachedModels: [],
          diagnostics: {
            credentialSource: "Server runtime credential",
            credentialConfigured: true,
            authenticatedTest: "pass",
            modelListRequest: "pass",
            modelsReturned: 0,
            modelsCached: 0,
            responsesCandidates: 0,
            webSearchCandidates: 0,
            realtimeCandidates: 0,
            selectedRouteModels: {},
            activationBlockers: [],
            lastSafeErrorCode: null,
            correlationId: "corr-zero",
            lastTestTime: "2026-08-31T00:00:00.000Z",
            providerLatencyMs: 12,
            zeroModels: true,
          },
        }),
      ),
    );
    render(<OpenAiAdministrationPanel />);
    expect(
      await screen.findAllByText(
        "OpenAI returned zero available models for this project credential.",
      ),
    ).not.toHaveLength(0);
  });
});
