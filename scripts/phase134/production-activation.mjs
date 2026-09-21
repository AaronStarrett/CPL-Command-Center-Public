import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { parseEnvironment } from "../../packages/config/src/index.ts";
import {
  createDatabaseAdapter,
  migrateDatabase,
  seedSystemDatabase,
  SqlFoundationRepository,
  SqlLocalOwnerAccountStore,
  verifyEmptyProductionBootstrap,
  verifyProductionDatabase,
} from "../../packages/database/src/index.ts";
import { LocalOwnerAuthenticationAdapter } from "../../packages/security/src/index.ts";

import { runProductionQueueCheck } from "../../apps/worker/src/production-queue-check.ts";
import { assertRepositoryBoundary } from "../repository-boundary.mjs";
import { createBuildManifest, writeBuildManifestAtomic } from "./build-manifest.mjs";
import { inspectBootstrapReadiness, writeSetupState } from "./configure-production.mjs";
import { readProductionConfig, writeProductionConfigAtomic } from "./production-config.mjs";
import { productionPaths, repositoryRoot } from "./production-paths.mjs";
import {
  PRODUCTION_POSTGRES_PREREQUISITES_SQL,
  productionPostgresConnectionUrl,
  validateProductionPostgresPrerequisites,
} from "./postgres-tools.mjs";
import { checkPortAvailable } from "./runtime-control.mjs";
import {
  readProductionSecrets,
  readSecretStatus,
  storeProductionSecrets,
} from "./production-secrets.mjs";
import { startProductionSetupSession } from "./production-setup-session.mjs";
import { applyRestrictedAcl, validateAclTargetForOperation } from "./windows-acl.mjs";

function createProductionEnvironment(config, secrets, paths = productionPaths) {
  return Object.freeze({
    APP_BASE_URL: config.appBaseUrl,
    APP_MODE: "production",
    BEA_AUTH_PROVIDER: config.authentication.provider,
    BEA_DEPLOYMENT_PROFILE: config.deploymentProfile,
    BEA_DISABLE_ENV_FILE: "true",
    BEA_PRODUCTION_CONFIG_PATH: paths.configFile,
    BEA_PRODUCTION_SECRET_PATH: paths.secretFile,
    BEA_RUNTIME_MODE: "production",
    DATABASE_DRIVER: "postgres",
    DATABASE_URL: productionPostgresConnectionUrl(secrets.databaseUrl, config.database.tlsMode),
    DEMO_AUTH_ENABLED: "false",
    NODE_ENV: "production",
    SESSION_SECRET: secrets.sessionSecret,
    WORKER_HEALTH_PORT: String(config.ports.workerHealth),
    WORKER_MODE: "serve",
    WORKER_QUEUE_ADAPTER: "pg-boss",
  });
}

function safeChildEnvironment(
  productionEnvironment,
  paths = productionPaths,
  source = process.env,
) {
  const inherited = Object.fromEntries(
    [
      "APPDATA",
      "ComSpec",
      "COMSPEC",
      "LANG",
      "LC_ALL",
      "LOCALAPPDATA",
      "NUMBER_OF_PROCESSORS",
      "PATHEXT",
      "PROCESSOR_ARCHITECTURE",
      "SystemDrive",
      "SystemRoot",
      "SYSTEMROOT",
      "TEMP",
      "TMP",
      "TZ",
      "USERPROFILE",
      "WINDIR",
    ]
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, source[key]]),
  );
  const inheritedPath = source.Path ?? source.PATH ?? "";
  const pinnedPath = `${paths.nodeDirectory};${dirname(paths.pnpmExecutable)}`;
  return {
    ...inherited,
    ...productionEnvironment,
    COREPACK_HOME: paths.corepackHome,
    PNPM_HOME: paths.pnpmHome,
    PATH: inheritedPath ? `${pinnedPath};${inheritedPath}` : pinnedPath,
    Path: inheritedPath ? `${pinnedPath};${inheritedPath}` : pinnedPath,
  };
}

function runPinnedPnpm(arguments_, environment, options = {}) {
  const command = options.command ?? process.env.ComSpec ?? "cmd.exe";
  const result = (options.spawnSync ?? spawnSync)(
    command,
    ["/d", "/s", "/c", productionPaths.pnpmExecutable, ...arguments_],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: safeChildEnvironment(environment),
      shell: false,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.status !== 0 || result.error) {
    throw new Error(`Pinned production ${arguments_[0]} failed.`);
  }
}

export async function inspectDatabasePrerequisites(database, config, databaseChoice, databaseUrl) {
  const result = await database.query(PRODUCTION_POSTGRES_PREREQUISITES_SQL);
  const row = result.rows.at(0);
  return validateProductionPostgresPrerequisites(row, {
    databaseUrl,
    tlsMode: config.database.tlsMode,
    forceTls: databaseChoice === "managed",
  });
}

export function createBuildEnvironment(config, paths = productionPaths) {
  return createProductionEnvironment(
    config,
    {
      databaseUrl: "postgresql://build-only:build-only@127.0.0.1:1/bea_build",
      sessionSecret: "build-only-non-secret-placeholder-".padEnd(96, "0"),
    },
    paths,
  );
}

async function assertPortsAvailable(config, currentSetupPort, dependencies = {}) {
  for (const [name, port] of Object.entries(config.ports)) {
    if (name === "setup" && port === currentSetupPort) continue;
    const status = await (dependencies.checkPort ?? checkPortAvailable)(port);
    if (!status.available) throw new Error(`The selected ${name} port is unavailable.`);
  }
}

function openSetupBrowser(url, spawnProcess = spawn) {
  const command = process.env.ComSpec ?? "cmd.exe";
  const child = spawnProcess(command, ["/d", "/s", "/c", "start", "", url], {
    cwd: repositoryRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref?.();
}

export async function applyProductionActivation(submission, dependencies = {}) {
  const paths = dependencies.paths ?? productionPaths;
  const initialConfig = (dependencies.readConfig ?? readProductionConfig)({
    filePath: paths.configFile,
    productRoot: paths.productRoot,
  });
  const ports = submission.ports ?? initialConfig.ports;
  const config = {
    ...initialConfig,
    appBaseUrl: `https://${initialConfig.hostname}:${String(ports.https)}`,
    ports,
    database: {
      ...initialConfig.database,
      tlsMode: submission.tlsMode,
      toolsDirectory: submission.postgresToolsDirectory,
    },
    authentication: {
      ...initialConfig.authentication,
      ownerUsername: submission.ownerUsername,
    },
  };
  const validateAclTarget = dependencies.validateAclTarget ?? validateAclTargetForOperation;
  for (const [label, target, allowedRoot] of [
    ["log-directory", config.paths.logDirectory, paths.productRoot],
    ["backup-directory", config.paths.backupDirectory, paths.productRoot],
  ]) {
    validateAclTarget(target, {
      allowedRoot,
      validationRoot: paths.productRoot,
      stage: `configured-${label}-preflight`,
    });
  }
  await assertPortsAvailable(config, initialConfig.ports.setup, dependencies);
  (dependencies.writeConfig ?? writeProductionConfigAtomic)(config, {
    filePath: paths.configFile,
    allowedRoot: paths.configDirectory,
    productRoot: paths.productRoot,
  });
  const applyAcl =
    dependencies.applyAcl ??
    ((path, directory = false, aclOptions = {}) =>
      applyRestrictedAcl(path, {
        allowedRoot: paths.productRoot,
        directory,
        ...aclOptions,
        confirm: async () => true,
      }));
  await applyAcl(paths.configFile, false, {
    policy: "secure-descendant",
    allowInherited: true,
  });
  await (dependencies.storeSecrets ?? storeProductionSecrets)(
    { databaseUrl: submission.databaseUrl },
    {
      filePath: paths.secretFile,
      allowedRoot: paths.secretDirectory,
      confirm: async () => true,
    },
  );
  await applyAcl(paths.secretFile, false, { policy: "secret-file", allowInherited: false });
  const secrets = (dependencies.readSecrets ?? readProductionSecrets)(
    ["sessionSecret", "databaseUrl"],
    { filePath: paths.secretFile, allowedRoot: paths.secretDirectory },
  );
  const rawEnvironment = createProductionEnvironment(config, secrets, paths);
  const environment = parseEnvironment(rawEnvironment);
  const createDatabase = dependencies.createDatabase ?? createDatabaseAdapter;
  const database = createDatabase(environment);
  let recoveryCode = null;
  let ownerProvisioned = false;
  try {
    await (dependencies.inspectDatabase ?? inspectDatabasePrerequisites)(
      database,
      config,
      submission.databaseChoice,
      submission.databaseUrl,
    );
    await (dependencies.migrate ?? migrateDatabase)(database);
    await (dependencies.systemSeed ?? seedSystemDatabase)(database);
    const repository = new SqlFoundationRepository(database);
    const accountStore = new SqlLocalOwnerAccountStore(database);
    const existing = await (
      dependencies.findOwnerCredential ??
      ((username) => accountStore.findCredentialByUsername(username))
    )(submission.ownerUsername);
    if (!existing) {
      await (dependencies.verifyEmptyBootstrap ?? verifyEmptyProductionBootstrap)(database);
    }

    (dependencies.runBuild ?? runPinnedPnpm)(
      ["build"],
      createBuildEnvironment(config, paths),
      dependencies,
    );
    const manifest = (dependencies.createManifest ?? createBuildManifest)({ paths });
    (dependencies.writeManifest ?? writeBuildManifestAtomic)(manifest, {
      filePath: paths.buildManifestFile,
      allowedRoot: paths.runtimeDirectory,
    });
    await applyAcl(paths.runtimeDirectory, true, {
      policy: "secure-descendant",
      allowInherited: true,
    });
    await applyAcl(paths.buildManifestFile, false, {
      policy: "secure-descendant",
      allowInherited: true,
    });
    await applyAcl(config.paths.logDirectory, true, {
      policy: "secure-descendant",
      allowInherited: true,
      createIfMissing: true,
    });
    await applyAcl(config.paths.backupDirectory, true, {
      policy: "protected",
      allowInherited: false,
      createIfMissing: true,
    });

    if (!existing) {
      const owner = await (
        dependencies.provisionOwner ??
        ((username, password) => {
          const authentication = new LocalOwnerAuthenticationAdapter(
            {
              deploymentProfile: "local-live",
              sessionSecret: secrets.sessionSecret,
              sessionTtlMinutes: environment.sessionTtlMinutes,
            },
            repository,
            accountStore,
            repository,
          );
          return authentication.provisionOwner(username, password);
        })
      )(submission.ownerUsername, submission.password);
      recoveryCode = owner.recoveryCode;
      ownerProvisioned = true;
    }
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error;
  }
  try {
    await database.close();
  } catch (error) {
    if (!ownerProvisioned) throw error;
  }

  let finalized = false;
  const finalize = async () => {
    if (finalized) return;
    const finalDatabase = createDatabase(environment);
    try {
      const finalRepository = new SqlFoundationRepository(finalDatabase);
      await (dependencies.verifyProduction ?? verifyProductionDatabase)(finalDatabase, environment);
      await (dependencies.queueCheck ?? runProductionQueueCheck)(rawEnvironment);
      (dependencies.writeState ?? writeSetupState)(
        {
          schemaVersion: 1,
          profile: "local-live",
          completed: {
            toolchain: true,
            config: true,
            secrets: true,
            certificate: true,
            database: true,
            migrations: true,
            systemSeed: true,
            owner: true,
            queue: true,
            build: true,
          },
          updatedAt: new Date().toISOString(),
        },
        { path: paths.setupStateFile },
      );
      await applyAcl(paths.setupStateFile, false);
      await (dependencies.recordAudit ?? ((event) => finalRepository.record(event)))({
        eventType: "production.configuration-activated",
        action: "production.configure",
        outcome: "succeeded",
        actorUserId: null,
        resourceType: "production-profile",
        resourceId: "local-live",
        correlationId: null,
        metadata: {
          profile: "local-live",
          databaseChoice: submission.databaseChoice,
          tlsMode: submission.tlsMode,
          queueVerified: true,
        },
        createdAt: new Date().toISOString(),
      });
      finalized = true;
    } finally {
      await finalDatabase.close().catch((error) => {
        if (!finalized) throw error;
      });
    }
  };
  return Object.freeze({ recoveryCode, finalize });
}

export async function runProductionActivation(options = {}, dependencies = {}) {
  (dependencies.assertBoundary ?? assertRepositoryBoundary)({
    cwd: repositoryRoot,
    target: repositoryRoot,
  });
  const paths = dependencies.paths ?? productionPaths;
  const readiness = await (dependencies.inspectBootstrap ?? inspectBootstrapReadiness)({ paths });
  if (!readiness.readyForDatabaseAndOwnerSetup) {
    throw new Error(
      "Toolchain, protected config/secrets, and trusted Local Live HTTPS are required.",
    );
  }
  if (options.check) {
    const secretStatus = (dependencies.readSecretStatus ?? readSecretStatus)({
      filePath: paths.secretFile,
      allowedRoot: paths.secretDirectory,
    });
    return {
      outcome: secretStatus.records.databaseUrl.configured
        ? "READY_FOR_DEEP_DOCTOR"
        : "SETUP_REQUIRED",
    };
  }
  const config = readiness.config;
  const secrets = (dependencies.readSecrets ?? readProductionSecrets)(["httpsPfxPassword"], {
    filePath: paths.secretFile,
    allowedRoot: paths.secretDirectory,
  });
  const setup = await (dependencies.startSetup ?? startProductionSetupSession)({
    hostname: config.hostname,
    port: config.ports.setup,
    pfx: readFileSync(config.https.pfxPath),
    passphrase: secrets.httpsPfxPassword,
    defaults: { ports: config.ports },
    applySetup: (submission) => applyProductionActivation(submission, dependencies),
  });
  (dependencies.openBrowser ?? openSetupBrowser)(setup.url);
  process.stdout.write(
    `BEA secure Local Live setup opened at https://${config.hostname}:${String(config.ports.setup)}/setup.\n` +
      "The one-time authorization was not printed. Complete or close the setup page within ten minutes.\n",
  );
  const outcome = await setup.completion;
  if (outcome.outcome !== "PASS") throw new Error("The one-time setup session expired.");
  process.stdout.write(
    "Local Live database, Owner, queue, and build setup completed. The recovery code was shown only in the setup page.\n" +
      "BEA_PHASE134_ACTIVATION=PASS\n",
  );
  return outcome;
}

function parseArguments(arguments_) {
  if (arguments_.length === 0) return { check: false };
  if (arguments_.length === 1 && arguments_[0] === "--check") return { check: true };
  throw new Error("Usage: production-activation.mjs [--check]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const parsedOptions = parseArguments(process.argv.slice(2));
  runProductionActivation(parsedOptions)
    .then((result) => {
      if (parsedOptions.check) {
        process.stdout.write(`BEA_PHASE134_ACTIVATION=${result.outcome}\n`);
        if (result.outcome !== "READY_FOR_DEEP_DOCTOR") process.exitCode = 1;
      }
    })
    .catch((error) => {
      process.stderr.write(
        `BEA_PHASE134_ACTIVATION=BLOCKED (${error instanceof Error ? error.name : "UnknownError"})\n`,
      );
      process.exitCode = 1;
    });
}
