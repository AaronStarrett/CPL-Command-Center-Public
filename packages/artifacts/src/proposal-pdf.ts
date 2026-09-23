import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from "pdf-lib";
import type { CplApprovedProposalPdf } from "@bea/domain/cpl-commercial";

export const CPL_PROPOSAL_PDF_RENDERER_VERSION = "cpl-proposal-pdf-v1";

export class CplProposalPdfError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CplProposalPdfError";
  }
}
const invalid = (): never => {
  throw new CplProposalPdfError(
    "CPL_PROPOSAL_PDF_INVALID",
    "The approved proposal PDF data is invalid.",
  );
};
const logoInvalid = (): never => {
  throw new CplProposalPdfError(
    "CPL_PROPOSAL_PDF_LOGO_INVALID",
    "Use a valid embedded PNG or JPEG logo, at most 128 KiB and 2048 pixels per side.",
  );
};
const WIDTH = 612,
  HEIGHT = 792,
  MARGIN = 48,
  BOTTOM = 64,
  CONTENT = WIDTH - 2 * MARGIN;
const INK = rgb(0.1, 0.17, 0.23),
  MUTED = rgb(0.34, 0.39, 0.43),
  LINE = rgb(0.82, 0.85, 0.87),
  PALE = rgb(0.95, 0.96, 0.97);
const currencies = new Set(["USD", "CAD", "EUR", "GBP", "AUD", "NZD"]);

/** Exact integer formatting; never introduce floating point monetary rounding. */
function money(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) return invalid();
  const raw = String(value).padStart(3, "0");
  return raw.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/gu, ",") + "." + raw.slice(-2);
}
function integer(value: unknown): bigint {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 1_000_000_000_000
  )
    return invalid();
  return BigInt(value);
}
function verifyTotals(input: CplApprovedProposalPdf): void {
  const { content, totals } = input;
  if (
    !currencies.has(content.currency) ||
    totals.currency !== content.currency ||
    !Array.isArray(content.lineItems) ||
    content.lineItems.length < 1 ||
    content.lineItems.length > 200 ||
    !Array.isArray(totals.lineTotalsMinor) ||
    totals.lineTotalsMinor.length !== content.lineItems.length
  )
    invalid();
  let subtotal = 0n;
  content.lineItems.forEach((item, index) => {
    if (typeof item.quantity !== "string" || !/^\d{1,9}(?:\.\d{1,3})?$/u.test(item.quantity))
      invalid();
    const [whole, fraction = ""] = item.quantity.split(".");
    const quantity = BigInt(whole!) * 1000n + BigInt(fraction.padEnd(3, "0"));
    if (quantity <= 0n) invalid();
    const line = (quantity * integer(item.unitPriceMinor) + 500n) / 1000n;
    if (integer(totals.lineTotalsMinor[index]) !== line) invalid();
    subtotal += line;
  });
  const discount = integer(content.discountMinor),
    rate = integer(content.taxBasisPoints);
  if (discount > subtotal || rate > 10000n) invalid();
  const taxable = subtotal - discount,
    tax = (taxable * rate + 5000n) / 10000n;
  if (
    integer(totals.subtotalMinor) !== subtotal ||
    integer(totals.discountMinor) !== discount ||
    integer(totals.taxableMinor) !== taxable ||
    integer(totals.taxMinor) !== tax ||
    integer(totals.totalMinor) !== taxable + tax
  )
    invalid();
}

/** Check encoded size and dimensions before the PDF library decodes pixels.
 * Animation and remote sources are refused; no fetch or filesystem lookup exists. */
function embeddedLogo(value: string): {
  bytes: Uint8Array;
  mime: "png" | "jpeg";
  width: number;
  height: number;
} {
  if (typeof value !== "string" || value.length > 175000) return logoInvalid();
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(value);
  if (!match || match[2]!.length % 4 !== 0) return logoInvalid();
  let bytes = Buffer.from(match[2]!, "base64");
  if (bytes.length > 128 * 1024 || bytes.toString("base64") !== match[2]) return logoInvalid();
  let width = 0,
    height = 0;
  if (match[1] === "png") {
    if (
      bytes.length < 33 ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(8) !== 13 ||
      bytes.toString("ascii", 12, 16) !== "IHDR"
    )
      return logoInvalid();
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
    const depths: Record<number, readonly number[]> = {
      0: [1, 2, 4, 8, 16],
      2: [8, 16],
      3: [1, 2, 4, 8],
      4: [8, 16],
      6: [8, 16],
    };
    if (
      !depths[bytes[25]!]?.includes(bytes[24]!) ||
      bytes[26] !== 0 ||
      bytes[27] !== 0 ||
      ![0, 1].includes(bytes[28]!)
    )
      return logoInvalid();
    const pixelChunks = [bytes.subarray(0, 8)];
    let offset = 8,
      ended = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset),
        kind = bytes.toString("ascii", offset + 4, offset + 8);
      if (
        offset + length + 12 > bytes.length ||
        ["acTL", "fcTL", "fdAT"].includes(kind) ||
        (kind === "IHDR" && offset !== 8) ||
        (kind === "IEND" && length !== 0)
      )
        return logoInvalid();
      // The pixel decoder must not read unbounded textual metadata or a second
      // header that can replace the dimensions checked before decompression.
      // Only image-critical data and transparency enter the PDF; input is untouched.
      if (["IHDR", "PLTE", "tRNS", "IDAT", "IEND"].includes(kind))
        pixelChunks.push(bytes.subarray(offset, offset + length + 12));
      offset += length + 12;
      if (kind === "IEND") {
        ended = true;
        break;
      }
    }
    if (!ended || offset !== bytes.length) return logoInvalid();
    bytes = Buffer.concat(pixelChunks);
  } else {
    if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) return logoInvalid();
    let offset = 2;
    const frame = new Set([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207]);
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 255) return logoInvalid();
      while (bytes[offset] === 255) offset++;
      if (offset + 3 > bytes.length) return logoInvalid();
      const marker = bytes[offset++]!;
      if (marker === 217 || marker === 218) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return logoInvalid();
      if (frame.has(marker)) {
        if (length < 8) return logoInvalid();
        height = bytes.readUInt16BE(offset + 3);
        width = bytes.readUInt16BE(offset + 5);
        break;
      }
      offset += length;
    }
  }
  if (width < 1 || height < 1 || width > 2048 || height > 2048) return logoInvalid();
  return { bytes, mime: match[1] as "png" | "jpeg", width, height };
}

function wrap(value: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of value.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/[ \t]+/u).filter(Boolean)) {
      if (font.widthOfTextAtSize(line ? line + " " + word : word, size) <= width) {
        line = line ? line + " " + word : word;
        continue;
      }
      if (line) {
        lines.push(line);
        line = "";
      }
      for (const character of word) {
        if (font.widthOfTextAtSize(line + character, size) > width) {
          lines.push(line);
          line = "";
        }
        line += character;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** The only input is the versioned public projection. Unknown properties are
 * never enumerated, serialized or rendered. No company/owner/CPL defaults exist. */
export async function renderCplProposalPdf(input: CplApprovedProposalPdf): Promise<Uint8Array> {
  if (!input || !input.company || !input.customer || !input.site || !input.content || !input.totals)
    return invalid();
  verifyTotals(input);
  if (
    !Number.isSafeInteger(input.version) ||
    input.version < 1 ||
    typeof input.approvedAt !== "string" ||
    !Number.isFinite(Date.parse(input.approvedAt)) ||
    new Date(input.approvedAt).toISOString() !== input.approvedAt
  )
    invalid();
  const document = await PDFDocument.create({ updateMetadata: false });
  const regular = await document.embedFont(StandardFonts.Helvetica),
    bold = await document.embedFont(StandardFonts.HelveticaBold);
  const supported = new Set(regular.getCharacterSet());
  let textLength = 0;
  const text = (value: unknown, max = 30000): string => {
    if (typeof value !== "string" || value.length > max) return invalid();
    const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    textLength += normalized.length;
    if (textLength > 300000) return invalid();
    for (const character of normalized) {
      if (character === "\n" || character === "\t") continue;
      if (!supported.has(character.codePointAt(0)!))
        throw new CplProposalPdfError(
          "CPL_PROPOSAL_PDF_UNSUPPORTED_CHARACTER",
          "This PDF font supports Western European text and common smart punctuation. Replace unsupported characters before approving the proposal.",
        );
    }
    return normalized;
  };
  const reference = text(input.reference, 120),
    company = input.company,
    content = input.content;
  if (typeof company.accentColor !== "string" || !/^#[0-9a-f]{6}$/iu.test(company.accentColor))
    invalid();
  const accent = rgb(
    ...([1, 3, 5].map(
      (offset) => Number.parseInt(company.accentColor.slice(offset, offset + 2), 16) / 255,
    ) as [number, number, number]),
  );
  const businessName = text(company.businessName, 240),
    title = text(content.title, 240);
  if (!reference.trim() || !businessName.trim() || !title.trim()) invalid();
  const companyLines = [
    businessName,
    text(company.address, 2000),
    text(company.email, 254),
    text(company.phone, 80),
  ].filter(Boolean);
  const customerLines = [
    text(input.customer.name, 240),
    text(input.customer.contactName, 240),
    text(input.customer.contactEmail ?? "", 254),
    text(input.customer.contactPhone, 80),
  ].filter(Boolean);
  const site = [text(input.site.name, 240), text(input.site.address, 2000)]
    .filter(Boolean)
    .join("\n");
  const sections = [
    ["Overview", text(content.summary)],
    ["Scope of work", text(content.scope)],
    ["Deliverables", text(content.deliverables)],
    ["Assumptions", text(content.assumptions)],
    ["Exclusions", text(content.exclusions)],
    ["Terms", text(content.terms)],
    ["Payment terms", text(content.paymentTerms)],
    ["Customer notes", text(content.customerNotes)],
  ] as const;
  const schedule: string[] = [];
  for (const [label, value] of [
    ["Planned start", content.startDate],
    ["Planned completion", content.endDate],
  ] as const) {
    if (value !== null) {
      if (
        typeof value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value
      )
        invalid();
      schedule.push(`${label}: ${value}`);
    }
  }
  const scheduleDescription = text(content.schedule);
  if (!Array.isArray(content.sections) || content.sections.length > 30) invalid();
  const customSections = content.sections.map((section) => ({
    title: text(section.title, 240),
    body: text(section.body, 20000),
  }));
  if (scheduleDescription) schedule.push(scheduleDescription);
  const items = content.lineItems.map((item, index) => ({
    description: text(`${index + 1}. ${item.description}`, 6000),
    service: text(item.serviceCode, 120),
    quantity: item.quantity,
    unit: text(item.unit, 80),
    price: money(item.unitPriceMinor),
    total: money(input.totals.lineTotalsMinor[index]!),
  }));
  let logo: PDFImage | undefined;
  if (company.logoDataUrl !== null) {
    const validated = embeddedLogo(company.logoDataUrl);
    try {
      logo =
        validated.mime === "png"
          ? await document.embedPng(validated.bytes)
          : await document.embedJpg(validated.bytes);
      if (logo.width !== validated.width || logo.height !== validated.height) return logoInvalid();
    } catch {
      return logoInvalid();
    }
  }
  document.setTitle(title);
  document.setAuthor(businessName);
  document.setSubject(`Proposal ${reference} - approved version ${input.version}`);
  document.setCreator("Proposal document renderer");
  document.setProducer("Deterministic proposal PDF");
  document.setCreationDate(new Date(input.approvedAt));
  document.setModificationDate(new Date(input.approvedAt));
  document.setKeywords(["Proposal", reference, `Version ${input.version}`]);
  // newPage initializes this before any content or footer is drawn.
  let page!: PDFPage;
  let y = 0;
  const draw = (
    value: string,
    x: number,
    baseline: number,
    size = 10,
    font = regular,
    color = INK,
  ) => page.drawText(value, { x, y: baseline, size, font, color });
  const newPage = () => {
    if (document.getPageCount() >= 200)
      throw new CplProposalPdfError(
        "CPL_PROPOSAL_PDF_TOO_LARGE",
        "The proposal exceeds the 200-page PDF limit. Shorten it before approval.",
      );
    page = document.addPage([WIDTH, HEIGHT]);
    const brandX = logo ? MARGIN + 112 : MARGIN,
      brandWidth = CONTENT - (logo ? 112 : 0) - 164;
    const brand = wrap(businessName, bold, 10, brandWidth);
    const metadata = [
      ...wrap(reference, bold, 8, 150),
      `Approved version ${input.version}`,
      `Approved ${input.approvedAt.slice(0, 10)}`,
    ];
    const headerHeight = Math.max(logo ? 34 : 0, brand.length * 12, metadata.length * 11);
    if (logo) {
      const scale = Math.min(96 / logo.width, 34 / logo.height);
      page.drawImage(logo, {
        x: MARGIN,
        y: HEIGHT - MARGIN - logo.height * scale,
        width: logo.width * scale,
        height: logo.height * scale,
      });
    }
    brand.forEach((line, i) => draw(line, brandX, HEIGHT - MARGIN - 10 - i * 12, 10, bold));
    metadata.forEach((line, i) =>
      draw(
        line,
        WIDTH - MARGIN - 150,
        HEIGHT - MARGIN - 8 - i * 11,
        8,
        i === 0 ? bold : regular,
        MUTED,
      ),
    );
    y = HEIGHT - MARGIN - headerHeight - 18;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: WIDTH - MARGIN, y },
      color: accent,
      thickness: 1.5,
    });
    y -= 24;
  };
  const ensure = (height: number) => {
    if (y - height < BOTTOM) newPage();
  };
  const paragraph = (value: string, size = 10, font = regular) => {
    for (const line of wrap(value, font, size, CONTENT)) {
      ensure(size + 4);
      draw(line, MARGIN, y, size, font);
      y -= size + 4;
    }
    y -= 8;
  };
  const heading = (value: string) => {
    const lines = wrap(value, bold, 12, CONTENT);
    ensure(lines.length * 16 + 32);
    for (const line of lines) {
      draw(line, MARGIN, y, 12, bold);
      y -= 16;
    }
    y -= 5;
  };
  newPage();
  paragraph("PROPOSAL", 9, bold);
  paragraph(title, 22, bold);
  const left = customerLines.flatMap((value) => wrap(value, regular, 9, CONTENT / 2 - 24));
  const right = companyLines.flatMap((value) => wrap(value, regular, 9, CONTENT / 2 - 24));
  const partyRows = Math.max(left.length, right.length);
  // Long addresses may span pages just like narrative content.
  let partyOffset = 0;
  while (partyOffset < partyRows) {
    ensure(58);
    draw(partyOffset ? "Prepared for (continued)" : "Prepared for", MARGIN, y, 9, bold);
    draw(
      partyOffset ? "Prepared by (continued)" : "Prepared by",
      MARGIN + CONTENT / 2 + 8,
      y,
      9,
      bold,
    );
    y -= 18;
    const count = Math.min(partyRows - partyOffset, Math.floor((y - BOTTOM) / 13));
    for (let line = 0; line < count; line++) {
      draw(left[partyOffset + line] ?? "", MARGIN, y, 9);
      draw(right[partyOffset + line] ?? "", MARGIN + CONTENT / 2 + 8, y, 9);
      y -= 13;
    }
    partyOffset += count;
    if (partyOffset < partyRows) newPage();
  }
  y -= 12;
  if (site) {
    heading("Service location");
    paragraph(site);
  }
  for (const [label, value] of sections.slice(0, 3))
    if (value) {
      heading(label);
      paragraph(value);
    }
  heading(`Pricing - ${content.currency}`);
  const widths = [238, 42, 48, 94, 94],
    starts = [MARGIN, MARGIN + 238, MARGIN + 280, MARGIN + 328, MARGIN + 422];
  const tableHeader = () => {
    ensure(40);
    page.drawRectangle({ x: MARGIN, y: y - 21, width: CONTENT, height: 25, color: PALE });
    ["Description", "Qty", "Unit", "Unit price", "Amount"].forEach((label, i) =>
      draw(label, starts[i]! + 5, y - 12, 8, bold),
    );
    y -= 31;
  };
  tableHeader();
  items.forEach((item, index) => {
    const cells = [
      item.description + (item.service ? `\nService: ${item.service}` : ""),
      item.quantity,
      item.unit,
      item.price,
      item.total,
    ].map((cell, column) => wrap(cell, regular, 9, widths[column]! - 10));
    const lines = Math.max(...cells.map((cell) => cell.length));
    let offset = 0;
    while (offset < lines) {
      if (y - 24 < BOTTOM) {
        newPage();
        tableHeader();
      }
      if (offset > 0) {
        draw(`Item ${index + 1} (continued)`, MARGIN + 5, y, 8, bold, MUTED);
        y -= 13;
      }
      const count = Math.min(lines - offset, Math.floor((y - BOTTOM - 6) / 13));
      if (count < 1) {
        newPage();
        tableHeader();
        continue;
      }
      for (let line = 0; line < count; line++)
        cells.forEach((cell, column) => {
          const value = cell[offset + line] ?? "";
          const x =
            column >= 3
              ? starts[column]! + widths[column]! - 5 - regular.widthOfTextAtSize(value, 9)
              : starts[column]! + 5;
          draw(value, x, y - line * 13, 9);
        });
      y -= count * 13 + 8;
      offset += count;
      if (offset < lines) {
        newPage();
        tableHeader();
      }
    }
    page.drawLine({
      start: { x: MARGIN, y: y + 3 },
      end: { x: WIDTH - MARGIN, y: y + 3 },
      color: LINE,
      thickness: 0.5,
    });
    y -= 10;
  });
  const totals = input.totals;
  ensure(142);
  y -= 9;
  for (const [label, value] of [
    ["Subtotal", totals.subtotalMinor],
    ["Discount", totals.discountMinor],
    ["Taxable amount", totals.taxableMinor],
    [`Tax (${(content.taxBasisPoints / 100).toFixed(2)}%)`, totals.taxMinor],
    [`Total (${totals.currency})`, totals.totalMinor],
  ] as const) {
    const total = label.startsWith("Total"),
      font = total ? bold : regular,
      size = total ? 13 : 10;
    if (total)
      page.drawRectangle({
        x: MARGIN + 260,
        y: y - 8,
        width: CONTENT - 260,
        height: 25,
        color: PALE,
      });
    draw(label, MARGIN + 272, y, size, font);
    const amount = (label === "Discount" && value > 0 ? "-" : "") + money(value);
    draw(amount, WIDTH - MARGIN - 8 - font.widthOfTextAtSize(amount, size), y, size, font);
    y -= 24;
  }
  y -= 8;
  if (schedule.length) {
    heading("Schedule");
    paragraph(schedule.join("\n"));
  }
  for (const section of customSections) {
    heading(section.title);
    paragraph(section.body);
  }
  for (const [label, value] of sections.slice(3))
    if (value) {
      heading(label);
      paragraph(value);
    }
  const pages = document.getPages();
  pages.forEach((current, index) => {
    current.drawLine({
      start: { x: MARGIN, y: 43 },
      end: { x: WIDTH - MARGIN, y: 43 },
      color: LINE,
      thickness: 0.6,
    });
    const footer = `Approved version ${input.version} - ${input.approvedAt.slice(0, 10)}`,
      number = `Page ${index + 1} of ${pages.length}`;
    current.drawText(footer, { x: MARGIN, y: 29, font: regular, size: 8, color: MUTED });
    current.drawText(number, {
      x: WIDTH - MARGIN - regular.widthOfTextAtSize(number, 8),
      y: 29,
      font: regular,
      size: 8,
      color: MUTED,
    });
  });
  return document.save({ addDefaultPage: false, useObjectStreams: false, objectsPerTick: 50 });
}
