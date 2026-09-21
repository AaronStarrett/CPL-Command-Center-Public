import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LeadCreateForm } from "../../apps/web/components/lead-create-form";
import { LeadEditForm } from "../../apps/web/components/lead-edit-form";
import { LeadReviewActions } from "../../apps/web/components/lead-review-actions";
import { WorkspaceRenderer } from "../../apps/web/components/workspace-renderer";
import type { AiCommandArtifactView } from "../../apps/web/lib/ai-command-contracts";
import { parseLeadParties } from "../../apps/web/lib/lead-api";
import { evaluateLeadReadiness } from "../../packages/domain/src/index.js";

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("lead create form validation", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("marks required intake fields and surfaces a server validation error", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: { message: "Lead fields are invalid or exceed their allowed length." } },
        400,
      ),
    );
    render(<LeadCreateForm companies={[]} reviewers={[]} />);
    expect(screen.getByLabelText(/intake source/i)).toBeRequired();
    expect(screen.getByLabelText(/opportunity or project name/i)).toBeRequired();
    expect(screen.getByLabelText(/request summary/i)).toBeRequired();
    fireEvent.change(screen.getByLabelText(/opportunity or project name/i), {
      target: { value: "Synthetic walk-up inquiry" },
    });
    fireEvent.change(screen.getByLabelText(/request summary/i), {
      target: { value: "Caller asked about a demonstration facade." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create lead" }));
    expect(
      await screen.findByText("Lead fields are invalid or exceed their allowed length."),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/leads",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("exposes canonical contact linking only when contacts.view is granted", () => {
    const { rerender } = render(
      <LeadCreateForm
        companies={[
          { id: "90000000-0000-4000-8000-000000000001", label: "Northstar Facade Group" },
        ]}
        contacts={[
          {
            id: "91000000-0000-4000-8000-000000000001",
            label: "Morgan Demo",
            companyId: "90000000-0000-4000-8000-000000000001",
          },
        ]}
        canViewContacts
        reviewers={[]}
      />,
    );
    expect(screen.getAllByLabelText(/linked contact/i).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("option", { name: "Morgan Demo" }).length).toBeGreaterThan(0);
    rerender(
      <LeadCreateForm
        companies={[
          { id: "90000000-0000-4000-8000-000000000001", label: "Northstar Facade Group" },
        ]}
        contacts={[
          {
            id: "91000000-0000-4000-8000-000000000001",
            label: "Morgan Demo",
            companyId: "90000000-0000-4000-8000-000000000001",
          },
        ]}
        canViewContacts={false}
        reviewers={[]}
      />,
    );
    expect(screen.queryByLabelText(/linked contact/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Morgan Demo" })).not.toBeInTheDocument();
  });
});

describe("lead edit form intake fields", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const lead = {
    id: "a1000000-0000-4000-8000-000000000009",
    reference: "BEA-LD-000009",
    sourceType: "manual" as const,
    sourceDetails: null,
    receivedAt: "2026-08-20T14:30:00.000Z",
    opportunityName: "Synthetic editable intake",
    requestSummary: "Edit every intake field.",
    requestedService: "Envelope investigation",
    siteName: "Example campus",
    siteAddressLine1: "10 Example Invalid Street",
    siteAddressLine2: null,
    siteCity: "Example City",
    siteRegion: "EX",
    sitePostalCode: "00000",
    siteCountry: "US",
    desiredDeadlineAt: null,
    requestedVisitAt: null,
    reviewerUserId: null,
    status: "new" as const,
    disqualificationReason: null,
    createdByUserId: "10000000-0000-4000-8000-000000000002",
    createdAt: "2026-08-20T14:30:00.000Z",
    updatedAt: "2026-08-20T14:30:00.000Z",
    version: 1,
  };

  it("shows editable address, email, phone, and contact controls and surfaces a ready-status conflict", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: {
            message:
              "The lead must first be moved to needs_info by an authorized reviewer before intake changes that introduce blocking gaps can be saved.",
          },
        },
        409,
      ),
    );
    render(
      <LeadEditForm
        lead={lead}
        parties={[]}
        companies={[
          { id: "90000000-0000-4000-8000-000000000001", label: "Northstar Facade Group" },
        ]}
        contacts={[
          {
            id: "91000000-0000-4000-8000-000000000001",
            label: "Morgan Demo",
            companyId: "90000000-0000-4000-8000-000000000001",
          },
        ]}
        canViewContacts
        reviewers={[]}
      />,
    );
    expect(screen.getByLabelText(/address line 1/i)).toBeVisible();
    expect(screen.getByLabelText(/address line 2/i)).toBeVisible();
    expect(screen.getByLabelText(/postal code/i)).toBeVisible();
    expect(screen.getByLabelText(/^country/i)).toBeVisible();
    expect(screen.getAllByLabelText(/^email$/i).length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText(/^phone$/i).length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText(/linked contact/i).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Save intake" }));
    expect(
      await screen.findByText(/moved to needs_info by an authorized reviewer/u),
    ).toBeInTheDocument();
  });
});

describe("lead party API parsing", () => {
  it("accepts create and edit party payloads that omit optional notes", () => {
    const parties = parseLeadParties([
      {
        role: "requester",
        companyId: null,
        contactId: null,
        unmatchedCompanyName: "Harborview",
        unmatchedContactName: "Alex Referral",
        unmatchedEmail: "alex.referral@example.invalid",
        unmatchedPhone: "+1-555-0140",
      },
    ]);
    expect(parties).toEqual([
      {
        role: "requester",
        companyId: null,
        contactId: null,
        unmatchedCompanyName: "Harborview",
        unmatchedContactName: "Alex Referral",
        unmatchedEmail: "alex.referral@example.invalid",
        unmatchedPhone: "+1-555-0140",
        notes: null,
      },
    ]);
  });
});

describe("lead review actions", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("requires a disqualification reason and keeps ready-for-proposal blocked until rules pass", () => {
    const lead = {
      id: "a1000000-0000-4000-8000-000000000001",
      reference: "BEA-LD-000001",
      sourceType: "manual" as const,
      sourceDetails: null,
      receivedAt: "2026-08-20T14:30:00.000Z",
      opportunityName: "Synthetic Harborview envelope inquiry",
      requestSummary: "Incomplete synthetic inquiry.",
      requestedService: null,
      siteName: null,
      siteAddressLine1: null,
      siteAddressLine2: null,
      siteCity: null,
      siteRegion: null,
      sitePostalCode: null,
      siteCountry: "US",
      desiredDeadlineAt: null,
      requestedVisitAt: null,
      reviewerUserId: null,
      status: "new" as const,
      disqualificationReason: null,
      createdByUserId: "10000000-0000-4000-8000-000000000002",
      createdAt: "2026-08-20T14:30:00.000Z",
      updatedAt: "2026-08-20T14:30:00.000Z",
      version: 1,
    };
    const readiness = evaluateLeadReadiness({
      sourceType: lead.sourceType,
      sourceDetails: lead.sourceDetails,
      receivedAt: lead.receivedAt,
      opportunityName: lead.opportunityName,
      requestSummary: lead.requestSummary,
      requestedService: lead.requestedService,
      siteName: lead.siteName,
      siteCity: lead.siteCity,
      siteRegion: lead.siteRegion,
      desiredDeadlineAt: lead.desiredDeadlineAt,
      requestedVisitAt: lead.requestedVisitAt,
      reviewerUserId: lead.reviewerUserId,
      parties: [],
    });
    render(
      <LeadReviewActions lead={lead} readiness={readiness} canReview canDisqualify canManage />,
    );
    expect(screen.getByRole("button", { name: "Mark ready for proposal" })).toBeDisabled();
    expect(screen.getByText(/Blocking intake information is still missing/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Disqualify" }));
    expect(screen.getByText("Disqualification requires a recorded reason.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("AI Command lead workspace rendering", () => {
  it("renders an authorized lead list and detail in the dynamic workspace", () => {
    const list: AiCommandArtifactView = {
      id: "artifact-lead-list",
      type: "lead-list",
      title: "Lead review queue",
      subtitle:
        "Lead records in the current environment · website, Outlook, and telephone connectors are not connected",
      state: "ready",
      payload: {
        items: [
          {
            id: "a1000000-0000-4000-8000-000000000003",
            title: "Synthetic Northstar curtain-wall review",
            href: "/leads/a1000000-0000-4000-8000-000000000003",
            status: "ready_for_proposal",
          },
        ],
      },
      sources: [],
      links: [],
      requiredPermissions: ["leads.view"],
      createdAt: "2026-08-28T00:00:00.000Z",
      errorCode: null,
    };
    const { rerender } = render(
      <WorkspaceRenderer artifact={list} canExecuteTaskAction={false} onConfirmAction={vi.fn()} />,
    );
    expect(screen.getByRole("heading", { name: "Lead review queue" })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Synthetic Northstar curtain-wall review" }),
    ).toHaveAttribute("href", "/leads/a1000000-0000-4000-8000-000000000003");
    rerender(
      <WorkspaceRenderer
        artifact={{
          ...list,
          id: "artifact-lead-detail",
          type: "lead-detail",
          title: "Synthetic Northstar curtain-wall review",
          payload: {
            record: {
              status: "ready_for_proposal",
              sourceType: "in_person",
              requestedService: "Curtain-wall investigation",
              readyForProposal: true,
            },
          },
        }}
        canExecuteTaskAction={false}
        onConfirmAction={vi.fn()}
      />,
    );
    expect(screen.getByText("ready_for_proposal")).toBeInTheDocument();
    expect(screen.getByText("Curtain-wall investigation")).toBeInTheDocument();
  });
});
