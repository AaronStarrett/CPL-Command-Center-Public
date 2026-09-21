import { NextRequest } from "next/server";

import { apiError, apiJson } from "@/lib/api-response";
import {
  digitalWorkforceContext,
  digitalWorkforceFailure,
  PERMISSIONS,
} from "@/lib/digital-workforce-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const context = await digitalWorkforceContext(request, {
    route: "/api/digital-workforce/runs/[id]",
    permission: PERMISSIONS.DIGITAL_WORKFORCE_VIEW,
    mutation: false,
    action: "digital-workforce.run.read",
  });
  if (!context.ok) return context.response;
  try {
    const { id } = await params;
    const run = await context.runtime.digitalWorkforce.getRun(id);
    if (!run) {
      return apiError(
        "not-found",
        "Digital Workforce run was not found.",
        404,
        context.correlationId,
      );
    }
    const [steps, handoffs, events] = await Promise.all([
      context.runtime.digitalWorkforce.listSteps(id),
      context.runtime.digitalWorkforce.listHandoffs(id),
      context.runtime.digitalWorkforce.listEvents(id, 200),
    ]);
    return apiJson({ run, steps, handoffs, events }, context.correlationId);
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
