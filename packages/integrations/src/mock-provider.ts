import type { Clock } from "@bea/domain";
import type {
  IntegrationHealth,
  IntegrationProvider,
  MockProviderDescriptor,
} from "./contracts.js";
import { systemClock } from "./contracts.js";

export class DeterministicMockIntegrationProvider implements IntegrationProvider {
  readonly mode = "mock" as const;
  readonly providerType;
  readonly displayName;

  constructor(
    private readonly descriptor: MockProviderDescriptor,
    private readonly clock: Clock = systemClock,
  ) {
    this.assertTestOnly();
    this.providerType = descriptor.providerType;
    this.displayName = descriptor.displayName;
  }

  async health(): Promise<IntegrationHealth> {
    this.assertTestOnly();
    return {
      providerType: this.descriptor.providerType,
      displayName: this.descriptor.displayName,
      mode: "mock",
      connectionStatus: "simulated",
      requirementStatus: "SIMULATED",
      checkedAt: this.clock.now().toISOString(),
      lastSuccessfulSynchronizationAt: null,
      lastFailure: null,
      configurationCompleteness: 0,
      requiredPermissions: this.descriptor.requiredPermissions,
      externalIdentifier: null,
      testMode: true,
      mockMode: true,
    };
  }

  private assertTestOnly(): void {
    if (process.env.NODE_ENV !== "test") {
      throw new Error("Simulated integration providers require an isolated NODE_ENV=test harness.");
    }
  }
}
