"use client";

import { Alert, Button, ConfirmationDialog } from "@bea/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { useHydrated } from "@/lib/use-hydrated";

interface SimulationResult {
  providerType: string;
  mode: "mock";
  connectionStatus: "simulated";
  externalCalls: 0;
  completedAt: string;
}

export function IntegrationSimulator({
  providerType,
  displayName,
}: {
  providerType: string;
  displayName: string;
}) {
  const router = useRouter();
  const interactive = useHydrated();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SimulationResult>();
  const [error, setError] = useState<string>();

  async function simulate() {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(
        `/api/integrations/${encodeURIComponent(providerType)}/simulate`,
        { method: "POST" },
      );
      if (response.status === 401) {
        router.replace("/sign-in?reason=expired");
        return;
      }
      if (!response.ok) throw new Error(`Simulation failed with status ${response.status}.`);
      setResult((await response.json()) as SimulationResult);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Simulation failed.");
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div className="bea-stack">
      <Button
        size="small"
        variant="ghost"
        disabled={!interactive}
        onClick={() => setConfirming(true)}
      >
        Run simulation
      </Button>
      {result ? (
        <Alert tone="success">
          Simulation completed with {result.externalCalls} external calls.
        </Alert>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <ConfirmationDialog
        open={confirming}
        title={`Simulate ${displayName}?`}
        description="This invokes the deterministic mock provider only. No credentials or external systems are used."
        confirmLabel="Run simulation"
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void simulate()}
      />
    </div>
  );
}
