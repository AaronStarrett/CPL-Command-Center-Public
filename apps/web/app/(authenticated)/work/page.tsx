import { getServerRuntime } from "@bea/database";
import {
  isOpenWorkItemStatus,
  SALES_COMMERCIAL_WORK_KINDS,
  workItemIsAtRisk,
  workItemIsOverdue,
  WORK_CONTROL_SYNTHETIC_DISCLOSURE,
} from "@bea/domain";
import { PERMISSIONS } from "@bea/security";
import { Badge, Card, CardContent, CardHeader, CardTitle, PageHeader } from "@bea/ui";
import type { Metadata } from "next";

import { WorkQueueTable } from "@/components/work-queue-table";
import {
  SyntheticFixtureBadge,
  SyntheticFixtureBanner,
} from "@/components/synthetic-fixture-banner";
import { requireAnyPermission, requireSession } from "@/lib/auth/authorization";
import { restrictWorkItemsForActor } from "@/lib/work-access";
import { formatDurationMs } from "@/lib/operations-presentation";

export const metadata: Metadata = { title: "My Work" };
export const dynamic = "force-dynamic";

export default async function MyWorkPage() {
  const session = await requireSession();
  await requireAnyPermission([PERMISSIONS.WORK_VIEW, PERMISSIONS.PROPOSALS_WORK_VIEW], "work");
  const runtime = await getServerRuntime();
  const fullView = (
    await runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.WORK_VIEW)
  ).allowed;
  const now = new Date();
  const items = restrictWorkItemsForActor(
    await runtime.workControl.repository.listWorkItems({ limit: 300 }),
    { hasFullWorkView: fullView },
  );
  const mine = items.filter(
    (item) => item.assignedUserId === session.personaId || item.claimedUserId === session.personaId,
  );
  const assigned = mine.filter((item) => isOpenWorkItemStatus(item.status));
  const dueSoon = assigned.filter((item) => workItemIsAtRisk(item.dueAt, item.availableAt, now));
  const overdue = assigned.filter((item) => workItemIsOverdue(item.dueAt, now));
  const blocked = assigned.filter((item) => item.status === "blocked");
  const escalated = assigned.filter((item) => item.escalationLevel !== "none");
  const recentlyCompleted = mine.filter((item) => item.status === "completed").slice(0, 20);
  const metrics = await runtime.workControl.metrics(
    now,
    fullView ? {} : { kinds: [...SALES_COMMERCIAL_WORK_KINDS] },
  );

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Operational work queue"
        title="My Work"
        description="Assigned and claimed work that is waiting on you. Completing a work item never bypasses the protected inspection or report command."
        actions={
          <div className="bea-cluster">
            <Badge tone="info">{assigned.length} open</Badge>
            <SyntheticFixtureBadge synthetic />
          </div>
        }
      />
      <SyntheticFixtureBanner synthetic />
      <p className="bea-muted" data-testid="work-synthetic-disclosure">
        {WORK_CONTROL_SYNTHETIC_DISCLOSURE}
      </p>
      <Card>
        <CardHeader>
          <CardTitle>Workload snapshot</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="bea-cluster" data-testid="work-metrics">
            <Badge tone="warning">Open count {metrics.open}</Badge>
            <Badge tone="warning">Due soon count {metrics.dueSoon}</Badge>
            <Badge tone="danger">Overdue count {metrics.overdue}</Badge>
            <Badge tone="danger">Blocked count {metrics.blocked}</Badge>
            <Badge tone="info">Escalated count {metrics.escalated}</Badge>
            <Badge tone="neutral">Unassigned count {metrics.unassigned}</Badge>
            <span>P50 age {formatDurationMs(metrics.p50AgeMs)}</span>
            <span>P90 age {formatDurationMs(metrics.p90AgeMs)}</span>
            <span>Avg waiting {formatDurationMs(metrics.averageAgeMs)}</span>
          </div>
          <p className="bea-muted">
            Synthetic metrics from persisted work items. Count badges are item counts. Age values
            are elapsed milliseconds from availableAt. This is not a proven four-to-five-day
            reduction.
          </p>
        </CardContent>
      </Card>
      <section>
        <h2>Assigned to me</h2>
        <WorkQueueTable
          items={assigned}
          testId="work-my-queue"
          emptyTitle="No assigned work"
          emptyDescription="Role-queue items appear here after you claim them. Seeded correction and review items are available in Team queues."
        />
      </section>
      <section>
        <h2>Due soon</h2>
        <WorkQueueTable
          items={dueSoon}
          testId="work-due-soon"
          emptyTitle="Nothing due soon"
          emptyDescription="Items approaching the synthetic due threshold appear here."
        />
      </section>
      <section>
        <h2>Overdue</h2>
        <WorkQueueTable
          items={overdue}
          testId="work-overdue"
          emptyTitle="Nothing overdue"
          emptyDescription="Overdue is derived from due time, not a manual status."
        />
      </section>
      <section>
        <h2>Blocked</h2>
        <WorkQueueTable
          items={blocked}
          testId="work-blocked"
          emptyTitle="No blocked work"
          emptyDescription="Blocked items require a structured reason."
        />
      </section>
      <section>
        <h2>Escalated</h2>
        <WorkQueueTable
          items={escalated}
          testId="work-escalated"
          emptyTitle="No escalations"
          emptyDescription="Watch, at-risk, breached, and critical items appear here."
        />
      </section>
      <section>
        <h2>Recently completed</h2>
        <WorkQueueTable
          items={recentlyCompleted}
          testId="work-completed"
          emptyTitle="No recent completions"
          emptyDescription="Domain events close work items automatically."
        />
      </section>
    </div>
  );
}
