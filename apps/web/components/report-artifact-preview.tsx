"use client";

import { useEffect, useState } from "react";

export function ReportArtifactPreview({ reportId, title }: { reportId: string; title: string }) {
  const [objectUrl, setObjectUrl] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    let createdUrl: string | undefined;
    void (async () => {
      try {
        const response = await fetch(
          `/api/operations/reports/${encodeURIComponent(reportId)}/artifact`,
          { signal: controller.signal },
        );
        if (!response.ok) {
          setError("The rendered artifact could not be loaded.");
          return;
        }
        const blob = await response.blob();
        createdUrl = URL.createObjectURL(blob);
        setObjectUrl(createdUrl);
      } catch (caught) {
        if ((caught as { name?: string }).name === "AbortError") return;
        setError("The rendered artifact could not be loaded.");
      }
    })();
    return () => {
      controller.abort();
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [reportId]);

  if (error) return <p>{error}</p>;
  if (!objectUrl) return <p>Loading synthetic PDF preview…</p>;

  return (
    <iframe
      title={title}
      src={objectUrl}
      className="bea-report-preview"
      data-testid="report-artifact-preview"
    />
  );
}
