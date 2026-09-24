import { SqlCplExecutionRepository } from "@bea/database/hosted";
import { withHostedRuntime, requireHostedSession, requireHostedMutation } from "@/lib/hosted-auth";
import {
  CommercialInputError,
  commercialTenant,
  commercialJson as json,
  commercialBody as body,
  commercialString as field,
  commercialInteger as integer,
} from "@/lib/cpl-commercial-http";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
const errors = new Set([
  "CPL_INVALID_INPUT",
  "CPL_ACCESS_DENIED",
  "CPL_SESSION_REQUIRED",
  "CPL_AUTHENTICATION_REQUIRED",
  "CPL_ORGANIZATION_ACCESS_DENIED",
  "CPL_CSRF_REJECTED",
  "CPL_RECENT_MFA_REQUIRED",
  "CPL_ORGANIZATION_REQUIRED",
  "CPL_ORGANIZATION_CONTEXT_CHANGED",
  "CPL_MODULE_DISABLED",
  "CPL_RECORD_NOT_FOUND",
  "CPL_IDEMPOTENCY_CONFLICT",
  "CPL_INVALID_IDEMPOTENCY_KEY",
  "CPL_AUTH_RATE_LIMITED",
  "CPL_EXECUTION_VERSION_CONFLICT",
  "CPL_EXECUTION_STATE_CONFLICT",
  "CPL_EXECUTION_VISIT_NOT_READY",
  "CPL_FIELD_VISIT_NOT_READY",
  "CPL_EXECUTION_SCHEDULE_CONFLICT",
  "CPL_EXECUTION_TIME_NONEXISTENT",
  "CPL_EXECUTION_TIME_AMBIGUOUS",
  "CPL_EXECUTION_TIME_OFFSET_INVALID",
  "CPL_EXECUTION_TIME_ZONE_INVALID",
  "CPL_EXECUTION_MEMBER_UNAVAILABLE",
  "CPL_EXECUTION_OPEN_VISITS",
  "CPL_EXECUTION_DIRECTORY_LIMIT",
  "CPL_EXECUTION_VISIT_LIMIT",
]);
function failure(error: unknown) {
  const row = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const code = typeof row.code === "string" ? row.code : "CPL_WORKSPACE_UNAVAILABLE";
  if (!errors.has(code)) return json({ code: "CPL_WORKSPACE_UNAVAILABLE" }, 503);
  const status =
    code === "CPL_AUTH_RATE_LIMITED"
      ? 429
      : code === "CPL_RECORD_NOT_FOUND"
        ? 404
        : ["CPL_SESSION_REQUIRED", "CPL_AUTHENTICATION_REQUIRED"].includes(code)
          ? 401
          : code.includes("CONFLICT") ||
              code.endsWith("NOT_READY") ||
              code.endsWith("_LIMIT") ||
              [
                "CPL_ORGANIZATION_CONTEXT_CHANGED",
                "CPL_EXECUTION_OPEN_VISITS",
                "CPL_EXECUTION_MEMBER_UNAVAILABLE",
              ].includes(code)
            ? 409
            : code.includes("INVALID") || code.includes("TIME_")
              ? 400
              : 403;
  // Return only the same-tenant, public conflict fields; never serialize an Error.
  const conflicts =
    code === "CPL_EXECUTION_SCHEDULE_CONFLICT" && Array.isArray(row.conflicts)
      ? row.conflicts.slice(0, 20).map((value: Record<string, unknown>) => ({
          visitId: value.visitId,
          projectId: value.projectId,
          purpose: value.purpose,
          plannedStartAt: value.plannedStartAt,
          plannedEndAt: value.plannedEndAt,
          timeZone: value.timeZone,
        }))
      : undefined;
  return json({ code, ...(conflicts ? { conflicts } : {}) }, status);
}
function query(request: Request, name: string) {
  const values = new URL(request.url).searchParams.getAll(name);
  if (values.length !== 1 || !values[0]) throw new CommercialInputError();
  return values[0];
}
export async function GET(request: Request, context: Context) {
  try {
    const { path } = await context.params;
    return await withHostedRuntime(
      async (runtime) => {
        const current = await requireHostedSession(runtime, request);
        const tenant = commercialTenant(current, request);
        const repository = new SqlCplExecutionRepository(runtime.tenants);
        if (path.length === 1 && path[0] === "assigned") {
          if (new URL(request.url).search) throw new CommercialInputError();
          return json(await repository.readAssignedWork(tenant));
        }
        if (path.length === 1 && path[0] === "agenda")
          return json(
            await repository.readAgenda({
              ...tenant,
              from: query(request, "from"),
              to: query(request, "to"),
            }),
          );
        if (path.length === 2 && path[0] === "projects")
          return json(await repository.getProjectWorkspace({ ...tenant, projectId: path[1]! }));
        if (path.length === 4 && path[0] === "projects" && path[2] === "visits")
          return json(
            await repository.getVisit({ ...tenant, projectId: path[1]!, visitId: path[3]! }),
          );
        return json({ code: "CPL_RECORD_NOT_FOUND" }, 404);
      },
      { sessionRequest: request },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request, context: Context) {
  try {
    const { path } = await context.params;
    return await withHostedRuntime(
      async (runtime) => {
        const current = await requireHostedMutation(runtime, request);
        const tenant = commercialTenant(current, request);
        const repository = new SqlCplExecutionRepository(runtime.tenants);
        if (path.length === 2 && path[0] === "projects") {
          const input = await body(request, ["expectedRevision", "idempotencyKey", "input"]);
          return json(
            await repository.saveProject({
              ...tenant,
              projectId: path[1]!,
              expectedRevision: integer(input, "expectedRevision", 0),
              idempotencyKey: field(input, "idempotencyKey"),
              input: input.input,
            }),
          );
        }
        if (path.length === 3 && path[0] === "projects" && path[2] === "visits") {
          const input = await body(request, ["idempotencyKey", "input"]);
          return json(
            await repository.createVisit({
              ...tenant,
              projectId: path[1]!,
              idempotencyKey: field(input, "idempotencyKey"),
              input: input.input,
            }),
            201,
          );
        }
        if (path.length === 2 && path[0] === "visits") {
          const input = await body(request, [
            "projectId",
            "expectedRevision",
            "idempotencyKey",
            "input",
          ]);
          return json(
            await repository.saveVisit({
              ...tenant,
              projectId: field(input, "projectId"),
              visitId: path[1]!,
              expectedRevision: integer(input, "expectedRevision"),
              idempotencyKey: field(input, "idempotencyKey"),
              input: input.input,
            }),
          );
        }
        return json({ code: "CPL_RECORD_NOT_FOUND" }, 404);
      },
      { sessionRequest: request },
    );
  } catch (error) {
    return failure(error);
  }
}
