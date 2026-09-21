import { describe, expect, it } from "vitest";

import {
  COMMERCIAL_PRODUCTION_UNCONFIGURED,
  COMMERCIAL_SYNTHETIC_DISCLOSURE,
  MONEY_ROUNDING_POLICY,
  PROPOSAL_EMAIL_DRY_RUN_DISCLOSURE,
  QUANTITY_SCALE,
  SYNTHETIC_ENVELOPE_CATALOG,
  SYNTHETIC_MOISTURE_CATALOG,
  SYNTHETIC_WORK_ROUTING_BLUEPRINTS,
  assertProposalStatusTransition,
  buildProposalDocument,
  buildWorkItemCycleIdentity,
  calculatePricingSnapshot,
  catalogPackageIdentityMaterial,
  compareProposalVersions,
  eventIdentityContractFor,
  evaluateProposalReadiness,
  formatProposalReference,
  jsonClone,
  lineSubtotalMinor,
  minorToDisplay,
  overrideDifferenceMinor,
  proposalDocumentToRenderLines,
  quantityToScaled,
  resolveWorkCycleIdentity,
  roundHalfAwayFromZero,
  scaledToQuantityString,
  validateCatalogPackage,
  MoneyArithmeticError,
  ProposalStatusTransitionError,
  type ProposalLeadSnapshot,
  type ProposalLineDraft,
  type ProposalPricingOverride,
  type ProposalVersion,
} from "../../packages/domain/src/index.js";
import { PERMISSIONS, authorize } from "../../packages/security/src/index.js";
import { DEMO_ROLE_IDS } from "../../packages/domain/src/index.js";

function snapshot(overrides: Partial<ProposalLeadSnapshot> = {}): ProposalLeadSnapshot {
  return {
    leadId: "a1000000-0000-4000-8000-000000000003",
    leadReference: "BEA-LD-000003",
    leadStatus: "ready_for_proposal",
    opportunityName: "Synthetic Harbor envelope advisory",
    requestSummary: "Lab-only envelope request.",
    requestedService: "Synthetic envelope advisory",
    siteName: "Harbor lab",
    siteAddressLine1: "1 Example Way",
    siteAddressLine2: null,
    siteCity: "Example City",
    siteRegion: "EX",
    sitePostalCode: "00000",
    siteCountry: "US",
    desiredDeadlineAt: "2026-09-15T00:00:00.000Z",
    requestedVisitAt: "2026-09-08T00:00:00.000Z",
    parties: [
      {
        role: "client_company",
        companyId: "90000000-0000-4000-8000-000000000001",
        contactId: null,
        unmatchedCompanyName: null,
        unmatchedContactName: null,
        displayName: "Northstar Facade Group",
      },
      {
        role: "primary_contact",
        companyId: null,
        contactId: "91000000-0000-4000-8000-000000000001",
        unmatchedCompanyName: null,
        unmatchedContactName: "Morgan Demo",
        displayName: "Morgan Demo",
      },
    ],
    ...overrides,
  };
}

function line(overrides: Partial<ProposalLineDraft> = {}): ProposalLineDraft {
  const item = SYNTHETIC_ENVELOPE_CATALOG.items[0]!;
  return {
    lineKey: item.serviceKey,
    serviceKey: item.serviceKey,
    serviceCode: item.serviceCode,
    displayName: item.displayName,
    pricingModel: item.pricingModel,
    unitOfMeasure: item.unitOfMeasure,
    currency: "USD",
    catalogUnitAmountMinor: item.defaultRateMinor,
    unitAmountMinor: item.defaultRateMinor,
    quantityScaled: item.minimumQuantityScaled,
    lineSubtotalMinor: item.defaultRateMinor,
    calculationMethod: item.pricingModel,
    scopeText: item.scopeTemplate,
    deliverables: item.defaultDeliverables,
    assumptions: item.defaultAssumptions,
    exclusions: item.defaultExclusions,
    overrideId: null,
    displayOrder: 10,
    ...overrides,
  };
}

describe("Phase 3.3A money arithmetic", () => {
  it("stores and rounds money in integer minor units", () => {
    expect(lineSubtotalMinor(11100n, QUANTITY_SCALE)).toBe(11100n);
    expect(lineSubtotalMinor(333n, 15_000n)).toBe(500n);
    expect(roundHalfAwayFromZero(5n, 2n)).toBe(3n);
    expect(roundHalfAwayFromZero(-5n, 2n)).toBe(-3n);
    expect(roundHalfAwayFromZero(1n, 4n)).toBe(0n);
    expect(minorToDisplay(11100n, "usd")).toBe("USD 111.00");
    expect(MONEY_ROUNDING_POLICY).toBe("half_away_from_zero");
  });

  it("rejects floating-point and negative money as authority", () => {
    expect(() => lineSubtotalMinor(-1n, QUANTITY_SCALE)).toThrow(MoneyArithmeticError);
    expect(() => quantityToScaled("-1")).toThrow(MoneyArithmeticError);
    expect(() => quantityToScaled("1.23456")).toThrow(MoneyArithmeticError);
    expect(quantityToScaled("1.25")).toBe(12_500n);
    expect(scaledToQuantityString(12_500n)).toBe("1.25");
  });

  it("prohibits mixed currencies and oversized discounts", () => {
    expect(() =>
      calculatePricingSnapshot({
        catalog: SYNTHETIC_ENVELOPE_CATALOG,
        catalogVersionId: "cat-1",
        catalogVersionNumber: 1,
        lines: [line(), line({ lineKey: "other", currency: "CAD" })],
      }),
    ).toThrow(/Mixed currencies/u);
    expect(() =>
      calculatePricingSnapshot({
        catalog: SYNTHETIC_ENVELOPE_CATALOG,
        catalogVersionId: "cat-1",
        catalogVersionNumber: 1,
        lines: [line()],
        discountMinor: 999_999,
      }),
    ).toThrow(/Discount cannot exceed/u);
  });

  it("separates allowance and reimbursable totals", () => {
    const pricing = calculatePricingSnapshot({
      catalog: SYNTHETIC_MOISTURE_CATALOG,
      catalogVersionId: "cat-m",
      catalogVersionNumber: 1,
      lines: [
        {
          ...line({
            lineKey: "syn-moi-probe-unit",
            serviceKey: "syn-moi-probe-unit",
            pricingModel: "unit_rate",
            catalogUnitAmountMinor: 19900,
            unitAmountMinor: 19900,
            quantityScaled: 20_000,
          }),
        },
        {
          ...line({
            lineKey: "syn-moi-equipment-reimbursable",
            serviceKey: "syn-moi-equipment-reimbursable",
            pricingModel: "reimbursable",
            catalogUnitAmountMinor: 7600,
            unitAmountMinor: 7600,
            quantityScaled: 10_000,
          }),
        },
      ],
    });
    expect(pricing.reimbursableMinor).toBe(7600);
    expect(pricing.subtotalMinor).toBe(39800);
    expect(pricing.totalMinor).toBe(47400);
    expect(pricing.taxConfigured).toBe(false);
  });
});

describe("Phase 3.3A catalog validation", () => {
  it("accepts the seeded synthetic catalogs", () => {
    expect(validateCatalogPackage(SYNTHETIC_ENVELOPE_CATALOG)).toEqual([]);
    expect(validateCatalogPackage(SYNTHETIC_MOISTURE_CATALOG)).toEqual([]);
    expect(SYNTHETIC_ENVELOPE_CATALOG.template.templateKey).not.toBe(
      SYNTHETIC_MOISTURE_CATALOG.template.templateKey,
    );
  });

  it("fails closed on duplicate keys, non-integer rates, and production activation", () => {
    const duplicate = jsonClone(SYNTHETIC_ENVELOPE_CATALOG);
    duplicate.items = [...duplicate.items, duplicate.items[0]!];
    expect(
      validateCatalogPackage(duplicate).some((item) => item.code === "duplicate_service"),
    ).toBe(true);
    const rate = jsonClone(SYNTHETIC_ENVELOPE_CATALOG);
    rate.items = [{ ...rate.items[0]!, defaultRateMinor: 11.5 as unknown as number }];
    expect(validateCatalogPackage(rate).some((item) => item.code === "rate")).toBe(true);
    const production = jsonClone(SYNTHETIC_ENVELOPE_CATALOG);
    production.synthetic = false;
    production.productionReady = true;
    expect(validateCatalogPackage(production).some((item) => item.code === "production")).toBe(
      true,
    );
  });

  it("changes identity when a synthetic rate changes", () => {
    const left = catalogPackageIdentityMaterial({
      catalogKey: SYNTHETIC_ENVELOPE_CATALOG.catalogKey,
      versionNumber: 1,
      currency: "USD",
      items: SYNTHETIC_ENVELOPE_CATALOG.items,
      terms: SYNTHETIC_ENVELOPE_CATALOG.terms,
      approval: SYNTHETIC_ENVELOPE_CATALOG.approval,
      template: SYNTHETIC_ENVELOPE_CATALOG.template,
    });
    const mutated = jsonClone(SYNTHETIC_ENVELOPE_CATALOG);
    mutated.items = [{ ...mutated.items[0]!, defaultRateMinor: 22200 }, ...mutated.items.slice(1)];
    const right = catalogPackageIdentityMaterial({
      catalogKey: mutated.catalogKey,
      versionNumber: 2,
      currency: "USD",
      items: mutated.items,
      terms: mutated.terms,
      approval: mutated.approval,
      template: mutated.template,
    });
    expect(left).not.toBe(right);
  });
});

describe("Phase 3.3A proposal readiness and transitions", () => {
  it("blocks review when services or scope are missing", () => {
    const empty = evaluateProposalReadiness({
      leadStatus: "ready_for_proposal",
      leadReadyForProposal: true,
      snapshot: snapshot(),
      catalog: SYNTHETIC_ENVELOPE_CATALOG,
      catalogStatus: "active",
      lines: [],
      pricing: calculatePricingSnapshot({
        catalog: SYNTHETIC_ENVELOPE_CATALOG,
        catalogVersionId: "cat-1",
        catalogVersionNumber: 1,
        lines: [],
      }),
      scopeText: "",
      assignedReviewerUserId: "owner",
      overrides: [],
    });
    expect(empty.readyForReview).toBe(false);
    expect(empty.blocking.map((item) => item.code)).toEqual(
      expect.arrayContaining(["missing_service_line", "missing_scope"]),
    );
  });

  it("blocks unapproved overrides and production catalogs", () => {
    const override: ProposalPricingOverride = {
      id: "ovr-1",
      proposalId: "p1",
      proposalVersionId: null,
      targetVersionNumber: 1,
      draftCycleNumber: 1,
      lineKey: "syn-env-fixed-advisory",
      originalAmountMinor: 11100,
      proposedAmountMinor: 5000,
      differenceMinor: -6100,
      reason: "Synthetic lab discount request.",
      status: "requested",
      requestedByUserId: "sales",
      approvedByUserId: null,
      approvedAt: null,
      synthetic: true,
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
      version: 1,
    };
    const blocked = evaluateProposalReadiness({
      leadStatus: "ready_for_proposal",
      leadReadyForProposal: true,
      snapshot: snapshot(),
      catalog: SYNTHETIC_ENVELOPE_CATALOG,
      catalogStatus: "active",
      lines: [line()],
      pricing: calculatePricingSnapshot({
        catalog: SYNTHETIC_ENVELOPE_CATALOG,
        catalogVersionId: "cat-1",
        catalogVersionNumber: 1,
        lines: [line()],
      }),
      scopeText: "Synthetic lab scope.",
      assignedReviewerUserId: "owner",
      overrides: [override],
    });
    expect(blocked.blocking.some((item) => item.code === "unapproved_override")).toBe(true);
    const production = evaluateProposalReadiness({
      leadStatus: "ready_for_proposal",
      leadReadyForProposal: true,
      snapshot: snapshot(),
      catalog: { ...SYNTHETIC_ENVELOPE_CATALOG, synthetic: false },
      catalogStatus: "draft",
      lines: [line()],
      pricing: calculatePricingSnapshot({
        catalog: SYNTHETIC_ENVELOPE_CATALOG,
        catalogVersionId: "cat-1",
        catalogVersionNumber: 1,
        lines: [line()],
      }),
      scopeText: "Synthetic lab scope.",
      assignedReviewerUserId: "owner",
      overrides: [],
      productionCatalogRequested: true,
    });
    expect(
      production.blocking.some((item) => item.code === "production_catalog_unconfigured"),
    ).toBe(true);
    expect(production.blocking.some((item) => item.origin === "production_blocker")).toBe(true);
    expect(COMMERCIAL_PRODUCTION_UNCONFIGURED).toMatch(/UNCONFIGURED/u);
  });

  it("rejects same-status and illegal transitions", () => {
    expect(() => assertProposalStatusTransition("draft", "draft")).toThrow(
      ProposalStatusTransitionError,
    );
    expect(() => assertProposalStatusTransition("approved", "draft")).toThrow(
      ProposalStatusTransitionError,
    );
    expect(() => assertProposalStatusTransition("draft", "ready_for_review")).not.toThrow();
    expect(() => assertProposalStatusTransition("in_review", "approved")).not.toThrow();
    expect(() => assertProposalStatusTransition("approved", "ready_for_delivery")).not.toThrow();
  });

  it("formats proposal references before freeze", () => {
    expect(formatProposalReference(1)).toBe("BEA-PP-000001");
    expect(formatProposalReference(42)).toBe("BEA-PP-000042");
  });
});

describe("Phase 3.3A documents, overrides, and events", () => {
  it("renders materially different documents from two synthetic catalogs", () => {
    const envelopePricing = calculatePricingSnapshot({
      catalog: SYNTHETIC_ENVELOPE_CATALOG,
      catalogVersionId: "env-1",
      catalogVersionNumber: 1,
      lines: [line()],
    });
    const moistureItem = SYNTHETIC_MOISTURE_CATALOG.items[0]!;
    const moisturePricing = calculatePricingSnapshot({
      catalog: SYNTHETIC_MOISTURE_CATALOG,
      catalogVersionId: "moi-1",
      catalogVersionNumber: 1,
      lines: [
        line({
          lineKey: moistureItem.serviceKey,
          serviceKey: moistureItem.serviceKey,
          displayName: moistureItem.displayName,
          pricingModel: moistureItem.pricingModel,
          catalogUnitAmountMinor: moistureItem.defaultRateMinor,
          unitAmountMinor: moistureItem.defaultRateMinor,
          quantityScaled: moistureItem.minimumQuantityScaled,
        }),
      ],
    });
    const envelope = buildProposalDocument({
      proposal: { reference: "BEA-PP-000001", opportunityName: "Envelope lab", currency: "USD" },
      versionNumber: 1,
      previewKind: "frozen_review",
      catalog: SYNTHETIC_ENVELOPE_CATALOG,
      catalogVersionNumber: 1,
      snapshot: snapshot(),
      pricing: envelopePricing,
      scopeText: "Envelope lab scope.",
      deliverables: ["Synthetic advisory summary"],
      assumptions: ["Access is available."],
      exclusions: ["Destructive testing"],
      scheduleText: "Week of 8 September 2026",
      preparedAt: "2026-09-02T12:00:00.000Z",
    });
    const moisture = buildProposalDocument({
      proposal: { reference: "BEA-PP-000002", opportunityName: "Moisture lab", currency: "USD" },
      versionNumber: 1,
      previewKind: "frozen_review",
      catalog: SYNTHETIC_MOISTURE_CATALOG,
      catalogVersionNumber: 1,
      snapshot: snapshot({ opportunityName: "Moisture lab" }),
      pricing: moisturePricing,
      scopeText: "Moisture lab scope.",
      deliverables: ["Synthetic moisture log"],
      assumptions: ["Openings can be accessed."],
      exclusions: ["Repair design"],
      scheduleText: "Week of 15 September 2026",
      preparedAt: "2026-09-02T12:00:00.000Z",
    });
    const envelopeText = proposalDocumentToRenderLines(envelope).join("\n");
    const moistureText = proposalDocumentToRenderLines(moisture).join("\n");
    expect(envelope.templateKey).toBe("synthetic-proposal-letter");
    expect(moisture.templateKey).toBe("synthetic-proposal-sectioned");
    expect(envelopeText).toContain("Synthetic Envelope");
    expect(moistureText).toContain("Synthetic Moisture");
    expect(envelopeText).not.toBe(moistureText);
    expect(envelopeText).toContain(COMMERCIAL_SYNTHETIC_DISCLOSURE);
    expect(envelopeText).toContain("BEA-PP-000001");
  });

  it("keeps original and proposed override amounts visible", () => {
    expect(overrideDifferenceMinor(11100, 5000)).toBe(-6100);
    expect(overrideDifferenceMinor(11100, 11100)).toBe(0);
  });

  it("requires exact proposal-version identities for review cycles", () => {
    const submitted = eventIdentityContractFor("proposal.submitted_for_review");
    expect(submitted?.fields.map((field) => field.field)).toEqual(
      expect.arrayContaining(["proposalId", "proposalVersionId"]),
    );
    const review = SYNTHETIC_WORK_ROUTING_BLUEPRINTS.find(
      (item) => item.workItemKind === "proposal_review",
    )!;
    const missing = resolveWorkCycleIdentity({
      blueprint: review,
      action: "create",
      identity: {
        eventType: "proposal.submitted_for_review",
        eventId: "e1",
        inspectionId: null,
        reportId: null,
        reportVersionId: null,
        requestedRevisionVersionId: null,
        submissionId: null,
        exceptionId: null,
        exceptionIds: [],
        exceptionIdsPresent: false,
        deliveryId: null,
        deliveryAuthorizationId: null,
        jobId: null,
        projectionEventId: null,
        scheduledActionId: null,
        failureSourceType: null,
        failureSourceId: null,
        leadId: "lead-1",
        proposalId: "proposal-1",
        proposalVersionId: null,
        catalogVersionId: "cat-1",
        pricingOverrideId: null,
        informationCycleNumber: null,
      },
    });
    expect(missing.kind).toBe("malformed_missing_identity");
    expect(
      buildWorkItemCycleIdentity({
        kind: "proposal_review",
        proposalId: "proposal-1",
        proposalVersionId: "version-1",
      }),
    ).toBe("proposal:proposal-1:review:version-1");
    expect(
      buildWorkItemCycleIdentity({
        kind: "proposal_review",
        proposalId: "proposal-1",
        proposalVersionId: "version-2",
      }),
    ).not.toBe("proposal:proposal-1:review:version-1");
  });

  it("does not treat work permissions as commercial approval", () => {
    expect(
      authorize({ roleIds: [DEMO_ROLE_IDS.SALES] }, PERMISSIONS.PROPOSALS_APPROVE).allowed,
    ).toBe(false);
    expect(PROPOSAL_EMAIL_DRY_RUN_DISCLOSURE).toBe("PROPOSAL EMAIL DRY-RUN — NO MESSAGE SENT");
  });

  it("compares frozen versions without mutating either record", () => {
    const left = {
      id: "v1",
      proposalId: "p1",
      versionNumber: 1,
      scopeText: "one",
      scheduleText: null,
      pricingSnapshot: { totalMinor: 11100, catalogVersionId: "c1" },
      lineItemSnapshot: [{ lineKey: "a" }],
      deliverables: ["d"],
      assumptions: ["a"],
      exclusions: ["e"],
    } as unknown as ProposalVersion;
    const right = {
      ...left,
      id: "v2",
      versionNumber: 2,
      scopeText: "two",
      pricingSnapshot: { totalMinor: 22200, catalogVersionId: "c1" },
    } as unknown as ProposalVersion;
    expect(compareProposalVersions(left, right).changed).toEqual(
      expect.arrayContaining(["scope", "total"]),
    );
    expect(left.scopeText).toBe("one");
  });
});
