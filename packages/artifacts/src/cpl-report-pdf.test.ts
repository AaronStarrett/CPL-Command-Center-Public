import { inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { cplReportPdfFixture } from "../../../tests/fixtures/cpl-report-pdf";
import { renderCplReportPdf } from "./cpl-report-pdf";

function extract(bytes: Uint8Array): string {
  const source = Buffer.from(bytes).toString("latin1"),
    output: string[] = [];
  for (const match of source.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/gu)) {
    let data: string;
    try {
      data = inflateSync(Buffer.from(match[1]!, "latin1")).toString("latin1");
    } catch {
      continue;
    }
    if (!data.includes("BT")) continue;
    for (const text of data.matchAll(/<([0-9a-f]+)>\s*Tj/giu))
      output.push(new TextDecoder("windows-1252").decode(Buffer.from(text[1]!, "hex")));
  }
  return output.join("\n");
}
describe("approved public field report PDF", () => {
  it("renders only selected sections in their explicit order without reading or embedding omitted photos", async () => {
    const input = await cplReportPdfFixture();
    Object.assign(input, {
      sectionOrder: ["conclusion", "sections", "scope"],
      conclusion: "CONCLUSION-FIRST",
      scope: "SCOPE-LAST",
      sections: [
        {
          id: "custom",
          title: "CUSTOM-MIDDLE",
          body: "Explicit public section",
          internalNotes: "PRIVATE-CUSTOM",
        },
      ],
    });
    Object.defineProperty(input, "visits", {
      get() {
        throw new Error("Omitted photo selection was read");
      },
    });
    Object.defineProperty(input, "summary", {
      get() {
        throw new Error("Omitted text was read");
      },
    });
    const bytes = await renderCplReportPdf(input),
      text = extract(bytes);
    expect(text.indexOf("CONCLUSION-FIRST")).toBeLessThan(text.indexOf("CUSTOM-MIDDLE"));
    expect(text.indexOf("CUSTOM-MIDDLE")).toBeLessThan(text.indexOf("SCOPE-LAST"));
    expect(text).not.toContain("PRIVATE-CUSTOM");
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
    Object.assign(input, { sectionOrder: ["scope", "scope"] });
    await expect(renderCplReportPdf(input)).rejects.toMatchObject({
      code: "CPL_REPORT_PDF_INVALID",
    });
  });
  it("is byte-deterministic with frozen approval metadata, report version and page numbering", async () => {
    const input = await cplReportPdfFixture(),
      first = await renderCplReportPdf(input),
      second = await renderCplReportPdf(input);
    expect(first).toEqual(second);
    const pdf = await PDFDocument.load(first, { updateMetadata: false });
    expect(pdf.getCreationDate()?.toISOString()).toBe(input.approvedAt);
    expect(pdf.getModificationDate()?.toISOString()).toBe(input.approvedAt);
    expect(pdf.getAuthor()).toBe(input.company.businessName);
    expect(pdf.getTitle()).toBe(input.title);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(3);
    const text = extract(first);
    for (const expected of [
      "RPT-2026-0042",
      "Approved version 3",
      "Visit 1",
      "Visit 2",
      "Priority: Review",
      "Review joint",
      "Photo appendix",
      "CONCLUSION-END",
      `Page ${pdf.getPageCount()} of ${pdf.getPageCount()}`,
    ])
      expect(text).toContain(expected);
  });
  it("paginates all long prose and caption lines without losing their final markers", async () => {
    const bytes = await renderCplReportPdf(await cplReportPdfFixture(true)),
      text = extract(bytes),
      pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThan(6);
    for (let index = 0; index < 42; index++) expect(text).toContain(`Scope paragraph ${index}:`);
    for (let index = 0; index < 70; index++) expect(text).toContain(`Caption detail ${index}:`);
    for (const marker of [
      "SCOPE-END",
      "LONG-CAPTION-END",
      "PORTRAIT-CAPTION-END",
      "APPENDIX-CAPTION-END",
      "FINAL-PHOTO-CAPTION",
      "CONCLUSION-END",
      "Photo captions (continued)",
    ])
      expect(text).toContain(marker);
  });
  it("never reads or serializes accidental private fields or source metadata", async () => {
    const input = await cplReportPdfFixture();
    for (const target of [
      input,
      input.company,
      input.project,
      input.visits[0]!,
      input.visits[0]!.observations[0]!,
      input.visits[0]!.observations[0]!.photos[0]!,
    ]) {
      Object.assign(target, {
        internalNotes: "PRIVATE-NOTES",
        accessInstructions: "PRIVATE-ACCESS",
        pricing: "PRIVATE-PRICING",
        sourceEvidence: "PRIVATE-SOURCE",
        unselectedPhotos: "PRIVATE-UNSELECTED",
      });
      Object.defineProperty(target, "filesystemPath", {
        get() {
          throw new Error("Private property read");
        },
      });
    }
    const bytes = await renderCplReportPdf(input);
    expect(extract(bytes)).not.toMatch(/PRIVATE-|sourceEvidence|filesystemPath/u);
    expect(Buffer.from(bytes).toString("latin1")).not.toMatch(/PRIVATE-|PRIVATE-ACCESS/u);
  });
  it("requires exact frozen photo hashes before consuming embedded pixels", async () => {
    const input = await cplReportPdfFixture();
    Object.assign(input.visits[0]!.observations[0]!.photos[0]!, { sha256: "0".repeat(64) });
    await expect(renderCplReportPdf(input)).rejects.toMatchObject({
      code: "CPL_REPORT_PDF_IMAGE_INVALID",
    });
  });
  it("refuses externally located branding and oversized pixel headers", async () => {
    const input = await cplReportPdfFixture();
    Object.assign(input.company, { logoDataUrl: "https://untrusted.invalid/logo.png" });
    await expect(renderCplReportPdf(input)).rejects.toMatchObject({
      code: "CPL_REPORT_PDF_IMAGE_INVALID",
    });
    Object.assign(input.company, { logoDataUrl: null });
    const photo = input.visits[0]!.observations[0]!.photos[0]!,
      bytes = Buffer.from(photo.bytes);
    bytes.writeUInt32BE(50000, 16);
    Object.assign(photo, { bytes, sha256: createHash("sha256").update(bytes).digest("hex") });
    await expect(renderCplReportPdf(input)).rejects.toMatchObject({
      code: "CPL_REPORT_PDF_IMAGE_INVALID",
    });
  });
  it("handles missing optional public values without placeholder private data", async () => {
    const input = await cplReportPdfFixture();
    Object.assign(input.company, { logoDataUrl: null, email: "", phone: "", address: "" });
    Object.assign(input, { scope: "", summary: "", limitations: "", conclusion: "", visits: [] });
    const bytes = await renderCplReportPdf(input);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
    expect(extract(bytes)).not.toMatch(/undefined|null|PRIVATE/u);
  });
  it("supports common smart punctuation but fails clearly for unsupported text", async () => {
    const input = await cplReportPdfFixture();
    Object.assign(input, { title: "Review – “roof edge” • façade €" });
    expect(extract(await renderCplReportPdf(input))).toContain("façade €");
    Object.assign(input, { title: "Unsupported 😀" });
    await expect(renderCplReportPdf(input)).rejects.toMatchObject({
      code: "CPL_REPORT_PDF_UNSUPPORTED_CHARACTER",
    });
  });
  it("enforces the normalized annotation contract and validates label characters", async () => {
    const input = await cplReportPdfFixture(),
      photo = input.visits[0]!.observations[0]!.photos[0]!;
    Object.assign(photo, {
      annotations: {
        coordinateSpace: "upright-normalized-v1",
        shapes: [
          { kind: "arrow", x1: -1, y1: 0, x2: 1, y2: 1, color: "#FFFFFF", strokeWidth: 0.01 },
        ],
      },
    });
    await expect(renderCplReportPdf(input)).rejects.toMatchObject({
      code: "CPL_IMAGE_INVALID_ANNOTATIONS",
    });
    Object.assign(photo, {
      annotations: {
        coordinateSpace: "upright-normalized-v1",
        shapes: [{ kind: "label", x: 0.1, y: 0.1, text: "😀", color: "#FFFFFF", fontSize: 0.04 }],
      },
    });
    await expect(renderCplReportPdf(input)).rejects.toMatchObject({
      code: "CPL_REPORT_PDF_UNSUPPORTED_CHARACTER",
    });
  });
});
