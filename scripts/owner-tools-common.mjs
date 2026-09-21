import { spawn, spawnSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createNetServer } from "node:net";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { assertRepositoryBoundary } from "./repository-boundary.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

export const repositoryRoot = resolve(scriptDirectory, "..");
export const demoHost = "127.0.0.1";
export const webPort = 3_000;
export const workerPort = 3_001;
export const controlPort = 3_002;
export const webUrl = `http://${demoHost}:${webPort}`;
export const signInUrl = `${webUrl}/sign-in`;
export const workerHealthUrl = `http://${demoHost}:${workerPort}/health`;
export const controlUrl = `http://${demoHost}:${controlPort}`;

const stateDirectory = join(repositoryRoot, ".data", "bea-owner-tools");

export const ownerToolPaths = Object.freeze({
  initializationFile: join(stateDirectory, "demo-initialized.json"),
  logDirectory: join(stateDirectory, "logs"),
  metadataFile: join(stateDirectory, "demo-process.json"),
  stateDirectory,
});

const safeEnvironmentKeys = [
  "APPDATA",
  "ComSpec",
  "COMSPEC",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "Path",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "SystemDrive",
  "SystemRoot",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USERPROFILE",
  "WINDIR",
];

export function assertOwnerToolBoundary() {
  return assertRepositoryBoundary({ cwd: process.cwd(), target: repositoryRoot });
}

export function normalizeWindowsPath(value) {
  return resolve(value)
    .replace(/[\\/]+$/u, "")
    .toLowerCase();
}

export function pathsEqual(left, right) {
  return normalizeWindowsPath(left) === normalizeWindowsPath(right);
}

export function isPathWithin(candidate, parent) {
  const candidatePath = normalizeWindowsPath(candidate);
  const parentPath = normalizeWindowsPath(parent);
  return candidatePath === parentPath || candidatePath.startsWith(`${parentPath}${sep}`);
}

export function relativeToRepository(path) {
  const value = relative(repositoryRoot, path);
  if (!value || value.startsWith("..") || isAbsolute(value)) {
    throw new Error("Owner-tool path is outside the BEA repository.");
  }
  return value.replaceAll("\\", "/");
}

function stripOptionalQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

export function readLocalEnvironment(options = {}) {
  const path = join(repositoryRoot, ".env.local");
  const environment = options.processEnvironment ?? process.env;
  const environmentFilesDisabled =
    process.env.BEA_DISABLE_ENV_FILE?.trim().toLowerCase() === "true" ||
    environment.BEA_DISABLE_ENV_FILE?.trim().toLowerCase() === "true";
  if (environmentFilesDisabled) {
    return {
      disabled: true,
      exists: false,
      path,
      values: new Map(),
      malformedLines: [],
    };
  }

  const fileExists = options.fileExists ?? existsSync;
  const readFile = options.readFile ?? readFileSync;
  if (!fileExists(path)) return { exists: false, path, values: new Map(), malformedLines: [] };

  const values = new Map();
  const malformedLines = [];
  const lines = readFile(path, "utf8")
    .replace(/^\uFEFF/u, "")
    .split(/\r?\n/u);
  for (const [index, sourceLine] of lines.entries()) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) {
      malformedLines.push(index + 1);
      continue;
    }
    values.set(match[1], stripOptionalQuotes(match[2].trim()));
  }
  return { exists: true, path, values, malformedLines };
}

function configuredValue(values, key, fallback) {
  const value = values.get(key);
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

function isBooleanTrue(value) {
  return value.toLowerCase() === "true";
}

export function inspectDemoEnvironment(options = {}) {
  const local = readLocalEnvironment(options);
  const issues = [];
  const warnings = [];
  if (local.malformedLines.length > 0) {
    issues.push(`.env.local has malformed entries on line(s) ${local.malformedLines.join(", ")}.`);
  }
  if (!local.exists) {
    warnings.push(
      local.disabled
        ? ".env.local inspection is disabled; the launcher will use its fixed safe demo defaults."
        : ".env.local is absent; the launcher will use its fixed safe demo defaults.",
    );
  }

  const values = local.values;
  const appMode = configuredValue(values, "APP_MODE", "demo");
  const databaseDriver = configuredValue(values, "DATABASE_DRIVER", "pglite");
  const demoAuthEnabled = configuredValue(values, "DEMO_AUTH_ENABLED", "true");
  const workerMode = configuredValue(values, "WORKER_MODE", "serve");
  const queueAdapter = configuredValue(values, "WORKER_QUEUE_ADAPTER", "inline");
  const configuredWebPort = configuredValue(values, "PORT", String(webPort));
  const configuredWorkerPort = configuredValue(values, "WORKER_HEALTH_PORT", String(workerPort));
  const appBaseUrl = configuredValue(values, "APP_BASE_URL", webUrl);
  const demoDatabasePath = configuredValue(values, "DEMO_DATABASE_PATH", ".data/pglite");
  const workerDatabasePath = configuredValue(values, "WORKER_DEMO_DATABASE_PATH", "memory://");

  if (appMode !== "demo") issues.push("APP_MODE must be demo for the owner launcher.");
  if (databaseDriver !== "pglite")
    issues.push("DATABASE_DRIVER must be pglite for the local demo.");
  if (!isBooleanTrue(demoAuthEnabled))
    issues.push("DEMO_AUTH_ENABLED must be true for the local demo.");
  if (workerMode !== "serve") issues.push("WORKER_MODE must be serve for the local demo.");
  if (queueAdapter !== "inline")
    issues.push("WORKER_QUEUE_ADAPTER must be inline for the local demo.");
  if (configuredWebPort !== String(webPort))
    issues.push(`PORT must be ${webPort} for the owner launcher.`);
  if (configuredWorkerPort !== String(workerPort)) {
    issues.push(`WORKER_HEALTH_PORT must be ${workerPort} for the owner launcher.`);
  }

  try {
    const url = new URL(appBaseUrl);
    const isExpectedOrigin =
      url.protocol === "http:" &&
      url.hostname === demoHost &&
      url.port === String(webPort) &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "";
    if (!isExpectedOrigin) issues.push(`APP_BASE_URL must be ${webUrl}.`);
  } catch {
    issues.push("APP_BASE_URL must be a valid loopback URL.");
  }

  if (demoDatabasePath !== "memory://") {
    const resolvedDatabasePath = resolve(repositoryRoot, demoDatabasePath);
    if (!isPathWithin(resolvedDatabasePath, join(repositoryRoot, ".data"))) {
      issues.push("DEMO_DATABASE_PATH must resolve inside the repository .data directory.");
    }
  }
  if (workerDatabasePath !== "memory://") {
    const resolvedWorkerPath = resolve(repositoryRoot, workerDatabasePath);
    if (!isPathWithin(resolvedWorkerPath, join(repositoryRoot, ".data"))) {
      issues.push("WORKER_DEMO_DATABASE_PATH must be memory:// or resolve inside .data.");
    }
    const resolvedDemoPath = resolve(repositoryRoot, demoDatabasePath);
    if (pathsEqual(resolvedWorkerPath, resolvedDemoPath)) {
      issues.push("Web and worker PGlite paths must be distinct.");
    }
  }

  return {
    issues,
    localEnvironmentExists: local.exists,
    localEnvironmentInspectionDisabled: local.disabled === true,
    profile: {
      appMode: "demo",
      databaseDriver: "pglite",
      queueAdapter: "inline",
      webPort,
      workerPort,
    },
    warnings,
  };
}

export function createDemoChildEnvironment(source = process.env) {
  const environment = {};
  for (const key of safeEnvironmentKeys) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  return {
    ...environment,
    BEA_DISABLE_ENV_FILE: "true",
    OPENAI_API_KEY: "",
    NODE_ENV: "development",
    APP_MODE: "demo",
    APP_BASE_URL: webUrl,
    DATABASE_DRIVER: "pglite",
    DEMO_DATABASE_PATH: ".data/pglite",
    WORKER_DEMO_DATABASE_PATH: "memory://",
    DEMO_AUTH_ENABLED: "true",
    SESSION_TTL_MINUTES: "480",
    WORKER_MODE: "serve",
    WORKER_QUEUE_ADAPTER: "inline",
    WORKER_POLL_INTERVAL_MS: "60000",
    WORKER_HEALTH_PORT: String(workerPort),
    LOG_LEVEL: "info",
    PORT: String(webPort),
  };
}

function pathEntries() {
  const pathValue = process.env.Path ?? process.env.PATH ?? "";
  return pathValue
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/gu, ""))
    .filter(Boolean);
}

export function findExecutable(fileNames) {
  for (const directory of pathEntries()) {
    for (const fileName of fileNames) {
      const candidate = join(directory, fileName);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export function runExecutable(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    shell: options.shell ?? false,
    stdio: options.stdio ?? "pipe",
    windowsHide: true,
  });
  return {
    error: result.error,
    exitCode: result.status ?? (result.error ? 1 : 0),
    stderr: String(result.stderr ?? "").trim(),
    stdout: String(result.stdout ?? "").trim(),
  };
}

export function runPnpm(pnpmCommand, arguments_, options = {}) {
  const windowsCommand = process.platform === "win32";
  const executable = windowsCommand ? process.env.ComSpec || "cmd.exe" : pnpmCommand;
  const executableArguments = windowsCommand
    ? ["/d", "/s", "/c", pnpmCommand, ...arguments_]
    : arguments_;
  return runExecutable(executable, executableArguments, {
    ...options,
    shell: false,
  });
}

export async function checkPort(port) {
  return new Promise((resolveCheck) => {
    const server = createNetServer();
    const finish = (result) => {
      server.removeAllListeners();
      resolveCheck(result);
    };
    server.once("error", (error) => finish({ available: false, code: error.code ?? "UNKNOWN" }));
    server.listen({ exclusive: true, host: demoHost, port }, () => {
      server.close((error) =>
        finish(
          error ? { available: false, code: error.code ?? "CLOSE_FAILED" } : { available: true },
        ),
      );
    });
  });
}

export function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function ensureOwnerToolDirectories() {
  mkdirSync(ownerToolPaths.logDirectory, { recursive: true });
}

export function createRunLogPaths() {
  const runId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomBytes(4).toString("hex")}`;
  return {
    supervisor: join(ownerToolPaths.logDirectory, `${runId}-supervisor.log`),
    web: join(ownerToolPaths.logDirectory, `${runId}-web.log`),
    worker: join(ownerToolPaths.logDirectory, `${runId}-worker.log`),
  };
}

export function openAppendOnlyLog(path) {
  return openSync(path, "a", 0o600);
}

export function closeFileDescriptor(fileDescriptor) {
  try {
    closeSync(fileDescriptor);
  } catch {
    // The descriptor may already have been transferred or closed.
  }
}

export function writeJsonAtomic(path, value) {
  const temporaryPath = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  rmSync(path, { force: true });
  renameSync(temporaryPath, path);
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateMetadata(value) {
  const issues = [];
  if (!isRecord(value)) return { issues: ["Metadata is not an object."] };
  if (value.version !== 1) issues.push("Metadata version is unsupported.");
  if (
    typeof value.repositoryRoot !== "string" ||
    !pathsEqual(value.repositoryRoot, repositoryRoot)
  ) {
    issues.push("Metadata repository root does not match this canonical BEA repository.");
  }
  if (!Number.isSafeInteger(value.supervisorPid) || value.supervisorPid <= 0) {
    issues.push("Metadata supervisor PID is invalid.");
  }
  if (typeof value.controlToken !== "string" || !/^[a-f0-9]{64}$/u.test(value.controlToken)) {
    issues.push("Metadata control token is invalid.");
  }
  if (value.controlHost !== demoHost || value.controlPort !== controlPort) {
    issues.push("Metadata control endpoint is not the fixed loopback endpoint.");
  }
  if (value.webPort !== webPort || value.workerPort !== workerPort) {
    issues.push("Metadata service ports do not match the owner-tool profile.");
  }
  if (typeof value.state !== "string") issues.push("Metadata state is invalid.");
  return issues.length > 0 ? { issues } : { issues: [], metadata: value };
}

export function readValidatedMetadata() {
  if (!existsSync(ownerToolPaths.metadataFile)) return { exists: false, issues: [] };
  try {
    const validation = validateMetadata(readJson(ownerToolPaths.metadataFile));
    return { exists: true, ...validation };
  } catch (error) {
    return {
      exists: true,
      issues: [
        `Metadata could not be read (${error instanceof Error ? error.name : "UnknownError"}).`,
      ],
    };
  }
}

export function removeMetadataOwnedBy(metadata) {
  const current = readValidatedMetadata();
  if (
    current.metadata &&
    current.metadata.supervisorPid === metadata.supervisorPid &&
    current.metadata.controlToken === metadata.controlToken
  ) {
    rmSync(ownerToolPaths.metadataFile, { force: true });
    return true;
  }
  return false;
}

export function tokensMatch(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export async function controlRequest(metadata, path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMilliseconds ?? 2_000);
  try {
    const response = await fetch(`${controlUrl}${path}`, {
      method: options.method ?? "GET",
      headers: { "x-bea-control-token": metadata.controlToken },
      signal: controller.signal,
      cache: "no-store",
    });
    const body = await response.json().catch(() => undefined);
    return { body, ok: response.ok, status: response.status };
  } finally {
    clearTimeout(timeout);
  }
}

export async function inspectTrackedDemo() {
  const metadataResult = readValidatedMetadata();
  if (!metadataResult.exists) return { state: "stopped" };
  if (!metadataResult.metadata) {
    return { issues: metadataResult.issues, state: "invalid" };
  }

  const metadata = metadataResult.metadata;
  if (!processIsAlive(metadata.supervisorPid)) {
    return { metadata, state: "stale" };
  }

  try {
    const response = await controlRequest(metadata, "/status");
    if (
      !response.ok ||
      !isRecord(response.body) ||
      response.body.supervisorPid !== metadata.supervisorPid
    ) {
      return { metadata, state: "unreachable" };
    }
    return { metadata, state: "running", status: response.body };
  } catch {
    return { metadata, state: "unreachable" };
  }
}

export async function waitFor(predicate, options = {}) {
  const deadline = Date.now() + (options.timeoutMilliseconds ?? 30_000);
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, options.intervalMilliseconds ?? 250),
    );
  }
  if (lastError) throw lastError;
  throw new Error(options.timeoutMessage ?? "Timed out waiting for the owner-tool operation.");
}

export function openInDefaultBrowser(url) {
  if (process.platform !== "win32") throw new Error("The owner launcher supports Windows only.");
  const command = process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe";
  const child = spawn(command, ["/d", "/s", "/c", "start", "", url], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

export function formatRelativePath(path) {
  return relativeToRepository(path);
}

export function safeFailure(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : "UnknownError";
}
