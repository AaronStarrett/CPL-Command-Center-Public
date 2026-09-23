import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { DEMO_PERSONAS } from "../../packages/domain/src/index.js";
import {
  LeadDisqualificationReasonError,
  LeadReadinessError,
  LeadReadyStatusInvariantError,
  LeadReviewerEligibilityError,
  LeadStatusTransitionError,
  LeadValidationError,
  PGliteDatabaseAdapter,
  SqlFoundationRepository,
  SqlLeadRepository,
  SqlPhase1Repository,
  createServerRuntime,
  migrateDatabase,
  seedDatabase,
  type BeaServerRuntime,
} from "../../packages/database/src/index.js";
import { PERMISSIONS, PersistentAuthorizationService } from "../../packages/security/src/index.js";
import {
  getAiCommandSnapshotWithRuntime,
  processAiCommandMessageWithRuntime,
  reserveAiCommandRequestWithRuntime,
} from "../../apps/web/lib/ai-command.js";

vi.mock("server-only", () => ({}));

const OWNER_USER_ID = DEMO_PERSONAS[0].id;
const SALES_USER_ID = DEMO_PERSONAS[1].id;
const OPERATIONS_USER_ID = DEMO_PERSONAS[2].id;
const COMPANY_ID = "90000000-0000-4000-8000-000000000001";
const CONTACT_ID = "91000000-0000-4000-8000-000000000001";
const MANUAL_LEAD_ID = "a1000000-0000-4000-8000-000000000001";
const REFERRAL_LEAD_ID = "a1000000-0000-4000-8000-000000000002";
const READY_LEAD_ID = "a1000000-0000-4000-8000-000000000003";
const DISQUALIFIED_LEAD_ID = "a1000000-0000-4000-8000-000000000004";

let database!: PGliteDatabaseAdapter;
let leads!: SqlLeadRepository;
let phase1!: SqlPhase1Repository;
let authorization!: PersistentAuthorizationService;

beforeAll(async () => {
  database = new PGliteDatabaseAdapter("memory://");
  const first = await migrateDatabase(database);
  expect(first.applied.at(-1)).toBe("0035_cpl_delivery_closeout.sql");
  expect((await migrateDatabase(database)).applied).toEqual([]);
  const firstSeed = await seedDatabase(database);
  const secondSeed = await seedDatabase(database);
  expect(firstSeed.leads).toBe(4);
  expect(secondSeed.leads).toBe(4);
  leads = new SqlLeadRepository(database);
  phase1 = new SqlPhase1Repository(database);
  authorization = new PersistentAuthorizationService(new SqlFoundationRepository(database));
}, 60_000);

afterAll(async () => {
  await database?.close();
});

describe("Phase 2.0 lead persistence", () => {
  it("migrates an empty database and seeds synthetic intake across all sources and statuses", async () => {
    const listed = await leads.listLeads({ limit: 100 });
    expect(listed.map((item) => item.lead.reference).sort()).toEqual([
      "BEA-LD-000001",
      "BEA-LD-000002",
      "BEA-LD-000003",
      "BEA-LD-000004",
      "BEA-LD-000005",
    ]);
    expect(listed.map((item) => item.lead.sourceType).sort()).toEqual([
      "in_person",
      "manual",
      "manual",
      "manual",
      "referral",
    ]);
    expect(listed.map((item) => item.lead.status).sort()).toEqual([
      "disqualified",
      "needs_info",
      "new",
      "ready_for_proposal",
      "ready_for_proposal",
    ]);
    const incomplete = await leads.getLead(MANUAL_LEAD_ID);
    expect(incomplete?.readiness.readyForProposal).toBe(false);
    expect(incomplete?.readiness.blocking.map((item) => item.code)).toEqual(
      expect.arrayContaining(["requested_service", "identified_client_or_contact"]),
    );
    const ready = await leads.getLead(READY_LEAD_ID);
    expect(ready?.readiness.readyForProposal).toBe(true);
    expect(ready?.parties.map((party) => party.role).sort()).toEqual([
      "client_company",
      "primary_contact",
      "requester",
    ]);
    expect(ready?.parties.find((party) => party.role === "primary_contact")?.contactId).toBe(
      CONTACT_ID,
    );
    const reviewers = await leads.listReviewerCandidates();
    expect(reviewers.map((reviewer) => reviewer.id)).toEqual(
      expect.arrayContaining([OWNER_USER_ID, SALES_USER_ID]),
    );
    expect(reviewers.map((reviewer) => reviewer.id)).not.toEqual(
      expect.arrayContaining([OPERATIONS_USER_ID]),
    );
  }, 30_000);

  it("creates, lists, updates, and links unmatched plus canonical parties", async () => {
    const created = await leads.createLead({
      sourceType: "manual",
      opportunityName: "Synthetic additional intake",
      requestSummary: "Created by the Phase 2.0 repository test.",
      requestedService: "Moisture investigation",
      createdByUserId: SALES_USER_ID,
      correlationId: "phase20-create-lead",
      parties: [
        {
          role: "client_company",
          companyId: COMPANY_ID,
          unmatchedCompanyName: "Northstar Facade Group",
        },
        {
          role: "requester",
          unmatchedContactName: "Jordan Intake",
          unmatchedEmail: "jordan.intake@example.invalid",
        },
      ],
    });
    expect(created.lead.reference).toMatch(/^BEA-LD-\d{6}$/u);
    expect(created.lead.status).toBe("new");
    expect(created.readiness.readyForProposal).toBe(true);
    const listed = await leads.listLeads({ query: "additional intake", status: "new" });
    expect(listed.some((item) => item.lead.id === created.lead.id)).toBe(true);
    const updated = await leads.updateLead({
      leadId: created.lead.id,
      expectedVersion: created.lead.version,
      actorUserId: SALES_USER_ID,
      correlationId: "phase20-update-lead",
      siteCity: "Example City",
      reviewerUserId: SALES_USER_ID,
    });
    expect(updated.lead.siteCity).toBe("Example City");
    expect(updated.lead.version).toBe(created.lead.version + 1);
    const audits = await database.query<{ event_type: string }>(
      "SELECT event_type FROM audit_logs WHERE resource_id=$1 ORDER BY created_at, id",
      [created.lead.id],
    );
    expect(audits.rows.map((row) => row.event_type)).toEqual(["lead.created", "lead.updated"]);
    const activities = await phase1.listActivities({ leadId: created.lead.id, limit: 20 });
    expect(activities.map((activity) => activity.type)).toEqual(
      expect.arrayContaining(["lead.created", "lead.updated"]),
    );
  }, 30_000);

  it("enforces the review state machine, disqualification reason, and readiness gate", async () => {
    const current = await leads.getLead(MANUAL_LEAD_ID);
    if (!current) throw new Error("Seeded incomplete lead is missing.");
    await expect(
      leads.transitionStatus({
        leadId: current.lead.id,
        toStatus: "ready_for_proposal",
        expectedVersion: current.lead.version,
        actorUserId: SALES_USER_ID,
      }),
    ).rejects.toBeInstanceOf(LeadReadinessError);
    const needsInfo = await leads.transitionStatus({
      leadId: current.lead.id,
      toStatus: "needs_info",
      expectedVersion: current.lead.version,
      actorUserId: SALES_USER_ID,
      reason: "Service description is still missing.",
      correlationId: "phase20-needs-info",
    });
    expect(needsInfo.lead.status).toBe("needs_info");
    await expect(
      leads.transitionStatus({
        leadId: needsInfo.lead.id,
        toStatus: "disqualified",
        expectedVersion: needsInfo.lead.version,
        actorUserId: SALES_USER_ID,
      }),
    ).rejects.toBeInstanceOf(LeadDisqualificationReasonError);
    const readyLead = await leads.getLead(READY_LEAD_ID);
    if (!readyLead) throw new Error("Seeded ready lead is missing.");
    await expect(
      leads.transitionStatus({
        leadId: readyLead.lead.id,
        toStatus: "new",
        expectedVersion: readyLead.lead.version,
        actorUserId: SALES_USER_ID,
      }),
    ).rejects.toBeInstanceOf(LeadStatusTransitionError);
    const returned = await leads.transitionStatus({
      leadId: readyLead.lead.id,
      toStatus: "needs_info",
      expectedVersion: readyLead.lead.version,
      actorUserId: SALES_USER_ID,
      reason: "Correction: additional site photos are useful.",
      correlationId: "phase20-return-needs-info",
    });
    expect(returned.lead.status).toBe("needs_info");
    const restored = await leads.transitionStatus({
      leadId: returned.lead.id,
      toStatus: "ready_for_proposal",
      expectedVersion: returned.lead.version,
      actorUserId: SALES_USER_ID,
      correlationId: "phase20-restore-ready",
    });
    expect(restored.lead.status).toBe("ready_for_proposal");
    const disqualified = await leads.getLead(DISQUALIFIED_LEAD_ID);
    expect(disqualified?.lead.disqualificationReason).toMatch(/outside BEA/u);
    const reopened = await leads.transitionStatus({
      leadId: DISQUALIFIED_LEAD_ID,
      toStatus: "new",
      expectedVersion: disqualified?.lead.version ?? 1,
      actorUserId: OWNER_USER_ID,
      reason: "Correction: reopen the synthetic fixture for review.",
      correlationId: "phase20-reopen",
    });
    expect(reopened.lead.status).toBe("new");
    expect(reopened.lead.disqualificationReason).toBeNull();
  }, 30_000);

  it("keeps lead mutations behind deny-by-default role permissions", async () => {
    await expect(
      authorization.requireUser({
        userId: SALES_USER_ID,
        permission: PERMISSIONS.LEADS_REVIEW,
        action: "lead.transition",
        resourceType: "lead",
      }),
    ).resolves.toBeUndefined();
    await expect(
      authorization.requireUser({
        userId: OPERATIONS_USER_ID,
        permission: PERMISSIONS.LEADS_VIEW,
        action: "lead.read",
        resourceType: "lead",
      }),
    ).rejects.toMatchObject({ reason: "permission-not-granted" });
    const salesSearch = await phase1.searchKeyword("Harborview", { types: ["lead"] });
    expect(salesSearch.length).toBeGreaterThan(0);
    const operationsDecision = await authorization.authorizeUser(
      OPERATIONS_USER_ID,
      PERMISSIONS.LEADS_VIEW,
    );
    expect(operationsDecision.allowed).toBe(false);
  }, 30_000);

  it("creates a follow-up task linked to a lead with actor audit context", async () => {
    const task = await phase1.createTask({
      title: "Follow up: BEA-LD-000002",
      description: "Synthetic follow-up from the lead command record.",
      assigneeUserId: SALES_USER_ID,
      createdByUserId: SALES_USER_ID,
      leadId: REFERRAL_LEAD_ID,
      correlationId: "phase20-task-follow-up",
    });
    expect(task.leadId).toBe(REFERRAL_LEAD_ID);
    const linked = await phase1.listTasks({ leadId: REFERRAL_LEAD_ID, limit: 20 });
    expect(linked.some((item) => item.id === task.id)).toBe(true);
  }, 30_000);
});

describe("Phase 2.0 pre-merge hardening", () => {
  it("rejects ready-for-proposal intake updates that introduce blocking gaps", async () => {
    const created = await leads.createLead({
      sourceType: "manual",
      opportunityName: "Synthetic ready invariant intake",
      requestSummary: "Complete enough for review-ready status.",
      requestedService: "Envelope investigation",
      createdByUserId: SALES_USER_ID,
      parties: [{ role: "client_company", companyId: COMPANY_ID }],
    });
    const ready = await leads.transitionStatus({
      leadId: created.lead.id,
      toStatus: "ready_for_proposal",
      expectedVersion: created.lead.version,
      actorUserId: SALES_USER_ID,
    });
    await expect(
      leads.updateLead({
        leadId: ready.lead.id,
        expectedVersion: ready.lead.version,
        actorUserId: SALES_USER_ID,
        requestedService: null,
        siteAddressLine1: "100 Example Invalid Way",
      }),
    ).rejects.toBeInstanceOf(LeadReadyStatusInvariantError);
    const unchanged = await leads.getLead(ready.lead.id);
    expect(unchanged?.lead.status).toBe("ready_for_proposal");
    expect(unchanged?.lead.requestedService).toBe("Envelope investigation");
    expect(unchanged?.lead.siteAddressLine1).toBeNull();
    expect(unchanged?.lead.version).toBe(ready.lead.version);
    const needsInfo = await leads.transitionStatus({
      leadId: ready.lead.id,
      toStatus: "needs_info",
      expectedVersion: ready.lead.version,
      actorUserId: SALES_USER_ID,
      reason: "Service description needs correction.",
    });
    const updated = await leads.updateLead({
      leadId: needsInfo.lead.id,
      expectedVersion: needsInfo.lead.version,
      actorUserId: SALES_USER_ID,
      requestedService: null,
    });
    expect(updated.lead.requestedService).toBeNull();
    expect(updated.lead.status).toBe("needs_info");
  }, 30_000);

  it("enforces reviewer eligibility from the same definition as candidate listing", async () => {
    const candidates = await leads.listReviewerCandidates();
    expect(candidates.map((reviewer) => reviewer.id)).toEqual(
      expect.arrayContaining([OWNER_USER_ID, SALES_USER_ID]),
    );
    expect(candidates.map((reviewer) => reviewer.id)).not.toContain(OPERATIONS_USER_ID);
    await expect(
      leads.createLead({
        sourceType: "manual",
        opportunityName: "Synthetic ineligible reviewer",
        requestSummary: "Operations cannot be assigned as reviewer.",
        createdByUserId: SALES_USER_ID,
        reviewerUserId: OPERATIONS_USER_ID,
      }),
    ).rejects.toBeInstanceOf(LeadReviewerEligibilityError);
    const created = await leads.createLead({
      sourceType: "manual",
      opportunityName: "Synthetic eligible reviewer",
      requestSummary: "Sales may be assigned as reviewer.",
      createdByUserId: SALES_USER_ID,
      reviewerUserId: SALES_USER_ID,
    });
    expect(created.lead.reviewerUserId).toBe(SALES_USER_ID);
    const ownerAssigned = await leads.updateLead({
      leadId: created.lead.id,
      expectedVersion: created.lead.version,
      actorUserId: SALES_USER_ID,
      reviewerUserId: OWNER_USER_ID,
    });
    expect(ownerAssigned.lead.reviewerUserId).toBe(OWNER_USER_ID);
    await expect(
      leads.updateLead({
        leadId: ownerAssigned.lead.id,
        expectedVersion: ownerAssigned.lead.version,
        actorUserId: SALES_USER_ID,
        reviewerUserId: OPERATIONS_USER_ID,
      }),
    ).rejects.toBeInstanceOf(LeadReviewerEligibilityError);
    const cleared = await leads.updateLead({
      leadId: ownerAssigned.lead.id,
      expectedVersion: ownerAssigned.lead.version,
      actorUserId: SALES_USER_ID,
      reviewerUserId: null,
    });
    expect(cleared.lead.reviewerUserId).toBeNull();
  }, 30_000);

  it("resolves canonical company and contact identity without unmatched text", async () => {
    const created = await leads.createLead({
      sourceType: "in_person",
      opportunityName: "Synthetic canonical-only identity",
      requestSummary: "Company and contact linked without duplicated unmatched names.",
      requestedService: "Facade review",
      createdByUserId: SALES_USER_ID,
      parties: [
        { role: "client_company", companyId: COMPANY_ID },
        { role: "primary_contact", contactId: CONTACT_ID, companyId: COMPANY_ID },
      ],
    });
    const listed = await leads.listLeads({ query: "canonical-only identity" });
    const item = listed.find((entry) => entry.lead.id === created.lead.id);
    expect(item?.primaryCompanyName).toBe("Northstar Facade Group");
    expect(item?.primaryContactName).toBe("Morgan Demo");
    expect(item?.primaryCompanyName).not.toBe("No company or contact identified");
    await expect(
      leads.createLead({
        sourceType: "manual",
        opportunityName: "Synthetic conflicting party",
        requestSummary: "Contact belongs to a different company.",
        createdByUserId: SALES_USER_ID,
        parties: [
          {
            role: "primary_contact",
            companyId: "90000000-0000-4000-8000-000000000003",
            contactId: CONTACT_ID,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(LeadValidationError);
  }, 30_000);

  it("synchronizes lead parties by role and records non-sensitive audit metadata", async () => {
    const created = await leads.createLead({
      sourceType: "manual",
      opportunityName: "Synthetic party sync",
      requestSummary: "Party identity must remain stable across edits.",
      requestedService: "Envelope investigation",
      siteAddressLine1: "10 Example Invalid Street",
      sitePostalCode: "00000",
      siteCountry: "US",
      createdByUserId: SALES_USER_ID,
      parties: [
        {
          role: "client_company",
          companyId: COMPANY_ID,
          unmatchedEmail: "intake@example.invalid",
        },
        {
          role: "requester",
          unmatchedContactName: "Jordan Intake",
          unmatchedPhone: "+1-555-0199",
        },
      ],
    });
    const originalClient = created.parties.find((party) => party.role === "client_company");
    const originalRequester = created.parties.find((party) => party.role === "requester");
    if (!originalClient || !originalRequester) throw new Error("Expected seeded party roles.");
    const updated = await leads.updateLead({
      leadId: created.lead.id,
      expectedVersion: created.lead.version,
      actorUserId: SALES_USER_ID,
      siteAddressLine1: "20 Example Invalid Avenue",
      siteAddressLine2: "Suite 2",
      sitePostalCode: null,
      siteCountry: "CA",
      parties: [
        {
          role: "client_company",
          companyId: COMPANY_ID,
          unmatchedEmail: "corrected@example.invalid",
          unmatchedPhone: "+1-555-0188",
        },
        {
          role: "billing_contact",
          unmatchedContactName: "Billing Example",
        },
      ],
    });
    const client = updated.parties.find((party) => party.role === "client_company");
    const billing = updated.parties.find((party) => party.role === "billing_contact");
    expect(client?.id).toBe(originalClient.id);
    expect(client?.createdAt).toBe(originalClient.createdAt);
    expect(client?.version).toBe(originalClient.version + 1);
    expect(client?.unmatchedEmail).toBe("corrected@example.invalid");
    expect(client?.unmatchedPhone).toBe("+1-555-0188");
    expect(updated.parties.some((party) => party.role === "requester")).toBe(false);
    expect(billing?.id).not.toBe(originalRequester.id);
    expect(updated.lead.siteAddressLine1).toBe("20 Example Invalid Avenue");
    expect(updated.lead.siteAddressLine2).toBe("Suite 2");
    expect(updated.lead.sitePostalCode).toBeNull();
    expect(updated.lead.siteCountry).toBe("CA");
    const audit = await database.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_logs WHERE resource_id=$1 AND event_type='lead.updated' ORDER BY created_at DESC, id DESC LIMIT 1",
      [created.lead.id],
    );
    expect(audit.rows[0]?.metadata).toMatchObject({
      changedFields: expect.arrayContaining([
        "siteAddressLine1",
        "siteAddressLine2",
        "sitePostalCode",
        "siteCountry",
      ]),
      partyRolesAdded: ["billing_contact"],
      partyRolesUpdated: ["client_company"],
      partyRolesRemoved: ["requester"],
    });
    expect(JSON.stringify(audit.rows[0]?.metadata)).not.toMatch(/example\.invalid/u);
    await expect(
      leads.updateLead({
        leadId: updated.lead.id,
        expectedVersion: updated.lead.version,
        actorUserId: SALES_USER_ID,
        parties: [
          {
            role: "billing_contact",
            unmatchedEmail: "not-an-email",
          },
        ],
      }),
    ).rejects.toBeInstanceOf(LeadValidationError);
    const afterInvalid = await leads.getLead(updated.lead.id);
    expect(afterInvalid?.lead.version).toBe(updated.lead.version);
    expect(afterInvalid?.parties.find((party) => party.role === "billing_contact")?.id).toBe(
      billing?.id,
    );
  }, 30_000);
});

describe("Phase 2.0 AI Command lead access", () => {
  let runtime: BeaServerRuntime | undefined;

  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
  });

  async function demoRuntime() {
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
    return runtime;
  }

  it("lets an authorized sales user search, open, and explain a lead without mutating it", async () => {
    const server = await demoRuntime();
    const conversation = await server.phase1.createConversation({
      ownerUserId: SALES_USER_ID,
      title: "Phase 2.0 lead command",
    });
    const reservation = await reserveAiCommandRequestWithRuntime(server, {
      userId: SALES_USER_ID,
      conversationId: conversation.id,
    });
    const listSnapshot = await processAiCommandMessageWithRuntime(server, {
      userId: SALES_USER_ID,
      conversationId: conversation.id,
      message: "Show leads",
      ...reservation,
      correlationId: "phase20-ai-leads",
    });
    expect(listSnapshot.artifact.type).toBe("lead-list");
    expect(listSnapshot.artifact.requiredPermissions).toContain(PERMISSIONS.LEADS_VIEW);
    const openReservation = await reserveAiCommandRequestWithRuntime(server, {
      userId: SALES_USER_ID,
      conversationId: conversation.id,
    });
    const openSnapshot = await processAiCommandMessageWithRuntime(server, {
      userId: SALES_USER_ID,
      conversationId: conversation.id,
      message: "Open lead BEA-LD-000001",
      ...openReservation,
      correlationId: "phase20-ai-lead-open",
    });
    expect(openSnapshot.artifact.type).toBe("lead-detail");
    expect(openSnapshot.artifact.payload.record).toMatchObject({
      status: "new",
      readyForProposal: false,
    });
    const missingReservation = await reserveAiCommandRequestWithRuntime(server, {
      userId: SALES_USER_ID,
      conversationId: conversation.id,
    });
    const missingSnapshot = await processAiCommandMessageWithRuntime(server, {
      userId: SALES_USER_ID,
      conversationId: conversation.id,
      message: "What is missing on lead BEA-LD-000001",
      ...missingReservation,
      correlationId: "phase20-ai-missing",
    });
    expect(listSnapshot.messages.at(-1)?.content).toMatch(
      /authorized lead records in the current environment/u,
    );
    expect(listSnapshot.messages.at(-1)?.content).not.toMatch(/synthetic lead/iu);
    expect(String(listSnapshot.artifact.subtitle ?? "")).not.toMatch(/synthetic/iu);
    expect(openSnapshot.artifact.subtitle).toMatch(/authorized lead record/u);
    expect(openSnapshot.artifact.subtitle).not.toMatch(/synthetic intake/iu);
    expect(missingSnapshot.messages.at(-1)?.content).toMatch(/Blocking missing information/u);
    const unchanged = await server.leads.getLead(MANUAL_LEAD_ID);
    expect(unchanged?.lead.status).toBe("new");
  }, 60_000);

  it("prepares a lead follow-up task behind the existing confirmation gate", async () => {
    const server = await demoRuntime();
    const conversation = await server.phase1.createConversation({
      ownerUserId: SALES_USER_ID,
      title: "Phase 2.0 lead follow-up",
    });
    const reservation = await reserveAiCommandRequestWithRuntime(server, {
      userId: SALES_USER_ID,
      conversationId: conversation.id,
    });
    const snapshot = await processAiCommandMessageWithRuntime(server, {
      userId: SALES_USER_ID,
      conversationId: conversation.id,
      message: "Create an internal follow-up task for lead BEA-LD-000003",
      ...reservation,
      correlationId: "phase20-ai-task",
    });
    expect(snapshot.artifact.type).toBe("action-preview");
    expect(snapshot.artifact.payload).toMatchObject({
      executable: true,
      fields: {
        title: "Internal follow-up task",
        lead: expect.stringContaining("BEA-LD-000003"),
      },
    });
    const tasks = await server.phase1.listTasks({ leadId: READY_LEAD_ID, limit: 20 });
    expect(tasks).toEqual([]);
  }, 60_000);

  it("denies lead data to roles without leads.view", async () => {
    const server = await demoRuntime();
    const conversation = await server.phase1.createConversation({
      ownerUserId: OPERATIONS_USER_ID,
      title: "Phase 2.0 unauthorized lead read",
    });
    const reservation = await reserveAiCommandRequestWithRuntime(server, {
      userId: OPERATIONS_USER_ID,
      conversationId: conversation.id,
    });
    await expect(
      processAiCommandMessageWithRuntime(server, {
        userId: OPERATIONS_USER_ID,
        conversationId: conversation.id,
        message: "Show leads",
        ...reservation,
        correlationId: "phase20-ai-denied",
      }),
    ).rejects.toMatchObject({ name: "AccessDeniedError" });
    const searchReservation = await reserveAiCommandRequestWithRuntime(server, {
      userId: OPERATIONS_USER_ID,
      conversationId: conversation.id,
    });
    const searchSnapshot = await processAiCommandMessageWithRuntime(server, {
      userId: OPERATIONS_USER_ID,
      conversationId: conversation.id,
      message: "Search for Harborview",
      ...searchReservation,
      correlationId: "phase20-ai-search-denied",
    });
    expect(
      (searchSnapshot.artifact.payload.items as readonly { type?: string }[] | undefined)?.some(
        (item) => item.type === "lead",
      ) ?? false,
    ).toBe(false);
    await getAiCommandSnapshotWithRuntime(server, OPERATIONS_USER_ID, conversation.id);
  }, 60_000);
});
