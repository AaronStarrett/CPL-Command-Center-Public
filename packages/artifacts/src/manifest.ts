import {
  ARTIFACT_CHART_TYPES,
  ARTIFACT_DATA_STATUSES,
  ARTIFACT_RENDERERS,
  ArtifactValidationError,
  type ArtifactChartData,
  type ArtifactCitation,
  type ArtifactFileReference,
  type ArtifactManifest,
  type ArtifactTableData,
} from "./contracts.js";
import { artifactBrandMetadata } from "./brand.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const artifactIdPattern = /^art_[a-f0-9]{24,64}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ArtifactValidationError("INVALID_MANIFEST", `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new ArtifactValidationError(
      "INVALID_MANIFEST",
      `${label} contains unsupported field ${unexpected[0]}.`,
    );
  }
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") {
    throw new ArtifactValidationError("INVALID_MANIFEST", `${label} must be text.`);
  }
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new ArtifactValidationError(
      "INVALID_MANIFEST",
      `${label} must contain between 1 and ${maximum} characters.`,
    );
  }
  return normalized;
}

function isoDate(value: unknown, label: string): string {
  const normalized = text(value, label, 40);
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== normalized) {
    throw new ArtifactValidationError("INVALID_MANIFEST", `${label} must be an ISO timestamp.`);
  }
  return normalized;
}

function normalizeCitation(value: unknown): ArtifactCitation {
  const input = record(value, "Citation");
  onlyKeys(input, ["accessedAt", "domain", "title", "url"], "Citation");
  const urlText = text(input.url, "Citation URL", 2_048);
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw new ArtifactValidationError("INVALID_MANIFEST", "Citation URL must be valid.");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new ArtifactValidationError(
      "INVALID_MANIFEST",
      "Citation URL must be an HTTPS URL without credentials.",
    );
  }
  const domain = text(input.domain, "Citation domain", 253).toLowerCase();
  if (url.hostname.toLowerCase() !== domain) {
    throw new ArtifactValidationError(
      "INVALID_MANIFEST",
      "Citation domain must match the URL hostname.",
    );
  }
  return {
    accessedAt: isoDate(input.accessedAt, "Citation accessedAt"),
    domain,
    title: text(input.title, "Citation title", 300),
    url: url.toString(),
  };
}

function normalizeCitations(value: unknown): readonly ArtifactCitation[] {
  if (!Array.isArray(value) || value.length > 50) {
    throw new ArtifactValidationError(
      "INVALID_MANIFEST",
      "Citations must be an array of at most 50 items.",
    );
  }
  return value.map(normalizeCitation);
}

function normalizeFile(value: unknown): ArtifactFileReference {
  const input = record(value, "File reference");
  onlyKeys(input, ["filename", "id", "mimeType", "sha256", "size"], "File reference");
  const id = text(input.id, "File ID", 80);
  const sha256 = text(input.sha256, "File hash", 64).toLowerCase();
  if (!artifactIdPattern.test(id) || !sha256Pattern.test(sha256)) {
    throw new ArtifactValidationError("INVALID_MANIFEST", "File reference identity is invalid.");
  }
  if (!Number.isSafeInteger(input.size) || Number(input.size) < 1) {
    throw new ArtifactValidationError("INVALID_MANIFEST", "File size must be a positive integer.");
  }
  return {
    filename: text(input.filename, "Filename", 128),
    id,
    mimeType: text(input.mimeType, "MIME type", 150).toLowerCase(),
    sha256,
    size: Number(input.size),
  };
}

export function normalizeArtifactChartData(
  value: unknown,
  citationUrls?: ReadonlySet<string>,
): ArtifactChartData {
  const input = record(value, "Chart");
  onlyKeys(input, ["provenance", "series", "title", "type", "unit"], "Chart");
  if (
    typeof input.type !== "string" ||
    !(ARTIFACT_CHART_TYPES as readonly string[]).includes(input.type)
  ) {
    throw new ArtifactValidationError("INVALID_MANIFEST", "Chart type is unsupported.");
  }
  if (!Array.isArray(input.series) || input.series.length === 0 || input.series.length > 24) {
    throw new ArtifactValidationError(
      "INVALID_MANIFEST",
      "Chart series must contain 1 to 24 points.",
    );
  }
  const series = input.series.map((entry) => {
    const point = record(entry, "Chart point");
    onlyKeys(point, ["group", "label", "secondaryValue", "timestamp", "value"], "Chart point");
    if (typeof point.value !== "number" || !Number.isFinite(point.value)) {
      throw new ArtifactValidationError("INVALID_MANIFEST", "Chart values must be finite numbers.");
    }
    if (
      point.secondaryValue !== undefined &&
      (typeof point.secondaryValue !== "number" || !Number.isFinite(point.secondaryValue))
    ) {
      throw new ArtifactValidationError(
        "INVALID_MANIFEST",
        "Chart secondary values must be finite numbers.",
      );
    }
    return {
      ...(point.group === undefined ? {} : { group: text(point.group, "Chart group", 80) }),
      label: text(point.label, "Chart label", 80),
      ...(point.secondaryValue === undefined
        ? {}
        : { secondaryValue: point.secondaryValue as number }),
      ...(point.timestamp === undefined
        ? {}
        : { timestamp: isoDate(point.timestamp, "Chart timestamp") }),
      value: point.value,
    };
  });
  if (input.type === "scatter" && series.some((point) => point.secondaryValue === undefined)) {
    throw new ArtifactValidationError(
      "INVALID_MANIFEST",
      "Scatter charts require a secondary value for every point.",
    );
  }
  if (input.type === "timeline" && series.some((point) => point.timestamp === undefined)) {
    throw new ArtifactValidationError(
      "INVALID_MANIFEST",
      "Timeline charts require a timestamp for every point.",
    );
  }
  if (input.type === "single_metric" && series.length !== 1) {
    throw new ArtifactValidationError(
      "INVALID_MANIFEST",
      "Single-metric charts require exactly one point.",
    );
  }

  const provenanceInput = record(input.provenance, "Chart provenance");
  onlyKeys(
    provenanceInput,
    ["calculationNotes", "dataStatus", "sourceDate", "sourceMapping"],
    "Chart provenance",
  );
  if (
    typeof provenanceInput.dataStatus !== "string" ||
    !(ARTIFACT_DATA_STATUSES as readonly string[]).includes(provenanceInput.dataStatus)
  ) {
    throw new ArtifactValidationError("INVALID_MANIFEST", "Chart data status is unsupported.");
  }
  if (
    !Array.isArray(provenanceInput.sourceMapping) ||
    provenanceInput.sourceMapping.length === 0 ||
    provenanceInput.sourceMapping.length > 50
  ) {
    throw new ArtifactValidationError(
      "INVALID_MANIFEST",
      "Chart provenance must map at least one source.",
    );
  }
  const labels = new Set(series.map((point) => point.label));
  const sourceMapping = provenanceInput.sourceMapping.map((entry) => {
    const mapping = record(entry, "Chart source mapping");
    onlyKeys(mapping, ["citationUrl", "seriesLabels"], "Chart source mapping");
    const citationUrl = text(mapping.citationUrl, "Chart source citation URL", 2_048);
    let parsedCitationUrl: URL;
    try {
      parsedCitationUrl = new URL(citationUrl);
    } catch {
      throw new ArtifactValidationError(
        "INVALID_MANIFEST",
        "Chart source citation URL must be valid.",
      );
    }
    const normalizedCitationUrl = parsedCitationUrl.toString();
    if (
      parsedCitationUrl.protocol !== "https:" ||
      parsedCitationUrl.username ||
      parsedCitationUrl.password ||
      (citationUrls !== undefined && !citationUrls.has(normalizedCitationUrl))
    ) {
      throw new ArtifactValidationError(
        "INVALID_MANIFEST",
        "Chart source mapping must reference an artifact citation.",
      );
    }
    if (!Array.isArray(mapping.seriesLabels) || mapping.seriesLabels.length === 0) {
      throw new ArtifactValidationError(
        "INVALID_MANIFEST",
        "Chart source mapping must name at least one series label.",
      );
    }
    const seriesLabels = mapping.seriesLabels.map((label) =>
      text(label, "Chart source series label", 80),
    );
    if (seriesLabels.some((label) => !labels.has(label))) {
      throw new ArtifactValidationError(
        "INVALID_MANIFEST",
        "Chart source mapping contains an unknown series label.",
      );
    }
    return { citationUrl: normalizedCitationUrl, seriesLabels };
  });
  const sourceDate =
    provenanceInput.sourceDate === undefined
      ? undefined
      : isoDate(provenanceInput.sourceDate, "Chart source date");
  if (provenanceInput.dataStatus !== "synthetic" && sourceDate === undefined) {
    throw new ArtifactValidationError(
      "INVALID_MANIFEST",
      "Non-synthetic chart provenance requires a source date.",
    );
  }
  return {
    provenance: {
      calculationNotes: text(provenanceInput.calculationNotes, "Chart calculation notes", 2_000),
      dataStatus: provenanceInput.dataStatus as ArtifactChartData["provenance"]["dataStatus"],
      ...(sourceDate === undefined ? {} : { sourceDate }),
      sourceMapping,
    },
    series,
    title: text(input.title, "Chart title", 200),
    type: input.type as ArtifactChartData["type"],
    ...(input.unit === undefined ? {} : { unit: text(input.unit, "Chart unit", 40) }),
  };
}

function normalizeTable(value: unknown): ArtifactTableData {
  const input = record(value, "Table");
  onlyKeys(input, ["columns", "rows", "title"], "Table");
  if (!Array.isArray(input.columns) || input.columns.length === 0 || input.columns.length > 12) {
    throw new ArtifactValidationError("INVALID_MANIFEST", "Table must contain 1 to 12 columns.");
  }
  const columns = input.columns.map((column) => text(column, "Table column", 80));
  if (!Array.isArray(input.rows) || input.rows.length > 250) {
    throw new ArtifactValidationError("INVALID_MANIFEST", "Table may contain at most 250 rows.");
  }
  const rows = input.rows.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== columns.length) {
      throw new ArtifactValidationError(
        "INVALID_MANIFEST",
        "Every table row must match the column count.",
      );
    }
    return entry.map((cell) => text(cell, "Table cell", 500));
  });
  return { columns, rows, title: text(input.title, "Table title", 200) };
}

export function normalizeArtifactManifest(value: unknown): ArtifactManifest {
  const input = record(value, "Artifact manifest");
  const baseKeys = [
    "artifactId",
    "citations",
    "createdAt",
    "disclosure",
    "ownerId",
    "renderer",
    "schemaVersion",
    "summary",
    "title",
    "brand",
  ];
  if (input.schemaVersion !== 1) {
    throw new ArtifactValidationError(
      "INVALID_MANIFEST",
      "Artifact schema version is unsupported.",
    );
  }
  if (
    typeof input.renderer !== "string" ||
    !(ARTIFACT_RENDERERS as readonly string[]).includes(input.renderer)
  ) {
    throw new ArtifactValidationError(
      "UNSUPPORTED_RENDERER",
      "Artifact renderer is not allowlisted.",
    );
  }
  const artifactId = text(input.artifactId, "Artifact ID", 80);
  const ownerId = text(input.ownerId, "Owner ID", 64);
  if (!artifactIdPattern.test(artifactId) || !uuidPattern.test(ownerId)) {
    throw new ArtifactValidationError("INVALID_MANIFEST", "Artifact or owner identity is invalid.");
  }
  const base = {
    artifactId,
    citations: normalizeCitations(input.citations),
    createdAt: isoDate(input.createdAt, "Artifact createdAt"),
    disclosure: text(input.disclosure, "Artifact disclosure", 500),
    ownerId,
    schemaVersion: 1 as const,
    summary: text(input.summary, "Artifact summary", 2_000),
    title: text(input.title, "Artifact title", 200),
    brand: artifactBrandMetadata(input.renderer as ArtifactManifest["renderer"]),
  };

  switch (input.renderer) {
    case "pdf":
      onlyKeys(input, [...baseKeys, "file"], "PDF artifact");
      return { ...base, file: normalizeFile(input.file), renderer: "pdf" };
    case "image":
      onlyKeys(input, [...baseKeys, "altText", "file"], "Image artifact");
      return {
        ...base,
        altText: text(input.altText, "Image alt text", 500),
        file: normalizeFile(input.file),
        renderer: "image",
      };
    case "chart":
      onlyKeys(input, [...baseKeys, "chart"], "Chart artifact");
      return {
        ...base,
        chart: normalizeArtifactChartData(
          input.chart,
          new Set(base.citations.map((citation) => citation.url)),
        ),
        renderer: "chart",
      };
    case "table":
      onlyKeys(input, [...baseKeys, "table"], "Table artifact");
      return { ...base, renderer: "table", table: normalizeTable(input.table) };
    case "data": {
      onlyKeys(input, [...baseKeys, "data"], "Data artifact");
      const data = record(input.data, "Data artifact payload");
      onlyKeys(data, ["file", "format", "recordCount"], "Data artifact payload");
      if (!(["csv", "docx", "json", "txt", "xlsx"] as const).includes(data.format as "csv")) {
        throw new ArtifactValidationError("INVALID_MANIFEST", "Data format is unsupported.");
      }
      if (!Number.isSafeInteger(data.recordCount) || Number(data.recordCount) < 0) {
        throw new ArtifactValidationError("INVALID_MANIFEST", "Data record count is invalid.");
      }
      return {
        ...base,
        data: {
          file: normalizeFile(data.file),
          format: data.format as "csv" | "docx" | "json" | "txt" | "xlsx",
          recordCount: Number(data.recordCount),
        },
        renderer: "data",
      };
    }
    case "research":
      onlyKeys(input, [...baseKeys, "findings"], "Research artifact");
      if (
        !Array.isArray(input.findings) ||
        input.findings.length === 0 ||
        input.findings.length > 50
      ) {
        throw new ArtifactValidationError(
          "INVALID_MANIFEST",
          "Research findings must contain 1 to 50 items.",
        );
      }
      return {
        ...base,
        findings: input.findings.map((finding) => text(finding, "Research finding", 1_000)),
        renderer: "research",
      };
    case "source-board":
      onlyKeys(input, [...baseKeys, "sources"], "Source-board artifact");
      return {
        ...base,
        renderer: "source-board",
        sources: normalizeCitations(input.sources),
      };
    case "metric": {
      onlyKeys(input, [...baseKeys, "metric"], "Metric artifact");
      const metric = record(input.metric, "Metric payload");
      onlyKeys(metric, ["label", "trend", "unit", "value"], "Metric payload");
      if (typeof metric.value !== "number" || !Number.isFinite(metric.value)) {
        throw new ArtifactValidationError("INVALID_MANIFEST", "Metric value must be finite.");
      }
      if (
        metric.trend !== undefined &&
        !(metric.trend === "up" || metric.trend === "flat" || metric.trend === "down")
      ) {
        throw new ArtifactValidationError("INVALID_MANIFEST", "Metric trend is unsupported.");
      }
      return {
        ...base,
        metric: {
          label: text(metric.label, "Metric label", 120),
          ...(metric.trend === undefined ? {} : { trend: metric.trend }),
          ...(metric.unit === undefined ? {} : { unit: text(metric.unit, "Metric unit", 40) }),
          value: metric.value,
        },
        renderer: "metric",
      };
    }
    case "timeline":
      onlyKeys(input, [...baseKeys, "events"], "Timeline artifact");
      if (!Array.isArray(input.events) || input.events.length === 0 || input.events.length > 100) {
        throw new ArtifactValidationError(
          "INVALID_MANIFEST",
          "Timeline must contain 1 to 100 events.",
        );
      }
      return {
        ...base,
        events: input.events.map((entry) => {
          const event = record(entry, "Timeline event");
          onlyKeys(event, ["at", "detail", "title"], "Timeline event");
          return {
            at: isoDate(event.at, "Timeline event timestamp"),
            detail: text(event.detail, "Timeline event detail", 1_000),
            title: text(event.title, "Timeline event title", 200),
          };
        }),
        renderer: "timeline",
      };
    case "comparison":
      onlyKeys(input, [...baseKeys, "comparison"], "Comparison artifact");
      return {
        ...base,
        comparison: normalizeTable(input.comparison),
        renderer: "comparison",
      };
    case "analysis":
      onlyKeys(input, [...baseKeys, "sections"], "Analysis artifact");
      if (
        !Array.isArray(input.sections) ||
        input.sections.length === 0 ||
        input.sections.length > 30
      ) {
        throw new ArtifactValidationError(
          "INVALID_MANIFEST",
          "Analysis must contain 1 to 30 sections.",
        );
      }
      return {
        ...base,
        renderer: "analysis",
        sections: input.sections.map((entry) => {
          const section = record(entry, "Analysis section");
          onlyKeys(section, ["body", "heading"], "Analysis section");
          return {
            body: text(section.body, "Analysis body", 5_000),
            heading: text(section.heading, "Analysis heading", 200),
          };
        }),
      };
    case "error": {
      onlyKeys(input, [...baseKeys, "error"], "Error artifact");
      const error = record(input.error, "Error payload");
      onlyKeys(error, ["code", "message", "retryable"], "Error payload");
      if (typeof error.retryable !== "boolean") {
        throw new ArtifactValidationError("INVALID_MANIFEST", "Error retryable must be boolean.");
      }
      return {
        ...base,
        error: {
          code: text(error.code, "Error code", 100),
          message: text(error.message, "Error message", 1_000),
          retryable: error.retryable,
        },
        renderer: "error",
      };
    }
  }
  throw new ArtifactValidationError(
    "UNSUPPORTED_RENDERER",
    "Artifact renderer is not allowlisted.",
  );
}
