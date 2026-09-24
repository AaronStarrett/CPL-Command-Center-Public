import { SqlCplIntegrationRepository, SqlCplInboundRepository } from "@bea/database/hosted";
import { createCplIntegrationRuntime } from "@bea/database/cpl-integration-runtime";
import { withHostedRuntime, requireHostedSession, requireHostedMutation } from "@/lib/hosted-auth";
import {
  CommercialInputError,
  commercialTenant,
  commercialBody as body,
  commercialString as text,
  commercialInteger as integer,
} from "@/lib/cpl-commercial-http";
import { administrationQuery } from "@/lib/cpl-administration-http";
import { inboundJson as json, inboundHeaders } from "@/lib/cpl-inbound-http";
import {
  integrationFailure,
  integrationList,
  integrationCallbackQuery,
} from "@/lib/cpl-integration-http";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
const id = (value: string | undefined) => {
  if (!value || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value))
    throw new CommercialInputError();
  return value;
};
const change = (input: Record<string, unknown>) => ({
  expectedRevision: integer(input, "expectedRevision"),
  idempotencyKey: text(input, "idempotencyKey"),
});

export async function GET(request: Request, context: Context) {
  try {
    const { path } = await context.params;
    return await withHostedRuntime(
      async (runtime) => {
        const current = await requireHostedSession(runtime, request);
        const options = await createCplIntegrationRuntime({
          database: runtime.database,
          origin: runtime.origin,
        });
        const repo = new SqlCplIntegrationRepository(runtime.database, runtime.tenants, options);
        const inbound = new SqlCplInboundRepository(runtime.database, runtime.tenants, options);
        if (path.join("/") === "oauth/google/callback") {
          // Ownership comes from single-use, session-bound state. The browser's
          // selected company/header/query never decides credential ownership.
          await repo.completeOAuth({
            sessionToken: current.sessionToken,
            ...integrationCallbackQuery(request),
          });
          return new Response(null, {
            status: 303,
            headers: { ...inboundHeaders, Location: runtime.origin + "/workspace" },
          });
        }
        const tenant = commercialTenant(current, request);
        if (path.length === 1 && path[0] === "mappings")
          return json(
            await repo.listMappings({
              ...tenant,
              ...integrationList(request, ["cursor", "limit"]),
            }),
          );
        if (path.length === 2 && path[0] === "mappings") {
          const query = administrationQuery(request, ["version"]);
          if (!query.version || !/^[1-9][0-9]{0,5}$/u.test(query.version))
            throw new CommercialInputError();
          return json(
            await repo.getMapping({
              ...tenant,
              mappingId: id(path[1]),
              version: Number(query.version),
            }),
          );
        }
        if (path.length === 1 && path[0] === "workspace")
          return json(await repo.getWorkspace({ ...tenant, ...integrationList(request) }));
        if (path.length === 1 && path[0] === "receipts")
          return json(
            await repo.listReceipts({
              ...tenant,
              ...integrationList(request, ["cursor", "limit", "status", "sourceId"]),
            }),
          );
        if (path.length === 1 && path[0] === "connections")
          return json(
            await repo.listConnections({
              ...tenant,
              ...integrationList(request, ["cursor", "limit"]),
            }),
          );
        if (path.length === 1 && path[0] === "forms")
          return json(
            await inbound.listForms({
              ...tenant,
              ...integrationList(request, ["cursor", "limit"]),
            }),
          );
        administrationQuery(request, []);
        if (path.length === 2 && path[0] === "connections")
          return json(await repo.getConnection({ ...tenant, connectionId: id(path[1]) }));
        if (path.length === 3 && path[0] === "connections" && path[2] === "labels")
          return json(await repo.listConnectionLabels({ ...tenant, connectionId: id(path[1]) }));
        if (path.length === 2 && path[0] === "receipts")
          return json(await repo.getReceipt({ ...tenant, receiptId: id(path[1]) }));
        if (path.length === 3 && path[0] === "receipts" && path[2] === "evidence") {
          const artifact = await repo.getReceiptEvidence({ ...tenant, receiptId: id(path[1]) });
          return new Response(Uint8Array.from(artifact.bytes), {
            headers: {
              ...inboundHeaders,
              "Content-Type": "application/octet-stream",
              "Content-Disposition": `attachment; filename="${artifact.filename}"`,
              "Content-Length": String(artifact.byteLength),
              "X-Content-Type-Options": "nosniff",
              "X-CPL-Content-SHA256": artifact.sha256,
              "Content-Security-Policy": "default-src 'none'; sandbox",
            },
          });
        }
        if (path.length === 3 && path[0] === "forms" && path[2] === "preview")
          return json(await inbound.readFormPreview({ ...tenant, formId: id(path[1]) }));
        return json({ code: "CPL_RECORD_NOT_FOUND" }, 404);
      },
      { sessionRequest: request },
    );
  } catch (error) {
    return integrationFailure(error);
  }
}

export async function POST(request: Request, context: Context) {
  try {
    const { path } = await context.params;
    administrationQuery(request, []);
    return await withHostedRuntime(
      async (runtime) => {
        const current = await requireHostedMutation(runtime, request),
          tenant = commercialTenant(current, request);
        const options = await createCplIntegrationRuntime({
          database: runtime.database,
          origin: runtime.origin,
        });
        const repo = new SqlCplIntegrationRepository(runtime.database, runtime.tenants, options);
        const inbound = new SqlCplInboundRepository(runtime.database, runtime.tenants, options);
        if (path.length === 1 && path[0] === "connections") {
          const input = await body(request, ["input", "idempotencyKey"]);
          return json(
            await repo.createConnection({
              ...tenant,
              input: input.input,
              idempotencyKey: text(input, "idempotencyKey"),
            }),
            201,
          );
        }
        if (
          path.length === 4 &&
          path[0] === "connections" &&
          path[2] === "oauth" &&
          path[3] === "start"
        ) {
          const input = await body(request, ["expectedRevision", "idempotencyKey"]);
          return json(
            await repo.startOAuth({ ...tenant, ...change(input), connectionId: id(path[1]) }),
          );
        }
        if (path.length === 3 && path[0] === "connections") {
          const connectionId = id(path[1]);
          if (path[2] === "save") {
            const input = await body(request, [
              "expectedRevision",
              "idempotencyKey",
              "input",
              "reconcile",
            ]);
            if (input.reconcile !== "from_now" && input.reconcile !== "bounded_backfill")
              throw new CommercialInputError();
            return json(
              await repo.saveConnection({
                ...tenant,
                ...change(input),
                connectionId,
                input: input.input,
                reconcile: input.reconcile,
              }),
            );
          }
          if (path[2] === "state") {
            const input = await body(request, [
              "expectedRevision",
              "idempotencyKey",
              "action",
              "reason",
            ]);
            if (
              input.action !== "pause" &&
              input.action !== "resume" &&
              input.action !== "disconnect"
            )
              throw new CommercialInputError();
            return json(
              await repo.changeConnectionState({
                ...tenant,
                ...change(input),
                connectionId,
                action: input.action,
                reason: text(input, "reason"),
              }),
            );
          }
          if (path[2] === "sync") {
            const input = await body(request, ["expectedRevision", "idempotencyKey", "reason"]);
            return json(
              await repo.enqueueSync({
                ...tenant,
                ...change(input),
                connectionId,
                reason: text(input, "reason"),
              }),
            );
          }
        }
        if (path.length === 1 && path[0] === "mappings") {
          const input = await body(request, [
            "mappingId",
            "expectedVersion",
            "idempotencyKey",
            "input",
          ]);
          return json(
            await repo.saveMapping({
              ...tenant,
              ...(input.mappingId === undefined ? {} : { mappingId: id(text(input, "mappingId")) }),
              expectedVersion: integer(input, "expectedVersion", 0),
              idempotencyKey: text(input, "idempotencyKey"),
              input: input.input,
            }),
          );
        }
        if (path.length === 2 && path[0] === "mappings" && path[1] === "preview") {
          const input = await body(request, ["input", "sample"], 65_536);
          return json(
            await repo.previewMapping({ ...tenant, input: input.input, sample: input.sample }),
          );
        }
        if (path.length === 1 && path[0] === "forms") {
          const input = await body(request, [
            "formId",
            "expectedRevision",
            "idempotencyKey",
            "input",
          ]);
          return json(
            await inbound.saveForm({
              ...tenant,
              ...(input.formId === undefined ? {} : { formId: id(text(input, "formId")) }),
              expectedRevision: integer(input, "expectedRevision", 0),
              idempotencyKey: text(input, "idempotencyKey"),
              input: input.input,
            }),
          );
        }
        if (path.length === 3 && path[0] === "forms") {
          const formId = id(path[1]);
          if (path[2] === "state") {
            const input = await body(request, [
              "expectedRevision",
              "idempotencyKey",
              "enabled",
              "reason",
            ]);
            if (typeof input.enabled !== "boolean") throw new CommercialInputError();
            return json(
              await inbound.setFormEnabled({
                ...tenant,
                ...change(input),
                formId,
                enabled: input.enabled,
                reason: text(input, "reason"),
              }),
            );
          }
          if (path[2] === "credential" || path[2] === "revoke-credential") {
            const input = await body(request, ["expectedRevision", "idempotencyKey", "reason"]);
            const credentialRequest = {
              ...tenant,
              ...change(input),
              formId,
              reason: text(input, "reason"),
            };
            return json(
              await (path[2] === "credential"
                ? inbound.rotateSourceCredential(credentialRequest)
                : inbound.revokeSourceCredential(credentialRequest)),
            );
          }
        }
        if (path.length === 3 && path[0] === "receipts") {
          const receiptId = id(path[1]);
          if (path[2] === "retry") {
            const input = await body(request, ["expectedRevision", "idempotencyKey", "reason"]);
            return json(
              await repo.retryReceipt({
                ...tenant,
                ...change(input),
                receiptId,
                reason: text(input, "reason"),
              }),
            );
          }
          if (path[2] === "reprocess") {
            const input = await body(request, [
              "expectedRevision",
              "idempotencyKey",
              "reason",
              "mappingId",
              "mappingVersion",
            ]);
            return json(
              await repo.reprocessReceipt({
                ...tenant,
                ...change(input),
                receiptId,
                reason: text(input, "reason"),
                mappingId: id(text(input, "mappingId")),
                mappingVersion: integer(input, "mappingVersion"),
              }),
            );
          }
        }
        return json({ code: "CPL_RECORD_NOT_FOUND" }, 404);
      },
      { sessionRequest: request },
    );
  } catch (error) {
    return integrationFailure(error);
  }
}
