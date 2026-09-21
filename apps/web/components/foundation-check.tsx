"use client";

import { Alert, Button, ConfirmationDialog, HealthIndicator, LoadingState } from "@bea/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { useHydrated } from "@/lib/use-hydrated";

interface WorkflowResult {
  run: { id: string; status: "succeeded" | "degraded" | "failed"; finishedAt: string | null };
  reused: boolean;
  steps: Array<{
    id: string;
    stepKey: string;
    status: "succeeded" | "degraded" | "failed";
  }>;
}

function resultPresentation(status: WorkflowResult["run"]["status"]) {
  if (status === "succeeded")
    return { tone: "success" as const, title: "Foundation check succeeded" };
  if (status === "degraded")
    return { tone: "warning" as const, title: "Foundation check completed with degraded status" };
  return { tone: "danger" as const, title: "Foundation check failed" };
}

export function FoundationCheck({ canRun }: { canRun: boolean }) {
  const router = useRouter();
  const interactive = useHydrated();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<WorkflowResult>();
  const [error, setError] = useState<string>();

  async function runCheck() {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/foundation/workflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "run-foundation-check",
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      if (response.status === 401) {
        router.replace("/sign-in?reason=expired");
        return;
      }
      const body = (await response.json()) as WorkflowResult | { error?: { message?: string } };
      if ("run" in body) {
        setResult(body);
        return;
      }
      if (!response.ok) {
        throw new Error(
          body.error?.message ?? `Foundation check failed with status ${response.status}.`,
        );
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Foundation check failed.");
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div className="bea-foundation-check">
      {!canRun ? (
        <Alert tone="info" title="View-only access">
          This account can inspect foundation status but cannot run the workflow.
        </Alert>
      ) : (
        <Button disabled={!interactive} onClick={() => setConfirming(true)}>
          Run foundation check
        </Button>
      )}
      {busy ? <LoadingState label="Running deterministic foundation checks" /> : null}
      {error ? (
        <Alert tone="danger" title="Check failed">
          {error}
        </Alert>
      ) : null}
      {result ? (
        <Alert
          tone={resultPresentation(result.run.status).tone}
          title={resultPresentation(result.run.status).title}
        >
          <ul className="bea-check-results">
            {result.steps.map((step) => (
              <li key={step.id}>
                <span>{step.stepKey.replaceAll("-", " ")}</span>
                <HealthIndicator
                  label={step.status}
                  state={
                    step.status === "succeeded"
                      ? "healthy"
                      : step.status === "degraded"
                        ? "degraded"
                        : "unavailable"
                  }
                />
              </li>
            ))}
          </ul>
          {result.reused ? <p>This idempotent result was reused.</p> : null}
        </Alert>
      ) : null}
      <ConfirmationDialog
        open={confirming}
        title="Run the foundation check?"
        description="This runs local deterministic checks only. It does not contact an external service or change business records."
        confirmLabel="Run check"
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void runCheck()}
      />
    </div>
  );
}
