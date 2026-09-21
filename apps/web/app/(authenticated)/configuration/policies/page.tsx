import { getServerRuntime } from "@bea/database";
import { PERMISSIONS } from "@bea/security";
import { Card, CardContent, CardHeader, CardTitle, Link, PageHeader } from "@bea/ui";
import type { Metadata } from "next";

import { SyntheticFixtureBanner } from "@/components/synthetic-fixture-banner";
import { requirePermission } from "@/lib/auth/authorization";

export const metadata: Metadata = { title: "Review, storage, delivery, and SLA policy" };
export const dynamic = "force-dynamic";

export default async function ConfigurationPoliciesPage() {
  await requirePermission(PERMISSIONS.CONFIGURATION_VIEW, "configuration-policies");
  const runtime = await getServerRuntime();
  const releases = await runtime.configuration.repository.listReleases();
  const kinds = ["review_policy", "storage_policy", "delivery_policy", "sla_policy"] as const;

  return (
    <>
      <PageHeader
        eyebrow="Configuration Studio"
        title="Policies"
        description="Review, storage, delivery, and SLA are configurable within safe boundaries. BEA production policy remains UNCONFIGURED until Owner confirms it."
      />
      <SyntheticFixtureBanner synthetic />
      {await Promise.all(
        releases.map(async (release) => {
          const artifacts = await runtime.configuration.repository.listArtifacts(release.id);
          const selected = artifacts.filter((item) =>
            (kinds as readonly string[]).includes(item.artifactKind),
          );
          if (selected.length === 0) return null;
          return (
            <Card key={release.id}>
              <CardHeader>
                <CardTitle>
                  <Link href={`/configuration/releases/${release.id}`}>
                    {release.displayName} v{release.versionNumber}
                  </Link>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {selected.map((artifact) => (
                  <section key={artifact.id}>
                    <h2>{artifact.artifactKind}</h2>
                    <pre className="bea-code-block">
                      {JSON.stringify(artifact.payload, null, 2)}
                    </pre>
                  </section>
                ))}
              </CardContent>
            </Card>
          );
        }),
      )}
    </>
  );
}
