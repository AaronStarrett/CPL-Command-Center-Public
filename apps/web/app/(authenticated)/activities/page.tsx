import { getServerRuntime } from "@bea/database";
import { PERMISSIONS } from "@bea/security";
import { Badge, EmptyState, Link, PageHeader, Table, TableFoundation } from "@bea/ui";
import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/authorization";
import { formatDateTime, statusTone } from "@/lib/phase1-presentation";

export const metadata: Metadata = { title: "Activities" };
export const dynamic = "force-dynamic";

export default async function ActivitiesPage() {
  const session = await requirePermission(PERMISSIONS.ACTIVITIES_VIEW, "activities");
  const runtime = await getServerRuntime();
  const [activities, companyDecision, contactDecision, taskDecision] = await Promise.all([
    runtime.phase1.listActivities({ limit: 100 }),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.COMPANIES_VIEW),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.CONTACTS_VIEW),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.TASKS_VIEW),
  ]);

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Operational evidence"
        title="Activity"
        description="Chronological business activity from the Phase 1 SQL record store."
        actions={<Badge tone="info">Latest {activities.length}</Badge>}
      />
      {activities.length ? (
        <TableFoundation>
          <Table>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Type</th>
                <th scope="col">Summary</th>
                <th scope="col">Related record</th>
                <th scope="col">Actor</th>
              </tr>
            </thead>
            <tbody>
              {activities.map((activity) => {
                const related =
                  activity.taskId && taskDecision.allowed ? (
                    <Link href={`/tasks/${encodeURIComponent(activity.taskId)}`}>Task</Link>
                  ) : activity.contactId && contactDecision.allowed ? (
                    <Link href={`/contacts/${encodeURIComponent(activity.contactId)}`}>
                      Contact
                    </Link>
                  ) : activity.companyId && companyDecision.allowed ? (
                    <Link href={`/companies/${encodeURIComponent(activity.companyId)}`}>
                      Company
                    </Link>
                  ) : (
                    "—"
                  );
                return (
                  <tr key={activity.id}>
                    <td>{formatDateTime(activity.createdAt)}</td>
                    <td>
                      <Badge tone={statusTone(activity.type)}>{activity.type}</Badge>
                    </td>
                    <td>{activity.summary}</td>
                    <td>{related}</td>
                    <td>
                      {activity.actorUserId ? (
                        <span className="bea-code">{activity.actorUserId.slice(0, 8)}…</span>
                      ) : (
                        "System"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </TableFoundation>
      ) : (
        <EmptyState
          title="No activity yet"
          description="No Phase 1 activity records are available."
        />
      )}
    </div>
  );
}
