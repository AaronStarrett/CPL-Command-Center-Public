import { createHash } from "node:crypto";
import { basename, extname } from "node:path";

import {
  ArtifactValidationError,
  type ArtifactUploadInput,
  type MalwareScanResult,
  type MalwareScanner,
  type NormalizedArtifactUpload,
  type ValidatedArtifactUpload,
} from "./contracts.js";

export const MAXIMUM_ARTIFACT_UPLOAD_BYTES = 12 * 1024 * 1024;
export const MAXIMUM_GENERATED_ARTIFACT_BYTES = 100_000_000;
const filenamePattern = /^[^\u0000-\u001f<>:"/\\|?*]+$/u;
const reservedWindowsName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

interface UploadPolicy {
  readonly extensions: readonly string[];
  readonly mimeTypes: readonly string[];
  readonly signature: "jpeg" | "ooxml-sheet" | "ooxml-word" | "pdf" | "png" | "text" | "webp";
}

const uploadPolicies: readonly UploadPolicy[] = [
  {
    extensions: [".pdf"],
    mimeTypes: ["application/pdf"],
    signature: "pdf",
  },
  {
    extensions: [".csv"],
    mimeTypes: ["text/csv", "application/csv"],
    signature: "text",
  },
  {
    extensions: [".xlsx"],
    mimeTypes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    signature: "ooxml-sheet",
  },
  {
    extensions: [".txt"],
    mimeTypes: ["text/plain"],
    signature: "text",
  },
  {
    extensions: [".docx"],
    mimeTypes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    signature: "ooxml-word",
  },
  {
    extensions: [".png"],
    mimeTypes: ["image/png"],
    signature: "png",
  },
  {
    extensions: [".jpg", ".jpeg"],
    mimeTypes: ["image/jpeg"],
    signature: "jpeg",
  },
  {
    extensions: [".webp"],
    mimeTypes: ["image/webp"],
    signature: "webp",
  },
];

function bytesBeginWith(bytes: Uint8Array, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[index] === value);
}

const maximumOoxmlEntryCount = 2_048;
const maximumOoxmlEntryNameBytes = 512;
const maximumOoxmlTotalEntryNameBytes = 256 * 1024;

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const minimumOffset = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
    if (
      bytes[offset] === 0x50 &&
      bytes[offset + 1] === 0x4b &&
      bytes[offset + 2] === 0x05 &&
      bytes[offset + 3] === 0x06
    ) {
      return offset;
    }
  }
  return -1;
}

function safeOoxmlEntryName(name: string): boolean {
  if (
    name.length === 0 ||
    name.includes("\\") ||
    name.includes("\u0000") ||
    name.startsWith("/") ||
    /^[A-Za-z]:/u.test(name)
  ) {
    return false;
  }
  const segments = name.split("/");
  if (segments.at(-1) === "") segments.pop();
  return (
    segments.length > 0 &&
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function inspectOoxmlEntries(bytes: Uint8Array): readonly string[] | null {
  if (bytes.length < 22) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findEndOfCentralDirectory(bytes);
  if (endOffset < 0) return null;
  const diskNumber = view.getUint16(endOffset + 4, true);
  const centralDisk = view.getUint16(endOffset + 6, true);
  const diskEntryCount = view.getUint16(endOffset + 8, true);
  const totalEntryCount = view.getUint16(endOffset + 10, true);
  const centralSize = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    diskEntryCount !== totalEntryCount ||
    totalEntryCount < 1 ||
    totalEntryCount > maximumOoxmlEntryCount ||
    centralOffset + centralSize > endOffset
  ) {
    return null;
  }

  const names: string[] = [];
  const seen = new Set<string>();
  let cursor = centralOffset;
  let totalNameBytes = 0;
  try {
    for (let index = 0; index < totalEntryCount; index += 1) {
      if (
        cursor + 46 > centralOffset + centralSize ||
        view.getUint32(cursor, true) !== 0x02014b50
      ) {
        return null;
      }
      const flags = view.getUint16(cursor + 8, true);
      const compressionMethod = view.getUint16(cursor + 10, true);
      const nameLength = view.getUint16(cursor + 28, true);
      const extraLength = view.getUint16(cursor + 30, true);
      const commentLength = view.getUint16(cursor + 32, true);
      const localOffset = view.getUint32(cursor + 42, true);
      const next = cursor + 46 + nameLength + extraLength + commentLength;
      if (
        (flags & 0x0001) !== 0 ||
        !(compressionMethod === 0 || compressionMethod === 8) ||
        nameLength < 1 ||
        nameLength > maximumOoxmlEntryNameBytes ||
        next > centralOffset + centralSize
      ) {
        return null;
      }
      totalNameBytes += nameLength;
      if (totalNameBytes > maximumOoxmlTotalEntryNameBytes) return null;
      const name = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(cursor + 46, cursor + 46 + nameLength),
      );
      if (localOffset + 30 > centralOffset || view.getUint32(localOffset, true) !== 0x04034b50) {
        return null;
      }
      const localFlags = view.getUint16(localOffset + 6, true);
      const localMethod = view.getUint16(localOffset + 8, true);
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const localNameEnd = localOffset + 30 + localNameLength;
      if (
        localFlags !== flags ||
        localMethod !== compressionMethod ||
        localNameLength !== nameLength ||
        localNameEnd + localExtraLength > centralOffset ||
        !bytes
          .subarray(localOffset + 30, localNameEnd)
          .every((value, byteIndex) => value === bytes[cursor + 46 + byteIndex])
      ) {
        return null;
      }
      const canonicalName = name.toLowerCase();
      if (!safeOoxmlEntryName(name) || seen.has(canonicalName)) return null;
      if (canonicalName.endsWith("/vbaproject.bin") || canonicalName.includes("/embeddings/")) {
        return null;
      }
      seen.add(canonicalName);
      names.push(name);
      cursor = next;
    }
  } catch {
    return null;
  }
  return cursor === centralOffset + centralSize ? names : null;
}

function ooxmlPackageMatches(bytes: Uint8Array, kind: "sheet" | "word"): boolean {
  const names = inspectOoxmlEntries(bytes);
  if (!names) return false;
  const canonicalNames = names.map((name) => name.toLowerCase());
  const root = kind === "word" ? "word/" : "xl/";
  return (
    canonicalNames.includes("[content_types].xml") &&
    canonicalNames.some((name) => name.startsWith(root) && name.length > root.length)
  );
}

function signatureMatches(bytes: Uint8Array, signature: UploadPolicy["signature"]): boolean {
  switch (signature) {
    case "pdf":
      return bytesBeginWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]);
    case "png":
      return bytesBeginWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "jpeg":
      return bytesBeginWith(bytes, [0xff, 0xd8, 0xff]);
    case "webp":
      return (
        bytesBeginWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
        bytes.length >= 12 &&
        String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
      );
    case "ooxml-sheet":
      return ooxmlPackageMatches(bytes, "sheet");
    case "ooxml-word":
      return ooxmlPackageMatches(bytes, "word");
    case "text":
      if (bytes.includes(0)) return false;
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return true;
      } catch {
        return false;
      }
  }
}

function normalizeFilename(value: string): string {
  const filename = value.normalize("NFKC").trim();
  if (
    filename.length === 0 ||
    filename.length > 128 ||
    filename !== basename(filename) ||
    !filenamePattern.test(filename) ||
    filename.endsWith(".") ||
    filename.endsWith(" ") ||
    reservedWindowsName.test(filename)
  ) {
    throw new ArtifactValidationError("INVALID_FILENAME", "Artifact filename is not allowed.");
  }
  return filename;
}

function normalizeArtifactFile(
  input: ArtifactUploadInput,
  maximumBytes: number,
): NormalizedArtifactUpload {
  if (!(input.bytes instanceof Uint8Array)) {
    throw new ArtifactValidationError("INVALID_FILE", "Artifact content must be binary data.");
  }
  if (input.bytes.length === 0 || input.bytes.length > maximumBytes) {
    throw new ArtifactValidationError(
      "INVALID_FILE_SIZE",
      `Artifact size must be between 1 and ${maximumBytes} bytes.`,
    );
  }
  const filename = normalizeFilename(input.filename);
  const extension = extname(filename).toLowerCase();
  const mimeType = input.mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const policy = uploadPolicies.find(
    (candidate) =>
      candidate.extensions.includes(extension) && candidate.mimeTypes.includes(mimeType),
  );
  if (!policy) {
    throw new ArtifactValidationError(
      "UNSUPPORTED_FILE_TYPE",
      "Artifact extension and MIME type are not an approved combination.",
    );
  }
  if (!signatureMatches(input.bytes, policy.signature)) {
    throw new ArtifactValidationError(
      "FILE_SIGNATURE_MISMATCH",
      "Artifact content does not match its declared file type.",
    );
  }
  return {
    bytes: input.bytes,
    extension,
    filename,
    mimeType,
    sha256: createHash("sha256").update(input.bytes).digest("hex"),
    size: input.bytes.length,
  };
}

export function validateArtifactUpload(input: ArtifactUploadInput): NormalizedArtifactUpload {
  return normalizeArtifactFile(input, MAXIMUM_ARTIFACT_UPLOAD_BYTES);
}

export function validateGeneratedArtifactFile(
  input: ArtifactUploadInput,
): NormalizedArtifactUpload {
  return normalizeArtifactFile(input, MAXIMUM_GENERATED_ARTIFACT_BYTES);
}

function normalizeScanResult(result: MalwareScanResult): MalwareScanResult {
  const engine = result.engine.trim();
  if (engine.length === 0 || engine.length > 100) {
    throw new ArtifactValidationError("MALWARE_SCAN_INVALID", "Malware scan result is invalid.");
  }
  if (!(["clean", "infected", "unavailable"] as const).includes(result.status)) {
    throw new ArtifactValidationError("MALWARE_SCAN_INVALID", "Malware scan result is invalid.");
  }
  if (!(["connected", "simulated"] as const).includes(result.mode)) {
    throw new ArtifactValidationError("MALWARE_SCAN_INVALID", "Malware scan mode is invalid.");
  }
  return {
    engine,
    mode: result.mode,
    ...(result.reference === undefined ? {} : { reference: result.reference.trim().slice(0, 200) }),
    status: result.status,
  };
}

export async function validateArtifactUploadWithScanner(
  input: ArtifactUploadInput,
  scanner: MalwareScanner,
  options: { readonly allowSimulatedClean?: boolean } = {},
): Promise<ValidatedArtifactUpload> {
  const upload = validateArtifactUpload(input);
  let malwareScan: MalwareScanResult;
  try {
    malwareScan = normalizeScanResult(await scanner.scan(upload));
  } catch (error) {
    if (error instanceof ArtifactValidationError) throw error;
    throw new ArtifactValidationError("MALWARE_SCAN_FAILED", "Malware scan did not complete.");
  }
  if (malwareScan.status !== "clean") {
    throw new ArtifactValidationError(
      malwareScan.status === "infected" ? "MALWARE_DETECTED" : "MALWARE_SCAN_UNAVAILABLE",
      malwareScan.status === "infected"
        ? "Artifact upload was rejected by malware scanning."
        : "Artifact upload cannot proceed until malware scanning is available.",
    );
  }
  if (malwareScan.mode === "simulated" && options.allowSimulatedClean !== true) {
    throw new ArtifactValidationError(
      "MALWARE_SCAN_SIMULATED",
      "Simulated malware scanning is not accepted for this upload.",
    );
  }
  return { ...upload, malwareScan } as ValidatedArtifactUpload;
}

export class DeterministicDemoMalwareScanner implements MalwareScanner {
  async scan(): Promise<MalwareScanResult> {
    return {
      engine: "bea-demo-malware-fixture",
      mode: "simulated",
      status: "clean",
    };
  }
}
