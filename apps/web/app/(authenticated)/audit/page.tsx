import { PERMISSIONS } from "@bea/security";
import { Badge, EmptyState, PageHeader, Table, TableFoundation } from "@bea/ui";
import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/authorization";
import { recentDemoAuditEvents } from "@/lib/demo-audit";
import { formatDateTime, statusTone } from "@/lib/phase1-presentation";

export const metadata: Metadata = { title: "Audit" };
export const dynamic = "force-dynamic";

export default async function AuditPage() {
  await requirePermission(PERMISSIONS.AUDIT_VIEW, "audit");
  const events = await recentDemoAuditEvents(100);

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Restricted evidence"
        title="Audit"
        description="Durable authentication, authorization, workflow, integration, and record evidence."
        actions={<Badge tone="warning">Restricted</Badge>}
      />
      {events.length ? (
        <TableFoundation>
          <Table>
            <thead>
              <tr>
                <th scope="col">Timestamp</th>
                <th scope="col">Event</th>
                <th scope="col">Action</th>
                <th scope="col">Outcome</th>
                <th scope="col">Actor</th>
                <th scope="col">Correlation</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td>{formatDateTime(event.createdAt)}</td>
                  <td>{event.eventType}</td>
                  <td>{event.action}</td>
                  <td>
                    <Badge tone={statusTone(event.outcome)}>{event.outcome}</Badge>
                  </td>
                  <td>
                    {event.actorUserId ? (
                      <span className="bea-code">{event.actorUserId.slice(0, 8)}…</span>
                    ) : (
                      "System"
                    )}
                  </td>
                  <td>
                    {event.correlationId ? (
                      <span className="bea-code">{event.correlationId}</span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableFoundation>
      ) : (
        <EmptyState
          title="No audit events"
          description="No persisted audit events are available."
        />
      )}
    </div>
  );
}
