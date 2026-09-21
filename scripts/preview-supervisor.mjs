import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertPreviewBoundary,
  assertOwnerEvaluationPathContract,
  assertPreviewPathContract,
  createOwnerEvaluationChildEnvironment,
  createPreviewChildEnvironment,
  inspectProcessIdentity,
  isPathWithin,
  launchFingerprint,
  ownerEvaluationPaths,
  ownerEvaluationPorts,
  ownerEvaluationSignInUrl,
  ownerEvaluationWorkerHealthUrl,
  pathsEqual,
  previewHost,
  previewPaths,
  previewPorts,
  previewSignInUrl,
  previewWorkerHealthUrl,
  processIdentityMatches,
  processIsAlive,
  readPreviewMetadata,
  removeMetadataOwnedBy,
  repositoryRoot,
  requireCanonicalToolchain,
  tokensMatch,
  waitFor,
  writeMetadataOwnedBy,
} from "./preview-common.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const webRoot = join(repositoryRoot, "apps", "web");
const nextLauncherScript = join(repositoryRoot, "scripts", "next-no-env.mjs");
const networkGuardScript = join(repositoryRoot, "scripts", "preview-network-guard.cjs");
const workerScript = join(repositoryRoot, "apps", "worker", "src", "index.ts");
const isolated = process.env.BEA_OWNER_EVALUATION === "true";
const isolatedPorts = isolated ? ownerEvaluationPorts : previewPorts;
const isolatedPaths = isolated ? ownerEvaluationPaths : previewPaths;
const isolatedSignInUrl = isolated ? ownerEvaluationSignInUrl : previewSignInUrl;
const isolatedWorkerHealthUrl = isolated ? ownerEvaluationWorkerHealthUrl : previewWorkerHealthUrl;
const webHealthUrl = `http://${previewHost}:${String(isolatedPorts.web)}/api/health`;

let metadata;
let controlServer;
let webChild;
let workerChild;
let startupPromise;
let shutdownPromise;
let resolveLifetime;
const lifetime = new Promise((resolveDone) => {
  resolveLifetime = resolveDone;
});
const pendingChildOwnership = Symbol("preview-pending-child-ownership");

function log(message) {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

export function validatePreviewSupervisorEnvironment(environment = process.env) {
  const issues = [];
  const ownerEvaluation = environment.BEA_OWNER_EVALUATION === "true";
  const exact = ownerEvaluation
    ? {
        APP_BASE_URL: `http://${previewHost}:${String(ownerEvaluationPorts.web)}`,
        APP_MODE: "demo",
        BEA_ARTIFACT_STORE_PATH: ".data/bea-owner-evaluation/artifacts",
        BEA_AUTH_PROVIDER: "demo",
        BEA_DEPLOYMENT_PROFILE: "owner-evaluation",
        BEA_DISABLE_ENV_FILE: "true",
        BEA_OWNER_EVALUATION: "true",
        BEA_OWNER_EVALUATION_AUTHORITY: "Start-BEA-Owner-Acceptance.cmd",
        BEA_OWNER_EVALUATION_NETWORK_GUARD: "loopback-only",
        BEA_PREVIEW_AUTHORITY: "",
        BEA_PREVIEW_MODE: "",
        BEA_PREVIEW_NETWORK_GUARD: "loopback-only",
        BEA_PRODUCTION_SECRET_PATH: "",
        BEA_RUNTIME_MODE: "development",
        DATABASE_DRIVER: "pglite",
        DATABASE_URL: "",
        DEMO_AUTH_ENABLED: "true",
        DEMO_DATABASE_PATH: ".data/bea-owner-evaluation/pglite",
        NODE_ENV: "development",
        OPENAI_API_KEY: "",
        PORT: String(ownerEvaluationPorts.web),
        WORKER_DEMO_DATABASE_PATH: "memory://",
        WORKER_HEALTH_PORT: String(ownerEvaluationPorts.workerHealth),
        WORKER_MODE: "serve",
        WORKER_QUEUE_ADAPTER: "inline",
      }
    : {
        APP_BASE_URL: `http://${previewHost}:${String(previewPorts.web)}`,
        APP_MODE: "demo",
        BEA_ARTIFACT_STORE_PATH: ".data/bea-preview/artifacts",
        BEA_AUTH_PROVIDER: "demo",
        BEA_DEPLOYMENT_PROFILE: "demo",
        BEA_DISABLE_ENV_FILE: "true",
        BEA_PREVIEW_AUTHORITY: "Start-BEA-Preview.cmd",
        BEA_PREVIEW_MODE: "true",
        BEA_PREVIEW_NETWORK_GUARD: "loopback-only",
        BEA_PRODUCTION_SECRET_PATH: "",
        BEA_RUNTIME_MODE: "development",
        DATABASE_DRIVER: "pglite",
        DATABASE_URL: "",
        DEMO_AUTH_ENABLED: "true",
        DEMO_DATABASE_PATH: ".data/bea-preview/pglite",
        NODE_ENV: "development",
        OPENAI_API_KEY: "",
        PORT: String(previewPorts.web),
        SESSION_SECRET: "",
        WORKER_DEMO_DATABASE_PATH: "memory://",
        WORKER_HEALTH_PORT: String(previewPorts.workerHealth),
        WORKER_MODE: "serve",
        WORKER_QUEUE_ADAPTER: "inline",
      };
  for (const [key, value] of Object.entries(exact)) {
    if (environment[key] !== value)
      issues.push(
        `${key} does not match the exact ${ownerEvaluation ? "Owner Evaluation" : "Preview"} contract.`,
      );
  }
  if (ownerEvaluation && (environment.SESSION_SECRET ?? "").length < 64) {
    issues.push("Owner Evaluation SESSION_SECRET must be at least 64 characters.");
  }
  if (!/^[a-f0-9]{32}$/u.test(environment.BEA_PREVIEW_INSTANCE_ID ?? "")) {
    issues.push("BEA_PREVIEW_INSTANCE_ID is invalid.");
  }
  if (!/^[a-f0-9]{64}$/u.test(environment.BEA_PREVIEW_CONTROL_TOKEN ?? "")) {
    issues.push("BEA_PREVIEW_CONTROL_TOKEN is invalid.");
  }
  const logDirectory = ownerEvaluation
    ? ownerEvaluationPaths.logDirectory
    : previewPaths.logDirectory;
  for (const [key, expectedDirectory] of [
    ["BEA_PREVIEW_WEB_LOG", logDirectory],
    ["BEA_PREVIEW_WORKER_LOG", logDirectory],
  ]) {
    const value = environment[key];
    if (typeof value !== "string" || !isPathWithin(resolve(value), expectedDirectory)) {
      issues.push(`${key} must remain inside the isolated log directory.`);
    }
  }
  return Object.freeze({ issues });
}

function updateMetadata(patch, dependencies = {}) {
  const next = {
    ...metadata,
    ...patch,
    updatedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
  };
  if (
    !(dependencies.writeMetadata ?? writeMetadataOwnedBy)(metadata, next, {
      path: isolatedPaths.metadataFile,
    })
  ) {
    throw new Error("Preview metadata ownership changed; supervisor update was refused.");
  }
  metadata = next;
  return metadata;
}

function writeJsonResponse(response, status, body) {
  const serialized = JSON.stringify(body);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(serialized),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(serialized);
}

export function createAuthenticatedStatus(metadataValue) {
  return Object.freeze({
    children: metadataValue.children,
    instanceId: metadataValue.instanceId,
    ok: true,
    ports: metadataValue.ports,
    profile: isolated ? "owner-evaluation" : "preview",
    signInUrl: isolatedSignInUrl,
    state: metadataValue.state,
    supervisorCommandLineFingerprint: metadataValue.supervisorOsIdentity.commandLineFingerprint,
    supervisorOsStartedAt: metadataValue.supervisorOsIdentity.osStartedAt,
    supervisorPid: metadataValue.supervisorOsIdentity.pid,
    workerHealthUrl: isolatedWorkerHealthUrl,
  });
}

function authenticated(request) {
  return tokensMatch(
    request.headers["x-bea-preview-control-token"],
    process.env.BEA_PREVIEW_CONTROL_TOKEN,
  );
}

function createControlServer() {
  const server = createServer((request, response) => {
    if (!authenticated(request)) {
      writeJsonResponse(response, 401, { code: "BEA_PREVIEW_CONTROL_UNAUTHORIZED", ok: false });
      return;
    }
    if (request.method === "GET" && request.url === "/status") {
      writeJsonResponse(response, 200, createAuthenticatedStatus(metadata));
      return;
    }
    if (request.method === "POST" && request.url === "/stop") {
      writeJsonResponse(response, 202, {
        code: "BEA_PREVIEW_STOP_ACCEPTED",
        ...createAuthenticatedStatus(metadata),
      });
      setImmediate(() => void beginShutdown("authenticated-control-request"));
      return;
    }
    writeJsonResponse(response, 404, { code: "BEA_PREVIEW_CONTROL_NOT_FOUND", ok: false });
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  return server;
}

async function listenForControl(dependencies = {}) {
  controlServer = (dependencies.createControlServer ?? createControlServer)();
  await new Promise((resolveListen, rejectListen) => {
    controlServer.once("error", rejectListen);
    controlServer.listen(isolatedPorts.control, previewHost, () => {
      controlServer.off("error", rejectListen);
      resolveListen();
    });
  });
}

function closeControlServer() {
  if (!controlServer) return Promise.resolve();
  return new Promise((resolveClose) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      resolveClose();
    };
    controlServer.close(finish);
    controlServer.closeIdleConnections?.();
    setTimeout(() => {
      controlServer.closeAllConnections?.();
      finish();
    }, 2_000).unref();
  });
}

function waitForChildExit(child, timeoutMilliseconds) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const onExit = () => {
      clearTimeout(timeout);
      resolveExit(true);
    };
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolveExit(false);
    }, timeoutMilliseconds);
    child.once("exit", onExit);
  });
}

export async function terminateExactPreviewChild(tracked, dependencies = {}) {
  if (
    !tracked?.process ||
    tracked.process.exitCode !== null ||
    tracked.process.signalCode !== null
  ) {
    return;
  }
  const inspect = dependencies.inspectProcessIdentity ?? inspectProcessIdentity;
  let expectedIdentity = tracked.osIdentity;
  if (!tracked.osIdentity) {
    if (
      tracked[pendingChildOwnership] !== true ||
      tracked.process.pid !== tracked.pid ||
      !Number.isSafeInteger(tracked.pid) ||
      launchFingerprint(tracked.executable, tracked.arguments, tracked.cwd) !==
        tracked.launchFingerprint
    ) {
      throw new Error(
        `Tracked Preview ${tracked.name ?? "child"} has no exact captured or pending ownership; no kill was sent.`,
      );
    }
    try {
      expectedIdentity = await inspect(tracked.pid);
    } catch {
      throw new Error(
        `Tracked Preview ${tracked.name} pending OS identity could not be captured; no kill was sent.`,
      );
    }
    if (!expectedIdentity || !pathsEqual(expectedIdentity.executablePath, tracked.executable)) {
      throw new Error(
        `Tracked Preview ${tracked.name} pending executable identity is invalid; no kill was sent.`,
      );
    }
  }
  const current = await inspect(expectedIdentity.pid);
  if (!current || !processIdentityMatches(expectedIdentity, current)) {
    throw new Error(
      `Tracked Preview ${tracked.name} process identity no longer matches; no kill was sent.`,
    );
  }
  tracked.process.kill("SIGTERM");
  if (await (dependencies.waitForChildExit ?? waitForChildExit)(tracked.process, 15_000)) return;
  const beforeEscalation = await inspect(expectedIdentity.pid);
  if (!beforeEscalation || !processIdentityMatches(expectedIdentity, beforeEscalation)) {
    throw new Error(
      `Tracked Preview ${tracked.name} identity changed before escalation; no kill was sent.`,
    );
  }
  tracked.process.kill("SIGKILL");
  if (!(await (dependencies.waitForChildExit ?? waitForChildExit)(tracked.process, 5_000))) {
    throw new Error(`Tracked Preview ${tracked.name} process did not stop.`);
  }
}

function pendingChildRecord(name, child, executable, script, arguments_, cwd) {
  return Object.freeze({
    arguments: Object.freeze([...arguments_]),
    cwd,
    executable,
    launchFingerprint: launchFingerprint(executable, arguments_, cwd),
    name,
    [pendingChildOwnership]: true,
    pid: child.pid,
    process: child,
    script,
  });
}

function observedChildRecord(pending, osIdentity) {
  return Object.freeze({ ...pending, osIdentity });
}

async function observeChildIdentity(child, dependencies = {}) {
  return (dependencies.waitFor ?? waitFor)(
    async () => {
      if (!(dependencies.processIsAlive ?? processIsAlive)(child.pid))
        throw new Error("Preview child exited before identity capture.");
      return (dependencies.inspectProcessIdentity ?? inspectProcessIdentity)(child.pid);
    },
    {
      intervalMilliseconds: 100,
      timeoutMessage: "Preview child OS identity was not observable.",
      timeoutMilliseconds: 5_000,
    },
  );
}

function spawnLoggedNode(executable, arguments_, options, dependencies = {}) {
  const descriptor = (dependencies.openLog ?? openSync)(options.logPath, "a", 0o600);
  try {
    return (dependencies.spawn ?? spawn)(executable, arguments_, {
      cwd: options.cwd,
      env: options.environment,
      stdio: ["ignore", descriptor, descriptor],
      windowsHide: true,
    });
  } finally {
    (dependencies.closeLog ?? closeSync)(descriptor);
  }
}

function watchUnexpectedChildExit(tracked) {
  tracked.process.once("exit", (code, signal) => {
    if (!shutdownPromise) {
      try {
        updateMetadata({ state: "failed" });
      } catch {
        // Ownership failure is reported by the shutdown path and never authorizes a broad kill.
      }
      log(
        `Tracked ${tracked.name} exited unexpectedly (code=${String(code)}, signal=${String(signal)}).`,
      );
      void beginShutdown(`${tracked.name}-exited`, 1);
    }
  });
}

async function startChildren(toolchain, dependencies = {}) {
  const childEnvironment = isolated
    ? createOwnerEvaluationChildEnvironment(process.env)
    : createPreviewChildEnvironment(process.env);
  const workerArguments = [
    "--require",
    networkGuardScript,
    "--import=tsx",
    workerScript,
    "--serve",
  ];
  const webArguments = [
    "--require",
    networkGuardScript,
    nextLauncherScript,
    "dev",
    "--webpack",
    "--hostname",
    previewHost,
    "--port",
    String(isolatedPorts.web),
  ];
  const workerProcess = spawnLoggedNode(
    toolchain.nodeExecutable,
    workerArguments,
    {
      cwd: repositoryRoot,
      environment: childEnvironment,
      logPath: process.env.BEA_PREVIEW_WORKER_LOG,
    },
    dependencies,
  );
  workerChild = pendingChildRecord(
    "worker",
    workerProcess,
    toolchain.nodeExecutable,
    workerScript,
    workerArguments,
    repositoryRoot,
  );
  watchUnexpectedChildExit(workerChild);
  const workerIdentity = await observeChildIdentity(workerProcess, dependencies);
  if (!pathsEqual(workerIdentity.executablePath, toolchain.nodeExecutable)) {
    throw new Error("Preview worker did not start with canonical BEA Node.");
  }
  workerChild = observedChildRecord(workerChild, workerIdentity);

  const webProcess = spawnLoggedNode(
    toolchain.nodeExecutable,
    webArguments,
    {
      cwd: webRoot,
      environment: childEnvironment,
      logPath: process.env.BEA_PREVIEW_WEB_LOG,
    },
    dependencies,
  );
  webChild = pendingChildRecord(
    "web",
    webProcess,
    toolchain.nodeExecutable,
    nextLauncherScript,
    webArguments,
    webRoot,
  );
  watchUnexpectedChildExit(webChild);
  const webIdentity = await observeChildIdentity(webProcess, dependencies);
  if (!pathsEqual(webIdentity.executablePath, toolchain.nodeExecutable)) {
    throw new Error("Preview web did not start with canonical BEA Node.");
  }
  webChild = observedChildRecord(webChild, webIdentity);

  updateMetadata({
    children: {
      web: {
        launchFingerprint: webChild.launchFingerprint,
        osIdentity: webChild.osIdentity,
        script: webChild.script,
      },
      worker: {
        launchFingerprint: workerChild.launchFingerprint,
        osIdentity: workerChild.osIdentity,
        script: workerChild.script,
      },
    },
    state: "starting",
  });
}

async function fetchWithTimeout(url, dependencies = {}, timeoutMilliseconds = 5_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
  try {
    return await (dependencies.fetch ?? fetch)(url, {
      cache: "no-store",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForReady(dependencies = {}) {
  await Promise.all([
    (dependencies.waitFor ?? waitFor)(
      async () => {
        if (!processIsAlive(workerChild?.osIdentity?.pid)) {
          throw new Error("Tracked Preview worker exited before readiness.");
        }
        const response = await fetchWithTimeout(isolatedWorkerHealthUrl, dependencies);
        if (response.status !== 200) return false;
        const body = await response.json();
        return body?.service === "bea-worker" && body?.status === "healthy";
      },
      { intervalMilliseconds: 300, timeoutMilliseconds: 180_000 },
    ),
    (dependencies.waitFor ?? waitFor)(
      async () => {
        if (!processIsAlive(webChild?.osIdentity?.pid)) {
          throw new Error("Tracked Preview web exited before readiness.");
        }
        const [health, signIn] = await Promise.all([
          fetchWithTimeout(webHealthUrl, dependencies),
          fetchWithTimeout(isolatedSignInUrl, dependencies),
        ]);
        return health.status === 200 && signIn.status === 200;
      },
      { intervalMilliseconds: 300, timeoutMilliseconds: 180_000 },
    ),
  ]);
}

async function waitForLaunchMetadata(dependencies = {}) {
  const ownIdentity = await (dependencies.inspectProcessIdentity ?? inspectProcessIdentity)(
    process.pid,
  );
  if (!ownIdentity) throw new Error("Preview supervisor OS identity could not be established.");
  return (dependencies.waitFor ?? waitFor)(
    () => {
      const result = (dependencies.readMetadata ?? readPreviewMetadata)({
        path: isolatedPaths.metadataFile,
      });
      if (
        result.metadata?.instanceId === process.env.BEA_PREVIEW_INSTANCE_ID &&
        tokensMatch(result.metadata.controlToken, process.env.BEA_PREVIEW_CONTROL_TOKEN) &&
        processIdentityMatches(result.metadata.supervisorOsIdentity, ownIdentity)
      ) {
        return result.metadata;
      }
      return false;
    },
    {
      intervalMilliseconds: 50,
      timeoutMessage: "Preview supervisor did not receive exact launcher metadata.",
      timeoutMilliseconds: 5_000,
    },
  );
}

function beginShutdown(reason, exitCode = 0, dependencies = {}) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    log(`Preview supervisor shutdown requested (${reason}).`);
    try {
      await closeControlServer();
      if (startupPromise) {
        try {
          await startupPromise;
        } catch {
          // Startup failure still leaves exact spawned child handles eligible for cleanup below.
        }
      }
      updateMetadata({ state: "stopping" }, dependencies);
      await Promise.all([
        terminateExactPreviewChild(webChild, dependencies),
        terminateExactPreviewChild(workerChild, dependencies),
      ]);
      if (!(dependencies.removeMetadata ?? removeMetadataOwnedBy)(metadata)) {
        throw new Error("Preview metadata ownership changed; active evidence was preserved.");
      }
      log("Preview supervisor stopped its exact tracked children and removed owned metadata.");
    } catch (error) {
      process.stderr.write(
        `${new Date().toISOString()} Preview cleanup failed (${error instanceof Error ? error.message : "UnknownError"}).\n`,
      );
      process.exitCode = 1;
    } finally {
      if (exitCode !== 0) process.exitCode = exitCode;
      resolveLifetime?.();
    }
  })();
  return shutdownPromise;
}

export async function runPreviewSupervisor(dependencies = {}) {
  (dependencies.assertBoundary ?? assertPreviewBoundary)();
  if ((dependencies.platform ?? process.platform) !== "win32") {
    throw new Error("The isolated Preview supervisor supports Windows only.");
  }
  (
    dependencies.assertPaths ??
    (isolated ? assertOwnerEvaluationPathContract : assertPreviewPathContract)
  )(isolatedPaths);
  const toolchain = (dependencies.requireToolchain ?? requireCanonicalToolchain)({
    requirePnpm: false,
  });
  if (!pathsEqual(toolchain.nodeExecutable, process.execPath)) {
    throw new Error("Preview supervisor is not running under canonical BEA Node.");
  }
  if (!pathsEqual(scriptPath, join(repositoryRoot, "scripts", "preview-supervisor.mjs"))) {
    throw new Error("Preview supervisor script path validation failed.");
  }
  const environment = validatePreviewSupervisorEnvironment(process.env);
  if (environment.issues.length > 0) throw new Error(environment.issues.join(" "));

  metadata = await waitForLaunchMetadata(dependencies);
  if (shutdownPromise) {
    await shutdownPromise;
    return;
  }
  startupPromise = (async () => {
    await startChildren(toolchain, dependencies);
    if (!shutdownPromise) await listenForControl(dependencies);
  })();
  try {
    await startupPromise;
  } catch (error) {
    await beginShutdown("startup-failed", 1, dependencies);
    throw error;
  }
  try {
    if (!shutdownPromise) await waitForReady(dependencies);
    if (!shutdownPromise) {
      updateMetadata({ state: "ready" }, dependencies);
      log(
        isolated
          ? `BEA Owner Evaluation ready at ${isolatedSignInUrl}.`
          : `BEA Preview ready at ${isolatedSignInUrl}.`,
      );
    }
  } catch {
    if (!shutdownPromise) {
      try {
        updateMetadata({ state: "failed" }, dependencies);
      } catch {
        // Preserve the original ownership/readiness failure for fail-closed cleanup.
      }
      void beginShutdown("readiness-failed", 1, dependencies);
    }
  }
  await lifetime;
  await shutdownPromise;
}

process.once("SIGINT", () => void beginShutdown("SIGINT"));
process.once("SIGTERM", () => void beginShutdown("SIGTERM"));
process.once("SIGHUP", () => void beginShutdown("SIGHUP"));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runPreviewSupervisor().catch(async (error) => {
    process.stderr.write(
      `${new Date().toISOString()} BEA_PREVIEW_SUPERVISOR=FAILED (${error instanceof Error ? error.message : "UnknownError"})\n`,
    );
    if (metadata) await beginShutdown("supervisor-failed", 1);
    else process.exitCode = 1;
  });
}
