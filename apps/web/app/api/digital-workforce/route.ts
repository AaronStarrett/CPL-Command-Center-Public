import { NextRequest } from "next/server";

import { apiJson } from "@/lib/api-response";
import { audienceRoles } from "@/lib/digital-workforce-runtime";
import {
  digitalWorkforceContext,
  digitalWorkforceFailure,
  PERMISSIONS,
} from "@/lib/digital-workforce-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const context = await digitalWorkforceContext(request, {
    route: "/api/digital-workforce",
    permission: PERMISSIONS.DIGITAL_WORKFORCE_VIEW,
    mutation: false,
    action: "digital-workforce.organization.read",
  });
  if (!context.ok) return context.response;
  try {
    const [organization, departments, teams, runs] = await Promise.all([
      context.runtime.digitalWorkforce.listOrganization({
        ...(audienceRoles(context.session.roleIds)
          ? { availableToRoleIds: audienceRoles(context.session.roleIds) }
          : {}),
      }),
      context.runtime.digitalWorkforce.listDepartments(),
      context.runtime.digitalWorkforce.listTeams(),
      context.runtime.digitalWorkforce.listRuns({ limit: 50 }),
    ]);
    return apiJson({ organization, departments, teams, runs }, context.correlationId);
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
