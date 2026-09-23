/** Pure, company-independent intake contracts. Source material is untrusted data. */
export const CPL_LEAD_SOURCES = [
  "website_form",
  "email",
  "phone",
  "manual",
  "referral",
  "in_person",
  "crm_import",
] as const;
export type CplLeadSource = (typeof CPL_LEAD_SOURCES)[number];
export const CPL_LEAD_STATUSES = [
  "new",
  "needs_info",
  "ready_for_proposal",
  "disqualified",
] as const;
export type CplLeadStatus = (typeof CPL_LEAD_STATUSES)[number];
export interface CplLeadFields {
  title: string;
  contactName: string;
  contactEmail: string | null;
  details: string;
  sourceType: CplLeadSource;
  customerId: string | null;
  customerName: string;
  contactId: string | null;
  contactPhone: string;
  siteId: string | null;
  siteName: string;
  siteAddress: string;
  requestedService: string;
  receivedAt: string;
  requestedDeadlineAt: string | null;
  requestedVisitAt: string | null;
  assignedMemberIdentityId: string | null;
  nextAction: string;
  notes: string;
  status: CplLeadStatus;
  disqualificationReason: string | null;
}
export interface CplLeadMissingInformation {
  code: string;
  severity: "blocking" | "optional";
  message: string;
}
export interface CplLeadReadiness {
  readyForProposal: boolean;
  missingInformation: CplLeadMissingInformation[];
  conflicts: { code: string; message: string }[];
}
export interface CplLeadDuplicateCandidate {
  leadId: string;
  title: string;
  reasons: string[];
}
export interface CplLeadEvidence {
  id: string;
  kind: "initial_capture" | "source_reference" | "note";
  label: string;
  reference: string | null;
  note: string | null;
  createdAt: string;
  actorIdentityId: string;
}
export interface CplLeadDuplicateReview {
  disposition: "unreviewed" | "distinct" | "duplicate";
  reason: string | null;
  relatedLeadId: string | null;
  reviewedAt: string | null;
}
export interface CplIntakeDirectory {
  customers: { id: string; name: string }[];
  contacts: {
    id: string;
    customerId: string | null;
    name: string;
    email: string | null;
    phone: string;
  }[];
  sites: { id: string; customerId: string | null; name: string; address: string }[];
  members: { identityId: string; displayName: string }[];
}
export interface CplWorkflowPermissions {
  canCreateLead: boolean;
  canEditLead: boolean;
  canReviewLead: boolean;
  canCreateProposal: boolean;
  canEditProposal: boolean;
}
export const CPL_LEAD_EDITABLE_FIELDS = [
  "title",
  "contactName",
  "contactEmail",
  "details",
  "sourceType",
  "customerId",
  "customerName",
  "contactId",
  "contactPhone",
  "siteId",
  "siteName",
  "siteAddress",
  "requestedService",
  "receivedAt",
  "requestedDeadlineAt",
  "requestedVisitAt",
  "assignedMemberIdentityId",
  "nextAction",
  "notes",
  "status",
  "disqualificationReason",
] as const satisfies readonly (keyof CplLeadFields)[];

export class CplIntakeValidationError extends Error {
  readonly code = "CPL_INVALID_INPUT";
  constructor() {
    super("CPL_INVALID_INPUT");
    this.name = "CplIntakeValidationError";
  }
}
function invalid(): never {
  throw new CplIntakeValidationError();
}
export function intakeText(value: unknown, max: number, required = false): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)
  )
    invalid();
  const result = value.replaceAll("\r\n", "\n").trim();
  if (required && !result) invalid();
  return result;
}
export function intakeId(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  )
    invalid();
  return value.toLowerCase();
}
function date(value: unknown, required = false): string | null {
  if (!required && (value === null || value === undefined || value === "")) return null;
  if (
    typeof value !== "string" ||
    value.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}T/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    invalid();
  return new Date(value).toISOString();
}
export function normalizeCplLeadFields(
  input: Record<string, unknown>,
  base?: CplLeadFields,
  now = new Date().toISOString(),
): CplLeadFields {
  const get = (key: keyof CplLeadFields, fallback: unknown = "") =>
    input[key] === undefined ? (base?.[key] ?? fallback) : input[key];
  const sourceValue = get("sourceType", "manual");
  const source =
    sourceValue === "email_import"
      ? "email"
      : sourceValue === "file_import"
        ? "crm_import"
        : sourceValue;
  const status = get("status", "new");
  if (
    !(CPL_LEAD_SOURCES as readonly unknown[]).includes(source) ||
    !(CPL_LEAD_STATUSES as readonly unknown[]).includes(status)
  )
    invalid();
  const emailInput = get("contactEmail", null);
  const email = emailInput === null ? null : intakeText(emailInput, 254) || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) invalid();
  const reasonValue = get("disqualificationReason", null);
  const reason = reasonValue === null ? null : intakeText(reasonValue, 2000) || null;
  if (status === "disqualified" && !reason) invalid();
  return {
    title: intakeText(get("title"), 240, true),
    contactName: intakeText(get("contactName"), 240),
    contactEmail: email,
    details: intakeText(get("details"), 20_000),
    sourceType: source as CplLeadSource,
    customerId: intakeId(get("customerId", null)),
    customerName: intakeText(get("customerName"), 240),
    contactId: intakeId(get("contactId", null)),
    contactPhone: intakeText(get("contactPhone"), 80),
    siteId: intakeId(get("siteId", null)),
    siteName: intakeText(get("siteName"), 240),
    siteAddress: intakeText(get("siteAddress"), 2000),
    requestedService: intakeText(get("requestedService"), 2000),
    receivedAt: date(get("receivedAt", now), true)!,
    requestedDeadlineAt: date(get("requestedDeadlineAt", null)),
    requestedVisitAt: date(get("requestedVisitAt", null)),
    assignedMemberIdentityId: intakeId(get("assignedMemberIdentityId", null)),
    nextAction: intakeText(get("nextAction"), 2000),
    notes: intakeText(get("notes"), 20_000),
    status: status as CplLeadStatus,
    disqualificationReason: reason,
  };
}
export function evaluateCplLeadReadiness(
  fields: CplLeadFields,
  input: {
    unresolvedDuplicates?: boolean;
    markedDuplicate?: boolean;
    inactiveAssignee?: boolean;
  } = {},
): CplLeadReadiness {
  const missingInformation: CplLeadMissingInformation[] = [];
  const add = (code: string, message: string, severity: "blocking" | "optional" = "blocking") =>
    missingInformation.push({ code, message, severity });
  if (!fields.details) add("request_details", "Describe the customer's request.");
  if (!fields.requestedService) add("requested_service", "Identify the requested service.");
  if (!fields.customerName && !fields.contactName)
    add("customer_identity", "Identify the customer or contact.");
  if (!fields.assignedMemberIdentityId || input.inactiveAssignee)
    add("assigned_member", "Assign an active organization member.");
  if (!fields.nextAction) add("next_action", "Record the next action.");
  if (!fields.siteName && !fields.siteAddress)
    add("site", "Add a site if this service requires one.", "optional");
  if (!fields.requestedDeadlineAt && !fields.requestedVisitAt)
    add("requested_date", "Record a requested date if one applies.", "optional");
  const conflicts: CplLeadReadiness["conflicts"] = [];
  if (input.unresolvedDuplicates)
    conflicts.push({
      code: "duplicate_review_required",
      message: "Review possible duplicate inquiries and record a reason.",
    });
  if (input.markedDuplicate)
    conflicts.push({ code: "marked_duplicate", message: "This inquiry is marked as a duplicate." });
  if (fields.status === "disqualified")
    conflicts.push({
      code: "disqualified",
      message: "Reopen the disqualified inquiry before proposal work.",
    });
  return {
    readyForProposal:
      missingInformation.every((item) => item.severity !== "blocking") && conflicts.length === 0,
    missingInformation,
    conflicts,
  };
}
/** Matching is advisory only; it never merges identities or accepts a candidate. */
export function cplLeadMatchReasons(left: CplLeadFields, right: CplLeadFields): string[] {
  const normalize = (value: string | null) =>
    (value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[ \t\r\n]+/gu, " ");
  const same = (a: string | null, b: string | null) =>
    Boolean(normalize(a)) && normalize(a) === normalize(b);
  const reasons: string[] = [];
  if (same(left.contactEmail, right.contactEmail)) reasons.push("same_contact_email");
  if (same(left.contactPhone.replace(/[^0-9+]/gu, ""), right.contactPhone.replace(/[^0-9+]/gu, "")))
    reasons.push("same_contact_phone");
  if (same(left.customerName, right.customerName) && same(left.title, right.title))
    reasons.push("same_customer_and_title");
  if (same(left.siteAddress, right.siteAddress) && same(left.title, right.title))
    reasons.push("same_site_and_title");
  return reasons;
}
