import { SqlCplCompanyRepository, SqlCplDeliveryRepository } from "@bea/database/hosted";
import type {
  CplDirectoryKind,
  CplCompanyStatus,
  CplCompanyTemplateKind,
} from "@bea/domain/cpl-company";
import { withHostedRuntime, requireHostedSession, requireHostedMutation } from "@/lib/hosted-auth";
import {
  CommercialInputError,
  commercialTenant,
  commercialJson as json,
  commercialBody as body,
  commercialString as text,
  commercialInteger as integer,
} from "@/lib/cpl-commercial-http";
import { administrationFailure, administrationQuery } from "@/lib/cpl-administration-http";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
function kind(value: string | undefined): CplDirectoryKind {
  if (!["customer", "contact", "site"].includes(value ?? "")) throw new CommercialInputError();
  return value as CplDirectoryKind;
}
function list(request: Request, allowed = ["q", "status", "cursor", "limit", "customerId"]) {
  const input = administrationQuery(request, allowed);
  if (input.limit !== undefined && !/^(?:[1-9][0-9]?|100)$/u.test(input.limit))
    throw new CommercialInputError();
  if (input.status !== undefined && !["all", "active", "archived"].includes(input.status))
    throw new CommercialInputError();
  return {
    ...input,
    ...(input.limit === undefined ? {} : { limit: Number(input.limit) }),
    ...(input.status === undefined ? {} : { status: input.status as CplCompanyStatus | "all" }),
  };
}
export async function GET(request: Request, context: Context) {
  try {
    const { path } = await context.params;
    return await withHostedRuntime(
      async (runtime) => {
        const current = await requireHostedSession(runtime, request),
          tenant = commercialTenant(current, request),
          repo = new SqlCplCompanyRepository(runtime.tenants);
        if (path.length === 1 && path[0] === "workspace") {
          administrationQuery(request, []);
          return json(await repo.readWorkspace(tenant));
        }
        if (path.length === 1 && path[0] === "configuration") {
          administrationQuery(request, []);
          return json(await repo.readConfiguration(tenant));
        }
        if (path.length === 1 && path[0] === "intake-policy") {
          administrationQuery(request, []);
          return json(await repo.getIntakePolicy(tenant));
        }
        if (path.length === 2 && path[0] === "templates") {
          if (!["proposal", "field", "report"].includes(path[1]!)) throw new CommercialInputError();
          return json(
            await repo.listTemplates({
              ...tenant,
              ...list(request, ["q", "cursor", "limit"]),
              kind: path[1] as CplCompanyTemplateKind,
            }),
          );
        }
        if (path.length === 1 && path[0] === "policies")
          return json(
            await repo.listPolicies({ ...tenant, ...list(request, ["q", "cursor", "limit"]) }),
          );
        if (path.length === 1 && path[0] === "catalog")
          return json(await repo.listCatalog({ ...tenant, ...list(request) }));
        if (path.length === 2 && path[0] === "catalog") {
          administrationQuery(request, []);
          return json(await repo.getCatalog({ ...tenant, itemId: path[1]! }));
        }
        if (path.length === 2 && path[0] === "directory")
          return json(
            await repo.listDirectory({ ...tenant, ...list(request), kind: kind(path[1]) }),
          );
        if (path.length === 3 && path[0] === "directory") {
          administrationQuery(request, []);
          return json(
            await repo.getDirectory({ ...tenant, kind: kind(path[1]), entryId: path[2]! }),
          );
        }
        if (path.length === 1 && path[0] === "audit")
          return json(
            await repo.listAudit({
              ...tenant,
              ...list(request, ["action", "actorIdentityId", "from", "to", "cursor", "limit"]),
            }),
          );
        return json({ code: "CPL_RECORD_NOT_FOUND" }, 404);
      },
      { sessionRequest: request },
    );
  } catch (error) {
    return administrationFailure(error);
  }
}
export async function POST(request: Request, context: Context) {
  try {
    const { path } = await context.params;
    administrationQuery(request, []);
    return await withHostedRuntime(
      async (runtime) => {
        const current = await requireHostedMutation(runtime, request),
          tenant = commercialTenant(current, request),
          repo = new SqlCplCompanyRepository(runtime.tenants);
        if (path.length === 1 && ["profile", "intake-policy", "policies"].includes(path[0]!)) {
          const input = await body(request, ["expectedVersion", "idempotencyKey", "input"]);
          const edit = {
            ...tenant,
            expectedVersion: integer(input, "expectedVersion", 0),
            idempotencyKey: text(input, "idempotencyKey"),
            input: input.input,
          };
          return json(
            await (path[0] === "profile"
              ? repo.saveProfile(edit)
              : path[0] === "intake-policy"
                ? repo.saveIntakePolicy(edit)
                : new SqlCplDeliveryRepository(runtime.tenants).saveCompanyPolicy(edit)),
          );
        }
        if ((path.length === 1 || path.length === 2) && path[0] === "catalog") {
          const input = await body(request, ["expectedRevision", "idempotencyKey", "input"]);
          return json(
            await repo.saveCatalog({
              ...tenant,
              ...(path[1] ? { itemId: path[1] } : {}),
              expectedRevision: integer(input, "expectedRevision", 0),
              idempotencyKey: text(input, "idempotencyKey"),
              input: input.input,
            }),
          );
        }
        if (
          path.length === 3 &&
          path[0] === "catalog" &&
          ["archive", "reactivate"].includes(path[2]!)
        ) {
          const input = await body(request, ["expectedRevision", "idempotencyKey", "reason"]);
          return json(
            await repo.setCatalogStatus({
              ...tenant,
              itemId: path[1]!,
              expectedRevision: integer(input, "expectedRevision"),
              idempotencyKey: text(input, "idempotencyKey"),
              reason: text(input, "reason"),
              status: path[2] === "archive" ? "archived" : "active",
            }),
          );
        }
        if ((path.length === 2 || path.length === 3) && path[0] === "directory") {
          const input = await body(request, ["expectedRevision", "idempotencyKey", "input"]);
          return json(
            await repo.saveDirectory({
              ...tenant,
              kind: kind(path[1]),
              ...(path[2] ? { entryId: path[2] } : {}),
              expectedRevision: integer(input, "expectedRevision", 0),
              idempotencyKey: text(input, "idempotencyKey"),
              input: input.input,
            }),
          );
        }
        if (
          path.length === 4 &&
          path[0] === "directory" &&
          ["archive", "reactivate"].includes(path[3]!)
        ) {
          const input = await body(request, ["expectedRevision", "idempotencyKey", "reason"]);
          return json(
            await repo.setDirectoryStatus({
              ...tenant,
              kind: kind(path[1]),
              entryId: path[2]!,
              expectedRevision: integer(input, "expectedRevision"),
              idempotencyKey: text(input, "idempotencyKey"),
              reason: text(input, "reason"),
              status: path[3] === "archive" ? "archived" : "active",
            }),
          );
        }
        return json({ code: "CPL_RECORD_NOT_FOUND" }, 404);
      },
      { sessionRequest: request },
    );
  } catch (error) {
    return administrationFailure(error);
  }
}
