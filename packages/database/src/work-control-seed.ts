import { assertLegacyRuntimeTestOnly } from "@bea/config";
import {
  DEMO_PERSONAS,
  DEMO_ROLE_IDS,
  EMAIL_DRY_RUN_DISCLOSURE,
  SEEDED_OPERATIONS_IDS,
  SEEDED_WORK_CONTROL_IDS,
  SYNTHETIC_NOTIFICATION_RECIPIENT,
  SYNTHETIC_WORK_ROUTING_BLUEPRINTS,
  TEAMS_DRY_RUN_DISCLOSURE,
  WORK_CONTROL_PRODUCTION_UNCONFIGURED,
  WORK_CONTROL_SYNTHETIC_DISCLOSURE,
  PRODUCTION_ORCHESTRATION_POLICY_PAYLOAD,
  SYNTHETIC_ORCHESTRATION_POLICY_PAYLOAD,
  WORK_ITEM_REQUIRED_ACTIONS,
  type WorkItemKind,
} from "@bea/domain";
import type { SqlExecutor } from "./adapter.js";

const DEMO_SEED_TIMESTAMP = "2026-01-01T00:00:00.000Z";
const ownerId = DEMO_PERSONAS[0].id;
const operationsId = DEMO_PERSONAS[2].id;

function blueprintId(index: number): string {
  return `d1100000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

export async function seedWorkControl(transaction: SqlExecutor): Promise<void> {
  assertLegacyRuntimeTestOnly(process.env);
  await transaction.query(
    `INSERT INTO orchestration_policy_versions
     (id,policy_key,policy_version,status,synthetic,production_ready,service_context_key,disclosure,payload,created_at,updated_at,version)
     VALUES ($1,$2,1,'active',TRUE,FALSE,'synthetic-operations',$3,$4::jsonb,$5,$5,1)
     ON CONFLICT (policy_key, policy_version) DO UPDATE SET
       status='active', disclosure=EXCLUDED.disclosure, payload=EXCLUDED.payload, updated_at=EXCLUDED.updated_at`,
    [
      SEEDED_WORK_CONTROL_IDS.syntheticPolicy,
      SYNTHETIC_ORCHESTRATION_POLICY_PAYLOAD.policyKey,
      WORK_CONTROL_SYNTHETIC_DISCLOSURE,
      JSON.stringify(SYNTHETIC_ORCHESTRATION_POLICY_PAYLOAD),
      DEMO_SEED_TIMESTAMP,
    ],
  );
  await transaction.query(
    `INSERT INTO orchestration_policy_versions
     (id,policy_key,policy_version,status,synthetic,production_ready,service_context_key,disclosure,payload,created_at,updated_at,version)
     VALUES ($1,$2,1,'draft',FALSE,FALSE,'bea-production-inspection-report',$3,$4::jsonb,$5,$5,1)
     ON CONFLICT (policy_key, policy_version) DO UPDATE SET
       status='draft', production_ready=FALSE, disclosure=EXCLUDED.disclosure, payload=EXCLUDED.payload, updated_at=EXCLUDED.updated_at`,
    [
      SEEDED_WORK_CONTROL_IDS.productionPolicy,
      PRODUCTION_ORCHESTRATION_POLICY_PAYLOAD.policyKey,
      WORK_CONTROL_PRODUCTION_UNCONFIGURED,
      JSON.stringify(PRODUCTION_ORCHESTRATION_POLICY_PAYLOAD),
      DEMO_SEED_TIMESTAMP,
    ],
  );

  for (const [index, blueprint] of SYNTHETIC_WORK_ROUTING_BLUEPRINTS.entries()) {
    await transaction.query(
      `INSERT INTO work_routing_blueprints
       (id,blueprint_key,blueprint_version,trigger_event_types,work_item_kind,queue_key,assignment_strategy,
        assigned_role_key,due_offset_ms,priority,completion_event_types,cancellation_event_types,title,required_action,
        deep_link_template,synthetic,trigger_status,policy_key,policy_version,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,TRUE,$16,$17,1,$18,$18,1)
       ON CONFLICT (blueprint_key, blueprint_version) DO UPDATE SET
         trigger_event_types=EXCLUDED.trigger_event_types,
         completion_event_types=EXCLUDED.completion_event_types,
         cancellation_event_types=EXCLUDED.cancellation_event_types,
         title=EXCLUDED.title, required_action=EXCLUDED.required_action, updated_at=EXCLUDED.updated_at`,
      [
        blueprintId(index),
        blueprint.blueprintKey,
        blueprint.blueprintVersion,
        JSON.stringify(blueprint.triggerEventTypes),
        blueprint.workItemKind,
        blueprint.queueKey,
        blueprint.assignmentStrategy,
        blueprint.assignedRoleKey,
        blueprint.dueOffsetMs,
        blueprint.priority,
        JSON.stringify(blueprint.completionEventTypes),
        JSON.stringify(blueprint.cancellationEventTypes),
        blueprint.title,
        blueprint.requiredAction,
        blueprint.deepLinkTemplate,
        blueprint.triggerStatus,
        SYNTHETIC_ORCHESTRATION_POLICY_PAYLOAD.policyKey,
        DEMO_SEED_TIMESTAMP,
      ],
    );
  }

  await transaction.query(
    `INSERT INTO scheduled_automation_actions
     (id,schedule_key,policy_version,action_type,scheduled_for,next_run_at,status,idempotency_key,correlation_id,payload,created_at,updated_at,version)
     VALUES ($1,'work.reconcile.recurring',1,'work.reconcile',$2,$2,'pending','work.reconcile.recurring:v1','seed-work-control',$3::jsonb,$2,$2,1)
     ON CONFLICT (idempotency_key) DO UPDATE SET scheduled_for=EXCLUDED.scheduled_for, next_run_at=EXCLUDED.next_run_at, status='pending'`,
    [
      SEEDED_WORK_CONTROL_IDS.recurringReconcile,
      DEMO_SEED_TIMESTAMP,
      JSON.stringify({ cadenceMs: 15 * 60 * 1000, synthetic: true }),
    ],
  );

  await seedLabWorkItems(transaction);
}

async function seedLabWorkItems(transaction: SqlExecutor): Promise<void> {
  await transaction.query(
    `INSERT INTO inspections
     (id,reference,project_id,status,inspector_user_id,reviewer_user_id,scheduled_at,started_at,completed_at,service_key,report_template_id,created_by_user_id,created_at,updated_at,version)
     VALUES
     ($1,'BEA-IN-000003',$4,'needs_correction',$5,$6,$7,$7,$7,'building-envelope-inspection',$8,$6,$7,$7,1),
     ($2,'BEA-IN-000004',$4,'reporting',$5,$6,$7,$7,$7,'building-envelope-inspection',$8,$6,$7,$7,1),
     ($3,'BEA-IN-000005',$4,'reporting',$5,$6,$7,$7,$7,'building-envelope-inspection',$8,$6,$7,$7,1)
     ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, updated_at=EXCLUDED.updated_at`,
    [
      SEEDED_WORK_CONTROL_IDS.labCorrectionInspection,
      SEEDED_WORK_CONTROL_IDS.labDeliveryInspection,
      SEEDED_WORK_CONTROL_IDS.labEscalatedInspection,
      SEEDED_OPERATIONS_IDS.happyProject,
      operationsId,
      ownerId,
      DEMO_SEED_TIMESTAMP,
      SEEDED_OPERATIONS_IDS.template,
    ],
  );

  await transaction.query(
    `INSERT INTO exception_cases
     (id,reference,kind,status,severity,title,detail,inspection_id,project_id,owner_user_id,sla_attribution,created_at,updated_at,version)
     VALUES ($1,'BEA-EX-000101','validation','open','error','Synthetic missing data','Lab correction queue item.',$2,$3,$4,'human_waiting',$5,$5,1)
     ON CONFLICT (id) DO UPDATE SET status='open', owner_user_id=EXCLUDED.owner_user_id`,
    [
      SEEDED_WORK_CONTROL_IDS.labException,
      SEEDED_WORK_CONTROL_IDS.labCorrectionInspection,
      SEEDED_OPERATIONS_IDS.happyProject,
      operationsId,
      DEMO_SEED_TIMESTAMP,
    ],
  );

  await transaction.query(
    `INSERT INTO inspection_reports
     (id,reference,inspection_id,project_id,template_id,current_template_version_id,status,current_version_number,created_by_user_id,created_at,updated_at,version)
     VALUES
     ($1,'BEA-RP-000101',$3,$5,$6,$7,'ready_for_delivery',1,$8,$9,$9,1),
     ($2,'BEA-RP-000102',$4,$5,$6,$7,'in_review',1,$8,$9,$9,1)
     ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, updated_at=EXCLUDED.updated_at`,
    [
      SEEDED_WORK_CONTROL_IDS.labDeliveryReport,
      SEEDED_WORK_CONTROL_IDS.labEscalatedReport,
      SEEDED_WORK_CONTROL_IDS.labDeliveryInspection,
      SEEDED_WORK_CONTROL_IDS.labEscalatedInspection,
      SEEDED_OPERATIONS_IDS.happyProject,
      SEEDED_OPERATIONS_IDS.template,
      SEEDED_OPERATIONS_IDS.templateVersion,
      ownerId,
      DEMO_SEED_TIMESTAMP,
    ],
  );

  await transaction.query(
    `INSERT INTO inspection_submissions
     (id,inspection_id,source_channel,source_idempotency_key,payload_sha256,raw_payload,schema_version,mapping_version,normalized_payload,actor_user_id,correlation_id,created_at)
     VALUES
     ($1,$3,'direct_entry','seed-work-delivery','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','{"synthetic":true}'::jsonb,'v1','v1','{"synthetic":true}'::jsonb,$5,'seed-work-control',$6),
     ($2,$4,'direct_entry','seed-work-review','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','{"synthetic":true}'::jsonb,'v1','v1','{"synthetic":true}'::jsonb,$5,'seed-work-control',$6)
     ON CONFLICT (id) DO NOTHING`,
    [
      SEEDED_WORK_CONTROL_IDS.labDeliverySubmission,
      SEEDED_WORK_CONTROL_IDS.labEscalatedSubmission,
      SEEDED_WORK_CONTROL_IDS.labDeliveryInspection,
      SEEDED_WORK_CONTROL_IDS.labEscalatedInspection,
      ownerId,
      DEMO_SEED_TIMESTAMP,
    ],
  );

  await transaction.query(
    `INSERT INTO report_versions
     (id,report_id,version_number,status,input_snapshot,template_version_id,submission_id,created_at)
     VALUES
     ($1,$3,1,'final','{"synthetic":true}'::jsonb,$5,$7,$6),
     ($2,$4,1,'in_review','{"synthetic":true}'::jsonb,$5,$8,$6)
     ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status`,
    [
      SEEDED_WORK_CONTROL_IDS.labDeliveryVersion,
      SEEDED_WORK_CONTROL_IDS.labEscalatedVersion,
      SEEDED_WORK_CONTROL_IDS.labDeliveryReport,
      SEEDED_WORK_CONTROL_IDS.labEscalatedReport,
      SEEDED_OPERATIONS_IDS.templateVersion,
      DEMO_SEED_TIMESTAMP,
      SEEDED_WORK_CONTROL_IDS.labDeliverySubmission,
      SEEDED_WORK_CONTROL_IDS.labEscalatedSubmission,
    ],
  );

  const duePast = "2025-12-31T22:00:00.000Z";
  await insertWorkItem(transaction, {
    id: SEEDED_WORK_CONTROL_IDS.labCorrectionWork,
    reference: "BEA-WK-000001",
    kind: "inspection_correction",
    queue: "inspection.correction",
    role: DEMO_ROLE_IDS.OPERATIONS,
    assignedUserId: null,
    inspectionId: SEEDED_WORK_CONTROL_IDS.labCorrectionInspection,
    reportId: null,
    exceptionId: SEEDED_WORK_CONTROL_IDS.labException,
    reportVersionId: null,
    jobId: null,
    cycle: `inspection:${SEEDED_WORK_CONTROL_IDS.labCorrectionInspection}:correction:${SEEDED_WORK_CONTROL_IDS.labException}`,
    title: "Correct inspection package",
    deepLink: `/inspections/${SEEDED_WORK_CONTROL_IDS.labCorrectionInspection}`,
    dueAt: duePast,
    escalation: "none",
  });
  await insertWorkItem(transaction, {
    id: SEEDED_WORK_CONTROL_IDS.labDeliveryWork,
    reference: "BEA-WK-000002",
    kind: "report_delivery_authorization",
    queue: "report.delivery-authorization",
    role: DEMO_ROLE_IDS.OWNER_ADMIN,
    assignedUserId: null,
    inspectionId: SEEDED_WORK_CONTROL_IDS.labDeliveryInspection,
    reportId: SEEDED_WORK_CONTROL_IDS.labDeliveryReport,
    exceptionId: null,
    reportVersionId: SEEDED_WORK_CONTROL_IDS.labDeliveryVersion,
    jobId: null,
    cycle: `report:${SEEDED_WORK_CONTROL_IDS.labDeliveryReport}:delivery-auth:${SEEDED_WORK_CONTROL_IDS.labDeliveryVersion}`,
    title: "Authorize report delivery",
    deepLink: `/reports/${SEEDED_WORK_CONTROL_IDS.labDeliveryReport}`,
    dueAt: duePast,
    escalation: "none",
  });
  await insertWorkItem(transaction, {
    id: SEEDED_WORK_CONTROL_IDS.labEscalatedWork,
    reference: "BEA-WK-000003",
    kind: "report_technical_review",
    queue: "report.technical-review",
    role: DEMO_ROLE_IDS.OPERATIONS,
    assignedUserId: operationsId,
    inspectionId: SEEDED_WORK_CONTROL_IDS.labEscalatedInspection,
    reportId: SEEDED_WORK_CONTROL_IDS.labEscalatedReport,
    exceptionId: null,
    reportVersionId: SEEDED_WORK_CONTROL_IDS.labEscalatedVersion,
    jobId: null,
    cycle: `report:${SEEDED_WORK_CONTROL_IDS.labEscalatedReport}:review:${SEEDED_WORK_CONTROL_IDS.labEscalatedVersion}`,
    title: "Complete technical review",
    deepLink: `/reports/${SEEDED_WORK_CONTROL_IDS.labEscalatedReport}`,
    dueAt: duePast,
    escalation: "breached",
  });

  await transaction.query(
    `INSERT INTO automation_jobs
     (id,job_type,blueprint_key,blueprint_version,aggregate_type,aggregate_id,idempotency_key,status,attempt_count,max_attempts,available_at,payload,created_at,updated_at,version)
     VALUES ($1,'inspection.validate','inspection.submission-validation',1,'inspection',$2,'seed-automation-failure:v1','dead_letter',3,3,$3,'{"synthetic":true}'::jsonb,$3,$3,1)
     ON CONFLICT (id) DO UPDATE SET status='dead_letter'`,
    [
      SEEDED_WORK_CONTROL_IDS.labAutomationJob,
      SEEDED_WORK_CONTROL_IDS.labCorrectionInspection,
      DEMO_SEED_TIMESTAMP,
    ],
  );
  await insertWorkItem(transaction, {
    id: SEEDED_WORK_CONTROL_IDS.labAutomationWork,
    reference: "BEA-WK-000004",
    kind: "automation_failure",
    queue: "automation.failure",
    role: DEMO_ROLE_IDS.INTEGRATION_ADMIN,
    assignedUserId: null,
    inspectionId: SEEDED_WORK_CONTROL_IDS.labCorrectionInspection,
    reportId: null,
    exceptionId: null,
    reportVersionId: null,
    jobId: SEEDED_WORK_CONTROL_IDS.labAutomationJob,
    cycle: `job:${SEEDED_WORK_CONTROL_IDS.labAutomationJob}:dead-letter`,
    title: "Resolve automation dead letter",
    deepLink: "/automations",
    dueAt: duePast,
    escalation: "none",
  });

  await transaction.query(
    `INSERT INTO work_item_escalations
     (id,work_item_id,escalation_level,reason,created_at,policy_version,owner_visible,cycle_identity)
     VALUES ($1,$2,'breached',$3,$4,1,TRUE,$5)
     ON CONFLICT (work_item_id, escalation_level, cycle_identity) DO NOTHING`,
    [
      SEEDED_WORK_CONTROL_IDS.labEscalation,
      SEEDED_WORK_CONTROL_IDS.labEscalatedWork,
      `Synthetic breached threshold crossed. ${WORK_CONTROL_SYNTHETIC_DISCLOSURE}`,
      DEMO_SEED_TIMESTAMP,
      `report:${SEEDED_WORK_CONTROL_IDS.labEscalatedReport}:review:${SEEDED_WORK_CONTROL_IDS.labEscalatedVersion}`,
    ],
  );
  await transaction.query(
    `INSERT INTO work_item_reminders
     (id,work_item_id,threshold_key,policy_version,scheduled_for,created_at,synthetic)
     VALUES ($1,$2,'overdue',1,$3,$3,TRUE)
     ON CONFLICT (work_item_id, threshold_key, policy_version) DO NOTHING`,
    [
      SEEDED_WORK_CONTROL_IDS.labReminder,
      SEEDED_WORK_CONTROL_IDS.labEscalatedWork,
      DEMO_SEED_TIMESTAMP,
    ],
  );

  await transaction.query(
    `INSERT INTO notification_outbox
     (id,work_item_id,reminder_id,channel,recipient_role_key,recipient_placeholder,subject,body,deep_link,status,adapter_result,idempotency_key,policy_version,correlation_id,created_at,available_at,processed_at)
     VALUES
     ($1,$3,$4,'email_dry_run',$5,$6,$7,$8,$9,'rendered_dry_run',$7,'lab-email-dry-run:v1',1,'seed-work-control',$10,$10,$10),
     ($2,$3,$4,'teams_dry_run',$5,$6,$11,$8,$9,'rendered_dry_run',$11,'lab-teams-dry-run:v1',1,'seed-work-control',$10,$10,$10)
     ON CONFLICT (idempotency_key) DO UPDATE SET adapter_result=EXCLUDED.adapter_result, status='rendered_dry_run'`,
    [
      SEEDED_WORK_CONTROL_IDS.labNotificationEmail,
      SEEDED_WORK_CONTROL_IDS.labNotificationTeams,
      SEEDED_WORK_CONTROL_IDS.labEscalatedWork,
      SEEDED_WORK_CONTROL_IDS.labReminder,
      DEMO_ROLE_IDS.OPERATIONS,
      SYNTHETIC_NOTIFICATION_RECIPIENT,
      EMAIL_DRY_RUN_DISCLOSURE,
      `${SEEDED_WORK_CONTROL_IDS.labEscalatedWork.slice(0, 8)}: Complete technical review. ${WORK_CONTROL_SYNTHETIC_DISCLOSURE} This message never includes raw inspection source, signatures, credentials, or report contents.`,
      `/work/${SEEDED_WORK_CONTROL_IDS.labEscalatedWork}`,
      DEMO_SEED_TIMESTAMP,
      TEAMS_DRY_RUN_DISCLOSURE,
    ],
  );

  await transaction.query(
    `SELECT setval('bea_work_item_reference_seq', GREATEST((SELECT COALESCE(MAX(CAST(substring(reference FROM 8) AS INTEGER)),0) FROM operational_work_items WHERE reference ~ '^BEA-WK-[0-9]{6}$'), 4), true)`,
  );
  await transaction.query(
    `SELECT setval('bea_inspection_reference_seq', GREATEST((SELECT COALESCE(MAX(CAST(substring(reference FROM 8) AS INTEGER)),0) FROM inspections WHERE reference ~ '^BEA-IN-[0-9]{6}$'), 5), true)`,
  );
  await transaction.query(
    `SELECT setval('bea_report_reference_seq', GREATEST((SELECT COALESCE(MAX(CAST(substring(reference FROM 8) AS INTEGER)),0) FROM inspection_reports WHERE reference ~ '^BEA-RP-[0-9]{6}$'), 102), true)`,
  );
  await transaction.query(
    `SELECT setval('bea_exception_reference_seq', GREATEST((SELECT COALESCE(MAX(CAST(substring(reference FROM 8) AS INTEGER)),0) FROM exception_cases WHERE reference ~ '^BEA-EX-[0-9]{6}$'), 101), true)`,
  );
}

async function insertWorkItem(
  transaction: SqlExecutor,
  input: {
    readonly id: string;
    readonly reference: string;
    readonly kind: WorkItemKind;
    readonly queue: string;
    readonly role: string;
    readonly assignedUserId: string | null;
    readonly inspectionId: string;
    readonly reportId: string | null;
    readonly exceptionId: string | null;
    readonly reportVersionId?: string | null;
    readonly jobId?: string | null;
    readonly cycle: string;
    readonly title: string;
    readonly deepLink: string;
    readonly dueAt: string;
    readonly escalation: string;
  },
): Promise<void> {
  await transaction.query(
    `INSERT INTO operational_work_items
     (id,reference,work_item_kind,status,priority,queue_key,assigned_role_key,assigned_user_id,project_id,inspection_id,report_id,exception_id,report_version_id,job_id,
      source_aggregate_type,source_aggregate_id,policy_key,policy_version,idempotency_key,cycle_identity,title,reason,required_action,deep_link,
      available_at,due_at,escalation_level,synthetic,correlation_id,created_at,updated_at,version)
     VALUES
     ($1,$2,$3,'open','urgent',$4,$5,$6::uuid,$7::uuid,$8::uuid,$9::uuid,$10::uuid,$21::uuid,$22::uuid,'inspection',$8,$11,1,$12,$13,$14,$15,$16,$17,$18::timestamptz,$19::timestamptz,$20,TRUE,'seed-work-control',$18::timestamptz,$18::timestamptz,1)
     ON CONFLICT (id) DO UPDATE SET
       status='open',
       assigned_user_id=EXCLUDED.assigned_user_id,
       report_version_id=EXCLUDED.report_version_id,
       job_id=EXCLUDED.job_id,
       cycle_identity=EXCLUDED.cycle_identity,
       due_at=EXCLUDED.due_at,
       escalation_level=EXCLUDED.escalation_level,
       required_action=EXCLUDED.required_action`,
    [
      input.id,
      input.reference,
      input.kind,
      input.queue,
      input.role,
      input.assignedUserId,
      SEEDED_OPERATIONS_IDS.happyProject,
      input.inspectionId,
      input.reportId,
      input.exceptionId,
      SYNTHETIC_ORCHESTRATION_POLICY_PAYLOAD.policyKey,
      `seed:${input.id}`,
      input.cycle,
      input.title,
      `${input.title}. ${WORK_CONTROL_SYNTHETIC_DISCLOSURE}`,
      WORK_ITEM_REQUIRED_ACTIONS[input.kind],
      input.deepLink,
      DEMO_SEED_TIMESTAMP,
      input.dueAt,
      input.escalation,
      input.reportVersionId ?? null,
      input.jobId ?? null,
    ],
  );
}
