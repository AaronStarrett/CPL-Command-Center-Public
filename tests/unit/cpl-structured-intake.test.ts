import { describe, expect, it } from "vitest";
import {
  cplLeadMatchReasons,
  evaluateCplLeadReadiness,
  normalizeCplLeadFields,
} from "../../packages/domain/src/cpl-intake";

const assignedMemberIdentityId = "10000000-0000-4000-8000-000000000001";
const complete = () =>
  normalizeCplLeadFields(
    {
      title: "Service inquiry",
      contactName: "Fictional contact",
      details: "Inspect a fictional site",
      requestedService: "Advisory visit",
      assignedMemberIdentityId,
      nextAction: "Confirm scope",
    },
    undefined,
    "2026-09-23T12:00:00Z",
  );
describe("company-independent structured intake rules", () => {
  it("captures an incomplete inquiry and gives actionable blocking requirements", () => {
    const lead = normalizeCplLeadFields({ title: "A phone inquiry", sourceType: "phone" });
    const readiness = evaluateCplLeadReadiness(lead);
    expect(lead.contactName).toBe("");
    expect(readiness.readyForProposal).toBe(false);
    expect(
      readiness.missingInformation
        .filter((item) => item.severity === "blocking")
        .map((item) => item.code),
    ).toEqual([
      "request_details",
      "requested_service",
      "customer_identity",
      "assigned_member",
      "next_action",
    ]);
  });
  it("does not require an industry-specific physical site or visit date", () => {
    const readiness = evaluateCplLeadReadiness(complete());
    expect(readiness.readyForProposal).toBe(true);
    expect(readiness.missingInformation.map((item) => item.code)).toEqual([
      "site",
      "requested_date",
    ]);
    expect(readiness.missingInformation.every((item) => item.severity === "optional")).toBe(true);
  });
  it.each(["website_form", "email", "phone", "manual", "referral", "in_person", "crm_import"])(
    "normalizes the supported %s source",
    (sourceType) => {
      expect(normalizeCplLeadFields({ title: "Inquiry", sourceType }).sourceType).toBe(sourceType);
    },
  );
  it("retains prior fields during a partial correction without resetting receivedAt", () => {
    const prior = complete();
    const next = normalizeCplLeadFields({ notes: "Corrected after a phone call" }, prior);
    expect(next).toEqual({ ...prior, notes: "Corrected after a phone call" });
  });
  it("requires disqualification evidence and rejects unknown enums and malformed references", () => {
    for (const change of [
      { status: "awarded" },
      { sourceType: "guessed" },
      { status: "disqualified" },
      { customerId: "foreign-or-malformed" },
      { contactEmail: "not an email" },
      { receivedAt: "yesterday" },
    ])
      expect(() => normalizeCplLeadFields(change, complete())).toThrow("CPL_INVALID_INPUT");
    expect(
      normalizeCplLeadFields(
        { status: "disqualified", disqualificationReason: "Outside offered services" },
        complete(),
      ).status,
    ).toBe("disqualified");
  });
  it("treats duplicate matches as review candidates rather than identity authority", () => {
    const left = {
      ...complete(),
      contactEmail: "Person@Example.invalid",
      contactPhone: "+1 (555) 123-4567",
    };
    const right = {
      ...complete(),
      title: "Different inquiry",
      contactEmail: "person@example.invalid",
      contactPhone: "+15551234567",
    };
    expect(cplLeadMatchReasons(left, right)).toEqual(["same_contact_email", "same_contact_phone"]);
    expect(cplLeadMatchReasons(complete(), { ...complete(), title: "Another title" })).toEqual([]);
  });
  it("blocks proposal readiness for unresolved matches, marked duplicates and inactive ownership", () => {
    expect(
      evaluateCplLeadReadiness(complete(), { unresolvedDuplicates: true }).readyForProposal,
    ).toBe(false);
    expect(evaluateCplLeadReadiness(complete(), { markedDuplicate: true }).readyForProposal).toBe(
      false,
    );
    expect(
      evaluateCplLeadReadiness(complete(), { inactiveAssignee: true }).missingInformation,
    ).toContainEqual(expect.objectContaining({ code: "assigned_member", severity: "blocking" }));
    expect(
      evaluateCplLeadReadiness({
        ...complete(),
        status: "disqualified",
        disqualificationReason: "Out of scope",
      }).readyForProposal,
    ).toBe(false);
  });
});
