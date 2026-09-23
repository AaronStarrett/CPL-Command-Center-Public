import { SqlCplAutomationRepository } from "@bea/database/hosted";
import { withHostedRuntime, requireHostedSession, requireHostedMutation } from "@/lib/hosted-auth";
import {
  CommercialInputError,
  commercialTenant,
  commercialJson as json,
  commercialBody as body,
  commercialString as field,
  commercialInteger as integer,
} from "@/lib/cpl-commercial-http";
import { cplOperationsFailure } from "@/lib/cpl-operations-http";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
export async function GET(request: Request, context: Context) {
  try {
    const { path } = await context.params;
    return await withHostedRuntime(
      async (runtime) => {
        const current = await requireHostedSession(runtime, request),
          tenant = commercialTenant(current, request),
          repository = new SqlCplAutomationRepository(runtime.tenants);
        if (path.length === 1 && path[0] === "workspace")
          return json(await repository.getWorkspace(tenant));
        if (path.length === 2 && path[0] === "executions")
          return json(await repository.getExecution({ ...tenant, executionId: path[1]! }));
        return json({ code: "CPL_RECORD_NOT_FOUND" }, 404);
      },
      { sessionRequest: request },
    );
  } catch (error) {
    return cplOperationsFailure(error);
  }
}
export async function POST(request: Request, context: Context) {
  try {
    const { path } = await context.params;
    return await withHostedRuntime(
      async (runtime) => {
        const current = await requireHostedMutation(runtime, request),
          tenant = commercialTenant(current, request),
          repository = new SqlCplAutomationRepository(runtime.tenants);
        if (path.length === 1 && path[0] === "recipes") {
          const input = await body(request, [
            "recipeId",
            "expectedVersion",
            "idempotencyKey",
            "input",
          ]);
          return json(
            await repository.saveRecipe({
              ...tenant,
              ...(input.recipeId === undefined ? {} : { recipeId: field(input, "recipeId") }),
              expectedVersion: integer(input, "expectedVersion", 0),
              idempotencyKey: field(input, "idempotencyKey"),
              input: input.input,
            }),
          );
        }
        if (path.length === 2 && path[0] === "tasks") {
          const input = await body(request, [
            "expectedRevision",
            "idempotencyKey",
            "action",
            "owner",
            "reason",
          ]);
          const action = field(input, "action");
          if (
            action !== "assign" &&
            action !== "start" &&
            action !== "complete" &&
            action !== "dismiss"
          )
            throw new CommercialInputError();
          return json(
            await repository.updateTask({
              ...tenant,
              taskId: path[1]!,
              expectedRevision: integer(input, "expectedRevision"),
              idempotencyKey: field(input, "idempotencyKey"),
              action,
              ...(input.owner === undefined
                ? {}
                : {
                    owner: input.owner as NonNullable<
                      Parameters<SqlCplAutomationRepository["updateTask"]>[0]["owner"]
                    >,
                  }),
              ...(input.reason === undefined ? {} : { reason: field(input, "reason") }),
            }),
          );
        }
        if (
          path.length === 3 &&
          path[0] === "executions" &&
          (path[2] === "retry" || path[2] === "cancel")
        ) {
          const input = await body(request, ["expectedRevision", "idempotencyKey", "reason"]);
          const edit = {
            ...tenant,
            executionId: path[1]!,
            expectedRevision: integer(input, "expectedRevision"),
            idempotencyKey: field(input, "idempotencyKey"),
            reason: field(input, "reason"),
          };
          return json(
            await (path[2] === "retry"
              ? repository.retryExecution(edit)
              : repository.cancelExecution(edit)),
          );
        }
        if (path.length === 3 && path[0] === "events" && path[2] === "replay") {
          const input = await body(request, ["idempotencyKey", "reason"]);
          return json(
            await repository.replayEvent({
              ...tenant,
              eventId: path[1]!,
              idempotencyKey: field(input, "idempotencyKey"),
              reason: field(input, "reason"),
            }),
          );
        }
        return json({ code: "CPL_RECORD_NOT_FOUND" }, 404);
      },
      { sessionRequest: request },
    );
  } catch (error) {
    return cplOperationsFailure(error);
  }
}
