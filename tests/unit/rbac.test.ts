import { describe, expect, it } from "vitest";
import { DEMO_ROLE_IDS } from "../../packages/domain/src/index.js";
import {
  PERMISSIONS,
  ROLE_PERMISSION_MATRIX,
  authorize,
  resolveTaskReadScope,
  roleHasPermission,
} from "../../packages/security/src/index.js";
import {
  APPROVED_CURRENT_ROLE_PERMISSIONS,
  APPROVED_PHASE1_ROLE_PERMISSIONS,
} from "../approved-phase1-rbac.js";

describe("deny-by-default RBAC", () => {
  it("allows configured role permissions", () => {
    expect(
      roleHasPermission(DEMO_ROLE_IDS.INTEGRATION_ADMIN, PERMISSIONS.INTEGRATIONS_MANAGE),
    ).toBe(true);
    expect(
      authorize({ roleIds: [DEMO_ROLE_IDS.INTEGRATION_ADMIN] }, PERMISSIONS.INTEGRATIONS_MANAGE),
    ).toEqual({ allowed: true });
  });
  it("denies absent and ungranted roles", () => {
    expect(authorize({ roleIds: [] }, PERMISSIONS.HOME_VIEW)).toMatchObject({
      allowed: false,
      reason: "unauthenticated",
    });
    expect(
      authorize({ roleIds: [DEMO_ROLE_IDS.SALES] }, PERMISSIONS.ADMINISTRATION_VIEW),
    ).toMatchObject({ allowed: false, reason: "permission-not-granted" });
  });
  it("does not treat a missing permission requirement as public", () => {
    expect(authorize({ roleIds: [DEMO_ROLE_IDS.OWNER_ADMIN] }, undefined)).toMatchObject({
      allowed: false,
      reason: "invalid-requirement",
    });
  });

  it("matches the owner-approved Phase 1 grants exactly for every role", () => {
    for (const roleId of Object.values(DEMO_ROLE_IDS)) {
      expect([...ROLE_PERMISSION_MATRIX[roleId]].sort()).toEqual(
        [...APPROVED_CURRENT_ROLE_PERMISSIONS[roleId]].sort(),
      );
    }
  });

  it("keeps the Phase 1 freeze fixture independent of the live matrix", () => {
    expect(APPROVED_PHASE1_ROLE_PERMISSIONS[DEMO_ROLE_IDS.SALES]).not.toContain(
      PERMISSIONS.OPERATIONS_BOARD_VIEW,
    );
    expect(ROLE_PERMISSION_MATRIX[DEMO_ROLE_IDS.SALES]).toContain(
      PERMISSIONS.OPERATIONS_BOARD_VIEW,
    );
    expect(APPROVED_PHASE1_ROLE_PERMISSIONS[DEMO_ROLE_IDS.OPERATIONS]).not.toContain(
      PERMISSIONS.REPORTS_APPROVE,
    );
    expect(ROLE_PERMISSION_MATRIX[DEMO_ROLE_IDS.OPERATIONS]).toContain(PERMISSIONS.REPORTS_APPROVE);
  });

  it("keeps executive reads separate from mutation and integration administration", () => {
    const executive = { roleIds: [DEMO_ROLE_IDS.EXECUTIVE_READONLY] } as const;
    expect(resolveTaskReadScope(executive)).toBe("all");
    expect(authorize(executive, PERMISSIONS.TASKS_MANAGE)).toMatchObject({ allowed: false });
    expect(authorize(executive, PERMISSIONS.TASK_ACTION_EXECUTE)).toMatchObject({ allowed: false });
    expect(authorize(executive, PERMISSIONS.NOTIFICATIONS_MANAGE)).toMatchObject({
      allowed: false,
    });
    expect(authorize(executive, PERMISSIONS.INTEGRATIONS_VIEW)).toMatchObject({ allowed: false });
  });

  it("keeps integration administration connector-only", () => {
    const integrationAdmin = { roleIds: [DEMO_ROLE_IDS.INTEGRATION_ADMIN] } as const;
    expect(resolveTaskReadScope(integrationAdmin)).toBe("none");
    expect(authorize(integrationAdmin, PERMISSIONS.AI_INTEGRATION_HEALTH_VIEW)).toEqual({
      allowed: true,
    });
    for (const permission of [
      PERMISSIONS.COMPANIES_VIEW,
      PERMISSIONS.CONTACTS_VIEW,
      PERMISSIONS.TASKS_VIEW,
      PERMISSIONS.ACTIVITIES_VIEW,
      PERMISSIONS.NOTIFICATIONS_VIEW,
      PERMISSIONS.TASK_ACTION_EXECUTE,
      PERMISSIONS.WORKFLOW_VIEW,
      PERMISSIONS.AUDIT_VIEW,
    ]) {
      expect(authorize(integrationAdmin, permission)).toMatchObject({ allowed: false });
    }
  });

  it("retains full operational task scope without granting integration administration", () => {
    for (const roleId of [DEMO_ROLE_IDS.SALES, DEMO_ROLE_IDS.OPERATIONS]) {
      const subject = { roleIds: [roleId] };
      expect(resolveTaskReadScope(subject)).toBe("all");
      expect(authorize(subject, PERMISSIONS.TASK_ACTION_EXECUTE)).toEqual({ allowed: true });
      expect(authorize(subject, PERMISSIONS.AUDIT_VIEW)).toMatchObject({ allowed: false });
      expect(authorize(subject, PERMISSIONS.INTEGRATIONS_MANAGE)).toMatchObject({ allowed: false });
    }
    expect(authorize({ roleIds: [DEMO_ROLE_IDS.SALES] }, PERMISSIONS.WORKFLOW_VIEW)).toMatchObject({
      allowed: false,
    });
    expect(authorize({ roleIds: [DEMO_ROLE_IDS.OPERATIONS] }, PERMISSIONS.WORKFLOW_VIEW)).toEqual({
      allowed: true,
    });
  });

  it("keeps Phase 3.1A configuration publish and activate Owner-only", () => {
    const sales = { roleIds: [DEMO_ROLE_IDS.SALES] };
    const operations = { roleIds: [DEMO_ROLE_IDS.OPERATIONS] };
    const owner = { roleIds: [DEMO_ROLE_IDS.OWNER_ADMIN] };
    const integration = { roleIds: [DEMO_ROLE_IDS.INTEGRATION_ADMIN] };
    const executive = { roleIds: [DEMO_ROLE_IDS.EXECUTIVE_READONLY] };
    expect(authorize(owner, PERMISSIONS.CONFIGURATION_POLICY_APPROVE)).toEqual({ allowed: true });
    expect(authorize(integration, PERMISSIONS.CONFIGURATION_POLICY_APPROVE)).toMatchObject({
      allowed: false,
    });
    expect(authorize(operations, PERMISSIONS.CONFIGURATION_POLICY_APPROVE)).toMatchObject({
      allowed: false,
    });
    expect(authorize(operations, PERMISSIONS.CONFIGURATION_MAPPING_EDIT)).toMatchObject({
      allowed: false,
    });
    expect(authorize(owner, PERMISSIONS.CONFIGURATION_ACTIVATE)).toEqual({ allowed: true });
    expect(authorize(integration, PERMISSIONS.CONFIGURATION_VIEW)).toEqual({ allowed: true });
    expect(authorize(integration, PERMISSIONS.CONFIGURATION_DRAFT)).toEqual({ allowed: true });
    expect(authorize(integration, PERMISSIONS.CONFIGURATION_VALIDATE)).toEqual({ allowed: true });
    expect(authorize(integration, PERMISSIONS.CONFIGURATION_MAPPING_EDIT)).toEqual({
      allowed: true,
    });
    expect(authorize(integration, PERMISSIONS.CONFIGURATION_DRY_RUN)).toEqual({ allowed: true });
    expect(authorize(integration, PERMISSIONS.CONFIGURATION_PUBLISH)).toMatchObject({
      allowed: false,
    });
    expect(authorize(integration, PERMISSIONS.CONFIGURATION_ACTIVATE)).toMatchObject({
      allowed: false,
    });
    expect(authorize(operations, PERMISSIONS.CONFIGURATION_VIEW)).toEqual({ allowed: true });
    expect(authorize(operations, PERMISSIONS.CONFIGURATION_DRY_RUN)).toEqual({ allowed: true });
    expect(authorize(operations, PERMISSIONS.CONFIGURATION_PUBLISH)).toMatchObject({
      allowed: false,
    });
    expect(authorize(operations, PERMISSIONS.CONFIGURATION_ACTIVATE)).toMatchObject({
      allowed: false,
    });
    expect(authorize(executive, PERMISSIONS.CONFIGURATION_VIEW)).toEqual({ allowed: true });
    expect(authorize(executive, PERMISSIONS.CONFIGURATION_DRAFT)).toMatchObject({ allowed: false });
    expect(authorize(sales, PERMISSIONS.CONFIGURATION_VIEW)).toMatchObject({ allowed: false });
    expect(authorize(sales, PERMISSIONS.CONFIGURATION_DRAFT)).toMatchObject({ allowed: false });
    expect(authorize(sales, PERMISSIONS.CONFIGURATION_PUBLISH)).toMatchObject({ allowed: false });
  });

  it("keeps Phase 3.0 sales view-only and Owner-only delivery authorization", () => {
    const sales = { roleIds: [DEMO_ROLE_IDS.SALES] };
    const operations = { roleIds: [DEMO_ROLE_IDS.OPERATIONS] };
    const owner = { roleIds: [DEMO_ROLE_IDS.OWNER_ADMIN] };
    const integration = { roleIds: [DEMO_ROLE_IDS.INTEGRATION_ADMIN] };
    expect(authorize(sales, PERMISSIONS.OPERATIONS_BOARD_VIEW)).toEqual({ allowed: true });
    expect(authorize(sales, PERMISSIONS.INSPECTIONS_VIEW)).toEqual({ allowed: true });
    expect(authorize(sales, PERMISSIONS.INSPECTIONS_SUBMIT)).toMatchObject({ allowed: false });
    expect(authorize(sales, PERMISSIONS.INSPECTIONS_CORRECT)).toMatchObject({ allowed: false });
    expect(authorize(sales, PERMISSIONS.REPORTS_APPROVE)).toMatchObject({ allowed: false });
    expect(authorize(sales, PERMISSIONS.REPORTS_DELIVER)).toMatchObject({ allowed: false });
    expect(authorize(operations, PERMISSIONS.REPORTS_APPROVE)).toEqual({ allowed: true });
    expect(authorize(operations, PERMISSIONS.REPORTS_DELIVER)).toMatchObject({ allowed: false });
    expect(authorize(owner, PERMISSIONS.REPORTS_DELIVER)).toEqual({ allowed: true });
    expect(authorize(integration, PERMISSIONS.OPERATIONS_BOARD_VIEW)).toMatchObject({
      allowed: false,
    });
    expect(authorize(integration, PERMISSIONS.REPORTS_DELIVER)).toMatchObject({ allowed: false });
  });

  it("grants lead review permissions by role, not by a person’s display name", () => {
    const sales = { roleIds: [DEMO_ROLE_IDS.SALES] } as const;
    const operations = { roleIds: [DEMO_ROLE_IDS.OPERATIONS] } as const;
    const executive = { roleIds: [DEMO_ROLE_IDS.EXECUTIVE_READONLY] } as const;
    for (const permission of [
      PERMISSIONS.LEADS_VIEW,
      PERMISSIONS.LEADS_MANAGE,
      PERMISSIONS.LEADS_REVIEW,
      PERMISSIONS.LEADS_DISQUALIFY,
    ]) {
      expect(authorize(sales, permission)).toEqual({ allowed: true });
      expect(authorize(operations, permission)).toMatchObject({ allowed: false });
      expect(authorize(executive, permission)).toMatchObject({ allowed: false });
    }
  });

  it("keeps Phase 3.3A commercial approval Owner-only", () => {
    const sales = { roleIds: [DEMO_ROLE_IDS.SALES] };
    const operations = { roleIds: [DEMO_ROLE_IDS.OPERATIONS] };
    const owner = { roleIds: [DEMO_ROLE_IDS.OWNER_ADMIN] };
    const integration = { roleIds: [DEMO_ROLE_IDS.INTEGRATION_ADMIN] };
    const executive = { roleIds: [DEMO_ROLE_IDS.EXECUTIVE_READONLY] };
    expect(authorize(sales, PERMISSIONS.PROPOSALS_VIEW)).toEqual({ allowed: true });
    expect(authorize(sales, PERMISSIONS.PROPOSALS_CREATE)).toEqual({ allowed: true });
    expect(authorize(sales, PERMISSIONS.PROPOSALS_EDIT)).toEqual({ allowed: true });
    expect(authorize(sales, PERMISSIONS.PROPOSALS_SUBMIT)).toEqual({ allowed: true });
    expect(authorize(sales, PERMISSIONS.PROPOSALS_OVERRIDE_REQUEST)).toEqual({ allowed: true });
    expect(authorize(sales, PERMISSIONS.PROPOSALS_APPROVE)).toMatchObject({ allowed: false });
    expect(authorize(sales, PERMISSIONS.PROPOSALS_REVIEW)).toMatchObject({ allowed: false });
    expect(authorize(sales, PERMISSIONS.PROPOSALS_OVERRIDE_APPROVE)).toMatchObject({
      allowed: false,
    });
    expect(authorize(sales, PERMISSIONS.PROPOSALS_DELIVERY_PLAN)).toEqual({ allowed: true });
    expect(authorize(sales, PERMISSIONS.PROPOSALS_WORK_VIEW)).toEqual({ allowed: true });
    expect(authorize(sales, PERMISSIONS.PROPOSALS_WORK_CLAIM)).toEqual({ allowed: true });
    expect(authorize(sales, PERMISSIONS.SERVICE_CATALOG_PUBLISH)).toMatchObject({ allowed: false });
    expect(authorize(sales, PERMISSIONS.WORK_VIEW)).toMatchObject({ allowed: false });
    expect(authorize(operations, PERMISSIONS.PROPOSALS_VIEW)).toEqual({ allowed: true });
    expect(authorize(operations, PERMISSIONS.PROPOSALS_CREATE)).toMatchObject({ allowed: false });
    expect(authorize(operations, PERMISSIONS.PROPOSALS_APPROVE)).toMatchObject({ allowed: false });
    expect(authorize(executive, PERMISSIONS.PROPOSALS_VIEW)).toEqual({ allowed: true });
    expect(authorize(executive, PERMISSIONS.PROPOSALS_EDIT)).toMatchObject({ allowed: false });
    expect(authorize(executive, PERMISSIONS.PROPOSALS_APPROVE)).toMatchObject({ allowed: false });
    expect(authorize(integration, PERMISSIONS.SERVICE_CATALOG_VIEW)).toEqual({ allowed: true });
    expect(authorize(integration, PERMISSIONS.SERVICE_CATALOG_MANAGE)).toEqual({ allowed: true });
    expect(authorize(integration, PERMISSIONS.COMMERCIAL_POLICY_MANAGE)).toEqual({ allowed: true });
    expect(authorize(integration, PERMISSIONS.PROPOSALS_VIEW)).toEqual({ allowed: true });
    expect(authorize(integration, PERMISSIONS.PROPOSALS_APPROVE)).toMatchObject({ allowed: false });
    expect(authorize(integration, PERMISSIONS.SERVICE_CATALOG_PUBLISH)).toMatchObject({
      allowed: false,
    });
    expect(authorize(owner, PERMISSIONS.PROPOSALS_APPROVE)).toEqual({ allowed: true });
    expect(authorize(owner, PERMISSIONS.PROPOSALS_OVERRIDE_APPROVE)).toEqual({ allowed: true });
    expect(authorize(owner, PERMISSIONS.PROPOSALS_DELIVERY_PLAN)).toEqual({ allowed: true });
    expect(authorize(owner, PERMISSIONS.SERVICE_CATALOG_PUBLISH)).toEqual({ allowed: true });
  });
});
