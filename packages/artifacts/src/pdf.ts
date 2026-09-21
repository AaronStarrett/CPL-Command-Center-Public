import { createHash } from "node:crypto";

import {
  ArtifactValidationError,
  type ArtifactCitation,
  type ArtifactTableData,
  type BeaPdfDocumentInput,
  type BeaPdfFinding,
  type BeaPdfImageInput,
} from "./contracts.js";
import { normalizeArtifactChartData } from "./manifest.js";

export const BEA_OFFICIAL_LOGO_SHA256 =
  "30c43d3ce4728e1a6d0fac689b6bce7cf3088b0ec4e46f30bd0bbff19fad8dd8";

export const BEA_PDF_PALETTE = {
  blue: "#1769AA",
  grayBlue: "#DCE7EC",
  green: "#4AA346",
  navy: "#08304A",
  paleGreen: "#EAF4EA",
  paleNavy: "#E6EEF1",
  slate: "#526875",
  white: "#FFFFFF",
} as const;

type PdfColor = object;

interface PdfFont {
  widthOfTextAtSize(text: string, size: number): number;
}

interface PdfImage {
  readonly height: number;
  readonly width: number;
}

interface PdfPage {
  drawImage(
    image: PdfImage,
    options: {
      readonly height: number;
      readonly width: number;
      readonly x: number;
      readonly y: number;
    },
  ): void;
  drawLine(options: {
    readonly color: PdfColor;
    readonly end: { readonly x: number; readonly y: number };
    readonly start: { readonly x: number; readonly y: number };
    readonly thickness: number;
  }): void;
  drawRectangle(options: {
    readonly borderColor?: PdfColor;
    readonly borderWidth?: number;
    readonly color?: PdfColor;
    readonly height: number;
    readonly opacity?: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
  }): void;
  drawText(
    text: string,
    options: {
      readonly color: PdfColor;
      readonly font: PdfFont;
      readonly size: number;
      readonly x: number;
      readonly y: number;
    },
  ): void;
  getSize(): { readonly height: number; readonly width: number };
}

interface PdfDocument {
  addPage(size: readonly [number, number]): PdfPage;
  embedFont(name: string): Promise<PdfFont>;
  embedJpg(bytes: Uint8Array): Promise<PdfImage>;
  embedPng(bytes: Uint8Array): Promise<PdfImage>;
  getPages(): readonly PdfPage[];
  save(options: {
    readonly addDefaultPage: false;
    readonly useObjectStreams: false;
  }): Promise<Uint8Array>;
  setAuthor(value: string): void;
  setCreationDate(value: Date): void;
  setCreator(value: string): void;
  setKeywords(value: readonly string[]): void;
  setModificationDate(value: Date): void;
  setProducer(value: string): void;
  setSubject(value: string): void;
  setTitle(value: string): void;
}

export interface PdfLibAdapter {
  readonly PDFDocument: { create(): Promise<PdfDocument> };
  readonly StandardFonts: {
    readonly Helvetica: string;
    readonly HelveticaBold: string;
  };
  rgb(red: number, green: number, blue: number): PdfColor;
}

export interface BeaPdfCompositionOptions {
  readonly logoBytes: Uint8Array;
  readonly pdfLib?: PdfLibAdapter;
}

export interface BeaPdfContentPlan {
  readonly disclosure: string;
  readonly generatedAt: string;
  readonly reportDate: string;
  readonly sections: ReadonlyArray<{
    readonly heading: string;
    readonly items: readonly string[];
  }>;
  readonly title: string;
  readonly requestedBy: string;
}

const pageWidth = 612;
const pageHeight = 792;
const margin = 48;
const contentWidth = pageWidth - margin * 2;
const contentTop = 718;
const contentBottom = 64;

function pdfText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u2010-\u2015]/gu, "-")
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/[\u201c\u201d]/gu, '"')
    .replace(/\u2026/gu, "...")
    .replace(/[^\u000a\u0020-\u007e]/gu, "?");
}

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") {
    throw new ArtifactValidationError("INVALID_PDF_INPUT", `${label} must be text.`);
  }
  const normalized = pdfText(value.trim().replace(/\s+/gu, " "));
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new ArtifactValidationError(
      "INVALID_PDF_INPUT",
      `${label} must contain between 1 and ${maximum} characters.`,
    );
  }
  return normalized;
}

function isoTimestamp(value: unknown, label: string): string {
  const normalized = requiredText(value, label, 40);
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== normalized) {
    throw new ArtifactValidationError("INVALID_PDF_INPUT", `${label} must be an ISO timestamp.`);
  }
  return normalized;
}

function calendarDate(value: unknown): string {
  const normalized = requiredText(value, "Report date", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    throw new ArtifactValidationError("INVALID_PDF_INPUT", "Report date must use YYYY-MM-DD.");
  }
  const date = new Date(`${normalized}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) {
    throw new ArtifactValidationError("INVALID_PDF_INPUT", "Report date is invalid.");
  }
  return normalized;
}

function normalizeCitation(value: ArtifactCitation): ArtifactCitation {
  const accessedAt = isoTimestamp(value.accessedAt, "Citation accessedAt");
  const title = requiredText(value.title, "Citation title", 300);
  const domain = requiredText(value.domain, "Citation domain", 253).toLowerCase();
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw new ArtifactValidationError("INVALID_PDF_INPUT", "Citation URL must be valid.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hostname.toLowerCase() !== domain
  ) {
    throw new ArtifactValidationError(
      "INVALID_PDF_INPUT",
      "Citation must use an HTTPS URL matching its domain.",
    );
  }
  return { accessedAt, domain, title, url: url.toString() };
}

function normalizeTable(value: ArtifactTableData): ArtifactTableData {
  if (value.columns.length === 0 || value.columns.length > 8 || value.rows.length > 100) {
    throw new ArtifactValidationError(
      "INVALID_PDF_INPUT",
      "PDF tables require 1 to 8 columns and at most 100 rows.",
    );
  }
  const columns = value.columns.map((column) => requiredText(column, "Table column", 80));
  const rows = value.rows.map((row) => {
    if (row.length !== columns.length) {
      throw new ArtifactValidationError(
        "INVALID_PDF_INPUT",
        "Every PDF table row must match the column count.",
      );
    }
    return row.map((cell) => requiredText(cell, "Table cell", 500));
  });
  return { columns, rows, title: requiredText(value.title, "Table title", 200) };
}

function normalizeImage(value: BeaPdfImageInput): BeaPdfImageInput {
  if (
    !(value.bytes instanceof Uint8Array) ||
    value.bytes.length === 0 ||
    value.bytes.length > 12 * 1024 * 1024
  ) {
    throw new ArtifactValidationError("INVALID_PDF_INPUT", "PDF image bytes are invalid.");
  }
  const png =
    value.bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (byte, index) => value.bytes[index] === byte,
    );
  const jpeg =
    value.bytes.length >= 3 &&
    value.bytes[0] === 0xff &&
    value.bytes[1] === 0xd8 &&
    value.bytes[2] === 0xff;
  if ((value.mimeType === "image/png" && !png) || (value.mimeType === "image/jpeg" && !jpeg)) {
    throw new ArtifactValidationError(
      "INVALID_PDF_INPUT",
      "PDF image content does not match its MIME type.",
    );
  }
  return {
    altText: requiredText(value.altText, "Image alt text", 500),
    bytes: value.bytes,
    caption: requiredText(value.caption, "Image caption", 500),
    mimeType: value.mimeType,
  };
}

function normalizeFinding(value: BeaPdfFinding): BeaPdfFinding {
  if (!(
    value.severity === "info" ||
    value.severity === "attention" ||
    value.severity === "critical"
  )) {
    throw new ArtifactValidationError("INVALID_PDF_INPUT", "Finding severity is unsupported.");
  }
  return {
    detail: requiredText(value.detail, "Finding detail", 2_000),
    severity: value.severity,
    title: requiredText(value.title, "Finding title", 200),
  };
}

function normalizeInput(value: BeaPdfDocumentInput): BeaPdfDocumentInput {
  if (
    !Array.isArray(value.citations) ||
    value.citations.length === 0 ||
    value.citations.length > 50
  ) {
    throw new ArtifactValidationError("INVALID_PDF_INPUT", "PDF citations require 1 to 50 items.");
  }
  if (!Array.isArray(value.findings) || value.findings.length === 0 || value.findings.length > 50) {
    throw new ArtifactValidationError("INVALID_PDF_INPUT", "PDF findings require 1 to 50 items.");
  }
  const citations = value.citations.map(normalizeCitation);
  const citationUrls = new Set(citations.map((citation) => citation.url));
  return {
    ...(value.chart === undefined
      ? {}
      : { chart: normalizeArtifactChartData(value.chart, citationUrls) }),
    citations,
    disclosure: requiredText(value.disclosure, "Disclosure", 1_000),
    findings: value.findings.map(normalizeFinding),
    generatedAt: isoTimestamp(value.generatedAt, "Generated at"),
    ...(value.image === undefined ? {} : { image: normalizeImage(value.image) }),
    reportDate: calendarDate(value.reportDate),
    summary: requiredText(value.summary, "Summary", 5_000),
    ...(value.table === undefined ? {} : { table: normalizeTable(value.table) }),
    title: requiredText(value.title, "Title", 200),
    requestedBy: requiredText(value.requestedBy ?? "Authorized user", "Requesting user", 160),
  };
}

export function createBeaPdfContentPlan(input: BeaPdfDocumentInput): BeaPdfContentPlan {
  const normalized = normalizeInput(input);
  const sections: Array<{ heading: string; items: string[] }> = [
    { heading: "Executive summary", items: [normalized.summary] },
    {
      heading: "Findings",
      items: normalized.findings.map(
        (finding) => `[${finding.severity.toUpperCase()}] ${finding.title}: ${finding.detail}`,
      ),
    },
  ];
  if (normalized.chart !== undefined) {
    sections.push({
      heading: "Chart",
      items: [
        normalized.chart.title,
        `Data status: ${normalized.chart.provenance.dataStatus}`,
        `Calculation notes: ${normalized.chart.provenance.calculationNotes}`,
      ],
    });
  }
  if (normalized.table !== undefined) {
    sections.push({ heading: "Table", items: [normalized.table.title] });
  }
  if (normalized.image !== undefined) {
    sections.push({ heading: "Image", items: [normalized.image.caption] });
  }
  sections.push({
    heading: "Citations",
    items: normalized.citations.map(
      (citation, index) =>
        `${index + 1}. ${citation.title} - ${citation.url} (accessed ${citation.accessedAt.slice(0, 10)})`,
    ),
  });
  sections.push({ heading: "Disclosure", items: [normalized.disclosure] });
  return {
    disclosure: normalized.disclosure,
    generatedAt: normalized.generatedAt,
    reportDate: normalized.reportDate,
    sections,
    title: normalized.title,
    requestedBy: normalized.requestedBy ?? "Authorized user",
  };
}

function hexColor(module: PdfLibAdapter, value: string): PdfColor {
  return module.rgb(
    Number.parseInt(value.slice(1, 3), 16) / 255,
    Number.parseInt(value.slice(3, 5), 16) / 255,
    Number.parseInt(value.slice(5, 7), 16) / 255,
  );
}

function wrapText(text: string, font: PdfFont, size: number, maximumWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of pdfText(text).split("\n")) {
    const words = paragraph.split(/\s+/u).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const candidate = line.length === 0 ? word : `${line} ${word}`;
      if (font.widthOfTextAtSize(candidate, size) <= maximumWidth) {
        line = candidate;
        continue;
      }
      if (line.length > 0) lines.push(line);
      if (font.widthOfTextAtSize(word, size) <= maximumWidth) {
        line = word;
        continue;
      }
      let fragment = "";
      for (const character of word) {
        if (font.widthOfTextAtSize(`${fragment}${character}`, size) > maximumWidth) {
          if (fragment.length > 0) lines.push(fragment);
          fragment = character;
        } else {
          fragment += character;
        }
      }
      line = fragment;
    }
    if (line.length > 0) lines.push(line);
  }
  return lines;
}

async function loadPdfLib(): Promise<PdfLibAdapter> {
  return (await import("pdf-lib")) as PdfLibAdapter;
}

export async function composeBeaPdf(
  input: BeaPdfDocumentInput,
  options: BeaPdfCompositionOptions,
): Promise<Uint8Array> {
  if (!(options.logoBytes instanceof Uint8Array)) {
    throw new ArtifactValidationError("INVALID_LOGO", "The approved CPL logo is required.");
  }
  const logoHash = createHash("sha256").update(options.logoBytes).digest("hex");
  if (logoHash !== BEA_OFFICIAL_LOGO_SHA256) {
    throw new ArtifactValidationError(
      "INVALID_LOGO",
      "The supplied CPL logo does not match the approved source asset.",
    );
  }
  const normalized = normalizeInput(input);
  const pdfLib = options.pdfLib ?? (await loadPdfLib());
  const document = await pdfLib.PDFDocument.create();
  const regular = await document.embedFont(pdfLib.StandardFonts.Helvetica);
  const bold = await document.embedFont(pdfLib.StandardFonts.HelveticaBold);
  const logo = await document.embedPng(options.logoBytes);
  const navy = hexColor(pdfLib, BEA_PDF_PALETTE.navy);
  const green = hexColor(pdfLib, BEA_PDF_PALETTE.green);
  const paleGreen = hexColor(pdfLib, BEA_PDF_PALETTE.paleGreen);
  const paleNavy = hexColor(pdfLib, BEA_PDF_PALETTE.paleNavy);
  const slate = hexColor(pdfLib, BEA_PDF_PALETTE.slate);
  const white = hexColor(pdfLib, BEA_PDF_PALETTE.white);
  const blue = hexColor(pdfLib, BEA_PDF_PALETTE.blue);
  const grayBlue = hexColor(pdfLib, BEA_PDF_PALETTE.grayBlue);
  const metadataDate = new Date(normalized.generatedAt);
  document.setTitle(normalized.title);
  document.setAuthor("Cyber Pirate Labs");
  document.setSubject("Building envelope report artifact");
  document.setKeywords(["Cyber Pirate Labs", "BEA", "building envelope", "report"]);
  document.setCreator("CPL Command Center");
  document.setProducer("CPL deterministic PDF composer");
  document.setCreationDate(metadataDate);
  document.setModificationDate(metadataDate);

  const cover = document.addPage([pageWidth, pageHeight]);
  cover.drawRectangle({ color: white, height: pageHeight, width: pageWidth, x: 0, y: 0 });
  cover.drawRectangle({ color: green, height: 12, width: pageWidth, x: 0, y: pageHeight - 12 });
  cover.drawRectangle({ color: paleNavy, height: 260, width: 360, x: 252, y: 0 });
  cover.drawRectangle({ color: grayBlue, height: 170, opacity: 0.72, width: 260, x: 352, y: 0 });
  cover.drawRectangle({ color: blue, height: 7, width: 170, x: 394, y: 250 });
  const logoScale = Math.min(240 / logo.width, 110 / logo.height);
  const logoWidth = logo.width * logoScale;
  const logoHeight = logo.height * logoScale;
  cover.drawImage(logo, { height: logoHeight, width: logoWidth, x: margin, y: 602 });
  cover.drawText("BUILDING ENVELOPE REPORT", {
    color: blue,
    font: bold,
    size: 12,
    x: margin,
    y: 520,
  });
  let coverY = 478;
  for (const line of wrapText(normalized.title, bold, 28, contentWidth)) {
    cover.drawText(line, { color: navy, font: bold, size: 28, x: margin, y: coverY });
    coverY -= 34;
  }
  cover.drawText(`Report date: ${normalized.reportDate}`, {
    color: slate,
    font: regular,
    size: 11,
    x: margin,
    y: coverY - 10,
  });
  cover.drawText(`Generated: ${normalized.generatedAt}`, {
    color: slate,
    font: regular,
    size: 9,
    x: margin,
    y: coverY - 30,
  });
  cover.drawText(`Requested by: ${normalized.requestedBy ?? "Authorized user"}`, {
    color: slate,
    font: regular,
    size: 9,
    x: margin,
    y: coverY - 48,
  });
  const coverDisclosureLines = wrapText(normalized.disclosure, regular, 9, contentWidth - 28);
  const coverDisclosureHeight = Math.max(54, coverDisclosureLines.length * 12 + 28);
  cover.drawRectangle({
    color: paleGreen,
    height: coverDisclosureHeight,
    width: contentWidth,
    x: margin,
    y: 72,
  });
  cover.drawText("DISCLOSURE", {
    color: navy,
    font: bold,
    size: 9,
    x: margin + 14,
    y: 72 + coverDisclosureHeight - 18,
  });
  coverDisclosureLines.forEach((line, index) => {
    cover.drawText(line, {
      color: navy,
      font: regular,
      size: 9,
      x: margin + 14,
      y: 72 + coverDisclosureHeight - 34 - index * 12,
    });
  });

  type FlowState = { page: PdfPage; y: number };
  const createContentPage = (): FlowState => {
    const page = document.addPage([pageWidth, pageHeight]);
    page.drawRectangle({ color: navy, height: 48, width: pageWidth, x: 0, y: pageHeight - 48 });
    const headerLogoScale = Math.min(100 / logo.width, 30 / logo.height);
    const headerLogoWidth = logo.width * headerLogoScale;
    const headerLogoHeight = logo.height * headerLogoScale;
    page.drawRectangle({ color: white, height: 38, width: 132, x: margin, y: pageHeight - 43 });
    page.drawImage(logo, {
      height: headerLogoHeight,
      width: headerLogoWidth,
      x: margin + 16,
      y: pageHeight - 39,
    });
    page.drawText("OPERATIONS COMMAND CENTER", {
      color: white,
      font: bold,
      size: 9,
      x: 354,
      y: pageHeight - 30,
    });
    return { page, y: contentTop };
  };
  let flow = createContentPage();
  const ensureSpace = (height: number): void => {
    if (flow.y - height < contentBottom) flow = createContentPage();
  };
  const heading = (value: string): void => {
    ensureSpace(34);
    flow.page.drawText(pdfText(value), { color: navy, font: bold, size: 16, x: margin, y: flow.y });
    flow.page.drawLine({
      color: green,
      end: { x: margin + contentWidth, y: flow.y - 8 },
      start: { x: margin, y: flow.y - 8 },
      thickness: 2,
    });
    flow.y -= 30;
  };
  const paragraph = (
    value: string,
    options: {
      readonly color?: PdfColor;
      readonly font?: PdfFont;
      readonly indent?: number;
      readonly size?: number;
    } = {},
  ): void => {
    const size = options.size ?? 10;
    const lineHeight = size + 4;
    const indent = options.indent ?? 0;
    const selectedFont = options.font ?? regular;
    for (const line of wrapText(value, selectedFont, size, contentWidth - indent)) {
      ensureSpace(lineHeight);
      flow.page.drawText(line, {
        color: options.color ?? slate,
        font: selectedFont,
        size,
        x: margin + indent,
        y: flow.y,
      });
      flow.y -= lineHeight;
    }
    flow.y -= 6;
  };

  heading("Executive summary");
  paragraph(normalized.summary, { size: 11 });
  heading("Findings");
  for (const [index, finding] of normalized.findings.entries()) {
    ensureSpace(68);
    const severityColor =
      finding.severity === "info" ? slate : finding.severity === "attention" ? green : navy;
    flow.page.drawRectangle({
      color: severityColor,
      height: 44,
      width: 5,
      x: margin,
      y: flow.y - 34,
    });
    paragraph(`${index + 1}. ${finding.title} [${finding.severity.toUpperCase()}]`, {
      color: navy,
      font: bold,
      indent: 14,
      size: 11,
    });
    paragraph(finding.detail, { indent: 14 });
  }

  if (normalized.chart !== undefined) {
    const chart = normalized.chart;
    heading(chart.title);
    paragraph(
      `Data status: ${chart.provenance.dataStatus}. Calculation notes: ${chart.provenance.calculationNotes}`,
      { size: 9 },
    );
    ensureSpace(228);
    const chartHeight = 190;
    const chartTop = flow.y;
    const chartBottom = chartTop - chartHeight;
    flow.page.drawRectangle({
      color: paleNavy,
      height: chartHeight,
      width: contentWidth,
      x: margin,
      y: chartBottom,
    });
    const values = chart.series.flatMap((point) =>
      point.secondaryValue === undefined ? [point.value] : [point.value, point.secondaryValue],
    );
    const minimum = Math.min(0, ...values);
    const maximum = Math.max(0, ...values);
    const span = maximum - minimum || 1;
    const graphLeft = margin + 48;
    const graphRight = margin + contentWidth - 18;
    const graphBottom = chartBottom + 36;
    const graphTop = chartTop - 24;
    const zeroY = graphBottom + ((0 - minimum) / span) * (graphTop - graphBottom);
    flow.page.drawLine({
      color: slate,
      end: { x: graphRight, y: zeroY },
      start: { x: graphLeft, y: zeroY },
      thickness: 1,
    });
    if (chart.type === "single_metric") {
      const point = chart.series[0]!;
      flow.page.drawText(`${point.value}${chart.unit === undefined ? "" : ` ${chart.unit}`}`, {
        color: navy,
        font: bold,
        size: 30,
        x: graphLeft,
        y: chartBottom + 86,
      });
      flow.page.drawText(pdfText(point.label), {
        color: slate,
        font: regular,
        size: 10,
        x: graphLeft,
        y: chartBottom + 66,
      });
    } else {
      const widthPerPoint = (graphRight - graphLeft) / chart.series.length;
      const pointCoordinates = chart.series.map((point, index) => {
        const x = graphLeft + widthPerPoint * index + widthPerPoint / 2;
        const y = graphBottom + ((point.value - minimum) / span) * (graphTop - graphBottom);
        return { point, x, y };
      });
      const lineLike = new Set(["line", "area", "scatter", "timeline"] as const).has(
        chart.type as "line",
      );
      if (lineLike) {
        pointCoordinates.forEach((coordinate, index) => {
          const previous = pointCoordinates[index - 1];
          if (previous !== undefined) {
            flow.page.drawLine({
              color: green,
              end: { x: coordinate.x, y: coordinate.y },
              start: { x: previous.x, y: previous.y },
              thickness: 2,
            });
          }
          flow.page.drawRectangle({
            color: navy,
            height: 6,
            width: 6,
            x: coordinate.x - 3,
            y: coordinate.y - 3,
          });
        });
      } else {
        const barWidth = Math.max(8, Math.min(34, widthPerPoint * 0.58));
        pointCoordinates.forEach(({ point, x, y }) => {
          const barY = Math.min(y, zeroY);
          flow.page.drawRectangle({
            color: green,
            height: Math.max(1, Math.abs(y - zeroY)),
            width: barWidth,
            x: x - barWidth / 2,
            y: barY,
          });
          flow.page.drawText(String(point.value), {
            color: navy,
            font: bold,
            size: 8,
            x: x - barWidth / 2,
            y: y >= zeroY ? y + 4 : y - 11,
          });
        });
      }
      pointCoordinates.forEach(({ point, x }) => {
        const label = pdfText(point.label).slice(0, 16);
        flow.page.drawText(label, {
          color: slate,
          font: regular,
          size: 7,
          x: x - Math.min(22, regular.widthOfTextAtSize(label, 7) / 2),
          y: chartBottom + 17,
        });
      });
    }
    flow.y = chartBottom - 20;
    const mappedSources = chart.provenance.sourceMapping
      .map((mapping) => mapping.citationUrl)
      .filter((url, index, all) => all.indexOf(url) === index)
      .join(", ");
    paragraph(`Chart sources: ${mappedSources}`, { size: 8 });
  }

  if (normalized.table !== undefined) {
    heading(normalized.table.title);
    const table = normalized.table;
    const columnWidth = contentWidth / table.columns.length;
    const drawTableHeader = (): void => {
      ensureSpace(26);
      flow.page.drawRectangle({
        color: navy,
        height: 22,
        width: contentWidth,
        x: margin,
        y: flow.y - 16,
      });
      table.columns.forEach((column, index) => {
        flow.page.drawText(pdfText(column).slice(0, 24), {
          color: white,
          font: bold,
          size: 8,
          x: margin + index * columnWidth + 5,
          y: flow.y - 9,
        });
      });
      flow.y -= 22;
    };
    drawTableHeader();
    for (const [rowIndex, row] of table.rows.entries()) {
      const wrappedCells = row.map((cell) =>
        wrapText(cell, regular, 8, columnWidth - 10).slice(0, 3),
      );
      const rowHeight = Math.max(
        22,
        Math.max(...wrappedCells.map((lines) => lines.length)) * 10 + 8,
      );
      if (flow.y - rowHeight - 2 < contentBottom) {
        flow = createContentPage();
        drawTableHeader();
      }
      if (rowIndex % 2 === 0) {
        flow.page.drawRectangle({
          color: paleNavy,
          height: rowHeight,
          width: contentWidth,
          x: margin,
          y: flow.y - rowHeight + 6,
        });
      }
      wrappedCells.forEach((lines, index) => {
        lines.forEach((line, lineIndex) => {
          flow.page.drawText(line, {
            color: navy,
            font: regular,
            size: 8,
            x: margin + index * columnWidth + 5,
            y: flow.y - 9 - lineIndex * 10,
          });
        });
      });
      flow.y -= rowHeight;
    }
    flow.y -= 12;
  }

  if (normalized.image !== undefined) {
    heading("Inspection image");
    const embeddedImage =
      normalized.image.mimeType === "image/png"
        ? await document.embedPng(normalized.image.bytes)
        : await document.embedJpg(normalized.image.bytes);
    const imageWidth = Math.min(contentWidth, embeddedImage.width);
    const imageHeight = Math.min(280, (embeddedImage.height / embeddedImage.width) * imageWidth);
    ensureSpace(imageHeight + 42);
    flow.page.drawImage(embeddedImage, {
      height: imageHeight,
      width: imageWidth,
      x: margin + (contentWidth - imageWidth) / 2,
      y: flow.y - imageHeight,
    });
    flow.y -= imageHeight + 10;
    paragraph(normalized.image.caption, { size: 9 });
    paragraph(`Alternative text: ${normalized.image.altText}`, { size: 8 });
  }

  heading("Citations");
  normalized.citations.forEach((citation, index) => {
    paragraph(
      `${index + 1}. ${citation.title} | ${citation.url} | accessed ${citation.accessedAt.slice(0, 10)}`,
      { size: 9 },
    );
  });
  heading("Disclosure");
  paragraph(normalized.disclosure, { color: navy, font: bold, size: 10 });

  const pages = document.getPages();
  pages.forEach((page, index) => {
    const { width } = page.getSize();
    page.drawLine({
      color: green,
      end: { x: width - margin, y: 40 },
      start: { x: margin, y: 40 },
      thickness: 1,
    });
    page.drawText("Cyber Pirate Labs | CPL Command Center", {
      color: index === 0 ? white : slate,
      font: regular,
      size: 7,
      x: margin,
      y: 25,
    });
    const pageNumber = `Page ${index + 1} of ${pages.length}`;
    page.drawText(pageNumber, {
      color: index === 0 ? white : slate,
      font: bold,
      size: 7,
      x: width - margin - bold.widthOfTextAtSize(pageNumber, 7),
      y: 25,
    });
  });

  return document.save({ addDefaultPage: false, useObjectStreams: false });
}
