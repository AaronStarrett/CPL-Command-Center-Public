import type { Clock } from "@bea/domain";
import type { MockProviderDescriptor } from "./contracts.js";
import { DeterministicMockIntegrationProvider } from "./mock-provider.js";
import { ProviderRegistry } from "./registry.js";
import { UnavailableIntegrationProvider } from "./unavailable-provider.js";

export const DEFAULT_MOCK_PROVIDER_DESCRIPTORS = [
  {
    providerType: "microsoft-identity",
    displayName: "Microsoft Entra ID",
    requiredPermissions: ["tenant configuration"],
  },
  {
    providerType: "microsoft-graph",
    displayName: "Microsoft Graph",
    requiredPermissions: ["least-privilege delegated/application scopes"],
  },
  {
    providerType: "outlook-email",
    displayName: "Outlook Email",
    requiredPermissions: ["Mail.ReadWrite"],
  },
  {
    providerType: "outlook-calendar",
    displayName: "Outlook Calendar",
    requiredPermissions: ["Calendars.ReadWrite"],
  },
  {
    providerType: "teams",
    displayName: "Microsoft Teams",
    requiredPermissions: ["Teams activity scope to be decided"],
  },
  {
    providerType: "sharepoint",
    displayName: "Microsoft SharePoint",
    requiredPermissions: ["Sites.Selected"],
  },
  {
    providerType: "crm",
    displayName: "CRM",
    requiredPermissions: ["provider and scopes unresolved"],
  },
  {
    providerType: "accounting",
    displayName: "Accounting",
    requiredPermissions: ["provider and scopes unresolved"],
  },
  {
    providerType: "timekeeping",
    displayName: "Timekeeping",
    requiredPermissions: ["provider and scopes unresolved"],
  },
  {
    providerType: "telephony",
    displayName: "Telephone",
    requiredPermissions: ["provider and scopes unresolved"],
  },
  {
    providerType: "e-signature",
    displayName: "E-signature",
    requiredPermissions: ["provider and scopes unresolved"],
  },
  { providerType: "ai", displayName: "AI", requiredPermissions: ["provider configuration"] },
  {
    providerType: "embeddings",
    displayName: "Embeddings",
    requiredPermissions: ["provider configuration"],
  },
  {
    providerType: "speech-to-text",
    displayName: "Speech to Text",
    requiredPermissions: ["provider configuration"],
  },
  {
    providerType: "text-to-speech",
    displayName: "Text to Speech",
    requiredPermissions: ["provider configuration"],
  },
] as const satisfies readonly MockProviderDescriptor[];

export function createDefaultMockProviderRegistry(clock?: Clock): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const descriptor of DEFAULT_MOCK_PROVIDER_DESCRIPTORS) {
    registry.register(new DeterministicMockIntegrationProvider(descriptor, clock));
  }
  return registry;
}

export function createUnavailableProviderRegistry(clock?: Clock): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const descriptor of DEFAULT_MOCK_PROVIDER_DESCRIPTORS) {
    registry.register(new UnavailableIntegrationProvider(descriptor, clock));
  }
  return registry;
}
