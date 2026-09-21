import { describe, expect, it } from "vitest";

import {
  COMMERCIAL_APPROVER_ELIGIBILITY_SQL,
  COMMERCIAL_OVERRIDE_APPROVER_ELIGIBILITY_SQL,
  PRODUCTION_SERVICE_CATALOG_PLACEHOLDER,
  SYNTHETIC_ENVELOPE_CATALOG,
  buildWorkItemCycleIdentity,
  canonicalCommercialJson,
  computeCatalogIdentityChecksum,
  isProposalStatus,
  isSalesCommercialWorkKind,
  jsonClone,
  parseCatalogPackage,
  proposalAllowsOverrideMutation,
  proposalStatusForCommercialEvent,
  sha256Utf8,
  tryParseCatalogPackage,
  validateCatalogPackage,
  type ProposalStatus,
  type ServiceCatalogPackage,
} from "../../packages/domain/src/index.js";

function identity(pack: ServiceCatalogPackage): string {
  return computeCatalogIdentityChecksum({
    catalogId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    catalogVersionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    catalogVersionNumber: 1,
    pack: parseCatalogPackage(pack),
  });
}

function codes(pack: unknown): readonly string[] {
  return validateCatalogPackage(pack).map((item) => item.code);
}

describe("Phase 3.3A runtime catalog parser", () => {
  const base = jsonClone(SYNTHETIC_ENVELOPE_CATALOG);

  it("accepts the seeded synthetic envelope package", () => {
    expect(tryParseCatalogPackage(base).ok).toBe(true);
    expect(validateCatalogPackage(base)).toEqual([]);
  });

  it("fails closed on missing, non-array, and empty items", () => {
    const missing = jsonClone(base) as Record<string, unknown>;
    delete missing.items;
    expect(codes(missing)).toEqual(expect.arrayContaining(["items"]));
    expect(codes({ ...base, items: "not-an-array" })).toEqual(expect.arrayContaining(["items"]));
    expect(codes({ ...base, items: [] })).toEqual(expect.arrayContaining(["items"]));
  });

  it("fails closed on missing terms, approval, template, and delivery", () => {
    expect(codes({ ...base, terms: undefined })).toEqual(expect.arrayContaining(["required"]));
    expect(codes({ ...base, approval: undefined })).toEqual(expect.arrayContaining(["required"]));
    expect(codes({ ...base, template: undefined })).toEqual(expect.arrayContaining(["required"]));
    expect(codes({ ...base, delivery: undefined })).toEqual(expect.arrayContaining(["required"]));
  });

  it("fails closed on duplicate service keys and codes", () => {
    expect(codes({ ...base, items: [...base.items, base.items[0]!] })).toEqual(
      expect.arrayContaining(["duplicate_service"]),
    );
    const duplicateCode = jsonClone(base);
    duplicateCode.items = [
      duplicateCode.items[0]!,
      { ...duplicateCode.items[1]!, serviceCode: duplicateCode.items[0]!.serviceCode },
    ];
    expect(codes(duplicateCode)).toEqual(expect.arrayContaining(["duplicate_service_code"]));
  });

  it("fails closed on unsupported pricing, negative, floating, and unsafe rates", () => {
    expect(
      codes({
        ...base,
        items: [{ ...base.items[0]!, pricingModel: "javascript-eval" as never }],
      }),
    ).toEqual(expect.arrayContaining(["pricing_model"]));
    expect(codes({ ...base, items: [{ ...base.items[0]!, defaultRateMinor: -1 }] })).toEqual(
      expect.arrayContaining(["rate"]),
    );
    expect(codes({ ...base, items: [{ ...base.items[0]!, defaultRateMinor: 11.5 }] })).toEqual(
      expect.arrayContaining(["rate"]),
    );
    expect(
      codes({
        ...base,
        items: [{ ...base.items[0]!, defaultRateMinor: Number.MAX_SAFE_INTEGER + 1 }],
      }),
    ).toEqual(expect.arrayContaining(["rate"]));
  });

  it("fails closed on invalid quantity types and bounds", () => {
    expect(
      codes({
        ...base,
        items: [{ ...base.items[0]!, minimumQuantityScaled: "1" as never }],
      }),
    ).toEqual(expect.arrayContaining(["type"]));
    expect(
      codes({
        ...base,
        items: [
          { ...base.items[0]!, minimumQuantityScaled: 20_000, maximumQuantityScaled: 10_000 },
        ],
      }),
    ).toEqual(expect.arrayContaining(["quantity_bounds"]));
  });

  it("fails closed on unknown renderer, self-approval, live writes, and invalid currency", () => {
    expect(
      codes({ ...base, template: { ...base.template, rendererAdapter: "office-word" } }),
    ).toEqual(expect.arrayContaining(["renderer"]));
    expect(codes({ ...base, approval: { ...base.approval, selfApprovalAllowed: true } })).toEqual(
      expect.arrayContaining(["self_approval"]),
    );
    expect(codes({ ...base, delivery: { ...base.delivery, liveWrites: true } })).toEqual(
      expect.arrayContaining(["live_writes"]),
    );
    expect(codes({ ...base, currency: "US" })).toEqual(expect.arrayContaining(["currency"]));
  });

  it("fails closed on invalid and reversed effective dates", () => {
    expect(codes({ ...base, items: [{ ...base.items[0]!, effectiveFrom: "not-a-date" }] })).toEqual(
      expect.arrayContaining(["effective_date"]),
    );
    expect(
      codes({
        ...base,
        items: [
          {
            ...base.items[0]!,
            effectiveFrom: "2026-09-02T00:00:00.000Z",
            effectiveTo: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    ).toEqual(expect.arrayContaining(["effective_date_range"]));
  });

  it("fails closed on synthetic mismatch, unknown execution properties, and production packages", () => {
    expect(codes({ ...base, items: [{ ...base.items[0]!, synthetic: false }] })).toEqual(
      expect.arrayContaining(["synthetic"]),
    );
    expect(codes({ ...base, formula: "unit * 2" })).toEqual(
      expect.arrayContaining(["unknown_execution_property"]),
    );
    expect(codes({ ...base, constructor: "Function" })).toEqual(
      expect.arrayContaining(["prototype_pollution"]),
    );
    expect(codes(PRODUCTION_SERVICE_CATALOG_PLACEHOLDER)).toEqual(
      expect.arrayContaining(["items", "production"]),
    );
    const productionLooking = jsonClone(base);
    productionLooking.synthetic = false;
    productionLooking.productionReady = true;
    productionLooking.catalogKey = "bea-production-service-catalog";
    expect(codes(productionLooking)).toEqual(expect.arrayContaining(["production"]));
  });
});

describe("Phase 3.3A complete catalog identity", () => {
  const pack = parseCatalogPackage(SYNTHETIC_ENVELOPE_CATALOG);
  const baseline = identity(pack);

  it("uses SHA-256 of canonical JSON and rejects unsafe JSON values", () => {
    expect(baseline).toMatch(/^[a-f0-9]{64}$/u);
    expect(sha256Utf8("abc")).toHaveLength(64);
    expect(() => canonicalCommercialJson({ value: Number.NaN })).toThrow(/NaN/u);
    expect(() => canonicalCommercialJson({ value: () => 1 })).toThrow(/function/u);
  });

  it("changes identity when any commercially meaningful field changes", () => {
    const mutations: Array<ServiceCatalogPackage> = [
      { ...pack, displayName: `${pack.displayName} changed` },
      { ...pack, serviceContextKey: "synthetic-moisture-investigation" },
      { ...pack, currency: "CAD" },
      {
        ...pack,
        items: [{ ...pack.items[0]!, serviceCode: "CHANGED" }, ...pack.items.slice(1)],
      },
      {
        ...pack,
        items: [{ ...pack.items[0]!, description: "Changed description" }, ...pack.items.slice(1)],
      },
      {
        ...pack,
        items: [{ ...pack.items[0]!, scopeTemplate: "Changed scope" }, ...pack.items.slice(1)],
      },
      {
        ...pack,
        items: [
          { ...pack.items[0]!, defaultDeliverables: ["Changed deliverable"] },
          ...pack.items.slice(1),
        ],
      },
      {
        ...pack,
        items: [
          { ...pack.items[0]!, defaultAssumptions: ["Changed assumption"] },
          ...pack.items.slice(1),
        ],
      },
      {
        ...pack,
        items: [
          { ...pack.items[0]!, defaultExclusions: ["Changed exclusion"] },
          ...pack.items.slice(1),
        ],
      },
      {
        ...pack,
        items: [{ ...pack.items[0]!, defaultRateMinor: 22200 }, ...pack.items.slice(1)],
      },
      {
        ...pack,
        items: [{ ...pack.items[0]!, minimumQuantityScaled: 20_000 }, ...pack.items.slice(1)],
      },
      {
        ...pack,
        items: [{ ...pack.items[0]!, maximumQuantityScaled: 90_000 }, ...pack.items.slice(1)],
      },
      {
        ...pack,
        items: [
          { ...pack.items[0]!, eligibilityNotes: "Changed eligibility" },
          ...pack.items.slice(1),
        ],
      },
      {
        ...pack,
        items: [
          { ...pack.items[0]!, requiredLeadInformation: ["changed_field"] },
          ...pack.items.slice(1),
        ],
      },
      {
        ...pack,
        items: [{ ...pack.items[0]!, options: ["changed-option"] }, ...pack.items.slice(1)],
      },
      {
        ...pack,
        items: [
          { ...pack.items[0]!, effectiveFrom: "2027-01-01T00:00:00.000Z" },
          ...pack.items.slice(1),
        ],
      },
      {
        ...pack,
        items: [{ ...pack.items[0]!, active: false }, ...pack.items.slice(1)],
      },
      { ...pack, terms: { ...pack.terms, termsText: "Changed terms" } },
      { ...pack, terms: { ...pack.terms, acceptanceLanguage: "Changed acceptance" } },
      { ...pack, terms: { ...pack.terms, validityDays: 30 } },
      { ...pack, template: { ...pack.template, introText: "Changed intro" } },
      { ...pack, template: { ...pack.template, sectionOrder: ["changed"] } },
      { ...pack, template: { ...pack.template, footerText: "Changed footer" } },
      { ...pack, delivery: { ...pack.delivery, senderMailbox: "other@example.invalid" } },
      { ...pack, delivery: { ...pack.delivery, subjectTemplate: "Changed subject {reference}" } },
      { ...pack, delivery: { ...pack.delivery, bodyTemplate: "Changed body" } },
      { ...pack, delivery: { ...pack.delivery, requiredScopes: ["changed.scope"] } },
    ];
    for (const mutated of mutations) {
      expect(identity(mutated)).not.toBe(baseline);
    }
    expect(
      computeCatalogIdentityChecksum({
        catalogId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        catalogVersionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        catalogVersionNumber: 1,
        pack: { ...pack, approval: { ...pack.approval, reviewerRole: "sales" } },
      }),
    ).not.toBe(baseline);
    expect(
      computeCatalogIdentityChecksum({
        catalogId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        catalogVersionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        catalogVersionNumber: 1,
        pack: { ...pack, synthetic: false, productionReady: true },
      }),
    ).not.toBe(baseline);
  });

  it("does not reorder commercially meaningful arrays when canonicalizing", () => {
    const canonical = canonicalCommercialJson({
      sectionOrder: ["cover", "scope", "price"],
      defaultDeliverables: ["one", "two"],
    });
    expect(canonical).toContain('["cover","scope","price"]');
    expect(canonical).toContain('["one","two"]');
  });
});

describe("Phase 3.3A override, work, reviewer, and status predicates", () => {
  it("allows override mutation only in editable proposal statuses", () => {
    const allowed: readonly ProposalStatus[] = [
      "draft",
      "needs_information",
      "ready_for_review",
      "revision_required",
    ];
    const blocked: readonly ProposalStatus[] = [
      "in_review",
      "approved",
      "ready_for_delivery",
      "cancelled",
      "superseded",
    ];
    for (const status of allowed) expect(proposalAllowsOverrideMutation(status)).toBe(true);
    for (const status of blocked) expect(proposalAllowsOverrideMutation(status)).toBe(false);
  });

  it("builds distinct information-cycle identities and requires a cycle number", () => {
    expect(
      buildWorkItemCycleIdentity({
        kind: "proposal_information",
        proposalId: "p1",
        informationCycleNumber: 1,
      }),
    ).toBe("proposal:p1:information:1");
    expect(
      buildWorkItemCycleIdentity({
        kind: "proposal_information",
        proposalId: "p1",
        informationCycleNumber: 2,
      }),
    ).toBe("proposal:p1:information:2");
  });

  it("limits Sales commercial work kinds and keeps reviewer eligibility Owner-only", () => {
    expect(isSalesCommercialWorkKind("proposal_preparation")).toBe(true);
    expect(isSalesCommercialWorkKind("proposal_information")).toBe(true);
    expect(isSalesCommercialWorkKind("proposal_revision")).toBe(true);
    expect(isSalesCommercialWorkKind("proposal_delivery_preparation")).toBe(true);
    expect(isSalesCommercialWorkKind("proposal_review")).toBe(false);
    expect(isSalesCommercialWorkKind("proposal_pricing_override")).toBe(false);
    expect(isSalesCommercialWorkKind("inspection_readiness")).toBe(false);
    expect(COMMERCIAL_APPROVER_ELIGIBILITY_SQL).toContain("proposals.approve");
    expect(COMMERCIAL_APPROVER_ELIGIBILITY_SQL).toContain("owner-admin");
    expect(COMMERCIAL_OVERRIDE_APPROVER_ELIGIBILITY_SQL).toContain("proposals.override.approve");
    expect(COMMERCIAL_OVERRIDE_APPROVER_ELIGIBILITY_SQL).toContain("owner-admin");
    expect(COMMERCIAL_OVERRIDE_APPROVER_ELIGIBILITY_SQL).not.toMatch(
      /p\.key='proposals\.approve'/u,
    );
  });

  it("maps commercial events to actual proposal statuses, never event names", () => {
    expect(proposalStatusForCommercialEvent("proposal.needs_information")).toBe(
      "needs_information",
    );
    expect(proposalStatusForCommercialEvent("proposal.pricing_override_requested")).toBeNull();
    expect(proposalStatusForCommercialEvent("proposal.updated")).toBeNull();
    expect(isProposalStatus("proposal.created")).toBe(false);
    expect(isProposalStatus("approved")).toBe(true);
  });
});
