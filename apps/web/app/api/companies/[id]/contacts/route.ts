import { getServerRuntime, type BeaServerRuntime } from "@bea/database";
import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { requestCorrelationId, requestSession, webRouteLogger } from "@/app/api/route-helpers";
import { apiError, apiException, apiJson } from "@/lib/api-response";
import { getPermissionAwareCompanyContacts } from "@/lib/company-contacts";
import { canIncludeApiDiagnostics } from "@/lib/diagnostics-authorization";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/companies/[id]/contacts", "GET");
  let runtime: BeaServerRuntime | undefined;
  let authenticatedUserId: string | undefined;
  try {
    runtime = await getServerRuntime();
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
    const { id } = await context.params;
    const result = await getPermissionAwareCompanyContacts(runtime, session.personaId, id);
    if (!result.ok && result.status === 403) {
      await runtime.repository.record({
        eventType: "authorization.denied",
        action: "company.contacts.list",
        outcome: "denied",
        actorUserId: session.personaId,
        resourceType: "company",
        correlationId,
        metadata: {
          permissions: [PERMISSIONS.COMPANIES_VIEW, PERMISSIONS.CONTACTS_VIEW],
          reason: result.reason,
        },
      });
      return apiError(result.code, result.message, result.status, correlationId);
    }
    if (!result.ok) {
      return apiError(result.code, result.message, result.status, correlationId);
    }
    return apiJson({ companyId: result.companyId, contacts: result.contacts }, correlationId);
  } catch (error) {
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Company contacts could not be listed",
    );
    const diagnosticsAllowed = await canIncludeApiDiagnostics(runtime, authenticatedUserId);
    return apiException(error, 500, correlationId, diagnosticsAllowed);
  }
}
