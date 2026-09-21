import { getServerRuntime } from "@bea/database";
import { PERMISSIONS } from "@bea/security";
import { Card, CardContent, CardHeader, CardTitle, PageHeader } from "@bea/ui";
import type { Metadata } from "next";

import { InspectionSetupForm } from "@/components/inspection-setup-form";
import { SyntheticFixtureBanner } from "@/components/synthetic-fixture-banner";
import { requirePermission } from "@/lib/auth/authorization";

export const metadata: Metadata = { title: "New inspection" };
export const dynamic = "force-dynamic";

export default async function NewInspectionPage() {
  const session = await requirePermission(PERMISSIONS.INSPECTIONS_SUBMIT, "inspection-create");
  const runtime = await getServerRuntime();
  const [projects, releases, users] = await Promise.all([
    runtime.operations.repository.listProjects(),
    runtime.configuration.repository.listReleases(),
    runtime.database.query<{ id: string; display_name: string }>(
      "SELECT id::text AS id, display_name FROM users ORDER BY display_name",
    ),
  ]);
  void session;

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Inspection setup"
        title="Create inspection"
        description="Connect an existing project to a published or active configuration release. Live Outlook calendar is not connected; only a dry-run plan is available from Configuration Studio."
      />
      <SyntheticFixtureBanner synthetic />
      <Card>
        <CardHeader>
          <CardTitle>Setup</CardTitle>
        </CardHeader>
        <CardContent>
          <InspectionSetupForm
            projects={projects.map((project) => ({
              id: project.id,
              reference: project.reference,
              name: project.name,
            }))}
            releases={releases.map((release) => ({
              id: release.id,
              displayName: release.displayName,
              versionNumber: release.versionNumber,
              status: release.status,
              synthetic: release.synthetic,
            }))}
            users={users.rows.map((row) => ({ id: row.id, displayName: row.display_name }))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
