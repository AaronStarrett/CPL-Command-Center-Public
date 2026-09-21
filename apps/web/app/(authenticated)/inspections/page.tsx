import { getServerRuntime } from "@bea/database";
import { PERMISSIONS } from "@bea/security";
import { Badge, EmptyState, Link, PageHeader, Table, TableFoundation } from "@bea/ui";
import type { Metadata } from "next";

import {
  SyntheticFixtureBadge,
  SyntheticFixtureBanner,
} from "@/components/synthetic-fixture-banner";
import { requirePermission } from "@/lib/auth/authorization";
import { inspectionStatusLabel, operationsStatusTone } from "@/lib/operations-presentation";

export const metadata: Metadata = { title: "Inspections" };
export const dynamic = "force-dynamic";

export default async function InspectionsPage() {
  await requirePermission(PERMISSIONS.INSPECTIONS_VIEW, "inspections");
  const runtime = await getServerRuntime();
  const [inspections, projects] = await Promise.all([
    runtime.operations.repository.listInspections(),
    runtime.operations.repository.listProjects(),
  ]);
  const projectById = new Map(projects.map((project) => [project.id, project]));

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Fieldwork records"
        title="Inspections"
        description="Canonical inspection records. Submission, validation, and report status live here rather than in email or chat."
        actions={
          <div className="bea-cluster">
            <SyntheticFixtureBadge synthetic={runtime.environment.appMode === "demo"} />
            <Link href="/inspections/new">Create inspection</Link>
          </div>
        }
      />
      <SyntheticFixtureBanner synthetic={runtime.environment.appMode === "demo"} />
      {inspections.length === 0 ? (
        <EmptyState
          title="No inspections"
          description="Seed the demo database to create synthetic inspections."
        />
      ) : (
        <TableFoundation>
          <Table>
            <thead>
              <tr>
                <th>Reference</th>
                <th>Project</th>
                <th>Status</th>
                <th>Completed</th>
                <th>Submitted</th>
              </tr>
            </thead>
            <tbody>
              {inspections.map((inspection) => {
                const project = projectById.get(inspection.projectId);
                return (
                  <tr key={inspection.id}>
                    <td>
                      <Link href={`/inspections/${inspection.id}`}>{inspection.reference}</Link>
                    </td>
                    <td>{project?.reference ?? inspection.projectId}</td>
                    <td>
                      <Badge tone={operationsStatusTone(inspection.status)}>
                        {inspectionStatusLabel(inspection.status)}
                      </Badge>
                    </td>
                    <td>{inspection.completedAt ?? "—"}</td>
                    <td>{inspection.submittedAt ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </TableFoundation>
      )}
    </div>
  );
}
