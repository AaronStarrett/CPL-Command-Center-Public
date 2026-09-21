import type { EntityId, IsoDateTime, JsonObject, JsonValue } from "./entities.js";
import type { ServiceCatalogPackage } from "./commercial.js";
import { SYNTHETIC_MERIDIAN_CATALOG } from "./synthetic-catalogs.js";

export const GUIDED_DEMO_SCENARIO_KEY = "meridian-commerce-center";
export const GUIDED_DEMO_SCENARIO_VERSION = "phase34a-v1";
export const GUIDED_DEMO_FEATURE_FLAG_KEY = "guided-meridian-demo";
export const SYNTHETIC_DEMONSTRATION_NOTICE = "SYNTHETIC DEMONSTRATION — NO REAL CLIENT DATA";
export const ILLUSTRATIVE_PRICING_NOTICE = "ILLUSTRATIVE SYNTHETIC PRICING — NOT BEA PRICING";
export const GUIDED_DEMO_PRESET_VOICE_PHRASE =
  "Show me the Meridian Commerce Center inspection report.";
export const GUIDED_DEMO_SIMULATED_COMMAND_LABEL = "SIMULATED AI COMMAND DEMONSTRATION";
export const MERIDIAN_RECIPIENT_EMAIL = "elena.torres@meridian-property.invalid";
export const OWNER_DELIVERY_CHANGE_DEFAULT_REASON =
  "Clarify the recommended repair priority before release.";
export const OWNER_DELIVERY_CHANGE_REASON_MAX = 500;
export const MERIDIAN_REPORT_WORKSPACE_SCHEMA = "bea.meridian-report-workspace.v1";

export const SEEDED_MERIDIAN_IDS = {
  company: "93400000-0000-4000-8000-000000000001",
  contact: "93400000-0000-4000-8000-000000000002",
  catalog: "e1000000-0000-4000-8000-000000000004",
  catalogVersion: "e1100000-0000-4000-8000-000000000004",
  featureFlag: "40000000-0000-4000-8000-000000000008",
  initialRun: "d3400000-0000-4000-8000-000000000001",
} as const;

export const GUIDED_DEMO_STAGE_KEYS = [
  "lead_intake",
  "information_check",
  "proposal",
  "customer_decision",
  "project_setup",
  "inspection",
  "data_validation",
  "report_assembly",
  "technical_review",
  "executive_approval",
  "client_delivery",
  "billing_closeout",
] as const;
export type GuidedDemoStageKey = (typeof GUIDED_DEMO_STAGE_KEYS)[number];

export const GUIDED_DEMO_MACHINE_STATES = [
  "not_started",
  "lead_intake_processing",
  "information_check_processing",
  "waiting_roof_authorization",
  "proposal_processing",
  "waiting_proposal_approval",
  "proposal_revision_processing",
  "customer_decision_processing",
  "project_setup_processing",
  "inspection_processing",
  "validation_processing",
  "report_assembly_processing",
  "report_assembly_failed",
  "waiting_technical_review",
  "report_revision_processing",
  "waiting_delivery_authorization",
  "delivery_processing",
  "closeout_processing",
  "completed",
  "paused",
  "archived",
] as const;
export type GuidedDemoMachineState = (typeof GUIDED_DEMO_MACHINE_STATES)[number];

export const GUIDED_DEMO_RUN_STATUSES = [
  "not_started",
  "running",
  "paused",
  "waiting_for_human",
  "failed",
  "completed",
  "archived",
] as const;
export type GuidedDemoRunStatus = (typeof GUIDED_DEMO_RUN_STATUSES)[number];

export const GUIDED_DEMO_SPEED_MODES = ["normal", "fast"] as const;
export type GuidedDemoSpeedMode = (typeof GUIDED_DEMO_SPEED_MODES)[number];

export const GUIDED_DEMO_BACKING_TYPES = [
  "runtime_backed",
  "guided_demonstration",
  "local_test_no_write",
] as const;
export type GuidedDemoBackingType = (typeof GUIDED_DEMO_BACKING_TYPES)[number];

export const GUIDED_DEMO_NODE_STATUSES = [
  "waiting",
  "queued",
  "processing",
  "completed",
  "human_decision_required",
  "failed",
  "guided_demonstration_only",
] as const;
export type GuidedDemoNodeStatus = (typeof GUIDED_DEMO_NODE_STATUSES)[number];

export const GUIDED_DEMO_DECISION_KEYS = [
  "add_simulated_authorization",
  "approve_simulated_management_override",
  "approve_proposal",
  "request_proposal_changes",
  "approve_technical_content",
  "request_technical_changes",
  "authorize_demo_delivery",
  "request_delivery_changes",
] as const;
export type GuidedDemoDecisionKey = (typeof GUIDED_DEMO_DECISION_KEYS)[number];

export const GUIDED_DEMO_ACTIONS = [
  "create_or_get",
  "start",
  "pause",
  "resume",
  "run_to_next_decision",
  "advance_one_stage",
  "tick",
  "submit_human_decision",
  "request_proposal_changes",
  "approve_proposal",
  "simulate_customer_decision",
  "prepare_project_bridge",
  "run_inspection_stage",
  "run_validation_stage",
  "run_report_assembly_stage",
  "request_technical_changes",
  "approve_technical_content",
  "request_delivery_changes",
  "authorize_demo_delivery",
  "inject_failure",
  "retry_failure",
  "restart",
  "reset",
  "get_snapshot",
  "get_events",
  "route_command",
] as const;
export type GuidedDemoAction = (typeof GUIDED_DEMO_ACTIONS)[number];

export const GUIDED_DEMO_COMMAND_INTENTS = [
  "open_meridian_report",
  "show_current_blocker",
  "show_workflow",
  "explain_next_step",
  "unsupported_demo_command",
] as const;
export type GuidedDemoCommandIntent = (typeof GUIDED_DEMO_COMMAND_INTENTS)[number];

export const GUIDED_DEMO_TRUTH_LABELS = {
  runtime_backed: "RUNTIME-BACKED",
  guided_demonstration: "GUIDED DEMONSTRATION",
  local_test_no_write: "LOCAL TEST / NO-WRITE",
} as const;

export const GUIDED_DEMO_SPEED_MS: Readonly<Record<GuidedDemoSpeedMode, number>> = {
  normal: 2_000,
  fast: 800,
};

export const GUIDED_DEMO_MOTION = {
  hoverMs: 150,
  cardMs: 210,
  drawerMs: 320,
  orbMs: 470,
  stageMs: 350,
  pulseMs: 1_400,
} as const;

export interface GuidedDemoStageDefinition {
  readonly key: GuidedDemoStageKey;
  readonly order: number;
  readonly title: string;
  readonly group: "intake_commercial" | "project_field" | "reporting_delivery";
  readonly ownerRoleKey: "system" | "owner-admin" | "sales" | "operations";
  readonly backingType: GuidedDemoBackingType;
  readonly activities: readonly string[];
  readonly packetLabel: string;
  readonly truthDetail: string;
}

export const GUIDED_DEMO_STAGES: readonly GuidedDemoStageDefinition[] = [
  {
    key: "lead_intake",
    order: 1,
    title: "Lead Intake",
    group: "intake_commercial",
    ownerRoleKey: "system",
    backingType: "runtime_backed",
    activities: [
      "Receiving website inquiry",
      "Adding phone notes",
      "Combining client and property records",
      "Creating Lead Command Record",
    ],
    packetLabel: "Inquiry",
    truthDetail: "Uses the implemented BEA application workflow.",
  },
  {
    key: "information_check",
    order: 2,
    title: "Information Check",
    group: "intake_commercial",
    ownerRoleKey: "sales",
    backingType: "runtime_backed",
    activities: [
      "Checking required client information",
      "Checking property details",
      "Checking access requirements",
      "Reviewing supplied documents",
    ],
    packetLabel: "Lead record",
    truthDetail: "Uses the implemented BEA application workflow.",
  },
  {
    key: "proposal",
    order: 3,
    title: "Proposal",
    group: "intake_commercial",
    ownerRoleKey: "owner-admin",
    backingType: "runtime_backed",
    activities: [
      "Selecting synthetic service package",
      "Creating deterministic pricing snapshot",
      "Compiling scope and assumptions",
      "Rendering Proposal Version 1",
      "Sending Proposal to internal review",
    ],
    packetLabel: "Proposal v1",
    truthDetail: "Uses the implemented BEA application workflow.",
  },
  {
    key: "customer_decision",
    order: 4,
    title: "Customer Decision",
    group: "intake_commercial",
    ownerRoleKey: "system",
    backingType: "guided_demonstration",
    activities: [
      "Preparing customer delivery plan",
      "Recording simulated customer response",
      "Confirming demonstration acceptance",
    ],
    packetLabel: "Acceptance",
    truthDetail:
      "GUIDED DEMONSTRATION STAGE — CLIENT ACCEPTANCE IS NOT YET CONNECTED. Visually represents a future integration or process stage that is not yet connected.",
  },
  {
    key: "project_setup",
    order: 5,
    title: "Project Setup",
    group: "project_field",
    ownerRoleKey: "operations",
    backingType: "guided_demonstration",
    activities: [
      "Preparing project record",
      "Linking client, proposal, and service scope",
      "Assigning synthetic inspection workflow",
      "Creating project checklist",
      "Project setup ready",
    ],
    packetLabel: "Project record",
    truthDetail:
      "GUIDED DEMONSTRATION STAGE — FULL AWARD-TO-PROJECT AUTOMATION IS DEFERRED. Visually represents a future integration or process stage that is not yet connected.",
  },
  {
    key: "inspection",
    order: 6,
    title: "Inspection",
    group: "project_field",
    ownerRoleKey: "operations",
    backingType: "runtime_backed",
    activities: [
      "Opening inspection package",
      "Importing inspection observations",
      "Normalizing twelve synthetic photos",
      "Linking evidence to observed conditions",
      "Recording inspection completion",
    ],
    packetLabel: "12 photos",
    truthDetail: "Uses the implemented BEA application workflow.",
  },
  {
    key: "data_validation",
    order: 7,
    title: "Data Validation",
    group: "project_field",
    ownerRoleKey: "system",
    backingType: "runtime_backed",
    activities: [
      "Preserving raw inspection source",
      "Mapping source fields to canonical records",
      "Checking required findings",
      "Checking evidence relationships",
      "Checking report completeness",
      "Validation passed",
    ],
    packetLabel: "3 findings",
    truthDetail: "Uses the implemented BEA application workflow.",
  },
  {
    key: "report_assembly",
    order: 8,
    title: "Report Assembly",
    group: "reporting_delivery",
    ownerRoleKey: "system",
    backingType: "runtime_backed",
    activities: [
      "Assembling report sections",
      "Adding three findings",
      "Placing twelve synthetic photos",
      "Adding recommendations",
      "Rendering report artifact",
      "Creating Report Version 1",
    ],
    packetLabel: "Report v1",
    truthDetail: "Uses the implemented BEA application workflow.",
  },
  {
    key: "technical_review",
    order: 9,
    title: "Technical Review",
    group: "reporting_delivery",
    ownerRoleKey: "operations",
    backingType: "runtime_backed",
    activities: ["Waiting for operations technical review"],
    packetLabel: "Approval",
    truthDetail: "Uses the implemented BEA application workflow.",
  },
  {
    key: "executive_approval",
    order: 10,
    title: "Executive Approval",
    group: "reporting_delivery",
    ownerRoleKey: "owner-admin",
    backingType: "runtime_backed",
    activities: ["Waiting for Owner delivery authorization"],
    packetLabel: "Approval",
    truthDetail: "Uses the implemented BEA application workflow.",
  },
  {
    key: "client_delivery",
    order: 11,
    title: "Client Delivery",
    group: "reporting_delivery",
    ownerRoleKey: "system",
    backingType: "local_test_no_write",
    activities: [
      "Validating approved report version",
      "Confirming authorized recipient",
      "Preparing no-send delivery manifest",
      "Recording local-test confirmation",
      "Closing delivery work",
    ],
    packetLabel: "Delivery manifest",
    truthDetail:
      "Uses a synthetic local adapter and does not perform a real external action. No real email, Outlook, Graph, Teams, or SharePoint write occurs.",
  },
  {
    key: "billing_closeout",
    order: 12,
    title: "Billing & Closeout",
    group: "reporting_delivery",
    ownerRoleKey: "system",
    backingType: "guided_demonstration",
    activities: [
      "Preparing closeout summary",
      "Marking demonstration workflow complete",
      "Displaying future billing handoff",
    ],
    packetLabel: "Closeout",
    truthDetail:
      "GUIDED DEMONSTRATION STAGE — BILLING AND ACCOUNTING ARE NOT CONNECTED. Visually represents a future integration or process stage that is not yet connected.",
  },
];

export const GUIDED_DEMO_STAGE_BY_KEY: Readonly<
  Record<GuidedDemoStageKey, GuidedDemoStageDefinition>
> = Object.fromEntries(GUIDED_DEMO_STAGES.map((stage) => [stage.key, stage])) as Readonly<
  Record<GuidedDemoStageKey, GuidedDemoStageDefinition>
>;

const PROCESSING_TO_STAGE: Readonly<Partial<Record<GuidedDemoMachineState, GuidedDemoStageKey>>> = {
  lead_intake_processing: "lead_intake",
  information_check_processing: "information_check",
  waiting_roof_authorization: "information_check",
  proposal_processing: "proposal",
  waiting_proposal_approval: "proposal",
  proposal_revision_processing: "proposal",
  customer_decision_processing: "customer_decision",
  project_setup_processing: "project_setup",
  inspection_processing: "inspection",
  validation_processing: "data_validation",
  report_assembly_processing: "report_assembly",
  report_assembly_failed: "report_assembly",
  waiting_technical_review: "technical_review",
  report_revision_processing: "report_assembly",
  waiting_delivery_authorization: "executive_approval",
  delivery_processing: "client_delivery",
  closeout_processing: "billing_closeout",
  completed: "billing_closeout",
};

export const GUIDED_DEMO_HUMAN_GATE_STATES: readonly GuidedDemoMachineState[] = [
  "waiting_roof_authorization",
  "waiting_proposal_approval",
  "waiting_technical_review",
  "waiting_delivery_authorization",
];

export const GUIDED_DEMO_TRANSITIONS: Readonly<
  Record<GuidedDemoMachineState, readonly GuidedDemoMachineState[]>
> = {
  not_started: ["lead_intake_processing", "archived"],
  lead_intake_processing: ["information_check_processing", "paused", "archived"],
  information_check_processing: ["waiting_roof_authorization", "paused", "archived"],
  waiting_roof_authorization: ["proposal_processing", "paused", "archived"],
  proposal_processing: ["waiting_proposal_approval", "paused", "archived"],
  waiting_proposal_approval: [
    "proposal_revision_processing",
    "customer_decision_processing",
    "paused",
    "archived",
  ],
  proposal_revision_processing: ["waiting_proposal_approval", "paused", "archived"],
  customer_decision_processing: ["project_setup_processing", "paused", "archived"],
  project_setup_processing: ["inspection_processing", "paused", "archived"],
  inspection_processing: ["validation_processing", "paused", "archived"],
  validation_processing: ["report_assembly_processing", "paused", "archived"],
  report_assembly_processing: [
    "waiting_technical_review",
    "report_assembly_failed",
    "paused",
    "archived",
  ],
  report_assembly_failed: ["report_assembly_processing", "paused", "archived"],
  waiting_technical_review: [
    "report_revision_processing",
    "waiting_delivery_authorization",
    "paused",
    "archived",
  ],
  report_revision_processing: ["waiting_technical_review", "paused", "archived"],
  waiting_delivery_authorization: [
    "delivery_processing",
    "report_revision_processing",
    "paused",
    "archived",
  ],
  delivery_processing: ["closeout_processing", "paused", "archived"],
  closeout_processing: ["completed", "paused", "archived"],
  completed: ["archived"],
  paused: ["archived"],
  archived: [],
};

export class GuidedDemoUnavailableError extends Error {
  readonly code = "GUIDED_DEMO_UNAVAILABLE";
  constructor(message = "The Meridian guided demonstration is unavailable outside demo mode.") {
    super(message);
    this.name = "GuidedDemoUnavailableError";
  }
}

export class GuidedDemoConflictError extends Error {
  readonly code = "GUIDED_DEMO_CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "GuidedDemoConflictError";
  }
}

export class GuidedDemoConcurrencyError extends Error {
  readonly code = "GUIDED_DEMO_CONCURRENCY";
  constructor(message = "The demonstration changed before this command completed.") {
    super(message);
    this.name = "GuidedDemoConcurrencyError";
  }
}

export class GuidedDemoAuthorizationError extends Error {
  readonly code = "GUIDED_DEMO_AUTHORIZATION";
  constructor(message = "The current role cannot perform this demonstration action.") {
    super(message);
    this.name = "GuidedDemoAuthorizationError";
  }
}

export class GuidedDemoValidationError extends Error {
  readonly code = "GUIDED_DEMO_VALIDATION";
  constructor(message: string) {
    super(message);
    this.name = "GuidedDemoValidationError";
  }
}

export class GuidedDemoIntegrityError extends Error {
  readonly code = "GUIDED_DEMO_INTEGRITY";
  constructor(message = "Stored Report content is unavailable for this demonstration run.") {
    super(message);
    this.name = "GuidedDemoIntegrityError";
  }
}

export function isGuidedDemoStageKey(value: string): value is GuidedDemoStageKey {
  return (GUIDED_DEMO_STAGE_KEYS as readonly string[]).includes(value);
}

export function isGuidedDemoMachineState(value: string): value is GuidedDemoMachineState {
  return (GUIDED_DEMO_MACHINE_STATES as readonly string[]).includes(value);
}

export function isGuidedDemoAction(value: string): value is GuidedDemoAction {
  return (GUIDED_DEMO_ACTIONS as readonly string[]).includes(value);
}

export function isGuidedDemoRunStatus(value: string): value is GuidedDemoRunStatus {
  return (GUIDED_DEMO_RUN_STATUSES as readonly string[]).includes(value);
}

export function isGuidedDemoDecisionKey(value: string): value is GuidedDemoDecisionKey {
  return (GUIDED_DEMO_DECISION_KEYS as readonly string[]).includes(value);
}

export function isGuidedDemoSpeedMode(value: string): value is GuidedDemoSpeedMode {
  return (GUIDED_DEMO_SPEED_MODES as readonly string[]).includes(value);
}

export function isHumanGateState(state: GuidedDemoMachineState): boolean {
  return GUIDED_DEMO_HUMAN_GATE_STATES.includes(state);
}

export function stageKeyForMachineState(state: GuidedDemoMachineState): GuidedDemoStageKey | null {
  return PROCESSING_TO_STAGE[state] ?? null;
}

export function runStatusForMachineState(state: GuidedDemoMachineState): GuidedDemoRunStatus {
  if (state === "not_started") return "not_started";
  if (state === "paused") return "paused";
  if (state === "archived") return "archived";
  if (state === "completed") return "completed";
  if (state === "report_assembly_failed") return "failed";
  if (isHumanGateState(state)) return "waiting_for_human";
  return "running";
}

export function assertGuidedDemoTransition(
  from: GuidedDemoMachineState,
  to: GuidedDemoMachineState,
): void {
  if (from === to) {
    throw new GuidedDemoConflictError(`Demonstration is already in ${from}.`);
  }
  if (from === "paused") {
    throw new GuidedDemoConflictError("Resume the demonstration before changing stages.");
  }
  if (!GUIDED_DEMO_TRANSITIONS[from].includes(to)) {
    throw new GuidedDemoConflictError(`Demonstration cannot move from ${from} to ${to}.`);
  }
}

export function nodeStatusForMachineState(
  stageKey: GuidedDemoStageKey,
  machineState: GuidedDemoMachineState,
  completedStageKeys: readonly GuidedDemoStageKey[],
): GuidedDemoNodeStatus {
  if (completedStageKeys.includes(stageKey) && stageKeyForMachineState(machineState) !== stageKey) {
    return "completed";
  }
  if (machineState === "not_started" || machineState === "archived") return "waiting";
  const active = stageKeyForMachineState(machineState);
  if (active !== stageKey) {
    const activeOrder = active ? GUIDED_DEMO_STAGE_BY_KEY[active].order : 0;
    const stageOrder = GUIDED_DEMO_STAGE_BY_KEY[stageKey].order;
    if (stageOrder < activeOrder) return "completed";
    if (stageOrder === activeOrder + 1) return "queued";
    return "waiting";
  }
  if (machineState === "report_assembly_failed") return "failed";
  if (isHumanGateState(machineState)) return "human_decision_required";
  if (
    machineState === "proposal_revision_processing" ||
    machineState === "report_revision_processing"
  ) {
    return "processing";
  }
  if (GUIDED_DEMO_STAGE_BY_KEY[stageKey].backingType === "guided_demonstration") {
    return machineState.endsWith("_processing") ? "processing" : "guided_demonstration_only";
  }
  return "processing";
}

export const GUIDED_DEMO_STATUS_COLORS: Readonly<
  Record<GuidedDemoNodeStatus, { readonly token: string; readonly label: string }>
> = {
  waiting: { token: "waiting-gray", label: "Waiting" },
  queued: { token: "waiting-gray", label: "Queued" },
  processing: { token: "processing-green", label: "Processing" },
  completed: { token: "completed-green", label: "Completed" },
  human_decision_required: { token: "human-gate-amber", label: "Human decision required" },
  failed: { token: "failure-red", label: "Failed" },
  guided_demonstration_only: { token: "guided-only-gray", label: "Guided stage" },
};

export function semanticColorForNodeStatus(status: GuidedDemoNodeStatus): string {
  return GUIDED_DEMO_STATUS_COLORS[status].token;
}

export function reducedMotionConfiguration(enabled: boolean): {
  readonly packetTravel: boolean;
  readonly pulse: boolean;
  readonly useShortFade: boolean;
} {
  if (enabled) {
    return { packetTravel: false, pulse: false, useShortFade: true };
  }
  return { packetTravel: true, pulse: true, useShortFade: false };
}

export function normalizeGuidedDemoCommand(input: string): string {
  return input
    .normalize("NFKC")
    .replace(/[“”]/gu, '"')
    .replace(/[‘’]/gu, "'")
    .toLocaleLowerCase("en-US")
    .replace(/[.,!?;:]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

const REPORT_COMMAND_PATTERNS: readonly RegExp[] = [
  /^show me (?:the )?meridian(?: commerce center)?(?: inspection)? report$/,
  /^show (?:the )?meridian(?: commerce center)?(?: inspection)? report$/,
  /^open (?:the )?meridian(?: commerce center)?(?: inspection)? report$/,
  /^let me see (?:the )?meridian(?: commerce center)?(?: inspection)? report$/,
  /^where is (?:the )?meridian(?: commerce center)?(?: inspection)? report$/,
];

export function routeGuidedDemoCommand(input: string): GuidedDemoCommandIntent {
  const normalized = normalizeGuidedDemoCommand(input);
  if (!normalized) return "unsupported_demo_command";
  if (REPORT_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "open_meridian_report";
  }
  if (
    /what is waiting on me/.test(normalized) ||
    /current blocker/.test(normalized) ||
    /needs (?:my|a) decision/.test(normalized)
  ) {
    return "show_current_blocker";
  }
  if (
    /where is the workflow/.test(normalized) ||
    /open automation flow/.test(normalized) ||
    /show(?: me)?(?: the)? workflow/.test(normalized)
  ) {
    return "show_workflow";
  }
  if (
    /what happens after i approve/.test(normalized) ||
    /what happens next/.test(normalized) ||
    /next step/.test(normalized)
  ) {
    return "explain_next_step";
  }
  return "unsupported_demo_command";
}

export interface GuidedDemoCommandSource {
  readonly key: string;
  readonly label: string;
  readonly href?: string;
  readonly sectionId?: string;
  readonly recordId?: string;
}

export interface GuidedDemoCommandResponse {
  readonly intent: GuidedDemoCommandIntent;
  readonly simulated: true;
  readonly label: typeof GUIDED_DEMO_SIMULATED_COMMAND_LABEL;
  readonly message: string;
  readonly openReport: boolean;
  readonly sources: readonly GuidedDemoCommandSource[];
}

export interface GuidedDemoCommandWorkspaceFacts {
  readonly reportId: string;
  readonly reportReference: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly reportStatus: string;
  readonly findingCount: number;
  readonly highPriorityCount: number;
  readonly mediumPriorityCount: number;
  readonly technicallyApproved: boolean;
  readonly deliveryConfirmed: boolean;
  readonly deliveryAuthorizationStatus: string | null;
  readonly inspectionId?: string;
}

export function mapGuidedDemoCommandResponse(input: {
  readonly intent: GuidedDemoCommandIntent;
  readonly machineState: GuidedDemoMachineState;
  readonly currentStageTitle: string;
  readonly reportReference: string | null;
  readonly reportVersionNumber: number | null;
  readonly workspace?: GuidedDemoCommandWorkspaceFacts | null;
  readonly workspaceUnavailable?: boolean;
}): GuidedDemoCommandResponse {
  const label = GUIDED_DEMO_SIMULATED_COMMAND_LABEL;
  if (input.intent === "unsupported_demo_command") {
    return {
      intent: input.intent,
      simulated: true,
      label,
      openReport: false,
      sources: [],
      message:
        "I can demonstrate the Meridian report, current blocker, workflow status, and next step in this synthetic experience.",
    };
  }
  if (input.intent === "show_workflow") {
    return {
      intent: input.intent,
      simulated: true,
      label,
      openReport: false,
      sources: [{ key: "flow", label: "Automation Flow", href: "/automation-flow" }],
      message: `The Meridian Commerce Center workflow is currently at ${input.currentStageTitle}.`,
    };
  }
  if (input.intent === "show_current_blocker") {
    const gate =
      input.machineState === "waiting_roof_authorization"
        ? "Roof Access Authorization is missing, so automation paused for a human decision."
        : input.machineState === "waiting_proposal_approval"
          ? "Proposal review is waiting for Owner commercial approval."
          : input.machineState === "waiting_technical_review"
            ? "Technical review is waiting for an operations decision."
            : input.machineState === "waiting_delivery_authorization"
              ? "The report is technically approved and ready for Owner delivery authorization. No delivery has occurred."
              : input.machineState === "report_assembly_failed"
                ? "Report rendering paused because synthetic photo metadata validation failed."
                : `Nothing is waiting on you. The workflow is at ${input.currentStageTitle}.`;
    return {
      intent: input.intent,
      simulated: true,
      label,
      openReport: false,
      sources: [{ key: "flow", label: "Automation Flow", href: "/automation-flow" }],
      message: gate,
    };
  }
  if (input.intent === "explain_next_step") {
    const next =
      input.machineState === "waiting_roof_authorization"
        ? "After the authorization decision, automation continues to Proposal."
        : input.machineState === "waiting_proposal_approval"
          ? "After Owner approval, the guided customer-decision stage runs. No proposal is sent."
          : input.machineState === "waiting_technical_review"
            ? "Technical approval still does not send the report. Owner delivery authorization remains separate."
            : input.machineState === "waiting_delivery_authorization"
              ? "Owner authorization confirms a local-test, no-send delivery. No real email is sent."
              : `The next visible step is ${input.currentStageTitle}.`;
    return {
      intent: input.intent,
      simulated: true,
      label,
      openReport: false,
      sources: [{ key: "flow", label: "Automation Flow", href: "/automation-flow" }],
      message: next,
    };
  }
  if (!input.reportReference) {
    return {
      intent: input.intent,
      simulated: true,
      label,
      openReport: false,
      sources: [{ key: "flow", label: "Automation Flow", href: "/automation-flow" }],
      message: `The Meridian Commerce Center report has not been assembled yet. The workflow is currently at ${input.currentStageTitle}.`,
    };
  }
  if (input.workspaceUnavailable || !input.workspace) {
    return {
      intent: input.intent,
      simulated: true,
      label,
      openReport: true,
      sources: [
        {
          key: "report",
          label: "Open Full Report Record",
        },
        { key: "flow", label: "Automation Flow", href: "/automation-flow" },
      ],
      message:
        "Stored Report content is unavailable for this demonstration run. I will not invent Report facts. Open the full Report record or return to Automation Flow.",
    };
  }
  const workspace = input.workspace;
  const version = workspace.versionNumber;
  const sources: GuidedDemoCommandSource[] = [
    {
      key: "report",
      label: "Report",
      sectionId: "cover",
      href: `/reports/${encodeURIComponent(workspace.reportId)}`,
      recordId: workspace.reportId,
    },
    {
      key: "inspection",
      label: "Inspection",
      sectionId: "property",
      ...(workspace.inspectionId
        ? {
            href: `/inspections/${encodeURIComponent(workspace.inspectionId)}`,
            recordId: workspace.inspectionId,
          }
        : {}),
    },
    {
      key: "findings",
      label: "Findings",
      sectionId: "findings",
      recordId: workspace.versionId,
    },
    {
      key: "review",
      label: "Review History",
      sectionId: "review-history",
      recordId: workspace.versionId,
    },
    {
      key: "delivery",
      label: "Delivery Status",
      sectionId: "delivery-status",
      recordId: workspace.reportId,
    },
    { key: "flow", label: "Automation Flow", href: "/automation-flow" },
  ];
  const findingSummary = `${workspace.findingCount} finding${workspace.findingCount === 1 ? "" : "s"}: ${workspace.highPriorityCount} high priority and ${workspace.mediumPriorityCount} medium priority`;
  if (input.machineState === "waiting_technical_review") {
    return {
      intent: input.intent,
      simulated: true,
      label,
      openReport: true,
      sources,
      message: `I found Meridian Commerce Center Report ${workspace.reportReference}, Version ${version}. It contains ${findingSummary}. Technical review is waiting for a decision.`,
    };
  }
  if (input.machineState === "waiting_delivery_authorization") {
    return {
      intent: input.intent,
      simulated: true,
      label,
      openReport: true,
      sources,
      message: `I found Meridian Commerce Center Report ${workspace.reportReference}, Version ${version}. It contains ${findingSummary}. The report is technically approved and ready for Owner delivery authorization. No delivery has occurred.`,
    };
  }
  if (input.machineState === "completed" || input.machineState === "closeout_processing") {
    return {
      intent: input.intent,
      simulated: true,
      label,
      openReport: true,
      sources,
      message: `I found Meridian Commerce Center Report ${workspace.reportReference}, Version ${version}. The Meridian Commerce Center report was confirmed through the local demonstration delivery adapter. No real email was sent.`,
    };
  }
  return {
    intent: input.intent,
    simulated: true,
    label,
    openReport: true,
    sources,
    message: `I found Meridian Commerce Center Report ${workspace.reportReference}, Version ${version}. It contains ${findingSummary}.`,
  };
}

export interface MeridianFinding {
  readonly code: string;
  readonly title: string;
  readonly priority: "High" | "Medium";
  readonly severity: "major" | "minor";
  readonly location: string;
  readonly observation: string;
  readonly recommendation: string;
}

export const MERIDIAN_FINDINGS: readonly MeridianFinding[] = [
  {
    code: "F-1",
    title: "Roof Membrane Puncture Near RTU-4",
    priority: "High",
    severity: "major",
    location: "Southeast corner of RTU-4",
    observation:
      "A localized membrane puncture is visible near the southeast corner of RTU-4. The surrounding surface shows signs of prior temporary repair.",
    recommendation:
      "Complete a qualified membrane repair, verify substrate condition, and inspect adjacent penetrations.",
  },
  {
    code: "F-2",
    title: "Deteriorated Sealant at East-Elevation Control Joints",
    priority: "Medium",
    severity: "minor",
    location: "East elevation control joints",
    observation:
      "Multiple control-joint sealant locations show cracking, adhesion loss, and weathering.",
    recommendation:
      "Remove failed sealant, prepare joint surfaces, and install a compatible replacement system.",
  },
  {
    code: "F-3",
    title: "Moisture Anomaly Near Parapet Transition",
    priority: "High",
    severity: "major",
    location: "East parapet transition",
    observation:
      "A moisture anomaly was identified near the east parapet transition, consistent with the reported interior staining location.",
    recommendation:
      "Perform focused exploratory review and correct transition flashing or membrane continuity deficiencies.",
  },
];

export const MERIDIAN_EVIDENCE_LABELS = [
  "East parapet overview",
  "RTU-4 southeast corner",
  "Membrane puncture close-up",
  "Temporary repair patch",
  "Adjacent roof penetration",
  "East-elevation control joint 1",
  "East-elevation control joint 2",
  "Sealant adhesion loss",
  "Interior staining location",
  "Parapet transition",
  "Moisture anomaly indicator",
  "Roof access path",
] as const;

export const MERIDIAN_WEBSITE_INQUIRY =
  "Meridian Property Group is requesting a building-envelope assessment following recurring water intrusion near the east parapet and several roof penetrations. The client would like inspection findings, repair priorities, and a formal report.";

export const MERIDIAN_PHONE_NOTE =
  "Elena confirmed staining worsens after wind-driven rain. Facilities can provide building plans and previous repair records. Roof access requires a management authorization that has not yet been supplied.";

export const MERIDIAN_CLIENT = {
  companyName: "Meridian Property Group",
  projectName: "Meridian Commerce Center",
  contactName: "Elena Torres",
  contactTitle: "Director of Facilities",
  email: MERIDIAN_RECIPIENT_EMAIL,
  inquiry: MERIDIAN_WEBSITE_INQUIRY,
  phoneNote: MERIDIAN_PHONE_NOTE,
} as const;

export function meridianCatalogPackage(): ServiceCatalogPackage {
  return SYNTHETIC_MERIDIAN_CATALOG;
}

export const MERIDIAN_PROPOSAL_TOTAL_MINOR = 785_000;
export const MERIDIAN_ENVELOPE_MINOR = 650_000;
export const MERIDIAN_MOISTURE_MINOR = 135_000;

export interface GuidedDemoRecordBindings {
  readonly companyId?: string;
  readonly contactId?: string;
  readonly leadId?: string;
  readonly proposalId?: string;
  readonly proposalVersionId?: string;
  readonly catalogVersionId?: string;
  readonly projectId?: string;
  readonly inspectionId?: string;
  readonly submissionId?: string;
  readonly reportId?: string;
  readonly reportVersionId?: string;
  readonly deliveryAuthorizationId?: string;
  readonly exceptionId?: string;
  readonly proposalWorkItemId?: string;
  readonly technicalWorkItemId?: string;
  readonly deliveryWorkItemId?: string;
}

export interface GuidedDemoSnapshot {
  readonly id: EntityId;
  readonly scenarioKey: typeof GUIDED_DEMO_SCENARIO_KEY;
  readonly scenarioVersion: typeof GUIDED_DEMO_SCENARIO_VERSION;
  readonly status: GuidedDemoRunStatus;
  readonly machineState: GuidedDemoMachineState;
  readonly pausedFromState: GuidedDemoMachineState | null;
  readonly currentStageKey: GuidedDemoStageKey | null;
  readonly currentGateKey: GuidedDemoDecisionKey | null;
  readonly speedMode: GuidedDemoSpeedMode;
  readonly currentActivity: string | null;
  readonly currentActivityIndex: number;
  readonly currentBlocker: string | null;
  readonly failureArmed: boolean;
  readonly presentationMode: boolean;
  readonly recordBindings: GuidedDemoRecordBindings;
  readonly optimisticVersion: number;
  readonly startedByUserId: EntityId | null;
  readonly startedAt: IsoDateTime | null;
  readonly pausedAt: IsoDateTime | null;
  readonly completedAt: IsoDateTime | null;
  readonly archivedAt: IsoDateTime | null;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
  readonly stages: readonly GuidedDemoStageState[];
  readonly recentEvents: readonly GuidedDemoEvent[];
}

export interface GuidedDemoStageState {
  readonly stageKey: GuidedDemoStageKey;
  readonly stageOrder: number;
  readonly status: GuidedDemoNodeStatus;
  readonly backingType: GuidedDemoBackingType;
  readonly ownerRoleKey: string;
  readonly currentActivity: string | null;
  readonly inputSummary: JsonObject;
  readonly outputSummary: JsonObject;
  readonly linkedRecords: JsonObject;
  readonly startedAt: IsoDateTime | null;
  readonly completedAt: IsoDateTime | null;
  readonly failedAt: IsoDateTime | null;
}

export interface GuidedDemoEvent {
  readonly id: EntityId;
  readonly sequenceNumber: number;
  readonly stageKey: GuidedDemoStageKey | null;
  readonly eventKind: string;
  readonly plainLanguageMessage: string;
  readonly actorUserId: EntityId | null;
  readonly safeMetadata: JsonObject;
  readonly createdAt: IsoDateTime;
}

export const GUIDED_DEMO_ACTIVITY_COPY = [
  "Website inquiry received",
  "Phone notes added",
  "Lead information combined",
  "Lead Command Record created",
  "Roof Access Authorization missing",
  "Automation paused for human input",
  "Simulated authorization added",
  "Proposal preparation started",
  "Proposal Version 1 created",
  "Proposal review requested",
  "Proposal approved by Owner",
  "Synthetic customer decision recorded",
  "Project setup prepared",
  "Inspection package received",
  "Twelve synthetic photos normalized",
  "Three findings identified",
  "Validation passed",
  "Report draft assembled",
  "Technical review requested",
  "Report changes requested",
  "Report Version 2 assembled",
  "Technical content approved",
  "Owner delivery authorization requested",
  "Demonstration delivery authorized",
  "No-send delivery confirmed",
  "Guided closeout reached",
] as const;

export const GUIDED_DEMO_PRESENTATION_CUES = [
  {
    step: 1,
    cue: "This inquiry came in through two channels. The platform is combining it into one Lead record.",
  },
  {
    step: 2,
    cue: "The system found a required authorization is missing, so automation has paused instead of letting bad data continue.",
  },
  {
    step: 3,
    cue: "After the human decision, the workflow resumes automatically.",
  },
  {
    step: 4,
    cue: "The Proposal is generated from structured data and frozen pricing.",
  },
  {
    step: 5,
    cue: "Technical approval does not send the Report. Owner still controls final delivery.",
  },
  {
    step: 6,
    cue: "The same Report can be retrieved through AI Command without replacing the automation underneath it.",
  },
] as const;

export function presentationCueForState(state: GuidedDemoMachineState): string {
  if (state === "lead_intake_processing" || state === "not_started") {
    return GUIDED_DEMO_PRESENTATION_CUES[0]!.cue;
  }
  if (state === "information_check_processing" || state === "waiting_roof_authorization") {
    return GUIDED_DEMO_PRESENTATION_CUES[1]!.cue;
  }
  if (state === "proposal_processing" || state === "waiting_proposal_approval") {
    return GUIDED_DEMO_PRESENTATION_CUES[3]!.cue;
  }
  if (state === "waiting_technical_review" || state === "waiting_delivery_authorization") {
    return GUIDED_DEMO_PRESENTATION_CUES[4]!.cue;
  }
  if (state === "completed" || state === "closeout_processing") {
    return GUIDED_DEMO_PRESENTATION_CUES[5]!.cue;
  }
  return GUIDED_DEMO_PRESENTATION_CUES[2]!.cue;
}

export function gateKeyForState(state: GuidedDemoMachineState): GuidedDemoDecisionKey | null {
  if (state === "waiting_roof_authorization") return "add_simulated_authorization";
  if (state === "waiting_proposal_approval") return "approve_proposal";
  if (state === "waiting_technical_review") return "approve_technical_content";
  if (state === "waiting_delivery_authorization") return "authorize_demo_delivery";
  return null;
}

export function isAutomatedProcessingState(state: GuidedDemoMachineState): boolean {
  return state.endsWith("_processing");
}

export function guidedDemoRoleCanPerform(
  roleKey: string,
  action: GuidedDemoAction,
  decisionKey?: GuidedDemoDecisionKey,
): boolean {
  if (
    action === "get_snapshot" ||
    action === "get_events" ||
    action === "create_or_get" ||
    action === "route_command"
  ) {
    return true;
  }
  if (roleKey === "executive-readonly") return false;
  if (roleKey === "owner-admin") return true;
  if (action === "submit_human_decision") {
    if (
      decisionKey === "add_simulated_authorization" ||
      decisionKey === "approve_simulated_management_override"
    ) {
      return roleKey === "sales" || roleKey === "owner-admin";
    }
    if (decisionKey === "approve_proposal" || decisionKey === "request_proposal_changes") {
      return roleKey === "owner-admin";
    }
    if (
      decisionKey === "approve_technical_content" ||
      decisionKey === "request_technical_changes"
    ) {
      return roleKey === "operations";
    }
    if (decisionKey === "authorize_demo_delivery" || decisionKey === "request_delivery_changes") {
      return roleKey === "owner-admin";
    }
  }
  if (action === "approve_proposal" || action === "request_proposal_changes") {
    return roleKey === "owner-admin";
  }
  if (action === "approve_technical_content" || action === "request_technical_changes") {
    return roleKey === "operations";
  }
  if (action === "authorize_demo_delivery" || action === "request_delivery_changes") {
    return roleKey === "owner-admin";
  }
  return false;
}

function syntheticDigest(label: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < label.length; index += 1) {
    hash = Math.imul(hash ^ label.charCodeAt(index), 16_777_619);
  }
  const hex = (hash >>> 0).toString(16).padStart(8, "0");
  return `${hex}${hex}${hex}${hex}${hex}${hex}${hex}${hex}`.slice(0, 64);
}

export interface MeridianWorkspaceFindingSeed {
  readonly code: string;
  readonly title: string;
  readonly priority: "High" | "Medium";
  readonly observation: string;
  readonly recommendation: string;
}

export interface MeridianWorkspaceEvidenceSeed {
  readonly label: string;
  readonly findingCode: string;
  readonly kind: "photo";
  readonly caption: string;
  readonly filename: string;
}

export interface MeridianReportWorkspaceDocument {
  readonly schema: typeof MERIDIAN_REPORT_WORKSPACE_SCHEMA;
  readonly title: string;
  readonly client: string;
  readonly project: string;
  readonly contactName: string;
  readonly contactTitle: string;
  readonly syntheticNotice: string;
  readonly versionMarker: string;
  readonly executiveSummary: string;
  readonly propertyDetails: string;
  readonly scope: string;
  readonly documentsReviewed: readonly string[];
  readonly observedConditions: string;
  readonly findings: readonly MeridianWorkspaceFindingSeed[];
  readonly evidence: readonly MeridianWorkspaceEvidenceSeed[];
  readonly recommendations: string;
  readonly repairPriorities: readonly { readonly band: string; readonly text: string }[];
  readonly limitations: string;
  readonly reviewUpdate: string | null;
}

export interface GuidedMeridianFindingView {
  readonly id: string;
  readonly code: string;
  readonly title: string;
  readonly priority: "High" | "Medium";
  readonly observation: string;
  readonly recommendation: string;
  readonly evidenceIds: readonly string[];
}

export interface GuidedMeridianEvidenceView {
  readonly id: string;
  readonly label: string;
  readonly caption: string;
  readonly filename: string;
  readonly findingCode: string | null;
  readonly storageRef: string;
  readonly kind: "photo";
}

export interface GuidedMeridianReviewRecordView {
  readonly versionId: string;
  readonly versionNumber: number;
  readonly decision: string | null;
  readonly comment: string | null;
  readonly reviewedAt: string | null;
  readonly reviewerUserId: string | null;
  readonly historical: boolean;
}

export interface GuidedMeridianReportView {
  readonly reportId: string;
  readonly reportReference: string;
  readonly reportStatus: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly versionStatus: string;
  readonly inspectionId: string;
  readonly inspectionReference: string;
  readonly inspectionCompletedAt: string | null;
  readonly projectId: string;
  readonly projectReference: string;
  readonly projectName: string;
  readonly clientName: string;
  readonly contactName: string;
  readonly contactTitle: string;
  readonly title: string;
  readonly versionMarker: string;
  readonly syntheticNotice: string;
  readonly executiveSummary: string;
  readonly propertyDetails: string;
  readonly scope: string;
  readonly documentsReviewed: readonly string[];
  readonly observedConditions: string;
  readonly findings: readonly GuidedMeridianFindingView[];
  readonly evidence: readonly GuidedMeridianEvidenceView[];
  readonly recommendations: string;
  readonly repairPriorities: readonly { readonly band: string; readonly text: string }[];
  readonly limitations: string;
  readonly reviewUpdate: string | null;
  readonly reviewHistory: readonly GuidedMeridianReviewRecordView[];
  readonly approvalStatus: string;
  readonly technicallyApproved: boolean;
  readonly deliveryAuthorizationStatus: string | null;
  readonly deliveryStatus: string;
  readonly deliveryConfirmed: boolean;
  readonly recipient: string | null;
  readonly artifactChecksum: string | null;
  readonly artifactFilename: string | null;
  readonly artifactStorageRef: string | null;
  readonly findingCount: number;
  readonly highPriorityCount: number;
  readonly mediumPriorityCount: number;
  readonly evidenceCount: number;
  readonly sources: readonly GuidedDemoCommandSource[];
}

export interface GuidedDemoReportConsistencyFacts {
  readonly machineState: GuidedDemoMachineState;
  readonly reportId: string | null;
  readonly boundReportVersionId: string | null;
  readonly reportStatus: string | null;
  readonly currentVersionId: string | null;
  readonly currentVersionReviewDecision: string | null;
  readonly technicallyApproved: boolean;
  readonly activeDeliveryAuthorizationId: string | null;
  readonly confirmedDeliveryVersionId: string | null;
}

export function meridianReportWorkspaceDocument(
  revision = 1,
  options: { readonly reviewComment?: string | null } = {},
): MeridianReportWorkspaceDocument {
  const findings = MERIDIAN_FINDINGS.map((finding) => ({
    code: finding.code,
    title: finding.title,
    priority: finding.priority,
    observation: finding.observation,
    recommendation:
      revision > 1 && finding.code === "F-1"
        ? `${finding.recommendation} Review update: confirm the recommended repair priority before release.`
        : finding.recommendation,
  }));
  const evidence = MERIDIAN_EVIDENCE_LABELS.map((label, index) => ({
    label,
    findingCode: index < 4 ? "F-1" : index < 8 ? "F-2" : "F-3",
    kind: "photo" as const,
    filename: `synthetic-inspection-${String(index + 1).padStart(2, "0")}.svg`,
    caption: `Synthetic inspection image — ${label}`,
  }));
  const reviewComment = options.reviewComment?.trim() || null;
  return {
    schema: MERIDIAN_REPORT_WORKSPACE_SCHEMA,
    title: "Meridian Commerce Center Building Envelope Assessment",
    client: MERIDIAN_CLIENT.companyName,
    project: MERIDIAN_CLIENT.projectName,
    contactName: MERIDIAN_CLIENT.contactName,
    contactTitle: MERIDIAN_CLIENT.contactTitle,
    syntheticNotice: SYNTHETIC_DEMONSTRATION_NOTICE,
    versionMarker:
      revision > 1
        ? `REVIEW UPDATE — Version ${revision}`
        : `ORIGINAL ASSESSMENT — Version ${revision}`,
    executiveSummary:
      revision > 1
        ? `Version ${revision} applies requested review comments to the stored Meridian Commerce Center assessment. Three material findings remain: two high-priority conditions and one medium-priority condition.`
        : "Three material findings were identified: two high-priority conditions and one medium-priority condition. Focus areas are the RTU-4 membrane puncture and the east parapet moisture anomaly.",
    propertyDetails:
      "Multi-building commercial property with office and distribution use. Recent wind-driven rain.",
    scope:
      "Exterior envelope and roof-transition review. Twelve synthetic evidence images. Three findings.",
    documentsReviewed: [
      "Synthetic website inquiry",
      "Synthetic phone note",
      "Synthetic plan record",
      "Synthetic repair-history record",
    ],
    observedConditions:
      "Interior staining near the east parapet. Concern near roof penetrations. Previous sealant repairs.",
    findings,
    evidence,
    recommendations:
      "Complete membrane repair, replace failed sealant, and review parapet transition flashing.",
    repairPriorities: [
      {
        band: "IMMEDIATE / HIGH",
        text: "Roof membrane puncture. Parapet transition moisture anomaly.",
      },
      {
        band: "PLANNED / MEDIUM",
        text: "East-elevation control-joint sealant.",
      },
    ],
    limitations:
      "This is a synthetic demonstration package. It is not a field-verified production report.",
    reviewUpdate:
      revision > 1
        ? (reviewComment ?? "Requested review comments were applied to this stored Report version.")
        : null,
  };
}

export function isMeridianReportWorkspaceDocument(
  value: unknown,
): value is MeridianReportWorkspaceDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schema === MERIDIAN_REPORT_WORKSPACE_SCHEMA &&
    typeof candidate.title === "string" &&
    typeof candidate.versionMarker === "string" &&
    Array.isArray(candidate.findings) &&
    Array.isArray(candidate.evidence)
  );
}

export function parseMeridianReportWorkspaceDocument(
  snapshot: JsonObject,
): MeridianReportWorkspaceDocument | null {
  const direct = snapshot.workspaceDocument;
  if (isMeridianReportWorkspaceDocument(direct)) return direct;
  const payload = snapshot.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const nested = (payload as JsonObject).workspaceDocument;
    if (isMeridianReportWorkspaceDocument(nested)) return nested;
  }
  return null;
}

export function normalizeOwnerDeliveryChangeReason(
  comments: string | undefined,
  presentationMode: boolean,
): string {
  const trimmed = comments?.trim() ?? "";
  if (trimmed) return trimmed.slice(0, OWNER_DELIVERY_CHANGE_REASON_MAX);
  if (presentationMode) return OWNER_DELIVERY_CHANGE_DEFAULT_REASON;
  return "";
}

export function assertGuidedDemoReportConsistency(facts: GuidedDemoReportConsistencyFacts): void {
  if (facts.machineState === "waiting_technical_review") {
    if (!facts.reportId || !facts.boundReportVersionId || !facts.currentVersionId) {
      throw new GuidedDemoIntegrityError(
        "Technical review requires an exact bound Report version.",
      );
    }
    if (facts.boundReportVersionId !== facts.currentVersionId) {
      throw new GuidedDemoIntegrityError(
        "The story Report version does not match the stored current Report version.",
      );
    }
    if (facts.reportStatus !== "in_review" && facts.reportStatus !== "draft_ready") {
      throw new GuidedDemoIntegrityError(
        "Technical review requires the stored Report to be awaiting technical review.",
      );
    }
    if (facts.technicallyApproved || facts.currentVersionReviewDecision === "approve") {
      throw new GuidedDemoIntegrityError(
        "The current Report version still carries a final technical approval.",
      );
    }
    if (facts.activeDeliveryAuthorizationId) {
      throw new GuidedDemoIntegrityError(
        "An active delivery authorization still exists for a Report in technical review.",
      );
    }
    return;
  }
  if (facts.machineState === "waiting_delivery_authorization") {
    if (!facts.reportId || !facts.boundReportVersionId || !facts.currentVersionId) {
      throw new GuidedDemoIntegrityError(
        "Owner delivery authorization requires an exact bound Report version.",
      );
    }
    if (facts.boundReportVersionId !== facts.currentVersionId) {
      throw new GuidedDemoIntegrityError(
        "The story Report version does not match the stored current Report version.",
      );
    }
    if (facts.reportStatus !== "ready_for_delivery") {
      throw new GuidedDemoIntegrityError(
        "Owner delivery authorization requires the stored Report to be ready for delivery.",
      );
    }
    if (!facts.technicallyApproved) {
      throw new GuidedDemoIntegrityError(
        "Owner delivery authorization requires technical approval of the current Report version.",
      );
    }
    if (facts.confirmedDeliveryVersionId) {
      throw new GuidedDemoIntegrityError("A confirmed delivery already exists for this Report.");
    }
    return;
  }
  if (facts.machineState === "delivery_processing") {
    if (!facts.activeDeliveryAuthorizationId) {
      throw new GuidedDemoIntegrityError(
        "Delivery processing requires an active authorization for the current Report version.",
      );
    }
    return;
  }
  if (facts.machineState === "completed") {
    if (
      !facts.confirmedDeliveryVersionId ||
      facts.confirmedDeliveryVersionId !== facts.currentVersionId
    ) {
      throw new GuidedDemoIntegrityError(
        "Completed demonstration delivery must confirm the current bound Report version.",
      );
    }
  }
}

export function meridianInspectionPayload(
  completedAt: string,
  revision = 1,
  options: { readonly reviewComment?: string | null } = {},
): JsonObject {
  const document = meridianReportWorkspaceDocument(revision, options);
  const findings = document.findings.map((finding, index) => {
    const seed = MERIDIAN_FINDINGS[index] ?? MERIDIAN_FINDINGS[0]!;
    return {
      code: finding.code,
      sectionKey: "envelope",
      title: finding.title,
      description: finding.observation,
      severity: seed.severity,
      location: seed.location,
      recommendation: finding.recommendation,
    };
  });
  const evidence = document.evidence.map((item, index) => ({
    findingCode: item.findingCode,
    kind: "photo" as const,
    filename: item.filename,
    contentType: "image/svg+xml",
    sha256: syntheticDigest(`meridian-photo-${revision}-${index}-${item.label}`),
    byteLength: 1024 + index,
    storageRef: `synthetic://meridian/inspection/${revision}/${index + 1}`,
    caption: item.caption,
  }));
  return {
    clientName: MERIDIAN_CLIENT.companyName,
    siteName: MERIDIAN_CLIENT.projectName,
    inspectorName: "Operations Coordinator",
    completedAt,
    serviceKey: "building-envelope-inspection",
    attestation: true,
    summary:
      revision > 1
        ? `Synthetic inspection package revision ${revision}. Applying requested review comments.`
        : "Synthetic building-envelope assessment package for Meridian Commerce Center.",
    weatherNote: "Recent wind-driven rain. Interior staining reported near the east parapet.",
    scope: document.scope,
    workspaceDocument: JSON.parse(JSON.stringify(document)) as JsonValue,
    findings,
    evidence: [
      ...evidence,
      {
        kind: "signature",
        filename: "inspector-attestation.sig",
        contentType: "application/octet-stream",
        sha256: syntheticDigest(`meridian-signature-${revision}`),
        byteLength: 128,
        storageRef: `synthetic://meridian/inspection/${revision}/signature`,
      },
    ],
  };
}

export function activityCopyForStageCompletion(
  stageKey: GuidedDemoStageKey,
  machineState: GuidedDemoMachineState,
): readonly string[] {
  if (stageKey === "lead_intake") {
    return [
      "Website inquiry received",
      "Phone notes added",
      "Lead information combined",
      "Lead Command Record created",
    ];
  }
  if (stageKey === "information_check") {
    return machineState === "waiting_roof_authorization"
      ? ["Roof Access Authorization missing", "Automation paused for human input"]
      : ["Simulated authorization added"];
  }
  if (stageKey === "proposal") {
    if (machineState === "proposal_revision_processing") {
      return ["Applying requested commercial changes"];
    }
    return [
      "Proposal preparation started",
      "Proposal Version 1 created",
      "Proposal review requested",
    ];
  }
  if (stageKey === "customer_decision") return ["Synthetic customer decision recorded"];
  if (stageKey === "project_setup") return ["Project setup prepared"];
  if (stageKey === "inspection") {
    return [
      "Inspection package received",
      "Twelve synthetic photos normalized",
      "Three findings identified",
    ];
  }
  if (stageKey === "data_validation") return ["Validation passed"];
  if (stageKey === "report_assembly") {
    return machineState === "report_revision_processing"
      ? ["Report Version 2 assembled"]
      : ["Report draft assembled", "Technical review requested"];
  }
  if (stageKey === "technical_review") return ["Technical content approved"];
  if (stageKey === "executive_approval") return ["Owner delivery authorization requested"];
  if (stageKey === "client_delivery") {
    return ["Demonstration delivery authorized", "No-send delivery confirmed"];
  }
  if (stageKey === "billing_closeout") return ["Guided closeout reached"];
  return [];
}
