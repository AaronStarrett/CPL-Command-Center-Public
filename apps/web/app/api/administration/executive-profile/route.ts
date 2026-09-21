import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { apiError, apiException, apiJson } from "@/lib/api-response";
import { requireAiApiContext } from "@/lib/ai-command-api";
import {
  readExecutiveProfileAdministration,
  updateExecutiveProfileAdministration,
} from "@/lib/executive-profile-administration";
import { validateBoundedJsonMutation } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const context = await requireAiApiContext(request, {
    route: "/api/administration/executive-profile",
    action: "executive-profile.read",
    permission: PERMISSIONS.EXECUTIVE_PROFILE_VIEW,
  });
  if (!context.ok) return context.response;
  try {
    return apiJson(
      await readExecutiveProfileAdministration(context.runtime),
      context.correlationId,
    );
  } catch (error) {
    return apiException(error, 500, context.correlationId, false);
  }
}

export async function PATCH(request: NextRequest) {
  const context = await requireAiApiContext(request, {
    route: "/api/administration/executive-profile",
    action: "executive-profile.update",
    permission: PERMISSIONS.EXECUTIVE_PROFILE_MANAGE,
    strictMutation: true,
    rateLimit: { key: "executive-profile.update", limit: 12, windowSeconds: 60 },
  });
  if (!context.ok) return context.response;
  const transport = validateBoundedJsonMutation(request);
  if (!transport.ok) {
    return apiError(transport.code, transport.message, transport.status, context.correlationId);
  }
  try {
    return apiJson(
      await updateExecutiveProfileAdministration({
        runtime: context.runtime,
        actorUserId: context.userId,
        correlationId: context.correlationId,
        value: await request.json(),
      }),
      context.correlationId,
    );
  } catch (error) {
    return apiException(error, 400, context.correlationId, false);
  }
}
