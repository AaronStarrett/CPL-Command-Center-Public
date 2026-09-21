import { toErrorResponse } from "@bea/observability";
import { NextResponse } from "next/server";

function responseHeaders(correlationId: string, noStore: boolean): Record<string, string> {
  return {
    "X-Correlation-ID": correlationId,
    ...(noStore ? { "Cache-Control": "no-store" } : {}),
  };
}

export function apiError(code: string, message: string, status: number, correlationId: string) {
  return NextResponse.json(
    { error: { code, message, correlationId } },
    { status, headers: responseHeaders(correlationId, true) },
  );
}

export function apiJson<T>(
  body: T,
  correlationId: string,
  options: { status?: number; noStore?: boolean } = {},
) {
  return NextResponse.json(body, {
    status: options.status ?? 200,
    headers: responseHeaders(correlationId, options.noStore ?? true),
  });
}

export function apiException(
  error: unknown,
  status: number,
  correlationId: string,
  includeDiagnostics: boolean,
) {
  return NextResponse.json(toErrorResponse({ error, correlationId, includeDiagnostics }), {
    status,
    headers: responseHeaders(correlationId, true),
  });
}
