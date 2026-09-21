import { randomUUID } from "node:crypto";
import {
  DEMO_PERSONAS,
  GUIDED_DEMO_FEATURE_FLAG_KEY,
  GUIDED_DEMO_SCENARIO_KEY,
  GUIDED_DEMO_SPEED_MS,
  GUIDED_DEMO_STAGE_BY_KEY,
  GuidedDemoAuthorizationError,
  GuidedDemoConcurrencyError,
  GuidedDemoConflictError,
  GuidedDemoIntegrityError,
  GuidedDemoUnavailableError,
  GuidedDemoValidationError,
  ILLUSTRATIVE_PRICING_NOTICE,
  MERIDIAN_CLIENT,
  MERIDIAN_PHONE_NOTE,
  MERIDIAN_RECIPIENT_EMAIL,
  MERIDIAN_WEBSITE_INQUIRY,
  SEEDED_MERIDIAN_IDS,
  SEEDED_OPERATIONS_IDS,
  SYNTHETIC_DEMONSTRATION_NOTICE,
  activityCopyForStageCompletion,
  assertGuidedDemoReportConsistency,
  assertGuidedDemoTransition,
  guidedDemoRoleCanPerform,
  isAutomatedProcessingState,
  isGuidedDemoAction,
  isHumanGateState,
  isOpenWorkItemStatus,
  mapGuidedDemoCommandResponse,
  meridianInspectionPayload,
  normalizeOwnerDeliveryChangeReason,
  routeGuidedDemoCommand,
  stageKeyForMachineState,
  type GuidedDemoAction,
  type GuidedDemoCommandIntent,
  type GuidedDemoCommandResponse,
  type GuidedDemoDecisionKey,
  type GuidedDemoMachineState,
  type GuidedDemoRecordBindings,
  type GuidedDemoSnapshot,
  type GuidedDemoSpeedMode,
  type GuidedDemoStageKey,
} from "@bea/domain";
import type { DatabaseAdapter, SqlExecutor } from "./adapter.js";
import { CommercialWorkflowService } from "./commercial-executor.js";
import { SqlGuidedDemoRepository, type GuidedDemoRunRow } from "./guided-demo-repository.js";
import { SqlLeadRepository } from "./lead-repository.js";
import { loadGuidedMeridianReportView } from "./meridian-report-workspace.js";
import { InspectionReportPipeline } from "./operations-executor.js";
import { nextOperationsReference } from "./operations-repository.js";
import { isUniqueConstraintViolation } from "./unique-constraint.js";

const OWNER = DEMO_PERSONAS[0]!.id;
const SALES = DEMO_PERSONAS[1]!.id;
const OPERATIONS = DEMO_PERSONAS[2]!.id;

export interface GuidedDemoCommandInput {
  readonly action: GuidedDemoAction | string;
  readonly actorUserId: string;
  readonly correlationId: string;
  readonly expectedVersion?: number;
  readonly skipDelay?: boolean;
  readonly decisionKey?: GuidedDemoDecisionKey;
  readonly idempotencyKey?: string;
  readonly comments?: string;
  readonly speedMode?: GuidedDemoSpeedMode;
  readonly presentationMode?: boolean;
  readonly commandText?: string;
}

function flagEnabled(value: unknown): boolean {
  return value === true || value === "t" || value === 1 || value === "1";
}

function activityAt(stageKey: GuidedDemoStageKey, index: number): string {
  const activities = GUIDED_DEMO_STAGE_BY_KEY[stageKey].activities;
  return activities[Math.min(Math.max(index, 0), activities.length - 1)] ?? activities[0]!;
}

function continueInput(input: GuidedDemoCommandInput): GuidedDemoCommandInput {
  return {
    action: input.action,
    actorUserId: input.actorUserId,
    correlationId: input.correlationId,
    skipDelay: true,
    ...(input.decisionKey === undefined ? {} : { decisionKey: input.decisionKey }),
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    ...(input.comments === undefined ? {} : { comments: input.comments }),
    ...(input.speedMode === undefined ? {} : { speedMode: input.speedMode }),
    ...(input.presentationMode === undefined ? {} : { presentationMode: input.presentationMode }),
    ...(input.commandText === undefined ? {} : { commandText: input.commandText }),
  };
}

function mergeBindings(
  base: GuidedDemoRecordBindings,
  extra: { readonly [K in keyof GuidedDemoRecordBindings]?: string | undefined },
): GuidedDemoRecordBindings {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === "string" && value.length > 0) next[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === "") {
      delete next[key];
      continue;
    }
    if (typeof value === "string" && value.length > 0) next[key] = value;
  }
  return next as GuidedDemoRecordBindings;
}

export class GuidedMeridianService {
  readonly repository: SqlGuidedDemoRepository;

  constructor(
    private readonly database: DatabaseAdapter,
    private readonly leads: SqlLeadRepository,
    private readonly commercial: CommercialWorkflowService,
    private readonly operations: InspectionReportPipeline,
    private readonly options: {
      readonly appMode: "demo" | "production";
      readonly now?: () => Date;
    },
  ) {
    this.repository = new SqlGuidedDemoRepository(database);
  }

  private stamp(): string {
    return (this.options.now ?? (() => new Date()))().toISOString();
  }

  async execute(input: GuidedDemoCommandInput): Promise<GuidedDemoSnapshot> {
    if (!isGuidedDemoAction(input.action)) {
      throw new GuidedDemoValidationError("Unknown demonstration action.");
    }
    await this.assertDemoAvailable();
    const roleKey = await this.roleKey(input.actorUserId);
    if (!guidedDemoRoleCanPerform(roleKey, input.action, input.decisionKey)) {
      throw new GuidedDemoAuthorizationError();
    }
    switch (input.action) {
      case "create_or_get":
      case "get_snapshot":
      case "get_events":
        return this.createOrGet(input);
      case "start":
        return this.start(input);
      case "pause":
        return this.pause(input);
      case "resume":
        return this.resume(input);
      case "tick":
        return this.tick(input);
      case "run_to_next_decision":
        return this.runToNextDecision(input);
      case "advance_one_stage":
        return this.advanceOneStage(input);
      case "submit_human_decision":
        return this.submitHumanDecision(input);
      case "request_proposal_changes":
        return this.requestProposalChanges(input);
      case "approve_proposal":
        return this.approveProposal(input);
      case "simulate_customer_decision":
        return this.completeCurrentStage(input, "customer_decision_processing");
      case "prepare_project_bridge":
        return this.completeCurrentStage(input, "project_setup_processing");
      case "run_inspection_stage":
        return this.completeCurrentStage(input, "inspection_processing");
      case "run_validation_stage":
        return this.completeCurrentStage(input, "validation_processing");
      case "run_report_assembly_stage":
        return this.completeCurrentStage(input, "report_assembly_processing");
      case "request_technical_changes":
        return this.requestTechnicalChanges(input);
      case "approve_technical_content":
        return this.approveTechnicalContent(input);
      case "request_delivery_changes":
        return this.requestDeliveryChanges(input);
      case "authorize_demo_delivery":
        return this.authorizeDemoDelivery(input);
      case "inject_failure":
        return this.injectFailure(input);
      case "retry_failure":
        return this.retryFailure(input);
      case "restart":
      case "reset":
        return this.reset(input);
      case "route_command":
        return this.createOrGet(input);
      default: {
        const _never: never = input.action;
        throw new GuidedDemoValidationError(`Unsupported demonstration action: ${String(_never)}`);
      }
    }
  }

  async routeCommand(input: GuidedDemoCommandInput): Promise<{
    readonly snapshot: GuidedDemoSnapshot;
    readonly response: GuidedDemoCommandResponse;
    readonly intent: GuidedDemoCommandIntent;
  }> {
    const snapshot = await this.execute({ ...input, action: "get_snapshot" });
    const intent = routeGuidedDemoCommand(input.commandText ?? "");
    const stageTitle =
      (snapshot.currentStageKey
        ? GUIDED_DEMO_STAGE_BY_KEY[snapshot.currentStageKey].title
        : "Not started") ?? "Not started";
    let reportReference: string | null = null;
    let reportVersionNumber: number | null = null;
    const loaded = await loadGuidedMeridianReportView({
      repository: this.operations.repository,
      bindings: snapshot.recordBindings,
      machineState: snapshot.machineState,
    });
    if (loaded.view) {
      reportReference = loaded.view.reportReference;
      reportVersionNumber = loaded.view.versionNumber;
    } else if (snapshot.recordBindings.reportId) {
      const report = await this.operations.repository.getReport(snapshot.recordBindings.reportId);
      reportReference = report?.reference ?? null;
      reportVersionNumber = report?.currentVersionNumber ?? null;
    }
    return {
      snapshot,
      intent,
      response: mapGuidedDemoCommandResponse({
        intent,
        machineState: snapshot.machineState,
        currentStageTitle: stageTitle,
        reportReference,
        reportVersionNumber,
        workspace: loaded.view
          ? {
              reportId: loaded.view.reportId,
              reportReference: loaded.view.reportReference,
              versionId: loaded.view.versionId,
              versionNumber: loaded.view.versionNumber,
              reportStatus: loaded.view.reportStatus,
              findingCount: loaded.view.findingCount,
              highPriorityCount: loaded.view.highPriorityCount,
              mediumPriorityCount: loaded.view.mediumPriorityCount,
              technicallyApproved: loaded.view.technicallyApproved,
              deliveryConfirmed: loaded.view.deliveryConfirmed,
              deliveryAuthorizationStatus: loaded.view.deliveryAuthorizationStatus,
              inspectionId: loaded.view.inspectionId,
            }
          : null,
        workspaceUnavailable: Boolean(reportReference) && !loaded.view,
      }),
    };
  }

  private async assertDemoAvailable(executor: SqlExecutor = this.database): Promise<void> {
    if (this.options.appMode !== "demo") {
      throw new GuidedDemoUnavailableError();
    }
    const flag = await executor.query<{ enabled: unknown }>(
      "SELECT enabled FROM feature_flags WHERE key=$1",
      [GUIDED_DEMO_FEATURE_FLAG_KEY],
    );
    if (!flagEnabled(flag.rows[0]?.enabled)) {
      throw new GuidedDemoUnavailableError();
    }
  }

  private async roleKey(userId: string): Promise<string> {
    const result = await this.database.query<{ key: string }>(
      `SELECT r.key
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id=$1
        LIMIT 1`,
      [userId],
    );
    return result.rows[0]?.key ?? "";
  }

  private async createOrGet(input: GuidedDemoCommandInput): Promise<GuidedDemoSnapshot> {
    return this.database.transaction(async (transaction) => {
      await this.assertDemoAvailable(transaction);
      let run = await this.repository.lockActiveRun(transaction);
      if (!run) {
        try {
          run = await this.repository.insertFreshRun(transaction, {
            now: this.stamp(),
            catalogVersionId: SEEDED_MERIDIAN_IDS.catalogVersion,
          });
        } catch (error) {
          if (!isUniqueConstraintViolation(error)) throw error;
          run = await this.repository.lockActiveRun(transaction);
        }
      }
      if (!run) throw new GuidedDemoConflictError("The Meridian demonstration run was not found.");
      void input;
      return this.repository.loadSnapshot(run, transaction);
    });
  }

  private async start(input: GuidedDemoCommandInput): Promise<GuidedDemoSnapshot> {
    const started = await this.database.transaction(async (transaction) => {
      await this.assertDemoAvailable(transaction);
      let run = await this.repository.lockActiveRun(transaction);
      if (!run) {
        run = await this.repository.insertFreshRun(transaction, {
          now: this.stamp(),
          catalogVersionId: SEEDED_MERIDIAN_IDS.catalogVersion,
        });
      }
      if (run.machineState !== "not_started") {
        return this.repository.loadSnapshot(run, transaction);
      }
      this.assertExpectedVersion(run, input.expectedVersion);
      const now = this.stamp();
      const next = this.repository.applyMachineState(run, "lead_intake_processing", {
        startedAt: now,
        startedByUserId: input.actorUserId,
        currentActivity: activityAt("lead_intake", 0),
        currentActivityIndex: 0,
        currentBlocker: null,
        speedMode: input.speedMode ?? run.speedMode,
        presentationMode: input.presentationMode ?? run.presentationMode,
      });
      const saved = await this.saveLocked(transaction, next, run.optimisticVersion, now);
      await this.repository.appendEvent(transaction, {
        runId: saved.id,
        stageKey: "lead_intake",
        eventKind: "demo.started",
        message: "Meridian Commerce Center demonstration started.",
        actorUserId: input.actorUserId,
        now,
      });
      return this.repository.loadSnapshot(saved, transaction);
    });
    if (input.skipDelay) return this.runToNextDecision(continueInput(input));
    return started;
  }

  private async pause(input: GuidedDemoCommandInput): Promise<GuidedDemoSnapshot> {
    return this.mutateRun(input, async (run) => {
      if (run.machineState === "paused") return run;
      if (run.machineState === "not_started" || run.machineState === "completed") {
        throw new GuidedDemoConflictError("The demonstration cannot pause in its current state.");
      }
      const now = this.stamp();
      return {
        ...run,
        pausedFromState: run.machineState,
        machineState: "paused",
        status: "paused",
        pausedAt: now,
      };
    });
  }

  private async resume(input: GuidedDemoCommandInput): Promise<GuidedDemoSnapshot> {
    return this.mutateRun(input, async (run) => {
      if (run.machineState !== "paused") {
        if (run.status === "running" || run.status === "waiting_for_human") return run;
        throw new GuidedDemoConflictError("The demonstration is not paused.");
      }
      const restored = run.pausedFromState;
      if (!restored || restored === "paused" || restored === "archived") {
        throw new GuidedDemoConflictError("The demonstration cannot resume.");
      }
      return this.repository.applyMachineState(run, restored, {
        pausedFromState: null,
        pausedAt: null,
      });
    });
  }

  private async tick(input: GuidedDemoCommandInput): Promise<GuidedDemoSnapshot> {
    const run = await this.requireActiveRun();
    if (run.machineState === "paused" || !isAutomatedProcessingState(run.machineState)) {
      if (input.speedMode && input.speedMode !== run.speedMode) {
        return this.mutateRun(input, async (locked) => ({
          ...locked,
          speedMode: input.speedMode!,
        }));
      }
      return this.repository.loadSnapshot(run);
    }
    const stageKey = stageKeyForMachineState(run.machineState);
    if (!stageKey) return this.repository.loadSnapshot(run);
    const activities = GUIDED_DEMO_STAGE_BY_KEY[stageKey].activities;
    const elapsed = Date.parse(this.stamp()) - Date.parse(run.updatedAt);
    const speed = input.speedMode ?? run.speedMode;
    if (!input.skipDelay && elapsed < GUIDED_DEMO_SPEED_MS[speed]) {
      if (input.speedMode && input.speedMode !== run.speedMode) {
        return this.mutateRun(input, async (locked) => ({
          ...locked,
          speedMode: input.speedMode!,
        }));
      }
      return this.repository.loadSnapshot(run);
    }
    const nextIndex = run.currentActivityIndex + 1;
    if (!input.skipDelay && nextIndex < activities.length) {
      return this.mutateRun(input, async (locked) => ({
        ...locked,
        currentActivityIndex: nextIndex,
        currentActivity: activityAt(stageKey, nextIndex),
        ...(input.speedMode ? { speedMode: input.speedMode } : {}),
      }));
    }
    return this.finishProcessingStage(input, run.machineState);
  }

  private async runToNextDecision(input: GuidedDemoCommandInput): Promise<GuidedDemoSnapshot> {
    let snapshot = await this.createOrGet(input);
    if (snapshot.machineState === "not_started") {
      snapshot = await this.start({ ...input, skipDelay: false });
    }
    for (let step = 0; step < 24; step += 1) {
      if (
        snapshot.machineState === "paused" ||
        snapshot.machineState === "completed" ||
        snapshot.machineState === "archived" ||
        snapshot.machineState === "report_assembly_failed" ||
        isHumanGateState(snapshot.machineState)
      ) {
        return snapshot;
      }
      if (!isAutomatedProcessingState(snapshot.machineState)) return snapshot;
      snapshot = await this.finishProcessingStage(continueInput(input), snapshot.machineState);
    }
    return snapshot;
  }

  private async advanceOneStage(input: GuidedDemoCommandInput): Promise<GuidedDemoSnapshot> {
    const run = await this.requireActiveRun();
    if (!isAutomatedProcessingState(run.machineState)) {
      throw new GuidedDemoConflictError("There is no automated stage to advance.");
    }
    return this.finishProcessingStage(input, run.machineState);
  }

  private async completeCurrentStage(
    input: GuidedDemoCommandInput,
    required: GuidedDemoMachineState,
  ): Promise<GuidedDemoSnapshot> {
    const run = await this.requireActiveRun();
    if (run.machineState !== required) {
      throw new GuidedDemoConflictError(
        `Demonstration is at ${run.machineState}, not ${required}.`,
      );
    }
    return this.finishProcessingStage(input, required);
  }

  private async finishProcessingStage(
    input: GuidedDemoCommandInput,
    expectedState: GuidedDemoMachineState,
  ): Promise<GuidedDemoSnapshot> {
    const run = await this.requireActiveRun();
    if (run.machineState !== expectedState) {
      return this.repository.loadSnapshot(run);
    }
    switch (expectedState) {
      case "lead_intake_processing":
        return this.completeLeadIntake(input);
      case "information_check_processing":
        return this.completeInformationCheck(input);
      case "proposal_processing":
      case "proposal_revision_processing":
        return this.completeProposal(input, expectedState);
      case "customer_decision_processing":
        return this.completeCustomerDecision(input);
      case "project_setup_processing":
        return this.completeProjectSetup(input);
      case "inspection_processing":
        return this.completeInspection(input);
      case "validation_processing":
        return this.completeValidation(input);
      case "report_assembly_processing":
      case "report_revision_processing":
        return this.completeReportAssembly(input, expectedState);
      case "delivery_processing":
        return this.transitionTo(input, "closeout_processing", {
          activityStage: "billing_closeout",
          events: [{ kind: "delivery.confirmed", message: "No-send delivery confirmed" }],
        });
      case "closeout_processing":
        return this.transitionTo(input, "completed", {
          activityStage: "billing_closeout",
          events: [{ kind: "closeout.reached", message: "Guided closeout reached" }],
          extra: { completedAt: this.stamp(), currentActivity: null, currentBlocker: null },
        });
      default:
        throw new GuidedDemoConflictError(`No automated completion for ${expectedState}.`);
    }
  }

  private async completeLeadIntake(input: GuidedDemoCommandInput): Promise<GuidedDemoSnapshot> {
    const run = await this.requireActiveRun();
    let bindings = run.recordBindings;
    if (!bindings.leadId) {
      const lead = await this.leads.createLead({
        createdByUserId: SALES,
        reviewerUserId: SALES,
        sourceType: "manual",
        sourceDetails: `Synthetic website inquiry. ${MERIDIAN_WEBSITE_INQUIRY}\n\nSynthetic phone note. ${MERIDIAN_PHONE_NOTE}`,
        receivedAt: this.stamp(),
        opportunityName: MERIDIAN_CLIENT.projectName,
        requestSummary: MERIDIAN_WEBSITE_INQUIRY,
        requestedService: "Building envelope assessment",
        siteName: MERIDIAN_CLIENT.projectName,
        siteCity: "Example City",
        siteRegion: "EX",
        siteCountry: "US",
        desiredDeadlineAt: this.stamp(),
        correlationId: input.correlationId,
        parties: [
          {
            role: "client_company",
            companyId: SEEDED_MERIDIAN_IDS.company,
            contactId: null,
            unmatchedCompanyName: null,
            unmatchedContactName: null,
            unmatchedEmail: null,
            unmatchedPhone: null,
            notes: SYNTHETIC_DEMONSTRATION_NOTICE,
          },
          {
            role: "primary_contact",
            companyId: SEEDED_MERIDIAN_IDS.company,
            contactId: SEEDED_MERIDIAN_IDS.contact,
            unmatchedCompanyName: null,
            unmatchedContactName: MERIDIAN_CLIENT.contactName,
            unmatchedEmail: MERIDIAN_CLIENT.email,
            unmatchedPhone: null,
            notes: SYNTHETIC_DEMONSTRATION_NOTICE,
          },
        ],
      });
      bindings = { ...bindings, leadId: lead.lead.id };
    }
    return this.transitionTo(input, "information_check_processing", {
      bindings,
      activityStage: "information_check",
      events: activityCopyForStageCompletion("lead_intake", "lead_intake_processing").map(
        (message, index) => ({
          kind: `lead.intake.${index}`,
          message,
          stageKey: "lead_intake" as const,
        }),
      ),
    });
  }

  private async completeInformationCheck(
    input: GuidedDemoCommandInput,
  ): Promise<GuidedDemoSnapshot> {
    const run = await this.requireActiveRun();
    const leadId = run.recordBindings.leadId;
    if (!leadId) throw new GuidedDemoConflictError("Lead intake has not created a lead.");
    const lead = await this.leads.getLead(leadId);
    if (!lead) throw new GuidedDemoConflictError("The Meridian lead was not found.");
    if (lead.lead.status === "new") {
      await this.leads.transitionStatus({
        leadId,
        toStatus: "needs_info",
        reason: "Roof Access Authorization is missing (synthetic).",
        expectedVersion: lead.lead.version,
        actorUserId: SALES,
        correlationId: input.correlationId,
      });
    }
    return this.transitionTo(input, "waiting_roof_authorization", {
      activityStage: "information_check",
      blocker: "Roof Access Authorization required",
      events: [
        {
          kind: "roof.missing",
          message: "Roof Access Authorization missing",
          stageKey: "information_check",
        },
        {
          kind: "automation.paused",
          message: "Automation paused for human input",
          stageKey: "information_check",
        },
      ],
    });
  }

  private async completeProposal(
    input: GuidedDemoCommandInput,
    from: GuidedDemoMachineState,
  ): Promise<GuidedDemoSnapshot> {
    const run = await this.requireActiveRun();
    const leadId = run.recordBindings.leadId;
    if (!leadId) throw new GuidedDemoConflictError("A lead is required before Proposal.");
    let proposalId = run.recordBindings.proposalId;
    if (!proposalId) {
      const created = await this.commercial.createProposalFromLead({
        leadId,
        actorUserId: SALES,
        correlationId: input.correlationId,
        catalogVersionId: SEEDED_MERIDIAN_IDS.catalogVersion,
        assignedReviewerUserId: OWNER,
      });
      proposalId = created.record.proposal.id;
    }
    let record = await this.commercial.repository.getProposal(proposalId);
    if (!record) throw new GuidedDemoConflictError("The Meridian proposal was not found.");
    if (record.proposal.status === "draft" || record.proposal.status === "needs_information") {
      record = await this.commercial.updateDraft({
        proposalId,
        actorUserId: SALES,
        correlationId: `${input.correlationId}:draft`,
        expectedVersion: record.proposal.version,
        assignedReviewerUserId: OWNER,
        opportunityName: MERIDIAN_CLIENT.projectName,
        scopeText: `${SYNTHETIC_DEMONSTRATION_NOTICE} ${ILLUSTRATIVE_PRICING_NOTICE} Synthetic envelope diagnostic assessment and moisture-scan allowance for Meridian Commerce Center.`,
        deliverables: [
          "Building envelope assessment report",
          "Repair-priority summary",
          "Photographic evidence index",
        ],
        assumptions: [
          "Roof Access Authorization is provided before inspection.",
          "Building plans and prior repair notes are available for review.",
        ],
        exclusions: ["Destructive testing", "Repair design", "Live client delivery"],
        lines: [
          { serviceKey: "syn-meridian-envelope-diagnostic", quantityScaled: 10_000 },
          { serviceKey: "syn-meridian-moisture-scan", quantityScaled: 10_000 },
        ],
      });
    }
    if (record.proposal.status === "revision_required") {
      record = await this.commercial.updateDraft({
        proposalId,
        actorUserId: SALES,
        correlationId: `${input.correlationId}:revision`,
        expectedVersion: record.proposal.version,
        assignedReviewerUserId: OWNER,
        scopeText: `${record.proposal.scopeText ?? ""} Applying requested commercial changes. ${ILLUSTRATIVE_PRICING_NOTICE}`,
      });
    }
    if (record.proposal.status === "ready_for_review") {
      record = await this.commercial.submitForReview({
        proposalId,
        actorUserId: SALES,
        correlationId: `${input.correlationId}:submit`,
        expectedVersion: record.proposal.version,
      });
    }
    const work = await this.operations.workControl?.repository.listWorkItems({
      proposalId,
      kinds: ["proposal_review"],
      limit: 5,
    });
    const currentVersion = record.versions.find(
      (version) => version.versionNumber === record.proposal.currentVersionNumber,
    );
    return this.transitionTo(input, "waiting_proposal_approval", {
      bindings: mergeBindings(run.recordBindings, {
        proposalId,
        proposalVersionId: currentVersion?.id,
        catalogVersionId: record.proposal.catalogVersionId,
        proposalWorkItemId: work?.[0]?.id,
      }),
      activityStage: "proposal",
      blocker: "Owner commercial approval required",
      events:
        from === "proposal_revision_processing"
          ? [
              {
                kind: "proposal.revision.ready",
                message: "Proposal review requested",
                stageKey: "proposal" as const,
              },
            ]
          : activityCopyForStageCompletion("proposal", "proposal_processing").map(
              (message, index) => ({
                kind: `proposal.prepare.${index}`,
                message,
                stageKey: "proposal" as const,
              }),
            ),
    });
  }

  private async completeCustomerDecision(
    input: GuidedDemoCommandInput,
  ): Promise<GuidedDemoSnapshot> {
    return this.transitionTo(input, "project_setup_processing", {
      activityStage: "project_setup",
      events: [
        {
          kind: "customer.guided",
          message: "Synthetic customer decision recorded",
          stageKey: "customer_decision",
        },
      ],
    });
  }

  private async completeProjectSetup(input: GuidedDemoCommandInput): Promise<GuidedDemoSnapshot> {
    const run = await this.requireActiveRun();
    let bindings = run.recordBindings;
    if (!bindings.projectId || !bindings.inspectionId) {
      const created = await this.insertProjectBridge(run);
      bindings = { ...bindings, ...created };
    }
    return this.transitionTo(input, "inspection_processing", {
      bindings,
      activityStage: "inspection",
      events: [
        {
          kind: "project.prepared",
          message: "Project setup prepared",
          stageKey: "project_setup",
        },
      ],
    });
  }

  private async completeInspection(input: GuidedDemoCommandInput): Promise<GuidedDemoSnapshot> {
    const run = await this.requireActiveRun();
    const inspectionId = run.recordBindings.inspectionId;
    if (!inspectionId)
      throw new GuidedDemoConflictError("Project setup has not created an inspection.");
    const revision = run.recordBindings.submissionId ? 2 : 1;
    const inspection = await this.operations.repository.getInspection(inspectionId);
    const completedAt = inspection?.completedAt ?? this.stamp();
    const submitted = await this.operations.submitInspection({
      inspectionId,
      sourceChannel: "direct_entry",
      sourceIdempotencyKey: `${run.id}:inspection:v${revision}`,
      payload: meridianInspectionPayload(completedAt, revision),
      actorUserId: OPERATIONS,
      correlationId: input.correlationId,
      recipients: [MERIDIAN_RECIPIENT_EMAIL],
    });
    const report = await this.operations.repository.getReportByInspection(inspectionId);
    const versions = report ? await this.operations.repository.listReportVersions(report.id) : [];
    const currentVersion = versions.find(
      (version) => version.versionNumber === report?.currentVersionNumber,
    );
    return this.transitionTo(input, "validation_processing", {
      bindings: mergeBindings(run.recordBindings, {
        inspectionId,
        submissionId: submitted.submission.id,
        reportId: report?.id,
        reportVersionId: currentVersion?.id,
      }),
      activityStage: "data_validation",
      events: activityCopyForStageCompletion("inspection", "inspection_processing").map(
        (message, index) => ({
          kind: `inspection.${index}`,
          message,
          stageKey: "inspection" as const,
        }),
      ),
    });
  }

  private async completeValidation(input: GuidedDemoCommandInput): Promise<GuidedDemoSnapshot> {
    const run = await this.requireActiveRun();
    const inspectionId = run.recordBindings.inspectionId;
    if (!inspectionId) throw new GuidedDemoConflictError("Inspection is missing.");
    const report = await this.operations.repository.getReportByInspection(inspectionId);
    const versions = report ? await this.operations.repository.listReportVersions(report.id) : [];
    const currentVersion = versions.find(
      (version) => version.versionNumber === report?.currentVersionNumber,
    );
    return this.transitionTo(input, "report_assembly_processing", {
      bindings: mergeBindings(run.recordBindings, {
        reportId: report?.id ?? run.recordBindings.reportId,
        reportVersionId: currentVersion?.id ?? run.recordBindings.reportVersionId,
      }),
      activityStage: "report_assembly",
      events: [
        {
          kind: "validation.passed",
          message: "Validation passed",
          stageKey: "data_validation",
        },
      ],
    });
  }

  private async completeReportAssembly(
    input: GuidedDemoCommandInput,
    from: GuidedDemoMachineState,
  ): Promise<GuidedDemoSnapshot> {
    const run = await this.requireActiveRun();
    if (run.failureArmed && from === "report_assembly_processing") {
      return this.failReportAssembly(input, run);
    }
    const inspectionId = run.recordBindings.inspectionId;
    if (!inspectionId) throw new GuidedDemoConflictError("Inspection is missing.");
    if (from === "report_revision_processing") {
      const inspection = await this.operations.repository.getInspection(inspectionId);
      const existingReport = run.recordBindings.reportId
        ? await this.operations.repository.getReport(run.recordBindings.reportId)
        : await this.operations.repository.getReportByInspection(inspectionId);
      if (!existingReport) throw new GuidedDemoConflictError("The report is not bound.");
      if (existingReport.status !== "revision_required") {
        throw new GuidedDemoIntegrityError(
          "Report Assembly cannot create a new version until the stored Report is in revision.",
        );
      }
      const previousVersions = await this.operations.repository.listReportVersions(
        existingReport.id,
      );
      const previousVersion = previousVersions.find(
        (version) => version.versionNumber === existingReport.currentVersionNumber,
      );
      const nextRevision = existingReport.currentVersionNumber + 1;
      const completedAt = inspection?.completedAt ?? this.stamp();
      const submitted = await this.operations.submitInspection({
        inspectionId,
        sourceChannel: "direct_entry",
        sourceIdempotencyKey: `${run.id}:inspection:revision:${existingReport.currentVersionNumber}`,
        payload: meridianInspectionPayload(completedAt, nextRevision, {
          reviewComment: input.comments ?? previousVersion?.reviewComment ?? null,
        }),
        actorUserId: OPERATIONS,
        correlationId: input.correlationId,
        recipients: [MERIDIAN_RECIPIENT_EMAIL],
      });
      const report = await this.operations.repository.getReportByInspection(inspectionId);
      const versions = report ? await this.operations.repository.listReportVersions(report.id) : [];
      const currentVersion = versions.find(
        (version) => version.versionNumber === report?.currentVersionNumber,
      );
      if (!report || !currentVersion || report.status !== "in_review") {
        throw new GuidedDemoIntegrityError("The revised Report did not reach technical review.");
      }
      await this.assertReportStoryConsistency(
        "waiting_technical_review",
        mergeBindings(run.recordBindings, {
          reportId: report.id,
          reportVersionId: currentVersion.id,
          deliveryAuthorizationId: undefined,
        }),
      );
      const work = await this.operations.workControl?.repository.listWorkItems({
        inspectionId: report.inspectionId,
        kinds: ["report_technical_review"],
        limit: 10,
      });
      const openTechnical = work?.find((item) => isOpenWorkItemStatus(item.status));
      return this.transitionTo(input, "waiting_technical_review", {
        bindings: mergeBindings(run.recordBindings, {
          submissionId: submitted.submission.id,
          reportId: report.id,
          reportVersionId: currentVersion.id,
          technicalWorkItemId: openTechnical?.id,
          deliveryAuthorizationId: undefined,
        }),
        activityStage: "technical_review",
        blocker: "Operations technical review required",
        extra: { failureArmed: false },
        events: [
          {
            kind: `report.v${currentVersion.versionNumber}`,
            message: `Report Version ${currentVersion.versionNumber} was prepared for technical review.`,
            stageKey: "report_assembly",
          },
        ],
      });
    }
    const report = run.recordBindings.reportId
      ? await this.operations.repository.getReport(run.recordBindings.reportId)
      : await this.operations.repository.getReportByInspection(inspectionId);
    const versions = report ? await this.operations.repository.listReportVersions(report.id) : [];
    const currentVersion = versions.find(
      (version) => version.versionNumber === report?.currentVersionNumber,
    );
    const work = report
      ? await this.operations.workControl?.repository.listWorkItems({
          inspectionId: report.inspectionId,
          kinds: ["report_technical_review"],
          limit: 5,
        })
      : undefined;
    return this.transitionTo(input, "waiting_technical_review", {
      bindings: mergeBindings(run.recordBindings, {
        reportId: report?.id,
        reportVersionId: currentVersion?.id,
        technicalWorkItemId: work?.[0]?.id,
      }),
      activityStage: "technical_review",
      blocker: "Operations technical review required",
      events: [
        {
          kind: "report.assembled",
          message: "Report draft assembled",
          stageKey: "report_assembly",
        },
        {
          kind: "technical.requested",
          message: "Technical review requested",
          stageKey: "technical_review",
        },
      ],
    });
  }

  private async failReportAssembly(
    input: GuidedDemoCommandInput,
    run: GuidedDemoRunRow,
  ): Promise<GuidedDemoSnapshot> {
    const now = this.stamp();
    let exceptionId = run.recordBindings.exceptionId;
    if (!exceptionId && run.recordBindings.inspectionId) {
      exceptionId = await this.insertSyntheticException(run, input.correlationId, now);
    }
    return this.transitionTo(input, "report_assembly_failed", {
      bindings: mergeBindings(run.recordBindings, { exceptionId }),
      activityStage: "report_assembly",
      blocker: "Synthetic photo metadata validation failed",
      extra: { failureArmed: false, currentActivity: "Report rendering paused" },
      events: [
        {
          kind: "report.failure",
          message: "Report rendering paused",
          stageKey: "report_assembly",
        },
      ],
    });
  }

  private async submitHumanDecision(input: GuidedDemoCommandInput): Promise<GuidedDemoSnapshot> {
    const key = input.decisionKey;
    if (!key) throw new GuidedDemoValidationError("A decision key is required.");
    if (key === "add_simulated_authorization" || key === "approve_simulated_management_override") {
      return this.resolveRoofGate(input, key);
    }
    if (key === "approve_proposal") return this.approveProposal(input);
    if (key === "request_proposal_changes") return this.requestProposalChanges(input);
    if (key === "approve_technical_content") return this.approveTechnicalContent(input);
    if (key === "request_technical_changes") return this.requestTechnicalChanges(input);
    if (key === "authorize_demo_delivery") return this.authorizeDemoDelivery(input);
    if (key === "request_delivery_changes") return this.requestDeliveryChanges(input);
    throw new GuidedDemoValidationError("Unsupported decision.");
  }

  private async resolveRoofGate(
    input: GuidedDemoCommandInput,
    decisionKey: GuidedDemoDecisionKey,
  ): Promise<GuidedDemoSnapshot> {
    const run = await this.requireActiveRun();
    if (run.machineState !== "waiting_roof_authorization") {
      if (run.machineState === "proposal_processing" || isHumanGateState(run.machineState)) {
        return this.repository.loadSnapshot(run);
      }
      throw new GuidedDemoConflictError("Roof Access Authorization is not the current gate.");
    }
    const inserted = await this.database.transaction(async (transaction) => {
      return this.repository.recordDecision(transaction, {
        runId: run.id,
        decisionKey,
        stageKey: "information_check",
        actorUserId: input.actorUserId,
        idempotencyKey: input.idempotencyKey ?? `${run.id}:roof:${decisionKey}`,
        outcome: decisionKey,
        now: this.stamp(),
      });
    });
    const leadId = run.recordBindings.leadId;
    if (inserted.inserted && leadId) {
      const lead = await this.leads.getLead(leadId);
      if (lead && lead.lead.status !== "ready_for_proposal") {
        await this.leads.transitionStatus({
          leadId,
          toStatus: "ready_for_proposal",
          reason: "Simulated Roof Access Authorization recorded for the Meridian demonstration.",
          expectedVersion: lead.lead.version,
          actorUserId: input.actorUserId,
          correlationId: input.correlationId,
        });
      }
    }
    const snapshot = await this.transitionTo(input, "proposal_processing", {
      activityStage: "proposal",
      blocker: null,
      events: [
        {
          kind: "roof.resolved",
          message: "Simulated authorization added",
          stageKey: "information_check",
        },
      ],
    });
    if (input.skipDelay) {
      return this.runToNextDecision(continueInput(input));
    }
    return snapshot;
  }

  private async approveProposal(input: GuidedDemoCommandInput): Promise<GuidedDemoSnapshot> {
    const run = await this.requireActiveRun();
    if (run.machineState !== "waiting_proposal_approval") {
      if (
        run.machineState === "customer_decision_processing" ||
        isAutomatedProcessingState(run.machineState) ||
        isHumanGateState(run.machineState)
      ) {
        if (run.recordBindings.proposalId) return this.repository.loadSnapshot(run);
      }
      throw new GuidedDemoConflictError("Proposal approval is not the current gate.");
    }
    const proposalId = run.recordBindings.proposalId;
    const proposalVersionId = run.recordBindings.proposalVersionId;
    if (!proposalId || !proposalVersionId) {
      throw new GuidedDemoConflictError("The exact Proposal version is not bound.");
    }
    const record = await this.commercial.repository.getProposal(proposalId);
    if (!record) throw new GuidedDemoConflictError("The Meridian proposal was not found.");
    if (record.proposal.status === "in_review") {
      await this.commercial.reviewProposal({
        proposalId,
        actorUserId: input.actorUserId,
        correlationId: input.correlationId,
        expectedVersion: record.proposal.version,
        proposalVersionId,
        decision: "approve",
        comments: input.comments ?? "Owner approved the exact synthetic Proposal version.",
      });
    }
    await this.database.transaction(async (transaction) => {
      await this.repository.recordDecision(transaction, {
        runId: run.id,
        decisionKey: "approve_proposal",
        stageKey: "proposal",
        actorUserId: input.actorUserId,
        idempotencyKey: input.idempotencyKey ?? `${run.id}:proposal:${proposalVersionId}`,
        outcome: "approve",
        now: this.stamp(),
      });
    });
    const snapshot = await this.transitionTo(input, "customer_decision_processing", {
      activityStage: "customer_decision",
      blocker: null,
      events: [
        {
          kind: "proposal.approved",
          message: "Proposal approved by Owner",
          stageKey: "proposal",
        },
      ],
    });
    if (input.skipDelay) return this.runToNextDecision(continueInput(input));
    return snapshot;
  }

  private async requestProposalChanges(input: GuidedDemoCommandInput): Promise<GuidedDemoSnapshot> {
    const run = await this.requireActiveRun();
    if (run.machineState !== "waiting_proposal_approval") {
      throw new GuidedDemoConflictError("Proposal changes can be requested only at approval.");
    }
    const proposalId = run.recordBindings.proposalId;
    const proposalVersionId = run.recordBindings.proposalVersionId;
    if (!proposalId || !proposalVersionId) {
      throw new GuidedDemoConflictError("The exact Proposal version is not bound.");
    }
    const record = await this.commercial.repository.getProposal(proposalId);
    if (!record) throw new GuidedDemoConflictError("The Meridian proposal was not found.");
    if (record.proposal.status === "in_review") {
      await this.commercial.reviewProposal({
        proposalId,
        actorUserId: input.actorUserId,
        correlationId: input.correlationId,
        expectedVersion: record.proposal.version,
        proposalVersionId,
        decision: "request_revision",
        comments: input.comments ?? "Request synthetic commercial changes.",
      });
    }
    return this.transitionTo(input, "proposal_revision_processing", {
      activityStage: "proposal",
      extra: { currentActivity: "Applying requested commercial changes" },
      events: [
        {
          kind: "proposal.changes",
          message: "Applying requested commercial changes",
          stageKey: "proposal",
        },
      ],
    }).then((snapshot) =>
      input.skipDelay ? this.runToNextDecision(continueInput(input)) : snapshot,
    );
  }

  private async approveTechnicalContent(
    input: GuidedDemoCommandInput,
  ): Promise<GuidedDemoSnapshot> {
    const run = await this.requireActiveRun();
    if (run.machineState !== "waiting_technical_review") {
      throw new GuidedDemoConflictError("Technical review is not the current gate.");
    }
    const reportId = run.recordBindings.reportId;
    if (!reportId) throw new GuidedDemoConflictError("The report is not bound.");
    const report = await this.operations.repository.getReport(reportId);
    if (!report) throw new GuidedDemoConflictError("The Meridian report was not found.");
    this.assertExpectedVersion(run, input.expectedVersion);
    if (report.status !== "in_review" && report.status !== "draft_ready") {
      throw new GuidedDemoConflictError(
        "Technical approval requires the stored Report to be in technical review.",
      );
    }
    await this.operations.reviewReport({
      reportId,
      decision: "approve",
      comment:
        input.comments ?? "Operations approved technical content. Delivery is not authorized.",
      actorUserId: input.actorUserId,
      correlationId: input.correlationId,
      expectedVersion: report.version,
    });
    const refreshed = await this.operations.repository.getReport(reportId);
    const versions = refreshed
      ? await this.operations.repository.listReportVersions(refreshed.id)
      : [];
    const currentVersion = versions.find(
      (version) => version.versionNumber === refreshed?.currentVersionNumber,
    );
    if (!refreshed || !currentVersion || refreshed.status !== "ready_for_delivery") {
      throw new GuidedDemoIntegrityError(
        "Technical approval did not leave the stored Report ready for delivery.",
      );
    }
    await this.assertReportStoryConsistency("waiting_delivery_authorization", {
      ...run.recordBindings,
      reportId: refreshed.id,
      reportVersionId: currentVersion.id,
    });
    const snapshot = await this.transitionTo(input, "waiting_delivery_authorization", {
      bindings: mergeBindings(run.recordBindings, {
        reportVersionId: currentVersion.id,
        deliveryAuthorizationId: undefined,
      }),
      activityStage: "executive_approval",
      blocker: "Owner delivery authorization required",
      events: [
        {
          kind: `technical.approved.v${currentVersion.versionNumber}`,
          message: "Technical content approved",
          stageKey: "technical_review",
        },
        {
          kind: `delivery.requested.v${currentVersion.versionNumber}`,
          message: "Owner delivery authorization requested",
          stageKey: "executive_approval",
        },
      ],
    });
    if (input.skipDelay) return snapshot;
    return snapshot;
  }

  private async requestTechnicalChanges(
    input: GuidedDemoCommandInput,
  ): Promise<GuidedDemoSnapshot> {
    const run = await this.requireActiveRun();
    this.assertExpectedVersion(run, input.expectedVersion);
    if (run.machineState === "waiting_delivery_authorization") {
      const roleKey = await this.roleKey(input.actorUserId);
      if (roleKey !== "owner-admin") {
        throw new GuidedDemoAuthorizationError(
          "The current role cannot mutate the Owner delivery gate.",
        );
      }
      throw new GuidedDemoConflictError(
        "Request Delivery Changes is required at the Owner delivery gate.",
      );
    }
    if (run.machineState !== "waiting_technical_review") {
      throw new GuidedDemoConflictError(
        "Technical changes can be requested only at Technical Review.",
      );
    }
    const reportId = run.recordBindings.reportId;
    if (!reportId) throw new GuidedDemoConflictError("The report is not bound.");
    const report = await this.operations.repository.getReport(reportId);
    if (!report) throw new GuidedDemoConflictError("The Meridian report was not found.");
    if (report.status !== "in_review" && report.status !== "draft_ready") {
      throw new GuidedDemoConflictError(
        "Technical changes require the stored Report to be in technical review.",
      );
    }
    await this.operations.reviewReport({
      reportId,
      decision: "request_revision",
      comment: input.comments ?? "Apply technical review comments to the synthetic report.",
      actorUserId: input.actorUserId,
      correlationId: input.correlationId,
      expectedVersion: report.version,
    });
    const snapshot = await this.transitionTo(input, "report_revision_processing", {
      activityStage: "report_assembly",
      extra: { currentActivity: "Applying technical review comments" },
      events: [
        {
          kind: `report.changes.v${report.currentVersionNumber}`,
          message: "Report changes requested",
          stageKey: "technical_review",
        },
      ],
    });
    if (input.skipDelay) return this.runToNextDecision(continueInput(input));
    return snapshot;
  }

  private async requestDeliveryChanges(input: GuidedDemoCommandInput): Promise<GuidedDemoSnapshot> {
    const run = await this.requireActiveRun();
    this.assertExpectedVersion(run, input.expectedVersion);
    if (run.machineState !== "waiting_delivery_authorization") {
      throw new GuidedDemoConflictError(
        "Delivery changes can be requested only at Owner delivery authorization.",
      );
    }
    const reason = normalizeOwnerDeliveryChangeReason(
      input.comments,
      input.presentationMode === true,
    );
    if (!reason) {
      throw new GuidedDemoValidationError("A nonempty delivery-change reason is required.");
    }
    if (reason.length > 500) {
      throw new GuidedDemoValidationError("The delivery-change reason is too long.");
    }
    const reportId = run.recordBindings.reportId;
    const reportVersionId = run.recordBindings.reportVersionId;
    if (!reportId || !reportVersionId) {
      throw new GuidedDemoConflictError("The exact Report version is not bound.");
    }
    const report = await this.operations.repository.getReport(reportId);
    if (!report) throw new GuidedDemoConflictError("The Meridian report was not found.");
    if (report.status !== "ready_for_delivery") {
      throw new GuidedDemoConflictError(
        "Delivery changes require the stored Report to be ready for delivery.",
      );
    }
    const versions = await this.operations.repository.listReportVersions(report.id);
    const currentVersion = versions.find(
      (version) => version.versionNumber === report.currentVersionNumber,
    );
    if (!currentVersion || currentVersion.id !== reportVersionId) {
      throw new GuidedDemoIntegrityError(
        "The bound Report version is not the current stored version.",
      );
    }
    if (currentVersion.reviewDecision !== "approve") {
      throw new GuidedDemoIntegrityError(
        "Delivery changes require technical approval of the current Report version.",
      );
    }
    const confirmed = await this.operations.repository.getConfirmedDelivery(report.id);
    if (confirmed) {
      throw new GuidedDemoConflictError("A confirmed delivery already exists for this Report.");
    }
    const active = await this.operations.repository.getActiveDeliveryAuthorization(report.id);
    if (active) {
      await this.operations.revokeDeliveryAuthorization({
        reportId,
        actorUserId: input.actorUserId,
        correlationId: input.correlationId,
        reason,
      });
    }
    await this.operations.reopenReportForRevision({
      reportId,
      reportVersionId,
      comment: reason,
      actorUserId: input.actorUserId,
      correlationId: input.correlationId,
      expectedVersion: report.version,
    });
    const reopened = await this.operations.repository.getReport(reportId);
    if (!reopened || reopened.status !== "revision_required") {
      throw new GuidedDemoIntegrityError(
        "The stored Report did not enter revision after the Owner delivery-change request.",
      );
    }
    const snapshot = await this.transitionTo(input, "report_revision_processing", {
      bindings: mergeBindings(run.recordBindings, {
        deliveryAuthorizationId: undefined,
      }),
      activityStage: "report_assembly",
      extra: { currentActivity: "Applying requested delivery changes" },
      events: [
        {
          kind: `delivery.changes.v${currentVersion.versionNumber}`,
          message: `Owner requested delivery changes for Report Version ${currentVersion.versionNumber}.`,
          stageKey: "executive_approval",
        },
      ],
    });
    if (input.skipDelay) {
      return this.runToNextDecision(continueInput({ ...input, comments: reason }));
    }
    return snapshot;
  }

  private async authorizeDemoDelivery(input: GuidedDemoCommandInput): Promise<GuidedDemoSnapshot> {
    const run = await this.requireActiveRun();
    if (run.machineState !== "waiting_delivery_authorization") {
      if (run.machineState === "delivery_processing" || run.machineState === "completed") {
        return this.repository.loadSnapshot(run);
      }
      throw new GuidedDemoConflictError("Owner delivery authorization is not the current gate.");
    }
    const reportId = run.recordBindings.reportId;
    const reportVersionId = run.recordBindings.reportVersionId;
    if (!reportId || !reportVersionId) {
      throw new GuidedDemoConflictError("The exact Report version is not bound.");
    }
    this.assertExpectedVersion(run, input.expectedVersion);
    const report = await this.operations.repository.getReport(reportId);
    if (!report) throw new GuidedDemoConflictError("The Meridian report was not found.");
    if (report.status !== "ready_for_delivery") {
      throw new GuidedDemoConflictError(
        "Demonstration delivery can be authorized only when the stored Report is ready for delivery.",
      );
    }
    const versions = await this.operations.repository.listReportVersions(report.id);
    const currentVersion = versions.find(
      (version) => version.versionNumber === report.currentVersionNumber,
    );
    if (!currentVersion || currentVersion.id !== reportVersionId) {
      throw new GuidedDemoIntegrityError(
        "Owner authorization must bind the current stored Report version.",
      );
    }
    const authorized = await this.operations.authorizeDelivery({
      reportId,
      actorUserId: input.actorUserId,
      correlationId: input.correlationId,
      recipients: [MERIDIAN_RECIPIENT_EMAIL],
    });
    const authorizationId = authorized.authorizationId;
    await this.database.transaction(async (transaction) => {
      await this.repository.recordDecision(transaction, {
        runId: run.id,
        decisionKey: "authorize_demo_delivery",
        stageKey: "executive_approval",
        actorUserId: input.actorUserId,
        idempotencyKey: input.idempotencyKey ?? `${run.id}:delivery:${reportId}`,
        outcome: "authorize",
        now: this.stamp(),
      });
    });
    const snapshot = await this.transitionTo(input, "delivery_processing", {
      bindings: mergeBindings(run.recordBindings, { deliveryAuthorizationId: authorizationId }),
      activityStage: "client_delivery",
      blocker: null,
      events: [
        {
          kind: "delivery.authorized",
          message: "Demonstration delivery authorized",
          stageKey: "executive_approval",
        },
      ],
    });
    if (input.skipDelay) return this.runToNextDecision(continueInput(input));
    return snapshot;
  }

  private async injectFailure(input: GuidedDemoCommandInput): Promise<GuidedDemoSnapshot> {
    const run = await this.requireActiveRun();
    if (run.machineState === "report_assembly_failed") {
      return this.repository.loadSnapshot(run);
    }
    if (run.machineState === "report_assembly_processing") {
      return this.failReportAssembly(input, run);
    }
    if (!isAutomatedProcessingState(run.machineState) && !isHumanGateState(run.machineState)) {
      throw new GuidedDemoConflictError("Failure injection is unavailable in this state.");
    }
    if (
      ["waiting_technical_review", "waiting_delivery_authorization", "completed"].includes(
        run.machineState,
      )
    ) {
      throw new GuidedDemoConflictError("Report Assembly has already completed.");
    }
    return this.mutateRun(input, async (locked) => ({ ...locked, failureArmed: true }));
  }

  private async retryFailure(input: GuidedDemoCommandInput): Promise<GuidedDemoSnapshot> {
    const run = await this.requireActiveRun();
    if (run.machineState !== "report_assembly_failed") {
      if (run.machineState === "waiting_technical_review") return this.repository.loadSnapshot(run);
      throw new GuidedDemoConflictError("There is no demonstration failure to retry.");
    }
    const snapshot = await this.transitionTo(input, "report_assembly_processing", {
      activityStage: "report_assembly",
      extra: {
        failureArmed: false,
        currentActivity: "Revalidating synthetic photo metadata",
        currentBlocker: null,
      },
      events: [
        {
          kind: "report.retry",
          message: "Revalidating synthetic photo metadata",
          stageKey: "report_assembly",
        },
      ],
    });
    if (input.skipDelay) return this.runToNextDecision(continueInput(input));
    return snapshot;
  }

  private async reset(input: GuidedDemoCommandInput): Promise<GuidedDemoSnapshot> {
    return this.database.transaction(async (transaction) => {
      await this.assertDemoAvailable(transaction);
      const existing = await this.repository.lockActiveRun(transaction);
      const now = this.stamp();
      if (existing) {
        await this.repository.archiveRun(transaction, existing.id, now);
        await this.repository.appendEvent(transaction, {
          runId: existing.id,
          stageKey: existing.currentStageKey,
          eventKind: "demo.reset",
          message: "Meridian demonstration archived and reset.",
          actorUserId: input.actorUserId,
          now,
        });
      }
      let run: GuidedDemoRunRow;
      try {
        run = await this.repository.insertFreshRun(transaction, {
          now,
          catalogVersionId: SEEDED_MERIDIAN_IDS.catalogVersion,
        });
      } catch (error) {
        if (!isUniqueConstraintViolation(error)) throw error;
        const again = await this.repository.lockActiveRun(transaction);
        if (!again) throw error;
        run = again;
      }
      void input;
      return this.repository.loadSnapshot(run, transaction);
    });
  }

  private async insertProjectBridge(
    run: GuidedDemoRunRow,
  ): Promise<Pick<GuidedDemoRecordBindings, "projectId" | "inspectionId">> {
    const now = this.stamp();
    const projectId = randomUUID();
    const inspectionId = randomUUID();
    const projectRef = await nextOperationsReference(
      this.database,
      "bea_project_reference_seq",
      "BEA-PR-",
    );
    const inspectionRef = await nextOperationsReference(
      this.database,
      "bea_inspection_reference_seq",
      "BEA-IN-",
    );
    await this.database.query(
      `INSERT INTO projects
       (id,reference,lead_id,company_id,contact_id,name,client_name,site_name,site_city,site_region,service_key,status,accepted_scope_snapshot,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$6,'Example City','EX','building-envelope-inspection','fieldwork',$8::jsonb,$9,$10,$10,1)`,
      [
        projectId,
        projectRef,
        run.recordBindings.leadId ?? null,
        SEEDED_MERIDIAN_IDS.company,
        SEEDED_MERIDIAN_IDS.contact,
        MERIDIAN_CLIENT.projectName,
        MERIDIAN_CLIENT.companyName,
        JSON.stringify({
          synthetic: true,
          disclosure:
            "GUIDED DEMONSTRATION STAGE — FULL AWARD-TO-PROJECT AUTOMATION IS DEFERRED. This project is a bounded synthetic bridge, not a production award record.",
          scenarioKey: GUIDED_DEMO_SCENARIO_KEY,
          proposalId: run.recordBindings.proposalId ?? null,
        }),
        OPERATIONS,
        now,
      ],
    );
    await this.database.query(
      `INSERT INTO inspections
       (id,reference,project_id,status,inspector_user_id,reviewer_user_id,scheduled_at,started_at,completed_at,service_key,report_template_id,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,$2,$3,'completed',$4,$5,$6,$6,NULL,'building-envelope-inspection',$7,$5,$6,$6,1)`,
      [
        inspectionId,
        inspectionRef,
        projectId,
        OPERATIONS,
        OWNER,
        now,
        SEEDED_OPERATIONS_IDS.template,
      ],
    );
    await this.database.query(
      `INSERT INTO inspection_assignments (id,inspection_id,user_id,assignment_role,assigned_at,assigned_by_user_id)
       VALUES ($1,$2,$3,'inspector',$4,$5)
       ON CONFLICT (inspection_id, assignment_role, user_id) DO NOTHING`,
      [randomUUID(), inspectionId, OPERATIONS, now, OWNER],
    );
    return { projectId, inspectionId };
  }

  private async insertSyntheticException(
    run: GuidedDemoRunRow,
    correlationId: string,
    now: string,
  ): Promise<string> {
    const id = randomUUID();
    const reference = await nextOperationsReference(
      this.database,
      "bea_exception_reference_seq",
      "BEA-EX-",
    );
    const inspection = await this.operations.repository.getInspection(
      run.recordBindings.inspectionId!,
    );
    await this.database.query(
      `INSERT INTO exception_cases
       (id,reference,kind,status,severity,title,detail,inspection_id,report_id,project_id,owner_user_id,sla_attribution,created_at,updated_at,version)
       VALUES ($1,$2,'validation','open','error',$3,$4,$5,$6,$7,$8,'system_processing',$9,$9,1)`,
      [
        id,
        reference,
        "Synthetic photo metadata validation failed",
        "Demonstration-only failure. The stored report was not corrupted. Retry revalidates synthetic photo metadata.",
        run.recordBindings.inspectionId ?? null,
        run.recordBindings.reportId ?? null,
        inspection?.projectId ?? run.recordBindings.projectId ?? null,
        OWNER,
        now,
      ],
    );
    void correlationId;
    return id;
  }

  private async transitionTo(
    input: GuidedDemoCommandInput,
    nextState: GuidedDemoMachineState,
    options: {
      readonly bindings?: GuidedDemoRecordBindings;
      readonly activityStage?: GuidedDemoStageKey;
      readonly blocker?: string | null;
      readonly extra?: Partial<GuidedDemoRunRow>;
      readonly events?: readonly {
        readonly kind: string;
        readonly message: string;
        readonly stageKey?: GuidedDemoStageKey;
      }[];
    } = {},
  ): Promise<GuidedDemoSnapshot> {
    return this.database.transaction(async (transaction) => {
      const run = await this.repository.lockActiveRun(transaction);
      if (!run) throw new GuidedDemoConflictError("The Meridian demonstration run was not found.");
      if (run.machineState === nextState) {
        return this.repository.loadSnapshot(run, transaction);
      }
      if (run.machineState === "paused") {
        throw new GuidedDemoConflictError("Resume the demonstration before changing stages.");
      }
      assertGuidedDemoTransition(run.machineState, nextState);
      this.assertExpectedVersion(run, input.expectedVersion);
      const now = this.stamp();
      const stageKey = options.activityStage ?? stageKeyForMachineState(nextState);
      const next = this.repository.applyMachineState(run, nextState, {
        ...options.extra,
        recordBindings: options.bindings ?? run.recordBindings,
        currentActivity:
          options.extra?.currentActivity ?? (stageKey ? activityAt(stageKey, 0) : null),
        currentActivityIndex: options.extra?.currentActivityIndex ?? 0,
        currentBlocker: options.blocker === undefined ? run.currentBlocker : options.blocker,
      });
      const saved = await this.saveLocked(transaction, next, run.optimisticVersion, now);
      for (const event of options.events ?? []) {
        await this.appendOnce(transaction, {
          runId: saved.id,
          stageKey: event.stageKey ?? stageKey ?? null,
          eventKind: event.kind,
          message: event.message,
          actorUserId: input.actorUserId,
          now,
        });
      }
      return this.repository.loadSnapshot(saved, transaction);
    });
  }

  private async mutateRun(
    input: GuidedDemoCommandInput,
    mutate: (run: GuidedDemoRunRow) => Promise<GuidedDemoRunRow>,
  ): Promise<GuidedDemoSnapshot> {
    return this.database.transaction(async (transaction) => {
      const run = await this.repository.lockActiveRun(transaction);
      if (!run) throw new GuidedDemoConflictError("The Meridian demonstration run was not found.");
      this.assertExpectedVersion(run, input.expectedVersion);
      const next = await mutate(run);
      const saved = await this.saveLocked(transaction, next, run.optimisticVersion, this.stamp());
      return this.repository.loadSnapshot(saved, transaction);
    });
  }

  private async saveLocked(
    transaction: SqlExecutor,
    run: GuidedDemoRunRow,
    expectedVersion: number,
    now: string,
  ): Promise<GuidedDemoRunRow> {
    try {
      const saved = await this.repository.saveRun(transaction, run, expectedVersion, now);
      await this.repository.replaceStageStates(transaction, saved, now);
      return saved;
    } catch (error) {
      if (error instanceof Error && error.message === "GUIDED_DEMO_CONCURRENCY") {
        throw new GuidedDemoConcurrencyError();
      }
      throw error;
    }
  }

  private async appendOnce(
    transaction: SqlExecutor,
    input: {
      readonly runId: string;
      readonly stageKey: GuidedDemoStageKey | null;
      readonly eventKind: string;
      readonly message: string;
      readonly actorUserId: string | null;
      readonly now: string;
    },
  ): Promise<void> {
    const existing = await transaction.query<{ id: string }>(
      `SELECT id FROM guided_demo_events WHERE demo_run_id=$1 AND event_kind=$2 LIMIT 1`,
      [input.runId, input.eventKind],
    );
    if (existing.rows[0]) return;
    await this.repository.appendEvent(transaction, input);
  }

  private async requireActiveRun(): Promise<GuidedDemoRunRow> {
    const run = await this.repository.getActiveRun();
    if (!run) throw new GuidedDemoConflictError("The Meridian demonstration run was not found.");
    return run;
  }

  private assertExpectedVersion(run: GuidedDemoRunRow, expectedVersion?: number): void {
    if (expectedVersion !== undefined && expectedVersion !== run.optimisticVersion) {
      throw new GuidedDemoConcurrencyError();
    }
  }

  private async assertReportStoryConsistency(
    machineState: GuidedDemoMachineState,
    bindings: GuidedDemoRecordBindings,
  ): Promise<void> {
    if (!bindings.reportId || !bindings.reportVersionId) {
      throw new GuidedDemoIntegrityError("The guided run is not bound to an exact Report version.");
    }
    const report = await this.operations.repository.getReport(bindings.reportId);
    if (!report) {
      throw new GuidedDemoIntegrityError("The bound Report was not found.");
    }
    const versions = await this.operations.repository.listReportVersions(report.id);
    const current = versions.find((item) => item.versionNumber === report.currentVersionNumber);
    const active = await this.operations.repository.getActiveDeliveryAuthorization(report.id);
    const confirmed = await this.operations.repository.getConfirmedDelivery(report.id);
    assertGuidedDemoReportConsistency({
      machineState,
      reportId: report.id,
      boundReportVersionId: bindings.reportVersionId,
      reportStatus: report.status,
      currentVersionId: current?.id ?? null,
      currentVersionReviewDecision: current?.reviewDecision ?? null,
      technicallyApproved: current?.reviewDecision === "approve",
      activeDeliveryAuthorizationId: active?.id ?? null,
      confirmedDeliveryVersionId: confirmed?.reportVersionId ?? null,
    });
  }
}
