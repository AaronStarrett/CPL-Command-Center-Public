import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session-store", () => ({
  getAuthenticationProvider: vi.fn(async () => "local-owner"),
}));

import RecoverLocalOwnerPage from "../../apps/web/app/recover/page";

describe("Phase 1.3.4 Local Owner recovery page", () => {
  it("renders only the bounded Local Owner recovery fields and one-time rotation warning", async () => {
    const view = await RecoverLocalOwnerPage({ searchParams: Promise.resolve({}) });
    const { container } = render(view);

    expect(screen.getByRole("heading", { name: "Recover Local Owner access" })).toBeVisible();
    expect(screen.getByLabelText(/^Username/iu)).toHaveAttribute("maxlength", "64");
    expect(screen.getByLabelText(/^Current recovery code/iu)).toHaveAttribute("type", "password");
    expect(screen.getByLabelText(/^New passphrase/iu)).toHaveAttribute("minlength", "14");
    expect(screen.getByLabelText(/^Confirm new passphrase/iu)).toHaveAttribute("minlength", "14");
    expect(container.querySelector("form")).toHaveAttribute("action", "/api/auth/recover");
    expect(screen.getByText(/displays a replacement recovery code once/iu)).toBeVisible();
    expect(screen.queryByText(/demo persona/iu)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/email/iu)).not.toBeInTheDocument();
  });

  it("shows the same generic failure for every denied recovery", async () => {
    render(
      await RecoverLocalOwnerPage({
        searchParams: Promise.resolve({ status: "failed", detail: "must-not-render" }),
      }),
    );
    expect(screen.getByText(/Recovery could not be completed/iu)).toBeVisible();
    expect(screen.queryByText("must-not-render")).not.toBeInTheDocument();
  });
});
