import type { DatabaseAdapter, SqlExecutor } from "./adapter.js";
import type { CplTenantAccess } from "./tenant-repository.js";
import { integrationFail, integrationJson, type IntegrationRow } from "./cpl-integration-data.js";
export async function withCplIngestionAuthority<T>(
  database: DatabaseAdapter,
  job: IntegrationRow,
  leaseToken: string,
  run: (e: SqlExecutor, a: CplTenantAccess) => Promise<T>,
  finalize?: (e: SqlExecutor, result: T) => Promise<void>,
): Promise<T> {
  return database.transaction(async (e) => {
    const row = await e.query<{ access: unknown }>(
      "SELECT cpl_ingestion_lock_authority($1,$2,$3) AS access",
      [job.organization_id, job.id, leaseToken],
    );
    if (!row.rows[0]?.access) integrationFail("CPL_INTEGRATION_AUTHORIZATION_REVOKED");
    const result = await run(e, integrationJson<CplTenantAccess>(row.rows[0].access));
    const fence = await e.query(
      "SELECT id FROM cpl_workflow_jobs WHERE organization_id=$1 AND id=$2 AND status='running' AND lease_token=$3 AND lease_expires_at>clock_timestamp()",
      [job.organization_id, job.id, leaseToken],
    );
    if (!fence.rowCount) integrationFail("CPL_INTEGRATION_LEASE_LOST");
    if (finalize) await finalize(e, result);
    return result;
  });
}
