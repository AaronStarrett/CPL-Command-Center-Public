import { getServerRuntime } from "@bea/database";
import { PERMISSIONS } from "@bea/security";
import { Card, CardContent, CardHeader, CardTitle, Link, PageHeader } from "@bea/ui";
import type { Metadata } from "next";
import type { ConfigurationArtifactKind } from "@bea/domain";

import { SyntheticFixtureBanner } from "@/components/synthetic-fixture-banner";
import { requirePermission } from "@/lib/auth/authorization";

export const dynamic = "force-dynamic";

async function ArtifactKindPage({
  title,
  description,
  kind,
  metadataTitle,
}: {
  title: string;
  description: string;
  kind: ConfigurationArtifactKind;
  metadataTitle: string;
}) {
  await requirePermission(PERMISSIONS.CONFIGURATION_VIEW, `configuration-${kind}`);
  const runtime = await getServerRuntime();
  const releases = await runtime.configuration.repository.listReleases();
  const rows = [];
  for (const release of releases) {
    const artifacts = await runtime.configuration.repository.listArtifacts(release.id);
    const artifact = artifacts.find((item) => item.artifactKind === kind);
    if (artifact) {
      rows.push({ release, artifact, payload: artifact.payload });
    }
  }
  return (
    <>
      <PageHeader eyebrow="Configuration Studio" title={title} description={description} />
      <SyntheticFixtureBanner synthetic />
      {rows.map(({ release, artifact, payload }) => (
        <Card key={artifact.id}>
          <CardHeader>
            <CardTitle>
              <Link href={`/configuration/releases/${release.id}`}>
                {release.displayName} v{release.versionNumber}
              </Link>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p>
              {artifact.artifactKey} ·{" "}
              {release.synthetic ? "Synthetic demonstration" : "Production unconfigured"}
            </p>
            <pre className="bea-code-block">{JSON.stringify(payload, null, 2)}</pre>
          </CardContent>
        </Card>
      ))}
      {rows.length === 0 ? <p>No {metadataTitle} artifacts are bound yet.</p> : null}
    </>
  );
}

export function makeArtifactPage(
  metadataTitle: string,
  title: string,
  description: string,
  kind: ConfigurationArtifactKind,
) {
  return {
    metadata: { title: metadataTitle } satisfies Metadata,
    Page: async function Page() {
      return ArtifactKindPage({ title, description, kind, metadataTitle });
    },
  };
}
