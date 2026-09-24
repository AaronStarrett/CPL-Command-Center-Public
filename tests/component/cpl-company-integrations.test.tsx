import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { normalizeCplInquiryForm, normalizeCplInboundMapping } from "@bea/domain/cpl-inbound";
import type {
  FormInput,
  InquiryForm,
  MappingVersion,
  SourceReceiptDetail,
} from "@bea/domain/cpl-inbound";
import type { IntegrationWorkspace, IntegrationConnection } from "@bea/domain/cpl-integrations";
import {
  CompanyIntakeForms,
  IntakeMappingEditor,
  IntakeMappingHistory,
} from "../../apps/web/app/workspace/company-intake-forms";
import { CompanyIntegrations } from "../../apps/web/app/workspace/company-integrations";

const id = "10000000-0000-4000-8000-000000000001",
  mappingId = "20000000-0000-4000-8000-000000000001",
  serviceId = "30000000-0000-4000-8000-000000000001";
function page<T>(items: T[]) {
  return { items, total: items.length, nextCursor: null, limit: 25 };
}
function mapping(): MappingVersion {
  return {
    id: mappingId,
    version: 1,
    createdAt: "2026-09-24T12:00:00Z",
    createdByIdentityId: id,
    input: {
      name: "Standard fictional form",
      sourceKind: "form",
      rules: ["title", "contactName", "contactEmail", "details"].map((field) => ({
        source: {
          kind: "form_field",
          key: field.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`),
        },
        target: {
          kind: "builtin",
          field: field as "title" | "contactName" | "contactEmail" | "details",
        },
        transform: "trim",
      })),
    },
  };
}
function savedForm(input?: FormInput): InquiryForm {
  return {
    id,
    publicId: "fictional-alder",
    revision: 1,
    generation: 1,
    enabled: false,
    configurationVersion: 1,
    input: input ?? {
      name: "Fictional intake",
      title: "Fictional inquiry",
      description: "",
      fields: [
        {
          key: "title",
          target: { kind: "builtin", field: "title" },
          label: "Inquiry title",
          type: "text",
          required: true,
          maxLength: 240,
          options: [],
        },
      ],
      publishedServiceIds: [],
      mappingId,
      mappingVersion: 1,
      confirmationText: "Received for review.",
    },
    configuredByIdentityId: id,
    configuredMembershipVersion: 1,
    signedSource: { enabled: false, keyId: null, generation: 1 },
  };
}
function common(request = vi.fn()) {
  return { request, onDirty: vi.fn(), onBusy: vi.fn() };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
function workspace(): IntegrationWorkspace {
  return {
    permissions: {
      canViewStatus: true,
      canConfigure: true,
      canAuthorize: true,
      canOperate: true,
      canReadSource: true,
      canReprocess: true,
    },
    connections: page([]),
    forms: page([]),
    mappings: [mapping()],
    counts: {
      queued: 0,
      processing: 0,
      needsReview: 0,
      linkedLead: 0,
      rejected: 0,
      failed: 0,
      blocked: 0,
    },
    runtime: { providerMode: "local_fixture", liveVerification: "deferred" },
  };
}
function connection(name = "Fictional mailbox"): IntegrationConnection {
  return {
    id,
    revision: 1,
    generation: 1,
    configurationVersion: 1,
    provider: "google-gmail",
    mode: "local_fixture",
    state: "authorization_required",
    displayName: name,
    account: null,
    grantedScopes: [],
    authorizedByIdentityId: null,
    authorizedMembershipVersion: null,
    configuration: { displayName: name, selection: null, mappingId: null, mappingVersion: null },
    coverage: "not_started",
    checkpoint: { historyId: null, pagePending: false },
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextEligibleAt: null,
    lastIssue: null,
    counts: { receipts: 0, linkedLeads: 0, needsReview: 0, failed: 0 },
  };
}
describe("company intake configuration", () => {
  it("reads an exact earlier immutable mapping version without changing the current mapping", async () => {
    const current = { ...mapping(), version: 3 };
    const request = vi.fn(async (path: string) => ({
      ...mapping(),
      version: Number(new URL(path, "http://localhost").searchParams.get("version")),
    }));
    render(<IntakeMappingHistory request={request} mapping={current} />);
    await screen.findByRole("heading", { name: /saved version 3/u });
    fireEvent.change(screen.getByLabelText("Saved version number"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "View saved mapping version" }));
    await screen.findByRole("heading", { name: /saved version 1/u });
    expect(request).toHaveBeenLastCalledWith(
      `/api/cpl-integrations/mappings/${mappingId}?version=1`,
    );
    expect(request.mock.calls.every((call) => call.length === 1)).toBe(true);
    expect(screen.queryByRole("button", { name: "Save mapping version" })).not.toBeInTheDocument();
    expect(current.version).toBe(3);
  });
  it("opens the exact Action Center connection and locks the editor during delayed detail load", async () => {
    const detail = deferred<IntegrationConnection>();
    const request = vi.fn(async (path: string) =>
      path.endsWith("/workspace")
        ? workspace()
        : path === `/api/cpl-integrations/connections/${id}`
          ? detail.promise
          : page([]),
    );
    render(
      <CompanyIntegrations
        {...common(request)}
        authorityKey="alder:owner:1"
        initialTarget={{ kind: "integration", id, nonce: 1 }}
        services={[]}
        customFields={[]}
        onOpenLead={vi.fn()}
        onAuthorize={vi.fn()}
      />,
    );
    await screen.findByText("Loading the selected connection…");
    expect(screen.queryByLabelText("Connection name")).not.toBeInTheDocument();
    await act(async () => detail.resolve(connection("Exact attention mailbox")));
    expect(await screen.findByLabelText("Connection name")).toHaveValue("Exact attention mailbox");
  });
  it("renders saved custom answers and downloads the original without changing historical evidence or recovery input", async () => {
    const receipt: SourceReceiptDetail = {
      id,
      reference: "INQ-FICTIONAL",
      revision: 1,
      sourceKind: "public_form",
      sourceId: id,
      providerAccountId: null,
      externalEventId: "fictional-event",
      receivedAt: "2026-09-24T12:00:00Z",
      providerAt: null,
      contentSha256: "a".repeat(64),
      state: "needs_review",
      mappingId,
      mappingVersion: 1,
      processingAttempts: 1,
      linkedLeadId: null,
      linkedLeadVersion: null,
      reviewRequired: true,
      lastIssue: null,
      original: {
        mediaType: "application/json",
        bytes: 42,
        sha256: "b".repeat(64),
        sourceClaims: {},
        plainText: "<script>untrusted fictional source</script>",
        safeEvidenceAvailable: true,
        attachments: [],
      },
      normalizations: [
        {
          version: 1,
          mappingId,
          mappingVersion: 1,
          fields: {
            title: "Fictional saved inquiry",
            customValues: {
              access: false,
              brief: "Fictional design brief",
              missing: null,
              retired: '<img src="https://untrusted.invalid/tracker" onerror="alert(1)">',
            },
          },
          issues: [],
          createdAt: "2026-09-24T12:00:01Z",
        },
        {
          version: 2,
          mappingId,
          mappingVersion: 1,
          fields: { customValues: {} },
          issues: [],
          createdAt: "2026-09-24T12:00:02Z",
        },
      ],
      attempts: [],
      permissions: {
        canReadEvidence: true,
        canRetry: true,
        canReprocess: false,
        canOpenLead: false,
      },
    };
    const savedEvidence = JSON.stringify(receipt);
    const request = vi.fn(async (path: string) =>
      path.endsWith("/workspace")
        ? workspace()
        : path === `/api/cpl-integrations/receipts/${id}`
          ? receipt
          : path.startsWith("/api/cpl-integrations/receipts?")
            ? page([receipt])
            : page([]),
    );
    const onDownloadEvidence = vi.fn().mockResolvedValue(undefined);
    render(
      <CompanyIntegrations
        {...common(request)}
        authorityKey="alder:owner:1"
        initialTarget={{ kind: "source_receipt", id, nonce: 1 }}
        services={[]}
        customFields={[{ id: "access", name: "Access arranged" }]}
        onOpenLead={vi.fn()}
        onAuthorize={vi.fn()}
        onDownloadEvidence={onDownloadEvidence}
      />,
    );
    fireEvent.change(await screen.findByLabelText("Recovery reason"), {
      target: { value: "Retained recovery explanation" },
    });
    const answers = within(screen.getByLabelText("Saved custom answers"));
    expect(answers.getByText("Access arranged (current label) ·")).toBeInTheDocument();
    expect(answers.getByText("access")).toBeInTheDocument();
    expect(answers.getByText("No")).toBeInTheDocument();
    expect(answers.getByText("Not supplied")).toBeInTheDocument();
    expect(answers.getByText("Fictional design brief")).toBeInTheDocument();
    expect(answers.getByText("retired")).toBeInTheDocument();
    expect(answers.getByText(/onerror=/u)).toBeInTheDocument();
    expect(screen.getByText("No custom answers recorded.")).toBeInTheDocument();
    expect(screen.queryByText("[object Object]")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Download original evidence" }));
    await waitFor(() =>
      expect(onDownloadEvidence).toHaveBeenCalledWith({
        receiptId: id,
        sha256: "b".repeat(64),
        bytes: 42,
      }),
    );
    expect(screen.getByLabelText("Recovery reason")).toHaveValue("Retained recovery explanation");
    expect(document.querySelector("script, img, iframe")).toBeNull();
    expect(screen.getByText(/not include attachment bytes/u)).toBeInTheDocument();
    expect(receipt.original.plainText).toBe("<script>untrusted fictional source</script>");
    expect(JSON.stringify(receipt)).toBe(savedEvidence);
  });
  it("creates a matching mapping from the edited questions without treating the form as saved", async () => {
    const request = vi.fn(async (path: string, body?: unknown) => {
      if (path === "/api/cpl-integrations/mappings")
        return {
          ...mapping(),
          input: normalizeCplInboundMapping((body as { input: unknown }).input),
        };
      return page([]);
    });
    const props = {
      ...common(request),
      forms: [],
      total: 0,
      mappings: [],
      services: [],
      customFields: [],
      canConfigure: true,
      onSaved: vi.fn(),
    };
    render(<CompanyIntakeForms {...props} />);
    fireEvent.change(screen.getByLabelText("Internal form name"), {
      target: { value: "Fictional service form" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add customer question" }));
    fireEvent.click(screen.getByRole("button", { name: "Create matching form mapping" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Mapping version")).toHaveValue(`${mappingId}:1`),
    );
    const body = request.mock.calls.find(
      ([path]) => path === "/api/cpl-integrations/mappings",
    )?.[1] as { input: MappingVersion["input"] };
    expect(body.input.rules).toHaveLength(5);
    expect(normalizeCplInboundMapping(body.input)).toEqual(body.input);
    expect(props.onDirty).toHaveBeenLastCalledWith(true);
    expect(props.onSaved).not.toHaveBeenCalled();
    expect(
      request.mock.calls.some(([path, body]) => path === "/api/cpl-integrations/forms" && body),
    ).toBe(false);
  });
  it("saves a real-normalizer-valid form using the matching default mapping and explicit catalog selection", async () => {
    const request = vi.fn(async (path: string, body?: unknown) => {
      if (path.startsWith("/api/cpl-company/catalog"))
        return page([{ id: serviceId, name: "Fictional assessment" }]);
      if (!body) return page([]);
      const edit = body as { input: unknown };
      return savedForm(normalizeCplInquiryForm(edit.input));
    });
    const props = {
      ...common(request),
      forms: [],
      total: 0,
      mappings: [mapping()],
      services: [],
      customFields: [],
      canConfigure: true,
      onSaved: vi.fn(),
    };
    render(<CompanyIntakeForms {...props} />);
    fireEvent.change(screen.getByLabelText("Internal form name"), {
      target: { value: "Fictional intake" },
    });
    fireEvent.change(screen.getByLabelText("Customer form title"), {
      target: { value: "Fictional customer inquiry" },
    });
    fireEvent.change(screen.getByLabelText("Mapping version"), {
      target: { value: `${mappingId}:1` },
    });
    fireEvent.click(await screen.findByLabelText("Fictional assessment"));
    fireEvent.click(screen.getByRole("button", { name: "Save form configuration" }));
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledOnce());
    const body = request.mock.calls.find(
      ([path, value]) => path === "/api/cpl-integrations/forms" && value,
    )?.[1] as { input: FormInput; expectedRevision: number; idempotencyKey: string };
    expect(body.expectedRevision).toBe(0);
    expect(body.idempotencyKey).toMatch(/^[a-f0-9-]{36}$/u);
    expect(body.input.publishedServiceIds).toEqual([serviceId]);
    expect(body.input.fields.map((field) => field.key)).toEqual([
      "title",
      "contact_name",
      "contact_email",
      "details",
    ]);
    expect(normalizeCplInquiryForm(body.input)).toEqual(body.input);
    expect(screen.getByText(/Saved configuration 1/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish form" })).toBeDisabled();
  });
  it("keeps unsaved fields when list navigation is cancelled", async () => {
    const request = vi.fn(async () => page([savedForm()]));
    render(
      <CompanyIntakeForms
        {...common(request)}
        forms={[savedForm()]}
        total={1}
        mappings={[mapping()]}
        services={[]}
        customFields={[]}
        canConfigure
        onSaved={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Fictional intake · Disabled/u })).toBeEnabled(),
    );
    fireEvent.change(screen.getByLabelText("Internal form name"), {
      target: { value: "Unsaved new form" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Fictional intake · Disabled/u }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Internal form name")).toHaveValue("Unsaved new form");
  });
  it("retains rejected form input and the same mutation key on retry", async () => {
    let attempts = 0;
    const request = vi.fn(async (_path: string, body?: unknown) => {
      if (!body) return page([]);
      attempts++;
      if (attempts === 1) throw new Error("The saved revision changed.");
      return savedForm((body as { input: FormInput }).input);
    });
    render(
      <CompanyIntakeForms
        {...common(request)}
        forms={[]}
        total={0}
        mappings={[mapping()]}
        services={[]}
        customFields={[]}
        canConfigure
        onSaved={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Internal form name"), {
      target: { value: "Retained form" },
    });
    fireEvent.change(screen.getByLabelText("Customer form title"), {
      target: { value: "Retained title" },
    });
    fireEvent.change(screen.getByLabelText("Mapping version"), {
      target: { value: `${mappingId}:1` },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save form configuration" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Internal form name")).toHaveValue("Retained form");
    fireEvent.click(screen.getByRole("button", { name: "Save form configuration" }));
    await screen.findByText(/Saved configuration 1/u);
    const writes = request.mock.calls.filter(([, body]) => Boolean(body));
    expect(writes[0]?.[1]).toEqual(writes[1]?.[1]);
  });
  it("requires a lifecycle reason and never publishes merely by saving a form", async () => {
    const request = vi.fn(async (_path: string, body?: unknown) =>
      body ? { ...savedForm(), revision: 2, enabled: true } : page([savedForm()]),
    );
    render(
      <CompanyIntakeForms
        {...common(request)}
        forms={[savedForm()]}
        total={1}
        mappings={[mapping()]}
        services={[]}
        customFields={[]}
        canConfigure
        onSaved={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Fictional intake · Disabled/u })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Fictional intake · Disabled/u }));
    expect(screen.getByRole("button", { name: "Publish form" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Lifecycle reason"), {
      target: { value: "Publish the fictional example only" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Publish form" }));
    await screen.findByRole("link", { name: "Open saved public inquiry form" });
    const call = request.mock.calls.find(([path, body]) => path.endsWith("/state") && body);
    expect(call?.[1]).toMatchObject({
      enabled: true,
      expectedRevision: 1,
      reason: "Publish the fictional example only",
    });
  });
  it("keeps one-time credential separate from URLs and uses its returned revision after explicit dismissal", async () => {
    const rotated = {
      ...savedForm(),
      revision: 2,
      signedSource: { enabled: true, keyId: "test-key", generation: 2 },
    };
    const request = vi.fn(async (path: string) =>
      path.endsWith("/credential")
        ? { form: rotated, credential: { keyId: "test-key", secret: "SYNTHETIC_SECRET_CANARY" } }
        : page([savedForm()]),
    );
    const onSaved = vi.fn();
    render(
      <CompanyIntakeForms
        {...common(request)}
        forms={[savedForm()]}
        total={1}
        mappings={[mapping()]}
        services={[]}
        customFields={[]}
        canConfigure
        onSaved={onSaved}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Fictional intake · Disabled/u })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Fictional intake · Disabled/u }));
    fireEvent.change(screen.getByLabelText("Lifecycle reason"), {
      target: { value: "Rotate fictional sender credential" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rotate signed source credential" }));
    const secret = await screen.findByLabelText("Source secret");
    expect(secret).toHaveAttribute("type", "password");
    expect(document.querySelector('a[href*="SYNTHETIC_SECRET_CANARY"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "I have stored it; hide credential" }));
    expect(onSaved).toHaveBeenLastCalledWith(rotated);
    expect(screen.queryByLabelText("Source secret")).not.toBeInTheDocument();
  });
  it("produces typed default mapping rules accepted by the actual domain normalizer", async () => {
    const request = vi.fn(async (_path: string, body: unknown) => ({
      ...mapping(),
      input: normalizeCplInboundMapping((body as { input: unknown }).input),
    }));
    const onSaved = vi.fn();
    render(
      <IntakeMappingEditor
        {...common(request)}
        value={null}
        customFields={[]}
        canConfigure
        onSaved={onSaved}
      />,
    );
    fireEvent.change(screen.getByLabelText("Mapping name"), {
      target: { value: "Fictional standard mapping" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save mapping version" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(onSaved.mock.calls[0]?.[0].input.rules).toEqual(mapping().input.rules);
  });
  it("previews a mapping without clearing unsaved edits or creating a source receipt", async () => {
    const request = vi.fn(async () => ({ fields: { title: "Fictional sample" }, issues: [] }));
    const dirty = vi.fn();
    render(
      <IntakeMappingEditor
        {...common(request)}
        onDirty={dirty}
        value={null}
        customFields={[]}
        canConfigure
        onSaved={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Mapping name"), {
      target: { value: "Unsaved mapping" },
    });
    fireEvent.change(screen.getByLabelText("Sample title"), {
      target: { value: "Fictional sample" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview mapping" }));
    expect(await screen.findByLabelText("Mapping preview")).toHaveTextContent("Fictional sample");
    expect(request.mock.calls[0]?.[0]).toBe("/api/cpl-integrations/mappings/preview");
    expect(dirty).toHaveBeenLastCalledWith(true);
  });
  it("ignores an unmounted company's late workspace result", async () => {
    const late = deferred<IntegrationWorkspace>();
    const request = vi
      .fn()
      .mockReturnValueOnce(late.promise)
      .mockImplementation(async (path: string) =>
        path.endsWith("/workspace") ? workspace() : page([]),
      );
    const props = {
      ...common(request),
      services: [],
      customFields: [],
      onOpenLead: vi.fn(),
      onAuthorize: vi.fn(),
    };
    const view = render(
      <CompanyIntegrations key="alder" {...props} authorityKey="alder:owner:1" />,
    );
    view.rerender(<CompanyIntegrations key="harbor" {...props} authorityKey="harbor:member:2" />);
    await screen.findByText(/Provider environment/u);
    await act(async () =>
      late.resolve({
        ...workspace(),
        connections: page([
          { id: "old", displayName: "PRIVATE_OLD_COMPANY", state: "active" } as never,
        ]),
      }),
    );
    expect(screen.queryByText(/PRIVATE_OLD_COMPANY/u)).not.toBeInTheDocument();
  });
  it("guards an unsaved mapping before changing integration sections", async () => {
    const request = vi.fn(async (path: string) =>
      path.endsWith("/workspace") ? workspace() : page([]),
    );
    render(
      <CompanyIntegrations
        {...common(request)}
        authorityKey="alder:owner:1"
        services={[]}
        customFields={[]}
        onOpenLead={vi.fn()}
        onAuthorize={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Mappings" }));
    fireEvent.change(screen.getByLabelText("Mapping name"), {
      target: { value: "Retained mapping" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Gmail connections" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Mapping name")).toHaveValue("Retained mapping");
  });
  it("loads a later connection page and does not navigate to authorization with an unsaved reason", async () => {
    const value = connection("Later fictional mailbox");
    const request = vi.fn(async (path: string) => {
      if (path.endsWith("/workspace")) return workspace();
      return path.includes("cursor=next")
        ? page([value])
        : { ...page([]), total: 26, nextCursor: "next" };
    });
    const onAuthorize = vi.fn();
    render(
      <CompanyIntegrations
        {...common(request)}
        authorityKey="alder:owner:1"
        services={[]}
        customFields={[]}
        onOpenLead={vi.fn()}
        onAuthorize={onAuthorize}
      />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    fireEvent.click(await screen.findByRole("button", { name: /Later fictional mailbox ·/u }));
    const authorize = screen.getByRole("button", { name: "Authorize controlled local fixture" });
    expect(authorize).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Operation reason"), {
      target: { value: "Unsaved operational reason" },
    });
    expect(authorize).toBeDisabled();
    expect(onAuthorize).not.toHaveBeenCalled();
  });
  it("offers source receipts without exposing configuration controls to a source-only reviewer", async () => {
    const status = workspace();
    status.permissions = {
      canViewStatus: false,
      canConfigure: false,
      canAuthorize: false,
      canOperate: false,
      canReadSource: true,
      canReprocess: false,
    };
    const request = vi.fn(async (path: string) =>
      path.endsWith("/workspace") ? status : page([]),
    );
    render(
      <CompanyIntegrations
        {...common(request)}
        authorityKey="alder:reviewer:1"
        services={[]}
        customFields={[]}
        onOpenLead={vi.fn()}
        onAuthorize={vi.fn()}
      />,
    );
    expect(await screen.findByRole("button", { name: "Source receipts" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Gmail connections" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Connection name")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        request.mock.calls.some(([path]) => path.startsWith("/api/cpl-integrations/receipts?")),
      ).toBe(true),
    );
  });
});
