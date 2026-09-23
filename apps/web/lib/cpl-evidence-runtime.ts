import "server-only";
import { createHash } from "node:crypto";
import type { CplEvidenceStorage } from "@bea/artifacts/cpl-evidence-store";
import {
  assertLocalDevelopmentRequest,
  readLocalDevelopmentConfiguration,
} from "@bea/security/hosted";

export const CPL_UPLOAD_MAXIMUM_BYTES = 12 * 1024 * 1024;
export class CplEvidenceRuntimeError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const refused = (code: string): never => {
  throw new CplEvidenceRuntimeError(code);
};

/** Provider selection is server configuration. Browser input never chooses a path
 * or turns on local authentication. Hosted storage remains a separate adapter. */
export async function cplEvidenceStorage(request: Request): Promise<CplEvidenceStorage> {
  if (process.env.CPL_LOCAL_DEVELOPMENT_AUTH !== "true")
    return refused("CPL_EVIDENCE_STORAGE_UNAVAILABLE");
  assertLocalDevelopmentRequest(request, readLocalDevelopmentConfiguration());
  const { CplEvidenceFileStore } = await import("@bea/artifacts/cpl-evidence-store");
  return new CplEvidenceFileStore({
    allowedRootDirectory: "D:\\Cyber Pirate Labs\\93_TOOLS_AND_CACHE\\CPL-Command-Center",
    rootDirectory:
      "D:\\Cyber Pirate Labs\\93_TOOLS_AND_CACHE\\CPL-Command-Center\\local-development\\evidence",
  });
}

/** Called only after session, CSRF and project/visit authorization. The raw stream
 * is bounded during reading, including requests without Content-Length. */
export async function cplImageUpload(request: Request) {
  const mimeType = request.headers.get("content-type")?.toLowerCase();
  if (mimeType !== "image/jpeg" && mimeType !== "image/png")
    return refused("CPL_IMAGE_UNSUPPORTED_TYPE");
  let filename: string;
  try {
    filename = decodeURIComponent(request.headers.get("x-cpl-filename") ?? "");
  } catch {
    return refused("CPL_IMAGE_INVALID_UPLOAD");
  }
  if (!filename || filename.length > 240 || /[\u0000-\u001f\u007f/\\]/u.test(filename))
    return refused("CPL_IMAGE_INVALID_UPLOAD");
  const idempotencyKey = request.headers.get("x-cpl-idempotency-key") ?? "";
  if (!/^[A-Za-z0-9_-]{8,120}$/u.test(idempotencyKey))
    return refused("CPL_INVALID_IDEMPOTENCY_KEY");
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > CPL_UPLOAD_MAXIMUM_BYTES))
    return refused("CPL_IMAGE_LIMIT_EXCEEDED");
  const reader = request.body?.getReader();
  if (!reader) return refused("CPL_IMAGE_INVALID_UPLOAD");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > CPL_UPLOAD_MAXIMUM_BYTES) {
        await reader.cancel();
        return refused("CPL_IMAGE_LIMIT_EXCEEDED");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size) return refused("CPL_IMAGE_INVALID_UPLOAD");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    filename,
    mimeType,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: size,
    idempotencyKey,
  };
}
