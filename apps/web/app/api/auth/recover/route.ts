import { getServerRuntime } from "@bea/database";
import { NextRequest } from "next/server";

import { requestCorrelationId, webRouteLogger } from "@/app/api/route-helpers";
import { apiException } from "@/lib/api-response";
import { handleLocalOwnerRecovery } from "@/lib/local-owner-recovery";

export async function POST(request: NextRequest) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/auth/recover", "POST");
  try {
    const response = await handleLocalOwnerRecovery(
      request,
      await getServerRuntime(),
      correlationId,
    );
    logger.info({ status: response.status }, "Local Owner recovery request completed");
    return response;
  } catch (error) {
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Local Owner recovery request failed",
    );
    return apiException(error, 500, correlationId, false);
  }
}
