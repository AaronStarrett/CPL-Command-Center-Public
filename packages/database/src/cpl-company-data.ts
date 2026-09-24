import { randomUUID } from "node:crypto";
import {
  normalizeCplIntakePolicy,
  type CplCatalogItem,
  type CplCatalogSnapshot,
  type CplCompanySetting,
  type CplDirectoryEntry,
  type CplDirectoryKind,
  type CplIntakePolicy,
} from "@bea/domain/cpl-company";
import type { SqlExecutor } from "./adapter.js";
import type { CplTenantAccess } from "./tenant-repository.js";

export type CompanyRow = Record<string, unknown>;
export const companyJson = <T>(value: unknown): T =>
  (typeof value === "string" ? JSON.parse(value) : value) as T;
export const companyIso = (value: unknown) => new Date(value as string).toISOString();
export const directoryTables = {
  customer: "cpl_customers",
  contact: "cpl_contacts",
  site: "cpl_sites",
} as const;
export async function readCplIntakePolicy(
  e: SqlExecutor,
  organizationId: string,
): Promise<CplCompanySetting<CplIntakePolicy>> {
  const r = await e.query<CompanyRow>(
    "SELECT value_json,version FROM cpl_organization_settings WHERE organization_id=$1 AND setting_key='company.intake-policy'",
    [organizationId],
  );
  return r.rows[0]
    ? {
        version: Number(r.rows[0].version),
        input: normalizeCplIntakePolicy(companyJson(r.rows[0].value_json)),
      }
    : { version: 0, input: { requiredFields: [], customFields: [] } };
}
export function mapCplCatalog(row: CompanyRow): CplCatalogItem {
  return {
    ...companyJson<CplCatalogSnapshot>(row.snapshot),
    id: String(row.id),
    organizationId: String(row.organization_id),
    revision: Number(row.revision),
    status: row.status as CplCatalogItem["status"],
    createdAt: companyIso(row.created_at),
    updatedAt: companyIso(row.updated_at),
  };
}
export async function readCplCatalog(
  e: SqlExecutor,
  organizationId: string,
  id: string,
): Promise<CplCatalogItem | null> {
  const r = await e.query<CompanyRow>(
    "SELECT * FROM cpl_catalog_items WHERE organization_id=$1 AND id=$2",
    [organizationId, id],
  );
  return r.rows[0] ? mapCplCatalog(r.rows[0]) : null;
}
export function catalogSnapshot(item: CplCatalogItem): CplCatalogSnapshot {
  const { id, revision, code, name, description, unit, unitPriceMinor, currency, workflowKey } =
    item;
  return { id, revision, code, name, description, unit, unitPriceMinor, currency, workflowKey };
}
export function mapCplDirectory(kind: CplDirectoryKind, row: CompanyRow): CplDirectoryEntry {
  const snapshot = row.current_snapshot
    ? companyJson<CplDirectoryEntry>(row.current_snapshot)
    : null;
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    kind,
    name: snapshot?.name ?? String(row.name),
    customerId: snapshot
      ? snapshot.customerId
      : row.customer_id == null
        ? null
        : String(row.customer_id),
    email: snapshot ? snapshot.email : row.email == null ? null : String(row.email),
    phone: snapshot?.phone ?? String(row.phone ?? ""),
    address: snapshot?.address ?? String(row.address ?? ""),
    revision: Number(row.current_revision ?? 1),
    status: (row.current_status ?? "active") as CplDirectoryEntry["status"],
    createdAt: companyIso(row.created_at),
    updatedAt: companyIso(row.current_updated_at ?? row.created_at),
  };
}
export async function readCplDirectory(
  e: SqlExecutor,
  organizationId: string,
  kind: CplDirectoryKind,
  id: string,
): Promise<CplDirectoryEntry | null> {
  const r = await e.query<CompanyRow>(
    `SELECT b.*,c.snapshot AS current_snapshot,c.revision AS current_revision,c.status AS current_status,c.updated_at AS current_updated_at FROM ${directoryTables[kind]} b LEFT JOIN cpl_directory_current c ON c.organization_id=b.organization_id AND c.id=b.id AND c.kind=$3 WHERE b.organization_id=$1 AND b.id=$2`,
    [organizationId, id, kind],
  );
  return r.rows[0] ? mapCplDirectory(kind, r.rows[0]) : null;
}
export async function auditCplCompany(
  e: SqlExecutor,
  a: CplTenantAccess,
  action: string,
  resourceType: string,
  resourceId: string,
  version: number,
  message: string,
) {
  await e.query(
    "INSERT INTO cpl_tenant_audit_events(id,organization_id,actor_identity_id,action,resource_id,resource_type,resource_version,safe_summary) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
    [
      randomUUID(),
      a.organizationId,
      a.identityId,
      action,
      resourceId,
      resourceType,
      version,
      JSON.stringify({ message }),
    ],
  );
}
