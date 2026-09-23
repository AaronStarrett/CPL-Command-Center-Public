import { describe, expect, it } from "vitest";
import {
  calculateCplCommercialTotals,
  defaultCplCommercialBranding,
  normalizeCplCommercialContent,
  normalizeCplCommercialBranding,
  normalizeCplCommercialTemplate,
  cplCommercialDate,
  validateCplCommercialLogo,
} from "../../packages/domain/src/cpl-commercial";

const config = { ...defaultCplCommercialBranding(), discountEnabled: true, taxEnabled: true };
const input = {
  title: "Fictional service",
  scope: "Confirmed scope",
  currency: "USD",
  lineItems: [
    {
      description: "Labor",
      serviceCode: "labor",
      quantity: "1.125",
      unit: "hours",
      unitPriceMinor: 101,
    },
  ],
  discountMinor: 4,
  taxBasisPoints: 875,
};
describe("commercial exact arithmetic and input boundaries", () => {
  it("rounds each extended line and tax half up using integers", () => {
    const value = normalizeCplCommercialContent(input, config);
    expect(calculateCplCommercialTotals(value)).toEqual({
      currency: "USD",
      lineTotalsMinor: [114],
      subtotalMinor: 114,
      discountMinor: 4,
      taxableMinor: 110,
      taxMinor: 10,
      totalMinor: 120,
    });
  });
  it.each(["0", "-1", "1.0001", "1e2", "Infinity", "01", "0.000"])(
    "refuses invalid quantity %s",
    (quantity) => {
      expect(() =>
        normalizeCplCommercialContent(
          { ...input, lineItems: [{ ...input.lineItems[0], quantity }] },
          config,
        ),
      ).toThrow();
    },
  );
  it.each([NaN, Infinity, -1, 0.1, 1_000_000_000_001])(
    "refuses unsafe money %s",
    (unitPriceMinor) => {
      expect(() =>
        normalizeCplCommercialContent(
          { ...input, lineItems: [{ ...input.lineItems[0], unitPriceMinor }] },
          config,
        ),
      ).toThrow();
    },
  );
  it("refuses overflowing totals, excessive discounts and disabled tax/discount", () => {
    expect(() =>
      normalizeCplCommercialContent(
        {
          ...input,
          lineItems: [{ ...input.lineItems[0], quantity: "2", unitPriceMinor: 1_000_000_000_000 }],
        },
        config,
      ),
    ).toThrow();
    expect(() => normalizeCplCommercialContent({ ...input, discountMinor: 115 }, config)).toThrow();
    expect(() => normalizeCplCommercialContent(input, defaultCplCommercialBranding())).toThrow();
    expect(() =>
      normalizeCplCommercialContent(
        { ...input, discountMinor: 0 },
        { ...config, taxEnabled: false },
      ),
    ).toThrow();
  });
  it("validates real calendar dates and date ordering", () => {
    expect(cplCommercialDate("2028-02-29")).toBe("2028-02-29");
    expect(() => cplCommercialDate("2027-02-29")).toThrow();
    expect(() =>
      normalizeCplCommercialContent(
        { ...input, startDate: "2026-02-03", endDate: "2026-02-02" },
        config,
      ),
    ).toThrow();
  });
  it("preserves section and item ordering while refusing duplicate section keys", () => {
    const sections = [
      { id: "second", title: "Second", body: "B" },
      { id: "first", title: "First", body: "A" },
    ];
    expect(normalizeCplCommercialContent({ ...input, sections }, config).sections).toEqual(
      sections,
    );
    expect(() =>
      normalizeCplCommercialContent({ ...input, sections: [sections[0], sections[0]] }, config),
    ).toThrow();
  });
  it("normalizes configurable branding and refuses external or active logos", () => {
    const value = { ...config, businessName: "Fictional Works", accentColor: "#aabbcc" };
    expect(normalizeCplCommercialBranding(value, 1).accentColor).toBe("#AABBCC");
    for (const logo of [
      "https://example.invalid/logo.png",
      "file:///logo.png",
      "data:image/svg+xml;base64,PHN2Zz4=",
      "data:image/png;base64,AAAA",
    ])
      expect(() => validateCplCommercialLogo(logo)).toThrow();
    expect(() =>
      normalizeCplCommercialBranding({ ...value, accentColor: "red;position:absolute" }, 1),
    ).toThrow();
    const truncatedJpeg = Uint8Array.from([
      255,
      216,
      255,
      224,
      0,
      16,
      ...Array(14).fill(0),
      255,
      192,
      0,
      2,
    ]);
    expect(() =>
      validateCplCommercialLogo(
        `data:image/jpeg;base64,${btoa(String.fromCharCode(...truncatedJpeg))}`,
      ),
    ).toThrow();
  });
  it("rejects duplicate template service codes and ignores untrusted internal input keys", () => {
    const item = { serviceCode: "x", description: "Fictional", unit: "each", unitPriceMinor: 100 };
    expect(() =>
      normalizeCplCommercialTemplate({ name: "Fictional", catalog: [item, item] }),
    ).toThrow();
    expect(
      normalizeCplCommercialContent({ ...input, internalNotes: "Never a content field" }, config),
    ).not.toHaveProperty("internalNotes");
  });
});
