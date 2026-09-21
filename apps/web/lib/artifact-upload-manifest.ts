import {
  ArtifactValidationError,
  normalizeArtifactManifest,
  type ArtifactManifest,
  type StoredArtifactFile,
} from "@bea/artifacts";

const imageMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const dataFormats = new Map<string, "csv" | "docx" | "txt" | "xlsx">([
  ["text/csv", "csv"],
  ["text/plain", "txt"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
]);

export function createUploadedArtifactManifest(
  artifact: StoredArtifactFile,
  ownerId: string,
): ArtifactManifest {
  const file = {
    filename: artifact.filename,
    id: artifact.id,
    mimeType: artifact.mimeType,
    sha256: artifact.sha256,
    size: artifact.size,
  };
  const base = {
    artifactId: artifact.id,
    citations: [],
    createdAt: artifact.createdAt,
    disclosure:
      "Owner-uploaded file accepted only after restricted type validation and malware scanning.",
    ownerId,
    schemaVersion: 1,
    summary: `Restricted owner upload: ${artifact.filename}`,
    title: artifact.filename,
  } as const;
  if (artifact.mimeType === "application/pdf") {
    return normalizeArtifactManifest({ ...base, file, renderer: "pdf" });
  }
  if (imageMimeTypes.has(artifact.mimeType)) {
    return normalizeArtifactManifest({
      ...base,
      altText: `Owner-uploaded image file ${artifact.filename}`,
      file,
      renderer: "image",
    });
  }
  const format = dataFormats.get(artifact.mimeType);
  if (format === undefined) {
    throw new ArtifactValidationError(
      "UNSUPPORTED_UPLOAD_MANIFEST",
      "Uploaded artifact MIME type cannot be rendered safely.",
    );
  }
  return normalizeArtifactManifest({
    ...base,
    data: { file, format, recordCount: 0 },
    renderer: "data",
  });
}
