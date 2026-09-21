"use client";

import { Alert, Button } from "@bea/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function WorkItemActions({
  workItemId,
  expectedVersion,
  canClaim,
  canUpdate,
  canReassign,
  canRetryAutomation,
  jobId,
  projectionEventId,
  ownerOnly,
}: {
  workItemId: string;
  expectedVersion: number;
  canClaim: boolean;
  canUpdate: boolean;
  canReassign: boolean;
  canRetryAutomation?: boolean;
  jobId?: string | null;
  projectionEventId?: string | null;
  ownerOnly: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [reason, setReason] = useState("Waiting on site access.");

  async function run(action: string, extra: Record<string, unknown> = {}) {
    setBusy(action);
    setError(undefined);
    try {
      const response = await fetch("/api/work", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, workItemId, expectedVersion, ...extra }),
      });
      const payload = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) {
        setError(payload.error?.message ?? "Work action failed.");
        return;
      }
      router.refresh();
    } catch {
      setError("Work action failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="bea-stack" data-testid="work-item-actions">
      {error ? (
        <Alert tone="danger" data-testid="work-action-error">
          {error}
        </Alert>
      ) : null}
      {ownerOnly ? (
        <Alert tone="warning" data-testid="owner-only-work">
          Owner-only delivery authorization. Claiming this item does not grant reports.deliver.
        </Alert>
      ) : null}
      <div className="bea-cluster">
        {canClaim ? (
          <>
            <Button
              type="button"
              data-testid="work-claim"
              disabled={Boolean(busy)}
              onClick={() => void run("claim")}
            >
              Claim
            </Button>
            <Button
              type="button"
              variant="secondary"
              data-testid="work-release"
              disabled={Boolean(busy)}
              onClick={() => void run("release")}
            >
              Release claim
            </Button>
          </>
        ) : null}
        {canUpdate ? (
          <>
            <Button
              type="button"
              variant="secondary"
              data-testid="work-acknowledge"
              disabled={Boolean(busy)}
              onClick={() => void run("acknowledge")}
            >
              Acknowledge
            </Button>
            <Button
              type="button"
              variant="secondary"
              data-testid="work-start"
              disabled={Boolean(busy)}
              onClick={() => void run("start")}
            >
              Start
            </Button>
            <Button
              type="button"
              variant="secondary"
              data-testid="work-block"
              disabled={Boolean(busy)}
              onClick={() => void run("block", { reason })}
            >
              Mark blocked
            </Button>
            <Button
              type="button"
              variant="secondary"
              data-testid="work-unblock"
              disabled={Boolean(busy)}
              onClick={() => void run("unblock")}
            >
              Clear block
            </Button>
          </>
        ) : null}
        {canReassign ? (
          <Button
            type="button"
            variant="secondary"
            data-testid="work-reassign"
            disabled={Boolean(busy)}
            onClick={() => void run("reassign", { assignedRoleKey: "operations" })}
          >
            Reassign to Operations
          </Button>
        ) : null}
        {canRetryAutomation ? (
          <>
            {projectionEventId ? (
              <Button
                type="button"
                variant="secondary"
                data-testid="work-retry-projection"
                disabled={Boolean(busy)}
                onClick={() => void run("retry-projection", { eventId: projectionEventId })}
              >
                Retry projection
              </Button>
            ) : null}
            {jobId ? (
              <Button
                type="button"
                variant="secondary"
                data-testid="work-retry-job"
                disabled={Boolean(busy)}
                onClick={() => void run("retry-job", { jobId })}
              >
                Requeue job
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
      {canUpdate ? (
        <label>
          Block reason
          <input
            className="bea-input"
            data-testid="work-block-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
      ) : null}
    </div>
  );
}
