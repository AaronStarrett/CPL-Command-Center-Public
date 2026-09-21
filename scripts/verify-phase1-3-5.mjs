import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PHASE1_3_5_INTENDED_FILES,
  PHASE1_3_5_STARTING_COMMIT,
  assertExactPhase1_3_5Paths,
} from "./phase1-3-5-intended-files.mjs";
import { auditLocalStorage, verifyPrivateRemote } from "./local-storage-audit.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const normalizedRoot = repositoryRoot.replaceAll("\\", "/");
const pnpm =
  process.env.BEA_PHASE135_PINNED_PNPM_EXECUTABLE?.trim() ||
  (process.platform === "win32" ? "pnpm.cmd" : "pnpm");

export const PHASE1_3_5_NODE_VERSION = "24.19.0";
export const PHASE1_3_5_PNPM_VERSION = "11.19.0";

export const PHASE1_3_5_GATE_DEFINITIONS = Object.freeze([
  [1, "Repository boundary"],
  [2, "Starting commit and intended tree"],
  [3, "Complete current-tree secret scan"],
  [4, "Complete Git-history secret scan"],
  [5, "Large-object scan"],
  [6, "Repository-size report"],
  [7, "Private GitHub repository creation"],
  [8, "Remote origin verification"],
  [9, "Full main-history push"],
  [10, "Remote/local HEAD equality"],
  [11, "Private visibility verification"],
  [12, "Branch tracking"],
  [13, "GitHub Actions syntax"],
  [14, "CI configuration"],
  [15, "Dependabot configuration"],
  [16, "CODEOWNERS"],
  [17, "Cloud architecture documents"],
  [18, "Provider-neutral deployment scaffolding"],
  [19, "Multi-tenancy architecture"],
  [20, "Storage and memory architecture"],
  [21, "Digital Workforce architecture"],
  [22, "Bridge Agent architecture"],
  [23, "Current data-location audit"],
  [24, "Cleanup dry run"],
  [25, "Safe cleanup execution"],
  [26, "Before/after disk report"],
  [27, "Source integrity"],
  [28, "Working-tree cleanliness"],
  [29, "Protected-repository confirmation"],
  [30, "No unintended process or cloud-resource change"],
  [31, "Azure not required initially"],
  [32, "Supabase PostgreSQL and optional Auth boundaries"],
  [33, "Cloudflare R2 primary object storage"],
  [34, "OneDrive default and Google Drive optional"],
  [35, "PostgreSQL/pgvector memory model"],
  [36, "GitHub excluded from runtime/customer data"],
  [37, "Drive connectors excluded from transactional database"],
  [38, "Application-host comparison"],
  [39, "Provider-neutral container contracts"],
  [40, "No cloud credential committed"],
  [41, "Non-regenerable local data preservation"],
  [42, "Focused Phase 1.3.5 tests"],
  [43, "Credential-free integration tests"],
  [44, "Dependency and inventory gates"],
]);

const safeEnvironmentKeys = Object.freeze([
  "APPDATA",
  "ComSpec",
  "COMSPEC",
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
  "USERPROFILE",
  "WINDIR",
]);

export function createPhase1_3_5Environment(source = {}) {
  const environment = {};
  for (const key of safeEnvironmentKeys) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  const inheritedPath = environment.Path ?? environment.PATH ?? "";
  const pinnedPath = inheritedPath
    ? path.dirname(process.execPath) + path.delimiter + inheritedPath
    : path.dirname(process.execPath);
  return {
    ...environment,
    APP_MODE: "demo",
    BEA_DISABLE_ENV_FILE: "true",
    BEA_REPOSITORY_ROOT: repositoryRoot,
    CI: "true",
    DATABASE_DRIVER: "pglite",
    DATABASE_URL: "",
    DEMO_AUTH_ENABLED: "true",
    DEMO_DATABASE_PATH: ".data/phase1-3-5-verification",
    FORCE_COLOR: "0",
    GITHUB_TOKEN: "",
    GH_TOKEN: "",
    LOG_LEVEL: "silent",
    NEXT_TELEMETRY_DISABLED: "1",
    NPM_TOKEN: "",
    OPENAI_API_KEY: "",
    R2_ACCESS_KEY_ID: "",
    R2_SECRET_ACCESS_KEY: "",
    SESSION_SECRET: "",
    SUPABASE_ACCESS_TOKEN: "",
    TURBO_TELEMETRY_DISABLED: "1",
    WORKER_DEMO_DATABASE_PATH: "memory://",
    PATH: pinnedPath,
    Path: pinnedPath,
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

export function runPhase1_3_5Command(command, arguments_, options = {}) {
  const environment = options.environment ?? createPhase1_3_5Environment(process.env);
  const invocation = invocationFor(command, arguments_, environment);
  const result = spawnSync(invocation.executable, invocation.arguments, {
    cwd: repositoryRoot,
    encoding: options.capture ? "utf8" : undefined,
    env: environment,
    maxBuffer: options.capture ? 64 * 1024 * 1024 : undefined,
    shell: false,
    stdio: options.capture ? "pipe" : "inherit",
    windowsHide: true,
  });
  return {
    error: result.error,
    exitCode: result.status ?? (result.error ? 1 : 0),
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function captured(command, arguments_, environment) {
  const result = runPhase1_3_5Command(command, arguments_, { capture: true, environment });
  if (result.error || result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "CAPTURED_COMMAND_FAILED");
  }
  return result.stdout.trim();
}

function git(arguments_, environment) {
  return captured("git", ["-c", "safe.directory=" + normalizedRoot, ...arguments_], environment);
}

export function inspectPhase1_3_5Scope(environment = createPhase1_3_5Environment(process.env)) {
  const branch = git(["branch", "--show-current"], environment);
  const ancestor = runPhase1_3_5Command(
    "git",
    [
      "-c",
      "safe.directory=" + normalizedRoot,
      "merge-base",
      "--is-ancestor",
      PHASE1_3_5_STARTING_COMMIT,
      "HEAD",
    ],
    { capture: true, environment },
  );
  const changed = git(["diff", "--name-only", PHASE1_3_5_STARTING_COMMIT + "..HEAD"], environment)
    .split(/\r?\n/u)
    .filter(Boolean);
  const worktreeChanged = git(["diff", "--name-only"], environment).split(/\r?\n/u).filter(Boolean);
  const staged = git(["diff", "--cached", "--name-only"], environment)
    .split(/\r?\n/u)
    .filter(Boolean);
  const untracked = git(["ls-files", "--others", "--exclude-standard"], environment)
    .split(/\r?\n/u)
    .filter(Boolean);
  return {
    branch,
    startingCommitIsAncestor: ancestor.exitCode === 0,
    paths: [...new Set([...changed, ...worktreeChanged, ...staged, ...untracked])].sort(),
  };
}

export function assertPhase1_3_5Toolchain(nodeVersion, pnpmVersion) {
  if (String(nodeVersion).replace(/^v/u, "") !== PHASE1_3_5_NODE_VERSION) {
    throw new Error("Phase 1.3.5 requires exact Node " + PHASE1_3_5_NODE_VERSION);
  }
  if (String(pnpmVersion).trim() !== PHASE1_3_5_PNPM_VERSION) {
    throw new Error("Phase 1.3.5 requires exact pnpm " + PHASE1_3_5_PNPM_VERSION);
  }
}

function runRequired(label, command, arguments_, environment) {
  process.stdout.write("PHASE1_3_5_GATE_START=" + label + "\n");
  const result = runPhase1_3_5Command(command, arguments_, { environment });
  if (result.error || result.exitCode !== 0) {
    throw new Error(label + " failed with exit code " + String(result.exitCode));
  }
  process.stdout.write("PHASE1_3_5_GATE_PASS=" + label + "\n");
}

export function phase1_3_5ExternalEvidenceDefaults() {
  return Object.freeze({
    publication: "NOT_RUN",
    containerBuilds: "NOT_RUN_LOCAL_CI_REQUIRED",
    safeCleanup: "NOT_RUN",
    cloudDeployment: "NOT_RUN",
    providerConnections: "NOT_CONNECTED",
    dataMigration: "NOT_RUN",
    ownerAcceptance: "NOT_RUN",
  });
}

export async function runLocalVerification() {
  const environment = createPhase1_3_5Environment(process.env);
  assertPhase1_3_5Toolchain(process.version, captured(pnpm, ["--version"], environment));
  const scope = inspectPhase1_3_5Scope(environment);
  if (scope.branch !== "main" || !scope.startingCommitIsAncestor) {
    throw new Error("Phase 1.3.5 requires main with the approved starting commit retained");
  }
  assertExactPhase1_3_5Paths(scope.paths);

  const commands = [
    ["boundary-first", process.execPath, ["scripts/repository-boundary.mjs"]],
    ["source-integrity", pnpm, ["source:verify"]],
    ["current-secret-scan", pnpm, ["security:secrets"]],
    ["history-secret-scan", pnpm, ["security:history"]],
    ["repository-health", pnpm, ["repository:health"]],
    ["deployment-contracts-and-actions-yaml", pnpm, ["deployment:validate"]],
    ["format-check", pnpm, ["format:check"]],
    ["lint", pnpm, ["lint"]],
    ["typecheck", pnpm, ["typecheck"]],
    [
      "focused-phase135-unit",
      pnpm,
      [
        "exec",
        "vitest",
        "run",
        "tests/unit/phase135-architecture-contracts.test.ts",
        "tests/unit/phase135-deployment-scaffolding.test.mjs",
        "tests/unit/phase135-history-security.test.mjs",
        "tests/unit/phase135-local-storage-audit.test.mjs",
        "tests/unit/phase135-verifier.test.mjs",
        "--config",
        "vitest.unit.config.ts",
      ],
    ],
    ["credential-free-integration", pnpm, ["test:integration"]],
    ["dependency-audit", pnpm, ["security:audit"]],
    ["inventory", pnpm, ["inventory:verify"]],
  ];
  for (const [label, command, arguments_] of commands) {
    runRequired(label, command, arguments_, environment);
  }
  process.stdout.write("PHASE1_3_5_GATE_START=cleanup-dry-run\n");
  const audit = await auditLocalStorage("dry-run");
  if (audit.exitCode !== 0 || audit.output.status !== "DRY_RUN_COMPLETE") {
    throw new Error("cleanup-dry-run failed");
  }
  process.stdout.write(
    "PHASE1_3_5_CLEANUP_DRY_RUN=" +
      JSON.stringify({
        status: audit.output.status,
        guards: audit.output.guards,
        totals: audit.output.totals,
        protectedRepositoryEntered: audit.output.protectedRepositoryEntered,
      }) +
      "\n",
  );
  process.stdout.write("PHASE1_3_5_GATE_PASS=cleanup-dry-run\n");
  runRequired("boundary-final", process.execPath, ["scripts/repository-boundary.mjs"], environment);
  const endingScope = inspectPhase1_3_5Scope(environment);
  assertExactPhase1_3_5Paths(endingScope.paths);
  process.stdout.write(
    "PHASE1_3_5_LOCAL_VERIFICATION=PASS files=" + String(PHASE1_3_5_INTENDED_FILES.length) + "\n",
  );
  process.stdout.write("PHASE1_3_5_PUBLICATION=NOT_RUN\n");
  process.stdout.write("PHASE1_3_5_SAFE_CLEANUP=NOT_RUN\n");
  process.stdout.write("PHASE1_3_5_CLOUD_DEPLOYMENT=NOT_RUN\n");
}

export function runPublicationVerification() {
  const remote = verifyPrivateRemote();
  if (remote.status !== "VERIFIED") {
    throw new Error("Private publication verification blocked: " + remote.blockers.join(","));
  }
  process.stdout.write("PHASE1_3_5_PUBLICATION=PASS\n");
  process.stdout.write(JSON.stringify({ code: "BEA_PRIVATE_PUBLICATION_VERIFIED", remote }) + "\n");
}

async function main() {
  const mode = process.argv[2] ?? "--local";
  if (!["--local", "--publication"].includes(mode) || process.argv.length > 3) {
    throw new Error("Usage: node scripts/verify-phase1-3-5.mjs [--local|--publication]");
  }
  if (mode === "--publication") runPublicationVerification();
  else await runLocalVerification();
}

export function phase1_3_5FailurePrefix(mode) {
  return mode === "--publication"
    ? "PHASE1_3_5_PUBLICATION=FAIL "
    : "PHASE1_3_5_LOCAL_VERIFICATION=FAIL ";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const requestedMode = process.argv[2] ?? "--local";
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      phase1_3_5FailurePrefix(requestedMode) +
        (error instanceof Error ? error.message : "UNKNOWN_FAILURE") +
        "\n",
    );
    process.exitCode = 1;
  }
}
