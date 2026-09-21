"use client";

import { Alert, Button, FormField, Select, Textarea } from "@bea/ui";
import { useState } from "react";

export function ConfigurationMappingLab({
  releases,
}: {
  releases: readonly {
    id: string;
    displayName: string;
    versionNumber: number;
    synthetic: boolean;
  }[];
}) {
  const [releaseId, setReleaseId] = useState(releases[0]?.id ?? "");
  const [sourceType, setSourceType] = useState("json");
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<string>();

  async function run(
    action: "dry-run-mapping" | "preview-report" | "connector-dry-run" | "replay-synthetic",
  ) {
    setBusy(action);
    setError(undefined);
    setResult(undefined);
    try {
      const response = await fetch("/api/configuration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          releaseId,
          sourceType,
          raw,
          inspectionReference: "BEA-IN-LAB",
          reportReference: "BEA-RP-LAB",
          projectReference: "BEA-PR-LAB",
          filename: "lab.pdf",
        }),
      });
      const payload = (await response.json()) as {
        error?: { message?: string };
        mapping?: { humanReadable?: string[]; unmappedSourceFields?: string[] };
        checksumSha256?: string;
        filename?: string;
        inspectionCreated?: boolean;
        manifest?: { liveWrites?: boolean; disclosure?: string };
      };
      if (!response.ok) {
        setError(payload.error?.message ?? "Lab action failed.");
        return;
      }
      setResult(JSON.stringify(payload, null, 2));
    } catch {
      setError("Lab action failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="bea-stack">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <FormField label="Configuration release" htmlFor="lab-release">
        <Select
          id="lab-release"
          value={releaseId}
          onChange={(event) => setReleaseId(event.target.value)}
          data-testid="lab-release"
        >
          {releases.map((release) => (
            <option key={release.id} value={release.id}>
              {release.displayName} v{release.versionNumber}
              {release.synthetic ? " · synthetic" : " · production (unconfigured)"}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label="Source type" htmlFor="lab-source-type">
        <Select
          id="lab-source-type"
          value={sourceType}
          onChange={(event) => setSourceType(event.target.value)}
          data-testid="lab-source-type"
        >
          <option value="json">JSON</option>
          <option value="csv">CSV</option>
        </Select>
      </FormField>
      <FormField
        label="Synthetic source"
        htmlFor="lab-raw"
        hint="Paste JSON or CSV. HTML, scripts, PDF, DOCX, and macros are quarantined and never executed."
      >
        <Textarea
          id="lab-raw"
          value={raw}
          onChange={(event) => setRaw(event.target.value)}
          rows={12}
          data-testid="lab-raw"
        />
      </FormField>
      <div className="bea-cluster">
        <Button
          type="button"
          data-testid="lab-dry-run"
          disabled={Boolean(busy)}
          onClick={() => void run("dry-run-mapping")}
        >
          {busy === "dry-run-mapping" ? "Mapping…" : "Dry-run mapping"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          data-testid="lab-preview-report"
          disabled={Boolean(busy)}
          onClick={() => void run("preview-report")}
        >
          {busy === "preview-report" ? "Rendering…" : "Preview synthetic report"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          data-testid="lab-replay"
          disabled={Boolean(busy)}
          onClick={() => void run("replay-synthetic")}
        >
          {busy === "replay-synthetic" ? "Replaying…" : "Replay without writes"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          data-testid="lab-connector-dry-run"
          disabled={Boolean(busy)}
          onClick={() => void run("connector-dry-run")}
        >
          {busy === "connector-dry-run" ? "Planning…" : "Storage and delivery dry-run"}
        </Button>
      </div>
      {result ? (
        <pre data-testid="lab-result" className="bea-code-block">
          {result}
        </pre>
      ) : null}
    </div>
  );
}
