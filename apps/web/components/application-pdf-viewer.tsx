"use client";

import { Alert, Button } from "@bea/ui";
import { useEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";

import styles from "@/components/ai-command.module.css";

export interface ApplicationPdfViewerProps {
  readonly src: string;
  readonly title: string;
  readonly downloadHref?: string | null;
  readonly loadPdfJs?: () => Promise<
    Pick<typeof import("pdfjs-dist"), "getDocument" | "GlobalWorkerOptions">
  >;
}

type ViewerState = "loading" | "ready" | "failed";

const MIN_ZOOM = 50;
const MAX_ZOOM = 200;
const MAX_PDF_BYTES = 100 * 1024 * 1024;
const MAX_PDF_SCROLL_POSITIONS = 40;
const pdfScrollPositions = new Map<string, number>();

function rememberPdfScrollPosition(src: string, scrollTop: number): void {
  pdfScrollPositions.delete(src);
  pdfScrollPositions.set(src, Math.max(0, scrollTop));
  while (pdfScrollPositions.size > MAX_PDF_SCROLL_POSITIONS) {
    const oldest = pdfScrollPositions.keys().next().value;
    if (typeof oldest !== "string") break;
    pdfScrollPositions.delete(oldest);
  }
}

function safeFailure(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "";
  return "The authorized PDF could not be rendered. Download remains available.";
}

function ApplicationPdfViewerSession({
  src,
  title,
  downloadHref,
  loadPdfJs,
}: ApplicationPdfViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const scrollRestoreFrameRef = useRef<number | undefined>(undefined);
  const pendingScrollRestoreRef = useRef(pdfScrollPositions.get(src) ?? 0);
  const [viewerState, setViewerState] = useState<ViewerState>("loading");
  const [safeError, setSafeError] = useState("");
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState(100);
  const [fitWidth, setFitWidth] = useState(true);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [documentVersion, setDocumentVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    documentRef.current = null;

    void (async () => {
      try {
        const response = await fetch(src, {
          credentials: "same-origin",
          headers: { Accept: "application/pdf" },
          signal: controller.signal,
        });
        const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
        if (!response.ok || mediaType !== "application/pdf") {
          throw new Error("Authorized PDF response was unavailable.");
        }
        const length = Number(response.headers.get("content-length") ?? 0);
        if (Number.isFinite(length) && length > MAX_PDF_BYTES) {
          throw new Error("Authorized PDF exceeds the viewer limit.");
        }
        const data = await response.arrayBuffer();
        if (data.byteLength < 5 || data.byteLength > MAX_PDF_BYTES) {
          throw new Error("Authorized PDF payload is invalid.");
        }
        const pdfjs = await (loadPdfJs ? loadPdfJs() : import("pdfjs-dist"));
        if (!pdfjs.GlobalWorkerOptions.workerSrc) {
          pdfjs.GlobalWorkerOptions.workerSrc = new URL(
            "pdfjs-dist/build/pdf.worker.min.mjs",
            import.meta.url,
          ).toString();
        }
        const loadingTask = pdfjs.getDocument({
          data: new Uint8Array(data),
        });
        loadingTaskRef.current = loadingTask;
        const document = await loadingTask.promise;
        if (!active) {
          await loadingTask.destroy();
          return;
        }
        documentRef.current = document;
        setPageCount(document.numPages);
        setViewerState("ready");
        setDocumentVersion((current) => current + 1);
      } catch (error) {
        if (!active) return;
        const message = safeFailure(error);
        if (!message) return;
        setSafeError(message);
        setViewerState("failed");
      }
    })();

    return () => {
      active = false;
      controller.abort();
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
      const document = documentRef.current;
      documentRef.current = null;
      if (document) void document.cleanup();
      const loadingTask = loadingTaskRef.current;
      loadingTaskRef.current = null;
      if (loadingTask && !loadingTask.destroyed) void loadingTask.destroy();
    };
  }, [loadPdfJs, src]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || viewerState !== "ready") return;
    if (scrollRestoreFrameRef.current !== undefined) {
      window.cancelAnimationFrame(scrollRestoreFrameRef.current);
    }
    scrollRestoreFrameRef.current = window.requestAnimationFrame(() => {
      scrollRestoreFrameRef.current = undefined;
      scroller.scrollTop = pendingScrollRestoreRef.current;
    });
    return () => {
      if (scrollRestoreFrameRef.current !== undefined) {
        window.cancelAnimationFrame(scrollRestoreFrameRef.current);
        scrollRestoreFrameRef.current = undefined;
      }
    };
  }, [src, viewerState]);

  useEffect(
    () => () => {
      const scroller = scrollerRef.current;
      if (scroller) rememberPdfScrollPosition(src, scroller.scrollTop);
    },
    [src],
  );

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setLayoutVersion((current) => current + 1));
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const document = documentRef.current;
    const canvas = canvasRef.current;
    const scroller = scrollerRef.current;
    if (!document || !canvas || !scroller || viewerState !== "ready") return;
    let active = true;
    let pageProxy: Awaited<ReturnType<PDFDocumentProxy["getPage"]>> | null = null;
    renderTaskRef.current?.cancel();

    void (async () => {
      try {
        const selectedPage = Math.min(document.numPages, Math.max(1, page));
        pageProxy = await document.getPage(selectedPage);
        if (!active) return;
        const baseViewport = pageProxy.getViewport({ scale: 1 });
        const availableWidth = Math.max(240, scroller.clientWidth - 32);
        const scale = fitWidth
          ? Math.min(3, Math.max(0.25, availableWidth / baseViewport.width))
          : zoom / 100;
        const viewport = pageProxy.getViewport({ scale });
        const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
        canvas.width = Math.max(1, Math.floor(viewport.width * pixelRatio));
        canvas.height = Math.max(1, Math.floor(viewport.height * pixelRatio));
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        canvas.dataset.page = String(selectedPage);
        const renderTask = pageProxy.render({
          canvas,
          viewport,
          transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
        });
        renderTaskRef.current = renderTask;
        await renderTask.promise;
        if (active) setSafeError("");
      } catch (error) {
        if (!active || (error instanceof Error && error.name === "RenderingCancelledException")) {
          return;
        }
        setSafeError("This PDF page could not be rendered.");
      } finally {
        pageProxy?.cleanup();
      }
    })();

    return () => {
      active = false;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
      pageProxy?.cleanup();
    };
  }, [documentVersion, fitWidth, layoutVersion, page, viewerState, zoom]);

  return (
    <div className={styles.pdfViewer} data-testid="application-pdf-viewer" data-state={viewerState}>
      <div
        className={styles.pdfToolbar}
        data-testid="workspace-pdf-toolbar"
        role="toolbar"
        aria-label="PDF preview controls"
      >
        <Button
          size="small"
          variant="ghost"
          disabled={viewerState !== "ready" || page <= 1}
          onClick={() => setPage((current) => Math.max(1, current - 1))}
        >
          Previous page
        </Button>
        <span aria-live="polite">
          Page {page}
          {pageCount > 0 ? ` of ${pageCount}` : ""}
        </span>
        <Button
          size="small"
          variant="ghost"
          disabled={viewerState !== "ready" || pageCount < 1 || page >= pageCount}
          onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
        >
          Next page
        </Button>
        <Button
          size="small"
          variant="ghost"
          disabled={viewerState !== "ready" || (!fitWidth && zoom <= MIN_ZOOM)}
          onClick={() => {
            setFitWidth(false);
            setZoom((current) => Math.max(MIN_ZOOM, current - 25));
          }}
        >
          Zoom out
        </Button>
        <Button
          size="small"
          variant="ghost"
          disabled={viewerState !== "ready" || (!fitWidth && zoom >= MAX_ZOOM)}
          onClick={() => {
            setFitWidth(false);
            setZoom((current) => Math.min(MAX_ZOOM, current + 25));
          }}
        >
          Zoom in
        </Button>
        <Button
          size="small"
          variant={fitWidth ? "secondary" : "ghost"}
          disabled={viewerState !== "ready"}
          aria-pressed={fitWidth}
          onClick={() => setFitWidth(true)}
        >
          Fit to width
        </Button>
        {downloadHref ? (
          <a className="bea-link" href={downloadHref} download>
            Download PDF
          </a>
        ) : null}
      </div>
      <div
        ref={scrollerRef}
        className={styles.pdfScroller}
        data-testid="workspace-pdf-scroller"
        data-scroll-owner="pdf"
        aria-label={`${title} PDF pages`}
        tabIndex={0}
        onScroll={(event) => rememberPdfScrollPosition(src, event.currentTarget.scrollTop)}
      >
        {viewerState === "loading" ? <p role="status">Loading authorized PDF…</p> : null}
        {viewerState === "failed" ? (
          <Alert tone="danger" title="PDF preview unavailable">
            {safeError}
          </Alert>
        ) : null}
        <canvas
          ref={canvasRef}
          className={styles.pdfCanvas}
          role="img"
          aria-label={`${title}, page ${page}`}
          hidden={viewerState !== "ready"}
        />
        {viewerState === "ready" && safeError ? (
          <Alert tone="danger" title="PDF page unavailable">
            {safeError}
          </Alert>
        ) : null}
      </div>
    </div>
  );
}

export function ApplicationPdfViewer(props: ApplicationPdfViewerProps) {
  return <ApplicationPdfViewerSession key={props.src} {...props} />;
}
