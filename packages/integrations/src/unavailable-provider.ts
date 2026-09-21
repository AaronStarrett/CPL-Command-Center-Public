import type { Clock } from "@bea/domain";
import type {
  IntegrationHealth,
  IntegrationProvider,
  MockProviderDescriptor,
} from "./contracts.js";
import { systemClock } from "./contracts.js";

/**
 * Production-safe placeholder for a connector that has not been activated.
 * It exposes no fixture behavior and can never be interpreted as connected.
 */
export class UnavailableIntegrationProvider implements IntegrationProvider {
  readonly mode = "live" as const;
  readonly providerType;
  readonly displayName;

  constructor(
    private readonly descriptor: MockProviderDescriptor,
    private readonly clock: Clock = systemClock,
  ) {
    this.providerType = descriptor.providerType;
    this.displayName = descriptor.displayName;
  }

  async health(): Promise<IntegrationHealth> {
    return {
      providerType: this.descriptor.providerType,
      displayName: this.descriptor.displayName,
      mode: "live",
      connectionStatus: "not-configured",
      requirementStatus: "BLOCKED",
      checkedAt: this.clock.now().toISOString(),
      lastSuccessfulSynchronizationAt: null,
      lastFailure: null,
      configurationCompleteness: 0,
      requiredPermissions: this.descriptor.requiredPermissions,
      externalIdentifier: null,
      testMode: false,
      mockMode: false,
    };
  }
}
