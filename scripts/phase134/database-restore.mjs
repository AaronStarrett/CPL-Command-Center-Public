import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";

import { assertRepositoryBoundary } from "../repository-boundary.mjs";
import { createProductionBackup } from "./database-backup.mjs";
import { readProductionConfig } from "./production-config.mjs";
import { productionPaths, repositoryRoot } from "./production-paths.mjs";
import { readProductionSecrets } from "./production-secrets.mjs";
import {
  postgresConnectionEnvironment,
  productionPostgresConnectionUrl,
  resolvePostgresTools,
  runPostgresTool,
  safeDatabaseDescriptor,
} from "./postgres-tools.mjs";
import { checkPortAvailable, readRuntimeMetadata } from "./runtime-control.mjs";

function contained(root, candidate) {
  const relationship = relative(resolve(root), resolve(candidate));
  return (
    relationship === "" ||
    (!relationship.startsWith(`..${sep}`) && relationship !== ".." && !isAbsolute(relationship))
  );
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function validateRestoreArchive(archivePath, config) {
  const archive = resolve(archivePath);
  if (!contained(config.paths.backupDirectory, archive) || !archive.endsWith(".dump")) {
    throw new Error(
      "Restore archive must be a .dump file inside the configured BEA backup directory.",
    );
  }
  const manifestPath = `${archive}.manifest.json`;
  if (!existsSync(archive) || !existsSync(manifestPath)) {
    throw new Error("Restore archive and manifest are both required.");
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error("Restore manifest is invalid.");
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.archiveFile !== basename(archive) ||
    !/^[a-f0-9]{64}$/u.test(manifest.archiveSha256 ?? "") ||
    manifest.archiveSha256 !== sha256(archive) ||
    typeof manifest.migrationVersion !== "string" ||
    !existsSync(
      resolve(
        repositoryRoot,
        "packages",
        "database",
        "migrations",
        `${manifest.migrationVersion}.sql`,
      ),
    )
  ) {
    throw new Error("Restore archive checksum or Phase 1.3.4 compatibility validation failed.");
  }
  return Object.freeze({ archive, manifestPath, manifest });
}

export function createRestorePlan(config, databaseUrl, tools, archive) {
  const target = safeDatabaseDescriptor(databaseUrl);
  if (archive.manifest.databaseName !== target.database) {
    throw new Error(
      "Restore archive database identity does not match the configured BEA database.",
    );
  }
  return Object.freeze({
    executable: tools.pgRestore,
    arguments: Object.freeze([
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-privileges",
      "--exit-on-error",
      "--single-transaction",
      "--dbname",
      target.database,
      archive.archive,
    ]),
    environment: postgresConnectionEnvironment(databaseUrl, config.database.tlsMode),
  });
}

export function acquireRestoreMaintenanceLock(paths, options = {}) {
  const lockPath = paths.runtimeLockFile ?? `${paths.runtimeMetadataFile}.lock`;
  let descriptor;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
    writeFileSync(
      descriptor,
      `${JSON.stringify({
        version: 1,
        kind: "maintenance-restore",
        repositoryRoot,
        ownerPid: options.pid ?? process.pid,
        operation: "restore",
        nonce: options.nonce ?? randomUUID(),
        createdAt: (options.now ?? new Date()).toISOString(),
      })}\n`,
      "utf8",
    );
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
      rmSync(lockPath, { force: true });
    }
    throw new Error(
      `The production maintenance lock could not be acquired (${error?.code ?? "LOCKED"}).`,
    );
  }
  let released = false;
  return Object.freeze({
    lockPath,
    release() {
      if (released) return;
      released = true;
      closeSync(descriptor);
      rmSync(lockPath, { force: true });
    },
  });
}

export async function assertRestoreRuntimeStopped(config, paths, dependencies = {}) {
  const tracked = (dependencies.readMetadata ?? readRuntimeMetadata)(paths.runtimeMetadataFile);
  if (tracked.exists) {
    throw new Error("Stop-BEA must complete and remove validated runtime metadata before restore.");
  }
  const lockPath = paths.runtimeLockFile ?? `${paths.runtimeMetadataFile}.lock`;
  if ((dependencies.exists ?? existsSync)(lockPath)) {
    throw new Error(
      "The production supervisor lock is present; restore cannot prove BEA is stopped.",
    );
  }
  for (const [name, port] of Object.entries(config.ports)) {
    const result = await (dependencies.checkPort ?? checkPortAvailable)(port);
    if (!result.available) {
      throw new Error(`Production port ${name} is occupied; restore cannot prove BEA is stopped.`);
    }
  }
}

async function defaultConfirm(archivePath) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(
      `Restore will replace data in the configured BEA database after a safety backup. Type RESTORE ${basename(archivePath)} to continue: `,
    );
    return answer === `RESTORE ${basename(archivePath)}`;
  } finally {
    terminal.close();
  }
}

export async function restoreProductionBackup(archivePath, options = {}, dependencies = {}) {
  (dependencies.assertBoundary ?? assertRepositoryBoundary)({
    cwd: repositoryRoot,
    target: repositoryRoot,
  });
  const paths = dependencies.paths ?? productionPaths;
  const config = (dependencies.readConfig ?? readProductionConfig)({ filePath: paths.configFile });
  await (dependencies.assertStopped ?? assertRestoreRuntimeStopped)(config, paths, dependencies);
  const archive = (dependencies.validateArchive ?? validateRestoreArchive)(archivePath, config);
  const maintenance = (dependencies.acquireMaintenanceLock ?? acquireRestoreMaintenanceLock)(paths);
  try {
    const approved = await (dependencies.confirm ?? defaultConfirm)(archive.archive);
    if (approved !== true) throw new Error("Owner declined the database restore.");
    const secrets = (dependencies.readSecrets ?? readProductionSecrets)(
      ["databaseUrl", "sessionSecret"],
      { filePath: paths.secretFile },
    );
    const tools = (dependencies.resolveTools ?? resolvePostgresTools)(config, options);
    const plan = (dependencies.createPlan ?? createRestorePlan)(
      config,
      secrets.databaseUrl,
      tools,
      archive,
    );

    const safetyBackup = await (dependencies.backup ?? createProductionBackup)(
      { prefix: "bea-pre-restore", quiet: true },
      dependencies,
    );
    const restored = (dependencies.runTool ?? runPostgresTool)(
      plan.executable,
      plan.arguments,
      plan.environment,
      { cwd: config.paths.backupDirectory },
    );
    if (restored.exitCode !== 0) {
      throw new Error(
        `pg_restore rolled back its single transaction. The pre-restore safety backup is ${basename(safetyBackup.archivePath)}.`,
      );
    }

    const migrationEnvironment = {
      ...plan.environment,
      APP_BASE_URL: config.appBaseUrl,
      APP_MODE: "production",
      BEA_AUTH_PROVIDER: config.authentication.provider,
      BEA_DEPLOYMENT_PROFILE: config.deploymentProfile,
      BEA_DISABLE_ENV_FILE: "true",
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
    };
    for (const operation of ["migrate", "system-seed", "verify-production"]) {
      const result = (dependencies.runMigration ?? runPostgresTool)(
        process.execPath,
        ["--import=tsx", "packages/database/src/cli/database-command.ts", operation],
        migrationEnvironment,
        { cwd: repositoryRoot },
      );
      if (result.exitCode !== 0) {
        throw new Error(`Post-restore ${operation} failed; automatic rollback was not attempted.`);
      }
    }
    process.stdout.write(
      `Restore completed from ${basename(archive.archive)}.\n` +
        `Pre-restore safety backup: ${basename(safetyBackup.archivePath)}\n` +
        `Migrations and production system seed were verified.\nBEA_PRODUCTION_RESTORE=PASS\n`,
    );
    return { outcome: "PASS", archive: archive.archive, safetyBackup: safetyBackup.archivePath };
  } finally {
    maintenance.release();
  }
}

if (process.argv[1]?.toLowerCase().endsWith("database-restore.mjs")) {
  const archivePath = process.argv[2];
  if (!archivePath || process.argv.length !== 3) {
    process.stderr.write("Usage: Restore-BEA.cmd <path-to-backup.dump>\n");
    process.exitCode = 1;
  } else {
    restoreProductionBackup(archivePath).catch((error) => {
      process.stderr.write(
        `BEA_PRODUCTION_RESTORE=BLOCKED (${error instanceof Error ? error.name : "UnknownError"})\n`,
      );
      process.exitCode = 1;
    });
  }
}
