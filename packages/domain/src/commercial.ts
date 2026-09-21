import type { EntityId, IsoDateTime, JsonObject, JsonValue, VersionedEntity } from "./entities.js";
import type { Lead, LeadParty, LeadStatus } from "./leads.js";
import { buildIdempotencyKey } from "./operations.js";

export const COMMERCIAL_CONTRACT_VERSION = "phase-3.3a.0";
export const PROPOSAL_REFERENCE_PREFIX = "BEA-PP-";
export const COMMERCIAL_SYNTHETIC_DISCLOSURE =
  "SYNTHETIC COMMERCIAL FIXTURE — demonstration only. Not a BEA production service, price, proposal template, or confirmed commercial policy.";
export const COMMERCIAL_PRODUCTION_UNCONFIGURED =
  "BEA PRODUCTION POLICY: UNCONFIGURED. Waiting for Owner's Thursday commercial materials. Production catalog, prices, terms, taxes, discounts, and approval thresholds remain blocked.";
export const PROPOSAL_EMAIL_DRY_RUN_DISCLOSURE = "PROPOSAL EMAIL DRY-RUN — NO MESSAGE SENT";
export const PROPOSAL_ACCEPTANCE_NON_EXECUTABLE =
  "ACCEPTANCE BLOCK IS NON-EXECUTABLE. Phase 3.3A does not record client acceptance, e-signature, or a job award.";
export const DEFAULT_PROPOSAL_CURRENCY = "USD";
export const QUANTITY_SCALE = 10_000n;
export const QUANTITY_SCALE_NUMBER = 10_000;
export const MONEY_ROUNDING_POLICY = "half_away_from_zero" as const;
export const SYNTHETIC_PROPOSAL_RECIPIENT = "client.proposal@example.invalid";
export const SYNTHETIC_PROPOSAL_CC = "owner.commercial@example.invalid";
export const SYNTHETIC_PROPOSAL_SENDER = "proposals@example.invalid";

export const CATALOG_VERSION_STATUSES = [
  "draft",
  "validation_failed",
  "validated",
  "published",
  "active",
  "superseded",
  "archived",
] as const;
export type CatalogVersionStatus = (typeof CATALOG_VERSION_STATUSES)[number];

export const SERVICE_PRICING_MODELS = [
  "fixed_fee",
  "unit_rate",
  "hourly",
  "daily",
  "allowance",
  "reimbursable",
  "no_charge",
] as const;
export type ServicePricingModel = (typeof SERVICE_PRICING_MODELS)[number];

export const PROPOSAL_STATUSES = [
  "draft",
  "needs_information",
  "ready_for_review",
  "in_review",
  "revision_required",
  "approved",
  "ready_for_delivery",
  "cancelled",
  "superseded",
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const PROPOSAL_VERSION_STATUSES = [
  "mutable_draft",
  "frozen_review",
  "revision_required",
  "approved",
  "superseded",
] as const;
export type ProposalVersionStatus = (typeof PROPOSAL_VERSION_STATUSES)[number];

export const PROPOSAL_REVIEW_DECISIONS = ["approve", "request_revision"] as const;
export type ProposalReviewDecision = (typeof PROPOSAL_REVIEW_DECISIONS)[number];

export const PRICING_OVERRIDE_STATUSES = ["requested", "approved", "rejected"] as const;
export type PricingOverrideStatus = (typeof PRICING_OVERRIDE_STATUSES)[number];

export const PROPOSAL_READINESS_SEVERITIES = ["blocking", "warning"] as const;
export type ProposalReadinessSeverity = (typeof PROPOSAL_READINESS_SEVERITIES)[number];

export const PROPOSAL_READINESS_ORIGINS = [
  "synthetic_rule",
  "framework_rule",
  "awaiting_bea_confirmation",
  "production_blocker",
] as const;
export type ProposalReadinessOrigin = (typeof PROPOSAL_READINESS_ORIGINS)[number];

export const PROPOSAL_READINESS_CODES = [
  "lead_not_ready",
  "missing_client",
  "missing_contact",
  "missing_title",
  "missing_service_line",
  "invalid_quantity",
  "missing_pricing_snapshot",
  "missing_scope",
  "missing_currency",
  "missing_terms",
  "unsupported_pricing_type",
  "mixed_currencies",
  "unapproved_override",
  "invalid_override",
  "missing_reviewer",
  "catalog_not_valid",
  "production_catalog_unconfigured",
  "negative_total",
  "missing_site",
  "missing_schedule",
  "missing_property_owner",
  "missing_billing_contact",
  "assumption_unreviewed",
] as const;
export type ProposalReadinessCode = (typeof PROPOSAL_READINESS_CODES)[number];

export const COMMERCIAL_EVENT_TYPES = [
  "lead.ready_for_proposal",
  "lead.disqualified",
  "lead.needs_info",
  "proposal.created",
  "proposal.updated",
  "proposal.readiness_failed",
  "proposal.needs_information",
  "proposal.ready_for_review",
  "proposal.submitted_for_review",
  "proposal.review_started",
  "proposal.revision_requested",
  "proposal.version_created",
  "proposal.pricing_override_requested",
  "proposal.pricing_override_approved",
  "proposal.pricing_override_rejected",
  "proposal.approved",
  "proposal.ready_for_delivery",
  "proposal.delivery_manifest_created",
  "proposal.cancelled",
  "proposal.superseded",
  "catalog.draft_created",
  "catalog.validated",
  "catalog.validation_failed",
  "catalog.published",
  "catalog.activated",
  "catalog.superseded",
  "catalog.rollback",
  "catalog.archived",
] as const;
export type CommercialEventType = (typeof COMMERCIAL_EVENT_TYPES)[number];

export const CATALOG_FAMILY_KEYS = [
  "synthetic-envelope-advisory",
  "synthetic-moisture-investigation",
  "synthetic-meridian-envelope",
  "bea-production-service-catalog",
] as const;
export type CatalogFamilyKey = (typeof CATALOG_FAMILY_KEYS)[number];

export const PROPOSAL_TEMPLATE_KEYS = [
  "synthetic-proposal-letter",
  "synthetic-proposal-sectioned",
] as const;
export type ProposalTemplateKey = (typeof PROPOSAL_TEMPLATE_KEYS)[number];

export const EDITABLE_CATALOG_STATUSES: readonly CatalogVersionStatus[] = [
  "draft",
  "validation_failed",
];
export const IMMUTABLE_CATALOG_STATUSES: readonly CatalogVersionStatus[] = [
  "published",
  "active",
  "superseded",
  "archived",
];
export const ACTIVE_PROPOSAL_STATUSES: readonly ProposalStatus[] = [
  "draft",
  "needs_information",
  "ready_for_review",
  "in_review",
  "revision_required",
  "approved",
  "ready_for_delivery",
];

export const PROPOSAL_STATUS_TRANSITIONS: Readonly<
  Record<ProposalStatus, readonly ProposalStatus[]>
> = {
  draft: ["needs_information", "ready_for_review", "cancelled"],
  needs_information: ["draft", "ready_for_review", "cancelled"],
  ready_for_review: ["in_review", "needs_information", "cancelled"],
  in_review: ["approved", "revision_required", "cancelled"],
  revision_required: ["draft", "ready_for_review", "needs_information", "cancelled"],
  approved: ["ready_for_delivery", "superseded", "cancelled"],
  ready_for_delivery: ["superseded", "cancelled"],
  cancelled: [],
  superseded: [],
};

export const PROPOSAL_STATUS_LABELS: Readonly<Record<ProposalStatus, string>> = {
  draft: "Draft",
  needs_information: "Needs information",
  ready_for_review: "Ready for review",
  in_review: "In review",
  revision_required: "Revision required",
  approved: "Approved",
  ready_for_delivery: "Ready for delivery",
  cancelled: "Cancelled",
  superseded: "Superseded",
};

export class CommercialValidationError extends Error {
  readonly code = "COMMERCIAL_VALIDATION";
  constructor(message: string) {
    super(message);
    this.name = "CommercialValidationError";
  }
}

export class CommercialNotFoundError extends Error {
  readonly code = "COMMERCIAL_NOT_FOUND";
  constructor(message = "Commercial record was not found.") {
    super(message);
    this.name = "CommercialNotFoundError";
  }
}

export class CommercialConcurrencyError extends Error {
  readonly code = "COMMERCIAL_CONCURRENCY";
  constructor(message = "The commercial record changed before this command completed.") {
    super(message);
    this.name = "CommercialConcurrencyError";
  }
}

export class ProposalStatusTransitionError extends Error {
  readonly code = "PROPOSAL_TRANSITION_INVALID";
  constructor(
    readonly fromStatus: string,
    readonly toStatus: string,
  ) {
    super(`Proposal status cannot move from ${fromStatus} to ${toStatus}.`);
    this.name = "ProposalStatusTransitionError";
  }
}

export class ProposalImmutabilityError extends Error {
  readonly code = "PROPOSAL_IMMUTABLE";
  constructor(message = "Approved or frozen proposal content cannot be edited in place.") {
    super(message);
    this.name = "ProposalImmutabilityError";
  }
}

export class CatalogImmutabilityError extends Error {
  readonly code = "CATALOG_IMMUTABLE";
  constructor(message = "Published catalog versions are immutable. Create a new draft version.") {
    super(message);
    this.name = "CatalogImmutabilityError";
  }
}

export class CatalogActivationError extends Error {
  readonly code = "CATALOG_ACTIVATION_REFUSED";
  constructor(message: string) {
    super(message);
    this.name = "CatalogActivationError";
  }
}

export class ProductionCatalogNotConfiguredError extends Error {
  readonly code = "PRODUCTION_CATALOG_UNCONFIGURED";
  constructor(message = COMMERCIAL_PRODUCTION_UNCONFIGURED) {
    super(message);
    this.name = "ProductionCatalogNotConfiguredError";
  }
}

export class ProposalAuthorizationError extends Error {
  readonly code = "PROPOSAL_AUTHORIZATION";
  constructor(message = "The current role cannot perform this commercial action.") {
    super(message);
    this.name = "ProposalAuthorizationError";
  }
}

export class MoneyArithmeticError extends Error {
  readonly code = "MONEY_ARITHMETIC";
  constructor(message: string) {
    super(message);
    this.name = "MoneyArithmeticError";
  }
}

export function formatProposalReference(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new CommercialValidationError("Proposal reference sequence is invalid.");
  }
  return `${PROPOSAL_REFERENCE_PREFIX}${String(sequence).padStart(6, "0")}`;
}

export function isCatalogVersionStatus(value: unknown): value is CatalogVersionStatus {
  return (CATALOG_VERSION_STATUSES as readonly string[]).includes(String(value));
}

export function isProposalStatus(value: unknown): value is ProposalStatus {
  return (PROPOSAL_STATUSES as readonly string[]).includes(String(value));
}

export function isServicePricingModel(value: unknown): value is ServicePricingModel {
  return (SERVICE_PRICING_MODELS as readonly string[]).includes(String(value));
}

export function catalogVersionIsEditable(status: CatalogVersionStatus): boolean {
  return EDITABLE_CATALOG_STATUSES.includes(status);
}

export function catalogVersionIsImmutable(status: CatalogVersionStatus): boolean {
  return IMMUTABLE_CATALOG_STATUSES.includes(status);
}

export function isActiveProposalStatus(status: ProposalStatus): boolean {
  return ACTIVE_PROPOSAL_STATUSES.includes(status);
}

export function assertProposalStatusTransition(from: ProposalStatus, to: ProposalStatus): void {
  if (from === to) {
    throw new ProposalStatusTransitionError(from, to);
  }
  if (!PROPOSAL_STATUS_TRANSITIONS[from].includes(to)) {
    throw new ProposalStatusTransitionError(from, to);
  }
}

export function assertCurrencyCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/u.test(normalized)) {
    throw new MoneyArithmeticError("Currency must be an ISO-like three-letter code.");
  }
  return normalized;
}

export function assertIntegerMinorUnits(value: unknown, label: string): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw new MoneyArithmeticError(`${label} must be an integer number of minor units.`);
    }
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?\d+$/u.test(value)) {
    return BigInt(value);
  }
  throw new MoneyArithmeticError(
    `${label} must be integer minor units, not a floating-point amount.`,
  );
}

export function assertNonNegativeMinor(value: bigint, label: string): bigint {
  if (value < 0n) {
    throw new MoneyArithmeticError(`${label} cannot be negative.`);
  }
  return value;
}

export function roundHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new MoneyArithmeticError("Rounding denominator must be positive.");
  }
  const sign = numerator < 0n ? -1n : 1n;
  const abs = numerator < 0n ? -numerator : numerator;
  const quotient = abs / denominator;
  const remainder = abs % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  return rounded * sign;
}

export function lineSubtotalMinor(unitAmountMinor: bigint, quantityScaled: bigint): bigint {
  assertNonNegativeMinor(unitAmountMinor, "Unit amount");
  if (quantityScaled < 0n) {
    throw new MoneyArithmeticError("Quantity cannot be negative.");
  }
  return roundHalfAwayFromZero(unitAmountMinor * quantityScaled, QUANTITY_SCALE);
}

export function quantityToScaled(quantity: string | number): bigint {
  const text = typeof quantity === "number" ? String(quantity) : quantity.trim();
  if (!/^\d+(\.\d{1,4})?$/u.test(text)) {
    throw new MoneyArithmeticError(
      "Quantity must be a non-negative decimal with at most 4 places.",
    );
  }
  const [whole, fraction = ""] = text.split(".");
  const scaled = BigInt(whole ?? "0") * QUANTITY_SCALE + BigInt((fraction + "0000").slice(0, 4));
  return scaled;
}

export function scaledToQuantityString(quantityScaled: bigint): string {
  const whole = quantityScaled / QUANTITY_SCALE;
  const fraction = quantityScaled % QUANTITY_SCALE;
  if (fraction === 0n) return whole.toString();
  return `${whole.toString()}.${fraction.toString().padStart(4, "0").replace(/0+$/u, "")}`;
}

export function minorToDisplay(minor: bigint, currency: string): string {
  const sign = minor < 0n ? "-" : "";
  const abs = minor < 0n ? -minor : minor;
  const whole = abs / 100n;
  const cents = abs % 100n;
  return `${sign}${assertCurrencyCode(currency)} ${whole.toString()}.${cents.toString().padStart(2, "0")}`;
}

export function toSafeIntegerNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new MoneyArithmeticError(`${label} exceeds the safe integer range.`);
  }
  return Number(value);
}

export interface ServiceCatalogItemDefinition {
  readonly serviceKey: string;
  readonly serviceCode: string;
  readonly displayName: string;
  readonly description: string;
  readonly scopeTemplate: string;
  readonly defaultDeliverables: readonly string[];
  readonly defaultAssumptions: readonly string[];
  readonly defaultExclusions: readonly string[];
  readonly unitOfMeasure: string;
  readonly pricingModel: ServicePricingModel;
  readonly defaultRateMinor: number;
  readonly minimumQuantityScaled: number;
  readonly maximumQuantityScaled: number;
  readonly eligibilityNotes: string;
  readonly requiredLeadInformation: readonly string[];
  readonly options: readonly string[];
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly active: boolean;
  readonly displayOrder: number;
  readonly synthetic: boolean;
}

export interface CommercialTermsPolicy {
  readonly templateKey: string;
  readonly validityDays: number | null;
  readonly termsText: string;
  readonly acceptanceLanguage: string;
  readonly taxConfigured: false;
  readonly taxBps: 0;
  readonly discountConfigured: false;
  readonly selfApprovalAllowed: false;
  readonly productionConfirmed: false;
  readonly disclosure: string;
}

export interface CommercialApprovalPolicy {
  readonly preparerRole: "sales";
  readonly reviewerRole: "owner-admin";
  readonly overrideApproverRole: "owner-admin";
  readonly selfApprovalAllowed: false;
  readonly overrideThresholdMinor: null;
  readonly productionConfirmed: false;
  readonly disclosure: string;
}

export interface ProposalTemplateDefinition {
  readonly templateKey: ProposalTemplateKey;
  readonly displayName: string;
  readonly rendererAdapter: "bea.deterministic-synthetic-pdf.v1";
  readonly coverTitle: string;
  readonly introText: string;
  readonly sectionOrder: readonly string[];
  readonly footerText: string;
  readonly synthetic: true;
  readonly disclosure: string;
}

export interface DeliveryManifestPolicy {
  readonly senderMailbox: string;
  readonly subjectTemplate: string;
  readonly bodyTemplate: string;
  readonly requiredScopes: readonly string[];
  readonly liveWrites: false;
  readonly disclosure: string;
}

export interface ServiceCatalogPackage {
  readonly catalogKey: CatalogFamilyKey;
  readonly displayName: string;
  readonly serviceContextKey: string;
  readonly currency: string;
  readonly synthetic: boolean;
  readonly productionReady: boolean;
  readonly disclosure: string;
  readonly items: readonly ServiceCatalogItemDefinition[];
  readonly terms: CommercialTermsPolicy;
  readonly approval: CommercialApprovalPolicy;
  readonly template: ProposalTemplateDefinition;
  readonly delivery: DeliveryManifestPolicy;
}

export interface ServiceCatalog extends VersionedEntity {
  catalogKey: string;
  displayName: string;
  serviceContextKey: string;
  synthetic: boolean;
  productionReady: boolean;
  disclosure: string;
}

export interface ServiceCatalogVersion extends VersionedEntity {
  catalogId: EntityId;
  catalogKey: string;
  versionNumber: number;
  status: CatalogVersionStatus;
  synthetic: boolean;
  productionReady: boolean;
  serviceContextKey: string;
  currency: string;
  effectiveFrom: IsoDateTime;
  disclosure: string;
  checksum: string | null;
  validatedIdentityChecksum: string | null;
  packagePayload: JsonObject;
  createdByUserId: EntityId;
  validatedAt: IsoDateTime | null;
  validatedByUserId: EntityId | null;
  publishedAt: IsoDateTime | null;
  publishedByUserId: EntityId | null;
  activatedAt: IsoDateTime | null;
  activatedByUserId: EntityId | null;
  archivedAt: IsoDateTime | null;
  parentVersionId: EntityId | null;
}

export interface CatalogValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly blocking: boolean;
  readonly path?: string;
}

export interface ProposalPartySnapshot {
  readonly role: string;
  readonly companyId: string | null;
  readonly contactId: string | null;
  readonly unmatchedCompanyName: string | null;
  readonly unmatchedContactName: string | null;
  readonly displayName: string;
}

export interface ProposalLeadSnapshot {
  readonly leadId: string;
  readonly leadReference: string;
  readonly leadStatus: LeadStatus;
  readonly opportunityName: string;
  readonly requestSummary: string;
  readonly requestedService: string | null;
  readonly siteName: string | null;
  readonly siteAddressLine1: string | null;
  readonly siteAddressLine2: string | null;
  readonly siteCity: string | null;
  readonly siteRegion: string | null;
  readonly sitePostalCode: string | null;
  readonly siteCountry: string | null;
  readonly desiredDeadlineAt: string | null;
  readonly requestedVisitAt: string | null;
  readonly parties: readonly ProposalPartySnapshot[];
}

export interface ProposalLineDraft {
  readonly lineKey: string;
  readonly serviceKey: string;
  readonly serviceCode: string;
  readonly displayName: string;
  readonly pricingModel: ServicePricingModel;
  readonly unitOfMeasure: string;
  readonly currency: string;
  readonly catalogUnitAmountMinor: number;
  readonly unitAmountMinor: number;
  readonly quantityScaled: number;
  readonly lineSubtotalMinor: number;
  readonly calculationMethod: string;
  readonly scopeText: string;
  readonly deliverables: readonly string[];
  readonly assumptions: readonly string[];
  readonly exclusions: readonly string[];
  readonly overrideId: string | null;
  readonly displayOrder: number;
}

export interface ProposalPricingSnapshot {
  readonly catalogVersionId: string;
  readonly catalogKey: string;
  readonly catalogVersionNumber: number;
  readonly currency: string;
  readonly roundingPolicy: typeof MONEY_ROUNDING_POLICY;
  readonly quantityScale: number;
  readonly lines: readonly ProposalLineDraft[];
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly allowanceMinor: number;
  readonly reimbursableMinor: number;
  readonly taxMinor: number;
  readonly taxConfigured: false;
  readonly totalMinor: number;
  readonly overrideIds: readonly string[];
}

export interface ProposalReadinessItem {
  readonly code: ProposalReadinessCode;
  readonly severity: ProposalReadinessSeverity;
  readonly origin: ProposalReadinessOrigin;
  readonly message: string;
}

export interface ProposalReadinessResult {
  readonly readyForReview: boolean;
  readonly readyForApproval: boolean;
  readonly blocking: readonly ProposalReadinessItem[];
  readonly warnings: readonly ProposalReadinessItem[];
  readonly items: readonly ProposalReadinessItem[];
}

export interface Proposal extends VersionedEntity {
  reference: string;
  leadId: EntityId;
  status: ProposalStatus;
  currentVersionNumber: number;
  assignedPreparerUserId: EntityId | null;
  assignedReviewerUserId: EntityId | null;
  catalogVersionId: EntityId;
  commercialPolicyVersionId: EntityId | null;
  opportunityName: string;
  currency: string;
  subtotalMinor: number;
  totalMinor: number;
  synthetic: boolean;
  informationCycleNumber: number;
  correlationId: string;
  causationId: string | null;
  createdByUserId: EntityId;
  submittedAt: IsoDateTime | null;
  reviewedAt: IsoDateTime | null;
  approvedAt: IsoDateTime | null;
  cancelledAt: IsoDateTime | null;
  scopeText: string;
  deliverables: readonly string[];
  assumptions: readonly string[];
  exclusions: readonly string[];
  scheduleText: string | null;
  leadSnapshot: ProposalLeadSnapshot | null;
}

export interface ProposalVersion extends VersionedEntity {
  proposalId: EntityId;
  versionNumber: number;
  status: ProposalVersionStatus;
  leadSnapshot: ProposalLeadSnapshot;
  partySnapshot: readonly ProposalPartySnapshot[];
  catalogVersionId: EntityId;
  lineItemSnapshot: readonly ProposalLineDraft[];
  scopeText: string;
  deliverables: readonly string[];
  assumptions: readonly string[];
  exclusions: readonly string[];
  scheduleText: string | null;
  termsSnapshot: CommercialTermsPolicy;
  pricingSnapshot: ProposalPricingSnapshot;
  totalMinor: number;
  currency: string;
  readiness: ProposalReadinessResult;
  reviewerUserId: EntityId | null;
  reviewDecision: ProposalReviewDecision | null;
  approvalEvidence: JsonObject | null;
  documentSnapshot: JsonObject;
  renderedChecksum: string | null;
  fileName: string | null;
  supersededAt: IsoDateTime | null;
  frozenAt: IsoDateTime | null;
}

export interface ProposalPricingOverride extends VersionedEntity {
  proposalId: EntityId;
  proposalVersionId: EntityId | null;
  targetVersionNumber: number;
  draftCycleNumber: number;
  lineKey: string;
  originalAmountMinor: number;
  proposedAmountMinor: number;
  differenceMinor: number;
  reason: string;
  status: PricingOverrideStatus;
  requestedByUserId: EntityId;
  approvedByUserId: EntityId | null;
  approvedAt: IsoDateTime | null;
  synthetic: true;
}

export interface ProposalDeliveryManifest extends VersionedEntity {
  proposalId: EntityId;
  proposalVersionId: EntityId;
  senderMailbox: string;
  toRecipient: string;
  ccRecipient: string;
  subject: string;
  body: string;
  proposalReference: string;
  proposalVersionNumber: number;
  attachmentFileName: string;
  attachmentChecksum: string;
  intendedAuthorization: string;
  connectorScopes: readonly string[];
  connectorReadiness: string;
  liveWrites: false;
  disclosure: typeof PROPOSAL_EMAIL_DRY_RUN_DISCLOSURE;
  synthetic: true;
}

export interface ProposalDocumentNode {
  readonly kind: "heading" | "paragraph" | "table" | "disclosure" | "page_break";
  readonly title?: string;
  readonly text?: string;
  readonly rows?: readonly (readonly string[])[];
}

export interface ProposalDocument {
  readonly rendererAdapter: "bea.deterministic-synthetic-pdf.v1";
  readonly templateKey: string;
  readonly proposalReference: string;
  readonly proposalVersionNumber: number;
  readonly catalogKey: string;
  readonly catalogVersionNumber: number;
  readonly currency: string;
  readonly previewKind: "mutable_draft" | "frozen_review" | "approved";
  readonly disclosure: string;
  readonly headerText: string;
  readonly footerText: string;
  readonly nodes: readonly ProposalDocumentNode[];
}

export function proposalStatusForCommercialEvent(
  eventType: CommercialEventType,
): ProposalStatus | null {
  switch (eventType) {
    case "proposal.created":
      return null;
    case "proposal.needs_information":
      return "needs_information";
    case "proposal.ready_for_review":
      return "ready_for_review";
    case "proposal.submitted_for_review":
    case "proposal.review_started":
      return "in_review";
    case "proposal.revision_requested":
      return "revision_required";
    case "proposal.approved":
      return "approved";
    case "proposal.ready_for_delivery":
      return "ready_for_delivery";
    case "proposal.cancelled":
      return "cancelled";
    case "proposal.superseded":
      return "superseded";
    default:
      return null;
  }
}

export function snapshotLeadForProposal(input: {
  readonly lead: Lead;
  readonly parties: readonly LeadParty[];
  readonly partyNames?: Readonly<Record<string, string>>;
}): ProposalLeadSnapshot {
  const parties: ProposalPartySnapshot[] = input.parties.map((party) => ({
    role: party.role,
    companyId: party.companyId,
    contactId: party.contactId,
    unmatchedCompanyName: party.unmatchedCompanyName,
    unmatchedContactName: party.unmatchedContactName,
    displayName:
      input.partyNames?.[party.role] ??
      party.unmatchedContactName ??
      party.unmatchedCompanyName ??
      party.contactId ??
      party.companyId ??
      party.role,
  }));
  return {
    leadId: input.lead.id,
    leadReference: input.lead.reference,
    leadStatus: input.lead.status,
    opportunityName: input.lead.opportunityName,
    requestSummary: input.lead.requestSummary,
    requestedService: input.lead.requestedService,
    siteName: input.lead.siteName,
    siteAddressLine1: input.lead.siteAddressLine1,
    siteAddressLine2: input.lead.siteAddressLine2,
    siteCity: input.lead.siteCity,
    siteRegion: input.lead.siteRegion,
    sitePostalCode: input.lead.sitePostalCode,
    siteCountry: input.lead.siteCountry,
    desiredDeadlineAt: input.lead.desiredDeadlineAt,
    requestedVisitAt: input.lead.requestedVisitAt,
    parties,
  };
}

export function calculatePricingSnapshot(input: {
  readonly catalog: ServiceCatalogPackage;
  readonly catalogVersionId: string;
  readonly catalogVersionNumber: number;
  readonly lines: readonly ProposalLineDraft[];
  readonly discountMinor?: number;
}): ProposalPricingSnapshot {
  const currency = assertCurrencyCode(input.catalog.currency);
  let subtotal = 0n;
  let allowance = 0n;
  let reimbursable = 0n;
  const computedLines: ProposalLineDraft[] = [];
  for (const line of input.lines) {
    if (assertCurrencyCode(line.currency) !== currency) {
      throw new MoneyArithmeticError("Mixed currencies within one proposal are prohibited.");
    }
    const unit = assertIntegerMinorUnits(line.unitAmountMinor, `${line.lineKey} unit`);
    const catalogUnit = assertIntegerMinorUnits(
      line.catalogUnitAmountMinor,
      `${line.lineKey} catalog unit`,
    );
    const quantity = assertIntegerMinorUnits(line.quantityScaled, `${line.lineKey} quantity`);
    const model = line.pricingModel;
    const subtotalMinor = model === "no_charge" ? 0n : lineSubtotalMinor(unit, quantity);
    if (model === "allowance") allowance += subtotalMinor;
    if (model === "reimbursable") reimbursable += subtotalMinor;
    if (model !== "allowance" && model !== "reimbursable") subtotal += subtotalMinor;
    computedLines.push({
      ...line,
      unitAmountMinor: toSafeIntegerNumber(unit, `${line.lineKey} unit`),
      catalogUnitAmountMinor: toSafeIntegerNumber(catalogUnit, `${line.lineKey} catalog unit`),
      quantityScaled: toSafeIntegerNumber(quantity, `${line.lineKey} quantity`),
      lineSubtotalMinor: toSafeIntegerNumber(subtotalMinor, `${line.lineKey} subtotal`),
      calculationMethod: `${model}:${MONEY_ROUNDING_POLICY}:scale-${QUANTITY_SCALE_NUMBER}`,
    });
  }
  const discount = assertIntegerMinorUnits(input.discountMinor ?? 0, "Discount");
  assertNonNegativeMinor(discount, "Discount");
  if (discount > subtotal) {
    throw new MoneyArithmeticError("Discount cannot exceed the proposal subtotal.");
  }
  const taxable = subtotal - discount + allowance + reimbursable;
  const tax = input.catalog.terms.taxConfigured
    ? roundHalfAwayFromZero(taxable * BigInt(input.catalog.terms.taxBps), 10_000n)
    : 0n;
  const total = taxable + tax;
  assertNonNegativeMinor(total, "Proposal total");
  return {
    catalogVersionId: input.catalogVersionId,
    catalogKey: input.catalog.catalogKey,
    catalogVersionNumber: input.catalogVersionNumber,
    currency,
    roundingPolicy: MONEY_ROUNDING_POLICY,
    quantityScale: QUANTITY_SCALE_NUMBER,
    lines: computedLines,
    subtotalMinor: toSafeIntegerNumber(subtotal, "Subtotal"),
    discountMinor: toSafeIntegerNumber(discount, "Discount"),
    allowanceMinor: toSafeIntegerNumber(allowance, "Allowance"),
    reimbursableMinor: toSafeIntegerNumber(reimbursable, "Reimbursable"),
    taxMinor: toSafeIntegerNumber(tax, "Tax"),
    taxConfigured: false,
    totalMinor: toSafeIntegerNumber(total, "Total"),
    overrideIds: computedLines
      .map((line) => line.overrideId)
      .filter((value): value is string => Boolean(value)),
  };
}

export function evaluateProposalReadiness(input: {
  readonly leadStatus: LeadStatus;
  readonly leadReadyForProposal: boolean;
  readonly snapshot: ProposalLeadSnapshot;
  readonly catalog: ServiceCatalogPackage | null;
  readonly catalogStatus: CatalogVersionStatus | null;
  readonly lines: readonly ProposalLineDraft[];
  readonly pricing: ProposalPricingSnapshot | null;
  readonly scopeText: string;
  readonly assignedReviewerUserId: string | null;
  readonly overrides: readonly ProposalPricingOverride[];
  readonly productionCatalogRequested?: boolean;
}): ProposalReadinessResult {
  const items: ProposalReadinessItem[] = [];
  const push = (
    code: ProposalReadinessCode,
    severity: ProposalReadinessSeverity,
    origin: ProposalReadinessOrigin,
    message: string,
  ) => {
    items.push({ code, severity, origin, message });
  };

  if (input.leadStatus !== "ready_for_proposal" || !input.leadReadyForProposal) {
    push(
      "lead_not_ready",
      "blocking",
      "framework_rule",
      "The Lead must remain ready_for_proposal before a proposal can be submitted.",
    );
  }
  const client = input.snapshot.parties.find((party) => party.role === "client_company");
  if (!client || !(client.companyId || client.unmatchedCompanyName || client.displayName.trim())) {
    push(
      "missing_client",
      "blocking",
      "framework_rule",
      "A client company or recognized client identity is required.",
    );
  }
  const contact = input.snapshot.parties.find((party) => party.role === "primary_contact");
  if (
    !contact ||
    !(contact.contactId || contact.unmatchedContactName || contact.displayName.trim())
  ) {
    push("missing_contact", "blocking", "framework_rule", "A proposal contact is required.");
  }
  if (!input.snapshot.opportunityName.trim()) {
    push(
      "missing_title",
      "blocking",
      "framework_rule",
      "A proposal title or project name is required.",
    );
  }
  if (input.lines.length === 0) {
    push(
      "missing_service_line",
      "blocking",
      "framework_rule",
      "At least one service line is required.",
    );
  }
  if (!input.scopeText.trim()) {
    push(
      "missing_scope",
      "blocking",
      "framework_rule",
      "Scope of services is required before review.",
    );
  }
  if (!input.pricing) {
    push(
      "missing_pricing_snapshot",
      "blocking",
      "framework_rule",
      "A deterministic pricing snapshot is required.",
    );
  } else {
    if (!input.pricing.currency) {
      push("missing_currency", "blocking", "framework_rule", "Proposal currency is required.");
    }
    if (input.pricing.totalMinor < 0) {
      push(
        "negative_total",
        "blocking",
        "framework_rule",
        "Negative proposal totals are prohibited.",
      );
    }
  }
  if (!input.catalog || !input.catalogStatus) {
    push(
      "catalog_not_valid",
      "blocking",
      "framework_rule",
      "An active synthetic catalog version is required.",
    );
  } else if (input.catalogStatus !== "active" && input.catalogStatus !== "published") {
    push(
      "catalog_not_valid",
      "blocking",
      "framework_rule",
      "The selected catalog version is not published or active.",
    );
  }
  if (!input.catalog?.synthetic || input.productionCatalogRequested) {
    push(
      "production_catalog_unconfigured",
      "blocking",
      "production_blocker",
      COMMERCIAL_PRODUCTION_UNCONFIGURED,
    );
  }
  if (!input.catalog?.terms.termsText.trim()) {
    push(
      "missing_terms",
      "blocking",
      "awaiting_bea_confirmation",
      "Terms configuration is missing.",
    );
  }
  if (!input.assignedReviewerUserId) {
    push(
      "missing_reviewer",
      "blocking",
      "framework_rule",
      "A commercial reviewer must be assigned before review.",
    );
  }
  const currencies = new Set(input.lines.map((line) => line.currency));
  if (currencies.size > 1) {
    push("mixed_currencies", "blocking", "framework_rule", "Mixed currencies are prohibited.");
  }
  for (const line of input.lines) {
    if (!isServicePricingModel(line.pricingModel)) {
      push(
        "unsupported_pricing_type",
        "blocking",
        "framework_rule",
        `${line.displayName} uses an unsupported pricing type.`,
      );
    }
    if (line.quantityScaled <= 0 && line.pricingModel !== "no_charge") {
      push(
        "invalid_quantity",
        "blocking",
        "framework_rule",
        `${line.displayName} quantity must be greater than zero.`,
      );
    }
  }
  const openOverrides = input.overrides.filter((item) => item.status === "requested");
  if (openOverrides.length > 0) {
    push(
      "unapproved_override",
      "blocking",
      "framework_rule",
      "Unapproved pricing overrides block commercial approval.",
    );
  }
  for (const override of input.overrides) {
    if (!override.reason.trim()) {
      push(
        "invalid_override",
        "blocking",
        "framework_rule",
        "A pricing override requires a nonempty reason.",
      );
    }
  }

  if (!input.snapshot.siteAddressLine1 && !input.snapshot.siteCity) {
    push("missing_site", "warning", "synthetic_rule", "Site address is missing.");
  }
  if (!input.snapshot.desiredDeadlineAt && !input.snapshot.requestedVisitAt) {
    push("missing_schedule", "warning", "synthetic_rule", "Requested schedule is missing.");
  }
  if (!input.snapshot.parties.some((party) => party.role === "property_owner")) {
    push(
      "missing_property_owner",
      "warning",
      "synthetic_rule",
      "Property owner is not identified.",
    );
  }
  if (!input.snapshot.parties.some((party) => party.role === "billing_contact")) {
    push(
      "missing_billing_contact",
      "warning",
      "synthetic_rule",
      "Billing contact is not identified.",
    );
  }
  if (input.lines.some((line) => line.assumptions.length === 0)) {
    push(
      "assumption_unreviewed",
      "warning",
      "synthetic_rule",
      "Optional assumptions have not been reviewed on every line.",
    );
  }

  const blocking = items.filter((item) => item.severity === "blocking");
  const warnings = items.filter((item) => item.severity === "warning");
  return {
    readyForReview: blocking.length === 0,
    readyForApproval: blocking.length === 0,
    blocking,
    warnings,
    items,
  };
}

export function nextProposalStatusForReadiness(
  current: ProposalStatus,
  readiness: ProposalReadinessResult,
): ProposalStatus {
  if (current === "draft" || current === "needs_information" || current === "revision_required") {
    return readiness.readyForReview ? "ready_for_review" : "needs_information";
  }
  if (current === "ready_for_review" && !readiness.readyForReview) {
    return "needs_information";
  }
  return current;
}

export function compareProposalVersions(
  left: ProposalVersion,
  right: ProposalVersion,
): {
  readonly changed: readonly string[];
} {
  const changed: string[] = [];
  if (left.scopeText !== right.scopeText) changed.push("scope");
  if (left.scheduleText !== right.scheduleText) changed.push("schedule");
  if (left.pricingSnapshot.totalMinor !== right.pricingSnapshot.totalMinor) changed.push("total");
  if (left.pricingSnapshot.catalogVersionId !== right.pricingSnapshot.catalogVersionId) {
    changed.push("catalog");
  }
  const leftLines = left.lineItemSnapshot.map((line) => line.lineKey).join(",");
  const rightLines = right.lineItemSnapshot.map((line) => line.lineKey).join(",");
  if (leftLines !== rightLines) changed.push("lines");
  if (JSON.stringify(left.deliverables) !== JSON.stringify(right.deliverables)) {
    changed.push("deliverables");
  }
  if (JSON.stringify(left.assumptions) !== JSON.stringify(right.assumptions)) {
    changed.push("assumptions");
  }
  if (JSON.stringify(left.exclusions) !== JSON.stringify(right.exclusions)) {
    changed.push("exclusions");
  }
  return { changed };
}

export function overrideDifferenceMinor(original: number, proposed: number): number {
  const left = assertIntegerMinorUnits(original, "Original override amount");
  const right = assertIntegerMinorUnits(proposed, "Proposed override amount");
  return toSafeIntegerNumber(right - left, "Override difference");
}

export function buildProposalDocument(input: {
  readonly proposal: Pick<Proposal, "reference" | "opportunityName" | "currency">;
  readonly versionNumber: number;
  readonly previewKind: ProposalDocument["previewKind"];
  readonly catalog: ServiceCatalogPackage;
  readonly catalogVersionNumber: number;
  readonly snapshot: ProposalLeadSnapshot;
  readonly pricing: ProposalPricingSnapshot;
  readonly scopeText: string;
  readonly deliverables: readonly string[];
  readonly assumptions: readonly string[];
  readonly exclusions: readonly string[];
  readonly scheduleText: string | null;
  readonly preparedAt: string;
  readonly revisionNotes?: readonly string[];
}): ProposalDocument {
  const template = input.catalog.template;
  const pricing = input.pricing;
  const client =
    input.snapshot.parties.find((party) => party.role === "client_company")?.displayName ??
    "Unnamed client";
  const contact =
    input.snapshot.parties.find((party) => party.role === "primary_contact")?.displayName ??
    "Unnamed contact";
  const nodes: ProposalDocumentNode[] = [
    { kind: "heading", title: template.coverTitle },
    {
      kind: "paragraph",
      text: `${input.proposal.reference} · Version ${input.versionNumber} · ${input.previewKind.replaceAll("_", " ")}`,
    },
    { kind: "paragraph", text: template.introText },
    { kind: "paragraph", text: `Prepared: ${input.preparedAt}` },
    {
      kind: "paragraph",
      text: input.catalog.terms.validityDays
        ? `Valid through: configured ${input.catalog.terms.validityDays} days (synthetic).`
        : "Valid-through date: UNCONFIGURED",
    },
    { kind: "heading", title: "Client and opportunity" },
    {
      kind: "table",
      rows: [
        ["Client", client],
        ["Contact", contact],
        ["Opportunity", input.proposal.opportunityName],
        ["Lead", input.snapshot.leadReference],
        [
          "Site",
          [input.snapshot.siteName, input.snapshot.siteAddressLine1, input.snapshot.siteCity]
            .filter(Boolean)
            .join(", ") || "Not provided",
        ],
        ["Requested service", input.snapshot.requestedService ?? "Not provided"],
      ],
    },
    { kind: "heading", title: "Scope of services" },
    { kind: "paragraph", text: input.scopeText },
    { kind: "heading", title: "Deliverables" },
    { kind: "paragraph", text: input.deliverables.join(" ") || "None recorded." },
    { kind: "heading", title: "Schedule or timing" },
    {
      kind: "paragraph",
      text:
        input.scheduleText ||
        input.snapshot.desiredDeadlineAt ||
        input.snapshot.requestedVisitAt ||
        "Timing not provided.",
    },
    { kind: "heading", title: "Line-item pricing" },
    {
      kind: "table",
      rows: [
        ["Service", "Model", "Qty", "Unit", "Line total", "Catalog unit"],
        ...pricing.lines.map((line) => [
          `${line.serviceCode} ${line.displayName}`,
          line.pricingModel,
          scaledToQuantityString(BigInt(line.quantityScaled)),
          minorToDisplay(BigInt(line.unitAmountMinor), line.currency),
          minorToDisplay(BigInt(line.lineSubtotalMinor), line.currency),
          minorToDisplay(BigInt(line.catalogUnitAmountMinor), line.currency),
        ]),
      ],
    },
    { kind: "heading", title: "Commercial totals" },
    {
      kind: "table",
      rows: [
        ["Subtotal", minorToDisplay(BigInt(pricing.subtotalMinor), pricing.currency)],
        ["Allowances", minorToDisplay(BigInt(pricing.allowanceMinor), pricing.currency)],
        ["Reimbursables", minorToDisplay(BigInt(pricing.reimbursableMinor), pricing.currency)],
        ["Discounts", minorToDisplay(BigInt(pricing.discountMinor), pricing.currency)],
        ["Tax", "UNCONFIGURED"],
        ["Total", minorToDisplay(BigInt(pricing.totalMinor), pricing.currency)],
      ],
    },
    { kind: "heading", title: "Assumptions" },
    { kind: "paragraph", text: input.assumptions.join(" ") || "None recorded." },
    { kind: "heading", title: "Exclusions" },
    { kind: "paragraph", text: input.exclusions.join(" ") || "None recorded." },
    { kind: "heading", title: "Commercial terms" },
    { kind: "paragraph", text: input.catalog.terms.termsText },
    { kind: "heading", title: "Acceptance" },
    {
      kind: "paragraph",
      text: `${input.catalog.terms.acceptanceLanguage} ${PROPOSAL_ACCEPTANCE_NON_EXECUTABLE}`,
    },
    { kind: "heading", title: "Revision history" },
    {
      kind: "paragraph",
      text:
        input.revisionNotes?.join(" ") || `Version ${input.versionNumber} is the current document.`,
    },
    { kind: "disclosure", text: COMMERCIAL_SYNTHETIC_DISCLOSURE },
    {
      kind: "paragraph",
      text: `Catalog ${input.catalog.catalogKey} v${input.catalogVersionNumber}. Template ${template.templateKey}. ${template.disclosure}`,
    },
  ];
  if (template.templateKey === "synthetic-proposal-sectioned") {
    nodes.splice(2, 0, {
      kind: "paragraph",
      text: "Sectioned synthetic layout: cover, commercial table, assumptions, and non-executable acceptance are always rendered.",
    });
  }
  return {
    rendererAdapter: "bea.deterministic-synthetic-pdf.v1",
    templateKey: template.templateKey,
    proposalReference: input.proposal.reference,
    proposalVersionNumber: input.versionNumber,
    catalogKey: input.catalog.catalogKey,
    catalogVersionNumber: input.catalogVersionNumber,
    currency: input.proposal.currency,
    previewKind: input.previewKind,
    disclosure: COMMERCIAL_SYNTHETIC_DISCLOSURE,
    headerText: `${input.proposal.reference} · ${template.coverTitle}`,
    footerText: template.footerText,
    nodes,
  };
}

export function proposalDocumentToRenderLines(document: ProposalDocument): readonly string[] {
  const lines: string[] = [
    document.headerText,
    document.disclosure,
    `Preview: ${document.previewKind}`,
    `Template: ${document.templateKey}`,
    `Catalog: ${document.catalogKey}@${document.catalogVersionNumber}`,
    `Reference: ${document.proposalReference}`,
    `Version: ${document.proposalVersionNumber}`,
  ];
  for (const node of document.nodes) {
    if (node.kind === "page_break") {
      lines.push("--- page ---");
      continue;
    }
    if (node.title) lines.push(node.title);
    if (node.text) lines.push(node.text);
    if (node.rows) {
      for (const row of node.rows) lines.push(row.filter(Boolean).join(" | "));
    }
  }
  lines.push(document.footerText);
  return lines;
}

export function buildProposalFileName(reference: string, versionNumber: number): string {
  return `${reference}-v${String(versionNumber).padStart(2, "0")}-synthetic.pdf`;
}

export function commercialIdempotencyKey(parts: readonly string[]): string {
  return buildIdempotencyKey(parts);
}

export const SEEDED_COMMERCIAL_IDS = {
  envelopeCatalog: "e1000000-0000-4000-8000-000000000001",
  moistureCatalog: "e1000000-0000-4000-8000-000000000002",
  productionCatalog: "e1000000-0000-4000-8000-000000000003",
  envelopeVersion1: "e1100000-0000-4000-8000-000000000001",
  moistureVersion1: "e1100000-0000-4000-8000-000000000002",
  productionDraft: "e1100000-0000-4000-8000-000000000003",
  happyProposal: "f1000000-0000-4000-8000-000000000001",
  infoProposal: "f1000000-0000-4000-8000-000000000002",
  happyVersion: "f1100000-0000-4000-8000-000000000001",
  infoVersionDraft: "f1100000-0000-4000-8000-000000000002",
  happyOverride: "f1200000-0000-4000-8000-000000000001",
  happyManifest: "f1300000-0000-4000-8000-000000000001",
  prepWork: "f2000000-0000-4000-8000-000000000001",
  reviewWork: "f2000000-0000-4000-8000-000000000002",
} as const;

export function jsonObjectFromUnknown(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonObject;
}

export function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
