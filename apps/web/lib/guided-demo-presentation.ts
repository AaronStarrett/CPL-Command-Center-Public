import {
  GUIDED_DEMO_ACTIONS,
  GUIDED_DEMO_DECISION_KEYS,
  GUIDED_DEMO_STAGES,
  GUIDED_DEMO_TRUTH_LABELS,
  guidedDemoRoleCanPerform,
  presentationCueForState,
  type GuidedDemoAction,
  type GuidedDemoDecisionKey,
  type GuidedDemoSnapshot,
  type GuidedDemoStageKey,
} from "@bea/domain";

export const PRIMARY_NAVIGATION_LABELS = [
  "Command Center",
  "Automation Flow",
  "Company Details",
] as const;

export function allowedGuidedDemoActions(roleKey: string): GuidedDemoAction[] {
  return GUIDED_DEMO_ACTIONS.filter((action) => guidedDemoRoleCanPerform(roleKey, action));
}

export function allowedGuidedDemoDecisions(roleKey: string): GuidedDemoDecisionKey[] {
  return GUIDED_DEMO_DECISION_KEYS.filter((decision) =>
    guidedDemoRoleCanPerform(roleKey, "submit_human_decision", decision),
  );
}

export function stageDefinition(stageKey: GuidedDemoStageKey) {
  return GUIDED_DEMO_STAGES.find((stage) => stage.key === stageKey) ?? GUIDED_DEMO_STAGES[0]!;
}

export function truthLabelForStage(stageKey: GuidedDemoStageKey): string {
  return GUIDED_DEMO_TRUTH_LABELS[stageDefinition(stageKey).backingType];
}

export function cueForSnapshot(snapshot: GuidedDemoSnapshot): string {
  return presentationCueForState(snapshot.machineState);
}

export function relatedRecordHref(
  kind: "lead" | "proposal" | "project" | "inspection" | "report" | "work" | "exception",
  id: string | undefined,
): string | null {
  if (!id) return null;
  if (kind === "work") return `/work/${encodeURIComponent(id)}`;
  if (kind === "exception") return `/exceptions`;
  return `/${kind}s/${encodeURIComponent(id)}`;
}

export function moneyFromMinor(minor: number): string {
  return `$${(minor / 100).toFixed(2)}`;
}

export function meridianReportSections() {
  return [
    { id: "cover", title: "Cover" },
    { id: "synthetic-notice", title: "Synthetic Demonstration Notice" },
    { id: "executive-summary", title: "Executive Summary" },
    { id: "property", title: "Property and Inspection Details" },
    { id: "scope", title: "Scope of Assessment" },
    { id: "documents", title: "Documents and Information Reviewed" },
    { id: "observed", title: "Observed Conditions" },
    { id: "findings", title: "Findings" },
    { id: "photos", title: "Photo Evidence" },
    { id: "recommended", title: "Recommended Actions" },
    { id: "priorities", title: "Repair Priorities" },
    { id: "limitations", title: "Limitations" },
    { id: "review-update", title: "Review Update" },
    { id: "review-history", title: "Review History" },
    { id: "approval-status", title: "Approval Status" },
    { id: "delivery-status", title: "Delivery Status" },
  ] as const;
}
