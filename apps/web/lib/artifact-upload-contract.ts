const conversationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const ARTIFACT_MULTIPART_OVERHEAD_BYTES = 128 * 1024;

export type ArtifactUploadTransportValidation =
  | { readonly ok: true; readonly contentLength: number }
  | { readonly ok: false; readonly reason: "invalid" | "missing" | "too_large" };

export function validateArtifactUploadTransport(
  contentLengthHeader: string | null,
  maxUploadBytes: number,
): ArtifactUploadTransportValidation {
  if (contentLengthHeader === null || contentLengthHeader.trim() === "") {
    return { ok: false, reason: "missing" };
  }
  const normalized = contentLengthHeader.trim();
  if (!/^[1-9][0-9]*$/u.test(normalized)) return { ok: false, reason: "invalid" };
  const contentLength = Number(normalized);
  if (
    !Number.isSafeInteger(contentLength) ||
    !Number.isSafeInteger(maxUploadBytes) ||
    maxUploadBytes < 1
  ) {
    return { ok: false, reason: "invalid" };
  }
  if (contentLength > maxUploadBytes + ARTIFACT_MULTIPART_OVERHEAD_BYTES) {
    return { ok: false, reason: "too_large" };
  }
  return { contentLength, ok: true };
}

export interface ArtifactUploadFileLike {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ParsedArtifactUploadForm {
  readonly conversationId: string;
  readonly file: ArtifactUploadFileLike;
}

export function isArtifactUploadFile(value: unknown): value is ArtifactUploadFileLike {
  return (
    value !== null &&
    typeof value === "object" &&
    "arrayBuffer" in value &&
    typeof value.arrayBuffer === "function" &&
    "name" in value &&
    typeof value.name === "string" &&
    "size" in value &&
    typeof value.size === "number" &&
    Number.isSafeInteger(value.size) &&
    "type" in value &&
    typeof value.type === "string"
  );
}

export function parseArtifactUploadForm(formData: FormData): ParsedArtifactUploadForm | null {
  const fileEntries = formData.getAll("file");
  const conversationEntries = formData.getAll("conversationId");
  const file = fileEntries[0] ?? null;
  const conversationId = conversationEntries[0];
  if (
    fileEntries.length !== 1 ||
    !isArtifactUploadFile(file) ||
    conversationEntries.length !== 1 ||
    typeof conversationId !== "string" ||
    !conversationIdPattern.test(conversationId.trim()) ||
    [...formData.keys()].some((key) => !(key === "file" || key === "conversationId"))
  ) {
    return null;
  }
  return { conversationId: conversationId.trim().toLowerCase(), file };
}
