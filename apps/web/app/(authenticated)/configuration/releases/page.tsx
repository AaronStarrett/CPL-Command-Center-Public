import { getServerRuntime } from "@bea/database";
import { PERMISSIONS } from "@bea/security";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Link,
  PageHeader,
  Table,
  TableFoundation,
} from "@bea/ui";
import type { Metadata } from "next";

import { ConfigurationDraftForm } from "@/components/configuration-draft-form";
import { SyntheticFixtureBanner } from "@/components/synthetic-fixture-banner";
import { requirePermission } from "@/lib/auth/authorization";
import {
  configurationStatusLabel,
  configurationStatusTone,
} from "@/lib/configuration-presentation";

export const metadata: Metadata = { title: "Configuration releases" };
export const dynamic = "force-dynamic";

export default async function ConfigurationReleasesPage() {
  const session = await requirePermission(PERMISSIONS.CONFIGURATION_VIEW, "configuration-releases");
  const runtime = await getServerRuntime();
  const releases = await runtime.configuration.repository.listReleases();
  const canDraft = (
    await runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.CONFIGURATION_DRAFT)
  ).allowed;

  return (
    <>
      <PageHeader
        eyebrow="Configuration Studio"
        title="Releases"
        description="Versioned operational configuration. Published releases are immutable. Activation is separate from publication."
      />
      <SyntheticFixtureBanner synthetic />
      <Card>
        <CardHeader>
          <CardTitle>Create a draft</CardTitle>
        </CardHeader>
        <CardContent>
          <ConfigurationDraftForm canDraft={canDraft} />
        </CardContent>
      </Card>
      <TableFoundation>
        <Table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Family</th>
              <th>Version</th>
              <th>Status</th>
              <th>Kind</th>
            </tr>
          </thead>
          <tbody>
            {releases.map((release) => (
              <tr key={release.id}>
                <td>
                  <Link href={`/configuration/releases/${release.id}`}>{release.displayName}</Link>
                </td>
                <td>{release.familyKey}</td>
                <td>v{release.versionNumber}</td>
                <td>
                  <Badge tone={configurationStatusTone(release.status)}>
                    {configurationStatusLabel(release.status)}
                  </Badge>
                </td>
                <td>{release.synthetic ? "Synthetic" : "Production (unconfigured)"}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </TableFoundation>
    </>
  );
}
