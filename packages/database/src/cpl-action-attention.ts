import { createHash, randomUUID } from "node:crypto";
import type { SqlExecutor } from "./adapter.js";
import type { CplTenantAccess } from "./tenant-repository.js";

/** Attention records are not recipe executions or historical automation replay.
 * The same lead revision never recreates a dismissed item. A later correction
 * updates its one durable source item and appends a new history entry. */
export async function syncCplLeadAttention(
  e: SqlExecutor,
  a: CplTenantAccess,
  lead: {
    id: string;
    version: number;
    title: string;
    customerName: string;
    assignedMemberIdentityId: string | null;
    nextAction: string;
    status: string;
    readiness: {
      readyForProposal: boolean;
      missingInformation: readonly { message: string }[];
      conflicts: readonly { message: string }[];
    };
  },
) {
  const existing = await e.query<Record<string, unknown>>(
    "SELECT * FROM cpl_action_tasks WHERE organization_id=$1 AND execution_id IS NULL AND step_key=$2 FOR UPDATE",
    [a.organizationId, `lead.attention:${lead.id}`],
  );
  const proposed =
    (
      await e.query(
        "SELECT id FROM cpl_commercial_proposals WHERE organization_id=$1 AND lead_id=$2 LIMIT 1",
        [a.organizationId, lead.id],
      )
    ).rows.length > 0;
  const sourceHash = createHash("sha256")
    .update(JSON.stringify({ version: lead.version, readiness: lead.readiness, proposed }))
    .digest("hex");
  const prior = existing.rows[0],
    context = prior?.display_context as { sourceHash?: string } | undefined;
  if (context?.sourceHash === sourceHash) return;
  const done = lead.status === "disqualified" || proposed;
  if (!prior && done) return;
  const group =
      lead.status === "ready_for_proposal" && lead.readiness.readyForProposal
        ? "next_actions"
        : lead.readiness.readyForProposal
          ? "reviews"
          : "missing_information",
    reason = done
      ? `Lead ${lead.status === "disqualified" ? "disqualified" : "linked to a structured proposal"}.`
      : lead.status === "ready_for_proposal" && lead.readiness.readyForProposal
        ? "Lead is ready for a proposal; continue the configured or manual handoff."
        : lead.readiness.readyForProposal
          ? "Intake information is complete; a human must review readiness before proposal creation."
          : `Required intake review: ${[...lead.readiness.missingInformation, ...lead.readiness.conflicts].map((x) => x.message).join(" ")}`;
  const owner = lead.assignedMemberIdentityId
    ? { kind: "person", identityId: lead.assignedMemberIdentityId, role: null }
    : { kind: "unassigned", identityId: null, role: null };
  const taskId = prior ? String(prior.id) : randomUUID(),
    revision = prior ? Number(prior.revision) + 1 : 1;
  const rows = prior
    ? await e.query<Record<string, unknown>>(
        "UPDATE cpl_action_tasks SET revision=$3,title=$4,reason=$5,task_group=$6,owner=$7::jsonb,status=$8,display_context=$9::jsonb,resolution_reason=$10,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND id=$2 RETURNING *",
        [
          a.organizationId,
          taskId,
          revision,
          lead.nextAction || `Review intake: ${lead.title}`,
          reason,
          group,
          JSON.stringify(owner),
          done ? "completed" : "open",
          JSON.stringify({
            customerName: lead.customerName,
            sourceVersion: lead.version,
            sourceHash,
          }),
          done ? reason : null,
        ],
      )
    : await e.query<Record<string, unknown>>(
        "INSERT INTO cpl_action_tasks(organization_id,id,execution_id,step_key,title,reason,task_group,target,owner,display_context) VALUES($1,$2,NULL,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb) RETURNING *",
        [
          a.organizationId,
          taskId,
          `lead.attention:${lead.id}`,
          lead.nextAction || `Review intake: ${lead.title}`,
          reason,
          group,
          JSON.stringify({ kind: "lead", id: lead.id, projectId: null, version: null }),
          JSON.stringify(owner),
          JSON.stringify({
            customerName: lead.customerName,
            sourceVersion: lead.version,
            sourceHash,
          }),
        ],
      );
  await e.query(
    "INSERT INTO cpl_action_task_events(organization_id,id,task_id,revision,action,actor_identity_id,reason,snapshot) VALUES($1,$2,$3,$4,'source.reconciled',$5,$6,$7::jsonb)",
    [
      a.organizationId,
      randomUUID(),
      taskId,
      revision,
      a.identityId,
      reason,
      JSON.stringify(rows.rows[0]),
    ],
  );
}
