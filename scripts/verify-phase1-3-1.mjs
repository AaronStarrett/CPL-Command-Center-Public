import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const normalizedRoot = repositoryRoot.replaceAll("\\", "/");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const startingCommit = "8f86e65b1a1aa6a1a58e65735902cc9fbff8ed29";
const results = [];
const environment = {
  ...process.env,
  APP_BASE_URL: "http://127.0.0.1:3000",
  APP_MODE: "demo",
  BEA_DISABLE_ENV_FILE: "true",
  DATABASE_DRIVER: "pglite",
  DEMO_AUTH_ENABLED: "true",
  DEMO_DATABASE_PATH: ".data/phase1-3-1-verification",
  DEMO_RESET_CONFIRMATION: "RESET_BEA_DEMO_DATA",
  LOG_LEVEL: "silent",
  OPENAI_API_KEY: "",
  SESSION_TTL_MINUTES: "480",
  WORKER_DEMO_DATABASE_PATH: "memory://",
  WORKER_HEALTH_PORT: "33131",
  WORKER_MODE: "once",
  WORKER_POLL_INTERVAL_MS: "60000",
  WORKER_QUEUE_ADAPTER: "inline",
};

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
    throw new Error(`${label} could not start: ${result.error.message}`);
  }
  const exitCode = result.status ?? 1;
  results.push({ gate: results.length + 1, label, result: exitCode === 0 ? "PASS" : "FAIL" });
  if (exitCode !== 0) throw new Error(`${label} failed with exit code ${exitCode}.`);
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

function evidence(label, checks) {
  process.stdout.write(`\n==> ${results.length + 1}. ${label}\n`);
  for (const [relativePath, phrases] of checks) {
    const source = readFileSync(path.join(repositoryRoot, relativePath), "utf8");
    for (const phrase of phrases) {
      if (!source.includes(phrase)) {
        results.push({ gate: results.length + 1, label, result: "FAIL" });
        throw new Error(`${label} is missing evidence '${phrase}' in ${relativePath}.`);
      }
    }
  }
  results.push({ gate: results.length + 1, label, result: "PASS" });
  process.stdout.write(`${label}=PASS\n`);
}

function startingState() {
  const head = output("git", ["-c", `safe.directory=${normalizedRoot}`, "rev-parse", "HEAD"]);
  const branch = output("git", [
    "-c",
    `safe.directory=${normalizedRoot}`,
    "symbolic-ref",
    "--short",
    "HEAD",
  ]);
  if (head !== startingCommit || branch !== "main") {
    throw new Error(
      `Expected Phase 1.3.1 starting state ${startingCommit} on main; found ${head} on ${branch}.`,
    );
  }
}

function verifyStagedState() {
  run("Staged diff whitespace", "git", [
    "-c",
    `safe.directory=${normalizedRoot}`,
    "diff",
    "--cached",
    "--check",
  ]);
  const status = output("git", [
    "-c",
    `safe.directory=${normalizedRoot}`,
    "status",
    "--porcelain=v1",
  ]);
  const invalid = status
    .split(/\r?\n/u)
    .filter(Boolean)
    .filter((line) => line.startsWith("??") || line[1] !== " ");
  if (!status || invalid.length > 0) {
    throw new Error(
      invalid.length > 0
        ? `Only intentionally staged files are allowed: ${invalid.join(", ")}`
        : "The Phase 1.3.1 staged diff is empty.",
    );
  }
  process.stdout.write("PHASE1_3_1_STAGED_STATE=PASS\n");
}

try {
  run("Repository boundary", process.execPath, ["scripts/repository-boundary.mjs"]);
  evidence("Starting commit and branch", [["package.json", ['"verify:phase1.3.1"']]]);
  startingState();
  run("Source integrity", pnpm, ["source:verify"]);
  run("Format", pnpm, ["format"]);
  run("Format check", pnpm, ["format:check"]);
  run("Lint", pnpm, ["lint"]);
  run("Type checking", pnpm, ["typecheck"]);
  run("Focused unit and provider tests", pnpm, [
    "exec",
    "vitest",
    "run",
    "tests/unit/phase131-persona-brand.test.ts",
    "tests/unit/openai-administration-backend.test.ts",
    "tests/unit/browser-realtime-voice.test.ts",
    "tests/unit/live-realtime-voice.test.ts",
    "packages/ai/src/openai/phase1-2-openai.test.ts",
    "packages/artifacts/src/manifest.test.ts",
    "packages/artifacts/src/pdf.test.ts",
    "--config",
    "vitest.unit.config.ts",
  ]);
  run("Focused component and visual tests", pnpm, [
    "exec",
    "vitest",
    "run",
    "tests/component/phase131-pro-theme.test.tsx",
    "tests/component/ai-command-workspace.test.tsx",
    "tests/component/phase11-motion.test.tsx",
    "tests/component/application-shell.test.tsx",
    "tests/component/persona-navigation.test.tsx",
    "tests/component/workspace-renderer.test.tsx",
    "tests/component/openai-administration.test.tsx",
    "tests/component/openai-route-transport.test.ts",
    "tests/component/realtime-route-transport.test.ts",
    "--config",
    "vitest.component.config.ts",
  ]);
  run("Focused integration and provenance tests", pnpm, [
    "exec",
    "vitest",
    "run",
    "tests/integration/phase131-policy-provenance.test.ts",
    "tests/integration/artifact-demo-runner.test.ts",
    "tests/integration/artifact-file-store.test.ts",
    "--config",
    "vitest.integration.config.ts",
  ]);
  run("Migration", pnpm, ["db:migrate"]);
  run("Idempotent seed", pnpm, ["db:seed"]);
  run("Idempotent seed repeat", pnpm, ["db:seed"]);
  evidence("Visual layout and light-glass theme", [
    [
      "tests/component/phase131-pro-theme.test.tsx",
      ["centralizes the light clear-glass shell", "36 percent cockpit split"],
    ],
    [
      "tests/component/ai-command-workspace.test.tsx",
      ["publishes the matched-height panel contract"],
    ],
  ]);
  evidence("Header and navigation", [
    [
      "packages/ui/src/styles.css",
      [".bea-application-shell__topbar", ".bea-application-shell__sidebar"],
    ],
  ]);
  evidence("Executive persona and provider context", [
    [
      "tests/unit/phase131-persona-brand.test.ts",
      ["server-owned context", "private personalization"],
    ],
  ]);
  evidence("Realtime persona", [
    [
      "apps/web/app/api/ai-command/realtime/client-secret/route.ts",
      ["providerInstructions", "policyProvenance"],
    ],
  ]);
  evidence("Artifact brand policy and renderers", [
    ["packages/artifacts/src/brand.ts", ["BEA_CHART_PALETTE", "normalizedByApplication"]],
  ]);
  evidence("Executive Profile RBAC", [
    ["packages/security/src/rbac.ts", ["EXECUTIVE_PROFILE_VIEW", "EXECUTIVE_PROFILE_MANAGE"]],
  ]);
  run("Production build", pnpm, ["build"]);
  evidence("Production browser acceptance", [
    ["docs/PHASE_1_3_1_VERIFICATION.md", ["PRODUCTION_BROWSER_ACCEPTANCE=PASS"]],
  ]);
  evidence("OpenAI text and web fixture smoke", [
    ["packages/ai/src/openai/phase1-2-openai.test.ts", ["streams simulated web citations"]],
  ]);
  run("Realtime fake-media smoke", process.execPath, [
    "scripts/verify-phase1-2.mjs",
    "--webrtc-browser",
  ]);
  evidence("PDF.js regression", [
    ["tests/component/workspace-renderer.test.tsx", ["embeds the controlled PDF viewer"]],
  ]);
  run("Windows Doctor", "cmd.exe", ["/d", "/c", "BEA-Doctor.cmd", "--check"]);
  run("Windows Start", "cmd.exe", ["/d", "/c", "Start-BEA-Demo.cmd", "--no-open", "--seed"]);
  run("Windows Stop", "cmd.exe", ["/d", "/c", "Stop-BEA-Demo.cmd"]);
  run("Dependency audit", pnpm, ["security:audit"]);
  run("Secret scan", process.execPath, ["scripts/secret-scan.mjs"]);
  run("Inventory reconciliation", process.execPath, ["scripts/file-inventory.mjs"]);
  verifyStagedState();
  console.table(results);
  process.stdout.write("PHASE1_3_1_VERIFICATION=PASS\n");
} catch (error) {
  console.table(results);
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.stdout.write("PHASE1_3_1_VERIFICATION=FAIL\n");
  process.exitCode = 1;
}
