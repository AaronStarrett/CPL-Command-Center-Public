import { intakeText, type CplLeadEvidence, type CplLeadFields } from "./cpl-intake.js";

export const CPL_COMMERCIAL_CURRENCIES = ["USD", "CAD", "EUR", "GBP", "AUD", "NZD"] as const;
export type CplCommercialState =
  "draft" | "review" | "approved" | "revision_requested" | "lost" | "withdrawn" | "awarded";
export interface CplCommercialLineItem {
  description: string;
  serviceCode: string;
  quantity: string;
  unit: string;
  unitPriceMinor: number;
}
export interface CplCommercialSection {
  id: string;
  title: string;
  body: string;
}
export interface CplCommercialContent {
  title: string;
  summary: string;
  scope: string;
  schedule: string;
  deliverables: string;
  assumptions: string;
  exclusions: string;
  terms: string;
  paymentTerms: string;
  customerNotes: string;
  currency: string;
  lineItems: CplCommercialLineItem[];
  discountMinor: number;
  taxBasisPoints: number;
  startDate: string | null;
  endDate: string | null;
  accessInstructions: string;
  constraints: string;
  sections: CplCommercialSection[];
}
export interface CplCommercialTotals {
  currency: string;
  lineTotalsMinor: number[];
  subtotalMinor: number;
  discountMinor: number;
  taxableMinor: number;
  taxMinor: number;
  totalMinor: number;
}
export interface CplCommercialBranding {
  revision: number;
  businessName: string;
  email: string;
  phone: string;
  address: string;
  logoDataUrl: string | null;
  defaultCurrency: string;
  discountEnabled: boolean;
  taxEnabled: boolean;
  accentColor: string;
}
export interface CplCommercialCatalogItem {
  serviceCode: string;
  description: string;
  unit: string;
  unitPriceMinor: number;
}
export interface CplCommercialTemplateInput {
  name: string;
  summary: string;
  scope: string;
  schedule: string;
  deliverables: string;
  assumptions: string;
  exclusions: string;
  terms: string;
  paymentTerms: string;
  catalog: CplCommercialCatalogItem[];
  sections: CplCommercialSection[];
}
export interface CplCommercialTemplate extends CplCommercialTemplateInput {
  id: string;
  organizationId: string;
  createdAt: string;
}
export interface CplCommercialSourceLead {
  id: string;
  version: number;
  fields: CplLeadFields;
  evidence: CplLeadEvidence[];
  capturedAt: string;
}
export interface CplCommercialVersion {
  version: number;
  content: CplCommercialContent;
  totals: CplCommercialTotals;
  sourceLead: CplCommercialSourceLead;
  branding: CplCommercialBranding;
  templateId: string | null;
  templateSnapshot: CplCommercialTemplate | null;
  createdAt: string;
  createdByIdentityId: string;
}
export interface CplCommercialProposalSummary {
  id: string;
  organizationId: string;
  reference: string;
  leadId: string;
  legacyDraftId: string | null;
  title: string;
  state: CplCommercialState;
  revision: number;
  currentVersion: number;
  approvedVersion: number | null;
  createdAt: string;
  updatedAt: string;
}
export interface CplCommercialEvent {
  id: string;
  action: string;
  version: number;
  revision: number;
  reason: string | null;
  reasonCode: CplCommercialLostReason | null;
  note: string | null;
  actorIdentityId: string;
  createdAt: string;
}
export const CPL_COMMERCIAL_LOST_REASONS = [
  "price",
  "competitor",
  "timing",
  "scope_changed",
  "no_response",
  "other",
] as const;
export type CplCommercialLostReason = (typeof CPL_COMMERCIAL_LOST_REASONS)[number];
export interface CplCommercialOutcome {
  outcome: "lost" | "withdrawn" | "awarded";
  reasonCode: CplCommercialLostReason | null;
  note: string | null;
  version: number;
  actorIdentityId: string;
  createdAt: string;
}
export interface CplCommercialAwardInput {
  awardDate: string;
  amountMinor: number;
  currency: string;
  purchaseOrder: string;
  startDate: string | null;
  notes: string;
}
export interface CplCommercialAward extends CplCommercialAwardInput {
  id: string;
  proposalId: string;
  proposalVersion: number;
  actorIdentityId: string;
  createdAt: string;
}
export interface CplCommercialArtifact {
  id: string;
  proposalId: string;
  version: number;
  projectionSha256: string;
  sha256: string;
  byteLength: number;
  rendererVersion: string;
  createdAt: string;
}
export interface CplCommercialProjectSnapshot {
  internalNotes: string;
  proposalReference: string;
  version: CplCommercialVersion;
  award: CplCommercialAward;
}
export interface CplCommercialProject {
  id: string;
  organizationId: string;
  reference: string;
  awardId: string;
  proposalId: string;
  proposalVersion: number;
  leadId: string;
  snapshot: CplCommercialProjectSnapshot;
  createdByIdentityId: string;
  createdAt: string;
}
export interface CplCommercialProposal extends CplCommercialProposalSummary {
  outcome: CplCommercialOutcome | null;
  internalNotes: string;
  versions: CplCommercialVersion[];
  events: CplCommercialEvent[];
  artifacts: CplCommercialArtifact[];
  award: CplCommercialAward | null;
  project: CplCommercialProject | null;
}
export interface CplCommercialPermissions {
  canEdit: boolean;
  canReview: boolean;
  canAward: boolean;
  canCreateProject: boolean;
  canConfigure: boolean;
}
/** Explicit customer projection. Contains no provenance notes, internal notes or actor IDs. */
export interface CplApprovedProposalPdf {
  proposalId: string;
  reference: string;
  version: number;
  approvedAt: string;
  company: Pick<
    CplCommercialBranding,
    "businessName" | "email" | "phone" | "address" | "logoDataUrl" | "accentColor"
  >;
  customer: {
    name: string;
    contactName: string;
    contactEmail: string | null;
    contactPhone: string;
  };
  site: { name: string; address: string };
  content: Omit<CplCommercialContent, "accessInstructions" | "constraints">;
  totals: CplCommercialTotals;
}
export interface CplCommercialCustomerPreview {
  approved: boolean;
  state: CplCommercialState;
  document: CplApprovedProposalPdf;
}
export class CplCommercialValidationError extends Error {
  readonly code = "CPL_INVALID_INPUT";
  constructor() {
    super("CPL_INVALID_INPUT");
    this.name = "CplCommercialValidationError";
  }
}
function invalid(): never {
  throw new CplCommercialValidationError();
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function string(value: unknown, maximum = 20000) {
  return intakeText(value ?? "", maximum);
}
const MAX_MONEY = 1_000_000_000_000;
export function cplCommercialMoney(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_MONEY)
    invalid();
  return value;
}
export function cplCommercialDate(value: unknown, required = false): string | null {
  if (!required && (value === null || value === undefined || value === "")) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) invalid();
  const time = Date.parse(value + "T00:00:00.000Z");
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) invalid();
  return value;
}
function sections(value: unknown): CplCommercialSection[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 30) invalid();
  const result = value.map((item) => {
    const row = object(item);
    const id = intakeText(row.id, 80, true);
    if (!/^[A-Za-z0-9_-]+$/u.test(id)) invalid();
    return { id, title: intakeText(row.title, 240, true), body: intakeText(row.body, 20000) };
  });
  if (new Set(result.map((x) => x.id)).size !== result.length) invalid();
  return result;
}
function currency(value: unknown): string {
  if (!(CPL_COMMERCIAL_CURRENCIES as readonly unknown[]).includes(value)) invalid();
  return value as string;
}
function quantity(value: unknown): string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,5})(?:\.\d{1,3})?$/u.test(value)) invalid();
  const [whole, fraction = ""] = value.split(".");
  if (BigInt(whole!) * 1000n + BigInt(fraction.padEnd(3, "0")) <= 0n) invalid();
  return value;
}
export function normalizeCplCommercialContent(
  input: unknown,
  config: Pick<CplCommercialBranding, "discountEnabled" | "taxEnabled" | "defaultCurrency">,
): CplCommercialContent {
  const v = object(input);
  if (!Array.isArray(v.lineItems) || v.lineItems.length > 100) invalid();
  const lineItems = v.lineItems.map((item) => {
    const row = object(item);
    return {
      description: intakeText(row.description, 2000, true),
      serviceCode: string(row.serviceCode, 120),
      quantity: quantity(row.quantity),
      unit: intakeText(row.unit, 80, true),
      unitPriceMinor: cplCommercialMoney(row.unitPriceMinor),
    };
  });
  const discountMinor = cplCommercialMoney(v.discountMinor ?? 0),
    taxBasisPoints = v.taxBasisPoints ?? 0;
  if (
    typeof taxBasisPoints !== "number" ||
    !Number.isSafeInteger(taxBasisPoints) ||
    taxBasisPoints < 0 ||
    taxBasisPoints > 10000 ||
    (!config.discountEnabled && discountMinor !== 0) ||
    (!config.taxEnabled && taxBasisPoints !== 0)
  )
    invalid();
  const content: CplCommercialContent = {
    title: intakeText(v.title, 240, true),
    summary: string(v.summary),
    scope: string(v.scope),
    schedule: string(v.schedule),
    deliverables: string(v.deliverables),
    assumptions: string(v.assumptions),
    exclusions: string(v.exclusions),
    terms: string(v.terms),
    paymentTerms: string(v.paymentTerms),
    customerNotes: string(v.customerNotes),
    currency: currency(v.currency ?? config.defaultCurrency),
    lineItems,
    discountMinor,
    taxBasisPoints,
    startDate: cplCommercialDate(v.startDate),
    endDate: cplCommercialDate(v.endDate),
    accessInstructions: string(v.accessInstructions),
    constraints: string(v.constraints),
    sections: sections(v.sections),
  };
  if (content.startDate && content.endDate && content.startDate > content.endDate) invalid();
  calculateCplCommercialTotals(content);
  return content;
}
/** Integer minor units and thousandths of quantity, half-up rounding per line and on tax. */
export function calculateCplCommercialTotals(content: CplCommercialContent): CplCommercialTotals {
  currency(content.currency);
  const bounded = (n: bigint): number => {
    if (n < 0n || n > BigInt(MAX_MONEY)) invalid();
    return Number(n);
  };
  const lineTotalsMinor = content.lineItems.map((row) => {
    const [whole, fraction = ""] = quantity(row.quantity).split(".");
    const scaled = BigInt(whole!) * 1000n + BigInt(fraction.padEnd(3, "0"));
    return bounded((scaled * BigInt(cplCommercialMoney(row.unitPriceMinor)) + 500n) / 1000n);
  });
  const subtotalMinor = bounded(lineTotalsMinor.reduce((sum, n) => sum + BigInt(n), 0n));
  const discountMinor = cplCommercialMoney(content.discountMinor);
  if (
    discountMinor > subtotalMinor ||
    !Number.isSafeInteger(content.taxBasisPoints) ||
    content.taxBasisPoints < 0 ||
    content.taxBasisPoints > 10000
  )
    invalid();
  const taxableMinor = subtotalMinor - discountMinor;
  const taxMinor = bounded(
    (BigInt(taxableMinor) * BigInt(content.taxBasisPoints) + 5000n) / 10000n,
  );
  return {
    currency: content.currency,
    lineTotalsMinor,
    subtotalMinor,
    discountMinor,
    taxableMinor,
    taxMinor,
    totalMinor: bounded(BigInt(taxableMinor) + BigInt(taxMinor)),
  };
}
export function defaultCplCommercialBranding(): CplCommercialBranding {
  return {
    revision: 0,
    businessName: "",
    email: "",
    phone: "",
    address: "",
    logoDataUrl: null,
    defaultCurrency: "USD",
    discountEnabled: false,
    taxEnabled: false,
    accentColor: "#155E75",
  };
}
/** Inline raster only. No remote URLs, SVG or filesystem paths are accepted. */
export function validateCplCommercialLogo(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 175000) invalid();
  const matched = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(value);
  if (!matched || matched[2]!.length % 4 !== 0) invalid();
  let bytes: string;
  try {
    bytes = atob(matched[2]!);
  } catch {
    invalid();
  }
  if (bytes.length > 131072 || bytes.length < 24 || btoa(bytes) !== matched[2]) invalid();
  const u = (i: number) => bytes.charCodeAt(i);
  let width = 0,
    height = 0;
  if (matched[1] === "png") {
    if (
      [137, 80, 78, 71, 13, 10, 26, 10].some((n, i) => u(i) !== n) ||
      bytes.slice(12, 16) !== "IHDR"
    )
      invalid();
    const n = (i: number) => u(i) * 16777216 + u(i + 1) * 65536 + u(i + 2) * 256 + u(i + 3);
    width = n(16);
    height = n(20);
  } else {
    if (u(0) !== 255 || u(1) !== 216) invalid();
    for (let p = 2; p + 3 < bytes.length;) {
      if (u(p) !== 255) invalid();
      const marker = u(p + 1),
        length = u(p + 2) * 256 + u(p + 3);
      if (length < 2 || p + 2 + length > bytes.length) invalid();
      if ([192, 193, 194].includes(marker)) {
        height = u(p + 5) * 256 + u(p + 6);
        width = u(p + 7) * 256 + u(p + 8);
        break;
      }
      if (marker === 218 || marker === 217) break;
      p += 2 + length;
    }
  }
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 2048 ||
    height > 2048
  )
    invalid();
  return value;
}
export function normalizeCplCommercialBranding(
  input: unknown,
  revision: number,
): CplCommercialBranding {
  const v = object(input);
  if (typeof v.discountEnabled !== "boolean" || typeof v.taxEnabled !== "boolean") invalid();
  const email = string(v.email, 254);
  if (typeof v.accentColor !== "string" || !/^#[0-9a-f]{6}$/iu.test(v.accentColor)) invalid();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) invalid();
  return {
    revision,
    businessName: intakeText(v.businessName, 240, true),
    email,
    phone: string(v.phone, 80),
    address: string(v.address, 2000),
    logoDataUrl: validateCplCommercialLogo(v.logoDataUrl),
    defaultCurrency: currency(v.defaultCurrency),
    discountEnabled: v.discountEnabled,
    taxEnabled: v.taxEnabled,
    accentColor: v.accentColor.toUpperCase(),
  };
}
export function normalizeCplCommercialTemplate(input: unknown): CplCommercialTemplateInput {
  const v = object(input);
  if (!Array.isArray(v.catalog) || v.catalog.length > 100) invalid();
  const catalog = v.catalog.map((item) => {
    const row = object(item);
    return {
      serviceCode: intakeText(row.serviceCode, 120, true),
      description: intakeText(row.description, 2000, true),
      unit: intakeText(row.unit, 80, true),
      unitPriceMinor: cplCommercialMoney(row.unitPriceMinor),
    };
  });
  if (new Set(catalog.map((x) => x.serviceCode)).size !== catalog.length) invalid();
  return {
    name: intakeText(v.name, 240, true),
    summary: string(v.summary),
    scope: string(v.scope),
    schedule: string(v.schedule),
    deliverables: string(v.deliverables),
    assumptions: string(v.assumptions),
    exclusions: string(v.exclusions),
    terms: string(v.terms),
    paymentTerms: string(v.paymentTerms),
    catalog,
    sections: sections(v.sections),
  };
}
