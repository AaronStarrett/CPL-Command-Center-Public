import { cplExecutionId, cplExecutionRevision } from "./cpl-execution.js";
import { cplFieldObject, cplFieldText } from "./cpl-field.js";

export type CplDeliveryState = "draft" | "ready" | "exported" | "manually_sent" | "acknowledged";
export interface CplDeliveryAttachmentSelection {
  reportId: string;
  version: number;
}
export interface CplDeliveryInput {
  customerName: string;
  contactName: string;
  recipient: string;
  subject: string;
  message: string;
  attachments: CplDeliveryAttachmentSelection[];
}
export interface CplDeliveryAttachment extends CplDeliveryAttachmentSelection {
  reference: string;
  title: string;
  sha256: string;
  byteLength: number;
  approvedAt: string;
}
export interface CplDeliveryVersion {
  version: number;
  input: CplDeliveryInput;
  attachments: CplDeliveryAttachment[];
  preparedByIdentityId: string;
  preparedAt: string;
  state: CplDeliveryState;
}
export interface CplDeliveryEvent {
  id: string;
  version: number;
  action: string;
  actorIdentityId: string;
  createdAt: string;
  details: Record<string, unknown>;
}
export interface CplDeliveryPackage {
  id: string;
  projectId: string;
  reference: string;
  revision: number;
  currentVersion: number;
  state: CplDeliveryState;
  versions: CplDeliveryVersion[];
  events: CplDeliveryEvent[];
  readiness: { ready: boolean; canMarkReady: boolean; reasons: string[] };
}
export interface CplDeliveryPermissions {
  canWrite: boolean;
  canConfirm: boolean;
  canConfigure: boolean;
  canOverride: boolean;
  canWithdrawApproval: boolean;
}
export interface CplDeliveryApprovedOption extends CplDeliveryAttachment {
  withdrawn: boolean;
  withdrawalReason: string | null;
  latestEditableVersion: number;
}
export interface CplCloseoutPolicyInput {
  serviceKey: string;
  name: string;
  requireAward: boolean;
  requireWorkCompleted: boolean;
  requireApprovedReport: boolean;
  requireDelivery: boolean;
  requirePurchaseOrder: boolean;
  requireIssuesDisposed: boolean;
}
export interface CplCloseoutPolicy extends CplCloseoutPolicyInput {
  version: number;
  createdAt: string;
  createdByIdentityId: string;
}
export interface CplCloseoutFactsInput {
  purchaseOrder: string;
  requiredReport: CplDeliveryAttachmentSelection | null;
  issueDispositions: {
    sourceKey: string;
    factHash: string;
    disposition: "resolved" | "accepted";
    reason: string;
  }[];
  manualIssues: {
    id: string;
    title: string;
    status: "open" | "resolved" | "accepted";
    reason: string;
  }[];
}
export interface CplCloseoutFacts extends CplCloseoutFactsInput {
  revision: number;
}
export type CplCloseoutFactKey =
  "award" | "work" | "report" | "delivery" | "purchase_order" | "issues";
export interface CplCloseoutIssue {
  sourceKey: string;
  factHash: string;
  title: string;
  disposed: boolean;
  reason: string | null;
}
export interface CplCloseoutCheck {
  key: CplCloseoutFactKey;
  required: boolean;
  met: boolean;
  message: string;
  evidenceHash: string;
  override: { reason: string; actorIdentityId: string; createdAt: string } | null;
}
export interface CplCloseoutReadiness {
  status: "not_configured" | "blocked" | "ready";
  policy: CplCloseoutPolicy | null;
  projectStatus: string;
  operationalCompletion: boolean;
  deliveryRecorded: boolean;
  agreedAmount: {
    label: "Agreed amount";
    amountMinor: number;
    currency: string;
    proposalReference: string;
    proposalVersion: number;
  };
  checks: CplCloseoutCheck[];
  issues: CplCloseoutIssue[];
  facts: CplCloseoutFacts;
  evaluatedAt: string;
  invoiceIssued: "not_tracked";
  paymentReceived: "not_tracked";
}
export interface CplDeliveryWorkspace {
  project: {
    id: string;
    reference: string;
    name: string;
    customerName: string;
    serviceKey: string;
    contactName: string;
    contactEmail: string | null;
  };
  approvedReports: CplDeliveryApprovedOption[];
  packages: CplDeliveryPackage[];
  policies: CplCloseoutPolicy[];
  readiness: CplCloseoutReadiness;
  permissions: CplDeliveryPermissions;
}
export interface CplManualDeliveryInput {
  sentAt: string;
  channel: string;
  recipient: string;
  reference: string;
  note: string;
}
export interface CplDeliveryAcknowledgmentInput {
  acknowledgedAt: string;
  evidence: string;
}
export class CplDeliveryValidationError extends Error {
  readonly code = "CPL_DELIVERY_INVALID_INPUT";
  constructor() {
    super("CPL_DELIVERY_INVALID_INPUT");
    this.name = "CplDeliveryValidationError";
  }
}
function fail(): never {
  throw new CplDeliveryValidationError();
}
function single(value: unknown, max = 240, required = false): string {
  const result = cplFieldText(value, max, required);
  if (/[\r\n\u007f]/u.test(result)) fail();
  return result;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") fail();
  return value;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail();
  return value;
}
export function cplDeliverySelection(value: unknown): CplDeliveryAttachmentSelection {
  const v = cplFieldObject(value);
  const version = cplExecutionRevision(v.version);
  if (version < 1) fail();
  return { reportId: cplExecutionId(v.reportId), version };
}
export function normalizeCplDeliveryInput(value: unknown): CplDeliveryInput {
  const v = cplFieldObject(value);
  const attachments = list(v.attachments, 10).map(cplDeliverySelection);
  if (
    !attachments.length ||
    new Set(attachments.map((x) => `${x.reportId}:${x.version}`)).size !== attachments.length
  )
    fail();
  return {
    customerName: single(v.customerName, 240, true),
    contactName: single(v.contactName),
    recipient: single(v.recipient, 320),
    subject: single(v.subject, 240, true),
    message: cplFieldText(v.message, 20000),
    attachments,
  };
}
export function normalizeCplCloseoutPolicy(value: unknown): CplCloseoutPolicyInput {
  const v = cplFieldObject(value),
    serviceKey = single(v.serviceKey, 240, true);
  return {
    serviceKey,
    name: single(v.name, 240, true),
    requireAward: bool(v.requireAward),
    requireWorkCompleted: bool(v.requireWorkCompleted),
    requireApprovedReport: bool(v.requireApprovedReport),
    requireDelivery: bool(v.requireDelivery),
    requirePurchaseOrder: bool(v.requirePurchaseOrder),
    requireIssuesDisposed: bool(v.requireIssuesDisposed),
  };
}
export function normalizeCplCloseoutFacts(value: unknown): CplCloseoutFactsInput {
  const v = cplFieldObject(value);
  const issueDispositions = list(v.issueDispositions, 300).map((item) => {
    const d = cplFieldObject(item),
      sourceKey = single(d.sourceKey, 160, true),
      factHash = single(d.factHash, 64, true);
    if (
      !/^[a-f0-9]{64}$/u.test(factHash) ||
      !["resolved", "accepted"].includes(String(d.disposition))
    )
      fail();
    return {
      sourceKey,
      factHash,
      disposition: d.disposition as "resolved" | "accepted",
      reason: cplFieldText(d.reason, 2000, true),
    };
  });
  const manualIssues = list(v.manualIssues, 100).map((item) => {
    const d = cplFieldObject(item),
      status = String(d.status);
    if (!["open", "resolved", "accepted"].includes(status)) fail();
    return {
      id: cplExecutionId(d.id),
      title: single(d.title, 240, true),
      status: status as "open" | "resolved" | "accepted",
      reason: cplFieldText(d.reason, 2000, status !== "open"),
    };
  });
  if (
    new Set(issueDispositions.map((x) => x.sourceKey)).size !== issueDispositions.length ||
    new Set(manualIssues.map((x) => x.id)).size !== manualIssues.length
  )
    fail();
  return {
    purchaseOrder: single(v.purchaseOrder, 240),
    requiredReport: v.requiredReport == null ? null : cplDeliverySelection(v.requiredReport),
    issueDispositions,
    manualIssues,
  };
}
export function cplDeliveryInstant(value: unknown, now = Date.now()): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/u.test(value)
  )
    fail();
  const day = new Date(value.slice(0, 10) + "T00:00:00Z");
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value.slice(0, 10))
    fail();
  const stamp = Date.parse(value);
  if (!Number.isFinite(stamp) || stamp > now || stamp < 0) fail();
  return new Date(stamp).toISOString();
}
export function normalizeCplManualDelivery(value: unknown, now?: number): CplManualDeliveryInput {
  const v = cplFieldObject(value);
  return {
    sentAt: cplDeliveryInstant(v.sentAt, now),
    channel: single(v.channel, 120, true),
    recipient: single(v.recipient, 320, true),
    reference: single(v.reference, 500),
    note: cplFieldText(v.note, 2000),
  };
}
/** Explicit allowlist. No paths, source notes, actor IDs or raw evidence enter the export. */
export function cplDeliveryPublicManifest(pkg: CplDeliveryPackage, version: number) {
  const selected = pkg.versions.find((v) => v.version === version);
  if (!selected) fail();
  return {
    disclosure: "Prepared delivery package. Export is not sending or customer acknowledgment.",
    reference: pkg.reference,
    version: selected.version,
    customerName: selected.input.customerName,
    contactName: selected.input.contactName,
    recipient: selected.input.recipient,
    subject: selected.input.subject,
    message: selected.input.message,
    attachments: selected.attachments.map((a) => ({
      reference: a.reference,
      version: a.version,
      title: a.title,
      sha256: a.sha256,
      byteLength: a.byteLength,
      approvedAt: a.approvedAt,
    })),
  };
}
export function cplDeliveryMessageText(pkg: CplDeliveryPackage, version: number): string {
  const v = cplDeliveryPublicManifest(pkg, version);
  return `To: ${v.recipient}\nSubject: ${v.subject}\n\n${v.message}\n\nAttachments:\n${v.attachments.map((a) => `${a.reference} v${a.version} — ${a.title}`).join("\n")}\n`;
}
export function cplBillingHandoff(
  project: CplDeliveryWorkspace["project"],
  readiness: CplCloseoutReadiness,
) {
  return {
    disclosure:
      "Internal readiness handoff only. Not an invoice, tax determination, payment request or receipt.",
    projectReference: project.reference,
    projectName: project.name,
    customerName: project.customerName,
    readiness: readiness.status,
    policy: readiness.policy
      ? {
          name: readiness.policy.name,
          serviceKey: readiness.policy.serviceKey,
          version: readiness.policy.version,
        }
      : null,
    agreedAmount: {
      label: readiness.agreedAmount.label,
      amountMinor: readiness.agreedAmount.amountMinor,
      currency: readiness.agreedAmount.currency,
      proposalReference: readiness.agreedAmount.proposalReference,
      proposalVersion: readiness.agreedAmount.proposalVersion,
    },
    purchaseOrder: readiness.facts.purchaseOrder,
    invoiceIssued: "not_tracked",
    paymentReceived: "not_tracked",
    checks: readiness.checks.map((c) => ({
      requirement: c.key,
      required: c.required,
      met: c.met,
      explanation: c.message,
      overrideReason: c.override?.reason ?? null,
    })),
    evaluatedAt: readiness.evaluatedAt,
  };
}
