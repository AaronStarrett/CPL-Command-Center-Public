import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import {
  PDFDocument,
  StandardFonts,
  rgb,
  pushGraphicsState,
  popGraphicsState,
  rectangle,
  clip,
  endPath,
  type PDFImage,
  type PDFPage,
  type PDFFont,
} from "pdf-lib";
import {
  projectCplPhotoAnnotations,
  validateCplPhotoAnnotations,
  type CplPhotoAnnotations,
} from "./cpl-photo-annotations.js";

export const CPL_REPORT_PDF_RENDERER_VERSION = "cpl-report-pdf-v1";
export type CplReportPdfSectionKey =
  "scope" | "summary" | "limitations" | "visits" | "conclusion" | "sections";
const DEFAULT_SECTION_ORDER: readonly CplReportPdfSectionKey[] = [
  "scope",
  "summary",
  "limitations",
  "visits",
  "conclusion",
  "sections",
];
/** Only the approved, explicitly public projection enters this renderer. Source
 * identifiers may exist on caller objects but are never enumerated or printed. */
export interface CplApprovedReportPdf {
  readonly sectionOrder?: readonly CplReportPdfSectionKey[];
  readonly sections?: readonly {
    readonly id: string;
    readonly title: string;
    readonly body: string;
  }[];
  readonly reference: string;
  readonly version: number;
  readonly approvedAt: string;
  readonly title: string;
  readonly scope: string;
  readonly limitations: string;
  readonly summary: string;
  readonly conclusion: string;
  readonly company: {
    readonly businessName: string;
    readonly email: string;
    readonly phone: string;
    readonly address: string;
    readonly accentColor: string;
    readonly logoDataUrl: string | null;
    readonly brandingVersion: number;
  };
  readonly project: {
    readonly reference: string;
    readonly name: string;
    readonly customerName: string;
    readonly siteName: string;
    readonly siteAddress: string;
  };
  readonly visits: readonly {
    readonly title: string;
    readonly date: string | null;
    readonly timeZone: string;
    readonly personnel: readonly string[];
    readonly observations: readonly {
      readonly title: string;
      readonly category: string;
      readonly priority: string;
      readonly location: string;
      readonly description: string;
      readonly followUp: string;
      readonly revision: number;
      readonly photos: readonly CplReportPdfPhoto[];
    }[];
  }[];
}
export interface CplReportPdfPhoto {
  readonly caption: string;
  readonly layout: "large" | "pair" | "appendix";
  readonly sha256: string;
  readonly bytes: Uint8Array;
  readonly annotations: CplPhotoAnnotations;
}
interface PreparedPhoto {
  image: PDFImage;
  annotations: CplPhotoAnnotations;
  layout: CplReportPdfPhoto["layout"];
  caption: string;
  number: number;
}
interface PreparedVisit {
  title: string;
  date: string | null;
  timeZone: string;
  personnel: string[];
  observations: {
    title: string;
    category: string;
    priority: string;
    location: string;
    description: string;
    followUp: string;
    photos: PreparedPhoto[];
  }[];
}
export class CplReportPdfError extends Error {
  constructor(
    readonly code:
      | "CPL_REPORT_PDF_INVALID"
      | "CPL_REPORT_PDF_IMAGE_INVALID"
      | "CPL_REPORT_PDF_UNSUPPORTED_CHARACTER"
      | "CPL_REPORT_PDF_TOO_LARGE",
  ) {
    super(
      code === "CPL_REPORT_PDF_UNSUPPORTED_CHARACTER"
        ? "This PDF supports Western European text and common smart punctuation. Replace unsupported characters before approval."
        : code,
    );
    this.name = "CplReportPdfError";
  }
}
function invalid(): never {
  throw new CplReportPdfError("CPL_REPORT_PDF_INVALID");
}
function imageInvalid(): never {
  throw new CplReportPdfError("CPL_REPORT_PDF_IMAGE_INVALID");
}
function tooLarge(): never {
  throw new CplReportPdfError("CPL_REPORT_PDF_TOO_LARGE");
}
const WIDTH = 612,
  HEIGHT = 792,
  MARGIN = 48,
  BOTTOM = 60,
  CONTENT = WIDTH - 2 * MARGIN;
const INK = rgb(0.09, 0.16, 0.21),
  MUTED = rgb(0.33, 0.39, 0.44),
  LINE = rgb(0.8, 0.85, 0.87),
  PALE = rgb(0.97, 0.98, 0.985);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Same defensive header/chunk strategy as the proven proposal renderer. Only
 * bounded critical pixel chunks reach the PDF decoder; textual metadata does not. */
function pngPixels(input: Uint8Array, side: number, maximumBytes: number) {
  const bytes = Buffer.from(input);
  if (
    bytes.length < 33 ||
    bytes.length > maximumBytes ||
    !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  )
    imageInvalid();
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  const depths: Record<number, readonly number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  if (
    !width ||
    !height ||
    width > side ||
    height > side ||
    !depths[bytes[25]!]?.includes(bytes[24]!) ||
    bytes[26] !== 0 ||
    bytes[27] !== 0 ||
    ![0, 1].includes(bytes[28]!)
  )
    imageInvalid();
  const chunks = [bytes.subarray(0, 8)];
  const compressed: Uint8Array[] = [];
  let cursor = 8,
    count = 0,
    ended = false;
  while (cursor + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(cursor),
      kind = bytes.toString("ascii", cursor + 4, cursor + 8);
    if (
      ++count > 4096 ||
      length > bytes.length - cursor - 12 ||
      ["acTL", "fcTL", "fdAT"].includes(kind) ||
      (kind === "IHDR" && cursor !== 8) ||
      (kind === "IEND" && length !== 0)
    )
      imageInvalid();
    if (["IHDR", "PLTE", "tRNS", "IDAT", "IEND"].includes(kind))
      chunks.push(bytes.subarray(cursor, cursor + length + 12));
    if (kind === "IDAT") compressed.push(bytes.subarray(cursor + 8, cursor + 8 + length));
    cursor += length + 12;
    if (kind === "IEND") {
      ended = true;
      break;
    }
  }
  if (!ended || cursor !== bytes.length) imageInvalid();
  // Bound the actual inflate as well as advertised dimensions before pdf-lib's
  // PNG decoder. Eight bytes/pixel plus scanline/interlace overhead covers PNG16.
  try {
    inflateSync(Buffer.concat(compressed), {
      maxOutputLength: width * height * 8 + (width + height) * 16 + 1024,
    });
  } catch {
    imageInvalid();
  }
  return { bytes: Buffer.concat(chunks), width, height };
}
function logoBytes(dataUrl: string) {
  if (typeof dataUrl !== "string" || dataUrl.length > 2_800_000) imageInvalid();
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(dataUrl);
  if (!match || match[2]!.length % 4 !== 0) imageInvalid();
  const bytes = Buffer.from(match[2]!, "base64");
  if (bytes.length > 2 * 1024 * 1024 || bytes.toString("base64") !== match[2]) imageInvalid();
  if (match[1] === "png")
    return { ...pngPixels(bytes, 2048, 2 * 1024 * 1024), mime: "png" as const };
  if (bytes[0] !== 255 || bytes[1] !== 216) imageInvalid();
  const kept = [bytes.subarray(0, 2)];
  let cursor = 2,
    width = 0,
    height = 0,
    ended = false;
  while (cursor + 4 <= bytes.length) {
    const start = cursor;
    if (bytes[cursor++] !== 255) imageInvalid();
    while (bytes[cursor] === 255) cursor++;
    const marker = bytes[cursor++]!;
    if (marker === 218) {
      kept.push(bytes.subarray(start));
      ended = true;
      break;
    }
    const length = bytes.readUInt16BE(cursor);
    if (length < 2 || cursor + length > bytes.length) imageInvalid();
    if ([192, 193, 194].includes(marker)) {
      if (length < 8) imageInvalid();
      height = bytes.readUInt16BE(cursor + 3);
      width = bytes.readUInt16BE(cursor + 5);
    }
    // Strip APP/COM blocks (EXIF, GPS, XMP and comments) from embedded branding.
    if (!(marker >= 224 && marker <= 239) && marker !== 254)
      kept.push(bytes.subarray(start, cursor + length));
    cursor += length;
  }
  if (!ended || !width || !height || width > 2048 || height > 2048) imageInvalid();
  return { bytes: Buffer.concat(kept), width, height, mime: "jpeg" as const };
}
function wrap(value: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of value.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/[ \t]+/u).filter(Boolean)) {
      if (font.widthOfTextAtSize(line ? `${line} ${word}` : word, size) <= width) {
        line = line ? `${line} ${word}` : word;
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
function color(hex: string) {
  if (typeof hex !== "string" || !/^#[0-9a-f]{6}$/iu.test(hex)) invalid();
  return rgb(
    ...([1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255) as [
      number,
      number,
      number,
    ]),
  );
}

export async function renderCplReportPdf(input: CplApprovedReportPdf): Promise<Uint8Array> {
  const sectionOrder = input?.sectionOrder ?? DEFAULT_SECTION_ORDER;
  if (
    !Array.isArray(sectionOrder) ||
    sectionOrder.length > 6 ||
    new Set(sectionOrder).size !== sectionOrder.length ||
    sectionOrder.some((key) => !DEFAULT_SECTION_ORDER.includes(key))
  )
    invalid();
  const showVisits = sectionOrder.includes("visits");
  if (
    !input?.company ||
    !input.project ||
    (showVisits && (!Array.isArray(input.visits) || input.visits.length > 50)) ||
    !Number.isSafeInteger(input.version) ||
    input.version < 1 ||
    !Number.isSafeInteger(input.company.brandingVersion) ||
    input.company.brandingVersion < 1 ||
    typeof input.approvedAt !== "string" ||
    !Number.isFinite(Date.parse(input.approvedAt)) ||
    new Date(input.approvedAt).toISOString() !== input.approvedAt
  )
    invalid();
  const document = await PDFDocument.create({ updateMetadata: false });
  const regular = await document.embedFont(StandardFonts.Helvetica),
    bold = await document.embedFont(StandardFonts.HelveticaBold),
    supported = new Set(regular.getCharacterSet());
  let textLength = 0;
  const text = (value: unknown, maximum = 30000): string => {
    if (typeof value !== "string" || value.length > maximum) invalid();
    const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    textLength += normalized.length;
    if (textLength > 500000) tooLarge();
    for (const character of normalized)
      if (character !== "\n" && character !== "\t" && !supported.has(character.codePointAt(0)!))
        throw new CplReportPdfError("CPL_REPORT_PDF_UNSUPPORTED_CHARACTER");
    return normalized;
  };
  const reference = text(input.reference, 120),
    title = text(input.title, 240),
    businessName = text(input.company.businessName, 240),
    accent = color(input.company.accentColor);
  if (!reference.trim() || !title.trim() || !businessName.trim()) invalid();
  const sections = new Map<CplReportPdfSectionKey, readonly [string, string]>();
  for (const [key, title] of [
    ["scope", "Scope"],
    ["summary", "Summary"],
    ["limitations", "Limitations"],
    ["conclusion", "Conclusion"],
  ] as const)
    if (sectionOrder.includes(key)) sections.set(key, [title, text(input[key])]);
  const customSections: { title: string; body: string }[] = [];
  if (sectionOrder.includes("sections") && input.sections !== undefined) {
    if (!Array.isArray(input.sections) || input.sections.length > 30) invalid();
    for (const section of input.sections)
      customSections.push({ title: text(section.title, 240), body: text(section.body) });
  }
  const projectLines = [
    text(input.project.reference, 120),
    text(input.project.name, 240),
    text(input.project.customerName, 240),
    text(input.project.siteName, 240),
    text(input.project.siteAddress, 2000),
  ].filter(Boolean);
  const contactLines = [
    text(input.company.address, 2000),
    text(input.company.email, 254),
    text(input.company.phone, 80),
  ].filter(Boolean);
  let logo: PDFImage | undefined;
  if (input.company.logoDataUrl !== null) {
    const valid = logoBytes(input.company.logoDataUrl);
    try {
      logo =
        valid.mime === "png"
          ? await document.embedPng(valid.bytes)
          : await document.embedJpg(valid.bytes);
    } catch {
      imageInvalid();
    }
    if (logo.width !== valid.width || logo.height !== valid.height) imageInvalid();
  }
  let photoCount = 0,
    observationCount = 0,
    compressedBytes = 0,
    totalPixels = 0;
  const visits: PreparedVisit[] = [];
  // An omitted visits section must not even embed unused photo objects in the PDF.
  for (const visit of showVisits ? input.visits : []) {
    if (
      !Array.isArray(visit.personnel) ||
      visit.personnel.length > 30 ||
      !Array.isArray(visit.observations)
    )
      invalid();
    if (
      visit.date !== null &&
      (typeof visit.date !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/u.test(visit.date) ||
        !Number.isFinite(Date.parse(visit.date)) ||
        new Date(visit.date).toISOString().slice(0, 10) !== visit.date)
    )
      invalid();
    const zone = text(visit.timeZone, 100);
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(0);
    } catch {
      invalid();
    }
    const observations = [];
    for (const observation of visit.observations) {
      if (
        ++observationCount > 200 ||
        !Array.isArray(observation.photos) ||
        !Number.isSafeInteger(observation.revision) ||
        observation.revision < 1
      )
        invalid();
      const photos = [];
      for (const photo of observation.photos) {
        if (++photoCount > 100) tooLarge();
        if (
          !(photo.bytes instanceof Uint8Array) ||
          !/^[a-f0-9]{64}$/u.test(photo.sha256) ||
          createHash("sha256").update(photo.bytes).digest("hex") !== photo.sha256 ||
          !["large", "pair", "appendix"].includes(photo.layout)
        )
          imageInvalid();
        compressedBytes += photo.bytes.length;
        if (compressedBytes > 96 * 1024 * 1024) tooLarge();
        const pixels = pngPixels(photo.bytes, 2400, 64 * 1024 * 1024);
        totalPixels += pixels.width * pixels.height;
        if (totalPixels > 80_000_000) tooLarge();
        let image: PDFImage;
        try {
          image = await document.embedPng(pixels.bytes);
        } catch {
          imageInvalid();
        }
        if (image.width !== pixels.width || image.height !== pixels.height) imageInvalid();
        const annotations = validateCplPhotoAnnotations(photo.annotations);
        for (const shape of annotations.shapes) if (shape.kind === "label") text(shape.text, 80);
        photos.push({
          image,
          annotations,
          layout: photo.layout,
          caption: text(photo.caption, 12000),
          number: photoCount,
        });
      }
      observations.push({
        title: text(observation.title, 240),
        category: text(observation.category, 120),
        priority: text(observation.priority, 120),
        location: text(observation.location, 1000),
        description: text(observation.description),
        followUp: text(observation.followUp),
        photos,
      });
    }
    visits.push({
      title: text(visit.title, 240),
      date: visit.date,
      timeZone: zone,
      personnel: visit.personnel.map((name: unknown) => text(name, 240)),
      observations,
    });
  }
  document.setTitle(title);
  document.setAuthor(businessName);
  document.setSubject(`Field report ${reference} - approved version ${input.version}`);
  document.setCreator("Field report renderer");
  document.setProducer("Deterministic field report PDF");
  document.setCreationDate(new Date(input.approvedAt));
  document.setModificationDate(new Date(input.approvedAt));
  document.setKeywords(["Field report", reference, `Version ${input.version}`]);
  let page!: PDFPage,
    y = 0;
  const draw = (value: string, x: number, baseline: number, size = 10, font = regular, ink = INK) =>
    page.drawText(value, { x, y: baseline, size, font, color: ink });
  const newPage = () => {
    if (document.getPageCount() >= 200) tooLarge();
    page = document.addPage([WIDTH, HEIGHT]);
    const left = logo ? MARGIN + 74 : MARGIN;
    const brand = wrap(businessName, bold, 10, CONTENT - (left - MARGIN) - 166);
    const meta = [
      ...wrap(reference, bold, 8, 150),
      `Approved version ${input.version}`,
      `Approved ${input.approvedAt.slice(0, 10)}`,
    ];
    const headerHeight = Math.max(logo ? 44 : 0, brand.length * 12, meta.length * 11);
    if (logo) {
      const scale = Math.min(60 / logo.width, 44 / logo.height);
      page.drawImage(logo, {
        x: MARGIN,
        y: HEIGHT - MARGIN - logo.height * scale,
        width: logo.width * scale,
        height: logo.height * scale,
      });
    }
    brand.forEach((line, index) => draw(line, left, HEIGHT - MARGIN - 10 - index * 12, 10, bold));
    meta.forEach((line, index) =>
      draw(
        line,
        WIDTH - MARGIN - 150,
        HEIGHT - MARGIN - 8 - index * 11,
        8,
        index ? regular : bold,
        MUTED,
      ),
    );
    y = HEIGHT - MARGIN - headerHeight - 14;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: WIDTH - MARGIN, y },
      color: accent,
      thickness: 1.5,
    });
    y -= 25;
  };
  const ensure = (height: number) => {
    if (y - height < BOTTOM) {
      newPage();
      return true;
    }
    return false;
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
    ensure(48);
    paragraph(value, 12, bold);
  };
  type RenderPhoto = (typeof visits)[number]["observations"][number]["photos"][number];
  const annotate = (
    photo: RenderPhoto,
    bounds: { x: number; y: number; width: number; height: number },
  ) => {
    page.pushOperators(
      pushGraphicsState(),
      rectangle(bounds.x, bounds.y, bounds.width, bounds.height),
      clip(),
      endPath(),
    );
    const geometry = projectCplPhotoAnnotations(photo.annotations, { ...bounds, y: 0 });
    const py = (value: number) => bounds.y + bounds.height - value;
    for (const shape of geometry) {
      const ink = color(shape.color);
      if (shape.kind === "label") {
        // Keep the complete label inside the photo. Long labels wrap; reducing
        // point size only when necessary avoids silently clipping annotation text.
        let size = Math.min(18, Math.max(6, shape.fontSize));
        let lines = wrap(shape.text, bold, size, Math.max(1, bounds.width - 4));
        while (lines.length * (size + 2) > bounds.height - 4 && size > 3) {
          size -= 0.5;
          lines = wrap(shape.text, bold, size, Math.max(1, bounds.width - 4));
        }
        if (lines.length * (size + 2) > bounds.height - 4) imageInvalid();
        const blockWidth = Math.max(...lines.map((line) => bold.widthOfTextAtSize(line, size)));
        const x = Math.max(
          bounds.x + 2,
          Math.min(shape.x, bounds.x + bounds.width - blockWidth - 2),
        );
        const top = Math.max(
          lines.length * (size + 2) + 2,
          Math.min(bounds.height - 2, bounds.height - shape.y),
        );
        lines.forEach((line, index) =>
          draw(line, x, bounds.y + top - size - index * (size + 2), size, bold, ink),
        );
      } else if (shape.kind === "arrow") {
        const start = { x: shape.x1, y: py(shape.y1) },
          end = { x: shape.x2, y: py(shape.y2) },
          thickness = Math.max(0.5, shape.strokeWidth);
        page.drawLine({ start, end, thickness, color: ink });
        const angle = Math.atan2(end.y - start.y, end.x - start.x),
          length = Math.max(5, thickness * 4);
        for (const offset of [-0.5, 0.5])
          page.drawLine({
            start: end,
            end: {
              x: end.x - length * Math.cos(angle + offset),
              y: end.y - length * Math.sin(angle + offset),
            },
            thickness,
            color: ink,
          });
      } else if (shape.kind === "rectangle")
        page.drawRectangle({
          x: shape.x,
          y: py(shape.y + shape.height),
          width: shape.width,
          height: shape.height,
          borderColor: ink,
          borderWidth: Math.max(0.5, shape.strokeWidth),
        });
      else
        page.drawEllipse({
          x: shape.x + shape.width / 2,
          y: py(shape.y + shape.height / 2),
          xScale: shape.width / 2,
          yScale: shape.height / 2,
          borderColor: ink,
          borderWidth: Math.max(0.5, shape.strokeWidth),
        });
    }
    page.pushOperators(popGraphicsState());
  };
  const photoRow = (photos: readonly RenderPhoto[], appendix = false) => {
    const gap = 16,
      width = photos.length === 2 ? (CONTENT - gap) / 2 : CONTENT,
      height = appendix ? 390 : photos.length === 2 ? 225 : 315;
    ensure(height + 64);
    photos.forEach((photo, index) => {
      const x = MARGIN + index * (width + gap);
      page.drawRectangle({
        x,
        y: y - height,
        width,
        height,
        color: PALE,
        borderColor: LINE,
        borderWidth: 0.5,
      });
      const scale = Math.min((width - 8) / photo.image.width, (height - 8) / photo.image.height);
      const bounds = {
        x: x + (width - photo.image.width * scale) / 2,
        y: y - height + (height - photo.image.height * scale) / 2,
        width: photo.image.width * scale,
        height: photo.image.height * scale,
      };
      page.drawImage(photo.image, bounds);
      annotate(photo, bounds);
    });
    y -= height + 14;
    const expanded = photos.filter((photo) => wrap(photo.caption, regular, 9, width).length > 12);
    const captions = photos.map((photo) =>
      wrap(
        `Photo ${photo.number}${expanded.includes(photo) ? " - Detailed caption follows below." : photo.caption ? ` - ${photo.caption}` : ""}`,
        regular,
        9,
        width,
      ),
    );
    const count = Math.max(...captions.map((lines) => lines.length));
    for (let row = 0; row < count; row++) {
      if (ensure(13) && row > 0) {
        draw("Photo captions (continued)", MARGIN, y, 9, bold, MUTED);
        y -= 16;
      }
      captions.forEach((lines, index) => {
        if (lines[row]) draw(lines[row]!, MARGIN + index * (width + gap), y, 9);
      });
      y -= 13;
    }
    y -= 16;
    // Long captions use the full text width, with an explicit photo number. This
    // preserves every paragraph without generating mostly empty paired columns.
    for (const photo of expanded) {
      ensure(40);
      draw(`Photo ${photo.number} - Detailed caption`, MARGIN, y, 10, bold);
      y -= 17;
      for (const line of wrap(photo.caption, regular, 9, CONTENT)) {
        if (ensure(13)) {
          draw("Photo captions (continued)", MARGIN, y, 9, bold, MUTED);
          y -= 16;
        }
        draw(line, MARGIN, y, 9);
        y -= 13;
      }
      y -= 16;
    }
  };
  newPage();
  paragraph("FIELD REPORT", 9, bold);
  paragraph(title, 22, bold);
  projectLines.forEach((line) => paragraph(line, 10));
  if (contactLines.length) paragraph(contactLines.join(" | "), 8);
  const appendix: Array<{ photo: RenderPhoto; context: string }> = [];
  const renderVisits = () => {
    for (const [visitIndex, visit] of visits.entries()) {
      heading(`Visit ${visitIndex + 1}: ${visit.title}`);
      paragraph(
        [
          visit.date ?? "Date not recorded",
          visit.timeZone,
          visit.personnel.length ? `Personnel: ${visit.personnel.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join(" | "),
        9,
      );
      for (const [observationIndex, observation] of visit.observations.entries()) {
        heading(`${visitIndex + 1}.${observationIndex + 1} ${observation.title}`);
        const details = [
          observation.category,
          observation.priority ? `Priority: ${observation.priority}` : "",
          observation.location,
        ].filter(Boolean);
        if (details.length) paragraph(details.join(" | "), 9);
        if (observation.description) paragraph(observation.description);
        if (observation.followUp) {
          paragraph("Recommended follow-up", 10, bold);
          paragraph(observation.followUp);
        }
        const inline = observation.photos.filter((photo) => photo.layout !== "appendix");
        for (let index = 0; index < inline.length; index++) {
          const photo = inline[index]!;
          if (photo.layout === "pair" && inline[index + 1]?.layout === "pair")
            photoRow([photo, inline[++index]!]);
          else photoRow([photo]);
        }
        for (const photo of observation.photos.filter((item) => item.layout === "appendix")) {
          appendix.push({ photo, context: `Visit ${visitIndex + 1} - ${observation.title}` });
          paragraph(`Photo ${photo.number} is included in the photo appendix.`, 9);
        }
      }
    }
  };
  for (const key of sectionOrder) {
    if (key === "visits") renderVisits();
    else if (key === "sections") {
      for (const section of customSections) {
        heading(section.title);
        paragraph(section.body);
      }
    } else {
      const [name, value] = sections.get(key)!;
      if (value.trim()) {
        heading(name);
        paragraph(value);
      }
    }
  }
  if (appendix.length) {
    newPage();
    heading("Photo appendix");
    for (const item of appendix) {
      heading(item.context);
      photoRow([item.photo], true);
    }
  }
  const total = document.getPageCount();
  document.getPages().forEach((item, index) => {
    item.drawLine({
      start: { x: MARGIN, y: 44 },
      end: { x: WIDTH - MARGIN, y: 44 },
      color: LINE,
      thickness: 0.5,
    });
    item.drawText(`Approved report | Version ${input.version}`, {
      x: MARGIN,
      y: 30,
      size: 8,
      font: regular,
      color: MUTED,
    });
    const label = `Page ${index + 1} of ${total}`;
    item.drawText(label, {
      x: WIDTH - MARGIN - regular.widthOfTextAtSize(label, 8),
      y: 30,
      size: 8,
      font: regular,
      color: MUTED,
    });
  });
  const bytes = await document.save({
    useObjectStreams: false,
    addDefaultPage: false,
    objectsPerTick: 50,
  });
  if (bytes.length > 64 * 1024 * 1024) tooLarge();
  return bytes;
}
