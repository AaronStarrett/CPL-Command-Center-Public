import { SqlCplFieldRepository } from "@bea/database/hosted";
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
import { cplEvidenceStorage, cplImageUpload } from "@/lib/cpl-evidence-runtime";
import { prepareCplPhoto } from "@/lib/cpl-field-evidence";

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
  if (!common.has(code) && !/^CPL_(?:FIELD|IMAGE|EVIDENCE)_[A-Z_]+$/u.test(code))
    return json({ code: "CPL_WORKSPACE_UNAVAILABLE" }, 503);
  const status =
    code.includes("SCHEMA_UNSAFE") ||
    code.includes("STORAGE_UNAVAILABLE") ||
    code.includes("INTEGRITY_FAILURE")
      ? 503
      : code === "CPL_AUTH_RATE_LIMITED" || code.endsWith("BUSY") || code.endsWith("QUEUE_TIMEOUT")
        ? 429
        : code.endsWith("NOT_FOUND")
          ? 404
          : ["CPL_SESSION_REQUIRED", "CPL_AUTHENTICATION_REQUIRED"].includes(code)
            ? 401
            : code.includes("CONFLICT") ||
                [
                  "CPL_FIELD_PHOTO_LEASE_EXPIRED",
                  "CPL_FIELD_VISIT_LOCKED",
                  "CPL_FIELD_TEMPLATE_PINNED",
                  "CPL_FIELD_IMMUTABLE_EVIDENCE",
                ].includes(code) ||
                code.endsWith("NOT_READY") ||
                (code.includes("REQUIRED") && code.startsWith("CPL_FIELD_")) ||
                code === "CPL_ORGANIZATION_CONTEXT_CHANGED"
              ? 409
              : code.includes("INVALID") ||
                  code.startsWith("CPL_IMAGE_") ||
                  code.endsWith("LIMIT") ||
                  code.endsWith("LIMIT_EXCEEDED")
                ? 400
                : 403;
  return json({ code }, status);
}
function visitPath(path: string[]) {
  if (path.length < 4 || path[0] !== "projects" || path[2] !== "visits")
    throw new CommercialInputError();
  return { projectId: path[1]!, visitId: path[3]! };
}
function optional(input: Record<string, unknown>, name: string) {
  return input[name] === undefined ? undefined : field(input, name);
}
export async function GET(request: Request, context: Context) {
  try {
    const { path } = await context.params;
    return await withHostedRuntime(
      async (runtime) => {
        const current = await requireHostedSession(runtime, request);
        const download = path.length === 7 && path[4] === "photos" && path[6] === "file";
        const tenant = commercialTenant(current, request, download),
          repository = new SqlCplFieldRepository(runtime.tenants);
        if (path.length === 1 && path[0] === "templates")
          return json(await repository.listTemplates(tenant));
        const scope = { ...tenant, ...visitPath(path) };
        if (path.length === 4) return json(await repository.getVisitWorkspace(scope));
        if (download) {
          const values = new URL(request.url).searchParams.getAll("variant"),
            kind = values[0];
          if (values.length !== 1 || !["original", "thumbnail", "report"].includes(kind ?? ""))
            throw new CommercialInputError();
          const reference = await repository.getPhotoContent({
            ...scope,
            photoId: path[5]!,
            kind: kind as "original" | "thumbnail" | "report",
          });
          const storage = await cplEvidenceStorage(request),
            bytes = await storage.getVerified(reference);
          // Original MIME is signature-derived, never extension- or caller-controlled.
          const mime =
            kind === "original" && bytes[0] === 0xff && bytes[1] === 0xd8
              ? "image/jpeg"
              : "image/png";
          return new Response(new Uint8Array(bytes).buffer, {
            headers: {
              ...commercialPrivateHeaders,
              "Content-Type": mime,
              "Content-Disposition": `${kind === "original" ? "attachment" : "inline"}; filename="photo-${path[5]!.replace(/[^a-zA-Z0-9-]/gu, "_")}-${kind}.${mime === "image/jpeg" ? "jpg" : "png"}"`,
              "Content-Security-Policy": "default-src 'none'; sandbox",
              "X-Artifact-SHA256": reference.sha256,
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
          repository = new SqlCplFieldRepository(runtime.tenants);
        if (path.length === 1 && path[0] === "templates") {
          const input = await body(request, [
              "templateId",
              "expectedVersion",
              "idempotencyKey",
              "input",
            ]),
            templateId = optional(input, "templateId");
          return json(
            await repository.saveTemplate({
              ...tenant,
              ...(templateId ? { templateId } : {}),
              expectedVersion: integer(input, "expectedVersion", 0),
              idempotencyKey: field(input, "idempotencyKey"),
              input: input.input,
            }),
            201,
          );
        }
        const scope = { ...tenant, ...visitPath(path) };
        if (path.length === 5 && path[4] === "photos") {
          const workspace = await repository.getVisitWorkspace(scope);
          if (!workspace.permissions.canEdit) return json({ code: "CPL_ACCESS_DENIED" }, 403);
          const storage = await cplEvidenceStorage(request),
            upload = await cplImageUpload(request);
          const { validateCplImageOriginal } = await import("@bea/artifacts/cpl-image");
          const validated = await validateCplImageOriginal(upload);
          const transfer = await repository.reservePhoto({
            ...scope,
            idempotencyKey: upload.idempotencyKey,
            input: {
              filename: validated.original.filename,
              mimeType: validated.original.mimeType,
              sha256: validated.original.sha256,
              byteLength: validated.original.byteLength,
            },
          });
          await storage.putImmutable({ ...transfer.original, bytes: validated.original.bytes });
          const photo = await prepareCplPhoto(
            repository,
            scope,
            storage,
            transfer,
            upload.idempotencyKey,
            validated,
          );
          return json(photo, photo.state === "ready" ? 201 : 202);
        }
        if (path.length === 7 && path[4] === "photos" && path[6] === "retry") {
          const input = await body(request, ["idempotencyKey"]),
            requestKey = field(input, "idempotencyKey");
          if (!/^[A-Za-z0-9_-]{8,120}$/u.test(requestKey)) throw new CommercialInputError();
          const transfer = await repository.getPhotoTransfer({ ...scope, photoId: path[5]! }),
            storage = await cplEvidenceStorage(request);
          const photo = await prepareCplPhoto(repository, scope, storage, transfer, requestKey);
          return json(photo, photo.state === "ready" ? 200 : 202);
        }
        if (path.length === 6 && path[4] === "photos") {
          const input = await body(request, ["expectedRevision", "idempotencyKey", "input"]);
          return json(
            await repository.savePhotoMetadata({
              ...scope,
              photoId: path[5]!,
              expectedRevision: integer(input, "expectedRevision", 0),
              idempotencyKey: field(input, "idempotencyKey"),
              input: input.input,
            }),
          );
        }
        if (path.length !== 5) return json({ code: "CPL_RECORD_NOT_FOUND" }, 404);
        if (path[4] === "template") {
          const input = await body(request, [
            "expectedRevision",
            "idempotencyKey",
            "templateId",
            "templateVersion",
          ]);
          return json(
            await repository.attachTemplate({
              ...scope,
              expectedRevision: integer(input, "expectedRevision", 0),
              idempotencyKey: field(input, "idempotencyKey"),
              templateId: field(input, "templateId"),
              templateVersion: integer(input, "templateVersion"),
            }),
          );
        }
        if (path[4] === "checklist") {
          const input = await body(request, ["expectedRevision", "idempotencyKey", "answers"]);
          return json(
            await repository.saveChecklist({
              ...scope,
              expectedRevision: integer(input, "expectedRevision", 0),
              idempotencyKey: field(input, "idempotencyKey"),
              answers: input.answers,
            }),
          );
        }
        if (path[4] === "observations") {
          const input = await body(request, [
              "expectedRevision",
              "idempotencyKey",
              "observationId",
              "input",
            ]),
            observationId = optional(input, "observationId");
          return json(
            await repository.saveObservation({
              ...scope,
              expectedRevision: integer(input, "expectedRevision", 0),
              idempotencyKey: field(input, "idempotencyKey"),
              ...(observationId ? { observationId } : {}),
              input: input.input,
            }),
          );
        }
        if (path[4] === "reopen") {
          const input = await body(request, [
            "expectedRevision",
            "expectedVisitRevision",
            "idempotencyKey",
            "reason",
          ]);
          return json(
            await repository.reopenVisit({
              ...scope,
              expectedFieldRevision: integer(input, "expectedRevision", 0),
              expectedVisitRevision: integer(input, "expectedVisitRevision"),
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
    return failure(error);
  }
}
