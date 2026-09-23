import { SqlCplReportRepository } from "@bea/database/hosted";
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
import { cplEvidenceStorage } from "@/lib/cpl-evidence-runtime";
import { approveCplReport } from "@/lib/cpl-report-artifact";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
const common = new Set([
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
]);
function failure(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "";
  if (!common.has(code) && !/^CPL_(?:REPORT|EVIDENCE|FIELD)_[A-Z_]+$/u.test(code))
    return json({ code: "CPL_WORKSPACE_UNAVAILABLE" }, 503);
  const status =
    code.includes("SCHEMA_UNSAFE") || code.startsWith("CPL_EVIDENCE_")
      ? 503
      : code === "CPL_AUTH_RATE_LIMITED"
        ? 429
        : code.endsWith("NOT_FOUND")
          ? 404
          : ["CPL_SESSION_REQUIRED", "CPL_AUTHENTICATION_REQUIRED"].includes(code)
            ? 401
            : code.includes("CONFLICT") ||
                code.includes("STALE") ||
                code === "CPL_REPORT_SOURCES_CHANGED" ||
                code === "CPL_REPORT_SOURCE_UNAVAILABLE" ||
                code === "CPL_REPORT_SOURCE_NOT_ELIGIBLE" ||
                code.includes("IMMUTABLE") ||
                code.endsWith("NOT_READY") ||
                code.endsWith("REQUIRED") ||
                code.endsWith("IMMUTABLE") ||
                code === "CPL_ORGANIZATION_CONTEXT_CHANGED"
              ? 409
              : code.includes("INVALID") ||
                  code.includes("LIMIT") ||
                  code.startsWith("CPL_REPORT_PDF_")
                ? 400
                : 403;
  return json({ code }, status);
}
function projectPath(path: string[]) {
  if (path[0] !== "projects" || path.length < 2) throw new CommercialInputError();
  return { projectId: path[1]! };
}
function reportPath(path: string[]) {
  if (path[2] !== "reports" || path.length < 4) throw new CommercialInputError();
  return { ...projectPath(path), reportId: path[3]! };
}
function requestedVersion(request: Request) {
  const values = new URL(request.url).searchParams.getAll("version");
  if (values.length !== 1 || !/^[1-9]\d{0,7}$/u.test(values[0] ?? ""))
    throw new CommercialInputError();
  return Number(values[0]);
}
export async function GET(request: Request, context: Context) {
  try {
    const { path } = await context.params;
    return await withHostedRuntime(
      async (runtime) => {
        const current = await requireHostedSession(runtime, request);
        const download = path.length === 5 && path[4] === "pdf";
        const tenant = commercialTenant(current, request, download),
          repository = new SqlCplReportRepository(runtime.tenants);
        if (path.length === 2)
          return json(await repository.getProjectWorkspace({ ...tenant, ...projectPath(path) }));
        const scope = { ...tenant, ...reportPath(path) };
        if (path.length === 4) return json(await repository.getReport(scope));
        if (path.length === 5 && path[4] === "preview")
          return json(
            await repository.getCustomerPreview({ ...scope, version: requestedVersion(request) }),
          );
        if (download) {
          const artifact = await repository.getArtifact({
            ...scope,
            version: requestedVersion(request),
          });
          const storage = await cplEvidenceStorage(request),
            bytes = await storage.getVerified(artifact.reference);
          return new Response(new Uint8Array(bytes).buffer, {
            headers: {
              ...commercialPrivateHeaders,
              "Content-Type": "application/pdf",
              "Content-Disposition": `attachment; filename="report-${scope.reportId.replace(/[^a-zA-Z0-9-]/gu, "_")}-v${artifact.version}.pdf"`,
              "Content-Security-Policy": "default-src 'none'; sandbox",
              "X-Artifact-SHA256": artifact.reference.sha256,
              "X-CPL-Report-Version": String(artifact.version),
            },
          });
        }
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
        const current = await requireHostedMutation(runtime, request),
          tenant = commercialTenant(current, request),
          repository = new SqlCplReportRepository(runtime.tenants);
        if (path.length === 1 && path[0] === "templates") {
          const input = await body(request, [
            "templateId",
            "expectedVersion",
            "idempotencyKey",
            "input",
          ]);
          return json(
            await repository.saveTemplate({
              ...tenant,
              ...(input.templateId === undefined ? {} : { templateId: field(input, "templateId") }),
              expectedVersion: integer(input, "expectedVersion", 0),
              idempotencyKey: field(input, "idempotencyKey"),
              input: input.input,
            }),
            201,
          );
        }
        if (path.length === 1 && path[0] === "branding") {
          const input = await body(
            request,
            ["expectedRevision", "idempotencyKey", "input"],
            2_850_000,
          );
          return json(
            await repository.saveBranding({
              ...tenant,
              expectedRevision: integer(input, "expectedRevision", 0),
              idempotencyKey: field(input, "idempotencyKey"),
              input: input.input,
            }),
          );
        }
        if (path.length === 3 && path[2] === "reports") {
          const input = await body(request, ["templateId", "templateVersion", "idempotencyKey"]);
          return json(
            await repository.createReport({
              ...tenant,
              ...projectPath(path),
              templateId: field(input, "templateId"),
              templateVersion: integer(input, "templateVersion"),
              idempotencyKey: field(input, "idempotencyKey"),
            }),
            201,
          );
        }
        if (path.length !== 5) return json({ code: "CPL_RECORD_NOT_FOUND" }, 404);
        const scope = { ...tenant, ...reportPath(path) },
          action = path[4];
        const input = await body(request, [
          "expectedRevision",
          "idempotencyKey",
          ...(action === "save" || action === "sources"
            ? ["input"]
            : action === "review" || action === "revise"
              ? ["reason"]
              : []),
        ]);
        const edit = {
          ...scope,
          expectedRevision: integer(input, "expectedRevision"),
          idempotencyKey: field(input, "idempotencyKey"),
        };
        if (action === "save")
          return json(await repository.saveReport({ ...edit, input: input.input }));
        if (action === "sources")
          return json(
            await repository.refreshSources({
              ...edit,
              ...(input.input === undefined ? {} : { input: input.input }),
            }),
          );
        if (action === "submit") return json(await repository.submitReport(edit));
        if (action === "review")
          return json(await repository.requestChanges({ ...edit, reason: field(input, "reason") }));
        if (action === "revise")
          return json(await repository.reviseReport({ ...edit, reason: field(input, "reason") }));
        if (action === "approve") {
          const storage = await cplEvidenceStorage(request);
          await approveCplReport(repository, edit, storage);
          return json(await repository.getReport(scope));
        }
        return json({ code: "CPL_RECORD_NOT_FOUND" }, 404);
      },
      { sessionRequest: request },
    );
  } catch (error) {
    return failure(error);
  }
}
