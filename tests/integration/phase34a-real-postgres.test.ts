import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEMO_PERSONAS,
  GuidedDemoAuthorizationError,
  GuidedDemoConcurrencyError,
} from "../../packages/domain/src/index.js";
import {
  CommercialWorkflowService,
  GuidedMeridianService,
  PgDatabaseAdapter,
  SqlLeadRepository,
  createInspectionReportPipeline,
  loadGuidedMeridianReportView,
  migrateDatabase,
  seedDatabase,
  verifyMigrations,
  type InspectionReportPipeline,
} from "../../packages/database/src/index.js";

const OWNER = DEMO_PERSONAS[0]!.id;
const OPERATIONS = DEMO_PERSONAS[2]!.id;
const LATEST_MIGRATION = "0039_cpl_durable_inbound.sql";

function inspectPhase34aPostgresUrl(value: string | undefined) {
  const url = value?.trim() ?? "";
  if (!url) {
    return { ready: false as const, detail: "BEA_PHASE34A_REAL_POSTGRES_URL is not set." };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("BEA_PHASE34A_REAL_POSTGRES_URL is invalid.");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("BEA_PHASE34A_REAL_POSTGRES_URL must be a PostgreSQL URL.");
  }
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!/(?:phase[_-]?34a?|phase[_-]?33a?|test|ci|disposable)/iu.test(database)) {
    throw new Error(
      "Refusing a PostgreSQL database whose name does not contain phase34a, test, ci, or disposable.",
    );
  }
  return { ready: true as const, url, database };
}

const prerequisite = inspectPhase34aPostgresUrl(process.env.BEA_PHASE34A_REAL_POSTGRES_URL);
if (!prerequisite.ready && process.env.BEA_PHASE34A_REQUIRE_REAL_POSTGRES === "true") {
  throw new Error(
    "CI Phase 3.4A PostgreSQL proofs cannot be skipped. Set BEA_PHASE34A_REAL_POSTGRES_URL to a disposable test database.",
  );
}
const describePostgres = prerequisite.ready ? describe.sequential : describe.sequential.skip;

function aborted(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /current transaction is aborted|25P02/iu.test(message);
}

describePostgres("Phase 3.4A real PostgreSQL guided story", () => {
  let database: PgDatabaseAdapter;
  let leftDb: PgDatabaseAdapter;
  let rightDb: PgDatabaseAdapter;
  let pipeline: InspectionReportPipeline;
  let commercial: CommercialWorkflowService;
  let leads: SqlLeadRepository;

  beforeAll(async () => {
    if (!prerequisite.ready) return;
    database = new PgDatabaseAdapter({
      connectionString: prerequisite.url,
      max: 4,
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
    expect(migrated.applied.at(-1) ?? migrated.alreadyApplied.at(-1)).toBe(LATEST_MIGRATION);
    await expect(verifyMigrations(database)).resolves.toMatchObject({ current: LATEST_MIGRATION });
    await seedDatabase(database);
    await seedDatabase(database);
    pipeline = createInspectionReportPipeline(database, "demo", { processInline: true });
    commercial = new CommercialWorkflowService(database, { processInline: true });
    commercial.bindWorkControl(pipeline.workControl!);
    leads = new SqlLeadRepository(database);
  }, 120_000);

  afterAll(async () => {
    await database?.close();
    await leftDb?.close();
    await rightDb?.close();
  });

  function serviceFor(adapter: PgDatabaseAdapter) {
    const ops = createInspectionReportPipeline(adapter, "demo", { processInline: true });
    const commerce = new CommercialWorkflowService(adapter, { processInline: true });
    commerce.bindWorkControl(ops.workControl!);
    return new GuidedMeridianService(adapter, new SqlLeadRepository(adapter), commerce, ops, {
      appMode: "demo",
    });
  }

  it("applies additive migration 0024 after 0023 without rewriting earlier history", async () => {
    const applied = await database.query<{ id: string }>(
      "SELECT id FROM bea_schema_migrations ORDER BY id",
    );
    expect(
      applied.rows.some(
        (row) => row.id === "0023_phase33a_commercial_integrity_and_override_cycles.sql",
      ),
    ).toBe(true);
    expect(applied.rows.at(-1)?.id).toBe(LATEST_MIGRATION);
  });

  it("creates one active run when two independent connections race start", async () => {
    const left = serviceFor(leftDb);
    const right = serviceFor(rightDb);
    await left.execute({
      action: "reset",
      actorUserId: OWNER,
      correlationId: "reset-left",
      skipDelay: true,
    });
    const [a, b] = await Promise.allSettled([
      left.execute({
        action: "start",
        actorUserId: OWNER,
        correlationId: "start-left",
        skipDelay: true,
      }),
      right.execute({
        action: "start",
        actorUserId: OWNER,
        correlationId: "start-right",
        skipDelay: true,
      }),
    ]);
    expect(a.status === "rejected" ? aborted(a.reason) : false).toBe(false);
    expect(b.status === "rejected" ? aborted(b.reason) : false).toBe(false);
    const fulfilled = [a, b].filter((item) => item.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    const ids = new Set(
      fulfilled.map((item) => (item.status === "fulfilled" ? item.value.id : "")),
    );
    expect(ids.size).toBe(1);
    const active = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM guided_demo_runs WHERE status <> 'archived' AND archived_at IS NULL`,
    );
    expect(Number(active.rows[0]?.count)).toBe(1);
  });

  it("keeps concurrent run-to-next-decision from skipping the roof gate", async () => {
    const left = serviceFor(leftDb);
    const right = serviceFor(rightDb);
    await left.execute({
      action: "reset",
      actorUserId: OWNER,
      correlationId: "gate-reset",
      skipDelay: true,
    });
    await left.execute({
      action: "start",
      actorUserId: OWNER,
      correlationId: "gate-start",
      skipDelay: true,
    });
    const [a, b] = await Promise.allSettled([
      left.execute({
        action: "run_to_next_decision",
        actorUserId: OWNER,
        correlationId: "gate-left",
        skipDelay: true,
      }),
      right.execute({
        action: "run_to_next_decision",
        actorUserId: OWNER,
        correlationId: "gate-right",
        skipDelay: true,
      }),
    ]);
    const states = [a, b]
      .filter(
        (
          item,
        ): item is PromiseFulfilledResult<Awaited<ReturnType<GuidedMeridianService["execute"]>>> =>
          item.status === "fulfilled",
      )
      .map((item) => item.value.machineState);
    expect(states.every((state) => state === "waiting_roof_authorization")).toBe(true);
    expect(states.some((state) => state === "waiting_proposal_approval")).toBe(false);
  });

  it("records one effective roof decision under duplicate idempotency keys", async () => {
    const service = serviceFor(database);
    await service.execute({
      action: "reset",
      actorUserId: OWNER,
      correlationId: "dec-reset",
      skipDelay: true,
    });
    const started = await service.execute({
      action: "start",
      actorUserId: OWNER,
      correlationId: "dec-start",
      skipDelay: true,
    });
    const key = `${started.id}:roof`;
    const first = await service.execute({
      action: "submit_human_decision",
      actorUserId: OWNER,
      correlationId: "dec-1",
      decisionKey: "add_simulated_authorization",
      idempotencyKey: key,
      skipDelay: true,
    });
    const second = await service.execute({
      action: "submit_human_decision",
      actorUserId: OWNER,
      correlationId: "dec-2",
      decisionKey: "add_simulated_authorization",
      idempotencyKey: key,
      skipDelay: true,
    });
    expect(second.recordBindings.proposalId).toBe(first.recordBindings.proposalId);
    const decisions = await database.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM guided_demo_decisions WHERE demo_run_id=$1 AND idempotency_key=$2",
      [started.id, key],
    );
    expect(Number(decisions.rows[0]?.count)).toBe(1);
  });

  it("keeps event sequence unique and ordered after reset archives the prior run", async () => {
    const service = serviceFor(database);
    const prior = await service.execute({
      action: "start",
      actorUserId: OWNER,
      correlationId: "arch-start",
      skipDelay: true,
    });
    const reset = await service.execute({
      action: "reset",
      actorUserId: OWNER,
      correlationId: "arch-reset",
      skipDelay: true,
    });
    expect(reset.id).not.toBe(prior.id);
    const archived = await database.query<{ status: string }>(
      "SELECT status FROM guided_demo_runs WHERE id=$1",
      [prior.id],
    );
    expect(archived.rows[0]?.status).toBe("archived");
    const sequences = await database.query<{ sequence_number: number }>(
      "SELECT sequence_number FROM guided_demo_events WHERE demo_run_id=$1 ORDER BY sequence_number",
      [reset.id],
    );
    const values = sequences.rows.map((row) => Number(row.sequence_number));
    expect(values).toEqual([...new Set(values)].sort((left, right) => left - right));
    expect(GuidedDemoConcurrencyError).toBeDefined();
    expect(commercial).toBeDefined();
    expect(leads).toBeDefined();
  });

  async function reachDeliveryGate(service: GuidedMeridianService) {
    await service.execute({
      action: "reset",
      actorUserId: OWNER,
      correlationId: `pg-reset-${Date.now()}`,
      skipDelay: true,
    });
    await service.execute({
      action: "run_to_next_decision",
      actorUserId: OWNER,
      correlationId: "pg-roof",
      skipDelay: true,
    });
    await service.execute({
      action: "submit_human_decision",
      actorUserId: OWNER,
      correlationId: "pg-auth",
      decisionKey: "add_simulated_authorization",
      skipDelay: true,
    });
    await service.execute({
      action: "approve_proposal",
      actorUserId: OWNER,
      correlationId: "pg-proposal",
      skipDelay: true,
    });
    return service.execute({
      action: "approve_technical_content",
      actorUserId: OPERATIONS,
      correlationId: "pg-tech",
      skipDelay: true,
    });
  }

  it("creates exactly one new Report version for concurrent Owner delivery-change requests", async () => {
    const left = serviceFor(leftDb);
    const right = serviceFor(rightDb);
    const gate = await reachDeliveryGate(left);
    expect(gate.machineState).toBe("waiting_delivery_authorization");
    const before = await pipeline.repository.listReportVersions(gate.recordBindings.reportId!);
    const [a, b] = await Promise.allSettled([
      left.execute({
        action: "request_delivery_changes",
        actorUserId: OWNER,
        correlationId: "pg-change-left",
        comments: "Clarify the recommended repair priority before release.",
        expectedVersion: gate.optimisticVersion,
        skipDelay: true,
      }),
      right.execute({
        action: "request_delivery_changes",
        actorUserId: OWNER,
        correlationId: "pg-change-right",
        comments: "Clarify the recommended repair priority before release.",
        expectedVersion: gate.optimisticVersion,
        skipDelay: true,
      }),
    ]);
    expect(a.status === "rejected" ? aborted(a.reason) : false).toBe(false);
    expect(b.status === "rejected" ? aborted(b.reason) : false).toBe(false);
    const fulfilled = [a, b].filter((item) => item.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    const rejected = [a, b].filter((item) => item.status === "rejected");
    expect(rejected).toHaveLength(1);
    const after = await pipeline.repository.listReportVersions(gate.recordBindings.reportId!);
    expect(after.length).toBe(before.length + 1);
    const winner = fulfilled[0];
    expect(winner && winner.status === "fulfilled" ? winner.value.machineState : "").toBe(
      "waiting_technical_review",
    );
    const report = await pipeline.repository.getReport(gate.recordBindings.reportId!);
    expect(report?.status).toBe("in_review");
  });

  it("rejects stale and Operations delivery-change requests before mutation", async () => {
    const service = serviceFor(database);
    const gate = await reachDeliveryGate(service);
    const before = await pipeline.repository.listReportVersions(gate.recordBindings.reportId!);
    await expect(
      service.execute({
        action: "request_delivery_changes",
        actorUserId: OWNER,
        correlationId: "pg-stale",
        comments: "Stale browser",
        expectedVersion: gate.optimisticVersion - 1,
        skipDelay: true,
      }),
    ).rejects.toBeInstanceOf(GuidedDemoConcurrencyError);
    await expect(
      service.execute({
        action: "request_delivery_changes",
        actorUserId: OPERATIONS,
        correlationId: "pg-ops",
        comments: "Ops mutation",
        expectedVersion: gate.optimisticVersion,
        skipDelay: true,
      }),
    ).rejects.toBeInstanceOf(GuidedDemoAuthorizationError);
    const after = await pipeline.repository.listReportVersions(gate.recordBindings.reportId!);
    expect(after).toHaveLength(before.length);
    const report = await pipeline.repository.getReport(gate.recordBindings.reportId!);
    expect(report?.status).toBe("ready_for_delivery");
  });

  it("serializes Request Delivery Changes against Authorize Delivery to one winner", async () => {
    const left = serviceFor(leftDb);
    const right = serviceFor(rightDb);
    const gate = await reachDeliveryGate(left);
    const [change, authorize] = await Promise.allSettled([
      left.execute({
        action: "request_delivery_changes",
        actorUserId: OWNER,
        correlationId: "pg-race-change",
        comments: "Clarify the recommended repair priority before release.",
        expectedVersion: gate.optimisticVersion,
        skipDelay: true,
      }),
      right.execute({
        action: "authorize_demo_delivery",
        actorUserId: OWNER,
        correlationId: "pg-race-auth",
        expectedVersion: gate.optimisticVersion,
        skipDelay: true,
      }),
    ]);
    expect(change.status === "rejected" ? aborted(change.reason) : false).toBe(false);
    expect(authorize.status === "rejected" ? aborted(authorize.reason) : false).toBe(false);
    const winners = [change, authorize].filter((item) => item.status === "fulfilled");
    expect(winners).toHaveLength(1);
    const report = await pipeline.repository.getReport(gate.recordBindings.reportId!);
    const deliveries = await pipeline.repository.listDeliveries(gate.recordBindings.reportId!);
    const delivered = deliveries.filter((item) => item.status === "delivered");
    if (change.status === "fulfilled") {
      expect(change.value.machineState).toBe("waiting_technical_review");
      expect(report?.status).toBe("in_review");
      expect(delivered).toHaveLength(0);
    } else {
      expect(authorize.status).toBe("fulfilled");
      expect(report?.status).toBe("delivered");
      expect(delivered).toHaveLength(1);
    }
    const workspace = await loadGuidedMeridianReportView({
      repository: pipeline.repository,
      bindings:
        change.status === "fulfilled"
          ? change.value.recordBindings
          : authorize.status === "fulfilled"
            ? authorize.value.recordBindings
            : gate.recordBindings,
      machineState:
        change.status === "fulfilled"
          ? change.value.machineState
          : authorize.status === "fulfilled"
            ? authorize.value.machineState
            : gate.machineState,
    });
    expect(workspace.view?.versionId).toBeTruthy();
    expect(workspace.error).toBeNull();
  });
});
