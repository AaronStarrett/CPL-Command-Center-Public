import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  normalizeCplReportBranding,
  normalizeCplReportContent,
  normalizeCplReportTemplate,
} from "../../packages/domain/src/cpl-report";

const input = () => ({
  title: "Human report",
  scope: "Public scope",
  summary: "Human summary",
  limitations: "Accessible areas",
  conclusion: "Human conclusion",
  sections: [{ id: randomUUID(), title: "Extra section", body: "Human extra text" }],
  sectionOrder: ["visits", "summary", "sections"],
  visits: [
    {
      visitId: randomUUID(),
      observations: [
        {
          observationId: randomUUID(),
          titleOverride: null,
          descriptionOverride: "Human report wording",
          followUpOverride: null,
          photos: [{ photoId: randomUUID(), layout: "large" }],
        },
      ],
      overviewPhotos: [],
    },
  ],
});
describe("report contracts", () => {
  it("preserves deliberate selection order and human overrides without accepting private extras", () => {
    const raw = input(),
      normalized = normalizeCplReportContent({
        ...raw,
        internalNotes: "PRIVATE",
        pricing: { total: 999 },
      });
    expect(normalized.sectionOrder).toEqual(raw.sectionOrder);
    expect(normalized.visits[0]?.observations[0]?.descriptionOverride).toBe("Human report wording");
    expect(normalized).not.toHaveProperty("internalNotes");
    expect(normalized).not.toHaveProperty("pricing");
  });
  it("rejects duplicate section keys, source IDs and unsupported photo layouts", () => {
    const raw = input();
    expect(() =>
      normalizeCplReportContent({ ...raw, sectionOrder: ["visits", "visits"] }),
    ).toThrow();
    expect(() =>
      normalizeCplReportContent({ ...raw, visits: [raw.visits[0], raw.visits[0]] }),
    ).toThrow();
    expect(() =>
      normalizeCplReportContent({
        ...raw,
        visits: [
          {
            ...raw.visits[0],
            observations: [
              {
                ...raw.visits[0]!.observations[0],
                photos: [{ photoId: randomUUID(), layout: "raw-html" }],
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });
  it("refuses the same photo appearing in overview and an observation", () => {
    const raw = input(),
      photo = raw.visits[0]!.observations[0]!.photos[0]!;
    expect(() =>
      normalizeCplReportContent({
        ...raw,
        visits: [{ ...raw.visits[0], overviewPhotos: [photo] }],
      }),
    ).toThrow();
  });
  it("allows incomplete source selection while keeping required report identity bounded", () => {
    expect(normalizeCplReportContent({ ...input(), visits: [] }).visits).toEqual([]);
    expect(() => normalizeCplReportContent({ ...input(), title: "" })).toThrow();
    expect(() => normalizeCplReportContent({ ...input(), sectionOrder: [] })).toThrow();
    expect(() => normalizeCplReportContent({ ...input(), summary: "x".repeat(30001) })).toThrow();
  });
  it("defines reusable report templates independently of selected project sources", () => {
    const t = normalizeCplReportTemplate({
      ...input(),
      name: "Tenant template",
      description: "Configured default",
    });
    expect(t.name).toBe("Tenant template");
    expect(t).not.toHaveProperty("visits");
  });
  it("permits embedded PNG/JPEG branding but rejects remote logos and malformed contact/color", () => {
    const branding = {
      businessName: "Tenant report business",
      email: "reports@example.invalid",
      phone: "",
      address: "",
      accentColor: "#aabbcc",
      logoDataUrl: null,
    };
    expect(normalizeCplReportBranding(branding).accentColor).toBe("#AABBCC");
    expect(() =>
      normalizeCplReportBranding({ ...branding, logoDataUrl: "https://example.invalid/logo.png" }),
    ).toThrow();
    expect(() => normalizeCplReportBranding({ ...branding, accentColor: "red" })).toThrow();
    expect(() => normalizeCplReportBranding({ ...branding, email: "invalid" })).toThrow();
  });
});
