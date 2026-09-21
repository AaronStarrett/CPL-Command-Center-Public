import type { JsonObject, JsonValue } from "./entities.js";
import {
  CANONICAL_FIELD_TYPES,
  COLLECTION_CARDINALITIES,
  COLLECTION_EMPTY_BEHAVIORS,
  COLLECTION_KINDS,
  CONFIGURATION_SYNTHETIC_DISCLOSURE,
  CSV_ROW_MODES,
  CSV_SCALAR_STRATEGIES,
  ConfigurationValidationError,
  EVIDENCE_BINDING_DESTINATIONS,
  FINDING_BINDING_DESTINATIONS,
  MAPPING_SOURCE_TYPES,
  MAPPING_TRANSFORM_KINDS,
  REPORT_FILENAME_TOKENS,
  REPORT_NODE_KINDS,
  SIGNATURE_BINDING_DESTINATIONS,
  STORAGE_PLACEHOLDER_TOKENS,
  VALIDATION_EXPRESSION_KINDS,
  VALIDATION_SEVERITIES,
  type BoundConfigurationPackage,
  type CanonicalFieldDefinition,
  type CanonicalSectionDefinition,
  type CollectionItemBinding,
  type CollectionRelationshipBinding,
  type ConfigurationArtifactKind,
  type ConfigurationValidationIssue,
  type DeliveryPolicyDefinition,
  type FieldCondition,
  type InspectionSchemaDefinition,
  type MappingTransform,
  type ReportTemplateDefinition,
  type ReportTemplateNode,
  type ReportTemplateSection,
  type ReviewPolicyDefinition,
  type SlaPolicyDefinition,
  type SourceCollectionMapping,
  type SourceMappingProfile,
  type SourceMappingRule,
  type StoragePolicyDefinition,
  type ValidationExpression,
  type ValidationRuleDefinition,
  type ValidationRuleSet,
  type WorkflowBlueprintParameters,
} from "./configuration.js";

const UNSAFE_PATH = /(?:__proto__|constructor|prototype|\[\s*["'`])/iu;

function assertSafeConfiguredPath(path: string): void {
  const trimmed = path.trim();
  if (!trimmed) {
    throw new Error("A source path is required.");
  }
  if (UNSAFE_PATH.test(trimmed) || trimmed.includes("..") || trimmed.includes("(")) {
    throw new Error(`Rejected unsafe source path: ${path}`);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\]|\[\*\])*$/u.test(trimmed)) {
    throw new Error(`Rejected unsafe source path: ${path}`);
  }
}

/**
 * Unknown-property policy:
 * Execution-bearing objects (rules, transforms, expressions, nodes, collection mappings,
 * item bindings, and artifact envelopes) reject unknown keys. Unknown rule, node,
 * transform, expression, and action kinds are always rejected. Optional documentation
 * fields are not accepted unless listed on the artifact contract.
 */
export const UNKNOWN_PROPERTY_POLICY =
  "Unknown keys on configuration artifacts and execution-bearing objects are rejected. Unknown rule, node, transform, expression, and action kinds always fail closed.";

const POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const FIELD_CONDITION_KINDS = ["always", "field_equals", "field_truthy", "field_present"] as const;
const PRIVACY = ["operational", "restricted", "signature"] as const;
const DEFAULT_STATUS = ["optional", "required", "system"] as const;
const EVIDENCE_REL = ["none", "requires_evidence", "is_evidence"] as const;
const FINDING_REL = ["none", "is_finding", "requires_finding"] as const;
const CONFLICT = ["reject", "first_wins", "last_wins"] as const;
const NULL_BEHAVIOR = ["leave_empty", "use_default"] as const;
const TRIGGER_COMPARE = ["eq", "neq", "gt", "gte", "lt", "lte"] as const;
const MISSING_VALUE = ["show_placeholder", "omit", "show_not_recorded"] as const;
const IMAGE_PLACEMENT = ["grid", "inline", "finding_adjacent"] as const;
const SUPPORTED_RENDERER = "bea.deterministic-synthetic-pdf.v1";
const SCRIPT_MARKUP = /<\s*script|javascript:|onerror\s*=/iu;
const CREDENTIAL_KEY = /password|secret|token|apikey|credential|private[_-]?key/iu;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;
const PLACEHOLDER_TOKEN = /\{([a-z0-9_]+)\}/giu;

const SCHEMA_KEYS = [
  "schemaKey",
  "schemaVersion",
  "displayName",
  "synthetic",
  "disclosure",
  "sections",
  "fields",
] as const;
const SECTION_KEYS = ["key", "label", "description", "displayOrder", "parentKey", "repeatable"];
const FIELD_KEYS = [
  "key",
  "label",
  "description",
  "dataType",
  "required",
  "defaultStatus",
  "sectionKey",
  "displayOrder",
  "repeatableGroup",
  "allowedValues",
  "unit",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "dateRule",
  "privacyClassification",
  "evidenceRelationship",
  "findingRelationship",
  "sourceLineageRequired",
  "correctionGuidance",
  "visibleIf",
  "requiredIf",
];
const MAPPING_KEYS = [
  "profileKey",
  "profileVersion",
  "displayName",
  "synthetic",
  "sourceType",
  "sourceSchemaVersion",
  "applicableConfiguration",
  "disclosure",
  "csvRowMode",
  "csvScalarStrategy",
  "rules",
  "collections",
];
const RULE_KEYS = [
  "ruleKey",
  "sourcePath",
  "canonicalField",
  "transforms",
  "requiredSource",
  "conflictBehavior",
  "nullBehavior",
  "defaultValue",
];
const TRANSFORM_KEYS = [
  "kind",
  "trueValues",
  "falseValues",
  "map",
  "fromUnit",
  "toUnit",
  "factor",
  "separator",
  "sources",
  "from",
  "to",
  "streetPath",
  "cityPath",
  "regionPath",
  "postalPath",
];
const COLLECTION_KEYS = [
  "collectionKey",
  "collectionKind",
  "sourcePath",
  "cardinality",
  "destinationGroupKey",
  "itemBindings",
  "relationshipBindings",
  "requiredSource",
  "emptyBehavior",
];
const ITEM_BINDING_KEYS = ["destination", "sourcePath", "transforms", "required", "defaultValue"];
const RELATIONSHIP_KEYS = ["relationshipKey", "sourcePath", "required"];
const VALIDATION_SET_KEYS = [
  "ruleSetKey",
  "ruleSetVersion",
  "displayName",
  "synthetic",
  "disclosure",
  "rules",
];
const VALIDATION_RULE_KEYS = [
  "ruleKey",
  "label",
  "description",
  "severity",
  "blocking",
  "sectionKey",
  "trigger",
  "expression",
  "remediation",
];
const TEMPLATE_KEYS = [
  "templateKey",
  "templateVersion",
  "displayName",
  "synthetic",
  "disclosure",
  "applicableSchemaKey",
  "applicableMappingKey",
  "rendererAdapter",
  "filenamePattern",
  "missingValueBehavior",
  "headerText",
  "footerText",
  "includePageNumbers",
  "sections",
];
const TEMPLATE_SECTION_KEYS = ["key", "title", "displayOrder", "visibleIf", "nodes"];
const NODE_KEYS = [
  "kind",
  "key",
  "title",
  "text",
  "fieldKey",
  "columns",
  "groupKey",
  "visibleIf",
  "imagePlacement",
];
const REVIEW_KEYS = [
  "policyKey",
  "policyVersion",
  "synthetic",
  "disclosure",
  "technicalReviewerRole",
  "assignmentStrategy",
  "requiredTechnicalApprovals",
  "selfReviewPermitted",
  "revisionResponsibility",
  "deliveryAuthorizerRole",
  "finalSendAuthorizationRequired",
];
const STORAGE_KEYS = [
  "policyKey",
  "policyVersion",
  "synthetic",
  "disclosure",
  "sharePointTenant",
  "site",
  "documentLibrary",
  "projectFolderPattern",
  "inspectionFolderPattern",
  "reportFolderPattern",
  "fileNamePattern",
  "versionBehavior",
  "conflictBehavior",
  "metadataFields",
  "configured",
];
const DELIVERY_KEYS = [
  "policyKey",
  "policyVersion",
  "synthetic",
  "disclosure",
  "senderMailbox",
  "toPattern",
  "ccPattern",
  "bccRestricted",
  "subjectPattern",
  "bodyTemplate",
  "attachmentNamePattern",
  "deliveryAuthorizerRole",
  "retryPolicy",
  "reconciliationPolicy",
  "configured",
];
const SLA_KEYS = [
  "policyKey",
  "policyVersion",
  "synthetic",
  "disclosure",
  "calendarMode",
  "timeZone",
  "workdays",
  "workdayStartMinute",
  "workdayEndMinute",
  "holidays",
  "targetMinutes",
  "warningThresholdMinutes",
  "breachThresholdMinutes",
  "pauseReasons",
  "attributionCategories",
  "escalationOwnerRole",
  "configured",
];
const WORKFLOW_KEYS = [
  "policyKey",
  "policyVersion",
  "synthetic",
  "humanGate",
  "autoResume",
  "maxAttempts",
  "finalApprovalRequired",
];

export interface ArtifactParseResult<T> {
  readonly value: T | null;
  readonly issues: readonly ConfigurationValidationIssue[];
}

function issue(
  code: string,
  path: string,
  message: string,
  remediation: string,
  blocking = true,
): ConfigurationValidationIssue {
  return {
    code,
    severity: blocking ? "blocking" : "warning",
    blocking,
    path,
    message,
    remediation,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rejectPollution(
  keys: readonly string[],
  path: string,
  issues: ConfigurationValidationIssue[],
): void {
  for (const key of keys) {
    if (POLLUTION_KEYS.has(key)) {
      issues.push(
        issue(
          "artifact.prototype_pollution",
          `${path}.${key}`,
          `Prototype-pollution key '${key}' is not allowed.`,
          "Remove __proto__, constructor, and prototype keys.",
        ),
      );
    }
  }
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: ConfigurationValidationIssue[],
): void {
  const allowedSet = new Set(allowed);
  rejectPollution(Object.keys(value), path, issues);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key) && !POLLUTION_KEYS.has(key)) {
      issues.push(
        issue(
          "artifact.unknown_property",
          `${path}.${key}`,
          `Unknown property '${key}' is not part of the ${path} contract.`,
          `${UNKNOWN_PROPERTY_POLICY} Remove the property or use a supported field.`,
        ),
      );
    }
  }
}

function expectString(
  value: unknown,
  path: string,
  issues: ConfigurationValidationIssue[],
  options: { readonly allowEmpty?: boolean } = {},
): string | null {
  if (typeof value !== "string") {
    issues.push(
      issue("artifact.invalid_type", path, `${path} must be a string.`, "Supply a string value."),
    );
    return null;
  }
  if (!options.allowEmpty && !value.trim()) {
    issues.push(
      issue("artifact.required", path, `${path} is required.`, "Provide a non-empty string."),
    );
    return null;
  }
  return value;
}

function expectBoolean(
  value: unknown,
  path: string,
  issues: ConfigurationValidationIssue[],
): boolean | null {
  if (typeof value !== "boolean") {
    issues.push(
      issue(
        "artifact.invalid_type",
        path,
        `${path} must be a boolean.`,
        "Supply true or false, not a string.",
      ),
    );
    return null;
  }
  return value;
}

function expectPositiveInteger(
  value: unknown,
  path: string,
  issues: ConfigurationValidationIssue[],
): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    issues.push(
      issue(
        "artifact.invalid_number",
        path,
        `${path} must be a positive integer.`,
        "Use a whole number greater than zero.",
      ),
    );
    return null;
  }
  return value;
}

function expectNumber(
  value: unknown,
  path: string,
  issues: ConfigurationValidationIssue[],
  options: { readonly allowNegative?: boolean } = {},
): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push(
      issue(
        "artifact.invalid_number",
        path,
        `${path} must be a finite number.`,
        "Supply a number.",
      ),
    );
    return null;
  }
  if (!options.allowNegative && value < 0) {
    issues.push(
      issue(
        "artifact.negative_value",
        path,
        `${path} cannot be negative.`,
        "Use zero or a positive number.",
      ),
    );
    return null;
  }
  return value;
}

function expectArray(
  value: unknown,
  path: string,
  issues: ConfigurationValidationIssue[],
): unknown[] | null {
  if (!Array.isArray(value)) {
    issues.push(
      issue("artifact.invalid_type", path, `${path} must be an array.`, "Supply a JSON array."),
    );
    return null;
  }
  return value;
}

function uniqueStrings(
  values: readonly string[],
  path: string,
  issues: ConfigurationValidationIssue[],
  code: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      issues.push(
        issue(code, path, `Duplicate key '${value}'.`, "Keys must be unique within the artifact."),
      );
    }
    seen.add(value);
  }
}

function parseFieldCondition(
  value: unknown,
  path: string,
  issues: ConfigurationValidationIssue[],
): FieldCondition | null {
  if (value === null) return null;
  if (!isPlainObject(value)) {
    issues.push(
      issue(
        "artifact.invalid_type",
        path,
        "Conditional expressions must be objects.",
        "Use a controlled FieldCondition object.",
      ),
    );
    return null;
  }
  rejectUnknownKeys(value, ["kind", "field", "value"], path, issues);
  const kind = expectString(value.kind, `${path}.kind`, issues);
  if (!kind) return null;
  if (!(FIELD_CONDITION_KINDS as readonly string[]).includes(kind)) {
    issues.push(
      issue(
        "artifact.unknown_condition_kind",
        `${path}.kind`,
        `Unknown condition kind '${kind}'.`,
        "Use always, field_equals, field_truthy, or field_present.",
      ),
    );
    return null;
  }
  if (kind === "always") return { kind: "always" };
  const field = expectString(value.field, `${path}.field`, issues);
  if (!field) return null;
  if (kind === "field_equals") {
    return { kind, field, value: (value.value ?? null) as JsonValue };
  }
  return { kind: kind as "field_truthy" | "field_present", field };
}

function parseSafePath(
  value: unknown,
  path: string,
  issues: ConfigurationValidationIssue[],
  allowCurrent = false,
): string | null {
  const text = expectString(value, path, issues);
  if (text === null) return null;
  if (allowCurrent && (text === "." || text === "")) return ".";
  try {
    assertSafeConfiguredPath(text);
  } catch (error) {
    issues.push(
      issue(
        "mapping.unsafe_path",
        path,
        error instanceof Error ? error.message : "Unsafe source path.",
        "Use a dotted identifier path. Arbitrary expressions, eval, JavaScript, SQL, and JSONata are rejected.",
      ),
    );
    return null;
  }
  return text;
}

function parseTransform(
  value: unknown,
  path: string,
  issues: ConfigurationValidationIssue[],
): MappingTransform | null {
  if (!isPlainObject(value)) {
    issues.push(
      issue(
        "mapping.invalid_transform",
        path,
        "Transforms must be objects.",
        "Use a controlled transform object.",
      ),
    );
    return null;
  }
  rejectUnknownKeys(value, TRANSFORM_KEYS, path, issues);
  const kind = expectString(value.kind, `${path}.kind`, issues);
  if (!kind) return null;
  if (!(MAPPING_TRANSFORM_KINDS as readonly string[]).includes(kind)) {
    issues.push(
      issue(
        "mapping.unknown_transform",
        `${path}.kind`,
        `Unknown transform kind '${kind}'.`,
        "Use a transform from the controlled allow-list. JavaScript, SQL, and shell are rejected.",
      ),
    );
    return null;
  }
  const transform: MappingTransform = { kind: kind as MappingTransform["kind"] };
  if (kind === "boolean_map") {
    if (value.trueValues !== undefined && !Array.isArray(value.trueValues)) {
      issues.push(
        issue(
          "mapping.transform_parameters",
          `${path}.trueValues`,
          "boolean_map trueValues must be a string array.",
          "Supply an array of strings.",
        ),
      );
    }
    if (value.falseValues !== undefined && !Array.isArray(value.falseValues)) {
      issues.push(
        issue(
          "mapping.transform_parameters",
          `${path}.falseValues`,
          "boolean_map falseValues must be a string array.",
          "Supply an array of strings.",
        ),
      );
    }
  }
  if (kind === "enum_map" && (value.map === undefined || !isPlainObject(value.map))) {
    issues.push(
      issue(
        "mapping.transform_parameters",
        `${path}.map`,
        "enum_map requires a map object.",
        "Provide map: { source: destination }.",
      ),
    );
  }
  if (
    kind === "unit_conversion" &&
    (typeof value.factor !== "number" || !Number.isFinite(value.factor))
  ) {
    issues.push(
      issue(
        "mapping.transform_parameters",
        `${path}.factor`,
        "unit_conversion requires a numeric factor.",
        "Provide factor as a finite number.",
      ),
    );
  }
  if (kind === "concat") {
    const sources = expectArray(value.sources, `${path}.sources`, issues);
    if (!sources || sources.length === 0) {
      issues.push(
        issue(
          "mapping.transform_parameters",
          `${path}.sources`,
          "concat requires sources.",
          "Provide a non-empty array of safe source paths.",
        ),
      );
    } else {
      for (const [index, source] of sources.entries()) {
        parseSafePath(source, `${path}.sources[${index}]`, issues);
      }
    }
  }
  if (kind === "replace_exact" && typeof value.from !== "string") {
    issues.push(
      issue(
        "mapping.transform_parameters",
        `${path}.from`,
        "replace_exact requires a from string.",
        "Provide from and optional to strings.",
      ),
    );
  }
  if (kind === "compose_address") {
    for (const key of ["streetPath", "cityPath", "regionPath", "postalPath"] as const) {
      if (value[key] !== undefined) parseSafePath(value[key], `${path}.${key}`, issues);
    }
  }
  return transform;
}

function parseItemBinding(
  value: unknown,
  path: string,
  issues: ConfigurationValidationIssue[],
  destinations: readonly string[],
  collectionKind: string,
): CollectionItemBinding | null {
  if (!isPlainObject(value)) {
    issues.push(
      issue(
        "mapping.invalid_binding",
        path,
        "Item bindings must be objects.",
        "Supply a binding object.",
      ),
    );
    return null;
  }
  rejectUnknownKeys(value, ITEM_BINDING_KEYS, path, issues);
  const destination = expectString(value.destination, `${path}.destination`, issues);
  const sourcePath = parseSafePath(value.sourcePath, `${path}.sourcePath`, issues, true);
  const required = expectBoolean(value.required, `${path}.required`, issues);
  const transformsRaw = expectArray(value.transforms ?? [], `${path}.transforms`, issues) ?? [];
  if (destination && collectionKind !== "repeatable_group" && !destinations.includes(destination)) {
    issues.push(
      issue(
        "mapping.invalid_destination",
        `${path}.destination`,
        `Destination '${destination}' is not valid for ${collectionKind}.`,
        `Use one of: ${destinations.join(", ")}.`,
      ),
    );
  }
  const transforms = transformsRaw.flatMap((item, index) => {
    const parsed = parseTransform(item, `${path}.transforms[${index}]`, issues);
    return parsed ? [parsed] : [];
  });
  if (!destination || sourcePath === null || required === null) return null;
  return {
    destination,
    sourcePath,
    transforms,
    required,
    ...(value.defaultValue !== undefined ? { defaultValue: value.defaultValue as JsonValue } : {}),
  };
}

export function parseInspectionSchema(
  value: unknown,
  path = "inspection_schema",
): ArtifactParseResult<InspectionSchemaDefinition> {
  const issues: ConfigurationValidationIssue[] = [];
  if (!isPlainObject(value)) {
    return {
      value: null,
      issues: [
        issue(
          "artifact.invalid_type",
          path,
          "Inspection schema must be an object.",
          "Supply a schema object.",
        ),
      ],
    };
  }
  rejectUnknownKeys(value, SCHEMA_KEYS, path, issues);
  const schemaKey = expectString(value.schemaKey, `${path}.schemaKey`, issues);
  const schemaVersion = expectPositiveInteger(value.schemaVersion, `${path}.schemaVersion`, issues);
  const displayName = expectString(value.displayName, `${path}.displayName`, issues);
  const synthetic = expectBoolean(value.synthetic, `${path}.synthetic`, issues);
  const disclosure = expectString(value.disclosure, `${path}.disclosure`, issues, {
    allowEmpty: true,
  });
  const sectionsRaw = expectArray(value.sections, `${path}.sections`, issues) ?? [];
  const fieldsRaw = expectArray(value.fields, `${path}.fields`, issues) ?? [];
  const sections: CanonicalSectionDefinition[] = [];
  for (const [index, sectionValue] of sectionsRaw.entries()) {
    const sectionPath = `${path}.sections[${index}]`;
    if (!isPlainObject(sectionValue)) {
      issues.push(
        issue(
          "schema.invalid_section",
          sectionPath,
          "Sections must be objects.",
          "Supply a section object.",
        ),
      );
      continue;
    }
    rejectUnknownKeys(sectionValue, SECTION_KEYS, sectionPath, issues);
    const key = expectString(sectionValue.key, `${sectionPath}.key`, issues);
    const label = expectString(sectionValue.label, `${sectionPath}.label`, issues);
    const description = expectString(
      sectionValue.description,
      `${sectionPath}.description`,
      issues,
      {
        allowEmpty: true,
      },
    );
    const displayOrder = expectNumber(
      sectionValue.displayOrder,
      `${sectionPath}.displayOrder`,
      issues,
    );
    const repeatable = expectBoolean(sectionValue.repeatable, `${sectionPath}.repeatable`, issues);
    const parentKey =
      sectionValue.parentKey === null || sectionValue.parentKey === undefined
        ? null
        : expectString(sectionValue.parentKey, `${sectionPath}.parentKey`, issues);
    if (key && label && description !== null && displayOrder !== null && repeatable !== null) {
      sections.push({
        key,
        label,
        description,
        displayOrder,
        parentKey,
        repeatable,
      });
    }
  }
  uniqueStrings(
    sections.map((item) => item.key),
    `${path}.sections`,
    issues,
    "schema.duplicate_section_key",
  );
  const sectionKeys = new Set(sections.map((item) => item.key));
  for (const section of sections) {
    if (section.parentKey && !sectionKeys.has(section.parentKey)) {
      issues.push(
        issue(
          "schema.invalid_parent_section",
          `${path}.sections.${section.key}.parentKey`,
          `Parent section '${section.parentKey}' does not exist.`,
          "Reference an existing section key.",
        ),
      );
    }
  }
  const fields: CanonicalFieldDefinition[] = [];
  for (const [index, fieldValue] of fieldsRaw.entries()) {
    const fieldPath = `${path}.fields[${index}]`;
    if (!isPlainObject(fieldValue)) {
      issues.push(
        issue(
          "schema.invalid_field",
          fieldPath,
          "Fields must be objects.",
          "Supply a field object.",
        ),
      );
      continue;
    }
    rejectUnknownKeys(fieldValue, FIELD_KEYS, fieldPath, issues);
    const key = expectString(fieldValue.key, `${fieldPath}.key`, issues);
    const label = expectString(fieldValue.label, `${fieldPath}.label`, issues);
    const description = expectString(fieldValue.description, `${fieldPath}.description`, issues, {
      allowEmpty: true,
    });
    const dataType = expectString(fieldValue.dataType, `${fieldPath}.dataType`, issues);
    if (dataType && !(CANONICAL_FIELD_TYPES as readonly string[]).includes(dataType)) {
      issues.push(
        issue(
          "schema.invalid_data_type",
          `${fieldPath}.dataType`,
          `Unknown data type '${dataType}'.`,
          `Use one of: ${CANONICAL_FIELD_TYPES.join(", ")}.`,
        ),
      );
    }
    const required = expectBoolean(fieldValue.required, `${fieldPath}.required`, issues);
    const defaultStatus = expectString(
      fieldValue.defaultStatus,
      `${fieldPath}.defaultStatus`,
      issues,
    );
    if (defaultStatus && !(DEFAULT_STATUS as readonly string[]).includes(defaultStatus)) {
      issues.push(
        issue(
          "schema.invalid_default_status",
          `${fieldPath}.defaultStatus`,
          `Invalid defaultStatus '${defaultStatus}'.`,
          "Use optional, required, or system.",
        ),
      );
    }
    const sectionKey = expectString(fieldValue.sectionKey, `${fieldPath}.sectionKey`, issues);
    if (sectionKey && !sectionKeys.has(sectionKey)) {
      issues.push(
        issue(
          "schema.invalid_section_reference",
          `${fieldPath}.sectionKey`,
          `Field references missing section '${sectionKey}'.`,
          "Use an existing section key.",
        ),
      );
    }
    const displayOrder = expectNumber(fieldValue.displayOrder, `${fieldPath}.displayOrder`, issues);
    const privacyClassification = expectString(
      fieldValue.privacyClassification,
      `${fieldPath}.privacyClassification`,
      issues,
    );
    if (privacyClassification && !(PRIVACY as readonly string[]).includes(privacyClassification)) {
      issues.push(
        issue(
          "schema.invalid_privacy",
          `${fieldPath}.privacyClassification`,
          `Invalid privacy classification '${privacyClassification}'.`,
          "Use operational, restricted, or signature.",
        ),
      );
    }
    if (
      fieldValue.evidenceRelationship &&
      !(EVIDENCE_REL as readonly string[]).includes(String(fieldValue.evidenceRelationship))
    ) {
      issues.push(
        issue(
          "schema.invalid_relationship",
          `${fieldPath}.evidenceRelationship`,
          "Invalid evidence relationship.",
          "Use none, requires_evidence, or is_evidence.",
        ),
      );
    }
    if (
      fieldValue.findingRelationship &&
      !(FINDING_REL as readonly string[]).includes(String(fieldValue.findingRelationship))
    ) {
      issues.push(
        issue(
          "schema.invalid_relationship",
          `${fieldPath}.findingRelationship`,
          "Invalid finding relationship.",
          "Use none, is_finding, or requires_finding.",
        ),
      );
    }
    if (fieldValue.allowedValues !== null && fieldValue.allowedValues !== undefined) {
      const allowed = expectArray(fieldValue.allowedValues, `${fieldPath}.allowedValues`, issues);
      if (allowed) {
        uniqueStrings(
          allowed.map((item) => String(item)),
          `${fieldPath}.allowedValues`,
          issues,
          "schema.duplicate_enum",
        );
      }
    }
    if (
      typeof fieldValue.minimum === "number" &&
      typeof fieldValue.maximum === "number" &&
      fieldValue.minimum > fieldValue.maximum
    ) {
      issues.push(
        issue(
          "schema.invalid_range",
          fieldPath,
          "minimum cannot exceed maximum.",
          "Correct the numeric range.",
        ),
      );
    }
    if (
      typeof fieldValue.minLength === "number" &&
      typeof fieldValue.maxLength === "number" &&
      fieldValue.minLength > fieldValue.maxLength
    ) {
      issues.push(
        issue(
          "schema.invalid_length_range",
          fieldPath,
          "minLength cannot exceed maxLength.",
          "Correct the length range.",
        ),
      );
    }
    const visibleIf =
      fieldValue.visibleIf === null || fieldValue.visibleIf === undefined
        ? null
        : parseFieldCondition(fieldValue.visibleIf, `${fieldPath}.visibleIf`, issues);
    const requiredIf =
      fieldValue.requiredIf === null || fieldValue.requiredIf === undefined
        ? null
        : parseFieldCondition(fieldValue.requiredIf, `${fieldPath}.requiredIf`, issues);
    const repeatableGroup =
      fieldValue.repeatableGroup === null || fieldValue.repeatableGroup === undefined
        ? null
        : expectString(fieldValue.repeatableGroup, `${fieldPath}.repeatableGroup`, issues);
    if (repeatableGroup && !sectionKeys.has(repeatableGroup)) {
      issues.push(
        issue(
          "schema.invalid_repeatable_group",
          `${fieldPath}.repeatableGroup`,
          `Repeatable group '${repeatableGroup}' does not exist.`,
          "Reference an existing section key.",
        ),
      );
    }
    const sourceLineageRequired = expectBoolean(
      fieldValue.sourceLineageRequired,
      `${fieldPath}.sourceLineageRequired`,
      issues,
    );
    const correctionGuidance = expectString(
      fieldValue.correctionGuidance,
      `${fieldPath}.correctionGuidance`,
      issues,
      { allowEmpty: true },
    );
    if (
      key &&
      label &&
      description !== null &&
      dataType &&
      required !== null &&
      defaultStatus &&
      sectionKey &&
      displayOrder !== null &&
      privacyClassification &&
      sourceLineageRequired !== null &&
      correctionGuidance !== null
    ) {
      fields.push({
        key,
        label,
        description,
        dataType: dataType as CanonicalFieldDefinition["dataType"],
        required,
        defaultStatus: defaultStatus as CanonicalFieldDefinition["defaultStatus"],
        sectionKey,
        displayOrder,
        repeatableGroup,
        allowedValues: Array.isArray(fieldValue.allowedValues)
          ? fieldValue.allowedValues.map((item) => String(item))
          : null,
        unit: typeof fieldValue.unit === "string" ? fieldValue.unit : null,
        minimum: typeof fieldValue.minimum === "number" ? fieldValue.minimum : null,
        maximum: typeof fieldValue.maximum === "number" ? fieldValue.maximum : null,
        minLength: typeof fieldValue.minLength === "number" ? fieldValue.minLength : null,
        maxLength: typeof fieldValue.maxLength === "number" ? fieldValue.maxLength : null,
        dateRule: typeof fieldValue.dateRule === "string" ? fieldValue.dateRule : null,
        privacyClassification:
          privacyClassification as CanonicalFieldDefinition["privacyClassification"],
        evidenceRelationship: (typeof fieldValue.evidenceRelationship === "string"
          ? fieldValue.evidenceRelationship
          : "none") as CanonicalFieldDefinition["evidenceRelationship"],
        findingRelationship: (typeof fieldValue.findingRelationship === "string"
          ? fieldValue.findingRelationship
          : "none") as CanonicalFieldDefinition["findingRelationship"],
        sourceLineageRequired,
        correctionGuidance,
        visibleIf,
        requiredIf,
      });
    }
  }
  uniqueStrings(
    fields.map((item) => item.key),
    `${path}.fields`,
    issues,
    "schema.duplicate_field_key",
  );
  if (
    issues.some((item) => item.blocking) ||
    !schemaKey ||
    schemaVersion === null ||
    !displayName ||
    synthetic === null
  ) {
    return { value: null, issues };
  }
  return {
    value: {
      schemaKey,
      schemaVersion,
      displayName,
      synthetic,
      disclosure: disclosure ?? CONFIGURATION_SYNTHETIC_DISCLOSURE,
      sections,
      fields,
    },
    issues,
  };
}

function parseCollection(
  value: unknown,
  path: string,
  issues: ConfigurationValidationIssue[],
): SourceCollectionMapping | null {
  if (!isPlainObject(value)) {
    issues.push(
      issue(
        "mapping.invalid_collection",
        path,
        "Collection mappings must be objects.",
        "Supply a collection object.",
      ),
    );
    return null;
  }
  rejectUnknownKeys(value, COLLECTION_KEYS, path, issues);
  const collectionKey = expectString(value.collectionKey, `${path}.collectionKey`, issues);
  const collectionKind = expectString(value.collectionKind, `${path}.collectionKind`, issues);
  if (collectionKind && !(COLLECTION_KINDS as readonly string[]).includes(collectionKind)) {
    issues.push(
      issue(
        "mapping.unknown_collection_kind",
        `${path}.collectionKind`,
        `Unknown collection kind '${collectionKind}'.`,
        `Use ${COLLECTION_KINDS.join(", ")}.`,
      ),
    );
  }
  const sourcePath = parseSafePath(value.sourcePath, `${path}.sourcePath`, issues, true);
  const cardinality = expectString(value.cardinality, `${path}.cardinality`, issues);
  if (cardinality && !(COLLECTION_CARDINALITIES as readonly string[]).includes(cardinality)) {
    issues.push(
      issue(
        "mapping.invalid_cardinality",
        `${path}.cardinality`,
        `Invalid cardinality '${cardinality}'.`,
        "Use one or many.",
      ),
    );
  }
  const requiredSource = expectBoolean(value.requiredSource, `${path}.requiredSource`, issues);
  const emptyBehavior = expectString(value.emptyBehavior, `${path}.emptyBehavior`, issues);
  if (emptyBehavior && !(COLLECTION_EMPTY_BEHAVIORS as readonly string[]).includes(emptyBehavior)) {
    issues.push(
      issue(
        "mapping.invalid_empty_behavior",
        `${path}.emptyBehavior`,
        "emptyBehavior must be block or allow.",
        "Use block or allow.",
      ),
    );
  }
  if (collectionKind === "repeatable_group" && typeof value.destinationGroupKey !== "string") {
    issues.push(
      issue(
        "mapping.missing_group_key",
        `${path}.destinationGroupKey`,
        "repeatable_group requires destinationGroupKey.",
        "Set destinationGroupKey to a schema section key.",
      ),
    );
  }
  const destinations =
    collectionKind === "findings"
      ? FINDING_BINDING_DESTINATIONS
      : collectionKind === "evidence"
        ? EVIDENCE_BINDING_DESTINATIONS
        : collectionKind === "signature"
          ? SIGNATURE_BINDING_DESTINATIONS
          : [];
  const bindingsRaw = expectArray(value.itemBindings, `${path}.itemBindings`, issues) ?? [];
  const itemBindings = bindingsRaw.flatMap((item, index) => {
    const parsed = parseItemBinding(
      item,
      `${path}.itemBindings[${index}]`,
      issues,
      destinations,
      collectionKind ?? "",
    );
    return parsed ? [parsed] : [];
  });
  uniqueStrings(
    itemBindings.map((item) => item.destination),
    `${path}.itemBindings`,
    issues,
    "mapping.duplicate_binding",
  );
  const relationships: CollectionRelationshipBinding[] = [];
  if (value.relationshipBindings !== undefined) {
    const raw =
      expectArray(value.relationshipBindings, `${path}.relationshipBindings`, issues) ?? [];
    for (const [index, item] of raw.entries()) {
      const relPath = `${path}.relationshipBindings[${index}]`;
      if (!isPlainObject(item)) {
        issues.push(
          issue(
            "mapping.invalid_relationship",
            relPath,
            "Relationships must be objects.",
            "Supply an object.",
          ),
        );
        continue;
      }
      rejectUnknownKeys(item, RELATIONSHIP_KEYS, relPath, issues);
      const relationshipKey = expectString(
        item.relationshipKey,
        `${relPath}.relationshipKey`,
        issues,
      );
      const relSource = parseSafePath(item.sourcePath, `${relPath}.sourcePath`, issues, true);
      const required = expectBoolean(item.required, `${relPath}.required`, issues);
      if (relationshipKey && relSource !== null && required !== null) {
        relationships.push({ relationshipKey, sourcePath: relSource, required });
      }
    }
  }
  if (
    !collectionKey ||
    !collectionKind ||
    sourcePath === null ||
    !cardinality ||
    requiredSource === null ||
    !emptyBehavior
  ) {
    return null;
  }
  return {
    collectionKey,
    collectionKind: collectionKind as SourceCollectionMapping["collectionKind"],
    sourcePath,
    cardinality: cardinality as SourceCollectionMapping["cardinality"],
    ...(typeof value.destinationGroupKey === "string"
      ? { destinationGroupKey: value.destinationGroupKey }
      : {}),
    itemBindings,
    ...(relationships.length > 0 ? { relationshipBindings: relationships } : {}),
    requiredSource,
    emptyBehavior: emptyBehavior as SourceCollectionMapping["emptyBehavior"],
  };
}

export function parseMappingProfile(
  value: unknown,
  path = "mapping_profile",
): ArtifactParseResult<SourceMappingProfile> {
  const issues: ConfigurationValidationIssue[] = [];
  if (!isPlainObject(value)) {
    return {
      value: null,
      issues: [
        issue(
          "artifact.invalid_type",
          path,
          "Mapping profile must be an object.",
          "Supply a mapping profile object.",
        ),
      ],
    };
  }
  rejectUnknownKeys(value, MAPPING_KEYS, path, issues);
  const profileKey = expectString(value.profileKey, `${path}.profileKey`, issues);
  const profileVersion = expectPositiveInteger(
    value.profileVersion,
    `${path}.profileVersion`,
    issues,
  );
  const displayName = expectString(value.displayName, `${path}.displayName`, issues);
  const synthetic = expectBoolean(value.synthetic, `${path}.synthetic`, issues);
  const sourceType = expectString(value.sourceType, `${path}.sourceType`, issues);
  if (sourceType && !(MAPPING_SOURCE_TYPES as readonly string[]).includes(sourceType)) {
    issues.push(
      issue(
        "mapping.unsupported_source_type",
        `${path}.sourceType`,
        `Unsupported source type '${sourceType}'.`,
        "Use json or csv.",
      ),
    );
  }
  const sourceSchemaVersion = expectString(
    value.sourceSchemaVersion,
    `${path}.sourceSchemaVersion`,
    issues,
  );
  const applicableConfiguration = expectString(
    value.applicableConfiguration,
    `${path}.applicableConfiguration`,
    issues,
  );
  const disclosure = expectString(value.disclosure, `${path}.disclosure`, issues, {
    allowEmpty: true,
  });
  const csvRowMode = expectString(value.csvRowMode, `${path}.csvRowMode`, issues);
  if (csvRowMode && !(CSV_ROW_MODES as readonly string[]).includes(csvRowMode)) {
    issues.push(
      issue(
        "mapping.invalid_csv_row_mode",
        `${path}.csvRowMode`,
        `Invalid csvRowMode '${csvRowMode}'.`,
        "Use single_record or record_collection.",
      ),
    );
  }
  const csvScalarStrategy = expectString(
    value.csvScalarStrategy,
    `${path}.csvScalarStrategy`,
    issues,
  );
  if (
    csvScalarStrategy &&
    !(CSV_SCALAR_STRATEGIES as readonly string[]).includes(csvScalarStrategy)
  ) {
    issues.push(
      issue(
        "mapping.invalid_csv_scalar_strategy",
        `${path}.csvScalarStrategy`,
        `Invalid csvScalarStrategy '${csvScalarStrategy}'.`,
        "Use all_rows_must_match or not_applicable. Do not guess a first-row authority.",
      ),
    );
  }
  if (
    sourceType === "csv" &&
    csvRowMode === "record_collection" &&
    csvScalarStrategy === "not_applicable"
  ) {
    issues.push(
      issue(
        "mapping.csv_scalar_strategy_required",
        `${path}.csvScalarStrategy`,
        "record_collection CSV profiles must declare a scalar strategy.",
        "Use all_rows_must_match. The first row is not assumed to be authoritative.",
      ),
    );
  }
  const rulesRaw = expectArray(value.rules, `${path}.rules`, issues);
  const rules: SourceMappingRule[] = [];
  if (rulesRaw) {
    for (const [index, ruleValue] of rulesRaw.entries()) {
      const rulePath = `${path}.rules[${index}]`;
      if (!isPlainObject(ruleValue)) {
        issues.push(
          issue(
            "mapping.invalid_rule",
            rulePath,
            "Mapping rules must be objects.",
            "Supply a rule object.",
          ),
        );
        continue;
      }
      rejectUnknownKeys(ruleValue, RULE_KEYS, rulePath, issues);
      const ruleKey = expectString(ruleValue.ruleKey, `${rulePath}.ruleKey`, issues);
      const sourcePath = parseSafePath(ruleValue.sourcePath, `${rulePath}.sourcePath`, issues);
      const canonicalField = expectString(
        ruleValue.canonicalField,
        `${rulePath}.canonicalField`,
        issues,
      );
      const requiredSource = expectBoolean(
        ruleValue.requiredSource,
        `${rulePath}.requiredSource`,
        issues,
      );
      const conflictBehavior = expectString(
        ruleValue.conflictBehavior,
        `${rulePath}.conflictBehavior`,
        issues,
      );
      if (conflictBehavior && !(CONFLICT as readonly string[]).includes(conflictBehavior)) {
        issues.push(
          issue(
            "mapping.invalid_conflict",
            `${rulePath}.conflictBehavior`,
            "Unsupported conflict behavior.",
            "Use reject, first_wins, or last_wins.",
          ),
        );
      }
      const nullBehavior = expectString(ruleValue.nullBehavior, `${rulePath}.nullBehavior`, issues);
      if (nullBehavior && !(NULL_BEHAVIOR as readonly string[]).includes(nullBehavior)) {
        issues.push(
          issue(
            "mapping.invalid_null_behavior",
            `${rulePath}.nullBehavior`,
            "Unsupported null behavior.",
            "Use leave_empty or use_default.",
          ),
        );
      }
      const transformsRaw =
        expectArray(ruleValue.transforms ?? [], `${rulePath}.transforms`, issues) ?? [];
      const transforms = transformsRaw.flatMap((item, transformIndex) => {
        const parsed = parseTransform(item, `${rulePath}.transforms[${transformIndex}]`, issues);
        return parsed ? [parsed] : [];
      });
      if (
        ruleKey &&
        sourcePath &&
        canonicalField &&
        requiredSource !== null &&
        conflictBehavior &&
        nullBehavior
      ) {
        rules.push({
          ruleKey,
          sourcePath,
          canonicalField,
          transforms,
          requiredSource,
          conflictBehavior: conflictBehavior as SourceMappingRule["conflictBehavior"],
          nullBehavior: nullBehavior as SourceMappingRule["nullBehavior"],
          ...(ruleValue.defaultValue !== undefined
            ? { defaultValue: ruleValue.defaultValue as JsonValue }
            : {}),
        });
      }
    }
  }
  uniqueStrings(
    rules.map((item) => item.ruleKey),
    `${path}.rules`,
    issues,
    "mapping.duplicate_rule_key",
  );
  const collectionsRaw = expectArray(value.collections, `${path}.collections`, issues) ?? [];
  const collections = collectionsRaw.flatMap((item, index) => {
    const parsed = parseCollection(item, `${path}.collections[${index}]`, issues);
    return parsed ? [parsed] : [];
  });
  uniqueStrings(
    collections.map((item) => item.collectionKey),
    `${path}.collections`,
    issues,
    "mapping.duplicate_collection_key",
  );
  if (
    issues.some((item) => item.blocking) ||
    !profileKey ||
    profileVersion === null ||
    !displayName ||
    synthetic === null ||
    !sourceType ||
    !csvRowMode ||
    !csvScalarStrategy
  ) {
    return { value: null, issues };
  }
  return {
    value: {
      profileKey,
      profileVersion,
      displayName,
      synthetic,
      sourceType: sourceType as SourceMappingProfile["sourceType"],
      sourceSchemaVersion: sourceSchemaVersion ?? "unspecified",
      applicableConfiguration: applicableConfiguration ?? profileKey,
      disclosure: disclosure ?? CONFIGURATION_SYNTHETIC_DISCLOSURE,
      csvRowMode: csvRowMode as SourceMappingProfile["csvRowMode"],
      csvScalarStrategy: csvScalarStrategy as SourceMappingProfile["csvScalarStrategy"],
      rules,
      collections,
    },
    issues,
  };
}

function parseExpression(
  value: unknown,
  path: string,
  issues: ConfigurationValidationIssue[],
): ValidationExpression | null {
  if (!isPlainObject(value)) {
    issues.push(
      issue(
        "validation.invalid_expression",
        path,
        "Validation expressions must be objects.",
        "Supply an expression object.",
      ),
    );
    return null;
  }
  const kind = expectString(value.kind, `${path}.kind`, issues);
  if (!kind) return null;
  if (!(VALIDATION_EXPRESSION_KINDS as readonly string[]).includes(kind)) {
    issues.push(
      issue(
        "validation.unknown_expression_kind",
        `${path}.kind`,
        `Unknown validation-expression kind '${kind}'.`,
        "Replace the expression with a supported kind. Unknown kinds cannot validate, publish, or execute.",
      ),
    );
    return null;
  }
  const allowedByKind: Record<string, readonly string[]> = {
    required: ["kind", "field"],
    required_if: ["kind", "field", "condition"],
    min_number: ["kind", "field", "minimum"],
    max_number: ["kind", "field", "maximum"],
    min_length: ["kind", "field", "minimum"],
    max_length: ["kind", "field", "maximum"],
    allowed_enum: ["kind", "field", "values"],
    date_ordering: ["kind", "earlierField", "laterField"],
    timestamp_ordering: ["kind", "earlierField", "laterField"],
    cross_field_compare: ["kind", "leftField", "operator", "rightField"],
    min_evidence_count: ["kind", "minimum"],
    min_photo_count: ["kind", "minimum"],
    required_caption: ["kind"],
    required_finding_relationship: ["kind"],
    required_signature: ["kind"],
    required_reviewer_role: ["kind", "role"],
    unique_in_group: ["kind", "groupKey", "field"],
    advisory: ["kind", "field", "message"],
  };
  rejectUnknownKeys(value, allowedByKind[kind] ?? ["kind"], path, issues);
  switch (kind) {
    case "required":
    case "advisory": {
      const field = expectString(value.field, `${path}.field`, issues);
      if (!field) return null;
      if (kind === "advisory") {
        const message = expectString(value.message, `${path}.message`, issues);
        if (!message) return null;
        return { kind, field, message };
      }
      return { kind: "required", field };
    }
    case "required_if": {
      const field = expectString(value.field, `${path}.field`, issues);
      const condition = parseFieldCondition(value.condition, `${path}.condition`, issues);
      if (!field || !condition) return null;
      return { kind, field, condition };
    }
    case "min_number":
    case "max_number":
    case "min_length":
    case "max_length": {
      const field = expectString(value.field, `${path}.field`, issues);
      const boundName = kind.startsWith("max") ? "maximum" : "minimum";
      const bound = expectNumber(value[boundName], `${path}.${boundName}`, issues);
      if (!field || bound === null) return null;
      return kind === "min_number" || kind === "min_length"
        ? { kind, field, minimum: bound }
        : { kind, field, maximum: bound };
    }
    case "allowed_enum": {
      const field = expectString(value.field, `${path}.field`, issues);
      const values = expectArray(value.values, `${path}.values`, issues);
      if (!field || !values) return null;
      return { kind, field, values: values.map((item) => String(item)) };
    }
    case "date_ordering":
    case "timestamp_ordering": {
      const earlierField = expectString(value.earlierField, `${path}.earlierField`, issues);
      const laterField = expectString(value.laterField, `${path}.laterField`, issues);
      if (!earlierField || !laterField) return null;
      return { kind, earlierField, laterField };
    }
    case "cross_field_compare": {
      const leftField = expectString(value.leftField, `${path}.leftField`, issues);
      const rightField = expectString(value.rightField, `${path}.rightField`, issues);
      const operator = expectString(value.operator, `${path}.operator`, issues);
      if (operator && !(TRIGGER_COMPARE as readonly string[]).includes(operator)) {
        issues.push(
          issue(
            "validation.invalid_operator",
            `${path}.operator`,
            `Unsupported operator '${operator}'.`,
            "Use eq, neq, gt, gte, lt, or lte.",
          ),
        );
        return null;
      }
      if (!leftField || !rightField || !operator) return null;
      return {
        kind,
        leftField,
        rightField,
        operator: operator as Extract<
          ValidationExpression,
          { kind: "cross_field_compare" }
        >["operator"],
      };
    }
    case "min_evidence_count":
    case "min_photo_count": {
      const minimum = expectNumber(value.minimum, `${path}.minimum`, issues);
      if (minimum === null) return null;
      return { kind, minimum };
    }
    case "required_caption":
    case "required_finding_relationship":
    case "required_signature":
      return { kind };
    case "required_reviewer_role": {
      const role = expectString(value.role, `${path}.role`, issues);
      if (!role) return null;
      return { kind, role };
    }
    case "unique_in_group": {
      const groupKey = expectString(value.groupKey, `${path}.groupKey`, issues);
      const field = expectString(value.field, `${path}.field`, issues);
      if (!groupKey || !field) return null;
      return { kind, groupKey, field };
    }
    default:
      issues.push(
        issue(
          "validation.unknown_expression_kind",
          `${path}.kind`,
          `Unknown validation-expression kind '${kind}'.`,
          "Replace the expression with a supported kind.",
        ),
      );
      return null;
  }
}

export function parseValidationRuleSet(
  value: unknown,
  path = "validation_rule_set",
): ArtifactParseResult<ValidationRuleSet> {
  const issues: ConfigurationValidationIssue[] = [];
  if (!isPlainObject(value)) {
    return {
      value: null,
      issues: [
        issue(
          "artifact.invalid_type",
          path,
          "Validation rule set must be an object.",
          "Supply a rule-set object.",
        ),
      ],
    };
  }
  rejectUnknownKeys(value, VALIDATION_SET_KEYS, path, issues);
  const ruleSetKey = expectString(value.ruleSetKey, `${path}.ruleSetKey`, issues);
  const ruleSetVersion = expectPositiveInteger(
    value.ruleSetVersion,
    `${path}.ruleSetVersion`,
    issues,
  );
  const displayName = expectString(value.displayName, `${path}.displayName`, issues);
  const synthetic = expectBoolean(value.synthetic, `${path}.synthetic`, issues);
  const disclosure = expectString(value.disclosure, `${path}.disclosure`, issues, {
    allowEmpty: true,
  });
  const rulesRaw = expectArray(value.rules, `${path}.rules`, issues) ?? [];
  const rules: ValidationRuleDefinition[] = [];
  for (const [index, ruleValue] of rulesRaw.entries()) {
    const rulePath = `${path}.rules[${index}]`;
    if (!isPlainObject(ruleValue)) {
      issues.push(
        issue(
          "validation.invalid_rule",
          rulePath,
          "Rules must be objects.",
          "Supply a rule object.",
        ),
      );
      continue;
    }
    rejectUnknownKeys(ruleValue, VALIDATION_RULE_KEYS, rulePath, issues);
    const ruleKey = expectString(ruleValue.ruleKey, `${rulePath}.ruleKey`, issues);
    const label = expectString(ruleValue.label, `${rulePath}.label`, issues);
    const description = expectString(ruleValue.description, `${rulePath}.description`, issues, {
      allowEmpty: true,
    });
    const severity = expectString(ruleValue.severity, `${rulePath}.severity`, issues);
    if (severity && !(VALIDATION_SEVERITIES as readonly string[]).includes(severity)) {
      issues.push(
        issue(
          "validation.invalid_severity",
          `${rulePath}.severity`,
          `Invalid severity '${severity}'.`,
          "Use blocking, warning, or advisory.",
        ),
      );
    }
    const blocking = expectBoolean(ruleValue.blocking, `${rulePath}.blocking`, issues);
    if (severity === "blocking" && blocking === false) {
      issues.push(
        issue(
          "validation.inconsistent_blocking",
          rulePath,
          "Blocking severity requires blocking: true.",
          "Set blocking to true for blocking rules.",
        ),
      );
    }
    if (severity && severity !== "blocking" && blocking === true) {
      issues.push(
        issue(
          "validation.inconsistent_blocking",
          rulePath,
          "Non-blocking severity cannot set blocking: true.",
          "Set blocking to false for warning and advisory rules.",
        ),
      );
    }
    const sectionKey = expectString(ruleValue.sectionKey, `${rulePath}.sectionKey`, issues);
    const trigger = parseFieldCondition(ruleValue.trigger, `${rulePath}.trigger`, issues);
    const expression = parseExpression(ruleValue.expression, `${rulePath}.expression`, issues);
    const remediation = expectString(ruleValue.remediation, `${rulePath}.remediation`, issues, {
      allowEmpty: true,
    });
    if (
      ruleKey &&
      label &&
      description !== null &&
      severity &&
      blocking !== null &&
      sectionKey &&
      trigger &&
      expression &&
      remediation !== null
    ) {
      rules.push({
        ruleKey,
        label,
        description,
        severity: severity as ValidationRuleDefinition["severity"],
        blocking,
        sectionKey,
        trigger,
        expression,
        remediation,
      });
    }
  }
  uniqueStrings(
    rules.map((item) => item.ruleKey),
    `${path}.rules`,
    issues,
    "validation.duplicate_rule_key",
  );
  if (
    issues.some((item) => item.blocking) ||
    !ruleSetKey ||
    ruleSetVersion === null ||
    !displayName ||
    synthetic === null
  ) {
    return { value: null, issues };
  }
  return {
    value: {
      ruleSetKey,
      ruleSetVersion,
      displayName,
      synthetic,
      disclosure: disclosure ?? CONFIGURATION_SYNTHETIC_DISCLOSURE,
      rules,
    },
    issues,
  };
}

function assertSafeStaticText(
  value: string,
  path: string,
  issues: ConfigurationValidationIssue[],
): void {
  if (SCRIPT_MARKUP.test(value)) {
    issues.push(
      issue(
        "template.unsafe_markup",
        path,
        "Executable markup is not allowed in report text.",
        "Remove script, javascript:, and event-handler content.",
      ),
    );
  }
}

function assertPlaceholderTokens(
  pattern: string,
  path: string,
  allowed: readonly string[],
  issues: ConfigurationValidationIssue[],
): void {
  if (pattern.includes("..") || pattern.includes("\\")) {
    issues.push(
      issue(
        "policy.path_traversal",
        path,
        "Path traversal is not allowed in configured patterns.",
        "Remove .. and backslashes. Use allow-listed tokens only.",
      ),
    );
  }
  for (const match of pattern.matchAll(PLACEHOLDER_TOKEN)) {
    const token = match[1] ?? "";
    if (!allowed.includes(token)) {
      issues.push(
        issue(
          "policy.unknown_placeholder",
          path,
          `Placeholder {${token}} is not on the allow-list.`,
          `Allowed tokens: ${allowed.map((item) => `{${item}}`).join(", ")}.`,
        ),
      );
    }
  }
}

export function parseReportTemplate(
  value: unknown,
  path = "report_template",
): ArtifactParseResult<ReportTemplateDefinition> {
  const issues: ConfigurationValidationIssue[] = [];
  if (!isPlainObject(value)) {
    return {
      value: null,
      issues: [
        issue(
          "artifact.invalid_type",
          path,
          "Report template must be an object.",
          "Supply a template object.",
        ),
      ],
    };
  }
  rejectUnknownKeys(value, TEMPLATE_KEYS, path, issues);
  const templateKey = expectString(value.templateKey, `${path}.templateKey`, issues);
  const templateVersion = expectPositiveInteger(
    value.templateVersion,
    `${path}.templateVersion`,
    issues,
  );
  const displayName = expectString(value.displayName, `${path}.displayName`, issues);
  const synthetic = expectBoolean(value.synthetic, `${path}.synthetic`, issues);
  const disclosure = expectString(value.disclosure, `${path}.disclosure`, issues, {
    allowEmpty: true,
  });
  const applicableSchemaKey = expectString(
    value.applicableSchemaKey,
    `${path}.applicableSchemaKey`,
    issues,
  );
  const applicableMappingKey = expectString(
    value.applicableMappingKey,
    `${path}.applicableMappingKey`,
    issues,
  );
  const rendererAdapter = expectString(value.rendererAdapter, `${path}.rendererAdapter`, issues);
  if (rendererAdapter && rendererAdapter !== SUPPORTED_RENDERER) {
    issues.push(
      issue(
        "template.unsupported_adapter",
        `${path}.rendererAdapter`,
        `Renderer adapter ${rendererAdapter} is not implemented.`,
        "Use bea.deterministic-synthetic-pdf.v1. DOCX and fillable PDF remain reserved.",
      ),
    );
  }
  const filenamePattern = expectString(value.filenamePattern, `${path}.filenamePattern`, issues);
  if (filenamePattern)
    assertPlaceholderTokens(
      filenamePattern,
      `${path}.filenamePattern`,
      REPORT_FILENAME_TOKENS,
      issues,
    );
  const missingValueBehavior = expectString(
    value.missingValueBehavior,
    `${path}.missingValueBehavior`,
    issues,
  );
  if (
    missingValueBehavior &&
    !(MISSING_VALUE as readonly string[]).includes(missingValueBehavior)
  ) {
    issues.push(
      issue(
        "template.invalid_missing_behavior",
        `${path}.missingValueBehavior`,
        "Invalid missing-value behavior.",
        "Use show_placeholder, omit, or show_not_recorded.",
      ),
    );
  }
  const headerText =
    expectString(value.headerText, `${path}.headerText`, issues, { allowEmpty: true }) ?? "";
  const footerText =
    expectString(value.footerText, `${path}.footerText`, issues, { allowEmpty: true }) ?? "";
  assertSafeStaticText(headerText, `${path}.headerText`, issues);
  assertSafeStaticText(footerText, `${path}.footerText`, issues);
  const includePageNumbers = expectBoolean(
    value.includePageNumbers,
    `${path}.includePageNumbers`,
    issues,
  );
  const sectionsRaw = expectArray(value.sections, `${path}.sections`, issues) ?? [];
  const sections: ReportTemplateSection[] = [];
  const nodeKeys: string[] = [];
  for (const [index, sectionValue] of sectionsRaw.entries()) {
    const sectionPath = `${path}.sections[${index}]`;
    if (!isPlainObject(sectionValue)) {
      issues.push(
        issue(
          "template.invalid_section",
          sectionPath,
          "Template sections must be objects.",
          "Supply a section.",
        ),
      );
      continue;
    }
    rejectUnknownKeys(sectionValue, TEMPLATE_SECTION_KEYS, sectionPath, issues);
    const key = expectString(sectionValue.key, `${sectionPath}.key`, issues);
    const title = expectString(sectionValue.title, `${sectionPath}.title`, issues);
    const displayOrder = expectNumber(
      sectionValue.displayOrder,
      `${sectionPath}.displayOrder`,
      issues,
    );
    const visibleIf =
      sectionValue.visibleIf === undefined
        ? undefined
        : (parseFieldCondition(sectionValue.visibleIf, `${sectionPath}.visibleIf`, issues) ??
          undefined);
    const nodesRaw = expectArray(sectionValue.nodes, `${sectionPath}.nodes`, issues) ?? [];
    const nodes: ReportTemplateNode[] = [];
    for (const [nodeIndex, nodeValue] of nodesRaw.entries()) {
      const nodePath = `${sectionPath}.nodes[${nodeIndex}]`;
      if (!isPlainObject(nodeValue)) {
        issues.push(
          issue(
            "template.invalid_node",
            nodePath,
            "Nodes must be objects.",
            "Supply a node object.",
          ),
        );
        continue;
      }
      rejectUnknownKeys(nodeValue, NODE_KEYS, nodePath, issues);
      const kind = expectString(nodeValue.kind, `${nodePath}.kind`, issues);
      if (kind && !(REPORT_NODE_KINDS as readonly string[]).includes(kind)) {
        issues.push(
          issue(
            "template.unknown_node_kind",
            `${nodePath}.kind`,
            `Unknown report node kind '${kind}'.`,
            `Use one of: ${REPORT_NODE_KINDS.join(", ")}.`,
          ),
        );
      }
      const nodeKey = expectString(nodeValue.key, `${nodePath}.key`, issues);
      if (nodeKey) nodeKeys.push(nodeKey);
      if (typeof nodeValue.text === "string")
        assertSafeStaticText(nodeValue.text, `${nodePath}.text`, issues);
      if (
        nodeValue.imagePlacement !== undefined &&
        !(IMAGE_PLACEMENT as readonly string[]).includes(String(nodeValue.imagePlacement))
      ) {
        issues.push(
          issue(
            "template.invalid_image_placement",
            `${nodePath}.imagePlacement`,
            "Invalid image placement.",
            "Use grid, inline, or finding_adjacent.",
          ),
        );
      }
      const nodeVisibleIf =
        nodeValue.visibleIf === undefined
          ? undefined
          : (parseFieldCondition(nodeValue.visibleIf, `${nodePath}.visibleIf`, issues) ??
            undefined);
      if (kind && nodeKey) {
        const node: ReportTemplateNode = {
          kind: kind as ReportTemplateNode["kind"],
          key: nodeKey,
        };
        if (typeof nodeValue.title === "string") {
          Object.assign(node, { title: nodeValue.title });
        }
        if (typeof nodeValue.text === "string") {
          Object.assign(node, { text: nodeValue.text });
        }
        if (typeof nodeValue.fieldKey === "string") {
          Object.assign(node, { fieldKey: nodeValue.fieldKey });
        }
        if (Array.isArray(nodeValue.columns)) {
          Object.assign(node, { columns: nodeValue.columns.map((item) => String(item)) });
        }
        if (typeof nodeValue.groupKey === "string") {
          Object.assign(node, { groupKey: nodeValue.groupKey });
        }
        if (nodeVisibleIf) {
          Object.assign(node, { visibleIf: nodeVisibleIf });
        }
        if (
          typeof nodeValue.imagePlacement === "string" &&
          (IMAGE_PLACEMENT as readonly string[]).includes(nodeValue.imagePlacement)
        ) {
          Object.assign(node, {
            imagePlacement: nodeValue.imagePlacement as NonNullable<
              ReportTemplateNode["imagePlacement"]
            >,
          });
        }
        nodes.push(node);
      }
    }
    if (key && title && displayOrder !== null) {
      sections.push({
        key,
        title,
        displayOrder,
        ...(visibleIf ? { visibleIf } : {}),
        nodes,
      });
    }
  }
  uniqueStrings(
    sections.map((item) => item.key),
    `${path}.sections`,
    issues,
    "template.duplicate_section_key",
  );
  uniqueStrings(nodeKeys, `${path}.nodes`, issues, "template.duplicate_node_key");
  if (
    issues.some((item) => item.blocking) ||
    !templateKey ||
    templateVersion === null ||
    !displayName ||
    synthetic === null ||
    !filenamePattern ||
    includePageNumbers === null
  ) {
    return { value: null, issues };
  }
  return {
    value: {
      templateKey,
      templateVersion,
      displayName,
      synthetic,
      disclosure: disclosure ?? CONFIGURATION_SYNTHETIC_DISCLOSURE,
      applicableSchemaKey: applicableSchemaKey ?? "",
      applicableMappingKey: applicableMappingKey ?? "",
      rendererAdapter: rendererAdapter ?? SUPPORTED_RENDERER,
      filenamePattern,
      missingValueBehavior: (missingValueBehavior ??
        "show_not_recorded") as ReportTemplateDefinition["missingValueBehavior"],
      headerText,
      footerText,
      includePageNumbers,
      sections,
    },
    issues,
  };
}

export function parseReviewPolicy(
  value: unknown,
  path = "review_policy",
): ArtifactParseResult<ReviewPolicyDefinition> {
  const issues: ConfigurationValidationIssue[] = [];
  if (!isPlainObject(value)) {
    return {
      value: null,
      issues: [
        issue(
          "artifact.invalid_type",
          path,
          "Review policy must be an object.",
          "Supply a review-policy object.",
        ),
      ],
    };
  }
  rejectUnknownKeys(value, REVIEW_KEYS, path, issues);
  for (const key of REVIEW_KEYS) {
    if (!(key in value)) {
      issues.push(
        issue(
          "review.missing_property",
          `${path}.${key}`,
          `Missing review-policy property '${key}'.`,
          "Supply every required review-policy field.",
        ),
      );
    }
  }
  const policyKey = expectString(value.policyKey, `${path}.policyKey`, issues);
  const policyVersion = expectPositiveInteger(value.policyVersion, `${path}.policyVersion`, issues);
  const synthetic = expectBoolean(value.synthetic, `${path}.synthetic`, issues);
  const disclosure = expectString(value.disclosure, `${path}.disclosure`, issues, {
    allowEmpty: true,
  });
  const technicalReviewerRole = expectString(
    value.technicalReviewerRole,
    `${path}.technicalReviewerRole`,
    issues,
  );
  const assignmentStrategy = expectString(
    value.assignmentStrategy,
    `${path}.assignmentStrategy`,
    issues,
  );
  if (assignmentStrategy && assignmentStrategy !== "inspection_reviewer") {
    issues.push(
      issue(
        "review.deferred_assignment_strategy",
        `${path}.assignmentStrategy`,
        "Alternate assignment strategies are DEFERRED in Phase 3.1A.",
        "Use inspection_reviewer. Role-pool assignment is not implemented.",
      ),
    );
  }
  const requiredTechnicalApprovals = expectNumber(
    value.requiredTechnicalApprovals,
    `${path}.requiredTechnicalApprovals`,
    issues,
  );
  if (requiredTechnicalApprovals !== null && requiredTechnicalApprovals !== 1) {
    issues.push(
      issue(
        "review.deferred_multi_approval",
        `${path}.requiredTechnicalApprovals`,
        "Only one technical approval is supported in Phase 3.1A.",
        "Set requiredTechnicalApprovals to 1. Multi-approval is DEFERRED.",
      ),
    );
  }
  const selfReviewPermitted = expectBoolean(
    value.selfReviewPermitted,
    `${path}.selfReviewPermitted`,
    issues,
  );
  if (selfReviewPermitted === true) {
    issues.push(
      issue(
        "review.deferred_self_review",
        `${path}.selfReviewPermitted`,
        "Self-review is not enforced and must remain false in Phase 3.1A.",
        "Set selfReviewPermitted to false. Broader self-review variants are DEFERRED.",
      ),
    );
  }
  const revisionResponsibility = expectString(
    value.revisionResponsibility,
    `${path}.revisionResponsibility`,
    issues,
  );
  if (revisionResponsibility && revisionResponsibility !== "inspector") {
    issues.push(
      issue(
        "review.deferred_revision_responsibility",
        `${path}.revisionResponsibility`,
        "Configurable revision responsibility is DEFERRED.",
        "Use inspector. Reviewer-owned revision is not implemented.",
      ),
    );
  }
  const deliveryAuthorizerRole = expectString(
    value.deliveryAuthorizerRole,
    `${path}.deliveryAuthorizerRole`,
    issues,
  );
  if (deliveryAuthorizerRole && deliveryAuthorizerRole !== "owner-admin") {
    issues.push(
      issue(
        "review.delivery_authorizer_locked",
        `${path}.deliveryAuthorizerRole`,
        "Delivery authorization must remain Owner-only.",
        "Set deliveryAuthorizerRole to owner-admin.",
      ),
    );
  }
  const finalSendAuthorizationRequired = expectBoolean(
    value.finalSendAuthorizationRequired,
    `${path}.finalSendAuthorizationRequired`,
    issues,
  );
  if (finalSendAuthorizationRequired === false) {
    issues.push(
      issue(
        "review.final_send_required",
        `${path}.finalSendAuthorizationRequired`,
        "Final-send authorization must remain true.",
        "Do not weaken Owner delivery authorization.",
      ),
    );
  }
  if (
    issues.some((item) => item.blocking) ||
    !policyKey ||
    policyVersion === null ||
    synthetic === null ||
    !technicalReviewerRole ||
    requiredTechnicalApprovals === null ||
    selfReviewPermitted === null ||
    finalSendAuthorizationRequired === null
  ) {
    return { value: null, issues };
  }
  return {
    value: {
      policyKey,
      policyVersion,
      synthetic,
      disclosure: disclosure ?? CONFIGURATION_SYNTHETIC_DISCLOSURE,
      technicalReviewerRole,
      assignmentStrategy: "inspection_reviewer",
      requiredTechnicalApprovals: 1,
      selfReviewPermitted: false,
      revisionResponsibility: "inspector",
      deliveryAuthorizerRole: "owner-admin",
      finalSendAuthorizationRequired: true,
    },
    issues,
  };
}

function rejectCredentialFields(
  value: Record<string, unknown>,
  path: string,
  issues: ConfigurationValidationIssue[],
): void {
  for (const key of Object.keys(value)) {
    if (CREDENTIAL_KEY.test(key)) {
      issues.push(
        issue(
          "policy.credential_field",
          `${path}.${key}`,
          "Credential fields are not permitted on storage or delivery policies.",
          "Remove secrets. Connectors remain disconnected.",
        ),
      );
    }
  }
}

export function parseStoragePolicy(
  value: unknown,
  path = "storage_policy",
): ArtifactParseResult<StoragePolicyDefinition> {
  const issues: ConfigurationValidationIssue[] = [];
  if (!isPlainObject(value)) {
    return {
      value: null,
      issues: [
        issue(
          "artifact.invalid_type",
          path,
          "Storage policy must be an object.",
          "Supply a storage-policy object.",
        ),
      ],
    };
  }
  rejectUnknownKeys(value, STORAGE_KEYS, path, issues);
  rejectCredentialFields(value, path, issues);
  const policyKey = expectString(value.policyKey, `${path}.policyKey`, issues);
  const policyVersion = expectPositiveInteger(value.policyVersion, `${path}.policyVersion`, issues);
  const synthetic = expectBoolean(value.synthetic, `${path}.synthetic`, issues);
  const disclosure = expectString(value.disclosure, `${path}.disclosure`, issues, {
    allowEmpty: true,
  });
  const projectFolderPattern = expectString(
    value.projectFolderPattern,
    `${path}.projectFolderPattern`,
    issues,
  );
  const inspectionFolderPattern = expectString(
    value.inspectionFolderPattern,
    `${path}.inspectionFolderPattern`,
    issues,
  );
  const reportFolderPattern = expectString(
    value.reportFolderPattern,
    `${path}.reportFolderPattern`,
    issues,
  );
  const fileNamePattern = expectString(value.fileNamePattern, `${path}.fileNamePattern`, issues);
  for (const [pattern, patternPath] of [
    [projectFolderPattern, `${path}.projectFolderPattern`],
    [inspectionFolderPattern, `${path}.inspectionFolderPattern`],
    [reportFolderPattern, `${path}.reportFolderPattern`],
    [fileNamePattern, `${path}.fileNamePattern`],
  ] as const) {
    if (pattern) assertPlaceholderTokens(pattern, patternPath, STORAGE_PLACEHOLDER_TOKENS, issues);
  }
  const configured = expectBoolean(value.configured, `${path}.configured`, issues);
  const versionBehavior = expectString(value.versionBehavior, `${path}.versionBehavior`, issues);
  const conflictBehavior = expectString(value.conflictBehavior, `${path}.conflictBehavior`, issues);
  const metadataFields = expectArray(value.metadataFields, `${path}.metadataFields`, issues) ?? [];
  if (
    issues.some((item) => item.blocking) ||
    !policyKey ||
    policyVersion === null ||
    synthetic === null ||
    !projectFolderPattern ||
    !inspectionFolderPattern ||
    !reportFolderPattern ||
    !fileNamePattern ||
    configured === null
  ) {
    return { value: null, issues };
  }
  return {
    value: {
      policyKey,
      policyVersion,
      synthetic,
      disclosure: disclosure ?? CONFIGURATION_SYNTHETIC_DISCLOSURE,
      sharePointTenant: typeof value.sharePointTenant === "string" ? value.sharePointTenant : null,
      site: typeof value.site === "string" ? value.site : null,
      documentLibrary: typeof value.documentLibrary === "string" ? value.documentLibrary : null,
      projectFolderPattern,
      inspectionFolderPattern,
      reportFolderPattern,
      fileNamePattern,
      versionBehavior: (versionBehavior ??
        "new_version") as StoragePolicyDefinition["versionBehavior"],
      conflictBehavior: (conflictBehavior ?? "fail") as StoragePolicyDefinition["conflictBehavior"],
      metadataFields: metadataFields.map((item) => String(item)),
      configured,
    },
    issues,
  };
}

export function parseDeliveryPolicy(
  value: unknown,
  path = "delivery_policy",
): ArtifactParseResult<DeliveryPolicyDefinition> {
  const issues: ConfigurationValidationIssue[] = [];
  if (!isPlainObject(value)) {
    return {
      value: null,
      issues: [
        issue(
          "artifact.invalid_type",
          path,
          "Delivery policy must be an object.",
          "Supply a delivery-policy object.",
        ),
      ],
    };
  }
  rejectUnknownKeys(value, DELIVERY_KEYS, path, issues);
  rejectCredentialFields(value, path, issues);
  const policyKey = expectString(value.policyKey, `${path}.policyKey`, issues);
  const policyVersion = expectPositiveInteger(value.policyVersion, `${path}.policyVersion`, issues);
  const synthetic = expectBoolean(value.synthetic, `${path}.synthetic`, issues);
  const disclosure = expectString(value.disclosure, `${path}.disclosure`, issues, {
    allowEmpty: true,
  });
  const toPattern = expectString(value.toPattern, `${path}.toPattern`, issues);
  const bccRestricted = expectBoolean(value.bccRestricted, `${path}.bccRestricted`, issues);
  if (bccRestricted === false) {
    issues.push(
      issue(
        "delivery.bcc_required",
        `${path}.bccRestricted`,
        "BCC restriction must remain enforced.",
        "Set bccRestricted to true.",
      ),
    );
  }
  const subjectPattern = expectString(value.subjectPattern, `${path}.subjectPattern`, issues, {
    allowEmpty: true,
  });
  const bodyTemplate = expectString(value.bodyTemplate, `${path}.bodyTemplate`, issues, {
    allowEmpty: true,
  });
  const attachmentNamePattern = expectString(
    value.attachmentNamePattern,
    `${path}.attachmentNamePattern`,
    issues,
  );
  for (const [pattern, patternPath] of [
    [subjectPattern, `${path}.subjectPattern`],
    [bodyTemplate, `${path}.bodyTemplate`],
    [attachmentNamePattern, `${path}.attachmentNamePattern`],
    [toPattern, `${path}.toPattern`],
  ] as const) {
    if (pattern) assertPlaceholderTokens(pattern, patternPath, STORAGE_PLACEHOLDER_TOKENS, issues);
  }
  const deliveryAuthorizerRole = expectString(
    value.deliveryAuthorizerRole,
    `${path}.deliveryAuthorizerRole`,
    issues,
  );
  if (deliveryAuthorizerRole && deliveryAuthorizerRole !== "owner-admin") {
    issues.push(
      issue(
        "delivery.authorizer_locked",
        `${path}.deliveryAuthorizerRole`,
        "Delivery authorization must remain Owner-only.",
        "Set deliveryAuthorizerRole to owner-admin.",
      ),
    );
  }
  const retryPolicy = expectString(value.retryPolicy, `${path}.retryPolicy`, issues, {
    allowEmpty: true,
  });
  const reconciliationPolicy = expectString(
    value.reconciliationPolicy,
    `${path}.reconciliationPolicy`,
    issues,
    {
      allowEmpty: true,
    },
  );
  const configured = expectBoolean(value.configured, `${path}.configured`, issues);
  if (
    issues.some((item) => item.blocking) ||
    !policyKey ||
    policyVersion === null ||
    synthetic === null ||
    !toPattern ||
    bccRestricted === null ||
    !attachmentNamePattern ||
    configured === null
  ) {
    return { value: null, issues };
  }
  return {
    value: {
      policyKey,
      policyVersion,
      synthetic,
      disclosure: disclosure ?? CONFIGURATION_SYNTHETIC_DISCLOSURE,
      senderMailbox: typeof value.senderMailbox === "string" ? value.senderMailbox : null,
      toPattern,
      ccPattern: typeof value.ccPattern === "string" ? value.ccPattern : null,
      bccRestricted: true,
      subjectPattern: subjectPattern ?? "",
      bodyTemplate: bodyTemplate ?? "",
      attachmentNamePattern,
      deliveryAuthorizerRole: "owner-admin",
      retryPolicy: retryPolicy ?? "manual-retry-after-authorization",
      reconciliationPolicy: reconciliationPolicy ?? "no-live-reconciliation",
      configured,
    },
    issues,
  };
}

function isValidTimeZone(value: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function parseSlaPolicy(
  value: unknown,
  path = "sla_policy",
): ArtifactParseResult<SlaPolicyDefinition> {
  const issues: ConfigurationValidationIssue[] = [];
  if (!isPlainObject(value)) {
    return {
      value: null,
      issues: [
        issue(
          "artifact.invalid_type",
          path,
          "SLA policy must be an object.",
          "Supply an SLA-policy object.",
        ),
      ],
    };
  }
  rejectUnknownKeys(value, SLA_KEYS, path, issues);
  const policyKey = expectString(value.policyKey, `${path}.policyKey`, issues);
  const policyVersion = expectPositiveInteger(value.policyVersion, `${path}.policyVersion`, issues);
  const synthetic = expectBoolean(value.synthetic, `${path}.synthetic`, issues);
  const disclosure = expectString(value.disclosure, `${path}.disclosure`, issues, {
    allowEmpty: true,
  });
  const calendarMode = expectString(value.calendarMode, `${path}.calendarMode`, issues);
  if (calendarMode && calendarMode !== "calendar_time" && calendarMode !== "business_hours") {
    issues.push(
      issue(
        "sla.invalid_calendar_mode",
        `${path}.calendarMode`,
        `Invalid calendar mode '${calendarMode}'.`,
        "Use calendar_time or business_hours.",
      ),
    );
  }
  const timeZone = expectString(value.timeZone, `${path}.timeZone`, issues);
  if (timeZone && !isValidTimeZone(timeZone)) {
    issues.push(
      issue(
        "sla.invalid_time_zone",
        `${path}.timeZone`,
        `Invalid time zone '${timeZone}'.`,
        "Use an IANA time-zone name.",
      ),
    );
  }
  const workdaysRaw = expectArray(value.workdays, `${path}.workdays`, issues) ?? [];
  const workdays: number[] = [];
  for (const [index, day] of workdaysRaw.entries()) {
    if (typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6) {
      issues.push(
        issue(
          "sla.invalid_workday",
          `${path}.workdays[${index}]`,
          "Workdays must be integers from 0 through 6.",
          "Use JS weekday numbers 0-6.",
        ),
      );
    } else {
      workdays.push(day);
    }
  }
  uniqueStrings(
    workdays.map((item) => String(item)),
    `${path}.workdays`,
    issues,
    "sla.duplicate_workday",
  );
  const workdayStartMinute = expectNumber(
    value.workdayStartMinute,
    `${path}.workdayStartMinute`,
    issues,
  );
  const workdayEndMinute = expectNumber(value.workdayEndMinute, `${path}.workdayEndMinute`, issues);
  if (
    workdayStartMinute !== null &&
    workdayEndMinute !== null &&
    workdayStartMinute >= workdayEndMinute
  ) {
    issues.push(
      issue(
        "sla.invalid_workday_range",
        path,
        "workdayStartMinute must be before workdayEndMinute.",
        "Correct the working-hours range.",
      ),
    );
  }
  const holidaysRaw = expectArray(value.holidays, `${path}.holidays`, issues) ?? [];
  const holidays: string[] = [];
  for (const [index, day] of holidaysRaw.entries()) {
    if (typeof day !== "string" || !DATE_ONLY.test(day)) {
      issues.push(
        issue(
          "sla.invalid_holiday",
          `${path}.holidays[${index}]`,
          "Holiday dates must be YYYY-MM-DD strings.",
          "Use ISO date-only strings.",
        ),
      );
    } else {
      holidays.push(day);
    }
  }
  const targetMinutes = expectNumber(value.targetMinutes, `${path}.targetMinutes`, issues);
  if (targetMinutes !== null && targetMinutes <= 0) {
    issues.push(
      issue(
        "sla.invalid_target",
        `${path}.targetMinutes`,
        "SLA target must be a positive number.",
        "Use a positive minute target.",
      ),
    );
  }
  const warningThresholdMinutes = expectNumber(
    value.warningThresholdMinutes,
    `${path}.warningThresholdMinutes`,
    issues,
  );
  const breachThresholdMinutes = expectNumber(
    value.breachThresholdMinutes,
    `${path}.breachThresholdMinutes`,
    issues,
  );
  if (
    warningThresholdMinutes !== null &&
    breachThresholdMinutes !== null &&
    warningThresholdMinutes > breachThresholdMinutes
  ) {
    issues.push(
      issue(
        "sla.contradictory_thresholds",
        path,
        "Warning threshold cannot exceed the breach threshold.",
        "Lower the warning threshold or raise the breach threshold.",
      ),
    );
  }
  const pauseReasons = expectArray(value.pauseReasons, `${path}.pauseReasons`, issues) ?? [];
  const attributionCategories =
    expectArray(value.attributionCategories, `${path}.attributionCategories`, issues) ?? [];
  const escalationOwnerRole = expectString(
    value.escalationOwnerRole,
    `${path}.escalationOwnerRole`,
    issues,
  );
  const configured = expectBoolean(value.configured, `${path}.configured`, issues);
  if (
    issues.some((item) => item.blocking) ||
    !policyKey ||
    policyVersion === null ||
    synthetic === null ||
    !calendarMode ||
    !timeZone ||
    targetMinutes === null ||
    warningThresholdMinutes === null ||
    breachThresholdMinutes === null ||
    workdayStartMinute === null ||
    workdayEndMinute === null ||
    !escalationOwnerRole ||
    configured === null
  ) {
    return { value: null, issues };
  }
  return {
    value: {
      policyKey,
      policyVersion,
      synthetic,
      disclosure: disclosure ?? CONFIGURATION_SYNTHETIC_DISCLOSURE,
      calendarMode: calendarMode as SlaPolicyDefinition["calendarMode"],
      timeZone,
      workdays,
      workdayStartMinute,
      workdayEndMinute,
      holidays,
      targetMinutes,
      warningThresholdMinutes,
      breachThresholdMinutes,
      pauseReasons: pauseReasons.map((item) => String(item)),
      attributionCategories: attributionCategories.map((item) => String(item)),
      escalationOwnerRole,
      configured,
    },
    issues,
  };
}

export function parseWorkflowBlueprint(
  value: unknown,
  path = "workflow_blueprint",
): ArtifactParseResult<WorkflowBlueprintParameters> {
  const issues: ConfigurationValidationIssue[] = [];
  if (!isPlainObject(value)) {
    return {
      value: null,
      issues: [
        issue(
          "artifact.invalid_type",
          path,
          "Workflow blueprint must be an object.",
          "Supply a workflow-blueprint object.",
        ),
      ],
    };
  }
  rejectUnknownKeys(value, WORKFLOW_KEYS, path, issues);
  if ("actions" in value) {
    issues.push(
      issue(
        "workflow.unsupported_actions",
        `${path}.actions`,
        "Arbitrary executable action definitions are not permitted.",
        "Remove actions. Live connector actions are not implemented.",
      ),
    );
  }
  const policyKey = expectString(value.policyKey, `${path}.policyKey`, issues);
  const policyVersion = expectPositiveInteger(value.policyVersion, `${path}.policyVersion`, issues);
  const synthetic = expectBoolean(value.synthetic, `${path}.synthetic`, issues);
  const humanGate = expectBoolean(value.humanGate, `${path}.humanGate`, issues);
  if (humanGate === false) {
    issues.push(
      issue(
        "workflow.human_gate_required",
        `${path}.humanGate`,
        "A human gate is required.",
        "Set humanGate to true.",
      ),
    );
  }
  const autoResume = expectBoolean(value.autoResume, `${path}.autoResume`, issues);
  const maxAttempts = expectPositiveInteger(value.maxAttempts, `${path}.maxAttempts`, issues);
  const finalApprovalRequired = expectBoolean(
    value.finalApprovalRequired,
    `${path}.finalApprovalRequired`,
    issues,
  );
  if (finalApprovalRequired === false) {
    issues.push(
      issue(
        "workflow.final_approval_required",
        `${path}.finalApprovalRequired`,
        "Final approval remains required.",
        "Set finalApprovalRequired to true.",
      ),
    );
  }
  if (
    issues.some((item) => item.blocking) ||
    !policyKey ||
    policyVersion === null ||
    synthetic === null ||
    humanGate === null ||
    autoResume === null ||
    maxAttempts === null ||
    finalApprovalRequired === null
  ) {
    return { value: null, issues };
  }
  return {
    value: {
      policyKey,
      policyVersion,
      synthetic,
      humanGate: true,
      autoResume,
      maxAttempts,
      finalApprovalRequired: true,
    },
    issues,
  };
}

export function parseConfigurationArtifact(
  kind: ConfigurationArtifactKind,
  payload: unknown,
): ArtifactParseResult<JsonObject> {
  const parsed =
    kind === "inspection_schema"
      ? parseInspectionSchema(payload)
      : kind === "mapping_profile"
        ? parseMappingProfile(payload)
        : kind === "validation_rule_set"
          ? parseValidationRuleSet(payload)
          : kind === "report_template"
            ? parseReportTemplate(payload)
            : kind === "review_policy"
              ? parseReviewPolicy(payload)
              : kind === "storage_policy"
                ? parseStoragePolicy(payload)
                : kind === "delivery_policy"
                  ? parseDeliveryPolicy(payload)
                  : kind === "sla_policy"
                    ? parseSlaPolicy(payload)
                    : parseWorkflowBlueprint(payload);
  if (!parsed.value) {
    return { value: null, issues: parsed.issues };
  }
  return { value: parsed.value as unknown as JsonObject, issues: parsed.issues };
}

export function assertArtifactSafeToSave(
  kind: ConfigurationArtifactKind,
  payload: unknown,
): JsonObject {
  const parsed = parseConfigurationArtifact(kind, payload);
  const blocking = parsed.issues.filter((item) => item.blocking);
  if (!parsed.value || blocking.length > 0) {
    throw new ConfigurationValidationError(
      blocking[0]?.message ?? `Configuration artifact ${kind} is not structurally safe.`,
      parsed.issues,
    );
  }
  return parsed.value;
}

export function parseBoundArtifacts(
  artifacts: Readonly<Record<ConfigurationArtifactKind, unknown>>,
): {
  readonly schema: InspectionSchemaDefinition | null;
  readonly mapping: SourceMappingProfile | null;
  readonly validation: ValidationRuleSet | null;
  readonly template: ReportTemplateDefinition | null;
  readonly review: ReviewPolicyDefinition | null;
  readonly storage: StoragePolicyDefinition | null;
  readonly delivery: DeliveryPolicyDefinition | null;
  readonly sla: SlaPolicyDefinition | null;
  readonly workflow: WorkflowBlueprintParameters | null;
  readonly issues: readonly ConfigurationValidationIssue[];
} {
  const schema = parseInspectionSchema(artifacts.inspection_schema);
  const mapping = parseMappingProfile(artifacts.mapping_profile);
  const validation = parseValidationRuleSet(artifacts.validation_rule_set);
  const template = parseReportTemplate(artifacts.report_template);
  const review = parseReviewPolicy(artifacts.review_policy);
  const storage = parseStoragePolicy(artifacts.storage_policy);
  const delivery = parseDeliveryPolicy(artifacts.delivery_policy);
  const sla = parseSlaPolicy(artifacts.sla_policy);
  const workflow = parseWorkflowBlueprint(artifacts.workflow_blueprint);
  return {
    schema: schema.value,
    mapping: mapping.value,
    validation: validation.value,
    template: template.value,
    review: review.value,
    storage: storage.value,
    delivery: delivery.value,
    sla: sla.value,
    workflow: workflow.value,
    issues: [
      ...schema.issues,
      ...mapping.issues,
      ...validation.issues,
      ...template.issues,
      ...review.issues,
      ...storage.issues,
      ...delivery.issues,
      ...sla.issues,
      ...workflow.issues,
    ],
  };
}

export function collectSyntheticConsistencyIssues(
  pack: BoundConfigurationPackage,
): readonly ConfigurationValidationIssue[] {
  const issues: ConfigurationValidationIssue[] = [];
  const artifacts: ReadonlyArray<readonly [string, boolean]> = [
    ["schema", pack.schema.synthetic],
    ["mapping", pack.mapping.synthetic],
    ["validation", pack.validation.synthetic],
    ["template", pack.template.synthetic],
    ["review", pack.review.synthetic],
    ["storage", pack.storage.synthetic],
    ["delivery", pack.delivery.synthetic],
    ["sla", pack.sla.synthetic],
    ["workflow", pack.workflow.synthetic],
  ];
  for (const [name, synthetic] of artifacts) {
    if (synthetic !== pack.release.synthetic) {
      issues.push(
        issue(
          "release.synthetic_inconsistency",
          `${name}.synthetic`,
          pack.release.synthetic
            ? `Non-synthetic ${name} artifact is inconsistent with a synthetic release.`
            : `Synthetic ${name} artifact cannot execute inside a non-synthetic release.`,
          "Keep release.synthetic aligned with every execution artifact. Phase 3.1A does not authorize a production-mapping readiness transition.",
        ),
      );
    }
  }
  return issues;
}
