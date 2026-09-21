import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import {
  Alert,
  Badge,
  Button,
  ConfirmationDialog,
  FormField,
  HealthIndicator,
  Input,
  Select,
} from "../../packages/ui/src/index";

describe("BEA UI primitives", () => {
  it("publishes the required semantic brand and accessibility tokens", () => {
    const css = readFileSync(resolve(process.cwd(), "packages/ui/src/styles.css"), "utf8");

    expect(css).toContain("--bea-brand-navy: #08304a");
    expect(css).toContain("--bea-brand-green: #4aa346");
    expect(css).toContain("--bea-action-green: #2f7d32");
    expect(css).toContain("--bea-focus: #1e78b4");
    for (const tone of ["success", "warning", "error", "info"]) {
      for (const variant of ["subtle", "border", "text"]) {
        expect(css).toContain(`--bea-${tone}-${variant}:`);
      }
    }
  });

  it("connects labels, hints, and form controls accessibly", () => {
    render(
      <FormField
        label="Project reference"
        htmlFor="project-reference"
        hint="Use the internal identifier."
      >
        <Input id="project-reference" name="projectReference" />
      </FormField>,
    );

    expect(screen.getByRole("textbox", { name: "Project reference" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Project reference" })).toHaveAccessibleDescription(
      "Use the internal identifier.",
    );
    expect(screen.getByText("Use the internal identifier.")).toBeVisible();
  });

  it("associates validation errors with invalid controls", () => {
    render(
      <FormField
        label="Project reference"
        htmlFor="invalid-project-reference"
        hint="Use the internal identifier."
        error="Project reference is required."
      >
        <Input id="invalid-project-reference" name="projectReference" />
      </FormField>,
    );

    const control = screen.getByRole("textbox", { name: "Project reference" });
    const error = screen.getByRole("alert");
    expect(control).toHaveAccessibleDescription(
      "Use the internal identifier. Project reference is required.",
    );
    expect(control).toHaveAttribute("aria-invalid", "true");
    expect(control).toHaveAttribute("aria-errormessage", error.id);
  });

  it("exposes busy and disabled button state", () => {
    render(<Button busy>Run check</Button>);
    expect(screen.getByRole("button", { name: "Run check" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Run check" })).toHaveAttribute("aria-busy", "true");
  });

  it("renders semantic status language without relying on color alone", () => {
    render(
      <div>
        <Badge tone="warning">Deferred</Badge>
        <HealthIndicator label="Worker" state="unavailable" />
        <Alert tone="danger" title="Failure">
          No action was taken.
        </Alert>
      </div>,
    );

    expect(screen.getByText("Deferred")).toBeVisible();
    expect(screen.getByText("Worker")).toBeVisible();
    expect(screen.getByText("unavailable")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("No action was taken.");
  });

  it("supports labeled select controls", () => {
    render(
      <FormField label="Persona" htmlFor="persona">
        <Select id="persona" defaultValue="operations">
          <option value="operations">Operations</option>
        </Select>
      </FormField>,
    );
    expect(screen.getByRole("combobox", { name: "Persona" })).toHaveValue("operations");
  });

  it("requires confirmation before invoking the supplied action", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmationDialog
        open
        title="Run simulation?"
        description="No external service will be contacted."
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(onCancel).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
