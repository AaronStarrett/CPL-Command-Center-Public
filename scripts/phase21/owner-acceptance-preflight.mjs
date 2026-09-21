import { statfsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUTHORIZED_REPOSITORY,
  FORBIDDEN_REPOSITORY,
  assertRepositoryBoundary,
} from "../repository-boundary.mjs";
import { OWNER_ACCEPTANCE_DISK_GUIDANCE } from "./owner-acceptance-package-policy.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function formatBytes(bytes) {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function inspectFreeDisk(targetPath) {
  try {
    const stats = statfsSync(targetPath);
    return { ok: true, freeBytes: Number(stats.bavail) * Number(stats.bsize) };
  } catch {
    return { ok: false, freeBytes: null };
  }
}

export async function runOwnerAcceptancePreflight(options = {}) {
  const cwd = options.cwd ?? repositoryRoot;
  assertRepositoryBoundary({ cwd, target: AUTHORIZED_REPOSITORY });
  if (cwd.replaceAll("\\", "/").toLowerCase().includes("cyber pirate labs command center")) {
    throw new Error("Owner Evaluation preflight refused the protected sibling path.");
  }

  process.stdout.write("BEA Owner Evaluation preflight\n");
  process.stdout.write("This check does not install software and does not call OpenAI.\n");
  process.stdout.write("PostgreSQL is not required for Owner Evaluation.\n\n");
  process.stdout.write(`Required folder: ${AUTHORIZED_REPOSITORY.replaceAll("/", "\\")}\n`);
  process.stdout.write(
    `Protected sibling (never use): ${FORBIDDEN_REPOSITORY.replaceAll("/", "\\")}\n`,
  );
  process.stdout.write(
    `Minimum free space: ${formatBytes(OWNER_ACCEPTANCE_DISK_GUIDANCE.minimumFreeBytes)}\n`,
  );
  process.stdout.write(
    `Recommended free space: ${formatBytes(OWNER_ACCEPTANCE_DISK_GUIDANCE.recommendedFreeBytes)}\n\n`,
  );

  const disk = inspectFreeDisk(options.diskTarget ?? cwd);
  if (disk.ok && disk.freeBytes < OWNER_ACCEPTANCE_DISK_GUIDANCE.minimumFreeBytes) {
    process.stdout.write(
      `[BLOCKED] Disk space: ${formatBytes(disk.freeBytes)} free; ${formatBytes(OWNER_ACCEPTANCE_DISK_GUIDANCE.minimumFreeBytes)} is required.\n`,
    );
    return "BLOCKED";
  }
  if (disk.ok && disk.freeBytes < OWNER_ACCEPTANCE_DISK_GUIDANCE.recommendedFreeBytes) {
    process.stdout.write(
      `[WARNING] Disk space: ${formatBytes(disk.freeBytes)} free; ${formatBytes(OWNER_ACCEPTANCE_DISK_GUIDANCE.recommendedFreeBytes)} is recommended.\n`,
    );
  } else if (disk.ok) {
    process.stdout.write(`[PASS] Disk space: ${formatBytes(disk.freeBytes)} free\n`);
  } else {
    process.stdout.write("[WARNING] Disk space could not be measured on this host.\n");
  }

  if (!process.env.LOCALAPPDATA && process.platform === "win32") {
    process.stdout.write("[BLOCKED] LOCALAPPDATA is unavailable.\n");
    return "BLOCKED";
  }
  if (process.platform === "win32") {
    process.stdout.write(`[PASS] LOCALAPPDATA: ${process.env.LOCALAPPDATA}\n`);
    process.stdout.write(`[PASS] User profile: ${homedir()}\n`);
  }

  process.stdout.write("\nBEA_OWNER_ACCEPTANCE_PREFLIGHT=PASS\n");
  process.stdout.write(
    "Start-BEA-Owner-Acceptance.cmd will install dependencies if needed, seed synthetic BEA records, and start Owner Evaluation.\n",
  );
  process.stdout.write("Paste the OpenAI key inside the application. Do not put it in a file.\n");
  return "PASS";
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  runOwnerAcceptancePreflight()
    .then((result) => {
      process.exitCode = result === "PASS" ? 0 : 1;
    })
    .catch((error) => {
      process.stderr.write(
        `BEA_OWNER_ACCEPTANCE_PREFLIGHT=BLOCKED (${error instanceof Error ? error.message : "error"})\n`,
      );
      process.exitCode = 1;
    });
}
