import type { CplActionTask } from "@bea/domain/cpl-automation";
import type { SqlExecutor } from "./adapter.js";
import { cplTenantRoleAllows, type CplTenantAccess } from "./tenant-repository.js";
import { integrationIso } from "./cpl-integration-data.js";

/** Derived source attention: never invents a lead, task mutation, or approval.
 * Current source/receipt state reconciles these entries on every authorized read. */
export async function readCplInboundAttention(
  e: SqlExecutor,
  a: CplTenantAccess,
): Promise<{ items: CplActionTask[]; total: number; missingInformation: number }> {
  const canSources = cplTenantRoleAllows(a.role, "sources:read"),
    canIntegrations = cplTenantRoleAllows(a.role, "integrations:read");
  if (!canSources && !canIntegrations) return { items: [], total: 0, missingInformation: 0 };
  const source = `SELECT id,revision,created_at,updated_at,'integration'::text AS kind,'Gmail connection needs attention'::text AS title FROM cpl_integration_sources WHERE organization_id=$1 AND $2::boolean AND kind='gmail' AND state<>'disconnected' AND (state IN('failed','reconnect_required') OR last_issue IS NOT NULL)
 UNION ALL SELECT r.id,r.revision,o.received_at AS created_at,r.updated_at,'source_receipt'::text AS kind,'Inbound inquiry needs review'::text AS title FROM cpl_inbound_receipts r JOIN cpl_inbound_originals o ON(o.organization_id,o.id)=(r.organization_id,r.id) WHERE r.organization_id=$1 AND $3::boolean AND r.linked_lead_id IS NULL AND r.state IN('needs_review','failed','blocked')`;
  const values = [a.organizationId, canIntegrations, canSources];
  const count = await e.query<{ total: string; missing: string }>(
    `SELECT count(*) AS total,count(*) FILTER(WHERE kind='source_receipt') AS missing FROM (${source}) attention`,
    values,
  );
  const rows = await e.query<Record<string, unknown>>(
    `SELECT * FROM (${source}) attention ORDER BY updated_at DESC,id LIMIT 100`,
    values,
  );
  return {
    total: Number(count.rows[0]!.total),
    missingInformation: Number(count.rows[0]!.missing),
    items: rows.rows.map((row) => {
      const receipt = row.kind === "source_receipt";
      return {
        id: String(row.id),
        organizationId: a.organizationId,
        revision: Number(row.revision),
        executionId: null,
        title: String(row.title),
        reason: receipt
          ? "Captured evidence is preserved and requires an authorized mapping, configuration, or intake review."
          : "Open the connection to inspect its current safe status and choose an authorized recovery action.",
        group: receipt ? "missing_information" : "automation_failures",
        customerName: null,
        projectName: null,
        nextAction: receipt
          ? "Review the original source and processing history"
          : "Review connection status",
        isMine: false,
        target: {
          kind: receipt ? "source_receipt" : "integration",
          id: String(row.id),
          projectId: null,
          version: null,
        },
        owner: { kind: "unassigned", role: null, identityId: null },
        dueAt: null,
        status: "blocked",
        resolutionReason: null,
        createdAt: integrationIso(row.created_at),
        updatedAt: integrationIso(row.updated_at),
        availableActions: {
          canAssign: false,
          canStart: false,
          canComplete: false,
          canDismiss: false,
        },
      };
    }),
  };
}
