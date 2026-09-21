import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApplicationPdfViewer } from "../../apps/web/components/application-pdf-viewer";

function pdfResponse(): Response {
  return {
    arrayBuffer: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]).buffer),
    headers: new Headers({ "Content-Length": "6", "Content-Type": "application/pdf" }),
    ok: true,
    status: 200,
  } as Response;
}

function pdfAdapter() {
  const render = vi.fn(() => ({ cancel: vi.fn(), promise: Promise.resolve() }));
  const document = {
    cleanup: vi.fn(async () => undefined),
    getPage: vi.fn(async () => ({
      cleanup: vi.fn(),
      getViewport: ({ scale }: { scale: number }) => ({
        height: 2_400 * scale,
        width: 612 * scale,
      }),
      render,
    })),
    numPages: 2,
  };
  const loadingTask = {
    destroy: vi.fn(async () => undefined),
    destroyed: false,
    promise: Promise.resolve(document),
  };
  return vi.fn(async () => ({
    getDocument: vi.fn(() => loadingTask),
    GlobalWorkerOptions: { workerSrc: "phase133-test-worker" },
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Phase 1.3.3 PDF scroll ownership", () => {
  it("restores position per document while a new document starts at the top", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => pdfResponse()),
    );
    const src = "/api/artifacts/phase133-report/preview";
    const first = render(
      <ApplicationPdfViewer
        src={src}
        title="Long authorized report"
        loadPdfJs={pdfAdapter() as never}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("application-pdf-viewer")).toHaveAttribute("data-state", "ready"),
    );

    const firstScroller = screen.getByTestId("workspace-pdf-scroller");
    expect(firstScroller).toHaveAttribute("data-scroll-owner", "pdf");
    expect(firstScroller).toHaveAttribute("tabindex", "0");
    expect(firstScroller).toHaveAccessibleName("Long authorized report PDF pages");
    firstScroller.scrollTop = 480;
    fireEvent.scroll(firstScroller);
    first.unmount();

    const restored = render(
      <ApplicationPdfViewer
        src={src}
        title="Long authorized report"
        loadPdfJs={pdfAdapter() as never}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("application-pdf-viewer")).toHaveAttribute("data-state", "ready"),
    );
    await waitFor(() => expect(screen.getByTestId("workspace-pdf-scroller").scrollTop).toBe(480));
    restored.unmount();

    render(
      <ApplicationPdfViewer
        src="/api/artifacts/phase133-new-report/preview"
        title="New authorized report"
        loadPdfJs={pdfAdapter() as never}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("application-pdf-viewer")).toHaveAttribute("data-state", "ready"),
    );
    expect(screen.getByTestId("workspace-pdf-scroller").scrollTop).toBe(0);
  });
});
