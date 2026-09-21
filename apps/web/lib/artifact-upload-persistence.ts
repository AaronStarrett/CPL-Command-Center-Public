import type { ArtifactManifest, StoredArtifactFile } from "@bea/artifacts";
import {
  SqlAiProviderRepository,
  SqlFoundationRepository,
  SqlPhase1Repository,
  type DatabaseAdapter,
  type SqlExecutor,
} from "@bea/database";
import type { JsonObject } from "@bea/domain";
import { PERMISSIONS } from "@bea/security";

function jsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function transactionalAdapter(database: DatabaseAdapter, executor: SqlExecutor): DatabaseAdapter {
  return {
    kind: database.kind,
    close: () => database.close(),
    execute: (sql) => executor.execute(sql),
    health: () => database.health(),
    query: (sql, parameters) => executor.query(sql, parameters),
    transaction: (operation) => operation(executor),
  };
}

export interface PersistUploadedArtifactInput {
  readonly artifact: StoredArtifactFile;
  readonly conversationId: string;
  readonly correlationId: string;
  readonly database: DatabaseAdapter;
  readonly manifest: ArtifactManifest;
  readonly ownerId: string;
}

export interface PersistUploadedArtifactResult {
  readonly generatedArtifactId: string;
  readonly workspaceArtifactId: string;
}

export async function persistUploadedArtifact(
  input: PersistUploadedArtifactInput,
): Promise<PersistUploadedArtifactResult> {
  return input.database.transaction(async (executor) => {
    const database = transactionalAdapter(input.database, executor);
    const persistence = new SqlAiProviderRepository(database);
    const phase1 = new SqlPhase1Repository(database);
    const repository = new SqlFoundationRepository(database);
    const previewable = new Set([
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/webp",
      "text/csv",
      "text/plain",
    ]).has(input.artifact.mimeType);
    const kind =
      input.artifact.mimeType === "application/pdf"
        ? "pdf"
        : input.artifact.mimeType.startsWith("image/")
          ? "image"
          : input.artifact.mimeType.includes("spreadsheet") ||
              input.artifact.mimeType === "text/csv"
            ? "data_file"
            : "text_document";
    const generatedArtifactId = await persistence.recordGeneratedArtifact({
      conversationId: input.conversationId,
      responseRunId: null,
      requestedByUserId: input.ownerId,
      kind,
      title: input.artifact.filename,
      status: "ready",
      artifactVersion: 1,
      provider: "application",
      providerItemId: null,
      providerContainerId: null,
      providerFileId: null,
      filename: input.artifact.filename,
      mediaType: input.artifact.mimeType,
      storageReference: input.artifact.id,
      specification: jsonObject(input.manifest),
      sourceMetadata: {
        dataStatus: "real",
        origin: "restricted_upload",
      },
      citationIds: [],
      fileMetadata: {
        artifactFileId: input.artifact.id,
        createdAt: input.artifact.createdAt,
        expiresAt: input.artifact.expiresAt,
        sha256: input.artifact.sha256,
        size: input.artifact.size,
        scanEngine: input.artifact.malwareScan?.engine ?? "unknown",
        scanMode: input.artifact.malwareScan?.mode ?? "unknown",
      },
      renderMetadata: jsonObject({ previewable, renderer: input.manifest.renderer }),
      generationMetadata: {
        applicationGenerated: false,
        mode: "restricted_upload",
        providerNeutral: true,
      },
      requiredPermissions: [PERMISSIONS.DOCUMENTS_VIEW],
      simulated: input.artifact.malwareScan?.mode === "simulated",
      errorCode: null,
    });
    const workspaceArtifact = await phase1.createWorkspaceArtifact({
      conversationId: input.conversationId,
      requestedByUserId: input.ownerId,
      type: "empty",
      title: input.artifact.filename,
      subtitle: "Restricted owner upload · ready for AI Command",
      state: "ready",
      payload: jsonObject(input.manifest),
      sources: [],
      links: [],
      requiredPermissions: [PERMISSIONS.DOCUMENTS_VIEW, PERMISSIONS.AI_COMMAND_VIEW],
    });
    await repository.record({
      eventType: "artifact.persisted",
      action: "artifact.upload.persist",
      outcome: "succeeded",
      actorUserId: input.ownerId,
      resourceType: "generated-artifact",
      resourceId: generatedArtifactId,
      correlationId: input.correlationId,
      metadata: {
        artifactFileId: input.artifact.id,
        conversationId: input.conversationId,
      },
    });
    return { generatedArtifactId, workspaceArtifactId: workspaceArtifact.id };
  });
}
