import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApplicationPdfViewer } from "../../apps/web/components/application-pdf-viewer";

function pdfResponse(overrides: Partial<Response> = {}): Response {
  return {
    arrayBuffer: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]).buffer),
    headers: new Headers({ "Content-Length": "6", "Content-Type": "application/pdf" }),
    ok: true,
    status: 200,
    ...overrides,
  } as Response;
}

function pdfAdapter() {
  const renderCancel = vi.fn();
  const render = vi.fn(() => ({ cancel: renderCancel, promise: Promise.resolve() }));
  const pageCleanup = vi.fn();
  const getPage = vi.fn(async () => ({
    cleanup: pageCleanup,
    getViewport: ({ scale }: { scale: number }) => ({ height: 792 * scale, width: 612 * scale }),
    render,
  }));
  const documentCleanup = vi.fn(async () => undefined);
  const document = { cleanup: documentCleanup, getPage, numPages: 2 };
  const destroy = vi.fn(async () => undefined);
  const loadingTask = { destroy, destroyed: false, promise: Promise.resolve(document) };
  const getDocument = vi.fn(() => loadingTask);
  const loadPdfJs = vi.fn(async () => ({
    getDocument,
    GlobalWorkerOptions: { workerSrc: "test-worker" },
  }));
  return {
    destroy,
    documentCleanup,
    getDocument,
    getPage,
    loadPdfJs,
    pageCleanup,
    render,
    renderCancel,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("application PDF viewer", () => {
  it("fetches an authorized PDF and supports navigation, zoom, fit, and cleanup", async () => {
    const adapter = pdfAdapter();
    const fetchMock = vi.fn(async () => pdfResponse());
    vi.stubGlobal("fetch", fetchMock);

    const view = render(
      <ApplicationPdfViewer
        src="/api/artifacts/report/preview"
        title="Authorized report"
        downloadHref="/api/artifacts/report/download"
        loadPdfJs={adapter.loadPdfJs as never}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("application-pdf-viewer")).toHaveAttribute("data-state", "ready"),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/artifacts/report/preview",
      expect.objectContaining({
        credentials: "same-origin",
        headers: { Accept: "application/pdf" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(adapter.getDocument).toHaveBeenCalledWith({ data: expect.any(Uint8Array) });
    expect(screen.getByRole("img", { name: "Authorized report, page 1" })).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(adapter.getPage).toHaveBeenCalledWith(2));
    expect(screen.getByRole("img", { name: "Authorized report, page 2" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByRole("button", { name: "Fit to width" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: "Fit to width" }));
    expect(screen.getByRole("button", { name: "Fit to width" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("link", { name: "Download PDF" })).toHaveAttribute(
      "href",
      "/api/artifacts/report/download",
    );

    view.unmount();
    expect(adapter.renderCancel).toHaveBeenCalled();
    expect(adapter.documentCleanup).toHaveBeenCalled();
    expect(adapter.destroy).toHaveBeenCalled();
  });

  it("fails closed for a non-PDF response while preserving download", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        pdfResponse({
          headers: new Headers({ "Content-Type": "text/plain" }),
          ok: false,
          status: 404,
        }),
      ),
    );
    const adapter = pdfAdapter();

    render(
      <ApplicationPdfViewer
        src="/api/artifacts/missing/preview"
        title="Unavailable report"
        downloadHref="/api/artifacts/missing/download"
        loadPdfJs={adapter.loadPdfJs as never}
      />,
    );

    expect(await screen.findByText("PDF preview unavailable")).toBeInTheDocument();
    expect(screen.getByText(/could not be rendered/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download PDF" })).toHaveAttribute(
      "href",
      "/api/artifacts/missing/download",
    );
    expect(adapter.loadPdfJs).not.toHaveBeenCalled();
    expect(document.querySelector("iframe")).toBeNull();
  });
});
