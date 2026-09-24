import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicInquiryForm as Definition } from "@bea/domain/cpl-inbound";
import { PublicInquiryForm } from "../../apps/web/app/workspace/public-inquiry-form";
import InquiryPage from "../../apps/web/app/inquiry/[publicId]/page";

const formId = "fictional-alder-form",
  serviceId = "10000000-0000-4000-8000-000000000001";
function definition(publicId = formId): Definition {
  return {
    publicId,
    version: 4,
    title: "Fictional service inquiry",
    description: "Tell us about the requested work.",
    fields: [
      {
        key: "title",
        label: "Inquiry title",
        type: "text",
        required: true,
        maxLength: 240,
        options: [],
      },
      {
        key: "contact_email",
        label: "Contact email",
        type: "email",
        required: true,
        maxLength: 254,
        options: [],
      },
      {
        key: "access",
        label: "Has access been arranged?",
        type: "boolean",
        required: true,
        maxLength: null,
        options: [],
      },
    ],
    services: [
      { id: serviceId, name: "Fictional assessment", description: "A requested assessment." },
    ],
    confirmationText: "The company will review the received information.",
  };
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function datedDefinition(): Definition {
  return {
    ...definition(),
    fields: [
      ...definition().fields,
      ...[
        ["requested_deadline_at", "Requested deadline"],
        ["requested_visit_at", "Requested visit date"],
      ].map(([key, label]) => ({
        key: key!,
        label: label!,
        type: "date" as const,
        required: false,
        maxLength: 10,
        options: [],
      })),
    ],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
async function fill() {
  await screen.findByLabelText("Inquiry title (required)");
  fireEvent.change(screen.getByLabelText("Inquiry title (required)"), {
    target: { value: "Fictional inquiry" },
  });
  fireEvent.change(screen.getByLabelText("Contact email (required)"), {
    target: { value: "visitor@example.invalid" },
  });
  fireEvent.change(screen.getByLabelText("Has access been arranged? (required)"), {
    target: { value: "no" },
  });
  fireEvent.change(screen.getByLabelText("Requested service"), { target: { value: serviceId } });
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("anonymous published inquiry", () => {
  it.each(["development", "production"])(
    "derives the development marker only from explicit non-production server configuration (%s)",
    async (mode) => {
      vi.stubEnv("NODE_ENV", mode);
      vi.stubEnv("CPL_LOCAL_DEVELOPMENT_AUTH", "true");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(definition())));
      render(await InquiryPage({ params: Promise.resolve({ publicId: formId }) }));
      await screen.findByLabelText("Inquiry title (required)");
      if (mode === "development")
        expect(screen.getByText("DEVELOPMENT · Synthetic local inquiry")).toBeInTheDocument();
      else
        expect(screen.queryByText("DEVELOPMENT · Synthetic local inquiry")).not.toBeInTheDocument();
    },
  );
  it("keeps the development marker across loading, failure, retry and receipt success", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(definition()))
      .mockRejectedValueOnce(new Error("uncertain"))
      .mockResolvedValueOnce(
        json({ reference: "REC-FIXTURE", status: "accepted", processing: "queued" }),
      );
    vi.stubGlobal("fetch", fetcher);
    render(<PublicInquiryForm publicId={formId} development />);
    expect(screen.getByText("DEVELOPMENT · Synthetic local inquiry")).toBeInTheDocument();
    await fill();
    fireEvent.click(screen.getByRole("button", { name: "Submit inquiry" }));
    await screen.findByRole("alert");
    expect(screen.getByText("DEVELOPMENT · Synthetic local inquiry")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Submit inquiry" }));
    await screen.findByText("REC-FIXTURE");
    expect(screen.getByText("DEVELOPMENT · Synthetic local inquiry")).toBeInTheDocument();
  });
  it("submits only published answers, explicit version and one event ID without employee credentials", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          ...definition(),
          organizationId: "private-org",
          internalNotes: "PRIVATE_CANARY",
          price: 9000,
        }),
      )
      .mockResolvedValueOnce(
        json({
          reference: "REC-EXAMPLE-1",
          status: "accepted",
          processing: "queued",
          linkedLeadId: "never-display",
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    render(<PublicInquiryForm publicId={formId} />);
    await fill();
    fireEvent.click(screen.getByRole("button", { name: "Submit inquiry" }));
    await screen.findByText("REC-EXAMPLE-1");
    const [url, options] = fetcher.mock.calls[1];
    expect(url).toBe(`/api/cpl-inbound/forms/${formId}`);
    expect(options.credentials).toBe("omit");
    expect(options.headers).toEqual({ "content-type": "application/json" });
    const body = JSON.parse(options.body);
    expect(Object.keys(body).sort()).toEqual([
      "configurationVersion",
      "eventId",
      "serviceId",
      "values",
    ]);
    expect(body).toMatchObject({
      configurationVersion: 4,
      serviceId,
      values: {
        title: "Fictional inquiry",
        contact_email: "visitor@example.invalid",
        access: false,
      },
    });
    expect(body.eventId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(
      screen.queryByText(/PRIVATE_CANARY|private-org|never-display|9000/u),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/does not confirm a booking/u)).toBeInTheDocument();
  });
  it("retains answers and the exact event ID across an uncertain network retry", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(definition()))
      .mockRejectedValueOnce(new Error("SECRET_NETWORK_MESSAGE"))
      .mockResolvedValueOnce(
        json({ reference: "REC-EXAMPLE-2", status: "accepted", processing: "queued" }),
      );
    vi.stubGlobal("fetch", fetcher);
    render(<PublicInquiryForm publicId={formId} />);
    await fill();
    fireEvent.click(screen.getByRole("button", { name: "Submit inquiry" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Inquiry title (required)")).toHaveValue("Fictional inquiry");
    expect(screen.queryByText(/SECRET_NETWORK_MESSAGE/u)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Submit inquiry" }));
    await screen.findByText("REC-EXAMPLE-2");
    expect(fetcher.mock.calls[2][1].body).toBe(fetcher.mock.calls[1][1].body);
  });
  it("submits both native date input values unchanged after another answer causes a render", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(datedDefinition()))
      .mockResolvedValueOnce(
        json({ reference: "REC-DATES", status: "accepted", processing: "queued" }),
      );
    vi.stubGlobal("fetch", fetcher);
    render(<PublicInquiryForm publicId={formId} />);
    await fill();
    fireEvent.change(screen.getByLabelText("Requested deadline"), {
      target: { value: "2026-10-14" },
    });
    fireEvent.change(screen.getByLabelText("Requested visit date"), {
      target: { value: "2026-10-12" },
    });
    fireEvent.change(screen.getByLabelText("Inquiry title (required)"), {
      target: { value: "Fictional dated inquiry" },
    });
    expect(screen.getByLabelText("Requested deadline")).toHaveAttribute("type", "date");
    expect(screen.getByLabelText("Requested deadline")).toHaveValue("2026-10-14");
    expect(screen.getByLabelText("Requested visit date")).toHaveValue("2026-10-12");
    fireEvent.click(screen.getByRole("button", { name: "Submit inquiry" }));
    await screen.findByText("REC-DATES");
    expect(JSON.parse(fetcher.mock.calls[1][1].body).values).toMatchObject({
      title: "Fictional dated inquiry",
      requested_deadline_at: "2026-10-14",
      requested_visit_at: "2026-10-12",
    });
  });
  it("retains both dates and the same event payload when retrying uncertain acceptance", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(datedDefinition()))
      .mockRejectedValueOnce(new Error("uncertain"))
      .mockResolvedValueOnce(
        json({ reference: "REC-DATE-RETRY", status: "accepted", processing: "queued" }),
      );
    vi.stubGlobal("fetch", fetcher);
    render(<PublicInquiryForm publicId={formId} />);
    await fill();
    fireEvent.change(screen.getByLabelText("Requested deadline"), {
      target: { value: "2026-10-14" },
    });
    fireEvent.change(screen.getByLabelText("Requested visit date"), {
      target: { value: "2026-10-12" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit inquiry" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Requested deadline")).toHaveValue("2026-10-14");
    expect(screen.getByLabelText("Requested visit date")).toHaveValue("2026-10-12");
    fireEvent.click(screen.getByRole("button", { name: "Submit inquiry" }));
    await screen.findByText("REC-DATE-RETRY");
    expect(fetcher.mock.calls[2][1].body).toBe(fetcher.mock.calls[1][1].body);
    expect(JSON.parse(fetcher.mock.calls[2][1].body).values).toMatchObject({
      requested_deadline_at: "2026-10-14",
      requested_visit_at: "2026-10-12",
    });
  });
  it("does not manufacture a second event identity when answers change after uncertain acceptance", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(definition()))
      .mockRejectedValueOnce(new Error("uncertain"))
      .mockResolvedValueOnce(json({ code: "CPL_IDEMPOTENCY_CONFLICT" }, 409));
    vi.stubGlobal("fetch", fetcher);
    render(<PublicInquiryForm publicId={formId} />);
    await fill();
    fireEvent.click(screen.getByRole("button", { name: "Submit inquiry" }));
    await screen.findByRole("alert");
    fireEvent.change(screen.getByLabelText("Inquiry title (required)"), {
      target: { value: "Corrected fictional inquiry" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit inquiry" }));
    await screen.findByText(/conflicts with an earlier attempt/u);
    expect(JSON.parse(fetcher.mock.calls[1][1].body).eventId).toBe(
      JSON.parse(fetcher.mock.calls[2][1].body).eventId,
    );
    expect(screen.getByLabelText("Inquiry title (required)")).toHaveValue(
      "Corrected fictional inquiry",
    );
  });
  it("shows safe rate-limit guidance and correlation reference without server error details", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(definition()))
      .mockResolvedValueOnce(
        json(
          { correlationId: "00000000-0000-4000-8000-000000000000", message: "SQL_PASSWORD_CANARY" },
          429,
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    render(<PublicInquiryForm publicId={formId} />);
    await fill();
    fireEvent.click(screen.getByRole("button", { name: "Submit inquiry" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("too many requests");
    expect(screen.getByRole("alert")).toHaveTextContent("00000000-0000-4000-8000-000000000000");
    expect(screen.queryByText(/SQL_PASSWORD_CANARY/u)).not.toBeInTheDocument();
  });
  it("ignores late metadata for a different form and never carries answers between forms", async () => {
    const old = deferred<Response>();
    const fetcher = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(json({ ...definition("harbor"), title: "Harbor inquiry" }));
    vi.stubGlobal("fetch", fetcher);
    const view = render(<PublicInquiryForm publicId="alder" />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    view.rerender(<PublicInquiryForm publicId="harbor" />);
    await screen.findByRole("heading", { name: "Harbor inquiry" });
    await act(async () =>
      old.resolve(json({ ...definition("alder"), title: "Stale Alder inquiry" })),
    );
    expect(screen.queryByRole("heading", { name: "Stale Alder inquiry" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Inquiry title (required)")).toHaveValue("");
  });
  it("renders hostile published text as text without activating markup or remote images", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          ...definition(),
          description: '<img src="https://untrusted.invalid/tracker" onerror="alert(1)">',
        }),
      ),
    );
    const { container } = render(<PublicInquiryForm publicId={formId} />);
    await screen.findByText(/onerror=/u);
    expect(container.querySelector("img, script, iframe")).toBeNull();
  });
  it("does not show a submission form when the published endpoint refuses a disabled source", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ code: "CPL_FORM_UNAVAILABLE" }, 404)));
    render(<PublicInquiryForm publicId={formId} />);
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Submit inquiry" })).not.toBeInTheDocument();
  });
  it("blocks a second click while acceptance is pending", async () => {
    const pending = deferred<Response>(),
      fetcher = vi
        .fn()
        .mockResolvedValueOnce(json(definition()))
        .mockReturnValueOnce(pending.promise);
    vi.stubGlobal("fetch", fetcher);
    render(<PublicInquiryForm publicId={formId} />);
    await fill();
    fireEvent.click(screen.getByRole("button", { name: "Submit inquiry" }));
    expect(screen.getByRole("button", { name: "Submitting…" })).toBeDisabled();
    expect(screen.getByLabelText("Inquiry title (required)")).toBeDisabled();
    await act(async () =>
      pending.resolve(
        json({ reference: "REC-EXAMPLE-3", status: "accepted", processing: "queued" }),
      ),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
