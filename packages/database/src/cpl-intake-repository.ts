import { createHash, randomUUID } from "node:crypto";
import { emitCplBusinessEvent } from "./cpl-business-events.js";
import { syncCplLeadAttention } from "./cpl-action-attention.js";
import {
  CPL_LEAD_EDITABLE_FIELDS,
  cplLeadMatchReasons,
  evaluateCplLeadReadiness,
  intakeId,
  intakeText,
  normalizeCplLeadFields,
  type CplLeadFields,
  type CplLeadReadiness,
  type CplLeadDuplicateCandidate,
  type CplLeadDuplicateReview,
  type CplLeadEvidence,
  type CplIntakeDirectory,
  type CplWorkflowPermissions,
} from "@bea/domain/cpl-intake";
import type { SqlExecutor } from "./adapter.js";
import {
  cplTenantRoleAllows,
  SqlCplTenantRepository,
  type CplTenantAccess,
  type CplTenantRequest,
} from "./tenant-repository.js";

export type { CplIntakeDirectory, CplWorkflowPermissions } from "@bea/domain/cpl-intake";
export interface CplWorkflowLead extends CplLeadFields {
  readonly id: string;
  readonly organizationId: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly readiness: CplLeadReadiness;
  readonly duplicateCandidates: CplLeadDuplicateCandidate[];
  readonly duplicateReview: CplLeadDuplicateReview;
  readonly evidence: CplLeadEvidence[];
}
type Row = Record<string, unknown>;
type LeadInput = Partial<CplLeadFields> & {
  title: string;
  idempotencyKey: string;
  sourceReference?: string;
  evidenceNote?: string;
};
type EditInput = Partial<CplLeadFields> & {
  leadId: string;
  expectedVersion: number;
  duplicateDisposition?: "unreviewed" | "distinct" | "duplicate";
  duplicateReason?: string;
  duplicateLeadId?: string | null;
};
export class CplIntakeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CplIntakeError";
  }
}
function fail(code: string): never {
  throw new CplIntakeError(code);
}
function id(value: unknown): string {
  return intakeId(value) ?? fail("CPL_INVALID_INPUT");
}
function iso(value: unknown): string {
  return new Date(value as string).toISOString();
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function reviewedCandidates(value: unknown): { leadId: string; version: number }[] {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (item): item is { leadId: string; version: number } =>
      item !== null &&
      typeof item === "object" &&
      typeof item.leadId === "string" &&
      Number.isSafeInteger(item.version),
  );
}
const columns: Record<keyof CplLeadFields, string> = {
  title: "title",
  contactName: "contact_name",
  contactEmail: "contact_email",
  details: "details",
  sourceType: "source_type",
  customerId: "customer_id",
  customerName: "customer_name",
  contactId: "contact_id",
  contactPhone: "contact_phone",
  siteId: "site_id",
  siteName: "site_name",
  siteAddress: "site_address",
  requestedService: "requested_service",
  receivedAt: "received_at",
  requestedDeadlineAt: "requested_deadline_at",
  requestedVisitAt: "requested_visit_at",
  assignedMemberIdentityId: "assigned_member_identity_id",
  nextAction: "next_action",
  notes: "notes",
  status: "status",
  disqualificationReason: "disqualification_reason",
};
function fields(row: Row): CplLeadFields {
  const input: Record<string, unknown> = {};
  for (const key of CPL_LEAD_EDITABLE_FIELDS) {
    const value = row[columns[key]];
    if (value !== undefined) input[key] = value instanceof Date ? value.toISOString() : value;
  }
  return normalizeCplLeadFields(input, undefined, iso(row.created_at));
}
function matchFingerprint(value: CplLeadFields): string {
  return hash(
    [
      value.title,
      value.customerId,
      value.customerName,
      value.contactId,
      value.contactEmail,
      value.contactPhone,
      value.siteId,
      value.siteAddress,
    ].map((item) => (typeof item === "string" ? item.trim().toLowerCase() : item)),
  );
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
  const requestHash = hash(input),
    resource = randomUUID();
  const inserted = await executor.query<Row>(
    "INSERT INTO cpl_workflow_mutations(organization_id,mutation_kind,idempotency_key,request_hash,resource_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING resource_id",
    [access.organizationId, kind, key, requestHash, resource],
  );
  if (inserted.rows[0]) return { id: resource, created: true };
  const prior = await executor.query<Row>(
    "SELECT request_hash,resource_id FROM cpl_workflow_mutations WHERE organization_id=$1 AND mutation_kind=$2 AND idempotency_key=$3 FOR UPDATE",
    [access.organizationId, kind, key],
  );
  if (prior.rows[0]?.request_hash !== requestHash) fail("CPL_IDEMPOTENCY_CONFLICT");
  return { id: String(prior.rows[0].resource_id), created: false };
}
function version(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) fail("CPL_INVALID_INPUT");
}
function permissions(access: CplTenantAccess): CplWorkflowPermissions {
  const write = cplTenantRoleAllows(access.role, "records:write");
  return {
    canCreateLead: write,
    canEditLead: write,
    canReviewLead: cplTenantRoleAllows(access.role, "leads:review"),
    canCreateProposal: write,
    canEditProposal: write,
  };
}

/** Composes only through the existing tenant transaction. No legacy table access. */
export class SqlCplIntakeRepository {
  constructor(private readonly intakeTenants: SqlCplTenantRepository) {}

  protected async protect(executor: SqlExecutor): Promise<void> {
    const result = await executor.query<{ protected: boolean }>(
      "SELECT count(*)=5 AND bool_and(relrowsecurity AND relforcerowsecurity) AS protected FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN ('cpl_customers','cpl_contacts','cpl_sites','cpl_lead_evidence','cpl_lead_review_events')",
    );
    if (result.rows[0]?.protected !== true) fail("CPL_INTAKE_SCHEMA_UNSAFE");
  }
  protected async lockIntake(executor: SqlExecutor, access: CplTenantAccess): Promise<void> {
    // Serialize matching/review decisions and new proposal eligibility per organization.
    // Transaction-scoped locks cannot escape pooled connections.
    await executor.query("SELECT pg_advisory_xact_lock(hashtextextended($1,29))", [
      access.organizationId,
    ]);
  }
  /** Directory names are immutable. Selecting a reference snapshots its fields;
   * ordinary lead corrections never update other leads' shared directory data. */
  private async resolve(
    executor: SqlExecutor,
    access: CplTenantAccess,
    value: CplLeadFields,
    previous?: CplLeadFields,
  ) {
    const result = { ...value };
    const load = async (
      table: "cpl_customers" | "cpl_contacts" | "cpl_sites",
      recordId: string,
    ) => {
      const found = await executor.query<Row>(
        `SELECT * FROM ${table} WHERE organization_id=$1 AND id=$2`,
        [access.organizationId, recordId],
      );
      return found.rows[0] ?? fail("CPL_RECORD_NOT_FOUND");
    };
    if (value.customerId) {
      const customer = await load("cpl_customers", value.customerId);
      if (!previous || previous.customerId !== value.customerId)
        result.customerName = String(customer.name);
    }
    if (value.contactId) {
      const contact = await load("cpl_contacts", value.contactId);
      if (contact.customer_id && contact.customer_id !== value.customerId)
        fail("CPL_REFERENCE_CONFLICT");
      if (!previous || previous.contactId !== value.contactId) {
        result.contactName = String(contact.name);
        result.contactEmail = contact.email == null ? null : String(contact.email);
        result.contactPhone = String(contact.phone);
      }
    }
    if (value.siteId) {
      const site = await load("cpl_sites", value.siteId);
      if (site.customer_id && site.customer_id !== value.customerId) fail("CPL_REFERENCE_CONFLICT");
      if (!previous || previous.siteId !== value.siteId) {
        result.siteName = String(site.name);
        result.siteAddress = String(site.address);
      }
    }
    if (value.assignedMemberIdentityId) {
      const member = await executor.query(
        "SELECT m.identity_id FROM cpl_memberships m JOIN cpl_identities i ON i.id=m.identity_id WHERE m.organization_id=$1 AND m.identity_id=$2 AND m.status='active' AND i.status='active' FOR SHARE OF m,i",
        [access.organizationId, value.assignedMemberIdentityId],
      );
      if (!member.rows[0]) fail("CPL_ASSIGNEE_UNAVAILABLE");
    }
    return result;
  }
  private async candidates(
    executor: SqlExecutor,
    access: CplTenantAccess,
    leadId: string,
    value: CplLeadFields,
  ): Promise<(CplLeadDuplicateCandidate & { version: number })[]> {
    const normalized = (value: string) =>
      value
        .trim()
        .toLowerCase()
        .replace(/[ \t\r\n]+/gu, " ");
    const rows = await executor.query<Row>(
      `SELECT * FROM cpl_workflow_leads WHERE organization_id=$1 AND id<>$2 AND (
      ($3::text IS NOT NULL AND lower(btrim(contact_email))=lower(btrim($3))) OR
      ($4::text<>'' AND regexp_replace(contact_phone,'[^0-9+]','','g')=$4) OR
      ($5::text<>'' AND btrim(regexp_replace(lower(customer_name),'[[:space:]]+',' ','g'))=$5 AND btrim(regexp_replace(lower(title),'[[:space:]]+',' ','g'))=$6) OR
      ($7::text<>'' AND btrim(regexp_replace(lower(site_address),'[[:space:]]+',' ','g'))=$7 AND btrim(regexp_replace(lower(title),'[[:space:]]+',' ','g'))=$6)) ORDER BY id LIMIT 100`,
      [
        access.organizationId,
        leadId,
        value.contactEmail,
        value.contactPhone.replace(/[^0-9+]/gu, ""),
        normalized(value.customerName),
        normalized(value.title),
        normalized(value.siteAddress),
      ],
    );
    return rows.rows
      .map((row) => ({
        leadId: String(row.id),
        version: Number(row.version),
        title: String(row.title),
        reasons: cplLeadMatchReasons(value, fields(row)),
      }))
      .filter((item) => item.reasons.length > 0);
  }
  protected async intakeLead(
    executor: SqlExecutor,
    access: CplTenantAccess,
    row: Row,
  ): Promise<CplWorkflowLead> {
    const value = fields(row),
      leadId = String(row.id);
    const duplicateCandidates = await this.candidates(executor, access, leadId, value);
    const reviews = await executor.query<Row>(
      "SELECT * FROM cpl_lead_review_events WHERE organization_id=$1 AND lead_id=$2 ORDER BY lead_version DESC,created_at DESC,id DESC LIMIT 1",
      [access.organizationId, leadId],
    );
    const review = reviews.rows[0];
    const currentReview =
      duplicateCandidates.length < 100 &&
      review?.match_fingerprint === matchFingerprint(value) &&
      duplicateCandidates.every((candidate) =>
        reviewedCandidates(review.candidate_ids).some(
          (proof) => proof.leadId === candidate.leadId && proof.version === candidate.version,
        ),
      );
    const duplicateReview: CplLeadDuplicateReview = currentReview
      ? {
          disposition: review!.disposition as CplLeadDuplicateReview["disposition"],
          reason: review!.reason == null ? null : String(review!.reason),
          relatedLeadId: review!.related_lead_id == null ? null : String(review!.related_lead_id),
          reviewedAt: iso(review!.created_at),
        }
      : { disposition: "unreviewed", reason: null, relatedLeadId: null, reviewedAt: null };
    const evidence = await executor.query<Row>(
      "SELECT id,kind,label,reference,note,created_at,actor_identity_id FROM cpl_lead_evidence WHERE organization_id=$1 AND lead_id=$2 ORDER BY created_at,id",
      [access.organizationId, leadId],
    );
    let inactiveAssignee = false;
    if (value.assignedMemberIdentityId) {
      const member = await executor.query(
        "SELECT m.identity_id FROM cpl_memberships m JOIN cpl_identities i ON i.id=m.identity_id WHERE m.organization_id=$1 AND m.identity_id=$2 AND m.status='active' AND i.status='active'",
        [access.organizationId, value.assignedMemberIdentityId],
      );
      inactiveAssignee = !member.rows[0];
    }
    return {
      ...value,
      id: leadId,
      organizationId: String(row.organization_id),
      version: Number(row.version),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      duplicateCandidates: duplicateCandidates.map(({ leadId, title, reasons }) => ({
        leadId,
        title,
        reasons,
      })),
      duplicateReview,
      evidence: evidence.rows.map((item) => ({
        id: String(item.id),
        kind: item.kind as CplLeadEvidence["kind"],
        label: String(item.label),
        reference: item.reference == null ? null : String(item.reference),
        note: item.note == null ? null : String(item.note),
        createdAt: iso(item.created_at),
        actorIdentityId: String(item.actor_identity_id),
      })),
      readiness: evaluateCplLeadReadiness(value, {
        inactiveAssignee,
        unresolvedDuplicates:
          duplicateCandidates.length > 0 && duplicateReview.disposition === "unreviewed",
        markedDuplicate: duplicateReview.disposition === "duplicate",
      }),
    };
  }
  protected async intakeLeads(
    executor: SqlExecutor,
    access: CplTenantAccess,
    rows: readonly Row[],
  ) {
    await this.protect(executor);
    const result: CplWorkflowLead[] = [];
    for (const row of rows) result.push(await this.intakeLead(executor, access, row));
    return result;
  }
  /** Existing-source attention only. Caller owns authenticated tenant scope and
   * the intake advisory lock; this never emits or replays a business event. */
  async reconcileAttentionInTransaction(
    executor: SqlExecutor,
    access: CplTenantAccess,
  ): Promise<void> {
    const rows = await executor.query<Row>(
      "SELECT * FROM cpl_workflow_leads WHERE organization_id=$1 AND status IN('new','needs_info','ready_for_proposal') ORDER BY id",
      [access.organizationId],
    );
    for (const row of rows.rows)
      await syncCplLeadAttention(executor, access, await this.intakeLead(executor, access, row));
  }
  protected async intakeDirectory(
    executor: SqlExecutor,
    access: CplTenantAccess,
  ): Promise<CplIntakeDirectory> {
    const customers = await executor.query<Row>(
      "SELECT id,name FROM cpl_customers WHERE organization_id=$1 ORDER BY name,id LIMIT 200",
      [access.organizationId],
    );
    const contacts = await executor.query<Row>(
      "SELECT id,customer_id,name,email,phone FROM cpl_contacts WHERE organization_id=$1 ORDER BY name,id LIMIT 200",
      [access.organizationId],
    );
    const sites = await executor.query<Row>(
      "SELECT id,customer_id,name,address FROM cpl_sites WHERE organization_id=$1 ORDER BY name,id LIMIT 200",
      [access.organizationId],
    );
    const members = await executor.query<Row>(
      "SELECT m.identity_id,i.display_name FROM cpl_memberships m JOIN cpl_identities i ON i.id=m.identity_id WHERE m.organization_id=$1 AND m.status='active' AND i.status='active' ORDER BY i.display_name,m.identity_id LIMIT 200",
      [access.organizationId],
    );
    return {
      customers: customers.rows.map((row) => ({ id: String(row.id), name: String(row.name) })),
      contacts: contacts.rows.map((row) => ({
        id: String(row.id),
        customerId: row.customer_id == null ? null : String(row.customer_id),
        name: String(row.name),
        email: row.email == null ? null : String(row.email),
        phone: String(row.phone),
      })),
      sites: sites.rows.map((row) => ({
        id: String(row.id),
        customerId: row.customer_id == null ? null : String(row.customer_id),
        name: String(row.name),
        address: String(row.address),
      })),
      members: members.rows.map((row) => ({
        identityId: String(row.identity_id),
        displayName: String(row.display_name),
      })),
    };
  }
  protected intakePermissions(access: CplTenantAccess): CplWorkflowPermissions {
    return permissions(access);
  }
  async getIntakeDirectory(request: CplTenantRequest): Promise<CplIntakeDirectory> {
    return this.intakeTenants.withTenantTransaction(
      request,
      "records:read",
      "intake-job-tracker",
      async (executor, access) => {
        await this.protect(executor);
        return this.intakeDirectory(executor, access);
      },
    );
  }
  async createDirectoryEntry(
    request: CplTenantRequest & {
      kind: "customer" | "contact" | "site";
      name: string;
      customerId?: string | null;
      email?: string;
      phone?: string;
      address?: string;
      idempotencyKey: string;
    },
  ) {
    if (!["customer", "contact", "site"].includes(request.kind)) fail("CPL_INVALID_INPUT");
    const value = {
      kind: request.kind,
      name: intakeText(request.name, 240, true),
      customerId: intakeId(request.customerId),
      email: intakeText(request.email ?? "", 254) || null,
      phone: intakeText(request.phone ?? "", 80),
      address: intakeText(request.address ?? "", 2000),
    };
    if (value.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.email)) fail("CPL_INVALID_INPUT");
    if (
      value.kind === "customer" &&
      (value.customerId || value.email || value.phone || value.address)
    )
      fail("CPL_INVALID_INPUT");
    if (value.kind === "contact" && value.address) fail("CPL_INVALID_INPUT");
    if (value.kind === "site" && (value.email || value.phone)) fail("CPL_INVALID_INPUT");
    return this.intakeTenants.withTenantTransaction(
      request,
      "records:write",
      "intake-job-tracker",
      async (executor, access) => {
        await this.protect(executor);
        if (
          value.customerId &&
          !(
            await executor.query(
              "SELECT id FROM cpl_customers WHERE organization_id=$1 AND id=$2",
              [access.organizationId, value.customerId],
            )
          ).rows[0]
        )
          fail("CPL_RECORD_NOT_FOUND");
        const resource = await mutation(
          executor,
          access,
          `directory.${value.kind}`,
          request.idempotencyKey,
          value,
        );
        if (resource.created) {
          if (value.kind === "customer")
            await executor.query(
              "INSERT INTO cpl_customers(id,organization_id,name,created_by_identity_id) VALUES($1,$2,$3,$4)",
              [resource.id, access.organizationId, value.name, access.identityId],
            );
          if (value.kind === "contact")
            await executor.query(
              "INSERT INTO cpl_contacts(id,organization_id,customer_id,name,email,phone,created_by_identity_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
              [
                resource.id,
                access.organizationId,
                value.customerId,
                value.name,
                value.email,
                value.phone,
                access.identityId,
              ],
            );
          if (value.kind === "site")
            await executor.query(
              "INSERT INTO cpl_sites(id,organization_id,customer_id,name,address,created_by_identity_id) VALUES($1,$2,$3,$4,$5,$6)",
              [
                resource.id,
                access.organizationId,
                value.customerId,
                value.name,
                value.address,
                access.identityId,
              ],
            );
          await audit(executor, access, `intake.${value.kind}.created`, resource.id);
        }
        if (value.kind === "customer") return { id: resource.id, name: value.name };
        if (value.kind === "contact")
          return {
            id: resource.id,
            name: value.name,
            customerId: value.customerId,
            email: value.email,
            phone: value.phone,
          };
        return {
          id: resource.id,
          name: value.name,
          customerId: value.customerId,
          address: value.address,
        };
      },
    );
  }
  async createLead(request: CplTenantRequest & LeadInput): Promise<CplWorkflowLead> {
    // Exclude the server-default received time from replay identity, while storing
    // it only on the first accepted request. Repeating an ambiguous POST is stable.
    const sourceReference = intakeText(request.sourceReference ?? "", 2000) || null;
    const evidenceNote = intakeText(request.evidenceNote ?? "", 20_000) || null;
    const normalized = normalizeCplLeadFields(request as unknown as Record<string, unknown>);
    if (normalized.status !== "new") fail("CPL_LEAD_REVIEW_REQUIRED");
    return this.intakeTenants.withTenantTransaction(
      request,
      "records:write",
      "intake-job-tracker",
      async (executor, access) => {
        await this.protect(executor);
        await this.lockIntake(executor, access);
        const value = await this.resolve(executor, access, normalized);
        const resource = await mutation(executor, access, "lead.create", request.idempotencyKey, {
          ...value,
          receivedAt: request.receivedAt ?? null,
          sourceReference,
          evidenceNote,
        });
        if (resource.created) {
          const keys = CPL_LEAD_EDITABLE_FIELDS;
          await executor.query(
            `INSERT INTO cpl_workflow_leads(id,organization_id,created_by_identity_id,${keys.map((key) => columns[key]).join(",")}) VALUES($1,$2,$3,${keys.map((_key, index) => `$${index + 4}`).join(",")})`,
            [
              resource.id,
              access.organizationId,
              access.identityId,
              ...keys.map((key) => value[key]),
            ],
          );
          await executor.query(
            "INSERT INTO cpl_lead_evidence(id,organization_id,lead_id,kind,label,reference,note,capture_json,actor_identity_id) VALUES($1,$2,$3,'initial_capture','Original intake capture',$4,$5,$6::jsonb,$7)",
            [
              randomUUID(),
              access.organizationId,
              resource.id,
              sourceReference,
              evidenceNote ?? value.details,
              JSON.stringify(value),
              access.identityId,
            ],
          );
          await audit(executor, access, "lead.created", resource.id);
        }
        const row = await executor.query<Row>(
          "SELECT * FROM cpl_workflow_leads WHERE organization_id=$1 AND id=$2",
          [access.organizationId, resource.id],
        );
        const lead = await this.intakeLead(executor, access, row.rows[0]!);
        await syncCplLeadAttention(executor, access, lead);
        return lead;
      },
    );
  }
  async listLeads(request: CplTenantRequest): Promise<readonly CplWorkflowLead[]> {
    return this.intakeTenants.withTenantTransaction(
      request,
      "records:read",
      "intake-job-tracker",
      async (executor, access) => {
        const rows = await executor.query<Row>(
          "SELECT * FROM cpl_workflow_leads WHERE organization_id=$1 ORDER BY created_at DESC,id LIMIT 100",
          [access.organizationId],
        );
        return this.intakeLeads(executor, access, rows.rows);
      },
    );
  }
  async getLead(request: CplTenantRequest & { leadId: string }): Promise<CplWorkflowLead> {
    return this.intakeTenants.withTenantTransaction(
      request,
      "records:read",
      "intake-job-tracker",
      async (executor, access) => {
        await this.protect(executor);
        const row = await executor.query<Row>(
          "SELECT * FROM cpl_workflow_leads WHERE organization_id=$1 AND id=$2",
          [access.organizationId, id(request.leadId)],
        );
        if (!row.rows[0]) fail("CPL_RECORD_NOT_FOUND");
        return this.intakeLead(executor, access, row.rows[0]);
      },
    );
  }
  async updateLead(request: CplTenantRequest & EditInput): Promise<CplWorkflowLead> {
    version(request.expectedVersion);
    return this.intakeTenants.withTenantTransaction(
      request,
      "records:read",
      "intake-job-tracker",
      async (executor, access) => {
        await this.protect(executor);
        await this.lockIntake(executor, access);
        const reviewKeys = ["status", "disqualificationReason"];
        const changesIntake = CPL_LEAD_EDITABLE_FIELDS.some(
          (key) => !reviewKeys.includes(key) && request[key] !== undefined,
        );
        const changesReview =
          request.status !== undefined ||
          request.disqualificationReason !== undefined ||
          request.duplicateDisposition !== undefined;
        if (changesIntake && !cplTenantRoleAllows(access.role, "records:write"))
          fail("CPL_ACCESS_DENIED");
        if (changesReview && !cplTenantRoleAllows(access.role, "leads:review"))
          fail("CPL_ACCESS_DENIED");
        if (!changesIntake && !changesReview) fail("CPL_INVALID_INPUT");
        const rows = await executor.query<Row>(
          "SELECT * FROM cpl_workflow_leads WHERE organization_id=$1 AND id=$2 FOR UPDATE",
          [access.organizationId, id(request.leadId)],
        );
        const row = rows.rows[0];
        if (!row) fail("CPL_RECORD_NOT_FOUND");
        if (Number(row.version) !== request.expectedVersion) fail("CPL_LEAD_VERSION_CONFLICT");
        const previous = fields(row),
          value = await this.resolve(
            executor,
            access,
            normalizeCplLeadFields(request as unknown as Record<string, unknown>, previous),
            previous,
          );
        if (request.duplicateDisposition !== undefined) {
          const disposition = request.duplicateDisposition;
          if (!["unreviewed", "distinct", "duplicate"].includes(disposition))
            fail("CPL_INVALID_INPUT");
          const reason =
            intakeText(request.duplicateReason ?? "", 2000, disposition !== "unreviewed") || null;
          const related = intakeId(request.duplicateLeadId);
          const candidates = await this.candidates(executor, access, String(row.id), value);
          if (
            disposition === "duplicate" &&
            (!related || !candidates.some((candidate) => candidate.leadId === related))
          )
            fail("CPL_DUPLICATE_REVIEW_CONFLICT");
          if (disposition !== "duplicate" && related) fail("CPL_INVALID_INPUT");
          await executor.query(
            "INSERT INTO cpl_lead_review_events(id,organization_id,lead_id,lead_version,disposition,reason,related_lead_id,match_fingerprint,candidate_ids,actor_identity_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)",
            [
              randomUUID(),
              access.organizationId,
              row.id,
              request.expectedVersion + 1,
              disposition,
              reason,
              related,
              matchFingerprint(value),
              JSON.stringify(
                candidates.map((candidate) => ({
                  leadId: candidate.leadId,
                  version: candidate.version,
                })),
              ),
              access.identityId,
            ],
          );
        } else if (request.duplicateReason !== undefined || request.duplicateLeadId !== undefined)
          fail("CPL_INVALID_INPUT");
        const keys = CPL_LEAD_EDITABLE_FIELDS;
        const changed = await executor.query<Row>(
          `UPDATE cpl_workflow_leads SET ${keys.map((key, index) => `${columns[key]}=$${index + 4}`).join(",")},version=version+1,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND id=$2 AND version=$3 RETURNING *`,
          [
            access.organizationId,
            row.id,
            request.expectedVersion,
            ...keys.map((key) => value[key]),
          ],
        );
        if (!changed.rows[0]) fail("CPL_LEAD_VERSION_CONFLICT");
        const result = await this.intakeLead(executor, access, changed.rows[0]);
        if (value.status === "ready_for_proposal" && !result.readiness.readyForProposal)
          fail("CPL_LEAD_NOT_READY");
        await audit(
          executor,
          access,
          changesIntake ? "lead.corrected" : "lead.reviewed",
          String(row.id),
        );
        if (changesIntake && changesReview)
          await audit(executor, access, "lead.reviewed", String(row.id));
        if (previous.status !== "ready_for_proposal" && result.status === "ready_for_proposal")
          await emitCplBusinessEvent(executor, access, {
            type: "lead.ready",
            sourceKind: "lead",
            sourceId: result.id,
            sourceVersion: result.version,
            service: result.requestedService,
            title: result.title,
          });
        await syncCplLeadAttention(executor, access, result);
        return result;
      },
    );
  }
  async appendLeadEvidence(
    request: CplTenantRequest & {
      leadId: string;
      expectedVersion: number;
      idempotencyKey: string;
      label: string;
      reference?: string;
      note?: string;
    },
  ): Promise<CplWorkflowLead> {
    version(request.expectedVersion);
    const value = {
      leadId: id(request.leadId),
      label: intakeText(request.label, 240, true),
      reference: intakeText(request.reference ?? "", 2000) || null,
      note: intakeText(request.note ?? "", 20_000) || null,
    };
    if (!value.reference && !value.note) fail("CPL_INVALID_INPUT");
    return this.intakeTenants.withTenantTransaction(
      request,
      "records:write",
      "intake-job-tracker",
      async (executor, access) => {
        await this.protect(executor);
        await this.lockIntake(executor, access);
        const row = (
          await executor.query<Row>(
            "SELECT * FROM cpl_workflow_leads WHERE organization_id=$1 AND id=$2 FOR UPDATE",
            [access.organizationId, value.leadId],
          )
        ).rows[0];
        if (!row) fail("CPL_RECORD_NOT_FOUND");
        const resource = await mutation(
          executor,
          access,
          "lead.evidence",
          request.idempotencyKey,
          value,
        );
        if (resource.created) {
          if (Number(row.version) !== request.expectedVersion) fail("CPL_LEAD_VERSION_CONFLICT");
          await executor.query(
            "INSERT INTO cpl_lead_evidence(id,organization_id,lead_id,kind,label,reference,note,actor_identity_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
            [
              resource.id,
              access.organizationId,
              value.leadId,
              value.reference ? "source_reference" : "note",
              value.label,
              value.reference,
              value.note,
              access.identityId,
            ],
          );
          await executor.query(
            "UPDATE cpl_workflow_leads SET version=version+1,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND id=$2",
            [access.organizationId, value.leadId],
          );
          await audit(executor, access, "lead.evidence.appended", value.leadId);
        }
        return this.intakeLead(
          executor,
          access,
          (
            await executor.query<Row>(
              "SELECT * FROM cpl_workflow_leads WHERE organization_id=$1 AND id=$2",
              [access.organizationId, value.leadId],
            )
          ).rows[0]!,
        );
      },
    );
  }
}
