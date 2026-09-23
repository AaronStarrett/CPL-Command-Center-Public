import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { CplEvidenceFileStore, CplEvidenceStoreError } from "./cpl-evidence-store";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync) };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

let sandbox: string;
const fixtures: string[] = [];
const organizationId = "41000000-0000-4000-8000-000000000001";
const objectId = "41000000-0000-4000-8000-000000000002";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const input = (bytes = Buffer.from("immutable original")) => ({
  organizationId,
  objectId,
  bytes,
  sha256: sha(bytes),
});

beforeAll(async () => {
  if (process.platform === "win32" && !/^D:\\/iu.test(tmpdir()))
    throw new Error("D-scoped temporary directory required");
  sandbox = await io.mkdtemp(join(tmpdir(), "cpl-evidence-tests-"));
});
afterEach(() => vi.resetAllMocks());
afterAll(async () => {
  for (const fixture of fixtures) {
    if (relative(sandbox, fixture).startsWith("..")) throw new Error("Unsafe test cleanup");
    await io.rm(fixture, { recursive: true, force: true });
  }
  await io.rmdir(sandbox);
});
function fixture() {
  const root = join(sandbox, randomUUID());
  fixtures.push(root);
  return {
    root,
    store: new CplEvidenceFileStore({ allowedRootDirectory: sandbox, rootDirectory: root }),
  };
}

describe("durable tenant evidence store", () => {
  it("round-trips verified bytes with path-free references and no expiry", async () => {
    const { root, store } = fixture(),
      original = input();
    const result = await store.putImmutable(original);
    expect(result).toEqual({
      organizationId,
      objectId,
      sha256: original.sha256,
      byteLength: original.bytes.length,
      created: true,
    });
    expect(await store.getVerified(result)).toEqual(original.bytes);
    expect(Object.keys(result)).not.toContain("path");
    expect(await io.readdir(join(root, organizationId, objectId))).toEqual([
      "bytes",
      "manifest.json",
    ]);
    const later = new CplEvidenceFileStore({ allowedRootDirectory: sandbox, rootDirectory: root });
    expect(await later.putImmutable(original)).toMatchObject({ created: false });
    expect(await later.getVerified(result)).toEqual(original.bytes);
  });
  it("retains the first object when the same key is supplied with different bytes", async () => {
    const { store } = fixture(),
      original = input();
    const result = await store.putImmutable(original);
    await expect(store.putImmutable(input(Buffer.from("different")))).rejects.toMatchObject({
      code: "CPL_EVIDENCE_CONFLICT",
    });
    expect(await store.getVerified(result)).toEqual(original.bytes);
  });
  it("one concurrent publisher wins and matching retries all verify identical bytes", async () => {
    const { store } = fixture();
    const results = await Promise.all(Array.from({ length: 6 }, () => store.putImmutable(input())));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    for (const result of results) expect(await store.getVerified(result)).toEqual(input().bytes);
  });
  it("tenant namespaces cannot read one another's opaque objects", async () => {
    const { store } = fixture(),
      first = await store.putImmutable(input());
    const otherOrg = "41000000-0000-4000-8000-000000000099";
    await expect(store.getVerified({ ...first, organizationId: otherOrg })).rejects.toMatchObject({
      code: "CPL_EVIDENCE_NOT_FOUND",
    });
    const second = await store.putImmutable({
      ...input(Buffer.from("other tenant")),
      organizationId: otherOrg,
    });
    expect(await store.getVerified(second)).toEqual(Buffer.from("other tenant"));
    expect(await store.getVerified(first)).toEqual(input().bytes);
  });
  it.each([
    "../outside",
    "..\\outside",
    "C:\\outside",
    "x/y",
    "00000000-0000-0000-0000-000000000000",
    "41000000-0000-4000-8000-000000000001:stream",
  ])("rejects non-UUID path material %s", async (value) => {
    const { store } = fixture();
    await expect(store.putImmutable({ ...input(), objectId: value })).rejects.toMatchObject({
      code: "CPL_EVIDENCE_INVALID_INPUT",
    });
    await expect(store.putImmutable({ ...input(), organizationId: value })).rejects.toMatchObject({
      code: "CPL_EVIDENCE_INVALID_INPUT",
    });
  });
  it("refuses bytes which do not match the caller's expected hash", async () => {
    const { store } = fixture();
    await expect(store.putImmutable({ ...input(), sha256: "0".repeat(64) })).rejects.toMatchObject({
      code: "CPL_EVIDENCE_INTEGRITY_FAILURE",
    });
  });
  it("detects corruption even when length and manifest remain unchanged", async () => {
    const { root, store } = fixture(),
      result = await store.putImmutable(input());
    await io.writeFile(
      join(root, organizationId, objectId, "bytes"),
      Buffer.alloc(result.byteLength),
    );
    await expect(store.getVerified(result)).rejects.toMatchObject({
      code: "CPL_EVIDENCE_INTEGRITY_FAILURE",
    });
    await expect(store.putImmutable(input())).rejects.toMatchObject({
      code: "CPL_EVIDENCE_INTEGRITY_FAILURE",
    });
  });
  it("never exposes a partial stage and retries publication without deleting it", async () => {
    const { root, store } = fixture(),
      original = input();
    vi.mocked(io.rename).mockRejectedValueOnce(
      Object.assign(new Error("private/path must not escape"), { code: "EIO" }),
    );
    await expect(store.putImmutable(original)).rejects.toMatchObject({
      code: "CPL_EVIDENCE_STORAGE_UNAVAILABLE",
      message: "CPL_EVIDENCE_STORAGE_UNAVAILABLE",
    });
    await expect(
      store.getVerified({ ...original, byteLength: original.bytes.length }),
    ).rejects.toMatchObject({ code: "CPL_EVIDENCE_NOT_FOUND" });
    const staged = await io.readdir(join(root, organizationId));
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatch(/^\.pending-/u);
    const result = await store.putImmutable(original);
    expect(result.created).toBe(true);
    expect(await io.readFile(join(root, organizationId, staged[0]!, "bytes"))).toEqual(
      original.bytes,
    );
    expect(await store.getVerified(result)).toEqual(original.bytes);
  });
  it("rejects redirected/reparse ancestors on each operation, including after construction", async () => {
    const { root, store } = fixture(),
      reference = await store.putImmutable(input());
    const originalLstat = (await vi.importActual<typeof import("node:fs")>("node:fs")).lstatSync;
    vi.mocked(fs.lstatSync).mockImplementation(((filename: fs.PathLike) => {
      const stat = originalLstat(filename);
      return String(filename) === root
        ? Object.assign(Object.create(stat), { isSymbolicLink: () => true })
        : stat;
    }) as typeof fs.lstatSync);
    await expect(store.getVerified(reference)).rejects.toMatchObject({
      code: "CPL_EVIDENCE_UNSAFE_PATH",
    });
    await expect(store.putImmutable(input())).rejects.toMatchObject({
      code: "CPL_EVIDENCE_UNSAFE_PATH",
    });
  });
  it("rejects an object leaf replaced by a directory and does not repair it", async () => {
    const { root, store } = fixture(),
      reference = await store.putImmutable(input());
    const leaf = join(root, organizationId, objectId, "bytes");
    await io.rename(leaf, join(root, organizationId, ".preserved-test-original"));
    await io.mkdir(leaf);
    await expect(store.getVerified(reference)).rejects.toMatchObject({
      code: "CPL_EVIDENCE_UNSAFE_PATH",
    });
  });
  it("requires an existing trusted ancestor and a strict contained root", () => {
    for (const rootDirectory of [sandbox, join(sandbox, "..", "outside"), "relative/path"]) {
      expect(
        () => new CplEvidenceFileStore({ rootDirectory, allowedRootDirectory: sandbox }),
      ).toThrow(CplEvidenceStoreError);
    }
    expect(
      () =>
        new CplEvidenceFileStore({
          rootDirectory: join(sandbox, "absent", "data"),
          allowedRootDirectory: join(sandbox, "absent"),
        }),
    ).toThrow(CplEvidenceStoreError);
  });
  it("copies mutable caller buffers before any asynchronous filesystem work", async () => {
    const { store } = fixture(),
      original = input(),
      expected = Buffer.from(original.bytes);
    const saving = store.putImmutable(original);
    original.bytes.fill(0);
    expect(await store.getVerified(await saving)).toEqual(expected);
  });
});
