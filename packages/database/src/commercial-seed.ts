import { assertLegacyRuntimeTestOnly } from "@bea/config";
import { createHash, randomUUID } from "node:crypto";
import {
  COMMERCIAL_SYNTHETIC_DISCLOSURE,
  DEMO_PERSONAS,
  DEMO_ROLE_IDS,
  PRODUCTION_SERVICE_CATALOG_PLACEHOLDER,
  SEEDED_COMMERCIAL_IDS,
  SYNTHETIC_ENVELOPE_CATALOG,
  SYNTHETIC_MOISTURE_CATALOG,
  SYNTHETIC_ORCHESTRATION_POLICY_PAYLOAD,
  WORK_CONTROL_SYNTHETIC_DISCLOSURE,
  WORK_ITEM_REQUIRED_ACTIONS,
  computeCatalogIdentityChecksum,
  tryParseCatalogPackage,
  type ServiceCatalogPackage,
} from "@bea/domain";
import type { SqlExecutor } from "./adapter.js";

const DEMO_SEED_TIMESTAMP = "2026-01-01T00:00:00.000Z";

const ownerId = DEMO_PERSONAS[0].id;
const salesId = DEMO_PERSONAS[1].id;
const READY_LEAD_ID = "a1000000-0000-4000-8000-000000000003";
const MOISTURE_LEAD_ID = "a1000000-0000-4000-8000-000000000005";
const COMPANY_ID = "90000000-0000-4000-8000-000000000001";
const CONTACT_ID = "91000000-0000-4000-8000-000000000001";

function checksum(
  pack: ServiceCatalogPackage,
  catalogId: string,
  catalogVersionId: string,
  versionNumber: number,
): string | null {
  const parsed = tryParseCatalogPackage(pack);
  if (!parsed.ok) return null;
  return computeCatalogIdentityChecksum({
    catalogId,
    catalogVersionId,
    catalogVersionNumber: versionNumber,
    pack: parsed.value,
  });
}

async function insertCatalog(
  transaction: SqlExecutor,
  input: {
    readonly catalogId: string;
    readonly versionId: string;
    readonly pack: ServiceCatalogPackage;
    readonly status: "active" | "draft";
    readonly synthetic: boolean;
  },
): Promise<void> {
  const now = DEMO_SEED_TIMESTAMP;
  const identity = checksum(input.pack, input.catalogId, input.versionId, 1);
  await transaction.query(
    `INSERT INTO service_catalogs
     (id,catalog_key,display_name,service_context_key,synthetic,production_ready,disclosure,created_at,updated_at,version)
     VALUES ($1,$2,$3,$4,$5,FALSE,$6,$7,$7,1)
     ON CONFLICT (id) DO UPDATE SET
       display_name=EXCLUDED.display_name,
       disclosure=EXCLUDED.disclosure,
       updated_at=EXCLUDED.updated_at`,
    [
      input.catalogId,
      input.pack.catalogKey,
      input.pack.displayName,
      input.pack.serviceContextKey,
      input.synthetic,
      input.pack.disclosure,
      now,
    ],
  );
  await transaction.query(
    `INSERT INTO service_catalog_versions
     (id,catalog_id,catalog_key,version_number,status,synthetic,production_ready,service_context_key,currency,
      effective_from,disclosure,checksum,validated_identity_checksum,package_payload,created_by_user_id,
      validated_at,validated_by_user_id,published_at,published_by_user_id,activated_at,activated_by_user_id,
      created_at,updated_at,version)
     VALUES ($1,$2,$3,1,$4,$5,FALSE,$6,$7,$8,$9,$10,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$8,$8,1)
     ON CONFLICT (id) DO UPDATE SET
       status=EXCLUDED.status,
       package_payload=EXCLUDED.package_payload,
       checksum=EXCLUDED.checksum,
       validated_identity_checksum=EXCLUDED.validated_identity_checksum,
       disclosure=EXCLUDED.disclosure,
       updated_at=EXCLUDED.updated_at`,
    [
      input.versionId,
      input.catalogId,
      input.pack.catalogKey,
      input.status,
      input.synthetic,
      input.pack.serviceContextKey,
      input.pack.currency,
      now,
      input.pack.disclosure,
      identity,
      JSON.stringify(input.pack),
      ownerId,
      input.status === "active" ? now : null,
      input.status === "active" ? ownerId : null,
      input.status === "active" ? now : null,
      input.status === "active" ? ownerId : null,
      input.status === "active" ? now : null,
      input.status === "active" ? ownerId : null,
    ],
  );
  await transaction.query("DELETE FROM service_catalog_items WHERE catalog_version_id=$1", [
    input.versionId,
  ]);
  for (const item of input.pack.items) {
    await transaction.query(
      `INSERT INTO service_catalog_items
       (id,catalog_version_id,service_key,service_code,display_name,description,scope_template,
        default_deliverables,default_assumptions,default_exclusions,unit_of_measure,pricing_model,
        default_rate_minor,minimum_quantity_scaled,maximum_quantity_scaled,eligibility_notes,
        required_lead_information,options,effective_from,effective_to,active,display_order,synthetic,
        created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19,$20,$21,$22,$23,$24,$24,1)
       ON CONFLICT (catalog_version_id, service_key) DO UPDATE SET
         display_name=EXCLUDED.display_name,
         default_rate_minor=EXCLUDED.default_rate_minor,
         description=EXCLUDED.description,
         scope_template=EXCLUDED.scope_template,
         updated_at=EXCLUDED.updated_at`,
      [
        randomUUID(),
        input.versionId,
        item.serviceKey,
        item.serviceCode,
        item.displayName,
        item.description,
        item.scopeTemplate,
        JSON.stringify(item.defaultDeliverables),
        JSON.stringify(item.defaultAssumptions),
        JSON.stringify(item.defaultExclusions),
        item.unitOfMeasure,
        item.pricingModel,
        item.defaultRateMinor,
        item.minimumQuantityScaled,
        item.maximumQuantityScaled,
        item.eligibilityNotes,
        JSON.stringify(item.requiredLeadInformation),
        JSON.stringify(item.options),
        item.effectiveFrom,
        item.effectiveTo,
        item.active,
        item.displayOrder,
        item.synthetic,
        now,
      ],
    );
  }
  for (const [kind, payload] of [
    ["terms", input.pack.terms],
    ["approval", input.pack.approval],
    ["proposal_template", input.pack.template],
    ["delivery", input.pack.delivery],
  ] as const) {
    await transaction.query(
      `INSERT INTO commercial_policy_versions
       (id,catalog_version_id,policy_kind,payload,checksum,synthetic,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$7,1)
       ON CONFLICT (catalog_version_id, policy_kind) DO UPDATE SET
         payload=EXCLUDED.payload, checksum=EXCLUDED.checksum, updated_at=EXCLUDED.updated_at`,
      [
        randomUUID(),
        input.versionId,
        kind,
        JSON.stringify(payload),
        createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex"),
        input.synthetic,
        now,
      ],
    );
  }
}

export async function seedCommercial(transaction: SqlExecutor): Promise<void> {
  assertLegacyRuntimeTestOnly(process.env);
  await insertCatalog(transaction, {
    catalogId: SEEDED_COMMERCIAL_IDS.envelopeCatalog,
    versionId: SEEDED_COMMERCIAL_IDS.envelopeVersion1,
    pack: SYNTHETIC_ENVELOPE_CATALOG,
    status: "active",
    synthetic: true,
  });
  await insertCatalog(transaction, {
    catalogId: SEEDED_COMMERCIAL_IDS.moistureCatalog,
    versionId: SEEDED_COMMERCIAL_IDS.moistureVersion1,
    pack: SYNTHETIC_MOISTURE_CATALOG,
    status: "active",
    synthetic: true,
  });
  await insertCatalog(transaction, {
    catalogId: SEEDED_COMMERCIAL_IDS.productionCatalog,
    versionId: SEEDED_COMMERCIAL_IDS.productionDraft,
    pack: PRODUCTION_SERVICE_CATALOG_PLACEHOLDER,
    status: "draft",
    synthetic: false,
  });

  await transaction.query(
    `INSERT INTO leads
     (id,reference,source_type,source_details,received_at,opportunity_name,request_summary,requested_service,
      site_name,site_city,site_region,site_country,desired_deadline_at,requested_visit_at,reviewer_user_id,
      status,disqualification_reason,created_by_user_id,created_at,updated_at,version)
     VALUES ($1,'BEA-LD-000005','manual','Synthetic moisture-catalog demonstration lead. No live connector.',
             $2,'Synthetic Harbor moisture investigation','Lab-only moisture investigation used to prove a second catalog produces a different proposal.',
             'Synthetic moisture investigation','Harborview synthetic annex','Example City','EX','US',$2,$2,$3,
             'ready_for_proposal',NULL,$4,$2,$2,1)
     ON CONFLICT (id) DO UPDATE SET
       opportunity_name=EXCLUDED.opportunity_name,
       status='ready_for_proposal',
       updated_at=EXCLUDED.updated_at`,
    [MOISTURE_LEAD_ID, DEMO_SEED_TIMESTAMP, salesId, ownerId],
  );
  await transaction.query(
    `INSERT INTO lead_parties
     (id,lead_id,role,company_id,contact_id,unmatched_company_name,unmatched_contact_name,unmatched_email,unmatched_phone,notes,created_by_user_id,created_at,updated_at,version)
     VALUES ($1,$2,'client_company',$3,NULL,'Harborview Property Partners',NULL,NULL,NULL,'Synthetic Phase 3.3A party fixture.',$4,$5,$5,1)
     ON CONFLICT (id) DO UPDATE SET company_id=EXCLUDED.company_id, updated_at=EXCLUDED.updated_at`,
    [
      "a1100000-0000-4000-8000-000000000011",
      MOISTURE_LEAD_ID,
      "90000000-0000-4000-8000-000000000002",
      ownerId,
      DEMO_SEED_TIMESTAMP,
    ],
  );
  await transaction.query(
    `INSERT INTO lead_parties
     (id,lead_id,role,company_id,contact_id,unmatched_company_name,unmatched_contact_name,unmatched_email,unmatched_phone,notes,created_by_user_id,created_at,updated_at,version)
     VALUES ($1,$2,'primary_contact',$3,$4,NULL,'Morgan Demo','morgan.demo@example.invalid','+1-555-0111','Synthetic Phase 3.3A party fixture.',$5,$6,$6,1)
     ON CONFLICT (id) DO UPDATE SET contact_id=EXCLUDED.contact_id, updated_at=EXCLUDED.updated_at`,
    [
      "a1100000-0000-4000-8000-000000000012",
      MOISTURE_LEAD_ID,
      COMPANY_ID,
      CONTACT_ID,
      ownerId,
      DEMO_SEED_TIMESTAMP,
    ],
  );
  await transaction.query(
    `SELECT setval(
       'bea_lead_reference_seq',
       GREATEST(
         5,
         COALESCE((SELECT MAX(CAST(substring(reference FROM 8) AS INTEGER)) FROM leads WHERE reference ~ '^BEA-LD-[0-9]{6}$'), 0)
       ),
       TRUE
     )`,
  );

  for (const [id, leadId] of [
    ["f3000000-0000-4000-8000-000000000001", READY_LEAD_ID],
    ["f3000000-0000-4000-8000-000000000002", MOISTURE_LEAD_ID],
  ] as const) {
    await transaction.query(
      `INSERT INTO automation_events
       (id,event_type,schema_version,aggregate_type,aggregate_id,correlation_id,causation_id,occurred_at,recorded_at,actor_type,actor_id,payload,processing_status)
       VALUES ($1,'lead.ready_for_proposal','1','lead',$2,'seed-phase33a',NULL,$3,$3,'user',$4,$5::jsonb,'pending')
       ON CONFLICT (id) DO UPDATE SET payload=EXCLUDED.payload, processing_status='pending'`,
      [
        id,
        leadId,
        DEMO_SEED_TIMESTAMP,
        salesId,
        JSON.stringify({
          leadId,
          synthetic: true,
          disclosure: COMMERCIAL_SYNTHETIC_DISCLOSURE,
        }),
      ],
    );
  }

  await transaction.query(
    `INSERT INTO operational_work_items
     (id,reference,work_item_kind,status,priority,queue_key,assigned_role_key,assigned_user_id,lead_id,
      source_event_id,source_aggregate_type,source_aggregate_id,policy_key,policy_version,idempotency_key,
      cycle_identity,title,reason,required_action,deep_link,available_at,due_at,escalation_level,synthetic,
      correlation_id,created_at,updated_at,version)
     VALUES
     ($1,'BEA-WK-000005','proposal_preparation','open','high','proposal.preparation',$2,$3::uuid,$4::uuid,
      $5::uuid,'lead',$4,$6,1,$7,$8,'Prepare proposal',$9,$10,$11,$12::timestamptz,$13::timestamptz,'none',TRUE,
      'seed-phase33a',$12::timestamptz,$12::timestamptz,1)
     ON CONFLICT (id) DO UPDATE SET
       status='open',
       assigned_user_id=EXCLUDED.assigned_user_id,
       cycle_identity=EXCLUDED.cycle_identity,
       required_action=EXCLUDED.required_action`,
    [
      SEEDED_COMMERCIAL_IDS.prepWork,
      DEMO_ROLE_IDS.SALES,
      salesId,
      READY_LEAD_ID,
      "f3000000-0000-4000-8000-000000000001",
      SYNTHETIC_ORCHESTRATION_POLICY_PAYLOAD.policyKey,
      "seed:phase33a-prep",
      `lead:${READY_LEAD_ID}:proposal-preparation`,
      `Prepare proposal. ${WORK_CONTROL_SYNTHETIC_DISCLOSURE}`,
      WORK_ITEM_REQUIRED_ACTIONS.proposal_preparation,
      `/leads/${READY_LEAD_ID}`,
      DEMO_SEED_TIMESTAMP,
      "2026-01-01T08:00:00.000Z",
    ],
  );
  await transaction.query(
    `SELECT setval(
       'bea_work_item_reference_seq',
       GREATEST(
         (SELECT COALESCE(MAX(CAST(substring(reference FROM 8) AS INTEGER)),0) FROM operational_work_items WHERE reference ~ '^BEA-WK-[0-9]{6}$'),
         5
       ),
       TRUE
     )`,
  );
  await transaction.query(`SELECT setval('bea_proposal_reference_seq', 1, false)`);
}
