import type { HealthStatus, IsoDateTime, JsonObject } from "@bea/domain";

export interface ComponentHealth {
  readonly name: string;
  readonly status: HealthStatus;
  readonly checkedAt: IsoDateTime;
  readonly detail?: string;
  readonly metadata?: JsonObject;
}

export interface ApplicationHealth {
  readonly status: Exclude<HealthStatus, "unknown">;
  readonly checkedAt: IsoDateTime;
  readonly components: readonly ComponentHealth[];
}

export function aggregateHealth(
  components: readonly ComponentHealth[],
  checkedAt = new Date().toISOString(),
): ApplicationHealth {
  const status = components.some((component) => component.status === "unhealthy")
    ? "unhealthy"
    : components.some(
          (component) => component.status === "degraded" || component.status === "unknown",
        )
      ? "degraded"
      : "healthy";
  return { status, checkedAt, components };
}
