import {
  cplFieldReadiness,
  type CplFieldAnswer,
  type CplFieldTemplateInput,
} from "@bea/domain/cpl-field";
import type { SqlExecutor } from "./adapter.js";

/** Called only within an authenticated tenant transaction holding the shared
 * execution/field organization advisory lock. No API-only completion bypass. */
export async function readCplFieldReadiness(
  e: SqlExecutor,
  organizationId: string,
  projectId: string,
  visitId: string,
) {
  const rows = await e.query<{ answers: CplFieldAnswer[]; snapshot: CplFieldTemplateInput }>(
    "SELECT r.answers,t.snapshot FROM cpl_field_records r JOIN cpl_field_templates t ON (t.organization_id,t.id,t.version)=(r.organization_id,r.template_id,r.template_version) WHERE r.organization_id=$1 AND r.project_id=$2 AND r.visit_id=$3",
    [organizationId, projectId, visitId],
  );
  const row = rows.rows[0];
  if (!row) return { attached: false, readiness: [] };
  const photos = await e.query<{ id: string; state: "ready" | "reserved" }>(
    "SELECT id,state FROM cpl_field_photos WHERE organization_id=$1 AND project_id=$2 AND visit_id=$3",
    [organizationId, projectId, visitId],
  );
  return { attached: true, readiness: cplFieldReadiness(row.snapshot, row.answers, photos.rows) };
}
