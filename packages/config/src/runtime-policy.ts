import {
  EnvironmentValidationError,
  parseEnvironment,
  type EnvironmentIssue,
} from "./environment.js";

export const CPL_RUNTIME_BLOCK_REASON =
  "Tenant-scoped authentication and operational routes are not enabled in this checkpoint.";

export class ProductRuntimeNotReadyError extends Error {
  readonly code = "CPL_PRODUCT_RUNTIME_NOT_READY";

  constructor() {
    super(CPL_RUNTIME_BLOCK_REASON);
    this.name = "ProductRuntimeNotReadyError";
  }
}

/** Both the requested environment and the executing process must be an isolated test harness. */
export function assertLegacyRuntimeTestOnly(
  input: Readonly<Record<string, string | undefined>>,
): void {
  if (input.NODE_ENV !== "test" || process.env.NODE_ENV !== "test") {
    throw new ProductRuntimeNotReadyError();
  }
}

export interface RuntimeConfigurationStatus {
  readonly state: "unconfigured" | "blocked" | "test";
  readonly code: "CPL_CONFIGURATION_REQUIRED" | "CPL_PRODUCT_RUNTIME_NOT_READY" | "CPL_TEST_ONLY";
  readonly issues: readonly EnvironmentIssue[];
}

/** Safe for the provisioning screen: reads no files, secrets, database, or provider adapters.
 * Complete environment variables never imply that the unfinished production runtime is ready.
 */
export function inspectRuntimeConfiguration(
  input: Readonly<Record<string, string | undefined>> = process.env,
): RuntimeConfigurationStatus {
  try {
    parseEnvironment(input);
  } catch (error) {
    if (!(error instanceof EnvironmentValidationError)) {
      return {
        state: "unconfigured",
        code: "CPL_CONFIGURATION_REQUIRED",
        issues: [{ path: "environment", message: "Secure configuration is required." }],
      };
    }
    return {
      state: "unconfigured",
      code: "CPL_CONFIGURATION_REQUIRED",
      // Do not expose configuration values or detailed backend validation to a public setup page.
      issues: error.issues.map(({ path }) => ({
        path,
        message: "Secure configuration is required.",
      })),
    };
  }
  if (input.NODE_ENV === "test" && process.env.NODE_ENV === "test") {
    return { state: "test", code: "CPL_TEST_ONLY", issues: [] };
  }
  return {
    state: "blocked",
    code: "CPL_PRODUCT_RUNTIME_NOT_READY",
    issues: [{ path: "runtime", message: CPL_RUNTIME_BLOCK_REASON }],
  };
}
export class ProductAiActivationRequiredError extends Error {
  readonly code = "CPL_AI_ACTIVATION_REQUIRED";

  constructor() {
    super("AI execution is blocked. This checkpoint has no authorized provider budget.");
    this.name = "ProductAiActivationRequiredError";
  }
}

/** Credentials and prior connection tests are not authorization to spend. */
export function assertApplicationProviderExecutionAllowed(): never {
  throw new ProductAiActivationRequiredError();
}
