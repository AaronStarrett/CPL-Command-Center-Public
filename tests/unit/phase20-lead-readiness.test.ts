import { describe, expect, it } from "vitest";

import {
  LEAD_STATUS_TRANSITIONS,
  LeadReadyStatusInvariantError,
  LeadStatusTransitionError,
  assertLeadStatusTransition,
  assertReadyForProposalUpdateAllowed,
  evaluateLeadReadiness,
  formatLeadReference,
  isLeadStatusTransitionAllowed,
  parseLeadReferenceSequence,
} from "../../packages/domain/src/index.js";

describe("Phase 2.0 lead reference convention", () => {
  it("formats and parses BEA-LD-000000 identifiers", () => {
    expect(formatLeadReference(1)).toBe("BEA-LD-000001");
    expect(formatLeadReference(42)).toBe("BEA-LD-000042");
    expect(parseLeadReferenceSequence("BEA-LD-000042")).toBe(42);
    expect(parseLeadReferenceSequence("bea-ld-1")).toBeNull();
    expect(() => formatLeadReference(0)).toThrow(/positive integer/u);
  });
});

describe("Phase 2.0 lead review state machine", () => {
  it("documents the allowed correction transitions", () => {
    expect(LEAD_STATUS_TRANSITIONS).toEqual({
      new: ["needs_info", "ready_for_proposal", "disqualified"],
      needs_info: ["new", "ready_for_proposal", "disqualified"],
      ready_for_proposal: ["needs_info", "disqualified"],
      disqualified: ["new", "needs_info"],
    });
    expect(isLeadStatusTransitionAllowed("ready_for_proposal", "new")).toBe(false);
    expect(isLeadStatusTransitionAllowed("new", "new")).toBe(false);
    expect(() => assertLeadStatusTransition("disqualified", "ready_for_proposal")).toThrow(
      LeadStatusTransitionError,
    );
  });
});

describe("Phase 2.0 deterministic lead readiness evaluator", () => {
  const complete = {
    sourceType: "manual" as const,
    sourceDetails: null,
    receivedAt: "2026-08-20T14:30:00.000Z",
    opportunityName: "Synthetic envelope inquiry",
    requestSummary: "Inspect a demonstration facade.",
    requestedService: "Building envelope assessment",
    siteName: "Example campus",
    siteCity: "Example City",
    siteRegion: "EX",
    desiredDeadlineAt: "2026-09-15T17:00:00.000Z",
    requestedVisitAt: null,
    reviewerUserId: "10000000-0000-4000-8000-000000000002",
    parties: [
      {
        role: "client_company" as const,
        unmatchedCompanyName: "Northstar Facade Group",
      },
      {
        role: "primary_contact" as const,
        unmatchedContactName: "Morgan Demo",
      },
    ],
  };

  it("requires blocking intake fields before ready-for-proposal", () => {
    const missing = evaluateLeadReadiness({
      sourceType: null,
      sourceDetails: null,
      receivedAt: null,
      opportunityName: " ",
      requestSummary: "",
      requestedService: null,
      siteName: null,
      siteCity: null,
      siteRegion: null,
      desiredDeadlineAt: null,
      requestedVisitAt: null,
      reviewerUserId: null,
      parties: [],
    });
    expect(missing.readyForProposal).toBe(false);
    expect(missing.blocking.map((item) => item.code)).toEqual([
      "opportunity_name",
      "request_summary",
      "source_type",
      "received_at",
      "requested_service",
      "identified_client_or_contact",
    ]);
    expect(missing.optional.map((item) => item.code)).toEqual([
      "site_location",
      "desired_deadline_or_visit",
      "reviewer_assignment",
      "requester",
      "property_owner",
      "general_contractor",
      "approval_authority",
      "billing_contact",
    ]);
  });

  it("requires referral source details only for referral intake", () => {
    const referral = evaluateLeadReadiness({
      ...complete,
      sourceType: "referral",
      sourceDetails: " ",
    });
    expect(referral.blocking.map((item) => item.code)).toContain("referral_source_details");
    expect(
      evaluateLeadReadiness({ ...complete, sourceType: "in_person", sourceDetails: null })
        .readyForProposal,
    ).toBe(true);
  });

  it("accepts unmatched or canonical party identity for the blocking client/contact rule", () => {
    expect(
      evaluateLeadReadiness({
        ...complete,
        parties: [{ role: "requester", unmatchedContactName: "Alex Referral" }],
      }).readyForProposal,
    ).toBe(true);
    expect(
      evaluateLeadReadiness({
        ...complete,
        parties: [{ role: "client_company", companyId: "90000000-0000-4000-8000-000000000001" }],
      }).readyForProposal,
    ).toBe(true);
  });

  it("rejects ready-for-proposal updates that introduce blocking gaps", () => {
    const ready = evaluateLeadReadiness(complete);
    expect(ready.readyForProposal).toBe(true);
    expect(() => assertReadyForProposalUpdateAllowed("ready_for_proposal", ready)).not.toThrow();
    const blocked = evaluateLeadReadiness({ ...complete, requestedService: null });
    expect(() => assertReadyForProposalUpdateAllowed("ready_for_proposal", blocked)).toThrow(
      LeadReadyStatusInvariantError,
    );
    expect(() => assertReadyForProposalUpdateAllowed("needs_info", blocked)).not.toThrow();
    expect(() => assertReadyForProposalUpdateAllowed("new", blocked)).not.toThrow();
  });

  it("does not treat optional site, visit, reviewer, or billing identity as blocking", () => {
    const result = evaluateLeadReadiness({
      ...complete,
      siteName: null,
      siteCity: null,
      siteRegion: null,
      desiredDeadlineAt: null,
      requestedVisitAt: null,
      reviewerUserId: null,
      parties: [{ role: "client_company", unmatchedCompanyName: "Cedar Ridge Facilities" }],
    });
    expect(result.readyForProposal).toBe(true);
    expect(result.optional.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "site_location",
        "desired_deadline_or_visit",
        "reviewer_assignment",
        "billing_contact",
      ]),
    );
  });
});
