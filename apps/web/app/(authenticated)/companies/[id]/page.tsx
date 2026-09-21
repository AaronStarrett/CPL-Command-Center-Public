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

export const metadata: Metadata = { title: "Company Detail" };
export const dynamic = "force-dynamic";

function safeWebsite(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

export default async function CompanyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission(PERMISSIONS.COMPANIES_VIEW, "company-detail");
  const runtime = await getServerRuntime();
  const { id } = await params;
  const company = await runtime.phase1.getCompany(id);
  if (!company) notFound();
  const [contactDecision, taskDecision, taskReadScope, activityDecision, communicationsDecision] =
    await Promise.all([
      runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.CONTACTS_VIEW),
      runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.TASKS_VIEW),
      runtime.authorization.taskReadScopeForUser(session.personaId),
      runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.ACTIVITIES_VIEW),
      runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.COMMUNICATIONS_VIEW),
    ]);
  const [contacts, tasks, activities] = await Promise.all([
    contactDecision.allowed
      ? runtime.phase1.listContacts({ companyId: company.id, limit: 100 })
      : Promise.resolve([]),
    taskDecision.allowed
      ? runtime.phase1.listTasks({
          companyId: company.id,
          limit: 100,
          ...(taskReadScope !== "all" ? { assigneeUserId: session.personaId } : {}),
        })
      : Promise.resolve([]),
    activityDecision.allowed
      ? runtime.phase1.listActivities({ companyId: company.id, limit: 50 })
      : Promise.resolve([]),
  ]);
  const website = safeWebsite(company.website);

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Company record"
        title={company.name}
        description={safeText(company.industry, "Industry not recorded")}
        actions={<Badge tone={statusTone(company.status)}>{company.status}</Badge>}
      />
      <Card>
        <CardHeader>
          <CardTitle>Company details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="bea-meta-list">
            <div>
              <dt>Industry</dt>
              <dd>{safeText(company.industry)}</dd>
            </div>
            <div>
              <dt>Phone</dt>
              <dd>{safeText(company.phone)}</dd>
            </div>
            <div>
              <dt>Website</dt>
              <dd>
                {website ? (
                  <Link href={website} target="_blank" rel="noreferrer">
                    {website}
                  </Link>
                ) : (
                  safeText(company.website)
                )}
              </dd>
            </div>
            <div>
              <dt>Notes</dt>
              <dd className="bea-preserve-lines">{safeText(company.notes)}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{formatDateTime(company.createdAt)}</dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>{formatDateTime(company.updatedAt)}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
      {contactDecision.allowed ? (
        <Card>
          <CardHeader>
            <CardTitle>Contacts</CardTitle>
          </CardHeader>
          <CardContent>
            {contacts.length ? (
              <TableFoundation>
                <Table>
                  <thead>
                    <tr>
                      <th scope="col">Contact</th>
                      <th scope="col">Title</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contacts.map((contact) => (
                      <tr key={contact.id}>
                        <td>
                          <Link href={`/contacts/${encodeURIComponent(contact.id)}`}>
                            {displayContactName(contact)}
                          </Link>
                        </td>
                        <td>{safeText(contact.jobTitle, "—")}</td>
                        <td>
                          <Badge tone={statusTone(contact.status)}>{contact.status}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </TableFoundation>
            ) : (
              <EmptyState
                title="No contacts"
                description="No contacts are linked to this company."
              />
            )}
          </CardContent>
        </Card>
      ) : null}
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
              <EmptyState title="No tasks" description="No tasks are linked to this company." />
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
              <p>No activity is linked to this company.</p>
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
