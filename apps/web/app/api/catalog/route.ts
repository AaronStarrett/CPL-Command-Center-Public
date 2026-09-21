import { type BeaServerRuntime } from "@bea/database";
import { COMMERCIAL_PRODUCTION_UNCONFIGURED, COMMERCIAL_SYNTHETIC_DISCLOSURE } from "@bea/domain";
import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { requestCorrelationId, requestSession, webRouteLogger } from "@/app/api/route-helpers";
import { apiError, apiException, apiJson } from "@/lib/api-response";
import { permissionForCatalogAction } from "@/lib/commercial-access";
import { canIncludeApiDiagnostics } from "@/lib/diagnostics-authorization";
import { getOperationsServerRuntime, operationsMutationErrorStatus } from "@/lib/operations-api";
import { isSameOriginRequest } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function GET(request: NextRequest) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/catalog", "GET");
  let runtime: BeaServerRuntime | undefined;
  let authenticatedUserId: string | undefined;
  try {
    runtime = await getOperationsServerRuntime();
    const session = await requestSession(request);
    authenticatedUserId = session?.personaId;
    if (!session) {
      return apiError(
        "authentication-required",
        "A valid demo session is required.",
        401,
        correlationId,
      );
    }
    const decision = await runtime.authorization.authorizeUser(
      session.personaId,
      PERMISSIONS.SERVICE_CATALOG_VIEW,
    );
    if (!decision.allowed) {
      return apiError(
        "permission-not-granted",
        "The current role cannot view the service catalog.",
        403,
        correlationId,
      );
    }
    const [catalogs, versions] = await Promise.all([
      runtime.commercial.repository.listCatalogs(),
      runtime.commercial.repository.listCatalogVersions(),
    ]);
    const catalogRepository = runtime.commercial.repository;
    const usage = await Promise.all(
      versions.map(async (version) => ({
        catalogVersionId: version.id,
        proposals: await catalogRepository.listProposalsUsedByCatalog(version.id),
      })),
    );
    return apiJson(
      {
        catalogs,
        versions,
        usage,
        synthetic: true,
        disclosure: COMMERCIAL_SYNTHETIC_DISCLOSURE,
        productionConfigured: false,
        productionLabel: COMMERCIAL_PRODUCTION_UNCONFIGURED,
      },
      correlationId,
    );
  } catch (error) {
    const mapped = operationsMutationErrorStatus(error);
    if (mapped) return apiError(mapped.code, mapped.message, mapped.status, correlationId);
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Catalog list failed",
    );
    const diagnosticsAllowed = await canIncludeApiDiagnostics(runtime, authenticatedUserId);
    return apiException(error, 500, correlationId, diagnosticsAllowed);
  }
}

export async function POST(request: NextRequest) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/catalog", "POST");
  let runtime: BeaServerRuntime | undefined;
  let authenticatedUserId: string | undefined;
  try {
    runtime = await getOperationsServerRuntime();
    const session = await requestSession(request);
    authenticatedUserId = session?.personaId;
    if (!isSameOriginRequest(request, runtime.environment.appBaseUrl)) {
      return apiError(
        "cross-origin-request-rejected",
        "Cross-origin catalog mutation was rejected.",
        403,
        correlationId,
      );
    }
    if (!session) {
      return apiError(
        "authentication-required",
        "A valid demo session is required.",
        401,
        correlationId,
      );
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError("invalid-json", "The request body must be valid JSON.", 400, correlationId);
    }
    if (!body || typeof body !== "object") {
      return apiError(
        "invalid-proposal",
        "Catalog action details are required.",
        400,
        correlationId,
      );
    }
    const input = body as Record<string, unknown>;
    const action = asString(input.action);
    const mapped = permissionForCatalogAction(action);
    if (!mapped) {
      return apiError(
        "unknown-action",
        "The catalog action is not recognized.",
        400,
        correlationId,
      );
    }
    const decision = await runtime.authorization.authorizeUser(
      session.personaId,
      mapped.permission,
    );
    if (!decision.allowed) {
      await runtime.repository.record({
        eventType: "authorization.denied",
        action: mapped.auditAction,
        outcome: "denied",
        actorUserId: session.personaId,
        resourceType: "service_catalog_version",
        correlationId,
        metadata: { permission: mapped.permission, reason: decision.reason },
      });
      return apiError("permission-not-granted", mapped.denyMessage, 403, correlationId);
    }
    const catalogVersionId = asString(input.catalogVersionId);
    if (!catalogVersionId) {
      return apiError("invalid-proposal", "A catalog version id is required.", 400, correlationId);
    }
    const actor = {
      catalogVersionId,
      actorUserId: session.personaId,
      correlationId,
    };
    if (action === "validate") {
      return apiJson(
        { version: await runtime.commercial.validateCatalog(actor), synthetic: true },
        correlationId,
      );
    }
    if (action === "clone") {
      return apiJson(
        { version: await runtime.commercial.cloneCatalogDraft(actor), synthetic: true },
        correlationId,
      );
    }
    if (action === "update-package") {
      if (!input.pack || typeof input.pack !== "object") {
        return apiError("invalid-proposal", "A catalog package is required.", 400, correlationId);
      }
      return apiJson(
        {
          version: await runtime.commercial.updateCatalogDraft({
            ...actor,
            pack: input.pack as never,
          }),
          synthetic: true,
        },
        correlationId,
      );
    }
    if (action === "publish") {
      return apiJson(
        { version: await runtime.commercial.publishCatalog(actor), synthetic: true },
        correlationId,
      );
    }
    if (action === "activate") {
      return apiJson(
        {
          version: await runtime.commercial.activateCatalog({
            ...actor,
            rollback: input.rollback === true,
          }),
          synthetic: true,
        },
        correlationId,
      );
    }
    return apiError("unknown-action", "The catalog action is not recognized.", 400, correlationId);
  } catch (error) {
    const mapped = operationsMutationErrorStatus(error);
    if (mapped) return apiError(mapped.code, mapped.message, mapped.status, correlationId);
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Catalog mutation failed",
    );
    const diagnosticsAllowed = await canIncludeApiDiagnostics(runtime, authenticatedUserId);
    return apiException(error, 500, correlationId, diagnosticsAllowed);
  }
}
