import type { NextRequest } from "next/server";

import { requestCorrelationId, webRouteLogger } from "@/app/api/route-helpers";
import { apiJson } from "@/lib/api-response";
import { getFoundationSnapshot } from "@/lib/foundation";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/health", "GET");
  try {
    const snapshot = await getFoundationSnapshot();
    const statusCode = snapshot.status === "healthy" ? 200 : 503;
    logger[statusCode === 200 ? "info" : "warn"](
      { status: snapshot.status },
      "Web health check completed",
    );
    return apiJson(
      {
        service: "bea-operations-command-center-web",
        status: snapshot.status,
        phase: "0",
        timestamp: snapshot.generatedAt,
        correlationId,
        components: {
          web: "healthy",
          database: snapshot.databaseHealth.status,
          worker: snapshot.workerHealth.status,
          providerRegistry: {
            status: snapshot.integrationHealth.status,
            total: snapshot.integrationHealth.total,
            simulated: snapshot.integrationHealth.simulated,
            connected: snapshot.integrationHealth.connected,
            failed: snapshot.integrationHealth.failed,
          },
        },
      },
      correlationId,
      { status: statusCode, noStore: true },
    );
  } catch (error) {
    logger.error(
      {
        errorName: error instanceof Error ? error.name : "UnknownError",
      },
      "Web health check failed",
    );
    return apiJson(
      {
        service: "bea-operations-command-center-web",
        status: "unhealthy",
        phase: "0",
        timestamp: new Date().toISOString(),
        correlationId,
        components: {
          web: "degraded",
          database: "unavailable",
          worker: "unavailable",
          providerRegistry: { status: "unknown" },
        },
      },
      correlationId,
      { status: 503, noStore: true },
    );
  }
}
