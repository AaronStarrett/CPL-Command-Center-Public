import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readProductionConfig } from "./production-config.mjs";
import { productionPaths, repositoryRoot } from "./production-paths.mjs";
const loopbackHost = "127.0.0.1";
const maxRestarts = 3;
const restartBaseDelayMs = 500;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validPort(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 65_535;
}

function contained(candidate, parent) {
  const relative = resolve(candidate).toLowerCase();
  const root = resolve(parent).toLowerCase();
  return relative === root || relative.startsWith(`${root}\\`) || relative.startsWith(`${root}/`);
}

export function validateSupervisorConfiguration(value) {
  const issues = [];
  if (!isRecord(value)) return { issues: ["Configuration is not an object."] };
  if (value.deploymentProfile !== "local-live") issues.push("Local Live profile is required.");
  if (value.hostname !== "bea.localhost") issues.push("HTTPS hostname must be bea.localhost.");
  const ports = value.ports;
  const portValues = isRecord(ports)
    ? [ports.web, ports.https, ports.workerHealth, ports.control, ports.setup]
    : [];
  if (portValues.length !== 5 || portValues.some((port) => !validPort(port))) {
    issues.push("Five valid production ports are required.");
  } else if (new Set(portValues).size !== portValues.length) {
    issues.push("Production ports must be distinct.");
  }
  if (
    value.appBaseUrl !==
    `https://${String(value.hostname)}:${String(isRecord(ports) ? ports.https : "")}`
  ) {
    issues.push("APP_BASE_URL does not match the configured HTTPS endpoint.");
  }
  if (value.database?.driver !== "postgres") issues.push("PostgreSQL is required.");
  if (value.queue?.adapter !== "pg-boss") issues.push("pg-boss is required.");
  if (value.worker?.mode !== "serve") issues.push("Worker serve mode is required.");
  if (value.authentication?.provider !== "local-owner") {
    issues.push("Local Owner authentication is required for Local Live.");
  }
  if (!isRecord(value.https) || typeof value.https.pfxPath !== "string") {
    issues.push("HTTPS PFX configuration is required.");
  }
  if (!isRecord(value.paths) || typeof value.paths.logDirectory !== "string") {
    issues.push("Production log directory is required.");
  }
  return issues.length === 0 ? { config: value, issues } : { issues };
}

export function commandFingerprint(executable, arguments_) {
  return createHash("sha256")
    .update(JSON.stringify([resolve(executable).toLowerCase(), ...arguments_]))
    .digest("hex");
}

function pidIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function acquireSupervisorLock(lockPath, options = {}) {
  const supervisorScript = fileURLToPath(import.meta.url);
  const fingerprint = commandFingerprint(process.execPath, [supervisorScript]);
  const evidence = {
    version: 1,
    kind: "supervisor",
    repositoryRoot,
    supervisorPid: process.pid,
    supervisorScript,
    supervisorFingerprint: fingerprint,
    createdAt: new Date().toISOString(),
  };
  const alive = options.processIsAlive ?? pidIsAlive;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify(evidence)}\n`, "utf8");
      return Object.freeze({
        evidence: Object.freeze(evidence),
        release() {
          closeSync(descriptor);
          rmSync(lockPath, { force: true });
        },
      });
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (error?.code !== "EEXIST" || attempt > 0) {
        throw new Error("The production single-instance lock could not be acquired.");
      }
      let existing;
      try {
        existing = JSON.parse(readFileSync(lockPath, "utf8"));
      } catch {
        throw new Error("The production single-instance lock is invalid and was preserved.");
      }
      const validSupervisor =
        existing.version === 1 &&
        (existing.kind === "supervisor" || existing.kind === undefined) &&
        resolve(existing.repositoryRoot ?? "").toLowerCase() === repositoryRoot.toLowerCase() &&
        resolve(existing.supervisorScript ?? "").toLowerCase() === supervisorScript.toLowerCase() &&
        existing.supervisorFingerprint === fingerprint &&
        Number.isSafeInteger(existing.supervisorPid) &&
        existing.supervisorPid > 0;
      const validMaintenance =
        existing.version === 1 &&
        existing.kind === "maintenance-restore" &&
        resolve(existing.repositoryRoot ?? "").toLowerCase() === repositoryRoot.toLowerCase() &&
        existing.operation === "restore" &&
        typeof existing.nonce === "string" &&
        existing.nonce.length >= 16 &&
        Number.isSafeInteger(existing.ownerPid) &&
        existing.ownerPid > 0;
      const ownerPid = validSupervisor ? existing.supervisorPid : existing.ownerPid;
      if ((!validSupervisor && !validMaintenance) || alive(ownerPid)) {
        throw new Error("An active or unverifiable production single-instance lock is present.");
      }
      rmSync(lockPath, { force: true });
    }
  }
  throw new Error("The production single-instance lock could not be acquired.");
}

export function nextRestartDelay(restartCount) {
  if (!Number.isSafeInteger(restartCount) || restartCount < 0 || restartCount >= maxRestarts) {
    return undefined;
  }
  return restartBaseDelayMs * 2 ** restartCount;
}

function constantTimeToken(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return leftHash.equals(rightHash);
}

function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "w",
    mode: 0o600,
  });
  renameSync(temporary, path);
}

export function publicMetadata(input) {
  return {
    version: 2,
    profile: "local-live",
    repositoryRoot,
    supervisorPid: input.supervisorPid,
    supervisorExecutable: input.supervisorExecutable,
    supervisorScript: input.supervisorScript,
    supervisorFingerprint: input.supervisorFingerprint,
    controlHost: loopbackHost,
    controlPort: input.controlPort,
    ports: input.ports,
    children: input.children,
    state: input.state,
    startedAt: input.startedAt,
    updatedAt: input.updatedAt,
  };
}

function rotateLog(path, maximumBytes = 10 * 1024 * 1024, keep = 5) {
  if (!existsSync(path) || statSync(path).size < maximumBytes) return;
  rmSync(`${path}.${String(keep)}`, { force: true });
  for (let index = keep - 1; index >= 1; index -= 1) {
    const source = `${path}.${String(index)}`;
    if (existsSync(source)) renameSync(source, `${path}.${String(index + 1)}`);
  }
  renameSync(path, `${path}.1`);
}

function log(event, fields = {}) {
  process.stdout.write(
    `${JSON.stringify({ at: new Date().toISOString(), event, service: "bea-production-supervisor", ...fields })}\n`,
  );
}

function readConfiguration(path) {
  const result = validateSupervisorConfiguration(
    readProductionConfig({ filePath: path, productRoot: productionPaths.productRoot }),
  );
  if (!result.config)
    throw new Error(`Production configuration is invalid: ${result.issues.join(" ")}`);
  return result.config;
}

function requiredSecret(name, environment = process.env) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Protected secret ${name} is unavailable.`);
  return value;
}

function writeJsonResponse(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  return fetch(url, { cache: "no-store", signal: controller.signal }).finally(() =>
    clearTimeout(timeout),
  );
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  }
  throw new Error(`${label} did not become ready.${lastError ? ` (${lastError.name})` : ""}`);
}

export async function runProductionSupervisor(environment = process.env) {
  const configPath = environment.BEA_PRODUCTION_CONFIG_PATH;
  const metadataPath = environment.BEA_PRODUCTION_METADATA_PATH;
  if (!configPath || !metadataPath) throw new Error("Production runtime paths are unavailable.");
  if (
    resolve(configPath).toLowerCase() !== productionPaths.configFile.toLowerCase() ||
    resolve(metadataPath).toLowerCase() !== productionPaths.runtimeMetadataFile.toLowerCase()
  ) {
    throw new Error("Production runtime paths do not match the protected Local Live contract.");
  }
  const config = readConfiguration(configPath);
  if (!contained(metadataPath, dirname(metadataPath))) throw new Error("Metadata path is invalid.");
  const lockPath = environment.BEA_PRODUCTION_LOCK_PATH ?? `${metadataPath}.lock`;
  if (
    !contained(lockPath, dirname(metadataPath)) ||
    resolve(lockPath).toLowerCase() !== productionPaths.runtimeLockFile.toLowerCase()
  ) {
    throw new Error("Lock path is invalid.");
  }
  const instanceLock = acquireSupervisorLock(lockPath);
  try {
    const controlToken = requiredSecret("BEA_PRODUCTION_CONTROL_TOKEN", environment);
    const databaseUrl = requiredSecret("DATABASE_URL", environment);
    const sessionSecret = requiredSecret("SESSION_SECRET", environment);
    const pfxPassword = requiredSecret("BEA_HTTPS_PFX_PASSWORD", environment);
    const logDirectory = config.paths.logDirectory;
    mkdirSync(logDirectory, { recursive: true });
    const logPaths = Object.fromEntries(
      ["web", "worker", "gateway"].map((name) => [name, join(logDirectory, `${name}.log`)]),
    );
    for (const path of Object.values(logPaths)) rotateLog(path);

    const requireFromWeb = createRequire(join(repositoryRoot, "apps", "web", "package.json"));
    const nextPackage = requireFromWeb.resolve("next/package.json");
    const nextCli = join(dirname(nextPackage), "dist", "bin", "next");
    const workerEntry = join(repositoryRoot, "apps", "worker", "dist", "index.js");
    const gatewayEntry = join(repositoryRoot, "scripts", "phase134", "https-gateway.mjs");
    const baseChildEnvironment = {
      APP_BASE_URL: config.appBaseUrl,
      APP_MODE: "production",
      BEA_AUTH_PROVIDER: "local-owner",
      BEA_DEPLOYMENT_PROFILE: "local-live",
      BEA_DISABLE_ENV_FILE: "true",
      BEA_PRODUCTION_CONFIG_PATH: configPath,
      BEA_PRODUCTION_SECRET_PATH: environment.BEA_PRODUCTION_SECRET_PATH,
      BEA_RUNTIME_MODE: "production",
      DATABASE_DRIVER: "postgres",
      DATABASE_URL: databaseUrl,
      DEMO_AUTH_ENABLED: "false",
      LOCALAPPDATA: environment.LOCALAPPDATA,
      LOG_LEVEL: environment.LOG_LEVEL ?? "info",
      NODE_ENV: "production",
      NODE_USE_SYSTEM_CA: "1",
      PATH: environment.PATH,
      Path: environment.Path,
      SESSION_SECRET: sessionSecret,
      SESSION_TTL_MINUTES: String(config.authentication.sessionTtlMinutes ?? 30),
      SystemRoot: environment.SystemRoot,
      TEMP: environment.TEMP,
      TMP: environment.TMP,
      USERPROFILE: environment.USERPROFILE,
      WINDIR: environment.WINDIR,
      WORKER_HEALTH_PORT: String(config.ports.workerHealth),
      WORKER_MODE: "serve",
      WORKER_POLL_INTERVAL_MS: String(config.worker.pollIntervalMs ?? 60_000),
      WORKER_QUEUE_ADAPTER: "pg-boss",
    };

    let controlServer;
    let shuttingDown;
    let resolveLifetime;
    const lifetime = new Promise((resolveDone) => {
      resolveLifetime = resolveDone;
    });
    const startedAt = new Date().toISOString();
    const children = new Map();
    const definitions = new Map([
      [
        "web",
        {
          arguments: [
            nextCli,
            "start",
            "--hostname",
            loopbackHost,
            "--port",
            String(config.ports.web),
          ],
          cwd: join(repositoryRoot, "apps", "web"),
          environment: { ...baseChildEnvironment, PORT: String(config.ports.web) },
        },
      ],
      [
        "worker",
        {
          arguments: [workerEntry, "--serve"],
          cwd: repositoryRoot,
          environment: baseChildEnvironment,
        },
      ],
      [
        "gateway",
        {
          arguments: [gatewayEntry],
          cwd: repositoryRoot,
          environment: {
            ...baseChildEnvironment,
            BEA_HTTPS_HOSTNAME: config.hostname,
            BEA_HTTPS_PFX_PASSWORD: pfxPassword,
            BEA_HTTPS_PFX_PATH: config.https.pfxPath,
            BEA_HTTPS_PORT: String(config.ports.https),
            PORT: String(config.ports.web),
          },
        },
      ],
    ]);

    const snapshotChildren = () =>
      Object.fromEntries(
        [...children.entries()].map(([name, entry]) => [
          name,
          {
            commandFingerprint: entry.commandFingerprint,
            exitCode: entry.child.exitCode,
            pid: entry.child.pid,
            restartCount: entry.restartCount,
            signalCode: entry.child.signalCode,
            startedAt: entry.startedAt,
          },
        ]),
      );
    let state = "starting";
    const updateMetadata = () =>
      writeJsonAtomic(
        metadataPath,
        publicMetadata({
          supervisorPid: process.pid,
          supervisorExecutable: process.execPath,
          supervisorScript: fileURLToPath(import.meta.url),
          supervisorFingerprint: commandFingerprint(process.execPath, [
            fileURLToPath(import.meta.url),
          ]),
          controlPort: config.ports.control,
          ports: config.ports,
          children: snapshotChildren(),
          state,
          startedAt,
          updatedAt: new Date().toISOString(),
        }),
      );

    const startChild = (name, restartCount = 0) => {
      const definition = definitions.get(name);
      const descriptor = openSync(logPaths[name], "a", 0o600);
      let child;
      try {
        child = spawn(process.execPath, definition.arguments, {
          cwd: definition.cwd,
          env: definition.environment,
          stdio: ["ignore", descriptor, descriptor],
          windowsHide: true,
        });
      } finally {
        closeSync(descriptor);
      }
      if (!child.pid) throw new Error(`${name} did not return a PID.`);
      const entry = {
        child,
        commandFingerprint: commandFingerprint(process.execPath, definition.arguments),
        restartCount,
        startedAt: new Date().toISOString(),
      };
      children.set(name, entry);
      child.once("exit", () => {
        if (shuttingDown) return;
        const delay = nextRestartDelay(entry.restartCount);
        if (delay === undefined) {
          state = "failed";
          updateMetadata();
          void beginShutdown(`${name}-restart-limit`, 1);
          return;
        }
        state = "degraded";
        updateMetadata();
        log("child.restart-scheduled", {
          child: name,
          delayMs: delay,
          restartCount: entry.restartCount + 1,
        });
        setTimeout(() => {
          if (!shuttingDown) {
            startChild(name, entry.restartCount + 1);
            updateMetadata();
          }
        }, delay).unref();
      });
      return entry;
    };

    const waitChildExit = (child, timeoutMs) =>
      new Promise((resolveExit) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolveExit(true);
        const timeout = setTimeout(() => {
          child.off("exit", onExit);
          resolveExit(false);
        }, timeoutMs);
        const onExit = () => {
          clearTimeout(timeout);
          resolveExit(true);
        };
        child.once("exit", onExit);
      });
    const terminateChild = async (name, entry) => {
      if (entry.child.exitCode !== null || entry.child.signalCode !== null) return;
      entry.child.kill("SIGTERM");
      if (await waitChildExit(entry.child, 15_000)) return;
      log("child.force-stop", { child: name, pid: entry.child.pid });
      entry.child.kill("SIGKILL");
      if (!(await waitChildExit(entry.child, 5_000))) throw new Error(`${name} did not stop.`);
    };
    const closeControl = () =>
      new Promise((resolveClose) => {
        if (!controlServer?.listening) return resolveClose();
        controlServer.close(() => resolveClose());
        controlServer.closeIdleConnections?.();
        setTimeout(() => {
          controlServer.closeAllConnections?.();
          resolveClose();
        }, 2_000).unref();
      });
    const beginShutdown = (reason, exitCode = 0) => {
      if (shuttingDown) return shuttingDown;
      shuttingDown = (async () => {
        state = "stopping";
        updateMetadata();
        log("supervisor.stopping", { reason });
        const failures = [];
        for (const [name, entry] of [...children.entries()].reverse()) {
          try {
            await terminateChild(name, entry);
          } catch (error) {
            failures.push(error);
          }
        }
        await closeControl();
        rmSync(metadataPath, { force: true });
        if (failures.length > 0 || exitCode !== 0) process.exitCode = 1;
        resolveLifetime();
      })();
      return shuttingDown;
    };

    controlServer = createServer((request, response) => {
      if (!constantTimeToken(request.headers["x-bea-control-token"], controlToken)) {
        writeJsonResponse(response, 401, { code: "BEA_CONTROL_UNAUTHORIZED", ok: false });
        return;
      }
      if (request.method === "GET" && request.url === "/status") {
        writeJsonResponse(response, 200, {
          children: snapshotChildren(),
          ok: true,
          profile: "local-live",
          state,
          supervisorPid: process.pid,
        });
        return;
      }
      if (request.method === "POST" && request.url === "/stop") {
        writeJsonResponse(response, 202, { code: "BEA_STOP_ACCEPTED", ok: true });
        setImmediate(() => void beginShutdown("authenticated-control-request"));
        return;
      }
      writeJsonResponse(response, 404, { code: "NOT_FOUND", ok: false });
    });
    controlServer.requestTimeout = 5_000;
    controlServer.headersTimeout = 5_000;
    await new Promise((resolveListen, rejectListen) => {
      controlServer.once("error", rejectListen);
      controlServer.listen(
        { host: loopbackHost, port: config.ports.control, exclusive: true },
        () => {
          controlServer.off("error", rejectListen);
          resolveListen();
        },
      );
    });

    for (const name of definitions.keys()) startChild(name);
    updateMetadata();
    await Promise.all([
      waitFor(
        async () => {
          const response = await fetchWithTimeout(
            `http://${loopbackHost}:${String(config.ports.workerHealth)}/health`,
          );
          return response.ok && (await response.json()).status === "healthy";
        },
        180_000,
        "Worker",
      ),
      waitFor(
        async () => {
          const response = await fetchWithTimeout(
            `http://${loopbackHost}:${String(config.ports.web)}/sign-in`,
          );
          return response.ok;
        },
        180_000,
        "Web",
      ),
      waitFor(
        async () => {
          const response = await fetchWithTimeout(`${config.appBaseUrl}/__bea_gateway_health`);
          return response.ok && (await response.json()).service === "bea-https-gateway";
        },
        180_000,
        "HTTPS gateway",
      ),
    ]).catch(async (error) => {
      state = "failed";
      updateMetadata();
      await beginShutdown("readiness-failed", 1);
      throw error;
    });
    state = "ready";
    updateMetadata();
    log("supervisor.ready", { appBaseUrl: config.appBaseUrl });

    process.once("SIGINT", () => void beginShutdown("SIGINT"));
    process.once("SIGTERM", () => void beginShutdown("SIGTERM"));
    process.once("SIGHUP", () => void beginShutdown("SIGHUP"));
    await lifetime;
    await shuttingDown;
  } finally {
    instanceLock.release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runProductionSupervisor().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({ code: "BEA_PRODUCTION_SUPERVISOR_FAILED", errorName: error instanceof Error ? error.name : "UnknownError" })}\n`,
    );
    process.exitCode = 1;
  });
}
