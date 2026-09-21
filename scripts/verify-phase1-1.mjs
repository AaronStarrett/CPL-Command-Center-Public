import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";

const verifierScriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(verifierScriptPath), "..");
const normalizedRoot = repositoryRoot.replaceAll("\\", "/");
const phase1StartingCommit = "8169bbda6be188c6cff189e11a0631b82b48d372";
const isWindows = process.platform === "win32";
const pnpm = isWindows ? "pnpm.cmd" : "pnpm";
const require = createRequire(import.meta.url);
const playwrightCliPath = require.resolve("@playwright/test/cli");
const forbiddenWarningOutput = ["MaxListenersExceededWarning"];
const warningSuppressingNodeOptions = [
  "--disable-warning",
  "--no-deprecation",
  "--no-warnings",
  "--redirect-warnings",
];
const ansiEscapePattern = new RegExp(String.raw`\u001b\[[0-?]*[ -/]*[@-~]`, "gu");
const requestedMode = process.argv[2];
const e2eRunnerMode = ["--prepared-e2e", "--production-e2e"].includes(requestedMode)
  ? requestedMode
  : null;
const skipEndToEnd = process.argv.includes("--skip-e2e");
const skipOwnerLauncher = process.argv.includes("--skip-owner-launcher");
const allowedArguments = new Set(["--skip-e2e", "--skip-owner-launcher"]);

function createWarningVisibleEnvironment(baseEnvironment, overrides = {}) {
  const environment = { ...baseEnvironment, ...overrides };
  const nodeOptionsEntries = Object.entries(environment).filter(
    ([key]) => key.toUpperCase() === "NODE_OPTIONS",
  );
  const nodeOptions = [
    ...new Set(nodeOptionsEntries.map(([, value]) => value).filter(Boolean)),
  ].join(" ");
  const blockedNodeOption = warningSuppressingNodeOptions.find((option) =>
    nodeOptions.toLowerCase().includes(option),
  );
  if (blockedNodeOption) {
    throw new Error(`Warning-suppressing NODE_OPTIONS are forbidden: ${blockedNodeOption}`);
  }

  const keysToDelete = new Set([
    "NODE_NO_WARNINGS",
    "NODE_OPTIONS",
    "NODE_REDIRECT_WARNINGS",
    "NO_COLOR",
  ]);
  for (const key of Object.keys(environment)) {
    if (keysToDelete.has(key.toUpperCase())) delete environment[key];
  }
  environment.FORCE_COLOR = "0";
  environment.NODE_OPTIONS = nodeOptions.includes("--trace-warnings")
    ? nodeOptions
    : [nodeOptions, "--trace-warnings"].filter(Boolean).join(" ");
  return environment;
}

function writeCapturedOutput(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function outputForInspection(value) {
  return value.replace(ansiEscapePattern, "");
}

function runCapturedCommand(command, args, environment) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: environment,
    encoding: "utf8",
    shell: isWindows && (command.endsWith(".cmd") || command === pnpm),
    stdio: "pipe",
    maxBuffer: 32 * 1024 * 1024,
  });
  writeCapturedOutput(result);
  const combinedOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const inspectedOutput = outputForInspection(combinedOutput);
  const forbiddenMatch = forbiddenWarningOutput.find((value) => inspectedOutput.includes(value));
  if (forbiddenMatch) {
    console.error(`Forbidden verifier output detected: ${forbiddenMatch}`);
    return { exitCode: 1, output: inspectedOutput };
  }
  return { exitCode: result.status ?? 1, output: inspectedOutput };
}

function normalizeE2ERunnerArguments(rawArguments) {
  const argumentsToNormalize = [...rawArguments];
  while (argumentsToNormalize[0] === "--") argumentsToNormalize.shift();

  let expectedTestCount;
  const normalized = [];
  for (let index = 0; index < argumentsToNormalize.length; index += 1) {
    const argument = argumentsToNormalize[index];
    if (argument.startsWith("--expected-test-count=")) {
      expectedTestCount = Number(argument.slice("--expected-test-count=".length));
      continue;
    }
    if (argument === "--expected-test-count") {
      expectedTestCount = Number(argumentsToNormalize[index + 1]);
      index += 1;
      continue;
    }
    normalized.push(argument);
  }

  if (expectedTestCount !== undefined && !Number.isSafeInteger(expectedTestCount)) {
    throw new Error("--expected-test-count must be a positive integer.");
  }
  if (expectedTestCount !== undefined && expectedTestCount < 1) {
    throw new Error("--expected-test-count must be a positive integer.");
  }
  const hasFocusedGrep = normalized.some(
    (argument) => argument === "--grep" || argument === "-g" || argument.startsWith("--grep="),
  );
  return {
    args: normalized,
    expectedTestCount: expectedTestCount ?? (hasFocusedGrep ? 1 : undefined),
  };
}

function parseDiscoveredTestCount(output) {
  const match = output.match(/Total:\s+(\d+)\s+tests?\s+in\b/u);
  return match ? Number(match[1]) : null;
}

function parsePassedTestCount(output) {
  const matches = [...output.matchAll(/^\s*(\d+)\s+passed\b/gmu)];
  return matches.length > 0 ? Number(matches.at(-1)[1]) : null;
}

function runPreparedE2E(rawArguments, buildFirst) {
  const environment = createWarningVisibleEnvironment(process.env);
  const { args, expectedTestCount } = normalizeE2ERunnerArguments(rawArguments);

  if (buildFirst) {
    const build = runCapturedCommand(pnpm, ["build"], environment);
    if (build.exitCode !== 0) return build.exitCode;
  }

  const listOnly = args.includes("--list");
  const discovery = runCapturedCommand(
    process.execPath,
    [playwrightCliPath, "test", ...args, ...(listOnly ? [] : ["--list"])],
    environment,
  );
  if (discovery.exitCode !== 0) return discovery.exitCode;
  const discoveredTestCount = parseDiscoveredTestCount(discovery.output);
  if (!discoveredTestCount) {
    console.error("Playwright discovery did not report a positive test count.");
    return 1;
  }
  if (expectedTestCount !== undefined && discoveredTestCount !== expectedTestCount) {
    console.error(
      `Playwright discovery count mismatch: expected ${expectedTestCount}, discovered ${discoveredTestCount}.`,
    );
    return 1;
  }
  if (listOnly) return 0;

  const execution = runCapturedCommand(
    process.execPath,
    [playwrightCliPath, "test", ...args],
    environment,
  );
  if (execution.exitCode !== 0) return execution.exitCode;
  const passedTestCount = parsePassedTestCount(execution.output);
  if (passedTestCount !== discoveredTestCount) {
    console.error(
      `Playwright execution count mismatch: discovered ${discoveredTestCount}, passed ${passedTestCount ?? 0}.`,
    );
    return 1;
  }
  return 0;
}

if (e2eRunnerMode) {
  process.exit(runPreparedE2E(process.argv.slice(3), e2eRunnerMode === "--production-e2e"));
}

for (const argument of process.argv.slice(2)) {
  if (!allowedArguments.has(argument)) {
    throw new Error("Usage: node scripts/verify-phase1-1.mjs [--skip-e2e] [--skip-owner-launcher]");
  }
}

const verificationEnvironment = createWarningVisibleEnvironment(process.env, {
  APP_MODE: "demo",
  APP_BASE_URL: "http://127.0.0.1:3000",
  DATABASE_DRIVER: "pglite",
  DEMO_DATABASE_PATH: ".data/phase1-1-verification",
  WORKER_DEMO_DATABASE_PATH: "memory://",
  DEMO_AUTH_ENABLED: "true",
  SESSION_TTL_MINUTES: "480",
  WORKER_MODE: "once",
  WORKER_QUEUE_ADAPTER: "inline",
  WORKER_POLL_INTERVAL_MS: "60000",
  WORKER_HEALTH_PORT: "33101",
  LOG_LEVEL: "silent",
  DEMO_RESET_CONFIRMATION: "RESET_BEA_DEMO_DATA",
});
const warningCheckedOptions = {
  capture: true,
  forbiddenOutput: forbiddenWarningOutput,
};

const gateDefinitions = [
  [1, "Repository boundary"],
  [2, "Starting-commit verification"],
  [3, "Source-asset integrity"],
  [4, "Frozen dependency installation"],
  [5, "Formatting"],
  [6, "Format check"],
  [7, "Lint"],
  [8, "Type checking"],
  [9, "Unit tests"],
  [10, "Component tests"],
  [11, "Integration tests"],
  [12, "Database migration"],
  [13, "Repeatable seed"],
  [14, "Demo reset safety"],
  [15, "Resizable-pane tests"],
  [16, "Pane-persistence tests"],
  [17, "Orb-state tests"],
  [18, "Full-motion-default tests"],
  [19, "Global-motion tests"],
  [20, "Workspace-transition tests"],
  [21, "Stale-response tests"],
  [22, "Company-dependent Contact tests"],
  [23, "Company/Contact server-validation tests"],
  [24, "Administration-matrix tests"],
  [25, "Listener-lifecycle tests"],
  [26, "Five-persona acceptance"],
  [27, "Web build"],
  [28, "Worker build"],
  [29, "Full monorepo build"],
  [30, "Built web startup"],
  [31, "Worker startup"],
  [32, "Health checks"],
  [33, "Full end-to-end tests"],
  [34, "Windows doctor regression"],
  [35, "Windows start regression"],
  [36, "Windows stop regression"],
  [37, "Dependency audit"],
  [38, "Secret scan"],
  [39, "Inventory reconciliation"],
  [40, "Staged-diff check"],
  [41, "Git status"],
];

const results = gateDefinitions.map(([number, name]) => ({
  number,
  name,
  result: "PENDING",
  exitCode: null,
  detail: "",
}));

let databaseBoundaryStarted = false;
let ownerLauncherAttempted = false;
let ownerLauncherStopped = false;
let productionBrowserBuildReady = false;
let terminalFailure;
let terminalBlock;

class RequiredGateBlockedError extends Error {}

function resultFor(number) {
  const result = results.find((entry) => entry.number === number);
  if (!result) throw new Error(`Unknown Phase 1.1 gate ${number}.`);
  return result;
}

function record(number, result, exitCode, detail = "") {
  Object.assign(resultFor(number), { result, exitCode, detail });
}

function execute(command, args, options = {}) {
  const focusedVitest = args.includes("vitest") && args.includes("-t");
  const executionEnvironment = createWarningVisibleEnvironment(
    verificationEnvironment,
    options.environment,
  );
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: executionEnvironment,
    encoding: "utf8",
    shell: isWindows && (command.endsWith(".cmd") || command === pnpm),
    stdio: "pipe",
    maxBuffer: 32 * 1024 * 1024,
  });
  writeCapturedOutput(result);
  const combinedOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const inspectedOutput = outputForInspection(combinedOutput);
  if (focusedVitest && !/\b[1-9]\d*\s+passed\b/u.test(inspectedOutput)) {
    console.error("Focused Vitest gate did not report an executed passing test.");
    return 1;
  }
  const forbiddenValues = new Set([...forbiddenWarningOutput, ...(options.forbiddenOutput ?? [])]);
  const forbiddenMatch = [...forbiddenValues].find((value) => inspectedOutput.includes(value));
  if (forbiddenMatch) {
    console.error(`Forbidden verifier output detected: ${forbiddenMatch}`);
    return 1;
  }
  return result.status ?? 1;
}

function commandGate(number, command, args, options = {}) {
  const { name } = resultFor(number);
  console.log(`\n==> ${number}. ${name}`);
  const exitCode = execute(command, args, options);
  record(number, exitCode === 0 ? "PASS" : "FAIL", exitCode);
  if (exitCode !== 0) throw new Error(`${name} failed with exit code ${exitCode}.`);
}

function customGate(number, callback) {
  const { name } = resultFor(number);
  console.log(`\n==> ${number}. ${name}`);
  const exitCode = callback();
  record(number, exitCode === 0 ? "PASS" : "FAIL", exitCode);
  if (exitCode !== 0) throw new Error(`${name} failed with exit code ${exitCode}.`);
}

function blockedGate(number, detail) {
  const { name } = resultFor(number);
  console.log(`\n==> ${number}. ${name}: BLOCKED (${detail})`);
  record(number, "BLOCKED", null, detail);
  throw new RequiredGateBlockedError(`${name} is required but was not run: ${detail}.`);
}

function pnpmGate(number, ...args) {
  commandGate(number, pnpm, args);
}

function vitestGate(number, config, pattern, files = [], options = {}) {
  commandGate(
    number,
    pnpm,
    ["exec", "vitest", "run", "--config", config, ...files, "-t", pattern],
    options,
  );
}

function executeSequence(steps) {
  for (const step of steps) {
    const exitCode = step.callback
      ? step.callback()
      : execute(step.command, step.args, step.options);
    if (exitCode !== 0) return exitCode;
  }
  return 0;
}

function ensureProductionBrowserBuild() {
  if (productionBrowserBuildReady) return 0;

  console.log("Preparing the production browser harness with one prerequisite build.");
  const exitCode = execute(pnpm, ["build"]);
  if (exitCode === 0) productionBrowserBuildReady = true;
  return exitCode;
}

function executeProductionBrowser(args, options = {}) {
  const buildExitCode = ensureProductionBrowserBuild();
  if (buildExitCode !== 0) return buildExitCode;
  return execute(
    process.execPath,
    [verifierScriptPath, "--prepared-e2e", "--expected-test-count=1", ...args],
    options,
  );
}

try {
  commandGate(1, "node", ["scripts/repository-boundary.mjs"]);
  customGate(2, () =>
    executeSequence([
      {
        command: "git",
        args: [
          "-c",
          `safe.directory=${normalizedRoot}`,
          "cat-file",
          "-e",
          `${phase1StartingCommit}^{commit}`,
        ],
      },
      {
        command: "git",
        args: [
          "-c",
          `safe.directory=${normalizedRoot}`,
          "merge-base",
          "--is-ancestor",
          phase1StartingCommit,
          "HEAD",
        ],
      },
    ]),
  );
  pnpmGate(3, "source:verify");
  commandGate(4, pnpm, ["install", "--frozen-lockfile"]);
  pnpmGate(5, "format");
  pnpmGate(6, "format:check");
  pnpmGate(7, "lint");
  pnpmGate(8, "typecheck");
  pnpmGate(9, "test:unit");
  pnpmGate(10, "test:component");
  pnpmGate(11, "test:integration");

  customGate(12, () => {
    const start = execute(pnpm, ["db:start"]);
    if (start !== 0) return start;
    databaseBoundaryStarted = true;
    return execute(pnpm, ["db:migrate"]);
  });
  customGate(13, () =>
    executeSequence([
      { command: pnpm, args: ["db:seed"] },
      { command: pnpm, args: ["db:seed"] },
    ]),
  );
  customGate(14, () =>
    executeSequence([
      { command: pnpm, args: ["demo:reset"] },
      { command: pnpm, args: ["db:seed"] },
    ]),
  );

  vitestGate(
    15,
    "vitest.component.config.ts",
    "resizes the AI split with pointer and accessible keyboard controls",
    ["tests/component/phase11-motion.test.tsx"],
  );
  vitestGate(
    16,
    "vitest.component.config.ts",
    "persists the user-keyed pane width and restores it",
    ["tests/component/phase11-motion.test.tsx"],
  );
  vitestGate(
    17,
    "vitest.component.config.ts",
    "publishes every required BEA orb state and integrated simulated voice flow",
    ["tests/component/phase11-motion.test.tsx"],
  );
  customGate(18, () =>
    executeSequence([
      {
        command: pnpm,
        args: [
          "exec",
          "vitest",
          "run",
          "--config",
          "vitest.component.config.ts",
          "tests/component/phase11-motion.test.tsx",
          "-t",
          "defaults to Full Motion and persists an explicit reduced preference",
        ],
      },
      {
        command: pnpm,
        args: [
          "exec",
          "vitest",
          "run",
          "--config",
          "vitest.component.config.ts",
          "tests/component/phase11-motion.test.tsx",
          "-t",
          "preserves prepaint reduced motion and pauses ambient surfaces for an owned busy load",
        ],
      },
    ]),
  );
  if (skipEndToEnd) {
    blockedGate(19, "--skip-e2e was supplied");
  } else {
    customGate(19, () => {
      const buildExitCode = ensureProductionBrowserBuild();
      if (buildExitCode !== 0) return buildExitCode;
      const componentExitCode = execute(pnpm, [
        "exec",
        "vitest",
        "run",
        "--config",
        "vitest.component.config.ts",
        "tests/component/phase11-motion.test.tsx",
        "-t",
        "defines shared glass motion tokens and pauses motion while hidden",
      ]);
      if (componentExitCode !== 0) return componentExitCode;
      return executeProductionBrowser(
        ["--grep", "Phase 1.1 global motion surfaces", "--workers=1"],
        warningCheckedOptions,
      );
    });
  }
  vitestGate(
    20,
    "vitest.component.config.ts",
    "keeps the current workspace visible until the staged replacement is ready",
    ["tests/component/phase11-motion.test.tsx"],
  );
  customGate(21, () =>
    executeSequence([
      {
        command: pnpm,
        args: [
          "exec",
          "vitest",
          "run",
          "--config",
          "vitest.component.config.ts",
          "tests/component/phase11-motion.test.tsx",
          "-t",
          "aborts a superseded client request and accepts only the latest generated response",
        ],
      },
      {
        command: pnpm,
        args: [
          "exec",
          "vitest",
          "run",
          "--config",
          "vitest.component.config.ts",
          "tests/component/phase11-motion.test.tsx",
          "-t",
          "ignores delayed JSON from an older request after a newer request starts",
        ],
      },
      {
        command: pnpm,
        args: [
          "exec",
          "vitest",
          "run",
          "--config",
          "vitest.component.config.ts",
          "tests/component/phase11-motion.test.tsx",
          "-t",
          "makes a reserved prior task preview non-actionable when message processing fails",
        ],
      },
      {
        command: pnpm,
        args: [
          "exec",
          "vitest",
          "run",
          "--config",
          "vitest.component.config.ts",
          "tests/component/phase11-motion.test.tsx",
          "-t",
          "keeps a preview non-actionable when a stale reservation succeeds before the current reservation fails",
        ],
      },
      {
        command: pnpm,
        args: [
          "exec",
          "vitest",
          "run",
          "--config",
          "vitest.component.config.ts",
          "tests/component/phase11-motion.test.tsx",
          "-t",
          "invalidates a preview before a stale successful reservation body settles when the current reservation fails",
        ],
      },
      {
        command: pnpm,
        args: [
          "exec",
          "vitest",
          "run",
          "--config",
          "vitest.integration.config.ts",
          "tests/integration/phase1-database.test.ts",
          "-t",
          "supersedes older AI Command generations and makes prior previews unexecutable",
        ],
      },
      {
        command: pnpm,
        args: [
          "exec",
          "vitest",
          "run",
          "--config",
          "vitest.integration.config.ts",
          "tests/integration/phase1-database.test.ts",
          "-t",
          "keeps a delayed older reservation stale after the newer request begins",
        ],
      },
      {
        command: pnpm,
        args: [
          "exec",
          "vitest",
          "run",
          "--config",
          "vitest.integration.config.ts",
          "tests/integration/server-runtime.test.ts",
          "-t",
          "keeps delayed older submission from replacing newer reserved AI state",
        ],
      },
      {
        command: pnpm,
        args: [
          "exec",
          "vitest",
          "run",
          "--config",
          "vitest.integration.config.ts",
          "tests/integration/server-runtime.test.ts",
          "-t",
          "redacts historical entity turns and blocks linked task execution after permission revocation",
        ],
      },
      {
        command: pnpm,
        args: [
          "exec",
          "vitest",
          "run",
          "--config",
          "vitest.integration.config.ts",
          "tests/integration/server-runtime.test.ts",
          "-t",
          "does not replace a newer reserved generation with task execution presentation",
        ],
      },
    ]),
  );
  customGate(22, () =>
    executeSequence([
      {
        command: pnpm,
        args: [
          "exec",
          "vitest",
          "run",
          "--config",
          "vitest.component.config.ts",
          "tests/component/task-create-form.test.tsx",
          "-t",
          "loads only contacts for the selected company and clears an incompatible selection",
        ],
      },
      {
        command: pnpm,
        args: [
          "exec",
          "vitest",
          "run",
          "--config",
          "vitest.component.config.ts",
          "tests/component/task-create-form.test.tsx",
          "-t",
          "uses an explicit reduced-aware contact state transition contract",
        ],
      },
      {
        command: pnpm,
        args: [
          "exec",
          "vitest",
          "run",
          "--config",
          "vitest.integration.config.ts",
          "tests/integration/server-runtime.test.ts",
          "-t",
          "enforces permission-aware company-scoped minimal contact options without full-list leakage",
        ],
      },
    ]),
  );
  customGate(23, () =>
    executeSequence([
      {
        command: pnpm,
        args: [
          "exec",
          "vitest",
          "run",
          "--config",
          "vitest.integration.config.ts",
          "tests/integration/phase1-database.test.ts",
          "-t",
          "rejects invalid company-contact task relationships without success evidence",
        ],
      },
      {
        command: pnpm,
        args: [
          "exec",
          "vitest",
          "run",
          "--config",
          "vitest.integration.config.ts",
          "tests/integration/phase1-database.test.ts",
          "-t",
          "revalidates the company-contact relationship during confirmed AI execution",
        ],
      },
      {
        command: pnpm,
        args: [
          "exec",
          "vitest",
          "run",
          "--config",
          "vitest.integration.config.ts",
          "tests/integration/server-runtime.test.ts",
          "-t",
          "rejects mismatched AI task contacts without creating an action or success evidence",
        ],
      },
    ]),
  );
  if (skipEndToEnd) {
    blockedGate(24, "--skip-e2e was supplied");
  } else {
    customGate(24, () =>
      executeSequence([
        {
          command: pnpm,
          args: [
            "exec",
            "vitest",
            "run",
            "--config",
            "vitest.unit.config.ts",
            "tests/unit/rbac.test.ts",
            "-t",
            "matches the owner-approved Phase 1 grants exactly for every role",
          ],
        },
        {
          command: pnpm,
          args: [
            "exec",
            "vitest",
            "run",
            "--config",
            "vitest.component.config.ts",
            "tests/component/persona-navigation.test.tsx",
            "-t",
            "renders only the authorized core destinations",
          ],
        },
        {
          callback: () =>
            executeProductionBrowser(
              ["--grep", "Phase 1.1 Administration matrix", "--workers=1"],
              warningCheckedOptions,
            ),
        },
      ]),
    );
  }
  if (skipEndToEnd) {
    blockedGate(25, "--skip-e2e was supplied");
  } else {
    customGate(25, () =>
      executeSequence([
        {
          command: pnpm,
          args: [
            "exec",
            "vitest",
            "run",
            "--config",
            "vitest.component.config.ts",
            "tests/component/phase11-motion.test.tsx",
          ],
          options: warningCheckedOptions,
        },
        {
          command: pnpm,
          args: [
            "exec",
            "vitest",
            "run",
            "--config",
            "vitest.unit.config.ts",
            "tests/unit/security-observability.test.ts",
            "-t",
            "reuses default-destination loggers across repeated module initialization",
          ],
          options: warningCheckedOptions,
        },
        {
          command: pnpm,
          args: [
            "exec",
            "vitest",
            "run",
            "--config",
            "vitest.integration.config.ts",
            "tests/integration/worker-runtime.test.ts",
            "-t",
            "removes abort listeners across repeated manual worker lifecycles",
          ],
          options: warningCheckedOptions,
        },
        ...Array.from({ length: 2 }, () => ({
          callback: () =>
            executeProductionBrowser(
              ["--grep", "Phase 1.1 listener lifecycle browser probe", "--workers=1"],
              warningCheckedOptions,
            ),
        })),
      ]),
    );
  }
  if (skipEndToEnd) {
    blockedGate(26, "--skip-e2e was supplied");
  } else {
    customGate(26, () =>
      executeProductionBrowser(
        ["--grep", "five-persona Phase 1.1 acceptance", "--workers=1"],
        warningCheckedOptions,
      ),
    );
  }

  pnpmGate(27, "build:web");
  pnpmGate(28, "build:worker");
  pnpmGate(29, "build");
  pnpmGate(30, "smoke:web");
  pnpmGate(31, "smoke:worker");
  if (skipEndToEnd) {
    blockedGate(32, "--skip-e2e was supplied");
  } else {
    customGate(32, () =>
      executeProductionBrowser(
        ["--grep", "reports database, worker, and simulated provider health", "--workers=1"],
        warningCheckedOptions,
      ),
    );
  }
  if (skipEndToEnd) blockedGate(33, "--skip-e2e was supplied");
  else
    commandGate(
      33,
      process.execPath,
      [verifierScriptPath, "--prepared-e2e"],
      warningCheckedOptions,
    );

  commandGate(34, "cmd.exe", ["/d", "/c", "BEA-Doctor.cmd", "--check"]);
  if (skipOwnerLauncher) {
    blockedGate(35, "--skip-owner-launcher was supplied");
  } else {
    ownerLauncherAttempted = true;
    commandGate(35, "cmd.exe", ["/d", "/c", "Start-BEA-Demo.cmd", "--no-open", "--seed"]);
    commandGate(36, "cmd.exe", ["/d", "/c", "Stop-BEA-Demo.cmd"]);
    ownerLauncherStopped = true;
  }

  pnpmGate(37, "security:audit");
  pnpmGate(38, "security:secrets");
  pnpmGate(39, "inventory:verify");
  customGate(40, () => {
    const check = execute("git", [
      "-c",
      `safe.directory=${normalizedRoot}`,
      "diff",
      "--cached",
      "--check",
    ]);
    if (check !== 0) return check;
    const empty = spawnSync(
      "git",
      ["-c", `safe.directory=${normalizedRoot}`, "diff", "--cached", "--quiet"],
      { cwd: repositoryRoot, stdio: "ignore" },
    ).status;
    if (empty === 0) {
      console.error("No staged Phase 1.1 diff is available for final verification.");
      return 1;
    }
    return empty === 1 ? 0 : (empty ?? 1);
  });
  customGate(41, () => {
    const status = spawnSync(
      "git",
      ["-c", `safe.directory=${normalizedRoot}`, "status", "--porcelain=v1"],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    if (status.status !== 0) return status.status ?? 1;
    const lines = status.stdout.split(/\r?\n/u).filter(Boolean);
    lines.forEach((line) => console.log(line));
    const invalid = lines.filter((line) => line.startsWith("??") || line[1] !== " ");
    if (invalid.length > 0) {
      console.error("Git status must be clean or contain only intentionally staged files.");
      return 1;
    }
    return 0;
  });
} catch (error) {
  if (error instanceof RequiredGateBlockedError) terminalBlock = error;
  else terminalFailure = error;
  console.error(error instanceof Error ? error.message : error);
} finally {
  if (ownerLauncherAttempted && !ownerLauncherStopped) {
    console.log("\n==> Exact owner-launcher cleanup boundary");
    const stopCode = execute("cmd.exe", ["/d", "/c", "Stop-BEA-Demo.cmd"]);
    if (stopCode !== 0) {
      terminalFailure ??= new Error(`Owner-launcher cleanup failed with exit code ${stopCode}.`);
      if (resultFor(36).result === "PENDING") {
        record(36, "FAIL", stopCode, "Exact owner-launcher cleanup failed.");
      }
    }
  }
  if (databaseBoundaryStarted) {
    console.log("\n==> Demo database shutdown boundary");
    const stopCode = execute(pnpm, ["db:stop"]);
    if (stopCode !== 0) {
      terminalFailure ??= new Error(`Demo database cleanup failed with exit code ${stopCode}.`);
      record(12, "FAIL", stopCode, "Database shutdown boundary failed.");
    }
  }

  const blocker = terminalFailure
    ? "blocked by an earlier failed gate"
    : terminalBlock
      ? "required gate was intentionally skipped"
      : "aggregate ended before this gate";
  for (const result of results) {
    if (result.result === "PENDING") {
      record(result.number, "BLOCKED", null, blocker);
    }
  }
  console.table(results);
}

const hasFailure = results.some((result) => result.result === "FAIL") || terminalFailure;
const hasBlocked = results.some((result) => result.result === "BLOCKED") || terminalBlock;

if (hasFailure) {
  console.log("PHASE1_1_VERIFICATION=FAIL");
  process.exitCode = 1;
} else if (hasBlocked) {
  console.log("PHASE1_1_VERIFICATION=BLOCKED_REQUIRED_GATE_NOT_RUN");
  process.exitCode = 2;
} else {
  console.log("PHASE1_1_VERIFICATION=PASS");
}
