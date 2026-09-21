import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { ArtifactValidationError, type BeaPdfDocumentInput } from "./contracts.js";
import { createDemoBeaPdfInput } from "./demo-fixtures.js";
import {
  BEA_OFFICIAL_LOGO_SHA256,
  BEA_PDF_PALETTE,
  composeBeaPdf,
  createBeaPdfContentPlan,
  type PdfLibAdapter,
} from "./pdf.js";

interface LoadedPdfDocument {
  getAuthor(): string | undefined;
  getCreationDate(): Date | undefined;
  getCreator(): string | undefined;
  getPageCount(): number;
  getProducer(): string | undefined;
  getTitle(): string | undefined;
}

interface TestPdfLibModule extends PdfLibAdapter {
  readonly PDFDocument: PdfLibAdapter["PDFDocument"] & {
    load(bytes: Uint8Array): Promise<LoadedPdfDocument>;
  };
}

function loadTestPdfLib(): TestPdfLibModule {
  return createRequire(import.meta.url)("pdf-lib") as TestPdfLibModule;
}

function extractPdfDrawnText(bytes: Uint8Array): string {
  const source = Buffer.from(bytes).toString("latin1");
  const contentStreams: string[] = [];
  for (const match of source.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/gu)) {
    const streamBytes = Buffer.from(match[1] ?? "", "latin1");
    try {
      contentStreams.push(inflateSync(streamBytes).toString("latin1"));
    } catch {
      contentStreams.push(streamBytes.toString("latin1"));
    }
  }
  const drawnText: string[] = [];
  for (const content of contentStreams) {
    for (const match of content.matchAll(/<([0-9a-f]+)>\s*Tj/giu)) {
      drawnText.push(Buffer.from(match[1] ?? "", "hex").toString("latin1"));
    }
    for (const match of content.matchAll(/\(([^)]*)\)\s*Tj/gu)) {
      drawnText.push(match[1] ?? "");
    }
  }
  return drawnText.join(" ");
}

async function officialLogo(): Promise<Uint8Array> {
  return readFile(new URL("../../../apps/web/public/brand/cpl-logo.png", import.meta.url));
}

describe("deterministic BEA-branded PDF composition", () => {
  it("creates byte-identical PDFs with branding, findings, citations, disclosure, dates, and page numbers", async () => {
    const logoBytes = await officialLogo();
    expect(createHash("sha256").update(logoBytes).digest("hex")).toBe(BEA_OFFICIAL_LOGO_SHA256);
    const pdfLib = loadTestPdfLib();
    const input = createDemoBeaPdfInput();
    const first = await composeBeaPdf(input, { logoBytes, pdfLib });
    const second = await composeBeaPdf(input, { logoBytes, pdfLib });

    expect(createHash("sha256").update(first).digest("hex")).toBe(
      createHash("sha256").update(second).digest("hex"),
    );
    expect(first.slice(0, 5)).toEqual(new TextEncoder().encode("%PDF-"));
    const loaded = await pdfLib.PDFDocument.load(first);
    expect(loaded.getPageCount()).toBeGreaterThanOrEqual(3);
    expect(loaded.getTitle()).toBe(input.title);
    expect(loaded.getAuthor()).toBe("Cyber Pirate Labs");
    expect(loaded.getCreator()).toBe("CPL Command Center");
    expect(loaded.getCreationDate()?.toISOString()).toBe(input.generatedAt);

    const content = extractPdfDrawnText(first);
    expect(content).toContain("Cyber Pirate Labs");
    expect(content).toContain("Synthetic Building Envelope Review");
    expect(content).toContain("Executive summary");
    expect(content).toContain("Roof transition review");
    expect(content).toContain("Data status: synthetic");
    expect(content).toContain("Citations");
    expect(content).toContain("https://example.invalid/bea/synthetic-roof-observations");
    expect(content).toContain("DEMO MODE");
    expect(content).toContain("Report date: 2026-08-20");
    expect(content).toContain("Page 1 of");
    expect(content).toContain(
      "Simulated AI-generated inspection diagram - not a field photograph or live provider output",
    );
    expect(BEA_PDF_PALETTE).toMatchObject({ green: "#4AA346", navy: "#08304A" });
  }, 30_000);

  it("exposes a deterministic content plan for audit and citation inspection", () => {
    const plan = createBeaPdfContentPlan(createDemoBeaPdfInput());
    expect(plan).toMatchObject({
      generatedAt: "2026-08-20T14:00:00.000Z",
      reportDate: "2026-08-20",
      title: "Synthetic Building Envelope Review",
    });
    expect(plan.sections.map((section) => section.heading)).toEqual([
      "Executive summary",
      "Findings",
      "Chart",
      "Table",
      "Image",
      "Citations",
      "Disclosure",
    ]);
    expect(plan.sections.find((section) => section.heading === "Citations")?.items).toEqual(
      expect.arrayContaining([
        expect.stringContaining("https://example.invalid/bea/synthetic-roof-observations"),
      ]),
    );
  });

  it("rejects an altered logo and chart inputs missing provenance", async () => {
    const logoBytes = await officialLogo();
    const alteredLogo = Uint8Array.from(logoBytes);
    alteredLogo[0] = alteredLogo[0]! ^ 0xff;
    await expect(
      composeBeaPdf(createDemoBeaPdfInput(), { logoBytes: alteredLogo, pdfLib: loadTestPdfLib() }),
    ).rejects.toThrowError(expect.objectContaining({ code: "INVALID_LOGO" }));

    const input = createDemoBeaPdfInput();
    const invalid = {
      ...input,
      chart: { ...input.chart, provenance: undefined },
    } as unknown as BeaPdfDocumentInput;
    expect(() => createBeaPdfContentPlan(invalid)).toThrow(ArtifactValidationError);
  });
});
