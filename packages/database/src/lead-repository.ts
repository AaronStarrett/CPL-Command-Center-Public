import { randomUUID } from "node:crypto";
import type {
  Activity,
  JsonObject,
  Lead,
  LeadParty,
  LeadPartyInput,
  LeadReadinessResult,
  LeadSourceType,
  LeadStatus,
  LeadStatusEvent,
  OperationsEventType,
} from "@bea/domain";
import {
  LeadDisqualificationReasonError,
  LeadReadinessError,
  LeadReviewerEligibilityError,
  LeadStatusTransitionError,
  assertLeadStatusTransition,
  assertReadyForProposalUpdateAllowed,
  evaluateLeadReadiness,
  formatLeadReference,
  isLeadPartyRole,
  isLeadSourceType,
  isLeadStatus,
  leadToIntakeSnapshot,
} from "@bea/domain";
import type { DatabaseAdapter, SqlExecutor } from "./adapter.js";
import { insertAutomationEvent } from "./operations-repository.js";

export {
  LeadDisqualificationReasonError,
  LeadReadinessError,
  LeadReadyStatusInvariantError,
  LeadReviewerEligibilityError,
  LeadStatusTransitionError,
} from "@bea/domain";

type Row = Record<string, unknown>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function json<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function clampLimit(value: number | undefined, fallback = 50, maximum = 100): number {
  return Math.max(1, Math.min(maximum, Math.trunc(value ?? fallback)));
}

function requiredText(value: string, name: string, maximum = 240): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new LeadValidationError(`${name} must contain between 1 and ${maximum} characters.`);
  }
  return normalized;
}

function requiredUuid(value: string, name: string): string {
  const normalized = requiredText(value, name, 36);
  if (!UUID_PATTERN.test(normalized)) {
    throw new LeadValidationError(`${name} must be a canonical UUID.`);
  }
  return normalized.toLocaleLowerCase("en-US");
}

function optionalText(value: string | null | undefined, maximum = 4_000): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  if (normalized.length > maximum) {
    throw new LeadValidationError(`Text must not exceed ${maximum} characters.`);
  }
  return normalized || null;
}

function optionalIso(value: string | null | undefined, name: string): string | null {
  if (value === null || value === undefined) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new LeadValidationError(`${name} must be an ISO time.`);
  return new Date(milliseconds).toISOString();
}

function optionalUuid(value: string | null | undefined, name: string): string | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  return requiredUuid(value, name);
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function optionalEmail(value: string | null | undefined): string | null {
  const normalized = optionalText(value ?? null, 240);
  if (!normalized) return null;
  if (!EMAIL_PATTERN.test(normalized)) {
    throw new LeadValidationError("Party email must be a valid email address.");
  }
  return normalized;
}

const REVIEWER_ELIGIBILITY_PREDICATE = `u.status='active' AND u.archived_at IS NULL AND EXISTS (
  SELECT 1
  FROM user_roles ur
  JOIN role_permissions rp ON rp.role_id = ur.role_id
  JOIN permissions p ON p.id = rp.permission_id
  WHERE ur.user_id = u.id AND p.key='leads.review'
)`;

function booleanFlag(value: unknown): boolean {
  return value === true || value === "t" || value === "true" || value === 1;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, "\\$&");
}

export class LeadRepositoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LeadRepositoryError";
  }
}

export class LeadValidationError extends LeadRepositoryError {
  constructor(message: string) {
    super("LEAD_VALIDATION_FAILED", message);
    this.name = "LeadValidationError";
  }
}

export class LeadRecordNotFoundError extends LeadRepositoryError {
  constructor() {
    super("LEAD_RECORD_NOT_FOUND", "Lead was not found.");
    this.name = "LeadRecordNotFoundError";
  }
}

export class LeadConcurrencyError extends LeadRepositoryError {
  constructor() {
    super("LEAD_CONCURRENT_UPDATE", "Lead changed before the update could be recorded.");
    this.name = "LeadConcurrencyError";
  }
}

export interface LeadReviewerCandidate {
  readonly id: string;
  readonly displayName: string;
  readonly title: string | null;
}

export interface ListLeadsOptions {
  readonly limit?: number;
  readonly query?: string;
  readonly status?: LeadStatus;
  readonly sourceType?: LeadSourceType;
  readonly reviewerUserId?: string | null;
}

export interface CreateLeadInput {
  readonly id?: string;
  readonly reference?: string;
  readonly sourceType: LeadSourceType;
  readonly sourceDetails?: string | null;
  readonly receivedAt?: string | null;
  readonly opportunityName: string;
  readonly requestSummary: string;
  readonly requestedService?: string | null;
  readonly siteName?: string | null;
  readonly siteAddressLine1?: string | null;
  readonly siteAddressLine2?: string | null;
  readonly siteCity?: string | null;
  readonly siteRegion?: string | null;
  readonly sitePostalCode?: string | null;
  readonly siteCountry?: string | null;
  readonly desiredDeadlineAt?: string | null;
  readonly requestedVisitAt?: string | null;
  readonly reviewerUserId?: string | null;
  readonly parties?: readonly LeadPartyInput[];
  readonly createdByUserId: string;
  readonly correlationId?: string;
  readonly createdAt?: string;
}

export interface UpdateLeadInput {
  readonly leadId: string;
  readonly expectedVersion: number;
  readonly actorUserId: string;
  readonly correlationId?: string;
  readonly sourceType?: LeadSourceType;
  readonly sourceDetails?: string | null;
  readonly receivedAt?: string | null;
  readonly opportunityName?: string;
  readonly requestSummary?: string;
  readonly requestedService?: string | null;
  readonly siteName?: string | null;
  readonly siteAddressLine1?: string | null;
  readonly siteAddressLine2?: string | null;
  readonly siteCity?: string | null;
  readonly siteRegion?: string | null;
  readonly sitePostalCode?: string | null;
  readonly siteCountry?: string | null;
  readonly desiredDeadlineAt?: string | null;
  readonly requestedVisitAt?: string | null;
  readonly reviewerUserId?: string | null;
  readonly parties?: readonly LeadPartyInput[];
}

export interface TransitionLeadStatusInput {
  readonly leadId: string;
  readonly toStatus: LeadStatus;
  readonly reason?: string | null;
  readonly expectedVersion: number;
  readonly actorUserId: string;
  readonly correlationId?: string;
}

export interface LeadRecord {
  readonly lead: Lead;
  readonly parties: readonly LeadParty[];
  readonly readiness: LeadReadinessResult;
  readonly statusEvents: readonly LeadStatusEvent[];
  readonly activities: readonly Activity[];
}

export interface LeadListItem {
  readonly lead: Lead;
  readonly readiness: LeadReadinessResult;
  readonly primaryCompanyName: string | null;
  readonly primaryContactName: string | null;
  readonly reviewerDisplayName: string | null;
  readonly parties: readonly LeadParty[];
}

function mapLead(row: Row): Lead {
  return {
    id: String(row.id),
    reference: String(row.reference),
    sourceType: row.source_type as LeadSourceType,
    sourceDetails: nullableString(row.source_details),
    receivedAt: iso(row.received_at),
    opportunityName: String(row.opportunity_name),
    requestSummary: String(row.request_summary),
    requestedService: nullableString(row.requested_service),
    siteName: nullableString(row.site_name),
    siteAddressLine1: nullableString(row.site_address_line1),
    siteAddressLine2: nullableString(row.site_address_line2),
    siteCity: nullableString(row.site_city),
    siteRegion: nullableString(row.site_region),
    sitePostalCode: nullableString(row.site_postal_code),
    siteCountry: nullableString(row.site_country),
    desiredDeadlineAt: nullableIso(row.desired_deadline_at),
    requestedVisitAt: nullableIso(row.requested_visit_at),
    reviewerUserId: nullableString(row.reviewer_user_id),
    status: row.status as LeadStatus,
    disqualificationReason: nullableString(row.disqualification_reason),
    createdByUserId: String(row.created_by_user_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

function mapParty(row: Row): LeadParty {
  return {
    id: String(row.id),
    leadId: String(row.lead_id),
    role: row.role as LeadParty["role"],
    companyId: nullableString(row.company_id),
    contactId: nullableString(row.contact_id),
    unmatchedCompanyName: nullableString(row.unmatched_company_name),
    unmatchedContactName: nullableString(row.unmatched_contact_name),
    unmatchedEmail: nullableString(row.unmatched_email),
    unmatchedPhone: nullableString(row.unmatched_phone),
    notes: nullableString(row.notes),
    createdByUserId: nullableString(row.created_by_user_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

function mapStatusEvent(row: Row): LeadStatusEvent {
  return {
    id: String(row.id),
    leadId: String(row.lead_id),
    fromStatus: (row.from_status as LeadStatus | null) ?? null,
    toStatus: row.to_status as LeadStatus,
    reason: nullableString(row.reason),
    actorUserId: nullableString(row.actor_user_id),
    correlationId: nullableString(row.correlation_id),
    metadata: json(row.metadata, {}),
    createdAt: iso(row.created_at),
  };
}

function mapActivity(row: Row): Activity {
  return {
    id: String(row.id),
    type: row.type as Activity["type"],
    summary: String(row.summary),
    actorUserId: nullableString(row.actor_user_id),
    companyId: nullableString(row.company_id),
    contactId: nullableString(row.contact_id),
    taskId: nullableString(row.task_id),
    leadId: nullableString(row.lead_id),
    correlationId: nullableString(row.correlation_id),
    metadata: json(row.metadata, {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

function normalizeParties(
  parties: readonly LeadPartyInput[] | undefined,
): readonly LeadPartyInput[] {
  if (!parties || parties.length === 0) return [];
  const seen = new Set<string>();
  const normalized: LeadPartyInput[] = [];
  for (const party of parties) {
    if (!isLeadPartyRole(party.role)) {
      throw new LeadValidationError("Lead party role is invalid.");
    }
    if (seen.has(party.role)) {
      throw new LeadValidationError("Each business role may appear only once on a lead.");
    }
    seen.add(party.role);
    const companyId = optionalUuid(party.companyId ?? null, "Party company ID");
    const contactId = optionalUuid(party.contactId ?? null, "Party contact ID");
    const unmatchedCompanyName = optionalText(party.unmatchedCompanyName ?? null, 240);
    const unmatchedContactName = optionalText(party.unmatchedContactName ?? null, 240);
    const unmatchedEmail = optionalEmail(party.unmatchedEmail ?? null);
    const unmatchedPhone = optionalText(party.unmatchedPhone ?? null, 64);
    const notes = optionalText(party.notes ?? null, 4_000);
    if (
      !companyId &&
      !contactId &&
      !unmatchedCompanyName &&
      !unmatchedContactName &&
      !unmatchedEmail &&
      !unmatchedPhone &&
      !notes
    ) {
      continue;
    }
    normalized.push({
      role: party.role,
      companyId,
      contactId,
      unmatchedCompanyName,
      unmatchedContactName,
      unmatchedEmail,
      unmatchedPhone,
      notes,
    });
  }
  return normalized;
}

function normalizeCreateInput(input: CreateLeadInput) {
  if (!isLeadSourceType(input.sourceType)) {
    throw new LeadValidationError("Lead source type is invalid.");
  }
  return {
    id: input.id ? requiredUuid(input.id, "Lead ID") : randomUUID(),
    sourceType: input.sourceType,
    sourceDetails: optionalText(input.sourceDetails ?? null, 4_000),
    receivedAt: optionalIso(input.receivedAt ?? null, "Received time") ?? new Date().toISOString(),
    opportunityName: requiredText(input.opportunityName, "Opportunity name", 240),
    requestSummary: requiredText(input.requestSummary, "Request summary", 4_000),
    requestedService: optionalText(input.requestedService ?? null, 240),
    siteName: optionalText(input.siteName ?? null, 240),
    siteAddressLine1: optionalText(input.siteAddressLine1 ?? null, 240),
    siteAddressLine2: optionalText(input.siteAddressLine2 ?? null, 240),
    siteCity: optionalText(input.siteCity ?? null, 120),
    siteRegion: optionalText(input.siteRegion ?? null, 120),
    sitePostalCode: optionalText(input.sitePostalCode ?? null, 32),
    siteCountry: optionalText(input.siteCountry ?? null, 120),
    desiredDeadlineAt: optionalIso(input.desiredDeadlineAt ?? null, "Desired deadline"),
    requestedVisitAt: optionalIso(input.requestedVisitAt ?? null, "Requested visit time"),
    reviewerUserId: optionalUuid(input.reviewerUserId ?? null, "Reviewer user ID"),
    parties: normalizeParties(input.parties),
    createdByUserId: requiredUuid(input.createdByUserId, "Creator user ID"),
    correlationId: input.correlationId?.trim() || null,
    createdAt:
      optionalIso(input.createdAt ?? null, "Lead creation time") ?? new Date().toISOString(),
  };
}

async function requireUser(executor: SqlExecutor, userId: string, name: string): Promise<void> {
  const result = await executor.query<Row>("SELECT id FROM users WHERE id=$1 FOR SHARE", [userId]);
  if (!result.rows[0]) throw new LeadValidationError(`${name} is unavailable.`);
}

async function requireEligibleReviewer(executor: SqlExecutor, userId: string): Promise<void> {
  const result = await executor.query<Row>(
    `SELECT u.id, u.status, u.archived_at,
            EXISTS (
              SELECT 1
              FROM user_roles ur
              JOIN role_permissions rp ON rp.role_id = ur.role_id
              JOIN permissions p ON p.id = rp.permission_id
              WHERE ur.user_id = u.id AND p.key='leads.review'
            ) AS has_review
     FROM users u
     WHERE u.id=$1
     FOR SHARE`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new LeadReviewerEligibilityError("Reviewer assignment requires an existing user.");
  }
  if (nullableString(row.archived_at)) {
    throw new LeadReviewerEligibilityError(
      "Reviewer assignment requires a user who is not archived.",
    );
  }
  if (String(row.status) !== "active") {
    throw new LeadReviewerEligibilityError("Reviewer assignment requires an active user.");
  }
  if (!booleanFlag(row.has_review)) {
    throw new LeadReviewerEligibilityError(
      "Reviewer assignment requires an active user with the leads.review permission.",
    );
  }
}

async function requireCompany(executor: SqlExecutor, companyId: string): Promise<void> {
  const result = await executor.query<Row>("SELECT id FROM companies WHERE id=$1 FOR SHARE", [
    companyId,
  ]);
  if (!result.rows[0]) throw new LeadValidationError("The linked company is unavailable.");
}

async function requireContact(
  executor: SqlExecutor,
  contactId: string,
  companyId: string | null,
): Promise<void> {
  const result = await executor.query<Row>(
    "SELECT id, company_id FROM contacts WHERE id=$1 FOR SHARE",
    [contactId],
  );
  const row = result.rows[0];
  if (!row) throw new LeadValidationError("The linked contact is unavailable.");
  if (companyId && nullableString(row.company_id) && nullableString(row.company_id) !== companyId) {
    throw new LeadValidationError("The linked contact does not match the selected company.");
  }
}

async function requirePartyRelationships(
  executor: SqlExecutor,
  parties: readonly LeadPartyInput[],
): Promise<void> {
  for (const party of parties) {
    if (party.companyId) await requireCompany(executor, party.companyId);
    if (party.contactId) await requireContact(executor, party.contactId, party.companyId ?? null);
  }
}

async function insertAudit(
  executor: SqlExecutor,
  input: {
    readonly eventType: string;
    readonly action: string;
    readonly actorUserId: string;
    readonly resourceId: string;
    readonly correlationId?: string | null;
    readonly metadata?: JsonObject;
    readonly createdAt: string;
  },
): Promise<void> {
  await executor.query(
    `INSERT INTO audit_logs
     (id,event_type,action,outcome,actor_user_id,resource_type,resource_id,correlation_id,metadata,created_at)
     VALUES ($1,$2,$3,'succeeded',$4,'lead',$5,$6,$7::jsonb,$8)`,
    [
      randomUUID(),
      input.eventType,
      input.action,
      input.actorUserId,
      input.resourceId,
      input.correlationId ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.createdAt,
    ],
  );
}

async function insertActivity(
  executor: SqlExecutor,
  input: {
    readonly type: Activity["type"];
    readonly summary: string;
    readonly actorUserId: string;
    readonly leadId: string;
    readonly companyId?: string | null;
    readonly contactId?: string | null;
    readonly correlationId?: string | null;
    readonly metadata?: JsonObject;
    readonly createdAt: string;
  },
): Promise<void> {
  await executor.query(
    `INSERT INTO activities
     (id,type,summary,actor_user_id,company_id,contact_id,task_id,lead_id,correlation_id,metadata,created_at,updated_at,version)
     VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9::jsonb,$10,$10,1)`,
    [
      randomUUID(),
      input.type,
      input.summary,
      input.actorUserId,
      input.companyId ?? null,
      input.contactId ?? null,
      input.leadId,
      input.correlationId ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.createdAt,
    ],
  );
}

async function insertStatusEvent(
  executor: SqlExecutor,
  input: {
    readonly leadId: string;
    readonly fromStatus: LeadStatus | null;
    readonly toStatus: LeadStatus;
    readonly reason: string | null;
    readonly actorUserId: string;
    readonly correlationId: string | null;
    readonly metadata?: JsonObject;
    readonly createdAt: string;
  },
): Promise<void> {
  await executor.query(
    `INSERT INTO lead_status_events
     (id,lead_id,from_status,to_status,reason,actor_user_id,correlation_id,metadata,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
    [
      randomUUID(),
      input.leadId,
      input.fromStatus,
      input.toStatus,
      input.reason,
      input.actorUserId,
      input.correlationId,
      JSON.stringify(input.metadata ?? {}),
      input.createdAt,
    ],
  );
}

function partyIdentity(party: LeadParty | LeadPartyInput): {
  readonly companyId: string | null;
  readonly contactId: string | null;
  readonly unmatchedCompanyName: string | null;
  readonly unmatchedContactName: string | null;
  readonly unmatchedEmail: string | null;
  readonly unmatchedPhone: string | null;
  readonly notes: string | null;
} {
  return {
    companyId: party.companyId ?? null,
    contactId: party.contactId ?? null,
    unmatchedCompanyName: party.unmatchedCompanyName ?? null,
    unmatchedContactName: party.unmatchedContactName ?? null,
    unmatchedEmail: party.unmatchedEmail ?? null,
    unmatchedPhone: party.unmatchedPhone ?? null,
    notes: party.notes ?? null,
  };
}

function partyIdentityEquals(
  left: LeadParty | LeadPartyInput,
  right: LeadParty | LeadPartyInput,
): boolean {
  return JSON.stringify(partyIdentity(left)) === JSON.stringify(partyIdentity(right));
}

async function insertParty(
  executor: SqlExecutor,
  leadId: string,
  party: LeadPartyInput,
  actorUserId: string,
  createdAt: string,
): Promise<LeadParty> {
  const result = await executor.query<Row>(
    `INSERT INTO lead_parties
     (id,lead_id,role,company_id,contact_id,unmatched_company_name,unmatched_contact_name,unmatched_email,unmatched_phone,notes,created_by_user_id,created_at,updated_at,version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,1)
     RETURNING *`,
    [
      randomUUID(),
      leadId,
      party.role,
      party.companyId ?? null,
      party.contactId ?? null,
      party.unmatchedCompanyName ?? null,
      party.unmatchedContactName ?? null,
      party.unmatchedEmail ?? null,
      party.unmatchedPhone ?? null,
      party.notes ?? null,
      actorUserId,
      createdAt,
    ],
  );
  return mapParty(result.rows[0] as Row);
}

async function replaceParties(
  executor: SqlExecutor,
  leadId: string,
  parties: readonly LeadPartyInput[],
  actorUserId: string,
  createdAt: string,
): Promise<readonly LeadParty[]> {
  await executor.query("DELETE FROM lead_parties WHERE lead_id=$1", [leadId]);
  const persisted: LeadParty[] = [];
  for (const party of parties) {
    persisted.push(await insertParty(executor, leadId, party, actorUserId, createdAt));
  }
  return persisted;
}

interface PartySyncResult {
  readonly parties: readonly LeadParty[];
  readonly added: readonly string[];
  readonly updated: readonly string[];
  readonly removed: readonly string[];
}

async function syncParties(
  executor: SqlExecutor,
  leadId: string,
  desired: readonly LeadPartyInput[],
  existing: readonly LeadParty[],
  actorUserId: string,
  updatedAt: string,
): Promise<PartySyncResult> {
  const existingByRole = new Map(existing.map((party) => [party.role, party]));
  const desiredByRole = new Map(desired.map((party) => [party.role, party]));
  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  const persisted: LeadParty[] = [];

  for (const current of existing) {
    const next = desiredByRole.get(current.role);
    if (!next) {
      await executor.query("DELETE FROM lead_parties WHERE id=$1 AND lead_id=$2", [
        current.id,
        leadId,
      ]);
      removed.push(current.role);
      continue;
    }
    if (partyIdentityEquals(current, next)) {
      persisted.push(current);
      continue;
    }
    const result = await executor.query<Row>(
      `UPDATE lead_parties SET
         company_id=$3, contact_id=$4, unmatched_company_name=$5, unmatched_contact_name=$6,
         unmatched_email=$7, unmatched_phone=$8, notes=$9, updated_at=$10, version=version+1
       WHERE id=$1 AND lead_id=$2
       RETURNING *`,
      [
        current.id,
        leadId,
        next.companyId ?? null,
        next.contactId ?? null,
        next.unmatchedCompanyName ?? null,
        next.unmatchedContactName ?? null,
        next.unmatchedEmail ?? null,
        next.unmatchedPhone ?? null,
        next.notes ?? null,
        updatedAt,
      ],
    );
    persisted.push(mapParty(result.rows[0] as Row));
    updated.push(current.role);
  }

  for (const next of desired) {
    if (existingByRole.has(next.role)) continue;
    persisted.push(await insertParty(executor, leadId, next, actorUserId, updatedAt));
    added.push(next.role);
  }

  persisted.sort((left, right) =>
    left.role === right.role
      ? left.id.localeCompare(right.id)
      : left.role.localeCompare(right.role),
  );
  return { parties: persisted, added, updated, removed };
}

async function loadParties(
  executor: SqlExecutor,
  leadIds: readonly string[],
): Promise<LeadParty[]> {
  if (leadIds.length === 0) return [];
  const placeholders = leadIds.map((_, index) => `$${index + 1}`).join(",");
  const result = await executor.query<Row>(
    `SELECT * FROM lead_parties WHERE lead_id IN (${placeholders}) ORDER BY role, id`,
    [...leadIds],
  );
  return result.rows.map(mapParty);
}

function primaryNames(
  parties: readonly LeadParty[],
  companyNames: ReadonlyMap<string, string>,
  contactNames: ReadonlyMap<string, string>,
): {
  readonly primaryCompanyName: string | null;
  readonly primaryContactName: string | null;
} {
  const client = parties.find((party) => party.role === "client_company");
  const primary = parties.find((party) => party.role === "primary_contact");
  const requester = parties.find((party) => party.role === "requester");
  const companyName = (party: LeadParty | undefined): string | null => {
    if (!party) return null;
    return (
      (party.companyId ? companyNames.get(party.companyId) : undefined) ??
      party.unmatchedCompanyName ??
      null
    );
  };
  const contactName = (party: LeadParty | undefined): string | null => {
    if (!party) return null;
    return (
      (party.contactId ? contactNames.get(party.contactId) : undefined) ??
      party.unmatchedContactName ??
      null
    );
  };
  return {
    primaryCompanyName: companyName(client) ?? companyName(primary) ?? companyName(requester),
    primaryContactName: contactName(primary) ?? contactName(requester) ?? contactName(client),
  };
}

async function loadCanonicalNames(
  executor: SqlExecutor,
  parties: readonly LeadParty[],
): Promise<{
  readonly companyNames: Map<string, string>;
  readonly contactNames: Map<string, string>;
}> {
  const companyIds = [...new Set(parties.map((party) => party.companyId).filter(Boolean))];
  const contactIds = [...new Set(parties.map((party) => party.contactId).filter(Boolean))];
  const companyNames = new Map<string, string>();
  const contactNames = new Map<string, string>();
  if (companyIds.length > 0) {
    const placeholders = companyIds.map((_, index) => `$${index + 1}`).join(",");
    const result = await executor.query<Row>(
      `SELECT id::text AS id, name FROM companies WHERE id IN (${placeholders})`,
      companyIds,
    );
    for (const row of result.rows) {
      companyNames.set(String(row.id), String(row.name));
    }
  }
  if (contactIds.length > 0) {
    const placeholders = contactIds.map((_, index) => `$${index + 1}`).join(",");
    const result = await executor.query<Row>(
      `SELECT id::text AS id, first_name, last_name FROM contacts WHERE id IN (${placeholders})`,
      contactIds,
    );
    for (const row of result.rows) {
      contactNames.set(String(row.id), `${String(row.first_name)} ${String(row.last_name)}`.trim());
    }
  }
  return { companyNames, contactNames };
}

function changedLeadFieldNames(
  current: Lead,
  next: {
    readonly sourceType: Lead["sourceType"];
    readonly sourceDetails: Lead["sourceDetails"];
    readonly receivedAt: Lead["receivedAt"];
    readonly opportunityName: Lead["opportunityName"];
    readonly requestSummary: Lead["requestSummary"];
    readonly requestedService: Lead["requestedService"];
    readonly siteName: Lead["siteName"];
    readonly siteAddressLine1: Lead["siteAddressLine1"];
    readonly siteAddressLine2: Lead["siteAddressLine2"];
    readonly siteCity: Lead["siteCity"];
    readonly siteRegion: Lead["siteRegion"];
    readonly sitePostalCode: Lead["sitePostalCode"];
    readonly siteCountry: Lead["siteCountry"];
    readonly desiredDeadlineAt: Lead["desiredDeadlineAt"];
    readonly requestedVisitAt: Lead["requestedVisitAt"];
    readonly reviewerUserId: Lead["reviewerUserId"];
  },
): readonly string[] {
  const fields: Array<keyof typeof next> = [
    "sourceType",
    "sourceDetails",
    "receivedAt",
    "opportunityName",
    "requestSummary",
    "requestedService",
    "siteName",
    "siteAddressLine1",
    "siteAddressLine2",
    "siteCity",
    "siteRegion",
    "sitePostalCode",
    "siteCountry",
    "desiredDeadlineAt",
    "requestedVisitAt",
    "reviewerUserId",
  ];
  return fields.filter((field) => current[field] !== next[field]);
}

function optionalLeadReference(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLocaleUpperCase("en-US");
  if (!/^BEA-LD-\d{6}$/u.test(normalized)) {
    throw new LeadValidationError("Lead reference must use the BEA-LD-000000 convention.");
  }
  return normalized;
}

async function nextReference(executor: SqlExecutor): Promise<string> {
  const result = await executor.query<{ value: string | number }>(
    "SELECT nextval('bea_lead_reference_seq') AS value",
  );
  return formatLeadReference(Number(result.rows[0]?.value));
}

export class SqlLeadRepository {
  constructor(private readonly database: DatabaseAdapter) {}

  async listReviewerCandidates(): Promise<readonly LeadReviewerCandidate[]> {
    const result = await this.database.query<Row>(
      `SELECT u.id::text AS id, u.display_name, u.title
       FROM users u
       WHERE ${REVIEWER_ELIGIBILITY_PREDICATE}
       ORDER BY u.display_name, u.id::text`,
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      displayName: String(row.display_name),
      title: nullableString(row.title),
    }));
  }

  async listLeads(options: ListLeadsOptions = {}): Promise<readonly LeadListItem[]> {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (options.status) {
      if (!isLeadStatus(options.status)) throw new LeadValidationError("Lead status is invalid.");
      parameters.push(options.status);
      clauses.push(`l.status=$${parameters.length}`);
    }
    if (options.sourceType) {
      if (!isLeadSourceType(options.sourceType)) {
        throw new LeadValidationError("Lead source type is invalid.");
      }
      parameters.push(options.sourceType);
      clauses.push(`l.source_type=$${parameters.length}`);
    }
    if (options.reviewerUserId === null) {
      clauses.push("l.reviewer_user_id IS NULL");
    } else if (options.reviewerUserId) {
      parameters.push(requiredUuid(options.reviewerUserId, "Reviewer user ID"));
      clauses.push(`l.reviewer_user_id=$${parameters.length}`);
    }
    if (options.query?.trim()) {
      parameters.push(`%${escapeLike(options.query.trim())}%`);
      const parameter = `$${parameters.length}`;
      clauses.push(
        `(l.reference ILIKE ${parameter} ESCAPE '\\' OR l.opportunity_name ILIKE ${parameter} ESCAPE '\\' OR l.request_summary ILIKE ${parameter} ESCAPE '\\' OR COALESCE(l.requested_service,'') ILIKE ${parameter} ESCAPE '\\' OR COALESCE(l.source_details,'') ILIKE ${parameter} ESCAPE '\\')`,
      );
    }
    parameters.push(clampLimit(options.limit));
    const result = await this.database.query<Row>(
      `SELECT l.*, reviewer.display_name AS reviewer_display_name
       FROM leads l
       LEFT JOIN users reviewer ON reviewer.id = l.reviewer_user_id
       ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY l.received_at DESC, l.reference DESC
       LIMIT $${parameters.length}`,
      parameters,
    );
    const leads = result.rows.map(mapLead);
    const parties = await loadParties(
      this.database,
      leads.map((lead) => lead.id),
    );
    const partiesByLead = new Map<string, LeadParty[]>();
    for (const party of parties) {
      const list = partiesByLead.get(party.leadId) ?? [];
      list.push(party);
      partiesByLead.set(party.leadId, list);
    }
    const { companyNames, contactNames } = await loadCanonicalNames(this.database, parties);
    return result.rows.map((row) => {
      const lead = mapLead(row);
      const leadParties = partiesByLead.get(lead.id) ?? [];
      const names = primaryNames(leadParties, companyNames, contactNames);
      return {
        lead,
        parties: leadParties,
        readiness: evaluateLeadReadiness(leadToIntakeSnapshot(lead, leadParties)),
        primaryCompanyName: names.primaryCompanyName,
        primaryContactName: names.primaryContactName,
        reviewerDisplayName: nullableString(row.reviewer_display_name),
      };
    });
  }

  async getLead(id: string, executor: SqlExecutor = this.database): Promise<LeadRecord | null> {
    const result = await executor.query<Row>("SELECT * FROM leads WHERE id=$1", [
      requiredUuid(id, "Lead ID"),
    ]);
    const row = result.rows[0];
    if (!row) return null;
    return this.composeRecord(mapLead(row), undefined, executor);
  }

  async getLeadByReference(reference: string): Promise<LeadRecord | null> {
    const normalized = requiredText(reference, "Lead reference", 32);
    const result = await this.database.query<Row>("SELECT * FROM leads WHERE reference=$1", [
      normalized,
    ]);
    const row = result.rows[0];
    if (!row) return null;
    return this.composeRecord(mapLead(row));
  }

  evaluate(lead: Lead, parties: readonly LeadParty[]): LeadReadinessResult {
    return evaluateLeadReadiness(leadToIntakeSnapshot(lead, parties));
  }

  async createLead(input: CreateLeadInput): Promise<LeadRecord> {
    const normalized = normalizeCreateInput(input);
    return this.database.transaction(async (transaction) => {
      await requireUser(transaction, normalized.createdByUserId, "Creator");
      if (normalized.reviewerUserId) {
        await requireEligibleReviewer(transaction, normalized.reviewerUserId);
      }
      await requirePartyRelationships(transaction, normalized.parties);
      const reference =
        optionalLeadReference(input.reference) ?? (await nextReference(transaction));
      const inserted = await transaction.query<Row>(
        `INSERT INTO leads
         (id,reference,source_type,source_details,received_at,opportunity_name,request_summary,requested_service,
          site_name,site_address_line1,site_address_line2,site_city,site_region,site_postal_code,site_country,
          desired_deadline_at,requested_visit_at,reviewer_user_id,status,disqualification_reason,
          created_by_user_id,created_at,updated_at,version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'new',NULL,$19,$20,$20,1)
         RETURNING *`,
        [
          normalized.id,
          reference,
          normalized.sourceType,
          normalized.sourceDetails,
          normalized.receivedAt,
          normalized.opportunityName,
          normalized.requestSummary,
          normalized.requestedService,
          normalized.siteName,
          normalized.siteAddressLine1,
          normalized.siteAddressLine2,
          normalized.siteCity,
          normalized.siteRegion,
          normalized.sitePostalCode,
          normalized.siteCountry,
          normalized.desiredDeadlineAt,
          normalized.requestedVisitAt,
          normalized.reviewerUserId,
          normalized.createdByUserId,
          normalized.createdAt,
        ],
      );
      const lead = mapLead(inserted.rows[0] as Row);
      const parties = await replaceParties(
        transaction,
        lead.id,
        normalized.parties,
        normalized.createdByUserId,
        normalized.createdAt,
      );
      await insertStatusEvent(transaction, {
        leadId: lead.id,
        fromStatus: null,
        toStatus: "new",
        reason: null,
        actorUserId: normalized.createdByUserId,
        correlationId: normalized.correlationId,
        metadata: { sourceType: lead.sourceType },
        createdAt: normalized.createdAt,
      });
      await insertActivity(transaction, {
        type: "lead.created",
        summary: `Lead created: ${lead.reference} ${lead.opportunityName}`,
        actorUserId: normalized.createdByUserId,
        leadId: lead.id,
        correlationId: normalized.correlationId,
        metadata: { sourceType: lead.sourceType, reference: lead.reference },
        createdAt: normalized.createdAt,
      });
      await insertAudit(transaction, {
        eventType: "lead.created",
        action: "lead.create",
        actorUserId: normalized.createdByUserId,
        resourceId: lead.id,
        correlationId: normalized.correlationId,
        metadata: { sourceType: lead.sourceType, reference: lead.reference, status: lead.status },
        createdAt: normalized.createdAt,
      });
      return this.composeRecord(lead, parties, transaction);
    });
  }

  async updateLead(input: UpdateLeadInput): Promise<LeadRecord> {
    const leadId = requiredUuid(input.leadId, "Lead ID");
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new LeadValidationError("Lead version is invalid.");
    }
    return this.database.transaction(async (transaction) => {
      const currentResult = await transaction.query<Row>(
        "SELECT * FROM leads WHERE id=$1 FOR UPDATE",
        [leadId],
      );
      const currentRow = currentResult.rows[0];
      if (!currentRow) throw new LeadRecordNotFoundError();
      const current = mapLead(currentRow);
      if (current.version !== input.expectedVersion) throw new LeadConcurrencyError();
      const sourceType = input.sourceType ?? current.sourceType;
      if (!isLeadSourceType(sourceType))
        throw new LeadValidationError("Lead source type is invalid.");
      const updatedFields = {
        sourceType,
        sourceDetails:
          input.sourceDetails === undefined
            ? current.sourceDetails
            : optionalText(input.sourceDetails, 4_000),
        receivedAt:
          input.receivedAt === undefined
            ? current.receivedAt
            : (optionalIso(input.receivedAt, "Received time") ?? current.receivedAt),
        opportunityName:
          input.opportunityName === undefined
            ? current.opportunityName
            : requiredText(input.opportunityName, "Opportunity name", 240),
        requestSummary:
          input.requestSummary === undefined
            ? current.requestSummary
            : requiredText(input.requestSummary, "Request summary", 4_000),
        requestedService:
          input.requestedService === undefined
            ? current.requestedService
            : optionalText(input.requestedService, 240),
        siteName:
          input.siteName === undefined ? current.siteName : optionalText(input.siteName, 240),
        siteAddressLine1:
          input.siteAddressLine1 === undefined
            ? current.siteAddressLine1
            : optionalText(input.siteAddressLine1, 240),
        siteAddressLine2:
          input.siteAddressLine2 === undefined
            ? current.siteAddressLine2
            : optionalText(input.siteAddressLine2, 240),
        siteCity:
          input.siteCity === undefined ? current.siteCity : optionalText(input.siteCity, 120),
        siteRegion:
          input.siteRegion === undefined ? current.siteRegion : optionalText(input.siteRegion, 120),
        sitePostalCode:
          input.sitePostalCode === undefined
            ? current.sitePostalCode
            : optionalText(input.sitePostalCode, 32),
        siteCountry:
          input.siteCountry === undefined
            ? current.siteCountry
            : optionalText(input.siteCountry, 120),
        desiredDeadlineAt:
          input.desiredDeadlineAt === undefined
            ? current.desiredDeadlineAt
            : optionalIso(input.desiredDeadlineAt, "Desired deadline"),
        requestedVisitAt:
          input.requestedVisitAt === undefined
            ? current.requestedVisitAt
            : optionalIso(input.requestedVisitAt, "Requested visit time"),
        reviewerUserId:
          input.reviewerUserId === undefined
            ? current.reviewerUserId
            : optionalUuid(input.reviewerUserId, "Reviewer user ID"),
      };
      if (updatedFields.reviewerUserId) {
        await requireEligibleReviewer(transaction, updatedFields.reviewerUserId);
      }
      const currentParties = await loadParties(transaction, [leadId]);
      const partiesInput =
        input.parties === undefined ? currentParties : normalizeParties(input.parties);
      if (input.parties) await requirePartyRelationships(transaction, partiesInput);
      const proposedLead = {
        ...current,
        ...updatedFields,
      };
      const proposedReadiness = evaluateLeadReadiness(
        leadToIntakeSnapshot(proposedLead, partiesInput),
      );
      assertReadyForProposalUpdateAllowed(current.status, proposedReadiness);
      const updatedAt = new Date().toISOString();
      const updated = await transaction.query<Row>(
        `UPDATE leads SET
           source_type=$2, source_details=$3, received_at=$4, opportunity_name=$5, request_summary=$6,
           requested_service=$7, site_name=$8, site_address_line1=$9, site_address_line2=$10, site_city=$11,
           site_region=$12, site_postal_code=$13, site_country=$14, desired_deadline_at=$15, requested_visit_at=$16,
           reviewer_user_id=$17, updated_at=$18, version=version+1
         WHERE id=$1 AND version=$19
         RETURNING *`,
        [
          leadId,
          updatedFields.sourceType,
          updatedFields.sourceDetails,
          updatedFields.receivedAt,
          updatedFields.opportunityName,
          updatedFields.requestSummary,
          updatedFields.requestedService,
          updatedFields.siteName,
          updatedFields.siteAddressLine1,
          updatedFields.siteAddressLine2,
          updatedFields.siteCity,
          updatedFields.siteRegion,
          updatedFields.sitePostalCode,
          updatedFields.siteCountry,
          updatedFields.desiredDeadlineAt,
          updatedFields.requestedVisitAt,
          updatedFields.reviewerUserId,
          updatedAt,
          input.expectedVersion,
        ],
      );
      const row = updated.rows[0];
      if (!row) throw new LeadConcurrencyError();
      const lead = mapLead(row);
      const partySync = input.parties
        ? await syncParties(
            transaction,
            lead.id,
            partiesInput,
            currentParties,
            input.actorUserId,
            updatedAt,
          )
        : {
            parties: currentParties,
            added: [] as readonly string[],
            updated: [] as readonly string[],
            removed: [] as readonly string[],
          };
      const changedFields = changedLeadFieldNames(current, updatedFields);
      await insertActivity(transaction, {
        type: "lead.updated",
        summary: `Lead updated: ${lead.reference}`,
        actorUserId: input.actorUserId,
        leadId: lead.id,
        correlationId: input.correlationId ?? null,
        metadata: {
          reference: lead.reference,
          changedFields: [...changedFields],
          partyRolesAdded: [...partySync.added],
          partyRolesUpdated: [...partySync.updated],
          partyRolesRemoved: [...partySync.removed],
        },
        createdAt: updatedAt,
      });
      await insertAudit(transaction, {
        eventType: "lead.updated",
        action: "lead.update",
        actorUserId: input.actorUserId,
        resourceId: lead.id,
        correlationId: input.correlationId ?? null,
        metadata: {
          reference: lead.reference,
          version: lead.version,
          changedFields: [...changedFields],
          partyRolesAdded: [...partySync.added],
          partyRolesUpdated: [...partySync.updated],
          partyRolesRemoved: [...partySync.removed],
        },
        createdAt: updatedAt,
      });
      return this.composeRecord(lead, partySync.parties as LeadParty[], transaction);
    });
  }

  async transitionStatus(input: TransitionLeadStatusInput): Promise<LeadRecord> {
    const leadId = requiredUuid(input.leadId, "Lead ID");
    if (!isLeadStatus(input.toStatus)) throw new LeadValidationError("Lead status is invalid.");
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new LeadValidationError("Lead version is invalid.");
    }
    return this.database.transaction(async (transaction) => {
      const currentResult = await transaction.query<Row>(
        "SELECT * FROM leads WHERE id=$1 FOR UPDATE",
        [leadId],
      );
      const currentRow = currentResult.rows[0];
      if (!currentRow) throw new LeadRecordNotFoundError();
      const current = mapLead(currentRow);
      if (current.version !== input.expectedVersion) throw new LeadConcurrencyError();
      try {
        assertLeadStatusTransition(current.status, input.toStatus);
      } catch (error) {
        if (error instanceof LeadStatusTransitionError) throw error;
        throw error;
      }
      const parties = await loadParties(transaction, [leadId]);
      const reason = optionalText(input.reason ?? null, 4_000);
      if (input.toStatus === "disqualified") {
        if (!reason) throw new LeadDisqualificationReasonError();
      }
      if (input.toStatus === "ready_for_proposal") {
        const readiness = evaluateLeadReadiness(leadToIntakeSnapshot(current, parties));
        if (!readiness.readyForProposal) throw new LeadReadinessError(readiness.blocking);
      }
      const updatedAt = new Date().toISOString();
      const disqualificationReason =
        input.toStatus === "disqualified"
          ? reason
          : input.toStatus === "new" || input.toStatus === "needs_info"
            ? null
            : current.disqualificationReason;
      const updated = await transaction.query<Row>(
        `UPDATE leads SET status=$2, disqualification_reason=$3, updated_at=$4, version=version+1
         WHERE id=$1 AND version=$5 RETURNING *`,
        [leadId, input.toStatus, disqualificationReason, updatedAt, input.expectedVersion],
      );
      const row = updated.rows[0];
      if (!row) throw new LeadConcurrencyError();
      const lead = mapLead(row);
      await insertStatusEvent(transaction, {
        leadId: lead.id,
        fromStatus: current.status,
        toStatus: lead.status,
        reason,
        actorUserId: input.actorUserId,
        correlationId: input.correlationId ?? null,
        metadata: { reference: lead.reference },
        createdAt: updatedAt,
      });
      const activityType =
        lead.status === "disqualified" ? "lead.disqualified" : "lead.status-changed";
      await insertActivity(transaction, {
        type: activityType,
        summary:
          lead.status === "disqualified"
            ? `Lead disqualified: ${lead.reference}`
            : `Lead status changed from ${current.status} to ${lead.status}: ${lead.reference}`,
        actorUserId: input.actorUserId,
        leadId: lead.id,
        correlationId: input.correlationId ?? null,
        metadata: {
          reference: lead.reference,
          fromStatus: current.status,
          toStatus: lead.status,
          reason,
        },
        createdAt: updatedAt,
      });
      await insertAudit(transaction, {
        eventType: lead.status === "disqualified" ? "lead.disqualified" : "lead.status-changed",
        action: "lead.transition",
        actorUserId: input.actorUserId,
        resourceId: lead.id,
        correlationId: input.correlationId ?? null,
        metadata: {
          reference: lead.reference,
          fromStatus: current.status,
          toStatus: lead.status,
          reason,
        },
        createdAt: updatedAt,
      });
      const automationEventType: OperationsEventType | null =
        lead.status === "ready_for_proposal"
          ? "lead.ready_for_proposal"
          : lead.status === "disqualified"
            ? "lead.disqualified"
            : lead.status === "needs_info"
              ? "lead.needs_info"
              : null;
      if (automationEventType) {
        await insertAutomationEvent(transaction, {
          eventType: automationEventType,
          aggregateType: "lead",
          aggregateId: lead.id,
          correlationId: input.correlationId ?? `lead-${lead.id}`,
          actorType: "user",
          actorId: input.actorUserId,
          payload: {
            leadId: lead.id,
            fromStatus: current.status,
            toStatus: lead.status,
          },
          occurredAt: updatedAt,
        });
      }
      return this.composeRecord(lead, parties, transaction);
    });
  }

  private async composeRecord(
    lead: Lead,
    parties?: readonly LeadParty[],
    executor: SqlExecutor = this.database,
  ): Promise<LeadRecord> {
    const [loadedParties, events, activities] = await Promise.all([
      parties ? Promise.resolve(parties) : loadParties(executor, [lead.id]),
      executor.query<Row>(
        "SELECT * FROM lead_status_events WHERE lead_id=$1 ORDER BY created_at ASC, id ASC",
        [lead.id],
      ),
      executor.query<Row>(
        "SELECT * FROM activities WHERE lead_id=$1 ORDER BY created_at DESC, id DESC LIMIT 50",
        [lead.id],
      ),
    ]);
    return {
      lead,
      parties: loadedParties,
      readiness: evaluateLeadReadiness(leadToIntakeSnapshot(lead, loadedParties)),
      statusEvents: events.rows.map(mapStatusEvent),
      activities: activities.rows.map(mapActivity),
    };
  }
}
