import { getServerRuntime } from "@bea/database";
import { isOpenWorkItemStatus, WORK_CONTROL_SYNTHETIC_DISCLOSURE } from "@bea/domain";
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
import { SALES_COMMERCIAL_QUEUE_KEYS, WORK_QUEUE_SECTIONS } from "@/lib/work-presentation";

export const metadata: Metadata = { title: "Team queues" };
export const dynamic = "force-dynamic";

export default async function WorkQueuesPage() {
  const session = await requireAnyPermission(
    [PERMISSIONS.WORK_VIEW, PERMISSIONS.PROPOSALS_WORK_VIEW],
    "work",
  );
  const runtime = await getServerRuntime();
  const fullView = (
    await runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.WORK_VIEW)
  ).allowed;
  const items = restrictWorkItemsForActor(
    (await runtime.workControl.repository.listWorkItems({ limit: 300 })).filter((item) =>
      isOpenWorkItemStatus(item.status),
    ),
    { hasFullWorkView: fullView },
  );
  const sections = fullView
    ? WORK_QUEUE_SECTIONS
    : WORK_QUEUE_SECTIONS.filter((section) =>
        (SALES_COMMERCIAL_QUEUE_KEYS as readonly string[]).includes(section.key),
      );

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Role queues"
        title="Team queues"
        description="Claimable operational work by inspection-to-report gate. Claiming does not execute the underlying domain action."
        actions={
          <div className="bea-cluster">
            <Badge tone="info">{items.length} open</Badge>
            <SyntheticFixtureBadge synthetic />
          </div>
        }
      />
      <SyntheticFixtureBanner synthetic />
      <p className="bea-muted">{WORK_CONTROL_SYNTHETIC_DISCLOSURE}</p>
      {sections.map((section) => (
        <section key={section.key} data-testid={`work-queue-section-${section.key}`}>
          <h2>{section.label}</h2>
          <WorkQueueTable
            items={items.filter((item) => item.queueKey === section.key)}
            testId={`work-queue-${section.key}`}
            emptyTitle={`No ${section.label.toLowerCase()} items`}
            emptyDescription="This queue is empty until a matching domain event creates work."
          />
        </section>
      ))}
    </div>
  );
}
