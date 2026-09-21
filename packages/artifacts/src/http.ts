import {
  ArtifactStoreError,
  ArtifactValidationError,
  type ArtifactWebAuditEvent,
  type ArtifactWebAuditSink,
  type ArtifactWebAuthorization,
  type ArtifactWebPermission,
  type ValidatedArtifactUpload,
} from "./contracts.js";
import type { RepositoryArtifactFileStore } from "./store.js";

const previewMimeTypes = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/csv",
  "text/plain",
]);

function safeDispositionFilename(filename: string): string {
  const ascii = filename.replace(/[^\u0020-\u007e]/gu, "_").replace(/["\\]/gu, "_");
  const fallback = ascii.length > 0 ? ascii : "artifact";
  return `filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function baseHeaders(input: {
  readonly disposition: "attachment" | "inline";
  readonly filename: string;
  readonly mimeType: string;
  readonly sha256: string;
  readonly size: number;
}): Headers {
  return new Headers({
    "cache-control": "private, no-store, max-age=0",
    "content-disposition": `${input.disposition}; ${safeDispositionFilename(input.filename)}`,
    "content-length": String(input.size),
    "content-security-policy": "default-src 'none'; sandbox",
    "content-type": input.mimeType,
    etag: `"sha256-${input.sha256}"`,
    pragma: "no-cache",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
}

function safeFailure(error: unknown): Response {
  const notFound = error instanceof ArtifactStoreError && error.code === "ARTIFACT_NOT_FOUND";
  const invalid = error instanceof ArtifactValidationError;
  return Response.json(
    {
      error: {
        code: notFound
          ? "ARTIFACT_NOT_FOUND"
          : invalid
            ? "ARTIFACT_UPLOAD_REJECTED"
            : "ARTIFACT_UNAVAILABLE",
        message: notFound
          ? "Artifact was not found."
          : invalid
            ? "Artifact upload was rejected."
            : "Artifact is unavailable.",
      },
      ok: false,
    },
    {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
      status: notFound ? 404 : invalid ? 400 : 500,
    },
  );
}

interface ArtifactWebRequestBase {
  readonly audit: ArtifactWebAuditSink;
  readonly authorization: ArtifactWebAuthorization;
}

function auditEvent(
  input: ArtifactWebRequestBase,
  action: ArtifactWebAuditEvent["action"],
  outcome: ArtifactWebAuditEvent["outcome"],
  artifactId?: string,
): ArtifactWebAuditEvent {
  return {
    action,
    actorId: input.authorization.actorId,
    ...(artifactId === undefined ? {} : { artifactId }),
    correlationId: input.authorization.correlationId,
    outcome,
    ownerId: input.authorization.ownerId,
  };
}

async function authorize(
  input: ArtifactWebRequestBase,
  action: ArtifactWebAuditEvent["action"],
  permission: ArtifactWebPermission,
  artifactId?: string,
): Promise<boolean> {
  const allowed =
    input.authorization.actorId === input.authorization.ownerId &&
    input.authorization.permissions.includes(permission);
  if (!allowed) {
    await input.audit.record(auditEvent(input, action, "denied", artifactId));
  }
  return allowed;
}

async function recordUnavailable(
  input: ArtifactWebRequestBase,
  action: ArtifactWebAuditEvent["action"],
  artifactId?: string,
): Promise<void> {
  await input.audit.record(auditEvent(input, action, "unavailable", artifactId));
}

function notFoundResponse(): Response {
  return safeFailure(new ArtifactStoreError("ARTIFACT_NOT_FOUND", "Artifact was not found."));
}

export async function createArtifactPreviewResponse(
  store: RepositoryArtifactFileStore,
  input: ArtifactWebRequestBase & { readonly artifactId: string },
): Promise<Response> {
  try {
    if (!(await authorize(input, "preview", "artifacts:read", input.artifactId))) {
      return notFoundResponse();
    }
  } catch (error) {
    return safeFailure(error);
  }
  try {
    const artifact = await store.get(input.authorization.ownerId, input.artifactId);
    try {
      await input.audit.record(auditEvent(input, "preview", "allowed", input.artifactId));
    } catch (error) {
      return safeFailure(error);
    }
    if (!previewMimeTypes.has(artifact.metadata.mimeType)) {
      return Response.json(
        {
          error: {
            code: "ARTIFACT_PREVIEW_UNSUPPORTED",
            message: "This artifact type must be downloaded.",
          },
          ok: false,
        },
        {
          headers: {
            "cache-control": "no-store",
            "content-type": "application/json; charset=utf-8",
            "x-content-type-options": "nosniff",
          },
          status: 415,
        },
      );
    }
    return new Response(Buffer.from(artifact.bytes), {
      headers: baseHeaders({ ...artifact.metadata, disposition: "inline" }),
      status: 200,
    });
  } catch (error) {
    try {
      await recordUnavailable(input, "preview", input.artifactId);
    } catch (auditError) {
      return safeFailure(auditError);
    }
    return safeFailure(error);
  }
}

export async function createArtifactDownloadResponse(
  store: RepositoryArtifactFileStore,
  input: ArtifactWebRequestBase & { readonly artifactId: string },
): Promise<Response> {
  try {
    if (!(await authorize(input, "download", "artifacts:download", input.artifactId))) {
      return notFoundResponse();
    }
  } catch (error) {
    return safeFailure(error);
  }
  try {
    const artifact = await store.get(input.authorization.ownerId, input.artifactId);
    try {
      await input.audit.record(auditEvent(input, "download", "allowed", input.artifactId));
    } catch (error) {
      return safeFailure(error);
    }
    return new Response(Buffer.from(artifact.bytes), {
      headers: baseHeaders({ ...artifact.metadata, disposition: "attachment" }),
      status: 200,
    });
  } catch (error) {
    try {
      await recordUnavailable(input, "download", input.artifactId);
    } catch (auditError) {
      return safeFailure(auditError);
    }
    return safeFailure(error);
  }
}

export async function createArtifactRefreshResponse(
  store: RepositoryArtifactFileStore,
  input: ArtifactWebRequestBase & { readonly artifactId: string },
): Promise<Response> {
  try {
    if (!(await authorize(input, "refresh", "artifacts:read", input.artifactId))) {
      return notFoundResponse();
    }
  } catch (error) {
    return safeFailure(error);
  }
  try {
    const artifact = await store.get(input.authorization.ownerId, input.artifactId);
    try {
      await input.audit.record(auditEvent(input, "refresh", "allowed", input.artifactId));
    } catch (error) {
      return safeFailure(error);
    }
    return Response.json(
      { artifact: artifact.metadata, ok: true },
      {
        headers: {
          "cache-control": "private, no-store, max-age=0",
          "content-type": "application/json; charset=utf-8",
          etag: `"sha256-${artifact.metadata.sha256}"`,
          "x-content-type-options": "nosniff",
        },
        status: 200,
      },
    );
  } catch (error) {
    try {
      await recordUnavailable(input, "refresh", input.artifactId);
    } catch (auditError) {
      return safeFailure(auditError);
    }
    return safeFailure(error);
  }
}

export async function createValidatedArtifactUploadResponse(
  store: RepositoryArtifactFileStore,
  input: ArtifactWebRequestBase & {
    readonly retentionMilliseconds?: number;
    readonly upload: ValidatedArtifactUpload;
  },
): Promise<Response> {
  try {
    if (!(await authorize(input, "upload", "artifacts:write"))) {
      return notFoundResponse();
    }
  } catch (error) {
    return safeFailure(error);
  }
  try {
    const metadata = await store.putValidatedUpload(
      input.authorization.ownerId,
      input.upload,
      input.retentionMilliseconds === undefined
        ? {}
        : { retentionMilliseconds: input.retentionMilliseconds },
    );
    try {
      await input.audit.record(auditEvent(input, "upload", "allowed", metadata.id));
    } catch (error) {
      try {
        await store.delete(input.authorization.ownerId, metadata.id);
      } catch {
        // The response remains fail-closed; no storage details are exposed.
      }
      return safeFailure(error);
    }
    return Response.json(
      { artifact: metadata, ok: true },
      {
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
        status: 201,
      },
    );
  } catch (error) {
    try {
      await recordUnavailable(input, "upload");
    } catch (auditError) {
      return safeFailure(auditError);
    }
    return safeFailure(error);
  }
}
