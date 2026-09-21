export interface RuntimePresentationEnvironment {
  readonly appMode?: string;
  readonly runtimeMode?: string;
  readonly deploymentProfile?: string;
}

export type ProviderHealthPresentation = "degraded" | "healthy" | "simulated" | "unavailable";

export function createRuntimePresentation(
  environment: RuntimePresentationEnvironment,
  deploymentProfileOverride?: string,
) {
  const ownerEvaluation = environment.deploymentProfile === "owner-evaluation";
  const production =
    environment.appMode === "production" || environment.runtimeMode === "production";
  const deploymentProfile = environment.deploymentProfile ?? deploymentProfileOverride;
  const localLive = production && deploymentProfile === "local-live";
  const profileLabel = localLive
    ? "Local Live Production"
    : ownerEvaluation
      ? "Owner Evaluation"
      : production
        ? "Production"
        : "BEA";

  return Object.freeze({
    production,
    localLive,
    ownerEvaluation,
    profileLabel,
    dashboardBadge: ownerEvaluation
      ? "Owner Evaluation"
      : production
        ? profileLabel
        : "Synthetic BEA data",
    dashboardDescription: production
      ? "Counts below are read from the production SQL record store and include only areas the signed-in account may access."
      : ownerEvaluation
        ? "Counts below are synthetic BEA records used for Owner Evaluation. They are not live business data."
        : "Live counts below are read from the Phase 1 SQL record store and shown only for areas your current role may access.",
    integrationsDescription:
      production || ownerEvaluation
        ? "Connect OpenAI and review the connection state of BEA-owned providers."
        : "Configure live OpenAI separately from synthetic BEA records and disconnected business providers.",
    integrationsBoundary:
      production || ownerEvaluation
        ? "OpenAI can be configured as a live AI service. Business providers remain unavailable until an authorized connection is completed; BEA does not substitute sample records or provider answers."
        : "OpenAI may be configured as a live AI service. Other business providers remain disconnected or simulated, and BEA business records remain synthetic.",
    administrationBadge: ownerEvaluation
      ? "Owner Evaluation"
      : production
        ? profileLabel
        : "Administration",
    authenticationLabel: production ? "Authentication" : "Authentication",
    auditTitle: "Persistent audit",
    auditDescription: production
      ? "Recent authentication, authorization, workflow, and provider events read from the protected SQL audit repository."
      : "Recent authentication, authorization, workflow, and provider events read from the shared SQL audit repository.",
    accountEyebrow: production ? `${profileLabel} identity` : "Local evaluation identity",
    accountDescription: production
      ? "Inspect the server-held account projection for this protected session."
      : "Inspect the server-held persona projection for this opaque session token.",
    accountIdentifierLabel: production ? "Account ID" : "Persona ID",
    accountEmailLabel: "Email",
  });
}

export function providerHealthPresentation(
  connectionStatus: string,
  production: boolean,
): ProviderHealthPresentation {
  if (!production) return "simulated";
  if (connectionStatus === "connected") return "healthy";
  if (connectionStatus === "connection-failed" || connectionStatus === "degraded") {
    return "degraded";
  }
  return "unavailable";
}
