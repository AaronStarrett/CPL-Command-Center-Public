import { createHash } from "node:crypto";
import type { JsonObject } from "@bea/domain";
import {
  SYNTHETIC_REPORT_DISCLOSURE,
  SYNTHETIC_REPORT_TEMPLATE_KEY,
  SYNTHETIC_REPORT_TEMPLATE_VERSION,
  type NormalizedInspectionPayload,
} from "@bea/domain";

export interface ReportRenderInput {
  readonly reportReference: string;
  readonly inspectionReference: string;
  readonly projectReference: string;
  readonly templateKey: string;
  readonly templateVersion: number;
  readonly disclosure: string;
  readonly snapshot: JsonObject;
  readonly generatedAt: string;
}

export interface ReportRenderResult {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly filename: string;
  readonly checksumSha256: string;
}

export interface ReportRenderer {
  render(input: ReportRenderInput): Promise<ReportRenderResult>;
}

export interface NarrativeAssistPort {
  suggestSection?(input: {
    readonly sectionKey: string;
    readonly snapshot: JsonObject;
  }): Promise<string | null>;
}

export class NoAiNarrativeAssist implements NarrativeAssistPort {
  async suggestSection(): Promise<string | null> {
    return null;
  }
}

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

export class DeterministicSyntheticReportRenderer implements ReportRenderer {
  async render(input: ReportRenderInput): Promise<ReportRenderResult> {
    const snapshot = input.snapshot as {
      readonly payload?: NormalizedInspectionPayload;
      readonly findings?: readonly { readonly title: string; readonly description: string }[];
    };
    const payload = snapshot.payload;
    const lines = [
      "BEA Operations Command Center",
      "Inspection Report",
      SYNTHETIC_REPORT_DISCLOSURE,
      `Template: ${input.templateKey}@${input.templateVersion}`,
      `Report: ${input.reportReference}`,
      `Inspection: ${input.inspectionReference}`,
      `Project: ${input.projectReference}`,
      `Generated: ${input.generatedAt}`,
      `Client: ${payload?.clientName ?? "unspecified"}`,
      `Site: ${payload?.siteName ?? "unspecified"}`,
      `Inspector: ${payload?.inspectorName ?? "unspecified"}`,
      `Completed: ${payload?.completedAt ?? "unspecified"}`,
      "Findings:",
      ...(payload?.findings ?? []).map(
        (finding, index) => `${index + 1}. ${finding.title}: ${finding.description}`,
      ),
    ];
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
    const bytes = new TextEncoder().encode(pdf);
    return {
      bytes,
      mimeType: "application/pdf",
      filename: `${input.reportReference.toLocaleLowerCase("en-US")}.pdf`,
      checksumSha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
}

export const defaultSyntheticRenderer = new DeterministicSyntheticReportRenderer();

export const SYNTHETIC_RENDERER_KEY = "bea.deterministic-synthetic-pdf.v1";

export function syntheticTemplateIdentity(): {
  readonly key: string;
  readonly version: number;
  readonly rendererKey: string;
  readonly disclosure: string;
} {
  return {
    key: SYNTHETIC_REPORT_TEMPLATE_KEY,
    version: SYNTHETIC_REPORT_TEMPLATE_VERSION,
    rendererKey: SYNTHETIC_RENDERER_KEY,
    disclosure: SYNTHETIC_REPORT_DISCLOSURE,
  };
}
