import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ScriptedDeliveryAdapter,
  type DeliveryAdapter,
} from "../../packages/automation/src/index.js";
import { DEMO_PERSONAS, SEEDED_OPERATIONS_IDS } from "../../packages/domain/src/index.js";
import {
  InspectionReportPipeline,
  PGliteDatabaseAdapter,
  SqlFoundationRepository,
  completeSyntheticSubmissionPayload,
  createServerRuntime,
  failClaimedJob,
  incompleteSyntheticSubmissionPayload,
  migrateDatabase,
  seedDatabase,
  type BeaServerRuntime,
} from "../../packages/database/src/index.js";
import { PERMISSIONS, PersistentAuthorizationService } from "../../packages/security/src/index.js";
import {
  permissionForInspectionSubmit,
  permissionForReportAction,
  projectInspectionSubmission,
  projectReportVersions,
} from "../../apps/web/lib/operations-access.js";

const OWNER = DEMO_PERSONAS[0].id;
const SALES = DEMO_PERSONAS[1].id;
const OPERATIONS = DEMO_PERSONAS[2].id;
const INTEGRATION = DEMO_PERSONAS[4].id;

class CountingDeliveryAdapter implements DeliveryAdapter {
  readonly key = "counting-test";
  readonly live = false;
  calls = 0;
  constructor(private readonly inner: DeliveryAdapter) {}
  async deliver(request: Parameters<DeliveryAdapter["deliver"]>[0]) {
    this.calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return this.inner.deliver(request);
  }
}

function advancingClock(start = "2026-08-31T16:00:00.000Z") {
  let current = Date.parse(start);
  return () => {
    current += 1_000;
    return new Date(current);
  };
}

async function insertInspectionFixture(
  database: PGliteDatabaseAdapter,
  input: { readonly reference: string; readonly completedAt?: string | null },
) {
  const projectId = randomUUID();
  const inspectionId = randomUUID();
  await database.query(
    `INSERT INTO projects
     (id,reference,name,client_name,site_name,service_key,status,accepted_scope_snapshot,created_by_user_id,created_at,updated_at,version)
     VALUES ($1,$2,'Fixture','Northstar Facade Group','Lab Site','building-envelope-inspection','fieldwork','{"synthetic":true}'::jsonb,$3,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1)`,
    [projectId, input.reference.replace("IN", "PR"), OWNER],
  );
  await database.query(
    `INSERT INTO inspections
     (id,reference,project_id,status,inspector_user_id,reviewer_user_id,completed_at,service_key,report_template_id,created_by_user_id,created_at,updated_at,version)
     VALUES ($1,$2,$3,'completed',$4,$5,$6,'building-envelope-inspection',$7,$5,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1)`,
    [
      inspectionId,
      input.reference,
      projectId,
      OPERATIONS,
      OWNER,
      input.completedAt ?? null,
      SEEDED_OPERATIONS_IDS.template,
    ],
  );
  return { projectId, inspectionId };
}

let database!: PGliteDatabaseAdapter;
let pipeline!: InspectionReportPipeline;
let authorization!: PersistentAuthorizationService;

beforeAll(async () => {
  database = new PGliteDatabaseAdapter("memory://");
  const migrated = await migrateDatabase(database);
  expect(migrated.applied.at(-1)).toBe("0026_cpl_hosted_workflow.sql");
  await seedDatabase(database);
  pipeline = new InspectionReportPipeline({
    database,
    deliveryAdapter: new ScriptedDeliveryAdapter(0),
    processInline: true,
    now: advancingClock(),
  });
  authorization = new PersistentAuthorizationService(new SqlFoundationRepository(database));
}, 60_000);

afterAll(async () => {
  await database?.close();
});

describe("Phase 3.0 inspection-to-report automation", () => {
  it("scenario 1 happy path: technical approval does not send; owner authorization delivers once", async () => {
    const submitted = await pipeline.submitInspection({
      inspectionId: SEEDED_OPERATIONS_IDS.happyInspection,
      sourceChannel: "direct_entry",
      sourceIdempotencyKey: "happy-complete-v1",
      payload: completeSyntheticSubmissionPayload(new Date("2026-08-31T16:00:00.000Z")),
      actorUserId: OPERATIONS,
      correlationId: "happy-1",
    });
    expect(submitted.duplicate).toBe(false);
    const inspection = await pipeline.repository.getInspection(
      SEEDED_OPERATIONS_IDS.happyInspection,
    );
    const report = await pipeline.repository.getReportByInspection(
      SEEDED_OPERATIONS_IDS.happyInspection,
    );
    expect(report?.status).toBe("in_review");
    const reviewed = await pipeline.reviewReport({
      reportId: report!.id,
      decision: "approve",
      actorUserId: OPERATIONS,
      correlationId: "happy-approve",
    });
    expect(reviewed.report.status).toBe("ready_for_delivery");
    expect(await pipeline.repository.listDeliveries(reviewed.report.id)).toHaveLength(0);
    const authorized = await pipeline.authorizeDelivery({
      reportId: reviewed.report.id,
      actorUserId: OWNER,
      correlationId: "happy-authorize",
    });
    expect(authorized.report.status).toBe("delivered");
    const deliveries = await pipeline.repository.listDeliveries(authorized.report.id);
    expect(deliveries.filter((item) => item.status === "delivered")).toHaveLength(1);
    const events = await pipeline.repository.listTimeline(SEEDED_OPERATIONS_IDS.happyInspection);
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "inspection.submitted",
        "inspection.validated",
        "report.draft_created",
        "report.review_requested",
        "report.approved",
        "report.ready_for_delivery",
        "report.delivery_requested",
        "report.delivered",
      ]),
    );
    const sla = await pipeline.repository.getSlaClock(SEEDED_OPERATIONS_IDS.happyInspection);
    const confirmed = await pipeline.repository.getConfirmedDelivery(authorized.report.id);
    expect(sla?.status).toBe("stopped");
    expect(inspection?.completedAt).toBeTruthy();
    expect(confirmed?.confirmedAt).toBeTruthy();
    const ageMs = Date.parse(confirmed!.confirmedAt!) - Date.parse(inspection!.completedAt!);
    expect(ageMs).toBeGreaterThan(0);
    expect(ageMs).toBeLessThan(4 * 60 * 60 * 1000);
    const intervals = sla ? await pipeline.repository.listStageIntervals(sla.id) : [];
    expect(intervals.length).toBeGreaterThan(0);
    expect(submitted.submission.rawPayload).toMatchObject({ clientName: "Northstar Facade Group" });
  });

  it("scenario 2 incomplete submission creates an exception, keeps wall-clock age, and emits exception.resolved", async () => {
    const first = await pipeline.submitInspection({
      inspectionId: SEEDED_OPERATIONS_IDS.blockedInspection,
      sourceChannel: "direct_entry",
      sourceIdempotencyKey: "blocked-incomplete-v1",
      payload: incompleteSyntheticSubmissionPayload(new Date("2026-08-31T16:00:00.000Z")),
      actorUserId: OPERATIONS,
      correlationId: "blocked-1",
    });
    expect(first.duplicate).toBe(false);
    expect(first.inspection.status).toBe("needs_correction");
    const exceptions = await pipeline.repository.listExceptionsForInspection(
      SEEDED_OPERATIONS_IDS.blockedInspection,
    );
    expect(exceptions[0]?.kind).toBe("validation");
    expect(exceptions[0]?.status).toBe("open");
    expect(exceptions[0]?.ownerUserId).toBe(OPERATIONS);
    const sla = await pipeline.repository.getSlaClock(SEEDED_OPERATIONS_IDS.blockedInspection);
    expect(sla?.status).toBe("paused");
    expect(sla?.pauseReason).toBe("awaiting_human");
    const board = await pipeline.repository.listTurnaroundBoard();
    const blocked = board.find(
      (item) => item.inspection.id === SEEDED_OPERATIONS_IDS.blockedInspection,
    );
    expect(blocked?.metrics.currentAgeMs).toBeGreaterThan(0);
    expect(blocked?.metrics.pausedDurationMs).toBeGreaterThan(0);
    expect(blocked?.currentOwner).toBe("Operations Coordinator");
    const corrected = await pipeline.submitInspection({
      inspectionId: SEEDED_OPERATIONS_IDS.blockedInspection,
      sourceChannel: "direct_entry",
      sourceIdempotencyKey: "blocked-complete-v1",
      payload: {
        ...completeSyntheticSubmissionPayload(new Date("2026-08-31T16:00:00.000Z")),
        siteName: "Harborview Plaza",
        clientName: "Harborview Property Partners",
      },
      actorUserId: OPERATIONS,
      correlationId: "blocked-2",
    });
    expect(corrected.duplicate).toBe(false);
    const report = await pipeline.repository.getReportByInspection(
      SEEDED_OPERATIONS_IDS.blockedInspection,
    );
    expect(report?.status).toBe("in_review");
    const resolved = await pipeline.repository.listExceptionsForInspection(
      SEEDED_OPERATIONS_IDS.blockedInspection,
    );
    expect(resolved.some((item) => item.status === "resolved")).toBe(true);
    const timeline = await pipeline.repository.listTimeline(
      SEEDED_OPERATIONS_IDS.blockedInspection,
    );
    expect(timeline.some((event) => event.eventType === "exception.resolved")).toBe(true);
    const audit = await database.query<{ event_type: string }>(
      "SELECT event_type FROM audit_logs WHERE event_type='exception.resolved'",
    );
    expect(audit.rows.length).toBeGreaterThan(0);
  });

  it("scenario 3 request revision waits for corrected input before creating a new version", async () => {
    const report = await pipeline.repository.getReportByInspection(
      SEEDED_OPERATIONS_IDS.blockedInspection,
    );
    expect(report).toBeTruthy();
    const versionsBefore = await pipeline.repository.listReportVersions(report!.id);
    await pipeline.reviewReport({
      reportId: report!.id,
      decision: "request_revision",
      comment: "Add the south-elevation context.",
      actorUserId: OWNER,
      correlationId: "revision-1",
    });
    const afterRequest = await pipeline.repository.getReport(report!.id);
    expect(afterRequest?.status).toBe("revision_required");
    const versionsAfterRequest = await pipeline.repository.listReportVersions(report!.id);
    expect(versionsAfterRequest).toHaveLength(versionsBefore.length);
    const corrected = await pipeline.submitInspection({
      inspectionId: SEEDED_OPERATIONS_IDS.blockedInspection,
      sourceChannel: "direct_entry",
      sourceIdempotencyKey: "blocked-revision-v2",
      payload: {
        ...completeSyntheticSubmissionPayload(new Date("2026-08-31T16:00:00.000Z")),
        siteName: "Harborview Plaza",
        clientName: "Harborview Property Partners",
        summary: "Corrected south-elevation narrative for revision.",
      },
      actorUserId: OPERATIONS,
      correlationId: "revision-correct",
    });
    expect(corrected.duplicate).toBe(false);
    const current = await pipeline.repository.getReport(report!.id);
    expect(current?.status).toBe("in_review");
    const versionsAfter = await pipeline.repository.listReportVersions(report!.id);
    expect(versionsAfter.length).toBe(versionsBefore.length + 1);
    expect(versionsAfter.some((version) => version.status === "superseded")).toBe(true);
    const approved = await pipeline.reviewReport({
      reportId: current!.id,
      decision: "approve",
      actorUserId: OPERATIONS,
      correlationId: "revision-approve",
    });
    expect(approved.report.status).toBe("ready_for_delivery");
    const delivered = await pipeline.authorizeDelivery({
      reportId: approved.report.id,
      actorUserId: OWNER,
      correlationId: "revision-authorize",
    });
    expect(delivered.report.status).toBe("delivered");
    const deliveries = await pipeline.repository.listDeliveries(delivered.report.id);
    expect(deliveries.filter((item) => item.status === "delivered")).toHaveLength(1);
  });

  it("scenario 4 duplicate submission does not create a second workflow or 500", async () => {
    const first = await pipeline.submitInspection({
      inspectionId: SEEDED_OPERATIONS_IDS.happyInspection,
      sourceChannel: "direct_entry",
      sourceIdempotencyKey: "happy-complete-v1",
      payload: completeSyntheticSubmissionPayload(new Date("2026-08-31T16:00:00.000Z")),
      actorUserId: OPERATIONS,
      correlationId: "dup-1",
    });
    expect(first.duplicate).toBe(true);
    const reports = (await pipeline.repository.listReports()).filter(
      (report) => report.inspectionId === SEEDED_OPERATIONS_IDS.happyInspection,
    );
    expect(reports).toHaveLength(1);
  });

  it("scenario 5 concurrent duplicate submissions return a stable duplicate result", async () => {
    const fixture = await insertInspectionFixture(database, { reference: "BEA-IN-000198" });
    const local = new InspectionReportPipeline({
      database,
      deliveryAdapter: new ScriptedDeliveryAdapter(0),
      processInline: true,
      now: advancingClock("2026-08-31T17:00:00.000Z"),
    });
    const payload = completeSyntheticSubmissionPayload(new Date("2026-08-31T17:00:00.000Z"));
    const [left, right] = await Promise.all([
      local.submitInspection({
        inspectionId: fixture.inspectionId,
        sourceChannel: "direct_entry",
        sourceIdempotencyKey: "concurrent-dup-v1",
        payload,
        actorUserId: OPERATIONS,
        correlationId: "dup-left",
      }),
      local.submitInspection({
        inspectionId: fixture.inspectionId,
        sourceChannel: "direct_entry",
        sourceIdempotencyKey: "concurrent-dup-v1",
        payload,
        actorUserId: OPERATIONS,
        correlationId: "dup-right",
      }),
    ]);
    expect([left.duplicate, right.duplicate].filter(Boolean).length).toBeGreaterThanOrEqual(1);
    const submissions = await database.query<{ count: string | number }>(
      "SELECT COUNT(*) AS count FROM inspection_submissions WHERE inspection_id=$1",
      [fixture.inspectionId],
    );
    expect(Number(submissions.rows[0]?.count)).toBe(1);
  });

  it("scenario 6 delivery failure stays undelivered, retries once, and does not double-send", async () => {
    const fixture = await insertInspectionFixture(database, { reference: "BEA-IN-000099" });
    const adapter = new ScriptedDeliveryAdapter(1);
    const failing = new InspectionReportPipeline({
      database,
      deliveryAdapter: adapter,
      processInline: true,
      now: advancingClock("2026-08-31T18:00:00.000Z"),
    });
    await failing.submitInspection({
      inspectionId: fixture.inspectionId,
      sourceChannel: "direct_entry",
      sourceIdempotencyKey: "delivery-fail-v1",
      payload: completeSyntheticSubmissionPayload(new Date("2026-08-31T18:00:00.000Z")),
      actorUserId: OPERATIONS,
      correlationId: "delivery-fail-submit",
    });
    const report = await failing.repository.getReportByInspection(fixture.inspectionId);
    await failing.reviewReport({
      reportId: report!.id,
      decision: "approve",
      actorUserId: OPERATIONS,
      correlationId: "delivery-fail-approve",
    });
    expect((await failing.repository.getReport(report!.id))?.status).toBe("ready_for_delivery");
    await failing.authorizeDelivery({
      reportId: report!.id,
      actorUserId: OWNER,
      correlationId: "delivery-fail-authorize",
    });
    expect((await failing.repository.getReport(report!.id))?.status).toBe("delivery_failed");
    expect(adapter.uniqueDeliveries).toBe(0);
    await failing.retryDelivery({
      reportId: report!.id,
      actorUserId: OWNER,
      correlationId: "delivery-fail-retry",
    });
    expect((await failing.repository.getReport(report!.id))?.status).toBe("delivered");
    expect(adapter.uniqueDeliveries).toBe(1);
    const auth = await failing.repository.getActiveDeliveryAuthorization(report!.id);
    expect(auth).toBeNull();
  });

  it("scenario 7 pending jobs resume after a worker-style drain", async () => {
    const fixture = await insertInspectionFixture(database, { reference: "BEA-IN-000096" });
    const queued = new InspectionReportPipeline({
      database,
      deliveryAdapter: new ScriptedDeliveryAdapter(0),
      processInline: false,
      now: advancingClock("2026-08-31T19:00:00.000Z"),
    });
    await queued.submitInspection({
      inspectionId: fixture.inspectionId,
      sourceChannel: "direct_entry",
      sourceIdempotencyKey: "worker-restart-v1",
      payload: completeSyntheticSubmissionPayload(new Date("2026-08-31T19:00:00.000Z")),
      actorUserId: OPERATIONS,
      correlationId: "worker-1",
    });
    const pendingBefore = (
      await queued.repository.listJobsForInspection(fixture.inspectionId)
    ).filter((job) => job.status === "pending" || job.status === "claimed");
    expect(pendingBefore.length).toBeGreaterThan(0);
    const recovered = new InspectionReportPipeline({
      database,
      deliveryAdapter: new ScriptedDeliveryAdapter(0),
      processInline: false,
      now: advancingClock("2026-08-31T19:05:00.000Z"),
    });
    await recovered.processPendingJobs({
      claimOwner: "restarted-worker",
      aggregateId: fixture.inspectionId,
    });
    expect((await recovered.repository.getReportByInspection(fixture.inspectionId))?.status).toBe(
      "in_review",
    );
  });

  it("scenario 8 authorization: operations can approve, cannot deliver; sales and integration-admin are denied", async () => {
    expect(
      (await authorization.authorizeUser(OPERATIONS, PERMISSIONS.REPORTS_APPROVE)).allowed,
    ).toBe(true);
    expect(
      (await authorization.authorizeUser(OPERATIONS, PERMISSIONS.REPORTS_DELIVER)).allowed,
    ).toBe(false);
    expect(
      (await authorization.authorizeUser(SALES, PERMISSIONS.INSPECTIONS_CORRECT)).allowed,
    ).toBe(false);
    expect((await authorization.authorizeUser(SALES, PERMISSIONS.REPORTS_APPROVE)).allowed).toBe(
      false,
    );
    expect((await authorization.authorizeUser(SALES, PERMISSIONS.REPORTS_DELIVER)).allowed).toBe(
      false,
    );
    expect(
      (await authorization.authorizeUser(INTEGRATION, PERMISSIONS.OPERATIONS_BOARD_VIEW)).allowed,
    ).toBe(false);
    expect((await authorization.authorizeUser(OWNER, PERMISSIONS.REPORTS_DELIVER)).allowed).toBe(
      true,
    );
  });
});

describe("Phase 3.0 atomic claiming and delivery authorization", () => {
  it("allows only one claimant for a pending job and refuses a non-stale claimed job", async () => {
    const fixture = await insertInspectionFixture(database, { reference: "BEA-IN-000181" });
    const queued = new InspectionReportPipeline({
      database,
      deliveryAdapter: new ScriptedDeliveryAdapter(0),
      processInline: false,
      now: advancingClock("2026-08-31T20:00:00.000Z"),
    });
    await queued.submitInspection({
      inspectionId: fixture.inspectionId,
      sourceChannel: "direct_entry",
      sourceIdempotencyKey: "claim-race-v1",
      payload: completeSyntheticSubmissionPayload(new Date("2026-08-31T20:00:00.000Z")),
      actorUserId: OPERATIONS,
      correlationId: "claim-race",
    });
    const web = new InspectionReportPipeline({
      database,
      deliveryAdapter: new ScriptedDeliveryAdapter(0),
      processInline: false,
    });
    const worker = new InspectionReportPipeline({
      database,
      deliveryAdapter: new ScriptedDeliveryAdapter(0),
      processInline: false,
    });
    const [first, second] = await Promise.all([
      web.claimNextRunnableJob("web-runtime", fixture.inspectionId),
      worker.claimNextRunnableJob("worker-runtime", fixture.inspectionId),
    ]);
    const claimed = [first, second].filter(Boolean);
    expect(claimed).toHaveLength(1);
    const again = await worker.claimNextRunnableJob("worker-runtime-2", fixture.inspectionId);
    expect(again).toBeNull();
  });

  it("reclaims a stale claimed job and still refuses delivery without a valid authorization", async () => {
    const fixture = await insertInspectionFixture(database, { reference: "BEA-IN-000182" });
    const queued = new InspectionReportPipeline({
      database,
      deliveryAdapter: new ScriptedDeliveryAdapter(0),
      processInline: false,
      now: advancingClock("2026-08-31T21:00:00.000Z"),
    });
    await queued.submitInspection({
      inspectionId: fixture.inspectionId,
      sourceChannel: "direct_entry",
      sourceIdempotencyKey: "stale-claim-v1",
      payload: completeSyntheticSubmissionPayload(new Date("2026-08-31T21:00:00.000Z")),
      actorUserId: OPERATIONS,
      correlationId: "stale-claim",
    });
    const claimed = await queued.claimNextRunnableJob("crashed-worker", fixture.inspectionId);
    expect(claimed).toBeTruthy();
    await database.query(
      "UPDATE automation_jobs SET claimed_at=$2, lease_expires_at=$2, updated_at=$2 WHERE id=$1",
      [claimed!.id, "2026-08-31T20:59:00.000Z"],
    );
    const reclaimed = await queued.claimNextRunnableJob("recovery-worker", fixture.inspectionId);
    expect(reclaimed?.id).toBe(claimed!.id);
    expect(reclaimed?.claimedBy).toBe("recovery-worker");
  });

  it("does not invoke the delivery adapter twice under concurrent drains", async () => {
    const fixture = await insertInspectionFixture(database, { reference: "BEA-IN-000183" });
    const counting = new CountingDeliveryAdapter(new ScriptedDeliveryAdapter(0));
    const setup = new InspectionReportPipeline({
      database,
      deliveryAdapter: counting,
      processInline: true,
      now: advancingClock("2026-08-31T22:00:00.000Z"),
    });
    await setup.submitInspection({
      inspectionId: fixture.inspectionId,
      sourceChannel: "direct_entry",
      sourceIdempotencyKey: "drain-race-v1",
      payload: completeSyntheticSubmissionPayload(new Date("2026-08-31T22:00:00.000Z")),
      actorUserId: OPERATIONS,
      correlationId: "drain-submit",
    });
    const report = await setup.repository.getReportByInspection(fixture.inspectionId);
    await setup.reviewReport({
      reportId: report!.id,
      decision: "approve",
      actorUserId: OPERATIONS,
      correlationId: "drain-approve",
    });
    const queued = new InspectionReportPipeline({
      database,
      deliveryAdapter: counting,
      processInline: false,
      now: advancingClock("2026-08-31T22:10:00.000Z"),
    });
    await queued.authorizeDelivery({
      reportId: report!.id,
      actorUserId: OWNER,
      correlationId: "drain-authorize",
    });
    counting.calls = 0;
    const drainClock = advancingClock("2026-08-31T22:15:00.000Z");
    const web = new InspectionReportPipeline({
      database,
      deliveryAdapter: counting,
      processInline: false,
      now: drainClock,
    });
    const worker = new InspectionReportPipeline({
      database,
      deliveryAdapter: counting,
      processInline: false,
      now: advancingClock("2026-08-31T22:15:00.000Z"),
    });
    await Promise.all([
      web.processPendingJobs({ claimOwner: "web-drain", aggregateId: report!.id }),
      worker.processPendingJobs({ claimOwner: "worker-drain", aggregateId: report!.id }),
    ]);
    expect(counting.calls).toBe(1);
    const deliveries = await queued.repository.listDeliveries(report!.id);
    expect(deliveries.filter((item) => item.status === "delivered")).toHaveLength(1);
  });

  it("revalidates authorization so a revoked or superseded grant cannot send", async () => {
    const fixture = await insertInspectionFixture(database, { reference: "BEA-IN-000184" });
    const counting = new CountingDeliveryAdapter(new ScriptedDeliveryAdapter(0));
    const setup = new InspectionReportPipeline({
      database,
      deliveryAdapter: counting,
      processInline: true,
      now: advancingClock("2026-08-31T23:00:00.000Z"),
    });
    await setup.submitInspection({
      inspectionId: fixture.inspectionId,
      sourceChannel: "direct_entry",
      sourceIdempotencyKey: "revoke-v1",
      payload: completeSyntheticSubmissionPayload(new Date("2026-08-31T23:00:00.000Z")),
      actorUserId: OPERATIONS,
      correlationId: "revoke-submit",
    });
    const report = await setup.repository.getReportByInspection(fixture.inspectionId);
    await setup.reviewReport({
      reportId: report!.id,
      decision: "approve",
      actorUserId: OPERATIONS,
      correlationId: "revoke-approve",
    });
    const queued = new InspectionReportPipeline({
      database,
      deliveryAdapter: counting,
      processInline: false,
    });
    await queued.authorizeDelivery({
      reportId: report!.id,
      actorUserId: OWNER,
      correlationId: "revoke-authorize",
    });
    await queued.revokeDeliveryAuthorization({
      reportId: report!.id,
      actorUserId: OWNER,
      correlationId: "revoke",
    });
    counting.calls = 0;
    await queued.processPendingJobs({ claimOwner: "stale-delivery", aggregateId: report!.id });
    expect(counting.calls).toBe(0);
    expect((await queued.repository.getReport(report!.id))?.status).not.toBe("delivered");
  });

  it("keeps one confirmed delivery after concurrent retries", async () => {
    const fixture = await insertInspectionFixture(database, { reference: "BEA-IN-000185" });
    const adapter = new ScriptedDeliveryAdapter(1);
    const failing = new InspectionReportPipeline({
      database,
      deliveryAdapter: adapter,
      processInline: true,
      now: advancingClock("2026-09-01T00:00:00.000Z"),
    });
    await failing.submitInspection({
      inspectionId: fixture.inspectionId,
      sourceChannel: "direct_entry",
      sourceIdempotencyKey: "retry-race-v1",
      payload: completeSyntheticSubmissionPayload(new Date("2026-09-01T00:00:00.000Z")),
      actorUserId: OPERATIONS,
      correlationId: "retry-submit",
    });
    const report = await failing.repository.getReportByInspection(fixture.inspectionId);
    await failing.reviewReport({
      reportId: report!.id,
      decision: "approve",
      actorUserId: OPERATIONS,
      correlationId: "retry-approve",
    });
    await failing.authorizeDelivery({
      reportId: report!.id,
      actorUserId: OWNER,
      correlationId: "retry-authorize",
    });
    const queued = new InspectionReportPipeline({
      database,
      deliveryAdapter: adapter,
      processInline: false,
    });
    await Promise.all([
      queued.retryDelivery({
        reportId: report!.id,
        actorUserId: OWNER,
        correlationId: "retry-a",
      }),
      queued.retryDelivery({
        reportId: report!.id,
        actorUserId: OWNER,
        correlationId: "retry-b",
      }),
    ]);
    await Promise.all([
      queued.processPendingJobs({ claimOwner: "retry-drain-a", aggregateId: report!.id }),
      queued.processPendingJobs({ claimOwner: "retry-drain-b", aggregateId: report!.id }),
    ]);
    const deliveries = await queued.repository.listDeliveries(report!.id);
    expect(deliveries.filter((item) => item.status === "delivered")).toHaveLength(1);
  });

  it("does not let a previous claimant settle a job after another worker reclaimed it", async () => {
    const fixture = await insertInspectionFixture(database, { reference: "BEA-IN-000186" });
    const queued = new InspectionReportPipeline({
      database,
      deliveryAdapter: new ScriptedDeliveryAdapter(0),
      processInline: false,
      now: advancingClock("2026-09-01T01:00:00.000Z"),
    });
    await queued.submitInspection({
      inspectionId: fixture.inspectionId,
      sourceChannel: "direct_entry",
      sourceIdempotencyKey: "owner-bound-v1",
      payload: completeSyntheticSubmissionPayload(new Date("2026-09-01T01:00:00.000Z")),
      actorUserId: OPERATIONS,
      correlationId: "owner-bound",
    });
    const claimed = await queued.claimNextRunnableJob("owner-a", fixture.inspectionId);
    expect(claimed).toBeTruthy();
    await database.query(
      "UPDATE automation_jobs SET claimed_at=$2, lease_expires_at=$2, updated_at=$2 WHERE id=$1",
      [claimed!.id, "2026-09-01T00:59:00.000Z"],
    );
    const reclaimed = await queued.claimNextRunnableJob("owner-b", fixture.inspectionId);
    expect(reclaimed?.id).toBe(claimed!.id);
    expect(reclaimed?.claimedBy).toBe("owner-b");
    await queued.executeClaimedJob(claimed!.id, "owner-a");
    const afterSucceed = (await queued.repository.listJobs(fixture.inspectionId)).find(
      (job) => job.id === claimed!.id,
    );
    expect(afterSucceed?.status).toBe("claimed");
    expect(afterSucceed?.claimedBy).toBe("owner-b");
    const failed = await failClaimedJob(database, {
      jobId: claimed!.id,
      claimOwner: "owner-a",
      status: "dead_letter",
      attemptCount: 9,
      availableAt: "2026-09-01T01:02:00.000Z",
      now: "2026-09-01T01:02:00.000Z",
      lastError: JSON.stringify({ code: "TEST", message: "should not apply" }),
    });
    expect(failed).toBeNull();
    const afterFail = (await queued.repository.listJobs(fixture.inspectionId)).find(
      (job) => job.id === claimed!.id,
    );
    expect(afterFail?.status).toBe("claimed");
    expect(afterFail?.claimedBy).toBe("owner-b");
  });

  it("refreshes the delivery job authorization id when a dead-letter job is re-authorized", async () => {
    const fixture = await insertInspectionFixture(database, { reference: "BEA-IN-000187" });
    const setup = new InspectionReportPipeline({
      database,
      deliveryAdapter: new ScriptedDeliveryAdapter(0),
      processInline: true,
      now: advancingClock("2026-09-01T02:00:00.000Z"),
    });
    await setup.submitInspection({
      inspectionId: fixture.inspectionId,
      sourceChannel: "direct_entry",
      sourceIdempotencyKey: "reauth-payload-v1",
      payload: completeSyntheticSubmissionPayload(new Date("2026-09-01T02:00:00.000Z")),
      actorUserId: OPERATIONS,
      correlationId: "reauth-submit",
    });
    const report = await setup.repository.getReportByInspection(fixture.inspectionId);
    await setup.reviewReport({
      reportId: report!.id,
      decision: "approve",
      actorUserId: OPERATIONS,
      correlationId: "reauth-approve",
    });
    const queued = new InspectionReportPipeline({
      database,
      deliveryAdapter: new ScriptedDeliveryAdapter(0),
      processInline: false,
    });
    const first = await queued.authorizeDelivery({
      reportId: report!.id,
      actorUserId: OWNER,
      correlationId: "reauth-first",
    });
    const original = (await queued.repository.listJobs(report!.id)).find(
      (job) => job.jobType === "report.deliver",
    );
    expect(original?.payload.authorizationId).toBe(first.authorizationId);
    await database.query("UPDATE automation_jobs SET status='dead_letter' WHERE id=$1", [
      original!.id,
    ]);
    await queued.revokeDeliveryAuthorization({
      reportId: report!.id,
      actorUserId: OWNER,
      correlationId: "reauth-revoke",
    });
    const second = await queued.authorizeDelivery({
      reportId: report!.id,
      actorUserId: OWNER,
      correlationId: "reauth-second",
    });
    expect(second.authorizationId).not.toBe(first.authorizationId);
    const refreshed = (await queued.repository.listJobs(report!.id)).find(
      (job) => job.id === original!.id,
    );
    expect(refreshed?.status).toBe("pending");
    expect(refreshed?.payload.authorizationId).toBe(second.authorizationId);
  });

  it("does not mark a delivery job succeeded when consume misses after adapter success", async () => {
    const fixture = await insertInspectionFixture(database, { reference: "BEA-IN-000188" });
    const inner = new ScriptedDeliveryAdapter(0);
    const revokeDuringSend: DeliveryAdapter = {
      key: "revoke-during-send",
      live: false,
      async deliver(request) {
        await database.query(
          `UPDATE delivery_authorizations
              SET status='revoked', reserved_token=NULL, reserved_at=NULL, updated_at=CURRENT_TIMESTAMP, version=version+1
            WHERE report_id=$1 AND status='active'`,
          [request.reportId],
        );
        return inner.deliver(request);
      },
    };
    const setup = new InspectionReportPipeline({
      database,
      deliveryAdapter: revokeDuringSend,
      processInline: true,
      now: advancingClock("2026-09-01T03:00:00.000Z"),
    });
    await setup.submitInspection({
      inspectionId: fixture.inspectionId,
      sourceChannel: "direct_entry",
      sourceIdempotencyKey: "consume-miss-v1",
      payload: completeSyntheticSubmissionPayload(new Date("2026-09-01T03:00:00.000Z")),
      actorUserId: OPERATIONS,
      correlationId: "consume-submit",
    });
    const report = await setup.repository.getReportByInspection(fixture.inspectionId);
    await setup.reviewReport({
      reportId: report!.id,
      decision: "approve",
      actorUserId: OPERATIONS,
      correlationId: "consume-approve",
    });
    const queued = new InspectionReportPipeline({
      database,
      deliveryAdapter: revokeDuringSend,
      processInline: false,
    });
    await queued.authorizeDelivery({
      reportId: report!.id,
      actorUserId: OWNER,
      correlationId: "consume-authorize",
    });
    await queued.processPendingJobs({ claimOwner: "consume-miss", aggregateId: report!.id });
    const jobs = await queued.repository.listJobs(report!.id);
    const deliver = jobs.find((job) => job.jobType === "report.deliver");
    expect(deliver?.status).toBe("dead_letter");
    expect(deliver?.lastError).toMatchObject({ code: "DELIVERY_OUTCOME_UNCERTAIN" });
    expect((await queued.repository.getReport(report!.id))?.status).not.toBe("delivered");
    expect(
      (await queued.repository.listDeliveries(report!.id)).filter(
        (item) => item.status === "delivered",
      ),
    ).toHaveLength(0);
  });

  it("refuses send when authorization recipients no longer match the job destination", async () => {
    const fixture = await insertInspectionFixture(database, { reference: "BEA-IN-000189" });
    const counting = new CountingDeliveryAdapter(new ScriptedDeliveryAdapter(0));
    const setup = new InspectionReportPipeline({
      database,
      deliveryAdapter: counting,
      processInline: true,
      now: advancingClock("2026-09-01T04:00:00.000Z"),
    });
    await setup.submitInspection({
      inspectionId: fixture.inspectionId,
      sourceChannel: "direct_entry",
      sourceIdempotencyKey: "dest-mismatch-1",
      payload: completeSyntheticSubmissionPayload(new Date("2026-09-01T04:00:00.000Z")),
      actorUserId: OPERATIONS,
      correlationId: "dest-submit",
    });
    const report = await setup.repository.getReportByInspection(fixture.inspectionId);
    await setup.reviewReport({
      reportId: report!.id,
      decision: "approve",
      actorUserId: OPERATIONS,
      correlationId: "dest-approve",
    });
    const queued = new InspectionReportPipeline({
      database,
      deliveryAdapter: counting,
      processInline: false,
    });
    await queued.authorizeDelivery({
      reportId: report!.id,
      actorUserId: OWNER,
      correlationId: "dest-authorize",
    });
    await database.query(
      `UPDATE delivery_authorizations
          SET recipients='["other@example.invalid"]'::jsonb, updated_at=CURRENT_TIMESTAMP, version=version+1
        WHERE report_id=$1 AND status='active'`,
      [report!.id],
    );
    counting.calls = 0;
    await queued.processPendingJobs({ claimOwner: "dest-mismatch", aggregateId: report!.id });
    expect(counting.calls).toBe(0);
    const deliver = (await queued.repository.listJobs(report!.id)).find(
      (job) => job.jobType === "report.deliver",
    );
    expect(deliver?.status).toBe("dead_letter");
    expect((await queued.repository.getReport(report!.id))?.status).not.toBe("delivered");
  });
});

describe("Phase 3.0 API authorization mapping", () => {
  it("maps unauthenticated to 401 and unauthorized roles to 403", async () => {
    expect(permissionForReportAction("technical-approve")?.permission).toBe(
      PERMISSIONS.REPORTS_APPROVE,
    );
    expect(permissionForReportAction("authorize-delivery")?.permission).toBe(
      PERMISSIONS.REPORTS_DELIVER,
    );
    expect(permissionForReportAction("retry-delivery")?.permission).toBe(
      PERMISSIONS.REPORTS_DELIVER,
    );
    expect(permissionForInspectionSubmit(true)).toBe(PERMISSIONS.INSPECTIONS_CORRECT);
    async function statusFor(userId: string | null, action: string) {
      if (!userId) return 401;
      const mapped = permissionForReportAction(action);
      if (!mapped) return 400;
      const decision = await authorization.authorizeUser(userId, mapped.permission);
      return decision.allowed ? 200 : 403;
    }
    expect(await statusFor(null, "authorize-delivery")).toBe(401);
    expect(await statusFor(SALES, "technical-approve")).toBe(403);
    expect(await statusFor(SALES, "authorize-delivery")).toBe(403);
    expect(await statusFor(OPERATIONS, "authorize-delivery")).toBe(403);
    expect(await statusFor(OPERATIONS, "retry-delivery")).toBe(403);
    expect(await statusFor(OPERATIONS, "technical-approve")).toBe(200);
    expect(await statusFor(OWNER, "authorize-delivery")).toBe(200);
    expect((await authorization.authorizeUser(SALES, PERMISSIONS.EXCEPTIONS_MANAGE)).allowed).toBe(
      false,
    );
    expect((await authorization.authorizeUser(SALES, PERMISSIONS.REPORTS_VIEW)).allowed).toBe(true);
    expect((await authorization.authorizeUser(INTEGRATION, PERMISSIONS.REPORTS_VIEW)).allowed).toBe(
      false,
    );
  });

  it("projects raw inspection payloads away from sales-level viewers", () => {
    const projected = projectInspectionSubmission({
      canViewSensitive: false,
      submission: {
        id: "sub-1",
        inspectionId: "insp-1",
        sourceChannel: "direct_entry",
        sourceIdempotencyKey: "k",
        payloadSha256: "aa",
        rawPayload: { secret: "field-photo" },
        schemaVersion: "1",
        mappingVersion: "1",
        normalizedPayload: { clientName: "hidden" },
        actorUserId: OPERATIONS,
        correlationId: "c",
        createdAt: "2026-08-31T16:00:00.000Z",
      },
      findings: [
        {
          id: "f1",
          submissionId: "sub-1",
          inspectionId: "insp-1",
          code: "F-1",
          sectionKey: "envelope",
          title: "Gap",
          description: "Sensitive narrative",
          severity: "major",
          location: "South",
          sortOrder: 0,
          createdAt: "2026-08-31T16:00:00.000Z",
        },
      ],
      evidence: [
        {
          id: "e1",
          submissionId: "sub-1",
          inspectionId: "insp-1",
          findingId: "f1",
          kind: "photo",
          filename: "south.jpg",
          contentType: "image/jpeg",
          sha256: "ab".repeat(32),
          byteLength: 12,
          storageRef: "synthetic://south.jpg",
          createdAt: "2026-08-31T16:00:00.000Z",
        },
      ],
    });
    expect(projected.submission).toEqual({ id: "sub-1", createdAt: "2026-08-31T16:00:00.000Z" });
    expect(projected.findings).toEqual([{ code: "F-1", title: "Gap" }]);
    expect(projected.evidence).toEqual([{ kind: "photo", filename: "south.jpg" }]);
  });

  it("projects report-version input snapshots away from sales-level viewers", () => {
    const projected = projectReportVersions({
      canViewSensitive: false,
      versions: [
        {
          id: "v1",
          reportId: "r1",
          versionNumber: 1,
          status: "in_review",
          inputSnapshot: {
            payload: { raw: "secret" },
            inspectionReference: "BEA-IN-000001",
            payloadSha256: "aa",
          },
          templateVersionId: "t1",
          submissionId: "sub-1",
          renderedChecksum: null,
          renderedStorageRef: null,
          renderedMimeType: null,
          reviewerUserId: null,
          reviewedAt: null,
          reviewDecision: null,
          reviewComment: null,
          createdAt: "2026-08-31T16:00:00.000Z",
        },
      ],
    });
    expect(projected[0]?.inputSnapshot.payload).toBeUndefined();
    expect(projected[0]?.inputSnapshot.inspectionReference).toBe("BEA-IN-000001");
  });
});

describe("Phase 3.0 AI independence", () => {
  let runtime: BeaServerRuntime | undefined;
  it("scenario 9 boots and runs without an AI key", async () => {
    runtime = await createServerRuntime({
      loadEnvFile: false,
      processEnvironment: {
        NODE_ENV: "test",
        APP_MODE: "demo",
        DATABASE_DRIVER: "pglite",
        DEMO_DATABASE_PATH: "memory://",
        DEMO_AUTH_ENABLED: "true",
        LOG_LEVEL: "silent",
        OPENAI_API_KEY: "",
      },
    });
    expect(runtime.environment.appMode).toBe("demo");
    const board = await runtime.operations.repository.listTurnaroundBoard();
    expect(board.length).toBeGreaterThanOrEqual(2);
    const connectors = await runtime.operations.repository.listConnectorReadiness();
    expect(connectors.every((item) => item.readinessStatus !== "healthy")).toBe(true);
  });
  afterAll(async () => {
    await runtime?.close();
  });
});
