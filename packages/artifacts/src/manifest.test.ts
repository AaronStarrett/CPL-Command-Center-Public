import { describe, expect, it } from "vitest";

import { ARTIFACT_CHART_TYPES, ARTIFACT_RENDERERS, ArtifactValidationError } from "./contracts.js";
import { DEMO_ARTIFACT_CHART, DEMO_ARTIFACT_CITATIONS } from "./demo-fixtures.js";
import { normalizeArtifactManifest } from "./manifest.js";

const ownerId = "10000000-0000-4000-8000-000000000001";
const createdAt = "2026-08-20T14:00:00.000Z";
const file = {
  filename: "synthetic-report.pdf",
  id: "art_0123456789abcdef0123456789abcdef",
  mimeType: "application/pdf",
  sha256: "a".repeat(64),
  size: 128,
};

const base = {
  artifactId: "art_abcdef0123456789abcdef0123456789",
  citations: DEMO_ARTIFACT_CITATIONS,
  createdAt,
  disclosure: "DEMO MODE - deterministic synthetic artifact.",
  ownerId,
  schemaVersion: 1,
  summary: "Synthetic artifact manifest for registry validation.",
  title: "Synthetic artifact",
};

function chartFor(type: (typeof ARTIFACT_CHART_TYPES)[number]) {
  const series =
    type === "single_metric"
      ? [{ label: "Roof", value: 4 }]
      : [
          {
            label: "Roof",
            ...(type === "scatter" ? { secondaryValue: 2 } : {}),
            ...(type === "timeline" ? { timestamp: createdAt } : {}),
            value: 4,
          },
          {
            label: "Glazing",
            ...(type === "scatter" ? { secondaryValue: 3 } : {}),
            ...(type === "timeline" ? { timestamp: "2026-08-20T15:00:00.000Z" } : {}),
            value: 2,
          },
        ];
  return {
    provenance: {
      calculationNotes: "Fixed synthetic counts grouped by envelope system.",
      dataStatus: "synthetic",
      sourceDate: createdAt,
      sourceMapping: [
        {
          citationUrl: DEMO_ARTIFACT_CITATIONS[0]!.url,
          seriesLabels: series.map((point) => point.label),
        },
      ],
    },
    series,
    title: `Synthetic ${type} chart`,
    type,
    unit: "findings",
  };
}

describe("normalized artifact renderer registry", () => {
  it("publishes every allowlisted chart type with explicit provenance requirements", () => {
    expect(ARTIFACT_CHART_TYPES).toEqual([
      "line",
      "bar",
      "stacked_bar",
      "area",
      "pie_or_donut",
      "scatter",
      "timeline",
      "single_metric",
      "comparison",
    ]);
    for (const type of ARTIFACT_CHART_TYPES) {
      const manifest = normalizeArtifactManifest({
        ...base,
        chart: chartFor(type),
        renderer: "chart",
      });
      expect(manifest.renderer).toBe("chart");
      if (manifest.renderer === "chart") {
        expect(manifest.chart.provenance.sourceMapping.length).toBeGreaterThan(0);
      }
    }
  });

  it.each(ARTIFACT_CHART_TYPES)(
    "accepts allowlisted %s charts with explicit provenance",
    (type) => {
      const manifest = normalizeArtifactManifest({
        ...base,
        chart: chartFor(type),
        renderer: "chart",
      });
      expect(manifest.renderer).toBe("chart");
      if (manifest.renderer === "chart") {
        expect(manifest.chart.type).toBe(type);
        expect(manifest.chart.provenance.dataStatus).toBe("synthetic");
        expect(manifest.chart.provenance.sourceMapping).toHaveLength(1);
      }
    },
  );

  it.each([
    ["pdf", { file }],
    ["image", { altText: "Synthetic elevation", file: { ...file, mimeType: "image/png" } }],
    ["chart", { chart: DEMO_ARTIFACT_CHART }],
    ["table", { table: { columns: ["System"], rows: [["Roof"]], title: "Synthetic table" } }],
    [
      "data",
      {
        data: {
          file: { ...file, filename: "synthetic.csv", mimeType: "text/csv" },
          format: "csv",
          recordCount: 1,
        },
      },
    ],
    ["research", { findings: ["Synthetic research finding"] }],
    ["source-board", { sources: DEMO_ARTIFACT_CITATIONS }],
    ["metric", { metric: { label: "Open findings", trend: "flat", unit: "findings", value: 4 } }],
    ["timeline", { events: [{ at: createdAt, detail: "Synthetic event", title: "Review" }] }],
    [
      "comparison",
      { comparison: { columns: ["System"], rows: [["Roof"]], title: "Synthetic comparison" } },
    ],
    ["analysis", { sections: [{ body: "Synthetic analysis body", heading: "Observation" }] }],
    ["error", { error: { code: "SYNTHETIC_ERROR", message: "Synthetic error", retryable: false } }],
  ] as const)("accepts only the normalized %s renderer shape", (renderer, payload) => {
    expect(normalizeArtifactManifest({ ...base, ...payload, renderer })).toMatchObject({
      renderer,
      schemaVersion: 1,
    });
  });

  it("rejects arbitrary renderers and unsafe extra renderer fields", () => {
    expect(() =>
      normalizeArtifactManifest({ ...base, renderer: "iframe", src: "https://example.invalid" }),
    ).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_RENDERER" }));
    expect(() =>
      normalizeArtifactManifest({
        ...base,
        chart: DEMO_ARTIFACT_CHART,
        renderer: "chart",
        unsafeHtml: "<script>alert(1)</script>",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_MANIFEST" }));
    expect(ARTIFACT_RENDERERS).not.toContain("iframe");
  });

  it("rejects chart provenance or data defects", () => {
    for (const chart of [
      { ...DEMO_ARTIFACT_CHART, provenance: undefined },
      { ...DEMO_ARTIFACT_CHART, series: [] },
      { ...DEMO_ARTIFACT_CHART, series: [{ label: "Roof", value: Number.NaN }] },
      {
        ...DEMO_ARTIFACT_CHART,
        provenance: { ...DEMO_ARTIFACT_CHART.provenance, sourceMapping: [] },
      },
    ]) {
      expect(() => normalizeArtifactManifest({ ...base, chart, renderer: "chart" })).toThrow(
        ArtifactValidationError,
      );
    }
  });

  it.each([
    [{ ...DEMO_ARTIFACT_CHART, provenance: undefined }, "missing provenance"],
    [{ ...DEMO_ARTIFACT_CHART, series: [] }, "empty data"],
    [{ ...DEMO_ARTIFACT_CHART, series: [{ label: "Roof", value: Number.NaN }] }, "non-finite data"],
    [
      {
        ...DEMO_ARTIFACT_CHART,
        provenance: { ...DEMO_ARTIFACT_CHART.provenance, sourceMapping: [] },
      },
      "empty source mapping",
    ],
    [
      {
        ...DEMO_ARTIFACT_CHART,
        provenance: {
          ...DEMO_ARTIFACT_CHART.provenance,
          dataStatus: "real",
          sourceDate: undefined,
        },
      },
      "real data without a source date",
    ],
    [
      {
        ...DEMO_ARTIFACT_CHART,
        provenance: {
          ...DEMO_ARTIFACT_CHART.provenance,
          sourceMapping: [
            {
              citationUrl: "https://unmapped.example.invalid/chart",
              seriesLabels: ["Roof"],
            },
          ],
        },
      },
      "unmapped citation",
    ],
  ])("rejects chart provenance or data defects: %s", (chart) => {
    expect(() => normalizeArtifactManifest({ ...base, chart, renderer: "chart" })).toThrow(
      ArtifactValidationError,
    );
  });
});
