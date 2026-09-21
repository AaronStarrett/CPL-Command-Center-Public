"use client";

import { Alert, Button } from "@bea/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function InspectionReadinessActions({
  inspectionId,
  canManage,
}: {
  inspectionId: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string>();

  if (!canManage) return null;

  async function run(
    setupAction: "checklist" | "ready" | "start" | "complete",
    checklistKey?: string,
  ) {
    setBusy(setupAction + (checklistKey ?? ""));
    setError(undefined);
    try {
      const response = await fetch("/api/configuration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update-inspection-setup",
          inspectionId,
          setupAction,
          checklistKey,
          checklistStatus: setupAction === "checklist" ? "complete" : undefined,
        }),
      });
      const payload = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) {
        setError(payload.error?.message ?? "Inspection setup update failed.");
        return;
      }
      router.refresh();
    } catch {
      setError("Inspection setup update failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="bea-stack">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="bea-cluster">
        {["scope", "access", "equipment"].map((key) => (
          <Button
            key={key}
            type="button"
            variant="secondary"
            data-testid={`inspection-checklist-${key}`}
            disabled={Boolean(busy)}
            onClick={() => void run("checklist", key)}
          >
            Mark {key} complete
          </Button>
        ))}
        <Button
          type="button"
          data-testid="inspection-ready"
          disabled={Boolean(busy)}
          onClick={() => void run("ready")}
        >
          Mark ready
        </Button>
        <Button
          type="button"
          variant="secondary"
          data-testid="inspection-start"
          disabled={Boolean(busy)}
          onClick={() => void run("start")}
        >
          Mark started
        </Button>
        <Button
          type="button"
          variant="secondary"
          data-testid="inspection-complete"
          disabled={Boolean(busy)}
          onClick={() => void run("complete")}
        >
          Mark completed
        </Button>
      </div>
    </div>
  );
}
