import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const pnpm = isWindows ? "pnpm.cmd" : "pnpm";
const skipEndToEnd = process.argv.includes("--skip-e2e");
const skipOwnerLauncher = process.argv.includes("--skip-owner-launcher");
const verificationEnvironment = {
  ...process.env,
  APP_MODE: "demo",
  APP_BASE_URL: "http://127.0.0.1:3000",
  DATABASE_DRIVER: "pglite",
  DEMO_DATABASE_PATH: ".data/phase1-verification",
  WORKER_DEMO_DATABASE_PATH: "memory://",
  DEMO_AUTH_ENABLED: "true",
  SESSION_TTL_MINUTES: "480",
  WORKER_MODE: "once",
  WORKER_QUEUE_ADAPTER: "inline",
  WORKER_POLL_INTERVAL_MS: "60000",
  WORKER_HEALTH_PORT: "33101",
  LOG_LEVEL: "silent",
  DEMO_RESET_CONFIRMATION: "RESET_BEA_DEMO_DATA",
};
const results = [];
let databaseBoundaryStarted = false;

function execute(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: verificationEnvironment,
    encoding: "utf8",
    shell: isWindows && (command.endsWith(".cmd") || command === pnpm),
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (options.capture) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  return result.status ?? 1;
}

function commandGate(number, name, command, args, options = {}) {
  console.log(`\n==> ${number}. ${name}`);
  const exitCode = execute(command, args, options);
  results.push({ number, name, result: exitCode === 0 ? "PASS" : "FAIL", exitCode });
  if (exitCode !== 0) throw new Error(`${name} failed with exit code ${exitCode}.`);
}

function customGate(number, name, callback) {
  console.log(`\n==> ${number}. ${name}`);
  const exitCode = callback();
  results.push({ number, name, result: exitCode === 0 ? "PASS" : "FAIL", exitCode });
  if (exitCode !== 0) throw new Error(`${name} failed with exit code ${exitCode}.`);
}

function skippedGate(number, name) {
  console.log(`\n==> ${number}. ${name}: NOT_RUN`);
  results.push({ number, name, result: "NOT_RUN", exitCode: null });
}

function pnpmGate(number, name, ...args) {
  commandGate(number, name, pnpm, args);
}

try {
  commandGate(1, "Repository boundary", "node", ["scripts/repository-boundary.mjs"]);
  pnpmGate(2, "Source integrity", "source:verify");
  commandGate(3, "Frozen dependency installation", pnpm, ["install", "--frozen-lockfile"]);
  pnpmGate(4, "Formatting", "format");
  pnpmGate(5, "Format check", "format:check");
  pnpmGate(6, "Lint", "lint");
  pnpmGate(7, "Type checking", "typecheck");
  pnpmGate(8, "Unit tests", "test:unit");
  pnpmGate(9, "Component tests", "test:component");
  pnpmGate(10, "Integration tests", "test:integration");

  customGate(11, "Database migration", () => {
    const start = execute(pnpm, ["db:start"]);
    if (start !== 0) return start;
    databaseBoundaryStarted = true;
    return execute(pnpm, ["db:migrate"]);
  });
  customGate(12, "Repeatable seed", () => {
    const first = execute(pnpm, ["db:seed"]);
    return first === 0 ? execute(pnpm, ["db:seed"]) : first;
  });
  customGate(13, "Demo reset safety", () => {
    const reset = execute(pnpm, ["demo:reset"]);
    if (reset !== 0) return reset;
    return execute(pnpm, ["db:seed"]);
  });

  commandGate(14, "AI Command intent tests", pnpm, [
    "exec",
    "vitest",
    "run",
    "--config",
    "vitest.unit.config.ts",
    "tests/unit/ai-command-router.test.ts",
  ]);
  commandGate(15, "Action-preview tests", pnpm, [
    "exec",
    "vitest",
    "run",
    "--config",
    "vitest.component.config.ts",
    "tests/component/workspace-renderer.test.tsx",
    "-t",
    "confirmation",
  ]);
  commandGate(16, "Action-confirmation tests", pnpm, [
    "exec",
    "vitest",
    "run",
    "--config",
    "vitest.integration.config.ts",
    "tests/integration/phase1-database.test.ts",
    "-t",
    "requires exact confirmation",
  ]);
  commandGate(17, "Idempotency tests", pnpm, [
    "exec",
    "vitest",
    "run",
    "--config",
    "vitest.integration.config.ts",
    "tests/integration/phase1-database.test.ts",
    "-t",
    "executes a confirmed task once",
  ]);
  commandGate(18, "Role and permission tests", pnpm, [
    "exec",
    "vitest",
    "run",
    "--config",
    "vitest.unit.config.ts",
    "tests/unit/rbac.test.ts",
  ]);

  pnpmGate(19, "Web build", "build:web");
  pnpmGate(20, "Worker build", "build:worker");
  pnpmGate(21, "Full monorepo build", "build");
  pnpmGate(22, "Built-server startup", "smoke:web");
  pnpmGate(23, "Worker startup", "smoke:worker");
  if (skipEndToEnd) {
    skippedGate(24, "Health checks");
    skippedGate(25, "End-to-end tests");
  } else {
    commandGate(24, "Health checks", pnpm, [
      "exec",
      "playwright",
      "test",
      "--grep",
      "reports database, worker, and simulated provider health",
    ]);
    pnpmGate(25, "End-to-end tests", "test:e2e");
  }

  commandGate(26, "Windows doctor test", "cmd.exe", ["/d", "/c", "BEA-Doctor.cmd", "--check"]);
  if (skipOwnerLauncher) {
    skippedGate(27, "Windows start/stop launcher test");
  } else {
    customGate(27, "Windows start/stop launcher test", () => {
      const start = execute("cmd.exe", ["/d", "/c", "Start-BEA-Demo.cmd", "--no-open", "--seed"]);
      const stop = execute("cmd.exe", ["/d", "/c", "Stop-BEA-Demo.cmd"]);
      return start === 0 && stop === 0 ? 0 : start || stop || 1;
    });
  }

  pnpmGate(28, "Dependency audit", "security:audit");
  pnpmGate(29, "Secret scan", "security:secrets");
  pnpmGate(30, "Repository inventory reconciliation", "inventory:verify");
  customGate(31, "Staged-diff check", () => {
    const safeRoot = repositoryRoot.replaceAll("\\", "/");
    const check = execute("git", [
      "-c",
      `safe.directory=${safeRoot}`,
      "diff",
      "--cached",
      "--check",
    ]);
    if (check !== 0) return check;
    const empty = spawnSync(
      "git",
      ["-c", `safe.directory=${safeRoot}`, "diff", "--cached", "--quiet"],
      { cwd: repositoryRoot, stdio: "ignore" },
    ).status;
    if (empty === 0) {
      console.error("No staged Phase 1 diff is available for final verification.");
      return 1;
    }
    return empty === 1 ? 0 : (empty ?? 1);
  });
  customGate(32, "Git status", () => {
    const safeRoot = repositoryRoot.replaceAll("\\", "/");
    const status = spawnSync(
      "git",
      ["-c", `safe.directory=${safeRoot}`, "status", "--porcelain=v1"],
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
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  if (databaseBoundaryStarted) {
    console.log("\n==> Demo database shutdown boundary");
    const stopCode = execute(pnpm, ["db:stop"]);
    if (stopCode !== 0) process.exitCode = 1;
  }
  console.table(results);
}

if (!process.exitCode && (skipEndToEnd || skipOwnerLauncher)) {
  console.log("PHASE1_VERIFICATION=BLOCKED_REQUIRED_GATE_NOT_RUN");
  process.exitCode = 2;
} else if (!process.exitCode) {
  console.log("PHASE1_VERIFICATION=PASS");
} else {
  console.log("PHASE1_VERIFICATION=FAIL");
}
