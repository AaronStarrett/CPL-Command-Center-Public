import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertRepositoryBoundary, targetForEnvironment } from "./repository-boundary.mjs";
import { findProhibitedRepositoryPaths } from "./repository-data-policy.mjs";
import { detectSecretTypes } from "./secret-scan.mjs";

function safeGitEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  );
}

function runGit(root, args, options = {}) {
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
      env: safeGitEnvironment(),
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      ...options,
    },
  );
  if (result.error || result.status === null || result.status > (options.allowedStatus ?? 0)) {
    throw new Error("History scan Git operation failed without exposing repository content.");
  }
  return result;
}

function readObjectsInBatch(root, objectIds) {
  const result = spawnSync(
    "git",
    [
      "--git-dir",
      path.join(root, ".git"),
      "--work-tree",
      root,
      "-c",
      "safe.directory=" + root.replaceAll("\\", "/"),
      "cat-file",
      "--batch",
    ],
    {
      cwd: root,
      encoding: null,
      env: safeGitEnvironment(),
      input: Buffer.from(objectIds.join("\n") + "\n", "utf8"),
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    throw new Error("History scan could not read reachable objects.");
  }
  const objects = [];
  let cursor = 0;
  while (cursor < result.stdout.length) {
    const headerEnd = result.stdout.indexOf(10, cursor);
    if (headerEnd === -1) break;
    const header = result.stdout.subarray(cursor, headerEnd).toString("utf8");
    cursor = headerEnd + 1;
    const [objectId, objectType, sizeText] = header.split(" ");
    const size = Number(sizeText);
    if (!objectId || !objectType || !Number.isSafeInteger(size) || size < 0) {
      throw new Error("History scan received an invalid object header.");
    }
    const end = cursor + size;
    if (end > result.stdout.length) throw new Error("History scan received truncated object data.");
    objects.push({ objectId, objectType, content: result.stdout.subarray(cursor, end) });
    cursor = end;
    if (result.stdout[cursor] === 10) cursor += 1;
  }
  return objects;
}

export function scanReachableHistory(root) {
  const commits = [
    ...new Set(
      runGit(root, ["rev-list", "--all", "--reflog"]).stdout.split(/\r?\n/u).filter(Boolean),
    ),
  ].sort();
  const findings = [];

  const objectLines = runGit(root, ["rev-list", "--objects", "--all", "--reflog"])
    .stdout.split(/\r?\n/u)
    .filter(Boolean);
  const pathsByObject = new Map();
  const objectIds = [];
  for (const line of objectLines) {
    const separator = line.indexOf(" ");
    const objectId = separator === -1 ? line : line.slice(0, separator);
    objectIds.push(objectId);
  }

  let blobsScanned = 0;
  let blobBytesScanned = 0;
  let annotatedTagsScanned = 0;
  const commitSet = new Set(commits);
  const scannedCommits = new Set();
  const rootTrees = new Set();
  const trees = new Map();
  const blobFindings = [];
  const uniqueObjectIds = [...new Set(objectIds)];
  for (let offset = 0; offset < uniqueObjectIds.length; offset += 64) {
    const batch = uniqueObjectIds.slice(offset, offset + 64);
    for (const object of readObjectsInBatch(root, batch)) {
      if (object.objectType === "commit" && commitSet.has(object.objectId)) {
        const separator = object.content.indexOf("\n\n");
        const header = object.content.subarray(0, separator).toString("utf8");
        const tree = /^tree ([a-f0-9]{40}|[a-f0-9]{64})$/mu.exec(header)?.[1];
        if (separator < 0 || !tree) throw new Error("History scan received an invalid commit.");
        rootTrees.add(tree);
        scannedCommits.add(object.objectId);
        for (const type of detectSecretTypes(
          object.content.subarray(separator + 2).toString("utf8"),
        )) {
          findings.push({ commit: object.objectId, path: null, type });
        }
        continue;
      }
      if (object.objectType === "tree") {
        trees.set(object.objectId, object.content);
        continue;
      }
      if (object.objectType === "tag") {
        annotatedTagsScanned += 1;
        for (const type of detectSecretTypes(object.content.toString("utf8"))) {
          findings.push({ tagObjectId: object.objectId, path: null, type });
        }
        continue;
      }
      if (object.objectType !== "blob") continue;
      blobsScanned += 1;
      blobBytesScanned += object.content.length;
      for (const type of detectSecretTypes(object.content.toString("utf8"))) {
        blobFindings.push({ objectId: object.objectId, type });
      }
    }
  }
  if (scannedCommits.size !== commits.length) {
    throw new Error("History scan did not read every reachable commit.");
  }

  // Reuse the raw trees already returned by cat-file. Spawning show/ls-tree for
  // each historical commit is prohibitively slow on Windows removable volumes.
  const treeEntries = new Map();
  function entriesForTree(treeId, ancestors = new Set()) {
    const cached = treeEntries.get(treeId);
    if (cached) return cached;
    const content = trees.get(treeId);
    if (!content || ancestors.has(treeId)) {
      throw new Error("History scan received a missing or cyclic tree.");
    }
    const nextAncestors = new Set([...ancestors, treeId]);
    const objectIdBytes = treeId.length / 2;
    const entries = [];
    let cursor = 0;
    while (cursor < content.length) {
      const space = content.indexOf(32, cursor);
      const nul = content.indexOf(0, space + 1);
      const end = nul + 1 + objectIdBytes;
      if (space <= cursor || nul <= space + 1 || end > content.length) {
        throw new Error("History scan received an invalid tree record.");
      }
      const mode = content.subarray(cursor, space).toString("ascii");
      const name = content.subarray(space + 1, nul).toString("utf8");
      const objectId = content.subarray(nul + 1, end).toString("hex");
      if (!/^(?:40000|040000|100644|100755|120000|160000)$/u.test(mode) || name.includes("/")) {
        throw new Error("History scan received an unsupported tree record.");
      }
      if (mode === "40000" || mode === "040000") {
        for (const entry of entriesForTree(objectId, nextAncestors)) {
          entries.push({ objectId: entry.objectId, path: `${name}/${entry.path}` });
        }
      } else {
        entries.push({ objectId, path: name });
      }
      cursor = end;
    }
    treeEntries.set(treeId, entries);
    return entries;
  }
  for (const treeId of [...rootTrees].sort()) {
    for (const entry of entriesForTree(treeId)) {
      const paths = pathsByObject.get(entry.objectId) ?? new Set();
      paths.add(entry.path);
      pathsByObject.set(entry.objectId, paths);
    }
  }
  for (const finding of blobFindings) {
    const paths = [...(pathsByObject.get(finding.objectId) ?? [])].sort();
    findings.push({ ...finding, path: paths[0] ?? null, paths });
  }

  const historicalPaths = [
    ...new Set([...pathsByObject.values()].flatMap((paths) => [...paths])),
  ].sort();
  const prohibitedPaths = findProhibitedRepositoryPaths(historicalPaths);

  return {
    blobBytesScanned,
    blobsScanned,
    annotatedTagsScanned,
    commitsScanned: commits.length,
    findings,
    historicalPathsScanned: historicalPaths.length,
    historicalPaths,
    prohibitedPaths,
  };
}

export function runHistorySecretScan(environment = process.env) {
  const boundary = assertRepositoryBoundary({ target: targetForEnvironment(environment) });
  const result = scanReachableHistory(boundary.target);
  const ok = result.findings.length === 0 && result.prohibitedPaths.length === 0;
  const output = {
    code: ok ? "BEA_HISTORY_SECRET_SCAN_CLEAR" : "BEA_HISTORY_SECRET_SCAN_FINDINGS",
    ok,
    commitsScanned: result.commitsScanned,
    blobsScanned: result.blobsScanned,
    annotatedTagsScanned: result.annotatedTagsScanned,
    blobBytesScanned: result.blobBytesScanned,
    historicalPathsScanned: result.historicalPathsScanned,
    findings: result.findings,
    prohibitedPaths: result.prohibitedPaths,
    scope: "all refs and reflogs",
    secretValuesPrinted: false,
  };
  (ok ? process.stdout : process.stderr).write(JSON.stringify(output) + "\n");
  return ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runHistorySecretScan();
  } catch {
    process.stderr.write(
      JSON.stringify({ code: "BEA_HISTORY_SECRET_SCAN_FAILED", ok: false }) + "\n",
    );
    process.exitCode = 1;
  }
}
