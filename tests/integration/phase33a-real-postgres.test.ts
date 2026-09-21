import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CommercialConcurrencyError,
  DEMO_PERSONAS,
  ProposalAuthorizationError,
  SEEDED_COMMERCIAL_IDS,
} from "../../packages/domain/src/index.js";
import {
  CommercialWorkflowService,
  PgDatabaseAdapter,
  SYSTEM_SEED_ID,
  WorkControlPlane,
  migrateDatabase,
  seedDatabase,
  verifyMigrations,
} from "../../packages/database/src/index.js";

const OWNER = DEMO_PERSONAS[0].id;
const SALES = DEMO_PERSONAS[1].id;
const READY_LEAD = "a1000000-0000-4000-8000-000000000003";
const MOISTURE_LEAD = "a1000000-0000-4000-8000-000000000005";
const MIGRATION_0023 = "0023_phase33a_commercial_integrity_and_override_cycles.sql";
const MIGRATION_0025 = "0025_cpl_tenant_foundation.sql";
const COMPANY_ID = "90000000-0000-4000-8000-000000000001";
const CONTACT_ID = "91000000-0000-4000-8000-000000000001";

function inspectPhase33aPostgresUrl(value: string | undefined) {
  const url = value?.trim() ?? "";
  if (!url) {
    return { ready: false as const, detail: "BEA_PHASE33A_REAL_POSTGRES_URL is not set." };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("BEA_PHASE33A_REAL_POSTGRES_URL is invalid.");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("BEA_PHASE33A_REAL_POSTGRES_URL must be a PostgreSQL URL.");
  }
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (
    !/(?:phase[_-]?33a?|phase[_-]?32a?|phase[_-]?31a?|phase[_-]?30|test|ci|disposable)/iu.test(
      database,
    )
  ) {
    throw new Error(
      "Refusing a PostgreSQL database whose name does not contain phase33a, test, ci, or disposable.",
    );
  }
  return { ready: true as const, url, database };
}

const prerequisite = inspectPhase33aPostgresUrl(process.env.BEA_PHASE33A_REAL_POSTGRES_URL);
if (!prerequisite.ready && process.env.BEA_PHASE33A_REQUIRE_REAL_POSTGRES === "true") {
  throw new Error(
    "CI Phase 3.3A PostgreSQL proofs cannot be skipped. Set BEA_PHASE33A_REAL_POSTGRES_URL to a disposable test database.",
  );
}
const describePostgres = prerequisite.ready ? describe.sequential : describe.sequential.skip;

function aborted(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /current transaction is aborted|25P02/iu.test(message);
}

async function insertReadyLead(
  adapter: PgDatabaseAdapter,
  leadId: string,
  input: { readonly opportunityName: string; readonly requestSummary: string },
): Promise<void> {
  const now = new Date().toISOString();
  await adapter.query(
    `INSERT INTO leads
     (id,reference,source_type,source_details,received_at,opportunity_name,request_summary,requested_service,
      site_name,site_city,site_region,site_country,desired_deadline_at,requested_visit_at,reviewer_user_id,
      status,disqualification_reason,created_by_user_id,created_at,updated_at,version)
     VALUES ($1,$2,'manual','SYNTHETIC postgres integrity lead.',
             $3,$4,$5,'SYNTHETIC envelope advisory',
             'Concurrent annex','Example City','EX','US',$3,$3,$6,
             'ready_for_proposal',NULL,$7,$3,$3,1)`,
    [
      leadId,
      `BEA-LD-PG-${leadId.slice(0, 8)}`,
      now,
      input.opportunityName,
      input.requestSummary,
      SALES,
      OWNER,
    ],
  );
  await adapter.query(
    `INSERT INTO lead_parties
     (id,lead_id,role,company_id,contact_id,unmatched_company_name,unmatched_contact_name,unmatched_email,unmatched_phone,notes,created_by_user_id,created_at,updated_at,version)
     VALUES ($1,$2,'client_company',$3,NULL,NULL,NULL,NULL,NULL,'SYNTHETIC concurrent party.',$4,$5,$5,1)`,
    [randomUUID(), leadId, COMPANY_ID, OWNER, now],
  );
  await adapter.query(
    `INSERT INTO lead_parties
     (id,lead_id,role,company_id,contact_id,unmatched_company_name,unmatched_contact_name,unmatched_email,unmatched_phone,notes,created_by_user_id,created_at,updated_at,version)
     VALUES ($1,$2,'primary_contact',$3,$4,NULL,'Casey Concurrent',NULL,NULL,'SYNTHETIC concurrent party.',$5,$6,$6,1)`,
    [randomUUID(), leadId, COMPANY_ID, CONTACT_ID, OWNER, now],
  );
}

async function draftAndSubmit(
  service: CommercialWorkflowService,
  leadId: string,
): Promise<{
  readonly proposalId: string;
  readonly versionId: string;
  readonly expectedVersion: number;
}> {
  const created = await service.createProposalFromLead({
    actorUserId: SALES,
    leadId,
    correlationId: randomUUID(),
  });
  const drafted = await service.updateDraft({
    actorUserId: SALES,
    proposalId: created.record.proposal.id,
    expectedVersion: created.record.proposal.version,
    correlationId: randomUUID(),
    scopeText: "SYNTHETIC postgres integrity scope.",
    deliverables: ["SYNTHETIC"],
    assumptions: ["SYNTHETIC"],
    exclusions: ["Live Microsoft 365"],
    scheduleText: "SYNTHETIC",
    lines: [{ serviceKey: "syn-env-fixed-advisory", quantityScaled: 10_000 }],
  });
  const submitted = await service.submitForReview({
    actorUserId: SALES,
    proposalId: drafted.proposal.id,
    expectedVersion: drafted.proposal.version,
    correlationId: randomUUID(),
  });
  const versionId = submitted.versions.find(
    (item) => item.versionNumber === submitted.proposal.currentVersionNumber,
  )!.id;
  return {
    proposalId: submitted.proposal.id,
    versionId,
    expectedVersion: submitted.proposal.version,
  };
}

async function assertHealthy(adapter: PgDatabaseAdapter) {
  const result = await adapter.query<{ ok: number | string }>("SELECT 1 AS ok");
  expect(Number(result.rows[0]?.ok)).toBe(1);
}

describePostgres("Phase 3.3A real PostgreSQL commercial concurrency", () => {
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
    expect(migrated.applied.at(-1) ?? migrated.alreadyApplied.at(-1)).toBe(MIGRATION_0025);
    await expect(verifyMigrations(database)).resolves.toMatchObject({ current: MIGRATION_0025 });
    await seedDatabase(database);
  }, 120_000);

  afterAll(async () => {
    await database?.close();
    await leftDb?.close();
    await rightDb?.close();
  });

  it("applies additive migration 0023 after 0022 without rewriting earlier history", async () => {
    const applied = await database.query<{ id: string }>(
      "SELECT id FROM bea_schema_migrations ORDER BY id",
    );
    expect(
      applied.rows.some((row) => row.id === "0022_phase33a_service_catalog_and_proposals.sql"),
    ).toBe(true);
    expect(applied.rows.some((row) => row.id === MIGRATION_0023)).toBe(true);
    expect(applied.rows.at(-1)?.id).toBe(MIGRATION_0025);
    expect(SYSTEM_SEED_ID).toBe("phase3.3a-system-v1");
  });

  it("creates one effective initial proposal when two independent connections race the same ready lead", async () => {
    const first = new CommercialWorkflowService(leftDb);
    const second = new CommercialWorkflowService(rightDb);
    const [a, b] = await Promise.allSettled([
      first.createProposalFromLead({
        actorUserId: SALES,
        leadId: READY_LEAD,
        correlationId: randomUUID(),
      }),
      second.createProposalFromLead({
        actorUserId: OWNER,
        leadId: READY_LEAD,
        correlationId: randomUUID(),
      }),
    ]);
    expect(a.status === "rejected" && aborted(a.reason)).toBe(false);
    expect(b.status === "rejected" && aborted(b.reason)).toBe(false);
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("fulfilled");
    if (a.status === "fulfilled" && b.status === "fulfilled") {
      expect(a.value.record.proposal.id).toBe(b.value.record.proposal.id);
      expect([a.value.alreadyExisted, b.value.alreadyExisted].filter(Boolean).length).toBe(1);
    }
    const rows = await database.query<{ id: string }>(
      "SELECT id FROM proposals WHERE lead_id = $1 AND status NOT IN ('cancelled','superseded')",
      [READY_LEAD],
    );
    expect(rows.rows).toHaveLength(1);
    await assertHealthy(leftDb);
    await assertHealthy(rightDb);
  }, 60_000);

  it("assigns one next version number when two independent connections race freeze", async () => {
    const first = new CommercialWorkflowService(leftDb);
    const second = new CommercialWorkflowService(rightDb);
    const created = await first.createProposalFromLead({
      actorUserId: SALES,
      leadId: MOISTURE_LEAD,
      catalogVersionId: SEEDED_COMMERCIAL_IDS.moistureVersion1,
      correlationId: randomUUID(),
    });
    const drafted = await first.updateDraft({
      actorUserId: SALES,
      proposalId: created.record.proposal.id,
      expectedVersion: created.record.proposal.version,
      correlationId: randomUUID(),
      scopeText: "SYNTHETIC concurrent freeze scope.",
      deliverables: ["SYNTHETIC concurrent freeze"],
      assumptions: ["SYNTHETIC"],
      exclusions: ["Live Microsoft 365"],
      scheduleText: "SYNTHETIC schedule",
      lines: [{ serviceKey: "syn-moi-probe-unit", quantityScaled: 10_000 }],
    });
    const [a, b] = await Promise.allSettled([
      first.submitForReview({
        actorUserId: SALES,
        proposalId: drafted.proposal.id,
        expectedVersion: drafted.proposal.version,
        correlationId: randomUUID(),
      }),
      second.submitForReview({
        actorUserId: OWNER,
        proposalId: drafted.proposal.id,
        expectedVersion: drafted.proposal.version,
        correlationId: randomUUID(),
      }),
    ]);
    expect(a.status === "rejected" && aborted(a.reason)).toBe(false);
    expect(b.status === "rejected" && aborted(b.reason)).toBe(false);
    const successes = [a, b].filter((result) => result.status === "fulfilled");
    expect(successes).toHaveLength(1);
    const failures = [a, b].filter((result) => result.status === "rejected");
    expect(failures).toHaveLength(1);
    if (failures[0]?.status === "rejected") {
      expect(failures[0].reason).toBeInstanceOf(CommercialConcurrencyError);
    }
    const versions = await database.query<{ version_number: number }>(
      "SELECT version_number FROM proposal_versions WHERE proposal_id = $1 ORDER BY version_number",
      [created.record.proposal.id],
    );
    const numbers = versions.rows.map((row) => row.version_number);
    expect(new Set(numbers).size).toBe(numbers.length);
    await assertHealthy(leftDb);
    await assertHealthy(rightDb);
  }, 60_000);

  it("keeps concurrent approval of the same version idempotent or controlled", async () => {
    const first = new CommercialWorkflowService(leftDb);
    const second = new CommercialWorkflowService(rightDb);
    const leadId = randomUUID();
    const now = new Date().toISOString();
    await database.query(
      `INSERT INTO leads
       (id,reference,source_type,source_details,received_at,opportunity_name,request_summary,requested_service,
        site_name,site_city,site_region,site_country,desired_deadline_at,requested_visit_at,reviewer_user_id,
        status,disqualification_reason,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,$2,'manual','SYNTHETIC concurrent approval lead.',
               $3,'SYNTHETIC Concurrent Approval','SYNTHETIC concurrent approval','SYNTHETIC envelope advisory',
               'Concurrent annex','Example City','EX','US',$3,$3,$4,
               'ready_for_proposal',NULL,$5,$3,$3,1)`,
      [leadId, `BEA-LD-PG-${leadId.slice(0, 8)}`, now, SALES, OWNER],
    );
    await database.query(
      `INSERT INTO lead_parties
       (id,lead_id,role,company_id,contact_id,unmatched_company_name,unmatched_contact_name,unmatched_email,unmatched_phone,notes,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,$2,'client_company',$3,NULL,NULL,NULL,NULL,NULL,'SYNTHETIC concurrent party.',$4,$5,$5,1)`,
      [randomUUID(), leadId, COMPANY_ID, OWNER, now],
    );
    await database.query(
      `INSERT INTO lead_parties
       (id,lead_id,role,company_id,contact_id,unmatched_company_name,unmatched_contact_name,unmatched_email,unmatched_phone,notes,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,$2,'primary_contact',$3,$4,NULL,'Casey Concurrent',NULL,NULL,'SYNTHETIC concurrent party.',$5,$6,$6,1)`,
      [randomUUID(), leadId, COMPANY_ID, CONTACT_ID, OWNER, now],
    );
    const created = await first.createProposalFromLead({
      actorUserId: SALES,
      leadId,
      correlationId: randomUUID(),
    });
    const drafted = await first.updateDraft({
      actorUserId: SALES,
      proposalId: created.record.proposal.id,
      expectedVersion: created.record.proposal.version,
      correlationId: randomUUID(),
      scopeText: "SYNTHETIC concurrent approval scope.",
      deliverables: ["SYNTHETIC"],
      assumptions: ["SYNTHETIC"],
      exclusions: ["Live Microsoft 365"],
      scheduleText: "SYNTHETIC",
      lines: [{ serviceKey: "syn-env-fixed-advisory", quantityScaled: 10_000 }],
    });
    const submitted = await first.submitForReview({
      actorUserId: SALES,
      proposalId: drafted.proposal.id,
      expectedVersion: drafted.proposal.version,
      correlationId: randomUUID(),
    });
    const versionId = submitted.versions.find((item) => item.versionNumber === 1)!.id;
    const [a, b] = await Promise.allSettled([
      first.reviewProposal({
        actorUserId: OWNER,
        proposalId: submitted.proposal.id,
        expectedVersion: submitted.proposal.version,
        proposalVersionId: versionId,
        decision: "approve",
        correlationId: randomUUID(),
      }),
      second.reviewProposal({
        actorUserId: OWNER,
        proposalId: submitted.proposal.id,
        expectedVersion: submitted.proposal.version,
        proposalVersionId: versionId,
        decision: "approve",
        correlationId: randomUUID(),
      }),
    ]);
    expect(a.status === "rejected" && aborted(a.reason)).toBe(false);
    expect(b.status === "rejected" && aborted(b.reason)).toBe(false);
    const successes = [a, b].filter((result) => result.status === "fulfilled");
    expect(successes).toHaveLength(1);
    const failures = [a, b].filter((result) => result.status === "rejected");
    expect(failures).toHaveLength(1);
    const events = await database.query<{ event_type: string }>(
      "SELECT event_type FROM proposal_status_events WHERE proposal_id = $1 AND to_status = 'approved'",
      [created.record.proposal.id],
    );
    expect(events.rows).toHaveLength(1);
    const reviews = await database.query<{ id: string }>(
      "SELECT id FROM proposal_reviews WHERE proposal_id = $1 AND decision = 'approve'",
      [created.record.proposal.id],
    );
    expect(reviews.rows).toHaveLength(1);
    await assertHealthy(leftDb);
    await assertHealthy(rightDb);
  }, 60_000);

  it("keeps one active catalog version per service context", async () => {
    const first = new CommercialWorkflowService(leftDb);
    const second = new CommercialWorkflowService(rightDb);
    const cloneA = await first.cloneCatalogDraft({
      actorUserId: OWNER,
      catalogVersionId: SEEDED_COMMERCIAL_IDS.envelopeVersion1,
      correlationId: randomUUID(),
    });
    const cloneB = await first.cloneCatalogDraft({
      actorUserId: OWNER,
      catalogVersionId: SEEDED_COMMERCIAL_IDS.envelopeVersion1,
      correlationId: randomUUID(),
    });
    await first.validateCatalog({
      actorUserId: OWNER,
      catalogVersionId: cloneA.id,
      correlationId: randomUUID(),
    });
    await first.validateCatalog({
      actorUserId: OWNER,
      catalogVersionId: cloneB.id,
      correlationId: randomUUID(),
    });
    await first.publishCatalog({
      actorUserId: OWNER,
      catalogVersionId: cloneA.id,
      correlationId: randomUUID(),
    });
    await first.publishCatalog({
      actorUserId: OWNER,
      catalogVersionId: cloneB.id,
      correlationId: randomUUID(),
    });
    const [a, b] = await Promise.allSettled([
      first.activateCatalog({
        actorUserId: OWNER,
        catalogVersionId: cloneA.id,
        correlationId: randomUUID(),
      }),
      second.activateCatalog({
        actorUserId: OWNER,
        catalogVersionId: cloneB.id,
        correlationId: randomUUID(),
      }),
    ]);
    expect(a.status === "rejected" && aborted(a.reason)).toBe(false);
    expect(b.status === "rejected" && aborted(b.reason)).toBe(false);
    const successes = [a, b].filter((result) => result.status === "fulfilled");
    expect(successes.length === 1 || successes.length === 2).toBe(true);
    const active = await database.query<{ id: string }>(
      "SELECT id FROM service_catalog_versions WHERE catalog_id = $1 AND status = 'active'",
      [SEEDED_COMMERCIAL_IDS.envelopeCatalog],
    );
    expect(active.rows).toHaveLength(1);
    await assertHealthy(leftDb);
    await assertHealthy(rightDb);
  }, 60_000);

  it("replays commercial work events without duplicate queue rows", async () => {
    const work = new WorkControlPlane({ database });
    await work.processPendingEvents();
    await work.processPendingEvents();
    const duplicates = await database.query<{ cycle_identity: string; count: string }>(
      `SELECT cycle_identity, COUNT(*)::text AS count
       FROM operational_work_items
       GROUP BY cycle_identity
       HAVING COUNT(*) > 1`,
    );
    expect(duplicates.rows).toEqual([]);
    await assertHealthy(database);
  }, 60_000);

  it("assigns distinct catalog version numbers when independent connections clone concurrently", async () => {
    const first = new CommercialWorkflowService(leftDb);
    const second = new CommercialWorkflowService(rightDb);
    const [a, b] = await Promise.allSettled([
      first.cloneCatalogDraft({
        actorUserId: OWNER,
        catalogVersionId: SEEDED_COMMERCIAL_IDS.envelopeVersion1,
        correlationId: randomUUID(),
      }),
      second.cloneCatalogDraft({
        actorUserId: OWNER,
        catalogVersionId: SEEDED_COMMERCIAL_IDS.envelopeVersion1,
        correlationId: randomUUID(),
      }),
    ]);
    expect(a.status === "rejected" && aborted(a.reason)).toBe(false);
    expect(b.status === "rejected" && aborted(b.reason)).toBe(false);
    const successes = [a, b].filter((result) => result.status === "fulfilled");
    expect(successes.length === 1 || successes.length === 2).toBe(true);
    if (successes.length === 1 && [a, b].some((result) => result.status === "rejected")) {
      const failure = [a, b].find((result) => result.status === "rejected");
      if (failure?.status === "rejected") {
        expect(failure.reason).toBeInstanceOf(CommercialConcurrencyError);
      }
    }
    if (a.status === "fulfilled" && b.status === "fulfilled") {
      expect(a.value.versionNumber).not.toBe(b.value.versionNumber);
      expect(a.value.id).not.toBe(b.value.id);
    }
    await assertHealthy(leftDb);
    await assertHealthy(rightDb);
  }, 60_000);

  it("keeps one terminal override decision when independent connections race decideOverride", async () => {
    const first = new CommercialWorkflowService(leftDb);
    const second = new CommercialWorkflowService(rightDb);
    const leadId = randomUUID();
    await insertReadyLead(database, leadId, {
      opportunityName: "SYNTHETIC Concurrent Override",
      requestSummary: "SYNTHETIC concurrent override",
    });
    const created = await first.createProposalFromLead({
      actorUserId: SALES,
      leadId,
      correlationId: randomUUID(),
    });
    const drafted = await first.updateDraft({
      actorUserId: SALES,
      proposalId: created.record.proposal.id,
      expectedVersion: created.record.proposal.version,
      correlationId: randomUUID(),
      scopeText: "SYNTHETIC concurrent override scope.",
      deliverables: ["SYNTHETIC"],
      assumptions: ["SYNTHETIC"],
      exclusions: ["Live Microsoft 365"],
      scheduleText: "SYNTHETIC",
      lines: [{ serviceKey: "syn-env-fixed-advisory", quantityScaled: 10_000 }],
    });
    const requested = await first.requestOverride({
      actorUserId: SALES,
      proposalId: drafted.proposal.id,
      expectedVersion: drafted.proposal.version,
      correlationId: randomUUID(),
      lineKey: drafted.lines[0]!.lineKey,
      proposedAmountMinor: 4000,
      reason: "SYNTHETIC concurrent override reason.",
    });
    const catalogAmount = drafted.lines[0]!.catalogUnitAmountMinor;
    const overrideId = requested.overrides[0]!.id;
    const [a, b] = await Promise.allSettled([
      first.decideOverride({
        actorUserId: OWNER,
        proposalId: requested.proposal.id,
        overrideId,
        expectedVersion: requested.proposal.version,
        correlationId: randomUUID(),
        approve: true,
      }),
      second.decideOverride({
        actorUserId: OWNER,
        proposalId: requested.proposal.id,
        overrideId,
        expectedVersion: requested.proposal.version,
        correlationId: randomUUID(),
        approve: false,
      }),
    ]);
    expect(a.status === "rejected" && aborted(a.reason)).toBe(false);
    expect(b.status === "rejected" && aborted(b.reason)).toBe(false);
    const successes = [a, b].filter((result) => result.status === "fulfilled");
    expect(successes).toHaveLength(1);
    const failures = [a, b].filter((result) => result.status === "rejected");
    expect(failures).toHaveLength(1);
    const override = await database.query<{ status: string }>(
      "SELECT status FROM proposal_pricing_overrides WHERE id=$1",
      [overrideId],
    );
    expect(["approved", "rejected"]).toContain(override.rows[0]?.status);
    const proposal = await database.query<{ total_minor: string | number }>(
      "SELECT total_minor FROM proposals WHERE id=$1",
      [requested.proposal.id],
    );
    expect(Number(proposal.rows[0]?.total_minor)).toBe(
      override.rows[0]?.status === "approved" ? 4000 : catalogAmount,
    );
    await assertHealthy(leftDb);
    await assertHealthy(rightDb);
  }, 60_000);

  it("rejects Sales and keeps one Owner terminal override when independent connections race decideOverride", async () => {
    const first = new CommercialWorkflowService(leftDb);
    const second = new CommercialWorkflowService(rightDb);
    const work = new WorkControlPlane({ database });
    const leadId = randomUUID();
    await insertReadyLead(database, leadId, {
      opportunityName: "SYNTHETIC Auth Concurrent Override",
      requestSummary: "SYNTHETIC auth concurrent override",
    });
    const created = await first.createProposalFromLead({
      actorUserId: SALES,
      leadId,
      correlationId: randomUUID(),
    });
    const drafted = await first.updateDraft({
      actorUserId: SALES,
      proposalId: created.record.proposal.id,
      expectedVersion: created.record.proposal.version,
      correlationId: randomUUID(),
      scopeText: "SYNTHETIC auth concurrent override scope.",
      deliverables: ["SYNTHETIC"],
      assumptions: ["SYNTHETIC"],
      exclusions: ["Live Microsoft 365"],
      scheduleText: "SYNTHETIC",
      lines: [{ serviceKey: "syn-env-fixed-advisory", quantityScaled: 10_000 }],
    });
    const requested = await first.requestOverride({
      actorUserId: SALES,
      proposalId: drafted.proposal.id,
      expectedVersion: drafted.proposal.version,
      correlationId: randomUUID(),
      lineKey: drafted.lines[0]!.lineKey,
      proposedAmountMinor: 4000,
      reason: "SYNTHETIC auth concurrent override reason.",
    });
    await work.processPendingEvents();
    const overrideId = requested.overrides[0]!.id;
    const [salesResult, ownerResult] = await Promise.allSettled([
      first.decideOverride({
        actorUserId: SALES,
        proposalId: requested.proposal.id,
        overrideId,
        expectedVersion: requested.proposal.version,
        correlationId: randomUUID(),
        approve: true,
      }),
      second.decideOverride({
        actorUserId: OWNER,
        proposalId: requested.proposal.id,
        overrideId,
        expectedVersion: requested.proposal.version,
        correlationId: randomUUID(),
        approve: true,
      }),
    ]);
    expect(salesResult.status).toBe("rejected");
    if (salesResult.status === "rejected") {
      expect(salesResult.reason).toBeInstanceOf(ProposalAuthorizationError);
      expect(aborted(salesResult.reason)).toBe(false);
    }
    expect(ownerResult.status).toBe("fulfilled");
    if (ownerResult.status === "rejected") {
      expect(aborted(ownerResult.reason)).toBe(false);
    }
    await work.processPendingEvents();
    const override = await database.query<{
      status: string;
      approved_by_user_id: string | null;
    }>(
      "SELECT status, approved_by_user_id::text AS approved_by_user_id FROM proposal_pricing_overrides WHERE id=$1",
      [overrideId],
    );
    expect(override.rows).toHaveLength(1);
    expect(override.rows[0]?.status).toBe("approved");
    expect(override.rows[0]?.approved_by_user_id).toBe(OWNER);
    const proposal = await database.query<{ total_minor: string | number }>(
      "SELECT total_minor FROM proposals WHERE id=$1",
      [requested.proposal.id],
    );
    expect(Number(proposal.rows[0]?.total_minor)).toBe(4000);
    const events = await database.query<{ event_type: string }>(
      `SELECT event_type FROM automation_events
        WHERE aggregate_id=$1
          AND event_type IN ('proposal.pricing_override_approved','proposal.pricing_override_rejected')
          AND payload->>'overrideId'=$2
        ORDER BY occurred_at, recorded_at, id`,
      [requested.proposal.id, overrideId],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      "proposal.pricing_override_approved",
    ]);
    const workItems = await database.query<{ status: string }>(
      `SELECT status FROM operational_work_items
        WHERE proposal_id=$1 AND work_item_kind='proposal_pricing_override'
        ORDER BY created_at, id`,
      [requested.proposal.id],
    );
    expect(workItems.rows).toHaveLength(1);
    expect(workItems.rows[0]?.status).toBe("completed");
    await assertHealthy(leftDb);
    await assertHealthy(rightDb);
  }, 60_000);

  it("keeps two eligible Owner approve attempts to one terminal override result", async () => {
    const first = new CommercialWorkflowService(leftDb);
    const second = new CommercialWorkflowService(rightDb);
    const work = new WorkControlPlane({ database });
    const leadId = randomUUID();
    await insertReadyLead(database, leadId, {
      opportunityName: "SYNTHETIC Owner Idempotent Override",
      requestSummary: "SYNTHETIC owner idempotent override",
    });
    const created = await first.createProposalFromLead({
      actorUserId: SALES,
      leadId,
      correlationId: randomUUID(),
    });
    const drafted = await first.updateDraft({
      actorUserId: SALES,
      proposalId: created.record.proposal.id,
      expectedVersion: created.record.proposal.version,
      correlationId: randomUUID(),
      scopeText: "SYNTHETIC owner idempotent override scope.",
      deliverables: ["SYNTHETIC"],
      assumptions: ["SYNTHETIC"],
      exclusions: ["Live Microsoft 365"],
      scheduleText: "SYNTHETIC",
      lines: [{ serviceKey: "syn-env-fixed-advisory", quantityScaled: 10_000 }],
    });
    const requested = await first.requestOverride({
      actorUserId: SALES,
      proposalId: drafted.proposal.id,
      expectedVersion: drafted.proposal.version,
      correlationId: randomUUID(),
      lineKey: drafted.lines[0]!.lineKey,
      proposedAmountMinor: 4000,
      reason: "SYNTHETIC owner idempotent override reason.",
    });
    await work.processPendingEvents();
    const overrideId = requested.overrides[0]!.id;
    const [a, b] = await Promise.allSettled([
      first.decideOverride({
        actorUserId: OWNER,
        proposalId: requested.proposal.id,
        overrideId,
        expectedVersion: requested.proposal.version,
        correlationId: randomUUID(),
        approve: true,
      }),
      second.decideOverride({
        actorUserId: OWNER,
        proposalId: requested.proposal.id,
        overrideId,
        expectedVersion: requested.proposal.version,
        correlationId: randomUUID(),
        approve: true,
      }),
    ]);
    expect(a.status === "rejected" && aborted(a.reason)).toBe(false);
    expect(b.status === "rejected" && aborted(b.reason)).toBe(false);
    const successes = [a, b].filter((result) => result.status === "fulfilled");
    const failures = [a, b].filter((result) => result.status === "rejected");
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    if (failures[0]?.status === "rejected") {
      expect(failures[0].reason).toBeInstanceOf(CommercialConcurrencyError);
    }
    await work.processPendingEvents();
    const override = await database.query<{ status: string }>(
      "SELECT status FROM proposal_pricing_overrides WHERE id=$1",
      [overrideId],
    );
    expect(override.rows).toHaveLength(1);
    expect(override.rows[0]?.status).toBe("approved");
    const events = await database.query<{ event_type: string }>(
      `SELECT event_type FROM automation_events
        WHERE aggregate_id=$1
          AND event_type IN ('proposal.pricing_override_approved','proposal.pricing_override_rejected')
          AND payload->>'overrideId'=$2
        ORDER BY occurred_at, recorded_at, id`,
      [requested.proposal.id, overrideId],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      "proposal.pricing_override_approved",
    ]);
    const contradictory = await database.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM proposal_pricing_overrides
        WHERE id=$1 AND status IN ('approved','rejected')`,
      [overrideId],
    );
    expect(Number(contradictory.rows[0]?.n)).toBe(1);
    const workItems = await database.query<{ status: string }>(
      `SELECT status FROM operational_work_items
        WHERE proposal_id=$1 AND work_item_kind='proposal_pricing_override'
        ORDER BY created_at, id`,
      [requested.proposal.id],
    );
    expect(workItems.rows).toHaveLength(1);
    expect(workItems.rows[0]?.status).toBe("completed");
    const proposal = await database.query<{ total_minor: string | number }>(
      "SELECT total_minor FROM proposals WHERE id=$1",
      [requested.proposal.id],
    );
    expect(Number(proposal.rows[0]?.total_minor)).toBe(4000);
    await assertHealthy(leftDb);
    await assertHealthy(rightDb);
  }, 60_000);

  it("creates one delivery manifest and one ready-for-delivery transition under concurrent callers", async () => {
    const first = new CommercialWorkflowService(leftDb);
    const second = new CommercialWorkflowService(rightDb);
    const work = new WorkControlPlane({ database });
    const leadId = randomUUID();
    await insertReadyLead(database, leadId, {
      opportunityName: "SYNTHETIC Concurrent Manifest",
      requestSummary: "SYNTHETIC concurrent manifest",
    });
    const submitted = await draftAndSubmit(first, leadId);
    await first.reviewProposal({
      actorUserId: OWNER,
      proposalId: submitted.proposalId,
      expectedVersion: submitted.expectedVersion,
      proposalVersionId: submitted.versionId,
      decision: "approve",
      correlationId: randomUUID(),
    });
    const approved = await first.repository.getProposal(submitted.proposalId);
    const [a, b] = await Promise.allSettled([
      first.generateDeliveryManifest({
        actorUserId: SALES,
        proposalId: submitted.proposalId,
        expectedVersion: approved!.proposal.version,
        proposalVersionId: submitted.versionId,
        correlationId: randomUUID(),
      }),
      second.generateDeliveryManifest({
        actorUserId: OWNER,
        proposalId: submitted.proposalId,
        expectedVersion: approved!.proposal.version,
        proposalVersionId: submitted.versionId,
        correlationId: randomUUID(),
      }),
    ]);
    expect(a.status === "rejected" && aborted(a.reason)).toBe(false);
    expect(b.status === "rejected" && aborted(b.reason)).toBe(false);
    const successes = [a, b].filter((result) => result.status === "fulfilled");
    expect(successes).toHaveLength(1);
    const failures = [a, b].filter((result) => result.status === "rejected");
    expect(failures).toHaveLength(1);
    const manifests = await database.query<{ id: string }>(
      "SELECT id FROM proposal_delivery_manifests WHERE proposal_id=$1",
      [submitted.proposalId],
    );
    expect(manifests.rows).toHaveLength(1);
    const ready = await database.query<{ event_type: string }>(
      "SELECT event_type FROM proposal_status_events WHERE proposal_id=$1 AND to_status='ready_for_delivery'",
      [submitted.proposalId],
    );
    expect(ready.rows).toHaveLength(1);
    await work.processPendingEvents();
    const deliveryWork = await database.query<{ id: string }>(
      `SELECT id FROM operational_work_items
        WHERE proposal_id=$1 AND work_item_kind='proposal_delivery_preparation'`,
      [submitted.proposalId],
    );
    expect(deliveryWork.rows).toHaveLength(1);
    await assertHealthy(leftDb);
    await assertHealthy(rightDb);
  }, 60_000);

  it("captures a coherent lead snapshot under concurrent lead edit and proposal creation", async () => {
    const first = new CommercialWorkflowService(leftDb);
    const leadId = randomUUID();
    const oldName = "SYNTHETIC OLD-COHERENT";
    const oldSummary = "SYNTHETIC old coherent summary";
    const newName = "SYNTHETIC NEW-COHERENT";
    const newSummary = "SYNTHETIC new coherent summary";
    await insertReadyLead(database, leadId, {
      opportunityName: oldName,
      requestSummary: oldSummary,
    });
    const update = leftDb.transaction(async (transaction) => {
      await transaction.query("SELECT id FROM leads WHERE id=$1 FOR UPDATE", [leadId]);
      await transaction.query(
        "UPDATE leads SET opportunity_name=$2, request_summary=$3, updated_at=$4, version=version+1 WHERE id=$1",
        [leadId, newName, newSummary, new Date().toISOString()],
      );
    });
    const create = first.createProposalFromLead({
      actorUserId: SALES,
      leadId,
      correlationId: randomUUID(),
    });
    const [updated, created] = await Promise.allSettled([update, create]);
    expect(updated.status === "rejected" && aborted(updated.reason)).toBe(false);
    expect(created.status === "rejected" && aborted(created.reason)).toBe(false);
    if (created.status === "fulfilled") {
      const snapshot = created.value.record.proposal.leadSnapshot;
      const coherentOld =
        snapshot?.opportunityName === oldName && snapshot.requestSummary === oldSummary;
      const coherentNew =
        snapshot?.opportunityName === newName && snapshot.requestSummary === newSummary;
      expect(coherentOld || coherentNew).toBe(true);
    }
    await assertHealthy(leftDb);
    await assertHealthy(rightDb);
  }, 60_000);

  it("enforces effective override uniqueness per proposal, target version, and line", async () => {
    const first = new CommercialWorkflowService(leftDb);
    const leadId = randomUUID();
    await insertReadyLead(database, leadId, {
      opportunityName: "SYNTHETIC Override Uniqueness",
      requestSummary: "SYNTHETIC override uniqueness",
    });
    const created = await first.createProposalFromLead({
      actorUserId: SALES,
      leadId,
      correlationId: randomUUID(),
    });
    const drafted = await first.updateDraft({
      actorUserId: SALES,
      proposalId: created.record.proposal.id,
      expectedVersion: created.record.proposal.version,
      correlationId: randomUUID(),
      scopeText: "SYNTHETIC uniqueness scope.",
      deliverables: ["SYNTHETIC"],
      assumptions: ["SYNTHETIC"],
      exclusions: ["Live Microsoft 365"],
      scheduleText: "SYNTHETIC",
      lines: [{ serviceKey: "syn-env-fixed-advisory", quantityScaled: 10_000 }],
    });
    const requested = await first.requestOverride({
      actorUserId: SALES,
      proposalId: drafted.proposal.id,
      expectedVersion: drafted.proposal.version,
      correlationId: randomUUID(),
      lineKey: drafted.lines[0]!.lineKey,
      proposedAmountMinor: 5000,
      reason: "SYNTHETIC uniqueness reason.",
    });
    await expect(
      first.requestOverride({
        actorUserId: SALES,
        proposalId: requested.proposal.id,
        expectedVersion: requested.proposal.version,
        correlationId: randomUUID(),
        lineKey: drafted.lines[0]!.lineKey,
        proposedAmountMinor: 6000,
        reason: "SYNTHETIC duplicate uniqueness reason.",
      }),
    ).rejects.toBeInstanceOf(CommercialConcurrencyError);
    await assertHealthy(leftDb);
  }, 60_000);

  it("does not duplicate information-cycle work under concurrent event processing", async () => {
    const workLeft = new WorkControlPlane({ database: leftDb });
    const workRight = new WorkControlPlane({ database: rightDb });
    const [a, b] = await Promise.allSettled([
      workLeft.processPendingEvents(),
      workRight.processPendingEvents(),
    ]);
    expect(a.status === "rejected" && aborted(a.reason)).toBe(false);
    expect(b.status === "rejected" && aborted(b.reason)).toBe(false);
    const duplicates = await database.query<{ cycle_identity: string; count: string }>(
      `SELECT cycle_identity, COUNT(*)::text AS count
         FROM operational_work_items
        WHERE work_item_kind = 'proposal_information'
        GROUP BY cycle_identity
       HAVING COUNT(*) > 1`,
    );
    expect(duplicates.rows).toEqual([]);
    await assertHealthy(leftDb);
    await assertHealthy(rightDb);
  }, 60_000);
});
