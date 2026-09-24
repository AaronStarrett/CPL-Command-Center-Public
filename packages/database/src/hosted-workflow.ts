import {
  SqlCplIntakeRepository,
  type CplWorkflowLead,
  type CplIntakeDirectory,
  type CplWorkflowPermissions,
} from "./cpl-intake-repository.js";
export type {
  CplWorkflowLead,
  CplIntakeDirectory,
  CplWorkflowPermissions,
} from "./cpl-intake-repository.js";
import { createHash, randomUUID } from "node:crypto";
import { processCplAutomationJob } from "./cpl-automation-worker.js";
import type { DatabaseAdapter, SqlExecutor } from "./adapter.js";
import {
  SqlCplTenantRepository,
  cplTenantRoleAllows,
  CplTenantAccessError,
  type CplTenantAccess,
  type CplTenantRequest,
} from "./tenant-repository.js";
import { verifyHostedDatabaseRole } from "./hosted-database-role.js";

type Row = Record<string, unknown>;
export interface CplProposalDraft {
  readonly id: string;
  readonly organizationId: string;
  readonly leadId: string;
  readonly title: string;
  readonly content: string;
  readonly status: "draft";
  readonly version: number;
  readonly preparedVersion: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface CplWorkflowJob {
  readonly id: string;
  readonly organizationId: string;
  readonly proposalId: string;
  readonly proposalVersion: number;
  readonly kind: "proposal.prepare";
  readonly status: "queued" | "running" | "completed" | "failed";
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lastErrorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface CplProposalDownload {
  readonly fileName: string;
  readonly contentType: "text/markdown; charset=utf-8";
  readonly content: string;
  readonly sha256: string;
}
export class CplWorkflowError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CplWorkflowError";
  }
}
function fail(code: string): never {
  throw new CplWorkflowError(code);
}
function text(value: unknown, maximum: number, empty = false): string {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    (!empty && !value.trim()) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)
  )
    fail("CPL_INVALID_INPUT");
  return value.replaceAll("\r\n", "\n");
}
function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value))
    fail("CPL_RECORD_NOT_FOUND");
  return value.toLowerCase();
}
function instant(value: unknown): string {
  return new Date(value as string).toISOString();
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function proposal(row: Row): CplProposalDraft {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    leadId: String(row.lead_id),
    title: String(row.title),
    content: String(row.content),
    status: "draft",
    version: Number(row.version),
    preparedVersion: row.prepared_version == null ? null : Number(row.prepared_version),
    createdAt: instant(row.created_at),
    updatedAt: instant(row.updated_at),
  };
}
function job(row: Row): CplWorkflowJob {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    proposalId: String(row.proposal_id),
    proposalVersion: Number(row.proposal_version),
    kind: "proposal.prepare",
    status: row.status as CplWorkflowJob["status"],
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    lastErrorCode: row.last_error_code == null ? null : String(row.last_error_code),
    createdAt: instant(row.created_at),
    updatedAt: instant(row.updated_at),
  };
}
function render(row: Row): CplProposalDownload {
  const content = `# ${String(row.title)}\n\nProposal draft · version ${Number(row.version)}\n\n${String(row.content)}\n\n---\nManually supplied content. This draft has not been sent to a customer.\n`;
  return {
    fileName: `proposal-${String(row.id)}-v${Number(row.version)}.md`,
    contentType: "text/markdown; charset=utf-8",
    content,
    sha256: hash(content),
  };
}
async function audit(
  executor: SqlExecutor,
  access: CplTenantAccess,
  action: string,
  resourceId: string,
) {
  await executor.query(
    "INSERT INTO cpl_tenant_audit_events (id,organization_id,actor_identity_id,action,resource_id) VALUES ($1,$2,$3,$4,$5)",
    [randomUUID(), access.organizationId, access.identityId, action, resourceId],
  );
}
async function idempotentResource(
  executor: SqlExecutor,
  access: CplTenantAccess,
  kind: string,
  key: string,
  input: unknown,
) {
  if (!/^[A-Za-z0-9._:-]{8,128}$/u.test(key)) fail("CPL_INVALID_IDEMPOTENCY_KEY");
  const requestHash = hash(JSON.stringify(input));
  const resourceId = randomUUID();
  const inserted = await executor.query<Row>(
    "INSERT INTO cpl_workflow_mutations (organization_id,mutation_kind,idempotency_key,request_hash,resource_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING resource_id",
    [access.organizationId, kind, key, requestHash, resourceId],
  );
  if (inserted.rows[0]) return { id: resourceId, created: true };
  const prior = await executor.query<Row>(
    "SELECT request_hash,resource_id FROM cpl_workflow_mutations WHERE organization_id=$1 AND mutation_kind=$2 AND idempotency_key=$3 FOR UPDATE",
    [access.organizationId, kind, key],
  );
  if (!prior.rows[0] || prior.rows[0].request_hash !== requestHash)
    fail("CPL_IDEMPOTENCY_CONFLICT");
  return { id: String(prior.rows[0].resource_id), created: false };
}
async function enqueue(executor: SqlExecutor, access: CplTenantAccess, draft: Row) {
  await executor.query(
    "INSERT INTO cpl_workflow_jobs (id,organization_id,proposal_id,proposal_version,issued_by_identity_id,issued_membership_version) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (organization_id,proposal_id,proposal_version,kind) DO NOTHING",
    [
      randomUUID(),
      access.organizationId,
      draft.id,
      draft.version,
      access.identityId,
      access.membershipVersion,
    ],
  );
}

/** All request values originate in authenticated server context; every operation
 * independently revalidates the session, membership, permission and module. */
export class SqlCplWorkflowRepository extends SqlCplIntakeRepository {
  constructor(
    _database: DatabaseAdapter,
    private readonly tenants: SqlCplTenantRepository,
  ) {
    super(tenants);
  }
  async readWorkspace(request: CplTenantRequest): Promise<{
    readonly leads: readonly CplWorkflowLead[];
    readonly proposals: readonly CplProposalDraft[];
    readonly jobs: readonly CplWorkflowJob[];
    readonly intakeDirectory: CplIntakeDirectory;
    readonly permissions: CplWorkflowPermissions;
  }> {
    return this.tenants.withTenantReadTransaction(
      request,
      ["intake-job-tracker", "proposal-builder"],
      async (executor, access) => {
        if (
          !cplTenantRoleAllows(access.role, "leads:read") ||
          !cplTenantRoleAllows(access.role, "commercial:read")
        )
          throw new CplTenantAccessError();
        const leads = await executor.query<Row>(
          "SELECT * FROM cpl_workflow_leads WHERE organization_id=$1 ORDER BY created_at DESC,id LIMIT 100",
          [access.organizationId],
        );
        const proposals = await executor.query<Row>(
          "SELECT * FROM cpl_proposal_drafts WHERE organization_id=$1 AND ($2::uuid IS NULL OR lead_id=$2) ORDER BY created_at DESC,id LIMIT 100",
          [access.organizationId, null],
        );
        const jobs = await executor.query<Row>(
          "SELECT * FROM cpl_workflow_jobs WHERE organization_id=$1 ORDER BY created_at DESC,id LIMIT 100",
          [access.organizationId],
        );
        return {
          leads: await this.intakeLeads(executor, access, leads.rows),
          intakeDirectory: await this.intakeDirectory(executor, access),
          permissions: this.intakePermissions(access),
          proposals: proposals.rows.map(proposal),
          jobs: jobs.rows.map(job),
        };
      },
    );
  }
  async createProposalDraft(
    request: CplTenantRequest & {
      leadId: string;
      title: string;
      content: string;
      idempotencyKey: string;
    },
  ): Promise<CplProposalDraft> {
    const leadId = uuid(request.leadId),
      title = text(request.title, 240).trim(),
      content = text(request.content, 50_000);
    return this.tenants.withTenantTransaction(
      request,
      "commercial:write",
      "proposal-builder",
      async (executor, access) => {
        await this.protect(executor);
        await this.lockIntake(executor, access);
        const parent = await executor.query(
          "SELECT * FROM cpl_workflow_leads WHERE organization_id=$1 AND id=$2 FOR SHARE",
          [access.organizationId, leadId],
        );
        if (!parent.rows[0]) fail("CPL_RECORD_NOT_FOUND");
        if (parent.rows[0].assigned_member_identity_id) {
          const assignee = await executor.query(
            "SELECT m.identity_id FROM cpl_memberships m JOIN cpl_identities i ON i.id=m.identity_id WHERE m.organization_id=$1 AND m.identity_id=$2 AND m.status='active' AND i.status='active' FOR SHARE OF m,i",
            [access.organizationId, parent.rows[0].assigned_member_identity_id],
          );
          if (!assignee.rows[0]) fail("CPL_LEAD_NOT_READY");
        }
        const intake = await this.intakeLead(executor, access, parent.rows[0]);
        if (intake.status !== "ready_for_proposal" || !intake.readiness.readyForProposal)
          fail("CPL_LEAD_NOT_READY");
        const resource = await idempotentResource(
          executor,
          access,
          "proposal.create",
          request.idempotencyKey,
          { leadId, title, content },
        );
        if (resource.created) {
          await executor.query(
            "INSERT INTO cpl_proposal_drafts (id,organization_id,lead_id,title,content,created_by_identity_id) VALUES ($1,$2,$3,$4,$5,$6)",
            [resource.id, access.organizationId, leadId, title, content, access.identityId],
          );
          await audit(executor, access, "proposal.created", resource.id);
        }
        const result = await executor.query<Row>(
          "SELECT * FROM cpl_proposal_drafts WHERE organization_id=$1 AND id=$2",
          [access.organizationId, resource.id],
        );
        if (resource.created) await enqueue(executor, access, result.rows[0]!);
        return proposal(result.rows[0]!);
      },
    );
  }
  async updateProposalDraft(
    request: CplTenantRequest & {
      proposalId: string;
      title: string;
      content: string;
      expectedVersion: number;
    },
  ): Promise<CplProposalDraft> {
    const title = text(request.title, 240).trim(),
      content = text(request.content, 50_000);
    if (!Number.isSafeInteger(request.expectedVersion) || request.expectedVersion < 1)
      fail("CPL_INVALID_INPUT");
    return this.tenants.withTenantTransaction(
      request,
      "commercial:write",
      "proposal-builder",
      async (executor, access) => {
        const result = await executor.query<Row>(
          "UPDATE cpl_proposal_drafts SET title=$3,content=$4,version=version+1,prepared_version=NULL,prepared_sha256=NULL,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND id=$2 AND version=$5 RETURNING *",
          [
            access.organizationId,
            uuid(request.proposalId),
            title,
            content,
            request.expectedVersion,
          ],
        );
        if (!result.rows[0]) fail("CPL_PROPOSAL_VERSION_CONFLICT");
        await enqueue(executor, access, result.rows[0]);
        await audit(executor, access, "proposal.updated", request.proposalId);
        return proposal(result.rows[0]);
      },
    );
  }
  async listProposalDrafts(
    request: CplTenantRequest & { leadId?: string },
  ): Promise<readonly CplProposalDraft[]> {
    const leadId = request.leadId === undefined ? null : uuid(request.leadId);
    return this.tenants.withTenantTransaction(
      request,
      "commercial:read",
      "proposal-builder",
      async (executor, access) =>
        (
          await executor.query<Row>(
            "SELECT * FROM cpl_proposal_drafts WHERE organization_id=$1 AND ($2::uuid IS NULL OR lead_id=$2) ORDER BY created_at DESC,id LIMIT 100",
            [access.organizationId, leadId],
          )
        ).rows.map(proposal),
    );
  }
  async getProposalDraft(
    request: CplTenantRequest & { proposalId: string },
  ): Promise<CplProposalDraft> {
    return this.tenants.withTenantTransaction(
      request,
      "commercial:read",
      "proposal-builder",
      async (executor, access) => {
        const result = await executor.query<Row>(
          "SELECT * FROM cpl_proposal_drafts WHERE organization_id=$1 AND id=$2",
          [access.organizationId, uuid(request.proposalId)],
        );
        if (!result.rows[0]) fail("CPL_RECORD_NOT_FOUND");
        return proposal(result.rows[0]);
      },
    );
  }
  async listJobs(request: CplTenantRequest): Promise<readonly CplWorkflowJob[]> {
    return this.tenants.withTenantTransaction(
      request,
      "commercial:read",
      "proposal-builder",
      async (executor, access) =>
        (
          await executor.query<Row>(
            "SELECT * FROM cpl_workflow_jobs WHERE organization_id=$1 ORDER BY created_at DESC,id LIMIT 100",
            [access.organizationId],
          )
        ).rows.map(job),
    );
  }
  async downloadProposal(
    request: CplTenantRequest & { proposalId: string },
  ): Promise<CplProposalDownload> {
    return this.tenants.withTenantTransaction(
      request,
      "commercial:read",
      "proposal-builder",
      async (executor, access) => {
        const result = await executor.query<Row>(
          "SELECT * FROM cpl_proposal_drafts WHERE organization_id=$1 AND id=$2 FOR SHARE",
          [access.organizationId, uuid(request.proposalId)],
        );
        const row = result.rows[0];
        if (!row) fail("CPL_RECORD_NOT_FOUND");
        const rendered = render(row);
        if (
          Number(row.prepared_version) !== Number(row.version) ||
          row.prepared_sha256 !== rendered.sha256
        )
          fail("CPL_PROPOSAL_NOT_READY");
        await audit(executor, access, "proposal.downloaded", request.proposalId);
        return rendered;
      },
    );
  }
}

export interface CplHostedJobResult {
  claimed: number;
  completed: number;
  retried: number;
  failed: number;
  skipped?: number;
  executionId?: string;
}
/** A distinct scheduler login executes one bounded durable job. Authority comes
 * from its stored tenant context. Ingestion provider access additionally requires
 * explicit server composition and live fences; no request selects an adapter. */
export async function processHostedJobs(
  database: DatabaseAdapter,
  options: {
    claimOwner: string;
    limit?: number;
    ingestion?: import("./cpl-integration-ports.js").CplIntegrationRepositoryOptions;
  },
): Promise<CplHostedJobResult> {
  if ((options.limit ?? 1) !== 1 || !/^[A-Za-z0-9._:-]{1,120}$/u.test(options.claimOwner))
    fail("CPL_INVALID_JOB_INVOCATION");
  if (database.kind !== "postgres") throw new Error("CPL_HOSTED_POSTGRES_REQUIRED");
  const result: CplHostedJobResult = { claimed: 0, completed: 0, retried: 0, failed: 0 };
  const leaseToken = randomUUID();
  const claimed = await database.transaction<(Row & { exhausted: boolean }) | null>(
    async (executor) => {
      await verifyHostedDatabaseRole(database, "worker", executor);
      const selected = await executor.query<Row>(
        "SELECT id,organization_id,kind,attempts,max_attempts FROM cpl_workflow_jobs WHERE (status IN ('queued','retrying') AND available_at<=CURRENT_TIMESTAMP) OR (status='running' AND lease_expires_at<=CURRENT_TIMESTAMP) ORDER BY available_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1",
      );
      const row = selected.rows[0];
      if (!row) return null;
      if (Number(row.attempts) >= Number(row.max_attempts)) {
        if (row.kind === "inbound.receipt.process" || row.kind === "integration.gmail.sync") {
          // Fence an exhausted crash recovery before touching source status. Do
          // not acquire the organization lock while holding the dispatch lock.
          const exhausted = await executor.query<Row>(
            "UPDATE cpl_workflow_jobs SET status='running',revision=revision+1,lease_token=$2,lease_owner=$3,lease_expires_at=clock_timestamp()+INTERVAL '30 seconds',updated_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *",
            [row.id, leaseToken, options.claimOwner],
          );
          return { ...exhausted.rows[0]!, exhausted: true };
        }
        if (row.kind === "automation.recipe") {
          await executor.query("SELECT set_config('cpl.organization_id',$1,true)", [
            row.organization_id,
          ]);
          await executor.query(
            "UPDATE cpl_automation_attempts SET status='failed',finished_at=CURRENT_TIMESTAMP,error_code='CPL_JOB_RETRY_EXHAUSTED' WHERE organization_id=$1 AND execution_id=$2 AND status='running'",
            [row.organization_id, row.id],
          );
        }
        await executor.query(
          "UPDATE cpl_workflow_jobs SET status='failed',last_error_code='CPL_JOB_RETRY_EXHAUSTED',lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=$1",
          [row.id],
        );
        return { ...row, exhausted: true };
      }
      const updated = await executor.query<Row>(
        "UPDATE cpl_workflow_jobs SET status='running',revision=revision+1,attempts=attempts+1,lease_token=$2,lease_owner=$3,lease_expires_at=CURRENT_TIMESTAMP+INTERVAL '30 seconds',updated_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING id,organization_id,kind,proposal_id,proposal_version,issued_by_identity_id,issued_membership_version,attempts,max_attempts,integration_source_id,integration_generation,integration_configuration_version,inbound_receipt_id",
        [row.id, leaseToken, options.claimOwner],
      );
      if (row.kind === "automation.recipe") {
        await executor.query("SELECT set_config('cpl.organization_id',$1,true)", [
          row.organization_id,
        ]);
        await executor.query(
          "UPDATE cpl_automation_attempts SET status='retrying',finished_at=CURRENT_TIMESTAMP,error_code='CPL_JOB_LEASE_EXPIRED' WHERE organization_id=$1 AND execution_id=$2 AND status='running'",
          [row.organization_id, row.id],
        );
        await executor.query(
          "INSERT INTO cpl_automation_attempts(organization_id,execution_id,attempt,status) VALUES($1,$2,$3,'running')",
          [row.organization_id, row.id, updated.rows[0]!.attempts],
        );
      }
      return { ...updated.rows[0]!, exhausted: false };
    },
  );
  if (!claimed) return result;
  result.claimed = 1;
  if (claimed.exhausted) {
    if (claimed.kind === "inbound.receipt.process" || claimed.kind === "integration.gmail.sync") {
      const { failExhaustedCplIngestionJob } = await import("./cpl-ingestion-worker.js");
      await failExhaustedCplIngestionJob(database, claimed, leaseToken);
    }
    result.failed = 1;
    return result;
  }
  if (claimed.kind === "automation.recipe") {
    const outcome = await processCplAutomationJob(database, claimed, leaseToken);
    result.executionId = String(claimed.id);
    if (outcome === "completed") result.completed = 1;
    else if (outcome === "retrying") result.retried = 1;
    else if (outcome === "skipped") result.skipped = 1;
    else result.failed = 1;
    return result;
  }
  if (claimed.kind === "inbound.receipt.process" || claimed.kind === "integration.gmail.sync") {
    const { processCplIngestionJob } = await import("./cpl-ingestion-worker.js");
    const outcome = await processCplIngestionJob(database, claimed, leaseToken, options.ingestion);
    if (outcome === "completed") result.completed = 1;
    else if (outcome === "retrying") result.retried = 1;
    else if (outcome === "skipped") result.skipped = 1;
    else result.failed = 1;
    return result;
  }
  if (claimed.kind !== "proposal.prepare") fail("CPL_INVALID_JOB_INVOCATION");
  try {
    await database.transaction(async (executor) => {
      await executor.query(
        "SELECT set_config('cpl.organization_id',$1,true),set_config('cpl.identity_id',$2,true)",
        [claimed.organization_id, claimed.issued_by_identity_id],
      );
      const fence = await executor.query<Row>(
        "SELECT id FROM cpl_workflow_jobs WHERE organization_id=$1 AND id=$2 AND status='running' AND lease_token=$3 AND lease_expires_at>CURRENT_TIMESTAMP FOR UPDATE",
        [claimed.organization_id, claimed.id, leaseToken],
      );
      if (!fence.rows[0]) fail("CPL_JOB_LEASE_LOST");
      // A draft can be locked by an editor while membership or entitlement is
      // revoked. Acquire it before reading live authorization, then make the
      // preparation mutation itself conditional on that authorization.
      const drafts = await executor.query<Row>(
        "SELECT id,title,content,version FROM cpl_proposal_drafts WHERE organization_id=$1 AND id=$2 FOR UPDATE",
        [claimed.organization_id, claimed.proposal_id],
      );
      const draft = drafts.rows[0];
      if (!draft) fail("CPL_RECORD_NOT_FOUND");
      const access = await executor.query<Row>(
        "SELECT m.role,m.version FROM cpl_memberships m JOIN cpl_organizations o ON o.id=m.organization_id JOIN cpl_identities i ON i.id=m.identity_id JOIN cpl_module_entitlements e ON e.organization_id=m.organization_id AND e.module_key='proposal-builder' WHERE m.organization_id=$1 AND m.identity_id=$2 AND m.status='active' AND i.status='active' AND o.status='active' AND e.enabled=TRUE AND (e.usage_limit IS NULL OR e.usage_limit>0) AND m.role IN ('owner','admin','manager','member','field-user')",
        [claimed.organization_id, claimed.issued_by_identity_id],
      );
      if (
        !access.rows[0] ||
        Number(access.rows[0].version) !== Number(claimed.issued_membership_version)
      )
        fail("CPL_JOB_AUTHORIZATION_REVOKED");
      const rendered = render(draft);
      if (Number(draft.version) === Number(claimed.proposal_version)) {
        const prepared = await executor.query(
          `UPDATE cpl_proposal_drafts SET prepared_version=version,prepared_sha256=$3
           WHERE organization_id=$1 AND id=$2 AND EXISTS (
             SELECT 1 FROM cpl_memberships m JOIN cpl_organizations o ON o.id=m.organization_id
             JOIN cpl_identities i ON i.id=m.identity_id JOIN cpl_module_entitlements e ON e.organization_id=m.organization_id AND e.module_key='proposal-builder'
             WHERE m.organization_id=$1 AND m.identity_id=$4 AND m.version=$5
               AND m.status='active' AND i.status='active' AND o.status='active'
               AND e.enabled=TRUE AND (e.usage_limit IS NULL OR e.usage_limit>0)
               AND m.role IN ('owner','admin','manager','member','field-user')) RETURNING id`,
          [
            claimed.organization_id,
            claimed.proposal_id,
            rendered.sha256,
            claimed.issued_by_identity_id,
            claimed.issued_membership_version,
          ],
        );
        if (prepared.rowCount !== 1) fail("CPL_JOB_AUTHORIZATION_REVOKED");
      }
      await executor.query(
        "UPDATE cpl_workflow_jobs SET status='completed',result_sha256=$4,last_error_code=NULL,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND id=$2 AND lease_token=$3",
        [claimed.organization_id, claimed.id, leaseToken, rendered.sha256],
      );
      await audit(
        executor,
        {
          organizationId: String(claimed.organization_id),
          identityId: String(claimed.issued_by_identity_id),
          role: access.rows[0].role as CplTenantAccess["role"],
          membershipVersion: Number(access.rows[0].version),
        },
        Number(draft.version) === Number(claimed.proposal_version)
          ? "proposal.prepared"
          : "proposal.preparation-superseded",
        String(claimed.proposal_id),
      );
    });
    result.completed = 1;
  } catch (error) {
    const code = error instanceof CplWorkflowError ? error.code : "CPL_JOB_PROCESSING_FAILED";
    if (code === "CPL_JOB_LEASE_LOST") throw error;
    const terminal =
      code === "CPL_JOB_AUTHORIZATION_REVOKED" ||
      code === "CPL_RECORD_NOT_FOUND" ||
      Number(claimed.attempts) >= Number(claimed.max_attempts);
    const changed = await database.query(
      "UPDATE cpl_workflow_jobs SET status=$3,last_error_code=$4,available_at=CURRENT_TIMESTAMP+INTERVAL '1 minute',lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND lease_token=$2 AND status='running'",
      [claimed.id, leaseToken, terminal ? "failed" : "queued", code],
    );
    if (changed.rowCount !== 1) fail("CPL_JOB_LEASE_LOST");
    if (terminal) result.failed = 1;
    else result.retried = 1;
  }
  return result;
}
