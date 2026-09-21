import { SALES_COMMERCIAL_WORK_KINDS, isSalesCommercialWorkKind } from "@bea/domain";
import { PERMISSIONS, type Permission } from "@bea/security";

export function permissionForWorkAction(action: string): {
  readonly permission: Permission;
  readonly alternatePermission?: Permission;
  readonly auditAction: string;
} | null {
  switch (action) {
    case "claim":
      return {
        permission: PERMISSIONS.WORK_CLAIM,
        alternatePermission: PERMISSIONS.PROPOSALS_WORK_CLAIM,
        auditAction: "work.claim",
      };
    case "release":
      return {
        permission: PERMISSIONS.WORK_CLAIM,
        alternatePermission: PERMISSIONS.PROPOSALS_WORK_CLAIM,
        auditAction: "work.release",
      };
    case "acknowledge":
    case "start":
    case "block":
    case "unblock":
      return { permission: PERMISSIONS.WORK_UPDATE, auditAction: `work.${action}` };
    case "reassign":
      return { permission: PERMISSIONS.WORK_REASSIGN, auditAction: "work.reassign" };
    case "reconcile-dry-run":
      return {
        permission: PERMISSIONS.WORK_SCHEDULES_MANAGE,
        auditAction: "work.reconcile-dry-run",
      };
    case "reconcile-execute":
      return { permission: PERMISSIONS.WORK_RECONCILE, auditAction: "work.reconcile-execute" };
    case "inspect-policy":
    case "validate-policy-preview":
    case "activation-readiness-preview":
      return {
        permission: PERMISSIONS.WORK_SCHEDULES_VIEW,
        auditAction: `orchestration.${action}`,
      };
    case "retry-projection":
    case "retry-job":
    case "cancel-job":
      return {
        permission: PERMISSIONS.INTEGRATIONS_MANAGE,
        auditAction: `work.${action}`,
      };
    case "provisioning-plan":
      return { permission: PERMISSIONS.WORK_SCHEDULES_VIEW, auditAction: "work.provisioning-plan" };
    default:
      return null;
  }
}

export function workViewPermission(view: string): Permission {
  if (view === "notifications") return PERMISSIONS.WORK_NOTIFICATIONS_VIEW;
  if (view === "scheduler" || view === "policies") return PERMISSIONS.WORK_SCHEDULES_VIEW;
  if (view === "projection-failures") return PERMISSIONS.WORK_VIEW;
  return PERMISSIONS.WORK_VIEW;
}

export function workViewAlternatePermission(view: string): Permission | null {
  if (view === "my" || view === "queues" || view === "at-risk" || view === "metrics" || !view) {
    return PERMISSIONS.PROPOSALS_WORK_VIEW;
  }
  return null;
}

export const SALES_VISIBLE_WORK_KINDS = SALES_COMMERCIAL_WORK_KINDS;

export function restrictWorkItemsForActor<T extends { readonly workItemKind: string }>(
  items: readonly T[],
  input: { readonly hasFullWorkView: boolean },
): readonly T[] {
  if (input.hasFullWorkView) return items;
  return items.filter((item) => isSalesCommercialWorkKind(item.workItemKind));
}

export function actorCanSeeWorkKind(
  kind: string,
  input: { readonly hasFullWorkView: boolean },
): boolean {
  return input.hasFullWorkView || isSalesCommercialWorkKind(kind);
}

export function sanitizeWorkItemForActor<T extends { readonly workItemKind: string }>(
  item: T,
  input: { readonly hasFullWorkView: boolean },
): T {
  if (input.hasFullWorkView || isSalesCommercialWorkKind(item.workItemKind)) return item;
  return item;
}
