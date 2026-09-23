import type {
  CplCommercialBranding,
  CplCommercialPermissions,
  CplCommercialProject,
  CplCommercialProposalSummary,
  CplCommercialTemplate,
} from "@bea/domain/cpl-commercial";

export type CommercialRequest = <T>(path: string, body?: unknown) => Promise<T>;
export function executionConflicts(input: unknown): Array<{
  visitId: string;
  projectId: string;
  purpose: string;
  plannedStartAt: string;
  plannedEndAt: string;
  timeZone: string;
}> {
  if (!Array.isArray(input) || input.length > 20) return [];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
  return input.flatMap((value: unknown) => {
    if (!value || typeof value !== "object") return [];
    const row = value as Record<string, unknown>;
    if (
      typeof row.visitId !== "string" ||
      !uuid.test(row.visitId) ||
      typeof row.projectId !== "string" ||
      !uuid.test(row.projectId) ||
      typeof row.purpose !== "string" ||
      row.purpose.length > 240 ||
      typeof row.timeZone !== "string" ||
      row.timeZone.length > 100 ||
      typeof row.plannedStartAt !== "string" ||
      !instant.test(row.plannedStartAt) ||
      !Number.isFinite(Date.parse(row.plannedStartAt)) ||
      typeof row.plannedEndAt !== "string" ||
      !instant.test(row.plannedEndAt) ||
      !Number.isFinite(Date.parse(row.plannedEndAt))
    )
      return [];
    return [
      {
        visitId: row.visitId,
        projectId: row.projectId,
        purpose: row.purpose,
        plannedStartAt: row.plannedStartAt,
        plannedEndAt: row.plannedEndAt,
        timeZone: row.timeZone,
      },
    ];
  });
}
export type CommercialWorkspaceData = {
  proposals: CplCommercialProposalSummary[];
  templates: CplCommercialTemplate[];
  branding: CplCommercialBranding;
  projects: CplCommercialProject[];
  permissions: CplCommercialPermissions;
};
export type ProposalIntent = { leadId: string; legacyDraftId?: string };

export const commercialStates = {
  draft: "Draft",
  review: "In review",
  approved: "Approved",
  revision_requested: "Changes requested",
  lost: "Lost",
  withdrawn: "Withdrawn",
  awarded: "Awarded",
} as const;

export const sectionLabels = {
  summary: "Summary",
  scope: "Scope of work",
  schedule: "Schedule / timing",
  deliverables: "Deliverables",
  assumptions: "Assumptions",
  exclusions: "Exclusions",
  terms: "Terms",
  paymentTerms: "Payment terms",
} as const;

/** These supported currencies all have two decimal minor units. Never round entered prices. */
export function parseMinorUnits(value: string): number {
  if (!/^(?:0|[1-9]\d{0,10})(?:\.\d{1,2})?$/u.test(value))
    throw new Error("Enter a non-negative amount with up to two decimal places.");
  const [whole, fraction = ""] = value.split(".");
  const result = Number(BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0")));
  if (!Number.isSafeInteger(result)) throw new Error("The amount is too large.");
  return result;
}

export function decimalMoney(value: number) {
  return (value / 100).toFixed(2);
}

export function money(value: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value / 100);
}

export function moveItem<T>(items: T[], index: number, direction: -1 | 1): T[] {
  const destination = index + direction;
  if (destination < 0 || destination >= items.length) return items;
  const next = [...items];
  [next[index], next[destination]] = [next[destination]!, next[index]!];
  return next;
}
