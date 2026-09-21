import {
  LEAD_PARTY_ROLE_LABELS,
  LEAD_SOURCE_LABELS,
  LEAD_STATUS_LABELS,
  type LeadParty,
  type LeadPartyRole,
  type LeadReadinessResult,
  type LeadSourceType,
  type LeadStatus,
} from "@bea/domain";
import type { StatusTone } from "@bea/ui";

export function leadStatusTone(status: LeadStatus): StatusTone {
  if (status === "ready_for_proposal") return "success";
  if (status === "disqualified") return "danger";
  if (status === "needs_info") return "warning";
  return "info";
}

export function leadReadinessTone(ready: boolean): StatusTone {
  return ready ? "success" : "warning";
}

export function leadSourceLabel(source: LeadSourceType): string {
  return LEAD_SOURCE_LABELS[source];
}

export function leadStatusLabel(status: LeadStatus): string {
  return LEAD_STATUS_LABELS[status];
}

export function leadPartyRoleLabel(role: LeadPartyRole): string {
  return LEAD_PARTY_ROLE_LABELS[role];
}

export function leadPartyDisplayName(
  party: LeadParty,
  resolved: { readonly companyName?: string | null; readonly contactName?: string | null } = {},
): string {
  return (
    resolved.contactName?.trim() ||
    party.unmatchedContactName?.trim() ||
    resolved.companyName?.trim() ||
    party.unmatchedCompanyName?.trim() ||
    party.unmatchedEmail?.trim() ||
    (party.contactId ? "Linked contact" : "") ||
    (party.companyId ? "Linked company" : "") ||
    "Unnamed intake party"
  );
}

export function leadQueuePrimaryLabel(item: {
  readonly primaryCompanyName: string | null;
  readonly primaryContactName: string | null;
}): string {
  return (
    item.primaryCompanyName?.trim() ||
    item.primaryContactName?.trim() ||
    "No company or contact identified"
  );
}

export function leadMissingCount(readiness: LeadReadinessResult): {
  readonly blocking: number;
  readonly optional: number;
} {
  return { blocking: readiness.blocking.length, optional: readiness.optional.length };
}

export function datetimeLocalValue(isoValue: string | null): string {
  if (!isoValue) return "";
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
