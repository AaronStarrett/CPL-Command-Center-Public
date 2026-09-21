import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";

import { assertRepositoryBoundary } from "../repository-boundary.mjs";
import { currentDatabaseMigrationVersion } from "./build-manifest.mjs";
import { readProductionConfig } from "./production-config.mjs";
import { productionPaths, repositoryRoot } from "./production-paths.mjs";
import { readProductionSecrets } from "./production-secrets.mjs";
import {
  PRODUCTION_POSTGRES_PREREQUISITES_SQL,
  postgresConnectionEnvironment,
  productionPostgresConnectionUrl,
  resolvePostgresTools,
  runPostgresTool,
  safeDatabaseDescriptor,
  validateProductionPostgresPrerequisites,
} from "./postgres-tools.mjs";
import { applyRestrictedAcl, validateAclTargetForOperation } from "./windows-acl.mjs";

const requireFromRoot = createRequire(join(repositoryRoot, "package.json"));

function archiveTimestamp(date) {
  return date
    .toISOString()
    .replace(/[-:TZ]/gu, "")
    .replace(".", "-");
}

function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function createBackupPlan(config, databaseUrl, tools, options = {}) {
  const descriptor = safeDatabaseDescriptor(databaseUrl);
  const backupDirectory = resolve(config.paths.backupDirectory);
  const timestamp = archiveTimestamp(options.now ?? new Date());
  const prefix = options.prefix ?? "bea-production";
  if (!/^[a-z0-9-]+$/u.test(prefix)) throw new Error("Backup prefix is invalid.");
  const archivePath = join(backupDirectory, `${prefix}-${timestamp}.dump`);
  return Object.freeze({
    archivePath,
    manifestPath: `${archivePath}.manifest.json`,
    pgDump: tools.pgDump,
    arguments: Object.freeze([
      "--format=custom",
      "--compress=9",
      "--no-owner",
      "--no-privileges",
      "--file",
      archivePath,
    ]),
    connectionEnvironment: postgresConnectionEnvironment(
      databaseUrl,
      config.database.tlsMode,
      options.environment,
    ),
    descriptor,
  });
}

export async function inspectBackupDatabase(config, databaseUrl, options = {}) {
  const pg = options.pgModule ?? requireFromRoot("pg");
  const connectionString = productionPostgresConnectionUrl(databaseUrl, config.database.tlsMode);
  const pool = new pg.Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
  });
  try {
    const prerequisiteResult = await pool.query(PRODUCTION_POSTGRES_PREREQUISITES_SQL);
    validateProductionPostgresPrerequisites(prerequisiteResult.rows.at(0), {
      databaseUrl,
      tlsMode: config.database.tlsMode,
    });
    const server = await pool.query(
      "SELECT current_database() AS database_name,current_setting('server_version') AS server_version",
    );
    const migration = await pool.query(
      "SELECT id FROM bea_schema_migrations ORDER BY id DESC LIMIT 1",
    );
    return {
      databaseName: server.rows[0]?.database_name,
      serverVersion: server.rows[0]?.server_version,
      migrationVersion: String(migration.rows[0]?.id ?? "none").replace(/\.sql$/u, ""),
    };
  } finally {
    await pool.end();
  }
}

function writeManifestAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporary, path);
}

export function applyBackupRetention(directory, retentionCount, options = {}) {
  if (!Number.isSafeInteger(retentionCount) || retentionCount < 1 || retentionCount > 365) {
    throw new Error("Backup retention count must be from 1 through 365.");
  }
  const root = resolve(directory);
  const archives = readdirSync(root)
    .filter((name) => /^bea-(?:production|pre-restore)-\d{8}\d{6}-\d{3}\.dump$/u.test(name))
    .map((name) => ({ name, path: join(root, name), modified: statSync(join(root, name)).mtimeMs }))
    .sort((left, right) => right.modified - left.modified);
  const removed = [];
  for (const archive of archives.slice(retentionCount)) {
    const resolved = resolve(archive.path);
    if (!resolved.toLowerCase().startsWith(`${root.toLowerCase()}\\`)) {
      throw new Error("Backup retention target escaped the configured directory.");
    }
    (options.remove ?? rmSync)(resolved, { force: true });
    (options.remove ?? rmSync)(`${resolved}.manifest.json`, { force: true });
    removed.push(archive.name);
  }
  return Object.freeze(removed);
}

export async function createProductionBackup(options = {}, dependencies = {}) {
  (dependencies.assertBoundary ?? assertRepositoryBoundary)({
    cwd: repositoryRoot,
    target: repositoryRoot,
  });
  const paths = dependencies.paths ?? productionPaths;
  const config = (dependencies.readConfig ?? readProductionConfig)({ filePath: paths.configFile });
  (dependencies.validateAclTarget ?? validateAclTargetForOperation)(config.paths.backupDirectory, {
    allowedRoot: paths.productRoot,
    validationRoot: paths.productRoot,
    stage: "configured-backup-directory-preflight",
  });
  const secrets = (dependencies.readSecrets ?? readProductionSecrets)(["databaseUrl"], {
    filePath: paths.secretFile,
  });
  const tools = (dependencies.resolveTools ?? resolvePostgresTools)(config, options);
  const plan = createBackupPlan(config, secrets.databaseUrl, tools, {
    now: options.now ?? new Date(),
    prefix: options.prefix,
    environment: dependencies.environment ?? process.env,
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
  await applyAcl(config.paths.backupDirectory, true, {
    policy: "protected",
    allowInherited: false,
    createIfMissing: true,
  });
  const database = await (dependencies.inspectDatabase ?? inspectBackupDatabase)(
    config,
    secrets.databaseUrl,
    dependencies,
  );
  const result = (dependencies.runTool ?? runPostgresTool)(
    plan.pgDump,
    plan.arguments,
    plan.connectionEnvironment,
    { cwd: config.paths.backupDirectory },
  );
  if (result.exitCode !== 0) {
    rmSync(plan.archivePath, { force: true });
    throw new Error("pg_dump failed; incomplete output was removed.");
  }
  if (!existsSync(plan.archivePath) || statSync(plan.archivePath).size < 1) {
    rmSync(plan.archivePath, { force: true });
    throw new Error("pg_dump did not create a nonempty archive.");
  }
  const manifest = Object.freeze({
    schemaVersion: 1,
    createdAt: (options.now ?? new Date()).toISOString(),
    archiveFile: basename(plan.archivePath),
    archiveSha256: fileSha256(plan.archivePath),
    archiveBytes: statSync(plan.archivePath).size,
    databaseName: database.databaseName,
    serverVersion: database.serverVersion,
    migrationVersion: database.migrationVersion,
    sourceHost: plan.descriptor.host,
    sourcePort: plan.descriptor.port,
    pgDumpExecutable: basename(plan.pgDump),
  });
  if (manifest.migrationVersion !== currentDatabaseMigrationVersion().replace(/\.sql$/u, "")) {
    rmSync(plan.archivePath, { force: true });
    throw new Error("Database migration level does not match the running Phase 1.3.4 source.");
  }
  writeManifestAtomic(plan.manifestPath, manifest);
  await applyAcl(plan.archivePath, false, { policy: "secret-file", allowInherited: false });
  await applyAcl(plan.manifestPath, false, { policy: "secret-file", allowInherited: false });
  const retentionCount = config.paths.backupRetentionCount ?? 14;
  const removed = (dependencies.applyRetention ?? applyBackupRetention)(
    config.paths.backupDirectory,
    retentionCount,
  );
  if (!options.quiet) {
    process.stdout.write(
      `Backup created: ${plan.archivePath}\n` +
        `Archive SHA-256: ${manifest.archiveSha256}\n` +
        `Retention removals: ${String(removed.length)}\nBEA_PRODUCTION_BACKUP=PASS\n`,
    );
  }
  return { archivePath: plan.archivePath, manifestPath: plan.manifestPath, manifest, removed };
}

if (process.argv[1]?.toLowerCase().endsWith("database-backup.mjs")) {
  createProductionBackup().catch((error) => {
    process.stderr.write(
      `BEA_PRODUCTION_BACKUP=BLOCKED (${error instanceof Error ? error.name : "UnknownError"})\n`,
    );
    process.exitCode = 1;
  });
}
