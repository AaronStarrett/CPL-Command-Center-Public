import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeWindowsFilesystemMissing } from "../filesystem-capabilities";

import {
  BUILD_MANIFEST_VERSION,
  checkBuildFreshness,
  createBuildManifest,
  readBuildManifest,
  writeBuildManifestAtomic,
} from "../../scripts/phase134/build-manifest.mjs";
import {
  createCertificateSetupPlan,
  inspectCertificateTrust,
  setupTrustedLocalCertificate,
  validateCertificateMetadata,
} from "../../scripts/phase134/production-certificate.mjs";
import { createProductionPaths, repositoryRoot } from "../../scripts/phase134/production-paths.mjs";
import {
  NODE_ARCHIVE_NAME,
  NODE_ARCHIVE_URL,
  NODE_CHECKSUM_URL,
  assertOfficialNodeUrl,
  bootstrapPinnedToolchain,
  isolatedToolchainEnvironment,
  parseNodeChecksumManifest,
  verifyNodeArchive,
  verifyPinnedToolchain,
} from "../../scripts/phase134/toolchain-bootstrap.mjs";

const temporaryDirectories = [];

function fixture(prefix = "bea-phase134-contract-") {
  const localAppData = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(localAppData);
  return { localAppData, paths: createProductionPaths({ localAppData }) };
}

function materializeToolchain(paths, options = {}) {
  if (options.node !== false) {
    mkdirSync(paths.nodeDirectory, { recursive: true });
    writeFileSync(paths.nodeExecutable, "synthetic pinned node");
    mkdirSync(join(paths.nodeDirectory, "node_modules", "corepack", "dist"), {
      recursive: true,
    });
    writeFileSync(paths.corepackJavaScript, "synthetic pinned corepack");
    writeFileSync(paths.corepackExecutable, "synthetic pinned corepack wrapper");
  }
  if (options.pnpm !== false) {
    mkdirSync(dirname(paths.pnpmExecutable), { recursive: true });
    writeFileSync(paths.pnpmExecutable, "synthetic canonical pnpm wrapper");
  }
}

function statusRunner(paths, options = {}) {
  const calls = [];
  const run = vi.fn((command, arguments_, invocation = {}) => {
    calls.push({ command, arguments_, invocation });
    if (command === paths.nodeExecutable && arguments_[0] === "--version") {
      return { exitCode: options.nodeExitCode ?? 0, stdout: options.nodeVersion ?? "v24.19.0" };
    }
    if (command === paths.nodeExecutable && arguments_[0] === paths.corepackJavaScript) {
      return { exitCode: options.corepackExitCode ?? 0, stdout: "prepared" };
    }
    if (command === paths.pnpmExecutable) {
      return {
        exitCode: options.pnpmExitCode ?? 0,
        stdout: options.pnpmVersion ?? "11.19.0",
      };
    }
    return { exitCode: 99, stdout: "", stderr: `unexpected command: ${command}` };
  });
  return { calls, run };
}

function createPowerShellToolchain(options = {}) {
  const { localAppData, paths } = fixture("bea phase134 powershell toolchain ");
  mkdirSync(paths.nodeDirectory, { recursive: true });
  copyFileSync(process.execPath, paths.nodeExecutable);
  mkdirSync(dirname(paths.corepackJavaScript), { recursive: true });
  writeFileSync(
    paths.corepackJavaScript,
    'if (process.argv.includes("pnpm") && process.argv.includes("--version")) console.log("11.19.0");\n',
  );
  mkdirSync(dirname(paths.pnpmExecutable), { recursive: true });
  writeFileSync(
    paths.pnpmExecutable,
    options.wrapper ?? "@echo off\r\necho 11.19.0\r\nexit /b 0\r\n",
  );
  return { localAppData, paths };
}

function windowsPowerShellExecutable() {
  return join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function windowsPowerShellEnvironment(localAppData, overrides = {}) {
  const environment = { ...process.env, ...overrides, LOCALAPPDATA: localAppData };
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase() === "PSMODULEPATH") delete environment[key];
  }
  environment.PSModulePath = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "Modules",
  );
  return environment;
}

function runPowerShellToolchainInstall(localAppData) {
  return spawnSync(
    windowsPowerShellExecutable(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(repositoryRoot, "scripts", "phase134", "ensure-toolchain.ps1"),
      "--confirm-download",
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: windowsPowerShellEnvironment(localAppData),
      windowsHide: true,
    },
  );
}

function runPowerShellToolchainCheck(localAppData, options = {}) {
  return spawnSync(
    windowsPowerShellExecutable(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(repositoryRoot, "scripts", "phase134", "ensure-toolchain.ps1"),
      "--check",
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: windowsPowerShellEnvironment(localAppData, options.environment),
      windowsHide: true,
    },
  );
}

function setMalformedPowerShellToolchainAcl(localAppData, target) {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$rights = [Security.AccessControl.FileSystemRights]::FullControl
$inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
$propagation = [Security.AccessControl.PropagationFlags]::None
$allow = [Security.AccessControl.AccessControlType]::Allow
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($currentSid, $rights, $inheritance, $propagation, $allow))
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($systemSid, $rights, $inheritance, $propagation, $allow))
$deny = [Security.AccessControl.AccessControlType]::Deny
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($systemSid, [Security.AccessControl.FileSystemRights]::WriteData, $inheritance, $propagation, $deny))
[IO.Directory]::SetAccessControl(([string]$inputData.target), $acl)
`;
  return spawnSync(
    windowsPowerShellExecutable(),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      encoding: "utf8",
      env: windowsPowerShellEnvironment(localAppData),
      input: JSON.stringify({ target }),
      windowsHide: true,
    },
  );
}

function inspectPowerShellToolchainAcl(localAppData, target) {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
$actual = Get-Acl -LiteralPath ([string]$inputData.target)
$ownerSid = [string]$actual.Owner
try { $ownerSid = ([Security.Principal.NTAccount]$actual.Owner).Translate([Security.Principal.SecurityIdentifier]).Value } catch { }
$rules = @($actual.Access | ForEach-Object {
  [ordered]@{
    sid = $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    accessType = [int]$_.AccessControlType
    rights = [int64]$_.FileSystemRights
    inheritance = [int]$_.InheritanceFlags
    propagation = [int]$_.PropagationFlags
    inherited = [bool]$_.IsInherited
  }
})
[ordered]@{ protected = [bool]$actual.AreAccessRulesProtected; ownerSid = $ownerSid; rules = $rules } |
  ConvertTo-Json -Depth 5 -Compress | Write-Output
`;
  const result = spawnSync(
    windowsPowerShellExecutable(),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      encoding: "utf8",
      env: windowsPowerShellEnvironment(localAppData),
      input: JSON.stringify({ target }),
      windowsHide: true,
    },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}

function parsePowerShellToolchainStatus(result) {
  const diagnosticLine = String(result.stdout)
    .split(/\r?\n/u)
    .find((line) => line.startsWith("BEA_TOOLCHAIN_STATUS="));
  if (!diagnosticLine) {
    throw new Error(`PowerShell toolchain diagnostic was absent: ${result.stderr}`);
  }
  return JSON.parse(diagnosticLine.slice("BEA_TOOLCHAIN_STATUS=".length));
}

afterEach(async () => {
  for (const path of temporaryDirectories.splice(0)) {
    await rm(path, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
  }
});

describe("Phase 1.3.4 verified toolchain contract", () => {
  it("allows only the exact official Node archive and checksum URLs", () => {
    expect(assertOfficialNodeUrl(NODE_ARCHIVE_URL, NODE_ARCHIVE_NAME)).toBe(NODE_ARCHIVE_URL);
    expect(assertOfficialNodeUrl(NODE_CHECKSUM_URL, "SHASUMS256.txt")).toBe(NODE_CHECKSUM_URL);
    for (const candidate of [
      "http://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip",
      "https://example.com/dist/v24.19.0/node-v24.19.0-win-x64.zip",
      "https://nodejs.org/dist/v24.19.1/node-v24.19.0-win-x64.zip",
      `${NODE_ARCHIVE_URL}?download=1`,
    ]) {
      expect(() => assertOfficialNodeUrl(candidate, NODE_ARCHIVE_NAME)).toThrow(/allowlist/iu);
    }
  });

  it("parses one exact checksum and refuses archive mismatch", async () => {
    const { localAppData } = fixture();
    const archive = join(localAppData, NODE_ARCHIVE_NAME);
    writeFileSync(archive, "verified synthetic archive bytes");
    const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
    expect(parseNodeChecksumManifest(`${digest}  ${NODE_ARCHIVE_NAME}\n`)).toBe(digest);
    await expect(verifyNodeArchive(archive, digest)).resolves.toBe(digest);
    await expect(verifyNodeArchive(archive, "0".repeat(64))).rejects.toThrow(/mismatch/iu);
    expect(() =>
      parseNodeChecksumManifest(
        `${digest}  ${NODE_ARCHIVE_NAME}\n${digest}  ${NODE_ARCHIVE_NAME}\n`,
      ),
    ).toThrow(/uniquely/iu);
  });

  it("bootstraps only after confirmation with injected download/extraction and exact versions", async () => {
    const { paths } = fixture("bea-phase134-toolchain-");
    const archiveBytes = Buffer.from("synthetic official archive fixture");
    const digest = createHash("sha256").update(archiveBytes).digest("hex");
    const download = vi.fn(async (url, destination) => {
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(
        destination,
        url === NODE_CHECKSUM_URL ? `${digest}  ${NODE_ARCHIVE_NAME}\n` : archiveBytes,
      );
    });
    const extractArchive = vi.fn(async (_archive, destination) => {
      const root = join(destination, "node-v24.19.0-win-x64");
      mkdirSync(join(root, "node_modules", "corepack", "dist"), { recursive: true });
      writeFileSync(join(root, "node.exe"), "synthetic node");
      writeFileSync(join(root, "corepack.cmd"), "synthetic corepack");
      writeFileSync(
        join(root, "node_modules", "corepack", "dist", "corepack.js"),
        "synthetic corepack",
      );
    });
    const run = vi.fn((command) => ({
      exitCode: 0,
      stdout: command === paths.nodeExecutable ? "v24.19.0" : "11.19.0",
      stderr: "",
    }));
    await expect(
      bootstrapPinnedToolchain({ paths, download, extractArchive, run }),
    ).rejects.toThrow(/confirmation/iu);
    const ready = await bootstrapPinnedToolchain({
      paths,
      download,
      extractArchive,
      run,
      pinnedArchiveSha256: digest,
      confirm: async () => true,
      now: () => new Date("2026-08-24T12:00:00.000Z"),
    });
    expect(ready).toMatchObject({
      ok: true,
      nodeVersion: "24.19.0",
      pnpmVersion: "11.19.0",
    });
    expect(download).toHaveBeenCalledTimes(2);
    expect(extractArchive).toHaveBeenCalledTimes(1);
    expect(readFileSync(paths.toolchainMetadataFile, "utf8")).toContain(digest);
    expect(existsSync(paths.pnpmExecutable)).toBe(true);
    expect(verifyPinnedToolchain({ paths, run }).ok).toBe(true);
  });
});

describe("Phase 1.3.4 focused canonical toolchain correction", () => {
  it("1. accepts exact Node 24.19.0 and pnpm 11.19.0", () => {
    const { paths } = fixture();
    materializeToolchain(paths);
    const { run } = statusRunner(paths);
    expect(verifyPinnedToolchain({ paths, run })).toMatchObject({
      ok: true,
      nodeVersion: "24.19.0",
      nodeReady: true,
      pnpmVersion: "11.19.0",
      pnpmReady: true,
      toolchainReady: true,
    });
  });

  it("2. ignores ambient Node 20 when BEA-owned Node 24 is installed", () => {
    const { localAppData } = createPowerShellToolchain({
      wrapper: [
        "@echo off",
        'node --version | findstr /x "v24.19.0" >nul',
        "if errorlevel 1 exit /b 7",
        "echo 11.19.0",
        "exit /b 0",
        "",
      ].join("\r\n"),
    });
    const ambient = join(localAppData, "ambient-node-20");
    mkdirSync(ambient, { recursive: true });
    writeFileSync(join(ambient, "node.cmd"), "@echo off\r\necho v20.12.2\r\n");
    const ambientPath = `${ambient};${process.env.SystemRoot}\\System32`;
    const result = runPowerShellToolchainCheck(localAppData, {
      environment: { Path: ambientPath, PATH: ambientPath },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"NodeVersion":"24.19.0"');
    expect(result.stdout).toContain('"ToolchainReady":true');
  });

  it("3. reports only the canonical BEA Node path", () => {
    const { paths } = fixture();
    materializeToolchain(paths);
    const { run } = statusRunner(paths);
    const status = verifyPinnedToolchain({ paths, run });
    expect(status.nodePath).toBe(paths.nodeExecutable);
    expect(status.nodePath).toBe(join(paths.nodeDirectory, "node.exe"));
  });

  it("4. reports only the canonical BEA pnpm wrapper path", () => {
    const { paths } = fixture();
    materializeToolchain(paths);
    const { run } = statusRunner(paths);
    const status = verifyPinnedToolchain({ paths, run });
    expect(status.pnpmPath).toBe(paths.pnpmExecutable);
    expect(status.pnpmPath).toBe(join(paths.toolchainDirectory, "bin", "pnpm.cmd"));
  });

  it("5. ignores internal node_modules and Corepack shims", () => {
    const { paths } = fixture();
    materializeToolchain(paths);
    for (const relativePath of [
      ["node_modules", "corepack", "shims", "pnpm.cmd"],
      ["node_modules", "corepack", "shims", "nodewin", "pnpm.cmd"],
      ["node_modules", "npm", "bin", "npm.cmd"],
    ]) {
      const path = join(paths.nodeDirectory, ...relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "forbidden internal shim");
    }
    const { calls, run } = statusRunner(paths);
    expect(verifyPinnedToolchain({ paths, run }).ok).toBe(true);
    expect(calls.map((call) => call.command)).toEqual([paths.nodeExecutable, paths.pnpmExecutable]);
  });

  it("6. never confuses npm 11.17.0 with pnpm 11.19.0", () => {
    const { paths } = fixture();
    materializeToolchain(paths);
    const npm = join(paths.nodeDirectory, "npm.cmd");
    writeFileSync(npm, "synthetic npm 11.17.0");
    const { calls, run } = statusRunner(paths);
    const status = verifyPinnedToolchain({ paths, run });
    expect(status.pnpmVersion).toBe("11.19.0");
    expect(calls.some((call) => call.command === npm)).toBe(false);
  });

  it("7. diagnoses a missing canonical Node executable", () => {
    const { paths } = fixture();
    materializeToolchain(paths, { node: false });
    const { run } = statusRunner(paths);
    expect(verifyPinnedToolchain({ paths, run })).toMatchObject({
      code: "NODE_MISSING",
      nodeReady: false,
      pnpmReady: false,
      toolchainReady: false,
    });

    const powershellFixture = createPowerShellToolchain();
    rmSync(powershellFixture.paths.nodeExecutable, { force: true });
    const result = runPowerShellToolchainCheck(powershellFixture.localAppData);
    expect(result.status).toBe(1);
    expect(parsePowerShellToolchainStatus(result)).toMatchObject({
      Code: "NODE_MISSING",
      NodeReady: false,
      PnpmReady: false,
      ToolchainReady: false,
    });
  });

  it("8. diagnoses a wrong canonical Node version without invoking pnpm", () => {
    const { paths } = fixture();
    materializeToolchain(paths);
    const { calls, run } = statusRunner(paths, { nodeVersion: "v24.18.0" });
    expect(verifyPinnedToolchain({ paths, run })).toMatchObject({
      code: "NODE_VERSION_MISMATCH",
      nodeVersion: "24.18.0",
      nodeReady: false,
      pnpmReady: false,
    });
    expect(calls).toHaveLength(1);
  });

  it("9. diagnoses a missing canonical pnpm wrapper", () => {
    const { paths } = fixture();
    materializeToolchain(paths, { pnpm: false });
    const { run } = statusRunner(paths);
    expect(verifyPinnedToolchain({ paths, run })).toMatchObject({
      code: "PNPM_MISSING",
      nodeReady: true,
      pnpmReady: false,
      toolchainReady: false,
    });

    const powershellFixture = createPowerShellToolchain();
    rmSync(powershellFixture.paths.pnpmExecutable, { force: true });
    const result = runPowerShellToolchainCheck(powershellFixture.localAppData);
    expect(result.status).toBe(1);
    expect(parsePowerShellToolchainStatus(result)).toMatchObject({
      Code: "PNPM_MISSING",
      NodeReady: true,
      PnpmReady: false,
      ToolchainReady: false,
    });
  });

  it("10. diagnoses a wrong pnpm version", () => {
    const { paths } = fixture();
    materializeToolchain(paths);
    const { run } = statusRunner(paths, { pnpmVersion: "11.18.0" });
    expect(verifyPinnedToolchain({ paths, run })).toMatchObject({
      code: "PNPM_VERSION_MISMATCH",
      pnpmVersion: "11.18.0",
      pnpmReady: false,
    });
    const ambiguous = statusRunner(paths, { pnpmVersion: "warning\n11.19.0" });
    expect(verifyPinnedToolchain({ paths, run: ambiguous.run })).toMatchObject({
      code: "PNPM_VERSION_MISMATCH",
      pnpmVersion: "",
      pnpmReady: false,
    });

    const powershellFixture = createPowerShellToolchain({
      wrapper: "@echo off\r\necho 11.18.0\r\nexit /b 0\r\n",
    });
    const result = runPowerShellToolchainCheck(powershellFixture.localAppData);
    expect(result.status).toBe(1);
    expect(parsePowerShellToolchainStatus(result)).toMatchObject({
      Code: "PNPM_VERSION_MISMATCH",
      PnpmVersion: "11.18.0",
      PnpmReady: false,
      PnpmExitCode: 0,
    });
  });

  it("11. writes a wrapper that cannot resolve pnpm through global Node", async () => {
    const { paths } = fixture();
    materializeToolchain(paths, { pnpm: false });
    const { run } = statusRunner(paths);
    await bootstrapPinnedToolchain({ paths, run, confirm: async () => true });
    const wrapper = readFileSync(paths.pnpmExecutable, "utf8");
    expect(wrapper).toContain(
      `set "PATH=${paths.nodeDirectory};${dirname(paths.pnpmExecutable)};%PATH%"`,
    );
    expect(wrapper).toContain(`"${paths.nodeExecutable}" "${paths.corepackJavaScript}" pnpm %*`);
    expect(wrapper).not.toMatch(/^\s*node\s/imu);
  });

  it("12. diagnoses a corrupted canonical pnpm wrapper", () => {
    const { paths } = fixture();
    materializeToolchain(paths);
    const { run } = statusRunner(paths, { pnpmExitCode: 1, pnpmVersion: "corrupted" });
    expect(verifyPinnedToolchain({ paths, run })).toMatchObject({
      code: "PNPM_FAILED",
      pnpmReady: false,
      toolchainReady: false,
    });

    const powershellFixture = createPowerShellToolchain({
      wrapper: "@echo off\r\necho corrupted\r\nexit /b 9\r\n",
    });
    const result = runPowerShellToolchainCheck(powershellFixture.localAppData);
    expect(result.status).toBe(1);
    expect(parsePowerShellToolchainStatus(result)).toMatchObject({
      Code: "PNPM_FAILED",
      PnpmVersion: null,
      PnpmReady: false,
      PnpmExitCode: 9,
      ToolchainReady: false,
    });
  });

  it("13. makes repeated setup checks safe and idempotent", async () => {
    const { localAppData, paths } = createPowerShellToolchain();
    const originalWrapper = readFileSync(paths.pnpmExecutable, "utf8");
    const first = runPowerShellToolchainCheck(localAppData);
    const second = runPowerShellToolchainCheck(localAppData);
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(readFileSync(paths.pnpmExecutable, "utf8")).toBe(originalWrapper);
    expect(existsSync(paths.toolchainMetadataFile)).toBe(false);

    const repeated = fixture("bea-phase134-repeated-bootstrap-").paths;
    materializeToolchain(repeated);
    const { run } = statusRunner(repeated);
    const confirm = vi.fn(async () => true);
    const download = vi.fn();
    await bootstrapPinnedToolchain({ paths: repeated, run, confirm, download });
    await bootstrapPinnedToolchain({ paths: repeated, run, confirm, download });
    expect(confirm).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it("14. reuses an existing valid Node runtime while repairing pnpm", async () => {
    const { paths } = fixture();
    materializeToolchain(paths, { pnpm: false });
    const { run } = statusRunner(paths);
    const download = vi.fn();
    const extractArchive = vi.fn();
    const ready = await bootstrapPinnedToolchain({
      paths,
      run,
      download,
      extractArchive,
      confirm: async () => true,
    });
    expect(ready.toolchainReady).toBe(true);
    expect(download).not.toHaveBeenCalled();
    expect(extractArchive).not.toHaveBeenCalled();
  });

  it.skipIf(nativeWindowsFilesystemMissing("persistent ACLs", tmpdir()))(
    "repairs and reuses the native PowerShell toolchain with exact ACLs",
    () => {
      const powershellFixture = createPowerShellToolchain();
      const sentinel = join(powershellFixture.localAppData, "outside-toolchain-sentinel.txt");
      writeFileSync(sentinel, "preserve me");
      const first = runPowerShellToolchainInstall(powershellFixture.localAppData);
      expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);
      expect(first.stdout).toContain("BEA_TOOLCHAIN=PASS node=24.19.0 pnpm=11.19.0");
      expect(existsSync(powershellFixture.paths.toolchainDownloadDirectory)).toBe(false);
      expect(existsSync(powershellFixture.paths.toolchainMetadataFile)).toBe(true);
      const normalizedWrapper = readFileSync(powershellFixture.paths.pnpmExecutable, "utf8");
      const metadata = readFileSync(powershellFixture.paths.toolchainMetadataFile, "utf8");
      expect(normalizedWrapper).toContain(`"${powershellFixture.paths.nodeExecutable}"`);
      expect(normalizedWrapper).toContain(
        `"${powershellFixture.paths.corepackJavaScript}" pnpm %*`,
      );
      expect(readFileSync(sentinel, "utf8")).toBe("preserve me");

      const second = runPowerShellToolchainInstall(powershellFixture.localAppData);
      expect(second.status, second.stderr).toBe(0);
      expect(readFileSync(powershellFixture.paths.pnpmExecutable, "utf8")).toBe(normalizedWrapper);
      expect(readFileSync(powershellFixture.paths.toolchainMetadataFile, "utf8")).toBe(metadata);
      expect(readFileSync(sentinel, "utf8")).toBe("preserve me");

      const malformed = setMalformedPowerShellToolchainAcl(
        powershellFixture.localAppData,
        powershellFixture.paths.toolchainDirectory,
      );
      expect(malformed.status, malformed.stderr).toBe(0);
      const malformedAcl = inspectPowerShellToolchainAcl(
        powershellFixture.localAppData,
        powershellFixture.paths.toolchainDirectory,
      );
      expect(malformedAcl.rules).toHaveLength(3);
      expect(malformedAcl.rules.some((rule) => rule.accessType === 1)).toBe(true);

      const third = runPowerShellToolchainInstall(powershellFixture.localAppData);
      expect(third.status, third.stderr).toBe(0);
      const repairedAcl = inspectPowerShellToolchainAcl(
        powershellFixture.localAppData,
        powershellFixture.paths.toolchainDirectory,
      );
      expect(repairedAcl.protected).toBe(true);
      expect(repairedAcl.rules).toHaveLength(2);
      expect(
        repairedAcl.rules.every(
          (rule) =>
            rule.accessType === 0 &&
            rule.rights === 2_032_127 &&
            rule.inheritance === 3 &&
            rule.propagation === 0 &&
            rule.inherited === false,
        ),
      ).toBe(true);
      expect(new Set(repairedAcl.rules.map((rule) => rule.sid)).size).toBe(2);
      expect(repairedAcl.rules.some((rule) => rule.sid === "S-1-5-18")).toBe(true);
      expect(repairedAcl.rules.some((rule) => rule.sid === repairedAcl.ownerSid)).toBe(true);
      expect(readFileSync(sentinel, "utf8")).toBe("preserve me");
    },
    20_000,
  );

  it("15. never mutates the parent or machine PATH", () => {
    const { paths } = fixture();
    materializeToolchain(paths);
    const beforePath = process.env.PATH;
    const beforePathAlias = process.env.Path;
    const { calls, run } = statusRunner(paths);
    expect(verifyPinnedToolchain({ paths, run }).ok).toBe(true);
    expect(process.env.PATH).toBe(beforePath);
    expect(process.env.Path).toBe(beforePathAlias);
    expect(calls[1].invocation.env.PATH.startsWith(`${paths.nodeDirectory};`)).toBe(true);
  });

  it("16. keeps Corepack and pnpm homes process-local", () => {
    const { paths } = fixture();
    materializeToolchain(paths);
    const beforeCorepackHome = process.env.COREPACK_HOME;
    const beforePnpmHome = process.env.PNPM_HOME;
    const environment = isolatedToolchainEnvironment(paths, process.env);
    expect(environment.COREPACK_HOME).toBe(paths.corepackHome);
    expect(environment.PNPM_HOME).toBe(paths.pnpmHome);
    expect(process.env.COREPACK_HOME).toBe(beforeCorepackHome);
    expect(process.env.PNPM_HOME).toBe(beforePnpmHome);
  });

  it("17. performs no global Node, pnpm, npm, or Corepack installation", async () => {
    const { paths } = fixture();
    materializeToolchain(paths, { pnpm: false });
    const { calls, run } = statusRunner(paths);
    await bootstrapPinnedToolchain({ paths, run, confirm: async () => true });
    expect(calls.some((call) => /(?:^|[\\/])npm(?:\.cmd)?$/iu.test(call.command))).toBe(false);
    expect(calls.some((call) => call.arguments_.some((value) => value === "-g"))).toBe(false);
    const activation = calls.find((call) => call.arguments_[0] === paths.corepackJavaScript);
    expect(activation).toMatchObject({
      command: paths.nodeExecutable,
      arguments_: [paths.corepackJavaScript, "prepare", "pnpm@11.19.0", "--activate"],
    });
    expect(activation.invocation.env.COREPACK_HOME).toBe(paths.corepackHome);
    expect(activation.invocation.env.PNPM_HOME).toBe(paths.pnpmHome);
    expect(activation.invocation.env.PATH.startsWith(`${paths.nodeDirectory};`)).toBe(true);
  });

  it("18. emits exact component-level PowerShell diagnostics", () => {
    const { localAppData, paths } = createPowerShellToolchain();
    const result = runPowerShellToolchainCheck(localAppData);
    expect(result.status).toBe(0);
    const diagnostic = parsePowerShellToolchainStatus(result);
    expect(diagnostic).toEqual({
      NodePath: paths.nodeExecutable,
      NodeVersion: "24.19.0",
      NodeReady: true,
      NodeExitCode: 0,
      PnpmPath: paths.pnpmExecutable,
      PnpmVersion: "11.19.0",
      PnpmReady: true,
      PnpmExitCode: 0,
      ToolchainReady: true,
      Code: "TOOLCHAIN_READY",
    });
  });

  it("19. lets Configure-BEA continue beyond successful toolchain verification", () => {
    const { localAppData } = createPowerShellToolchain();
    const result = spawnSync(
      process.env.ComSpec ?? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"),
      ["/d", "/c", "call", join(repositoryRoot, "Configure-BEA.cmd"), "--check"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: { ...process.env, LOCALAPPDATA: localAppData },
        windowsHide: true,
        // The real Windows wrapper starts PowerShell and several verified Node
        // processes; bound the child independently of Vitest's callback timer.
        timeout: 30_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("BEA_TOOLCHAIN=PASS node=24.19.0 pnpm=11.19.0");
    expect(result.stdout).toContain("BEA Local Live Production bootstrap");
    expect(result.stdout).toContain("BEA_PHASE134_BOOTSTRAP=SETUP_REQUIRED");
  }, 35_000);

  it("20. limits rollback and cleanup to the BEA-owned toolchain root", async () => {
    const source = readFileSync(
      join(repositoryRoot, "scripts", "phase134", "ensure-toolchain.ps1"),
      "utf8",
    );
    expect(source).toContain("Rollback: stop BEA, then remove only $ToolchainRoot.");
    expect(source).toContain("Assert-ContainedPath $StagingRoot $Stage");
    expect(source).toContain("Remove-Item -LiteralPath $ResolvedStage -Recurse -Force");
    expect(source).not.toMatch(/Remove-Item[^\n]+(?:LOCALAPPDATA|ProductRoot)/iu);

    const { localAppData, paths } = fixture("bea phase134 cleanup containment ");
    const sentinel = join(localAppData, "outside-toolchain-sentinel.txt");
    writeFileSync(sentinel, "preserve me");
    const archiveBytes = Buffer.from("synthetic official archive fixture");
    const digest = createHash("sha256").update(archiveBytes).digest("hex");
    const download = async (url, destination) => {
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(
        destination,
        url === NODE_CHECKSUM_URL ? `${digest}  ${NODE_ARCHIVE_NAME}\n` : archiveBytes,
      );
    };
    const extractArchive = async (_archive, destination) => {
      writeFileSync(join(destination, "partial-extraction.txt"), "temporary");
      throw new Error("synthetic extraction failure");
    };
    await expect(
      bootstrapPinnedToolchain({
        paths,
        download,
        extractArchive,
        pinnedArchiveSha256: digest,
        confirm: async () => true,
      }),
    ).rejects.toThrow("synthetic extraction failure");
    expect(readFileSync(sentinel, "utf8")).toBe("preserve me");
    expect(readdirSync(paths.toolchainStagingDirectory)).toEqual([]);
  });
});

describe("Phase 1.3.4 trusted local certificate contract", () => {
  it("requires a loopback-safe hostname and models CurrentUser trust only", () => {
    const { paths } = fixture("bea-phase134-certificate-");
    expect(createCertificateSetupPlan({ paths })).toMatchObject({
      hostname: "bea.localhost",
      trustStore: "Cert:\\CurrentUser\\Root",
      privateKeyStore: "Cert:\\CurrentUser\\My",
      sans: ["bea.localhost", "localhost", "127.0.0.1", "::1"],
    });
    expect(() => createCertificateSetupPlan({ paths, hostname: "public.example" })).toThrow(
      /loopback/iu,
    );
  });

  it("requires explicit trust approval and validates generated metadata", async () => {
    const { paths } = fixture("bea-phase134-certificate-setup-");
    const metadata = {
      schemaVersion: 1,
      hostname: "bea.localhost",
      subject: "CN=bea.localhost",
      issuer: "CN=BEA Local Production Root",
      certificateThumbprint: "A".repeat(40),
      rootThumbprint: "B".repeat(40),
      sans: ["bea.localhost", "localhost", "127.0.0.1", "::1"],
      notBefore: "2026-08-24T00:00:00.000Z",
      notAfter: "2027-08-24T00:00:00.000Z",
      trustStore: "Cert:\\CurrentUser\\Root",
      privateKeyStore: "Cert:\\CurrentUser\\My",
      pfxPath: paths.certificatePfxFile,
      rootCertificatePath: paths.certificateRootFile,
    };
    await expect(
      setupTrustedLocalCertificate({ paths, pfxPassword: "p".repeat(48) }),
    ).rejects.toThrow(/confirmation/iu);
    const executePowerShell = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify(metadata),
    }));
    const inspectTrust = vi.fn(async () => ({
      trusted: true,
      contractValid: true,
      rootTrusted: true,
      leafPresent: true,
      leafHasPrivateKey: true,
      pfxPresent: true,
      rootCertificatePresent: true,
      notAfter: metadata.notAfter,
    }));
    const result = await setupTrustedLocalCertificate({
      paths,
      pfxPassword: "p".repeat(48),
      confirmTrust: async () => true,
      executePowerShell,
      inspectTrust,
      now: new Date("2026-08-24T12:00:00.000Z"),
    });
    expect(result).toMatchObject({
      hostname: "bea.localhost",
      certificateThumbprint: "A".repeat(40),
      renewalWarning: false,
    });
    expect(executePowerShell).toHaveBeenCalledTimes(1);
    expect(inspectTrust).toHaveBeenCalledTimes(1);
    const [setupPowerShellScript, setupInput, setupInvocationOptions] =
      executePowerShell.mock.calls[0];
    expect(setupPowerShellScript).not.toContain("p".repeat(48));
    expect(JSON.parse(setupInput).pfxPassword).toBe("p".repeat(48));
    expect(setupInvocationOptions).not.toHaveProperty("pfxPassword");
    expect(inspectTrust.mock.calls[0][1]).toMatchObject({
      pfxPassword: "p".repeat(48),
      metadataValidated: true,
    });
    expect(
      validateCertificateMetadata(metadata, {
        productRoot: paths.productRoot,
        now: new Date("2026-08-24T12:00:00.000Z"),
      }).daysUntilExpiration,
    ).toBeGreaterThan(300);
    mkdirSync(paths.certificateDirectory, { recursive: true });
    writeFileSync(paths.certificatePfxFile, "synthetic encrypted PFX fixture");
    writeFileSync(paths.certificateRootFile, "synthetic root certificate fixture");
    const pfxPassword = "q".repeat(48);
    const actualInspection = {
      rootTrusted: true,
      leafPresent: true,
      leafHasPrivateKey: true,
      rootSignerPresent: true,
      rootSignerHasPrivateKey: true,
      pfxHasPrivateKey: true,
      rootFileHasPrivateKey: false,
      pfxLeafThumbprint: metadata.certificateThumbprint,
      storeLeafThumbprint: metadata.certificateThumbprint,
      storeRootThumbprint: metadata.rootThumbprint,
      storeRootSignerThumbprint: metadata.rootThumbprint,
      rootFileThumbprint: metadata.rootThumbprint,
      subject: metadata.subject,
      issuer: metadata.issuer,
      sans: metadata.sans,
      sansMatch: true,
      hostnameMatch: true,
      enhancedKeyUsages: ["1.3.6.1.5.5.7.3.1"],
      serverAuthPurpose: true,
      leafCurrentlyValid: true,
      rootCurrentlyValid: true,
      notBefore: metadata.notBefore,
      notAfter: metadata.notAfter,
      rootNotAfter: "2031-08-24T00:00:00.000Z",
      chainBuilt: true,
      chainRootThumbprint: metadata.rootThumbprint,
      chainStatus: [],
    };
    const inspectPowerShell = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify(actualInspection),
    }));
    const trust = await inspectCertificateTrust(metadata, {
      productRoot: paths.productRoot,
      now: new Date("2026-08-24T12:00:00.000Z"),
      pfxPassword,
      executePowerShell: inspectPowerShell,
    });
    expect(trust).toMatchObject({
      trusted: true,
      contractValid: true,
      leafHasPrivateKey: true,
      rootSignerHasPrivateKey: true,
      pfxHasPrivateKey: true,
      privateKeysReady: true,
      thumbprintsMatch: true,
      identityMatches: true,
      validityMatchesMetadata: true,
      chainValid: true,
      serverAuthPurpose: true,
    });
    const [inspectionScript, inspectionInput, invocationOptions] = inspectPowerShell.mock.calls[0];
    expect(inspectionScript).toContain("[Console]::In.ReadToEnd()");
    expect(inspectionScript).toContain("X509KeyStorageFlags]::EphemeralKeySet");
    expect(inspectionScript).toContain("Cert:\\CurrentUser\\Root\\");
    expect(inspectionScript).toContain("Cert:\\CurrentUser\\My\\");
    expect(inspectionScript).toContain("Read-SubjectAlternativeNames");
    expect(inspectionScript).toContain("$chain.Build($pfx)");
    expect(inspectionScript).toMatch(/ApplicationPolicy\.Add\([^\n]+\) \| Out-Null/u);
    expect(inspectionScript).toContain("1.3.6.1.5.5.7.3.1");
    expect(inspectionScript).not.toContain(pfxPassword);
    expect(JSON.parse(inspectionInput).pfxPassword).toBe(pfxPassword);
    expect(invocationOptions).not.toHaveProperty("pfxPassword");

    for (const mutation of [
      { pfxLeafThumbprint: "C".repeat(40) },
      { sans: ["localhost"], sansMatch: false, hostnameMatch: false },
      { rootFileThumbprint: "C".repeat(40) },
      { storeRootSignerThumbprint: "C".repeat(40) },
      { pfxHasPrivateKey: false },
      { rootFileHasPrivateKey: true },
      { notBefore: "2026-08-23T00:00:00.000Z" },
      { chainBuilt: false },
      { enhancedKeyUsages: ["1.3.6.1.5.5.7.3.2"], serverAuthPurpose: false },
    ]) {
      const rejected = await inspectCertificateTrust(metadata, {
        productRoot: paths.productRoot,
        now: new Date("2026-08-24T12:00:00.000Z"),
        pfxPassword,
        executePowerShell: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({ ...actualInspection, ...mutation }),
        }),
      });
      expect(rejected.contractValid).toBe(false);
    }

    await expect(
      inspectCertificateTrust(metadata, {
        productRoot: paths.productRoot,
        now: new Date("2026-08-24T12:00:00.000Z"),
        executePowerShell: inspectPowerShell,
      }),
    ).rejects.toThrow(/PFX password/iu);
  });
});

describe("Phase 1.3.4 build freshness manifest", () => {
  it("records and compares commit, toolchain, schema, migration, and lock hash", () => {
    const { paths, localAppData } = fixture("bea-phase134-manifest-");
    const migrations = join(localAppData, "migrations");
    mkdirSync(migrations, { recursive: true });
    writeFileSync(join(migrations, "0001_initial.sql"), "SELECT 1;");
    writeFileSync(join(migrations, "0002_current.sql"), "SELECT 2;");
    const lockfile = join(localAppData, "pnpm-lock.yaml");
    writeFileSync(lockfile, "lockfileVersion: '9.0'\n");
    const manifest = createBuildManifest({
      paths,
      toolchainStatus: { ok: true, nodeVersion: "24.19.0", pnpmVersion: "11.19.0" },
      gitCommit: "c".repeat(40),
      migrationDirectory: migrations,
      lockfilePath: lockfile,
      now: () => new Date("2026-08-24T12:00:00.000Z"),
    });
    expect(manifest).toMatchObject({
      manifestVersion: BUILD_MANIFEST_VERSION,
      gitCommit: "c".repeat(40),
      nodeVersion: "24.19.0",
      pnpmVersion: "11.19.0",
      configSchemaVersion: 1,
      databaseMigrationVersion: "0002_current",
    });
    writeBuildManifestAtomic(manifest, {
      filePath: paths.buildManifestFile,
      allowedRoot: paths.runtimeDirectory,
    });
    expect(readBuildManifest({ filePath: paths.buildManifestFile })).toEqual(manifest);
    const expected = { ...manifest };
    expect(checkBuildFreshness(manifest, expected, { paths })).toEqual({
      fresh: true,
      mismatches: [],
      rebuildCommand: `"${paths.pnpmExecutable}" build`,
    });
    expect(checkBuildFreshness(manifest, { ...expected, gitCommit: "d".repeat(40) })).toMatchObject(
      {
        fresh: false,
        mismatches: ["gitCommit"],
      },
    );
  });
});
