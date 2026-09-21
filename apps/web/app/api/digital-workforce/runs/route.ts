import { NextRequest } from "next/server";

import { apiError, apiJson } from "@/lib/api-response";
import {
  digitalWorkforceContext,
  digitalWorkforceFailure,
  PERMISSIONS,
} from "@/lib/digital-workforce-api";
import { startDigitalWorkforceRun } from "@/lib/digital-workforce-runtime";
import { validateBoundedJsonMutation } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const context = await digitalWorkforceContext(request, {
    route: "/api/digital-workforce/runs",
    permission: PERMISSIONS.DIGITAL_WORKFORCE_VIEW,
    mutation: false,
    action: "digital-workforce.runs.read",
  });
  if (!context.ok) return context.response;
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get("status") ?? undefined;
    const runs = await context.runtime.digitalWorkforce.listRuns({
      limit: 50,
      ...(status ? { status: status as never } : {}),
    });
    return apiJson({ runs }, context.correlationId);
  } catch (error) {
    return digitalWorkforceFailure(
      error,
      context.runtime,
      context.session.personaId,
      context.correlationId,
      context.logger,
    );
  }
}

export async function POST(request: NextRequest) {
  const context = await digitalWorkforceContext(request, {
    route: "/api/digital-workforce/runs",
    permission: PERMISSIONS.DIGITAL_WORKFORCE_RUN,
    mutation: true,
    action: "digital-workforce.run.create",
  });
  if (!context.ok) return context.response;
  const transport = validateBoundedJsonMutation(request, 8_192);
  if (!transport.ok) {
    return apiError(transport.code, transport.message, transport.status, context.correlationId);
  }
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(
        "invalid-json",
        "The request body must be valid JSON.",
        400,
        context.correlationId,
      );
    }
    const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const started = await startDigitalWorkforceRun({
      runtime: context.runtime,
      userId: context.session.personaId,
      roleIds: context.session.roleIds,
      goal: typeof input.goal === "string" ? input.goal : "",
      rootAgentId: typeof input.rootAgentId === "string" ? input.rootAgentId : null,
      idempotencyKey:
        typeof input.idempotencyKey === "string" ? input.idempotencyKey : crypto.randomUUID(),
      conversationId: typeof input.conversationId === "string" ? input.conversationId : null,
      initiatingMessageId:
        typeof input.initiatingMessageId === "string" ? input.initiatingMessageId : null,
      correlationId: context.correlationId,
    });
    return apiJson(started, context.correlationId, { status: 201 });
  } catch (error) {
    return digitalWorkforceFailure(
      error,
      context.runtime,
      context.session.personaId,
      context.correlationId,
      context.logger,
    );
  }
}
