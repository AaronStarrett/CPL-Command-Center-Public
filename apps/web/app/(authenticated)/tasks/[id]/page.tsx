import { getServerRuntime } from "@bea/database";
import { PERMISSIONS } from "@bea/security";
import { Badge, Card, CardContent, CardHeader, CardTitle, Link, PageHeader } from "@bea/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { TaskCompleteButton } from "@/components/task-complete-button";
import { requirePermission } from "@/lib/auth/authorization";
import { formatDateTime, safeText, statusTone } from "@/lib/phase1-presentation";

export const metadata: Metadata = { title: "Task Detail" };
export const dynamic = "force-dynamic";

export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission(PERMISSIONS.TASKS_VIEW, "task-detail");
  const runtime = await getServerRuntime();
  const { id } = await params;
  const [
    task,
    manageDecision,
    taskReadScope,
    companyDecision,
    contactDecision,
    activityDecision,
    leadDecision,
  ] = await Promise.all([
    runtime.phase1.getTask(id),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.TASKS_MANAGE),
    runtime.authorization.taskReadScopeForUser(session.personaId),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.COMPANIES_VIEW),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.CONTACTS_VIEW),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.ACTIVITIES_VIEW),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.LEADS_VIEW),
  ]);
  if (!task || (taskReadScope !== "all" && task.assigneeUserId !== session.personaId)) notFound();
  const [company, contact, activities] = await Promise.all([
    companyDecision.allowed && task.companyId
      ? runtime.phase1.getCompany(task.companyId)
      : Promise.resolve(null),
    contactDecision.allowed && task.contactId
      ? runtime.phase1.getContact(task.contactId)
      : Promise.resolve(null),
    activityDecision.allowed
      ? runtime.phase1.listActivities({ taskId: task.id, limit: 50 })
      : Promise.resolve([]),
  ]);

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Task record"
        title={task.title}
        description={safeText(task.description, "No description provided")}
        actions={
          <div className="bea-cluster">
            <Badge tone={statusTone(task.priority)}>{task.priority}</Badge>
            <Badge tone={statusTone(task.status)}>{task.status}</Badge>
            {task.status === "open" && manageDecision.allowed ? (
              <TaskCompleteButton taskId={task.id} />
            ) : null}
          </div>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle>Task details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="bea-meta-list">
            <div>
              <dt>Assignee</dt>
              <dd>
                <span className="bea-code">{task.assigneeUserId}</span>
              </dd>
            </div>
            <div>
              <dt>Due</dt>
              <dd>{formatDateTime(task.dueAt)}</dd>
            </div>
            <div>
              <dt>Completed</dt>
              <dd>{formatDateTime(task.completedAt)}</dd>
            </div>
            {companyDecision.allowed ? (
              <div>
                <dt>Company</dt>
                <dd>
                  {company ? (
                    <Link href={`/companies/${encodeURIComponent(company.id)}`}>
                      {company.name}
                    </Link>
                  ) : (
                    "Not linked"
                  )}
                </dd>
              </div>
            ) : null}
            {contactDecision.allowed ? (
              <div>
                <dt>Contact</dt>
                <dd>
                  {contact ? (
                    <Link href={`/contacts/${encodeURIComponent(contact.id)}`}>
                      {`${contact.firstName} ${contact.lastName}`.trim()}
                    </Link>
                  ) : (
                    "Not linked"
                  )}
                </dd>
              </div>
            ) : null}
            {task.leadId && leadDecision.allowed ? (
              <div>
                <dt>Lead</dt>
                <dd>
                  <Link href={`/leads/${encodeURIComponent(task.leadId)}`}>Linked lead record</Link>
                </dd>
              </div>
            ) : null}
            <div>
              <dt>Created</dt>
              <dd>{formatDateTime(task.createdAt)}</dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>{formatDateTime(task.updatedAt)}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
      {activityDecision.allowed ? (
        <Card>
          <CardHeader>
            <CardTitle>Task activity</CardTitle>
          </CardHeader>
          <CardContent>
            {activities.length ? (
              <ol className="bea-timeline">
                {activities.map((activity) => (
                  <li key={activity.id}>
                    <time dateTime={activity.createdAt}>{formatDateTime(activity.createdAt)}</time>
                    <strong>{activity.summary}</strong>
                  </li>
                ))}
              </ol>
            ) : (
              <p>No activity is linked to this task.</p>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
