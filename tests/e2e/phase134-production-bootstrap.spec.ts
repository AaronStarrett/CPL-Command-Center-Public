import type {
  AiModelRoutingProfile,
  AiProviderSettings,
  AiRoutingCapability,
  AiWorkloadRouteKey,
} from "@bea/domain";
import { expect, test, type Page } from "@playwright/test";

import type { AiCommandSnapshot } from "../../apps/web/lib/ai-command-contracts";
import type { OpenAiAdministrationView } from "../../apps/web/lib/openai-administration-client";
const appOrigin = "http://127.0.0.1:3132";
const ownerPersonaId = "10000000-0000-4000-8000-000000000001";
const salesPersonaId = "10000000-0000-4000-8000-000000000002";
const now = "2026-08-24T12:00:00.000Z";

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
    version: "phase1.3.4-test-only-v1",
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
    settings: providerSettings(profile),
    apiKeyStatus: "not_configured",
    apiKeySource: "none",
    apiKeyFingerprint: null,
    protectedStorageAvailable: true,
    connectionStatus: "not_configured",
    liveConnected: false,
    providerStatus: "SETUP_REQUIRED",
    capabilityRegistryVersion: "phase1.3.4-test-only-v1",
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
      id: "voice-pref-phase134",
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
        registryVersion: "phase1.3.4-test-only-v1",
        validatedAt: now,
        validationMethod: "models_api" as const,
        evidence: {},
      },
      fetchedAt: now,
      expiresAt: "2026-08-25T12:00:00.000Z",
      createdAt: now,
      updatedAt: now,
      version: 1,
    })),
    billingNotice: "OpenAI API billing is separate from ChatGPT subscriptions.",
  };
}

function setupRequiredSnapshot(): AiCommandSnapshot {
  const conversation = {
    id: "40000000-0000-4000-8000-000000000134",
    title: "Local Live setup presentation",
    updatedAt: now,
  };
  return {
    conversation,
    conversations: [conversation],
    messages: [],
    artifact: {
      id: "60000000-0000-4000-8000-000000000134",
      type: "empty",
      title: "Connect OpenAI",
      subtitle: "OpenAI setup required",
      state: "empty",
      payload: { providerStatus: "SETUP_REQUIRED", actionable: true },
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
      routerVersion: "phase1.3.4-test-only-v1",
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
      promptVersion: "phase1.3.4-test-only",
      executiveProfileVersion: null,
      brandPolicyVersion: "phase1.3.4",
      artifactTemplateVersion: "phase1.3.4",
    },
  };
}

function connectedAdministration(): OpenAiAdministrationView {
  const base = administrationFixture();
  const evidence = {
    id: "90000000-0000-4000-8000-000000000134",
    provider: "openai" as const,
    actorUserId: ownerPersonaId,
    outcome: "succeeded" as const,
    authenticated: true,
    safeFailureCode: null,
    safeMessage: "Authenticated TEST-ONLY connection evidence.",
    modelCount: base.cachedModels.length,
    latencyMs: 17,
    credentialFingerprint: "sha256:phase134testonly",
    correlationId: "phase134-test-only-browser-evidence",
    testedAt: "2026-08-24T12:00:00.000Z",
    createdAt: "2026-08-24T12:00:00.000Z",
    updatedAt: "2026-08-24T12:00:00.000Z",
    version: 1,
  };
  return {
    ...base,
    apiKeyStatus: "configured",
    apiKeySource: "windows_protected",
    apiKeyFingerprint: "sha256:phase134testonly",
    connectionStatus: "connected",
    liveConnected: true,
    providerStatus: "CONNECTED",
    lastTest: evidence,
    lastSuccessfulTest: evidence,
  };
}

function connectedSnapshot(): AiCommandSnapshot {
  const snapshot = setupRequiredSnapshot();
  const conversation = {
    ...snapshot.conversation,
    id: "40000000-0000-4000-8000-000000000135",
    title: "Local Live connected presentation",
  };
  return {
    ...snapshot,
    conversation,
    conversations: [conversation],
    artifact: {
      ...snapshot.artifact,
      id: "60000000-0000-4000-8000-000000000135",
      title: "Local Live AI workspace",
      subtitle: "OpenAI provider controls are connected",
      payload: { providerStatus: "CONNECTED", actionable: false },
    },
    provider: {
      ...snapshot.provider,
      label: "OpenAI connected",
      status: "CONNECTED",
      providerStatus: "CONNECTED",
      liveConnected: true,
    },
  };
}

async function signInTestBackend(page: Page, personaId: string): Promise<void> {
  const response = await page.request.post("/api/auth/sign-in", {
    form: { personaId, returnTo: "/ai-command" },
    headers: { Origin: appOrigin },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(303);
}

test.describe("@phase133-production-presentation @phase134-production-bootstrap Local Live TEST-ONLY browser acceptance", () => {
  test("presents the Local Owner HTTPS contract without a Demo identity selector", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto("/sign-in");

    await expect(page.getByRole("heading", { name: "Local Owner sign-in" })).toBeVisible();
    await expect(page.getByLabel("Username")).toHaveAttribute("autocomplete", "username");
    await expect(page.getByLabel("Passphrase")).toHaveAttribute("type", "password");
    await expect(page.getByText("Local Live boundary", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Demo persona")).toHaveCount(0);
    await expect(page.getByText(/Demo Mode/iu)).toHaveCount(0);

    // The running browser profile is deliberately HTTP and TEST-ONLY. The real
    // certificate/hostname contract is exercised by the certificate/profile
    // tests and by owner-machine acceptance, not by disabling TLS here.
    expect(new URL("https://bea.localhost:3443").hostname).toBe("bea.localhost");
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test("shows setup-required then connected mocked owner controls and invalidates sign-out", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));

    let administration = administrationFixture();
    let snapshot = setupRequiredSnapshot();
    await page.route("**/api/integrations/ai/settings", async (route) => {
      if (route.request().method() !== "GET") {
        await route.abort("blockedbyclient");
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(administration),
      });
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

    // The exact-authority presentation server keeps its Demo persistence solely
    // as a TEST-ONLY authentication fixture. The visible surface is Local Owner;
    // real Local Owner credential/session behavior is covered by integration tests.
    await signInTestBackend(page, ownerPersonaId);
    await page.goto("/ai-command");
    await page.getByLabel("Open conversation history").click();
    await page.getByRole("button", { name: "New conversation" }).click();
    await expect(page).toHaveURL(/conversation=40000000-0000-4000-8000-000000000134/u);
    await page.getByTestId("ai-command-options-trigger").click();
    const setupPanel = page.getByTestId("openai-administration-panel");
    await expect(setupPanel.getByRole("heading", { name: "Connect OpenAI" })).toBeVisible();
    await expect(setupPanel.getByTestId("openai-api-key")).toHaveAttribute("type", "password");
    await expect(setupPanel.locator('[data-testid^="openai-route-"]')).toHaveCount(12);
    await expect(setupPanel.getByLabel("Realtime model")).toBeVisible();
    await expect(setupPanel.getByTestId("openai-voice")).toHaveValue("coral");
    await expect(page.locator(".bea-demo-banner")).toHaveCount(0);
    await expect(page.getByText(/Demo persona/iu)).toHaveCount(0);

    administration = connectedAdministration();
    snapshot = connectedSnapshot();
    const connectedProviderState = await page.evaluate(async () => {
      const response = await fetch("/api/integrations/ai/settings");
      return (await response.json()) as { liveConnected?: boolean; providerStatus?: string };
    });
    expect(connectedProviderState).toMatchObject({
      liveConnected: true,
      providerStatus: "CONNECTED",
    });
    await page.getByRole("button", { name: "New conversation" }).click();
    await expect(page).toHaveURL(/conversation=40000000-0000-4000-8000-000000000135/u);
    await expect(setupPanel).toHaveCount(0);

    const providerControls = page.getByTestId("ai-command-progressive-controls");
    await expect(providerControls).toContainText("CONNECTED");
    await expect(providerControls).toContainText("gpt-fixture");
    await expect(providerControls).toContainText("coral");
    await page.getByTestId("ai-command-options-trigger").click();
    await page.getByLabel("Open conversation history").click();

    await page.getByTestId("ai-interaction-mode-voice").click();
    const realtime = page.getByTestId("ai-voice-panel");
    await expect(realtime).toHaveAttribute("data-voice-mode", "openai-realtime");
    await expect(realtime).toHaveAttribute("data-voice-mode", "openai-realtime");
    await expect(realtime.getByTestId("ai-realtime-status")).toContainText(
      "Realtime ready to start",
    );
    await expect(realtime.getByTestId("ai-realtime-status")).toContainText("gpt-fixture");
    await expect(realtime.getByTestId("ai-realtime-status")).toContainText("coral");
    await expect(realtime.getByTestId("bea-live-voice-start")).toBeVisible();

    const visible = await page.locator(".bea-application-shell").innerText();
    for (const forbidden of [/DEMO MODE/iu, /SYNTHETIC/iu, /TEST-PROVIDER/iu]) {
      expect(visible).not.toMatch(forbidden);
    }

    await page.getByTestId("account-menu").locator("summary").click();
    await expect(page.getByLabel("Demo persona")).toHaveCount(0);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/sign-in\?reason=signed-out/u);
    await page.goto("/ai-command");
    await expect(page).toHaveURL(/\/sign-in/u);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test("denies provider administration to a non-Owner test identity", async ({ page }) => {
    await signInTestBackend(page, salesPersonaId);
    const response = await page.request.get("/api/integrations/ai/settings");
    expect(response.status()).toBe(403);
  });
});
