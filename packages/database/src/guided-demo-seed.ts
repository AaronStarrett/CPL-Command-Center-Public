import { assertLegacyRuntimeTestOnly } from "@bea/config";
import { createHash, randomUUID } from "node:crypto";
import {
  DEMO_PERSONAS,
  GUIDED_DEMO_FEATURE_FLAG_KEY,
  GUIDED_DEMO_SCENARIO_KEY,
  GUIDED_DEMO_SCENARIO_VERSION,
  GUIDED_DEMO_STAGES,
  MERIDIAN_CLIENT,
  SEEDED_MERIDIAN_IDS,
  SYNTHETIC_DEMONSTRATION_NOTICE,
  SYNTHETIC_MERIDIAN_CATALOG,
  computeCatalogIdentityChecksum,
  tryParseCatalogPackage,
  type ServiceCatalogPackage,
} from "@bea/domain";
import type { SqlExecutor } from "./adapter.js";

const DEMO_SEED_TIMESTAMP = "2026-01-01T00:00:00.000Z";
const ownerId = DEMO_PERSONAS[0].id;

function catalogChecksum(
  pack: ServiceCatalogPackage,
  catalogId: string,
  catalogVersionId: string,
): string | null {
  const parsed = tryParseCatalogPackage(pack);
  if (!parsed.ok) return null;
  return computeCatalogIdentityChecksum({
    catalogId,
    catalogVersionId,
    catalogVersionNumber: 1,
    pack: parsed.value,
  });
}

export async function seedGuidedMeridianExperience(transaction: SqlExecutor): Promise<void> {
  assertLegacyRuntimeTestOnly(process.env);
  await transaction.query(
    `INSERT INTO feature_flags (id,key,display_name,description,enabled,requirement_status,created_at,updated_at,version)
     VALUES ($1,$2,$3,$4,TRUE,'IMPLEMENTED',$5,$5,1)
     ON CONFLICT (id) DO UPDATE SET
       key=EXCLUDED.key, display_name=EXCLUDED.display_name, description=EXCLUDED.description,
       enabled=TRUE, requirement_status='IMPLEMENTED', updated_at=EXCLUDED.updated_at`,
    [
      SEEDED_MERIDIAN_IDS.featureFlag,
      GUIDED_DEMO_FEATURE_FLAG_KEY,
      "Guided Meridian demonstration",
      "Demo-only guided Meridian Commerce Center story. Disabled outside APP_MODE=demo.",
      DEMO_SEED_TIMESTAMP,
    ],
  );

  await transaction.query(
    `INSERT INTO companies
     (id,name,industry,status,website,phone,notes,created_by_user_id,created_at,updated_at,version)
     VALUES ($1,$2,'Commercial real estate','active',$3,$4,$5,$6,$7,$7,1)
     ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, notes=EXCLUDED.notes, updated_at=EXCLUDED.updated_at`,
    [
      SEEDED_MERIDIAN_IDS.company,
      MERIDIAN_CLIENT.companyName,
      "https://meridian-property.invalid",
      "+1-555-0140",
      `${SYNTHETIC_DEMONSTRATION_NOTICE} Multi-building commercial property used only in the Meridian Commerce Center guided demonstration.`,
      ownerId,
      DEMO_SEED_TIMESTAMP,
    ],
  );

  await transaction.query(
    `INSERT INTO contacts
     (id,company_id,first_name,last_name,job_title,email,phone,status,notes,created_by_user_id,created_at,updated_at,version)
     VALUES ($1,$2,'Elena','Torres',$3,$4,'+1-555-0141','active',$5,$6,$7,$7,1)
     ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email, notes=EXCLUDED.notes, updated_at=EXCLUDED.updated_at`,
    [
      SEEDED_MERIDIAN_IDS.contact,
      SEEDED_MERIDIAN_IDS.company,
      MERIDIAN_CLIENT.contactTitle,
      MERIDIAN_CLIENT.email,
      `${SYNTHETIC_DEMONSTRATION_NOTICE} Synthetic facilities contact. No real person.`,
      ownerId,
      DEMO_SEED_TIMESTAMP,
    ],
  );

  const pack = SYNTHETIC_MERIDIAN_CATALOG;
  const identity = catalogChecksum(
    pack,
    SEEDED_MERIDIAN_IDS.catalog,
    SEEDED_MERIDIAN_IDS.catalogVersion,
  );
  await transaction.query(
    `INSERT INTO service_catalogs
     (id,catalog_key,display_name,service_context_key,synthetic,production_ready,disclosure,created_at,updated_at,version)
     VALUES ($1,$2,$3,$4,TRUE,FALSE,$5,$6,$6,1)
     ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name, disclosure=EXCLUDED.disclosure, updated_at=EXCLUDED.updated_at`,
    [
      SEEDED_MERIDIAN_IDS.catalog,
      pack.catalogKey,
      pack.displayName,
      pack.serviceContextKey,
      pack.disclosure,
      DEMO_SEED_TIMESTAMP,
    ],
  );
  await transaction.query(
    `INSERT INTO service_catalog_versions
     (id,catalog_id,catalog_key,version_number,status,synthetic,production_ready,service_context_key,currency,
      effective_from,disclosure,checksum,validated_identity_checksum,package_payload,created_by_user_id,
      validated_at,validated_by_user_id,published_at,published_by_user_id,activated_at,activated_by_user_id,
      created_at,updated_at,version)
     VALUES ($1,$2,$3,1,'active',TRUE,FALSE,$4,$5,$6,$7,$8,$8,$9::jsonb,$10,$6,$10,$6,$10,$6,$10,$6,$6,1)
     ON CONFLICT (id) DO UPDATE SET
       status='active', package_payload=EXCLUDED.package_payload, checksum=EXCLUDED.checksum,
       validated_identity_checksum=EXCLUDED.validated_identity_checksum, updated_at=EXCLUDED.updated_at`,
    [
      SEEDED_MERIDIAN_IDS.catalogVersion,
      SEEDED_MERIDIAN_IDS.catalog,
      pack.catalogKey,
      pack.serviceContextKey,
      pack.currency,
      DEMO_SEED_TIMESTAMP,
      pack.disclosure,
      identity,
      JSON.stringify(pack),
      ownerId,
    ],
  );
  await transaction.query("DELETE FROM service_catalog_items WHERE catalog_version_id=$1", [
    SEEDED_MERIDIAN_IDS.catalogVersion,
  ]);
  for (const item of pack.items) {
    await transaction.query(
      `INSERT INTO service_catalog_items
       (id,catalog_version_id,service_key,service_code,display_name,description,scope_template,
        default_deliverables,default_assumptions,default_exclusions,unit_of_measure,pricing_model,
        default_rate_minor,minimum_quantity_scaled,maximum_quantity_scaled,eligibility_notes,
        required_lead_information,options,effective_from,effective_to,active,display_order,synthetic,
        created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19,$20,$21,$22,$23,$24,$24,1)
       ON CONFLICT (catalog_version_id, service_key) DO UPDATE SET
         display_name=EXCLUDED.display_name, default_rate_minor=EXCLUDED.default_rate_minor, updated_at=EXCLUDED.updated_at`,
      [
        randomUUID(),
        SEEDED_MERIDIAN_IDS.catalogVersion,
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
        DEMO_SEED_TIMESTAMP,
      ],
    );
  }
  for (const [kind, payload] of [
    ["terms", pack.terms],
    ["approval", pack.approval],
    ["proposal_template", pack.template],
    ["delivery", pack.delivery],
  ] as const) {
    await transaction.query(
      `INSERT INTO commercial_policy_versions
       (id,catalog_version_id,policy_kind,payload,checksum,synthetic,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4::jsonb,$5,TRUE,$6,$6,1)
       ON CONFLICT (catalog_version_id, policy_kind) DO UPDATE SET
         payload=EXCLUDED.payload, checksum=EXCLUDED.checksum, updated_at=EXCLUDED.updated_at`,
      [
        randomUUID(),
        SEEDED_MERIDIAN_IDS.catalogVersion,
        kind,
        JSON.stringify(payload),
        createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex"),
        DEMO_SEED_TIMESTAMP,
      ],
    );
  }

  const existing = await transaction.query<{ id: string }>(
    `SELECT id FROM guided_demo_runs
      WHERE scenario_key=$1 AND archived_at IS NULL AND status <> 'archived'
      LIMIT 1`,
    [GUIDED_DEMO_SCENARIO_KEY],
  );
  if (existing.rows[0]) return;

  await transaction.query(
    `INSERT INTO guided_demo_runs
     (id,scenario_key,scenario_version,status,machine_state,speed_mode,record_bindings,
      current_activity_index,failure_armed,presentation_mode,optimistic_version,created_at,updated_at)
     VALUES ($1,$2,$3,'not_started','not_started','normal',$4::jsonb,0,FALSE,FALSE,1,$5,$5)
     ON CONFLICT (id) DO NOTHING`,
    [
      SEEDED_MERIDIAN_IDS.initialRun,
      GUIDED_DEMO_SCENARIO_KEY,
      GUIDED_DEMO_SCENARIO_VERSION,
      JSON.stringify({
        companyId: SEEDED_MERIDIAN_IDS.company,
        contactId: SEEDED_MERIDIAN_IDS.contact,
        catalogVersionId: SEEDED_MERIDIAN_IDS.catalogVersion,
      }),
      DEMO_SEED_TIMESTAMP,
    ],
  );
  for (const stage of GUIDED_DEMO_STAGES) {
    await transaction.query(
      `INSERT INTO guided_demo_stage_states
       (id,demo_run_id,stage_key,stage_order,status,backing_type,owner_role_key,
        input_summary,output_summary,linked_records,updated_at)
       VALUES ($1,$2,$3,$4,'waiting',$5,$6,'{}'::jsonb,'{}'::jsonb,$7::jsonb,$8)
       ON CONFLICT (demo_run_id, stage_key) DO NOTHING`,
      [
        randomUUID(),
        SEEDED_MERIDIAN_IDS.initialRun,
        stage.key,
        stage.order,
        stage.backingType,
        stage.ownerRoleKey,
        JSON.stringify({
          companyId: SEEDED_MERIDIAN_IDS.company,
          contactId: SEEDED_MERIDIAN_IDS.contact,
        }),
        DEMO_SEED_TIMESTAMP,
      ],
    );
  }
}
