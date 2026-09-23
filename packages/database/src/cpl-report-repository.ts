import { createHash, randomUUID } from "node:crypto";
import { emitCplBusinessEvent } from "./cpl-business-events.js";
import { cplExecutionId, cplExecutionRevision } from "@bea/domain/cpl-execution";
import {
  cplFieldText,
  type CplFieldObservationInput,
  type CplFieldPhotoMetadata,
  type CplFieldPhotoDerivative,
} from "@bea/domain/cpl-field";
import {
  normalizeCplReportBranding,
  normalizeCplReportContent,
  normalizeCplReportTemplate,
  type CplReportBranding,
  type CplReportTemplateVersion,
  type CplReportTemplateInput,
  type CplReportContent,
  type CplReportSources,
  type CplReportVersion,
  type CplReportSummary,
  type CplReportDetail,
  type CplReportWorkspace,
  type CplReportSourceOption,
  type CplReportArtifact,
  type CplReportPublicProjection,
  type CplReportApprovalPreparation,
  type CplReportSourcePhoto,
  type CplReportPhotoSelection,
  type CplReportEvent,
} from "@bea/domain/cpl-report";
import type { CplCommercialProjectSnapshot } from "@bea/domain/cpl-commercial";
import type { SqlExecutor } from "./adapter.js";
import { readCplFieldReadiness } from "./cpl-field-readiness.js";
import {
  CplTenantAccessError,
  cplTenantRoleAllows,
  type CplTenantAccess,
  type CplTenantRequest,
  type SqlCplTenantRepository,
} from "./tenant-repository.js";

type Row = Record<string, unknown>;
type ProjectRequest = CplTenantRequest & { projectId: string };
type ReportRequest = ProjectRequest & { reportId: string };
type EditRequest = ReportRequest & { expectedRevision: number; idempotencyKey: string };
function fail(code: string): never {
  throw new CplTenantAccessError(code);
}
function json<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}
function iso(value: unknown): string {
  // pg returns Date objects; converting one through Date.toString() discards
  // milliseconds and would change the exact prepared approval projection.
  return new Date(value instanceof Date ? value.getTime() : String(value)).toISOString();
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
function sourceHash(sources: CplReportSources, branding: CplReportBranding): string {
  return hash(canonical({ sources, branding }));
}
function summary(row: Row): CplReportSummary {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    projectId: String(row.project_id),
    reference: String(row.reference),
    revision: Number(row.revision),
    currentVersion: Number(row.current_version),
    state: row.state as CplReportSummary["state"],
    title: String(row.title),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
function template(row: Row): CplReportTemplateVersion {
  return {
    ...json<CplReportTemplateInput>(row.snapshot),
    id: String(row.id),
    organizationId: String(row.organization_id),
    version: Number(row.version),
    createdByIdentityId: String(row.created_by_identity_id),
    createdAt: iso(row.created_at),
  };
}
function artifact(row: Row): CplReportArtifact {
  return {
    reportId: String(row.report_id),
    version: Number(row.version),
    reference: {
      organizationId: String(row.organization_id),
      objectId: String(row.object_id),
      sha256: String(row.sha256),
      byteLength: Number(row.byte_length),
    },
    rendererVersion: String(row.renderer_version),
    approvedAt: iso(row.approved_at),
    approvedByIdentityId: String(row.approved_by_identity_id),
    sourceHash: String(row.source_hash),
  };
}
function version(row: Row): CplReportVersion {
  return {
    ...json<Omit<CplReportVersion, "version" | "createdAt" | "createdByIdentityId">>(row.snapshot),
    version: Number(row.version),
    sourceHash: String(row.source_hash),
    createdAt: iso(row.created_at),
    createdByIdentityId: String(row.created_by_identity_id),
  };
}
function permissions(a: CplTenantAccess): CplReportDetail["permissions"] {
  return {
    canWrite: cplTenantRoleAllows(a.role, "reports:write"),
    canReview: cplTenantRoleAllows(a.role, "reports:review"),
    canConfigure: cplTenantRoleAllows(a.role, "reports:configure"),
  };
}
function requirePermission(a: CplTenantAccess, permission: keyof CplReportDetail["permissions"]) {
  if (!permissions(a)[permission]) fail("CPL_ACCESS_DENIED");
}
function projection(
  report: CplReportSummary,
  v: CplReportVersion,
  approvedAt: string,
): CplReportPublicProjection {
  const c = v.content,
    included = new Set(c.sectionOrder);
  const photos = (p: CplReportSourcePhoto[]) =>
    p.map((photo) => ({
      photoId: photo.id,
      caption: photo.caption,
      layout: photo.layout,
      sha256: photo.report.sha256,
      width: photo.report.width,
      height: photo.report.height,
      annotations: photo.annotations,
    }));
  return {
    reference: report.reference,
    version: v.version,
    approvedAt,
    title: c.title,
    scope: included.has("scope") ? c.scope : "",
    summary: included.has("summary") ? c.summary : "",
    limitations: included.has("limitations") ? c.limitations : "",
    conclusion: included.has("conclusion") ? c.conclusion : "",
    sections: included.has("sections") ? c.sections : [],
    sectionOrder: c.sectionOrder,
    company: {
      businessName: v.branding.businessName,
      email: v.branding.email,
      phone: v.branding.phone,
      address: v.branding.address,
      accentColor: v.branding.accentColor,
      logoDataUrl: v.branding.logoDataUrl,
      brandingVersion: v.branding.revision,
    },
    project: v.sources.project,
    visits: included.has("visits")
      ? v.sources.visits.map((visit) => {
          const chosen = c.visits.find((x) => x.visitId === visit.id)!;
          return {
            visitId: visit.id,
            title: visit.title,
            date: visit.date,
            timeZone: visit.timeZone,
            personnel: visit.personnel,
            observations: [
              ...(visit.overviewPhotos.length
                ? [
                    {
                      title: "Visit overview",
                      category: "",
                      priority: "",
                      location: "",
                      description: "",
                      followUp: "",
                      revision: visit.fieldRevision,
                      photos: photos(visit.overviewPhotos),
                    },
                  ]
                : []),
              ...visit.observations.map((o) => {
                const edits = chosen.observations.find((x) => x.observationId === o.id)!;
                return {
                  title: edits.titleOverride ?? o.title,
                  category: o.category,
                  priority: o.priority,
                  location: o.location,
                  description: edits.descriptionOverride ?? o.description,
                  followUp: edits.followUpOverride ?? o.followUp,
                  revision: o.revision,
                  photos: photos(o.photos),
                };
              }),
            ],
          };
        })
      : [],
  };
}

/** Approval is a prepare/render/commit protocol. File writes happen outside the
 * transaction; only a fresh authenticated commit makes their immutable reference
 * downloadable as an approved artifact. */
export class SqlCplReportRepository {
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
        if (a.role === "field-user") fail("CPL_ACCESS_DENIED");
        const protection = await e.query<Row>(
          "SELECT count(*)=8 AND bool_and(relrowsecurity AND relforcerowsecurity) AS protected FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN ('cpl_report_branding','cpl_report_templates','cpl_reports','cpl_report_versions','cpl_report_events','cpl_report_attempts','cpl_report_artifacts','cpl_report_mutations')",
        );
        if (protection.rows[0]?.protected !== true) fail("CPL_REPORT_SCHEMA_UNSAFE");
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
  private async parent(e: SqlExecutor, a: CplTenantAccess, projectId: string): Promise<Row> {
    const rows = await e.query<Row>(
      "SELECT * FROM cpl_commercial_projects WHERE organization_id=$1 AND id=$2",
      [a.organizationId, cplExecutionId(projectId)],
    );
    return rows.rows[0] ?? fail("CPL_RECORD_NOT_FOUND");
  }
  private async row(
    e: SqlExecutor,
    a: CplTenantAccess,
    request: Pick<ReportRequest, "projectId" | "reportId">,
  ): Promise<Row> {
    const rows = await e.query<Row>(
      "SELECT * FROM cpl_reports WHERE organization_id=$1 AND project_id=$2 AND id=$3",
      [a.organizationId, cplExecutionId(request.projectId), cplExecutionId(request.reportId)],
    );
    return rows.rows[0] ?? fail("CPL_RECORD_NOT_FOUND");
  }
  private async saved(
    e: SqlExecutor,
    a: CplTenantAccess,
    request: Pick<ReportRequest, "projectId" | "reportId">,
    number: number,
  ): Promise<CplReportVersion> {
    const rows = await e.query<Row>(
      "SELECT * FROM cpl_report_versions WHERE organization_id=$1 AND project_id=$2 AND report_id=$3 AND version=$4",
      [a.organizationId, request.projectId, request.reportId, cplExecutionRevision(number)],
    );
    return version(rows.rows[0] ?? fail("CPL_RECORD_NOT_FOUND"));
  }
  private async branding(e: SqlExecutor, a: CplTenantAccess): Promise<CplReportBranding | null> {
    const rows = await e.query<Row>(
      "SELECT * FROM cpl_report_branding WHERE organization_id=$1 ORDER BY revision DESC LIMIT 1",
      [a.organizationId],
    );
    return rows.rows[0]
      ? {
          ...json<Omit<CplReportBranding, "revision">>(rows.rows[0].configuration),
          revision: Number(rows.rows[0].revision),
        }
      : null;
  }
  private async templates(e: SqlExecutor, a: CplTenantAccess): Promise<CplReportTemplateVersion[]> {
    const rows = await e.query<Row>(
      "SELECT * FROM cpl_report_templates WHERE organization_id=$1 ORDER BY created_at DESC,id,version DESC LIMIT 201",
      [a.organizationId],
    );
    if (rows.rows.length > 200) fail("CPL_REPORT_TEMPLATE_LIMIT");
    return rows.rows.map(template);
  }
  private async mutation(
    e: SqlExecutor,
    a: CplTenantAccess,
    kind: string,
    key: string,
    input: unknown,
    resourceId: string,
  ) {
    if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{8,120}$/u.test(key))
      fail("CPL_INVALID_IDEMPOTENCY_KEY");
    const digest = hash(canonical(input)),
      prior = await e.query<Row>(
        "SELECT * FROM cpl_report_mutations WHERE organization_id=$1 AND mutation_kind=$2 AND idempotency_key=$3",
        [a.organizationId, kind, key],
      );
    if (prior.rows[0]) {
      if (prior.rows[0].request_hash !== digest) fail("CPL_IDEMPOTENCY_CONFLICT");
      return { duplicate: true, resourceId: String(prior.rows[0].resource_id) };
    }
    await e.query(
      "INSERT INTO cpl_report_mutations(organization_id,mutation_kind,idempotency_key,request_hash,resource_id) VALUES($1,$2,$3,$4,$5)",
      [a.organizationId, kind, key, digest, resourceId],
    );
    return { duplicate: false, resourceId };
  }
  private async audit(e: SqlExecutor, a: CplTenantAccess, action: string, id: string) {
    await e.query(
      "INSERT INTO cpl_tenant_audit_events(id,organization_id,actor_identity_id,action,resource_id) VALUES($1,$2,$3,$4,$5)",
      [randomUUID(), a.organizationId, a.identityId, action, id],
    );
  }
  private async event(
    e: SqlExecutor,
    a: CplTenantAccess,
    r: CplReportSummary,
    action: string,
    note = "",
  ) {
    await e.query(
      "INSERT INTO cpl_report_events(id,organization_id,project_id,report_id,action,revision,version,note,actor_identity_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        randomUUID(),
        a.organizationId,
        r.projectId,
        r.id,
        action,
        r.revision,
        r.currentVersion,
        note,
        a.identityId,
      ],
    );
    await this.audit(e, a, action, r.id);
  }
  private checkRevision(row: Row, expected: number) {
    if (Number(row.revision) !== cplExecutionRevision(expected))
      fail("CPL_REPORT_VERSION_CONFLICT");
  }
  async saveBranding(
    request: CplTenantRequest & {
      expectedRevision: number;
      idempotencyKey: string;
      input: unknown;
    },
  ): Promise<CplReportBranding> {
    const input = normalizeCplReportBranding(request.input),
      expected = cplExecutionRevision(request.expectedRevision);
    return this.run(request, true, async (e, a) => {
      requirePermission(a, "canConfigure");
      const key = await this.mutation(
        e,
        a,
        "branding.save",
        request.idempotencyKey,
        { expected, input },
        a.organizationId,
      );
      if (key.duplicate) {
        const rows = await e.query<Row>(
          "SELECT configuration FROM cpl_report_branding WHERE organization_id=$1 AND revision=$2",
          [a.organizationId, expected + 1],
        );
        return {
          ...json<Omit<CplReportBranding, "revision">>(rows.rows[0]!.configuration),
          revision: expected + 1,
        };
      }
      const prior = await this.branding(e, a);
      if ((prior?.revision ?? 0) !== expected) fail("CPL_REPORT_VERSION_CONFLICT");
      await e.query(
        "INSERT INTO cpl_report_branding(organization_id,revision,configuration,created_by_identity_id) VALUES($1,$2,$3::jsonb,$4)",
        [a.organizationId, expected + 1, JSON.stringify(input), a.identityId],
      );
      await this.audit(e, a, "report.branding.saved", a.organizationId);
      return { ...input, revision: expected + 1 };
    });
  }
  async saveTemplate(
    request: CplTenantRequest & {
      templateId?: string;
      expectedVersion: number;
      idempotencyKey: string;
      input: unknown;
    },
  ): Promise<CplReportTemplateVersion> {
    const input = normalizeCplReportTemplate(request.input),
      expected = cplExecutionRevision(request.expectedVersion),
      id = request.templateId ? cplExecutionId(request.templateId) : null;
    return this.run(request, true, async (e, a) => {
      requirePermission(a, "canConfigure");
      const key = await this.mutation(
        e,
        a,
        "template.save",
        request.idempotencyKey,
        { id, expected, input },
        id ?? randomUUID(),
      );
      if (key.duplicate) {
        const saved = await e.query<Row>(
          "SELECT * FROM cpl_report_templates WHERE organization_id=$1 AND id=$2 AND version=$3",
          [a.organizationId, key.resourceId, expected + 1],
        );
        return template(saved.rows[0] ?? fail("CPL_RECORD_NOT_FOUND"));
      }
      const prior = await e.query<Row>(
        "SELECT version FROM cpl_report_templates WHERE organization_id=$1 AND id=$2 ORDER BY version DESC LIMIT 1",
        [a.organizationId, key.resourceId],
      );
      if (Number(prior.rows[0]?.version ?? 0) !== expected || (id && !prior.rows[0]))
        fail("CPL_REPORT_VERSION_CONFLICT");
      if ((await this.templates(e, a)).length >= 200) fail("CPL_REPORT_TEMPLATE_LIMIT");
      const rows = await e.query<Row>(
        "INSERT INTO cpl_report_templates(organization_id,id,version,snapshot,created_by_identity_id) VALUES($1,$2,$3,$4::jsonb,$5) RETURNING *",
        [a.organizationId, key.resourceId, expected + 1, JSON.stringify(input), a.identityId],
      );
      await this.audit(e, a, "report.template.saved", key.resourceId);
      return template(rows.rows[0]!);
    });
  }
  private async sourceOptions(
    e: SqlExecutor,
    a: CplTenantAccess,
    projectId: string,
  ): Promise<CplReportSourceOption[]> {
    const visits = await e.query<Row>(
      "SELECT v.id,v.revision,v.status,v.snapshot,r.revision AS field_revision FROM cpl_project_visits v JOIN cpl_field_records r ON (r.organization_id,r.project_id,r.visit_id)=(v.organization_id,v.project_id,v.id) WHERE v.organization_id=$1 AND v.project_id=$2 ORDER BY v.planned_start_at,v.id",
      [a.organizationId, projectId],
    );
    const result: CplReportSourceOption[] = [];
    for (const v of visits.rows) {
      const observations = await e.query<Row>(
        "SELECT id,revision,snapshot FROM cpl_field_observations WHERE organization_id=$1 AND project_id=$2 AND visit_id=$3 ORDER BY created_at,id",
        [a.organizationId, projectId, v.id],
      );
      const photos = await e.query<Row>(
        "SELECT p.id,p.state,p.metadata_revision,r.snapshot FROM cpl_field_photos p JOIN cpl_field_photo_revisions r ON (r.organization_id,r.photo_id,r.revision)=(p.organization_id,p.id,p.metadata_revision) WHERE p.organization_id=$1 AND p.project_id=$2 AND p.visit_id=$3 ORDER BY p.created_at,p.id",
        [a.organizationId, projectId, v.id],
      );
      result.push({
        visitId: String(v.id),
        title: json<{ purpose: string }>(v.snapshot).purpose,
        status: String(v.status),
        revision: Number(v.revision),
        fieldRevision: Number(v.field_revision),
        observations: observations.rows.map((o) => {
          const x = json<CplFieldObservationInput>(o.snapshot);
          return {
            id: String(o.id),
            revision: Number(o.revision),
            title: x.title,
            description: x.description,
            followUp: x.followUp,
            reportEligible: x.reportEligible,
          };
        }),
        photos: photos.rows.map((p) => {
          const m = json<CplFieldPhotoMetadata>(p.snapshot);
          return {
            id: String(p.id),
            caption: m.caption,
            observationId: m.observationId,
            overview: m.overview,
            reportEligible: m.reportEligible,
            state: String(p.state),
            metadataRevision: Number(p.metadata_revision),
          };
        }),
      });
    }
    return result;
  }
  private async capture(
    e: SqlExecutor,
    a: CplTenantAccess,
    projectId: string,
    content: CplReportContent,
  ): Promise<CplReportSources> {
    const project = await this.parent(e, a, projectId),
      original = json<CplCommercialProjectSnapshot>(project.snapshot);
    const fields = original.version.sourceLead.fields;
    const sources: CplReportSources = {
      project: {
        reference: String(project.reference),
        name: original.version.content.title,
        customerName: fields.customerName,
        siteName: fields.siteName,
        siteAddress: fields.siteAddress,
      },
      visits: [],
    };
    // Omitted visit sections are omitted from both the customer projection and
    // the frozen source list, so hidden selections cannot embed unused images.
    if (!content.sectionOrder.includes("visits")) return sources;
    for (const selected of content.visits) {
      const rows = await e.query<Row>(
        "SELECT v.*,r.revision AS field_revision,r.template_id,r.template_version FROM cpl_project_visits v JOIN cpl_field_records r ON (r.organization_id,r.project_id,r.visit_id)=(v.organization_id,v.project_id,v.id) WHERE v.organization_id=$1 AND v.project_id=$2 AND v.id=$3",
        [a.organizationId, projectId, selected.visitId],
      );
      const row = rows.rows[0] ?? fail("CPL_REPORT_SOURCE_UNAVAILABLE"),
        v = json<{ purpose: string; timeZone: string; plannedStartLocal: string | null }>(
          row.snapshot,
        );
      const observations = await e.query<Row>(
        "SELECT id,revision,snapshot FROM cpl_field_observations WHERE organization_id=$1 AND project_id=$2 AND visit_id=$3",
        [a.organizationId, projectId, selected.visitId],
      );
      const photoRows = await e.query<Row>(
        "SELECT p.*,r.snapshot AS metadata FROM cpl_field_photos p JOIN cpl_field_photo_revisions r ON (r.organization_id,r.photo_id,r.revision)=(p.organization_id,p.id,p.metadata_revision) WHERE p.organization_id=$1 AND p.project_id=$2 AND p.visit_id=$3",
        [a.organizationId, projectId, selected.visitId],
      );
      const byObservation = new Map(observations.rows.map((o) => [String(o.id), o])),
        byPhoto = new Map(photoRows.rows.map((p) => [String(p.id), p]));
      const photo = (
        chosen: CplReportPhotoSelection,
        observationId: string | null,
      ): CplReportSourcePhoto => {
        const p = byPhoto.get(chosen.photoId) ?? fail("CPL_REPORT_SOURCE_UNAVAILABLE"),
          m = json<CplFieldPhotoMetadata>(p.metadata);
        if (
          p.state !== "ready" ||
          !m.reportEligible ||
          (observationId ? m.observationId !== observationId : !m.overview)
        )
          fail("CPL_REPORT_SOURCE_NOT_ELIGIBLE");
        if (
          m.observationId &&
          !json<CplFieldObservationInput>(
            byObservation.get(m.observationId)?.snapshot ?? fail("CPL_REPORT_SOURCE_UNAVAILABLE"),
          ).reportEligible
        )
          fail("CPL_REPORT_SOURCE_NOT_ELIGIBLE");
        const derivative = json<CplFieldPhotoDerivative>(p.report),
          upload = json<{ sha256: string }>(p.upload);
        return {
          id: chosen.photoId,
          metadataRevision: Number(p.metadata_revision),
          originalSha256: upload.sha256,
          caption: m.caption,
          annotations: m.annotations,
          layout: chosen.layout,
          report: {
            organizationId: a.organizationId,
            objectId: String(p.report_object_id),
            sha256: derivative.sha256,
            byteLength: derivative.byteLength,
            width: derivative.width,
            height: derivative.height,
            pipelineVersion: derivative.pipelineVersion,
          },
        };
      };
      const assignee = await e.query<Row>(
        "SELECT i.display_name FROM cpl_memberships m JOIN cpl_identities i ON i.id=m.identity_id WHERE m.organization_id=$1 AND m.identity_id=$2",
        [a.organizationId, row.responsible_identity_id],
      );
      const readiness = await readCplFieldReadiness(
        e,
        a.organizationId,
        projectId,
        selected.visitId,
      );
      sources.visits.push({
        id: selected.visitId,
        revision: Number(row.revision),
        fieldRevision: Number(row.field_revision),
        templateId: String(row.template_id),
        templateVersion: Number(row.template_version),
        status: String(row.status),
        readiness: readiness.readiness.map((x) => x.code),
        title: v.purpose,
        date: v.plannedStartLocal?.slice(0, 10) ?? null,
        timeZone: v.timeZone,
        personnel: assignee.rows.map((i) => String(i.display_name)),
        observations: selected.observations.map((chosen) => {
          const o =
              byObservation.get(chosen.observationId) ?? fail("CPL_REPORT_SOURCE_UNAVAILABLE"),
            data = json<CplFieldObservationInput>(o.snapshot);
          if (!data.reportEligible) fail("CPL_REPORT_SOURCE_NOT_ELIGIBLE");
          return {
            id: chosen.observationId,
            revision: Number(o.revision),
            title: data.title,
            category: data.category,
            priority: data.priority,
            location: data.location,
            description: data.description,
            followUp: data.followUp,
            photos: chosen.photos.map((p) => photo(p, chosen.observationId)),
          };
        }),
        overviewPhotos: selected.overviewPhotos.map((p) => photo(p, null)),
      });
    }
    return sources;
  }
  private readiness(v: CplReportVersion): CplReportDetail["readiness"] {
    const issues: CplReportDetail["readiness"] = [];
    if (!v.content.sectionOrder.includes("visits") || !v.sources.visits.length)
      issues.push({
        code: "CPL_REPORT_VISIT_REQUIRED",
        message: "Select at least one visit and include the visits section.",
      });
    for (const visit of v.sources.visits) {
      if (visit.status !== "completed" || visit.readiness.length)
        issues.push({
          code: "CPL_REPORT_VISIT_NOT_READY",
          message: `${visit.title}: complete the visit and required field evidence first.`,
        });
      if (!visit.observations.length && !visit.overviewPhotos.length)
        issues.push({
          code: "CPL_REPORT_EVIDENCE_REQUIRED",
          message: `${visit.title}: select a report-eligible observation or overview photo.`,
        });
    }
    return issues;
  }
  private async fresh(
    e: SqlExecutor,
    a: CplTenantAccess,
    projectId: string,
    v: CplReportVersion,
  ): Promise<void> {
    const currentBranding = await this.branding(e, a);
    if (!currentBranding) fail("CPL_REPORT_BRANDING_REQUIRED");
    const sources = await this.capture(e, a, projectId, v.content);
    if (sourceHash(sources, currentBranding) !== v.sourceHash) fail("CPL_REPORT_SOURCES_CHANGED");
  }
  private async append(
    e: SqlExecutor,
    a: CplTenantAccess,
    request: Pick<ReportRequest, "projectId" | "reportId">,
    number: number,
    content: CplReportContent,
    selectedTemplate: CplReportTemplateVersion,
    branding: CplReportBranding,
  ): Promise<CplReportVersion> {
    if (number > 200) fail("CPL_REPORT_VERSION_LIMIT");
    const sources = await this.capture(e, a, request.projectId, content),
      proof = sourceHash(sources, branding);
    const rows = await e.query<Row>(
      "INSERT INTO cpl_report_versions(organization_id,project_id,report_id,version,snapshot,source_hash,template_id,template_version,branding_revision,created_by_identity_id) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10) RETURNING *",
      [
        a.organizationId,
        request.projectId,
        request.reportId,
        number,
        JSON.stringify({
          content,
          template: selectedTemplate,
          branding,
          sources,
          sourceHash: proof,
        }),
        proof,
        selectedTemplate.id,
        selectedTemplate.version,
        branding.revision,
        a.identityId,
      ],
    );
    return version(rows.rows[0]!);
  }
  private async detail(
    e: SqlExecutor,
    a: CplTenantAccess,
    request: Pick<ReportRequest, "projectId" | "reportId">,
  ): Promise<CplReportDetail> {
    const row = await this.row(e, a, request),
      r = summary(row);
    const versions = (
      await e.query<Row>(
        "SELECT * FROM cpl_report_versions WHERE organization_id=$1 AND project_id=$2 AND report_id=$3 ORDER BY version DESC",
        [a.organizationId, request.projectId, request.reportId],
      )
    ).rows.map(version);
    const artifacts = (
      await e.query<Row>(
        "SELECT * FROM cpl_report_artifacts WHERE organization_id=$1 AND project_id=$2 AND report_id=$3 ORDER BY version DESC",
        [a.organizationId, request.projectId, request.reportId],
      )
    ).rows.map(artifact);
    const events = (
      await e.query<Row>(
        "SELECT * FROM cpl_report_events WHERE organization_id=$1 AND project_id=$2 AND report_id=$3 ORDER BY created_at DESC,id DESC LIMIT 500",
        [a.organizationId, request.projectId, request.reportId],
      )
    ).rows.map((x): CplReportEvent => ({
      id: String(x.id),
      action: String(x.action),
      revision: Number(x.revision),
      version: Number(x.version),
      actorIdentityId: String(x.actor_identity_id),
      note: String(x.note),
      createdAt: iso(x.created_at),
    }));
    const current =
      versions.find((v) => v.version === r.currentVersion) ?? fail("CPL_REPORT_SCHEMA_UNSAFE");
    let sourcesStale = false;
    try {
      await this.fresh(e, a, request.projectId, current);
    } catch (error) {
      if (
        error instanceof CplTenantAccessError &&
        [
          "CPL_REPORT_SOURCES_CHANGED",
          "CPL_REPORT_SOURCE_UNAVAILABLE",
          "CPL_REPORT_SOURCE_NOT_ELIGIBLE",
          "CPL_REPORT_BRANDING_REQUIRED",
        ].includes(error.code)
      )
        sourcesStale = true;
      else throw error;
    }
    return {
      ...r,
      versions,
      artifacts,
      events,
      sourcesStale,
      readiness: [
        ...this.readiness(current),
        ...(sourcesStale
          ? [
              {
                code: "CPL_REPORT_SOURCES_CHANGED",
                message:
                  "Sources or branding changed. Explicitly refresh and review a new saved version.",
              },
            ]
          : []),
      ],
      permissions: permissions(a),
    };
  }
  async getProjectWorkspace(request: ProjectRequest): Promise<CplReportWorkspace> {
    return this.run(request, false, async (e, a) => {
      await this.parent(e, a, request.projectId);
      const reports = await e.query<Row>(
        "SELECT * FROM cpl_reports WHERE organization_id=$1 AND project_id=$2 ORDER BY created_at DESC,id LIMIT 101",
        [a.organizationId, request.projectId],
      );
      if (reports.rows.length > 100) fail("CPL_REPORT_LIMIT");
      return {
        projectId: request.projectId,
        reports: reports.rows.map(summary),
        templates: await this.templates(e, a),
        branding: await this.branding(e, a),
        sources: await this.sourceOptions(e, a, request.projectId),
        permissions: permissions(a),
      };
    });
  }
  async getReport(request: ReportRequest): Promise<CplReportDetail> {
    return this.run(request, false, (e, a) => this.detail(e, a, request));
  }
  async createReport(
    request: ProjectRequest & {
      templateId: string;
      templateVersion: number;
      idempotencyKey: string;
    },
  ): Promise<CplReportDetail> {
    return this.run(request, true, (e, a) => this.createReportInTransaction(e, a, request));
  }
  /** Shared draft assembly only; this never submits or approves a report. */
  async createReportInTransaction(
    e: SqlExecutor,
    a: CplTenantAccess,
    request: {
      projectId: string;
      templateId: string;
      templateVersion: number;
      idempotencyKey: string;
      initialContent?: unknown;
    },
  ): Promise<CplReportDetail> {
    const templateId = cplExecutionId(request.templateId),
      templateVersion = cplExecutionRevision(request.templateVersion);
    requirePermission(a, "canWrite");
    const parent = await this.parent(e, a, request.projectId);
    const key = await this.mutation(
      e,
      a,
      "report.create",
      request.idempotencyKey,
      { projectId: request.projectId, templateId, templateVersion },
      randomUUID(),
    );
    const next = { ...request, reportId: key.resourceId };
    if (key.duplicate) return this.detail(e, a, next);
    const count = await e.query<Row>(
      "SELECT count(*) AS total FROM cpl_reports WHERE organization_id=$1 AND project_id=$2",
      [a.organizationId, request.projectId],
    );
    if (Number(count.rows[0]?.total) >= 100) fail("CPL_REPORT_LIMIT");
    const templateRows = await e.query<Row>(
      "SELECT * FROM cpl_report_templates WHERE organization_id=$1 AND id=$2 AND version=$3",
      [a.organizationId, templateId, templateVersion],
    );
    const selected = template(templateRows.rows[0] ?? fail("CPL_RECORD_NOT_FOUND"));
    const branding = await this.branding(e, a);
    if (!branding) fail("CPL_REPORT_BRANDING_REQUIRED");
    const content = normalizeCplReportContent(
      request.initialContent ?? {
        ...selected,
        scope:
          selected.scope ||
          json<CplCommercialProjectSnapshot>(parent.snapshot).version.content.scope,
        visits: [],
      },
    );
    const rows = await e.query<Row>(
      "INSERT INTO cpl_reports(organization_id,project_id,id,reference,revision,current_version,state,title,created_by_identity_id) VALUES($1,$2,$3,$4,1,1,'draft',$5,$6) RETURNING *",
      [
        a.organizationId,
        request.projectId,
        key.resourceId,
        `RPT-${new Date().getUTCFullYear()}-${key.resourceId.replaceAll("-", "").slice(0, 12).toUpperCase()}`,
        content.title,
        a.identityId,
      ],
    );
    await this.append(e, a, next, 1, content, selected, branding);
    await this.event(e, a, summary(rows.rows[0]!), "report.created");
    return this.detail(e, a, next);
  }
  private async edit(
    request: EditRequest,
    contentInput: unknown | undefined,
    refresh: boolean,
  ): Promise<CplReportDetail> {
    return this.run(request, true, async (e, a) => {
      requirePermission(a, "canWrite");
      const row = await this.row(e, a, request),
        r = summary(row),
        prior = await this.saved(e, a, request, r.currentVersion);
      const content =
        contentInput === undefined ? prior.content : normalizeCplReportContent(contentInput);
      const key = await this.mutation(
        e,
        a,
        refresh ? "report.refresh" : "report.save",
        request.idempotencyKey,
        {
          projectId: request.projectId,
          reportId: request.reportId,
          expectedRevision: request.expectedRevision,
          ...(refresh ? { input: contentInput === undefined ? null : content } : { content }),
        },
        r.id,
      );
      if (key.duplicate) return this.detail(e, a, request);
      this.checkRevision(row, request.expectedRevision);
      if (!["draft", "changes_requested"].includes(r.state)) fail("CPL_REPORT_STATE_CONFLICT");
      if (!refresh) await this.fresh(e, a, request.projectId, prior);
      const branding = await this.branding(e, a);
      if (!branding) fail("CPL_REPORT_BRANDING_REQUIRED");
      await this.append(e, a, request, r.currentVersion + 1, content, prior.template, branding);
      await e.query(
        "UPDATE cpl_reports SET revision=revision+1,current_version=current_version+1,title=$4,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND project_id=$2 AND id=$3",
        [a.organizationId, request.projectId, request.reportId, content.title],
      );
      await this.event(
        e,
        a,
        { ...r, revision: r.revision + 1, currentVersion: r.currentVersion + 1 },
        refresh ? "report.sources_refreshed" : "report.saved",
      );
      return this.detail(e, a, request);
    });
  }
  async saveReport(request: EditRequest & { input: unknown }): Promise<CplReportDetail> {
    return this.edit(request, request.input, false);
  }
  async refreshSources(request: EditRequest & { input?: unknown }): Promise<CplReportDetail> {
    return this.edit(request, request.input, true);
  }
  private async transition(
    request: EditRequest,
    action: "submit" | "request_changes" | "revise",
    reason = "",
  ): Promise<CplReportDetail> {
    const note = cplFieldText(reason, 4000, action !== "submit");
    return this.run(request, true, async (e, a) => {
      requirePermission(a, action === "request_changes" ? "canReview" : "canWrite");
      const row = await this.row(e, a, request),
        r = summary(row);
      const key = await this.mutation(
        e,
        a,
        `report.${action}`,
        request.idempotencyKey,
        {
          projectId: request.projectId,
          reportId: request.reportId,
          expectedRevision: request.expectedRevision,
          note,
        },
        r.id,
      );
      if (key.duplicate) return this.detail(e, a, request);
      this.checkRevision(row, request.expectedRevision);
      if (action === "submit") {
        if (!["draft", "changes_requested"].includes(r.state)) fail("CPL_REPORT_STATE_CONFLICT");
        const saved = await this.saved(e, a, request, r.currentVersion);
        await this.fresh(e, a, request.projectId, saved);
        if (this.readiness(saved).length) fail("CPL_REPORT_NOT_READY");
      } else if (action === "request_changes" ? r.state !== "in_review" : r.state !== "approved")
        fail("CPL_REPORT_STATE_CONFLICT");
      const state =
        action === "submit"
          ? "in_review"
          : action === "request_changes"
            ? "changes_requested"
            : "draft";
      let nextVersion = r.currentVersion;
      if (action === "revise") {
        nextVersion += 1;
        if (nextVersion > 200) fail("CPL_REPORT_VERSION_LIMIT");
        // Start a distinct editable version without silently refreshing the
        // approved sources. Any later source drift still requires explicit
        // reconciliation; the old PDF/version remains independently readable.
        await e.query(
          "INSERT INTO cpl_report_versions(organization_id,project_id,report_id,version,snapshot,source_hash,template_id,template_version,branding_revision,created_by_identity_id) SELECT organization_id,project_id,report_id,$5,snapshot,source_hash,template_id,template_version,branding_revision,$6 FROM cpl_report_versions WHERE organization_id=$1 AND project_id=$2 AND report_id=$3 AND version=$4",
          [
            a.organizationId,
            request.projectId,
            request.reportId,
            r.currentVersion,
            nextVersion,
            a.identityId,
          ],
        );
      }
      await e.query(
        "UPDATE cpl_reports SET revision=revision+1,state=$4,current_version=$5,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND project_id=$2 AND id=$3",
        [a.organizationId, request.projectId, request.reportId, state, nextVersion],
      );
      await this.event(
        e,
        a,
        { ...r, revision: r.revision + 1, currentVersion: nextVersion, state },
        `report.${action}`,
        note,
      );
      return this.detail(e, a, request);
    });
  }
  async submitReport(request: EditRequest) {
    return this.transition(request, "submit");
  }
  async requestChanges(request: EditRequest & { reason: string }) {
    return this.transition(request, "request_changes", request.reason);
  }
  async reviseReport(request: EditRequest & { reason: string }) {
    return this.transition(request, "revise", request.reason);
  }
  private async artifact(
    e: SqlExecutor,
    a: CplTenantAccess,
    request: Pick<ReportRequest, "projectId" | "reportId">,
    number: number,
  ): Promise<Row | undefined> {
    return (
      await e.query<Row>(
        "SELECT * FROM cpl_report_artifacts WHERE organization_id=$1 AND project_id=$2 AND report_id=$3 AND version=$4",
        [a.organizationId, request.projectId, request.reportId, number],
      )
    ).rows[0];
  }
  private prepared(row: Row, saved: CplReportVersion): CplReportApprovalPreparation {
    return {
      status: "prepared",
      attemptId: String(row.id),
      approvedAt: iso(row.approved_at),
      artifactObjectId: String(row.artifact_object_id),
      sourceHash: String(row.source_hash),
      projection: json<CplReportPublicProjection>(row.projection),
      photoReferences: saved.sources.visits
        .flatMap((v) => [...v.overviewPhotos, ...v.observations.flatMap((o) => o.photos)])
        .map((p) => ({
          photoId: p.id,
          reference: {
            organizationId: p.report.organizationId,
            objectId: p.report.objectId,
            sha256: p.report.sha256,
            byteLength: p.report.byteLength,
          },
        })),
    };
  }
  async prepareApproval(request: EditRequest): Promise<CplReportApprovalPreparation> {
    return this.run(request, true, async (e, a) => {
      requirePermission(a, "canReview");
      const row = await this.row(e, a, request),
        r = summary(row),
        saved = await this.saved(e, a, request, r.currentVersion);
      if (r.state === "approved") {
        const completed = await this.artifact(e, a, request, r.currentVersion);
        return {
          status: "completed",
          artifact: artifact(completed ?? fail("CPL_REPORT_SCHEMA_UNSAFE")),
          version: saved,
        };
      }
      const key = await this.mutation(
        e,
        a,
        "report.prepare",
        request.idempotencyKey,
        {
          projectId: request.projectId,
          reportId: request.reportId,
          expectedRevision: request.expectedRevision,
        },
        randomUUID(),
      );
      if (key.duplicate) {
        const prior =
          (
            await e.query<Row>(
              "SELECT * FROM cpl_report_attempts WHERE organization_id=$1 AND project_id=$2 AND report_id=$3 AND id=$4",
              [a.organizationId, request.projectId, request.reportId, key.resourceId],
            )
          ).rows[0] ?? fail("CPL_RECORD_NOT_FOUND");
        if (prior.prepared_by_identity_id !== a.identityId) fail("CPL_ACCESS_DENIED");
        this.checkRevision(row, Number(prior.expected_revision));
        await this.fresh(e, a, request.projectId, saved);
        if (r.state !== "in_review") fail("CPL_REPORT_STATE_CONFLICT");
        return this.prepared(prior, saved);
      }
      this.checkRevision(row, request.expectedRevision);
      if (r.state !== "in_review") fail("CPL_REPORT_STATE_CONFLICT");
      await this.fresh(e, a, request.projectId, saved);
      if (this.readiness(saved).length) fail("CPL_REPORT_NOT_READY");
      const timestamp = new Date().toISOString(),
        publicProjection = projection(r, saved, timestamp);
      const rows = await e.query<Row>(
        "INSERT INTO cpl_report_attempts(organization_id,project_id,report_id,version,id,expected_revision,artifact_object_id,source_hash,projection,approved_at,prepared_by_identity_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11) RETURNING *",
        [
          a.organizationId,
          request.projectId,
          request.reportId,
          r.currentVersion,
          key.resourceId,
          r.revision,
          randomUUID(),
          saved.sourceHash,
          JSON.stringify(publicProjection),
          timestamp,
          a.identityId,
        ],
      );
      await this.event(e, a, r, "report.approval_prepared");
      return this.prepared(rows.rows[0]!, saved);
    });
  }
  async completeApproval(
    request: ReportRequest & {
      attemptId: string;
      sha256: string;
      byteLength: number;
      rendererVersion: string;
      idempotencyKey: string;
    },
  ): Promise<CplReportDetail> {
    const attemptId = cplExecutionId(request.attemptId);
    if (
      !/^[a-f0-9]{64}$/u.test(request.sha256) ||
      !Number.isSafeInteger(request.byteLength) ||
      request.byteLength < 1 ||
      request.byteLength > 64 * 1024 * 1024 ||
      request.rendererVersion !== "cpl-report-pdf-v1"
    )
      fail("CPL_REPORT_ARTIFACT_INVALID");
    return this.run(request, true, async (e, a) => {
      requirePermission(a, "canReview");
      const row = await this.row(e, a, request),
        r = summary(row);
      const attempt =
        (
          await e.query<Row>(
            "SELECT * FROM cpl_report_attempts WHERE organization_id=$1 AND project_id=$2 AND report_id=$3 AND id=$4",
            [a.organizationId, request.projectId, request.reportId, attemptId],
          )
        ).rows[0] ?? fail("CPL_RECORD_NOT_FOUND");
      if (attempt.prepared_by_identity_id !== a.identityId) fail("CPL_ACCESS_DENIED");
      const completed = await this.artifact(e, a, request, Number(attempt.version));
      if (completed) {
        if (
          completed.attempt_id !== attemptId ||
          completed.sha256 !== request.sha256 ||
          Number(completed.byte_length) !== request.byteLength ||
          completed.renderer_version !== request.rendererVersion
        )
          fail("CPL_REPORT_IMMUTABLE_ARTIFACT");
        return this.detail(e, a, request);
      }
      const key = await this.mutation(
        e,
        a,
        "report.approve",
        request.idempotencyKey,
        {
          projectId: request.projectId,
          reportId: request.reportId,
          attemptId,
          sha256: request.sha256,
          byteLength: request.byteLength,
          rendererVersion: request.rendererVersion,
        },
        request.reportId,
      );
      if (key.duplicate) fail("CPL_REPORT_SCHEMA_UNSAFE");
      this.checkRevision(row, Number(attempt.expected_revision));
      if (r.state !== "in_review" || r.currentVersion !== Number(attempt.version))
        fail("CPL_REPORT_STATE_CONFLICT");
      const saved = await this.saved(e, a, request, r.currentVersion);
      await this.fresh(e, a, request.projectId, saved);
      if (this.readiness(saved).length || saved.sourceHash !== attempt.source_hash)
        fail("CPL_REPORT_SOURCES_CHANGED");
      if (
        hash(canonical(projection(r, saved, iso(attempt.approved_at)))) !==
        hash(canonical(json(attempt.projection)))
      )
        fail("CPL_REPORT_SOURCES_CHANGED");
      await e.query(
        "INSERT INTO cpl_report_artifacts(organization_id,project_id,report_id,version,attempt_id,object_id,sha256,byte_length,renderer_version,source_hash,approved_at,approved_by_identity_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
        [
          a.organizationId,
          request.projectId,
          request.reportId,
          r.currentVersion,
          attemptId,
          attempt.artifact_object_id,
          request.sha256,
          request.byteLength,
          request.rendererVersion,
          saved.sourceHash,
          attempt.approved_at,
          a.identityId,
        ],
      );
      await e.query(
        "UPDATE cpl_reports SET revision=revision+1,state='approved',updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND project_id=$2 AND id=$3",
        [a.organizationId, request.projectId, request.reportId],
      );
      await this.event(
        e,
        a,
        { ...r, revision: r.revision + 1, state: "approved" },
        "report.approved",
      );
      await emitCplBusinessEvent(e, a, {
        type: "report.approved",
        sourceKind: "report",
        sourceId: r.id,
        sourceVersion: r.currentVersion,
        projectId: request.projectId,
        service: json<CplCommercialProjectSnapshot>(
          (await this.parent(e, a, request.projectId)).snapshot,
        ).version.sourceLead.fields.requestedService,
        title: r.title,
      });
      return this.detail(e, a, request);
    });
  }
  async getCustomerPreview(request: ReportRequest & { version: number }): Promise<{
    reportId: string;
    version: number;
    approvalState: "approved" | "unapproved";
    projection: CplReportPublicProjection;
  }> {
    return this.run(request, false, async (e, a) => {
      const r = summary(await this.row(e, a, request)),
        v = await this.saved(e, a, request, request.version),
        approved = await this.artifact(e, a, request, v.version);
      return {
        reportId: r.id,
        version: v.version,
        approvalState: approved ? "approved" : "unapproved",
        projection: projection(r, v, approved ? iso(approved.approved_at) : v.createdAt),
      };
    });
  }
  async getArtifact(request: ReportRequest & { version: number }): Promise<CplReportArtifact> {
    return this.run(request, false, async (e, a) => {
      await this.row(e, a, request);
      return artifact(
        (await this.artifact(e, a, request, cplExecutionRevision(request.version))) ??
          fail("CPL_REPORT_ARTIFACT_NOT_FOUND"),
      );
    });
  }
}
