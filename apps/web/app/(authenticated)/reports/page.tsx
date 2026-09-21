import { getServerRuntime } from "@bea/database";
import { PERMISSIONS } from "@bea/security";
import { Badge, EmptyState, Link, PageHeader, Table, TableFoundation } from "@bea/ui";
import type { Metadata } from "next";

import {
  SyntheticFixtureBadge,
  SyntheticFixtureBanner,
} from "@/components/synthetic-fixture-banner";
import { requirePermission } from "@/lib/auth/authorization";
import { operationsStatusTone, reportStatusLabel } from "@/lib/operations-presentation";

export const metadata: Metadata = { title: "Reports" };
export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  await requirePermission(PERMISSIONS.REPORTS_VIEW, "reports");
  const runtime = await getServerRuntime();
  const [reports, inspections, projects] = await Promise.all([
    runtime.operations.repository.listReports(),
    runtime.operations.repository.listInspections(),
    runtime.operations.repository.listProjects(),
  ]);
  const inspectionById = new Map(inspections.map((inspection) => [inspection.id, inspection]));
  const projectById = new Map(projects.map((project) => [project.id, project]));

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Deterministic document pipeline"
        title="Reports"
        description="Versioned inspection reports. Draft assembly does not require an AI provider. Production BEA template mapping is NOT CONFIGURED."
        actions={<SyntheticFixtureBadge synthetic={runtime.environment.appMode === "demo"} />}
      />
      <SyntheticFixtureBanner synthetic={runtime.environment.appMode === "demo"} />
      {reports.length === 0 ? (
        <EmptyState
          title="No reports"
          description="Submit a complete synthetic inspection package to assemble a draft automatically."
        />
      ) : (
        <TableFoundation>
          <Table>
            <thead>
              <tr>
                <th>Reference</th>
                <th>Inspection</th>
                <th>Project</th>
                <th>Status</th>
                <th>Version</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((report) => {
                const inspection = inspectionById.get(report.inspectionId);
                const project = projectById.get(report.projectId);
                return (
                  <tr key={report.id}>
                    <td>
                      <Link href={`/reports/${report.id}`}>{report.reference}</Link>
                    </td>
                    <td>
                      {inspection ? (
                        <Link href={`/inspections/${inspection.id}`}>{inspection.reference}</Link>
                      ) : (
                        report.inspectionId
                      )}
                    </td>
                    <td>{project?.reference ?? report.projectId}</td>
                    <td>
                      <Badge tone={operationsStatusTone(report.status)}>
                        {reportStatusLabel(report.status)}
                      </Badge>
                    </td>
                    <td>v{report.currentVersionNumber}</td>
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
