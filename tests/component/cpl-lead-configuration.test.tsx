import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { LeadConfigurationFields } from "../../apps/web/app/workspace/lead-configuration";
import type { CplLeadConfiguration, CplIntakePolicy } from "@bea/domain/cpl-company";
const field = "10000000-0000-4000-8000-000000000001",
  item = "20000000-0000-4000-8000-000000000001";
const policy: CplIntakePolicy = {
  requiredFields: ["siteAddress"],
  customFields: [
    {
      id: field,
      label: "Fictional permit confirmed",
      type: "boolean",
      required: true,
      options: [],
      active: true,
    },
  ],
};
const configuration: CplLeadConfiguration = {
  catalog: null,
  customValues: { [field]: true },
  policyVersion: 1,
  reviewedPolicyVersion: 1,
  policy,
};
function props() {
  return {
    request: vi.fn().mockImplementation(async (path: string) =>
      path === "/api/cpl-company/intake-policy"
        ? { version: 2, input: policy }
        : {
            items: [
              {
                id: item,
                name: "Synthetic assessment",
                code: "ASSESS",
                revision: 3,
                currency: "USD",
                workflowKey: "FIXED-ASSESS",
              },
            ],
            total: 26,
            nextCursor: path.includes("cursor=") ? null : "opaque-next",
            hasMore: true,
            limit: 25,
          },
    ),
    configuration,
    onChange: vi.fn(),
    onService: vi.fn(),
    saved: true,
  };
}
describe("lead company configuration", () => {
  it("preserves explicit false and null instead of falling back to a saved true answer", async () => {
    const p = props();
    render(<LeadConfigurationFields {...p} />);
    const input = await screen.findByLabelText(/Fictional permit confirmed/);
    expect(input).toHaveValue("true");
    fireEvent.change(input, { target: { value: "false" } });
    expect(input).toHaveValue("false");
    expect(p.onChange).toHaveBeenLastCalledWith({ customValues: { [field]: false } });
    fireEvent.change(input, { target: { value: "" } });
    expect(input).toHaveValue("");
    expect(p.onChange).toHaveBeenLastCalledWith({ customValues: { [field]: null } });
  });
  it("sends only deliberate catalog ID and fixed service key, leaving trusted snapshot creation to the server", async () => {
    const p = props();
    render(<LeadConfigurationFields {...p} />);
    await screen.findByRole("option", { name: /ASSESS · Synthetic assessment/ });
    fireEvent.change(screen.getByLabelText("Catalog service"), { target: { value: item } });
    expect(p.onChange).toHaveBeenCalledWith({ catalogItemId: item });
    expect(p.onService).toHaveBeenCalledWith("FIXED-ASSESS");
    expect(p.onChange.mock.calls.some((c) => Object.hasOwn(c[0], "catalog"))).toBe(false);
  });
  it("marks a changed current policy for review without silently changing historical answers", async () => {
    const p = props();
    render(<LeadConfigurationFields {...p} />);
    await screen.findByText(/Current policy version 2/);
    expect(screen.getByText(/Review required before proposal readiness/)).toBeVisible();
    expect(screen.getByLabelText(/Fictional permit confirmed/)).toHaveValue("true");
    expect(p.onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(/Explicitly refresh this lead’s linked/));
    expect(p.onChange).toHaveBeenLastCalledWith({ refreshDirectory: true });
  });
  it("pages catalog service choices with the opaque cursor and restarts search at page one", async () => {
    const p = props();
    render(<LeadConfigurationFields {...p} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "More services" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "More services" }));
    await waitFor(() =>
      expect(p.request).toHaveBeenCalledWith(expect.stringContaining("cursor=opaque-next")),
    );
    fireEvent.change(screen.getByLabelText("Find catalog service"), { target: { value: "Roof" } });
    fireEvent.click(screen.getByRole("button", { name: "Find catalog service" }));
    await waitFor(() => expect(p.request).toHaveBeenCalledWith(expect.stringContaining("q=Roof")));
    const last = p.request.mock.calls.at(-1)![0];
    expect(last).not.toContain("cursor=");
  });
});
