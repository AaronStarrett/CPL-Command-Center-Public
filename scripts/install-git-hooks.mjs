import { assertRepositoryBoundary } from "./repository-boundary.mjs";

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const normalizedRoot = repositoryRoot.replaceAll("\\", "/");
const hooksPath = "scripts/git-hooks";

function git(arguments_, options = {}) {
  return execFileSync("git", ["-c", "safe.directory=" + normalizedRoot, ...arguments_], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: options.allowFailure ? ["ignore", "pipe", "pipe"] : undefined,
  }).trim();
}

function currentHooksPath() {
  try {
    return git(["config", "--local", "--get", "core.hooksPath"], { allowFailure: true });
  } catch {
    return "";
  }
}

export function installGitHooks(root = repositoryRoot) {
  assertRepositoryBoundary({ cwd: root, target: root });
  if (!existsSync(path.join(root, ".git"))) {
    return { installed: false, reason: "NO_GIT" };
  }
  if (currentHooksPath() !== hooksPath) {
    git(["config", "--local", "core.hooksPath", hooksPath]);
  }
  return { installed: true, hooksPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = installGitHooks();
    if (!result.installed) {
      process.stdout.write("BEA_GIT_HOOKS=SKIPPED_" + result.reason + "\n");
    } else {
      process.stdout.write("BEA_GIT_HOOKS=INSTALLED path=" + result.hooksPath + "\n");
    }
  } catch (error) {
    process.stderr.write(String(error instanceof Error ? error.message : error) + "\n");
    process.exitCode = 1;
  }
}
