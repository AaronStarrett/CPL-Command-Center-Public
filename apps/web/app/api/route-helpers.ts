import { getServerRuntime } from "@bea/database";
import { createCorrelationId, createLogger } from "@bea/observability";
import type { NextRequest } from "next/server";

import { readAuthSession, sessionCookieName } from "@/lib/auth/session-store";
import { resolveWebLoggingConfiguration } from "@/lib/web-logging-config";

export async function requestSession(request: NextRequest) {
  const runtime = await getServerRuntime();
  const name = sessionCookieName(runtime.environment.authProvider);
  return name ? readAuthSession(request.cookies.get(name)?.value) : undefined;
}

export const CORRELATION_ID_HEADER = "X-Correlation-ID";

const loggingConfiguration = resolveWebLoggingConfiguration();

const webLogger = createLogger({
  service: "bea-web",
  environment: loggingConfiguration.environment,
  level: loggingConfiguration.environment === "test" ? "silent" : loggingConfiguration.level,
});

if (loggingConfiguration.usedSafeFallback) {
  webLogger.warn({}, "Web logging configuration unavailable; safe defaults applied");
}

export function webRouteLogger(correlationId: string, route: string, method: string) {
  return webLogger.child({ correlationId, route, method });
}

export function requestCorrelationId(request: NextRequest): string {
  const supplied = request.headers.get(CORRELATION_ID_HEADER)?.trim();
  return supplied && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(supplied)
    ? supplied
    : createCorrelationId();
}

export function correlationHeaders(
  correlationId: string,
  options: { noStore?: boolean } = {},
): Record<string, string> {
  return {
    [CORRELATION_ID_HEADER]: correlationId,
    ...(options.noStore ? { "Cache-Control": "no-store" } : {}),
  };
}
