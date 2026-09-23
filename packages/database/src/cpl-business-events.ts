import { randomUUID } from "node:crypto";
import type { CplAutomationTrigger, CplBusinessEvent } from "@bea/domain/cpl-automation";
import type { SqlExecutor } from "./adapter.js";
import type { CplTenantAccess } from "./tenant-repository.js";

/** Source mutation, immutable event and captured recipe jobs share one COMMIT.
 * There is deliberately no historical scan when a recipe is enabled. */
export async function emitCplBusinessEvent(
  executor: SqlExecutor,
  access: CplTenantAccess,
  input: {
    type: CplAutomationTrigger;
    sourceKind: CplBusinessEvent["sourceKind"];
    sourceId: string;
    sourceVersion: number;
    projectId?: string | null;
    service?: string | null;
    title?: string;
  },
): Promise<string> {
  const inserted = await executor.query<Record<string, unknown>>(
    "INSERT INTO cpl_business_events(organization_id,id,event_type,source_kind,source_id,source_version,project_id,actor_identity_id,origin,causation_execution_id,context) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT(organization_id,event_type,source_id,source_version) DO NOTHING RETURNING id",
    [
      access.organizationId,
      randomUUID(),
      input.type,
      input.sourceKind,
      input.sourceId,
      input.sourceVersion,
      input.projectId ?? null,
      access.identityId,
      access.automationExecutionId ? "automation" : "human",
      access.automationExecutionId ?? null,
      JSON.stringify({ service: input.service ?? null, title: input.title ?? "" }),
    ],
  );
  if (!inserted.rows[0]) {
    const prior = await executor.query<Record<string, unknown>>(
      "SELECT id FROM cpl_business_events WHERE organization_id=$1 AND event_type=$2 AND source_id=$3 AND source_version=$4",
      [access.organizationId, input.type, input.sourceId, input.sourceVersion],
    );
    if (!prior.rows[0]) throw new Error("CPL_AUTOMATION_EVENT_CONFLICT");
    return String(prior.rows[0].id);
  }
  const eventId = String(inserted.rows[0].id);
  // Only human business transitions initiate configured handoffs. Worker progress
  // retains causation but cannot recursively initiate another recipe.
  if (access.automationExecutionId) return eventId;
  await executor.query(
    `INSERT INTO cpl_workflow_jobs(id,organization_id,kind,event_id,recipe_id,recipe_version,issued_by_identity_id,issued_membership_version)
     SELECT gen_random_uuid(),r.organization_id,'automation.recipe',$2,r.id,r.current_version,v.configured_by_identity_id,v.authorized_membership_version
     FROM cpl_automation_recipes r JOIN cpl_automation_recipe_versions v ON(v.organization_id,v.recipe_id,v.version)=(r.organization_id,r.id,r.current_version)
     WHERE r.organization_id=$1 AND r.enabled AND r.trigger_type=$3
       AND (v.configuration->>'service' IS NULL OR v.configuration->>'service'=$4)
     ON CONFLICT(organization_id,event_id,recipe_id) WHERE kind='automation.recipe' DO NOTHING`,
    [access.organizationId, eventId, input.type, input.service ?? null],
  );
  return eventId;
}
