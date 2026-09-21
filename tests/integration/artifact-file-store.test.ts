import { nativeWindowsFilesystemMissing } from "../filesystem-capabilities";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  ArtifactValidationError,
  DeterministicDemoMalwareScanner,
  RepositoryArtifactFileStore,
  createArtifactDownloadResponse,
  createArtifactPreviewResponse,
  createArtifactRefreshResponse,
  createValidatedArtifactUploadResponse,
  validateArtifactUploadWithScanner,
  type ArtifactFileOperations,
  type ArtifactWebAuditEvent,
  type ArtifactWebAuditSink,
  type ArtifactWebPermission,
  type StoredArtifactFile,
} from "../../packages/artifacts/src/index.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const dataDirectory = join(repositoryRoot, ".data");
const ownerId = "10000000-0000-4000-8000-000000000001";
const otherOwnerId = "10000000-0000-4000-8000-000000000002";
const uploadInput = {
  bytes: new TextEncoder().encode("system,observation\nRoof,Synthetic observation\n"),
  filename: "synthetic-observations.csv",
  mimeType: "text/csv",
};
const itWithReparsePoints = it.skipIf(
  nativeWindowsFilesystemMissing("reparse points", dataDirectory),
);
const cleanupDirectories: string[] = [];
const cleanupLinks: string[] = [];
const auditEvents: ArtifactWebAuditEvent[] = [];
const audit: ArtifactWebAuditSink = {
  async record(event) {
    auditEvents.push(event);
  },
};

async function mkdirExclusive(path: string): Promise<boolean> {
  try {
    await mkdir(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

function webContext(
  input: {
    readonly actorId?: string;
    readonly ownerId?: string;
    readonly permissions?: readonly ArtifactWebPermission[];
  } = {},
) {
  return {
    audit,
    authorization: {
      actorId: input.actorId ?? ownerId,
      correlationId: `artifact-web-test-${auditEvents.length + 1}`,
      ownerId: input.ownerId ?? ownerId,
      permissions: input.permissions ?? ["artifacts:read", "artifacts:download", "artifacts:write"],
    },
  } as const;
}

async function createStoreRoot(): Promise<string> {
  await mkdir(dataDirectory, { recursive: true });
  const root = await mkdtemp(join(dataDirectory, "artifact-store-test-"));
  cleanupDirectories.push(root);
  return root;
}

afterEach(async () => {
  auditEvents.splice(0);
  for (const link of cleanupLinks.splice(0).reverse()) {
    await unlink(link).catch(() => undefined);
  }
  for (const directory of cleanupDirectories.splice(0).reverse()) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("repository-local artifact file store and safe web response seams", () => {
  it("stores stable IDs and hashes without exposing raw paths", async () => {
    const rootDirectory = await createStoreRoot();
    const clock = () => new Date("2026-08-20T14:00:00.000Z");
    const store = new RepositoryArtifactFileStore({ clock, repositoryRoot, rootDirectory });
    const first = await store.put(ownerId, uploadInput);
    const second = await store.put(ownerId, uploadInput);

    expect(second).toEqual(first);
    expect(first.id).toMatch(/^art_[a-f0-9]{32}$/u);
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(first)).not.toContain(rootDirectory);
    expect(first).not.toHaveProperty("ownerId");
    await expect(store.get(ownerId, first.id)).resolves.toMatchObject({ metadata: first });
  });

  it("keeps a prior shared artifact when a later deduplicated reference is cleaned up", async () => {
    const rootDirectory = await createStoreRoot();
    const store = new RepositoryArtifactFileStore({ repositoryRoot, rootDirectory });
    const first = await store.put(ownerId, uploadInput);
    const later = await store.put(ownerId, uploadInput);

    expect(later.id).toBe(first.id);
    await store.delete(ownerId, later.id);
    await expect(store.get(ownerId, first.id)).resolves.toMatchObject({ metadata: later });

    await store.delete(ownerId, first.id);
    await expect(store.get(ownerId, first.id)).rejects.toMatchObject({
      code: "ARTIFACT_NOT_FOUND",
    });
  });

  it("serializes concurrent reference acquisition and release across store instances", async () => {
    const rootDirectory = await createStoreRoot();
    const stores = Array.from(
      { length: 4 },
      () => new RepositoryArtifactFileStore({ repositoryRoot, rootDirectory }),
    );
    const first = await stores[0]!.put(ownerId, uploadInput);
    const acquired = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        stores[index % stores.length]!.put(ownerId, uploadInput),
      ),
    );

    expect(new Set(acquired.map(({ id }) => id))).toEqual(new Set([first.id]));
    const manifestPath = join(rootDirectory, "manifests", `${first.id}.json`);
    await expect(readFile(manifestPath, "utf8").then(JSON.parse)).resolves.toMatchObject({
      referenceCount: 17,
      version: 2,
    });

    await Promise.all(
      acquired.map(({ id }, index) => stores[index % stores.length]!.delete(ownerId, id)),
    );
    await expect(readFile(manifestPath, "utf8").then(JSON.parse)).resolves.toMatchObject({
      referenceCount: 1,
      version: 2,
    });
    await expect(stores[1]!.get(ownerId, first.id)).resolves.toMatchObject({
      metadata: { id: first.id, sha256: first.sha256 },
    });

    await stores[2]!.delete(ownerId, first.id);
    await expect(stores[3]!.get(ownerId, first.id)).rejects.toMatchObject({
      code: "ARTIFACT_NOT_FOUND",
    });
  });

  it("renews a deduplicated reference from its acquisition time", async () => {
    const rootDirectory = await createStoreRoot();
    let now = new Date("2026-08-20T14:00:00.000Z");
    const firstStore = new RepositoryArtifactFileStore({
      clock: () => now,
      repositoryRoot,
      retentionMilliseconds: 1_000,
      rootDirectory,
    });
    const secondStore = new RepositoryArtifactFileStore({
      clock: () => now,
      repositoryRoot,
      retentionMilliseconds: 5_000,
      rootDirectory,
    });
    const first = await firstStore.put(ownerId, uploadInput);
    expect(first.expiresAt).toBe("2026-08-20T14:00:01.000Z");

    now = new Date("2026-08-20T14:00:00.900Z");
    const renewed = await secondStore.put(ownerId, uploadInput);
    expect(renewed).toMatchObject({
      createdAt: first.createdAt,
      expiresAt: "2026-08-20T14:00:05.900Z",
      id: first.id,
    });

    now = new Date("2026-08-20T14:00:01.001Z");
    await expect(firstStore.get(ownerId, first.id)).resolves.toMatchObject({
      metadata: renewed,
    });
  });

  it("requires a validated upload at the web seam and returns safe preview, download, and refresh responses", async () => {
    const rootDirectory = await createStoreRoot();
    const store = new RepositoryArtifactFileStore({ repositoryRoot, rootDirectory });
    const upload = await validateArtifactUploadWithScanner(
      uploadInput,
      new DeterministicDemoMalwareScanner(),
      { allowSimulatedClean: true },
    );
    const uploadResponse = await createValidatedArtifactUploadResponse(store, {
      ...webContext(),
      upload,
    });
    expect(uploadResponse.status).toBe(201);
    const uploadPayload = (await uploadResponse.json()) as {
      readonly artifact: { readonly id: string };
      readonly ok: boolean;
    };
    expect(uploadPayload.ok).toBe(true);

    const routeCases = [
      [createArtifactPreviewResponse, "inline"],
      [createArtifactDownloadResponse, "attachment"],
    ] as const;
    for (const [route, disposition] of routeCases) {
      const response = await route(store, {
        ...webContext(),
        artifactId: uploadPayload.artifact.id,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition")).toContain(disposition);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(JSON.stringify([...response.headers])).not.toContain(rootDirectory);
    }
    const refresh = await createArtifactRefreshResponse(store, {
      ...webContext(),
      artifactId: uploadPayload.artifact.id,
    });
    expect(refresh.status).toBe(200);
    expect(JSON.stringify(await refresh.json())).not.toContain(rootDirectory);
    expect(auditEvents.map(({ action, outcome }) => `${action}:${outcome}`)).toEqual([
      "upload:allowed",
      "preview:allowed",
      "download:allowed",
      "refresh:allowed",
    ]);
    expect(JSON.stringify(auditEvents)).not.toContain(rootDirectory);
  });

  it("removes a stored upload when the authoritative success audit fails", async () => {
    const rootDirectory = await createStoreRoot();
    const store = new RepositoryArtifactFileStore({ repositoryRoot, rootDirectory });
    const upload = await validateArtifactUploadWithScanner(
      uploadInput,
      new DeterministicDemoMalwareScanner(),
      { allowSimulatedClean: true },
    );

    const response = await createValidatedArtifactUploadResponse(store, {
      ...webContext(),
      audit: {
        async record() {
          throw new Error("simulated audit outage");
        },
      },
      upload,
    });

    expect(response.status).toBe(500);
    await expect(readdir(join(rootDirectory, "blobs"))).resolves.toEqual([]);
    await expect(readdir(join(rootDirectory, "manifests"))).resolves.toEqual([]);
  });

  it("releases only the failed upload lease when identical content already succeeded", async () => {
    const rootDirectory = await createStoreRoot();
    const store = new RepositoryArtifactFileStore({ repositoryRoot, rootDirectory });
    const upload = await validateArtifactUploadWithScanner(
      uploadInput,
      new DeterministicDemoMalwareScanner(),
      { allowSimulatedClean: true },
    );
    const successful = await createValidatedArtifactUploadResponse(store, {
      ...webContext(),
      upload,
    });
    const successfulPayload = (await successful.json()) as {
      readonly artifact: StoredArtifactFile;
    };

    const failed = await createValidatedArtifactUploadResponse(store, {
      ...webContext(),
      audit: {
        async record() {
          throw new Error("simulated later audit outage");
        },
      },
      upload,
    });

    expect(failed.status).toBe(500);
    await expect(store.get(ownerId, successfulPayload.artifact.id)).resolves.toMatchObject({
      metadata: {
        id: successfulPayload.artifact.id,
        sha256: successfulPayload.artifact.sha256,
      },
    });
  });

  it("returns the same non-enumerating 404 for cross-owner preview, download, and refresh", async () => {
    const rootDirectory = await createStoreRoot();
    const store = new RepositoryArtifactFileStore({ repositoryRoot, rootDirectory });
    const artifact = await store.put(ownerId, uploadInput);
    const expected = {
      error: { code: "ARTIFACT_NOT_FOUND", message: "Artifact was not found." },
      ok: false,
    };

    for (const route of [
      createArtifactPreviewResponse,
      createArtifactDownloadResponse,
      createArtifactRefreshResponse,
    ]) {
      const response = await route(store, {
        ...webContext({ actorId: otherOwnerId, ownerId }),
        artifactId: artifact.id,
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual(expected);
    }
    expect(auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "preview", outcome: "denied" }),
        expect.objectContaining({ action: "download", outcome: "denied" }),
        expect.objectContaining({ action: "refresh", outcome: "denied" }),
      ]),
    );
  });

  it("treats expired artifacts as the same non-enumerating 404 before cleanup", async () => {
    const rootDirectory = await createStoreRoot();
    let now = new Date("2026-08-20T14:00:00.000Z");
    const store = new RepositoryArtifactFileStore({
      clock: () => now,
      repositoryRoot,
      retentionMilliseconds: 1_000,
      rootDirectory,
    });
    const artifact = await store.put(ownerId, uploadInput);
    const unauthorized = await createArtifactPreviewResponse(store, {
      ...webContext({ actorId: otherOwnerId, ownerId }),
      artifactId: artifact.id,
    });
    const unauthorizedPayload = await unauthorized.json();

    now = new Date("2026-08-20T14:00:01.000Z");
    const expired = await createArtifactPreviewResponse(store, {
      ...webContext(),
      artifactId: artifact.id,
    });
    expect(expired.status).toBe(404);
    expect(await expired.json()).toEqual(unauthorizedPayload);
    expect(auditEvents.at(-1)).toMatchObject({ action: "preview", outcome: "unavailable" });
    const cleanup = await store.cleanupExpired();
    expect(cleanup).toEqual({ deletedIds: [artifact.id], failed: [] });
  });

  it("reports failed retention cleanup without exposing a path and succeeds on retry", async () => {
    const rootDirectory = await createStoreRoot();
    let now = new Date("2026-08-20T14:00:00.000Z");
    let failBlobDelete = true;
    const fileOperations: ArtifactFileOperations = {
      async mkdir(path) {
        await mkdir(path, { recursive: true });
      },
      mkdirExclusive,
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
        if (failBlobDelete && path.endsWith(".bin")) {
          failBlobDelete = false;
          throw new Error(`synthetic cleanup failure at ${path}`);
        }
        await unlink(path);
      },
      async writeFile(path, data) {
        await mkdir(dirname(path), { recursive: true });
        if (typeof data === "string") await writeFile(path, data, "utf8");
        else await writeFile(path, data);
      },
    };
    const store = new RepositoryArtifactFileStore({
      clock: () => now,
      fileOperations,
      repositoryRoot,
      retentionMilliseconds: 1_000,
      rootDirectory,
    });
    const artifact = await store.put(ownerId, uploadInput);
    now = new Date("2026-08-20T14:00:01.000Z");

    const failed = await store.cleanupExpired();
    expect(failed).toEqual({
      deletedIds: [],
      failed: [{ code: "delete-failed", id: artifact.id }],
    });
    expect(JSON.stringify(failed)).not.toContain(rootDirectory);
    await expect(store.cleanupExpired()).resolves.toEqual({
      deletedIds: [artifact.id],
      failed: [],
    });
  });

  it("sweeps expired files and crash orphans while preserving fresh and paired data", async () => {
    const rootDirectory = await createStoreRoot();
    let now = new Date(Date.now());
    const store = new RepositoryArtifactFileStore({
      clock: () => now,
      orphanGraceMilliseconds: 1_000,
      repositoryRoot,
      retentionMilliseconds: 60_000,
      rootDirectory,
    });
    const expired = await store.put(ownerId, uploadInput, { retentionMilliseconds: 1_000 });
    const live = await store.put(ownerId, {
      ...uploadInput,
      filename: "live-synthetic-observations.csv",
    });
    await store.initialize();

    const orphanBlobId = `art_${"b".repeat(32)}`;
    const orphanManifestId = `art_${"c".repeat(32)}`;
    const temporaryId = `art_${"d".repeat(32)}`;
    const freshOrphanId = `art_${"e".repeat(32)}`;
    const old = new Date(now.getTime() - 10_000);
    const orphanBlob = join(rootDirectory, "blobs", `${orphanBlobId}.bin`);
    const orphanManifest = join(rootDirectory, "manifests", `${orphanManifestId}.json`);
    const temporaryBlob = join(
      rootDirectory,
      "blobs",
      `${temporaryId}.bin.123-${"a".repeat(12)}.tmp`,
    );
    const temporaryManifest = join(
      rootDirectory,
      "manifests",
      `${temporaryId}.json.123-${"b".repeat(12)}.tmp`,
    );
    const freshOrphan = join(rootDirectory, "blobs", `${freshOrphanId}.bin`);
    await Promise.all([
      writeFile(orphanBlob, "old orphan blob"),
      writeFile(orphanManifest, "old orphan manifest"),
      writeFile(temporaryBlob, "old temporary blob"),
      writeFile(temporaryManifest, "old temporary manifest"),
      writeFile(freshOrphan, "fresh orphan blob"),
    ]);
    await Promise.all(
      [orphanBlob, orphanManifest, temporaryBlob, temporaryManifest].map((path) =>
        utimes(path, old, old),
      ),
    );

    now = new Date(now.getTime() + 2_000);
    await utimes(freshOrphan, now, now);
    const result = await store.runMaintenanceSweep();

    expect(result).toEqual({
      status: "completed",
      expired: { deletedIds: [expired.id], failed: [] },
      orphans: {
        deletedIds: [orphanBlobId, orphanManifestId],
        deletedInvalidMetadataIds: [],
        deletedTemporaryFiles: 2,
        failed: [],
      },
    });
    await expect(store.get(ownerId, live.id)).resolves.toMatchObject({ metadata: { id: live.id } });
    await expect(readFile(freshOrphan, "utf8")).resolves.toBe("fresh orphan blob");
  });

  it("skips a sweep owned by a live peer process without touching expired bytes", async () => {
    const rootDirectory = await createStoreRoot();
    let now = new Date(Date.now());
    const store = new RepositoryArtifactFileStore({
      clock: () => now,
      orphanGraceMilliseconds: 1_000,
      repositoryRoot,
      retentionMilliseconds: 1_000,
      rootDirectory,
    });
    const artifact = await store.put(ownerId, uploadInput);
    now = new Date(now.getTime() + 2_000);
    const lockDirectory = join(rootDirectory, "locks", "mutation.lock");
    await mkdir(lockDirectory);
    await writeFile(
      join(lockDirectory, "owner.json"),
      `${JSON.stringify({ createdAt: now.toISOString(), pid: process.pid, token: "a".repeat(24) })}\n`,
    );

    await expect(store.runMaintenanceSweep()).resolves.toEqual({
      status: "skipped-active",
      expired: { deletedIds: [], failed: [] },
      orphans: {
        deletedIds: [],
        deletedInvalidMetadataIds: [],
        deletedTemporaryFiles: 0,
        failed: [],
      },
    });
    await expect(
      readFile(join(rootDirectory, "blobs", `${artifact.id}.bin`)),
    ).resolves.toBeDefined();
  });

  it("reclaims a dead process lock before reconciling expired artifact data", async () => {
    const rootDirectory = await createStoreRoot();
    let now = new Date(Date.now());
    const store = new RepositoryArtifactFileStore({
      clock: () => now,
      orphanGraceMilliseconds: 1_000,
      processIsAlive: () => false,
      repositoryRoot,
      retentionMilliseconds: 1_000,
      rootDirectory,
    });
    const artifact = await store.put(ownerId, uploadInput);
    now = new Date(now.getTime() + 2_000);
    const lockDirectory = join(rootDirectory, "locks", "mutation.lock");
    await mkdir(lockDirectory);
    await writeFile(
      join(lockDirectory, "owner.json"),
      `${JSON.stringify({ createdAt: now.toISOString(), pid: 2_147_483_647, token: "b".repeat(24) })}\n`,
    );

    await expect(store.runMaintenanceSweep()).resolves.toEqual({
      status: "completed",
      expired: { deletedIds: [artifact.id], failed: [] },
      orphans: {
        deletedIds: [],
        deletedInvalidMetadataIds: [],
        deletedTemporaryFiles: 0,
        failed: [],
      },
    });
    await expect(readdir(join(rootDirectory, "locks"))).resolves.toEqual([]);
  });

  it("rejects invalid explicit or clock-derived maintenance dates before deleting data", async () => {
    const rootDirectory = await createStoreRoot();
    const store = new RepositoryArtifactFileStore({
      repositoryRoot,
      retentionMilliseconds: 1_000,
      rootDirectory,
    });
    const artifact = await store.put(ownerId, uploadInput);
    const invalidDate = new Date(Number.NaN);

    await expect(store.cleanupExpired(invalidDate)).rejects.toMatchObject({
      code: "INVALID_RETENTION",
    });
    await expect(store.runMaintenanceSweep(invalidDate)).rejects.toMatchObject({
      code: "INVALID_RETENTION",
    });
    const invalidClockStore = new RepositoryArtifactFileStore({
      clock: () => invalidDate,
      repositoryRoot,
      rootDirectory,
    });
    await expect(invalidClockStore.cleanupExpired()).rejects.toMatchObject({
      code: "INVALID_RETENTION",
    });
    await expect(invalidClockStore.runMaintenanceSweep()).rejects.toMatchObject({
      code: "INVALID_RETENTION",
    });
    await expect(
      readFile(join(rootDirectory, "blobs", `${artifact.id}.bin`)),
    ).resolves.toBeDefined();
    await expect(
      readFile(join(rootDirectory, "manifests", `${artifact.id}.json`)),
    ).resolves.toBeDefined();
  });

  it("reconciles only grace-aged strict-ID pairs with malformed metadata", async () => {
    const rootDirectory = await createStoreRoot();
    const now = new Date(Date.now());
    const store = new RepositoryArtifactFileStore({
      clock: () => now,
      orphanGraceMilliseconds: 1_000,
      repositoryRoot,
      rootDirectory,
    });
    await store.initialize();
    const oldId = `art_${"1".repeat(32)}`;
    const freshId = `art_${"2".repeat(32)}`;
    const oldBlob = join(rootDirectory, "blobs", `${oldId}.bin`);
    const oldManifest = join(rootDirectory, "manifests", `${oldId}.json`);
    const freshBlob = join(rootDirectory, "blobs", `${freshId}.bin`);
    const freshManifest = join(rootDirectory, "manifests", `${freshId}.json`);
    await Promise.all([
      writeFile(oldBlob, "old invalid pair"),
      writeFile(oldManifest, "{not valid metadata"),
      writeFile(freshBlob, "fresh invalid pair"),
      writeFile(freshManifest, "{not valid metadata"),
    ]);
    const old = new Date(now.getTime() - 10_000);
    await Promise.all([utimes(oldBlob, old, old), utimes(oldManifest, old, old)]);
    await Promise.all([utimes(freshBlob, now, now), utimes(freshManifest, now, now)]);

    const result = await store.runMaintenanceSweep();

    expect(result).toEqual({
      status: "completed",
      expired: {
        deletedIds: [],
        failed: [{ code: "invalid-metadata", id: freshId }],
      },
      orphans: {
        deletedIds: [],
        deletedInvalidMetadataIds: [oldId],
        deletedTemporaryFiles: 0,
        failed: [],
      },
    });
    await expect(readFile(oldBlob)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(oldManifest)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(freshBlob, "utf8")).resolves.toBe("fresh invalid pair");
    await expect(readFile(freshManifest, "utf8")).resolves.toBe("{not valid metadata");
  });

  it("preserves swapped valid manifests and their blobs as identity-mismatched data", async () => {
    const rootDirectory = await createStoreRoot();
    let now = new Date("2026-08-20T14:00:00.000Z");
    const store = new RepositoryArtifactFileStore({
      clock: () => now,
      orphanGraceMilliseconds: 1_000,
      repositoryRoot,
      retentionMilliseconds: 1_000,
      rootDirectory,
    });
    const first = await store.put(ownerId, uploadInput);
    const second = await store.put(ownerId, {
      ...uploadInput,
      filename: "second-synthetic-observations.csv",
    });
    const firstBlob = join(rootDirectory, "blobs", `${first.id}.bin`);
    const secondBlob = join(rootDirectory, "blobs", `${second.id}.bin`);
    const firstManifest = join(rootDirectory, "manifests", `${first.id}.json`);
    const secondManifest = join(rootDirectory, "manifests", `${second.id}.json`);
    const [firstManifestBytes, secondManifestBytes] = await Promise.all([
      readFile(firstManifest),
      readFile(secondManifest),
    ]);
    await Promise.all([
      writeFile(firstManifest, secondManifestBytes),
      writeFile(secondManifest, firstManifestBytes),
    ]);
    now = new Date(now.getTime() + 10_000);
    const old = new Date(now.getTime() - 5_000);
    await Promise.all([
      utimes(firstBlob, old, old),
      utimes(secondBlob, old, old),
      utimes(firstManifest, old, old),
      utimes(secondManifest, old, old),
    ]);
    const ids = [first.id, second.id].sort();

    const readFailure = await store.get(ownerId, first.id).catch((error: unknown) => error);
    expect(readFailure).toMatchObject({
      code: "ARTIFACT_STORE_FAILURE",
      message: "Artifact metadata is invalid.",
    });
    expect(JSON.stringify(readFailure)).not.toContain(rootDirectory);

    await expect(store.cleanupExpired()).resolves.toEqual({
      deletedIds: [],
      failed: ids.map((id) => ({ code: "invalid-metadata", id })),
    });
    await expect(store.runMaintenanceSweep()).resolves.toEqual({
      status: "completed",
      expired: {
        deletedIds: [],
        failed: ids.map((id) => ({ code: "invalid-metadata", id })),
      },
      orphans: {
        deletedIds: [],
        deletedInvalidMetadataIds: [],
        deletedTemporaryFiles: 0,
        failed: ids.map((id) => ({ code: "inspect-failed", id })),
      },
    });
    await expect(readFile(firstBlob)).resolves.toEqual(Buffer.from(uploadInput.bytes));
    await expect(readFile(secondBlob)).resolves.toEqual(Buffer.from(uploadInput.bytes));
    await expect(readFile(firstManifest)).resolves.toEqual(secondManifestBytes);
    await expect(readFile(secondManifest)).resolves.toEqual(firstManifestBytes);
  });

  it("fails safely when a deduplicated manifest exists without its blob", async () => {
    const rootDirectory = await createStoreRoot();
    const now = new Date(Date.now());
    const store = new RepositoryArtifactFileStore({
      clock: () => now,
      orphanGraceMilliseconds: 1_000,
      repositoryRoot,
      rootDirectory,
    });
    const artifact = await store.put(ownerId, uploadInput);
    const manifestPath = join(rootDirectory, "manifests", `${artifact.id}.json`);
    const blobPath = join(rootDirectory, "blobs", `${artifact.id}.bin`);
    const originalManifest = await readFile(manifestPath, "utf8");
    await unlink(blobPath);

    const failure = await store.put(ownerId, uploadInput).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "ARTIFACT_STORE_FAILURE",
      message: "Artifact content could not be verified safely.",
    });
    expect(JSON.stringify(failure)).not.toContain(rootDirectory);
    await expect(readFile(manifestPath, "utf8")).resolves.toBe(originalManifest);
    await expect(readFile(blobPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves an orphan leaf when filesystem modification time is non-finite", async () => {
    const rootDirectory = await createStoreRoot();
    const orphanId = `art_${"3".repeat(32)}`;
    const orphanPath = join(rootDirectory, "blobs", `${orphanId}.bin`);
    const fileOperations: ArtifactFileOperations = {
      async mkdir(path) {
        await mkdir(path, { recursive: true });
      },
      mkdirExclusive,
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
        if (path === orphanPath) return { mtimeMs: Number.NaN };
        const value = await stat(path);
        return { mtimeMs: value.mtimeMs };
      },
      async unlink(path) {
        await unlink(path);
      },
      async writeFile(path, data) {
        if (typeof data === "string") await writeFile(path, data, "utf8");
        else await writeFile(path, data);
      },
    };
    const store = new RepositoryArtifactFileStore({
      fileOperations,
      orphanGraceMilliseconds: 1_000,
      repositoryRoot,
      rootDirectory,
    });
    await store.initialize();
    await writeFile(orphanPath, "preserve non-finite timestamp");

    const result = await store.runMaintenanceSweep();

    expect(result.orphans).toEqual({
      deletedIds: [],
      deletedInvalidMetadataIds: [],
      deletedTemporaryFiles: 0,
      failed: [{ code: "inspect-failed", id: orphanId }],
    });
    await expect(readFile(orphanPath, "utf8")).resolves.toBe("preserve non-finite timestamp");
  });

  it("removes temporary and committed bytes when artifact generation storage fails", async () => {
    const rootDirectory = await createStoreRoot();
    let failManifestCommit = true;
    const fileOperations: ArtifactFileOperations = {
      async mkdir(path) {
        await mkdir(path, { recursive: true });
      },
      mkdirExclusive,
      async readFile(path) {
        return readFile(path);
      },
      async readdir(path) {
        return readdir(path);
      },
      async rename(from, to) {
        if (failManifestCommit && to.endsWith(".json")) {
          failManifestCommit = false;
          throw new Error("synthetic manifest commit failure");
        }
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
        if (typeof data === "string") await writeFile(path, data, "utf8");
        else await writeFile(path, data);
      },
    };
    const store = new RepositoryArtifactFileStore({
      fileOperations,
      repositoryRoot,
      rootDirectory,
    });

    await expect(store.put(ownerId, uploadInput)).rejects.toThrowError(
      expect.objectContaining({ code: "ARTIFACT_STORE_FAILURE" }),
    );
    await expect(readdir(join(rootDirectory, "blobs"))).resolves.toEqual([]);
    await expect(readdir(join(rootDirectory, "manifests"))).resolves.toEqual([]);
  });

  itWithReparsePoints("rejects a symbolic-link or Windows reparse-point store escape", async () => {
    await mkdir(dataDirectory, { recursive: true });
    const outsideTarget = await mkdtemp(join(tmpdir(), "bea-artifact-escape-"));
    cleanupDirectories.push(outsideTarget);
    const link = join(dataDirectory, `artifact-store-link-${process.pid}-${Date.now()}`);
    await symlink(outsideTarget, link, process.platform === "win32" ? "junction" : "dir");
    cleanupLinks.push(link);

    expect(
      () => new RepositoryArtifactFileStore({ repositoryRoot, rootDirectory: link }),
    ).toThrowError(
      expect.objectContaining<Partial<ArtifactValidationError>>({ code: "INVALID_STORE_ROOT" }),
    );
  });

  itWithReparsePoints.each(["blobs", "manifests"])(
    "rejects an existing %s child-directory reparse escape before file access",
    async (childName) => {
      const rootDirectory = await createStoreRoot();
      const store = new RepositoryArtifactFileStore({ repositoryRoot, rootDirectory });
      const artifact = await store.put(ownerId, uploadInput);
      const childDirectory = join(rootDirectory, childName);
      await rename(childDirectory, `${childDirectory}-original`);

      const outsideTarget = await mkdtemp(join(tmpdir(), `bea-artifact-${childName}-escape-`));
      cleanupDirectories.push(outsideTarget);
      await symlink(
        outsideTarget,
        childDirectory,
        process.platform === "win32" ? "junction" : "dir",
      );
      cleanupLinks.push(childDirectory);

      await expect(store.get(ownerId, artifact.id)).rejects.toThrowError(
        expect.objectContaining<Partial<ArtifactValidationError>>({ code: "INVALID_STORE_ROOT" }),
      );
      await expect(readdir(outsideTarget)).resolves.toEqual([]);
    },
  );

  itWithReparsePoints.each([
    ["blobs", ".bin"],
    ["manifests", ".json"],
  ] as const)(
    "rejects an existing %s final-leaf reparse escape before file access",
    async (childName, extension) => {
      const rootDirectory = await createStoreRoot();
      const store = new RepositoryArtifactFileStore({ repositoryRoot, rootDirectory });
      const artifact = await store.put(ownerId, uploadInput);
      const leaf = join(rootDirectory, childName, `${artifact.id}${extension}`);
      await rename(leaf, `${leaf}-original`);

      const outsideTarget = await mkdtemp(join(tmpdir(), `bea-artifact-leaf-${childName}-`));
      cleanupDirectories.push(outsideTarget);
      await symlink(outsideTarget, leaf, process.platform === "win32" ? "junction" : "dir");
      cleanupLinks.push(leaf);

      await expect(store.get(ownerId, artifact.id)).rejects.toThrowError(
        expect.objectContaining<Partial<ArtifactValidationError>>({ code: "INVALID_STORE_ROOT" }),
      );
      await expect(readdir(outsideTarget)).resolves.toEqual([]);
    },
  );
});
