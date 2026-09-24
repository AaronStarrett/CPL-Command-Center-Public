import { createHash } from "node:crypto";
import { SqlCplCommercialRepository } from "@bea/database/hosted";
import type { CplCommercialAwardInput, CplCommercialLostReason } from "@bea/domain/cpl-commercial";
import {
  renderCplProposalPdf,
  CPL_PROPOSAL_PDF_RENDERER_VERSION,
} from "@bea/artifacts/proposal-pdf";
import { withHostedRuntime, requireHostedSession, requireHostedMutation } from "@/lib/hosted-auth";
import {
  CommercialInputError,
  commercialPrivateHeaders,
  commercialTenant,
  commercialJson as json,
  commercialBody as body,
  commercialString as field,
  commercialInteger as integer,
  commercialVersion,
} from "@/lib/cpl-commercial-http";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
const rendererVersion = CPL_PROPOSAL_PDF_RENDERER_VERSION;
const publicCodes = new Set([
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
  "CPL_VERSION_CONFLICT",
  "CPL_COMMERCIAL_VERSION_CONFLICT",
  "CPL_COMMERCIAL_STATE_CONFLICT",
  "CPL_COMMERCIAL_RECORD_TOO_LARGE",
  "CPL_COMMERCIAL_VERSION_LIMIT",
  "CPL_COMMERCIAL_NOT_READY",
  "CPL_APPROVED_VERSION_REQUIRED",
  "CPL_AWARD_TOTAL_MISMATCH",
  "CPL_AWARD_REQUIRED",
  "CPL_ARTIFACT_SNAPSHOT_CONFLICT",
  "CPL_ARTIFACT_IMMUTABLE",
  "CPL_ARTIFACT_NOT_FOUND",
  "CPL_PROPOSAL_VERSION_CONFLICT",
  "CPL_PROPOSAL_NOT_APPROVED",
  "CPL_PROPOSAL_NOT_READY",
  "CPL_PROPOSAL_ALREADY_EXISTS",
  "CPL_LEAD_NOT_READY",
  "CPL_TEMPLATE_CURRENCY_CONFIRMATION_REQUIRED",
  "CPL_RECORD_NOT_FOUND",
  "CPL_IDEMPOTENCY_CONFLICT",
  "CPL_INVALID_IDEMPOTENCY_KEY",
  "CPL_AUTH_RATE_LIMITED",
  "CPL_PROPOSAL_PDF_UNSUPPORTED_CHARACTER",
  "CPL_PROPOSAL_PDF_INVALID",
  "CPL_PROPOSAL_PDF_LOGO_INVALID",
  "CPL_PROPOSAL_PDF_TOO_LARGE",
  "CPL_ARTIFACT_NOT_READY",
  "CPL_ARTIFACT_CONFLICT",
  "CPL_HOSTED_AUTH_NOT_CONFIGURED",
  "CPL_HOSTED_NOT_CONFIGURED",
]);
function failure(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "CPL_WORKSPACE_UNAVAILABLE";
  if (!publicCodes.has(code)) return json({ code: "CPL_WORKSPACE_UNAVAILABLE" }, 503);
  const status = code.includes("NOT_CONFIGURED")
    ? 503
    : code === "CPL_AUTH_RATE_LIMITED"
      ? 429
      : code === "CPL_RECORD_NOT_FOUND" || code === "CPL_ARTIFACT_NOT_FOUND"
        ? 404
        : ["CPL_SESSION_REQUIRED", "CPL_AUTHENTICATION_REQUIRED"].includes(code)
          ? 401
          : code.includes("CONFLICT") ||
              code.endsWith("NOT_READY") ||
              code.endsWith("NOT_APPROVED") ||
              code.endsWith("ALREADY_EXISTS") ||
              [
                "CPL_COMMERCIAL_VERSION_LIMIT",
                "CPL_APPROVED_VERSION_REQUIRED",
                "CPL_AWARD_TOTAL_MISMATCH",
                "CPL_AWARD_REQUIRED",
                "CPL_ARTIFACT_IMMUTABLE",
              ].includes(code) ||
              code === "CPL_LEAD_NOT_READY" ||
              code === "CPL_TEMPLATE_CURRENCY_CONFIRMATION_REQUIRED" ||
              code === "CPL_ORGANIZATION_CONTEXT_CHANGED"
            ? 409
            : code.includes("INVALID") ||
                code === "CPL_COMMERCIAL_RECORD_TOO_LARGE" ||
                code.startsWith("CPL_PROPOSAL_PDF_")
              ? 400
              : 403;
  return json({ code }, status);
}
function optionalString(input: Record<string, unknown>, name: string) {
  if (input[name] === undefined || input[name] === null) return undefined;
  return field(input, name);
}
function optionalBoolean(input: Record<string, unknown>, name: string) {
  if (input[name] === undefined) return false;
  if (typeof input[name] !== "boolean") throw new CommercialInputError();
  return input[name];
}
function awardInput(value: unknown): CplCommercialAwardInput | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CommercialInputError();
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).some(
      (key) =>
        !["awardDate", "amountMinor", "currency", "purchaseOrder", "startDate", "notes"].includes(
          key,
        ),
    )
  )
    throw new CommercialInputError();
  return {
    awardDate: field(row, "awardDate"),
    amountMinor: integer(row, "amountMinor", 0),
    currency: field(row, "currency"),
    purchaseOrder: field(row, "purchaseOrder", true),
    startDate: optionalString(row, "startDate") || null,
    notes: field(row, "notes", true),
  };
}

export async function GET(request: Request, context: Context) {
  try {
    const { path } = await context.params;
    return await withHostedRuntime(
      async (runtime) => {
        const current = await requireHostedSession(runtime, request);
        const download = path[0] === "proposals" && path.length === 3 && path[2] === "pdf";
        const tenant = commercialTenant(current, request, download);
        const repository = new SqlCplCommercialRepository(runtime.tenants);
        if (path.length === 1 && path[0] === "workspace")
          return json(await repository.readWorkspace(tenant));
        if (path.length === 2 && path[0] === "projects")
          return json(await repository.getProject({ ...tenant, projectId: path[1]! }));
        if (path[0] !== "proposals" || path.length < 2 || path.length > 3)
          return json({ code: "CPL_RECORD_NOT_FOUND" }, 404);
        const selected = { ...tenant, proposalId: path[1]! };
        if (path.length === 2) return json(await repository.getProposal(selected));
        if (path[2] === "project-preview") return json(await repository.previewProject(selected));
        const version = commercialVersion(request);
        if (path[2] === "customer-preview")
          return json(
            await repository.getCustomerPreview({
              ...selected,
              ...(version === undefined ? {} : { version }),
            }),
          );
        if (download) {
          if (version === undefined) throw new CommercialInputError();
          const artifact = await repository.getPdfArtifact({ ...selected, version });
          return new Response(new Uint8Array(artifact.bytes).buffer, {
            headers: {
              ...commercialPrivateHeaders,
              "Content-Type": "application/pdf",
              "Content-Disposition": `attachment; filename="proposal-${selected.proposalId.replace(/[^a-zA-Z0-9-]/gu, "_")}-v${version}.pdf"`,
              "Content-Security-Policy": "default-src 'none'; sandbox",
              "X-Artifact-SHA256": artifact.metadata.sha256,
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
        const current = await requireHostedMutation(runtime, request);
        const tenant = commercialTenant(current, request);
        const repository = new SqlCplCommercialRepository(runtime.tenants);
        if (path.length === 1 && path[0] === "proposals") {
          const input = await body(request, [
            "leadId",
            "templateId",
            "legacyDraftId",
            "allowAdditional",
            "legacyTemplateCurrency",
            "idempotencyKey",
          ]);
          const templateId = optionalString(input, "templateId"),
            legacyDraftId = optionalString(input, "legacyDraftId");
          return json(
            await repository.createProposal({
              ...tenant,
              leadId: field(input, "leadId"),
              ...(templateId ? { templateId } : {}),
              ...(legacyDraftId ? { legacyDraftId } : {}),
              allowAdditional: optionalBoolean(input, "allowAdditional"),
              ...(input.legacyTemplateCurrency === undefined
                ? {}
                : { legacyTemplateCurrency: field(input, "legacyTemplateCurrency") }),
              idempotencyKey: field(input, "idempotencyKey"),
            }),
            201,
          );
        }
        if (path.length === 1 && path[0] === "templates") {
          const input = await body(request, ["input", "idempotencyKey"]);
          return json(
            await repository.createTemplate({
              ...tenant,
              input: input.input,
              idempotencyKey: field(input, "idempotencyKey"),
            }),
            201,
          );
        }
        if (path.length === 1 && path[0] === "branding") {
          const input = await body(request, ["input", "expectedRevision"]);
          return json(
            await repository.saveBranding({
              ...tenant,
              input: input.input,
              expectedRevision: integer(input, "expectedRevision", 0),
            }),
          );
        }
        if (path[0] !== "proposals" || path.length !== 3)
          return json({ code: "CPL_RECORD_NOT_FOUND" }, 404);
        const selected = { ...tenant, proposalId: path[1]! };
        if (path[2] === "pdf") {
          const input = await body(request, ["version"]),
            version = integer(input, "version");
          // Every artifact begins with an approved customer projection. Renderer
          // output is the only source of bytes; browser-supplied artifacts are refused.
          await runtime.tenants.authorize({
            ...tenant,
            permission: "commercial:write",
            module: "proposal-builder",
          });
          const projection = await repository.getApprovedPdf({ ...selected, version });
          const bytes = await renderCplProposalPdf(projection);
          const projectionSha256 = createHash("sha256")
            .update(JSON.stringify(projection))
            .digest("hex");
          return json(
            await repository.recordArtifact({
              ...selected,
              version,
              projectionSha256,
              bytes,
              rendererVersion,
            }),
            201,
          );
        }
        if (path[2] === "save") {
          const input = await body(request, ["expectedRevision", "content", "internalNotes"]);
          return json(
            await repository.saveProposal({
              ...selected,
              expectedRevision: integer(input, "expectedRevision"),
              content: input.content,
              ...(input.internalNotes === undefined
                ? {}
                : { internalNotes: field(input, "internalNotes", true) }),
            }),
          );
        }
        if (path[2] === "submit") {
          const input = await body(request, ["expectedRevision"]);
          return json(
            await repository.submitProposal({
              ...selected,
              expectedRevision: integer(input, "expectedRevision"),
            }),
          );
        }
        if (path[2] === "review") {
          const input = await body(request, ["expectedRevision", "decision", "note"]);
          const decision = field(input, "decision");
          if (decision !== "approve" && decision !== "request_revision")
            throw new CommercialInputError();
          return json(
            await repository.reviewProposal({
              ...selected,
              expectedRevision: integer(input, "expectedRevision"),
              decision: decision === "request_revision" ? "request_changes" : "approve",
              reason: field(input, "note", true),
            }),
          );
        }
        if (path[2] === "revise") {
          const input = await body(request, ["expectedRevision", "note"]);
          return json(
            await repository.reviseProposal({
              ...selected,
              expectedRevision: integer(input, "expectedRevision"),
              reason: field(input, "note", true),
            }),
          );
        }
        if (path[2] === "outcome") {
          const input = await body(request, [
            "expectedRevision",
            "outcome",
            "reason",
            "reasonCode",
            "note",
            "award",
            "idempotencyKey",
          ]);
          const outcome = field(input, "outcome");
          if (!["awarded", "lost", "withdrawn"].includes(outcome)) throw new CommercialInputError();
          const award = awardInput(input.award);
          const reasonCode = optionalString(input, "reasonCode");
          if (
            reasonCode !== undefined &&
            !["price", "competitor", "timing", "scope_changed", "no_response", "other"].includes(
              reasonCode,
            )
          )
            throw new CommercialInputError();
          return json(
            await repository.recordOutcome({
              ...selected,
              expectedRevision: integer(input, "expectedRevision"),
              outcome: outcome as "awarded" | "lost" | "withdrawn",
              reason: field(input, "reason", true),
              ...(reasonCode === undefined
                ? {}
                : { reasonCode: reasonCode as CplCommercialLostReason }),
              ...(input.note === undefined ? {} : { note: field(input, "note", true) }),
              ...(award === undefined ? {} : { award }),
              idempotencyKey: field(input, "idempotencyKey"),
            }),
          );
        }
        if (path[2] === "project") {
          const input = await body(request, ["idempotencyKey"]);
          return json(
            await repository.createProject({
              ...selected,
              idempotencyKey: field(input, "idempotencyKey"),
            }),
            201,
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
