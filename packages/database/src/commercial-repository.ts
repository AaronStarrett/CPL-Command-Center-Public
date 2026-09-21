import {
  COMMERCIAL_SYNTHETIC_DISCLOSURE,
  isProposalStatus,
  parseCatalogPackage,
  tryParseCatalogPackage,
  type CatalogVersionStatus,
  type CommercialTermsPolicy,
  type Proposal,
  type ProposalDeliveryManifest,
  type ProposalLeadSnapshot,
  type ProposalLineDraft,
  type ProposalPricingOverride,
  type ProposalPricingSnapshot,
  type ProposalReadinessResult,
  type ProposalStatus,
  type ProposalVersion,
  type ProposalVersionStatus,
  type ServiceCatalog,
  type ServiceCatalogItemDefinition,
  type ServiceCatalogPackage,
  type ServiceCatalogVersion,
} from "@bea/domain";
import type { DatabaseAdapter, SqlExecutor } from "./adapter.js";
import { iso, jsonValue, nullableIso, nullableString } from "./operations-repository.js";

type Row = Record<string, unknown>;

function bool(value: unknown): boolean {
  return value === true || value === "t" || value === 1 || value === "1";
}

function commercialTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return iso(value);
}

function commercialTimestampOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : commercialTimestamp(value);
}

function parseLeadSnapshot(value: unknown): ProposalLeadSnapshot | null {
  const snapshot = jsonValue<ProposalLeadSnapshot>(value, {
    leadId: "",
    leadReference: "",
    leadStatus: "new",
    opportunityName: "",
    requestSummary: "",
    requestedService: null,
    siteName: null,
    siteAddressLine1: null,
    siteAddressLine2: null,
    siteCity: null,
    siteRegion: null,
    sitePostalCode: null,
    siteCountry: null,
    desiredDeadlineAt: null,
    requestedVisitAt: null,
    parties: [],
  });
  return snapshot.leadId ? snapshot : null;
}

export function mapServiceCatalog(row: Row): ServiceCatalog {
  return {
    id: String(row.id),
    catalogKey: String(row.catalog_key),
    displayName: String(row.display_name),
    serviceContextKey: String(row.service_context_key),
    synthetic: bool(row.synthetic),
    productionReady: bool(row.production_ready),
    disclosure: String(row.disclosure),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

export function mapCatalogVersion(row: Row): ServiceCatalogVersion {
  return {
    id: String(row.id),
    catalogId: String(row.catalog_id),
    catalogKey: String(row.catalog_key),
    versionNumber: Number(row.version_number),
    status: row.status as CatalogVersionStatus,
    synthetic: bool(row.synthetic),
    productionReady: bool(row.production_ready),
    serviceContextKey: String(row.service_context_key),
    currency: String(row.currency),
    effectiveFrom: iso(row.effective_from),
    disclosure: String(row.disclosure),
    checksum: nullableString(row.checksum),
    validatedIdentityChecksum: nullableString(row.validated_identity_checksum),
    packagePayload: jsonValue(row.package_payload, {}),
    createdByUserId: String(row.created_by_user_id),
    validatedAt: nullableIso(row.validated_at),
    validatedByUserId: nullableString(row.validated_by_user_id),
    publishedAt: nullableIso(row.published_at),
    publishedByUserId: nullableString(row.published_by_user_id),
    activatedAt: nullableIso(row.activated_at),
    activatedByUserId: nullableString(row.activated_by_user_id),
    archivedAt: nullableIso(row.archived_at),
    parentVersionId: nullableString(row.parent_version_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

export function mapProposal(row: Row): Proposal {
  return {
    id: String(row.id),
    reference: String(row.reference),
    leadId: String(row.lead_id),
    status: row.status as ProposalStatus,
    currentVersionNumber: Number(row.current_version_number),
    assignedPreparerUserId: nullableString(row.assigned_preparer_user_id),
    assignedReviewerUserId: nullableString(row.assigned_reviewer_user_id),
    catalogVersionId: String(row.catalog_version_id),
    commercialPolicyVersionId: nullableString(row.commercial_policy_version_id),
    opportunityName: String(row.opportunity_name),
    currency: String(row.currency),
    subtotalMinor: Number(row.subtotal_minor),
    totalMinor: Number(row.total_minor),
    synthetic: bool(row.synthetic),
    informationCycleNumber: Number(row.information_cycle_number ?? 0),
    correlationId: String(row.correlation_id),
    causationId: nullableString(row.causation_id),
    createdByUserId: String(row.created_by_user_id),
    submittedAt: nullableIso(row.submitted_at),
    reviewedAt: nullableIso(row.reviewed_at),
    approvedAt: nullableIso(row.approved_at),
    cancelledAt: nullableIso(row.cancelled_at),
    scopeText: String(row.scope_text ?? ""),
    deliverables: jsonValue(row.deliverables, []),
    assumptions: jsonValue(row.assumptions, []),
    exclusions: jsonValue(row.exclusions, []),
    scheduleText: nullableString(row.schedule_text),
    leadSnapshot: parseLeadSnapshot(row.lead_snapshot),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

export function mapProposalVersion(row: Row): ProposalVersion {
  return {
    id: String(row.id),
    proposalId: String(row.proposal_id),
    versionNumber: Number(row.version_number),
    status: row.status as ProposalVersionStatus,
    leadSnapshot: jsonValue(row.lead_snapshot, {
      leadId: "",
      leadReference: "",
      leadStatus: "new",
      opportunityName: "",
      requestSummary: "",
      requestedService: null,
      siteName: null,
      siteAddressLine1: null,
      siteAddressLine2: null,
      siteCity: null,
      siteRegion: null,
      sitePostalCode: null,
      siteCountry: null,
      desiredDeadlineAt: null,
      requestedVisitAt: null,
      parties: [],
    } satisfies ProposalLeadSnapshot),
    partySnapshot: jsonValue(row.party_snapshot, []),
    catalogVersionId: String(row.catalog_version_id),
    lineItemSnapshot: jsonValue(row.line_item_snapshot, []),
    scopeText: String(row.scope_text ?? ""),
    deliverables: jsonValue(row.deliverables, []),
    assumptions: jsonValue(row.assumptions, []),
    exclusions: jsonValue(row.exclusions, []),
    scheduleText: nullableString(row.schedule_text),
    termsSnapshot: jsonValue(row.terms_snapshot, {
      templateKey: "unconfigured",
      validityDays: null,
      termsText: COMMERCIAL_SYNTHETIC_DISCLOSURE,
      acceptanceLanguage: COMMERCIAL_SYNTHETIC_DISCLOSURE,
      taxConfigured: false,
      taxBps: 0,
      discountConfigured: false,
      selfApprovalAllowed: false,
      productionConfirmed: false,
      disclosure: COMMERCIAL_SYNTHETIC_DISCLOSURE,
    } satisfies CommercialTermsPolicy),
    pricingSnapshot: jsonValue(row.pricing_snapshot, {
      catalogVersionId: "",
      catalogKey: "",
      catalogVersionNumber: 0,
      currency: "USD",
      roundingPolicy: "half_away_from_zero",
      quantityScale: 10_000,
      lines: [],
      subtotalMinor: 0,
      discountMinor: 0,
      allowanceMinor: 0,
      reimbursableMinor: 0,
      taxMinor: 0,
      taxConfigured: false,
      totalMinor: 0,
      overrideIds: [],
    } satisfies ProposalPricingSnapshot),
    totalMinor: Number(row.total_minor),
    currency: String(row.currency),
    readiness: jsonValue(row.readiness, {
      readyForReview: false,
      readyForApproval: false,
      blocking: [],
      warnings: [],
      items: [],
    } satisfies ProposalReadinessResult),
    reviewerUserId: nullableString(row.reviewer_user_id),
    reviewDecision: nullableString(row.review_decision) as ProposalVersion["reviewDecision"],
    approvalEvidence: jsonValue(row.approval_evidence, null),
    documentSnapshot: jsonValue(row.document_snapshot, {}),
    renderedChecksum: nullableString(row.rendered_checksum),
    fileName: nullableString(row.file_name),
    supersededAt: nullableIso(row.superseded_at),
    frozenAt: nullableIso(row.frozen_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

export function mapOverride(row: Row): ProposalPricingOverride {
  return {
    id: String(row.id),
    proposalId: String(row.proposal_id),
    proposalVersionId: nullableString(row.proposal_version_id),
    targetVersionNumber: Number(row.target_version_number ?? 1),
    draftCycleNumber: Number(row.draft_cycle_number ?? 1),
    lineKey: String(row.line_key),
    originalAmountMinor: Number(row.original_amount_minor),
    proposedAmountMinor: Number(row.proposed_amount_minor),
    differenceMinor: Number(row.difference_minor),
    reason: String(row.reason),
    status: row.status as ProposalPricingOverride["status"],
    requestedByUserId: String(row.requested_by_user_id),
    approvedByUserId: nullableString(row.approved_by_user_id),
    approvedAt: nullableIso(row.approved_at),
    synthetic: true,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

export function mapManifest(row: Row): ProposalDeliveryManifest {
  return {
    id: String(row.id),
    proposalId: String(row.proposal_id),
    proposalVersionId: String(row.proposal_version_id),
    senderMailbox: String(row.sender_mailbox),
    toRecipient: String(row.to_recipient),
    ccRecipient: String(row.cc_recipient),
    subject: String(row.subject),
    body: String(row.body),
    proposalReference: String(row.proposal_reference),
    proposalVersionNumber: Number(row.proposal_version_number),
    attachmentFileName: String(row.attachment_file_name),
    attachmentChecksum: String(row.attachment_checksum),
    intendedAuthorization: String(row.intended_authorization),
    connectorScopes: jsonValue(row.connector_scopes, []),
    connectorReadiness: String(row.connector_readiness),
    liveWrites: false,
    disclosure: String(row.disclosure) as ProposalDeliveryManifest["disclosure"],
    synthetic: true,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

export function mapDraftLine(row: Row): ProposalLineDraft {
  return {
    lineKey: String(row.line_key),
    serviceKey: String(row.service_key),
    serviceCode: String(row.service_code),
    displayName: String(row.display_name),
    pricingModel: row.pricing_model as ProposalLineDraft["pricingModel"],
    unitOfMeasure: String(row.unit_of_measure),
    currency: String(row.currency),
    catalogUnitAmountMinor: Number(row.catalog_unit_amount_minor),
    unitAmountMinor: Number(row.unit_amount_minor),
    quantityScaled: Number(row.quantity_scaled),
    lineSubtotalMinor: Number(row.line_subtotal_minor),
    calculationMethod: String(row.calculation_method),
    scopeText: String(row.scope_text ?? ""),
    deliverables: jsonValue(row.deliverables, []),
    assumptions: jsonValue(row.assumptions, []),
    exclusions: jsonValue(row.exclusions, []),
    overrideId: nullableString(row.override_id),
    displayOrder: Number(row.display_order),
  };
}

export function parseCatalogPackageOrNull(payload: unknown): ServiceCatalogPackage | null {
  const parsed = tryParseCatalogPackage(payload);
  return parsed.ok ? parsed.value : null;
}

export { parseCatalogPackage, tryParseCatalogPackage };

export interface ProposalRecord {
  readonly proposal: Proposal;
  readonly versions: readonly ProposalVersion[];
  readonly lines: readonly ProposalLineDraft[];
  readonly overrides: readonly ProposalPricingOverride[];
  readonly manifests: readonly ProposalDeliveryManifest[];
  readonly catalogVersion: ServiceCatalogVersion | null;
  readonly catalogPackage: ServiceCatalogPackage | null;
}

export interface ProposalListFilters {
  readonly status?: ProposalStatus;
  readonly search?: string;
  readonly assignedPreparerUserId?: string;
  readonly assignedReviewerUserId?: string;
  readonly leadId?: string;
}

export class SqlCommercialRepository {
  constructor(private readonly database: DatabaseAdapter) {}

  async listCatalogs(): Promise<readonly ServiceCatalog[]> {
    const result = await this.database.query<Row>(
      "SELECT * FROM service_catalogs ORDER BY catalog_key",
    );
    return result.rows.map(mapServiceCatalog);
  }

  async listCatalogVersions(catalogId?: string): Promise<readonly ServiceCatalogVersion[]> {
    const result = catalogId
      ? await this.database.query<Row>(
          "SELECT * FROM service_catalog_versions WHERE catalog_id=$1 ORDER BY version_number",
          [catalogId],
        )
      : await this.database.query<Row>(
          "SELECT * FROM service_catalog_versions ORDER BY catalog_key, version_number",
        );
    return result.rows.map(mapCatalogVersion);
  }

  async getCatalogVersion(
    id: string,
    executor: SqlExecutor = this.database,
  ): Promise<ServiceCatalogVersion | null> {
    const result = await executor.query<Row>("SELECT * FROM service_catalog_versions WHERE id=$1", [
      id,
    ]);
    return result.rows[0] ? mapCatalogVersion(result.rows[0]) : null;
  }

  async getActiveCatalogVersion(serviceContextKey: string): Promise<ServiceCatalogVersion | null> {
    const result = await this.database.query<Row>(
      "SELECT * FROM service_catalog_versions WHERE service_context_key=$1 AND status='active' LIMIT 1",
      [serviceContextKey],
    );
    return result.rows[0] ? mapCatalogVersion(result.rows[0]) : null;
  }

  async listCatalogItems(
    catalogVersionId: string,
  ): Promise<readonly ServiceCatalogItemDefinition[]> {
    const result = await this.database.query<Row>(
      "SELECT * FROM service_catalog_items WHERE catalog_version_id=$1 ORDER BY display_order, service_key",
      [catalogVersionId],
    );
    return result.rows.map((row) => ({
      serviceKey: String(row.service_key),
      serviceCode: String(row.service_code),
      displayName: String(row.display_name),
      description: String(row.description),
      scopeTemplate: String(row.scope_template),
      defaultDeliverables: jsonValue(row.default_deliverables, []),
      defaultAssumptions: jsonValue(row.default_assumptions, []),
      defaultExclusions: jsonValue(row.default_exclusions, []),
      unitOfMeasure: String(row.unit_of_measure),
      pricingModel: row.pricing_model as ServiceCatalogItemDefinition["pricingModel"],
      defaultRateMinor: Number(row.default_rate_minor),
      minimumQuantityScaled: Number(row.minimum_quantity_scaled),
      maximumQuantityScaled: Number(row.maximum_quantity_scaled),
      eligibilityNotes: String(row.eligibility_notes ?? ""),
      requiredLeadInformation: jsonValue(row.required_lead_information, []),
      options: jsonValue(row.options, []),
      effectiveFrom: commercialTimestamp(row.effective_from),
      effectiveTo: commercialTimestampOrNull(row.effective_to),
      active: bool(row.active),
      displayOrder: Number(row.display_order),
      synthetic: bool(row.synthetic),
    }));
  }

  async listCatalogItemsOn(
    catalogVersionId: string,
    executor: SqlExecutor = this.database,
  ): Promise<readonly ServiceCatalogItemDefinition[]> {
    const result = await executor.query<Row>(
      "SELECT * FROM service_catalog_items WHERE catalog_version_id=$1 ORDER BY display_order, service_key",
      [catalogVersionId],
    );
    return result.rows.map((row) => ({
      serviceKey: String(row.service_key),
      serviceCode: String(row.service_code),
      displayName: String(row.display_name),
      description: String(row.description),
      scopeTemplate: String(row.scope_template),
      defaultDeliverables: jsonValue(row.default_deliverables, []),
      defaultAssumptions: jsonValue(row.default_assumptions, []),
      defaultExclusions: jsonValue(row.default_exclusions, []),
      unitOfMeasure: String(row.unit_of_measure),
      pricingModel: row.pricing_model as ServiceCatalogItemDefinition["pricingModel"],
      defaultRateMinor: Number(row.default_rate_minor),
      minimumQuantityScaled: Number(row.minimum_quantity_scaled),
      maximumQuantityScaled: Number(row.maximum_quantity_scaled),
      eligibilityNotes: String(row.eligibility_notes ?? ""),
      requiredLeadInformation: jsonValue(row.required_lead_information, []),
      options: jsonValue(row.options, []),
      effectiveFrom: commercialTimestamp(row.effective_from),
      effectiveTo: commercialTimestampOrNull(row.effective_to),
      active: bool(row.active),
      displayOrder: Number(row.display_order),
      synthetic: bool(row.synthetic),
    }));
  }

  async listPolicyRows(
    catalogVersionId: string,
    executor: SqlExecutor = this.database,
  ): Promise<
    readonly {
      readonly policyKind: "terms" | "approval" | "proposal_template" | "delivery";
      readonly payload: unknown;
      readonly synthetic: boolean;
    }[]
  > {
    const result = await executor.query<Row>(
      "SELECT policy_kind, payload, synthetic FROM commercial_policy_versions WHERE catalog_version_id=$1",
      [catalogVersionId],
    );
    return result.rows.map((row) => ({
      policyKind: row.policy_kind as "terms" | "approval" | "proposal_template" | "delivery",
      payload: jsonValue(row.payload, {}),
      synthetic: bool(row.synthetic),
    }));
  }

  async listCommercialApprovers(
    executor: SqlExecutor = this.database,
  ): Promise<readonly { readonly id: string; readonly displayName: string }[]> {
    const result = await executor.query<Row>(
      `SELECT u.id::text AS id, u.display_name
         FROM users u
        WHERE u.status='active' AND u.archived_at IS NULL AND EXISTS (
          SELECT 1
            FROM user_roles ur
            JOIN roles r ON r.id = ur.role_id AND r.status='active'
            JOIN role_permissions rp ON rp.role_id = ur.role_id
            JOIN permissions p ON p.id = rp.permission_id
           WHERE ur.user_id = u.id AND p.key='proposals.approve' AND r.key='owner-admin'
        )
        ORDER BY u.display_name, u.id::text`,
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      displayName: String(row.display_name),
    }));
  }

  async listActiveSyntheticCatalogs(
    executor: SqlExecutor = this.database,
  ): Promise<readonly ServiceCatalogVersion[]> {
    const result = await executor.query<Row>(
      `SELECT * FROM service_catalog_versions
        WHERE status='active' AND synthetic=TRUE
        ORDER BY service_context_key, version_number`,
    );
    return result.rows.map(mapCatalogVersion);
  }

  async listProposals(filters: ProposalListFilters = {}): Promise<readonly Proposal[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filters.status && isProposalStatus(filters.status)) {
      params.push(filters.status);
      clauses.push(`status=$${params.length}`);
    }
    if (filters.assignedPreparerUserId) {
      params.push(filters.assignedPreparerUserId);
      clauses.push(`assigned_preparer_user_id=$${params.length}`);
    }
    if (filters.assignedReviewerUserId) {
      params.push(filters.assignedReviewerUserId);
      clauses.push(`assigned_reviewer_user_id=$${params.length}`);
    }
    if (filters.leadId) {
      params.push(filters.leadId);
      clauses.push(`lead_id=$${params.length}`);
    }
    if (filters.search?.trim()) {
      params.push(`%${filters.search.trim()}%`);
      clauses.push(
        `(reference ILIKE $${params.length} OR opportunity_name ILIKE $${params.length} OR currency ILIKE $${params.length})`,
      );
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await this.database.query<Row>(
      `SELECT * FROM proposals ${where} ORDER BY updated_at DESC, reference`,
      params,
    );
    return result.rows.map(mapProposal);
  }

  async getProposal(
    id: string,
    executor: SqlExecutor = this.database,
  ): Promise<ProposalRecord | null> {
    const result = await executor.query<Row>("SELECT * FROM proposals WHERE id=$1", [id]);
    if (!result.rows[0]) return null;
    const proposal = mapProposal(result.rows[0]);
    const versions = await executor.query<Row>(
      "SELECT * FROM proposal_versions WHERE proposal_id=$1 ORDER BY version_number",
      [id],
    );
    const lines = await executor.query<Row>(
      "SELECT * FROM proposal_line_items WHERE proposal_id=$1 AND proposal_version_id IS NULL ORDER BY display_order",
      [id],
    );
    const overrides = await executor.query<Row>(
      "SELECT * FROM proposal_pricing_overrides WHERE proposal_id=$1 ORDER BY created_at",
      [id],
    );
    const manifests = await executor.query<Row>(
      "SELECT * FROM proposal_delivery_manifests WHERE proposal_id=$1 ORDER BY created_at",
      [id],
    );
    const catalogVersion = await this.getCatalogVersion(proposal.catalogVersionId, executor);
    return {
      proposal,
      versions: versions.rows.map(mapProposalVersion),
      lines: lines.rows.map(mapDraftLine),
      overrides: overrides.rows.map(mapOverride),
      manifests: manifests.rows.map(mapManifest),
      catalogVersion,
      catalogPackage: catalogVersion
        ? parseCatalogPackageOrNull(catalogVersion.packagePayload)
        : null,
    };
  }

  async getProposalByLead(leadId: string): Promise<Proposal | null> {
    const result = await this.database.query<Row>(
      `SELECT * FROM proposals
        WHERE lead_id=$1 AND status NOT IN ('cancelled','superseded')
        ORDER BY created_at
        LIMIT 1`,
      [leadId],
    );
    return result.rows[0] ? mapProposal(result.rows[0]) : null;
  }

  async listProposalsForLead(leadId: string): Promise<readonly Proposal[]> {
    const result = await this.database.query<Row>(
      "SELECT * FROM proposals WHERE lead_id=$1 ORDER BY created_at",
      [leadId],
    );
    return result.rows.map(mapProposal);
  }

  async listAudit(proposalId: string): Promise<readonly Row[]> {
    const result = await this.database.query<Row>(
      `SELECT * FROM audit_logs
        WHERE resource_id=$1 AND resource_type IN ('proposal','service_catalog_version')
        ORDER BY created_at`,
      [proposalId],
    );
    return result.rows;
  }

  async listStatusEvents(proposalId: string): Promise<readonly Row[]> {
    const result = await this.database.query<Row>(
      "SELECT * FROM proposal_status_events WHERE proposal_id=$1 ORDER BY created_at",
      [proposalId],
    );
    return result.rows;
  }

  async listProposalsUsedByCatalog(
    catalogVersionId: string,
  ): Promise<readonly Pick<Proposal, "id" | "reference" | "status">[]> {
    const result = await this.database.query<Row>(
      "SELECT id, reference, status FROM proposals WHERE catalog_version_id=$1 ORDER BY reference",
      [catalogVersionId],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      reference: String(row.reference),
      status: row.status as ProposalStatus,
    }));
  }

  async metrics(): Promise<{
    readonly synthetic: true;
    readonly disclosure: string;
    readonly byStatus: Readonly<Record<string, number>>;
    readonly total: number;
    readonly readyForDelivery: number;
    readonly withUnapprovedOverrides: number;
  }> {
    const result = await this.database.query<{ status: string; n: string }>(
      "SELECT status, COUNT(*)::text AS n FROM proposals GROUP BY status",
    );
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const row of result.rows) {
      const count = Number(row.n);
      byStatus[row.status] = count;
      total += count;
    }
    const overrides = await this.database.query<{ n: string }>(
      `SELECT COUNT(DISTINCT proposal_id)::text AS n
         FROM proposal_pricing_overrides WHERE status='requested'`,
    );
    return {
      synthetic: true,
      disclosure: COMMERCIAL_SYNTHETIC_DISCLOSURE,
      byStatus,
      total,
      readyForDelivery: byStatus.ready_for_delivery ?? 0,
      withUnapprovedOverrides: Number(overrides.rows[0]?.n ?? 0),
    };
  }
}

export async function loadDraftLines(
  executor: SqlExecutor,
  proposalId: string,
): Promise<readonly ProposalLineDraft[]> {
  const result = await executor.query<Row>(
    `SELECT * FROM proposal_line_items
      WHERE proposal_id=$1 AND proposal_version_id IS NULL
      ORDER BY display_order, line_key`,
    [proposalId],
  );
  return result.rows.map(mapDraftLine);
}

export async function loadOverrides(
  executor: SqlExecutor,
  proposalId: string,
  targetVersionNumber?: number,
): Promise<readonly ProposalPricingOverride[]> {
  const result =
    targetVersionNumber === undefined
      ? await executor.query<Row>(
          "SELECT * FROM proposal_pricing_overrides WHERE proposal_id=$1 ORDER BY created_at",
          [proposalId],
        )
      : await executor.query<Row>(
          "SELECT * FROM proposal_pricing_overrides WHERE proposal_id=$1 AND target_version_number=$2 ORDER BY created_at",
          [proposalId, targetVersionNumber],
        );
  return result.rows.map(mapOverride);
}
