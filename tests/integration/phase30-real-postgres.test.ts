import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ScriptedDeliveryAdapter } from "../../packages/automation/src/index.js";
import {
  DEMO_PERSONAS,
  JOB_LEASE_MS,
  SEEDED_OPERATIONS_IDS,
} from "../../packages/domain/src/index.js";
import {
  InspectionReportPipeline,
  PgDatabaseAdapter,
  completeSyntheticSubmissionPayload,
  migrateDatabase,
  seedDatabase,
  verifyMigrations,
} from "../../packages/database/src/index.js";

const OWNER = DEMO_PERSONAS[0].id;
const OPERATIONS = DEMO_PERSONAS[2].id;

function inspectPhase30PostgresUrl(value: string | undefined) {
  const url = value?.trim() ?? "";
  if (!url) {
    return { ready: false as const, detail: "BEA_PHASE30_REAL_POSTGRES_URL is not set." };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("BEA_PHASE30_REAL_POSTGRES_URL is invalid.");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("BEA_PHASE30_REAL_POSTGRES_URL must be a PostgreSQL URL.");
  }
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!/(?:phase[_-]?30|test|ci|disposable)/iu.test(database)) {
    throw new Error(
      "Refusing a PostgreSQL database whose name does not contain phase30, test, ci, or disposable.",
    );
  }
  return { ready: true as const, url, database };
}

const prerequisite = inspectPhase30PostgresUrl(process.env.BEA_PHASE30_REAL_POSTGRES_URL);
const describePostgres = prerequisite.ready ? describe.sequential : describe.sequential.skip;

describePostgres("Phase 3.0 real PostgreSQL concurrency", () => {
  let database: PgDatabaseAdapter;

  beforeAll(async () => {
    if (!prerequisite.ready) return;
    database = new PgDatabaseAdapter({
      connectionString: prerequisite.url,
      max: 8,
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
  });

  it("enforces atomic claims, duplicate submissions, one delivery, and rollback", async () => {
    const projectId = randomUUID();
    const inspectionId = randomUUID();
    const reference = `BEA-IN-${randomUUID().slice(0, 6)}`;
    await database.query(
      `INSERT INTO projects
       (id,reference,name,client_name,site_name,service_key,status,accepted_scope_snapshot,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,$2,'PG fixture','Northstar Facade Group','Lab Site','building-envelope-inspection','fieldwork','{"synthetic":true}'::jsonb,$3,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1)`,
      [projectId, reference.replace("IN", "PR"), OWNER],
    );
    await database.query(
      `INSERT INTO inspections
       (id,reference,project_id,status,inspector_user_id,reviewer_user_id,completed_at,service_key,report_template_id,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,$2,$3,'completed',$4,$5,NULL,'building-envelope-inspection',$6,$5,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1)`,
      [inspectionId, reference, projectId, OPERATIONS, OWNER, SEEDED_OPERATIONS_IDS.template],
    );
    const pipeline = new InspectionReportPipeline({
      database,
      deliveryAdapter: new ScriptedDeliveryAdapter(0),
      processInline: false,
    });
    await pipeline.submitInspection({
      inspectionId,
      sourceChannel: "direct_entry",
      sourceIdempotencyKey: "pg-happy-v1",
      payload: completeSyntheticSubmissionPayload(),
      actorUserId: OPERATIONS,
      correlationId: "pg-submit",
    });
    const [left, right] = await Promise.all([
      pipeline.claimNextRunnableJob("pg-claimer-a", inspectionId),
      pipeline.claimNextRunnableJob("pg-claimer-b", inspectionId),
    ]);
    const claimed = [left, right].filter(Boolean);
    expect(claimed).toHaveLength(1);
    expect(await pipeline.claimNextRunnableJob("pg-claimer-c", inspectionId)).toBeNull();
    const stale = new Date(Date.now() - JOB_LEASE_MS - 1_000).toISOString();
    await database.query(
      "UPDATE automation_jobs SET claimed_at=$2, lease_expires_at=$2 WHERE id=$1",
      [claimed[0]!.id, stale],
    );
    const recovered = await pipeline.claimNextRunnableJob("pg-recovery", inspectionId);
    expect(recovered?.id).toBe(claimed[0]!.id);
    await database.query(
      `UPDATE automation_jobs
          SET status='pending', claimed_at=NULL, claimed_by=NULL, lease_expires_at=NULL
        WHERE aggregate_id=$1 AND status='claimed'`,
      [inspectionId],
    );

    const duplicates = await Promise.all([
      pipeline.submitInspection({
        inspectionId,
        sourceChannel: "direct_entry",
        sourceIdempotencyKey: "pg-happy-v1",
        payload: completeSyntheticSubmissionPayload(),
        actorUserId: OPERATIONS,
        correlationId: "pg-dup-a",
      }),
      pipeline.submitInspection({
        inspectionId,
        sourceChannel: "direct_entry",
        sourceIdempotencyKey: "pg-happy-v1",
        payload: completeSyntheticSubmissionPayload(),
        actorUserId: OPERATIONS,
        correlationId: "pg-dup-b",
      }),
    ]);
    expect(duplicates.every((item) => item.duplicate)).toBe(true);

    await pipeline.processPendingJobs({ claimOwner: "pg-worker", aggregateId: inspectionId });
    const report = await pipeline.repository.getReportByInspection(inspectionId);
    expect(report?.status).toBe("in_review");
    await pipeline.reviewReport({
      reportId: report!.id,
      decision: "approve",
      actorUserId: OPERATIONS,
      correlationId: "pg-approve",
    });
    await pipeline.processPendingJobs({ claimOwner: "pg-render", aggregateId: report!.id });
    expect((await pipeline.repository.getReport(report!.id))?.status).toBe("ready_for_delivery");
    await pipeline.authorizeDelivery({
      reportId: report!.id,
      actorUserId: OWNER,
      correlationId: "pg-authorize",
    });
    await Promise.all([
      pipeline.processPendingJobs({ claimOwner: "pg-drain-a", aggregateId: report!.id }),
      pipeline.processPendingJobs({ claimOwner: "pg-drain-b", aggregateId: report!.id }),
    ]);
    const deliveries = await pipeline.repository.listDeliveries(report!.id);
    expect(deliveries.filter((item) => item.status === "delivered")).toHaveLength(1);
    const authorizations = await pipeline.repository.listDeliveryAuthorizations(report!.id);
    expect(authorizations.some((item) => item.status === "consumed")).toBe(true);
    expect(authorizations.filter((item) => item.status === "active")).toHaveLength(0);

    const statusBefore = (await pipeline.repository.getReport(report!.id))?.status;
    await expect(
      database.transaction(async (transaction) => {
        await transaction.query("UPDATE inspection_reports SET version=version+1 WHERE id=$1", [
          report!.id,
        ]);
        throw new Error("forced rollback");
      }),
    ).rejects.toThrow("forced rollback");
    expect((await pipeline.repository.getReport(report!.id))?.status).toBe(statusBefore);
  });
});
