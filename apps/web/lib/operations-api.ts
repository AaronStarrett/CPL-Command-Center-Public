import {
  OperationsConcurrencyError,
  OperationsNotFoundError,
  OperationsStatusTransitionError,
  OperationsValidationError,
  OperationsAuthorizationError,
  ConfigurationActivationError,
  ConfigurationImmutabilityError,
  ConfigurationValidationError,
  ProductionMappingNotConfiguredError,
  StagingSourceTooLargeError,
  UnsafeTransformationError,
  WorkItemClaimError,
  WorkProjectionNotFoundError,
  WorkProjectionRetryConflictError,
  CommercialCatalogValidationError,
  CommercialConcurrencyError,
  CommercialNotFoundError,
  CommercialValidationError,
  CatalogActivationError,
  CatalogImmutabilityError,
  ProductionCatalogNotConfiguredError,
  ProposalAuthorizationError,
  ProposalImmutabilityError,
  ProposalStatusTransitionError,
  MoneyArithmeticError,
  GuidedDemoAuthorizationError,
  GuidedDemoConcurrencyError,
  GuidedDemoConflictError,
  GuidedDemoIntegrityError,
  GuidedDemoUnavailableError,
  GuidedDemoValidationError,
} from "@bea/domain";
import { getServerRuntime, type BeaServerRuntime } from "@bea/database";

export async function getOperationsServerRuntime(): Promise<BeaServerRuntime> {
  return getServerRuntime();
}

export function operationsMutationErrorStatus(
  error: unknown,
): { code: string; message: string; status: number } | null {
  if (error instanceof OperationsValidationError) {
    return { code: "invalid-operations", message: error.message, status: 400 };
  }
  if (error instanceof OperationsNotFoundError) {
    return { code: "operations-not-found", message: error.message, status: 404 };
  }
  if (error instanceof OperationsStatusTransitionError) {
    return { code: "invalid-transition", message: error.message, status: 409 };
  }
  if (error instanceof OperationsConcurrencyError) {
    return { code: "operations-conflict", message: error.message, status: 409 };
  }
  if (error instanceof OperationsAuthorizationError) {
    return { code: "permission-not-granted", message: error.message, status: 403 };
  }
  if (error instanceof WorkProjectionNotFoundError) {
    return { code: "work-projection-not-found", message: error.message, status: 404 };
  }
  if (error instanceof WorkProjectionRetryConflictError) {
    return { code: "work-projection-retry-conflict", message: error.message, status: 409 };
  }
  if (error instanceof WorkItemClaimError) {
    return { code: "work-item-claim-refused", message: error.message, status: 403 };
  }
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code: string }).code);
    const guidedMessage = error instanceof Error ? error.message : "Demonstration command refused.";
    if (code === "GUIDED_DEMO_UNAVAILABLE") {
      return { code: "guided-demo-unavailable", message: guidedMessage, status: 404 };
    }
    if (code === "GUIDED_DEMO_AUTHORIZATION") {
      return { code: "permission-not-granted", message: guidedMessage, status: 403 };
    }
    if (code === "GUIDED_DEMO_CONCURRENCY") {
      return { code: "guided-demo-conflict", message: guidedMessage, status: 409 };
    }
    if (code === "GUIDED_DEMO_CONFLICT") {
      return { code: "invalid-transition", message: guidedMessage, status: 409 };
    }
    if (code === "GUIDED_DEMO_VALIDATION") {
      return { code: "invalid-guided-demo", message: guidedMessage, status: 400 };
    }
    if (code === "GUIDED_DEMO_INTEGRITY") {
      return { code: "guided-demo-integrity", message: guidedMessage, status: 409 };
    }
    if (code === "WORK_ITEM_TRANSITION_INVALID" || code === "WORK_ITEM_MANUAL_COMPLETION_REFUSED") {
      return {
        code: code.toLowerCase().replaceAll("_", "-"),
        message: error instanceof Error ? error.message : "Work item mutation refused.",
        status: 409,
      };
    }
    if (code === "WORK_ITEM_CLAIM_REFUSED") {
      return {
        code: "work-item-claim-refused",
        message: error instanceof Error ? error.message : "Claim refused.",
        status: 403,
      };
    }
    if (code === "WORK_ITEM_REASSIGN_REFUSED") {
      return {
        code: "work-item-reassign-refused",
        message: error instanceof Error ? error.message : "Reassignment refused.",
        status: 400,
      };
    }
  }
  if (error instanceof ConfigurationValidationError) {
    return { code: error.code, message: error.message, status: 400 };
  }
  if (error instanceof ConfigurationImmutabilityError) {
    return { code: error.code, message: error.message, status: 409 };
  }
  if (error instanceof ConfigurationActivationError) {
    return { code: error.code, message: error.message, status: 409 };
  }
  if (error instanceof ProductionMappingNotConfiguredError) {
    return { code: error.code, message: error.message, status: 409 };
  }
  if (error instanceof StagingSourceTooLargeError) {
    return { code: error.code, message: error.message, status: 413 };
  }
  if (error instanceof UnsafeTransformationError) {
    return { code: error.code, message: error.message, status: 400 };
  }
  if (
    error instanceof CommercialValidationError ||
    error instanceof MoneyArithmeticError ||
    error instanceof CommercialCatalogValidationError
  ) {
    return { code: "invalid-proposal", message: error.message, status: 400 };
  }
  if (error instanceof CommercialNotFoundError) {
    return { code: "proposal-not-found", message: error.message, status: 404 };
  }
  if (error instanceof CommercialConcurrencyError) {
    return { code: "proposal-conflict", message: error.message, status: 409 };
  }
  if (
    error instanceof ProposalAuthorizationError ||
    error instanceof ProductionCatalogNotConfiguredError
  ) {
    return { code: "permission-not-granted", message: error.message, status: 403 };
  }
  if (
    error instanceof ProposalStatusTransitionError ||
    error instanceof ProposalImmutabilityError ||
    error instanceof CatalogImmutabilityError ||
    error instanceof CatalogActivationError
  ) {
    return {
      code: "invalid-transition",
      message: error.message,
      status: error instanceof ProposalStatusTransitionError ? 409 : 409,
    };
  }
  if (error instanceof GuidedDemoUnavailableError) {
    return { code: "guided-demo-unavailable", message: error.message, status: 404 };
  }
  if (error instanceof GuidedDemoAuthorizationError) {
    return { code: "permission-not-granted", message: error.message, status: 403 };
  }
  if (error instanceof GuidedDemoConcurrencyError) {
    return { code: "guided-demo-conflict", message: error.message, status: 409 };
  }
  if (error instanceof GuidedDemoConflictError) {
    return { code: "invalid-transition", message: error.message, status: 409 };
  }
  if (error instanceof GuidedDemoValidationError) {
    return { code: "invalid-guided-demo", message: error.message, status: 400 };
  }
  if (error instanceof GuidedDemoIntegrityError) {
    return { code: "guided-demo-integrity", message: error.message, status: 409 };
  }
  return null;
}

export function optionalOperationsString(
  value: unknown,
  maxLength: number,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length <= maxLength ? normalized || null : undefined;
}
