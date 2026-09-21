import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  EnvironmentValidationError,
  isOwnerEvaluationRuntime,
  parseEnvironment,
  type ServerEnvironment,
} from "./environment.js";
import {
  OWNER_EVALUATION_PROTECTED_SECRET_RELATIVE_PATH,
  parseServerSecrets,
  type ServerSecrets,
} from "./secrets.js";
import { isLoopbackHostname, parseExactHttpOrigin } from "./trusted-origins.js";

export interface LoadedRepositoryEnvironment {
  readonly environment: ServerEnvironment;
  readonly secrets: ServerSecrets;
  readonly repositoryRoot: string;
  readonly envFileLoaded: boolean;
}

export interface RepositoryEnvFileAccess {
  readonly exists: (path: string) => boolean;
  readonly read: (path: string) => string;
}

export function findRepositoryRoot(startDirectory: string): string {
  let current = resolve(startDirectory);
  while (true) {
    const manifestPath = join(current, "package.json");
    const workspacePath = join(current, "pnpm-workspace.yaml");
    if (existsSync(manifestPath) && existsSync(workspacePath)) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error("Unable to locate the BEA workspace root.");
    current = parent;
  }
}

export function parseEnvFile(contents: string): Readonly<Record<string, string>> {
  const parsed: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Z_][A-Z\d_]*)=(.*)$/u.exec(line);
    if (!match) continue;
    const key = match[1];
    let value = match[2]?.trim() ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/u, "").trim();
    }
    if (key) parsed[key] = value;
  }
  return parsed;
}

function isContainedPath(root: string, candidate: string): boolean {
  const relationship = relative(root, candidate);
  return (
    relationship === "" ||
    (relationship !== ".." && !relationship.startsWith(`..${sep}`) && !isAbsolute(relationship))
  );
}

function canonicalizeProspectivePath(candidate: string): string {
  let existingAncestor = candidate;
  const missingSegments: string[] = [];
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) break;
    missingSegments.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }
  const canonicalAncestor = existsSync(existingAncestor)
    ? realpathSync.native(existingAncestor)
    : resolve(existingAncestor);
  return resolve(canonicalAncestor, ...missingSegments);
}

function resolveContainedPglitePath(
  repositoryRoot: string,
  candidate: string,
  environmentKey: "DEMO_DATABASE_PATH" | "WORKER_DEMO_DATABASE_PATH",
): string {
  const lexicalRoot = resolve(repositoryRoot);
  const lexicalCandidate = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(lexicalRoot, candidate);
  if (!isContainedPath(lexicalRoot, lexicalCandidate)) {
    throw new EnvironmentValidationError([
      {
        path: environmentKey,
        message: "PGlite data path must resolve within the BEA repository root",
      },
    ]);
  }

  const canonicalRoot = realpathSync.native(lexicalRoot);
  const canonicalCandidate = canonicalizeProspectivePath(lexicalCandidate);
  if (!isContainedPath(canonicalRoot, canonicalCandidate)) {
    throw new EnvironmentValidationError([
      {
        path: environmentKey,
        message: "PGlite data path must remain within the canonical BEA repository root",
      },
    ]);
  }
  return canonicalCandidate;
}

function comparablePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isIsolatedPreviewEnvironment(
  input: Readonly<Record<string, string | undefined>>,
): boolean {
  return input.BEA_PREVIEW_MODE?.trim().toLowerCase() === "true";
}

export function isOwnerEvaluationProcessEnvironment(
  input: Readonly<Record<string, string | undefined>>,
): boolean {
  return input.BEA_OWNER_EVALUATION?.trim().toLowerCase() === "true";
}

export function assertDistinctPgliteServePaths(
  environment: ServerEnvironment,
  workerMode: "once" | "serve" = environment.workerMode,
): void {
  if (
    environment.databaseDriver !== "pglite" ||
    workerMode !== "serve" ||
    environment.demoDatabasePath === "memory://" ||
    environment.workerDemoDatabasePath === "memory://"
  ) {
    return;
  }
  if (
    comparablePath(environment.demoDatabasePath) ===
    comparablePath(environment.workerDemoDatabasePath)
  ) {
    throw new EnvironmentValidationError([
      {
        path: "WORKER_DEMO_DATABASE_PATH",
        message: "Serve-mode web and worker PGlite owners must use distinct data paths",
      },
    ]);
  }
}

export function loadRepositoryEnvironment(
  input: {
    readonly startDirectory?: string;
    readonly processEnvironment?: Readonly<Record<string, string | undefined>>;
    readonly envFileName?: string;
    /** Explicitly disables all env-file existence/read access. Process values remain authoritative. */
    readonly loadEnvFile?: boolean;
    /** Test seam used to prove disabled verification never touches `.env.local`. */
    readonly envFileAccess?: RepositoryEnvFileAccess;
  } = {},
): LoadedRepositoryEnvironment {
  const repositoryRoot = findRepositoryRoot(input.startDirectory ?? process.cwd());
  const envFile = join(repositoryRoot, input.envFileName ?? ".env.local");
  const processEnvironment = input.processEnvironment ?? process.env;
  const explicitlyDisabled =
    processEnvironment.BEA_DISABLE_ENV_FILE?.trim().toLowerCase() === "true";
  const ambientlyDisabled = process.env.BEA_DISABLE_ENV_FILE?.trim().toLowerCase() === "true";
  // An authoritative verification parent must be able to disable env-file access even when a
  // child passes a narrowed process-environment object or requests loading explicitly.
  const loadEnvFile = explicitlyDisabled || ambientlyDisabled ? false : (input.loadEnvFile ?? true);
  const envFileAccess = input.envFileAccess ?? {
    exists: existsSync,
    read: (path: string) => readFileSync(path, "utf8"),
  };
  // This branch is deliberately evaluated before *any* env-file exists/read call.
  const envFileExists = loadEnvFile ? envFileAccess.exists(envFile) : false;
  const fileValues = envFileExists ? parseEnvFile(envFileAccess.read(envFile)) : {};
  const merged: Record<string, string | undefined> = {
    ...fileValues,
    ...processEnvironment,
  };
  let environment = parseEnvironment(merged);
  const demoPath = environment.demoDatabasePath;
  if (demoPath !== "memory://") {
    merged.DEMO_DATABASE_PATH =
      environment.databaseDriver === "pglite"
        ? resolveContainedPglitePath(repositoryRoot, demoPath, "DEMO_DATABASE_PATH")
        : isAbsolute(demoPath)
          ? resolve(demoPath)
          : resolve(repositoryRoot, demoPath);
  }
  const workerDemoPath = environment.workerDemoDatabasePath;
  if (workerDemoPath !== "memory://") {
    merged.WORKER_DEMO_DATABASE_PATH =
      environment.databaseDriver === "pglite"
        ? resolveContainedPglitePath(repositoryRoot, workerDemoPath, "WORKER_DEMO_DATABASE_PATH")
        : isAbsolute(workerDemoPath)
          ? resolve(workerDemoPath)
          : resolve(repositoryRoot, workerDemoPath);
  }
  environment = parseEnvironment(merged);
  assertDistinctPgliteServePaths(environment);
  const isolatedPreview = isIsolatedPreviewEnvironment(merged);
  const ownerEvaluation =
    isOwnerEvaluationProcessEnvironment(merged) || isOwnerEvaluationRuntime(environment);
  if (isolatedPreview && ownerEvaluation) {
    throw new EnvironmentValidationError([
      {
        path: "BEA_OWNER_EVALUATION",
        message: "Owner Evaluation cannot run inside Preview. Use Start-BEA-Owner-Acceptance.cmd.",
      },
    ]);
  }
  if (isolatedPreview) {
    const previewOrigin = new URL(environment.appBaseUrl);
    const previewContractValid =
      merged.BEA_PREVIEW_AUTHORITY === "Start-BEA-Preview.cmd" &&
      merged.BEA_DISABLE_ENV_FILE?.trim().toLowerCase() === "true" &&
      environment.appMode === "demo" &&
      environment.runtimeMode === "test" &&
      process.env.NODE_ENV === "test" &&
      environment.deploymentProfile === "demo" &&
      environment.authProvider === "demo" &&
      environment.databaseDriver === "pglite" &&
      previewOrigin.protocol === "http:" &&
      previewOrigin.hostname === "127.0.0.1" &&
      !merged.BEA_PRODUCTION_SECRET_PATH?.trim() &&
      !merged.DATABASE_URL?.trim() &&
      !merged.OPENAI_API_KEY?.trim();
    if (!previewContractValid) {
      throw new EnvironmentValidationError([
        {
          path: "BEA_PREVIEW_MODE",
          message:
            "Preview requires the exact loopback Demo/PGlite contract with production credentials absent",
        },
      ]);
    }
  }
  if (ownerEvaluation) {
    const origin = new URL(environment.appBaseUrl);
    const loopback = isLoopbackHostname(origin.hostname);
    let publicOrigin: string | undefined;
    if (merged.BEA_OWNER_EVALUATION_PUBLIC_ORIGIN?.trim()) {
      try {
        publicOrigin = parseExactHttpOrigin(
          merged.BEA_OWNER_EVALUATION_PUBLIC_ORIGIN,
          "BEA_OWNER_EVALUATION_PUBLIC_ORIGIN",
        );
      } catch {
        publicOrigin = undefined;
      }
    }
    const publicOriginMatchesApp = publicOrigin !== undefined && publicOrigin === origin.origin;
    // Cloud Owner Evaluation may receive OPENAI_API_KEY as a process-only runtime secret when
    // BEA_DISABLE_ENV_FILE=true. Windows Owner Evaluation still blanks the inherited key and
    // persists a browser-submitted key with DPAPI. Preview continues to forbid any live key.
    const ownerContractValid =
      merged.BEA_OWNER_EVALUATION?.trim().toLowerCase() === "true" &&
      merged.BEA_OWNER_EVALUATION_AUTHORITY === "Start-BEA-Owner-Acceptance.cmd" &&
      merged.BEA_DISABLE_ENV_FILE?.trim().toLowerCase() === "true" &&
      environment.deploymentProfile === "owner-evaluation" &&
      environment.appMode === "demo" &&
      environment.runtimeMode === "development" &&
      environment.authProvider === "demo" &&
      environment.databaseDriver === "pglite" &&
      (loopback || publicOriginMatchesApp) &&
      !merged.BEA_PREVIEW_MODE?.trim() &&
      !merged.DATABASE_URL?.trim() &&
      !merged.BEA_PRODUCTION_SECRET_PATH?.trim();
    if (!ownerContractValid) {
      throw new EnvironmentValidationError([
        {
          path: "BEA_OWNER_EVALUATION",
          message:
            "Owner Evaluation requires the loopback or exact public-origin PGlite contract with live OpenAI from DPAPI or a server runtime credential and no Preview flags",
        },
      ]);
    }
  }
  if (
    environment.deploymentProfile === "local-live" &&
    !merged.BEA_PRODUCTION_SECRET_PATH?.trim()
  ) {
    throw new EnvironmentValidationError([
      {
        path: "BEA_PRODUCTION_SECRET_PATH",
        message: "Local Live production requires the protected user-local DPAPI vault",
      },
    ]);
  }
  return {
    environment,
    // Preview deliberately receives an empty, non-persistent secret provider. It cannot read or
    // mutate either the Local Live DPAPI vault or the repository Demo secret store.
    secrets: isolatedPreview
      ? parseServerSecrets({})
      : parseServerSecrets(merged, {
          repositoryRoot,
          ...(environment.deploymentProfile === "local-live" && merged.BEA_PRODUCTION_SECRET_PATH
            ? { productionVaultPath: merged.BEA_PRODUCTION_SECRET_PATH }
            : ownerEvaluation
              ? { protectedSecretRelativePath: OWNER_EVALUATION_PROTECTED_SECRET_RELATIVE_PATH }
              : {}),
        }),
    repositoryRoot,
    envFileLoaded: envFileExists,
  };
}
