import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";

import { assertRepositoryBoundary } from "../repository-boundary.mjs";
import { readProductionConfig } from "./production-config.mjs";
import {
  collectProductionDoctorReport,
  printProductionDoctorReport,
} from "./production-doctor.mjs";
import { productionPaths, repositoryRoot, TOOLCHAIN_NODE_VERSION } from "./production-paths.mjs";
import { readProductionSecrets } from "./production-secrets.mjs";
import { productionPostgresConnectionUrl } from "./postgres-tools.mjs";
import {
  controlRequest,
  processIsAlive,
  readRuntimeMetadata,
  waitFor,
} from "./runtime-control.mjs";

const supervisorScript = join(repositoryRoot, "scripts", "phase134", "production-supervisor.mjs");

export function createSupervisorEnvironment(
  config,
  secrets,
  paths = productionPaths,
  source = process.env,
) {
  const required = ["sessionSecret", "databaseUrl", "httpsPfxPassword", "controlToken"];
  for (const key of required) {
    if (typeof secrets[key] !== "string" || secrets[key].length === 0) {
      throw new Error(`Protected secret ${key} is required.`);
    }
  }
  const inherited = Object.fromEntries(
    [
      "APPDATA",
      "ComSpec",
      "COMSPEC",
      "LANG",
      "LC_ALL",
      "LOCALAPPDATA",
      "NUMBER_OF_PROCESSORS",
      "PATH",
      "Path",
      "PATHEXT",
      "PROCESSOR_ARCHITECTURE",
      "SystemDrive",
      "SystemRoot",
      "SYSTEMROOT",
      "TEMP",
      "TMP",
      "TZ",
      "USERPROFILE",
      "WINDIR",
    ]
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, source[key]]),
  );
  return {
    ...inherited,
    APP_BASE_URL: config.appBaseUrl,
    APP_MODE: "production",
    BEA_AUTH_PROVIDER: config.authentication.provider,
    BEA_DEPLOYMENT_PROFILE: config.deploymentProfile,
    BEA_DISABLE_ENV_FILE: "true",
    BEA_HTTPS_PFX_PASSWORD: secrets.httpsPfxPassword,
    BEA_PRODUCTION_CONFIG_PATH: paths.configFile,
    BEA_PRODUCTION_CONTROL_TOKEN: secrets.controlToken,
    BEA_PRODUCTION_METADATA_PATH: paths.runtimeMetadataFile,
    BEA_PRODUCTION_LOCK_PATH: paths.runtimeLockFile ?? `${paths.runtimeMetadataFile}.lock`,
    BEA_PRODUCTION_SECRET_PATH: paths.secretFile,
    BEA_RUNTIME_MODE: "production",
    DATABASE_DRIVER: "postgres",
    DATABASE_URL: productionPostgresConnectionUrl(secrets.databaseUrl, config.database.tlsMode),
    DEMO_AUTH_ENABLED: "false",
    NODE_ENV: "production",
    NODE_USE_SYSTEM_CA: "1",
    SESSION_SECRET: secrets.sessionSecret,
    WORKER_HEALTH_PORT: String(config.ports.workerHealth),
    WORKER_MODE: "serve",
    WORKER_QUEUE_ADAPTER: "pg-boss",
  };
}

export function decideStartFromTrackedState(metadataResult, alive) {
  if (!metadataResult.exists) return { action: "start" };
  if (!metadataResult.metadata) {
    return { action: "block", message: metadataResult.issues.join(" ") };
  }
  if (!alive) return { action: "remove-stale", metadata: metadataResult.metadata };
  return { action: "authenticate", metadata: metadataResult.metadata };
}

function openBrowser(url, spawnProcess = spawn) {
  const command = process.env.ComSpec ?? "cmd.exe";
  const child = spawnProcess(command, ["/d", "/s", "/c", "start", "", url], {
    cwd: repositoryRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref?.();
}

async function stopFailedLaunch(child, metadataPath, dependencies = {}) {
  const alive = dependencies.processIsAlive ?? processIsAlive;
  if (child?.pid && alive(child.pid)) {
    child.kill("SIGTERM");
    try {
      await (dependencies.waitFor ?? waitFor)(() => !alive(child.pid), {
        timeoutMs: 15_000,
        intervalMs: 200,
      });
    } catch {
      if (alive(child.pid)) child.kill("SIGKILL");
    }
  }
  if (!child?.pid || !alive(child.pid)) rmSync(metadataPath, { force: true });
}

export async function startProduction(options = {}, dependencies = {}) {
  (dependencies.assertBoundary ?? assertRepositoryBoundary)({
    cwd: repositoryRoot,
    target: repositoryRoot,
  });
  if ((dependencies.platform ?? process.platform) !== "win32") {
    throw new Error("Local Live production supports Windows only.");
  }
  const currentNode = (dependencies.nodeVersion ?? process.version).replace(/^v/u, "");
  if (currentNode !== TOOLCHAIN_NODE_VERSION) {
    throw new Error(`Start-BEA requires the BEA-owned Node ${TOOLCHAIN_NODE_VERSION}.`);
  }
  const paths = dependencies.paths ?? productionPaths;
  const config = (dependencies.readConfig ?? readProductionConfig)({ filePath: paths.configFile });
  const secrets = (dependencies.readSecrets ?? readProductionSecrets)(
    ["sessionSecret", "databaseUrl", "httpsPfxPassword", "controlToken"],
    { filePath: paths.secretFile },
  );
  const tracked = (dependencies.readMetadata ?? readRuntimeMetadata)(paths.runtimeMetadataFile);
  const decision = decideStartFromTrackedState(
    tracked,
    tracked.metadata
      ? (dependencies.processIsAlive ?? processIsAlive)(tracked.metadata.supervisorPid)
      : false,
  );
  if (decision.action === "block") throw new Error(decision.message);
  if (decision.action === "authenticate") {
    const response = await (dependencies.controlRequest ?? controlRequest)(
      decision.metadata,
      secrets.controlToken,
      "/status",
    ).catch(() => undefined);
    if (
      !response?.ok ||
      response.body?.supervisorPid !== decision.metadata.supervisorPid ||
      response.body?.profile !== "local-live"
    ) {
      throw new Error(
        "A tracked PID is alive but did not authenticate as this BEA supervisor; no process was touched.",
      );
    }
    if (!options.noOpen) (dependencies.openBrowser ?? openBrowser)(`${config.appBaseUrl}/sign-in`);
    process.stdout.write(
      `BEA Local Live is already running under owned supervisor PID ${String(decision.metadata.supervisorPid)}.\n` +
        `Open ${config.appBaseUrl}/sign-in\nBEA_PRODUCTION_START=ALREADY_RUNNING\n`,
    );
    return { outcome: "ALREADY_RUNNING", supervisorPid: decision.metadata.supervisorPid };
  }
  if (decision.action === "remove-stale") {
    rmSync(paths.runtimeMetadataFile, { force: true });
  }

  const doctor = await (dependencies.collectDoctor ?? collectProductionDoctorReport)({
    paths,
    deep: options.deep ?? true,
  });
  if (options.check) {
    printProductionDoctorReport(doctor);
    process.stdout.write(
      `BEA_PRODUCTION_START_CHECK=${doctor.startBlockers.length === 0 ? "PASS" : "BLOCKED"}\n`,
    );
    return { outcome: doctor.startBlockers.length === 0 ? "PASS" : "BLOCKED", doctor };
  }
  if (doctor.startBlockers.length > 0) {
    printProductionDoctorReport(doctor);
    throw new Error(
      "Production readiness contains genuine startup blockers; no process was started.",
    );
  }

  mkdirSync(paths.runtimeDirectory, { recursive: true });
  mkdirSync(paths.logDirectory, { recursive: true });
  const supervisorLogPath = join(paths.logDirectory, "supervisor.log");
  const supervisorLog = openSync(supervisorLogPath, "a", 0o600);
  let child;
  try {
    child = (dependencies.spawn ?? spawn)(process.execPath, [supervisorScript], {
      cwd: repositoryRoot,
      detached: true,
      env: createSupervisorEnvironment(
        config,
        secrets,
        paths,
        dependencies.environment ?? process.env,
      ),
      stdio: ["ignore", supervisorLog, supervisorLog],
      windowsHide: true,
    });
  } finally {
    closeSync(supervisorLog);
  }
  if (!child.pid) {
    throw new Error("The production supervisor did not return a PID.");
  }
  child.unref?.();
  try {
    const ready = await (dependencies.waitFor ?? waitFor)(
      async () => {
        if (!(dependencies.processIsAlive ?? processIsAlive)(child.pid)) {
          throw new Error("The owned production supervisor exited before readiness.");
        }
        const current = (dependencies.readMetadata ?? readRuntimeMetadata)(
          paths.runtimeMetadataFile,
        );
        if (!current.metadata || current.metadata.supervisorPid !== child.pid) return false;
        const response = await (dependencies.controlRequest ?? controlRequest)(
          current.metadata,
          secrets.controlToken,
          "/status",
        );
        if (response.body?.state === "failed")
          throw new Error("The supervisor reported readiness failure.");
        return response.ok && response.body?.state === "ready" ? current.metadata : false;
      },
      {
        timeoutMs: 190_000,
        intervalMs: 300,
        message: "The Local Live production runtime did not become ready.",
      },
    );
    if (!options.noOpen) (dependencies.openBrowser ?? openBrowser)(`${config.appBaseUrl}/sign-in`);
    process.stdout.write(
      `BEA Local Live Production is ready under owned supervisor PID ${String(ready.supervisorPid)}.\n` +
        `Open ${config.appBaseUrl}/sign-in\n` +
        `OpenAI may remain SETUP REQUIRED until Andrew connects it after sign-in.\n` +
        `BEA_PRODUCTION_START=PASS\n`,
    );
    return { outcome: "PASS", supervisorPid: ready.supervisorPid };
  } catch (error) {
    await stopFailedLaunch(child, paths.runtimeMetadataFile, dependencies);
    throw error;
  }
}

function parseArguments(arguments_) {
  const options = { check: false, deep: false, noOpen: false };
  for (const argument of arguments_) {
    if (argument === "--check") options.check = true;
    else if (argument === "--deep") options.deep = true;
    else if (argument === "--no-open") options.noOpen = true;
    else throw new Error("Usage: production-start.mjs [--check] [--deep] [--no-open]");
  }
  if (options.check && options.noOpen)
    throw new Error("--check cannot be combined with --no-open.");
  return options;
}

if (process.argv[1]?.toLowerCase().endsWith("production-start.mjs")) {
  startProduction(parseArguments(process.argv.slice(2))).catch((error) => {
    process.stderr.write(
      `BEA_PRODUCTION_START=BLOCKED (${error instanceof Error ? error.name : "UnknownError"})\n`,
    );
    process.exitCode = 1;
  });
}
