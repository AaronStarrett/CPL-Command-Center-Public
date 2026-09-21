import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertProductionOwnerToolBoundary,
  checkPort,
  expectedNodeVersion,
  expectedPnpmVersion,
  findExecutable,
  inspectProductionEnvironment,
  inspectTrackedProduction,
  productionHost,
  redactSensitiveText,
  repositoryRoot,
  runExecutable,
  runPnpm,
} from "./production-owner-tools.mjs";

function addCheck(checks, name, status, detail, blocker = false) {
  checks.push({ blocker, detail, name, status });
}

function firstOutputLine(result) {
  return (result.stdout || result.stderr).split(/\r?\n/u).find(Boolean) ?? "no version output";
}

function exactNodeVersion(version) {
  return version.replace(/^v/u, "") === expectedNodeVersion;
}

export async function collectProductionDoctorReport(options = {}) {
  const checks = [];
  const environment = options.environment ?? process.env;
  const boundary = (options.assertBoundary ?? assertProductionOwnerToolBoundary)();
  addCheck(checks, "Repository boundary", "PASS", boundary.current);

  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const windows = platform === "win32";
  addCheck(
    checks,
    "Windows",
    windows ? "PASS" : "BLOCKED",
    windows ? `${platform} ${architecture}` : `unsupported platform ${platform}`,
    !windows,
  );

  const nodeVersion = options.nodeVersion ?? process.version;
  const supportedNode = exactNodeVersion(nodeVersion);
  addCheck(
    checks,
    "Node",
    supportedNode ? "PASS" : "BLOCKED",
    supportedNode
      ? `${nodeVersion} matches the verified production runtime`
      : `exact Node ${expectedNodeVersion} is required; received ${nodeVersion}`,
    !supportedNode,
  );

  const pnpmCommand =
    options.pnpmCommand ??
    findExecutable(platform === "win32" ? ["pnpm.cmd"] : ["pnpm"], { environment });
  let pnpmVersion;
  if (!pnpmCommand) {
    addCheck(
      checks,
      "pnpm",
      "BLOCKED",
      "The verified pnpm executable was not found on PATH.",
      true,
    );
  } else {
    const result =
      options.pnpmVersionResult ?? runPnpm(pnpmCommand, ["--version"], { env: environment });
    pnpmVersion = result.exitCode === 0 ? firstOutputLine(result) : undefined;
    const supportedPnpm = pnpmVersion === expectedPnpmVersion;
    addCheck(
      checks,
      "pnpm",
      supportedPnpm ? "PASS" : "BLOCKED",
      supportedPnpm
        ? `${pnpmVersion} matches the pinned package manager`
        : `exact pnpm ${expectedPnpmVersion} is required; received ${pnpmVersion ?? "unavailable"}`,
      !supportedPnpm,
    );
  }

  const gitCommand =
    options.gitCommand ??
    findExecutable(platform === "win32" ? ["git.exe", "git.cmd"] : ["git"], { environment });
  if (!gitCommand) {
    addCheck(checks, "Git", "BLOCKED", "Git was not found on PATH.", true);
  } else {
    const result =
      options.gitVersionResult ?? runExecutable(gitCommand, ["--version"], { env: environment });
    addCheck(
      checks,
      "Git",
      result.exitCode === 0 ? "PASS" : "BLOCKED",
      result.exitCode === 0 ? firstOutputLine(result) : "Git could not be executed.",
      result.exitCode !== 0,
    );
  }

  const fileExists = options.fileExists ?? existsSync;
  const dependenciesPresent = fileExists(join(repositoryRoot, "node_modules"));
  addCheck(
    checks,
    "Dependencies",
    dependenciesPresent ? "PASS" : "BLOCKED",
    dependenciesPresent
      ? "repository node_modules is present"
      : "repository node_modules is absent; run the frozen setup explicitly before production start",
    !dependenciesPresent,
  );

  const webBuildPresent = fileExists(join(repositoryRoot, "apps", "web", ".next", "BUILD_ID"));
  const workerBuildPresent = fileExists(join(repositoryRoot, "apps", "worker", "dist", "index.js"));
  addCheck(
    checks,
    "Production artifacts",
    webBuildPresent && workerBuildPresent ? "PASS" : "BLOCKED",
    webBuildPresent && workerBuildPresent
      ? "built web and worker entrypoints are present"
      : "run the verified production build before Start-BEA.cmd",
    !(webBuildPresent && workerBuildPresent),
  );

  const environmentReport = inspectProductionEnvironment(environment);
  for (const check of environmentReport.checks) checks.push(check);

  const tracked = await (options.inspectTracked ?? inspectTrackedProduction)();
  const ownedPorts = new Set();
  if (tracked.state === "running") {
    ownedPorts.add(tracked.metadata.webPort);
    ownedPorts.add(tracked.metadata.workerPort);
    ownedPorts.add(tracked.metadata.controlPort);
    addCheck(
      checks,
      "Tracked production runtime",
      "RUNNING",
      `authenticated supervisor PID ${tracked.metadata.supervisorPid}; state ${tracked.status.state}`,
    );
  } else if (tracked.state === "stopped") {
    addCheck(
      checks,
      "Tracked production runtime",
      "STOPPED",
      "no production owner-tool metadata is present",
    );
  } else if (tracked.state === "stale") {
    addCheck(
      checks,
      "Tracked production runtime",
      "BLOCKED",
      `stale metadata references stopped supervisor PID ${tracked.metadata.supervisorPid}; run Stop-BEA.cmd for safe cleanup`,
      true,
    );
  } else if (tracked.state === "invalid") {
    addCheck(checks, "Tracked production runtime", "BLOCKED", tracked.issues.join(" "), true);
  } else {
    addCheck(
      checks,
      "Tracked production runtime",
      "BLOCKED",
      `supervisor PID ${tracked.metadata.supervisorPid} is alive but did not authenticate; no process was inspected or terminated beyond the control handshake`,
      true,
    );
  }

  if (environmentReport.profile) {
    for (const [name, port] of [
      ["Web port", environmentReport.profile.webPort],
      ["Worker health port", environmentReport.profile.workerPort],
      ["Production control port", environmentReport.profile.controlPort],
    ]) {
      if (ownedPorts.has(port)) {
        addCheck(
          checks,
          name,
          "OWNED",
          `${port} is tracked by the authenticated BEA production supervisor`,
        );
        continue;
      }
      const result = await (options.checkPort ?? checkPort)(port);
      addCheck(
        checks,
        name,
        result.available ? "PASS" : "BLOCKED",
        result.available
          ? `${port} is available on ${productionHost}`
          : `${port} is occupied (${result.code ?? "UNKNOWN"})`,
        !result.available,
      );
    }
  } else {
    addCheck(
      checks,
      "Port availability",
      "NOT RUN",
      "production ports are not valid, so no bind probes were attempted",
    );
  }

  addCheck(
    checks,
    "PostgreSQL and pg-boss connectivity",
    "NOT RUN",
    "Doctor is read-only; exact launched web/worker readiness performs runtime connectivity checks",
  );
  addCheck(
    checks,
    "External provider and owner acceptance",
    "NOT RUN",
    "no provider request, paid operation, live voice session, or owner acceptance is performed",
  );

  return {
    blockers: checks.filter((check) => check.blocker),
    checks,
    environmentReport,
    gitCommand,
    pnpmCommand,
    tracked,
  };
}

export function printProductionDoctorReport(report) {
  process.stdout.write("BEA Operations Command Center - Production Doctor\n");
  process.stdout.write(
    "Read-only, fail-closed prerequisite check; no environment file, credential value, provider, database, or process is modified.\n\n",
  );
  for (const check of report.checks) {
    process.stdout.write(`[${check.status}] ${check.name}: ${check.detail}\n`);
  }
  process.stdout.write(
    `\nBEA_PRODUCTION_DOCTOR=${report.blockers.length === 0 ? "PASS" : "BLOCKED"}\n`,
  );
}

export async function runProductionDoctor(options = {}) {
  const report = await collectProductionDoctorReport(options);
  printProductionDoctorReport(report);
  return report.blockers.length === 0 ? 0 : 1;
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.some((argument) => argument !== "--check")) {
    throw new Error("Usage: node scripts/phase133/production-preflight.mjs [--check]");
  }
  process.exitCode = await runProductionDoctor();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    const message = redactSensitiveText(error instanceof Error ? error.message : "UnknownError");
    process.stderr.write(`BEA_PRODUCTION_DOCTOR=BLOCKED (${message})\n`);
    process.exitCode = 1;
  });
}
