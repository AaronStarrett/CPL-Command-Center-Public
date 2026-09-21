import "server-only";

import { getServerRuntime } from "@bea/database";
import { PERMISSIONS, type Permission } from "@bea/security";

export interface CommandCenterNavigationItem {
  href: string;
  label: string;
  shortLabel: string;
  permission: Permission;
  anyOf?: readonly Permission[];
  deferred?: boolean;
}

export const primaryProductNavigation: readonly CommandCenterNavigationItem[] = [
  {
    href: "/command-center",
    label: "Command Center",
    shortLabel: "Command",
    permission: PERMISSIONS.HOME_VIEW,
  },
  {
    href: "/automation-flow",
    label: "Automation Flow",
    shortLabel: "Flow",
    permission: PERMISSIONS.HOME_VIEW,
  },
  {
    href: "/company-details",
    label: "Company Details",
    shortLabel: "Company",
    permission: PERMISSIONS.HOME_VIEW,
  },
] as const;

export const commandCenterNavigation: readonly CommandCenterNavigationItem[] = [
  {
    href: "/records-overview",
    label: "Records overview",
    shortLabel: "RO",
    permission: PERMISSIONS.HOME_VIEW,
  },
  {
    href: "/operations",
    label: "Operations",
    shortLabel: "OP",
    permission: PERMISSIONS.OPERATIONS_BOARD_VIEW,
  },
  {
    href: "/work",
    label: "Work",
    shortLabel: "WK",
    permission: PERMISSIONS.WORK_VIEW,
    anyOf: [PERMISSIONS.WORK_VIEW, PERMISSIONS.PROPOSALS_WORK_VIEW],
  },
  {
    href: "/configuration",
    label: "Configuration",
    shortLabel: "CF",
    permission: PERMISSIONS.CONFIGURATION_VIEW,
  },
  {
    href: "/projects",
    label: "Projects",
    shortLabel: "PJ",
    permission: PERMISSIONS.PROJECTS_VIEW,
  },
  {
    href: "/inspections",
    label: "Inspections",
    shortLabel: "IS",
    permission: PERMISSIONS.INSPECTIONS_VIEW,
  },
  {
    href: "/reports",
    label: "Reports",
    shortLabel: "RP",
    permission: PERMISSIONS.REPORTS_VIEW,
  },
  {
    href: "/exceptions",
    label: "Exceptions",
    shortLabel: "EX",
    permission: PERMISSIONS.EXCEPTIONS_VIEW,
  },
  {
    href: "/automations",
    label: "Automations",
    shortLabel: "AU",
    permission: PERMISSIONS.AUTOMATIONS_VIEW,
  },
  {
    href: "/integrations",
    label: "Integrations",
    shortLabel: "IN",
    permission: PERMISSIONS.INTEGRATIONS_VIEW,
  },
  {
    href: "/leads",
    label: "Leads",
    shortLabel: "LD",
    permission: PERMISSIONS.LEADS_VIEW,
  },
  {
    href: "/proposals",
    label: "Proposals",
    shortLabel: "PR",
    permission: PERMISSIONS.PROPOSALS_VIEW,
  },
  {
    href: "/search",
    label: "Search",
    shortLabel: "SR",
    permission: PERMISSIONS.SEARCH_VIEW,
  },
  {
    href: "/companies",
    label: "Companies",
    shortLabel: "CO",
    permission: PERMISSIONS.COMPANIES_VIEW,
  },
  {
    href: "/contacts",
    label: "Contacts",
    shortLabel: "CT",
    permission: PERMISSIONS.CONTACTS_VIEW,
  },
  {
    href: "/tasks",
    label: "Tasks",
    shortLabel: "TK",
    permission: PERMISSIONS.TASKS_VIEW,
  },
  {
    href: "/activities",
    label: "Activities",
    shortLabel: "AC",
    permission: PERMISSIONS.ACTIVITIES_VIEW,
  },
  {
    href: "/notifications",
    label: "Notifications",
    shortLabel: "NT",
    permission: PERMISSIONS.NOTIFICATIONS_VIEW,
  },
  {
    href: "/communications",
    label: "Communications",
    shortLabel: "CM",
    permission: PERMISSIONS.COMMUNICATIONS_VIEW,
    deferred: true,
  },
  {
    href: "/documents",
    label: "Documents",
    shortLabel: "DC",
    permission: PERMISSIONS.DOCUMENTS_VIEW,
    deferred: true,
  },
  {
    href: "/workflow-runs",
    label: "Workflow Runs",
    shortLabel: "WF",
    permission: PERMISSIONS.WORKFLOW_VIEW,
  },
  {
    href: "/audit",
    label: "Audit",
    shortLabel: "AT",
    permission: PERMISSIONS.AUDIT_VIEW,
  },
  {
    href: "/administration",
    label: "Settings",
    shortLabel: "AD",
    permission: PERMISSIONS.ADMINISTRATION_VIEW,
  },
  {
    href: "/digital-workforce",
    label: "Digital Workforce",
    shortLabel: "DW",
    permission: PERMISSIONS.DIGITAL_WORKFORCE_VIEW,
  },
  {
    href: "/ai-command",
    label: "AI Command",
    shortLabel: "AI",
    permission: PERMISSIONS.AI_COMMAND_VIEW,
  },
] as const;

async function authorizedItems(
  userId: string,
  items: readonly CommandCenterNavigationItem[],
): Promise<CommandCenterNavigationItem[]> {
  const runtime = await getServerRuntime();
  const decisions = await Promise.all(
    items.map((item) =>
      item.anyOf
        ? Promise.all(
            item.anyOf.map((permission) => runtime.authorization.authorizeUser(userId, permission)),
          ).then((results) => ({ allowed: results.some((result) => result.allowed) }))
        : runtime.authorization.authorizeUser(userId, item.permission),
    ),
  );
  return items.filter(
    (item, index) =>
      decisions[index]?.allowed &&
      !item.deferred &&
      item.href !== "/ai-command" &&
      item.href !== "/digital-workforce",
  );
}

export async function navigationForUser(userId: string) {
  return authorizedItems(userId, commandCenterNavigation);
}

export async function primaryNavigationForUser(userId: string) {
  return authorizedItems(userId, primaryProductNavigation);
}
