import { NextRequest } from "next/server";

import { apiError, apiJson } from "@/lib/api-response";
import {
  digitalWorkforceContext,
  digitalWorkforceFailure,
  PERMISSIONS,
} from "@/lib/digital-workforce-api";
import { cancelDigitalWorkforceRun } from "@/lib/digital-workforce-runtime";
import { validateBoundedJsonMutation } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const context = await digitalWorkforceContext(request, {
    route: "/api/digital-workforce/runs/[id]/cancel",
    permission: PERMISSIONS.DIGITAL_WORKFORCE_CANCEL,
    mutation: true,
    action: "digital-workforce.run.cancel",
  });
  if (!context.ok) return context.response;
  const transport = validateBoundedJsonMutation(request, 2_048);
  if (!transport.ok) {
    return apiError(transport.code, transport.message, transport.status, context.correlationId);
  }
  try {
    const { id } = await params;
    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const reason =
      body && typeof body === "object" && typeof (body as { reason?: unknown }).reason === "string"
        ? (body as { reason: string }).reason
        : "Owner stopped the run.";
    await cancelDigitalWorkforceRun({
      runtime: context.runtime,
      userId: context.session.personaId,
      runId: id,
      reason,
      correlationId: context.correlationId,
    });
    const run = await context.runtime.digitalWorkforce.getRun(id);
    return apiJson({ run }, context.correlationId);
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
