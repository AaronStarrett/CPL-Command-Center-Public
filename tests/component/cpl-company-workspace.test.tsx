import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import type { CplAdminBootstrap } from "@bea/domain/cpl-admin";
import type {
  CplCompanyWorkspace,
  CplCompanyConfiguration,
  CplDirectoryDetail,
  CplCatalogItem,
} from "@bea/domain/cpl-company";
import { defaultCplCommercialBranding } from "@bea/domain/cpl-commercial";
import { CompanyWorkspace } from "../../apps/web/app/workspace/company-workspace";
import { CompanyDocuments } from "../../apps/web/app/workspace/company-documents";
import { CompanyDirectory, CompanyCatalog } from "../../apps/web/app/workspace/company-records";
const org = "10000000-0000-4000-8000-000000000001",
  id = "20000000-0000-4000-8000-000000000001";
const bootstrap: CplAdminBootstrap = {
  identity: { id: "owner", displayName: "Synthetic owner" },
  organizations: [
    { id: org, slug: "synthetic", displayName: "Synthetic company", status: "active" },
  ],
  selectedOrganizationId: org,
  membership: { role: "owner", version: 1 },
  platform: { canProvision: false, assurance: "none" },
  permissions: {
    canManageMembers: true,
    canGrantOwner: true,
    canConfigureCompany: true,
    canReadDirectory: true,
    canWriteDirectory: true,
    canReadIntegrations: false,
    canReadAudit: true,
  },
  roles: [],
  localRecipients: [],
  enabledModules: [],
};
function workspace(): CplCompanyWorkspace {
  return {
    organizationId: org,
    profile: {
      version: 0,
      input: {
        displayName: "Synthetic company",
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
  };
}
function config(): CplCompanyConfiguration {
  return {
    modules: { proposal: true, field: true, report: true, delivery: true },
    commercialBranding: defaultCplCommercialBranding(),
    reportBranding: null,
    closeoutPolicies: [],
    closeoutPoliciesTruncated: false,
  };
}
function page<T>(items: T[], nextCursor: string | null = null) {
  return { items, total: items.length, nextCursor, hasMore: !!nextCursor, limit: 25 };
}
function detail(): CplDirectoryDetail {
  return {
    id,
    organizationId: org,
    kind: "customer",
    revision: 1,
    status: "active",
    name: "Saved fictional customer",
    customerId: null,
    email: null,
    phone: "",
    address: "",
    createdAt: "2026-09-23T12:00:00Z",
    updatedAt: "2026-09-23T12:00:00Z",
    revisions: [],
    duplicateCandidates: [],
  };
}
function catalog(): CplCatalogItem {
  return {
    id,
    organizationId: org,
    revision: 1,
    status: "active",
    code: "SERVICE",
    name: "Saved service",
    description: "",
    unit: "service",
    unitPriceMinor: 50000,
    currency: "USD",
    workflowKey: "SERVICE",
    createdAt: "2026-09-23T12:00:00Z",
    updatedAt: "2026-09-23T12:00:00Z",
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
  return { promise, resolve };
}
describe("company editor persistence and navigation", () => {
  it("keeps submitted profile fields until refreshed DTO and editor revision commit together", async () => {
    const initial = workspace(),
      loaded = deferred<CplCompanyWorkspace>();
    let reads = 0;
    const request = vi
      .fn()
      .mockImplementation(async (path: string, input?: unknown) =>
        path === "/api/cpl-company/workspace"
          ? ++reads === 1
            ? initial
            : loaded.promise
          : { version: 1, input: (input as { input: unknown }).input },
      );
    render(<CompanyWorkspace {...common(request)} bootstrap={bootstrap} onChanged={vi.fn()} />);
    await screen.findByRole("heading", { name: "Company profile" });
    for (const [label, value] of [
      ["Legal business name", "Synthetic Company LLC"],
      ["Company email", "owner@example.invalid"],
      ["Company phone", "555-0100"],
      ["Business address", "10 Fictional Lane"],
      ["Company time zone", "America/New_York"],
    ])
      fireEvent.change(screen.getByLabelText(new RegExp("^" + label!)), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Save company profile" }));
    await waitFor(() => expect(reads).toBe(2));
    expect(screen.getByLabelText("Company email")).toHaveValue("owner@example.invalid");
    expect(screen.getByRole("button", { name: "Save company profile" })).toBeDisabled();
    const saved = {
      ...initial,
      profile: {
        version: 1,
        input: (
          request.mock.calls.find((c) => c[0] === "/api/cpl-company/profile")![1] as {
            input: CplCompanyWorkspace["profile"]["input"];
          }
        ).input,
      },
    };
    await act(async () => loaded.resolve(saved));
    expect(screen.getByText(/Profile version 1/)).toBeVisible();
    expect(screen.getByLabelText(/^Company time zone/)).toHaveValue("America/New_York");
    expect(screen.getByLabelText("Company email")).toHaveValue("owner@example.invalid");
    expect(screen.getByText("Saved company configuration is up to date.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Save company profile" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "/api/cpl-company/profile",
        expect.objectContaining({ expectedVersion: 1 }),
      ),
    );
  });
  it("keeps report branding through delayed readback then uses the saved revision on the next save", async () => {
    const initial = config(),
      loaded = deferred<CplCompanyConfiguration>();
    let reads = 0;
    const request = vi
      .fn()
      .mockImplementation(async (path: string, input?: unknown) =>
        path === "/api/cpl-company/configuration"
          ? ++reads === 1
            ? initial
            : loaded.promise
          : { ...(input as { input: object }).input, revision: 1 },
      );
    render(<CompanyDocuments {...common(request)} />);
    fireEvent.click(await screen.findByRole("button", { name: "report branding" }));
    fireEvent.change(screen.getByLabelText("Report business name"), {
      target: { value: "Synthetic Report Company" },
    });
    fireEvent.change(screen.getByLabelText("Report contact email"), {
      target: { value: "report@example.invalid" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save report company identity" }));
    await waitFor(() => expect(reads).toBe(2));
    expect(screen.getByLabelText("Report business name")).toHaveValue("Synthetic Report Company");
    expect(screen.getByRole("button", { name: "Save report company identity" })).toBeDisabled();
    const input = request.mock.calls.find((c) => c[0] === "/api/cpl-reports/branding")![1].input;
    await act(async () =>
      loaded.resolve({ ...initial, reportBranding: { ...input, revision: 1 } }),
    );
    expect(screen.getByLabelText("Report contact email")).toHaveValue("report@example.invalid");
    fireEvent.click(screen.getByRole("button", { name: "Save report company identity" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "/api/cpl-reports/branding",
        expect.objectContaining({ expectedRevision: 1 }),
      ),
    );
  });
  it("locks the directory form during an exact record read instead of discarding a new draft on arrival", async () => {
    const pending = deferred<CplDirectoryDetail>(),
      request = vi
        .fn()
        .mockImplementation((path: string) =>
          path.includes("?") ? Promise.resolve(page([detail()])) : pending.promise,
        );
    render(<CompanyDirectory {...common(request)} allowed />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Saved fictional customer · active/ }),
    );
    expect(screen.getByLabelText("Customer name")).toBeDisabled();
    expect(screen.getByRole("button", { name: "New customer" })).toBeDisabled();
    await act(async () => pending.resolve(detail()));
    expect(screen.getByLabelText("Customer name")).toHaveValue("Saved fictional customer");
    expect(screen.getByLabelText("Customer name")).toBeEnabled();
  });
  it("locks initial catalog detail until the linked record has loaded", async () => {
    const pending = deferred<CplCatalogItem>(),
      request = vi
        .fn()
        .mockImplementation((path: string) =>
          path.includes("?") ? Promise.resolve(page([])) : pending.promise,
        );
    render(<CompanyCatalog {...common(request)} allowed defaultCurrency="USD" initialId={id} />);
    expect(screen.getByLabelText("Catalog item name")).toBeDisabled();
    await act(async () => pending.resolve(catalog()));
    expect(screen.getByLabelText("Catalog item name")).toHaveValue("Saved service");
  });
  it("does not allow an archive action to discard unsaved catalog edits", async () => {
    const request = vi.fn().mockResolvedValue(page([catalog()]));
    render(<CompanyCatalog {...common(request)} allowed defaultCurrency="USD" />);
    fireEvent.click(await screen.findByRole("button", { name: /SERVICE · Saved service/ }));
    fireEvent.change(screen.getByLabelText("Catalog item name"), {
      target: { value: "Unsaved service name" },
    });
    expect(screen.getByRole("button", { name: "Archive catalog item" })).toBeDisabled();
    expect(screen.getByText(/Save or discard the item edits/)).toBeVisible();
    expect(request.mock.calls.every((c) => c[1] === undefined)).toBe(true);
  });
  it("holds pagination and other records while a directory mutation is pending", async () => {
    const pending = deferred<CplDirectoryDetail>(),
      request = vi
        .fn()
        .mockImplementation((path: string, input?: unknown) =>
          input ? pending.promise : Promise.resolve(page([detail()], "next-page")),
        );
    render(<CompanyDirectory {...common(request)} allowed />);
    await screen.findByRole("button", { name: /Saved fictional customer · active/ });
    fireEvent.change(screen.getByLabelText("Customer name"), {
      target: { value: "New fictional customer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save directory revision" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "New customer" })).toBeDisabled();
    await act(async () => pending.resolve(detail()));
  });
  it("opens the exact authorized catalog target from a company audit entry", async () => {
    const event = {
      id: "audit",
      organizationId: org,
      action: "catalog.updated",
      actorIdentityId: null,
      actorName: "Historical actor",
      summary: "Service revised",
      version: 1,
      createdAt: "2026-09-23T12:00:00Z",
      target: { kind: "catalog", id },
    };
    const request = vi
      .fn()
      .mockImplementation(async (path: string) =>
        path === "/api/cpl-company/workspace"
          ? workspace()
          : path.startsWith("/api/cpl-company/audit?")
            ? page([event])
            : path === `/api/cpl-company/catalog/${id}`
              ? catalog()
              : page([]),
      );
    render(<CompanyWorkspace {...common(request)} bootstrap={bootstrap} onChanged={vi.fn()} />);
    await screen.findByRole("heading", { name: "Company profile" });
    fireEvent.click(screen.getByRole("button", { name: "Activity", exact: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Open related record" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Catalog item name")).toHaveValue("Saved service"),
    );
    expect(request).toHaveBeenCalledWith(`/api/cpl-company/catalog/${id}`);
  });
});
