import { createArtifactRefreshResponse } from "@bea/artifacts";
import { NextRequest } from "next/server";

import { requirePersistedArtifactAccess } from "@/lib/artifact-access";
import { requireArtifactApiContext } from "@/lib/artifact-api";
import { finalizeArtifactRouteResponse } from "@/lib/artifact-route-contract";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  routeContext: { readonly params: Promise<{ readonly id: string }> },
) {
  const context = await requireArtifactApiContext(request, {
    action: "refresh",
    nonEnumerating: true,
    route: "/api/artifacts/[id]",
  });
  if (!context.ok) return context.response;
  const { id } = await routeContext.params;
  const accessDenial = await requirePersistedArtifactAccess(context, id, "refresh");
  if (accessDenial !== null) {
    return finalizeArtifactRouteResponse(accessDenial, context.correlationId);
  }
  const response = await createArtifactRefreshResponse(context.store, {
    artifactId: id,
    audit: context.audit,
    authorization: context.authorization,
  });
  return finalizeArtifactRouteResponse(response, context.correlationId);
}
