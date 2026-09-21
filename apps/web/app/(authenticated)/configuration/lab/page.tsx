import { getServerRuntime } from "@bea/database";
import {
  SYNTHETIC_EXTERIOR_CSV_FIXTURE,
  SYNTHETIC_EXTERIOR_JSON_FIXTURE,
  SYNTHETIC_MOISTURE_CSV_FIXTURE,
  SYNTHETIC_MOISTURE_JSON_FIXTURE,
} from "@bea/domain";
import { PERMISSIONS } from "@bea/security";
import { Card, CardContent, CardHeader, CardTitle, PageHeader } from "@bea/ui";
import type { Metadata } from "next";

import { ConfigurationMappingLab } from "@/components/configuration-mapping-lab";
import { SyntheticFixtureBanner } from "@/components/synthetic-fixture-banner";
import { requirePermission } from "@/lib/auth/authorization";

export const metadata: Metadata = { title: "Synthetic configuration lab" };
export const dynamic = "force-dynamic";

export default async function ConfigurationLabPage() {
  const session = await requirePermission(PERMISSIONS.CONFIGURATION_VIEW, "configuration-lab");
  const runtime = await getServerRuntime();
  const dryRun = await runtime.authorization.authorizeUser(
    session.personaId,
    PERMISSIONS.CONFIGURATION_DRY_RUN,
  );
  const releases = await runtime.configuration.repository.listReleases();

  return (
    <>
      <PageHeader
        eyebrow="Configuration Studio"
        title="Synthetic lab"
        description="Two demonstration families prove the same engine can map JSON and CSV, validate, and render different reports without code changes. These are not BEA service definitions."
      />
      <SyntheticFixtureBanner synthetic />
      <Card>
        <CardHeader>
          <CardTitle>Demonstration families</CardTitle>
        </CardHeader>
        <CardContent>
          <ul>
            <li>
              Synthetic Exterior Observation — JSON mapping, photo grid, BEA-SYN-EXT filename.
            </li>
            <li>
              Synthetic Moisture Investigation — CSV mapping, moisture table, BEA-SYN-MOI filename.
            </li>
          </ul>
        </CardContent>
      </Card>
      {dryRun.allowed ? (
        <Card>
          <CardHeader>
            <CardTitle>Replay and dry-run</CardTitle>
          </CardHeader>
          <CardContent>
            <ConfigurationMappingLab
              releases={releases.map((release) => ({
                id: release.id,
                displayName: release.displayName,
                versionNumber: release.versionNumber,
                synthetic: release.synthetic,
              }))}
            />
          </CardContent>
        </Card>
      ) : (
        <p>The current role can view the lab but cannot run mapping dry-runs.</p>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Synthetic JSON fixture — Exterior Observation</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="bea-code-block">
            {JSON.stringify(SYNTHETIC_EXTERIOR_JSON_FIXTURE, null, 2)}
          </pre>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Synthetic CSV fixture — Moisture Investigation</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="bea-code-block">{SYNTHETIC_MOISTURE_CSV_FIXTURE}</pre>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Additional synthetic fixtures</CardTitle>
        </CardHeader>
        <CardContent>
          <p>
            Exterior CSV and moisture JSON exist for engine tests and are not BEA production data.
          </p>
          <pre className="bea-code-block">{SYNTHETIC_EXTERIOR_CSV_FIXTURE}</pre>
          <pre className="bea-code-block">
            {JSON.stringify(SYNTHETIC_MOISTURE_JSON_FIXTURE, null, 2)}
          </pre>
        </CardContent>
      </Card>
    </>
  );
}
