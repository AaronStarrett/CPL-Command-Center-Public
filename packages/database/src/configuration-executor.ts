import { createHash, randomUUID } from "node:crypto";
import {
  applySourceMapping,
  assertInspectionStatusTransition,
  assertArtifactSafeToSave,
  assertStagingSourceSize,
  assertSyntheticReleaseExecution,
  buildReportDocument,
  buildStorageDeliveryDryRun,
  CONFIGURATION_ARTIFACT_KINDS,
  CONFIGURATION_SYNTHETIC_DISCLOSURE,
  ConfigurationActivationError,
  ConfigurationImmutabilityError,
  ConfigurationValidationError,
  configurationReleaseIdentityMaterial,
  defaultReviewPolicy,
  evaluateValidationRules,
  exportIntakePacketJson,
  exportIntakePacketMarkdown,
  hashRawSourceText,
  isIntakeStatus,
  OperationsConcurrencyError,
  OperationsNotFoundError,
  OperationsValidationError,
  parseBoundArtifacts,
  parseStagingSource,
  previewSlaDue,
  ProductionMappingNotConfiguredError,
  releaseIsEditable,
  safeStagingError,
  SEEDED_OPERATIONS_IDS,
  stagingSourceIdempotencyKey,
  StagingSourceTooLargeError,
  validateBoundPackage,
  type BoundConfigurationPackage,
  type ConfigurationArtifactKind,
  type ConfigurationRelease,
  type ConfigurationValidationIssue,
  type IngestionStagingRun,
  type Inspection,
  type JsonObject,
  type MappingEngineReport,
  type SafeStagingError,
  type StagingStatus,
} from "@bea/domain";
import { renderReportDocumentToPdf } from "@bea/automation";
import type { DatabaseAdapter, SqlExecutor } from "./adapter.js";
import {
  artifactChecksum,
  insertArtifact,
  mapConfigurationArtifact,
  mapConfigurationRelease,
  mapIntakeItem,
  mapStagingRun,
  SqlConfigurationRepository,
} from "./configuration-repository.js";
import {
  insertAutomationEvent,
  mapInspection,
  nextOperationsReference,
  recordAuditAndActivity,
} from "./operations-repository.js";
import type { WorkControlPlane } from "./work-control-executor.js";

export function computeConfigurationReleaseIdentityChecksum(input: {
  readonly releaseId: string;
  readonly versionNumber: number;
  readonly artifacts: readonly {
    readonly artifactKind: string;
    readonly artifactKey: string;
    readonly checksum: string;
  }[];
}): string {
  return createHash("sha256")
    .update(
      configurationReleaseIdentityMaterial({
        releaseId: input.releaseId,
        versionNumber: input.versionNumber,
        artifacts: input.artifacts.map((item) => ({
          artifactKind: item.artifactKind,
          artifactKey: item.artifactKey,
          payloadChecksum: item.checksum,
        })),
      }),
      "utf8",
    )
    .digest("hex");
}

function assertArtifactsMatchStoredChecksums(
  artifacts: readonly { readonly payload: JsonObject; readonly checksum: string }[],
): void {
  for (const artifact of artifacts) {
    if (artifactChecksum(artifact.payload) !== artifact.checksum) {
      throw new ConfigurationValidationError(
        "A configuration artifact checksum does not match its payload. Publication and activation are refused.",
      );
    }
  }
}

function revalidateLockedReleaseArtifacts(
  release: ConfigurationRelease,
  artifacts: readonly {
    readonly artifactKind: ConfigurationArtifactKind;
    readonly artifactKey: string;
    readonly payload: JsonObject;
    readonly checksum: string;
  }[],
): { readonly identityChecksum: string } {
  assertArtifactsMatchStoredChecksums(artifacts);
  const pack = boundPackageFromArtifacts(release, artifacts);
  const result = validateBoundPackage(pack);
  const blocking = result.issues.filter((item) => item.blocking);
  if (blocking.length > 0 || !result.passed) {
    throw new ConfigurationValidationError(
      blocking[0]?.message ?? "Bound-package revalidation failed.",
      result.issues,
    );
  }
  return {
    identityChecksum: computeConfigurationReleaseIdentityChecksum({
      releaseId: release.id,
      versionNumber: release.versionNumber,
      artifacts,
    }),
  };
}

type Row = Record<string, unknown>;

function emptyMappingReport(warnings: readonly string[]): MappingEngineReport {
  return {
    canonical: { fields: {}, findings: [], evidence: [], groups: {}, lineage: [] },
    unmappedSourceFields: [],
    canonicalFieldsWithoutSource: [],
    conflicts: [],
    rejectedTransforms: [],
    blockingIssues: [],
    rowCount: 0,
    humanReadable: warnings,
  };
}

function classifyStagingFailure(
  error: unknown,
  correlationId: string,
  stage: string,
): SafeStagingError {
  const code =
    error instanceof StagingSourceTooLargeError
      ? error.code
      : error instanceof ProductionMappingNotConfiguredError
        ? error.code
        : error instanceof ConfigurationValidationError
          ? error.code
          : error instanceof OperationsValidationError
            ? "OPERATIONS_VALIDATION"
            : error instanceof Error
              ? error.name
              : "STAGING_FAILED";
  const retryable = !(
    error instanceof ProductionMappingNotConfiguredError ||
    error instanceof StagingSourceTooLargeError ||
    error instanceof ConfigurationValidationError
  );
  return safeStagingError({ code, retryable, correlationId, failureStage: stage });
}

export type StagingSubmissionPort = {
  submitInspection(input: {
    readonly inspectionId: string;
    readonly sourceChannel: string;
    readonly sourceIdempotencyKey: string;
    readonly payload: JsonObject;
    readonly actorUserId: string;
    readonly correlationId: string;
  }): Promise<{
    readonly duplicate: boolean;
    readonly submission: { readonly id: string };
    readonly inspection: { readonly id: string };
  }>;
};

export function boundPackageFromArtifacts(
  release: ConfigurationRelease,
  artifacts: readonly {
    readonly artifactKind: ConfigurationArtifactKind;
    readonly payload: JsonObject;
  }[],
): BoundConfigurationPackage {
  const byKind = new Map(artifacts.map((item) => [item.artifactKind, item.payload]));
  const missing = CONFIGURATION_ARTIFACT_KINDS.filter((kind) => !byKind.has(kind));
  if (missing.length > 0) {
    throw new ConfigurationValidationError(
      `Configuration package is missing: ${missing.join(", ")}.`,
      missing.map((kind) => ({
        code: "package.missing_artifact",
        severity: "blocking",
        blocking: true,
        path: kind,
        message: `Missing ${kind}.`,
        remediation: "Add the artifact in a draft.",
      })),
    );
  }
  const parsed = parseBoundArtifacts({
    inspection_schema: byKind.get("inspection_schema")!,
    mapping_profile: byKind.get("mapping_profile")!,
    validation_rule_set: byKind.get("validation_rule_set")!,
    report_template: byKind.get("report_template")!,
    review_policy: byKind.get("review_policy")!,
    storage_policy: byKind.get("storage_policy")!,
    delivery_policy: byKind.get("delivery_policy")!,
    sla_policy: byKind.get("sla_policy")!,
    workflow_blueprint: byKind.get("workflow_blueprint")!,
  });
  const blocking = parsed.issues.filter((item) => item.blocking);
  if (
    blocking.length > 0 ||
    !parsed.schema ||
    !parsed.mapping ||
    !parsed.validation ||
    !parsed.template ||
    !parsed.review ||
    !parsed.storage ||
    !parsed.delivery ||
    !parsed.sla ||
    !parsed.workflow
  ) {
    throw new ConfigurationValidationError(
      blocking[0]?.message ?? "Configuration artifacts failed runtime validation.",
      parsed.issues,
    );
  }
  const pack: BoundConfigurationPackage = {
    release: {
      id: release.id,
      familyKey: release.familyKey,
      displayName: release.displayName,
      versionNumber: release.versionNumber,
      status: release.status,
      synthetic: release.synthetic,
      productionReady: release.productionReady,
      serviceContextKey: release.serviceContextKey,
      disclosure: release.disclosure,
    },
    schema: parsed.schema,
    mapping: parsed.mapping,
    validation: parsed.validation,
    template: parsed.template,
    review: parsed.review,
    storage: parsed.storage,
    delivery: parsed.delivery,
    sla: parsed.sla,
    workflow: parsed.workflow,
  };
  const consistency = validateBoundPackage(pack).issues.filter((item) => item.blocking);
  if (consistency.length > 0) {
    throw new ConfigurationValidationError(
      consistency[0]?.message ?? "Invalid configuration package.",
      consistency,
    );
  }
  return pack;
}

export async function loadBoundPackageFromExecutor(
  executor: SqlExecutor,
  releaseId: string,
): Promise<BoundConfigurationPackage> {
  const releaseRow = await executor.query<Row>("SELECT * FROM configuration_releases WHERE id=$1", [
    releaseId,
  ]);
  if (!releaseRow.rows[0]) {
    throw new OperationsNotFoundError("Configuration release was not found.");
  }
  const artifacts = (
    await executor.query<Row>("SELECT * FROM configuration_artifacts WHERE release_id=$1", [
      releaseId,
    ])
  ).rows.map(mapConfigurationArtifact);
  return boundPackageFromArtifacts(mapConfigurationRelease(releaseRow.rows[0] as Row), artifacts);
}

export class ConfigurationStudioService {
  readonly repository: SqlConfigurationRepository;
  private readonly now: () => Date;
  private submissions: StagingSubmissionPort | null = null;
  private workControl: WorkControlPlane | null = null;

  constructor(
    private readonly database: DatabaseAdapter,
    options: { readonly now?: () => Date } = {},
  ) {
    this.repository = new SqlConfigurationRepository(database);
    this.now = options.now ?? (() => new Date());
  }

  bindSubmissions(port: StagingSubmissionPort): void {
    this.submissions = port;
  }

  bindWorkControl(workControl: WorkControlPlane): void {
    this.workControl = workControl;
  }

  private async afterDomainWork(): Promise<void> {
    if (!this.workControl) return;
    await this.workControl.processPendingEvents();
    await this.workControl.evaluateDueSchedules();
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  private async requireSyntheticPackage(releaseId: string): Promise<BoundConfigurationPackage> {
    const release = await this.repository.getRelease(releaseId);
    if (!release) throw new OperationsNotFoundError("Configuration release was not found.");
    assertSyntheticReleaseExecution(release.synthetic);
    return this.getBoundPackage(releaseId);
  }

  async getBoundPackage(releaseId: string): Promise<BoundConfigurationPackage> {
    const release = await this.repository.getRelease(releaseId);
    if (!release) throw new OperationsNotFoundError("Configuration release was not found.");
    const artifacts = await this.repository.listArtifacts(releaseId);
    return boundPackageFromArtifacts(release, artifacts);
  }

  async createDraft(input: {
    readonly familyKey: string;
    readonly displayName: string;
    readonly serviceContextKey: string;
    readonly description: string;
    readonly synthetic: boolean;
    readonly actorUserId: string;
    readonly correlationId: string;
  }): Promise<ConfigurationRelease> {
    const familyKey = input.familyKey.trim();
    if (!familyKey) throw new OperationsValidationError("A configuration family key is required.");
    if (!input.synthetic && familyKey.startsWith("bea-production")) {
      // Allowed as an unconfigured draft, never production-ready.
    }
    const now = this.stamp();
    const created = await this.database.transaction(async (transaction) => {
      const latest = await transaction.query<{ version_number: number }>(
        "SELECT COALESCE(MAX(version_number),0) AS version_number FROM configuration_releases WHERE family_key=$1",
        [familyKey],
      );
      const versionNumber = Number(latest.rows[0]?.version_number ?? 0) + 1;
      const inserted = await transaction.query<Row>(
        `INSERT INTO configuration_releases
         (id,family_key,display_name,version_number,status,synthetic,production_ready,service_context_key,description,disclosure,created_by_user_id,created_at,updated_at,version)
         VALUES ($1,$2,$3,$4,'draft',$5,FALSE,$6,$7,$8,$9,$10,$10,1)
         RETURNING *`,
        [
          randomUUID(),
          familyKey,
          input.displayName.trim() || familyKey,
          versionNumber,
          input.synthetic,
          input.serviceContextKey.trim() || familyKey,
          input.description.trim() || "Draft operational configuration.",
          input.synthetic
            ? CONFIGURATION_SYNTHETIC_DISCLOSURE
            : "BEA PRODUCTION POLICY: UNCONFIGURED. This draft is not active and is not ready.",
          input.actorUserId,
          now,
        ],
      );
      const release = mapConfigurationRelease(inserted.rows[0] as Row);
      await recordAuditAndActivity(transaction, {
        eventType: "configuration.draft_created",
        action: "configuration.create-draft",
        actorUserId: input.actorUserId,
        resourceType: "configuration_release",
        resourceId: release.id,
        correlationId: input.correlationId,
        metadata: { familyKey, versionNumber, synthetic: input.synthetic },
        summary: `Configuration draft created: ${release.displayName} v${versionNumber}`,
        now,
      });
      return release;
    });
    return created;
  }

  async cloneRelease(input: {
    readonly releaseId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
  }): Promise<ConfigurationRelease> {
    const source = await this.repository.getRelease(input.releaseId);
    if (!source) throw new OperationsNotFoundError("Configuration release was not found.");
    if (source.status === "draft") {
      throw new OperationsValidationError(
        "Clone a published release rather than duplicating a draft.",
      );
    }
    const artifacts = await this.repository.listArtifacts(source.id);
    const now = this.stamp();
    return this.database.transaction(async (transaction) => {
      const latest = await transaction.query<{ version_number: number }>(
        "SELECT COALESCE(MAX(version_number),0) AS version_number FROM configuration_releases WHERE family_key=$1",
        [source.familyKey],
      );
      const versionNumber = Number(latest.rows[0]?.version_number ?? 0) + 1;
      const inserted = await transaction.query<Row>(
        `INSERT INTO configuration_releases
         (id,family_key,display_name,version_number,status,synthetic,production_ready,service_context_key,description,disclosure,parent_release_id,created_by_user_id,created_at,updated_at,version)
         VALUES ($1,$2,$3,$4,'draft',$5,FALSE,$6,$7,$8,$9,$10,$11,$11,1)
         RETURNING *`,
        [
          randomUUID(),
          source.familyKey,
          source.displayName,
          versionNumber,
          source.synthetic,
          source.serviceContextKey,
          `Cloned from v${source.versionNumber}. ${source.description}`,
          source.disclosure,
          source.id,
          input.actorUserId,
          now,
        ],
      );
      const release = mapConfigurationRelease(inserted.rows[0] as Row);
      for (const artifact of artifacts) {
        await insertArtifact(transaction, {
          releaseId: release.id,
          kind: artifact.artifactKind,
          artifactKey: artifact.artifactKey,
          payload: artifact.payload,
          now,
        });
      }
      await recordAuditAndActivity(transaction, {
        eventType: "configuration.cloned",
        action: "configuration.clone",
        actorUserId: input.actorUserId,
        resourceType: "configuration_release",
        resourceId: release.id,
        correlationId: input.correlationId,
        metadata: { parentReleaseId: source.id, versionNumber },
        summary: `Configuration cloned: ${release.displayName} v${versionNumber}`,
        now,
      });
      return release;
    });
  }

  async updateDraftArtifact(input: {
    readonly releaseId: string;
    readonly kind: ConfigurationArtifactKind;
    readonly artifactKey: string;
    readonly payload: JsonObject;
    readonly expectedVersion: number;
    readonly actorUserId: string;
    readonly correlationId: string;
  }): Promise<ConfigurationRelease> {
    const now = this.stamp();
    return this.database.transaction(async (transaction) => {
      const locked = await transaction.query<Row>(
        "SELECT * FROM configuration_releases WHERE id=$1 FOR UPDATE",
        [input.releaseId],
      );
      const release = locked.rows[0] ? mapConfigurationRelease(locked.rows[0]) : null;
      if (!release) throw new OperationsNotFoundError("Configuration release was not found.");
      if (!releaseIsEditable(release.status)) {
        throw new ConfigurationImmutabilityError();
      }
      if (release.version !== input.expectedVersion) throw new OperationsConcurrencyError();
      const safePayload = assertArtifactSafeToSave(input.kind, input.payload);
      await insertArtifact(transaction, {
        releaseId: release.id,
        kind: input.kind,
        artifactKey: input.artifactKey,
        payload: safePayload,
        now,
      });
      const updated = await transaction.query<Row>(
        `UPDATE configuration_releases
            SET status='draft', updated_at=$2, version=version+1
          WHERE id=$1 AND version=$3
          RETURNING *`,
        [release.id, now, release.version],
      );
      if (!updated.rows[0]) throw new OperationsConcurrencyError();
      await recordAuditAndActivity(transaction, {
        eventType: "configuration.artifact_updated",
        action: "configuration.update-artifact",
        actorUserId: input.actorUserId,
        resourceType: "configuration_release",
        resourceId: release.id,
        correlationId: input.correlationId,
        metadata: { kind: input.kind, artifactKey: input.artifactKey },
        summary: `Configuration artifact updated: ${input.kind}`,
        now,
      });
      return mapConfigurationRelease(updated.rows[0]);
    });
  }

  async validateRelease(input: {
    readonly releaseId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
  }): Promise<{
    readonly release: ConfigurationRelease;
    readonly passed: boolean;
    readonly issues: readonly ConfigurationValidationIssue[];
  }> {
    const now = this.stamp();
    return this.database.transaction(async (transaction) => {
      const locked = await transaction.query<Row>(
        "SELECT * FROM configuration_releases WHERE id=$1 FOR UPDATE",
        [input.releaseId],
      );
      const release = locked.rows[0] ? mapConfigurationRelease(locked.rows[0]) : null;
      if (!release) throw new OperationsNotFoundError("Configuration release was not found.");
      if (releaseIsEditable(release.status) === false && release.status !== "validated") {
        throw new ConfigurationImmutabilityError("Only drafts can be revalidated.");
      }
      const artifacts = (
        await transaction.query<Row>("SELECT * FROM configuration_artifacts WHERE release_id=$1", [
          release.id,
        ])
      ).rows.map(mapConfigurationArtifact);
      let issues: ConfigurationValidationIssue[] = [];
      let passed = false;
      try {
        const pack = boundPackageFromArtifacts(release, artifacts);
        const result = validateBoundPackage(pack);
        issues = [...result.issues];
        passed = result.passed && !(!pack.release.synthetic && pack.release.productionReady);
      } catch (error) {
        if (error instanceof ConfigurationValidationError) {
          issues = [...error.issues];
        } else {
          issues = [
            {
              code: "package.invalid",
              severity: "blocking",
              blocking: true,
              path: "release",
              message: error instanceof Error ? error.message : "Invalid configuration package.",
              remediation: "Correct the draft artifacts.",
            },
          ];
        }
      }
      const blocking = issues.filter((item) => item.blocking);
      const warnings = issues.filter((item) => !item.blocking);
      passed = blocking.length === 0;
      await transaction.query(
        `INSERT INTO configuration_validation_runs
         (id,release_id,passed,blocking,warnings,actor_user_id,created_at)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)`,
        [
          randomUUID(),
          release.id,
          passed,
          JSON.stringify(blocking),
          JSON.stringify(warnings),
          input.actorUserId,
          now,
        ],
      );
      const nextStatus = passed ? "validated" : "validation_failed";
      const identityChecksum = passed
        ? computeConfigurationReleaseIdentityChecksum({
            releaseId: release.id,
            versionNumber: release.versionNumber,
            artifacts,
          })
        : null;
      const updated = await transaction.query<Row>(
        `UPDATE configuration_releases
            SET status=$2, validated_at=$3, validated_by_user_id=$4, updated_at=$3, version=version+1,
                validated_identity_checksum=$5
          WHERE id=$1
          RETURNING *`,
        [release.id, nextStatus, now, input.actorUserId, identityChecksum],
      );
      await recordAuditAndActivity(transaction, {
        eventType: passed ? "configuration.validated" : "configuration.validation_failed",
        action: "configuration.validate",
        actorUserId: input.actorUserId,
        resourceType: "configuration_release",
        resourceId: release.id,
        correlationId: input.correlationId,
        metadata: { passed, blocking: blocking.length, warnings: warnings.length },
        summary: passed
          ? `Configuration validated: ${release.displayName} v${release.versionNumber}`
          : `Configuration validation failed: ${release.displayName} v${release.versionNumber}`,
        now,
      });
      return {
        release: mapConfigurationRelease(updated.rows[0] as Row),
        passed,
        issues,
      };
    });
  }

  async publishRelease(input: {
    readonly releaseId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
  }): Promise<ConfigurationRelease> {
    const now = this.stamp();
    return this.database.transaction(async (transaction) => {
      const locked = await transaction.query<Row>(
        "SELECT * FROM configuration_releases WHERE id=$1 FOR UPDATE",
        [input.releaseId],
      );
      const release = locked.rows[0] ? mapConfigurationRelease(locked.rows[0]) : null;
      if (!release) throw new OperationsNotFoundError("Configuration release was not found.");
      if (release.status !== "validated") {
        throw new ConfigurationValidationError("Publication requires a validated configuration.");
      }
      const artifacts = (
        await transaction.query<Row>("SELECT * FROM configuration_artifacts WHERE release_id=$1", [
          release.id,
        ])
      ).rows.map(mapConfigurationArtifact);
      const revalidated = revalidateLockedReleaseArtifacts(release, artifacts);
      if (!release.validatedIdentityChecksum) {
        throw new ConfigurationValidationError(
          "Publication requires a stored validated identity checksum. Revalidate the release before publishing.",
        );
      }
      if (release.validatedIdentityChecksum !== revalidated.identityChecksum) {
        throw new ConfigurationValidationError(
          "Configuration artifacts changed after validation. Publication is refused.",
        );
      }
      const checksum = revalidated.identityChecksum;
      const updated = await transaction.query<Row>(
        `UPDATE configuration_releases
            SET status='published', checksum=$2, published_at=$3, published_by_user_id=$4, updated_at=$3, version=version+1
          WHERE id=$1
          RETURNING *`,
        [release.id, checksum, now, input.actorUserId],
      );
      await recordAuditAndActivity(transaction, {
        eventType: "configuration.published",
        action: "configuration.publish",
        actorUserId: input.actorUserId,
        resourceType: "configuration_release",
        resourceId: release.id,
        correlationId: input.correlationId,
        metadata: { checksum },
        summary: `Configuration published: ${release.displayName} v${release.versionNumber}`,
        now,
      });
      return mapConfigurationRelease(updated.rows[0] as Row);
    });
  }

  async activateRelease(input: {
    readonly releaseId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
    readonly rollback?: boolean;
  }): Promise<ConfigurationRelease> {
    const now = this.stamp();
    const readiness = await this.repository.listReadinessItems();
    return this.database.transaction(async (transaction) => {
      const locked = await transaction.query<Row>(
        "SELECT * FROM configuration_releases WHERE id=$1 FOR UPDATE",
        [input.releaseId],
      );
      const release = locked.rows[0] ? mapConfigurationRelease(locked.rows[0]) : null;
      if (!release) throw new OperationsNotFoundError("Configuration release was not found.");
      if (release.status !== "published" && release.status !== "superseded") {
        throw new ConfigurationActivationError("Only published releases can be activated.");
      }
      if (!release.synthetic) {
        throw new ConfigurationActivationError(
          "Unconfigured production releases cannot be activated. BEA PRODUCTION POLICY: UNCONFIGURED.",
        );
      }
      const artifacts = (
        await transaction.query<Row>("SELECT * FROM configuration_artifacts WHERE release_id=$1", [
          release.id,
        ])
      ).rows.map(mapConfigurationArtifact);
      let identityChecksum: string;
      try {
        identityChecksum = revalidateLockedReleaseArtifacts(release, artifacts).identityChecksum;
      } catch (error) {
        throw new ConfigurationActivationError(
          error instanceof Error
            ? error.message
            : "Current artifacts failed revalidation before activation.",
        );
      }
      if (!release.checksum || release.checksum !== identityChecksum) {
        throw new ConfigurationActivationError(
          "Current artifacts do not match the published checksum. Activation is refused.",
        );
      }
      const blockingGaps = readiness.filter(
        (item) =>
          item.status !== "confirmed" &&
          item.status !== "configured" &&
          item.status !== "tested" &&
          item.status !== "approved" &&
          item.blockingStage === "production_activation" &&
          !release.synthetic,
      );
      if (blockingGaps.length > 0) {
        throw new ConfigurationActivationError(
          `Activation blocked by unconfirmed BEA decisions: ${blockingGaps.map((item) => item.gapKey).join(", ")}.`,
        );
      }
      const currentActive = await transaction.query<Row>(
        "SELECT * FROM configuration_releases WHERE service_context_key=$1 AND status='active' FOR UPDATE",
        [release.serviceContextKey],
      );
      for (const row of currentActive.rows) {
        const current = mapConfigurationRelease(row);
        if (current.id === release.id) continue;
        await transaction.query(
          `UPDATE configuration_releases
              SET status='superseded', updated_at=$2, version=version+1
            WHERE id=$1`,
          [current.id, now],
        );
        await recordAuditAndActivity(transaction, {
          eventType: "configuration.superseded",
          action: "configuration.supersede",
          actorUserId: input.actorUserId,
          resourceType: "configuration_release",
          resourceId: current.id,
          correlationId: input.correlationId,
          metadata: { replacedBy: release.id },
          summary: `Configuration superseded: ${current.displayName} v${current.versionNumber}`,
          now,
        });
      }
      const updated = await transaction.query<Row>(
        `UPDATE configuration_releases
            SET status='active', activated_at=$2, activated_by_user_id=$3, updated_at=$2, version=version+1
          WHERE id=$1
          RETURNING *`,
        [release.id, now, input.actorUserId],
      );
      await recordAuditAndActivity(transaction, {
        eventType: input.rollback ? "configuration.rollback" : "configuration.activated",
        action: input.rollback ? "configuration.rollback" : "configuration.activate",
        actorUserId: input.actorUserId,
        resourceType: "configuration_release",
        resourceId: release.id,
        correlationId: input.correlationId,
        metadata: { rollback: Boolean(input.rollback) },
        summary: input.rollback
          ? `Configuration rolled back to ${release.displayName} v${release.versionNumber}`
          : `Configuration activated: ${release.displayName} v${release.versionNumber}`,
        now,
      });
      return mapConfigurationRelease(updated.rows[0] as Row);
    });
  }

  async archiveRelease(input: {
    readonly releaseId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
  }): Promise<ConfigurationRelease> {
    const now = this.stamp();
    return this.database.transaction(async (transaction) => {
      const locked = await transaction.query<Row>(
        "SELECT * FROM configuration_releases WHERE id=$1 FOR UPDATE",
        [input.releaseId],
      );
      const release = locked.rows[0] ? mapConfigurationRelease(locked.rows[0]) : null;
      if (!release) throw new OperationsNotFoundError("Configuration release was not found.");
      if (release.status === "active") {
        throw new ConfigurationActivationError(
          "Deactivate by activating another release before archive.",
        );
      }
      const updated = await transaction.query<Row>(
        `UPDATE configuration_releases
            SET status='archived', archived_at=$2, archived_by_user_id=$3, updated_at=$2, version=version+1
          WHERE id=$1
          RETURNING *`,
        [release.id, now, input.actorUserId],
      );
      await recordAuditAndActivity(transaction, {
        eventType: "configuration.archived",
        action: "configuration.archive",
        actorUserId: input.actorUserId,
        resourceType: "configuration_release",
        resourceId: release.id,
        correlationId: input.correlationId,
        metadata: {},
        summary: `Configuration archived: ${release.displayName} v${release.versionNumber}`,
        now,
      });
      return mapConfigurationRelease(updated.rows[0] as Row);
    });
  }

  async compareReleases(
    leftId: string,
    rightId: string,
  ): Promise<{
    readonly left: ConfigurationRelease;
    readonly right: ConfigurationRelease;
    readonly changes: readonly string[];
  }> {
    const [left, right] = await Promise.all([
      this.repository.getRelease(leftId),
      this.repository.getRelease(rightId),
    ]);
    if (!left || !right) throw new OperationsNotFoundError("Configuration release was not found.");
    const [leftArtifacts, rightArtifacts] = await Promise.all([
      this.repository.listArtifacts(left.id),
      this.repository.listArtifacts(right.id),
    ]);
    const changes: string[] = [];
    if (left.versionNumber !== right.versionNumber) {
      changes.push(`version ${left.versionNumber} → ${right.versionNumber}`);
    }
    const rightByKind = new Map(rightArtifacts.map((item) => [item.artifactKind, item.checksum]));
    for (const artifact of leftArtifacts) {
      const other = rightByKind.get(artifact.artifactKind);
      if (other !== artifact.checksum) {
        changes.push(`${artifact.artifactKind} changed`);
      }
    }
    return { left, right, changes };
  }

  async createInspection(input: {
    readonly projectId: string;
    readonly configurationReleaseId: string;
    readonly inspectionType: string;
    readonly inspectorUserId: string | null;
    readonly scheduledAt: string | null;
    readonly actorUserId: string;
    readonly correlationId: string;
  }): Promise<Inspection> {
    const pack = await this.requireSyntheticPackage(input.configurationReleaseId);
    if (
      pack.release.status !== "published" &&
      pack.release.status !== "active" &&
      pack.release.status !== "superseded"
    ) {
      throw new OperationsValidationError(
        "Inspections must use a published, active, or superseded configuration release.",
      );
    }
    const now = this.stamp();
    const checklist = [
      { key: "scope", label: "Confirm inspection scope", status: "pending", detail: null },
      { key: "access", label: "Site access arranged", status: "pending", detail: null },
      { key: "equipment", label: "Required equipment available", status: "pending", detail: null },
    ];
    const created = await this.database.transaction(async (transaction) => {
      const project = await transaction.query<Row>("SELECT * FROM projects WHERE id=$1", [
        input.projectId,
      ]);
      if (!project.rows[0]) throw new OperationsNotFoundError("Project was not found.");
      const reference = await nextOperationsReference(
        transaction,
        "bea_inspection_reference_seq",
        "BEA-IN-",
      );
      const status = input.scheduledAt ? "scheduled" : "draft";
      const inserted = await transaction.query<Row>(
        `INSERT INTO inspections
         (id,reference,project_id,status,inspector_user_id,reviewer_user_id,scheduled_at,service_key,report_template_id,configuration_release_id,inspection_type,readiness_checklist,created_by_user_id,created_at,updated_at,version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$14,1)
         RETURNING *`,
        [
          randomUUID(),
          reference,
          input.projectId,
          status,
          input.inspectorUserId,
          input.actorUserId,
          input.scheduledAt,
          pack.release.familyKey,
          SEEDED_OPERATIONS_IDS.template,
          pack.release.id,
          input.inspectionType.trim() || pack.release.displayName,
          JSON.stringify({ items: checklist }),
          input.actorUserId,
          now,
        ],
      );
      const inspection = mapInspection(inserted.rows[0] as Row);
      if (input.inspectorUserId) {
        await transaction.query(
          `INSERT INTO inspection_assignments (id,inspection_id,user_id,assignment_role,assigned_at,assigned_by_user_id)
           VALUES ($1,$2,$3,'inspector',$4,$5)`,
          [randomUUID(), inspection.id, input.inspectorUserId, now, input.actorUserId],
        );
      }
      await recordAuditAndActivity(transaction, {
        eventType: "inspection.created",
        action: "inspection.create",
        actorUserId: input.actorUserId,
        resourceType: "inspection",
        resourceId: inspection.id,
        correlationId: input.correlationId,
        metadata: {
          configurationReleaseId: pack.release.id,
          inspectionType: inspection.inspectionType,
        },
        summary: `Inspection created: ${inspection.reference}`,
        inspectionId: inspection.id,
        now,
      });
      await insertAutomationEvent(transaction, {
        eventType: "inspection.created",
        aggregateType: "inspection",
        aggregateId: inspection.id,
        correlationId: input.correlationId,
        actorType: "user",
        actorId: input.actorUserId,
        payload: {
          inspectionId: inspection.id,
          configurationReleaseId: pack.release.id,
          inspectionType: inspection.inspectionType,
          inspectorUserId: inspection.inspectorUserId,
        },
        occurredAt: now,
      });
      if (input.scheduledAt) {
        await insertAutomationEvent(transaction, {
          eventType: "inspection.scheduled",
          aggregateType: "inspection",
          aggregateId: inspection.id,
          correlationId: input.correlationId,
          actorType: "user",
          actorId: input.actorUserId,
          payload: { inspectionId: inspection.id, scheduledAt: input.scheduledAt },
          occurredAt: now,
        });
      }
      return inspection;
    });
    await this.afterDomainWork();
    return created;
  }

  async updateInspectionSetup(input: {
    readonly inspectionId: string;
    readonly action: "ready" | "start" | "complete" | "checklist";
    readonly checklistKey?: string;
    readonly checklistStatus?: "pending" | "complete" | "blocked";
    readonly actorUserId: string;
    readonly correlationId: string;
  }): Promise<Inspection> {
    const now = this.stamp();
    const updatedInspection = await this.database.transaction(async (transaction) => {
      const locked = await transaction.query<Row>(
        "SELECT * FROM inspections WHERE id=$1 FOR UPDATE",
        [input.inspectionId],
      );
      const inspection = locked.rows[0] ? mapInspection(locked.rows[0]) : null;
      if (!inspection) throw new OperationsNotFoundError("Inspection was not found.");
      const stored = inspection.readinessChecklist;
      let checklist = jsonChecklist(stored);
      if (input.action === "checklist") {
        checklist = checklist.map((item) => {
          const row = item as {
            key?: string;
            status?: string;
            label?: string;
            detail?: string | null;
          };
          if (row.key === input.checklistKey) {
            return { ...row, status: input.checklistStatus ?? row.status };
          }
          return row;
        });
        const updated = await transaction.query<Row>(
          `UPDATE inspections SET readiness_checklist=$2::jsonb, updated_at=$3, version=version+1 WHERE id=$1 RETURNING *`,
          [inspection.id, JSON.stringify({ items: checklist }), now],
        );
        return mapInspection(updated.rows[0] as Row);
      }
      const next =
        input.action === "ready" ? "ready" : input.action === "start" ? "in_progress" : "completed";
      assertInspectionStatusTransition(inspection.status, next);
      if (input.action === "ready") {
        const blocked = checklist.some(
          (item) => (item as { status?: string }).status === "blocked",
        );
        const pending = checklist.some(
          (item) => (item as { status?: string }).status !== "complete",
        );
        if (blocked || pending) {
          throw new OperationsValidationError(
            "Mark every readiness item complete before the inspection can be marked ready.",
          );
        }
      }
      const updated = await transaction.query<Row>(
        `UPDATE inspections
            SET status=$2,
                started_at=CASE WHEN $2='in_progress' THEN COALESCE(started_at,$3) ELSE started_at END,
                completed_at=CASE WHEN $2='completed' THEN COALESCE(completed_at,$3) ELSE completed_at END,
                updated_at=$3,
                version=version+1
          WHERE id=$1
          RETURNING *`,
        [inspection.id, next, now],
      );
      const eventType =
        input.action === "ready"
          ? "inspection.ready"
          : input.action === "start"
            ? "inspection.started"
            : "inspection.completed";
      await recordAuditAndActivity(transaction, {
        eventType,
        action: `inspection.${input.action}`,
        actorUserId: input.actorUserId,
        resourceType: "inspection",
        resourceId: inspection.id,
        correlationId: input.correlationId,
        metadata: { from: inspection.status, to: next },
        summary: `Inspection ${input.action}: ${inspection.reference}`,
        inspectionId: inspection.id,
        now,
      });
      await insertAutomationEvent(transaction, {
        eventType,
        aggregateType: "inspection",
        aggregateId: inspection.id,
        correlationId: input.correlationId,
        actorType: "user",
        actorId: input.actorUserId,
        payload: { inspectionId: inspection.id, from: inspection.status, to: next },
        occurredAt: now,
      });
      return mapInspection(updated.rows[0] as Row);
    });
    await this.afterDomainWork();
    return updatedInspection;
  }

  async slaPreview(releaseId: string, startedAt: string, owner: string) {
    const pack = await this.requireSyntheticPackage(releaseId);
    return previewSlaDue({
      policy: pack.sla,
      startedAt,
      now: this.stamp(),
      responsibleOwner: owner,
    });
  }

  async replaySynthetic(input: {
    readonly releaseId: string;
    readonly sourceType: string;
    readonly raw: string;
  }) {
    return this.previewReport(input);
  }

  private async insertStagingRun(input: {
    readonly sourceType: string;
    readonly sourceSystemLabel: string | null;
    readonly sourceSchemaVersion: string | null;
    readonly sourceIdentity: string;
    readonly payloadSha256: string;
    readonly rawRepresentation: JsonObject;
    readonly rawSourceText: string;
    readonly rawSourceSha256: string;
    readonly rawSourceByteLength: number;
    readonly inspectionId: string | null;
    readonly sourceIdempotencyKey: string | null;
    readonly mappingProfileKey: string | null;
    readonly configurationReleaseId: string | null;
    readonly dryRun: boolean;
    readonly status: StagingStatus;
    readonly mappingReport: MappingEngineReport | null;
    readonly validationPreview: ReturnType<typeof evaluateValidationRules> | null;
    readonly actorUserId: string;
    readonly classificationWarnings: readonly string[];
    readonly lastError: SafeStagingError | null;
  }): Promise<IngestionStagingRun> {
    const now = this.stamp();
    const inserted = await this.database.query<Row>(
      `INSERT INTO ingestion_staging_runs
       (id,source_type,source_system_label,source_schema_version,source_identity,payload_sha256,
        raw_representation,raw_source_text,raw_source_sha256,raw_source_byte_length,inspection_id,
        source_idempotency_key,mapping_profile_key,configuration_release_id,dry_run,status,
        mapping_report,validation_preview,actor_user_id,classification_warnings,last_error,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19,$20::jsonb,$21::jsonb,$22,$22)
       RETURNING *`,
      [
        randomUUID(),
        input.sourceType,
        input.sourceSystemLabel,
        input.sourceSchemaVersion,
        input.sourceIdentity,
        input.payloadSha256,
        JSON.stringify(input.rawRepresentation),
        input.rawSourceText,
        input.rawSourceSha256,
        input.rawSourceByteLength,
        input.inspectionId,
        input.sourceIdempotencyKey,
        input.mappingProfileKey,
        input.configurationReleaseId,
        input.dryRun,
        input.status,
        input.mappingReport ? JSON.stringify(input.mappingReport) : null,
        input.validationPreview ? JSON.stringify(input.validationPreview) : null,
        input.actorUserId,
        JSON.stringify(input.classificationWarnings),
        input.lastError ? JSON.stringify(input.lastError) : null,
        now,
      ],
    );
    return mapStagingRun(inserted.rows[0] as Row);
  }

  async finalizeStaging(input: {
    readonly stagingId: string;
    readonly status: "committed" | "duplicate" | "failed";
    readonly submissionId: string | null;
    readonly lastError?: SafeStagingError | null;
    readonly correlationId: string;
    readonly actorUserId: string;
  }): Promise<IngestionStagingRun> {
    const now = this.stamp();
    const updated = await this.database.query<Row>(
      `UPDATE ingestion_staging_runs
          SET status=$2,
              committed_submission_id=$3,
              last_error=$4::jsonb,
              finalized_at=$5,
              updated_at=$5
        WHERE id=$1
        RETURNING *`,
      [
        input.stagingId,
        input.status,
        input.submissionId,
        input.lastError ? JSON.stringify(input.lastError) : null,
        now,
      ],
    );
    if (!updated.rows[0]) throw new OperationsNotFoundError("Staging run was not found.");
    const staging = mapStagingRun(updated.rows[0] as Row);
    await recordAuditAndActivity(this.database, {
      eventType: `configuration.staging_${input.status}`,
      action: "configuration.finalize-staging",
      actorUserId: input.actorUserId,
      resourceType: "ingestion_staging_run",
      resourceId: staging.id,
      correlationId: input.correlationId,
      metadata: {
        status: input.status,
        submissionId: input.submissionId,
        inspectionId: staging.inspectionId,
        configurationReleaseId: staging.configurationReleaseId,
        rawSourceSha256: staging.rawSourceSha256,
        sourceIdempotencyKey: staging.sourceIdempotencyKey,
      },
      summary: `Staging ${input.status}`,
      inspectionId: staging.inspectionId,
      now,
    });
    return staging;
  }

  async dryRunMapping(input: {
    readonly releaseId: string;
    readonly sourceType: string;
    readonly raw: string;
    readonly actorUserId: string;
    readonly correlationId: string;
  }): Promise<{
    readonly staging: IngestionStagingRun;
    readonly mapping: MappingEngineReport;
    readonly validation: ReturnType<typeof evaluateValidationRules>;
  }> {
    const pack = await this.requireSyntheticPackage(input.releaseId);
    assertStagingSourceSize(input.raw);
    const integrity = hashRawSourceText(input.raw);
    const parsed = parseStagingSource(input.sourceType, input.raw, {
      csvRowMode: pack.mapping.csvRowMode,
    });
    const identity = `${pack.mapping.profileKey}:${integrity.sha256}`;
    const now = this.stamp();
    if (parsed.quarantined) {
      const staging = await this.insertStagingRun({
        sourceType: input.sourceType,
        sourceSystemLabel: "synthetic-lab",
        sourceSchemaVersion: pack.mapping.sourceSchemaVersion,
        sourceIdentity: identity,
        payloadSha256: integrity.sha256,
        rawRepresentation: { source: parsed.source, quarantined: true },
        rawSourceText: input.raw,
        rawSourceSha256: integrity.sha256,
        rawSourceByteLength: integrity.byteLength,
        inspectionId: null,
        sourceIdempotencyKey: null,
        mappingProfileKey: pack.mapping.profileKey,
        configurationReleaseId: pack.release.id,
        dryRun: true,
        status: "quarantined",
        mappingReport: emptyMappingReport(parsed.warnings),
        validationPreview: {
          passed: false,
          blocking: [],
          warnings: [],
          advisories: [],
          ruleSetKey: pack.validation.ruleSetKey,
          ruleSetVersion: pack.validation.ruleSetVersion,
        },
        actorUserId: input.actorUserId,
        classificationWarnings: parsed.warnings,
        lastError: null,
      });
      return {
        staging,
        mapping: emptyMappingReport(parsed.warnings),
        validation: {
          passed: false,
          blocking: [],
          warnings: [],
          advisories: [],
          ruleSetKey: pack.validation.ruleSetKey,
          ruleSetVersion: pack.validation.ruleSetVersion,
        },
      };
    }
    const mapping = applySourceMapping(parsed.source, pack.mapping, pack.schema);
    const validation = evaluateValidationRules(mapping.canonical, pack.validation);
    const staging = await this.insertStagingRun({
      sourceType: pack.mapping.sourceType,
      sourceSystemLabel: "synthetic-lab",
      sourceSchemaVersion: pack.mapping.sourceSchemaVersion,
      sourceIdentity: identity,
      payloadSha256: integrity.sha256,
      rawRepresentation: { source: parsed.source, previewOnly: true },
      rawSourceText: input.raw,
      rawSourceSha256: integrity.sha256,
      rawSourceByteLength: integrity.byteLength,
      inspectionId: null,
      sourceIdempotencyKey: null,
      mappingProfileKey: pack.mapping.profileKey,
      configurationReleaseId: pack.release.id,
      dryRun: true,
      status: "mapped",
      mappingReport: mapping,
      validationPreview: validation,
      actorUserId: input.actorUserId,
      classificationWarnings: parsed.warnings,
      lastError: null,
    });
    await recordAuditAndActivity(this.database, {
      eventType: "configuration.mapping_dry_run",
      action: "configuration.mapping-dry-run",
      actorUserId: input.actorUserId,
      resourceType: "configuration_release",
      resourceId: input.releaseId,
      correlationId: input.correlationId,
      metadata: {
        stagingId: staging.id,
        dryRun: true,
        rawSourceSha256: integrity.sha256,
        rawSourceByteLength: integrity.byteLength,
      },
      summary: `Mapping dry-run for ${pack.release.displayName}`,
      now,
    });
    return { staging, mapping, validation };
  }

  async previewReport(input: {
    readonly releaseId: string;
    readonly sourceType: string;
    readonly raw: string;
    readonly inspectionReference?: string;
    readonly reportReference?: string;
    readonly projectReference?: string;
  }): Promise<{
    readonly mapping: MappingEngineReport;
    readonly validation: ReturnType<typeof evaluateValidationRules>;
    readonly document: ReturnType<typeof buildReportDocument>;
    readonly rendered: ReturnType<typeof renderReportDocumentToPdf>;
  }> {
    const pack = await this.requireSyntheticPackage(input.releaseId);
    assertStagingSourceSize(input.raw);
    const parsed = parseStagingSource(input.sourceType, input.raw, {
      csvRowMode: pack.mapping.csvRowMode,
    });
    if (parsed.quarantined) {
      throw new OperationsValidationError(parsed.warnings.join(" "));
    }
    const mapping = applySourceMapping(parsed.source, pack.mapping, pack.schema);
    const validation = evaluateValidationRules(mapping.canonical, pack.validation);
    const inspectionReference = input.inspectionReference ?? "BEA-IN-PREVIEW";
    const reportReference = input.reportReference ?? "BEA-RP-PREVIEW";
    const document = buildReportDocument({
      template: pack.template,
      record: mapping.canonical,
      schema: pack.schema,
      mapping: pack.mapping,
      ruleSet: pack.validation,
      configurationReleaseId: pack.release.id,
      configurationReleaseVersion: pack.release.versionNumber,
      inspectionReference,
      reportReference,
      projectReference: input.projectReference ?? "BEA-PR-PREVIEW",
      preview: true,
    });
    const rendered = renderReportDocumentToPdf(document, this.stamp());
    return { mapping, validation, document, rendered };
  }

  async connectorDryRun(input: {
    readonly releaseId: string;
    readonly inspectionReference: string;
    readonly reportReference: string;
    readonly projectReference: string;
    readonly filename: string;
    readonly actorUserId: string;
    readonly correlationId: string;
  }) {
    const pack = await this.requireSyntheticPackage(input.releaseId);
    const connectors = await this.database.query<Row>(
      "SELECT provider_type, readiness_status FROM connector_readiness",
    );
    const sharePoint =
      connectors.rows.find((row) => String(row.provider_type) === "sharepoint")?.readiness_status ??
      "not_connected";
    const outlook =
      connectors.rows.find((row) => String(row.provider_type) === "outlook-email")
        ?.readiness_status ?? "not_connected";
    const manifest = buildStorageDeliveryDryRun({
      pack,
      inspectionReference: input.inspectionReference,
      reportReference: input.reportReference,
      projectReference: input.projectReference,
      filename: input.filename,
      recipient: "client@example.invalid",
      sharePointStatus: String(sharePoint),
      outlookStatus: String(outlook),
    });
    const now = this.stamp();
    await this.database.query(
      `UPDATE connector_readiness
          SET last_dry_run_at=$1,
              required_action=$2,
              updated_at=$1,
              version=version+1
        WHERE provider_type IN ('sharepoint','outlook-email','outlook-calendar')`,
      [
        now,
        "Dry-run only. No Microsoft Graph request was made. Existing readiness status was preserved. Activation remains blocked until BEA confirms storage and delivery policy.",
      ],
    );
    await recordAuditAndActivity(this.database, {
      eventType: "configuration.connector_dry_run",
      action: "configuration.connector-dry-run",
      actorUserId: input.actorUserId,
      resourceType: "configuration_release",
      resourceId: input.releaseId,
      correlationId: input.correlationId,
      metadata: {
        liveWrites: false,
        preservedReadiness: true,
        sharePoint: String(sharePoint),
        outlook: String(outlook),
        dryRunValidated: false,
      },
      summary: "Storage and delivery dry-run produced a no-write action plan.",
      now,
    });
    return manifest;
  }

  async exportIntake(): Promise<{ readonly markdown: string; readonly json: JsonObject }> {
    const [items, gaps] = await Promise.all([
      this.repository.listIntakeItems(),
      this.repository.listReadinessItems(),
    ]);
    return {
      markdown: exportIntakePacketMarkdown(items, gaps),
      json: exportIntakePacketJson(items, gaps),
    };
  }

  async prepareCommit(input: {
    readonly inspectionId: string;
    readonly sourceType: string;
    readonly raw: string;
    readonly actorUserId: string;
    readonly correlationId: string;
  }): Promise<{
    readonly staging: IngestionStagingRun;
    readonly mapping: MappingEngineReport;
    readonly validation: ReturnType<typeof evaluateValidationRules>;
    readonly source: JsonObject;
    readonly configurationReleaseId: string;
    readonly sourceIdempotencyKey: string;
  }> {
    const inspectionRow = await this.database.query<Row>("SELECT * FROM inspections WHERE id=$1", [
      input.inspectionId,
    ]);
    const inspection = inspectionRow.rows[0] ? mapInspection(inspectionRow.rows[0]) : null;
    if (!inspection) throw new OperationsNotFoundError("Inspection was not found.");
    if (!inspection.configurationReleaseId) {
      throw new OperationsValidationError(
        "This inspection has no configuration release. Select a published synthetic release first.",
      );
    }
    const pack = await this.requireSyntheticPackage(inspection.configurationReleaseId);
    assertStagingSourceSize(input.raw);
    const integrity = hashRawSourceText(input.raw);
    const sourceIdempotencyKey = stagingSourceIdempotencyKey(inspection.id, integrity.sha256);
    const parsed = parseStagingSource(input.sourceType, input.raw, {
      csvRowMode: pack.mapping.csvRowMode,
    });
    const identity = `${pack.mapping.profileKey}:${integrity.sha256}`;
    if (parsed.quarantined) {
      await this.insertStagingRun({
        sourceType: input.sourceType,
        sourceSystemLabel: "synthetic-lab",
        sourceSchemaVersion: pack.mapping.sourceSchemaVersion,
        sourceIdentity: identity,
        payloadSha256: integrity.sha256,
        rawRepresentation: { source: parsed.source, quarantined: true },
        rawSourceText: input.raw,
        rawSourceSha256: integrity.sha256,
        rawSourceByteLength: integrity.byteLength,
        inspectionId: inspection.id,
        sourceIdempotencyKey,
        mappingProfileKey: pack.mapping.profileKey,
        configurationReleaseId: pack.release.id,
        dryRun: false,
        status: "quarantined",
        mappingReport: emptyMappingReport(parsed.warnings),
        validationPreview: null,
        actorUserId: input.actorUserId,
        classificationWarnings: parsed.warnings,
        lastError: safeStagingError({
          code: "SOURCE_QUARANTINED",
          retryable: false,
          correlationId: input.correlationId,
          failureStage: "parse",
        }),
      });
      throw new OperationsValidationError(
        parsed.warnings.join(" ") || "Source package was quarantined.",
      );
    }
    const mapping = applySourceMapping(parsed.source, pack.mapping, pack.schema);
    const validation = evaluateValidationRules(mapping.canonical, pack.validation);
    const status: StagingStatus =
      mapping.blockingIssues.length === 0 && validation.passed ? "validated" : "mapped";
    const staging = await this.insertStagingRun({
      sourceType: pack.mapping.sourceType,
      sourceSystemLabel: "synthetic-lab",
      sourceSchemaVersion: pack.mapping.sourceSchemaVersion,
      sourceIdentity: identity,
      payloadSha256: integrity.sha256,
      rawRepresentation: { source: parsed.source, previewOnly: false },
      rawSourceText: input.raw,
      rawSourceSha256: integrity.sha256,
      rawSourceByteLength: integrity.byteLength,
      inspectionId: inspection.id,
      sourceIdempotencyKey,
      mappingProfileKey: pack.mapping.profileKey,
      configurationReleaseId: pack.release.id,
      dryRun: false,
      status,
      mappingReport: mapping,
      validationPreview: validation,
      actorUserId: input.actorUserId,
      classificationWarnings: parsed.warnings,
      lastError: null,
    });
    return {
      staging,
      mapping,
      validation,
      source: parsed.source,
      configurationReleaseId: pack.release.id,
      sourceIdempotencyKey,
    };
  }

  async commitStagedInspection(input: {
    readonly inspectionId: string;
    readonly sourceType: string;
    readonly raw: string;
    readonly actorUserId: string;
    readonly correlationId: string;
  }): Promise<{
    readonly staging: IngestionStagingRun;
    readonly mapping: MappingEngineReport;
    readonly validation: ReturnType<typeof evaluateValidationRules>;
    readonly duplicate: boolean;
    readonly submissionId: string | null;
    readonly inspectionId: string;
    readonly newSubmissionCreated: boolean;
  }> {
    const prepared = await this.prepareCommit(input);
    if (prepared.mapping.blockingIssues.length > 0 || !prepared.validation.passed) {
      return {
        staging: prepared.staging,
        mapping: prepared.mapping,
        validation: prepared.validation,
        duplicate: false,
        submissionId: null,
        inspectionId: input.inspectionId,
        newSubmissionCreated: false,
      };
    }
    const port = this.submissions;
    if (!port) {
      throw new OperationsValidationError(
        "Staging commit is not bound to the inspection submission service.",
      );
    }
    try {
      const submitted = await port.submitInspection({
        inspectionId: input.inspectionId,
        sourceChannel: "file_import",
        sourceIdempotencyKey: prepared.sourceIdempotencyKey,
        payload: prepared.source,
        actorUserId: input.actorUserId,
        correlationId: input.correlationId,
      });
      const staging = await this.finalizeStaging({
        stagingId: prepared.staging.id,
        status: submitted.duplicate ? "duplicate" : "committed",
        submissionId: submitted.submission.id,
        correlationId: input.correlationId,
        actorUserId: input.actorUserId,
      });
      return {
        staging,
        mapping: prepared.mapping,
        validation: prepared.validation,
        duplicate: submitted.duplicate,
        submissionId: submitted.submission.id,
        inspectionId: submitted.inspection.id,
        newSubmissionCreated: !submitted.duplicate,
      };
    } catch (error) {
      const staging = await this.finalizeStaging({
        stagingId: prepared.staging.id,
        status: "failed",
        submissionId: null,
        lastError: classifyStagingFailure(error, input.correlationId, "submitInspection"),
        correlationId: input.correlationId,
        actorUserId: input.actorUserId,
      });
      if (
        error instanceof OperationsValidationError ||
        error instanceof ProductionMappingNotConfiguredError ||
        error instanceof ConfigurationValidationError ||
        error instanceof StagingSourceTooLargeError
      ) {
        throw error;
      }
      throw new OperationsValidationError(
        `Inspection submission failed. Staging ${staging.id} is marked failed and can be retried or reconciled.`,
      );
    }
  }

  async reconcileStaging(input: {
    readonly stagingId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
  }): Promise<IngestionStagingRun> {
    const staging = await this.repository.getStagingRun(input.stagingId);
    if (!staging) throw new OperationsNotFoundError("Staging run was not found.");
    if (staging.status === "committed" || staging.status === "duplicate") return staging;
    if (!staging.inspectionId || !staging.sourceIdempotencyKey) {
      throw new OperationsValidationError(
        "This staging run has no persisted inspection or source idempotency key to reconcile.",
      );
    }
    const found = await this.database.query<Row>(
      `SELECT id FROM inspection_submissions
        WHERE inspection_id=$1 AND source_idempotency_key=$2
        ORDER BY created_at
        LIMIT 1`,
      [staging.inspectionId, staging.sourceIdempotencyKey],
    );
    if (!found.rows[0]) {
      throw new OperationsValidationError(
        "No existing inspection submission matches this staging run. Retry commit instead of reconciling.",
      );
    }
    const submissionId = String(found.rows[0].id);
    const already = await this.database.query<Row>(
      `SELECT id FROM ingestion_staging_runs
        WHERE committed_submission_id=$1 AND status='committed' AND id<>$2
        LIMIT 1`,
      [submissionId, staging.id],
    );
    return this.finalizeStaging({
      stagingId: staging.id,
      status: already.rows[0] ? "duplicate" : "committed",
      submissionId,
      correlationId: input.correlationId,
      actorUserId: input.actorUserId,
    });
  }

  async retryStagingCommit(input: {
    readonly stagingId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
  }) {
    const staging = await this.repository.getStagingRun(input.stagingId);
    if (!staging) throw new OperationsNotFoundError("Staging run was not found.");
    if (!staging.rawSourceText || !staging.inspectionId) {
      throw new OperationsValidationError(
        "This staging run cannot be retried without preserved raw source.",
      );
    }
    return this.commitStagedInspection({
      inspectionId: staging.inspectionId,
      sourceType: staging.sourceType,
      raw: staging.rawSourceText,
      actorUserId: input.actorUserId,
      correlationId: input.correlationId,
    });
  }

  async updateIntakeItem(input: {
    readonly itemId: string;
    readonly status: string;
    readonly answer: string | null;
    readonly notes: string | null;
    readonly expectedVersion: number;
    readonly actorUserId: string;
    readonly correlationId: string;
  }) {
    if (!isIntakeStatus(input.status)) {
      throw new OperationsValidationError("An intake status from the controlled list is required.");
    }
    const current = await this.database.query<Row>(
      "SELECT * FROM configuration_intake_items WHERE id=$1",
      [input.itemId],
    );
    if (!current.rows[0]) throw new OperationsNotFoundError("Intake item was not found.");
    const previousStatus = String(current.rows[0].status);
    if (
      input.status === "approved" &&
      previousStatus !== "confirmed" &&
      previousStatus !== "tested"
    ) {
      throw new OperationsValidationError(
        "approved requires confirmed or tested evidence before the status can advance.",
      );
    }
    const now = this.stamp();
    const updated = await this.database.query<Row>(
      `UPDATE configuration_intake_items
          SET status=$2, answer=COALESCE($3, answer), notes=$4, updated_at=$5, version=version+1
        WHERE id=$1 AND version=$6
        RETURNING *`,
      [input.itemId, input.status, input.answer, input.notes, now, input.expectedVersion],
    );
    if (!updated.rows[0]) throw new OperationsConcurrencyError();
    await recordAuditAndActivity(this.database, {
      eventType: "configuration.intake_updated",
      action: "configuration.update-intake",
      actorUserId: input.actorUserId,
      resourceType: "configuration_intake_item",
      resourceId: input.itemId,
      correlationId: input.correlationId,
      metadata: { previousStatus, nextStatus: input.status },
      summary: `Configuration intake ${previousStatus} → ${input.status}`,
      now,
    });
    return mapIntakeItem(updated.rows[0]);
  }
}

function jsonChecklist(value: JsonObject | null): unknown[] {
  if (!value) {
    return [
      { key: "scope", label: "Confirm inspection scope", status: "pending", detail: null },
      { key: "access", label: "Site access arranged", status: "pending", detail: null },
      { key: "equipment", label: "Required equipment available", status: "pending", detail: null },
    ];
  }
  if (Array.isArray(value.items)) return [...value.items];
  return [];
}

export { defaultReviewPolicy, artifactChecksum };
