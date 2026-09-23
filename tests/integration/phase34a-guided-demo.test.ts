import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEMO_PERSONAS,
  GUIDED_DEMO_PRESET_VOICE_PHRASE,
  GuidedDemoAuthorizationError,
  GuidedDemoConcurrencyError,
  GuidedDemoUnavailableError,
  GuidedDemoValidationError,
  MERIDIAN_CLIENT,
  MERIDIAN_PROPOSAL_TOTAL_MINOR,
} from "../../packages/domain/src/index.js";
import {
  CommercialWorkflowService,
  GuidedMeridianService,
  PGliteDatabaseAdapter,
  SqlLeadRepository,
  createInspectionReportPipeline,
  loadGuidedMeridianReportView,
  migrateDatabase,
  seedDatabase,
  type InspectionReportPipeline,
} from "../../packages/database/src/index.js";

const OWNER = DEMO_PERSONAS[0]!.id;
const SALES = DEMO_PERSONAS[1]!.id;
const OPERATIONS = DEMO_PERSONAS[2]!.id;
const EXECUTIVE = DEMO_PERSONAS[3]!.id;
const INTEGRATION = DEMO_PERSONAS[4]!.id;
const LATEST_MIGRATION = "0035_cpl_delivery_closeout.sql";

let database: PGliteDatabaseAdapter;
let pipeline: InspectionReportPipeline;
let commercial: CommercialWorkflowService;
let leads: SqlLeadRepository;
let guided: GuidedMeridianService;

function command(
  action: Parameters<GuidedMeridianService["execute"]>[0]["action"],
  actorUserId: string,
  extra: Partial<Parameters<GuidedMeridianService["execute"]>[0]> = {},
) {
  return guided.execute({
    action,
    actorUserId,
    correlationId: `${action}-${actorUserId.slice(-4)}`,
    skipDelay: true,
    ...extra,
  });
}

beforeAll(async () => {
  expect(process.env.OPENAI_API_KEY ?? "").toBe("");
  database = new PGliteDatabaseAdapter("memory://");
  const migrated = await migrateDatabase(database);
  expect(migrated.applied.at(-1)).toBe(LATEST_MIGRATION);
  await seedDatabase(database);
  await seedDatabase(database);
  pipeline = createInspectionReportPipeline(database, "demo", { processInline: true });
  commercial = new CommercialWorkflowService(database, { processInline: true });
  commercial.bindWorkControl(pipeline.workControl!);
  leads = new SqlLeadRepository(database);
  guided = new GuidedMeridianService(database, leads, commercial, pipeline, { appMode: "demo" });
}, 60_000);

afterAll(async () => {
  await database?.close();
});

describe("Phase 3.4A guided Meridian story", { timeout: 90_000 }, () => {
  it("scenario A follows the default happy path to local-test closeout", async () => {
    const started = await command("start", OWNER);
    expect(started.scenarioKey).toBe("meridian-commerce-center");
    expect(started.machineState).toBe("waiting_roof_authorization");
    expect(started.status).toBe("waiting_for_human");
    expect(started.recordBindings.leadId).toBeTruthy();
    expect(started.recentEvents.map((event) => event.plainLanguageMessage)).toEqual(
      expect.arrayContaining([
        "Website inquiry received",
        "Roof Access Authorization missing",
        "Automation paused for human input",
      ]),
    );

    const authorized = await command("submit_human_decision", OWNER, {
      decisionKey: "add_simulated_authorization",
      expectedVersion: started.optimisticVersion,
    });
    expect(authorized.machineState).toBe("waiting_proposal_approval");
    expect(authorized.recordBindings.proposalId).toBeTruthy();
    expect(authorized.recordBindings.proposalVersionId).toBeTruthy();
    const proposal = await commercial.repository.getProposal(authorized.recordBindings.proposalId!);
    expect(proposal?.proposal.totalMinor).toBe(MERIDIAN_PROPOSAL_TOTAL_MINOR);
    expect(proposal?.proposal.status).toBe("in_review");

    const afterProposal = await command("approve_proposal", OWNER, {
      expectedVersion: authorized.optimisticVersion,
    });
    expect(afterProposal.machineState).toBe("waiting_technical_review");
    expect(afterProposal.recordBindings.inspectionId).toBeTruthy();
    expect(afterProposal.recordBindings.reportId).toBeTruthy();
    const report = await pipeline.repository.getReport(afterProposal.recordBindings.reportId!);
    expect(report?.status).toBe("in_review");

    const afterTechnical = await command("approve_technical_content", OPERATIONS, {
      expectedVersion: afterProposal.optimisticVersion,
    });
    expect(afterTechnical.machineState).toBe("waiting_delivery_authorization");
    const technicallyApproved = await pipeline.repository.getReport(
      afterTechnical.recordBindings.reportId!,
    );
    expect(technicallyApproved?.status).toBe("ready_for_delivery");

    const delivered = await command("authorize_demo_delivery", OWNER, {
      expectedVersion: afterTechnical.optimisticVersion,
    });
    expect(delivered.machineState).toBe("completed");
    expect(delivered.status).toBe("completed");
    const finalReport = await pipeline.repository.getReport(delivered.recordBindings.reportId!);
    expect(finalReport?.status).toBe("delivered");
    const deliveries = await pipeline.repository.listDeliveries(finalReport!.id);
    expect(deliveries.some((item) => item.status === "delivered")).toBe(true);
    expect(delivered.recentEvents.map((event) => event.plainLanguageMessage)).toEqual(
      expect.arrayContaining(["No-send delivery confirmed", "Guided closeout reached"]),
    );
    const lead = await leads.getLead(delivered.recordBindings.leadId!);
    expect(lead?.lead.opportunityName).toBe(MERIDIAN_CLIENT.projectName);
  });

  it("scenario B requests proposal changes and refuses to reuse the old version", async () => {
    await command("reset", OWNER);
    const gate = await command("run_to_next_decision", OWNER);
    expect(gate.machineState).toBe("waiting_roof_authorization");
    const proposalGate = await command("submit_human_decision", OWNER, {
      decisionKey: "add_simulated_authorization",
    });
    expect(proposalGate.machineState).toBe("waiting_proposal_approval");
    const firstVersion = proposalGate.recordBindings.proposalVersionId;
    const revised = await command("request_proposal_changes", OWNER);
    expect(revised.machineState).toBe("waiting_proposal_approval");
    expect(revised.recordBindings.proposalVersionId).toBeTruthy();
    expect(revised.recordBindings.proposalVersionId).not.toBe(firstVersion);
    const proposal = await commercial.repository.getProposal(revised.recordBindings.proposalId!);
    expect(proposal?.proposal.currentVersionNumber).toBeGreaterThan(1);
    await command("approve_proposal", OWNER);
  });

  it("scenario C loops technical review through a new report version", async () => {
    await command("reset", OWNER);
    await command("run_to_next_decision", OWNER);
    await command("submit_human_decision", OWNER, {
      decisionKey: "add_simulated_authorization",
    });
    const review = await command("approve_proposal", OWNER);
    expect(review.machineState).toBe("waiting_technical_review");
    const firstVersion = review.recordBindings.reportVersionId;
    const looped = await command("request_technical_changes", OPERATIONS);
    expect(looped.machineState).toBe("waiting_technical_review");
    expect(looped.recordBindings.reportVersionId).not.toBe(firstVersion);
    const afterApprove = await command("approve_technical_content", OPERATIONS);
    expect(afterApprove.machineState).toBe("waiting_delivery_authorization");
  });

  it("scenario D injects a report-assembly failure and recovers once", async () => {
    await command("reset", OWNER);
    await command("run_to_next_decision", OWNER);
    await command("submit_human_decision", OWNER, {
      decisionKey: "add_simulated_authorization",
    });
    const armed = await command("inject_failure", OWNER);
    expect(armed.failureArmed || armed.machineState === "report_assembly_failed").toBe(true);
    const recovered = await command("approve_proposal", OWNER);
    const failed =
      recovered.machineState === "report_assembly_failed"
        ? recovered
        : await command("inject_failure", OWNER);
    expect(failed.machineState).toBe("report_assembly_failed");
    expect(failed.currentBlocker).toContain("Synthetic photo metadata");
    const retried = await command("retry_failure", OWNER);
    expect(retried.machineState).toBe("waiting_technical_review");
    const second = await command("retry_failure", OWNER);
    expect(second.machineState).toBe("waiting_technical_review");
    expect(second.optimisticVersion).toBe(retried.optimisticVersion);
  });

  it("scenario E archives the prior run on reset without deleting unrelated fixtures", async () => {
    const before = await command("run_to_next_decision", OWNER);
    const priorId = before.id;
    const northstar = await pipeline.repository.getInspection(
      "b2000000-0000-4000-8000-000000000001",
    );
    expect(northstar).toBeTruthy();
    const reset = await command("reset", OWNER);
    expect(reset.id).not.toBe(priorId);
    expect(reset.machineState).toBe("not_started");
    expect(reset.recordBindings.leadId).toBeUndefined();
    const archived = await database.query<{ status: string }>(
      "SELECT status FROM guided_demo_runs WHERE id=$1",
      [priorId],
    );
    expect(archived.rows[0]?.status).toBe("archived");
    expect(
      await pipeline.repository.getInspection("b2000000-0000-4000-8000-000000000001"),
    ).toBeTruthy();
  });

  it("scenario F reloads the same gate after a snapshot refresh", async () => {
    await command("start", OWNER);
    const gate = await command("get_snapshot", OWNER);
    expect(gate.machineState).toBe("waiting_roof_authorization");
    const again = await command("get_snapshot", OWNER);
    expect(again.id).toBe(gate.id);
    expect(again.machineState).toBe("waiting_roof_authorization");
    expect(again.recentEvents.map((event) => event.eventKind)).toEqual([
      ...new Set(again.recentEvents.map((event) => event.eventKind)),
    ]);
  });

  it("scenario G routes the deterministic report command from current story state", async () => {
    await command("reset", OWNER);
    const before = await guided.routeCommand({
      action: "route_command",
      actorUserId: OWNER,
      correlationId: "ai-before",
      commandText: GUIDED_DEMO_PRESET_VOICE_PHRASE,
    });
    expect(before.intent).toBe("open_meridian_report");
    expect(before.response.openReport).toBe(false);
    expect(before.response.message).toContain("has not been assembled yet");
    await command("start", OWNER);
    await command("submit_human_decision", OWNER, {
      decisionKey: "add_simulated_authorization",
    });
    await command("approve_proposal", OWNER);
    const after = await guided.routeCommand({
      action: "route_command",
      actorUserId: OWNER,
      correlationId: "ai-after",
      commandText: "Show me the Meridian Commerce Center inspection report.",
    });
    expect(after.response.openReport).toBe(true);
    expect(after.response.message).toContain("3 findings: 2 high priority and 1 medium priority");
    expect(after.response.label).toContain("SIMULATED AI COMMAND");
  });

  it("binds Command Center workspace facts to the stored current Report version", async () => {
    await command("reset", OWNER);
    await command("run_to_next_decision", OWNER);
    await command("submit_human_decision", OWNER, {
      decisionKey: "add_simulated_authorization",
    });
    const review = await command("approve_proposal", OWNER);
    const first = await loadGuidedMeridianReportView({
      repository: pipeline.repository,
      bindings: review.recordBindings,
      machineState: review.machineState,
    });
    expect(first.view?.reportId).toBe(review.recordBindings.reportId);
    expect(first.view?.versionId).toBe(review.recordBindings.reportVersionId);
    expect(first.view?.findingCount).toBe(3);
    expect(first.view?.evidenceCount).toBe(12);
    expect(first.view?.highPriorityCount).toBe(2);
    expect(first.view?.versionMarker).toContain("ORIGINAL ASSESSMENT");
    expect(first.view?.findings.map((item) => item.code)).toEqual(["F-1", "F-2", "F-3"]);
    const firstVersionId = review.recordBindings.reportVersionId;
    const looped = await command("request_technical_changes", OPERATIONS);
    const second = await loadGuidedMeridianReportView({
      repository: pipeline.repository,
      bindings: looped.recordBindings,
      machineState: looped.machineState,
    });
    expect(looped.recordBindings.reportVersionId).not.toBe(firstVersionId);
    expect(second.view?.versionNumber).toBe(2);
    expect(second.view?.versionMarker).toContain("REVIEW UPDATE — Version 2");
    expect(second.view?.reviewUpdate).toBeTruthy();
    expect(second.view?.technicallyApproved).toBe(false);
    const historical = await pipeline.repository.listReportVersions(
      review.recordBindings.reportId!,
    );
    expect(historical).toHaveLength(2);
    expect(historical[0]?.id).toBe(firstVersionId);
  });

  it("reopens a real Report version from the Owner delivery gate", async () => {
    await command("reset", OWNER);
    await command("run_to_next_decision", OWNER);
    await command("submit_human_decision", OWNER, {
      decisionKey: "add_simulated_authorization",
    });
    const review = await command("approve_proposal", OWNER);
    const gate = await command("approve_technical_content", OPERATIONS);
    expect(gate.machineState).toBe("waiting_delivery_authorization");
    const approved = await pipeline.repository.getReport(gate.recordBindings.reportId!);
    expect(approved?.status).toBe("ready_for_delivery");
    const firstVersionId = gate.recordBindings.reportVersionId;
    await expect(
      command("request_technical_changes", OPERATIONS, {
        expectedVersion: gate.optimisticVersion,
      }),
    ).rejects.toBeInstanceOf(GuidedDemoAuthorizationError);
    await expect(
      command("request_delivery_changes", OPERATIONS, {
        comments: "Ops should not reopen delivery.",
      }),
    ).rejects.toBeInstanceOf(GuidedDemoAuthorizationError);
    await expect(
      command("request_delivery_changes", SALES, {
        comments: "Sales should not reopen delivery.",
      }),
    ).rejects.toBeInstanceOf(GuidedDemoAuthorizationError);
    await expect(
      command("request_delivery_changes", EXECUTIVE, {
        comments: "Executive should not reopen delivery.",
      }),
    ).rejects.toBeInstanceOf(GuidedDemoAuthorizationError);
    await expect(
      command("request_delivery_changes", INTEGRATION, {
        comments: "Integration should not reopen delivery.",
      }),
    ).rejects.toBeInstanceOf(GuidedDemoAuthorizationError);
    await expect(command("request_delivery_changes", OWNER)).rejects.toBeInstanceOf(
      GuidedDemoValidationError,
    );
    await expect(
      command("request_delivery_changes", OWNER, {
        comments: "Stale request",
        expectedVersion: gate.optimisticVersion - 1,
      }),
    ).rejects.toBeInstanceOf(GuidedDemoConcurrencyError);
    const unchanged = await pipeline.repository.getReport(gate.recordBindings.reportId!);
    expect(unchanged?.status).toBe("ready_for_delivery");
    expect(unchanged?.currentVersionNumber).toBe(approved?.currentVersionNumber);
    const revised = await command("request_delivery_changes", OWNER, {
      comments: "Clarify the recommended repair priority before release.",
      expectedVersion: gate.optimisticVersion,
    });
    expect(revised.machineState).toBe("waiting_technical_review");
    expect(revised.recordBindings.reportVersionId).not.toBe(firstVersionId);
    const afterRevision = await pipeline.repository.getReport(revised.recordBindings.reportId!);
    expect(afterRevision?.status).toBe("in_review");
    expect(afterRevision?.currentVersionNumber).toBeGreaterThan(approved!.currentVersionNumber);
    const versions = await pipeline.repository.listReportVersions(afterRevision!.id);
    const previous = versions.find((item) => item.id === firstVersionId);
    const current = versions.find((item) => item.id === revised.recordBindings.reportVersionId);
    expect(previous?.reviewDecision).toBe("approve");
    expect(current?.reviewDecision).not.toBe("approve");
    expect(await pipeline.repository.getActiveDeliveryAuthorization(afterRevision!.id)).toBeNull();
    const workspace = await loadGuidedMeridianReportView({
      repository: pipeline.repository,
      bindings: revised.recordBindings,
      machineState: revised.machineState,
    });
    expect(workspace.view?.versionId).toBe(revised.recordBindings.reportVersionId);
    expect(workspace.view?.technicallyApproved).toBe(false);
    expect(workspace.view?.reviewHistory.some((item) => item.comment?.includes("Clarify"))).toBe(
      true,
    );
    const reapproved = await command("approve_technical_content", OPERATIONS);
    expect(reapproved.machineState).toBe("waiting_delivery_authorization");
    expect(reapproved.recordBindings.reportVersionId).toBe(revised.recordBindings.reportVersionId);
    const ready = await pipeline.repository.getReport(reapproved.recordBindings.reportId!);
    expect(ready?.status).toBe("ready_for_delivery");
    const delivered = await command("authorize_demo_delivery", OWNER);
    expect(delivered.machineState).toBe("completed");
    const finalReport = await pipeline.repository.getReport(delivered.recordBindings.reportId!);
    expect(finalReport?.status).toBe("delivered");
    const deliveries = await pipeline.repository.listDeliveries(finalReport!.id);
    expect(deliveries.filter((item) => item.status === "delivered")).toHaveLength(1);
    expect(deliveries[0]?.reportVersionId).toBe(reapproved.recordBindings.reportVersionId);
    void review;
  });

  it("denies executive mutation and production mode", async () => {
    await expect(command("start", EXECUTIVE)).rejects.toBeInstanceOf(GuidedDemoAuthorizationError);
    await expect(command("approve_proposal", SALES)).rejects.toBeInstanceOf(
      GuidedDemoAuthorizationError,
    );
    await expect(command("authorize_demo_delivery", OPERATIONS)).rejects.toBeInstanceOf(
      GuidedDemoAuthorizationError,
    );
    await expect(command("start", INTEGRATION)).rejects.toBeInstanceOf(
      GuidedDemoAuthorizationError,
    );
    const production = new GuidedMeridianService(database, leads, commercial, pipeline, {
      appMode: "production",
    });
    await expect(
      production.execute({ action: "start", actorUserId: OWNER, correlationId: "prod" }),
    ).rejects.toBeInstanceOf(GuidedDemoUnavailableError);
  });

  it("treats duplicate start and duplicate roof decisions as one outcome", async () => {
    await command("reset", OWNER);
    const first = await command("start", OWNER);
    const second = await command("start", OWNER);
    expect(second.id).toBe(first.id);
    expect(second.machineState).toBe("waiting_roof_authorization");
    const decision = await command("submit_human_decision", OWNER, {
      decisionKey: "add_simulated_authorization",
      idempotencyKey: `${first.id}:roof-once`,
    });
    const duplicate = await command("submit_human_decision", OWNER, {
      decisionKey: "add_simulated_authorization",
      idempotencyKey: `${first.id}:roof-once`,
    });
    expect(duplicate.recordBindings.proposalId).toBe(decision.recordBindings.proposalId);
  });
});
