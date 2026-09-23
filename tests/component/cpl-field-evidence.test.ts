// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlCplFieldRepository } from "@bea/database/hosted";
import type { CplFieldPhotoTransfer } from "@bea/domain/cpl-field";
const image = vi.hoisted(() => ({ validate: vi.fn(), process: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@bea/artifacts/cpl-image", () => ({
  validateCplImageOriginal: image.validate,
  processCplImage: image.process,
}));
import { prepareCplPhoto } from "../../apps/web/lib/cpl-field-evidence";
const scope = {
  sessionToken: "server-session",
  organizationId: "organization",
  projectId: "project",
  visitId: "visit",
};
const original = {
  organizationId: scope.organizationId,
  objectId: "original",
  sha256: "a".repeat(64),
  byteLength: 3,
};
const bytes = new Uint8Array([1, 2, 3]);
function transfer(state = "reserved", revision = 1, width: number | null = null) {
  return {
    original,
    thumbnailObjectId: "thumbnail",
    reportObjectId: "report",
    photo: {
      id: "photo",
      state,
      revision,
      original: { filename: "fictional.png", mimeType: "image/png", width },
    },
  } as unknown as CplFieldPhotoTransfer;
}
function fixture() {
  const repository = {
    recordPhotoOriginal: vi.fn().mockResolvedValue(transfer("original_ready", 2, 10)),
    beginPhotoProcessing: vi
      .fn()
      .mockResolvedValue({ ...transfer("processing", 3, 10), processingToken: "private-claim" }),
    completePhoto: vi.fn().mockResolvedValue(transfer("ready", 4, 10)),
    failPhoto: vi.fn().mockResolvedValue(transfer("failed", 4, 10)),
  };
  const storage = {
    getVerified: vi.fn().mockResolvedValue(bytes),
    putImmutable: vi.fn().mockResolvedValue({ ...original, created: true }),
  };
  const run = (initial = transfer(), key = "retry-request") =>
    prepareCplPhoto(repository as unknown as SqlCplFieldRepository, scope, storage, initial, key);
  return { repository, storage, run };
}
describe("recoverable field photo orchestration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    const derivative = {
      bytes,
      sha256: "b".repeat(64),
      byteLength: 3,
      width: 10,
      height: 20,
      mimeType: "image/png",
      pipelineVersion: "test",
    };
    image.validate.mockResolvedValue({
      original: { width: 10, height: 20, exifOrientation: null },
      upright: { width: 10, height: 20 },
    });
    image.process.mockResolvedValue({ thumbnail: derivative, report: derivative });
  });
  it("publishes ready only after both immutable derivatives and the claimed SQL write", async () => {
    const f = fixture();
    expect((await f.run()).state).toBe("ready");
    expect(f.storage.getVerified).toHaveBeenCalledWith(original);
    expect(f.storage.putImmutable.mock.calls.map(([v]) => v.objectId)).toEqual([
      "thumbnail",
      "report",
    ]);
    expect(f.repository.completePhoto).toHaveBeenCalledWith(
      expect.objectContaining({ ...scope, photoId: "photo", processingToken: "private-claim" }),
    );
    expect(f.repository.completePhoto.mock.invocationCallOrder[0]).toBeGreaterThan(
      f.storage.putImmutable.mock.invocationCallOrder[1]!,
    );
    expect(f.repository.failPhoto).not.toHaveBeenCalled();
  });
  it("retains an original when native processing fails and succeeds on a later retry", async () => {
    const f = fixture();
    image.process.mockRejectedValueOnce(new Error("private decoder diagnostic"));
    expect((await f.run()).state).toBe("failed");
    expect(f.repository.failPhoto).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPhotoRevision: 3,
        processingToken: "private-claim",
        failureCode: "CPL_PHOTO_PROCESSING_FAILED",
      }),
    );
    expect(f.repository.completePhoto).not.toHaveBeenCalled();
    expect((await f.run(transfer("failed", 4, 10), "second-retry")).state).toBe("ready");
    expect(f.repository.recordPhotoOriginal).toHaveBeenCalledTimes(1);
    expect(f.storage.putImmutable.mock.calls.every(([v]) => v.objectId !== "original")).toBe(true);
  });
  it("leaves a partial derivative write recoverable without finalizing a ready image", async () => {
    const f = fixture();
    f.storage.putImmutable
      .mockResolvedValueOnce({ ...original, created: true })
      .mockRejectedValueOnce({ code: "CPL_EVIDENCE_STORAGE_UNAVAILABLE" });
    expect((await f.run()).state).toBe("failed");
    expect(f.repository.completePhoto).not.toHaveBeenCalled();
    expect(f.repository.failPhoto).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: "CPL_PHOTO_STORAGE_UNAVAILABLE" }),
    );
  });
  it("records unavailable originals without inventing their dimensions or processing them", async () => {
    const f = fixture();
    f.storage.getVerified.mockRejectedValue({ code: "CPL_EVIDENCE_NOT_FOUND" });
    expect((await f.run()).state).toBe("failed");
    expect(f.repository.failPhoto).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPhotoRevision: 1,
        failureCode: "CPL_PHOTO_ORIGINAL_UNAVAILABLE",
      }),
    );
    expect(image.validate).not.toHaveBeenCalled();
    expect(image.process).not.toHaveBeenCalled();
  });
  it.each([
    "CPL_ACCESS_DENIED",
    "CPL_FIELD_VERSION_CONFLICT",
    "CPL_ORGANIZATION_INACTIVE",
    "CPL_SESSION_INVALID",
  ])("does not convert %s into a saved failure", async (code) => {
    const f = fixture();
    f.repository.beginPhotoProcessing.mockRejectedValue({ code });
    await expect(f.run()).rejects.toEqual({ code });
    expect(f.repository.failPhoto).not.toHaveBeenCalled();
    expect(image.process).not.toHaveBeenCalled();
  });
  it("propagates a lost final SQL response and retries without overwriting stored bytes", async () => {
    const f = fixture();
    f.repository.completePhoto.mockRejectedValueOnce({ code: "CPL_FIELD_VERSION_CONFLICT" });
    await expect(f.run()).rejects.toEqual({ code: "CPL_FIELD_VERSION_CONFLICT" });
    expect(f.repository.failPhoto).not.toHaveBeenCalled();
    const writes = f.storage.putImmutable.mock.calls.length;
    expect((await f.run(transfer("ready", 4, 10))).state).toBe("ready");
    expect(f.storage.putImmutable).toHaveBeenCalledTimes(writes);
  });
});
