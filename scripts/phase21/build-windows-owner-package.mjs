import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertRepositoryBoundary, targetForEnvironment } from "../repository-boundary.mjs";
import {
  buildReadMeFirst,
  OWNER_ACCEPTANCE_PACKAGE_NAME,
  ownerAcceptanceManifestTemplate,
  shouldIncludeRepositoryFile,
} from "./owner-acceptance-package-policy.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function git(args, cwd = repositoryRoot) {
  const result = spawnSync("git", ["-c", `safe.directory=${cwd.replaceAll("\\", "/")}`, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return String(result.stdout ?? "").trim();
}

function listPackageFiles() {
  const result = spawnSync(
    "git",
    [
      "-c",
      `safe.directory=${repositoryRoot.replaceAll("\\", "/")}`,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
    ],
    { cwd: repositoryRoot, encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error("Could not list repository files for the owner package.");
  }
  return result.stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trim().replaceAll("\\", "/"))
    .filter(Boolean)
    .filter(shouldIncludeRepositoryFile)
    .sort();
}

function directorySize(root) {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile()) total += statSync(fullPath).size;
    }
  }
  return total;
}

function zipDirectory(sourceDir, zipFile) {
  if (existsSync(zipFile)) rmSync(zipFile);
  const pythonCandidates =
    process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
  const script = [
    "import os, zipfile",
    "from pathlib import Path",
    "root = Path(os.environ['BEA_ZIP_SOURCE'])",
    "dest = Path(os.environ['BEA_ZIP_DEST'])",
    "with zipfile.ZipFile(dest, 'w', compression=zipfile.ZIP_DEFLATED) as archive:",
    "    for path in sorted(root.rglob('*')):",
    "        if path.is_file():",
    "            archive.write(path, path.relative_to(root).as_posix())",
  ].join("\n");
  let lastError = "python was not found";
  for (const command of pythonCandidates) {
    const result = spawnSync(command, ["-c", script], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, BEA_ZIP_SOURCE: sourceDir, BEA_ZIP_DEST: zipFile },
      windowsHide: true,
    });
    if (result.status === 0 && existsSync(zipFile)) return;
    lastError = String(result.stderr || result.stdout || result.error || "zip failed").trim();
  }
  throw new Error(`Owner package zip failed: ${lastError}`);
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function contentChecksums(staging) {
  const lines = [];
  const stack = [staging];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        const relative = path.relative(staging, fullPath).split(path.sep).join("/");
        lines.push(`${sha256File(fullPath)}  ${relative}`);
      }
    }
  }
  return lines.sort().join("\n");
}

export function buildWindowsOwnerAcceptancePackage(options = {}) {
  const environment = options.environment ?? process.env;
  assertRepositoryBoundary({
    cwd: options.cwd ?? repositoryRoot,
    target: targetForEnvironment(environment),
  });
  const outputDir = path.resolve(
    options.outputDir ?? path.join(repositoryRoot, ".data", "owner-package"),
  );
  mkdirSync(outputDir, { recursive: true });
  const staging = path.join(outputDir, "staging");
  const zipFile = path.join(outputDir, `${OWNER_ACCEPTANCE_PACKAGE_NAME}.zip`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  const files = listPackageFiles();
  for (const relative of files) {
    const source = path.join(repositoryRoot, relative);
    const destination = path.join(staging, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(source, destination);
  }

  const gitCommitSha = options.gitCommitSha ?? git(["rev-parse", "HEAD"]);
  const gitBranch = options.gitBranch ?? git(["rev-parse", "--abbrev-ref", "HEAD"]);
  writeFileSync(
    path.join(staging, "READ-ME-FIRST.txt"),
    buildReadMeFirst({ gitCommitSha, gitBranch }),
  );
  const pendingManifest = ownerAcceptanceManifestTemplate({
    gitBranch,
    gitCommitSha,
    buildDate: options.buildDate ?? new Date().toISOString(),
    includedFileCount: files.length + 3,
    compressedBytes: 0,
    extractedBytes: 0,
    sha256: "pending-archive-hash",
  });
  writeFileSync(
    path.join(staging, "PACKAGE-MANIFEST.json"),
    `${JSON.stringify(pendingManifest, null, 2)}\n`,
  );
  writeFileSync(
    path.join(staging, "PACKAGE-CHECKSUMS.txt"),
    `# Extracted content SHA-256\n${contentChecksums(staging)}\n`,
  );
  const extractedBytes = directorySize(staging);
  pendingManifest.extractedBytes = extractedBytes;
  writeFileSync(
    path.join(staging, "PACKAGE-MANIFEST.json"),
    `${JSON.stringify(pendingManifest, null, 2)}\n`,
  );

  zipDirectory(staging, zipFile);
  const compressedBytes = statSync(zipFile).size;
  const sha256 = sha256File(zipFile);
  const manifest = {
    ...pendingManifest,
    extractedBytes,
    compressedBytes,
    sha256,
    includedFileCount: files.length + 3,
  };
  const readme = buildReadMeFirst({ gitCommitSha, gitBranch, sha256 });
  const sidecarChecksums = [
    `${sha256}  ${OWNER_ACCEPTANCE_PACKAGE_NAME}.zip`,
    `compressed-bytes ${compressedBytes}`,
    `extracted-bytes ${extractedBytes}`,
    `git-commit ${gitCommitSha}`,
    `extraction-path C:\\CPL-Dev\\BEA-Automation-Command-Center`,
  ].join("\n");

  writeFileSync(
    path.join(outputDir, "PACKAGE-MANIFEST.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  writeFileSync(path.join(outputDir, "PACKAGE-CHECKSUMS.txt"), `${sidecarChecksums}\n`);
  writeFileSync(path.join(outputDir, "READ-ME-FIRST.txt"), readme);

  return {
    outputDir,
    zipFile,
    staging,
    files,
    manifest,
  };
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const outputFlag = process.argv.indexOf("--output-dir");
  const outputDir =
    outputFlag >= 0
      ? process.argv[outputFlag + 1]
      : path.join(process.env.GITHUB_WORKSPACE || tmpdir(), "bea-owner-package");
  const result = buildWindowsOwnerAcceptancePackage({ outputDir });
  process.stdout.write(
    JSON.stringify(
      {
        code: "BEA_WINDOWS_OWNER_PACKAGE=READY",
        artifact: result.zipFile,
        sha256: result.manifest.sha256,
        compressedBytes: result.manifest.compressedBytes,
        extractedBytes: result.manifest.extractedBytes,
        includedFileCount: result.manifest.includedFileCount,
      },
      null,
      2,
    ) + "\n",
  );
}
