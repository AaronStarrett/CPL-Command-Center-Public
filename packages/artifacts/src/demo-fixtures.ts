import { deflateSync } from "node:zlib";

import type {
  ArtifactChartData,
  ArtifactCitation,
  ArtifactTableData,
  BeaPdfDocumentInput,
} from "./contracts.js";

export const DEMO_ARTIFACT_OWNER_ID = "10000000-0000-4000-8000-000000000001";
export const DEMO_ARTIFACT_GENERATED_AT = "2026-08-20T14:00:00.000Z";

export const DEMO_ARTIFACT_CITATIONS: readonly ArtifactCitation[] = [
  {
    accessedAt: DEMO_ARTIFACT_GENERATED_AT,
    domain: "example.invalid",
    title: "Synthetic roof-observation worksheet",
    url: "https://example.invalid/bea/synthetic-roof-observations",
  },
  {
    accessedAt: DEMO_ARTIFACT_GENERATED_AT,
    domain: "example.invalid",
    title: "Synthetic envelope test summary",
    url: "https://example.invalid/bea/synthetic-envelope-summary",
  },
];

export const DEMO_ARTIFACT_CHART: ArtifactChartData = {
  provenance: {
    calculationNotes: "Counts are fixed synthetic fixture values grouped by envelope system.",
    dataStatus: "synthetic",
    sourceDate: DEMO_ARTIFACT_GENERATED_AT,
    sourceMapping: [
      {
        citationUrl: DEMO_ARTIFACT_CITATIONS[0]!.url,
        seriesLabels: ["Roof", "Facade", "Glazing", "Sealants"],
      },
    ],
  },
  series: [
    { label: "Roof", value: 4 },
    { label: "Facade", value: 2 },
    { label: "Glazing", value: 3 },
    { label: "Sealants", value: 1 },
  ],
  title: "Synthetic findings by system",
  type: "bar",
  unit: "findings",
};

export const DEMO_ARTIFACT_TABLE: ArtifactTableData = {
  columns: ["System", "Observation", "Priority"],
  rows: [
    ["Roof", "Membrane transition requires review", "Attention"],
    ["Facade", "Control-joint sealant remains serviceable", "Info"],
    ["Glazing", "Perimeter sealant discontinuity at test bay", "Critical"],
  ],
  title: "Synthetic observation register",
};

export const DEMO_ARTIFACT_RESEARCH = {
  citations: DEMO_ARTIFACT_CITATIONS,
  findings: [
    "Synthetic roof-transition observation prepared only for deterministic workflow testing.",
    "Synthetic glazing-perimeter observation prepared only for deterministic workflow testing.",
  ],
  summary:
    "Deterministic synthetic research fixture; it is not sourced from live BEA or provider data.",
  title: "Synthetic envelope research brief",
} as const;

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

export function createDemoInspectionImagePng(): Uint8Array {
  const width = 480;
  const height = 270;
  const scanlines = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    scanlines[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 3;
      let color: readonly [number, number, number] = [230, 239, 240];
      if (y > 54 && y < 236 && x > 54 && x < 426) color = [8, 48, 74];
      if (y > 76 && y < 218 && x > 78 && x < 402) color = [239, 244, 242];
      if (y > 94 && y < 202 && x > 96 && x < 384) {
        const bay = Math.floor((x - 96) / 48);
        color = bay % 2 === 0 ? [116, 160, 171] : [160, 190, 194];
      }
      if (
        (x > 50 && x < 430 && (y === 52 || y === 53)) ||
        (y > 48 && y < 240 && (x === 52 || x === 53))
      ) {
        color = [74, 163, 70];
      }
      if (x > 309 && x < 373 && y > 129 && y < 193) color = [255, 255, 255];
      if (x > 315 && x < 367 && y > 135 && y < 187) color = [74, 163, 70];
      scanlines[offset] = color[0];
      scanlines[offset + 1] = color[1];
      scanlines[offset + 2] = color[2];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", header),
      pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
      pngChunk("IEND", new Uint8Array()),
    ]),
  );
}

export function createDemoArtifactCsv(): Uint8Array {
  return new TextEncoder().encode(
    "system,observation,priority\nRoof,Synthetic membrane transition review,attention\nGlazing,Synthetic perimeter discontinuity,critical\n",
  );
}

export function createDemoBeaPdfInput(): BeaPdfDocumentInput {
  return {
    chart: DEMO_ARTIFACT_CHART,
    citations: DEMO_ARTIFACT_CITATIONS,
    disclosure:
      "DEMO MODE - This report contains deterministic synthetic records and no live BEA or provider data.",
    findings: [
      {
        detail:
          "A synthetic membrane transition is shown for workflow and document-layout validation only.",
        severity: "attention",
        title: "Roof transition review",
      },
      {
        detail:
          "The synthetic glazing bay includes a perimeter discontinuity used to demonstrate priority styling.",
        severity: "critical",
        title: "Glazing perimeter discontinuity",
      },
      {
        detail: "Synthetic control-joint sealant is recorded as serviceable in the demo fixture.",
        severity: "info",
        title: "Facade control joint",
      },
    ],
    generatedAt: DEMO_ARTIFACT_GENERATED_AT,
    image: {
      altText: "Synthetic building elevation diagram with highlighted inspection bay",
      bytes: createDemoInspectionImagePng(),
      caption:
        "Simulated AI-generated inspection diagram - not a field photograph or live provider output",
      mimeType: "image/png",
    },
    reportDate: "2026-08-20",
    summary:
      "This deterministic report demonstrates the BEA artifact workflow with synthetic envelope observations, a chart, a table, a diagram, citations, and explicit Demo Mode disclosure.",
    table: DEMO_ARTIFACT_TABLE,
    title: "Synthetic Building Envelope Review",
    requestedBy: "Workspace Owner",
  };
}
