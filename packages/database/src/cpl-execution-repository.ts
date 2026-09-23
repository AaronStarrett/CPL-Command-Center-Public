import { createHash, randomUUID } from "node:crypto";
import { emitCplBusinessEvent } from "./cpl-business-events.js";
import {
  CPL_EXECUTION_TIME_ZONE,
  cplExecutionId,
  cplExecutionInstant,
  cplExecutionRevision,
  cplVisitReadiness,
  normalizeCplProjectOperations,
  normalizeCplVisit,
  type CplExecutionAgenda,
  type CplExecutionEvent,
  type CplExecutionMember,
  type CplProjectOperations,
  type CplProjectOperationsInput,
  type CplProjectWorkspace,
  type CplVisit,
  type CplVisitInput,
  type CplVisitConflict,
} from "@bea/domain/cpl-execution";
import type {
  CplCommercialProject,
  CplCommercialProjectSnapshot,
} from "@bea/domain/cpl-commercial";
import type { SqlExecutor } from "./adapter.js";
import { readCplFieldReadiness } from "./cpl-field-readiness.js";
import {
  cplTenantRoleAllows,
  CplTenantAccessError,
  type CplTenantAccess,
  type CplTenantRequest,
  type SqlCplTenantRepository,
} from "./tenant-repository.js";

type Row = Record<string, unknown>;
type ProjectRequest = CplTenantRequest & { projectId: string };
type NormalizedVisit = ReturnType<typeof normalizeCplVisit>;
function fail(code: string): never {
  throw new CplTenantAccessError(code);
}
function json<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}
function iso(value: unknown): string {
  return new Date(String(value)).toISOString();
}
function digest(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
export class CplExecutionConflictError extends CplTenantAccessError {
  constructor(readonly conflicts: CplVisitConflict[]) {
    super("CPL_EXECUTION_SCHEDULE_CONFLICT");
  }
}
function project(row: Row): CplCommercialProject {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    reference: String(row.reference),
    awardId: String(row.award_id),
    proposalId: String(row.proposal_id),
    proposalVersion: Number(row.proposal_version),
    leadId: String(row.lead_id),
    snapshot: json<CplCommercialProjectSnapshot>(row.snapshot),
    createdByIdentityId: String(row.created_by_identity_id),
    createdAt: iso(row.created_at),
  };
}
function visit(row: Row): CplVisit {
  const input = json<NormalizedVisit>(row.snapshot);
  return {
    ...input,
    id: String(row.id),
    organizationId: String(row.organization_id),
    projectId: String(row.project_id),
    revision: Number(row.revision),
    plannedStartAt: row.planned_start_at ? iso(row.planned_start_at) : null,
    plannedEndAt: row.planned_end_at ? iso(row.planned_end_at) : null,
    createdByIdentityId: String(row.created_by_identity_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    readiness: cplVisitReadiness(input),
  };
}
function cleanVisit(value: CplVisitInput): CplVisitInput {
  return {
    purpose: value.purpose,
    serviceType: value.serviceType,
    status: value.status,
    timeZone: value.timeZone,
    plannedStartLocal: value.plannedStartLocal,
    plannedEndLocal: value.plannedEndLocal,
    plannedStartOffsetMinutes: value.plannedStartOffsetMinutes,
    plannedEndOffsetMinutes: value.plannedEndOffsetMinutes,
    responsibleIdentityId: value.responsibleIdentityId,
    siteName: value.siteName,
    siteAddress: value.siteAddress,
    accessInstructions: value.accessInstructions,
    actualStartAt: value.actualStartAt,
    actualEndAt: value.actualEndAt,
    completionNote: value.completionNote,
    cancellationReason: value.cancellationReason,
    tasks: value.tasks,
  };
}
/** All execution extends the existing immutable commercial project, within the
 * existing authenticated tenant transaction. No legacy operational tables. */
export class SqlCplExecutionRepository {
  constructor(private readonly tenants: SqlCplTenantRepository) {}
  private run<T>(
    request: CplTenantRequest,
    write: boolean,
    operation: (e: SqlExecutor, a: CplTenantAccess) => Promise<T>,
  ): Promise<T> {
    return this.tenants.withTenantReadTransaction(
      request,
      ["award-to-project-launcher"],
      async (e, a) => {
        const protection = await e.query<Row>(
          "SELECT count(*)=7 AND bool_and(relrowsecurity AND relforcerowsecurity) AS protected FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN ('cpl_commercial_projects','cpl_project_operations','cpl_project_team','cpl_project_visits','cpl_project_tasks','cpl_execution_events','cpl_execution_mutations')",
        );
        if (protection.rows[0]?.protected !== true) fail("CPL_EXECUTION_SCHEMA_UNSAFE");
        // One organization lock makes conflict detection plus interval mutation
        // atomic without requiring an extension or trusting a prior UI check.
        await e.query(
          write
            ? "SELECT pg_advisory_xact_lock(hashtextextended($1,31))"
            : "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,31))",
          [a.organizationId],
        );
        return operation(e, a);
      },
    );
  }
  private plan(a: CplTenantAccess) {
    if (!cplTenantRoleAllows(a.role, "execution:plan")) fail("CPL_ACCESS_DENIED");
  }
  private async parent(
    e: SqlExecutor,
    a: CplTenantAccess,
    id: string,
  ): Promise<CplCommercialProject> {
    const rows = await e.query<Row>(
      "SELECT * FROM cpl_commercial_projects WHERE organization_id=$1 AND id=$2",
      [a.organizationId, cplExecutionId(id)],
    );
    return project(rows.rows[0] ?? fail("CPL_RECORD_NOT_FOUND"));
  }
  private async operations(
    e: SqlExecutor,
    a: CplTenantAccess,
    p: CplCommercialProject,
  ): Promise<CplProjectOperations> {
    const rows = await e.query<Row>(
      "SELECT * FROM cpl_project_operations WHERE organization_id=$1 AND project_id=$2",
      [a.organizationId, p.id],
    );
    const row = rows.rows[0];
    if (row)
      return {
        ...json<CplProjectOperationsInput>(row.snapshot),
        projectId: p.id,
        revision: Number(row.revision),
        updatedAt: iso(row.updated_at),
        updatedByIdentityId: String(row.updated_by_identity_id),
      };
    return {
      projectId: p.id,
      revision: 0,
      name: p.snapshot.version.content.title,
      status: "active",
      ownerIdentityId: null,
      teamIdentityIds: [],
      nextAction: "",
      operationalInstructions: p.snapshot.version.content.accessInstructions,
      internalNotes: p.snapshot.internalNotes,
      timeZone: CPL_EXECUTION_TIME_ZONE,
      statusReason: "",
      updatedAt: null,
      updatedByIdentityId: null,
    };
  }
  private async member(e: SqlExecutor, a: CplTenantAccess, identityId: string | null) {
    if (!identityId) return;
    const rows = await e.query<Row>(
      "SELECT m.identity_id FROM cpl_memberships m JOIN cpl_identities i ON i.id=m.identity_id WHERE m.organization_id=$1 AND m.identity_id=$2 AND m.status='active' AND i.status='active' FOR SHARE OF m,i",
      [a.organizationId, identityId],
    );
    if (!rows.rows[0]) fail("CPL_EXECUTION_MEMBER_UNAVAILABLE");
  }
  private async event(
    e: SqlExecutor,
    a: CplTenantAccess,
    projectId: string,
    visitId: string | null,
    action: string,
    revision: number,
    before: unknown,
    after: unknown,
  ) {
    const id = randomUUID();
    await e.query(
      "INSERT INTO cpl_execution_events(id,organization_id,project_id,visit_id,action,revision,before_snapshot,after_snapshot,actor_identity_id) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)",
      [
        id,
        a.organizationId,
        projectId,
        visitId,
        action,
        revision,
        before ? JSON.stringify(before) : null,
        JSON.stringify(after),
        a.identityId,
      ],
    );
    await e.query(
      "INSERT INTO cpl_tenant_audit_events(id,organization_id,actor_identity_id,action,resource_id) VALUES($1,$2,$3,$4,$5)",
      [randomUUID(), a.organizationId, a.identityId, action, visitId ?? projectId],
    );
  }
  private async mutation(
    e: SqlExecutor,
    a: CplTenantAccess,
    kind: string,
    key: string,
    payload: unknown,
    resourceId: string,
  ): Promise<{ duplicate: boolean; resourceId: string }> {
    if (typeof key !== "string" || !/^[A-Za-z0-9_-]{8,120}$/u.test(key))
      fail("CPL_INVALID_IDEMPOTENCY_KEY");
    const hash = digest(payload);
    const inserted = await e.query<Row>(
      "INSERT INTO cpl_execution_mutations(organization_id,mutation_kind,idempotency_key,request_hash,resource_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING resource_id",
      [a.organizationId, kind, key, hash, resourceId],
    );
    if (inserted.rows[0]) return { duplicate: false, resourceId };
    const prior = await e.query<Row>(
      "SELECT * FROM cpl_execution_mutations WHERE organization_id=$1 AND mutation_kind=$2 AND idempotency_key=$3",
      [a.organizationId, kind, key],
    );
    if (prior.rows[0]?.request_hash !== hash) fail("CPL_IDEMPOTENCY_CONFLICT");
    return { duplicate: true, resourceId: String(prior.rows[0]!.resource_id) };
  }
  private async row(
    e: SqlExecutor,
    a: CplTenantAccess,
    projectId: string,
    visitId: string,
  ): Promise<CplVisit> {
    const rows = await e.query<Row>(
      "SELECT * FROM cpl_project_visits WHERE organization_id=$1 AND project_id=$2 AND id=$3",
      [a.organizationId, cplExecutionId(projectId), cplExecutionId(visitId)],
    );
    return visit(rows.rows[0] ?? fail("CPL_RECORD_NOT_FOUND"));
  }
  private async workspace(
    e: SqlExecutor,
    a: CplTenantAccess,
    p: CplCommercialProject,
  ): Promise<CplProjectWorkspace> {
    const operations = await this.operations(e, a, p);
    const members = await e.query<Row>(
      "SELECT m.identity_id,i.display_name,m.role FROM cpl_memberships m JOIN cpl_identities i ON i.id=m.identity_id WHERE m.organization_id=$1 AND m.status='active' AND i.status='active' ORDER BY i.display_name,m.identity_id LIMIT 101",
      [a.organizationId],
    );
    if (members.rows.length > 100) fail("CPL_EXECUTION_DIRECTORY_LIMIT");
    const visits = await e.query<Row>(
      "SELECT * FROM cpl_project_visits WHERE organization_id=$1 AND project_id=$2 ORDER BY planned_start_at NULLS LAST,created_at,id LIMIT 201",
      [a.organizationId, p.id],
    );
    if (visits.rows.length > 200) fail("CPL_EXECUTION_VISIT_LIMIT");
    const events = await e.query<Row>(
      "SELECT * FROM cpl_execution_events WHERE organization_id=$1 AND project_id=$2 ORDER BY created_at DESC,id DESC LIMIT 200",
      [a.organizationId, p.id],
    );
    return {
      project: p,
      operations,
      members: members.rows.map((row): CplExecutionMember => ({
        identityId: String(row.identity_id),
        displayName: String(row.display_name),
        role: String(row.role),
      })),
      visits: visits.rows.map(visit),
      events: events.rows.map((row): CplExecutionEvent => ({
        id: String(row.id),
        projectId: String(row.project_id),
        visitId: row.visit_id ? String(row.visit_id) : null,
        action: String(row.action),
        revision: Number(row.revision),
        actorIdentityId: String(row.actor_identity_id),
        createdAt: iso(row.created_at),
        before: row.before_snapshot ? json(row.before_snapshot) : null,
        after: json(row.after_snapshot),
      })),
      permissions: {
        canPlan: cplTenantRoleAllows(a.role, "execution:plan"),
        canCompleteAssignedVisits: cplTenantRoleAllows(a.role, "execution:field"),
      },
      currentIdentityId: a.identityId,
    };
  }
  async getProjectWorkspace(request: ProjectRequest): Promise<CplProjectWorkspace> {
    return this.run(request, false, async (e, a) =>
      this.workspace(e, a, await this.parent(e, a, request.projectId)),
    );
  }
  async getVisit(request: ProjectRequest & { visitId: string }): Promise<CplVisit> {
    return this.run(request, false, async (e, a) => {
      await this.parent(e, a, request.projectId);
      return this.row(e, a, request.projectId, request.visitId);
    });
  }
  async readAgenda(
    request: CplTenantRequest & { from: string; to: string },
  ): Promise<CplExecutionAgenda> {
    const from = cplExecutionInstant(request.from),
      to = cplExecutionInstant(request.to);
    if (!from || !to || to <= from || Date.parse(to) - Date.parse(from) > 93 * 86400000)
      fail("CPL_INVALID_INPUT");
    return this.run(request, false, async (e, a) => {
      const rows = await e.query<Row>(
        "SELECT v.*,p.reference AS project_reference,COALESCE(o.name,p.snapshot->'version'->'content'->>'title') AS project_name FROM cpl_project_visits v JOIN cpl_commercial_projects p ON p.organization_id=v.organization_id AND p.id=v.project_id LEFT JOIN cpl_project_operations o ON o.organization_id=v.organization_id AND o.project_id=v.project_id WHERE v.organization_id=$1 AND v.planned_start_at<$3 AND v.planned_end_at>$2 ORDER BY v.planned_start_at,v.id LIMIT 501",
        [a.organizationId, from, to],
      );
      return {
        from,
        to,
        items: rows.rows.slice(0, 500).map((row) => ({
          visit: visit(row),
          projectReference: String(row.project_reference),
          projectName: String(row.project_name),
        })),
        truncated: rows.rows.length > 500,
      };
    });
  }
  async saveProject(
    request: ProjectRequest & { expectedRevision: number; idempotencyKey: string; input: unknown },
  ): Promise<CplProjectWorkspace> {
    const input = normalizeCplProjectOperations(request.input),
      expected = cplExecutionRevision(request.expectedRevision);
    return this.run(request, true, async (e, a) => {
      this.plan(a);
      const p = await this.parent(e, a, request.projectId);
      const key = await this.mutation(
        e,
        a,
        "project.save",
        request.idempotencyKey,
        { projectId: p.id, expectedRevision: expected, input },
        p.id,
      );
      if (key.duplicate) return this.workspace(e, a, p);
      const prior = await this.operations(e, a, p);
      if (prior.revision !== expected) fail("CPL_EXECUTION_VERSION_CONFLICT");
      if (["completed", "cancelled"].includes(input.status)) {
        const active = await e.query<Row>(
          "SELECT id FROM cpl_project_visits WHERE organization_id=$1 AND project_id=$2 AND status NOT IN ('completed','cancelled') LIMIT 1",
          [a.organizationId, p.id],
        );
        if (active.rows[0]) fail("CPL_EXECUTION_OPEN_VISITS");
      }
      for (const id of [...new Set([input.ownerIdentityId, ...input.teamIdentityIds])]
        .filter((id): id is string => Boolean(id))
        .sort())
        await this.member(e, a, id);
      await e.query(
        "INSERT INTO cpl_project_operations(organization_id,project_id,revision,name,status,owner_identity_id,snapshot,updated_by_identity_id) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT(organization_id,project_id) DO UPDATE SET revision=EXCLUDED.revision,name=EXCLUDED.name,status=EXCLUDED.status,owner_identity_id=EXCLUDED.owner_identity_id,snapshot=EXCLUDED.snapshot,updated_by_identity_id=EXCLUDED.updated_by_identity_id,updated_at=CURRENT_TIMESTAMP",
        [
          a.organizationId,
          p.id,
          expected + 1,
          input.name,
          input.status,
          input.ownerIdentityId,
          JSON.stringify(input),
          a.identityId,
        ],
      );
      await e.query(
        "UPDATE cpl_project_team SET active=FALSE WHERE organization_id=$1 AND project_id=$2",
        [a.organizationId, p.id],
      );
      for (const id of input.teamIdentityIds)
        await e.query(
          "INSERT INTO cpl_project_team(organization_id,project_id,identity_id) VALUES($1,$2,$3) ON CONFLICT(organization_id,project_id,identity_id) DO UPDATE SET active=TRUE",
          [a.organizationId, p.id, id],
        );
      await this.event(e, a, p.id, null, "project.operations_saved", expected + 1, prior, input);
      return this.workspace(e, a, p);
    });
  }
  private validateState(input: NormalizedVisit, prior?: CplVisit) {
    const transitions = {
      draft: ["draft", "scheduled", "cancelled"],
      scheduled: ["scheduled", "draft", "in_progress", "completed", "cancelled"],
      in_progress: ["in_progress", "completed", "cancelled"],
      completed: [],
      cancelled: [],
    };
    if (
      prior
        ? !(transitions[prior.status] as string[]).includes(input.status)
        : !["draft", "scheduled"].includes(input.status)
    )
      fail("CPL_EXECUTION_STATE_CONFLICT");
    if (input.status !== "cancelled" && input.cancellationReason) fail("CPL_INVALID_INPUT");
    if (
      ["draft", "scheduled"].includes(input.status) &&
      (input.actualStartAt || input.actualEndAt || input.completionNote)
    )
      fail("CPL_INVALID_INPUT");
    if (input.status === "in_progress" && (!input.actualStartAt || input.actualEndAt))
      fail("CPL_EXECUTION_VISIT_NOT_READY");
    if (
      ["scheduled", "in_progress", "completed"].includes(input.status) &&
      cplVisitReadiness(input).some((item) => item.code !== "task_incomplete")
    )
      fail("CPL_EXECUTION_VISIT_NOT_READY");
    if (
      input.status === "completed" &&
      (!input.actualStartAt ||
        !input.actualEndAt ||
        !input.completionNote ||
        cplVisitReadiness(input).length)
    )
      fail("CPL_EXECUTION_VISIT_NOT_READY");
  }
  private async conflicts(
    e: SqlExecutor,
    a: CplTenantAccess,
    input: NormalizedVisit,
    ownId: string,
  ) {
    if (!["scheduled", "in_progress"].includes(input.status) || !input.responsibleIdentityId)
      return;
    const rows = await e.query<Row>(
      "SELECT id,project_id,snapshot,planned_start_at,planned_end_at FROM cpl_project_visits WHERE organization_id=$1 AND responsible_identity_id=$2 AND id<>$3 AND status IN ('scheduled','in_progress') AND planned_start_at<$5 AND planned_end_at>$4 ORDER BY planned_start_at,id LIMIT 20",
      [
        a.organizationId,
        input.responsibleIdentityId,
        ownId,
        input.plannedStartAt,
        input.plannedEndAt,
      ],
    );
    if (rows.rows.length)
      throw new CplExecutionConflictError(
        rows.rows.map((row) => ({
          visitId: String(row.id),
          projectId: String(row.project_id),
          purpose: json<CplVisitInput>(row.snapshot).purpose,
          plannedStartAt: iso(row.planned_start_at),
          plannedEndAt: iso(row.planned_end_at),
          timeZone: json<CplVisitInput>(row.snapshot).timeZone,
        })),
      );
  }
  private async tasks(
    e: SqlExecutor,
    a: CplTenantAccess,
    projectId: string,
    visitId: string,
    input: NormalizedVisit,
  ) {
    await e.query(
      "UPDATE cpl_project_tasks SET removed=TRUE WHERE organization_id=$1 AND project_id=$2 AND visit_id=$3",
      [a.organizationId, projectId, visitId],
    );
    for (const [index, task] of input.tasks.entries()) {
      const saved = await e.query<Row>(
        "INSERT INTO cpl_project_tasks(id,organization_id,project_id,visit_id,snapshot,sort_order) VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(id) DO UPDATE SET snapshot=EXCLUDED.snapshot,sort_order=EXCLUDED.sort_order,removed=FALSE WHERE cpl_project_tasks.organization_id=EXCLUDED.organization_id AND cpl_project_tasks.project_id=EXCLUDED.project_id AND cpl_project_tasks.visit_id=EXCLUDED.visit_id RETURNING id",
        [task.id, a.organizationId, projectId, visitId, JSON.stringify(task), index],
      );
      if (!saved.rows[0]) fail("CPL_INVALID_INPUT");
    }
  }
  async createVisit(
    request: ProjectRequest & { idempotencyKey: string; input: unknown },
  ): Promise<CplVisit> {
    const input = normalizeCplVisit(request.input);
    return this.run(request, true, async (e, a) => {
      this.plan(a);
      const p = await this.parent(e, a, request.projectId);
      const key = await this.mutation(
        e,
        a,
        "visit.create",
        request.idempotencyKey,
        { projectId: p.id, input },
        randomUUID(),
      );
      if (key.duplicate) return this.row(e, a, p.id, key.resourceId);
      if ((await this.operations(e, a, p)).status !== "active")
        fail("CPL_EXECUTION_STATE_CONFLICT");
      const count = await e.query<Row>(
        "SELECT count(*) AS total FROM cpl_project_visits WHERE organization_id=$1 AND project_id=$2",
        [a.organizationId, p.id],
      );
      if (Number(count.rows[0]?.total) >= 200) fail("CPL_EXECUTION_VISIT_LIMIT");
      this.validateState(input);
      await this.member(e, a, input.responsibleIdentityId);
      await this.conflicts(e, a, input, key.resourceId);
      await e.query(
        "INSERT INTO cpl_project_visits(id,organization_id,project_id,revision,status,responsible_identity_id,planned_start_at,planned_end_at,snapshot,created_by_identity_id) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8::jsonb,$9)",
        [
          key.resourceId,
          a.organizationId,
          p.id,
          input.status,
          input.responsibleIdentityId,
          input.plannedStartAt,
          input.plannedEndAt,
          JSON.stringify(input),
          a.identityId,
        ],
      );
      await this.tasks(e, a, p.id, key.resourceId, input);
      await this.event(e, a, p.id, key.resourceId, "visit.created", 1, null, cleanVisit(input));
      return this.row(e, a, p.id, key.resourceId);
    });
  }
  async saveVisit(
    request: ProjectRequest & {
      visitId: string;
      expectedRevision: number;
      idempotencyKey: string;
      input: unknown;
    },
  ): Promise<CplVisit> {
    const input = normalizeCplVisit(request.input),
      expected = cplExecutionRevision(request.expectedRevision);
    return this.run(request, true, async (e, a) => {
      const p = await this.parent(e, a, request.projectId),
        prior = await this.row(e, a, p.id, request.visitId);
      const planner = cplTenantRoleAllows(a.role, "execution:plan");
      if (
        !planner &&
        !(
          cplTenantRoleAllows(a.role, "execution:field") &&
          prior.responsibleIdentityId === a.identityId
        )
      )
        fail("CPL_ACCESS_DENIED");
      if (!planner) {
        const planning = (v: CplVisitInput) => ({
          purpose: v.purpose,
          serviceType: v.serviceType,
          timeZone: v.timeZone,
          plannedStartLocal: v.plannedStartLocal,
          plannedEndLocal: v.plannedEndLocal,
          plannedStartOffsetMinutes: v.plannedStartOffsetMinutes,
          plannedEndOffsetMinutes: v.plannedEndOffsetMinutes,
          responsibleIdentityId: v.responsibleIdentityId,
          siteName: v.siteName,
          siteAddress: v.siteAddress,
          accessInstructions: v.accessInstructions,
          tasks: v.tasks.map((t) => ({
            id: t.id,
            title: t.title,
            instructions: t.instructions,
            required: t.required,
          })),
        });
        if (
          digest(planning(input)) !== digest(planning(prior)) ||
          !["in_progress", "completed"].includes(input.status)
        )
          fail("CPL_ACCESS_DENIED");
      }
      const key = await this.mutation(
        e,
        a,
        "visit.save",
        request.idempotencyKey,
        { projectId: p.id, visitId: prior.id, expectedRevision: expected, input },
        prior.id,
      );
      if (key.duplicate) return prior;
      if (prior.revision !== expected) fail("CPL_EXECUTION_VERSION_CONFLICT");
      const ops = await this.operations(e, a, p);
      if (ops.status !== "active" && input.status !== "cancelled")
        fail("CPL_EXECUTION_STATE_CONFLICT");
      this.validateState(input, prior);
      if (input.status === "completed") {
        const field = await readCplFieldReadiness(e, a.organizationId, p.id, prior.id);
        if (field.attached) {
          const entitlement = await e.query<Row>(
            "SELECT enabled,usage_limit FROM cpl_module_entitlements WHERE organization_id=$1 AND module_key='field-report-assembler' FOR SHARE",
            [a.organizationId],
          );
          if (
            entitlement.rows[0]?.enabled !== true ||
            Number(entitlement.rows[0]?.usage_limit ?? 1) === 0
          )
            fail("CPL_MODULE_DISABLED");
          if (field.readiness.length) fail("CPL_FIELD_VISIT_NOT_READY");
        }
      }
      if (input.status !== "cancelled") await this.member(e, a, input.responsibleIdentityId);
      await this.conflicts(e, a, input, prior.id);
      await e.query(
        "UPDATE cpl_project_visits SET revision=revision+1,status=$4,responsible_identity_id=$5,planned_start_at=$6,planned_end_at=$7,snapshot=$8::jsonb,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND project_id=$2 AND id=$3",
        [
          a.organizationId,
          p.id,
          prior.id,
          input.status,
          input.responsibleIdentityId,
          input.plannedStartAt,
          input.plannedEndAt,
          JSON.stringify(input),
        ],
      );
      await this.tasks(e, a, p.id, prior.id, input);
      await this.event(
        e,
        a,
        p.id,
        prior.id,
        input.status !== prior.status ? `visit.${input.status}` : "visit.updated",
        expected + 1,
        cleanVisit(prior),
        cleanVisit(input),
      );
      if (prior.status !== "completed" && input.status === "completed")
        await emitCplBusinessEvent(e, a, {
          type: "fieldwork.submitted",
          sourceKind: "visit",
          sourceId: prior.id,
          sourceVersion: expected + 1,
          projectId: p.id,
          service: input.serviceType,
          title: input.purpose,
        });
      return this.row(e, a, p.id, prior.id);
    });
  }
}
