import { NextRequest } from "next/server";

import { apiError, apiJson } from "@/lib/api-response";
import {
  digitalWorkforceContext,
  digitalWorkforceFailure,
  PERMISSIONS,
} from "@/lib/digital-workforce-api";
import { validateBoundedJsonMutation } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const context = await digitalWorkforceContext(request, {
    route: "/api/digital-workforce/teams",
    permission: PERMISSIONS.DIGITAL_WORKFORCE_VIEW,
    mutation: false,
    action: "digital-workforce.teams.read",
  });
  if (!context.ok) return context.response;
  try {
    const url = new URL(request.url);
    const departmentId = url.searchParams.get("departmentId") ?? undefined;
    const teams = await context.runtime.digitalWorkforce.listTeams(departmentId);
    return apiJson({ teams }, context.correlationId);
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
    route: "/api/digital-workforce/teams",
    permission: PERMISSIONS.DIGITAL_WORKFORCE_MANAGE,
    mutation: true,
    action: "digital-workforce.teams.write",
  });
  if (!context.ok) return context.response;
  const transport = validateBoundedJsonMutation(request, 4_096);
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
    const team = await context.runtime.digitalWorkforce.upsertTeam({
      ...(typeof input.id === "string" ? { id: input.id } : {}),
      departmentId: typeof input.departmentId === "string" ? input.departmentId : "",
      name: typeof input.name === "string" ? input.name : "",
      slug: typeof input.slug === "string" ? input.slug : "",
      description:
        typeof input.description === "string" ? input.description : "Digital Agent team.",
      status:
        input.status === "paused" || input.status === "archived" || input.status === "active"
          ? input.status
          : "active",
      teamLeadAgentId: typeof input.teamLeadAgentId === "string" ? input.teamLeadAgentId : null,
      displayOrder: typeof input.displayOrder === "number" ? input.displayOrder : 0,
      createdByUserId: context.session.personaId,
    });
    return apiJson({ team }, context.correlationId, { status: 201 });
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
