import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertOwnerToolBoundary,
  controlPort,
  createDemoChildEnvironment,
  demoHost,
  isPathWithin,
  ownerToolPaths,
  processIsAlive,
  readValidatedMetadata,
  removeMetadataOwnedBy,
  repositoryRoot,
  signInUrl,
  tokensMatch,
  waitFor,
  webPort,
  workerHealthUrl,
  writeJsonAtomic,
} from "./owner-tools-common.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const webRoot = join(repositoryRoot, "apps", "web");
const workerEntry = join(repositoryRoot, "apps", "worker", "src", "index.ts");
const controlToken = process.env.BEA_DEMO_CONTROL_TOKEN;
const webLogPath = process.env.BEA_DEMO_WEB_LOG;
const workerLogPath = process.env.BEA_DEMO_WORKER_LOG;

let metadata;
let webChild;
let workerChild;
let controlServer;
let shutdownPromise;
let resolveLifetime;
const lifetime = new Promise((resolveDone) => {
  resolveLifetime = resolveDone;
});

function log(message) {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

function childSnapshot(child) {
  if (!child) return undefined;
  return {
    exitCode: child.exitCode,
    pid: child.pid,
    signalCode: child.signalCode,
  };
}

function updateMetadata(patch) {
  metadata = {
    ...metadata,
    ...patch,
    children: {
      web: childSnapshot(webChild),
      worker: childSnapshot(workerChild),
    },
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(ownerToolPaths.metadataFile, metadata);
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

function authenticated(request) {
  return tokensMatch(request.headers["x-bea-control-token"], controlToken);
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

async function terminateExactChild(child, label) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  log(`Requesting graceful shutdown for tracked ${label} PID ${child.pid}.`);
  child.kill("SIGTERM");
  if (await waitForChildExit(child, 15_000)) return;
  log(`Tracked ${label} PID ${child.pid} exceeded the grace period; terminating that exact PID.`);
  child.kill("SIGKILL");
  if (!(await waitForChildExit(child, 5_000))) {
    throw new Error(`Tracked ${label} PID ${child.pid} did not stop.`);
  }
}

function closeControlServer() {
  if (!controlServer) return Promise.resolve();
  return new Promise((resolveClose) => {
    controlServer.close(() => resolveClose());
    controlServer.closeIdleConnections?.();
    setTimeout(() => {
      controlServer.closeAllConnections?.();
      resolveClose();
    }, 2_000).unref();
  });
}

function beginShutdown(reason, exitCode = 0) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    log(`Supervisor shutdown requested (${reason}).`);
    try {
      updateMetadata({ state: "stopping", stopReason: reason });
      await Promise.all([
        terminateExactChild(webChild, "web"),
        terminateExactChild(workerChild, "worker"),
      ]);
      await closeControlServer();
      removeMetadataOwnedBy(metadata);
      log("Supervisor stopped all tracked children and removed active metadata.");
    } catch (error) {
      process.stderr.write(
        `${new Date().toISOString()} Supervisor cleanup failed (${error instanceof Error ? error.name : "UnknownError"}).\n`,
      );
      process.exitCode = 1;
    } finally {
      if (exitCode !== 0) process.exitCode = exitCode;
      resolveLifetime?.();
    }
  })();
  return shutdownPromise;
}

function createControlServer() {
  const server = createServer((request, response) => {
    if (!authenticated(request)) {
      writeJsonResponse(response, 401, { code: "BEA_DEMO_CONTROL_UNAUTHORIZED", ok: false });
      return;
    }
    if (request.method === "GET" && request.url === "/status") {
      writeJsonResponse(response, 200, {
        children: metadata.children,
        ok: true,
        state: metadata.state,
        supervisorPid: process.pid,
        webUrl: signInUrl,
        workerHealthUrl,
      });
      return;
    }
    if (request.method === "POST" && request.url === "/stop") {
      writeJsonResponse(response, 202, {
        code: "BEA_DEMO_STOP_ACCEPTED",
        ok: true,
        supervisorPid: process.pid,
      });
      setImmediate(() => void beginShutdown("authenticated-control-request"));
      return;
    }
    writeJsonResponse(response, 404, { code: "BEA_DEMO_CONTROL_NOT_FOUND", ok: false });
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  return server;
}

async function listenForControl() {
  controlServer = createControlServer();
  await new Promise((resolveListen, rejectListen) => {
    controlServer.once("error", rejectListen);
    controlServer.listen(controlPort, demoHost, () => {
      controlServer.off("error", rejectListen);
      resolveListen();
    });
  });
}

function validateLogPath(path, label) {
  if (typeof path !== "string" || !isPathWithin(path, ownerToolPaths.logDirectory)) {
    throw new Error(`${label} log path is outside the owner-tool log directory.`);
  }
}

function spawnLoggedNode(arguments_, options) {
  const descriptor = openSync(options.logPath, "a", 0o600);
  try {
    return spawn(process.execPath, arguments_, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", descriptor, descriptor],
      windowsHide: true,
    });
  } finally {
    closeSync(descriptor);
  }
}

function startChildren() {
  validateLogPath(webLogPath, "Web");
  validateLogPath(workerLogPath, "Worker");
  const childEnvironment = createDemoChildEnvironment(process.env);
  const requireFromWeb = createRequire(join(webRoot, "package.json"));
  const nextPackagePath = requireFromWeb.resolve("next/package.json");
  const nextCliPath = join(dirname(nextPackagePath), "dist", "bin", "next");

  workerChild = spawnLoggedNode(["--import=tsx", workerEntry, "--serve"], {
    cwd: repositoryRoot,
    env: childEnvironment,
    logPath: workerLogPath,
  });
  webChild = spawnLoggedNode(
    [nextCliPath, "dev", "--webpack", "--hostname", demoHost, "--port", String(webPort)],
    { cwd: webRoot, env: childEnvironment, logPath: webLogPath },
  );

  for (const [label, child] of [
    ["worker", workerChild],
    ["web", webChild],
  ]) {
    if (!child.pid) throw new Error(`The ${label} process did not return a PID.`);
    child.once("exit", (code, signal) => {
      if (!shutdownPromise) {
        updateMetadata({
          failureCode: `${label.toUpperCase()}_EXITED`,
          state: "failed",
        });
        log(
          `Tracked ${label} process exited unexpectedly (code=${String(code)}, signal=${String(signal)}).`,
        );
        void beginShutdown(`${label}-exited`, 1);
      }
    });
  }
  updateMetadata({ state: "starting" });
}

async function fetchWithTimeout(url, timeoutMilliseconds = 5_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
  try {
    return await fetch(url, { cache: "no-store", signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForReady() {
  await Promise.all([
    waitFor(
      async () => {
        if (!processIsAlive(workerChild?.pid)) {
          throw new Error("Tracked worker exited before readiness.");
        }
        const response = await fetchWithTimeout(workerHealthUrl);
        if (response.status !== 200) return false;
        const body = await response.json();
        return body?.service === "bea-worker" && body?.status === "healthy";
      },
      {
        intervalMilliseconds: 300,
        timeoutMessage: "Worker health was not ready within 180 seconds.",
        timeoutMilliseconds: 180_000,
      },
    ),
    waitFor(
      async () => {
        if (!processIsAlive(webChild?.pid)) {
          throw new Error("Tracked web process exited before readiness.");
        }
        const response = await fetchWithTimeout(signInUrl);
        if (response.status !== 200) return false;
        const body = await response.text();
        return body.includes("Open the local demo");
      },
      {
        intervalMilliseconds: 300,
        timeoutMessage: "Web sign-in was not ready within 180 seconds.",
        timeoutMilliseconds: 180_000,
      },
    ),
  ]);
}

async function waitForLaunchMetadata() {
  return waitFor(
    () => {
      const result = readValidatedMetadata();
      if (
        result.metadata?.supervisorPid === process.pid &&
        tokensMatch(result.metadata.controlToken, controlToken)
      ) {
        return result.metadata;
      }
      return false;
    },
    {
      intervalMilliseconds: 50,
      timeoutMessage: "Supervisor did not receive valid launcher metadata.",
      timeoutMilliseconds: 5_000,
    },
  );
}

async function main() {
  assertOwnerToolBoundary();
  if (process.platform !== "win32")
    throw new Error("The owner demo supervisor supports Windows only.");
  if (!/^[a-f0-9]{64}$/u.test(controlToken ?? ""))
    throw new Error("Supervisor control token is invalid.");
  if (fileURLToPath(new URL(import.meta.url)) !== join(scriptDirectory, "demo-supervisor.mjs")) {
    throw new Error("Supervisor script path validation failed.");
  }

  metadata = await waitForLaunchMetadata();
  log(`Authenticated supervisor PID ${process.pid} starting from ${repositoryRoot}.`);
  await listenForControl();
  startChildren();

  try {
    await waitForReady();
    if (!shutdownPromise) {
      updateMetadata({ readyAt: new Date().toISOString(), state: "ready" });
      log(`Demo Mode ready: ${signInUrl}`);
    }
  } catch (error) {
    if (!shutdownPromise) {
      updateMetadata({ failureCode: "READINESS_FAILED", state: "failed" });
      process.stderr.write(
        `${new Date().toISOString()} Demo readiness failed (${error instanceof Error ? error.name : "UnknownError"}).\n`,
      );
      void beginShutdown("readiness-failed", 1);
    }
  }

  await lifetime;
  await shutdownPromise;
}

process.once("SIGINT", () => void beginShutdown("SIGINT"));
process.once("SIGTERM", () => void beginShutdown("SIGTERM"));
process.once("SIGHUP", () => void beginShutdown("SIGHUP"));

void main().catch(async (error) => {
  process.stderr.write(
    `${new Date().toISOString()} BEA_DEMO_SUPERVISOR=FAILED (${error instanceof Error ? error.name : "UnknownError"})\n`,
  );
  if (metadata) {
    await beginShutdown("supervisor-failed", 1);
  } else {
    process.exitCode = 1;
    resolveLifetime?.();
  }
});
