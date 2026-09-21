import type { ArtifactWebPermission } from "@bea/artifacts";
import { PERMISSIONS, type Permission } from "@bea/security";

export type ArtifactRouteAction = "download" | "preview" | "refresh" | "upload";

export interface ArtifactRoutePolicy {
  readonly artifactPermissions: readonly ArtifactWebPermission[];
  readonly mutation: boolean;
  readonly rbacPermissions: readonly Permission[];
}

const policies: Readonly<Record<ArtifactRouteAction, ArtifactRoutePolicy>> = {
  download: {
    artifactPermissions: ["artifacts:download"],
    mutation: false,
    rbacPermissions: [PERMISSIONS.DOCUMENTS_VIEW],
  },
  preview: {
    artifactPermissions: ["artifacts:read"],
    mutation: false,
    rbacPermissions: [PERMISSIONS.DOCUMENTS_VIEW],
  },
  refresh: {
    artifactPermissions: ["artifacts:read"],
    mutation: false,
    rbacPermissions: [PERMISSIONS.DOCUMENTS_VIEW],
  },
  upload: {
    artifactPermissions: ["artifacts:write"],
    mutation: true,
    rbacPermissions: [PERMISSIONS.DOCUMENTS_VIEW, PERMISSIONS.AI_COMMAND_RUN],
  },
};

export function artifactRoutePolicy(action: ArtifactRouteAction): ArtifactRoutePolicy {
  return policies[action];
}

export function finalizeArtifactRouteResponse(response: Response, correlationId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store, max-age=0");
  headers.set("pragma", "no-cache");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-correlation-id", correlationId);
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}
