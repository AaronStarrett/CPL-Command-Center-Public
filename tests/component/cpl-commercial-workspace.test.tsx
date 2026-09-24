import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  calculateCplCommercialTotals,
  defaultCplCommercialBranding,
  type CplCommercialContent,
  type CplCommercialProposal,
  type CplCommercialProject,
  type CplCommercialTemplate,
} from "@bea/domain/cpl-commercial";
import type { CplWorkflowLead } from "@bea/database/hosted";
import { CommercialWorkspace } from "../../apps/web/app/workspace/commercial-workspace";
import type {
  CommercialWorkspaceData,
  ProposalIntent,
} from "../../apps/web/app/workspace/commercial-ui";
import type { WorkspaceRecordIntent } from "../../apps/web/app/workspace/phase4-ui";

const org = "10000000-0000-4000-8000-000000000021";
const leadId = "20000000-0000-4000-8000-000000000021";
const proposalId = "30000000-0000-4000-8000-000000000021";
const now = "2026-09-23T12:00:00.000Z";
const base = "/api/cpl-commercial";
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function lead(): CplWorkflowLead {
  return {
    id: leadId,
    organizationId: org,
    title: "Fictional clinic inquiry",
    contactName: "Example contact",
    contactEmail: "contact@example.invalid",
    details: "Confirmed inspection scope",
    sourceType: "email",
    customerId: null,
    customerName: "Fictional customer",
    contactId: null,
    contactPhone: "",
    siteId: null,
    siteName: "Example site",
    siteAddress: "Fictional address",
    requestedService: "Inspection",
    receivedAt: now,
    requestedDeadlineAt: null,
    requestedVisitAt: null,
    assignedMemberIdentityId: "owner",
    nextAction: "Prepare scope",
    notes: "Private lead notes",
    status: "ready_for_proposal",
    disqualificationReason: null,
    version: 3,
    createdAt: now,
    updatedAt: now,
    readiness: { readyForProposal: true, missingInformation: [], conflicts: [] },
    duplicateCandidates: [],
    duplicateReview: {
      disposition: "unreviewed",
      reason: null,
      relatedLeadId: null,
      reviewedAt: null,
    },
    evidence: [
      {
        id: "source",
        kind: "initial_capture",
        label: "Original email",
        reference: "internal-source-reference",
        note: "Original source wording",
        actorIdentityId: "owner",
        createdAt: now,
      },
    ],
  };
}
function content(): CplCommercialContent {
  return {
    title: "Fictional inspection proposal",
    summary: "A focused inspection",
    scope: "Confirmed inspection scope",
    schedule: "Within two weeks",
    deliverables: "Written findings",
    assumptions: "Access is arranged",
    exclusions: "Repair work",
    terms: "Fictional terms",
    paymentTerms: "Due on completion",
    customerNotes: "Customer-visible note",
    currency: "USD",
    sections: [{ id: "additional", title: "Quality", body: "Human review" }],
    lineItems: [
      {
        serviceCode: "INSPECT",
        description: "Inspection visit",
        quantity: "1",
        unit: "visit",
        unitPriceMinor: 10000,
      },
    ],
    discountMinor: 0,
    taxBasisPoints: 0,
    startDate: null,
    endDate: null,
    accessInstructions: "PRIVATE ACCESS CODE",
    constraints: "PRIVATE STAFFING NOTE",
  };
}
function template(): CplCommercialTemplate {
  return {
    currency: "USD",
    id: "template-1",
    organizationId: org,
    name: "Fictional service template",
    summary: "",
    scope: "",
    schedule: "",
    deliverables: "",
    assumptions: "",
    exclusions: "",
    terms: "",
    paymentTerms: "",
    sections: [],
    catalog: [
      { serviceCode: "TEST", description: "Test service", unit: "each", unitPriceMinor: 5000 },
    ],
    createdAt: now,
  };
}
function proposal(): CplCommercialProposal {
  const value = content();
  return {
    id: proposalId,
    organizationId: org,
    reference: "Q-2026-EXAMPLE",
    leadId,
    legacyDraftId: null,
    title: value.title,
    state: "draft",
    revision: 1,
    currentVersion: 1,
    approvedVersion: null,
    createdAt: now,
    updatedAt: now,
    internalNotes: "PRIVATE INTERNAL NOTES",
    versions: [
      {
        version: 1,
        content: value,
        totals: calculateCplCommercialTotals(value),
        sourceLead: {
          id: leadId,
          version: 3,
          fields: lead(),
          evidence: lead().evidence,
          capturedAt: now,
        },
        branding: {
          ...defaultCplCommercialBranding(),
          businessName: "Fictional Services",
          discountEnabled: true,
          taxEnabled: true,
        },
        templateId: "template-1",
        templateSnapshot: template(),
        createdAt: now,
        createdByIdentityId: "owner",
      },
    ],
    events: [],
    artifacts: [],
    award: null,
    project: null,
    outcome: null,
  };
}

describe("structured commercial workspace", () => {
  let record: CplCommercialProposal;
  let data: CommercialWorkspaceData;
  const request = vi.fn<(path: string, body?: unknown) => Promise<unknown>>();
  const dirty = vi.fn();
  const onLegacy = vi.fn();
  const onOpenLead = vi.fn();
  function project(): CplCommercialProject {
    return {
      id: "project-1",
      organizationId: org,
      reference: "PRJ-2026-EXAMPLE",
      awardId: record.award!.id,
      proposalId,
      proposalVersion: record.approvedVersion!,
      leadId,
      snapshot: {
        proposalReference: record.reference,
        version: record.versions[0]!,
        award: record.award!,
        internalNotes: record.internalNotes,
      },
      createdByIdentityId: "owner",
      createdAt: now,
    };
  }
  async function normal(path: string, input?: unknown) {
    const body = input as Record<string, unknown> | undefined;
    if (path === `${base}/workspace`) return copy(data);
    if (path === "/api/cpl-execution/projects/project-1")
      return {
        project: project(),
        operations: {
          projectId: "project-1",
          revision: 0,
          name: record.title,
          status: "active",
          ownerIdentityId: null,
          teamIdentityIds: [],
          nextAction: "",
          operationalInstructions: "",
          internalNotes: "",
          timeZone: "America/Indiana/Indianapolis",
          statusReason: "",
          updatedAt: null,
          updatedByIdentityId: null,
        },
        members: [],
        visits: [],
        events: [],
        permissions: { canPlan: true, canCompleteAssignedVisits: false },
        currentIdentityId: "owner",
      };
    if (path === `${base}/proposals/${proposalId}`) return copy(record);
    if (path === `${base}/proposals`) {
      data.proposals = [record];
      return copy(record);
    }
    if (path.endsWith("/save")) {
      const next = body!.content as CplCommercialContent;
      record = {
        ...record,
        title: next.title,
        internalNotes: String(body!.internalNotes),
        revision: record.revision + 1,
        currentVersion: record.currentVersion + 1,
        versions: [
          ...record.versions,
          {
            ...record.versions[0]!,
            version: record.currentVersion + 1,
            content: next,
            totals: calculateCplCommercialTotals(next),
          },
        ],
      };
      data.proposals = [record];
      return copy(record);
    }
    if (path.endsWith("/submit")) {
      record.state = "review";
      record.revision++;
      return copy(record);
    }
    if (path.endsWith("/review")) {
      record.state = body!.decision === "approve" ? "approved" : "revision_requested";
      record.approvedVersion = body!.decision === "approve" ? record.currentVersion : null;
      record.revision++;
      return copy(record);
    }
    if (path.includes("/customer-preview")) {
      const value = record.versions[0]!;
      const publicContent = Object.fromEntries(
        Object.entries(value.content).filter(
          ([key]) => !["accessInstructions", "constraints"].includes(key),
        ),
      );
      return {
        approved: record.approvedVersion !== null,
        state: record.state,
        document: {
          proposalId,
          reference: record.reference,
          version: value.version,
          approvedAt: now,
          company: value.branding,
          customer: {
            name: "Fictional customer",
            contactName: "Example contact",
            contactEmail: null,
            contactPhone: "",
          },
          site: { name: "Example site", address: "" },
          content: publicContent,
          totals: value.totals,
        },
      };
    }
    if (path.endsWith("/pdf"))
      return {
        id: "artifact-1",
        proposalId,
        version: body!.version,
        projectionSha256: "b".repeat(64),
        sha256: "a".repeat(64),
        byteLength: 1200,
        rendererVersion: "test-renderer",
        createdAt: now,
      };
    if (path.endsWith("/project-preview")) return copy(project().snapshot);
    if (path.endsWith("/project") || path === `${base}/projects/project-1`) {
      const result = project();
      data.projects = [result];
      return copy(result);
    }
    if (path === `${base}/templates`)
      return copy({
        ...(body!.input as object),
        id: "template-new",
        organizationId: org,
        createdAt: now,
      });
    if (path === `${base}/branding`) {
      data.branding = {
        ...(body!.input as typeof data.branding),
        revision: data.branding.revision + 1,
      };
      return copy(data.branding);
    }
    if (path.endsWith("/outcome")) return copy(record);
    throw new Error(`Unexpected fixture request ${path}`);
  }
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    record = proposal();
    data = {
      proposals: [record],
      templates: [template()],
      branding: record.versions[0]!.branding,
      projects: [],
      permissions: {
        canEdit: true,
        canReview: true,
        canAward: true,
        canCreateProject: true,
        canConfigure: true,
      },
    };
    request.mockReset().mockImplementation(normal);
    dirty.mockReset();
    onLegacy.mockReset();
    onOpenLead.mockReset();
  });
  afterEach(() => {
    expect(console.error).not.toHaveBeenCalled();
    expect(window.confirm).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
  async function open(intent?: ProposalIntent, recordIntent?: WorkspaceRecordIntent) {
    render(
      <CommercialWorkspace
        organizationId={org}
        leads={[lead()]}
        legacyDrafts={[]}
        intent={intent}
        recordIntent={recordIntent}
        request={request as <T>(path: string, body?: unknown) => Promise<T>}
        onDirty={dirty}
        onBusy={vi.fn()}
        onLegacy={onLegacy}
        onOpenLead={onOpenLead}
      />,
    );
    await screen.findByRole("heading", { name: "Proposals & projects" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh saved state" })).toBeEnabled(),
    );
  }
  async function select() {
    await open();
    fireEvent.click(screen.getByRole("button", { name: /Fictional inspection proposal/ }));
    await screen.findByLabelText("Proposal title");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh saved state" })).toBeEnabled(),
    );
  }
  function calls(suffix: string) {
    return request.mock.calls.filter(([path]) => path.endsWith(suffix));
  }
  it("opens a linked existing proposal without creating an additional draft", async () => {
    await open(undefined, {
      kind: "proposal",
      id: proposalId,
      projectId: null,
      version: 1,
      nonce: 1,
    });
    expect(await screen.findByLabelText("Proposal title")).toHaveValue(record.title);
    expect(request).toHaveBeenCalledWith(`${base}/proposals/${proposalId}`);
    expect(request.mock.calls.filter(([, body]) => body !== undefined)).toHaveLength(0);
  });
  it("rejects a linked proposal response from another company", async () => {
    record.organizationId = "different-company";
    await open(undefined, {
      kind: "proposal",
      id: proposalId,
      projectId: null,
      version: 1,
      nonce: 1,
    });
    expect(screen.getByRole("alert")).toHaveTextContent("did not match this company");
    expect(screen.queryByLabelText("Proposal title")).not.toBeInTheDocument();
  });

  it("requires explicit creation and intentional additional proposal confirmation with source evidence", async () => {
    await open({ leadId });
    expect(screen.getByText("Original source wording")).toBeVisible();
    expect(calls("/proposals")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Create proposal", exact: true })).toBeDisabled();
    fireEvent.click(
      screen.getByLabelText("Intentionally create an additional proposal for this lead"),
    );
    fireEvent.change(screen.getByLabelText("Proposal template"), {
      target: { value: "template-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create proposal", exact: true }));
    await screen.findByLabelText("Proposal title");
    expect(calls("/proposals")[0]![1]).toEqual({
      leadId,
      templateId: "template-1",
      allowAdditional: true,
      idempotencyKey: expect.any(String),
    });
  });
  it("displays captured catalog and typed intake answers without substituting current company settings", async () => {
    const id = "123e4567-e89b-12d3-a456-426614174999";
    record.versions[0]!.sourceLead.configuration = {
      catalog: {
        id,
        revision: 2,
        code: "INSPECT",
        name: "Saved inspection",
        description: "Saved service",
        unit: "visit",
        unitPriceMinor: 10000,
        currency: "CAD",
        workflowKey: "fixed-key",
      },
      policyVersion: 3,
      reviewedPolicyVersion: 3,
      policy: {
        requiredFields: [],
        customFields: [
          {
            id,
            label: "Access confirmed at capture",
            type: "boolean",
            required: true,
            active: true,
            options: [],
          },
        ],
      },
      customValues: { [id]: false },
    };
    await select();
    expect(screen.getByText("Captured company intake configuration")).toBeVisible();
    expect(screen.getByText(/Service: Saved inspection.*revision 2.*CAD/)).toBeVisible();
    expect(screen.getByText("Access confirmed at capture").parentElement).toHaveTextContent("No");
  });

  it("keeps the idempotency key on an ambiguous creation retry", async () => {
    data.proposals = [];
    let failed = false;
    request.mockImplementation(async (path, body) => {
      if (path === `${base}/proposals` && !failed) {
        failed = true;
        throw new Error("Network interrupted");
      }
      return normal(path, body);
    });
    await open({ leadId });
    fireEvent.click(screen.getByRole("button", { name: "Create proposal", exact: true }));
    await screen.findByText("Network interrupted");
    fireEvent.click(screen.getByRole("button", { name: "Create proposal", exact: true }));
    await screen.findByLabelText("Proposal title");
    expect(calls("/proposals")[0]![1]).toEqual(calls("/proposals")[1]![1]);
  });

  it("uses domain rounding for live totals and saves exact quantity, prices and revision", async () => {
    await select();
    expect(screen.queryByLabelText("Review / revision note")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Item 1 quantity"), { target: { value: "1.125" } });
    fireEvent.change(screen.getByLabelText("Item 1 unit price"), { target: { value: "10.05" } });
    fireEvent.change(screen.getByLabelText("Discount amount"), { target: { value: "1.00" } });
    fireEvent.change(screen.getByLabelText("Tax percent"), { target: { value: "7.25" } });
    expect(within(screen.getByLabelText("Proposal totals")).getByText("$11.06")).toBeVisible();
    expect(screen.getByRole("button", { name: "Submit for review" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save proposal" }));
    await screen.findByText(/Proposal version saved/);
    expect(calls("/save")[0]![1]).toMatchObject({
      expectedRevision: 1,
      internalNotes: "PRIVATE INTERNAL NOTES",
      content: {
        lineItems: [{ quantity: "1.125", unitPriceMinor: 1005 }],
        discountMinor: 100,
        taxBasisPoints: 725,
      },
    });
    expect(screen.getByRole("button", { name: "Save proposal" })).toBeDisabled();
  });

  it("retains incomplete decimal input and blocks saving invalid amounts", async () => {
    await select();
    fireEvent.change(screen.getByLabelText("Item 1 unit price"), { target: { value: "12." } });
    expect(screen.getByLabelText("Item 1 unit price")).toHaveValue("12.");
    fireEvent.click(screen.getByRole("button", { name: "Save proposal" }));
    await screen.findByText(/Check quantities, amounts/);
    expect(calls("/save")).toHaveLength(0);
  });

  it("adds, reorders and removes proposal sections and pricing rows", async () => {
    await select();
    fireEvent.click(screen.getByRole("button", { name: "Add section", exact: true }));
    fireEvent.change(screen.getByLabelText("Section 2 heading"), {
      target: { value: "Acceptance" },
    });
    fireEvent.change(screen.getByLabelText("Section 2 text"), {
      target: { value: "Human acceptance" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Move section 2 up" }));
    expect(screen.getByLabelText("Section 1 heading")).toHaveValue("Acceptance");
    fireEvent.click(screen.getByRole("button", { name: "Remove section 2" }));
    fireEvent.change(screen.getByLabelText("Template service"), { target: { value: "TEST" } });
    fireEvent.click(screen.getByRole("button", { name: "Add selected service" }));
    fireEvent.click(screen.getByRole("button", { name: "Move item 2 up" }));
    expect(screen.getByLabelText("Item 1 description")).toHaveValue("Test service");
    fireEvent.click(screen.getByRole("button", { name: "Remove item 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Save proposal" }));
    await screen.findByText(/Proposal version saved/);
    expect(calls("/save")[0]![1]).toMatchObject({
      content: {
        sections: [{ title: "Acceptance", body: "Human acceptance" }],
        lineItems: [{ serviceCode: "TEST", unitPriceMinor: 5000 }],
      },
    });
  });

  it("preserves dirty values and original optimistic token on a stale saved-state refresh", async () => {
    await select();
    fireEvent.change(screen.getByLabelText("Scope of work"), {
      target: { value: "Unsaved scope" },
    });
    record.revision = 2;
    record.versions[0]!.content.scope = "Another session scope";
    fireEvent.click(screen.getByRole("button", { name: "Refresh saved state" }));
    await screen.findByText(/A newer saved revision is available/);
    expect(screen.getByLabelText("Scope of work")).toHaveValue("Unsaved scope");
    expect(screen.getByRole("button", { name: "Save proposal" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Discard edits and load latest" }));
    expect(screen.getByRole("dialog", { name: "Keep your work?" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByLabelText("Scope of work")).toHaveValue("Another session scope");
  });

  it("retains form values after a denied save and does not submit review", async () => {
    await select();
    request.mockImplementation(async (path, body) => {
      if (path.endsWith("/save")) throw new Error("Version conflict; retained");
      return normal(path, body);
    });
    fireEvent.change(screen.getByLabelText("Scope of work"), {
      target: { value: "Keep this scope" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save proposal" }));
    await screen.findByText("Version conflict; retained");
    expect(screen.getByLabelText("Scope of work")).toHaveValue("Keep this scope");
    expect(calls("/save")[0]![1]).toMatchObject({ expectedRevision: 1 });
    expect(screen.getByRole("button", { name: "Submit for review" })).toBeDisabled();
  });

  it("warns on unsaved internal navigation and browser unload", async () => {
    await select();
    fireEvent.change(screen.getByLabelText("Scope of work"), { target: { value: "Unsaved" } });
    fireEvent.click(screen.getByRole("button", { name: "Templates & services" }));
    const dialog = screen.getByRole("dialog", { name: "Keep your work?" });
    expect(screen.getByRole("button", { name: "Keep editing" })).toHaveFocus();
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Scope of work")).toHaveValue("Unsaved");
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(dirty).toHaveBeenLastCalledWith(true);
  });

  it("requires a review note for changes and passes the current saved revision", async () => {
    record.state = "review";
    await select();
    expect(screen.getByRole("button", { name: "Request revision" })).toBeDisabled();
    expect(screen.getByLabelText("Scope of work")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Review / revision note"), {
      target: { value: "Clarify deliverables" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Request revision" }));
    await screen.findByText(/Changes requested. The review note/);
    expect(calls("/review")[0]![1]).toEqual({
      expectedRevision: 1,
      decision: "request_revision",
      note: "Clarify deliverables",
    });
  });

  it("fails closed on response permissions for editing, review and company configuration", async () => {
    data.permissions = {
      canEdit: false,
      canReview: false,
      canAward: false,
      canCreateProject: false,
      canConfigure: false,
    };
    record.state = "review";
    await select();
    expect(screen.getByLabelText("Proposal title")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Approve version 1" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Artifact branding" }));
    expect(screen.getByLabelText("Document business name")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save artifact branding" })).toBeDisabled();
  });

  it("renders only the explicit server customer projection and downloads a recorded approved PDF", async () => {
    record.state = "approved";
    record.approvedVersion = 1;
    await select();
    fireEvent.click(screen.getByRole("button", { name: "Customer preview & PDF" }));
    expect(screen.queryByRole("link", { name: /Download approved PDF/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load approved customer preview" }));
    await screen.findByLabelText("Customer proposal preview");
    expect(screen.getByText("Customer-visible note")).toBeVisible();
    for (const text of [
      "PRIVATE ACCESS CODE",
      "PRIVATE STAFFING NOTE",
      "PRIVATE INTERNAL NOTES",
      "Original source wording",
      "internal-source-reference",
    ])
      expect(screen.queryByText(text)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Generate approved PDF" }));
    const link = await screen.findByRole("link", { name: "Download approved PDF v1" });
    expect(link).toHaveAttribute(
      "href",
      `${base}/proposals/${proposalId}/pdf?version=1&organization=${org}`,
    );
    expect(calls("/pdf")[0]![1]).toEqual({ version: 1 });
  });

  it("keeps draft preview clearly unapproved and offers no final PDF action", async () => {
    await select();
    fireEvent.click(screen.getByRole("button", { name: "Customer preview & PDF" }));
    expect(screen.queryByRole("button", { name: "Generate approved PDF" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load draft customer preview" }));
    await screen.findByText(/DRAFT — NOT APPROVED FOR CUSTOMER DELIVERY/);
  });

  it("requires project preview and deliberate confirmation, then retrieves the linked project", async () => {
    record.state = "awarded";
    record.approvedVersion = 1;
    record.award = {
      id: "award-1",
      proposalId,
      proposalVersion: 1,
      actorIdentityId: "owner",
      createdAt: now,
      awardDate: "2026-09-23",
      amountMinor: 10000,
      currency: "USD",
      purchaseOrder: "TEST-PO",
      startDate: "2026-10-07",
      notes: "Fictional award",
    };
    await select();
    fireEvent.click(screen.getByRole("button", { name: "Outcome & project" }));
    expect(screen.queryByRole("button", { name: "Create linked project" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview project handoff" }));
    const create = await screen.findByRole("button", { name: "Create linked project" });
    expect(create).toBeDisabled();
    expect(screen.getByText(/PRIVATE ACCESS CODE/)).toBeVisible();
    fireEvent.click(
      screen.getByLabelText("I reviewed the awarded scope and want to create its linked project."),
    );
    fireEvent.click(create);
    await screen.findByLabelText("Operational project name");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Awarded agreement" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Awarded agreement" }));
    await screen.findByLabelText("Linked project");
    expect(screen.getByText(/2026-10-07 · from the award record/)).toBeVisible();
    expect(calls("/project")[0]![1]).toEqual({ idempotencyKey: expect.any(String) });
    fireEvent.click(
      screen.getByRole("button", { name: /PRJ-2026-EXAMPLE.*Fictional inspection proposal/ }),
    );
    await waitFor(() => expect(request).toHaveBeenCalledWith(`${base}/projects/project-1`));
  });

  it("creates a new immutable template copy with edited catalog pricing", async () => {
    data.templates[0]!.currency = "EUR";
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Templates & services" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Edit a new copy of Fictional service template" }),
    );
    expect(screen.getByLabelText("Template name")).toHaveValue("Fictional service template — copy");
    expect(screen.getByLabelText(/Template price currency/)).toHaveValue("EUR");
    fireEvent.change(screen.getByLabelText("Service 1 unit price"), { target: { value: "75.25" } });
    fireEvent.click(screen.getByRole("button", { name: "Save new template" }));
    await screen.findByText(/New company template saved/);
    expect(calls("/templates")[0]![1]).toMatchObject({
      input: {
        name: "Fictional service template — copy",
        currency: "EUR",
        catalog: [{ serviceCode: "TEST", unitPriceMinor: 7525 }],
      },
      idempotencyKey: expect.any(String),
    });
    expect(data.templates[0]!.catalog[0]!.unitPriceMinor).toBe(5000);
  });
  it("requires deliberate currency confirmation for a legacy template under a changed company default", async () => {
    data.proposals = [];
    delete data.templates[0]!.currency;
    data.branding.defaultCurrency = "CAD";
    await open({ leadId });
    fireEvent.change(screen.getByLabelText("Proposal template"), {
      target: { value: "template-1" },
    });
    const create = screen.getByRole("button", { name: "Create proposal", exact: true });
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Legacy template price currency"), {
      target: { value: "USD" },
    });
    expect(create).toBeDisabled();
    fireEvent.click(
      screen.getByLabelText("I reviewed these template prices and confirm their currency."),
    );
    fireEvent.click(create);
    await screen.findByLabelText("Proposal title");
    expect(calls("/proposals")[0]![1]).toMatchObject({
      legacyTemplateCurrency: "USD",
      templateId: "template-1",
    });
  });

  it("rejects oversized and non-raster logo files before saving branding", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Artifact branding" }));
    fireEvent.change(screen.getByLabelText("Document logo"), {
      target: { files: [new File(["<svg></svg>"], "example.svg", { type: "image/svg+xml" })] },
    });
    await screen.findByText("Choose a PNG or JPEG up to 128 KB and 2048 × 2048 pixels.");
    fireEvent.change(screen.getByLabelText("Document logo"), {
      target: { files: [new File([new Uint8Array(131073)], "large.png", { type: "image/png" })] },
    });
    expect(calls("/branding")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Save artifact branding" })).toBeDisabled();
  });

  it("saves company artifact settings with an explicit optimistic revision", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Artifact branding" }));
    fireEvent.change(screen.getByLabelText("Document business name"), {
      target: { value: "Fictional Customer Services" },
    });
    fireEvent.change(screen.getByLabelText("Document accent color"), {
      target: { value: "#225577" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save artifact branding" }));
    await screen.findByText(/Company artifact branding saved/);
    expect(calls("/branding")[0]![1]).toMatchObject({
      expectedRevision: 0,
      input: { businessName: "Fictional Customer Services", accentColor: "#225577" },
    });
  });

  it("records a structured lost reason separately from the human note", async () => {
    await select();
    fireEvent.click(screen.getByRole("button", { name: "Outcome & project" }));
    fireEvent.change(screen.getByLabelText("Lost reason"), { target: { value: "timing" } });
    fireEvent.change(screen.getByLabelText("Outcome note"), {
      target: { value: "Customer moved the work to next year." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record lost" }));
    await screen.findByText(/Commercial outcome recorded/);
    expect(calls("/outcome")[0]![1]).toEqual({
      outcome: "lost",
      reasonCode: "timing",
      note: "Customer moved the work to next year.",
      expectedRevision: 1,
      idempotencyKey: expect.any(String),
    });
  });

  it("records withdrawal notes without misclassifying them as a lost reason", async () => {
    await select();
    fireEvent.click(screen.getByRole("button", { name: "Outcome & project" }));
    fireEvent.change(screen.getByLabelText("Outcome"), { target: { value: "withdrawn" } });
    fireEvent.change(screen.getByLabelText("Outcome note"), {
      target: { value: "Scope is outside our services." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record withdrawn" }));
    await screen.findByText(/Commercial outcome recorded/);
    expect(calls("/outcome")[0]![1]).toEqual({
      outcome: "withdrawn",
      note: "Scope is outside our services.",
      expectedRevision: 1,
      idempotencyKey: expect.any(String),
    });
  });

  it("loads a newer clean editor on refresh and shows immutable older versions separately", async () => {
    await select();
    const next = {
      ...record.versions[0]!,
      version: 2,
      content: { ...record.versions[0]!.content, scope: "New saved scope" },
    };
    record = { ...record, currentVersion: 2, revision: 2, versions: [...record.versions, next] };
    fireEvent.click(screen.getByRole("button", { name: "Refresh saved state" }));
    await screen.findByText(/Latest saved state loaded/);
    expect(screen.getByLabelText("Scope of work")).toHaveValue("New saved scope");
    fireEvent.click(screen.getByRole("button", { name: "Versions & review" }));
    fireEvent.change(screen.getByLabelText("View saved version"), { target: { value: "1" } });
    expect(screen.getByText("READ ONLY · VERSION 1")).toBeVisible();
    expect(screen.getByText("Confirmed inspection scope")).toBeVisible();
    expect(screen.queryByLabelText("Proposal title")).not.toBeInTheDocument();
    expect(calls("/save")).toHaveLength(0);
  });

  it("reuses a template creation key when its POST succeeded but the readback failed", async () => {
    let posted = false,
      failed = false;
    request.mockImplementation(async (path, body) => {
      if (path === `${base}/templates`) posted = true;
      if (path === `${base}/workspace` && posted && !failed) {
        failed = true;
        throw new Error("Readback interrupted");
      }
      return normal(path, body);
    });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Templates & services" }));
    fireEvent.change(screen.getByLabelText("Template name"), {
      target: { value: "Retry-safe example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save new template" }));
    await screen.findByText("Readback interrupted");
    expect(screen.getByLabelText("Template name")).toHaveValue("Retry-safe example");
    fireEvent.click(screen.getByRole("button", { name: "Save new template" }));
    await screen.findByText(/New company template saved/);
    expect(calls("/templates")[0]![1]).toEqual(calls("/templates")[1]![1]);
  });

  it("returns to the actual source lead only after dirty edits are kept or discarded explicitly", async () => {
    await select();
    fireEvent.change(screen.getByLabelText("Scope of work"), {
      target: { value: "Pending scope" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open source lead" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(onOpenLead).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Scope of work")).toHaveValue("Pending scope");
    fireEvent.click(screen.getByRole("button", { name: "Open source lead" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(onOpenLead).toHaveBeenCalledExactlyOnceWith(leadId);
  });

  it("offers explicit clearing of old amounts after company tax and discount are disabled", async () => {
    record.versions[0]!.content.discountMinor = 1000;
    record.versions[0]!.content.taxBasisPoints = 500;
    data.branding = { ...data.branding, discountEnabled: false, taxEnabled: false };
    await select();
    expect(screen.getByLabelText("Discount amount")).toHaveValue("10.00");
    expect(screen.getByLabelText("Tax percent")).toHaveValue("5.00");
    expect(screen.getByLabelText("Discount amount")).toBeDisabled();
    expect(screen.getByLabelText("Tax percent")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Remove disabled discount" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove disabled tax" }));
    fireEvent.click(screen.getByRole("button", { name: "Save proposal" }));
    await screen.findByText(/Proposal version saved/);
    expect(calls("/save")[0]![1]).toMatchObject({
      content: { discountMinor: 0, taxBasisPoints: 0 },
    });
  });

  it("guards unsaved award fields while keeping the outcome action available", async () => {
    record.state = "approved";
    record.approvedVersion = 1;
    await select();
    fireEvent.click(screen.getByRole("button", { name: "Outcome & project" }));
    fireEvent.change(screen.getByLabelText("Award date"), { target: { value: "2026-09-23" } });
    fireEvent.change(screen.getByLabelText("Purchase order / acceptance reference"), {
      target: { value: "PENDING-PO" },
    });
    fireEvent.change(screen.getByLabelText("Award start date"), {
      target: { value: "2026-10-08" },
    });
    fireEvent.change(screen.getByLabelText("Internal award notes"), {
      target: { value: "Pending handoff" },
    });
    expect(screen.getByRole("button", { name: "Record award" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Projects", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Purchase order / acceptance reference")).toHaveValue(
      "PENDING-PO",
    );
    expect(screen.getByLabelText("Award start date")).toHaveValue("2026-10-08");
    expect(dirty).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Record award" }));
    await screen.findByText(/Commercial outcome recorded/);
    expect(calls("/outcome")[0]![1]).toMatchObject({
      expectedRevision: 1,
      outcome: "awarded",
      award: { purchaseOrder: "PENDING-PO", startDate: "2026-10-08", notes: "Pending handoff" },
    });
    expect(dirty).toHaveBeenLastCalledWith(false);
  });

  it("guards review notes without disabling approve and clears them only after success or discard", async () => {
    record.state = "review";
    await select();
    fireEvent.change(screen.getByLabelText("Review / revision note"), {
      target: { value: "Scope verified" },
    });
    expect(screen.getByRole("button", { name: "Approve version 1" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Templates & services" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Review / revision note")).toHaveValue("Scope verified");
    fireEvent.click(screen.getByRole("button", { name: "Approve version 1" }));
    await screen.findByText(/This saved version is approved/);
    expect(calls("/review")[0]![1]).toEqual({
      expectedRevision: 1,
      decision: "approve",
      note: "Scope verified",
    });
    expect(screen.getByLabelText("Review / revision note")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Review / revision note"), {
      target: { value: "Unsubmitted revision reason" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Templates & services" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByRole("heading", { name: "Create a template" })).toBeVisible();
    expect(dirty).toHaveBeenLastCalledWith(false);
  });

  it("retains stale outcome entries and requires explicit reload before recording a newer proposal", async () => {
    record.state = "approved";
    record.approvedVersion = 1;
    await select();
    fireEvent.click(screen.getByRole("button", { name: "Outcome & project" }));
    fireEvent.change(screen.getByLabelText("Purchase order / acceptance reference"), {
      target: { value: "Keep this award reference" },
    });
    record.revision = 2;
    fireEvent.click(screen.getByRole("button", { name: "Refresh saved state" }));
    await screen.findByText(/The saved proposal changed. Your outcome entries are kept/);
    expect(screen.getByLabelText("Purchase order / acceptance reference")).toHaveValue(
      "Keep this award reference",
    );
    expect(screen.getByRole("button", { name: "Record award" })).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Discard outcome entries and load latest" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByLabelText("Purchase order / acceptance reference")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Record award" })).toBeEnabled();
  });

  it("does not approve unseen refreshed content while retaining a pending review note", async () => {
    record.state = "review";
    await select();
    fireEvent.change(screen.getByLabelText("Review / revision note"), {
      target: { value: "My pending review" },
    });
    record.revision = 2;
    record.versions[0]!.content.scope = "Changed saved scope";
    fireEvent.click(screen.getByRole("button", { name: "Refresh saved state" }));
    await screen.findByText(/The saved proposal changed while you were reviewing it/);
    expect(screen.getByLabelText("Review / revision note")).toHaveValue("My pending review");
    expect(screen.getByRole("button", { name: "Approve version 1" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Request revision" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Discard pending review and load latest" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByLabelText("Scope of work")).toHaveValue("Changed saved scope");
    expect(screen.getByLabelText("Review / revision note")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Approve version 1" })).toBeEnabled();
    expect(calls("/review")).toHaveLength(0);
  });
});
