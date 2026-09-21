import "server-only";

import type { BeaServerRuntime } from "@bea/database";
import type { JsonObject, WorkspaceArtifactType } from "@bea/domain";
import { AccessDeniedError, PERMISSIONS, type Permission } from "@bea/security";

import type { AiCommandArtifactView } from "@/lib/ai-command-contracts";
import {
  parseAiCommandWorkspacePath,
  type ParsedAiCommandWorkspacePath,
} from "@/lib/ai-command-workspace-paths";

export interface AiCommandWorkspaceViewResult {
  readonly artifact: AiCommandArtifactView;
  readonly path: string;
  readonly parentPath: string | null;
  readonly canOpenFullPage: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function allowed(
  runtime: BeaServerRuntime,
  userId: string,
  permission: Permission,
): Promise<boolean> {
  return (await runtime.authorization.authorizeUser(userId, permission)).allowed;
}

function artifact(input: {
  readonly type: WorkspaceArtifactType;
  readonly title: string;
  readonly subtitle: string;
  readonly payload: JsonObject;
  readonly sources?: AiCommandArtifactView["sources"];
  readonly links?: AiCommandArtifactView["links"];
  readonly requiredPermissions: readonly string[];
}): AiCommandArtifactView {
  return {
    id: `workspace-${input.type}-${nowIso()}`,
    type: input.type,
    title: input.title,
    subtitle: input.subtitle,
    state: "ready",
    payload: input.payload,
    sources: input.sources ?? [],
    links: input.links ?? [],
    requiredPermissions: input.requiredPermissions,
    createdAt: nowIso(),
    errorCode: null,
  };
}

function emptyArtifact(
  type: WorkspaceArtifactType,
  title: string,
  permission: Permission,
): AiCommandArtifactView {
  return {
    ...artifact({
      type,
      title,
      subtitle: "No authorized records matched this request.",
      payload: { items: [] },
      requiredPermissions: [permission],
    }),
    state: "empty",
  };
}

export async function loadAiCommandWorkspaceView(input: {
  readonly runtime: BeaServerRuntime;
  readonly userId: string;
  readonly path: string;
}): Promise<AiCommandWorkspaceViewResult> {
  const parsed = parseAiCommandWorkspacePath(input.path);
  if (!parsed) {
    throw new AccessDeniedError("permission-not-granted");
  }
  const artifactView = await renderWorkspaceView(input.runtime, input.userId, parsed);
  return {
    artifact: artifactView,
    path: parsed.path,
    parentPath: parsed.parentPath,
    canOpenFullPage: true,
  };
}

async function renderWorkspaceView(
  runtime: BeaServerRuntime,
  userId: string,
  parsed: ParsedAiCommandWorkspacePath,
): Promise<AiCommandArtifactView> {
  switch (parsed.view) {
    case "company-list":
      return loadCompanyList(runtime, userId);
    case "company-detail":
      return loadCompanyDetail(runtime, userId, parsed.recordId ?? "");
    case "contact-list":
      return loadContactList(runtime, userId);
    case "contact-detail":
      return loadContactDetail(runtime, userId, parsed.recordId ?? "");
    case "lead-list":
      return loadLeadList(runtime, userId);
    case "lead-detail":
      return loadLeadDetail(runtime, userId, parsed.recordId ?? "");
    case "task-list":
      return loadTaskList(runtime, userId);
    case "task-detail":
      return loadTaskDetail(runtime, userId, parsed.recordId ?? "");
    case "activities":
      return loadActivities(runtime, userId);
    case "notifications":
      return loadNotifications(runtime, userId);
    case "workflow-runs":
      return loadWorkflowRuns(runtime, userId);
    case "workflow-run-detail":
      return loadWorkflowRunDetail(runtime, userId, parsed.recordId ?? "");
    case "integration-health":
      return loadIntegrationHealth(runtime, userId);
    case "sources":
      return artifact({
        type: "help",
        title: "Sources",
        subtitle: "Open a citation from the conversation to inspect it here.",
        payload: { items: [] },
        requiredPermissions: [PERMISSIONS.AI_COMMAND_VIEW],
      });
    case "digital-workforce-organization":
    case "digital-workforce-department":
    case "digital-workforce-team":
    case "digital-workforce-agent-list":
    case "digital-workforce-agent-detail":
    case "digital-workforce-run-list":
    case "digital-workforce-run-trace":
    case "digital-workforce-handoff-detail":
      return (await import("./digital-workforce-command")).loadDigitalWorkforceWorkspace(
        runtime,
        userId,
        parsed.view,
        parsed.recordId,
      );
    default:
      throw new AccessDeniedError("permission-not-granted");
  }
}

async function loadCompanyList(runtime: BeaServerRuntime, userId: string) {
  if (!(await allowed(runtime, userId, PERMISSIONS.COMPANIES_VIEW))) {
    throw new AccessDeniedError("permission-not-granted");
  }
  const companies = await runtime.phase1.listCompanies({ limit: 100 });
  return artifact({
    type: "company-list",
    title: "Companies",
    subtitle: "Synthetic BEA records · not live business data",
    payload: {
      items: companies.map((company) => ({
        id: company.id,
        title: company.name,
        subtitle: company.industry ?? "Building-envelope organization",
        status: company.status,
        href: `/companies/${company.id}`,
      })),
    },
    sources: companies.map((company) => ({
      id: company.id,
      type: "company",
      title: company.name,
      href: `/companies/${company.id}`,
    })),
    links: companies.slice(0, 10).map((company) => ({
      label: `Open ${company.name}`,
      href: `/companies/${company.id}`,
    })),
    requiredPermissions: [PERMISSIONS.COMPANIES_VIEW],
  });
}

async function loadCompanyDetail(runtime: BeaServerRuntime, userId: string, id: string) {
  if (!(await allowed(runtime, userId, PERMISSIONS.COMPANIES_VIEW))) {
    throw new AccessDeniedError("permission-not-granted");
  }
  const company = await runtime.phase1.getCompany(id);
  if (!company) {
    return emptyArtifact("company-detail", "Company not found", PERMISSIONS.COMPANIES_VIEW);
  }
  const [canViewContacts, canViewTasks, taskReadScope] = await Promise.all([
    allowed(runtime, userId, PERMISSIONS.CONTACTS_VIEW),
    allowed(runtime, userId, PERMISSIONS.TASKS_VIEW),
    runtime.authorization.taskReadScopeForUser(userId),
  ]);
  const [contacts, tasks] = await Promise.all([
    canViewContacts
      ? runtime.phase1.listContacts({ companyId: company.id, limit: 100 })
      : Promise.resolve([]),
    canViewTasks
      ? runtime.phase1.listTasks({
          companyId: company.id,
          limit: 100,
          ...(taskReadScope !== "all" ? { assigneeUserId: userId } : {}),
        })
      : Promise.resolve([]),
  ]);
  return artifact({
    type: "company-detail",
    title: company.name,
    subtitle: "Synthetic BEA company record · not live business data",
    payload: {
      record: {
        id: company.id,
        status: company.status,
        industry: company.industry,
        website: company.website,
        phone: company.phone,
        ...(canViewContacts ? { contacts: contacts.length } : {}),
        ...(canViewTasks ? { relatedTasks: tasks.length } : {}),
        href: `/companies/${company.id}`,
      },
    },
    sources: [
      { id: company.id, type: "company", title: company.name, href: `/companies/${company.id}` },
    ],
    links: [
      { label: "Open full page", href: `/companies/${company.id}` },
      ...(canViewContacts ? [{ label: "View contacts", href: "/contacts" }] : []),
    ],
    requiredPermissions: [
      PERMISSIONS.COMPANIES_VIEW,
      ...(canViewContacts ? [PERMISSIONS.CONTACTS_VIEW] : []),
      ...(canViewTasks ? [PERMISSIONS.TASKS_VIEW] : []),
    ],
  });
}

async function loadContactList(runtime: BeaServerRuntime, userId: string) {
  if (!(await allowed(runtime, userId, PERMISSIONS.CONTACTS_VIEW))) {
    throw new AccessDeniedError("permission-not-granted");
  }
  const contacts = await runtime.phase1.listContacts({ limit: 100 });
  return artifact({
    type: "contact-list",
    title: "Contacts",
    subtitle: "Synthetic BEA records · not live business data",
    payload: {
      items: contacts.map((contact) => ({
        id: contact.id,
        title: `${contact.firstName} ${contact.lastName}`,
        subtitle: contact.jobTitle ?? contact.email ?? "Contact",
        status: contact.status,
        href: `/contacts/${contact.id}`,
      })),
    },
    sources: contacts.map((contact) => ({
      id: contact.id,
      type: "contact",
      title: `${contact.firstName} ${contact.lastName}`,
      href: `/contacts/${contact.id}`,
    })),
    links: contacts.slice(0, 10).map((contact) => ({
      label: `Open ${contact.firstName} ${contact.lastName}`,
      href: `/contacts/${contact.id}`,
    })),
    requiredPermissions: [PERMISSIONS.CONTACTS_VIEW],
  });
}

async function loadContactDetail(runtime: BeaServerRuntime, userId: string, id: string) {
  if (!(await allowed(runtime, userId, PERMISSIONS.CONTACTS_VIEW))) {
    throw new AccessDeniedError("permission-not-granted");
  }
  const contact = await runtime.phase1.getContact(id);
  if (!contact) {
    return emptyArtifact("contact-detail", "Contact not found", PERMISSIONS.CONTACTS_VIEW);
  }
  return artifact({
    type: "contact-detail",
    title: `${contact.firstName} ${contact.lastName}`,
    subtitle: "Synthetic BEA contact record · not live business data",
    payload: {
      record: {
        id: contact.id,
        status: contact.status,
        jobTitle: contact.jobTitle,
        email: contact.email,
        phone: contact.phone,
        companyId: contact.companyId,
        href: `/contacts/${contact.id}`,
      },
    },
    sources: [
      {
        id: contact.id,
        type: "contact",
        title: `${contact.firstName} ${contact.lastName}`,
        href: `/contacts/${contact.id}`,
      },
    ],
    links: [
      { label: "Open full page", href: `/contacts/${contact.id}` },
      ...(contact.companyId
        ? [{ label: "View company", href: `/companies/${contact.companyId}` }]
        : []),
    ],
    requiredPermissions: [PERMISSIONS.CONTACTS_VIEW],
  });
}

async function loadLeadList(runtime: BeaServerRuntime, userId: string) {
  if (!(await allowed(runtime, userId, PERMISSIONS.LEADS_VIEW))) {
    throw new AccessDeniedError("permission-not-granted");
  }
  const leads = await runtime.leads.listLeads({ limit: 100 });
  return artifact({
    type: "lead-list",
    title: "Leads",
    subtitle:
      "Synthetic BEA records · website, Outlook, and telephone connectors are not connected",
    payload: {
      items: leads.map((item) => ({
        id: item.lead.id,
        title: item.lead.opportunityName,
        subtitle: `${item.lead.reference} · ${item.lead.sourceType} · ${item.lead.status}`,
        status: item.lead.status,
        href: `/leads/${item.lead.id}`,
      })),
    },
    sources: leads.map((item) => ({
      id: item.lead.id,
      type: "lead",
      title: item.lead.opportunityName,
      href: `/leads/${item.lead.id}`,
    })),
    links: leads.slice(0, 10).map((item) => ({
      label: `Open ${item.lead.opportunityName}`,
      href: `/leads/${item.lead.id}`,
    })),
    requiredPermissions: [PERMISSIONS.LEADS_VIEW],
  });
}

async function loadLeadDetail(runtime: BeaServerRuntime, userId: string, id: string) {
  if (!(await allowed(runtime, userId, PERMISSIONS.LEADS_VIEW))) {
    throw new AccessDeniedError("permission-not-granted");
  }
  const match = await runtime.leads.getLead(id);
  if (!match) {
    return emptyArtifact("lead-detail", "Lead not found", PERMISSIONS.LEADS_VIEW);
  }
  return artifact({
    type: "lead-detail",
    title: match.lead.opportunityName,
    subtitle: `${match.lead.reference} · authorized lead record · external systems not connected`,
    payload: {
      record: {
        id: match.lead.id,
        status: match.lead.status,
        sourceType: match.lead.sourceType,
        receivedAt: match.lead.receivedAt,
        requestedService: match.lead.requestedService,
        requestSummary: match.lead.requestSummary,
        readyForProposal: match.readiness.readyForProposal,
        blocking: match.readiness.blocking.map((item) => item.message),
        optional: match.readiness.optional.map((item) => item.message),
        href: `/leads/${match.lead.id}`,
      },
    },
    sources: [
      {
        id: match.lead.id,
        type: "lead",
        title: match.lead.opportunityName,
        href: `/leads/${match.lead.id}`,
      },
    ],
    links: [{ label: "Open full page", href: `/leads/${match.lead.id}` }],
    requiredPermissions: [PERMISSIONS.LEADS_VIEW],
  });
}

async function loadTaskList(runtime: BeaServerRuntime, userId: string) {
  if (!(await allowed(runtime, userId, PERMISSIONS.TASKS_VIEW))) {
    throw new AccessDeniedError("permission-not-granted");
  }
  const scope = await runtime.authorization.taskReadScopeForUser(userId);
  const tasks = await runtime.phase1.listTasks({
    limit: 100,
    ...(scope !== "all" ? { assigneeUserId: userId } : {}),
  });
  return artifact({
    type: "task-list",
    title: "Tasks",
    subtitle: "Synthetic BEA records · not live business data",
    payload: {
      items: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        subtitle: task.description ?? "Internal task",
        status: task.status,
        href: `/tasks/${task.id}`,
      })),
    },
    sources: tasks.map((task) => ({
      id: task.id,
      type: "task",
      title: task.title,
      href: `/tasks/${task.id}`,
    })),
    links: tasks.slice(0, 10).map((task) => ({
      label: `Open ${task.title}`,
      href: `/tasks/${task.id}`,
    })),
    requiredPermissions: [PERMISSIONS.TASKS_VIEW],
  });
}

async function loadTaskDetail(runtime: BeaServerRuntime, userId: string, id: string) {
  if (!(await allowed(runtime, userId, PERMISSIONS.TASKS_VIEW))) {
    throw new AccessDeniedError("permission-not-granted");
  }
  const task = await runtime.phase1.getTask(id);
  if (!task) {
    return emptyArtifact("task-detail", "Task not found", PERMISSIONS.TASKS_VIEW);
  }
  return artifact({
    type: "task-detail",
    title: task.title,
    subtitle: "Synthetic BEA task record · not live business data",
    payload: {
      record: {
        id: task.id,
        status: task.status,
        priority: task.priority,
        dueAt: task.dueAt,
        description: task.description,
        href: `/tasks/${task.id}`,
      },
    },
    sources: [{ id: task.id, type: "task", title: task.title, href: `/tasks/${task.id}` }],
    links: [{ label: "Open full page", href: `/tasks/${task.id}` }],
    requiredPermissions: [PERMISSIONS.TASKS_VIEW],
  });
}

async function loadActivities(runtime: BeaServerRuntime, userId: string) {
  if (!(await allowed(runtime, userId, PERMISSIONS.ACTIVITIES_VIEW))) {
    throw new AccessDeniedError("permission-not-granted");
  }
  const activities = await runtime.phase1.listActivities({ limit: 30 });
  return artifact({
    type: "activity-timeline",
    title: "Recent activity",
    subtitle: "Synthetic BEA activity timeline",
    payload: {
      items: activities.map((activity) => ({
        id: activity.id,
        title: activity.summary,
        subtitle: new Date(activity.createdAt).toLocaleString("en-US"),
        status: activity.type,
        href: activity.taskId
          ? `/tasks/${activity.taskId}`
          : activity.leadId
            ? `/leads/${activity.leadId}`
            : activity.companyId
              ? `/companies/${activity.companyId}`
              : activity.contactId
                ? `/contacts/${activity.contactId}`
                : "/activities",
      })),
    },
    requiredPermissions: [PERMISSIONS.ACTIVITIES_VIEW],
  });
}

async function loadNotifications(runtime: BeaServerRuntime, userId: string) {
  if (!(await allowed(runtime, userId, PERMISSIONS.NOTIFICATIONS_VIEW))) {
    throw new AccessDeniedError("permission-not-granted");
  }
  const notifications = await runtime.phase1.listNotifications({
    userId,
    limit: 50,
  });
  return artifact({
    type: "notification-list",
    title: "Notifications",
    subtitle: "Synthetic BEA notifications",
    payload: {
      items: notifications.map((notification) => ({
        id: notification.id,
        title: notification.title,
        subtitle: notification.body,
        status: notification.readAt ? "read" : "unread",
        href: "/notifications",
      })),
    },
    requiredPermissions: [PERMISSIONS.NOTIFICATIONS_VIEW],
  });
}

async function loadWorkflowRuns(runtime: BeaServerRuntime, userId: string) {
  if (!(await allowed(runtime, userId, PERMISSIONS.WORKFLOW_VIEW))) {
    throw new AccessDeniedError("permission-not-granted");
  }
  const runs = await runtime.phase1.listWorkflowRuns({ limit: 25 });
  return artifact({
    type: "workflow-run-list",
    title: "Workflow runs",
    subtitle: "Synthetic BEA workflow evidence",
    payload: {
      items: runs.map((run) => ({
        id: run.id,
        title: run.workflowKey,
        subtitle: run.status,
        status: run.status,
        href: `/workflow-runs/${run.id}`,
      })),
    },
    requiredPermissions: [PERMISSIONS.WORKFLOW_VIEW],
  });
}

async function loadWorkflowRunDetail(runtime: BeaServerRuntime, userId: string, id: string) {
  if (!(await allowed(runtime, userId, PERMISSIONS.WORKFLOW_VIEW))) {
    throw new AccessDeniedError("permission-not-granted");
  }
  const runs = await runtime.phase1.listWorkflowRuns({ limit: 100 });
  const run = runs.find((item) => item.id === id);
  if (!run) {
    return emptyArtifact(
      "workflow-run-detail",
      "Workflow run not found",
      PERMISSIONS.WORKFLOW_VIEW,
    );
  }
  return artifact({
    type: "workflow-run-detail",
    title: run.workflowKey,
    subtitle: "Synthetic BEA workflow evidence",
    payload: {
      record: {
        id: run.id,
        status: run.status,
        href: `/workflow-runs/${run.id}`,
      },
    },
    links: [{ label: "Open full page", href: `/workflow-runs/${run.id}` }],
    requiredPermissions: [PERMISSIONS.WORKFLOW_VIEW],
  });
}

async function loadIntegrationHealth(runtime: BeaServerRuntime, userId: string) {
  if (!(await allowed(runtime, userId, PERMISSIONS.AI_INTEGRATION_HEALTH_VIEW))) {
    throw new AccessDeniedError("permission-not-granted");
  }
  const connections = await runtime.repository.listIntegrationConnections();
  return artifact({
    type: "integration-health-summary",
    title: "Integration health",
    subtitle: "External systems not connected",
    payload: {
      items: connections.map((connection) => ({
        id: connection.id,
        title: connection.displayName,
        subtitle: `${connection.providerType} · ${connection.requirementStatus}`,
        status: connection.connectionStatus,
        href: `/integrations/${encodeURIComponent(connection.providerType)}`,
      })),
    },
    requiredPermissions: [PERMISSIONS.AI_INTEGRATION_HEALTH_VIEW],
  });
}
