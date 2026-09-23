import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import fileSystemPromises from "node:fs/promises";

import { assertRepositoryBoundary } from "./repository-boundary.mjs";
import { installBuildReadlinkCompatibility } from "./next-build-filesystem.mjs";
import { assertNoLocalDevelopmentConfiguration } from "./local-development-policy.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const webPackagePath = path.join(repositoryRoot, "apps", "web", "package.json");

const nextLaunchStages = new Set([
  "boundary",
  "resolve-next-cli",
  "resolve-next-environment",
  "create-next-environment-directory",
  "load-next-environment",
  "prime-next-environment",
  "import-next-cli",
  "cleanup-next-environment",
  "unknown",
]);
const safeErrorCategories = new Map([
  ["MODULE_NOT_FOUND", "MODULE_NOT_FOUND"],
  ["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"],
  ["ERR_UNSUPPORTED_ESM_URL_SCHEME", "UNSUPPORTED_MODULE_URL"],
  ["ERR_INVALID_URL", "INVALID_MODULE_URL"],
  ["ENOENT", "NOT_FOUND"],
  ["EACCES", "ACCESS_DENIED"],
  ["EPERM", "PERMISSION_DENIED"],
  ["EBUSY", "RESOURCE_BUSY"],
  ["ERR_REQUIRE_ESM", "MODULE_FORMAT_MISMATCH"],
  ["ERR_UNKNOWN_FILE_EXTENSION", "MODULE_FORMAT_MISMATCH"],
]);

class NextLaunchStageError extends Error {
  constructor(stage, cause) {
    super("Next launcher stage failed safely.");
    this.name = "NextLaunchStageError";
    this.stage = nextLaunchStages.has(stage) ? stage : "unknown";
    this.cause = cause;
  }
}

function asNextLaunchStageError(stage, error) {
  return error instanceof NextLaunchStageError ? error : new NextLaunchStageError(stage, error);
}

function runNextLaunchStage(stage, operation) {
  try {
    return operation();
  } catch (error) {
    throw asNextLaunchStageError(stage, error);
  }
}

async function runNextLaunchStageAsync(stage, operation) {
  try {
    return await operation();
  } catch (error) {
    throw asNextLaunchStageError(stage, error);
  }
}

export function safeNextLaunchDiagnostic(error) {
  const failure = asNextLaunchStageError("unknown", error);
  const cause = failure.cause;
  const errorCode = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
  return {
    code: "BEA_NEXT_LAUNCH_FAILED",
    message: "Next launch failed safely.",
    stage: failure.stage,
    category:
      typeof errorCode === "string"
        ? (safeErrorCategories.get(errorCode) ?? "UNCLASSIFIED")
        : "UNCLASSIFIED",
  };
}

export function resolveNextEnvironmentModule() {
  const webRequire = createRequire(webPackagePath);
  const nextRequire = createRequire(webRequire.resolve("next/package.json"));
  return nextRequire("@next/env");
}

export function primeNextEnvironment(options = {}) {
  const environmentModule =
    options.environmentModule ??
    runNextLaunchStage("resolve-next-environment", resolveNextEnvironmentModule);
  const safeDirectory =
    options.safeDirectory ??
    runNextLaunchStage("create-next-environment-directory", () =>
      mkdtempSync(path.join(tmpdir(), "bea-next-empty-env-")),
    );
  runNextLaunchStage("load-next-environment", () =>
    environmentModule.loadEnvConfig(safeDirectory, false, options.logger ?? console, true),
  );
  return {
    safeDirectory,
    remove() {
      if (options.safeDirectory === undefined) {
        runNextLaunchStage("cleanup-next-environment", () =>
          rmSync(safeDirectory, { force: true, recursive: true }),
        );
      }
    },
  };
}

export async function runNextWithoutRepositoryEnv(
  arguments_ = process.argv.slice(2),
  options = {},
) {
  const environment = options.environment ?? process.env;
  const assertBoundary = options.assertBoundary ?? assertRepositoryBoundary;
  const createWebRequire = options.createWebRequire ?? createRequire;
  const primeEnvironment = options.primeEnvironment ?? primeNextEnvironment;
  const importNextCli = options.importNextCli ?? ((specifier) => import(specifier));

  runNextLaunchStage("boundary", () => assertBoundary({ target: repositoryRoot }));
  if (["build", "start"].includes(arguments_[0]))
    assertNoLocalDevelopmentConfiguration(environment);
  // The CLI schedules its build asynchronously, so this process-local adapter
  // must live through final output tracing. Dev/start do not install it.
  installBuildReadlinkCompatibility({
    command: arguments_[0],
    fileSystem: fileSystemPromises,
    root: repositoryRoot,
  });
  const webRequire = runNextLaunchStage("resolve-next-cli", () => createWebRequire(webPackagePath));
  const nextCliPath = runNextLaunchStage("resolve-next-cli", () =>
    webRequire.resolve("next/dist/bin/next"),
  );
  const disableEnvironmentFiles = environment.BEA_DISABLE_ENV_FILE?.trim().toLowerCase() === "true";
  const primed = disableEnvironmentFiles
    ? runNextLaunchStage("prime-next-environment", primeEnvironment)
    : null;
  let launchFailure;
  try {
    await runNextLaunchStageAsync("import-next-cli", () =>
      importNextCli(pathToFileURL(nextCliPath).href),
    );
  } catch (error) {
    launchFailure = error;
  }
  try {
    primed?.remove();
  } catch (error) {
    launchFailure ??= asNextLaunchStageError("cleanup-next-environment", error);
  }
  if (launchFailure) {
    throw launchFailure;
  }
  return arguments_;
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(scriptPath);

if (isMain) {
  runNextWithoutRepositoryEnv().catch((error) => {
    const diagnostic = safeNextLaunchDiagnostic(error);
    process.stderr.write(JSON.stringify(diagnostic) + "\n");
    if (diagnostic.stage === "boundary") {
      process.stderr.write(JSON.stringify({ code: "BEA_REPOSITORY_BOUNDARY_REFUSED" }) + "\n");
    }
    process.exitCode = 1;
  });
}
