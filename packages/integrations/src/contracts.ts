import type {
  Clock,
  IntegrationConnectionStatus,
  IntegrationMode,
  IntegrationProviderType,
  IsoDateTime,
  RequirementStatus,
  StructuredError,
} from "@bea/domain";

export interface IntegrationHealth {
  readonly providerType: IntegrationProviderType;
  readonly displayName: string;
  readonly mode: IntegrationMode;
  readonly connectionStatus: IntegrationConnectionStatus;
  readonly requirementStatus: RequirementStatus;
  readonly checkedAt: IsoDateTime;
  readonly lastSuccessfulSynchronizationAt: IsoDateTime | null;
  readonly lastFailure: StructuredError | null;
  readonly configurationCompleteness: number;
  readonly requiredPermissions: readonly string[];
  readonly externalIdentifier: string | null;
  readonly testMode: boolean;
  readonly mockMode: boolean;
}

export interface IntegrationProvider {
  readonly providerType: IntegrationProviderType;
  readonly displayName: string;
  readonly mode: IntegrationMode;
  health(): Promise<IntegrationHealth>;
}

export interface MockProviderDescriptor {
  readonly providerType: IntegrationProviderType;
  readonly displayName: string;
  readonly requiredPermissions: readonly string[];
}

export interface IntegrationHealthSummary {
  readonly status: "healthy" | "degraded" | "unhealthy";
  readonly checkedAt: IsoDateTime;
  readonly total: number;
  readonly simulated: number;
  readonly connected: number;
  readonly degraded: number;
  readonly failed: number;
  readonly providers: readonly IntegrationHealth[];
}

export const systemClock: Clock = { now: () => new Date() };
