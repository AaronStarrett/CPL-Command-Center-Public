export type WorkerHealthStatus = "healthy" | "degraded" | "unhealthy" | "unavailable";

export interface WorkerHealthResult {
  readonly status: WorkerHealthStatus;
  readonly checkedAt: string;
}

export function parseWorkerHealthResponse(
  httpStatus: number,
  body: unknown,
  fallbackCheckedAt: string,
): WorkerHealthResult {
  if (!body || typeof body !== "object") {
    return { status: "unavailable", checkedAt: fallbackCheckedAt };
  }

  const candidate = body as Record<string, unknown>;
  if (candidate.service !== "bea-worker") {
    return { status: "unavailable", checkedAt: fallbackCheckedAt };
  }

  const checkedAt =
    typeof candidate.checkedAt === "string" && Number.isFinite(Date.parse(candidate.checkedAt))
      ? candidate.checkedAt
      : fallbackCheckedAt;

  if (candidate.status === "healthy" && httpStatus >= 200 && httpStatus < 300) {
    return { status: "healthy", checkedAt };
  }
  if (httpStatus === 503 && (candidate.status === "degraded" || candidate.status === "unhealthy")) {
    return { status: candidate.status, checkedAt };
  }

  return { status: "unavailable", checkedAt: fallbackCheckedAt };
}
