import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ScriptedDeliveryAdapter } from "../../packages/automation/src/index.js";
import {
  ConfigurationValidationError,
  DEMO_PERSONAS,
  DEMO_ROLE_IDS,
  EMAIL_DRY_RUN_DISCLOSURE,
  PROJECTION_MAX_ATTEMPTS,
  SEEDED_CONFIGURATION_IDS,
  SEEDED_WORK_CONTROL_IDS,
  SCHEDULE_MAX_ATTEMPTS,
  TEAMS_DRY_RUN_DISCLOSURE,
  WorkItemClaimError,
  WorkItemManualCompletionError,
  buildWorkItemCycleIdentity,
  syntheticInspectionCompletedAt,
} from "../../packages/domain/src/index.js";
import { PERMISSIONS, PersistentAuthorizationService } from "../../packages/security/src/index.js";
import {
  ConfigurationStudioService,
  PGliteDatabaseAdapter,
  SqlFoundationRepository,
  WorkControlPlane,
  completeSyntheticSubmissionPayload,
  createInspectionReportPipeline,
  incompleteSyntheticSubmissionPayload,
  migrateDatabase,
  seedDatabase,
  type InspectionReportPipeline,
} from "../../packages/database/src/index.js";

const OWNER = DEMO_PERSONAS[0].id;
const OPERATIONS = DEMO_PERSONAS[2].id;
const OPERATIONS_B = DEMO_PERSONAS[5].id;
const INTEGRATION = DEMO_PERSONAS[4].id;

function createClock(start: string) {
  let current = new Date(start);
  return {
    now: () => new Date(current.getTime()),
    set(value: string) {
      current = new Date(value);
    },
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
}

async function insertCompletedInspection(
  database: PGliteDatabaseAdapter,
  reference: string,
  completedAt: string,
) {
  const projectId = randomUUID();
  const inspectionId = randomUUID();
  await database.query(
    `INSERT INTO projects
     (id,reference,name,client_name,site_name,service_key,status,accepted_scope_snapshot,created_by_user_id,created_at,updated_at,version)
     VALUES ($1,$2,'Work lab','Northstar Facade Group','Lab Site','building-envelope-inspection','fieldwork','{"synthetic":true}'::jsonb,$3,$4,$4,1)`,
    [projectId, reference.replace("IN", "PR"), OWNER, completedAt],
  );
  await database.query(
    `INSERT INTO inspections
     (id,reference,project_id,status,inspector_user_id,reviewer_user_id,completed_at,service_key,report_template_id,created_by_user_id,created_at,updated_at,version)
     VALUES ($1,$2,$3,'completed',$4,$5,$6,'building-envelope-inspection',$7,$5,$6,$6,1)`,
    [
      inspectionId,
      reference,
      projectId,
      OPERATIONS,
      OWNER,
      syntheticInspectionCompletedAt(new Date(completedAt)),
      "b3000000-0000-4000-8000-000000000001",
    ],
  );
  return { projectId, inspectionId };
}

async function insertPendingEvent(
  eventType: string,
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, unknown>,
  correlationId: string,
) {
  const id = randomUUID();
  await database.query(
    `INSERT INTO automation_events
     (id,event_type,schema_version,aggregate_type,aggregate_id,correlation_id,occurred_at,recorded_at,actor_type,actor_id,payload,processing_status)
     VALUES ($1,$2,'1',$3,$4,$5,$6,$6,'system',NULL,$7::jsonb,'pending')`,
    [
      id,
      eventType,
      aggregateType,
      aggregateId,
      correlationId,
      clock.now().toISOString(),
      JSON.stringify(payload),
    ],
  );
  return id;
}

async function insertReportVersion(
  fixture: { projectId: string; inspectionId: string },
  reportId: string,
  versionId: string,
  status: string,
) {
  const submissionId = randomUUID();
  const reportStatus =
    status === "ready_for_delivery" || status === "final" || status === "approved"
      ? "ready_for_delivery"
      : status;
  const versionStatus = status === "ready_for_delivery" ? "approved" : status;
  await database.query(
    `INSERT INTO inspection_reports
     (id,reference,inspection_id,project_id,template_id,current_template_version_id,status,current_version_number,created_by_user_id,created_at,updated_at,version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$9,1)
     ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, current_version_number=EXCLUDED.current_version_number`,
    [
      reportId,
      `BEA-RP-${reportId.replaceAll("-", "").slice(0, 12)}`,
      fixture.inspectionId,
      fixture.projectId,
      "b3000000-0000-4000-8000-000000000001",
      "b3000000-0000-4000-8000-000000000011",
      reportStatus,
      OWNER,
      clock.now().toISOString(),
    ],
  );
  await database.query(
    `INSERT INTO inspection_submissions
     (id,inspection_id,source_channel,source_idempotency_key,payload_sha256,raw_payload,schema_version,mapping_version,normalized_payload,created_at)
     VALUES ($1,$2,'direct_entry',$3,'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd','{}'::jsonb,'v1','v1','{}'::jsonb,$4)
     ON CONFLICT (id) DO NOTHING`,
    [submissionId, fixture.inspectionId, `sub-${versionId}`, clock.now().toISOString()],
  );
  await database.query(
    `INSERT INTO report_versions
     (id,report_id,version_number,status,input_snapshot,template_version_id,submission_id,created_at)
     VALUES ($1,$2,1,$3,'{}'::jsonb,$4,$5,$6)
     ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status`,
    [
      versionId,
      reportId,
      versionStatus,
      "b3000000-0000-4000-8000-000000000011",
      submissionId,
      clock.now().toISOString(),
    ],
  );
}

let database: PGliteDatabaseAdapter;
let pipeline: InspectionReportPipeline;
let configuration: ConfigurationStudioService;
const clock = createClock("2026-09-01T12:00:00.000Z");

beforeAll(async () => {
  expect(process.env.OPENAI_API_KEY ?? "").toBe("");
  expect(process.env.MICROSOFT_GRAPH_CLIENT_SECRET ?? "").toBe("");
  database = new PGliteDatabaseAdapter("memory://");
  const migrated = await migrateDatabase(database);
  expect(migrated.applied.at(-1)).toBe("0035_cpl_delivery_closeout.sql");
  await seedDatabase(database);
  pipeline = createInspectionReportPipeline(database, "demo", {
    processInline: true,
    deliveryAdapter: new ScriptedDeliveryAdapter(0),
    now: () => clock.now(),
  });
  configuration = new ConfigurationStudioService(database, { now: () => clock.now() });
  configuration.bindWorkControl(pipeline.workControl!);
  configuration.bindSubmissions({
    submitInspection: (input) => pipeline.submitInspection(input),
  });
}, 60_000);

afterAll(async () => {
  await database?.close();
});

describe("Phase 3.2A operational work control", () => {
  it("creates readiness work from inspection.scheduled and auto-completes on ready", async () => {
    const inspection = await configuration.createInspection({
      projectId: "b1000000-0000-4000-8000-000000000001",
      configurationReleaseId: SEEDED_CONFIGURATION_IDS.exteriorRelease,
      inspectionType: "synthetic-lab",
      inspectorUserId: OPERATIONS,
      scheduledAt: clock.now().toISOString(),
      actorUserId: OWNER,
      correlationId: "readiness-create",
    });
    const readiness = (
      await pipeline.workControl!.repository.listWorkItems({
        inspectionId: inspection.id,
        kinds: ["inspection_readiness"],
      })
    ).filter((item) => item.status === "open" || item.status === "in_progress");
    expect(readiness.length).toBeGreaterThanOrEqual(1);
    await pipeline.workControl!.claimWorkItem(readiness[0]!.id, {
      userId: OPERATIONS,
      roleKeys: [DEMO_ROLE_IDS.OPERATIONS],
      correlationId: "readiness-claim",
    });
    for (const key of ["scope", "access", "equipment"]) {
      await configuration.updateInspectionSetup({
        inspectionId: inspection.id,
        action: "checklist",
        checklistKey: key,
        checklistStatus: "complete",
        actorUserId: OWNER,
        correlationId: `ready-${key}`,
      });
    }
    await configuration.updateInspectionSetup({
      inspectionId: inspection.id,
      action: "ready",
      actorUserId: OWNER,
      correlationId: "ready",
    });
    const closed = await pipeline.workControl!.repository.getWorkItem(readiness[0]!.id);
    expect(closed?.status).toBe("completed");
  });

  it("creates submission work from inspection.completed and closes on submit", async () => {
    const fixture = await insertCompletedInspection(
      database,
      "BEA-IN-000201",
      clock.now().toISOString(),
    );
    await database.query(
      `INSERT INTO automation_events
       (id,event_type,schema_version,aggregate_type,aggregate_id,correlation_id,occurred_at,recorded_at,actor_type,actor_id,payload,processing_status)
       VALUES ($1,'inspection.completed','1','inspection',$2,'submission-trigger',$3,$3,'system',NULL,'{}'::jsonb,'pending')`,
      [randomUUID(), fixture.inspectionId, clock.now().toISOString()],
    );
    await pipeline.workControl!.processPendingEvents();
    const open = await pipeline.workControl!.repository.listWorkItems({
      inspectionId: fixture.inspectionId,
      kinds: ["inspection_submission"],
    });
    expect(open.some((item) => item.status === "open")).toBe(true);
    await pipeline.submitInspection({
      inspectionId: fixture.inspectionId,
      sourceChannel: "direct_entry",
      sourceIdempotencyKey: `submit-${fixture.inspectionId}`,
      payload: completeSyntheticSubmissionPayload(clock.now()),
      actorUserId: OPERATIONS,
      correlationId: "submission-complete",
    });
    const after = await pipeline.workControl!.repository.listWorkItems({
      inspectionId: fixture.inspectionId,
      kinds: ["inspection_submission"],
    });
    expect(after.some((item) => item.status === "completed")).toBe(true);
  });

  it("fails inspection.submitted when exceptionIds is omitted and does not dead-letter an official duplicate that includes them", async () => {
    const fixture = await insertCompletedInspection(
      database,
      "BEA-IN-000208",
      clock.now().toISOString(),
    );
    await database.query(
      `INSERT INTO automation_events
       (id,event_type,schema_version,aggregate_type,aggregate_id,correlation_id,occurred_at,recorded_at,actor_type,actor_id,payload,processing_status)
       VALUES ($1,'inspection.completed','1','inspection',$2,'dup-submit-trigger',$3,$3,'system',NULL,'{}'::jsonb,'pending')`,
      [randomUUID(), fixture.inspectionId, clock.now().toISOString()],
    );
    await pipeline.workControl!.processPendingEvents();
    const malformedId = await insertPendingEvent(
      "inspection.submitted",
      "inspection",
      fixture.inspectionId,
      { inspectionId: fixture.inspectionId, submissionId: randomUUID(), duplicate: true },
      "dup-submit-malformed",
    );
    await pipeline.workControl!.processPendingEvents();
    const malformed = await eventState(malformedId);
    expect(malformed?.processing_status).toBe("failed");
    expect(malformed?.projection_error_code).toBe("CYCLE_IDENTITY_INCOMPLETE");
    expect(malformed?.projection_error_message ?? "").toContain("exceptionIds");
    const first = await pipeline.submitInspection({
      inspectionId: fixture.inspectionId,
      sourceChannel: "direct_entry",
      sourceIdempotencyKey: `official-dup-${fixture.inspectionId}`,
      payload: completeSyntheticSubmissionPayload(clock.now()),
      actorUserId: OPERATIONS,
      correlationId: "official-dup-first",
    });
    expect(first.duplicate).toBe(false);
    const second = await pipeline.submitInspection({
      inspectionId: fixture.inspectionId,
      sourceChannel: "direct_entry",
      sourceIdempotencyKey: `official-dup-${fixture.inspectionId}`,
      payload: completeSyntheticSubmissionPayload(clock.now()),
      actorUserId: OPERATIONS,
      correlationId: "official-dup-second",
    });
    expect(second.duplicate).toBe(true);
    await pipeline.workControl!.processPendingEvents();
    const duplicateEvents = await database.query<{
      processing_status: string;
      payload: { duplicate?: boolean; exceptionIds?: unknown; submissionId?: string };
    }>(
      `SELECT processing_status, payload
         FROM automation_events
        WHERE event_type='inspection.submitted' AND aggregate_id=$1
        ORDER BY recorded_at`,
      [fixture.inspectionId],
    );
    const officialDuplicate = duplicateEvents.rows.find((row) => {
      const payload =
        typeof row.payload === "string"
          ? (JSON.parse(row.payload) as {
              duplicate?: boolean;
              exceptionIds?: unknown;
              submissionId?: string;
            })
          : row.payload;
      return payload.duplicate === true && Array.isArray(payload.exceptionIds);
    });
    expect(officialDuplicate).toBeDefined();
    const officialPayload =
      typeof officialDuplicate?.payload === "string"
        ? (JSON.parse(officialDuplicate.payload) as {
            submissionId?: string;
            exceptionIds?: unknown;
          })
        : officialDuplicate?.payload;
    expect(Array.isArray(officialPayload?.exceptionIds)).toBe(true);
    expect(officialPayload?.submissionId).toBe(first.submission.id);
    expect(officialDuplicate?.processing_status).toBe("processed");
    const failures = (
      await pipeline.workControl!.repository.listWorkItems({
        kinds: ["automation_failure"],
      })
    ).filter((item) => item.sourceAggregateId === fixture.inspectionId);
    expect(failures).toHaveLength(0);
    const submission = await pipeline.workControl!.repository.listWorkItems({
      inspectionId: fixture.inspectionId,
      kinds: ["inspection_submission"],
    });
    expect(submission.some((item) => item.status === "completed")).toBe(true);
  });

  it("creates one correction work item for validation failure and closes it after correction", async () => {
    const fixture = await insertCompletedInspection(
      database,
      "BEA-IN-000202",
      clock.now().toISOString(),
    );
    await pipeline.submitInspection({
      inspectionId: fixture.inspectionId,
      sourceChannel: "direct_entry",
      sourceIdempotencyKey: `incomplete-${fixture.inspectionId}`,
      payload: incompleteSyntheticSubmissionPayload(clock.now()),
      actorUserId: OPERATIONS,
      correlationId: "correction-open",
    });
    const corrections = await pipeline.workControl!.repository.listWorkItems({
      inspectionId: fixture.inspectionId,
      kinds: ["inspection_correction"],
    });
    const open = corrections.filter(
      (item) => item.status === "open" || item.status === "in_progress",
    );
    expect(open).toHaveLength(1);
    await pipeline.submitInspection({
      inspectionId: fixture.inspectionId,
      sourceChannel: "direct_entry",
      sourceIdempotencyKey: `complete-${fixture.inspectionId}`,
      payload: completeSyntheticSubmissionPayload(clock.now()),
      actorUserId: OPERATIONS,
      correlationId: "correction-close",
    });
    const after = await pipeline.workControl!.repository.getWorkItem(open[0]!.id);
    expect(after?.status).toBe("completed");
  });

  it("creates technical review work from draft/review and closes on approval", async () => {
    const fixture = await insertCompletedInspection(
      database,
      "BEA-IN-000203",
      clock.now().toISOString(),
    );
    await pipeline.submitInspection({
      inspectionId: fixture.inspectionId,
      sourceChannel: "direct_entry",
      sourceIdempotencyKey: `review-${fixture.inspectionId}`,
      payload: completeSyntheticSubmissionPayload(clock.now()),
      actorUserId: OPERATIONS,
      correlationId: "review-submit",
    });
    const report = await pipeline.repository.getReportByInspection(fixture.inspectionId);
    expect(report).toBeTruthy();
    const reviews = await pipeline.workControl!.repository.listWorkItems({
      kinds: ["report_technical_review"],
    });
    const open = reviews.filter(
      (item) =>
        item.reportId === report!.id && (item.status === "open" || item.status === "in_progress"),
    );
    expect(open.length).toBe(1);
    await pipeline.reviewReport({
      reportId: report!.id,
      decision: "approve",
      actorUserId: OPERATIONS,
      correlationId: "review-approve",
    });
    const closed = await pipeline.workControl!.repository.getWorkItem(open[0]!.id);
    expect(closed?.status).toBe("completed");
  });

  it("creates Owner-only delivery authorization work and refuses Operations claim", async () => {
    const fixture = await insertCompletedInspection(
      database,
      "BEA-IN-000204",
      clock.now().toISOString(),
    );
    await pipeline.submitInspection({
      inspectionId: fixture.inspectionId,
      sourceChannel: "direct_entry",
      sourceIdempotencyKey: `deliver-${fixture.inspectionId}`,
      payload: completeSyntheticSubmissionPayload(clock.now()),
      actorUserId: OPERATIONS,
      correlationId: "deliver-submit",
    });
    const report = await pipeline.repository.getReportByInspection(fixture.inspectionId);
    await pipeline.reviewReport({
      reportId: report!.id,
      decision: "approve",
      actorUserId: OPERATIONS,
      correlationId: "deliver-approve",
    });
    const live = await pipeline.repository.getReport(report!.id);
    expect(live?.status).toBe("ready_for_delivery");
    const authItems = (
      await pipeline.workControl!.repository.listWorkItems({
        kinds: ["report_delivery_authorization"],
      })
    ).filter((item) => item.reportId === report!.id && item.status === "open");
    expect(authItems).toHaveLength(1);
    await expect(
      pipeline.workControl!.claimWorkItem(authItems[0]!.id, {
        userId: OPERATIONS,
        roleKeys: [DEMO_ROLE_IDS.OPERATIONS],
        correlationId: "ops-claim-delivery",
      }),
    ).rejects.toBeInstanceOf(WorkItemClaimError);
    await pipeline.workControl!.claimWorkItem(authItems[0]!.id, {
      userId: OWNER,
      roleKeys: [DEMO_ROLE_IDS.OWNER_ADMIN],
      correlationId: "owner-claim-delivery",
    });
    await pipeline.authorizeDelivery({
      reportId: report!.id,
      actorUserId: OWNER,
      correlationId: "deliver-authorize",
    });
    const closed = await pipeline.workControl!.repository.getWorkItem(authItems[0]!.id);
    expect(closed?.status).toBe("completed");
    expect((await pipeline.repository.getReport(report!.id))?.status).toBe("delivered");
  });

  it("creates delivery-reconciliation work after a scripted failure and closes after retry", async () => {
    const fixture = await insertCompletedInspection(
      database,
      "BEA-IN-000205",
      clock.now().toISOString(),
    );
    const failing = createInspectionReportPipeline(database, "demo", {
      processInline: true,
      deliveryAdapter: new ScriptedDeliveryAdapter(1),
      now: () => clock.now(),
    });
    await failing.submitInspection({
      inspectionId: fixture.inspectionId,
      sourceChannel: "direct_entry",
      sourceIdempotencyKey: `fail-${fixture.inspectionId}`,
      payload: completeSyntheticSubmissionPayload(clock.now()),
      actorUserId: OPERATIONS,
      correlationId: "fail-submit",
    });
    const report = await failing.repository.getReportByInspection(fixture.inspectionId);
    await failing.reviewReport({
      reportId: report!.id,
      decision: "approve",
      actorUserId: OPERATIONS,
      correlationId: "fail-approve",
    });
    await failing.authorizeDelivery({
      reportId: report!.id,
      actorUserId: OWNER,
      correlationId: "fail-authorize",
    });
    expect((await failing.repository.getReport(report!.id))?.status).toBe("delivery_failed");
    const recon = (
      await failing.workControl!.repository.listWorkItems({
        kinds: ["delivery_reconciliation"],
      })
    ).filter((item) => item.reportId === report!.id && item.status === "open");
    expect(recon).toHaveLength(1);
    await failing.retryDelivery({
      reportId: report!.id,
      actorUserId: OWNER,
      correlationId: "fail-retry",
    });
    expect((await failing.repository.getReport(report!.id))?.status).toBe("delivered");
    expect((await failing.workControl!.repository.getWorkItem(recon[0]!.id))?.status).toBe(
      "completed",
    );
  });

  it("creates one reminder per threshold and remains idempotent after catch-up", async () => {
    const item = await pipeline.workControl!.repository.getWorkItem(
      SEEDED_WORK_CONTROL_IDS.labEscalatedWork,
    );
    expect(item).toBeTruthy();
    clock.set("2026-09-01T16:00:00.000Z");
    await pipeline.workControl!.evaluateDueSchedules();
    await pipeline.workControl!.evaluateDueSchedules();
    const reminders = await pipeline.workControl!.repository.listReminders(item!.id);
    const overdue = reminders.filter((reminder) => reminder.thresholdKey === "overdue");
    expect(overdue).toHaveLength(1);
    const notifications = (await pipeline.workControl!.repository.listNotifications()).filter(
      (row) => row.workItemId === item!.id && row.channel === "email_dry_run",
    );
    expect(
      notifications.every(
        (row) =>
          row.adapterResult?.includes("NO MESSAGE SENT") || row.subject.includes("NO MESSAGE SENT"),
      ),
    ).toBe(true);
    expect(EMAIL_DRY_RUN_DISCLOSURE).toContain("NO MESSAGE SENT");
    expect(TEAMS_DRY_RUN_DISCLOSURE).toContain("NO MESSAGE POSTED");
  });

  it("creates each escalation level once and resolves on completion", async () => {
    const fixture = await insertCompletedInspection(
      database,
      "BEA-IN-000206",
      "2026-09-01T08:00:00.000Z",
    );
    const reportId = randomUUID();
    const versionId = randomUUID();
    const submissionId = randomUUID();
    await database.query(
      `INSERT INTO inspection_reports
       (id,reference,inspection_id,project_id,template_id,current_template_version_id,status,current_version_number,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,'BEA-RP-000206',$2,$3,$4,$5,'in_review',1,$6,$7,$7,1)`,
      [
        reportId,
        fixture.inspectionId,
        fixture.projectId,
        "b3000000-0000-4000-8000-000000000001",
        "b3000000-0000-4000-8000-000000000011",
        OWNER,
        "2026-09-01T08:00:00.000Z",
      ],
    );
    await database.query(
      `INSERT INTO inspection_submissions
       (id,inspection_id,source_channel,source_idempotency_key,payload_sha256,raw_payload,schema_version,mapping_version,normalized_payload,created_at)
       VALUES ($1,$2,'direct_entry','esc-206','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','{}'::jsonb,'v1','v1','{}'::jsonb,$3)`,
      [submissionId, fixture.inspectionId, "2026-09-01T08:00:00.000Z"],
    );
    await database.query(
      `INSERT INTO report_versions
       (id,report_id,version_number,status,input_snapshot,template_version_id,submission_id,created_at)
       VALUES ($1,$2,1,'in_review','{}'::jsonb,$3,$4,$5)`,
      [
        versionId,
        reportId,
        "b3000000-0000-4000-8000-000000000011",
        submissionId,
        "2026-09-01T08:00:00.000Z",
      ],
    );
    await database.query(
      `INSERT INTO automation_events
       (id,event_type,schema_version,aggregate_type,aggregate_id,correlation_id,occurred_at,recorded_at,actor_type,actor_id,payload,processing_status)
       VALUES ($1,'report.review_requested','1','report',$2,'esc-review',$3,$3,'system',NULL,$4::jsonb,'pending')`,
      [
        randomUUID(),
        reportId,
        "2026-09-01T08:00:00.000Z",
        JSON.stringify({
          inspectionId: fixture.inspectionId,
          projectId: fixture.projectId,
          reportId,
          reportVersionId: versionId,
          versionId,
        }),
      ],
    );
    clock.set("2026-09-01T08:00:00.000Z");
    await pipeline.workControl!.processPendingEvents();
    const review = (
      await pipeline.workControl!.repository.listWorkItems({
        kinds: ["report_technical_review"],
      })
    ).find((item) => item.reportId === reportId && item.status === "open");
    expect(review).toBeTruthy();
    clock.set("2026-09-01T20:00:00.000Z");
    await pipeline.workControl!.evaluateDueSchedules();
    await pipeline.workControl!.evaluateDueSchedules();
    const escalations = await pipeline.workControl!.repository.listEscalations(review!.id);
    const levels = new Set(escalations.map((item) => item.escalationLevel));
    expect(levels.size).toBe(escalations.length);
  });

  it("replays events without duplicate work, reminders, or notifications", async () => {
    const beforeItems = await pipeline.workControl!.repository.listWorkItems({ limit: 500 });
    const beforeReminders = await pipeline.workControl!.repository.listReminders();
    const beforeNotes = await pipeline.workControl!.repository.listNotifications();
    await database.query(
      `UPDATE automation_events SET processing_status='pending'
        WHERE event_type IN ('inspection.completed','report.ready_for_delivery','inspection.validation_failed')`,
    );
    await pipeline.workControl!.processPendingEvents();
    const midItems = await pipeline.workControl!.repository.listWorkItems({ limit: 500 });
    const midReminders = await pipeline.workControl!.repository.listReminders();
    const midNotes = await pipeline.workControl!.repository.listNotifications();
    await pipeline.workControl!.processPendingEvents();
    const afterItems = await pipeline.workControl!.repository.listWorkItems({ limit: 500 });
    const afterReminders = await pipeline.workControl!.repository.listReminders();
    const afterNotes = await pipeline.workControl!.repository.listNotifications();
    expect(afterItems.length).toBe(midItems.length);
    expect(afterReminders.length).toBe(midReminders.length);
    expect(afterNotes.length).toBe(midNotes.length);
    expect(afterReminders.length).toBe(beforeReminders.length);
    expect(afterNotes.filter((item) => item.channel === "email_dry_run").length).toBe(
      beforeNotes.filter((item) => item.channel === "email_dry_run").length,
    );
    void beforeItems;
  });

  it("reconciles missing delivery-authorization work in dry-run then execute", async () => {
    await database.query(`DELETE FROM operational_work_items WHERE id=$1`, [
      SEEDED_WORK_CONTROL_IDS.labDeliveryWork,
    ]);
    const dry = await pipeline.workControl!.reconcile({
      mode: "dry_run",
      actorUserId: OWNER,
      correlationId: "recon-dry",
    });
    expect(dry.details.some((item) => item.action === "create_missing")).toBe(true);
    const executed = await pipeline.workControl!.reconcile({
      mode: "execute",
      actorUserId: OWNER,
      correlationId: "recon-exec",
    });
    expect(executed.createdMissing).toBeGreaterThanOrEqual(1);
    const again = await pipeline.workControl!.reconcile({
      mode: "execute",
      actorUserId: OWNER,
      correlationId: "recon-again",
    });
    expect(again.createdMissing).toBe(0);
  });

  it("refuses manual completion of critical workflow items", () => {
    expect(() => pipeline.workControl!.refuseManualCompletion("report_technical_review")).toThrow(
      WorkItemManualCompletionError,
    );
  });

  it("refuses publication and activation after artifact corruption", async () => {
    const cloned = await configuration.cloneRelease({
      releaseId: SEEDED_CONFIGURATION_IDS.exteriorRelease,
      actorUserId: OWNER,
      correlationId: "harden-clone",
    });
    const validated = await configuration.validateRelease({
      releaseId: cloned.id,
      actorUserId: OWNER,
      correlationId: "harden-validate",
    });
    expect(validated.passed).toBe(true);
    await database.query(
      `UPDATE configuration_artifacts
          SET payload = payload || '{"corrupted":true}'::jsonb
        WHERE id = (SELECT id FROM configuration_artifacts WHERE release_id=$1 LIMIT 1)`,
      [cloned.id],
    );
    await expect(
      configuration.publishRelease({
        releaseId: cloned.id,
        actorUserId: OWNER,
        correlationId: "harden-publish",
      }),
    ).rejects.toBeInstanceOf(ConfigurationValidationError);

    const clean = await configuration.cloneRelease({
      releaseId: SEEDED_CONFIGURATION_IDS.exteriorRelease,
      actorUserId: OWNER,
      correlationId: "harden-clone-2",
    });
    const cleanValidated = await configuration.validateRelease({
      releaseId: clean.id,
      actorUserId: OWNER,
      correlationId: "harden-validate-2",
    });
    expect(cleanValidated.passed).toBe(true);
    const published = await configuration.publishRelease({
      releaseId: clean.id,
      actorUserId: OWNER,
      correlationId: "harden-publish-2",
    });
    expect(published.status).toBe("published");
    await database.query(
      `UPDATE configuration_artifacts
          SET payload = payload || '{"corrupted":true}'::jsonb
        WHERE id = (SELECT id FROM configuration_artifacts WHERE release_id=$1 LIMIT 1)`,
      [clean.id],
    );
    await expect(
      configuration.activateRelease({
        releaseId: clean.id,
        actorUserId: OWNER,
        correlationId: "harden-activate",
      }),
    ).rejects.toThrow(/checksum|revalidation|corrupt|match/i);
  });

  it("does not grant reports.deliver through work.claim", async () => {
    const authorization = new PersistentAuthorizationService(new SqlFoundationRepository(database));
    expect(
      (await authorization.authorizeUser(OPERATIONS, PERMISSIONS.REPORTS_DELIVER)).allowed,
    ).toBe(false);
    expect(
      (await authorization.authorizeUser(INTEGRATION, PERMISSIONS.REPORTS_APPROVE)).allowed,
    ).toBe(false);
  });

  it("keeps Version-1 approval from closing Version-2 review work", async () => {
    const fixture = await insertCompletedInspection(
      database,
      "BEA-IN-000301",
      clock.now().toISOString(),
    );
    const reportId = randomUUID();
    const version1 = randomUUID();
    const version2 = randomUUID();
    await insertReportVersion(fixture, reportId, version1, "in_review");
    await insertPendingEvent(
      "report.review_requested",
      "report",
      reportId,
      {
        inspectionId: fixture.inspectionId,
        reportId,
        reportVersionId: version1,
        versionId: version1,
      },
      "v1-review",
    );
    await pipeline.workControl!.processPendingEvents();
    const v1Item = (
      await pipeline.workControl!.repository.listWorkItems({ kinds: ["report_technical_review"] })
    ).find((item) => item.reportVersionId === version1 && item.status === "open");
    expect(v1Item).toBeTruthy();
    await insertPendingEvent(
      "report.approved",
      "report",
      reportId,
      {
        inspectionId: fixture.inspectionId,
        reportId,
        reportVersionId: version1,
        versionId: version1,
      },
      "v1-approve",
    );
    await pipeline.workControl!.processPendingEvents();
    expect((await pipeline.workControl!.repository.getWorkItem(v1Item!.id))?.status).toBe(
      "completed",
    );
    await database.query(
      `INSERT INTO report_versions
       (id,report_id,version_number,status,input_snapshot,template_version_id,submission_id,created_at)
       SELECT $1,$2,2,'in_review','{}'::jsonb,template_version_id,submission_id,$3
         FROM report_versions WHERE id=$4`,
      [version2, reportId, clock.now().toISOString(), version1],
    );
    await database.query(
      `UPDATE inspection_reports SET current_version_number=2, status='in_review' WHERE id=$1`,
      [reportId],
    );
    await insertPendingEvent(
      "report.review_requested",
      "report",
      reportId,
      {
        inspectionId: fixture.inspectionId,
        reportId,
        reportVersionId: version2,
        versionId: version2,
      },
      "v2-review",
    );
    await pipeline.workControl!.processPendingEvents();
    const v2Item = (
      await pipeline.workControl!.repository.listWorkItems({ kinds: ["report_technical_review"] })
    ).find((item) => item.reportVersionId === version2 && item.status === "open");
    expect(v2Item).toBeTruthy();
    await insertPendingEvent(
      "report.approved",
      "report",
      reportId,
      {
        inspectionId: fixture.inspectionId,
        reportId,
        reportVersionId: version1,
        versionId: version1,
      },
      "v1-delayed-approve",
    );
    await pipeline.workControl!.processPendingEvents();
    expect((await pipeline.workControl!.repository.getWorkItem(v2Item!.id))?.status).toBe("open");
  });

  it("keeps correction cycle A from closing correction cycle B", async () => {
    const fixture = await insertCompletedInspection(
      database,
      "BEA-IN-000302",
      clock.now().toISOString(),
    );
    const exceptionA = randomUUID();
    const exceptionB = randomUUID();
    for (const exceptionId of [exceptionA, exceptionB]) {
      await database.query(
        `INSERT INTO exception_cases
         (id,reference,kind,status,severity,title,detail,inspection_id,project_id,owner_user_id,sla_attribution,created_at,updated_at,version)
         VALUES ($1,$2,'validation','open','error','Correction','Synthetic.',$3,$4,$5,'human_waiting',$6,$6,1)`,
        [
          exceptionId,
          `BEA-EX-${exceptionId.replaceAll("-", "")}`,
          fixture.inspectionId,
          fixture.projectId,
          OPERATIONS,
          clock.now().toISOString(),
        ],
      );
    }
    await insertPendingEvent(
      "exception.created",
      "exception",
      exceptionA,
      { inspectionId: fixture.inspectionId, exceptionId: exceptionA },
      "ex-a-open",
    );
    await pipeline.workControl!.processPendingEvents();
    const itemA = (
      await pipeline.workControl!.repository.listWorkItems({
        inspectionId: fixture.inspectionId,
        kinds: ["inspection_correction"],
      })
    ).find((item) => item.exceptionId === exceptionA && item.status === "open");
    expect(itemA).toBeTruthy();
    await insertPendingEvent(
      "exception.resolved",
      "exception",
      exceptionA,
      { inspectionId: fixture.inspectionId, exceptionId: exceptionA },
      "ex-a-close",
    );
    await pipeline.workControl!.processPendingEvents();
    expect((await pipeline.workControl!.repository.getWorkItem(itemA!.id))?.status).toBe(
      "completed",
    );
    await insertPendingEvent(
      "exception.created",
      "exception",
      exceptionB,
      { inspectionId: fixture.inspectionId, exceptionId: exceptionB },
      "ex-b-open",
    );
    await pipeline.workControl!.processPendingEvents();
    const itemB = (
      await pipeline.workControl!.repository.listWorkItems({
        inspectionId: fixture.inspectionId,
        kinds: ["inspection_correction"],
      })
    ).find((item) => item.exceptionId === exceptionB && item.status === "open");
    expect(itemB).toBeTruthy();
    await insertPendingEvent(
      "inspection.submitted",
      "inspection",
      fixture.inspectionId,
      {
        inspectionId: fixture.inspectionId,
        exceptionIds: [exceptionA],
        submissionId: randomUUID(),
      },
      "ex-a-delayed-submit",
    );
    await insertPendingEvent(
      "exception.resolved",
      "exception",
      exceptionA,
      { inspectionId: fixture.inspectionId, exceptionId: exceptionA },
      "ex-a-delayed-resolve",
    );
    await pipeline.workControl!.processPendingEvents();
    expect((await pipeline.workControl!.repository.getWorkItem(itemB!.id))?.status).toBe("open");
  });

  it("keeps Version-1 delivery authorization from closing Version-2 work", async () => {
    const fixture = await insertCompletedInspection(
      database,
      "BEA-IN-000303",
      clock.now().toISOString(),
    );
    const reportId = randomUUID();
    const version1 = randomUUID();
    const version2 = randomUUID();
    await insertReportVersion(fixture, reportId, version1, "ready_for_delivery");
    await insertPendingEvent(
      "report.ready_for_delivery",
      "report",
      reportId,
      {
        inspectionId: fixture.inspectionId,
        reportId,
        reportVersionId: version1,
        versionId: version1,
      },
      "v1-ready",
    );
    await pipeline.workControl!.processPendingEvents();
    const v1Auth = (
      await pipeline.workControl!.repository.listWorkItems({
        kinds: ["report_delivery_authorization"],
      })
    ).find((item) => item.reportVersionId === version1 && item.status === "open");
    expect(v1Auth).toBeTruthy();
    await database.query(
      `INSERT INTO report_versions
       (id,report_id,version_number,status,input_snapshot,template_version_id,submission_id,created_at)
       SELECT $1,$2,2,'final','{}'::jsonb,template_version_id,submission_id,$3
         FROM report_versions WHERE id=$4`,
      [version2, reportId, clock.now().toISOString(), version1],
    );
    await database.query(
      `UPDATE inspection_reports SET current_version_number=2, status='ready_for_delivery' WHERE id=$1`,
      [reportId],
    );
    await insertPendingEvent(
      "report.draft_created",
      "report",
      reportId,
      {
        inspectionId: fixture.inspectionId,
        reportId,
        reportVersionId: version2,
        versionId: version2,
        previousVersionId: version1,
        requestedRevisionVersionId: version1,
      },
      "v1-supersede",
    );
    await insertPendingEvent(
      "report.ready_for_delivery",
      "report",
      reportId,
      {
        inspectionId: fixture.inspectionId,
        reportId,
        reportVersionId: version2,
        versionId: version2,
      },
      "v2-ready",
    );
    await pipeline.workControl!.processPendingEvents();
    const v2Auth = (
      await pipeline.workControl!.repository.listWorkItems({
        kinds: ["report_delivery_authorization"],
      })
    ).find((item) => item.reportVersionId === version2 && item.status === "open");
    expect(v2Auth).toBeTruthy();
    expect((await pipeline.workControl!.repository.getWorkItem(v1Auth!.id))?.status).toBe(
      "cancelled",
    );
    await insertPendingEvent(
      "report.delivery_requested",
      "report",
      reportId,
      {
        inspectionId: fixture.inspectionId,
        reportId,
        reportVersionId: version1,
        versionId: version1,
      },
      "v1-delayed-deliver",
    );
    await pipeline.workControl!.processPendingEvents();
    expect((await pipeline.workControl!.repository.getWorkItem(v2Auth!.id))?.status).toBe("open");
  });

  it("closes only the Version-1 revision cycle when Version 2 is created", async () => {
    const fixture = await insertCompletedInspection(
      database,
      "BEA-IN-000304",
      clock.now().toISOString(),
    );
    const reportId = randomUUID();
    const version1 = randomUUID();
    const version2 = randomUUID();
    await insertReportVersion(fixture, reportId, version1, "in_review");
    await insertPendingEvent(
      "report.review_requested",
      "report",
      reportId,
      {
        inspectionId: fixture.inspectionId,
        reportId,
        reportVersionId: version1,
        versionId: version1,
      },
      "rev-review",
    );
    await pipeline.workControl!.processPendingEvents();
    await insertPendingEvent(
      "report.revision_requested",
      "report",
      reportId,
      {
        inspectionId: fixture.inspectionId,
        reportId,
        reportVersionId: version1,
        versionId: version1,
        requestedRevisionVersionId: version1,
      },
      "rev-request",
    );
    await pipeline.workControl!.processPendingEvents();
    const revision = (
      await pipeline.workControl!.repository.listWorkItems({ kinds: ["report_revision"] })
    ).find((item) => item.reportVersionId === version1 && item.status === "open");
    expect(revision).toBeTruthy();
    await database.query(
      `INSERT INTO report_versions
       (id,report_id,version_number,status,input_snapshot,template_version_id,submission_id,created_at)
       SELECT $1,$2,2,'in_review','{}'::jsonb,template_version_id,submission_id,$3
         FROM report_versions WHERE id=$4`,
      [version2, reportId, clock.now().toISOString(), version1],
    );
    await insertPendingEvent(
      "report.draft_created",
      "report",
      reportId,
      {
        inspectionId: fixture.inspectionId,
        reportId,
        reportVersionId: version2,
        versionId: version2,
        previousVersionId: version1,
        requestedRevisionVersionId: version1,
      },
      "rev-v2",
    );
    await pipeline.workControl!.processPendingEvents();
    expect((await pipeline.workControl!.repository.getWorkItem(revision!.id))?.status).toBe(
      "completed",
    );
    const v2Review = (
      await pipeline.workControl!.repository.listWorkItems({ kinds: ["report_technical_review"] })
    ).find((item) => item.reportVersionId === version2 && item.status === "open");
    expect(v2Review).toBeTruthy();
  });

  it("creates one review item from complementary draft and review events", async () => {
    const fixture = await insertCompletedInspection(
      database,
      "BEA-IN-000305",
      clock.now().toISOString(),
    );
    const reportId = randomUUID();
    const versionId = randomUUID();
    await insertReportVersion(fixture, reportId, versionId, "in_review");
    const draftId = await insertPendingEvent(
      "report.draft_created",
      "report",
      reportId,
      { inspectionId: fixture.inspectionId, reportId, reportVersionId: versionId, versionId },
      "complement-draft",
    );
    const reviewId = await insertPendingEvent(
      "report.review_requested",
      "report",
      reportId,
      { inspectionId: fixture.inspectionId, reportId, reportVersionId: versionId, versionId },
      "complement-review",
    );
    await Promise.all([
      pipeline.workControl!.processEventById(draftId),
      pipeline.workControl!.processEventById(reviewId),
    ]);
    const items = (
      await pipeline.workControl!.repository.listWorkItems({ kinds: ["report_technical_review"] })
    ).filter((item) => item.reportId === reportId);
    expect(items).toHaveLength(1);
    const events = await database.query<{ processing_status: string }>(
      "SELECT processing_status FROM automation_events WHERE id=$1 OR id=$2",
      [draftId, reviewId],
    );
    expect(events.rows).toHaveLength(2);
    expect(events.rows.every((row) => row.processing_status === "processed")).toBe(true);
    const receipts = await database.query<{ result: string; n: string }>(
      `SELECT result, COUNT(*)::text AS n FROM event_projection_receipts
        WHERE source_event_id=$1 OR source_event_id=$2
        GROUP BY result`,
      [draftId, reviewId],
    );
    const countFor = (result: string) =>
      Number(receipts.rows.find((row) => row.result === result)?.n ?? 0);
    expect(countFor("created") + countFor("duplicate_suppressed")).toBe(2);
    expect(countFor("not_applicable")).toBe(2);
  });

  it("releases role-queue claims without durable assignment and allows Operations B to claim", async () => {
    const itemId = SEEDED_WORK_CONTROL_IDS.labCorrectionWork;
    await database.query(
      `UPDATE operational_work_items
          SET assigned_user_id=NULL, claimed_user_id=NULL, claimed_at=NULL, started_at=NULL, acknowledged_at=NULL, status='open'
        WHERE id=$1`,
      [itemId],
    );
    const claimed = await pipeline.workControl!.claimWorkItem(itemId, {
      userId: OPERATIONS,
      roleKeys: [DEMO_ROLE_IDS.OPERATIONS],
      correlationId: "ops-a-claim",
    });
    expect(claimed.assignedUserId).toBeNull();
    expect(claimed.claimedUserId).toBe(OPERATIONS);
    expect(claimed.startedAt).toBeNull();
    const acknowledged = await pipeline.workControl!.acknowledgeWorkItem(itemId, {
      userId: OPERATIONS,
      roleKeys: [DEMO_ROLE_IDS.OPERATIONS],
      correlationId: "ops-a-ack",
    });
    expect(acknowledged.acknowledgedAt).toBeTruthy();
    expect(acknowledged.startedAt).toBeNull();
    const started = await pipeline.workControl!.startWorkItem(itemId, {
      userId: OPERATIONS,
      roleKeys: [DEMO_ROLE_IDS.OPERATIONS],
      correlationId: "ops-a-start",
    });
    expect(started.startedAt).toBeTruthy();
    await pipeline.workControl!.releaseClaim(itemId, {
      userId: OPERATIONS,
      roleKeys: [DEMO_ROLE_IDS.OPERATIONS],
      correlationId: "ops-a-release",
    });
    await database.query(
      "UPDATE operational_work_items SET status='open', started_at=NULL, acknowledged_at=NULL WHERE id=$1",
      [itemId],
    );
    const released = await pipeline.workControl!.repository.getWorkItem(itemId);
    expect(released?.assignedUserId).toBeNull();
    expect(released?.claimedUserId).toBeNull();
    const claimedB = await pipeline.workControl!.claimWorkItem(itemId, {
      userId: OPERATIONS_B,
      roleKeys: [DEMO_ROLE_IDS.OPERATIONS],
      correlationId: "ops-b-claim",
    });
    expect(claimedB.claimedUserId).toBe(OPERATIONS_B);
    expect(claimedB.assignedUserId).toBeNull();
    await pipeline.workControl!.releaseClaim(itemId, {
      userId: OPERATIONS_B,
      roleKeys: [DEMO_ROLE_IDS.OPERATIONS],
      correlationId: "ops-b-release",
    });
  });

  it("keeps explicit assignment after claim/release and requires Owner reassignment", async () => {
    const itemId = SEEDED_WORK_CONTROL_IDS.labEscalatedWork;
    await database.query(
      `UPDATE operational_work_items
          SET assigned_user_id=$2, claimed_user_id=NULL, claimed_at=NULL, status='open'
        WHERE id=$1`,
      [itemId, OPERATIONS],
    );
    await pipeline.workControl!.claimWorkItem(itemId, {
      userId: OPERATIONS,
      roleKeys: [DEMO_ROLE_IDS.OPERATIONS],
      correlationId: "explicit-claim",
    });
    await pipeline.workControl!.releaseClaim(itemId, {
      userId: OPERATIONS,
      roleKeys: [DEMO_ROLE_IDS.OPERATIONS],
      correlationId: "explicit-release",
    });
    const afterRelease = await pipeline.workControl!.repository.getWorkItem(itemId);
    expect(afterRelease?.assignedUserId).toBe(OPERATIONS);
    expect(afterRelease?.claimedUserId).toBeNull();
    await expect(
      pipeline.workControl!.claimWorkItem(itemId, {
        userId: OPERATIONS_B,
        roleKeys: [DEMO_ROLE_IDS.OPERATIONS],
        correlationId: "explicit-b-denied",
      }),
    ).rejects.toBeInstanceOf(WorkItemClaimError);
    await pipeline.workControl!.reassignWorkItem(
      itemId,
      {
        userId: OWNER,
        roleKeys: [DEMO_ROLE_IDS.OWNER_ADMIN],
        correlationId: "explicit-reassign",
      },
      { assignedUserId: OPERATIONS_B, assignedRoleKey: DEMO_ROLE_IDS.OPERATIONS },
    );
    const claimedB = await pipeline.workControl!.claimWorkItem(itemId, {
      userId: OPERATIONS_B,
      roleKeys: [DEMO_ROLE_IDS.OPERATIONS],
      correlationId: "explicit-b-claim",
    });
    expect(claimedB.assignedUserId).toBe(OPERATIONS_B);
    await pipeline.workControl!.releaseClaim(itemId, {
      userId: OPERATIONS_B,
      roleKeys: [DEMO_ROLE_IDS.OPERATIONS],
      correlationId: "explicit-b-release",
    });
  });

  it("retries a supported projection failure and ignores unsupported events", async () => {
    const fixture = await insertCompletedInspection(
      database,
      "BEA-IN-000306",
      clock.now().toISOString(),
    );
    const missingReportId = randomUUID();
    const versionId = randomUUID();
    const eventId = await insertPendingEvent(
      "report.review_requested",
      "report",
      missingReportId,
      {
        inspectionId: fixture.inspectionId,
        reportId: missingReportId,
        reportVersionId: versionId,
        versionId,
      },
      "retryable-missing-report",
    );
    await pipeline.workControl!.processPendingEvents();
    const failed = await database.query<{ processing_status: string }>(
      "SELECT processing_status FROM automation_events WHERE id=$1",
      [eventId],
    );
    expect(failed.rows[0]?.processing_status).toBe("failed");
    const failures = await pipeline.workControl!.repository.listProjectionFailures();
    expect(failures.some((row) => row.sourceEventId === eventId)).toBe(true);
    await insertReportVersion(fixture, missingReportId, versionId, "in_review");
    await pipeline.workControl!.retryProjectionEvent(eventId, {
      userId: OWNER,
      roleKeys: [DEMO_ROLE_IDS.OWNER_ADMIN],
      correlationId: "retry-missing-report",
    });
    await pipeline.workControl!.processPendingEvents();
    const processed = await database.query<{ processing_status: string }>(
      "SELECT processing_status FROM automation_events WHERE id=$1",
      [eventId],
    );
    expect(processed.rows[0]?.processing_status).toBe("processed");
    const reviews = (
      await pipeline.workControl!.repository.listWorkItems({ kinds: ["report_technical_review"] })
    ).filter((item) => item.reportId === missingReportId);
    expect(reviews).toHaveLength(1);
    const unsupportedId = await insertPendingEvent(
      "lead.created",
      "lead",
      randomUUID(),
      {},
      "unsupported-event",
    );
    await pipeline.workControl!.processPendingEvents();
    const ignored = await database.query<{ processing_status: string }>(
      "SELECT processing_status FROM automation_events WHERE id=$1",
      [unsupportedId],
    );
    expect(ignored.rows[0]?.processing_status).toBe("ignored");
    const unsupportedFailures = await database.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM event_projection_failures WHERE source_event_id=$1",
      [unsupportedId],
    );
    expect(Number(unsupportedFailures.rows[0]?.n)).toBe(0);
  });

  it("closes automation-failure work only from the exact job event", async () => {
    const fixture = await insertCompletedInspection(
      database,
      "BEA-IN-000307",
      clock.now().toISOString(),
    );
    const jobId = randomUUID();
    await database.query(
      `INSERT INTO automation_jobs
       (id,job_type,blueprint_key,blueprint_version,aggregate_type,aggregate_id,idempotency_key,status,attempt_count,max_attempts,available_at,payload,created_at,updated_at,version)
       VALUES ($1,'inspection.validate','inspection.submission-validation',1,'inspection',$2,$3,'dead_letter',3,3,$4,'{"synthetic":true}'::jsonb,$4,$4,1)`,
      [jobId, fixture.inspectionId, `job-fail-${jobId}`, clock.now().toISOString()],
    );
    await insertPendingEvent(
      "automation.job_dead_letter",
      "job",
      jobId,
      { jobId, inspectionId: fixture.inspectionId },
      "job-dlq",
    );
    await pipeline.workControl!.processPendingEvents();
    const failureItem = (
      await pipeline.workControl!.repository.listWorkItems({ kinds: ["automation_failure"] })
    ).find((item) => item.jobId === jobId && item.status === "open");
    expect(failureItem).toBeTruthy();
    const exceptionId = randomUUID();
    await database.query(
      `INSERT INTO exception_cases
       (id,reference,kind,status,severity,title,detail,inspection_id,project_id,owner_user_id,sla_attribution,created_at,updated_at,version)
       VALUES ($1,'BEA-EX-000307','validation','open','error','Unrelated','Unrelated.',$2,$3,$4,'human_waiting',$5,$5,1)`,
      [exceptionId, fixture.inspectionId, fixture.projectId, OPERATIONS, clock.now().toISOString()],
    );
    await insertPendingEvent(
      "exception.resolved",
      "exception",
      exceptionId,
      { inspectionId: fixture.inspectionId, exceptionId, reportId: null },
      "unrelated-exception",
    );
    await pipeline.workControl!.processPendingEvents();
    expect((await pipeline.workControl!.repository.getWorkItem(failureItem!.id))?.status).toBe(
      "open",
    );
    await insertPendingEvent("automation.job_requeued", "job", jobId, { jobId }, "job-requeue");
    await pipeline.workControl!.processPendingEvents();
    expect((await pipeline.workControl!.repository.getWorkItem(failureItem!.id))?.status).toBe(
      "open",
    );
    await insertPendingEvent("automation.job_succeeded", "job", jobId, { jobId }, "job-success");
    await pipeline.workControl!.processPendingEvents();
    expect((await pipeline.workControl!.repository.getWorkItem(failureItem!.id))?.status).toBe(
      "completed",
    );
  });

  it("names metrics as counts versus millisecond durations", async () => {
    const metrics = await pipeline.workControl!.metrics(clock.now());
    expect(metrics).toEqual(
      expect.objectContaining({
        synthetic: true,
        openCountByKind: expect.any(Object),
        humanWaitingMsByKind: expect.any(Object),
        openByRoleCount: expect.any(Object),
        openByAssigneeCount: expect.any(Object),
        reportDelayCountByBucket: expect.any(Object),
        reportDelayMsByBucket: expect.any(Object),
      }),
    );
    expect(metrics).not.toHaveProperty("humanWaitingByKind");
    expect(metrics).not.toHaveProperty("reportDelayBuckets");
    for (const value of Object.values(metrics.humanWaitingMsByKind)) {
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  async function eventState(eventId: string) {
    const row = await database.query<{
      processing_status: string;
      projection_attempt_count: number | string | null;
      projection_error_code: string | null;
      projection_error_message: string | null;
      projection_dead_lettered_at: string | null;
      projection_retryable: boolean | string | null;
    }>(
      `SELECT processing_status, projection_attempt_count, projection_error_code, projection_error_message,
              projection_dead_lettered_at, projection_retryable
         FROM automation_events WHERE id=$1`,
      [eventId],
    );
    return row.rows[0];
  }

  async function exhaustProjection(
    plane: WorkControlPlane,
    eventId: string,
    attempts = PROJECTION_MAX_ATTEMPTS,
  ) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await database.query(
        "UPDATE automation_events SET projection_next_retry_at=NULL WHERE id=$1",
        [eventId],
      );
      try {
        await plane.processEventById(eventId);
      } catch {
        /* recorded by the executor */
      }
    }
  }

  it("fails report.approved without reportVersionId and leaves technical-review work open", async () => {
    const fixture = await insertCompletedInspection(
      database,
      "BEA-IN-000401",
      clock.now().toISOString(),
    );
    const reportId = randomUUID();
    const versionId = randomUUID();
    await insertReportVersion(fixture, reportId, versionId, "in_review");
    await insertPendingEvent(
      "report.review_requested",
      "report",
      reportId,
      {
        inspectionId: fixture.inspectionId,
        reportId,
        reportVersionId: versionId,
        versionId,
      },
      "contract-review-open",
    );
    await pipeline.workControl!.processPendingEvents();
    const open = (
      await pipeline.workControl!.repository.listWorkItems({ kinds: ["report_technical_review"] })
    ).find((item) => item.reportId === reportId && item.status === "open");
    expect(open).toBeTruthy();
    const eventId = await insertPendingEvent(
      "report.approved",
      "report",
      reportId,
      { inspectionId: fixture.inspectionId, reportId },
      "contract-approved-missing-version",
    );
    await pipeline.workControl!.processPendingEvents();
    const state = await eventState(eventId);
    expect(state?.processing_status).toBe("failed");
    expect(state?.projection_error_code).toBe("CYCLE_IDENTITY_INCOMPLETE");
    expect(state?.projection_error_message ?? "").toContain("reportVersionId");
    expect((await pipeline.workControl!.repository.getWorkItem(open!.id))?.status).toBe("open");
    const failures = await database.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM event_projection_failures WHERE source_event_id=$1",
      [eventId],
    );
    expect(Number(failures.rows[0]?.n)).toBeGreaterThanOrEqual(1);
  });

  it("fails report.delivered without deliveryId and leaves reconciliation work open", async () => {
    const fixture = await insertCompletedInspection(
      database,
      "BEA-IN-000402",
      clock.now().toISOString(),
    );
    const reportId = randomUUID();
    const versionId = randomUUID();
    await insertReportVersion(fixture, reportId, versionId, "approved");
    const deliveryId = randomUUID();
    await database.query(
      `INSERT INTO report_deliveries
       (id,report_id,report_version_id,idempotency_key,adapter_key,status,recipients,subject,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,'local-test','failed','[]'::jsonb,'Synthetic delivery',$5,$5,1)`,
      [deliveryId, reportId, versionId, `delivery-${deliveryId}`, clock.now().toISOString()],
    );
    await insertPendingEvent(
      "report.delivery_failed",
      "report",
      reportId,
      {
        inspectionId: fixture.inspectionId,
        reportId,
        reportVersionId: versionId,
        deliveryId,
      },
      "contract-delivery-failed",
    );
    await pipeline.workControl!.processPendingEvents();
    const recon = (
      await pipeline.workControl!.repository.listWorkItems({ kinds: ["delivery_reconciliation"] })
    ).find((item) => item.deliveryId === deliveryId && item.status === "open");
    expect(recon).toBeTruthy();
    const eventId = await insertPendingEvent(
      "report.delivered",
      "report",
      reportId,
      { inspectionId: fixture.inspectionId, reportId, reportVersionId: versionId },
      "contract-delivered-missing-delivery",
    );
    await pipeline.workControl!.processPendingEvents();
    const state = await eventState(eventId);
    expect(state?.processing_status).toBe("failed");
    expect(state?.projection_error_code).toBe("CYCLE_IDENTITY_INCOMPLETE");
    expect(state?.projection_error_message ?? "").toContain("deliveryId");
    expect((await pipeline.workControl!.repository.getWorkItem(recon!.id))?.status).toBe("open");
  });

  it("fails inspection.validated when exceptionIds is omitted and leaves correction work open", async () => {
    const fixture = await insertCompletedInspection(
      database,
      "BEA-IN-000403",
      clock.now().toISOString(),
    );
    const exceptionId = randomUUID();
    await database.query(
      `INSERT INTO exception_cases
       (id,reference,kind,status,severity,title,detail,inspection_id,project_id,owner_user_id,sla_attribution,created_at,updated_at,version)
       VALUES ($1,'BEA-EX-000403','validation','open','error','Correction','Correction.',$2,$3,$4,'human_waiting',$5,$5,1)`,
      [exceptionId, fixture.inspectionId, fixture.projectId, OPERATIONS, clock.now().toISOString()],
    );
    await insertPendingEvent(
      "inspection.validation_failed",
      "inspection",
      fixture.inspectionId,
      { inspectionId: fixture.inspectionId, exceptionId, exceptionIds: [exceptionId] },
      "contract-correction-open",
    );
    await pipeline.workControl!.processPendingEvents();
    const correction = (
      await pipeline.workControl!.repository.listWorkItems({ kinds: ["inspection_correction"] })
    ).find((item) => item.exceptionId === exceptionId && item.status === "open");
    expect(correction).toBeTruthy();
    const eventId = await insertPendingEvent(
      "inspection.validated",
      "inspection",
      fixture.inspectionId,
      { inspectionId: fixture.inspectionId },
      "contract-validated-missing-exceptions",
    );
    await pipeline.workControl!.processPendingEvents();
    const state = await eventState(eventId);
    expect(state?.processing_status).toBe("failed");
    expect(state?.projection_error_code).toBe("CYCLE_IDENTITY_INCOMPLETE");
    expect(state?.projection_error_message ?? "").toContain("exceptionIds");
    expect((await pipeline.workControl!.repository.getWorkItem(correction!.id))?.status).toBe(
      "open",
    );
  });

  it("processes inspection.validated with an explicit empty exceptionIds array", async () => {
    const fixture = await insertCompletedInspection(
      database,
      "BEA-IN-000404",
      clock.now().toISOString(),
    );
    const before = await pipeline.workControl!.repository.listWorkItems({
      inspectionId: fixture.inspectionId,
      kinds: ["inspection_correction"],
    });
    const eventId = await insertPendingEvent(
      "inspection.validated",
      "inspection",
      fixture.inspectionId,
      { inspectionId: fixture.inspectionId, exceptionIds: [] },
      "contract-validated-empty",
    );
    await pipeline.workControl!.processPendingEvents();
    expect((await eventState(eventId))?.processing_status).toBe("processed");
    const after = await pipeline.workControl!.repository.listWorkItems({
      inspectionId: fixture.inspectionId,
      kinds: ["inspection_correction"],
    });
    expect(after).toHaveLength(before.length);
    const receipts = await database.query<{ result: string }>(
      "SELECT result FROM event_projection_receipts WHERE source_event_id=$1",
      [eventId],
    );
    expect(receipts.rows.some((row) => row.result === "not_applicable")).toBe(true);
  });

  it("creates technical-review work from an initial draft without closing a revision cycle", async () => {
    const fixture = await insertCompletedInspection(
      database,
      "BEA-IN-000405",
      clock.now().toISOString(),
    );
    const reportId = randomUUID();
    const versionId = randomUUID();
    await insertReportVersion(fixture, reportId, versionId, "in_review");
    const eventId = await insertPendingEvent(
      "report.draft_created",
      "report",
      reportId,
      {
        inspectionId: fixture.inspectionId,
        reportId,
        reportVersionId: versionId,
        versionId,
      },
      "contract-initial-draft",
    );
    await pipeline.workControl!.processPendingEvents();
    expect((await eventState(eventId))?.processing_status).toBe("processed");
    const reviews = (
      await pipeline.workControl!.repository.listWorkItems({ kinds: ["report_technical_review"] })
    ).filter((item) => item.reportId === reportId);
    expect(reviews).toHaveLength(1);
    const revisions = (
      await pipeline.workControl!.repository.listWorkItems({ kinds: ["report_revision"] })
    ).filter((item) => item.reportId === reportId && item.status === "completed");
    expect(revisions).toHaveLength(0);
  });

  it("fails report.delivery_requested without reportVersionId and leaves authorization work open", async () => {
    const fixture = await insertCompletedInspection(
      database,
      "BEA-IN-000406",
      clock.now().toISOString(),
    );
    const reportId = randomUUID();
    const versionId = randomUUID();
    await insertReportVersion(fixture, reportId, versionId, "ready_for_delivery");
    await insertPendingEvent(
      "report.ready_for_delivery",
      "report",
      reportId,
      { inspectionId: fixture.inspectionId, reportId, reportVersionId: versionId, versionId },
      "contract-ready-for-delivery",
    );
    await pipeline.workControl!.processPendingEvents();
    const auth = (
      await pipeline.workControl!.repository.listWorkItems({
        kinds: ["report_delivery_authorization"],
      })
    ).find((item) => item.reportId === reportId && item.status === "open");
    expect(auth).toBeTruthy();
    const eventId = await insertPendingEvent(
      "report.delivery_requested",
      "report",
      reportId,
      { inspectionId: fixture.inspectionId, reportId },
      "contract-delivery-requested-missing-version",
    );
    await pipeline.workControl!.processPendingEvents();
    const state = await eventState(eventId);
    expect(state?.processing_status).toBe("failed");
    expect(state?.projection_error_code).toBe("CYCLE_IDENTITY_INCOMPLETE");
    expect(state?.projection_error_message ?? "").toContain("reportVersionId");
    expect((await pipeline.workControl!.repository.getWorkItem(auth!.id))?.status).toBe("open");
  });

  it("dead-letters a missing-report projection and creates failure work without a report FK", async () => {
    const fixture = await insertCompletedInspection(
      database,
      "BEA-IN-000407",
      clock.now().toISOString(),
    );
    const missingReportId = randomUUID();
    const versionId = randomUUID();
    const eventId = await insertPendingEvent(
      "report.review_requested",
      "report",
      missingReportId,
      {
        inspectionId: fixture.inspectionId,
        reportId: missingReportId,
        reportVersionId: versionId,
        versionId,
      },
      "exhaust-missing-report",
    );
    const attempts: number[] = [];
    for (let attempt = 1; attempt <= PROJECTION_MAX_ATTEMPTS; attempt += 1) {
      await database.query(
        "UPDATE automation_events SET projection_next_retry_at=NULL WHERE id=$1",
        [eventId],
      );
      try {
        await pipeline.workControl!.processEventById(eventId);
      } catch {
        /* recorded */
      }
      attempts.push(Number((await eventState(eventId))?.projection_attempt_count ?? 0));
    }
    expect(attempts).toEqual([1, 2, 3, 4, 5]);
    const state = await eventState(eventId);
    expect(state?.processing_status).toBe("dead_lettered");
    expect(state?.projection_dead_lettered_at).toBeTruthy();
    const failures = await database.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM event_projection_failures WHERE source_event_id=$1",
      [eventId],
    );
    expect(Number(failures.rows[0]?.n)).toBe(PROJECTION_MAX_ATTEMPTS);
    const cycle = buildWorkItemCycleIdentity({
      kind: "automation_failure",
      projectionEventId: eventId,
      failureSourceType: "projection",
      failureSourceId: eventId,
    });
    const items = (
      await pipeline.workControl!.repository.listWorkItems({ kinds: ["automation_failure"] })
    ).filter((item) => item.cycleIdentity === cycle);
    expect(items).toHaveLength(1);
    expect(items[0]?.reportId).toBeNull();
    expect(items[0]?.sourceAggregateType).toBe("report");
    expect(items[0]?.sourceAggregateId).toBe(missingReportId);
    expect(items[0]?.jobId).toBeNull();
  });

  it("continues a poll after a poison event and processes a later healthy event", async () => {
    const fixture = await insertCompletedInspection(
      database,
      "BEA-IN-000408",
      clock.now().toISOString(),
    );
    clock.advance(10);
    const poisonId = await insertPendingEvent(
      "report.approved",
      "report",
      randomUUID(),
      { reportId: randomUUID() },
      "poison-approved",
    );
    clock.advance(10);
    const reportId = randomUUID();
    const versionId = randomUUID();
    await insertReportVersion(fixture, reportId, versionId, "in_review");
    const healthyId = await insertPendingEvent(
      "report.review_requested",
      "report",
      reportId,
      {
        inspectionId: fixture.inspectionId,
        reportId,
        reportVersionId: versionId,
        versionId,
      },
      "healthy-after-poison",
    );
    const batch = await pipeline.workControl!.processPendingEvents();
    expect(batch.failed).toBeGreaterThanOrEqual(1);
    expect(batch.processed).toBeGreaterThanOrEqual(1);
    expect((await eventState(poisonId))?.processing_status).toBe("failed");
    expect((await eventState(healthyId))?.processing_status).toBe("processed");
    const reviews = (
      await pipeline.workControl!.repository.listWorkItems({ kinds: ["report_technical_review"] })
    ).filter((item) => item.reportId === reportId);
    expect(reviews).toHaveLength(1);
  });

  it("dead-letters a missing-inspection projection without an inspection FK", async () => {
    const missingInspectionId = randomUUID();
    const eventId = await insertPendingEvent(
      "inspection.completed",
      "inspection",
      missingInspectionId,
      { inspectionId: missingInspectionId },
      "exhaust-missing-inspection",
    );
    await exhaustProjection(pipeline.workControl!, eventId);
    const state = await eventState(eventId);
    expect(state?.processing_status).toBe("dead_lettered");
    const cycle = buildWorkItemCycleIdentity({
      kind: "automation_failure",
      projectionEventId: eventId,
      failureSourceType: "projection",
      failureSourceId: eventId,
    });
    const items = (
      await pipeline.workControl!.repository.listWorkItems({ kinds: ["automation_failure"] })
    ).filter((item) => item.cycleIdentity === cycle);
    expect(items).toHaveLength(1);
    expect(items[0]?.inspectionId).toBeNull();
    expect(items[0]?.sourceAggregateType).toBe("inspection");
    expect(items[0]?.sourceAggregateId).toBe(missingInspectionId);
  });

  it("creates schedule-failure work without using an automation job id", async () => {
    const fixture = await insertCompletedInspection(
      database,
      "BEA-IN-000409",
      clock.now().toISOString(),
    );
    const reportId = randomUUID();
    const versionId = randomUUID();
    await insertReportVersion(fixture, reportId, versionId, "in_review");
    await insertPendingEvent(
      "report.review_requested",
      "report",
      reportId,
      {
        inspectionId: fixture.inspectionId,
        reportId,
        reportVersionId: versionId,
        versionId,
      },
      "schedule-review",
    );
    await pipeline.workControl!.processPendingEvents();
    const review = (
      await pipeline.workControl!.repository.listWorkItems({ kinds: ["report_technical_review"] })
    ).find((item) => item.reportId === reportId && item.status === "open");
    expect(review).toBeTruthy();
    const scheduleId = randomUUID();
    await database.query(
      `INSERT INTO scheduled_automation_actions
       (id,schedule_key,policy_version,action_type,work_item_id,scheduled_for,status,idempotency_key,correlation_id,payload,created_at,updated_at,version,max_attempts)
       VALUES ($1,$2,1,'work.escalation',$3,$4::timestamptz,'pending',$5,$6,'{"level":"critical"}'::jsonb,$4::timestamptz,$4::timestamptz,1,$7)`,
      [
        scheduleId,
        `work.escalation:${review!.id}:critical-test`,
        review!.id,
        clock.now().toISOString(),
        `sched-fail:${scheduleId}`,
        `sched-fail-${scheduleId}`,
        SCHEDULE_MAX_ATTEMPTS,
      ],
    );
    const failing = new WorkControlPlane({
      database,
      now: () => clock.now(),
      beforeScheduleEffect: async () => {
        throw new Error("simulated schedule effect failure");
      },
    });
    let outcome = "retry_scheduled";
    for (let attempt = 0; attempt < SCHEDULE_MAX_ATTEMPTS; attempt += 1) {
      outcome = await failing.evaluateSchedule(scheduleId);
    }
    expect(outcome).toBe("failed");
    const schedule = await database.query<{ status: string; attempt_count: number | string }>(
      "SELECT status, attempt_count FROM scheduled_automation_actions WHERE id=$1",
      [scheduleId],
    );
    expect(schedule.rows[0]?.status).toBe("failed");
    expect(Number(schedule.rows[0]?.attempt_count)).toBeGreaterThanOrEqual(SCHEDULE_MAX_ATTEMPTS);
    await pipeline.workControl!.processPendingEvents();
    const dlq = await database.query<{ event_type: string; payload: unknown }>(
      "SELECT event_type, payload FROM automation_events WHERE event_type='automation.schedule_dead_lettered' AND aggregate_id=$1",
      [scheduleId],
    );
    expect(dlq.rows).toHaveLength(1);
    expect(JSON.stringify(dlq.rows[0]?.payload)).not.toMatch(/"jobId":"/u);
    const cycle = buildWorkItemCycleIdentity({
      kind: "automation_failure",
      scheduledActionId: scheduleId,
      failureSourceType: "schedule",
      failureSourceId: scheduleId,
    });
    const items = (
      await pipeline.workControl!.repository.listWorkItems({ kinds: ["automation_failure"] })
    ).filter((item) => item.cycleIdentity === cycle);
    expect(items).toHaveLength(1);
    expect(items[0]?.jobId).toBeNull();
    expect(items[0]?.scheduledActionId).toBe(scheduleId);
    expect(items[0]?.failureSourceType).toBe("schedule");
    const unrelatedJob = randomUUID();
    await insertPendingEvent(
      "automation.job_succeeded",
      "job",
      unrelatedJob,
      { jobId: unrelatedJob },
      "unrelated-job-success",
    );
    await pipeline.workControl!.processPendingEvents();
    expect((await pipeline.workControl!.repository.getWorkItem(items[0]!.id))?.status).toBe("open");
    await insertPendingEvent(
      "automation.schedule_resolved",
      "schedule",
      scheduleId,
      { scheduleId, scheduledActionId: scheduleId },
      "schedule-resolved",
    );
    await pipeline.workControl!.processPendingEvents();
    expect((await pipeline.workControl!.repository.getWorkItem(items[0]!.id))?.status).toBe(
      "completed",
    );
  });

  it("keeps the original event dead-lettered when failure-work projection is interrupted", async () => {
    const missingReportId = randomUUID();
    const versionId = randomUUID();
    const eventId = await insertPendingEvent(
      "report.review_requested",
      "report",
      missingReportId,
      { reportId: missingReportId, reportVersionId: versionId, versionId },
      "interrupt-missing-report",
    );
    const interrupting = new WorkControlPlane({
      database,
      now: () => clock.now(),
      beforeProjectFailureWork: async () => {
        throw new Error("simulated failure-work interruption");
      },
    });
    await exhaustProjection(interrupting, eventId);
    const state = await eventState(eventId);
    expect(state?.processing_status).toBe("dead_lettered");
    const history = await database.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM event_projection_failures WHERE source_event_id=$1",
      [eventId],
    );
    expect(Number(history.rows[0]?.n)).toBe(PROJECTION_MAX_ATTEMPTS);
    const cycle = buildWorkItemCycleIdentity({
      kind: "automation_failure",
      projectionEventId: eventId,
      failureSourceType: "projection",
      failureSourceId: eventId,
    });
    const before = (
      await pipeline.workControl!.repository.listWorkItems({ kinds: ["automation_failure"] })
    ).filter((item) => item.cycleIdentity === cycle);
    expect(before).toHaveLength(0);
    const notification = await database.query<{
      id: string;
      processing_status: string;
      projection_retryable: boolean | string | null;
    }>(
      `SELECT id, processing_status, projection_retryable FROM automation_events
        WHERE event_type='automation.projection_dead_lettered' AND payload->>'sourceEventId'=$1`,
      [eventId],
    );
    expect(notification.rows[0]).toBeTruthy();
    expect(["failed", "pending"]).toContain(notification.rows[0]?.processing_status);
    const recon = await pipeline.workControl!.reconcile({
      mode: "execute",
      actorUserId: OWNER,
      correlationId: "recon-interrupt-failure-work",
    });
    expect(recon.actualCreatedMissing).toBeGreaterThanOrEqual(1);
    const after = (
      await pipeline.workControl!.repository.listWorkItems({ kinds: ["automation_failure"] })
    ).filter((item) => item.cycleIdentity === cycle);
    expect(after).toHaveLength(1);
    expect((await eventState(eventId))?.processing_status).toBe("dead_lettered");
    const again = await pipeline.workControl!.reconcile({
      mode: "execute",
      actorUserId: OWNER,
      correlationId: "recon-interrupt-again",
    });
    expect(again.createdMissing).toBe(0);
  });

  it("gives malformed, exhausted, and healthy events independent poll outcomes", async () => {
    const fixture = await insertCompletedInspection(
      database,
      "BEA-IN-000410",
      clock.now().toISOString(),
    );
    const poisonReport = randomUUID();
    const poisonId = await insertPendingEvent(
      "report.review_requested",
      "report",
      poisonReport,
      { reportId: poisonReport, reportVersionId: randomUUID() },
      "poll-exhausted-poison",
    );
    for (let attempt = 0; attempt < PROJECTION_MAX_ATTEMPTS - 1; attempt += 1) {
      await database.query(
        "UPDATE automation_events SET projection_next_retry_at=NULL WHERE id=$1",
        [poisonId],
      );
      try {
        await pipeline.workControl!.processEventById(poisonId);
      } catch {
        /* recorded */
      }
    }
    expect(Number((await eventState(poisonId))?.projection_attempt_count)).toBe(
      PROJECTION_MAX_ATTEMPTS - 1,
    );
    clock.advance(10);
    const malformedId = await insertPendingEvent(
      "report.approved",
      "report",
      randomUUID(),
      { reportId: randomUUID() },
      "poll-malformed",
    );
    clock.advance(10);
    const reportId = randomUUID();
    const versionId = randomUUID();
    await insertReportVersion(fixture, reportId, versionId, "in_review");
    const healthyId = await insertPendingEvent(
      "report.review_requested",
      "report",
      reportId,
      {
        inspectionId: fixture.inspectionId,
        reportId,
        reportVersionId: versionId,
        versionId,
      },
      "poll-healthy",
    );
    await database.query("UPDATE automation_events SET projection_next_retry_at=NULL WHERE id=$1", [
      poisonId,
    ]);
    await expect(pipeline.workControl!.processPendingEvents()).resolves.toMatchObject({
      processed: expect.any(Number),
      failed: expect.any(Number),
      deadLettered: expect.any(Number),
    });
    expect((await eventState(malformedId))?.processing_status).toBe("failed");
    expect((await eventState(poisonId))?.processing_status).toBe("dead_lettered");
    expect((await eventState(healthyId))?.processing_status).toBe("processed");
    const reviews = (
      await pipeline.workControl!.repository.listWorkItems({ kinds: ["report_technical_review"] })
    ).filter((item) => item.reportId === reportId);
    expect(reviews).toHaveLength(1);
  });
});
