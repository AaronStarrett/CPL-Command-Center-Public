import { createHash, randomUUID } from "node:crypto";
import { cplExecutionId, cplExecutionRevision } from "@bea/domain/cpl-execution";
import { cplFieldObject, cplFieldText, type CplFieldAnswer } from "@bea/domain/cpl-field";
import type { CplCommercialProjectSnapshot } from "@bea/domain/cpl-commercial";
import {
  cplDeliveryInstant,
  cplDeliverySelection,
  normalizeCplDeliveryInput,
  normalizeCplCloseoutPolicy,
  normalizeCplCloseoutFacts,
  normalizeCplManualDelivery,
  type CplDeliveryInput,
  type CplDeliveryPackage,
  type CplDeliveryState,
  type CplDeliveryAttachment,
  type CplDeliveryApprovedOption,
  type CplDeliveryPermissions,
  type CplDeliveryWorkspace,
  type CplCloseoutPolicy,
  type CplCloseoutPolicyInput,
  type CplCloseoutFacts,
  type CplCloseoutFactsInput,
  type CplCloseoutReadiness,
  type CplCloseoutFactKey,
  type CplCloseoutCheck,
  type CplCloseoutIssue,
} from "@bea/domain/cpl-delivery";
import type { SqlExecutor } from "./adapter.js";
import { emitCplBusinessEvent } from "./cpl-business-events.js";
import {
  CplTenantAccessError,
  cplTenantRoleAllows,
  type CplTenantAccess,
  type CplTenantRequest,
  type SqlCplTenantRepository,
} from "./tenant-repository.js";

type Row = Record<string, unknown>;
type ProjectRequest = CplTenantRequest & { projectId: string };
type PackageRequest = ProjectRequest & { packageId: string };
type EditRequest = PackageRequest & { expectedRevision: number; idempotencyKey: string };
type Parent = {
  row: Row;
  snapshot: CplCommercialProjectSnapshot;
  status: string;
  operationalRevision: number;
};
const TABLES =
  "'cpl_delivery_packages','cpl_delivery_versions','cpl_delivery_attachments','cpl_delivery_events','cpl_report_approval_withdrawals','cpl_closeout_policies','cpl_closeout_facts','cpl_closeout_overrides','cpl_delivery_mutations'";
function fail(code: string): never {
  throw new CplTenantAccessError(code);
}
function json<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}
function iso(value: unknown): string {
  return new Date(value instanceof Date ? value.getTime() : String(value)).toISOString();
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
function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
function permissions(a: CplTenantAccess): CplDeliveryPermissions {
  return {
    canWrite: cplTenantRoleAllows(a.role, "delivery:write"),
    canConfirm: cplTenantRoleAllows(a.role, "delivery:confirm"),
    canConfigure: cplTenantRoleAllows(a.role, "delivery:configure"),
    canOverride: cplTenantRoleAllows(a.role, "delivery:override"),
    canWithdrawApproval: cplTenantRoleAllows(a.role, "reports:review"),
  };
}
function requirePermission(a: CplTenantAccess, key: keyof CplDeliveryPermissions) {
  if (!permissions(a)[key]) fail("CPL_ACCESS_DENIED");
}
function active(p: Parent) {
  if (p.status === "cancelled" || p.status === "on_hold") fail("CPL_DELIVERY_PROJECT_UNAVAILABLE");
}
function attachment(row: Row): CplDeliveryAttachment {
  return {
    reportId: String(row.report_id),
    version: Number(row.version),
    reference: String(row.reference),
    title: String(row.title),
    sha256: String(row.sha256),
    byteLength: Number(row.byte_length),
    approvedAt: iso(row.approved_at),
  };
}
function policy(row: Row): CplCloseoutPolicy {
  return {
    ...json<CplCloseoutPolicyInput>(row.snapshot),
    version: Number(row.version),
    createdAt: iso(row.created_at),
    createdByIdentityId: String(row.created_by_identity_id),
  };
}
/** Only called after same-transaction tenant authorization. The shared project
 * lock also serializes approval withdrawal, field changes and delayed actions. */
async function protect(e: SqlExecutor, a: CplTenantAccess, write: boolean) {
  const p = await e.query<Row>(
    `SELECT count(*)=9 AND bool_and(relrowsecurity AND relforcerowsecurity) AS protected FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN (${TABLES})`,
  );
  if (p.rows[0]?.protected !== true) fail("CPL_DELIVERY_SCHEMA_UNSAFE");
  await e.query(
    write
      ? "SELECT pg_advisory_xact_lock(hashtextextended($1,31))"
      : "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,31))",
    [a.organizationId],
  );
}
async function parent(e: SqlExecutor, a: CplTenantAccess, projectId: string): Promise<Parent> {
  const r = await e.query<Row>(
    "SELECT p.*,o.status AS operational_status,o.revision AS operational_revision FROM cpl_commercial_projects p LEFT JOIN cpl_project_operations o ON (o.organization_id,o.project_id)=(p.organization_id,p.id) WHERE p.organization_id=$1 AND p.id=$2",
    [a.organizationId, cplExecutionId(projectId)],
  );
  const row = r.rows[0] ?? fail("CPL_RECORD_NOT_FOUND");
  return {
    row,
    snapshot: json<CplCommercialProjectSnapshot>(row.snapshot),
    status: String(row.operational_status ?? "active"),
    operationalRevision: Number(row.operational_revision ?? 0),
  };
}
async function mutation(
  e: SqlExecutor,
  a: CplTenantAccess,
  kind: string,
  key: string,
  input: unknown,
  resourceId: string = randomUUID(),
) {
  const idempotencyKey = cplFieldText(key, 200, true),
    requestHash = hash(input);
  const old = await e.query<Row>(
    "SELECT resource_id,request_hash FROM cpl_delivery_mutations WHERE organization_id=$1 AND mutation_kind=$2 AND idempotency_key=$3",
    [a.organizationId, kind, idempotencyKey],
  );
  if (old.rows[0]) {
    if (old.rows[0].request_hash !== requestHash) fail("CPL_IDEMPOTENCY_CONFLICT");
    return { id: String(old.rows[0].resource_id), replay: true };
  }
  await e.query(
    "INSERT INTO cpl_delivery_mutations(organization_id,mutation_kind,idempotency_key,request_hash,resource_id) VALUES($1,$2,$3,$4,$5)",
    [a.organizationId, kind, idempotencyKey, requestHash, resourceId],
  );
  return { id: resourceId, replay: false };
}
async function audit(e: SqlExecutor, a: CplTenantAccess, action: string, resourceId: string) {
  await e.query(
    "INSERT INTO cpl_tenant_audit_events(id,organization_id,actor_identity_id,action,resource_id) VALUES($1,$2,$3,$4,$5)",
    [randomUUID(), a.organizationId, a.identityId, action, resourceId],
  );
}
async function event(
  e: SqlExecutor,
  a: CplTenantAccess,
  projectId: string,
  packageId: string,
  version: number,
  action: string,
  details: Row,
) {
  await e.query(
    "INSERT INTO cpl_delivery_events(id,organization_id,project_id,package_id,version,action,details,actor_identity_id) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)",
    [
      randomUUID(),
      a.organizationId,
      projectId,
      packageId,
      version,
      action,
      JSON.stringify({
        ...details,
        origin: a.automationExecutionId ? "automation" : "human",
        automationExecutionId: a.automationExecutionId ?? null,
      }),
      a.identityId,
    ],
  );
  await audit(e, a, `delivery.${action}`, packageId);
}
async function approved(
  e: SqlExecutor,
  a: CplTenantAccess,
  projectId: string,
): Promise<CplDeliveryApprovedOption[]> {
  const rows = await e.query<Row>(
    `SELECT a.*,r.reference,r.current_version,v.snapshot->'content'->>'title' AS title,w.reason AS withdrawal_reason
    FROM cpl_report_artifacts a JOIN cpl_reports r ON (r.organization_id,r.id)=(a.organization_id,a.report_id)
    JOIN cpl_report_versions v ON (v.organization_id,v.report_id,v.version)=(a.organization_id,a.report_id,a.version)
    LEFT JOIN cpl_report_approval_withdrawals w ON (w.organization_id,w.report_id,w.version)=(a.organization_id,a.report_id,a.version)
    WHERE a.organization_id=$1 AND a.project_id=$2 ORDER BY a.approved_at DESC,a.report_id,a.version DESC`,
    [a.organizationId, projectId],
  );
  return rows.rows.map((r) => ({
    ...attachment(r),
    withdrawn: r.withdrawal_reason != null,
    withdrawalReason: r.withdrawal_reason == null ? null : String(r.withdrawal_reason),
    latestEditableVersion: Number(r.current_version),
  }));
}
async function selections(
  e: SqlExecutor,
  a: CplTenantAccess,
  projectId: string,
  input: CplDeliveryInput,
): Promise<CplDeliveryAttachment[]> {
  const options = await approved(e, a, projectId);
  return input.attachments.map((s) => {
    const found = options.find((x) => x.reportId === s.reportId && x.version === s.version);
    if (!found) fail("CPL_DELIVERY_APPROVED_ARTIFACT_REQUIRED");
    if (found.withdrawn) fail("CPL_DELIVERY_APPROVAL_WITHDRAWN");
    return {
      reportId: found.reportId,
      version: found.version,
      reference: found.reference,
      title: found.title,
      sha256: found.sha256,
      byteLength: found.byteLength,
      approvedAt: found.approvedAt,
    };
  });
}
async function appendVersion(
  e: SqlExecutor,
  a: CplTenantAccess,
  projectId: string,
  packageId: string,
  version: number,
  input: CplDeliveryInput,
  attachments: CplDeliveryAttachment[],
) {
  await e.query(
    "INSERT INTO cpl_delivery_versions(organization_id,project_id,package_id,version,snapshot,prepared_by_identity_id) VALUES($1,$2,$3,$4,$5::jsonb,$6)",
    [
      a.organizationId,
      projectId,
      packageId,
      version,
      JSON.stringify({ input, attachments }),
      a.identityId,
    ],
  );
  for (const [index, att] of attachments.entries())
    await e.query(
      "INSERT INTO cpl_delivery_attachments(organization_id,project_id,package_id,package_version,report_id,report_version,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [a.organizationId, projectId, packageId, version, att.reportId, att.version, index],
    );
}
async function load(
  e: SqlExecutor,
  a: CplTenantAccess,
  projectId: string,
  packageId: string,
): Promise<CplDeliveryPackage> {
  const rows = await e.query<Row>(
    "SELECT * FROM cpl_delivery_packages WHERE organization_id=$1 AND project_id=$2 AND id=$3",
    [a.organizationId, projectId, cplExecutionId(packageId)],
  );
  const row = rows.rows[0] ?? fail("CPL_RECORD_NOT_FOUND");
  const events = (
    await e.query<Row>(
      "SELECT * FROM cpl_delivery_events WHERE organization_id=$1 AND project_id=$2 AND package_id=$3 ORDER BY created_at,id",
      [a.organizationId, projectId, packageId],
    )
  ).rows.map((r) => ({
    id: String(r.id),
    version: Number(r.version),
    action: String(r.action),
    actorIdentityId: String(r.actor_identity_id),
    createdAt: iso(r.created_at),
    details: json<Row>(r.details),
  }));
  const states: Record<string, CplDeliveryState> = {
    ready: "ready",
    exported: "exported",
    manually_sent: "manually_sent",
    acknowledged: "acknowledged",
  };
  const versions = (
    await e.query<Row>(
      "SELECT * FROM cpl_delivery_versions WHERE organization_id=$1 AND project_id=$2 AND package_id=$3 ORDER BY version",
      [a.organizationId, projectId, packageId],
    )
  ).rows.map((r) => {
    const value = json<{ input: CplDeliveryInput; attachments: CplDeliveryAttachment[] }>(
      r.snapshot,
    );
    const version = Number(r.version);
    // Transitions are monotonic within one immutable version; UUID ordering is
    // never used to decide truth when transaction timestamps are equal.
    let state: CplDeliveryState = "draft";
    for (const name of ["ready", "exported", "manually_sent", "acknowledged"] as const)
      if (events.some((x) => x.version === version && states[x.action] === name)) state = name;
    return {
      version,
      input: value.input,
      attachments: value.attachments,
      preparedByIdentityId: String(r.prepared_by_identity_id),
      preparedAt: iso(r.prepared_at),
      state,
    };
  });
  const current =
    versions.find((v) => v.version === Number(row.current_version)) ??
    fail("CPL_DELIVERY_INVALID_STATE");
  const options = await approved(e, a, projectId),
    p = await parent(e, a, projectId),
    reasons: string[] = [];
  if (p.status === "cancelled" || p.status === "on_hold")
    reasons.push("Project is cancelled or on hold.");
  if (!current.input.recipient) reasons.push("Recipient details are missing.");
  for (const att of current.attachments) {
    const option = options.find((o) => o.reportId === att.reportId && o.version === att.version);
    if (!option || option.sha256 !== att.sha256 || option.withdrawn)
      reasons.push(`Approval for ${att.reference} v${att.version} is unavailable or withdrawn.`);
  }
  const canMarkReady = row.state === "draft" && reasons.length === 0;
  if (row.state === "draft") reasons.push("Recipient and package have not been confirmed ready.");
  return {
    id: String(row.id),
    projectId,
    reference: String(row.reference),
    revision: Number(row.revision),
    currentVersion: Number(row.current_version),
    state: row.state as CplDeliveryState,
    versions,
    events,
    readiness: { ready: reasons.length === 0, canMarkReady, reasons },
  };
}
async function create(
  e: SqlExecutor,
  a: CplTenantAccess,
  projectId: string,
  input: CplDeliveryInput,
  idempotencyKey: string,
): Promise<CplDeliveryPackage> {
  requirePermission(a, "canWrite");
  const p = await parent(e, a, projectId);
  const m = await mutation(e, a, "package.create", idempotencyKey, { projectId, input });
  if (!m.replay) {
    active(p);
    const attachments = await selections(e, a, projectId, input);
    const reference = `DEL-${m.id.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    await e.query(
      "INSERT INTO cpl_delivery_packages(organization_id,project_id,id,reference,revision,current_version,state,created_by_identity_id) VALUES($1,$2,$3,$4,1,1,'draft',$5)",
      [a.organizationId, projectId, m.id, reference, a.identityId],
    );
    await appendVersion(e, a, projectId, m.id, 1, input, attachments);
    await event(e, a, projectId, m.id, 1, "prepared", {});
  }
  return load(e, a, projectId, m.id);
}

export class SqlCplDeliveryRepository {
  constructor(private readonly tenants: SqlCplTenantRepository) {}
  private scope<T>(
    request: CplTenantRequest,
    write: boolean,
    operation: (e: SqlExecutor, a: CplTenantAccess) => Promise<T>,
  ): Promise<T> {
    return this.tenants.withTenantReadTransaction(
      request,
      ["award-to-project-launcher", "field-report-assembler"],
      async (e, a) => {
        if (a.role === "field-user") fail("CPL_ACCESS_DENIED");
        await protect(e, a, write);
        return operation(e, a);
      },
    );
  }
  async workspace(request: ProjectRequest): Promise<CplDeliveryWorkspace> {
    return this.scope(request, false, (e, a) =>
      this.workspaceInTransaction(e, a, cplExecutionId(request.projectId)),
    );
  }
  async getPackage(request: PackageRequest): Promise<CplDeliveryPackage> {
    return this.scope(request, false, (e, a) =>
      load(e, a, cplExecutionId(request.projectId), cplExecutionId(request.packageId)),
    );
  }
  /** Trusted worker composition: caller holds verified worker lease, live
   * sponsor/member/module authorization, and recipe/source locks in THIS transaction. */
  async prepareFromApprovedReportInTransaction(
    e: SqlExecutor,
    a: CplTenantAccess,
    input: { projectId: string; reportId: string; version: number; idempotencyKey: string },
  ): Promise<CplDeliveryPackage> {
    await protect(e, a, true);
    const projectId = cplExecutionId(input.projectId),
      selected = cplDeliverySelection(input),
      p = await parent(e, a, projectId);
    const options = await approved(e, a, projectId),
      report = options.find(
        (x) => x.reportId === selected.reportId && x.version === selected.version,
      );
    if (!report || report.withdrawn) fail("CPL_DELIVERY_APPROVED_ARTIFACT_REQUIRED");
    const f = p.snapshot.version.sourceLead.fields;
    return create(
      e,
      a,
      projectId,
      normalizeCplDeliveryInput({
        customerName: f.customerName,
        contactName: f.contactName,
        recipient: f.contactEmail ?? "",
        subject: `${report.title} — ${report.reference} v${report.version}`.slice(0, 240),
        message: `Please find the approved report attached.`,
        attachments: [selected],
      }),
      input.idempotencyKey,
    );
  }
  async createPackage(
    request: ProjectRequest & { input: unknown; idempotencyKey: string },
  ): Promise<CplDeliveryPackage> {
    const input = normalizeCplDeliveryInput(request.input),
      projectId = cplExecutionId(request.projectId);
    return this.scope(request, true, (e, a) =>
      create(e, a, projectId, input, request.idempotencyKey),
    );
  }
  async savePackage(request: EditRequest & { input: unknown }): Promise<CplDeliveryPackage> {
    return this.edit(request, false);
  }
  async revisePackage(
    request: EditRequest & { input: unknown; reason: string },
  ): Promise<CplDeliveryPackage> {
    return this.edit(request, true);
  }
  private async edit(
    request: EditRequest & { input: unknown; reason?: string },
    revision: boolean,
  ): Promise<CplDeliveryPackage> {
    const input = normalizeCplDeliveryInput(request.input),
      expected = cplExecutionRevision(request.expectedRevision),
      note = revision ? cplFieldText(request.reason, 2000, true) : "";
    return this.scope(request, true, async (e, a) => {
      requirePermission(a, "canWrite");
      const projectId = cplExecutionId(request.projectId),
        packageId = cplExecutionId(request.packageId);
      const p = await parent(e, a, projectId);
      active(p);
      const m = await mutation(
        e,
        a,
        revision ? "package.revise" : "package.save",
        request.idempotencyKey,
        { projectId, packageId, expected, input, note },
        packageId,
      );
      let pkg = await load(e, a, projectId, packageId);
      if (m.replay) return pkg;
      if (pkg.revision !== expected) fail("CPL_DELIVERY_REVISION_CONFLICT");
      if (!revision && ["manually_sent", "acknowledged"].includes(pkg.state))
        fail("CPL_DELIVERY_EXPLICIT_REVISION_REQUIRED");
      const attachments = await selections(e, a, projectId, input),
        next = pkg.currentVersion + 1;
      await appendVersion(e, a, projectId, packageId, next, input, attachments);
      await e.query(
        "UPDATE cpl_delivery_packages SET revision=revision+1,current_version=$4,state='draft',updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND project_id=$2 AND id=$3",
        [a.organizationId, projectId, packageId, next],
      );
      await event(e, a, projectId, packageId, next, revision ? "revised" : "saved", {
        reason: note,
        previousVersion: pkg.currentVersion,
        readyConfirmationInvalidated: true,
      });
      pkg = await load(e, a, projectId, packageId);
      return pkg;
    });
  }
  private async transition(
    request: EditRequest,
    action: "ready" | "exported" | "manually_sent" | "acknowledged",
    details: Row,
  ): Promise<CplDeliveryPackage> {
    return this.scope(request, true, async (e, a) => {
      requirePermission(a, action === "exported" ? "canWrite" : "canConfirm");
      const projectId = cplExecutionId(request.projectId),
        packageId = cplExecutionId(request.packageId),
        expected = cplExecutionRevision(request.expectedRevision);
      const m = await mutation(
        e,
        a,
        `package.${action}`,
        request.idempotencyKey,
        { projectId, packageId, expected, details },
        packageId,
      );
      const pkg = await load(e, a, projectId, packageId);
      if (m.replay) return pkg;
      if (pkg.revision !== expected) fail("CPL_DELIVERY_REVISION_CONFLICT");
      const current = pkg.versions.find((v) => v.version === pkg.currentVersion)!;
      if (action === "acknowledged") {
        if (pkg.state !== "manually_sent") fail("CPL_DELIVERY_INVALID_STATE");
        const sent = pkg.events.find(
          (x) => x.version === pkg.currentVersion && x.action === "manually_sent",
        );
        if (
          !sent ||
          Date.parse(String(details.acknowledgedAt)) < Date.parse(String(sent.details.sentAt))
        )
          fail("CPL_DELIVERY_INVALID_EVIDENCE");
      } else {
        active(await parent(e, a, projectId));
        const fresh = await selections(e, a, projectId, current.input);
        if (hash(fresh) !== hash(current.attachments)) fail("CPL_DELIVERY_ARTIFACT_CHANGED");
        if (!current.input.recipient) fail("CPL_DELIVERY_RECIPIENT_REQUIRED");
        if (action === "ready" && pkg.state !== "draft") fail("CPL_DELIVERY_INVALID_STATE");
        if (action !== "ready" && !["ready", "exported"].includes(pkg.state))
          fail("CPL_DELIVERY_NOT_READY");
        if (action === "manually_sent") {
          if (details.recipient !== current.input.recipient) fail("CPL_DELIVERY_RECIPIENT_CHANGED");
          if (Date.parse(String(details.sentAt)) < Date.parse(current.preparedAt))
            fail("CPL_DELIVERY_INVALID_EVIDENCE");
        }
      }
      await event(e, a, projectId, packageId, pkg.currentVersion, action, details);
      await e.query(
        "UPDATE cpl_delivery_packages SET revision=revision+1,state=$4,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND project_id=$2 AND id=$3",
        [a.organizationId, projectId, packageId, action],
      );
      if (action === "manually_sent") {
        const p = await parent(e, a, projectId);
        await emitCplBusinessEvent(e, a, {
          type: "delivery.recorded",
          sourceKind: "delivery",
          sourceId: packageId,
          sourceVersion: pkg.currentVersion,
          projectId,
          service: p.snapshot.version.sourceLead.fields.requestedService,
          title: current.input.subject,
        });
      }
      return load(e, a, projectId, packageId);
    });
  }
  async markReady(
    request: EditRequest & { recipientConfirmed: boolean },
  ): Promise<CplDeliveryPackage> {
    if (request.recipientConfirmed !== true) fail("CPL_DELIVERY_RECIPIENT_CONFIRMATION_REQUIRED");
    return this.transition(request, "ready", { recipientConfirmed: true });
  }
  async recordExport(request: EditRequest): Promise<CplDeliveryPackage> {
    return this.transition(request, "exported", { disclosure: "Export does not mean sent." });
  }
  async recordSent(request: EditRequest & { input: unknown }): Promise<CplDeliveryPackage> {
    return this.transition(request, "manually_sent", {
      ...normalizeCplManualDelivery(request.input),
      providerReceipt: false,
    });
  }
  async acknowledge(request: EditRequest & { input: unknown }): Promise<CplDeliveryPackage> {
    const input = cplFieldObject(request.input);
    return this.transition(request, "acknowledged", {
      acknowledgedAt: cplDeliveryInstant(input.acknowledgedAt),
      evidence: cplFieldText(input.evidence, 2000, true),
      providerReceipt: false,
    });
  }
  async withdrawApproval(
    request: ProjectRequest & {
      reportId: string;
      version: number;
      reason: string;
      idempotencyKey: string;
    },
  ): Promise<CplDeliveryWorkspace> {
    const selected = cplDeliverySelection(request),
      reason = cplFieldText(request.reason, 2000, true);
    return this.scope(request, true, async (e, a) => {
      requirePermission(a, "canWithdrawApproval");
      const projectId = cplExecutionId(request.projectId);
      await parent(e, a, projectId);
      const m = await mutation(e, a, "approval.withdraw", request.idempotencyKey, {
        projectId,
        ...selected,
        reason,
      });
      if (!m.replay) {
        const artifact = (await approved(e, a, projectId)).find(
          (x) => x.reportId === selected.reportId && x.version === selected.version,
        );
        if (!artifact) fail("CPL_DELIVERY_APPROVED_ARTIFACT_REQUIRED");
        if (artifact.withdrawn) fail("CPL_DELIVERY_APPROVAL_ALREADY_WITHDRAWN");
        await e.query(
          "INSERT INTO cpl_report_approval_withdrawals(organization_id,project_id,report_id,version,reason,actor_identity_id) VALUES($1,$2,$3,$4,$5,$6)",
          [a.organizationId, projectId, selected.reportId, selected.version, reason, a.identityId],
        );
        await audit(e, a, "report.approval-withdrawn", selected.reportId);
      }
      return this.workspaceInTransaction(e, a, projectId);
    });
  }
  async attachment(
    request: PackageRequest & { version: number; reportId: string; reportVersion: number },
  ) {
    const version = cplExecutionRevision(request.version),
      selected = cplDeliverySelection({
        reportId: request.reportId,
        version: request.reportVersion,
      });
    return this.scope(request, false, async (e, a) => {
      const projectId = cplExecutionId(request.projectId),
        packageId = cplExecutionId(request.packageId);
      const pkg = await load(e, a, projectId, packageId);
      const bound = pkg.versions
        .find((v) => v.version === version)
        ?.attachments.find(
          (x) => x.reportId === selected.reportId && x.version === selected.version,
        );
      if (!bound) fail("CPL_RECORD_NOT_FOUND");
      const result = await e.query<Row>(
        "SELECT a.object_id,a.sha256,a.byte_length FROM cpl_delivery_attachments d JOIN cpl_report_artifacts a ON (a.organization_id,a.report_id,a.version)=(d.organization_id,d.report_id,d.report_version) WHERE d.organization_id=$1 AND d.project_id=$2 AND d.package_id=$3 AND d.package_version=$4 AND d.report_id=$5 AND d.report_version=$6",
        [a.organizationId, projectId, packageId, version, selected.reportId, selected.version],
      );
      const row = result.rows[0] ?? fail("CPL_RECORD_NOT_FOUND");
      if (row.sha256 !== bound.sha256 || Number(row.byte_length) !== bound.byteLength)
        fail("CPL_DELIVERY_ARTIFACT_CHANGED");
      return {
        organizationId: a.organizationId,
        objectId: String(row.object_id),
        sha256: bound.sha256,
        byteLength: bound.byteLength,
      };
    });
  }
  async savePolicy(
    request: ProjectRequest & { expectedVersion: number; input: unknown; idempotencyKey: string },
  ): Promise<CplDeliveryWorkspace> {
    const input = normalizeCplCloseoutPolicy(request.input),
      expected = cplExecutionRevision(request.expectedVersion);
    return this.scope(request, true, async (e, a) => {
      requirePermission(a, "canConfigure");
      const projectId = cplExecutionId(request.projectId);
      await parent(e, a, projectId);
      const m = await mutation(e, a, "policy.save", request.idempotencyKey, {
        projectId,
        expected,
        input,
      });
      if (!m.replay) {
        const current = await e.query<Row>(
          "SELECT version FROM cpl_closeout_policies WHERE organization_id=$1 AND service_key=$2 ORDER BY version DESC LIMIT 1",
          [a.organizationId, input.serviceKey],
        );
        if (Number(current.rows[0]?.version ?? 0) !== expected)
          fail("CPL_DELIVERY_REVISION_CONFLICT");
        await e.query(
          "INSERT INTO cpl_closeout_policies(organization_id,service_key,version,snapshot,created_by_identity_id) VALUES($1,$2,$3,$4::jsonb,$5)",
          [a.organizationId, input.serviceKey, expected + 1, JSON.stringify(input), a.identityId],
        );
        await audit(e, a, "closeout.policy-saved", m.id);
      }
      return this.workspaceInTransaction(e, a, projectId);
    });
  }
  async saveCloseoutFacts(
    request: ProjectRequest & { expectedRevision: number; input: unknown; idempotencyKey: string },
  ): Promise<CplDeliveryWorkspace> {
    const input = normalizeCplCloseoutFacts(request.input),
      expected = cplExecutionRevision(request.expectedRevision);
    return this.scope(request, true, async (e, a) => {
      requirePermission(a, "canConfirm");
      const projectId = cplExecutionId(request.projectId);
      await parent(e, a, projectId);
      const m = await mutation(e, a, "facts.save", request.idempotencyKey, {
        projectId,
        expected,
        input,
      });
      if (!m.replay) {
        const current = await this.facts(e, a, projectId);
        if (current.revision !== expected) fail("CPL_DELIVERY_REVISION_CONFLICT");
        if (
          current.manualIssues.some((old) => !input.manualIssues.some((next) => next.id === old.id))
        )
          fail("CPL_CLOSEOUT_ISSUE_DISPOSITION_REQUIRED");
        if (
          input.requiredReport &&
          !(await approved(e, a, projectId)).some(
            (x) =>
              x.reportId === input.requiredReport!.reportId &&
              x.version === input.requiredReport!.version &&
              !x.withdrawn,
          )
        )
          fail("CPL_DELIVERY_APPROVED_ARTIFACT_REQUIRED");
        const issues = await this.issues(e, a, projectId, { ...input, revision: expected + 1 });
        for (const d of input.issueDispositions)
          if (!issues.some((x) => x.sourceKey === d.sourceKey && x.factHash === d.factHash))
            fail("CPL_CLOSEOUT_ISSUE_CHANGED");
        await e.query(
          "INSERT INTO cpl_closeout_facts(organization_id,project_id,revision,snapshot,created_by_identity_id) VALUES($1,$2,$3,$4::jsonb,$5)",
          [a.organizationId, projectId, expected + 1, JSON.stringify(input), a.identityId],
        );
        await audit(e, a, "closeout.facts-saved", projectId);
      }
      return this.workspaceInTransaction(e, a, projectId);
    });
  }
  async overrideReadiness(
    request: ProjectRequest & {
      key: CplCloseoutFactKey;
      evidenceHash: string;
      active: boolean;
      reason: string;
      idempotencyKey: string;
    },
  ): Promise<CplDeliveryWorkspace> {
    const reason = cplFieldText(request.reason, 2000, true);
    if (
      typeof request.active !== "boolean" ||
      typeof request.evidenceHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(request.evidenceHash)
    )
      fail("CPL_DELIVERY_INVALID_INPUT");
    return this.scope(request, true, async (e, a) => {
      requirePermission(a, "canOverride");
      const projectId = cplExecutionId(request.projectId);
      const m = await mutation(e, a, "readiness.override", request.idempotencyKey, {
        projectId,
        key: request.key,
        evidenceHash: request.evidenceHash,
        active: request.active,
        reason,
      });
      if (!m.replay) {
        const current = await this.workspaceInTransaction(e, a, projectId),
          check = current.readiness.checks.find((c) => c.key === request.key);
        if (!check || !check.required || check.met || check.evidenceHash !== request.evidenceHash)
          fail("CPL_CLOSEOUT_EVIDENCE_CHANGED");
        await e.query(
          "INSERT INTO cpl_closeout_overrides(id,organization_id,project_id,fact_key,evidence_hash,active,reason,actor_identity_id,revision) SELECT $1,$2,$3,$4,$5,$6,$7,$8,COALESCE(MAX(revision),0)+1 FROM cpl_closeout_overrides WHERE organization_id=$2 AND project_id=$3",
          [
            m.id,
            a.organizationId,
            projectId,
            request.key,
            request.evidenceHash,
            request.active,
            reason,
            a.identityId,
          ],
        );
        await audit(
          e,
          a,
          request.active ? "closeout.override-recorded" : "closeout.override-revoked",
          projectId,
        );
      }
      return this.workspaceInTransaction(e, a, projectId);
    });
  }
  private async facts(
    e: SqlExecutor,
    a: CplTenantAccess,
    projectId: string,
  ): Promise<CplCloseoutFacts> {
    const rows = await e.query<Row>(
      "SELECT * FROM cpl_closeout_facts WHERE organization_id=$1 AND project_id=$2 ORDER BY revision DESC LIMIT 1",
      [a.organizationId, projectId],
    );
    return rows.rows[0]
      ? {
          ...json<CplCloseoutFactsInput>(rows.rows[0].snapshot),
          revision: Number(rows.rows[0].revision),
        }
      : {
          revision: 0,
          purchaseOrder: "",
          requiredReport: null,
          issueDispositions: [],
          manualIssues: [],
        };
  }
  private async issues(
    e: SqlExecutor,
    a: CplTenantAccess,
    projectId: string,
    facts: CplCloseoutFacts,
  ): Promise<CplCloseoutIssue[]> {
    const result: CplCloseoutIssue[] = [];
    const rows = await e.query<Row>(
      "SELECT r.visit_id,r.revision,r.answers,v.snapshot->>'purpose' AS title,t.snapshot AS template FROM cpl_field_records r JOIN cpl_project_visits v ON (v.organization_id,v.id)=(r.organization_id,r.visit_id) JOIN cpl_field_templates t ON (t.organization_id,t.id,t.version)=(r.organization_id,r.template_id,r.template_version) WHERE r.organization_id=$1 AND r.project_id=$2 AND v.status<>'cancelled' ORDER BY r.visit_id",
      [a.organizationId, projectId],
    );
    for (const row of rows.rows)
      for (const answer of json<CplFieldAnswer[]>(row.answers))
        if (answer.result === "issue") {
          const sourceKey = `checklist:${row.visit_id}:${answer.itemId}`,
            factHash = hash({ revision: Number(row.revision), answer });
          const d = facts.issueDispositions.find(
            (x) => x.sourceKey === sourceKey && x.factHash === factHash,
          );
          const template = json<{ sections: { items: { id: string; label: string }[] }[] }>(
            row.template,
          );
          const label =
            template.sections.flatMap((s) => s.items).find((x) => x.id === answer.itemId)?.label ??
            "Checklist issue";
          result.push({
            sourceKey,
            factHash,
            title: `${label} — ${String(row.title ?? "Visit")}`,
            disposed: !!d,
            reason: d?.reason ?? null,
          });
        }
    const observations = await e.query<Row>(
      "SELECT o.id,o.revision,o.snapshot FROM cpl_field_observations o JOIN cpl_project_visits v ON (v.organization_id,v.id)=(o.organization_id,o.visit_id) WHERE o.organization_id=$1 AND o.project_id=$2 AND v.status<>'cancelled' ORDER BY o.id",
      [a.organizationId, projectId],
    );
    for (const row of observations.rows) {
      const s = json<Row>(row.snapshot);
      if (!String(s.followUp ?? "").trim()) continue;
      const sourceKey = `observation:${row.id}`,
        factHash = hash({ revision: Number(row.revision), followUp: s.followUp }),
        d = facts.issueDispositions.find(
          (x) => x.sourceKey === sourceKey && x.factHash === factHash,
        );
      result.push({
        sourceKey,
        factHash,
        title: String(s.title),
        disposed: !!d,
        reason: d?.reason ?? null,
      });
    }
    for (const issue of facts.manualIssues)
      result.push({
        sourceKey: `manual:${issue.id}`,
        factHash: hash(issue),
        title: issue.title,
        disposed: issue.status !== "open",
        reason: issue.reason || null,
      });
    return result;
  }
  /** Shared transaction-only evaluation. Never stores a permanently latched ready flag. */
  async workspaceInTransaction(
    e: SqlExecutor,
    a: CplTenantAccess,
    projectId: string,
  ): Promise<CplDeliveryWorkspace> {
    const p = await parent(e, a, projectId),
      f = p.snapshot.version.sourceLead.fields;
    const project = {
      id: projectId,
      reference: String(p.row.reference),
      name: p.snapshot.version.content.title,
      customerName: f.customerName,
      serviceKey: f.requestedService,
      contactName: f.contactName,
      contactEmail: f.contactEmail,
    };
    const approvedReports = await approved(e, a, projectId);
    const packageRows = await e.query<Row>(
      "SELECT id FROM cpl_delivery_packages WHERE organization_id=$1 AND project_id=$2 ORDER BY created_at,id",
      [a.organizationId, projectId],
    );
    const packages: CplDeliveryPackage[] = [];
    for (const row of packageRows.rows) packages.push(await load(e, a, projectId, String(row.id)));
    const policies = (
      await e.query<Row>(
        "SELECT DISTINCT ON(service_key) * FROM cpl_closeout_policies WHERE organization_id=$1 ORDER BY service_key,version DESC",
        [a.organizationId],
      )
    ).rows.map(policy);
    const selectedPolicy =
      policies.find((x) => x.serviceKey === project.serviceKey) ??
      policies.find((x) => x.serviceKey === "*") ??
      null;
    const facts = await this.facts(e, a, projectId),
      issues = await this.issues(e, a, projectId, facts);
    const visits = (
      await e.query<Row>(
        "SELECT id,revision,status FROM cpl_project_visits WHERE organization_id=$1 AND project_id=$2 ORDER BY id",
        [a.organizationId, projectId],
      )
    ).rows;
    const operationalCompletion =
      visits.length > 0 &&
      visits.filter((x) => x.status !== "cancelled").length > 0 &&
      visits.every((x) => ["completed", "cancelled"].includes(String(x.status)));
    const required = facts.requiredReport;
    const requiredArtifact = required
      ? approvedReports.find(
          (x) => x.reportId === required.reportId && x.version === required.version,
        )
      : undefined;
    const sentVersions = packages.flatMap((pkg) =>
      pkg.versions
        .filter((v) => ["manually_sent", "acknowledged"].includes(v.state))
        .map((v) => ({ packageId: pkg.id, version: v.version, attachments: v.attachments })),
    );
    const deliveryRecorded =
      !!requiredArtifact &&
      !requiredArtifact.withdrawn &&
      sentVersions.some((v) =>
        v.attachments.some(
          (x) =>
            x.reportId === requiredArtifact.reportId &&
            x.version === requiredArtifact.version &&
            x.sha256 === requiredArtifact.sha256,
        ),
      );
    const po = facts.purchaseOrder || p.snapshot.award.purchaseOrder;
    const definitions: {
      key: CplCloseoutFactKey;
      required: boolean;
      met: boolean;
      message: string;
      evidence: unknown;
    }[] = [
      {
        key: "award",
        required: selectedPolicy?.requireAward ?? false,
        met: !!p.row.award_id,
        message: "Immutable awarded agreement is linked.",
        evidence: { awardId: p.row.award_id, proposalVersion: p.row.proposal_version },
      },
      {
        key: "work",
        required: selectedPolicy?.requireWorkCompleted ?? false,
        met: operationalCompletion,
        message: operationalCompletion
          ? "Non-cancelled visits are completed."
          : "Required work is incomplete or no work is recorded.",
        evidence: { visits, projectStatus: p.status, projectRevision: p.operationalRevision },
      },
      {
        key: "report",
        required: selectedPolicy?.requireApprovedReport ?? false,
        met: !!requiredArtifact && !requiredArtifact.withdrawn,
        message:
          requiredArtifact && !requiredArtifact.withdrawn
            ? "Selected exact report version remains approved."
            : "Select a valid approved report version.",
        evidence: { required, artifact: requiredArtifact ?? null },
      },
      {
        key: "delivery",
        required: selectedPolicy?.requireDelivery ?? false,
        met: deliveryRecorded,
        message: deliveryRecorded
          ? "Manual delivery was recorded for the selected approved version."
          : "Manual delivery has not been recorded for the selected approved version.",
        evidence: { required, withdrawn: requiredArtifact?.withdrawn ?? null, sentVersions },
      },
      {
        key: "purchase_order",
        required: selectedPolicy?.requirePurchaseOrder ?? false,
        met: !!po,
        message: po
          ? "Purchase-order/reference details are recorded."
          : "Purchase-order/reference details are missing.",
        evidence: { purchaseOrder: po },
      },
      {
        key: "issues",
        required: selectedPolicy?.requireIssuesDisposed ?? false,
        met: issues.every((x) => x.disposed),
        message: issues.every((x) => x.disposed)
          ? "Relevant recorded issues have a human disposition."
          : "Recorded issues still need an authorized disposition.",
        evidence: { issues },
      },
    ];
    const overrideRows = (
      await e.query<Row>(
        "SELECT * FROM cpl_closeout_overrides WHERE organization_id=$1 AND project_id=$2 ORDER BY revision DESC",
        [a.organizationId, projectId],
      )
    ).rows;
    const checks: CplCloseoutCheck[] = definitions.map((d) => {
      const evidenceHash = hash({
        policy: selectedPolicy
          ? { serviceKey: selectedPolicy.serviceKey, version: selectedPolicy.version }
          : null,
        key: d.key,
        evidence: d.evidence,
      });
      const override = overrideRows.find(
        (x) => x.fact_key === d.key && x.evidence_hash === evidenceHash,
      );
      return {
        key: d.key,
        required: d.required,
        met: d.met,
        message: d.message,
        evidenceHash,
        override:
          override?.active === true
            ? {
                reason: String(override.reason),
                actorIdentityId: String(override.actor_identity_id),
                createdAt: iso(override.created_at),
              }
            : null,
      };
    });
    const readiness: CplCloseoutReadiness = {
      status: !selectedPolicy
        ? "not_configured"
        : ["cancelled", "on_hold"].includes(p.status) ||
            checks.some((x) => x.required && !x.met && !x.override)
          ? "blocked"
          : "ready",
      policy: selectedPolicy,
      projectStatus: p.status,
      operationalCompletion,
      deliveryRecorded,
      agreedAmount: {
        label: "Agreed amount",
        amountMinor: p.snapshot.award.amountMinor,
        currency: p.snapshot.award.currency,
        proposalReference: p.snapshot.proposalReference,
        proposalVersion: Number(p.row.proposal_version),
      },
      checks,
      issues,
      facts: { ...facts, purchaseOrder: po },
      evaluatedAt: new Date().toISOString(),
      invoiceIssued: "not_tracked",
      paymentReceived: "not_tracked",
    };
    return { project, approvedReports, packages, policies, readiness, permissions: permissions(a) };
  }
}
