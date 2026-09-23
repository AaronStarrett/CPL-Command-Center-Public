import { SqlCplDeliveryRepository } from "@bea/database/hosted";
import {
  cplDeliveryPublicManifest,
  cplDeliveryMessageText,
  cplBillingHandoff,
} from "@bea/domain/cpl-delivery";
import { withHostedRuntime, requireHostedSession, requireHostedMutation } from "@/lib/hosted-auth";
import {
  CommercialInputError,
  commercialTenant,
  commercialJson as json,
  commercialBody as body,
  commercialString as field,
  commercialInteger as integer,
  commercialPrivateHeaders,
} from "@/lib/cpl-commercial-http";
import { cplOperationsFailure } from "@/lib/cpl-operations-http";
import { cplEvidenceStorage } from "@/lib/cpl-evidence-runtime";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
function projectPath(path: string[]) {
  if (path[0] !== "projects" || path.length < 2) throw new CommercialInputError();
  return { projectId: path[1]! };
}
function packagePath(path: string[]) {
  if (path[2] !== "packages" || path.length < 4) throw new CommercialInputError();
  return { ...projectPath(path), packageId: path[3]! };
}
function versionQuery(request: Request, name = "version") {
  const values = new URL(request.url).searchParams.getAll(name);
  if (values.length !== 1 || !/^[1-9][0-9]{0,7}$/u.test(values[0] ?? ""))
    throw new CommercialInputError();
  return Number(values[0]);
}
function download(value: string, name: string, contentType: string) {
  return new Response(value, {
    headers: {
      ...commercialPrivateHeaders,
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${name}"`,
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
export async function GET(request: Request, context: Context) {
  try {
    const { path } = await context.params;
    return await withHostedRuntime(
      async (runtime) => {
        const current = await requireHostedSession(runtime, request);
        const exporting =
          (path.length === 3 && path[2] === "billing-handoff") ||
          (path.length === 5 && ["manifest", "message"].includes(path[4]!)) ||
          (path.length === 6 && path[4] === "attachments");
        const tenant = commercialTenant(current, request, exporting),
          repository = new SqlCplDeliveryRepository(runtime.tenants),
          project = { ...tenant, ...projectPath(path) };
        if (path.length === 2) return json(await repository.workspace(project));
        if (path.length === 3 && path[2] === "billing-handoff") {
          const workspace = await repository.workspace(project);
          return download(
            JSON.stringify(cplBillingHandoff(workspace.project, workspace.readiness), null, 2) +
              "\n",
            "billing-handoff.json",
            "application/json; charset=utf-8",
          );
        }
        const scope = { ...tenant, ...packagePath(path) };
        if (path.length === 4) return json(await repository.getPackage(scope));
        if (path.length === 5 && ["manifest", "message"].includes(path[4]!)) {
          const version = versionQuery(request),
            pkg = await repository.getPackage(scope);
          return path[4] === "manifest"
            ? download(
                JSON.stringify(cplDeliveryPublicManifest(pkg, version), null, 2) + "\n",
                `delivery-package-v${version}.json`,
                "application/json; charset=utf-8",
              )
            : download(
                cplDeliveryMessageText(pkg, version),
                `delivery-message-v${version}.txt`,
                "text/plain; charset=utf-8",
              );
        }
        if (path.length === 6 && path[4] === "attachments") {
          const version = versionQuery(request),
            reportVersion = versionQuery(request, "reportVersion");
          const reference = await repository.attachment({
            ...scope,
            version,
            reportId: path[5]!,
            reportVersion,
          });
          const storage = await cplEvidenceStorage(request),
            bytes = await storage.getVerified(reference);
          return new Response(new Uint8Array(bytes).buffer, {
            headers: {
              ...commercialPrivateHeaders,
              "Content-Type": "application/pdf",
              "Content-Disposition": `attachment; filename="approved-report-v${reportVersion}.pdf"`,
              "Content-Security-Policy": "default-src 'none'; sandbox",
              "X-Artifact-SHA256": reference.sha256,
              "X-CPL-Report-Version": String(reportVersion),
              "X-CPL-Package-Version": String(version),
            },
          });
        }
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
          repository = new SqlCplDeliveryRepository(runtime.tenants),
          project = { ...tenant, ...projectPath(path) };
        if (path.length === 3 && path[2] === "packages") {
          const input = await body(request, ["input", "idempotencyKey"]);
          return json(
            await repository.createPackage({
              ...project,
              input: input.input,
              idempotencyKey: field(input, "idempotencyKey"),
            }),
            201,
          );
        }
        if (path.length === 3 && path[2] === "policy") {
          const input = await body(request, ["input", "expectedVersion", "idempotencyKey"]);
          return json(
            await repository.savePolicy({
              ...project,
              input: input.input,
              expectedVersion: integer(input, "expectedVersion", 0),
              idempotencyKey: field(input, "idempotencyKey"),
            }),
          );
        }
        if (path.length === 3 && path[2] === "closeout") {
          const input = await body(request, ["input", "expectedRevision", "idempotencyKey"]);
          return json(
            await repository.saveCloseoutFacts({
              ...project,
              input: input.input,
              expectedRevision: integer(input, "expectedRevision", 0),
              idempotencyKey: field(input, "idempotencyKey"),
            }),
          );
        }
        if (path.length === 3 && path[2] === "override") {
          const input = await body(request, [
            "key",
            "evidenceHash",
            "active",
            "reason",
            "idempotencyKey",
          ]);
          if (typeof input.active !== "boolean") throw new CommercialInputError();
          return json(
            await repository.overrideReadiness({
              ...project,
              key: field(input, "key") as Parameters<
                SqlCplDeliveryRepository["overrideReadiness"]
              >[0]["key"],
              evidenceHash: field(input, "evidenceHash"),
              active: input.active,
              reason: field(input, "reason"),
              idempotencyKey: field(input, "idempotencyKey"),
            }),
          );
        }
        if (path.length === 5 && path[2] === "reports" && path[4] === "withdraw") {
          const input = await body(request, ["version", "reason", "idempotencyKey"]);
          return json(
            await repository.withdrawApproval({
              ...project,
              reportId: path[3]!,
              version: integer(input, "version"),
              reason: field(input, "reason"),
              idempotencyKey: field(input, "idempotencyKey"),
            }),
          );
        }
        const scope = { ...tenant, ...packagePath(path) };
        if (path.length !== 5) return json({ code: "CPL_RECORD_NOT_FOUND" }, 404);
        const action = path[4];
        if (!["save", "revise", "ready", "export", "record-sent", "acknowledge"].includes(action!))
          return json({ code: "CPL_RECORD_NOT_FOUND" }, 404);
        const input = await body(request, [
          "expectedRevision",
          "idempotencyKey",
          ...(action === "revise"
            ? ["input", "reason"]
            : action === "save" || action === "record-sent" || action === "acknowledge"
              ? ["input"]
              : action === "ready"
                ? ["recipientConfirmed"]
                : []),
        ]);
        const edit = {
          ...scope,
          expectedRevision: integer(input, "expectedRevision"),
          idempotencyKey: field(input, "idempotencyKey"),
        };
        if (action === "save")
          return json(await repository.savePackage({ ...edit, input: input.input }));
        if (action === "revise")
          return json(
            await repository.revisePackage({
              ...edit,
              input: input.input,
              reason: field(input, "reason"),
            }),
          );
        if (action === "ready") {
          if (input.recipientConfirmed !== true) throw new CommercialInputError();
          return json(await repository.markReady({ ...edit, recipientConfirmed: true }));
        }
        if (action === "export") return json(await repository.recordExport(edit));
        if (action === "record-sent")
          return json(await repository.recordSent({ ...edit, input: input.input }));
        return json(await repository.acknowledge({ ...edit, input: input.input }));
      },
      { sessionRequest: request },
    );
  } catch (error) {
    return cplOperationsFailure(error);
  }
}
