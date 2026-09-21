import {
  DIGITAL_AGENT_LABEL,
  DIGITAL_WORKFORCE_REGISTERED_TOOLS,
  SEEDED_DIGITAL_WORKFORCE_IDS,
  type DigitalWorkforceAgentIdentity,
  type DigitalWorkforceAgentVersion,
  type DigitalWorkforceOrganizationNode,
  type DigitalWorkforceRuntimeLimits,
  DEFAULT_DIGITAL_WORKFORCE_RUNTIME_POLICY,
} from "@bea/domain";

export const PUBLISH_DIGITAL_AGENT_CONFIRMATION = "PUBLISH_DIGITAL_AGENT";
export const DIGITAL_WORKFORCE_TABS = [
  "organization",
  "agents",
  "active",
  "handoffs",
  "templates",
  "settings",
] as const;
export type DigitalWorkforceTab = (typeof DIGITAL_WORKFORCE_TABS)[number];

export function isDigitalWorkforceTab(value: string): value is DigitalWorkforceTab {
  return (DIGITAL_WORKFORCE_TABS as readonly string[]).includes(value);
}

export function workingStateTone(
  state: DigitalWorkforceOrganizationNode["workingState"],
): "success" | "info" | "warning" | "danger" | "neutral" {
  switch (state) {
    case "working":
      return "info";
    case "idle":
      return "success";
    case "paused":
      return "warning";
    case "archived":
      return "neutral";
    case "draft":
      return "warning";
    default:
      return "neutral";
  }
}

export function agentStatusLabel(status: DigitalWorkforceAgentIdentity["status"]): string {
  switch (status) {
    case "active":
      return "Active Digital Agent";
    case "paused":
      return "Paused Digital Agent";
    case "archived":
      return "Archived Digital Agent";
    case "draft":
      return "Draft Digital Agent";
    default:
      return DIGITAL_AGENT_LABEL;
  }
}

export function knowledgeDisclosure(version: DigitalWorkforceAgentVersion | null): string {
  if (!version) return "No published configuration.";
  const disconnected = version.knowledgeScopes.filter(
    (scope) => scope.connectionState !== "connected",
  );
  if (disconnected.length === 0) return "Authorized knowledge scopes are connected.";
  return disconnected.map((scope) => scope.disclosure).join(" ");
}

export function toolGrantCount(version: DigitalWorkforceAgentVersion | null): number {
  return version?.toolGrants.filter((grant) => grant.enabled).length ?? 0;
}

export function seededExecutiveAgentId(): string {
  return SEEDED_DIGITAL_WORKFORCE_IDS.agents.andrewExecutive;
}

export function registeredToolOptions(): readonly string[] {
  return DIGITAL_WORKFORCE_REGISTERED_TOOLS;
}

export function defaultRuntimePolicy(): DigitalWorkforceRuntimeLimits {
  return { ...DEFAULT_DIGITAL_WORKFORCE_RUNTIME_POLICY };
}

export function hierarchyForest(
  nodes: readonly DigitalWorkforceOrganizationNode[],
): readonly DigitalWorkforceOrganizationNode[] {
  const bySupervisor = new Map<string | null, DigitalWorkforceOrganizationNode[]>();
  for (const node of nodes) {
    const key = node.supervisorAgentId;
    const list = bySupervisor.get(key) ?? [];
    list.push(node);
    bySupervisor.set(key, list);
  }
  const roots = (bySupervisor.get(null) ?? [])
    .slice()
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
  return roots;
}

export function directReports(
  nodes: readonly DigitalWorkforceOrganizationNode[],
  agentId: string,
): readonly DigitalWorkforceOrganizationNode[] {
  return nodes
    .filter((node) => node.supervisorAgentId === agentId)
    .slice()
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}
