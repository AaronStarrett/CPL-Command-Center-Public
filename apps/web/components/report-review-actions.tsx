"use client";

import type { InspectionReport } from "@bea/domain";
import { Alert, Button, FormField } from "@bea/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function ReportReviewActions({
  report,
  canReview,
  canApprove,
  canDeliver,
}: {
  report: InspectionReport;
  canReview: boolean;
  canApprove: boolean;
  canDeliver: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [comment, setComment] = useState("");
  const inReview = report.status === "in_review" || report.status === "draft_ready";
  const readyForDelivery = report.status === "ready_for_delivery";
  const canRetry = report.status === "delivery_failed" && canDeliver;
  const canRevoke = report.status === "delivering" && canDeliver;

  async function post(body: Record<string, unknown>, action: string) {
    setBusy(action);
    setError(undefined);
    try {
      const response = await fetch(`/api/operations/reports/${encodeURIComponent(report.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) {
        setError(payload.error?.message ?? "Report action failed.");
        return;
      }
      router.refresh();
    } catch {
      setError("Report action failed.");
    } finally {
      setBusy(null);
    }
  }

  if (!inReview && !readyForDelivery && !canRetry && !canRevoke) return null;

  return (
    <div className="bea-stack">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {inReview ? (
        <>
          <FormField label="Review comment" htmlFor="report-review-comment">
            <textarea
              id="report-review-comment"
              className="bea-input bea-textarea"
              rows={3}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
            />
          </FormField>
          <div className="bea-cluster">
            {canApprove ? (
              <Button
                type="button"
                data-testid="report-approve"
                disabled={Boolean(busy)}
                onClick={() =>
                  void post(
                    {
                      action: "technical-approve",
                      decision: "approve",
                      expectedVersion: report.version,
                      comment: comment.trim() || null,
                    },
                    "approve",
                  )
                }
              >
                {busy === "approve" ? "Approving…" : "Approve technical content"}
              </Button>
            ) : null}
            {canReview ? (
              <Button
                type="button"
                variant="secondary"
                data-testid="report-request-revision"
                disabled={Boolean(busy)}
                onClick={() =>
                  void post(
                    {
                      action: "request-revision",
                      decision: "request_revision",
                      expectedVersion: report.version,
                      comment: comment.trim() || null,
                    },
                    "revision",
                  )
                }
              >
                {busy === "revision" ? "Recording…" : "Request revision"}
              </Button>
            ) : null}
            {canReview ? (
              <Button
                type="button"
                variant="secondary"
                data-testid="report-return-inspector"
                disabled={Boolean(busy)}
                onClick={() =>
                  void post(
                    {
                      action: "return-to-inspector",
                      decision: "return_to_inspector",
                      expectedVersion: report.version,
                      comment: comment.trim() || null,
                    },
                    "return",
                  )
                }
              >
                {busy === "return" ? "Returning…" : "Return to inspector"}
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
      {readyForDelivery && canDeliver ? (
        <div className="bea-stack">
          <p data-testid="ready-for-delivery-gate">
            Technical content is approved and the final artifact is rendered. Client delivery has
            not been authorized.
          </p>
          <Button
            type="button"
            data-testid="report-authorize-delivery"
            disabled={Boolean(busy)}
            onClick={() => void post({ action: "authorize-delivery" }, "authorize")}
          >
            {busy === "authorize" ? "Authorizing…" : "Authorize client delivery"}
          </Button>
        </div>
      ) : null}
      {readyForDelivery && !canDeliver ? (
        <p data-testid="delivery-authorization-required">
          Final artifact rendering is complete. A user with reports.deliver must authorize client
          delivery. Technical approval does not send the report.
        </p>
      ) : null}
      {canRevoke ? (
        <Button
          type="button"
          variant="secondary"
          data-testid="report-revoke-delivery"
          disabled={Boolean(busy)}
          onClick={() => void post({ action: "revoke-delivery-authorization" }, "revoke")}
        >
          {busy === "revoke" ? "Revoking…" : "Revoke delivery authorization"}
        </Button>
      ) : null}
      {canRetry ? (
        <Button
          type="button"
          data-testid="report-retry-delivery"
          disabled={Boolean(busy)}
          onClick={() => void post({ action: "retry-delivery" }, "retry")}
        >
          {busy === "retry" ? "Retrying…" : "Retry failed delivery"}
        </Button>
      ) : null}
    </div>
  );
}
