import { getServerRuntime } from "@bea/database";
import { PERMISSIONS } from "@bea/security";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  PageHeader,
  Table,
  TableFoundation,
} from "@bea/ui";
import type { Metadata } from "next";

import {
  SyntheticFixtureBadge,
  SyntheticFixtureBanner,
} from "@/components/synthetic-fixture-banner";
import { requirePermission } from "@/lib/auth/authorization";
import {
  configurationStatusLabel,
  configurationStatusTone,
} from "@/lib/configuration-presentation";

export const metadata: Metadata = { title: "Configuration readiness" };
export const dynamic = "force-dynamic";

export default async function ConfigurationReadinessPage() {
  await requirePermission(PERMISSIONS.CONFIGURATION_VIEW, "configuration-readiness");
  const runtime = await getServerRuntime();
  const [releases, readiness, intake, connectors] = await Promise.all([
    runtime.configuration.repository.listReleases(),
    runtime.configuration.repository.listReadinessItems(),
    runtime.configuration.repository.listIntakeItems(),
    runtime.operations.repository.listConnectorReadiness(),
  ]);
  const active = releases.filter((item) => item.status === "active");
  const drafts = releases.filter(
    (item) => item.status === "draft" || item.status === "validation_failed",
  );
  const blocking = readiness.filter(
    (item) =>
      item.status !== "confirmed" &&
      item.status !== "configured" &&
      item.status !== "tested" &&
      item.status !== "approved",
  );
  const architectureComplete = true;
  const syntheticComplete = active.some((item) => item.synthetic);
  const productionConfigured = releases.some((item) => !item.synthetic && item.productionReady);
  const productionConfirmed = readiness.every(
    (item) =>
      item.status === "confirmed" ||
      item.status === "configured" ||
      item.status === "tested" ||
      item.status === "approved",
  );

  return (
    <>
      <PageHeader
        eyebrow="Configuration Studio"
        title="Readiness"
        description="What is configured, what is synthetic, what Owner must confirm on Thursday, and which release would produce a report."
        actions={<SyntheticFixtureBadge synthetic />}
      />
      <SyntheticFixtureBanner synthetic />
      <Card>
        <CardHeader>
          <CardTitle>Status distinctions</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="bea-meta-list" data-testid="configuration-readiness-distinctions">
            <div>
              <dt>Architecture</dt>
              <dd>{architectureComplete ? "Complete for Phase 3.1A" : "Incomplete"}</dd>
            </div>
            <div>
              <dt>Synthetic configuration</dt>
              <dd>{syntheticComplete ? "Complete for two demonstration families" : "Missing"}</dd>
            </div>
            <div>
              <dt>Production configuration</dt>
              <dd>{productionConfigured ? "Present" : "Missing"}</dd>
            </div>
            <div>
              <dt>Production confirmation</dt>
              <dd>{productionConfirmed ? "Confirmed" : "Awaiting BEA confirmation"}</dd>
            </div>
            <div>
              <dt>Production tested</dt>
              <dd>Not tested. No BEA production materials are in this repository.</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Active and draft releases</CardTitle>
        </CardHeader>
        <CardContent>
          <p data-testid="configuration-active-count">
            {active.length} active synthetic release(s). Unconfigured production drafts are not
            active.
          </p>
          <TableFoundation>
            <Table>
              <thead>
                <tr>
                  <th>Release</th>
                  <th>Status</th>
                  <th>Kind</th>
                  <th>Version</th>
                </tr>
              </thead>
              <tbody>
                {[...active, ...drafts].map((release) => (
                  <tr key={release.id}>
                    <td>{release.displayName}</td>
                    <td>
                      <Badge tone={configurationStatusTone(release.status)}>
                        {configurationStatusLabel(release.status)}
                      </Badge>
                    </td>
                    <td>{release.synthetic ? "Synthetic" : "Production (unconfigured)"}</td>
                    <td>v{release.versionNumber}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableFoundation>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Unresolved BEA decisions</CardTitle>
        </CardHeader>
        <CardContent>
          <TableFoundation>
            <Table>
              <thead>
                <tr>
                  <th>Gap</th>
                  <th>Area</th>
                  <th>Blocking stage</th>
                  <th>Status</th>
                  <th>Owner</th>
                </tr>
              </thead>
              <tbody>
                {blocking.map((item) => (
                  <tr key={item.id}>
                    <td>{item.description}</td>
                    <td>{item.area}</td>
                    <td>{item.blockingStage}</td>
                    <td>
                      <Badge tone={configurationStatusTone(item.status)}>
                        {configurationStatusLabel(item.status)}
                      </Badge>
                    </td>
                    <td>{item.responsiblePerson}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableFoundation>
          <p>
            {
              intake.filter(
                (item) => item.status === "awaiting_bea_confirmation" || item.status === "unknown",
              ).length
            }{" "}
            Thursday intake questions still need Owner’s materials.
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Connector dependencies</CardTitle>
        </CardHeader>
        <CardContent>
          <ul>
            {connectors.map((connector) => (
              <li key={connector.id}>
                {connector.displayName}: {connector.readinessStatus}
                {connector.readinessStatus === "authenticated" ||
                connector.readinessStatus === "healthy"
                  ? " (verified)"
                  : " — not connected for live writes"}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </>
  );
}
