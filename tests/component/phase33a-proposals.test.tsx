import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PROPOSAL_EMAIL_DRY_RUN_DISCLOSURE,
  SYNTHETIC_ENVELOPE_CATALOG,
  type Proposal,
  type ProposalLineDraft,
} from "../../packages/domain/src/index.js";
import { CreateProposalButton } from "../../apps/web/components/create-proposal-button";
import { ProposalBuilderForm } from "../../apps/web/components/proposal-builder-form";
import { ProposalCommandActions } from "../../apps/web/components/proposal-command-actions";

const refresh = vi.fn();
const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push, replace: vi.fn() }),
}));

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const proposal: Proposal = {
  id: "f1000000-0000-4000-8000-000000000001",
  reference: "BEA-PP-000001",
  leadId: "a1000000-0000-4000-8000-000000000003",
  status: "ready_for_review",
  currentVersionNumber: 0,
  assignedPreparerUserId: "sales",
  assignedReviewerUserId: "owner",
  catalogVersionId: "e1100000-0000-4000-8000-000000000001",
  commercialPolicyVersionId: null,
  opportunityName: "Synthetic Harbor envelope advisory",
  currency: "USD",
  subtotalMinor: 11100,
  totalMinor: 11100,
  synthetic: true,
  correlationId: "test",
  causationId: null,
  createdByUserId: "sales",
  submittedAt: null,
  reviewedAt: null,
  approvedAt: null,
  cancelledAt: null,
  scopeText: "Synthetic lab scope.",
  deliverables: ["Synthetic advisory summary"],
  assumptions: ["Access is available."],
  exclusions: ["Destructive testing"],
  scheduleText: null,
  leadSnapshot: null,
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
  version: 2,
};

const line: ProposalLineDraft = {
  lineKey: "syn-env-fixed-advisory",
  serviceKey: "syn-env-fixed-advisory",
  serviceCode: "SYN-ENV-001",
  displayName: "Synthetic envelope advisory visit",
  pricingModel: "fixed_fee",
  unitOfMeasure: "visit",
  currency: "USD",
  catalogUnitAmountMinor: 11100,
  unitAmountMinor: 11100,
  quantityScaled: 10_000,
  lineSubtotalMinor: 11100,
  calculationMethod: "fixed_fee",
  scopeText: "scope",
  deliverables: [],
  assumptions: [],
  exclusions: [],
  overrideId: null,
  displayOrder: 10,
};

describe("Phase 3.3A proposal workspace components", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/proposals" && init?.method === "POST") {
          return jsonResponse({ record: { proposal: { id: proposal.id } } });
        }
        return jsonResponse({ record: { proposal } });
      }),
    );
  });

  it("creates a proposal from a ready lead", async () => {
    render(
      <CreateProposalButton
        leadId={proposal.leadId}
        catalogs={[
          {
            id: "e1100000-0000-4000-8000-000000000001",
            catalogKey: "synthetic-envelope-advisory",
            versionNumber: 1,
            status: "active",
            synthetic: true,
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByTestId("create-proposal"));
    expect(await screen.findByTestId("create-proposal")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalled();
  });

  it("renders the proposal builder service checkboxes", () => {
    render(
      <ProposalBuilderForm
        proposal={proposal}
        lines={[line]}
        items={SYNTHETIC_ENVELOPE_CATALOG.items}
        canEdit
      />,
    );
    expect(screen.getByTestId("proposal-builder")).toBeInTheDocument();
    expect(screen.getByTestId("proposal-service-syn-env-fixed-advisory")).toBeChecked();
    expect(screen.getByTestId("proposal-save-draft")).toBeInTheDocument();
    expect(screen.getByTestId("proposal-scope")).toBeInTheDocument();
  });

  it("toggles a service checkbox without reading a pooled event target", () => {
    render(
      <ProposalBuilderForm
        proposal={proposal}
        lines={[line]}
        items={SYNTHETIC_ENVELOPE_CATALOG.items}
        canEdit
      />,
    );
    const advisory = screen.getByTestId("proposal-service-syn-env-fixed-advisory");
    const hourly = screen.getByTestId("proposal-service-syn-env-hourly-coordination");
    expect(advisory).toBeChecked();
    expect(hourly).not.toBeChecked();
    fireEvent.click(hourly);
    fireEvent.click(advisory);
    expect(hourly).toBeChecked();
    expect(advisory).not.toBeChecked();
    expect(screen.getByTestId("proposal-builder")).toBeInTheDocument();
  });

  it("hides approval controls from Sales", () => {
    render(
      <ProposalCommandActions
        proposal={{ ...proposal, status: "in_review" }}
        currentVersion={
          {
            id: "v1",
            proposalId: proposal.id,
            versionNumber: 1,
            status: "frozen_review",
          } as never
        }
        overrides={[]}
        canEdit
        canSubmit={false}
        canApprove={false}
        canOverride={false}
        canDecideOverride={false}
        canDelivery={false}
        canCancel={false}
      />,
    );
    expect(screen.queryByTestId("proposal-approve")).toBeNull();
  });

  it("hides the Approve override control from Sales", () => {
    render(
      <ProposalCommandActions
        proposal={proposal}
        currentVersion={null}
        overrides={[{ id: "override-1", status: "requested" } as never]}
        canEdit
        canSubmit
        canApprove={false}
        canOverride
        canDecideOverride={false}
        canDelivery={false}
        canCancel={false}
      />,
    );
    expect(screen.queryByTestId("proposal-approve-override-override-1")).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve override" })).toBeNull();
  });

  it("shows the Approve override control to Owner when an override is pending", () => {
    render(
      <ProposalCommandActions
        proposal={proposal}
        currentVersion={null}
        overrides={[{ id: "override-1", status: "requested" } as never]}
        canEdit={false}
        canSubmit={false}
        canApprove
        canOverride={false}
        canDecideOverride
        canDelivery={false}
        canCancel={false}
      />,
    );
    expect(screen.getByTestId("proposal-approve-override-override-1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve override" })).toBeInTheDocument();
  });

  it("shows the no-send delivery action for Owner", () => {
    render(
      <ProposalCommandActions
        proposal={{ ...proposal, status: "approved" }}
        currentVersion={
          {
            id: "v1",
            proposalId: proposal.id,
            versionNumber: 1,
            status: "approved",
          } as never
        }
        overrides={[]}
        canEdit={false}
        canSubmit={false}
        canApprove
        canOverride={false}
        canDecideOverride={false}
        canDelivery
        canCancel={false}
      />,
    );
    expect(screen.getByTestId("delivery-manifest")).toBeInTheDocument();
    expect(PROPOSAL_EMAIL_DRY_RUN_DISCLOSURE).toMatch(/NO MESSAGE SENT/u);
  });
});
