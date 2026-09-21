import { getServerRuntime } from "@bea/database";
import { EMAIL_DRY_RUN_DISCLOSURE, TEAMS_DRY_RUN_DISCLOSURE } from "@bea/domain";
import { PERMISSIONS } from "@bea/security";
import { Alert, Badge, EmptyState, Link, PageHeader, Table, TableFoundation } from "@bea/ui";
import type { Metadata } from "next";

import {
  SyntheticFixtureBadge,
  SyntheticFixtureBanner,
} from "@/components/synthetic-fixture-banner";
import { requirePermission } from "@/lib/auth/authorization";
import { formatDateTime } from "@/lib/phase1-presentation";

export const metadata: Metadata = { title: "Notification outbox" };
export const dynamic = "force-dynamic";

export default async function WorkNotificationsPage() {
  await requirePermission(PERMISSIONS.WORK_NOTIFICATIONS_VIEW, "work");
  const runtime = await getServerRuntime();
  const items = await runtime.workControl.repository.listNotifications();

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Planned notifications"
        title="Notification outbox"
        description="In-app records are real. Email and Teams rows are dry-run manifests only."
        actions={
          <div className="bea-cluster">
            <Badge tone="info">{items.length} records</Badge>
            <SyntheticFixtureBadge synthetic />
          </div>
        }
      />
      <SyntheticFixtureBanner synthetic />
      <Alert tone="warning" title="No live messages" data-testid="work-email-dry-run">
        {EMAIL_DRY_RUN_DISCLOSURE}. No Graph call, SMTP, OAuth, or webhook is performed.
      </Alert>
      <Alert tone="warning" title="No Teams posts" data-testid="work-teams-dry-run">
        {TEAMS_DRY_RUN_DISCLOSURE}. Recipient placeholders use .invalid addresses.
      </Alert>
      {items.length === 0 ? (
        <EmptyState
          title="No notification records"
          description="Reminder and escalation thresholds write in-app and dry-run manifests here."
        />
      ) : (
        <TableFoundation>
          <Table data-testid="work-notification-outbox">
            <thead>
              <tr>
                <th>Channel</th>
                <th>Status</th>
                <th>Recipient</th>
                <th>Subject</th>
                <th>Work item</th>
                <th>Adapter result</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} data-testid={`notification-${item.channel}`}>
                  <td>{item.channel}</td>
                  <td>
                    <Badge tone={item.status === "rendered_dry_run" ? "warning" : "info"}>
                      {item.status}
                    </Badge>
                  </td>
                  <td>
                    {item.recipientPlaceholder}
                    <div>{item.recipientRoleKey ?? item.recipientUserId ?? ""}</div>
                  </td>
                  <td>
                    {item.subject}
                    <div>{item.body}</div>
                    {item.suppressionReason ? (
                      <div>Suppressed: {item.suppressionReason}</div>
                    ) : null}
                  </td>
                  <td>
                    {item.workItemId ? (
                      <Link href={`/work/${item.workItemId}`}>Open work item</Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>{item.adapterResult ?? "—"}</td>
                  <td>{formatDateTime(item.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableFoundation>
      )}
    </div>
  );
}
