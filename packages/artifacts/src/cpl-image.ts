import { createHash } from "node:crypto";

import sharp from "sharp";

import { type ArtifactUploadInput } from "./contracts.js";
import { CPL_PHOTO_ANNOTATION_MAXIMUM_IMAGE_SIDE } from "./cpl-photo-annotations.js";
import { validateArtifactUpload } from "./uploads.js";

export const CPL_IMAGE_PIPELINE_VERSION = "cpl-image-v1-sharp-0.35.4";
export const CPL_IMAGE_LIMITS = Object.freeze({
  inputBytes: 12 * 1024 * 1024,
  pixels: 40_000_000,
  side: CPL_PHOTO_ANNOTATION_MAXIMUM_IMAGE_SIDE,
  thumbnailSide: 480,
  reportSide: 2_400,
  outputBytes: 64 * 1024 * 1024,
  active: 2,
  queued: 4,
  queueWaitMilliseconds: 10_000,
  decodeSeconds: 15,
});

export class CplImageError extends Error {
  constructor(
    readonly code:
      | "CPL_IMAGE_INVALID_UPLOAD"
      | "CPL_IMAGE_DECODE_FAILED"
      | "CPL_IMAGE_LIMIT_EXCEEDED"
      | "CPL_IMAGE_BUSY"
      | "CPL_IMAGE_QUEUE_TIMEOUT"
      | "CPL_IMAGE_INVALID_ANNOTATIONS",
  ) {
    super(code);
    this.name = "CplImageError";
  }
}

function fail(code: CplImageError["code"]): never {
  throw new CplImageError(code);
}

/** The queue bounds both native work and retained input bytes. A running task keeps
 * its slot until it actually settles; a timeout must never release a live decoder. */
export class CplImageWorkQueue {
  #active = 0;
  readonly #waiting: Array<{ start: () => void }> = [];

  constructor(
    private readonly limits: {
      readonly active: number;
      readonly queued: number;
      readonly waitMilliseconds: number;
    } = {
      active: CPL_IMAGE_LIMITS.active,
      queued: CPL_IMAGE_LIMITS.queued,
      waitMilliseconds: CPL_IMAGE_LIMITS.queueWaitMilliseconds,
    },
  ) {
    if (
      !Number.isSafeInteger(limits.active) ||
      limits.active < 1 ||
      limits.active > CPL_IMAGE_LIMITS.active ||
      !Number.isSafeInteger(limits.queued) ||
      limits.queued < 0 ||
      limits.queued > CPL_IMAGE_LIMITS.queued ||
      !Number.isSafeInteger(limits.waitMilliseconds) ||
      limits.waitMilliseconds < 1 ||
      limits.waitMilliseconds > CPL_IMAGE_LIMITS.queueWaitMilliseconds
    )
      fail("CPL_IMAGE_LIMIT_EXCEEDED");
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#active >= this.limits.active && this.#waiting.length >= this.limits.queued)
      return Promise.reject(new CplImageError("CPL_IMAGE_BUSY"));
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const entry = {
        start: () => {
          if (timer) clearTimeout(timer);
          this.#active += 1;
          void Promise.resolve()
            .then(operation)
            .then(resolve, reject)
            .finally(() => {
              this.#active -= 1;
              this.#waiting.shift()?.start();
            });
        },
      };
      if (this.#active < this.limits.active) entry.start();
      else {
        this.#waiting.push(entry);
        timer = setTimeout(() => {
          const index = this.#waiting.indexOf(entry);
          if (index < 0) return;
          this.#waiting.splice(index, 1);
          reject(new CplImageError("CPL_IMAGE_QUEUE_TIMEOUT"));
        }, this.limits.waitMilliseconds);
      }
    });
  }
}

export interface CplImageDerivative {
  readonly kind: "thumbnail" | "report";
  readonly mimeType: "image/png";
  readonly width: number;
  readonly height: number;
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly sha256: string;
  readonly pipelineVersion: typeof CPL_IMAGE_PIPELINE_VERSION;
}

export interface CplProcessedImage {
  readonly original: {
    readonly bytes: Uint8Array;
    readonly filename: string;
    readonly mimeType: "image/png" | "image/jpeg";
    readonly sha256: string;
    readonly byteLength: number;
    readonly width: number;
    readonly height: number;
    readonly exifOrientation: number | null;
  };
  readonly upright: { readonly width: number; readonly height: number };
  readonly thumbnail: CplImageDerivative;
  readonly report: CplImageDerivative;
}

const queue = new CplImageWorkQueue();
const decoderOptions = Object.freeze({
  failOn: "warning" as const,
  limitInputPixels: CPL_IMAGE_LIMITS.pixels,
  limitInputChannels: 4,
  unlimited: false,
  sequentialRead: true,
  animated: false,
});

function inspectPngContainer(bytes: Buffer): void {
  let cursor = 8;
  let chunks = 0;
  while (cursor + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(cursor);
    const kind = bytes.toString("ascii", cursor + 4, cursor + 8);
    if (++chunks > 4096 || length > bytes.length - cursor - 12) fail("CPL_IMAGE_INVALID_UPLOAD");
    if (["acTL", "fcTL", "fdAT"].includes(kind)) fail("CPL_IMAGE_INVALID_UPLOAD");
    if (chunks === 1) {
      if (kind !== "IHDR" || length !== 13) fail("CPL_IMAGE_INVALID_UPLOAD");
      const width = bytes.readUInt32BE(cursor + 8),
        height = bytes.readUInt32BE(cursor + 12);
      if (
        !width ||
        !height ||
        width > CPL_IMAGE_LIMITS.side ||
        height > CPL_IMAGE_LIMITS.side ||
        width * height > CPL_IMAGE_LIMITS.pixels
      )
        fail("CPL_IMAGE_LIMIT_EXCEEDED");
    }
    cursor += length + 12;
    if (kind === "IEND") {
      if (length !== 0 || cursor !== bytes.length) fail("CPL_IMAGE_INVALID_UPLOAD");
      return;
    }
  }
  fail("CPL_IMAGE_INVALID_UPLOAD");
}

/** Server-only native module: import dynamically from the local storage adapter,
 * never from an Edge/Worker barrel. Original bytes are not rewritten or stripped.
 * Decoding is format validation, not a malware scan. */
function imageInput(input: ArtifactUploadInput) {
  if (
    !input ||
    !(input.bytes instanceof Uint8Array) ||
    input.bytes.length > CPL_IMAGE_LIMITS.inputBytes ||
    typeof input.mimeType !== "string" ||
    !["image/png", "image/jpeg"].includes(input.mimeType.toLowerCase())
  )
    fail("CPL_IMAGE_INVALID_UPLOAD");
  let upload;
  try {
    upload = validateArtifactUpload({ ...input, bytes: Uint8Array.from(input.bytes) });
  } catch {
    fail("CPL_IMAGE_INVALID_UPLOAD");
  }
  const originalBytes = Buffer.from(upload.bytes);
  if (upload.mimeType === "image/png") inspectPngContainer(originalBytes);
  return { upload, originalBytes };
}

async function decodeOriginal({ upload, originalBytes }: ReturnType<typeof imageInput>) {
  try {
    const decoder = sharp(originalBytes, decoderOptions).timeout({
      seconds: CPL_IMAGE_LIMITS.decodeSeconds,
    });
    const metadata = await decoder.metadata();
    const expectedFormat = upload.mimeType === "image/jpeg" ? "jpeg" : "png";
    if (metadata.format !== expectedFormat || (metadata.pages ?? 1) !== 1)
      fail("CPL_IMAGE_INVALID_UPLOAD");
    const { width, height } = metadata;
    if (
      !width ||
      !height ||
      width > CPL_IMAGE_LIMITS.side ||
      height > CPL_IMAGE_LIMITS.side ||
      width * height > CPL_IMAGE_LIMITS.pixels
    )
      fail("CPL_IMAGE_LIMIT_EXCEEDED");
    // Decode every pixel before resizing; header inspection or a tiny thumbnail
    // alone cannot establish that the original is decodable. One upright source
    // supplies both derivatives, so report quality never depends on a thumbnail.
    const decoded = await decoder
      .autoOrient()
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const upright = { width: decoded.info.width, height: decoded.info.height };
    return {
      original: {
        bytes: originalBytes,
        filename: upload.filename,
        mimeType: upload.mimeType as "image/png" | "image/jpeg",
        sha256: upload.sha256,
        byteLength: originalBytes.length,
        width,
        height,
        exifOrientation: metadata.orientation ?? null,
      },
      upright,
      decoded,
    };
  } catch (error) {
    if (error instanceof CplImageError) throw error;
    fail("CPL_IMAGE_DECODE_FAILED");
  }
}

/** Full native validation before durable original storage. No derivative encoder
 * runs here. Callers can preserve the valid original even when derivation fails. */
export async function validateCplImageOriginal(input: ArtifactUploadInput): Promise<{
  readonly original: CplProcessedImage["original"];
  readonly upright: CplProcessedImage["upright"];
}> {
  const prepared = imageInput(input);
  return queue.run(async () => {
    const { original, upright } = await decodeOriginal(prepared);
    return { original, upright };
  });
}

export async function processCplImage(input: ArtifactUploadInput): Promise<CplProcessedImage> {
  const prepared = imageInput(input);
  return queue.run(async () => {
    try {
      const { original, upright, decoded } = await decodeOriginal(prepared);
      const derivative = async (
        kind: CplImageDerivative["kind"],
        side: number,
      ): Promise<CplImageDerivative> => {
        const result = await sharp(decoded.data, {
          raw: { ...upright, channels: 4 },
          limitInputPixels: CPL_IMAGE_LIMITS.pixels,
        })
          .resize({ width: side, height: side, fit: "inside", withoutEnlargement: true })
          .png({ compressionLevel: 6, adaptiveFiltering: false, palette: false })
          .timeout({ seconds: CPL_IMAGE_LIMITS.decodeSeconds })
          .toBuffer({ resolveWithObject: true });
        if (
          result.data.length > CPL_IMAGE_LIMITS.outputBytes ||
          result.info.width > side ||
          result.info.height > side
        )
          fail("CPL_IMAGE_LIMIT_EXCEEDED");
        return {
          kind,
          mimeType: "image/png",
          width: result.info.width,
          height: result.info.height,
          bytes: result.data,
          byteLength: result.data.length,
          sha256: createHash("sha256").update(result.data).digest("hex"),
          pipelineVersion: CPL_IMAGE_PIPELINE_VERSION,
        };
      };
      const thumbnail = await derivative("thumbnail", CPL_IMAGE_LIMITS.thumbnailSide);
      const report = await derivative("report", CPL_IMAGE_LIMITS.reportSide);
      return {
        original,
        upright,
        thumbnail,
        report,
      };
    } catch (error) {
      if (error instanceof CplImageError) throw error;
      fail("CPL_IMAGE_DECODE_FAILED");
    }
  });
}

export * from "./cpl-photo-annotations.js";
