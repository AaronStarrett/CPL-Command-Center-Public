import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { randomBytes } from "node:crypto";

import {
  DEFAULT_PRODUCTION_PORTS,
  validateProductionPorts,
  validateProfileOrigin,
} from "./production-profile.mjs";
import { assertPathContained, productionPaths, isPathContained } from "./production-paths.mjs";

export const CONFIG_SCHEMA_VERSION = 1;

const topLevelKeys = Object.freeze([
  "schemaVersion",
  "deploymentProfile",
  "appBaseUrl",
  "hostname",
  "ports",
  "database",
  "queue",
  "worker",
  "authentication",
  "https",
  "paths",
  "features",
]);

export class ProductionConfigValidationError extends Error {
  constructor(issues) {
    super(`Production configuration validation failed: ${issues.join("; ")}`);
    this.name = "ProductionConfigValidationError";
    this.issues = Object.freeze([...issues]);
  }
}

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertStrictObject(value, path, keys, issues) {
  if (!record(value)) {
    issues.push(`${path} must be an object`);
    return false;
  }
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) issues.push(`${path} has unknown fields: ${unknown.join(", ")}`);
  return true;
}

function isoTimestampOrNull(value, path, issues) {
  if (value === null) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    issues.push(`${path} must be null or an ISO timestamp`);
    return null;
  }
  return new Date(value).toISOString();
}

function absolutePath(value, path, issues) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    issues.push(`${path} must be an absolute path`);
    return "";
  }
  return resolve(value);
}

function nullableAbsolutePath(value, path, issues) {
  if (value === null) return null;
  return absolutePath(value, path, issues);
}

export function migrateProductionConfig(input) {
  if (!record(input))
    throw new ProductionConfigValidationError(["configuration must be an object"]);
  if (input.schemaVersion === CONFIG_SCHEMA_VERSION) return structuredClone(input);
  if (input.schemaVersion === 0) {
    const migrated = structuredClone(input);
    return {
      ...migrated,
      schemaVersion: 1,
      features: input.features ?? { webSearchEnabled: false, realtimeEnabled: false },
      database: {
        ...migrated.database,
        toolsDirectory: migrated.database?.toolsDirectory ?? null,
      },
      paths: {
        ...migrated.paths,
        backupRetentionCount: migrated.paths?.backupRetentionCount ?? 14,
      },
    };
  }
  throw new ProductionConfigValidationError([
    `unsupported schemaVersion ${String(input.schemaVersion)}`,
  ]);
}

export function validateProductionConfig(input, options = {}) {
  const issues = [];
  if (!assertStrictObject(input, "configuration", topLevelKeys, issues)) {
    throw new ProductionConfigValidationError(issues);
  }
  if (input.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    issues.push(`schemaVersion must equal ${CONFIG_SCHEMA_VERSION}`);
  }

  let origin;
  try {
    origin = validateProfileOrigin(input);
  } catch (error) {
    issues.push(...(error.issues ?? [error.message]));
  }
  let ports;
  try {
    ports = validateProductionPorts(input.ports);
  } catch (error) {
    issues.push(...(error.issues ?? [error.message]));
  }
  if (ports && origin) {
    const originPort = Number(new URL(origin.appBaseUrl).port || 443);
    if (originPort !== ports.https) issues.push("appBaseUrl port must match ports.https");
  }

  let database;
  if (
    assertStrictObject(input.database, "database", ["driver", "tlsMode", "toolsDirectory"], issues)
  ) {
    if (input.database.driver !== "postgres") issues.push("database.driver must be postgres");
    if (!["prefer", "require", "verify-full"].includes(input.database.tlsMode)) {
      issues.push("database.tlsMode must be prefer, require, or verify-full");
    }
    database = {
      driver: input.database.driver,
      tlsMode: input.database.tlsMode,
      toolsDirectory: nullableAbsolutePath(
        input.database.toolsDirectory,
        "database.toolsDirectory",
        issues,
      ),
    };
  }

  let queue;
  if (assertStrictObject(input.queue, "queue", ["adapter"], issues)) {
    if (input.queue.adapter !== "pg-boss") issues.push("queue.adapter must be pg-boss");
    queue = { adapter: input.queue.adapter };
  }

  let worker;
  if (assertStrictObject(input.worker, "worker", ["mode"], issues)) {
    if (input.worker.mode !== "serve") issues.push("worker.mode must be serve");
    worker = { mode: input.worker.mode };
  }

  let authentication;
  if (
    assertStrictObject(
      input.authentication,
      "authentication",
      ["provider", "ownerUsername"],
      issues,
    )
  ) {
    const expectedProvider =
      input.deploymentProfile === "local-live" ? "local-owner" : "microsoft-entra";
    if (input.authentication.provider !== expectedProvider) {
      issues.push(
        `${input.deploymentProfile} requires authentication.provider=${expectedProvider}`,
      );
    }
    if (input.deploymentProfile === "local-live") {
      if (
        typeof input.authentication.ownerUsername !== "string" ||
        !/^[A-Za-z0-9._@-]{3,64}$/u.test(input.authentication.ownerUsername)
      ) {
        issues.push("local-live authentication.ownerUsername is invalid");
      }
    } else if (input.authentication.ownerUsername !== null) {
      issues.push("enterprise authentication.ownerUsername must be null");
    }
    authentication = {
      provider: input.authentication.provider,
      ownerUsername: input.authentication.ownerUsername,
    };
  }

  let https;
  if (
    assertStrictObject(
      input.https,
      "https",
      ["pfxPath", "certificateThumbprint", "notAfter"],
      issues,
    )
  ) {
    const pfxPath = absolutePath(input.https.pfxPath, "https.pfxPath", issues);
    const expectedRoot = options.productRoot ?? productionPaths.productRoot;
    if (
      input.deploymentProfile === "local-live" &&
      pfxPath &&
      !isPathContained(resolve(expectedRoot, "certificates"), pfxPath)
    ) {
      issues.push(
        "local-live https.pfxPath must remain inside the protected certificate directory",
      );
    }
    const thumbprint = input.https.certificateThumbprint;
    if (thumbprint !== null && !/^[A-Fa-f0-9]{40,128}$/u.test(thumbprint ?? "")) {
      issues.push("https.certificateThumbprint must be null or a hexadecimal thumbprint");
    }
    https = {
      pfxPath,
      certificateThumbprint: thumbprint === null ? null : thumbprint.toUpperCase(),
      notAfter: isoTimestampOrNull(input.https.notAfter, "https.notAfter", issues),
    };
  }

  let configuredPaths;
  if (
    assertStrictObject(
      input.paths,
      "paths",
      ["logDirectory", "backupDirectory", "backupRetentionCount"],
      issues,
    )
  ) {
    const logDirectory = absolutePath(input.paths.logDirectory, "paths.logDirectory", issues);
    const backupDirectory = absolutePath(
      input.paths.backupDirectory,
      "paths.backupDirectory",
      issues,
    );
    if (
      !Number.isInteger(input.paths.backupRetentionCount) ||
      input.paths.backupRetentionCount < 1 ||
      input.paths.backupRetentionCount > 365
    ) {
      issues.push("paths.backupRetentionCount must be an integer from 1 through 365");
    }
    const expectedRoot = options.productRoot ?? productionPaths.productRoot;
    if (input.deploymentProfile === "local-live") {
      if (logDirectory && !isPathContained(expectedRoot, logDirectory)) {
        issues.push("local-live logDirectory must remain inside the BEA product root");
      }
      if (backupDirectory && !isPathContained(expectedRoot, backupDirectory)) {
        issues.push("local-live backupDirectory must remain inside the BEA product root");
      }
    }
    configuredPaths = {
      logDirectory,
      backupDirectory,
      backupRetentionCount: input.paths.backupRetentionCount,
    };
  }

  let features;
  if (
    assertStrictObject(input.features, "features", ["webSearchEnabled", "realtimeEnabled"], issues)
  ) {
    if (typeof input.features.webSearchEnabled !== "boolean") {
      issues.push("features.webSearchEnabled must be boolean");
    }
    if (typeof input.features.realtimeEnabled !== "boolean") {
      issues.push("features.realtimeEnabled must be boolean");
    }
    features = {
      webSearchEnabled: input.features.webSearchEnabled,
      realtimeEnabled: input.features.realtimeEnabled,
    };
  }

  if (issues.length > 0) throw new ProductionConfigValidationError(issues);
  return Object.freeze({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    ...origin,
    ports,
    database: Object.freeze(database),
    queue: Object.freeze(queue),
    worker: Object.freeze(worker),
    authentication: Object.freeze(authentication),
    https: Object.freeze(https),
    paths: Object.freeze(configuredPaths),
    features: Object.freeze(features),
  });
}

export function createDefaultProductionConfig(options = {}) {
  const paths = options.paths ?? productionPaths;
  const ports = options.ports ?? DEFAULT_PRODUCTION_PORTS;
  return validateProductionConfig(
    {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      deploymentProfile: "local-live",
      appBaseUrl: `https://bea.localhost:${String(ports.https)}`,
      hostname: "bea.localhost",
      ports,
      database: { driver: "postgres", tlsMode: "prefer", toolsDirectory: null },
      queue: { adapter: "pg-boss" },
      worker: { mode: "serve" },
      authentication: { provider: "local-owner", ownerUsername: options.ownerUsername ?? "owner" },
      https: {
        pfxPath: paths.certificatePfxFile,
        certificateThumbprint: null,
        notAfter: null,
      },
      paths: {
        logDirectory: paths.logDirectory,
        backupDirectory: paths.backupDirectory,
        backupRetentionCount: 14,
      },
      features: { webSearchEnabled: false, realtimeEnabled: false },
    },
    { productRoot: paths.productRoot },
  );
}

function resolvedReadOptions(input) {
  return typeof input === "string" ? { filePath: input } : input;
}

export function readProductionConfig(input = {}) {
  const options = resolvedReadOptions(input);
  const filePath = resolve(options.filePath ?? productionPaths.configFile);
  const bytes = readFileSync(filePath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    throw new ProductionConfigValidationError(["production config is not valid JSON"]);
  }
  const migrated = options.migrate === false ? parsed : migrateProductionConfig(parsed);
  return validateProductionConfig(migrated, {
    productRoot: options.productRoot ?? productionPaths.productRoot,
  });
}

export function writeProductionConfigAtomic(config, options = {}) {
  const filePath = resolve(options.filePath ?? productionPaths.configFile);
  const allowedRoot = resolve(options.allowedRoot ?? productionPaths.configDirectory);
  assertPathContained(allowedRoot, filePath, "Production config path");
  const validated = validateProductionConfig(config, {
    productRoot: options.productRoot ?? productionPaths.productRoot,
  });
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  if (existsSync(filePath) && lstatSync(filePath).isSymbolicLink()) {
    throw new Error("Production config cannot be written through a symbolic link.");
  }
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, filePath);
    options.applyAcl?.(filePath);
    return validated;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
  }
}

export function productionConfigToEnvironment(config, options = {}) {
  const validated = validateProductionConfig(config, options);
  return Object.freeze({
    APP_MODE: "production",
    BEA_RUNTIME_MODE: "production",
    NODE_ENV: "production",
    BEA_DISABLE_ENV_FILE: "true",
    DEMO_AUTH_ENABLED: "false",
    BEA_DEPLOYMENT_PROFILE: validated.deploymentProfile,
    APP_BASE_URL: validated.appBaseUrl,
    PORT: String(validated.ports.web),
    WORKER_HEALTH_PORT: String(validated.ports.workerHealth),
    BEA_PRODUCTION_CONTROL_PORT: String(validated.ports.control),
    DATABASE_DRIVER: validated.database.driver,
    WORKER_QUEUE_ADAPTER: validated.queue.adapter,
    WORKER_MODE: validated.worker.mode,
    BEA_AUTH_PROVIDER: validated.authentication.provider,
  });
}
