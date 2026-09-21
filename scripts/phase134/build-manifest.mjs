import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { CONFIG_SCHEMA_VERSION } from "./production-config.mjs";
import {
  assertPathContained,
  productionPaths,
  repositoryRoot,
  TOOLCHAIN_NODE_VERSION,
  TOOLCHAIN_PNPM_VERSION,
} from "./production-paths.mjs";
import { verifyPinnedToolchain } from "./toolchain-bootstrap.mjs";

export const BUILD_MANIFEST_VERSION = 1;

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  return {
    exitCode: result.status ?? (result.error ? 1 : 0),
    stdout: String(result.stdout ?? "").trim(),
  };
}

function currentGitCommit(options) {
  if (options.gitCommit) return options.gitCommit;
  const result = (options.run ?? run)(
    options.gitExecutable ?? "git.exe",
    ["-c", `safe.directory=${repositoryRoot.replaceAll("\\", "/")}`, "rev-parse", "HEAD"],
    { cwd: repositoryRoot },
  );
  if (result.exitCode !== 0 || !/^[a-f0-9]{40}$/u.test(result.stdout)) {
    throw new Error("The current Git commit could not be resolved for the build manifest.");
  }
  return result.stdout;
}

export function currentDatabaseMigrationVersion(options = {}) {
  const migrationDirectory = resolve(
    options.migrationDirectory ?? join(repositoryRoot, "packages", "database", "migrations"),
  );
  const migrations = readdirSync(migrationDirectory)
    .filter((name) => /^\d{4}_[A-Za-z0-9_.-]+\.sql$/u.test(name))
    .sort();
  if (migrations.length === 0) throw new Error("No database migrations were found.");
  return migrations.at(-1).replace(/\.sql$/u, "");
}

export function validateBuildManifest(value) {
  const issues = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Build manifest is invalid.");
  }
  const allowed = [
    "manifestVersion",
    "gitCommit",
    "buildTimestamp",
    "nodeVersion",
    "pnpmVersion",
    "configSchemaVersion",
    "databaseMigrationVersion",
    "packageLockSha256",
  ];
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) issues.push(`unknown fields: ${unknown.join(", ")}`);
  if (value.manifestVersion !== BUILD_MANIFEST_VERSION)
    issues.push("manifestVersion is unsupported");
  if (!/^[a-f0-9]{40}$/u.test(value.gitCommit ?? "")) issues.push("gitCommit is invalid");
  if (typeof value.buildTimestamp !== "string" || Number.isNaN(Date.parse(value.buildTimestamp))) {
    issues.push("buildTimestamp is invalid");
  }
  if (value.nodeVersion !== TOOLCHAIN_NODE_VERSION) issues.push("nodeVersion is not pinned");
  if (value.pnpmVersion !== TOOLCHAIN_PNPM_VERSION) issues.push("pnpmVersion is not pinned");
  if (value.configSchemaVersion !== CONFIG_SCHEMA_VERSION) {
    issues.push("configSchemaVersion is unsupported");
  }
  if (!/^\d{4}_[A-Za-z0-9_.-]+$/u.test(value.databaseMigrationVersion ?? "")) {
    issues.push("databaseMigrationVersion is invalid");
  }
  if (!/^[a-f0-9]{64}$/u.test(value.packageLockSha256 ?? "")) {
    issues.push("packageLockSha256 is invalid");
  }
  if (issues.length > 0) throw new Error(`Build manifest is invalid: ${issues.join("; ")}`);
  return Object.freeze({ ...value });
}

export function createBuildManifest(options = {}) {
  const toolchain = options.toolchainStatus ?? verifyPinnedToolchain(options);
  if (!toolchain.ok)
    throw new Error("The exact BEA toolchain is required to create a build manifest.");
  const lockfilePath = resolve(options.lockfilePath ?? join(repositoryRoot, "pnpm-lock.yaml"));
  return validateBuildManifest({
    manifestVersion: BUILD_MANIFEST_VERSION,
    gitCommit: currentGitCommit(options),
    buildTimestamp: (options.now ?? (() => new Date()))().toISOString(),
    nodeVersion: toolchain.nodeVersion,
    pnpmVersion: toolchain.pnpmVersion,
    configSchemaVersion: CONFIG_SCHEMA_VERSION,
    databaseMigrationVersion:
      options.databaseMigrationVersion ?? currentDatabaseMigrationVersion(options),
    packageLockSha256: options.packageLockSha256 ?? sha256(lockfilePath),
  });
}

export function readBuildManifest(options = {}) {
  const filePath = resolve(options.filePath ?? productionPaths.buildManifestFile);
  try {
    return validateBuildManifest(JSON.parse(readFileSync(filePath, "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Build manifest is not valid JSON.");
    throw error;
  }
}

export function writeBuildManifestAtomic(manifest, options = {}) {
  const validated = validateBuildManifest(manifest);
  const filePath = resolve(options.filePath ?? productionPaths.buildManifestFile);
  const allowedRoot = resolve(options.allowedRoot ?? productionPaths.runtimeDirectory);
  assertPathContained(allowedRoot, filePath, "Build manifest path");
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, filePath);
    options.applyAcl?.(filePath);
    return validated;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

export function checkBuildFreshness(manifest, expected, options = {}) {
  const validated = validateBuildManifest(manifest);
  const mismatches = [];
  for (const key of [
    "gitCommit",
    "nodeVersion",
    "pnpmVersion",
    "configSchemaVersion",
    "databaseMigrationVersion",
    "packageLockSha256",
  ]) {
    if (validated[key] !== expected[key]) mismatches.push(key);
  }
  return Object.freeze({
    fresh: mismatches.length === 0,
    mismatches: Object.freeze(mismatches),
    rebuildCommand: `"${(options.paths ?? productionPaths).pnpmExecutable}" build`,
  });
}
