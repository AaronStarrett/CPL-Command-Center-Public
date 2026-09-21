"use client";

import { Alert, Button } from "@bea/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function WorkReconcileActions({ canExecute }: { canExecute: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<string>();

  async function run(action: "reconcile-dry-run" | "reconcile-execute") {
    setBusy(action);
    setError(undefined);
    setResult(undefined);
    try {
      const response = await fetch("/api/work", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = (await response.json()) as {
        error?: { message?: string };
        result?: { createdMissing: number; completedStale: number; unchanged: number };
      };
      if (!response.ok) {
        setError(payload.error?.message ?? "Reconciliation failed.");
        return;
      }
      setResult(
        `${action === "reconcile-dry-run" ? "Dry-run" : "Execute"}: create ${payload.result?.createdMissing ?? 0}, complete ${payload.result?.completedStale ?? 0}, unchanged ${payload.result?.unchanged ?? 0}. Official inspection and report state was not mutated.`,
      );
      router.refresh();
    } catch {
      setError("Reconciliation failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="bea-stack" data-testid="work-reconcile-actions">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {result ? (
        <Alert tone="info" data-testid="work-reconcile-result">
          {result}
        </Alert>
      ) : null}
      <div className="bea-cluster">
        <Button
          type="button"
          variant="secondary"
          data-testid="work-reconcile-dry-run"
          disabled={Boolean(busy)}
          onClick={() => void run("reconcile-dry-run")}
        >
          Dry-run reconciliation
        </Button>
        {canExecute ? (
          <Button
            type="button"
            data-testid="work-reconcile-execute"
            disabled={Boolean(busy)}
            onClick={() => void run("reconcile-execute")}
          >
            Execute reconciliation
          </Button>
        ) : null}
      </div>
    </div>
  );
}
