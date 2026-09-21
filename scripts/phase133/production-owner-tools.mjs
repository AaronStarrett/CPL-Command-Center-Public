import { spawnSync } from "node:child_process";
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

import { assertRepositoryBoundary } from "../repository-boundary.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const stateDirectoryName = "bea-production-owner-tools";

export const repositoryRoot = resolve(scriptDirectory, "../..");
export const productionHost = "127.0.0.1";
export const expectedNodeVersion = "24.19.0";
export const expectedPnpmVersion = "11.19.0";

const stateDirectory = join(repositoryRoot, ".data", stateDirectoryName);

export const productionOwnerToolPaths = Object.freeze({
  logDirectory: join(stateDirectory, "logs"),
  metadataFile: join(stateDirectory, "production-process.json"),
  stateDirectory,
});

const safeInheritedEnvironmentKeys = Object.freeze([
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
]);

const productionEnvironmentKeys = Object.freeze([
  "APP_BASE_URL",
  "BEA_AUTH_PROVIDER",
  "BEA_AUTH_READY",
  "BEA_OPENAI_SETUP_READY",
  "BEA_PRODUCTION_CONTROL_PORT",
  "DATABASE_URL",
  "LOG_LEVEL",
  "OPENAI_API_KEY",
  "PORT",
  "SESSION_SECRET",
  "SESSION_TTL_MINUTES",
  "WORKER_HEALTH_PORT",
  "WORKER_POLL_INTERVAL_MS",
]);

const sensitiveEnvironmentKeys = Object.freeze([
  "DATABASE_URL",
  "OPENAI_API_KEY",
  "SESSION_SECRET",
]);

export function assertProductionOwnerToolBoundary(options = {}) {
  return assertRepositoryBoundary({
    cwd: options.cwd ?? process.cwd(),
    target: options.target ?? repositoryRoot,
  });
}

function normalizeWindowsPath(value) {
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
    throw new Error("Production owner-tool path is outside the BEA repository.");
  }
  return value.replaceAll("\\", "/");
}

function normalizedValue(environment, key) {
  const value = environment[key];
  return typeof value === "string" ? value.trim() : "";
}

function exactTrue(value) {
  return value.toLowerCase() === "true";
}

export function parsePort(value) {
  if (!/^\d{1,5}$/u.test(value)) return undefined;
  const port = Number(value);
  return Number.isSafeInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

function safeHttpsOrigin(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function addEnvironmentCheck(checks, name, passed, passDetail, blockedDetail) {
  checks.push({
    blocker: !passed,
    detail: passed ? passDetail : blockedDetail,
    name,
    status: passed ? "PASS" : "BLOCKED",
  });
}

export function inspectProductionEnvironment(environment = process.env) {
  const checks = [];
  const appMode = normalizedValue(environment, "APP_MODE");
  const runtimeMode = normalizedValue(environment, "BEA_RUNTIME_MODE");
  const nodeEnvironment = normalizedValue(environment, "NODE_ENV");
  const envFileDisabled = normalizedValue(environment, "BEA_DISABLE_ENV_FILE");
  const appBaseUrl = normalizedValue(environment, "APP_BASE_URL");
  const databaseDriver = normalizedValue(environment, "DATABASE_DRIVER");
  const databaseUrl = normalizedValue(environment, "DATABASE_URL");
  const demoAuthEnabled = normalizedValue(environment, "DEMO_AUTH_ENABLED");
  const queueAdapter = normalizedValue(environment, "WORKER_QUEUE_ADAPTER");
  const workerMode = normalizedValue(environment, "WORKER_MODE");
  const sessionSecret = normalizedValue(environment, "SESSION_SECRET");
  const authProvider = normalizedValue(environment, "BEA_AUTH_PROVIDER");
  const authReady = normalizedValue(environment, "BEA_AUTH_READY");
  const openAiReady = normalizedValue(environment, "BEA_OPENAI_SETUP_READY");
  const webPort = parsePort(normalizedValue(environment, "PORT"));
  const workerPort = parsePort(normalizedValue(environment, "WORKER_HEALTH_PORT"));
  const controlPort = parsePort(normalizedValue(environment, "BEA_PRODUCTION_CONTROL_PORT"));

  addEnvironmentCheck(
    checks,
    "Deployment mode",
    appMode === "production" && runtimeMode === "production",
    "APP_MODE and BEA_RUNTIME_MODE explicitly select production",
    "APP_MODE=production and BEA_RUNTIME_MODE=production are both required; Demo fallback is refused.",
  );
  addEnvironmentCheck(
    checks,
    "Node runtime mode",
    nodeEnvironment === "production",
    "NODE_ENV explicitly selects the optimized runtime",
    "NODE_ENV=production is required.",
  );
  addEnvironmentCheck(
    checks,
    "Environment-file isolation",
    exactTrue(envFileDisabled),
    "repository environment-file loading is disabled for the managed production launch",
    "BEA_DISABLE_ENV_FILE=true is required; the production launcher never reads .env.local.",
  );
  addEnvironmentCheck(
    checks,
    "HTTPS application origin",
    safeHttpsOrigin(appBaseUrl),
    "APP_BASE_URL is a credential-free HTTPS origin",
    "APP_BASE_URL must be a credential-free HTTPS origin without a path, query, or fragment.",
  );
  addEnvironmentCheck(
    checks,
    "PostgreSQL configuration",
    databaseDriver === "postgres" && /^postgres(?:ql)?:\/\//u.test(databaseUrl),
    "PostgreSQL is explicitly selected and a connection URL is present (value redacted)",
    "DATABASE_DRIVER=postgres and a PostgreSQL DATABASE_URL are required.",
  );
  addEnvironmentCheck(
    checks,
    "Queue configuration",
    queueAdapter === "pg-boss" && workerMode === "serve",
    "pg-boss and serve mode are explicitly selected",
    "WORKER_QUEUE_ADAPTER=pg-boss and WORKER_MODE=serve are required.",
  );
  addEnvironmentCheck(
    checks,
    "Production session",
    sessionSecret.length >= 32 && demoAuthEnabled.toLowerCase() === "false",
    "a production session secret is present (value redacted) and Demo authentication is disabled",
    "SESSION_SECRET must contain at least 32 characters and DEMO_AUTH_ENABLED=false is required.",
  );
  addEnvironmentCheck(
    checks,
    "Authentication readiness",
    authProvider === "microsoft-entra" && exactTrue(authReady),
    "Microsoft Entra authentication readiness is explicitly attested",
    "BEA_AUTH_PROVIDER=microsoft-entra and BEA_AUTH_READY=true are required.",
  );
  addEnvironmentCheck(
    checks,
    "OpenAI setup readiness",
    exactTrue(openAiReady),
    "OpenAI setup readiness is explicitly attested; no credential value was inspected or printed",
    "BEA_OPENAI_SETUP_READY=true is required after protected setup and authenticated connection testing.",
  );
  const portsValid =
    webPort !== undefined &&
    workerPort !== undefined &&
    controlPort !== undefined &&
    new Set([webPort, workerPort, controlPort]).size === 3;
  addEnvironmentCheck(
    checks,
    "Production ports",
    portsValid,
    `explicit distinct web, worker, and control ports are configured (${webPort}, ${workerPort}, ${controlPort})`,
    "PORT, WORKER_HEALTH_PORT, and BEA_PRODUCTION_CONTROL_PORT must be explicit, valid, and distinct.",
  );

  return {
    blockers: checks.filter((check) => check.blocker),
    checks,
    profile: portsValid
      ? {
          appBaseUrl,
          controlPort,
          webPort,
          workerPort,
        }
      : undefined,
  };
}

export function createProductionChildEnvironment(source = process.env) {
  const environment = {};
  for (const key of [...safeInheritedEnvironmentKeys, ...productionEnvironmentKeys]) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  return {
    ...environment,
    APP_MODE: "production",
    BEA_DISABLE_ENV_FILE: "true",
    BEA_RUNTIME_MODE: "production",
    DATABASE_DRIVER: "postgres",
    DEMO_AUTH_ENABLED: "false",
    NODE_ENV: "production",
    WORKER_MODE: "serve",
    WORKER_QUEUE_ADAPTER: "pg-boss",
  };
}

function pathEntries(environment = process.env) {
  const pathValue = environment.Path ?? environment.PATH ?? "";
  return pathValue
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/gu, ""))
    .filter(Boolean);
}

export function findExecutable(fileNames, options = {}) {
  const fileExists = options.fileExists ?? existsSync;
  for (const directory of pathEntries(options.environment)) {
    for (const fileName of fileNames) {
      const candidate = join(directory, fileName);
      if (fileExists(candidate)) return candidate;
    }
  }
  return undefined;
}

export function runExecutable(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    shell: false,
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
  return runExecutable(executable, executableArguments, options);
}

export async function checkPort(port) {
  return new Promise((resolveCheck) => {
    const server = createNetServer();
    const finish = (result) => {
      server.removeAllListeners();
      resolveCheck(result);
    };
    server.once("error", (error) => finish({ available: false, code: error.code ?? "UNKNOWN" }));
    server.listen({ exclusive: true, host: productionHost, port }, () => {
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

export function ensureProductionOwnerToolDirectories() {
  mkdirSync(productionOwnerToolPaths.logDirectory, { recursive: true });
}

export function createProductionLogPaths() {
  const runId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomBytes(4).toString("hex")}`;
  return {
    supervisor: join(productionOwnerToolPaths.logDirectory, `${runId}-supervisor.log`),
    web: join(productionOwnerToolPaths.logDirectory, `${runId}-web.log`),
    worker: join(productionOwnerToolPaths.logDirectory, `${runId}-worker.log`),
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

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decideNonOperationalProductionStop(tracked) {
  if (isRecord(tracked) && tracked.state === "stopped") {
    return Object.freeze({
      action: "none",
      exitCode: 0,
      marker: "BEA_PRODUCTION_STOP=ALREADY_STOPPED",
      message: "BEA production runtime is already stopped; no metadata is present.",
      outcome: "ALREADY_STOPPED",
      processAccessRequired: false,
    });
  }

  return Object.freeze({
    action: "block",
    exitCode: 1,
    marker: "BEA_PRODUCTION_STOP=BLOCKED",
    message:
      "The non-operational stop decision accepts only an explicitly stopped state; no process or metadata action was attempted.",
    outcome: "BLOCKED",
    processAccessRequired: false,
  });
}

export function validateProductionMetadata(value) {
  const issues = [];
  if (!isRecord(value)) return { issues: ["Metadata is not an object."] };
  if (value.version !== 1 || value.profile !== "production") {
    issues.push("Metadata profile or version is unsupported.");
  }
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
  if (value.controlHost !== productionHost || parsePort(String(value.controlPort)) === undefined) {
    issues.push("Metadata control endpoint is invalid.");
  }
  const webPort = parsePort(String(value.webPort));
  const workerPort = parsePort(String(value.workerPort));
  if (
    webPort === undefined ||
    workerPort === undefined ||
    new Set([webPort, workerPort, value.controlPort]).size !== 3
  ) {
    issues.push("Metadata service ports are invalid or overlap.");
  }
  if (typeof value.state !== "string") issues.push("Metadata state is invalid.");
  return issues.length > 0 ? { issues } : { issues: [], metadata: value };
}

export function readValidatedProductionMetadata() {
  if (!existsSync(productionOwnerToolPaths.metadataFile)) return { exists: false, issues: [] };
  try {
    const validation = validateProductionMetadata(readJson(productionOwnerToolPaths.metadataFile));
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

export function removeProductionMetadataOwnedBy(metadata) {
  const current = readValidatedProductionMetadata();
  if (
    current.metadata &&
    current.metadata.supervisorPid === metadata.supervisorPid &&
    current.metadata.controlToken === metadata.controlToken
  ) {
    rmSync(productionOwnerToolPaths.metadataFile, { force: true });
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

export async function productionControlRequest(metadata, path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMilliseconds ?? 2_000);
  try {
    const response = await fetch(
      `http://${metadata.controlHost}:${String(metadata.controlPort)}${path}`,
      {
        method: options.method ?? "GET",
        headers: { "x-bea-control-token": metadata.controlToken },
        signal: controller.signal,
        cache: "no-store",
      },
    );
    const body = await response.json().catch(() => undefined);
    return { body, ok: response.ok, status: response.status };
  } finally {
    clearTimeout(timeout);
  }
}

export async function inspectTrackedProduction() {
  const metadataResult = readValidatedProductionMetadata();
  if (!metadataResult.exists) return { state: "stopped" };
  if (!metadataResult.metadata) return { issues: metadataResult.issues, state: "invalid" };

  const metadata = metadataResult.metadata;
  if (!processIsAlive(metadata.supervisorPid)) return { metadata, state: "stale" };

  try {
    const response = await productionControlRequest(metadata, "/status");
    if (
      !response.ok ||
      !isRecord(response.body) ||
      response.body.supervisorPid !== metadata.supervisorPid ||
      response.body.profile !== "production"
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
  throw new Error(options.timeoutMessage ?? "Timed out waiting for a production owner operation.");
}

export function redactSensitiveText(value, environment = process.env) {
  let text = String(value);
  for (const key of sensitiveEnvironmentKeys) {
    const candidate = normalizedValue(environment, key);
    if (candidate) text = text.replaceAll(candidate, `[REDACTED_${key}]`);
  }
  return text;
}
