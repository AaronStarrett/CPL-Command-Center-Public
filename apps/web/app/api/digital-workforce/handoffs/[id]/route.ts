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
    route: "/api/digital-workforce/handoffs/[id]",
    permission: PERMISSIONS.DIGITAL_WORKFORCE_VIEW,
    mutation: false,
    action: "digital-workforce.handoff.read",
  });
  if (!context.ok) return context.response;
  try {
    const { id } = await params;
    const handoff = await context.runtime.digitalWorkforce.getHandoff(id);
    if (!handoff) {
      return apiError("not-found", "Handoff was not found.", 404, context.correlationId);
    }
    return apiJson({ handoff }, context.correlationId);
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
