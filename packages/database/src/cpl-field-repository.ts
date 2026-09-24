import { createHash, randomUUID } from "node:crypto";
import { validateCplPhotoAnnotations } from "@bea/artifacts/cpl-photo-annotations";
import {
  cplExecutionId,
  cplExecutionRevision,
  cplVisitReadiness,
  type CplVisit,
  type CplVisitInput,
} from "@bea/domain/cpl-execution";
import {
  cplFieldObject,
  cplFieldReadiness,
  cplFieldText,
  normalizeCplFieldAnswers,
  normalizeCplFieldObservation,
  normalizeCplFieldPhotoMetadata,
  normalizeCplFieldPhotoUpload,
  normalizeCplFieldTemplate,
  type CplFieldAnswer,
  type CplFieldTemplateVersion,
  type CplFieldTemplateInput,
  type CplFieldWorkspace,
  type CplFieldObservation,
  type CplFieldObservationRevision,
  type CplFieldPhoto,
  type CplFieldPhotoDerivative,
  type CplFieldPhotoMetadata,
  type CplFieldPhotoTransfer,
  type CplFieldPhotoUploadInput,
  type CplFieldEvidenceReference,
} from "@bea/domain/cpl-field";
import type { SqlExecutor } from "./adapter.js";
import {
  CplTenantAccessError,
  cplTenantRoleAllows,
  type CplTenantAccess,
  type CplTenantRequest,
  type SqlCplTenantRepository,
} from "./tenant-repository.js";

type Row = Record<string, unknown>;
type VisitRequest = CplTenantRequest & { projectId: string; visitId: string };
type EditRequest = VisitRequest & { expectedRevision: number; idempotencyKey: string };
type PhotoRequest = VisitRequest & { photoId: string };
function fail(code: string): never {
  throw new CplTenantAccessError(code);
}
function json<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}
function iso(value: unknown): string {
  return new Date(String(value)).toISOString();
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function positive(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max)
    fail("CPL_FIELD_INVALID_INPUT");
  return value;
}
function template(row: Row): CplFieldTemplateVersion {
  return {
    ...json<CplFieldTemplateInput>(row.snapshot),
    id: String(row.id),
    organizationId: String(row.organization_id),
    version: Number(row.version),
    createdByIdentityId: String(row.created_by_identity_id),
    createdAt: iso(row.created_at),
  };
}
function mapVisit(row: Row): CplVisit {
  const v = json<CplVisitInput>(row.snapshot);
  return {
    ...v,
    id: String(row.id),
    organizationId: String(row.organization_id),
    projectId: String(row.project_id),
    revision: Number(row.revision),
    plannedStartAt: row.planned_start_at ? iso(row.planned_start_at) : null,
    plannedEndAt: row.planned_end_at ? iso(row.planned_end_at) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    createdByIdentityId: String(row.created_by_identity_id),
    readiness: cplVisitReadiness(v),
  };
}
function revision<T>(
  row: Row,
): T & { revision: number; createdByIdentityId: string; createdAt: string } {
  return {
    ...json<T>(row.snapshot),
    revision: Number(row.revision),
    createdByIdentityId: String(row.created_by_identity_id),
    createdAt: iso(row.created_at),
  };
}
function derivative(input: unknown, maxSide: number): CplFieldPhotoDerivative {
  const v = cplFieldObject(input);
  if (
    v.mimeType !== "image/png" ||
    typeof v.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(v.sha256) ||
    v.pipelineVersion !== "cpl-image-v1-sharp-0.35.4"
  )
    fail("CPL_FIELD_INVALID_INPUT");
  return {
    sha256: v.sha256,
    byteLength: positive(v.byteLength, 64 * 1024 * 1024),
    width: positive(v.width, maxSide),
    height: positive(v.height, maxSide),
    mimeType: "image/png",
    pipelineVersion: v.pipelineVersion,
  };
}
/** Tenant authority, revision control and immutable evidence metadata. Bytes are
 * handled by the authenticated server service, never by client-supplied paths. */
export class SqlCplFieldRepository {
  constructor(private readonly tenants: SqlCplTenantRepository) {}
  private run<T>(
    request: CplTenantRequest,
    write: boolean,
    operation: (e: SqlExecutor, a: CplTenantAccess) => Promise<T>,
  ): Promise<T> {
    return this.tenants.withTenantReadTransaction(
      request,
      ["award-to-project-launcher", "field-report-assembler"],
      async (e, a) => {
        const protectedRows = await e.query<Row>(
          "SELECT count(*)=9 AND bool_and(relrowsecurity AND relforcerowsecurity) AS protected FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN ('cpl_field_templates','cpl_field_records','cpl_field_checklist_revisions','cpl_field_observations','cpl_field_observation_revisions','cpl_field_photos','cpl_field_photo_revisions','cpl_field_events','cpl_field_mutations')",
        );
        if (protectedRows.rows[0]?.protected !== true) fail("CPL_FIELD_SCHEMA_UNSAFE");
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
  private async visit(
    e: SqlExecutor,
    a: CplTenantAccess,
    request: VisitRequest,
    edit = false,
  ): Promise<CplVisit> {
    const rows = await e.query<Row>(
      "SELECT * FROM cpl_project_visits WHERE organization_id=$1 AND project_id=$2 AND id=$3",
      [a.organizationId, cplExecutionId(request.projectId), cplExecutionId(request.visitId)],
    );
    const v = mapVisit(rows.rows[0] ?? fail("CPL_RECORD_NOT_FOUND"));
    if (a.role === "field-user" && v.responsibleIdentityId !== a.identityId)
      fail("CPL_ACCESS_DENIED");
    if (edit) {
      if (!cplTenantRoleAllows(a.role, "field:write")) fail("CPL_ACCESS_DENIED");
      if (["completed", "cancelled"].includes(v.status)) fail("CPL_FIELD_VISIT_LOCKED");
      const operations = await e.query<Row>(
        "SELECT status FROM cpl_project_operations WHERE organization_id=$1 AND project_id=$2",
        [a.organizationId, v.projectId],
      );
      if (operations.rows[0] && operations.rows[0].status !== "active")
        fail("CPL_EXECUTION_STATE_CONFLICT");
    }
    return v;
  }
  private async record(
    e: SqlExecutor,
    a: CplTenantAccess,
    request: VisitRequest,
    required = true,
  ): Promise<Row | undefined> {
    const rows = await e.query<Row>(
      "SELECT * FROM cpl_field_records WHERE organization_id=$1 AND project_id=$2 AND visit_id=$3",
      [a.organizationId, request.projectId, request.visitId],
    );
    if (!rows.rows[0] && required) fail("CPL_FIELD_TEMPLATE_REQUIRED");
    return rows.rows[0];
  }
  private checkRevision(record: Row | undefined, expected: number) {
    if (Number(record?.revision ?? 0) !== cplExecutionRevision(expected))
      fail("CPL_FIELD_VERSION_CONFLICT");
  }
  private async bump(e: SqlExecutor, a: CplTenantAccess, request: VisitRequest): Promise<number> {
    const result = await e.query<Row>(
      "UPDATE cpl_field_records SET revision=revision+1,updated_by_identity_id=$4,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND project_id=$2 AND visit_id=$3 RETURNING revision",
      [a.organizationId, request.projectId, request.visitId, a.identityId],
    );
    return Number(result.rows[0]?.revision ?? fail("CPL_FIELD_TEMPLATE_REQUIRED"));
  }
  private async mutation(
    e: SqlExecutor,
    a: CplTenantAccess,
    kind: string,
    key: string,
    payload: unknown,
    resourceId: string,
  ) {
    if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{8,120}$/u.test(key))
      fail("CPL_INVALID_IDEMPOTENCY_KEY");
    const hash = digest(payload),
      prior = await e.query<Row>(
        "SELECT request_hash,resource_id FROM cpl_field_mutations WHERE organization_id=$1 AND mutation_kind=$2 AND idempotency_key=$3",
        [a.organizationId, kind, key],
      );
    if (prior.rows[0]) {
      if (prior.rows[0].request_hash !== hash) fail("CPL_IDEMPOTENCY_CONFLICT");
      return { duplicate: true, resourceId: String(prior.rows[0].resource_id) };
    }
    await e.query(
      "INSERT INTO cpl_field_mutations(organization_id,mutation_kind,idempotency_key,request_hash,resource_id) VALUES($1,$2,$3,$4,$5)",
      [a.organizationId, kind, key, hash, resourceId],
    );
    return { duplicate: false, resourceId };
  }
  private async audit(e: SqlExecutor, a: CplTenantAccess, action: string, resourceId: string) {
    await e.query(
      "INSERT INTO cpl_tenant_audit_events(id,organization_id,actor_identity_id,action,resource_id) VALUES($1,$2,$3,$4,$5)",
      [randomUUID(), a.organizationId, a.identityId, action, resourceId],
    );
  }
  private async event(
    e: SqlExecutor,
    a: CplTenantAccess,
    request: VisitRequest,
    action: string,
    version: number,
    resourceId: string | null = null,
    note = "",
  ) {
    await e.query(
      "INSERT INTO cpl_field_events(id,organization_id,project_id,visit_id,action,revision,resource_id,note,actor_identity_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        randomUUID(),
        a.organizationId,
        request.projectId,
        request.visitId,
        action,
        version,
        resourceId,
        note,
        a.identityId,
      ],
    );
    await this.audit(e, a, action, resourceId ?? request.visitId);
  }
  private async templates(e: SqlExecutor, a: CplTenantAccess): Promise<CplFieldTemplateVersion[]> {
    const rows = await e.query<Row>(
      "SELECT * FROM cpl_field_templates WHERE organization_id=$1 ORDER BY created_at DESC,id,version DESC LIMIT 201",
      [a.organizationId],
    );
    if (rows.rows.length > 200) fail("CPL_FIELD_TEMPLATE_LIMIT");
    return rows.rows.map(template);
  }
  async listTemplates(request: CplTenantRequest) {
    return this.run(request, false, (e, a) => {
      if (a.role === "field-user") fail("CPL_ACCESS_DENIED");
      return this.templates(e, a);
    });
  }
  async saveTemplate(
    request: CplTenantRequest & {
      templateId?: string;
      expectedVersion: number;
      idempotencyKey: string;
      input: unknown;
    },
  ): Promise<CplFieldTemplateVersion> {
    const input = normalizeCplFieldTemplate(request.input),
      expected = cplExecutionRevision(request.expectedVersion);
    const id = request.templateId ? cplExecutionId(request.templateId) : null;
    return this.run(request, true, async (e, a) => {
      if (!cplTenantRoleAllows(a.role, "field:templates")) fail("CPL_ACCESS_DENIED");
      const key = await this.mutation(
        e,
        a,
        "template.save",
        request.idempotencyKey,
        { id, expected, input },
        id ?? randomUUID(),
      );
      const prior = await e.query<Row>(
        "SELECT * FROM cpl_field_templates WHERE organization_id=$1 AND id=$2 ORDER BY version DESC LIMIT 1",
        [a.organizationId, key.resourceId],
      );
      if (key.duplicate) {
        const saved = await e.query<Row>(
          "SELECT * FROM cpl_field_templates WHERE organization_id=$1 AND id=$2 AND version=$3",
          [a.organizationId, key.resourceId, expected + 1],
        );
        return template(saved.rows[0] ?? fail("CPL_RECORD_NOT_FOUND"));
      }
      if (Number(prior.rows[0]?.version ?? 0) !== expected || (!!id && !prior.rows[0]))
        fail("CPL_FIELD_VERSION_CONFLICT");
      if ((await this.templates(e, a)).length >= 200) fail("CPL_FIELD_TEMPLATE_LIMIT");
      const rows = await e.query<Row>(
        "INSERT INTO cpl_field_templates(organization_id,id,version,snapshot,created_by_identity_id) VALUES($1,$2,$3,$4::jsonb,$5) RETURNING *",
        [a.organizationId, key.resourceId, expected + 1, JSON.stringify(input), a.identityId],
      );
      await this.audit(e, a, "field.template.saved", key.resourceId);
      return template(rows.rows[0]!);
    });
  }
  private async templateFor(
    e: SqlExecutor,
    a: CplTenantAccess,
    record: Row,
  ): Promise<CplFieldTemplateVersion> {
    const rows = await e.query<Row>(
      "SELECT * FROM cpl_field_templates WHERE organization_id=$1 AND id=$2 AND version=$3",
      [a.organizationId, record.template_id, record.template_version],
    );
    return template(rows.rows[0] ?? fail("CPL_RECORD_NOT_FOUND"));
  }
  private async photos(
    e: SqlExecutor,
    a: CplTenantAccess,
    request: VisitRequest,
  ): Promise<CplFieldPhoto[]> {
    const rows = await e.query<Row>(
      "SELECT * FROM cpl_field_photos WHERE organization_id=$1 AND project_id=$2 AND visit_id=$3 ORDER BY created_at,id",
      [a.organizationId, request.projectId, request.visitId],
    );
    const histories = await e.query<Row>(
      "SELECT * FROM cpl_field_photo_revisions WHERE organization_id=$1 AND project_id=$2 AND visit_id=$3 ORDER BY revision DESC",
      [a.organizationId, request.projectId, request.visitId],
    );
    return rows.rows.map((row) => {
      const revisions = histories.rows
        .filter((h) => h.photo_id === row.id)
        .map((h) => revision<CplFieldPhotoMetadata>(h));
      return {
        id: String(row.id),
        organizationId: a.organizationId,
        projectId: request.projectId,
        visitId: request.visitId,
        revision: Number(row.revision),
        state: row.state as CplFieldPhoto["state"],
        failureCode: row.failure_code as CplFieldPhoto["failureCode"],
        attempts: Number(row.attempts),
        processingExpiresAt: row.processing_expires_at ? iso(row.processing_expires_at) : null,
        original: {
          ...json<CplFieldPhotoUploadInput>(row.upload),
          width: null,
          height: null,
          exifOrientation: null,
          ...(row.original_metadata ? json<object>(row.original_metadata) : {}),
        },
        upright: row.upright ? json<CplFieldPhoto["upright"]>(row.upright) : null,
        thumbnail: row.thumbnail ? json<CplFieldPhotoDerivative>(row.thumbnail) : null,
        report: row.report ? json<CplFieldPhotoDerivative>(row.report) : null,
        metadata: revisions[0] ?? fail("CPL_FIELD_SCHEMA_UNSAFE"),
        revisions,
        createdByIdentityId: String(row.created_by_identity_id),
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
      };
    });
  }
  private async workspace(
    e: SqlExecutor,
    a: CplTenantAccess,
    request: VisitRequest,
  ): Promise<CplFieldWorkspace> {
    const v = await this.visit(e, a, request),
      record = await this.record(e, a, request, false);
    const templates = a.role === "field-user" ? [] : await this.templates(e, a);
    const photos = await this.photos(e, a, request);
    const observations = await e.query<Row>(
      "SELECT * FROM cpl_field_observation_revisions WHERE organization_id=$1 AND project_id=$2 AND visit_id=$3 ORDER BY observation_id,revision DESC",
      [a.organizationId, request.projectId, request.visitId],
    );
    const history = await e.query<Row>(
      "SELECT * FROM cpl_field_checklist_revisions WHERE organization_id=$1 AND project_id=$2 AND visit_id=$3 ORDER BY revision DESC",
      [a.organizationId, request.projectId, request.visitId],
    );
    const events = await e.query<Row>(
      "SELECT * FROM cpl_field_events WHERE organization_id=$1 AND project_id=$2 AND visit_id=$3 ORDER BY created_at DESC,id DESC LIMIT 500",
      [a.organizationId, request.projectId, request.visitId],
    );
    const mapped = new Map<string, CplFieldObservation>();
    for (const row of observations.rows) {
      const id = String(row.observation_id),
        rev = revision<CplFieldObservationRevision>(row),
        prior = mapped.get(id);
      if (prior) prior.revisions.push(rev);
      else mapped.set(id, { ...rev, id, revisions: [rev] });
    }
    const pinned = record ? await this.templateFor(e, a, record) : null,
      answers = record ? json<CplFieldAnswer[]>(record.answers) : [];
    const planner = cplTenantRoleAllows(a.role, "execution:plan"),
      writable =
        cplTenantRoleAllows(a.role, "field:write") &&
        !["completed", "cancelled"].includes(v.status);
    return {
      projectId: request.projectId,
      visit: v,
      revision: Number(record?.revision ?? 0),
      template: pinned,
      templates: a.role === "field-user" ? (pinned ? [pinned] : []) : templates,
      answers,
      checklistRevisions: history.rows.map((row) => ({
        revision: Number(row.revision),
        answers: json<CplFieldAnswer[]>(row.answers),
        createdByIdentityId: String(row.created_by_identity_id),
        createdAt: iso(row.created_at),
      })),
      observations: [...mapped.values()],
      photos,
      events: events.rows.map((row) => ({
        id: String(row.id),
        action: String(row.action),
        revision: Number(row.revision),
        resourceId: row.resource_id ? String(row.resource_id) : null,
        actorIdentityId: String(row.actor_identity_id),
        createdAt: iso(row.created_at),
        note: String(row.note),
      })),
      readiness: cplFieldReadiness(pinned, answers, photos),
      permissions: {
        canManageTemplates: cplTenantRoleAllows(a.role, "field:templates"),
        canAttachTemplate: writable && !record && planner,
        canEdit: writable && !!record,
        canReopen: planner && v.status === "completed" && !!record,
      },
    };
  }
  async getVisitWorkspace(request: VisitRequest): Promise<CplFieldWorkspace> {
    return this.run(request, false, (e, a) => this.workspace(e, a, request));
  }
  async attachTemplate(
    request: EditRequest & { templateId: string; templateVersion: number },
  ): Promise<CplFieldWorkspace> {
    const templateId = cplExecutionId(request.templateId),
      templateVersion = positive(request.templateVersion, 2147483646);
    return this.run(request, true, async (e, a) => {
      await this.visit(e, a, request, true);
      if (!cplTenantRoleAllows(a.role, "execution:plan")) fail("CPL_ACCESS_DENIED");
      const key = await this.mutation(
        e,
        a,
        "template.attach",
        request.idempotencyKey,
        {
          projectId: request.projectId,
          visitId: request.visitId,
          expectedRevision: request.expectedRevision,
          templateId,
          templateVersion,
        },
        request.visitId,
      );
      if (key.duplicate) return this.workspace(e, a, request);
      const existing = await this.record(e, a, request, false);
      this.checkRevision(existing, request.expectedRevision);
      if (existing) fail("CPL_FIELD_TEMPLATE_PINNED");
      const found = await e.query<Row>(
        "SELECT id FROM cpl_field_templates WHERE organization_id=$1 AND id=$2 AND version=$3",
        [a.organizationId, templateId, templateVersion],
      );
      if (!found.rows[0]) fail("CPL_RECORD_NOT_FOUND");
      await e.query(
        "INSERT INTO cpl_field_records(organization_id,project_id,visit_id,revision,template_id,template_version,updated_by_identity_id) VALUES($1,$2,$3,1,$4,$5,$6)",
        [
          a.organizationId,
          request.projectId,
          request.visitId,
          templateId,
          templateVersion,
          a.identityId,
        ],
      );
      await this.event(e, a, request, "field.template.attached", 1, templateId);
      return this.workspace(e, a, request);
    });
  }
  async saveChecklist(request: EditRequest & { answers: unknown }): Promise<CplFieldWorkspace> {
    return this.run(request, true, async (e, a) => {
      await this.visit(e, a, request, true);
      const record = (await this.record(e, a, request))!,
        pinned = await this.templateFor(e, a, record);
      const answers = normalizeCplFieldAnswers(request.answers, pinned);
      const key = await this.mutation(
        e,
        a,
        "checklist.save",
        request.idempotencyKey,
        {
          projectId: request.projectId,
          visitId: request.visitId,
          expectedRevision: request.expectedRevision,
          answers,
        },
        request.visitId,
      );
      if (key.duplicate) return this.workspace(e, a, request);
      this.checkRevision(record, request.expectedRevision);
      const photos = await this.photos(e, a, request),
        ids = new Set(photos.map((p) => p.id));
      if (answers.some((answer) => answer.photoIds.some((id) => !ids.has(id))))
        fail("CPL_RECORD_NOT_FOUND");
      const version = await this.bump(e, a, request);
      await e.query(
        "UPDATE cpl_field_records SET answers=$4::jsonb WHERE organization_id=$1 AND project_id=$2 AND visit_id=$3",
        [a.organizationId, request.projectId, request.visitId, JSON.stringify(answers)],
      );
      await e.query(
        "INSERT INTO cpl_field_checklist_revisions(organization_id,project_id,visit_id,revision,answers,created_by_identity_id) VALUES($1,$2,$3,$4,$5::jsonb,$6)",
        [
          a.organizationId,
          request.projectId,
          request.visitId,
          version,
          JSON.stringify(answers),
          a.identityId,
        ],
      );
      await this.event(e, a, request, "field.checklist.saved", version);
      return this.workspace(e, a, request);
    });
  }
  async saveObservation(
    request: EditRequest & { observationId?: string; input: unknown },
  ): Promise<CplFieldWorkspace> {
    const input = normalizeCplFieldObservation(request.input),
      id = request.observationId ? cplExecutionId(request.observationId) : null;
    return this.run(request, true, async (e, a) => {
      await this.visit(e, a, request, true);
      const record = (await this.record(e, a, request))!;
      const key = await this.mutation(
        e,
        a,
        "observation.save",
        request.idempotencyKey,
        {
          projectId: request.projectId,
          visitId: request.visitId,
          expectedRevision: request.expectedRevision,
          id,
          input,
        },
        id ?? randomUUID(),
      );
      if (key.duplicate) return this.workspace(e, a, request);
      this.checkRevision(record, request.expectedRevision);
      const pinned = await this.templateFor(e, a, record);
      if (
        input.checklistItemId &&
        !pinned.sections.some((s) => s.items.some((i) => i.id === input.checklistItemId))
      )
        fail("CPL_FIELD_INVALID_INPUT");
      const prior = await e.query<Row>(
        "SELECT revision FROM cpl_field_observations WHERE organization_id=$1 AND project_id=$2 AND visit_id=$3 AND id=$4",
        [a.organizationId, request.projectId, request.visitId, key.resourceId],
      );
      if (id && !prior.rows[0]) fail("CPL_RECORD_NOT_FOUND");
      const count = await e.query<Row>(
        "SELECT count(*) AS total FROM cpl_field_observations WHERE organization_id=$1 AND project_id=$2 AND visit_id=$3",
        [a.organizationId, request.projectId, request.visitId],
      );
      if (!id && Number(count.rows[0]?.total) >= 200) fail("CPL_FIELD_OBSERVATION_LIMIT");
      const rev = Number(prior.rows[0]?.revision ?? 0) + 1;
      if (id)
        await e.query(
          "UPDATE cpl_field_observations SET revision=$5,snapshot=$6::jsonb WHERE organization_id=$1 AND project_id=$2 AND visit_id=$3 AND id=$4",
          [a.organizationId, request.projectId, request.visitId, id, rev, JSON.stringify(input)],
        );
      else
        await e.query(
          "INSERT INTO cpl_field_observations(organization_id,project_id,visit_id,id,revision,snapshot,created_by_identity_id) VALUES($1,$2,$3,$4,1,$5::jsonb,$6)",
          [
            a.organizationId,
            request.projectId,
            request.visitId,
            key.resourceId,
            JSON.stringify(input),
            a.identityId,
          ],
        );
      await e.query(
        "INSERT INTO cpl_field_observation_revisions(organization_id,project_id,visit_id,observation_id,revision,snapshot,created_by_identity_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)",
        [
          a.organizationId,
          request.projectId,
          request.visitId,
          key.resourceId,
          rev,
          JSON.stringify(input),
          a.identityId,
        ],
      );
      await this.event(
        e,
        a,
        request,
        "field.observation.saved",
        await this.bump(e, a, request),
        key.resourceId,
      );
      return this.workspace(e, a, request);
    });
  }
  private async photoRow(e: SqlExecutor, a: CplTenantAccess, request: PhotoRequest): Promise<Row> {
    const rows = await e.query<Row>(
      "SELECT * FROM cpl_field_photos WHERE organization_id=$1 AND project_id=$2 AND visit_id=$3 AND id=$4",
      [a.organizationId, request.projectId, request.visitId, cplExecutionId(request.photoId)],
    );
    return rows.rows[0] ?? fail("CPL_RECORD_NOT_FOUND");
  }
  private async transfer(
    e: SqlExecutor,
    a: CplTenantAccess,
    request: PhotoRequest,
  ): Promise<CplFieldPhotoTransfer> {
    const row = await this.photoRow(e, a, request),
      photo =
        (await this.photos(e, a, request)).find((p) => p.id === request.photoId) ??
        fail("CPL_RECORD_NOT_FOUND");
    return {
      photo,
      original: {
        organizationId: a.organizationId,
        objectId: String(row.original_object_id),
        sha256: photo.original.sha256,
        byteLength: photo.original.byteLength,
      },
      thumbnailObjectId: String(row.thumbnail_object_id),
      reportObjectId: String(row.report_object_id),
    };
  }
  async reservePhoto(
    request: VisitRequest & { idempotencyKey: string; input: unknown },
  ): Promise<CplFieldPhotoTransfer> {
    const input = normalizeCplFieldPhotoUpload(request.input);
    return this.run(request, true, async (e, a) => {
      await this.visit(e, a, request, true);
      await this.record(e, a, request);
      const key = await this.mutation(
        e,
        a,
        "photo.reserve",
        request.idempotencyKey,
        { projectId: request.projectId, visitId: request.visitId, input },
        randomUUID(),
      );
      if (key.duplicate) return this.transfer(e, a, { ...request, photoId: key.resourceId });
      const count = await e.query<Row>(
        "SELECT count(*) AS total FROM cpl_field_photos WHERE organization_id=$1 AND project_id=$2 AND visit_id=$3",
        [a.organizationId, request.projectId, request.visitId],
      );
      if (Number(count.rows[0]?.total) >= 100) fail("CPL_FIELD_PHOTO_LIMIT");
      await e.query(
        "INSERT INTO cpl_field_photos(organization_id,project_id,visit_id,id,revision,metadata_revision,state,upload,original_object_id,thumbnail_object_id,report_object_id,created_by_identity_id) VALUES($1,$2,$3,$4,1,1,'reserved',$5::jsonb,$6,$7,$8,$9)",
        [
          a.organizationId,
          request.projectId,
          request.visitId,
          key.resourceId,
          JSON.stringify(input),
          randomUUID(),
          randomUUID(),
          randomUUID(),
          a.identityId,
        ],
      );
      const metadata: CplFieldPhotoMetadata = {
        caption: "",
        observationId: null,
        order: Number(count.rows[0]?.total),
        overview: false,
        reportEligible: true,
        annotations: { coordinateSpace: "upright-normalized-v1", shapes: [] },
      };
      await e.query(
        "INSERT INTO cpl_field_photo_revisions(organization_id,project_id,visit_id,photo_id,revision,snapshot,created_by_identity_id) VALUES($1,$2,$3,$4,1,$5::jsonb,$6)",
        [
          a.organizationId,
          request.projectId,
          request.visitId,
          key.resourceId,
          JSON.stringify(metadata),
          a.identityId,
        ],
      );
      await this.event(
        e,
        a,
        request,
        "field.photo.reserved",
        await this.bump(e, a, request),
        key.resourceId,
      );
      return this.transfer(e, a, { ...request, photoId: key.resourceId });
    });
  }
  async getPhotoTransfer(request: PhotoRequest): Promise<CplFieldPhotoTransfer> {
    return this.run(request, false, async (e, a) => {
      await this.visit(e, a, request, true);
      return this.transfer(e, a, request);
    });
  }
  async savePhotoMetadata(
    request: EditRequest & { photoId: string; input: unknown },
  ): Promise<CplFieldWorkspace> {
    const input = normalizeCplFieldPhotoMetadata(request.input, validateCplPhotoAnnotations);
    return this.run(request, true, async (e, a) => {
      await this.visit(e, a, request, true);
      const record = (await this.record(e, a, request))!,
        photo = await this.photoRow(e, a, request);
      const key = await this.mutation(
        e,
        a,
        "photo.metadata",
        request.idempotencyKey,
        {
          projectId: request.projectId,
          visitId: request.visitId,
          photoId: request.photoId,
          expectedRevision: request.expectedRevision,
          input,
        },
        request.photoId,
      );
      if (key.duplicate) return this.workspace(e, a, request);
      this.checkRevision(record, request.expectedRevision);
      if (input.observationId) {
        const found = await e.query<Row>(
          "SELECT id FROM cpl_field_observations WHERE organization_id=$1 AND project_id=$2 AND visit_id=$3 AND id=$4",
          [a.organizationId, request.projectId, request.visitId, input.observationId],
        );
        if (!found.rows[0]) fail("CPL_RECORD_NOT_FOUND");
      }
      const metadataRevision = Number(photo.metadata_revision) + 1;
      await e.query(
        "INSERT INTO cpl_field_photo_revisions(organization_id,project_id,visit_id,photo_id,revision,observation_id,snapshot,created_by_identity_id) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)",
        [
          a.organizationId,
          request.projectId,
          request.visitId,
          request.photoId,
          metadataRevision,
          input.observationId,
          JSON.stringify(input),
          a.identityId,
        ],
      );
      await e.query(
        "UPDATE cpl_field_photos SET metadata_revision=$5,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND project_id=$2 AND visit_id=$3 AND id=$4",
        [a.organizationId, request.projectId, request.visitId, request.photoId, metadataRevision],
      );
      await this.event(
        e,
        a,
        request,
        "field.photo.metadata_saved",
        await this.bump(e, a, request),
        request.photoId,
      );
      return this.workspace(e, a, request);
    });
  }
  async recordPhotoOriginal(
    request: PhotoRequest & {
      expectedPhotoRevision: number;
      idempotencyKey: string;
      original: { width: number; height: number; exifOrientation: number | null };
      upright: { width: number; height: number };
    },
  ): Promise<CplFieldPhotoTransfer> {
    const original = {
      width: positive(request.original.width, 16384),
      height: positive(request.original.height, 16384),
      exifOrientation:
        request.original.exifOrientation === null
          ? null
          : positive(request.original.exifOrientation, 8),
    };
    const upright = {
      width: positive(request.upright.width, 16384),
      height: positive(request.upright.height, 16384),
    };
    if (
      original.width * original.height > 40000000 ||
      upright.width * upright.height !== original.width * original.height ||
      (original.exifOrientation !== null && original.exifOrientation >= 5
        ? upright.width !== original.height || upright.height !== original.width
        : upright.width !== original.width || upright.height !== original.height)
    )
      fail("CPL_FIELD_INVALID_INPUT");
    return this.run(request, true, async (e, a) => {
      await this.visit(e, a, request, true);
      const row = await this.photoRow(e, a, request);
      const key = await this.mutation(
        e,
        a,
        "photo.original",
        request.idempotencyKey,
        {
          photoId: request.photoId,
          expectedPhotoRevision: request.expectedPhotoRevision,
          original,
          upright,
        },
        request.photoId,
      );
      if (key.duplicate) return this.transfer(e, a, request);
      if (Number(row.revision) !== cplExecutionRevision(request.expectedPhotoRevision))
        fail("CPL_FIELD_VERSION_CONFLICT");
      if (row.original_metadata) {
        const prior = json<typeof original>(row.original_metadata),
          priorUpright = json<typeof upright>(row.upright);
        if (
          prior.width !== original.width ||
          prior.height !== original.height ||
          prior.exifOrientation !== original.exifOrientation ||
          priorUpright.width !== upright.width ||
          priorUpright.height !== upright.height
        )
          fail("CPL_FIELD_IMMUTABLE_EVIDENCE");
        return this.transfer(e, a, request);
      }
      if (!["reserved", "failed"].includes(String(row.state)))
        fail("CPL_FIELD_PHOTO_STATE_CONFLICT");
      await e.query(
        "UPDATE cpl_field_photos SET revision=revision+1,state='original_ready',original_metadata=$5::jsonb,upright=$6::jsonb,failure_code=NULL,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND project_id=$2 AND visit_id=$3 AND id=$4",
        [
          a.organizationId,
          request.projectId,
          request.visitId,
          request.photoId,
          JSON.stringify(original),
          JSON.stringify(upright),
        ],
      );
      await this.event(
        e,
        a,
        request,
        "field.photo.original_recorded",
        Number((await this.record(e, a, request))!.revision),
        request.photoId,
      );
      return this.transfer(e, a, request);
    });
  }
  async beginPhotoProcessing(
    request: PhotoRequest & { expectedPhotoRevision: number; idempotencyKey: string },
  ): Promise<CplFieldPhotoTransfer & { processingToken: string }> {
    return this.run(request, true, async (e, a) => {
      await this.visit(e, a, request, true);
      const row = await this.photoRow(e, a, request);
      const key = await this.mutation(
        e,
        a,
        "photo.processing",
        request.idempotencyKey,
        { photoId: request.photoId, expectedPhotoRevision: request.expectedPhotoRevision },
        randomUUID(),
      );
      if (key.duplicate) {
        if (
          row.processing_token !== key.resourceId ||
          new Date(String(row.processing_expires_at)).getTime() <= Date.now()
        )
          fail("CPL_FIELD_PHOTO_LEASE_EXPIRED");
        return { ...(await this.transfer(e, a, request)), processingToken: key.resourceId };
      }
      if (Number(row.revision) !== cplExecutionRevision(request.expectedPhotoRevision))
        fail("CPL_FIELD_VERSION_CONFLICT");
      if (!row.original_metadata || row.state === "ready") fail("CPL_FIELD_PHOTO_STATE_CONFLICT");
      if (
        row.state === "processing" &&
        new Date(String(row.processing_expires_at)).getTime() > Date.now()
      )
        fail("CPL_FIELD_PHOTO_BUSY");
      await e.query(
        "UPDATE cpl_field_photos SET revision=revision+1,state='processing',processing_token=$5,processing_expires_at=CURRENT_TIMESTAMP+interval '90 seconds',attempts=attempts+1,failure_code=NULL,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND project_id=$2 AND visit_id=$3 AND id=$4",
        [a.organizationId, request.projectId, request.visitId, request.photoId, key.resourceId],
      );
      await this.event(
        e,
        a,
        request,
        "field.photo.processing",
        Number((await this.record(e, a, request))!.revision),
        request.photoId,
      );
      return { ...(await this.transfer(e, a, request)), processingToken: key.resourceId };
    });
  }
  async completePhoto(
    request: PhotoRequest & {
      processingToken: string;
      idempotencyKey: string;
      thumbnail: CplFieldPhotoDerivative;
      report: CplFieldPhotoDerivative;
    },
  ): Promise<CplFieldPhotoTransfer> {
    const thumbnail = derivative(request.thumbnail, 480),
      report = derivative(request.report, 2400),
      processingToken = cplExecutionId(request.processingToken);
    return this.run(request, true, async (e, a) => {
      await this.visit(e, a, request, true);
      const row = await this.photoRow(e, a, request);
      const key = await this.mutation(
        e,
        a,
        "photo.complete",
        request.idempotencyKey,
        { photoId: request.photoId, processingToken, thumbnail, report },
        request.photoId,
      );
      if (key.duplicate) return this.transfer(e, a, request);
      if (
        row.state !== "processing" ||
        row.processing_token !== processingToken ||
        new Date(String(row.processing_expires_at)).getTime() <= Date.now()
      )
        fail("CPL_FIELD_PHOTO_LEASE_EXPIRED");
      const upright = json<{ width: number; height: number }>(row.upright);
      if (
        [thumbnail, report].some(
          (d) =>
            d.width > upright.width ||
            d.height > upright.height ||
            Math.abs(d.width / d.height - upright.width / upright.height) >
              2 / Math.min(d.width, d.height),
        )
      )
        fail("CPL_FIELD_INVALID_INPUT");
      await e.query(
        "UPDATE cpl_field_photos SET revision=revision+1,state='ready',thumbnail=$5::jsonb,report=$6::jsonb,processing_token=NULL,processing_expires_at=NULL,failure_code=NULL,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND project_id=$2 AND visit_id=$3 AND id=$4",
        [
          a.organizationId,
          request.projectId,
          request.visitId,
          request.photoId,
          JSON.stringify(thumbnail),
          JSON.stringify(report),
        ],
      );
      await this.event(
        e,
        a,
        request,
        "field.photo.ready",
        Number((await this.record(e, a, request))!.revision),
        request.photoId,
      );
      return this.transfer(e, a, request);
    });
  }
  async failPhoto(
    request: PhotoRequest & {
      processingToken?: string;
      expectedPhotoRevision: number;
      idempotencyKey: string;
      failureCode: NonNullable<CplFieldPhoto["failureCode"]>;
    },
  ): Promise<CplFieldPhotoTransfer> {
    if (
      ![
        "CPL_PHOTO_ORIGINAL_UNAVAILABLE",
        "CPL_PHOTO_PROCESSING_FAILED",
        "CPL_PHOTO_STORAGE_UNAVAILABLE",
      ].includes(request.failureCode)
    )
      fail("CPL_FIELD_INVALID_INPUT");
    return this.run(request, true, async (e, a) => {
      await this.visit(e, a, request, true);
      const row = await this.photoRow(e, a, request);
      const key = await this.mutation(
        e,
        a,
        "photo.failed",
        request.idempotencyKey,
        {
          photoId: request.photoId,
          expectedPhotoRevision: request.expectedPhotoRevision,
          processingToken: request.processingToken ?? null,
          failureCode: request.failureCode,
        },
        request.photoId,
      );
      if (key.duplicate) return this.transfer(e, a, request);
      if (Number(row.revision) !== cplExecutionRevision(request.expectedPhotoRevision))
        fail("CPL_FIELD_VERSION_CONFLICT");
      if (
        row.state === "ready" ||
        (row.state === "processing" && row.processing_token !== request.processingToken)
      )
        fail("CPL_FIELD_PHOTO_STATE_CONFLICT");
      await e.query(
        "UPDATE cpl_field_photos SET revision=revision+1,state='failed',processing_token=NULL,processing_expires_at=NULL,failure_code=$5,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND project_id=$2 AND visit_id=$3 AND id=$4",
        [
          a.organizationId,
          request.projectId,
          request.visitId,
          request.photoId,
          request.failureCode,
        ],
      );
      await this.event(
        e,
        a,
        request,
        "field.photo.failed",
        Number((await this.record(e, a, request))!.revision),
        request.photoId,
      );
      return this.transfer(e, a, request);
    });
  }
  async getPhotoContent(
    request: PhotoRequest & { kind: "original" | "thumbnail" | "report" },
  ): Promise<CplFieldEvidenceReference> {
    if (!["original", "thumbnail", "report"].includes(request.kind))
      fail("CPL_FIELD_INVALID_INPUT");
    return this.run(request, false, async (e, a) => {
      await this.visit(e, a, request);
      const row = await this.photoRow(e, a, request);
      if (request.kind === "original") {
        if (!row.original_metadata) fail("CPL_FIELD_PHOTO_NOT_READY");
        const upload = json<CplFieldPhotoUploadInput>(row.upload);
        return {
          organizationId: a.organizationId,
          objectId: String(row.original_object_id),
          sha256: upload.sha256,
          byteLength: upload.byteLength,
        };
      }
      if (row.state !== "ready") fail("CPL_FIELD_PHOTO_NOT_READY");
      const meta = json<CplFieldPhotoDerivative>(row[request.kind]);
      return {
        organizationId: a.organizationId,
        objectId: String(row[`${request.kind}_object_id`]),
        sha256: meta.sha256,
        byteLength: meta.byteLength,
      };
    });
  }
  async reopenVisit(
    request: VisitRequest & {
      expectedFieldRevision: number;
      expectedVisitRevision: number;
      reason: string;
      idempotencyKey: string;
    },
  ): Promise<CplFieldWorkspace> {
    const reason = cplFieldText(request.reason, 4000, true);
    return this.run(request, true, async (e, a) => {
      const v = await this.visit(e, a, request),
        record = (await this.record(e, a, request))!;
      if (!cplTenantRoleAllows(a.role, "execution:plan")) fail("CPL_ACCESS_DENIED");
      const key = await this.mutation(
        e,
        a,
        "visit.reopen",
        request.idempotencyKey,
        {
          projectId: request.projectId,
          visitId: request.visitId,
          expectedFieldRevision: request.expectedFieldRevision,
          expectedVisitRevision: request.expectedVisitRevision,
          reason,
        },
        request.visitId,
      );
      if (key.duplicate) return this.workspace(e, a, request);
      this.checkRevision(record, request.expectedFieldRevision);
      if (v.revision !== cplExecutionRevision(request.expectedVisitRevision))
        fail("CPL_EXECUTION_VERSION_CONFLICT");
      if (v.status !== "completed") fail("CPL_FIELD_VISIT_LOCKED");
      const operations = await e.query<Row>(
        "SELECT status FROM cpl_project_operations WHERE organization_id=$1 AND project_id=$2",
        [a.organizationId, request.projectId],
      );
      if (operations.rows[0] && operations.rows[0].status !== "active")
        fail("CPL_EXECUTION_STATE_CONFLICT");
      const active = await e.query<Row>(
        "SELECT m.identity_id FROM cpl_memberships m JOIN cpl_identities i ON i.id=m.identity_id WHERE m.organization_id=$1 AND m.identity_id=$2 AND m.status='active' AND i.status='active' FOR SHARE OF m,i",
        [a.organizationId, v.responsibleIdentityId],
      );
      if (!active.rows[0]) fail("CPL_EXECUTION_MEMBER_UNAVAILABLE");
      const conflicts = await e.query<Row>(
        "SELECT id FROM cpl_project_visits WHERE organization_id=$1 AND id<>$2 AND responsible_identity_id=$3 AND status IN ('scheduled','in_progress') AND planned_start_at<$5 AND planned_end_at>$4 LIMIT 1",
        [a.organizationId, v.id, v.responsibleIdentityId, v.plannedStartAt, v.plannedEndAt],
      );
      if (conflicts.rows[0]) fail("CPL_EXECUTION_SCHEDULE_CONFLICT");
      const before = json<CplVisitInput>(
        (
          await e.query<Row>(
            "SELECT snapshot FROM cpl_project_visits WHERE organization_id=$1 AND id=$2",
            [a.organizationId, v.id],
          )
        ).rows[0]!.snapshot,
      );
      const after = { ...before, status: "in_progress", actualEndAt: null, completionNote: "" };
      await e.query(
        "UPDATE cpl_project_visits SET revision=revision+1,status='in_progress',snapshot=$3::jsonb,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND id=$2",
        [a.organizationId, v.id, JSON.stringify(after)],
      );
      await e.query(
        "INSERT INTO cpl_execution_events(id,organization_id,project_id,visit_id,action,revision,before_snapshot,after_snapshot,actor_identity_id) VALUES($1,$2,$3,$4,'visit.reopened',$5,$6::jsonb,$7::jsonb,$8)",
        [
          randomUUID(),
          a.organizationId,
          request.projectId,
          v.id,
          v.revision + 1,
          JSON.stringify(before),
          JSON.stringify(after),
          a.identityId,
        ],
      );
      await this.event(
        e,
        a,
        request,
        "field.visit.reopened",
        await this.bump(e, a, request),
        v.id,
        reason,
      );
      return this.workspace(e, a, request);
    });
  }
}
