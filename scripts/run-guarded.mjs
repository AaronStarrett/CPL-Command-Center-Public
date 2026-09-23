import { spawnSync } from "node:child_process";

import { assertRepositoryBoundary, targetForEnvironment } from "./repository-boundary.mjs";
import { assertNoLocalDevelopmentConfiguration } from "./local-development-policy.mjs";

assertRepositoryBoundary({ target: targetForEnvironment() });

const [command, ...args] = process.argv.slice(2);
// Turbo's strict child environment may omit these flags. Refuse at the parent
// before any build task can scrub them or reuse a production cache entry.
if (args.includes("build")) assertNoLocalDevelopmentConfiguration();
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
