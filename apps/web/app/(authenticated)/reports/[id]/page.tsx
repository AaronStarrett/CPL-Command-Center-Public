import { computeMetrics, durationsFromIntervals, getServerRuntime } from "@bea/database";
import { PERMISSIONS } from "@bea/security";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Link,
  PageHeader,
  Table,
  TableFoundation,
} from "@bea/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ReportArtifactPreview } from "@/components/report-artifact-preview";
import { ReportReviewActions } from "@/components/report-review-actions";
import {
  SyntheticFixtureBadge,
  SyntheticFixtureBanner,
} from "@/components/synthetic-fixture-banner";
import { requirePermission } from "@/lib/auth/authorization";
import { canViewInspectionSensitive, projectInspectionSubmission } from "@/lib/operations-access";
import { formatDateTime } from "@/lib/phase1-presentation";
import {
  formatDurationMs,
  formatJobAttemptLabel,
  isSyntheticOperationsFixture,
  operationsStatusTone,
  reportStatusLabel,
  slaStageLabel,
} from "@/lib/operations-presentation";

export const metadata: Metadata = { title: "Report review" };
export const dynamic = "force-dynamic";

export default async function ReportReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission(PERMISSIONS.REPORTS_VIEW, "report-detail");
  const runtime = await getServerRuntime();
  const { id } = await params;
  const report = await runtime.operations.repository.getReport(id);
  if (!report) notFound();
  const [
    inspection,
    project,
    versions,
    deliveries,
    events,
    jobs,
    reviewDecision,
    approveDecision,
    deliverDecision,
  ] = await Promise.all([
    runtime.operations.repository.getInspection(report.inspectionId),
    runtime.operations.repository.getProject(report.projectId),
    runtime.operations.repository.listReportVersions(report.id),
    runtime.operations.repository.listDeliveries(report.id),
    runtime.operations.repository.listTimeline(report.inspectionId),
    runtime.operations.repository.listJobsForInspection(report.inspectionId),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.REPORTS_REVIEW),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.REPORTS_APPROVE),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.REPORTS_DELIVER),
  ]);
  if (!inspection) notFound();
  const submission = await runtime.operations.repository.getLatestSubmission(inspection.id);
  const [findings, evidence, validation, sla, confirmedDelivery] = await Promise.all([
    submission ? runtime.operations.repository.listFindings(submission.id) : Promise.resolve([]),
    submission ? runtime.operations.repository.listEvidence(submission.id) : Promise.resolve([]),
    runtime.operations.repository.latestValidation(inspection.id),
    runtime.operations.repository.getSlaClock(inspection.id),
    runtime.operations.repository.getConfirmedDelivery(report.id),
  ]);
  const projected = projectInspectionSubmission({
    canViewSensitive: canViewInspectionSensitive({
      roleIds: session.roleIds,
      userId: session.personaId,
    }),
    submission,
    findings,
    evidence,
  });
  const stageIntervals = sla ? await runtime.operations.repository.listStageIntervals(sla.id) : [];
  const now = new Date().toISOString();
  const current =
    versions.find((version) => version.versionNumber === report.currentVersionNumber) ??
    versions.at(-1);
  const artifactAvailable = Boolean(current?.renderedChecksum || current?.renderedStorageRef);
  const metrics = computeMetrics(inspection, report, sla, now, {
    confirmedDeliveryAt: confirmedDelivery?.confirmedAt ?? null,
    stageDurations: durationsFromIntervals(stageIntervals, now),
  });
  const synthetic = isSyntheticOperationsFixture(
    runtime.environment.appMode,
    project?.acceptedScopeSnapshot ?? null,
  );

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Report review workspace"
        title={report.reference}
        description={`${project?.clientName ?? "Unknown client"} · ${project?.siteName ?? "Unknown site"}`}
        actions={
          <div className="bea-cluster">
            <Badge tone={operationsStatusTone(report.status)}>
              {reportStatusLabel(report.status)}
            </Badge>
            <SyntheticFixtureBadge synthetic={synthetic} />
          </div>
        }
      />
      <SyntheticFixtureBanner synthetic={synthetic} />
      <Card>
        <CardHeader>
          <CardTitle>Turnaround</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="bea-meta-list" data-testid="report-turnaround">
            <div>
              <dt>Inspection completed</dt>
              <dd>{formatDateTime(metrics.inspectionCompletedAt)}</dd>
            </div>
            <div>
              <dt>Confirmed delivery</dt>
              <dd>{formatDateTime(metrics.confirmedDeliveryAt)}</dd>
            </div>
            <div>
              <dt>Total elapsed wall-clock</dt>
              <dd data-testid="total-elapsed">{formatDurationMs(metrics.currentAgeMs)}</dd>
            </div>
            <div>
              <dt>North-star turnaround</dt>
              <dd data-testid="north-star-turnaround">
                {formatDurationMs(metrics.totalTurnaroundMs)}
              </dd>
            </div>
            <div>
              <dt>Current stage age</dt>
              <dd>
                {metrics.currentStageKey} · {formatDurationMs(metrics.currentStageAgeMs)}
              </dd>
            </div>
            <div>
              <dt>SLA elapsed</dt>
              <dd data-testid="sla-elapsed">{formatDurationMs(metrics.slaElapsedMs)}</dd>
            </div>
            <div>
              <dt>SLA remaining</dt>
              <dd>
                {formatDurationMs(metrics.slaRemainingMs)} / {metrics.slaTargetMinutes} min ·{" "}
                {metrics.slaStatus}
              </dd>
            </div>
            <div>
              <dt>Paused duration</dt>
              <dd data-testid="paused-duration">
                {formatDurationMs(metrics.pausedDurationMs)}
                {metrics.pauseReason ? ` · ${metrics.pauseReason}` : ""}
              </dd>
            </div>
          </dl>
          <ul data-testid="stage-durations">
            {Object.entries(metrics.stageDurations).map(([key, duration]) => (
              <li key={key}>
                {slaStageLabel(key)}: {formatDurationMs(duration)}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Related records</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="bea-meta-list">
            <div>
              <dt>Inspection</dt>
              <dd>
                <Link href={`/inspections/${inspection.id}`}>{inspection.reference}</Link>
              </dd>
            </div>
            <div>
              <dt>Project</dt>
              <dd>{project ? <Link href="/projects">{project.reference}</Link> : "—"}</dd>
            </div>
            <div>
              <dt>Template version</dt>
              <dd data-testid="report-current-version">
                {current?.templateVersionId ?? report.currentTemplateVersionId} · report version{" "}
                {report.currentVersionNumber}
              </dd>
            </div>
            <div>
              <dt>Submission</dt>
              <dd>{submission?.id ?? "None"}</dd>
            </div>
            <div>
              <dt>Configuration release</dt>
              <dd data-testid="report-configuration-release">
                {report.configurationReleaseId ? (
                  <Link href={`/configuration/releases/${report.configurationReleaseId}`}>
                    {report.configurationReleaseId}
                  </Link>
                ) : (
                  "Phase 3.0 fixture (no configuration release)"
                )}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Draft preview</CardTitle>
        </CardHeader>
        <CardContent>
          {artifactAvailable && current ? (
            <ReportArtifactPreview reportId={report.id} title={`${report.reference} artifact`} />
          ) : (
            <p>
              A reviewable draft exists as versioned structured data. The immutable PDF appears
              after final approval and render.
            </p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Findings and evidence</CardTitle>
        </CardHeader>
        <CardContent>
          {projected.findings.length === 0 ? (
            <p>No findings on the latest submission.</p>
          ) : (
            <ul>
              {projected.findings.map((finding, index) => (
                <li key={"id" in finding ? finding.id : `${finding.code}-${index}`}>
                  {finding.code} · {finding.title}
                  {"description" in finding ? ` — ${finding.description}` : ""}
                </li>
              ))}
            </ul>
          )}
          {projected.evidence.length > 0 ? (
            <ul>
              {projected.evidence.map((item, index) => (
                <li key={"id" in item ? item.id : `${item.kind}-${item.filename}-${index}`}>
                  {item.kind}: {item.filename}
                  {"sha256" in item ? ` (${item.sha256.slice(0, 12)}…)` : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Validation</CardTitle>
        </CardHeader>
        <CardContent>
          {validation ? (
            <>
              <Badge tone={validation.passed ? "success" : "danger"}>
                {validation.passed ? "Passed" : "Failed"}
              </Badge>
              <ul>
                {validation.blocking.map((item) => (
                  <li key={item.code}>
                    {item.path}: {item.message}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <EmptyState title="No validation result" description="Submit inspection data first." />
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Versions</CardTitle>
        </CardHeader>
        <CardContent>
          <ul>
            {versions.map((version) => (
              <li key={version.id}>
                v{version.versionNumber} · {version.status}
                {version.reviewDecision ? ` · ${version.reviewDecision}` : ""}
                {version.reviewComment ? ` — ${version.reviewComment}` : ""}
                {version.renderedChecksum
                  ? ` · checksum ${version.renderedChecksum.slice(0, 12)}`
                  : ""}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Review actions</CardTitle>
        </CardHeader>
        <CardContent>
          <ReportReviewActions
            report={report}
            canReview={reviewDecision.allowed}
            canApprove={approveDecision.allowed}
            canDeliver={deliverDecision.allowed}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Deliveries</CardTitle>
        </CardHeader>
        <CardContent>
          <div data-testid="report-deliveries">
            {deliveries.length === 0 ? (
              <p>
                No delivery attempts yet. Technical approval renders the final artifact. Owner
                delivery authorization is required before send.
              </p>
            ) : (
              <TableFoundation>
                <Table>
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>Adapter</th>
                      <th>External message</th>
                      <th>Confirmed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deliveries.map((delivery) => (
                      <tr key={delivery.id}>
                        <td>
                          <Badge tone={operationsStatusTone(delivery.status)}>
                            {delivery.status}
                          </Badge>
                        </td>
                        <td>{delivery.adapterKey}</td>
                        <td>{delivery.externalMessageId ?? "—"}</td>
                        <td>{formatDateTime(delivery.confirmedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </TableFoundation>
            )}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Event timeline</CardTitle>
        </CardHeader>
        <CardContent>
          <TableFoundation>
            <Table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Event</th>
                  <th>Actor</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td>{formatDateTime(event.occurredAt)}</td>
                    <td>{event.eventType}</td>
                    <td>
                      {event.actorType}
                      {event.actorId ? ` · ${event.actorId.slice(0, 8)}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableFoundation>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Automation jobs</CardTitle>
        </CardHeader>
        <CardContent>
          <ul>
            {jobs.map((job) => (
              <li key={job.id}>
                {job.jobType} · {job.status} · {formatJobAttemptLabel(job)}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
