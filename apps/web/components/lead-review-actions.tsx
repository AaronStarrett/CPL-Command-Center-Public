"use client";

import type { Lead, LeadReadinessResult, LeadStatus } from "@bea/domain";
import { Alert, Button, FormField, Link } from "@bea/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";

interface ReviewAction {
  readonly toStatus: LeadStatus;
  readonly label: string;
  readonly tone?: "primary" | "danger";
  readonly needsReason?: boolean;
  readonly disabledReason?: string;
}

export function LeadReviewActions({
  lead,
  readiness,
  canReview,
  canDisqualify,
  canManage,
}: {
  lead: Lead;
  readiness: LeadReadinessResult;
  canReview: boolean;
  canDisqualify: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [reason, setReason] = useState("");

  const actions: ReviewAction[] = [];
  if (canReview && (lead.status === "new" || lead.status === "disqualified")) {
    actions.push({ toStatus: "needs_info", label: "Mark needs information" });
  }
  if (canReview && lead.status === "needs_info") {
    actions.push({ toStatus: "new", label: "Return to new" });
  }
  if (canReview && (lead.status === "new" || lead.status === "needs_info")) {
    actions.push({
      toStatus: "ready_for_proposal",
      label: "Mark ready for proposal",
      disabledReason: readiness.readyForProposal
        ? undefined
        : "Blocking intake information is still missing.",
    });
  }
  if (canReview && lead.status === "ready_for_proposal") {
    actions.push({ toStatus: "needs_info", label: "Return to needs information" });
  }
  if (canDisqualify && lead.status !== "disqualified") {
    actions.push({
      toStatus: "disqualified",
      label: "Disqualify",
      tone: "danger",
      needsReason: true,
    });
  }
  if (canReview && lead.status === "disqualified") {
    actions.push({ toStatus: "new", label: "Reopen as new" });
  }

  async function run(action: ReviewAction) {
    if (action.disabledReason) return;
    if (action.needsReason && !reason.trim()) {
      setError("Disqualification requires a recorded reason.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/leads/${encodeURIComponent(lead.id)}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toStatus: action.toStatus,
          expectedVersion: lead.version,
          reason: reason.trim() || null,
        }),
      });
      if (response.status === 401) {
        router.replace("/sign-in?reason=expired");
        return;
      }
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) {
        throw new Error(body.error?.message ?? "The review action could not be completed.");
      }
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "The review action could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!canReview && !canDisqualify && !canManage) return null;

  return (
    <div className="bea-lead-review-actions">
      {canDisqualify || actions.some((action) => action.needsReason) ? (
        <FormField
          label="Disqualification or correction reason"
          htmlFor="lead-review-reason"
          hint="Required to disqualify. Optional for other review transitions."
        >
          <textarea
            id="lead-review-reason"
            className="bea-input bea-textarea"
            value={reason}
            onChange={(event) => setReason(event.currentTarget.value)}
            maxLength={4000}
          />
        </FormField>
      ) : null}
      <div className="bea-record-actions">
        {actions.map((action) => (
          <Button
            key={`${action.toStatus}-${action.label}`}
            type="button"
            variant={action.tone === "danger" ? "danger" : "secondary"}
            busy={busy}
            disabled={Boolean(action.disabledReason) || busy}
            onClick={() => void run(action)}
          >
            {action.label}
          </Button>
        ))}
        {canManage ? (
          <Link href={`/leads/${lead.id}/edit`} variant="button">
            Edit intake
          </Link>
        ) : null}
      </div>
      {actions
        .filter((action) => action.disabledReason)
        .map((action) => (
          <Alert key={action.toStatus} tone="warning" title="Ready for proposal is blocked">
            {action.disabledReason} This does not mean commercially authorized, billable, or ready
            to schedule.
          </Alert>
        ))}
      {error ? (
        <Alert tone="danger" title="Review action failed">
          {error}
        </Alert>
      ) : null}
    </div>
  );
}
