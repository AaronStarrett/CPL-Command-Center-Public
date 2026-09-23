import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, realpathSync } from "node:fs";
import { mkdir, open, readdir, rename } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export const CPL_EVIDENCE_MAXIMUM_BYTES = 64 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const hash = /^[0-9a-f]{64}$/u;

export class CplEvidenceStoreError extends Error {
  constructor(
    readonly code:
      | "CPL_EVIDENCE_INVALID_INPUT"
      | "CPL_EVIDENCE_UNSAFE_PATH"
      | "CPL_EVIDENCE_NOT_FOUND"
      | "CPL_EVIDENCE_CONFLICT"
      | "CPL_EVIDENCE_INTEGRITY_FAILURE"
      | "CPL_EVIDENCE_STORAGE_UNAVAILABLE",
  ) {
    super(code);
    this.name = "CplEvidenceStoreError";
  }
}

export interface CplEvidenceKey {
  readonly organizationId: string;
  readonly objectId: string;
}

export interface CplEvidenceReference extends CplEvidenceKey {
  readonly sha256: string;
  readonly byteLength: number;
}

export interface CplEvidenceStorage {
  putImmutable(
    input: CplEvidenceKey & { readonly bytes: Uint8Array; readonly sha256: string },
  ): Promise<CplEvidenceReference & { readonly created: boolean }>;
  getVerified(reference: CplEvidenceReference): Promise<Uint8Array>;
}

function fail(code: CplEvidenceStoreError["code"]): never {
  throw new CplEvidenceStoreError(code);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function contained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference === "" ||
    (!isAbsolute(difference) && difference !== ".." && !difference.startsWith(`..${sep}`))
  );
}

/** Check every existing ancestor, including ancestors of the configured trust root. */
function inspectPath(candidate: string, leaf: "directory" | "file"): boolean {
  const root = parse(candidate).root;
  let current = root;
  for (const segment of relative(root, candidate).split(sep).filter(Boolean)) {
    current = join(current, segment);
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    if (info.isSymbolicLink() || relative(current, realpathSync(current)) !== "") {
      fail("CPL_EVIDENCE_UNSAFE_PATH");
    }
    if (current === candidate && leaf === "file" ? !info.isFile() : !info.isDirectory()) {
      fail("CPL_EVIDENCE_UNSAFE_PATH");
    }
  }
  return true;
}

function validateKey(key: CplEvidenceKey): void {
  if (!uuid.test(key.organizationId) || !uuid.test(key.objectId))
    fail("CPL_EVIDENCE_INVALID_INPUT");
}

function validateReference(reference: CplEvidenceReference): void {
  validateKey(reference);
  if (
    !hash.test(reference.sha256) ||
    !Number.isSafeInteger(reference.byteLength) ||
    reference.byteLength < 1 ||
    reference.byteLength > CPL_EVIDENCE_MAXIMUM_BYTES
  ) {
    fail("CPL_EVIDENCE_INVALID_INPUT");
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sanitize(error: unknown): never {
  if (error instanceof CplEvidenceStoreError) throw error;
  // Filesystem messages contain private root paths. They never cross this port.
  fail("CPL_EVIDENCE_STORAGE_UNAVAILABLE");
}

/**
 * SQL owns authorization and references. This adapter adds tenant-separated opaque
 * storage, never permissions. Both roots must come from trusted server configuration.
 * There is intentionally no delete, expiry, listing, or caller-supplied path API.
 */
export class CplEvidenceFileStore implements CplEvidenceStorage {
  readonly #root: string;

  constructor(options: { readonly rootDirectory: string; readonly allowedRootDirectory: string }) {
    try {
      const allowed = resolve(options.allowedRootDirectory);
      const root = resolve(options.rootDirectory);
      if (
        !isAbsolute(options.rootDirectory) ||
        !isAbsolute(options.allowedRootDirectory) ||
        allowed === parse(allowed).root ||
        root === allowed ||
        !contained(allowed, root) ||
        !inspectPath(allowed, "directory")
      ) {
        fail("CPL_EVIDENCE_UNSAFE_PATH");
      }
      inspectPath(root, "directory");
      this.#root = root;
    } catch (error) {
      sanitize(error);
    }
  }

  #objectPath(key: CplEvidenceKey): string {
    validateKey(key);
    const target = join(this.#root, key.organizationId, key.objectId);
    if (!contained(this.#root, target)) fail("CPL_EVIDENCE_UNSAFE_PATH");
    return target;
  }

  async #readFile(filename: string, maximumBytes: number): Promise<Uint8Array> {
    if (!inspectPath(filename, "file")) fail("CPL_EVIDENCE_NOT_FOUND");
    const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size < 1 || before.size > maximumBytes)
        fail("CPL_EVIDENCE_INTEGRITY_FAILURE");
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (
        bytes.length !== before.size ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        !inspectPath(filename, "file")
      )
        fail("CPL_EVIDENCE_INTEGRITY_FAILURE");
      return bytes;
    } finally {
      await handle.close();
    }
  }

  async #readObject(reference: CplEvidenceReference): Promise<Uint8Array> {
    const target = this.#objectPath(reference);
    if (!inspectPath(target, "directory")) fail("CPL_EVIDENCE_NOT_FOUND");
    const entries = (await readdir(target)).sort();
    if (entries.length !== 2 || entries[0] !== "bytes" || entries[1] !== "manifest.json")
      fail("CPL_EVIDENCE_INTEGRITY_FAILURE");
    let manifest: unknown;
    try {
      manifest = JSON.parse(
        Buffer.from(await this.#readFile(join(target, "manifest.json"), 1024)).toString("utf8"),
      );
    } catch (error) {
      if (error instanceof CplEvidenceStoreError) throw error;
      fail("CPL_EVIDENCE_INTEGRITY_FAILURE");
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
      fail("CPL_EVIDENCE_INTEGRITY_FAILURE");
    const expected = {
      format: 1,
      organizationId: reference.organizationId,
      objectId: reference.objectId,
      sha256: reference.sha256,
      byteLength: reference.byteLength,
    };
    if (JSON.stringify(manifest) !== JSON.stringify(expected)) fail("CPL_EVIDENCE_CONFLICT");
    const bytes = await this.#readFile(join(target, "bytes"), reference.byteLength);
    if (bytes.length !== reference.byteLength || digest(bytes) !== reference.sha256)
      fail("CPL_EVIDENCE_INTEGRITY_FAILURE");
    return bytes;
  }

  async getVerified(reference: CplEvidenceReference): Promise<Uint8Array> {
    try {
      validateReference(reference);
      return await this.#readObject(reference);
    } catch (error) {
      sanitize(error);
    }
  }

  async putImmutable(
    input: CplEvidenceKey & { readonly bytes: Uint8Array; readonly sha256: string },
  ): Promise<CplEvidenceReference & { readonly created: boolean }> {
    try {
      if (!(input.bytes instanceof Uint8Array)) fail("CPL_EVIDENCE_INVALID_INPUT");
      const reference: CplEvidenceReference = {
        organizationId: input.organizationId,
        objectId: input.objectId,
        sha256: input.sha256,
        byteLength: input.bytes.length,
      };
      validateReference(reference);
      const bytes = Uint8Array.from(input.bytes);
      if (digest(bytes) !== reference.sha256) fail("CPL_EVIDENCE_INTEGRITY_FAILURE");
      const target = this.#objectPath(reference);
      if (inspectPath(target, "directory")) {
        await this.#readObject(reference);
        return { ...reference, created: false };
      }
      const parent = join(this.#root, reference.organizationId);
      inspectPath(parent, "directory");
      await mkdir(parent, { recursive: true });
      inspectPath(parent, "directory");
      // Staging remains private and is never a readable object. Interrupted writes
      // are retained for operator reconciliation; a retry uses a fresh staging ID.
      const staging = join(parent, `.pending-${randomUUID()}`);
      await mkdir(staging);
      inspectPath(staging, "directory");
      const manifest = Buffer.from(JSON.stringify({ format: 1, ...reference }));
      for (const [name, content] of [
        ["bytes", bytes],
        ["manifest.json", manifest],
      ] as const) {
        const filename = join(staging, name);
        inspectPath(staging, "directory");
        const handle = await open(filename, "wx", 0o600);
        try {
          await handle.writeFile(content);
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      if (digest(await this.#readFile(join(staging, "bytes"), bytes.length)) !== reference.sha256)
        fail("CPL_EVIDENCE_INTEGRITY_FAILURE");
      inspectPath(parent, "directory");
      inspectPath(staging, "directory");
      // A published target is a nonempty directory: a competing rename cannot
      // overwrite it. In particular, do not rename a file over another file.
      if (!inspectPath(target, "directory")) {
        try {
          await rename(staging, target);
        } catch (error) {
          if (!inspectPath(target, "directory")) throw error;
        }
      }
      await this.#readObject(reference);
      return { ...reference, created: !inspectPath(staging, "directory") };
    } catch (error) {
      sanitize(error);
    }
  }
}
