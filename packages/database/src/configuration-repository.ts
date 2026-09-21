import { randomUUID } from "node:crypto";
import type {
  ConfigurationArtifact,
  ConfigurationArtifactKind,
  ConfigurationIntakeItem,
  ConfigurationReadinessItem,
  ConfigurationRelease,
  ConfigurationReleaseStatus,
  ConfigurationValidationRun,
  IngestionStagingRun,
  JsonObject,
  SafeStagingError,
} from "@bea/domain";
import type { DatabaseAdapter, SqlExecutor } from "./adapter.js";
import { hashJson, iso, jsonValue, nullableIso, nullableString } from "./operations-repository.js";

type Row = Record<string, unknown>;

export function mapConfigurationRelease(row: Row): ConfigurationRelease {
  return {
    id: String(row.id),
    familyKey: String(row.family_key),
    displayName: String(row.display_name),
    versionNumber: Number(row.version_number),
    status: row.status as ConfigurationReleaseStatus,
    synthetic: row.synthetic === true || row.synthetic === "t",
    productionReady: row.production_ready === true || row.production_ready === "t",
    serviceContextKey: String(row.service_context_key),
    description: String(row.description),
    disclosure: String(row.disclosure),
    parentReleaseId: nullableString(row.parent_release_id),
    checksum: nullableString(row.checksum),
    validatedIdentityChecksum: nullableString(row.validated_identity_checksum),
    createdByUserId: String(row.created_by_user_id),
    validatedAt: nullableIso(row.validated_at),
    validatedByUserId: nullableString(row.validated_by_user_id),
    publishedAt: nullableIso(row.published_at),
    publishedByUserId: nullableString(row.published_by_user_id),
    activatedAt: nullableIso(row.activated_at),
    activatedByUserId: nullableString(row.activated_by_user_id),
    archivedAt: nullableIso(row.archived_at),
    archivedByUserId: nullableString(row.archived_by_user_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

export function mapConfigurationArtifact(row: Row): ConfigurationArtifact {
  return {
    id: String(row.id),
    releaseId: String(row.release_id),
    artifactKind: row.artifact_kind as ConfigurationArtifactKind,
    artifactKey: String(row.artifact_key),
    payload: jsonValue(row.payload, {}),
    checksum: String(row.checksum),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function mapValidationRun(row: Row): ConfigurationValidationRun {
  return {
    id: String(row.id),
    releaseId: String(row.release_id),
    passed: row.passed === true || row.passed === "t",
    blocking: jsonValue(row.blocking, []),
    warnings: jsonValue(row.warnings, []),
    actorUserId: nullableString(row.actor_user_id),
    createdAt: iso(row.created_at),
  };
}

export function mapReadinessItem(row: Row): ConfigurationReadinessItem {
  return {
    id: String(row.id),
    gapKey: String(row.gap_key),
    area: String(row.area),
    description: String(row.description),
    currentSyntheticBehavior: String(row.current_synthetic_behavior),
    whyConfirmationRequired: String(row.why_confirmation_required),
    blockingStage: String(row.blocking_stage),
    responsiblePerson: String(row.responsible_person),
    targetMeeting: String(row.target_meeting),
    status: row.status as ConfigurationReadinessItem["status"],
    resolution: nullableString(row.resolution),
    configurationArtifactKind:
      (row.configuration_artifact_kind as ConfigurationArtifactKind) ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

export function mapIntakeItem(row: Row): ConfigurationIntakeItem {
  return {
    id: String(row.id),
    questionKey: String(row.question_key),
    sectionKey: String(row.section_key),
    prompt: String(row.prompt),
    status: row.status as ConfigurationIntakeItem["status"],
    answer: nullableString(row.answer),
    notes: nullableString(row.notes),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

export function mapStagingRun(row: Row): IngestionStagingRun {
  const lastError = jsonValue<SafeStagingError | null>(row.last_error, null);
  const rawByte =
    row.raw_source_byte_length === null || row.raw_source_byte_length === undefined
      ? null
      : Number(row.raw_source_byte_length);
  return {
    id: String(row.id),
    sourceType: String(row.source_type),
    sourceSystemLabel: nullableString(row.source_system_label),
    sourceSchemaVersion: nullableString(row.source_schema_version),
    sourceTimestamp: nullableIso(row.source_timestamp),
    sourceIdentity: String(row.source_identity),
    payloadSha256: String(row.payload_sha256),
    rawRepresentation: jsonValue(row.raw_representation, {}),
    rawSourceText: nullableString(row.raw_source_text),
    rawSourceSha256: nullableString(row.raw_source_sha256),
    rawSourceByteLength: rawByte !== null && Number.isFinite(rawByte) ? rawByte : null,
    inspectionId: nullableString(row.inspection_id),
    sourceIdempotencyKey: nullableString(row.source_idempotency_key),
    lastError:
      lastError && typeof lastError === "object"
        ? {
            code: String(lastError.code ?? "STAGING_FAILED"),
            retryable: lastError.retryable === true,
            correlationId: String(lastError.correlationId ?? ""),
            failureStage: String(lastError.failureStage ?? "unknown"),
          }
        : null,
    finalizedAt: nullableIso(row.finalized_at),
    mappingProfileKey: nullableString(row.mapping_profile_key),
    configurationReleaseId: nullableString(row.configuration_release_id),
    dryRun: row.dry_run === true || row.dry_run === "t",
    status: row.status as IngestionStagingRun["status"],
    mappingReport: jsonValue(row.mapping_report, null),
    validationPreview: jsonValue(row.validation_preview, null),
    committedSubmissionId: nullableString(row.committed_submission_id),
    actorUserId: nullableString(row.actor_user_id),
    classificationWarnings: jsonValue(row.classification_warnings, []),
    createdAt: iso(row.created_at),
    updatedAt: nullableIso(row.updated_at),
  };
}

export function projectStagingRun(
  run: IngestionStagingRun,
  includeSensitiveSource: boolean,
): IngestionStagingRun {
  if (includeSensitiveSource) return run;
  const mapping = run.mappingReport;
  const validation = run.validationPreview;
  return {
    ...run,
    rawSourceText: null,
    rawRepresentation: { redacted: true },
    mappingReport: mapping
      ? {
          humanReadable: Array.isArray((mapping as { humanReadable?: unknown }).humanReadable)
            ? (mapping as { humanReadable: string[] }).humanReadable
            : [],
          blockingIssueCount: Array.isArray(
            (mapping as { blockingIssues?: unknown }).blockingIssues,
          )
            ? (mapping as { blockingIssues: unknown[] }).blockingIssues.length
            : 0,
        }
      : null,
    validationPreview: validation
      ? {
          passed: (validation as { passed?: unknown }).passed === true,
          blockingCount: Array.isArray((validation as { blocking?: unknown }).blocking)
            ? (validation as { blocking: unknown[] }).blocking.length
            : 0,
          warningCount: Array.isArray((validation as { warnings?: unknown }).warnings)
            ? (validation as { warnings: unknown[] }).warnings.length
            : 0,
        }
      : null,
  };
}

export function artifactChecksum(payload: JsonObject): string {
  return hashJson(payload);
}

export class SqlConfigurationRepository {
  constructor(private readonly database: DatabaseAdapter) {}

  async listReleases(): Promise<readonly ConfigurationRelease[]> {
    const result = await this.database.query<Row>(
      `SELECT * FROM configuration_releases
       ORDER BY family_key, version_number DESC, created_at DESC`,
    );
    return result.rows.map(mapConfigurationRelease);
  }

  async getRelease(id: string): Promise<ConfigurationRelease | null> {
    const result = await this.database.query<Row>(
      "SELECT * FROM configuration_releases WHERE id=$1",
      [id],
    );
    return result.rows[0] ? mapConfigurationRelease(result.rows[0]) : null;
  }

  async getActiveRelease(serviceContextKey: string): Promise<ConfigurationRelease | null> {
    const result = await this.database.query<Row>(
      "SELECT * FROM configuration_releases WHERE service_context_key=$1 AND status='active' LIMIT 1",
      [serviceContextKey],
    );
    return result.rows[0] ? mapConfigurationRelease(result.rows[0]) : null;
  }

  async listArtifacts(releaseId: string): Promise<readonly ConfigurationArtifact[]> {
    const result = await this.database.query<Row>(
      "SELECT * FROM configuration_artifacts WHERE release_id=$1 ORDER BY artifact_kind",
      [releaseId],
    );
    return result.rows.map(mapConfigurationArtifact);
  }

  async listValidationRuns(releaseId: string): Promise<readonly ConfigurationValidationRun[]> {
    const result = await this.database.query<Row>(
      "SELECT * FROM configuration_validation_runs WHERE release_id=$1 ORDER BY created_at DESC",
      [releaseId],
    );
    return result.rows.map(mapValidationRun);
  }

  async listReadinessItems(): Promise<readonly ConfigurationReadinessItem[]> {
    const result = await this.database.query<Row>(
      "SELECT * FROM configuration_readiness_items ORDER BY area, gap_key",
    );
    return result.rows.map(mapReadinessItem);
  }

  async listIntakeItems(): Promise<readonly ConfigurationIntakeItem[]> {
    const result = await this.database.query<Row>(
      "SELECT * FROM configuration_intake_items ORDER BY section_key, question_key",
    );
    return result.rows.map(mapIntakeItem);
  }

  async listAudit(resourceId: string): Promise<readonly JsonObject[]> {
    const result = await this.database.query<Row>(
      `SELECT event_type, action, actor_user_id, metadata, created_at
         FROM audit_logs
        WHERE resource_type='configuration_release' AND resource_id=$1
        ORDER BY created_at`,
      [resourceId],
    );
    return result.rows.map((row) => ({
      eventType: String(row.event_type),
      action: String(row.action),
      actorUserId: nullableString(row.actor_user_id),
      metadata: jsonValue(row.metadata, {}),
      createdAt: iso(row.created_at),
    }));
  }

  async listStagingRuns(): Promise<readonly IngestionStagingRun[]> {
    const result = await this.database.query<Row>(
      "SELECT * FROM ingestion_staging_runs ORDER BY created_at DESC LIMIT 50",
    );
    return result.rows.map(mapStagingRun);
  }

  async getStagingRun(id: string): Promise<IngestionStagingRun | null> {
    const result = await this.database.query<Row>(
      "SELECT * FROM ingestion_staging_runs WHERE id=$1",
      [id],
    );
    return result.rows[0] ? mapStagingRun(result.rows[0]) : null;
  }
}

export async function insertArtifact(
  executor: SqlExecutor,
  input: {
    readonly releaseId: string;
    readonly kind: ConfigurationArtifactKind;
    readonly artifactKey: string;
    readonly payload: JsonObject;
    readonly now: string;
  },
): Promise<ConfigurationArtifact> {
  const checksum = artifactChecksum(input.payload);
  const result = await executor.query<Row>(
    `INSERT INTO configuration_artifacts
     (id,release_id,artifact_kind,artifact_key,payload,checksum,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$7)
     ON CONFLICT (release_id, artifact_kind) DO UPDATE SET
       artifact_key=EXCLUDED.artifact_key,
       payload=EXCLUDED.payload,
       checksum=EXCLUDED.checksum,
       updated_at=EXCLUDED.updated_at
     RETURNING *`,
    [
      randomUUID(),
      input.releaseId,
      input.kind,
      input.artifactKey,
      JSON.stringify(input.payload),
      checksum,
      input.now,
    ],
  );
  return mapConfigurationArtifact(result.rows[0] as Row);
}
