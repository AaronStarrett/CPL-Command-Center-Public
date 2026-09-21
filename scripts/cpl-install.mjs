import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertLocalLauncherStopped,
  createSafeEnvironment,
  ensureLocalBoundary,
  prepareDirectories,
} from "./cpl-local.mjs";
import { synchronizeWorkspaceCopies } from "./cpl-workspace-copies.mjs";
import { installGitHooks } from "./install-git-hooks.mjs";

export const INSTALL_ARGUMENTS = Object.freeze([
  "install",
  "--frozen-lockfile",
  "--store-dir",
  ".data/tooling/pnpm-store",
  "--ignore-scripts",
  "--config.node-linker=hoisted",
  "--config.enable-global-virtual-store=false",
  "--config.package-import-method=copy",
  "--config.inject-workspace-packages=true",
  "--config.dedupe-injected-deps=false",
  "--config.symlink=false",
  "--config.prefer-symlinked-executables=false",
  "--config.hoist-workspace-packages=false",
]);

export function requireSuccessfulCommand(result, label) {
  if (result.error || result.signal || result.status !== 0)
    throw new Error(label + " failed; installation is incomplete.");
}

export async function installLocalDependencies() {
  const root = ensureLocalBoundary();
  await assertLocalLauncherStopped(root);
  const paths = prepareDirectories(root);
  const environment = createSafeEnvironment(root);
  // Avoid duplicate case-insensitive PATH entries on Windows.
  const existingPath = environment.Path ?? environment.PATH ?? "";
  delete environment.PATH;
  environment.Path = path.dirname(process.execPath) + path.delimiter + existingPath;
  environment.COREPACK_HOME = path.join(paths.cache, "corepack");
  environment.PNPM_HOME = path.join(paths.tooling, "pnpm-home");
  const run = (args, capture = false) =>
    spawnSync(
      environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe",
      ["/d", "/s", "/c", "pnpm.cmd", ...args],
      {
        cwd: root,
        env: environment,
        encoding: "utf8",
        shell: false,
        stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
        windowsHide: true,
      },
    );
  const version = run(["--version"], true);
  requireSuccessfulCommand(version, "pnpm version check");
  if (version.stdout.trim() !== "11.19.0")
    throw new Error("This exFAT recipe requires pnpm 11.19.0; no install was started.");
  requireSuccessfulCommand(run(INSTALL_ARGUMENTS), "Frozen dependency install");
  const copies = synchronizeWorkspaceCopies();
  const hooks = installGitHooks(root);
  process.stdout.write(JSON.stringify({ code: "CPL_SETUP_COMPLETE", copies, hooks }) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await installLocalDependencies();
  } catch (error) {
    process.stderr.write("CPL_SETUP_FAILED: " + error.message + "\n");
    process.exitCode = 1;
  }
}
