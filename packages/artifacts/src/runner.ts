import { createHash } from "node:crypto";

import {
  ArtifactStoreError,
  ArtifactValidationError,
  type ArtifactManifest,
  type ChartArtifactManifest,
  type ImageArtifactManifest,
  type PdfArtifactManifest,
  type SourceBoardArtifactManifest,
  type StoredArtifactContent,
  type StoredArtifactFile,
  type TableArtifactManifest,
} from "./contracts.js";
import {
  DEMO_ARTIFACT_CHART,
  DEMO_ARTIFACT_CITATIONS,
  DEMO_ARTIFACT_GENERATED_AT,
  DEMO_ARTIFACT_TABLE,
  createDemoBeaPdfInput,
  createDemoInspectionImagePng,
} from "./demo-fixtures.js";
import { normalizeArtifactManifest } from "./manifest.js";
import { composeBeaPdf, type BeaPdfCompositionOptions } from "./pdf.js";
import { MAXIMUM_GENERATED_ARTIFACT_BYTES } from "./uploads.js";

export const DEMO_ARTIFACT_TOOL_DEFINITION = {
  description:
    "Create the deterministic Demo Mode BEA research source board, comparison chart, and branded PDF artifact bundle.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      conversationId: {
        description: "The owning BEA conversation UUID.",
        type: "string",
      },
      inputMode: {
        description: "Text input or the explicitly simulated voice path.",
        enum: ["text", "simulated_voice"],
        type: "string",
      },
      prompt: {
        description: "The artifact request, limited to 2,000 characters.",
        maxLength: 2_000,
        minLength: 1,
        type: "string",
      },
    },
    required: ["conversationId", "inputMode", "prompt"],
    type: "object",
  },
  name: "bea_create_demo_artifact_bundle",
  strict: true,
} as const;

export type DemoArtifactInputMode = "simulated_voice" | "text";

export interface DemoArtifactToolArguments {
  readonly conversationId: string;
  readonly inputMode: DemoArtifactInputMode;
  readonly prompt: string;
}

export interface DemoArtifactRunnerContext {
  readonly correlationId: string;
  readonly ownerId: string;
  readonly requestId: string;
  readonly responseRunId?: string;
}

export interface DemoArtifactRunnerInvocation {
  readonly arguments: DemoArtifactToolArguments;
  readonly context: DemoArtifactRunnerContext;
  readonly toolName: typeof DEMO_ARTIFACT_TOOL_DEFINITION.name;
}

export interface DemoArtifactGenerationBundle {
  readonly comparisonChart: ChartArtifactManifest;
  readonly context: DemoArtifactRunnerContext;
  readonly file: StoredArtifactFile;
  readonly image: ImageArtifactManifest;
  readonly imageFile: StoredArtifactFile;
  readonly input: DemoArtifactToolArguments;
  readonly pdf: PdfArtifactManifest;
  readonly sourceBoard: SourceBoardArtifactManifest;
  readonly table: TableArtifactManifest;
}

export interface DemoArtifactGenerationPersistence {
  persist(bundle: DemoArtifactGenerationBundle): Promise<{ readonly generatedArtifactId: string }>;
  reopen(
    ownerId: string,
    artifactFileId: string,
  ): Promise<{
    readonly generatedArtifactId: string;
    readonly manifest: ArtifactManifest;
  } | null>;
}

export interface DemoArtifactRunnerAuditEvent {
  readonly action: "demo-artifact.generate" | "demo-artifact.reopen";
  readonly artifactFileId?: string;
  readonly correlationId: string;
  readonly errorCode?: string;
  readonly generatedArtifactId?: string;
  readonly inputMode?: DemoArtifactInputMode;
  readonly outcome: "allowed" | "denied" | "failed" | "succeeded";
  readonly ownerId: string;
}

export interface DemoArtifactRunnerAuditSink {
  record(event: DemoArtifactRunnerAuditEvent): Promise<void>;
}

export interface DemoArtifactUsageEvent {
  readonly citationCount: number;
  readonly correlationId: string;
  readonly inputCharacters: number;
  readonly inputMode: DemoArtifactInputMode;
  readonly operation: "artifact.demo.generate";
  readonly outputBytes: number;
  readonly ownerId: string;
  readonly responseRunId?: string;
  readonly simulated: true;
}

export type DemoArtifactAuthorizationRequest =
  | {
      readonly action: "generate";
      readonly conversationId: string;
      readonly ownerId: string;
    }
  | {
      readonly action: "reopen";
      readonly artifactFileId: string;
      readonly ownerId: string;
    };

export interface DemoArtifactRunnerAuthorization {
  authorize(request: DemoArtifactAuthorizationRequest): Promise<boolean>;
}

export interface DemoArtifactUsageSink {
  record(event: DemoArtifactUsageEvent): Promise<void>;
}

export interface ArtifactRunnerFileStore {
  delete(ownerId: string, id: string): Promise<void>;
  get(ownerId: string, id: string): Promise<StoredArtifactContent>;
  put(
    ownerId: string,
    input: { readonly bytes: Uint8Array; readonly filename: string; readonly mimeType: string },
  ): Promise<StoredArtifactFile>;
}

export interface DemoArtifactRunnerOptions {
  readonly audit: DemoArtifactRunnerAuditSink;
  readonly authorization: DemoArtifactRunnerAuthorization;
  readonly fileStore: ArtifactRunnerFileStore;
  readonly maxGeneratedFileBytes: number;
  readonly pdf: BeaPdfCompositionOptions;
  readonly persistence: DemoArtifactGenerationPersistence;
  readonly usage: DemoArtifactUsageSink;
}

export interface DemoArtifactRunnerResult extends DemoArtifactGenerationBundle {
  readonly completionAuditRecorded: boolean;
  readonly generatedArtifactId: string;
}

export interface ReopenedDemoArtifact {
  readonly content: StoredArtifactContent;
  readonly generatedArtifactId: string;
  readonly manifest: ArtifactManifest;
}

export class DemoArtifactRunnerError extends Error {
  constructor(
    readonly code:
      | "DEMO_ARTIFACT_AUDIT_FAILED"
      | "DEMO_ARTIFACT_FILE_TOO_LARGE"
      | "DEMO_ARTIFACT_GENERATION_FAILED"
      | "DEMO_ARTIFACT_NOT_FOUND"
      | "DEMO_ARTIFACT_PERMISSION_DENIED"
      | "DEMO_ARTIFACT_PERSISTENCE_FAILED"
      | "DEMO_ARTIFACT_USAGE_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "DemoArtifactRunnerError";
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const requestKeyPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;

function stableArtifactId(...values: readonly string[]): string {
  const hash = createHash("sha256");
  for (const value of values) hash.update(value).update("\0");
  return `art_${hash.digest("hex").slice(0, 32)}`;
}

function artifactFileReference(file: StoredArtifactFile) {
  return {
    filename: file.filename,
    id: file.id,
    mimeType: file.mimeType,
    sha256: file.sha256,
    size: file.size,
  };
}

function normalizeInvocation(value: DemoArtifactRunnerInvocation): DemoArtifactRunnerInvocation {
  if (value.toolName !== DEMO_ARTIFACT_TOOL_DEFINITION.name) {
    throw new ArtifactValidationError("INVALID_TOOL", "Artifact tool is not registered.");
  }
  const ownerId = value.context.ownerId.trim().toLowerCase();
  const conversationId = value.arguments.conversationId.trim().toLowerCase();
  if (!uuidPattern.test(ownerId) || !uuidPattern.test(conversationId)) {
    throw new ArtifactValidationError(
      "INVALID_TOOL_INPUT",
      "Artifact owner or conversation identity is invalid.",
    );
  }
  const correlationId = value.context.correlationId.trim();
  const requestId = value.context.requestId.trim();
  if (!requestKeyPattern.test(correlationId) || !requestKeyPattern.test(requestId)) {
    throw new ArtifactValidationError(
      "INVALID_TOOL_INPUT",
      "Artifact request identity is invalid.",
    );
  }
  if (
    value.context.responseRunId !== undefined &&
    !uuidPattern.test(value.context.responseRunId.trim().toLowerCase())
  ) {
    throw new ArtifactValidationError(
      "INVALID_TOOL_INPUT",
      "Artifact response run identity is invalid.",
    );
  }
  if (!(value.arguments.inputMode === "text" || value.arguments.inputMode === "simulated_voice")) {
    throw new ArtifactValidationError("INVALID_TOOL_INPUT", "Artifact input mode is unsupported.");
  }
  const prompt = value.arguments.prompt.trim().replace(/\s+/gu, " ");
  if (prompt.length === 0 || prompt.length > 2_000) {
    throw new ArtifactValidationError(
      "INVALID_TOOL_INPUT",
      "Artifact prompt must contain 1 to 2,000 characters.",
    );
  }
  return {
    arguments: { conversationId, inputMode: value.arguments.inputMode, prompt },
    context: {
      correlationId,
      ownerId,
      requestId,
      ...(value.context.responseRunId === undefined
        ? {}
        : { responseRunId: value.context.responseRunId.trim().toLowerCase() }),
    },
    toolName: DEMO_ARTIFACT_TOOL_DEFINITION.name,
  };
}

function manifestBase(input: {
  readonly artifactId: string;
  readonly disclosure?: string;
  readonly ownerId: string;
  readonly summary: string;
  readonly title: string;
}) {
  return {
    artifactId: input.artifactId,
    citations: DEMO_ARTIFACT_CITATIONS,
    createdAt: DEMO_ARTIFACT_GENERATED_AT,
    disclosure:
      input.disclosure ??
      "DEMO MODE - deterministic synthetic records; no live BEA or provider data was used.",
    ownerId: input.ownerId,
    schemaVersion: 1 as const,
    summary: input.summary,
    title: input.title,
  };
}

function tableManifest(ownerId: string, conversationId: string): TableArtifactManifest {
  return normalizeArtifactManifest({
    ...manifestBase({
      artifactId: stableArtifactId(ownerId, conversationId, "table"),
      ownerId,
      summary: "Synthetic comparison table used for deterministic artifact rendering.",
      title: DEMO_ARTIFACT_TABLE.title,
    }),
    renderer: "table",
    table: DEMO_ARTIFACT_TABLE,
  }) as TableArtifactManifest;
}

function imageManifest(ownerId: string, imageFile: StoredArtifactFile): ImageArtifactManifest {
  return normalizeArtifactManifest({
    ...manifestBase({
      artifactId: imageFile.id,
      disclosure:
        "SIMULATED AI-GENERATED IMAGE FIXTURE - deterministic illustration, not a field photograph or live provider output.",
      ownerId,
      summary:
        "Explicitly labeled simulated AI-generated building-elevation illustration for Demo Mode.",
      title: "Simulated AI-generated inspection image",
    }),
    altText:
      "Simulated AI-generated building elevation diagram with a highlighted synthetic inspection bay",
    file: artifactFileReference(imageFile),
    renderer: "image",
  }) as ImageArtifactManifest;
}

function sourceBoardManifest(ownerId: string, conversationId: string): SourceBoardArtifactManifest {
  return normalizeArtifactManifest({
    ...manifestBase({
      artifactId: stableArtifactId(ownerId, conversationId, "source-board"),
      ownerId,
      summary: "Synthetic source board used to demonstrate cited artifact generation.",
      title: "Synthetic envelope source board",
    }),
    renderer: "source-board",
    sources: DEMO_ARTIFACT_CITATIONS,
  }) as SourceBoardArtifactManifest;
}

function comparisonChartManifest(ownerId: string, conversationId: string): ChartArtifactManifest {
  const chart = {
    ...DEMO_ARTIFACT_CHART,
    title: "Synthetic envelope-system comparison",
    type: "comparison" as const,
  };
  return normalizeArtifactManifest({
    ...manifestBase({
      artifactId: stableArtifactId(ownerId, conversationId, "comparison-chart"),
      ownerId,
      summary: "Synthetic comparison of fixed envelope-system finding counts.",
      title: "Synthetic envelope-system comparison",
    }),
    chart,
    renderer: "chart",
  }) as ChartArtifactManifest;
}

async function bestEffortFailureAudit(
  audit: DemoArtifactRunnerAuditSink,
  input: DemoArtifactRunnerAuditEvent,
): Promise<void> {
  try {
    await audit.record(input);
  } catch {
    // The original failure remains authoritative; the caller receives a fail-closed result.
  }
}

export class DemoArtifactApplicationRunner {
  constructor(private readonly options: DemoArtifactRunnerOptions) {
    if (
      !Number.isSafeInteger(options.maxGeneratedFileBytes) ||
      options.maxGeneratedFileBytes < 1_024 ||
      options.maxGeneratedFileBytes > MAXIMUM_GENERATED_ARTIFACT_BYTES
    ) {
      throw new ArtifactValidationError(
        "INVALID_GENERATED_FILE_LIMIT",
        `Generated artifact size must be between 1,024 and ${MAXIMUM_GENERATED_ARTIFACT_BYTES} bytes.`,
      );
    }
  }

  #assertGeneratedFileSize(bytes: Uint8Array): void {
    if (bytes.length > this.options.maxGeneratedFileBytes) {
      throw new DemoArtifactRunnerError(
        "DEMO_ARTIFACT_FILE_TOO_LARGE",
        "Generated artifact exceeds the configured size limit.",
      );
    }
  }

  async run(invocationInput: DemoArtifactRunnerInvocation): Promise<DemoArtifactRunnerResult> {
    const invocation = normalizeInvocation(invocationInput);
    const { context, arguments: input } = invocation;
    if (
      !(await this.options.authorization.authorize({
        action: "generate",
        conversationId: input.conversationId,
        ownerId: context.ownerId,
      }))
    ) {
      await bestEffortFailureAudit(this.options.audit, {
        action: "demo-artifact.generate",
        correlationId: context.correlationId,
        inputMode: input.inputMode,
        outcome: "denied",
        ownerId: context.ownerId,
      });
      throw new DemoArtifactRunnerError(
        "DEMO_ARTIFACT_PERMISSION_DENIED",
        "Artifact was not found.",
      );
    }
    try {
      await this.options.audit.record({
        action: "demo-artifact.generate",
        correlationId: context.correlationId,
        inputMode: input.inputMode,
        outcome: "allowed",
        ownerId: context.ownerId,
      });
    } catch {
      throw new DemoArtifactRunnerError(
        "DEMO_ARTIFACT_AUDIT_FAILED",
        "Artifact generation could not begin because auditing is unavailable.",
      );
    }

    let file: StoredArtifactFile | undefined;
    let imageFile: StoredArtifactFile | undefined;
    try {
      const sourceBoard = sourceBoardManifest(context.ownerId, input.conversationId);
      const comparisonChart = comparisonChartManifest(context.ownerId, input.conversationId);
      const table = tableManifest(context.ownerId, input.conversationId);
      const imageBytes = createDemoInspectionImagePng();
      this.#assertGeneratedFileSize(imageBytes);
      imageFile = await this.options.fileStore.put(context.ownerId, {
        bytes: imageBytes,
        filename: "bea-simulated-ai-generated-inspection.png",
        mimeType: "image/png",
      });
      const image = imageManifest(context.ownerId, imageFile);
      const pdfBytes = await composeBeaPdf(createDemoBeaPdfInput(), this.options.pdf);
      this.#assertGeneratedFileSize(pdfBytes);
      file = await this.options.fileStore.put(context.ownerId, {
        bytes: pdfBytes,
        filename: "bea-synthetic-envelope-review.pdf",
        mimeType: "application/pdf",
      });
      const normalizedPdf = normalizeArtifactManifest({
        ...manifestBase({
          artifactId: file.id,
          ownerId: context.ownerId,
          summary:
            "Deterministic BEA-branded PDF with synthetic findings, comparison data, citations, and disclosure.",
          title: "Synthetic Building Envelope Review",
        }),
        file: artifactFileReference(file),
        renderer: "pdf",
      });
      if (normalizedPdf.renderer !== "pdf") {
        throw new ArtifactValidationError(
          "INVALID_MANIFEST",
          "Demo PDF manifest did not normalize as a PDF artifact.",
        );
      }
      const pdf = normalizedPdf;
      try {
        await this.options.usage.record({
          citationCount: pdf.citations.length,
          correlationId: context.correlationId,
          inputCharacters: input.prompt.length,
          inputMode: input.inputMode,
          operation: "artifact.demo.generate",
          outputBytes: pdf.file.size + imageFile.size,
          ownerId: context.ownerId,
          ...(context.responseRunId === undefined ? {} : { responseRunId: context.responseRunId }),
          simulated: true,
        });
      } catch {
        throw new DemoArtifactRunnerError(
          "DEMO_ARTIFACT_USAGE_FAILED",
          "Artifact usage recording did not complete.",
        );
      }
      const bundle: DemoArtifactGenerationBundle = {
        comparisonChart,
        context,
        file,
        image,
        imageFile,
        input,
        pdf,
        sourceBoard,
        table,
      };
      let persisted: { readonly generatedArtifactId: string };
      try {
        persisted = await this.options.persistence.persist(bundle);
      } catch {
        throw new DemoArtifactRunnerError(
          "DEMO_ARTIFACT_PERSISTENCE_FAILED",
          "Artifact generation could not be persisted.",
        );
      }
      let completionAuditRecorded = true;
      try {
        await this.options.audit.record({
          action: "demo-artifact.generate",
          artifactFileId: file.id,
          correlationId: context.correlationId,
          generatedArtifactId: persisted.generatedArtifactId,
          inputMode: input.inputMode,
          outcome: "succeeded",
          ownerId: context.ownerId,
        });
      } catch {
        completionAuditRecorded = false;
      }
      return {
        ...bundle,
        completionAuditRecorded,
        generatedArtifactId: persisted.generatedArtifactId,
      };
    } catch (error) {
      for (const stored of [file, imageFile]) {
        if (stored !== undefined) {
          try {
            await this.options.fileStore.delete(context.ownerId, stored.id);
          } catch {
            // Cleanup failure is reported by the failure audit without exposing a local path.
          }
        }
      }
      const code =
        error instanceof DemoArtifactRunnerError ? error.code : "DEMO_ARTIFACT_GENERATION_FAILED";
      await bestEffortFailureAudit(this.options.audit, {
        action: "demo-artifact.generate",
        ...(file === undefined ? {} : { artifactFileId: file.id }),
        correlationId: context.correlationId,
        errorCode: code,
        inputMode: input.inputMode,
        outcome: "failed",
        ownerId: context.ownerId,
      });
      if (error instanceof DemoArtifactRunnerError) throw error;
      throw new DemoArtifactRunnerError(
        "DEMO_ARTIFACT_GENERATION_FAILED",
        "Artifact generation did not complete.",
      );
    }
  }

  async reopen(input: {
    readonly artifactFileId: string;
    readonly correlationId: string;
    readonly ownerId: string;
  }): Promise<ReopenedDemoArtifact> {
    const ownerId = input.ownerId.trim().toLowerCase();
    if (!uuidPattern.test(ownerId) || !requestKeyPattern.test(input.correlationId)) {
      throw new DemoArtifactRunnerError("DEMO_ARTIFACT_NOT_FOUND", "Artifact was not found.");
    }
    if (
      !(await this.options.authorization.authorize({
        action: "reopen",
        artifactFileId: input.artifactFileId,
        ownerId,
      }))
    ) {
      await bestEffortFailureAudit(this.options.audit, {
        action: "demo-artifact.reopen",
        artifactFileId: input.artifactFileId,
        correlationId: input.correlationId,
        outcome: "denied",
        ownerId,
      });
      throw new DemoArtifactRunnerError("DEMO_ARTIFACT_NOT_FOUND", "Artifact was not found.");
    }
    const persisted = await this.options.persistence.reopen(ownerId, input.artifactFileId);
    if (!persisted) {
      await bestEffortFailureAudit(this.options.audit, {
        action: "demo-artifact.reopen",
        artifactFileId: input.artifactFileId,
        correlationId: input.correlationId,
        outcome: "denied",
        ownerId,
      });
      throw new DemoArtifactRunnerError("DEMO_ARTIFACT_NOT_FOUND", "Artifact was not found.");
    }
    let content: StoredArtifactContent;
    try {
      content = await this.options.fileStore.get(ownerId, input.artifactFileId);
    } catch (error) {
      if (error instanceof ArtifactStoreError) {
        throw new DemoArtifactRunnerError("DEMO_ARTIFACT_NOT_FOUND", "Artifact was not found.");
      }
      throw error;
    }
    await this.options.audit.record({
      action: "demo-artifact.reopen",
      artifactFileId: input.artifactFileId,
      correlationId: input.correlationId,
      generatedArtifactId: persisted.generatedArtifactId,
      outcome: "succeeded",
      ownerId,
    });
    return { content, ...persisted };
  }
}
