import { intakeId, intakeText, type CplLeadFields } from "./cpl-intake.js";
import { CPL_COMMERCIAL_CURRENCIES } from "./cpl-commercial.js";
import type { CplCommercialBranding, CplCommercialTemplate } from "./cpl-commercial.js";
import type { CplFieldTemplateVersion } from "./cpl-field.js";
import type { CplReportBranding, CplReportTemplateVersion } from "./cpl-report.js";
import type { CplCloseoutPolicy } from "./cpl-delivery.js";
import { cplExecutionTimeZone } from "./cpl-execution.js";

export type CplCompanyStatus = "active" | "archived";
export interface CplCompanyProfile {
  displayName: string;
  legalName: string;
  email: string;
  phone: string;
  address: string;
  timeZone: string;
}
export interface CplCompanySetting<T> {
  version: number;
  input: T;
}
export interface CplCompanyPage<T> {
  items: T[];
  total: number;
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}
export type CplCompanyTemplateKind = "proposal" | "field" | "report";
export type CplCompanyTemplate =
  CplCommercialTemplate | CplFieldTemplateVersion | CplReportTemplateVersion;
export interface CplCompanyConfiguration {
  commercialBranding: CplCommercialBranding | null;
  reportBranding: CplReportBranding | null;
  modules: { proposal: boolean; field: boolean; report: boolean; delivery: boolean };
  closeoutPolicies: CplCloseoutPolicy[];
  closeoutPoliciesTruncated: boolean;
}
export interface CplCompanyListInput {
  q?: string;
  status?: CplCompanyStatus | "all";
  cursor?: string;
  limit?: number;
  customerId?: string;
}
export interface CplCatalogInput {
  code: string;
  name: string;
  description: string;
  unit: string;
  unitPriceMinor: number | null;
  currency: string;
  /** Fixed matching key. An explicit legacy key can be selected only at creation. */
  workflowKey: string;
}
export interface CplCatalogSnapshot extends CplCatalogInput {
  id: string;
  revision: number;
}
export interface CplCatalogItem extends CplCatalogSnapshot {
  organizationId: string;
  status: CplCompanyStatus;
  createdAt: string;
  updatedAt: string;
}
export const CPL_INTAKE_OPTIONAL_REQUIREMENTS = [
  "contactEmail",
  "contactPhone",
  "customerName",
  "siteName",
  "siteAddress",
  "requestedDeadlineAt",
  "requestedVisitAt",
] as const;
export type CplIntakeOptionalRequirement = (typeof CPL_INTAKE_OPTIONAL_REQUIREMENTS)[number];
export interface CplIntakeCustomField {
  id: string;
  label: string;
  type: "text" | "boolean" | "choice";
  required: boolean;
  options: string[];
  active: boolean;
}
export interface CplIntakePolicy {
  requiredFields: CplIntakeOptionalRequirement[];
  customFields: CplIntakeCustomField[];
}
export type CplIntakeCustomValues = Record<string, string | boolean | null>;
export interface CplLeadConfiguration {
  catalog: CplCatalogSnapshot | null;
  customValues: CplIntakeCustomValues;
  policyVersion: number;
  reviewedPolicyVersion: number | null;
  policy: CplIntakePolicy;
}
export type CplDirectoryKind = "customer" | "contact" | "site";
export interface CplDirectoryInput {
  name: string;
  customerId: string | null;
  email: string | null;
  phone: string;
  address: string;
}
export interface CplDirectoryEntry extends CplDirectoryInput {
  id: string;
  organizationId: string;
  kind: CplDirectoryKind;
  revision: number;
  status: CplCompanyStatus;
  createdAt: string;
  updatedAt: string;
}
export interface CplDirectoryDetail extends CplDirectoryEntry {
  revisions: {
    revision: number;
    snapshot: CplDirectoryInput;
    status: CplCompanyStatus;
    actorIdentityId: string;
    createdAt: string;
    reason: string | null;
  }[];
  duplicateCandidates: { id: string; name: string }[];
}
export interface CplCompanyAuditEvent {
  id: string;
  actorIdentityId: string | null;
  actorName: string;
  createdAt: string;
  action: string;
  resourceId: string | null;
  resourceType: string | null;
  version: number | null;
  summary: string;
  target: {
    kind: "customer" | "contact" | "site" | "catalog" | "profile" | "intake-policy";
    id: string | null;
  } | null;
}
export interface CplCompanyAuditFilters {
  action?: string;
  actorIdentityId?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}
export interface CplCompanyWorkspace {
  organizationId: string;
  profile: CplCompanySetting<CplCompanyProfile>;
  intakePolicy: CplCompanySetting<CplIntakePolicy>;
  defaultCurrency: string;
  setup: {
    status: "incomplete" | "configured" | "operationally_ready";
    checks: {
      key: string;
      status: "missing" | "saved" | "configured" | "ready" | "optional" | "disabled";
      message: string;
      blocking: boolean;
    }[];
  };
  permissions: {
    canConfigure: boolean;
    canReadDirectory: boolean;
    canWriteDirectory: boolean;
    canReadAudit: boolean;
  };
  readiness: {
    code: string;
    message: string;
    section: "profile" | "catalog" | "branding";
    blocking: boolean;
  }[];
}
export class CplCompanyValidationError extends Error {
  readonly code = "CPL_COMPANY_INVALID_INPUT";
  constructor() {
    super("CPL_COMPANY_INVALID_INPUT");
    this.name = "CplCompanyValidationError";
  }
}
function invalid(): never {
  throw new CplCompanyValidationError();
}
export function cplCompanyObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
export function cplCompanyRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid();
  return Number(value);
}
function text(value: unknown, maximum: number, required = false) {
  return intakeText(value ?? "", maximum, required);
}
function email(value: unknown): string {
  const result = text(value, 254);
  if (result && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(result)) invalid();
  return result;
}
export function normalizeCplCompanyProfile(value: unknown): CplCompanyProfile {
  const row = cplCompanyObject(value);
  return {
    displayName: text(row.displayName, 240, true),
    legalName: text(row.legalName, 240),
    email: email(row.email),
    phone: text(row.phone, 80),
    address: text(row.address, 2000),
    timeZone: cplExecutionTimeZone(row.timeZone),
  };
}
export function normalizeCplCatalogInput(value: unknown): CplCatalogInput {
  const row = cplCompanyObject(value),
    code = text(row.code, 80, true);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(code)) invalid();
  const price = row.unitPriceMinor;
  if (
    price !== null &&
    (!Number.isSafeInteger(price) || Number(price) < 0 || Number(price) > 1_000_000_000)
  )
    invalid();
  if (!(CPL_COMMERCIAL_CURRENCIES as readonly unknown[]).includes(row.currency)) invalid();
  return {
    code,
    name: text(row.name, 240, true),
    description: text(row.description, 2000),
    unit: text(row.unit, 80, true),
    unitPriceMinor: price as number | null,
    currency: row.currency as string,
    workflowKey: text(row.workflowKey ?? code, 2000, true),
  };
}
export function normalizeCplIntakePolicy(value: unknown): CplIntakePolicy {
  const row = cplCompanyObject(value);
  if (
    !Array.isArray(row.requiredFields) ||
    !Array.isArray(row.customFields) ||
    row.customFields.length > 20
  )
    invalid();
  const requiredFields = row.requiredFields.map((field) => {
    if (!(CPL_INTAKE_OPTIONAL_REQUIREMENTS as readonly unknown[]).includes(field)) invalid();
    return field as CplIntakeOptionalRequirement;
  });
  if (new Set(requiredFields).size !== requiredFields.length) invalid();
  const customFields = row.customFields.map((value) => {
    const field = cplCompanyObject(value),
      id = intakeId(field.id) ?? invalid();
    if (
      !["text", "boolean", "choice"].includes(String(field.type)) ||
      typeof field.required !== "boolean" ||
      typeof field.active !== "boolean" ||
      !Array.isArray(field.options)
    )
      invalid();
    const options = field.options.map((option) => text(option, 160, true));
    if (
      new Set(options).size !== options.length ||
      options.length > 30 ||
      (field.type === "choice" ? options.length < 1 : options.length !== 0)
    )
      invalid();
    return {
      id,
      label: text(field.label, 240, true),
      type: field.type as CplIntakeCustomField["type"],
      required: field.required,
      active: field.active,
      options,
    };
  });
  if (new Set(customFields.map((field) => field.id)).size !== customFields.length) invalid();
  return { requiredFields, customFields };
}
export function normalizeCplIntakeCustomValues(
  value: unknown,
  policy: CplIntakePolicy,
  prior: CplIntakeCustomValues = {},
): CplIntakeCustomValues {
  const input = cplCompanyObject(value),
    result = { ...prior };
  for (const [key, raw] of Object.entries(input)) {
    const field = policy.customFields.find((field) => field.id === key);
    if (!field || !field.active) invalid();
    if (raw === null || raw === "") {
      result[key] = null;
      continue;
    }
    if (field.type === "boolean") {
      if (typeof raw !== "boolean") invalid();
      result[key] = raw;
    } else {
      const textValue = text(raw, field.type === "text" ? 2000 : 160);
      if (field.type === "choice" && !field.options.includes(textValue)) invalid();
      result[key] = textValue;
    }
  }
  return result;
}
export function cplConfiguredIntakeIssues(
  fields: CplLeadFields,
  policy: CplIntakePolicy,
  values: CplIntakeCustomValues,
): { code: string; severity: "blocking"; message: string }[] {
  const issues: { code: string; severity: "blocking"; message: string }[] = [];
  const labels: Record<CplIntakeOptionalRequirement, string> = {
    contactEmail: "Contact email",
    contactPhone: "Contact phone",
    customerName: "Customer name",
    siteName: "Site name",
    siteAddress: "Site address",
    requestedDeadlineAt: "Requested deadline",
    requestedVisitAt: "Requested visit",
  };
  for (const key of policy.requiredFields)
    if (!fields[key])
      issues.push({
        code: `company.${key}`,
        severity: "blocking",
        message: `${labels[key]} is required by the company's intake policy.`,
      });
  for (const field of policy.customFields.filter((field) => field.active && field.required)) {
    const value = values[field.id];
    if (
      value === undefined ||
      value === null ||
      value === "" ||
      (field.type === "choice" && !field.options.includes(String(value)))
    )
      issues.push({
        code: `custom.${field.id}`,
        severity: "blocking",
        message: `${field.label} requires an answer.`,
      });
  }
  return issues;
}
export function normalizeCplDirectoryInput(
  kind: CplDirectoryKind,
  value: unknown,
): CplDirectoryInput {
  if (!["customer", "contact", "site"].includes(kind)) invalid();
  const row = cplCompanyObject(value);
  if (kind === "customer" && intakeId(row.customerId)) invalid();
  return {
    name: text(row.name, 240, true),
    customerId: kind === "customer" ? null : intakeId(row.customerId),
    email: kind === "contact" ? email(row.email) || null : null,
    phone: kind === "contact" ? text(row.phone, 80) : "",
    address: kind === "site" ? text(row.address, 2000) : "",
  };
}
