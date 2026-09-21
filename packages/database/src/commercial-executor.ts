import { randomUUID } from "node:crypto";
import { renderProposalDocumentToPdf } from "@bea/automation";
import {
  COMMERCIAL_APPROVER_ELIGIBILITY_SQL,
  COMMERCIAL_OVERRIDE_APPROVER_ELIGIBILITY_SQL,
  COMMERCIAL_SYNTHETIC_DISCLOSURE,
  CatalogActivationError,
  CatalogImmutabilityError,
  CommercialConcurrencyError,
  CommercialNotFoundError,
  CommercialValidationError,
  MoneyArithmeticError,
  PROPOSAL_EMAIL_DRY_RUN_DISCLOSURE,
  ProductionCatalogNotConfiguredError,
  ProposalAuthorizationError,
  ProposalImmutabilityError,
  ProposalStatusTransitionError,
  SYNTHETIC_PROPOSAL_CC,
  SYNTHETIC_PROPOSAL_RECIPIENT,
  SYNTHETIC_PROPOSAL_SENDER,
  assertProposalStatusTransition,
  assertSafeProposedAmount,
  assertSafeScaledQuantity,
  buildProposalDocument,
  buildProposalFileName,
  calculatePricingSnapshot,
  catalogContextKeyForLead,
  catalogProjectionIssues,
  catalogVersionIsEditable,
  computeCatalogIdentityChecksum,
  evaluateProposalReadiness,
  formatProposalReference,
  isProposalStatus,
  nextProposalStatusForReadiness,
  overrideDifferenceMinor,
  parseCatalogPackage,
  proposalAllowsOverrideMutation,
  snapshotLeadForProposal,
  tryParseCatalogPackage,
  validateCatalogPackage,
  type CatalogValidationIssue,
  type CommercialEventType,
  type JsonObject,
  type LeadStatus,
  type OperationsEventType,
  type Proposal,
  type ProposalDocument,
  type ProposalLineDraft,
  type ProposalReviewDecision,
  type ProposalStatus,
  type ServiceCatalogPackage,
  type ServiceCatalogVersion,
} from "@bea/domain";
import type { DatabaseAdapter, SqlExecutor } from "./adapter.js";
import {
  SqlCommercialRepository,
  loadDraftLines,
  loadOverrides,
  mapCatalogVersion,
  mapOverride,
  mapProposal,
  mapProposalVersion,
  type ProposalRecord,
} from "./commercial-repository.js";
import { SqlLeadRepository } from "./lead-repository.js";
import {
  hashJson,
  insertAutomationEvent,
  recordAuditAndActivity,
} from "./operations-repository.js";
import { isUniqueConstraintViolation } from "./unique-constraint.js";
import type { WorkControlPlane } from "./work-control-executor.js";

type Row = Record<string, unknown>;

function catalogIdentity(current: ServiceCatalogVersion, pack: ServiceCatalogPackage): string {
  return computeCatalogIdentityChecksum({
    catalogId: current.catalogId,
    catalogVersionId: current.id,
    catalogVersionNumber: current.versionNumber,
    pack,
  });
}

function targetVersionNumber(proposal: Pick<Proposal, "currentVersionNumber">): number {
  return proposal.currentVersionNumber + 1;
}

function informationCycleForStatus(
  currentCycle: number,
  fromStatus: ProposalStatus | "new",
  toStatus: ProposalStatus,
): number {
  if (toStatus === "needs_information" && fromStatus !== "needs_information") {
    return currentCycle + 1;
  }
  return currentCycle;
}

function parseUnknownCatalog(input: unknown): ServiceCatalogPackage {
  return parseCatalogPackage(input);
}

export class CommercialWorkflowService {
  readonly repository: SqlCommercialRepository;
  workControl: WorkControlPlane | null = null;
  private readonly processInline: boolean;
  private readonly now: () => Date;
  private readonly leads: SqlLeadRepository;

  constructor(
    private readonly database: DatabaseAdapter,
    options: { readonly processInline?: boolean; readonly now?: () => Date } = {},
  ) {
    this.repository = new SqlCommercialRepository(database);
    this.leads = new SqlLeadRepository(database);
    this.processInline = options.processInline === true;
    this.now = options.now ?? (() => new Date());
  }

  bindWorkControl(workControl: WorkControlPlane): void {
    this.workControl = workControl;
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  private async afterDomainWork(): Promise<void> {
    if (!this.processInline || !this.workControl) return;
    await this.workControl.processPendingEvents();
  }

  async validateCatalog(input: {
    readonly catalogVersionId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
  }): Promise<ServiceCatalogVersion> {
    const result = await this.database.transaction(async (transaction) => {
      const current = await this.lockCatalogVersion(transaction, input.catalogVersionId);
      if (!catalogVersionIsEditable(current.status) && current.status !== "validated") {
        throw new CatalogImmutabilityError();
      }
      const now = this.stamp();
      const parsed = tryParseCatalogPackage(current.packagePayload);
      let issues: readonly CatalogValidationIssue[] = parsed.ok
        ? validateCatalogPackage(parsed.value)
        : parsed.issues;
      let identity: string | null = null;
      if (parsed.ok) {
        const projection = await this.projectionIssues(transaction, current, parsed.value);
        issues = [...issues, ...projection];
        if (!issues.some((item) => item.blocking)) {
          identity = catalogIdentity(current, parsed.value);
        }
      }
      const blocking = issues.filter((item) => item.blocking);
      const status = blocking.length > 0 ? "validation_failed" : "validated";
      const updated = await transaction.query<Row>(
        `UPDATE service_catalog_versions
            SET status=$2, validated_identity_checksum=$3, updated_at=$4, version=version+1,
                validated_at=$4, validated_by_user_id=$5
          WHERE id=$1 RETURNING *`,
        [current.id, status, identity, now, input.actorUserId],
      );
      await this.emitCommercialEvent(transaction, {
        eventType: blocking.length > 0 ? "catalog.validation_failed" : "catalog.validated",
        aggregateType: "catalog",
        aggregateId: current.id,
        actorUserId: input.actorUserId,
        correlationId: input.correlationId,
        payload: {
          catalogVersionId: current.id,
          issueCount: issues.length,
          blockingIssueCount: blocking.length,
        },
        summary: `Catalog ${status}: ${current.catalogKey} v${current.versionNumber}`,
        now,
      });
      return mapCatalogVersion(updated.rows[0] as Row);
    });
    await this.afterDomainWork();
    return result;
  }

  async publishCatalog(input: {
    readonly catalogVersionId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
  }): Promise<ServiceCatalogVersion> {
    const result = await this.database.transaction(async (transaction) => {
      const current = await this.lockCatalogVersion(transaction, input.catalogVersionId);
      if (current.status !== "validated") {
        throw new CommercialValidationError("A catalog version must be validated before publish.");
      }
      if (!current.validatedIdentityChecksum) {
        throw new CommercialValidationError(
          "Validated identity checksum is required before publication.",
        );
      }
      const pack = parseUnknownCatalog(current.packagePayload);
      const blocking = validateCatalogPackage(pack).filter((item) => item.blocking);
      if (blocking[0]) throw new CommercialValidationError(blocking[0].message);
      await this.assertProjectionAgrees(transaction, current, pack);
      const identity = catalogIdentity(current, pack);
      if (identity !== current.validatedIdentityChecksum) {
        throw new CatalogImmutabilityError(
          "Catalog identity changed after validation. Re-validate before publish.",
        );
      }
      const now = this.stamp();
      const updated = await transaction.query<Row>(
        `UPDATE service_catalog_versions
            SET status='published', checksum=$2, published_at=$3, published_by_user_id=$4, updated_at=$3, version=version+1
          WHERE id=$1 RETURNING *`,
        [current.id, identity, now, input.actorUserId],
      );
      await this.emitCommercialEvent(transaction, {
        eventType: "catalog.published",
        aggregateType: "catalog",
        aggregateId: current.id,
        actorUserId: input.actorUserId,
        correlationId: input.correlationId,
        payload: { catalogVersionId: current.id, checksum: identity },
        summary: `Catalog published: ${current.catalogKey} v${current.versionNumber}`,
        now,
      });
      return mapCatalogVersion(updated.rows[0] as Row);
    });
    await this.afterDomainWork();
    return result;
  }

  async activateCatalog(input: {
    readonly catalogVersionId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
    readonly rollback?: boolean;
  }): Promise<ServiceCatalogVersion> {
    const result = await this.database.transaction(async (transaction) => {
      const current = await this.lockCatalogVersion(transaction, input.catalogVersionId);
      if (!current.synthetic) throw new ProductionCatalogNotConfiguredError();
      if (current.status !== "published" && current.status !== "superseded") {
        throw new CatalogActivationError(
          "Only published or superseded synthetic catalogs can activate.",
        );
      }
      if (!current.checksum) {
        throw new CatalogActivationError(
          "Published identity checksum is required before activation.",
        );
      }
      const pack = parseUnknownCatalog(current.packagePayload);
      const blocking = validateCatalogPackage(pack).filter((item) => item.blocking);
      if (blocking[0]) throw new CatalogActivationError(blocking[0].message);
      await this.assertProjectionAgrees(transaction, current, pack);
      const identity = catalogIdentity(current, pack);
      if (identity !== current.checksum) {
        throw new CatalogActivationError("Catalog checksum no longer matches the frozen package.");
      }
      if (this.database.kind === "postgres") {
        await transaction.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          current.serviceContextKey,
        ]);
      }
      const now = this.stamp();
      const active = await transaction.query<Row>(
        "SELECT * FROM service_catalog_versions WHERE service_context_key=$1 AND status='active' FOR UPDATE",
        [current.serviceContextKey],
      );
      for (const row of active.rows) {
        const prior = mapCatalogVersion(row);
        if (prior.id === current.id) continue;
        await transaction.query(
          `UPDATE service_catalog_versions SET status='superseded', updated_at=$2, version=version+1 WHERE id=$1`,
          [prior.id, now],
        );
        await this.emitCommercialEvent(transaction, {
          eventType: "catalog.superseded",
          aggregateType: "catalog",
          aggregateId: prior.id,
          actorUserId: input.actorUserId,
          correlationId: input.correlationId,
          payload: { catalogVersionId: prior.id, replacedBy: current.id },
          summary: `Catalog superseded: ${prior.catalogKey} v${prior.versionNumber}`,
          now,
        });
      }
      let updated;
      try {
        updated = await transaction.query<Row>(
          `UPDATE service_catalog_versions
              SET status='active', activated_at=$2, activated_by_user_id=$3, updated_at=$2, version=version+1
            WHERE id=$1 RETURNING *`,
          [current.id, now, input.actorUserId],
        );
      } catch (error) {
        if (isUniqueConstraintViolation(error)) {
          throw new CommercialConcurrencyError(
            "Another catalog version is already active for this service context.",
          );
        }
        throw error;
      }
      await this.emitCommercialEvent(transaction, {
        eventType: input.rollback ? "catalog.rollback" : "catalog.activated",
        aggregateType: "catalog",
        aggregateId: current.id,
        actorUserId: input.actorUserId,
        correlationId: input.correlationId,
        payload: { catalogVersionId: current.id, rollback: Boolean(input.rollback) },
        summary: `Catalog activated: ${current.catalogKey} v${current.versionNumber}`,
        now,
      });
      return mapCatalogVersion(updated.rows[0] as Row);
    });
    await this.afterDomainWork();
    return result;
  }

  async cloneCatalogDraft(input: {
    readonly catalogVersionId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
  }): Promise<ServiceCatalogVersion> {
    const created = await this.database.transaction(async (transaction) => {
      const current = await this.lockCatalogVersion(transaction, input.catalogVersionId);
      const pack = parseUnknownCatalog(current.packagePayload);
      if (this.database.kind === "postgres") {
        await transaction.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `catalog:${current.catalogId}`,
        ]);
      } else {
        await transaction.query("SELECT id FROM service_catalogs WHERE id=$1 FOR UPDATE", [
          current.catalogId,
        ]);
      }
      const max = await transaction.query<{ n: string }>(
        "SELECT COALESCE(MAX(version_number),0)::text AS n FROM service_catalog_versions WHERE catalog_id=$1",
        [current.catalogId],
      );
      const versionNumber = Number(max.rows[0]?.n ?? 0) + 1;
      const now = this.stamp();
      const id = randomUUID();
      let inserted;
      try {
        inserted = await transaction.query<Row>(
          `INSERT INTO service_catalog_versions
           (id,catalog_id,catalog_key,version_number,status,synthetic,production_ready,service_context_key,currency,
            effective_from,disclosure,package_payload,created_by_user_id,parent_version_id,created_at,updated_at,version)
           VALUES ($1,$2,$3,$4,'draft',$5,FALSE,$6,$7,$8,$9,$10::jsonb,$11,$12,$8,$8,1)
           RETURNING *`,
          [
            id,
            current.catalogId,
            current.catalogKey,
            versionNumber,
            current.synthetic,
            current.serviceContextKey,
            pack.currency,
            now,
            pack.disclosure,
            JSON.stringify(pack),
            input.actorUserId,
            current.id,
          ],
        );
      } catch (error) {
        if (isUniqueConstraintViolation(error)) {
          throw new CommercialConcurrencyError(
            "A concurrent Catalog clone already allocated this version number.",
          );
        }
        throw error;
      }
      await this.replaceCatalogItems(transaction, id, pack, now);
      await this.emitCommercialEvent(transaction, {
        eventType: "catalog.draft_created",
        aggregateType: "catalog",
        aggregateId: id,
        actorUserId: input.actorUserId,
        correlationId: input.correlationId,
        payload: { catalogVersionId: id, parentVersionId: current.id },
        summary: `Catalog draft cloned: ${current.catalogKey} v${versionNumber}`,
        now,
      });
      return mapCatalogVersion(inserted.rows[0] as Row);
    });
    await this.afterDomainWork();
    return created;
  }

  async updateCatalogDraft(input: {
    readonly catalogVersionId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
    readonly pack: unknown;
  }): Promise<ServiceCatalogVersion> {
    const pack = parseUnknownCatalog(input.pack);
    const updated = await this.database.transaction(async (transaction) => {
      const current = await this.lockCatalogVersion(transaction, input.catalogVersionId);
      if (!catalogVersionIsEditable(current.status)) {
        throw new CatalogImmutabilityError();
      }
      if (pack.catalogKey !== current.catalogKey) {
        throw new CommercialValidationError("A catalog draft cannot change its catalog key.");
      }
      if (!current.synthetic || !pack.synthetic) {
        throw new ProductionCatalogNotConfiguredError();
      }
      const now = this.stamp();
      const replaced = await transaction.query<Row>(
        `UPDATE service_catalog_versions
            SET package_payload=$2::jsonb, currency=$3, disclosure=$4, checksum=NULL,
                validated_identity_checksum=NULL, status='draft', updated_at=$5, version=version+1,
                validated_at=NULL, validated_by_user_id=NULL, published_at=NULL, published_by_user_id=NULL
          WHERE id=$1 RETURNING *`,
        [current.id, JSON.stringify(pack), pack.currency, pack.disclosure, now],
      );
      await this.replaceCatalogItems(transaction, current.id, pack, now);
      await this.emitCommercialEvent(transaction, {
        eventType: "catalog.draft_created",
        aggregateType: "catalog",
        aggregateId: current.id,
        actorUserId: input.actorUserId,
        correlationId: input.correlationId,
        payload: { catalogVersionId: current.id },
        summary: `Catalog draft updated: ${current.catalogKey} v${current.versionNumber}`,
        now,
      });
      return mapCatalogVersion(replaced.rows[0] as Row);
    });
    await this.afterDomainWork();
    return updated;
  }

  async createProposalFromLead(input: {
    readonly leadId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
    readonly catalogVersionId?: string;
    readonly assignedReviewerUserId?: string;
  }): Promise<{ readonly record: ProposalRecord; readonly alreadyExisted: boolean }> {
    const created = await this.database.transaction(async (transaction) => {
      const locked = await transaction.query<Row>("SELECT id FROM leads WHERE id=$1 FOR UPDATE", [
        input.leadId,
      ]);
      if (!locked.rows[0]) throw new CommercialNotFoundError("Lead was not found.");
      const leadRecord = await this.leads.getLead(input.leadId, transaction);
      if (!leadRecord) throw new CommercialNotFoundError("Lead was not found.");
      if (
        leadRecord.lead.status !== "ready_for_proposal" ||
        !leadRecord.readiness.readyForProposal
      ) {
        throw new CommercialValidationError(
          "A proposal can be created only from a lead that is ready_for_proposal.",
        );
      }
      const catalogVersion = await this.requireActiveSyntheticCatalog(
        transaction,
        leadRecord.lead,
        input.catalogVersionId,
      );
      const pack = parseUnknownCatalog(catalogVersion.packagePayload);
      const now = this.stamp();
      const id = randomUUID();
      const reference = await this.nextProposalReference(transaction);
      const reviewerId = await this.resolveReviewer(transaction, input.assignedReviewerUserId);
      const snapshot = snapshotLeadForProposal({
        lead: leadRecord.lead,
        parties: leadRecord.parties,
      });
      const pricing = calculatePricingSnapshot({
        catalog: pack,
        catalogVersionId: catalogVersion.id,
        catalogVersionNumber: catalogVersion.versionNumber,
        lines: [],
      });
      const readiness = evaluateProposalReadiness({
        leadStatus: leadRecord.lead.status,
        leadReadyForProposal: true,
        snapshot,
        catalog: pack,
        catalogStatus: catalogVersion.status,
        lines: [],
        pricing,
        scopeText: "",
        assignedReviewerUserId: reviewerId,
        overrides: [],
      });
      const initialStatus = nextProposalStatusForReadiness("draft", readiness);
      const cycle = informationCycleForStatus(0, "new", initialStatus);
      try {
        const inserted = await transaction.query<Row>(
          `INSERT INTO proposals
           (id,reference,lead_id,status,current_version_number,assigned_preparer_user_id,assigned_reviewer_user_id,
            catalog_version_id,opportunity_name,currency,subtotal_minor,total_minor,synthetic,correlation_id,
            created_by_user_id,lead_snapshot,information_cycle_number,created_at,updated_at,version)
           VALUES ($1,$2,$3,$4,0,$5,$6,$7,$8,$9,0,0,TRUE,$10,$5,$11::jsonb,$12,$13,$13,1)
           ON CONFLICT (lead_id) WHERE status NOT IN ('cancelled','superseded')
           DO NOTHING
           RETURNING *`,
          [
            id,
            reference,
            input.leadId,
            initialStatus,
            input.actorUserId,
            reviewerId,
            catalogVersion.id,
            leadRecord.lead.opportunityName,
            catalogVersion.currency,
            input.correlationId,
            JSON.stringify(snapshot),
            cycle,
            now,
          ],
        );
        if (!inserted.rows[0]) {
          const existing = await transaction.query<Row>(
            `SELECT id FROM proposals
              WHERE lead_id=$1 AND status NOT IN ('cancelled','superseded')
              ORDER BY created_at LIMIT 1`,
            [input.leadId],
          );
          if (!existing.rows[0]) {
            throw new CommercialConcurrencyError(
              "Concurrent proposal creation did not yield a record.",
            );
          }
          return { proposalId: String(existing.rows[0].id), alreadyExisted: true };
        }
        const ids = {
          proposalId: id,
          leadId: input.leadId,
          catalogVersionId: catalogVersion.id,
          informationCycleNumber: cycle,
        };
        await this.emitCommercialEvent(transaction, {
          eventType: "proposal.created",
          aggregateType: "proposal",
          aggregateId: id,
          actorUserId: input.actorUserId,
          correlationId: input.correlationId,
          payload: {
            ...ids,
            leadSnapshot: snapshot as unknown as JsonObject,
          },
          summary: `Proposal created: ${reference}`,
          now,
          ...ids,
          preparerUserId: input.actorUserId,
          reviewerUserId: reviewerId,
          fromStatus: null,
          toStatus: initialStatus,
        });
        if (!readiness.readyForReview) {
          await this.emitCommercialEvent(transaction, {
            eventType: "proposal.readiness_failed",
            aggregateType: "proposal",
            aggregateId: id,
            actorUserId: input.actorUserId,
            correlationId: input.correlationId,
            payload: { ...ids, readiness: readiness as unknown as JsonObject },
            summary: `Proposal readiness failed: ${reference}`,
            now,
            ...ids,
          });
          await this.emitCommercialEvent(transaction, {
            eventType: "proposal.needs_information",
            aggregateType: "proposal",
            aggregateId: id,
            actorUserId: input.actorUserId,
            correlationId: input.correlationId,
            payload: ids,
            summary: `Proposal needs information: ${reference}`,
            now,
            ...ids,
          });
        }
        return { proposalId: id, alreadyExisted: false };
      } catch (error) {
        if (isUniqueConstraintViolation(error)) {
          const existing = await transaction.query<Row>(
            `SELECT id FROM proposals WHERE lead_id=$1 AND status NOT IN ('cancelled','superseded') LIMIT 1`,
            [input.leadId],
          );
          if (existing.rows[0]) {
            return { proposalId: String(existing.rows[0].id), alreadyExisted: true };
          }
        }
        throw error;
      }
    });
    await this.afterDomainWork();
    const record = await this.repository.getProposal(created.proposalId);
    if (!record) throw new CommercialNotFoundError();
    return { record, alreadyExisted: created.alreadyExisted };
  }

  async updateDraft(input: {
    readonly proposalId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
    readonly expectedVersion: number;
    readonly opportunityName?: string;
    readonly assignedReviewerUserId?: string | null;
    readonly scopeText?: string;
    readonly deliverables?: readonly string[];
    readonly assumptions?: readonly string[];
    readonly exclusions?: readonly string[];
    readonly scheduleText?: string | null;
    readonly lines?: readonly { readonly serviceKey: string; readonly quantityScaled: number }[];
  }): Promise<ProposalRecord> {
    await this.database.transaction(async (transaction) => {
      const proposal = await this.lockProposal(
        transaction,
        input.proposalId,
        input.expectedVersion,
      );
      this.assertMutable(proposal.status);
      if (input.assignedReviewerUserId) {
        await this.requireEligibleReviewer(transaction, input.assignedReviewerUserId);
      }
      const catalog = await this.lockCatalogVersion(transaction, proposal.catalogVersionId);
      const pack = parseUnknownCatalog(catalog.packagePayload);
      const now = this.stamp();
      if (input.lines) {
        for (const line of input.lines) {
          assertSafeScaledQuantity(line.quantityScaled, line.serviceKey);
        }
        await this.replaceDraftLines(transaction, proposal.id, pack, catalog, input.lines, now);
      }
      const target = targetVersionNumber(proposal);
      const lines = this.applyApprovedOverrides(
        await loadDraftLines(transaction, proposal.id),
        await loadOverrides(transaction, proposal.id, target),
        target,
      );
      const overrides = await loadOverrides(transaction, proposal.id, target);
      const pricing = calculatePricingSnapshot({
        catalog: pack,
        catalogVersionId: catalog.id,
        catalogVersionNumber: catalog.versionNumber,
        lines,
      });
      this.assertSafeTotal(pricing.totalMinor, "Proposal total");
      await this.persistPricedDraftLines(transaction, proposal.id, pricing.lines, now);
      const leadStatusRow = await transaction.query<{ status: string }>(
        "SELECT status FROM leads WHERE id=$1",
        [proposal.leadId],
      );
      const snapshot = proposal.leadSnapshot;
      if (!snapshot) {
        throw new CommercialValidationError("Proposal lead snapshot is missing.");
      }
      const leadStatus = String(leadStatusRow.rows[0]?.status ?? "") as LeadStatus;
      const scopeText = input.scopeText ?? proposal.scopeText;
      const reviewerId =
        input.assignedReviewerUserId === undefined
          ? proposal.assignedReviewerUserId
          : input.assignedReviewerUserId;
      const readiness = evaluateProposalReadiness({
        leadStatus,
        leadReadyForProposal: leadStatus === "ready_for_proposal",
        snapshot,
        catalog: pack,
        catalogStatus: catalog.status,
        lines,
        pricing,
        scopeText,
        assignedReviewerUserId: reviewerId,
        overrides,
      });
      const nextStatus = nextProposalStatusForReadiness(proposal.status, readiness);
      if (nextStatus !== proposal.status)
        assertProposalStatusTransition(proposal.status, nextStatus);
      const cycle = informationCycleForStatus(
        proposal.informationCycleNumber,
        proposal.status,
        nextStatus,
      );
      const updated = await transaction.query<Row>(
        `UPDATE proposals
            SET opportunity_name=COALESCE($2, opportunity_name),
                assigned_reviewer_user_id=CASE WHEN $3 THEN $4::uuid ELSE assigned_reviewer_user_id END,
                status=$5, subtotal_minor=$6, total_minor=$7,
                scope_text=$8, deliverables=$9::jsonb, assumptions=$10::jsonb, exclusions=$11::jsonb,
                schedule_text=$12, information_cycle_number=$13, updated_at=$14, version=version+1
          WHERE id=$1 AND version=$15
          RETURNING *`,
        [
          proposal.id,
          input.opportunityName ?? null,
          input.assignedReviewerUserId !== undefined,
          input.assignedReviewerUserId ?? null,
          nextStatus,
          pricing.subtotalMinor,
          pricing.totalMinor,
          scopeText,
          JSON.stringify(input.deliverables ?? proposal.deliverables),
          JSON.stringify(input.assumptions ?? proposal.assumptions),
          JSON.stringify(input.exclusions ?? proposal.exclusions),
          input.scheduleText === undefined ? proposal.scheduleText : input.scheduleText,
          cycle,
          now,
          proposal.version,
        ],
      );
      if (!updated.rows[0]) throw new CommercialConcurrencyError();
      const ids = {
        proposalId: proposal.id,
        leadId: proposal.leadId,
        catalogVersionId: catalog.id,
        informationCycleNumber: cycle,
      };
      if (readiness.readyForReview) {
        await this.emitCommercialEvent(transaction, {
          eventType: "proposal.ready_for_review",
          aggregateType: "proposal",
          aggregateId: proposal.id,
          actorUserId: input.actorUserId,
          correlationId: input.correlationId,
          payload: { ...ids, readiness: readiness as unknown as JsonObject },
          summary: `Proposal ready for review: ${proposal.reference}`,
          now,
          ...ids,
          fromStatus: proposal.status,
          toStatus: nextStatus,
        });
        await this.emitCommercialEvent(transaction, {
          eventType: "proposal.updated",
          aggregateType: "proposal",
          aggregateId: proposal.id,
          actorUserId: input.actorUserId,
          correlationId: input.correlationId,
          payload: ids,
          summary: `Proposal updated: ${proposal.reference}`,
          now,
          ...ids,
        });
      } else {
        await this.emitCommercialEvent(transaction, {
          eventType: "proposal.readiness_failed",
          aggregateType: "proposal",
          aggregateId: proposal.id,
          actorUserId: input.actorUserId,
          correlationId: input.correlationId,
          payload: { ...ids, readiness: readiness as unknown as JsonObject },
          summary: `Proposal readiness failed: ${proposal.reference}`,
          now,
          ...ids,
          fromStatus: proposal.status,
          toStatus: nextStatus,
        });
        await this.emitCommercialEvent(transaction, {
          eventType: "proposal.needs_information",
          aggregateType: "proposal",
          aggregateId: proposal.id,
          actorUserId: input.actorUserId,
          correlationId: input.correlationId,
          payload: ids,
          summary: `Proposal needs information: ${proposal.reference}`,
          now,
          ...ids,
        });
      }
    });
    await this.afterDomainWork();
    const record = await this.repository.getProposal(input.proposalId);
    if (!record) throw new CommercialNotFoundError();
    return record;
  }

  async submitForReview(input: {
    readonly proposalId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
    readonly expectedVersion: number;
  }): Promise<ProposalRecord> {
    await this.database.transaction(async (transaction) => {
      const proposal = await this.lockProposal(
        transaction,
        input.proposalId,
        input.expectedVersion,
      );
      if (proposal.status !== "ready_for_review") {
        throw new ProposalStatusTransitionError(proposal.status, "in_review");
      }
      const context = await this.proposalContext(proposal, transaction);
      if (!context.readiness.readyForReview) {
        throw new CommercialValidationError(
          context.readiness.blocking[0]?.message ?? "Proposal readiness is blocking.",
        );
      }
      if (!proposal.assignedReviewerUserId) {
        throw new CommercialValidationError(
          "A commercial reviewer must be assigned before review.",
        );
      }
      await this.requireEligibleReviewer(transaction, proposal.assignedReviewerUserId);
      const now = this.stamp();
      assertProposalStatusTransition("ready_for_review", "in_review");
      const versionNumber = proposal.currentVersionNumber + 1;
      const versionId = randomUUID();
      const document = this.documentFrom(proposal, context, versionNumber, "frozen_review", now);
      const rendered = renderProposalDocumentToPdf(document, now);
      try {
        await transaction.query(
          `INSERT INTO proposal_versions
           (id,proposal_id,version_number,status,lead_snapshot,party_snapshot,catalog_version_id,line_item_snapshot,
            scope_text,deliverables,assumptions,exclusions,schedule_text,terms_snapshot,pricing_snapshot,total_minor,
            currency,readiness,document_snapshot,rendered_checksum,file_name,frozen_at,created_at,updated_at,version)
           VALUES ($1,$2,$3,'frozen_review',$4::jsonb,$5::jsonb,$6,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,
                   $13::jsonb,$14::jsonb,$15,$16,$17::jsonb,$18::jsonb,$19,$20,$21,$21,$21,1)`,
          [
            versionId,
            proposal.id,
            versionNumber,
            JSON.stringify(context.snapshot),
            JSON.stringify(context.snapshot.parties),
            context.catalog.id,
            JSON.stringify(context.pricing.lines),
            proposal.scopeText,
            JSON.stringify(proposal.deliverables),
            JSON.stringify(proposal.assumptions),
            JSON.stringify(proposal.exclusions),
            proposal.scheduleText,
            JSON.stringify(context.pack.terms),
            JSON.stringify(context.pricing),
            context.pricing.totalMinor,
            context.pricing.currency,
            JSON.stringify(context.readiness),
            JSON.stringify(document),
            rendered.checksumSha256,
            buildProposalFileName(proposal.reference, versionNumber),
            now,
          ],
        );
      } catch (error) {
        if (isUniqueConstraintViolation(error)) {
          throw new CommercialConcurrencyError("Another version was created for this proposal.");
        }
        throw error;
      }
      await transaction.query(
        `UPDATE proposal_pricing_overrides
            SET proposal_version_id=$2, updated_at=$3, version=version+1
          WHERE proposal_id=$1 AND target_version_number=$4 AND status='approved' AND proposal_version_id IS NULL`,
        [proposal.id, versionId, now, versionNumber],
      );
      let requestedRevisionVersionId: string | null = null;
      if (proposal.currentVersionNumber > 0) {
        const prior = await transaction.query<Row>(
          "SELECT id FROM proposal_versions WHERE proposal_id=$1 AND version_number=$2",
          [proposal.id, proposal.currentVersionNumber],
        );
        requestedRevisionVersionId = prior.rows[0] ? String(prior.rows[0].id) : null;
        await transaction.query(
          `UPDATE proposal_versions
              SET status='superseded', superseded_at=$2, updated_at=$2, version=version+1
            WHERE proposal_id=$1 AND id<>$3 AND status IN ('frozen_review','revision_required','approved')`,
          [proposal.id, now, versionId],
        );
      }
      const updated = await transaction.query<Row>(
        `UPDATE proposals
            SET status='in_review', current_version_number=$2, submitted_at=$3, updated_at=$3, version=version+1
          WHERE id=$1 AND version=$4 RETURNING *`,
        [proposal.id, versionNumber, now, proposal.version],
      );
      if (!updated.rows[0]) throw new CommercialConcurrencyError();
      const ids = {
        proposalId: proposal.id,
        proposalVersionId: versionId,
        leadId: proposal.leadId,
        catalogVersionId: context.catalog.id,
        pricingSnapshotId: versionId,
        requestedRevisionVersionId,
        informationCycleNumber: proposal.informationCycleNumber,
      };
      await this.emitCommercialEvent(transaction, {
        eventType: "proposal.version_created",
        aggregateType: "proposal",
        aggregateId: proposal.id,
        actorUserId: input.actorUserId,
        correlationId: input.correlationId,
        payload: ids,
        summary: `Proposal version created: ${proposal.reference} v${versionNumber}`,
        now,
        ...ids,
      });
      await this.emitCommercialEvent(transaction, {
        eventType: "proposal.submitted_for_review",
        aggregateType: "proposal",
        aggregateId: proposal.id,
        actorUserId: input.actorUserId,
        correlationId: input.correlationId,
        payload: ids,
        summary: `Proposal submitted for review: ${proposal.reference} v${versionNumber}`,
        now,
        ...ids,
        fromStatus: proposal.status,
        toStatus: "in_review",
      });
      await this.emitCommercialEvent(transaction, {
        eventType: "proposal.review_started",
        aggregateType: "proposal",
        aggregateId: proposal.id,
        actorUserId: input.actorUserId,
        correlationId: input.correlationId,
        payload: ids,
        summary: `Proposal review started: ${proposal.reference} v${versionNumber}`,
        now,
        ...ids,
      });
    });
    await this.afterDomainWork();
    const record = await this.repository.getProposal(input.proposalId);
    if (!record) throw new CommercialNotFoundError();
    return record;
  }

  async reviewProposal(input: {
    readonly proposalId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
    readonly expectedVersion: number;
    readonly proposalVersionId: string;
    readonly decision: ProposalReviewDecision;
    readonly comments?: string;
    readonly requestedSections?: readonly string[];
    readonly ownerApprovalOverrideReason?: string;
  }): Promise<ProposalRecord> {
    await this.database.transaction(async (transaction) => {
      const proposal = await this.lockProposal(
        transaction,
        input.proposalId,
        input.expectedVersion,
      );
      if (proposal.status !== "in_review") {
        throw new ProposalStatusTransitionError(
          proposal.status,
          input.decision === "approve" ? "approved" : "revision_required",
        );
      }
      const versionRow = await transaction.query<Row>(
        "SELECT * FROM proposal_versions WHERE id=$1 AND proposal_id=$2 FOR UPDATE",
        [input.proposalVersionId, proposal.id],
      );
      if (!versionRow.rows[0]) throw new CommercialNotFoundError("Proposal version was not found.");
      const frozen = mapProposalVersion(versionRow.rows[0]);
      if (frozen.versionNumber !== proposal.currentVersionNumber) {
        throw new ProposalImmutabilityError(
          "Approval applies only to the exact current reviewed version.",
        );
      }
      if (frozen.status === "approved" && input.decision === "approve") return;
      if (frozen.status !== "frozen_review") {
        throw new ProposalImmutabilityError("The selected version is not in review.");
      }
      if (!frozen.renderedChecksum || !frozen.fileName) {
        throw new CommercialValidationError(
          "A frozen Proposal version must have a rendered checksum and filename before approval.",
        );
      }
      if (proposal.assignedPreparerUserId === input.actorUserId) {
        throw new ProposalAuthorizationError("Self-approval is UNCONFIGURED and blocked.");
      }
      const assignedReviewer = proposal.assignedReviewerUserId;
      const overrideReason = input.ownerApprovalOverrideReason?.trim() ?? "";
      if (assignedReviewer && assignedReviewer !== input.actorUserId) {
        if (!overrideReason) {
          throw new ProposalAuthorizationError(
            "Only the assigned commercial reviewer may approve, unless an explicit Owner override reason is supplied.",
          );
        }
        await this.requireEligibleReviewer(transaction, input.actorUserId);
      } else if (assignedReviewer === input.actorUserId) {
        await this.requireEligibleReviewer(transaction, input.actorUserId);
      } else {
        await this.requireEligibleReviewer(transaction, input.actorUserId);
      }
      const pendingOverrides = await loadOverrides(transaction, proposal.id, frozen.versionNumber);
      if (
        input.decision === "approve" &&
        pendingOverrides.some((item) => item.status === "requested")
      ) {
        throw new CommercialValidationError(
          "Unapproved pricing overrides block commercial approval.",
        );
      }
      const now = this.stamp();
      const nextStatus: ProposalStatus =
        input.decision === "approve" ? "approved" : "revision_required";
      assertProposalStatusTransition("in_review", nextStatus);
      const evidence =
        input.decision === "approve"
          ? {
              userId: input.actorUserId,
              timestamp: now,
              proposalVersionId: frozen.id,
              checksum: frozen.renderedChecksum,
              fileName: frozen.fileName,
              totalMinor: frozen.totalMinor,
              currency: frozen.currency,
              ownerOverride: overrideReason ? true : false,
              ownerOverrideReason: overrideReason || null,
            }
          : null;
      try {
        await transaction.query(
          `INSERT INTO proposal_reviews
         (id,proposal_id,proposal_version_id,decision,comments,requested_sections,reviewer_user_id,checksum,total_minor,currency,created_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)`,
          [
            randomUUID(),
            proposal.id,
            frozen.id,
            input.decision,
            input.comments ?? "",
            JSON.stringify(input.requestedSections ?? []),
            input.actorUserId,
            frozen.renderedChecksum,
            frozen.totalMinor,
            frozen.currency,
            now,
          ],
        );
      } catch (error) {
        if (isUniqueConstraintViolation(error)) {
          throw new CommercialConcurrencyError(
            "Another commercial approval already exists for this Proposal version.",
          );
        }
        throw error;
      }
      await transaction.query(
        `UPDATE proposal_versions
            SET status=$2, reviewer_user_id=$3, review_decision=$4, approval_evidence=$5::jsonb, updated_at=$6, version=version+1
          WHERE id=$1`,
        [
          frozen.id,
          input.decision === "approve" ? "approved" : "revision_required",
          input.actorUserId,
          input.decision,
          evidence ? JSON.stringify(evidence) : null,
          now,
        ],
      );
      const updated = await transaction.query<Row>(
        `UPDATE proposals
            SET status=$2, reviewed_at=$3, approved_at=$4, updated_at=$3, version=version+1
          WHERE id=$1 AND version=$5 RETURNING *`,
        [proposal.id, nextStatus, now, input.decision === "approve" ? now : null, proposal.version],
      );
      if (!updated.rows[0]) throw new CommercialConcurrencyError();
      if (input.decision !== "approve") {
        await transaction.query(
          `UPDATE proposal_line_items
              SET unit_amount_minor = catalog_unit_amount_minor,
                  override_id = NULL,
                  updated_at = $2,
                  version = version + 1
            WHERE proposal_id=$1 AND proposal_version_id IS NULL`,
          [proposal.id, now],
        );
        const catalog = await this.lockCatalogVersion(transaction, proposal.catalogVersionId);
        const pack = parseUnknownCatalog(catalog.packagePayload);
        const resetLines = (await loadDraftLines(transaction, proposal.id)).map((line) => ({
          ...line,
          unitAmountMinor: line.catalogUnitAmountMinor,
          overrideId: null,
        }));
        const pricing = calculatePricingSnapshot({
          catalog: pack,
          catalogVersionId: catalog.id,
          catalogVersionNumber: catalog.versionNumber,
          lines: resetLines,
        });
        this.assertSafeTotal(pricing.totalMinor, "Proposal total");
        for (const line of pricing.lines) {
          await transaction.query(
            `UPDATE proposal_line_items
                SET line_subtotal_minor=$2, updated_at=$3, version=version+1
              WHERE proposal_id=$1 AND proposal_version_id IS NULL AND line_key=$4`,
            [proposal.id, line.lineSubtotalMinor, now, line.lineKey],
          );
        }
        await transaction.query(
          `UPDATE proposals SET subtotal_minor=$2, total_minor=$3, updated_at=$4 WHERE id=$1`,
          [proposal.id, pricing.subtotalMinor, pricing.totalMinor, now],
        );
      }
      await this.emitCommercialEvent(transaction, {
        eventType:
          input.decision === "approve" ? "proposal.approved" : "proposal.revision_requested",
        aggregateType: "proposal",
        aggregateId: proposal.id,
        actorUserId: input.actorUserId,
        correlationId: input.correlationId,
        payload: {
          proposalId: proposal.id,
          proposalVersionId: frozen.id,
          leadId: proposal.leadId,
          catalogVersionId: proposal.catalogVersionId,
          comments: input.comments ?? "",
          requestedSections: [...(input.requestedSections ?? [])],
          informationCycleNumber: proposal.informationCycleNumber,
          ownerOverrideReason: overrideReason || null,
        },
        summary:
          input.decision === "approve"
            ? `Proposal approved: ${proposal.reference} v${frozen.versionNumber}`
            : `Proposal revision requested: ${proposal.reference} v${frozen.versionNumber}`,
        now,
        leadId: proposal.leadId,
        proposalId: proposal.id,
        proposalVersionId: frozen.id,
        catalogVersionId: proposal.catalogVersionId,
        informationCycleNumber: proposal.informationCycleNumber,
        fromStatus: proposal.status,
        toStatus: nextStatus,
      });
    });
    await this.afterDomainWork();
    const record = await this.repository.getProposal(input.proposalId);
    if (!record) throw new CommercialNotFoundError();
    return record;
  }

  async requestOverride(input: {
    readonly proposalId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
    readonly expectedVersion: number;
    readonly lineKey: string;
    readonly proposedAmountMinor: number;
    readonly reason: string;
  }): Promise<ProposalRecord> {
    await this.database.transaction(async (transaction) => {
      const proposal = await this.lockProposal(
        transaction,
        input.proposalId,
        input.expectedVersion,
      );
      this.assertMutable(proposal.status);
      const proposedAmountMinor = assertSafeProposedAmount(
        input.proposedAmountMinor,
        "Proposed override amount",
      );
      if (!input.reason.trim()) {
        throw new CommercialValidationError("A pricing override requires a nonempty reason.");
      }
      const target = targetVersionNumber(proposal);
      const line = (await loadDraftLines(transaction, proposal.id)).find(
        (item) => item.lineKey === input.lineKey,
      );
      if (!line) throw new CommercialNotFoundError("Proposal line was not found.");
      const now = this.stamp();
      const id = randomUUID();
      try {
        await transaction.query(
          `INSERT INTO proposal_pricing_overrides
           (id,proposal_id,line_key,original_amount_minor,proposed_amount_minor,difference_minor,reason,status,
            requested_by_user_id,synthetic,target_version_number,draft_cycle_number,created_at,updated_at,version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'requested',$8,TRUE,$9,$9,$10,$10,1)`,
          [
            id,
            proposal.id,
            input.lineKey,
            line.catalogUnitAmountMinor,
            proposedAmountMinor,
            overrideDifferenceMinor(line.catalogUnitAmountMinor, proposedAmountMinor),
            input.reason.trim(),
            input.actorUserId,
            target,
            now,
          ],
        );
      } catch (error) {
        if (isUniqueConstraintViolation(error)) {
          throw new CommercialConcurrencyError(
            "An effective pricing override already exists for this line and target version.",
          );
        }
        throw error;
      }
      await transaction.query(
        "UPDATE proposals SET updated_at=$2, version=version+1 WHERE id=$1 AND version=$3",
        [proposal.id, now, proposal.version],
      );
      await this.emitCommercialEvent(transaction, {
        eventType: "proposal.pricing_override_requested",
        aggregateType: "proposal",
        aggregateId: proposal.id,
        actorUserId: input.actorUserId,
        correlationId: input.correlationId,
        payload: {
          proposalId: proposal.id,
          leadId: proposal.leadId,
          catalogVersionId: proposal.catalogVersionId,
          overrideId: id,
        },
        summary: `Pricing override requested: ${proposal.reference}`,
        now,
        leadId: proposal.leadId,
        proposalId: proposal.id,
        catalogVersionId: proposal.catalogVersionId,
        overrideId: id,
      });
    });
    await this.afterDomainWork();
    const record = await this.repository.getProposal(input.proposalId);
    if (!record) throw new CommercialNotFoundError();
    return record;
  }

  async decideOverride(input: {
    readonly proposalId: string;
    readonly overrideId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
    readonly expectedVersion: number;
    readonly approve: boolean;
  }): Promise<ProposalRecord> {
    await this.database.transaction(async (transaction) => {
      const locked = await transaction.query<Row>(
        "SELECT * FROM proposals WHERE id=$1 FOR UPDATE",
        [input.proposalId],
      );
      if (!locked.rows[0]) throw new CommercialNotFoundError("Proposal was not found.");
      const proposal = mapProposal(locked.rows[0]);
      this.assertMutable(proposal.status);
      await this.requireEligibleOverrideApprover(transaction, input.actorUserId);
      if (proposal.version !== input.expectedVersion) throw new CommercialConcurrencyError();
      const overrideRow = await transaction.query<Row>(
        "SELECT * FROM proposal_pricing_overrides WHERE id=$1 AND proposal_id=$2 FOR UPDATE",
        [input.overrideId, proposal.id],
      );
      if (!overrideRow.rows[0])
        throw new CommercialNotFoundError("Pricing override was not found.");
      const override = mapOverride(overrideRow.rows[0]);
      const target = targetVersionNumber(proposal);
      if (override.targetVersionNumber !== target) {
        throw new CommercialValidationError(
          "The pricing override does not target the current draft version.",
        );
      }
      if (override.status !== "requested") {
        if (
          (input.approve && override.status === "approved") ||
          (!input.approve && override.status === "rejected")
        ) {
          return;
        }
        throw new CommercialConcurrencyError(
          "The pricing override already has a contradictory terminal decision.",
        );
      }
      const line = (await loadDraftLines(transaction, proposal.id)).find(
        (item) => item.lineKey === override.lineKey,
      );
      if (!line) throw new CommercialNotFoundError("Proposal line was not found.");
      const now = this.stamp();
      const decided = await transaction.query<Row>(
        `UPDATE proposal_pricing_overrides
            SET status=$2, approved_by_user_id=$3, approved_at=$4, updated_at=$4, version=version+1
          WHERE id=$1 AND status='requested'
          RETURNING *`,
        [override.id, input.approve ? "approved" : "rejected", input.actorUserId, now],
      );
      if (!decided.rows[0]) {
        const current = mapOverride(
          (
            await transaction.query<Row>("SELECT * FROM proposal_pricing_overrides WHERE id=$1", [
              override.id,
            ])
          ).rows[0] as Row,
        );
        if (
          (input.approve && current.status === "approved") ||
          (!input.approve && current.status === "rejected")
        ) {
          return;
        }
        throw new CommercialConcurrencyError(
          "The pricing override already has a contradictory terminal decision.",
        );
      }
      if (input.approve) {
        await transaction.query(
          `UPDATE proposal_line_items
              SET unit_amount_minor=$2, override_id=$3, updated_at=$4, version=version+1
            WHERE proposal_id=$1 AND proposal_version_id IS NULL AND line_key=$5`,
          [proposal.id, override.proposedAmountMinor, override.id, now, override.lineKey],
        );
      }
      const catalog = await this.lockCatalogVersion(transaction, proposal.catalogVersionId);
      const pack = parseUnknownCatalog(catalog.packagePayload);
      const lines = this.applyApprovedOverrides(
        await loadDraftLines(transaction, proposal.id),
        await loadOverrides(transaction, proposal.id, target),
        target,
      );
      const pricing = calculatePricingSnapshot({
        catalog: pack,
        catalogVersionId: catalog.id,
        catalogVersionNumber: catalog.versionNumber,
        lines,
      });
      this.assertSafeTotal(pricing.totalMinor, "Proposal total");
      await this.persistPricedDraftLines(transaction, proposal.id, pricing.lines, now);
      const snapshot = proposal.leadSnapshot;
      const leadStatusRow = await transaction.query<{ status: string }>(
        "SELECT status FROM leads WHERE id=$1",
        [proposal.leadId],
      );
      const leadStatus = String(leadStatusRow.rows[0]?.status ?? "") as LeadStatus;
      const readiness = snapshot
        ? evaluateProposalReadiness({
            leadStatus,
            leadReadyForProposal: leadStatus === "ready_for_proposal",
            snapshot,
            catalog: pack,
            catalogStatus: catalog.status,
            lines,
            pricing,
            scopeText: proposal.scopeText,
            assignedReviewerUserId: proposal.assignedReviewerUserId,
            overrides: await loadOverrides(transaction, proposal.id, target),
          })
        : null;
      const nextStatus = readiness
        ? nextProposalStatusForReadiness(proposal.status, readiness)
        : proposal.status;
      if (nextStatus !== proposal.status)
        assertProposalStatusTransition(proposal.status, nextStatus);
      await transaction.query(
        `UPDATE proposals
            SET subtotal_minor=$2, total_minor=$3, status=$4, updated_at=$5, version=version+1
          WHERE id=$1 AND version=$6`,
        [proposal.id, pricing.subtotalMinor, pricing.totalMinor, nextStatus, now, proposal.version],
      );
      await this.emitCommercialEvent(transaction, {
        eventType: input.approve
          ? "proposal.pricing_override_approved"
          : "proposal.pricing_override_rejected",
        aggregateType: "proposal",
        aggregateId: proposal.id,
        actorUserId: input.actorUserId,
        correlationId: input.correlationId,
        payload: {
          proposalId: proposal.id,
          leadId: proposal.leadId,
          catalogVersionId: proposal.catalogVersionId,
          overrideId: override.id,
          informationCycleNumber: proposal.informationCycleNumber,
        },
        summary: `Pricing override ${input.approve ? "approved" : "rejected"}: ${proposal.reference}`,
        now,
        leadId: proposal.leadId,
        proposalId: proposal.id,
        catalogVersionId: proposal.catalogVersionId,
        overrideId: override.id,
        informationCycleNumber: proposal.informationCycleNumber,
        fromStatus: proposal.status,
        toStatus: nextStatus,
      });
    });
    await this.afterDomainWork();
    const record = await this.repository.getProposal(input.proposalId);
    if (!record) throw new CommercialNotFoundError();
    return record;
  }

  async generateDeliveryManifest(input: {
    readonly proposalId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
    readonly expectedVersion: number;
    readonly proposalVersionId: string;
  }): Promise<ProposalRecord> {
    await this.database.transaction(async (transaction) => {
      const proposal = await this.lockProposal(
        transaction,
        input.proposalId,
        input.expectedVersion,
      );
      if (proposal.status !== "approved" && proposal.status !== "ready_for_delivery") {
        throw new ProposalStatusTransitionError(proposal.status, "ready_for_delivery");
      }
      const versionRow = await transaction.query<Row>(
        "SELECT * FROM proposal_versions WHERE id=$1 AND proposal_id=$2",
        [input.proposalVersionId, proposal.id],
      );
      if (!versionRow.rows[0]) throw new CommercialNotFoundError("Proposal version was not found.");
      const frozen = mapProposalVersion(versionRow.rows[0]);
      if (frozen.status !== "approved") {
        throw new CommercialValidationError("A delivery dry-run requires an approved version.");
      }
      if (frozen.versionNumber !== proposal.currentVersionNumber) {
        throw new CommercialValidationError(
          "The delivery manifest must target the exact current approved Proposal version.",
        );
      }
      if (!frozen.renderedChecksum || !frozen.fileName) {
        throw new CommercialValidationError(
          "A delivery dry-run requires the frozen rendered checksum and filename.",
        );
      }
      const catalog = await this.lockCatalogVersion(transaction, frozen.catalogVersionId);
      const pack = parseUnknownCatalog(catalog.packagePayload);
      const now = this.stamp();
      const subject = pack.delivery.subjectTemplate
        .replace("{reference}", proposal.reference)
        .replace("{version}", String(frozen.versionNumber));
      const body = `${pack.delivery.bodyTemplate}\n\n${PROPOSAL_EMAIL_DRY_RUN_DISCLOSURE}`;
      const inserted = await transaction.query<Row>(
        `INSERT INTO proposal_delivery_manifests
         (id,proposal_id,proposal_version_id,sender_mailbox,to_recipient,cc_recipient,subject,body,
          proposal_reference,proposal_version_number,attachment_file_name,attachment_checksum,
          intended_authorization,connector_scopes,connector_readiness,live_writes,disclosure,policy_key,
          created_by_user_id,created_at,updated_at,version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,'not_connected',FALSE,$15,'synthetic-proposal-delivery',$16,$17,$17,1)
         ON CONFLICT (proposal_version_id, policy_key) DO NOTHING
         RETURNING *`,
        [
          randomUUID(),
          proposal.id,
          frozen.id,
          SYNTHETIC_PROPOSAL_SENDER,
          SYNTHETIC_PROPOSAL_RECIPIENT,
          SYNTHETIC_PROPOSAL_CC,
          subject,
          body,
          proposal.reference,
          frozen.versionNumber,
          frozen.fileName,
          frozen.renderedChecksum,
          "Internal dry-run only. Sending remains DEFERRED.",
          JSON.stringify(pack.delivery.requiredScopes),
          PROPOSAL_EMAIL_DRY_RUN_DISCLOSURE,
          input.actorUserId,
          now,
        ],
      );
      if (proposal.status === "ready_for_delivery" && !inserted.rows[0]) {
        return;
      }
      if (proposal.status !== "ready_for_delivery") {
        assertProposalStatusTransition(proposal.status, "ready_for_delivery");
        const moved = await transaction.query<Row>(
          `UPDATE proposals SET status='ready_for_delivery', updated_at=$2, version=version+1
            WHERE id=$1 AND version=$3 RETURNING *`,
          [proposal.id, now, proposal.version],
        );
        if (!moved.rows[0]) throw new CommercialConcurrencyError();
      }
      const ids = {
        proposalId: proposal.id,
        proposalVersionId: frozen.id,
        leadId: proposal.leadId,
        catalogVersionId: frozen.catalogVersionId,
        informationCycleNumber: proposal.informationCycleNumber,
      };
      if (inserted.rows[0]) {
        await this.emitCommercialEvent(transaction, {
          eventType: "proposal.delivery_manifest_created",
          aggregateType: "proposal",
          aggregateId: proposal.id,
          actorUserId: input.actorUserId,
          correlationId: input.correlationId,
          payload: { ...ids, liveWrites: false },
          summary: `Proposal delivery dry-run created: ${proposal.reference}`,
          now,
          ...ids,
        });
      }
      if (proposal.status !== "ready_for_delivery") {
        await this.emitCommercialEvent(transaction, {
          eventType: "proposal.ready_for_delivery",
          aggregateType: "proposal",
          aggregateId: proposal.id,
          actorUserId: input.actorUserId,
          correlationId: input.correlationId,
          payload: ids,
          summary: `Proposal ready for delivery: ${proposal.reference}`,
          now,
          ...ids,
          fromStatus: proposal.status,
          toStatus: "ready_for_delivery",
        });
      }
    });
    await this.afterDomainWork();
    const record = await this.repository.getProposal(input.proposalId);
    if (!record) throw new CommercialNotFoundError();
    return record;
  }

  async cancelProposal(input: {
    readonly proposalId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
    readonly expectedVersion: number;
  }): Promise<ProposalRecord> {
    await this.database.transaction(async (transaction) => {
      const proposal = await this.lockProposal(
        transaction,
        input.proposalId,
        input.expectedVersion,
      );
      assertProposalStatusTransition(proposal.status, "cancelled");
      const now = this.stamp();
      const updated = await transaction.query<Row>(
        `UPDATE proposals SET status='cancelled', cancelled_at=$2, updated_at=$2, version=version+1
          WHERE id=$1 AND version=$3 RETURNING *`,
        [proposal.id, now, proposal.version],
      );
      if (!updated.rows[0]) throw new CommercialConcurrencyError();
      await this.emitCommercialEvent(transaction, {
        eventType: "proposal.cancelled",
        aggregateType: "proposal",
        aggregateId: proposal.id,
        actorUserId: input.actorUserId,
        correlationId: input.correlationId,
        payload: {
          proposalId: proposal.id,
          leadId: proposal.leadId,
          catalogVersionId: proposal.catalogVersionId,
          informationCycleNumber: proposal.informationCycleNumber,
        },
        summary: `Proposal cancelled: ${proposal.reference}`,
        now,
        leadId: proposal.leadId,
        proposalId: proposal.id,
        catalogVersionId: proposal.catalogVersionId,
        informationCycleNumber: proposal.informationCycleNumber,
        fromStatus: proposal.status,
        toStatus: "cancelled",
      });
    });
    await this.afterDomainWork();
    const record = await this.repository.getProposal(input.proposalId);
    if (!record) throw new CommercialNotFoundError();
    return record;
  }

  async previewDocument(input: {
    readonly proposalId: string;
    readonly proposalVersionId?: string;
  }): Promise<{
    readonly document: ProposalDocument;
    readonly previewKind: ProposalDocument["previewKind"];
    readonly pdf: ReturnType<typeof renderProposalDocumentToPdf>;
  }> {
    const record = await this.repository.getProposal(input.proposalId);
    if (!record?.catalogPackage || !record.catalogVersion) {
      throw new CommercialNotFoundError();
    }
    if (input.proposalVersionId) {
      const frozen = record.versions.find((item) => item.id === input.proposalVersionId);
      if (!frozen) throw new CommercialNotFoundError("Proposal version was not found.");
      const document = frozen.documentSnapshot as unknown as ProposalDocument;
      return {
        document,
        previewKind: frozen.status === "approved" ? "approved" : "frozen_review",
        pdf: renderProposalDocumentToPdf(document, frozen.frozenAt ?? frozen.createdAt),
      };
    }
    const context = await this.proposalContext(record.proposal);
    const document = this.documentFrom(
      record.proposal,
      context,
      Math.max(record.proposal.currentVersionNumber, 0) + 1,
      "mutable_draft",
      this.stamp(),
    );
    return {
      document,
      previewKind: "mutable_draft",
      pdf: renderProposalDocumentToPdf(document, this.stamp()),
    };
  }

  async inspectProposal(proposalId: string): Promise<{
    readonly record: ProposalRecord;
    readonly readiness: ReturnType<typeof evaluateProposalReadiness>;
    readonly pricing: ReturnType<typeof calculatePricingSnapshot>;
  }> {
    const record = await this.repository.getProposal(proposalId);
    if (!record) throw new CommercialNotFoundError();
    const context = await this.proposalContext(record.proposal);
    return { record, readiness: context.readiness, pricing: context.pricing };
  }

  async refreshDraftFromLead(input: {
    readonly proposalId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
    readonly expectedVersion: number;
  }): Promise<{ readonly record: ProposalRecord; readonly changes: readonly string[] }> {
    const leadChanges: string[] = [];
    await this.database.transaction(async (transaction) => {
      const proposal = await this.lockProposal(
        transaction,
        input.proposalId,
        input.expectedVersion,
      );
      this.assertMutable(proposal.status);
      await transaction.query("SELECT id FROM leads WHERE id=$1 FOR UPDATE", [proposal.leadId]);
      const leadRecord = await this.leads.getLead(proposal.leadId, transaction);
      if (!leadRecord) throw new CommercialNotFoundError("Lead was not found.");
      const snapshot = snapshotLeadForProposal({
        lead: leadRecord.lead,
        parties: leadRecord.parties,
      });
      if (snapshot.opportunityName !== proposal.opportunityName)
        leadChanges.push("opportunityName");
      if (JSON.stringify(snapshot) !== JSON.stringify(proposal.leadSnapshot)) {
        leadChanges.push("leadSnapshot");
      }
      const now = this.stamp();
      await transaction.query(
        `UPDATE proposals
            SET opportunity_name=$2, lead_snapshot=$3::jsonb, updated_at=$4, version=version+1
          WHERE id=$1 AND version=$5`,
        [proposal.id, snapshot.opportunityName, JSON.stringify(snapshot), now, proposal.version],
      );
      await this.emitCommercialEvent(transaction, {
        eventType: "proposal.updated",
        aggregateType: "proposal",
        aggregateId: proposal.id,
        actorUserId: input.actorUserId,
        correlationId: input.correlationId,
        payload: {
          proposalId: proposal.id,
          leadId: proposal.leadId,
          catalogVersionId: proposal.catalogVersionId,
          refreshFromLead: true,
          changes: leadChanges,
          leadSnapshot: snapshot as unknown as JsonObject,
        },
        summary: `Proposal refreshed from lead: ${proposal.reference}`,
        now,
        leadId: proposal.leadId,
        proposalId: proposal.id,
        catalogVersionId: proposal.catalogVersionId,
      });
    });
    await this.afterDomainWork();
    const record = await this.repository.getProposal(input.proposalId);
    if (!record) throw new CommercialNotFoundError();
    return { record, changes: leadChanges };
  }

  private assertMutable(status: ProposalStatus): void {
    if (!proposalAllowsOverrideMutation(status)) {
      throw new ProposalImmutabilityError();
    }
  }

  private async lockProposal(executor: SqlExecutor, id: string, expectedVersion: number) {
    const result = await executor.query<Row>("SELECT * FROM proposals WHERE id=$1 FOR UPDATE", [
      id,
    ]);
    if (!result.rows[0]) throw new CommercialNotFoundError("Proposal was not found.");
    const proposal = mapProposal(result.rows[0]);
    if (proposal.version !== expectedVersion) throw new CommercialConcurrencyError();
    return proposal;
  }

  private async lockCatalogVersion(executor: SqlExecutor, id: string) {
    const result = await executor.query<Row>(
      "SELECT * FROM service_catalog_versions WHERE id=$1 FOR UPDATE",
      [id],
    );
    if (!result.rows[0]) throw new CommercialNotFoundError("Catalog version was not found.");
    return mapCatalogVersion(result.rows[0]);
  }

  private async requireActiveSyntheticCatalog(
    executor: SqlExecutor,
    lead: { readonly requestedService?: string | null; readonly opportunityName?: string | null },
    catalogVersionId?: string,
  ) {
    if (catalogVersionId) {
      const selected = await this.lockCatalogVersion(executor, catalogVersionId);
      if (!selected.synthetic) throw new ProductionCatalogNotConfiguredError();
      if (selected.status !== "active") {
        throw new CommercialValidationError(
          "Ordinary proposal creation requires an active synthetic catalog.",
        );
      }
      parseUnknownCatalog(selected.packagePayload);
      return selected;
    }
    const contextKey = catalogContextKeyForLead(lead);
    const catalogs = await this.repository.listActiveSyntheticCatalogs(executor);
    const matching = contextKey
      ? catalogs.filter((item) => item.serviceContextKey === contextKey)
      : catalogs;
    if (matching.length === 0) {
      throw new CommercialValidationError("No active synthetic catalog is configured.");
    }
    if (matching.length > 1 && !contextKey) {
      throw new CommercialValidationError(
        "Select an explicit catalog when multiple active service contexts exist.",
      );
    }
    const chosen = matching[0]!;
    return this.lockCatalogVersion(executor, chosen.id);
  }

  private async nextProposalReference(executor: SqlExecutor): Promise<string> {
    const result = await executor.query<{ value: string | number }>(
      "SELECT nextval('bea_proposal_reference_seq') AS value",
    );
    return formatProposalReference(Number(result.rows[0]?.value ?? 0));
  }

  private async replaceCatalogItems(
    executor: SqlExecutor,
    catalogVersionId: string,
    pack: ServiceCatalogPackage,
    now: string,
  ): Promise<void> {
    await executor.query("DELETE FROM service_catalog_items WHERE catalog_version_id=$1", [
      catalogVersionId,
    ]);
    for (const item of pack.items) {
      await executor.query(
        `INSERT INTO service_catalog_items
         (id,catalog_version_id,service_key,service_code,display_name,description,scope_template,
          default_deliverables,default_assumptions,default_exclusions,unit_of_measure,pricing_model,
          default_rate_minor,minimum_quantity_scaled,maximum_quantity_scaled,eligibility_notes,
          required_lead_information,options,effective_from,effective_to,active,display_order,synthetic,
          created_at,updated_at,version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19,$20,$21,$22,$23,$24,$24,1)`,
        [
          randomUUID(),
          catalogVersionId,
          item.serviceKey,
          item.serviceCode,
          item.displayName,
          item.description,
          item.scopeTemplate,
          JSON.stringify(item.defaultDeliverables),
          JSON.stringify(item.defaultAssumptions),
          JSON.stringify(item.defaultExclusions),
          item.unitOfMeasure,
          item.pricingModel,
          item.defaultRateMinor,
          item.minimumQuantityScaled,
          item.maximumQuantityScaled,
          item.eligibilityNotes,
          JSON.stringify(item.requiredLeadInformation),
          JSON.stringify(item.options),
          item.effectiveFrom,
          item.effectiveTo,
          item.active,
          item.displayOrder,
          item.synthetic,
          now,
        ],
      );
    }
    for (const [kind, payload] of [
      ["terms", pack.terms],
      ["approval", pack.approval],
      ["proposal_template", pack.template],
      ["delivery", pack.delivery],
    ] as const) {
      await executor.query(
        `INSERT INTO commercial_policy_versions
         (id,catalog_version_id,policy_kind,payload,checksum,synthetic,created_at,updated_at,version)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$7,1)
         ON CONFLICT (catalog_version_id, policy_kind) DO UPDATE
           SET payload=EXCLUDED.payload, checksum=EXCLUDED.checksum, updated_at=EXCLUDED.updated_at`,
        [
          randomUUID(),
          catalogVersionId,
          kind,
          JSON.stringify(payload),
          hashJson(payload as unknown as JsonObject),
          pack.synthetic,
          now,
        ],
      );
    }
  }

  private async replaceDraftLines(
    executor: SqlExecutor,
    proposalId: string,
    pack: ServiceCatalogPackage,
    catalog: ServiceCatalogVersion,
    lines: readonly { readonly serviceKey: string; readonly quantityScaled: number }[],
    now: string,
  ): Promise<void> {
    await executor.query(
      "DELETE FROM proposal_line_items WHERE proposal_id=$1 AND proposal_version_id IS NULL",
      [proposalId],
    );
    const itemByKey = new Map(pack.items.map((item) => [item.serviceKey, item]));
    let order = 10;
    for (const line of lines) {
      const item = itemByKey.get(line.serviceKey);
      if (!item?.active) {
        throw new CommercialValidationError(`Unknown or inactive service ${line.serviceKey}.`);
      }
      if (
        line.quantityScaled < item.minimumQuantityScaled ||
        line.quantityScaled > item.maximumQuantityScaled
      ) {
        throw new CommercialValidationError(
          `${item.displayName} quantity is outside catalog bounds.`,
        );
      }
      const draft: ProposalLineDraft = {
        lineKey: item.serviceKey,
        serviceKey: item.serviceKey,
        serviceCode: item.serviceCode,
        displayName: item.displayName,
        pricingModel: item.pricingModel,
        unitOfMeasure: item.unitOfMeasure,
        currency: catalog.currency,
        catalogUnitAmountMinor: item.defaultRateMinor,
        unitAmountMinor: item.defaultRateMinor,
        quantityScaled: line.quantityScaled,
        lineSubtotalMinor: 0,
        calculationMethod: item.pricingModel,
        scopeText: item.scopeTemplate,
        deliverables: item.defaultDeliverables,
        assumptions: item.defaultAssumptions,
        exclusions: item.defaultExclusions,
        overrideId: null,
        displayOrder: order,
      };
      const priced = calculatePricingSnapshot({
        catalog: pack,
        catalogVersionId: catalog.id,
        catalogVersionNumber: catalog.versionNumber,
        lines: [draft],
      }).lines[0];
      if (!priced) throw new CommercialValidationError("Line pricing failed.");
      await executor.query(
        `INSERT INTO proposal_line_items
         (id,proposal_id,line_key,service_key,service_code,display_name,pricing_model,unit_of_measure,currency,
          catalog_unit_amount_minor,unit_amount_minor,quantity_scaled,line_subtotal_minor,calculation_method,
          scope_text,deliverables,assumptions,exclusions,override_id,display_order,created_at,updated_at,version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18::jsonb,NULL,$19,$20,$20,1)`,
        [
          randomUUID(),
          proposalId,
          priced.lineKey,
          priced.serviceKey,
          priced.serviceCode,
          priced.displayName,
          priced.pricingModel,
          priced.unitOfMeasure,
          priced.currency,
          priced.catalogUnitAmountMinor,
          priced.unitAmountMinor,
          priced.quantityScaled,
          priced.lineSubtotalMinor,
          priced.calculationMethod,
          priced.scopeText,
          JSON.stringify(priced.deliverables),
          JSON.stringify(priced.assumptions),
          JSON.stringify(priced.exclusions),
          priced.displayOrder,
          now,
        ],
      );
      order += 10;
    }
  }

  private async persistPricedDraftLines(
    executor: SqlExecutor,
    proposalId: string,
    lines: readonly ProposalLineDraft[],
    now: string,
  ): Promise<void> {
    for (const line of lines) {
      await executor.query(
        `UPDATE proposal_line_items
            SET unit_amount_minor=$2, override_id=$3, line_subtotal_minor=$4, updated_at=$5, version=version+1
          WHERE proposal_id=$1 AND proposal_version_id IS NULL AND line_key=$6`,
        [
          proposalId,
          line.unitAmountMinor,
          line.overrideId,
          line.lineSubtotalMinor,
          now,
          line.lineKey,
        ],
      );
    }
  }

  private applyApprovedOverrides(
    lines: readonly ProposalLineDraft[],
    overrides: readonly ReturnType<typeof mapOverride>[],
    targetVersion: number,
  ): ProposalLineDraft[] {
    const approved = new Map(
      overrides
        .filter((item) => item.status === "approved" && item.targetVersionNumber === targetVersion)
        .map((item) => [item.lineKey, item]),
    );
    return lines.map((line) => {
      const override = approved.get(line.lineKey);
      if (!override)
        return { ...line, unitAmountMinor: line.catalogUnitAmountMinor, overrideId: null };
      return { ...line, unitAmountMinor: override.proposedAmountMinor, overrideId: override.id };
    });
  }

  private async proposalContext(proposal: Proposal, executor: SqlExecutor = this.database) {
    const catalog = await this.repository.getCatalogVersion(proposal.catalogVersionId, executor);
    if (!catalog) throw new CommercialNotFoundError("Catalog version was not found.");
    const pack = parseUnknownCatalog(catalog.packagePayload);
    const record = await this.repository.getProposal(proposal.id, executor);
    const target = targetVersionNumber(proposal);
    const scopedOverrides = (record?.overrides ?? []).filter(
      (item) => item.targetVersionNumber === target,
    );
    const lines = this.applyApprovedOverrides(record?.lines ?? [], scopedOverrides, target);
    const snapshot = record?.proposal.leadSnapshot ?? proposal.leadSnapshot;
    if (!snapshot) throw new CommercialValidationError("Proposal lead snapshot is missing.");
    const leadStatusRow = await executor.query<{ status: string }>(
      "SELECT status FROM leads WHERE id=$1",
      [proposal.leadId],
    );
    const leadStatus = String(leadStatusRow.rows[0]?.status ?? "") as LeadStatus;
    const pricing = calculatePricingSnapshot({
      catalog: pack,
      catalogVersionId: catalog.id,
      catalogVersionNumber: catalog.versionNumber,
      lines,
    });
    const readiness = evaluateProposalReadiness({
      leadStatus,
      leadReadyForProposal: leadStatus === "ready_for_proposal",
      snapshot,
      catalog: pack,
      catalogStatus: catalog.status,
      lines,
      pricing,
      scopeText: proposal.scopeText,
      assignedReviewerUserId: proposal.assignedReviewerUserId,
      overrides: scopedOverrides,
    });
    return { catalog, pack, lines, snapshot, pricing, readiness };
  }

  private documentFrom(
    proposal: Proposal,
    context: Awaited<ReturnType<CommercialWorkflowService["proposalContext"]>>,
    versionNumber: number,
    previewKind: ProposalDocument["previewKind"],
    preparedAt: string,
  ): ProposalDocument {
    return buildProposalDocument({
      proposal,
      versionNumber,
      previewKind,
      catalog: context.pack,
      catalogVersionNumber: context.catalog.versionNumber,
      snapshot: context.snapshot,
      pricing: context.pricing,
      scopeText: proposal.scopeText,
      deliverables: proposal.deliverables,
      assumptions: proposal.assumptions,
      exclusions: proposal.exclusions,
      scheduleText: proposal.scheduleText,
      preparedAt,
    });
  }

  private async projectionIssues(
    executor: SqlExecutor,
    current: ServiceCatalogVersion,
    pack: ServiceCatalogPackage,
  ): Promise<readonly CatalogValidationIssue[]> {
    const items = await this.repository.listCatalogItemsOn(current.id, executor);
    const policies = await this.repository.listPolicyRows(current.id, executor);
    return catalogProjectionIssues({
      pack,
      catalogKey: current.catalogKey,
      serviceContextKey: current.serviceContextKey,
      currency: current.currency,
      synthetic: current.synthetic,
      productionReady: current.productionReady,
      items,
      policies,
    });
  }

  private async assertProjectionAgrees(
    executor: SqlExecutor,
    current: ServiceCatalogVersion,
    pack: ServiceCatalogPackage,
  ): Promise<void> {
    const issues = await this.projectionIssues(executor, current, pack);
    const blocking = issues.find((item) => item.blocking);
    if (blocking) throw new CommercialValidationError(blocking.message);
  }

  private async requireEligibleReviewer(executor: SqlExecutor, userId: string): Promise<void> {
    const result = await executor.query<Row>(
      `SELECT u.id FROM users u WHERE u.id=$1 AND ${COMMERCIAL_APPROVER_ELIGIBILITY_SQL}`,
      [userId],
    );
    if (!result.rows[0]) {
      throw new CommercialValidationError(
        "Assigned reviewer must be an active Owner with proposals.approve.",
      );
    }
  }

  private async requireEligibleOverrideApprover(
    executor: SqlExecutor,
    userId: string,
  ): Promise<void> {
    const result = await executor.query<Row>(
      `SELECT u.id FROM users u WHERE u.id=$1 AND ${COMMERCIAL_OVERRIDE_APPROVER_ELIGIBILITY_SQL} FOR SHARE`,
      [userId],
    );
    if (!result.rows[0]) {
      throw new ProposalAuthorizationError(
        "Override decision requires an active Owner with proposals.override.approve.",
      );
    }
  }

  private async resolveReviewer(executor: SqlExecutor, assignedReviewerUserId?: string) {
    if (assignedReviewerUserId) {
      await this.requireEligibleReviewer(executor, assignedReviewerUserId);
      return assignedReviewerUserId;
    }
    const approvers = await this.repository.listCommercialApprovers(executor);
    if (!approvers[0]) {
      throw new CommercialValidationError("No eligible commercial reviewer is configured.");
    }
    return approvers[0].id;
  }

  private assertSafeTotal(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new MoneyArithmeticError(`${label} must remain a safe nonnegative integer.`);
    }
  }

  private async emitCommercialEvent(
    executor: SqlExecutor,
    input: {
      readonly eventType: CommercialEventType;
      readonly aggregateType: string;
      readonly aggregateId: string;
      readonly actorUserId: string;
      readonly correlationId: string;
      readonly payload: JsonObject;
      readonly summary: string;
      readonly now: string;
      readonly leadId?: string;
      readonly proposalId?: string;
      readonly proposalVersionId?: string;
      readonly catalogVersionId?: string;
      readonly overrideId?: string;
      readonly requestedRevisionVersionId?: string | null;
      readonly preparerUserId?: string;
      readonly reviewerUserId?: string;
      readonly informationCycleNumber?: number;
      readonly fromStatus?: ProposalStatus | null;
      readonly toStatus?: ProposalStatus | null;
    },
  ): Promise<void> {
    const payload: JsonObject = {
      ...input.payload,
      ...(input.informationCycleNumber !== undefined
        ? { informationCycleNumber: input.informationCycleNumber }
        : {}),
    };
    await recordAuditAndActivity(executor, {
      eventType: input.eventType,
      action: input.eventType.replaceAll(".", "-"),
      actorUserId: input.actorUserId,
      resourceType: input.aggregateType === "proposal" ? "proposal" : "service_catalog_version",
      resourceId: input.aggregateId,
      correlationId: input.correlationId,
      metadata: { ...payload, synthetic: true, disclosure: COMMERCIAL_SYNTHETIC_DISCLOSURE },
      summary: input.summary,
      now: input.now,
      proposalId: input.proposalId ?? null,
    });
    if (
      input.proposalId &&
      input.toStatus &&
      isProposalStatus(input.toStatus) &&
      input.fromStatus !== input.toStatus
    ) {
      await executor.query(
        `INSERT INTO proposal_status_events
         (id,proposal_id,proposal_version_id,from_status,to_status,event_type,actor_user_id,correlation_id,causation_id,payload,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9::jsonb,$10)`,
        [
          randomUUID(),
          input.proposalId,
          input.proposalVersionId ?? null,
          input.fromStatus ?? null,
          input.toStatus,
          input.eventType,
          input.actorUserId,
          input.correlationId,
          JSON.stringify(payload),
          input.now,
        ],
      );
    }
    if (input.eventType.startsWith("catalog.")) return;
    await insertAutomationEvent(executor, {
      eventType: input.eventType as OperationsEventType,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      correlationId: input.correlationId,
      actorType: "user",
      actorId: input.actorUserId,
      payload: {
        ...payload,
        proposalId: input.proposalId ?? null,
        leadId: input.leadId ?? null,
        catalogVersionId: input.catalogVersionId ?? null,
        proposalVersionId: input.proposalVersionId ?? null,
        overrideId: input.overrideId ?? null,
        requestedRevisionVersionId: input.requestedRevisionVersionId ?? null,
        preparerUserId: input.preparerUserId ?? null,
        reviewerUserId: input.reviewerUserId ?? null,
        informationCycleNumber: input.informationCycleNumber ?? null,
      },
      occurredAt: input.now,
    });
  }
}
