export const REQUIREMENT_STATUSES = [
  "CONFIRMED",
  "ASSUMED",
  "CONFIGURABLE",
  "SIMULATED",
  "IMPLEMENTED",
  "CONNECTED",
  "BLOCKED",
  "DEFERRED",
  "REJECTED",
] as const;

export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

export type EntityStatus = "active" | "inactive" | "archived";
export type WorkflowStatus =
  "pending" | "running" | "succeeded" | "degraded" | "failed" | "cancelled";

export type IntegrationMode = "mock" | "live";
export type IntegrationConnectionStatus =
  "simulated" | "not-configured" | "connected" | "degraded" | "failed" | "disabled";

export type HealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";
