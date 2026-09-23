import type { CplApprovedProposalPdf } from "../../packages/domain/src/cpl-commercial";

/** Entirely synthetic public/customer data; never an owner/customer export. */
export function cplProposalPdfFixture(): CplApprovedProposalPdf {
  return {
    proposalId: "00000000-0000-4000-8000-000000000001",
    reference: "PROP-2026-0042",
    version: 3,
    approvedAt: "2026-09-23T14:30:00.000Z",
    company: {
      businessName: "Alder Field Services",
      email: "hello@example.invalid",
      phone: "+1 555 010 0240",
      address: "240 Example Avenue\nExample City, NY 10000",
      logoDataUrl: null,
      accentColor: "#245A68",
    },
    customer: {
      name: "Harbor Workshop - Synthetic Customer",
      contactName: "Jordan Example",
      contactEmail: "jordan@example.invalid",
      contactPhone: "+1 555 010 0310",
    },
    site: { name: "Workshop Annex", address: "18 Sample Lane\nExample City, NY 10000" },
    content: {
      title: "Workshop inspection and service plan",
      summary:
        "A practical service package for the workshop annex, prepared from the agreed customer requirements.",
      scope:
        "Inspect the listed workshop areas, document existing conditions, and complete the agreed service work. Confirm any additional work with the customer before proceeding.",
      deliverables: "A written findings summary, completion checklist, and customer walkthrough.",
      schedule: "Work is planned over two visits, coordinated with the customer’s operating hours.",
      assumptions: "The described work areas will be available during the agreed visits.",
      exclusions:
        "Additional repairs, hazardous-material remediation, and changes outside the listed scope are excluded.",
      terms:
        "This proposal covers only the services listed. Scope changes require written agreement.",
      paymentTerms:
        "A 25% deposit is due upon acceptance. The remaining balance is due within 14 days of completion.",
      customerNotes:
        "Thank you for the opportunity. Please retain this approved version for your records.",
      currency: "USD",
      lineItems: [
        {
          description: "Site inspection and documented recommendations",
          serviceCode: "INSPECT",
          quantity: "2.5",
          unit: "hour",
          unitPriceMinor: 12500,
        },
        {
          description: "Scheduled service visit and completion checklist",
          serviceCode: "SERVICE",
          quantity: "1",
          unit: "visit",
          unitPriceMinor: 85000,
        },
      ],
      discountMinor: 6250,
      taxBasisPoints: 825,
      startDate: "2026-10-05",
      endDate: "2026-10-09",
      sections: [
        {
          id: "communication",
          title: "Communication and confirmation",
          body: "A named coordinator will confirm visit dates and share the completion summary.",
        },
      ],
    },
    totals: {
      currency: "USD",
      lineTotalsMinor: [31250, 85000],
      subtotalMinor: 116250,
      discountMinor: 6250,
      taxableMinor: 110000,
      taxMinor: 9075,
      totalMinor: 119075,
    },
  };
}
