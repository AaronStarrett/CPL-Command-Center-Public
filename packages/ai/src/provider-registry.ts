import type { AiCommandProvider } from "./contracts.js";

export class AiProviderRegistry {
  private readonly providers = new Map<string, AiCommandProvider>();
  private activeKey: string;

  constructor(defaultProvider: AiCommandProvider) {
    this.register(defaultProvider);
    this.activeKey = defaultProvider.providerKey;
  }

  register(provider: AiCommandProvider): void {
    if (this.providers.has(provider.providerKey)) {
      throw new Error(`AI provider already registered: ${provider.providerKey}`);
    }
    this.providers.set(provider.providerKey, provider);
  }

  /** Rebuilds a configured provider without changing which provider is active. */
  replace(provider: AiCommandProvider): void {
    if (!this.providers.has(provider.providerKey)) {
      throw new Error(`AI provider is not registered: ${provider.providerKey}`);
    }
    this.providers.set(provider.providerKey, provider);
  }

  has(providerKey: string): boolean {
    return this.providers.has(providerKey);
  }

  get(providerKey: string): AiCommandProvider {
    const provider = this.providers.get(providerKey);
    if (!provider) throw new Error(`AI provider is not registered: ${providerKey}`);
    return provider;
  }

  active(): AiCommandProvider {
    return this.get(this.activeKey);
  }

  activate(providerKey: string): AiCommandProvider {
    const provider = this.get(providerKey);
    this.activeKey = providerKey;
    return provider;
  }

  list(): readonly AiCommandProvider[] {
    return [...this.providers.values()];
  }
}
