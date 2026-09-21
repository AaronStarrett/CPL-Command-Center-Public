import { createHash } from "node:crypto";
import {
  ARTIFACT_BRAND_POLICY_SETTING_KEY,
  DEFAULT_ARTIFACT_BRAND_POLICY,
  DEFAULT_EXECUTIVE_PERSONA_POLICY,
  SYNTHETIC_EXECUTIVE_PROFILE,
  DEMO_PERSONAS,
  DEMO_ROLE_IDS,
  EXECUTIVE_PERSONA_POLICY_SETTING_KEY,
  EXECUTIVE_PROFILE_SETTING_KEY,
  type RoleId,
} from "@bea/domain";
import { DEFAULT_MOCK_PROVIDER_DESCRIPTORS } from "@bea/integrations";
import { PERMISSIONS, ROLE_PERMISSION_MATRIX, type Permission } from "@bea/security";
import type { DatabaseAdapter, SqlExecutor } from "./adapter.js";
import { seedDigitalWorkforce } from "./digital-workforce-seed.js";
import { seedConfigurationStudio } from "./configuration-seed.js";
import { seedInspectionReportCore } from "./operations-seed.js";
import { seedWorkControl } from "./work-control-seed.js";
import { seedCommercial } from "./commercial-seed.js";
import { seedGuidedMeridianExperience } from "./guided-demo-seed.js";

export const DEMO_SEED_TIMESTAMP = "2026-01-01T00:00:00.000Z";

const roleIds: Readonly<Record<RoleId, string>> = {
  [DEMO_ROLE_IDS.OWNER_ADMIN]: "20000000-0000-4000-8000-000000000001",
  [DEMO_ROLE_IDS.SALES]: "20000000-0000-4000-8000-000000000002",
  [DEMO_ROLE_IDS.OPERATIONS]: "20000000-0000-4000-8000-000000000003",
  [DEMO_ROLE_IDS.EXECUTIVE_READONLY]: "20000000-0000-4000-8000-000000000004",
  [DEMO_ROLE_IDS.INTEGRATION_ADMIN]: "20000000-0000-4000-8000-000000000005",
};

const roleNames: Readonly<Record<RoleId, string>> = {
  [DEMO_ROLE_IDS.OWNER_ADMIN]: "Owner / Administrator",
  [DEMO_ROLE_IDS.SALES]: "Sales",
  [DEMO_ROLE_IDS.OPERATIONS]: "Operations",
  [DEMO_ROLE_IDS.EXECUTIVE_READONLY]: "Read-only Executive",
  [DEMO_ROLE_IDS.INTEGRATION_ADMIN]: "Integration Administrator",
};

function stablePermissionId(key: Permission): string {
  const digest = createHash("sha256").update(`bea-demo-permission:${key}`, "utf8").digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

const permissionEntries = Object.values(PERMISSIONS).map((key) => ({
  id: stablePermissionId(key),
  key,
}));

export const FEATURE_FLAG_SEEDS = [
  ["lead-intake", "Lead intake"],
  ["proposal-builder", "Proposal builder"],
  ["award-to-project", "Award-to-project conversion"],
  ["ask-bea", "Ask BEA"],
  ["voice", "Voice"],
  ["telephone", "Telephone"],
  ["executive-reports", "Executive reports"],
] as const;

export interface SeedSummary {
  readonly users: number;
  readonly roles: number;
  readonly permissions: number;
  readonly featureFlags: number;
  readonly integrations: number;
  readonly workflowRuns: number;
  readonly companies: number;
  readonly contacts: number;
  readonly tasks: number;
  readonly leads: number;
  readonly conversations: number;
  readonly suggestedActions: number;
  readonly projects: number;
  readonly inspections: number;
}

export class DemoSeedRefusedError extends Error {
  readonly code = "DEMO_SEED_REFUSED";

  constructor() {
    super("Deterministic fixtures require demo mode in an isolated NODE_ENV=test harness.");
    this.name = "DemoSeedRefusedError";
  }
}

export function assertDemoSeedAllowed(appMode: "demo" | "production"): void {
  if (appMode !== "demo" || process.env.NODE_ENV !== "test") throw new DemoSeedRefusedError();
}

export async function seedDatabaseOnExecutor(transaction: SqlExecutor): Promise<SeedSummary> {
  assertDemoSeedAllowed("demo");
  for (const roleKey of Object.values(DEMO_ROLE_IDS)) {
    await transaction.query(
      `INSERT INTO roles (id,key,name,description,status,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,'active',$5,$5,1)
       ON CONFLICT (id) DO UPDATE SET key=EXCLUDED.key,name=EXCLUDED.name,description=EXCLUDED.description,status='active',updated_at=EXCLUDED.updated_at`,
      [
        roleIds[roleKey],
        roleKey,
        roleNames[roleKey],
        `Configurable Phase 0 ${roleNames[roleKey]} role.`,
        DEMO_SEED_TIMESTAMP,
      ],
    );
  }

  // Phase 0 assigned permission IDs by object position. New permission constants changed those
  // positions, so legacy grants must be removed before permission rows receive stable keyed IDs.
  // Current grants are rebuilt from ROLE_PERMISSION_MATRIX later in this same transaction.
  for (const roleKey of Object.values(DEMO_ROLE_IDS)) {
    await transaction.query("DELETE FROM role_permissions WHERE role_id=$1", [roleIds[roleKey]]);
  }

  const permissionIdByKey = new Map<Permission, string>();
  for (const permission of permissionEntries) {
    const result = await transaction.query<{ id: string }>(
      `INSERT INTO permissions (id,key,name,description,status,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,'active',$5,$5,1)
       ON CONFLICT (key) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,
       status='active',updated_at=EXCLUDED.updated_at
       RETURNING id::text AS id`,
      [
        permission.id,
        permission.key,
        permission.key,
        `Allows ${permission.key}.`,
        DEMO_SEED_TIMESTAMP,
      ],
    );
    const persistedId = result.rows[0]?.id;
    if (!persistedId) throw new Error(`Permission ${permission.key} was not persisted.`);
    permissionIdByKey.set(permission.key, persistedId);
  }

  for (const persona of DEMO_PERSONAS) {
    await transaction.query(
      `INSERT INTO users (id,persona_key,email,display_name,title,status,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,'active',$6,$6,1)
       ON CONFLICT (id) DO UPDATE SET persona_key=EXCLUDED.persona_key,email=EXCLUDED.email,display_name=EXCLUDED.display_name,title=EXCLUDED.title,status='active',archived_at=NULL,updated_at=EXCLUDED.updated_at`,
      [
        persona.id,
        persona.key,
        persona.email,
        persona.displayName,
        persona.title,
        DEMO_SEED_TIMESTAMP,
      ],
    );
    for (const roleKey of persona.roleIds) {
      await transaction.query(
        `INSERT INTO user_roles (user_id,role_id,created_at) VALUES ($1,$2,$3)
         ON CONFLICT (user_id,role_id) DO NOTHING`,
        [persona.id, roleIds[roleKey], DEMO_SEED_TIMESTAMP],
      );
    }
  }

  const ownerUserId = DEMO_PERSONAS[0].id;
  const salesUserId = DEMO_PERSONAS[1].id;
  const operationsUserId = DEMO_PERSONAS[2].id;
  const phase1Companies = [
    {
      id: "90000000-0000-4000-8000-000000000001",
      name: "Northstar Facade Group",
      industry: "Synthetic building envelope services",
      status: "active",
      website: "https://northstar.example.invalid",
      phone: "+1-555-0101",
      notes: "Synthetic Phase 1 demonstration company.",
    },
    {
      id: "90000000-0000-4000-8000-000000000002",
      name: "Harborview Property Partners",
      industry: "Synthetic property management",
      status: "prospect",
      website: "https://harborview.example.invalid",
      phone: "+1-555-0102",
      notes: "Synthetic Phase 1 prospect record.",
    },
    {
      id: "90000000-0000-4000-8000-000000000003",
      name: "Cedar Ridge Facilities",
      industry: "Synthetic facilities operations",
      status: "active",
      website: "https://cedarridge.example.invalid",
      phone: "+1-555-0103",
      notes: "Synthetic Phase 1 demonstration company.",
    },
  ] as const;
  for (const company of phase1Companies) {
    await transaction.query(
      `INSERT INTO companies
       (id,name,industry,status,website,phone,notes,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,1)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,industry=EXCLUDED.industry,status=EXCLUDED.status,
       website=EXCLUDED.website,phone=EXCLUDED.phone,notes=EXCLUDED.notes,updated_at=EXCLUDED.updated_at`,
      [
        company.id,
        company.name,
        company.industry,
        company.status,
        company.website,
        company.phone,
        company.notes,
        ownerUserId,
        DEMO_SEED_TIMESTAMP,
      ],
    );
  }

  const phase1Contacts = [
    {
      id: "91000000-0000-4000-8000-000000000001",
      companyId: phase1Companies[0].id,
      firstName: "Morgan",
      lastName: "Demo",
      jobTitle: "Synthetic Facilities Director",
      email: "morgan.demo@example.invalid",
      phone: "+1-555-0111",
    },
    {
      id: "91000000-0000-4000-8000-000000000002",
      companyId: phase1Companies[1].id,
      firstName: "Taylor",
      lastName: "Sample",
      jobTitle: "Synthetic Property Manager",
      email: "taylor.sample@example.invalid",
      phone: "+1-555-0112",
    },
    {
      id: "91000000-0000-4000-8000-000000000003",
      companyId: phase1Companies[2].id,
      firstName: "Jordan",
      lastName: "Fixture",
      jobTitle: "Synthetic Operations Lead",
      email: "jordan.fixture@example.invalid",
      phone: "+1-555-0113",
    },
    {
      id: "91000000-0000-4000-8000-000000000004",
      companyId: phase1Companies[0].id,
      firstName: "Casey",
      lastName: "Example",
      jobTitle: "Synthetic Project Contact",
      email: "casey.example@example.invalid",
      phone: "+1-555-0114",
    },
  ] as const;
  for (const contact of phase1Contacts) {
    await transaction.query(
      `INSERT INTO contacts
       (id,company_id,first_name,last_name,job_title,email,phone,status,notes,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,$10,1)
       ON CONFLICT (id) DO UPDATE SET company_id=EXCLUDED.company_id,first_name=EXCLUDED.first_name,
       last_name=EXCLUDED.last_name,job_title=EXCLUDED.job_title,email=EXCLUDED.email,phone=EXCLUDED.phone,
       status='active',notes=EXCLUDED.notes,updated_at=EXCLUDED.updated_at`,
      [
        contact.id,
        contact.companyId,
        contact.firstName,
        contact.lastName,
        contact.jobTitle,
        contact.email,
        contact.phone,
        "Synthetic Phase 1 contact; not a real person.",
        ownerUserId,
        DEMO_SEED_TIMESTAMP,
      ],
    );
  }

  const phase1Tasks = [
    {
      id: "92000000-0000-4000-8000-000000000001",
      title: "Review synthetic inquiry details",
      description: "Confirm the demonstration contact record is complete.",
      status: "open",
      priority: "high",
      assigneeUserId: salesUserId,
      dueAt: "2026-08-21T15:00:00.000Z",
      completedAt: null,
      companyId: phase1Companies[1].id,
      contactId: phase1Contacts[1].id,
      createdByUserId: ownerUserId,
    },
    {
      id: "92000000-0000-4000-8000-000000000002",
      title: "Prepare synthetic operations handoff",
      description: "Review the demonstration company and task context.",
      status: "open",
      priority: "normal",
      assigneeUserId: operationsUserId,
      dueAt: "2026-08-22T17:00:00.000Z",
      completedAt: null,
      companyId: phase1Companies[0].id,
      contactId: phase1Contacts[0].id,
      createdByUserId: ownerUserId,
    },
    {
      id: "92000000-0000-4000-8000-000000000003",
      title: "Validate Phase 1 synthetic records",
      description: "Completed fixture proving deterministic task history.",
      status: "completed",
      priority: "normal",
      assigneeUserId: ownerUserId,
      dueAt: "2026-08-19T17:00:00.000Z",
      completedAt: "2026-08-18T18:00:00.000Z",
      companyId: phase1Companies[2].id,
      contactId: phase1Contacts[2].id,
      createdByUserId: ownerUserId,
    },
    {
      id: "92000000-0000-4000-8000-000000000004",
      title: "Document confirmed synthetic follow-up",
      description: "Fixture created by a previously confirmed simulated action.",
      status: "completed",
      priority: "low",
      assigneeUserId: ownerUserId,
      dueAt: null,
      completedAt: "2026-08-18T19:00:00.000Z",
      companyId: phase1Companies[0].id,
      contactId: phase1Contacts[3].id,
      createdByUserId: ownerUserId,
    },
  ] as const;
  for (const task of phase1Tasks) {
    await transaction.query(
      `INSERT INTO tasks
       (id,title,description,status,priority,assignee_user_id,due_at,completed_at,company_id,contact_id,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,1)
       ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title,description=EXCLUDED.description,status=tasks.status,
       priority=EXCLUDED.priority,assignee_user_id=EXCLUDED.assignee_user_id,due_at=EXCLUDED.due_at,
       completed_at=tasks.completed_at,company_id=EXCLUDED.company_id,contact_id=EXCLUDED.contact_id,
       updated_at=EXCLUDED.updated_at`,
      [
        task.id,
        task.title,
        task.description,
        task.status,
        task.priority,
        task.assigneeUserId,
        task.dueAt,
        task.completedAt,
        task.companyId,
        task.contactId,
        task.createdByUserId,
        DEMO_SEED_TIMESTAMP,
      ],
    );
  }

  const phase2Leads = [
    {
      id: "a1000000-0000-4000-8000-000000000001",
      reference: "BEA-LD-000001",
      sourceType: "manual",
      sourceDetails: null,
      receivedAt: "2026-08-20T14:30:00.000Z",
      opportunityName: "Synthetic Harborview envelope inquiry",
      requestSummary:
        "Synthetic manual inquiry about moisture staining on a demonstration facade. Service details are still incomplete.",
      requestedService: null,
      siteName: null,
      siteCity: null,
      siteRegion: null,
      desiredDeadlineAt: null,
      requestedVisitAt: null,
      reviewerUserId: salesUserId,
      status: "new",
      disqualificationReason: null,
      createdByUserId: salesUserId,
    },
    {
      id: "a1000000-0000-4000-8000-000000000002",
      reference: "BEA-LD-000002",
      sourceType: "referral",
      sourceDetails:
        "Referred by synthetic Harborview property manager; not a live referral channel.",
      receivedAt: "2026-08-19T16:00:00.000Z",
      opportunityName: "Synthetic Cedar Ridge roof assessment",
      requestSummary:
        "Referral asked BEA to review a demonstration roof assembly after a leak report.",
      requestedService: "Building envelope assessment",
      siteName: "Cedar Ridge Facilities — synthetic campus",
      siteCity: "Example City",
      siteRegion: "EX",
      desiredDeadlineAt: "2026-09-15T17:00:00.000Z",
      requestedVisitAt: null,
      reviewerUserId: salesUserId,
      status: "needs_info",
      disqualificationReason: null,
      createdByUserId: ownerUserId,
    },
    {
      id: "a1000000-0000-4000-8000-000000000003",
      reference: "BEA-LD-000003",
      sourceType: "in_person",
      sourceDetails: "Captured during a synthetic in-person site conversation. No live connector.",
      receivedAt: "2026-08-18T13:00:00.000Z",
      opportunityName: "Synthetic Northstar curtain-wall review",
      requestSummary:
        "In-person request to inspect a demonstration curtain-wall assembly and prepare a later proposal.",
      requestedService: "Curtain-wall investigation",
      siteName: "Northstar Facade Group — synthetic plaza",
      siteCity: "Example City",
      siteRegion: "EX",
      desiredDeadlineAt: "2026-09-30T17:00:00.000Z",
      requestedVisitAt: "2026-08-28T15:00:00.000Z",
      reviewerUserId: salesUserId,
      status: "ready_for_proposal",
      disqualificationReason: null,
      createdByUserId: salesUserId,
    },
    {
      id: "a1000000-0000-4000-8000-000000000004",
      reference: "BEA-LD-000004",
      sourceType: "manual",
      sourceDetails: "Synthetic out-of-scope request used to demonstrate disqualification.",
      receivedAt: "2026-08-17T11:00:00.000Z",
      opportunityName: "Synthetic interior millwork request",
      requestSummary:
        "Requester asked for interior millwork, which is outside BEA envelope services.",
      requestedService: "Interior millwork",
      siteName: null,
      siteCity: "Example City",
      siteRegion: "EX",
      desiredDeadlineAt: null,
      requestedVisitAt: null,
      reviewerUserId: ownerUserId,
      status: "disqualified",
      disqualificationReason:
        "Synthetic fixture: request is outside BEA building-envelope services.",
      createdByUserId: ownerUserId,
    },
  ] as const;
  for (const lead of phase2Leads) {
    await transaction.query(
      `INSERT INTO leads
       (id,reference,source_type,source_details,received_at,opportunity_name,request_summary,requested_service,
        site_name,site_city,site_region,site_country,desired_deadline_at,requested_visit_at,reviewer_user_id,
        status,disqualification_reason,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'US',$12,$13,$14,$15,$16,$17,$18,$18,1)
       ON CONFLICT (id) DO UPDATE SET reference=EXCLUDED.reference,source_type=EXCLUDED.source_type,
       source_details=EXCLUDED.source_details,received_at=EXCLUDED.received_at,opportunity_name=EXCLUDED.opportunity_name,
       request_summary=EXCLUDED.request_summary,requested_service=EXCLUDED.requested_service,site_name=EXCLUDED.site_name,
       site_city=EXCLUDED.site_city,site_region=EXCLUDED.site_region,desired_deadline_at=EXCLUDED.desired_deadline_at,
       requested_visit_at=EXCLUDED.requested_visit_at,reviewer_user_id=EXCLUDED.reviewer_user_id,status=EXCLUDED.status,
       disqualification_reason=EXCLUDED.disqualification_reason,updated_at=EXCLUDED.updated_at`,
      [
        lead.id,
        lead.reference,
        lead.sourceType,
        lead.sourceDetails,
        lead.receivedAt,
        lead.opportunityName,
        lead.requestSummary,
        lead.requestedService,
        lead.siteName,
        lead.siteCity,
        lead.siteRegion,
        lead.desiredDeadlineAt,
        lead.requestedVisitAt,
        lead.reviewerUserId,
        lead.status,
        lead.disqualificationReason,
        lead.createdByUserId,
        DEMO_SEED_TIMESTAMP,
      ],
    );
  }
  await transaction.query(
    `SELECT setval(
       'bea_lead_reference_seq',
       GREATEST(
         4,
         COALESCE((SELECT MAX(CAST(substring(reference FROM 8) AS INTEGER)) FROM leads WHERE reference ~ '^BEA-LD-[0-9]{6}$'), 0)
       ),
       TRUE
     )`,
  );

  const phase2LeadParties = [
    {
      id: "a1100000-0000-4000-8000-000000000001",
      leadId: phase2Leads[1].id,
      role: "requester",
      companyId: null,
      contactId: null,
      unmatchedCompanyName: null,
      unmatchedContactName: "Alex Referral",
      unmatchedEmail: "alex.referral@example.invalid",
      unmatchedPhone: "+1-555-0140",
    },
    {
      id: "a1100000-0000-4000-8000-000000000002",
      leadId: phase2Leads[1].id,
      role: "client_company",
      companyId: phase1Companies[2].id,
      contactId: null,
      unmatchedCompanyName: "Cedar Ridge Facilities",
      unmatchedContactName: null,
      unmatchedEmail: null,
      unmatchedPhone: null,
    },
    {
      id: "a1100000-0000-4000-8000-000000000003",
      leadId: phase2Leads[2].id,
      role: "client_company",
      companyId: phase1Companies[0].id,
      contactId: null,
      unmatchedCompanyName: "Northstar Facade Group",
      unmatchedContactName: null,
      unmatchedEmail: null,
      unmatchedPhone: null,
    },
    {
      id: "a1100000-0000-4000-8000-000000000004",
      leadId: phase2Leads[2].id,
      role: "primary_contact",
      companyId: phase1Companies[0].id,
      contactId: phase1Contacts[0].id,
      unmatchedCompanyName: null,
      unmatchedContactName: "Morgan Demo",
      unmatchedEmail: "morgan.demo@example.invalid",
      unmatchedPhone: "+1-555-0111",
    },
    {
      id: "a1100000-0000-4000-8000-000000000005",
      leadId: phase2Leads[2].id,
      role: "requester",
      companyId: phase1Companies[0].id,
      contactId: phase1Contacts[3].id,
      unmatchedCompanyName: null,
      unmatchedContactName: "Casey Example",
      unmatchedEmail: "casey.example@example.invalid",
      unmatchedPhone: "+1-555-0114",
    },
    {
      id: "a1100000-0000-4000-8000-000000000006",
      leadId: phase2Leads[3].id,
      role: "requester",
      companyId: null,
      contactId: null,
      unmatchedCompanyName: null,
      unmatchedContactName: "Pat Disqualified",
      unmatchedEmail: "pat.disqualified@example.invalid",
      unmatchedPhone: null,
    },
  ] as const;
  for (const party of phase2LeadParties) {
    await transaction.query(
      `INSERT INTO lead_parties
       (id,lead_id,role,company_id,contact_id,unmatched_company_name,unmatched_contact_name,unmatched_email,unmatched_phone,notes,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Synthetic Phase 2.0 party fixture.',$10,$11,$11,1)
       ON CONFLICT (id) DO UPDATE SET lead_id=EXCLUDED.lead_id,role=EXCLUDED.role,company_id=EXCLUDED.company_id,
       contact_id=EXCLUDED.contact_id,unmatched_company_name=EXCLUDED.unmatched_company_name,
       unmatched_contact_name=EXCLUDED.unmatched_contact_name,unmatched_email=EXCLUDED.unmatched_email,
       unmatched_phone=EXCLUDED.unmatched_phone,updated_at=EXCLUDED.updated_at`,
      [
        party.id,
        party.leadId,
        party.role,
        party.companyId,
        party.contactId,
        party.unmatchedCompanyName,
        party.unmatchedContactName,
        party.unmatchedEmail,
        party.unmatchedPhone,
        ownerUserId,
        DEMO_SEED_TIMESTAMP,
      ],
    );
  }

  const phase2LeadStatusEvents = [
    {
      id: "a1200000-0000-4000-8000-000000000001",
      leadId: phase2Leads[0].id,
      fromStatus: null,
      toStatus: "new",
      reason: null,
    },
    {
      id: "a1200000-0000-4000-8000-000000000002",
      leadId: phase2Leads[1].id,
      fromStatus: null,
      toStatus: "new",
      reason: null,
    },
    {
      id: "a1200000-0000-4000-8000-000000000003",
      leadId: phase2Leads[1].id,
      fromStatus: "new",
      toStatus: "needs_info",
      reason: "Synthetic fixture: site access details are still missing.",
    },
    {
      id: "a1200000-0000-4000-8000-000000000004",
      leadId: phase2Leads[2].id,
      fromStatus: null,
      toStatus: "new",
      reason: null,
    },
    {
      id: "a1200000-0000-4000-8000-000000000005",
      leadId: phase2Leads[2].id,
      fromStatus: "new",
      toStatus: "ready_for_proposal",
      reason: "Synthetic fixture: minimum review information is present.",
    },
    {
      id: "a1200000-0000-4000-8000-000000000006",
      leadId: phase2Leads[3].id,
      fromStatus: null,
      toStatus: "new",
      reason: null,
    },
    {
      id: "a1200000-0000-4000-8000-000000000007",
      leadId: phase2Leads[3].id,
      fromStatus: "new",
      toStatus: "disqualified",
      reason: "Synthetic fixture: request is outside BEA building-envelope services.",
    },
  ] as const;
  for (const event of phase2LeadStatusEvents) {
    await transaction.query(
      `INSERT INTO lead_status_events
       (id,lead_id,from_status,to_status,reason,actor_user_id,correlation_id,metadata,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
       ON CONFLICT (id) DO UPDATE SET from_status=EXCLUDED.from_status,to_status=EXCLUDED.to_status,
       reason=EXCLUDED.reason,metadata=EXCLUDED.metadata`,
      [
        event.id,
        event.leadId,
        event.fromStatus,
        event.toStatus,
        event.reason,
        salesUserId,
        `seed-phase2-lead-${event.toStatus}`,
        JSON.stringify({ synthetic: true }),
        DEMO_SEED_TIMESTAMP,
      ],
    );
  }

  const phase1Activities = [
    {
      id: "93000000-0000-4000-8000-000000000001",
      type: "task.created",
      summary: "Synthetic inquiry review task created.",
      actorUserId: ownerUserId,
      companyId: phase1Companies[1].id,
      contactId: phase1Contacts[1].id,
      taskId: phase1Tasks[0].id,
      correlationId: "seed-phase1-task-created",
      metadata: { synthetic: true },
    },
    {
      id: "93000000-0000-4000-8000-000000000002",
      type: "action.approved",
      summary: "Synthetic task action explicitly approved.",
      actorUserId: ownerUserId,
      companyId: phase1Companies[0].id,
      contactId: phase1Contacts[3].id,
      taskId: phase1Tasks[3].id,
      correlationId: "seed-phase1-action-executed",
      metadata: { synthetic: true },
    },
    {
      id: "93000000-0000-4000-8000-000000000003",
      type: "action.executed",
      summary: "Synthetic confirmed task action executed.",
      actorUserId: ownerUserId,
      companyId: phase1Companies[0].id,
      contactId: phase1Contacts[3].id,
      taskId: phase1Tasks[3].id,
      correlationId: "seed-phase1-action-executed",
      metadata: { synthetic: true, externalActionPerformed: false },
    },
  ] as const;
  for (const activity of phase1Activities) {
    await transaction.query(
      `INSERT INTO activities
       (id,type,summary,actor_user_id,company_id,contact_id,task_id,correlation_id,metadata,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$10,1)
       ON CONFLICT (id) DO UPDATE SET type=EXCLUDED.type,summary=EXCLUDED.summary,actor_user_id=EXCLUDED.actor_user_id,
       company_id=EXCLUDED.company_id,contact_id=EXCLUDED.contact_id,task_id=EXCLUDED.task_id,
       correlation_id=EXCLUDED.correlation_id,metadata=EXCLUDED.metadata,updated_at=EXCLUDED.updated_at`,
      [
        activity.id,
        activity.type,
        activity.summary,
        activity.actorUserId,
        activity.companyId,
        activity.contactId,
        activity.taskId,
        activity.correlationId,
        JSON.stringify(activity.metadata),
        DEMO_SEED_TIMESTAMP,
      ],
    );
  }

  const phase2LeadActivities = [
    {
      id: "93000000-0000-4000-8000-000000000004",
      type: "lead.created",
      summary: "Synthetic manual lead created: BEA-LD-000001",
      leadId: "a1000000-0000-4000-8000-000000000001",
      actorUserId: salesUserId,
    },
    {
      id: "93000000-0000-4000-8000-000000000005",
      type: "lead.created",
      summary: "Synthetic referral lead created: BEA-LD-000002",
      leadId: "a1000000-0000-4000-8000-000000000002",
      actorUserId: ownerUserId,
    },
    {
      id: "93000000-0000-4000-8000-000000000006",
      type: "lead.status-changed",
      summary: "Lead status changed from new to needs_info: BEA-LD-000002",
      leadId: "a1000000-0000-4000-8000-000000000002",
      actorUserId: salesUserId,
    },
    {
      id: "93000000-0000-4000-8000-000000000007",
      type: "lead.status-changed",
      summary: "Lead status changed from new to ready_for_proposal: BEA-LD-000003",
      leadId: "a1000000-0000-4000-8000-000000000003",
      actorUserId: salesUserId,
    },
    {
      id: "93000000-0000-4000-8000-000000000008",
      type: "lead.disqualified",
      summary: "Lead disqualified: BEA-LD-000004",
      leadId: "a1000000-0000-4000-8000-000000000004",
      actorUserId: ownerUserId,
    },
  ] as const;
  for (const activity of phase2LeadActivities) {
    await transaction.query(
      `INSERT INTO activities
       (id,type,summary,actor_user_id,company_id,contact_id,task_id,lead_id,correlation_id,metadata,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,NULL,NULL,NULL,$5,$6,$7::jsonb,$8,$8,1)
       ON CONFLICT (id) DO UPDATE SET type=EXCLUDED.type,summary=EXCLUDED.summary,lead_id=EXCLUDED.lead_id,
       metadata=EXCLUDED.metadata,updated_at=EXCLUDED.updated_at`,
      [
        activity.id,
        activity.type,
        activity.summary,
        activity.actorUserId,
        activity.leadId,
        "seed-phase2-lead",
        JSON.stringify({ synthetic: true, demoOnly: true }),
        DEMO_SEED_TIMESTAMP,
      ],
    );
  }

  const phase1Notifications = [
    {
      id: "94000000-0000-4000-8000-000000000001",
      userId: salesUserId,
      type: "task.assigned",
      title: "Synthetic task assigned",
      body: "Review the synthetic inquiry details.",
      sourceId: phase1Tasks[0].id,
      sourceHref: `/tasks/${phase1Tasks[0].id}`,
      readAt: null,
    },
    {
      id: "94000000-0000-4000-8000-000000000002",
      userId: operationsUserId,
      type: "task.assigned",
      title: "Synthetic operations task assigned",
      body: "Prepare the synthetic operations handoff.",
      sourceId: phase1Tasks[1].id,
      sourceHref: `/tasks/${phase1Tasks[1].id}`,
      readAt: null,
    },
    {
      id: "94000000-0000-4000-8000-000000000003",
      userId: ownerUserId,
      type: "action.executed",
      title: "Synthetic action completed",
      body: "A confirmed simulated task action completed without an external provider.",
      sourceId: phase1Tasks[3].id,
      sourceHref: `/tasks/${phase1Tasks[3].id}`,
      readAt: "2026-08-18T20:00:00.000Z",
    },
  ] as const;
  for (const notification of phase1Notifications) {
    await transaction.query(
      `INSERT INTO notifications
       (id,user_id,type,title,body,source_type,source_id,source_href,read_at,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,'task',$6,$7,$8,$9,$9,1)
       ON CONFLICT (id) DO UPDATE SET user_id=EXCLUDED.user_id,type=EXCLUDED.type,title=EXCLUDED.title,
       body=EXCLUDED.body,source_type=EXCLUDED.source_type,source_id=EXCLUDED.source_id,
       source_href=EXCLUDED.source_href,read_at=COALESCE(notifications.read_at,EXCLUDED.read_at),updated_at=EXCLUDED.updated_at`,
      [
        notification.id,
        notification.userId,
        notification.type,
        notification.title,
        notification.body,
        notification.sourceId,
        notification.sourceHref,
        notification.readAt,
        DEMO_SEED_TIMESTAMP,
      ],
    );
  }

  const phase1Conversations = [
    {
      id: "95000000-0000-4000-8000-000000000001",
      ownerUserId,
      title: "Phase 1 command center demo",
      status: "active",
    },
    {
      id: "95000000-0000-4000-8000-000000000002",
      ownerUserId: salesUserId,
      title: "Synthetic sales workspace",
      status: "active",
    },
  ] as const;
  for (const conversation of phase1Conversations) {
    await transaction.query(
      `INSERT INTO conversations
       (id,owner_user_id,title,provider,model,router_version,status,created_at,updated_at,version)
       VALUES ($1,$2,$3,'simulated','deterministic-demo-router','phase1-demo-router-v1',$4,$5,$5,1)
       ON CONFLICT (id) DO UPDATE SET owner_user_id=EXCLUDED.owner_user_id,title=EXCLUDED.title,provider='simulated',
       model='deterministic-demo-router',router_version=EXCLUDED.router_version,status=conversations.status,
       updated_at=EXCLUDED.updated_at`,
      [
        conversation.id,
        conversation.ownerUserId,
        conversation.title,
        conversation.status,
        DEMO_SEED_TIMESTAMP,
      ],
    );
  }

  const phase1Messages = [
    {
      id: "96000000-0000-4000-8000-000000000001",
      conversationId: phase1Conversations[0].id,
      role: "user",
      content: "Show the synthetic Phase 1 command center summary.",
      provider: null,
      model: null,
      routerVersion: null,
      executionMs: null,
      correlationId: "seed-phase1-command-summary",
      requiredPermissions: [],
    },
    {
      id: "96000000-0000-4000-8000-000000000002",
      conversationId: phase1Conversations[0].id,
      role: "assistant",
      content: "Here is the deterministic local summary. No live provider was called.",
      provider: "simulated",
      model: "deterministic-demo-router",
      routerVersion: "phase1-demo-router-v1",
      executionMs: 0,
      correlationId: "seed-phase1-command-summary",
      requiredPermissions: [PERMISSIONS.AI_COMMAND_VIEW],
    },
    {
      id: "96000000-0000-4000-8000-000000000003",
      conversationId: phase1Conversations[1].id,
      role: "assistant",
      content: "This synthetic workspace is isolated to its owner.",
      provider: "simulated",
      model: "deterministic-demo-router",
      routerVersion: "phase1-demo-router-v1",
      executionMs: 0,
      correlationId: "seed-phase1-sales-workspace",
      requiredPermissions: [PERMISSIONS.AI_COMMAND_VIEW],
    },
  ] as const;
  for (const message of phase1Messages) {
    await transaction.query(
      `INSERT INTO assistant_messages
       (id,conversation_id,role,content,provider,model,router_version,execution_ms,correlation_id,required_permissions,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$11,1)
       ON CONFLICT (id) DO UPDATE SET conversation_id=EXCLUDED.conversation_id,role=EXCLUDED.role,
       content=EXCLUDED.content,provider=EXCLUDED.provider,model=EXCLUDED.model,
       router_version=EXCLUDED.router_version,execution_ms=EXCLUDED.execution_ms,
       correlation_id=EXCLUDED.correlation_id,
       required_permissions=EXCLUDED.required_permissions,updated_at=EXCLUDED.updated_at`,
      [
        message.id,
        message.conversationId,
        message.role,
        message.content,
        message.provider,
        message.model,
        message.routerVersion,
        message.executionMs,
        message.correlationId,
        JSON.stringify(message.requiredPermissions),
        DEMO_SEED_TIMESTAMP,
      ],
    );
  }

  await transaction.query(
    `INSERT INTO workspace_artifacts
     (id,conversation_id,requested_by_user_id,type,title,subtitle,state,payload,sources,links,required_permissions,error_code,created_at,updated_at,version)
     VALUES ($1,$2,$3,'command-center-summary',$4,$5,'ready',$6::jsonb,'[]'::jsonb,$7::jsonb,$8::jsonb,NULL,$9,$9,1)
     ON CONFLICT (id) DO UPDATE SET conversation_id=EXCLUDED.conversation_id,
     requested_by_user_id=EXCLUDED.requested_by_user_id,type=EXCLUDED.type,title=EXCLUDED.title,
     subtitle=EXCLUDED.subtitle,state=EXCLUDED.state,payload=EXCLUDED.payload,sources=EXCLUDED.sources,
     links=EXCLUDED.links,required_permissions=EXCLUDED.required_permissions,error_code=NULL,
     updated_at=EXCLUDED.updated_at`,
    [
      "97000000-0000-4000-8000-000000000001",
      phase1Conversations[0].id,
      ownerUserId,
      "Synthetic command center summary",
      "Deterministic local data only",
      JSON.stringify({ companies: 3, contacts: 4, tasks: 4, simulated: true }),
      JSON.stringify([{ label: "View companies", href: "/companies" }]),
      JSON.stringify([PERMISSIONS.COMPANIES_VIEW, PERMISSIONS.TASKS_VIEW]),
      DEMO_SEED_TIMESTAMP,
    ],
  );

  const phase1SuggestedActions = [
    {
      id: "98000000-0000-4000-8000-000000000001",
      status: "pending",
      payload: {
        title: "Review synthetic contact follow-up",
        priority: "normal",
        assigneeUserId: ownerUserId,
        companyId: phase1Companies[2].id,
        contactId: phase1Contacts[2].id,
      },
      idempotencyKey: "seed:phase1:suggested-task:pending:v1",
      correlationId: "seed-phase1-action-pending",
      expiresAt: "2099-12-31T23:59:59.000Z",
    },
    {
      id: "98000000-0000-4000-8000-000000000002",
      status: "executed",
      payload: {
        title: phase1Tasks[3].title,
        priority: phase1Tasks[3].priority,
        assigneeUserId: ownerUserId,
        companyId: phase1Companies[0].id,
        contactId: phase1Contacts[3].id,
      },
      idempotencyKey: "seed:phase1:suggested-task:executed:v1",
      correlationId: "seed-phase1-action-executed",
      expiresAt: "2099-12-31T23:59:59.000Z",
    },
  ] as const;
  for (const action of phase1SuggestedActions) {
    await transaction.query(
      `INSERT INTO suggested_actions
       (id,conversation_id,requested_by_user_id,action_type,status,payload,required_permission,idempotency_key,correlation_id,expires_at,created_at,updated_at,version)
       VALUES ($1,$2,$3,'task.create',$4,$5::jsonb,$6,$7,$8,$9,$10,$10,1)
       ON CONFLICT (id) DO UPDATE SET conversation_id=EXCLUDED.conversation_id,
       requested_by_user_id=EXCLUDED.requested_by_user_id,action_type='task.create',status=suggested_actions.status,
       payload=EXCLUDED.payload,required_permission=EXCLUDED.required_permission,
       idempotency_key=EXCLUDED.idempotency_key,correlation_id=EXCLUDED.correlation_id,
       expires_at=EXCLUDED.expires_at,updated_at=EXCLUDED.updated_at`,
      [
        action.id,
        phase1Conversations[0].id,
        ownerUserId,
        action.status,
        JSON.stringify(action.payload),
        PERMISSIONS.TASK_ACTION_EXECUTE,
        action.idempotencyKey,
        action.correlationId,
        action.expiresAt,
        DEMO_SEED_TIMESTAMP,
      ],
    );
  }

  await transaction.query(
    `INSERT INTO action_approvals
     (id,suggested_action_id,actor_user_id,decision,correlation_id,created_at,updated_at,version)
     VALUES ($1,$2,$3,'approved',$4,$5,$5,1)
     ON CONFLICT (id) DO UPDATE SET suggested_action_id=EXCLUDED.suggested_action_id,
     actor_user_id=EXCLUDED.actor_user_id,decision='approved',correlation_id=EXCLUDED.correlation_id,
     updated_at=EXCLUDED.updated_at`,
    [
      "98100000-0000-4000-8000-000000000001",
      phase1SuggestedActions[1].id,
      ownerUserId,
      phase1SuggestedActions[1].correlationId,
      DEMO_SEED_TIMESTAMP,
    ],
  );
  await transaction.query(
    `INSERT INTO action_executions
     (id,suggested_action_id,actor_user_id,status,idempotency_key,result,error_code,correlation_id,created_at,updated_at,version)
     VALUES ($1,$2,$3,'succeeded',$4,$5::jsonb,NULL,$6,$7,$7,1)
     ON CONFLICT (id) DO UPDATE SET suggested_action_id=EXCLUDED.suggested_action_id,
     actor_user_id=EXCLUDED.actor_user_id,status='succeeded',idempotency_key=EXCLUDED.idempotency_key,
     result=EXCLUDED.result,error_code=NULL,correlation_id=EXCLUDED.correlation_id,
     updated_at=EXCLUDED.updated_at`,
    [
      "98200000-0000-4000-8000-000000000001",
      phase1SuggestedActions[1].id,
      ownerUserId,
      "seed:phase1:execution:task-create:v1",
      JSON.stringify({ taskId: phase1Tasks[3].id, actionType: "task.create", simulated: true }),
      phase1SuggestedActions[1].correlationId,
      DEMO_SEED_TIMESTAMP,
    ],
  );

  for (const roleKey of Object.values(DEMO_ROLE_IDS)) {
    for (const permission of ROLE_PERMISSION_MATRIX[roleKey]) {
      await transaction.query(
        `INSERT INTO role_permissions (role_id,permission_id,created_at) VALUES ($1,$2,$3)
         ON CONFLICT (role_id,permission_id) DO NOTHING`,
        [roleIds[roleKey], permissionIdByKey.get(permission), DEMO_SEED_TIMESTAMP],
      );
    }
  }

  for (const [index, [key, displayName]] of FEATURE_FLAG_SEEDS.entries()) {
    await transaction.query(
      `INSERT INTO feature_flags (id,key,display_name,description,enabled,requirement_status,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,FALSE,'DEFERRED',$5,$5,1)
       ON CONFLICT (id) DO UPDATE SET key=EXCLUDED.key,display_name=EXCLUDED.display_name,description=EXCLUDED.description,enabled=FALSE,requirement_status='DEFERRED',updated_at=EXCLUDED.updated_at`,
      [
        `40000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        key,
        displayName,
        `${displayName} is deferred beyond Phase 0.`,
        DEMO_SEED_TIMESTAMP,
      ],
    );
  }

  const settings = [
    ["product.display-name", "Cyber Pirate Labs", "public"],
    ["product.name", "BEA Operations Command Center", "public"],
    ["product.legal-entity-name", "UNRESOLVED", "internal"],
    ["runtime.demo-mode", true, "internal"],
  ] as const;
  for (const [index, [key, value, sensitivity]] of settings.entries()) {
    await transaction.query(
      `INSERT INTO system_settings (id,key,value_json,description,sensitivity,created_at,updated_at,version)
       VALUES ($1,$2,$3::jsonb,$4,$5,$6,$6,1)
       ON CONFLICT (id) DO UPDATE SET key=EXCLUDED.key,value_json=EXCLUDED.value_json,description=EXCLUDED.description,sensitivity=EXCLUDED.sensitivity,updated_at=EXCLUDED.updated_at`,
      [
        `50000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        key,
        JSON.stringify(value),
        `Phase 0 setting for ${key}.`,
        sensitivity,
        DEMO_SEED_TIMESTAMP,
      ],
    );
  }

  const phase131Settings = [
    [
      "50000000-0000-4000-8000-000000000006",
      EXECUTIVE_PROFILE_SETTING_KEY,
      SYNTHETIC_EXECUTIVE_PROFILE,
      "Versioned, source-backed Owner Executive Profile. Restricted by executive-profile permissions.",
      "secret",
    ],
    [
      "50000000-0000-4000-8000-000000000007",
      EXECUTIVE_PERSONA_POLICY_SETTING_KEY,
      DEFAULT_EXECUTIVE_PERSONA_POLICY,
      "Versioned server-owned assistant persona policy.",
      "internal",
    ],
    [
      "50000000-0000-4000-8000-000000000008",
      ARTIFACT_BRAND_POLICY_SETTING_KEY,
      DEFAULT_ARTIFACT_BRAND_POLICY,
      "Deterministic application-owned BEA artifact brand policy.",
      "internal",
    ],
  ] as const;
  for (const [id, key, value, description, sensitivity] of phase131Settings) {
    await transaction.query(
      `INSERT INTO system_settings (id,key,value_json,description,sensitivity,created_at,updated_at,version)
       VALUES ($1,$2,$3::jsonb,$4,$5,$6,$6,1)
       ON CONFLICT (key) DO NOTHING`,
      [id, key, JSON.stringify(value), description, sensitivity, DEMO_SEED_TIMESTAMP],
    );
  }

  await transaction.query(
    `INSERT INTO system_settings (id,key,value_json,description,sensitivity,created_at,updated_at,version)
     VALUES ('50000000-0000-4000-8000-000000000005','ai.provider.settings',$1::jsonb,
             'Phase 1.2 provider policy. The standard API key is never stored here.','internal',$2,$2,1)
     ON CONFLICT (key) DO NOTHING`,
    [
      JSON.stringify({
        mode: "demo",
        defaultTextModel: "deterministic-demo-router",
        defaultRealtimeModel: "deterministic-demo-router",
        defaultVoice: "demo",
        webSearchAllowed: false,
        webSearchDefault: false,
        codeInterpreterAllowed: false,
        imageGenerationAllowed: false,
        pdfGenerationAllowed: false,
        realtimeAllowed: true,
        requestTimeoutMs: 30_000,
        modelCacheTtlSeconds: 3_600,
        dailyRequestLimit: 100,
        perUserRequestsPerMinute: 10,
        perConversationRequestsPerMinute: 10,
        maxUploadBytes: 10_000_000,
        maxGeneratedFileBytes: 25_000_000,
        maxResearchDurationSeconds: 300,
        codeInterpreterMaxContainerSeconds: 300,
        imageQuality: "medium",
        defaultChartType: "bar",
        defaultPdfTemplate: "standard",
        artifactRetentionDays: 30,
        monthlyCostLimitUsd: null,
        highCostConfirmationThresholdUsd: null,
        realtimeTurnDetection: "server_vad",
        realtimeInteractionMode: "automatic",
        realtimeAllowInterruption: true,
        inputTranscriptionModel: null,
        realtimeOutputSpeed: 1,
        realtimeSessionInstructions:
          "Assist with authorized BEA work and only propose registered tools.",
        realtimeMaxOutputTokens: 2048,
        modelCapabilityOverrides: {},
      }),
      DEMO_SEED_TIMESTAMP,
    ],
  );

  for (const [index, descriptor] of DEFAULT_MOCK_PROVIDER_DESCRIPTORS.entries()) {
    await transaction.query(
      `INSERT INTO integration_connections
       (id,provider_type,display_name,mode,connection_status,requirement_status,configuration_completeness,required_permissions,test_mode,mock_mode,created_at,updated_at,version)
       VALUES ($1,$2,$3,'mock','simulated','SIMULATED',0,$4::jsonb,TRUE,TRUE,$5,$5,1)
       ON CONFLICT (id) DO UPDATE SET provider_type=EXCLUDED.provider_type,display_name=EXCLUDED.display_name,mode='mock',connection_status='simulated',requirement_status='SIMULATED',configuration_completeness=0,required_permissions=EXCLUDED.required_permissions,external_identifier=NULL,last_successful_sync_at=NULL,last_failure=NULL,test_mode=TRUE,mock_mode=TRUE,updated_at=EXCLUDED.updated_at
       WHERE NOT (integration_connections.provider_type='ai' AND integration_connections.mode='live')`,
      [
        `60000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        descriptor.providerType,
        descriptor.displayName,
        JSON.stringify(descriptor.requiredPermissions),
        DEMO_SEED_TIMESTAMP,
      ],
    );
  }

  await transaction.query(
    `INSERT INTO workflow_runs
     (id,workflow_key,status,trigger_metadata,correlation_id,idempotency_key,started_at,finished_at,retry_count,cancellation_requested,created_at,updated_at,version)
     VALUES ($1,'foundation.system-health-check','succeeded',$2::jsonb,$3,$4,$5,$5,0,FALSE,$5,$5,1)
     ON CONFLICT (id) DO UPDATE SET status='succeeded',trigger_metadata=EXCLUDED.trigger_metadata,finished_at=EXCLUDED.finished_at,error=NULL,updated_at=EXCLUDED.updated_at`,
    [
      "70000000-0000-4000-8000-000000000001",
      JSON.stringify({ source: "deterministic-seed", simulated: true }),
      "seed-correlation-foundation-health",
      "seed:foundation.system-health-check:v1",
      DEMO_SEED_TIMESTAMP,
    ],
  );
  for (const [index, stepKey] of ["database-health", "provider-registry-health"].entries()) {
    await transaction.query(
      `INSERT INTO workflow_step_runs
       (id,workflow_run_id,step_key,sequence,status,started_at,finished_at,result_json,retry_count,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,'succeeded',$5,$5,$6::jsonb,0,$5,$5,1)
       ON CONFLICT (workflow_run_id,step_key) DO UPDATE SET status='succeeded',finished_at=EXCLUDED.finished_at,result_json=EXCLUDED.result_json,error=NULL,updated_at=EXCLUDED.updated_at`,
      [
        `71000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        "70000000-0000-4000-8000-000000000001",
        stepKey,
        index + 1,
        DEMO_SEED_TIMESTAMP,
        JSON.stringify({ simulated: true, healthy: true }),
      ],
    );
  }
  await transaction.query(
    `INSERT INTO audit_logs (id,event_type,action,outcome,metadata,correlation_id,created_at)
     VALUES ($1,'demo.seeded','demo.seed','succeeded',$2::jsonb,$3,$4)
     ON CONFLICT (id) DO UPDATE SET metadata=EXCLUDED.metadata,created_at=EXCLUDED.created_at`,
    [
      "80000000-0000-4000-8000-000000000001",
      JSON.stringify({ deterministic: true, syntheticDataOnly: true }),
      "seed-correlation",
      DEMO_SEED_TIMESTAMP,
    ],
  );

  await seedDigitalWorkforce(transaction);
  const operations = await seedInspectionReportCore(transaction);
  await seedConfigurationStudio(transaction);
  await seedWorkControl(transaction);
  await seedCommercial(transaction);
  await seedGuidedMeridianExperience(transaction);

  return {
    users: DEMO_PERSONAS.length,
    roles: Object.values(DEMO_ROLE_IDS).length,
    permissions: permissionEntries.length,
    featureFlags: FEATURE_FLAG_SEEDS.length,
    integrations: DEFAULT_MOCK_PROVIDER_DESCRIPTORS.length,
    workflowRuns: 1,
    companies: phase1Companies.length,
    contacts: phase1Contacts.length,
    tasks: phase1Tasks.length,
    leads: phase2Leads.length,
    conversations: phase1Conversations.length,
    suggestedActions: phase1SuggestedActions.length,
    projects: operations.projects,
    inspections: operations.inspections,
  };
}

export async function seedDatabase(database: DatabaseAdapter): Promise<SeedSummary> {
  assertDemoSeedAllowed("demo");
  return database.transaction(seedDatabaseOnExecutor);
}
