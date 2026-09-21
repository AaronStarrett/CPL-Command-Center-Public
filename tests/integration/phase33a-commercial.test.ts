import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ScriptedDeliveryAdapter } from "../../packages/automation/src/index.js";
import {
  COMMERCIAL_PRODUCTION_UNCONFIGURED,
  COMMERCIAL_SYNTHETIC_DISCLOSURE,
  CommercialCatalogValidationError,
  CommercialValidationError,
  DEMO_PERSONAS,
  PROPOSAL_EMAIL_DRY_RUN_DISCLOSURE,
  ProductionCatalogNotConfiguredError,
  ProposalAuthorizationError,
  SEEDED_COMMERCIAL_IDS,
  SYNTHETIC_ENVELOPE_CATALOG,
  isProposalStatus,
  isSalesCommercialWorkKind,
  jsonClone,
  type ServiceCatalogPackage,
} from "../../packages/domain/src/index.js";
import {
  CommercialWorkflowService,
  PGliteDatabaseAdapter,
  createInspectionReportPipeline,
  migrateDatabase,
  seedDatabase,
  type InspectionReportPipeline,
} from "../../packages/database/src/index.js";

const OWNER = DEMO_PERSONAS[0].id;
const SALES = DEMO_PERSONAS[1].id;
const OPERATIONS = DEMO_PERSONAS[2].id;
const EXECUTIVE = DEMO_PERSONAS[3].id;
const INTEGRATION = DEMO_PERSONAS[4].id;
const OWNER_ROLE_ID = "20000000-0000-4000-8000-000000000001";
const COMPANY_ID = "90000000-0000-4000-8000-000000000001";
const CONTACT_ID = "91000000-0000-4000-8000-000000000001";
const OVERRIDE_DECISION_EVENTS = [
  "proposal.pricing_override_approved",
  "proposal.pricing_override_rejected",
] as const;
const READY_LEAD = "a1000000-0000-4000-8000-000000000003";
const UNREADY_LEAD = "a1000000-0000-4000-8000-000000000001";
const MOISTURE_LEAD = "a1000000-0000-4000-8000-000000000005";

function createClock(start: string) {
  let current = new Date(start);
  return {
    now: () => new Date(current.getTime()),
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
}

let database: PGliteDatabaseAdapter;
let pipeline: InspectionReportPipeline;
let commercial: CommercialWorkflowService;
const clock = createClock("2026-09-02T12:00:00.000Z");

async function completeDraft(
  proposalId: string,
  expectedVersion: number,
  extra: { readonly serviceKey?: string; readonly catalogVersionId?: string } = {},
) {
  const serviceKey = extra.serviceKey ?? "syn-env-fixed-advisory";
  return commercial.updateDraft({
    proposalId,
    actorUserId: SALES,
    correlationId: `draft-${proposalId}`,
    expectedVersion,
    scopeText: "Synthetic laboratory scope of services for Phase 3.3A demonstration.",
    deliverables: ["Synthetic advisory summary"],
    assumptions: ["Access is available during the scheduled synthetic window."],
    exclusions: ["Destructive testing", "Repair design"],
    lines: [{ serviceKey, quantityScaled: 10_000 }],
  });
}

async function insertAuthorizationLead(label: string): Promise<string> {
  const leadId = randomUUID();
  const now = clock.now().toISOString();
  await database.query(
    `INSERT INTO leads
     (id,reference,source_type,source_details,received_at,opportunity_name,request_summary,requested_service,
      site_name,site_city,site_region,site_country,desired_deadline_at,requested_visit_at,reviewer_user_id,
      status,disqualification_reason,created_by_user_id,created_at,updated_at,version)
     VALUES ($1,$2,'manual','Synthetic override-authorization lead.',
             $3,$4,$5,'Synthetic envelope advisory','Auth annex','Example City','EX','US',$3,$3,$6,
             'ready_for_proposal',NULL,$7,$3,$3,1)`,
    [
      leadId,
      `BEA-LD-AUTH-${leadId.slice(0, 8)}`,
      now,
      `Synthetic ${label} override authorization`,
      `Lab-only ${label} override authorization.`,
      SALES,
      OWNER,
    ],
  );
  await database.query(
    `INSERT INTO lead_parties
     (id,lead_id,role,company_id,contact_id,unmatched_company_name,unmatched_contact_name,unmatched_email,unmatched_phone,notes,created_by_user_id,created_at,updated_at,version)
     VALUES ($1,$2,'client_company',$3,NULL,NULL,NULL,NULL,NULL,'Synthetic authorization party.',$4,$5,$5,1)`,
    [randomUUID(), leadId, COMPANY_ID, OWNER, now],
  );
  await database.query(
    `INSERT INTO lead_parties
     (id,lead_id,role,company_id,contact_id,unmatched_company_name,unmatched_contact_name,unmatched_email,unmatched_phone,notes,created_by_user_id,created_at,updated_at,version)
     VALUES ($1,$2,'primary_contact',$3,$4,NULL,'Authorization Contact',NULL,NULL,'Synthetic authorization party.',$5,$6,$6,1)`,
    [randomUUID(), leadId, COMPANY_ID, CONTACT_ID, OWNER, now],
  );
  return leadId;
}

async function createRequestedOverride(label: string, proposedAmountMinor = 5000) {
  const leadId = await insertAuthorizationLead(label);
  const created = await commercial.createProposalFromLead({
    leadId,
    actorUserId: SALES,
    correlationId: `${label}-create`,
  });
  const drafted = await completeDraft(created.record.proposal.id, created.record.proposal.version);
  const requested = await commercial.requestOverride({
    proposalId: drafted.proposal.id,
    actorUserId: SALES,
    correlationId: `${label}-request`,
    expectedVersion: drafted.proposal.version,
    lineKey: drafted.lines[0]!.lineKey,
    proposedAmountMinor,
    reason: `Synthetic ${label} override authorization.`,
  });
  return {
    catalogAmount: drafted.lines[0]!.catalogUnitAmountMinor,
    overrideId: requested.overrides[0]!.id,
    proposalId: requested.proposal.id,
    requested,
  };
}

async function captureOverrideInvariants(proposalId: string, overrideId: string) {
  const record = await commercial.repository.getProposal(proposalId);
  const proposal = record!.proposal;
  const line = record!.lines[0]!;
  const override = record!.overrides.find((item) => item.id === overrideId)!;
  const work = await pipeline.workControl!.repository.listWorkItems({
    proposalId,
    kinds: ["proposal_pricing_override"],
    limit: 20,
  });
  const statusEvents = await commercial.repository.listStatusEvents(proposalId);
  const audit = await commercial.repository.listAudit(proposalId);
  const events = await database.query<{ event_type: string }>(
    `SELECT event_type FROM automation_events
      WHERE aggregate_id=$1
        AND event_type IN ('proposal.pricing_override_approved','proposal.pricing_override_rejected')
      ORDER BY occurred_at, recorded_at, id`,
    [proposalId],
  );
  const activities = await database.query<{ type: string }>(
    `SELECT type FROM activities
      WHERE proposal_id=$1
        AND type IN ('proposal.pricing_override_approved','proposal.pricing_override_rejected')
      ORDER BY created_at, id`,
    [proposalId],
  );
  return {
    activities: activities.rows.map((row) => row.type),
    approvedAt: override.approvedAt,
    approvedBy: override.approvedByUserId,
    auditDecisionCount: audit.filter((row) =>
      OVERRIDE_DECISION_EVENTS.includes(
        String(row.event_type) as (typeof OVERRIDE_DECISION_EVENTS)[number],
      ),
    ).length,
    automationEvents: events.rows.map((row) => row.event_type),
    lineAmount: line.unitAmountMinor,
    lineOverrideId: line.overrideId,
    overrideStatus: override.status,
    overrideVersion: override.version,
    overrideWorkStatuses: work.map((item) => item.status),
    status: proposal.status,
    statusEventCount: statusEvents.length,
    subtotalMinor: proposal.subtotalMinor,
    totalMinor: proposal.totalMinor,
    updatedAt: proposal.updatedAt,
    version: proposal.version,
  };
}

async function expectAuthorizationDenied(actorUserId: string, label: string) {
  const prepared = await createRequestedOverride(label);
  const before = await captureOverrideInvariants(prepared.proposalId, prepared.overrideId);
  await expect(
    commercial.decideOverride({
      proposalId: prepared.proposalId,
      overrideId: prepared.overrideId,
      actorUserId,
      correlationId: `${label}-decide`,
      expectedVersion: prepared.requested.proposal.version,
      approve: true,
    }),
  ).rejects.toBeInstanceOf(ProposalAuthorizationError);
  const after = await captureOverrideInvariants(prepared.proposalId, prepared.overrideId);
  expect(after).toEqual(before);
  expect(after.overrideStatus).toBe("requested");
  expect(after.approvedBy).toBeNull();
  expect(after.approvedAt).toBeNull();
  expect(after.automationEvents).toEqual([]);
  expect(after.activities).toEqual([]);
  expect(after.auditDecisionCount).toBe(0);
  expect(after.overrideWorkStatuses).toHaveLength(1);
  expect(after.overrideWorkStatuses[0]).not.toBe("completed");
  return after;
}

beforeAll(async () => {
  expect(process.env.OPENAI_API_KEY ?? "").toBe("");
  expect(process.env.MICROSOFT_GRAPH_CLIENT_SECRET ?? "").toBe("");
  database = new PGliteDatabaseAdapter("memory://");
  const migrated = await migrateDatabase(database);
  expect(migrated.applied.at(-1)).toBe("0025_cpl_tenant_foundation.sql");
  await seedDatabase(database);
  pipeline = createInspectionReportPipeline(database, "demo", {
    processInline: true,
    deliveryAdapter: new ScriptedDeliveryAdapter(0),
    now: () => clock.now(),
  });
  commercial = new CommercialWorkflowService(database, {
    processInline: true,
    now: () => clock.now(),
  });
  commercial.bindWorkControl(pipeline.workControl!);
  await pipeline.workControl!.processPendingEvents();
}, 60_000);

afterAll(async () => {
  await database?.close();
});

describe("Phase 3.3A commercial workflow", () => {
  it("blocks proposal creation from an unready lead", async () => {
    await expect(
      commercial.createProposalFromLead({
        leadId: UNREADY_LEAD,
        actorUserId: SALES,
        correlationId: "unready",
      }),
    ).rejects.toBeInstanceOf(CommercialValidationError);
  });

  it("creates a proposal from a ready lead, snapshots parties, and opens information work", async () => {
    const created = await commercial.createProposalFromLead({
      leadId: READY_LEAD,
      actorUserId: SALES,
      correlationId: "create-ready",
    });
    expect(created.alreadyExisted).toBe(false);
    expect(created.record.proposal.reference).toMatch(/^BEA-PP-/u);
    expect(created.record.proposal.leadSnapshot?.leadReference).toBe("BEA-LD-000003");
    expect(
      created.record.proposal.leadSnapshot?.parties.some(
        (party) => party.role === "client_company",
      ),
    ).toBe(true);
    expect(created.record.proposal.status).toBe("needs_information");
    const inspected = await commercial.inspectProposal(created.record.proposal.id);
    expect(inspected.readiness.readyForReview).toBe(false);
    expect(inspected.readiness.blocking.map((item) => item.code)).toEqual(
      expect.arrayContaining(["missing_service_line", "missing_scope"]),
    );
    const work = await pipeline.workControl!.repository.listWorkItems({
      proposalId: created.record.proposal.id,
      limit: 20,
    });
    expect(work.some((item) => item.workItemKind === "proposal_information")).toBe(true);
    const prep = await pipeline.workControl!.repository.listWorkItems({
      leadId: READY_LEAD,
      limit: 20,
    });
    const prepItem = prep.find((item) => item.workItemKind === "proposal_preparation");
    expect(prepItem?.status).toBe("completed");
  });

  it("is idempotent for a second create on the same ready lead", async () => {
    const first = await commercial.repository.getProposalByLead(READY_LEAD);
    const second = await commercial.createProposalFromLead({
      leadId: READY_LEAD,
      actorUserId: SALES,
      correlationId: "create-ready-again",
    });
    expect(second.alreadyExisted).toBe(true);
    expect(second.record.proposal.id).toBe(first?.id);
  });

  it("submits version 1, refuses Sales self-approval, and lets Owner approve the exact version", async () => {
    const proposal = await commercial.repository.getProposalByLead(READY_LEAD);
    expect(proposal).toBeTruthy();
    const drafted = await completeDraft(proposal!.id, proposal!.version);
    expect(drafted.proposal.status).toBe("ready_for_review");
    const submitted = await commercial.submitForReview({
      proposalId: drafted.proposal.id,
      actorUserId: SALES,
      correlationId: "submit-v1",
      expectedVersion: drafted.proposal.version,
    });
    expect(submitted.proposal.status).toBe("in_review");
    expect(submitted.proposal.currentVersionNumber).toBe(1);
    const version = submitted.versions.find((item) => item.versionNumber === 1);
    expect(version?.status).toBe("frozen_review");
    expect(version?.totalMinor).toBe(11100);
    await expect(
      commercial.reviewProposal({
        proposalId: submitted.proposal.id,
        actorUserId: SALES,
        correlationId: "sales-approve",
        expectedVersion: submitted.proposal.version,
        proposalVersionId: version!.id,
        decision: "approve",
      }),
    ).rejects.toBeInstanceOf(ProposalAuthorizationError);
    const approved = await commercial.reviewProposal({
      proposalId: submitted.proposal.id,
      actorUserId: OWNER,
      correlationId: "owner-approve-v1",
      expectedVersion: submitted.proposal.version,
      proposalVersionId: version!.id,
      decision: "approve",
    });
    expect(approved.proposal.status).toBe("approved");
    expect(approved.versions.find((item) => item.versionNumber === 1)?.status).toBe("approved");
    const reviewWork = await pipeline.workControl!.repository.listWorkItems({
      proposalId: approved.proposal.id,
      limit: 50,
    });
    expect(reviewWork.find((item) => item.workItemKind === "proposal_review")?.status).toBe(
      "completed",
    );
  });

  it("generates a no-write delivery dry-run without sending a message", async () => {
    const proposal = (await commercial.repository.getProposalByLead(READY_LEAD))!;
    const record = await commercial.repository.getProposal(proposal.id);
    const version = record!.versions.find((item) => item.versionNumber === 1)!;
    const delivered = await commercial.generateDeliveryManifest({
      proposalId: proposal.id,
      actorUserId: OWNER,
      correlationId: "delivery-v1",
      expectedVersion: record!.proposal.version,
      proposalVersionId: version.id,
    });
    expect(delivered.proposal.status).toBe("ready_for_delivery");
    expect(delivered.manifests).toHaveLength(1);
    expect(delivered.manifests[0]?.liveWrites).toBe(false);
    expect(delivered.manifests[0]?.disclosure).toBe(PROPOSAL_EMAIL_DRY_RUN_DISCLOSURE);
    expect(delivered.manifests[0]?.toRecipient).toMatch(/\.invalid$/u);
    const again = await commercial.generateDeliveryManifest({
      proposalId: proposal.id,
      actorUserId: OWNER,
      correlationId: "delivery-v1-again",
      expectedVersion: delivered.proposal.version,
      proposalVersionId: version.id,
    });
    expect(again.manifests).toHaveLength(1);
  });

  it("creates version 2 on revision and does not carry v1 approval forward", async () => {
    const created = await commercial.createProposalFromLead({
      leadId: MOISTURE_LEAD,
      actorUserId: SALES,
      correlationId: "moisture-create",
      catalogVersionId: SEEDED_COMMERCIAL_IDS.moistureVersion1,
    });
    const drafted = await completeDraft(
      created.record.proposal.id,
      created.record.proposal.version,
      {
        serviceKey: "syn-moi-probe-unit",
      },
    );
    const submitted = await commercial.submitForReview({
      proposalId: drafted.proposal.id,
      actorUserId: SALES,
      correlationId: "moisture-submit-v1",
      expectedVersion: drafted.proposal.version,
    });
    const v1 = submitted.versions.find((item) => item.versionNumber === 1)!;
    const revised = await commercial.reviewProposal({
      proposalId: submitted.proposal.id,
      actorUserId: OWNER,
      correlationId: "moisture-revise",
      expectedVersion: submitted.proposal.version,
      proposalVersionId: v1.id,
      decision: "request_revision",
      comments: "Please expand the synthetic exclusions.",
      requestedSections: ["exclusions"],
    });
    expect(revised.proposal.status).toBe("revision_required");
    expect(revised.versions.find((item) => item.id === v1.id)?.status).toBe("revision_required");
    const corrected = await commercial.updateDraft({
      proposalId: revised.proposal.id,
      actorUserId: SALES,
      correlationId: "moisture-edit-v2",
      expectedVersion: revised.proposal.version,
      scopeText: "Revised synthetic moisture investigation scope.",
      exclusions: ["Repair design", "Permit applications", "Live sampling"],
      lines: [{ serviceKey: "syn-moi-probe-unit", quantityScaled: 20_000 }],
    });
    const submittedV2 = await commercial.submitForReview({
      proposalId: corrected.proposal.id,
      actorUserId: SALES,
      correlationId: "moisture-submit-v2",
      expectedVersion: corrected.proposal.version,
    });
    expect(submittedV2.proposal.currentVersionNumber).toBe(2);
    const frozenV1 = submittedV2.versions.find((item) => item.versionNumber === 1)!;
    const frozenV2 = submittedV2.versions.find((item) => item.versionNumber === 2)!;
    expect(frozenV1.status).toBe("superseded");
    expect(frozenV1.scopeText).toContain("laboratory scope");
    await expect(
      commercial.reviewProposal({
        proposalId: submittedV2.proposal.id,
        actorUserId: OWNER,
        correlationId: "old-approval",
        expectedVersion: submittedV2.proposal.version,
        proposalVersionId: frozenV1.id,
        decision: "approve",
      }),
    ).rejects.toThrow(/exact current reviewed version/u);
    const approved = await commercial.reviewProposal({
      proposalId: submittedV2.proposal.id,
      actorUserId: OWNER,
      correlationId: "moisture-approve-v2",
      expectedVersion: submittedV2.proposal.version,
      proposalVersionId: frozenV2.id,
      decision: "approve",
    });
    expect(approved.proposal.status).toBe("approved");
    expect(approved.proposal.currentVersionNumber).toBe(2);
  });

  it("blocks commercial approval until a pricing override is decided and freezes the approved amount", async () => {
    const leadId = "a1000000-0000-4000-8000-000000000006";
    const now = clock.now().toISOString();
    await database.query(
      `INSERT INTO leads
       (id,reference,source_type,source_details,received_at,opportunity_name,request_summary,requested_service,
        site_name,site_city,site_region,site_country,desired_deadline_at,requested_visit_at,reviewer_user_id,
        status,disqualification_reason,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,'BEA-LD-000006','manual','Synthetic override demonstration lead.',
               $2,'Synthetic override lab','Lab-only override path.','Synthetic envelope advisory','Override annex','Example City','EX','US',$2,$2,$3,
               'ready_for_proposal',NULL,$4,$2,$2,1)`,
      [leadId, now, SALES, OWNER],
    );
    await database.query(
      `INSERT INTO lead_parties
       (id,lead_id,role,company_id,contact_id,unmatched_company_name,unmatched_contact_name,unmatched_email,unmatched_phone,notes,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,$2,'client_company',$3,NULL,NULL,NULL,NULL,NULL,'Synthetic override party.',$4,$5,$5,1)`,
      [
        "a1100000-0000-4000-8000-000000000061",
        leadId,
        "90000000-0000-4000-8000-000000000001",
        OWNER,
        now,
      ],
    );
    await database.query(
      `INSERT INTO lead_parties
       (id,lead_id,role,company_id,contact_id,unmatched_company_name,unmatched_contact_name,unmatched_email,unmatched_phone,notes,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,$2,'primary_contact',$3,$4,NULL,'Override Contact',NULL,NULL,'Synthetic override party.',$5,$6,$6,1)`,
      [
        "a1100000-0000-4000-8000-000000000062",
        leadId,
        "90000000-0000-4000-8000-000000000001",
        "91000000-0000-4000-8000-000000000001",
        OWNER,
        now,
      ],
    );
    const created = await commercial.createProposalFromLead({
      leadId,
      actorUserId: SALES,
      correlationId: "override-create",
    });
    const drafted = await completeDraft(
      created.record.proposal.id,
      created.record.proposal.version,
    );
    const overridden = await commercial.requestOverride({
      proposalId: drafted.proposal.id,
      actorUserId: SALES,
      correlationId: "override-request",
      expectedVersion: drafted.proposal.version,
      lineKey: "syn-env-fixed-advisory",
      proposedAmountMinor: 5000,
      reason: "Synthetic laboratory courtesy adjustment.",
    });
    expect(overridden.overrides[0]?.originalAmountMinor).toBe(11100);
    expect(overridden.overrides[0]?.proposedAmountMinor).toBe(5000);
    await expect(
      commercial.submitForReview({
        proposalId: overridden.proposal.id,
        actorUserId: SALES,
        correlationId: "override-submit-blocked",
        expectedVersion: overridden.proposal.version,
      }),
    ).rejects.toBeInstanceOf(CommercialValidationError);
    const decided = await commercial.decideOverride({
      proposalId: overridden.proposal.id,
      overrideId: overridden.overrides[0]!.id,
      actorUserId: OWNER,
      correlationId: "override-approve",
      expectedVersion: overridden.proposal.version,
      approve: true,
    });
    const submitted = await commercial.submitForReview({
      proposalId: decided.proposal.id,
      actorUserId: SALES,
      correlationId: "override-submit",
      expectedVersion: decided.proposal.version,
    });
    const frozen = submitted.versions.find((item) => item.versionNumber === 1);
    expect(frozen?.pricingSnapshot.lines[0]?.unitAmountMinor).toBe(5000);
    expect(frozen?.pricingSnapshot.lines[0]?.catalogUnitAmountMinor).toBe(11100);
    expect(frozen?.totalMinor).toBe(5000);
  });

  it("keeps historical proposal totals when a later catalog version activates", async () => {
    const existing = await commercial.repository.getProposalByLead(READY_LEAD);
    const before = existing!.totalMinor;
    const catalogVersionId = existing!.catalogVersionId;
    const cloned = await commercial.cloneCatalogDraft({
      catalogVersionId: SEEDED_COMMERCIAL_IDS.envelopeVersion1,
      actorUserId: OWNER,
      correlationId: "clone-v2",
    });
    const clonedPack = jsonClone(SYNTHETIC_ENVELOPE_CATALOG);
    const pack = {
      ...clonedPack,
      items: clonedPack.items.map((item) =>
        item.serviceKey === "syn-env-fixed-advisory" ? { ...item, defaultRateMinor: 22200 } : item,
      ),
    };
    const updated = await commercial.updateCatalogDraft({
      catalogVersionId: cloned.id,
      actorUserId: OWNER,
      correlationId: "update-v2",
      pack,
    });
    const validated = await commercial.validateCatalog({
      catalogVersionId: updated.id,
      actorUserId: OWNER,
      correlationId: "validate-v2",
    });
    const published = await commercial.publishCatalog({
      catalogVersionId: validated.id,
      actorUserId: OWNER,
      correlationId: "publish-v2",
    });
    await commercial.activateCatalog({
      catalogVersionId: published.id,
      actorUserId: OWNER,
      correlationId: "activate-v2",
    });
    const pinned = await commercial.repository.getProposal(existing!.id);
    expect(pinned?.proposal.catalogVersionId).toBe(catalogVersionId);
    expect(pinned?.proposal.totalMinor).toBe(before);
    const preview = await commercial.previewDocument({
      proposalId: existing!.id,
      proposalVersionId: pinned!.versions[0]?.id,
    });
    expect(
      preview.document.nodes.some(
        (node) =>
          JSON.stringify(node).includes("111.00") ||
          JSON.stringify(node).includes("11100") ||
          JSON.stringify(node).includes("USD 111"),
      ),
    ).toBe(true);
  });

  it("produces different documents from envelope versus moisture catalogs", async () => {
    const envelope = await commercial.repository.getProposalByLead(READY_LEAD);
    const moisture = await commercial.repository.getProposalByLead(MOISTURE_LEAD);
    const envelopeDoc = await commercial.previewDocument({
      proposalId: envelope!.id,
      proposalVersionId: (await commercial.repository.getProposal(envelope!.id))?.versions[0]?.id,
    });
    const moistureRecord = await commercial.repository.getProposal(moisture!.id);
    const moistureDoc = await commercial.previewDocument({
      proposalId: moisture!.id,
      proposalVersionId: moistureRecord?.versions.find((item) => item.versionNumber === 2)?.id,
    });
    expect(envelopeDoc.document.templateKey).toBe("synthetic-proposal-letter");
    expect(moistureDoc.document.templateKey).toBe("synthetic-proposal-sectioned");
    expect(envelopeDoc.document.nodes[0]).not.toEqual(moistureDoc.document.nodes[0]);
    expect(envelopeDoc.previewKind).toBe("approved");
  });

  it("blocks production catalog activation and stays credential-free", async () => {
    await expect(
      commercial.activateCatalog({
        catalogVersionId: SEEDED_COMMERCIAL_IDS.productionDraft,
        actorUserId: OWNER,
        correlationId: "activate-production",
      }),
    ).rejects.toBeInstanceOf(ProductionCatalogNotConfiguredError);
    expect(COMMERCIAL_PRODUCTION_UNCONFIGURED).toMatch(/UNCONFIGURED/u);
    expect(COMMERCIAL_SYNTHETIC_DISCLOSURE).toMatch(/SYNTHETIC/u);
    expect(process.env.OPENAI_API_KEY ?? "").toBe("");
  });

  it("replays proposal events without duplicating work items", async () => {
    const proposal = await commercial.repository.getProposalByLead(READY_LEAD);
    const before = await pipeline.workControl!.repository.listWorkItems({
      proposalId: proposal!.id,
      limit: 50,
    });
    await pipeline.workControl!.processPendingEvents();
    await pipeline.workControl!.processPendingEvents();
    const after = await pipeline.workControl!.repository.listWorkItems({
      proposalId: proposal!.id,
      limit: 50,
    });
    expect(after).toHaveLength(before.length);
  });

  it("keeps one frozen/approved/preview/manifest checksum", async () => {
    const proposal = (await commercial.repository.getProposalByLead(READY_LEAD))!;
    const record = (await commercial.repository.getProposal(proposal.id))!;
    const version = record.versions.find((item) => item.versionNumber === 1)!;
    expect(version.renderedChecksum).toBeTruthy();
    expect(version.fileName).toBeTruthy();
    const evidence = version.approvalEvidence as { checksum?: string } | null;
    expect(evidence?.checksum).toBe(version.renderedChecksum);
    const preview = await commercial.previewDocument({
      proposalId: proposal.id,
      proposalVersionId: version.id,
    });
    expect(preview.previewKind).toBe("approved");
    expect(preview.document.previewKind).toBe("frozen_review");
    expect(preview.pdf.checksumSha256).toBe(version.renderedChecksum);
    expect(record.manifests[0]?.attachmentChecksum).toBe(version.renderedChecksum);
    expect(record.manifests[0]?.attachmentFileName).toBe(version.fileName);
  });

  it("records actual proposal status transitions rather than event names", async () => {
    const proposal = (await commercial.repository.getProposalByLead(READY_LEAD))!;
    const events = await commercial.repository.listStatusEvents(proposal.id);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(isProposalStatus(event.to_status)).toBe(true);
      if (event.from_status !== null) expect(isProposalStatus(event.from_status)).toBe(true);
      expect(isProposalStatus(event.event_type)).toBe(false);
    }
    expect(events.map((event) => `${event.from_status ?? "null"}->${event.to_status}`)).toEqual(
      expect.arrayContaining([
        "null->needs_information",
        "needs_information->ready_for_review",
        "ready_for_review->in_review",
        "in_review->approved",
        "approved->ready_for_delivery",
      ]),
    );
  });

  it("fails closed on malformed catalog packages and package mutation after validation", async () => {
    const cloned = await commercial.cloneCatalogDraft({
      catalogVersionId: SEEDED_COMMERCIAL_IDS.moistureVersion1,
      actorUserId: OWNER,
      correlationId: "integrity-clone",
    });
    const clonedPack = cloned.packagePayload as ServiceCatalogPackage;
    await expect(
      commercial.updateCatalogDraft({
        catalogVersionId: cloned.id,
        actorUserId: OWNER,
        correlationId: "integrity-bad-pack",
        pack: { ...clonedPack, items: [] },
      }),
    ).rejects.toBeInstanceOf(CommercialCatalogValidationError);
    const current = await commercial.repository.getCatalogVersion(cloned.id);
    expect(current?.status).toBe("draft");
    const updated = await commercial.updateCatalogDraft({
      catalogVersionId: cloned.id,
      actorUserId: OWNER,
      correlationId: "integrity-good-pack",
      pack: jsonClone(
        (await commercial.repository.getCatalogVersion(cloned.id))!.packagePayload as never,
      ),
    });
    const validated = await commercial.validateCatalog({
      catalogVersionId: updated.id,
      actorUserId: OWNER,
      correlationId: "integrity-validate",
    });
    expect(validated.validatedIdentityChecksum).toBeTruthy();
    await database.query(
      "UPDATE service_catalog_items SET description='mutated-projection-description' WHERE catalog_version_id=$1",
      [validated.id],
    );
    await expect(
      commercial.publishCatalog({
        catalogVersionId: validated.id,
        actorUserId: OWNER,
        correlationId: "integrity-publish-projection",
      }),
    ).rejects.toBeInstanceOf(Error);
    await database.query(
      "UPDATE service_catalog_versions SET package_payload = jsonb_set(package_payload, '{displayName}', '\"mutated-display\"') WHERE id=$1",
      [validated.id],
    );
    await expect(
      commercial.publishCatalog({
        catalogVersionId: validated.id,
        actorUserId: OWNER,
        correlationId: "integrity-publish-mutated",
      }),
    ).rejects.toBeInstanceOf(Error);
    await database.query(
      "UPDATE service_catalog_versions SET validated_identity_checksum=NULL, status='validated' WHERE id=$1",
      [validated.id],
    );
    await expect(
      commercial.publishCatalog({
        catalogVersionId: validated.id,
        actorUserId: OWNER,
        correlationId: "integrity-publish-null",
      }),
    ).rejects.toBeInstanceOf(CommercialValidationError);
    const publishedClone = await commercial.cloneCatalogDraft({
      catalogVersionId: SEEDED_COMMERCIAL_IDS.moistureVersion1,
      actorUserId: OWNER,
      correlationId: "integrity-null-checksum-clone",
    });
    const publishedPack = jsonClone(
      (await commercial.repository.getCatalogVersion(publishedClone.id))!.packagePayload as never,
    );
    await commercial.updateCatalogDraft({
      catalogVersionId: publishedClone.id,
      actorUserId: OWNER,
      correlationId: "integrity-null-checksum-pack",
      pack: publishedPack,
    });
    await commercial.validateCatalog({
      catalogVersionId: publishedClone.id,
      actorUserId: OWNER,
      correlationId: "integrity-null-checksum-validate",
    });
    const published = await commercial.publishCatalog({
      catalogVersionId: publishedClone.id,
      actorUserId: OWNER,
      correlationId: "integrity-null-checksum-publish",
    });
    await database.query("UPDATE service_catalog_versions SET checksum=NULL WHERE id=$1", [
      published.id,
    ]);
    await expect(
      commercial.activateCatalog({
        catalogVersionId: published.id,
        actorUserId: OWNER,
        correlationId: "integrity-null-checksum-activate",
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  it("does not inherit version-1 overrides into a revision draft", async () => {
    const leadId = "a1000000-0000-4000-8000-000000000007";
    const now = clock.now().toISOString();
    await database.query(
      `INSERT INTO leads
       (id,reference,source_type,source_details,received_at,opportunity_name,request_summary,requested_service,
        site_name,site_city,site_region,site_country,desired_deadline_at,requested_visit_at,reviewer_user_id,
        status,disqualification_reason,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,'BEA-LD-000007','manual','Synthetic override-reset lead.',
               $2,'Synthetic override reset','Lab-only override reset.','Synthetic envelope advisory','Reset annex','Example City','EX','US',$2,$2,$3,
               'ready_for_proposal',NULL,$4,$2,$2,1)`,
      [leadId, now, SALES, OWNER],
    );
    await database.query(
      `INSERT INTO lead_parties
       (id,lead_id,role,company_id,contact_id,unmatched_company_name,unmatched_contact_name,unmatched_email,unmatched_phone,notes,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,$2,'client_company',$3,NULL,NULL,NULL,NULL,NULL,'Synthetic reset party.',$4,$5,$5,1)`,
      [
        "a1100000-0000-4000-8000-000000000071",
        leadId,
        "90000000-0000-4000-8000-000000000001",
        OWNER,
        now,
      ],
    );
    await database.query(
      `INSERT INTO lead_parties
       (id,lead_id,role,company_id,contact_id,unmatched_company_name,unmatched_contact_name,unmatched_email,unmatched_phone,notes,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,$2,'primary_contact',$3,$4,NULL,'Reset Contact',NULL,NULL,'Synthetic reset party.',$5,$6,$6,1)`,
      [
        "a1100000-0000-4000-8000-000000000072",
        leadId,
        "90000000-0000-4000-8000-000000000001",
        "91000000-0000-4000-8000-000000000001",
        OWNER,
        now,
      ],
    );
    const created = await commercial.createProposalFromLead({
      leadId,
      actorUserId: SALES,
      correlationId: "reset-create",
    });
    const drafted = await completeDraft(
      created.record.proposal.id,
      created.record.proposal.version,
    );
    const catalogAmount = drafted.lines[0]!.catalogUnitAmountMinor;
    const requested = await commercial.requestOverride({
      proposalId: drafted.proposal.id,
      actorUserId: SALES,
      correlationId: "reset-override",
      expectedVersion: drafted.proposal.version,
      lineKey: drafted.lines[0]!.lineKey,
      proposedAmountMinor: 4000,
      reason: "Synthetic version-1 courtesy adjustment.",
    });
    const decided = await commercial.decideOverride({
      proposalId: requested.proposal.id,
      overrideId: requested.overrides[0]!.id,
      actorUserId: OWNER,
      correlationId: "reset-decide",
      expectedVersion: requested.proposal.version,
      approve: true,
    });
    expect(decided.proposal.totalMinor).toBe(4000);
    const submitted = await commercial.submitForReview({
      proposalId: decided.proposal.id,
      actorUserId: SALES,
      correlationId: "reset-submit",
      expectedVersion: decided.proposal.version,
    });
    const v1 = submitted.versions.find((item) => item.versionNumber === 1)!;
    expect(v1.totalMinor).toBe(4000);
    const revised = await commercial.reviewProposal({
      proposalId: submitted.proposal.id,
      actorUserId: OWNER,
      correlationId: "reset-revise",
      expectedVersion: submitted.proposal.version,
      proposalVersionId: v1.id,
      decision: "request_revision",
      comments: "Reset pricing to catalog.",
    });
    const refreshed = await commercial.repository.getProposal(revised.proposal.id);
    expect(refreshed!.lines[0]!.unitAmountMinor).toBe(catalogAmount);
    expect(refreshed!.lines[0]!.overrideId).toBeNull();
    expect(refreshed!.proposal.totalMinor).toBe(catalogAmount);
    await expect(
      commercial.decideOverride({
        proposalId: revised.proposal.id,
        overrideId: decided.overrides[0]!.id,
        actorUserId: OWNER,
        correlationId: "reset-post-approve",
        expectedVersion: revised.proposal.version,
        approve: true,
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  it("opens a second information cycle after revision when information is missing", async () => {
    const proposal = (await commercial.repository.getProposalByLead(
      "a1000000-0000-4000-8000-000000000007",
    ))!;
    const record = (await commercial.repository.getProposal(proposal.id))!;
    const cleared = await commercial.updateDraft({
      proposalId: record.proposal.id,
      actorUserId: SALES,
      correlationId: "cycle-2",
      expectedVersion: record.proposal.version,
      lines: [],
      scopeText: "",
    });
    expect(cleared.proposal.status).toBe("needs_information");
    expect(cleared.proposal.informationCycleNumber).toBe(2);
    const work = await pipeline.workControl!.repository.listWorkItems({
      proposalId: cleared.proposal.id,
      limit: 50,
    });
    const information = work.filter((item) => item.workItemKind === "proposal_information");
    expect(information).toHaveLength(2);
    expect(information.some((item) => item.status === "completed")).toBe(true);
    expect(information.some((item) => item.status !== "completed")).toBe(true);
  });

  it("refuses ordinary creation against a non-active or non-synthetic catalog", async () => {
    const leadId = "a1000000-0000-4000-8000-000000000009";
    const now = clock.now().toISOString();
    await database.query(
      `INSERT INTO leads
       (id,reference,source_type,source_details,received_at,opportunity_name,request_summary,requested_service,
        site_name,site_city,site_region,site_country,desired_deadline_at,requested_visit_at,reviewer_user_id,
        status,disqualification_reason,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,'BEA-LD-000009','manual','Synthetic inactive-catalog lead.',
               $2,'Synthetic inactive catalog','Lab-only inactive catalog.','Synthetic envelope advisory','Inactive annex','Example City','EX','US',$2,$2,$3,
               'ready_for_proposal',NULL,$4,$2,$2,1)`,
      [leadId, now, SALES, OWNER],
    );
    await database.query(
      `INSERT INTO lead_parties
       (id,lead_id,role,company_id,contact_id,unmatched_company_name,unmatched_contact_name,unmatched_email,unmatched_phone,notes,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,$2,'client_company',$3,NULL,NULL,NULL,NULL,NULL,'Synthetic inactive party.',$4,$5,$5,1)`,
      [
        "a1100000-0000-4000-8000-000000000091",
        leadId,
        "90000000-0000-4000-8000-000000000001",
        OWNER,
        now,
      ],
    );
    await database.query(
      `INSERT INTO lead_parties
       (id,lead_id,role,company_id,contact_id,unmatched_company_name,unmatched_contact_name,unmatched_email,unmatched_phone,notes,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,$2,'primary_contact',$3,$4,NULL,'Inactive Contact',NULL,NULL,'Synthetic inactive party.',$5,$6,$6,1)`,
      [
        "a1100000-0000-4000-8000-000000000092",
        leadId,
        "90000000-0000-4000-8000-000000000001",
        "91000000-0000-4000-8000-000000000001",
        OWNER,
        now,
      ],
    );
    await expect(
      commercial.createProposalFromLead({
        leadId,
        actorUserId: SALES,
        correlationId: "inactive-catalog",
        catalogVersionId: SEEDED_COMMERCIAL_IDS.productionDraft,
      }),
    ).rejects.toBeInstanceOf(ProductionCatalogNotConfiguredError);
  });

  it("hides technical work kinds from the Sales commercial-work predicate", async () => {
    const items = await pipeline.workControl!.repository.listWorkItems({ limit: 300 });
    const salesVisible = items.filter((item) => isSalesCommercialWorkKind(item.workItemKind));
    expect(
      salesVisible.every((item) =>
        [
          "proposal_preparation",
          "proposal_information",
          "proposal_revision",
          "proposal_delivery_preparation",
        ].includes(item.workItemKind),
      ),
    ).toBe(true);
    expect(items.some((item) => item.workItemKind === "proposal_review")).toBe(true);
  });

  it("blocks approval and manifests when frozen checksum or filename is missing", async () => {
    const leadId = "a1000000-0000-4000-8000-000000000008";
    const now = clock.now().toISOString();
    await database.query(
      `INSERT INTO leads
       (id,reference,source_type,source_details,received_at,opportunity_name,request_summary,requested_service,
        site_name,site_city,site_region,site_country,desired_deadline_at,requested_visit_at,reviewer_user_id,
        status,disqualification_reason,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,'BEA-LD-000008','manual','Synthetic missing-artifact lead.',
               $2,'Synthetic missing artifact','Lab-only missing artifact.','Synthetic envelope advisory','Artifact annex','Example City','EX','US',$2,$2,$3,
               'ready_for_proposal',NULL,$4,$2,$2,1)`,
      [leadId, now, SALES, OWNER],
    );
    await database.query(
      `INSERT INTO lead_parties
       (id,lead_id,role,company_id,contact_id,unmatched_company_name,unmatched_contact_name,unmatched_email,unmatched_phone,notes,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,$2,'client_company',$3,NULL,NULL,NULL,NULL,NULL,'Synthetic artifact party.',$4,$5,$5,1)`,
      [
        "a1100000-0000-4000-8000-000000000081",
        leadId,
        "90000000-0000-4000-8000-000000000001",
        OWNER,
        now,
      ],
    );
    await database.query(
      `INSERT INTO lead_parties
       (id,lead_id,role,company_id,contact_id,unmatched_company_name,unmatched_contact_name,unmatched_email,unmatched_phone,notes,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,$2,'primary_contact',$3,$4,NULL,'Artifact Contact',NULL,NULL,'Synthetic artifact party.',$5,$6,$6,1)`,
      [
        "a1100000-0000-4000-8000-000000000082",
        leadId,
        "90000000-0000-4000-8000-000000000001",
        "91000000-0000-4000-8000-000000000001",
        OWNER,
        now,
      ],
    );
    const created = await commercial.createProposalFromLead({
      leadId,
      actorUserId: SALES,
      correlationId: "artifact-create",
    });
    const drafted = await completeDraft(
      created.record.proposal.id,
      created.record.proposal.version,
    );
    const submitted = await commercial.submitForReview({
      proposalId: drafted.proposal.id,
      actorUserId: SALES,
      correlationId: "artifact-submit",
      expectedVersion: drafted.proposal.version,
    });
    const version = submitted.versions.find((item) => item.versionNumber === 1)!;
    await database.query("UPDATE proposal_versions SET rendered_checksum=NULL WHERE id=$1", [
      version.id,
    ]);
    await expect(
      commercial.reviewProposal({
        proposalId: submitted.proposal.id,
        actorUserId: OWNER,
        correlationId: "artifact-approve",
        expectedVersion: submitted.proposal.version,
        proposalVersionId: version.id,
        decision: "approve",
      }),
    ).rejects.toBeInstanceOf(CommercialValidationError);
    await database.query("UPDATE proposal_versions SET rendered_checksum=$2 WHERE id=$1", [
      version.id,
      version.renderedChecksum,
    ]);
    const approved = await commercial.reviewProposal({
      proposalId: submitted.proposal.id,
      actorUserId: OWNER,
      correlationId: "artifact-approve-restored",
      expectedVersion: submitted.proposal.version,
      proposalVersionId: version.id,
      decision: "approve",
    });
    await database.query("UPDATE proposal_versions SET file_name=NULL WHERE id=$1", [version.id]);
    await expect(
      commercial.generateDeliveryManifest({
        proposalId: approved.proposal.id,
        actorUserId: SALES,
        correlationId: "artifact-manifest",
        expectedVersion: approved.proposal.version,
        proposalVersionId: version.id,
      }),
    ).rejects.toBeInstanceOf(CommercialValidationError);
  });

  it("rejects a direct Sales decideOverride call without commercial mutation", async () => {
    await expectAuthorizationDenied(SALES, "sales");
  });

  it("rejects a direct Operations decideOverride call without commercial mutation", async () => {
    await expectAuthorizationDenied(OPERATIONS, "operations");
  });

  it("rejects a direct Integration Administrator decideOverride call without commercial mutation", async () => {
    await expectAuthorizationDenied(INTEGRATION, "integration");
  });

  it("rejects a direct Executive Read-only decideOverride call without commercial mutation", async () => {
    await expectAuthorizationDenied(EXECUTIVE, "executive");
  });

  it("rejects an unknown user decideOverride call without commercial mutation", async () => {
    await expectAuthorizationDenied(randomUUID(), "unknown-user");
  });

  it("rejects inactive and archived otherwise-eligible override approvers without mutation", async () => {
    const now = clock.now().toISOString();
    const inactiveId = randomUUID();
    const archivedId = randomUUID();
    for (const [userId, email] of [
      [inactiveId, `inactive.owner.${inactiveId.slice(0, 8)}@example.invalid`],
      [archivedId, `archived.owner.${archivedId.slice(0, 8)}@example.invalid`],
    ] as const) {
      await database.query(
        `INSERT INTO users (id,persona_key,email,display_name,title,status,created_at,updated_at,version)
         VALUES ($1,NULL,$2,$3,'Chief Executive Officer','active',$4,$4,1)`,
        [userId, email, `Eligible Owner ${userId.slice(0, 8)}`, now],
      );
      await database.query(
        `INSERT INTO user_roles (user_id,role_id,created_at) VALUES ($1,$2,$3)`,
        [userId, OWNER_ROLE_ID, now],
      );
    }
    await database.query("UPDATE users SET status='inactive' WHERE id=$1", [inactiveId]);
    await database.query("UPDATE users SET status='archived', archived_at=$2 WHERE id=$1", [
      archivedId,
      now,
    ]);
    await expectAuthorizationDenied(inactiveId, "inactive-owner");
    await expectAuthorizationDenied(archivedId, "archived-owner");
  });

  it("lets an eligible Owner approve a requested override and close the exact work item", async () => {
    const prepared = await createRequestedOverride("owner-approve", 4000);
    const decided = await commercial.decideOverride({
      proposalId: prepared.proposalId,
      overrideId: prepared.overrideId,
      actorUserId: OWNER,
      correlationId: "owner-approve-decide",
      expectedVersion: prepared.requested.proposal.version,
      approve: true,
    });
    const after = await captureOverrideInvariants(prepared.proposalId, prepared.overrideId);
    expect(decided.overrides[0]?.status).toBe("approved");
    expect(after.overrideStatus).toBe("approved");
    expect(after.approvedBy).toBe(OWNER);
    expect(after.approvedAt).toBeTruthy();
    expect(after.lineAmount).toBe(4000);
    expect(after.lineOverrideId).toBe(prepared.overrideId);
    expect(after.totalMinor).toBe(4000);
    expect(after.subtotalMinor).toBe(4000);
    expect(after.automationEvents).toEqual(["proposal.pricing_override_approved"]);
    expect(after.activities).toEqual(["proposal.pricing_override_approved"]);
    expect(after.auditDecisionCount).toBe(1);
    expect(after.overrideWorkStatuses).toEqual(["completed"]);
  });

  it("lets an eligible Owner reject a requested override without changing catalog amounts", async () => {
    const prepared = await createRequestedOverride("owner-reject", 2500);
    const decided = await commercial.decideOverride({
      proposalId: prepared.proposalId,
      overrideId: prepared.overrideId,
      actorUserId: OWNER,
      correlationId: "owner-reject-decide",
      expectedVersion: prepared.requested.proposal.version,
      approve: false,
    });
    const after = await captureOverrideInvariants(prepared.proposalId, prepared.overrideId);
    expect(decided.overrides[0]?.status).toBe("rejected");
    expect(after.overrideStatus).toBe("rejected");
    expect(after.approvedBy).toBe(OWNER);
    expect(after.lineAmount).toBe(prepared.catalogAmount);
    expect(after.lineOverrideId).toBeNull();
    expect(after.totalMinor).toBe(prepared.catalogAmount);
    expect(after.automationEvents).toEqual(["proposal.pricing_override_rejected"]);
    expect(after.activities).toEqual(["proposal.pricing_override_rejected"]);
    expect(after.auditDecisionCount).toBe(1);
    expect(after.overrideWorkStatuses).toEqual(["completed"]);
  });
});
