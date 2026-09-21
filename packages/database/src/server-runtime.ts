import { FoundationSystemHealthWorkflow } from "@bea/automation";
import {
  AiProviderRegistry,
  DemoStreamingAiProvider,
  type OpenAiProvider,
  UnavailableOpenAiProvider,
  type ModelCapabilityOverride,
} from "@bea/ai";
import {
  assertApplicationProviderExecutionAllowed,
  assertLegacyRuntimeTestOnly,
  FeatureFlagService,
  loadRepositoryEnvironment,
  requiresLiveOpenAiProvider,
  SystemSettingService,
  type ServerEnvironment,
  type ServerSecrets,
} from "@bea/config";
import type { DatabaseHealth } from "@bea/domain";
import {
  createDefaultMockProviderRegistry,
  createUnavailableProviderRegistry,
  type IntegrationHealthSummary,
  type ProviderRegistry,
} from "@bea/integrations";
import { createLogger, type StructuredLogger } from "@bea/observability";
import {
  DemoAuthenticationAdapter,
  LocalOwnerAuthenticationAdapter,
  microsoftEntraAuthenticationSeam,
  PersistentAuthorizationService,
  type RuntimeAuthenticationAdapter,
} from "@bea/security";
import type { DatabaseAdapter } from "./adapter.js";
import { createDatabaseAdapter } from "./factory.js";
import { SqlAiProviderRepository } from "./ai-provider-repository.js";
import {
  migrateDatabase,
  verifyMigrations,
  type MigrationResult,
  type MigrationVerificationResult,
} from "./migrations.js";
import { SqlDigitalWorkforceRepository } from "./digital-workforce-repository.js";
import { SqlLeadRepository } from "./lead-repository.js";
import { createInspectionReportPipeline, InspectionReportPipeline } from "./operations-executor.js";
import { ConfigurationStudioService } from "./configuration-executor.js";
import { WorkControlPlane } from "./work-control-executor.js";
import { CommercialWorkflowService } from "./commercial-executor.js";
import { GuidedMeridianService } from "./guided-demo-executor.js";
import { SqlLocalOwnerAccountStore } from "./local-owner-repository.js";
import { SqlPhase1Repository } from "./phase1-repository.js";
import { SqlFoundationRepository } from "./repository.js";
import { seedDatabase, type SeedSummary } from "./seed.js";
import { verifySystemSeed, type SystemSeedVerification } from "./system-seed.js";

export interface ServerRuntimeHealth {
  readonly status: "healthy" | "degraded" | "unhealthy";
  readonly checkedAt: string;
  readonly appMode: "demo" | "production";
  readonly database: DatabaseHealth;
  readonly integrations: IntegrationHealthSummary;
}

export interface BeaServerRuntime {
  readonly environment: ServerEnvironment;
  readonly repositoryRoot: string;
  readonly database: DatabaseAdapter;
  readonly repository: SqlFoundationRepository;
  readonly phase1: SqlPhase1Repository;
  readonly leads: SqlLeadRepository;
  readonly operations: InspectionReportPipeline;
  readonly configuration: ConfigurationStudioService;
  readonly workControl: WorkControlPlane;
  readonly commercial: CommercialWorkflowService;
  readonly guidedDemo: GuidedMeridianService;
  readonly digitalWorkforce: SqlDigitalWorkforceRepository;
  readonly ai: {
    readonly registry: AiProviderRegistry;
    readonly persistence: SqlAiProviderRepository;
    readonly secrets: ServerSecrets;
    createOpenAiProvider(input: {
      readonly defaultModel: string;
      readonly capabilityOverrides?: readonly ModelCapabilityOverride[];
      readonly timeoutMs?: number;
      readonly maxRetries?: number;
      readonly connectionEvidenceVerified?: boolean;
    }): Promise<OpenAiProvider>;
  };
  readonly authentication: RuntimeAuthenticationAdapter;
  readonly authorization: PersistentAuthorizationService;
  readonly featureFlags: FeatureFlagService;
  readonly settings: SystemSettingService;
  readonly providers: ProviderRegistry;
  readonly workflow: FoundationSystemHealthWorkflow;
  readonly logger: StructuredLogger;
  readonly bootstrap: {
    readonly migration?: MigrationResult;
    readonly migrationVerification?: MigrationVerificationResult;
    readonly systemSeedVerification?: SystemSeedVerification;
    readonly seed?: SeedSummary;
  };
  health(): Promise<ServerRuntimeHealth>;
  close(): Promise<void>;
}

export interface CreateServerRuntimeOptions {
  readonly startDirectory?: string;
  readonly processEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly bootstrapDemo?: boolean;
  readonly loadEnvFile?: boolean;
}

export async function createServerRuntime(
  options: CreateServerRuntimeOptions = {},
): Promise<BeaServerRuntime> {
  assertLegacyRuntimeTestOnly(options.processEnvironment ?? process.env);
  const loaded = loadRepositoryEnvironment({
    ...(options.startDirectory === undefined ? {} : { startDirectory: options.startDirectory }),
    ...(options.processEnvironment === undefined
      ? {}
      : { processEnvironment: options.processEnvironment }),
    ...(options.loadEnvFile === undefined ? {} : { loadEnvFile: options.loadEnvFile }),
  });
  const environment = loaded.environment;
  const database = createDatabaseAdapter(environment);
  const repository = new SqlFoundationRepository(database);
  const phase1 = new SqlPhase1Repository(database);
  const leads = new SqlLeadRepository(database);
  const operations = createInspectionReportPipeline(database, environment.appMode, {
    processInline: environment.appMode === "demo",
  });
  const configuration = new ConfigurationStudioService(database);
  const commercial = new CommercialWorkflowService(database, {
    processInline: environment.appMode === "demo",
  });
  const guidedDemo = new GuidedMeridianService(database, leads, commercial, operations, {
    appMode: environment.appMode,
  });
  configuration.bindSubmissions({
    submitInspection: (input) => operations.submitInspection(input),
  });
  if (operations.workControl) {
    configuration.bindWorkControl(operations.workControl);
    commercial.bindWorkControl(operations.workControl);
  }
  const digitalWorkforce = new SqlDigitalWorkforceRepository(database);
  const aiPersistence = new SqlAiProviderRepository(database);
  const logger = createLogger({
    service: "bea-server",
    environment: environment.nodeEnv,
    level: environment.logLevel,
  });
  const liveAiRequired = requiresLiveOpenAiProvider(environment);
  const providers =
    environment.appMode === "demo" && !liveAiRequired
      ? createDefaultMockProviderRegistry()
      : createUnavailableProviderRegistry();
  const aiProviderRegistry = new AiProviderRegistry(
    environment.appMode === "demo" && !liveAiRequired
      ? new DemoStreamingAiProvider()
      : new UnavailableOpenAiProvider(
          loaded.secrets.status().openAiApiKey === "configured"
            ? "CONFIGURED_NOT_TESTED"
            : "SETUP_REQUIRED",
        ),
  );
  const bootstrap: {
    migration?: MigrationResult;
    migrationVerification?: MigrationVerificationResult;
    systemSeedVerification?: SystemSeedVerification;
    seed?: SeedSummary;
  } = {};

  try {
    if (environment.appMode === "demo") {
      bootstrap.migration = await migrateDatabase(database);
      await aiPersistence.ensureProviderSettings(environment.appMode);
      if (options.bootstrapDemo !== false) {
        bootstrap.seed = await seedDatabase(database);
      }
      if (liveAiRequired) {
        const current = await aiPersistence.getProviderSettings();
        if (current.mode === "demo") {
          await aiPersistence.adoptOwnerEvaluationOpenAiBoundary();
        }
      }
    } else {
      bootstrap.migrationVerification = await verifyMigrations(database);
      bootstrap.systemSeedVerification = await verifySystemSeed(database);
    }
  } catch (error) {
    await database.close();
    throw error;
  }

  const authentication: RuntimeAuthenticationAdapter =
    environment.authProvider === "demo"
      ? new DemoAuthenticationAdapter(
          {
            appMode: environment.appMode,
            enabled: environment.demoAuthEnabled,
            sessionTtlMinutes: environment.sessionTtlMinutes,
            secureCookies: environment.secureCookies,
          },
          repository,
          repository,
          repository,
        )
      : environment.authProvider === "local-owner"
        ? new LocalOwnerAuthenticationAdapter(
            {
              deploymentProfile: "local-live",
              sessionSecret: environment.sessionSecret as string,
              sessionTtlMinutes: environment.sessionTtlMinutes,
            },
            repository,
            new SqlLocalOwnerAccountStore(database),
            repository,
          )
        : microsoftEntraAuthenticationSeam;
  const authorization = new PersistentAuthorizationService(repository, repository);
  const featureFlags = new FeatureFlagService(repository, repository);
  const settings = new SystemSettingService(repository, repository);
  const workflow = new FoundationSystemHealthWorkflow({
    database,
    providers,
    store: repository,
    audit: repository,
    logger,
  });

  return {
    environment,
    repositoryRoot: loaded.repositoryRoot,
    database,
    repository,
    phase1,
    leads,
    operations,
    configuration,
    commercial,
    guidedDemo,
    workControl: operations.workControl as WorkControlPlane,
    digitalWorkforce,
    ai: {
      registry: aiProviderRegistry,
      persistence: aiPersistence,
      secrets: loaded.secrets,
      async createOpenAiProvider() {
        return assertApplicationProviderExecutionAllowed();
      },
    },
    authentication,
    authorization,
    featureFlags,
    settings,
    providers,
    workflow,
    logger,
    bootstrap,
    async health(): Promise<ServerRuntimeHealth> {
      const [databaseHealth, integrationHealth] = await Promise.all([
        database.health(),
        providers.healthSummary(),
      ]);
      const status =
        databaseHealth.status === "unhealthy" || integrationHealth.status === "unhealthy"
          ? "unhealthy"
          : databaseHealth.status === "degraded" || integrationHealth.status === "degraded"
            ? "degraded"
            : "healthy";
      return {
        status,
        checkedAt: new Date().toISOString(),
        appMode: environment.appMode,
        database: databaseHealth,
        integrations: integrationHealth,
      };
    },
    close: () => database.close(),
  };
}

const runtimeGlobal = globalThis as typeof globalThis & {
  __beaServerRuntimePromise?: Promise<BeaServerRuntime>;
};

export function getServerRuntime(
  options: CreateServerRuntimeOptions = {},
): Promise<BeaServerRuntime> {
  assertLegacyRuntimeTestOnly(options.processEnvironment ?? process.env);
  runtimeGlobal.__beaServerRuntimePromise ??= createServerRuntime(options).catch(
    (error: unknown) => {
      delete runtimeGlobal.__beaServerRuntimePromise;
      throw error;
    },
  );
  return runtimeGlobal.__beaServerRuntimePromise;
}

export async function closeServerRuntime(): Promise<void> {
  const runtime = await runtimeGlobal.__beaServerRuntimePromise;
  delete runtimeGlobal.__beaServerRuntimePromise;
  await runtime?.close();
}
