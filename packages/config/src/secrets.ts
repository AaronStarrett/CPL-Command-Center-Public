import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type OpenAiSecretStatus = "not_configured" | "configured" | "invalid";
export type OpenAiSecretSource = "none" | "environment" | "windows_protected" | "server_runtime";

export interface OpenAiSecretDescriptor {
  readonly status: OpenAiSecretStatus;
  readonly source: OpenAiSecretSource;
  readonly fingerprint: string | null;
  readonly protectedStorageAvailable: boolean;
}

export interface ServerSecretStatus {
  readonly openAiApiKey: OpenAiSecretStatus;
  readonly openAiApiKeySource: OpenAiSecretSource;
  readonly openAiApiKeyFingerprint: string | null;
  readonly windowsProtectedStorageAvailable: boolean;
}

export interface ServerSecrets {
  status(): ServerSecretStatus;
  describeOpenAiApiKey(): OpenAiSecretDescriptor;
  readOpenAiApiKey(): string | undefined;
  storeOpenAiApiKey(value: string): OpenAiSecretDescriptor;
  deleteProtectedOpenAiApiKey(): OpenAiSecretDescriptor;
  redact(text: string): string;
}

export interface WindowsSecretProtector {
  protect(plaintext: string): string;
  unprotect(ciphertext: string): string;
}

export const OWNER_EVALUATION_PROTECTED_SECRET_RELATIVE_PATH = [
  ".data",
  "bea-owner-evaluation",
  "secrets",
  "openai-api-key.dpapi",
] as const;

export interface WindowsProtectedSecretProviderOptions {
  readonly repositoryRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly protector?: WindowsSecretProtector;
  /** Exact user-local Phase 1.3.4 DPAPI vault path for Local Live production. */
  readonly productionVaultPath?: string;
  /** Repository-relative DPAPI file used by Owner Evaluation. */
  readonly protectedSecretRelativePath?: readonly string[];
}

interface ProtectedSecretEnvelope {
  readonly version: 1;
  readonly protection: "windows-dpapi-current-user";
  readonly ciphertext: string;
}

interface ProductionVaultRecord {
  readonly ciphertext: string;
  readonly fingerprint: string;
  readonly updatedAt: string;
}

interface ProductionVaultEnvelope {
  readonly schemaVersion: 1;
  readonly protection: "windows-dpapi-current-user";
  readonly records: Record<string, ProductionVaultRecord>;
}

const PROTECTED_SECRET_RELATIVE_PATH = [".data", "secrets", "openai-api-key.dpapi"] as const;
const MAX_PROTECTED_SECRET_BYTES = 16_384;

export function validOpenAiKey(value: string): boolean {
  return value.length >= 20 && value.length <= 512 && !/\s/u.test(value);
}

function fingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function vaultFingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function contained(root: string, candidate: string): boolean {
  const relationship = relative(root, candidate);
  return (
    relationship === "" ||
    (relationship !== ".." && !relationship.startsWith(`..${sep}`) && !isAbsolute(relationship))
  );
}

function assertProtectedPath(
  repositoryRoot: string,
  candidate: string,
  relativePath: readonly string[] = PROTECTED_SECRET_RELATIVE_PATH,
): void {
  const lexicalRoot = resolve(repositoryRoot);
  const lexicalCandidate = resolve(candidate);
  if (!contained(lexicalRoot, lexicalCandidate)) {
    throw new Error("Protected secret storage path is outside the BEA repository.");
  }
  const canonicalRoot = realpathSync.native(lexicalRoot);
  let existing = lexicalCandidate;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const canonicalExisting = existsSync(existing)
    ? realpathSync.native(existing)
    : resolve(existing);
  if (!contained(canonicalRoot, canonicalExisting)) {
    throw new Error("Protected secret storage path does not remain inside the BEA repository.");
  }
  for (let index = 1; index < relativePath.length; index += 1) {
    const segmentPath = join(lexicalRoot, ...relativePath.slice(0, index));
    if (existsSync(segmentPath) && lstatSync(segmentPath).isSymbolicLink()) {
      throw new Error("Protected secret storage cannot use symbolic links.");
    }
  }
  if (existsSync(lexicalCandidate) && lstatSync(lexicalCandidate).isSymbolicLink()) {
    throw new Error("Protected secret storage cannot use a symbolic link.");
  }
}

const WINDOWS_DPAPI_POWERSHELL_EXECUTABLE =
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

function normalizedWindowsPath(value: string): string {
  return resolve(value).replaceAll("/", "\\").toLowerCase();
}

function pinnedPathChain(targetPath: string): readonly string[] {
  const entries: string[] = [];
  let current = resolve(targetPath);
  while (true) {
    entries.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return entries.reverse();
}

function validatePinnedWindowsDpapiPowershell(): string {
  const executable = resolve(WINDOWS_DPAPI_POWERSHELL_EXECUTABLE);
  for (const entry of pinnedPathChain(executable)) {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(entry);
    } catch {
      throw new Error("Windows protected secret storage is unavailable.");
    }
    if (stat.isSymbolicLink()) {
      throw new Error("Windows protected secret storage is unavailable.");
    }
  }
  let executableStat: ReturnType<typeof lstatSync>;
  try {
    executableStat = lstatSync(executable);
  } catch {
    throw new Error("Windows protected secret storage is unavailable.");
  }
  if (!executableStat.isFile()) {
    throw new Error("Windows protected secret storage is unavailable.");
  }
  let canonicalExecutable: string;
  try {
    canonicalExecutable = realpathSync.native(executable);
  } catch {
    throw new Error("Windows protected secret storage is unavailable.");
  }
  if (
    normalizedWindowsPath(canonicalExecutable) !==
    normalizedWindowsPath(WINDOWS_DPAPI_POWERSHELL_EXECUTABLE)
  ) {
    throw new Error("Windows protected secret storage is unavailable.");
  }
  return executable;
}

const protectScript = String.raw`
$ErrorActionPreference = 'Stop'
$securityAssembly = [Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')
$plain = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
$protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($protected))
`;

const unprotectScript = String.raw`
$ErrorActionPreference = 'Stop'
$securityAssembly = [Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')
$ciphertext = [Console]::In.ReadToEnd()
$protected = [Convert]::FromBase64String($ciphertext)
$bytes = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
`;

export class WindowsDpapiCurrentUserProtector implements WindowsSecretProtector {
  #run(script: string, input: string): string {
    const executable = validatePinnedWindowsDpapiPowershell();
    const environment: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(environment)) {
      if (key.toLowerCase() === "psmodulepath") {
        delete environment[key];
      }
    }
    const result = spawnSync(
      executable,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      {
        encoding: "utf8",
        env: environment,
        input,
        maxBuffer: MAX_PROTECTED_SECRET_BYTES,
        shell: false,
        windowsHide: true,
      },
    );
    if (result.status !== 0 || result.error || typeof result.stdout !== "string") {
      throw new Error("Windows protected secret storage is unavailable.");
    }
    return result.stdout.trim();
  }

  protect(plaintext: string): string {
    const ciphertext = this.#run(protectScript, plaintext);
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(ciphertext)) {
      throw new Error("Windows protected secret storage returned invalid ciphertext.");
    }
    return ciphertext;
  }

  unprotect(ciphertext: string): string {
    return this.#run(unprotectScript, ciphertext);
  }
}

/** Read-only fallback for an ignored environment file or process environment. */
export class EnvironmentSecretProvider {
  readonly #candidate: string | undefined;
  readonly #status: OpenAiSecretStatus;
  readonly #source: OpenAiSecretSource;

  constructor(input: Readonly<Record<string, string | undefined>>) {
    const candidate = input.OPENAI_API_KEY?.trim();
    this.#status = !candidate
      ? "not_configured"
      : validOpenAiKey(candidate)
        ? "configured"
        : "invalid";
    this.#candidate = this.#status === "configured" ? candidate : undefined;
    this.#source =
      this.#status === "not_configured"
        ? "none"
        : input.BEA_DISABLE_ENV_FILE?.trim().toLowerCase() === "true"
          ? "server_runtime"
          : "environment";
  }

  describe(): OpenAiSecretDescriptor {
    return {
      status: this.#status,
      source: this.#source,
      fingerprint: this.#candidate ? fingerprint(this.#candidate) : null,
      protectedStorageAvailable: process.platform === "win32",
    };
  }

  read(): string | undefined {
    return this.#candidate;
  }
}

/** Persistent ciphertext protected to the current Windows account through DPAPI. */
export class WindowsProtectedSecretProvider {
  readonly #repositoryRoot: string;
  readonly #relativePath: readonly string[];
  readonly #path: string;
  readonly #platform: NodeJS.Platform;
  readonly #protector: WindowsSecretProtector;

  constructor(options: WindowsProtectedSecretProviderOptions) {
    this.#repositoryRoot = realpathSync.native(resolve(options.repositoryRoot));
    this.#relativePath = options.protectedSecretRelativePath ?? PROTECTED_SECRET_RELATIVE_PATH;
    this.#path = join(this.#repositoryRoot, ...this.#relativePath);
    this.#platform = options.platform ?? process.platform;
    this.#protector = options.protector ?? new WindowsDpapiCurrentUserProtector();
    assertProtectedPath(this.#repositoryRoot, this.#path, this.#relativePath);
  }

  available(): boolean {
    return this.#platform === "win32";
  }

  exists(): boolean {
    assertProtectedPath(this.#repositoryRoot, this.#path, this.#relativePath);
    return existsSync(this.#path);
  }

  read(): string | undefined {
    if (!this.exists()) return undefined;
    if (!this.available()) throw new Error("Windows protected secret storage is unavailable.");
    assertProtectedPath(this.#repositoryRoot, this.#path, this.#relativePath);
    const bytes = readFileSync(this.#path);
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_PROTECTED_SECRET_BYTES) {
      throw new Error("The protected OpenAI secret is invalid.");
    }
    let envelope: ProtectedSecretEnvelope;
    try {
      envelope = JSON.parse(bytes.toString("utf8")) as ProtectedSecretEnvelope;
    } catch {
      throw new Error("The protected OpenAI secret is invalid.");
    }
    if (
      envelope.version !== 1 ||
      envelope.protection !== "windows-dpapi-current-user" ||
      typeof envelope.ciphertext !== "string" ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(envelope.ciphertext)
    ) {
      throw new Error("The protected OpenAI secret is invalid.");
    }
    const plaintext = this.#protector.unprotect(envelope.ciphertext);
    if (!validOpenAiKey(plaintext)) throw new Error("The protected OpenAI secret is invalid.");
    return plaintext;
  }

  store(value: string): void {
    if (!this.available()) throw new Error("Windows protected secret storage is unavailable.");
    if (!validOpenAiKey(value)) throw new Error("The OpenAI API key format is invalid.");
    assertProtectedPath(this.#repositoryRoot, this.#path, this.#relativePath);
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    assertProtectedPath(this.#repositoryRoot, this.#path, this.#relativePath);
    const envelope: ProtectedSecretEnvelope = {
      version: 1,
      protection: "windows-dpapi-current-user",
      ciphertext: this.#protector.protect(value),
    };
    const temporaryPath = `${this.#path}.${randomUUID()}.tmp`;
    assertProtectedPath(this.#repositoryRoot, temporaryPath);
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(envelope)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temporaryPath, this.#path);
    } finally {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
  }

  delete(): boolean {
    assertProtectedPath(this.#repositoryRoot, this.#path, this.#relativePath);
    if (!existsSync(this.#path)) return false;
    unlinkSync(this.#path);
    return true;
  }
}

const PRODUCTION_VAULT_KEYS = new Set([
  "sessionSecret",
  "databaseUrl",
  "openAiApiKey",
  "httpsPfxPassword",
  "controlToken",
]);

function assertProductionVaultPath(candidate: string): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData || !isAbsolute(candidate)) {
    throw new Error("The Local Live production secret vault path is invalid.");
  }
  const expected = resolve(
    localAppData,
    "BEA",
    "CommandCenter",
    "secrets",
    "production-secrets.dpapi.json",
  );
  const actual = resolve(candidate);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error("The Local Live production secret vault path is invalid.");
  }
  let existing = actual;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  if (existsSync(existing) && lstatSync(existing).isSymbolicLink()) {
    throw new Error("The Local Live production secret vault cannot traverse a symbolic link.");
  }
  return actual;
}

function validateProductionVaultEnvelope(value: unknown): ProductionVaultEnvelope {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as ProductionVaultEnvelope).schemaVersion !== 1 ||
    (value as ProductionVaultEnvelope).protection !== "windows-dpapi-current-user" ||
    typeof (value as ProductionVaultEnvelope).records !== "object" ||
    (value as ProductionVaultEnvelope).records === null ||
    Array.isArray((value as ProductionVaultEnvelope).records)
  ) {
    throw new Error("The Local Live production secret vault is invalid.");
  }
  const envelope = value as ProductionVaultEnvelope;
  for (const [key, record] of Object.entries(envelope.records)) {
    if (
      !PRODUCTION_VAULT_KEYS.has(key) ||
      typeof record !== "object" ||
      record === null ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(record.ciphertext) ||
      !/^sha256:[a-f0-9]{64}$/u.test(record.fingerprint) ||
      Number.isNaN(Date.parse(record.updatedAt))
    ) {
      throw new Error("The Local Live production secret vault is invalid.");
    }
  }
  return envelope;
}

/** OpenAI projection over the user-local Phase 1.3.4 multi-secret DPAPI vault. */
export class WindowsProductionVaultOpenAiProvider {
  readonly #path: string;
  readonly #platform: NodeJS.Platform;
  readonly #protector: WindowsSecretProtector;

  constructor(options: WindowsProtectedSecretProviderOptions) {
    if (!options.productionVaultPath) {
      throw new Error("The Local Live production secret vault path is required.");
    }
    this.#path = assertProductionVaultPath(options.productionVaultPath);
    this.#platform = options.platform ?? process.platform;
    this.#protector = options.protector ?? new WindowsDpapiCurrentUserProtector();
  }

  available(): boolean {
    return this.#platform === "win32";
  }

  #readEnvelope(): ProductionVaultEnvelope {
    if (!existsSync(this.#path)) {
      return {
        schemaVersion: 1,
        protection: "windows-dpapi-current-user",
        records: {},
      };
    }
    if (lstatSync(this.#path).isSymbolicLink()) {
      throw new Error("The Local Live production secret vault cannot be a symbolic link.");
    }
    const bytes = readFileSync(this.#path);
    if (bytes.byteLength < 2 || bytes.byteLength > 1_048_576) {
      throw new Error("The Local Live production secret vault is invalid.");
    }
    try {
      return validateProductionVaultEnvelope(JSON.parse(bytes.toString("utf8")));
    } catch {
      throw new Error("The Local Live production secret vault is invalid.");
    }
  }

  exists(): boolean {
    return this.#readEnvelope().records.openAiApiKey !== undefined;
  }

  read(): string | undefined {
    const record = this.#readEnvelope().records.openAiApiKey;
    if (!record) return undefined;
    if (!this.available()) throw new Error("Windows protected secret storage is unavailable.");
    const plaintext = this.#protector.unprotect(record.ciphertext);
    if (!validOpenAiKey(plaintext) || vaultFingerprint(plaintext) !== record.fingerprint) {
      throw new Error("The protected OpenAI secret is invalid.");
    }
    return plaintext;
  }

  store(value: string): void {
    if (!this.available()) throw new Error("Windows protected secret storage is unavailable.");
    if (!validOpenAiKey(value)) throw new Error("The OpenAI API key format is invalid.");
    const envelope = structuredClone(this.#readEnvelope());
    envelope.records.openAiApiKey = {
      ciphertext: this.#protector.protect(value),
      fingerprint: vaultFingerprint(value),
      updatedAt: new Date().toISOString(),
    };
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.#path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(envelope)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temporaryPath, this.#path);
    } finally {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
  }

  delete(): boolean {
    const envelope = structuredClone(this.#readEnvelope());
    if (!envelope.records.openAiApiKey) return false;
    delete envelope.records.openAiApiKey;
    const temporaryPath = `${this.#path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(envelope)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temporaryPath, this.#path);
    } finally {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
    return true;
  }
}

/** Server-only composite store. A present but invalid protected secret fails closed. */
export class CompositeServerSecrets implements ServerSecrets {
  readonly #environment: EnvironmentSecretProvider;
  readonly #protected: WindowsProtectedSecretProvider | WindowsProductionVaultOpenAiProvider;

  constructor(
    input: Readonly<Record<string, string | undefined>>,
    options: WindowsProtectedSecretProviderOptions,
  ) {
    // Credential precedence is explicit and session-stable:
    // 1. Windows DPAPI ciphertext when the protected file exists (Windows Owner Evaluation / Local Live vault).
    // 2. Process-only server runtime credential (Cursor Cloud OPENAI_API_KEY with BEA_DISABLE_ENV_FILE=true).
    // The selected source does not switch mid-request.
    this.#environment = new EnvironmentSecretProvider(options.productionVaultPath ? {} : input);
    this.#protected = options.productionVaultPath
      ? new WindowsProductionVaultOpenAiProvider(options)
      : new WindowsProtectedSecretProvider(options);
  }

  describeOpenAiApiKey(): OpenAiSecretDescriptor {
    if (this.#protected.exists()) {
      try {
        const key = this.#protected.read();
        return {
          status: key ? "configured" : "invalid",
          source: "windows_protected",
          fingerprint: key ? fingerprint(key) : null,
          protectedStorageAvailable: this.#protected.available(),
        };
      } catch {
        return {
          status: "invalid",
          source: "windows_protected",
          fingerprint: null,
          protectedStorageAvailable: this.#protected.available(),
        };
      }
    }
    const environment = this.#environment.describe();
    return { ...environment, protectedStorageAvailable: this.#protected.available() };
  }

  status(): ServerSecretStatus {
    const descriptor = this.describeOpenAiApiKey();
    return {
      openAiApiKey: descriptor.status,
      openAiApiKeySource: descriptor.source,
      openAiApiKeyFingerprint: descriptor.fingerprint,
      windowsProtectedStorageAvailable: descriptor.protectedStorageAvailable,
    };
  }

  readOpenAiApiKey(): string | undefined {
    if (this.#protected.exists()) return this.#protected.read();
    return this.#environment.read();
  }

  storeOpenAiApiKey(value: string): OpenAiSecretDescriptor {
    const normalized = value.trim();
    if (!validOpenAiKey(normalized)) throw new Error("The OpenAI API key format is invalid.");
    this.#protected.store(normalized);
    return this.describeOpenAiApiKey();
  }

  deleteProtectedOpenAiApiKey(): OpenAiSecretDescriptor {
    this.#protected.delete();
    return this.describeOpenAiApiKey();
  }

  redact(text: string): string {
    const candidates = new Set<string>();
    const environment = this.#environment.read();
    if (environment) candidates.add(environment);
    try {
      const protectedValue = this.#protected.read();
      if (protectedValue) candidates.add(protectedValue);
    } catch {
      // Invalid ciphertext has no known plaintext to redact.
    }
    let redacted = text;
    for (const candidate of candidates) {
      redacted = redacted.replaceAll(candidate, "[REDACTED_OPENAI_API_KEY]");
    }
    return redacted;
  }
}

/** Compatibility wrapper for tests and explicit environment-only deployments. */
export class EnvironmentServerSecrets implements ServerSecrets {
  readonly #provider: EnvironmentSecretProvider;

  constructor(input: Readonly<Record<string, string | undefined>>) {
    this.#provider = new EnvironmentSecretProvider(input);
  }

  describeOpenAiApiKey(): OpenAiSecretDescriptor {
    return this.#provider.describe();
  }

  status(): ServerSecretStatus {
    const descriptor = this.describeOpenAiApiKey();
    return {
      openAiApiKey: descriptor.status,
      openAiApiKeySource: descriptor.source,
      openAiApiKeyFingerprint: descriptor.fingerprint,
      windowsProtectedStorageAvailable: false,
    };
  }

  readOpenAiApiKey(): string | undefined {
    return this.#provider.read();
  }

  storeOpenAiApiKey(): OpenAiSecretDescriptor {
    throw new Error("Windows protected secret storage is unavailable.");
  }

  deleteProtectedOpenAiApiKey(): OpenAiSecretDescriptor {
    return this.describeOpenAiApiKey();
  }

  redact(text: string): string {
    const key = this.#provider.read();
    return key ? text.replaceAll(key, "[REDACTED_OPENAI_API_KEY]") : text;
  }
}

export function parseServerSecrets(
  input: Readonly<Record<string, string | undefined>>,
  options?: WindowsProtectedSecretProviderOptions,
): ServerSecrets {
  return options ? new CompositeServerSecrets(input, options) : new EnvironmentServerSecrets(input);
}
