import type {
  ConnectorReadinessStatus,
  ExceptionCase,
  InspectionStatus,
  ReportStatus,
  SlaClockStatus,
  TurnaroundBoardItem,
  TurnaroundMetrics,
} from "@bea/domain";
import {
  CONNECTOR_READINESS_LABELS,
  INSPECTION_STATUS_LABELS,
  REPORT_STATUS_LABELS,
  SLA_STAGE_LABELS,
  SYNTHETIC_REPORT_DISCLOSURE,
  type JsonObject,
  type SlaStageKey,
} from "@bea/domain";
import type { StatusTone } from "@bea/ui";

export const OPERATIONS_SYNTHETIC_DISCLOSURE = SYNTHETIC_REPORT_DISCLOSURE;

export function isSyntheticOperationsFixture(
  appMode: "demo" | "production",
  snapshot?: JsonObject | null,
): boolean {
  if (appMode === "demo") return true;
  return snapshot?.synthetic === true;
}

export function slaStageLabel(stageKey: string): string {
  return SLA_STAGE_LABELS[stageKey as SlaStageKey] ?? stageKey.replaceAll("_", " ");
}

export function formatJobAttemptLabel(input: {
  readonly status: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
}): string {
  const executions = input.attemptCount;
  if (input.status === "succeeded") {
    return `executed ${executions} time${executions === 1 ? "" : "s"} (max ${input.maxAttempts})`;
  }
  if (input.status === "claimed") {
    return `in progress · execution ${Math.max(1, executions)}/${input.maxAttempts}`;
  }
  if (input.status === "dead_letter" || input.status === "failed") {
    return `failed after ${executions} execution${executions === 1 ? "" : "s"} (max ${input.maxAttempts})`;
  }
  if (executions === 0) {
    return `queued · 0 executions (max ${input.maxAttempts})`;
  }
  return `executions ${executions}/${input.maxAttempts}`;
}

export const TURNAROUND_BOARD_FILTERS = [
  { key: "", label: "All active work" },
  { key: "at-risk", label: "At risk" },
  { key: "blocked", label: "Blocked" },
  { key: "awaiting-submission", label: "Awaiting inspection submission" },
  { key: "needs-correction", label: "Needs correction" },
  { key: "draft-generation", label: "Draft generation" },
  { key: "awaiting-review", label: "Awaiting review" },
  { key: "revision-required", label: "Revision required" },
  { key: "awaiting-approval", label: "Awaiting approval" },
  { key: "delivery-failure", label: "Delivery failure" },
  { key: "delivered-today", label: "Delivered today" },
] as const;

export type TurnaroundBoardFilter = (typeof TURNAROUND_BOARD_FILTERS)[number]["key"];

export function operationsStatusTone(
  status: InspectionStatus | ReportStatus | SlaClockStatus | ConnectorReadinessStatus | string,
): StatusTone {
  if (
    [
      "complete",
      "completed",
      "delivered",
      "validated",
      "approved",
      "healthy",
      "stopped",
      "resolved",
      "succeeded",
    ].includes(status)
  ) {
    return "success";
  }
  if (
    [
      "needs_correction",
      "delivery_failed",
      "failed",
      "dead_letter",
      "breached",
      "error",
      "auth_expired",
      "cancelled",
    ].includes(status)
  ) {
    return "danger";
  }
  if (
    [
      "in_review",
      "revision_required",
      "validating",
      "paused",
      "degraded",
      "open",
      "assigned",
      "delivering",
      "rendering_final",
    ].includes(status)
  ) {
    return "warning";
  }
  if (["draft", "scheduled", "ready", "not_connected", "ready_for_activation"].includes(status)) {
    return "info";
  }
  return "neutral";
}

export function inspectionStatusLabel(status: InspectionStatus): string {
  return INSPECTION_STATUS_LABELS[status];
}

export function reportStatusLabel(status: ReportStatus): string {
  return REPORT_STATUS_LABELS[status];
}

export function connectorStatusLabel(status: ConnectorReadinessStatus): string {
  return CONNECTOR_READINESS_LABELS[status];
}

export function formatDurationMs(milliseconds: number | null | undefined): string {
  if (milliseconds === null || milliseconds === undefined || !Number.isFinite(milliseconds)) {
    return "Not started";
  }
  const absolute = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(absolute / 3_600_000);
  const minutes = Math.floor((absolute % 3_600_000) / 60_000);
  if (hours >= 48) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.max(1, Math.round(absolute / 1000))}s`;
}

export function slaTone(metrics: TurnaroundMetrics): StatusTone {
  if (metrics.slaStatus === "breached" || (metrics.slaRemainingMs ?? 1) < 0) return "danger";
  if (metrics.slaStatus === "paused") return "warning";
  if (metrics.slaRemainingMs !== null && metrics.slaRemainingMs < 4 * 60 * 60 * 1000) {
    return "warning";
  }
  if (metrics.slaStatus === "stopped") return "success";
  return "info";
}

export function filterTurnaroundBoard(
  items: readonly TurnaroundBoardItem[],
  filter: string,
  now = new Date(),
): readonly TurnaroundBoardItem[] {
  const today = now.toISOString().slice(0, 10);
  switch (filter) {
    case "at-risk":
      return items.filter(
        (item) =>
          slaTone(item.metrics) === "warning" ||
          slaTone(item.metrics) === "danger" ||
          Boolean(item.exception),
      );
    case "blocked":
      return items.filter((item) => Boolean(item.exception));
    case "awaiting-submission":
      return items.filter((item) =>
        ["completed", "draft", "scheduled", "ready", "in_progress"].includes(
          item.inspection.status,
        ),
      );
    case "needs-correction":
      return items.filter((item) => item.inspection.status === "needs_correction");
    case "draft-generation":
      return items.filter((item) =>
        ["assembling", "awaiting_data", "validated", "validating", "submitted"].includes(
          item.report?.status ?? item.inspection.status,
        ),
      );
    case "awaiting-review":
    case "awaiting-approval":
      return items.filter(
        (item) => item.report?.status === "in_review" || item.report?.status === "draft_ready",
      );
    case "revision-required":
      return items.filter((item) => item.report?.status === "revision_required");
    case "delivery-failure":
      return items.filter((item) => item.report?.status === "delivery_failed");
    case "delivered-today":
      return items.filter((item) => item.metrics.reportDeliveredAt?.slice(0, 10) === today);
    default:
      return items;
  }
}

export function exceptionSummary(exception: ExceptionCase | null): string {
  if (!exception) return "None";
  return `${exception.reference}: ${exception.title}`;
}
