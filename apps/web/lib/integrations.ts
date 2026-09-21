import "server-only";

import { DEFAULT_MOCK_PROVIDER_DESCRIPTORS, type IntegrationHealth } from "@bea/integrations";
import type { BeaServerRuntime } from "@bea/database";

import { getFoundationRuntime } from "./foundation-runtime";
import { readOpenAiAdministration } from "./openai-administration";

export const integrationDescriptors = DEFAULT_MOCK_PROVIDER_DESCRIPTORS;

export async function getAiIntegrationHealthWithRuntime(
  runtime: BeaServerRuntime,
): Promise<IntegrationHealth> {
  const descriptor = DEFAULT_MOCK_PROVIDER_DESCRIPTORS.find(
    (candidate) => candidate.providerType === "ai",
  );
  if (!descriptor) throw new Error("AI integration descriptor is unavailable.");
  const administration = await readOpenAiAdministration(runtime);
  const liveMode =
    administration.settings.mode === "openai" || administration.settings.mode === "hybrid";
  const blocked = liveMode && !administration.liveConnected;
  return {
    providerType: "ai",
    displayName: liveMode ? "OpenAI" : descriptor.displayName,
    mode: liveMode ? "live" : "mock",
    connectionStatus: administration.liveConnected
      ? "connected"
      : administration.settings.mode === "demo"
        ? "simulated"
        : administration.lastTest?.outcome === "failed"
          ? "failed"
          : administration.apiKeyStatus === "configured"
            ? "degraded"
            : "not-configured",
    requirementStatus: administration.liveConnected
      ? "CONNECTED"
      : blocked
        ? "BLOCKED"
        : "SIMULATED",
    checkedAt: administration.lastTest?.testedAt ?? new Date().toISOString(),
    lastSuccessfulSynchronizationAt: null,
    lastFailure:
      administration.lastTest?.outcome === "failed"
        ? {
            code: administration.lastTest.safeFailureCode ?? "OPENAI_CONNECTION_TEST_FAILED",
            message: administration.lastTest.safeMessage,
            retryable: false,
          }
        : null,
    configurationCompleteness: administration.liveConnected
      ? 100
      : administration.apiKeyStatus === "configured"
        ? 50
        : 0,
    requiredPermissions: descriptor.requiredPermissions,
    externalIdentifier: null,
    testMode: administration.settings.mode === "demo",
    mockMode: administration.settings.mode === "demo",
  };
}

export async function getIntegrationHealthSummary() {
  const runtime = await getFoundationRuntime();
  const summary = await runtime.providers.healthSummary();
  const ai = await getAiIntegrationHealthWithRuntime(runtime);
  const providers = summary.providers.map((provider) =>
    provider.providerType === "ai" ? ai : provider,
  );
  const connected = providers.filter(
    (provider) => provider.connectionStatus === "connected",
  ).length;
  const simulated = providers.filter(
    (provider) => provider.connectionStatus === "simulated",
  ).length;
  const degraded = providers.filter((provider) => provider.connectionStatus === "degraded").length;
  const failed = providers.filter((provider) => provider.connectionStatus === "failed").length;
  return {
    status:
      failed > 0
        ? ("unhealthy" as const)
        : degraded > 0
          ? ("degraded" as const)
          : ("healthy" as const),
    checkedAt: new Date().toISOString(),
    total: providers.length,
    simulated,
    connected,
    degraded,
    failed,
    providers,
  };
}

export async function getIntegrationHealth(providerType: string) {
  const knownProvider = DEFAULT_MOCK_PROVIDER_DESCRIPTORS.find(
    (descriptor) => descriptor.providerType === providerType,
  );
  if (!knownProvider) return undefined;
  const runtime = await getFoundationRuntime();
  if (knownProvider.providerType === "ai") return getAiIntegrationHealthWithRuntime(runtime);
  return runtime.providers.get(knownProvider.providerType)?.health();
}
