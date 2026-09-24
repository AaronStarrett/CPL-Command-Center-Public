import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "../../apps/web/app/workspace/workspace";
import { defaultCplCommercialBranding } from "@bea/domain/cpl-commercial";
import type { CplAutomationWorkspace } from "@bea/domain/cpl-automation";

vi.mock("@/components/app-logo", () => ({ AppLogo: () => <span>CPL</span> }));
vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
}));

const orgA = "10000000-0000-4000-8000-000000000001";
const orgB = "10000000-0000-4000-8000-000000000002";
const leadId = "20000000-0000-4000-8000-000000000001";
const proposalId = "30000000-0000-4000-8000-000000000001";
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("hosted workspace organization and edit safety", () => {
  let selected = orgA;
  let signedIn = true;
  let csrfToken = "csrf-test-only";
  let version = 1;
  let leadVersion = 1;
  let localDevelopment = false;
  let permissions = {
    canCreateLead: true,
    canEditLead: true,
    canReviewLead: true,
    canCreateProposal: true,
    canEditProposal: true,
  };
  const fetchMock = vi.fn<typeof fetch>();
  function actions(): CplAutomationWorkspace {
    return {
      recipes: [],
      executions: [],
      tasks: [
        {
          id: "40000000-0000-4000-8000-000000000001",
          organizationId: selected,
          revision: 1,
          executionId: null,
          title: "Check current lead",
          reason: "Contact method needed",
          group: "missing_information",
          customerName: "Example Customer",
          projectName: null,
          nextAction: "Confirm the contact",
          isMine: true,
          target: { kind: "lead", id: leadId, projectId: null, version: 1 },
          owner: { kind: "role", role: "owner", identityId: null },
          dueAt: null,
          status: "open",
          resolutionReason: null,
          createdAt: "2026-09-23T12:00:00Z",
          updatedAt: "2026-09-23T12:00:00Z",
          availableActions: {
            canAssign: true,
            canStart: true,
            canComplete: true,
            canDismiss: true,
          },
        },
      ],
      counts: {
        openTasks: 1,
        myTasks: 1,
        reviews: 0,
        missingInformation: 1,
        delivery: 0,
        closeout: 0,
        failedExecutions: 0,
        queuedExecutions: 0,
        succeededExecutions: 0,
      },
      currentIdentityId: "owner",
      members: [{ identityId: "owner", displayName: "Fictional Owner", role: "owner" }],
      proposalTemplates: [],
      reportTemplates: [],
      permissions: {
        canConfigure: true,
        canOperate: true,
        canAssign: true,
        canViewExecutions: true,
      },
      listLimit: 100,
    };
  }
  function workspace() {
    return {
      organizations: [
        { id: orgA, displayName: "Fictional Alpha", slug: "fictional-alpha" },
        { id: orgB, displayName: "Fictional Beta", slug: "fictional-beta" },
      ],
      currentOrganizationId: selected,
      permissions,
      intakeDirectory: {
        customers: [{ id: "customer-a", name: "Example Customer" }],
        contacts: [],
        sites: [],
        members: [{ identityId: "owner", displayName: "Fictional Owner" }],
      },
      leads: [
        {
          id: leadId,
          organizationId: selected,
          title: "Fictional inquiry",
          contactName: "Example",
          contactEmail: null,
          details: "Test only",
          version: leadVersion,
          sourceType: "email",
          customerId: null,
          customerName: "Example Customer",
          contactId: null,
          contactPhone: "",
          siteId: null,
          siteName: "",
          siteAddress: "",
          requestedService: "Inspection",
          receivedAt: "2026-09-21T00:00:00Z",
          requestedDeadlineAt: null,
          requestedVisitAt: null,
          assignedMemberIdentityId: "owner",
          nextAction: "Confirm the requested scope",
          notes: "",
          status: "needs_info",
          disqualificationReason: null,
          readiness: {
            readyForProposal: false,
            missingInformation: [
              { code: "contact", severity: "blocking", message: "Confirm a contact method." },
            ],
            conflicts: [{ code: "scope", message: "Requested scope needs confirmation." }],
          },
          duplicateCandidates: [
            { leadId: "related-lead", title: "Related inquiry", reasons: ["Matching contact"] },
          ],
          duplicateReview: {
            disposition: "unreviewed",
            reason: null,
            relatedLeadId: null,
            reviewedAt: null,
          },
          evidence: [
            {
              id: "source-a",
              kind: "initial_capture",
              label: "Original email",
              reference: "email-reference-only",
              note: "Original source wording",
              createdAt: "2026-09-21T00:00:00Z",
              actorIdentityId: "owner",
            },
          ],
          createdAt: "2026-09-21T00:00:00Z",
          updatedAt: "2026-09-21T00:00:00Z",
        },
      ],
      proposals: [
        {
          id: proposalId,
          organizationId: selected,
          leadId,
          title: "Fictional draft",
          content: `Saved version ${version}`,
          status: "draft",
          version,
          preparedVersion: version,
          createdAt: "2026-09-21T00:00:00Z",
          updatedAt: "2026-09-21T00:00:00Z",
        },
      ],
      jobs: [],
    };
  }
  async function normalFetch(input: RequestInfo | URL, init?: RequestInit) {
    const url = String(input);
    if (url === "/api/auth/session")
      return json(
        signedIn
          ? {
              authenticated: true,
              authenticationMode: localDevelopment ? "local-development" : "google",
              synthetic: localDevelopment,
              identity: {
                id: "owner",
                displayName: "Fictional Owner",
                email: "owner@example.invalid",
              },
              csrfToken,
              session: {
                expiresAt: "2026-09-21T23:00:00Z",
                currentOrganizationId: selected,
                stepUpRequired: false,
                hasPasskey: true,
              },
            }
          : {
              authenticated: false,
              authenticationMode: localDevelopment ? "local-development" : "google",
              synthetic: localDevelopment,
            },
      );
    if (url === "/api/cpl/workspace") return json(workspace());
    if (url === "/api/cpl-company/intake-policy")
      return json({ version: 0, input: { requiredFields: [], customFields: [] } });
    if (url.startsWith("/api/cpl-company/catalog?"))
      return json({ items: [], total: 0, nextCursor: null, hasMore: false, limit: 25 });
    if (url === "/api/cpl-company/workspace")
      return json({
        organizationId: selected,
        profile: {
          version: 0,
          input: {
            displayName: "Fictional Alpha",
            legalName: "",
            email: "",
            phone: "",
            address: "",
            timeZone: "UTC",
          },
        },
        intakePolicy: { version: 0, input: { requiredFields: [], customFields: [] } },
        defaultCurrency: "USD",
        permissions: {
          canConfigure: true,
          canReadDirectory: true,
          canWriteDirectory: true,
          canReadAudit: true,
        },
        readiness: [],
        setup: { status: "incomplete", checks: [] },
      });

    if (url === "/api/cpl-admin/bootstrap")
      return json({
        identity: { id: "owner", displayName: "Fictional Owner" },
        organizations: workspace().organizations,
        selectedOrganizationId: selected,
        membership: { role: "owner", version: 1 },
        platform: { canProvision: false, assurance: "none" },
        permissions: {
          canManageMembers: true,
          canGrantOwner: true,
          canConfigureCompany: true,
          canReadDirectory: true,
          canWriteDirectory: true,
          canReadAudit: true,
        },
        enabledModules: [
          "intake-job-tracker",
          "proposal-builder",
          "award-to-project-launcher",
          "field-report-assembler",
        ],
        roles: [],
        localRecipients: [],
      });
    if (url === "/api/auth/local/config")
      return json({
        authenticationMode: "local-development",
        synthetic: true,
        personas: [
          { key: "legacy-owner", label: "Existing development owner" },
          { key: "platform-operator", label: "Synthetic platform operator" },
        ],
      });
    if (url.startsWith("/api/cpl-admin/members?"))
      return json({ items: [], total: 0, nextCursor: null, limit: 25 });
    if (url === "/api/cpl-automation/workspace") return json(actions());
    if (url.startsWith("/api/cpl-automation/tasks/")) return json(actions().tasks[0]);
    if (url === "/api/cpl-commercial/workspace")
      return json({
        proposals: [],
        templates: [],
        projects: [],
        branding: defaultCplCommercialBranding(),
        permissions: {
          canEdit: true,
          canReview: true,
          canAward: true,
          canCreateProject: true,
          canConfigure: true,
        },
      });
    if (url === "/api/cpl/organizations/select") {
      selected = JSON.parse(String(init?.body)).organizationId;
      return json({ ok: true });
    }
    if (url === "/api/auth/logout") {
      signedIn = false;
      return json({ ok: true });
    }
    if (url === "/api/cpl/leads") return json(workspace().leads[0], 201);
    if (url.startsWith("/api/cpl/leads/")) return json(workspace().leads[0]);
    if (url === "/api/auth/local/sign-in") {
      signedIn = true;
      return json({ ok: true });
    }
    if (url.startsWith("/api/cpl/proposals")) return json(workspace().proposals[0]);
    throw new Error(`Unexpected test request: ${url}`);
  }
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    selected = orgA;
    signedIn = true;
    csrfToken = "csrf-test-only";
    version = 1;
    leadVersion = 1;
    localDevelopment = false;
    permissions = {
      canCreateLead: true,
      canEditLead: true,
      canReviewLead: true,
      canCreateProposal: true,
      canEditProposal: true,
    };
    fetchMock.mockReset().mockImplementation(normalFetch);
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    expect(console.error).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  async function open() {
    render(<Workspace />);
    await screen.findByRole("heading", { name: "Fictional Alpha" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Leads", exact: true })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Leads", exact: true }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save lead" })).toBeEnabled());
  }

  it.each(["integration", "source_receipt"] as const)(
    "routes Action Center %s attention into the exact company-scoped integration detail",
    async (kind) => {
      const targetId = "60000000-0000-4000-8000-000000000001";
      fetchMock.mockImplementation(async (input, init) => {
        const path = String(input);
        if (path === "/api/cpl-admin/bootstrap") {
          const data = await (await normalFetch(input, init)).json();
          data.permissions.canReadIntegrations = true;
          return json(data);
        }
        if (path === "/api/cpl-automation/workspace") {
          const value = actions();
          value.tasks[0]!.target = { kind, id: targetId, projectId: null, version: null };
          value.tasks[0]!.availableActions = {
            canAssign: false,
            canStart: false,
            canComplete: false,
            canDismiss: false,
          };
          return json(value);
        }
        if (path === "/api/cpl-integrations/workspace")
          return json({
            permissions: {
              canViewStatus: true,
              canConfigure: true,
              canAuthorize: true,
              canOperate: true,
              canReadSource: true,
              canReprocess: true,
            },
            connections: { items: [], total: 0, nextCursor: null, limit: 25 },
            forms: { items: [], total: 0, nextCursor: null, limit: 25 },
            mappings: [],
            counts: {
              queued: 0,
              processing: 0,
              needsReview: 1,
              linkedLead: 0,
              rejected: 0,
              failed: 0,
              blocked: 0,
            },
            runtime: { providerMode: "local_fixture", liveVerification: "deferred" },
          });
        if (
          path ===
          `/api/cpl-integrations/${kind === "integration" ? "connections" : "receipts"}/${targetId}`
        )
          return json({ code: "CPL_INTEGRATION_NOT_FOUND" }, 404);
        if (path.startsWith("/api/cpl-integrations/"))
          return json({ items: [], total: 0, nextCursor: null, limit: 25 });
        return normalFetch(input, init);
      });
      render(<Workspace />);
      fireEvent.click(await screen.findByRole("button", { name: /Check current lead/u }));
      fireEvent.click(screen.getByRole("button", { name: "Open related record" }));
      await screen.findByRole("heading", { name: "Company integrations & intake" });
      const expected = `/api/cpl-integrations/${kind === "integration" ? "connections" : "receipts"}/${targetId}`;
      await waitFor(() =>
        expect(fetchMock.mock.calls.some(([path]) => path === expected)).toBe(true),
      );
      const call = fetchMock.mock.calls.find(([path]) => path === expected)!;
      expect(new Headers(call[1]?.headers).get("X-CPL-Organization")).toBe(orgA);
      await screen.findByText("This integration record is not available in the selected company.");
      expect(
        fetchMock.mock.calls.some(([path]) => String(path).startsWith("/api/cpl-commercial/")),
      ).toBe(false);
    },
  );

  it("shows a safe local sign-in correlation reference and keeps the sign-in choice available", async () => {
    localDevelopment = true;
    signedIn = false;
    const correlationId = "00000000-0000-4000-8000-000000000123";
    fetchMock.mockImplementation(async (input, init) =>
      String(input) === "/api/auth/local/sign-in"
        ? json(
            { code: "CPL_HOSTED_AUTH_UNAVAILABLE", correlationId, message: "PRIVATE_SQL_CANARY" },
            503,
          )
        : normalFetch(input, init),
    );
    render(<Workspace />);
    fireEvent.click(await screen.findByRole("button", { name: "Enter development workspace" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(`Reference: ${correlationId}`);
    expect(screen.queryByText(/PRIVATE_SQL_CANARY/u)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enter development workspace" })).toBeEnabled();
  });

  it("handles a non-JSON startup failure with its validated correlation header", async () => {
    const correlationId = "00000000-0000-4000-8000-000000000124";
    fetchMock.mockImplementation(
      async () =>
        new Response("PRIVATE_SERVER_HTML_CANARY", {
          status: 503,
          headers: { "X-CPL-Correlation-ID": correlationId, "Content-Type": "text/html" },
        }),
    );
    render(<Workspace />);
    expect(await screen.findByRole("alert")).toHaveTextContent(`Reference: ${correlationId}`);
    expect(
      screen.queryByText(/PRIVATE_SERVER_HTML_CANARY|Unexpected token/u),
    ).not.toBeInTheDocument();
  });

  it("clears discarded lead state across proposal handoff and later navigation without weakening Keep editing", async () => {
    localDevelopment = true;
    let switched = false;
    fetchMock.mockImplementation(async (input, init) => {
      const path = String(input);
      if (path === "/api/auth/local/sign-in") switched = true;
      if (path === "/api/cpl/workspace") {
        const value = workspace();
        value.leads[0]!.status = "ready_for_proposal";
        value.leads[0]!.readiness = {
          readyForProposal: true,
          missingInformation: [],
          conflicts: [],
        };
        return json(value);
      }
      const response = await normalFetch(input, init);
      if (switched && path === "/api/auth/session") {
        const value = await response.json();
        value.identity = {
          id: "operator",
          displayName: "Synthetic platform operator",
          email: null,
        };
        value.session.currentOrganizationId = null;
        return json(value);
      }
      if (switched && path === "/api/cpl-admin/bootstrap") {
        const value = await response.json();
        value.identity = { id: "operator", displayName: "Synthetic platform operator" };
        value.organizations = [];
        value.selectedOrganizationId = null;
        value.membership = null;
        value.platform = { canProvision: true, assurance: "local-development" };
        return json(value);
      }
      return response;
    });
    await open();
    fireEvent.click(screen.getByRole("button", { name: /^All\s*1$/ }));
    fireEvent.click(screen.getByRole("button", { name: /Fictional inquiry/ }));
    fireEvent.change(screen.getByLabelText("Next action"), {
      target: { value: "Keep until deliberately discarded" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create proposal", exact: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Keep editing", exact: true }));
    expect(screen.getByLabelText("Next action")).toHaveValue("Keep until deliberately discarded");
    expect(screen.queryByRole("heading", { name: "Proposals & projects" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create proposal", exact: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard changes", exact: true }));
    await screen.findByRole("heading", { name: "Proposals & projects" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Company settings", exact: true })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Company settings", exact: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await screen.findByRole("heading", { name: "Company settings & access" });
    fireEvent.click(screen.getByRole("button", { name: "Leads", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Company settings", exact: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Development identity"), {
      target: { value: "platform-operator" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Switch development identity" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/auth/local/sign-in",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ personaKey: "platform-operator" }),
        }),
      ),
    );
    await screen.findByRole("button", { name: "Platform administration", exact: true });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([path, init]) => String(path).startsWith("/api/cpl/leads/") && init?.method === "PATCH",
      ),
    ).toBe(false);
  });

  it("clears a discarded lead on legacy handoff while retaining genuinely edited legacy drafts", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: /^All\s*1$/ }));
    fireEvent.click(screen.getByRole("button", { name: /Fictional inquiry/ }));
    fireEvent.change(screen.getByLabelText("Next action"), {
      target: { value: "Discard only after confirming the handoff" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Fictional draft.*Legacy draft/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard changes", exact: true }));
    await screen.findByRole("heading", { name: "Saved drafts" });
    fireEvent.click(screen.getByRole("button", { name: "Company settings", exact: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await screen.findByRole("heading", { name: "Company settings & access" });
    fireEvent.click(screen.getByRole("button", { name: "Leads", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: /Fictional draft.*Legacy draft/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit draft", exact: true }));
    fireEvent.change(screen.getByLabelText("Proposal title"), {
      target: { value: "Keep this real legacy draft change" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Company settings", exact: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Keep editing", exact: true }));
    expect(screen.getByLabelText("Proposal title")).toHaveValue(
      "Keep this real legacy draft change",
    );
    expect(screen.getByRole("heading", { name: "Edit proposal draft" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("opens Action Center first and follows the exact tenant-scoped lead target", async () => {
    render(<Workspace />);
    await screen.findByRole("button", { name: /Check current lead/ });
    expect(screen.getByRole("button", { name: "Action Center", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/cpl-automation/workspace",
      expect.objectContaining({
        method: "GET",
        credentials: "same-origin",
        headers: { "X-CPL-Organization": orgA },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Check current lead/ }));
    fireEvent.change(screen.getByLabelText(/^Action reason/), {
      target: { value: "Unsaved task note" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open related record" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText(/^Action reason/)).toHaveValue("Unsaved task note");
    fireEvent.click(screen.getByRole("button", { name: "Open related record" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    await screen.findByRole("button", { name: "Save lead changes" });
    expect(screen.getByLabelText("Lead title")).toHaveValue("Fictional inquiry");
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/cpl/leads/${leadId}`,
      expect.objectContaining({
        method: "GET",
        headers: { "X-CPL-Organization": orgA },
      }),
    );
  });

  it("guards an unsaved action reason and sends scoped CSRF-protected task commands", async () => {
    render(<Workspace />);
    fireEvent.click(await screen.findByRole("button", { name: /Check current lead/ }));
    fireEvent.change(screen.getByLabelText(/^Action reason/), {
      target: { value: "Verified follow-up complete" },
    });
    fireEvent.change(screen.getByLabelText("Organization", { exact: true }), {
      target: { value: orgB },
    });
    expect(screen.getByRole("dialog", { name: "Keep your work?" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText(/^Action reason/)).toHaveValue("Verified follow-up complete");
    expect(
      fetchMock.mock.calls.some(([url]) => String(url) === "/api/cpl/organizations/select"),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Complete action" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/cpl-automation/tasks/40000000-0000-4000-8000-000000000001",
        expect.objectContaining({
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "X-CPL-CSRF": csrfToken,
            "X-CPL-Organization": orgA,
          },
        }),
      ),
    );
    const call = fetchMock.mock.calls.find(([url]) =>
      String(url).startsWith("/api/cpl-automation/tasks/"),
    )!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({
      action: "complete",
      expectedRevision: 1,
      reason: "Verified follow-up complete",
      idempotencyKey: expect.any(String),
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Leads", exact: true })).toBeEnabled(),
    );
  });

  it("loads one initial GET pair and keeps current mutation headers after switching organizations", async () => {
    await open();
    const reads = (path: string) => fetchMock.mock.calls.filter(([url]) => String(url) === path);
    expect(reads("/api/auth/session")).toHaveLength(1);
    expect(reads("/api/cpl/workspace")).toHaveLength(1);
    csrfToken = "rotated-csrf-test-only";
    fireEvent.change(screen.getByLabelText("Organization", { exact: true }), {
      target: { value: orgB },
    });
    await screen.findByRole("heading", { name: "Fictional Beta" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save lead" })).toBeEnabled());
    expect(reads("/api/auth/session")).toHaveLength(2);
    expect(reads("/api/cpl/workspace")).toHaveLength(2);
    for (const [, init] of [...reads("/api/auth/session"), ...reads("/api/cpl/workspace")])
      expect(init).toEqual(
        expect.objectContaining({
          method: "GET",
          cache: "no-store",
          credentials: "same-origin",
          headers: undefined,
        }),
      );
    fireEvent.change(screen.getByLabelText("Lead title"), { target: { value: "Beta inquiry" } });
    fireEvent.change(screen.getByLabelText("Contact name"), { target: { value: "Example" } });
    fireEvent.click(screen.getByRole("button", { name: "Save lead" }));
    await screen.findByText("Lead saved to your organization.");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/cpl/leads",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-CPL-CSRF": "rotated-csrf-test-only",
          "X-CPL-Organization": orgB,
        },
      }),
    );
  });

  it.each([
    ["CPL_CSRF_REJECTED", 403],
    ["CPL_AUTHENTICATION_REQUIRED", 401],
  ])(
    "shows sign-in after %s only when the session check confirms it ended",
    async (code, status) => {
      await open();
      fetchMock.mockImplementation(async (input, init) => {
        if (String(input) === "/api/auth/logout") {
          signedIn = false;
          return json({ ok: false, code }, status);
        }
        return normalFetch(input, init);
      });
      fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
      await screen.findByRole("button", { name: "Continue with Google" });
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Your session expired. Sign in again to continue.",
      );
      expect(screen.queryByRole("heading", { name: "Fictional Alpha" })).not.toBeInTheDocument();
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url) === "/api/auth/logout"),
      ).toHaveLength(1);
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url) === "/api/auth/session"),
      ).toHaveLength(2);
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url) === "/api/cpl/workspace"),
      ).toHaveLength(1);
    },
  );

  it.each(["authenticated", "unavailable"])(
    "does not treat rejected logout as success when the session is %s",
    async (state) => {
      await open();
      fetchMock.mockImplementation(async (input, init) => {
        if (String(input) === "/api/auth/logout")
          return json({ ok: false, code: "CPL_CSRF_REJECTED" }, 403);
        if (String(input) === "/api/auth/session" && state === "unavailable")
          return json({ ok: false, code: "CPL_HOSTED_AUTH_UNAVAILABLE" }, 503);
        return normalFetch(input, init);
      });
      fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Your sign-in state changed. Refresh and try again.",
      );
      expect(screen.getByRole("heading", { name: "Fictional Alpha" })).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Continue with Google" }),
      ).not.toBeInTheDocument();
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url) === "/api/auth/logout"),
      ).toHaveLength(1);
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url) === "/api/auth/session"),
      ).toHaveLength(2);
    },
  );

  it("clears unsaved lead and proposal content when the displayed organization changes", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Lead title"), {
      target: { value: "Alpha private inquiry" },
    });
    fireEvent.change(screen.getByLabelText("Organization", { exact: true }), {
      target: { value: orgB },
    });
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    await screen.findByRole("heading", { name: "Fictional Beta" });
    expect(screen.getByLabelText("Lead title")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Legacy drafts" }));
    fireEvent.change(screen.getByLabelText("Proposal title"), {
      target: { value: "Beta private title" },
    });
    fireEvent.change(screen.getByLabelText("Manual proposal content"), {
      target: { value: "Beta private content" },
    });
    fireEvent.change(screen.getByLabelText("Organization", { exact: true }), {
      target: { value: orgA },
    });
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    await screen.findByRole("heading", { name: "Fictional Alpha" });
    expect(screen.getByLabelText("Proposal title")).toHaveValue("");
    expect(screen.getByLabelText("Manual proposal content")).toHaveValue("");
  });

  it("retains the original edit version across a status refresh", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Legacy drafts" }));
    fireEvent.click(screen.getByRole("button", { name: /Fictional draft/ }));
    fireEvent.click(screen.getByRole("button", { name: "Edit draft" }));
    fireEvent.change(screen.getByLabelText("Manual proposal content"), {
      target: { value: "My unfinished edit" },
    });
    version = 2;
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await screen.findByText("DRAFT · VERSION 2");
    await waitFor(() => expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/cpl/proposals/${proposalId}`,
        expect.objectContaining({
          body: JSON.stringify({
            title: "Fictional draft",
            content: "My unfinished edit",
            expectedVersion: 1,
          }),
          headers: expect.objectContaining({ "X-CPL-Organization": orgA }),
        }),
      ),
    );
  });

  it("reuses the same create key after an ambiguous network failure", async () => {
    let first = true;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/cpl/leads" && first) {
        first = false;
        throw new TypeError("Network interrupted");
      }
      return normalFetch(input, init);
    });
    await open();
    fireEvent.change(screen.getByLabelText("Lead title"), {
      target: { value: "Fictional new lead" },
    });
    fireEvent.change(screen.getByLabelText("Contact name"), { target: { value: "Example" } });
    fireEvent.click(screen.getByRole("button", { name: "Save lead" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Save lead" }));
    await screen.findByText("Lead saved to your organization.");
    const calls = fetchMock.mock.calls.filter(([url]) => String(url) === "/api/cpl/leads");
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[0][1]?.body)).idempotencyKey).toBe(
      JSON.parse(String(calls[1][1]?.body)).idempotencyKey,
    );
  });

  it("does not restore authenticated records from a stale refresh after logout", async () => {
    let release: ((response: Response) => void) | undefined;
    let workspaceReads = 0;
    const staleWorkspace = workspace();
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/cpl/workspace" && ++workspaceReads === 1)
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      return normalFetch(input, init);
    });
    // Strict Mode overlaps initial reads; the older response must not undo logout.
    render(
      <React.StrictMode>
        <Workspace />
      </React.StrictMode>,
    );
    await screen.findByRole("heading", { name: "Fictional Alpha" });
    await waitFor(() => expect(release).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByRole("button", { name: "Continue with Google" });
    await act(async () => {
      release?.(json(staleWorkspace));
    });
    expect(screen.queryByRole("heading", { name: "Fictional Alpha" })).not.toBeInTheDocument();
  });

  it("keeps source evidence alongside structured edits and server review signals", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: /Needs information Fictional inquiry/ }));
    expect(screen.getByLabelText("Requested service")).toHaveValue("Inspection");
    expect(screen.getByLabelText("Next action")).toHaveValue("Confirm the requested scope");
    expect(screen.getByText("Original source wording")).toBeVisible();
    expect(screen.getByText("Confirm a contact method.")).toBeVisible();
    expect(screen.getByText(/Requested scope needs confirmation/)).toBeVisible();
    expect(screen.getByRole("heading", { name: "Possible duplicates" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Request details"), {
      target: { value: "New interpretation" },
    });
    expect(screen.getByText("Original source wording")).toBeVisible();
    expect(screen.getByRole("button", { name: "Create proposal" })).toBeDisabled();
  });

  it("retains lead edit version and unsaved fields after refreshing a newer saved record", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: /Needs information Fictional inquiry/ }));
    fireEvent.change(screen.getByLabelText("Next action"), {
      target: { value: "My pending follow-up" },
    });
    leadVersion = 2;
    fireEvent.click(screen.getByRole("button", { name: "Refresh", exact: true }));
    await screen.findByText(/A newer saved version is available/);
    expect(screen.getByLabelText("Next action")).toHaveValue("My pending follow-up");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save lead changes" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save lead changes" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/cpl/leads/${leadId}`,
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
    const [, init] = fetchMock.mock.calls.find(
      ([url]) => String(url) === `/api/cpl/leads/${leadId}`,
    )!;
    expect(JSON.parse(String(init?.body))).toEqual(
      expect.objectContaining({ expectedVersion: 1, nextAction: "My pending follow-up" }),
    );
    expect(init?.headers).toEqual(
      expect.objectContaining({ "X-CPL-Organization": orgA, "X-CPL-CSRF": csrfToken }),
    );
  });

  it("lets a reviewer change disposition without exposing intake edit permissions", async () => {
    permissions = {
      canCreateLead: false,
      canEditLead: false,
      canReviewLead: true,
      canCreateProposal: false,
      canEditProposal: false,
    };
    render(<Workspace />);
    await screen.findByRole("heading", { name: "Fictional Alpha" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Leads", exact: true })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Leads", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: /Needs information Fictional inquiry/ }));
    expect(screen.getByLabelText("Lead title")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save lead changes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Create proposal" })).toBeDisabled();
    expect(screen.queryByText("Add source evidence")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Duplicate review"), { target: { value: "distinct" } });
    fireEvent.change(screen.getByLabelText("Duplicate review reason"), {
      target: { value: "Separate request verified" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save review" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/cpl/leads/${leadId}`,
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
    const [, init] = fetchMock.mock.calls.find(
      ([url]) => String(url) === `/api/cpl/leads/${leadId}`,
    )!;
    expect(JSON.parse(String(init?.body))).toEqual({
      expectedVersion: 1,
      status: "needs_info",
      duplicateDisposition: "distinct",
      duplicateReason: "Separate request verified",
      duplicateLeadId: null,
      disqualificationReason: null,
    });
  });

  it("fails closed on missing permission metadata", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/cpl/workspace")
        return json({ ...workspace(), permissions: undefined });
      return normalFetch(input, init);
    });
    render(<Workspace />);
    await screen.findByRole("heading", { name: "Fictional Alpha" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Leads", exact: true })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Leads", exact: true }));
    expect(screen.getByRole("button", { name: "Save lead" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Legacy drafts", exact: true }));
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
  });

  it("offers local entry only for the explicit synthetic development descriptor and keeps it after logout", async () => {
    localDevelopment = true;
    signedIn = false;
    render(<Workspace />);
    fireEvent.click(await screen.findByRole("button", { name: "Enter development workspace" }));
    await screen.findByRole("heading", { name: "Fictional Alpha" });
    expect(screen.getByText("DEVELOPMENT", { exact: true })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Continue with Google" })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/local/sign-in",
      expect.objectContaining({
        method: "POST",
        body: "{}",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Company settings", exact: true })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Company settings", exact: true }));
    expect(screen.getByRole("button", { name: "Refresh development sign-in" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Verify passkey" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByRole("button", { name: "Enter development workspace" });
  });

  it("reloads current identity action data when personas switch within the same company", async () => {
    localDevelopment = true;
    let switched = false,
      actionReads = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const path = String(input);
      if (path === "/api/auth/local/sign-in") switched = true;
      if (path === "/api/cpl-automation/workspace") {
        actionReads++;
        const value = actions();
        value.currentIdentityId = switched ? "member" : "owner";
        value.tasks[0]!.title = switched ? "Member current action" : "Owner current action";
        value.permissions.canConfigure = !switched;
        return json(value);
      }
      const response = await normalFetch(input, init);
      if (path === "/api/auth/session" && switched) {
        const value = await response.json();
        value.identity = {
          id: "member",
          displayName: "Synthetic member",
          email: "member@example.invalid",
        };
        return json(value);
      }
      if (path === "/api/cpl-admin/bootstrap" && switched) {
        const value = await response.json();
        value.identity = { id: "member", displayName: "Synthetic member" };
        value.membership.role = "member";
        value.permissions.canConfigureCompany = false;
        return json(value);
      }
      return response;
    });
    render(<Workspace />);
    await screen.findByRole("button", { name: /Owner current action/ });
    fireEvent.change(screen.getByLabelText("Development identity"), {
      target: { value: "platform-operator" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Switch development identity" }));
    await screen.findByRole("button", { name: /Member current action/ });
    expect(screen.queryByRole("button", { name: /Owner current action/ })).not.toBeInTheDocument();
    expect(actionReads).toBe(2);
  });

  it("retains dirty entries and blocks submission when the same identity's membership authority changes", async () => {
    let changed = false;
    fetchMock.mockImplementation(async (input, init) => {
      const response = await normalFetch(input, init);
      if (String(input) === "/api/cpl-admin/bootstrap" && changed) {
        const value = await response.json();
        value.membership = { role: "member", version: 2 };
        return json(value);
      }
      return response;
    });
    await open();
    fireEvent.change(screen.getByLabelText("Lead title"), {
      target: { value: "Retained after authority change" },
    });
    changed = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh", exact: true }));
    await screen.findByRole("button", { name: "Review current access" });
    expect(screen.getByLabelText("Lead title")).toHaveValue("Retained after authority change");
    const before = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").length;
    fireEvent.click(screen.getByRole("button", { name: "Save lead" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save lead" })).toBeEnabled());
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(before);
  });

  it("does not infer development sign-in from an incomplete descriptor", async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input) === "/api/auth/session"
        ? json({ authenticated: false, authenticationMode: "local-development", synthetic: false })
        : json({}),
    );
    render(<Workspace />);
    await screen.findByRole("button", { name: "Continue with Google" });
    expect(
      screen.queryByRole("button", { name: "Enter development workspace" }),
    ).not.toBeInTheDocument();
  });

  it("renders untrusted source text without turning it into markup or a link", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/cpl/workspace") {
        const value = workspace();
        value.leads[0]!.evidence[0]!.note = "<img src=x onerror=alert(1)>";
        value.leads[0]!.evidence[0]!.reference = "javascript:alert(1)";
        return json(value);
      }
      return normalFetch(input, init);
    });
    await open();
    fireEvent.click(screen.getByRole("button", { name: /Needs information Fictional inquiry/ }));
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeVisible();
    expect(screen.getByText("javascript:alert(1)").tagName).toBe("P");
    expect(document.querySelector("img[src='x']")).toBeNull();
  });

  it("sends an entered contact email and keeps the saved API readback after creation", async () => {
    let storedEmail: string | null = null;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/cpl/leads" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        expect(body.contactEmail).toBe("avery@example.invalid");
        storedEmail = body.contactEmail;
        return json({ ...workspace().leads[0], contactEmail: storedEmail }, 201);
      }
      if (String(input) === "/api/cpl/workspace") {
        const value = workspace();
        return json({
          ...value,
          leads: value.leads.map((lead) => ({ ...lead, contactEmail: storedEmail })),
        });
      }
      return normalFetch(input, init);
    });
    await open();
    fireEvent.change(screen.getByLabelText("Lead title"), {
      target: { value: "Email capture test" },
    });
    fireEvent.change(screen.getByLabelText("Contact email (optional)"), {
      target: { value: "avery@example.invalid" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save lead" }));
    await screen.findByText("Lead saved to your organization.");
    expect(screen.getByLabelText("Contact email (optional)")).toHaveValue("avery@example.invalid");
    fireEvent.click(screen.getByRole("button", { name: "Refresh", exact: true }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save lead changes" })).toBeEnabled(),
    );
    expect(screen.getByLabelText("Contact email (optional)")).toHaveValue("avery@example.invalid");
  });

  it("preserves evidence append identity when the network outcome is ambiguous", async () => {
    let first = true;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/evidence") && first) {
        first = false;
        throw new TypeError("Network interrupted");
      }
      return normalFetch(input, init);
    });
    await open();
    fireEvent.click(screen.getByRole("button", { name: /Needs information Fictional inquiry/ }));
    fireEvent.click(screen.getByText("Add source evidence"));
    fireEvent.change(screen.getByLabelText("Evidence label"), { target: { value: "Call note" } });
    fireEvent.change(screen.getByLabelText("Evidence note"), {
      target: { value: "Scope confirmed by contact" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preserve evidence" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Preserve evidence" }));
    await screen.findByText("Source evidence preserved with the lead.");
    const calls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/evidence"));
    expect(calls).toHaveLength(2);
    const firstInput = JSON.parse(String(calls[0]![1]?.body));
    const retryInput = JSON.parse(String(calls[1]![1]?.body));
    expect(firstInput).toEqual(retryInput);
    expect(firstInput).toEqual(
      expect.objectContaining({
        expectedVersion: 1,
        label: "Call note",
        note: "Scope confirmed by contact",
      }),
    );
  });

  it("keeps entered lead corrections after a server version conflict", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === `/api/cpl/leads/${leadId}` && init?.method === "PATCH")
        return json({ code: "CPL_LEAD_VERSION_CONFLICT" }, 409);
      return normalFetch(input, init);
    });
    await open();
    fireEvent.click(screen.getByRole("button", { name: /Needs information Fictional inquiry/ }));
    fireEvent.change(screen.getByLabelText("Request details"), {
      target: { value: "My pending correction" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save lead changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your entries are kept");
    expect(screen.getByLabelText("Request details")).toHaveValue("My pending correction");
    expect(screen.getByText("Original source wording")).toBeVisible();
  });

  it("opens explicit structured proposal setup only for a server-ready lead with scoped reads", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/cpl/workspace") {
        const value = workspace();
        value.leads[0]!.status = "ready_for_proposal";
        value.leads[0]!.readiness = {
          readyForProposal: true,
          missingInformation: [],
          conflicts: [],
        };
        value.leads[0]!.duplicateCandidates = [];
        return json(value);
      }
      return normalFetch(input, init);
    });
    await open();
    fireEvent.click(screen.getByRole("button", { name: /Ready\s*1/ }));
    fireEvent.click(screen.getByRole("button", { name: /Ready for proposal Fictional inquiry/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create proposal" }));
    await screen.findByRole("heading", { name: "Create a structured proposal" });
    expect(screen.getByLabelText("Confirmed lead")).toHaveValue(leadId);
    expect(screen.getByText("Original source wording")).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Create proposal", exact: true })).toBeEnabled(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/cpl-commercial/workspace",
      expect.objectContaining({
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "X-CPL-Organization": orgA },
      }),
    );
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => String(url) === "/api/cpl-commercial/proposals" && init?.method === "POST",
      ),
    ).toHaveLength(0);
  });

  it("guards dirty commercial navigation and sends current company and CSRF on configuration writes", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/cpl-commercial/branding")
        return json({ ...JSON.parse(String(init?.body)).input, revision: 1 });
      return normalFetch(input, init);
    });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Proposals", exact: true }));
    await screen.findByRole("heading", { name: "Proposals & projects" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Artifact branding" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Artifact branding" }));
    fireEvent.change(screen.getByLabelText("Document business name"), {
      target: { value: "Fictional Alpha Services" },
    });
    fireEvent.change(screen.getByLabelText("Organization", { exact: true }), {
      target: { value: orgB },
    });
    expect(screen.getByRole("dialog", { name: "Keep your work?" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    fireEvent.click(screen.getByRole("button", { name: "Leads", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Document business name")).toHaveValue("Fictional Alpha Services");
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        ["/api/auth/logout", "/api/cpl/organizations/select"].includes(String(url)),
      ),
    ).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Save artifact branding" }));
    await screen.findByText(/Company artifact branding saved/);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/cpl-commercial/branding",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-CPL-CSRF": csrfToken,
          "X-CPL-Organization": orgA,
        },
        body: expect.any(String),
      }),
    );
  });
});
