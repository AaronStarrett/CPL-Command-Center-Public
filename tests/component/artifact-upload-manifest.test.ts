import { describe, expect, it } from "vitest";

import { createUploadedArtifactManifest } from "../../apps/web/lib/artifact-upload-manifest";
import type { StoredArtifactFile } from "../../packages/artifacts/src/index.js";

const ownerId = "10000000-0000-4000-8000-000000000001";
const baseFile: StoredArtifactFile = {
  createdAt: "2026-08-20T14:00:00.000Z",
  expiresAt: "2026-09-19T14:00:00.000Z",
  filename: "owner-upload.pdf",
  id: "art_0123456789abcdef0123456789abcdef",
  mimeType: "application/pdf",
  sha256: "a".repeat(64),
  size: 256,
};

describe("restricted upload normalized manifests", () => {
  it.each([
    ["application/pdf", "owner-upload.pdf", "pdf", undefined],
    ["image/png", "owner-upload.png", "image", undefined],
    ["text/csv", "owner-upload.csv", "data", "csv"],
    ["text/plain", "owner-upload.txt", "data", "txt"],
    [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "owner-upload.docx",
      "data",
      "docx",
    ],
    [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "owner-upload.xlsx",
      "data",
      "xlsx",
    ],
  ] as const)("maps %s to the controlled %s renderer", (mimeType, filename, renderer, format) => {
    const manifest = createUploadedArtifactManifest({ ...baseFile, filename, mimeType }, ownerId);

    expect(manifest.renderer).toBe(renderer);
    if (manifest.renderer === "data") expect(manifest.data.format).toBe(format);
    expect(JSON.stringify(manifest)).not.toContain("expiresAt");
    expect(JSON.stringify(manifest)).not.toContain("file-preview");
    expect(JSON.stringify(manifest)).not.toContain("file-download");
  });

  it("rejects MIME types outside the restricted upload registry", () => {
    expect(() =>
      createUploadedArtifactManifest(
        { ...baseFile, filename: "owner-upload.gif", mimeType: "image/gif" },
        ownerId,
      ),
    ).toThrowError(/cannot be rendered safely/iu);
  });
});
