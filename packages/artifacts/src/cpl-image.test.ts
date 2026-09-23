import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import {
  CPL_IMAGE_LIMITS,
  CplImageWorkQueue,
  processCplImage,
  validateCplImageOriginal,
} from "./cpl-image";

const png = (width = 24, height = 12) =>
  sharp({
    create: { width, height, channels: 4, background: { r: 20, g: 150, b: 210, alpha: 0.5 } },
  })
    .png()
    .toBuffer();
const upload = (bytes: Uint8Array, filename = "site-photo.png", mimeType = "image/png") => ({
  filename,
  mimeType,
  bytes,
});
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("bounded original-preserving image processing", () => {
  it("makes a fully decoded original available before an independent derivative encoder failure", async () => {
    const bytes = await png();
    const validated = await validateCplImageOriginal(upload(bytes));
    expect(validated.original.bytes).toEqual(bytes);
    expect(validated.original.sha256).toBe(sha(bytes));
    expect(validated.upright).toEqual({ width: 24, height: 12 });
    const encoder = vi.spyOn(sharp.prototype, "png").mockImplementation(() => {
      throw new Error("encoder unavailable");
    });
    try {
      await expect(processCplImage(upload(bytes))).rejects.toMatchObject({
        code: "CPL_IMAGE_DECODE_FAILED",
      });
      expect(validated.original.bytes).toEqual(bytes);
    } finally {
      encoder.mockRestore();
    }
    await expect(validateCplImageOriginal(upload(bytes.subarray(0, 40)))).rejects.toMatchObject({
      code: "CPL_IMAGE_INVALID_UPLOAD",
    });
  });
  it("fully decodes PNG, preserves original bytes/transparency and produces deterministic stripped PNG derivatives", async () => {
    const bytes = await sharp(await png())
      .withMetadata({ orientation: 1 })
      .png()
      .toBuffer();
    const first = await processCplImage(upload(bytes)),
      second = await processCplImage(upload(bytes));
    expect(first.original.bytes).toEqual(bytes);
    expect(first.original.sha256).toBe(sha(bytes));
    expect(first.upright).toEqual({ width: 24, height: 12 });
    for (const kind of ["thumbnail", "report"] as const) {
      expect(first[kind].bytes).toEqual(second[kind].bytes);
      expect(first[kind].sha256).toBe(sha(first[kind].bytes));
      const metadata = await sharp(first[kind].bytes).metadata();
      expect(metadata).toMatchObject({ format: "png", width: 24, height: 12, hasAlpha: true });
      for (const key of ["exif", "icc", "iptc", "xmp", "orientation"] as const)
        expect(metadata[key]).toBeUndefined();
      expect(first[kind].byteLength).toBeLessThanOrEqual(CPL_IMAGE_LIMITS.outputBytes);
    }
    const pixels = await sharp(first.report.bytes).raw().toBuffer();
    expect(pixels[3]).toBeGreaterThan(0);
    expect(pixels[3]).toBeLessThan(255);
  });
  it("uses native EXIF orientation for JPEG and keeps the original oriented metadata intact", async () => {
    const bytes = await sharp({ create: { width: 60, height: 20, channels: 3, background: "red" } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const result = await processCplImage(upload(bytes, "portrait.jpeg", "image/jpeg"));
    expect(result.original).toMatchObject({
      width: 60,
      height: 20,
      exifOrientation: 6,
      sha256: sha(bytes),
    });
    expect(result.original.bytes).toEqual(bytes);
    expect(result.upright).toEqual({ width: 20, height: 60 });
    expect(await sharp(result.report.bytes).metadata()).toMatchObject({ width: 20, height: 60 });
    expect((await sharp(result.report.bytes).metadata()).orientation).toBeUndefined();
  });
  it("derives proportionate bounded report and thumbnail independently without upscaling or cropping", async () => {
    const result = await processCplImage(upload(await png(3000, 1000)));
    expect(result.thumbnail).toMatchObject({ width: 480, height: 160 });
    expect(result.report).toMatchObject({ width: 2400, height: 800 });
    expect(result.report.width).toBeGreaterThan(result.thumbnail.width);
    expect(result.original).toMatchObject({ width: 3000, height: 1000 });
  });
  it.each([
    [2, [0, 255, 0]],
    [6, [0, 0, 255]],
    [8, [0, 255, 0]],
  ] as const)(
    "places actual JPEG pixels upright for EXIF orientation %i",
    async (orientation, expected) => {
      const pixels = Buffer.alloc(60 * 40 * 3);
      for (let y = 0; y < 40; y++)
        for (let x = 0; x < 60; x++) {
          const color =
            y < 20 ? (x < 30 ? [255, 0, 0] : [0, 255, 0]) : x < 30 ? [0, 0, 255] : [255, 255, 0];
          pixels.set(color, (y * 60 + x) * 3);
        }
      const bytes = await sharp(pixels, { raw: { width: 60, height: 40, channels: 3 } })
        .withMetadata({ orientation })
        .jpeg({ quality: 100, chromaSubsampling: "4:4:4" })
        .toBuffer();
      const result = await processCplImage(upload(bytes, "orientation.jpg", "image/jpeg"));
      const actual = await sharp(result.report.bytes)
        .extract({ left: 5, top: 5, width: 1, height: 1 })
        .raw()
        .toBuffer();
      expected.forEach((channel, index) =>
        expect(Math.abs(actual[index]! - channel)).toBeLessThan(5),
      );
      expect(result.original.bytes).toEqual(bytes);
    },
  );
  it.each([
    ["../escape.png", "image/png"],
    ["bad.jpg", "image/png"],
    ["photo.png", "image/jpeg"],
    ["CON.png", "image/png"],
    ["photo.svg", "image/svg+xml"],
  ])("refuses filename/MIME/magic mismatch %s %s", async (filename, mimeType) => {
    await expect(processCplImage(upload(await png(), filename, mimeType))).rejects.toMatchObject({
      code: "CPL_IMAGE_INVALID_UPLOAD",
    });
  });
  it("rejects a signature-valid but truncated JPEG through full native decoding", async () => {
    const bytes = await sharp(await png(300, 200))
      .jpeg()
      .toBuffer();
    await expect(
      processCplImage(upload(bytes.subarray(0, bytes.length - 40), "broken.jpg", "image/jpeg")),
    ).rejects.toMatchObject({ code: "CPL_IMAGE_DECODE_FAILED" });
  });
  it("refuses native side/pixel bombs and excessive upload bytes", async () => {
    await expect(processCplImage(upload(await png(16_385, 1)))).rejects.toMatchObject({
      code: "CPL_IMAGE_LIMIT_EXCEEDED",
    });
    // Native metadata reads are bounded by the configured pixel limit before decode.
    await expect(processCplImage(upload(await png(6500, 6500)))).rejects.toMatchObject({
      code: "CPL_IMAGE_LIMIT_EXCEEDED",
    });
    await expect(
      processCplImage(upload(new Uint8Array(CPL_IMAGE_LIMITS.inputBytes + 1))),
    ).rejects.toMatchObject({ code: "CPL_IMAGE_INVALID_UPLOAD" });
  });
  it("refuses animated PNG container chunks even if a native decoder would expose only frame one", async () => {
    const bytes = await png();
    const animation = Buffer.alloc(20);
    animation.writeUInt32BE(8, 0);
    animation.write("acTL", 4, "ascii");
    animation.writeUInt32BE(2, 8);
    const animated = Buffer.concat([bytes.subarray(0, 33), animation, bytes.subarray(33)]);
    await expect(processCplImage(upload(animated))).rejects.toMatchObject({
      code: "CPL_IMAGE_INVALID_UPLOAD",
    });
  });
});

describe("image admission queue", () => {
  it("bounds active and queued work and retains a live decoder slot until settlement", async () => {
    const queue = new CplImageWorkQueue({ active: 1, queued: 1, waitMilliseconds: 1000 });
    let release!: () => void;
    const order: string[] = [];
    const first = queue.run(async () => {
      order.push("first");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return 1;
    });
    const second = queue.run(async () => {
      order.push("second");
      return 2;
    });
    await expect(queue.run(async () => 3)).rejects.toMatchObject({ code: "CPL_IMAGE_BUSY" });
    expect(order).toEqual(["first"]);
    release();
    expect(await first).toBe(1);
    expect(await second).toBe(2);
    expect(order).toEqual(["first", "second"]);
  });
  it("expires queued work without executing it or releasing the active operation", async () => {
    const queue = new CplImageWorkQueue({ active: 1, queued: 1, waitMilliseconds: 10 });
    let release!: () => void;
    let ran = false;
    const first = queue.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await expect(
      queue.run(async () => {
        ran = true;
      }),
    ).rejects.toMatchObject({ code: "CPL_IMAGE_QUEUE_TIMEOUT" });
    expect(ran).toBe(false);
    const third = queue.run(async () => 3);
    await expect(queue.run(async () => 4)).rejects.toMatchObject({ code: "CPL_IMAGE_BUSY" });
    release();
    await first;
    expect(await third).toBe(3);
  });
  it("continues after a decoder rejection and refuses bounds above the global policy", async () => {
    const queue = new CplImageWorkQueue({ active: 1, queued: 1, waitMilliseconds: 1000 });
    await expect(
      queue.run(async () => {
        throw new Error("decoder failed");
      }),
    ).rejects.toThrow("decoder failed");
    expect(await queue.run(async () => 2)).toBe(2);
    expect(() => new CplImageWorkQueue({ active: 3, queued: 1, waitMilliseconds: 1000 })).toThrow();
  });
});
