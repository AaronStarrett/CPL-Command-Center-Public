import { getServerRuntime } from "@bea/database";
import { isSalesCommercialWorkKind } from "@bea/domain";
import {
  OWNER_ONLY_WORK_ITEM_KINDS,
  WORK_CONTROL_SYNTHETIC_DISCLOSURE,
  WORK_ITEM_REQUIRED_ACTIONS,
} from "@bea/domain";
import { PERMISSIONS } from "@bea/security";
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Link,
  PageHeader,
  Table,
  TableFoundation,
} from "@bea/ui";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import {
  SyntheticFixtureBadge,
  SyntheticFixtureBanner,
} from "@/components/synthetic-fixture-banner";
import { WorkItemActions } from "@/components/work-item-actions";
import { requireAnyPermission, requireSession } from "@/lib/auth/authorization";
import { formatDurationMs } from "@/lib/operations-presentation";
import { formatDateTime } from "@/lib/phase1-presentation";
import { workDueLabel, workKindLabel, workStatusTone } from "@/lib/work-presentation";

export const metadata: Metadata = { title: "Work item" };
export const dynamic = "force-dynamic";

export default async function WorkItemDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  await requireAnyPermission([PERMISSIONS.WORK_VIEW, PERMISSIONS.PROPOSALS_WORK_VIEW], "work");
  const { id } = await params;
  const runtime = await getServerRuntime();
  const fullView = (
    await runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.WORK_VIEW)
  ).allowed;
  const item = await runtime.workControl.repository.getWorkItem(id);
  if (!item) notFound();
  if (!fullView && !isSalesCommercialWorkKind(item.workItemKind)) notFound();
  const [
    assignments,
    events,
    reminders,
    escalations,
    canClaimFull,
    canClaimCommercial,
    canUpdate,
    canReassign,
    canRetryAutomation,
  ] = await Promise.all([
    runtime.workControl.repository.listAssignments(id),
    runtime.workControl.repository.listWorkItemEvents(id),
    runtime.workControl.repository.listReminders(id),
    runtime.workControl.repository.listEscalations(id),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.WORK_CLAIM),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.PROPOSALS_WORK_CLAIM),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.WORK_UPDATE),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.WORK_REASSIGN),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.INTEGRATIONS_MANAGE),
  ]);
  const canClaim = {
    allowed:
      canClaimFull.allowed ||
      (canClaimCommercial.allowed && isSalesCommercialWorkKind(item.workItemKind)),
  };
  const now = new Date();
  const ownerOnly = OWNER_ONLY_WORK_ITEM_KINDS.includes(item.workItemKind);
  const ageMs = Math.max(0, now.getTime() - Date.parse(item.availableAt));

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow={item.reference}
        title={item.title}
        description={item.reason}
        actions={
          <div className="bea-cluster">
            <Badge tone={workStatusTone(item.status)}>{item.status}</Badge>
            <SyntheticFixtureBadge synthetic={item.synthetic} />
          </div>
        }
      />
      <SyntheticFixtureBanner synthetic={item.synthetic} />
      <p className="bea-muted">{WORK_CONTROL_SYNTHETIC_DISCLOSURE}</p>
      <Alert tone="info" data-testid="work-item-detail">
        Why this exists: {item.reason}
      </Alert>
      <Card>
        <CardHeader>
          <CardTitle>Next required action</CardTitle>
        </CardHeader>
        <CardContent>
          <p data-testid="work-required-action">
            {item.requiredAction || WORK_ITEM_REQUIRED_ACTIONS[item.workItemKind]}
          </p>
          <p>
            Completes from event{" "}
            {item.completionEventType ?? "the matching domain completion event"}. Manual complete is
            refused for critical workflow items.
          </p>
          <Link href={item.deepLink}>Open protected domain record</Link>
        </CardContent>
      </Card>
      <WorkItemActions
        workItemId={item.id}
        expectedVersion={item.version}
        canClaim={canClaim.allowed}
        canUpdate={canUpdate.allowed}
        canReassign={canReassign.allowed}
        canRetryAutomation={
          canRetryAutomation.allowed && item.workItemKind === "automation_failure"
        }
        jobId={item.jobId}
        projectionEventId={
          item.cycleIdentity.startsWith("projection:") ? item.cycleIdentity.split(":")[1] : null
        }
        ownerOnly={ownerOnly}
      />
      <Card>
        <CardHeader>
          <CardTitle>Context</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="bea-stack">
            <div>
              <dt>Kind</dt>
              <dd>{workKindLabel(item.workItemKind)}</dd>
            </div>
            <div>
              <dt>Queue</dt>
              <dd>{item.queueKey}</dd>
            </div>
            <div>
              <dt>Assigned role</dt>
              <dd>{item.assignedRoleKey ?? "Unassigned queue"}</dd>
            </div>
            <div>
              <dt>Assigned user</dt>
              <dd>{item.assignedUserId ?? "Role queue"}</dd>
            </div>
            <div>
              <dt>Claimed user</dt>
              <dd>{item.claimedUserId ?? "Unclaimed"}</dd>
            </div>
            <div>
              <dt>Acknowledged at</dt>
              <dd>
                {item.acknowledgedAt ? formatDateTime(item.acknowledgedAt) : "Not acknowledged"}
              </dd>
            </div>
            <div>
              <dt>Started at</dt>
              <dd>{item.startedAt ? formatDateTime(item.startedAt) : "Not started"}</dd>
            </div>
            <div>
              <dt>Due</dt>
              <dd>
                {workDueLabel(item, now)}
                {item.dueAt ? ` · ${formatDateTime(item.dueAt)}` : ""}
              </dd>
            </div>
            <div>
              <dt>Age</dt>
              <dd>{formatDurationMs(ageMs)}</dd>
            </div>
            <div>
              <dt>Escalation</dt>
              <dd>{item.escalationLevel}</dd>
            </div>
            <div>
              <dt>Reminders</dt>
              <dd>{item.reminderCount}</dd>
            </div>
            <div>
              <dt>Blocked reason</dt>
              <dd>{item.blockedReason ?? "Not blocked"}</dd>
            </div>
            <div>
              <dt>Source event</dt>
              <dd>{item.sourceEventId ?? "Reconciliation or seed"}</dd>
            </div>
            <div>
              <dt>Cycle</dt>
              <dd>{item.cycleIdentity}</dd>
            </div>
            <div>
              <dt>Project / inspection / report</dt>
              <dd>
                {item.projectId ? <Link href="/projects">Project</Link> : "—"}
                {item.inspectionId ? (
                  <>
                    {" · "}
                    <Link href={`/inspections/${item.inspectionId}`}>Inspection</Link>
                  </>
                ) : null}
                {item.reportId ? (
                  <>
                    {" · "}
                    <Link href={`/reports/${item.reportId}`}>Report</Link>
                  </>
                ) : null}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Reminder history</CardTitle>
        </CardHeader>
        <CardContent>
          <TableFoundation>
            <Table data-testid="work-reminders">
              <thead>
                <tr>
                  <th>Threshold</th>
                  <th>Scheduled</th>
                  <th>Policy</th>
                </tr>
              </thead>
              <tbody>
                {reminders.map((reminder) => (
                  <tr key={reminder.id}>
                    <td>{reminder.thresholdKey}</td>
                    <td>{formatDateTime(reminder.scheduledFor)}</td>
                    <td>v{reminder.policyVersion}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableFoundation>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Escalation history</CardTitle>
        </CardHeader>
        <CardContent>
          <TableFoundation>
            <Table data-testid="work-escalations">
              <thead>
                <tr>
                  <th>Level</th>
                  <th>Reason</th>
                  <th>Owner visible</th>
                  <th>Created</th>
                  <th>Resolved</th>
                </tr>
              </thead>
              <tbody>
                {escalations.map((escalation) => (
                  <tr key={escalation.id}>
                    <td>{escalation.escalationLevel}</td>
                    <td>{escalation.reason}</td>
                    <td>{escalation.ownerVisible ? "Yes" : "No"}</td>
                    <td>{formatDateTime(escalation.createdAt)}</td>
                    <td>
                      {escalation.resolvedAt ? formatDateTime(escalation.resolvedAt) : "Open"}
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
          <CardTitle>Assignment history</CardTitle>
        </CardHeader>
        <CardContent>
          <TableFoundation>
            <Table>
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Role</th>
                  <th>User</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {assignments.map((assignment) => (
                  <tr key={String(assignment.id)}>
                    <td>{String(assignment.action)}</td>
                    <td>{String(assignment.assignedRoleKey ?? "—")}</td>
                    <td>{String(assignment.claimedUserId ?? assignment.assignedUserId ?? "—")}</td>
                    <td>{formatDateTime(String(assignment.createdAt))}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableFoundation>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Audit timeline</CardTitle>
        </CardHeader>
        <CardContent>
          <TableFoundation>
            <Table data-testid="work-timeline">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>From</th>
                  <th>To</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={String(event.id)}>
                    <td>{String(event.eventType)}</td>
                    <td>{String(event.fromStatus ?? "—")}</td>
                    <td>{String(event.toStatus ?? "—")}</td>
                    <td>{formatDateTime(String(event.createdAt))}</td>
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
