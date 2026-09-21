"use client";

import { Alert, Button, ConfirmationDialog } from "@bea/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function TaskCompleteButton({ taskId }: { taskId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function completeTask() {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/complete`, {
        method: "POST",
      });
      if (response.status === 401) {
        router.replace("/sign-in?reason=expired");
        return;
      }
      if (!response.ok) throw new Error("The task could not be completed.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The task could not be completed.");
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div className="bea-stack">
      <Button size="small" onClick={() => setConfirming(true)}>
        Complete task
      </Button>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <ConfirmationDialog
        open={confirming}
        title="Complete this task?"
        description="This records a durable completion event in the Phase 1 data store."
        confirmLabel="Complete task"
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void completeTask()}
      />
    </div>
  );
}
