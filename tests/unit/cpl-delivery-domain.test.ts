import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  normalizeCplDeliveryInput,
  normalizeCplCloseoutPolicy,
  normalizeCplCloseoutFacts,
  normalizeCplManualDelivery,
  cplDeliveryInstant,
  cplDeliveryPublicManifest,
  cplDeliveryMessageText,
  cplBillingHandoff,
  type CplDeliveryPackage,
  type CplCloseoutReadiness,
} from "../../packages/domain/src/cpl-delivery";
const input = () => ({
  customerName: "Fictional Customer",
  contactName: "Fictional Contact",
  recipient: "customer@example.invalid",
  subject: "Approved report",
  message: "Human customer message.",
  attachments: [{ reportId: randomUUID(), version: 4 }],
});
function pkg(): CplDeliveryPackage {
  const value = input();
  return {
    id: randomUUID(),
    projectId: randomUUID(),
    reference: "DEL-FICTIONAL",
    revision: 1,
    currentVersion: 1,
    state: "draft",
    readiness: { ready: false, canMarkReady: true, reasons: [] },
    events: [],
    versions: [
      {
        version: 1,
        input: value,
        preparedByIdentityId: randomUUID(),
        preparedAt: "2026-09-23T00:00:00Z",
        state: "draft",
        attachments: [
          {
            ...value.attachments[0]!,
            reference: "RPT-FICTIONAL",
            title: "Public report",
            sha256: "a".repeat(64),
            byteLength: 100,
            approvedAt: "2026-09-23T00:00:00Z",
          },
        ],
      },
    ],
  };
}
describe("delivery and closeout public contracts", () => {
  it("keeps explicit approved version and strips extra private input", () => {
    const v = normalizeCplDeliveryInput({
      ...input(),
      internalNotes: "PRIVATE",
      paths: ["D:/PRIVATE"],
      providerReceipt: "fake",
    });
    expect(v.attachments[0]?.version).toBe(4);
    expect(v).not.toHaveProperty("internalNotes");
    expect(v).not.toHaveProperty("paths");
  });
  it.each(["subject", "recipient", "customerName", "contactName"])(
    "rejects line/header injection in %s",
    (field) => {
      expect(() =>
        normalizeCplDeliveryInput({
          ...input(),
          [field]: "Customer\nBcc: attacker@example.invalid",
        }),
      ).toThrow();
    },
  );
  it("requires at least one bounded unique approved-artifact selection", () => {
    const v = input();
    expect(() => normalizeCplDeliveryInput({ ...v, attachments: [] })).toThrow();
    expect(() =>
      normalizeCplDeliveryInput({ ...v, attachments: [v.attachments[0], v.attachments[0]] }),
    ).toThrow();
    expect(() =>
      normalizeCplDeliveryInput({ ...v, attachments: [{ reportId: randomUUID(), version: 0 }] }),
    ).toThrow();
    expect(() =>
      normalizeCplDeliveryInput({
        ...v,
        attachments: Array.from({ length: 11 }, () => ({ reportId: randomUUID(), version: 1 })),
      }),
    ).toThrow();
    expect(() =>
      normalizeCplDeliveryInput({ ...v, attachments: [{ path: "D:/PRIVATE", version: 4 }] }),
    ).toThrow();
  });
  it("allows an incomplete recipient in draft but bounds message text", () => {
    expect(normalizeCplDeliveryInput({ ...input(), recipient: "" }).recipient).toBe("");
    expect(() => normalizeCplDeliveryInput({ ...input(), message: "x".repeat(20001) })).toThrow();
  });
  it("requires explicit booleans and preserves exact organization/service policy", () => {
    const p = {
      serviceKey: "Building envelope",
      name: "Agreed milestone",
      requireAward: true,
      requireWorkCompleted: false,
      requireApprovedReport: false,
      requireDelivery: false,
      requirePurchaseOrder: true,
      requireIssuesDisposed: true,
    };
    expect(normalizeCplCloseoutPolicy(p)).toEqual(p);
    expect(normalizeCplCloseoutPolicy({ ...p, serviceKey: "*" }).serviceKey).toBe("*");
    expect(() => normalizeCplCloseoutPolicy({ ...p, requireDelivery: "false" })).toThrow();
  });
  it("rejects duplicated/disposed issues without evidence and requires stale-sensitive source hashes", () => {
    const value = {
      purchaseOrder: "PO fictional",
      requiredReport: null,
      issueDispositions: [],
      manualIssues: [],
    };
    expect(normalizeCplCloseoutFacts(value)).toEqual(value);
    expect(() =>
      normalizeCplCloseoutFacts({
        ...value,
        manualIssues: [{ id: randomUUID(), title: "Issue", status: "resolved", reason: "" }],
      }),
    ).toThrow();
    expect(() =>
      normalizeCplCloseoutFacts({
        ...value,
        issueDispositions: [
          {
            sourceKey: "observation:x",
            factHash: "bad",
            disposition: "accepted",
            reason: "Recorded human decision",
          },
        ],
      }),
    ).toThrow();
  });
  it("rejects future or timezone-ambiguous manual evidence and missing recipient", () => {
    const now = Date.parse("2026-09-23T12:00:00Z");
    expect(cplDeliveryInstant("2026-09-23T10:00:00-01:00", now)).toBe("2026-09-23T11:00:00.000Z");
    expect(() => cplDeliveryInstant("2026-09-23T13:00:00Z", now)).toThrow();
    expect(() => cplDeliveryInstant("2026-09-23T10:00", now)).toThrow();
    expect(() => cplDeliveryInstant("2026-02-31T10:00:00Z", now)).toThrow();
    expect(() =>
      normalizeCplManualDelivery(
        {
          sentAt: "2026-09-23T10:00:00Z",
          channel: "Email recorded manually",
          recipient: "",
          reference: "",
          note: "",
        },
        now,
      ),
    ).toThrow();
  });
  it("exports only allowlisted customer content and never infers sending from download", () => {
    const p = pkg();
    Object.assign(p, { internalNotes: "PRIVATE", paths: ["D:/PRIVATE"] });
    Object.assign(p.versions[0]!.attachments[0]!, {
      objectId: "PRIVATE_OBJECT",
      path: "PRIVATE_PATH",
    });
    Object.assign(p.versions[0]!.input, { internalNotes: "PRIVATE_SOURCE" });
    const manifest = cplDeliveryPublicManifest(p, 1),
      output = JSON.stringify(manifest);
    expect(output).not.toContain("PRIVATE");
    expect(output).not.toContain("preparedByIdentityId");
    expect(manifest.disclosure).toMatch(/not sending/u);
    expect(cplDeliveryMessageText(p, 1)).toContain("RPT-FICTIONAL v4");
    expect(() => cplDeliveryPublicManifest(p, 2)).toThrow();
  });
  it("billing projection labels frozen agreed amounts and unknown invoice/payment facts", () => {
    const readiness = {
      status: "not_configured",
      policy: null,
      agreedAmount: {
        label: "Agreed amount",
        amountMinor: 12345,
        currency: "USD",
        proposalReference: "PROP-1",
        proposalVersion: 2,
        internalNotes: "PRIVATE",
      },
      facts: { purchaseOrder: "PO-1", internalNotes: "PRIVATE" },
      checks: [],
      evaluatedAt: "2026-09-23T00:00:00Z",
    } as unknown as CplCloseoutReadiness;
    const output = cplBillingHandoff(
      {
        id: randomUUID(),
        reference: "PRJ-1",
        name: "Fictional",
        customerName: "Customer",
        serviceKey: "Inspection",
        contactName: "",
        contactEmail: null,
      },
      readiness,
    );
    expect(output.agreedAmount.amountMinor).toBe(12345);
    expect(output.invoiceIssued).toBe("not_tracked");
    expect(output.paymentReceived).toBe("not_tracked");
    expect(JSON.stringify(output)).not.toContain("PRIVATE");
  });
});
