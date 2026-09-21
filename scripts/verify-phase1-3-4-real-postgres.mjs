import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertRepositoryBoundary } from "./repository-boundary.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DISPOSABLE_POSTGRES_CONFIRMATION_PREFIX = "RUN PHASE134 AGAINST ";

export function inspectRealPostgresPrerequisite(environment = process.env) {
  const value = environment.BEA_PHASE134_REAL_POSTGRES_URL?.trim() ?? "";
  const confirmation = environment.BEA_PHASE134_REAL_POSTGRES_DISPOSABLE_CONFIRMATION?.trim() ?? "";
  if (!value && !confirmation) {
    return Object.freeze({
      ready: false,
      status: "OWNER_PREREQUISITE_REQUIRED",
      detail:
        "Supply an explicit disposable real PostgreSQL URL and its exact database-name confirmation.",
    });
  }
  if (!value || !confirmation) {
    throw new Error("The URL and disposable-database confirmation must be supplied together.");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The disposable PostgreSQL URL is invalid.");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    !url.username ||
    !url.pathname.slice(1) ||
    url.hash
  ) {
    throw new Error("The disposable PostgreSQL URL is incomplete or unsafe.");
  }
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!/(?:phase[_-]?134|test|disposable)/iu.test(database)) {
    throw new Error(
      "The real PostgreSQL gate refuses a database whose name does not contain phase134, test, or disposable.",
    );
  }
  if (confirmation !== `${DISPOSABLE_POSTGRES_CONFIRMATION_PREFIX}${database}`) {
    throw new Error(
      `Set BEA_PHASE134_REAL_POSTGRES_DISPOSABLE_CONFIRMATION to ${DISPOSABLE_POSTGRES_CONFIRMATION_PREFIX}<exact database name>.`,
    );
  }
  return Object.freeze({ ready: true, status: "READY", database, url: value });
}

function verificationEnvironment(source, prerequisite) {
  const keys = [
    "APPDATA",
    "ComSpec",
    "COMSPEC",
    "FORCE_COLOR",
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
  ];
  const environment = Object.fromEntries(
    keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
  );
  return {
    ...environment,
    BEA_DISABLE_ENV_FILE: "true",
    BEA_PHASE134_POSTGRES_TOOLS_DIRECTORY: source.BEA_PHASE134_POSTGRES_TOOLS_DIRECTORY ?? "",
    BEA_PHASE134_REAL_POSTGRES_DISPOSABLE_CONFIRMATION:
      source.BEA_PHASE134_REAL_POSTGRES_DISPOSABLE_CONFIRMATION,
    BEA_PHASE134_REAL_POSTGRES_TLS_MODE: source.BEA_PHASE134_REAL_POSTGRES_TLS_MODE ?? "prefer",
    BEA_PHASE134_REAL_POSTGRES_URL: prerequisite.url,
    CI: "1",
    FORCE_COLOR: "0",
    NODE_NO_WARNINGS: "",
    NODE_OPTIONS: "--trace-warnings",
    NODE_REDIRECT_WARNINGS: "",
  };
}

export function runRealPostgresGate(environment = process.env, run = spawnSync) {
  assertRepositoryBoundary({ cwd: repositoryRoot, target: repositoryRoot });
  const prerequisite = inspectRealPostgresPrerequisite(environment);
  if (!prerequisite.ready) {
    process.stdout.write(
      `${JSON.stringify({ code: "BEA_PHASE134_REAL_POSTGRES", ...prerequisite })}\n`,
    );
    return 0;
  }
  const vitest = path.join(repositoryRoot, "node_modules", "vitest", "vitest.mjs");
  if (!existsSync(vitest)) {
    throw new Error("The locked Vitest dependency is unavailable; run the guarded frozen install.");
  }
  const result = run(
    process.execPath,
    [
      vitest,
      "run",
      "tests/integration/phase134-real-postgres.test.ts",
      "--config",
      "vitest.integration.config.ts",
    ],
    {
      cwd: repositoryRoot,
      env: verificationEnvironment(environment, prerequisite),
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    },
  );
  const exitCode = result.status ?? (result.error ? 1 : 0);
  if (exitCode !== 0) return exitCode;
  process.stdout.write(
    `${JSON.stringify({ code: "BEA_PHASE134_REAL_POSTGRES", status: "PASS", database: prerequisite.database })}\n`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) {
      throw new Error("Usage: node scripts/verify-phase1-3-4-real-postgres.mjs");
    }
    process.exitCode = runRealPostgresGate();
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ code: "BEA_PHASE134_REAL_POSTGRES", status: "BLOCKED", errorName: error instanceof Error ? error.name : "UnknownError" })}\n`,
    );
    process.exitCode = 1;
  }
}
