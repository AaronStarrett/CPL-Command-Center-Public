import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { dirname, join } from "node:path";

import {
  assertPathContained,
  productionPaths,
  TOOLCHAIN_NODE_VERSION,
  TOOLCHAIN_PNPM_VERSION,
} from "./production-paths.mjs";

export const NODE_ARCHIVE_NAME = `node-v${TOOLCHAIN_NODE_VERSION}-win-x64.zip`;
export const NODE_DISTRIBUTION_BASE_URL = `https://nodejs.org/dist/v${TOOLCHAIN_NODE_VERSION}/`;
export const NODE_ARCHIVE_URL = `${NODE_DISTRIBUTION_BASE_URL}${NODE_ARCHIVE_NAME}`;
export const NODE_CHECKSUM_URL = `${NODE_DISTRIBUTION_BASE_URL}SHASUMS256.txt`;
export const NODE_ARCHIVE_SHA256 =
  "57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73";

function run(command, arguments_, options = {}) {
  const commandIsBatch = /\.(?:cmd|bat)$/iu.test(command);
  const executable = commandIsBatch ? (process.env.ComSpec ?? "cmd.exe") : command;
  const args = commandIsBatch ? ["/d", "/s", "/c", "call", command, ...arguments_] : arguments_;
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    input: options.input,
    shell: false,
    windowsHide: true,
  });
  return {
    exitCode: result.status ?? (result.error ? 1 : 0),
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim(),
  };
}

export function assertOfficialNodeUrl(value, expectedName) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Node download URL is invalid.");
  }
  const expectedPath = `/dist/v${TOOLCHAIN_NODE_VERSION}/${expectedName}`;
  if (
    url.protocol !== "https:" ||
    url.hostname !== "nodejs.org" ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== expectedPath ||
    url.search ||
    url.hash
  ) {
    throw new Error("Node download URL is outside the exact official allowlist.");
  }
  return url.href;
}

export function parseNodeChecksumManifest(contents, archiveName = NODE_ARCHIVE_NAME) {
  if (typeof contents !== "string" || contents.length > 1_048_576) {
    throw new Error("Node checksum manifest is invalid.");
  }
  const matches = contents
    .split(/\r?\n/u)
    .map((line) => /^([a-f0-9]{64})\s+\*?([^\\/]+)$/u.exec(line.trim()))
    .filter((match) => match?.[2] === archiveName);
  if (matches.length !== 1) throw new Error("Exact Node archive checksum was not found uniquely.");
  return matches[0][1];
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyNodeArchive(filePath, expectedSha256) {
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) throw new Error("Expected SHA-256 is invalid.");
  const actualSha256 = await sha256File(filePath);
  if (actualSha256 !== expectedSha256) {
    throw new Error("Node archive checksum mismatch; extraction was refused.");
  }
  return actualSha256;
}

export async function downloadOfficialFile(url, destination, options = {}) {
  assertOfficialNodeUrl(url, options.expectedName);
  const response = await (options.fetch ?? fetch)(url, {
    method: "GET",
    redirect: "error",
    signal: options.signal,
  });
  if (!response.ok || response.url !== url || !response.body) {
    throw new Error("Official Node download failed closed.");
  }
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
  return destination;
}

export function isolatedToolchainEnvironment(paths, source = process.env) {
  const inheritedPath = source.Path ?? source.PATH ?? "";
  const pinnedPath = `${paths.nodeDirectory};${dirname(paths.pnpmExecutable)}`;
  return {
    ...source,
    COREPACK_HOME: paths.corepackHome,
    PNPM_HOME: paths.pnpmHome,
    PATH: inheritedPath ? `${pinnedPath};${inheritedPath}` : pinnedPath,
    Path: inheritedPath ? `${pinnedPath};${inheritedPath}` : pinnedPath,
  };
}

function exactVersionFromOutput(value, prefix = "") {
  const lines = String(value ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) return "";
  return new RegExp(`^${prefix}\\d+\\.\\d+\\.\\d+$`, "u").test(lines[0])
    ? lines[0].replace(/^v/u, "")
    : "";
}

export function verifyPinnedToolchain(options = {}) {
  const paths = options.paths ?? productionPaths;
  const runner = options.run ?? run;
  const nodePresent = existsSync(paths.nodeExecutable);
  const pnpmPresent = existsSync(paths.pnpmExecutable);
  const environment = isolatedToolchainEnvironment(paths, options.environment);
  const node = nodePresent
    ? runner(paths.nodeExecutable, ["--version"], { env: environment })
    : { exitCode: null, stdout: "", stderr: "" };
  const nodeVersion = exactVersionFromOutput(node.stdout, "v?");
  const nodeReady = nodePresent && node.exitCode === 0 && nodeVersion === TOOLCHAIN_NODE_VERSION;
  const pnpm =
    pnpmPresent && nodeReady
      ? runner(paths.pnpmExecutable, ["--version"], { env: environment })
      : { exitCode: null, stdout: "", stderr: "" };
  const pnpmVersion = exactVersionFromOutput(pnpm.stdout);
  const pnpmReady =
    pnpmPresent && nodeReady && pnpm.exitCode === 0 && pnpmVersion === TOOLCHAIN_PNPM_VERSION;
  const toolchainReady = nodeReady && pnpmReady;
  const code = toolchainReady
    ? "TOOLCHAIN_READY"
    : !nodePresent
      ? "NODE_MISSING"
      : node.exitCode !== 0
        ? "NODE_FAILED"
        : nodeVersion !== TOOLCHAIN_NODE_VERSION
          ? "NODE_VERSION_MISMATCH"
          : !pnpmPresent
            ? "PNPM_MISSING"
            : pnpm.exitCode !== 0
              ? "PNPM_FAILED"
              : "PNPM_VERSION_MISMATCH";
  return Object.freeze({
    ok: toolchainReady,
    code,
    nodePath: paths.nodeExecutable,
    nodeVersion,
    nodeReady,
    nodeExitCode: node.exitCode,
    pnpmPath: paths.pnpmExecutable,
    pnpmVersion,
    pnpmReady,
    pnpmExitCode: pnpm.exitCode,
    toolchainReady,
  });
}

function writePnpmShim(paths) {
  mkdirSync(dirname(paths.pnpmExecutable), { recursive: true, mode: 0o700 });
  const text = [
    "@echo off",
    "setlocal",
    `set "PATH=${paths.nodeDirectory};${dirname(paths.pnpmExecutable)};%PATH%"`,
    `set "COREPACK_HOME=${paths.corepackHome}"`,
    `set "PNPM_HOME=${paths.pnpmHome}"`,
    `"${paths.nodeExecutable}" "${paths.corepackJavaScript}" pnpm %*`,
    "exit /b %errorlevel%",
    "",
  ].join("\r\n");
  const previous = existsSync(paths.pnpmExecutable)
    ? readFileSync(paths.pnpmExecutable, "utf8")
    : null;
  if (previous === text) return { changed: false, existed: true, previous };
  writeFileSync(paths.pnpmExecutable, text, { encoding: "utf8", mode: 0o700 });
  return { changed: true, existed: previous !== null, previous };
}

function restorePnpmShim(paths, change) {
  if (!change.changed) return;
  if (change.existed) {
    writeFileSync(paths.pnpmExecutable, change.previous, { encoding: "utf8", mode: 0o700 });
  } else {
    rmSync(paths.pnpmExecutable, { force: true });
  }
}

function writeToolchainMetadata(paths, archiveSha256, options = {}) {
  if (existsSync(paths.toolchainMetadataFile)) {
    try {
      const existing = JSON.parse(readFileSync(paths.toolchainMetadataFile, "utf8"));
      if (
        existing.schemaVersion === 1 &&
        existing.nodeVersion === TOOLCHAIN_NODE_VERSION &&
        existing.pnpmVersion === TOOLCHAIN_PNPM_VERSION &&
        existing.archiveSha256 === archiveSha256
      ) {
        return;
      }
    } catch {
      // Replace only invalid metadata inside the already-contained toolchain root.
    }
  }
  writeFileSync(
    paths.toolchainMetadataFile,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        nodeVersion: TOOLCHAIN_NODE_VERSION,
        pnpmVersion: TOOLCHAIN_PNPM_VERSION,
        nodeSource: NODE_ARCHIVE_URL,
        checksumSource: NODE_CHECKSUM_URL,
        archiveSha256,
        installedAt: (options.now ?? (() => new Date()))().toISOString(),
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function defaultExtractArchive(archive, destination) {
  const extractScript = String.raw`
$ErrorActionPreference = 'Stop'
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
Expand-Archive -LiteralPath ([string]$inputData.archive) -DestinationPath ([string]$inputData.destination) -Force
`;
  const result = run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", extractScript],
    {
      input: JSON.stringify({ archive, destination }),
    },
  );
  if (result.exitCode !== 0) throw new Error("Verified Node archive extraction failed.");
}

function inspectPinnedNode(paths, runner, environment) {
  if (!existsSync(paths.nodeExecutable) || !existsSync(paths.corepackJavaScript)) return false;
  const result = runner(paths.nodeExecutable, ["--version"], { env: environment });
  return (
    result.exitCode === 0 && exactVersionFromOutput(result.stdout, "v?") === TOOLCHAIN_NODE_VERSION
  );
}

export async function bootstrapPinnedToolchain(options = {}) {
  const paths = options.paths ?? productionPaths;
  const existing = verifyPinnedToolchain({ ...options, paths });
  assertPathContained(paths.productRoot, paths.toolchainDirectory, "Toolchain directory");
  if (existing.ok) {
    const change = writePnpmShim(paths);
    const normalized = verifyPinnedToolchain({ ...options, paths });
    if (!normalized.ok) {
      restorePnpmShim(paths, change);
      throw new Error(
        "The normalized BEA pnpm wrapper failed exact version verification; the previous wrapper was restored.",
      );
    }
    writeToolchainMetadata(paths, options.pinnedArchiveSha256 ?? NODE_ARCHIVE_SHA256, options);
    await options.applyAcl?.(paths.toolchainDirectory);
    return normalized;
  }
  if (typeof options.confirm !== "function") {
    throw new Error(
      "Explicit Owner confirmation is required before downloading the BEA toolchain.",
    );
  }
  const confirmed = await options.confirm({
    action: "install-bea-toolchain",
    publisher: "OpenJS Foundation / Node.js",
    nodeUrl: NODE_ARCHIVE_URL,
    checksumUrl: NODE_CHECKSUM_URL,
    destination: paths.toolchainDirectory,
    estimatedDiskImpact: "approximately 250 MB plus pnpm cache",
    rollback: `Remove only ${paths.toolchainDirectory} after BEA is stopped.`,
  });
  if (confirmed !== true) throw new Error("Owner declined the BEA toolchain installation.");

  const environment = isolatedToolchainEnvironment(paths, options.environment);
  const runner = options.run ?? run;
  const reusableNode = inspectPinnedNode(paths, runner, environment);
  let verifiedSha256 = options.pinnedArchiveSha256 ?? NODE_ARCHIVE_SHA256;
  if (!reusableNode) {
    if (existsSync(paths.nodeDirectory)) {
      throw new Error(
        "An invalid existing BEA Node directory was preserved; remove it explicitly before retrying.",
      );
    }
    assertOfficialNodeUrl(NODE_ARCHIVE_URL, NODE_ARCHIVE_NAME);
    assertOfficialNodeUrl(NODE_CHECKSUM_URL, "SHASUMS256.txt");
    mkdirSync(paths.toolchainDownloadDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(paths.toolchainStagingDirectory, { recursive: true, mode: 0o700 });
    const archivePath = join(paths.toolchainDownloadDirectory, NODE_ARCHIVE_NAME);
    const checksumPath = join(paths.toolchainDownloadDirectory, "SHASUMS256.txt");
    const download = options.download ?? downloadOfficialFile;
    await download(NODE_CHECKSUM_URL, checksumPath, {
      expectedName: "SHASUMS256.txt",
      fetch: options.fetch,
    });
    await download(NODE_ARCHIVE_URL, archivePath, {
      expectedName: NODE_ARCHIVE_NAME,
      fetch: options.fetch,
    });
    const expectedSha256 = parseNodeChecksumManifest(readFileSync(checksumPath, "utf8"));
    if (expectedSha256 !== verifiedSha256) {
      throw new Error("The official checksum manifest did not match the pinned Node archive hash.");
    }
    verifiedSha256 = await verifyNodeArchive(archivePath, expectedSha256);
    const stage = join(paths.toolchainStagingDirectory, randomBytes(12).toString("hex"));
    assertPathContained(paths.toolchainStagingDirectory, stage, "Toolchain staging path");
    mkdirSync(stage, { recursive: true, mode: 0o700 });
    try {
      await (options.extractArchive ?? defaultExtractArchive)(archivePath, stage);
      const extracted = join(stage, `node-v${TOOLCHAIN_NODE_VERSION}-win-x64`);
      if (
        !existsSync(join(extracted, "node.exe")) ||
        !existsSync(join(extracted, "node_modules", "corepack", "dist", "corepack.js"))
      ) {
        throw new Error("Verified Node archive did not contain the expected toolchain layout.");
      }
      renameSync(extracted, paths.nodeDirectory);
    } finally {
      rmSync(stage, { force: true, recursive: true });
    }
  }

  mkdirSync(paths.corepackHome, { recursive: true, mode: 0o700 });
  mkdirSync(paths.pnpmHome, { recursive: true, mode: 0o700 });
  const corepack = runner(
    paths.nodeExecutable,
    [paths.corepackJavaScript, "prepare", `pnpm@${TOOLCHAIN_PNPM_VERSION}`, "--activate"],
    { env: environment },
  );
  if (corepack.exitCode !== 0) throw new Error("Isolated pnpm activation failed closed.");
  const change = writePnpmShim(paths);

  const ready = verifyPinnedToolchain({ ...options, paths, environment, run: runner });
  if (!ready.ok) {
    restorePnpmShim(paths, change);
    throw new Error(
      "The installed BEA toolchain failed exact version verification; the previous wrapper was restored.",
    );
  }
  writeToolchainMetadata(paths, verifiedSha256, options);
  await options.applyAcl?.(paths.toolchainDirectory);
  return ready;
}
