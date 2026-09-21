import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertRepositoryBoundary, targetForEnvironment } from "./repository-boundary.mjs";

function git(root, args, input) {
  const result = spawnSync(
    "git",
    [
      "--git-dir",
      path.join(root, ".git"),
      "--work-tree",
      root,
      "-c",
      "safe.directory=" + root.replaceAll("\\", "/"),
      ...args,
    ],
    {
      cwd: root,
      encoding: "utf8",
      input,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
      ),
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error("Repository health Git operation failed.");
  }
  return result.stdout;
}

export function inspectRepositoryHealth(root) {
  const objectLines = git(root, ["rev-list", "--objects", "--all", "--reflog"])
    .split(/\r?\n/u)
    .filter(Boolean);
  const pathsByObject = new Map();
  for (const line of objectLines) {
    const separator = line.indexOf(" ");
    const objectId = separator === -1 ? line : line.slice(0, separator);
    const objectPath = separator === -1 ? null : line.slice(separator + 1);
    if (objectPath) {
      const paths = pathsByObject.get(objectId) ?? new Set();
      paths.add(objectPath);
      pathsByObject.set(objectId, paths);
    }
  }
  const objectIds = [...new Set(objectLines.map((line) => line.split(" ", 1)[0]).values())];
  const batch = git(
    root,
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    objectIds.join("\n") + "\n",
  );
  const blobs = [];
  let totalBlobBytes = 0;
  for (const line of batch.split(/\r?\n/u).filter(Boolean)) {
    const [objectId, objectType, sizeText] = line.split(" ");
    if (objectType !== "blob" || !objectId || !sizeText) continue;
    const sizeBytes = Number(sizeText);
    totalBlobBytes += sizeBytes;
    blobs.push({
      objectId,
      path: [...(pathsByObject.get(objectId) ?? [])].sort()[0] ?? null,
      paths: [...(pathsByObject.get(objectId) ?? [])].sort(),
      sizeBytes,
    });
  }
  blobs.sort(
    (left, right) =>
      right.sizeBytes - left.sizeBytes || left.objectId.localeCompare(right.objectId),
  );
  const countObjects = git(root, ["count-objects", "-vH"]).trim().split(/\r?\n/u);
  git(root, ["fsck", "--full", "--strict", "--no-dangling"]);
  const blobsAtLeast10MiB = blobs.filter((blob) => blob.sizeBytes >= 10 * 1024 * 1024).length;
  const ok = blobsAtLeast10MiB === 0;
  return {
    code: ok ? "BEA_REPOSITORY_HEALTH_OK" : "BEA_REPOSITORY_HEALTH_POLICY_FAILED",
    ok,
    reachableObjects: objectIds.length,
    blobs: blobs.length,
    totalBlobBytes,
    blobsAtLeast1MiB: blobs.filter((blob) => blob.sizeBytes >= 1024 * 1024).length,
    blobsAtLeast10MiB,
    integrity: "PASS",
    largestBlobs: blobs.slice(0, 10),
    gitObjectStore: countObjects,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const boundary = assertRepositoryBoundary({ target: targetForEnvironment() });
    const result = inspectRepositoryHealth(boundary.target);
    (result.ok ? process.stdout : process.stderr).write(JSON.stringify(result) + "\n");
    if (!result.ok) process.exitCode = 1;
  } catch {
    process.stderr.write(
      JSON.stringify({ code: "BEA_REPOSITORY_HEALTH_FAILED", ok: false }) + "\n",
    );
    process.exitCode = 1;
  }
}
