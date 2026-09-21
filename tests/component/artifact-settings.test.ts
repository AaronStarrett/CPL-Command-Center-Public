import { describe, expect, it } from "vitest";

import {
  effectiveArtifactRetentionMilliseconds,
  effectiveArtifactUploadBytes,
  effectiveArtifactUploadRateLimit,
  effectiveGeneratedArtifactBytes,
} from "../../apps/web/lib/artifact-settings";

describe("artifact administration settings enforcement", () => {
  it("uses the strictest bounded upload and generated-file limits", () => {
    expect(effectiveArtifactUploadBytes(8_000_000)).toBe(8_000_000);
    expect(effectiveArtifactUploadBytes(512_000_000)).toBe(12 * 1024 * 1024);
    expect(effectiveArtifactUploadBytes(Number.NaN)).toBe(1_024);
    expect(effectiveGeneratedArtifactBytes(25_000_000)).toBe(25_000_000);
    expect(effectiveGeneratedArtifactBytes(250_000_000)).toBe(100_000_000);
    expect(effectiveGeneratedArtifactBytes(Number.NaN)).toBe(1_024);
  });

  it("bounds retention and upload request rate without disabling either control", () => {
    expect(effectiveArtifactRetentionMilliseconds(30)).toBe(30 * 24 * 60 * 60 * 1_000);
    expect(effectiveArtifactRetentionMilliseconds(0)).toBe(24 * 60 * 60 * 1_000);
    expect(effectiveArtifactRetentionMilliseconds(365)).toBe(90 * 24 * 60 * 60 * 1_000);
    expect(effectiveArtifactUploadRateLimit(0)).toBe(1);
    expect(effectiveArtifactUploadRateLimit(10)).toBe(10);
    expect(effectiveArtifactUploadRateLimit(1_000)).toBe(12);
  });
});
