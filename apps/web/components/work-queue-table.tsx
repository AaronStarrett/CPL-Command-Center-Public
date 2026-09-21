import type { OperationalWorkItem } from "@bea/domain";
import { Badge, EmptyState, Link, Table, TableFoundation } from "@bea/ui";

import { formatDateTime } from "@/lib/phase1-presentation";
import { formatDurationMs } from "@/lib/operations-presentation";
import { workDueLabel, workKindLabel, workStatusTone } from "@/lib/work-presentation";

export function WorkQueueTable({
  items,
  testId,
  emptyTitle,
  emptyDescription,
}: {
  items: readonly OperationalWorkItem[];
  testId: string;
  emptyTitle: string;
  emptyDescription: string;
}) {
  if (items.length === 0) {
    return (
      <div data-testid={testId}>
        <EmptyState title={emptyTitle} description={emptyDescription} />
      </div>
    );
  }
  const now = new Date();
  return (
    <TableFoundation>
      <Table data-testid={testId}>
        <thead>
          <tr>
            <th>Reference</th>
            <th>Kind</th>
            <th>Status</th>
            <th>Queue</th>
            <th>Owner</th>
            <th>Due</th>
            <th>Age</th>
            <th>Escalation</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} data-testid={`work-row-${item.reference}`}>
              <td>
                <Link href={`/work/${item.id}`}>{item.reference}</Link>
                <div>{item.title}</div>
              </td>
              <td>{workKindLabel(item.workItemKind)}</td>
              <td>
                <Badge tone={workStatusTone(item.status)}>{item.status}</Badge>
              </td>
              <td>{item.queueKey}</td>
              <td data-testid={`work-owner-${item.reference}`}>
                {item.claimedUserId ?? item.assignedUserId ?? item.assignedRoleKey ?? "Unassigned"}
              </td>
              <td>
                {workDueLabel(item, now)}
                {item.dueAt ? <div>{formatDateTime(item.dueAt)}</div> : null}
              </td>
              <td>{formatDurationMs(Math.max(0, now.getTime() - Date.parse(item.availableAt)))}</td>
              <td>{item.escalationLevel}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </TableFoundation>
  );
}
