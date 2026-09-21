import { getServerRuntime } from "@bea/database";
import { PERMISSIONS } from "@bea/security";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  FormField,
  Link,
  PageHeader,
  Select,
} from "@bea/ui";
import type { Metadata } from "next";

import { NotificationReadButton } from "@/components/notification-read-button";
import { requirePermission } from "@/lib/auth/authorization";
import { formatDateTime } from "@/lib/phase1-presentation";
import { safeInternalHref } from "@/lib/safe-return-path";

export const metadata: Metadata = { title: "Notifications" };
export const dynamic = "force-dynamic";

function safeSourceHref(value: string | null): string | undefined {
  return safeInternalHref(value) ?? undefined;
}

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePermission(PERMISSIONS.NOTIFICATIONS_VIEW, "notifications");
  const runtime = await getServerRuntime();
  const query = await searchParams;
  const unreadOnly = query.view === "unread";
  const [
    notifications,
    manageDecision,
    companyDecision,
    contactDecision,
    taskDecision,
    workflowDecision,
  ] = await Promise.all([
    runtime.phase1.listNotifications({
      userId: session.personaId,
      limit: 100,
      ...(unreadOnly ? { unreadOnly: true } : {}),
    }),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.NOTIFICATIONS_MANAGE),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.COMPANIES_VIEW),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.CONTACTS_VIEW),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.TASKS_VIEW),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.WORKFLOW_VIEW),
  ]);

  function mayOpenSource(sourceType: string | null): boolean {
    if (!sourceType) return false;
    if (sourceType === "company") return companyDecision.allowed;
    if (sourceType === "contact") return contactDecision.allowed;
    if (sourceType === "task") return taskDecision.allowed;
    if (sourceType === "workflow-run") return workflowDecision.allowed;
    return false;
  }

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Personal workspace"
        title="Notifications"
        description="Notifications are scoped to the current signed-in account."
        actions={<Badge tone="info">{notifications.length} shown</Badge>}
      />
      <form action="/notifications" className="bea-filter-bar bea-filter-bar--compact">
        <FormField label="View" htmlFor="notification-view">
          <Select id="notification-view" name="view" defaultValue={unreadOnly ? "unread" : "all"}>
            <option value="all">All notifications</option>
            <option value="unread">Unread only</option>
          </Select>
        </FormField>
        <Button type="submit" variant="secondary">
          Apply filter
        </Button>
      </form>
      {notifications.length ? (
        <div className="bea-notification-list bea-animated-list">
          {notifications.map((notification) => {
            const sourceHref = mayOpenSource(notification.sourceType)
              ? safeSourceHref(notification.sourceHref)
              : undefined;
            return (
              <Card
                key={notification.id}
                className={`bea-list-presence-item${notification.readAt ? "" : " bea-card--unread"}`}
                data-list-state="idle"
              >
                <CardHeader>
                  <div className="bea-record-heading">
                    <CardTitle>{notification.title}</CardTitle>
                    <Badge tone={notification.readAt ? "neutral" : "warning"}>
                      {notification.readAt ? "Read" : "Unread"}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="bea-stack">
                  <p>{notification.body}</p>
                  <div className="bea-record-actions">
                    <time dateTime={notification.createdAt}>
                      {formatDateTime(notification.createdAt)}
                    </time>
                    {sourceHref ? <Link href={sourceHref}>Open related record</Link> : null}
                    {!notification.readAt && manageDecision.allowed ? (
                      <NotificationReadButton notificationId={notification.id} />
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <EmptyState
          title="No notifications"
          description={
            unreadOnly
              ? "There are no unread notifications for this account."
              : "There are no notifications for this account."
          }
        />
      )}
    </div>
  );
}
