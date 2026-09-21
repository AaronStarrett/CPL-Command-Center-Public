import { getServerRuntime } from "@bea/database";
import { PERMISSIONS } from "@bea/security";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Link,
  PageHeader,
  Table,
  TableFoundation,
} from "@bea/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { requirePermission } from "@/lib/auth/authorization";
import {
  displayContactName,
  formatDate,
  formatDateTime,
  safeText,
  statusTone,
} from "@/lib/phase1-presentation";

export const metadata: Metadata = { title: "Contact Detail" };
export const dynamic = "force-dynamic";

export default async function ContactDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission(PERMISSIONS.CONTACTS_VIEW, "contact-detail");
  const runtime = await getServerRuntime();
  const { id } = await params;
  const contact = await runtime.phase1.getContact(id);
  if (!contact) notFound();
  const [companyDecision, taskDecision, taskReadScope, activityDecision, communicationsDecision] =
    await Promise.all([
      runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.COMPANIES_VIEW),
      runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.TASKS_VIEW),
      runtime.authorization.taskReadScopeForUser(session.personaId),
      runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.ACTIVITIES_VIEW),
      runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.COMMUNICATIONS_VIEW),
    ]);
  const [company, tasks, activities] = await Promise.all([
    companyDecision.allowed && contact.companyId
      ? runtime.phase1.getCompany(contact.companyId)
      : Promise.resolve(null),
    taskDecision.allowed
      ? runtime.phase1.listTasks({
          contactId: contact.id,
          limit: 100,
          ...(taskReadScope !== "all" ? { assigneeUserId: session.personaId } : {}),
        })
      : Promise.resolve([]),
    activityDecision.allowed
      ? runtime.phase1.listActivities({ contactId: contact.id, limit: 50 })
      : Promise.resolve([]),
  ]);

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Contact record"
        title={displayContactName(contact)}
        description={safeText(contact.jobTitle, "Job title not recorded")}
        actions={<Badge tone={statusTone(contact.status)}>{contact.status}</Badge>}
      />
      <Card>
        <CardHeader>
          <CardTitle>Contact details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="bea-meta-list">
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
            <div>
              <dt>Email</dt>
              <dd>{safeText(contact.email)}</dd>
            </div>
            <div>
              <dt>Phone</dt>
              <dd>{safeText(contact.phone)}</dd>
            </div>
            <div>
              <dt>Notes</dt>
              <dd className="bea-preserve-lines">{safeText(contact.notes)}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{formatDateTime(contact.createdAt)}</dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>{formatDateTime(contact.updatedAt)}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
      {taskDecision.allowed ? (
        <Card>
          <CardHeader>
            <CardTitle>Tasks</CardTitle>
          </CardHeader>
          <CardContent>
            {tasks.length ? (
              <TableFoundation>
                <Table>
                  <thead>
                    <tr>
                      <th scope="col">Task</th>
                      <th scope="col">Priority</th>
                      <th scope="col">Status</th>
                      <th scope="col">Due</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tasks.map((task) => (
                      <tr key={task.id}>
                        <td>
                          <Link href={`/tasks/${encodeURIComponent(task.id)}`}>{task.title}</Link>
                        </td>
                        <td>
                          <Badge tone={statusTone(task.priority)}>{task.priority}</Badge>
                        </td>
                        <td>
                          <Badge tone={statusTone(task.status)}>{task.status}</Badge>
                        </td>
                        <td>{formatDate(task.dueAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </TableFoundation>
            ) : (
              <EmptyState title="No tasks" description="No tasks are linked to this contact." />
            )}
          </CardContent>
        </Card>
      ) : null}
      {activityDecision.allowed ? (
        <Card>
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
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
              <p>No activity is linked to this contact.</p>
            )}
          </CardContent>
        </Card>
      ) : null}
      {communicationsDecision.allowed ? (
        <Card>
          <CardHeader>
            <div className="bea-record-heading">
              <CardTitle>Recent communications</CardTitle>
              <Badge>PLANNED</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <p>Communication ingestion and message history are deferred beyond Phase 1.</p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
