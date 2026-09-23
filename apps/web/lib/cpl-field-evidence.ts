import "server-only";
import { createHash } from "node:crypto";
import type { SqlCplFieldRepository, CplTenantRequest } from "@bea/database/hosted";
import type { CplFieldPhotoTransfer } from "@bea/domain/cpl-field";
import type { CplEvidenceStorage } from "@bea/artifacts/cpl-evidence-store";
import type { CplProcessedImage } from "@bea/artifacts/cpl-image";

type Scope = CplTenantRequest & { projectId: string; visitId: string };
const key = (kind: string, value: string) =>
  `${kind}-${createHash("sha256").update(value).digest("hex")}`;

/** Authorization is repeated by every repository method. The transfer and claim
 * never leave this server boundary; clients cannot choose file references. */
export async function prepareCplPhoto(
  repository: SqlCplFieldRepository,
  scope: Scope,
  storage: CplEvidenceStorage,
  initial: CplFieldPhotoTransfer,
  requestKey: string,
  validatedOriginal?: Pick<CplProcessedImage, "original" | "upright">,
) {
  let transfer = initial;
  if (transfer.photo.state === "ready") return transfer.photo;
  let processingToken: string | undefined;
  try {
    const bytes = await storage.getVerified(transfer.original);
    const { validateCplImageOriginal, processCplImage } = await import("@bea/artifacts/cpl-image");
    const input = {
      bytes,
      filename: transfer.photo.original.filename,
      mimeType: transfer.photo.original.mimeType,
    };
    if (transfer.photo.original.width === null) {
      const validated = validatedOriginal ?? (await validateCplImageOriginal(input));
      transfer = await repository.recordPhotoOriginal({
        ...scope,
        photoId: transfer.photo.id,
        expectedPhotoRevision: transfer.photo.revision,
        idempotencyKey: key("photo-original", requestKey + transfer.photo.revision),
        original: {
          width: validated.original.width,
          height: validated.original.height,
          exifOrientation: validated.original.exifOrientation,
        },
        upright: validated.upright,
      });
    }
    if (transfer.photo.state === "ready") return transfer.photo;
    const claimed = await repository.beginPhotoProcessing({
      ...scope,
      photoId: transfer.photo.id,
      expectedPhotoRevision: transfer.photo.revision,
      idempotencyKey: key("photo-process", requestKey + transfer.photo.revision),
    });
    transfer = claimed;
    processingToken = claimed.processingToken;
    const image = await processCplImage(input);
    for (const [objectId, derivative] of [
      [transfer.thumbnailObjectId, image.thumbnail],
      [transfer.reportObjectId, image.report],
    ] as const)
      await storage.putImmutable({
        organizationId: scope.organizationId,
        objectId,
        sha256: derivative.sha256,
        bytes: derivative.bytes,
      });
    const metadata = (value: typeof image.thumbnail) => ({
      sha256: value.sha256,
      byteLength: value.byteLength,
      width: value.width,
      height: value.height,
      mimeType: "image/png" as const,
      pipelineVersion: value.pipelineVersion,
    });
    const ready = await repository.completePhoto({
      ...scope,
      photoId: transfer.photo.id,
      processingToken,
      idempotencyKey: key("photo-complete", processingToken),
      thumbnail: metadata(image.thumbnail),
      report: metadata(image.report),
    });
    return ready.photo;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (
      code.startsWith("CPL_FIELD_") ||
      code === "CPL_ACCESS_DENIED" ||
      code.startsWith("CPL_ORGANIZATION_") ||
      code.includes("SESSION")
    )
      throw error;
    const failureCode =
      code === "CPL_EVIDENCE_NOT_FOUND"
        ? "CPL_PHOTO_ORIGINAL_UNAVAILABLE"
        : code.startsWith("CPL_EVIDENCE_")
          ? "CPL_PHOTO_STORAGE_UNAVAILABLE"
          : "CPL_PHOTO_PROCESSING_FAILED";
    const failed = await repository.failPhoto({
      ...scope,
      photoId: transfer.photo.id,
      expectedPhotoRevision: transfer.photo.revision,
      ...(processingToken ? { processingToken } : {}),
      idempotencyKey: key(
        "photo-failed",
        requestKey + transfer.photo.revision + (processingToken ?? ""),
      ),
      failureCode,
    });
    return failed.photo;
  }
}
