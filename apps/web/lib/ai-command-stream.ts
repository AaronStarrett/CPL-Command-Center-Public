import "server-only";

import { createHash } from "node:crypto";

import {
  normalizeArtifactManifest,
  RepositoryArtifactFileStore,
  type ArtifactManifest,
  type StoredArtifactFile,
} from "@bea/artifacts";
import {
  BEA_GENERATED_ARTIFACT_TOOLS,
  findRegisteredArtifactTool,
  inferAiWorkloadRoute,
  routeDemoCommand,
  selectAiRoute,
  validateRegisteredArtifactToolCall,
  buildResearchPresentation,
  parseSafeWorkspaceSelection,
  researchWorkspacePayload,
  researchWorkspaceSubtitle,
  isFollowUpAboutSelection,
  webSearchToolSucceeded,
  PHASE21_LIMITS,
  buildSelectedEvidenceContext,
  selectedEvidenceInstructions,
  authorizeWorkspaceSelection,
  presentationPacketFromStoredRun,
  type AiBuiltInToolRequest,
  type AiCommandProvider,
  type AiConversationResult,
  type AiGeneratedArtifactContentProvider,
  type AiGeneratedArtifactReference,
  type AiInputFileReference,
  type AiModelMetadata,
  type AiResponseStreamEvent,
  type AiToolCall,
} from "@bea/ai";
import { Phase1OwnershipError, type BeaServerRuntime } from "@bea/database";
import type {
  AiRouteDecisionProvenance,
  AssistantPolicyProvenance,
  GeneratedArtifactRecord,
  JsonObject,
} from "@bea/domain";
import { PERMISSIONS, requireCredentialSafeContent, type Permission } from "@bea/security";

import {
  normalizeAiCommandRequestGeneration,
  normalizeAiCommandRequestId,
  persistPresentationPacketWithRuntime,
  processAiCommandMessageWithRuntime,
} from "./ai-command";
import { getAssistantPolicyContext } from "./assistant-policy";
import { createDemoArtifactApplicationRunner } from "./demo-artifact-runner";
import { generateExecutivePdfArtifact, type ExecutivePdfRequest } from "./executive-artifact";
import { effectiveArtifactRetentionMilliseconds } from "./artifact-settings";
import {
  authorizeLiveOwnerTools,
  isDeterministicDemoAiCommandAllowed,
  OpenAiAdministrationError,
  requireLiveOwnerAuthorization,
  resolveAiCommandProvider,
} from "./openai-administration";

export interface StreamAiCommandInput {
  readonly runtime: BeaServerRuntime;
  readonly userId: string;
  readonly conversationId: string;
  readonly message: string;
  readonly requestId: string;
  readonly generation: number;
  readonly correlationId: string;
  readonly webSearch: boolean;
  readonly builtInTools: readonly ("web_search" | "code_interpreter" | "image_generation")[];
  readonly confirmHighCostTools: boolean;
  readonly inputMode: "text" | "simulated_voice" | "live_voice";
  readonly inputArtifactIds: readonly string[];
  readonly liveVoiceWebSearchAuthorization?: unknown;
  readonly workspaceSelection?: unknown;
  readonly signal?: AbortSignal;
}

class LiveVoiceWebSearchAuthorization {
  #consumed = false;

  private constructor(
    readonly userId: string,
    readonly conversationId: string,
    readonly expiresAt: number,
  ) {}

  static async issue(input: {
    readonly runtime: BeaServerRuntime;
    readonly userId: string;
    readonly conversationId: string;
    readonly correlationId: string;
  }): Promise<LiveVoiceWebSearchAuthorization> {
    for (const permission of [
      PERMISSIONS.AI_COMMAND_RUN,
      PERMISSIONS.SEARCH_VIEW,
      PERMISSIONS.INTEGRATIONS_MANAGE,
      PERMISSIONS.SETTINGS_MANAGE,
    ] as const) {
      await input.runtime.authorization.requireUser({
        userId: input.userId,
        permission,
        action: "ai-command.realtime.search-web",
        resourceType: "conversation",
        resourceId: input.conversationId,
        correlationId: input.correlationId,
      });
    }
    const [conversation, provider, settings] = await Promise.all([
      input.runtime.phase1.getConversation(input.conversationId, input.userId),
      resolveAiCommandProvider(input.runtime),
      input.runtime.ai.persistence.getProviderSettings(),
    ]);
    if (!conversation || provider.providerKey !== "openai" || !settings.webSearchAllowed) {
      throw new OpenAiAdministrationError(
        "REALTIME_WEB_SEARCH_NOT_AUTHORIZED",
        403,
        "Live voice web search is not authorized by the current provider policy.",
      );
    }
    return new LiveVoiceWebSearchAuthorization(
      input.userId,
      input.conversationId,
      Date.now() + 30_000,
    );
  }

  consume(input: StreamAiCommandInput): boolean {
    if (
      this.#consumed ||
      Date.now() > this.expiresAt ||
      input.userId !== this.userId ||
      input.conversationId !== this.conversationId ||
      input.inputMode !== "live_voice" ||
      !input.webSearch ||
      input.builtInTools.length !== 1 ||
      input.builtInTools[0] !== "web_search"
    ) {
      return false;
    }
    this.#consumed = true;
    return true;
  }
}

export async function authorizeLiveVoiceWebSearch(input: {
  readonly runtime: BeaServerRuntime;
  readonly userId: string;
  readonly conversationId: string;
  readonly correlationId: string;
}): Promise<unknown> {
  return LiveVoiceWebSearchAuthorization.issue(input);
}

export function compactAiCommandCompletionResult(
  result: AiConversationResult,
): AiConversationResult {
  return {
    ...result,
    citations: [],
    webSources: [],
    fileSources: [],
    toolCalls: [],
    generatedArtifacts: [],
  };
}

export function shouldUseInternalDemoRouter(
  internalIntent: ReturnType<typeof routeDemoCommand>,
  inputArtifactIds: readonly string[],
): boolean {
  return internalIntent.type !== "unsupported" && inputArtifactIds.length === 0;
}

async function prepareAuthorizedInputFiles(input: {
  readonly runtime: BeaServerRuntime;
  readonly userId: string;
  readonly conversationId: string;
  readonly inputArtifactIds: readonly string[];
  readonly provider: AiCommandProvider;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<readonly AiInputFileReference[]> {
  if (input.inputArtifactIds.length === 0) return [];
  if (input.provider.providerKey === "openai") {
    const authorization = await authorizeLiveOwnerTools({
      runtime: input.runtime,
      actorUserId: input.userId,
      correlationId: `input-file:${input.conversationId}`,
      capabilities: ["input_file"],
    });
    requireLiveOwnerAuthorization(input.provider.providerKey, "input_file", authorization);
  }
  const [documentsPermission, settings] = await Promise.all([
    input.runtime.authorization.authorizeUser(input.userId, PERMISSIONS.DOCUMENTS_VIEW),
    input.runtime.ai.persistence.getProviderSettings(),
  ]);
  if (!documentsPermission.allowed) {
    throw new OpenAiAdministrationError(
      "INPUT_ARTIFACT_PERMISSION_REQUIRED",
      403,
      "Document permission is required to attach an artifact.",
    );
  }
  const store = new RepositoryArtifactFileStore({
    repositoryRoot: input.runtime.repositoryRoot,
    retentionMilliseconds: effectiveArtifactRetentionMilliseconds(settings.artifactRetentionDays),
  });
  const references: AiInputFileReference[] = [];
  for (const artifactFileId of input.inputArtifactIds) {
    const persisted = await input.runtime.ai.persistence.getGeneratedArtifactByStorageReference(
      artifactFileId,
      input.userId,
    );
    if (
      !persisted ||
      persisted.conversationId !== input.conversationId ||
      persisted.status !== "ready" ||
      persisted.storageReference !== artifactFileId
    ) {
      throw new OpenAiAdministrationError(
        "INPUT_ARTIFACT_NOT_FOUND",
        404,
        "An attached artifact was not found.",
      );
    }
    let content;
    try {
      content = await store.get(input.userId, artifactFileId);
    } catch {
      throw new OpenAiAdministrationError(
        "INPUT_ARTIFACT_NOT_FOUND",
        404,
        "An attached artifact was not found.",
      );
    }
    const scan = content.metadata.malwareScan;
    const scanAccepted =
      scan?.status === "clean" &&
      (input.provider.providerKey === "demo" ? true : scan.mode === "connected");
    if (!scanAccepted) {
      throw new OpenAiAdministrationError(
        "INPUT_ARTIFACT_SCAN_REQUIRED",
        409,
        "The attached artifact does not have an acceptable malware-scan result for this provider.",
      );
    }
    if (content.bytes.byteLength > settings.maxUploadBytes) {
      throw new OpenAiAdministrationError(
        "INPUT_ARTIFACT_TOO_LARGE",
        413,
        "The attached artifact exceeds the configured upload limit.",
      );
    }
    const reference = await input.provider.uploadInputFile(
      {
        ownerId: input.userId,
        artifactId: artifactFileId,
        filename: content.metadata.filename,
        mimeType: content.metadata.mimeType,
        bytes: content.bytes,
        detail: content.metadata.mimeType === "application/pdf" ? "auto" : undefined,
      },
      {
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        timeoutMs: input.timeoutMs,
      },
    );
    references.push(reference);
    await input.runtime.repository.record({
      eventType: "ai-provider.input-artifact-authorized",
      action: "ai-command.input-artifact",
      outcome: "succeeded",
      actorUserId: input.userId,
      resourceType: "generated-artifact",
      resourceId: persisted.id,
      metadata: {
        artifactFileId,
        conversationId: input.conversationId,
        provider: input.provider.providerKey,
        scanMode: scan.mode,
      },
    });
  }
  return references;
}

const knownPermissions = new Set<string>(Object.values(PERMISSIONS));
const demoArtifactToolNames = new Set([
  "bea_research",
  "bea_analyze",
  "bea_create_chart",
  "bea_create_table",
  "bea_create_board",
  "bea_create_pdf",
  "bea_create_image",
]);

interface PreparedWorkspaceArtifact {
  readonly manifest: ArtifactManifest;
  readonly requiredPermissions: readonly string[];
  readonly executedToolCallId?: string;
  readonly workspacePayload?: JsonObject;
}

interface PreparedProviderGeneratedArtifact {
  readonly reference: AiGeneratedArtifactReference;
  readonly stored: StoredArtifactFile | null;
  readonly manifest: ArtifactManifest | null;
  readonly errorCode: string | null;
}

function jsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function sourceBoardForResult(input: {
  readonly result: AiConversationResult;
  readonly ownerId: string;
  readonly conversationId: string;
}): ArtifactManifest | null {
  const byUrl = new Map<
    string,
    { accessedAt: string; domain: string; title: string; url: string }
  >();
  for (const source of input.result.webSources) {
    byUrl.set(source.url, {
      accessedAt: source.retrievedAt,
      domain: source.domain,
      title: source.title,
      url: source.url,
    });
  }
  for (const citation of input.result.citations) {
    if (!byUrl.has(citation.url)) {
      byUrl.set(citation.url, {
        accessedAt: citation.retrievedAt,
        domain: citation.domain,
        title: citation.title,
        url: citation.url,
      });
    }
  }
  const sources = [...byUrl.values()];
  const fileSources = (input.result.fileSources ?? []).slice(0, 50);
  if (sources.length === 0 && fileSources.length === 0) return null;
  const artifactId = `art_${createHash("sha256")
    .update(input.ownerId)
    .update("\0")
    .update(input.conversationId)
    .update("\0")
    .update(input.result.responseId)
    .digest("hex")
    .slice(0, 32)}`;
  if (fileSources.length > 0) {
    return normalizeArtifactManifest({
      artifactId,
      citations: sources,
      createdAt: input.result.completedAt,
      disclosure:
        "OpenAI File Search evidence from administrator-approved vector stores. Confirm the cited file context before relying on the result.",
      ownerId: input.ownerId,
      renderer: "analysis",
      schemaVersion: 1,
      sections: fileSources.map((source) => ({
        heading: source.filename,
        body: [
          source.excerpt?.trim() || "The provider returned this file as relevant evidence.",
          source.score === undefined
            ? "Relevance score: not supplied."
            : `Relevance score: ${(source.score * 100).toFixed(1)}%.`,
          `Retrieved: ${source.retrievedAt}.`,
        ].join("\n\n"),
      })),
      summary: `${fileSources.length} organizational file source${fileSources.length === 1 ? "" : "s"}${
        sources.length > 0
          ? ` and ${sources.length} verified HTTPS source${sources.length === 1 ? "" : "s"}`
          : ""
      } returned by the provider.`,
      title: sources.length > 0 ? "AI research sources" : "Organizational file-search sources",
    });
  }
  return normalizeArtifactManifest({
    artifactId,
    citations: sources,
    createdAt: input.result.completedAt,
    disclosure: input.result.simulated
      ? "DEMO MODE - these are deterministic synthetic web-search sources."
      : "OpenAI web-search sources. Review each source before relying on the result.",
    ownerId: input.ownerId,
    renderer: "source-board",
    schemaVersion: 1,
    sources,
    summary: `${sources.length} verified HTTPS source${sources.length === 1 ? "" : "s"} returned by the provider.`,
    title: "AI research sources",
  });
}

function sourcePermissionsForResult(result: AiConversationResult): readonly Permission[] {
  return [
    PERMISSIONS.AI_COMMAND_VIEW,
    ...(result.webSources.length > 0 || result.citations.length > 0
      ? [PERMISSIONS.SEARCH_VIEW]
      : []),
    ...(result.fileSources?.length ? [PERMISSIONS.DOCUMENTS_VIEW] : []),
  ];
}

function orderedSourceLinks(result: AiConversationResult): readonly {
  readonly id: string;
  readonly title: string;
  readonly url: string;
}[] {
  const byUrl = new Map<string, { id: string; title: string; url: string }>();
  for (const source of [...result.webSources, ...result.citations]) {
    if (!byUrl.has(source.url)) {
      byUrl.set(source.url, { id: source.id, title: source.title, url: source.url });
    }
  }
  return [...byUrl.values()].slice(0, 30);
}

function generatedContentProvider(
  provider: AiCommandProvider,
): (AiCommandProvider & AiGeneratedArtifactContentProvider) | null {
  return "fetchGeneratedArtifactContent" in provider &&
    typeof provider.fetchGeneratedArtifactContent === "function"
    ? (provider as AiCommandProvider & AiGeneratedArtifactContentProvider)
    : null;
}

function storedFileReference(file: StoredArtifactFile) {
  return {
    filename: file.filename,
    id: file.id,
    mimeType: file.mimeType,
    sha256: file.sha256,
    size: file.size,
  };
}

function manifestForGeneratedContent(input: {
  readonly file: StoredArtifactFile;
  readonly ownerId: string;
  readonly result: AiConversationResult;
}): ArtifactManifest | null {
  const citations = input.result.citations.map((citation) => ({
    accessedAt: citation.retrievedAt,
    domain: citation.domain,
    title: citation.title,
    url: citation.url,
  }));
  const base = {
    artifactId: input.file.id,
    citations,
    createdAt: input.result.completedAt,
    disclosure:
      "OpenAI-generated content stored in the owner-scoped BEA artifact store. Review before use.",
    ownerId: input.ownerId,
    schemaVersion: 1 as const,
    summary: "Generated provider content was validated, stored locally, and is ready to reopen.",
    title: input.file.filename,
  };
  const file = storedFileReference(input.file);
  if (input.file.mimeType === "application/pdf") {
    return normalizeArtifactManifest({ ...base, file, renderer: "pdf" });
  }
  if (["image/png", "image/jpeg", "image/webp"].includes(input.file.mimeType)) {
    return normalizeArtifactManifest({
      ...base,
      altText: `Generated image: ${input.file.filename}`,
      file,
      renderer: "image",
    });
  }
  const extension = input.file.filename.split(".").at(-1)?.toLowerCase();
  const format =
    extension === "csv" || extension === "docx" || extension === "txt" || extension === "xlsx"
      ? extension
      : null;
  return format
    ? normalizeArtifactManifest({
        ...base,
        data: { file, format, recordCount: 0 },
        renderer: "data",
      })
    : null;
}

async function prepareProviderGeneratedArtifacts(input: {
  readonly runtime: BeaServerRuntime;
  readonly userId: string;
  readonly provider: AiCommandProvider;
  readonly result: AiConversationResult;
  readonly signal?: AbortSignal;
}): Promise<readonly PreparedProviderGeneratedArtifact[]> {
  if (input.provider.providerKey !== "openai" || input.result.generatedArtifacts.length === 0) {
    return [];
  }
  const contentProvider = generatedContentProvider(input.provider);
  if (!contentProvider) {
    return input.result.generatedArtifacts.map((reference) => ({
      reference,
      stored: null,
      manifest: null,
      errorCode: "GENERATED_CONTENT_PROVIDER_UNAVAILABLE",
    }));
  }
  const settings = await input.runtime.ai.persistence.getProviderSettings();
  const store = new RepositoryArtifactFileStore({
    repositoryRoot: input.runtime.repositoryRoot,
    retentionMilliseconds: effectiveArtifactRetentionMilliseconds(settings.artifactRetentionDays),
  });
  const prepared: PreparedProviderGeneratedArtifact[] = [];
  for (const reference of input.result.generatedArtifacts) {
    let storedForCleanup: StoredArtifactFile | null = null;
    try {
      const content = await contentProvider.fetchGeneratedArtifactContent(reference, {
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        timeoutMs: settings.requestTimeoutMs,
      });
      if (!content || content.bytes.byteLength > settings.maxGeneratedFileBytes) {
        prepared.push({
          reference,
          stored: null,
          manifest: null,
          errorCode: content ? "GENERATED_CONTENT_TOO_LARGE" : "GENERATED_CONTENT_UNAVAILABLE",
        });
        continue;
      }
      const mediaType = content.mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      const fallbackFilename =
        mediaType === "image/png"
          ? "generated-image.png"
          : mediaType === "image/jpeg"
            ? "generated-image.jpg"
            : mediaType === "image/webp"
              ? "generated-image.webp"
              : mediaType === "application/pdf"
                ? "generated-document.pdf"
                : mediaType === "text/csv"
                  ? "generated-data.csv"
                  : mediaType === "text/plain"
                    ? "generated-data.txt"
                    : null;
      const filename = content.filename ?? reference.filename ?? fallbackFilename;
      if (!filename || !mediaType) {
        prepared.push({
          reference,
          stored: null,
          manifest: null,
          errorCode: "GENERATED_CONTENT_TYPE_UNSUPPORTED",
        });
        continue;
      }
      const stored = await store.put(input.userId, {
        bytes: content.bytes,
        filename,
        mimeType: mediaType,
      });
      storedForCleanup = stored;
      const manifest = manifestForGeneratedContent({
        file: stored,
        ownerId: input.userId,
        result: input.result,
      });
      if (!manifest) {
        await store.delete(input.userId, stored.id);
        storedForCleanup = null;
        prepared.push({
          reference,
          stored: null,
          manifest: null,
          errorCode: "GENERATED_CONTENT_RENDERER_UNAVAILABLE",
        });
        continue;
      }
      prepared.push({ reference, stored, manifest, errorCode: null });
      storedForCleanup = null;
    } catch {
      if (storedForCleanup) {
        try {
          await store.delete(input.userId, storedForCleanup.id);
        } catch {
          // Retention cleanup remains the final fail-safe if immediate cleanup is unavailable.
        }
      }
      prepared.push({
        reference,
        stored: null,
        manifest: null,
        errorCode: "GENERATED_CONTENT_VALIDATION_FAILED",
      });
    }
  }
  return prepared;
}

async function cleanupPreparedProviderArtifacts(input: {
  readonly runtime: BeaServerRuntime;
  readonly userId: string;
  readonly artifacts: readonly PreparedProviderGeneratedArtifact[];
  readonly alreadyReleased?: ReadonlyMap<string, number>;
}): Promise<void> {
  const remainingReleased = new Map(input.alreadyReleased ?? []);
  const stored = input.artifacts.flatMap((artifact) => {
    if (!artifact.stored) return [];
    const released = remainingReleased.get(artifact.stored.id) ?? 0;
    if (released > 0) {
      remainingReleased.set(artifact.stored.id, released - 1);
      return [];
    }
    return [artifact.stored];
  });
  if (stored.length === 0) return;
  const settings = await input.runtime.ai.persistence.getProviderSettings();
  const store = new RepositoryArtifactFileStore({
    repositoryRoot: input.runtime.repositoryRoot,
    retentionMilliseconds: effectiveArtifactRetentionMilliseconds(settings.artifactRetentionDays),
  });
  await Promise.allSettled(stored.map((artifact) => store.delete(input.userId, artifact.id)));
}

async function prepareWorkspaceArtifact(input: {
  readonly runtime: BeaServerRuntime;
  readonly userId: string;
  readonly conversationId: string;
  readonly correlationId: string;
  readonly requestId: string;
  readonly responseRunId: string;
  readonly requestMessage: string;
  readonly inputMode: "text" | "simulated_voice" | "live_voice";
  readonly provider: AiCommandProvider;
  readonly result: AiConversationResult;
  readonly policyProvenance: AssistantPolicyProvenance;
}): Promise<PreparedWorkspaceArtifact | null> {
  const proposed = input.result.toolCalls.find(
    (call) =>
      demoArtifactToolNames.has(call.name) &&
      validateRegisteredArtifactToolCall(call.name, call.arguments).ok,
  );
  const pdfTool = input.result.toolCalls.find(
    (call) =>
      (call.name === "bea_create_pdf" || call.name === "bea_revise_artifact") &&
      validateRegisteredArtifactToolCall(call.name, call.arguments).ok,
  );
  if (pdfTool) {
    const args = pdfTool.arguments;
    const generated = await generateExecutivePdfArtifact({
      runtime: input.runtime,
      userId: input.userId,
      correlationId: input.correlationId,
      responseRunId: input.responseRunId,
      request: {
        conversationId: input.conversationId,
        ...(typeof args.title === "string" ? { title: args.title } : {}),
        ...(typeof args.template === "string"
          ? { template: args.template as ExecutivePdfRequest["template"] }
          : {}),
        ...(typeof args.outputLength === "string"
          ? { outputLength: args.outputLength as ExecutivePdfRequest["outputLength"] }
          : {}),
        ...(typeof args.instructions === "string" ? { instructions: args.instructions } : {}),
        ...(typeof args.leadId === "string" ? { leadId: args.leadId } : {}),
        ...(typeof args.presentationRunId === "string"
          ? { presentationRunId: args.presentationRunId }
          : {}),
        ...(typeof args.parentArtifactId === "string"
          ? { parentArtifactId: args.parentArtifactId }
          : pdfTool.name === "bea_revise_artifact" && typeof args.parentArtifactId === "string"
            ? { parentArtifactId: args.parentArtifactId }
            : {}),
        ...(Array.isArray(args.sourceArtifactIds)
          ? {
              sourceArtifactIds: args.sourceArtifactIds.filter(
                (item): item is string => typeof item === "string",
              ),
            }
          : {}),
        model: input.result.model,
        provider: input.provider.providerKey,
      },
    });
    return {
      manifest: generated.manifest,
      workspacePayload: generated.workspacePayload,
      requiredPermissions: generated.specification.requiredPermissions,
      executedToolCallId: pdfTool.id,
    };
  }
  if (
    inferAiWorkloadRoute({
      input: input.requestMessage,
      builtInTools: [],
    }) === "pdf_narrative_generation"
  ) {
    const generated = await generateExecutivePdfArtifact({
      runtime: input.runtime,
      userId: input.userId,
      correlationId: input.correlationId,
      responseRunId: input.responseRunId,
      request: {
        conversationId: input.conversationId,
        instructions: input.requestMessage,
        model: input.result.model,
        provider: input.provider.providerKey,
      },
    });
    return {
      manifest: generated.manifest,
      workspacePayload: generated.workspacePayload,
      requiredPermissions: generated.specification.requiredPermissions,
      executedToolCallId: "bea_create_pdf",
    };
  }
  if (input.provider.providerKey === "demo" && proposed) {
    const runner = await createDemoArtifactApplicationRunner(input.runtime, input.policyProvenance);
    const bundle = await runner.run({
      toolName: "bea_create_demo_artifact_bundle",
      arguments: {
        conversationId: input.conversationId,
        inputMode: input.inputMode === "live_voice" ? "text" : input.inputMode,
        prompt: input.requestMessage,
      },
      context: {
        ownerId: input.userId,
        correlationId: input.correlationId,
        requestId: input.requestId,
        responseRunId: input.responseRunId,
      },
    });
    const manifest =
      proposed.name === "bea_research" || proposed.name === "bea_create_board"
        ? bundle.sourceBoard
        : proposed.name === "bea_create_chart" || proposed.name === "bea_analyze"
          ? bundle.comparisonChart
          : proposed.name === "bea_create_table"
            ? bundle.table
            : proposed.name === "bea_create_image"
              ? bundle.image
              : bundle.pdf;
    return {
      manifest,
      requiredPermissions: [PERMISSIONS.AI_COMMAND_VIEW, PERMISSIONS.DOCUMENTS_VIEW],
      executedToolCallId: proposed.id,
    };
  }
  const sourceBoard = sourceBoardForResult({
    result: input.result,
    ownerId: input.userId,
    conversationId: input.conversationId,
  });
  return sourceBoard
    ? {
        manifest: sourceBoard,
        requiredPermissions: sourcePermissionsForResult(input.result),
      }
    : null;
}

async function authorizedConversationHistory(
  runtime: BeaServerRuntime,
  userId: string,
  conversationId: string,
) {
  const messages = await runtime.phase1.listAssistantMessages(conversationId, userId, 40);
  const selected: {
    role: "user" | "assistant";
    content: string;
    providerResponseId?: string;
    provider?: string | null;
    model?: string | null;
    responseStatus?: "streaming" | "completed" | "cancelled" | "failed" | "incomplete";
  }[] = [];
  for (const message of messages.slice(-20)) {
    if (message.role === "system") continue;
    if (message.role === "assistant") {
      if (message.requiredPermissions.length === 0) continue;
      const permissions = message.requiredPermissions.filter((permission) =>
        knownPermissions.has(permission),
      );
      if (permissions.length !== message.requiredPermissions.length) continue;
      const decisions = await Promise.all(
        permissions.map((permission) =>
          runtime.authorization.authorizeUser(userId, permission as Permission),
        ),
      );
      if (!decisions.every((decision) => decision.allowed)) continue;
    }
    const content = message.content.replace(/\s+/gu, " ").trim().slice(0, 1_000);
    if (!content) continue;
    try {
      requireCredentialSafeContent(content);
    } catch {
      // Fail closed: a historical turn that resembles a credential is never sent externally.
      continue;
    }
    selected.push({
      role: message.role,
      content,
      ...(message.providerResponseId ? { providerResponseId: message.providerResponseId } : {}),
      ...(message.provider === undefined ? {} : { provider: message.provider }),
      ...(message.model === undefined ? {} : { model: message.model }),
      ...(message.responseStatus === undefined ? {} : { responseStatus: message.responseStatus }),
    });
  }
  let remaining = 6_000;
  return selected
    .reverse()
    .flatMap((message) => {
      if (remaining <= 0) return [];
      const content = message.content.slice(0, remaining);
      remaining -= content.length;
      return [{ ...message, content }];
    })
    .reverse();
}

function artifactKind(
  reference: AiConversationResult["generatedArtifacts"][number],
): GeneratedArtifactRecord["kind"] {
  return reference.kind === "generated_image" ? "image" : "code_interpreter_output";
}

async function persistToolCall(
  runtime: BeaServerRuntime,
  userId: string,
  responseRunId: string,
  toolCall: AiToolCall,
  executed: boolean,
): Promise<void> {
  const validation = validateRegisteredArtifactToolCall(toolCall.name, toolCall.arguments);
  const builtIn = ["web_search", "file_search", "code_interpreter", "image_generation"].includes(
    toolCall.name,
  );
  let status: "proposed" | "validated" | "rejected" | "completed" | "failed" = "rejected";
  let requiredPermissions: readonly string[] = [];
  let effect: "read" | "preview" = "read";
  if (builtIn) {
    requiredPermissions =
      toolCall.name === "web_search"
        ? [PERMISSIONS.AI_COMMAND_VIEW, PERMISSIONS.SEARCH_VIEW]
        : [PERMISSIONS.AI_COMMAND_VIEW, PERMISSIONS.DOCUMENTS_VIEW];
    effect = toolCall.name === "web_search" || toolCall.name === "file_search" ? "read" : "preview";
    status =
      toolCall.status === "failed"
        ? "failed"
        : toolCall.status === "completed"
          ? toolCall.name === "web_search" || toolCall.name === "file_search" || executed
            ? "completed"
            : "validated"
          : "proposed";
  } else if (validation.ok) {
    requiredPermissions = validation.tool.requiredPermissions;
    effect = validation.tool.effect;
    const decisions = await Promise.all(
      requiredPermissions.map((permission) =>
        runtime.authorization.authorizeUser(userId, permission as Permission),
      ),
    );
    status = decisions.every((decision) => decision.allowed)
      ? executed
        ? "completed"
        : "validated"
      : "rejected";
  }
  await runtime.ai.persistence.recordToolCall({
    responseRunId,
    providerCallId: toolCall.providerCallId ?? null,
    name: toolCall.name,
    arguments: toolCall.arguments,
    status,
    requiredPermissions,
    effect,
    errorCode:
      status === "rejected"
        ? "TOOL_PROPOSAL_REJECTED"
        : status === "failed"
          ? "PROVIDER_TOOL_FAILED"
          : null,
  });
}

async function providerForRequest(
  runtime: BeaServerRuntime,
  userId: string,
  input: StreamAiCommandInput,
): Promise<{
  readonly provider: AiCommandProvider;
  readonly builtInTools: readonly AiBuiltInToolRequest[];
  readonly model: string;
  readonly routeDecision: AiRouteDecisionProvenance | null;
  readonly maxOutputTokens: number | undefined;
  readonly timeoutMs: number;
}> {
  const settings = await runtime.ai.persistence.getProviderSettings();
  const provider = await resolveAiCommandProvider(runtime);
  if (input.inputMode === "live_voice" && provider.providerKey !== "openai") {
    throw new OpenAiAdministrationError(
      "REALTIME_WEB_SEARCH_NOT_AUTHORIZED",
      403,
      "Live voice web search requires the currently connected OpenAI provider.",
    );
  }
  const enforceLivePolicy = provider.providerKey === "openai";
  const requested = new Set<AiBuiltInToolRequest["type"]>(input.builtInTools);
  if (input.webSearch) requested.add("web_search");
  const routingTools: AiBuiltInToolRequest[] = [...requested].map((type) => {
    if (type === "code_interpreter") {
      return { type, container: { type: "auto", memoryLimit: "4g" } };
    }
    if (type === "image_generation") return { type };
    if (type === "file_search") return { type, vectorStoreIds: [] };
    return { type: "web_search" };
  });
  const routeKey = inferAiWorkloadRoute({
    input: input.message,
    builtInTools: routingTools,
    files: input.inputArtifactIds.map(() => ({ type: "input_file" as const })),
  });
  if (enforceLivePolicy && routeKey === "embeddings_indexing") {
    throw new OpenAiAdministrationError(
      "EMBEDDINGS_INDEXING_DEFERRED",
      409,
      "Embeddings and indexing execution is deferred; this Phase 1.3.3 route is configuration-only.",
    );
  }
  if (enforceLivePolicy && routeKey === "organizational_file_search") {
    requested.add("file_search");
  }
  if (enforceLivePolicy && requested.has("web_search") && !settings.webSearchAllowed) {
    throw new OpenAiAdministrationError(
      "WEB_SEARCH_DISABLED",
      403,
      "Web search is disabled by provider policy.",
    );
  }
  if (enforceLivePolicy && requested.has("code_interpreter") && !settings.codeInterpreterAllowed) {
    throw new OpenAiAdministrationError(
      "CODE_INTERPRETER_DISABLED",
      403,
      "Code Interpreter is disabled by provider policy.",
    );
  }
  if (enforceLivePolicy && requested.has("image_generation") && !settings.imageGenerationAllowed) {
    throw new OpenAiAdministrationError(
      "IMAGE_GENERATION_DISABLED",
      403,
      "Image generation is disabled by provider policy.",
    );
  }
  if (
    enforceLivePolicy &&
    (requested.has("code_interpreter") || requested.has("image_generation")) &&
    !input.confirmHighCostTools
  ) {
    throw new OpenAiAdministrationError(
      "HIGH_COST_CONFIRMATION_REQUIRED",
      409,
      "Explicit confirmation is required before requesting a high-cost provider tool.",
    );
  }
  if (
    enforceLivePolicy &&
    (requested.has("code_interpreter") || requested.has("image_generation"))
  ) {
    const authorization = input.confirmHighCostTools
      ? await authorizeLiveOwnerTools({
          runtime,
          actorUserId: userId,
          correlationId: input.correlationId,
          capabilities: [
            ...(requested.has("code_interpreter") ? (["code_interpreter"] as const) : []),
            ...(requested.has("image_generation") ? (["image_generation"] as const) : []),
          ],
        })
      : undefined;
    if (requested.has("code_interpreter")) {
      requireLiveOwnerAuthorization(provider.providerKey, "code_interpreter", authorization);
    }
    if (requested.has("image_generation")) {
      requireLiveOwnerAuthorization(provider.providerKey, "image_generation", authorization);
    }
  }
  if (requested.has("web_search")) {
    const permission = await runtime.authorization.authorizeUser(userId, PERMISSIONS.SEARCH_VIEW);
    if (!permission.allowed) {
      throw new OpenAiAdministrationError(
        "WEB_SEARCH_PERMISSION_REQUIRED",
        403,
        "Web search permission is required.",
      );
    }
  }
  const builtInTools: AiBuiltInToolRequest[] = [];
  if (requested.has("web_search")) builtInTools.push({ type: "web_search" });
  if (requested.has("code_interpreter")) {
    builtInTools.push({ type: "code_interpreter", container: { type: "auto", memoryLimit: "4g" } });
  }
  if (requested.has("image_generation")) {
    builtInTools.push({
      type: "image_generation",
      partialImages: 1,
      quality: settings.imageQuality,
    });
  }
  let routeDecision: AiRouteDecisionProvenance | null = null;
  let model =
    provider.providerKey === "demo" ? "deterministic-demo-router" : settings.defaultTextModel;
  let maxOutputTokens: number | undefined;
  let timeoutMs = settings.requestTimeoutMs;
  if (provider.providerKey === "openai") {
    const [cachedModels, user] = await Promise.all([
      runtime.ai.persistence.listCachedModels("openai"),
      runtime.repository.findActiveUserById(userId),
    ]);
    if (!user) throw new Phase1OwnershipError();
    const policy = settings.routingProfile.routes[routeKey];
    const roleKey = user.roleIds.find((roleId) => policy.roleAvailability.includes(roleId)) ?? "";
    const models: AiModelMetadata[] = cachedModels.map((cached) => ({
      id: cached.modelId,
      provider: cached.provider,
      displayName: cached.modelId,
      available: cached.available,
      ...(cached.ownedBy === null ? {} : { ownedBy: cached.ownedBy }),
      capabilities: {
        ...(cached.capabilities as unknown as AiModelMetadata["capabilities"]),
        ...((typeof settings.modelCapabilityOverrides[cached.modelId] === "object" &&
        settings.modelCapabilityOverrides[cached.modelId] !== null
          ? settings.modelCapabilityOverrides[cached.modelId]
          : {}) as Partial<AiModelMetadata["capabilities"]>),
      },
      capabilitySource: cached.capabilitySource,
      validation: cached.validation,
    }));
    try {
      routeDecision = selectAiRoute({
        routeKey,
        profile: settings.routingProfile,
        models,
        roleKey,
      });
    } catch (error) {
      if (routeKey !== "pdf_narrative_generation" && routeKey !== "document_report_drafting") {
        throw error;
      }
      routeDecision = selectAiRoute({
        routeKey: "executive_conversation",
        profile: settings.routingProfile,
        models,
        roleKey,
      });
    }
    model = routeDecision.selectedModel;
    maxOutputTokens = policy.maxOutputTokens;
    timeoutMs = policy.timeoutMs;
    if ([...requested].some((tool) => !policy.toolAllowlist.includes(tool))) {
      throw new OpenAiAdministrationError(
        "ROUTE_TOOL_NOT_ALLOWED",
        409,
        "The selected workload route does not allow every requested provider tool.",
      );
    }
    if (requested.has("file_search")) {
      const vectorStoreIds = settings.routingProfile.vectorStoreAssignments
        .filter(
          (assignment) =>
            assignment.enabled &&
            user.roleIds.some((role) => assignment.allowedRoleKeys.includes(role)),
        )
        .map((assignment) => assignment.vectorStoreId);
      if (vectorStoreIds.length === 0) {
        throw new OpenAiAdministrationError(
          "FILE_SEARCH_NOT_CONFIGURED",
          409,
          "No organizational knowledge source is configured.",
        );
      }
      builtInTools.push({ type: "file_search", vectorStoreIds, maxNumResults: 10 });
    }
  }
  return { provider, builtInTools, model, routeDecision, maxOutputTokens, timeoutMs };
}

async function persistCompletedResult(input: {
  readonly runtime: BeaServerRuntime;
  readonly userId: string;
  readonly conversationId: string;
  readonly generation: number;
  readonly correlationId: string;
  readonly responseRunId: string;
  readonly query: string;
  readonly provider: AiCommandProvider;
  readonly result: AiConversationResult;
  readonly executionMs: number;
  readonly workspaceArtifact: PreparedWorkspaceArtifact | null;
  readonly providerGeneratedArtifacts: readonly PreparedProviderGeneratedArtifact[];
  readonly policyProvenance: AssistantPolicyProvenance;
}): Promise<"completed" | "superseded"> {
  const providerName = input.result.simulated ? "simulated" : input.provider.providerKey;
  const sourceBoard = sourceBoardForResult({
    result: input.result,
    ownerId: input.userId,
    conversationId: input.conversationId,
  });
  const sourceLinks = orderedSourceLinks(input.result);
  const preferPdf = input.workspaceArtifact?.manifest.renderer === "pdf";
  const shouldPresentResearch =
    !preferPdf &&
    (webSearchToolSucceeded(input.result) ||
      input.result.webSources.length > 0 ||
      input.result.citations.length > 0);
  const presentation = shouldPresentResearch
    ? buildResearchPresentation({
        conversationId: input.conversationId,
        actingUserId: input.userId,
        query: input.query,
        result: input.result,
        provider: providerName,
        requiredPermissions: sourcePermissionsForResult(input.result),
        visualArtifactId: sourceBoard?.artifactId ?? null,
      })
    : null;
  const researchPayload = presentation
    ? jsonObject({
        ...(sourceBoard ?? {}),
        ...researchWorkspacePayload(presentation),
        renderer: sourceBoard?.renderer ?? "research",
      })
    : null;
  const finalized = await input.runtime.phase1.finalizeAiCommandRequest({
    conversationId: input.conversationId,
    ownerUserId: input.userId,
    generation: input.generation,
    assistantMessage: {
      content: input.result.text.trim() || "A generated artifact is ready for review.",
      correlationId: input.correlationId,
      routerVersion: "phase1.3-provider-v1",
      executionMs: input.executionMs,
      provider: providerName,
      model: input.result.model,
      providerResponseId: input.result.responseId,
      responseStatus: "completed",
    },
    workspaceArtifact: presentation
      ? {
          type: "help",
          title: presentation.title,
          subtitle: researchWorkspaceSubtitle(presentation),
          state: presentation.status === "insufficient_evidence" ? "empty" : "ready",
          payload: researchPayload ?? jsonObject(researchWorkspacePayload(presentation)),
          sources: sourceLinks.map((source) => ({
            id: source.id,
            type: "web-source",
            title: source.title,
            href: source.url,
          })),
          links: sourceLinks.map((source) => ({ label: source.title, href: source.url })),
          requiredPermissions: sourcePermissionsForResult(input.result),
        }
      : !preferPdf && sourceBoard
        ? {
            type: "help",
            title: sourceBoard.title,
            subtitle: input.result.simulated
              ? "SIMULATED · deterministic source fixture"
              : input.result.fileSources?.length
                ? `OpenAI File Search · ${input.result.model}`
                : `OpenAI web search · ${input.result.model}`,
            state: "ready",
            payload: jsonObject(sourceBoard),
            sources: sourceLinks.map((source) => ({
              id: source.id,
              type: "web-source",
              title: source.title,
              href: source.url,
            })),
            links: sourceLinks.map((source) => ({ label: source.title, href: source.url })),
            requiredPermissions: sourcePermissionsForResult(input.result),
          }
        : input.workspaceArtifact
          ? {
              type: "help",
              title: input.workspaceArtifact.manifest.title,
              subtitle: input.result.simulated
                ? "SIMULATED · normalized generated artifact"
                : `OpenAI · ${input.result.model}`,
              state: "ready",
              payload:
                input.workspaceArtifact.workspacePayload ??
                jsonObject(input.workspaceArtifact.manifest),
              sources: [],
              links: [],
              requiredPermissions: input.workspaceArtifact.requiredPermissions,
            }
          : {
              type: "help",
              title: "AI Command response",
              subtitle: input.result.simulated
                ? "Simulated provider result"
                : `OpenAI · ${input.result.model}`,
              state: "ready",
              payload: {
                provider: providerName,
                model: input.result.model,
                providerResponseId: input.result.responseId,
                simulated: input.result.simulated,
                citationCount: input.result.citations.length,
                toolCallCount: input.result.toolCalls.length,
              },
              sources: [],
              links: [],
              requiredPermissions: [PERMISSIONS.AI_COMMAND_VIEW],
            },
  });
  if (finalized.status === "superseded") {
    await cleanupPreparedProviderArtifacts({
      runtime: input.runtime,
      userId: input.userId,
      artifacts: input.providerGeneratedArtifacts,
    });
    await input.runtime.ai.persistence.completeResponseRun({
      id: input.responseRunId,
      requestedByUserId: input.userId,
      status: "cancelled",
      providerResponseId: input.result.responseId,
      errorCode: "SUPERSEDED",
    });
    return "superseded";
  }

  try {
    for (const citation of input.result.citations) {
      await input.runtime.ai.persistence.recordCitation({
        responseRunId: input.responseRunId,
        assistantMessageId: finalized.assistantMessage.id,
        providerItemId: citation.toolCallId ?? null,
        title: citation.title,
        url: citation.url,
        domain: citation.domain,
        startIndex: citation.startIndex ?? null,
        endIndex: citation.endIndex ?? null,
        retrievedAt: citation.retrievedAt,
        simulated: citation.simulated,
      });
    }
    const sourceBoardManifest = sourceBoardForResult({
      result: input.result,
      ownerId: input.userId,
      conversationId: input.conversationId,
    });
    if (sourceBoardManifest) {
      await input.runtime.ai.persistence.recordGeneratedArtifact({
        conversationId: input.conversationId,
        responseRunId: input.responseRunId,
        requestedByUserId: input.userId,
        kind: "web_search_result",
        title: sourceBoardManifest.title,
        status: "ready",
        artifactVersion: 1,
        provider: input.result.simulated ? "demo" : "openai",
        providerItemId: null,
        providerContainerId: null,
        providerFileId: null,
        filename: null,
        mediaType: null,
        storageReference: null,
        specification: jsonObject(sourceBoardManifest),
        sourceMetadata: jsonObject({
          responseId: input.result.responseId,
          webSourceCount: input.result.webSources.length,
        }),
        citationIds: input.result.citations.map((citation) => citation.id),
        fileMetadata: {},
        renderMetadata: { renderer: "source-board" },
        generationMetadata: { providerResponseId: input.result.responseId },
        requiredPermissions: [PERMISSIONS.AI_COMMAND_VIEW, PERMISSIONS.SEARCH_VIEW],
        simulated: input.result.simulated,
        errorCode: null,
        policyProvenance: input.policyProvenance,
      });
    }
    for (const toolCall of input.result.toolCalls) {
      await persistToolCall(
        input.runtime,
        input.userId,
        input.responseRunId,
        toolCall,
        input.workspaceArtifact?.executedToolCallId === toolCall.id,
      );
    }
    for (const reference of input.workspaceArtifact?.executedToolCallId
      ? []
      : input.result.generatedArtifacts) {
      const prepared = input.providerGeneratedArtifacts.find(
        (candidate) => candidate.reference.id === reference.id,
      );
      const registered = input.result.toolCalls
        .map((call) => findRegisteredArtifactTool(call.name))
        .find((tool) => tool !== null);
      await input.runtime.ai.persistence.recordGeneratedArtifact({
        conversationId: input.conversationId,
        responseRunId: input.responseRunId,
        requestedByUserId: input.userId,
        kind: artifactKind(reference),
        title:
          prepared?.stored?.filename ??
          reference.filename ??
          (reference.kind === "generated_image" ? "Generated image" : "Generated data file"),
        status: prepared?.stored && prepared.manifest ? "ready" : "failed",
        artifactVersion: 1,
        provider: input.result.simulated ? "demo" : "openai",
        providerItemId: reference.providerItemId,
        providerContainerId: reference.containerId ?? null,
        providerFileId: reference.fileId ?? null,
        filename: prepared?.stored?.filename ?? reference.filename ?? null,
        mediaType:
          prepared?.stored?.mimeType ?? (reference.kind === "generated_image" ? "image/png" : null),
        storageReference: prepared?.stored?.id ?? null,
        specification: prepared?.manifest ? jsonObject(prepared.manifest) : {},
        sourceMetadata: { responseId: input.result.responseId },
        citationIds: input.result.citations.map((citation) => citation.id),
        fileMetadata: prepared?.stored
          ? {
              artifactFileId: prepared.stored.id,
              createdAt: prepared.stored.createdAt,
              expiresAt: prepared.stored.expiresAt,
              sha256: prepared.stored.sha256,
              size: prepared.stored.size,
            }
          : { rawBytesPersisted: false },
        renderMetadata: prepared?.manifest ? { renderer: prepared.manifest.renderer } : {},
        generationMetadata: { providerItemId: reference.providerItemId },
        requiredPermissions: registered?.requiredPermissions ?? [PERMISSIONS.AI_COMMAND_VIEW],
        simulated: reference.simulated,
        errorCode: prepared?.errorCode ?? null,
        policyProvenance: input.policyProvenance,
      });
    }
    if (input.result.usage) {
      await input.runtime.ai.persistence.recordUsage({
        responseRunId: input.responseRunId,
        realtimeSessionId: null,
        requestedByUserId: input.userId,
        provider: input.result.simulated ? "demo" : "openai",
        model: input.result.model,
        operation: "responses.stream",
        inputTokens: input.result.usage.inputTokens,
        outputTokens: input.result.usage.outputTokens,
        reasoningTokens: input.result.usage.reasoningTokens ?? 0,
        cachedInputTokens: input.result.usage.cachedInputTokens ?? 0,
        audioInputTokens: input.result.usage.audioInputTokens ?? 0,
        audioOutputTokens: input.result.usage.audioOutputTokens ?? 0,
        realtimeDurationSeconds: 0,
        estimatedCostUsd: null,
        costStatus: "unavailable",
        simulated: input.result.simulated,
        recordedAt: input.result.completedAt,
      });
    }
    await input.runtime.ai.persistence.completeResponseRun({
      id: input.responseRunId,
      requestedByUserId: input.userId,
      status: "completed",
      providerResponseId: input.result.responseId,
    });
    if (finalized.status === "completed") {
      await persistPresentationPacketWithRuntime(input.runtime, {
        userId: input.userId,
        conversationId: input.conversationId,
        payload: finalized.workspaceArtifact.payload,
        visualArtifactId: finalized.workspaceArtifact.id,
        assistantMessageId: finalized.assistantMessage.id,
        responseRunId: input.responseRunId,
      });
    }
    return "completed";
  } catch (error) {
    const orphanedStorageReferences = await input.runtime.ai.persistence
      .failGeneratedArtifactsForResponseRun({
        responseRunId: input.responseRunId,
        requestedByUserId: input.userId,
        errorCode: "RESPONSE_METADATA_PERSISTENCE_FAILED",
      })
      .catch(() => [] as readonly string[]);
    await input.runtime.phase1
      .markAiCommandFinalizationIncomplete({
        assistantMessageId: finalized.assistantMessage.id,
        workspaceArtifactId: finalized.workspaceArtifact.id,
        ownerUserId: input.userId,
        errorCode: "RESPONSE_METADATA_PERSISTENCE_FAILED",
      })
      .catch(() => undefined);
    const releasedReferenceCounts = new Map<string, number>();
    if (orphanedStorageReferences.length > 0) {
      await (async () => {
        const settings = await input.runtime.ai.persistence.getProviderSettings();
        const store = new RepositoryArtifactFileStore({
          repositoryRoot: input.runtime.repositoryRoot,
          retentionMilliseconds: effectiveArtifactRetentionMilliseconds(
            settings.artifactRetentionDays,
          ),
        });
        for (const artifactFileId of orphanedStorageReferences) {
          const released = await store
            .delete(input.userId, artifactFileId)
            .then(() => true)
            .catch(() => false);
          if (released) {
            releasedReferenceCounts.set(
              artifactFileId,
              (releasedReferenceCounts.get(artifactFileId) ?? 0) + 1,
            );
          }
        }
      })().catch(() => undefined);
    }
    await cleanupPreparedProviderArtifacts({
      runtime: input.runtime,
      userId: input.userId,
      artifacts: input.providerGeneratedArtifacts,
      alreadyReleased: releasedReferenceCounts,
    }).catch(() => undefined);
    throw error;
  }
}

async function persistTerminalStreamResult(input: {
  readonly runtime: BeaServerRuntime;
  readonly userId: string;
  readonly conversationId: string;
  readonly generation: number;
  readonly correlationId: string;
  readonly provider: AiCommandProvider;
  readonly model: string;
  readonly providerResponseId?: string;
  readonly partialText: string;
  readonly status: "cancelled" | "failed" | "incomplete";
  readonly reason: string;
  readonly retryable: boolean;
  readonly executionMs: number;
}): Promise<"completed" | "superseded"> {
  const content =
    input.partialText.trim().slice(0, 20_000) ||
    (input.status === "cancelled"
      ? "The AI Command response was cancelled before completion."
      : "The AI Command response did not complete.");
  const finalized = await input.runtime.phase1.finalizeAiCommandRequest({
    conversationId: input.conversationId,
    ownerUserId: input.userId,
    generation: input.generation,
    assistantMessage: {
      content,
      correlationId: input.correlationId,
      routerVersion: "phase1.3-provider-v1",
      executionMs: input.executionMs,
      provider: input.provider.providerKey === "demo" ? "simulated" : "openai",
      model: input.model,
      ...(input.providerResponseId === undefined
        ? {}
        : { providerResponseId: input.providerResponseId }),
      responseStatus: input.status,
      incompleteReason: input.reason.slice(0, 200),
    },
    workspaceArtifact: {
      type: "error",
      title:
        input.status === "cancelled"
          ? "AI Command response cancelled"
          : "AI Command response incomplete",
      subtitle: input.retryable
        ? "The partial response was saved and can be retried."
        : "The partial response was saved.",
      state: "failed",
      payload: {
        errorCode: input.reason.slice(0, 100),
        partial: input.partialText.length > 0,
        retryable: input.retryable,
      },
      sources: [],
      links: [],
      requiredPermissions: [PERMISSIONS.AI_COMMAND_VIEW],
      errorCode: input.reason.slice(0, 100),
    },
  });
  return finalized.status;
}

export async function* processAiCommandStream(
  input: StreamAiCommandInput,
): AsyncIterable<AiResponseStreamEvent> {
  const conversation = await input.runtime.phase1.getConversation(
    input.conversationId,
    input.userId,
  );
  if (!conversation) throw new Phase1OwnershipError();
  const normalized = input.message.replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > 2_000) {
    throw new OpenAiAdministrationError(
      "INVALID_MESSAGE",
      400,
      "AI Command messages must contain 1 to 2,000 characters.",
    );
  }
  requireCredentialSafeContent(normalized);
  const requestId = normalizeAiCommandRequestId(input.requestId);
  const generation = normalizeAiCommandRequestGeneration(input.generation);
  const internalIntent = routeDemoCommand(normalized);
  const authorizedRealtimeWebSearch =
    input.liveVoiceWebSearchAuthorization instanceof LiveVoiceWebSearchAuthorization &&
    input.liveVoiceWebSearchAuthorization.consume(input);
  if (input.inputMode === "live_voice" && !authorizedRealtimeWebSearch) {
    throw new OpenAiAdministrationError(
      "REALTIME_WEB_SEARCH_NOT_AUTHORIZED",
      403,
      "Live voice web search requires current server authorization.",
    );
  }
  const history = await authorizedConversationHistory(
    input.runtime,
    input.userId,
    input.conversationId,
  );
  const workspaceSelection = parseSafeWorkspaceSelection(input.workspaceSelection);
  const latestPresentation =
    await input.runtime.ai.persistence.getLatestPresentationRunForConversation(
      input.conversationId,
      input.userId,
    );
  const latestPacket = latestPresentation
    ? presentationPacketFromStoredRun(latestPresentation.packet)
    : null;
  const selectedEvidence =
    workspaceSelection && latestPacket
      ? buildSelectedEvidenceContext(latestPacket, workspaceSelection)
      : null;
  if (workspaceSelection && !latestPacket) {
    throw new OpenAiAdministrationError(
      "PRESENTATION_UNAVAILABLE",
      404,
      "No presentation is available for this conversation.",
    );
  }
  if (
    workspaceSelection &&
    latestPacket &&
    (!selectedEvidence ||
      !authorizeWorkspaceSelection({
        latest: latestPacket,
        selection: workspaceSelection,
        conversationOwnerUserId: conversation.ownerUserId,
        actingUserId: input.userId,
        permissionsAllowed: true,
        runVisualArtifactId: latestPresentation?.visualArtifactId,
      }).ok)
  ) {
    throw new OpenAiAdministrationError(
      "PRESENTATION_SELECTION_MISMATCH",
      409,
      "The workspace selection is not part of this presentation.",
    );
  }
  if (input.webSearch) {
    const [userLimit, conversationLimit] = await Promise.all([
      input.runtime.ai.persistence.consumeRateLimit({
        subjectKey: `user:${input.userId}`,
        routeKey: "ai-command.web-search.user",
        limit: PHASE21_LIMITS.webSearchPerUserPerMinute,
        windowSeconds: 60,
      }),
      input.runtime.ai.persistence.consumeRateLimit({
        subjectKey: `conversation:${input.userId}:${input.conversationId}`,
        routeKey: "ai-command.web-search.conversation",
        limit: PHASE21_LIMITS.webSearchPerConversationPerMinute,
        windowSeconds: 60,
      }),
    ]);
    if (!userLimit.allowed || !conversationLimit.allowed) {
      throw new OpenAiAdministrationError(
        "WEB_SEARCH_RATE_LIMITED",
        429,
        "Web search is temporarily rate limited.",
      );
    }
  }
  if (
    !authorizedRealtimeWebSearch &&
    (shouldUseInternalDemoRouter(internalIntent, input.inputArtifactIds) ||
      Boolean(workspaceSelection && isFollowUpAboutSelection(normalized))) &&
    (await isDeterministicDemoAiCommandAllowed(input.runtime))
  ) {
    const snapshot = await processAiCommandMessageWithRuntime(input.runtime, {
      userId: input.userId,
      conversationId: input.conversationId,
      message: normalized,
      requestId,
      generation,
      correlationId: input.correlationId,
      ...(workspaceSelection ? { workspaceSelection } : {}),
    });
    const assistant = [...snapshot.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    const text = assistant?.content ?? "The internal BEA request completed.";
    const result: AiConversationResult = {
      responseId: `legacy-${requestId}`,
      model: "bea-internal-router",
      text,
      citations: [],
      webSources: [],
      fileSources: [],
      toolCalls: [],
      generatedArtifacts: [],
      usage: null,
      completedAt: new Date().toISOString(),
      simulated: true,
    };
    yield {
      type: "response.started",
      requestId,
      providerResponseId: result.responseId,
      model: result.model,
      simulated: true,
    };
    yield { type: "response.output_text.delta", delta: text };
    yield { type: "response.completed", result };
    return;
  }
  const { provider, builtInTools, model, routeDecision, maxOutputTokens, timeoutMs } =
    await providerForRequest(input.runtime, input.userId, input);
  const settings = await input.runtime.ai.persistence.getProviderSettings();
  const assistantPolicy = await getAssistantPolicyContext(input.runtime, input.userId);
  const request = await input.runtime.phase1.beginAiCommandRequest({
    requestId,
    generation,
    conversationId: conversation.id,
    ownerUserId: input.userId,
    content: normalized,
    correlationId: input.correlationId,
  });
  if (request.status === "superseded") {
    yield { type: "response.cancelled", requestId };
    return;
  }
  let responseRun;
  try {
    responseRun = await input.runtime.ai.persistence.beginResponseRun({
      conversationId: conversation.id,
      requestedByUserId: input.userId,
      requestId,
      provider: provider.providerKey === "demo" ? "demo" : "openai",
      model,
      correlationId: input.correlationId,
      policyProvenance: assistantPolicy.provenance,
      ...(routeDecision === null ? {} : { routeDecision }),
    });
  } catch (error) {
    await persistTerminalStreamResult({
      runtime: input.runtime,
      userId: input.userId,
      conversationId: input.conversationId,
      generation,
      correlationId: input.correlationId,
      provider,
      model,
      partialText: "",
      status: "failed",
      reason: "RESPONSE_RUN_START_FAILED",
      retryable: true,
      executionMs: 0,
    }).catch(() => undefined);
    throw error;
  }
  const started = performance.now();
  const previousResponseId =
    provider.providerKey === "openai"
      ? [...history]
          .reverse()
          .find(
            (message) =>
              message.role === "assistant" &&
              message.provider === "openai" &&
              message.model === model &&
              message.responseStatus === "completed" &&
              message.providerResponseId,
          )?.providerResponseId
      : undefined;
  let partialText = "";
  let startedResponseId: string | undefined;
  let startedModel = model;
  let terminalPersisted = false;
  try {
    const inputFiles = await prepareAuthorizedInputFiles({
      runtime: input.runtime,
      userId: input.userId,
      conversationId: input.conversationId,
      inputArtifactIds: input.inputArtifactIds,
      provider,
      timeoutMs: settings.requestTimeoutMs,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const registeredTools =
      provider.providerKey === "openai" && routeDecision
        ? BEA_GENERATED_ARTIFACT_TOOLS.filter((tool) =>
            routeDecision.toolAllowlist.includes(tool.name),
          )
        : BEA_GENERATED_ARTIFACT_TOOLS;
    for await (const event of provider.streamResponse({
      model,
      input: normalized,
      history: history.map((message) => ({ role: message.role, content: message.content })),
      ...(previousResponseId === undefined ? {} : { previousResponseId }),
      instructions: [
        provider.providerKey === "demo"
          ? assistantPolicy.internalInstructions
          : assistantPolicy.providerInstructions,
        workspaceSelection && selectedEvidence
          ? selectedEvidenceInstructions(selectedEvidence)
          : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      persona: {
        kind: assistantPolicy.persona.kind,
        preferredName: assistantPolicy.persona.preferredName,
      },
      tools: registeredTools,
      builtInTools,
      files: inputFiles,
      ...(routeDecision === null ? {} : { routeDecision }),
      options: {
        requestId,
        correlationId: input.correlationId,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        timeoutMs: builtInTools.some((tool) => tool.type === "web_search")
          ? Math.min(timeoutMs, settings.maxResearchDurationSeconds * 1_000)
          : timeoutMs,
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        userSafetyIdentifier: createHash("sha256")
          .update(`bea-responses:${input.userId}`)
          .digest("hex"),
      },
    })) {
      if (event.type === "response.started") {
        startedResponseId = event.providerResponseId;
        startedModel = event.model;
      }
      if (event.type === "response.output_text.delta" && partialText.length < 20_000) {
        partialText += event.delta.slice(0, 20_000 - partialText.length);
      }
      if (event.type === "response.completed") {
        const providerGeneratedArtifacts = await prepareProviderGeneratedArtifacts({
          runtime: input.runtime,
          userId: input.userId,
          provider,
          result: event.result,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        const preparedWorkspaceArtifact = await prepareWorkspaceArtifact({
          runtime: input.runtime,
          userId: input.userId,
          conversationId: input.conversationId,
          correlationId: input.correlationId,
          requestId,
          responseRunId: responseRun.id,
          requestMessage: normalized,
          inputMode: input.inputMode,
          provider,
          result: event.result,
          policyProvenance: assistantPolicy.provenance,
        });
        const generatedManifest = providerGeneratedArtifacts.find(
          (candidate) => candidate.manifest !== null,
        )?.manifest;
        const workspaceArtifact = generatedManifest
          ? {
              manifest: generatedManifest,
              requiredPermissions: [PERMISSIONS.AI_COMMAND_VIEW, PERMISSIONS.DOCUMENTS_VIEW],
            }
          : preparedWorkspaceArtifact;
        const persistenceStatus = await persistCompletedResult({
          runtime: input.runtime,
          userId: input.userId,
          conversationId: input.conversationId,
          generation,
          correlationId: input.correlationId,
          responseRunId: responseRun.id,
          query: normalized,
          provider,
          result: event.result,
          executionMs: Math.max(0, Math.round(performance.now() - started)),
          workspaceArtifact,
          providerGeneratedArtifacts,
          policyProvenance: assistantPolicy.provenance,
        });
        if (persistenceStatus === "superseded") {
          terminalPersisted = true;
          yield { type: "response.cancelled", requestId };
          return;
        }
        terminalPersisted = true;
        await input.runtime.repository.record({
          eventType: "ai-provider.response-completed",
          action: "ai-command.stream",
          outcome: "succeeded",
          actorUserId: input.userId,
          resourceType: "ai-response-run",
          resourceId: responseRun.id,
          correlationId: input.correlationId,
          metadata: {
            provider: provider.providerKey,
            model: event.result.model,
            simulated: event.result.simulated,
            citationCount: event.result.citations.length,
            fileSourceCount: event.result.fileSources?.length ?? 0,
            fileSourceProvenance: (event.result.fileSources ?? []).slice(0, 50).map((source) => ({
              fileId: source.fileId,
              filename: source.filename,
              ...(source.vectorStoreId === undefined
                ? {}
                : { vectorStoreId: source.vectorStoreId }),
              ...(source.score === undefined ? {} : { score: source.score }),
              retrievedAt: source.retrievedAt,
            })),
            toolCallCount: event.result.toolCalls.length,
            inputMode: input.inputMode,
            policyProvenance: assistantPolicy.provenance,
            selectedEvidenceIds: [...(selectedEvidence?.evidenceIds ?? [])],
          },
        });
        yield {
          type: "response.completed",
          result: compactAiCommandCompletionResult(event.result),
        };
        return;
      }
      if (event.type === "response.cancelled" || event.type === "response.error") {
        const terminalStatus = event.type === "response.cancelled" ? "cancelled" : "incomplete";
        const reason = event.type === "response.error" ? event.code : "CANCELLED";
        const terminalStatusResult = await persistTerminalStreamResult({
          runtime: input.runtime,
          userId: input.userId,
          conversationId: input.conversationId,
          generation,
          correlationId: input.correlationId,
          provider,
          model: startedModel,
          ...(startedResponseId === undefined ? {} : { providerResponseId: startedResponseId }),
          partialText,
          status: terminalStatus,
          reason,
          retryable: event.type === "response.error" && event.retryable,
          executionMs: Math.max(0, Math.round(performance.now() - started)),
        });
        await input.runtime.ai.persistence.completeResponseRun({
          id: responseRun.id,
          requestedByUserId: input.userId,
          status:
            terminalStatusResult === "superseded"
              ? "cancelled"
              : event.type === "response.cancelled"
                ? "cancelled"
                : "incomplete",
          ...(startedResponseId === undefined ? {} : { providerResponseId: startedResponseId }),
          ...(event.type === "response.error" ? { errorCode: event.code } : {}),
        });
        terminalPersisted = true;
        yield terminalStatusResult === "superseded"
          ? { type: "response.cancelled", requestId }
          : event;
        return;
      }
      yield event;
    }
    if (!terminalPersisted) {
      await persistTerminalStreamResult({
        runtime: input.runtime,
        userId: input.userId,
        conversationId: input.conversationId,
        generation,
        correlationId: input.correlationId,
        provider,
        model: startedModel,
        ...(startedResponseId === undefined ? {} : { providerResponseId: startedResponseId }),
        partialText,
        status: "incomplete",
        reason: "INCOMPLETE_STREAM",
        retryable: true,
        executionMs: Math.max(0, Math.round(performance.now() - started)),
      });
      await input.runtime.ai.persistence.completeResponseRun({
        id: responseRun.id,
        requestedByUserId: input.userId,
        status: "incomplete",
        ...(startedResponseId === undefined ? {} : { providerResponseId: startedResponseId }),
        errorCode: "INCOMPLETE_STREAM",
      });
    }
  } catch (error) {
    if (!terminalPersisted) {
      try {
        await persistTerminalStreamResult({
          runtime: input.runtime,
          userId: input.userId,
          conversationId: input.conversationId,
          generation,
          correlationId: input.correlationId,
          provider,
          model: startedModel,
          ...(startedResponseId === undefined ? {} : { providerResponseId: startedResponseId }),
          partialText,
          status: input.signal?.aborted ? "cancelled" : "failed",
          reason: input.signal?.aborted ? "CANCELLED" : "PROVIDER_STREAM_FAILED",
          retryable: !input.signal?.aborted,
          executionMs: Math.max(0, Math.round(performance.now() - started)),
        });
      } catch {
        // Preserve the original provider/persistence failure while the response run is closed below.
      }
    }
    await input.runtime.ai.persistence
      .completeResponseRun({
        id: responseRun.id,
        requestedByUserId: input.userId,
        status: input.signal?.aborted ? "cancelled" : "failed",
        errorCode: input.signal?.aborted ? "CANCELLED" : "PROVIDER_STREAM_FAILED",
      })
      .catch(() => null);
    throw error;
  }
}
