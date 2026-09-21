import type { OperationalWorkItem, WorkItemKind } from "@bea/domain";
import {
  EMAIL_DRY_RUN_DISCLOSURE,
  TEAMS_DRY_RUN_DISCLOSURE,
  WORK_CONTROL_SYNTHETIC_DISCLOSURE,
  WORK_ITEM_KIND_LABELS,
  workItemIsAtRisk,
  workItemIsOverdue,
} from "@bea/domain";
import type { StatusTone } from "@bea/ui";

export const WORK_SYNTHETIC_DISCLOSURE = WORK_CONTROL_SYNTHETIC_DISCLOSURE;

export function workKindLabel(kind: string): string {
  return WORK_ITEM_KIND_LABELS[kind as WorkItemKind] ?? kind.replaceAll("_", " ");
}

export function workStatusTone(status: string): StatusTone {
  if (status === "completed") return "success";
  if (status === "cancelled") return "neutral";
  if (status === "blocked") return "danger";
  if (status === "in_progress" || status === "acknowledged") return "info";
  return "warning";
}

export function workDueLabel(
  item: Pick<OperationalWorkItem, "dueAt" | "availableAt">,
  now = new Date(),
): string {
  if (workItemIsOverdue(item.dueAt, now)) return "Overdue";
  if (workItemIsAtRisk(item.dueAt, item.availableAt, now)) return "Due soon";
  return "On track";
}

export const WORK_QUEUE_SECTIONS = [
  { key: "proposal.preparation", label: "Proposal preparation" },
  { key: "proposal.information", label: "Proposal information" },
  { key: "proposal.revision", label: "Proposal revision" },
  { key: "proposal.delivery-preparation", label: "Proposal delivery preparation" },
  { key: "proposal.review", label: "Proposal review" },
  { key: "proposal.pricing-override", label: "Pricing override" },
  { key: "inspection.readiness", label: "Inspection readiness" },
  { key: "inspection.submission", label: "Inspection submission" },
  { key: "inspection.correction", label: "Corrections" },
  { key: "report.technical-review", label: "Technical review" },
  { key: "report.revision", label: "Report revision" },
  { key: "report.delivery-authorization", label: "Delivery authorization" },
  { key: "delivery.reconciliation", label: "Delivery reconciliation" },
  { key: "automation.failure", label: "Automation failures" },
] as const;

export const SALES_COMMERCIAL_QUEUE_KEYS = [
  "proposal.preparation",
  "proposal.information",
  "proposal.revision",
  "proposal.delivery-preparation",
] as const;

export const DRY_RUN_EMAIL = EMAIL_DRY_RUN_DISCLOSURE;
export const DRY_RUN_TEAMS = TEAMS_DRY_RUN_DISCLOSURE;

export const WORK_STUDIO_LINKS = [
  { href: "/work", label: "My Work" },
  { href: "/work/queues", label: "Team queues" },
  { href: "/work/at-risk", label: "At risk" },
  { href: "/work/notifications", label: "Notification outbox" },
  { href: "/work/scheduler", label: "Scheduler" },
] as const;

export function isOpenWorkStatus(status: string): boolean {
  return (
    status === "open" ||
    status === "acknowledged" ||
    status === "in_progress" ||
    status === "blocked"
  );
}

export function workOwnerLabel(item: OperationalWorkItem): string {
  if (item.claimedUserId) return `Claimed ${item.claimedUserId}`;
  if (item.assignedUserId) return `Assigned ${item.assignedUserId}`;
  if (item.assignedRoleKey) return `Queue ${item.assignedRoleKey}`;
  return "Unassigned";
}
