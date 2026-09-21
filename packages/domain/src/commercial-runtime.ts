import type { JsonObject, JsonValue } from "./entities.js";
import {
  CATALOG_FAMILY_KEYS,
  COMMERCIAL_CONTRACT_VERSION,
  COMMERCIAL_PRODUCTION_UNCONFIGURED,
  COMMERCIAL_SYNTHETIC_DISCLOSURE,
  PROPOSAL_TEMPLATE_KEYS,
  SERVICE_PRICING_MODELS,
  SYNTHETIC_PROPOSAL_SENDER,
  assertCurrencyCode,
  CommercialValidationError,
  type CatalogFamilyKey,
  type CatalogValidationIssue,
  type CommercialApprovalPolicy,
  type CommercialTermsPolicy,
  type DeliveryManifestPolicy,
  type ProposalStatus,
  type ProposalTemplateDefinition,
  type ProposalTemplateKey,
  type ServiceCatalogItemDefinition,
  type ServiceCatalogPackage,
  type ServicePricingModel,
} from "./commercial.js";
import type { WorkItemKind } from "./work-control.js";

export const COMMERCIAL_SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER;
export const COMMERCIAL_SAFE_INTEGER_MIN = 0;
export const MAX_CATALOG_VALIDATION_ISSUES = 48;
export const MAX_COMMERCIAL_KEY_LENGTH = 120;
export const MAX_COMMERCIAL_NAME_LENGTH = 240;
export const MAX_COMMERCIAL_TEXT_LENGTH = 8_000;
export const MAX_COMMERCIAL_NOTE_LENGTH = 2_000;
export const MAX_COMMERCIAL_ARRAY_LENGTH = 64;
export const MAX_VALIDITY_DAYS = 3_650;
export const SUPPORTED_PROPOSAL_RENDERER = "bea.deterministic-synthetic-pdf.v1";
export const COMMERCIAL_PREPARER_ROLE = "sales";
export const COMMERCIAL_REVIEWER_ROLE = "owner-admin";
export const COMMERCIAL_OVERRIDE_APPROVER_ROLE = "owner-admin";

export const SALES_COMMERCIAL_WORK_KINDS = [
  "proposal_preparation",
  "proposal_information",
  "proposal_revision",
  "proposal_delivery_preparation",
] as const satisfies readonly WorkItemKind[];
export type SalesCommercialWorkKind = (typeof SALES_COMMERCIAL_WORK_KINDS)[number];

export const OVERRIDE_MUTABLE_PROPOSAL_STATUSES: readonly ProposalStatus[] = [
  "draft",
  "needs_information",
  "ready_for_review",
  "revision_required",
];

const POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const FORBIDDEN_EXECUTION_KEYS = new Set([
  "formula",
  "formulas",
  "script",
  "scripts",
  "function",
  "functions",
  "functionName",
  "handler",
  "javascript",
  "js",
  "sql",
  "expression",
  "expressions",
  "eval",
  "code",
  "wasm",
  "callback",
  "transformFn",
  "arbitraryFormula",
  "executable",
]);
const SCRIPTISH = /(?:<\s*script\b|javascript:|\beval\s*\(|\bFunction\s*\()/iu;
const CREDENTIAL_KEY = /password|secret|token|apikey|credential|private[_-]?key/iu;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/u;

const CATALOG_KEYS = [
  "catalogKey",
  "displayName",
  "serviceContextKey",
  "currency",
  "synthetic",
  "productionReady",
  "disclosure",
  "items",
  "terms",
  "approval",
  "template",
  "delivery",
] as const;
const ITEM_KEYS = [
  "serviceKey",
  "serviceCode",
  "displayName",
  "description",
  "scopeTemplate",
  "defaultDeliverables",
  "defaultAssumptions",
  "defaultExclusions",
  "unitOfMeasure",
  "pricingModel",
  "defaultRateMinor",
  "minimumQuantityScaled",
  "maximumQuantityScaled",
  "eligibilityNotes",
  "requiredLeadInformation",
  "options",
  "effectiveFrom",
  "effectiveTo",
  "active",
  "displayOrder",
  "synthetic",
] as const;
const TERMS_KEYS = [
  "templateKey",
  "validityDays",
  "termsText",
  "acceptanceLanguage",
  "taxConfigured",
  "taxBps",
  "discountConfigured",
  "selfApprovalAllowed",
  "productionConfirmed",
  "disclosure",
] as const;
const APPROVAL_KEYS = [
  "preparerRole",
  "reviewerRole",
  "overrideApproverRole",
  "selfApprovalAllowed",
  "overrideThresholdMinor",
  "productionConfirmed",
  "disclosure",
] as const;
const TEMPLATE_KEYS = [
  "templateKey",
  "displayName",
  "rendererAdapter",
  "coverTitle",
  "introText",
  "sectionOrder",
  "footerText",
  "synthetic",
  "disclosure",
] as const;
const DELIVERY_KEYS = [
  "senderMailbox",
  "subjectTemplate",
  "bodyTemplate",
  "requiredScopes",
  "liveWrites",
  "disclosure",
] as const;

export class CommercialCatalogValidationError extends Error {
  readonly code = "COMMERCIAL_CATALOG_VALIDATION";
  constructor(readonly issues: readonly CatalogValidationIssue[]) {
    const first = issues.find((item) => item.blocking) ?? issues[0];
    super(first?.message ?? "Catalog package failed runtime validation.");
    this.name = "CommercialCatalogValidationError";
  }
}

export interface CatalogParseSuccess {
  readonly ok: true;
  readonly value: ServiceCatalogPackage;
}

export interface CatalogParseFailure {
  readonly ok: false;
  readonly issues: readonly CatalogValidationIssue[];
}

export type CatalogParseResult = CatalogParseSuccess | CatalogParseFailure;

function issue(
  code: string,
  message: string,
  path?: string,
  blocking = true,
): CatalogValidationIssue {
  return path ? { code, message, blocking, path } : { code, message, blocking };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function objectKeys(value: Record<string, unknown>): readonly string[] {
  return Reflect.ownKeys(value).filter((key): key is string => typeof key === "string");
}

function collectKeyProblems(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: CatalogValidationIssue[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of objectKeys(value)) {
    if (POLLUTION_KEYS.has(key)) {
      issues.push(
        issue(
          "prototype_pollution",
          `Prototype-pollution key '${key}' is not allowed on ${path}.`,
          `${path}.${key}`,
        ),
      );
      continue;
    }
    if (FORBIDDEN_EXECUTION_KEYS.has(key) || CREDENTIAL_KEY.test(key)) {
      issues.push(
        issue(
          "unknown_execution_property",
          `Unsupported execution-bearing property '${key}' is not allowed on ${path}.`,
          `${path}.${key}`,
        ),
      );
      continue;
    }
    if (!allowedSet.has(key)) {
      issues.push(
        issue(
          "unknown_execution_property",
          `Unknown property '${key}' is not part of the ${path} contract.`,
          `${path}.${key}`,
        ),
      );
    }
  }
}

function expectString(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
  options: { readonly min?: number; readonly max?: number; readonly nonempty?: boolean } = {},
): string {
  const max = options.max ?? MAX_COMMERCIAL_TEXT_LENGTH;
  const min = options.min ?? (options.nonempty === false ? 0 : 1);
  if (typeof value !== "string") {
    issues.push(issue("type", `${path} must be a string.`, path));
    return "";
  }
  if (SCRIPTISH.test(value)) {
    issues.push(
      issue("unknown_execution_property", `${path} contains unsupported script content.`, path),
    );
  }
  if (value.length < min || value.length > max) {
    issues.push(issue("bounds", `${path} must be between ${min} and ${max} characters.`, path));
  }
  if (options.nonempty !== false && !value.trim()) {
    issues.push(issue("required", `${path} is required.`, path));
  }
  return value;
}

function expectBoolean(value: unknown, path: string, issues: CatalogValidationIssue[]): boolean {
  if (typeof value !== "boolean") {
    issues.push(issue("type", `${path} must be a boolean.`, path));
    return false;
  }
  return value;
}

function expectSafeInteger(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
  options: { readonly min?: number; readonly max?: number } = {},
): number {
  const min = options.min ?? Number.MIN_SAFE_INTEGER;
  const max = options.max ?? COMMERCIAL_SAFE_INTEGER_MAX;
  if (typeof value === "bigint") {
    if (value > BigInt(COMMERCIAL_SAFE_INTEGER_MAX) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      issues.push(issue("unsafe_integer", `${path} exceeds the safe integer range.`, path));
      return 0;
    }
    value = Number(value);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push(issue("type", `${path} must be a finite number.`, path));
    return 0;
  }
  if (!Number.isInteger(value)) {
    issues.push(issue("type", `${path} must be an integer, not a floating-point value.`, path));
    return 0;
  }
  if (!Number.isSafeInteger(value)) {
    issues.push(issue("unsafe_integer", `${path} exceeds the safe integer range.`, path));
    return 0;
  }
  if (value < min || value > max) {
    issues.push(issue("bounds", `${path} is outside the permitted range.`, path));
  }
  return value;
}

function expectStringArray(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
  options: { readonly maxItemLength?: number } = {},
): string[] {
  if (!Array.isArray(value)) {
    issues.push(issue("type", `${path} must be an array of strings.`, path));
    return [];
  }
  if (value.length > MAX_COMMERCIAL_ARRAY_LENGTH) {
    issues.push(
      issue(
        "bounds",
        `${path} cannot contain more than ${MAX_COMMERCIAL_ARRAY_LENGTH} entries.`,
        path,
      ),
    );
  }
  const items: string[] = [];
  value.forEach((entry, index) => {
    items.push(
      expectString(entry, `${path}[${index}]`, issues, {
        min: 1,
        max: options.maxItemLength ?? MAX_COMMERCIAL_NOTE_LENGTH,
      }),
    );
  });
  return items;
}

function expectIsoDate(
  value: unknown,
  path: string,
  issues: CatalogValidationIssue[],
  optional: boolean,
): string | null {
  if (value === null || value === undefined) {
    if (!optional) issues.push(issue("required", `${path} is required.`, path));
    return null;
  }
  if (typeof value !== "string" || !ISO_DATE.test(value) || !Number.isFinite(Date.parse(value))) {
    issues.push(issue("effective_date", `${path} must be a valid ISO-8601 timestamp.`, path));
    return null;
  }
  return value;
}

function parseItem(
  value: unknown,
  path: string,
  catalogSynthetic: boolean,
  issues: CatalogValidationIssue[],
): ServiceCatalogItemDefinition | null {
  if (!isPlainObject(value)) {
    issues.push(issue("type", `${path} must be an object.`, path));
    return null;
  }
  collectKeyProblems(value, ITEM_KEYS, path, issues);
  const serviceKey = expectString(value.serviceKey, `${path}.serviceKey`, issues, {
    max: MAX_COMMERCIAL_KEY_LENGTH,
  });
  const serviceCode = expectString(value.serviceCode, `${path}.serviceCode`, issues, {
    max: MAX_COMMERCIAL_KEY_LENGTH,
  });
  const displayName = expectString(value.displayName, `${path}.displayName`, issues, {
    max: MAX_COMMERCIAL_NAME_LENGTH,
  });
  const description = expectString(value.description, `${path}.description`, issues);
  const scopeTemplate = expectString(value.scopeTemplate, `${path}.scopeTemplate`, issues);
  const defaultDeliverables = expectStringArray(
    value.defaultDeliverables,
    `${path}.defaultDeliverables`,
    issues,
  );
  const defaultAssumptions = expectStringArray(
    value.defaultAssumptions,
    `${path}.defaultAssumptions`,
    issues,
  );
  const defaultExclusions = expectStringArray(
    value.defaultExclusions,
    `${path}.defaultExclusions`,
    issues,
  );
  const unitOfMeasure = expectString(value.unitOfMeasure, `${path}.unitOfMeasure`, issues, {
    max: MAX_COMMERCIAL_KEY_LENGTH,
  });
  const pricingModelRaw = expectString(value.pricingModel, `${path}.pricingModel`, issues, {
    max: 40,
  });
  if (!(SERVICE_PRICING_MODELS as readonly string[]).includes(pricingModelRaw)) {
    issues.push(
      issue(
        "pricing_model",
        `${path}.pricingModel is not a supported pricing model.`,
        `${path}.pricingModel`,
      ),
    );
  }
  const rateIssues: CatalogValidationIssue[] = [];
  const defaultRateMinor = expectSafeInteger(
    value.defaultRateMinor,
    `${path}.defaultRateMinor`,
    rateIssues,
    { min: 0 },
  );
  for (const rateIssue of rateIssues) {
    issues.push({ ...rateIssue, code: "rate" });
  }
  const minimumQuantityScaled = expectSafeInteger(
    value.minimumQuantityScaled,
    `${path}.minimumQuantityScaled`,
    issues,
    { min: 0 },
  );
  const maximumQuantityScaled = expectSafeInteger(
    value.maximumQuantityScaled,
    `${path}.maximumQuantityScaled`,
    issues,
    { min: 0 },
  );
  if (minimumQuantityScaled > maximumQuantityScaled) {
    issues.push(
      issue(
        "quantity_bounds",
        `${path} minimum quantity cannot exceed maximum quantity.`,
        `${path}.minimumQuantityScaled`,
      ),
    );
  }
  const eligibilityNotes = expectString(
    value.eligibilityNotes,
    `${path}.eligibilityNotes`,
    issues,
    { nonempty: false, max: MAX_COMMERCIAL_NOTE_LENGTH },
  );
  const requiredLeadInformation = expectStringArray(
    value.requiredLeadInformation,
    `${path}.requiredLeadInformation`,
    issues,
    { maxItemLength: MAX_COMMERCIAL_KEY_LENGTH },
  );
  const options = expectStringArray(value.options, `${path}.options`, issues, {
    maxItemLength: MAX_COMMERCIAL_KEY_LENGTH,
  });
  const effectiveFrom = expectIsoDate(value.effectiveFrom, `${path}.effectiveFrom`, issues, false);
  const effectiveTo = expectIsoDate(value.effectiveTo, `${path}.effectiveTo`, issues, true);
  if (effectiveFrom && effectiveTo && Date.parse(effectiveTo) < Date.parse(effectiveFrom)) {
    issues.push(
      issue(
        "effective_date_range",
        `${path}.effectiveTo cannot precede effectiveFrom.`,
        `${path}.effectiveTo`,
      ),
    );
  }
  const active = expectBoolean(value.active, `${path}.active`, issues);
  const displayOrder = expectSafeInteger(value.displayOrder, `${path}.displayOrder`, issues, {
    min: 0,
    max: 1_000_000,
  });
  const synthetic = expectBoolean(value.synthetic, `${path}.synthetic`, issues);
  if (synthetic !== catalogSynthetic) {
    issues.push(
      issue(
        "synthetic",
        `${path} synthetic identity must match the catalog synthetic identity.`,
        `${path}.synthetic`,
      ),
    );
  }
  return {
    serviceKey,
    serviceCode,
    displayName,
    description,
    scopeTemplate,
    defaultDeliverables,
    defaultAssumptions,
    defaultExclusions,
    unitOfMeasure,
    pricingModel: pricingModelRaw as ServicePricingModel,
    defaultRateMinor,
    minimumQuantityScaled,
    maximumQuantityScaled,
    eligibilityNotes,
    requiredLeadInformation,
    options,
    effectiveFrom: effectiveFrom ?? "",
    effectiveTo,
    active,
    displayOrder,
    synthetic,
  };
}

function parseTerms(
  value: unknown,
  issues: CatalogValidationIssue[],
): CommercialTermsPolicy | null {
  if (!isPlainObject(value)) {
    issues.push(issue("required", "Catalog terms are required.", "terms"));
    return null;
  }
  collectKeyProblems(value, TERMS_KEYS, "terms", issues);
  const templateKey = expectString(value.templateKey, "terms.templateKey", issues, {
    max: MAX_COMMERCIAL_KEY_LENGTH,
  });
  let validityDays: number | null = null;
  if (value.validityDays !== null && value.validityDays !== undefined) {
    validityDays = expectSafeInteger(value.validityDays, "terms.validityDays", issues, {
      min: 1,
      max: MAX_VALIDITY_DAYS,
    });
  }
  const termsText = expectString(value.termsText, "terms.termsText", issues);
  const acceptanceLanguage = expectString(
    value.acceptanceLanguage,
    "terms.acceptanceLanguage",
    issues,
  );
  const taxConfigured = expectBoolean(value.taxConfigured, "terms.taxConfigured", issues);
  const taxBps = expectSafeInteger(value.taxBps, "terms.taxBps", issues, { min: 0, max: 0 });
  const discountConfigured = expectBoolean(
    value.discountConfigured,
    "terms.discountConfigured",
    issues,
  );
  const selfApprovalAllowed = expectBoolean(
    value.selfApprovalAllowed,
    "terms.selfApprovalAllowed",
    issues,
  );
  const productionConfirmed = expectBoolean(
    value.productionConfirmed,
    "terms.productionConfirmed",
    issues,
  );
  const disclosure = expectString(value.disclosure, "terms.disclosure", issues);
  if (taxConfigured !== false) {
    issues.push(
      issue("tax", "Real tax configuration remains UNCONFIGURED.", "terms.taxConfigured"),
    );
  }
  if (taxBps !== 0) {
    issues.push(issue("tax", "Tax basis points must remain zero.", "terms.taxBps"));
  }
  if (discountConfigured !== false) {
    issues.push(
      issue(
        "discount",
        "Catalog-level discounts remain UNCONFIGURED. Use the controlled Proposal override system.",
        "terms.discountConfigured",
      ),
    );
  }
  if (selfApprovalAllowed !== false) {
    issues.push(
      issue(
        "self_approval",
        "Self-approval remains UNCONFIGURED and must stay blocked.",
        "terms.selfApprovalAllowed",
      ),
    );
  }
  if (productionConfirmed !== false) {
    issues.push(
      issue("production", COMMERCIAL_PRODUCTION_UNCONFIGURED, "terms.productionConfirmed"),
    );
  }
  return {
    templateKey,
    validityDays,
    termsText,
    acceptanceLanguage,
    taxConfigured: false,
    taxBps: 0,
    discountConfigured: false,
    selfApprovalAllowed: false,
    productionConfirmed: false,
    disclosure,
  };
}

function parseApproval(
  value: unknown,
  issues: CatalogValidationIssue[],
): CommercialApprovalPolicy | null {
  if (!isPlainObject(value)) {
    issues.push(issue("required", "Catalog approval policy is required.", "approval"));
    return null;
  }
  collectKeyProblems(value, APPROVAL_KEYS, "approval", issues);
  const preparerRole = expectString(value.preparerRole, "approval.preparerRole", issues, {
    max: 80,
  });
  const reviewerRole = expectString(value.reviewerRole, "approval.reviewerRole", issues, {
    max: 80,
  });
  const overrideApproverRole = expectString(
    value.overrideApproverRole,
    "approval.overrideApproverRole",
    issues,
    { max: 80 },
  );
  if (preparerRole !== COMMERCIAL_PREPARER_ROLE) {
    issues.push(
      issue("approval_role", "Phase 3.3A preparer role must be sales.", "approval.preparerRole"),
    );
  }
  if (reviewerRole !== COMMERCIAL_REVIEWER_ROLE) {
    issues.push(
      issue("approval_role", "Commercial approval remains Owner-only.", "approval.reviewerRole"),
    );
  }
  if (overrideApproverRole !== COMMERCIAL_OVERRIDE_APPROVER_ROLE) {
    issues.push(
      issue(
        "approval_role",
        "Override approval remains Owner-only.",
        "approval.overrideApproverRole",
      ),
    );
  }
  const selfApprovalAllowed = expectBoolean(
    value.selfApprovalAllowed,
    "approval.selfApprovalAllowed",
    issues,
  );
  if (selfApprovalAllowed !== false) {
    issues.push(
      issue(
        "self_approval",
        "Self-approval remains UNCONFIGURED and must stay blocked.",
        "approval.selfApprovalAllowed",
      ),
    );
  }
  if (value.overrideThresholdMinor !== null && value.overrideThresholdMinor !== undefined) {
    issues.push(
      issue(
        "override_threshold",
        "Production override thresholds remain UNCONFIGURED.",
        "approval.overrideThresholdMinor",
      ),
    );
  }
  const productionConfirmed = expectBoolean(
    value.productionConfirmed,
    "approval.productionConfirmed",
    issues,
  );
  if (productionConfirmed !== false) {
    issues.push(
      issue("production", COMMERCIAL_PRODUCTION_UNCONFIGURED, "approval.productionConfirmed"),
    );
  }
  const disclosure = expectString(value.disclosure, "approval.disclosure", issues);
  return {
    preparerRole: COMMERCIAL_PREPARER_ROLE,
    reviewerRole: COMMERCIAL_REVIEWER_ROLE,
    overrideApproverRole: COMMERCIAL_OVERRIDE_APPROVER_ROLE,
    selfApprovalAllowed: false,
    overrideThresholdMinor: null,
    productionConfirmed: false,
    disclosure,
  };
}

function parseTemplate(
  value: unknown,
  catalogSynthetic: boolean,
  issues: CatalogValidationIssue[],
): ProposalTemplateDefinition | null {
  if (!isPlainObject(value)) {
    issues.push(issue("required", "Catalog proposal template is required.", "template"));
    return null;
  }
  collectKeyProblems(value, TEMPLATE_KEYS, "template", issues);
  const templateKey = expectString(value.templateKey, "template.templateKey", issues, {
    max: MAX_COMMERCIAL_KEY_LENGTH,
  });
  if (!(PROPOSAL_TEMPLATE_KEYS as readonly string[]).includes(templateKey)) {
    issues.push(
      issue("template_key", "Unsupported proposal template key.", "template.templateKey"),
    );
  }
  const displayName = expectString(value.displayName, "template.displayName", issues, {
    max: MAX_COMMERCIAL_NAME_LENGTH,
  });
  const rendererAdapter = expectString(value.rendererAdapter, "template.rendererAdapter", issues, {
    max: 120,
  });
  if (rendererAdapter !== SUPPORTED_PROPOSAL_RENDERER) {
    issues.push(
      issue(
        "renderer",
        "Unknown proposal renderer. Only bea.deterministic-synthetic-pdf.v1 is supported.",
        "template.rendererAdapter",
      ),
    );
  }
  const coverTitle = expectString(value.coverTitle, "template.coverTitle", issues, {
    max: MAX_COMMERCIAL_NAME_LENGTH,
  });
  const introText = expectString(value.introText, "template.introText", issues);
  const sectionOrder = expectStringArray(value.sectionOrder, "template.sectionOrder", issues, {
    maxItemLength: MAX_COMMERCIAL_KEY_LENGTH,
  });
  const footerText = expectString(value.footerText, "template.footerText", issues);
  const synthetic = expectBoolean(value.synthetic, "template.synthetic", issues);
  if (synthetic !== catalogSynthetic) {
    issues.push(
      issue(
        "synthetic",
        "Proposal template synthetic identity must match the catalog synthetic identity.",
        "template.synthetic",
      ),
    );
  }
  const disclosure = expectString(value.disclosure, "template.disclosure", issues);
  return {
    templateKey: templateKey as ProposalTemplateKey,
    displayName,
    rendererAdapter: SUPPORTED_PROPOSAL_RENDERER,
    coverTitle,
    introText,
    sectionOrder,
    footerText,
    synthetic: true,
    disclosure,
  };
}

function parseDelivery(
  value: unknown,
  catalogSynthetic: boolean,
  issues: CatalogValidationIssue[],
): DeliveryManifestPolicy | null {
  if (!isPlainObject(value)) {
    issues.push(issue("required", "Catalog delivery policy is required.", "delivery"));
    return null;
  }
  collectKeyProblems(value, DELIVERY_KEYS, "delivery", issues);
  const senderMailbox = expectString(value.senderMailbox, "delivery.senderMailbox", issues, {
    max: 240,
  });
  if (catalogSynthetic && !senderMailbox.toLowerCase().endsWith(".invalid")) {
    issues.push(
      issue(
        "delivery_address",
        "Synthetic delivery addresses must use the .invalid suffix.",
        "delivery.senderMailbox",
      ),
    );
  }
  const subjectTemplate = expectString(value.subjectTemplate, "delivery.subjectTemplate", issues, {
    max: MAX_COMMERCIAL_NOTE_LENGTH,
  });
  const bodyTemplate = expectString(value.bodyTemplate, "delivery.bodyTemplate", issues);
  const requiredScopes = expectStringArray(
    value.requiredScopes,
    "delivery.requiredScopes",
    issues,
    { maxItemLength: 120 },
  );
  const liveWrites = expectBoolean(value.liveWrites, "delivery.liveWrites", issues);
  if (liveWrites !== false) {
    issues.push(
      issue(
        "live_writes",
        "Proposal delivery liveWrites must remain false.",
        "delivery.liveWrites",
      ),
    );
  }
  const disclosure = expectString(value.disclosure, "delivery.disclosure", issues);
  return {
    senderMailbox: senderMailbox || SYNTHETIC_PROPOSAL_SENDER,
    subjectTemplate,
    bodyTemplate,
    requiredScopes,
    liveWrites: false,
    disclosure,
  };
}

export function tryParseCatalogPackage(input: unknown): CatalogParseResult {
  const issues: CatalogValidationIssue[] = [];
  if (!isPlainObject(input)) {
    return {
      ok: false,
      issues: [issue("type", "A catalog package must be an object.", "$")],
    };
  }
  collectKeyProblems(input, CATALOG_KEYS, "catalog", issues);
  const catalogKey = expectString(input.catalogKey, "catalogKey", issues, {
    max: MAX_COMMERCIAL_KEY_LENGTH,
  });
  if (catalogKey && !(CATALOG_FAMILY_KEYS as readonly string[]).includes(catalogKey)) {
    issues.push(
      issue("catalog_key", "Catalog key is not in the controlled family list.", "catalogKey"),
    );
  }
  const displayName = expectString(input.displayName, "displayName", issues, {
    max: MAX_COMMERCIAL_NAME_LENGTH,
  });
  const serviceContextKey = expectString(input.serviceContextKey, "serviceContextKey", issues, {
    max: MAX_COMMERCIAL_KEY_LENGTH,
  });
  const currencyRaw = expectString(input.currency, "currency", issues, { max: 3, min: 3 });
  let currency = currencyRaw;
  try {
    if (currencyRaw) currency = assertCurrencyCode(currencyRaw);
  } catch {
    issues.push(issue("currency", "Catalog currency is invalid.", "currency"));
  }
  const synthetic = expectBoolean(input.synthetic, "synthetic", issues);
  const productionReady = expectBoolean(input.productionReady, "productionReady", issues);
  const disclosure = expectString(input.disclosure, "disclosure", issues);
  if (productionReady !== false) {
    issues.push(issue("production", COMMERCIAL_PRODUCTION_UNCONFIGURED, "productionReady"));
  }
  if (!synthetic) {
    issues.push(issue("production", COMMERCIAL_PRODUCTION_UNCONFIGURED, "synthetic"));
  }
  if (catalogKey === "bea-production-service-catalog" && synthetic) {
    issues.push(
      issue(
        "production",
        "A production catalog key cannot be made executable by labeling it synthetic.",
        "catalogKey",
      ),
    );
  }
  if (synthetic && catalogKey === "bea-production-service-catalog") {
    issues.push(issue("production", COMMERCIAL_PRODUCTION_UNCONFIGURED, "catalogKey"));
  }

  if (!Object.prototype.hasOwnProperty.call(input, "items")) {
    issues.push(issue("items", "Catalog items are required.", "items"));
  } else if (!Array.isArray(input.items)) {
    issues.push(issue("items", "Catalog items must be an array.", "items"));
  } else if (input.items.length === 0) {
    issues.push(
      issue("items", "A catalog version must include at least one service item.", "items"),
    );
  }

  const items: ServiceCatalogItemDefinition[] = [];
  if (Array.isArray(input.items)) {
    const keys = new Set<string>();
    const codes = new Set<string>();
    input.items.forEach((entry, index) => {
      const item = parseItem(entry, `items[${index}]`, synthetic, issues);
      if (!item) return;
      if (item.serviceKey) {
        if (keys.has(item.serviceKey)) {
          issues.push(
            issue(
              "duplicate_service",
              `Duplicate service key ${item.serviceKey}.`,
              `items[${index}].serviceKey`,
            ),
          );
        }
        keys.add(item.serviceKey);
      }
      if (item.serviceCode) {
        if (codes.has(item.serviceCode)) {
          issues.push(
            issue(
              "duplicate_service_code",
              `Duplicate service code ${item.serviceCode}.`,
              `items[${index}].serviceCode`,
            ),
          );
        }
        codes.add(item.serviceCode);
      }
      items.push(item);
    });
  }

  const terms = parseTerms(input.terms, issues);
  const approval = parseApproval(input.approval, issues);
  const template = parseTemplate(input.template, synthetic, issues);
  const delivery = parseDelivery(input.delivery, synthetic, issues);

  const blocking = issues.filter((item) => item.blocking).slice(0, MAX_CATALOG_VALIDATION_ISSUES);
  if (blocking.length > 0 || !terms || !approval || !template || !delivery || items.length === 0) {
    return { ok: false, issues: blocking.length > 0 ? blocking : issues };
  }

  const value: ServiceCatalogPackage = {
    catalogKey: catalogKey as CatalogFamilyKey,
    displayName,
    serviceContextKey,
    currency,
    synthetic,
    productionReady: false,
    disclosure: disclosure || COMMERCIAL_SYNTHETIC_DISCLOSURE,
    items,
    terms,
    approval,
    template,
    delivery,
  };
  return { ok: true, value };
}

export function parseCatalogPackage(input: unknown): ServiceCatalogPackage {
  const parsed = tryParseCatalogPackage(input);
  if (!parsed.ok) {
    throw new CommercialCatalogValidationError(parsed.issues);
  }
  return parsed.value;
}

export function catalogValidationIssues(input: unknown): readonly CatalogValidationIssue[] {
  const parsed = tryParseCatalogPackage(input);
  return parsed.ok ? [] : parsed.issues;
}

export function validateCatalogPackage(input: unknown): readonly CatalogValidationIssue[] {
  return catalogValidationIssues(input);
}

export function canonicalCommercialJson(value: unknown): string {
  if (value === undefined) {
    throw new CommercialCatalogValidationError([
      issue("canonical_json", "Canonical catalog JSON cannot contain undefined."),
    ]);
  }
  if (typeof value === "bigint") {
    throw new CommercialCatalogValidationError([
      issue("canonical_json", "Canonical catalog JSON cannot contain BigInt."),
    ]);
  }
  if (typeof value === "function") {
    throw new CommercialCatalogValidationError([
      issue("canonical_json", "Canonical catalog JSON cannot contain functions."),
    ]);
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new CommercialCatalogValidationError([
      issue("canonical_json", "Canonical catalog JSON cannot contain NaN or Infinity."),
    ]);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalCommercialJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of objectKeys(record)) {
      if (POLLUTION_KEYS.has(key)) {
        throw new CommercialCatalogValidationError([
          issue("prototype_pollution", `Canonical JSON rejected pollution key '${key}'.`),
        ]);
      }
    }
    const entries = Object.entries(record)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, "en-US"));
    for (const [, entry] of entries) {
      if (typeof entry === "function") {
        throw new CommercialCatalogValidationError([
          issue("canonical_json", "Canonical catalog JSON cannot contain functions."),
        ]);
      }
    }
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalCommercialJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

export function sha256Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 9 + 63) >> 6) << 6) >>> 0;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15]!;
      const previous2 = words[index - 2]!;
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + SHA256_K[index]! + words[index]!) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => word.toString(16).padStart(8, "0"))
    .join("");
}

export function catalogIdentityPayload(input: {
  readonly catalogId: string;
  readonly catalogVersionId: string;
  readonly catalogVersionNumber: number;
  readonly pack: ServiceCatalogPackage;
}): JsonObject {
  return {
    contractVersion: COMMERCIAL_CONTRACT_VERSION,
    catalogId: input.catalogId,
    catalogVersionId: input.catalogVersionId,
    catalogKey: input.pack.catalogKey,
    catalogVersionNumber: input.catalogVersionNumber,
    displayName: input.pack.displayName,
    serviceContextKey: input.pack.serviceContextKey,
    currency: input.pack.currency,
    synthetic: input.pack.synthetic,
    productionReady: input.pack.productionReady,
    normalizedPackage: JSON.parse(canonicalCommercialJson(input.pack)) as JsonValue,
  };
}

export function computeCatalogIdentityChecksum(input: {
  readonly catalogId: string;
  readonly catalogVersionId: string;
  readonly catalogVersionNumber: number;
  readonly pack: ServiceCatalogPackage;
}): string {
  return sha256Utf8(canonicalCommercialJson(catalogIdentityPayload(input)));
}

export function catalogPackageIdentityMaterial(input: {
  readonly catalogId?: string;
  readonly catalogVersionId?: string;
  readonly catalogKey: string;
  readonly versionNumber: number;
  readonly currency: string;
  readonly displayName?: string;
  readonly serviceContextKey?: string;
  readonly synthetic?: boolean;
  readonly productionReady?: boolean;
  readonly items: readonly ServiceCatalogItemDefinition[];
  readonly terms: CommercialTermsPolicy;
  readonly approval: CommercialApprovalPolicy;
  readonly template: ProposalTemplateDefinition;
  readonly delivery?: DeliveryManifestPolicy;
}): string {
  const pack = {
    catalogKey: input.catalogKey,
    displayName: input.displayName ?? input.catalogKey,
    serviceContextKey: input.serviceContextKey ?? input.catalogKey,
    currency: input.currency,
    synthetic: input.synthetic ?? true,
    productionReady: input.productionReady ?? false,
    disclosure: COMMERCIAL_SYNTHETIC_DISCLOSURE,
    items: input.items,
    terms: input.terms,
    approval: input.approval,
    template: input.template,
    delivery: input.delivery ?? {
      senderMailbox: SYNTHETIC_PROPOSAL_SENDER,
      subjectTemplate: "SYNTHETIC",
      bodyTemplate: "SYNTHETIC",
      requiredScopes: [],
      liveWrites: false as const,
      disclosure: COMMERCIAL_SYNTHETIC_DISCLOSURE,
    },
  } as ServiceCatalogPackage;
  return computeCatalogIdentityChecksum({
    catalogId: input.catalogId ?? "identity-catalog",
    catalogVersionId: input.catalogVersionId ?? "identity-version",
    catalogVersionNumber: input.versionNumber,
    pack,
  });
}

export interface CatalogProjectionRow {
  readonly serviceKey: string;
  readonly serviceCode: string;
  readonly displayName: string;
  readonly description: string;
  readonly scopeTemplate: string;
  readonly defaultDeliverables: readonly string[];
  readonly defaultAssumptions: readonly string[];
  readonly defaultExclusions: readonly string[];
  readonly unitOfMeasure: string;
  readonly pricingModel: string;
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

export interface CatalogPolicyRow {
  readonly policyKind: "terms" | "approval" | "proposal_template" | "delivery";
  readonly payload: unknown;
  readonly synthetic: boolean;
}

export function catalogProjectionIssues(input: {
  readonly pack: ServiceCatalogPackage;
  readonly catalogKey: string;
  readonly serviceContextKey: string;
  readonly currency: string;
  readonly synthetic: boolean;
  readonly productionReady: boolean;
  readonly items: readonly CatalogProjectionRow[];
  readonly policies: readonly CatalogPolicyRow[];
}): readonly CatalogValidationIssue[] {
  const issues: CatalogValidationIssue[] = [];
  if (input.catalogKey !== input.pack.catalogKey) {
    issues.push(issue("row_metadata", "Catalog key does not match the package."));
  }
  if (input.serviceContextKey !== input.pack.serviceContextKey) {
    issues.push(issue("row_metadata", "Service context does not match the package."));
  }
  if (input.currency !== input.pack.currency) {
    issues.push(issue("row_metadata", "Currency does not match the package."));
  }
  if (input.synthetic !== input.pack.synthetic) {
    issues.push(issue("row_metadata", "Row-level synthetic identity does not match the package."));
  }
  if (input.productionReady !== input.pack.productionReady) {
    issues.push(issue("row_metadata", "Production-ready flag does not match the package."));
  }
  if (input.items.length !== input.pack.items.length) {
    issues.push(issue("projection", "Normalized catalog items do not match the package."));
  }
  const byKey = new Map(input.items.map((item) => [item.serviceKey, item]));
  for (const item of input.pack.items) {
    const row = byKey.get(item.serviceKey);
    if (!row) {
      issues.push(issue("projection", `Normalized item ${item.serviceKey} is missing.`));
      continue;
    }
    if (
      canonicalCommercialJson(rowForCompare(row)) !== canonicalCommercialJson(itemForCompare(item))
    ) {
      issues.push(
        issue("projection", `Normalized item ${item.serviceKey} diverges from the package.`),
      );
    }
  }
  const policyByKind = new Map(input.policies.map((item) => [item.policyKind, item]));
  const expected: Record<CatalogPolicyRow["policyKind"], unknown> = {
    terms: input.pack.terms,
    approval: input.pack.approval,
    proposal_template: input.pack.template,
    delivery: input.pack.delivery,
  };
  for (const [kind, payload] of Object.entries(expected) as Array<
    [CatalogPolicyRow["policyKind"], unknown]
  >) {
    const row = policyByKind.get(kind);
    if (!row) {
      issues.push(issue("projection", `Normalized ${kind} policy is missing.`));
      continue;
    }
    if (row.synthetic !== input.pack.synthetic) {
      issues.push(issue("projection", `Normalized ${kind} synthetic identity diverges.`));
    }
    if (canonicalCommercialJson(row.payload) !== canonicalCommercialJson(payload)) {
      issues.push(issue("projection", `Normalized ${kind} policy diverges from the package.`));
    }
  }
  return issues;
}

function itemForCompare(item: ServiceCatalogItemDefinition): CatalogProjectionRow {
  return {
    serviceKey: item.serviceKey,
    serviceCode: item.serviceCode,
    displayName: item.displayName,
    description: item.description,
    scopeTemplate: item.scopeTemplate,
    defaultDeliverables: [...item.defaultDeliverables],
    defaultAssumptions: [...item.defaultAssumptions],
    defaultExclusions: [...item.defaultExclusions],
    unitOfMeasure: item.unitOfMeasure,
    pricingModel: item.pricingModel,
    defaultRateMinor: item.defaultRateMinor,
    minimumQuantityScaled: item.minimumQuantityScaled,
    maximumQuantityScaled: item.maximumQuantityScaled,
    eligibilityNotes: item.eligibilityNotes,
    requiredLeadInformation: [...item.requiredLeadInformation],
    options: [...item.options],
    effectiveFrom: item.effectiveFrom,
    effectiveTo: item.effectiveTo,
    active: item.active,
    displayOrder: item.displayOrder,
    synthetic: item.synthetic,
  };
}

function rowForCompare(row: CatalogProjectionRow): CatalogProjectionRow {
  return {
    ...row,
    defaultDeliverables: [...row.defaultDeliverables],
    defaultAssumptions: [...row.defaultAssumptions],
    defaultExclusions: [...row.defaultExclusions],
    requiredLeadInformation: [...row.requiredLeadInformation],
    options: [...row.options],
  };
}

export function isSalesCommercialWorkKind(kind: string): kind is SalesCommercialWorkKind {
  return (SALES_COMMERCIAL_WORK_KINDS as readonly string[]).includes(kind);
}

export function proposalAllowsOverrideMutation(status: ProposalStatus): boolean {
  return OVERRIDE_MUTABLE_PROPOSAL_STATUSES.includes(status);
}

export function assertSafeScaledQuantity(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CommercialValidationError(`${label} quantity must be a finite number.`);
  }
  if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
    throw new CommercialValidationError(`${label} quantity must be a safe integer after scaling.`);
  }
  if (value < 0) {
    throw new CommercialValidationError(`${label} quantity cannot be negative.`);
  }
  return value;
}

export function assertSafeProposedAmount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CommercialValidationError(`${label} must be a finite number.`);
  }
  if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
    throw new CommercialValidationError(`${label} must be a safe integer number of minor units.`);
  }
  if (value < 0) {
    throw new CommercialValidationError(`${label} cannot be negative.`);
  }
  return value;
}

export function catalogContextKeyForLead(input: {
  readonly requestedService?: string | null;
  readonly opportunityName?: string | null;
}): string | null {
  const haystack = `${input.requestedService ?? ""} ${input.opportunityName ?? ""}`.toLowerCase();
  if (/\bmoisture\b/u.test(haystack)) return "synthetic-moisture-investigation";
  if (/\b(envelope|curtain-wall|curtain wall|facade|advisory)\b/u.test(haystack)) {
    return "synthetic-envelope-advisory";
  }
  return null;
}

export const COMMERCIAL_APPROVER_ELIGIBILITY_SQL = `u.status='active' AND u.archived_at IS NULL AND EXISTS (
  SELECT 1
  FROM user_roles ur
  JOIN roles r ON r.id = ur.role_id AND r.status='active'
  JOIN role_permissions rp ON rp.role_id = ur.role_id
  JOIN permissions p ON p.id = rp.permission_id
  WHERE ur.user_id = u.id AND p.key='proposals.approve' AND r.key='owner-admin'
)`;

export const COMMERCIAL_OVERRIDE_APPROVER_ELIGIBILITY_SQL = `u.status='active' AND u.archived_at IS NULL AND EXISTS (
  SELECT 1
  FROM user_roles ur
  JOIN roles r ON r.id = ur.role_id AND r.status='active'
  JOIN role_permissions rp ON rp.role_id = ur.role_id
  JOIN permissions p ON p.id = rp.permission_id
  WHERE ur.user_id = u.id AND p.key='proposals.override.approve' AND r.key='${COMMERCIAL_OVERRIDE_APPROVER_ROLE}'
)`;
