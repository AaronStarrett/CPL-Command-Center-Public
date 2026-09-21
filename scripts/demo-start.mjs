import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { collectDoctorReport, printDoctorReport } from "./bea-doctor.mjs";
import {
  assertOwnerToolBoundary,
  closeFileDescriptor,
  controlPort,
  controlRequest,
  createDemoChildEnvironment,
  createRunLogPaths,
  ensureOwnerToolDirectories,
  formatRelativePath,
  inspectDemoEnvironment,
  inspectTrackedDemo,
  openAppendOnlyLog,
  openInDefaultBrowser,
  ownerToolPaths,
  processIsAlive,
  readJson,
  readValidatedMetadata,
  removeMetadataOwnedBy,
  repositoryRoot,
  runPnpm,
  signInUrl,
  waitFor,
  webPort,
  workerPort,
  writeJsonAtomic,
} from "./owner-tools-common.mjs";

const supervisorScript = join(repositoryRoot, "scripts", "demo-supervisor.mjs");

function parseArguments(arguments_) {
  const options = { check: false, noOpen: false, seed: false };
  for (const argument of arguments_) {
    if (argument === "--check") options.check = true;
    else if (argument === "--no-open") options.noOpen = true;
    else if (argument === "--seed") options.seed = true;
    else {
      throw new Error("Usage: node scripts/demo-start.mjs [--check] [--no-open] [--seed]");
    }
  }
  if (options.check && (options.noOpen || options.seed)) {
    throw new Error(
      "--check cannot be combined with --no-open or --seed because it makes no changes.",
    );
  }
  return options;
}

function readInitializationState() {
  if (!existsSync(ownerToolPaths.initializationFile)) return { firstStart: true };
  try {
    const value = readJson(ownerToolPaths.initializationFile);
    if (
      value?.version !== 1 ||
      typeof value.repositoryRoot !== "string" ||
      value.repositoryRoot.toLowerCase() !== repositoryRoot.toLowerCase()
    ) {
      throw new Error("initialization marker does not match this canonical repository");
    }
    return { firstStart: false, marker: value };
  } catch (error) {
    throw new Error(
      `Owner initialization marker is invalid (${error instanceof Error ? error.message : "UnknownError"}).`,
    );
  }
}

function runRequiredPnpm(pnpmCommand, arguments_, environment, label) {
  process.stdout.write(`==> ${label}\n`);
  const result = runPnpm(pnpmCommand, arguments_, {
    env: environment,
    stdio: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${result.exitCode}.`);
  }
}

function writeLaunchMetadata(supervisorPid, controlToken, logs) {
  const metadata = {
    version: 1,
    repositoryRoot,
    supervisorPid,
    controlHost: "127.0.0.1",
    controlPort,
    controlToken,
    webPort,
    workerPort,
    state: "starting",
    startedAt: new Date().toISOString(),
    children: {},
    logs: {
      supervisor: formatRelativePath(logs.supervisor),
      web: formatRelativePath(logs.web),
      worker: formatRelativePath(logs.worker),
    },
  };
  writeJsonAtomic(ownerToolPaths.metadataFile, metadata);
  return metadata;
}

async function waitForSupervisorReady(supervisorPid) {
  return waitFor(
    async () => {
      if (!processIsAlive(supervisorPid)) {
        throw new Error("The tracked supervisor exited before the demo became ready.");
      }
      const tracked = await inspectTrackedDemo();
      if (tracked.state === "running") {
        if (tracked.status.state === "ready") return tracked;
        if (tracked.status.state === "failed") {
          throw new Error("The tracked supervisor reported a readiness failure.");
        }
      } else if (tracked.state === "invalid" || tracked.state === "stale") {
        throw new Error("The tracked supervisor metadata became invalid during startup.");
      }
      return false;
    },
    {
      intervalMilliseconds: 300,
      timeoutMessage: "The BEA demo was not ready within 185 seconds.",
      timeoutMilliseconds: 185_000,
    },
  );
}

async function cleanFailedLaunch(supervisor, metadata) {
  try {
    const tracked = await inspectTrackedDemo();
    if (tracked.state === "running") {
      await controlRequest(tracked.metadata, "/stop", {
        method: "POST",
        timeoutMilliseconds: 3_000,
      });
    } else if (processIsAlive(supervisor.pid)) {
      supervisor.kill("SIGTERM");
    }
  } catch {
    if (processIsAlive(supervisor.pid)) supervisor.kill("SIGTERM");
  }

  try {
    await waitFor(() => !processIsAlive(supervisor.pid), {
      intervalMilliseconds: 200,
      timeoutMilliseconds: 20_000,
    });
  } catch {
    if (processIsAlive(supervisor.pid)) {
      supervisor.kill("SIGKILL");
      await waitFor(() => !processIsAlive(supervisor.pid), {
        intervalMilliseconds: 100,
        timeoutMessage:
          "The exact launcher-owned supervisor PID did not terminate after escalation.",
        timeoutMilliseconds: 5_000,
      });
    }
  }
  if (!processIsAlive(supervisor.pid)) removeMetadataOwnedBy(metadata);
}

function startSupervisor(logs, controlToken) {
  const supervisorLog = openAppendOnlyLog(logs.supervisor);
  try {
    return spawn(process.execPath, [supervisorScript], {
      cwd: repositoryRoot,
      detached: true,
      env: {
        ...createDemoChildEnvironment(process.env),
        BEA_DEMO_CONTROL_TOKEN: controlToken,
        BEA_DEMO_WEB_LOG: logs.web,
        BEA_DEMO_WORKER_LOG: logs.worker,
      },
      stdio: ["ignore", supervisorLog, supervisorLog],
      windowsHide: true,
    });
  } finally {
    closeFileDescriptor(supervisorLog);
  }
}

function recordInitialization(existing, seeded) {
  const now = new Date().toISOString();
  writeJsonAtomic(ownerToolPaths.initializationFile, {
    version: 1,
    repositoryRoot,
    initializedAt: existing?.initializedAt ?? now,
    lastSeededAt: seeded ? now : existing?.lastSeededAt,
    profile: "Demo Mode / PGlite / inline queue",
  });
}

export async function startDemo(options = {}) {
  assertOwnerToolBoundary();
  if (process.platform !== "win32")
    throw new Error("The owner demo launcher supports Windows only.");

  if (options.check) {
    const report = await collectDoctorReport();
    printDoctorReport(report);
    process.stdout.write(
      `BEA_DEMO_START_CHECK=${report.blockers.length === 0 ? "PASS" : "BLOCKED"}\n`,
    );
    return report.blockers.length === 0 ? 0 : 1;
  }

  const environmentInspection = inspectDemoEnvironment();
  if (environmentInspection.issues.length > 0) {
    throw new Error(
      `Demo environment validation failed. ${environmentInspection.issues.join(" ")}`,
    );
  }

  const existing = await inspectTrackedDemo();
  if (existing.state === "running") {
    if (options.seed) throw new Error("Stop the running demo before using --seed.");
    process.stdout.write(
      `BEA Demo Mode is already running under authenticated supervisor PID ${existing.metadata.supervisorPid}.\n`,
    );
    if (!options.noOpen) openInDefaultBrowser(signInUrl);
    process.stdout.write(`Open ${signInUrl}\nBEA_DEMO_START=ALREADY_RUNNING\n`);
    return 0;
  }
  if (existing.state === "stale") {
    if (!removeMetadataOwnedBy(existing.metadata)) {
      throw new Error("Stale owner metadata changed during validation and was not removed.");
    }
    process.stdout.write(
      `Cleaned stale metadata for stopped supervisor PID ${existing.metadata.supervisorPid}.\n`,
    );
  } else if (existing.state === "invalid") {
    throw new Error(`Owner metadata failed validation. ${existing.issues.join(" ")}`);
  } else if (existing.state === "unreachable") {
    throw new Error(
      `Supervisor PID ${existing.metadata.supervisorPid} is alive but its control token did not authenticate. No process was terminated.`,
    );
  }

  const report = await collectDoctorReport({ allowMissingDependencies: true });
  if (report.blockers.length > 0) {
    printDoctorReport(report);
    throw new Error("Owner prerequisite checks are blocked; no demo process was started.");
  }
  if (!report.pnpmCommand) throw new Error("pnpm.cmd was not found on PATH.");

  if (!existsSync(join(repositoryRoot, "node_modules"))) {
    runRequiredPnpm(
      report.pnpmCommand,
      ["install", "--frozen-lockfile"],
      process.env,
      "Frozen dependency installation (first setup only)",
    );
  } else {
    process.stdout.write("==> Dependencies already present; frozen install skipped.\n");
  }

  const initialization = readInitializationState();
  const shouldSeed = initialization.firstStart || options.seed;
  const childEnvironment = createDemoChildEnvironment(process.env);
  runRequiredPnpm(report.pnpmCommand, ["db:migrate"], childEnvironment, "Demo database migration");
  if (shouldSeed) {
    runRequiredPnpm(report.pnpmCommand, ["db:seed"], childEnvironment, "Deterministic demo seed");
  } else {
    process.stdout.write("==> Existing owner demo initialization found; seed skipped.\n");
  }

  ensureOwnerToolDirectories();
  const logs = createRunLogPaths();
  const controlToken = randomBytes(32).toString("hex");
  const supervisor = startSupervisor(logs, controlToken);
  if (!supervisor.pid) throw new Error("The BEA demo supervisor did not return a PID.");
  const metadata = writeLaunchMetadata(supervisor.pid, controlToken, logs);
  supervisor.unref();

  try {
    const ready = await waitForSupervisorReady(supervisor.pid);
    recordInitialization(initialization.marker, shouldSeed);
    process.stdout.write("\nBEA Operations Command Center is ready in Demo Mode.\n");
    process.stdout.write(`Sign-in: ${signInUrl}\n`);
    process.stdout.write(`Supervisor PID: ${ready.metadata.supervisorPid}\n`);
    process.stdout.write(`Logs: ${formatRelativePath(logs.supervisor).replace(/\/[^/]+$/u, "")}\n`);
    process.stdout.write("All external providers remain SIMULATED; zero live connections.\n");
    if (!options.noOpen) openInDefaultBrowser(signInUrl);
    process.stdout.write("BEA_DEMO_START=PASS\n");
    return 0;
  } catch (error) {
    await cleanFailedLaunch(supervisor, metadata);
    const current = readValidatedMetadata();
    if (current.metadata?.supervisorPid === supervisor.pid && !processIsAlive(supervisor.pid)) {
      removeMetadataOwnedBy(metadata);
    }
    throw error;
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  process.exitCode = await startDemo(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    process.stderr.write(
      `BEA_DEMO_START=BLOCKED (${error instanceof Error ? error.message : "UnknownError"})\n`,
    );
    process.exitCode = 1;
  });
}
