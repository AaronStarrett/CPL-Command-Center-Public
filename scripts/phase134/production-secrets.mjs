import { spawnSync } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TOOLCHAIN_NODE_VERSION,
  assertPathContained,
  productionPaths,
} from "./production-paths.mjs";
import { inspectAcl } from "./windows-acl.mjs";

export const SECRET_SCHEMA_VERSION = 1;
export const PRODUCTION_SECRET_KEYS = Object.freeze([
  "sessionSecret",
  "databaseUrl",
  "openAiApiKey",
  "httpsPfxPassword",
  "controlToken",
]);

export const WINDOWS_DPAPI_POWERSHELL_EXECUTABLE =
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
export const DPAPI_CURRENT_USER_READINESS_HELPER = fileURLToPath(
  new URL("./dpapi-current-user-readiness.ps1", import.meta.url),
);
export const DPAPI_READINESS_SCHEMA_VERSION = 1;

const sidPattern = /^S-\d-(?:\d+-){1,14}\d+$/u;
const readinessHelperKeys = Object.freeze([
  "schemaVersion",
  "provider",
  "runtimeExecutable",
  "runtimeVersion",
  "currentUserSid",
  "currentTokenElevated",
  "userProfileLoaded",
  "protectSucceeded",
  "unprotectSucceeded",
  "roundTripMatched",
  "probePersisted",
  "probeOutput",
  "failureCategory",
]);
const readinessFailureCategories = new Set([
  "NONE",
  "MALFORMED_HELPER_INPUT",
  "IDENTITY_UNAVAILABLE",
  "IDENTITY_MISMATCH",
  "USER_PROFILE_UNAVAILABLE",
  "ELEVATED_TOKEN_REFUSED",
  "CRYPTOGRAPHY_RUNTIME_UNAVAILABLE",
  "PROTECT_FAILED",
  "UNPROTECT_FAILED",
  "ROUND_TRIP_MISMATCH",
  "HELPER_INTERNAL_FAILURE",
]);
const preIdentityReadinessFailureCategories = new Set([
  "MALFORMED_HELPER_INPUT",
  "IDENTITY_UNAVAILABLE",
  "HELPER_INTERNAL_FAILURE",
]);

const protectScript = String.raw`
$ErrorActionPreference = 'Stop'
$securityAssembly = [Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')
$plain = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
$cipher = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($cipher))
`;

const unprotectScript = String.raw`
$ErrorActionPreference = 'Stop'
$securityAssembly = [Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')
$encoded = [Console]::In.ReadToEnd()
$cipher = [Convert]::FromBase64String($encoded)
$bytes = [Security.Cryptography.ProtectedData]::Unprotect($cipher, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
`;

function runPowerShell(script, input, options = {}) {
  let executable;
  try {
    executable = validatePinnedWindowsDpapiPowershell(options);
  } catch {
    throw new Error("Windows protected secret storage is unavailable.");
  }
  const result = spawnSync(
    executable,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      encoding: "utf8",
      env: windowsPowerShellEnvironment(options.environment ?? process.env),
      input,
      maxBuffer: 65_536,
      shell: false,
      windowsHide: true,
    },
  );
  if (result.status !== 0 || result.error || typeof result.stdout !== "string") {
    throw new Error("Windows protected secret storage is unavailable.");
  }
  return result.stdout.trim();
}

function windowsPowerShellEnvironment(environment = process.env) {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => key.toLowerCase() !== "psmodulepath"),
  );
}

function runReadinessHelper(executable, arguments_, options = {}) {
  const result = spawnSync(executable, arguments_, {
    encoding: "utf8",
    env: windowsPowerShellEnvironment(options.environment ?? process.env),
    input: options.input,
    maxBuffer: 65_536,
    shell: false,
    windowsHide: true,
  });
  return {
    exitCode: Number.isInteger(result.status) ? result.status : 1,
    stdout: typeof result.stdout === "string" ? result.stdout.trim() : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    error: result.error,
  };
}

function normalizedPath(value) {
  return resolve(value).replaceAll("/", "\\").toLowerCase();
}

function pinnedPathChain(targetPath) {
  const entries = [];
  let current = resolve(targetPath);
  while (true) {
    entries.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return entries.reverse();
}

function validatePinnedWindowsDpapiPowershell(options = {}) {
  const executable = resolve(options.powershellExecutable ?? WINDOWS_DPAPI_POWERSHELL_EXECUTABLE);
  if (normalizedPath(executable) !== normalizedPath(WINDOWS_DPAPI_POWERSHELL_EXECUTABLE)) {
    throw new Error("The pinned system Windows PowerShell executable was refused.");
  }
  const lstat = options.powershellLstat ?? lstatSync;
  for (const entry of pinnedPathChain(executable)) {
    let stat;
    try {
      stat = lstat(entry);
    } catch {
      throw new Error("The pinned system Windows PowerShell executable is missing.");
    }
    if (stat.isSymbolicLink()) {
      throw new Error("The pinned system Windows PowerShell path contains a reparse point.");
    }
  }
  let executableStat;
  try {
    executableStat = lstat(executable);
  } catch {
    throw new Error("The pinned system Windows PowerShell executable is missing.");
  }
  if (!executableStat.isFile()) {
    throw new Error("The pinned system Windows PowerShell executable is not a regular file.");
  }
  const realpath = options.powershellRealpath ?? realpathSync.native;
  if (
    normalizedPath(realpath(executable)) !== normalizedPath(WINDOWS_DPAPI_POWERSHELL_EXECUTABLE)
  ) {
    throw new Error("The pinned system Windows PowerShell executable resolves unexpectedly.");
  }
  return executable;
}

function readinessEvidence(values = {}) {
  return Object.freeze({
    Ready: values.ready === true,
    SecretProvider: "windows-dpapi-current-user",
    IntendedUserSid: values.intendedUserSid ?? "UNKNOWN",
    CurrentUserSid: values.currentUserSid ?? "UNKNOWN",
    CurrentTokenElevated:
      typeof values.currentTokenElevated === "boolean" ? values.currentTokenElevated : null,
    UserProfileLoaded: values.userProfileLoaded === true,
    ProductRoot: values.productRoot ?? "UNKNOWN",
    SecretsDirectory: values.secretsDirectory ?? "UNKNOWN",
    SecretsDirectoryExists: values.secretsDirectoryExists === true,
    SecretsDirectoryAclReady: values.secretsDirectoryAclReady === true,
    DpapiHelperPath: values.helperPath ?? DPAPI_CURRENT_USER_READINESS_HELPER,
    DpapiHelperExecutable: values.helperExecutable ?? WINDOWS_DPAPI_POWERSHELL_EXECUTABLE,
    DpapiHelperRuntime: values.helperRuntime ?? "WINDOWS_POWERSHELL_DOTNET_DPAPI_CURRENT_USER",
    DpapiHelperRuntimeVersion: values.helperRuntimeVersion ?? "UNKNOWN",
    DpapiHelperExitCode: Number.isInteger(values.helperExitCode) ? values.helperExitCode : null,
    DpapiFailureCategory: values.failureCategory ?? "READINESS_NOT_RUN",
    DpapiProtectSucceeded: values.protectSucceeded === true,
    DpapiUnprotectSucceeded: values.unprotectSucceeded === true,
    DpapiRoundTripMatched: values.roundTripMatched === true,
    DpapiProbePersisted: false,
    DpapiProbeOutput: false,
    FailureBeforeSecretWrite: values.ready !== true,
    ProductionSecretGenerated: false,
    CanonicalNodeExecutable: values.canonicalNodeExecutable ?? "UNKNOWN",
    CanonicalNodeVersion: values.canonicalNodeVersion ?? "UNKNOWN",
    CanonicalNodeReady: values.canonicalNodeReady === true,
  });
}

function helperEvidenceShape(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== readinessHelperKeys.length ||
    !readinessHelperKeys.every((key) => keys.includes(key))
  ) {
    return false;
  }
  const identityEstablished =
    sidPattern.test(value.currentUserSid) && typeof value.currentTokenElevated === "boolean";
  const legitimatePreIdentityFailure =
    value.currentUserSid === "UNKNOWN" &&
    value.currentTokenElevated === null &&
    preIdentityReadinessFailureCategories.has(value.failureCategory);
  return (
    value.schemaVersion === DPAPI_READINESS_SCHEMA_VERSION &&
    value.provider === "windows-dpapi-current-user" &&
    typeof value.runtimeExecutable === "string" &&
    isAbsolute(value.runtimeExecutable) &&
    typeof value.runtimeVersion === "string" &&
    /^5\.1\.\d+(?:\.\d+)?$/u.test(value.runtimeVersion) &&
    (identityEstablished || legitimatePreIdentityFailure) &&
    typeof value.userProfileLoaded === "boolean" &&
    typeof value.protectSucceeded === "boolean" &&
    typeof value.unprotectSucceeded === "boolean" &&
    typeof value.roundTripMatched === "boolean" &&
    value.probePersisted === false &&
    value.probeOutput === false &&
    readinessFailureCategories.has(value.failureCategory)
  );
}

function parseReadinessHelperEvidence(stdout) {
  if (typeof stdout !== "string" || stdout.length < 2 || stdout.length > 16_384) return undefined;
  try {
    const value = JSON.parse(stdout);
    return helperEvidenceShape(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function injectedProtectorEvidence(protector, intendedUserSid) {
  let probe;
  let plaintext;
  let roundTrip;
  let leftDigest;
  let rightDigest;
  let protectSucceeded = false;
  let unprotectSucceeded = false;
  try {
    probe = randomBytes(32);
    plaintext = Buffer.from(probe.toString("base64"), "utf8");
    let ciphertext;
    try {
      ciphertext = protector.protect(plaintext.toString("utf8"));
      protectSucceeded = true;
    } catch {
      return {
        currentUserSid: intendedUserSid,
        currentTokenElevated: false,
        userProfileLoaded: true,
        protectSucceeded: false,
        unprotectSucceeded: false,
        roundTripMatched: false,
        failureCategory: "PROTECT_FAILED",
        exitCode: 13,
      };
    }
    try {
      roundTrip = Buffer.from(protector.unprotect(ciphertext), "utf8");
      unprotectSucceeded = true;
    } catch {
      return {
        currentUserSid: intendedUserSid,
        currentTokenElevated: false,
        userProfileLoaded: true,
        protectSucceeded,
        unprotectSucceeded: false,
        roundTripMatched: false,
        failureCategory: "UNPROTECT_FAILED",
        exitCode: 14,
      };
    }
    leftDigest = createHash("sha256").update(plaintext).digest();
    rightDigest = createHash("sha256").update(roundTrip).digest();
    const roundTripMatched =
      plaintext.byteLength === roundTrip.byteLength && timingSafeEqual(leftDigest, rightDigest);
    return {
      currentUserSid: intendedUserSid,
      currentTokenElevated: false,
      userProfileLoaded: true,
      protectSucceeded,
      unprotectSucceeded,
      roundTripMatched,
      failureCategory: roundTripMatched ? "NONE" : "ROUND_TRIP_MISMATCH",
      exitCode: roundTripMatched ? 0 : 15,
    };
  } finally {
    for (const buffer of [probe, plaintext, roundTrip, leftDigest, rightDigest]) {
      buffer?.fill(0);
    }
  }
}

export function inspectProtectedSecretReadiness(options = {}) {
  const paths = options.paths ?? productionPaths;
  const intendedUserSid = options.intendedUserSid;
  const productRoot = resolve(paths.productRoot);
  const secretsDirectory = resolve(paths.secretDirectory);
  const helperPath = resolve(options.helperPath ?? DPAPI_CURRENT_USER_READINESS_HELPER);
  const canonicalNodeExecutable = resolve(paths.nodeExecutable);
  const currentNodeExecutable = resolve(options.currentNodeExecutable ?? process.execPath);
  const currentNodeVersion = String(options.currentNodeVersion ?? process.version).replace(
    /^v/u,
    "",
  );
  const toolchain = options.toolchain;
  const injectedToolchainReady =
    options.trustInjectedToolchain === true &&
    toolchain?.ok === true &&
    toolchain?.nodeVersion === TOOLCHAIN_NODE_VERSION;
  const structuredToolchainReady =
    toolchain === undefined ||
    (toolchain.ok === true &&
      toolchain.nodeReady === true &&
      normalizedPath(toolchain.nodePath) === normalizedPath(canonicalNodeExecutable) &&
      toolchain.nodeVersion === TOOLCHAIN_NODE_VERSION);
  const canonicalNodeReady =
    currentNodeVersion === TOOLCHAIN_NODE_VERSION &&
    (normalizedPath(currentNodeExecutable) === normalizedPath(canonicalNodeExecutable) ||
      injectedToolchainReady) &&
    (structuredToolchainReady || injectedToolchainReady);
  const base = {
    intendedUserSid,
    productRoot,
    secretsDirectory,
    helperPath,
    canonicalNodeExecutable,
    canonicalNodeVersion: TOOLCHAIN_NODE_VERSION,
    canonicalNodeReady,
  };

  if ((options.platform ?? process.platform) !== "win32") {
    return readinessEvidence({ ...base, failureCategory: "UNSUPPORTED_PLATFORM" });
  }
  if (!sidPattern.test(intendedUserSid ?? "")) {
    return readinessEvidence({ ...base, failureCategory: "INTENDED_IDENTITY_INVALID" });
  }
  if (!canonicalNodeReady) {
    return readinessEvidence({ ...base, failureCategory: "CANONICAL_NODE_REQUIRED" });
  }
  try {
    assertPathContained(productRoot, secretsDirectory, "Production secrets directory");
  } catch {
    return readinessEvidence({ ...base, failureCategory: "SECRETS_DIRECTORY_OUTSIDE_ROOT" });
  }

  const trustInjectedAcl = options.trustInjectedAcl === true;
  const exists = options.exists ?? existsSync;
  const secretsDirectoryExists = trustInjectedAcl || exists(secretsDirectory);
  if (!secretsDirectoryExists) {
    return readinessEvidence({
      ...base,
      secretsDirectoryExists: false,
      failureCategory: "SECRETS_DIRECTORY_MISSING",
    });
  }
  let secretsDirectoryAclReady = false;
  try {
    const acl = trustInjectedAcl
      ? { exactProtected: true }
      : (options.inspectAcl ?? inspectAcl)(secretsDirectory, {
          ...options,
          allowedRoot: productRoot,
          currentUserSid: intendedUserSid,
          directory: true,
          allowInherited: false,
        });
    secretsDirectoryAclReady = acl?.exactProtected === true;
  } catch {
    secretsDirectoryAclReady = false;
  }
  if (!secretsDirectoryAclReady) {
    return readinessEvidence({
      ...base,
      secretsDirectoryExists,
      secretsDirectoryAclReady: false,
      failureCategory: "SECRETS_DIRECTORY_ACL_NOT_READY",
    });
  }

  let powershellExecutable;
  try {
    powershellExecutable = validatePinnedWindowsDpapiPowershell(options);
  } catch {
    return readinessEvidence({
      ...base,
      secretsDirectoryExists,
      secretsDirectoryAclReady,
      failureCategory: "HELPER_RUNTIME_REFUSED",
    });
  }
  if (!isAbsolute(helperPath) || !isAbsolute(powershellExecutable)) {
    return readinessEvidence({
      ...base,
      secretsDirectoryExists,
      secretsDirectoryAclReady,
      helperExecutable: powershellExecutable,
      failureCategory: "HELPER_RUNTIME_REFUSED",
    });
  }
  const helperExists = options.helperExists ?? existsSync;
  let helperAvailable = false;
  try {
    helperAvailable = helperExists(helperPath);
  } catch {
    helperAvailable = false;
  }
  if (!helperAvailable) {
    return readinessEvidence({
      ...base,
      secretsDirectoryExists,
      secretsDirectoryAclReady,
      failureCategory: "DPAPI_HELPER_UNAVAILABLE",
    });
  }

  if (options.useInjectedProtector === true && options.protector) {
    const output = injectedProtectorEvidence(options.protector, intendedUserSid);
    return readinessEvidence({
      ...base,
      secretsDirectoryExists,
      secretsDirectoryAclReady,
      helperRuntime: "INJECTED_TEST_PROTECTOR",
      helperExecutable: powershellExecutable,
      helperRuntimeVersion: "INJECTED",
      helperExitCode: output.exitCode,
      failureCategory: output.failureCategory,
      currentUserSid: output.currentUserSid,
      currentTokenElevated: output.currentTokenElevated,
      userProfileLoaded: output.userProfileLoaded,
      protectSucceeded: output.protectSucceeded,
      unprotectSucceeded: output.unprotectSucceeded,
      roundTripMatched: output.roundTripMatched,
      ready: output.failureCategory === "NONE",
    });
  }

  let result;
  try {
    result = (options.runReadinessHelper ?? runReadinessHelper)(
      powershellExecutable,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helperPath],
      {
        environment: options.environment,
        input: JSON.stringify({
          schemaVersion: DPAPI_READINESS_SCHEMA_VERSION,
          intendedUserSid,
        }),
      },
    );
  } catch {
    return readinessEvidence({
      ...base,
      secretsDirectoryExists,
      secretsDirectoryAclReady,
      helperExecutable: powershellExecutable,
      helperExitCode: 1,
      failureCategory: "DPAPI_HELPER_UNAVAILABLE",
    });
  }
  const exitCode = Number.isInteger(result?.exitCode) ? result.exitCode : 1;
  const withDirectory = {
    ...base,
    secretsDirectoryExists,
    secretsDirectoryAclReady,
    helperExecutable: powershellExecutable,
    helperExitCode: exitCode,
  };
  if (result?.error) {
    return readinessEvidence({ ...withDirectory, failureCategory: "DPAPI_HELPER_UNAVAILABLE" });
  }
  const helperEvidence = parseReadinessHelperEvidence(result?.stdout);
  if (!helperEvidence) {
    return readinessEvidence({
      ...withDirectory,
      failureCategory: exitCode === 0 ? "MALFORMED_HELPER_EVIDENCE" : "HELPER_NONZERO_EXIT",
    });
  }
  if (normalizedPath(helperEvidence.runtimeExecutable) !== normalizedPath(powershellExecutable)) {
    return readinessEvidence({
      ...withDirectory,
      currentUserSid: helperEvidence.currentUserSid,
      currentTokenElevated: helperEvidence.currentTokenElevated,
      userProfileLoaded: helperEvidence.userProfileLoaded,
      protectSucceeded: helperEvidence.protectSucceeded,
      unprotectSucceeded: helperEvidence.unprotectSucceeded,
      roundTripMatched: helperEvidence.roundTripMatched,
      helperRuntimeVersion: helperEvidence.runtimeVersion,
      failureCategory: "HELPER_RUNTIME_REFUSED",
    });
  }
  if (helperEvidence.currentUserSid === "UNKNOWN") {
    return readinessEvidence({
      ...withDirectory,
      currentUserSid: helperEvidence.currentUserSid,
      currentTokenElevated: helperEvidence.currentTokenElevated,
      helperRuntimeVersion: helperEvidence.runtimeVersion,
      userProfileLoaded: helperEvidence.userProfileLoaded,
      protectSucceeded: helperEvidence.protectSucceeded,
      unprotectSucceeded: helperEvidence.unprotectSucceeded,
      roundTripMatched: helperEvidence.roundTripMatched,
      failureCategory:
        exitCode === 0 ? "MALFORMED_HELPER_EVIDENCE" : helperEvidence.failureCategory,
    });
  }
  if (helperEvidence.currentUserSid !== intendedUserSid) {
    return readinessEvidence({
      ...withDirectory,
      currentUserSid: helperEvidence.currentUserSid,
      currentTokenElevated: helperEvidence.currentTokenElevated,
      userProfileLoaded: helperEvidence.userProfileLoaded,
      protectSucceeded: helperEvidence.protectSucceeded,
      unprotectSucceeded: helperEvidence.unprotectSucceeded,
      roundTripMatched: helperEvidence.roundTripMatched,
      failureCategory: "IDENTITY_MISMATCH",
    });
  }
  const success =
    exitCode === 0 &&
    helperEvidence.failureCategory === "NONE" &&
    helperEvidence.currentTokenElevated === false &&
    helperEvidence.userProfileLoaded &&
    helperEvidence.protectSucceeded &&
    helperEvidence.unprotectSucceeded &&
    helperEvidence.roundTripMatched;
  const failureCategory = success
    ? "NONE"
    : exitCode === 0
      ? "MALFORMED_HELPER_EVIDENCE"
      : helperEvidence.failureCategory === "NONE"
        ? "HELPER_NONZERO_EXIT"
        : helperEvidence.failureCategory;
  return readinessEvidence({
    ...withDirectory,
    currentUserSid: helperEvidence.currentUserSid,
    currentTokenElevated: helperEvidence.currentTokenElevated,
    helperRuntimeVersion: helperEvidence.runtimeVersion,
    userProfileLoaded: helperEvidence.userProfileLoaded,
    protectSucceeded: helperEvidence.protectSucceeded,
    unprotectSucceeded: helperEvidence.unprotectSucceeded,
    roundTripMatched: helperEvidence.roundTripMatched,
    failureCategory,
    ready: success,
  });
}

export function assertProtectedSecretReadiness(options = {}) {
  const evidence = inspectProtectedSecretReadiness(options);
  if (evidence.Ready) return evidence;
  const error = new Error(
    `Windows protected secret storage readiness failed closed: ${evidence.DpapiFailureCategory}.`,
  );
  error.code = "BEA_PROTECTED_SECRET_READINESS_FAILED";
  error.evidence = evidence;
  throw error;
}

export class WindowsDpapiCurrentUserProtector {
  constructor(options = {}) {
    this.platform = options.platform ?? process.platform;
    this.powershellExecutable = options.powershellExecutable;
    this.runner = options.runner ?? runPowerShell;
  }

  available() {
    return this.platform === "win32";
  }

  probe() {
    if (!this.available()) return false;
    const value = randomBytes(32).toString("hex");
    try {
      return this.unprotect(this.protect(value)) === value;
    } catch {
      return false;
    }
  }

  protect(value) {
    if (!this.available()) throw new Error("Windows protected secret storage is unavailable.");
    const ciphertext = this.runner(protectScript, value, {
      powershellExecutable: this.powershellExecutable,
    });
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(ciphertext)) {
      throw new Error("Windows protected secret storage returned invalid ciphertext.");
    }
    return ciphertext;
  }

  unprotect(ciphertext) {
    if (!this.available()) throw new Error("Windows protected secret storage is unavailable.");
    return this.runner(unprotectScript, ciphertext, {
      powershellExecutable: this.powershellExecutable,
    });
  }
}

function fingerprint(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function validSecret(key, value) {
  if (typeof value !== "string" || value.includes("\0") || value.length > 8_192) return false;
  if (key === "sessionSecret") return value.length >= 64;
  if (key === "databaseUrl") return /^postgres(?:ql)?:\/\/[^\s]+$/u.test(value);
  if (key === "openAiApiKey") return value.length >= 20 && !/\s/u.test(value);
  if (key === "httpsPfxPassword") return value.length >= 32;
  if (key === "controlToken") return /^[a-f0-9]{64}$/u.test(value);
  return false;
}

function emptyEnvelope() {
  return {
    schemaVersion: SECRET_SCHEMA_VERSION,
    protection: "windows-dpapi-current-user",
    records: {},
  };
}

function validateEnvelope(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    value.schemaVersion !== SECRET_SCHEMA_VERSION ||
    value.protection !== "windows-dpapi-current-user" ||
    typeof value.records !== "object" ||
    value.records === null ||
    Array.isArray(value.records)
  ) {
    throw new Error("The protected production secret vault is invalid.");
  }
  const unknown = Object.keys(value.records).filter((key) => !PRODUCTION_SECRET_KEYS.includes(key));
  if (unknown.length > 0) throw new Error("The protected production secret vault is invalid.");
  for (const record of Object.values(value.records)) {
    if (
      typeof record !== "object" ||
      record === null ||
      typeof record.ciphertext !== "string" ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(record.ciphertext) ||
      typeof record.fingerprint !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(record.fingerprint) ||
      typeof record.updatedAt !== "string" ||
      Number.isNaN(Date.parse(record.updatedAt))
    ) {
      throw new Error("The protected production secret vault is invalid.");
    }
  }
  return value;
}

function readEnvelope(filePath) {
  if (!existsSync(filePath)) return emptyEnvelope();
  if (lstatSync(filePath).isSymbolicLink()) {
    throw new Error("The production secret vault cannot be a symbolic link.");
  }
  const bytes = readFileSync(filePath);
  if (bytes.byteLength < 2 || bytes.byteLength > 1_048_576) {
    throw new Error("The protected production secret vault is invalid.");
  }
  try {
    return validateEnvelope(JSON.parse(bytes.toString("utf8")));
  } catch {
    throw new Error("The protected production secret vault is invalid.");
  }
}

function writeEnvelopeAtomic(envelope, options) {
  const filePath = resolve(options.filePath);
  assertPathContained(options.allowedRoot, filePath, "Production secret vault path");
  const parentDirectory = dirname(filePath);
  if (!existsSync(parentDirectory) || !lstatSync(parentDirectory).isDirectory()) {
    throw new Error("The protected production secret directory is not ready.");
  }
  if (lstatSync(parentDirectory).isSymbolicLink()) {
    throw new Error("The protected production secret directory cannot be a symbolic link.");
  }
  if (existsSync(filePath) && lstatSync(filePath).isSymbolicLink()) {
    throw new Error("The production secret vault cannot be a symbolic link.");
  }
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, filePath);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
  }
}

function resolvedOptions(options = {}) {
  return {
    ...options,
    filePath: resolve(options.filePath ?? productionPaths.secretFile),
    allowedRoot: resolve(options.allowedRoot ?? productionPaths.secretDirectory),
    protector: options.protector ?? new WindowsDpapiCurrentUserProtector(options),
  };
}

export function readSecretStatus(options = {}) {
  const resolved = resolvedOptions(options);
  assertPathContained(resolved.allowedRoot, resolved.filePath, "Production secret vault path");
  const envelope = readEnvelope(resolved.filePath);
  const suppliedReadiness = options.readinessEvidence;
  const available =
    suppliedReadiness?.Ready === true &&
    suppliedReadiness.SecretProvider === "windows-dpapi-current-user"
      ? true
      : options.probe === false
        ? false
        : resolved.protector.available() === true &&
          (typeof resolved.protector.probe !== "function" || resolved.protector.probe() === true);
  const records = {};
  for (const key of PRODUCTION_SECRET_KEYS) {
    const entry = envelope.records[key];
    let configured = false;
    if (entry !== undefined && available) {
      const plaintext = resolved.protector.unprotect(entry.ciphertext);
      if (!validSecret(key, plaintext) || fingerprint(plaintext) !== entry.fingerprint) {
        throw new Error("A protected production secret failed validation.");
      }
      configured = true;
    }
    records[key] = Object.freeze({
      present: entry !== undefined,
      configured,
      fingerprint: entry?.fingerprint ?? null,
      updatedAt: entry?.updatedAt ?? null,
    });
  }
  return Object.freeze({
    available,
    schemaVersion: envelope.schemaVersion,
    protection: envelope.protection,
    records: Object.freeze(records),
  });
}

export function readProductionSecrets(keysOrOptions = PRODUCTION_SECRET_KEYS, maybeOptions = {}) {
  const keys = Array.isArray(keysOrOptions) ? keysOrOptions : PRODUCTION_SECRET_KEYS;
  const options = Array.isArray(keysOrOptions) ? maybeOptions : keysOrOptions;
  const resolved = resolvedOptions(options);
  assertPathContained(resolved.allowedRoot, resolved.filePath, "Production secret vault path");
  const envelope = readEnvelope(resolved.filePath);
  const output = {};
  for (const key of keys) {
    if (!PRODUCTION_SECRET_KEYS.includes(key)) throw new Error("Unknown production secret key.");
    const entry = envelope.records[key];
    if (entry === undefined) continue;
    const plaintext = resolved.protector.unprotect(entry.ciphertext);
    if (!validSecret(key, plaintext) || fingerprint(plaintext) !== entry.fingerprint) {
      throw new Error("A protected production secret failed validation.");
    }
    output[key] = plaintext;
  }
  return Object.freeze(output);
}

export async function storeProductionSecrets(values, options = {}) {
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    throw new Error("Production secrets must be supplied as an object.");
  }
  const entries = Object.entries(values);
  if (entries.length === 0) throw new Error("At least one production secret is required.");
  for (const [key, value] of entries) {
    if (!PRODUCTION_SECRET_KEYS.includes(key) || !validSecret(key, value)) {
      throw new Error("A production secret failed validation.");
    }
  }
  if (typeof options.confirm !== "function") {
    throw new Error("Explicit Owner confirmation is required before storing production secrets.");
  }
  const confirmed = await options.confirm({
    action: "store-production-secrets",
    keys: entries.map(([key]) => key),
  });
  if (confirmed !== true) throw new Error("Owner declined production secret storage.");

  const resolved = resolvedOptions(options);
  if (!resolved.protector.available()) {
    throw new Error("Windows protected secret storage is unavailable.");
  }
  const envelope = readEnvelope(resolved.filePath);
  const next = structuredClone(envelope);
  const now = (options.now ?? (() => new Date()))().toISOString();
  for (const [key, value] of entries) {
    next.records[key] = {
      ciphertext: resolved.protector.protect(value),
      fingerprint: fingerprint(value),
      updatedAt: now,
    };
  }
  writeEnvelopeAtomic(validateEnvelope(next), resolved);
  await options.applyAcl?.(resolved.filePath);
  return readSecretStatus(resolved);
}

export async function deleteProductionSecrets(keys, options = {}) {
  if (
    !Array.isArray(keys) ||
    keys.length === 0 ||
    keys.some((key) => !PRODUCTION_SECRET_KEYS.includes(key))
  ) {
    throw new Error("Valid production secret keys are required.");
  }
  if (
    typeof options.confirm !== "function" ||
    (await options.confirm({
      action: "delete-production-secrets",
      keys: [...keys],
    })) !== true
  ) {
    throw new Error("Explicit Owner confirmation is required before deleting production secrets.");
  }
  const resolved = resolvedOptions(options);
  const envelope = structuredClone(readEnvelope(resolved.filePath));
  for (const key of keys) delete envelope.records[key];
  writeEnvelopeAtomic(validateEnvelope(envelope), resolved);
  await options.applyAcl?.(resolved.filePath);
  return readSecretStatus(resolved);
}

export function generateSessionSecret() {
  return randomBytes(64).toString("base64url");
}

export function generateControlToken() {
  return randomBytes(32).toString("hex");
}

export function generatePfxPassword() {
  return randomBytes(48).toString("base64url");
}
