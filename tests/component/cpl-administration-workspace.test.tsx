import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import type { CplAdminBootstrap, CplAdminMember, CplAdminInvitation } from "@bea/domain/cpl-admin";
import {
  AcceptInvitation,
  ProvisionCompany,
  TeamAdministration,
  readInvitationHandoff,
} from "../../apps/web/app/workspace/administration-workspace";
const org = "10000000-0000-4000-8000-000000000001",
  operator = "20000000-0000-4000-8000-000000000001",
  owner = "20000000-0000-4000-8000-000000000002",
  token = "t".repeat(43);
const bootstrap: CplAdminBootstrap = {
  identity: { id: operator, displayName: "Synthetic operator" },
  organizations: [],
  selectedOrganizationId: null,
  membership: null,
  platform: { canProvision: true, assurance: "local-development" },
  permissions: {
    canManageMembers: true,
    canGrantOwner: true,
    canConfigureCompany: true,
    canReadDirectory: true,
    canWriteDirectory: true,
    canReadIntegrations: false,
    canReadAudit: true,
  },
  enabledModules: [],
  roles: [
    { role: "owner", description: "Own company", canGrant: true },
    { role: "member", description: "Draft work", canGrant: true },
  ],
  localRecipients: [
    { identityId: operator, personaKey: "platform-operator", displayName: "Synthetic operator" },
    { identityId: owner, personaKey: "owner-alpha", displayName: "Synthetic owner Alpha" },
  ],
};
function common(request = vi.fn().mockResolvedValue({})) {
  return { request, onDirty: vi.fn(), onBusy: vi.fn() };
}
function pendingInvitation(id: string): CplAdminInvitation {
  return {
    id,
    organizationId: org,
    recipientIdentityId: owner,
    recipientDisplayName: "Synthetic owner Alpha",
    role: "member",
    status: "pending",
    version: 1,
    createdAt: "2026-09-23T12:00:00Z",
    expiresAt: "2026-09-24T12:00:00Z",
    redeemedAt: null,
    revokedAt: null,
    invitedByIdentityId: operator,
    replacesId: null,
    canReissue: true,
    canRevoke: true,
  };
}
describe("administration UI identity and mutation contracts", () => {
  it("does not apply a late members response after switching to invitations", async () => {
    let resolveMembers!: (value: unknown) => void;
    const members = new Promise((resolve) => {
      resolveMembers = resolve;
    });
    const request = vi
      .fn()
      .mockImplementation((path: string) =>
        path.startsWith("/api/cpl-admin/members?")
          ? members
          : Promise.resolve({ items: [], total: 0, nextCursor: null, limit: 25 }),
      );
    render(<TeamAdministration {...common(request)} bootstrap={bootstrap} onChanged={vi.fn()} />);
    await waitFor(() => expect(request).toHaveBeenCalledWith(expect.stringContaining("/members?")));
    fireEvent.click(screen.getByRole("button", { name: "Invitations", exact: true }));
    await screen.findByLabelText("Verified invitation recipient");
    await act(async () =>
      resolveMembers({
        items: [
          {
            identityId: owner,
            displayName: "Late old member",
            email: null,
            role: "member",
            status: "active",
            version: 1,
            createdAt: "2026-09-23T12:00:00Z",
            canChange: true,
            canGrantOwner: true,
            needsReassignment: false,
          },
        ],
        total: 1,
        nextCursor: null,
        limit: 25,
      }),
    );
    expect(screen.queryByText("Late old member")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Invitations", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
  it("retains other invitation forms and their navigation guard after one action succeeds", async () => {
    const first = pendingInvitation("30000000-0000-4000-8000-000000000010"),
      second = pendingInvitation("30000000-0000-4000-8000-000000000011");
    const request = vi.fn().mockImplementation(async (path: string, body?: unknown) => {
      if (body)
        return { invitation: { ...first, status: "revoked" }, token: null, delivery: "not_sent" };
      return {
        items: path.includes("/invitations?") ? [first, second] : [],
        total: 2,
        nextCursor: null,
        limit: 25,
      };
    });
    const props = common(request);
    render(<TeamAdministration {...props} bootstrap={bootstrap} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Invitations", exact: true }));
    const reasons = await screen.findAllByLabelText("Reason");
    fireEvent.change(reasons[0]!, { target: { value: "Cancel first handoff" } });
    fireEvent.change(reasons[1]!, { target: { value: "Unfinished second reason" } });
    fireEvent.change(screen.getByLabelText("Verified invitation recipient"), {
      target: { value: owner },
    });
    const listReads = request.mock.calls.filter(([, body]) => body === undefined).length;
    fireEvent.click(
      within(reasons[0]!.closest("form")!).getByRole("button", { name: "Revoke invitation" }),
    );
    await screen.findByText(/Invitation revoked\. Other unsaved forms/);
    expect(props.onDirty).toHaveBeenLastCalledWith(true);
    expect(screen.getAllByLabelText("Reason")[1]).toHaveValue("Unfinished second reason");
    expect(screen.getByLabelText("Verified invitation recipient")).toHaveValue(owner);
    expect(request.mock.calls.filter(([, body]) => body === undefined)).toHaveLength(listReads);
    fireEvent.click(screen.getByRole("button", { name: "Refresh invitations" }));
    fireEvent.click(await screen.findByRole("button", { name: "Keep editing" }));
    expect(screen.getAllByLabelText("Reason")[1]).toHaveValue("Unfinished second reason");
    fireEvent.click(screen.getByRole("button", { name: "Refresh invitations" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
    await waitFor(() =>
      expect(
        screen.getAllByLabelText("Reason").every((el) => (el as HTMLInputElement).value === ""),
      ).toBe(true),
    );
    expect(screen.getByLabelText("Verified invitation recipient")).toHaveValue("");
    expect(props.onDirty).toHaveBeenLastCalledWith(false);
  });
  it("does not replace an unfinished invitation reason when a new handoff is created", async () => {
    const existing = pendingInvitation("30000000-0000-4000-8000-000000000020"),
      created = pendingInvitation("30000000-0000-4000-8000-000000000021");
    const request = vi.fn().mockImplementation(async (path: string, body?: unknown) => {
      if (body) return { invitation: created, token, delivery: "not_sent" };
      return {
        items: path.includes("/invitations?") ? [existing] : [],
        total: 1,
        nextCursor: null,
        limit: 25,
      };
    });
    const props = common(request);
    render(<TeamAdministration {...props} bootstrap={bootstrap} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Invitations", exact: true }));
    fireEvent.change(await screen.findByLabelText("Reason"), {
      target: { value: "Keep this unfinished explanation" },
    });
    fireEvent.change(screen.getByLabelText("Verified invitation recipient"), {
      target: { value: owner },
    });
    const listReads = request.mock.calls.filter(([, body]) => body === undefined).length;
    fireEvent.click(screen.getByRole("button", { name: "Create local handoff invitation" }));
    await screen.findByRole("heading", { name: "Invitation NOT SENT" });
    expect(screen.getByLabelText("Reason")).toHaveValue("Keep this unfinished explanation");
    expect(screen.getByLabelText("Verified invitation recipient")).toHaveValue("");
    expect(props.onDirty).toHaveBeenLastCalledWith(true);
    expect(request.mock.calls.filter(([, body]) => body === undefined)).toHaveLength(listReads);
    fireEvent.click(screen.getByRole("button", { name: "Members", exact: true }));
    expect(await screen.findByRole("button", { name: "Keep editing" })).toBeInTheDocument();
  });
  it("provisions a distinct chosen initial owner with stable retry key and no implicit operator membership", async () => {
    const request = vi
        .fn()
        .mockRejectedValueOnce(new Error("Retry after connection loss"))
        .mockResolvedValue({ id: org }),
      props = common(request);
    render(<ProvisionCompany {...props} bootstrap={bootstrap} onCreated={vi.fn()} />);
    expect(screen.queryByRole("option", { name: "Synthetic operator" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Company name"), {
      target: { value: "Synthetic Alpha" },
    });
    fireEvent.change(screen.getByLabelText(/^Company workspace key/), {
      target: { value: "synthetic-alpha" },
    });
    fireEvent.change(screen.getByLabelText("Initial company owner"), { target: { value: owner } });
    fireEvent.click(screen.getByRole("button", { name: "Create company" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Create company" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[0]).toEqual(request.mock.calls[1]);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      initialOwnerIdentityId: owner,
      enabledModules: expect.arrayContaining(["intake-job-tracker", "proposal-builder"]),
    });
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty("role");
  });
  it("does not offer company provisioning to an ordinary company owner", () => {
    render(
      <ProvisionCompany
        {...common()}
        bootstrap={{ ...bootstrap, platform: { canProvision: false, assurance: "none" } }}
        onCreated={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Create company" })).not.toBeInTheDocument();
    expect(
      screen.getByText(/requires the separate authorized platform operator/),
    ).toBeInTheDocument();
  });
  it("parses only same-origin fragment handoffs and refuses query-token/external URLs", () => {
    const origin = "http://127.0.0.1:3400";
    expect(
      readInvitationHandoff(`${origin}/workspace#cplInvite=${token}&organization=${org}`, origin),
    ).toEqual({ organizationId: org, invitationToken: token });
    for (const url of [
      `${origin}/workspace?cplInvite=${token}&organization=${org}`,
      `https://other.invalid/workspace#cplInvite=${token}&organization=${org}`,
      `${origin}/workspace#cplInvite=${token}&cplInvite=${token}&organization=${org}`,
    ])
      expect(readInvitationHandoff(url, origin)).toBeNull();
  });
  it("accepts only as the current identity and sends exact invitation fields", async () => {
    const request = vi.fn().mockResolvedValue({ organizationId: org });
    render(
      <AcceptInvitation
        {...common(request)}
        handoff={{ organizationId: org, invitationToken: token }}
        identityName="Synthetic recipient"
        onAccepted={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Accept invitation as this identity" }));
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request.mock.calls[0]?.[1]).toEqual({
      organizationId: org,
      invitationToken: token,
      idempotencyKey: expect.any(String),
    });
    expect(screen.getByText(/No email was sent/)).toBeInTheDocument();
  });
  it("keeps membership edits after a stale-version denial and never silently retries", async () => {
    const member: CplAdminMember = {
      identityId: owner,
      displayName: "Synthetic member",
      email: null,
      role: "member",
      status: "active",
      version: 3,
      createdAt: "2026-09-23T12:00:00Z",
      canChange: true,
      canGrantOwner: true,
      needsReassignment: false,
    };
    const request = vi.fn().mockImplementation(async (path: string, body?: unknown) => {
      if (body) throw new Error("Membership changed elsewhere");
      return { items: [member], total: 1, nextCursor: null, limit: 25 };
    });
    render(<TeamAdministration {...common(request)} bootstrap={bootstrap} onChanged={vi.fn()} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Change membership for Synthetic member" }),
    );
    fireEvent.change(screen.getByLabelText("Reason for membership change"), {
      target: { value: "Explicit ownership transfer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save membership change" }));
    await screen.findByText("Membership changed elsewhere");
    expect(screen.getByLabelText("Reason for membership change")).toHaveValue(
      "Explicit ownership transfer",
    );
    expect(request.mock.calls.filter(([, body]) => body !== undefined)).toHaveLength(1);
    expect(request.mock.calls.find(([, body]) => body !== undefined)?.[1]).toMatchObject({
      expectedVersion: 3,
      identityId: owner,
    });
  });
  it("labels the once-only token as NOT SENT and keeps it out of list requests", async () => {
    const invitation: CplAdminInvitation = {
      id: "30000000-0000-4000-8000-000000000001",
      organizationId: org,
      recipientIdentityId: owner,
      recipientDisplayName: "Synthetic owner Alpha",
      role: "member",
      status: "pending",
      version: 1,
      createdAt: "2026-09-23T12:00:00Z",
      expiresAt: "2026-09-24T12:00:00Z",
      redeemedAt: null,
      revokedAt: null,
      invitedByIdentityId: operator,
      replacesId: null,
      canReissue: true,
      canRevoke: true,
    };
    const request = vi
      .fn()
      .mockImplementation(async (_path: string, body?: unknown) =>
        body
          ? { invitation, token, delivery: "not_sent" }
          : { items: [], total: 0, nextCursor: null, limit: 25 },
      );
    render(<TeamAdministration {...common(request)} bootstrap={bootstrap} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Invitations", exact: true }));
    fireEvent.change(await screen.findByLabelText("Verified invitation recipient"), {
      target: { value: owner },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create local handoff invitation" }));
    await screen.findByRole("heading", { name: "Invitation NOT SENT" });
    expect((screen.getByLabelText("Local handoff link") as HTMLTextAreaElement).value).toContain(
      "#cplInvite=",
    );
    expect(
      request.mock.calls
        .filter(([, body]) => body === undefined)
        .every(([path]) => !String(path).includes(token)),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Hide handoff token" }));
    expect(screen.queryByLabelText("Local handoff link")).not.toBeInTheDocument();
  });
});
