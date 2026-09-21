import { getServerRuntime } from "@bea/database";
import type { TaskStatus } from "@bea/domain";
import { PERMISSIONS } from "@bea/security";
import {
  Badge,
  Button,
  EmptyState,
  FormField,
  Input,
  Link,
  PageHeader,
  Select,
  Table,
  TableFoundation,
} from "@bea/ui";
import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/authorization";
import { formatDate, statusTone } from "@/lib/phase1-presentation";

export const metadata: Metadata = { title: "Tasks" };
export const dynamic = "force-dynamic";

const taskStatuses = ["open", "completed"] as const;

function queryValue(value: string | string[] | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePermission(PERMISSIONS.TASKS_VIEW, "tasks");
  const runtime = await getServerRuntime();
  const query = await searchParams;
  const text = queryValue(query.q).slice(0, 120);
  const requestedStatus = queryValue(query.status);
  const overdueOnly = queryValue(query.overdue) === "true";
  const status = taskStatuses.includes(requestedStatus as TaskStatus)
    ? (requestedStatus as TaskStatus)
    : undefined;
  const [manageDecision, taskReadScope, companyDecision, contactDecision] = await Promise.all([
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.TASKS_MANAGE),
    runtime.authorization.taskReadScopeForUser(session.personaId),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.COMPANIES_VIEW),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.CONTACTS_VIEW),
  ]);
  const showAll = taskReadScope === "all" && queryValue(query.scope) !== "mine";
  const [taskRecords, companies, contacts] = await Promise.all([
    runtime.phase1.listTasks({
      limit: 100,
      ...(status ? { status } : {}),
      ...(text ? { query: text } : {}),
      ...(overdueOnly ? { overdueOnly: true } : {}),
      ...(!showAll ? { assigneeUserId: session.personaId } : {}),
    }),
    companyDecision.allowed ? runtime.phase1.listCompanies({ limit: 250 }) : Promise.resolve([]),
    contactDecision.allowed ? runtime.phase1.listContacts({ limit: 250 }) : Promise.resolve([]),
  ]);
  const tasks = taskRecords;
  const companyNames = new Map(companies.map((company) => [company.id, company.name]));
  const contactNames = new Map(
    contacts.map((contact) => [contact.id, `${contact.firstName} ${contact.lastName}`.trim()]),
  );

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Phase 1 records"
        title="Tasks"
        description={
          showAll
            ? "Review operational tasks across permitted records."
            : "Review tasks assigned to the current account."
        }
        actions={
          manageDecision.allowed ? (
            <Link href="/tasks/new" variant="button">
              Create task
            </Link>
          ) : null
        }
      />
      <form action="/tasks" className="bea-filter-bar bea-filter-bar--tasks">
        {overdueOnly ? <input type="hidden" name="overdue" value="true" /> : null}
        <FormField label="Task title or description" htmlFor="task-query">
          <Input id="task-query" name="q" type="search" defaultValue={text} maxLength={120} />
        </FormField>
        <FormField label="Status" htmlFor="task-status">
          <Select id="task-status" name="status" defaultValue={status ?? ""}>
            <option value="">All statuses</option>
            {taskStatuses.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </FormField>
        {taskReadScope === "all" ? (
          <FormField label="Assignment scope" htmlFor="task-scope">
            <Select id="task-scope" name="scope" defaultValue={showAll ? "all" : "mine"}>
              <option value="all">All permitted tasks</option>
              <option value="mine">Assigned to me</option>
            </Select>
          </FormField>
        ) : null}
        <Button type="submit" variant="secondary">
          Apply filters
        </Button>
      </form>
      {tasks.length ? (
        <TableFoundation>
          <Table>
            <thead>
              <tr>
                <th scope="col">Task</th>
                <th scope="col">Priority</th>
                <th scope="col">Status</th>
                <th scope="col">Due</th>
                {companyDecision.allowed ? <th scope="col">Company</th> : null}
                {contactDecision.allowed ? <th scope="col">Contact</th> : null}
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
                  {companyDecision.allowed ? (
                    <td>
                      {task.companyId
                        ? (companyNames.get(task.companyId) ?? "Company record")
                        : "—"}
                    </td>
                  ) : null}
                  {contactDecision.allowed ? (
                    <td>
                      {task.contactId
                        ? (contactNames.get(task.contactId) ?? "Contact record")
                        : "—"}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </Table>
        </TableFoundation>
      ) : (
        <EmptyState title="No tasks found" description="No tasks match the current filters." />
      )}
    </div>
  );
}
