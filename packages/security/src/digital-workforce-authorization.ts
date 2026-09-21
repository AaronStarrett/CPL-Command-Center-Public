import type {
  DigitalWorkforceApprovalPolicy,
  DigitalWorkforceDataScope,
  DigitalWorkforceEffectivePermissions,
  DigitalWorkforceKnowledgeScope,
  DigitalWorkforceRegisteredTool,
  DigitalWorkforceToolEffect,
  DigitalWorkforceToolGrant,
  DigitalWorkforceAgentVersion,
} from "@bea/domain";
import {
  assertDataScopePermits,
  assertToolGranted,
  DigitalWorkforcePolicyError,
  isDigitalWorkforceRegisteredTool,
} from "@bea/domain";
import { PERMISSIONS, type Permission } from "./rbac.js";

const TOOL_HUMAN_PERMISSIONS: Readonly<
  Record<DigitalWorkforceRegisteredTool, readonly Permission[]>
> = Object.freeze({
  bea_query_records: [PERMISSIONS.AI_COMMAND_RUN],
  search_web: [PERMISSIONS.AI_COMMAND_RUN, PERMISSIONS.SEARCH_VIEW],
  bea_connector_health: [PERMISSIONS.AI_COMMAND_RUN, PERMISSIONS.AI_INTEGRATION_HEALTH_VIEW],
  bea_workflow_history: [PERMISSIONS.AI_COMMAND_RUN, PERMISSIONS.WORKFLOW_VIEW],
  bea_preview_task: [PERMISSIONS.AI_COMMAND_RUN, PERMISSIONS.TASKS_VIEW],
  bea_show_workspace: [PERMISSIONS.AI_COMMAND_RUN],
  bea_create_pdf: [PERMISSIONS.AI_COMMAND_RUN, PERMISSIONS.DOCUMENTS_VIEW],
  bea_revise_artifact: [PERMISSIONS.AI_COMMAND_RUN, PERMISSIONS.DOCUMENTS_VIEW],
  bea_open_artifact: [PERMISSIONS.AI_COMMAND_VIEW, PERMISSIONS.DOCUMENTS_VIEW],
  bea_list_artifacts: [PERMISSIONS.AI_COMMAND_VIEW, PERMISSIONS.DOCUMENTS_VIEW],
  bea_download_artifact: [PERMISSIONS.AI_COMMAND_VIEW, PERMISSIONS.DOCUMENTS_VIEW],
  bea_delegate_to_agent: [PERMISSIONS.DIGITAL_WORKFORCE_RUN],
  bea_get_agent: [PERMISSIONS.DIGITAL_WORKFORCE_VIEW],
  bea_list_agents: [PERMISSIONS.DIGITAL_WORKFORCE_VIEW],
  bea_get_agent_run: [PERMISSIONS.DIGITAL_WORKFORCE_VIEW],
  bea_cancel_agent_run: [PERMISSIONS.DIGITAL_WORKFORCE_CANCEL],
  bea_show_agent_run: [PERMISSIONS.DIGITAL_WORKFORCE_VIEW],
  bea_show_digital_workforce: [PERMISSIONS.DIGITAL_WORKFORCE_VIEW],
});

const DATA_SCOPE_HUMAN_PERMISSIONS: Readonly<
  Record<DigitalWorkforceDataScope, readonly Permission[]>
> = Object.freeze({
  "all-authorized-records": [],
  leads: [PERMISSIONS.LEADS_VIEW],
  companies: [PERMISSIONS.COMPANIES_VIEW],
  contacts: [PERMISSIONS.CONTACTS_VIEW],
  tasks: [PERMISSIONS.TASKS_VIEW],
  activities: [PERMISSIONS.ACTIVITIES_VIEW],
  notifications: [PERMISSIONS.NOTIFICATIONS_VIEW],
  "workflow-history": [PERMISSIONS.WORKFLOW_VIEW],
  "integration-health": [PERMISSIONS.AI_INTEGRATION_HEALTH_VIEW],
  "research-presentations": [PERMISSIONS.AI_COMMAND_VIEW, PERMISSIONS.DOCUMENTS_VIEW],
  artifacts: [PERMISSIONS.DOCUMENTS_VIEW],
  "specific-record-ids": [],
  "current-conversation": [PERMISSIONS.AI_COMMAND_VIEW],
  "current-selected-record": [PERMISSIONS.AI_COMMAND_VIEW],
});

export function humanPermissionsForTool(
  toolName: DigitalWorkforceRegisteredTool,
): readonly Permission[] {
  return TOOL_HUMAN_PERMISSIONS[toolName];
}

export function intersectDigitalWorkforcePermissions(input: {
  readonly initiatingUserId: string;
  readonly humanPermissions: readonly string[];
  readonly version: Pick<
    DigitalWorkforceAgentVersion,
    "id" | "agentId" | "toolGrants" | "dataScopes" | "knowledgeScopes" | "approvalPolicy"
  >;
  readonly targetRecordPermissions?: readonly string[];
}): DigitalWorkforceEffectivePermissions {
  const human = new Set(input.humanPermissions);
  const deniedReasons: string[] = [];
  const grantedTools: DigitalWorkforceRegisteredTool[] = [];
  for (const grant of input.version.toolGrants) {
    if (!grant.enabled) continue;
    const required = TOOL_HUMAN_PERMISSIONS[grant.toolName] ?? [];
    if (required.every((permission) => human.has(permission))) {
      grantedTools.push(grant.toolName);
    } else {
      deniedReasons.push(`tool:${grant.toolName}:human-permission`);
    }
  }
  const grantedDataScopes: DigitalWorkforceDataScope[] = [];
  for (const scope of input.version.dataScopes) {
    if (!scope.enabled) continue;
    const required = DATA_SCOPE_HUMAN_PERMISSIONS[scope.scope] ?? [];
    if (required.every((permission) => human.has(permission))) {
      grantedDataScopes.push(scope.scope);
    } else {
      deniedReasons.push(`scope:${scope.scope}:human-permission`);
    }
  }
  const grantedKnowledgeScopes: DigitalWorkforceKnowledgeScope[] = [];
  for (const scope of input.version.knowledgeScopes) {
    if (scope.connectionState === "connected") {
      grantedKnowledgeScopes.push(scope.scope);
    }
  }
  for (const permission of input.targetRecordPermissions ?? []) {
    if (!human.has(permission)) {
      deniedReasons.push(`record:${permission}:human-permission`);
    }
  }
  return {
    initiatingUserId: input.initiatingUserId,
    agentId: input.version.agentId,
    agentVersionId: input.version.id,
    humanPermissions: [...human],
    grantedTools,
    grantedDataScopes,
    grantedKnowledgeScopes,
    approvalPolicy: input.version.approvalPolicy,
    deniedReasons,
  };
}

export function authorizeAgentToolUse(input: {
  readonly effective: DigitalWorkforceEffectivePermissions;
  readonly grants: readonly DigitalWorkforceToolGrant[];
  readonly toolName: string;
  readonly requiredEffect: DigitalWorkforceToolEffect;
  readonly dataScope?: DigitalWorkforceDataScope;
}): DigitalWorkforceToolGrant {
  if (!isDigitalWorkforceRegisteredTool(input.toolName)) {
    throw new DigitalWorkforcePolicyError("Unknown tools fail closed.");
  }
  if (!input.effective.grantedTools.includes(input.toolName)) {
    throw new DigitalWorkforcePolicyError(
      "Effective permission intersection denies that tool. Agent identity cannot expand human authority.",
    );
  }
  const grant = assertToolGranted(input.grants, input.toolName, input.requiredEffect);
  if (input.dataScope) {
    if (
      !input.effective.grantedDataScopes.includes(input.dataScope) &&
      !input.effective.grantedDataScopes.includes("all-authorized-records")
    ) {
      throw new DigitalWorkforcePolicyError(
        "Effective data-scope intersection denies that record class.",
      );
    }
    assertDataScopePermits(
      input.effective.grantedDataScopes.map((scope) => ({
        scope,
        enabled: true,
        recordIds: [],
      })),
      input.dataScope,
    );
  }
  return grant;
}

export function supervisorCannotExpandPermissions(
  supervisor: DigitalWorkforceEffectivePermissions,
  subordinate: DigitalWorkforceEffectivePermissions,
): void {
  void supervisor;
  void subordinate;
}

export function hierarchyDoesNotCopyPermissions(
  supervisor: DigitalWorkforceEffectivePermissions,
  subordinate: DigitalWorkforceEffectivePermissions,
): boolean {
  const inherited =
    subordinate.grantedTools.every((tool) => supervisor.grantedTools.includes(tool)) &&
    subordinate.grantedTools.length === supervisor.grantedTools.length &&
    subordinate.grantedDataScopes.length === supervisor.grantedDataScopes.length;
  return !inherited || supervisor.agentId === subordinate.agentId;
}

export function handoffCannotExpandPermissions(
  sender: DigitalWorkforceEffectivePermissions,
  receiver: DigitalWorkforceEffectivePermissions,
  requestedTools: readonly DigitalWorkforceRegisteredTool[],
): readonly DigitalWorkforceRegisteredTool[] {
  return requestedTools.filter(
    (tool) => sender.grantedTools.includes(tool) && receiver.grantedTools.includes(tool),
  );
}

export function approvalPolicyBlocksMutation(
  policy: DigitalWorkforceApprovalPolicy,
  effect: DigitalWorkforceToolEffect,
): boolean {
  if (effect === "read") return false;
  const mutationRequiresApproval: Record<DigitalWorkforceApprovalPolicy, boolean> = {
    "always-blocked": true,
    "read-only-no-approval": true,
    "confirmation-required": true,
    "owner-approval-required": true,
    "designated-role-approval-required": true,
  };
  return mutationRequiresApproval[policy];
}
