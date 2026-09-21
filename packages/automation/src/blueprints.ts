import {
  BLUEPRINT_KEYS,
  type AutomationBlueprint,
  type BlueprintKey,
  type OperationsEventType,
} from "@bea/domain";

export interface BlueprintDefinition {
  readonly key: BlueprintKey;
  readonly displayName: string;
  readonly blueprintVersion: number;
  readonly triggerEventType: OperationsEventType;
  readonly actions: readonly string[];
  readonly parameters: {
    readonly humanGate: boolean;
    readonly autoResume: boolean;
    readonly maxAttempts: number;
    readonly finalApprovalRequired: boolean;
  };
}

export const INSPECTION_REPORT_BLUEPRINTS: readonly BlueprintDefinition[] = [
  {
    key: "inspection.submission-validation",
    displayName: "Inspection submission validation",
    blueprintVersion: 1,
    triggerEventType: "inspection.submitted",
    actions: ["normalize", "validate", "open-exception-if-failed", "enqueue-assembly-if-passed"],
    parameters: {
      humanGate: false,
      autoResume: true,
      maxAttempts: 3,
      finalApprovalRequired: false,
    },
  },
  {
    key: "report.assembly",
    displayName: "Report assembly",
    blueprintVersion: 1,
    triggerEventType: "inspection.validated",
    actions: ["snapshot-inputs", "render-draft", "create-review-task"],
    parameters: {
      humanGate: false,
      autoResume: true,
      maxAttempts: 3,
      finalApprovalRequired: false,
    },
  },
  {
    key: "report.review",
    displayName: "Report review",
    blueprintVersion: 1,
    triggerEventType: "report.review_requested",
    actions: ["await-reviewer", "record-decision", "resume-revision-or-finalize"],
    parameters: {
      humanGate: true,
      autoResume: true,
      maxAttempts: 1,
      finalApprovalRequired: true,
    },
  },
  {
    key: "report.delivery",
    displayName: "Report delivery",
    blueprintVersion: 1,
    triggerEventType: "report.approved",
    actions: ["render-final", "deliver-through-adapter", "record-receipt-or-exception"],
    parameters: {
      humanGate: false,
      autoResume: true,
      maxAttempts: 3,
      finalApprovalRequired: true,
    },
  },
  {
    key: "sla.escalation",
    displayName: "SLA escalation",
    blueprintVersion: 1,
    triggerEventType: "sla.threshold_crossed",
    actions: ["classify-delay", "notify-owner", "keep-clock-visible"],
    parameters: {
      humanGate: false,
      autoResume: true,
      maxAttempts: 3,
      finalApprovalRequired: false,
    },
  },
  {
    key: "connector.reconciliation",
    displayName: "Connector reconciliation",
    blueprintVersion: 1,
    triggerEventType: "inspection.submitted",
    actions: ["dry-run-only-until-activated"],
    parameters: {
      humanGate: false,
      autoResume: true,
      maxAttempts: 3,
      finalApprovalRequired: false,
    },
  },
];

export function blueprintByKey(key: BlueprintKey): BlueprintDefinition {
  const found = INSPECTION_REPORT_BLUEPRINTS.find((blueprint) => blueprint.key === key);
  if (!found) throw new Error(`Unknown automation blueprint ${key}.`);
  return found;
}

export function isKnownBlueprintKey(value: string): value is BlueprintKey {
  return (BLUEPRINT_KEYS as readonly string[]).includes(value);
}

export function toPersistedBlueprint(
  definition: BlueprintDefinition,
  now: string,
): Omit<AutomationBlueprint, "id"> {
  return {
    key: definition.key,
    displayName: definition.displayName,
    blueprintVersion: definition.blueprintVersion,
    status: "active",
    triggerEventType: definition.triggerEventType,
    actions: definition.actions,
    parameters: definition.parameters,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
}
