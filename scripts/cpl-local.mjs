import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import net from "node:net";
import { get as httpGet } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertRepositoryBoundary, isPathWithin, REPOSITORY_ID } from "./repository-boundary.mjs";

import { synchronizeWorkspaceCopies, inspectWorkspaceCopies } from "./cpl-workspace-copies.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LOCAL_CACHE_ROOT = "D:\\Cyber Pirate Labs\\93_TOOLS_AND_CACHE\\CPL-Command-Center";
export const LOCAL_PORT = 3400;
export const LOCAL_URL = "http://127.0.0.1:" + LOCAL_PORT + "/setup";
const inheritedKeys = [
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "ComSpec",
  "COMSPEC",
  "Path",
  "PATH",
  "PATHEXT",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "LANG",
  "TZ",
];

export function runtimePaths(root) {
  const tooling = LOCAL_CACHE_ROOT;
  const stateDirectory = path.join(root, ".data", "cpl-local");
  const hash = createHash("sha256").update(root.toLowerCase()).digest("hex").slice(0, 24);
  return {
    tooling,
    stateDirectory,
    stateFile: path.join(stateDirectory, "launcher.json"),
    pipe: "\\\\.\\pipe\\cpl-command-center-" + hash,
    temp: path.join(tooling, "temp"),
    cache: path.join(tooling, "cache"),
    playwright: path.join(tooling, "playwright"),
    appData: path.join(tooling, "app-data"),
    localAppData: path.join(tooling, "local-app-data"),
    home: path.join(tooling, "home"),
    data: path.join(tooling, "data"),
    state: path.join(tooling, "state"),
    corepack: path.join(tooling, "cache", "corepack"),
    pnpmHome: path.join(tooling, "pnpm-home"),
    npmCache: path.join(tooling, "cache", "npm"),
    pnpmStore: path.join(root, ".data", "tooling", "pnpm-store"),
    nextOutput: path.join(root, "apps", "web", ".next"),
    turboOutput: path.join(root, ".turbo"),
  };
}

export function createSafeEnvironment(root, source = process.env) {
  const paths = runtimePaths(root);
  const environment = Object.fromEntries(
    inheritedKeys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
  );
  return {
    ...environment,
    APP_MODE: "production",
    BEA_RUNTIME_MODE: "production",
    NODE_ENV: "development",
    BEA_DISABLE_ENV_FILE: "true",
    CPL_REPOSITORY_ROOT: root,
    BEA_REPOSITORY_ROOT: root,
    APP_BASE_URL: "http://127.0.0.1:" + LOCAL_PORT,
    DEMO_AUTH_ENABLED: "false",
    OPENAI_API_KEY: "",
    DATABASE_URL: "",
    SESSION_SECRET: "",
    NEXT_TELEMETRY_DISABLED: "1",
    TURBO_TELEMETRY_DISABLED: "1",
    TEMP: paths.temp,
    TMP: paths.temp,
    TMPDIR: paths.temp,
    XDG_CACHE_HOME: paths.cache,
    npm_config_cache: paths.npmCache,
    npm_config_store_dir: paths.pnpmStore,
    XDG_DATA_HOME: paths.data,
    XDG_STATE_HOME: paths.state,
    COREPACK_HOME: paths.corepack,
    PNPM_HOME: paths.pnpmHome,
    HOME: paths.home,
    USERPROFILE: paths.home,
    PLAYWRIGHT_BROWSERS_PATH: paths.playwright,
    APPDATA: paths.appData,
    LOCALAPPDATA: paths.localAppData,
  };
}

export function ensureLocalBoundary() {
  const boundary = assertRepositoryBoundary({ cwd: repositoryRoot, target: repositoryRoot });
  if (process.platform !== "win32" || !/^D:[\\/]/iu.test(boundary.target)) {
    throw new Error("These local launchers require the authorized Windows SSD checkout.");
  }
  return boundary.target;
}

function assertUnredirected(root, candidate) {
  if (!isPathWithin(candidate, root))
    throw new Error("Local runtime path escaped its authorized storage root.");
  let existing = candidate;
  while (!existsSync(existing)) existing = path.dirname(existing);
  if (realpathSync.native(existing).toLowerCase() !== path.resolve(existing).toLowerCase()) {
    throw new Error("Redirected local runtime path refused.");
  }
  if (lstatSync(existing).isSymbolicLink()) throw new Error("Linked local runtime path refused.");
}

export function prepareDirectories(root) {
  const paths = runtimePaths(root);
  for (const candidate of [
    paths.stateDirectory,
    paths.temp,
    paths.cache,
    paths.playwright,
    paths.appData,
    paths.localAppData,
    paths.home,
    paths.data,
    paths.state,
    paths.corepack,
    paths.pnpmHome,
    paths.npmCache,
    paths.pnpmStore,
    paths.nextOutput,
    paths.turboOutput,
  ]) {
    const storageRoot = isPathWithin(candidate, root) ? root : LOCAL_CACHE_ROOT;
    assertUnredirected(storageRoot, candidate);
    mkdirSync(candidate, { recursive: true });
    assertUnredirected(storageRoot, candidate);
  }
  return paths;
}

export function checkDependencies(root) {
  const requireWeb = createRequire(path.join(root, "apps", "web", "package.json"));
  const missing = [];
  for (const dependency of ["next/package.json", "react/package.json", "@bea/ui"]) {
    try {
      requireWeb.resolve(dependency);
    } catch {
      missing.push(dependency);
    }
  }
  return { ok: missing.length === 0, missing };
}

export async function warmSetupPage({
  url = LOCAL_URL,
  timeoutMs = 90_000,
  retryMs = 250,
  progressMs = 10_000,
  signal,
  onProgress = () => {},
} = {}) {
  const started = Date.now();
  const controller = new AbortController();
  let phase = "STARTING";
  const report = () => onProgress({ state: phase, elapsedMs: Date.now() - started });
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error("SETUP_READINESS_TIMEOUT")),
    timeoutMs,
  );
  const progress = setInterval(report, progressMs);
  try {
    report();
    while (true) {
      controller.signal.throwIfAborted();
      try {
        await new Promise((resolve, reject) => {
          const request = httpGet(url, { signal: controller.signal }, (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("error", reject);
            response.on("data", (chunk) => {
              body += chunk;
              if (body.length > 262_144) {
                request.destroy(new Error("SETUP_RESPONSE_TOO_LARGE"));
              }
            });
            response.on("end", () => {
              if (response.statusCode !== 200) {
                reject(new Error("SETUP_HTTP_" + response.statusCode));
              } else if (
                !body.includes("CPL Command Center") ||
                !body.includes("Workspace setup")
              ) {
                reject(new Error("SETUP_RESPONSE_NOT_RECOGNIZED"));
              } else resolve();
            });
          });
          request.on("socket", (socket) => {
            socket.once("connect", () => {
              phase = "COMPILING";
              report();
            });
          });
          request.on("error", reject);
        });
        phase = "READY";
        report();
        return { state: phase, elapsedMs: Date.now() - started };
      } catch (error) {
        if (controller.signal.aborted) {
          if (signal?.aborted) throw signal.reason;
          throw error;
        }
        if (error.code !== "ECONNREFUSED" && error.code !== "ECONNRESET") throw error;
        await delay(retryMs, undefined, { signal: controller.signal });
      }
    }
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) {
      throw new Error(
        "Setup did not become ready within " +
          Math.ceil(timeoutMs / 1000) +
          " seconds. Review the compiler output and run CPL-Doctor.cmd.",
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    clearInterval(progress);
    signal?.removeEventListener("abort", abort);
  }
}

function tokenMatches(expected, supplied) {
  if (typeof supplied !== "string" || !/^[a-f0-9]{64}$/u.test(supplied)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(supplied, "hex"));
}

export function createControlServer({ pipe, token, status, stop }) {
  const server = net.createServer((socket) => {
    socket.setTimeout(3000, () => socket.destroy());
    let buffer = "";
    socket.on("error", () => {});
    socket.on("data", async (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 2048) {
        socket.destroy();
        return;
      }
      if (!buffer.includes("\n")) return;
      socket.pause();
      try {
        const request = JSON.parse(buffer.split("\n")[0]);
        if (request.action === "status") {
          socket.end(JSON.stringify({ ok: true, ...status() }) + "\n");
        } else if (request.action === "stop" && tokenMatches(token, request.token)) {
          await stop();
          socket.end(JSON.stringify({ ok: true, stopped: true }) + "\n");
        } else {
          socket.end(JSON.stringify({ ok: false, code: "UNAUTHORIZED_CONTROL_REQUEST" }) + "\n");
        }
      } catch {
        socket.end(JSON.stringify({ ok: false, code: "CONTROL_REQUEST_FAILED" }) + "\n");
      }
    });
  });
  return {
    server,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(pipe, () => {
          server.off("error", reject);
          resolve();
        });
      }),
  };
}

export function requestControl(pipe, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe);
    let buffer = "";
    socket.setTimeout(8000, () => socket.destroy(new Error("Local launcher control timed out.")));
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 4096) {
        socket.destroy(new Error("Invalid launcher response."));
        return;
      }
      if (buffer.includes("\n")) {
        try {
          resolve(JSON.parse(buffer.split("\n")[0]));
        } catch {
          reject(new Error("Invalid launcher response."));
        }
        socket.end();
      }
    });
    socket.on("end", () => {
      if (!buffer.includes("\n")) reject(new Error("Incomplete launcher response."));
    });
  });
}

export function ownsProcessEvidence(evidence, expected) {
  const command =
    typeof evidence?.CommandLine === "string" ? evidence.CommandLine.toLowerCase() : "";
  return (
    evidence?.ProcessId === expected.pid &&
    evidence?.ParentProcessId === expected.parentPid &&
    typeof evidence.ExecutablePath === "string" &&
    evidence.ExecutablePath.toLowerCase() === expected.executable.toLowerCase() &&
    command.includes('"' + expected.script.toLowerCase() + '"')
  );
}

function stopOwnedChild(child, root) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || pid < 1)
    throw new Error(
      "Owned web process identity is unavailable; use Ctrl+C in its launch terminal.",
    );
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  const powershell = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  let evidence;
  try {
    const command =
      "Get-CimInstance Win32_Process -Filter 'ProcessId = " +
      pid +
      "' | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress";
    evidence = JSON.parse(
      execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch {
    throw new Error("Could not verify the owned web process; use Ctrl+C in its launch terminal.");
  }
  if (
    !ownsProcessEvidence(evidence, {
      pid,
      parentPid: process.pid,
      executable: process.execPath,
      script: path.join(root, "scripts", "next-no-env.mjs"),
    })
  ) {
    throw new Error(
      "Web process ownership changed; no process was terminated. Use its original terminal.",
    );
  }
  execFileSync(
    path.join(systemRoot, "System32", "taskkill.exe"),
    ["/PID", String(pid), "/T", "/F"],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
}

export async function startLocal() {
  const root = ensureLocalBoundary();
  const paths = runtimePaths(root);
  assertUnredirected(root, paths.stateFile);
  const token = randomBytes(32).toString("hex");
  let child;
  let stopping;
  let childClosed;
  const warmupController = new AbortController();
  let readiness = { state: "STARTING", elapsedMs: 0 };
  const status = () => ({
    repositoryId: REPOSITORY_ID,
    root,
    launcherPid: process.pid,
    webPid: child?.pid ?? null,
    url: LOCAL_URL,
    mode: "provisioning-only",
    readiness,
  });
  const stop = () => {
    stopping ??= (async () => {
      warmupController.abort();
      if (child) stopOwnedChild(child, root);
      await childClosed;
    })().catch((error) => {
      stopping = undefined;
      throw error;
    });
    return stopping;
  };
  const control = createControlServer({ pipe: paths.pipe, token, status, stop });
  try {
    await control.listen();
  } catch {
    throw new Error(
      "A CPL local launcher already owns this checkout, or its control pipe is unavailable. Run CPL-Doctor.cmd.",
    );
  }
  const onSignal = () => {
    stop().catch((error) => process.stderr.write(error.message + "\n"));
  };
  control.server.on("error", () => {
    process.stderr.write("Local control channel failed; stopping the owned web process.\n");
    onSignal();
  });
  const cleanup = () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    control.server.close();
    try {
      assertUnredirected(root, paths.stateFile);
      const recorded = JSON.parse(readFileSync(paths.stateFile, "utf8"));
      if (recorded.token === token) rmSync(paths.stateFile);
    } catch {
      /* Only this launcher's matching metadata may be removed. */
    }
  };
  try {
    // Take the exclusive launcher pipe before mutating copies or build output.
    prepareDirectories(root);
    synchronizeWorkspaceCopies();
    const dependencies = checkDependencies(root);
    if (!dependencies.ok)
      throw new Error(
        "Local dependencies are incomplete: " +
          dependencies.missing.join(", ") +
          ". Complete the SSD dependency installation first.",
      );
    child = spawn(
      process.execPath,
      [
        path.join(root, "scripts", "next-no-env.mjs"),
        "dev",
        "--webpack",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(LOCAL_PORT),
      ],
      {
        cwd: path.join(root, "apps", "web"),
        env: createSafeEnvironment(root),
        stdio: "inherit",
        windowsHide: true,
      },
    );
    childClosed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    writeFileSync(
      paths.stateFile,
      JSON.stringify({ ...status(), pipe: paths.pipe, token }) + "\n",
      { mode: 0o600 },
    );
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    process.stdout.write(
      "Starting CPL provisioning at " +
        LOCAL_URL +
        ". Waiting for the setup page to compile. Stop with Ctrl+C or Stop-CPL.cmd.\n",
    );
    const warmed = warmSetupPage({
      signal: warmupController.signal,
      onProgress: (progress) => {
        readiness = progress;
        process.stdout.write(
          "CPL_SETUP=" +
            progress.state +
            " elapsed=" +
            (progress.elapsedMs / 1000).toFixed(1) +
            "s\n",
        );
      },
    });
    try {
      await Promise.race([warmed, childClosed]);
    } catch (error) {
      if (!stopping) throw error;
    }
    if (readiness.state === "READY" && !stopping)
      process.stdout.write("CPL_LOCAL=READY " + LOCAL_URL + " Keep this terminal open.\n");
    const outcome = await childClosed;
    warmupController.abort();
    await warmed.catch(() => {});
    if (!stopping && outcome.code !== 0)
      throw new Error("Local web process exited unsuccessfully. Review the launch output above.");
  } catch (error) {
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        await stop();
      } catch (stopError) {
        process.stderr.write(stopError.message + "\n");
      }
    }
    throw error;
  } finally {
    cleanup();
  }
}

export async function stopLocal() {
  const root = ensureLocalBoundary();
  const paths = runtimePaths(root);
  assertUnredirected(root, paths.stateFile);
  if (!existsSync(paths.stateFile)) {
    process.stdout.write("CPL_LOCAL=NOT_RUNNING No owned launcher metadata exists.\n");
    return;
  }
  const state = JSON.parse(readFileSync(paths.stateFile, "utf8"));
  if (
    state.root !== root ||
    state.repositoryId !== REPOSITORY_ID ||
    state.pipe !== paths.pipe ||
    !/^[a-f0-9]{64}$/u.test(state.token ?? "")
  ) {
    throw new Error("Launcher metadata failed ownership checks; no process was terminated.");
  }
  let response;
  try {
    response = await requestControl(paths.pipe, { action: "stop", token: state.token });
  } catch {
    throw new Error(
      "The owning launcher did not respond. No process was terminated by PID or port. Use Ctrl+C in the original launch terminal.",
    );
  }
  if (!response.ok || !response.stopped)
    throw new Error(
      "The owning launcher refused shutdown. Review its terminal; no unverified process was terminated.",
    );
  process.stdout.write("CPL_LOCAL=STOPPED Owned provisioning web process stopped.\n");
}

// A read-only preflight for installers and verification. This does not claim a
// shared mutation lock: a separate Start can still race after the check returns.
export async function assertLocalLauncherStopped(root = ensureLocalBoundary()) {
  const actualRoot = ensureLocalBoundary();
  if (path.resolve(root).toLowerCase() !== actualRoot.toLowerCase())
    throw new Error("Launcher status requested outside the authorized checkout.");
  try {
    await requestControl(runtimePaths(actualRoot).pipe, { action: "status" });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ECONNREFUSED") return;
    throw new Error(
      "Launcher status could not be verified; stop the local launcher before modifying dependencies.",
    );
  }
  throw new Error(
    "The local launcher is active. Run Stop-CPL.cmd before installation or verification.",
  );
}

export async function doctorLocal() {
  const root = ensureLocalBoundary();
  const paths = runtimePaths(root);
  for (const candidate of [paths.temp, paths.cache, paths.stateDirectory])
    assertUnredirected(candidate === paths.stateDirectory ? root : LOCAL_CACHE_ROOT, candidate);
  const dependencies = checkDependencies(root);
  const workspaceCopies = inspectWorkspaceCopies();
  let launcher = null;
  try {
    const response = await requestControl(paths.pipe, { action: "status" });
    if (response.ok && response.root === root && response.repositoryId === REPOSITORY_ID)
      launcher = response;
  } catch {
    /* No live owner is a normal stopped state. */
  }
  process.stdout.write(
    JSON.stringify({
      code: "CPL_LOCAL_DOCTOR",
      boundary: "PASS",
      repositoryId: REPOSITORY_ID,
      dependencies,
      workspaceCopies,
      tempDirectory: paths.temp,
      tempExists: existsSync(paths.temp),
      launcher: launcher
        ? launcher.readiness?.state === "READY"
          ? "READY"
          : "STARTING"
        : "STOPPED_OR_UNREACHABLE",
      readiness: launcher?.readiness ?? null,
      url: LOCAL_URL,
      productRuntime: "UNCONFIGURED",
      mode: "provisioning-only",
      workersStarted: false,
      providerCallsEnabled: false,
      databaseProvisioned: false,
    }) + "\n",
  );
  if (!dependencies.ok || workspaceCopies.state !== "FRESH") process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const commands = { start: startLocal, stop: stopLocal, doctor: doctorLocal };
  const command = commands[process.argv[2]];
  if (!command) {
    process.stderr.write("Usage: node scripts/cpl-local.mjs start|stop|doctor\n");
    process.exitCode = 1;
  } else
    command().catch((error) => {
      process.stderr.write("CPL_LOCAL_FAILED: " + error.message + "\n");
      process.exitCode = 1;
    });
}
