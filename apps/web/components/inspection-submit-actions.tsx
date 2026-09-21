"use client";

import { Alert, Button } from "@bea/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function InspectionSubmitActions({
  inspectionId,
  canSubmit,
  canCorrect,
  needsCorrection,
}: {
  inspectionId: string;
  canSubmit: boolean;
  canCorrect: boolean;
  needsCorrection: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"complete" | "incomplete" | null>(null);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const allowed = needsCorrection ? canCorrect : canSubmit;
  if (!allowed) return null;

  async function submit(fixture: "complete" | "incomplete") {
    setBusy(fixture);
    setError(undefined);
    setMessage(undefined);
    try {
      const response = await fetch(
        `/api/operations/inspections/${encodeURIComponent(inspectionId)}/submit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fixture,
            sourceChannel: "direct_entry",
            sourceIdempotencyKey: `${fixture}:${inspectionId}:${Date.now()}`,
          }),
        },
      );
      const body = (await response.json()) as {
        duplicate?: boolean;
        error?: { message?: string };
      };
      if (!response.ok) {
        setError(body.error?.message ?? "Inspection submission failed.");
        return;
      }
      setMessage(
        body.duplicate
          ? "Duplicate submission ignored. Existing workflow was left in place."
          : fixture === "complete"
            ? "Complete synthetic package submitted. Validation and report assembly ran automatically."
            : "Incomplete synthetic package submitted. Validation should block report assembly.",
      );
      router.refresh();
    } catch {
      setError("Inspection submission failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="bea-stack">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {message ? <Alert tone="info">{message}</Alert> : null}
      <div className="bea-cluster">
        <Button
          type="button"
          data-testid="inspection-submit-complete"
          disabled={Boolean(busy)}
          onClick={() => void submit("complete")}
        >
          {busy === "complete" ? "Submitting…" : "Submit complete synthetic package"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          data-testid="inspection-submit-incomplete"
          disabled={Boolean(busy)}
          onClick={() => void submit("incomplete")}
        >
          {busy === "incomplete" ? "Submitting…" : "Submit incomplete package"}
        </Button>
      </div>
    </div>
  );
}
