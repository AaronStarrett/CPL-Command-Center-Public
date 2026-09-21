import {
  COMMERCIAL_PRODUCTION_UNCONFIGURED,
  COMMERCIAL_SYNTHETIC_DISCLOSURE,
  PROPOSAL_EMAIL_DRY_RUN_DISCLOSURE,
  PROPOSAL_STATUS_LABELS,
  minorToDisplay,
  type Proposal,
  type ProposalReadinessResult,
  type ProposalStatus,
} from "@bea/domain";

export const COMMERCIAL_UI_DISCLOSURE = COMMERCIAL_SYNTHETIC_DISCLOSURE;
export const COMMERCIAL_PRODUCTION_LABEL = COMMERCIAL_PRODUCTION_UNCONFIGURED;
export const PROPOSAL_NO_SEND_LABEL = PROPOSAL_EMAIL_DRY_RUN_DISCLOSURE;

export function proposalStatusLabel(status: ProposalStatus): string {
  return PROPOSAL_STATUS_LABELS[status];
}

export function proposalStatusTone(
  status: ProposalStatus,
): "neutral" | "info" | "success" | "warning" | "danger" {
  switch (status) {
    case "approved":
    case "ready_for_delivery":
      return "success";
    case "in_review":
    case "ready_for_review":
      return "info";
    case "needs_information":
    case "revision_required":
      return "warning";
    case "cancelled":
    case "superseded":
      return "danger";
    default:
      return "neutral";
  }
}

export function formatProposalMoney(minor: number, currency: string): string {
  return minorToDisplay(BigInt(minor), currency);
}

export function proposalNextAction(input: {
  readonly status: ProposalStatus;
  readonly readiness?: ProposalReadinessResult | null;
  readonly openOverrideCount: number;
}): string {
  if (input.openOverrideCount > 0) return "Owner must approve or reject the pricing override.";
  if (input.status === "needs_information" || input.readiness?.readyForReview === false) {
    return "Complete required proposal information, then submit for review.";
  }
  if (input.status === "draft" || input.status === "ready_for_review") {
    return "Submit the draft for Owner commercial review.";
  }
  if (input.status === "in_review") return "Owner reviews the exact frozen version.";
  if (input.status === "revision_required") {
    return "Prepare a new version. The prior version stays immutable.";
  }
  if (input.status === "approved") {
    return "Generate the no-write delivery dry-run. No message is sent.";
  }
  if (input.status === "ready_for_delivery") {
    return "Internal delivery planning is complete. Live send remains deferred.";
  }
  if (input.status === "cancelled") return "This proposal is cancelled.";
  if (input.status === "superseded") return "This proposal was superseded.";
  return "Continue the synthetic commercial workflow.";
}

export function proposalAgeLabel(createdAt: string, now = Date.now()): string {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return "Unknown age";
  const hours = Math.max(0, Math.floor((now - created) / (60 * 60 * 1000)));
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function previewKindLabel(kind: string): string {
  if (kind === "approved") return "Approved version";
  if (kind === "frozen_review") return "Frozen reviewed version";
  return "Mutable draft preview";
}

export function linkedProposalSummary(
  proposal: Pick<Proposal, "reference" | "status" | "totalMinor" | "currency">,
): string {
  return `${proposal.reference} · ${proposalStatusLabel(proposal.status)} · ${formatProposalMoney(proposal.totalMinor, proposal.currency)}`;
}
