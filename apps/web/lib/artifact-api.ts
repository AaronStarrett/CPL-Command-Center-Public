import "server-only";

import {
  DeterministicDemoMalwareScanner,
  RepositoryArtifactFileStore,
  type ArtifactWebAuditSink,
  type ArtifactWebAuthorization,
  type MalwareScanResult,
  type MalwareScanner,
} from "@bea/artifacts";
import { getServerRuntime, type BeaServerRuntime } from "@bea/database";
import type { NextRequest } from "next/server";

import { requestCorrelationId, requestSession, webRouteLogger } from "@/app/api/route-helpers";
import { apiError } from "@/lib/api-response";
import { createArtifactAuditSink } from "@/lib/artifact-audit";
import {
  effectiveArtifactRetentionMilliseconds,
  effectiveArtifactUploadBytes,
  effectiveArtifactUploadRateLimit,
} from "@/lib/artifact-settings";
import { artifactRoutePolicy, type ArtifactRouteAction } from "@/lib/artifact-route-contract";
import { isSameOriginRequest, isStrictSameOriginMutation } from "@/lib/request-security";

class UnavailableArtifactMalwareScanner implements MalwareScanner {
  async scan(): Promise<MalwareScanResult> {
    return {
      engine: "bea-malware-scanner-unconfigured",
      mode: "connected",
      status: "unavailable",
    };
  }
}

export type ArtifactApiContext =
  | {
      readonly allowSimulatedClean: boolean;
      readonly audit: ArtifactWebAuditSink;
      readonly authorization: ArtifactWebAuthorization;
      readonly correlationId: string;
      readonly maxUploadBytes: number;
      readonly ok: true;
      readonly runtime: BeaServerRuntime;
      readonly scanner: MalwareScanner;
      readonly store: RepositoryArtifactFileStore;
    }
  | { readonly ok: false; readonly response: Response };

function nonEnumeratingArtifactResponse(correlationId: string): Response {
  return apiError("artifact-not-found", "Artifact was not found.", 404, correlationId);
}

export async function requireArtifactApiContext(
  request: NextRequest,
  options: {
    readonly action: ArtifactRouteAction;
    readonly nonEnumerating?: boolean;
    readonly route: string;
  },
): Promise<ArtifactApiContext> {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, options.route, request.method);
  const runtime = await getServerRuntime();
  const session = await requestSession(request);
  const policy = artifactRoutePolicy(options.action);
  const originAllowed = policy.mutation
    ? isStrictSameOriginMutation(request, runtime.environment.appBaseUrl)
    : isSameOriginRequest(request, runtime.environment.appBaseUrl);
  if (!originAllowed) {
    await runtime.repository.record({
      eventType: "authorization.denied",
      action: `artifact.${options.action}`,
      outcome: "denied",
      actorUserId: session?.personaId ?? null,
      resourceType: "artifact",
      correlationId,
      metadata: { reason: "cross-origin-request" },
    });
    logger.warn({}, "Cross-origin artifact request rejected");
    return {
      ok: false,
      response: apiError(
        "cross-origin-request-rejected",
        "Cross-origin artifact access was rejected.",
        403,
        correlationId,
      ),
    };
  }
  if (!session) {
    await runtime.repository.record({
      eventType: "authentication.required",
      action: `artifact.${options.action}`,
      outcome: "denied",
      resourceType: "artifact",
      correlationId,
      metadata: { reason: "missing-or-invalid-session" },
    });
    return {
      ok: false,
      response: apiError(
        "authentication-required",
        "A valid demo session is required.",
        401,
        correlationId,
      ),
    };
  }
  for (const permission of policy.rbacPermissions) {
    const decision = await runtime.authorization.authorizeUser(session.personaId, permission);
    if (decision.allowed) continue;
    await runtime.repository.record({
      eventType: "authorization.denied",
      action: `artifact.${options.action}`,
      outcome: "denied",
      actorUserId: session.personaId,
      resourceType: "artifact",
      correlationId,
      metadata: { permission, reason: decision.reason },
    });
    return {
      ok: false,
      response:
        options.nonEnumerating === true
          ? nonEnumeratingArtifactResponse(correlationId)
          : apiError(
              "permission-not-granted",
              "The current role cannot upload artifacts.",
              403,
              correlationId,
            ),
    };
  }
  const settings =
    options.action === "upload" ? await runtime.ai.persistence.getProviderSettings() : null;
  const maxUploadBytes = effectiveArtifactUploadBytes(
    settings?.maxUploadBytes ?? Number.POSITIVE_INFINITY,
  );
  const retentionMilliseconds =
    settings === null
      ? undefined
      : effectiveArtifactRetentionMilliseconds(settings.artifactRetentionDays);
  if (options.action === "upload") {
    const rateLimit = await runtime.ai.persistence.consumeRateLimit({
      subjectKey: `user:${session.personaId}`,
      routeKey: "artifact.upload",
      limit: effectiveArtifactUploadRateLimit(settings?.perUserRequestsPerMinute ?? 1),
      windowSeconds: 60,
    });
    if (!rateLimit.allowed) {
      await runtime.repository.record({
        eventType: "rate-limit.denied",
        action: "artifact.upload",
        outcome: "denied",
        actorUserId: session.personaId,
        resourceType: "artifact",
        correlationId,
        metadata: { limit: rateLimit.limit, resetAt: rateLimit.resetAt },
      });
      const response = apiError(
        "rate-limit-exceeded",
        "Artifact upload is temporarily rate limited.",
        429,
        correlationId,
      );
      response.headers.set(
        "Retry-After",
        String(Math.max(1, Math.ceil((Date.parse(rateLimit.resetAt) - Date.now()) / 1_000))),
      );
      return { ok: false, response };
    }
  }
  const audit = createArtifactAuditSink(runtime.repository);
  return {
    allowSimulatedClean: runtime.environment.appMode === "demo",
    audit,
    authorization: {
      actorId: session.personaId,
      correlationId,
      ownerId: session.personaId,
      permissions: policy.artifactPermissions,
    },
    correlationId,
    maxUploadBytes,
    ok: true,
    runtime,
    scanner:
      runtime.environment.appMode === "demo"
        ? new DeterministicDemoMalwareScanner()
        : new UnavailableArtifactMalwareScanner(),
    store: new RepositoryArtifactFileStore({
      repositoryRoot: runtime.repositoryRoot,
      ...(retentionMilliseconds === undefined ? {} : { retentionMilliseconds }),
    }),
  };
}
