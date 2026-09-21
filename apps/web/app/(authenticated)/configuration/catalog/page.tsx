import { getServerRuntime } from "@bea/database";
import {
  COMMERCIAL_INTAKE_QUESTIONS,
  COMMERCIAL_PRODUCTION_UNCONFIGURED,
  COMMERCIAL_READINESS_GAPS,
  COMMERCIAL_SYNTHETIC_DISCLOSURE,
  PRODUCTION_SERVICE_CATALOG_PLACEHOLDER,
  SYNTHETIC_ENVELOPE_CATALOG,
  SYNTHETIC_MOISTURE_CATALOG,
} from "@bea/domain";
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

import { CatalogLifecycleActions } from "@/components/catalog-lifecycle-actions";
import {
  SyntheticFixtureBadge,
  SyntheticFixtureBanner,
} from "@/components/synthetic-fixture-banner";
import { requirePermission } from "@/lib/auth/authorization";
import {
  configurationStatusLabel,
  configurationStatusTone,
} from "@/lib/configuration-presentation";

export const metadata: Metadata = { title: "Service catalog" };
export const dynamic = "force-dynamic";

export default async function ServiceCatalogPage() {
  const session = await requirePermission(PERMISSIONS.SERVICE_CATALOG_VIEW, "service-catalog");
  const runtime = await getServerRuntime();
  const [catalogs, versions, manage, publish] = await Promise.all([
    runtime.commercial.repository.listCatalogs(),
    runtime.commercial.repository.listCatalogVersions(),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.SERVICE_CATALOG_MANAGE),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.SERVICE_CATALOG_PUBLISH),
  ]);
  const active = versions.filter((item) => item.status === "active");
  const production = versions.filter((item) => !item.synthetic);

  return (
    <>
      <PageHeader
        eyebrow="Configuration Studio"
        title="Service catalog"
        description="Versioned synthetic catalogs and an unconfigured production placeholder. Prices are laboratory integers, not BEA-approved rates."
        actions={<SyntheticFixtureBadge synthetic />}
      />
      <SyntheticFixtureBanner synthetic />
      <p className="bea-muted" data-testid="synthetic-disclosure">
        {COMMERCIAL_SYNTHETIC_DISCLOSURE}
      </p>
      <Card>
        <CardHeader>
          <CardTitle>Catalog readiness</CardTitle>
        </CardHeader>
        <CardContent data-testid="catalog-readiness">
          <ul>
            <li>
              Active synthetic catalogs:{" "}
              {active.map((item) => `${item.catalogKey} v${item.versionNumber}`).join(", ") ||
                "none"}
            </li>
            <li>Which prices are synthetic? All active catalog prices in this lab.</li>
            <li>Production catalog: {COMMERCIAL_PRODUCTION_UNCONFIGURED}</li>
            <li>
              Production versions: {production.length} draft placeholder
              {production[0] ? ` (${production[0].catalogKey})` : ""}
            </li>
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Catalog versions</CardTitle>
        </CardHeader>
        <CardContent>
          <TableFoundation>
            <Table data-testid="catalog-versions">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Version</th>
                  <th>Status</th>
                  <th>Currency</th>
                  <th>Identity</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((version) => (
                  <tr key={version.id}>
                    <td>{version.catalogKey}</td>
                    <td>{version.versionNumber}</td>
                    <td>
                      <Badge tone={configurationStatusTone(version.status)}>
                        {configurationStatusLabel(version.status)}
                      </Badge>
                    </td>
                    <td>{version.currency}</td>
                    <td>{version.synthetic ? "SYNTHETIC" : "PRODUCTION PLACEHOLDER"}</td>
                    <td>
                      <CatalogLifecycleActions
                        version={version}
                        canManage={manage.allowed}
                        canPublish={publish.allowed}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableFoundation>
        </CardContent>
      </Card>
      {await Promise.all(
        versions.map(async (version) => {
          const items = await runtime.commercial.repository.listCatalogItems(version.id);
          const used = await runtime.commercial.repository.listProposalsUsedByCatalog(version.id);
          return (
            <Card key={`items-${version.id}`}>
              <CardHeader>
                <CardTitle>
                  {version.catalogKey} v{version.versionNumber} items
                </CardTitle>
              </CardHeader>
              <CardContent>
                <TableFoundation>
                  <Table>
                    <thead>
                      <tr>
                        <th>Code</th>
                        <th>Name</th>
                        <th>Model</th>
                        <th>Rate (cents)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item) => (
                        <tr key={item.serviceKey}>
                          <td>{item.serviceCode}</td>
                          <td>{item.displayName}</td>
                          <td>{item.pricingModel}</td>
                          <td>{item.defaultRateMinor}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </TableFoundation>
                <p>
                  Proposals that used this version:{" "}
                  {used.length
                    ? used.map((proposal) => (
                        <Link key={proposal.id} href={`/proposals/${proposal.id}`}>
                          {proposal.reference}{" "}
                        </Link>
                      ))
                    : "none yet"}
                </p>
              </CardContent>
            </Card>
          );
        }),
      )}
      <Card>
        <CardHeader>
          <CardTitle>Synthetic lab families</CardTitle>
        </CardHeader>
        <CardContent>
          <p>
            {SYNTHETIC_ENVELOPE_CATALOG.displayName} uses{" "}
            {SYNTHETIC_ENVELOPE_CATALOG.template.templateKey}.
            {SYNTHETIC_MOISTURE_CATALOG.displayName} uses{" "}
            {SYNTHETIC_MOISTURE_CATALOG.template.templateKey}. Configuration, not fixture-ID
            branches, produces the different documents.
          </p>
          <p>{PRODUCTION_SERVICE_CATALOG_PLACEHOLDER.displayName} remains UNCONFIGURED.</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>What is needed from Owner</CardTitle>
        </CardHeader>
        <CardContent>
          <ul>
            {COMMERCIAL_READINESS_GAPS.map((gap) => (
              <li key={gap.gapKey}>
                <strong>{gap.area}:</strong> {gap.description}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Thursday commercial intake</CardTitle>
        </CardHeader>
        <CardContent>
          <p>
            Answers remain unconfirmed until Owner confirms them. Open the{" "}
            <Link href="/configuration/intake">Thursday intake</Link> workspace.
          </p>
          <ul>
            {COMMERCIAL_INTAKE_QUESTIONS.map((item) => (
              <li key={item.key}>
                {item.section}. {item.prompt}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <p className="bea-muted">
        {catalogs.length} catalog families. Production activation is blocked.
      </p>
    </>
  );
}
