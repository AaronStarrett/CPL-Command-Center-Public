import { withHostedRuntime, requireHostedSession, requireHostedMutation } from "@/lib/hosted-auth";
import { SqlCplWorkflowRepository } from "@bea/database/hosted";

export const dynamic = "force-dynamic";
const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Vary: "Cookie",
  "X-Content-Type-Options": "nosniff",
};
type Context = { params: Promise<{ path: string[] }> };
function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: privateHeaders });
}
class InputError extends Error {
  readonly code = "CPL_INVALID_INPUT";
}
class OrganizationContextError extends Error {
  constructor(readonly code = "CPL_ORGANIZATION_CONTEXT_CHANGED") {
    super(code);
  }
}
/** The displayed organization is only a stale-view precondition. All tenant
 * identity and authorization still come from this single server session snapshot. */
function selectedTenant(
  current: Awaited<ReturnType<typeof requireHostedSession>>,
  request: Request,
  expectedContext: boolean,
  download = false,
) {
  const organizationId = current.session.selectedOrganizationId;
  if (!organizationId) throw new OrganizationContextError("CPL_ORGANIZATION_REQUIRED");
  if (expectedContext) {
    const header = request.headers.get("x-cpl-organization");
    const query = download ? new URL(request.url).searchParams.getAll("organization") : [];
    if (query.length > 1 || (header && query.length && header !== query[0]))
      throw new OrganizationContextError();
    const expected = header ?? query[0];
    if (expected !== organizationId) throw new OrganizationContextError();
  }
  return { sessionToken: current.sessionToken, organizationId };
}
async function body(request: Request, keys: readonly string[]): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|\s*$)/iu.test(request.headers.get("content-type") ?? ""))
    throw new InputError();
  const reader = request.body?.getReader();
  if (!reader) throw new InputError();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) {
        await reader.cancel();
        throw new InputError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new InputError();
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).some((key) => !keys.includes(key))
  )
    throw new InputError();
  return parsed as Record<string, unknown>;
}
function field(input: Record<string, unknown>, key: string, optional = false) {
  const value = input[key];
  if (optional && (value === null || value === undefined)) return "";
  if (typeof value !== "string") throw new InputError();
  return value;
}
function failure(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "CPL_WORKSPACE_UNAVAILABLE";
  const publicCodes = new Set([
    "CPL_INVALID_INPUT",
    "CPL_ACCESS_DENIED",
    "CPL_SESSION_REQUIRED",
    "CPL_AUTHENTICATION_REQUIRED",
    "CPL_ORGANIZATION_ACCESS_DENIED",
    "CPL_CSRF_REJECTED",
    "CPL_RECENT_MFA_REQUIRED",
    "CPL_PLATFORM_MFA_REQUIRED",
    "CPL_PLATFORM_ADMIN_REQUIRED",
    "CPL_ORGANIZATION_REQUIRED",
    "CPL_ORGANIZATION_CONTEXT_CHANGED",
    "CPL_MODULE_DISABLED",
    "CPL_VERSION_CONFLICT",
    "CPL_PROPOSAL_VERSION_CONFLICT",
    "CPL_PROPOSAL_NOT_READY",
    "CPL_RECORD_NOT_FOUND",
    "CPL_HOSTED_AUTH_NOT_CONFIGURED",
    "CPL_AUTH_RATE_LIMITED",
    "CPL_IDEMPOTENCY_CONFLICT",
    "CPL_INVALID_ORGANIZATION_SLUG",
    "CPL_INVALID_IDEMPOTENCY_KEY",
    "CPL_HOSTED_NOT_CONFIGURED",
  ]);
  if (!publicCodes.has(code)) return json({ code: "CPL_WORKSPACE_UNAVAILABLE" }, 503);
  const status = code.includes("NOT_CONFIGURED")
    ? 503
    : code === "CPL_AUTH_RATE_LIMITED"
      ? 429
      : code === "CPL_RECORD_NOT_FOUND"
        ? 404
        : code === "CPL_SESSION_REQUIRED" || code === "CPL_AUTHENTICATION_REQUIRED"
          ? 401
          : code.includes("CONFLICT") ||
              code === "CPL_PROPOSAL_NOT_READY" ||
              code === "CPL_ORGANIZATION_CONTEXT_CHANGED"
            ? 409
            : code.includes("INVALID")
              ? 400
              : 403;
  return json({ code }, status);
}

export async function GET(request: Request, context: Context) {
  try {
    const { path } = await context.params;
    return await withHostedRuntime(async (runtime) => {
      const current = await requireHostedSession(runtime, request);
      const repository = new SqlCplWorkflowRepository(runtime.database, runtime.tenants);
      if (path.length === 1 && path[0] === "workspace") {
        const organizations = await runtime.tenants.listOrganizations(current.sessionToken);
        const organizationId = current.session.selectedOrganizationId;
        if (!organizationId)
          return json({
            organizations,
            currentOrganizationId: null,
            leads: [],
            proposals: [],
            jobs: [],
          });
        const tenant = selectedTenant(current, request, false);
        await runtime.tenants.authorize({ ...tenant, permission: "records:read" });
        const leads = await repository.listLeads(tenant);
        const proposals = await repository.listProposalDrafts(tenant);
        const jobs = await repository.listJobs(tenant);
        return json({
          organizations,
          currentOrganizationId: organizationId,
          leads,
          proposals,
          jobs,
        });
      }
      const tenant = selectedTenant(
        current,
        request,
        true,
        path[0] === "proposals" && path.length === 3 && path[2] === "download",
      );
      await runtime.tenants.authorize({ ...tenant, permission: "records:read" });
      if (path[0] === "leads" && path.length === 1) return json(await repository.listLeads(tenant));
      if (path[0] === "leads" && path.length === 2)
        return json(await repository.getLead({ ...tenant, leadId: path[1]! }));
      if (path[0] === "proposals" && path.length === 1)
        return json(await repository.listProposalDrafts(tenant));
      if (path[0] === "proposals" && path.length === 2)
        return json(await repository.getProposalDraft({ ...tenant, proposalId: path[1]! }));
      if (path[0] === "proposals" && path.length === 3 && path[2] === "download") {
        const file = await repository.downloadProposal({ ...tenant, proposalId: path[1]! });
        return new Response(file.content, {
          headers: {
            ...privateHeaders,
            "Content-Type": file.contentType,
            "Content-Disposition": `attachment; filename="${file.fileName.replace(/[^a-zA-Z0-9._-]/gu, "_")}"`,
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "X-Artifact-SHA256": file.sha256,
          },
        });
      }
      if (path[0] === "jobs" && path.length === 1) return json(await repository.listJobs(tenant));
      return json({ code: "CPL_RECORD_NOT_FOUND" }, 404);
    });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request, context: Context) {
  try {
    const { path } = await context.params;
    return await withHostedRuntime(async (runtime) => {
      const current = await requireHostedMutation(runtime, request);
      if (path[0] === "organizations" && path.length === 1) {
        const input = await body(request, ["slug", "displayName"]);
        const organization = await runtime.tenants.createEnabledOrganization(current.sessionToken, {
          slug: field(input, "slug"),
          displayName: field(input, "displayName"),
        });
        await runtime.auth.selectOrganization(current.sessionToken, organization.id);
        return json(organization, 201);
      }
      if (path[0] === "organizations" && path[1] === "select" && path.length === 2) {
        const input = await body(request, ["organizationId"]);
        await runtime.auth.selectOrganization(current.sessionToken, field(input, "organizationId"));
        return json({ ok: true });
      }
      const tenant = selectedTenant(current, request, true);
      await runtime.tenants.authorize({ ...tenant, permission: "records:write" });
      const repository = new SqlCplWorkflowRepository(runtime.database, runtime.tenants);
      if (path[0] === "leads" && path.length === 1) {
        const input = await body(request, [
          "title",
          "contactName",
          "contactEmail",
          "details",
          "idempotencyKey",
        ]);
        return json(
          await repository.createLead({
            ...tenant,
            title: field(input, "title"),
            contactName: field(input, "contactName"),
            contactEmail: field(input, "contactEmail", true) || undefined,
            details: field(input, "details", true),
            idempotencyKey: field(input, "idempotencyKey"),
          }),
          201,
        );
      }
      if (path[0] === "proposals" && path.length === 1) {
        const input = await body(request, ["leadId", "title", "content", "idempotencyKey"]);
        return json(
          await repository.createProposalDraft({
            ...tenant,
            leadId: field(input, "leadId"),
            title: field(input, "title"),
            content: field(input, "content"),
            idempotencyKey: field(input, "idempotencyKey"),
          }),
          201,
        );
      }
      if (path[0] === "proposals" && path.length === 2) {
        const input = await body(request, ["title", "content", "expectedVersion"]);
        if (!Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion) < 1)
          throw new InputError();
        return json(
          await repository.updateProposalDraft({
            ...tenant,
            proposalId: path[1]!,
            title: field(input, "title"),
            content: field(input, "content"),
            expectedVersion: Number(input.expectedVersion),
          }),
        );
      }
      return json({ code: "CPL_RECORD_NOT_FOUND" }, 404);
    });
  } catch (error) {
    return failure(error);
  }
}
