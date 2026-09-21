import { getServerRuntime } from "@bea/database";
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

import { InspectionSubmitActions } from "@/components/inspection-submit-actions";
import { InspectionReadinessActions } from "@/components/inspection-readiness-actions";
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
  inspectionStatusLabel,
  isSyntheticOperationsFixture,
  operationsStatusTone,
  reportStatusLabel,
} from "@/lib/operations-presentation";
import { computeMetrics } from "@bea/database";

export const metadata: Metadata = { title: "Inspection record" };
export const dynamic = "force-dynamic";

export default async function InspectionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requirePermission(PERMISSIONS.INSPECTIONS_VIEW, "inspection-detail");
  const runtime = await getServerRuntime();
  const { id } = await params;
  const inspection = await runtime.operations.repository.getInspection(id);
  if (!inspection) notFound();
  const [
    project,
    submission,
    validation,
    report,
    sla,
    exceptions,
    events,
    jobs,
    submitDecision,
    correctDecision,
  ] = await Promise.all([
    runtime.operations.repository.getProject(inspection.projectId),
    runtime.operations.repository.getLatestSubmission(inspection.id),
    runtime.operations.repository.latestValidation(inspection.id),
    runtime.operations.repository.getReportByInspection(inspection.id),
    runtime.operations.repository.getSlaClock(inspection.id),
    runtime.operations.repository.listExceptionsForInspection(inspection.id),
    runtime.operations.repository.listTimeline(inspection.id),
    runtime.operations.repository.listJobsForInspection(inspection.id),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.INSPECTIONS_SUBMIT),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.INSPECTIONS_CORRECT),
  ]);
  const findings = submission
    ? await runtime.operations.repository.listFindings(submission.id)
    : [];
  const evidence = submission
    ? await runtime.operations.repository.listEvidence(submission.id)
    : [];
  const versions = report ? await runtime.operations.repository.listReportVersions(report.id) : [];
  const metrics = computeMetrics(inspection, report, sla, new Date().toISOString());
  const projected = projectInspectionSubmission({
    canViewSensitive: canViewInspectionSensitive({
      roleIds: session.roleIds,
      userId: session.personaId,
    }),
    submission,
    findings,
    evidence,
  });
  const synthetic = isSyntheticOperationsFixture(
    runtime.environment.appMode,
    project?.acceptedScopeSnapshot ?? null,
  );
  const openException = exceptions.find(
    (item) => item.status === "open" || item.status === "assigned" || item.status === "in_progress",
  );
  const blockerOwner = openException?.ownerDisplayName ?? openException?.ownerUserId ?? null;

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Canonical inspection"
        title={inspection.reference}
        description={`${project?.clientName ?? "Unknown client"} · ${project?.siteName ?? "Unknown site"}`}
        actions={
          <div className="bea-cluster">
            <Badge tone={operationsStatusTone(inspection.status)}>
              {inspectionStatusLabel(inspection.status)}
            </Badge>
            <SyntheticFixtureBadge synthetic={synthetic} />
          </div>
        }
      />
      <SyntheticFixtureBanner synthetic={synthetic} />
      <Card>
        <CardHeader>
          <CardTitle>Schedule and assignment</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="bea-meta-list">
            <div>
              <dt>Project</dt>
              <dd>{project ? <Link href="/projects">{project.reference}</Link> : "—"}</dd>
            </div>
            <div>
              <dt>Service</dt>
              <dd>{inspection.serviceKey}</dd>
            </div>
            <div>
              <dt>Scheduled</dt>
              <dd>{formatDateTime(inspection.scheduledAt)}</dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd>{formatDateTime(inspection.startedAt)}</dd>
            </div>
            <div>
              <dt>Completed</dt>
              <dd>{formatDateTime(inspection.completedAt)}</dd>
            </div>
            <div>
              <dt>Submitted</dt>
              <dd>{formatDateTime(inspection.submittedAt)}</dd>
            </div>
            <div>
              <dt>Configuration release</dt>
              <dd>
                {inspection.configurationReleaseId ? (
                  <Link href={`/configuration/releases/${inspection.configurationReleaseId}`}>
                    Bound release
                  </Link>
                ) : (
                  "Phase 3.0 fixture (no configuration release)"
                )}
              </dd>
            </div>
            <div>
              <dt>Inspection type</dt>
              <dd>{inspection.inspectionType ?? "—"}</dd>
            </div>
            <div>
              <dt>Turnaround age</dt>
              <dd data-testid="inspection-age">{formatDurationMs(metrics.currentAgeMs)}</dd>
            </div>
            <div>
              <dt>Paused duration</dt>
              <dd data-testid="inspection-paused">
                {formatDurationMs(metrics.pausedDurationMs)}
                {metrics.pauseReason ? ` · ${metrics.pauseReason}` : ""}
              </dd>
            </div>
            <div>
              <dt>Blocker owner</dt>
              <dd data-testid="inspection-blocker-owner">{blockerOwner ?? "None"}</dd>
            </div>
            <div>
              <dt>SLA</dt>
              <dd>
                {metrics.slaStatus} · remaining {formatDurationMs(metrics.slaRemainingMs)} · elapsed{" "}
                {formatDurationMs(metrics.slaElapsedMs)}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Readiness checklist</CardTitle>
        </CardHeader>
        <CardContent>
          <p>
            <Link href={`/inspections/${inspection.id}/ingest`}>
              Open package-ingestion workspace
            </Link>
          </p>
          <InspectionReadinessActions
            inspectionId={inspection.id}
            canManage={submitDecision.allowed || correctDecision.allowed}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Submit inspection data</CardTitle>
        </CardHeader>
        <CardContent>
          <InspectionSubmitActions
            inspectionId={inspection.id}
            canSubmit={submitDecision.allowed}
            canCorrect={correctDecision.allowed}
            needsCorrection={inspection.status === "needs_correction"}
          />
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
            <EmptyState
              title="Not validated yet"
              description="Submit inspection data to run deterministic validation."
            />
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
          <CardTitle>Report</CardTitle>
        </CardHeader>
        <CardContent>
          {report ? (
            <p>
              <Link href={`/reports/${report.id}`}>{report.reference}</Link>{" "}
              <Badge tone={operationsStatusTone(report.status)}>
                {reportStatusLabel(report.status)}
              </Badge>{" "}
              version {report.currentVersionNumber}
            </p>
          ) : (
            <p>No report yet.</p>
          )}
          {versions.length > 0 ? (
            <ul>
              {versions.map((version) => (
                <li key={version.id}>
                  v{version.versionNumber} · {version.status}
                  {version.reviewDecision ? ` · ${version.reviewDecision}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Exceptions</CardTitle>
        </CardHeader>
        <CardContent>
          {exceptions.length === 0 ? (
            <p>No exceptions.</p>
          ) : (
            <ul>
              {exceptions.map((exception) => (
                <li key={exception.id}>
                  <Link href="/exceptions">{exception.reference}</Link> · {exception.status} ·{" "}
                  {exception.title}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Event timeline</CardTitle>
        </CardHeader>
        <CardContent>
          <TableFoundation>
            <Table data-testid="inspection-timeline">
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
          <ul data-testid="inspection-jobs">
            {jobs.map((job) => (
              <li key={job.id}>
                {job.jobType} · {job.status} · {formatJobAttemptLabel(job)}
                {job.lastError && "message" in job.lastError
                  ? ` · ${String(job.lastError.message)}`
                  : ""}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
