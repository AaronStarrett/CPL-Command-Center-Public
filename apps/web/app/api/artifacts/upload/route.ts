import {
  ArtifactValidationError,
  createValidatedArtifactUploadResponse,
  type StoredArtifactFile,
  validateArtifactUploadWithScanner,
} from "@bea/artifacts";
import { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { requireArtifactApiContext, type ArtifactApiContext } from "@/lib/artifact-api";
import { finalizeArtifactRouteResponse } from "@/lib/artifact-route-contract";
import {
  parseArtifactUploadForm,
  validateArtifactUploadTransport,
} from "@/lib/artifact-upload-contract";
import { createUploadedArtifactManifest } from "@/lib/artifact-upload-manifest";
import { persistUploadedArtifact } from "@/lib/artifact-upload-persistence";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type SuccessfulArtifactApiContext = Extract<ArtifactApiContext, { readonly ok: true }>;

async function rejectedUpload(
  context: SuccessfulArtifactApiContext,
  input: { readonly code: string; readonly message: string; readonly status: number },
): Promise<Response> {
  try {
    await context.audit.record({
      action: "upload",
      actorId: context.authorization.actorId,
      correlationId: context.correlationId,
      outcome: "unavailable",
      ownerId: context.authorization.ownerId,
    });
  } catch {
    return finalizeArtifactRouteResponse(
      apiError(
        "artifact-audit-unavailable",
        "Artifact upload is unavailable.",
        500,
        context.correlationId,
      ),
      context.correlationId,
    );
  }
  return finalizeArtifactRouteResponse(
    apiError(input.code, input.message, input.status, context.correlationId),
    context.correlationId,
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  const context = await requireArtifactApiContext(request, {
    action: "upload",
    route: "/api/artifacts/upload",
  });
  if (!context.ok) return context.response;

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("multipart/form-data;")) {
    return rejectedUpload(context, {
      code: "artifact-upload-content-type-invalid",
      message: "Artifact upload requires multipart form data.",
      status: 415,
    });
  }
  const transport = validateArtifactUploadTransport(
    request.headers.get("content-length"),
    context.maxUploadBytes,
  );
  if (!transport.ok) {
    return rejectedUpload(context, {
      code:
        transport.reason === "too_large"
          ? "artifact-upload-too-large"
          : "artifact-upload-content-length-required",
      message:
        transport.reason === "too_large"
          ? "Artifact upload exceeds the allowed size."
          : "Artifact upload requires a valid bounded Content-Length.",
      status: transport.reason === "too_large" ? 413 : transport.reason === "missing" ? 411 : 400,
    });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return rejectedUpload(context, {
      code: "artifact-upload-invalid",
      message: "Artifact upload could not be parsed.",
      status: 400,
    });
  }
  const parsed = parseArtifactUploadForm(formData);
  if (!parsed) {
    return rejectedUpload(context, {
      code: "artifact-upload-invalid",
      message: "Exactly one artifact file and conversation association are required.",
      status: 400,
    });
  }
  const { file, conversationId } = parsed;
  if (
    !(await context.runtime.phase1.getConversation(conversationId, context.authorization.ownerId))
  ) {
    return rejectedUpload(context, {
      code: "artifact-not-found",
      message: "Artifact was not found.",
      status: 404,
    });
  }
  if (file.size < 1 || file.size > context.maxUploadBytes) {
    return rejectedUpload(context, {
      code: "artifact-upload-too-large",
      message: "Artifact upload exceeds the allowed size.",
      status: 413,
    });
  }

  try {
    const upload = await validateArtifactUploadWithScanner(
      {
        bytes: new Uint8Array(await file.arrayBuffer()),
        filename: file.name,
        mimeType: file.type,
      },
      context.scanner,
      { allowSimulatedClean: context.allowSimulatedClean },
    );
    const storedResponse = await createValidatedArtifactUploadResponse(context.store, {
      audit: context.audit,
      authorization: context.authorization,
      upload,
    });
    if (storedResponse.status !== 201) {
      return finalizeArtifactRouteResponse(storedResponse, context.correlationId);
    }
    const storedPayload = (await storedResponse.clone().json()) as {
      readonly artifact: StoredArtifactFile;
    };
    const artifact = storedPayload.artifact;
    const manifest = createUploadedArtifactManifest(artifact, context.authorization.ownerId);
    let generatedArtifactId: string;
    let workspaceArtifactId: string;
    try {
      ({ generatedArtifactId, workspaceArtifactId } = await persistUploadedArtifact({
        artifact,
        conversationId,
        correlationId: context.correlationId,
        database: context.runtime.database,
        manifest,
        ownerId: context.authorization.ownerId,
      }));
    } catch {
      let cleanupSucceeded = true;
      try {
        await context.store.delete(context.authorization.ownerId, artifact.id);
      } catch {
        cleanupSucceeded = false;
      }
      await context.runtime.repository.record({
        eventType: "artifact.persistence-failed",
        action: "artifact.upload.persist",
        outcome: "failed",
        actorUserId: context.authorization.ownerId,
        resourceType: "artifact",
        resourceId: null,
        correlationId: context.correlationId,
        metadata: { artifactFileId: artifact.id, cleanupSucceeded, conversationId },
      });
      return finalizeArtifactRouteResponse(
        apiError(
          "artifact-persistence-failed",
          "Artifact upload could not be completed.",
          500,
          context.correlationId,
        ),
        context.correlationId,
      );
    }
    return finalizeArtifactRouteResponse(
      Response.json(
        { artifact, conversationId, generatedArtifactId, manifest, ok: true, workspaceArtifactId },
        { headers: { "cache-control": "no-store" }, status: 201 },
      ),
      context.correlationId,
    );
  } catch (error) {
    const scanUnavailable =
      error instanceof ArtifactValidationError &&
      (error.code === "MALWARE_SCAN_UNAVAILABLE" || error.code === "MALWARE_SCAN_FAILED");
    const infected = error instanceof ArtifactValidationError && error.code === "MALWARE_DETECTED";
    return rejectedUpload(context, {
      code: scanUnavailable
        ? "artifact-malware-scan-unavailable"
        : infected
          ? "artifact-upload-rejected"
          : "artifact-upload-invalid",
      message: scanUnavailable
        ? "Artifact upload is unavailable until malware scanning succeeds."
        : "Artifact upload was rejected.",
      status: scanUnavailable ? 503 : infected ? 422 : 400,
    });
  }
}
