import { spawnSync } from "node:child_process";

import { assertRepositoryBoundary, targetForEnvironment } from "./repository-boundary.mjs";

assertRepositoryBoundary({ target: targetForEnvironment() });

const [command, ...args] = process.argv.slice(2);
if (!command) {
  process.stderr.write("Usage: node scripts/run-guarded.mjs <command> [...args]\n");
  process.exit(2);
}

const result = spawnSync(command, args, {
  cwd: process.cwd(),
  env: process.env,
  shell: process.platform === "win32",
  stdio: "inherit",
  windowsHide: true,
});

if (result.error) {
  process.stderr.write("Guarded command could not start: " + result.error.message + "\n");
  process.exit(1);
}
if (result.signal) {
  process.stderr.write("Guarded command terminated by signal " + result.signal + ".\n");
  process.exit(1);
}

process.exit(result.status ?? 1);
