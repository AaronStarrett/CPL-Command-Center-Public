import { getServerRuntime } from "@bea/database";
import { PERMISSIONS } from "@bea/security";
import { Card, CardContent, CardHeader, CardTitle, PageHeader } from "@bea/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { InspectionIngestForm } from "@/components/inspection-ingest-form";
import { SyntheticFixtureBanner } from "@/components/synthetic-fixture-banner";
import { requirePermission } from "@/lib/auth/authorization";

export const metadata: Metadata = { title: "Package ingestion" };
export const dynamic = "force-dynamic";

export default async function InspectionIngestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requirePermission(PERMISSIONS.INSPECTIONS_VIEW, "inspection-ingest");
  const runtime = await getServerRuntime();
  const { id } = await params;
  const inspection = await runtime.operations.repository.getInspection(id);
  if (!inspection) notFound();
  const canSubmit = await runtime.authorization.authorizeUser(
    session.personaId,
    inspection.status === "needs_correction"
      ? PERMISSIONS.INSPECTIONS_CORRECT
      : PERMISSIONS.INSPECTIONS_SUBMIT,
  );

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Package ingestion"
        title={inspection.reference}
        description="Preserve the source, map through the bound configuration release, preview canonical data, then commit as an inspection submission."
      />
      <SyntheticFixtureBanner synthetic />
      <Card>
        <CardHeader>
          <CardTitle>Stage JSON or CSV</CardTitle>
        </CardHeader>
        <CardContent>
          {canSubmit.allowed ? (
            <InspectionIngestForm
              inspectionId={inspection.id}
              needsCorrection={inspection.status === "needs_correction"}
            />
          ) : (
            <p>The current role cannot commit inspection packages.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
