import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CplDeliveryWorkspace,
  CplDeliveryPackage,
  CplDeliveryInput,
} from "@bea/domain/cpl-delivery";
import type { CommercialRequest } from "../../apps/web/app/workspace/commercial-ui";
import { DeliveryWorkspace } from "../../apps/web/app/workspace/delivery-workspace";

const org = "10000000-0000-4000-8000-000000000035",
  projectId = "20000000-0000-4000-8000-000000000035",
  reportId = "30000000-0000-4000-8000-000000000035",
  packageId = "40000000-0000-4000-8000-000000000035",
  member = "50000000-0000-4000-8000-000000000035";
const base = `/api/cpl-delivery/projects/${projectId}`,
  path = `${base}/packages/${packageId}`,
  now = "2026-09-23T12:00:00.000Z";
function fixtures(): CplDeliveryWorkspace {
  const attachment = {
    reportId,
    version: 4,
    reference: "RPT-FICTIONAL",
    title: "Fictional approved survey",
    sha256: "a".repeat(64),
    byteLength: 456,
    approvedAt: now,
  };
  const input: CplDeliveryInput = {
    customerName: "Fictional school",
    contactName: "Synthetic contact",
    recipient: "review@example.invalid",
    subject: "Reviewed site report",
    message: "Please review the attached approved findings.",
    attachments: [{ reportId, version: 4 }],
  };
  const pkg: CplDeliveryPackage = {
    id: packageId,
    projectId,
    reference: "DEL-FICTIONAL",
    revision: 2,
    currentVersion: 1,
    state: "draft",
    versions: [
      {
        version: 1,
        input,
        attachments: [attachment],
        preparedByIdentityId: member,
        preparedAt: now,
        state: "draft",
      },
    ],
    events: [],
    readiness: { ready: false, canMarkReady: true, reasons: [] },
  };
  return {
    project: {
      id: projectId,
      reference: "PRJ-FICTIONAL",
      name: "Fictional school survey",
      customerName: input.customerName,
      serviceKey: "Site assessment",
      contactName: input.contactName,
      contactEmail: input.recipient,
    },
    approvedReports: [
      { ...attachment, withdrawn: false, withdrawalReason: null, latestEditableVersion: 6 },
    ],
    packages: [pkg],
    policies: [],
    readiness: {
      status: "not_configured",
      policy: null,
      projectStatus: "active",
      operationalCompletion: false,
      deliveryRecorded: false,
      agreedAmount: {
        label: "Agreed amount",
        amountMinor: 12345,
        currency: "USD",
        proposalReference: "Q-FICTIONAL",
        proposalVersion: 3,
      },
      checks: [
        {
          key: "work",
          required: false,
          met: false,
          message: "One visit remains open",
          evidenceHash: "b".repeat(64),
          override: null,
        },
      ],
      issues: [],
      facts: {
        revision: 0,
        purchaseOrder: "",
        requiredReport: null,
        issueDispositions: [],
        manualIssues: [],
      },
      evaluatedAt: now,
      invoiceIssued: "not_tracked",
      paymentReceived: "not_tracked",
    },
    permissions: {
      canWrite: true,
      canConfirm: true,
      canConfigure: true,
      canOverride: true,
      canWithdrawApproval: true,
    },
  };
}
describe("approved delivery and live readiness UI", () => {
  let data: CplDeliveryWorkspace, handler: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    data = fixtures();
    handler = vi.fn(async (url: string, body?: Record<string, unknown>) => {
      if (url === base) return structuredClone(data);
      if (url === path) return structuredClone(data.packages[0]);
      if (body && (url === `${base}/packages` || url.startsWith(path))) {
        const pkg = data.packages[0]!;
        if (body.input && typeof body.input === "object" && "subject" in body.input) {
          pkg.currentVersion++;
          pkg.versions.push({
            ...structuredClone(pkg.versions[0]!),
            version: pkg.currentVersion,
            input: structuredClone(body.input as CplDeliveryInput),
            state: "draft",
          });
          pkg.state = "draft";
        }
        if (url.endsWith("/ready")) {
          pkg.state = "ready";
          pkg.readiness = { ready: true, canMarkReady: false, reasons: [] };
        }
        if (url.endsWith("/export")) pkg.state = "exported";
        if (url.endsWith("/record-sent")) pkg.state = "manually_sent";
        if (url.endsWith("/acknowledge")) pkg.state = "acknowledged";
        pkg.revision++;
        return structuredClone(pkg);
      }
      if (body) return structuredClone(data);
      throw new Error(`Unexpected ${url}`);
    });
  });
  function mount(initial = true) {
    const onDirty = vi.fn(),
      onOpenReport = vi.fn();
    render(
      <DeliveryWorkspace
        projectId={projectId}
        organizationId={org}
        request={handler as CommercialRequest}
        members={[{ identityId: member, displayName: "Synthetic Coordinator" }]}
        onDirty={onDirty}
        onBusy={vi.fn()}
        onOpenReport={onOpenReport}
        {...(initial ? { initialPackageId: packageId } : {})}
      />,
    );
    return { onDirty, onOpenReport };
  }
  it("selects approved version4 while clearly separating current editable version6", async () => {
    mount();
    await screen.findByLabelText("Customer subject");
    expect(screen.getByText(/Current editable report is version 6/)).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: /RPT-FICTIONAL · approved version 4/ }),
    ).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: /approved version 6/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Customer package preview" }));
    const download = await screen.findByRole("link", {
      name: "Download RPT-FICTIONAL PDF version 4",
    });
    expect(download).toHaveAttribute(
      "href",
      `${path}/attachments/${reportId}?version=1&reportVersion=4&organization=${org}`,
    );
    expect(screen.getByText(`SHA-256 ${"a".repeat(64)}`)).toBeInTheDocument();
    expect(handler.mock.calls.every(([, body]) => body === undefined)).toBe(true);
  });
  it("shows saved preparation and recording identities only in internal history", async () => {
    const formerMember = "60000000-0000-4000-8000-000000000035";
    const pkg = data.packages[0]!;
    pkg.currentVersion = 2;
    pkg.state = "manually_sent";
    pkg.versions.push({
      ...structuredClone(pkg.versions[0]!),
      version: 2,
      preparedByIdentityId: formerMember,
      state: "manually_sent",
    });
    pkg.events = [
      {
        id: "70000000-0000-4000-8000-000000000035",
        version: 1,
        action: "exported",
        actorIdentityId: formerMember,
        createdAt: now,
        details: { reason: "" },
      },
      {
        id: "80000000-0000-4000-8000-000000000035",
        version: 2,
        action: "manually_sent",
        actorIdentityId: member,
        createdAt: "2026-09-23T12:02:00.000Z",
        details: { sentAt: now, channel: "Fictional external handoff", reason: "   " },
      },
    ];
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Package history" }));
    expect(screen.getByText("Prepared by: Synthetic Coordinator")).toBeInTheDocument();
    expect(screen.getByText(`Prepared by: Identity ${formerMember}`)).toBeInTheDocument();
    expect(screen.getByText("Recorded by: Synthetic Coordinator")).toBeInTheDocument();
    expect(screen.getByText(`Recorded by: Identity ${formerMember}`)).toBeInTheDocument();
    const statedTime = screen.getByText(/Stated send time:/).querySelector("time");
    expect(statedTime).toHaveAttribute("dateTime", now);
    expect(statedTime).toHaveTextContent(new Date(now).toLocaleString());
    expect(screen.queryByText(/^Reason:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/sent At:/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Customer package preview" }));
    expect(
      await screen.findByRole("region", { name: "Customer delivery package preview" }),
    ).not.toHaveTextContent("Synthetic Coordinator");
    expect(screen.queryByText(new RegExp(formerMember))).not.toBeInTheDocument();
    expect(screen.queryByText(/Prepared by:|Recorded by:/)).not.toBeInTheDocument();
    expect(handler.mock.calls.every(([, body]) => body === undefined)).toBe(true);
  });
  it("requires recipient review and never treats an edit as ready", async () => {
    mount();
    await screen.findByLabelText("Customer subject");
    const mark = screen.getByRole("button", { name: "Mark saved package ready" });
    expect(mark).toBeDisabled();
    fireEvent.click(
      screen.getByLabelText(
        "I reviewed the saved recipient, message and exact approved attachments.",
      ),
    );
    expect(mark).toBeEnabled();
    fireEvent.change(screen.getByLabelText(/^Intended recipient/), {
      target: { value: "other@example.invalid" },
    });
    expect(mark).toBeDisabled();
    expect(
      screen.getByLabelText(
        "I reviewed the saved recipient, message and exact approved attachments.",
      ),
    ).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Save draft package version" }));
    await waitFor(() =>
      expect(handler).toHaveBeenCalledWith(
        `${path}/save`,
        expect.objectContaining({
          expectedRevision: 2,
          input: expect.objectContaining({
            recipient: "other@example.invalid",
            attachments: [{ reportId, version: 4 }],
          }),
          idempotencyKey: expect.any(String),
        }),
      ),
    );
    expect(handler.mock.calls.some(([url]) => url === `${path}/ready`)).toBe(false);
  });
  it("preserves entered content and idempotency key when readback fails after save", async () => {
    let saved = false,
      fail = true;
    handler.mockImplementation(async (url: string, body?: unknown) => {
      if (url === base) {
        if (saved && fail) {
          fail = false;
          throw new Error("Saved readback unavailable");
        }
        return structuredClone(data);
      }
      if (url === path) return structuredClone(data.packages[0]);
      if (url === `${path}/save` && body) {
        saved = true;
        return structuredClone(data.packages[0]);
      }
      throw new Error("unexpected");
    });
    mount();
    await screen.findByLabelText("Customer message");
    fireEvent.change(screen.getByLabelText("Customer message"), {
      target: { value: "Keep the human-written text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft package version" }));
    await screen.findByText("Saved readback unavailable");
    expect(screen.getByLabelText("Customer message")).toHaveValue("Keep the human-written text");
    fireEvent.click(screen.getByRole("button", { name: "Save draft package version" }));
    await screen.findByText(/Delivery package version saved/);
    const calls = handler.mock.calls.filter(([url]) => url === `${path}/save`);
    expect(calls).toHaveLength(2);
    expect(calls[0]![1]).toEqual(calls[1]![1]);
  });
  it("guards unsaved customer text and retains it when navigation is cancelled", async () => {
    mount();
    await screen.findByLabelText("Customer message");
    fireEvent.change(screen.getByLabelText("Customer message"), {
      target: { value: "Retain this draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Closeout & invoice readiness" }));
    fireEvent.click(await screen.findByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Customer message")).toHaveValue("Retain this draft");
  });
  it("marks readiness only through the explicit saved-version confirmation POST", async () => {
    mount();
    await screen.findByLabelText("Customer subject");
    fireEvent.click(
      screen.getByLabelText(
        "I reviewed the saved recipient, message and exact approved attachments.",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark saved package ready" }));
    await waitFor(() =>
      expect(handler).toHaveBeenCalledWith(`${path}/ready`, {
        recipientConfirmed: true,
        expectedRevision: 2,
        idempotencyKey: expect.any(String),
      }),
    );
    expect(
      await screen.findByText("Saved package marked ready. It has not been sent."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Download saved manifest/ })).not.toBeInTheDocument();
  });
  it("records export separately and enables only exact saved package download links", async () => {
    data.packages[0]!.state = "ready";
    data.packages[0]!.readiness = { ready: true, canMarkReady: false, reasons: [] };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Record package export" }));
    await waitFor(() =>
      expect(handler).toHaveBeenCalledWith(`${path}/export`, {
        expectedRevision: 2,
        idempotencyKey: expect.any(String),
      }),
    );
    expect(await screen.findByRole("link", { name: "Download saved manifest v1" })).toHaveAttribute(
      "href",
      `${path}/manifest?version=1&organization=${org}`,
    );
    expect(handler.mock.calls.some(([url]) => String(url).endsWith("record-sent"))).toBe(false);
  });
  it("requires an actual manual send record and protects its unsaved evidence", async () => {
    data.packages[0]!.state = "ready";
    data.packages[0]!.readiness = { ready: true, canMarkReady: false, reasons: [] };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Record a manual send" }));
    fireEvent.change(screen.getByLabelText("Channel used"), {
      target: { value: "Existing email client" },
    });
    fireEvent.change(screen.getByLabelText("Send note (optional)"), {
      target: { value: "Fictional owner acceptance exercise" },
    });
    expect(screen.getByRole("button", { name: "Record manually sent" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Package history" }));
    fireEvent.click(await screen.findByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Send note (optional)")).toHaveValue(
      "Fictional owner acceptance exercise",
    );
    expect(handler.mock.calls.some(([, body]) => Boolean(body))).toBe(false);
  });
  it("requires explicit reason for revising a previously sent package", async () => {
    data.packages[0]!.state = "manually_sent";
    mount();
    await screen.findByLabelText("Customer message");
    fireEvent.change(screen.getByLabelText("Customer subject"), {
      target: { value: "Revised message" },
    });
    expect(screen.getByRole("button", { name: "Create revised draft package" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/^Reason for a new package revision/), {
      target: { value: "Clarify the customer handoff" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create revised draft package" }));
    await waitFor(() =>
      expect(handler).toHaveBeenCalledWith(
        `${path}/revise`,
        expect.objectContaining({
          expectedRevision: 2,
          reason: "Clarify the customer handoff",
          input: expect.objectContaining({ subject: "Revised message" }),
        }),
      ),
    );
    expect(handler.mock.calls.some(([url]) => url === `${path}/save`)).toBe(false);
  });
  it("shows no-policy state and agreed amount without inventing invoice or payment facts", async () => {
    mount();
    await screen.findByLabelText("Customer subject");
    fireEvent.click(screen.getByRole("button", { name: "Closeout & invoice readiness" }));
    expect(await screen.findByText("Readiness policy not configured")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Agreed amount: $123.45" })).toBeInTheDocument();
    expect(
      screen.getByText(/Invoice issued and payment received remain outside this phase/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download current billing handoff" })).toHaveAttribute(
      "href",
      `${base}/billing-handoff?organization=${org}`,
    );
    expect(screen.queryByText("Invoice paid")).not.toBeInTheDocument();
  });
  it("does not preselect billing requirements for an unconfigured company", async () => {
    mount();
    await screen.findByLabelText("Customer subject");
    fireEvent.click(screen.getByRole("button", { name: "Readiness policies" }));
    expect(screen.getByLabelText("Selected deliverable manually recorded sent")).not.toBeChecked();
    expect(screen.getByLabelText("Required work completed")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Save readiness policy version" })).toBeDisabled();
  });
  it("respects read-only package and confirmation permissions", async () => {
    data.permissions.canWrite = false;
    data.permissions.canConfirm = false;
    mount();
    expect(await screen.findByLabelText("Customer subject")).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Mark saved package ready" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New delivery package" })).toBeDisabled();
  });
  it("blocks reuse of historical ready status when the saved artifact is no longer eligible", async () => {
    data.packages[0]!.state = "ready";
    data.packages[0]!.readiness = {
      ready: false,
      canMarkReady: false,
      reasons: ["The selected report approval was withdrawn"],
    };
    mount();
    expect(await screen.findByRole("button", { name: "Record package export" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Record a manual send" })).toBeDisabled();
    expect(screen.getByText("The selected report approval was withdrawn")).toBeInTheDocument();
  });
  it("records an explicit exact-version approval withdrawal with reason and confirmation", async () => {
    mount();
    await screen.findByLabelText("Customer subject");
    fireEvent.click(screen.getByRole("button", { name: "Approved artifacts" }));
    fireEvent.change(screen.getByLabelText("Approval to withdraw"), {
      target: { value: `${reportId}:4` },
    });
    fireEvent.change(screen.getByLabelText("Approval withdrawal reason"), {
      target: { value: "Material evidence requires renewed review" },
    });
    expect(screen.getByRole("button", { name: "Record approval withdrawal" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/I intend to withdraw this exact version/));
    fireEvent.click(screen.getByRole("button", { name: "Record approval withdrawal" }));
    await waitFor(() =>
      expect(handler).toHaveBeenCalledWith(`${base}/reports/${reportId}/withdraw`, {
        version: 4,
        reason: "Material evidence requires renewed review",
        idempotencyKey: expect.any(String),
      }),
    );
  });
  it("records human send evidence with the saved recipient and separate event time", async () => {
    data.packages[0]!.state = "ready";
    data.packages[0]!.readiness = { ready: true, canMarkReady: false, reasons: [] };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Record a manual send" }));
    const actual = new Date(Date.now() - 60000);
    actual.setSeconds(0, 0);
    const pad = (value: number) => String(value).padStart(2, "0");
    const local = `${actual.getFullYear()}-${pad(actual.getMonth() + 1)}-${pad(actual.getDate())}T${pad(actual.getHours())}:${pad(actual.getMinutes())}`;
    fireEvent.change(screen.getByLabelText(/^Actual send date and time/), {
      target: { value: local },
    });
    fireEvent.change(screen.getByLabelText("Channel used"), {
      target: { value: "Fictional email exercise" },
    });
    fireEvent.change(screen.getByLabelText("External reference (optional)"), {
      target: { value: "Synthetic handoff log" },
    });
    fireEvent.click(
      screen.getByLabelText("I am recording an actual manual send of this exact package version."),
    );
    fireEvent.click(screen.getByRole("button", { name: "Record manually sent" }));
    await waitFor(() =>
      expect(handler).toHaveBeenCalledWith(`${path}/record-sent`, {
        expectedRevision: 2,
        idempotencyKey: expect.any(String),
        input: {
          sentAt: actual.toISOString(),
          channel: "Fictional email exercise",
          recipient: "review@example.invalid",
          reference: "Synthetic handoff log",
          note: "",
        },
      }),
    );
  });
  it("uses the operator's current local time only after a click and requires renewed confirmation", async () => {
    data.packages[0]!.state = "ready";
    data.packages[0]!.readiness = { ready: true, canMarkReady: false, reasons: [] };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Record a manual send" }));
    const date = screen.getByLabelText(/^Actual send date and time/) as HTMLInputElement;
    expect(date.value).toBe("");
    fireEvent.change(screen.getByLabelText("Channel used"), {
      target: { value: "Fictional email exercise" },
    });
    fireEvent.change(screen.getByLabelText("External reference (optional)"), {
      target: { value: "Retained reference" },
    });
    const confirmation = screen.getByLabelText(
      "I am recording an actual manual send of this exact package version.",
    );
    fireEvent.click(confirmation);
    const before = Date.now();
    fireEvent.click(screen.getByRole("button", { name: "Use current time" }));
    const entered = new Date(date.value);
    expect(entered.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(entered.getTime()).toBeLessThanOrEqual(Date.now());
    expect(date).toHaveAttribute("step", "1");
    expect(confirmation).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Record manually sent" })).toBeDisabled();
    expect(screen.getByLabelText("Channel used")).toHaveValue("Fictional email exercise");
    expect(screen.getByLabelText("External reference (optional)")).toHaveValue(
      "Retained reference",
    );
    expect(handler.mock.calls.some(([, body]) => Boolean(body))).toBe(false);
    fireEvent.click(confirmation);
    fireEvent.click(screen.getByRole("button", { name: "Record manually sent" }));
    await waitFor(() =>
      expect(handler).toHaveBeenCalledWith(`${path}/record-sent`, {
        expectedRevision: 2,
        idempotencyKey: expect.any(String),
        input: {
          sentAt: entered.toISOString(),
          channel: "Fictional email exercise",
          recipient: "review@example.invalid",
          reference: "Retained reference",
          note: "",
        },
      }),
    );
  });
  it("explains an incomplete date and refuses a future manual time without losing evidence", async () => {
    data.packages[0]!.state = "ready";
    data.packages[0]!.readiness = { ready: true, canMarkReady: false, reasons: [] };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Record a manual send" }));
    fireEvent.change(screen.getByLabelText("Send note (optional)"), {
      target: { value: "Keep this human evidence" },
    });
    const confirmation = screen.getByLabelText(
      "I am recording an actual manual send of this exact package version.",
    );
    fireEvent.click(confirmation);
    const form = screen.getByRole("button", { name: "Record manually sent" }).closest("form")!;
    // Invoke the handler independently of native constraint validation to cover its guard.
    fireEvent.submit(form);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter a complete event date and time, or choose Use current time.",
    );
    const future = new Date(Date.now() + 86400000);
    const pad = (value: number) => String(value).padStart(2, "0");
    fireEvent.change(screen.getByLabelText(/^Actual send date and time/), {
      target: {
        value: `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T${pad(future.getHours())}:${pad(future.getMinutes())}`,
      },
    });
    expect(confirmation).not.toBeChecked();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(confirmation);
    fireEvent.submit(form);
    expect(await screen.findByRole("alert")).toHaveTextContent("Use the actual past event time.");
    expect(screen.getByLabelText("Send note (optional)")).toHaveValue("Keep this human evidence");
    expect(handler.mock.calls.some(([, body]) => Boolean(body))).toBe(false);
  });
});
