import type { EntityId, IsoDateTime, JsonObject, VersionedEntity } from "./entities.js";

export const LEAD_SOURCE_TYPES = ["manual", "referral", "in_person"] as const;
export type LeadSourceType = (typeof LEAD_SOURCE_TYPES)[number];

export const LEAD_STATUSES = ["new", "needs_info", "ready_for_proposal", "disqualified"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_PARTY_ROLES = [
  "requester",
  "client_company",
  "primary_contact",
  "property_owner",
  "general_contractor",
  "approval_authority",
  "billing_contact",
] as const;
export type LeadPartyRole = (typeof LEAD_PARTY_ROLES)[number];

export const LEAD_READINESS_SEVERITIES = ["blocking", "optional"] as const;
export type LeadReadinessSeverity = (typeof LEAD_READINESS_SEVERITIES)[number];

export const LEAD_MISSING_INFORMATION_CODES = [
  "opportunity_name",
  "request_summary",
  "requested_service",
  "received_at",
  "source_type",
  "referral_source_details",
  "identified_client_or_contact",
  "site_location",
  "desired_deadline_or_visit",
  "reviewer_assignment",
  "requester",
  "property_owner",
  "general_contractor",
  "approval_authority",
  "billing_contact",
] as const;
export type LeadMissingInformationCode = (typeof LEAD_MISSING_INFORMATION_CODES)[number];

export const LEAD_REFERENCE_PREFIX = "BEA-LD-";

export interface LeadMissingInformationItem {
  readonly code: LeadMissingInformationCode;
  readonly severity: LeadReadinessSeverity;
  readonly message: string;
}

export interface LeadReadinessResult {
  readonly readyForProposal: boolean;
  readonly blocking: readonly LeadMissingInformationItem[];
  readonly optional: readonly LeadMissingInformationItem[];
  readonly items: readonly LeadMissingInformationItem[];
}

export interface Lead extends VersionedEntity {
  reference: string;
  sourceType: LeadSourceType;
  sourceDetails: string | null;
  receivedAt: IsoDateTime;
  opportunityName: string;
  requestSummary: string;
  requestedService: string | null;
  siteName: string | null;
  siteAddressLine1: string | null;
  siteAddressLine2: string | null;
  siteCity: string | null;
  siteRegion: string | null;
  sitePostalCode: string | null;
  siteCountry: string | null;
  desiredDeadlineAt: IsoDateTime | null;
  requestedVisitAt: IsoDateTime | null;
  reviewerUserId: EntityId | null;
  status: LeadStatus;
  disqualificationReason: string | null;
  createdByUserId: EntityId;
}

export interface LeadParty extends VersionedEntity {
  leadId: EntityId;
  role: LeadPartyRole;
  companyId: EntityId | null;
  contactId: EntityId | null;
  unmatchedCompanyName: string | null;
  unmatchedContactName: string | null;
  unmatchedEmail: string | null;
  unmatchedPhone: string | null;
  notes: string | null;
  createdByUserId: EntityId | null;
}

export interface LeadStatusEvent {
  id: EntityId;
  leadId: EntityId;
  fromStatus: LeadStatus | null;
  toStatus: LeadStatus;
  reason: string | null;
  actorUserId: EntityId | null;
  correlationId: string | null;
  metadata: JsonObject;
  createdAt: IsoDateTime;
}

export interface LeadPartyInput {
  readonly role: LeadPartyRole;
  readonly companyId?: string | null;
  readonly contactId?: string | null;
  readonly unmatchedCompanyName?: string | null;
  readonly unmatchedContactName?: string | null;
  readonly unmatchedEmail?: string | null;
  readonly unmatchedPhone?: string | null;
  readonly notes?: string | null;
}

export interface LeadIntakeSnapshot {
  readonly sourceType: LeadSourceType | null;
  readonly sourceDetails: string | null;
  readonly receivedAt: IsoDateTime | null;
  readonly opportunityName: string | null;
  readonly requestSummary: string | null;
  readonly requestedService: string | null;
  readonly siteName: string | null;
  readonly siteCity: string | null;
  readonly siteRegion: string | null;
  readonly desiredDeadlineAt: IsoDateTime | null;
  readonly requestedVisitAt: IsoDateTime | null;
  readonly reviewerUserId: EntityId | null;
  readonly parties: readonly LeadPartyInput[];
}

export const LEAD_STATUS_TRANSITIONS: Readonly<Record<LeadStatus, readonly LeadStatus[]>> = {
  new: ["needs_info", "ready_for_proposal", "disqualified"],
  needs_info: ["new", "ready_for_proposal", "disqualified"],
  ready_for_proposal: ["needs_info", "disqualified"],
  disqualified: ["new", "needs_info"],
};

export function isLeadSourceType(value: string): value is LeadSourceType {
  return (LEAD_SOURCE_TYPES as readonly string[]).includes(value);
}

export function isLeadStatus(value: string): value is LeadStatus {
  return (LEAD_STATUSES as readonly string[]).includes(value);
}

export function isLeadPartyRole(value: string): value is LeadPartyRole {
  return (LEAD_PARTY_ROLES as readonly string[]).includes(value);
}

export function formatLeadReference(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("Lead reference sequence must be a positive integer.");
  }
  return `${LEAD_REFERENCE_PREFIX}${String(sequence).padStart(6, "0")}`;
}

export function parseLeadReferenceSequence(reference: string): number | null {
  const match = new RegExp(`^${LEAD_REFERENCE_PREFIX}(\\d{6})$`, "u").exec(reference.trim());
  if (!match) return null;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) && sequence >= 1 ? sequence : null;
}

export function isLeadStatusTransitionAllowed(from: LeadStatus, to: LeadStatus): boolean {
  if (from === to) return false;
  return LEAD_STATUS_TRANSITIONS[from].includes(to);
}

export function assertLeadStatusTransition(from: LeadStatus, to: LeadStatus): void {
  if (!isLeadStatusTransitionAllowed(from, to)) {
    throw new LeadStatusTransitionError(from, to);
  }
}

export class LeadStatusTransitionError extends Error {
  readonly code = "LEAD_STATUS_TRANSITION_INVALID";

  constructor(
    readonly fromStatus: LeadStatus,
    readonly toStatus: LeadStatus,
  ) {
    super(`Lead status cannot move from ${fromStatus} to ${toStatus}.`);
    this.name = "LeadStatusTransitionError";
  }
}

export class LeadReadinessError extends Error {
  readonly code = "LEAD_NOT_READY_FOR_PROPOSAL";

  constructor(readonly missing: readonly LeadMissingInformationItem[]) {
    super("Lead is not ready for proposal review.");
    this.name = "LeadReadinessError";
  }
}

export class LeadDisqualificationReasonError extends Error {
  readonly code = "LEAD_DISQUALIFICATION_REASON_REQUIRED";

  constructor() {
    super("Disqualification requires a recorded reason.");
    this.name = "LeadDisqualificationReasonError";
  }
}

export class LeadReadyStatusInvariantError extends Error {
  readonly code = "LEAD_READY_STATUS_INVARIANT";

  constructor(readonly missing: readonly LeadMissingInformationItem[]) {
    super(
      "The lead must first be moved to needs_info by an authorized reviewer before intake changes that introduce blocking gaps can be saved.",
    );
    this.name = "LeadReadyStatusInvariantError";
  }
}

export class LeadReviewerEligibilityError extends Error {
  readonly code = "LEAD_REVIEWER_NOT_ELIGIBLE";

  constructor(
    message = "Reviewer assignment requires an active, non-archived user with the leads.review permission.",
  ) {
    super(message);
    this.name = "LeadReviewerEligibilityError";
  }
}

export function assertReadyForProposalUpdateAllowed(
  status: LeadStatus,
  readiness: LeadReadinessResult,
): void {
  if (status === "ready_for_proposal" && !readiness.readyForProposal) {
    throw new LeadReadyStatusInvariantError(readiness.blocking);
  }
}

function present(value: string | null | undefined): boolean {
  return Boolean(value?.trim());
}

function partyHasIdentity(party: LeadPartyInput | undefined): boolean {
  if (!party) return false;
  return Boolean(
    party.companyId ||
    party.contactId ||
    present(party.unmatchedCompanyName) ||
    present(party.unmatchedContactName),
  );
}

function findParty(
  parties: readonly LeadPartyInput[],
  role: LeadPartyRole,
): LeadPartyInput | undefined {
  return parties.find((party) => party.role === role);
}

function item(
  code: LeadMissingInformationCode,
  severity: LeadReadinessSeverity,
  message: string,
): LeadMissingInformationItem {
  return { code, severity, message };
}

export function evaluateLeadReadiness(snapshot: LeadIntakeSnapshot): LeadReadinessResult {
  const blocking: LeadMissingInformationItem[] = [];
  const optional: LeadMissingInformationItem[] = [];

  if (!present(snapshot.opportunityName)) {
    blocking.push(
      item("opportunity_name", "blocking", "Opportunity or project name is required for review."),
    );
  }
  if (!present(snapshot.requestSummary)) {
    blocking.push(item("request_summary", "blocking", "A request summary is required for review."));
  }
  if (!snapshot.sourceType) {
    blocking.push(item("source_type", "blocking", "Intake source type is required."));
  }
  if (!snapshot.receivedAt) {
    blocking.push(item("received_at", "blocking", "Received date and time is required."));
  }
  if (!present(snapshot.requestedService)) {
    blocking.push(
      item(
        "requested_service",
        "blocking",
        "Requested service or service description is required before proposal work.",
      ),
    );
  }
  if (snapshot.sourceType === "referral" && !present(snapshot.sourceDetails)) {
    blocking.push(
      item(
        "referral_source_details",
        "blocking",
        "Referral intake requires source details or referral notes.",
      ),
    );
  }

  const clientCompany = findParty(snapshot.parties, "client_company");
  const primaryContact = findParty(snapshot.parties, "primary_contact");
  const requester = findParty(snapshot.parties, "requester");
  if (
    !partyHasIdentity(clientCompany) &&
    !partyHasIdentity(primaryContact) &&
    !partyHasIdentity(requester)
  ) {
    blocking.push(
      item(
        "identified_client_or_contact",
        "blocking",
        "Identify at least one client company, primary contact, or requester. Canonical company/contact links are preferred when known.",
      ),
    );
  }

  if (!present(snapshot.siteName) && !present(snapshot.siteCity) && !present(snapshot.siteRegion)) {
    optional.push(
      item(
        "site_location",
        "optional",
        "Site or project location is useful for later proposal and visit planning.",
      ),
    );
  }
  if (!snapshot.desiredDeadlineAt && !snapshot.requestedVisitAt) {
    optional.push(
      item(
        "desired_deadline_or_visit",
        "optional",
        "A desired deadline or requested visit date helps later scheduling, but is not a Phase 2.0 review gate.",
      ),
    );
  }
  if (!snapshot.reviewerUserId) {
    optional.push(
      item(
        "reviewer_assignment",
        "optional",
        "Assigning a reviewer makes the sales review queue easier to work, but is not required to mark review-ready.",
      ),
    );
  }
  if (!partyHasIdentity(requester)) {
    optional.push(
      item("requester", "optional", "The person who requested the work is not yet identified."),
    );
  }
  if (!partyHasIdentity(findParty(snapshot.parties, "property_owner"))) {
    optional.push(item("property_owner", "optional", "Property owner is not yet identified."));
  }
  if (!partyHasIdentity(findParty(snapshot.parties, "general_contractor"))) {
    optional.push(
      item(
        "general_contractor",
        "optional",
        "General contractor or construction manager is not yet identified.",
      ),
    );
  }
  if (!partyHasIdentity(findParty(snapshot.parties, "approval_authority"))) {
    optional.push(
      item(
        "approval_authority",
        "optional",
        "Approval authority is not yet identified. This is not a commercial authorization gate.",
      ),
    );
  }
  if (!partyHasIdentity(findParty(snapshot.parties, "billing_contact"))) {
    optional.push(
      item(
        "billing_contact",
        "optional",
        "Billing contact is not yet identified. This is not a billing approval gate.",
      ),
    );
  }

  return {
    readyForProposal: blocking.length === 0,
    blocking,
    optional,
    items: [...blocking, ...optional],
  };
}

export function leadToIntakeSnapshot(
  lead: Lead,
  parties: readonly LeadPartyInput[],
): LeadIntakeSnapshot {
  return {
    sourceType: lead.sourceType,
    sourceDetails: lead.sourceDetails,
    receivedAt: lead.receivedAt,
    opportunityName: lead.opportunityName,
    requestSummary: lead.requestSummary,
    requestedService: lead.requestedService,
    siteName: lead.siteName,
    siteCity: lead.siteCity,
    siteRegion: lead.siteRegion,
    desiredDeadlineAt: lead.desiredDeadlineAt,
    requestedVisitAt: lead.requestedVisitAt,
    reviewerUserId: lead.reviewerUserId,
    parties,
  };
}

export const LEAD_PARTY_ROLE_LABELS: Readonly<Record<LeadPartyRole, string>> = {
  requester: "Requester",
  client_company: "Client company",
  primary_contact: "Primary contact",
  property_owner: "Property owner",
  general_contractor: "General contractor / construction manager",
  approval_authority: "Approval authority",
  billing_contact: "Billing contact",
};

export const LEAD_STATUS_LABELS: Readonly<Record<LeadStatus, string>> = {
  new: "New",
  needs_info: "Needs information",
  ready_for_proposal: "Ready for proposal",
  disqualified: "Disqualified",
};

export const LEAD_SOURCE_LABELS: Readonly<Record<LeadSourceType, string>> = {
  manual: "Manual intake",
  referral: "Referral intake",
  in_person: "In-person intake",
};
