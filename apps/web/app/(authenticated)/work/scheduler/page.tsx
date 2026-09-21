import { getServerRuntime } from "@bea/database";
import {
  WORK_CONTROL_CODE_DEFINED_POLICY,
  WORK_CONTROL_PRODUCTION_UNCONFIGURED,
  WORK_CONTROL_SYNTHETIC_DISCLOSURE,
} from "@bea/domain";
import { PERMISSIONS } from "@bea/security";
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  Table,
  TableFoundation,
} from "@bea/ui";
import type { Metadata } from "next";

import {
  SyntheticFixtureBadge,
  SyntheticFixtureBanner,
} from "@/components/synthetic-fixture-banner";
import { WorkReconcileActions } from "@/components/work-reconcile-actions";
import { requirePermission, requireSession } from "@/lib/auth/authorization";
import { formatDateTime } from "@/lib/phase1-presentation";

export const metadata: Metadata = { title: "Work scheduler" };
export const dynamic = "force-dynamic";

export default async function WorkSchedulerPage() {
  const session = await requireSession();
  await requirePermission(PERMISSIONS.WORK_SCHEDULES_VIEW, "work");
  const runtime = await getServerRuntime();
  const [schedules, runs, policies, plan, projectionFailures, canExecute, canDryRun] =
    await Promise.all([
      runtime.workControl.repository.listSchedules(),
      runtime.workControl.repository.listReconciliationRuns(),
      runtime.workControl.repository.listPolicies(),
      Promise.resolve(runtime.workControl.triggerProvisioningPlan()),
      runtime.workControl.repository.listProjectionFailures(),
      runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.WORK_RECONCILE),
      runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.WORK_SCHEDULES_MANAGE),
    ]);

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Durable scheduler"
        title="Scheduler and policies"
        description="Missed runs catch up once. Recurring reconciliation is not started from ordinary page loads."
        actions={
          <div className="bea-cluster">
            <Badge tone="info">{schedules.length} schedules</Badge>
            <SyntheticFixtureBadge synthetic />
          </div>
        }
      />
      <SyntheticFixtureBanner synthetic />
      <Alert tone="info">{WORK_CONTROL_SYNTHETIC_DISCLOSURE}</Alert>
      <Alert tone="warning" data-testid="work-production-policy">
        {WORK_CONTROL_PRODUCTION_UNCONFIGURED}
      </Alert>
      <Alert tone="info" data-testid="work-code-defined-policy">
        {WORK_CONTROL_CODE_DEFINED_POLICY}
      </Alert>
      {(canDryRun.allowed || canExecute.allowed) && (
        <WorkReconcileActions canExecute={canExecute.allowed} />
      )}
      <Card>
        <CardHeader>
          <CardTitle>Scheduled actions</CardTitle>
        </CardHeader>
        <CardContent>
          {schedules.length === 0 ? (
            <EmptyState
              title="No schedules"
              description="Reminder, escalation, and reconciliation schedules appear after work items are created."
            />
          ) : (
            <TableFoundation>
              <Table data-testid="work-scheduler">
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Action</th>
                    <th>Status</th>
                    <th>Scheduled for</th>
                    <th>Last evaluated</th>
                    <th>Next run</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {schedules.map((item) => (
                    <tr key={item.id}>
                      <td>{item.scheduleKey}</td>
                      <td>{item.actionType}</td>
                      <td>
                        <Badge tone={item.status === "failed" ? "danger" : "info"}>
                          {item.status}
                        </Badge>
                      </td>
                      <td>{formatDateTime(item.scheduledFor)}</td>
                      <td>{item.lastEvaluatedAt ? formatDateTime(item.lastEvaluatedAt) : "—"}</td>
                      <td>{item.nextRunAt ? formatDateTime(item.nextRunAt) : "—"}</td>
                      <td>{item.lastResult ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableFoundation>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Projection failures</CardTitle>
        </CardHeader>
        <CardContent data-testid="work-projection-failures">
          {projectionFailures.length === 0 ? (
            <EmptyState
              title="No projection failures"
              description="Supported events that fail projection remain retryable here. Intentionally unsupported events are ignored without a failure row."
            />
          ) : (
            <TableFoundation>
              <Table>
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Status</th>
                    <th>Attempts</th>
                    <th>Error</th>
                    <th>Next retry</th>
                  </tr>
                </thead>
                <tbody>
                  {projectionFailures.map((failure) => (
                    <tr key={String(failure.id)}>
                      <td>{String(failure.eventType)}</td>
                      <td>{String(failure.processingStatus)}</td>
                      <td>{String(failure.attemptCount)}</td>
                      <td>
                        {String(failure.errorCode)}: {String(failure.errorMessage)}
                      </td>
                      <td>
                        {failure.nextRetryAt ? formatDateTime(String(failure.nextRetryAt)) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableFoundation>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Reconciliation history</CardTitle>
        </CardHeader>
        <CardContent>
          <TableFoundation>
            <Table data-testid="work-reconciliation-runs">
              <thead>
                <tr>
                  <th>Mode</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Completed stale</th>
                  <th>Unchanged</th>
                  <th>Started</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={String(run.id)}>
                    <td>{String(run.mode)}</td>
                    <td>{String(run.status)}</td>
                    <td>{String(run.createdMissing)}</td>
                    <td>{String(run.completedStale)}</td>
                    <td>{String(run.unchanged)}</td>
                    <td>{formatDateTime(String(run.startedAt))}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableFoundation>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Orchestration policies</CardTitle>
        </CardHeader>
        <CardContent>
          <TableFoundation>
            <Table data-testid="work-policies">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Version</th>
                  <th>Status</th>
                  <th>Synthetic</th>
                  <th>Production ready</th>
                </tr>
              </thead>
              <tbody>
                {policies.map((policy) => (
                  <tr key={policy.id}>
                    <td>{policy.policyKey}</td>
                    <td>{policy.policyVersion}</td>
                    <td>
                      <Badge tone={policy.synthetic ? "warning" : "danger"}>{policy.status}</Badge>
                    </td>
                    <td>{policy.synthetic ? "Yes" : "No"}</td>
                    <td>{policy.productionReady ? "Yes" : "No"}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableFoundation>
          <p className="bea-muted">{policies.find((item) => !item.synthetic)?.disclosure}</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>External trigger provisioning plan</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert tone="warning" data-testid="work-provisioning-plan">
            Status {plan.status}. Live connection: NOT RUN. No subscription is installed.
          </Alert>
          <TableFoundation>
            <Table>
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Mechanism</th>
                  <th>Resource</th>
                  <th>Internal event</th>
                </tr>
              </thead>
              <tbody>
                {plan.items.map((item) => (
                  <tr key={item.source}>
                    <td>{item.source}</td>
                    <td>{item.mechanism}</td>
                    <td>{item.resourceSelection}</td>
                    <td>{item.internalEvent}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableFoundation>
        </CardContent>
      </Card>
    </div>
  );
}
