import { inflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { cplProposalPdfFixture } from "../../../tests/fixtures/cpl-proposal-pdf";
import { renderCplProposalPdf } from "./proposal-pdf";

function text(bytes: Uint8Array): string {
  const source = Buffer.from(bytes).toString("latin1"),
    lines: string[] = [];
  for (const match of source.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/gu)) {
    let content: string;
    try {
      content = inflateSync(Buffer.from(match[1]!, "latin1")).toString("latin1");
    } catch {
      continue;
    }
    for (const drawn of content.matchAll(/<([0-9a-f]+)>\s*Tj/giu))
      lines.push(new TextDecoder("windows-1252").decode(Buffer.from(drawn[1]!, "hex")));
  }
  return lines.join("\n");
}
const tinyPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";
describe("public approved proposal PDF", () => {
  it("is byte-identical and binds metadata, totals, reference and approved version", async () => {
    const input = cplProposalPdfFixture(),
      first = await renderCplProposalPdf(input),
      second = await renderCplProposalPdf(input);
    expect(first).toEqual(second);
    const loaded = await PDFDocument.load(first, { updateMetadata: false });
    expect(loaded.getTitle()).toBe(input.content.title);
    expect(loaded.getAuthor()).toBe(input.company.businessName);
    expect(loaded.getCreationDate()?.toISOString()).toBe(input.approvedAt);
    expect(loaded.getModificationDate()?.toISOString()).toBe(input.approvedAt);
    const output = text(first);
    for (const item of [
      "PROP-2026-0042",
      "Approved version 3",
      "1,162.50",
      "-62.50",
      "1,100.00",
      "90.75",
      "1,190.75",
      "Tax (8.25%)",
      "Total (USD)",
      "2.5",
      "Communication and confirmation",
      "2026-10-05",
      "2026-10-09",
    ])
      expect(output).toContain(item);
    expect(output).not.toMatch(/Cyber Pirate|CPL Command Center|Building Envelope/iu);
  });
  it("paginates long narratives and a single over-page table row without truncating the end", async () => {
    const input = cplProposalPdfFixture();
    input.content.scope =
      Array.from(
        { length: 125 },
        (_, i) =>
          `Scope paragraph ${i}: preserve all customer work details, quantities, and outcomes.`,
      ).join("\n") + "\nSCOPE-END-SENTINEL";
    input.content.lineItems[0]!.description =
      Array.from({ length: 65 }, (_, i) => `Detailed line ${i} with full deliverable wording`).join(
        " ",
      ) + " TABLE-END-SENTINEL";
    input.content.sections = [
      { id: "long", title: "Long custom heading ".repeat(10), body: "Section body" },
    ];
    input.content.customerNotes = "FINAL-CUSTOMER-NOTE-SENTINEL";
    const bytes = await renderCplProposalPdf(input),
      loaded = await PDFDocument.load(bytes),
      output = text(bytes);
    expect(loaded.getPageCount()).toBeGreaterThan(5);
    for (const sentinel of [
      "SCOPE-END-SENTINEL",
      "TABLE-END-SENTINEL",
      "FINAL-CUSTOMER-NOTE-SENTINEL",
    ])
      expect(output).toContain(sentinel);
    for (let i = 0; i < 125; i++) expect(output).toContain(`Scope paragraph ${i}:`);
    expect(output).toContain(`Page ${loaded.getPageCount()} of ${loaded.getPageCount()}`);
    expect(output.match(/Description\nQty\nUnit\nUnit price\nAmount/gu)!.length).toBeGreaterThan(1);
  });
  it("never enumerates accidental private properties or operational content", async () => {
    const input = cplProposalPdfFixture();
    Object.assign(input, {
      internalNotes: "PRIVATE-NOTES-SENTINEL",
      sourceLead: { evidence: "PRIVATE-EVIDENCE-SENTINEL" },
      actorIdentityId: "PRIVATE-ACTOR-SENTINEL",
    });
    Object.assign(input.content, {
      accessInstructions: "PRIVATE-ACCESS-SENTINEL",
      constraints: "PRIVATE-CONSTRAINT-SENTINEL",
      internalNotes: "PRIVATE-CONTENT-SENTINEL",
    });
    Object.defineProperty(input, "credential", {
      get() {
        throw new Error("private field must not be read");
      },
      enumerable: true,
    });
    const bytes = await renderCplProposalPdf(input);
    expect(text(bytes)).not.toContain("PRIVATE-");
    expect(Buffer.from(bytes).toString("utf8")).not.toContain("PRIVATE-");
  });
  it("preserves common Western European names, smart punctuation and currency signs", async () => {
    const input = cplProposalPdfFixture();
    input.content.customerNotes =
      "Renée’s café: “approved” — €250, £200, ¥100; façade, naïve, ©2026, 20°C.";
    expect(text(await renderCplProposalPdf(input))).toContain(input.content.customerNotes);
  });
  it.each(["中文", "🔒", "A\u0000B"])(
    "refuses unsupported characters clearly instead of substituting: %s",
    async (value) => {
      const input = cplProposalPdfFixture();
      input.content.scope = value;
      await expect(renderCplProposalPdf(input)).rejects.toMatchObject({
        code: "CPL_PROPOSAL_PDF_UNSUPPORTED_CHARACTER",
      });
    },
  );
  it("embeds an explicitly supplied bounded logo deterministically", async () => {
    const input = cplProposalPdfFixture();
    input.company.logoDataUrl = tinyPng;
    const first = await renderCplProposalPdf(input);
    expect(first).toEqual(await renderCplProposalPdf(input));
    expect(Buffer.from(first).toString("latin1")).toContain("/Subtype /Image");
  });
  it.each([
    "https://example.invalid/logo.png",
    "data:image/svg+xml;base64,PHN2Zy8+",
    "data:image/jpeg;base64,AAAA",
    "data:image/png;base64," + "A".repeat(175000),
  ])("rejects external, mismatched or oversized logo data", async (value) => {
    const input = cplProposalPdfFixture();
    input.company.logoDataUrl = value;
    await expect(renderCplProposalPdf(input)).rejects.toMatchObject({
      code: "CPL_PROPOSAL_PDF_LOGO_INVALID",
    });
  });
  it("rejects oversized decoded dimensions before image decoding", async () => {
    const input = cplProposalPdfFixture(),
      bytes = Buffer.from(tinyPng.split(",")[1]!, "base64");
    bytes.writeUInt32BE(2049, 16);
    input.company.logoDataUrl = "data:image/png;base64," + bytes.toString("base64");
    await expect(renderCplProposalPdf(input)).rejects.toMatchObject({
      code: "CPL_PROPOSAL_PDF_LOGO_INVALID",
    });
  });
  it("refuses a second PNG header before the decoder can replace validated dimensions", async () => {
    const input = cplProposalPdfFixture(),
      bytes = Buffer.from(tinyPng.split(",")[1]!, "base64"),
      replacement = Buffer.from(bytes.subarray(8, 33));
    replacement.writeUInt32BE(2049, 8);
    input.company.logoDataUrl =
      "data:image/png;base64," +
      Buffer.concat([bytes.subarray(0, 33), replacement, bytes.subarray(33)]).toString("base64");
    await expect(renderCplProposalPdf(input)).rejects.toMatchObject({
      code: "CPL_PROPOSAL_PDF_LOGO_INVALID",
    });
  });
  it("excludes PNG textual metadata from decoding and customer artifact bytes", async () => {
    const input = cplProposalPdfFixture(),
      bytes = Buffer.from(tinyPng.split(",")[1]!, "base64"),
      payload = Buffer.from("PRIVATE-LOGO-METADATA-WITHOUT-TERMINATOR"),
      chunk = Buffer.alloc(payload.length + 12);
    chunk.writeUInt32BE(payload.length);
    chunk.write("tEXt", 4, "ascii");
    payload.copy(chunk, 8);
    input.company.logoDataUrl =
      "data:image/png;base64," +
      Buffer.concat([bytes.subarray(0, 33), chunk, bytes.subarray(33)]).toString("base64");
    const output = await renderCplProposalPdf(input);
    expect(Buffer.from(output).toString("latin1")).not.toContain("PRIVATE-LOGO");
    input.company.logoDataUrl = tinyPng;
    expect(output).toEqual(await renderCplProposalPdf(input));
  });
  it("refuses inconsistent approved monetary totals", async () => {
    const input = cplProposalPdfFixture();
    input.totals.totalMinor++;
    await expect(renderCplProposalPdf(input)).rejects.toMatchObject({
      code: "CPL_PROPOSAL_PDF_INVALID",
    });
  });
});
