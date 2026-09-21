import { createHash } from "node:crypto";
import type { JsonObject, ReportDocument } from "@bea/domain";
import type { ReportRenderInput, ReportRenderResult, ReportRenderer } from "./report-renderer.js";
import { DeterministicSyntheticReportRenderer } from "./report-renderer.js";

function pdfEscape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function wrapLine(value: string, width: number): readonly string[] {
  const words = value.split(/\s+/u).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > width) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

function encodePdf(lines: readonly string[]): Uint8Array {
  const contentLines = lines.flatMap((line) => wrapLine(line, 90));
  const streamParts = ["BT", "/F1 11 Tf", "50 740 Td", "14 TL"];
  for (const line of contentLines.slice(0, 48)) {
    streamParts.push(`(${pdfEscape(line)}) '`);
  }
  streamParts.push("ET");
  const stream = streamParts.join("\n");
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj",
    `4 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj`,
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
  ];
  let offset = "%PDF-1.4\n".length;
  const xref = ["0000000000 65535 f "];
  let body = "%PDF-1.4\n";
  for (const object of objects) {
    xref.push(`${String(offset).padStart(10, "0")} 00000 n `);
    body += `${object}\n`;
    offset += object.length + 1;
  }
  const xrefStart = offset;
  const pdf = `${body}xref\n0 ${objects.length + 1}\n${xref.join("\n")}\ntrailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

export function renderReportDocumentToPdf(
  document: ReportDocument,
  generatedAt: string,
): ReportRenderResult {
  const lines: string[] = [
    document.headerText,
    document.disclosure,
    `Template: ${document.templateKey}@${document.templateVersion}`,
    document.configurationReleaseId
      ? `Configuration release: ${document.configurationReleaseId}@${document.configurationReleaseVersion ?? 0}`
      : "Configuration release: none",
    `Schema: ${document.schemaVersion}`,
    `Mapping: ${document.mappingVersion}`,
    `Rules: ${document.ruleSetVersion}`,
    `Generated: ${generatedAt}`,
  ];
  for (const node of document.nodes) {
    if (node.kind === "page_break") {
      lines.push("--- page ---");
      continue;
    }
    if (node.title) lines.push(node.title);
    if (node.text) lines.push(node.text);
    if (node.rows) {
      for (const row of node.rows) {
        lines.push(row.filter(Boolean).join(" | "));
      }
    }
  }
  if (document.includePageNumbers) lines.push("Page 1");
  lines.push(document.footerText);
  const bytes = encodePdf(lines);
  return {
    bytes,
    mimeType: "application/pdf",
    filename: document.filename,
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export class ConfigurableDeterministicReportRenderer implements ReportRenderer {
  private readonly fallback = new DeterministicSyntheticReportRenderer();

  async render(input: ReportRenderInput): Promise<ReportRenderResult> {
    const snapshot = input.snapshot as JsonObject & {
      readonly reportDocument?: ReportDocument;
      readonly frozenGeneratedAt?: string;
    };
    const generatedAt =
      typeof snapshot.frozenGeneratedAt === "string" && snapshot.frozenGeneratedAt
        ? snapshot.frozenGeneratedAt
        : input.generatedAt;
    if (snapshot.reportDocument && typeof snapshot.reportDocument === "object") {
      return renderReportDocumentToPdf(snapshot.reportDocument, generatedAt);
    }
    return this.fallback.render(input);
  }
}

export const configurableSyntheticRenderer = new ConfigurableDeterministicReportRenderer();
export const CONFIGURABLE_RENDERER_KEY = "bea.deterministic-synthetic-pdf.v1";
