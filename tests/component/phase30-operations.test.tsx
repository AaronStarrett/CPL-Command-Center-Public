import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InspectionSubmitActions } from "../../apps/web/components/inspection-submit-actions";
import { ReportReviewActions } from "../../apps/web/components/report-review-actions";

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Phase 3.0 operations actions", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("submits the labeled complete synthetic package", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ duplicate: false }, 201));
    render(
      <InspectionSubmitActions
        inspectionId="b2000000-0000-4000-8000-000000000001"
        canSubmit
        canCorrect
        needsCorrection={false}
      />,
    );
    fireEvent.click(screen.getByTestId("inspection-submit-complete"));
    await screen.findByText(/Complete synthetic package submitted/i);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/operations/inspections/"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("approves a report in review", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ report: { status: "delivered" } }));
    render(
      <ReportReviewActions
        report={{
          id: "report-1",
          reference: "BEA-RP-000001",
          inspectionId: "insp-1",
          projectId: "proj-1",
          templateId: "tmpl-1",
          currentTemplateVersionId: "tmplv-1",
          status: "in_review",
          currentVersionNumber: 1,
          createdByUserId: null,
          createdAt: "2026-08-31T00:00:00.000Z",
          updatedAt: "2026-08-31T00:00:00.000Z",
          version: 3,
        }}
        canReview
        canApprove
        canDeliver
      />,
    );
    expect(screen.getByTestId("report-approve")).toHaveTextContent("Approve technical content");
    fireEvent.click(screen.getByTestId("report-approve"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      action: "technical-approve",
      decision: "approve",
      expectedVersion: 3,
    });
  });

  it("authorizes client delivery without using an Approve label", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ report: { status: "delivering" } }));
    render(
      <ReportReviewActions
        report={{
          id: "report-1",
          reference: "BEA-RP-000001",
          inspectionId: "insp-1",
          projectId: "proj-1",
          templateId: "tmpl-1",
          currentTemplateVersionId: "tmplv-1",
          status: "ready_for_delivery",
          currentVersionNumber: 1,
          createdByUserId: null,
          createdAt: "2026-08-31T00:00:00.000Z",
          updatedAt: "2026-08-31T00:00:00.000Z",
          version: 4,
        }}
        canReview
        canApprove
        canDeliver
      />,
    );
    expect(screen.getByTestId("report-authorize-delivery")).toHaveTextContent(
      "Authorize client delivery",
    );
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    fireEvent.click(screen.getByTestId("report-authorize-delivery"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      action: "authorize-delivery",
    });
  });
});
