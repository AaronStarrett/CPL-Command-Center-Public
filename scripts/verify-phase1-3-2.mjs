import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const normalizedRoot = repositoryRoot.replaceAll("\\", "/");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const startingCommit = "ea18c510eb7b8ee4cb1e4b0120a72c79a530b07e";
const verifiedNodeVersion = "24.19.0";
const verifiedPnpmVersion = "11.19.0";
const intendedPhase132Paths = new Set([
  "README.md",
  "apps/web/app/(authenticated)/layout.tsx",
  "apps/web/app/sign-in/page.tsx",
  "apps/web/components/ai-command-motion-workspace.tsx",
  "apps/web/components/ai-command.module.css",
  "apps/web/components/workspace-renderer.tsx",
  "apps/web/lib/ai-command-contracts.ts",
  "apps/web/lib/ai-command.ts",
  "docs/AI_AND_MEMORY.md",
  "docs/ASSUMPTIONS_AND_GAPS.md",
  "docs/BRAND_SYSTEM.md",
  "docs/CHANGELOG.md",
  "docs/DECISIONS.md",
  "docs/DEMO_GUIDE.md",
  "docs/FILE_INVENTORY.md",
  "docs/OPERATIONS_RUNBOOK.md",
  "docs/PHASE_1_3_2_VERIFICATION.md",
  "docs/PROJECT_CONTEXT.md",
  "docs/REQUIREMENTS_TRACEABILITY.md",
  "docs/SECURITY.md",
  "docs/TEST_PLAN.md",
  "docs/UX_ARCHITECTURE.md",
  "package.json",
  "scripts/verify-phase1-3-2.mjs",
  "tests/component/ai-command-workspace.test.tsx",
  "tests/component/phase131-pro-theme.test.tsx",
  "tests/component/phase132-seamless-tiles.test.tsx",
  "tests/component/workspace-renderer.test.tsx",
  "tests/e2e/command-center.spec.ts",
  "tests/e2e/phase132-visual-evidence.spec.ts",
]);
const results = [];
const environment = {
  ...process.env,
  APP_BASE_URL: "http://127.0.0.1:3000",
  APP_MODE: "demo",
  BEA_DISABLE_ENV_FILE: "true",
  BEA_PHASE132_EVIDENCE_DIR: path.join(
    repositoryRoot,
    ".data",
    "phase1-3-2-evidence",
    "screenshots",
  ),
  DATABASE_DRIVER: "pglite",
  DEMO_AUTH_ENABLED: "true",
  DEMO_DATABASE_PATH: ".data/phase1-3-2-verification",
  DEMO_RESET_CONFIRMATION: "RESET_BEA_DEMO_DATA",
  LOG_LEVEL: "silent",
  OPENAI_API_KEY: "",
  SESSION_TTL_MINUTES: "480",
  WORKER_DEMO_DATABASE_PATH: "memory://",
  WORKER_HEALTH_PORT: "33132",
  WORKER_MODE: "once",
  WORKER_POLL_INTERVAL_MS: "60000",
  WORKER_QUEUE_ADAPTER: "inline",
};

function record(label, passed) {
  results.push({ gate: results.length + 1, label, result: passed ? "PASS" : "FAIL" });
}

function run(label, command, arguments_) {
  process.stdout.write(`\n==> ${results.length + 1}. ${label}\n`);
  const commandScript = process.platform === "win32" && command.toLowerCase().endsWith(".cmd");
  const executable = commandScript ? (process.env.ComSpec ?? "cmd.exe") : command;
  const executableArguments = commandScript
    ? ["/d", "/s", "/c", command, ...arguments_]
    : arguments_;
  const result = spawnSync(executable, executableArguments, {
    cwd: repositoryRoot,
    env: environment,
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) {
    record(label, false);
    throw new Error(`${label} could not start: ${result.error.message}`);
  }
  const passed = result.status === 0;
  record(label, passed);
  if (!passed) throw new Error(`${label} failed with exit code ${result.status ?? 1}.`);
}

function output(command, arguments_) {
  const result = spawnSync(command, arguments_, {
    cwd: repositoryRoot,
    env: environment,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed.`);
  return result.stdout.trim();
}

function verifyToolchain() {
  const commandScript = process.platform === "win32";
  const executable = commandScript ? (process.env.ComSpec ?? "cmd.exe") : pnpm;
  const executableArguments = commandScript ? ["/d", "/s", "/c", pnpm, "--version"] : ["--version"];
  const result = spawnSync(executable, executableArguments, {
    cwd: repositoryRoot,
    env: environment,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  const pnpmVersion = result.status === 0 ? result.stdout.trim() : "";
  if (process.versions.node !== verifiedNodeVersion || pnpmVersion !== verifiedPnpmVersion) {
    throw new Error(
      `Phase 1.3.2 authoritative verification requires exact Node ${verifiedNodeVersion} and pnpm ${verifiedPnpmVersion}; received Node ${process.versions.node || "unknown"} and pnpm ${pnpmVersion || "unknown"}.`,
    );
  }
  process.stdout.write(
    `PHASE1_3_2_TOOLCHAIN=PASS node=${process.versions.node} pnpm=${pnpmVersion}\n`,
  );
}

function verifyStartingState() {
  const label = "Starting commit";
  process.stdout.write(`\n==> ${results.length + 1}. ${label}\n`);
  const head = output("git", ["-c", `safe.directory=${normalizedRoot}`, "rev-parse", "HEAD"]);
  const branch = output("git", [
    "-c",
    `safe.directory=${normalizedRoot}`,
    "symbolic-ref",
    "--short",
    "HEAD",
  ]);
  const passed = head === startingCommit && branch === "main";
  record(label, passed);
  if (!passed) {
    throw new Error(
      `Expected Phase 1.3.2 starting state ${startingCommit} on main; found ${head} on ${branch}.`,
    );
  }
  process.stdout.write("PHASE1_3_2_STARTING_STATE=PASS\n");
}

function verifyStagedState() {
  const label = "Git status";
  process.stdout.write(`\n==> ${results.length + 1}. ${label}\n`);
  const whitespace = spawnSync(
    "git",
    ["-c", `safe.directory=${normalizedRoot}`, "diff", "--cached", "--check"],
    {
      cwd: repositoryRoot,
      env: environment,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    },
  );
  const status = output("git", [
    "-c",
    `safe.directory=${normalizedRoot}`,
    "status",
    "--porcelain=v1",
  ]);
  const stagedPaths = output("git", [
    "-c",
    `safe.directory=${normalizedRoot}`,
    "diff",
    "--cached",
    "--name-only",
  ])
    .split(/\r?\n/u)
    .map((entry) => entry.trim().replaceAll("\\", "/"))
    .filter(Boolean);
  const invalid = status
    .split(/\r?\n/u)
    .filter(Boolean)
    .filter((line) => line.startsWith("??") || line[1] !== " ");
  const unexpected = stagedPaths.filter((entry) => !intendedPhase132Paths.has(entry));
  const missing = [...intendedPhase132Paths].filter((entry) => !stagedPaths.includes(entry));
  const passed =
    whitespace.status === 0 &&
    Boolean(status) &&
    invalid.length === 0 &&
    unexpected.length === 0 &&
    missing.length === 0;
  record(label, passed);
  if (!passed) {
    throw new Error(
      whitespace.status !== 0
        ? whitespace.stdout || whitespace.stderr || "The staged diff has whitespace errors."
        : invalid.length > 0
          ? `Only intentionally staged files are allowed: ${invalid.join(", ")}`
          : unexpected.length > 0
            ? `Unexpected staged Phase 1.3.2 paths: ${unexpected.join(", ")}`
            : missing.length > 0
              ? `Missing staged Phase 1.3.2 paths: ${missing.join(", ")}`
              : "The Phase 1.3.2 staged diff is empty.",
    );
  }
  process.stdout.write("PHASE1_3_2_STAGED_STATE=PASS\n");
}

try {
  verifyToolchain();
  run("Repository boundary", process.execPath, ["scripts/repository-boundary.mjs"]);
  verifyStartingState();
  run("Source integrity", pnpm, ["source:verify"]);
  run("Format", pnpm, ["format"]);
  run("Format check", pnpm, ["format:check"]);
  run("Lint", pnpm, ["lint"]);
  run("Typecheck", pnpm, ["typecheck"]);
  run("AI Command structural component tests", pnpm, [
    "exec",
    "vitest",
    "run",
    "tests/component/phase132-seamless-tiles.test.tsx",
    "--config",
    "vitest.component.config.ts",
  ]);
  run("Left-tile visual tests", pnpm, [
    "exec",
    "vitest",
    "run",
    "tests/component/phase131-pro-theme.test.tsx",
    "--config",
    "vitest.component.config.ts",
  ]);
  run("Right-tile renderer tests", pnpm, [
    "exec",
    "vitest",
    "run",
    "tests/component/workspace-renderer.test.tsx",
    "--config",
    "vitest.component.config.ts",
  ]);
  run("Divider regression", pnpm, [
    "exec",
    "vitest",
    "run",
    "tests/component/phase11-motion.test.tsx",
    "-t",
    "resizes the AI split",
    "--config",
    "vitest.component.config.ts",
  ]);
  run("Responsive regression", pnpm, [
    "exec",
    "vitest",
    "run",
    "tests/component/phase132-seamless-tiles.test.tsx",
    "-t",
    "compact Conversation/Workspace tab contract",
    "--config",
    "vitest.component.config.ts",
  ]);
  run("Voice transient-state regression", pnpm, [
    "exec",
    "vitest",
    "run",
    "tests/component/phase132-seamless-tiles.test.tsx",
    "-t",
    "simulated transcript review only while active",
    "--config",
    "vitest.component.config.ts",
  ]);
  run("Progressive-control regression", pnpm, [
    "exec",
    "vitest",
    "run",
    "tests/component/phase132-seamless-tiles.test.tsx",
    "-t",
    "progressively disclosed",
    "--config",
    "vitest.component.config.ts",
  ]);
  run("Persona preservation regression", pnpm, [
    "exec",
    "vitest",
    "run",
    "tests/unit/phase131-persona-brand.test.ts",
    "--config",
    "vitest.unit.config.ts",
  ]);
  run("Artifact-brand preservation regression", pnpm, [
    "exec",
    "vitest",
    "run",
    "packages/artifacts/src/manifest.test.ts",
    "packages/artifacts/src/pdf.test.ts",
    "--config",
    "vitest.unit.config.ts",
  ]);
  run("OpenAI-settings reachability regression", pnpm, [
    "exec",
    "vitest",
    "run",
    "tests/component/openai-administration.test.tsx",
    "--config",
    "vitest.component.config.ts",
  ]);
  run("Responses streaming fixture smoke", pnpm, [
    "exec",
    "vitest",
    "run",
    "tests/component/ai-command-workspace.test.tsx",
    "-t",
    "streams general provider work incrementally",
    "--config",
    "vitest.component.config.ts",
  ]);
  run("Web-search and citation fixture smoke", pnpm, [
    "exec",
    "vitest",
    "run",
    "tests/component/ai-command-workspace.test.tsx",
    "-t",
    "safe HTTPS citation|safe web-search default",
    "--config",
    "vitest.component.config.ts",
  ]);
  run("Realtime fake-media smoke", process.execPath, [
    "scripts/verify-phase1-2.mjs",
    "--webrtc-browser",
  ]);
  run("PDF.js regression", pnpm, [
    "exec",
    "vitest",
    "run",
    "tests/component/workspace-renderer.test.tsx",
    "-t",
    "controlled PDF viewer",
    "--config",
    "vitest.component.config.ts",
  ]);
  run("Task-action regression", pnpm, [
    "exec",
    "vitest",
    "run",
    "tests/component/ai-command-workspace.test.tsx",
    "-t",
    "explicit dialog confirmation",
    "--config",
    "vitest.component.config.ts",
  ]);
  run("Production build", pnpm, ["build"]);
  run("Production Chromium visual acceptance", pnpm, [
    "exec",
    "playwright",
    "test",
    "tests/e2e/command-center.spec.ts",
    "tests/e2e/phase132-visual-evidence.spec.ts",
    "--grep",
    "captures Phase 1.3.2 production visual evidence|keeps AI Command panels matched|keeps AI Command capabilities and divider operable",
    "--project=chromium-desktop",
  ]);
  run("Windows Doctor", "cmd.exe", ["/d", "/c", "BEA-Doctor.cmd", "--check"]);
  run("Windows Start", "cmd.exe", ["/d", "/c", "Start-BEA-Demo.cmd", "--no-open", "--seed"]);
  run("Windows Stop", "cmd.exe", ["/d", "/c", "Stop-BEA-Demo.cmd"]);
  run("Dependency audit", pnpm, ["security:audit"]);
  run("Secret scan", process.execPath, ["scripts/secret-scan.mjs"]);
  run("Inventory reconciliation", process.execPath, ["scripts/file-inventory.mjs"]);
  verifyStagedState();
  if (results.length !== 31) {
    throw new Error(`Expected exactly 31 Phase 1.3.2 gates; recorded ${results.length}.`);
  }
  console.table(results);
  process.stdout.write("PHASE1_3_2_VERIFICATION=PASS\n");
} catch (error) {
  console.table(results);
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.stdout.write("PHASE1_3_2_VERIFICATION=FAIL\n");
  process.exitCode = 1;
}
