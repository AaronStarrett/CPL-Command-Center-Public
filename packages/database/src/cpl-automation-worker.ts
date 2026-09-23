import { randomUUID } from "node:crypto";
import {
  cplAutomationDueAt,
  normalizeCplAutomationRecipe,
  type CplActionTarget,
  type CplAutomationRecipeInput,
} from "@bea/domain/cpl-automation";
import type { CplFieldObservationInput, CplFieldPhotoMetadata } from "@bea/domain/cpl-field";
import type { CplReportContent, CplReportTemplateInput } from "@bea/domain/cpl-report";
import type { CplCommercialProjectSnapshot } from "@bea/domain/cpl-commercial";
import type { DatabaseAdapter, SqlExecutor } from "./adapter.js";
import {
  SqlCplTenantRepository,
  type CplTenantAccess,
  type CplModuleKey,
} from "./tenant-repository.js";
import { SqlCplCommercialRepository } from "./cpl-commercial-repository.js";
import { SqlCplReportRepository } from "./cpl-report-repository.js";
import { SqlCplDeliveryRepository } from "./cpl-delivery-repository.js";
import { readCplFieldReadiness } from "./cpl-field-readiness.js";

type Row = Record<string, unknown>;
const json = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;
function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
const target = (
  kind: CplActionTarget["kind"],
  id: string,
  projectId: string | null = null,
  version: number | null = null,
): CplActionTarget => ({ kind, id, projectId, version });
const instant = (x: unknown) => new Date(x instanceof Date ? x.getTime() : String(x)).toISOString();

/** No browser session is fabricated. Each step reacquires the durable lease,
 * current recipe, live sponsor authority, source state and tenant locks. */
export async function processCplAutomationJob(
  database: DatabaseAdapter,
  job: Row,
  leaseToken: string,
): Promise<"completed" | "retrying" | "failed" | "skipped"> {
  const tenants = new SqlCplTenantRepository(database),
    commercial = new SqlCplCommercialRepository(tenants),
    reports = new SqlCplReportRepository(tenants),
    delivery = new SqlCplDeliveryRepository(tenants);
  const claim = {
    organizationId: String(job.organization_id),
    executionId: String(job.id),
    leaseToken,
  };
  try {
    // The queue claim is trusted database data. Configuration is read only after
    // SQL authority fencing, not from arbitrary browser or job payload scripts.
    for (const step of ["handoff", "task"] as const) {
      await tenants.withAutomationTransaction(claim, "automation:configure", [], async (e, a) => {
        const r = await e.query<Row>(
          "SELECT v.configuration,b.* FROM cpl_workflow_jobs j JOIN cpl_automation_recipe_versions v ON(v.organization_id,v.recipe_id,v.version)=(j.organization_id,j.recipe_id,j.recipe_version) JOIN cpl_business_events b ON(b.organization_id,b.id)=(j.organization_id,j.event_id) WHERE j.organization_id=$1 AND j.id=$2",
          [a.organizationId, job.id],
        );
        const source = r.rows[0] ?? fail("CPL_AUTOMATION_SOURCE_UNAVAILABLE"),
          config = normalizeCplAutomationRecipe(json(source.configuration));
        const required: CplModuleKey[] =
          config.trigger === "lead.ready"
            ? ["intake-job-tracker", "proposal-builder"]
            : config.trigger === "proposal.awarded"
              ? ["proposal-builder", "award-to-project-launcher"]
              : ["award-to-project-launcher", "field-report-assembler"];
        // Assignment is part of the recipe authorization, not merely task
        // decoration: validate it before any independently committed handoff.
        if (config.owner.kind === "person") {
          const owner = await e.query(
            "SELECT m.identity_id FROM cpl_memberships m JOIN cpl_identities i ON i.id=m.identity_id WHERE m.organization_id=$1 AND m.identity_id=$2 AND m.status='active' AND i.status='active'",
            [a.organizationId, config.owner.identityId],
          );
          if (!owner.rows[0]) fail("CPL_AUTOMATION_OWNER_UNAVAILABLE");
        }
        for (const module of required) {
          const en = await e.query<Row>(
            "SELECT enabled,usage_limit FROM cpl_module_entitlements WHERE organization_id=$1 AND module_key=$2",
            [a.organizationId, module],
          );
          if (en.rows[0]?.enabled !== true || Number(en.rows[0]?.usage_limit ?? 1) === 0)
            fail("CPL_MODULE_DISABLED");
        }
        await e.query("SELECT pg_advisory_xact_lock(hashtextextended($1,$2))", [
          a.organizationId,
          config.trigger === "lead.ready" || config.trigger === "proposal.awarded" ? 29 : 31,
        ]);
        const prior = await e.query<Row>(
          "SELECT result FROM cpl_automation_steps WHERE organization_id=$1 AND execution_id=$2 AND step_key=$3",
          [a.organizationId, job.id, step],
        );
        if (prior.rows[0]) return; // The domain mutation and this immutable receipt committed together.
        await sourceCurrent(e, a, source, config);
        let result: CplActionTarget;
        if (step === "handoff") {
          const key = `automation:${String(job.id)}:handoff`,
            sourceId = String(source.source_id),
            projectId = source.project_id ? String(source.project_id) : null;
          switch (config.trigger) {
            case "lead.ready": {
              if (config.prepareDraft) {
                const p = await commercial.createProposalInTransaction(e, a, {
                  leadId: sourceId,
                  templateId: config.templateId!,
                  idempotencyKey: key,
                });
                result = target("proposal", p.id, null, p.currentVersion);
              } else result = target("lead", sourceId);
              break;
            }
            case "proposal.awarded": {
              const p = await commercial.createProjectInTransaction(e, a, {
                proposalId: sourceId,
                idempotencyKey: key,
              });
              await parentAvailable(e, a, p.id);
              result = target("project", p.id, p.id);
              break;
            }
            case "fieldwork.submitted": {
              if (config.prepareDraft) {
                const content = await reportContent(e, a, source, config);
                const p = await reports.createReportInTransaction(e, a, {
                  projectId: projectId!,
                  templateId: config.templateId!,
                  templateVersion: config.templateVersion!,
                  // Report mutations intentionally use their existing stricter key alphabet.
                  idempotencyKey: `automation-${String(job.id)}-handoff`,
                  initialContent: content,
                });
                result = target("report", p.id, projectId, p.currentVersion);
              } else result = target("visit", sourceId, projectId, Number(source.source_version));
              break;
            }
            case "report.approved": {
              const p = await delivery.prepareFromApprovedReportInTransaction(e, a, {
                projectId: projectId!,
                reportId: sourceId,
                version: Number(source.source_version),
                idempotencyKey: key,
              });
              result = target("package", p.id, projectId, p.currentVersion);
              break;
            }
            case "delivery.recorded": {
              await delivery.workspaceInTransaction(e, a, projectId!);
              result = target("project", projectId!, projectId);
              break;
            }
          }
        } else {
          const previous = await e.query<Row>(
            "SELECT result FROM cpl_automation_steps WHERE organization_id=$1 AND execution_id=$2 AND step_key='handoff'",
            [a.organizationId, job.id],
          );
          result = json<CplActionTarget>(
            previous.rows[0]?.result ?? fail("CPL_AUTOMATION_STEP_MISSING"),
          );
          if (result.projectId) await parentAvailable(e, a, result.projectId);
          await createTask(e, a, job, source, config, result);
        }
        await e.query(
          "INSERT INTO cpl_automation_steps(organization_id,execution_id,step_key,result) VALUES($1,$2,$3,$4::jsonb)",
          [a.organizationId, job.id, step, JSON.stringify(result)],
        );
        await e.query(
          "INSERT INTO cpl_tenant_audit_events(id,organization_id,actor_identity_id,action,resource_id) VALUES($1,$2,$3,$4,$5)",
          [randomUUID(), a.organizationId, a.identityId, `automation.step.${step}`, job.id],
        );
      });
    }
    await finish(database, job, leaseToken, "completed", null);
    return "completed";
  } catch (error) {
    const raw =
      error && typeof error === "object"
        ? "code" in error
          ? String(error.code)
          : "message" in error
            ? String(error.message)
            : ""
        : "";
    const sqlMessage = error instanceof Error ? error.message : "";
    const code = /^CPL_[A-Z0-9_]{1,100}$/u.test(raw)
      ? raw
      : /^CPL_[A-Z0-9_]{1,100}$/u.test(sqlMessage)
        ? sqlMessage
        : "CPL_AUTOMATION_PROCESSING_FAILED";
    if (code === "CPL_JOB_LEASE_LOST") throw error;
    const skipped = [
      "CPL_AUTOMATION_CONFIGURATION_CHANGED",
      "CPL_AUTOMATION_AUTHORIZATION_REVOKED",
      "CPL_AUTOMATION_SOURCE_CHANGED",
      "CPL_AUTOMATION_SOURCE_UNAVAILABLE",
      "CPL_AUTOMATION_OWNER_UNAVAILABLE",
      "CPL_MODULE_DISABLED",
      "CPL_RECORD_NOT_FOUND",
      "CPL_ACCESS_DENIED",
    ].includes(code);
    const terminal = Number(job.attempts) >= Number(job.max_attempts),
      status = skipped ? "skipped" : terminal ? "failed" : "retrying";
    await finish(database, job, leaseToken, status, code);
    return status;
  }
}
async function finish(
  database: DatabaseAdapter,
  job: Row,
  lease: string,
  status: string,
  code: string | null,
) {
  await database.transaction(async (e) => {
    await e.query("SELECT set_config('cpl.organization_id',$1,true)", [job.organization_id]);
    const changed = await e.query(
      "UPDATE cpl_workflow_jobs SET status=$3,revision=revision+1,last_error_code=$4,available_at=CURRENT_TIMESTAMP+INTERVAL '1 minute',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_expires_at>clock_timestamp() RETURNING id",
      [job.id, lease, status, code],
    );
    if (changed.rowCount !== 1) fail("CPL_JOB_LEASE_LOST");
    await e.query(
      "UPDATE cpl_automation_attempts SET finished_at=CURRENT_TIMESTAMP,status=$4,error_code=$5 WHERE organization_id=$1 AND execution_id=$2 AND attempt=$3",
      [
        job.organization_id,
        job.id,
        job.attempts,
        status === "completed" ? "succeeded" : status,
        code,
      ],
    );
  });
}
async function sourceCurrent(
  e: SqlExecutor,
  a: CplTenantAccess,
  source: Row,
  config: CplAutomationRecipeInput,
) {
  if (source.project_id) await parentAvailable(e, a, String(source.project_id));
  const values = [a.organizationId, source.source_id];
  let row: Row | undefined;
  switch (config.trigger) {
    case "lead.ready":
      row = (
        await e.query<Row>(
          "SELECT version,status FROM cpl_workflow_leads WHERE organization_id=$1 AND id=$2",
          values,
        )
      ).rows[0];
      if (
        !row ||
        row.status !== "ready_for_proposal" ||
        Number(row.version) !== Number(source.source_version)
      )
        fail("CPL_AUTOMATION_SOURCE_CHANGED");
      break;
    case "proposal.awarded":
      row = (
        await e.query<Row>(
          "SELECT revision,state FROM cpl_commercial_proposals WHERE organization_id=$1 AND id=$2",
          values,
        )
      ).rows[0];
      if (!row || row.state !== "awarded" || Number(row.revision) !== Number(source.source_version))
        fail("CPL_AUTOMATION_SOURCE_CHANGED");
      break;
    case "fieldwork.submitted":
      row = (
        await e.query<Row>(
          "SELECT revision,status,project_id FROM cpl_project_visits WHERE organization_id=$1 AND id=$2",
          values,
        )
      ).rows[0];
      if (
        !row ||
        row.status !== "completed" ||
        Number(row.revision) !== Number(source.source_version) ||
        row.project_id !== source.project_id
      )
        fail("CPL_AUTOMATION_SOURCE_CHANGED");
      if (
        (
          await readCplFieldReadiness(
            e,
            a.organizationId,
            String(source.project_id),
            String(source.source_id),
          )
        ).readiness.length
      )
        fail("CPL_AUTOMATION_SOURCE_CHANGED");
      break;
    case "report.approved":
      row = (
        await e.query<Row>(
          "SELECT report_id FROM cpl_report_artifacts a WHERE a.organization_id=$1 AND a.report_id=$2 AND a.version=$3 AND a.project_id=$4 AND NOT EXISTS(SELECT 1 FROM cpl_report_approval_withdrawals w WHERE(w.organization_id,w.report_id,w.version)=(a.organization_id,a.report_id,a.version))",
          [...values, source.source_version, source.project_id],
        )
      ).rows[0];
      if (!row) fail("CPL_AUTOMATION_SOURCE_CHANGED");
      break;
    case "delivery.recorded":
      row = (
        await e.query<Row>(
          "SELECT state,current_version FROM cpl_delivery_packages WHERE organization_id=$1 AND id=$2 AND project_id=$3",
          [...values, source.project_id],
        )
      ).rows[0];
      if (
        !row ||
        !["manually_sent", "acknowledged"].includes(String(row.state)) ||
        Number(row.current_version) !== Number(source.source_version)
      )
        fail("CPL_AUTOMATION_SOURCE_CHANGED");
      break;
  }
}
async function parentAvailable(e: SqlExecutor, a: CplTenantAccess, projectId: string) {
  // Award conversion holds intake29 first; project lifecycle changes hold31.
  // Keep the live-parent check fenced through this action's COMMIT too.
  await e.query("SELECT pg_advisory_xact_lock(hashtextextended($1,31))", [a.organizationId]);
  const p = await e.query<Row>(
    "SELECT p.id,o.status FROM cpl_commercial_projects p LEFT JOIN cpl_project_operations o ON(o.organization_id,o.project_id)=(p.organization_id,p.id) WHERE p.organization_id=$1 AND p.id=$2",
    [a.organizationId, projectId],
  );
  if (
    !p.rows[0] ||
    (p.rows[0].status && !["active", "completed"].includes(String(p.rows[0].status)))
  )
    fail("CPL_AUTOMATION_SOURCE_CHANGED");
}
async function createTask(
  e: SqlExecutor,
  a: CplTenantAccess,
  job: Row,
  source: Row,
  config: CplAutomationRecipeInput,
  destination: CplActionTarget,
) {
  if (config.owner.kind === "person") {
    const owner = await e.query(
      "SELECT m.identity_id FROM cpl_memberships m JOIN cpl_identities i ON i.id=m.identity_id WHERE m.organization_id=$1 AND m.identity_id=$2 AND m.status='active' AND i.status='active'",
      [a.organizationId, config.owner.identityId],
    );
    if (!owner.rows[0]) fail("CPL_AUTOMATION_OWNER_UNAVAILABLE");
  }
  const group =
    config.trigger === "fieldwork.submitted"
      ? "reviews"
      : config.trigger === "report.approved"
        ? "delivery"
        : config.trigger === "delivery.recorded"
          ? "closeout"
          : "next_actions";
  const reason =
    config.trigger === "fieldwork.submitted"
      ? "Fieldwork is complete; human report review is still required."
      : config.trigger === "report.approved"
        ? "Approved artifact prepared for human recipient and delivery review; nothing has been sent."
        : config.trigger === "delivery.recorded"
          ? "Manual delivery recorded; review current closeout requirements."
          : "Configured internal handoff completed; continue the linked work.";
  let display: Record<string, string> = {};
  const projectId =
    source.project_id ??
    destination.projectId ??
    (destination.kind === "project" ? destination.id : null);
  if (projectId) {
    const p = await e.query<Row>(
      "SELECT snapshot FROM cpl_commercial_projects WHERE organization_id=$1 AND id=$2",
      [a.organizationId, projectId],
    );
    const s = json<{
      version: { content: { title: string }; sourceLead: { fields: { customerName: string } } };
    }>(p.rows[0]?.snapshot);
    if (s)
      display = {
        customerName: s.version.sourceLead.fields.customerName,
        projectName: s.version.content.title,
      };
  } else if (config.trigger === "lead.ready") {
    const l = await e.query<Row>(
      "SELECT customer_name FROM cpl_workflow_leads WHERE organization_id=$1 AND id=$2",
      [a.organizationId, source.source_id],
    );
    if (l.rows[0]) display = { customerName: String(l.rows[0].customer_name) };
  }
  const taskId = randomUUID();
  const inserted = await e.query<Row>(
    "INSERT INTO cpl_action_tasks(organization_id,id,execution_id,step_key,title,reason,task_group,target,owner,due_at,display_context) VALUES($1,$2,$3,'handoff',$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10::jsonb) ON CONFLICT(organization_id,execution_id,step_key) DO NOTHING RETURNING *",
    [
      a.organizationId,
      taskId,
      job.id,
      config.taskTitle,
      reason,
      group,
      JSON.stringify(destination),
      JSON.stringify(config.owner),
      cplAutomationDueAt(instant(source.occurred_at), config.dueAfterHours),
      JSON.stringify(display),
    ],
  );
  if (inserted.rows[0])
    await e.query(
      "INSERT INTO cpl_action_task_events(organization_id,id,task_id,revision,action,actor_identity_id,snapshot) VALUES($1,$2,$3,1,'created',$4,$5::jsonb)",
      [a.organizationId, randomUUID(), taskId, a.identityId, JSON.stringify(inserted.rows[0])],
    );
}
async function reportContent(
  e: SqlExecutor,
  a: CplTenantAccess,
  source: Row,
  config: CplAutomationRecipeInput,
): Promise<CplReportContent> {
  const t = await e.query<Row>(
    "SELECT snapshot FROM cpl_report_templates WHERE organization_id=$1 AND id=$2 AND version=$3",
    [a.organizationId, config.templateId, config.templateVersion],
  );
  const template = json<CplReportTemplateInput>(
    t.rows[0]?.snapshot ?? fail("CPL_AUTOMATION_TEMPLATE_UNAVAILABLE"),
  );
  const project = await e.query<Row>(
    "SELECT snapshot FROM cpl_commercial_projects WHERE organization_id=$1 AND id=$2",
    [a.organizationId, source.project_id],
  );
  const awarded = json<CplCommercialProjectSnapshot>(
    project.rows[0]?.snapshot ?? fail("CPL_AUTOMATION_SOURCE_UNAVAILABLE"),
  );
  const obs = await e.query<Row>(
    "SELECT id,snapshot FROM cpl_field_observations WHERE organization_id=$1 AND project_id=$2 AND visit_id=$3 ORDER BY created_at,id",
    [a.organizationId, source.project_id, source.source_id],
  );
  const photos = await e.query<Row>(
    "SELECT p.id,r.snapshot FROM cpl_field_photos p JOIN cpl_field_photo_revisions r ON(r.organization_id,r.photo_id,r.revision)=(p.organization_id,p.id,p.metadata_revision) WHERE p.organization_id=$1 AND p.project_id=$2 AND p.visit_id=$3 AND p.state='ready' ORDER BY p.created_at,p.id",
    [a.organizationId, source.project_id, source.source_id],
  );
  const eligible = photos.rows
    .map((p) => ({ id: String(p.id), m: json<CplFieldPhotoMetadata>(p.snapshot) }))
    .filter((p) => p.m.reportEligible);
  return {
    ...template,
    scope: template.scope || awarded.version.content.scope,
    visits: [
      {
        visitId: String(source.source_id),
        observations: obs.rows
          .filter((o) => json<CplFieldObservationInput>(o.snapshot).reportEligible)
          .map((o) => ({
            observationId: String(o.id),
            titleOverride: null,
            descriptionOverride: null,
            followUpOverride: null,
            photos: eligible
              .filter((p) => p.m.observationId === o.id)
              .map((p) => ({ photoId: p.id, layout: "pair" })),
          })),
        overviewPhotos: eligible
          .filter((p) => p.m.overview && !p.m.observationId)
          .map((p) => ({ photoId: p.id, layout: "pair" })),
      },
    ],
  };
}
