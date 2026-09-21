export type ProviderAdapterStatus =
  "primary-pilot" | "default-connector" | "optional-pilot" | "future-optional";

export interface ProviderAdapterDescriptor {
  readonly adapterId: string;
  readonly providerContract: string;
  readonly status: ProviderAdapterStatus;
  readonly architectureOnly: true;
}

export const PROVIDER_ADAPTER_CATALOG = [
  {
    adapterId: "SupabasePostgresProvider",
    providerContract: "DatabaseProvider",
    status: "primary-pilot",
    architectureOnly: true,
  },
  {
    adapterId: "SupabaseAuthProvider",
    providerContract: "AuthProvider",
    status: "optional-pilot",
    architectureOnly: true,
  },
  {
    adapterId: "CloudflareR2Provider",
    providerContract: "ObjectStorageProvider",
    status: "primary-pilot",
    architectureOnly: true,
  },
  {
    adapterId: "OneDriveKnowledgeProvider",
    providerContract: "KnowledgeSourceProvider",
    status: "default-connector",
    architectureOnly: true,
  },
  {
    adapterId: "GoogleDriveKnowledgeProvider",
    providerContract: "KnowledgeSourceProvider",
    status: "optional-pilot",
    architectureOnly: true,
  },
  {
    adapterId: "LocalPreviewStorageProvider",
    providerContract: "ObjectStorageProvider",
    status: "optional-pilot",
    architectureOnly: true,
  },
  {
    adapterId: "SupabasePgvectorProvider",
    providerContract: "VectorMemoryProvider",
    status: "primary-pilot",
    architectureOnly: true,
  },
  {
    adapterId: "PgBossQueueProvider",
    providerContract: "QueueProvider",
    status: "primary-pilot",
    architectureOnly: true,
  },
  {
    adapterId: "RailwayRuntimeTarget",
    providerContract: "ApplicationRuntimeTarget",
    status: "primary-pilot",
    architectureOnly: true,
  },
  {
    adapterId: "RuntimeEncryptedSecretProvider",
    providerContract: "SecretProvider",
    status: "primary-pilot",
    architectureOnly: true,
  },
  {
    adapterId: "ProviderNeutralEmailAdapter",
    providerContract: "EmailProvider",
    status: "optional-pilot",
    architectureOnly: true,
  },
  {
    adapterId: "OpenTelemetryMonitoringProvider",
    providerContract: "MonitoringProvider",
    status: "optional-pilot",
    architectureOnly: true,
  },
  {
    adapterId: "PostgresR2BackupProvider",
    providerContract: "BackupProvider",
    status: "optional-pilot",
    architectureOnly: true,
  },
  {
    adapterId: "AzurePostgresProvider",
    providerContract: "DatabaseProvider",
    status: "future-optional",
    architectureOnly: true,
  },
  {
    adapterId: "AzureBlobProvider",
    providerContract: "ObjectStorageProvider",
    status: "future-optional",
    architectureOnly: true,
  },
  {
    adapterId: "AzureKeyVaultProvider",
    providerContract: "SecretProvider",
    status: "future-optional",
    architectureOnly: true,
  },
  {
    adapterId: "MicrosoftEntraProvider",
    providerContract: "AuthProvider",
    status: "future-optional",
    architectureOnly: true,
  },
  {
    adapterId: "S3Provider",
    providerContract: "ObjectStorageProvider",
    status: "future-optional",
    architectureOnly: true,
  },
  {
    adapterId: "BackblazeB2Provider",
    providerContract: "ObjectStorageProvider",
    status: "future-optional",
    architectureOnly: true,
  },
] as const satisfies readonly ProviderAdapterDescriptor[];
