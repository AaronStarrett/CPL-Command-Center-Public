import { createHash, randomUUID } from "node:crypto";
import {
  CplIntegrationError,
  type CplIntegrationErrorCode,
  type InquiryForm,
  type FormInput,
  type MappingVersion,
  type PageInput,
} from "@bea/domain/cpl-integrations";
import {
  applyCplInboundMapping,
  inboundCanonical,
  inboundId,
  inboundInteger,
  inboundKey,
} from "@bea/domain/cpl-inbound";
import { CPL_EXECUTION_TIME_ZONE, cplExecutionTimeZone } from "@bea/domain/cpl-execution";
import type { MappingInput } from "@bea/domain/cpl-integrations";
import type { DatabaseAdapter, SqlExecutor } from "./adapter.js";
import { companyJson, companyIso, auditCplCompany } from "./cpl-company-data.js";
import {
  SqlCplTenantRepository,
  type CplTenantAccess,
  type CplTenantRequest,
  type CplTenantPermission,
} from "./tenant-repository.js";
import type { CplIntegrationRepositoryOptions } from "./cpl-integration-ports.js";
export type IntegrationRow = Record<string, unknown>;
/** Preview, processing and explicit reprocessing share the same date convention. */
export async function mapCplInboundForOrganization(
  e: SqlExecutor,
  organizationId: string,
  mapping: MappingInput,
  sample: Record<string, unknown>,
) {
  const settings = await e.query<{ value_json: unknown }>(
    "SELECT value_json FROM cpl_organization_settings WHERE organization_id=$1 AND setting_key='company.profile'",
    [organizationId],
  );
  const configured = settings.rows[0]
    ? integrationJson<{ timeZone?: unknown }>(settings.rows[0].value_json).timeZone
    : undefined;
  const timeZone =
    configured === undefined ? CPL_EXECUTION_TIME_ZONE : cplExecutionTimeZone(configured);
  return applyCplInboundMapping(mapping, sample, timeZone);
}
export const CPL_INBOUND_RETENTION_LIMITS = Object.freeze({
  receipts: 25000,
  bytes: 256 * 1024 * 1024,
});
/** Call after deduplication and under the organization integration lock. Never
 * evicts originals; both form and Gmail capture share this admission ceiling. */
export async function assertCplInboundCapacity(
  e: SqlExecutor,
  organizationId: string,
  additionalBytes: number,
): Promise<void> {
  if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 1 || additionalBytes > 4194304)
    integrationFail("CPL_INTEGRATION_INPUT_TOO_LARGE");
  const r = await e.query<{ count: string; bytes: string }>(
    "SELECT count(*) AS count,COALESCE(sum(octet_length(original_bytes)),0) AS bytes FROM cpl_inbound_originals WHERE organization_id=$1",
    [organizationId],
  );
  if (
    Number(r.rows[0]!.count) >= CPL_INBOUND_RETENTION_LIMITS.receipts ||
    Number(r.rows[0]!.bytes) + additionalBytes > CPL_INBOUND_RETENTION_LIMITS.bytes
  )
    integrationFail("CPL_INTEGRATION_STORAGE_LIMIT");
}
export const integrationHash = (value: unknown) =>
  createHash("sha256").update(inboundCanonical(value)).digest("hex");
export const integrationBytesHash = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export function integrationFail(code: CplIntegrationErrorCode): never {
  throw new CplIntegrationError(code);
}
export const integrationJson = companyJson;
export const integrationIso = companyIso;
export async function lockIntegration(e: SqlExecutor, org: string) {
  await e.query("SELECT pg_advisory_xact_lock(hashtextextended($1,38))", [org]);
}
export async function integrationSource(
  e: SqlExecutor,
  org: string,
  id: string,
  kind?: "form" | "gmail",
): Promise<IntegrationRow> {
  const r = await e.query<IntegrationRow>(
    "SELECT s.*,v.input FROM cpl_integration_sources s JOIN cpl_integration_source_versions v ON v.organization_id=s.organization_id AND v.source_id=s.id AND v.version=s.configuration_version WHERE s.organization_id=$1 AND s.id=$2",
    [org, inboundId(id)],
  );
  const row = r.rows[0];
  if (!row || (kind && row.kind !== kind)) integrationFail("CPL_INTEGRATION_NOT_FOUND");
  return row;
}
export async function integrationMapping(
  e: SqlExecutor,
  org: string,
  id: string,
  version: number,
): Promise<MappingVersion> {
  const r = await e.query<IntegrationRow>(
    "SELECT * FROM cpl_inbound_mapping_versions WHERE organization_id=$1 AND id=$2 AND version=$3",
    [org, inboundId(id), inboundInteger(version, 1, 1000000)],
  );
  const row = r.rows[0];
  if (!row) integrationFail("CPL_INTEGRATION_MAPPING_INVALID");
  return {
    id: String(row.id),
    version: Number(row.version),
    input: companyJson(row.input),
    createdAt: companyIso(row.created_at),
    createdByIdentityId: String(row.created_by_identity_id),
  };
}
export async function integrationMutation<T>(
  e: SqlExecutor,
  a: CplTenantAccess,
  kind: string,
  key: string,
  input: unknown,
  action: () => Promise<T>,
): Promise<T> {
  const hash = integrationHash(input);
  const r = await e.query<IntegrationRow>(
    "SELECT request_hash,result FROM cpl_integration_mutations WHERE organization_id=$1 AND kind=$2 AND idempotency_key=$3",
    [a.organizationId, kind, inboundKey(key)],
  );
  if (r.rows[0]) {
    if (r.rows[0].request_hash !== hash) integrationFail("CPL_IDEMPOTENCY_CONFLICT");
    return companyJson<T>(r.rows[0].result);
  }
  const result = await action();
  await e.query(
    "INSERT INTO cpl_integration_mutations(organization_id,kind,idempotency_key,request_hash,result) VALUES($1,$2,$3,$4,$5::jsonb)",
    [a.organizationId, kind, key, hash, JSON.stringify(result)],
  );
  return result;
}
export async function integrationEvent(
  e: SqlExecutor,
  a: CplTenantAccess,
  row: IntegrationRow,
  action: string,
  reason = "",
) {
  await e.query(
    "INSERT INTO cpl_integration_events(organization_id,source_id,id,action,actor_identity_id,revision,generation,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      a.organizationId,
      row.id,
      randomUUID(),
      action,
      a.identityId,
      row.revision,
      row.generation,
      reason,
    ],
  );
  await auditCplCompany(
    e,
    a,
    action,
    "integration",
    String(row.id),
    Number(row.revision),
    "Integration configuration or source processing changed.",
  );
}
export async function integrationVersion(
  e: SqlExecutor,
  a: CplTenantAccess,
  id: string,
  version: number,
  input: unknown,
) {
  await e.query(
    "INSERT INTO cpl_integration_source_versions(organization_id,source_id,version,input,configured_by_identity_id,authorized_membership_version) VALUES($1,$2,$3,$4::jsonb,$5,$6)",
    [a.organizationId, id, version, JSON.stringify(input), a.identityId, a.membershipVersion],
  );
}
export async function mapInquiryForm(e: SqlExecutor, row: IntegrationRow): Promise<InquiryForm> {
  const key = await e.query<IntegrationRow>(
    "SELECT key_id,key_generation FROM cpl_integration_credentials WHERE organization_id=$1 AND source_id=$2 AND purpose='signed_intake_key'",
    [row.organization_id, row.id],
  );
  return {
    id: String(row.id),
    publicId: String(row.public_id),
    revision: Number(row.revision),
    generation: Number(row.generation),
    enabled: row.state === "active",
    configurationVersion: Number(row.configuration_version),
    input: companyJson<FormInput>(row.input),
    configuredByIdentityId: String(row.configured_by_identity_id),
    configuredMembershipVersion: Number(row.authorized_membership_version),
    signedSource: {
      enabled: !!key.rows[0],
      keyId: key.rows[0] ? String(key.rows[0].key_id) : null,
      generation: Number(key.rows[0]?.key_generation ?? 0),
    },
  };
}
export function integrationPage(input: PageInput) {
  const limit = input.limit === undefined ? 25 : inboundInteger(input.limit, 1, 100);
  let cursor: string | null = null;
  if (input.cursor !== undefined) {
    if (!/^[A-Za-z0-9_-]{1,200}$/u.test(input.cursor)) integrationFail("CPL_INBOUND_INVALID_INPUT");
    cursor = inboundId(Buffer.from(input.cursor, "base64url").toString("utf8"));
  }
  return { limit, cursor, next: (id: string) => Buffer.from(id).toString("base64url") };
}
export class CplIntegrationStore {
  constructor(
    protected readonly database: DatabaseAdapter,
    protected readonly tenants: SqlCplTenantRepository,
    protected readonly options: CplIntegrationRepositoryOptions = {},
  ) {}
  protected transaction<T>(
    request: CplTenantRequest,
    permission: CplTenantPermission,
    run: (e: SqlExecutor, a: CplTenantAccess) => Promise<T>,
  ): Promise<T> {
    return this.tenants.withTenantTransaction(
      request,
      permission,
      "intake-job-tracker",
      async (e, a) => {
        await lockIntegration(e, a.organizationId);
        return run(e, a);
      },
    );
  }
}
