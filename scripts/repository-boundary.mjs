import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const AUTHORIZED_REPOSITORY =
  "D:/Cyber Pirate Labs/93_TOOLS_AND_CACHE/CPL-Command-Center/publication/source";
export const REPOSITORY_ID = 1380072423;
export const IDENTITY_FILE = ".cpl-repository.json";
export const FORBIDDEN_REPOSITORY = "C:/CPL-Dev/Cyber Pirate Labs Command Center";
export const FORBIDDEN_REPOSITORIES = Object.freeze([
  FORBIDDEN_REPOSITORY,
  "D:/CPL-Dev/Cyber Pirate Labs Command Center",
  "D:/Cyber Pirate Labs/03_ENGINEERING/Repositories/Cyber Pirate Labs Command Center",
]);
const CLOUD_REPOSITORIES = Object.freeze([
  "D:/Cyber Pirate Labs/93_TOOLS_AND_CACHE/CPL-Command-Center/publication/anonymous-clone",
  "/workspace/CPL-Command-Center-Public",
  "/workspaces/CPL-Command-Center-Public",
]);
const ORIGIN_URLS = new Set(
  ["CPL-Command-Center-Public"].flatMap((name) => [
    "https://github.com/AaronStarrett/" + name + ".git",
    "https://github.com/AaronStarrett/" + name,
    "git@github.com:AaronStarrett/" + name + ".git",
    "ssh://git@github.com/AaronStarrett/" + name + ".git",
  ]),
);

function pathApiFor(...values) {
  return values.some((value) => /^[A-Za-z]:[\\/]/u.test(value)) ? path.win32 : path.posix;
}

function normalized(candidate) {
  const api = pathApiFor(candidate);
  const result = api.resolve(candidate).replace(/[\\/]+$/u, "");
  return api === path.win32 ? result.toLowerCase() : result;
}

function samePath(left, right) {
  return pathApiFor(left) === pathApiFor(right) && normalized(left) === normalized(right);
}

function requireAbsolute(candidate) {
  if (
    typeof candidate !== "string" ||
    !pathApiFor(candidate).isAbsolute(candidate) ||
    candidate.split(/[\\/]/u).includes("..")
  ) {
    throw new Error("Repository boundary refused: absolute path without traversal required.");
  }
}

export function canonicalize(candidate) {
  requireAbsolute(candidate);
  // Missing/unreadable roots fail closed; they cannot stand in for a verified checkout.
  return realpathSync.native(candidate);
}

export function isPathWithin(candidate, parent) {
  const api = pathApiFor(candidate, parent);
  const relative = api.relative(api.resolve(parent), api.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(".." + api.sep) && relative !== ".." && !api.isAbsolute(relative))
  );
}

function approvedTarget(target) {
  return (
    samePath(target, AUTHORIZED_REPOSITORY) ||
    CLOUD_REPOSITORIES.some((candidate) => samePath(target, candidate))
  );
}

function refuseProtected(candidate) {
  // Deny this separate personal repository for every Windows account. A mutable
  // USERPROFILE value must never remove protection for another user's location.
  const personalRepository =
    /^[a-z]:\/users\/[^/]+\/onedrive\/documents\/chatgpt\/cpl command center(?:\/|$)/iu.test(
      normalized(candidate).replaceAll("\\", "/"),
    );
  if (
    personalRepository ||
    FORBIDDEN_REPOSITORIES.some((forbidden) => isPathWithin(candidate, forbidden))
  ) {
    throw new Error("Repository boundary refused: protected CPL repository.");
  }
}

// Pure path-policy seam only. This does NOT authenticate a repository or authorize mutation.
// A resolver is injectable for link/redirection tests on filesystems without symlink support.
export function assertPathBoundary({ cwd, target, resolvePath = (candidate) => candidate }) {
  requireAbsolute(cwd);
  requireAbsolute(target);
  refuseProtected(cwd);
  refuseProtected(target);
  if (!approvedTarget(target)) {
    throw new Error("Repository boundary refused: target is not an authorized checkout path.");
  }
  if (!isPathWithin(cwd, target)) {
    throw new Error(
      "Repository boundary refused: current directory is outside the authorized checkout.",
    );
  }
  const current = resolvePath(cwd);
  const resolvedTarget = resolvePath(target);
  requireAbsolute(current);
  requireAbsolute(resolvedTarget);
  refuseProtected(current);
  refuseProtected(resolvedTarget);
  if (!samePath(target, resolvedTarget) || !samePath(cwd, current)) {
    throw new Error("Repository boundary refused: redirected checkout path.");
  }
  if (!isPathWithin(current, resolvedTarget)) {
    throw new Error("Repository boundary refused: resolved current directory escaped checkout.");
  }
  return { current, target: resolvedTarget };
}

// Pure evidence validator used by tests; the live guard always gathers this evidence itself.
export function validateRepositoryIdentity(evidence) {
  const { target, gitRoot, gitDirectory, commonDirectory, marker, originUrls, pushUrls } = evidence;
  if (!samePath(gitRoot, target)) {
    throw new Error(
      "Repository boundary refused: Git root does not match the authorized checkout.",
    );
  }
  if (
    !isPathWithin(gitDirectory, target) ||
    !isPathWithin(commonDirectory, target) ||
    samePath(gitDirectory, target) ||
    samePath(commonDirectory, target)
  ) {
    throw new Error(
      "Repository boundary refused: Git metadata is outside the authorized checkout.",
    );
  }
  if (
    marker?.schemaVersion !== 1 ||
    marker?.repositoryId !== REPOSITORY_ID ||
    marker?.owner !== "AaronStarrett"
  ) {
    throw new Error("Repository boundary refused: stable repository identity marker mismatch.");
  }
  for (const urls of [originUrls, pushUrls]) {
    if (!Array.isArray(urls) || urls.length !== 1 || !ORIGIN_URLS.has(urls[0])) {
      // Never include the rejected URL: it may contain a credential.
      throw new Error(
        "Repository boundary refused: origin is not the authorized GitHub repository.",
      );
    }
  }
}

function gitOutput(root, arguments_, safeDirectory = root) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^GIT_/iu.test(key)),
  );
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  try {
    return execFileSync(
      "git",
      ["-c", "safe.directory=" + safeDirectory.replaceAll("\\", "/"), "-C", root, ...arguments_],
      { encoding: "utf8", env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    ).trim();
  } catch {
    throw new Error(
      "Repository boundary refused: required local Git identity evidence unavailable.",
    );
  }
}

export function targetForEnvironment(environment = process.env) {
  const candidate = environment.CPL_REPOSITORY_ROOT ?? environment.BEA_REPOSITORY_ROOT;
  if (candidate !== undefined) {
    requireAbsolute(candidate);
    refuseProtected(candidate);
    if (!approvedTarget(candidate)) {
      throw new Error(
        "Repository boundary refused: environment cannot authorize an arbitrary checkout.",
      );
    }
    return candidate;
  }
  const scriptRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  return CLOUD_REPOSITORIES.some((candidate) => samePath(scriptRoot, candidate))
    ? scriptRoot
    : AUTHORIZED_REPOSITORY;
}

export function assertRepositoryBoundary(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const target = options.target ?? targetForEnvironment();
  const boundary = assertPathBoundary({ cwd, target, resolvePath: canonicalize });
  const scriptRoot = canonicalize(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  if (!samePath(scriptRoot, boundary.target)) {
    throw new Error("Repository boundary refused: guard script belongs to a different checkout.");
  }
  const markerPath = path.join(boundary.target, IDENTITY_FILE);
  let marker;
  try {
    if (!samePath(canonicalize(markerPath), markerPath) || !statSync(markerPath).isFile()) {
      throw new Error("redirected marker");
    }
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    throw new Error(
      "Repository boundary refused: missing, invalid, or redirected identity marker.",
    );
  }
  const gitRoot = canonicalize(gitOutput(cwd, ["rev-parse", "--show-toplevel"], boundary.target));
  const gitDirectory = canonicalize(
    gitOutput(cwd, ["rev-parse", "--absolute-git-dir"], boundary.target),
  );
  const commonDirectory = canonicalize(
    gitOutput(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], boundary.target),
  );
  const originUrls = gitOutput(boundary.target, ["remote", "get-url", "--all", "origin"]).split(
    /\r?\n/u,
  );
  const pushUrls = gitOutput(boundary.target, [
    "remote",
    "get-url",
    "--push",
    "--all",
    "origin",
  ]).split(/\r?\n/u);
  const configuredOrigins = gitOutput(boundary.target, [
    "config",
    "--local",
    "--get-all",
    "remote.origin.url",
  ]).split(/\r?\n/u);
  validateRepositoryIdentity({
    ...boundary,
    gitRoot,
    gitDirectory,
    commonDirectory,
    marker,
    originUrls,
    pushUrls,
  });
  validateRepositoryIdentity({
    ...boundary,
    gitRoot,
    gitDirectory,
    commonDirectory,
    marker,
    originUrls: configuredOrigins,
    pushUrls,
  });
  return {
    ...boundary,
    gitRoot,
    repositoryId: REPOSITORY_ID,
    identity: "local-marker-and-git-origin-verified",
    forbidden: FORBIDDEN_REPOSITORY,
    protectedRepositoryEntered: false,
  };
}

if (process.argv[1] && samePath(path.resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  try {
    const result = assertRepositoryBoundary();
    process.stdout.write(
      JSON.stringify({ code: "BEA_REPOSITORY_BOUNDARY_OK", ok: true, ...result }) + "\n",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Repository boundary refused.";
    process.stderr.write(
      JSON.stringify({ code: "BEA_REPOSITORY_BOUNDARY_REFUSED", message, ok: false }) + "\n",
    );
    process.exitCode = 1;
  }
}
