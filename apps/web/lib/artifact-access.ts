import type { ArtifactWebAuthorization } from "@bea/artifacts";
import type { BeaServerRuntime } from "@bea/database";
import type { GeneratedArtifactRecord } from "@bea/domain";
import { PERMISSIONS, type Permission } from "@bea/security";

import { apiError } from "./api-response.js";
import type { ArtifactRouteAction } from "./artifact-route-contract.js";

const knownArtifactPermissions = new Set<string>(Object.values(PERMISSIONS));

export interface PersistedArtifactAccessContext {
  readonly authorization: Pick<ArtifactWebAuthorization, "actorId" | "ownerId">;
  readonly correlationId: string;
  readonly runtime: Pick<BeaServerRuntime, "ai" | "authorization" | "repository">;
}

function nonEnumeratingArtifactResponse(correlationId: string): Response {
  return apiError("artifact-not-found", "Artifact was not found.", 404, correlationId);
}

export async function requirePersistedArtifactAccess(
  context: PersistedArtifactAccessContext,
  artifactId: string,
  action: Exclude<ArtifactRouteAction, "upload">,
): Promise<Response | null> {
  let persisted: GeneratedArtifactRecord | null;
  try {
    persisted = await context.runtime.ai.persistence.getGeneratedArtifactByStorageReference(
      artifactId,
      context.authorization.ownerId,
    );
  } catch {
    return apiError(
      "artifact-authorization-unavailable",
      "Artifact access is temporarily unavailable.",
      503,
      context.correlationId,
    );
  }

  const requiredPermissions = persisted?.requiredPermissions ?? [];
  const validPermissions =
    persisted?.status === "ready" &&
    persisted.storageReference === artifactId &&
    requiredPermissions.length > 0 &&
    requiredPermissions.length <= 32 &&
    new Set(requiredPermissions).size === requiredPermissions.length &&
    requiredPermissions.every(
      (permission): permission is Permission =>
        typeof permission === "string" && knownArtifactPermissions.has(permission),
    );
  let denial: { readonly permission?: string; readonly reason: string } | undefined;
  if (!validPermissions) {
    denial = { reason: persisted === null ? "artifact-unassociated" : "invalid-persisted-access" };
  } else {
    try {
      for (const permission of requiredPermissions) {
        const decision = await context.runtime.authorization.authorizeUser(
          context.authorization.actorId,
          permission as Permission,
        );
        if (!decision.allowed) {
          denial = { permission, reason: decision.reason };
          break;
        }
      }
    } catch {
      return apiError(
        "artifact-authorization-unavailable",
        "Artifact access is temporarily unavailable.",
        503,
        context.correlationId,
      );
    }
  }
  if (denial === undefined) return null;

  try {
    await context.runtime.repository.record({
      eventType: "authorization.denied",
      action: `artifact.${action}`,
      outcome: "denied",
      actorUserId: context.authorization.actorId,
      resourceType: "artifact",
      resourceId: null,
      correlationId: context.correlationId,
      metadata: {
        artifactFileId: artifactId,
        ownerScoped: true,
        ...(denial.permission === undefined ? {} : { permission: denial.permission }),
        reason: denial.reason,
      },
    });
  } catch {
    return apiError(
      "artifact-audit-unavailable",
      "Artifact access is temporarily unavailable.",
      503,
      context.correlationId,
    );
  }
  return nonEnumeratingArtifactResponse(context.correlationId);
}
