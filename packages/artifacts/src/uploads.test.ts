import { describe, expect, it } from "vitest";

import { type MalwareScanner } from "./contracts.js";
import {
  DeterministicDemoMalwareScanner,
  MAXIMUM_ARTIFACT_UPLOAD_BYTES,
  validateArtifactUpload,
  validateArtifactUploadWithScanner,
  validateGeneratedArtifactFile,
} from "./uploads.js";

const textBytes = new TextEncoder().encode("system,observation\nRoof,Synthetic observation\n");

function littleEndian(value: number, byteCount: 2 | 4): Uint8Array {
  const bytes = new Uint8Array(byteCount);
  const view = new DataView(bytes.buffer);
  if (byteCount === 2) view.setUint16(0, value, true);
  else view.setUint32(0, value, true);
  return bytes;
}

function joinBytes(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function syntheticZip(entries: readonly { readonly encrypted?: boolean; readonly name: string }[]) {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const flags = entry.encrypted ? 1 : 0;
    const local = joinBytes([
      littleEndian(0x04034b50, 4),
      littleEndian(20, 2),
      littleEndian(flags, 2),
      littleEndian(0, 2),
      new Uint8Array(16),
      littleEndian(name.length, 2),
      littleEndian(0, 2),
      name,
    ]);
    const central = joinBytes([
      littleEndian(0x02014b50, 4),
      littleEndian(20, 2),
      littleEndian(20, 2),
      littleEndian(flags, 2),
      littleEndian(0, 2),
      new Uint8Array(16),
      littleEndian(name.length, 2),
      littleEndian(0, 2),
      littleEndian(0, 2),
      littleEndian(0, 2),
      littleEndian(0, 2),
      littleEndian(0, 4),
      littleEndian(localOffset, 4),
      name,
    ]);
    localParts.push(local);
    centralParts.push(central);
    localOffset += local.length;
  }
  const central = joinBytes(centralParts);
  const end = joinBytes([
    littleEndian(0x06054b50, 4),
    littleEndian(0, 2),
    littleEndian(0, 2),
    littleEndian(entries.length, 2),
    littleEndian(entries.length, 2),
    littleEndian(central.length, 4),
    littleEndian(localOffset, 4),
    littleEndian(0, 2),
  ]);
  return joinBytes([...localParts, central, end]);
}

describe("restricted artifact upload validation", () => {
  it("keeps browser uploads at 12 MiB while trusted generated files use their separate ceiling", () => {
    const bytes = new Uint8Array(MAXIMUM_ARTIFACT_UPLOAD_BYTES + 1).fill(0x61);
    const input = { bytes, filename: "generated.txt", mimeType: "text/plain" };

    expect(() => validateArtifactUpload(input)).toThrowError(
      expect.objectContaining({ code: "INVALID_FILE_SIZE" }),
    );
    expect(validateGeneratedArtifactFile(input)).toMatchObject({
      size: MAXIMUM_ARTIFACT_UPLOAD_BYTES + 1,
    });
  });

  it("normalizes an approved filename, MIME type, size, and hash", () => {
    const upload = validateArtifactUpload({
      bytes: textBytes,
      filename: "synthetic.csv",
      mimeType: "text/csv",
    });
    expect(upload).toMatchObject({
      extension: ".csv",
      filename: "synthetic.csv",
      mimeType: "text/csv",
      size: textBytes.length,
    });
    expect(upload.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("accepts only bounded type-specific OOXML packages instead of arbitrary ZIP files", () => {
    const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const xlsxMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const docx = syntheticZip([{ name: "[Content_Types].xml" }, { name: "word/document.xml" }]);
    const xlsx = syntheticZip([{ name: "[Content_Types].xml" }, { name: "xl/workbook.xml" }]);
    expect(
      validateArtifactUpload({ bytes: docx, filename: "safe.docx", mimeType: docxMime }),
    ).toMatchObject({ extension: ".docx" });
    expect(
      validateArtifactUpload({ bytes: xlsx, filename: "safe.xlsx", mimeType: xlsxMime }),
    ).toMatchObject({ extension: ".xlsx" });

    for (const bytes of [
      syntheticZip([{ name: "notes.txt" }]),
      syntheticZip([{ name: "[Content_Types].xml" }, { name: "../word/document.xml" }]),
      syntheticZip([
        { name: "[Content_Types].xml" },
        { encrypted: true, name: "word/document.xml" },
      ]),
      syntheticZip([
        { name: "[Content_Types].xml" },
        { name: "word/document.xml" },
        { name: "word/vbaProject.bin" },
      ]),
      xlsx,
    ]) {
      expect(() =>
        validateArtifactUpload({ bytes, filename: "unsafe.docx", mimeType: docxMime }),
      ).toThrowError(expect.objectContaining({ code: "FILE_SIGNATURE_MISMATCH" }));
    }
  });

  it.each([
    [{ bytes: textBytes, filename: "../synthetic.csv", mimeType: "text/csv" }, "INVALID_FILENAME"],
    [
      { bytes: textBytes, filename: "synthetic.exe", mimeType: "application/octet-stream" },
      "UNSUPPORTED_FILE_TYPE",
    ],
    [
      { bytes: textBytes, filename: "synthetic.pdf", mimeType: "application/pdf" },
      "FILE_SIGNATURE_MISMATCH",
    ],
    [
      { bytes: new Uint8Array(), filename: "synthetic.txt", mimeType: "text/plain" },
      "INVALID_FILE_SIZE",
    ],
  ])("rejects unsafe upload input with %s", (input, code) => {
    expect(() => validateArtifactUpload(input)).toThrowError(expect.objectContaining({ code }));
  });

  it("fails closed for simulated, infected, unavailable, and failed malware scans", async () => {
    await expect(
      validateArtifactUploadWithScanner(
        { bytes: textBytes, filename: "synthetic.csv", mimeType: "text/csv" },
        new DeterministicDemoMalwareScanner(),
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: "MALWARE_SCAN_SIMULATED" }));

    for (const [status, code] of [
      ["infected", "MALWARE_DETECTED"],
      ["unavailable", "MALWARE_SCAN_UNAVAILABLE"],
    ] as const) {
      const scanner: MalwareScanner = {
        async scan() {
          return { engine: "test-scanner", mode: "connected", status };
        },
      };
      await expect(
        validateArtifactUploadWithScanner(
          { bytes: textBytes, filename: "synthetic.csv", mimeType: "text/csv" },
          scanner,
        ),
      ).rejects.toThrowError(expect.objectContaining({ code }));
    }

    const failedScanner: MalwareScanner = {
      async scan() {
        throw new Error("scanner internal path must not escape");
      },
    };
    await expect(
      validateArtifactUploadWithScanner(
        { bytes: textBytes, filename: "synthetic.csv", mimeType: "text/csv" },
        failedScanner,
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: "MALWARE_SCAN_FAILED" }));
  });

  it("brands an explicitly allowed deterministic Demo scan as a validated upload", async () => {
    const upload = await validateArtifactUploadWithScanner(
      { bytes: textBytes, filename: "synthetic.csv", mimeType: "text/csv" },
      new DeterministicDemoMalwareScanner(),
      { allowSimulatedClean: true },
    );
    expect(upload.malwareScan).toEqual({
      engine: "bea-demo-malware-fixture",
      mode: "simulated",
      status: "clean",
    });
  });
});
