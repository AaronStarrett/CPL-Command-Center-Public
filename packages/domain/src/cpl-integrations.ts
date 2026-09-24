/** Tenant integration and inbound view contracts. Never contain credential material. */
export const CPL_INTEGRATION_ERROR_CODES = [
  "CPL_INBOUND_INVALID_INPUT",
  "CPL_INVALID_IDEMPOTENCY_KEY",
  "CPL_IDEMPOTENCY_CONFLICT",
  "CPL_INTEGRATION_NOT_FOUND",
  "CPL_INTEGRATION_STALE",
  "CPL_INTEGRATION_DISABLED",
  "CPL_INTEGRATION_PROVIDER_DISABLED",
  "CPL_INTEGRATION_AUTHORIZATION_REVOKED",
  "CPL_INTEGRATION_CONFIGURATION_CHANGED",
  "CPL_INTEGRATION_LEASE_LOST",
  "CPL_INTEGRATION_RECONNECT_REQUIRED",
  "CPL_INTEGRATION_RESYNC_REQUIRED",
  "CPL_INTEGRATION_OAUTH_REJECTED",
  "CPL_INTEGRATION_SOURCE_CONFLICT",
  "CPL_INTEGRATION_PROCESSING_FAILED",
  "CPL_INTEGRATION_RATE_LIMITED",
  "CPL_INTEGRATION_MAPPING_INVALID",
  "CPL_INTEGRATION_SIGNATURE_REJECTED",
  "CPL_INTEGRATION_SOURCE_UNAVAILABLE",
  "CPL_INTEGRATION_REPLAY_REJECTED",
  "CPL_INTEGRATION_SCHEMA_REQUIRED",
  "CPL_INTEGRATION_INPUT_TOO_LARGE",
  "CPL_INTEGRATION_STORAGE_LIMIT",
  "CPL_INTEGRATION_BUSY",
  "CPL_FORM_CONFIGURATION_CHANGED",
  "CPL_FORM_REQUIRED_FIELD",
  "CPL_FORM_SERVICE_UNAVAILABLE",
  "CPL_MAPPING_VALUE_INVALID",
] as const;
export type CplIntegrationErrorCode = (typeof CPL_INTEGRATION_ERROR_CODES)[number];
export class CplIntegrationError extends Error {
  constructor(readonly code: CplIntegrationErrorCode) {
    super(code);
    this.name = "CplIntegrationError";
  }
}
export type Id = string;
export type IsoTime = string;
export type Hash = string;
export type TenantRequest = { sessionToken: string; organizationId: Id };
export type Change = { expectedRevision: number; idempotencyKey: string };
export type Page<T> = { items: T[]; total: number; nextCursor: string | null; limit: number };
export type PageInput = { cursor?: string; limit?: number; status?: string };

export type IntegrationState =
  | "unconfigured"
  | "authorization_required"
  | "active"
  | "paused"
  | "reconnect_required"
  | "failed"
  | "disconnected";
export type ReceiptState =
  "queued" | "processing" | "needs_review" | "linked_lead" | "rejected" | "failed" | "blocked";
export type SafeIssue = {
  code: string;
  message: string;
  retryable: boolean;
  occurredAt: IsoTime;
  correlationId: string | null;
};
export type IntegrationPermissions = {
  canViewStatus: boolean;
  canConfigure: boolean;
  canAuthorize: boolean;
  canOperate: boolean;
  canReadSource: boolean;
  canReprocess: boolean;
};
export type GmailSelection = {
  kind: "label";
  labelId: string;
  labelName: string; // Provider-validated snapshot; arbitrary labels are not created.
  start: { kind: "from_now" } | { kind: "bounded_backfill"; after: IsoTime; maxMessages: number };
  cadenceMinutes: number;
};
export type GmailConfiguration = {
  displayName: string;
  selection: GmailSelection | null; // Null until authorized label selection.
  mappingId: Id | null;
  mappingVersion: number | null;
};
export type IntegrationConnection = {
  id: Id;
  revision: number;
  generation: number;
  configurationVersion: number;
  provider: "google-gmail";
  mode: "live" | "local_fixture";
  state: IntegrationState;
  displayName: string;
  account: { subject: string; email: string } | null;
  grantedScopes: string[];
  authorizedByIdentityId: Id | null;
  authorizedMembershipVersion: number | null;
  configuration: GmailConfiguration;
  coverage:
    | "not_started"
    | "complete_to_checkpoint"
    | "backfill_in_progress"
    | "resync_required"
    | "incomplete";
  checkpoint: { historyId: string | null; pagePending: boolean };
  lastAttemptAt: IsoTime | null;
  lastSuccessAt: IsoTime | null;
  nextEligibleAt: IsoTime | null;
  lastIssue: SafeIssue | null;
  counts: { receipts: number; linkedLeads: number; needsReview: number; failed: number };
};

/** Published form fields refer only to supported intake types, never directory IDs,
 * actor/role/status/readiness or arbitrary internal object paths. */
export type FormBuiltin =
  | "title"
  | "contactName"
  | "contactEmail"
  | "contactPhone"
  | "customerName"
  | "siteName"
  | "siteAddress"
  | "details"
  | "requestedDeadlineAt"
  | "requestedVisitAt";
export type FormField = {
  key: string;
  target: { kind: "builtin"; field: FormBuiltin } | { kind: "custom"; fieldId: Id };
  label: string;
  type: "text" | "textarea" | "email" | "date" | "boolean" | "choice";
  required: boolean;
  maxLength: number | null;
  options: string[];
};
export type FormInput = {
  name: string;
  title: string;
  description: string;
  fields: FormField[];
  publishedServiceIds: Id[];
  confirmationText: string;
  mappingId: Id;
  mappingVersion: number;
};
export type InquiryForm = {
  id: Id;
  publicId: string;
  revision: number;
  generation: number;
  enabled: boolean;
  configurationVersion: number;
  input: FormInput;
  configuredByIdentityId: Id;
  configuredMembershipVersion: number;
  signedSource: { enabled: boolean; keyId: string | null; generation: number };
};
export type PublicInquiryForm = {
  publicId: string;
  version: number;
  title: string;
  description: string;
  fields: Pick<FormField, "key" | "label" | "type" | "required" | "maxLength" | "options">[];
  services: { id: Id; name: string; description: string }[]; // No price, directory or internal workflow key.
  confirmationText: string;
};
export type PublicInquiryInput = {
  configurationVersion: number;
  eventId: string; // Random caller-generated event identity, independent of authentication nonce.
  values: Record<string, string | boolean | null>;
  serviceId: Id | null;
};
export type PublicReceipt = {
  reference: string;
  status: "accepted" | "rejected";
  processing: "queued" | "pending_review" | "received";
  // No tenant, lead ID, member, error-body or original-source fields.
};

export type MappingSource =
  | { kind: "form_field"; key: string }
  | { kind: "gmail"; field: "subject" | "senderNameClaim" | "senderEmailClaim" | "plainText" }
  | { kind: "literal"; value: string };
export type MappingRule = {
  source: MappingSource;
  target: { kind: "builtin"; field: FormBuiltin } | { kind: "custom"; fieldId: Id };
  transform: "none" | "trim" | "collapse_whitespace" | "lowercase_email";
};
export type MappingInput = { name: string; sourceKind: "form" | "gmail"; rules: MappingRule[] };
export type MappingVersion = {
  id: Id;
  version: number;
  input: MappingInput;
  createdAt: IsoTime;
  createdByIdentityId: Id;
};
export type SourceReceiptSummary = {
  id: Id;
  reference: string;
  revision: number;
  sourceKind: "public_form" | "signed_form" | "gmail";
  sourceId: Id;
  providerAccountId: Id | null;
  externalEventId: string;
  receivedAt: IsoTime;
  providerAt: IsoTime | null;
  contentSha256: Hash;
  state: ReceiptState;
  mappingId: Id;
  mappingVersion: number;
  processingAttempts: number;
  linkedLeadId: Id | null;
  linkedLeadVersion: number | null;
  reviewRequired: boolean;
  lastIssue: SafeIssue | null;
};
export type SourceReceiptDetail = SourceReceiptSummary & {
  original: {
    mediaType: string;
    bytes: number;
    sha256: Hash;
    sourceClaims: Record<string, string>;
    plainText: string | null;
    safeEvidenceAvailable: boolean;
    attachments: {
      name: string;
      mediaType: string;
      bytes: number;
      status: "not_ingested" | "unavailable";
    }[];
  };
  normalizations: {
    version: number;
    mappingId: Id;
    mappingVersion: number;
    fields: Record<string, string | boolean | null | Record<string, string | boolean | null>>;
    issues: SafeIssue[];
    createdAt: IsoTime;
  }[];
  attempts: {
    number: number;
    state: string;
    startedAt: IsoTime;
    finishedAt: IsoTime | null;
    issue: SafeIssue | null;
  }[];
  permissions: {
    canReadEvidence: boolean;
    canRetry: boolean;
    canReprocess: boolean;
    canOpenLead: boolean;
  };
};
export type IntegrationWorkspace = {
  permissions: IntegrationPermissions;
  connections: Page<IntegrationConnection>;
  forms: Page<InquiryForm>;
  mappings: MappingVersion[];
  counts: {
    queued: number;
    processing: number;
    needsReview: number;
    linkedLead: number;
    rejected: number;
    failed: number;
    blocked: number;
  };
  runtime: { providerMode: "disabled" | "local_fixture" | "live"; liveVerification: "deferred" };
};
