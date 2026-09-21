import { createHash } from "node:crypto";
import type { ProposalDocument } from "@bea/domain";
import { proposalDocumentToRenderLines } from "@bea/domain";

export interface ProposalRenderResult {
  readonly bytes: Uint8Array;
  readonly checksumSha256: string;
  readonly pageCount: number;
  readonly renderer: "bea.deterministic-synthetic-pdf.v1";
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
      current = word.length > width ? word.slice(0, width) : word;
      if (word.length > width) {
        const remaining = word.slice(width);
        if (remaining) lines.push(...wrapLine(remaining, width));
      }
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

function encodeMultipagePdf(lines: readonly string[], generatedAt: string): Uint8Array {
  const wrapped = lines.flatMap((line) => (line === "--- page ---" ? [line] : wrapLine(line, 90)));
  const pages: string[][] = [[]];
  for (const line of wrapped) {
    if (line === "--- page ---" || (pages.at(-1)?.length ?? 0) >= 48) {
      pages.push([]);
      if (line === "--- page ---") continue;
    }
    pages[pages.length - 1]?.push(line);
  }
  const pageCount = Math.max(pages.length, 1);
  const objectCount = 3 + pageCount * 2;
  const objects: string[] = [];
  const pageObjectNumbers: number[] = [];
  objects.push("placeholder-catalog");
  objects.push("placeholder-pages");
  for (let index = 0; index < pageCount; index += 1) {
    const pageNo = 3 + index * 2;
    const contentNo = pageNo + 1;
    pageObjectNumbers.push(pageNo);
    const streamParts = ["BT", "/F1 11 Tf", "50 740 Td", "14 TL"];
    streamParts.push(
      `(${pdfEscape(`Generated: ${generatedAt} · page ${index + 1} of ${pageCount}`)}) '`,
    );
    for (const line of pages[index] ?? []) {
      streamParts.push(`(${pdfEscape(line)}) '`);
    }
    streamParts.push("ET");
    const stream = streamParts.join("\n");
    objects.push(
      `${pageNo} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNo} 0 R /Resources << /Font << /F1 ${objectCount} 0 R >> >> >> endobj`,
    );
    objects.push(
      `${contentNo} 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj`,
    );
  }
  objects[0] = `1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj`;
  objects[1] = `2 0 obj << /Type /Pages /Kids [${pageObjectNumbers.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageCount} >> endobj`;
  objects.push(
    `${objectCount} 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj`,
  );
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

export function renderProposalDocumentToPdf(
  document: ProposalDocument,
  generatedAt: string,
): ProposalRenderResult {
  const lines = [
    ...proposalDocumentToRenderLines(document),
    `Frozen render input generatedAt=${generatedAt}`,
  ];
  const bytes = encodeMultipagePdf(lines, generatedAt);
  return {
    bytes,
    checksumSha256: createHash("sha256")
      .update(`${lines.join("\n")}\n${generatedAt}`, "utf8")
      .digest("hex"),
    pageCount: Math.max(1, Math.ceil(lines.length / 48)),
    renderer: "bea.deterministic-synthetic-pdf.v1",
  };
}
