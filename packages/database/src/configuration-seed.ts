import { assertLegacyRuntimeTestOnly } from "@bea/config";
import { createHash } from "node:crypto";
import {
  CONFIGURATION_ARTIFACT_KINDS,
  SEEDED_CONFIGURATION_IDS,
  configurationReleaseIdentityMaterial,
  defaultIntakeItems,
  defaultReadinessItems,
  SYNTHETIC_EXTERIOR_PACKAGE,
  SYNTHETIC_MOISTURE_PACKAGE,
  type BoundConfigurationPackage,
  type JsonObject,
} from "@bea/domain";
import { DEMO_PERSONAS } from "@bea/domain";
import type { SqlExecutor } from "./adapter.js";
import { artifactChecksum } from "./configuration-repository.js";

const DEMO_SEED_TIMESTAMP = "2026-01-01T00:00:00.000Z";
const ownerId = DEMO_PERSONAS[0].id;

function artifactId(releaseId: string, kindIndex: number): string {
  const series =
    releaseId === SEEDED_CONFIGURATION_IDS.exteriorRelease
      ? "c1100000"
      : releaseId === SEEDED_CONFIGURATION_IDS.moistureRelease
        ? "c1200000"
        : "c1300000";
  return `${series}-0000-4000-8000-${String(kindIndex).padStart(12, "0")}`;
}

function artifactsOf(pack: BoundConfigurationPackage): readonly {
  readonly kind: (typeof CONFIGURATION_ARTIFACT_KINDS)[number];
  readonly key: string;
  readonly payload: JsonObject;
}[] {
  return [
    {
      kind: "inspection_schema",
      key: pack.schema.schemaKey,
      payload: pack.schema as unknown as JsonObject,
    },
    {
      kind: "mapping_profile",
      key: pack.mapping.profileKey,
      payload: pack.mapping as unknown as JsonObject,
    },
    {
      kind: "validation_rule_set",
      key: pack.validation.ruleSetKey,
      payload: pack.validation as unknown as JsonObject,
    },
    {
      kind: "report_template",
      key: pack.template.templateKey,
      payload: pack.template as unknown as JsonObject,
    },
    {
      kind: "review_policy",
      key: pack.review.policyKey,
      payload: pack.review as unknown as JsonObject,
    },
    {
      kind: "storage_policy",
      key: pack.storage.policyKey,
      payload: pack.storage as unknown as JsonObject,
    },
    {
      kind: "delivery_policy",
      key: pack.delivery.policyKey,
      payload: pack.delivery as unknown as JsonObject,
    },
    { kind: "sla_policy", key: pack.sla.policyKey, payload: pack.sla as unknown as JsonObject },
    {
      kind: "workflow_blueprint",
      key: pack.workflow.policyKey,
      payload: pack.workflow as unknown as JsonObject,
    },
  ];
}

async function seedRelease(
  transaction: SqlExecutor,
  input: {
    readonly id: string;
    readonly pack: BoundConfigurationPackage;
    readonly status: "published" | "active" | "draft";
    readonly productionReady?: boolean;
  },
): Promise<void> {
  const checksum =
    input.status === "draft"
      ? null
      : createHash("sha256")
          .update(
            configurationReleaseIdentityMaterial({
              releaseId: input.id,
              versionNumber: 1,
              artifacts: artifactsOf(input.pack).map((item) => ({
                artifactKind: item.kind,
                artifactKey: item.key,
                payloadChecksum: artifactChecksum(item.payload),
              })),
            }),
            "utf8",
          )
          .digest("hex");
  await transaction.query(
    `INSERT INTO configuration_releases
     (id,family_key,display_name,version_number,status,synthetic,production_ready,service_context_key,description,disclosure,checksum,validated_identity_checksum,created_by_user_id,validated_at,validated_by_user_id,published_at,published_by_user_id,activated_at,activated_by_user_id,created_at,updated_at,version)
     VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$11,$12,$11,$13,$14,$12,$12,1)
     ON CONFLICT (id) DO UPDATE SET
       display_name=EXCLUDED.display_name,
       status=EXCLUDED.status,
       synthetic=EXCLUDED.synthetic,
       production_ready=EXCLUDED.production_ready,
       disclosure=EXCLUDED.disclosure,
       checksum=EXCLUDED.checksum,
       validated_identity_checksum=EXCLUDED.validated_identity_checksum,
       updated_at=EXCLUDED.updated_at`,
    [
      input.id,
      input.pack.release.familyKey,
      input.pack.release.displayName,
      input.status,
      input.pack.release.synthetic,
      input.productionReady === true,
      input.pack.release.serviceContextKey,
      `${input.pack.release.displayName} demonstration release. Not a BEA production service definition.`,
      input.pack.release.disclosure,
      input.status === "draft" ? null : checksum,
      ownerId,
      DEMO_SEED_TIMESTAMP,
      input.status === "active" ? DEMO_SEED_TIMESTAMP : null,
      input.status === "active" ? ownerId : null,
    ],
  );
  if (input.status === "draft") return;
  for (const artifact of artifactsOf(input.pack)) {
    await transaction.query(
      `INSERT INTO configuration_artifacts
       (id,release_id,artifact_kind,artifact_key,payload,checksum,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$7)
       ON CONFLICT (release_id, artifact_kind) DO UPDATE SET
         artifact_key=EXCLUDED.artifact_key,
         payload=EXCLUDED.payload,
         checksum=EXCLUDED.checksum,
         updated_at=EXCLUDED.updated_at`,
      [
        artifactId(input.id, CONFIGURATION_ARTIFACT_KINDS.indexOf(artifact.kind) + 1),
        input.id,
        artifact.kind,
        artifact.key,
        JSON.stringify(artifact.payload),
        artifactChecksum(artifact.payload),
        DEMO_SEED_TIMESTAMP,
      ],
    );
  }
}

export async function seedConfigurationStudio(transaction: SqlExecutor): Promise<{
  readonly releases: number;
  readonly readinessItems: number;
  readonly intakeItems: number;
}> {
  assertLegacyRuntimeTestOnly(process.env);
  await seedRelease(transaction, {
    id: SEEDED_CONFIGURATION_IDS.exteriorRelease,
    pack: SYNTHETIC_EXTERIOR_PACKAGE,
    status: "active",
  });
  await seedRelease(transaction, {
    id: SEEDED_CONFIGURATION_IDS.moistureRelease,
    pack: SYNTHETIC_MOISTURE_PACKAGE,
    status: "active",
  });
  await transaction.query(
    `INSERT INTO configuration_releases
     (id,family_key,display_name,version_number,status,synthetic,production_ready,service_context_key,description,disclosure,created_by_user_id,created_at,updated_at,version)
     VALUES ($1,'bea-production-inspection-report','BEA production inspection report (unconfigured)',1,'draft',FALSE,FALSE,'bea-production-inspection-report',$2,$3,$4,$5,$5,1)
     ON CONFLICT (id) DO UPDATE SET
       status='draft', synthetic=FALSE, production_ready=FALSE, updated_at=EXCLUDED.updated_at`,
    [
      SEEDED_CONFIGURATION_IDS.productionDraft,
      "Placeholder draft only. Not active and not ready. Waiting for Thursday mapping materials.",
      "BEA PRODUCTION POLICY: UNCONFIGURED. This draft must not be activated.",
      ownerId,
      DEMO_SEED_TIMESTAMP,
    ],
  );

  const readiness = defaultReadinessItems(DEMO_SEED_TIMESTAMP);
  for (const item of readiness) {
    await transaction.query(
      `INSERT INTO configuration_readiness_items
       (id,gap_key,area,description,current_synthetic_behavior,why_confirmation_required,blocking_stage,responsible_person,target_meeting,status,resolution,configuration_artifact_kind,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,1)
       ON CONFLICT (gap_key) DO UPDATE SET
         description=EXCLUDED.description,
         current_synthetic_behavior=EXCLUDED.current_synthetic_behavior,
         why_confirmation_required=EXCLUDED.why_confirmation_required,
         status=EXCLUDED.status,
         updated_at=EXCLUDED.updated_at`,
      [
        item.id,
        item.gapKey,
        item.area,
        item.description,
        item.currentSyntheticBehavior,
        item.whyConfirmationRequired,
        item.blockingStage,
        item.responsiblePerson,
        item.targetMeeting,
        item.status,
        item.resolution,
        item.configurationArtifactKind,
        DEMO_SEED_TIMESTAMP,
      ],
    );
  }

  const intake = defaultIntakeItems(DEMO_SEED_TIMESTAMP);
  for (const item of intake) {
    await transaction.query(
      `INSERT INTO configuration_intake_items
       (id,question_key,section_key,prompt,status,answer,notes,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,1)
       ON CONFLICT (question_key) DO UPDATE SET
         prompt=EXCLUDED.prompt,
         status=EXCLUDED.status,
         notes=EXCLUDED.notes,
         updated_at=EXCLUDED.updated_at`,
      [
        item.id,
        item.questionKey,
        item.sectionKey,
        item.prompt,
        item.status,
        item.answer,
        item.notes,
        DEMO_SEED_TIMESTAMP,
      ],
    );
  }

  return {
    releases: 3,
    readinessItems: readiness.length,
    intakeItems: intake.length,
  };
}
