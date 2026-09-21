import type {
  AiModelRoutingProfile,
  AiProviderSettings,
  AiRoutingCapability,
  AiWorkloadRouteKey,
} from "@bea/domain";
import { expect, test, type Locator, type Page } from "@playwright/test";

import type { AiCommandSnapshot } from "../../apps/web/lib/ai-command-contracts";
import type { OpenAiAdministrationView } from "../../apps/web/lib/openai-administration-client";

const appOrigin = "http://127.0.0.1:3132";
const ownerPersonaId = "10000000-0000-4000-8000-000000000001";
const now = "2026-08-23T12:00:00.000Z";

function routingProfile(primaryModel: string): AiModelRoutingProfile {
  const definitions = [
    ["executive_conversation", ["responsesText", "streaming"], []],
    ["fast_general_conversation", ["responsesText", "streaming"], []],
    ["complex_reasoning_strategy", ["responsesText", "streaming", "reasoning"], []],
    ["public_web_research", ["responsesText", "streaming", "webSearch"], ["web_search"]],
    ["organizational_file_search", ["responsesText", "streaming", "fileSearch"], ["file_search"]],
    ["document_report_drafting", ["responsesText", "streaming", "structuredOutputs"], []],
    [
      "pdf_narrative_generation",
      ["responsesText", "streaming", "structuredOutputs"],
      ["bea_create_pdf"],
    ],
    [
      "data_analysis_chart_preparation",
      ["responsesText", "codeInterpreter", "structuredOutputs"],
      ["code_interpreter", "bea_create_chart"],
    ],
    ["image_generation", ["imageGeneration"], ["image_generation"]],
    ["vision_image_understanding", ["responsesText", "imageInput"], []],
    ["realtime_voice", ["realtime", "audioInput", "audioOutput"], ["web_search", "file_search"]],
    ["embeddings_indexing", ["embeddings"], []],
  ] as const satisfies readonly [
    AiWorkloadRouteKey,
    readonly AiRoutingCapability[],
    readonly string[],
  ][];

  return {
    version: "phase1.3.3-v1",
    routes: Object.fromEntries(
      definitions.map(([routeKey, requiredCapabilities, toolAllowlist]) => [
        routeKey,
        {
          routeKey,
          primaryModel,
          fallbackModel: "gpt-fixture-fallback",
          requiredCapabilities,
          reasoningEffort: "none",
          maxOutputTokens: 2_048,
          timeoutMs: 30_000,
          toolAllowlist,
          costClass: "standard",
          maximumEstimatedCostUsd: null,
          roleAvailability: [
            "owner-admin",
            "integration-admin",
            "executive-readonly",
            "sales",
            "operations",
          ],
          enabled: true,
        },
      ]),
    ) as unknown as AiModelRoutingProfile["routes"],
    vectorStoreAssignments: [],
    updatedAt: null,
    updatedByUserId: null,
  };
}

function providerSettings(profile: AiModelRoutingProfile): AiProviderSettings {
  return {
    mode: "openai",
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

function administrationFixture(): OpenAiAdministrationView {
  const profile = routingProfile("gpt-fixture");
  const settings = providerSettings(profile);
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

  return {
    settings,
    apiKeyStatus: "not_configured",
    apiKeySource: "none",
    apiKeyFingerprint: null,
    protectedStorageAvailable: true,
    connectionStatus: "not_configured",
    liveConnected: false,
    providerStatus: "SETUP_REQUIRED",
    capabilityRegistryVersion: "phase1.3.3-v1",
    routingProfile: profile,
    recommendedRoutingProfile: profile,
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
        previewAvailable: false,
      },
    ],
    voicePreference: {
      id: "voice-pref-presentation",
      userId: ownerPersonaId,
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
  };
}

function setupRequiredSnapshot(): AiCommandSnapshot {
  const conversation = {
    id: "40000000-0000-4000-8000-000000000133",
    title: "OpenAI setup presentation",
    updatedAt: now,
  };
  return {
    conversation,
    conversations: [conversation],
    messages: [
      {
        id: "50000000-0000-4000-8000-000000000001",
        role: "user",
        content: "Show the current provider readiness and the next authorized setup step.",
        createdAt: now,
        provider: null,
        model: null,
        executionMs: null,
        links: [],
      },
      {
        id: "50000000-0000-4000-8000-000000000002",
        role: "assistant",
        content:
          "OpenAI setup is required. Complete the evidence-gated provider workflow in the workspace before activation.",
        createdAt: now,
        provider: null,
        model: null,
        executionMs: null,
        links: [],
      },
    ],
    artifact: {
      id: "60000000-0000-4000-8000-000000000133",
      type: "empty",
      title: "Connect OpenAI",
      subtitle: "OpenAI setup required",
      state: "empty",
      payload: {
        providerStatus: "SETUP_REQUIRED",
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
      createdAt: now,
      errorCode: null,
    },
    provider: {
      name: "OpenAI",
      label: "OpenAI setup required",
      mode: "openai",
      status: "SETUP_REQUIRED",
      providerStatus: "SETUP_REQUIRED",
      simulated: false,
      model: "gpt-fixture",
      textModel: "gpt-fixture",
      realtimeModel: "gpt-fixture",
      voice: "coral",
      routerVersion: "phase1.3.3-v1",
      liveConnected: false,
      streaming: true,
      webSearchAllowed: false,
      webSearchDefault: false,
      codeInterpreterAllowed: false,
      imageGenerationAllowed: false,
      pdfGenerationAllowed: true,
      realtimeAllowed: true,
      speakResponses: false,
      maxUploadBytes: 10_000_000,
      textModelCapabilities: {},
    },
    permissions: {
      canConfigureOpenAi: true,
      canExecuteTaskAction: false,
      canUploadArtifact: false,
    },
    actingUser: {
      id: ownerPersonaId,
      displayName: "Workspace Owner",
      title: "Chief Executive Officer",
    },
    assistant: {
      kind: "executive-business-partner",
      preferredName: null,
      label: "Ask BEA",
      subtitle: "Executive operating partner",
      promptVersion: "phase1.3.3-presentation",
      executiveProfileVersion: null,
      brandPolicyVersion: "phase1.3.3",
      artifactTemplateVersion: "phase1.3.3",
    },
  };
}

async function activeApplicationShell(page: Page): Promise<Locator> {
  const shells = page.locator(".bea-application-shell");
  await expect
    .poll(async () => shells.filter({ visible: true }).count(), {
      message: "exactly one Command Center shell is interactive",
    })
    .toBe(1);
  return shells.filter({ visible: true });
}

test("@phase133-production-presentation TEST-ONLY renders setup-required OpenAI administration without test-provider presentation", async ({
  page,
}) => {
  const snapshot = setupRequiredSnapshot();
  const administration = administrationFixture();
  const unexpectedAdministrationRequests: string[] = [];

  await page.route("**/api/integrations/ai/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/api/integrations/ai/settings") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(administration),
      });
      return;
    }
    unexpectedAdministrationRequests.push(`${request.method()} ${path}`);
    await route.abort("blockedbyclient");
  });

  await page.route("**/api/ai-command/conversations", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(snapshot),
    });
  });

  const signIn = await page.request.post("/api/auth/sign-in", {
    form: { personaId: ownerPersonaId, returnTo: "/ai-command" },
    headers: { Origin: appOrigin },
    maxRedirects: 0,
  });
  expect(signIn.status()).toBe(303);

  await page.goto("/ai-command");
  const shell = await activeApplicationShell(page);
  await expect(shell.locator(".bea-demo-banner")).toHaveCount(0);

  await shell.locator('summary[aria-label="Open conversation history"]').click();
  await shell.getByRole("button", { name: "New conversation" }).click();

  await expect(page).toHaveURL(new RegExp(`conversation=${snapshot.conversation.id}`, "u"));
  await shell.getByTestId("ai-command-options-trigger").click();
  await expect(shell.getByText("SETUP REQUIRED", { exact: true })).toBeVisible();

  const panel = shell.getByTestId("openai-administration-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-compact", "true");
  await expect(panel.getByRole("heading", { name: "Connect OpenAI" })).toBeVisible();
  await expect(panel.getByTestId("openai-api-key")).toHaveAttribute("type", "password");

  const firstRun = panel.getByTestId("openai-first-run");
  for (const step of [
    "Enter and save a masked, project-scoped API key",
    "Run an authenticated connection test",
    "Refresh the provider model inventory",
    "Review all 12 workload routes and capability warnings",
    "Select the Realtime model and approved voice",
    "Activate from current server evidence",
  ]) {
    await expect(firstRun.getByText(step, { exact: true })).toBeVisible();
  }

  await expect(panel.getByTestId("openai-test-connection")).toBeDisabled();
  await expect(panel.getByTestId("openai-refresh-models")).toBeDisabled();
  await expect(panel.getByTestId("openai-compact-route-list")).toBeVisible();
  await expect(panel.locator('[data-testid^="openai-route-"]')).toHaveCount(12);
  await expect(panel.getByTestId("openai-reset-route-recommendations")).toBeVisible();
  await expect(panel.getByTestId("openai-voice")).toHaveValue("coral");
  await expect(panel.getByTestId("openai-voice-description")).toContainText(
    "Catalog preview: unavailable",
  );
  await expect(panel.getByRole("button", { name: "Preview unavailable" })).toBeDisabled();
  await expect(panel.getByTestId("openai-activate")).toBeDisabled();
  await expect(panel.getByTestId("openai-provider-mode").locator("select")).toHaveCount(0);

  const visiblePresentation = await shell.innerText();
  for (const forbidden of [
    /DEMO MODE/iu,
    /HYBRID MODE/iu,
    /SIMULATED/iu,
    /SYNTHETIC/iu,
    /TEST-PROVIDER/iu,
  ]) {
    expect(visiblePresentation).not.toMatch(forbidden);
  }
  expect(unexpectedAdministrationRequests).toEqual([]);
});
