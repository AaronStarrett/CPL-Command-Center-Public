import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertOwnerToolBoundary,
  checkPort,
  controlPort,
  findExecutable,
  inspectDemoEnvironment,
  inspectTrackedDemo,
  repositoryRoot,
  runExecutable,
  runPnpm,
  webPort,
  workerPort,
} from "./owner-tools-common.mjs";

function addCheck(checks, name, status, detail, blocker = false) {
  checks.push({ blocker, detail, name, status });
}

function nodeVersionSupported() {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/u.exec(process.version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 20 || (major === 20 && minor >= 9);
}

function firstOutputLine(result) {
  return (result.stdout || result.stderr).split(/\r?\n/u).find(Boolean) ?? "no version output";
}

export async function collectDoctorReport(options = {}) {
  const checks = [];
  const boundary = assertOwnerToolBoundary();
  addCheck(checks, "Repository", "PASS", boundary.current);

  const windows = process.platform === "win32";
  addCheck(
    checks,
    "Windows",
    windows ? "PASS" : "BLOCKED",
    windows ? `${process.platform} ${process.arch}` : `unsupported platform ${process.platform}`,
    !windows,
  );

  const supportedNode = nodeVersionSupported();
  addCheck(
    checks,
    "Node",
    supportedNode ? "PASS" : "BLOCKED",
    `${process.version} at ${process.execPath}`,
    !supportedNode,
  );

  const pnpmCommand = findExecutable(["pnpm.cmd"]);
  if (!pnpmCommand) {
    addCheck(checks, "pnpm.cmd", "BLOCKED", "pnpm.cmd was not found on PATH.", true);
  } else {
    const result = runPnpm(pnpmCommand, ["--version"]);
    addCheck(
      checks,
      "pnpm.cmd",
      result.exitCode === 0 ? "PASS" : "BLOCKED",
      result.exitCode === 0
        ? `${firstOutputLine(result)} at ${pnpmCommand}`
        : `could not run pnpm.cmd (${firstOutputLine(result)})`,
      result.exitCode !== 0,
    );
  }

  const gitCommand = findExecutable(["git.exe", "git.cmd"]);
  if (!gitCommand) {
    addCheck(checks, "Git", "BLOCKED", "Git was not found on PATH.", true);
  } else {
    const result = runExecutable(gitCommand, ["--version"]);
    addCheck(
      checks,
      "Git",
      result.exitCode === 0 ? "PASS" : "BLOCKED",
      result.exitCode === 0
        ? `${firstOutputLine(result)} at ${gitCommand}`
        : `could not run Git (${firstOutputLine(result)})`,
      result.exitCode !== 0,
    );
  }

  const dependenciesPresent = existsSync(join(repositoryRoot, "node_modules"));
  const missingDependenciesBlock = !dependenciesPresent && !options.allowMissingDependencies;
  addCheck(
    checks,
    "Dependencies",
    dependenciesPresent ? "PASS" : missingDependenciesBlock ? "BLOCKED" : "NEEDS_INSTALL",
    dependenciesPresent
      ? "repository node_modules is present"
      : "repository node_modules is absent; Start-BEA-Demo.cmd can perform one frozen install",
    missingDependenciesBlock,
  );

  const environment = inspectDemoEnvironment();
  addCheck(
    checks,
    "Environment",
    environment.issues.length === 0 ? "PASS" : "BLOCKED",
    environment.localEnvironmentExists
      ? ".env.local is compatible with the fixed owner demo profile"
      : "safe launcher defaults will be used because .env.local is absent",
    environment.issues.length > 0,
  );
  for (const issue of environment.issues) {
    addCheck(checks, "Environment detail", "BLOCKED", issue, true);
  }
  for (const warning of environment.warnings) {
    addCheck(checks, "Environment detail", "NOTE", warning);
  }
  addCheck(
    checks,
    "Database mode",
    "PASS",
    "PGlite repository-local Demo Mode; inline queue; zero live connections",
  );

  const tracked = await inspectTrackedDemo();
  const ownedPorts = new Set();
  if (tracked.state === "running") {
    ownedPorts.add(webPort);
    ownedPorts.add(workerPort);
    ownedPorts.add(controlPort);
    addCheck(
      checks,
      "Tracked demo",
      "RUNNING",
      `authenticated supervisor PID ${tracked.metadata.supervisorPid}; state ${tracked.status.state}`,
    );
  } else if (tracked.state === "stopped") {
    addCheck(checks, "Tracked demo", "STOPPED", "no owner-tool metadata is present");
  } else if (tracked.state === "stale") {
    addCheck(
      checks,
      "Tracked demo",
      "BLOCKED",
      `stale metadata references stopped supervisor PID ${tracked.metadata.supervisorPid}; run Stop-BEA-Demo.cmd for safe cleanup`,
      true,
    );
  } else if (tracked.state === "invalid") {
    addCheck(checks, "Tracked demo", "BLOCKED", tracked.issues.join(" "), true);
  } else {
    addCheck(
      checks,
      "Tracked demo",
      "BLOCKED",
      `supervisor PID ${tracked.metadata.supervisorPid} is alive but did not authenticate on the control endpoint`,
      true,
    );
  }

  for (const [name, port] of [
    ["Web port", webPort],
    ["Worker health port", workerPort],
    ["Control port", controlPort],
  ]) {
    if (ownedPorts.has(port)) {
      addCheck(
        checks,
        name,
        "OWNED",
        `${port} is tracked by the authenticated BEA demo supervisor`,
      );
      continue;
    }
    const result = await checkPort(port);
    addCheck(
      checks,
      name,
      result.available ? "PASS" : "BLOCKED",
      result.available
        ? `${port} is available on 127.0.0.1`
        : `${port} is occupied (${result.code})`,
      !result.available,
    );
  }

  return {
    blockers: checks.filter((check) => check.blocker),
    checks,
    environment,
    gitCommand,
    pnpmCommand,
    tracked,
  };
}

export function printDoctorReport(report) {
  process.stdout.write("BEA Operations Command Center - Owner Doctor\n");
  process.stdout.write(
    "Read-only prerequisite check; no software is installed and no settings are changed.\n\n",
  );
  for (const check of report.checks) {
    process.stdout.write(`[${check.status}] ${check.name}: ${check.detail}\n`);
  }
  process.stdout.write(`\nBEA_DOCTOR=${report.blockers.length === 0 ? "PASS" : "BLOCKED"}\n`);
}

export async function runDoctor(options = {}) {
  const report = await collectDoctorReport(options);
  printDoctorReport(report);
  return report.blockers.length === 0 ? 0 : 1;
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.some((argument) => argument !== "--check")) {
    throw new Error("Usage: node scripts/bea-doctor.mjs [--check]");
  }
  process.exitCode = await runDoctor();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    process.stderr.write(
      `BEA_DOCTOR=BLOCKED (${error instanceof Error ? error.message : "UnknownError"})\n`,
    );
    process.exitCode = 1;
  });
}
