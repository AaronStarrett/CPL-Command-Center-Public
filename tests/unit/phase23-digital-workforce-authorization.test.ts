import { describe, expect, it } from "vitest";

import {
  DEFAULT_DIGITAL_WORKFORCE_RUNTIME_POLICY,
  DIGITAL_WORKFORCE_CONTRACT_VERSION,
  SEEDED_DIGITAL_WORKFORCE_IDS,
  type DigitalWorkforceAgentVersion,
  type DigitalWorkforceEffectivePermissions,
  type DigitalWorkforceToolGrant,
} from "../../packages/domain/src/index.js";
import {
  PERMISSIONS,
  ROLE_PERMISSION_MATRIX,
  authorize,
  authorizeAgentToolUse,
  handoffCannotExpandPermissions,
  hierarchyDoesNotCopyPermissions,
  humanPermissionsForTool,
  intersectDigitalWorkforcePermissions,
  supervisorCannotExpandPermissions,
} from "../../packages/security/src/index.js";

const ownerId = "10000000-0000-4000-8000-000000000001";

function grant(
  toolName: DigitalWorkforceToolGrant["toolName"],
  allowedEffect: DigitalWorkforceToolGrant["allowedEffect"] = "read",
): DigitalWorkforceToolGrant {
  return {
    toolName,
    enabled: true,
    allowedEffect,
    approvalRequired: allowedEffect !== "read",
    maximumCallsPerRun: 2,
    toolPolicyVersion: DIGITAL_WORKFORCE_CONTRACT_VERSION,
  };
}

function version(
  overrides: Partial<
    Pick<
      DigitalWorkforceAgentVersion,
      "id" | "agentId" | "toolGrants" | "dataScopes" | "knowledgeScopes" | "approvalPolicy"
    >
  > = {},
): Pick<
  DigitalWorkforceAgentVersion,
  "id" | "agentId" | "toolGrants" | "dataScopes" | "knowledgeScopes" | "approvalPolicy"
> {
  return {
    id: SEEDED_DIGITAL_WORKFORCE_IDS.versions.leadReview,
    agentId: SEEDED_DIGITAL_WORKFORCE_IDS.agents.leadReview,
    toolGrants: [grant("bea_query_records"), grant("bea_list_agents")],
    dataScopes: [{ scope: "leads", enabled: true, recordIds: [] }],
    knowledgeScopes: [
      {
        scope: "current-conversation",
        connectionState: "connected",
        collectionId: null,
        disclosure: "Current conversation",
      },
      {
        scope: "organizational-file-search",
        connectionState: "not-connected",
        collectionId: null,
        disclosure: "Organizational File Search is not connected.",
      },
    ],
    approvalPolicy: "confirmation-required",
    ...overrides,
  };
}

function effective(
  overrides: Partial<DigitalWorkforceEffectivePermissions> = {},
): DigitalWorkforceEffectivePermissions {
  return {
    initiatingUserId: ownerId,
    agentId: SEEDED_DIGITAL_WORKFORCE_IDS.agents.leadReview,
    agentVersionId: SEEDED_DIGITAL_WORKFORCE_IDS.versions.leadReview,
    humanPermissions: [PERMISSIONS.AI_COMMAND_RUN, PERMISSIONS.DIGITAL_WORKFORCE_VIEW],
    grantedTools: ["bea_query_records", "bea_list_agents"],
    grantedDataScopes: ["leads"],
    grantedKnowledgeScopes: ["current-conversation"],
    approvalPolicy: "confirmation-required",
    deniedReasons: [],
    ...overrides,
  };
}

describe("Phase 2.3 Digital Workforce authorization", () => {
  it("grants owner-admin every Digital Workforce permission and integration-admin none", () => {
    for (const permission of [
      PERMISSIONS.DIGITAL_WORKFORCE_VIEW,
      PERMISSIONS.DIGITAL_WORKFORCE_MANAGE,
      PERMISSIONS.DIGITAL_WORKFORCE_PUBLISH,
      PERMISSIONS.DIGITAL_WORKFORCE_RUN,
      PERMISSIONS.DIGITAL_WORKFORCE_CANCEL,
      PERMISSIONS.DIGITAL_WORKFORCE_APPROVE,
      PERMISSIONS.DIGITAL_WORKFORCE_AUDIT,
    ]) {
      expect(authorize({ roleIds: ["owner-admin"] }, permission)).toEqual({ allowed: true });
      expect(authorize({ roleIds: ["integration-admin"] }, permission)).toMatchObject({
        allowed: false,
        reason: "permission-not-granted",
      });
    }
  });

  it("grants sales, operations, and executive view plus run only", () => {
    for (const roleId of ["sales", "operations", "executive-readonly"] as const) {
      expect(ROLE_PERMISSION_MATRIX[roleId]).toContain(PERMISSIONS.DIGITAL_WORKFORCE_VIEW);
      expect(ROLE_PERMISSION_MATRIX[roleId]).toContain(PERMISSIONS.DIGITAL_WORKFORCE_RUN);
      expect(ROLE_PERMISSION_MATRIX[roleId]).not.toContain(PERMISSIONS.DIGITAL_WORKFORCE_MANAGE);
      expect(ROLE_PERMISSION_MATRIX[roleId]).not.toContain(PERMISSIONS.DIGITAL_WORKFORCE_PUBLISH);
      expect(ROLE_PERMISSION_MATRIX[roleId]).not.toContain(PERMISSIONS.DIGITAL_WORKFORCE_CANCEL);
    }
  });

  it("intersects human RBAC with tool grants and connected knowledge only", () => {
    const sales = intersectDigitalWorkforcePermissions({
      initiatingUserId: ownerId,
      humanPermissions: ROLE_PERMISSION_MATRIX.sales,
      version: version({
        toolGrants: [
          grant("bea_query_records"),
          grant("search_web"),
          grant("bea_create_pdf", "preview"),
        ],
        dataScopes: [
          { scope: "leads", enabled: true, recordIds: [] },
          { scope: "workflow-history", enabled: true, recordIds: [] },
        ],
      }),
    });
    expect(sales.grantedTools).toEqual(["bea_query_records", "search_web", "bea_create_pdf"]);
    expect(sales.grantedDataScopes).toEqual(["leads"]);
    expect(sales.grantedKnowledgeScopes).toEqual(["current-conversation"]);
    expect(sales.deniedReasons).toContain("scope:workflow-history:human-permission");
  });

  it("denies tools the human principal does not hold even when the agent lists them", () => {
    const operations = intersectDigitalWorkforcePermissions({
      initiatingUserId: ownerId,
      humanPermissions: ROLE_PERMISSION_MATRIX.operations,
      version: version({
        toolGrants: [grant("bea_cancel_agent_run", "preview")],
      }),
    });
    expect(operations.grantedTools).not.toContain("bea_cancel_agent_run");
    expect(operations.deniedReasons).toContain("tool:bea_cancel_agent_run:human-permission");
  });

  it("rejects unknown tools and tools outside the effective intersection", () => {
    const grants = [grant("bea_query_records")];
    expect(() =>
      authorizeAgentToolUse({
        effective: effective(),
        grants,
        toolName: "arbitrary_sql",
        requiredEffect: "read",
      }),
    ).toThrow(/unknown tools fail closed/iu);
    expect(() =>
      authorizeAgentToolUse({
        effective: effective({ grantedTools: ["bea_list_agents"] }),
        grants,
        toolName: "bea_query_records",
        requiredEffect: "read",
      }),
    ).toThrow(/cannot expand human authority/iu);
  });

  it("does not copy supervisor grants onto subordinates", () => {
    const supervisor = effective({
      agentId: SEEDED_DIGITAL_WORKFORCE_IDS.agents.andrewExecutive,
      grantedTools: ["bea_delegate_to_agent", "bea_create_pdf", "search_web"],
      grantedDataScopes: ["leads", "artifacts"],
    });
    const subordinate = effective({
      grantedTools: ["bea_query_records"],
      grantedDataScopes: ["leads"],
    });
    expect(() => supervisorCannotExpandPermissions(supervisor, subordinate)).not.toThrow();
    expect(hierarchyDoesNotCopyPermissions(supervisor, subordinate)).toBe(true);
    void DEFAULT_DIGITAL_WORKFORCE_RUNTIME_POLICY;
  });

  it("intersects handoff tools so the receiver cannot gain sender-only grants", () => {
    const sender = effective({
      grantedTools: ["bea_query_records", "search_web", "bea_create_pdf"],
    });
    const receiver = effective({
      agentId: SEEDED_DIGITAL_WORKFORCE_IDS.agents.executiveDocument,
      grantedTools: ["bea_create_pdf", "bea_list_artifacts"],
    });
    expect(
      handoffCannotExpandPermissions(sender, receiver, [
        "bea_query_records",
        "search_web",
        "bea_create_pdf",
      ]),
    ).toEqual(["bea_create_pdf"]);
  });

  it("maps registered Digital Workforce tools onto human permissions", () => {
    expect(humanPermissionsForTool("bea_delegate_to_agent")).toEqual([
      PERMISSIONS.DIGITAL_WORKFORCE_RUN,
    ]);
    expect(humanPermissionsForTool("bea_cancel_agent_run")).toEqual([
      PERMISSIONS.DIGITAL_WORKFORCE_CANCEL,
    ]);
    expect(humanPermissionsForTool("search_web")).toEqual([
      PERMISSIONS.AI_COMMAND_RUN,
      PERMISSIONS.SEARCH_VIEW,
    ]);
  });
});
