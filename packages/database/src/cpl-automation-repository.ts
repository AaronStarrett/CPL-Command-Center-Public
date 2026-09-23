import { createHash, randomUUID } from "node:crypto";
import {
  CPL_AUTOMATION_TRIGGERS,
  cplAutomationFail as fail,
  cplAutomationId as id,
  cplAutomationRevision as revision,
  cplAutomationReason as noteText,
  normalizeCplActionOwner,
  normalizeCplAutomationRecipe,
  type CplAutomationRecipe,
  type CplAutomationRecipeInput,
  type CplAutomationWorkspace,
  type CplAutomationExecution,
  type CplAutomationExecutionDetail,
  type CplBusinessEvent,
  type CplActionTask,
  type CplActionTarget,
  type CplActionOwner,
  type CplAutomationTrigger,
  type CplAutomationStatus,
} from "@bea/domain/cpl-automation";
import type { SqlExecutor } from "./adapter.js";
import {
  SqlCplTenantRepository,
  cplTenantRoleAllows,
  type CplTenantRequest,
  type CplTenantAccess,
  type CplModuleKey,
} from "./tenant-repository.js";
import { SqlCplIntakeRepository } from "./cpl-intake-repository.js";
import { SqlCplDeliveryRepository } from "./cpl-delivery-repository.js";

type Row = Record<string, unknown>;
type EditExecution = CplTenantRequest & {
  executionId: string;
  expectedRevision: number;
  idempotencyKey: string;
  reason: string;
};
const limit = 100;
const json = <T>(v: unknown): T => (typeof v === "string" ? JSON.parse(v) : v) as T;
const iso = (v: unknown) => new Date(v instanceof Date ? v.getTime() : String(v)).toISOString();
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, value]) => [k, canonical(value)]),
        )
      : v;
const hash = (v: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(v)))
    .digest("hex");
const status = (row: Row): CplAutomationStatus =>
  row.status === "completed" ? "succeeded" : (row.status as CplAutomationStatus);
const roles = (a: CplTenantAccess) => ({
  canConfigure: cplTenantRoleAllows(a.role, "automation:configure"),
  canOperate: cplTenantRoleAllows(a.role, "automation:operate"),
  canAssign: cplTenantRoleAllows(a.role, "automation:operate"),
  canViewExecutions: a.role !== "field-user",
});
const modules = (trigger: CplAutomationTrigger): CplModuleKey[] =>
  trigger === "lead.ready"
    ? ["intake-job-tracker", "proposal-builder"]
    : trigger === "proposal.awarded"
      ? ["proposal-builder", "award-to-project-launcher"]
      : ["award-to-project-launcher", "field-report-assembler"];
function recipe(row: Row): CplAutomationRecipe {
  const config = normalizeCplAutomationRecipe(json(row.configuration));
  return {
    ...config,
    id: String(row.recipe_id ?? row.id),
    organizationId: String(row.organization_id),
    version: Number(row.version),
    configuredByIdentityId: String(row.configured_by_identity_id),
    configuredAt: iso(row.configured_at),
    authorizedMembershipVersion: Number(row.authorized_membership_version),
    templateAuthorizedAt: config.templateApprovedForAutomation ? iso(row.configured_at) : null,
  };
}
function event(row: Row): CplBusinessEvent {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    type: row.event_type as CplBusinessEvent["type"],
    sourceKind: row.source_kind as CplBusinessEvent["sourceKind"],
    sourceId: String(row.source_id),
    sourceVersion: Number(row.source_version),
    projectId: row.project_id ? String(row.project_id) : null,
    actorIdentityId: String(row.actor_identity_id),
    occurredAt: iso(row.occurred_at),
    origin: row.origin as CplBusinessEvent["origin"],
    causationExecutionId: row.causation_execution_id ? String(row.causation_execution_id) : null,
  };
}
async function audit(e: SqlExecutor, a: CplTenantAccess, action: string, resource: string) {
  await e.query(
    "INSERT INTO cpl_tenant_audit_events(id,organization_id,actor_identity_id,action,resource_id) VALUES($1,$2,$3,$4,$5)",
    [randomUUID(), a.organizationId, a.identityId, action, resource],
  );
}
async function mutation(
  e: SqlExecutor,
  a: CplTenantAccess,
  kind: string,
  key: string,
  input: unknown,
  resourceId: string = randomUUID(),
) {
  if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{8,180}$/u.test(key))
    fail("CPL_INVALID_IDEMPOTENCY_KEY");
  const digest = hash(input),
    r = await e.query<Row>(
      "INSERT INTO cpl_automation_mutations(organization_id,mutation_kind,idempotency_key,request_hash,resource_id,details) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING RETURNING resource_id",
      [a.organizationId, kind, key, digest, resourceId, JSON.stringify(input)],
    );
  if (r.rows[0]) return { id: String(r.rows[0].resource_id), created: true };
  const prior = await e.query<Row>(
    "SELECT request_hash,resource_id FROM cpl_automation_mutations WHERE organization_id=$1 AND mutation_kind=$2 AND idempotency_key=$3",
    [a.organizationId, kind, key],
  );
  if (prior.rows[0]?.request_hash !== digest) fail("CPL_IDEMPOTENCY_CONFLICT");
  return { id: String(prior.rows[0].resource_id), created: false };
}
async function entitled(e: SqlExecutor, a: CplTenantAccess, keys: readonly CplModuleKey[]) {
  for (const key of keys) {
    const r = await e.query<Row>(
      `SELECT enabled,usage_limit FROM cpl_module_entitlements WHERE organization_id=$1 AND module_key=$2 ${a.automationExecutionId ? "" : "FOR SHARE"}`,
      [a.organizationId, key],
    );
    if (r.rows[0]?.enabled !== true || Number(r.rows[0]?.usage_limit ?? 1) === 0)
      fail("CPL_MODULE_DISABLED");
  }
}
async function ownerValid(e: SqlExecutor, a: CplTenantAccess, owner: CplActionOwner) {
  if (owner.kind !== "person") return;
  const r = await e.query(
    `SELECT m.identity_id FROM cpl_memberships m JOIN cpl_identities i ON i.id=m.identity_id WHERE m.organization_id=$1 AND m.identity_id=$2 AND m.status='active' AND i.status='active' ${a.automationExecutionId ? "" : "FOR SHARE OF m,i"}`,
    [a.organizationId, owner.identityId],
  );
  if (!r.rows[0]) fail("CPL_AUTOMATION_OWNER_UNAVAILABLE");
}
export class SqlCplAutomationRepository {
  constructor(private readonly tenants: SqlCplTenantRepository) {}
  private run<T>(
    request: CplTenantRequest,
    operation: (e: SqlExecutor, a: CplTenantAccess) => Promise<T>,
  ) {
    return this.tenants.withOrganizationTransaction(request, "records:read", async (e, a) => {
      const r = await e.query<Row>(
        "SELECT count(*)=8 AND bool_and(relrowsecurity AND relforcerowsecurity) AS protected FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN ('cpl_automation_recipes','cpl_automation_recipe_versions','cpl_business_events','cpl_automation_steps','cpl_automation_attempts','cpl_action_tasks','cpl_action_task_events','cpl_automation_mutations')",
      );
      if (r.rows[0]?.protected !== true) fail("CPL_AUTOMATION_SCHEMA_UNSAFE");
      return operation(e, a);
    });
  }
  async saveRecipe(
    request: CplTenantRequest & {
      recipeId?: string;
      expectedVersion: number;
      idempotencyKey: string;
      input: unknown;
    },
  ): Promise<CplAutomationRecipe> {
    const input = normalizeCplAutomationRecipe(request.input),
      expected = revision(request.expectedVersion, true),
      recipeId = request.recipeId ? id(request.recipeId) : undefined;
    return this.run(request, async (e, a) => {
      if (!roles(a).canConfigure) fail("CPL_ACCESS_DENIED");
      await entitled(e, a, modules(input.trigger));
      await ownerValid(e, a, input.owner);
      if (input.prepareDraft) {
        const table =
          input.trigger === "lead.ready" ? "cpl_commercial_templates" : "cpl_report_templates";
        const found = await e.query<Row>(
          `SELECT id FROM ${table} WHERE organization_id=$1 AND id=$2${input.trigger === "fieldwork.submitted" ? " AND version=$3" : ""}`,
          [
            a.organizationId,
            input.templateId,
            ...(input.trigger === "fieldwork.submitted" ? [input.templateVersion] : []),
          ],
        );
        if (!found.rows[0] || (input.trigger === "lead.ready" && input.templateVersion !== 1))
          fail("CPL_AUTOMATION_TEMPLATE_UNAVAILABLE");
      }
      const key = await mutation(
        e,
        a,
        "recipe.save",
        request.idempotencyKey,
        { recipeId: recipeId ?? null, expected, input },
        recipeId,
      );
      if (!key.created) {
        const r = await e.query<Row>(
          "SELECT * FROM cpl_automation_recipe_versions WHERE organization_id=$1 AND recipe_id=$2 AND version=$3",
          [a.organizationId, key.id, expected + 1],
        );
        return recipe(r.rows[0] ?? fail("CPL_RECORD_NOT_FOUND"));
      }
      const r = await e.query<Row>(
        "SELECT * FROM cpl_automation_recipes WHERE organization_id=$1 AND id=$2 FOR UPDATE",
        [a.organizationId, key.id],
      );
      if (r.rows[0]) {
        if (
          Number(r.rows[0].current_version) !== expected ||
          r.rows[0].trigger_type !== input.trigger
        )
          fail("CPL_AUTOMATION_VERSION_CONFLICT");
      } else {
        if (recipeId || expected !== 0) fail("CPL_RECORD_NOT_FOUND");
        const count = await e.query<Row>(
          "SELECT count(*) AS total FROM cpl_automation_recipes WHERE organization_id=$1",
          [a.organizationId],
        );
        if (Number(count.rows[0]?.total) >= 50) fail("CPL_AUTOMATION_RECIPE_LIMIT");
        await e.query(
          "INSERT INTO cpl_automation_recipes(organization_id,id,current_version,enabled,trigger_type) VALUES($1,$2,1,$3,$4)",
          [a.organizationId, key.id, input.enabled, input.trigger],
        );
      }
      const v = await e.query<Row>(
        "INSERT INTO cpl_automation_recipe_versions(organization_id,recipe_id,version,configuration,configured_by_identity_id,authorized_membership_version) VALUES($1,$2,$3,$4::jsonb,$5,$6) RETURNING *",
        [
          a.organizationId,
          key.id,
          expected + 1,
          JSON.stringify(input),
          a.identityId,
          a.membershipVersion,
        ],
      );
      if (r.rows[0])
        await e.query(
          "UPDATE cpl_automation_recipes SET current_version=$3,enabled=$4,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND id=$2",
          [a.organizationId, key.id, expected + 1, input.enabled],
        );
      await audit(e, a, "automation.recipe.saved", key.id);
      return recipe(v.rows[0]!);
    });
  }
  private async execution(
    e: SqlExecutor,
    a: CplTenantAccess,
    row: Row,
  ): Promise<CplAutomationExecution> {
    const er = await e.query<Row>(
      "SELECT * FROM cpl_business_events WHERE organization_id=$1 AND id=$2",
      [a.organizationId, row.event_id],
    );
    if (er.rows[0]) await entitled(e, a, modules(er.rows[0].event_type as CplAutomationTrigger));
    const rr = await e.query<Row>(
      "SELECT configuration FROM cpl_automation_recipe_versions WHERE organization_id=$1 AND recipe_id=$2 AND version=$3",
      [a.organizationId, row.recipe_id, row.recipe_version],
    );
    const steps = await e.query<Row>(
      "SELECT step_key,result,completed_at FROM cpl_automation_steps WHERE organization_id=$1 AND execution_id=$2 ORDER BY completed_at,step_key",
      [a.organizationId, row.id],
    );
    const current = status(row),
      can = roles(a).canOperate;
    return {
      id: String(row.id),
      organizationId: a.organizationId,
      revision: Number(row.revision),
      event: event(er.rows[0] ?? fail("CPL_AUTOMATION_SCHEMA_UNSAFE")),
      recipeId: String(row.recipe_id),
      recipeVersion: Number(row.recipe_version),
      recipeName: json<CplAutomationRecipeInput>(rr.rows[0]?.configuration).name,
      status: current,
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
      nextRetryAt: current === "retrying" ? iso(row.available_at) : null,
      lastErrorCode: row.last_error_code ? String(row.last_error_code) : null,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      results: steps.rows.map((s) => ({
        step: String(s.step_key),
        target: json<CplActionTarget>(s.result),
        completedAt: iso(s.completed_at),
      })),
      availableActions: {
        canRetry: can && ["failed", "retrying"].includes(current),
        canCancel: can && ["queued", "running", "retrying"].includes(current),
        canReplay: can && current !== "running",
      },
    };
  }
  async getExecution(
    request: CplTenantRequest & { executionId: string },
  ): Promise<CplAutomationExecutionDetail> {
    return this.run(request, async (e, a) => {
      if (!roles(a).canViewExecutions) fail("CPL_ACCESS_DENIED");
      const r = await e.query<Row>(
        "SELECT * FROM cpl_workflow_jobs WHERE organization_id=$1 AND id=$2 AND kind='automation.recipe'",
        [a.organizationId, id(request.executionId)],
      );
      const row = r.rows[0] ?? fail("CPL_RECORD_NOT_FOUND"),
        history = await e.query<Row>(
          "SELECT * FROM cpl_automation_attempts WHERE organization_id=$1 AND execution_id=$2 ORDER BY attempt",
          [a.organizationId, row.id],
        );
      return {
        ...(await this.execution(e, a, row)),
        attemptHistory: history.rows.map((h) => ({
          attempt: Number(h.attempt),
          startedAt: iso(h.started_at),
          finishedAt: h.finished_at ? iso(h.finished_at) : null,
          status: h.status as CplAutomationExecutionDetail["attemptHistory"][number]["status"],
          errorCode: h.error_code ? String(h.error_code) : null,
        })),
      };
    });
  }
  private async task(e: SqlExecutor, a: CplTenantAccess, row: Row): Promise<CplActionTask> {
    const owner = normalizeCplActionOwner(json(row.owner)),
      mine =
        owner.kind === "person"
          ? owner.identityId === a.identityId
          : owner.kind === "role" && owner.role === a.role;
    const open = ["open", "in_progress", "blocked"].includes(String(row.status)),
      can = roles(a).canOperate || mine,
      context = json<{ customerName?: string; projectName?: string }>(row.display_context);
    // Older kickoff tasks predate captured display context. Resolve only their
    // already-authorized immutable project, without rewriting task history.
    const destination = json<CplActionTarget>(row.target),
      projectId = destination.projectId ?? (destination.kind === "project" ? destination.id : null);
    if (projectId && (!context.customerName || !context.projectName)) {
      const project = await e.query<Row>(
        "SELECT snapshot FROM cpl_commercial_projects WHERE organization_id=$1 AND id=$2",
        [a.organizationId, projectId],
      );
      if (project.rows[0]) {
        const saved = json<{
          version: { content: { title: string }; sourceLead: { fields: { customerName: string } } };
        }>(project.rows[0].snapshot);
        context.customerName ||= saved.version.sourceLead.fields.customerName;
        context.projectName ||= saved.version.content.title;
      }
    }
    return {
      id: String(row.id),
      organizationId: a.organizationId,
      revision: Number(row.revision),
      executionId: row.execution_id ? String(row.execution_id) : null,
      title: String(row.title),
      reason: String(row.reason),
      group: row.task_group as CplActionTask["group"],
      target: json(row.target),
      owner,
      dueAt: row.due_at ? iso(row.due_at) : null,
      status: row.status as CplActionTask["status"],
      resolutionReason: row.resolution_reason ? String(row.resolution_reason) : null,
      customerName: context.customerName ?? null,
      projectName: context.projectName ?? null,
      nextAction: String(row.title),
      isMine: mine,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      availableActions: {
        canAssign: open && roles(a).canAssign,
        canStart: row.status === "open" && can,
        canComplete:
          open &&
          row.status !== "blocked" &&
          can &&
          row.task_group === "next_actions" &&
          json<CplActionTarget>(row.target).kind === "project",
        canDismiss: open && roles(a).canOperate,
      },
    };
  }
  private async taskAccess(e: SqlExecutor, a: CplTenantAccess, row: Row) {
    const t = json<CplActionTarget>(row.target);
    await entitled(
      e,
      a,
      t.kind === "lead"
        ? ["intake-job-tracker"]
        : t.kind === "proposal"
          ? ["proposal-builder"]
          : [
              "award-to-project-launcher",
              ...(t.kind === "report" ||
              t.kind === "package" ||
              t.kind === "visit" ||
              row.task_group === "closeout"
                ? ["field-report-assembler" as const]
                : []),
            ],
    );
    if (a.role === "field-user") {
      if (t.kind !== "visit") fail("CPL_ACCESS_DENIED");
      const v = await e.query(
        "SELECT id FROM cpl_project_visits WHERE organization_id=$1 AND id=$2 AND responsible_identity_id=$3",
        [a.organizationId, t.id, a.identityId],
      );
      if (!v.rows[0]) fail("CPL_ACCESS_DENIED");
    }
  }
  private async reconcile(e: SqlExecutor, a: CplTenantAccess, enabled: Set<string>) {
    if (a.role === "field-user") return;
    const rows = await e.query<Row>(
      "SELECT * FROM cpl_action_tasks WHERE organization_id=$1 AND execution_id IS NOT NULL AND (status IN('open','in_progress','blocked') OR (status='completed' AND resolution_reason LIKE 'Source:%')) ORDER BY id FOR UPDATE",
      [a.organizationId],
    );
    for (const row of rows.rows) {
      const t = json<CplActionTarget>(row.target),
        group = String(row.task_group);
      let state: string | null = null,
        reason = "";
      if (
        (t.kind === "lead" && !enabled.has("intake-job-tracker")) ||
        (t.kind === "proposal" && !enabled.has("proposal-builder")) ||
        (["project", "visit", "report", "package"].includes(t.kind) &&
          !enabled.has("award-to-project-launcher")) ||
        (["report", "package"].includes(t.kind) && !enabled.has("field-report-assembler"))
      )
        continue;
      if (t.projectId) {
        const p = await e.query<Row>(
          "SELECT status FROM cpl_project_operations WHERE organization_id=$1 AND project_id=$2",
          [a.organizationId, t.projectId],
        );
        if (p.rows[0]?.status === "cancelled") {
          state = "blocked";
          reason = "Source: project is cancelled. Review the linked project before continuing.";
        }
      }
      if (!state && t.kind === "proposal") {
        const p = await e.query<Row>(
          "SELECT state FROM cpl_commercial_proposals WHERE organization_id=$1 AND id=$2",
          [a.organizationId, t.id],
        );
        if (!p.rows[0]) {
          state = "blocked";
          reason = "Source: proposal unavailable.";
        } else if (["approved", "awarded", "lost", "withdrawn"].includes(String(p.rows[0].state))) {
          state = "completed";
          reason = `Source: proposal ${String(p.rows[0].state)} through its governed workflow.`;
        }
      } else if (!state && t.kind === "lead") {
        const p = await e.query<Row>(
          "SELECT l.status,EXISTS(SELECT 1 FROM cpl_commercial_proposals p WHERE p.organization_id=l.organization_id AND p.lead_id=l.id) AS proposed FROM cpl_workflow_leads l WHERE l.organization_id=$1 AND l.id=$2",
          [a.organizationId, t.id],
        );
        if (!p.rows[0]) {
          state = "blocked";
          reason = "Source: lead unavailable.";
        } else if (p.rows[0].proposed || p.rows[0].status === "disqualified") {
          state = "completed";
          reason = "Source: lead has a proposal or recorded disqualification.";
        } else if (p.rows[0].status !== "ready_for_proposal") {
          state = "blocked";
          reason = "Source: lead needs renewed readiness review.";
        }
      } else if (!state && t.kind === "report") {
        const p = await e.query<Row>(
          "SELECT a.version,EXISTS(SELECT 1 FROM cpl_report_approval_withdrawals w WHERE(w.organization_id,w.report_id,w.version)=(a.organization_id,a.report_id,a.version)) AS withdrawn FROM cpl_report_artifacts a WHERE a.organization_id=$1 AND a.report_id=$2 AND a.version>=$3 ORDER BY a.version DESC LIMIT 1",
          [a.organizationId, t.id, t.version ?? 1],
        );
        if (p.rows[0]) {
          state = p.rows[0].withdrawn ? "blocked" : "completed";
          reason = p.rows[0].withdrawn
            ? "Source: report approval was withdrawn. Human review is required."
            : "Source: a governed report approval and immutable artifact are recorded.";
        }
      } else if (!state && t.kind === "visit") {
        const p = await e.query<Row>(
          "SELECT status,revision FROM cpl_project_visits WHERE organization_id=$1 AND id=$2",
          [a.organizationId, t.id],
        );
        if (
          !p.rows[0] ||
          p.rows[0].status !== "completed" ||
          Number(p.rows[0].revision) !== t.version
        ) {
          state = "blocked";
          reason = "Source: submitted visit was reopened, changed, or cancelled.";
        } else {
          const approved = await e.query<Row>(
            "SELECT a.report_id FROM cpl_report_artifacts a JOIN cpl_report_versions v ON(v.organization_id,v.report_id,v.version)=(a.organization_id,a.report_id,a.version) WHERE a.organization_id=$1 AND a.project_id=$2 AND v.snapshot->'sources'->'visits' @> $3::jsonb AND NOT EXISTS(SELECT 1 FROM cpl_report_approval_withdrawals w WHERE(w.organization_id,w.report_id,w.version)=(a.organization_id,a.report_id,a.version)) LIMIT 1",
            [a.organizationId, t.projectId, JSON.stringify([{ id: t.id }])],
          );
          if (approved.rows[0]) {
            state = "completed";
            reason = "Source: submitted visit is included in an approved report.";
          }
        }
      } else if (!state && t.kind === "package") {
        const p = await e.query<Row>(
          "SELECT p.state,EXISTS(SELECT 1 FROM cpl_delivery_attachments d JOIN cpl_report_approval_withdrawals w ON(w.organization_id,w.report_id,w.version)=(d.organization_id,d.report_id,d.report_version) WHERE d.organization_id=p.organization_id AND d.package_id=p.id AND d.package_version=p.current_version) AS withdrawn FROM cpl_delivery_packages p WHERE p.organization_id=$1 AND p.id=$2",
          [a.organizationId, t.id],
        );
        if (!p.rows[0] || p.rows[0].withdrawn) {
          state = "blocked";
          reason =
            "Source: delivery package or its approved attachment is unavailable or withdrawn.";
        } else if (["manually_sent", "acknowledged"].includes(String(p.rows[0].state))) {
          state = "completed";
          reason = "Source: human manual delivery confirmation is recorded.";
        }
      } else if (
        !state &&
        t.kind === "project" &&
        group === "closeout" &&
        enabled.has("field-report-assembler")
      ) {
        const readiness = (
          await new SqlCplDeliveryRepository(this.tenants).workspaceInTransaction(e, a, t.id)
        ).readiness;
        state = readiness.status === "ready" ? "completed" : "blocked";
        reason =
          readiness.status === "ready"
            ? "Source: current configured closeout requirements are satisfied. Invoice issuance and payment are not tracked."
            : `Source: ${
                readiness.status === "not_configured"
                  ? "configure a closeout policy"
                  : readiness.checks
                      .filter((c) => c.required && !c.met && !c.override)
                      .map((c) => c.message)
                      .join(" ") || "resolve current closeout requirements"
              }.`;
      }
      if (!state && (row.status === "blocked" || row.status === "completed")) {
        state = "open";
        reason = "Source: current work requires attention again.";
      }
      if (
        !state ||
        (row.status === state && (row.resolution_reason === reason || state === "open"))
      )
        continue;
      const updated = await e.query<Row>(
        "UPDATE cpl_action_tasks SET revision=revision+1,status=$3,resolution_reason=$4,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND id=$2 RETURNING *",
        [a.organizationId, row.id, state, reason],
      );
      await e.query(
        "INSERT INTO cpl_action_task_events(organization_id,id,task_id,revision,action,actor_identity_id,reason,snapshot) VALUES($1,$2,$3,$4,'source.reconciled',$5,$6,$7::jsonb)",
        [
          a.organizationId,
          randomUUID(),
          row.id,
          updated.rows[0]!.revision,
          a.identityId,
          reason,
          JSON.stringify(updated.rows[0]),
        ],
      );
    }
  }
  async getWorkspace(request: CplTenantRequest): Promise<CplAutomationWorkspace> {
    return this.run(request, async (e, a) => {
      const enabledRows = await e.query<Row>(
        "SELECT module_key FROM cpl_module_entitlements WHERE organization_id=$1 AND enabled AND(usage_limit IS NULL OR usage_limit>0) FOR SHARE",
        [a.organizationId],
      );
      const enabled = new Set(enabledRows.rows.map((r) => String(r.module_key)));
      await e.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,29)),pg_advisory_xact_lock(hashtextextended($1,31))",
        [a.organizationId],
      );
      if (a.role !== "field-user" && enabled.has("intake-job-tracker"))
        await new SqlCplIntakeRepository(this.tenants).reconcileAttentionInTransaction(e, a);
      await this.reconcile(e, a, enabled);
      const permissions = roles(a),
        triggers = CPL_AUTOMATION_TRIGGERS.filter((t) => modules(t).every((m) => enabled.has(m))),
        scope =
          "organization_id=$1 AND target->>'kind'=ANY($5::text[]) AND(task_group<>'closeout' OR $6::boolean) AND ($2::boolean OR ((owner->>'identityId'=$3 OR (owner->>'kind'='role' AND owner->>'role'=$4)) AND target->>'kind'='visit' AND EXISTS(SELECT 1 FROM cpl_project_visits v WHERE v.organization_id=$1 AND v.id::text=target->>'id' AND v.responsible_identity_id=$3::uuid)))",
        kinds = [
          ...(enabled.has("intake-job-tracker") ? ["lead"] : []),
          ...(enabled.has("proposal-builder") ? ["proposal"] : []),
          ...(enabled.has("award-to-project-launcher") ? ["project"] : []),
          ...(enabled.has("award-to-project-launcher") && enabled.has("field-report-assembler")
            ? ["report", "package", "visit"]
            : []),
        ],
        values = [
          a.organizationId,
          a.role !== "field-user",
          a.identityId,
          a.role,
          kinds,
          enabled.has("field-report-assembler"),
        ];
      const tasks = await e.query<Row>(
        `SELECT * FROM cpl_action_tasks WHERE ${scope} ORDER BY (status IN ('open','in_progress','blocked')) DESC,due_at NULLS LAST,created_at,id LIMIT 100`,
        values,
      );
      const totals = await e.query<Row>(
        `SELECT count(*) FILTER(WHERE status IN ('open','in_progress','blocked')) AS open_tasks,count(*) FILTER(WHERE status IN ('open','in_progress','blocked') AND (owner->>'identityId'=$3 OR(owner->>'kind'='role' AND owner->>'role'=$4))) AS my_tasks,count(*) FILTER(WHERE status IN ('open','in_progress','blocked') AND task_group='reviews') AS reviews,count(*) FILTER(WHERE status IN ('open','in_progress','blocked') AND task_group='missing_information') AS missing_information,count(*) FILTER(WHERE status IN ('open','in_progress','blocked') AND task_group='delivery') AS delivery,count(*) FILTER(WHERE status IN ('open','in_progress','blocked') AND task_group='closeout') AS closeout FROM cpl_action_tasks WHERE ${scope}`,
        values,
      );
      const jobs = permissions.canViewExecutions
        ? await e.query<Row>(
            "SELECT j.* FROM cpl_workflow_jobs j JOIN cpl_business_events b ON(b.organization_id,b.id)=(j.organization_id,j.event_id) WHERE j.organization_id=$1 AND j.kind='automation.recipe' AND b.event_type=ANY($2::text[]) ORDER BY j.created_at DESC,j.id LIMIT 100",
            [a.organizationId, triggers],
          )
        : { rows: [] };
      const jobsTotal = permissions.canViewExecutions
        ? await e.query<Row>(
            "SELECT count(*) FILTER(WHERE j.status='failed') AS failed,count(*) FILTER(WHERE j.status IN ('queued','retrying','running')) AS queued,count(*) FILTER(WHERE j.status='completed') AS succeeded FROM cpl_workflow_jobs j JOIN cpl_business_events b ON(b.organization_id,b.id)=(j.organization_id,j.event_id) WHERE j.organization_id=$1 AND j.kind='automation.recipe' AND b.event_type=ANY($2::text[])",
            [a.organizationId, triggers],
          )
        : { rows: [] };
      const rs = permissions.canViewExecutions
        ? await e.query<Row>(
            "SELECT v.* FROM cpl_automation_recipes r JOIN cpl_automation_recipe_versions v ON(v.organization_id,v.recipe_id,v.version)=(r.organization_id,r.id,r.current_version) WHERE r.organization_id=$1 AND r.trigger_type=ANY($2::text[]) ORDER BY r.created_at,r.id",
            [a.organizationId, triggers],
          )
        : { rows: [] };
      const members = await e.query<Row>(
        "SELECT m.identity_id,i.display_name,m.role FROM cpl_memberships m JOIN cpl_identities i ON i.id=m.identity_id WHERE m.organization_id=$1 AND m.status='active' AND i.status='active' ORDER BY i.display_name,m.identity_id",
        [a.organizationId],
      );
      const proposalTemplates =
        permissions.canConfigure && enabled.has("proposal-builder")
          ? await e.query<Row>(
              "SELECT id,name FROM cpl_commercial_templates WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100",
              [a.organizationId],
            )
          : { rows: [] };
      const reportTemplates =
        permissions.canConfigure && enabled.has("field-report-assembler")
          ? await e.query<Row>(
              "SELECT DISTINCT ON(id) id,version,snapshot->>'name' AS name FROM cpl_report_templates WHERE organization_id=$1 ORDER BY id,version DESC LIMIT 100",
              [a.organizationId],
            )
          : { rows: [] };
      const t = totals.rows[0] ?? {},
        j = jobsTotal.rows[0] ?? {};
      const executions = [];
      for (const row of jobs.rows) executions.push(await this.execution(e, a, row));
      return {
        recipes: rs.rows.map(recipe),
        executions,
        tasks: await Promise.all(tasks.rows.map((r) => this.task(e, a, r))),
        counts: {
          openTasks: Number(t.open_tasks ?? 0),
          myTasks: Number(t.my_tasks ?? 0),
          reviews: Number(t.reviews ?? 0),
          missingInformation: Number(t.missing_information ?? 0),
          delivery: Number(t.delivery ?? 0),
          closeout: Number(t.closeout ?? 0),
          failedExecutions: Number(j.failed ?? 0),
          queuedExecutions: Number(j.queued ?? 0),
          succeededExecutions: Number(j.succeeded ?? 0),
        },
        currentIdentityId: a.identityId,
        members: members.rows.map((r) => ({
          identityId: String(r.identity_id),
          displayName: String(r.display_name),
          role: r.role as CplAutomationWorkspace["members"][number]["role"],
        })),
        proposalTemplates: proposalTemplates.rows.map((r) => ({
          id: String(r.id),
          name: String(r.name),
          version: 1,
        })),
        reportTemplates: reportTemplates.rows.map((r) => ({
          id: String(r.id),
          name: String(r.name),
          version: Number(r.version),
        })),
        permissions,
        listLimit: limit,
      };
    });
  }
  async updateTask(
    request: CplTenantRequest & {
      taskId: string;
      expectedRevision: number;
      idempotencyKey: string;
      action: "assign" | "start" | "complete" | "dismiss";
      owner?: unknown;
      reason?: string;
    },
  ): Promise<CplActionTask> {
    const taskId = id(request.taskId),
      expected = revision(request.expectedRevision),
      action = request.action,
      note = noteText(request.reason ?? "", ["dismiss", "complete"].includes(action));
    if (!["assign", "start", "complete", "dismiss"].includes(action)) fail();
    const owner = action === "assign" ? normalizeCplActionOwner(request.owner) : null;
    return this.run(request, async (e, a) => {
      const enabledRows = await e.query<Row>(
        "SELECT module_key FROM cpl_module_entitlements WHERE organization_id=$1 AND enabled AND(usage_limit IS NULL OR usage_limit>0) FOR SHARE",
        [a.organizationId],
      );
      await e.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,29)),pg_advisory_xact_lock(hashtextextended($1,31))",
        [a.organizationId],
      );
      await this.reconcile(e, a, new Set(enabledRows.rows.map((r) => String(r.module_key))));
      const rows = await e.query<Row>(
          "SELECT * FROM cpl_action_tasks WHERE organization_id=$1 AND id=$2 FOR UPDATE",
          [a.organizationId, taskId],
        ),
        row = rows.rows[0] ?? fail("CPL_RECORD_NOT_FOUND"),
        prior = await this.task(e, a, row);
      await this.taskAccess(e, a, row);
      const allowed =
        action === "assign"
          ? prior.availableActions.canAssign
          : action === "start"
            ? prior.availableActions.canStart
            : action === "complete"
              ? prior.availableActions.canComplete
              : prior.availableActions.canDismiss;
      // Check access before idempotency readback; past possession never authorizes a retry.
      const mine = prior.isMine;
      if (!roles(a).canOperate && !mine) fail("CPL_ACCESS_DENIED");
      const key = await mutation(
        e,
        a,
        `task.${action}`,
        request.idempotencyKey,
        { taskId, expected, owner, note },
        taskId,
      );
      if (!key.created) return prior;
      if (!allowed) fail("CPL_ACCESS_DENIED");
      if (prior.revision !== expected) fail("CPL_AUTOMATION_VERSION_CONFLICT");
      if (owner) await ownerValid(e, a, owner);
      const nextStatus =
        action === "start"
          ? "in_progress"
          : action === "complete"
            ? "completed"
            : action === "dismiss"
              ? "dismissed"
              : prior.status;
      const updated = await e.query<Row>(
        "UPDATE cpl_action_tasks SET revision=revision+1,owner=$3::jsonb,status=$4,resolution_reason=$5,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND id=$2 RETURNING *",
        [
          a.organizationId,
          taskId,
          JSON.stringify(owner ?? prior.owner),
          nextStatus,
          ["complete", "dismiss"].includes(action) ? note : null,
        ],
      );
      await e.query(
        "INSERT INTO cpl_action_task_events(organization_id,id,task_id,revision,action,actor_identity_id,reason,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
        [
          a.organizationId,
          randomUUID(),
          taskId,
          expected + 1,
          action,
          a.identityId,
          note,
          JSON.stringify(updated.rows[0]),
        ],
      );
      await audit(e, a, `automation.task.${action}`, taskId);
      return this.task(e, a, updated.rows[0]!);
    });
  }
  private async control(request: EditExecution, action: "retry" | "cancel") {
    const executionId = id(request.executionId),
      expected = revision(request.expectedRevision),
      reason = noteText(request.reason, true);
    return this.run(request, async (e, a) => {
      if (!roles(a).canOperate) fail("CPL_ACCESS_DENIED");
      const rows = await e.query<Row>(
          "SELECT * FROM cpl_workflow_jobs WHERE organization_id=$1 AND id=$2 AND kind='automation.recipe' FOR UPDATE",
          [a.organizationId, executionId],
        ),
        row = rows.rows[0] ?? fail("CPL_RECORD_NOT_FOUND");
      const key = await mutation(
        e,
        a,
        `execution.${action}`,
        request.idempotencyKey,
        { executionId, expected, reason },
        executionId,
      );
      if (!key.created) return this.execution(e, a, row);
      if (Number(row.revision) !== expected) fail("CPL_AUTOMATION_VERSION_CONFLICT");
      if (action === "retry" && Number(row.attempts) > 27)
        fail("CPL_AUTOMATION_RETRY_BUDGET_EXHAUSTED");
      if (
        !(action === "retry" ? ["failed", "retrying"] : ["queued", "retrying", "running"]).includes(
          String(row.status),
        )
      )
        fail("CPL_AUTOMATION_STATE_CONFLICT");
      const r = await e.query<Row>(
        "SELECT enabled,current_version FROM cpl_automation_recipes WHERE organization_id=$1 AND id=$2 FOR SHARE",
        [a.organizationId, row.recipe_id],
      );
      if (
        action === "retry" &&
        (!r.rows[0]?.enabled || Number(r.rows[0].current_version) !== Number(row.recipe_version))
      )
        fail("CPL_AUTOMATION_CONFIGURATION_CHANGED");
      const changed = await e.query<Row>(
        "UPDATE cpl_workflow_jobs SET revision=revision+1,status=$3,max_attempts=CASE WHEN $3='queued' THEN GREATEST(max_attempts,attempts+3) ELSE max_attempts END,last_error_code=$4,available_at=CURRENT_TIMESTAMP,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND id=$2 RETURNING *",
        [
          a.organizationId,
          executionId,
          action === "retry" ? "queued" : "cancelled",
          action === "retry" ? null : "CPL_AUTOMATION_CANCELLED",
        ],
      );
      if (action === "cancel")
        await e.query(
          "UPDATE cpl_automation_attempts SET status='cancelled',finished_at=CURRENT_TIMESTAMP,error_code='CPL_AUTOMATION_CANCELLED' WHERE organization_id=$1 AND execution_id=$2 AND status='running'",
          [a.organizationId, executionId],
        );
      // The note is immutable private audit evidence, never an executable input.
      await audit(e, a, `automation.execution.${action}`, executionId);
      return this.execution(e, a, changed.rows[0]!);
    });
  }
  retryExecution(request: EditExecution) {
    return this.control(request, "retry");
  }
  cancelExecution(request: EditExecution) {
    return this.control(request, "cancel");
  }
  async replayEvent(
    request: CplTenantRequest & { eventId: string; idempotencyKey: string; reason: string },
  ): Promise<CplAutomationExecution[]> {
    const eventId = id(request.eventId),
      reason = noteText(request.reason, true);
    return this.run(request, async (e, a) => {
      if (!roles(a).canOperate) fail("CPL_ACCESS_DENIED");
      const ev = await e.query(
        "SELECT id FROM cpl_business_events WHERE organization_id=$1 AND id=$2",
        [a.organizationId, eventId],
      );
      if (!ev.rows[0]) fail("CPL_RECORD_NOT_FOUND");
      const key = await mutation(
        e,
        a,
        "event.replay",
        request.idempotencyKey,
        { eventId, reason },
        eventId,
      );
      // Requeue only captured failed work. Successful/skipped/cancelled work and
      // recipes added or changed after the event are never silently replayed.
      if (key.created) {
        await e.query(
          "UPDATE cpl_workflow_jobs j SET status='queued',revision=revision+1,max_attempts=GREATEST(max_attempts,attempts+3),last_error_code=NULL,available_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP FROM cpl_automation_recipes r WHERE j.organization_id=$1 AND j.event_id=$2 AND j.kind='automation.recipe' AND j.status IN('failed','retrying') AND j.attempts<=27 AND(r.organization_id,r.id,r.current_version)=(j.organization_id,j.recipe_id,j.recipe_version) AND r.enabled",
          [a.organizationId, eventId],
        );
        await audit(e, a, "automation.event.replayed", eventId);
      }
      const rows = await e.query<Row>(
          "SELECT * FROM cpl_workflow_jobs WHERE organization_id=$1 AND event_id=$2 AND kind='automation.recipe' ORDER BY created_at,id",
          [a.organizationId, eventId],
        ),
        out = [];
      for (const row of rows.rows) out.push(await this.execution(e, a, row));
      return out;
    });
  }
}
