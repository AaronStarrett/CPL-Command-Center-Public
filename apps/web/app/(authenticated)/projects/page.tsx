import { getServerRuntime } from "@bea/database";
import { PROJECT_STATUS_LABELS } from "@bea/domain";
import { PERMISSIONS } from "@bea/security";
import { Badge, EmptyState, Link, PageHeader, Table, TableFoundation } from "@bea/ui";
import type { Metadata } from "next";

import {
  SyntheticFixtureBadge,
  SyntheticFixtureBanner,
} from "@/components/synthetic-fixture-banner";
import { requirePermission } from "@/lib/auth/authorization";
import { operationsStatusTone } from "@/lib/operations-presentation";

export const metadata: Metadata = { title: "Projects" };
export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  await requirePermission(PERMISSIONS.PROJECTS_VIEW, "projects");
  const runtime = await getServerRuntime();
  const projects = await runtime.operations.repository.listProjects();

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Awarded work"
        title="Projects"
        description="Canonical projects carried forward from accepted commercial snapshots. Award-to-project conversion remains a later phase."
        actions={<SyntheticFixtureBadge synthetic={runtime.environment.appMode === "demo"} />}
      />
      <SyntheticFixtureBanner synthetic={runtime.environment.appMode === "demo"} />
      {projects.length === 0 ? (
        <EmptyState title="No projects" description="Demo seed creates two synthetic projects." />
      ) : (
        <TableFoundation>
          <Table>
            <thead>
              <tr>
                <th>Reference</th>
                <th>Name</th>
                <th>Client</th>
                <th>Site</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => (
                <tr key={project.id}>
                  <td>
                    <Link href="/operations">{project.reference}</Link>
                  </td>
                  <td>{project.name}</td>
                  <td>{project.clientName}</td>
                  <td>{project.siteName}</td>
                  <td>
                    <Badge tone={operationsStatusTone(project.status)}>
                      {PROJECT_STATUS_LABELS[project.status]}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableFoundation>
      )}
    </div>
  );
}
