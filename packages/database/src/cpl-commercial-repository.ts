import { createHash, randomUUID } from "node:crypto";
import {
  CPL_COMMERCIAL_LOST_REASONS,
  calculateCplCommercialTotals,
  cplCommercialDate,
  cplCommercialMoney,
  defaultCplCommercialBranding,
  normalizeCplCommercialBranding,
  normalizeCplCommercialContent,
  normalizeCplCommercialTemplate,
  type CplApprovedProposalPdf,
  type CplCommercialArtifact,
  type CplCommercialAward,
  type CplCommercialAwardInput,
  type CplCommercialBranding,
  type CplCommercialCustomerPreview,
  type CplCommercialEvent,
  type CplCommercialLostReason,
  type CplCommercialOutcome,
  type CplCommercialPermissions,
  type CplCommercialProject,
  type CplCommercialProjectSnapshot,
  type CplCommercialProposal,
  type CplCommercialProposalSummary,
  type CplCommercialSourceLead,
  type CplCommercialTemplate,
  type CplCommercialVersion,
} from "@bea/domain/cpl-commercial";
import {
  CPL_LEAD_EDITABLE_FIELDS,
  intakeId,
  intakeText,
  type CplLeadFields,
} from "@bea/domain/cpl-intake";
import { SqlCplIntakeRepository } from "./cpl-intake-repository.js";
import { emitCplBusinessEvent } from "./cpl-business-events.js";
import type { SqlExecutor } from "./adapter.js";
import {
  cplTenantRoleAllows,
  type CplTenantAccess,
  type CplTenantPermission,
  type CplTenantRequest,
  SqlCplTenantRepository,
} from "./tenant-repository.js";

export type * from "@bea/domain/cpl-commercial";
type Row = Record<string, unknown>;
export class CplCommercialError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CplCommercialError";
  }
}
function fail(code: string): never {
  throw new CplCommercialError(code);
}
function id(value: unknown): string {
  return intakeId(value) ?? fail("CPL_INVALID_INPUT");
}
function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    fail("CPL_INVALID_INPUT");
  return value;
}
function iso(value: unknown): string {
  return new Date(value as string).toISOString();
}
function json<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}
function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function boundedJson(value: unknown): string {
  const result = JSON.stringify(value);
  if (Buffer.byteLength(result) > 2_097_152) fail("CPL_COMMERCIAL_RECORD_TOO_LARGE");
  return result;
}
function summary(row: Row): CplCommercialProposalSummary {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    reference: String(row.reference),
    leadId: String(row.lead_id),
    legacyDraftId: row.legacy_draft_id == null ? null : String(row.legacy_draft_id),
    title: String(row.title),
    state: row.state as CplCommercialProposalSummary["state"],
    revision: Number(row.revision),
    currentVersion: Number(row.current_version),
    approvedVersion: row.approved_version == null ? null : Number(row.approved_version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
function version(row: Row): CplCommercialVersion {
  return {
    ...json<Omit<CplCommercialVersion, "version" | "createdAt" | "createdByIdentityId">>(
      row.snapshot,
    ),
    version: Number(row.version),
    createdAt: iso(row.created_at),
    createdByIdentityId: String(row.created_by_identity_id),
  };
}
function award(row: Row): CplCommercialAward {
  return {
    ...json<CplCommercialAwardInput>(row.snapshot),
    id: String(row.id),
    proposalId: String(row.proposal_id),
    proposalVersion: Number(row.proposal_version),
    actorIdentityId: String(row.actor_identity_id),
    createdAt: iso(row.created_at),
  };
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
function artifact(row: Row): CplCommercialArtifact {
  return {
    id: String(row.id),
    proposalId: String(row.proposal_id),
    version: Number(row.version),
    projectionSha256: String(row.projection_sha256),
    sha256: String(row.sha256),
    byteLength: Number(row.byte_length),
    rendererVersion: String(row.renderer_version),
    createdAt: iso(row.created_at),
  };
}
async function audit(
  executor: SqlExecutor,
  access: CplTenantAccess,
  action: string,
  resource: string,
) {
  await executor.query(
    "INSERT INTO cpl_tenant_audit_events(id,organization_id,actor_identity_id,action,resource_id) VALUES($1,$2,$3,$4,$5)",
    [randomUUID(), access.organizationId, access.identityId, action, resource],
  );
}
async function mutation(
  executor: SqlExecutor,
  access: CplTenantAccess,
  kind: string,
  key: string,
  input: unknown,
) {
  if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/u.test(key))
    fail("CPL_INVALID_IDEMPOTENCY_KEY");
  const requestHash = hash(JSON.stringify(input)),
    resourceId = randomUUID();
  const result = await executor.query<Row>(
    "INSERT INTO cpl_workflow_mutations(organization_id,mutation_kind,idempotency_key,request_hash,resource_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING resource_id",
    [access.organizationId, kind, key, requestHash, resourceId],
  );
  if (result.rows[0]) return { id: resourceId, created: true };
  const prior = await executor.query<Row>(
    "SELECT request_hash,resource_id FROM cpl_workflow_mutations WHERE organization_id=$1 AND mutation_kind=$2 AND idempotency_key=$3 FOR UPDATE",
    [access.organizationId, kind, key],
  );
  if (prior.rows[0]?.request_hash !== requestHash) fail("CPL_IDEMPOTENCY_CONFLICT");
  return { id: String(prior.rows[0]!.resource_id), created: false };
}

/** All commercial records are additive, tenant-scoped and independent of legacy repositories. */
export class SqlCplCommercialRepository extends SqlCplIntakeRepository {
  constructor(private readonly tenants: SqlCplTenantRepository) {
    super(tenants);
  }
  private async commercialSchema(executor: SqlExecutor) {
    const rows = await executor.query<{ protected: boolean }>(
      "SELECT count(*)=8 AND bool_and(relrowsecurity AND relforcerowsecurity) AS protected FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN ('cpl_commercial_branding','cpl_commercial_templates','cpl_commercial_proposals','cpl_commercial_versions','cpl_commercial_events','cpl_commercial_awards','cpl_commercial_projects','cpl_commercial_artifacts')",
    );
    if (rows.rows[0]?.protected !== true) fail("CPL_COMMERCIAL_SCHEMA_UNSAFE");
  }
  private run<T>(
    request: CplTenantRequest,
    permission: CplTenantPermission,
    operation: (executor: SqlExecutor, access: CplTenantAccess) => Promise<T>,
    modules: readonly ("proposal-builder" | "award-to-project-launcher")[] = ["proposal-builder"],
  ): Promise<T> {
    return this.tenants.withTenantReadTransaction(request, modules, async (executor, access) => {
      if (!cplTenantRoleAllows(access.role, permission)) fail("CPL_ACCESS_DENIED");
      await this.commercialSchema(executor);
      return operation(executor, access);
    });
  }
  private async branding(
    executor: SqlExecutor,
    access: CplTenantAccess,
  ): Promise<CplCommercialBranding> {
    const r = await executor.query<Row>(
      "SELECT * FROM cpl_commercial_branding WHERE organization_id=$1",
      [access.organizationId],
    );
    return r.rows[0]
      ? {
          ...json<CplCommercialBranding>(r.rows[0].configuration),
          revision: Number(r.rows[0].revision),
        }
      : defaultCplCommercialBranding();
  }
  private async template(
    executor: SqlExecutor,
    access: CplTenantAccess,
    templateId: string,
  ): Promise<CplCommercialTemplate> {
    const r = await executor.query<Row>(
      "SELECT * FROM cpl_commercial_templates WHERE organization_id=$1 AND id=$2",
      [access.organizationId, id(templateId)],
    );
    const row = r.rows[0] ?? fail("CPL_RECORD_NOT_FOUND");
    return {
      ...json<CplCommercialTemplate>(row.snapshot),
      id: String(row.id),
      organizationId: access.organizationId,
      createdAt: iso(row.created_at),
    };
  }
  private async row(
    executor: SqlExecutor,
    access: CplTenantAccess,
    proposalId: string,
    lock = false,
  ): Promise<Row> {
    const r = await executor.query<Row>(
      `SELECT * FROM cpl_commercial_proposals WHERE organization_id=$1 AND id=$2${lock ? " FOR UPDATE" : " FOR SHARE"}`,
      [access.organizationId, id(proposalId)],
    );
    return r.rows[0] ?? fail("CPL_RECORD_NOT_FOUND");
  }
  private async quoted(
    executor: SqlExecutor,
    access: CplTenantAccess,
    proposalId: string,
    number: number,
  ): Promise<CplCommercialVersion> {
    const r = await executor.query<Row>(
      "SELECT * FROM cpl_commercial_versions WHERE organization_id=$1 AND proposal_id=$2 AND version=$3",
      [access.organizationId, proposalId, positive(number)],
    );
    return version(r.rows[0] ?? fail("CPL_RECORD_NOT_FOUND"));
  }
  private async detail(
    executor: SqlExecutor,
    access: CplTenantAccess,
    row: Row,
  ): Promise<CplCommercialProposal> {
    const args = [access.organizationId, row.id];
    const versions = await executor.query<Row>(
      "SELECT * FROM cpl_commercial_versions WHERE organization_id=$1 AND proposal_id=$2 ORDER BY version DESC",
      args,
    );
    const events = await executor.query<Row>(
      "SELECT * FROM cpl_commercial_events WHERE organization_id=$1 AND proposal_id=$2 ORDER BY revision DESC",
      args,
    );
    const artifacts = await executor.query<Row>(
      "SELECT id,proposal_id,version,projection_sha256,sha256,byte_length,renderer_version,created_at FROM cpl_commercial_artifacts WHERE organization_id=$1 AND proposal_id=$2 ORDER BY version DESC",
      args,
    );
    const awards = await executor.query<Row>(
      "SELECT * FROM cpl_commercial_awards WHERE organization_id=$1 AND proposal_id=$2",
      args,
    );
    const projects = (await this.projectsEnabled(executor, access))
      ? await executor.query<Row>(
          "SELECT * FROM cpl_commercial_projects WHERE organization_id=$1 AND proposal_id=$2",
          args,
        )
      : { rows: [] };
    return {
      ...summary(row),
      outcome: (() => {
        const event = events.rows.find((event) =>
          ["lost", "withdrawn", "awarded"].includes(String(event.action)),
        );
        return event
          ? {
              outcome: event.action as CplCommercialOutcome["outcome"],
              reasonCode: event.reason_code as CplCommercialLostReason | null,
              note: event.note == null ? null : String(event.note),
              version: Number(event.version),
              actorIdentityId: String(event.actor_identity_id),
              createdAt: iso(event.created_at),
            }
          : null;
      })(),
      internalNotes: String(row.internal_notes),
      versions: versions.rows.map(version),
      events: events.rows.map(
        (r) =>
          ({
            id: String(r.id),
            action: String(r.action),
            version: Number(r.version),
            revision: Number(r.revision),
            reason: r.reason == null ? null : String(r.reason),
            reasonCode: r.reason_code as CplCommercialLostReason | null,
            note: r.note == null ? null : String(r.note),
            actorIdentityId: String(r.actor_identity_id),
            createdAt: iso(r.created_at),
          }) satisfies CplCommercialEvent,
      ),
      artifacts: artifacts.rows.map(artifact),
      award: awards.rows[0] ? award(awards.rows[0]) : null,
      project: projects.rows[0] ? project(projects.rows[0]) : null,
    };
  }
  private async event(
    executor: SqlExecutor,
    access: CplTenantAccess,
    row: Row,
    action: string,
    reason: string | null = null,
    reasonCode: CplCommercialLostReason | null = null,
    note: string | null = null,
  ) {
    await executor.query(
      "INSERT INTO cpl_commercial_events(id,organization_id,proposal_id,version,revision,action,reason,actor_identity_id,reason_code,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [
        randomUUID(),
        access.organizationId,
        row.id,
        row.current_version,
        row.revision,
        action,
        reason,
        access.identityId,
        reasonCode,
        note,
      ],
    );
    await audit(executor, access, `commercial.${action}`, String(row.id));
  }
  private expected(row: Row, revision: number) {
    if (Number(row.revision) !== positive(revision)) fail("CPL_COMMERCIAL_VERSION_CONFLICT");
  }
  private async projectsEnabled(executor: SqlExecutor, access: CplTenantAccess): Promise<boolean> {
    const result = await executor.query<Row>(
      `SELECT enabled,usage_limit FROM cpl_module_entitlements WHERE organization_id=$1 AND module_key='award-to-project-launcher' ${access.automationExecutionId ? "" : "FOR SHARE"}`,
      [access.organizationId],
    );
    return (
      result.rows[0]?.enabled === true &&
      (result.rows[0].usage_limit == null || Number(result.rows[0].usage_limit) > 0)
    );
  }
  private async changed(
    executor: SqlExecutor,
    access: CplTenantAccess,
    row: Row,
    state: string,
    approvedVersion: number | null,
    action: string,
    reason: string | null = null,
    reasonCode: CplCommercialLostReason | null = null,
    note: string | null = null,
  ) {
    const result = await executor.query<Row>(
      "UPDATE cpl_commercial_proposals SET state=$3,approved_version=$4,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND id=$2 RETURNING *",
      [access.organizationId, row.id, state, approvedVersion],
    );
    await this.event(executor, access, result.rows[0]!, action, reason, reasonCode, note);
    return result.rows[0]!;
  }
  async readWorkspace(request: CplTenantRequest): Promise<{
    proposals: CplCommercialProposalSummary[];
    templates: CplCommercialTemplate[];
    branding: CplCommercialBranding;
    projects: CplCommercialProject[];
    permissions: CplCommercialPermissions;
  }> {
    return this.run(request, "records:read", async (executor, access) => {
      const proposals = await executor.query<Row>(
        "SELECT * FROM cpl_commercial_proposals WHERE organization_id=$1 ORDER BY updated_at DESC,id LIMIT 100",
        [access.organizationId],
      );
      const templates = await executor.query<Row>(
        "SELECT * FROM cpl_commercial_templates WHERE organization_id=$1 ORDER BY created_at DESC,id LIMIT 100",
        [access.organizationId],
      );
      const enabled = await this.projectsEnabled(executor, access);
      const projects = enabled
        ? await executor.query<Row>(
            "SELECT * FROM cpl_commercial_projects WHERE organization_id=$1 ORDER BY created_at DESC,id LIMIT 100",
            [access.organizationId],
          )
        : { rows: [] };
      return {
        proposals: proposals.rows.map(summary),
        templates: templates.rows.map((r) => ({
          ...json<CplCommercialTemplate>(r.snapshot),
          id: String(r.id),
          organizationId: access.organizationId,
          createdAt: iso(r.created_at),
        })),
        branding: await this.branding(executor, access),
        projects: projects.rows.map(project),
        permissions: {
          canEdit: cplTenantRoleAllows(access.role, "commercial:write"),
          canReview: cplTenantRoleAllows(access.role, "commercial:review"),
          canAward: cplTenantRoleAllows(access.role, "commercial:award"),
          canCreateProject: enabled && cplTenantRoleAllows(access.role, "projects:create"),
          canConfigure: cplTenantRoleAllows(access.role, "settings:write"),
        },
      };
    });
  }
  async getProposal(
    request: CplTenantRequest & { proposalId: string },
  ): Promise<CplCommercialProposal> {
    return this.run(request, "records:read", async (e, a) =>
      this.detail(e, a, await this.row(e, a, request.proposalId)),
    );
  }
  async getTemplate(
    request: CplTenantRequest & { templateId: string },
  ): Promise<CplCommercialTemplate> {
    return this.run(request, "records:read", (e, a) => this.template(e, a, request.templateId));
  }
  async getProject(
    request: CplTenantRequest & { projectId: string },
  ): Promise<CplCommercialProject> {
    return this.run(
      request,
      "records:read",
      async (e, a) => {
        const r = await e.query<Row>(
          "SELECT * FROM cpl_commercial_projects WHERE organization_id=$1 AND id=$2",
          [a.organizationId, id(request.projectId)],
        );
        return project(r.rows[0] ?? fail("CPL_RECORD_NOT_FOUND"));
      },
      ["award-to-project-launcher"],
    );
  }
  async createTemplate(
    request: CplTenantRequest & { input: unknown; idempotencyKey: string },
  ): Promise<CplCommercialTemplate> {
    const value = normalizeCplCommercialTemplate(request.input);
    return this.run(request, "settings:write", async (e, a) => {
      const key = await mutation(e, a, "commercial.template", request.idempotencyKey, value);
      if (key.created) {
        await e.query(
          "INSERT INTO cpl_commercial_templates(id,organization_id,name,snapshot,created_by_identity_id) VALUES($1,$2,$3,$4::jsonb,$5)",
          [key.id, a.organizationId, value.name, boundedJson(value), a.identityId],
        );
        await audit(e, a, "commercial.template.created", key.id);
      }
      return this.template(e, a, key.id);
    });
  }
  async saveBranding(
    request: CplTenantRequest & { input: unknown; expectedRevision: number },
  ): Promise<CplCommercialBranding> {
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0)
      fail("CPL_INVALID_INPUT");
    const value = normalizeCplCommercialBranding(request.input, request.expectedRevision + 1);
    return this.run(request, "settings:write", async (e, a) => {
      await this.lockIntake(e, a);
      const prior = await this.branding(e, a);
      if (prior.revision !== request.expectedRevision) fail("CPL_COMMERCIAL_VERSION_CONFLICT");
      await e.query(
        "INSERT INTO cpl_commercial_branding(organization_id,revision,configuration,updated_by_identity_id) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(organization_id) DO UPDATE SET revision=EXCLUDED.revision,configuration=EXCLUDED.configuration,updated_by_identity_id=EXCLUDED.updated_by_identity_id,updated_at=CURRENT_TIMESTAMP",
        [a.organizationId, value.revision, boundedJson(value), a.identityId],
      );
      await audit(e, a, "commercial.branding.updated", a.organizationId);
      return value;
    });
  }
  async createProposal(
    request: CplTenantRequest & {
      leadId: string;
      templateId?: string;
      legacyDraftId?: string;
      allowAdditional?: boolean;
      idempotencyKey: string;
    },
  ): Promise<CplCommercialProposal> {
    return this.run(request, "commercial:write", (e, a) =>
      this.createProposalInTransaction(e, a, request),
    );
  }
  /** Trusted server composition; the caller holds live authorization and the worker fence. */
  async createProposalInTransaction(
    e: SqlExecutor,
    a: CplTenantAccess,
    request: {
      leadId: string;
      templateId?: string;
      legacyDraftId?: string;
      allowAdditional?: boolean;
      idempotencyKey: string;
    },
  ): Promise<CplCommercialProposal> {
    if (!cplTenantRoleAllows(a.role, "commercial:write")) fail("CPL_ACCESS_DENIED");
    await this.commercialSchema(e);
    const leadId = id(request.leadId),
      templateId = request.templateId ? id(request.templateId) : null,
      legacyDraftId = request.legacyDraftId ? id(request.legacyDraftId) : null;
    if (request.allowAdditional !== undefined && typeof request.allowAdditional !== "boolean")
      fail("CPL_INVALID_INPUT");
    await this.protect(e);
    await this.lockIntake(e, a);
    const key = await mutation(e, a, "commercial.create", request.idempotencyKey, {
      leadId,
      templateId,
      legacyDraftId,
      allowAdditional: request.allowAdditional === true,
    });
    if (!key.created) return this.detail(e, a, await this.row(e, a, key.id));
    const source = await e.query<Row>(
      "SELECT * FROM cpl_workflow_leads WHERE organization_id=$1 AND id=$2 FOR SHARE",
      [a.organizationId, leadId],
    );
    const leadRow = source.rows[0] ?? fail("CPL_RECORD_NOT_FOUND");
    if (leadRow.assigned_member_identity_id) {
      const member = await e.query(
        `SELECT m.identity_id FROM cpl_memberships m JOIN cpl_identities i ON i.id=m.identity_id WHERE m.organization_id=$1 AND m.identity_id=$2 AND m.status='active' AND i.status='active' ${a.automationExecutionId ? "" : "FOR SHARE OF m,i"}`,
        [a.organizationId, leadRow.assigned_member_identity_id],
      );
      if (!member.rows[0]) fail("CPL_LEAD_NOT_READY");
    }
    const lead = await this.intakeLead(e, a, leadRow);
    if (lead.status !== "ready_for_proposal" || !lead.readiness.readyForProposal)
      fail("CPL_LEAD_NOT_READY");
    let legacy: Row | null = null;
    if (legacyDraftId) {
      const r = await e.query<Row>(
        "SELECT * FROM cpl_proposal_drafts WHERE organization_id=$1 AND id=$2 AND lead_id=$3 FOR SHARE",
        [a.organizationId, legacyDraftId, leadId],
      );
      legacy = r.rows[0] ?? fail("CPL_RECORD_NOT_FOUND");
    }
    const existing = await e.query<Row>(
      "SELECT * FROM cpl_commercial_proposals WHERE organization_id=$1 AND (($3::uuid IS NOT NULL AND legacy_draft_id=$3) OR ($4=FALSE AND lead_id=$2)) ORDER BY created_at,id LIMIT 1",
      [a.organizationId, leadId, legacyDraftId, request.allowAdditional === true],
    );
    if (existing.rows[0]) {
      await e.query(
        "UPDATE cpl_workflow_mutations SET resource_id=$4 WHERE organization_id=$1 AND mutation_kind='commercial.create' AND idempotency_key=$2 AND resource_id=$3",
        [a.organizationId, request.idempotencyKey, key.id, existing.rows[0].id],
      );
      return this.detail(e, a, existing.rows[0]);
    }
    const branding = await this.branding(e, a),
      template = templateId ? await this.template(e, a, templateId) : null;
    const content = normalizeCplCommercialContent(
      {
        ...template,
        title: lead.title,
        scope: legacy
          ? `Preserved legacy manual draft (version ${Number(legacy.version)})\n\n${String(legacy.content)}`
          : template?.scope || lead.details,
        currency: branding.defaultCurrency,
        lineItems: template?.catalog.map((item) => ({ ...item, quantity: "1" })) ?? [],
        discountMinor: 0,
        taxBasisPoints: 0,
        startDate: null,
        endDate: null,
        accessInstructions: "",
        constraints: "",
      },
      branding,
    );
    const fields = Object.fromEntries(
      CPL_LEAD_EDITABLE_FIELDS.map((k) => [k, lead[k]]),
    ) as unknown as CplLeadFields;
    const sourceLead: CplCommercialSourceLead = {
      id: lead.id,
      version: lead.version,
      fields,
      evidence: lead.evidence,
      capturedAt: new Date().toISOString(),
    };
    const inserted = await e.query<Row>(
      "INSERT INTO cpl_commercial_proposals(id,organization_id,reference,lead_id,legacy_draft_id,title,current_version,created_by_identity_id) VALUES($1,$2,$3,$4,$5,$6,1,$7) RETURNING *",
      [
        key.id,
        a.organizationId,
        `Q-${new Date().getUTCFullYear()}-${key.id.replaceAll("-", "").slice(0, 12).toUpperCase()}`,
        leadId,
        legacyDraftId,
        content.title,
        a.identityId,
      ],
    );
    await e.query(
      "INSERT INTO cpl_commercial_versions(organization_id,proposal_id,version,snapshot,created_by_identity_id) VALUES($1,$2,1,$3::jsonb,$4)",
      [
        a.organizationId,
        key.id,
        boundedJson({
          content,
          totals: calculateCplCommercialTotals(content),
          sourceLead,
          branding,
          templateId,
          templateSnapshot: template,
        }),
        a.identityId,
      ],
    );
    await this.event(e, a, inserted.rows[0]!, legacy ? "legacy-upgraded" : "created");
    return this.detail(e, a, inserted.rows[0]!);
  }
  async saveProposal(
    request: CplTenantRequest & {
      proposalId: string;
      expectedRevision: number;
      content: unknown;
      internalNotes?: string;
    },
  ): Promise<CplCommercialProposal> {
    return this.run(request, "commercial:write", async (e, a) => {
      const row = await this.row(e, a, request.proposalId, true);
      this.expected(row, request.expectedRevision);
      if (!["draft", "revision_requested"].includes(String(row.state)))
        fail("CPL_COMMERCIAL_STATE_CONFLICT");
      const previous = await this.quoted(e, a, String(row.id), Number(row.current_version));
      if (previous.version >= 100) fail("CPL_COMMERCIAL_VERSION_LIMIT");
      const branding = await this.branding(e, a),
        content = normalizeCplCommercialContent(request.content, branding),
        next = previous.version + 1;
      const internalNotes =
        request.internalNotes === undefined
          ? String(row.internal_notes)
          : intakeText(request.internalNotes, 20000);
      await e.query(
        "INSERT INTO cpl_commercial_versions(organization_id,proposal_id,version,snapshot,created_by_identity_id) VALUES($1,$2,$3,$4::jsonb,$5)",
        [
          a.organizationId,
          row.id,
          next,
          boundedJson({
            content,
            totals: calculateCplCommercialTotals(content),
            sourceLead: previous.sourceLead,
            branding,
            templateId: previous.templateId,
            templateSnapshot: previous.templateSnapshot,
          }),
          a.identityId,
        ],
      );
      const updated = await e.query<Row>(
        "UPDATE cpl_commercial_proposals SET current_version=$3,title=$4,internal_notes=$5,state='draft',approved_version=NULL,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND id=$2 RETURNING *",
        [a.organizationId, row.id, next, content.title, internalNotes],
      );
      await this.event(e, a, updated.rows[0]!, "version.saved");
      return this.detail(e, a, updated.rows[0]!);
    });
  }
  private submittable(value: CplCommercialVersion) {
    if (
      !value.content.scope.trim() ||
      value.content.lineItems.length === 0 ||
      !value.branding.businessName.trim()
    )
      fail("CPL_COMMERCIAL_NOT_READY");
  }
  async submitProposal(
    request: CplTenantRequest & { proposalId: string; expectedRevision: number },
  ): Promise<CplCommercialProposal> {
    return this.run(request, "commercial:write", async (e, a) => {
      const row = await this.row(e, a, request.proposalId, true);
      this.expected(row, request.expectedRevision);
      if (row.state !== "draft") fail("CPL_COMMERCIAL_STATE_CONFLICT");
      this.submittable(await this.quoted(e, a, String(row.id), Number(row.current_version)));
      return this.detail(e, a, await this.changed(e, a, row, "review", null, "submitted"));
    });
  }
  async reviewProposal(
    request: CplTenantRequest & {
      proposalId: string;
      expectedRevision: number;
      decision: "approve" | "request_changes";
      reason?: string;
    },
  ): Promise<CplCommercialProposal> {
    if (!["approve", "request_changes"].includes(request.decision)) fail("CPL_INVALID_INPUT");
    const reason =
      intakeText(request.reason ?? "", 2000, request.decision === "request_changes") || null;
    return this.run(request, "commercial:review", async (e, a) => {
      const row = await this.row(e, a, request.proposalId, true);
      this.expected(row, request.expectedRevision);
      if (row.state !== "review") fail("CPL_COMMERCIAL_STATE_CONFLICT");
      this.submittable(await this.quoted(e, a, String(row.id), Number(row.current_version)));
      return this.detail(
        e,
        a,
        await this.changed(
          e,
          a,
          row,
          request.decision === "approve" ? "approved" : "revision_requested",
          request.decision === "approve" ? Number(row.current_version) : null,
          request.decision === "approve" ? "approved" : "revision.requested",
          reason,
        ),
      );
    });
  }
  async reviseProposal(
    request: CplTenantRequest & { proposalId: string; expectedRevision: number; reason: string },
  ): Promise<CplCommercialProposal> {
    const reason = intakeText(request.reason, 2000, true);
    return this.run(request, "commercial:write", async (e, a) => {
      const row = await this.row(e, a, request.proposalId, true);
      this.expected(row, request.expectedRevision);
      if (!["review", "approved", "revision_requested"].includes(String(row.state)))
        fail("CPL_COMMERCIAL_STATE_CONFLICT");
      return this.detail(
        e,
        a,
        await this.changed(e, a, row, "draft", null, "revision.opened", reason),
      );
    });
  }
  async recordOutcome(
    request: CplTenantRequest & {
      proposalId: string;
      expectedRevision: number;
      outcome: "lost" | "withdrawn" | "awarded";
      reason?: string;
      reasonCode?: CplCommercialLostReason;
      note?: string;
      award?: CplCommercialAwardInput;
      idempotencyKey: string;
    },
  ): Promise<CplCommercialProposal> {
    if (!["lost", "withdrawn", "awarded"].includes(request.outcome)) fail("CPL_INVALID_INPUT");
    const reasonCode = request.outcome === "lost" ? (request.reasonCode ?? "other") : null;
    if (
      reasonCode !== null &&
      !(CPL_COMMERCIAL_LOST_REASONS as readonly string[]).includes(reasonCode)
    )
      fail("CPL_INVALID_INPUT");
    const note =
      intakeText(
        request.note ?? request.reason ?? "",
        2000,
        request.outcome === "withdrawn" || reasonCode === "other",
      ) || null;
    const reason = note ?? reasonCode;
    let value: CplCommercialAwardInput | null = null;
    if (request.outcome === "awarded") {
      if (!request.award) fail("CPL_INVALID_INPUT");
      value = {
        awardDate: cplCommercialDate(request.award.awardDate, true)!,
        amountMinor: cplCommercialMoney(request.award.amountMinor),
        currency: intakeText(request.award.currency, 3, true),
        purchaseOrder: intakeText(request.award.purchaseOrder ?? "", 240),
        startDate: cplCommercialDate(request.award.startDate),
        notes: intakeText(request.award.notes ?? "", 20000),
      };
    }
    return this.run(request, "commercial:award", async (e, a) => {
      const row = await this.row(e, a, request.proposalId, true);
      const key = await mutation(e, a, "commercial.award", request.idempotencyKey, {
        proposalId: String(row.id),
        expectedRevision: request.expectedRevision,
        outcome: request.outcome,
        reason,
        reasonCode,
        note,
        award: value,
      });
      if (!key.created) return this.detail(e, a, row);
      this.expected(row, request.expectedRevision);
      if (["lost", "withdrawn", "awarded"].includes(String(row.state)))
        fail("CPL_COMMERCIAL_STATE_CONFLICT");
      if (value) {
        if (row.state !== "approved" || row.approved_version !== row.current_version)
          fail("CPL_APPROVED_VERSION_REQUIRED");
        const quoted = await this.quoted(e, a, String(row.id), Number(row.current_version));
        if (
          value.amountMinor !== quoted.totals.totalMinor ||
          value.currency !== quoted.totals.currency
        )
          fail("CPL_AWARD_TOTAL_MISMATCH");
        await e.query(
          "INSERT INTO cpl_commercial_awards(id,organization_id,proposal_id,proposal_version,snapshot,actor_identity_id) VALUES($1,$2,$3,$4,$5::jsonb,$6)",
          [key.id, a.organizationId, row.id, row.current_version, boundedJson(value), a.identityId],
        );
      }
      const changed = await this.changed(
        e,
        a,
        row,
        request.outcome,
        row.approved_version == null ? null : Number(row.approved_version),
        request.outcome,
        reason,
        reasonCode,
        note,
      );
      if (request.outcome === "awarded") {
        const quoted = await this.quoted(e, a, String(row.id), Number(row.current_version));
        await emitCplBusinessEvent(e, a, {
          type: "proposal.awarded",
          sourceKind: "proposal",
          sourceId: String(row.id),
          sourceVersion: Number(changed.revision),
          service: quoted.sourceLead.fields.requestedService,
          title: String(row.title),
        });
      }
      return this.detail(e, a, changed);
    });
  }
  private async projectSnapshot(
    e: SqlExecutor,
    a: CplTenantAccess,
    row: Row,
  ): Promise<CplCommercialProjectSnapshot> {
    if (row.state !== "awarded") fail("CPL_AWARD_REQUIRED");
    const r = await e.query<Row>(
      "SELECT * FROM cpl_commercial_awards WHERE organization_id=$1 AND proposal_id=$2",
      [a.organizationId, row.id],
    );
    const awarded = award(r.rows[0] ?? fail("CPL_AWARD_REQUIRED"));
    return {
      proposalReference: String(row.reference),
      internalNotes: String(row.internal_notes),
      version: await this.quoted(e, a, String(row.id), awarded.proposalVersion),
      award: awarded,
    };
  }
  async previewProject(
    request: CplTenantRequest & { proposalId: string },
  ): Promise<CplCommercialProjectSnapshot> {
    return this.run(
      request,
      "records:read",
      async (e, a) => this.projectSnapshot(e, a, await this.row(e, a, request.proposalId)),
      ["proposal-builder", "award-to-project-launcher"],
    );
  }
  async createProject(
    request: CplTenantRequest & { proposalId: string; idempotencyKey: string },
  ): Promise<CplCommercialProject> {
    return this.run(
      request,
      "projects:create",
      (e, a) => this.createProjectInTransaction(e, a, request),
      ["proposal-builder", "award-to-project-launcher"],
    );
  }
  /** Shared manual/automation conversion: the unique award remains authoritative. */
  async createProjectInTransaction(
    e: SqlExecutor,
    a: CplTenantAccess,
    request: { proposalId: string; idempotencyKey: string },
  ): Promise<CplCommercialProject> {
    if (!cplTenantRoleAllows(a.role, "projects:create")) fail("CPL_ACCESS_DENIED");
    await this.commercialSchema(e);
    const row = await this.row(e, a, request.proposalId, true);
    const snapshot = await this.projectSnapshot(e, a, row);
    const key = await mutation(e, a, "commercial.project", request.idempotencyKey, {
      proposalId: String(row.id),
      awardId: snapshot.award.id,
    });
    const existing = await e.query<Row>(
      "SELECT * FROM cpl_commercial_projects WHERE organization_id=$1 AND award_id=$2",
      [a.organizationId, snapshot.award.id],
    );
    if (existing.rows[0]) return project(existing.rows[0]);
    const inserted = await e.query<Row>(
      "INSERT INTO cpl_commercial_projects(id,organization_id,reference,award_id,proposal_id,proposal_version,lead_id,snapshot,created_by_identity_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING *",
      [
        key.id,
        a.organizationId,
        `PRJ-${new Date().getUTCFullYear()}-${key.id.replaceAll("-", "").slice(0, 12).toUpperCase()}`,
        snapshot.award.id,
        row.id,
        snapshot.award.proposalVersion,
        row.lead_id,
        boundedJson(snapshot),
        a.identityId,
      ],
    );
    await audit(e, a, "commercial.project.created", key.id);
    return project(inserted.rows[0]!);
  }
  private async publicDocument(
    e: SqlExecutor,
    a: CplTenantAccess,
    row: Row,
    number: number,
  ): Promise<{ document: CplApprovedProposalPdf; approved: boolean }> {
    const quoted = await this.quoted(e, a, String(row.id), number);
    const approvals = await e.query<Row>(
      "SELECT created_at FROM cpl_commercial_events WHERE organization_id=$1 AND proposal_id=$2 AND version=$3 AND action='approved' ORDER BY revision LIMIT 1",
      [a.organizationId, row.id, number],
    );
    const { businessName, email, phone, address, logoDataUrl, accentColor } = quoted.branding;
    const { customerName, contactName, contactEmail, contactPhone, siteName, siteAddress } =
      quoted.sourceLead.fields;
    // Explicit key projection prevents internal operational fields entering preview/PDF.
    const c = quoted.content;
    const content: CplApprovedProposalPdf["content"] = {
      title: c.title,
      summary: c.summary,
      scope: c.scope,
      schedule: c.schedule,
      deliverables: c.deliverables,
      assumptions: c.assumptions,
      exclusions: c.exclusions,
      terms: c.terms,
      paymentTerms: c.paymentTerms,
      customerNotes: c.customerNotes,
      currency: c.currency,
      lineItems: c.lineItems,
      discountMinor: c.discountMinor,
      taxBasisPoints: c.taxBasisPoints,
      startDate: c.startDate,
      endDate: c.endDate,
      sections: c.sections,
    };
    return {
      approved: approvals.rows.length > 0,
      document: {
        proposalId: String(row.id),
        reference: String(row.reference),
        version: number,
        approvedAt: approvals.rows[0] ? iso(approvals.rows[0].created_at) : "",
        company: { businessName, email, phone, address, logoDataUrl, accentColor },
        customer: { name: customerName, contactName, contactEmail, contactPhone },
        site: { name: siteName, address: siteAddress },
        content,
        totals: quoted.totals,
      },
    };
  }
  async getCustomerPreview(
    request: CplTenantRequest & { proposalId: string; version?: number },
  ): Promise<CplCommercialCustomerPreview> {
    return this.run(request, "records:read", async (e, a) => {
      const row = await this.row(e, a, request.proposalId);
      return {
        ...(await this.publicDocument(
          e,
          a,
          row,
          request.version === undefined ? Number(row.current_version) : positive(request.version),
        )),
        state: row.state as CplCommercialProposalSummary["state"],
      };
    });
  }
  private async approvedDocument(
    e: SqlExecutor,
    a: CplTenantAccess,
    row: Row,
    number: number,
  ): Promise<CplApprovedProposalPdf> {
    if (
      !["approved", "awarded"].includes(String(row.state)) ||
      Number(row.approved_version) !== number ||
      Number(row.current_version) !== number
    )
      fail("CPL_APPROVED_VERSION_REQUIRED");
    const result = await this.publicDocument(e, a, row, number);
    if (!result.approved) fail("CPL_APPROVED_VERSION_REQUIRED");
    return result.document;
  }
  async getApprovedPdf(
    request: CplTenantRequest & { proposalId: string; version?: number },
  ): Promise<CplApprovedProposalPdf> {
    return this.run(request, "records:read", async (e, a) => {
      const row = await this.row(e, a, request.proposalId);
      return this.approvedDocument(
        e,
        a,
        row,
        request.version === undefined ? Number(row.current_version) : positive(request.version),
      );
    });
  }
  async recordArtifact(
    request: CplTenantRequest & {
      proposalId: string;
      version: number;
      projectionSha256: string;
      bytes: Uint8Array;
      rendererVersion: string;
    },
  ): Promise<CplCommercialArtifact> {
    if (
      !(request.bytes instanceof Uint8Array) ||
      request.bytes.length < 8 ||
      request.bytes.length > 5242880 ||
      Buffer.from(request.bytes.subarray(0, 5)).toString("ascii") !== "%PDF-" ||
      !/^[0-9a-f]{64}$/u.test(request.projectionSha256)
    )
      fail("CPL_INVALID_INPUT");
    const bytes = Buffer.from(request.bytes),
      sha256 = hash(bytes),
      rendererVersion = intakeText(request.rendererVersion, 120, true);
    return this.run(request, "commercial:write", async (e, a) => {
      const row = await this.row(e, a, request.proposalId, true);
      const document = await this.approvedDocument(e, a, row, positive(request.version));
      if (hash(JSON.stringify(document)) !== request.projectionSha256)
        fail("CPL_ARTIFACT_SNAPSHOT_CONFLICT");
      const old = await e.query<Row>(
        "SELECT * FROM cpl_commercial_artifacts WHERE organization_id=$1 AND proposal_id=$2 AND version=$3",
        [a.organizationId, row.id, request.version],
      );
      if (old.rows[0]) {
        if (
          old.rows[0].projection_sha256 !== request.projectionSha256 ||
          old.rows[0].sha256 !== sha256
        )
          fail("CPL_ARTIFACT_IMMUTABLE");
        return artifact(old.rows[0]);
      }
      const inserted = await e.query<Row>(
        "INSERT INTO cpl_commercial_artifacts(id,organization_id,proposal_id,version,projection_sha256,sha256,renderer_version,bytes,byte_length,created_by_identity_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
        [
          randomUUID(),
          a.organizationId,
          row.id,
          request.version,
          request.projectionSha256,
          sha256,
          rendererVersion,
          bytes,
          bytes.length,
          a.identityId,
        ],
      );
      await audit(e, a, "commercial.pdf.created", String(row.id));
      return artifact(inserted.rows[0]!);
    });
  }
  async getPdfArtifact(
    request: CplTenantRequest & { proposalId: string; version: number },
  ): Promise<{ metadata: CplCommercialArtifact; bytes: Uint8Array }> {
    return this.run(request, "records:read", async (e, a) => {
      const row = await this.row(e, a, request.proposalId);
      const r = await e.query<Row>(
        "SELECT * FROM cpl_commercial_artifacts WHERE organization_id=$1 AND proposal_id=$2 AND version=$3",
        [a.organizationId, row.id, positive(request.version)],
      );
      const file = r.rows[0] ?? fail("CPL_ARTIFACT_NOT_FOUND");
      const bytes = Uint8Array.from(file.bytes as Uint8Array);
      if (hash(bytes) !== file.sha256 || bytes.length !== Number(file.byte_length))
        fail("CPL_ARTIFACT_INTEGRITY_FAILED");
      return { metadata: artifact(file), bytes };
    });
  }
}
