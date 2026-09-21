import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpenAiAdministrationPanel } from "../../apps/web/components/openai-administration-panel";
import type { OpenAiAdministrationView } from "../../apps/web/lib/openai-administration-client";
import type { AiProviderSettings } from "@bea/domain";
import { setTestRouterReplace } from "./stubs/next-navigation";

const routerReplace = vi.fn();

const settings: AiProviderSettings = {
  mode: "demo",
  defaultTextModel: "gpt-safe-text",
  defaultRealtimeModel: "gpt-safe-realtime",
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
  inputTranscriptionModel: "gpt-safe-transcribe",
  realtimeOutputSpeed: 1,
  realtimeSessionInstructions: "Use registered tools only.",
  realtimeMaxOutputTokens: 2_048,
  modelCapabilityOverrides: {},
};

const verifiedTextCapabilities = {
  responsesText: true,
  streaming: true,
  reasoning: "unknown",
  functionCalling: true,
  structuredOutputs: true,
  webSearch: true,
  codeInterpreter: true,
  imageGeneration: true,
  imageInput: true,
  fileInput: true,
  realtime: false,
  audioInput: false,
  audioOutput: false,
} as const;

function administration(
  overrides: Partial<OpenAiAdministrationView> = {},
): OpenAiAdministrationView {
  const now = "2026-08-20T13:00:00.000Z";
  return {
    settings,
    apiKeyStatus: "configured",
    apiKeySource: "windows_protected",
    apiKeyFingerprint: "sha256:fixture000001",
    protectedStorageAvailable: true,
    connectionStatus: "configured_not_tested",
    liveConnected: false,
    lastTest: null,
    lastSuccessfulTest: null,
    lastFailedTest: null,
    cachedModels: [
      {
        id: "cache-text",
        provider: "openai",
        modelId: "gpt-safe-text",
        available: true,
        ownedBy: "openai",
        capabilities: verifiedTextCapabilities,
        capabilitySource: "provider",
        fetchedAt: now,
        expiresAt: "2026-08-21T13:00:00.000Z",
        createdAt: now,
        updatedAt: now,
        version: 1,
      },
      {
        id: "cache-realtime",
        provider: "openai",
        modelId: "gpt-safe-realtime",
        available: true,
        ownedBy: "openai",
        capabilities: {
          ...verifiedTextCapabilities,
          realtime: true,
          audioInput: true,
          audioOutput: true,
        },
        capabilitySource: "provider",
        fetchedAt: now,
        expiresAt: "2026-08-21T13:00:00.000Z",
        createdAt: now,
        updatedAt: now,
        version: 1,
      },
      {
        id: "cache-transcribe",
        provider: "openai",
        modelId: "gpt-safe-transcribe",
        available: true,
        ownedBy: "openai",
        capabilities: { ...verifiedTextCapabilities, audioInput: "unknown" },
        capabilitySource: "unknown",
        fetchedAt: now,
        expiresAt: "2026-08-21T13:00:00.000Z",
        createdAt: now,
        updatedAt: now,
        version: 1,
      },
    ],
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

describe("OpenAI administration", () => {
  beforeEach(() => {
    routerReplace.mockReset();
    setTestRouterReplace(routerReplace);
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders safe status evidence and an empty one-way credential input", async () => {
    vi.mocked(fetch).mockResolvedValue(response(administration()));
    render(<OpenAiAdministrationPanel />);

    const panel = await screen.findByTestId("openai-administration-panel");
    expect(within(panel).getByTestId("openai-api-key-status")).toHaveTextContent("configured");
    expect(within(panel).getByTestId("openai-billing-notice")).toHaveTextContent(
      "separate from ChatGPT subscriptions",
    );
    const input = within(panel).getByLabelText("OpenAI API key");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveValue("");
    expect(within(panel).getByText(/sha256:fixture000001/u)).toBeInTheDocument();
    expect(within(panel).getByTestId("openai-connection-state")).toHaveTextContent(
      "OPENAI NOT CONNECTED",
    );
    expect(within(panel).getAllByTestId("openai-model-warning")).not.toHaveLength(0);
  });

  it("keeps activation disabled until current authenticated evidence and verified text capabilities exist", async () => {
    const ready = administration({
      lastTest: {
        id: "test-1",
        provider: "openai",
        actorUserId: "10000000-0000-4000-8000-000000000001",
        outcome: "succeeded",
        authenticated: true,
        safeFailureCode: null,
        safeMessage: "OpenAI connection succeeded.",
        modelCount: 3,
        latencyMs: 21,
        credentialFingerprint: "sha256:000000000001",
        correlationId: "correlation-1",
        testedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
      },
      lastSuccessfulTest: {
        id: "test-1",
        provider: "openai",
        actorUserId: "10000000-0000-4000-8000-000000000001",
        outcome: "succeeded",
        authenticated: true,
        safeFailureCode: null,
        safeMessage: "OpenAI connection succeeded.",
        modelCount: 3,
        latencyMs: 21,
        credentialFingerprint: "sha256:000000000001",
        correlationId: "correlation-1",
        testedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
      },
    });
    vi.mocked(fetch).mockResolvedValue(response(ready));
    render(<OpenAiAdministrationPanel />);

    const activate = await screen.findByTestId("openai-activate");
    await waitFor(() => expect(activate).toBeEnabled());
    expect(screen.getByTestId("openai-activation-readiness")).toHaveTextContent(
      "ready for activation",
    );
  });

  it("keeps unknown capabilities blocked until an explicit audited tri-state attestation", async () => {
    const now = new Date().toISOString();
    const unknown = administration({
      lastTest: {
        id: "test-unknown",
        provider: "openai",
        actorUserId: "10000000-0000-4000-8000-000000000001",
        outcome: "succeeded",
        authenticated: true,
        safeFailureCode: null,
        safeMessage: "OpenAI connection succeeded.",
        modelCount: 3,
        latencyMs: 18,
        credentialFingerprint: "sha256:000000000001",
        correlationId: "correlation-unknown",
        testedAt: now,
        createdAt: now,
        updatedAt: now,
        version: 1,
      },
      cachedModels: administration().cachedModels.map((model) =>
        model.modelId === "gpt-safe-text"
          ? {
              ...model,
              capabilities: {
                ...verifiedTextCapabilities,
                responsesText: "unknown",
                streaming: "unknown",
                functionCalling: "unknown",
                structuredOutputs: "unknown",
              },
              capabilitySource: "unknown",
            }
          : model,
      ),
    });
    vi.mocked(fetch).mockResolvedValue(response(unknown));
    render(<OpenAiAdministrationPanel />);

    const activate = await screen.findByTestId("openai-activate");
    expect(activate).toBeDisabled();
    expect(screen.getByTestId("openai-manual-model-controls")).toBeInTheDocument();
    expect(screen.getByTestId("openai-capability-editor")).toHaveTextContent(
      "Models API does not supply a complete capability matrix",
    );
    fireEvent.click(screen.getByTestId("openai-capability-attestation"));
    for (const capability of [
      "responsesText",
      "streaming",
      "functionCalling",
      "structuredOutputs",
    ]) {
      fireEvent.change(screen.getByTestId(`openai-capability-${capability}`), {
        target: { value: "true" },
      });
    }

    await waitFor(() => expect(activate).toBeEnabled());
    expect(screen.getByTestId("openai-text-model")).toHaveTextContent("OpenAI · text suitable");
  });

  it("saves bounded settings without sending credential-shaped fields", async () => {
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/settings") && init?.method === "PUT") {
        return response({ settings: JSON.parse(String(init.body)) });
      }
      return response(administration());
    });
    render(<OpenAiAdministrationPanel />);

    const save = await screen.findByTestId("openai-save-settings");
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.change(screen.getByTestId("openai-daily-request-limit"), {
      target: { value: "250" },
    });
    fireEvent.click(save);

    await waitFor(() =>
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        "/api/integrations/ai/settings",
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    const put = vi
      .mocked(fetch)
      .mock.calls.find(
        ([input, init]) => String(input).endsWith("/settings") && init?.method === "PUT",
      );
    expect(put).toBeDefined();
    const body = JSON.parse(String(put?.[1]?.body)) as Record<string, unknown>;
    expect(body.dailyRequestLimit).toBe(250);
    expect(
      Object.keys(body).some((key) => /api.?key|secret|credential|access.?token/iu.test(key)),
    ).toBe(false);
  });

  it("sends a new key only to the connect endpoint and clears the input", async () => {
    const afterSave = administration({
      apiKeyStatus: "configured",
      apiKeySource: "windows_protected",
      apiKeyFingerprint: "sha256:replacement1",
      connectionStatus: "configured_not_tested",
      lastTest: null,
      lastSuccessfulTest: null,
      lastFailedTest: null,
    });
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      String(input).endsWith("/connect") && init?.method === "POST"
        ? response(afterSave)
        : response(
            administration({
              apiKeyStatus: "not_configured",
              apiKeySource: "none",
              apiKeyFingerprint: null,
            }),
          ),
    );
    render(<OpenAiAdministrationPanel />);

    const keyInput = await screen.findByTestId("openai-api-key");
    const testSecret = "phase13-component-secret-value-0001";
    fireEvent.change(keyInput, { target: { value: testSecret } });
    fireEvent.click(screen.getByTestId("openai-save-secret"));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/integrations/ai/connect",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const connectCall = vi
      .mocked(fetch)
      .mock.calls.find(
        ([, init]) => init?.method === "POST" && String(init.body).includes("apiKey"),
      );
    expect(JSON.parse(String(connectCall?.[1]?.body))).toEqual({ apiKey: testSecret });
    await waitFor(() => expect(keyInput).toHaveValue(""));
    expect(document.body.textContent).not.toContain(testSecret);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("requires confirmation before disconnecting and never submits a key on deletion", async () => {
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      String(input).endsWith("/secret") && init?.method === "DELETE"
        ? response(
            administration({
              apiKeyStatus: "not_configured",
              apiKeySource: "none",
              apiKeyFingerprint: null,
              connectionStatus: "not_configured",
            }),
          )
        : response(administration()),
    );
    render(<OpenAiAdministrationPanel />);

    fireEvent.click(await screen.findByTestId("openai-disconnect"));
    expect(screen.getByRole("dialog", { name: "Disconnect OpenAI?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect and delete protected key" }));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/integrations/ai/secret",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    const deleteCall = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "DELETE");
    expect(deleteCall?.[1]?.body).toBeUndefined();
  });

  it("gates the administration panel on both management permissions in the server page", () => {
    const source = readFileSync(
      resolve(process.cwd(), "apps/web/app/(authenticated)/integrations/[id]/page.tsx"),
      "utf8",
    );
    expect(source).toContain("PERMISSIONS.INTEGRATIONS_MANAGE");
    expect(source).toContain("PERMISSIONS.SETTINGS_MANAGE");
    expect(source).toContain(
      'health.providerType === "ai" && manageDecision.allowed && settingsDecision.allowed',
    );
    expect(source).toContain("<OpenAiAdministrationPanel />");
    expect(source).toContain('health.connectionStatus === "connected"');
    expect(source).not.toContain(
      '<HealthIndicator label={health.connectionStatus} state="simulated" />',
    );
  });
});
