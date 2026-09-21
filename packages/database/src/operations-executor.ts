import { createHash, randomUUID } from "node:crypto";
import {
  DeliveryAdapterError,
  FailClosedLiveDeliveryAdapter,
  LocalTestDeliveryAdapter,
  assertDeliveryConfirmed,
  configurableSyntheticRenderer,
  type DeliveryAdapter,
  type ReportRenderer,
} from "@bea/automation";
import type {
  CanonicalInspectionRecord,
  Inspection,
  InspectionReport,
  InspectionSourceChannel,
  InspectionSubmission,
  InspectionValidationItem,
  JsonObject,
  NormalizedInspectionPayload,
  Project,
  ReportReviewDecision,
  ReportVersion,
  SlaAttribution,
  SlaStageKey,
} from "@bea/domain";
import {
  applySourceMapping,
  buildReportDocument,
  DEFAULT_LOCAL_TEST_RECIPIENTS,
  DEFAULT_REPORT_SLA_TARGET_MINUTES,
  DEFAULT_SLA_CLOCK_KIND,
  evaluateValidationRules,
  JOB_LEASE_MS,
  OPERATIONS_CONTRACT_VERSION,
  OperationsNotFoundError,
  OperationsStatusTransitionError,
  OperationsValidationError,
  assertSyntheticReleaseExecution,
  projectCanonicalToNormalized,
  SYNTHETIC_REPORT_TEMPLATE_KEY,
  assertInspectionStatusTransition,
  assertProjectStatusTransition,
  assertReportStatusTransition,
  buildIdempotencyKey,
  elapsedMs,
  evaluateInspectionCompleteness,
  isDeliveryDestinationKind,
  isInspectionSourceChannel,
  isReportReviewDecision,
  normalizeInspectionPayload,
  sameCanonicalRecipients,
  type BoundConfigurationPackage,
  type DeliveryDestinationKind,
  type InspectionStatus,
  type ReportStatus,
} from "@bea/domain";
import type { DatabaseAdapter, SqlExecutor } from "./adapter.js";
import { claimRunnableJob, failClaimedJob, succeedClaimedJob } from "./job-claim.js";
import {
  enqueueAutomationJob,
  hashJson,
  insertAutomationEvent,
  jsonValue,
  mapDeliveryAuthorization,
  mapInspection,
  mapJob,
  mapProject,
  mapReport,
  mapReportVersion,
  mapSubmission,
  mapTemplateVersion,
  nextOperationsReference,
  recordAuditAndActivity,
  SqlOperationsRepository,
} from "./operations-repository.js";
import { isUniqueConstraintViolation } from "./unique-constraint.js";
import { loadBoundPackageFromExecutor } from "./configuration-executor.js";
import { WorkControlPlane } from "./work-control-executor.js";

type SqlRow = Record<string, unknown>;

async function loadSyntheticBoundPackage(
  executor: SqlExecutor,
  releaseId: string,
): Promise<BoundConfigurationPackage> {
  const releaseRow = await executor.query<{ synthetic: boolean | string }>(
    "SELECT synthetic FROM configuration_releases WHERE id=$1",
    [releaseId],
  );
  if (!releaseRow.rows[0]) {
    throw new OperationsNotFoundError("Configuration release was not found.");
  }
  assertSyntheticReleaseExecution(
    releaseRow.rows[0].synthetic === true || releaseRow.rows[0].synthetic === "t",
  );
  return loadBoundPackageFromExecutor(executor, releaseId);
}

export { JOB_LEASE_MS };

export interface InspectionReportPipelineDependencies {
  readonly database: DatabaseAdapter;
  readonly deliveryAdapter: DeliveryAdapter;
  readonly renderer?: ReportRenderer;
  readonly now?: () => Date;
  readonly processInline?: boolean;
}

export interface SubmitInspectionInput {
  readonly inspectionId: string;
  readonly sourceChannel: InspectionSourceChannel | string;
  readonly sourceIdempotencyKey: string;
  readonly payload: JsonObject;
  readonly actorUserId: string;
  readonly correlationId: string;
  readonly recipients?: readonly string[];
}

export interface ReviewReportInput {
  readonly reportId: string;
  readonly decision: ReportReviewDecision | string;
  readonly comment?: string | null;
  readonly actorUserId: string;
  readonly correlationId: string;
  readonly expectedVersion?: number;
  readonly affectedSections?: readonly string[];
}

export interface AuthorizeDeliveryInput {
  readonly reportId: string;
  readonly actorUserId: string;
  readonly correlationId: string;
  readonly recipients?: readonly string[];
}

export interface RevokeDeliveryAuthorizationInput {
  readonly reportId: string;
  readonly actorUserId: string;
  readonly correlationId: string;
  readonly reason?: string | null;
}

export interface ReopenReportForRevisionInput {
  readonly reportId: string;
  readonly actorUserId: string;
  readonly correlationId: string;
  readonly comment: string;
  readonly expectedVersion?: number;
  readonly reportVersionId?: string;
}

export class InspectionReportPipeline {
  readonly repository: SqlOperationsRepository;
  workControl: WorkControlPlane | null = null;
  private readonly renderer: ReportRenderer;
  private readonly processInline: boolean;
  private readonly now: () => Date;

  constructor(private readonly dependencies: InspectionReportPipelineDependencies) {
    this.repository = new SqlOperationsRepository(dependencies.database);
    this.renderer = dependencies.renderer ?? configurableSyntheticRenderer;
    this.processInline = dependencies.processInline === true;
    this.now = dependencies.now ?? (() => new Date());
  }

  bindWorkControl(workControl: WorkControlPlane): void {
    this.workControl = workControl;
  }

  private async afterDomainWork(): Promise<void> {
    if (!this.processInline || !this.workControl) return;
    await this.workControl.processPendingEvents();
    await this.workControl.evaluateDueSchedules();
  }

  async submitInspection(input: SubmitInspectionInput): Promise<{
    readonly submission: InspectionSubmission;
    readonly duplicate: boolean;
    readonly inspection: Inspection;
  }> {
    if (!isInspectionSourceChannel(input.sourceChannel)) {
      throw new OperationsValidationError("A supported inspection source channel is required.");
    }
    if (!input.sourceIdempotencyKey.trim()) {
      throw new OperationsValidationError("A source idempotency key is required.");
    }
    const payloadHash = hashJson(input.payload);
    const existing =
      (await this.repository.getSubmissionByIdempotency(
        input.inspectionId,
        input.sourceIdempotencyKey.trim(),
      )) ?? (await this.repository.getSubmissionByHash(input.inspectionId, payloadHash));
    if (existing) {
      return this.duplicateSubmissionResult(input, existing);
    }

    let result: { readonly submission: InspectionSubmission; readonly inspection: Inspection };
    try {
      result = await this.dependencies.database.transaction(async (transaction) => {
        const inspectionRow = await transaction.query<SqlRow>(
          "SELECT * FROM inspections WHERE id=$1 FOR UPDATE",
          [input.inspectionId],
        );
        const inspection = inspectionRow.rows[0] ? mapInspection(inspectionRow.rows[0]) : null;
        if (!inspection) throw new OperationsNotFoundError("Inspection was not found.");
        const now = this.stamp();
        let pack: BoundConfigurationPackage | null = null;
        let normalized = normalizeInspectionPayload(input.payload);
        let schemaVersion = OPERATIONS_CONTRACT_VERSION;
        let mappingVersion = `${SYNTHETIC_REPORT_TEMPLATE_KEY}@1`;
        let sourceLineage: JsonObject | null = null;
        if (inspection.configurationReleaseId) {
          pack = await loadSyntheticBoundPackage(transaction, inspection.configurationReleaseId);
          const mapping = applySourceMapping(input.payload, pack.mapping, pack.schema);
          const projected = projectCanonicalToNormalized(mapping.canonical);
          normalized = {
            ...projected,
            canonicalRecord: mapping.canonical,
          } as NormalizedInspectionPayload;
          schemaVersion = `${pack.schema.schemaKey}@${pack.schema.schemaVersion}`;
          mappingVersion = `${pack.mapping.profileKey}@${pack.mapping.profileVersion}`;
          sourceLineage = {
            lineage: mapping.canonical.lineage as unknown as JsonObject[],
            unmappedSourceFields: [...mapping.unmappedSourceFields],
            canonicalFieldsWithoutSource: [...mapping.canonicalFieldsWithoutSource],
            conflicts: [...mapping.conflicts],
          };
        }
        const operationalCompletedAt = inspection.configurationReleaseId
          ? (inspection.completedAt ?? normalized.completedAt)
          : normalized.completedAt;
        await this.applyInspectionCompletion(transaction, inspection, operationalCompletedAt, now);
        const locked = mapInspection(
          (
            await transaction.query<SqlRow>("SELECT * FROM inspections WHERE id=$1", [
              inspection.id,
            ])
          ).rows[0] as SqlRow,
        );
        const completedAt = locked.completedAt ?? now;
        await this.moveInspectionTowardSubmission(transaction, locked, completedAt, now);
        const submissionId = randomUUID();
        const inserted = await transaction.query<SqlRow>(
          `INSERT INTO inspection_submissions
         (id,inspection_id,source_channel,source_idempotency_key,payload_sha256,raw_payload,schema_version,mapping_version,normalized_payload,actor_user_id,correlation_id,created_at,configuration_release_id,source_lineage)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,$10,$11,$12,$13,$14::jsonb)
         RETURNING *`,
          [
            submissionId,
            inspection.id,
            input.sourceChannel,
            input.sourceIdempotencyKey.trim(),
            payloadHash,
            JSON.stringify(input.payload),
            schemaVersion,
            mappingVersion,
            JSON.stringify(normalized),
            input.actorUserId,
            input.correlationId,
            now,
            inspection.configurationReleaseId,
            sourceLineage ? JSON.stringify(sourceLineage) : null,
          ],
        );
        const submission = mapSubmission(inserted.rows[0] as SqlRow);
        await this.persistFindingsAndEvidence(transaction, submission, normalized, now);
        const liveInspection = mapInspection(
          (
            await transaction.query<SqlRow>("SELECT * FROM inspections WHERE id=$1", [
              inspection.id,
            ])
          ).rows[0] as SqlRow,
        );
        await this.ensureSlaClock(
          transaction,
          inspection.id,
          liveInspection.completedAt ?? completedAt,
          now,
          pack,
        );
        await this.closeAndStartStage(
          transaction,
          inspection.id,
          "inspection_completed_to_submission_received",
          "submission_received_to_validation_completed",
          "system_processing",
          now,
        );
        const event = await insertAutomationEvent(transaction, {
          eventType: "inspection.submitted",
          aggregateType: "inspection",
          aggregateId: inspection.id,
          correlationId: input.correlationId,
          actorType: "user",
          actorId: input.actorUserId,
          payload: {
            inspectionId: inspection.id,
            submissionId: submission.id,
            sourceChannel: submission.sourceChannel,
            payloadSha256: submission.payloadSha256,
            exceptionIds: await this.listOpenExceptionIds(transaction, inspection.id),
          },
          occurredAt: now,
        });
        await enqueueAutomationJob(transaction, {
          jobType: "inspection.validate",
          blueprintKey: "inspection.submission-validation",
          blueprintVersion: 1,
          aggregateType: "inspection",
          aggregateId: inspection.id,
          eventId: event.id,
          idempotencyKey: buildIdempotencyKey([
            "inspection.validate",
            inspection.id,
            submission.id,
            "v1",
          ]),
          payload: {
            submissionId: submission.id,
            recipients: [...(input.recipients ?? ["client@example.invalid"])],
          },
          now,
        });
        await recordAuditAndActivity(transaction, {
          eventType: "inspection.submitted",
          action: "inspection.submit",
          actorUserId: input.actorUserId,
          resourceType: "inspection",
          resourceId: inspection.id,
          correlationId: input.correlationId,
          metadata: { submissionId: submission.id, duplicate: false },
          summary: `Inspection submitted: ${inspection.reference}`,
          inspectionId: inspection.id,
          now,
        });
        const updated = await transaction.query<SqlRow>("SELECT * FROM inspections WHERE id=$1", [
          inspection.id,
        ]);
        return {
          submission,
          inspection: mapInspection(updated.rows[0] as SqlRow),
        };
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        const recovered =
          (await this.repository.getSubmissionByIdempotency(
            input.inspectionId,
            input.sourceIdempotencyKey.trim(),
          )) ?? (await this.repository.getSubmissionByHash(input.inspectionId, payloadHash));
        if (recovered) {
          return this.duplicateSubmissionResult(input, recovered);
        }
      }
      throw error;
    }
    if (this.processInline) {
      await this.processPendingJobs({
        claimOwner: `inline:${input.correlationId}`,
        aggregateId: input.inspectionId,
      });
      await this.afterDomainWork();
    }
    const inspection =
      (await this.repository.getInspection(input.inspectionId)) ?? result.inspection;
    return { ...result, inspection, duplicate: false };
  }

  async reviewReport(input: ReviewReportInput): Promise<{
    readonly report: InspectionReport;
    readonly version: ReportVersion;
  }> {
    if (!isReportReviewDecision(input.decision)) {
      throw new OperationsValidationError("A valid review decision is required.");
    }
    const reviewed = await this.dependencies.database.transaction(async (transaction) => {
      const reportRow = await transaction.query<SqlRow>(
        "SELECT * FROM inspection_reports WHERE id=$1 FOR UPDATE",
        [input.reportId],
      );
      const report = reportRow.rows[0] ? mapReport(reportRow.rows[0]) : null;
      if (!report) throw new OperationsNotFoundError("Report was not found.");
      if (input.expectedVersion && input.expectedVersion !== report.version) {
        throw new OperationsValidationError("Report changed before the review could be recorded.");
      }
      if (report.status !== "in_review" && report.status !== "draft_ready") {
        throw new OperationsStatusTransitionError("report", report.status, "approved");
      }
      const versionRow = await transaction.query<SqlRow>(
        "SELECT * FROM report_versions WHERE report_id=$1 AND version_number=$2 FOR UPDATE",
        [report.id, report.currentVersionNumber],
      );
      const version = versionRow.rows[0] ? mapReportVersion(versionRow.rows[0]) : null;
      if (!version) throw new OperationsNotFoundError("Report version was not found.");
      const now = this.stamp();
      const comment = input.comment?.trim() || null;
      if (input.decision === "approve") {
        await this.transitionReport(transaction, report, "approved", now);
        await transaction.query(
          `UPDATE report_versions SET status='approved', reviewer_user_id=$2, reviewed_at=$3, review_decision='approve', review_comment=$4
           WHERE id=$1`,
          [version.id, input.actorUserId, now, comment],
        );
        const event = await insertAutomationEvent(transaction, {
          eventType: "report.approved",
          aggregateType: "report",
          aggregateId: report.id,
          correlationId: input.correlationId,
          actorType: "user",
          actorId: input.actorUserId,
          payload: {
            inspectionId: report.inspectionId,
            reportId: report.id,
            reportVersionId: version.id,
            versionId: version.id,
            versionNumber: version.versionNumber,
          },
          occurredAt: now,
        });
        await enqueueAutomationJob(transaction, {
          jobType: "report.render-final",
          blueprintKey: "report.delivery",
          blueprintVersion: 1,
          aggregateType: "report",
          aggregateId: report.id,
          eventId: event.id,
          idempotencyKey: buildIdempotencyKey(["report.render-final", report.id, version.id, "v1"]),
          payload: { versionId: version.id },
          now,
        });
        await this.closeAndStartStage(
          transaction,
          report.inspectionId,
          "report_draft_created_to_technical_decision",
          "technical_approval_to_final_artifact_rendered",
          "system_processing",
          now,
        );
      } else if (input.decision === "request_revision") {
        await this.transitionReport(transaction, report, "revision_required", now);
        await transaction.query(
          `UPDATE report_versions SET status='revision_required', reviewer_user_id=$2, reviewed_at=$3, review_decision='request_revision', review_comment=$4
           WHERE id=$1`,
          [version.id, input.actorUserId, now, comment],
        );
        await this.recordReviewComments(transaction, version.id, input, now);
        await this.pauseSla(transaction, report.inspectionId, "awaiting_human", now);
        await this.returnInspectionForCorrection(
          transaction,
          report.inspectionId,
          now,
          "reporting",
        );
        await insertAutomationEvent(transaction, {
          eventType: "report.revision_requested",
          aggregateType: "report",
          aggregateId: report.id,
          correlationId: input.correlationId,
          actorType: "user",
          actorId: input.actorUserId,
          payload: {
            inspectionId: report.inspectionId,
            reportId: report.id,
            reportVersionId: version.id,
            versionId: version.id,
            requestedRevisionVersionId: version.id,
            comment,
            affectedSections: [...(input.affectedSections ?? [])],
          },
          occurredAt: now,
        });
        await this.ensureOpenException(transaction, {
          inspectionId: report.inspectionId,
          reportId: report.id,
          kind: "state",
          title: `Report revision required for ${report.reference}`,
          detail:
            comment ??
            "Reviewer requested a report revision. Submit corrected inspection input before a new version is assembled.",
          ownerUserId:
            (await this.inspectionOwner(transaction, report.inspectionId)) ?? input.actorUserId,
          slaAttribution: "human_waiting",
          now,
          correlationId: input.correlationId,
        });
        await this.createTask(transaction, {
          title: `Revise ${report.reference}`,
          description: comment ?? "Reviewer requested a report revision.",
          assigneeUserId:
            (await this.inspectionOwner(transaction, report.inspectionId)) ?? input.actorUserId,
          inspectionId: report.inspectionId,
          reportId: report.id,
          actorUserId: input.actorUserId,
          now,
        });
        await this.closeOpenStage(
          transaction,
          report.inspectionId,
          "report_draft_created_to_technical_decision",
          "human_waiting",
          now,
        );
      } else {
        await this.transitionReport(transaction, report, "revision_required", now);
        await transaction.query(
          `UPDATE report_versions SET status='revision_required', reviewer_user_id=$2, reviewed_at=$3, review_decision='return_to_inspector', review_comment=$4
           WHERE id=$1`,
          [version.id, input.actorUserId, now, comment],
        );
        await this.recordReviewComments(transaction, version.id, input, now);
        await this.pauseSla(transaction, report.inspectionId, "awaiting_human", now);
        await this.returnInspectionForCorrection(
          transaction,
          report.inspectionId,
          now,
          "reporting",
        );
        const returnedException = await this.ensureOpenException(transaction, {
          inspectionId: report.inspectionId,
          reportId: report.id,
          kind: "validation",
          title: `Inspector correction required for ${report.reference}`,
          detail:
            comment ??
            "Reviewer returned the report to the inspector. Corrected field evidence is required.",
          ownerUserId:
            (await this.inspectionOwner(transaction, report.inspectionId)) ?? input.actorUserId,
          slaAttribution: "human_waiting",
          now,
          correlationId: input.correlationId,
        });
        await insertAutomationEvent(transaction, {
          eventType: "report.returned_to_inspector",
          aggregateType: "report",
          aggregateId: report.id,
          correlationId: input.correlationId,
          actorType: "user",
          actorId: input.actorUserId,
          payload: {
            inspectionId: report.inspectionId,
            reportId: report.id,
            reportVersionId: version.id,
            versionId: version.id,
            requestedRevisionVersionId: version.id,
            exceptionId: returnedException.id,
            exceptionIds: [returnedException.id],
            returnedToInspector: true,
            comment,
            affectedSections: [...(input.affectedSections ?? [])],
          },
          occurredAt: now,
        });
        await this.createTask(transaction, {
          title: `Correct inspection for ${report.reference}`,
          description: comment ?? "Reviewer returned the report to the inspector.",
          assigneeUserId:
            (await this.inspectionOwner(transaction, report.inspectionId)) ?? input.actorUserId,
          inspectionId: report.inspectionId,
          reportId: report.id,
          actorUserId: input.actorUserId,
          now,
        });
        await this.closeOpenStage(
          transaction,
          report.inspectionId,
          "report_draft_created_to_technical_decision",
          "human_waiting",
          now,
        );
      }
      await recordAuditAndActivity(transaction, {
        eventType: `report.${input.decision}`,
        action: "report.review",
        actorUserId: input.actorUserId,
        resourceType: "report",
        resourceId: report.id,
        correlationId: input.correlationId,
        metadata: { decision: input.decision, versionId: version.id },
        summary: `Report ${report.reference} ${input.decision.replaceAll("_", " ")}`,
        inspectionId: report.inspectionId,
        reportId: report.id,
        now,
      });
      const updatedReport = await transaction.query<SqlRow>(
        "SELECT * FROM inspection_reports WHERE id=$1",
        [report.id],
      );
      const updatedVersion = await transaction.query<SqlRow>(
        "SELECT * FROM report_versions WHERE id=$1",
        [version.id],
      );
      return {
        report: mapReport(updatedReport.rows[0] as SqlRow),
        version: mapReportVersion(updatedVersion.rows[0] as SqlRow),
      };
    });
    if (this.processInline) {
      await this.processPendingJobs({
        claimOwner: `inline-review:${input.correlationId}`,
        aggregateId: reviewed.report.id,
      });
      await this.processPendingJobs({
        claimOwner: `inline-review-inspection:${input.correlationId}`,
        aggregateId: reviewed.report.inspectionId,
      });
      await this.afterDomainWork();
    }
    const report = (await this.repository.getReport(reviewed.report.id)) ?? reviewed.report;
    const versions = await this.repository.listReportVersions(report.id);
    const version =
      versions.find((item) => item.versionNumber === report.currentVersionNumber) ??
      reviewed.version;
    return { report, version };
  }

  async reopenReportForRevision(input: ReopenReportForRevisionInput): Promise<{
    readonly report: InspectionReport;
    readonly version: ReportVersion;
  }> {
    const comment = input.comment.trim();
    if (!comment) {
      throw new OperationsValidationError("A nonempty revision reason is required.");
    }
    const reopened = await this.dependencies.database.transaction(async (transaction) => {
      const reportRow = await transaction.query<SqlRow>(
        "SELECT * FROM inspection_reports WHERE id=$1 FOR UPDATE",
        [input.reportId],
      );
      const report = reportRow.rows[0] ? mapReport(reportRow.rows[0]) : null;
      if (!report) throw new OperationsNotFoundError("Report was not found.");
      if (input.expectedVersion && input.expectedVersion !== report.version) {
        throw new OperationsValidationError(
          "Report changed before the revision could be recorded.",
        );
      }
      if (report.status !== "ready_for_delivery") {
        throw new OperationsStatusTransitionError("report", report.status, "revision_required");
      }
      const versionRow = await transaction.query<SqlRow>(
        "SELECT * FROM report_versions WHERE report_id=$1 AND version_number=$2 FOR UPDATE",
        [report.id, report.currentVersionNumber],
      );
      const version = versionRow.rows[0] ? mapReportVersion(versionRow.rows[0]) : null;
      if (!version) throw new OperationsNotFoundError("Report version was not found.");
      if (input.reportVersionId && input.reportVersionId !== version.id) {
        throw new OperationsValidationError(
          "The bound Report version is no longer the current deliverable version.",
        );
      }
      if (version.reviewDecision !== "approve") {
        throw new OperationsValidationError(
          "Delivery-gate revision requires a technically approved current Report version.",
        );
      }
      const confirmed = await transaction.query<SqlRow>(
        "SELECT id FROM report_deliveries WHERE report_id=$1 AND status='delivered' LIMIT 1",
        [report.id],
      );
      if (confirmed.rows[0]) {
        throw new OperationsValidationError(
          "A confirmed delivery already exists; the Report cannot be reopened.",
        );
      }
      const now = this.stamp();
      await transaction.query(
        `UPDATE delivery_authorizations
            SET status='superseded', updated_at=$2, version=version+1
          WHERE report_id=$1 AND status='active'`,
        [report.id, now],
      );
      await this.transitionReport(transaction, report, "revision_required", now);
      await this.recordReviewComments(
        transaction,
        version.id,
        {
          reportId: report.id,
          decision: "request_revision",
          comment,
          actorUserId: input.actorUserId,
          correlationId: input.correlationId,
        },
        now,
      );
      await this.pauseSla(transaction, report.inspectionId, "awaiting_human", now);
      await this.returnInspectionForCorrection(transaction, report.inspectionId, now, "reporting");
      await insertAutomationEvent(transaction, {
        eventType: "report.revision_requested",
        aggregateType: "report",
        aggregateId: report.id,
        correlationId: input.correlationId,
        actorType: "user",
        actorId: input.actorUserId,
        payload: {
          inspectionId: report.inspectionId,
          reportId: report.id,
          reportVersionId: version.id,
          versionId: version.id,
          requestedRevisionVersionId: version.id,
          comment,
          source: "owner_delivery_gate",
        },
        occurredAt: now,
      });
      await this.ensureOpenException(transaction, {
        inspectionId: report.inspectionId,
        reportId: report.id,
        kind: "state",
        title: `Report revision required for ${report.reference}`,
        detail: comment,
        ownerUserId:
          (await this.inspectionOwner(transaction, report.inspectionId)) ?? input.actorUserId,
        slaAttribution: "human_waiting",
        now,
        correlationId: input.correlationId,
      });
      await this.createTask(transaction, {
        title: `Revise ${report.reference}`,
        description: comment,
        assigneeUserId:
          (await this.inspectionOwner(transaction, report.inspectionId)) ?? input.actorUserId,
        inspectionId: report.inspectionId,
        reportId: report.id,
        actorUserId: input.actorUserId,
        now,
      });
      await this.closeOpenStage(
        transaction,
        report.inspectionId,
        "final_artifact_rendered_to_delivery_authorized",
        "human_waiting",
        now,
      );
      await recordAuditAndActivity(transaction, {
        eventType: "report.revision_requested",
        action: "report.reopen-for-revision",
        actorUserId: input.actorUserId,
        resourceType: "report",
        resourceId: report.id,
        correlationId: input.correlationId,
        metadata: { versionId: version.id, source: "owner_delivery_gate" },
        summary: `Owner requested delivery changes for ${report.reference} Version ${version.versionNumber}`,
        inspectionId: report.inspectionId,
        reportId: report.id,
        now,
      });
      const updatedReport = await transaction.query<SqlRow>(
        "SELECT * FROM inspection_reports WHERE id=$1",
        [report.id],
      );
      const updatedVersion = await transaction.query<SqlRow>(
        "SELECT * FROM report_versions WHERE id=$1",
        [version.id],
      );
      return {
        report: mapReport(updatedReport.rows[0] as SqlRow),
        version: mapReportVersion(updatedVersion.rows[0] as SqlRow),
      };
    });
    if (this.processInline) {
      await this.afterDomainWork();
    }
    return reopened;
  }

  async authorizeDelivery(input: AuthorizeDeliveryInput): Promise<{
    readonly report: InspectionReport;
    readonly authorizationId: string;
  }> {
    const authorized = await this.dependencies.database.transaction(async (transaction) => {
      const reportRow = await transaction.query<SqlRow>(
        "SELECT * FROM inspection_reports WHERE id=$1 FOR UPDATE",
        [input.reportId],
      );
      const report = reportRow.rows[0] ? mapReport(reportRow.rows[0]) : null;
      if (!report) throw new OperationsNotFoundError("Report was not found.");
      if (report.status === "revision_required") {
        throw new OperationsStatusTransitionError("report", report.status, "delivering");
      }
      if (report.status !== "ready_for_delivery") {
        throw new OperationsStatusTransitionError("report", report.status, "delivering");
      }
      const versionRow = await transaction.query<SqlRow>(
        "SELECT * FROM report_versions WHERE report_id=$1 AND version_number=$2 FOR UPDATE",
        [report.id, report.currentVersionNumber],
      );
      const version = versionRow.rows[0] ? mapReportVersion(versionRow.rows[0]) : null;
      if (!version) throw new OperationsNotFoundError("Report version was not found.");
      if (!version.renderedChecksum) {
        throw new OperationsValidationError(
          "A rendered artifact checksum is required before delivery can be authorized.",
        );
      }
      const confirmed = await transaction.query<SqlRow>(
        "SELECT id FROM report_deliveries WHERE report_id=$1 AND status='delivered' LIMIT 1",
        [report.id],
      );
      if (confirmed.rows[0]) {
        throw new OperationsValidationError("This report already has a confirmed delivery.");
      }
      const recipients = [...(input.recipients ?? DEFAULT_LOCAL_TEST_RECIPIENTS)];
      const now = this.stamp();
      await transaction.query(
        `UPDATE delivery_authorizations
            SET status='superseded', updated_at=$2, version=version+1
          WHERE report_id=$1 AND status='active'`,
        [report.id, now],
      );
      const authorizationId = randomUUID();
      await transaction.query(
        `INSERT INTO delivery_authorizations
         (id,report_id,report_version_id,artifact_checksum,recipients,destination_kind,authorizing_user_id,authorized_at,status,created_at,updated_at,version)
         VALUES ($1,$2,$3,$4,$5::jsonb,'local_test',$6,$7,'active',$7,$7,1)`,
        [
          authorizationId,
          report.id,
          version.id,
          version.renderedChecksum,
          JSON.stringify(recipients),
          input.actorUserId,
          now,
        ],
      );
      const event = await insertAutomationEvent(transaction, {
        eventType: "report.delivery_requested",
        aggregateType: "report",
        aggregateId: report.id,
        correlationId: input.correlationId,
        actorType: "user",
        actorId: input.actorUserId,
        payload: {
          inspectionId: report.inspectionId,
          reportId: report.id,
          reportVersionId: version.id,
          versionId: version.id,
          authorizationId,
          deliveryAuthorizationId: authorizationId,
          checksum: version.renderedChecksum,
          recipients,
        },
        occurredAt: now,
      });
      await this.transitionReport(transaction, report, "delivering", now);
      await enqueueAutomationJob(transaction, {
        jobType: "report.deliver",
        blueprintKey: "report.delivery",
        blueprintVersion: 1,
        aggregateType: "report",
        aggregateId: report.id,
        eventId: event.id,
        idempotencyKey: buildIdempotencyKey(["report.deliver", report.id, version.id, "v1"]),
        payload: {
          versionId: version.id,
          authorizationId,
          checksum: version.renderedChecksum,
          recipients,
          destinationKind: "local_test",
        },
        now,
      });
      await recordAuditAndActivity(transaction, {
        eventType: "report.delivery_requested",
        action: "report.authorize-delivery",
        actorUserId: input.actorUserId,
        resourceType: "report",
        resourceId: report.id,
        correlationId: input.correlationId,
        metadata: { authorizationId, versionId: version.id, checksum: version.renderedChecksum },
        summary: `Client delivery authorized for ${report.reference}`,
        inspectionId: report.inspectionId,
        reportId: report.id,
        now,
      });
      await this.closeAndStartStage(
        transaction,
        report.inspectionId,
        "final_artifact_rendered_to_delivery_authorized",
        "delivery_authorized_to_confirmed_delivery",
        "system_processing",
        now,
      );
      return { reportId: report.id, authorizationId };
    });
    if (this.processInline) {
      await this.processPendingJobs({
        claimOwner: `inline-deliver:${input.correlationId}`,
        aggregateId: input.reportId,
      });
      await this.afterDomainWork();
    }
    const report = await this.repository.getReport(authorized.reportId);
    if (!report) throw new OperationsNotFoundError("Report was not found.");
    return { report, authorizationId: authorized.authorizationId };
  }

  async revokeDeliveryAuthorization(input: RevokeDeliveryAuthorizationInput): Promise<void> {
    await this.dependencies.database.transaction(async (transaction) => {
      const reportRow = await transaction.query<SqlRow>(
        "SELECT * FROM inspection_reports WHERE id=$1 FOR UPDATE",
        [input.reportId],
      );
      const report = reportRow.rows[0] ? mapReport(reportRow.rows[0]) : null;
      if (!report) throw new OperationsNotFoundError("Report was not found.");
      const now = this.stamp();
      const active = await transaction.query<SqlRow>(
        `UPDATE delivery_authorizations
            SET status='revoked', revoked_at=$2, revoked_by_user_id=$3, reserved_token=NULL, reserved_at=NULL, updated_at=$2, version=version+1
          WHERE report_id=$1 AND status='active'
          RETURNING *`,
        [report.id, now, input.actorUserId],
      );
      if (!active.rows[0]) {
        throw new OperationsValidationError("No active delivery authorization exists to revoke.");
      }
      if (report.status === "delivering") {
        await this.transitionReport(transaction, report, "ready_for_delivery", now);
      }
      await insertAutomationEvent(transaction, {
        eventType: "report.delivery_authorization_revoked",
        aggregateType: "report",
        aggregateId: report.id,
        correlationId: input.correlationId,
        actorType: "user",
        actorId: input.actorUserId,
        payload: {
          inspectionId: report.inspectionId,
          reportId: report.id,
          reportVersionId: String(active.rows[0].report_version_id),
          versionId: String(active.rows[0].report_version_id),
          authorizationId: String(active.rows[0].id),
          deliveryAuthorizationId: String(active.rows[0].id),
          reason: input.reason ?? null,
        },
        occurredAt: now,
      });
      await recordAuditAndActivity(transaction, {
        eventType: "report.delivery_authorization_revoked",
        action: "report.revoke-delivery-authorization",
        actorUserId: input.actorUserId,
        resourceType: "report",
        resourceId: report.id,
        correlationId: input.correlationId,
        metadata: { authorizationId: String(active.rows[0].id) },
        summary: `Delivery authorization revoked for ${report.reference}`,
        inspectionId: report.inspectionId,
        reportId: report.id,
        now,
      });
    });
  }

  async retryDelivery(input: {
    readonly reportId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
  }): Promise<void> {
    const now = this.stamp();
    await this.dependencies.database.transaction(async (transaction) => {
      const reportRow = await transaction.query<SqlRow>(
        "SELECT * FROM inspection_reports WHERE id=$1 FOR UPDATE",
        [input.reportId],
      );
      const report = reportRow.rows[0] ? mapReport(reportRow.rows[0]) : null;
      if (!report) throw new OperationsNotFoundError("Report was not found.");
      const versionRow = await transaction.query<SqlRow>(
        "SELECT * FROM report_versions WHERE report_id=$1 AND version_number=$2",
        [report.id, report.currentVersionNumber],
      );
      const version = mapReportVersion(versionRow.rows[0] as SqlRow);
      const authorizationRow = await transaction.query<SqlRow>(
        `SELECT * FROM delivery_authorizations
          WHERE report_id=$1 AND report_version_id=$2 AND status='active'
          ORDER BY authorized_at DESC LIMIT 1`,
        [report.id, version.id],
      );
      const authorization = authorizationRow.rows[0]
        ? mapDeliveryAuthorization(authorizationRow.rows[0])
        : null;
      if (!authorization) {
        throw new OperationsValidationError(
          "Delivery retry requires the original active authorization for this exact report version.",
        );
      }
      if (authorization.artifactChecksum !== version.renderedChecksum) {
        throw new OperationsValidationError(
          "The authorized artifact no longer matches this report version.",
        );
      }
      const confirmed = await transaction.query<SqlRow>(
        "SELECT id FROM report_deliveries WHERE report_id=$1 AND status='delivered' LIMIT 1",
        [report.id],
      );
      if (confirmed.rows[0] || report.status === "delivered") {
        throw new OperationsValidationError("A confirmed delivery already exists.");
      }
      if (report.status !== "delivery_failed" && report.status !== "delivering") {
        throw new OperationsStatusTransitionError("report", report.status, "delivering");
      }
      if (report.status === "delivery_failed") {
        await this.transitionReport(transaction, report, "delivering", now);
      }
      await enqueueAutomationJob(transaction, {
        jobType: "report.deliver",
        blueprintKey: "report.delivery",
        blueprintVersion: 1,
        aggregateType: "report",
        aggregateId: report.id,
        eventId: null,
        idempotencyKey: buildIdempotencyKey(["report.deliver", report.id, version.id, "v1"]),
        payload: {
          versionId: version.id,
          authorizationId: authorization.id,
          checksum: authorization.artifactChecksum,
          recipients: [...authorization.recipients],
          destinationKind: authorization.destinationKind,
          retry: true,
        },
        now,
      });
    });
    if (this.processInline) {
      await this.processPendingJobs({
        claimOwner: `inline-retry:${input.correlationId}`,
        aggregateId: input.reportId,
      });
      await this.afterDomainWork();
    }
  }

  async resolveException(input: {
    readonly exceptionId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
    readonly resolution?: string | null;
  }): Promise<void> {
    await this.dependencies.database.transaction(async (transaction) => {
      const row = await transaction.query<SqlRow>(
        "SELECT * FROM exception_cases WHERE id=$1 FOR UPDATE",
        [input.exceptionId],
      );
      if (!row.rows[0]) throw new OperationsNotFoundError("Exception was not found.");
      const now = this.stamp();
      await this.resolveExceptionRows(
        transaction,
        [String(row.rows[0].id)],
        now,
        input.resolution ?? "Exception resolved.",
        input.actorUserId,
        "user",
        input.correlationId,
        String(row.rows[0].id),
      );
    });
    await this.afterDomainWork();
  }

  async claimNextRunnableJob(claimOwner: string, aggregateId?: string) {
    return this.claimNextJob(claimOwner, aggregateId);
  }

  async processPendingJobs(input: {
    readonly claimOwner: string;
    readonly aggregateId?: string;
    readonly limit?: number;
  }): Promise<{ readonly processed: number }> {
    let processed = 0;
    for (let iteration = 0; iteration < 40; iteration += 1) {
      const claimed = await this.claimNextJob(input.claimOwner, input.aggregateId);
      if (!claimed) break;
      processed += 1;
      try {
        await this.executeJob(claimed.id, input.claimOwner);
      } catch (error) {
        await this.failJob(claimed.id, input.claimOwner, error);
      }
    }
    return { processed };
  }

  async executeClaimedJob(jobId: string, claimOwner: string): Promise<void> {
    try {
      await this.executeJob(jobId, claimOwner);
    } catch (error) {
      await this.failJob(jobId, claimOwner, error);
    }
  }

  private async claimNextJob(claimOwner: string, aggregateId?: string) {
    const now = this.stamp();
    return this.dependencies.database.transaction(async (transaction) => {
      const row = await claimRunnableJob(this.dependencies.database, transaction, {
        claimOwner,
        now,
        ...(aggregateId ? { aggregateId } : {}),
      });
      return row ? mapJob(row) : null;
    });
  }

  private async executeJob(jobId: string, claimOwner: string): Promise<void> {
    const jobRow = await this.dependencies.database.query<SqlRow>(
      "SELECT * FROM automation_jobs WHERE id=$1",
      [jobId],
    );
    const job = jobRow.rows[0] ? mapJob(jobRow.rows[0]) : null;
    if (!job || job.status !== "claimed" || job.claimedBy !== claimOwner) return;
    if (job.jobType === "inspection.validate") {
      await this.runValidation(job.aggregateId, String(job.payload.submissionId ?? ""), job.id);
    } else if (job.jobType === "report.assemble") {
      await this.runAssembly(job.aggregateId, String(job.payload.submissionId ?? ""), job.id);
    } else if (job.jobType === "report.render-final") {
      await this.runRender(job.aggregateId, String(job.payload.versionId ?? ""), job.id);
    } else if (job.jobType === "report.deliver") {
      await this.runDelivery(
        job.aggregateId,
        String(job.payload.versionId ?? ""),
        job.id,
        claimOwner,
      );
    }
    const now = this.stamp();
    await succeedClaimedJob(this.dependencies.database, { jobId, claimOwner, now });
    await insertAutomationEvent(this.dependencies.database, {
      eventType: "automation.job_succeeded",
      aggregateType: "job",
      aggregateId: jobId,
      correlationId: jobId,
      actorType: "worker",
      actorId: null,
      payload: {
        jobId,
        jobType: job.jobType,
        inspectionId: job.aggregateType === "inspection" ? job.aggregateId : null,
        reportId: job.aggregateType === "report" ? job.aggregateId : null,
      },
      occurredAt: now,
    });
  }

  private async failJob(jobId: string, claimOwner: string, error: unknown): Promise<void> {
    const jobRow = await this.dependencies.database.query<SqlRow>(
      "SELECT * FROM automation_jobs WHERE id=$1",
      [jobId],
    );
    const job = jobRow.rows[0] ? mapJob(jobRow.rows[0]) : null;
    if (!job || job.status !== "claimed" || job.claimedBy !== claimOwner) return;
    const retryable =
      job.jobType === "report.deliver"
        ? false
        : error instanceof DeliveryAdapterError
          ? error.retryable
          : true;
    const attempt = job.attemptCount;
    const now = this.stamp();
    const dead = !retryable || attempt >= job.maxAttempts;
    const nextStatus = dead ? "dead_letter" : "pending";
    const availableAt = new Date(Date.parse(now) + 2 ** attempt * 1000).toISOString();
    await failClaimedJob(this.dependencies.database, {
      jobId,
      claimOwner,
      status: nextStatus,
      attemptCount: attempt,
      availableAt: dead ? now : availableAt,
      now,
      lastError: JSON.stringify({
        code: error instanceof Error && "code" in error ? String(error.code) : "JOB_FAILED",
        message: error instanceof Error ? error.message : "Job failed.",
        retryable,
      }),
    });
    if (dead && job.jobType !== "report.deliver") {
      await insertAutomationEvent(this.dependencies.database, {
        eventType: "automation.job_dead_letter",
        aggregateType: job.aggregateType,
        aggregateId: job.aggregateId,
        correlationId: jobId,
        actorType: "worker",
        actorId: null,
        payload: {
          jobId,
          jobType: job.jobType,
          inspectionId: job.aggregateType === "inspection" ? job.aggregateId : null,
          reportId: job.aggregateType === "report" ? job.aggregateId : null,
        },
        occurredAt: now,
      });
    }
  }

  private async runValidation(
    inspectionId: string,
    submissionId: string,
    jobId: string,
  ): Promise<void> {
    await this.dependencies.database.transaction(async (transaction) => {
      const inspection = mapInspection(
        (
          await transaction.query<SqlRow>("SELECT * FROM inspections WHERE id=$1 FOR UPDATE", [
            inspectionId,
          ])
        ).rows[0] as SqlRow,
      );
      const submission = mapSubmission(
        (
          await transaction.query<SqlRow>("SELECT * FROM inspection_submissions WHERE id=$1", [
            submissionId,
          ])
        ).rows[0] as SqlRow,
      );
      const template = mapTemplateVersion(
        (
          await transaction.query<SqlRow>(
            "SELECT * FROM report_template_versions WHERE template_id=$1 ORDER BY version_number DESC LIMIT 1",
            [inspection.reportTemplateId],
          )
        ).rows[0] as SqlRow,
      );
      if (inspection.status === "submitted") {
        await this.transitionInspection(transaction, inspection, "validating", this.stamp());
      }
      const current = mapInspection(
        (await transaction.query<SqlRow>("SELECT * FROM inspections WHERE id=$1", [inspection.id]))
          .rows[0] as SqlRow,
      );
      const payload = jsonValue<NormalizedInspectionPayload>(
        submission.normalizedPayload,
        normalizeInspectionPayload(submission.rawPayload),
      );
      const releaseId = inspection.configurationReleaseId ?? submission.configurationReleaseId;
      const pack = releaseId ? await loadSyntheticBoundPackage(transaction, releaseId) : null;
      const result = pack
        ? configuredValidationResult(payload, pack)
        : evaluateInspectionCompleteness(payload, template.requirements);
      const now = this.stamp();
      await transaction.query(
        `INSERT INTO inspection_validation_results
         (id,submission_id,inspection_id,passed,rule_set_key,rule_set_version,blocking,optional_items,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,
        [
          randomUUID(),
          submission.id,
          inspection.id,
          result.passed,
          pack ? pack.validation.ruleSetKey : template.rendererKey,
          pack ? String(pack.validation.ruleSetVersion) : String(template.versionNumber),
          JSON.stringify(result.blocking),
          JSON.stringify(pack ? result.optional : result.optional),
          now,
        ],
      );
      if (!result.passed) {
        await this.transitionInspection(transaction, current, "needs_correction", now);
        await this.pauseSla(transaction, inspection.id, "awaiting_human", now);
        await this.closeAndStartStage(
          transaction,
          inspection.id,
          "submission_received_to_validation_completed",
          "validation_failure_to_corrected_submission",
          "human_waiting",
          now,
        );
        const exception = await this.ensureOpenException(transaction, {
          inspectionId: inspection.id,
          reportId: null,
          kind: "validation",
          title: "Inspection submission is incomplete",
          detail: result.blocking.map((item) => item.message).join(" "),
          ownerUserId: inspection.inspectorUserId ?? inspection.createdByUserId,
          slaAttribution: "human_waiting",
          jobId,
          now,
          correlationId: submission.correlationId ?? jobId,
        });
        await this.createTask(transaction, {
          title: `Correct ${inspection.reference}`,
          description: result.blocking.map((item) => item.message).join(" "),
          assigneeUserId: inspection.inspectorUserId ?? inspection.createdByUserId,
          inspectionId: inspection.id,
          exceptionId: exception.id,
          actorUserId: null,
          now,
        });
        await insertAutomationEvent(transaction, {
          eventType: "inspection.validation_failed",
          aggregateType: "inspection",
          aggregateId: inspection.id,
          correlationId: submission.correlationId ?? jobId,
          actorType: "system",
          actorId: null,
          payload: JSON.parse(
            JSON.stringify({
              blocking: result.blocking,
              inspectionId: inspection.id,
              submissionId: submission.id,
              exceptionId: exception.id,
              exceptionIds: [exception.id],
            }),
          ) as JsonObject,
          occurredAt: now,
        });
        return;
      }
      await this.transitionInspection(transaction, current, "validated", now);
      await this.resumeSla(transaction, inspection.id, now);
      await this.closeAndStartStage(
        transaction,
        inspection.id,
        "submission_received_to_validation_completed",
        "validation_passed_to_report_draft_created",
        "system_processing",
        now,
      );
      await this.closeOpenStage(
        transaction,
        inspection.id,
        "validation_failure_to_corrected_submission",
        "human_waiting",
        now,
      );
      const resolvedExceptionIds = (
        await transaction.query<SqlRow>(
          `SELECT id FROM exception_cases
            WHERE inspection_id=$1 AND kind IN ('validation','state')
              AND status IN ('open','assigned','in_progress')`,
          [inspection.id],
        )
      ).rows.map((item) => String(item.id));
      await this.resolveOpenValidationExceptions(
        transaction,
        inspection.id,
        now,
        submission.correlationId ?? jobId,
      );
      const event = await insertAutomationEvent(transaction, {
        eventType: "inspection.validated",
        aggregateType: "inspection",
        aggregateId: inspection.id,
        correlationId: submission.correlationId ?? jobId,
        actorType: "system",
        actorId: null,
        payload: {
          inspectionId: inspection.id,
          submissionId: submission.id,
          exceptionIds: resolvedExceptionIds,
        },
        occurredAt: now,
      });
      await enqueueAutomationJob(transaction, {
        jobType: "report.assemble",
        blueprintKey: "report.assembly",
        blueprintVersion: 1,
        aggregateType: "inspection",
        aggregateId: inspection.id,
        eventId: event.id,
        idempotencyKey: buildIdempotencyKey([
          "report.assemble",
          inspection.id,
          submission.id,
          "v1",
        ]),
        payload: { submissionId: submission.id },
        now,
      });
    });
  }

  private async runAssembly(
    inspectionId: string,
    submissionId: string,
    jobId: string,
  ): Promise<void> {
    await this.dependencies.database.transaction(async (transaction) => {
      const inspection = mapInspection(
        (
          await transaction.query<SqlRow>("SELECT * FROM inspections WHERE id=$1 FOR UPDATE", [
            inspectionId,
          ])
        ).rows[0] as SqlRow,
      );
      const project = mapProject(
        (
          await transaction.query<SqlRow>("SELECT * FROM projects WHERE id=$1", [
            inspection.projectId,
          ])
        ).rows[0] as SqlRow,
      );
      const submission = mapSubmission(
        (
          await transaction.query<SqlRow>("SELECT * FROM inspection_submissions WHERE id=$1", [
            submissionId,
          ])
        ).rows[0] as SqlRow,
      );
      const template = mapTemplateVersion(
        (
          await transaction.query<SqlRow>(
            "SELECT * FROM report_template_versions WHERE template_id=$1 ORDER BY version_number DESC LIMIT 1",
            [inspection.reportTemplateId],
          )
        ).rows[0] as SqlRow,
      );
      const now = this.stamp();
      if (inspection.status === "validated") {
        await this.transitionInspection(transaction, inspection, "reporting", now);
      }
      await this.resumeSla(transaction, inspection.id, now);
      const existing = await transaction.query<SqlRow>(
        "SELECT * FROM inspection_reports WHERE inspection_id=$1 FOR UPDATE",
        [inspection.id],
      );
      let report = existing.rows[0] ? mapReport(existing.rows[0]) : null;
      const already = await transaction.query<SqlRow>(
        "SELECT id FROM report_versions WHERE submission_id=$1 LIMIT 1",
        [submission.id],
      );
      if (already.rows[0]) {
        return;
      }
      if (!report) {
        const reference = await nextOperationsReference(
          transaction,
          "bea_report_reference_seq",
          "BEA-RP-",
        );
        const inserted = await transaction.query<SqlRow>(
          `INSERT INTO inspection_reports
           (id,reference,inspection_id,project_id,template_id,current_template_version_id,status,current_version_number,created_by_user_id,created_at,updated_at,version,configuration_release_id)
           VALUES ($1,$2,$3,$4,$5,$6,'awaiting_data',0,$7,$8,$8,1,$9)
           RETURNING *`,
          [
            randomUUID(),
            reference,
            inspection.id,
            inspection.projectId,
            inspection.reportTemplateId,
            template.id,
            inspection.createdByUserId,
            now,
            inspection.configurationReleaseId,
          ],
        );
        report = mapReport(inserted.rows[0] as SqlRow);
      }
      if (report.status === "awaiting_data" || report.status === "revision_required") {
        report = await this.transitionReport(transaction, report, "assembling", now);
      }
      await transaction.query(
        `UPDATE delivery_authorizations
            SET status='superseded', updated_at=$2, version=version+1
          WHERE report_id=$1 AND status='active'`,
        [report.id, now],
      );
      const previousVersion = await transaction.query<SqlRow>(
        `SELECT id FROM report_versions WHERE report_id=$1 AND version_number=$2 LIMIT 1`,
        [report.id, report.currentVersionNumber],
      );
      const previousVersionId = previousVersion.rows[0] ? String(previousVersion.rows[0].id) : null;
      await transaction.query(
        "UPDATE report_versions SET status='superseded' WHERE report_id=$1 AND status IN ('draft','in_review','revision_required','approved','final')",
        [report.id],
      );
      const nextVersion = report.currentVersionNumber + 1;
      const releaseId = inspection.configurationReleaseId ?? submission.configurationReleaseId;
      const pack = releaseId ? await loadSyntheticBoundPackage(transaction, releaseId) : null;
      const payload = jsonValue<NormalizedInspectionPayload>(
        submission.normalizedPayload,
        normalizeInspectionPayload(submission.rawPayload),
      );
      const rawPayload = jsonValue<JsonObject>(submission.rawPayload, {});
      const workspaceDocument = rawPayload.workspaceDocument;
      const snapshot: JsonObject = pack
        ? {
            ...configuredReportSnapshot({
              pack,
              inspection,
              project,
              report,
              submission,
              templateVersion: template.versionNumber,
              payload,
              frozenGeneratedAt: now,
            }),
            ...(workspaceDocument && typeof workspaceDocument === "object"
              ? { workspaceDocument }
              : {}),
          }
        : {
            inspectionId: inspection.id,
            inspectionReference: inspection.reference,
            reportReference: report.reference,
            projectReference: project.reference,
            submissionId: submission.id,
            payloadSha256: submission.payloadSha256,
            templateKey: SYNTHETIC_REPORT_TEMPLATE_KEY,
            templateVersion: template.versionNumber,
            frozenGeneratedAt: now,
            payload: submission.normalizedPayload,
            ...(workspaceDocument && typeof workspaceDocument === "object"
              ? { workspaceDocument }
              : {}),
            rawPreserved: true,
          };
      const versionId = randomUUID();
      await transaction.query(
        `INSERT INTO report_versions
         (id,report_id,version_number,status,input_snapshot,template_version_id,submission_id,created_at,configuration_release_id)
         VALUES ($1,$2,$3,'in_review',$4::jsonb,$5,$6,$7,$8)`,
        [
          versionId,
          report.id,
          nextVersion,
          JSON.stringify(snapshot),
          template.id,
          submission.id,
          now,
          pack?.release.id ?? inspection.configurationReleaseId,
        ],
      );
      await transaction.query(
        `UPDATE inspection_reports SET current_version_number=$2, updated_at=$3, version=version+1 WHERE id=$1`,
        [report.id, nextVersion, now],
      );
      if (report.status === "assembling") {
        report = await this.transitionReport(
          transaction,
          { ...report, currentVersionNumber: nextVersion, version: report.version + 1 },
          "draft_ready",
          now,
        );
      }
      if (report.status === "draft_ready") {
        report = await this.transitionReport(transaction, report, "in_review", now);
      }
      const projectRow = await transaction.query<SqlRow>(
        "SELECT * FROM projects WHERE id=$1 FOR UPDATE",
        [project.id],
      );
      const liveProject = mapProject(projectRow.rows[0] as SqlRow);
      if (liveProject.status === "fieldwork" || liveProject.status === "ready") {
        if (liveProject.status === "ready") {
          await this.transitionProject(transaction, liveProject, "fieldwork", now);
        }
        const fieldwork = mapProject(
          (await transaction.query<SqlRow>("SELECT * FROM projects WHERE id=$1", [project.id]))
            .rows[0] as SqlRow,
        );
        if (fieldwork.status === "fieldwork") {
          await this.transitionProject(transaction, fieldwork, "reporting", now);
        }
      }
      await this.createTask(transaction, {
        title: `Review ${report.reference}`,
        description: "Technical review is required before final report delivery.",
        assigneeUserId: inspection.reviewerUserId ?? inspection.createdByUserId,
        inspectionId: inspection.id,
        reportId: report.id,
        actorUserId: null,
        now,
      });
      await insertAutomationEvent(transaction, {
        eventType: "report.draft_created",
        aggregateType: "report",
        aggregateId: report.id,
        correlationId: submission.correlationId ?? jobId,
        actorType: "system",
        actorId: null,
        payload: {
          inspectionId: inspection.id,
          reportId: report.id,
          reportVersionId: versionId,
          versionId,
          versionNumber: nextVersion,
          submissionId: submission.id,
          previousVersionId,
          requestedRevisionVersionId: previousVersionId,
        },
        occurredAt: now,
      });
      await insertAutomationEvent(transaction, {
        eventType: "report.review_requested",
        aggregateType: "report",
        aggregateId: report.id,
        correlationId: submission.correlationId ?? jobId,
        actorType: "system",
        actorId: null,
        payload: {
          inspectionId: inspection.id,
          reportId: report.id,
          reportVersionId: versionId,
          versionId,
          submissionId: submission.id,
          previousVersionId,
          requestedRevisionVersionId: previousVersionId,
        },
        occurredAt: now,
      });
      await this.closeAndStartStage(
        transaction,
        inspection.id,
        "validation_passed_to_report_draft_created",
        "report_draft_created_to_technical_decision",
        "human_waiting",
        now,
      );
      await transaction.query(
        "UPDATE sla_clocks SET report_id=$2, updated_at=$3 WHERE inspection_id=$1",
        [inspection.id, report.id, now],
      );
    });
  }

  private async runRender(reportId: string, versionId: string, jobId: string): Promise<void> {
    const loaded = await this.dependencies.database.transaction(async (transaction) => {
      const report = mapReport(
        (
          await transaction.query<SqlRow>(
            "SELECT * FROM inspection_reports WHERE id=$1 FOR UPDATE",
            [reportId],
          )
        ).rows[0] as SqlRow,
      );
      const version = mapReportVersion(
        (await transaction.query<SqlRow>("SELECT * FROM report_versions WHERE id=$1", [versionId]))
          .rows[0] as SqlRow,
      );
      const inspection = mapInspection(
        (
          await transaction.query<SqlRow>("SELECT * FROM inspections WHERE id=$1", [
            report.inspectionId,
          ])
        ).rows[0] as SqlRow,
      );
      const project = mapProject(
        (await transaction.query<SqlRow>("SELECT * FROM projects WHERE id=$1", [report.projectId]))
          .rows[0] as SqlRow,
      );
      const template = mapTemplateVersion(
        (
          await transaction.query<SqlRow>("SELECT * FROM report_template_versions WHERE id=$1", [
            version.templateVersionId,
          ])
        ).rows[0] as SqlRow,
      );
      const now = this.stamp();
      if (report.status === "approved") {
        await this.transitionReport(transaction, report, "rendering_final", now);
      }
      return { report, version, inspection, project, template, now };
    });
    const rendered = await this.renderer.render({
      reportReference: loaded.report.reference,
      inspectionReference: loaded.inspection.reference,
      projectReference: loaded.project.reference,
      templateKey: SYNTHETIC_REPORT_TEMPLATE_KEY,
      templateVersion: loaded.template.versionNumber,
      disclosure: loaded.template.disclosure,
      snapshot: loaded.version.inputSnapshot,
      generatedAt: loaded.now,
    });
    await this.dependencies.database.transaction(async (transaction) => {
      let report = mapReport(
        (
          await transaction.query<SqlRow>(
            "SELECT * FROM inspection_reports WHERE id=$1 FOR UPDATE",
            [reportId],
          )
        ).rows[0] as SqlRow,
      );
      const now = this.stamp();
      await transaction.query(
        `UPDATE report_versions
         SET status='final', rendered_checksum=$2, rendered_storage_ref=$3, rendered_mime_type=$4, rendered_content=$5
         WHERE id=$1`,
        [
          versionId,
          rendered.checksumSha256,
          `synthetic://report/${loaded.report.reference}`,
          rendered.mimeType,
          Buffer.from(rendered.bytes).toString("base64"),
        ],
      );
      if (report.status === "approved") {
        report = await this.transitionReport(transaction, report, "rendering_final", now);
      }
      if (report.status === "rendering_final") {
        report = await this.transitionReport(transaction, report, "ready_for_delivery", now);
      }
      await insertAutomationEvent(transaction, {
        eventType: "report.ready_for_delivery",
        aggregateType: "report",
        aggregateId: report.id,
        correlationId: jobId,
        actorType: "system",
        actorId: null,
        payload: {
          inspectionId: report.inspectionId,
          reportId: report.id,
          reportVersionId: versionId,
          versionId,
          checksum: rendered.checksumSha256,
        },
        occurredAt: now,
      });
      await this.closeAndStartStage(
        transaction,
        report.inspectionId,
        "technical_approval_to_final_artifact_rendered",
        "final_artifact_rendered_to_delivery_authorized",
        "human_waiting",
        now,
      );
    });
  }

  private async runDelivery(
    reportId: string,
    versionId: string,
    jobId: string,
    claimOwner: string,
  ): Promise<void> {
    const reservationToken = randomUUID();
    const loaded = await this.dependencies.database.transaction(async (transaction) => {
      const jobRow = await transaction.query<SqlRow>("SELECT * FROM automation_jobs WHERE id=$1", [
        jobId,
      ]);
      const job = jobRow.rows[0] ? mapJob(jobRow.rows[0]) : null;
      if (!job || job.status !== "claimed" || job.claimedBy !== claimOwner) {
        return { skip: true as const };
      }
      const report = mapReport(
        (
          await transaction.query<SqlRow>(
            "SELECT * FROM inspection_reports WHERE id=$1 FOR UPDATE",
            [reportId],
          )
        ).rows[0] as SqlRow,
      );
      const version = mapReportVersion(
        (await transaction.query<SqlRow>("SELECT * FROM report_versions WHERE id=$1", [versionId]))
          .rows[0] as SqlRow,
      );
      const prior = await transaction.query<SqlRow>(
        "SELECT * FROM report_deliveries WHERE idempotency_key=$1",
        [buildIdempotencyKey(["report.deliver", report.id, version.id, "v1"])],
      );
      if (prior.rows[0] && String(prior.rows[0].status) === "delivered") {
        return { skip: true as const };
      }
      const authorizationId = String(job.payload.authorizationId ?? "");
      const authorizationRow = authorizationId
        ? await transaction.query<SqlRow>(
            "SELECT * FROM delivery_authorizations WHERE id=$1 FOR UPDATE",
            [authorizationId],
          )
        : { rows: [] as SqlRow[] };
      const authorization = authorizationRow.rows[0]
        ? mapDeliveryAuthorization(authorizationRow.rows[0])
        : null;
      this.assertDeliveryAuthorization(report, version, authorization, {
        recipients: recipientsFromPayload(job.payload) ?? [
          ...(authorization?.recipients ?? DEFAULT_LOCAL_TEST_RECIPIENTS),
        ],
        destinationKind:
          destinationKindFromPayload(job.payload) ?? authorization?.destinationKind ?? "local_test",
      });
      const now = this.stamp();
      const stale = new Date(Date.parse(now) - JOB_LEASE_MS).toISOString();
      const reserved = await transaction.query<SqlRow>(
        `UPDATE delivery_authorizations
            SET reserved_token=$2,
                reserved_at=$3,
                consumed_by_job_id=$4,
                updated_at=$3,
                version=version+1
          WHERE id=$1
            AND status='active'
            AND (
              reserved_token IS NULL
              OR reserved_token=$2
              OR (reserved_at IS NOT NULL AND reserved_at<=$5)
            )
          RETURNING *`,
        [authorization!.id, reservationToken, now, jobId, stale],
      );
      if (!reserved.rows[0]) {
        throw new DeliveryAdapterError(
          "DELIVERY_AUTHORIZATION_RESERVED",
          "Another worker already reserved this delivery authorization.",
          false,
        );
      }
      const idempotencyKey = buildIdempotencyKey(["report.deliver", report.id, version.id, "v1"]);
      const deliveryId = prior.rows[0] ? String(prior.rows[0].id) : randomUUID();
      const recipients = [...(authorization?.recipients ?? DEFAULT_LOCAL_TEST_RECIPIENTS)];
      if (!prior.rows[0]) {
        await transaction.query(
          `INSERT INTO report_deliveries
           (id,report_id,report_version_id,idempotency_key,adapter_key,status,recipients,subject,artifact_checksum,attempted_at,created_at,updated_at,version)
           VALUES ($1,$2,$3,$4,$5,'attempting',$6::jsonb,$7,$8,$9,$9,$9,1)`,
          [
            deliveryId,
            report.id,
            version.id,
            idempotencyKey,
            this.dependencies.deliveryAdapter.key,
            JSON.stringify(recipients),
            `BEA inspection report ${report.reference}`,
            version.renderedChecksum,
            now,
          ],
        );
      } else {
        await transaction.query(
          `UPDATE report_deliveries SET status='attempting', attempted_at=$2, updated_at=$2, version=version+1 WHERE id=$1 AND status <> 'delivered'`,
          [deliveryId, now],
        );
      }
      return {
        skip: false as const,
        report,
        version,
        deliveryId,
        idempotencyKey,
        artifact: version,
        authorizationId: authorization!.id,
        reservationToken,
        recipients,
      };
    });
    if (loaded.skip) return;
    const content = loaded.artifact.renderedStorageRef
      ? await this.readRenderedBytes(versionId)
      : new Uint8Array();
    try {
      const delivered = assertDeliveryConfirmed(
        await this.dependencies.deliveryAdapter.deliver({
          idempotencyKey: loaded.idempotencyKey,
          reportId,
          reportVersionId: versionId,
          reportReference: loaded.report.reference,
          artifactChecksum:
            loaded.artifact.renderedChecksum ?? createHash("sha256").update(content).digest("hex"),
          artifact: content,
          mimeType: loaded.artifact.renderedMimeType ?? "application/pdf",
          filename: `${loaded.report.reference.toLocaleLowerCase("en-US")}.pdf`,
          recipients: loaded.recipients,
          subject: `BEA inspection report ${loaded.report.reference}`,
          correlationId: jobId,
        }),
      );
      await this.dependencies.database.transaction(async (transaction) => {
        const now = this.stamp();
        const consumed = await transaction.query<SqlRow>(
          `UPDATE delivery_authorizations
              SET status='consumed', consumed_at=$2, consumed_by_job_id=$3, reserved_token=NULL, reserved_at=NULL, updated_at=$2, version=version+1
            WHERE id=$1 AND status='active' AND reserved_token=$4
            RETURNING *`,
          [loaded.authorizationId, now, jobId, loaded.reservationToken],
        );
        if (!consumed.rows[0]) {
          throw new DeliveryAdapterError(
            "DELIVERY_OUTCOME_UNCERTAIN",
            "Delivery authorization could not be consumed after the adapter accepted the send.",
            false,
          );
        }
        await transaction.query(
          `UPDATE report_deliveries
           SET status='delivered', external_message_id=$2, confirmed_at=$3, artifact_checksum=$4, error=NULL, updated_at=$3, version=version+1
           WHERE id=$1 AND status <> 'delivered'`,
          [loaded.deliveryId, delivered.externalMessageId, now, delivered.artifactChecksum],
        );
        const report = mapReport(
          (
            await transaction.query<SqlRow>(
              "SELECT * FROM inspection_reports WHERE id=$1 FOR UPDATE",
              [reportId],
            )
          ).rows[0] as SqlRow,
        );
        if (report.status === "delivering" || report.status === "delivery_failed") {
          if (report.status === "delivery_failed") {
            await this.transitionReport(transaction, report, "delivering", now);
          }
          const live = mapReport(
            (
              await transaction.query<SqlRow>("SELECT * FROM inspection_reports WHERE id=$1", [
                report.id,
              ])
            ).rows[0] as SqlRow,
          );
          await this.transitionReport(transaction, live, "delivered", now);
        }
        const inspection = mapInspection(
          (
            await transaction.query<SqlRow>("SELECT * FROM inspections WHERE id=$1 FOR UPDATE", [
              report.inspectionId,
            ])
          ).rows[0] as SqlRow,
        );
        if (inspection.status === "reporting") {
          await this.transitionInspection(transaction, inspection, "complete", now);
        }
        const project = mapProject(
          (
            await transaction.query<SqlRow>("SELECT * FROM projects WHERE id=$1 FOR UPDATE", [
              report.projectId,
            ])
          ).rows[0] as SqlRow,
        );
        if (project.status === "reporting") {
          await this.transitionProject(transaction, project, "delivered", now);
        }
        await transaction.query(
          `UPDATE sla_clocks SET status='stopped', stopped_at=$2, paused_at=NULL, pause_reason=NULL, updated_at=$2, version=version+1
           WHERE inspection_id=$1 AND status IN ('running','paused','breached')`,
          [report.inspectionId, now],
        );
        await this.resolveOpenDeliveryExceptions(transaction, report.id, now, jobId);
        await this.closeOpenStage(
          transaction,
          report.inspectionId,
          "delivery_authorized_to_confirmed_delivery",
          "system_processing",
          now,
        );
        await insertAutomationEvent(transaction, {
          eventType: "report.delivered",
          aggregateType: "report",
          aggregateId: report.id,
          correlationId: jobId,
          actorType: "system",
          actorId: null,
          payload: {
            inspectionId: report.inspectionId,
            reportId: report.id,
            reportVersionId: loaded.version.id,
            versionId: loaded.version.id,
            deliveryId: loaded.deliveryId,
            deliveryAuthorizationId: loaded.authorizationId,
            externalMessageId: delivered.externalMessageId,
            checksum: delivered.artifactChecksum,
            synthetic: delivered.synthetic,
          },
          occurredAt: now,
        });
      });
    } catch (error) {
      await this.dependencies.database.transaction(async (transaction) => {
        const owner = await transaction.query<SqlRow>(
          "SELECT claimed_by, status FROM automation_jobs WHERE id=$1 FOR UPDATE",
          [jobId],
        );
        if (
          !owner.rows[0] ||
          String(owner.rows[0].claimed_by) !== claimOwner ||
          String(owner.rows[0].status) !== "claimed"
        ) {
          return;
        }
        const now = this.stamp();
        await transaction.query(
          `UPDATE delivery_authorizations
              SET reserved_token=NULL, reserved_at=NULL, consumed_by_job_id=NULL, updated_at=$2, version=version+1
            WHERE id=$1 AND status='active' AND reserved_token=$3`,
          [loaded.authorizationId, now, loaded.reservationToken],
        );
        await transaction.query(
          `UPDATE report_deliveries SET status='failed', error=$2::jsonb, updated_at=$3, version=version+1 WHERE id=$1 AND status <> 'delivered'`,
          [
            loaded.deliveryId,
            JSON.stringify({
              code:
                error instanceof Error && "code" in error ? String(error.code) : "DELIVERY_FAILED",
              message: error instanceof Error ? error.message : "Delivery failed.",
            }),
            now,
          ],
        );
        const report = mapReport(
          (
            await transaction.query<SqlRow>(
              "SELECT * FROM inspection_reports WHERE id=$1 FOR UPDATE",
              [reportId],
            )
          ).rows[0] as SqlRow,
        );
        if (report.status === "delivering") {
          await this.transitionReport(transaction, report, "delivery_failed", now);
        }
        const exceptionRef = await nextOperationsReference(
          transaction,
          "bea_exception_reference_seq",
          "BEA-EX-",
        );
        await transaction.query(
          `INSERT INTO exception_cases
           (id,reference,kind,status,severity,title,detail,inspection_id,report_id,project_id,delivery_id,job_id,owner_user_id,sla_attribution,created_at,updated_at,version)
           VALUES ($1,$2,'delivery','open','error',$3,$4,$5,$6,$7,$8,$9,$10,'connector_waiting',$11,$11,1)`,
          [
            randomUUID(),
            exceptionRef,
            "Report delivery failed",
            error instanceof Error ? error.message : "Delivery failed.",
            report.inspectionId,
            report.id,
            report.projectId,
            loaded.deliveryId,
            jobId,
            null,
            now,
          ],
        );
        await insertAutomationEvent(transaction, {
          eventType: "report.delivery_failed",
          aggregateType: "report",
          aggregateId: report.id,
          correlationId: jobId,
          actorType: "system",
          actorId: null,
          payload: {
            inspectionId: report.inspectionId,
            reportId: report.id,
            reportVersionId: loaded.version.id,
            versionId: loaded.version.id,
            deliveryId: loaded.deliveryId,
            deliveryAuthorizationId: loaded.authorizationId,
          },
          occurredAt: now,
        });
      });
      throw error;
    }
  }

  private async readRenderedBytes(versionId: string): Promise<Uint8Array> {
    const result = await this.dependencies.database.query<{ rendered_content: string | null }>(
      "SELECT rendered_content FROM report_versions WHERE id=$1",
      [versionId],
    );
    const encoded = result.rows[0]?.rendered_content;
    return encoded ? Uint8Array.from(Buffer.from(encoded, "base64")) : new Uint8Array();
  }

  private async moveInspectionTowardSubmission(
    transaction: SqlExecutor,
    inspection: Inspection,
    _completedAt: string,
    now: string,
  ): Promise<void> {
    let current = inspection;
    if (current.status === "ready") {
      await this.transitionInspection(transaction, current, "in_progress", now);
      current = mapInspection(
        (await transaction.query<SqlRow>("SELECT * FROM inspections WHERE id=$1", [current.id]))
          .rows[0] as SqlRow,
      );
    }
    if (current.status === "in_progress") {
      await this.transitionInspection(transaction, current, "completed", now);
      current = mapInspection(
        (await transaction.query<SqlRow>("SELECT * FROM inspections WHERE id=$1", [current.id]))
          .rows[0] as SqlRow,
      );
      await insertAutomationEvent(transaction, {
        eventType: "inspection.completed",
        aggregateType: "inspection",
        aggregateId: current.id,
        correlationId: current.id,
        actorType: "system",
        actorId: null,
        payload: {
          inspectionId: current.id,
          completedAt: current.completedAt,
        },
        occurredAt: now,
      });
    }
    if (current.status === "completed" || current.status === "needs_correction") {
      await transaction.query("UPDATE inspections SET submitted_at=$2, updated_at=$3 WHERE id=$1", [
        current.id,
        now,
        now,
      ]);
      await this.transitionInspection(transaction, current, "submitted", now);
    } else if (current.status !== "submitted" && current.status !== "validating") {
      throw new OperationsStatusTransitionError("inspection", current.status, "submitted");
    }
  }

  private async persistFindingsAndEvidence(
    transaction: SqlExecutor,
    submission: InspectionSubmission,
    payload: NormalizedInspectionPayload,
    now: string,
  ): Promise<void> {
    const findingIds = new Map<string, string>();
    for (const [index, finding] of payload.findings.entries()) {
      const id = randomUUID();
      findingIds.set(finding.code, id);
      await transaction.query(
        `INSERT INTO inspection_findings
         (id,submission_id,inspection_id,code,section_key,title,description,severity,location,sort_order,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          id,
          submission.id,
          submission.inspectionId,
          finding.code,
          finding.sectionKey,
          finding.title,
          finding.description,
          finding.severity,
          finding.location,
          index,
          now,
        ],
      );
    }
    for (const evidence of payload.evidence) {
      await transaction.query(
        `INSERT INTO inspection_evidence
         (id,submission_id,inspection_id,finding_id,kind,filename,content_type,sha256,byte_length,storage_ref,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          randomUUID(),
          submission.id,
          submission.inspectionId,
          evidence.findingCode ? (findingIds.get(evidence.findingCode) ?? null) : null,
          evidence.kind,
          evidence.filename,
          evidence.contentType,
          evidence.sha256,
          evidence.byteLength,
          evidence.storageRef,
          now,
        ],
      );
    }
  }

  private async ensureSlaClock(
    transaction: SqlExecutor,
    inspectionId: string,
    startedAt: string,
    now: string,
    pack: BoundConfigurationPackage | null = null,
  ): Promise<void> {
    const inserted = await transaction.query<{ id: string }>(
      `INSERT INTO sla_clocks
       (id,inspection_id,clock_kind,target_minutes,started_at,status,paused_total_ms,created_at,updated_at,version,sla_policy_key,sla_policy_version)
       VALUES ($1,$2,$3,$4,$5,'running',0,$6,$6,1,$7,$8)
       ON CONFLICT (inspection_id) DO NOTHING
       RETURNING id`,
      [
        randomUUID(),
        inspectionId,
        pack?.sla.calendarMode === "business_hours" ? "business_hours" : DEFAULT_SLA_CLOCK_KIND,
        pack?.sla.targetMinutes ?? DEFAULT_REPORT_SLA_TARGET_MINUTES,
        startedAt,
        now,
        pack?.sla.policyKey ?? null,
        pack?.sla.policyVersion ?? null,
      ],
    );
    if (inserted.rows[0]) {
      await this.startStage(
        transaction,
        inspectionId,
        "inspection_completed_to_submission_received",
        "system_processing",
        startedAt,
      );
    }
  }

  private async pauseSla(
    transaction: SqlExecutor,
    inspectionId: string,
    reason: "awaiting_human" | "internal_exception" | "customer_caused",
    now: string,
  ): Promise<void> {
    await transaction.query(
      `UPDATE sla_clocks SET status='paused', paused_at=$2, pause_reason=$3, updated_at=$2, version=version+1
       WHERE inspection_id=$1 AND status='running'`,
      [inspectionId, now, reason],
    );
  }

  private async resumeSla(
    transaction: SqlExecutor,
    inspectionId: string,
    now: string,
  ): Promise<void> {
    const clock = await transaction.query<SqlRow>(
      "SELECT * FROM sla_clocks WHERE inspection_id=$1 FOR UPDATE",
      [inspectionId],
    );
    const row = clock.rows[0];
    if (!row || String(row.status) !== "paused") return;
    const pausedAt = row.paused_at ? Date.parse(isoLike(row.paused_at)) : Date.parse(now);
    const additional = Math.max(0, Date.parse(now) - pausedAt);
    await transaction.query(
      `UPDATE sla_clocks
          SET status='running',
              paused_at=NULL,
              pause_reason=NULL,
              paused_total_ms=paused_total_ms+$3,
              updated_at=$2,
              version=version+1
        WHERE inspection_id=$1 AND status='paused'`,
      [inspectionId, now, additional],
    );
  }

  private async resolveOpenValidationExceptions(
    transaction: SqlExecutor,
    inspectionId: string,
    now: string,
    correlationId: string,
  ): Promise<void> {
    const open = await transaction.query<SqlRow>(
      `SELECT id FROM exception_cases
        WHERE inspection_id=$1 AND kind IN ('validation','state') AND status IN ('open','assigned','in_progress')`,
      [inspectionId],
    );
    await this.resolveExceptionRows(
      transaction,
      open.rows.map((row) => String(row.id)),
      now,
      "Inspection data corrected and revalidated.",
      null,
      "system",
      correlationId,
      correlationId,
    );
  }

  private async resolveOpenDeliveryExceptions(
    transaction: SqlExecutor,
    reportId: string,
    now: string,
    correlationId: string,
  ): Promise<void> {
    const open = await transaction.query<SqlRow>(
      `SELECT id FROM exception_cases
        WHERE report_id=$1 AND kind='delivery' AND status IN ('open','assigned','in_progress')`,
      [reportId],
    );
    await this.resolveExceptionRows(
      transaction,
      open.rows.map((row) => String(row.id)),
      now,
      "Delivery confirmed.",
      null,
      "system",
      correlationId,
      correlationId,
    );
  }

  private async createTask(
    transaction: SqlExecutor,
    input: {
      readonly title: string;
      readonly description: string;
      readonly assigneeUserId: string;
      readonly inspectionId: string;
      readonly reportId?: string | null;
      readonly exceptionId?: string | null;
      readonly actorUserId: string | null;
      readonly now: string;
    },
  ): Promise<void> {
    await transaction.query(
      `INSERT INTO tasks
       (id,title,description,status,priority,assignee_user_id,inspection_id,report_id,exception_id,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,$2,$3,'open','high',$4,$5,$6,$7,$8,$9,$9,1)`,
      [
        randomUUID(),
        input.title,
        input.description,
        input.assigneeUserId,
        input.inspectionId,
        input.reportId ?? null,
        input.exceptionId ?? null,
        input.actorUserId ?? input.assigneeUserId,
        input.now,
      ],
    );
  }

  private async inspectionOwner(
    transaction: SqlExecutor,
    inspectionId: string,
  ): Promise<string | null> {
    const result = await transaction.query<{ inspector_user_id: string | null }>(
      "SELECT inspector_user_id FROM inspections WHERE id=$1",
      [inspectionId],
    );
    return result.rows[0]?.inspector_user_id ?? null;
  }

  private async transitionInspection(
    transaction: SqlExecutor,
    inspection: Inspection,
    to: InspectionStatus,
    now: string,
  ): Promise<Inspection> {
    assertInspectionStatusTransition(inspection.status, to);
    const result = await transaction.query<SqlRow>(
      `UPDATE inspections SET status=$2, updated_at=$3, version=version+1 WHERE id=$1 RETURNING *`,
      [inspection.id, to, now],
    );
    return mapInspection(result.rows[0] as SqlRow);
  }

  private async transitionReport(
    transaction: SqlExecutor,
    report: InspectionReport,
    to: ReportStatus,
    now: string,
  ): Promise<InspectionReport> {
    assertReportStatusTransition(report.status, to);
    const result = await transaction.query<SqlRow>(
      `UPDATE inspection_reports SET status=$2, updated_at=$3, version=version+1 WHERE id=$1 RETURNING *`,
      [report.id, to, now],
    );
    return mapReport(result.rows[0] as SqlRow);
  }

  private async transitionProject(
    transaction: SqlExecutor,
    project: Project,
    to: Project["status"],
    now: string,
  ): Promise<Project> {
    assertProjectStatusTransition(project.status, to);
    const result = await transaction.query<SqlRow>(
      `UPDATE projects SET status=$2, updated_at=$3, version=version+1 WHERE id=$1 RETURNING *`,
      [project.id, to, now],
    );
    return mapProject(result.rows[0] as SqlRow);
  }

  private async requireInspection(id: string): Promise<Inspection> {
    const inspection = await this.repository.getInspection(id);
    if (!inspection) throw new OperationsNotFoundError("Inspection was not found.");
    return inspection;
  }

  private async listOpenExceptionIds(
    executor: SqlExecutor,
    inspectionId: string,
  ): Promise<string[]> {
    const rows = await executor.query<SqlRow>(
      `SELECT id FROM exception_cases
        WHERE inspection_id=$1 AND status IN ('open','assigned','in_progress')`,
      [inspectionId],
    );
    return rows.rows.map((item) => String(item.id));
  }

  private async duplicateSubmissionResult(
    input: SubmitInspectionInput,
    existing: InspectionSubmission,
  ) {
    const inspection = await this.requireInspection(input.inspectionId);
    await this.dependencies.database.transaction(async (transaction) => {
      await insertAutomationEvent(transaction, {
        eventType: "inspection.submitted",
        aggregateType: "inspection",
        aggregateId: inspection.id,
        correlationId: input.correlationId,
        actorType: "system",
        actorId: input.actorUserId,
        payload: {
          duplicate: true,
          inspectionId: inspection.id,
          submissionId: existing.id,
          exceptionIds: await this.listOpenExceptionIds(transaction, inspection.id),
        },
        occurredAt: this.stamp(),
      });
    });
    return { submission: existing, duplicate: true as const, inspection };
  }

  private async applyInspectionCompletion(
    transaction: SqlExecutor,
    inspection: Inspection,
    submittedCompletedAt: string | null,
    now: string,
  ): Promise<void> {
    if (inspection.completedAt && submittedCompletedAt) {
      const official = Date.parse(inspection.completedAt);
      const submitted = Date.parse(submittedCompletedAt);
      if (Number.isFinite(official) && Number.isFinite(submitted) && official !== submitted) {
        throw new OperationsValidationError(
          "Submitted inspection completion time conflicts with the official inspection record.",
        );
      }
      return;
    }
    if (!inspection.completedAt && submittedCompletedAt) {
      await transaction.query(
        `UPDATE inspections SET completed_at=$2, updated_at=$3, version=version+1 WHERE id=$1 AND completed_at IS NULL`,
        [inspection.id, submittedCompletedAt, now],
      );
      await insertAutomationEvent(transaction, {
        eventType: "inspection.completed",
        aggregateType: "inspection",
        aggregateId: inspection.id,
        correlationId: inspection.id,
        actorType: "system",
        actorId: null,
        payload: {
          inspectionId: inspection.id,
          completedAt: submittedCompletedAt,
          source: "validated_submission",
        },
        occurredAt: now,
      });
      await recordAuditAndActivity(transaction, {
        eventType: "inspection.completed",
        action: "inspection.complete",
        actorUserId: null,
        resourceType: "inspection",
        resourceId: inspection.id,
        correlationId: inspection.id,
        metadata: { completedAt: submittedCompletedAt, source: "validated_submission" },
        summary: `Inspection completion recorded from validated submission: ${inspection.reference}`,
        inspectionId: inspection.id,
        now,
      });
    }
  }

  private async returnInspectionForCorrection(
    transaction: SqlExecutor,
    inspectionId: string,
    now: string,
    fromStatus: InspectionStatus,
  ): Promise<void> {
    const inspectionRow = await transaction.query<SqlRow>(
      "SELECT * FROM inspections WHERE id=$1 FOR UPDATE",
      [inspectionId],
    );
    const inspection = mapInspection(inspectionRow.rows[0] as SqlRow);
    if (inspection.status === fromStatus || inspection.status === "reporting") {
      await this.transitionInspection(transaction, inspection, "needs_correction", now);
    }
  }

  private async recordReviewComments(
    transaction: SqlExecutor,
    versionId: string,
    input: ReviewReportInput,
    now: string,
  ): Promise<void> {
    const comment = input.comment?.trim();
    const sections = input.affectedSections ?? [];
    if (!comment && sections.length === 0) return;
    const bodies =
      sections.length > 0
        ? sections.map((section) => ({
            section,
            body: comment ?? `Revision requested for ${section}.`,
          }))
        : [{ section: null as string | null, body: comment ?? "Revision requested." }];
    for (const item of bodies) {
      await transaction.query(
        `INSERT INTO report_review_comments (id,report_version_id,author_user_id,section_key,body,created_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [randomUUID(), versionId, input.actorUserId, item.section, item.body, now],
      );
    }
  }

  private async ensureOpenException(
    transaction: SqlExecutor,
    input: {
      readonly inspectionId: string;
      readonly reportId: string | null;
      readonly kind: "validation" | "state" | "delivery";
      readonly title: string;
      readonly detail: string;
      readonly ownerUserId: string;
      readonly slaAttribution: SlaAttribution;
      readonly jobId?: string;
      readonly now: string;
      readonly correlationId: string;
    },
  ): Promise<{ id: string; created: boolean }> {
    const existing = await transaction.query<SqlRow>(
      `SELECT * FROM exception_cases
        WHERE inspection_id=$1 AND kind=$2 AND status IN ('open','assigned','in_progress')
        ORDER BY created_at DESC LIMIT 1`,
      [input.inspectionId, input.kind],
    );
    if (existing.rows[0]) {
      await transaction.query(
        `UPDATE exception_cases
            SET detail=$2, title=$3, owner_user_id=$4, updated_at=$5, version=version+1
          WHERE id=$1`,
        [String(existing.rows[0].id), input.detail, input.title, input.ownerUserId, input.now],
      );
      return { id: String(existing.rows[0].id), created: false };
    }
    const inspection = mapInspection(
      (
        await transaction.query<SqlRow>("SELECT * FROM inspections WHERE id=$1", [
          input.inspectionId,
        ])
      ).rows[0] as SqlRow,
    );
    const exceptionRef = await nextOperationsReference(
      transaction,
      "bea_exception_reference_seq",
      "BEA-EX-",
    );
    const id = randomUUID();
    await transaction.query(
      `INSERT INTO exception_cases
       (id,reference,kind,status,severity,title,detail,inspection_id,report_id,project_id,owner_user_id,sla_attribution,job_id,created_at,updated_at,version)
       VALUES ($1,$2,$3,'open','error',$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,1)`,
      [
        id,
        exceptionRef,
        input.kind,
        input.title,
        input.detail,
        input.inspectionId,
        input.reportId,
        inspection.projectId,
        input.ownerUserId,
        input.slaAttribution,
        input.jobId ?? null,
        input.now,
      ],
    );
    await insertAutomationEvent(transaction, {
      eventType: "exception.created",
      aggregateType: "exception",
      aggregateId: id,
      correlationId: input.correlationId,
      actorType: "system",
      actorId: null,
      payload: {
        inspectionId: input.inspectionId,
        reportId: input.reportId,
        exceptionId: id,
        kind: input.kind,
      },
      occurredAt: input.now,
    });
    return { id, created: true };
  }

  private async resolveExceptionRows(
    transaction: SqlExecutor,
    ids: readonly string[],
    now: string,
    resolution: string,
    actorUserId: string | null,
    actorType: "user" | "system",
    correlationId: string,
    causationId: string,
  ): Promise<void> {
    for (const id of ids) {
      const updated = await transaction.query<SqlRow>(
        `UPDATE exception_cases
            SET status='resolved',
                resolved_at=$2,
                resolution=$3,
                resolved_by_user_id=$4,
                resolved_by_actor_type=$5,
                updated_at=$2,
                version=version+1
          WHERE id=$1 AND status IN ('open','assigned','in_progress')
          RETURNING *`,
        [id, now, resolution, actorUserId, actorType],
      );
      if (!updated.rows[0]) continue;
      await insertAutomationEvent(transaction, {
        eventType: "exception.resolved",
        aggregateType: "exception",
        aggregateId: id,
        correlationId,
        causationId,
        actorType,
        actorId: actorUserId,
        payload: {
          exceptionId: id,
          inspectionId: nullableId(updated.rows[0].inspection_id),
          reportId: nullableId(updated.rows[0].report_id),
          resolution,
        },
        occurredAt: now,
      });
      await recordAuditAndActivity(transaction, {
        eventType: "exception.resolved",
        action: "exception.resolve",
        actorUserId,
        resourceType: "exception",
        resourceId: id,
        correlationId,
        metadata: { resolution },
        summary: `Exception resolved: ${String(updated.rows[0].reference)}`,
        inspectionId: nullableId(updated.rows[0].inspection_id),
        reportId: nullableId(updated.rows[0].report_id),
        now,
      });
    }
  }

  private async closeOpenStage(
    transaction: SqlExecutor,
    inspectionId: string,
    stageKey: SlaStageKey,
    attribution: SlaAttribution,
    now: string,
  ): Promise<void> {
    const clock = await transaction.query<{ id: string }>(
      "SELECT id FROM sla_clocks WHERE inspection_id=$1",
      [inspectionId],
    );
    const clockId = clock.rows[0]?.id;
    if (!clockId) return;
    const open = await transaction.query<SqlRow>(
      `SELECT * FROM sla_stage_intervals
        WHERE clock_id=$1 AND stage_key=$2 AND ended_at IS NULL
        ORDER BY started_at DESC LIMIT 1`,
      [clockId, stageKey],
    );
    const row = open.rows[0];
    if (!row) return;
    const duration = elapsedMs(isoLike(row.started_at), now);
    await transaction.query(
      `UPDATE sla_stage_intervals SET ended_at=$2, duration_ms=$3 WHERE id=$1`,
      [String(row.id), now, duration],
    );
    void attribution;
  }

  private async startStage(
    transaction: SqlExecutor,
    inspectionId: string,
    stageKey: SlaStageKey,
    attribution: SlaAttribution,
    now: string,
  ): Promise<void> {
    const clock = await transaction.query<{ id: string }>(
      "SELECT id FROM sla_clocks WHERE inspection_id=$1",
      [inspectionId],
    );
    const clockId = clock.rows[0]?.id;
    if (!clockId) return;
    const open = await transaction.query<SqlRow>(
      `SELECT id FROM sla_stage_intervals
        WHERE clock_id=$1 AND stage_key=$2 AND ended_at IS NULL LIMIT 1`,
      [clockId, stageKey],
    );
    if (open.rows[0]) return;
    await transaction.query(
      `INSERT INTO sla_stage_intervals (id,clock_id,stage_key,started_at,attribution)
       VALUES ($1,$2,$3,$4,$5)`,
      [randomUUID(), clockId, stageKey, now, attribution],
    );
  }

  private async closeAndStartStage(
    transaction: SqlExecutor,
    inspectionId: string,
    closeKey: SlaStageKey,
    startKey: SlaStageKey,
    attribution: SlaAttribution,
    now: string,
  ): Promise<void> {
    await this.closeOpenStage(transaction, inspectionId, closeKey, attribution, now);
    await this.startStage(transaction, inspectionId, startKey, attribution, now);
  }

  private assertDeliveryAuthorization(
    report: InspectionReport,
    version: ReportVersion,
    authorization: ReturnType<typeof mapDeliveryAuthorization> | null,
    expected: {
      readonly recipients: readonly string[];
      readonly destinationKind: DeliveryDestinationKind;
    },
  ): void {
    if (report.status === "revision_required") {
      throw new DeliveryAdapterError(
        "DELIVERY_AUTHORIZATION_INVALID",
        "A report in revision_required cannot be delivered.",
        false,
      );
    }
    if (!authorization) {
      throw new DeliveryAdapterError(
        "DELIVERY_AUTHORIZATION_MISSING",
        "Delivery requires a durable authorization for this report version.",
        false,
      );
    }
    if (authorization.status !== "active") {
      throw new DeliveryAdapterError(
        "DELIVERY_AUTHORIZATION_INVALID",
        `Delivery authorization is ${authorization.status}.`,
        false,
      );
    }
    if (authorization.reportId !== report.id) {
      throw new DeliveryAdapterError(
        "DELIVERY_AUTHORIZATION_MISMATCH",
        "Delivery authorization is bound to a different report.",
        false,
      );
    }
    if (authorization.reportVersionId !== version.id) {
      throw new DeliveryAdapterError(
        "DELIVERY_AUTHORIZATION_MISMATCH",
        "Delivery authorization is bound to a different report version.",
        false,
      );
    }
    if (authorization.artifactChecksum !== version.renderedChecksum) {
      throw new DeliveryAdapterError(
        "DELIVERY_AUTHORIZATION_MISMATCH",
        "Delivery authorization checksum does not match the rendered artifact.",
        false,
      );
    }
    if (authorization.destinationKind !== expected.destinationKind) {
      throw new DeliveryAdapterError(
        "DELIVERY_AUTHORIZATION_MISMATCH",
        "Delivery authorization destination does not match the authorized destination.",
        false,
      );
    }
    if (!sameCanonicalRecipients(authorization.recipients, expected.recipients)) {
      throw new DeliveryAdapterError(
        "DELIVERY_AUTHORIZATION_MISMATCH",
        "Delivery authorization recipients do not match the authorized destination.",
        false,
      );
    }
  }

  private stamp(): string {
    return this.now().toISOString();
  }
}

function isoLike(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function nullableId(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function recipientsFromPayload(payload: { readonly recipients?: unknown }): string[] | null {
  return Array.isArray(payload.recipients)
    ? payload.recipients.filter((item): item is string => typeof item === "string")
    : null;
}

function destinationKindFromPayload(payload: {
  readonly destinationKind?: unknown;
}): DeliveryDestinationKind | null {
  return isDeliveryDestinationKind(payload.destinationKind) ? payload.destinationKind : null;
}

function canonicalRecordFromPayload(
  payload: NormalizedInspectionPayload,
): CanonicalInspectionRecord {
  const extra = payload as NormalizedInspectionPayload & {
    readonly canonicalRecord?: CanonicalInspectionRecord;
  };
  if (extra.canonicalRecord && typeof extra.canonicalRecord === "object") {
    return extra.canonicalRecord;
  }
  return {
    fields: {
      client_name: payload.clientName,
      site_name: payload.siteName,
      inspector_name: payload.inspectorName,
      completed_at: payload.completedAt,
      service_key: payload.serviceKey,
      attestation: payload.attestation,
      summary: payload.summary,
    },
    findings: payload.findings,
    evidence: payload.evidence.map((item) => ({ ...item, caption: null })),
    groups: {},
    lineage: [],
  };
}

function configuredValidationResult(
  payload: NormalizedInspectionPayload,
  pack: BoundConfigurationPackage,
): {
  readonly passed: boolean;
  readonly blocking: readonly InspectionValidationItem[];
  readonly optional: readonly InspectionValidationItem[];
} {
  const result = evaluateValidationRules(canonicalRecordFromPayload(payload), pack.validation);
  return {
    passed: result.blocking.length === 0,
    blocking: result.blocking.map((item) => ({
      code: item.ruleKey,
      severity: "blocking" as const,
      message: item.message,
      path: item.path,
    })),
    optional: [...result.warnings, ...result.advisories].map((item) => ({
      code: item.ruleKey,
      severity: "optional" as const,
      message: item.message,
      path: item.path,
    })),
  };
}

function configuredReportSnapshot(input: {
  readonly pack: BoundConfigurationPackage;
  readonly inspection: Inspection;
  readonly project: Project;
  readonly report: InspectionReport;
  readonly submission: InspectionSubmission;
  readonly templateVersion: number;
  readonly payload: NormalizedInspectionPayload;
  readonly frozenGeneratedAt: string;
}): JsonObject {
  const document = buildReportDocument({
    template: input.pack.template,
    record: canonicalRecordFromPayload(input.payload),
    schema: input.pack.schema,
    mapping: input.pack.mapping,
    ruleSet: input.pack.validation,
    configurationReleaseId: input.pack.release.id,
    configurationReleaseVersion: input.pack.release.versionNumber,
    inspectionReference: input.inspection.reference,
    reportReference: input.report.reference,
    projectReference: input.project.reference,
    preview: false,
  });
  return JSON.parse(
    JSON.stringify({
      inspectionId: input.inspection.id,
      inspectionReference: input.inspection.reference,
      reportReference: input.report.reference,
      projectReference: input.project.reference,
      submissionId: input.submission.id,
      payloadSha256: input.submission.payloadSha256,
      templateKey: input.pack.template.templateKey,
      templateVersion: input.pack.template.templateVersion,
      configurationReleaseId: input.pack.release.id,
      configurationReleaseVersion: input.pack.release.versionNumber,
      schemaVersion: `${input.pack.schema.schemaKey}@${input.pack.schema.schemaVersion}`,
      mappingVersion: `${input.pack.mapping.profileKey}@${input.pack.mapping.profileVersion}`,
      ruleSetVersion: `${input.pack.validation.ruleSetKey}@${input.pack.validation.ruleSetVersion}`,
      frozenGeneratedAt: input.frozenGeneratedAt,
      reportDocument: document,
      payload: input.submission.normalizedPayload,
      rawPreserved: true,
    }),
  ) as JsonObject;
}

export function createInspectionReportPipeline(
  database: DatabaseAdapter,
  appMode: "demo" | "production",
  options: {
    readonly processInline?: boolean;
    readonly deliveryAdapter?: DeliveryAdapter;
    readonly renderer?: ReportRenderer;
    readonly now?: () => Date;
  } = {},
): InspectionReportPipeline {
  const pipeline = new InspectionReportPipeline({
    database,
    deliveryAdapter:
      options.deliveryAdapter ??
      (appMode === "demo"
        ? new LocalTestDeliveryAdapter(options.now)
        : new FailClosedLiveDeliveryAdapter()),
    renderer: options.renderer ?? configurableSyntheticRenderer,
    ...(options.now ? { now: options.now } : {}),
    processInline: options.processInline ?? appMode === "demo",
  });
  pipeline.bindWorkControl(
    new WorkControlPlane({ database, ...(options.now ? { now: options.now } : {}) }),
  );
  return pipeline;
}
