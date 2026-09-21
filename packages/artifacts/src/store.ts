import { createHash, randomBytes } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  ArtifactStoreError,
  ArtifactValidationError,
  type ArtifactCleanupResult,
  type ArtifactMaintenanceResult,
  type ArtifactOrphanCleanupResult,
  type ArtifactUploadInput,
  type MalwareScanResult,
  type NormalizedArtifactUpload,
  type StoredArtifactContent,
  type StoredArtifactFile,
  type ValidatedArtifactUpload,
} from "./contracts.js";
import { validateArtifactUpload, validateGeneratedArtifactFile } from "./uploads.js";

const defaultRetentionMilliseconds = 7 * 24 * 60 * 60 * 1_000;
const maximumRetentionMilliseconds = 90 * 24 * 60 * 60 * 1_000;
const ownerIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const artifactIdPattern = /^art_[a-f0-9]{32}$/u;
const artifactBlobNamePattern = /^(art_[a-f0-9]{32})\.bin$/u;
const artifactManifestNamePattern = /^(art_[a-f0-9]{32})\.json$/u;
const artifactTemporaryNamePattern = /^(art_[a-f0-9]{32})\.(?:bin|json)\.\d+-[a-f0-9]{12}\.tmp$/u;
const defaultOrphanGraceMilliseconds = 5 * 60 * 1_000;
const maximumOrphanGraceMilliseconds = 24 * 60 * 60 * 1_000;
const mutationLockRetryAttempts = 500;
const mutationLockRetryMilliseconds = 10;

interface InternalStoredArtifactFile extends StoredArtifactFile {
  readonly ownerId: string;
  readonly referenceCount: number;
  readonly version: 2;
}

interface LegacyInternalStoredArtifactFile extends StoredArtifactFile {
  readonly ownerId: string;
  readonly version: 1;
}

interface StoredArtifactMetadataCandidate extends Partial<StoredArtifactFile> {
  readonly ownerId?: string;
  readonly referenceCount?: number;
  readonly version?: 1 | 2;
}

export interface ArtifactFileOperations {
  mkdir(path: string): Promise<void>;
  mkdirExclusive(path: string): Promise<boolean>;
  readFile(path: string): Promise<Uint8Array>;
  readdir(path: string): Promise<readonly string[]>;
  rename(from: string, to: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  stat(path: string): Promise<{ readonly mtimeMs: number }>;
  unlink(path: string): Promise<void>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
}

const nodeFileOperations: ArtifactFileOperations = {
  async mkdir(path) {
    await mkdir(path, { recursive: true });
  },
  async mkdirExclusive(path) {
    try {
      await mkdir(path);
      return true;
    } catch (error) {
      if (isFileSystemError(error, "EEXIST")) return false;
      throw error;
    }
  },
  async readFile(path) {
    return readFile(path);
  },
  async readdir(path) {
    return readdir(path);
  },
  async rename(from, to) {
    await rename(from, to);
  },
  async rmdir(path) {
    await rmdir(path);
  },
  async stat(path) {
    const value = await stat(path);
    return { mtimeMs: value.mtimeMs };
  },
  async unlink(path) {
    await unlink(path);
  },
  async writeFile(path, data) {
    if (typeof data === "string") {
      await writeFile(path, data, "utf8");
    } else {
      await writeFile(path, data);
    }
  },
};

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function canonicalizeExistingAncestor(path: string): string {
  let cursor = resolve(path);
  const missingSegments: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync.native(cursor), ...missingSegments.reverse());
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) {
        throw new ArtifactValidationError(
          "INVALID_STORE_ROOT",
          "Artifact storage could not be resolved safely.",
        );
      }
      try {
        lstatSync(cursor);
      } catch (lstatError) {
        if (!isFileSystemError(lstatError, "ENOENT")) {
          throw new ArtifactValidationError(
            "INVALID_STORE_ROOT",
            "Artifact storage could not be resolved safely.",
          );
        }
        const parent = dirname(cursor);
        if (parent === cursor) {
          throw new ArtifactValidationError(
            "INVALID_STORE_ROOT",
            "Artifact storage could not be resolved safely.",
          );
        }
        missingSegments.push(basename(cursor));
        cursor = parent;
        continue;
      }
      throw new ArtifactValidationError(
        "INVALID_STORE_ROOT",
        "Artifact storage cannot use a dangling symbolic link or reparse point.",
      );
    }
  }
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  return normalize(left) === normalize(right);
}

function isWithin(candidate: string, parent: string): boolean {
  const candidatePath = resolve(candidate);
  const parentPath = resolve(parent);
  const child = relative(parentPath, candidatePath);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function safeOwnerId(value: string): string {
  const ownerId = value.trim().toLowerCase();
  if (!ownerIdPattern.test(ownerId)) {
    throw new ArtifactValidationError("INVALID_OWNER", "Artifact owner identity is invalid.");
  }
  return ownerId;
}

function safeArtifactId(value: string): string {
  if (!artifactIdPattern.test(value)) {
    throw new ArtifactStoreError("ARTIFACT_NOT_FOUND", "Artifact was not found.");
  }
  return value;
}

function validateMaintenanceDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new ArtifactValidationError(
      "INVALID_RETENTION",
      "Artifact maintenance time is invalid; no cleanup was performed.",
    );
  }
  return value;
}

function publicMetadata(value: InternalStoredArtifactFile): StoredArtifactFile {
  return {
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    filename: value.filename,
    id: value.id,
    ...(value.malwareScan === undefined ? {} : { malwareScan: value.malwareScan }),
    mimeType: value.mimeType,
    sha256: value.sha256,
    size: value.size,
  };
}

function parseMetadata(bytes: Uint8Array): InternalStoredArtifactFile {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ArtifactStoreError("ARTIFACT_STORE_FAILURE", "Artifact metadata is invalid.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ArtifactStoreError("ARTIFACT_STORE_FAILURE", "Artifact metadata is invalid.");
  }
  const metadata = value as StoredArtifactMetadataCandidate;
  if (
    !(metadata.version === 1 || metadata.version === 2) ||
    typeof metadata.id !== "string" ||
    !artifactIdPattern.test(metadata.id) ||
    typeof metadata.ownerId !== "string" ||
    !ownerIdPattern.test(metadata.ownerId) ||
    typeof metadata.filename !== "string" ||
    typeof metadata.mimeType !== "string" ||
    typeof metadata.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(metadata.sha256) ||
    !Number.isSafeInteger(metadata.size) ||
    Number(metadata.size) < 1 ||
    typeof metadata.createdAt !== "string" ||
    typeof metadata.expiresAt !== "string" ||
    !Number.isFinite(new Date(metadata.createdAt).getTime()) ||
    !Number.isFinite(new Date(metadata.expiresAt).getTime())
  ) {
    throw new ArtifactStoreError("ARTIFACT_STORE_FAILURE", "Artifact metadata is invalid.");
  }
  if (
    metadata.version === 2 &&
    (!Number.isSafeInteger(metadata.referenceCount) || Number(metadata.referenceCount) < 1)
  ) {
    throw new ArtifactStoreError("ARTIFACT_STORE_FAILURE", "Artifact metadata is invalid.");
  }
  return {
    ...(metadata as LegacyInternalStoredArtifactFile),
    referenceCount: metadata.version === 2 ? Number(metadata.referenceCount) : 1,
    version: 2,
  };
}

function parseMetadataForArtifact(
  bytes: Uint8Array,
  expectedId: string,
): InternalStoredArtifactFile {
  const metadata = parseMetadata(bytes);
  if (metadata.id !== expectedId) {
    throw new ArtifactStoreError("ARTIFACT_STORE_FAILURE", "Artifact metadata is invalid.");
  }
  return metadata;
}

const isMissingFileError = (error: unknown) => isFileSystemError(error, "ENOENT");

const artifactOperationTails = new Map<string, Promise<void>>();
const storeMutationTails = new Map<string, Promise<void>>();

async function serializeArtifactOperation<T>(id: string, operation: () => Promise<T>): Promise<T> {
  const previous = artifactOperationTails.get(id) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveCurrent) => {
    release = resolveCurrent;
  });
  const tail = previous.then(
    () => current,
    () => current,
  );
  artifactOperationTails.set(id, tail);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (artifactOperationTails.get(id) === tail) {
      artifactOperationTails.delete(id);
    }
  }
}

async function serializeStoreMutation<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const previous = storeMutationTails.get(root) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveCurrent) => {
    release = resolveCurrent;
  });
  const tail = previous.then(
    () => current,
    () => current,
  );
  storeMutationTails.set(root, tail);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (storeMutationTails.get(root) === tail) storeMutationTails.delete(root);
  }
}

interface ArtifactMutationLockOwner {
  readonly createdAt: string;
  readonly pid: number;
  readonly token: string;
}

function parseLockOwner(bytes: Uint8Array): ArtifactMutationLockOwner | undefined {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<ArtifactMutationLockOwner>;
    if (
      !Number.isSafeInteger(value.pid) ||
      Number(value.pid) < 1 ||
      typeof value.token !== "string" ||
      !/^[a-f0-9]{24}$/u.test(value.token) ||
      typeof value.createdAt !== "string" ||
      !Number.isFinite(new Date(value.createdAt).getTime())
    ) {
      return undefined;
    }
    return value as ArtifactMutationLockOwner;
  } catch {
    return undefined;
  }
}

function defaultProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isFileSystemError(error, "ESRCH");
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

export interface RepositoryArtifactFileStoreOptions {
  readonly clock?: () => Date;
  readonly fileOperations?: ArtifactFileOperations;
  readonly orphanGraceMilliseconds?: number;
  readonly processIsAlive?: (pid: number) => boolean;
  readonly repositoryRoot: string;
  readonly retentionMilliseconds?: number;
  readonly rootDirectory?: string;
}

export function artifactStoreRootForEnvironment(
  repositoryRoot: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const configured = environment.BEA_ARTIFACT_STORE_PATH?.trim();
  return configured ? resolve(repositoryRoot, configured) : undefined;
}

export class RepositoryArtifactFileStore {
  readonly #blobsDirectory: string;
  readonly #dataDirectory: string;
  readonly #expectedCanonicalDataDirectory: string;
  readonly #clock: () => Date;
  readonly #fileOperations: ArtifactFileOperations;
  readonly #locksDirectory: string;
  readonly #manifestsDirectory: string;
  readonly #mutationLockDirectory: string;
  readonly #mutationLockOwnerPath: string;
  readonly #orphanGraceMilliseconds: number;
  readonly #processIsAlive: (pid: number) => boolean;
  readonly #retentionMilliseconds: number;
  readonly #rootDirectory: string;

  constructor(options: RepositoryArtifactFileStoreOptions) {
    const repositoryRoot = resolve(options.repositoryRoot);
    const dataDirectory = resolve(repositoryRoot, ".data");
    const rootDirectory = resolve(
      options.rootDirectory ??
        artifactStoreRootForEnvironment(repositoryRoot) ??
        join(dataDirectory, "artifacts"),
    );
    const canonicalRepositoryRoot = canonicalizeExistingAncestor(repositoryRoot);
    const expectedCanonicalDataDirectory = resolve(canonicalRepositoryRoot, ".data");
    const canonicalDataDirectory = canonicalizeExistingAncestor(dataDirectory);
    const canonicalRootDirectory = canonicalizeExistingAncestor(rootDirectory);
    if (
      !samePath(canonicalDataDirectory, expectedCanonicalDataDirectory) ||
      !isWithin(canonicalRootDirectory, canonicalDataDirectory)
    ) {
      throw new ArtifactValidationError(
        "INVALID_STORE_ROOT",
        "Artifact storage must remain inside the repository .data directory.",
      );
    }
    const retentionMilliseconds = options.retentionMilliseconds ?? defaultRetentionMilliseconds;
    if (
      !Number.isSafeInteger(retentionMilliseconds) ||
      retentionMilliseconds < 1_000 ||
      retentionMilliseconds > maximumRetentionMilliseconds
    ) {
      throw new ArtifactValidationError(
        "INVALID_RETENTION",
        "Artifact retention must be between one second and ninety days.",
      );
    }
    this.#rootDirectory = rootDirectory;
    this.#dataDirectory = dataDirectory;
    this.#expectedCanonicalDataDirectory = expectedCanonicalDataDirectory;
    this.#blobsDirectory = join(rootDirectory, "blobs");
    this.#manifestsDirectory = join(rootDirectory, "manifests");
    this.#locksDirectory = join(rootDirectory, "locks");
    this.#mutationLockDirectory = join(this.#locksDirectory, "mutation.lock");
    this.#mutationLockOwnerPath = join(this.#mutationLockDirectory, "owner.json");
    this.#clock = options.clock ?? (() => new Date());
    this.#fileOperations = options.fileOperations ?? nodeFileOperations;
    const orphanGraceMilliseconds =
      options.orphanGraceMilliseconds ?? defaultOrphanGraceMilliseconds;
    if (
      !Number.isSafeInteger(orphanGraceMilliseconds) ||
      orphanGraceMilliseconds < 1_000 ||
      orphanGraceMilliseconds > maximumOrphanGraceMilliseconds
    ) {
      throw new ArtifactValidationError(
        "INVALID_RETENTION",
        "Artifact orphan grace must be between one second and twenty-four hours.",
      );
    }
    this.#orphanGraceMilliseconds = orphanGraceMilliseconds;
    this.#processIsAlive = options.processIsAlive ?? defaultProcessIsAlive;
    this.#retentionMilliseconds = retentionMilliseconds;
  }

  async initialize(): Promise<void> {
    this.#assertCanonicalContainment();
    await Promise.all([
      this.#fileOperations.mkdir(this.#blobsDirectory),
      this.#fileOperations.mkdir(this.#manifestsDirectory),
      this.#fileOperations.mkdir(this.#locksDirectory),
    ]);
    this.#assertCanonicalContainment();
  }

  #assertSafeMutationLockDirectory(): void {
    this.#assertCanonicalContainment();
    let stats;
    try {
      stats = lstatSync(this.#mutationLockDirectory);
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw new ArtifactValidationError(
        "INVALID_STORE_ROOT",
        "Artifact mutation lock could not be inspected safely.",
      );
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new ArtifactValidationError(
        "INVALID_STORE_ROOT",
        "Artifact mutation lock cannot use a symbolic link or reparse point.",
      );
    }
    const canonicalLock = realpathSync.native(this.#mutationLockDirectory);
    const canonicalLocksDirectory = realpathSync.native(this.#locksDirectory);
    if (!isWithin(canonicalLock, canonicalLocksDirectory)) {
      throw new ArtifactValidationError(
        "INVALID_STORE_ROOT",
        "Artifact mutation lock escaped its controlled directory.",
      );
    }
  }

  async #tryReclaimAbandonedMutationLock(): Promise<boolean> {
    this.#assertSafeMutationLockDirectory();
    let ownerBytes: Uint8Array | undefined;
    try {
      ownerBytes = await this.#readFile(this.#mutationLockOwnerPath);
    } catch (error) {
      if (!isMissingFileError(error)) return false;
    }
    const owner = ownerBytes === undefined ? undefined : parseLockOwner(ownerBytes);
    if (owner) {
      let alive = true;
      try {
        alive = this.#processIsAlive(owner.pid);
      } catch {
        alive = true;
      }
      if (alive) return false;
    } else {
      let lockStats: { readonly mtimeMs: number };
      try {
        lockStats = await this.#fileOperations.stat(this.#mutationLockDirectory);
      } catch {
        return false;
      }
      if (
        !Number.isFinite(lockStats.mtimeMs) ||
        lockStats.mtimeMs > this.#clock().getTime() - this.#orphanGraceMilliseconds
      ) {
        return false;
      }
    }

    try {
      if (ownerBytes !== undefined) await this.#unlinkIfPresent(this.#mutationLockOwnerPath);
      this.#assertSafeMutationLockDirectory();
      await this.#fileOperations.rmdir(this.#mutationLockDirectory);
      return true;
    } catch (error) {
      return isMissingFileError(error);
    }
  }

  async #acquireMutationLock(waitForLock: boolean): Promise<string | undefined> {
    await this.initialize();
    for (let attempt = 0; attempt < mutationLockRetryAttempts; attempt += 1) {
      this.#assertCanonicalContainment();
      if (await this.#fileOperations.mkdirExclusive(this.#mutationLockDirectory)) {
        const token = randomBytes(12).toString("hex");
        const owner: ArtifactMutationLockOwner = {
          createdAt: this.#clock().toISOString(),
          pid: process.pid,
          token,
        };
        try {
          this.#assertSafeMutationLockDirectory();
          await this.#writeFile(this.#mutationLockOwnerPath, `${JSON.stringify(owner)}\n`);
          return token;
        } catch (error) {
          try {
            await this.#unlinkIfPresent(this.#mutationLockOwnerPath);
            this.#assertSafeMutationLockDirectory();
            await this.#fileOperations.rmdir(this.#mutationLockDirectory);
          } catch {
            // The original safe failure is preserved; the next sweep can reclaim an abandoned lock.
          }
          throw error;
        }
      }
      if (await this.#tryReclaimAbandonedMutationLock()) continue;
      if (!waitForLock) return undefined;
      await wait(mutationLockRetryMilliseconds);
    }
    throw new ArtifactStoreError(
      "ARTIFACT_STORE_FAILURE",
      "Artifact storage is busy; no mutation was performed.",
    );
  }

  async #releaseMutationLock(token: string): Promise<void> {
    let owner: ArtifactMutationLockOwner | undefined;
    try {
      owner = parseLockOwner(await this.#readFile(this.#mutationLockOwnerPath));
    } catch {
      owner = undefined;
    }
    if (!owner || owner.token !== token || owner.pid !== process.pid) {
      throw new ArtifactStoreError(
        "ARTIFACT_STORE_FAILURE",
        "Artifact mutation lock ownership could not be verified.",
      );
    }
    await this.#unlinkIfPresent(this.#mutationLockOwnerPath);
    this.#assertSafeMutationLockDirectory();
    await this.#fileOperations.rmdir(this.#mutationLockDirectory);
  }

  async #withMutationLock<T>(
    operation: () => Promise<T>,
    waitForLock: boolean,
  ): Promise<T | undefined> {
    return serializeStoreMutation(this.#rootDirectory, async () => {
      const token = await this.#acquireMutationLock(waitForLock);
      if (!token) return undefined;
      try {
        return await operation();
      } finally {
        await this.#releaseMutationLock(token);
      }
    });
  }

  #assertCanonicalContainment(): void {
    const canonicalDataDirectory = canonicalizeExistingAncestor(this.#dataDirectory);
    const canonicalRootDirectory = canonicalizeExistingAncestor(this.#rootDirectory);
    const canonicalBlobsDirectory = canonicalizeExistingAncestor(this.#blobsDirectory);
    const canonicalManifestsDirectory = canonicalizeExistingAncestor(this.#manifestsDirectory);
    const canonicalLocksDirectory = canonicalizeExistingAncestor(this.#locksDirectory);
    const canonicalMutationLockDirectory = canonicalizeExistingAncestor(
      this.#mutationLockDirectory,
    );
    if (
      !samePath(canonicalDataDirectory, this.#expectedCanonicalDataDirectory) ||
      !isWithin(canonicalRootDirectory, canonicalDataDirectory) ||
      !isWithin(canonicalBlobsDirectory, canonicalRootDirectory) ||
      !isWithin(canonicalManifestsDirectory, canonicalRootDirectory) ||
      !isWithin(canonicalLocksDirectory, canonicalRootDirectory) ||
      !isWithin(canonicalMutationLockDirectory, canonicalLocksDirectory)
    ) {
      throw new ArtifactValidationError(
        "INVALID_STORE_ROOT",
        "Artifact storage must remain inside the repository .data directory.",
      );
    }
  }

  #assertSafeArtifactLeaf(path: string): void {
    const parent = dirname(path);
    if (
      !samePath(parent, this.#blobsDirectory) &&
      !samePath(parent, this.#manifestsDirectory) &&
      !samePath(parent, this.#mutationLockDirectory)
    ) {
      throw new ArtifactValidationError(
        "INVALID_STORE_ROOT",
        "Artifact storage leaf must remain inside a controlled artifact directory.",
      );
    }
    let stats;
    try {
      stats = lstatSync(path);
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw new ArtifactValidationError(
        "INVALID_STORE_ROOT",
        "Artifact storage leaf could not be inspected safely.",
      );
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new ArtifactValidationError(
        "INVALID_STORE_ROOT",
        "Artifact storage cannot use a symbolic link or reparse-point leaf.",
      );
    }
    const canonicalParent = realpathSync.native(parent);
    const canonicalLeaf = realpathSync.native(path);
    if (!isWithin(canonicalLeaf, canonicalParent)) {
      throw new ArtifactValidationError(
        "INVALID_STORE_ROOT",
        "Artifact storage leaf escaped its controlled directory.",
      );
    }
  }

  async #readFile(path: string): Promise<Uint8Array> {
    this.#assertCanonicalContainment();
    this.#assertSafeArtifactLeaf(path);
    return this.#fileOperations.readFile(path);
  }

  async #readdir(path: string): Promise<readonly string[]> {
    this.#assertCanonicalContainment();
    return this.#fileOperations.readdir(path);
  }

  async #rename(from: string, to: string): Promise<void> {
    this.#assertCanonicalContainment();
    this.#assertSafeArtifactLeaf(from);
    this.#assertSafeArtifactLeaf(to);
    await this.#fileOperations.rename(from, to);
  }

  async #writeFile(path: string, data: Uint8Array | string): Promise<void> {
    this.#assertCanonicalContainment();
    this.#assertSafeArtifactLeaf(path);
    await this.#fileOperations.writeFile(path, data);
  }

  async #writeManifestAtomically(
    path: string,
    metadata: InternalStoredArtifactFile,
  ): Promise<void> {
    const temporaryPath = `${path}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
    try {
      await this.#writeFile(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`);
      await this.#rename(temporaryPath, path);
    } catch (error) {
      await this.#unlinkIfPresent(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  #paths(id: string) {
    const artifactId = safeArtifactId(id);
    return {
      blob: join(this.#blobsDirectory, `${artifactId}.bin`),
      manifest: join(this.#manifestsDirectory, `${artifactId}.json`),
    };
  }

  async #readInternal(id: string): Promise<InternalStoredArtifactFile> {
    const paths = this.#paths(id);
    try {
      return parseMetadataForArtifact(await this.#readFile(paths.manifest), id);
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new ArtifactStoreError("ARTIFACT_NOT_FOUND", "Artifact was not found.");
      }
      if (error instanceof ArtifactValidationError) throw error;
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactStoreError(
        "ARTIFACT_STORE_FAILURE",
        "Artifact metadata could not be read.",
      );
    }
  }

  async put(
    ownerIdInput: string,
    input: ArtifactUploadInput,
    options: { readonly retentionMilliseconds?: number } = {},
  ): Promise<StoredArtifactFile> {
    const ownerId = safeOwnerId(ownerIdInput);
    return this.#putNormalized(ownerId, validateGeneratedArtifactFile(input), options);
  }

  async putValidatedUpload(
    ownerIdInput: string,
    input: ValidatedArtifactUpload,
    options: { readonly retentionMilliseconds?: number } = {},
  ): Promise<StoredArtifactFile> {
    const ownerId = safeOwnerId(ownerIdInput);
    const normalized = validateArtifactUpload(input);
    if (
      normalized.extension !== input.extension ||
      normalized.filename !== input.filename ||
      normalized.mimeType !== input.mimeType ||
      normalized.sha256 !== input.sha256 ||
      normalized.size !== input.size ||
      input.malwareScan.status !== "clean" ||
      !(input.malwareScan.mode === "connected" || input.malwareScan.mode === "simulated") ||
      input.malwareScan.engine.trim().length === 0
    ) {
      throw new ArtifactValidationError(
        "INVALID_VALIDATED_UPLOAD",
        "Validated artifact upload metadata is inconsistent.",
      );
    }
    return this.#putNormalized(ownerId, { ...normalized, malwareScan: input.malwareScan }, options);
  }

  async #putNormalized(
    ownerId: string,
    upload: NormalizedArtifactUpload | ValidatedArtifactUpload,
    options: { readonly retentionMilliseconds?: number },
  ): Promise<StoredArtifactFile> {
    const retentionMilliseconds = options.retentionMilliseconds ?? this.#retentionMilliseconds;
    if (
      !Number.isSafeInteger(retentionMilliseconds) ||
      retentionMilliseconds < 1_000 ||
      retentionMilliseconds > maximumRetentionMilliseconds
    ) {
      throw new ArtifactValidationError("INVALID_RETENTION", "Artifact retention is invalid.");
    }
    const id = `art_${createHash("sha256")
      .update(ownerId)
      .update("\0")
      .update(upload.filename)
      .update("\0")
      .update(upload.mimeType)
      .update("\0")
      .update(upload.sha256)
      .digest("hex")
      .slice(0, 32)}`;
    const stored = await this.#withMutationLock(
      () =>
        serializeArtifactOperation(id, async () => {
          const paths = this.#paths(id);
          await this.initialize();

          try {
            const existing = await this.#readInternal(id);
            if (existing.ownerId !== ownerId || existing.sha256 !== upload.sha256) {
              throw new ArtifactStoreError(
                "ARTIFACT_STORE_FAILURE",
                "Artifact identity collision.",
              );
            }
            let existingBytes: Uint8Array;
            try {
              existingBytes = await this.#readFile(paths.blob);
            } catch (error) {
              if (error instanceof ArtifactValidationError) throw error;
              throw new ArtifactStoreError(
                "ARTIFACT_STORE_FAILURE",
                "Artifact content could not be verified safely.",
              );
            }
            const existingHash = createHash("sha256").update(existingBytes).digest("hex");
            if (existingBytes.length !== existing.size || existingHash !== existing.sha256) {
              throw new ArtifactStoreError(
                "ARTIFACT_STORE_FAILURE",
                "Artifact integrity verification failed.",
              );
            }
            const acquiredAt = this.#clock();
            if (new Date(existing.expiresAt).getTime() > acquiredAt.getTime()) {
              const requestedExpiry = acquiredAt.getTime() + retentionMilliseconds;
              const referenced: InternalStoredArtifactFile = {
                ...existing,
                expiresAt: new Date(
                  Math.max(new Date(existing.expiresAt).getTime(), requestedExpiry),
                ).toISOString(),
                referenceCount: existing.referenceCount + 1,
              };
              if (!Number.isSafeInteger(referenced.referenceCount)) {
                throw new ArtifactStoreError(
                  "ARTIFACT_STORE_FAILURE",
                  "Artifact reference limit was exceeded.",
                );
              }
              try {
                await this.#writeManifestAtomically(paths.manifest, referenced);
              } catch {
                throw new ArtifactStoreError(
                  "ARTIFACT_STORE_FAILURE",
                  "Artifact reference could not be acquired.",
                );
              }
              return publicMetadata(referenced);
            }
            await this.#unlinkIfPresent(paths.blob);
            await this.#unlinkIfPresent(paths.manifest);
          } catch (error) {
            if (!(error instanceof ArtifactStoreError) || error.code !== "ARTIFACT_NOT_FOUND") {
              throw error;
            }
          }

          const createdAt = this.#clock();
          const expiresAt = new Date(createdAt.getTime() + retentionMilliseconds);
          const metadata: InternalStoredArtifactFile = {
            createdAt: createdAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
            filename: upload.filename,
            id,
            ...("malwareScan" in upload
              ? { malwareScan: upload.malwareScan as MalwareScanResult }
              : {}),
            mimeType: upload.mimeType,
            ownerId,
            referenceCount: 1,
            sha256: upload.sha256,
            size: upload.size,
            version: 2,
          };
          const temporarySuffix = `${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
          const temporaryBlob = `${paths.blob}.${temporarySuffix}`;
          const temporaryManifest = `${paths.manifest}.${temporarySuffix}`;
          let blobCommitted = false;
          let manifestCommitted = false;
          try {
            await this.#writeFile(temporaryBlob, upload.bytes);
            await this.#writeFile(temporaryManifest, `${JSON.stringify(metadata, null, 2)}\n`);
            await this.#rename(temporaryBlob, paths.blob);
            blobCommitted = true;
            await this.#rename(temporaryManifest, paths.manifest);
            manifestCommitted = true;
            return publicMetadata(metadata);
          } catch {
            const cleanupTargets = [
              this.#unlinkIfPresent(temporaryBlob),
              this.#unlinkIfPresent(temporaryManifest),
              ...(blobCommitted ? [this.#unlinkIfPresent(paths.blob)] : []),
              ...(manifestCommitted ? [this.#unlinkIfPresent(paths.manifest)] : []),
            ];
            await Promise.allSettled(cleanupTargets);
            throw new ArtifactStoreError("ARTIFACT_STORE_FAILURE", "Artifact could not be stored.");
          }
        }),
      true,
    );
    if (!stored) {
      throw new ArtifactStoreError("ARTIFACT_STORE_FAILURE", "Artifact could not be stored.");
    }
    return stored;
  }

  async #unlinkIfPresent(path: string): Promise<void> {
    try {
      this.#assertCanonicalContainment();
      this.#assertSafeArtifactLeaf(path);
      await this.#fileOperations.unlink(path);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  }

  async get(ownerIdInput: string, id: string): Promise<StoredArtifactContent> {
    const ownerId = safeOwnerId(ownerIdInput);
    await this.initialize();
    const metadata = await this.#readInternal(id);
    if (
      metadata.ownerId !== ownerId ||
      new Date(metadata.expiresAt).getTime() <= this.#clock().getTime()
    ) {
      throw new ArtifactStoreError("ARTIFACT_NOT_FOUND", "Artifact was not found.");
    }
    let bytes: Uint8Array;
    try {
      bytes = await this.#readFile(this.#paths(id).blob);
    } catch (error) {
      if (error instanceof ArtifactValidationError) throw error;
      throw new ArtifactStoreError("ARTIFACT_STORE_FAILURE", "Artifact content could not be read.");
    }
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== metadata.size || hash !== metadata.sha256) {
      throw new ArtifactStoreError(
        "ARTIFACT_STORE_FAILURE",
        "Artifact integrity verification failed.",
      );
    }
    return { bytes, metadata: publicMetadata(metadata) };
  }

  async delete(ownerIdInput: string, id: string): Promise<void> {
    const ownerId = safeOwnerId(ownerIdInput);
    const artifactId = safeArtifactId(id);
    await this.#withMutationLock(
      () =>
        serializeArtifactOperation(artifactId, async () => {
          await this.initialize();
          const metadata = await this.#readInternal(artifactId);
          if (
            metadata.ownerId !== ownerId ||
            new Date(metadata.expiresAt).getTime() <= this.#clock().getTime()
          ) {
            throw new ArtifactStoreError("ARTIFACT_NOT_FOUND", "Artifact was not found.");
          }
          const paths = this.#paths(artifactId);
          try {
            if (metadata.referenceCount > 1) {
              await this.#writeManifestAtomically(paths.manifest, {
                ...metadata,
                referenceCount: metadata.referenceCount - 1,
              });
              return;
            }
            await this.#unlinkIfPresent(paths.blob);
            await this.#unlinkIfPresent(paths.manifest);
          } catch {
            throw new ArtifactStoreError(
              "ARTIFACT_STORE_FAILURE",
              "Artifact cleanup did not complete.",
            );
          }
        }),
      true,
    );
  }

  async cleanupExpired(at: Date = this.#clock()): Promise<ArtifactCleanupResult> {
    const cleanupAt = validateMaintenanceDate(at);
    const result = await this.#withMutationLock(
      () => this.#cleanupExpiredUnlocked(cleanupAt),
      true,
    );
    if (!result) {
      throw new ArtifactStoreError("ARTIFACT_STORE_FAILURE", "Artifact retention scan failed.");
    }
    return result;
  }

  async #cleanupExpiredUnlocked(at: Date): Promise<ArtifactCleanupResult> {
    await this.initialize();
    let names: readonly string[];
    try {
      names = await this.#readdir(this.#manifestsDirectory);
    } catch {
      throw new ArtifactStoreError("ARTIFACT_STORE_FAILURE", "Artifact retention scan failed.");
    }
    const deletedIds: string[] = [];
    const failed: Array<{ code: "invalid-metadata" | "delete-failed"; id: string }> = [];
    for (const name of names.filter((entry) => /^art_[a-f0-9]{32}\.json$/u.test(entry)).sort()) {
      const id = name.slice(0, -".json".length);
      try {
        await serializeArtifactOperation(id, async () => {
          let metadata: InternalStoredArtifactFile;
          try {
            metadata = await this.#readInternal(id);
          } catch {
            failed.push({ code: "invalid-metadata", id });
            return;
          }
          if (new Date(metadata.expiresAt).getTime() > at.getTime()) return;
          const paths = this.#paths(id);
          try {
            await this.#unlinkIfPresent(paths.blob);
            await this.#unlinkIfPresent(paths.manifest);
            deletedIds.push(id);
          } catch {
            failed.push({ code: "delete-failed", id });
          }
        });
      } catch {
        failed.push({ code: "invalid-metadata", id });
      }
    }
    return { deletedIds, failed };
  }

  async #cleanupCrashOrphansUnlocked(at: Date): Promise<ArtifactOrphanCleanupResult> {
    await this.initialize();
    let blobNames: readonly string[];
    let manifestNames: readonly string[];
    try {
      [blobNames, manifestNames] = await Promise.all([
        this.#readdir(this.#blobsDirectory),
        this.#readdir(this.#manifestsDirectory),
      ]);
    } catch {
      throw new ArtifactStoreError("ARTIFACT_STORE_FAILURE", "Artifact orphan scan failed.");
    }

    const deletedIds = new Set<string>();
    const deletedInvalidMetadataIds = new Set<string>();
    let deletedTemporaryFiles = 0;
    const failed: Array<{ code: "inspect-failed" | "delete-failed"; id: string }> = [];
    const cutoff = at.getTime() - this.#orphanGraceMilliseconds;
    const deleteOldLeaf = async (path: string, id: string, temporary: boolean): Promise<void> => {
      let details: { readonly mtimeMs: number };
      try {
        this.#assertCanonicalContainment();
        this.#assertSafeArtifactLeaf(path);
        details = await this.#fileOperations.stat(path);
      } catch (error) {
        if (!isMissingFileError(error)) failed.push({ code: "inspect-failed", id });
        return;
      }
      if (!Number.isFinite(details.mtimeMs)) {
        failed.push({ code: "inspect-failed", id });
        return;
      }
      if (details.mtimeMs > cutoff) return;
      try {
        await this.#unlinkIfPresent(path);
        if (temporary) deletedTemporaryFiles += 1;
        else deletedIds.add(id);
      } catch {
        failed.push({ code: "delete-failed", id });
      }
    };

    const manifestSet = new Set(
      manifestNames.flatMap((name) => {
        const match = artifactManifestNamePattern.exec(name);
        return match?.[1] ? [match[1]] : [];
      }),
    );
    const blobSet = new Set(
      blobNames.flatMap((name) => {
        const match = artifactBlobNamePattern.exec(name);
        return match?.[1] ? [match[1]] : [];
      }),
    );

    for (const id of [...blobSet].filter((value) => manifestSet.has(value)).sort()) {
      const paths = this.#paths(id);
      let metadataBytes: Uint8Array;
      try {
        metadataBytes = await this.#readFile(paths.manifest);
      } catch {
        failed.push({ code: "inspect-failed", id });
        continue;
      }
      let metadata: InternalStoredArtifactFile | undefined;
      try {
        metadata = parseMetadata(metadataBytes);
      } catch {
        // A strict-ID pair with malformed metadata is unusable crash residue.
      }
      if (metadata) {
        if (metadata.id !== id) failed.push({ code: "inspect-failed", id });
        continue;
      }

      let blobDetails: { readonly mtimeMs: number };
      let manifestDetails: { readonly mtimeMs: number };
      try {
        this.#assertSafeArtifactLeaf(paths.blob);
        this.#assertSafeArtifactLeaf(paths.manifest);
        [blobDetails, manifestDetails] = await Promise.all([
          this.#fileOperations.stat(paths.blob),
          this.#fileOperations.stat(paths.manifest),
        ]);
      } catch {
        failed.push({ code: "inspect-failed", id });
        continue;
      }
      if (
        !Number.isFinite(blobDetails.mtimeMs) ||
        !Number.isFinite(manifestDetails.mtimeMs) ||
        blobDetails.mtimeMs > cutoff ||
        manifestDetails.mtimeMs > cutoff
      ) {
        continue;
      }
      try {
        await this.#unlinkIfPresent(paths.blob);
        await this.#unlinkIfPresent(paths.manifest);
        deletedInvalidMetadataIds.add(id);
      } catch {
        failed.push({ code: "delete-failed", id });
      }
    }

    for (const name of [...blobNames].sort()) {
      const temporary = artifactTemporaryNamePattern.exec(name);
      if (temporary?.[1]) {
        await deleteOldLeaf(join(this.#blobsDirectory, name), temporary[1], true);
        continue;
      }
      const blob = artifactBlobNamePattern.exec(name);
      if (blob?.[1] && !manifestSet.has(blob[1])) {
        await deleteOldLeaf(join(this.#blobsDirectory, name), blob[1], false);
      }
    }
    for (const name of [...manifestNames].sort()) {
      const temporary = artifactTemporaryNamePattern.exec(name);
      if (temporary?.[1]) {
        await deleteOldLeaf(join(this.#manifestsDirectory, name), temporary[1], true);
        continue;
      }
      const manifest = artifactManifestNamePattern.exec(name);
      if (manifest?.[1] && !blobSet.has(manifest[1])) {
        await deleteOldLeaf(join(this.#manifestsDirectory, name), manifest[1], false);
      }
    }

    return {
      deletedIds: [...deletedIds].sort(),
      deletedInvalidMetadataIds: [...deletedInvalidMetadataIds].sort(),
      deletedTemporaryFiles,
      failed,
    };
  }

  async runMaintenanceSweep(at: Date = this.#clock()): Promise<ArtifactMaintenanceResult> {
    const sweepAt = validateMaintenanceDate(at);
    const result = await this.#withMutationLock(async () => {
      const orphans = await this.#cleanupCrashOrphansUnlocked(sweepAt);
      const expired = await this.#cleanupExpiredUnlocked(sweepAt);
      return { status: "completed" as const, expired, orphans };
    }, false);
    return (
      result ?? {
        status: "skipped-active" as const,
        expired: { deletedIds: [], failed: [] },
        orphans: {
          deletedIds: [],
          deletedInvalidMetadataIds: [],
          deletedTemporaryFiles: 0,
          failed: [],
        },
      }
    );
  }
}
