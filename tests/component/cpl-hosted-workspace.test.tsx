import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "../../apps/web/app/workspace/workspace";

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
  let version = 1;
  const fetchMock = vi.fn<typeof fetch>();
  function workspace() {
    return {
      organizations: [
        { id: orgA, displayName: "Fictional Alpha", slug: "fictional-alpha" },
        { id: orgB, displayName: "Fictional Beta", slug: "fictional-beta" },
      ],
      currentOrganizationId: selected,
      leads: [
        {
          id: leadId,
          organizationId: selected,
          title: "Fictional inquiry",
          contactName: "Example",
          contactEmail: null,
          details: "Test only",
          version: 1,
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
              identity: {
                id: "owner",
                displayName: "Fictional Owner",
                email: "owner@example.invalid",
              },
              csrfToken: "csrf-test-only",
              session: {
                expiresAt: "2026-09-21T23:00:00Z",
                currentOrganizationId: selected,
                stepUpRequired: false,
                hasPasskey: true,
              },
            }
          : { authenticated: false },
      );
    if (url === "/api/cpl/workspace") return json(workspace());
    if (url === "/api/cpl/organizations/select") {
      selected = JSON.parse(String(init?.body)).organizationId;
      return json({ ok: true });
    }
    if (url === "/api/auth/logout") {
      signedIn = false;
      return json({ ok: true });
    }
    if (url === "/api/cpl/leads") return json(workspace().leads[0], 201);
    if (url.startsWith("/api/cpl/proposals")) return json(workspace().proposals[0]);
    throw new Error(`Unexpected test request: ${url}`);
  }
  beforeEach(() => {
    selected = orgA;
    signedIn = true;
    version = 1;
    fetchMock.mockReset().mockImplementation(normalFetch);
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  async function open() {
    render(<Workspace />);
    await screen.findByRole("heading", { name: "Fictional Alpha" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save lead" })).toBeEnabled());
  }

  it("clears unsaved lead and proposal content when the displayed organization changes", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Lead title"), {
      target: { value: "Alpha private inquiry" },
    });
    fireEvent.change(screen.getByLabelText("Organization", { exact: true }), {
      target: { value: orgB },
    });
    await screen.findByRole("heading", { name: "Fictional Beta" });
    expect(screen.getByLabelText("Lead title")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Proposal drafts" }));
    fireEvent.change(screen.getByLabelText("Proposal title"), {
      target: { value: "Beta private title" },
    });
    fireEvent.change(screen.getByLabelText("Manual proposal content"), {
      target: { value: "Beta private content" },
    });
    fireEvent.change(screen.getByLabelText("Organization", { exact: true }), {
      target: { value: orgA },
    });
    await screen.findByRole("heading", { name: "Fictional Alpha" });
    expect(screen.getByLabelText("Proposal title")).toHaveValue("");
    expect(screen.getByLabelText("Manual proposal content")).toHaveValue("");
  });

  it("retains the original edit version across a status refresh", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Proposal drafts" }));
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
      if (String(input) === "/api/cpl/workspace" && ++workspaceReads > 1)
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      return normalFetch(input, init);
    });
    await open();
    // Session/CSRF synchronization performs a background refresh without locking actions.
    await waitFor(() => expect(release).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByRole("button", { name: "Continue with Google" });
    await act(async () => {
      release?.(json(staleWorkspace));
    });
    expect(screen.queryByRole("heading", { name: "Fictional Alpha" })).not.toBeInTheDocument();
  });
});
