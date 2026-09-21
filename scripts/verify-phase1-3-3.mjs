import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  PHASE1_3_3_INTENDED_FILES,
  assertExactPhase1_3_3StagedPaths,
} from "./phase1-3-3-intended-files.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const normalizedRoot = repositoryRoot.replaceAll("\\", "/");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

export const PHASE1_3_3_STARTING_COMMIT = "6a67c6da5a6a765a79cc49d134158c644768a3b4";
export const PHASE1_3_3_VERIFIED_NODE_VERSION = "24.19.0";
export const PHASE1_3_3_VERIFIED_PNPM_VERSION = "11.19.0";

export const PHASE1_3_3_GATE_DEFINITIONS = Object.freeze([
  [1, "Repository boundary"],
  [2, "Starting commit"],
  [3, "Source integrity"],
  [4, "Format"],
  [5, "Format check"],
  [6, "Lint"],
  [7, "Typecheck"],
  [8, "Left-scroll unit/component tests"],
  [9, "Orb fade/translucency tests"],
  [10, "Right-scroll renderer tests"],
  [11, "Long-content browser tests"],
  [12, "Production-mode tests"],
  [13, "Test-provider isolation"],
  [14, "Secret-store tests"],
  [15, "Connection-wizard tests"],
  [16, "Model-discovery tests"],
  [17, "Capability-registry tests"],
  [18, "Model-routing tests"],
  [19, "File Search route tests"],
  [20, "Document/PDF route tests"],
  [21, "Data/chart route tests"],
  [22, "Image-generation route tests"],
  [23, "Realtime model/voice tests"],
  [24, "Voice spoken-response tests"],
  [25, "Persona preservation tests"],
  [26, "Artifact-brand preservation tests"],
  [27, "Production build"],
  [28, "Production browser acceptance"],
  [29, "Realtime fake-media acceptance"],
  [30, "PDF.js regression"],
  [31, "Task-action regression"],
  [32, "Windows Doctor"],
  [33, "Start-BEA"],
  [34, "Stop-BEA"],
  [35, "Dependency audit"],
  [36, "Secret scan"],
  [37, "Inventory reconciliation"],
  [38, "Git status"],
]);

const safeInheritedEnvironmentKeys = Object.freeze([
  "APPDATA",
  "ComSpec",
  "COMSPEC",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "Path",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "SystemDrive",
  "SystemRoot",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USERPROFILE",
  "WINDIR",
]);

const authoritativeTestEnvironment = Object.freeze({
  APP_BASE_URL: "http://127.0.0.1:3134",
  APP_MODE: "demo",
  BEA_BROWSER_MEDIA_TEST_AUTHORITY: "",
  BEA_BROWSER_MEDIA_TEST_MODE: "false",
  BEA_BROWSER_MEDIA_TEST_WAV_PATH: "",
  BEA_BROWSER_MEDIA_TEST_WAV_SHA256: "",
  BEA_DISABLE_ENV_FILE: "true",
  BEA_RUNTIME_MODE: "",
  CI: "1",
  DATABASE_DRIVER: "pglite",
  DEMO_AUTH_ENABLED: "true",
  DEMO_DATABASE_PATH: ".data/phase1-3-3-verification",
  FORCE_COLOR: "0",
  LOG_LEVEL: "silent",
  NODE_ENV: "test",
  NODE_NO_WARNINGS: "",
  NODE_OPTIONS: "--trace-warnings",
  NODE_REDIRECT_WARNINGS: "",
  OPENAI_API_KEY: "",
  SESSION_TTL_MINUTES: "480",
  WORKER_DEMO_DATABASE_PATH: "memory://",
  WORKER_HEALTH_PORT: "3135",
  WORKER_MODE: "once",
  WORKER_POLL_INTERVAL_MS: "60000",
  WORKER_QUEUE_ADAPTER: "inline",
});

export function createPhase1_3_3VerificationEnvironment(source = {}) {
  const environment = {};
  for (const key of safeInheritedEnvironmentKeys) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  return { ...environment, ...authoritativeTestEnvironment };
}

export function assertPhase1_3_3ToolchainVersions(nodeVersion, pnpmVersion) {
  const normalizedNodeVersion = String(nodeVersion).replace(/^v/u, "");
  if (normalizedNodeVersion !== PHASE1_3_3_VERIFIED_NODE_VERSION) {
    throw new Error(
      `Phase 1.3.3 verification requires exact Node ${PHASE1_3_3_VERIFIED_NODE_VERSION}; received ${normalizedNodeVersion || "unknown"}.`,
    );
  }
  if (String(pnpmVersion).trim() !== PHASE1_3_3_VERIFIED_PNPM_VERSION) {
    throw new Error(
      `Phase 1.3.3 verification requires exact pnpm ${PHASE1_3_3_VERIFIED_PNPM_VERSION}; received ${String(pnpmVersion).trim() || "unknown"}.`,
    );
  }
}

export function assertPhase1_3_3StartingState(head, branch) {
  if (head !== PHASE1_3_3_STARTING_COMMIT) {
    throw new Error(
      `Phase 1.3.3 verification requires starting HEAD ${PHASE1_3_3_STARTING_COMMIT}; received ${head || "unknown"}.`,
    );
  }
  if (branch !== "main") {
    throw new Error(
      `Phase 1.3.3 verification requires branch main; received ${branch || "unknown"}.`,
    );
  }
}

function invocationFor(command, arguments_, environment) {
  const commandScript = process.platform === "win32" && command.toLowerCase().endsWith(".cmd");
  return commandScript
    ? {
        arguments: ["/d", "/s", "/c", command, ...arguments_],
        executable: environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe",
      }
    : { arguments: arguments_, executable: command };
}

export function runPhase1_3_3Command(command, arguments_, options = {}) {
  const environment = options.environment ?? createPhase1_3_3VerificationEnvironment(process.env);
  const invocation = invocationFor(command, arguments_, environment);
  const result = spawnSync(invocation.executable, invocation.arguments, {
    cwd: repositoryRoot,
    encoding: options.capture ? "utf8" : undefined,
    env: environment,
    maxBuffer: options.capture ? 32 * 1024 * 1024 : undefined,
    shell: false,
    stdio: options.capture ? "pipe" : "inherit",
    windowsHide: true,
  });
  return {
    error: result.error,
    exitCode: result.status ?? (result.error ? 1 : 0),
    stderr: String(result.stderr ?? ""),
    stdout: String(result.stdout ?? ""),
  };
}

function capturedOutput(command, arguments_, environment) {
  const result = runPhase1_3_3Command(command, arguments_, {
    capture: true,
    environment,
  });
  if (result.error || result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `${command} failed with exit code ${result.exitCode}.`,
    );
  }
  return result.stdout.trim();
}

export function inspectPhase1_3_3StagedState(runOutput) {
  const output =
    runOutput ??
    ((command, arguments_) =>
      capturedOutput(command, arguments_, createPhase1_3_3VerificationEnvironment(process.env)));
  const git = (...arguments_) =>
    output("git", ["-c", `safe.directory=${normalizedRoot}`, ...arguments_]);
  const splitZero = (value) => String(value).split("\0").filter(Boolean);
  return {
    stagedPaths: splitZero(git("diff", "--cached", "--name-only", "-z")),
    unstagedPaths: splitZero(git("diff", "--name-only", "-z")),
    untrackedPaths: splitZero(git("ls-files", "--others", "--exclude-standard", "-z")),
    whitespace: git("diff", "--cached", "--check"),
  };
}

export function assertPhase1_3_3StagedState(state) {
  assertExactPhase1_3_3StagedPaths(state.stagedPaths);
  if (state.unstagedPaths.length > 0) {
    throw new Error(`Phase 1.3.3 has unstaged paths: ${state.unstagedPaths.join(", ")}`);
  }
  if (state.untrackedPaths.length > 0) {
    throw new Error(`Phase 1.3.3 has untracked paths: ${state.untrackedPaths.join(", ")}`);
  }
  if (state.whitespace.trim() !== "") {
    throw new Error(`Phase 1.3.3 staged whitespace check failed: ${state.whitespace.trim()}`);
  }
  return state;
}

function writeCaptured(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function unitArguments(files) {
  return ["exec", "vitest", "run", ...files, "--config", "vitest.unit.config.ts"];
}

function componentArguments(files) {
  return ["exec", "vitest", "run", ...files, "--config", "vitest.component.config.ts"];
}

export function phase1_3_3SafetyOutcomes() {
  return Object.freeze({
    doctor: "BLOCKED_READ_ONLY",
    liveProviderAcceptance: "NOT_RUN",
    ownerAcceptance: "NOT_RUN",
    productionStart: "BLOCKED_NOT_RUN",
    productionStop: "ALREADY_STOPPED_STATIC_CONTRACT",
  });
}

export function runPhase1_3_3Verification() {
  const environment = createPhase1_3_3VerificationEnvironment(process.env);
  const results = PHASE1_3_3_GATE_DEFINITIONS.map(([number, name]) => ({
    detail: "",
    exitCode: null,
    name,
    number,
    result: "PENDING",
  }));
  let terminalError;

  const resultFor = (number) => {
    const result = results[number - 1];
    if (!result || result.number !== number) {
      throw new Error(`Unknown Phase 1.3.3 gate ${number}.`);
    }
    return result;
  };
  const record = (number, result, exitCode, detail = "") =>
    Object.assign(resultFor(number), { detail, exitCode, result });
  const announce = (number) => process.stdout.write(`\n==> ${number}. ${resultFor(number).name}\n`);

  const commandGate = (number, command, arguments_) => {
    announce(number);
    const execution = runPhase1_3_3Command(command, arguments_, { environment });
    const passed = !execution.error && execution.exitCode === 0;
    record(number, passed ? "PASS" : "FAIL", execution.exitCode);
    if (!passed) {
      throw new Error(
        execution.error?.message ??
          `${resultFor(number).name} failed with exit code ${execution.exitCode}.`,
      );
    }
  };

  const expectedCommandGate = (number, command, arguments_, expectedExitCode, marker, detail) => {
    announce(number);
    const execution = runPhase1_3_3Command(command, arguments_, {
      capture: true,
      environment,
    });
    writeCaptured(execution);
    const combined = `${execution.stdout}\n${execution.stderr}`;
    const passed =
      !execution.error && execution.exitCode === expectedExitCode && combined.includes(marker);
    record(number, passed ? "PASS" : "FAIL", execution.exitCode, passed ? detail : "");
    if (!passed) {
      throw new Error(
        `${resultFor(number).name} did not produce the required safe outcome ${marker} with exit code ${expectedExitCode}.`,
      );
    }
  };

  const sequenceGate = (number, steps) => {
    announce(number);
    for (const [command, arguments_] of steps) {
      const execution = runPhase1_3_3Command(command, arguments_, { environment });
      if (execution.error || execution.exitCode !== 0) {
        record(number, "FAIL", execution.exitCode);
        throw new Error(
          execution.error?.message ??
            `${resultFor(number).name} failed with exit code ${execution.exitCode}.`,
        );
      }
    }
    record(number, "PASS", 0);
  };

  const customGate = (number, callback, detail = "") => {
    announce(number);
    callback();
    record(number, "PASS", 0, detail);
  };

  const pnpmGate = (number, ...arguments_) => commandGate(number, pnpm, arguments_);
  const unitGate = (number, files) => pnpmGate(number, ...unitArguments(files));
  const componentGate = (number, files) => pnpmGate(number, ...componentArguments(files));

  try {
    const pnpmVersion = capturedOutput(pnpm, ["--version"], environment);
    assertPhase1_3_3ToolchainVersions(process.versions.node, pnpmVersion);
    process.stdout.write(
      `PHASE1_3_3_TOOLCHAIN=PASS node=${process.versions.node} pnpm=${pnpmVersion}\n`,
    );

    commandGate(1, process.execPath, ["scripts/repository-boundary.mjs"]);
    customGate(2, () => {
      const head = capturedOutput(
        "git",
        ["-c", `safe.directory=${normalizedRoot}`, "rev-parse", "HEAD"],
        environment,
      );
      const branch = capturedOutput(
        "git",
        ["-c", `safe.directory=${normalizedRoot}`, "symbolic-ref", "--short", "HEAD"],
        environment,
      );
      assertPhase1_3_3StartingState(head, branch);
    });
    commandGate(3, process.execPath, ["scripts/source-integrity.mjs"]);

    assertPhase1_3_3StagedState(inspectPhase1_3_3StagedState());
    process.stdout.write(
      `PHASE1_3_3_INITIAL_STAGED_MANIFEST=PASS files=${PHASE1_3_3_INTENDED_FILES.length}\n`,
    );

    pnpmGate(4, "exec", "prettier", "--check", ".");
    pnpmGate(5, "format:check");
    pnpmGate(6, "lint");
    pnpmGate(7, "typecheck");
    componentGate(8, ["tests/component/phase133-scroll-ownership.test.tsx"]);
    componentGate(9, ["tests/component/phase133-scroll-ownership.test.tsx"]);
    componentGate(10, [
      "tests/component/phase133-long-workspace-renderer.test.tsx",
      "tests/component/phase133-pdf-scroll-position.test.tsx",
    ]);

    sequenceGate(11, [
      [pnpm, ["build"]],
      [
        pnpm,
        [
          "exec",
          "playwright",
          "test",
          "tests/e2e/command-center.spec.ts",
          "--grep",
          "scrolls long Phase 1.3.3 cockpit fixtures across six required viewport contexts",
          "--project=chromium-desktop",
        ],
      ],
    ]);

    sequenceGate(12, [
      [
        pnpm,
        unitArguments([
          "tests/unit/environment.test.ts",
          "tests/unit/phase133-production-provider-isolation.test.ts",
        ]),
      ],
      [
        pnpm,
        componentArguments([
          "tests/component/phase133-production-isolation-ui.test.ts",
          "tests/component/phase133-production-presentation-server-boundary.test.ts",
        ]),
      ],
    ]);
    sequenceGate(13, [
      [pnpm, unitArguments(["tests/unit/phase133-production-provider-isolation.test.ts"])],
      [
        pnpm,
        componentArguments([
          "tests/component/phase133-production-isolation-ui.test.ts",
          "tests/component/openai-route-transport.test.ts",
        ]),
      ],
    ]);
    unitGate(14, [
      "tests/unit/server-secrets.test.ts",
      "tests/unit/openai-administration-backend.test.ts",
    ]);
    componentGate(15, [
      "tests/component/openai-administration.test.tsx",
      "tests/component/openai-route-transport.test.ts",
      "tests/component/phase133-openai-admin-ui.test.tsx",
    ]);
    unitGate(16, ["tests/unit/openai-administration-backend.test.ts"]);
    unitGate(17, [
      "tests/unit/phase133-openai-routing.test.ts",
      "tests/unit/openai-administration-backend.test.ts",
      "packages/ai/src/openai/phase1-2-openai.test.ts",
    ]);
    sequenceGate(18, [
      [
        pnpm,
        unitArguments([
          "tests/unit/phase133-openai-routing.test.ts",
          "tests/unit/openai-administration-backend.test.ts",
          "packages/ai/src/openai/phase1-2-openai.test.ts",
        ]),
      ],
      [pnpm, componentArguments(["tests/component/phase133-route-test-api.test.ts"])],
    ]);
    unitGate(19, [
      "tests/unit/phase133-openai-routing.test.ts",
      "packages/ai/src/openai/phase1-2-openai.test.ts",
    ]);
    unitGate(20, [
      "tests/unit/phase133-openai-routing.test.ts",
      "packages/ai/src/openai/phase1-2-openai.test.ts",
      "packages/artifacts/src/pdf.test.ts",
    ]);
    unitGate(21, [
      "tests/unit/phase133-openai-routing.test.ts",
      "packages/ai/src/openai/phase1-2-openai.test.ts",
      "packages/artifacts/src/manifest.test.ts",
    ]);
    unitGate(22, [
      "tests/unit/phase133-openai-routing.test.ts",
      "packages/ai/src/openai/phase1-2-openai.test.ts",
    ]);
    sequenceGate(23, [
      [
        pnpm,
        unitArguments([
          "tests/unit/phase133-openai-routing.test.ts",
          "tests/unit/live-realtime-voice.test.ts",
          "packages/ai/src/openai/phase1-2-openai.test.ts",
        ]),
      ],
      [pnpm, componentArguments(["tests/component/realtime-route-transport.test.ts"])],
    ]);
    sequenceGate(24, [
      [
        pnpm,
        unitArguments([
          "tests/unit/browser-realtime-voice.test.ts",
          "tests/unit/live-realtime-voice.test.ts",
        ]),
      ],
      [
        pnpm,
        componentArguments([
          "tests/component/phase133-realtime-preference-route.test.ts",
          "tests/component/phase133-scroll-ownership.test.tsx",
        ]),
      ],
    ]);
    unitGate(25, ["tests/unit/phase131-persona-brand.test.ts"]);
    unitGate(26, ["packages/artifacts/src/manifest.test.ts", "packages/artifacts/src/pdf.test.ts"]);
    pnpmGate(27, "build");
    sequenceGate(28, [
      [
        pnpm,
        [
          "exec",
          "playwright",
          "test",
          "tests/e2e/command-center.spec.ts",
          "--grep",
          "keeps AI Command panels matched and the composer anchored across six required viewport contexts|scrolls long Phase 1.3.3 cockpit fixtures across six required viewport contexts|true touch context",
          "--project=chromium-desktop",
        ],
      ],
      [pnpm, ["exec", "playwright", "test", "--config=playwright.phase133-presentation.config.ts"]],
    ]);
    commandGate(29, process.execPath, ["scripts/verify-phase1-2.mjs", "--webrtc-browser"]);
    componentGate(30, [
      "tests/component/phase133-pdf-scroll-position.test.tsx",
      "tests/component/workspace-renderer.test.tsx",
    ]);
    componentGate(31, ["tests/component/ai-command-workspace.test.tsx"]);
    expectedCommandGate(
      32,
      "BEA-Doctor.cmd",
      ["--check"],
      1,
      "BEA_PRODUCTION_DOCTOR=BLOCKED",
      "Expected read-only BLOCKED result under the credential-free verification environment.",
    );
    expectedCommandGate(
      33,
      "Start-BEA.cmd",
      [],
      1,
      "BEA_PRODUCTION_START=BLOCKED",
      "Expected BLOCKED/NOT RUN result; no process, database, migration, or provider was started.",
    );
    pnpmGate(
      34,
      "exec",
      "vitest",
      "run",
      "tests/unit/phase133-production-owner-tools.test.mjs",
      "-t",
      "executes the pure Stop-BEA ALREADY_STOPPED decision without process access",
      "--config",
      "vitest.unit.config.ts",
    );
    record(
      34,
      "PASS",
      0,
      "Pure fail-closed ALREADY_STOPPED decision produced BEA_PRODUCTION_STOP=ALREADY_STOPPED with processAccessRequired=false; Stop-BEA.cmd was not invoked.",
    );
    pnpmGate(35, "security:audit");
    commandGate(36, process.execPath, ["scripts/secret-scan.mjs"]);
    commandGate(37, process.execPath, ["scripts/file-inventory.mjs"]);
    customGate(
      38,
      () => assertPhase1_3_3StagedState(inspectPhase1_3_3StagedState()),
      `Exact staged manifest repeated (${PHASE1_3_3_INTENDED_FILES.length} paths).`,
    );
  } catch (error) {
    terminalError = error;
    const pending = results.find((result) => result.result === "PENDING");
    if (pending) record(pending.number, "FAIL", 1, "Verification stopped at this gate.");
  } finally {
    const detail = terminalError ? "blocked by an earlier failed gate" : "aggregate ended early";
    for (const result of results) {
      if (result.result === "PENDING") record(result.number, "BLOCKED", null, detail);
    }
    console.table(results);
  }

  const passed = !terminalError && results.every((result) => result.result === "PASS");
  if (passed) {
    process.stdout.write("PHASE1_3_3_VERIFICATION=PASS\n");
    return 0;
  }
  process.stderr.write(
    `${terminalError instanceof Error ? terminalError.message : terminalError}\n`,
  );
  process.stdout.write("PHASE1_3_3_VERIFICATION=FAIL\n");
  return 1;
}

function main() {
  if (process.argv.length !== 2) {
    throw new Error("Usage: node scripts/verify-phase1-3-3.mjs");
  }
  process.exitCode = runPhase1_3_3Verification();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.stdout.write("PHASE1_3_3_VERIFICATION=FAIL\n");
    process.exitCode = 1;
  }
}
