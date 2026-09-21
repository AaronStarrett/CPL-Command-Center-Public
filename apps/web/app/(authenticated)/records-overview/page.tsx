import { getServerRuntime } from "@bea/database";
import { PERMISSIONS, type Permission } from "@bea/security";
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  HealthIndicator,
  Link,
  MetricCard,
  PageHeader,
  Table,
  TableFoundation,
} from "@bea/ui";
import type { Metadata } from "next";

import { FoundationCheck } from "@/components/foundation-check";
import { requirePermission } from "@/lib/auth/authorization";
import { getFoundationSnapshot } from "@/lib/foundation";
import { formatDateTime, statusTone } from "@/lib/phase1-presentation";
import { createRuntimePresentation } from "@/lib/production-presentation";
import { workflowStepTone } from "@/lib/workflow-presentation";

export const metadata: Metadata = { title: "Records overview" };
export const dynamic = "force-dynamic";

interface DashboardArea {
  readonly href: string;
  readonly title: string;
  readonly description: string;
  readonly permission: Permission;
}

const dashboardAreas: readonly DashboardArea[] = [
  {
    href: "/companies",
    title: "Companies",
    description: "Review active organizations and open their related contacts and work.",
    permission: PERMISSIONS.COMPANIES_VIEW,
  },
  {
    href: "/contacts",
    title: "Contacts",
    description: "Find the people connected to BEA company records.",
    permission: PERMISSIONS.CONTACTS_VIEW,
  },
  {
    href: "/tasks",
    title: "Tasks",
    description: "Track assigned operational work, priorities, and due dates.",
    permission: PERMISSIONS.TASKS_VIEW,
  },
  {
    href: "/activities",
    title: "Activity",
    description: "Inspect the chronological record of Phase 1 business events.",
    permission: PERMISSIONS.ACTIVITIES_VIEW,
  },
  {
    href: "/notifications",
    title: "Notifications",
    description: "Review alerts addressed to the current signed-in account.",
    permission: PERMISSIONS.NOTIFICATIONS_VIEW,
  },
  {
    href: "/workflow-runs",
    title: "Workflow runs",
    description: "Inspect persisted workflow outcomes and step-level evidence.",
    permission: PERMISSIONS.WORKFLOW_VIEW,
  },
  {
    href: "/leads",
    title: "Leads",
    description: "Review manual, referral, and in-person intake in the sales review queue.",
    permission: PERMISSIONS.LEADS_VIEW,
  },
] as const;

export default async function CommandCenterPage() {
  const session = await requirePermission(PERMISSIONS.HOME_VIEW, "command-center");
  const runtime = await getServerRuntime();
  const presentation = createRuntimePresentation(
    runtime.environment,
    process.env.BEA_DEPLOYMENT_PROFILE,
  );
  const [
    areaDecisions,
    aiDecision,
    integrationDecision,
    taskReadScope,
    foundationRunDecision,
    operationsDecision,
  ] = await Promise.all([
    Promise.all(
      dashboardAreas.map((area) =>
        runtime.authorization.authorizeUser(session.personaId, area.permission),
      ),
    ),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.AI_COMMAND_VIEW),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.INTEGRATIONS_VIEW),
    runtime.authorization.taskReadScopeForUser(session.personaId),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.FOUNDATION_WORKFLOW_RUN),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.OPERATIONS_BOARD_VIEW),
  ]);
  const availableAreas = dashboardAreas.filter((_, index) => areaDecisions[index]?.allowed);
  const companiesAllowed = areaDecisions[0]?.allowed === true;
  const contactsAllowed = areaDecisions[1]?.allowed === true;
  const tasksAllowed = areaDecisions[2]?.allowed === true;
  const activityAllowed = areaDecisions[3]?.allowed === true;
  const notificationsAllowed = areaDecisions[4]?.allowed === true;
  const workflowAllowed = areaDecisions[5]?.allowed === true;
  const summary = await runtime.phase1.getDashboardCounts(session.personaId, {
    companies: companiesAllowed,
    contacts: contactsAllowed,
    tasks: tasksAllowed,
    taskScope: taskReadScope === "all" ? "all" : "assigned",
    notifications: notificationsAllowed,
    conversations: aiDecision.allowed,
  });
  const [foundation, recentRuns, recentActivities, openTasks] = await Promise.all([
    integrationDecision.allowed || workflowAllowed
      ? getFoundationSnapshot()
      : Promise.resolve(null),
    workflowAllowed ? runtime.phase1.listWorkflowRuns({ limit: 5 }) : Promise.resolve([]),
    activityAllowed ? runtime.phase1.listActivities({ limit: 5 }) : Promise.resolve([]),
    tasksAllowed
      ? runtime.phase1.listTasks({
          limit: 100,
          status: "open",
          ...(taskReadScope !== "all" ? { assigneeUserId: session.personaId } : {}),
        })
      : Promise.resolve([]),
  ]);
  const priorityTasks = [...openTasks]
    .sort((left, right) => {
      const priority = { urgent: 0, high: 1, normal: 2, low: 3 } as const;
      return (
        priority[left.priority] - priority[right.priority] ||
        (left.dueAt ?? "9999").localeCompare(right.dueAt ?? "9999")
      );
    })
    .slice(0, 5);

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow={
          presentation.production ? presentation.profileLabel : "Phase 1.1 command center core"
        }
        title={`Good day, ${session.displayName}.`}
        description={presentation.dashboardDescription}
        actions={<Badge tone="info">{presentation.dashboardBadge}</Badge>}
      />

      {operationsDecision.allowed ? (
        <Link href="/operations" className="bea-ai-command-entry">
          <Card>
            <CardHeader>
              <div className="bea-record-heading">
                <div>
                  <span className="bea-eyebrow">Primary operations queue</span>
                  <CardTitle>Turnaround board</CardTitle>
                </div>
                <Badge tone="warning">SYNTHETIC DEMO</Badge>
              </div>
              <CardDescription>
                Move inspections from submission through validation, review, and delivery. AI is not
                required.
              </CardDescription>
            </CardHeader>
          </Card>
        </Link>
      ) : null}

      {aiDecision.allowed ? (
        <Link href="/ai-command" className="bea-ai-command-entry">
          <Card>
            <CardHeader>
              <div className="bea-record-heading">
                <div>
                  <span className="bea-eyebrow">Primary workspace</span>
                  <CardTitle>AI Command</CardTitle>
                </div>
                <Badge tone="info">{summary.activeConversations} active conversations</Badge>
              </div>
              <CardDescription>
                Open the permission-aware command workspace and its generated record views.
              </CardDescription>
            </CardHeader>
          </Card>
        </Link>
      ) : null}

      <section aria-labelledby="record-summary-heading">
        <h2 id="record-summary-heading" className="bea-section-title">
          Record summary
        </h2>
        <div className="bea-grid">
          {companiesAllowed ? (
            <Link
              href="/companies"
              className="bea-metric-link"
              aria-label={`${summary.companies} companies`}
            >
              <MetricCard label="Companies" value={summary.companies} detail="Stored records" />
            </Link>
          ) : null}
          {contactsAllowed ? (
            <Link
              href="/contacts"
              className="bea-metric-link"
              aria-label={`${summary.contacts} contacts`}
            >
              <MetricCard label="Contacts" value={summary.contacts} detail="Stored records" />
            </Link>
          ) : null}
          {tasksAllowed ? (
            <>
              <Link
                href="/tasks?status=open&scope=mine"
                className="bea-metric-link"
                aria-label={`${summary.openTasks} open tasks`}
              >
                <MetricCard
                  label="Open tasks"
                  value={summary.openTasks}
                  detail="Requires follow-up"
                />
              </Link>
              <Link
                href="/tasks?status=open&overdue=true&scope=mine"
                className="bea-metric-link"
                aria-label={`${summary.overdueTasks} overdue tasks`}
              >
                <MetricCard
                  label="Overdue tasks"
                  value={summary.overdueTasks}
                  detail="Past due and still open"
                  status={summary.overdueTasks > 0 ? "warning" : "success"}
                />
              </Link>
              <Link
                href="/tasks?status=completed&scope=mine"
                className="bea-metric-link"
                aria-label={`${summary.completedTasks} completed tasks`}
              >
                <MetricCard
                  label="Completed tasks"
                  value={summary.completedTasks}
                  detail="Persisted completion"
                  status="success"
                />
              </Link>
            </>
          ) : null}
          {notificationsAllowed ? (
            <Link
              href="/notifications?view=unread"
              className="bea-metric-link"
              aria-label={`${summary.unreadNotifications} unread notifications`}
            >
              <MetricCard
                label="Unread notifications"
                value={summary.unreadNotifications}
                detail="For this account"
                status={summary.unreadNotifications > 0 ? "warning" : "neutral"}
              />
            </Link>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="operational-pulse-heading">
        <h2 id="operational-pulse-heading" className="bea-section-title">
          Operational pulse
        </h2>
        <div className="bea-grid bea-grid--wide">
          {foundation ? (
            <Card>
              <CardHeader>
                <CardTitle>Integration health</CardTitle>
                <CardDescription>Current registered provider and runtime checks.</CardDescription>
              </CardHeader>
              <CardContent className="bea-stack">
                <HealthIndicator
                  label={
                    presentation.production
                      ? foundation.integrationHealth.connected > 0
                        ? `${foundation.integrationHealth.connected} connected providers`
                        : `${foundation.integrationHealth.total} providers require setup`
                      : `${foundation.integrationHealth.simulated} simulated providers`
                  }
                  state={
                    presentation.production
                      ? foundation.integrationHealth.connected > 0
                        ? "healthy"
                        : "degraded"
                      : "simulated"
                  }
                />
                <HealthIndicator
                  label="Database"
                  state={foundation.databaseHealth.status === "healthy" ? "healthy" : "unavailable"}
                />
                <HealthIndicator
                  label="Worker"
                  state={
                    foundation.workerHealth.status === "healthy"
                      ? "healthy"
                      : foundation.workerHealth.status === "degraded"
                        ? "degraded"
                        : "unavailable"
                  }
                />
                <Link href="/integrations">Open Integration Center</Link>
              </CardContent>
            </Card>
          ) : null}
          {workflowAllowed ? (
            <Card>
              <CardHeader>
                <CardTitle>Automation health</CardTitle>
                <CardDescription>Most recent persisted workflow runs.</CardDescription>
              </CardHeader>
              <CardContent>
                {recentRuns.length ? (
                  <ol className="bea-dashboard-list">
                    {recentRuns.map((run) => (
                      <li key={run.id}>
                        <Link href={`/workflow-runs/${encodeURIComponent(run.id)}`}>
                          {run.workflowKey}
                        </Link>
                        <Badge tone={statusTone(run.status)}>{run.status}</Badge>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p>No workflow runs are available.</p>
                )}
              </CardContent>
            </Card>
          ) : null}
          {tasksAllowed ? (
            <Card>
              <CardHeader>
                <CardTitle>Priority items</CardTitle>
                <CardDescription>
                  Highest-priority open tasks within your permitted scope.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {priorityTasks.length ? (
                  <ol className="bea-dashboard-list">
                    {priorityTasks.map((task) => (
                      <li key={task.id}>
                        <div>
                          <Link href={`/tasks/${encodeURIComponent(task.id)}`}>{task.title}</Link>
                          <small>
                            {task.dueAt
                              ? `Due ${new Date(task.dueAt).toLocaleDateString("en-US")}`
                              : "No due date"}
                          </small>
                        </div>
                        <Badge tone={statusTone(task.priority)}>{task.priority}</Badge>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p>No open priority tasks are available.</p>
                )}
              </CardContent>
            </Card>
          ) : null}
          {activityAllowed ? (
            <Card>
              <CardHeader>
                <CardTitle>Recent activity</CardTitle>
                <CardDescription>Latest permitted Phase 1 record events.</CardDescription>
              </CardHeader>
              <CardContent>
                {recentActivities.length ? (
                  <ol className="bea-dashboard-list">
                    {recentActivities.map((activity) => (
                      <li key={activity.id}>
                        <div>
                          <strong>{activity.summary}</strong>
                          <small>{formatDateTime(activity.createdAt)}</small>
                        </div>
                        <Badge>{activity.type}</Badge>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p>No recent activity is available.</p>
                )}
              </CardContent>
            </Card>
          ) : null}
        </div>
      </section>

      {foundationRunDecision.allowed || (workflowAllowed && foundation) ? (
        <section aria-labelledby="foundation-controls-heading">
          <h2 id="foundation-controls-heading" className="bea-section-title">
            Foundation controls
          </h2>
          <div className="bea-grid bea-grid--wide">
            {foundationRunDecision.allowed ? (
              <Card>
                <CardHeader>
                  <CardTitle>Controlled foundation check</CardTitle>
                  <CardDescription>
                    Exercise the server-authorized local workflow and inspect persisted results.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <FoundationCheck canRun />
                </CardContent>
              </Card>
            ) : null}
            {workflowAllowed && foundation ? (
              <Card data-testid="latest-foundation-run">
                <CardHeader>
                  <CardTitle>Latest persisted foundation run</CardTitle>
                  <CardDescription>
                    Re-read from the SQL workflow repository on every page refresh.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {foundation.latestWorkflow ? (
                    <div className="bea-stack">
                      <dl className="bea-meta-list">
                        <div>
                          <dt>Status</dt>
                          <dd>
                            <Badge tone={statusTone(foundation.latestWorkflow.run.status)}>
                              {foundation.latestWorkflow.run.status}
                            </Badge>
                          </dd>
                        </div>
                        <div>
                          <dt>Correlation ID</dt>
                          <dd className="bea-code">
                            {foundation.latestWorkflow.run.correlationId}
                          </dd>
                        </div>
                        <div>
                          <dt>Idempotency key</dt>
                          <dd className="bea-code">
                            {foundation.latestWorkflow.run.idempotencyKey}
                          </dd>
                        </div>
                      </dl>
                      <TableFoundation>
                        <Table>
                          <thead>
                            <tr>
                              <th scope="col">Sequence</th>
                              <th scope="col">Step</th>
                              <th scope="col">Outcome</th>
                            </tr>
                          </thead>
                          <tbody>
                            {foundation.latestWorkflow.steps.map((step) => (
                              <tr key={step.id}>
                                <td>{step.sequence}</td>
                                <td>{step.stepKey}</td>
                                <td>
                                  <Badge tone={workflowStepTone(step.status)}>{step.status}</Badge>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </Table>
                      </TableFoundation>
                    </div>
                  ) : (
                    <p>No persisted foundation workflow run is available.</p>
                  )}
                </CardContent>
              </Card>
            ) : null}
          </div>
        </section>
      ) : null}

      <section aria-labelledby="workspace-links-heading">
        <h2 id="workspace-links-heading" className="bea-section-title">
          Your workspace
        </h2>
        <div className="bea-grid bea-grid--wide">
          {availableAreas.map((area) => (
            <Card key={area.href} className="bea-record-link-card">
              <CardHeader>
                <CardTitle>{area.title}</CardTitle>
                <CardDescription>{area.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <Link href={area.href}>Open {area.title.toLowerCase()}</Link>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}
