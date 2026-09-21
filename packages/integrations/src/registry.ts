import type { IntegrationProviderType } from "@bea/domain";
import type {
  IntegrationHealth,
  IntegrationHealthSummary,
  IntegrationProvider,
} from "./contracts.js";

export class DuplicateProviderError extends Error {
  constructor(providerType: IntegrationProviderType) {
    super(`An integration provider is already registered for ${providerType}.`);
    this.name = "DuplicateProviderError";
  }
}

export class ProviderRegistry {
  private readonly providers = new Map<IntegrationProviderType, IntegrationProvider>();

  register(provider: IntegrationProvider): void {
    if (this.providers.has(provider.providerType)) {
      throw new DuplicateProviderError(provider.providerType);
    }
    this.providers.set(provider.providerType, provider);
  }

  get(providerType: IntegrationProviderType): IntegrationProvider | undefined {
    return this.providers.get(providerType);
  }

  list(): readonly IntegrationProvider[] {
    return [...this.providers.values()];
  }

  async health(): Promise<readonly IntegrationHealth[]> {
    return Promise.all(this.list().map((provider) => provider.health()));
  }

  async healthSummary(): Promise<IntegrationHealthSummary> {
    const providers = await this.health();
    const failed = providers.filter((provider) => provider.connectionStatus === "failed").length;
    const degraded = providers.filter((provider) =>
      ["degraded", "disabled", "not-configured"].includes(provider.connectionStatus),
    ).length;
    const checkedAt = providers.at(0)?.checkedAt ?? new Date(0).toISOString();
    return {
      status: failed > 0 ? "unhealthy" : degraded > 0 ? "degraded" : "healthy",
      checkedAt,
      total: providers.length,
      simulated: providers.filter((provider) => provider.requirementStatus === "SIMULATED").length,
      connected: providers.filter((provider) => provider.requirementStatus === "CONNECTED").length,
      degraded,
      failed,
      providers,
    };
  }
}
