import { MAX_COMMERCIAL_ARRAY_LENGTH, MAX_COMMERCIAL_TEXT_LENGTH } from "@bea/domain";
import { PERMISSIONS, type Permission } from "@bea/security";

export function permissionForProposalAction(action: string): {
  readonly permission: Permission;
  readonly auditAction: string;
  readonly denyMessage: string;
} | null {
  switch (action) {
    case "create-from-lead":
      return {
        permission: PERMISSIONS.PROPOSALS_CREATE,
        auditAction: "proposal.create",
        denyMessage: "The current role cannot create a proposal.",
      };
    case "update-draft":
    case "refresh-from-lead":
      return {
        permission: PERMISSIONS.PROPOSALS_EDIT,
        auditAction: `proposal.${action}`,
        denyMessage: "The current role cannot edit a proposal draft.",
      };
    case "submit-for-review":
      return {
        permission: PERMISSIONS.PROPOSALS_SUBMIT,
        auditAction: "proposal.submit",
        denyMessage: "The current role cannot submit a proposal for review.",
      };
    case "review":
      return {
        permission: PERMISSIONS.PROPOSALS_APPROVE,
        auditAction: "proposal.review",
        denyMessage: "The current role cannot approve or request revision of a proposal.",
      };
    case "request-override":
      return {
        permission: PERMISSIONS.PROPOSALS_OVERRIDE_REQUEST,
        auditAction: "proposal.override.request",
        denyMessage: "The current role cannot request a pricing override.",
      };
    case "decide-override":
      return {
        permission: PERMISSIONS.PROPOSALS_OVERRIDE_APPROVE,
        auditAction: "proposal.override.decide",
        denyMessage: "The current role cannot approve or reject a pricing override.",
      };
    case "delivery-manifest":
      return {
        permission: PERMISSIONS.PROPOSALS_DELIVERY_PLAN,
        auditAction: "proposal.delivery.plan",
        denyMessage: "The current role cannot generate a delivery dry-run.",
      };
    case "cancel":
      return {
        permission: PERMISSIONS.PROPOSALS_CANCEL,
        auditAction: "proposal.cancel",
        denyMessage: "The current role cannot cancel a proposal.",
      };
    case "preview":
      return {
        permission: PERMISSIONS.PROPOSALS_VIEW,
        auditAction: "proposal.preview",
        denyMessage: "The current role cannot view proposal documents.",
      };
    default:
      return null;
  }
}

export function permissionForCatalogAction(action: string): {
  readonly permission: Permission;
  readonly auditAction: string;
  readonly denyMessage: string;
} | null {
  switch (action) {
    case "validate":
    case "clone":
    case "update-package":
      return {
        permission: PERMISSIONS.SERVICE_CATALOG_MANAGE,
        auditAction: `catalog.${action}`,
        denyMessage: "The current role cannot prepare a service catalog.",
      };
    case "publish":
    case "activate":
      return {
        permission: PERMISSIONS.SERVICE_CATALOG_PUBLISH,
        auditAction: `catalog.${action}`,
        denyMessage: "The current role cannot publish or activate a service catalog.",
      };
    default:
      return null;
  }
}

export class CommercialInputError extends Error {
  readonly status = 400;
  readonly errorCode = "invalid-proposal";
  constructor(message: string) {
    super(message);
    this.name = "CommercialInputError";
  }
}

export function boundedCommercialText(
  value: unknown,
  label: string,
  max = MAX_COMMERCIAL_TEXT_LENGTH,
): string {
  if (typeof value !== "string") {
    throw new CommercialInputError(`${label} must be a string.`);
  }
  if (value.length > max) {
    throw new CommercialInputError(`${label} exceeds the permitted length.`);
  }
  return value;
}

export function parseCommercialStringArray(
  value: unknown,
  label: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new CommercialInputError(`${label} must be an array of strings.`);
  }
  if (value.length > MAX_COMMERCIAL_ARRAY_LENGTH) {
    throw new CommercialInputError(`${label} exceeds the permitted array length.`);
  }
  if (value.some((entry) => typeof entry !== "string")) {
    throw new CommercialInputError(`${label} must contain strings only.`);
  }
  return value.map((entry) => boundedCommercialText(entry, label));
}

export function parseOptionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CommercialInputError(`${label} must be a finite number.`);
  }
  return value;
}
