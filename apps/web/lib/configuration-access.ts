import {
  INTAKE_DRAFT_STATUSES,
  INTAKE_POLICY_STATUSES,
  INTAKE_TESTED_STATUSES,
  isIntakeStatus,
} from "@bea/domain";
import { PERMISSIONS, type Permission } from "@bea/security";

export function permissionForIntakeStatus(status: string): {
  readonly permission: Permission;
  readonly denyMessage: string;
} | null {
  if (!isIntakeStatus(status)) return null;
  if ((INTAKE_POLICY_STATUSES as readonly string[]).includes(status)) {
    return {
      permission: PERMISSIONS.CONFIGURATION_POLICY_APPROVE,
      denyMessage: "Only the Owner can confirm or approve configuration policy status.",
    };
  }
  if ((INTAKE_TESTED_STATUSES as readonly string[]).includes(status)) {
    return {
      permission: PERMISSIONS.CONFIGURATION_VALIDATE,
      denyMessage: "The current role cannot mark configuration intake as tested.",
    };
  }
  if ((INTAKE_DRAFT_STATUSES as readonly string[]).includes(status)) {
    return {
      permission: PERMISSIONS.CONFIGURATION_DRAFT,
      denyMessage: "The current role cannot edit configuration drafts.",
    };
  }
  return null;
}

export function permissionForConfigurationAction(
  action: string,
  options: { readonly intakeStatus?: string } = {},
): {
  readonly permission: Permission;
  readonly auditAction: string;
  readonly denyMessage: string;
} | null {
  switch (action) {
    case "create-draft":
    case "clone":
    case "update-artifact":
      return {
        permission: PERMISSIONS.CONFIGURATION_DRAFT,
        auditAction: `configuration.${action}`,
        denyMessage: "The current role cannot edit configuration drafts.",
      };
    case "update-intake": {
      const intake = permissionForIntakeStatus(options.intakeStatus ?? "");
      if (!intake) {
        return {
          permission: PERMISSIONS.CONFIGURATION_DRAFT,
          auditAction: "configuration.update-intake",
          denyMessage: "An intake status from the controlled list is required.",
        };
      }
      return {
        permission: intake.permission,
        auditAction: "configuration.update-intake",
        denyMessage: intake.denyMessage,
      };
    }
    case "validate":
      return {
        permission: PERMISSIONS.CONFIGURATION_VALIDATE,
        auditAction: "configuration.validate",
        denyMessage: "The current role cannot validate configuration releases.",
      };
    case "publish":
      return {
        permission: PERMISSIONS.CONFIGURATION_PUBLISH,
        auditAction: "configuration.publish",
        denyMessage: "The current role cannot publish configuration releases.",
      };
    case "activate":
    case "rollback":
      return {
        permission: PERMISSIONS.CONFIGURATION_ACTIVATE,
        auditAction: `configuration.${action}`,
        denyMessage: "The current role cannot activate or roll back configuration releases.",
      };
    case "archive":
      return {
        permission: PERMISSIONS.CONFIGURATION_ARCHIVE,
        auditAction: "configuration.archive",
        denyMessage: "The current role cannot archive configuration releases.",
      };
    case "dry-run-mapping":
    case "preview-report":
    case "connector-dry-run":
    case "replay-synthetic":
    case "sla-preview":
    case "compare-releases":
      return {
        permission: PERMISSIONS.CONFIGURATION_DRY_RUN,
        auditAction: `configuration.${action}`,
        denyMessage: "The current role cannot run configuration dry-runs.",
      };
    case "create-inspection":
    case "update-inspection-setup":
    case "commit-staged-inspection":
    case "reconcile-staging":
    case "retry-staging":
      return {
        permission: PERMISSIONS.INSPECTIONS_SUBMIT,
        auditAction: `inspection.${action}`,
        denyMessage: "The current role cannot create or submit inspections.",
      };
    case "export-intake":
      return {
        permission: PERMISSIONS.CONFIGURATION_VIEW,
        auditAction: "configuration.export-intake",
        denyMessage: "The current role cannot view configuration intake.",
      };
    default:
      return null;
  }
}
