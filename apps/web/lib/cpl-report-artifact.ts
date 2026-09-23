import "server-only";
import { createHash } from "node:crypto";
import type { SqlCplReportRepository, CplTenantRequest } from "@bea/database/hosted";
import type { CplEvidenceStorage } from "@bea/artifacts/cpl-evidence-store";
import type { CplApprovedReportPdf } from "@bea/artifacts/cpl-report-pdf";

type ApprovalRequest = CplTenantRequest & {
  projectId: string;
  reportId: string;
  expectedRevision: number;
  idempotencyKey: string;
};

/** Rendering and durable I/O happen outside the SQL transaction. The repository
 * rechecks authorization, the reviewer version, and frozen source proofs at the
 * final write. A failed render/storage write leaves the report in review. */
export async function approveCplReport(
  repository: SqlCplReportRepository,
  input: ApprovalRequest,
  storage: CplEvidenceStorage,
) {
  const prepared = await repository.prepareApproval(input);
  if (prepared.status === "completed") {
    await storage.getVerified(prepared.artifact.reference);
    return prepared.artifact;
  }
  const photos = new Map<string, Uint8Array>();
  for (const photo of prepared.photoReferences) {
    if (photo.reference.organizationId !== input.organizationId)
      throw new Error("CPL_REPORT_SOURCE_REFERENCE_INVALID");
    photos.set(photo.photoId, await storage.getVerified(photo.reference));
  }
  const projection: CplApprovedReportPdf = {
    ...prepared.projection,
    visits: prepared.projection.visits.map((visit) => ({
      ...visit,
      observations: visit.observations.map((observation) => ({
        ...observation,
        photos: observation.photos.map((photo) => {
          const bytes = photos.get(photo.photoId);
          if (!bytes || createHash("sha256").update(bytes).digest("hex") !== photo.sha256)
            throw new Error("CPL_REPORT_SOURCE_REFERENCE_INVALID");
          return { ...photo, bytes };
        }),
      })),
    })),
  };
  const { renderCplReportPdf, CPL_REPORT_PDF_RENDERER_VERSION } =
    await import("@bea/artifacts/cpl-report-pdf");
  const bytes = await renderCplReportPdf(projection);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await storage.putImmutable({
    organizationId: input.organizationId,
    objectId: prepared.artifactObjectId,
    sha256,
    bytes,
  });
  return repository.completeApproval({
    sessionToken: input.sessionToken,
    organizationId: input.organizationId,
    projectId: input.projectId,
    reportId: input.reportId,
    attemptId: prepared.attemptId,
    sha256,
    byteLength: bytes.byteLength,
    rendererVersion: CPL_REPORT_PDF_RENDERER_VERSION,
    idempotencyKey: `report-final-${prepared.attemptId}`,
  });
}
