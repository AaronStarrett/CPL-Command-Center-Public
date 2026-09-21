"use client";

import type { Proposal, ProposalPricingOverride, ProposalVersion } from "@bea/domain";
import { Alert, Button, FormField } from "@bea/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function ProposalCommandActions({
  proposal,
  currentVersion,
  overrides,
  canEdit,
  canSubmit,
  canApprove,
  canOverride,
  canDecideOverride,
  canDelivery,
  canCancel,
}: {
  proposal: Proposal;
  currentVersion: ProposalVersion | null;
  overrides: readonly ProposalPricingOverride[];
  canEdit: boolean;
  canSubmit: boolean;
  canApprove: boolean;
  canOverride: boolean;
  canDecideOverride: boolean;
  canDelivery: boolean;
  canCancel: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [comments, setComments] = useState("");
  const [ownerOverrideReason, setOwnerOverrideReason] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [overrideLine, setOverrideLine] = useState("");
  const [overrideAmount, setOverrideAmount] = useState("");
  const openOverrides = overrides.filter((item) => item.status === "requested");

  async function post(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/proposals/${encodeURIComponent(proposal.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, expectedVersion: proposal.version, ...extra }),
      });
      if (response.status === 401) {
        router.replace("/sign-in?reason=expired");
        return;
      }
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) {
        throw new Error(body.error?.message ?? "The proposal action could not be completed.");
      }
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "The proposal action could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bea-stack" data-testid="proposal-actions">
      {canEdit &&
      (proposal.status === "draft" ||
        proposal.status === "needs_information" ||
        proposal.status === "ready_for_review" ||
        proposal.status === "revision_required") ? (
        <Button
          type="button"
          variant="secondary"
          data-testid="proposal-refresh-from-lead"
          busy={busy}
          onClick={() => void post("refresh-from-lead")}
        >
          Refresh snapshot from Lead
        </Button>
      ) : null}
      {canSubmit &&
      (proposal.status === "draft" ||
        proposal.status === "needs_information" ||
        proposal.status === "ready_for_review" ||
        proposal.status === "revision_required") ? (
        <Button
          type="button"
          data-testid="proposal-submit"
          busy={busy}
          onClick={() => void post("submit-for-review")}
        >
          Submit for review
        </Button>
      ) : null}
      {canApprove && proposal.status === "in_review" && currentVersion ? (
        <>
          <FormField label="Review comments" htmlFor="proposal-review-comments">
            <textarea
              id="proposal-review-comments"
              className="bea-input bea-textarea"
              value={comments}
              onChange={(event) => setComments(event.currentTarget.value)}
            />
          </FormField>
          <FormField label="Owner approval override reason" htmlFor="proposal-owner-override">
            <textarea
              id="proposal-owner-override"
              className="bea-input bea-textarea"
              value={ownerOverrideReason}
              onChange={(event) => setOwnerOverrideReason(event.currentTarget.value)}
              data-testid="proposal-owner-override-reason"
            />
          </FormField>
          <p className="bea-muted">
            Assigned reviewer is the commercial approval authority. An Owner override reason is
            required only when a different eligible Owner approves.
          </p>
          <div className="bea-cluster">
            <Button
              type="button"
              data-testid="proposal-approve"
              busy={busy}
              onClick={() =>
                void post("review", {
                  decision: "approve",
                  proposalVersionId: currentVersion.id,
                  comments,
                  ...(ownerOverrideReason.trim()
                    ? { ownerApprovalOverrideReason: ownerOverrideReason.trim() }
                    : {}),
                })
              }
            >
              Approve exact version
            </Button>
            <Button
              type="button"
              variant="secondary"
              data-testid="proposal-request-revision"
              busy={busy}
              onClick={() =>
                void post("review", {
                  decision: "request_revision",
                  proposalVersionId: currentVersion.id,
                  comments,
                  requestedSections: comments ? [comments] : ["scope"],
                })
              }
            >
              Request revision
            </Button>
          </div>
        </>
      ) : null}
      {canOverride &&
      (proposal.status === "draft" ||
        proposal.status === "needs_information" ||
        proposal.status === "ready_for_review" ||
        proposal.status === "revision_required") ? (
        <div className="bea-stack">
          <FormField label="Override line key" htmlFor="proposal-override-line">
            <input
              id="proposal-override-line"
              className="bea-input"
              data-testid="proposal-override-line"
              value={overrideLine}
              onChange={(event) => setOverrideLine(event.currentTarget.value)}
            />
          </FormField>
          <FormField label="Proposed amount (minor units)" htmlFor="proposal-override-amount">
            <input
              id="proposal-override-amount"
              className="bea-input"
              data-testid="proposal-override-amount"
              value={overrideAmount}
              onChange={(event) => setOverrideAmount(event.currentTarget.value)}
            />
          </FormField>
          <FormField label="Override reason" htmlFor="proposal-override-reason">
            <textarea
              id="proposal-override-reason"
              className="bea-input bea-textarea"
              data-testid="proposal-override-reason"
              value={overrideReason}
              onChange={(event) => setOverrideReason(event.currentTarget.value)}
            />
          </FormField>
          <Button
            type="button"
            variant="secondary"
            data-testid="proposal-request-override"
            busy={busy}
            onClick={() =>
              void post("request-override", {
                lineKey: overrideLine,
                proposedAmountMinor: Number(overrideAmount),
                reason: overrideReason,
              })
            }
          >
            Request pricing override
          </Button>
        </div>
      ) : null}
      {canDecideOverride
        ? openOverrides.map((item) => (
            <div key={item.id} className="bea-cluster">
              <Button
                type="button"
                data-testid={`proposal-approve-override-${item.id}`}
                busy={busy}
                onClick={() => void post("decide-override", { overrideId: item.id, approve: true })}
              >
                Approve override
              </Button>
              <Button
                type="button"
                variant="danger"
                busy={busy}
                onClick={() =>
                  void post("decide-override", { overrideId: item.id, approve: false })
                }
              >
                Reject override
              </Button>
            </div>
          ))
        : null}
      {canDelivery &&
      currentVersion &&
      (proposal.status === "approved" || proposal.status === "ready_for_delivery") ? (
        <Button
          type="button"
          data-testid="delivery-manifest"
          busy={busy}
          onClick={() => void post("delivery-manifest", { proposalVersionId: currentVersion.id })}
        >
          Generate delivery dry-run
        </Button>
      ) : null}
      {canCancel && proposal.status !== "cancelled" && proposal.status !== "superseded" ? (
        <Button
          type="button"
          variant="danger"
          data-testid="proposal-cancel"
          busy={busy}
          onClick={() => void post("cancel")}
        >
          Cancel proposal
        </Button>
      ) : null}
      {error ? (
        <Alert tone="danger" title="Proposal action failed" data-testid="proposal-action-error">
          {error}
        </Alert>
      ) : null}
    </div>
  );
}
