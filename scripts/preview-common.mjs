import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { assertRepositoryBoundary } from "./repository-boundary.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

export const repositoryRoot = resolve(scriptDirectory, "..");
export const previewHost = "127.0.0.1";
export const previewPorts = Object.freeze({ control: 3_102, web: 3_100, workerHealth: 3_101 });
export const previewWebUrl = `http://${previewHost}:${String(previewPorts.web)}`;
export const previewSignInUrl = `${previewWebUrl}/sign-in`;
export const previewWorkerHealthUrl = `http://${previewHost}:${String(previewPorts.workerHealth)}/health`;
export const previewControlUrl = `http://${previewHost}:${String(previewPorts.control)}`;
export const previewAuthority = "Start-BEA-Preview.cmd";
export const ownerEvaluationPorts = Object.freeze({
  control: 3_302,
  web: 3_300,
  workerHealth: 3_301,
});
export const ownerEvaluationWebUrl = `http://${previewHost}:${String(ownerEvaluationPorts.web)}`;
export const ownerEvaluationSignInUrl = `${ownerEvaluationWebUrl}/sign-in`;

export function ownerEvaluationBrowserSignInUrl(source = process.env) {
  const publicOrigin = source.BEA_OWNER_EVALUATION_PUBLIC_ORIGIN?.trim();
  if (publicOrigin) {
    try {
      return `${new URL(publicOrigin).origin}/sign-in`;
    } catch {
      return ownerEvaluationSignInUrl;
    }
  }
  return ownerEvaluationSignInUrl;
}
export const ownerEvaluationWorkerHealthUrl = `http://${previewHost}:${String(ownerEvaluationPorts.workerHealth)}/health`;
export const ownerEvaluationControlUrl = `http://${previewHost}:${String(ownerEvaluationPorts.control)}`;
export const ownerEvaluationAuthority = "Start-BEA-Owner-Acceptance.cmd";
export const expectedNodeVersion = "24.19.0";
export const expectedPnpmVersion = "11.19.0";

const previewRoot = join(repositoryRoot, ".data", "bea-preview");

export const previewPaths = Object.freeze({
  artifactDirectory: join(previewRoot, "artifacts"),
  databaseDirectory: join(previewRoot, "pglite"),
  initializationFile: join(previewRoot, "preview-initialized.json"),
  launchLockFile: join(previewRoot, "preview-launch.lock"),
  logDirectory: join(previewRoot, "logs"),
  metadataFile: join(previewRoot, "preview-process.json"),
  root: previewRoot,
});

export const previewLaunchRecoveryFile = `${previewPaths.launchLockFile}.recovering`;

const ownerEvaluationRoot = join(repositoryRoot, ".data", "bea-owner-evaluation");

export const ownerEvaluationPaths = Object.freeze({
  artifactDirectory: join(ownerEvaluationRoot, "artifacts"),
  databaseDirectory: join(ownerEvaluationRoot, "pglite"),
  initializationFile: join(ownerEvaluationRoot, "owner-evaluation-initialized.json"),
  launchLockFile: join(ownerEvaluationRoot, "owner-evaluation-launch.lock"),
  logDirectory: join(ownerEvaluationRoot, "logs"),
  metadataFile: join(ownerEvaluationRoot, "owner-evaluation-process.json"),
  secretDirectory: join(ownerEvaluationRoot, "secrets"),
  root: ownerEvaluationRoot,
});

export const ownerEvaluationLaunchRecoveryFile = `${ownerEvaluationPaths.launchLockFile}.recovering`;

const safeEnvironmentKeys = Object.freeze([
  "APPDATA",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USERPROFILE",
]);

const canonicalWindowsRoot = "C:\\Windows";
const canonicalWindowsSystem32 = join(canonicalWindowsRoot, "System32");
const canonicalCommandPrompt = join(canonicalWindowsSystem32, "cmd.exe");
const canonicalWindowsPowerShell = join(
  canonicalWindowsSystem32,
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

const metadataStates = new Set(["starting", "ready", "failed", "stopping"]);
const childNames = Object.freeze(["web", "worker"]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeWindowsPath(value) {
  return resolve(value)
    .replace(/[\\/]+$/u, "")
    .toLowerCase();
}

export function pathsEqual(left, right) {
  return normalizeWindowsPath(left) === normalizeWindowsPath(right);
}

export function isPathWithin(candidate, parent) {
  const candidatePath = normalizeWindowsPath(candidate);
  const parentPath = normalizeWindowsPath(parent);
  return candidatePath === parentPath || candidatePath.startsWith(`${parentPath}${sep}`);
}

export function assertPreviewBoundary(options = {}) {
  return (options.assertBoundary ?? assertRepositoryBoundary)({
    cwd: options.cwd ?? process.cwd(),
    target: options.repositoryRoot ?? repositoryRoot,
  });
}

function relativePreviewPath(path) {
  const relationship = relative(repositoryRoot, resolve(path));
  if (!relationship || relationship.startsWith("..") || isAbsolute(relationship)) {
    throw new Error("Preview path is outside the canonical BEA repository.");
  }
  return relationship.replaceAll("\\", "/");
}

export function assertNoReparsePreviewPath(target, options = {}) {
  const root = resolve(options.repositoryRoot ?? repositoryRoot);
  const candidate = resolve(target);
  if (!isPathWithin(candidate, root)) {
    throw new Error("Preview path must remain inside the canonical BEA repository.");
  }
  const inspect = options.lstat ?? lstatSync;
  const relationship = relative(root, candidate);
  let current = root;
  const chain = [
    root,
    ...relationship
      .split(/[\\/]/u)
      .filter(Boolean)
      .map((segment) => {
        current = join(current, segment);
        return current;
      }),
  ];
  for (const entry of chain) {
    let status;
    try {
      status = inspect(entry);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (status.isSymbolicLink?.()) {
      throw new Error("Preview paths cannot traverse a symbolic link, junction, or reparse point.");
    }
  }
  return candidate;
}

export function assertPreviewPathContract(paths = previewPaths, options = {}) {
  const expectedRoot = resolve(options.repositoryRoot ?? repositoryRoot, ".data", "bea-preview");
  if (!pathsEqual(paths.root, expectedRoot)) {
    throw new Error("Preview state root does not match the isolated .data/bea-preview contract.");
  }
  for (const path of Object.values(paths)) {
    if (typeof path !== "string" || !isPathWithin(path, expectedRoot)) {
      throw new Error("Every Preview persistence path must remain inside .data/bea-preview.");
    }
    assertNoReparsePreviewPath(path, options);
  }
  return paths;
}

export function ensurePreviewDirectories(paths = previewPaths, options = {}) {
  assertPreviewPathContract(paths, options);
  const makeDirectory = options.mkdir ?? mkdirSync;
  for (const path of [
    paths.root,
    paths.logDirectory,
    paths.databaseDirectory,
    paths.artifactDirectory,
  ]) {
    makeDirectory(path, { recursive: true, mode: 0o700 });
  }
  assertPreviewPathContract(paths, options);
}

export function assertOwnerEvaluationPathContract(paths = ownerEvaluationPaths, options = {}) {
  const expectedRoot = resolve(
    options.repositoryRoot ?? repositoryRoot,
    ".data",
    "bea-owner-evaluation",
  );
  if (!pathsEqual(paths.root, expectedRoot)) {
    throw new Error(
      "Owner Evaluation state root does not match the isolated .data/bea-owner-evaluation contract.",
    );
  }
  for (const path of Object.values(paths)) {
    if (typeof path !== "string" || !isPathWithin(path, expectedRoot)) {
      throw new Error(
        "Every Owner Evaluation persistence path must remain inside .data/bea-owner-evaluation.",
      );
    }
    assertNoReparsePreviewPath(path, options);
  }
  return paths;
}

export function ensureOwnerEvaluationDirectories(paths = ownerEvaluationPaths, options = {}) {
  assertOwnerEvaluationPathContract(paths, options);
  const makeDirectory = options.mkdir ?? mkdirSync;
  for (const path of [
    paths.root,
    paths.logDirectory,
    paths.databaseDirectory,
    paths.artifactDirectory,
    paths.secretDirectory,
  ]) {
    makeDirectory(path, { recursive: true, mode: 0o700 });
  }
  assertOwnerEvaluationPathContract(paths, options);
}

export function createPreviewChildEnvironment(source = process.env) {
  const environment = {};
  for (const key of safeEnvironmentKeys) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  const toolchain = canonicalToolchainPaths(source);
  const nodeDirectory = dirname(toolchain.nodeExecutable);
  const toolchainBinDirectory = dirname(toolchain.pnpmExecutable);
  const pinnedPath = [
    nodeDirectory,
    toolchainBinDirectory,
    canonicalWindowsSystem32,
    canonicalWindowsRoot,
    join(canonicalWindowsSystem32, "Wbem"),
    dirname(canonicalWindowsPowerShell),
  ].join(";");
  return {
    ...environment,
    APP_BASE_URL: previewWebUrl,
    APP_MODE: "demo",
    BEA_ARTIFACT_STORE_PATH: ".data/bea-preview/artifacts",
    BEA_AUTH_PROVIDER: "demo",
    BEA_DEPLOYMENT_PROFILE: "demo",
    BEA_DISABLE_ENV_FILE: "true",
    BEA_PREVIEW_AUTHORITY: previewAuthority,
    BEA_PREVIEW_MODE: "true",
    BEA_PREVIEW_NETWORK_GUARD: "loopback-only",
    BEA_PRODUCTION_SECRET_PATH: "",
    BEA_RUNTIME_MODE: "development",
    DATABASE_DRIVER: "pglite",
    DATABASE_URL: "",
    DEMO_AUTH_ENABLED: "true",
    DEMO_DATABASE_PATH: ".data/bea-preview/pglite",
    LOG_LEVEL: "info",
    NODE_ENV: "development",
    OPENAI_API_KEY: "",
    COMSPEC: canonicalCommandPrompt,
    ComSpec: canonicalCommandPrompt,
    PATH: pinnedPath,
    Path: pinnedPath,
    PORT: String(previewPorts.web),
    SESSION_SECRET: "",
    SYSTEMROOT: canonicalWindowsRoot,
    SystemDrive: "C:",
    SystemRoot: canonicalWindowsRoot,
    SESSION_TTL_MINUTES: "480",
    WORKER_DEMO_DATABASE_PATH: "memory://",
    WORKER_HEALTH_PORT: String(previewPorts.workerHealth),
    WORKER_MODE: "serve",
    WORKER_POLL_INTERVAL_MS: "60000",
    WORKER_QUEUE_ADAPTER: "inline",
    WINDIR: canonicalWindowsRoot,
  };
}

export function createOwnerEvaluationChildEnvironment(source = process.env) {
  const preview = createPreviewChildEnvironment(source);
  const sessionSecret =
    typeof source.SESSION_SECRET === "string" && source.SESSION_SECRET.length >= 64
      ? source.SESSION_SECRET
      : randomBytes(32).toString("hex");
  return {
    ...preview,
    APP_BASE_URL: ownerEvaluationWebUrl,
    BEA_ARTIFACT_STORE_PATH: ".data/bea-owner-evaluation/artifacts",
    BEA_DEPLOYMENT_PROFILE: "owner-evaluation",
    BEA_OWNER_EVALUATION: "true",
    BEA_OWNER_EVALUATION_AUTHORITY: ownerEvaluationAuthority,
    BEA_OWNER_EVALUATION_NETWORK_GUARD: "loopback-only",
    BEA_OWNER_EVALUATION_PUBLIC_ORIGIN: source.BEA_OWNER_EVALUATION_PUBLIC_ORIGIN ?? "",
    BEA_PREVIEW_AUTHORITY: "",
    BEA_PREVIEW_MODE: "",
    DEMO_DATABASE_PATH: ".data/bea-owner-evaluation/pglite",
    // Preserve a process-only Cloud runtime secret. Windows Start-BEA-Owner-Acceptance.cmd
    // blanks OPENAI_API_KEY before invoking this helper so DPAPI remains the Windows path.
    OPENAI_API_KEY:
      typeof source.OPENAI_API_KEY === "string" && source.OPENAI_API_KEY.trim()
        ? source.OPENAI_API_KEY
        : "",
    PORT: String(ownerEvaluationPorts.web),
    SESSION_SECRET: sessionSecret,
    WORKER_HEALTH_PORT: String(ownerEvaluationPorts.workerHealth),
  };
}

export function canonicalToolchainPaths(environment = process.env) {
  const localAppData = environment.LOCALAPPDATA;
  if (typeof localAppData !== "string" || !isAbsolute(localAppData)) {
    throw new Error("LOCALAPPDATA is required to locate the canonical BEA toolchain.");
  }
  const root = resolve(localAppData, "BEA", "CommandCenter", "toolchain");
  return Object.freeze({
    nodeExecutable: join(root, `node-v${expectedNodeVersion}-win-x64`, "node.exe"),
    pnpmExecutable: join(root, "bin", "pnpm.cmd"),
    root,
  });
}

export function createWindowsCommandLine(command, arguments_) {
  if (!isAbsolute(command) || !/\.cmd$/iu.test(command)) {
    throw new Error("Preview pnpm must be an absolute Windows command-wrapper path.");
  }
  const tokens = [command, ...arguments_.map((value) => String(value))];
  for (const token of tokens) {
    if (/[\0\r\n"%!]/u.test(token)) {
      throw new Error("Preview command contains an unsupported Windows command token.");
    }
  }
  // cmd.exe /s /c requires the extra outer quote pair when the executable itself is quoted.
  // Every value here is either the pinned absolute pnpm.cmd path or a fixed launcher argument.
  return `"${tokens.map((token) => `"${token}"`).join(" ")}"`;
}

function runWindowsCommand(command, arguments_, options = {}) {
  const shell = systemCommandPromptPath(options);
  const commandLine = createWindowsCommandLine(command, arguments_);
  return (options.spawnSync ?? spawnSync)(shell, ["/d", "/s", "/c", commandLine], {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: options.environment,
    shell: false,
    stdio: options.stdio ?? "pipe",
    windowsVerbatimArguments: true,
    windowsHide: true,
  });
}

export function inspectCanonicalToolchain(options = {}) {
  const environment = options.environment ?? process.env;
  const paths = options.toolchainPaths ?? canonicalToolchainPaths(environment);
  const fileExists = options.exists ?? existsSync;
  const nodePresent = fileExists(paths.nodeExecutable);
  const pnpmPresent = fileExists(paths.pnpmExecutable);
  const nodeVersion = String(options.nodeVersion ?? process.version).replace(/^v/u, "");
  let pnpmVersion = "";
  let pnpmExitCode = 1;
  if (pnpmPresent && options.requirePnpm !== false) {
    const childEnvironment = createPreviewChildEnvironment(environment);
    const result = (options.runPnpmVersion ?? runWindowsCommand)(
      paths.pnpmExecutable,
      ["--version"],
      {
        cwd: repositoryRoot,
        environment: childEnvironment,
        spawnSync: options.spawnSync,
      },
    );
    pnpmVersion = String(result.stdout ?? "").trim();
    pnpmExitCode = result.status ?? (result.error ? 1 : 0);
  }
  const nodeReady =
    nodePresent &&
    pathsEqual(options.nodeExecutable ?? process.execPath, paths.nodeExecutable) &&
    nodeVersion === expectedNodeVersion;
  const pnpmReady =
    options.requirePnpm === false ||
    (pnpmPresent && pnpmExitCode === 0 && pnpmVersion === expectedPnpmVersion);
  return Object.freeze({
    nodeExecutable: paths.nodeExecutable,
    nodePresent,
    nodeReady,
    nodeVersion,
    pnpmExecutable: paths.pnpmExecutable,
    pnpmExitCode,
    pnpmPresent,
    pnpmReady,
    pnpmVersion,
    ready: nodeReady && pnpmReady,
  });
}

export function requireCanonicalToolchain(options = {}) {
  const status = (options.inspectToolchain ?? inspectCanonicalToolchain)(options);
  if (!status.nodeReady) {
    throw new Error(`Preview requires canonical BEA Node ${expectedNodeVersion}.`);
  }
  if (options.requirePnpm !== false && !status.pnpmReady) {
    throw new Error(`Preview requires canonical BEA pnpm ${expectedPnpmVersion}.`);
  }
  return status;
}

export function runCanonicalPnpm(pnpmExecutable, arguments_, options = {}) {
  const result = (options.runWindowsCommand ?? runWindowsCommand)(pnpmExecutable, arguments_, {
    cwd: options.cwd ?? repositoryRoot,
    environment: options.environment ?? createPreviewChildEnvironment(process.env),
    spawnSync: options.spawnSync,
    stdio: options.stdio ?? "inherit",
  });
  return {
    error: result.error,
    exitCode: result.status ?? (result.error ? 1 : 0),
    stderr: String(result.stderr ?? "").trim(),
    stdout: String(result.stdout ?? "").trim(),
  };
}

export function launchFingerprint(executable, arguments_, cwd = repositoryRoot) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        normalizeWindowsPath(executable),
        normalizeWindowsPath(cwd),
        ...arguments_.map((argument) => String(argument)),
      ]),
    )
    .digest("hex");
}

export function commandLineFingerprint(commandLine) {
  return createHash("sha256").update(String(commandLine), "utf8").digest("hex");
}

function validateNativeWindowsExecutable(expected, options = {}) {
  const candidate = resolve(options.path ?? expected);
  if (!pathsEqual(candidate, expected)) {
    throw new Error("Preview native Windows executable path is not canonical.");
  }
  const inspect = options.lstat ?? lstatSync;
  const chain = [];
  let current = candidate;
  while (true) {
    chain.unshift(current);
    const parent = dirname(current);
    if (pathsEqual(parent, current)) break;
    current = parent;
  }
  for (const path of chain) {
    const status = inspect(path);
    if (status.isSymbolicLink?.()) {
      throw new Error("Preview native Windows executable cannot traverse a reparse point.");
    }
  }
  const fileStatus = inspect(candidate);
  if (!fileStatus.isFile?.()) {
    throw new Error("Preview native Windows executable is not a regular file.");
  }
  const nativePath = (options.realpath ?? realpathSync.native)(candidate);
  if (!pathsEqual(nativePath, expected)) {
    throw new Error("Preview native Windows executable native path is not canonical.");
  }
  return resolve(nativePath);
}

export function systemCommandPromptPath(options = {}) {
  return validateNativeWindowsExecutable(canonicalCommandPrompt, options);
}

export function systemPowerShellPath(_environment = process.env, options = {}) {
  void _environment;
  return validateNativeWindowsExecutable(canonicalWindowsPowerShell, options);
}

export function createWindowsPowerShellEnvironment(environment = process.env) {
  const sanitized = Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) =>
        !["comspec", "psmodulepath", "systemdrive", "systemroot", "windir"].includes(
          key.toLowerCase(),
        ),
    ),
  );
  return {
    ...sanitized,
    COMSPEC: canonicalCommandPrompt,
    ComSpec: canonicalCommandPrompt,
    SYSTEMROOT: canonicalWindowsRoot,
    SystemDrive: "C:",
    SystemRoot: canonicalWindowsRoot,
    WINDIR: canonicalWindowsRoot,
  };
}

export function inspectProcessIdentity(pid, options = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Process PID is invalid.");
  const environment = createWindowsPowerShellEnvironment(options.environment ?? process.env);
  const powershell = systemPowerShellPath(environment, {
    ...options,
    path: options.powershellPath ?? canonicalWindowsPowerShell,
  });
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$target = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${String(pid)}'
if ($null -eq $target) { exit 3 }
$started = $target.CreationDate.ToUniversalTime().ToString('o')
@{ pid = [int]$target.ProcessId; executablePath = [string]$target.ExecutablePath; commandLine = [string]$target.CommandLine; osStartedAt = $started } | ConvertTo-Json -Compress
`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const result = (options.spawnSync ?? spawnSync)(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { encoding: "utf8", env: environment, shell: false, windowsHide: true },
  );
  if (result.status === 3) return undefined;
  if (result.status !== 0 || result.error) {
    throw new Error("Exact Windows process inspection failed closed.");
  }
  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout ?? "").trim());
  } catch {
    throw new Error("Exact Windows process inspection returned invalid JSON.");
  }
  if (
    !isRecord(parsed) ||
    parsed.pid !== pid ||
    typeof parsed.executablePath !== "string" ||
    !isAbsolute(parsed.executablePath) ||
    typeof parsed.commandLine !== "string" ||
    parsed.commandLine.length === 0 ||
    typeof parsed.osStartedAt !== "string" ||
    Number.isNaN(Date.parse(parsed.osStartedAt))
  ) {
    throw new Error("Exact Windows process inspection returned an invalid identity.");
  }
  return Object.freeze({
    commandLineFingerprint: commandLineFingerprint(parsed.commandLine),
    executablePath: resolve(parsed.executablePath),
    osStartedAt: new Date(parsed.osStartedAt).toISOString(),
    pid,
  });
}

export function processIdentityMatches(expected, actual) {
  return (
    isRecord(expected) &&
    isRecord(actual) &&
    expected.pid === actual.pid &&
    pathsEqual(expected.executablePath, actual.executablePath) &&
    expected.commandLineFingerprint === actual.commandLineFingerprint &&
    new Date(expected.osStartedAt).toISOString() === new Date(actual.osStartedAt).toISOString()
  );
}

export function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function validProcessIdentity(value) {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.executablePath === "string" &&
    isAbsolute(value.executablePath) &&
    /^[a-f0-9]{64}$/u.test(value.commandLineFingerprint ?? "") &&
    typeof value.osStartedAt === "string" &&
    !Number.isNaN(Date.parse(value.osStartedAt))
  );
}

function sameLaunchLockOwner(left, right) {
  return (
    left?.token === right?.token &&
    left?.createdAt === right?.createdAt &&
    processIdentityMatches(left?.ownerOsIdentity, right?.ownerOsIdentity)
  );
}

export function createPreviewLaunchLock(ownerOsIdentity, token, options = {}) {
  const value = Object.freeze({
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    ownerOsIdentity: Object.freeze({ ...ownerOsIdentity }),
    profile: "preview-launch",
    repositoryRoot,
    token,
    version: 1,
  });
  const validation = validatePreviewLaunchLock(value, options);
  if (!validation.lock) throw new Error(validation.issues.join(" "));
  return value;
}

export function validatePreviewLaunchLock(value, options = {}) {
  const issues = [];
  if (!isRecord(value)) return { issues: ["Preview launch lock is not an object."] };
  const expectedKeys = [
    "createdAt",
    "ownerOsIdentity",
    "profile",
    "repositoryRoot",
    "token",
    "version",
  ];
  const unknown = Object.keys(value).filter((key) => !expectedKeys.includes(key));
  if (unknown.length > 0) {
    issues.push(`Preview launch lock has unknown fields: ${unknown.join(", ")}.`);
  }
  if (value.version !== 1 || value.profile !== "preview-launch") {
    issues.push("Preview launch lock version/profile is unsupported.");
  }
  if (
    typeof value.repositoryRoot !== "string" ||
    !pathsEqual(value.repositoryRoot, repositoryRoot)
  ) {
    issues.push("Preview launch lock repository does not match this canonical BEA checkout.");
  }
  if (!/^[a-f0-9]{64}$/u.test(value.token ?? "")) {
    issues.push("Preview launch-lock token is invalid.");
  }
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
    issues.push("Preview launch-lock timestamp is invalid.");
  }
  const expectedNode =
    options.nodeExecutable ??
    canonicalToolchainPaths(options.environment ?? process.env).nodeExecutable;
  if (!validProcessIdentity(value.ownerOsIdentity)) {
    issues.push("Preview launch-lock owner OS identity is invalid.");
  } else if (!pathsEqual(value.ownerOsIdentity.executablePath, expectedNode)) {
    issues.push("Preview launch-lock owner is not canonical BEA Node.");
  }
  return issues.length === 0 ? { issues, lock: value } : { issues };
}

export function readPreviewLaunchLock(options = {}) {
  const path = options.path ?? previewPaths.launchLockFile;
  try {
    const parsed = JSON.parse((options.readFile ?? readFileSync)(path, "utf8"));
    return { exists: true, ...validatePreviewLaunchLock(parsed, options) };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, issues: [] };
    return { exists: true, issues: ["Preview launch lock could not be read or validated."] };
  }
}

export async function inspectPreviewLaunchLock(options = {}) {
  const readLock = options.readLaunchLock ?? readPreviewLaunchLock;
  const primary = readLock({ ...options, path: options.path ?? previewPaths.launchLockFile });
  const recovery = readLock({
    ...options,
    path: options.recoveryPath ?? previewLaunchRecoveryFile,
  });
  if (primary.exists && recovery.exists) {
    return {
      issues: ["Preview launch-lock recovery ownership is ambiguous."],
      state: "ambiguous",
    };
  }
  const selected = recovery.exists
    ? { recovery: true, result: recovery }
    : { recovery: false, result: primary };
  if (!selected.result.exists) return { state: "missing" };
  if (!selected.result.lock) {
    return { issues: selected.result.issues, recovery: selected.recovery, state: "invalid" };
  }
  const lock = selected.result.lock;
  if (!(options.processIsAlive ?? processIsAlive)(lock.ownerOsIdentity.pid)) {
    return { lock, recovery: selected.recovery, state: "stale" };
  }
  let actual;
  try {
    actual = await (options.inspectProcessIdentity ?? inspectProcessIdentity)(
      lock.ownerOsIdentity.pid,
    );
  } catch {
    return { lock, recovery: selected.recovery, state: "ambiguous" };
  }
  if (!actual || !processIdentityMatches(lock.ownerOsIdentity, actual)) {
    return { lock, recovery: selected.recovery, state: "ambiguous" };
  }
  return { lock, recovery: selected.recovery, state: "live" };
}

export async function recoverStalePreviewLaunchLock(stale, options = {}) {
  if (stale?.state !== "stale" || !stale.lock) {
    throw new Error("Only a validated dead-owner Preview launch lock can be recovered.");
  }
  const inspect = options.inspectLaunchLock ?? inspectPreviewLaunchLock;
  const current = await inspect(options);
  if (
    current.state !== "stale" ||
    current.recovery !== stale.recovery ||
    !sameLaunchLockOwner(current.lock, stale.lock)
  ) {
    throw new Error("Preview launch-lock ownership changed; the lock was preserved.");
  }

  const primaryPath = options.path ?? previewPaths.launchLockFile;
  const recoveryPath = options.recoveryPath ?? previewLaunchRecoveryFile;
  if (!current.recovery) {
    try {
      (options.rename ?? renameSync)(primaryPath, recoveryPath);
    } catch (error) {
      if (["EEXIST", "ENOENT"].includes(error?.code)) return false;
      throw error;
    }
  }

  const claimed = (options.readLaunchLock ?? readPreviewLaunchLock)({
    ...options,
    path: recoveryPath,
  });
  if (!claimed.lock || !sameLaunchLockOwner(claimed.lock, stale.lock)) {
    throw new Error("Preview launch-lock recovery claim changed; evidence was preserved.");
  }
  (options.remove ?? rmSync)(recoveryPath);
  return true;
}

export function supervisorLaunchFingerprint(options = {}) {
  const nodeExecutable =
    options.nodeExecutable ?? canonicalToolchainPaths(options.environment).nodeExecutable;
  const supervisorScript =
    options.supervisorScript ?? join(repositoryRoot, "scripts", "preview-supervisor.mjs");
  return launchFingerprint(nodeExecutable, [supervisorScript], repositoryRoot);
}

export function validatePreviewMetadata(value, options = {}) {
  const issues = [];
  if (!isRecord(value)) return { issues: ["Preview metadata is not an object."] };
  const expectedKeys = [
    "children",
    "controlHost",
    "controlPort",
    "controlToken",
    "instanceId",
    "logs",
    "ports",
    "profile",
    "repositoryRoot",
    "startedAt",
    "state",
    "supervisorExecutable",
    "supervisorLaunchFingerprint",
    "supervisorOsIdentity",
    "supervisorScript",
    "updatedAt",
    "version",
  ];
  const unknown = Object.keys(value).filter((key) => !expectedKeys.includes(key));
  if (unknown.length > 0)
    issues.push(`Preview metadata has unknown fields: ${unknown.join(", ")}.`);
  if (
    value.version !== 1 ||
    (value.profile !== "preview" && value.profile !== "owner-evaluation")
  ) {
    issues.push("Preview metadata version/profile is unsupported.");
  }
  const isolatedPorts = value.profile === "owner-evaluation" ? ownerEvaluationPorts : previewPorts;
  if (
    typeof value.repositoryRoot !== "string" ||
    !pathsEqual(value.repositoryRoot, repositoryRoot)
  ) {
    issues.push("Preview metadata repository does not match this canonical BEA checkout.");
  }
  if (!/^[a-f0-9]{32}$/u.test(value.instanceId ?? ""))
    issues.push("Preview instance ID is invalid.");
  if (!/^[a-f0-9]{64}$/u.test(value.controlToken ?? ""))
    issues.push("Preview control token is invalid.");
  if (value.controlHost !== previewHost || value.controlPort !== isolatedPorts.control) {
    issues.push("Preview control endpoint does not match the fixed loopback contract.");
  }
  if (
    !isRecord(value.ports) ||
    value.ports.web !== isolatedPorts.web ||
    value.ports.workerHealth !== isolatedPorts.workerHealth ||
    value.ports.control !== isolatedPorts.control ||
    Object.keys(value.ports).sort().join(",") !== "control,web,workerHealth"
  ) {
    issues.push("Preview service ports do not match the isolated Preview profile.");
  }
  const expectedNode =
    options.nodeExecutable ?? canonicalToolchainPaths(options.environment).nodeExecutable;
  const expectedSupervisor =
    options.supervisorScript ?? join(repositoryRoot, "scripts", "preview-supervisor.mjs");
  if (
    typeof value.supervisorExecutable !== "string" ||
    !pathsEqual(value.supervisorExecutable, expectedNode)
  ) {
    issues.push("Preview supervisor executable is not canonical BEA Node.");
  }
  if (
    typeof value.supervisorScript !== "string" ||
    !pathsEqual(value.supervisorScript, expectedSupervisor)
  ) {
    issues.push("Preview supervisor script identity is invalid.");
  }
  if (
    value.supervisorLaunchFingerprint !==
    supervisorLaunchFingerprint({
      environment: options.environment,
      nodeExecutable: expectedNode,
      supervisorScript: expectedSupervisor,
    })
  ) {
    issues.push("Preview supervisor launch fingerprint is invalid.");
  }
  if (!validProcessIdentity(value.supervisorOsIdentity)) {
    issues.push("Preview supervisor OS identity is invalid.");
  } else if (!pathsEqual(value.supervisorOsIdentity.executablePath, expectedNode)) {
    issues.push("Preview supervisor OS executable does not match canonical BEA Node.");
  }
  if (!metadataStates.has(value.state)) issues.push("Preview metadata state is invalid.");
  if (
    typeof value.startedAt !== "string" ||
    Number.isNaN(Date.parse(value.startedAt)) ||
    typeof value.updatedAt !== "string" ||
    Number.isNaN(Date.parse(value.updatedAt))
  ) {
    issues.push("Preview metadata timestamps are invalid.");
  }
  if (!isRecord(value.children)) {
    issues.push("Preview child metadata is invalid.");
  } else {
    const unexpectedChildren = Object.keys(value.children).filter(
      (name) => !childNames.includes(name),
    );
    if (unexpectedChildren.length > 0)
      issues.push("Preview child metadata has unexpected entries.");
    for (const child of Object.values(value.children)) {
      if (
        !isRecord(child) ||
        !validProcessIdentity(child.osIdentity) ||
        typeof child.script !== "string" ||
        !isAbsolute(child.script) ||
        !/^[a-f0-9]{64}$/u.test(child.launchFingerprint ?? "")
      ) {
        issues.push("A Preview child identity is invalid.");
        break;
      }
    }
  }
  if (
    !isRecord(value.logs) ||
    ["supervisor", "web", "worker"].some(
      (name) =>
        typeof value.logs[name] !== "string" ||
        !isPathWithin(resolve(repositoryRoot, value.logs[name]), previewPaths.logDirectory),
    )
  ) {
    issues.push("Preview log metadata is invalid.");
  }
  return issues.length === 0 ? { issues, metadata: value } : { issues };
}

export function writeJsonAtomic(path, value, options = {}) {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let descriptor;
  try {
    descriptor = (options.open ?? openSync)(temporary, "wx", 0o600);
    (options.write ?? writeFileSync)(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    (options.fsync ?? fsyncSync)(descriptor);
    (options.close ?? closeSync)(descriptor);
    descriptor = undefined;
    (options.rename ?? renameSync)(temporary, path);
  } finally {
    if (descriptor !== undefined) (options.close ?? closeSync)(descriptor);
    (options.remove ?? rmSync)(temporary, { force: true });
  }
}

export function readPreviewMetadata(options = {}) {
  const path = options.path ?? previewPaths.metadataFile;
  try {
    const parsed = JSON.parse((options.readFile ?? readFileSync)(path, "utf8"));
    return { exists: true, ...validatePreviewMetadata(parsed, options) };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, issues: [] };
    return { exists: true, issues: ["Preview metadata could not be read or validated."] };
  }
}

function sameMetadataOwner(left, right) {
  return (
    left?.instanceId === right?.instanceId &&
    left?.controlToken === right?.controlToken &&
    left?.supervisorOsIdentity?.pid === right?.supervisorOsIdentity?.pid &&
    left?.supervisorOsIdentity?.osStartedAt === right?.supervisorOsIdentity?.osStartedAt
  );
}

export function writeMetadataOwnedBy(owner, value, options = {}) {
  const current = (options.readMetadata ?? readPreviewMetadata)(options);
  if (!current.metadata || !sameMetadataOwner(current.metadata, owner)) return false;
  const validation = validatePreviewMetadata(value, options);
  if (!validation.metadata || !sameMetadataOwner(validation.metadata, owner)) return false;
  (options.writeMetadata ?? writeJsonAtomic)(options.path ?? previewPaths.metadataFile, value);
  return true;
}

export function removeMetadataOwnedBy(owner, options = {}) {
  const current = (options.readMetadata ?? readPreviewMetadata)(options);
  if (!current.metadata || !sameMetadataOwner(current.metadata, owner)) return false;
  (options.remove ?? rmSync)(options.path ?? previewPaths.metadataFile, { force: true });
  return true;
}

export function tokensMatch(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const first = createHash("sha256").update(left).digest();
  const second = createHash("sha256").update(right).digest();
  return timingSafeEqual(first, second);
}

export async function controlRequest(metadata, path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMilliseconds ?? 3_000);
  try {
    const response = await (options.fetch ?? fetch)(
      `${options.controlUrl ?? `http://${metadata.controlHost ?? previewHost}:${String(metadata.controlPort ?? previewPorts.control)}`}${path}`,
      {
        cache: "no-store",
        headers: { "x-bea-preview-control-token": metadata.controlToken },
        method: options.method ?? "GET",
        signal: controller.signal,
      },
    );
    return {
      body: await response.json().catch(() => undefined),
      ok: response.ok,
      status: response.status,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function authenticatedStatusMatches(metadata, status) {
  return (
    isRecord(status) &&
    status.ok === true &&
    (status.profile === "preview" || status.profile === "owner-evaluation") &&
    status.instanceId === metadata.instanceId &&
    status.supervisorPid === metadata.supervisorOsIdentity.pid &&
    status.supervisorOsStartedAt === metadata.supervisorOsIdentity.osStartedAt &&
    status.supervisorCommandLineFingerprint ===
      metadata.supervisorOsIdentity.commandLineFingerprint &&
    JSON.stringify(status.ports) === JSON.stringify(metadata.ports)
  );
}

export async function inspectTrackedPreview(options = {}) {
  const metadataResult = (options.readMetadata ?? readPreviewMetadata)(options);
  if (!metadataResult.exists) return { state: "stopped" };
  if (!metadataResult.metadata) return { issues: metadataResult.issues, state: "invalid" };
  const metadata = metadataResult.metadata;
  const alive = options.processIsAlive ?? processIsAlive;
  if (!alive(metadata.supervisorOsIdentity.pid)) return { metadata, state: "stale" };
  let identity;
  try {
    identity = await (options.inspectProcessIdentity ?? inspectProcessIdentity)(
      metadata.supervisorOsIdentity.pid,
    );
  } catch {
    return { metadata, state: "unreachable" };
  }
  if (!identity || !processIdentityMatches(metadata.supervisorOsIdentity, identity)) {
    return { metadata, state: "unreachable" };
  }
  try {
    const response = await (options.controlRequest ?? controlRequest)(metadata, "/status");
    if (!response.ok || !authenticatedStatusMatches(metadata, response.body)) {
      return { metadata, state: "unreachable" };
    }
    return { metadata, state: "running", status: response.body };
  } catch {
    return { metadata, state: "unreachable" };
  }
}

export async function checkPortAvailable(port, host = previewHost, options = {}) {
  return new Promise((resolveCheck) => {
    const server = (options.createServer ?? createNetServer)();
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      server.removeAllListeners();
      resolveCheck(result);
    };
    server.once("error", (error) => finish({ available: false, code: error.code ?? "UNKNOWN" }));
    server.listen({ exclusive: true, host, port }, () => {
      server.close((error) =>
        finish(
          error ? { available: false, code: error.code ?? "CLOSE_FAILED" } : { available: true },
        ),
      );
    });
  });
}

export async function inspectPreviewPorts(options = {}) {
  const check = options.checkPort ?? checkPortAvailable;
  const ports = options.ports ?? previewPorts;
  const results = {};
  for (const [name, port] of Object.entries(ports)) {
    results[name] = await check(port, previewHost);
  }
  return results;
}

export function unavailablePreviewPorts(results, ports = previewPorts) {
  return Object.entries(results)
    .filter(([, result]) => !result.available)
    .map(([name, result]) => `${name}:${String(ports[name])}:${result.code ?? "OCCUPIED"}`);
}

export async function waitFor(predicate, options = {}) {
  const deadline = Date.now() + (options.timeoutMilliseconds ?? 30_000);
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, options.intervalMilliseconds ?? 250),
    );
  }
  if (lastError) throw lastError;
  throw new Error(options.timeoutMessage ?? "Timed out waiting for the isolated Preview runtime.");
}

export function openInDefaultBrowser(url, options = {}) {
  const command = systemCommandPromptPath({
    ...options,
    path: options.comspec ?? canonicalCommandPrompt,
  });
  const child = (options.spawn ?? spawn)(command, ["/d", "/s", "/c", "start", "", url], {
    cwd: repositoryRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref?.();
}

export function createRunLogPaths(
  now = new Date(),
  random = randomBytes,
  logDirectory = previewPaths.logDirectory,
) {
  const runId = `${now.toISOString().replace(/[:.]/gu, "-")}-${random(4).toString("hex")}`;
  return Object.freeze({
    supervisor: join(logDirectory, `${runId}-supervisor.log`),
    web: join(logDirectory, `${runId}-web.log`),
    worker: join(logDirectory, `${runId}-worker.log`),
  });
}

export function relativeLogPaths(logs) {
  return Object.freeze({
    supervisor: relativePreviewPath(logs.supervisor),
    web: relativePreviewPath(logs.web),
    worker: relativePreviewPath(logs.worker),
  });
}

export function openAppendOnlyLog(path, options = {}) {
  assertNoReparsePreviewPath(path, options);
  return (options.open ?? openSync)(path, "a", 0o600);
}

export function closeFileDescriptor(descriptor, options = {}) {
  try {
    (options.close ?? closeSync)(descriptor);
  } catch {
    // A transferred descriptor may already have been closed by the child-process implementation.
  }
}
