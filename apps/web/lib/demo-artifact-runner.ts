import "server-only";

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  BEA_PDF_PALETTE,
  DEMO_ARTIFACT_GENERATED_AT,
  DEMO_ARTIFACT_TOOL_DEFINITION,
  DemoArtifactApplicationRunner,
  RepositoryArtifactFileStore,
  normalizeArtifactManifest,
  type DemoArtifactGenerationBundle,
  type DemoArtifactGenerationPersistence,
  type DemoArtifactRunnerAuditSink,
  type DemoArtifactUsageSink,
} from "@bea/artifacts";
import type { BeaServerRuntime, RecordGeneratedArtifactInput } from "@bea/database";
import {
  DEFAULT_ASSISTANT_POLICY_PROVENANCE,
  type AssistantPolicyProvenance,
  type JsonObject,
} from "@bea/domain";

import {
  effectiveArtifactRetentionMilliseconds,
  effectiveGeneratedArtifactBytes,
} from "./artifact-settings";

function jsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

class ServerGeneratedArtifactPersistence implements DemoArtifactGenerationPersistence {
  constructor(
    private readonly runtime: BeaServerRuntime,
    private readonly policyProvenance: AssistantPolicyProvenance,
  ) {}

  async persist(bundle: DemoArtifactGenerationBundle) {
    const sourceMetadata = jsonObject({
      citations: bundle.pdf.citations,
      dataStatus: "synthetic",
      sourceBoardArtifactId: bundle.sourceBoard.artifactId,
    });
    const generationMetadata = jsonObject({
      deterministic: true,
      inputMode: bundle.input.inputMode,
      providerNeutral: true,
      requestId: bundle.context.requestId,
      toolName: DEMO_ARTIFACT_TOOL_DEFINITION.name,
    });
    const shared = {
      conversationId: bundle.input.conversationId,
      responseRunId: bundle.context.responseRunId ?? null,
      requestedByUserId: bundle.context.ownerId,
      status: "ready",
      artifactVersion: 1,
      provider: "demo",
      providerItemId: null,
      providerContainerId: null,
      providerFileId: null,
      citationIds: [],
      generationMetadata,
      requiredPermissions: ["documents.view", "ai-command.view"],
      simulated: true,
      errorCode: null,
      sourceMetadata,
      policyProvenance: this.policyProvenance,
    } as const;
    const records: readonly RecordGeneratedArtifactInput[] = [
      {
        ...shared,
        kind: "source_board",
        title: bundle.sourceBoard.title,
        filename: null,
        mediaType: null,
        storageReference: null,
        specification: jsonObject({ manifest: bundle.sourceBoard, schemaVersion: 1 }),
        fileMetadata: {},
        renderMetadata: jsonObject({ renderer: bundle.sourceBoard.renderer }),
      },
      {
        ...shared,
        kind: "chart",
        title: bundle.comparisonChart.title,
        filename: null,
        mediaType: null,
        storageReference: null,
        specification: jsonObject({ manifest: bundle.comparisonChart, schemaVersion: 1 }),
        fileMetadata: {},
        renderMetadata: jsonObject({
          chartType: bundle.comparisonChart.chart.type,
          renderer: bundle.comparisonChart.renderer,
        }),
      },
      {
        ...shared,
        kind: "table",
        title: bundle.table.title,
        filename: null,
        mediaType: null,
        storageReference: null,
        specification: jsonObject({ manifest: bundle.table, schemaVersion: 1 }),
        fileMetadata: {},
        renderMetadata: jsonObject({ renderer: bundle.table.renderer }),
      },
      {
        ...shared,
        kind: "image",
        title: bundle.image.title,
        filename: bundle.imageFile.filename,
        mediaType: bundle.imageFile.mimeType,
        storageReference: bundle.imageFile.id,
        specification: jsonObject({ manifest: bundle.image, schemaVersion: 1 }),
        fileMetadata: jsonObject({
          artifactFileId: bundle.imageFile.id,
          createdAt: bundle.imageFile.createdAt,
          expiresAt: bundle.imageFile.expiresAt,
          sha256: bundle.imageFile.sha256,
          size: bundle.imageFile.size,
        }),
        renderMetadata: jsonObject({
          label: "SIMULATED AI-GENERATED IMAGE",
          renderer: bundle.image.renderer,
        }),
      },
      {
        ...shared,
        kind: "pdf",
        title: bundle.pdf.title,
        filename: bundle.file.filename,
        mediaType: bundle.file.mimeType,
        storageReference: bundle.file.id,
        specification: jsonObject({
          manifest: bundle.pdf,
          pdfManifest: bundle.pdf,
          schemaVersion: 1,
        }),
        fileMetadata: jsonObject({
          artifactFileId: bundle.file.id,
          createdAt: bundle.file.createdAt,
          expiresAt: bundle.file.expiresAt,
          sha256: bundle.file.sha256,
          size: bundle.file.size,
          imageArtifactFileId: bundle.imageFile.id,
        }),
        renderMetadata: jsonObject({
          palette: BEA_PDF_PALETTE,
          renderer: bundle.pdf.renderer,
        }),
      },
    ];
    const generatedArtifactIds =
      await this.runtime.ai.persistence.recordGeneratedArtifacts(records);
    const generatedArtifactId = generatedArtifactIds.at(-1);
    if (!generatedArtifactId || generatedArtifactIds.length !== records.length) {
      throw new Error("Generated artifact persistence returned an incomplete batch.");
    }
    return { generatedArtifactId };
  }

  async reopen(ownerId: string, artifactFileId: string) {
    const persisted = await this.runtime.ai.persistence.getGeneratedArtifactByStorageReference(
      artifactFileId,
      ownerId,
    );
    if (!persisted || persisted.status !== "ready") return null;
    const candidate = persisted.specification.pdfManifest ?? persisted.specification.manifest;
    const manifest = normalizeArtifactManifest(candidate);
    if (manifest.renderer !== "pdf" || manifest.file.id !== artifactFileId) return null;
    return { generatedArtifactId: persisted.id, manifest };
  }
}

function runnerAuditSink(runtime: BeaServerRuntime): DemoArtifactRunnerAuditSink {
  return {
    async record(event) {
      await runtime.repository.record({
        eventType:
          event.action === "demo-artifact.reopen" ? "artifact.reopened" : "artifact.generation",
        action: event.action,
        outcome: event.outcome,
        actorUserId: event.ownerId,
        resourceType: event.generatedArtifactId ? "generated-artifact" : "artifact",
        resourceId: event.generatedArtifactId ?? null,
        correlationId: event.correlationId,
        metadata: {
          ...(event.artifactFileId === undefined ? {} : { artifactFileId: event.artifactFileId }),
          ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
          ...(event.inputMode === undefined ? {} : { inputMode: event.inputMode }),
        },
      });
    },
  };
}

function runnerUsageSink(runtime: BeaServerRuntime): DemoArtifactUsageSink {
  return {
    async record(event) {
      await runtime.ai.persistence.recordUsage({
        responseRunId: event.responseRunId ?? null,
        realtimeSessionId: null,
        requestedByUserId: event.ownerId,
        provider: "demo",
        model: "bea-deterministic-artifact-v1",
        operation: event.operation,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        audioInputTokens: 0,
        audioOutputTokens: 0,
        realtimeDurationSeconds: 0,
        estimatedCostUsd: "0.000000",
        costStatus: "estimated",
        simulated: true,
        recordedAt: DEMO_ARTIFACT_GENERATED_AT,
      });
      await runtime.repository.record({
        eventType: "artifact.usage",
        action: event.operation,
        outcome: "succeeded",
        actorUserId: event.ownerId,
        resourceType: "artifact",
        resourceId: null,
        correlationId: event.correlationId,
        metadata: {
          citationCount: event.citationCount,
          inputCharacters: event.inputCharacters,
          inputMode: event.inputMode,
          outputBytes: event.outputBytes,
          simulated: event.simulated,
        },
      });
    },
  };
}

export async function createDemoArtifactApplicationRunner(
  runtime: BeaServerRuntime,
  policyProvenance: AssistantPolicyProvenance = DEFAULT_ASSISTANT_POLICY_PROVENANCE,
): Promise<DemoArtifactApplicationRunner> {
  if (runtime.environment.runtimeMode === "production") {
    throw new Error("Test-only artifact fixtures are unavailable in production.");
  }
  const [logoBytes, settings] = await Promise.all([
    readFile(join(runtime.repositoryRoot, "apps", "web", "public", "brand", "cpl-logo.png")),
    runtime.ai.persistence.getProviderSettings(),
  ]);
  const retentionMilliseconds = effectiveArtifactRetentionMilliseconds(
    settings.artifactRetentionDays,
  );
  const maxGeneratedFileBytes = effectiveGeneratedArtifactBytes(settings.maxGeneratedFileBytes);
  return new DemoArtifactApplicationRunner({
    audit: runnerAuditSink(runtime),
    authorization: {
      async authorize(request) {
        if (request.action === "generate") {
          const [conversation, documents, run] = await Promise.all([
            runtime.phase1.getConversation(request.conversationId, request.ownerId),
            runtime.authorization.authorizeUser(request.ownerId, "documents.view"),
            runtime.authorization.authorizeUser(request.ownerId, "ai-command.run"),
          ]);
          return conversation !== null && documents.allowed && run.allowed;
        }
        const [persisted, documents] = await Promise.all([
          runtime.ai.persistence.getGeneratedArtifactByStorageReference(
            request.artifactFileId,
            request.ownerId,
          ),
          runtime.authorization.authorizeUser(request.ownerId, "documents.view"),
        ]);
        return persisted !== null && documents.allowed;
      },
    },
    fileStore: new RepositoryArtifactFileStore({
      repositoryRoot: runtime.repositoryRoot,
      retentionMilliseconds,
    }),
    maxGeneratedFileBytes,
    pdf: { logoBytes },
    persistence: new ServerGeneratedArtifactPersistence(runtime, policyProvenance),
    usage: runnerUsageSink(runtime),
  });
}
