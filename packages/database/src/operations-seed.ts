import { assertLegacyRuntimeTestOnly } from "@bea/config";
import {
  DEFAULT_SYNTHETIC_REQUIREMENTS,
  DEMO_PERSONAS,
  SEEDED_OPERATIONS_IDS,
  SYNTHETIC_REPORT_DISCLOSURE,
  SYNTHETIC_REPORT_TEMPLATE_KEY,
  syntheticInspectionCompletedAt,
  type JsonObject,
} from "@bea/domain";
import { INSPECTION_REPORT_BLUEPRINTS, SYNTHETIC_RENDERER_KEY } from "@bea/automation";
import type { SqlExecutor } from "./adapter.js";

const DEMO_SEED_TIMESTAMP = "2026-01-01T00:00:00.000Z";
const ownerId = DEMO_PERSONAS[0].id;
const operationsId = DEMO_PERSONAS[2].id;
const companyId = "90000000-0000-4000-8000-000000000001";
const readyLeadId = "a1000000-0000-4000-8000-000000000003";

export async function seedInspectionReportCore(transaction: SqlExecutor): Promise<{
  readonly projects: number;
  readonly inspections: number;
}> {
  assertLegacyRuntimeTestOnly(process.env);
  for (const blueprint of INSPECTION_REPORT_BLUEPRINTS) {
    await transaction.query(
      `INSERT INTO automation_blueprints
       (id,key,display_name,blueprint_version,status,trigger_event_type,actions,parameters,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,'active',$5,$6::jsonb,$7::jsonb,$8,$8,1)
       ON CONFLICT (key, blueprint_version) DO UPDATE SET
       display_name=EXCLUDED.display_name,status='active',actions=EXCLUDED.actions,
       parameters=EXCLUDED.parameters,updated_at=EXCLUDED.updated_at`,
      [
        `b4000000-0000-4000-8000-${String(INSPECTION_REPORT_BLUEPRINTS.indexOf(blueprint) + 1).padStart(12, "0")}`,
        blueprint.key,
        blueprint.displayName,
        blueprint.blueprintVersion,
        blueprint.triggerEventType,
        JSON.stringify(blueprint.actions),
        JSON.stringify(blueprint.parameters),
        DEMO_SEED_TIMESTAMP,
      ],
    );
  }

  await transaction.query(
    `INSERT INTO report_templates (id,key,name,synthetic,status,created_at,updated_at,version)
     VALUES ($1,$2,$3,TRUE,'active',$4,$4,1)
     ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,synthetic=TRUE,status='active',updated_at=EXCLUDED.updated_at`,
    [
      SEEDED_OPERATIONS_IDS.template,
      SYNTHETIC_REPORT_TEMPLATE_KEY,
      "BEA Synthetic Inspection Report",
      DEMO_SEED_TIMESTAMP,
    ],
  );
  await transaction.query(
    `INSERT INTO report_template_versions
     (id,template_id,version_number,mapping,requirements,renderer_key,disclosure,created_at)
     VALUES ($1,$2,1,$3::jsonb,$4::jsonb,$5,$6,$7)
     ON CONFLICT (template_id, version_number) DO UPDATE SET
     mapping=EXCLUDED.mapping,requirements=EXCLUDED.requirements,renderer_key=EXCLUDED.renderer_key,disclosure=EXCLUDED.disclosure`,
    [
      SEEDED_OPERATIONS_IDS.templateVersion,
      SEEDED_OPERATIONS_IDS.template,
      JSON.stringify({ clientName: "clientName", siteName: "siteName", findings: "findings" }),
      JSON.stringify(DEFAULT_SYNTHETIC_REQUIREMENTS),
      SYNTHETIC_RENDERER_KEY,
      SYNTHETIC_REPORT_DISCLOSURE,
      DEMO_SEED_TIMESTAMP,
    ],
  );

  const projects = [
    {
      id: SEEDED_OPERATIONS_IDS.happyProject,
      reference: "BEA-PR-000001",
      name: "Synthetic Northstar curtain-wall inspection",
      siteName: "Northstar Tower",
      siteCity: "Chicago",
      siteRegion: "IL",
    },
    {
      id: SEEDED_OPERATIONS_IDS.blockedProject,
      reference: "BEA-PR-000002",
      name: "Synthetic Harborview roof inspection",
      siteName: "Harborview Plaza",
      siteCity: "Milwaukee",
      siteRegion: "WI",
    },
  ] as const;

  for (const project of projects) {
    await transaction.query(
      `INSERT INTO projects
       (id,reference,lead_id,company_id,name,client_name,site_name,site_city,site_region,service_key,status,accepted_scope_snapshot,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,'Northstar Facade Group',$6,$7,$8,'building-envelope-inspection','fieldwork',$9::jsonb,$10,$11,$11,1)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,status=EXCLUDED.status,updated_at=EXCLUDED.updated_at`,
      [
        project.id,
        project.reference,
        readyLeadId,
        companyId,
        project.name,
        project.siteName,
        project.siteCity,
        project.siteRegion,
        JSON.stringify({
          synthetic: true,
          disclosure: "Accepted scope snapshot is a synthetic placeholder, not a commercial award.",
          serviceKey: "building-envelope-inspection",
        }),
        ownerId,
        DEMO_SEED_TIMESTAMP,
      ],
    );
  }

  const inspections = [
    {
      id: SEEDED_OPERATIONS_IDS.happyInspection,
      reference: "BEA-IN-000001",
      projectId: SEEDED_OPERATIONS_IDS.happyProject,
    },
    {
      id: SEEDED_OPERATIONS_IDS.blockedInspection,
      reference: "BEA-IN-000002",
      projectId: SEEDED_OPERATIONS_IDS.blockedProject,
    },
  ] as const;

  for (const inspection of inspections) {
    await transaction.query(
      `INSERT INTO inspections
       (id,reference,project_id,status,inspector_user_id,reviewer_user_id,scheduled_at,started_at,completed_at,service_key,report_template_id,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,$2,$3,'completed',$4,$5,$6,$6,NULL,'building-envelope-inspection',$7,$5,$6,$6,1)
       ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status,inspector_user_id=EXCLUDED.inspector_user_id,reviewer_user_id=EXCLUDED.reviewer_user_id,completed_at=EXCLUDED.completed_at,updated_at=EXCLUDED.updated_at`,
      [
        inspection.id,
        inspection.reference,
        inspection.projectId,
        operationsId,
        ownerId,
        DEMO_SEED_TIMESTAMP,
        SEEDED_OPERATIONS_IDS.template,
      ],
    );
    await transaction.query(
      `INSERT INTO inspection_assignments (id,inspection_id,user_id,assignment_role,assigned_at,assigned_by_user_id)
       VALUES ($1,$2,$3,'inspector',$4,$5)
       ON CONFLICT (inspection_id, assignment_role, user_id) DO NOTHING`,
      [
        inspection.id.replace("b2000000", "b2100000"),
        inspection.id,
        operationsId,
        DEMO_SEED_TIMESTAMP,
        ownerId,
      ],
    );
    await transaction.query(
      `INSERT INTO inspection_assignments (id,inspection_id,user_id,assignment_role,assigned_at,assigned_by_user_id)
       VALUES ($1,$2,$3,'reviewer',$4,$5)
       ON CONFLICT (inspection_id, assignment_role, user_id) DO NOTHING`,
      [
        inspection.id.replace("b2000000", "b2200000"),
        inspection.id,
        ownerId,
        DEMO_SEED_TIMESTAMP,
        ownerId,
      ],
    );
  }

  const connectors = [
    ["outlook-email", "Outlook email", "not_connected", "Connect and verify before any live send."],
    ["sharepoint", "SharePoint", "not_connected", "Connect and map libraries before file writes."],
    ["outlook-calendar", "Outlook calendar", "not_connected", "Connect before scheduling writes."],
    [
      "local-test-delivery",
      "Local test delivery adapter",
      "ready_for_activation",
      "Synthetic adapter only. Not a live client channel.",
    ],
  ] as const;
  for (const [index, [providerType, displayName, status, requiredAction]] of connectors.entries()) {
    await transaction.query(
      `INSERT INTO connector_readiness
       (id,provider_type,display_name,readiness_status,required_action,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,$6,$6,1)
       ON CONFLICT (provider_type, display_name) DO UPDATE SET
       readiness_status=EXCLUDED.readiness_status,required_action=EXCLUDED.required_action,updated_at=EXCLUDED.updated_at`,
      [
        `b5000000-0000-4000-8000-00000000000${index + 1}`,
        providerType,
        displayName,
        status,
        requiredAction,
        DEMO_SEED_TIMESTAMP,
      ],
    );
  }

  await transaction.query(
    `SELECT setval('bea_project_reference_seq', GREATEST((SELECT COALESCE(MAX(CAST(substring(reference FROM 8) AS INTEGER)),0) FROM projects WHERE reference ~ '^BEA-PR-[0-9]{6}$'), 1), true)`,
  );
  await transaction.query(
    `SELECT setval('bea_inspection_reference_seq', GREATEST((SELECT COALESCE(MAX(CAST(substring(reference FROM 8) AS INTEGER)),0) FROM inspections WHERE reference ~ '^BEA-IN-[0-9]{6}$'), 1), true)`,
  );

  return { projects: projects.length, inspections: inspections.length };
}

export function completeSyntheticSubmissionPayload(now: Date = new Date()): JsonObject {
  return {
    clientName: "Northstar Facade Group",
    siteName: "Northstar Tower",
    inspectorName: "Operations Coordinator",
    completedAt: syntheticInspectionCompletedAt(now),
    serviceKey: "building-envelope-inspection",
    attestation: true,
    summary: "Synthetic complete inspection package for automation demonstration.",
    findings: [
      {
        code: "F-1",
        sectionKey: "envelope",
        title: "Sealant discontinuity",
        description: "Observed sealant gap at the south curtain-wall stack joint.",
        severity: "major",
        location: "South elevation, level 12",
      },
    ],
    evidence: [
      {
        findingCode: "F-1",
        kind: "photo",
        filename: "south-joint.jpg",
        contentType: "image/jpeg",
        sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        byteLength: 2048,
        storageRef: "synthetic://evidence/south-joint.jpg",
      },
      {
        kind: "signature",
        filename: "inspector-attestation.sig",
        contentType: "application/octet-stream",
        sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        byteLength: 128,
        storageRef: "synthetic://evidence/inspector-attestation.sig",
      },
    ],
  } as JsonObject;
}

export function incompleteSyntheticSubmissionPayload(now: Date = new Date()): JsonObject {
  return {
    clientName: "Harborview Property Partners",
    siteName: "",
    inspectorName: "",
    completedAt: syntheticInspectionCompletedAt(now),
    attestation: false,
    findings: [],
    evidence: [],
  };
}
