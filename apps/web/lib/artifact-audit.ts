import type { ArtifactWebAuditEvent, ArtifactWebAuditSink } from "@bea/artifacts";
import type { AuditEventInput } from "@bea/domain";

export interface ArtifactAuditRepository {
  record(event: AuditEventInput): Promise<unknown>;
}

function domainAuditOutcome(
  outcome: ArtifactWebAuditEvent["outcome"],
): "allowed" | "denied" | "failed" {
  return outcome === "unavailable" ? "failed" : outcome;
}

export function createArtifactAuditSink(repository: ArtifactAuditRepository): ArtifactWebAuditSink {
  return {
    async record(event) {
      await repository.record({
        eventType: event.outcome === "denied" ? "authorization.denied" : "artifact.access",
        action: `artifact.${event.action}`,
        outcome: domainAuditOutcome(event.outcome),
        actorUserId: event.actorId,
        resourceType: "artifact",
        resourceId: null,
        correlationId: event.correlationId,
        metadata: {
          artifactOutcome: event.outcome,
          ...(event.artifactId === undefined ? {} : { artifactFileId: event.artifactId }),
          ownerScoped: event.actorId === event.ownerId,
        },
      });
    },
  };
}
