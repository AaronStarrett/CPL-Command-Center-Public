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
import { notFound } from "next/navigation";

import { ConfigurationReleaseActions } from "@/components/configuration-release-actions";
import { SyntheticFixtureBanner } from "@/components/synthetic-fixture-banner";
import { requirePermission } from "@/lib/auth/authorization";
import {
  configurationStatusLabel,
  configurationStatusTone,
} from "@/lib/configuration-presentation";

export const metadata: Metadata = { title: "Configuration release" };
export const dynamic = "force-dynamic";

export default async function ConfigurationReleaseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requirePermission(PERMISSIONS.CONFIGURATION_VIEW, "configuration-release");
  const runtime = await getServerRuntime();
  const { id } = await params;
  const release = await runtime.configuration.repository.getRelease(id);
  if (!release) notFound();
  const [
    artifacts,
    validationRuns,
    audit,
    canDraft,
    canValidate,
    canPublish,
    canActivate,
    canArchive,
  ] = await Promise.all([
    runtime.configuration.repository.listArtifacts(id),
    runtime.configuration.repository.listValidationRuns(id),
    runtime.configuration.repository.listAudit(id),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.CONFIGURATION_DRAFT),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.CONFIGURATION_VALIDATE),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.CONFIGURATION_PUBLISH),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.CONFIGURATION_ACTIVATE),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.CONFIGURATION_ARCHIVE),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Configuration release"
        title={`${release.displayName} v${release.versionNumber}`}
        description={release.disclosure}
        actions={
          <Badge tone={configurationStatusTone(release.status)}>
            {configurationStatusLabel(release.status)}
          </Badge>
        }
      />
      <SyntheticFixtureBanner synthetic={release.synthetic} />
      <Card>
        <CardHeader>
          <CardTitle>Lifecycle</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="bea-meta-list">
            <div>
              <dt>Family</dt>
              <dd>{release.familyKey}</dd>
            </div>
            <div>
              <dt>Service context</dt>
              <dd>{release.serviceContextKey}</dd>
            </div>
            <div>
              <dt>Production ready</dt>
              <dd>{release.productionReady ? "Yes" : "No"}</dd>
            </div>
            <div>
              <dt>Validated</dt>
              <dd>{release.validatedAt ?? "—"}</dd>
            </div>
            <div>
              <dt>Published</dt>
              <dd>{release.publishedAt ?? "—"}</dd>
            </div>
            <div>
              <dt>Activated</dt>
              <dd>{release.activatedAt ?? "—"}</dd>
            </div>
          </dl>
          <ConfigurationReleaseActions
            releaseId={release.id}
            status={release.status}
            canDraft={canDraft.allowed}
            canValidate={canValidate.allowed}
            canPublish={canPublish.allowed}
            canActivate={canActivate.allowed}
            canArchive={canArchive.allowed}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Bound artifacts</CardTitle>
        </CardHeader>
        <CardContent>
          <TableFoundation>
            <Table>
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Key</th>
                  <th>Checksum</th>
                </tr>
              </thead>
              <tbody>
                {artifacts.map((artifact) => (
                  <tr key={artifact.id}>
                    <td>{artifact.artifactKind}</td>
                    <td>{artifact.artifactKey}</td>
                    <td>{artifact.checksum.slice(0, 12)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableFoundation>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Validation history</CardTitle>
        </CardHeader>
        <CardContent>
          {validationRuns.length === 0 ? (
            <p>No validation runs yet.</p>
          ) : (
            <ul>
              {validationRuns.map((run) => (
                <li key={run.id}>
                  {run.createdAt}: {run.passed ? "passed" : "failed"} ({run.blocking.length}{" "}
                  blocking, {run.warnings.length} warnings)
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Audit history</CardTitle>
        </CardHeader>
        <CardContent>
          <ul data-testid="configuration-audit">
            {audit.map((entry, index) => (
              <li key={`${String(entry.createdAt)}-${index}`}>
                {String(entry.createdAt)} · {String(entry.action)} · {String(entry.eventType)}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </>
  );
}
