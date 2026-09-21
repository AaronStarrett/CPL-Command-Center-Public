import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskCreateForm } from "../../apps/web/components/task-create-form";

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("dependent task company and contact fields", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("loads only contacts for the selected company and clears an incompatible selection", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          companyId: "company-a",
          contacts: [{ id: "contact-a", label: "Morgan Demo" }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ companyId: "company-b", contacts: [] }));

    render(
      <TaskCreateForm
        companies={[
          { id: "company-a", label: "Northstar Facade Group" },
          { id: "company-b", label: "Harborview Property Partners" },
        ]}
        contactsEnabled
      />,
    );

    const company = screen.getByLabelText("Company");
    const contact = screen.getByLabelText("Contact") as HTMLSelectElement;
    const contactRegion = screen.getByTestId("task-contact-region");
    expect(contactRegion).toHaveAttribute("data-contact-state", "idle");
    expect(within(contactRegion).getByRole("status")).toHaveTextContent(
      "Select a company to load its contacts.",
    );
    expect(contact).toBeDisabled();
    expect(contact).toHaveDisplayValue("Select a company first");
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(company, { target: { value: "company-a" } });
    expect(contactRegion).toHaveAttribute("data-contact-state", "loading");
    expect(within(contactRegion).getByRole("status")).toHaveTextContent(
      "Loading contacts for the selected company.",
    );
    await waitFor(() => expect(contact).toBeEnabled());
    expect(contactRegion).toHaveAttribute("data-contact-state", "ready");
    expect(within(contactRegion).getByRole("status")).toHaveTextContent("1 contact available.");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/companies/company-a/contacts",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
    expect(contact).toHaveDisplayValue("No linked contact");
    fireEvent.change(contact, { target: { value: "contact-a" } });
    expect(contact.value).toBe("contact-a");

    fireEvent.change(company, { target: { value: "company-b" } });
    expect(contactRegion).toHaveAttribute("data-contact-state", "loading");
    expect(contact.value).toBe("");
    expect(contact).toBeDisabled();
    await waitFor(() =>
      expect(contact).toHaveDisplayValue("No contacts available for this company"),
    );
    expect(contactRegion).toHaveAttribute("data-contact-state", "empty");
    expect(within(contactRegion).getByRole("status")).toHaveTextContent(
      "No contacts are available for this company.",
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/companies/company-b/contacts",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("uses an explicit reduced-aware contact state transition contract", () => {
    const css = readFileSync(resolve(process.cwd(), "apps/web/app/globals.css"), "utf8");
    expect(css).toMatch(
      /\.bea-task-contact-region\[data-contact-state="loading"\] \.bea-select[\s\S]*?opacity:\s*0\.66/u,
    );
    expect(css).toMatch(
      /\.bea-task-contact-status[\s\S]*?animation:\s*bea-list-enter var\(--bea-motion-panel-duration\)/u,
    );
    expect(css).toMatch(
      /:root\[data-motion-profile="reduced"\][\s\S]*?transition-duration:\s*0\.01ms !important/u,
    );
  });

  it("renders a server relationship rejection on the contact field without navigating", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          companyId: "company-a",
          contacts: [{ id: "contact-a", label: "Morgan Demo" }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: "invalid-contact",
              field: "contactId",
              message: "The linked contact no longer matches the selected company.",
            },
          },
          400,
        ),
      );
    render(
      <TaskCreateForm
        companies={[{ id: "company-a", label: "Northstar Facade Group" }]}
        contactsEnabled
      />,
    );

    fireEvent.change(screen.getByLabelText("Company"), { target: { value: "company-a" } });
    const contact = screen.getByLabelText("Contact") as HTMLSelectElement;
    await waitFor(() => expect(contact).toBeEnabled());
    fireEvent.change(contact, { target: { value: "contact-a" } });
    fireEvent.change(screen.getByLabelText(/Title/u), { target: { value: "Scoped task" } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));

    await screen.findByText("The linked contact no longer matches the selected company.");
    expect(contact).toHaveAttribute("aria-invalid", "true");
    const request = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      companyId: string;
      contactId: string;
    };
    expect(request).toMatchObject({ companyId: "company-a", contactId: "contact-a" });
  });
});
