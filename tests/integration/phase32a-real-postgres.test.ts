import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEMO_PERSONAS,
  DEMO_ROLE_IDS,
  EMAIL_DRY_RUN_DISCLOSURE,
  PROJECTION_MAX_ATTEMPTS,
  SCHEDULE_MAX_ATTEMPTS,
  SEEDED_OPERATIONS_IDS,
  SEEDED_WORK_CONTROL_IDS,
  SYNTHETIC_REMINDER_RULES,
  buildWorkItemCycleIdentity,
} from "../../packages/domain/src/index.js";
import {
  PgDatabaseAdapter,
  WorkControlPlane,
  migrateDatabase,
  seedDatabase,
  verifyMigrations,
} from "../../packages/database/src/index.js";

const OWNER = DEMO_PERSONAS[0].id;
const OPERATIONS = DEMO_PERSONAS[2].id;
const OPERATIONS_B = DEMO_PERSONAS[5].id;
const EXECUTIVE = DEMO_PERSONAS[3].id;
const INTEGRATION = DEMO_PERSONAS[4].id;

function inspectPhase32aPostgresUrl(value: string | undefined) {
  const url = value?.trim() ?? "";
  if (!url) {
    return { ready: false as const, detail: "BEA_PHASE32A_REAL_POSTGRES_URL is not set." };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("BEA_PHASE32A_REAL_POSTGRES_URL is invalid.");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("BEA_PHASE32A_REAL_POSTGRES_URL must be a PostgreSQL URL.");
  }
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!/(?:phase[_-]?32a?|phase[_-]?31a?|phase[_-]?30|test|ci|disposable)/iu.test(database)) {
    throw new Error(
      "Refusing a PostgreSQL database whose name does not contain phase32a, test, ci, or disposable.",
    );
  }
  return { ready: true as const, url, database };
}

const prerequisite = inspectPhase32aPostgresUrl(process.env.BEA_PHASE32A_REAL_POSTGRES_URL);
if (!prerequisite.ready && process.env.BEA_PHASE32A_REQUIRE_REAL_POSTGRES === "true") {
  throw new Error(
    "CI Phase 3.2A PostgreSQL proofs cannot be skipped. Set BEA_PHASE32A_REAL_POSTGRES_URL to a disposable test database.",
  );
}
const describePostgres = prerequisite.ready ? describe.sequential : describe.sequential.skip;

function aborted(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /current transaction is aborted|25P02/iu.test(message);
}

async function assertHealthy(adapter: PgDatabaseAdapter) {
  const result = await adapter.query<{ ok: number | string }>("SELECT 1 AS ok");
  expect(Number(result.rows[0]?.ok)).toBe(1);
}

describePostgres("Phase 3.2A real PostgreSQL work-control concurrency", () => {
  let database: PgDatabaseAdapter;
  let leftDb: PgDatabaseAdapter;
  let rightDb: PgDatabaseAdapter;

  beforeAll(async () => {
    if (!prerequisite.ready) return;
    database = new PgDatabaseAdapter({
      connectionString: prerequisite.url,
      max: 8,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 15_000,
    });
    leftDb = new PgDatabaseAdapter({
      connectionString: prerequisite.url,
      max: 4,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 15_000,
    });
    rightDb = new PgDatabaseAdapter({
      connectionString: prerequisite.url,
      max: 4,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 15_000,
    });
    const migrated = await migrateDatabase(database);
    expect(migrated.applied.at(-1) ?? migrated.alreadyApplied.at(-1)).toBe(
      "0026_cpl_hosted_workflow.sql",
    );
    await expect(verifyMigrations(database)).resolves.toMatchObject({
      current: "0026_cpl_hosted_workflow.sql",
    });
    await seedDatabase(database);
  }, 60_000);

  afterAll(async () => {
    await database?.close();
    await leftDb?.close();
    await rightDb?.close();
  });

  async function insertInspection(reference: string) {
    const projectId = SEEDED_OPERATIONS_IDS.happyProject;
    const inspectionId = randomUUID();
    const now = new Date().toISOString();
    const uniqueReference = `${reference}-${inspectionId.slice(0, 8)}`;
    await database.query(
      `INSERT INTO inspections
       (id,reference,project_id,status,inspector_user_id,reviewer_user_id,completed_at,service_key,report_template_id,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,$2,$3,'completed',$4,$5,$6,'building-envelope-inspection',$7,$5,$6,$6,1)`,
      [
        inspectionId,
        uniqueReference,
        projectId,
        OPERATIONS,
        OWNER,
        now,
        SEEDED_OPERATIONS_IDS.template,
      ],
    );
    return { projectId, inspectionId, now };
  }

  async function insertReport(
    fixture: { projectId: string; inspectionId: string; now: string },
    status: string,
  ) {
    const reportId = randomUUID();
    const versionId = randomUUID();
    const submissionId = randomUUID();
    await database.query(
      `INSERT INTO inspection_reports
       (id,reference,inspection_id,project_id,template_id,current_template_version_id,status,current_version_number,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$9,1)`,
      [
        reportId,
        `BEA-RP-${reportId.replaceAll("-", "").slice(0, 12)}`,
        fixture.inspectionId,
        fixture.projectId,
        SEEDED_OPERATIONS_IDS.template,
        SEEDED_OPERATIONS_IDS.templateVersion,
        status,
        OWNER,
        fixture.now,
      ],
    );
    await database.query(
      `INSERT INTO inspection_submissions
       (id,inspection_id,source_channel,source_idempotency_key,payload_sha256,raw_payload,schema_version,mapping_version,normalized_payload,created_at)
       VALUES ($1,$2,'direct_entry',$3,'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee','{}'::jsonb,'v1','v1','{}'::jsonb,$4)`,
      [submissionId, fixture.inspectionId, `pg-${versionId}`, fixture.now],
    );
    await database.query(
      `INSERT INTO report_versions
       (id,report_id,version_number,status,input_snapshot,template_version_id,submission_id,created_at)
       VALUES ($1,$2,1,$3,'{}'::jsonb,$4,$5,$6)`,
      [
        versionId,
        reportId,
        status,
        SEEDED_OPERATIONS_IDS.templateVersion,
        submissionId,
        fixture.now,
      ],
    );
    return { reportId, versionId, submissionId };
  }

  async function insertEvent(
    eventType: string,
    aggregateType: string,
    aggregateId: string,
    payload: Record<string, unknown>,
    correlationId: string,
  ) {
    const id = randomUUID();
    const now = new Date().toISOString();
    await database.query(
      `INSERT INTO automation_events
       (id,event_type,schema_version,aggregate_type,aggregate_id,correlation_id,occurred_at,recorded_at,actor_type,actor_id,payload,processing_status)
       VALUES ($1,$2,'1',$3,$4,$5,$6,$6,'system',NULL,$7::jsonb,'pending')`,
      [id, eventType, aggregateType, aggregateId, correlationId, now, JSON.stringify(payload)],
    );
    return id;
  }

  it("creates one review item from concurrent complementary events without aborting", async () => {
    const fixture = await insertInspection("BEA-IN-000401");
    const report = await insertReport(fixture, "in_review");
    const payload = {
      inspectionId: fixture.inspectionId,
      reportId: report.reportId,
      reportVersionId: report.versionId,
      versionId: report.versionId,
    };
    const draftId = await insertEvent(
      "report.draft_created",
      "report",
      report.reportId,
      payload,
      "pg-complement-draft",
    );
    const reviewId = await insertEvent(
      "report.review_requested",
      "report",
      report.reportId,
      payload,
      "pg-complement-review",
    );
    const left = new WorkControlPlane({ database: leftDb });
    const right = new WorkControlPlane({ database: rightDb });
    const results = await Promise.allSettled([
      left.processEventById(draftId),
      right.processEventById(reviewId),
    ]);
    expect(results.every((item) => item.status === "fulfilled")).toBe(true);
    expect(results.some((item) => item.status === "rejected" && aborted(item.reason))).toBe(false);
    await assertHealthy(leftDb);
    await assertHealthy(rightDb);
    const items = await database.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM operational_work_items
        WHERE work_item_kind='report_technical_review' AND report_id=$1`,
      [report.reportId],
    );
    expect(Number(items.rows[0]?.n)).toBe(1);
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
    const workId = (
      await database.query<{ id: string }>(
        `SELECT id FROM operational_work_items
          WHERE work_item_kind='report_technical_review' AND report_id=$1`,
        [report.reportId],
      )
    ).rows[0]?.id;
    const assignments = await database.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM work_item_assignments WHERE work_item_id=$1 AND action='created'",
      [workId],
    );
    expect(Number(assignments.rows[0]?.n)).toBe(1);
    const reminderSchedules = await database.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM scheduled_automation_actions WHERE work_item_id=$1 AND action_type='work.reminder'",
      [workId],
    );
    expect(Number(reminderSchedules.rows[0]?.n)).toBe(SYNTHETIC_REMINDER_RULES.length);
  });

  it("returns role-queue work to Operations B after Operations A releases", async () => {
    const itemId = SEEDED_WORK_CONTROL_IDS.labCorrectionWork;
    await database.query(
      `UPDATE operational_work_items
          SET assigned_user_id=NULL, claimed_user_id=NULL, claimed_at=NULL, status='open', started_at=NULL
        WHERE id=$1`,
      [itemId],
    );
    const plane = new WorkControlPlane({ database });
    const claimedA = await plane.claimWorkItem(itemId, {
      userId: OPERATIONS,
      roleKeys: [DEMO_ROLE_IDS.OPERATIONS],
      correlationId: "pg-ops-a",
    });
    expect(claimedA.assignedUserId).toBeNull();
    expect(claimedA.claimedUserId).toBe(OPERATIONS);
    expect(claimedA.startedAt).toBeNull();
    await plane.releaseClaim(itemId, {
      userId: OPERATIONS,
      roleKeys: [DEMO_ROLE_IDS.OPERATIONS],
      correlationId: "pg-ops-a-release",
    });
    const released = await plane.repository.getWorkItem(itemId);
    expect(released?.assignedUserId).toBeNull();
    expect(released?.claimedUserId).toBeNull();
    const claimedB = await plane.claimWorkItem(itemId, {
      userId: OPERATIONS_B,
      roleKeys: [DEMO_ROLE_IDS.OPERATIONS],
      correlationId: "pg-ops-b",
    });
    expect(claimedB.claimedUserId).toBe(OPERATIONS_B);
    await plane.releaseClaim(itemId, {
      userId: OPERATIONS_B,
      roleKeys: [DEMO_ROLE_IDS.OPERATIONS],
      correlationId: "pg-ops-b-release",
    });
  });

  it("allows only one concurrent claim to succeed", async () => {
    const itemId = SEEDED_WORK_CONTROL_IDS.labCorrectionWork;
    await database.query(
      `UPDATE operational_work_items
          SET assigned_user_id=NULL, claimed_user_id=NULL, claimed_at=NULL, status='open'
        WHERE id=$1`,
      [itemId],
    );
    const planeA = new WorkControlPlane({ database: leftDb });
    const planeB = new WorkControlPlane({ database: rightDb });
    const results = await Promise.allSettled([
      planeA.claimWorkItem(itemId, {
        userId: OPERATIONS,
        roleKeys: [DEMO_ROLE_IDS.OPERATIONS],
        correlationId: "claim-a",
      }),
      planeB.claimWorkItem(itemId, {
        userId: EXECUTIVE,
        roleKeys: [DEMO_ROLE_IDS.OPERATIONS],
        correlationId: "claim-b",
      }),
    ]);
    const succeeded = results.filter((item) => item.status === "fulfilled");
    const failed = results.filter((item) => item.status === "rejected");
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed.some((item) => item.status === "rejected" && aborted(item.reason))).toBe(false);
    await new WorkControlPlane({ database }).releaseClaim(itemId, {
      userId: OPERATIONS,
      roleKeys: [DEMO_ROLE_IDS.OWNER_ADMIN, DEMO_ROLE_IDS.OPERATIONS],
      correlationId: "claim-unlock",
    });
  });

  it("creates one reminder and exact notifications from concurrent scheduler workers", async () => {
    const fixture = await insertInspection("BEA-IN-000402");
    const report = await insertReport(fixture, "in_review");
    const plane = new WorkControlPlane({ database });
    const eventId = await insertEvent(
      "report.review_requested",
      "report",
      report.reportId,
      {
        inspectionId: fixture.inspectionId,
        reportId: report.reportId,
        reportVersionId: report.versionId,
        versionId: report.versionId,
      },
      "pg-reminder-review",
    );
    await plane.processEventById(eventId);
    const work = (
      await plane.repository.listWorkItems({ kinds: ["report_technical_review"] })
    ).find((item) => item.reportId === report.reportId);
    expect(work).toBeTruthy();
    await database.query("DELETE FROM scheduled_automation_actions WHERE work_item_id=$1", [
      work!.id,
    ]);
    const scheduleId = randomUUID();
    const due = new Date(Date.now() - 60_000).toISOString();
    await database.query(
      `INSERT INTO scheduled_automation_actions
       (id,schedule_key,policy_version,action_type,work_item_id,scheduled_for,status,idempotency_key,correlation_id,payload,created_at,updated_at,version,max_attempts)
       VALUES ($1,$2,1,'work.reminder',$3,$4::timestamptz,'pending',$5,'pg-reminder',$6::jsonb,$4::timestamptz,$4::timestamptz,1,5)`,
      [
        scheduleId,
        `work.reminder:${work!.id}:overdue`,
        work!.id,
        due,
        `pg-reminder:${work!.id}:overdue`,
        JSON.stringify({ thresholdKey: "overdue" }),
      ],
    );
    const left = new WorkControlPlane({ database: leftDb });
    const right = new WorkControlPlane({ database: rightDb });
    const outcomes = await Promise.all([
      left.evaluateSchedule(scheduleId),
      right.evaluateSchedule(scheduleId),
    ]);
    expect(outcomes.filter((item) => item === "claimed_and_executed")).toHaveLength(1);
    expect(
      outcomes.filter((item) =>
        ["unavailable", "already_processed", "duplicate_suppressed"].includes(item),
      ),
    ).toHaveLength(1);
    await assertHealthy(leftDb);
    await assertHealthy(rightDb);
    const reminders = await database.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM work_item_reminders WHERE work_item_id=$1 AND threshold_key='overdue'",
      [work!.id],
    );
    expect(Number(reminders.rows[0]?.n)).toBe(1);
    const notifications = await database.query<{ channel: string }>(
      "SELECT channel FROM notification_outbox WHERE work_item_id=$1 AND idempotency_key LIKE $2",
      [work!.id, `${work!.id}:%`],
    );
    const channels = notifications.rows.map((row) => row.channel).sort();
    expect(channels).toEqual(["email_dry_run", "in_app"]);
    expect(
      (
        await database.query<{ adapter_result: string }>(
          "SELECT adapter_result FROM notification_outbox WHERE work_item_id=$1 AND channel='email_dry_run'",
          [work!.id],
        )
      ).rows[0]?.adapter_result,
    ).toContain(EMAIL_DRY_RUN_DISCLOSURE);
    const schedule = await database.query<{ status: string; attempt_count: number }>(
      "SELECT status, attempt_count FROM scheduled_automation_actions WHERE id=$1",
      [scheduleId],
    );
    expect(schedule.rows[0]?.status).toBe("succeeded");
    expect(Number(schedule.rows[0]?.attempt_count)).toBe(1);
  });

  it("reconciles a crashed reminder insert without duplicating it", async () => {
    const fixture = await insertInspection("BEA-IN-000403");
    const report = await insertReport(fixture, "in_review");
    const plane = new WorkControlPlane({ database });
    const eventId = await insertEvent(
      "report.review_requested",
      "report",
      report.reportId,
      {
        inspectionId: fixture.inspectionId,
        reportId: report.reportId,
        reportVersionId: report.versionId,
        versionId: report.versionId,
      },
      "pg-crash-review",
    );
    await plane.processEventById(eventId);
    const work = (
      await plane.repository.listWorkItems({ kinds: ["report_technical_review"] })
    ).find((item) => item.reportId === report.reportId);
    expect(work).toBeTruthy();
    await database.query("DELETE FROM scheduled_automation_actions WHERE work_item_id=$1", [
      work!.id,
    ]);
    const now = new Date().toISOString();
    await database.query(
      `INSERT INTO work_item_reminders (id,work_item_id,threshold_key,policy_version,scheduled_for,created_at,synthetic)
       VALUES ($1,$2,'due_now',1,$3::timestamptz,$3::timestamptz,TRUE)`,
      [randomUUID(), work!.id, now],
    );
    const scheduleId = randomUUID();
    await database.query(
      `INSERT INTO scheduled_automation_actions
       (id,schedule_key,policy_version,action_type,work_item_id,scheduled_for,status,idempotency_key,correlation_id,payload,created_at,updated_at,version,max_attempts)
       VALUES ($1,$2,1,'work.reminder',$3,$4::timestamptz,'pending',$5,'pg-crash',$6::jsonb,$4::timestamptz,$4::timestamptz,1,5)`,
      [
        scheduleId,
        `work.reminder:${work!.id}:due_now`,
        work!.id,
        now,
        `pg-crash:${work!.id}:due_now`,
        JSON.stringify({ thresholdKey: "due_now" }),
      ],
    );
    const outcome = await plane.evaluateSchedule(scheduleId);
    expect(["duplicate_suppressed", "claimed_and_executed", "already_processed"]).toContain(
      outcome,
    );
    const reminders = await database.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM work_item_reminders WHERE work_item_id=$1 AND threshold_key='due_now'",
      [work!.id],
    );
    expect(Number(reminders.rows[0]?.n)).toBe(1);
    const schedule = await database.query<{ status: string }>(
      "SELECT status FROM scheduled_automation_actions WHERE id=$1",
      [scheduleId],
    );
    expect(schedule.rows[0]?.status).toBe("succeeded");
  });

  it("creates one escalation from concurrent workers without aborting", async () => {
    const fixture = await insertInspection("BEA-IN-000404");
    const report = await insertReport(fixture, "in_review");
    const plane = new WorkControlPlane({ database });
    const eventId = await insertEvent(
      "report.review_requested",
      "report",
      report.reportId,
      {
        inspectionId: fixture.inspectionId,
        reportId: report.reportId,
        reportVersionId: report.versionId,
        versionId: report.versionId,
      },
      "pg-esc-review",
    );
    await plane.processEventById(eventId);
    const work = (
      await plane.repository.listWorkItems({ kinds: ["report_technical_review"] })
    ).find((item) => item.reportId === report.reportId);
    expect(work).toBeTruthy();
    await database.query("DELETE FROM scheduled_automation_actions WHERE work_item_id=$1", [
      work!.id,
    ]);
    await database.query(
      `UPDATE operational_work_items
          SET available_at=$2::timestamptz, due_at=$3::timestamptz, escalation_level='none'
        WHERE id=$1`,
      [
        work!.id,
        new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
        new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      ],
    );
    const scheduleId = randomUUID();
    const due = new Date(Date.now() - 60_000).toISOString();
    await database.query(
      `INSERT INTO scheduled_automation_actions
       (id,schedule_key,policy_version,action_type,work_item_id,scheduled_for,status,idempotency_key,correlation_id,payload,created_at,updated_at,version,max_attempts)
       VALUES ($1,$2,1,'work.escalation',$3,$4::timestamptz,'pending',$5,'pg-esc',$6::jsonb,$4::timestamptz,$4::timestamptz,1,5)`,
      [
        scheduleId,
        `work.escalation:${work!.id}:critical`,
        work!.id,
        due,
        `pg-esc:${work!.id}:critical`,
        JSON.stringify({ level: "critical" }),
      ],
    );
    const left = new WorkControlPlane({ database: leftDb });
    const right = new WorkControlPlane({ database: rightDb });
    const outcomes = await Promise.allSettled([
      left.evaluateSchedule(scheduleId),
      right.evaluateSchedule(scheduleId),
    ]);
    expect(outcomes.every((item) => item.status === "fulfilled")).toBe(true);
    expect(outcomes.some((item) => item.status === "rejected" && aborted(item.reason))).toBe(false);
    const escalations = await database.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM work_item_escalations WHERE work_item_id=$1",
      [work!.id],
    );
    expect(Number(escalations.rows[0]?.n)).toBe(1);
    const notifications = await database.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM notification_outbox WHERE work_item_id=$1 AND escalation_id IS NOT NULL",
      [work!.id],
    );
    expect(Number(notifications.rows[0]?.n)).toBe(1);
  });

  it("runs concurrent reconciliation without aborting and creates one missing item", async () => {
    await new WorkControlPlane({ database }).reconcile({
      mode: "execute",
      actorUserId: OWNER,
      correlationId: "pg-recon-settle",
    });
    const fixture = await insertInspection("BEA-IN-000405");
    const left = new WorkControlPlane({ database: leftDb });
    const right = new WorkControlPlane({ database: rightDb });
    const results = await Promise.allSettled([
      left.reconcile({
        mode: "execute",
        actorUserId: OWNER,
        correlationId: "pg-recon-left",
      }),
      right.reconcile({
        mode: "execute",
        actorUserId: OWNER,
        correlationId: "pg-recon-right",
      }),
    ]);
    expect(results.every((item) => item.status === "fulfilled")).toBe(true);
    expect(results.some((item) => item.status === "rejected" && aborted(item.reason))).toBe(false);
    const created = results
      .filter((item) => item.status === "fulfilled")
      .map((item) => item.value.actualCreatedMissing);
    expect(created).toHaveLength(2);
    expect(created[0]! + created[1]!).toBe(1);
    expect(created.some((value) => value === 0)).toBe(true);
    const items = await database.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM operational_work_items
        WHERE work_item_kind='inspection_submission' AND inspection_id=$1 AND status IN ('open','acknowledged','in_progress','blocked')`,
      [fixture.inspectionId],
    );
    expect(Number(items.rows[0]?.n)).toBe(1);
    const again = await new WorkControlPlane({ database }).reconcile({
      mode: "execute",
      actorUserId: OWNER,
      correlationId: "pg-recon-again",
    });
    expect(again.createdMissing).toBe(0);
    expect(again.actualCreatedMissing).toBe(0);
    await assertHealthy(leftDb);
    await assertHealthy(rightDb);
  });

  it("retries a failed supported projection until it is processed", async () => {
    const fixture = await insertInspection("BEA-IN-000406");
    const reportId = randomUUID();
    const versionId = randomUUID();
    const eventId = await insertEvent(
      "report.review_requested",
      "report",
      reportId,
      {
        inspectionId: fixture.inspectionId,
        reportId,
        reportVersionId: versionId,
        versionId,
      },
      "pg-retry-missing",
    );
    const plane = new WorkControlPlane({ database });
    await plane.processPendingEvents();
    const failed = await database.query<{ processing_status: string }>(
      "SELECT processing_status FROM automation_events WHERE id=$1",
      [eventId],
    );
    expect(failed.rows[0]?.processing_status).toBe("failed");
    const submissionId = randomUUID();
    await database.query(
      `INSERT INTO inspection_submissions
       (id,inspection_id,source_channel,source_idempotency_key,payload_sha256,raw_payload,schema_version,mapping_version,normalized_payload,created_at)
       VALUES ($1,$2,'direct_entry',$3,'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff','{}'::jsonb,'v1','v1','{}'::jsonb,CURRENT_TIMESTAMP)`,
      [submissionId, fixture.inspectionId, `pg-retry-${versionId}`],
    );
    await database.query(
      `INSERT INTO inspection_reports
       (id,reference,inspection_id,project_id,template_id,current_template_version_id,status,current_version_number,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,$6,'in_review',1,$7,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1)`,
      [
        reportId,
        `BEA-RP-${reportId.replaceAll("-", "").slice(0, 12)}`,
        fixture.inspectionId,
        fixture.projectId,
        SEEDED_OPERATIONS_IDS.template,
        SEEDED_OPERATIONS_IDS.templateVersion,
        OWNER,
      ],
    );
    await database.query(
      `INSERT INTO report_versions
       (id,report_id,version_number,status,input_snapshot,template_version_id,submission_id,created_at)
       VALUES ($1,$2,1,'in_review','{}'::jsonb,$3,$4,CURRENT_TIMESTAMP)`,
      [versionId, reportId, SEEDED_OPERATIONS_IDS.templateVersion, submissionId],
    );
    await plane.retryProjectionEvent(eventId, {
      userId: OWNER,
      roleKeys: [DEMO_ROLE_IDS.OWNER_ADMIN],
      correlationId: "pg-retry",
    });
    await plane.processPendingEvents();
    const processed = await database.query<{ processing_status: string }>(
      "SELECT processing_status FROM automation_events WHERE id=$1",
      [eventId],
    );
    expect(processed.rows[0]?.processing_status).toBe("processed");
    const items = await database.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM operational_work_items
        WHERE work_item_kind='report_technical_review' AND report_id=$1`,
      [reportId],
    );
    expect(Number(items.rows[0]?.n)).toBe(1);
  });

  it("does not close automation-failure work from an unrelated exception", async () => {
    const fixture = await insertInspection("BEA-IN-000407");
    const jobId = randomUUID();
    await database.query(
      `INSERT INTO automation_jobs
       (id,job_type,blueprint_key,blueprint_version,aggregate_type,aggregate_id,idempotency_key,status,attempt_count,max_attempts,available_at,payload,created_at,updated_at,version)
       VALUES ($1,'inspection.validate','inspection.submission-validation',1,'inspection',$2,$3,'dead_letter',3,3,CURRENT_TIMESTAMP,'{"synthetic":true}'::jsonb,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1)`,
      [jobId, fixture.inspectionId, `pg-job-${jobId}`],
    );
    const plane = new WorkControlPlane({ database });
    await plane.processEventById(
      await insertEvent(
        "automation.job_dead_letter",
        "job",
        jobId,
        { jobId, inspectionId: fixture.inspectionId },
        "pg-job-dlq",
      ),
    );
    const item = (await plane.repository.listWorkItems({ kinds: ["automation_failure"] })).find(
      (row) => row.jobId === jobId,
    );
    expect(item?.status).toBe("open");
    const exceptionId = randomUUID();
    await database.query(
      `INSERT INTO exception_cases
       (id,reference,kind,status,severity,title,detail,inspection_id,project_id,owner_user_id,sla_attribution,created_at,updated_at,version)
       VALUES ($1,$2,'validation','open','error','Unrelated','Unrelated.',$3,$4,$5,'human_waiting',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1)`,
      [
        exceptionId,
        `BEA-EX-${exceptionId.replaceAll("-", "")}`,
        fixture.inspectionId,
        fixture.projectId,
        OPERATIONS,
      ],
    );
    await plane.processEventById(
      await insertEvent(
        "exception.resolved",
        "exception",
        exceptionId,
        { inspectionId: fixture.inspectionId, exceptionId },
        "pg-unrelated-ex",
      ),
    );
    expect((await plane.repository.getWorkItem(item!.id))?.status).toBe("open");
    await plane.processEventById(
      await insertEvent("automation.job_succeeded", "job", jobId, { jobId }, "pg-job-success"),
    );
    expect((await plane.repository.getWorkItem(item!.id))?.status).toBe("completed");
  });

  it("lets a second Integration Administrator claim after release", async () => {
    const integrationB = randomUUID();
    const roleId = (
      await database.query<{ id: string }>("SELECT id FROM roles WHERE key=$1", [
        DEMO_ROLE_IDS.INTEGRATION_ADMIN,
      ])
    ).rows[0]?.id;
    await database.query(
      `INSERT INTO users (id,persona_key,email,display_name,title,status,created_at,updated_at,version)
       VALUES ($1,$3,$2,'Integration Administrator B','Integration Administrator','active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1)`,
      [
        integrationB,
        `integrations.b.${integrationB.slice(0, 8)}@example.invalid`,
        `integration-administrator-b-${integrationB.slice(0, 8)}`,
      ],
    );
    await database.query(
      "INSERT INTO user_roles (user_id,role_id,created_at) VALUES ($1,$2,CURRENT_TIMESTAMP)",
      [integrationB, roleId],
    );
    const itemId = SEEDED_WORK_CONTROL_IDS.labAutomationWork;
    await database.query(
      `UPDATE operational_work_items
          SET assigned_user_id=NULL, claimed_user_id=NULL, claimed_at=NULL, status='open'
        WHERE id=$1`,
      [itemId],
    );
    const plane = new WorkControlPlane({ database });
    await plane.claimWorkItem(itemId, {
      userId: INTEGRATION,
      roleKeys: [DEMO_ROLE_IDS.INTEGRATION_ADMIN],
      correlationId: "pg-int-a",
    });
    await plane.releaseClaim(itemId, {
      userId: INTEGRATION,
      roleKeys: [DEMO_ROLE_IDS.INTEGRATION_ADMIN],
      correlationId: "pg-int-a-release",
    });
    const claimedB = await plane.claimWorkItem(itemId, {
      userId: integrationB,
      roleKeys: [DEMO_ROLE_IDS.INTEGRATION_ADMIN],
      correlationId: "pg-int-b",
    });
    expect(claimedB.claimedUserId).toBe(integrationB);
    expect(claimedB.assignedUserId).toBeNull();
  });

  async function eventState(eventId: string) {
    const row = await database.query<{
      processing_status: string;
      projection_attempt_count: number | string | null;
      projection_error_code: string | null;
      projection_error_message: string | null;
      projection_dead_lettered_at: string | null;
    }>(
      `SELECT processing_status, projection_attempt_count, projection_error_code, projection_error_message,
              projection_dead_lettered_at
         FROM automation_events WHERE id=$1`,
      [eventId],
    );
    return row.rows[0];
  }

  it("fails a missing-cycle completion and still processes a later healthy event", async () => {
    const fixture = await insertInspection("BEA-IN-000410");
    const report = await insertReport(fixture, "in_review");
    const malformedId = await insertEvent(
      "report.approved",
      "report",
      report.reportId,
      { inspectionId: fixture.inspectionId, reportId: report.reportId },
      "pg-missing-cycle",
    );
    const healthyId = await insertEvent(
      "report.review_requested",
      "report",
      report.reportId,
      {
        inspectionId: fixture.inspectionId,
        reportId: report.reportId,
        reportVersionId: report.versionId,
        versionId: report.versionId,
      },
      "pg-healthy-after-missing-cycle",
    );
    const plane = new WorkControlPlane({ database });
    await expect(plane.processPendingEvents()).resolves.toMatchObject({
      processed: expect.any(Number),
      failed: expect.any(Number),
    });
    const malformed = await eventState(malformedId);
    expect(malformed?.processing_status).toBe("failed");
    expect(malformed?.projection_error_code).toBe("CYCLE_IDENTITY_INCOMPLETE");
    expect(malformed?.projection_error_message ?? "").toContain("reportVersionId");
    expect((await eventState(healthyId))?.processing_status).toBe("processed");
    const items = await database.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM operational_work_items
        WHERE work_item_kind='report_technical_review' AND report_id=$1`,
      [report.reportId],
    );
    expect(Number(items.rows[0]?.n)).toBe(1);
    await assertHealthy(database);
  });

  it("dead-letters an exhausted missing-report event without invalid foreign keys", async () => {
    const missingReportId = randomUUID();
    const versionId = randomUUID();
    const eventId = await insertEvent(
      "report.review_requested",
      "report",
      missingReportId,
      { reportId: missingReportId, reportVersionId: versionId, versionId },
      "pg-exhaust-missing-report",
    );
    const plane = new WorkControlPlane({ database });
    for (let attempt = 0; attempt < PROJECTION_MAX_ATTEMPTS; attempt += 1) {
      await database.query(
        "UPDATE automation_events SET projection_next_retry_at=NULL WHERE id=$1",
        [eventId],
      );
      try {
        await plane.processEventById(eventId);
      } catch {
        /* recorded */
      }
    }
    const state = await eventState(eventId);
    expect(state?.processing_status).toBe("dead_lettered");
    expect(state?.projection_dead_lettered_at).toBeTruthy();
    const cycle = buildWorkItemCycleIdentity({
      kind: "automation_failure",
      projectionEventId: eventId,
      failureSourceType: "projection",
      failureSourceId: eventId,
    });
    const items = await database.query<{
      n: string;
      report_id: string | null;
      job_id: string | null;
      source_aggregate_type: string;
      source_aggregate_id: string;
    }>(
      `SELECT COUNT(*)::text AS n, MIN(report_id::text) AS report_id, MIN(job_id::text) AS job_id,
              MIN(source_aggregate_type) AS source_aggregate_type, MIN(source_aggregate_id::text) AS source_aggregate_id
         FROM operational_work_items WHERE cycle_identity=$1`,
      [cycle],
    );
    expect(Number(items.rows[0]?.n)).toBe(1);
    expect(items.rows[0]?.report_id).toBeNull();
    expect(items.rows[0]?.job_id).toBeNull();
    expect(items.rows[0]?.source_aggregate_type).toBe("report");
    expect(items.rows[0]?.source_aggregate_id).toBe(missingReportId);
    await assertHealthy(database);
  });

  it("projects projection dead-letter work once under two workers", async () => {
    const sourceEventId = randomUUID();
    const notificationId = await insertEvent(
      "automation.projection_dead_lettered",
      "projection",
      sourceEventId,
      {
        sourceEventId,
        projectionEventId: sourceEventId,
        originalAggregateType: "report",
        originalAggregateId: randomUUID(),
      },
      "pg-dlq-notify",
    );
    const left = new WorkControlPlane({ database: leftDb });
    const right = new WorkControlPlane({ database: rightDb });
    const results = await Promise.allSettled([
      left.processEventById(notificationId),
      right.processEventById(notificationId),
    ]);
    expect(results.every((item) => item.status === "fulfilled")).toBe(true);
    expect(results.some((item) => item.status === "rejected" && aborted(item.reason))).toBe(false);
    const cycle = buildWorkItemCycleIdentity({
      kind: "automation_failure",
      projectionEventId: sourceEventId,
      failureSourceType: "projection",
      failureSourceId: sourceEventId,
    });
    const items = await database.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM operational_work_items WHERE cycle_identity=$1",
      [cycle],
    );
    expect(Number(items.rows[0]?.n)).toBe(1);
    await left.processEventById(notificationId);
    expect(
      Number(
        (
          await database.query<{ n: string }>(
            "SELECT COUNT(*)::text AS n FROM operational_work_items WHERE cycle_identity=$1",
            [cycle],
          )
        ).rows[0]?.n,
      ),
    ).toBe(1);
    await assertHealthy(leftDb);
    await assertHealthy(rightDb);
  });

  it("creates schedule dead-letter work without a job foreign key", async () => {
    const fixture = await insertInspection("BEA-IN-000411");
    const report = await insertReport(fixture, "in_review");
    const plane = new WorkControlPlane({ database });
    await plane.processEventById(
      await insertEvent(
        "report.review_requested",
        "report",
        report.reportId,
        {
          inspectionId: fixture.inspectionId,
          reportId: report.reportId,
          reportVersionId: report.versionId,
          versionId: report.versionId,
        },
        "pg-sched-review",
      ),
    );
    const work = (
      await plane.repository.listWorkItems({ kinds: ["report_technical_review"] })
    ).find((item) => item.reportId === report.reportId);
    expect(work).toBeTruthy();
    const scheduleId = randomUUID();
    const due = new Date().toISOString();
    await database.query(
      `INSERT INTO scheduled_automation_actions
       (id,schedule_key,policy_version,action_type,work_item_id,scheduled_for,status,idempotency_key,correlation_id,payload,created_at,updated_at,version,max_attempts)
       VALUES ($1,$2,1,'work.escalation',$3,$4::timestamptz,'pending',$5,'pg-sched-fail',$6::jsonb,$4::timestamptz,$4::timestamptz,1,$7)`,
      [
        scheduleId,
        `work.escalation:${work!.id}:pg-fail`,
        work!.id,
        due,
        `pg-sched-fail:${scheduleId}`,
        JSON.stringify({ level: "critical" }),
        SCHEDULE_MAX_ATTEMPTS,
      ],
    );
    const failing = new WorkControlPlane({
      database,
      beforeScheduleEffect: async () => {
        throw new Error("simulated schedule effect failure");
      },
    });
    let outcome = "retry_scheduled";
    for (let attempt = 0; attempt < SCHEDULE_MAX_ATTEMPTS; attempt += 1) {
      outcome = await failing.evaluateSchedule(scheduleId);
    }
    expect(outcome).toBe("failed");
    const cycle = buildWorkItemCycleIdentity({
      kind: "automation_failure",
      scheduledActionId: scheduleId,
      failureSourceType: "schedule",
      failureSourceId: scheduleId,
    });
    const items = await database.query<{ n: string; job_id: string | null }>(
      `SELECT COUNT(*)::text AS n, MIN(job_id::text) AS job_id
         FROM operational_work_items WHERE cycle_identity=$1`,
      [cycle],
    );
    expect(Number(items.rows[0]?.n)).toBe(1);
    expect(items.rows[0]?.job_id).toBeNull();
    await assertHealthy(database);
  });
});
