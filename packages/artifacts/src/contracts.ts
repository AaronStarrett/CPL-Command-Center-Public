export const ARTIFACT_RENDERERS = [
  "pdf",
  "image",
  "chart",
  "table",
  "data",
  "research",
  "source-board",
  "metric",
  "timeline",
  "comparison",
  "analysis",
  "error",
] as const;

export const ARTIFACT_CHART_TYPES = [
  "line",
  "bar",
  "stacked_bar",
  "area",
  "pie_or_donut",
  "scatter",
  "timeline",
  "single_metric",
  "comparison",
] as const;

export type ArtifactRenderer = (typeof ARTIFACT_RENDERERS)[number];

export const ARTIFACT_DATA_STATUSES = [
  "real",
  "synthetic",
  "partial",
  "estimated",
  "inferred",
] as const;

export type ArtifactDataStatus = (typeof ARTIFACT_DATA_STATUSES)[number];

export interface ArtifactBrandMetadata {
  readonly organization: "Cyber Pirate Labs";
  readonly policyVersion: string;
  readonly templateVersion: string;
  readonly theme: "cpl-light-premium";
  readonly renderer: ArtifactRenderer;
  readonly logoPath: "/brand/cpl-logo.png";
  readonly palette: readonly string[];
  readonly normalizedByApplication: true;
}

export interface ArtifactCitation {
  readonly accessedAt: string;
  readonly domain: string;
  readonly title: string;
  readonly url: string;
}

export interface ArtifactFileReference {
  readonly filename: string;
  readonly id: string;
  readonly mimeType: string;
  readonly sha256: string;
  readonly size: number;
}

export interface ArtifactChartData {
  readonly provenance: {
    readonly calculationNotes: string;
    readonly dataStatus: ArtifactDataStatus;
    readonly sourceDate?: string;
    readonly sourceMapping: ReadonlyArray<{
      readonly citationUrl: string;
      readonly seriesLabels: readonly string[];
    }>;
  };
  readonly series: ReadonlyArray<{
    readonly group?: string;
    readonly label: string;
    readonly secondaryValue?: number;
    readonly timestamp?: string;
    readonly value: number;
  }>;
  readonly title: string;
  readonly type: (typeof ARTIFACT_CHART_TYPES)[number];
  readonly unit?: string;
}

export interface ArtifactTableData {
  readonly columns: readonly string[];
  readonly rows: ReadonlyArray<readonly string[]>;
  readonly title: string;
}

interface ArtifactManifestBase {
  readonly artifactId: string;
  readonly citations: readonly ArtifactCitation[];
  readonly createdAt: string;
  readonly disclosure: string;
  readonly ownerId: string;
  readonly schemaVersion: 1;
  readonly summary: string;
  readonly title: string;
  readonly brand: ArtifactBrandMetadata;
}

export interface PdfArtifactManifest extends ArtifactManifestBase {
  readonly file: ArtifactFileReference;
  readonly renderer: "pdf";
}

export interface ImageArtifactManifest extends ArtifactManifestBase {
  readonly altText: string;
  readonly file: ArtifactFileReference;
  readonly renderer: "image";
}

export interface ChartArtifactManifest extends ArtifactManifestBase {
  readonly chart: ArtifactChartData;
  readonly renderer: "chart";
}

export interface TableArtifactManifest extends ArtifactManifestBase {
  readonly renderer: "table";
  readonly table: ArtifactTableData;
}

export interface DataArtifactManifest extends ArtifactManifestBase {
  readonly data: {
    readonly file: ArtifactFileReference;
    readonly format: "csv" | "docx" | "json" | "txt" | "xlsx";
    readonly recordCount: number;
  };
  readonly renderer: "data";
}

export interface ResearchArtifactManifest extends ArtifactManifestBase {
  readonly findings: readonly string[];
  readonly renderer: "research";
}

export interface SourceBoardArtifactManifest extends ArtifactManifestBase {
  readonly renderer: "source-board";
  readonly sources: readonly ArtifactCitation[];
}

export interface MetricArtifactManifest extends ArtifactManifestBase {
  readonly metric: {
    readonly label: string;
    readonly trend?: "down" | "flat" | "up";
    readonly unit?: string;
    readonly value: number;
  };
  readonly renderer: "metric";
}

export interface TimelineArtifactManifest extends ArtifactManifestBase {
  readonly events: ReadonlyArray<{
    readonly at: string;
    readonly detail: string;
    readonly title: string;
  }>;
  readonly renderer: "timeline";
}

export interface ComparisonArtifactManifest extends ArtifactManifestBase {
  readonly comparison: ArtifactTableData;
  readonly renderer: "comparison";
}

export interface AnalysisArtifactManifest extends ArtifactManifestBase {
  readonly renderer: "analysis";
  readonly sections: ReadonlyArray<{
    readonly body: string;
    readonly heading: string;
  }>;
}

export interface ErrorArtifactManifest extends ArtifactManifestBase {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
  readonly renderer: "error";
}

export type ArtifactManifest =
  | PdfArtifactManifest
  | ImageArtifactManifest
  | ChartArtifactManifest
  | TableArtifactManifest
  | DataArtifactManifest
  | ResearchArtifactManifest
  | SourceBoardArtifactManifest
  | MetricArtifactManifest
  | TimelineArtifactManifest
  | ComparisonArtifactManifest
  | AnalysisArtifactManifest
  | ErrorArtifactManifest;

export interface ArtifactUploadInput {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly mimeType: string;
}

export interface NormalizedArtifactUpload extends ArtifactUploadInput {
  readonly extension: string;
  readonly sha256: string;
  readonly size: number;
}

declare const validatedArtifactUploadBrand: unique symbol;

export type MalwareScanRequest = NormalizedArtifactUpload;

export interface MalwareScanResult {
  readonly engine: string;
  readonly mode: "connected" | "simulated";
  readonly reference?: string;
  readonly status: "clean" | "infected" | "unavailable";
}

export interface MalwareScanner {
  scan(request: MalwareScanRequest): Promise<MalwareScanResult>;
}

export interface ValidatedArtifactUpload extends NormalizedArtifactUpload {
  readonly [validatedArtifactUploadBrand]: true;
  readonly malwareScan: MalwareScanResult;
}

export interface StoredArtifactFile {
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly filename: string;
  readonly id: string;
  readonly malwareScan?: MalwareScanResult;
  readonly mimeType: string;
  readonly sha256: string;
  readonly size: number;
}

export interface StoredArtifactContent {
  readonly bytes: Uint8Array;
  readonly metadata: StoredArtifactFile;
}

export interface ArtifactCleanupResult {
  readonly deletedIds: readonly string[];
  readonly failed: ReadonlyArray<{
    readonly code: "invalid-metadata" | "delete-failed";
    readonly id: string;
  }>;
}

export interface ArtifactOrphanCleanupResult {
  readonly deletedIds: readonly string[];
  readonly deletedInvalidMetadataIds: readonly string[];
  readonly deletedTemporaryFiles: number;
  readonly failed: ReadonlyArray<{
    readonly code: "inspect-failed" | "delete-failed";
    readonly id: string;
  }>;
}

export interface ArtifactMaintenanceResult {
  readonly status: "completed" | "skipped-active";
  readonly expired: ArtifactCleanupResult;
  readonly orphans: ArtifactOrphanCleanupResult;
}

export type ArtifactWebPermission = "artifacts:download" | "artifacts:read" | "artifacts:write";

export interface ArtifactWebAuthorization {
  readonly actorId: string;
  readonly correlationId: string;
  readonly ownerId: string;
  readonly permissions: readonly ArtifactWebPermission[];
}

export interface ArtifactWebAuditEvent {
  readonly action: "download" | "preview" | "refresh" | "upload";
  readonly actorId: string;
  readonly artifactId?: string;
  readonly correlationId: string;
  readonly outcome: "allowed" | "denied" | "unavailable";
  readonly ownerId: string;
}

export interface ArtifactWebAuditSink {
  record(event: ArtifactWebAuditEvent): Promise<void>;
}

export interface ArtifactFileRecord extends StoredArtifactFile {
  readonly ownerId: string;
}

export interface ArtifactVersionRecord {
  readonly artifactId: string;
  readonly createdAt: string;
  readonly fileId?: string;
  readonly id: string;
  readonly manifest: ArtifactManifest;
  readonly ownerId: string;
  readonly version: number;
}

export interface ArtifactSourceRecord {
  readonly artifactVersionId: string;
  readonly dataStatus: ArtifactDataStatus;
  readonly fileId?: string;
  readonly id: string;
  readonly kind: "external" | "generated" | "upload";
  readonly ownerId: string;
  readonly sourceDate?: string;
  readonly title: string;
  readonly url?: string;
}

export interface ArtifactCitationRecord {
  readonly artifactVersionId: string;
  readonly citation: ArtifactCitation;
  readonly id: string;
  readonly ownerId: string;
  readonly sourceId?: string;
}

export interface ArtifactRenderSpecRecord {
  readonly artifactVersionId: string;
  readonly id: string;
  readonly manifest: ArtifactManifest;
  readonly ownerId: string;
  readonly renderer: ArtifactRenderer;
  readonly schemaVersion: 1;
}

export interface ArtifactGenerationRunRecord {
  readonly artifactVersionId?: string;
  readonly cleanupStatus: "complete" | "failed" | "not_required" | "pending";
  readonly completedAt?: string;
  readonly errorCode?: string;
  readonly id: string;
  readonly ownerId: string;
  readonly startedAt: string;
  readonly status: "failed" | "queued" | "running" | "succeeded";
}

export interface BeaPdfFinding {
  readonly detail: string;
  readonly severity: "info" | "attention" | "critical";
  readonly title: string;
}

export interface BeaPdfImageInput {
  readonly altText: string;
  readonly bytes: Uint8Array;
  readonly caption: string;
  readonly mimeType: "image/jpeg" | "image/png";
}

export interface BeaPdfDocumentInput {
  readonly chart?: ArtifactChartData;
  readonly citations: readonly ArtifactCitation[];
  readonly disclosure: string;
  readonly findings: readonly BeaPdfFinding[];
  readonly generatedAt: string;
  readonly image?: BeaPdfImageInput;
  readonly reportDate: string;
  readonly summary: string;
  readonly table?: ArtifactTableData;
  readonly title: string;
  readonly requestedBy?: string;
}

export class ArtifactValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ArtifactValidationError";
  }
}

export class ArtifactStoreError extends Error {
  readonly code: "ARTIFACT_NOT_FOUND" | "ARTIFACT_STORE_FAILURE";

  constructor(code: "ARTIFACT_NOT_FOUND" | "ARTIFACT_STORE_FAILURE", message: string) {
    super(message);
    this.code = code;
    this.name = "ArtifactStoreError";
  }
}
