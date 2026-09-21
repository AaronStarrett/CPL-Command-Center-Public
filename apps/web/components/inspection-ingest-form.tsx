"use client";

import { Alert, Button, FormField, Select, Textarea } from "@bea/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function InspectionIngestForm({
  inspectionId,
  needsCorrection,
}: {
  inspectionId: string;
  needsCorrection: boolean;
}) {
  const router = useRouter();
  const [sourceType, setSourceType] = useState("json");
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [preview, setPreview] = useState<string>();

  async function run(action: "dry-run-mapping" | "commit-staged-inspection") {
    setBusy(action);
    setError(undefined);
    setMessage(undefined);
    try {
      const releaseResponse = await fetch(
        `/api/operations/inspections/${encodeURIComponent(inspectionId)}`,
      );
      const inspectionBody = (await releaseResponse.json()) as {
        inspection?: { configurationReleaseId?: string | null };
        error?: { message?: string };
      };
      const releaseId = inspectionBody.inspection?.configurationReleaseId;
      if (!releaseId) {
        setError(
          "This inspection has no configuration release. Production mapping is not configured.",
        );
        return;
      }
      const response = await fetch("/api/configuration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: action === "dry-run-mapping" ? "dry-run-mapping" : "commit-staged-inspection",
          releaseId,
          inspectionId,
          sourceType,
          raw,
        }),
      });
      const payload = (await response.json()) as {
        error?: { message?: string };
        inspectionCreated?: boolean;
        duplicate?: boolean;
        mapping?: unknown;
        validation?: unknown;
      };
      if (!response.ok) {
        setError(payload.error?.message ?? "Ingestion failed.");
        return;
      }
      if (action === "dry-run-mapping") {
        setMessage("Dry-run only. No inspection submission was created.");
        setPreview(JSON.stringify(payload, null, 2));
      } else {
        setMessage(
          payload.duplicate
            ? "Duplicate source package ignored."
            : "Mapped package committed as an inspection submission.",
        );
        router.refresh();
      }
    } catch {
      setError("Ingestion failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="bea-stack">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {message ? <Alert tone="info">{message}</Alert> : null}
      <p>
        {needsCorrection
          ? "Correct the source package and commit again. Validation history is retained."
          : "JSON or CSV only. Uploaded files are not stored in Git. HTML and scripts are not rendered."}
      </p>
      <FormField label="Source type" htmlFor="ingest-source-type">
        <Select
          id="ingest-source-type"
          value={sourceType}
          onChange={(event) => setSourceType(event.target.value)}
        >
          <option value="json">JSON</option>
          <option value="csv">CSV</option>
        </Select>
      </FormField>
      <FormField label="Source package" htmlFor="ingest-raw">
        <Textarea
          id="ingest-raw"
          value={raw}
          onChange={(event) => setRaw(event.target.value)}
          rows={14}
          data-testid="ingest-raw"
        />
      </FormField>
      <div className="bea-cluster">
        <Button
          type="button"
          variant="secondary"
          data-testid="ingest-dry-run"
          disabled={Boolean(busy)}
          onClick={() => void run("dry-run-mapping")}
        >
          {busy === "dry-run-mapping" ? "Previewing…" : "Preview normalized data"}
        </Button>
        <Button
          type="button"
          data-testid="ingest-commit"
          disabled={Boolean(busy)}
          onClick={() => void run("commit-staged-inspection")}
        >
          {busy === "commit-staged-inspection" ? "Committing…" : "Commit as inspection submission"}
        </Button>
      </div>
      {preview ? (
        <pre data-testid="ingest-preview" className="bea-code-block">
          {preview}
        </pre>
      ) : null}
    </div>
  );
}
