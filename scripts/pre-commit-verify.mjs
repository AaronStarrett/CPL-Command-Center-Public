import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertRepositoryBoundary, targetForEnvironment } from "./repository-boundary.mjs";
import {
  assertLocalLauncherStopped,
  createSafeEnvironment,
  prepareDirectories,
} from "./cpl-local.mjs";

import { synchronizeWorkspaceCopies } from "./cpl-workspace-copies.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const normalizedRoot = repositoryRoot.replaceAll("\\", "/");
// This selects SSD-local cache settings only; runPrecommitVerification always
// validates the exact checkout, stable identity, and origin before any execution.
const localSsdCheckout =
  process.platform === "win32" && normalizedRoot.toLowerCase().startsWith("d:/cyber pirate labs/");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const PHASE135_PRECOMMIT_UNIT = Object.freeze([
  "tests/unit/phase135-architecture-contracts.test.ts",
  "tests/unit/phase135-deployment-scaffolding.test.mjs",
  "tests/unit/phase135-history-security.test.mjs",
  "tests/unit/phase135-verifier.test.mjs",
  "tests/unit/hosted-actions-precommit.test.mjs",
]);

export function buildPrecommitSteps(platform = process.platform) {
  const steps = [
    ["repository-boundary", process.execPath, ["scripts/repository-boundary.mjs"]],
    ["source-integrity", pnpm, ["source:verify"]],
    ["format-check", pnpm, ["format:check"]],
    ["lint", pnpm, ["lint"]],
    ["typecheck", pnpm, ["typecheck"]],
    [
      "phase135-and-parking-contracts",
      pnpm,
      ["exec", "vitest", "run", ...PHASE135_PRECOMMIT_UNIT, "--config", "vitest.unit.config.ts"],
    ],
    ["verify-phase2.0", pnpm, ["verify:phase2.0"]],
    ["verify-phase2.1", pnpm, ["verify:phase2.1"]],
    ["verify-phase2.2", pnpm, ["verify:phase2.2"]],
    ["verify-phase2.3", pnpm, ["verify:phase2.3"]],
    ["verify-phase3.0", pnpm, ["verify:phase3.0"]],
    ["verify-phase3.1a", pnpm, ["verify:phase3.1a"]],
    ["verify-phase3.2a", pnpm, ["verify:phase3.2a"]],
    ["verify-phase3.3a", pnpm, ["verify:phase3.3a"]],
    ["verify-phase3.4a", pnpm, ["verify:phase3.4a"]],
    ["secret-scan", pnpm, ["security:secrets"]],
    ["inventory", pnpm, ["inventory:verify"]],
  ];
  if (platform === "win32") {
    steps.splice(6, 0, [
      "phase135-local-storage-audit",
      pnpm,
      [
        "exec",
        "vitest",
        "run",
        "tests/unit/phase135-local-storage-audit.test.mjs",
        "--config",
        "vitest.unit.config.ts",
      ],
    ]);
  }
  return Object.freeze(steps);
}

export const PRECOMMIT_STEPS = buildPrecommitSteps();

const inheritedKeys = Object.freeze([
  "APPDATA",
  "ComSpec",
  "COMSPEC",
  "HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "NO_PROXY",
  "NUMBER_OF_PROCESSORS",
  "Path",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "ProgramFiles",
  "SystemDrive",
  "SystemRoot",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "PNPM_HOME",
  "npm_config_cache",
  "COREPACK_HOME",
  "PLAYWRIGHT_BROWSERS_PATH",
  "USERPROFILE",
  "WINDIR",
]);

export function createPrecommitEnvironment(source = process.env) {
  const environment = localSsdCheckout ? createSafeEnvironment(repositoryRoot, source) : {};
  if (!localSsdCheckout)
    for (const key of inheritedKeys) {
      if (source[key] !== undefined) environment[key] = source[key];
    }
  const inheritedPath = environment.Path ?? environment.PATH ?? "";
  delete environment.Path;
  delete environment.PATH;
  environment[process.platform === "win32" ? "Path" : "PATH"] =
    path.dirname(process.execPath) + path.delimiter + inheritedPath;
  return {
    ...environment,
    APP_MODE: "demo",
    BEA_DISABLE_ENV_FILE: "true",
    BEA_REPOSITORY_ROOT: localSsdCheckout
      ? repositoryRoot
      : source.BEA_REPOSITORY_ROOT || repositoryRoot,
    BEA_RUNTIME_MODE: "development",
    NODE_ENV: "test",
    DATABASE_DRIVER: "pglite",
    DEMO_AUTH_ENABLED: "true",
    FORCE_COLOR: "0",
    LOG_LEVEL: "silent",
    NEXT_TELEMETRY_DISABLED: "1",
    OPENAI_API_KEY: "",
    TURBO_TELEMETRY_DISABLED: "1",
    WORKER_DEMO_DATABASE_PATH: "memory://",
  };
}

function invocationFor(command, arguments_, environment) {
  if (process.platform === "win32" && command.toLowerCase().endsWith(".cmd")) {
    return {
      executable: environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe",
      arguments: ["/d", "/s", "/c", command, ...arguments_],
    };
  }
  return { executable: command, arguments: arguments_ };
}

export function runPrecommitStep(label, command, arguments_, options = {}) {
  const environment = createPrecommitEnvironment(options.environment ?? process.env);
  const invocation = invocationFor(command, arguments_, environment);
  process.stdout.write("BEA_PRECOMMIT_START=" + label + "\n");
  const result = (options.spawnSync ?? spawnSync)(invocation.executable, invocation.arguments, {
    cwd: repositoryRoot,
    env: environment,
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  });
  const exitCode = result.status ?? 1;
  if (result.error || result.signal || exitCode !== 0) {
    process.stderr.write("BEA_PRECOMMIT_FAIL=" + label + " exit=" + String(exitCode) + "\n");
    throw new Error("Pre-commit suite failed at " + label);
  }
  process.stdout.write("BEA_PRECOMMIT_PASS=" + label + "\n");
  return exitCode;
}

export async function runPrecommitVerification(options = {}) {
  const environment = createPrecommitEnvironment(options.environment ?? process.env);
  assertRepositoryBoundary({
    cwd: repositoryRoot,
    target: targetForEnvironment(environment),
  });
  if (localSsdCheckout) {
    await assertLocalLauncherStopped(repositoryRoot);
    prepareDirectories(repositoryRoot);
  }
  process.stdout.write(
    "BEA_PRECOMMIT=START root=" +
      normalizedRoot +
      " steps=" +
      String(PRECOMMIT_STEPS.length) +
      "\n",
  );
  synchronizeWorkspaceCopies();
  for (const [label, command, arguments_] of PRECOMMIT_STEPS) {
    runPrecommitStep(label, command, arguments_, { environment });
  }
  process.stdout.write("BEA_PRECOMMIT=PASS\n");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runPrecommitVerification();
  } catch (error) {
    process.stderr.write(String(error instanceof Error ? error.message : error) + "\n");
    process.exitCode = 1;
  }
}
