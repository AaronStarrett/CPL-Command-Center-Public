import { getServerRuntime } from "@bea/database";
import {
  isOpenWorkItemStatus,
  workItemIsAtRisk,
  workItemIsOverdue,
  WORK_CONTROL_SYNTHETIC_DISCLOSURE,
} from "@bea/domain";
import { PERMISSIONS } from "@bea/security";
import { Badge, PageHeader } from "@bea/ui";
import type { Metadata } from "next";

import {
  SyntheticFixtureBadge,
  SyntheticFixtureBanner,
} from "@/components/synthetic-fixture-banner";
import { WorkQueueTable } from "@/components/work-queue-table";
import { requireAnyPermission } from "@/lib/auth/authorization";
import { restrictWorkItemsForActor } from "@/lib/work-access";

export const metadata: Metadata = { title: "At risk work" };
export const dynamic = "force-dynamic";

export default async function AtRiskWorkPage() {
  const session = await requireAnyPermission(
    [PERMISSIONS.WORK_VIEW, PERMISSIONS.PROPOSALS_WORK_VIEW],
    "work",
  );
  const runtime = await getServerRuntime();
  const fullView = (
    await runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.WORK_VIEW)
  ).allowed;
  const now = new Date();
  const open = restrictWorkItemsForActor(
    (await runtime.workControl.repository.listWorkItems({ limit: 300 })).filter((item) =>
      isOpenWorkItemStatus(item.status),
    ),
    { hasFullWorkView: fullView },
  );
  const dueSoon = open.filter((item) => workItemIsAtRisk(item.dueAt, item.availableAt, now));
  const atRisk = open.filter(
    (item) => item.escalationLevel === "at_risk" || item.escalationLevel === "watch",
  );
  const breached = open.filter(
    (item) => item.escalationLevel === "breached" || item.escalationLevel === "critical",
  );
  const overdue = open.filter((item) => workItemIsOverdue(item.dueAt, now));
  const longest = [...open].sort(
    (left, right) => Date.parse(left.availableAt) - Date.parse(right.availableAt),
  );

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Human waiting"
        title="At risk"
        description="Due soon, SLA at risk, breached, critical, and longest-waiting human gates. Wall-clock age remains visible when an SLA is paused."
        actions={
          <div className="bea-cluster">
            <Badge tone="danger">{breached.length} breached</Badge>
            <SyntheticFixtureBadge synthetic />
          </div>
        }
      />
      <SyntheticFixtureBanner synthetic />
      <p className="bea-muted">{WORK_CONTROL_SYNTHETIC_DISCLOSURE}</p>
      <section>
        <h2>Due soon</h2>
        <WorkQueueTable
          items={dueSoon}
          testId="work-at-risk-due-soon"
          emptyTitle="Nothing due soon"
          emptyDescription="Synthetic due-soon threshold has not been crossed."
        />
      </section>
      <section>
        <h2>SLA at risk</h2>
        <WorkQueueTable
          items={atRisk}
          testId="work-at-risk"
          emptyTitle="No at-risk escalations"
          emptyDescription="Watch and at-risk thresholds appear here once."
        />
      </section>
      <section>
        <h2>SLA breached and critical</h2>
        <WorkQueueTable
          items={breached}
          testId="work-breached"
          emptyTitle="No breaches"
          emptyDescription="Owner-visible breached and critical escalations appear here."
        />
      </section>
      <section>
        <h2>Overdue</h2>
        <WorkQueueTable
          items={overdue}
          testId="work-at-risk-overdue"
          emptyTitle="Nothing overdue"
          emptyDescription="Overdue is derived from due time."
        />
      </section>
      <section>
        <h2>Longest waiting human gates</h2>
        <WorkQueueTable
          items={longest}
          testId="work-longest-waiting"
          emptyTitle="No open gates"
          emptyDescription="Oldest open work items appear first."
        />
      </section>
    </div>
  );
}
