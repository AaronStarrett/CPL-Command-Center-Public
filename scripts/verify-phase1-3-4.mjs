import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  PHASE1_3_4_BASE_COMMIT,
  PHASE1_3_4_INTENDED_FILES,
  assertExactPhase1_3_4StagedPaths,
} from "./phase1-3-4-intended-files.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const normalizedRoot = repositoryRoot.replaceAll("\\", "/");
const pnpm =
  process.env.BEA_PHASE134_PINNED_PNPM_EXECUTABLE?.trim() ||
  (process.platform === "win32" ? "pnpm.cmd" : "pnpm");

export const PHASE1_3_4_STARTING_COMMIT = PHASE1_3_4_BASE_COMMIT;
export const PHASE1_3_4_STARTING_MESSAGE =
  "feat: activate production AI routing and refine scrollable BEA cockpit";
export const PHASE1_3_4_VERIFIED_NODE_VERSION = "24.19.0";
export const PHASE1_3_4_VERIFIED_PNPM_VERSION = "11.19.0";

export const PHASE1_3_4_GATE_DEFINITIONS = Object.freeze([
  [1, "Repository boundary"],
  [2, "Starting commit"],
  [3, "Source integrity"],
  [4, "Toolchain bootstrap tests"],
  [5, "Node checksum tests"],
  [6, "pnpm isolation tests"],
  [7, "Format"],
  [8, "Format check"],
  [9, "Lint"],
  [10, "Typecheck"],
  [11, "Config-store tests"],
  [12, "Secret-store tests"],
  [13, "HTTPS/certificate tests"],
  [14, "Port-management tests"],
  [15, "Deployment-profile tests"],
  [16, "Local Owner authentication tests"],
  [17, "Session-security tests"],
  [18, "PostgreSQL adapter tests"],
  [19, "Real PostgreSQL integration gate"],
  [20, "Production migrations"],
  [21, "System-seed/no-demo-data tests"],
  [22, "pg-boss tests"],
  [23, "Supervisor ownership tests"],
  [24, "Start-BEA tests"],
  [25, "Stop-BEA tests"],
  [26, "Doctor tests"],
  [27, "Build-freshness tests"],
  [28, "OpenAI setup-required startup test"],
  [29, "OpenAI configuration regression"],
  [30, "Model-routing regression"],
  [31, "Realtime regression"],
  [32, "Two-tile UX regression"],
  [33, "Conversation/workspace scroll regression"],
  [34, "PDF.js regression"],
  [35, "Production build"],
  [36, "Production browser acceptance"],
  [37, "Backup/restore test"],
  [38, "Dependency audit"],
  [39, "Secret scan"],
  [40, "Inventory reconciliation"],
  [41, "Git status"],
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
  "ProgramFiles",
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
  BEA_AUTH_PROVIDER: "demo",
  BEA_BROWSER_MEDIA_TEST_AUTHORITY: "",
  BEA_BROWSER_MEDIA_TEST_MODE: "false",
  BEA_DISABLE_ENV_FILE: "true",
  BEA_PHASE133_PRESENTATION_TEST_AUTHORITY: "",
  BEA_PHASE133_PRESENTATION_TEST_MODE: "false",
  BEA_PRODUCTION_SECRET_PATH: "",
  BEA_RUNTIME_MODE: "",
  CI: "1",
  DATABASE_DRIVER: "pglite",
  DATABASE_URL: "",
  DEMO_AUTH_ENABLED: "true",
  DEMO_DATABASE_PATH: ".data/phase1-3-4-verification",
  FORCE_COLOR: "0",
  LOG_LEVEL: "silent",
  NODE_ENV: "test",
  NODE_NO_WARNINGS: "",
  NODE_OPTIONS: "--trace-warnings",
  NODE_REDIRECT_WARNINGS: "",
  OPENAI_API_KEY: "",
  SESSION_SECRET: "",
  SESSION_TTL_MINUTES: "480",
  WORKER_DEMO_DATABASE_PATH: "memory://",
  WORKER_HEALTH_PORT: "3135",
  WORKER_MODE: "once",
  WORKER_POLL_INTERVAL_MS: "60000",
  WORKER_QUEUE_ADAPTER: "inline",
});

export function createPhase1_3_4VerificationEnvironment(source = {}) {
  const environment = {};
  for (const key of safeInheritedEnvironmentKeys) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  const inheritedPath = environment.Path ?? environment.PATH ?? "";
  const pinnedNodeDirectory = path.dirname(process.execPath);
  const pinnedPath = inheritedPath
    ? `${pinnedNodeDirectory}${path.delimiter}${inheritedPath}`
    : pinnedNodeDirectory;
  return {
    ...environment,
    ...authoritativeTestEnvironment,
    PATH: pinnedPath,
    Path: pinnedPath,
  };
}

export function assertPhase1_3_4ToolchainVersions(nodeVersion, pnpmVersion) {
  const normalizedNodeVersion = String(nodeVersion).replace(/^v/u, "");
  if (normalizedNodeVersion !== PHASE1_3_4_VERIFIED_NODE_VERSION) {
    throw new Error(
      `Phase 1.3.4 verification requires exact Node ${PHASE1_3_4_VERIFIED_NODE_VERSION}; received ${normalizedNodeVersion || "unknown"}.`,
    );
  }
  if (String(pnpmVersion).trim() !== PHASE1_3_4_VERIFIED_PNPM_VERSION) {
    throw new Error(
      `Phase 1.3.4 verification requires exact pnpm ${PHASE1_3_4_VERIFIED_PNPM_VERSION}; received ${String(pnpmVersion).trim() || "unknown"}.`,
    );
  }
}

export function assertPhase1_3_4StartingState(state) {
  if (state.branch !== "main") {
    throw new Error(`Phase 1.3.4 verification requires branch main; received ${state.branch}.`);
  }
  if (state.startingCommitPresent !== true || state.startingCommitIsAncestor !== true) {
    throw new Error(`Required starting commit ${PHASE1_3_4_STARTING_COMMIT} is not retained.`);
  }
  if (state.startingMessage !== PHASE1_3_4_STARTING_MESSAGE) {
    throw new Error(
      "The Phase 1.3.4 starting commit message does not match the approved checkpoint.",
    );
  }
}

function invocationFor(command, arguments_, environment) {
  const commandScript = process.platform === "win32" && command.toLowerCase().endsWith(".cmd");
  return commandScript
    ? {
        executable: environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe",
        arguments: ["/d", "/s", "/c", command, ...arguments_],
      }
    : { executable: command, arguments: arguments_ };
}

export function runPhase1_3_4Command(command, arguments_, options = {}) {
  const environment = options.environment ?? createPhase1_3_4VerificationEnvironment(process.env);
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
  const result = runPhase1_3_4Command(command, arguments_, { capture: true, environment });
  if (result.error || result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `${path.basename(command)} failed with exit code ${String(result.exitCode)}.`,
    );
  }
  return result.stdout.trim();
}

export function inspectPhase1_3_4StagedState(runOutput) {
  const environment = createPhase1_3_4VerificationEnvironment(process.env);
  const output =
    runOutput ?? ((command, arguments_) => capturedOutput(command, arguments_, environment));
  const git = (...arguments_) =>
    output("git", ["-c", `safe.directory=${normalizedRoot}`, ...arguments_]);
  const splitZero = (value) => String(value).split("\0").filter(Boolean);
  return {
    stagedPaths: splitZero(git("diff", "--cached", "--name-only", "-z", PHASE1_3_4_BASE_COMMIT)),
    unstagedPaths: splitZero(git("diff", "--name-only", "-z")),
    untrackedPaths: splitZero(git("ls-files", "--others", "--exclude-standard", "-z")),
    whitespace: git("diff", "--cached", "--check"),
  };
}

export function assertPhase1_3_4StagedState(state) {
  assertExactPhase1_3_4StagedPaths(state.stagedPaths);
  if (state.unstagedPaths.length > 0) {
    throw new Error(`Phase 1.3.4 has unstaged paths: ${state.unstagedPaths.join(", ")}`);
  }
  if (state.untrackedPaths.length > 0) {
    throw new Error(`Phase 1.3.4 has untracked paths: ${state.untrackedPaths.join(", ")}`);
  }
  if (state.whitespace.trim() !== "") {
    throw new Error(`Phase 1.3.4 staged whitespace check failed: ${state.whitespace.trim()}`);
  }
  return state;
}

function unitArguments(files, testNamePattern) {
  return [
    "exec",
    "vitest",
    "run",
    ...files,
    ...(testNamePattern ? ["-t", testNamePattern] : []),
    "--config",
    "vitest.unit.config.ts",
  ];
}

function componentArguments(files) {
  return ["exec", "vitest", "run", ...files, "--config", "vitest.component.config.ts"];
}

function integrationArguments(files) {
  return ["exec", "vitest", "run", ...files, "--config", "vitest.integration.config.ts"];
}

export function phase1_3_4ExternalEvidenceDefaults() {
  return Object.freeze({
    machineConfiguration: "NOT_RUN",
    ownerLiveOpenAi: "NOT_RUN",
    ownerAcceptance: "NOT_RUN",
    browserProfile: "TEST_ONLY",
    realPostgres: "OWNER_PREREQUISITE_REQUIRED",
  });
}

export function runPhase1_3_4Verification() {
  const environment = createPhase1_3_4VerificationEnvironment(process.env);
  const results = PHASE1_3_4_GATE_DEFINITIONS.map(([number, name]) => ({
    number,
    name,
    result: "PENDING",
    exitCode: null,
    detail: "",
  }));
  let terminalError;
  let realPostgresStatus = "OWNER_PREREQUISITE_REQUIRED";

  const resultFor = (number) => {
    const result = results[number - 1];
    if (!result || result.number !== number) throw new Error(`Unknown Phase 1.3.4 gate ${number}.`);
    return result;
  };
  const record = (number, result, exitCode, detail = "") =>
    Object.assign(resultFor(number), { result, exitCode, detail });
  const announce = (number) => process.stdout.write(`\n==> ${number}. ${resultFor(number).name}\n`);
  const writeCaptured = (result) => {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  };
  const commandGate = (number, command, arguments_, options = {}) => {
    announce(number);
    const execution = runPhase1_3_4Command(command, arguments_, {
      environment: options.environment ?? environment,
      capture: options.capture ?? false,
    });
    if (options.capture) writeCaptured(execution);
    const passed = !execution.error && execution.exitCode === 0;
    record(number, passed ? "PASS" : "FAIL", execution.exitCode, options.detail ?? "");
    if (!passed) {
      throw new Error(
        execution.error?.message ??
          `${resultFor(number).name} failed with exit code ${String(execution.exitCode)}.`,
      );
    }
    return execution;
  };
  const pnpmGate = (number, ...arguments_) => commandGate(number, pnpm, arguments_);
  const unitGate = (number, files, pattern) => pnpmGate(number, ...unitArguments(files, pattern));
  const componentGate = (number, files) => pnpmGate(number, ...componentArguments(files));
  const integrationGate = (number, files) => pnpmGate(number, ...integrationArguments(files));
  const sequenceGate = (number, steps, detail = "") => {
    announce(number);
    for (const [command, arguments_] of steps) {
      const execution = runPhase1_3_4Command(command, arguments_, { environment });
      if (execution.error || execution.exitCode !== 0) {
        record(number, "FAIL", execution.exitCode);
        throw new Error(
          execution.error?.message ??
            `${resultFor(number).name} failed with exit code ${String(execution.exitCode)}.`,
        );
      }
    }
    record(number, "PASS", 0, detail);
  };
  const customGate = (number, callback, detail = "") => {
    announce(number);
    callback();
    record(number, "PASS", 0, detail);
  };

  try {
    const pnpmVersion = capturedOutput(pnpm, ["--version"], environment);
    assertPhase1_3_4ToolchainVersions(process.versions.node, pnpmVersion);
    process.stdout.write(
      `PHASE1_3_4_TOOLCHAIN=PASS node=${process.versions.node} pnpm=${pnpmVersion}\n`,
    );

    commandGate(1, process.execPath, ["scripts/repository-boundary.mjs"]);
    customGate(2, () => {
      const git = (...arguments_) =>
        runPhase1_3_4Command("git", ["-c", `safe.directory=${normalizedRoot}`, ...arguments_], {
          capture: true,
          environment,
        });
      const present = git("cat-file", "-e", `${PHASE1_3_4_STARTING_COMMIT}^{commit}`);
      const ancestor = git("merge-base", "--is-ancestor", PHASE1_3_4_STARTING_COMMIT, "HEAD");
      assertPhase1_3_4StartingState({
        branch: capturedOutput(
          "git",
          ["-c", `safe.directory=${normalizedRoot}`, "symbolic-ref", "--short", "HEAD"],
          environment,
        ),
        startingCommitPresent: present.exitCode === 0,
        startingCommitIsAncestor: ancestor.exitCode === 0,
        startingMessage: capturedOutput(
          "git",
          [
            "-c",
            `safe.directory=${normalizedRoot}`,
            "show",
            "-s",
            "--format=%s",
            PHASE1_3_4_STARTING_COMMIT,
          ],
          environment,
        ),
      });
    });
    commandGate(3, process.execPath, ["scripts/source-integrity.mjs"]);

    assertPhase1_3_4StagedState(inspectPhase1_3_4StagedState());
    process.stdout.write(
      `PHASE1_3_4_INITIAL_CUMULATIVE_MANIFEST=PASS files=${String(PHASE1_3_4_INTENDED_FILES.length)}\n`,
    );

    unitGate(4, [
      "tests/unit/phase134-bootstrap-configure-wrappers.test.mjs",
      "tests/unit/phase134-bootstrap-toolchain-certificate-manifest.test.mjs",
    ]);
    unitGate(
      5,
      ["tests/unit/phase134-bootstrap-toolchain-certificate-manifest.test.mjs"],
      "allows only the exact official Node archive|parses one exact checksum",
    );
    unitGate(
      6,
      [
        "tests/unit/phase134-bootstrap-configure-wrappers.test.mjs",
        "tests/unit/phase134-bootstrap-toolchain-certificate-manifest.test.mjs",
      ],
      "bootstraps only after confirmation|invokes only absolute pinned Node",
    );
    pnpmGate(7, "exec", "prettier", "--write", ".");
    pnpmGate(8, "format:check");
    pnpmGate(9, "lint");
    pnpmGate(10, "typecheck");
    unitGate(11, [
      "tests/unit/phase134-bootstrap-config.test.mjs",
      "tests/unit/phase134-bootstrap-configure-wrappers.test.mjs",
      "tests/unit/phase134-production-setup-session.test.mjs",
    ]);
    unitGate(12, [
      "tests/unit/phase134-bootstrap-secrets-acl.test.mjs",
      "tests/unit/phase134-protected-secret-readiness.test.mjs",
      "tests/unit/phase134-production-openai-vault.test.ts",
      "tests/unit/server-secrets.test.ts",
    ]);
    unitGate(13, [
      "tests/unit/phase134-bootstrap-toolchain-certificate-manifest.test.mjs",
      "tests/unit/phase134-https-gateway.test.mjs",
    ]);
    unitGate(14, [
      "tests/unit/phase134-bootstrap-config.test.mjs",
      "tests/unit/phase134-production-doctor.test.mjs",
      "tests/unit/phase134-runtime-control.test.mjs",
      "tests/unit/phase134-start-stop.test.mjs",
    ]);
    unitGate(15, [
      "tests/unit/phase134-bootstrap-config.test.mjs",
      "tests/unit/phase134-local-owner-environment.test.ts",
      "tests/unit/environment.test.ts",
    ]);
    sequenceGate(16, [
      [pnpm, unitArguments(["tests/unit/phase134-local-owner-environment.test.ts"])],
      [
        pnpm,
        integrationArguments([
          "tests/integration/phase134-local-owner-authentication.test.ts",
          "tests/integration/phase134-local-owner-recovery-route.test.ts",
        ]),
      ],
      [pnpm, componentArguments(["tests/component/phase134-local-owner-recovery-page.test.tsx"])],
    ]);
    integrationGate(17, [
      "tests/integration/phase134-local-owner-authentication.test.ts",
      "tests/integration/phase134-local-owner-recovery-route.test.ts",
    ]);
    sequenceGate(18, [
      [pnpm, unitArguments(["tests/unit/database-service.test.ts"])],
      [pnpm, integrationArguments(["tests/integration/database-pglite.test.ts"])],
    ]);

    announce(19);
    const realPostgresEnvironment = {
      ...environment,
      BEA_PHASE134_POSTGRES_TOOLS_DIRECTORY:
        process.env.BEA_PHASE134_POSTGRES_TOOLS_DIRECTORY ?? "",
      BEA_PHASE134_REAL_POSTGRES_DISPOSABLE_CONFIRMATION:
        process.env.BEA_PHASE134_REAL_POSTGRES_DISPOSABLE_CONFIRMATION ?? "",
      BEA_PHASE134_REAL_POSTGRES_TLS_MODE:
        process.env.BEA_PHASE134_REAL_POSTGRES_TLS_MODE ?? "prefer",
      BEA_PHASE134_REAL_POSTGRES_URL: process.env.BEA_PHASE134_REAL_POSTGRES_URL ?? "",
    };
    const realPostgres = runPhase1_3_4Command(
      process.execPath,
      ["scripts/verify-phase1-3-4-real-postgres.mjs"],
      { capture: true, environment: realPostgresEnvironment },
    );
    writeCaptured(realPostgres);
    const realPostgresOutput = `${realPostgres.stdout}\n${realPostgres.stderr}`;
    if (
      !realPostgres.error &&
      realPostgres.exitCode === 0 &&
      realPostgresOutput.includes('"status":"PASS"')
    ) {
      realPostgresStatus = "PASS";
      record(19, "PASS", 0, "Disposable real PostgreSQL acceptance passed.");
    } else if (
      !realPostgres.error &&
      realPostgres.exitCode === 0 &&
      realPostgresOutput.includes('"status":"OWNER_PREREQUISITE_REQUIRED"')
    ) {
      realPostgresStatus = "OWNER_PREREQUISITE_REQUIRED";
      record(
        19,
        "OWNER_PREREQUISITE_REQUIRED",
        0,
        "No explicit disposable real PostgreSQL URL/confirmation was supplied; no connection was attempted.",
      );
    } else {
      record(19, "FAIL", realPostgres.exitCode);
      throw new Error("The disposable real PostgreSQL gate failed closed.");
    }

    integrationGate(20, [
      "tests/integration/phase134-system-seed.test.ts",
      "tests/integration/database-pglite.test.ts",
    ]);
    sequenceGate(21, [
      [pnpm, integrationArguments(["tests/integration/phase134-system-seed.test.ts"])],
      [pnpm, componentArguments(["tests/component/phase134-production-empty-state.test.tsx"])],
    ]);
    sequenceGate(22, [
      [
        pnpm,
        integrationArguments([
          "tests/integration/phase134-production-queue-contract.test.ts",
          "tests/integration/worker-runtime.test.ts",
        ]),
      ],
      [pnpm, unitArguments(["tests/unit/queue.test.ts", "tests/unit/worker.test.ts"])],
    ]);
    unitGate(23, [
      "tests/unit/phase134-preview-runtime.test.mjs",
      "tests/unit/phase134-production-supervisor.test.mjs",
      "tests/unit/phase134-runtime-control.test.mjs",
    ]);
    sequenceGate(24, [
      [
        pnpm,
        unitArguments(["tests/unit/phase134-start-stop.test.mjs"], "starts only|injects exact"),
      ],
      [
        pnpm,
        unitArguments(
          ["tests/unit/phase134-preview-runtime.test.mjs"],
          "^(?:.* )?(?:1|2|3|4|5|6|7|8|9|10|11|17|18|19|20|21)\\.",
        ),
      ],
    ]);
    sequenceGate(25, [
      [pnpm, unitArguments(["tests/unit/phase134-start-stop.test.mjs"], "stops only")],
      [
        pnpm,
        unitArguments(
          ["tests/unit/phase134-preview-runtime.test.mjs"],
          "^(?:.* )?(?:12|13|14|15|16|22)\\.",
        ),
      ],
    ]);
    unitGate(26, ["tests/unit/phase134-production-doctor.test.mjs"]);
    unitGate(27, [
      "tests/unit/phase134-bootstrap-toolchain-certificate-manifest.test.mjs",
      "tests/unit/phase134-production-activation.test.mjs",
    ]);
    sequenceGate(28, [
      [
        pnpm,
        unitArguments([
          "tests/unit/phase134-production-doctor.test.mjs",
          "tests/unit/phase134-start-stop.test.mjs",
        ]),
      ],
      [pnpm, componentArguments(["tests/component/phase134-openai-setup-reachability.test.tsx"])],
    ]);
    sequenceGate(29, [
      [
        pnpm,
        unitArguments([
          "tests/unit/openai-administration-backend.test.ts",
          "tests/unit/phase134-production-openai-vault.test.ts",
        ]),
      ],
      [pnpm, componentArguments(["tests/component/openai-administration.test.tsx"])],
    ]);
    unitGate(30, [
      "tests/unit/phase133-openai-routing.test.ts",
      "packages/ai/src/openai/phase1-2-openai.test.ts",
    ]);
    sequenceGate(31, [
      [
        pnpm,
        unitArguments([
          "tests/unit/browser-realtime-voice.test.ts",
          "tests/unit/live-realtime-voice.test.ts",
        ]),
      ],
      [pnpm, componentArguments(["tests/component/realtime-route-transport.test.ts"])],
    ]);
    componentGate(32, ["tests/component/phase132-seamless-tiles.test.tsx"]);
    componentGate(33, [
      "tests/component/phase133-scroll-ownership.test.tsx",
      "tests/component/phase133-long-workspace-renderer.test.tsx",
    ]);
    componentGate(34, [
      "tests/component/application-pdf-viewer.test.tsx",
      "tests/component/phase133-pdf-scroll-position.test.tsx",
    ]);
    pnpmGate(35, "build");
    commandGate(
      36,
      pnpm,
      [
        "exec",
        "playwright",
        "test",
        "tests/e2e/phase134-production-bootstrap.spec.ts",
        "--config=playwright.phase134-production.config.ts",
      ],
      {
        detail:
          "TEST-ONLY browser profile; real certificate trust, Local Owner SQL credential, live provider, and machine process lifecycle remain external.",
      },
    );
    unitGate(37, ["tests/unit/phase134-backup-restore.test.mjs"]);
    pnpmGate(38, "security:audit");
    commandGate(39, process.execPath, ["scripts/secret-scan.mjs"]);
    commandGate(40, process.execPath, ["scripts/file-inventory.mjs"]);
    customGate(
      41,
      () => assertPhase1_3_4StagedState(inspectPhase1_3_4StagedState()),
      `Exact cumulative staged-tree manifest repeated (${String(PHASE1_3_4_INTENDED_FILES.length)} paths).`,
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
    process.stdout.write(`PHASE1_3_4_REAL_POSTGRES=${realPostgresStatus}\n`);
    process.stdout.write("PHASE1_3_4_BROWSER_ACCEPTANCE=TEST_ONLY\n");
    process.stdout.write("PHASE1_3_4_MACHINE_CONFIGURATION=NOT_RUN\n");
    process.stdout.write("PHASE1_3_4_OWNER_OPENAI=NOT_RUN\n");
    process.stdout.write("PHASE1_3_4_OWNER_ACCEPTANCE=NOT_RUN\n");
  }

  const accepted = results.every(
    (result) =>
      result.result === "PASS" ||
      (result.number === 19 && result.result === "OWNER_PREREQUISITE_REQUIRED"),
  );
  if (!terminalError && accepted) {
    process.stdout.write("PHASE1_3_4_VERIFICATION=PASS\n");
    return 0;
  }
  process.stderr.write(
    `${terminalError instanceof Error ? terminalError.message : terminalError}\n`,
  );
  process.stdout.write("PHASE1_3_4_VERIFICATION=FAIL\n");
  return 1;
}

function main() {
  if (process.argv.length !== 2) throw new Error("Usage: node scripts/verify-phase1-3-4.mjs");
  process.exitCode = runPhase1_3_4Verification();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.stdout.write("PHASE1_3_4_VERIFICATION=FAIL\n");
    process.exitCode = 1;
  }
}
