import type { JsonObject, JsonValue } from "./entities.js";
import type { EvidenceKind, FindingSeverity } from "./operations.js";
import { FINDING_SEVERITIES, EVIDENCE_KINDS, presentText } from "./operations.js";
import {
  BEA_PRODUCTION_POLICY_UNCONFIGURED,
  CONFIGURATION_ARTIFACT_KINDS,
  CONFIGURATION_SYNTHETIC_DISCLOSURE,
  ConfigurationValidationError,
  MAPPING_TRANSFORM_KINDS,
  isPlaceholderOperationalReference,
  ProductionMappingNotConfiguredError,
  UnsafeTransformationError,
  type BoundConfigurationPackage,
  type CanonicalFieldDefinition,
  type CanonicalInspectionRecord,
  type CollectionItemBinding,
  type ConfigurationValidationIssue,
  type ControlledValidationItem,
  type ControlledValidationResult,
  type FieldCondition,
  type InspectionSchemaDefinition,
  type MappingEngineReport,
  type MappingIssue,
  type MappingTransform,
  type ReportDocument,
  type ReportDocumentNode,
  type ReportTemplateDefinition,
  type ReviewPolicyDefinition,
  type SlaDuePreview,
  type SlaPolicyDefinition,
  type SourceCollectionMapping,
  type SourceLineage,
  type SourceMappingProfile,
  type StorageDeliveryDryRunManifest,
  type ValidationExpression,
  type ValidationRuleSet,
} from "./configuration.js";
import { collectSyntheticConsistencyIssues, parseBoundArtifacts } from "./configuration-runtime.js";

const UNSAFE_PATH = /(?:__proto__|constructor|prototype|\[\s*["'`])/iu;
const SAFE_PATH_TOKEN = /^(?:[A-Za-z_][A-Za-z0-9_]*|\[\d+\]|\[\*\]|\.)$/u;

export function assertSafeJsonPath(path: string): void {
  const trimmed = path.trim();
  if (trimmed === ".") return;
  if (!trimmed) {
    throw new UnsafeTransformationError("A source path is required.");
  }
  if (UNSAFE_PATH.test(trimmed) || trimmed.includes("..") || trimmed.includes("(")) {
    throw new UnsafeTransformationError(`Rejected unsafe source path: ${path}`);
  }
  const tokens = trimmed
    .split(/(\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\]|\[\*\]|[A-Za-z_][A-Za-z0-9_]*)/u)
    .filter(Boolean);
  if (tokens.some((token) => !SAFE_PATH_TOKEN.test(token) && token !== ".")) {
    const rebuilt = tokens.join("");
    if (
      rebuilt !== trimmed &&
      !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\]|\[\*\])*$/u.test(trimmed)
    ) {
      throw new UnsafeTransformationError(`Rejected unsafe source path: ${path}`);
    }
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\]|\[\*\])*$/u.test(trimmed)) {
    throw new UnsafeTransformationError(`Rejected unsafe source path: ${path}`);
  }
}

export function collectJsonPaths(value: unknown, prefix = ""): string[] {
  if (value === null || value === undefined) {
    return prefix ? [prefix] : [];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return prefix ? [prefix] : [];
    return value.flatMap((item, index) =>
      collectJsonPaths(item, prefix ? `${prefix}[${index}]` : `[${index}]`),
    );
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      collectJsonPaths(child, prefix ? `${prefix}.${key}` : key),
    );
  }
  return prefix ? [prefix] : [];
}

export function readJsonPath(source: unknown, path: string): JsonValue {
  assertSafeJsonPath(path);
  const parts = path.match(/[A-Za-z_][A-Za-z0-9_]*|\[\d+\]|\[\*\]/gu) ?? [];
  let current: unknown = source;
  for (const part of parts) {
    if (current === null || current === undefined) return null;
    if (part === "[*]") {
      if (!Array.isArray(current)) return null;
      return current as JsonValue;
    }
    if (part.startsWith("[") && part.endsWith("]")) {
      if (!Array.isArray(current)) return null;
      current = current[Number(part.slice(1, -1))];
      continue;
    }
    if (typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[part];
  }
  return (current ?? null) as JsonValue;
}

function asString(value: JsonValue | undefined | null): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function applyTransform(value: JsonValue, transform: MappingTransform, source: unknown): JsonValue {
  if (!MAPPING_TRANSFORM_KINDS.includes(transform.kind)) {
    throw new UnsafeTransformationError(`Unsupported transformation: ${String(transform.kind)}`);
  }
  switch (transform.kind) {
    case "trim":
      return asString(value).trim();
    case "collapse_whitespace":
      return asString(value).trim().replace(/\s+/gu, " ");
    case "lowercase":
      return asString(value).toLocaleLowerCase("en-US");
    case "uppercase":
      return asString(value).toLocaleUpperCase("en-US");
    case "parse_date": {
      const text = asString(value).trim();
      if (!text) return null;
      const parsed = Date.parse(text);
      if (Number.isNaN(parsed)) return null;
      return new Date(parsed).toISOString().slice(0, 10);
    }
    case "parse_timestamp": {
      const text = asString(value).trim();
      if (!text) return null;
      const parsed = Date.parse(text);
      return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
    }
    case "parse_integer": {
      const text = asString(value).trim();
      if (!text) return null;
      const parsed = Number.parseInt(text, 10);
      return Number.isFinite(parsed) ? parsed : null;
    }
    case "parse_decimal": {
      const text = asString(value).trim();
      if (!text) return null;
      const parsed = Number.parseFloat(text);
      return Number.isFinite(parsed) ? parsed : null;
    }
    case "boolean_map": {
      const text = asString(value).trim().toLocaleLowerCase("en-US");
      if (
        (transform.trueValues ?? ["true", "yes", "1"])
          .map((item) => item.toLocaleLowerCase("en-US"))
          .includes(text)
      ) {
        return true;
      }
      if (
        (transform.falseValues ?? ["false", "no", "0"])
          .map((item) => item.toLocaleLowerCase("en-US"))
          .includes(text)
      ) {
        return false;
      }
      return null;
    }
    case "enum_map": {
      const text = asString(value).trim();
      return transform.map?.[text] ?? text;
    }
    case "unit_conversion": {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return null;
      return parsed * (transform.factor ?? 1);
    }
    case "concat": {
      const parts = (transform.sources ?? []).map((path) => asString(readJsonPath(source, path)));
      return parts.filter(Boolean).join(transform.separator ?? " ");
    }
    case "flatten_array":
      return Array.isArray(value)
        ? value.map((item) => asString(item as JsonValue)).join(", ")
        : value;
    case "replace_exact":
      return asString(value) === (transform.from ?? "") ? (transform.to ?? "") : value;
    case "compose_address": {
      const street = asString(readJsonPath(source, transform.streetPath ?? "street"));
      const city = asString(readJsonPath(source, transform.cityPath ?? "city"));
      const region = asString(readJsonPath(source, transform.regionPath ?? "region"));
      const postal = asString(readJsonPath(source, transform.postalPath ?? "postal"));
      return [street, city, region, postal].filter(Boolean).join(", ");
    }
    default:
      throw new UnsafeTransformationError(`Unsupported transformation: ${transform.kind}`);
  }
}

export function parseCsv(text: string): readonly JsonObject[] {
  const rows: string[][] = [];
  let current: string[] = [];
  let cell = "";
  let inQuotes = false;
  const source = text.replace(/^\uFEFF/u, "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ",") {
      current.push(cell);
      cell = "";
      continue;
    }
    if (char === "\n") {
      current.push(cell);
      rows.push(current);
      current = [];
      cell = "";
      continue;
    }
    if (char !== "\r") cell += char;
  }
  current.push(cell);
  if (current.some((item) => item.length > 0) || rows.length === 0) rows.push(current);
  const header = (rows[0] ?? []).map((item) => item.trim());
  return rows
    .slice(1)
    .filter((row) => row.some((item) => item.trim()))
    .map((row) => {
      const record: JsonObject = {};
      header.forEach((key, index) => {
        if (key) record[key] = row[index] ?? "";
      });
      return record;
    });
}

export function parseStagingSource(
  sourceType: string,
  raw: string,
  options: { readonly csvRowMode?: "single_record" | "record_collection" } = {},
): {
  readonly source: JsonObject;
  readonly rows: readonly JsonObject[];
  readonly quarantined: boolean;
  readonly warnings: readonly string[];
  readonly rowCount: number;
} {
  const warnings: string[] = [];
  const lowered = sourceType.trim().toLocaleLowerCase("en-US");
  if (lowered !== "json" && lowered !== "csv") {
    return {
      source: { unsupported: true, sourceType },
      rows: [],
      quarantined: true,
      rowCount: 0,
      warnings: [
        `Unsupported format '${sourceType}' was quarantined. OCR, PDF, DOCX, and macros are not parsed.`,
      ],
    };
  }
  if (/<\s*script/iu.test(raw) || /javascript:/iu.test(raw)) {
    warnings.push("Embedded script content was not executed and will not be rendered.");
  }
  if (lowered === "json") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {
          source: { invalid: true },
          rows: [],
          quarantined: true,
          rowCount: 0,
          warnings: ["JSON source must be a single object."],
        };
      }
      const source = parsed as JsonObject;
      return { source, rows: [source], quarantined: false, warnings, rowCount: 1 };
    } catch {
      return {
        source: { invalid: true },
        rows: [],
        quarantined: true,
        rowCount: 0,
        warnings: ["JSON could not be parsed. The source was quarantined."],
      };
    }
  }
  const rows = parseCsv(raw);
  const csvRowMode = options.csvRowMode ?? "single_record";
  if (csvRowMode === "single_record") {
    if (rows.length !== 1) {
      return {
        source: { invalid: true, rowCount: rows.length },
        rows,
        quarantined: true,
        rowCount: rows.length,
        warnings: [
          ...warnings,
          `CSV single_record mode requires exactly one nonempty data row. Received ${rows.length} row(s). No rows were discarded.`,
        ],
      };
    }
    return { source: rows[0] ?? {}, rows, quarantined: false, warnings, rowCount: 1 };
  }
  return {
    source: { rows: [...rows] },
    rows,
    quarantined: false,
    warnings,
    rowCount: rows.length,
  };
}

function asFindingSeverity(value: JsonValue | undefined | null): FindingSeverity {
  const text = asString(value).trim().toLocaleLowerCase("en-US");
  return (FINDING_SEVERITIES as readonly string[]).includes(text)
    ? (text as FindingSeverity)
    : "info";
}

function asEvidenceKind(value: JsonValue | undefined | null): EvidenceKind {
  const text = asString(value).trim().toLocaleLowerCase("en-US");
  return (EVIDENCE_KINDS as readonly string[]).includes(text) ? (text as EvidenceKind) : "photo";
}

function objectFromValue(value: JsonValue | undefined | null): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonObject;
}

function isMissingSourceValue(value: JsonValue | undefined | null): boolean {
  return (
    value === null || value === undefined || (typeof value === "string" && value.trim() === "")
  );
}

function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function recordPathRoot(path: string): string {
  if (path === "." || path === "") return ".";
  return path.split(/[.[]/u)[0] ?? path;
}

function readRelativePath(item: unknown, path: string): JsonValue {
  if (path === "." || path === "") {
    return (item ?? null) as JsonValue;
  }
  return readJsonPath(item, path);
}

function transformValue(
  rawValue: JsonValue,
  transforms: readonly MappingTransform[],
  source: unknown,
): JsonValue {
  let transformed = rawValue;
  for (const transform of transforms) {
    transformed = applyTransform(transformed, transform, source);
  }
  return transformed;
}

function mappingIssue(input: {
  readonly code: string;
  readonly ruleKey: string;
  readonly sourcePath: string;
  readonly canonicalField: string | null;
  readonly message: string;
  readonly remediation: string;
}): MappingIssue {
  return { ...input, blocking: true };
}

function collectionItems(source: JsonObject, mapping: SourceCollectionMapping): unknown[] {
  if (mapping.sourcePath === "." || mapping.sourcePath === "") {
    return mapping.cardinality === "one" ? [source] : [];
  }
  const value = readJsonPath(source, mapping.sourcePath);
  if (mapping.cardinality === "one") {
    const obj = objectFromValue(value);
    return obj ? [obj] : [];
  }
  return Array.isArray(value) ? value : [];
}

function bindItemFields(
  item: unknown,
  bindings: readonly CollectionItemBinding[],
  source: unknown,
  issues: MappingIssue[],
  collectionKey: string,
): Record<string, JsonValue> {
  const row: Record<string, JsonValue> = {};
  for (const binding of bindings) {
    let rawValue: JsonValue;
    try {
      rawValue = readRelativePath(item, binding.sourcePath);
    } catch (error) {
      issues.push(
        mappingIssue({
          code: "mapping.unsafe_item_path",
          ruleKey: collectionKey,
          sourcePath: binding.sourcePath,
          canonicalField: binding.destination,
          message: error instanceof Error ? error.message : "Unsafe item path.",
          remediation: "Use a safe item-relative path.",
        }),
      );
      continue;
    }
    let transformed: JsonValue;
    try {
      transformed = transformValue(rawValue, binding.transforms, source);
    } catch (error) {
      issues.push(
        mappingIssue({
          code: "mapping.item_transform_failed",
          ruleKey: collectionKey,
          sourcePath: binding.sourcePath,
          canonicalField: binding.destination,
          message: error instanceof Error ? error.message : "Transform failed.",
          remediation: "Use a controlled transform.",
        }),
      );
      continue;
    }
    if (isMissingSourceValue(transformed) && binding.defaultValue !== undefined) {
      transformed = binding.defaultValue;
    }
    if (binding.required && isMissingSourceValue(transformed)) {
      issues.push(
        mappingIssue({
          code: "mapping.required_item_missing",
          ruleKey: collectionKey,
          sourcePath: binding.sourcePath,
          canonicalField: binding.destination,
          message: `Required collection item '${binding.destination}' is missing on '${collectionKey}'.`,
          remediation: `Supply ${binding.sourcePath} on each collection item.`,
        }),
      );
      continue;
    }
    row[binding.destination] = transformed;
  }
  return row;
}

function readScalarSourceValue(
  source: JsonObject,
  sourcePath: string,
  profile: SourceMappingProfile,
  issues: MappingIssue[],
  ruleKey: string,
  canonicalField: string,
): JsonValue {
  if (
    profile.sourceType === "csv" &&
    profile.csvRowMode === "record_collection" &&
    Array.isArray(source.rows)
  ) {
    const values = source.rows.map((row) => readJsonPath(row, sourcePath));
    if (profile.csvScalarStrategy !== "all_rows_must_match") {
      issues.push(
        mappingIssue({
          code: "mapping.csv_scalar_strategy",
          ruleKey,
          sourcePath,
          canonicalField,
          message: "CSV record_collection scalar fields require all_rows_must_match.",
          remediation:
            "Declare csvScalarStrategy all_rows_must_match. The first row is not authoritative.",
        }),
      );
      return null;
    }
    const first = values[0] ?? null;
    if (values.some((value) => !jsonEqual(value, first))) {
      issues.push(
        mappingIssue({
          code: "mapping.csv_scalar_mismatch",
          ruleKey,
          sourcePath,
          canonicalField,
          message: `CSV rows disagree on scalar path '${sourcePath}'.`,
          remediation: "Make the scalar value identical on every row or map it as a collection.",
        }),
      );
      return null;
    }
    return first;
  }
  return readJsonPath(source, sourcePath);
}

export function applySourceMapping(
  source: JsonObject,
  profile: SourceMappingProfile,
  schema: InspectionSchemaDefinition,
): MappingEngineReport {
  if (!profile.synthetic) {
    throw new ProductionMappingNotConfiguredError(
      "Phase 3.1A blocks mapping execution when mapping.synthetic is false. Production mapping remains unconfigured.",
    );
  }
  const fields: Record<string, JsonValue> = {};
  const lineage: SourceLineage[] = [];
  const conflicts: string[] = [];
  const rejectedTransforms: string[] = [];
  const blockingIssues: MappingIssue[] = [];
  const mappedDestinations = new Map<string, string>();
  const mappedSourcePaths = new Set<string>();
  const collections = profile.collections ?? [];
  const csvRows = Array.isArray(source.rows) ? source.rows.length : 1;

  for (const rule of profile.rules) {
    try {
      assertSafeJsonPath(rule.sourcePath);
      for (const transform of rule.transforms) {
        if (!MAPPING_TRANSFORM_KINDS.includes(transform.kind)) {
          throw new UnsafeTransformationError(transform.kind);
        }
      }
    } catch (error) {
      rejectedTransforms.push(
        `${rule.ruleKey}: ${error instanceof Error ? error.message : "unsafe transformation"}`,
      );
      continue;
    }
    mappedSourcePaths.add(recordPathRoot(rule.sourcePath));
    const rawValue = readScalarSourceValue(
      source,
      rule.sourcePath,
      profile,
      blockingIssues,
      rule.ruleKey,
      rule.canonicalField,
    );
    let transformed: JsonValue = rawValue;
    try {
      transformed = transformValue(rawValue, rule.transforms, source);
    } catch (error) {
      rejectedTransforms.push(
        `${rule.ruleKey}: ${error instanceof Error ? error.message : "transform failed"}`,
      );
      continue;
    }
    if (isMissingSourceValue(transformed) && rule.nullBehavior === "use_default") {
      transformed = rule.defaultValue ?? null;
    }
    if (rule.requiredSource && isMissingSourceValue(transformed)) {
      blockingIssues.push(
        mappingIssue({
          code: "mapping.required_source_missing",
          ruleKey: rule.ruleKey,
          sourcePath: rule.sourcePath,
          canonicalField: rule.canonicalField,
          message: `Required source '${rule.sourcePath}' is missing, empty, or incompatible for '${rule.canonicalField}'.`,
          remediation: `Supply ${rule.sourcePath} or mark requiredSource false on ${rule.ruleKey}.`,
        }),
      );
      continue;
    }
    const prior = mappedDestinations.get(rule.canonicalField);
    if (prior && prior !== rule.sourcePath) {
      if (rule.conflictBehavior === "reject") {
        conflicts.push(
          `${rule.canonicalField} is mapped from both ${prior} and ${rule.sourcePath}.`,
        );
        continue;
      }
      if (rule.conflictBehavior === "first_wins") continue;
    }
    mappedDestinations.set(rule.canonicalField, rule.sourcePath);
    fields[rule.canonicalField] = transformed;
    lineage.push({
      canonicalField: rule.canonicalField,
      sourcePath: rule.sourcePath,
      rawValue,
      transformedValue: transformed,
      transforms: rule.transforms.map((item) => item.kind),
    });
  }

  const findings: CanonicalInspectionRecord["findings"][number][] = [];
  const evidence: CanonicalInspectionRecord["evidence"][number][] = [];
  const groups: Record<string, JsonObject[]> = {};

  for (const collection of collections) {
    mappedSourcePaths.add(recordPathRoot(collection.sourcePath));
    let rawRoot: JsonValue = null;
    try {
      rawRoot =
        collection.sourcePath === "." || collection.sourcePath === ""
          ? source
          : readJsonPath(source, collection.sourcePath);
    } catch (error) {
      blockingIssues.push(
        mappingIssue({
          code: "mapping.unsafe_collection_path",
          ruleKey: collection.collectionKey,
          sourcePath: collection.sourcePath,
          canonicalField: collection.collectionKind,
          message: error instanceof Error ? error.message : "Unsafe collection path.",
          remediation: "Use the controlled path grammar. Arbitrary expressions are rejected.",
        }),
      );
      continue;
    }
    const missingRoot =
      collection.sourcePath !== "." &&
      collection.sourcePath !== "" &&
      (rawRoot === null || rawRoot === undefined);
    const items = collectionItems(source, collection);
    const structurallyIncompatible =
      !missingRoot &&
      collection.cardinality === "many" &&
      rawRoot !== null &&
      !Array.isArray(rawRoot);
    if (structurallyIncompatible) {
      blockingIssues.push(
        mappingIssue({
          code: "mapping.required_collection_incompatible",
          ruleKey: collection.collectionKey,
          sourcePath: collection.sourcePath,
          canonicalField: collection.collectionKind,
          message: `Collection '${collection.collectionKey}' at '${collection.sourcePath}' is not an array.`,
          remediation: "Point sourcePath at an array, or use cardinality one for a single object.",
        }),
      );
      continue;
    }
    if (collection.requiredSource && (missingRoot || items.length === 0)) {
      blockingIssues.push(
        mappingIssue({
          code: "mapping.required_collection_missing",
          ruleKey: collection.collectionKey,
          sourcePath: collection.sourcePath,
          canonicalField: collection.collectionKind,
          message: `Required collection '${collection.collectionKey}' at '${collection.sourcePath}' is missing or empty.`,
          remediation: `Supply ${collection.sourcePath} or set requiredSource to false.`,
        }),
      );
      continue;
    }
    if (items.length === 0 && collection.emptyBehavior === "block") {
      blockingIssues.push(
        mappingIssue({
          code: "mapping.collection_empty",
          ruleKey: collection.collectionKey,
          sourcePath: collection.sourcePath,
          canonicalField: collection.collectionKind,
          message: `Collection '${collection.collectionKey}' is empty.`,
          remediation: "Supply items or set emptyBehavior to allow.",
        }),
      );
      continue;
    }
    for (const [index, item] of items.entries()) {
      const row = bindItemFields(
        item,
        collection.itemBindings,
        source,
        blockingIssues,
        collection.collectionKey,
      );
      if (collection.collectionKind === "findings") {
        findings.push({
          code: asString(row.code) || `F-${index + 1}`,
          sectionKey: asString(row.sectionKey) || "findings",
          title: asString(row.title) || `Finding ${index + 1}`,
          description: asString(row.description),
          severity: asFindingSeverity(row.severity ?? null),
          location: asString(row.location) || null,
        });
      } else if (collection.collectionKind === "evidence") {
        let findingCode = asString(row.findingCode) || null;
        for (const relationship of collection.relationshipBindings ?? []) {
          const related = readRelativePath(item, relationship.sourcePath);
          const relatedText = asString(related);
          if (relationship.required && !relatedText) {
            blockingIssues.push(
              mappingIssue({
                code: "mapping.required_relationship_missing",
                ruleKey: collection.collectionKey,
                sourcePath: relationship.sourcePath,
                canonicalField: relationship.relationshipKey,
                message: `Required evidence relationship '${relationship.relationshipKey}' is missing.`,
                remediation: `Supply ${relationship.sourcePath} so evidence can keep its finding relationship.`,
              }),
            );
          }
          if (relationship.relationshipKey === "findingCode" && relatedText) {
            findingCode = relatedText;
          }
        }
        evidence.push({
          findingCode,
          kind: asEvidenceKind(row.kind ?? "photo"),
          filename: asString(row.filename) || `evidence-${index + 1}`,
          contentType: asString(row.contentType) || "image/jpeg",
          sha256: asString(row.sha256),
          byteLength: typeof row.byteLength === "number" ? row.byteLength : 0,
          storageRef: asString(row.storageRef) || `synthetic://${asString(row.filename)}`,
          caption: asString(row.caption) || null,
        });
      } else if (collection.collectionKind === "signature") {
        evidence.push({
          findingCode: null,
          kind: "signature",
          filename: asString(row.filename) || "signature.sig",
          contentType: asString(row.contentType) || "application/octet-stream",
          sha256: asString(row.sha256),
          byteLength: typeof row.byteLength === "number" ? row.byteLength : 0,
          storageRef: asString(row.storageRef) || "synthetic://signature",
          caption: null,
        });
      } else {
        const groupKey = collection.destinationGroupKey ?? collection.collectionKey;
        groups[groupKey] = [...(groups[groupKey] ?? []), row];
      }
    }
  }

  const sourcePaths = collectJsonPaths(source);
  const unmappedSourceFields = sourcePaths.filter((path) => {
    const root = recordPathRoot(path);
    return !mappedSourcePaths.has(root) && root !== ".";
  });
  const mappedFields = new Set(Object.keys(fields));
  const requiredSourceFields = new Set(
    blockingIssues
      .filter((item) => item.canonicalField)
      .map((item) => item.canonicalField as string),
  );
  const canonicalFieldsWithoutSource = schema.fields
    .filter(
      (field) =>
        field.required &&
        !mappedFields.has(field.key) &&
        !requiredSourceFields.has(field.key) &&
        field.dataType !== "finding_collection" &&
        field.dataType !== "evidence_collection" &&
        field.dataType !== "signature_reference",
    )
    .map((field) => field.key);

  const canonical: CanonicalInspectionRecord = {
    fields,
    findings,
    evidence,
    groups,
    lineage,
  };
  const humanReadable = [
    `Mapped ${lineage.length} field${lineage.length === 1 ? "" : "s"} using ${profile.profileKey}@${profile.profileVersion}.`,
    unmappedSourceFields.length
      ? `Unmapped source fields: ${unmappedSourceFields.slice(0, 12).join(", ")}.`
      : "No unmapped source fields.",
    canonicalFieldsWithoutSource.length
      ? `Canonical fields without a source: ${canonicalFieldsWithoutSource.join(", ")}.`
      : "Every required canonical field has a source mapping.",
    conflicts.length ? `Conflicts: ${conflicts.join(" ")}` : "No mapping conflicts.",
    blockingIssues.length
      ? `Blocking mapping issues: ${blockingIssues.map((item) => item.ruleKey).join(", ")}.`
      : "No blocking mapping issues.",
  ];
  return {
    canonical,
    unmappedSourceFields,
    canonicalFieldsWithoutSource,
    conflicts,
    rejectedTransforms,
    blockingIssues,
    rowCount: csvRows,
    humanReadable,
  };
}

export function detectSchemaBreakingChanges(
  previous: InspectionSchemaDefinition,
  next: InspectionSchemaDefinition,
): readonly ConfigurationValidationIssue[] {
  const issues: ConfigurationValidationIssue[] = [];
  const previousByKey = new Map(previous.fields.map((field) => [field.key, field]));
  for (const field of previous.fields) {
    const current = next.fields.find((item) => item.key === field.key);
    if (!current) {
      issues.push({
        code: "schema.field_removed",
        severity: field.required ? "blocking" : "warning",
        blocking: field.required,
        path: field.key,
        message: `Canonical field ${field.key} was removed.`,
        remediation: "Keep the stable key or introduce an explicit alias before publishing.",
      });
      continue;
    }
    if (current.dataType !== field.dataType) {
      issues.push({
        code: "schema.type_changed",
        severity: "blocking",
        blocking: true,
        path: field.key,
        message: `Field ${field.key} changed type from ${field.dataType} to ${current.dataType}.`,
        remediation: "Type changes are breaking. Add a new field key instead.",
      });
    }
    const previousValues = new Set(field.allowedValues ?? []);
    for (const value of previousValues) {
      if (current.allowedValues && !current.allowedValues.includes(value)) {
        issues.push({
          code: "schema.enum_value_removed",
          severity: "blocking",
          blocking: true,
          path: field.key,
          message: `Allowed value '${value}' was removed from ${field.key}.`,
          remediation: "Keep historical enum values or create a new field.",
        });
      }
    }
  }
  for (const field of next.fields) {
    if (!previousByKey.has(field.key)) {
      issues.push({
        code: "schema.field_added",
        severity: "advisory",
        blocking: false,
        path: field.key,
        message: `New canonical field ${field.key} was added.`,
        remediation: "Map a source for the new field before activating production.",
      });
    }
  }
  return issues;
}

function conditionHolds(condition: FieldCondition, record: CanonicalInspectionRecord): boolean {
  if (condition.kind === "always") return true;
  const value = condition.field ? record.fields[condition.field] : null;
  if (condition.kind === "field_present")
    return value !== null && value !== undefined && value !== "";
  if (condition.kind === "field_truthy") return Boolean(value);
  return value === condition.value;
}

function fieldNumber(record: CanonicalInspectionRecord, field: string): number | null {
  const value = record.fields[field];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function fieldText(record: CanonicalInspectionRecord, field: string): string {
  return asString(record.fields[field] ?? null);
}

export function evaluateValidationRules(
  record: CanonicalInspectionRecord,
  ruleSet: ValidationRuleSet,
  options: { readonly reviewerRole?: string } = {},
): ControlledValidationResult {
  const blocking: ControlledValidationItem[] = [];
  const warnings: ControlledValidationItem[] = [];
  const advisories: ControlledValidationItem[] = [];

  const push = (rule: ValidationRuleSet["rules"][number], path: string, message: string) => {
    const item: ControlledValidationItem = {
      ruleKey: rule.ruleKey,
      severity: rule.severity,
      blocking: rule.blocking && rule.severity === "blocking",
      path,
      message,
      remediation: rule.remediation,
    };
    if (item.blocking) blocking.push(item);
    else if (rule.severity === "warning") warnings.push(item);
    else advisories.push(item);
  };

  for (const rule of ruleSet.rules) {
    if (!conditionHolds(rule.trigger, record)) continue;
    const expression = rule.expression;
    switch (expression.kind) {
      case "required":
        if (!presentText(fieldText(record, expression.field))) {
          push(rule, expression.field, rule.description);
        }
        break;
      case "required_if":
        if (
          conditionHolds(expression.condition, record) &&
          !presentText(fieldText(record, expression.field))
        ) {
          push(rule, expression.field, rule.description);
        }
        break;
      case "min_number": {
        const value = fieldNumber(record, expression.field);
        if (value === null || value < expression.minimum)
          push(rule, expression.field, rule.description);
        break;
      }
      case "max_number": {
        const value = fieldNumber(record, expression.field);
        if (value === null || value > expression.maximum)
          push(rule, expression.field, rule.description);
        break;
      }
      case "min_length":
        if (fieldText(record, expression.field).trim().length < expression.minimum) {
          push(rule, expression.field, rule.description);
        }
        break;
      case "max_length":
        if (fieldText(record, expression.field).trim().length > expression.maximum) {
          push(rule, expression.field, rule.description);
        }
        break;
      case "allowed_enum":
        if (!expression.values.includes(fieldText(record, expression.field))) {
          push(rule, expression.field, rule.description);
        }
        break;
      case "date_ordering":
      case "timestamp_ordering": {
        const earlier = Date.parse(fieldText(record, expression.earlierField));
        const later = Date.parse(fieldText(record, expression.laterField));
        if (!Number.isNaN(earlier) && !Number.isNaN(later) && earlier > later) {
          push(rule, expression.laterField, rule.description);
        }
        break;
      }
      case "cross_field_compare": {
        const left = fieldNumber(record, expression.leftField);
        const right = fieldNumber(record, expression.rightField);
        if (left === null || right === null) break;
        const ok =
          expression.operator === "eq"
            ? left === right
            : expression.operator === "neq"
              ? left !== right
              : expression.operator === "gt"
                ? left > right
                : expression.operator === "gte"
                  ? left >= right
                  : expression.operator === "lt"
                    ? left < right
                    : left <= right;
        if (!ok) push(rule, expression.leftField, rule.description);
        break;
      }
      case "min_evidence_count":
        if (record.evidence.length < expression.minimum) push(rule, "evidence", rule.description);
        break;
      case "min_photo_count":
        if (record.evidence.filter((item) => item.kind === "photo").length < expression.minimum) {
          push(rule, "evidence", rule.description);
        }
        break;
      case "required_caption":
        if (record.evidence.some((item) => item.kind === "photo" && !presentText(item.caption))) {
          push(rule, "evidence.caption", rule.description);
        }
        break;
      case "required_finding_relationship":
        if (record.evidence.some((item) => item.kind === "photo" && !item.findingCode)) {
          push(rule, "evidence.findingCode", rule.description);
        }
        break;
      case "required_signature":
        if (
          !record.evidence.some(
            (item) => item.kind === "signature" && /^[a-f0-9]{64}$/iu.test(item.sha256),
          )
        ) {
          push(rule, "evidence.signature", rule.description);
        }
        break;
      case "required_reviewer_role":
        if (!options.reviewerRole || options.reviewerRole !== expression.role) {
          push(rule, "reviewer", rule.description);
        }
        break;
      case "unique_in_group": {
        const group = record.groups[expression.groupKey] ?? [];
        const seen = new Set<string>();
        for (const row of group) {
          const value = asString(row[expression.field] ?? null);
          if (!value) continue;
          if (seen.has(value)) {
            push(rule, `${expression.groupKey}.${expression.field}`, rule.description);
            break;
          }
          seen.add(value);
        }
        break;
      }
      case "advisory":
        if (!presentText(fieldText(record, expression.field))) {
          push(rule, expression.field, expression.message);
        }
        break;
      default: {
        const unknownKind = String((expression as { kind?: unknown }).kind ?? "unknown");
        throw new ConfigurationValidationError(
          `Validation rule '${rule.ruleKey}' uses unknown expression kind '${unknownKind}'.`,
          [
            {
              code: "validation.unknown_expression_kind",
              severity: "blocking",
              blocking: true,
              path: `validation.rules.${rule.ruleKey}.expression.kind`,
              message: `Unknown validation-expression kind '${unknownKind}' cannot execute.`,
              remediation: `Replace rule '${rule.ruleKey}' with a supported expression kind. Unknown kinds cannot validate, publish, or execute.`,
            },
          ],
        );
      }
    }
  }

  return {
    passed: blocking.length === 0,
    blocking,
    warnings,
    advisories,
    ruleSetKey: ruleSet.ruleSetKey,
    ruleSetVersion: ruleSet.ruleSetVersion,
  };
}

function interpolate(pattern: string, values: Readonly<Record<string, string>>): string {
  return pattern.replace(/\{([a-z0-9_]+)\}/giu, (_match, key: string) => values[key] ?? "");
}

function missingText(
  template: ReportTemplateDefinition,
  field: CanonicalFieldDefinition | undefined,
): string {
  if (template.missingValueBehavior === "omit") return "";
  if (template.missingValueBehavior === "show_not_recorded") return "Not recorded";
  return field?.correctionGuidance || "Value not supplied";
}

export function buildReportDocument(input: {
  readonly template: ReportTemplateDefinition;
  readonly record: CanonicalInspectionRecord;
  readonly schema: InspectionSchemaDefinition;
  readonly mapping: SourceMappingProfile;
  readonly ruleSet: ValidationRuleSet;
  readonly configurationReleaseId: string | null;
  readonly configurationReleaseVersion: number | null;
  readonly inspectionReference: string;
  readonly reportReference: string;
  readonly projectReference: string;
  readonly preview?: boolean;
}): ReportDocument {
  const preview = input.preview === true;
  if (
    !preview &&
    [input.reportReference, input.inspectionReference, input.projectReference].some((value) =>
      isPlaceholderOperationalReference(value),
    )
  ) {
    throw new ConfigurationValidationError(
      "Committed report documents cannot use pending, preview, or placeholder operational references.",
      [
        {
          code: "report.placeholder_reference",
          severity: "blocking",
          blocking: true,
          path: "reportReference",
          message:
            "A committed report must use the official BEA-RP, BEA-IN, and BEA-PR references.",
          remediation:
            "Pass the assigned report, inspection, and project references. Preview artifacts may use labeled preview references.",
        },
      ],
    );
  }
  const fieldByKey = new Map(input.schema.fields.map((field) => [field.key, field]));
  const nodes: ReportDocumentNode[] = [];
  const filename = interpolate(input.template.filenamePattern, {
    inspectionRef: input.inspectionReference,
    reportRef: input.reportReference,
    projectRef: input.projectReference,
  });

  for (const section of [...input.template.sections].sort(
    (left, right) => left.displayOrder - right.displayOrder,
  )) {
    if (section.visibleIf && !conditionHolds(section.visibleIf, input.record)) continue;
    for (const node of section.nodes) {
      if (node.visibleIf && !conditionHolds(node.visibleIf, input.record)) continue;
      if (node.kind === "page_break") {
        nodes.push({ kind: "page_break", key: node.key, text: "" });
        continue;
      }
      if (node.kind === "cover" || node.kind === "title" || node.kind === "heading") {
        nodes.push({
          kind: node.kind,
          key: node.key,
          title: node.title ?? section.title,
          text: node.text ?? section.title,
        });
        continue;
      }
      if (
        node.kind === "paragraph" ||
        node.kind === "static_disclaimer" ||
        node.kind === "caption"
      ) {
        nodes.push({
          kind: node.kind,
          key: node.key,
          text: node.text ?? input.template.disclosure,
        });
        continue;
      }
      if (node.kind === "bound_field" || node.kind === "label_value") {
        const fieldKey = node.fieldKey ?? node.key;
        const value = asString(input.record.fields[fieldKey] ?? null);
        const field = fieldByKey.get(fieldKey);
        nodes.push({
          kind: node.kind,
          key: node.key,
          title: node.title ?? field?.label ?? fieldKey,
          text: presentText(value) ? value : missingText(input.template, field),
        });
        continue;
      }
      if (node.kind === "finding_block") {
        const rows = input.record.findings.map((finding) => [
          finding.code,
          finding.title,
          finding.severity,
          finding.description,
        ]);
        nodes.push({
          kind: "finding_block",
          key: node.key,
          title: node.title ?? "Findings",
          text: rows.length ? `${rows.length} finding(s)` : missingText(input.template, undefined),
          rows,
        });
        continue;
      }
      if (node.kind === "photo_grid" || node.kind === "evidence_block") {
        const photos = input.record.evidence.filter((item) => item.kind === "photo");
        nodes.push({
          kind: node.kind,
          key: node.key,
          title: node.title ?? (node.kind === "photo_grid" ? "Photo grid" : "Evidence"),
          text: photos.length ? `${photos.length} photo(s)` : "No photos supplied",
          rows: photos.map((item) => [item.filename, item.caption ?? "", item.findingCode ?? ""]),
        });
        continue;
      }
      if (node.kind === "signature_block") {
        const signature = input.record.evidence.find((item) => item.kind === "signature");
        nodes.push({
          kind: "signature_block",
          key: node.key,
          title: "Signature",
          text: signature
            ? `Signature captured (${signature.filename})`
            : missingText(input.template, undefined),
        });
        continue;
      }
      if (node.kind === "table" || node.kind === "repeatable_row") {
        const group = input.record.groups[node.groupKey ?? ""] ?? [];
        const columns = node.columns ?? Object.keys(group[0] ?? {});
        nodes.push({
          kind: node.kind,
          key: node.key,
          title: node.title ?? section.title,
          text: `${group.length} row(s)`,
          rows: group.map((row) => columns.map((column) => asString(row[column] ?? null))),
        });
        continue;
      }
      if (node.kind === "section_status") {
        nodes.push({
          kind: "section_status",
          key: node.key,
          title: section.title,
          text: "Configured from the active report template. Not a BEA production section status.",
        });
      }
    }
  }

  return {
    templateKey: input.template.templateKey,
    templateVersion: input.template.templateVersion,
    configurationReleaseId: input.configurationReleaseId,
    configurationReleaseVersion: input.configurationReleaseVersion,
    schemaVersion: `${input.schema.schemaKey}@${input.schema.schemaVersion}`,
    mappingVersion: `${input.mapping.profileKey}@${input.mapping.profileVersion}`,
    ruleSetVersion: `${input.ruleSet.ruleSetKey}@${input.ruleSet.ruleSetVersion}`,
    disclosure: input.template.disclosure,
    filename,
    headerText: input.template.headerText,
    footerText: input.template.footerText,
    includePageNumbers: input.template.includePageNumbers,
    reportReference: input.reportReference,
    inspectionReference: input.inspectionReference,
    projectReference: input.projectReference,
    preview,
    nodes,
  };
}

function isWeekday(date: Date, workdays: readonly number[]): boolean {
  return workdays.includes(date.getUTCDay());
}

function isHoliday(date: Date, holidays: readonly string[]): boolean {
  return holidays.includes(date.toISOString().slice(0, 10));
}

export function previewSlaDue(input: {
  readonly policy: SlaPolicyDefinition;
  readonly startedAt: string;
  readonly now: string;
  readonly pausedMs?: number;
  readonly currentStageAgeMs?: number;
  readonly responsibleOwner: string;
}): SlaDuePreview {
  const started = Date.parse(input.startedAt);
  const now = Date.parse(input.now);
  const wall = Math.max(0, now - started);
  if (!input.policy.configured) {
    const elapsed = Math.max(0, wall - (input.pausedMs ?? 0));
    return {
      calendarPolicyUsed: `${input.policy.calendarMode} · ${input.policy.timeZone} · ${BEA_PRODUCTION_POLICY_UNCONFIGURED}`,
      configured: false,
      totalWallClockAgeMs: wall,
      slaElapsedMs: elapsed,
      pausedTimeMs: input.pausedMs ?? 0,
      remainingMs: input.policy.targetMinutes * 60_000 - elapsed,
      currentStageAgeMs: input.currentStageAgeMs ?? 0,
      responsibleOwner: input.responsibleOwner,
      dueAt: new Date(started + input.policy.targetMinutes * 60_000).toISOString(),
      disclosure: input.policy.disclosure,
    };
  }
  let elapsed = 0;
  if (input.policy.calendarMode === "calendar_time") {
    elapsed = Math.max(0, wall - (input.pausedMs ?? 0));
  } else {
    const cursor = new Date(started);
    const end = new Date(now);
    while (cursor < end) {
      const day = new Date(
        Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate()),
      );
      if (isWeekday(day, input.policy.workdays) && !isHoliday(day, input.policy.holidays)) {
        const startMinutes = input.policy.workdayStartMinute;
        const endMinutes = input.policy.workdayEndMinute;
        const dayStart = day.getTime() + startMinutes * 60_000;
        const dayEnd = day.getTime() + endMinutes * 60_000;
        const overlapStart = Math.max(dayStart, started);
        const overlapEnd = Math.min(dayEnd, now);
        if (overlapEnd > overlapStart) elapsed += overlapEnd - overlapStart;
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(0, 0, 0, 0);
    }
    elapsed = Math.max(0, elapsed - (input.pausedMs ?? 0));
  }
  return {
    calendarPolicyUsed: `${input.policy.calendarMode} · ${input.policy.timeZone}`,
    configured: true,
    totalWallClockAgeMs: wall,
    slaElapsedMs: elapsed,
    pausedTimeMs: input.pausedMs ?? 0,
    remainingMs: input.policy.targetMinutes * 60_000 - elapsed,
    currentStageAgeMs: input.currentStageAgeMs ?? 0,
    responsibleOwner: input.responsibleOwner,
    dueAt: new Date(started + input.policy.targetMinutes * 60_000).toISOString(),
    disclosure: input.policy.disclosure,
  };
}

export function validateBoundPackage(pack: BoundConfigurationPackage): {
  readonly passed: boolean;
  readonly issues: readonly ConfigurationValidationIssue[];
} {
  const issues: ConfigurationValidationIssue[] = [];
  const requiredKinds = CONFIGURATION_ARTIFACT_KINDS;
  for (const kind of requiredKinds) {
    const present =
      kind === "inspection_schema"
        ? pack.schema
        : kind === "mapping_profile"
          ? pack.mapping
          : kind === "validation_rule_set"
            ? pack.validation
            : kind === "report_template"
              ? pack.template
              : kind === "review_policy"
                ? pack.review
                : kind === "delivery_policy"
                  ? pack.delivery
                  : kind === "storage_policy"
                    ? pack.storage
                    : kind === "sla_policy"
                      ? pack.sla
                      : pack.workflow;
    if (!present) {
      issues.push({
        code: "package.missing_artifact",
        severity: "blocking",
        blocking: true,
        path: kind,
        message: `Required artifact ${kind} is missing.`,
        remediation: "Add the missing artifact before validation can pass.",
      });
    }
  }
  const parsed = parseBoundArtifacts({
    inspection_schema: pack.schema,
    mapping_profile: pack.mapping,
    validation_rule_set: pack.validation,
    report_template: pack.template,
    review_policy: pack.review,
    storage_policy: pack.storage,
    delivery_policy: pack.delivery,
    sla_policy: pack.sla,
    workflow_blueprint: pack.workflow,
  });
  issues.push(...parsed.issues);
  issues.push(...collectSyntheticConsistencyIssues(pack));
  const fieldKeys = new Set(pack.schema.fields.map((field) => field.key));
  const sectionKeys = new Set(pack.schema.sections.map((section) => section.key));
  const mapped = new Set(pack.mapping.rules.map((rule) => rule.canonicalField));
  for (const field of pack.schema.fields) {
    if (
      field.required &&
      !mapped.has(field.key) &&
      field.dataType !== "finding_collection" &&
      field.dataType !== "evidence_collection" &&
      field.dataType !== "signature_reference"
    ) {
      issues.push({
        code: "mapping.required_field_unmapped",
        severity: "blocking",
        blocking: true,
        path: field.key,
        message: `Required canonical field ${field.key} has no source mapping.`,
        remediation: "Map a source path or mark the field optional in a new draft.",
      });
    }
  }
  const destinations = new Map<string, string>();
  for (const rule of pack.mapping.rules) {
    if (!fieldKeys.has(rule.canonicalField)) {
      issues.push({
        code: "mapping.unknown_canonical_field",
        severity: "blocking",
        blocking: true,
        path: `mapping.rules.${rule.ruleKey}.canonicalField`,
        message: `Mapping '${rule.ruleKey}' targets nonexistent canonical field '${rule.canonicalField}'.`,
        remediation: "Map only to field keys defined on the inspection schema.",
      });
    }
    const prior = destinations.get(rule.canonicalField);
    if (prior && prior !== rule.sourcePath && rule.conflictBehavior === "reject") {
      issues.push({
        code: "mapping.conflict",
        severity: "blocking",
        blocking: true,
        path: rule.canonicalField,
        message: `Conflicting mappings for ${rule.canonicalField}.`,
        remediation: "Keep one mapping or change conflict behavior in a draft.",
      });
    }
    destinations.set(rule.canonicalField, rule.sourcePath);
    try {
      assertSafeJsonPath(rule.sourcePath);
    } catch (error) {
      issues.push({
        code: "mapping.unsafe_path",
        severity: "blocking",
        blocking: true,
        path: rule.sourcePath,
        message: error instanceof Error ? error.message : "Unsafe path",
        remediation: "Use a dotted field path. Arbitrary expressions are not allowed.",
      });
    }
    for (const transform of rule.transforms) {
      if (!MAPPING_TRANSFORM_KINDS.includes(transform.kind)) {
        issues.push({
          code: "mapping.unsafe_transform",
          severity: "blocking",
          blocking: true,
          path: rule.ruleKey,
          message: `Transformation ${String(transform.kind)} is not on the allowed list.`,
          remediation: "Use a controlled transformation. JavaScript, SQL, and shell are rejected.",
        });
      }
    }
  }
  for (const collection of pack.mapping.collections ?? []) {
    if (
      collection.collectionKind === "repeatable_group" &&
      collection.destinationGroupKey &&
      !sectionKeys.has(collection.destinationGroupKey)
    ) {
      issues.push({
        code: "mapping.unknown_group_key",
        severity: "blocking",
        blocking: true,
        path: `mapping.collections.${collection.collectionKey}.destinationGroupKey`,
        message: `Collection '${collection.collectionKey}' targets unknown group '${collection.destinationGroupKey}'.`,
        remediation: "Use a schema section key as destinationGroupKey.",
      });
    }
  }
  const referencedCanonicalFields = (expression: ValidationExpression): readonly string[] => {
    switch (expression.kind) {
      case "required":
      case "required_if":
      case "min_number":
      case "max_number":
      case "min_length":
      case "max_length":
      case "allowed_enum":
      case "advisory":
        return [expression.field];
      case "date_ordering":
      case "timestamp_ordering":
        return [expression.earlierField, expression.laterField];
      case "cross_field_compare":
        return [expression.leftField, expression.rightField];
      case "unique_in_group":
      case "min_evidence_count":
      case "min_photo_count":
      case "required_caption":
      case "required_finding_relationship":
      case "required_signature":
      case "required_reviewer_role":
        return [];
      default: {
        const unknownKind = String((expression as { kind?: unknown }).kind ?? "unknown");
        issues.push({
          code: "validation.unknown_expression_kind",
          severity: "blocking",
          blocking: true,
          path: "validation",
          message: `Unknown validation-expression kind '${unknownKind}' cannot be referenced.`,
          remediation: "Replace the rule with a supported expression kind.",
        });
        return [];
      }
    }
  };
  for (const rule of pack.validation.rules) {
    for (const field of referencedCanonicalFields(rule.expression)) {
      if (!fieldKeys.has(field)) {
        issues.push({
          code: "validation.unknown_field",
          severity: "blocking",
          blocking: true,
          path: `validation.rules.${rule.ruleKey}`,
          message: `Validation rule '${rule.ruleKey}' references nonexistent field '${field}'.`,
          remediation: "Point the rule at a canonical field on the schema.",
        });
      }
    }
    if (rule.expression.kind === "unique_in_group" && !sectionKeys.has(rule.expression.groupKey)) {
      issues.push({
        code: "validation.unknown_group",
        severity: "blocking",
        blocking: true,
        path: `validation.rules.${rule.ruleKey}.expression.groupKey`,
        message: `Validation rule '${rule.ruleKey}' references unknown group '${rule.expression.groupKey}'.`,
        remediation:
          "Use a schema section key. unique_in_group.field is a group row property, not a schema field.",
      });
    }
  }
  for (const section of pack.template.sections) {
    for (const node of section.nodes) {
      if ((node.kind === "bound_field" || node.kind === "label_value") && node.fieldKey) {
        if (!fieldKeys.has(node.fieldKey)) {
          issues.push({
            code: "template.unknown_field",
            severity: "blocking",
            blocking: true,
            path: `template.sections.${section.key}.nodes.${node.key}`,
            message: `Template node '${node.key}' binds to nonexistent field '${node.fieldKey}'.`,
            remediation: "Bind only to canonical field keys.",
          });
        }
      }
      if ((node.kind === "table" || node.kind === "repeatable_row") && node.groupKey) {
        if (!sectionKeys.has(node.groupKey)) {
          issues.push({
            code: "template.unknown_group",
            severity: "blocking",
            blocking: true,
            path: `template.sections.${section.key}.nodes.${node.key}`,
            message: `Template node '${node.key}' binds to nonexistent group '${node.groupKey}'.`,
            remediation: "Bind tables to a schema section key.",
          });
        }
      }
    }
  }
  if (pack.review.deliveryAuthorizerRole !== "owner-admin") {
    issues.push({
      code: "review.delivery_authorizer_locked",
      severity: "blocking",
      blocking: true,
      path: "review.deliveryAuthorizerRole",
      message: "Delivery authorization must remain Owner-only.",
      remediation: "Do not weaken the technical-review versus delivery-authorization split.",
    });
  }
  if (pack.review.requiredTechnicalApprovals < 1) {
    issues.push({
      code: "review.approvals_required",
      severity: "blocking",
      blocking: true,
      path: "review.requiredTechnicalApprovals",
      message: "At least one technical approval is required.",
      remediation: "Set required technical approvals to 1 or more.",
    });
  }
  if (!pack.release.synthetic && pack.release.productionReady) {
    issues.push({
      code: "production.unconfirmed",
      severity: "blocking",
      blocking: true,
      path: "release.productionReady",
      message: BEA_PRODUCTION_POLICY_UNCONFIGURED,
      remediation: "Keep production releases inactive until Owner confirms the intake packet.",
    });
  }
  if (pack.template.rendererAdapter !== "bea.deterministic-synthetic-pdf.v1") {
    issues.push({
      code: "template.unsupported_adapter",
      severity: "blocking",
      blocking: true,
      path: "template.rendererAdapter",
      message: `Renderer adapter ${pack.template.rendererAdapter} is not implemented.`,
      remediation:
        "Use the deterministic synthetic PDF adapter. DOCX and fillable PDF remain reserved.",
    });
  }
  return { passed: issues.filter((item) => item.blocking).length === 0, issues };
}

export function compareMappingProfiles(
  left: SourceMappingProfile,
  right: SourceMappingProfile,
): readonly string[] {
  const leftMap = new Map(left.rules.map((rule) => [rule.canonicalField, rule.sourcePath]));
  const rightMap = new Map(right.rules.map((rule) => [rule.canonicalField, rule.sourcePath]));
  const keys = new Set([...leftMap.keys(), ...rightMap.keys()]);
  const changes: string[] = [];
  for (const key of keys) {
    if (leftMap.get(key) !== rightMap.get(key)) {
      changes.push(`${key}: ${leftMap.get(key) ?? "(none)"} → ${rightMap.get(key) ?? "(none)"}`);
    }
  }
  return changes;
}

export function compareReportTemplates(
  left: ReportTemplateDefinition,
  right: ReportTemplateDefinition,
): readonly string[] {
  const changes: string[] = [];
  if (left.filenamePattern !== right.filenamePattern) {
    changes.push(`filename: ${left.filenamePattern} → ${right.filenamePattern}`);
  }
  const leftSections = left.sections.map((section) => section.key).join(",");
  const rightSections = right.sections.map((section) => section.key).join(",");
  if (leftSections !== rightSections) {
    changes.push(`sections: ${leftSections} → ${rightSections}`);
  }
  return changes;
}

export function buildStorageDeliveryDryRun(input: {
  readonly pack: BoundConfigurationPackage;
  readonly inspectionReference: string;
  readonly reportReference: string;
  readonly projectReference: string;
  readonly filename: string;
  readonly recipient: string;
  readonly sharePointStatus: string;
  readonly outlookStatus: string;
}): StorageDeliveryDryRunManifest {
  const values = {
    projectRef: input.projectReference,
    inspectionRef: input.inspectionReference,
    reportRef: input.reportReference,
  };
  const projectFolder = interpolate(input.pack.storage.projectFolderPattern, values);
  const inspectionFolder = interpolate(input.pack.storage.inspectionFolderPattern, values);
  const reportFolder = interpolate(input.pack.storage.reportFolderPattern, values);
  const fileName = interpolate(input.pack.storage.fileNamePattern, {
    ...values,
    filename: input.filename,
  });
  return {
    liveWrites: false,
    connectorStatus: {
      sharePoint: input.sharePointStatus,
      outlook: input.outlookStatus,
    },
    foldersThatWouldBeCreated: [projectFolder, inspectionFolder, reportFolder],
    filesThatWouldBeUploaded: [`${reportFolder}/${fileName}`],
    metadataThatWouldBeWritten: {
      inspection: input.inspectionReference,
      report: input.reportReference,
      configurationRelease: `${input.pack.release.familyKey}@${input.pack.release.versionNumber}`,
    },
    emailThatWouldBePrepared: {
      from: input.pack.delivery.senderMailbox ?? "unconfigured-sender",
      to: [input.recipient],
      cc: input.pack.delivery.ccPattern ? [input.pack.delivery.ccPattern] : [],
      subject: interpolate(input.pack.delivery.subjectPattern, values),
      body: interpolate(input.pack.delivery.bodyTemplate, values),
      attachments: [fileName],
    },
    authorizationRequired:
      "Owner delivery authorization remains required. No automatic client send.",
    connectorScopesRequired: ["Sites.ReadWrite.All (deferred)", "Mail.Send (deferred)"],
    calendarEventThatWouldBePrepared: {
      title: `Inspection ${input.inspectionReference}`,
      disclosure:
        "Dry-run calendar plan only. Live Outlook calendar is not connected and no event is created.",
    },
    disclosure: `${CONFIGURATION_SYNTHETIC_DISCLOSURE} No Microsoft Graph request is made. Connectors remain not connected.`,
  };
}

export function assertReviewPolicySafe(policy: ReviewPolicyDefinition): void {
  if (policy.deliveryAuthorizerRole !== "owner-admin" || !policy.finalSendAuthorizationRequired) {
    throw new UnsafeTransformationError("Delivery authorization cannot be weakened.");
  }
  if (policy.requiredTechnicalApprovals < 1) {
    throw new UnsafeTransformationError("Technical approval cannot be removed.");
  }
}

export function schemaFieldKeys(schema: InspectionSchemaDefinition): readonly string[] {
  return schema.fields.map((field) => field.key);
}

export function emptyCanonicalRecord(): CanonicalInspectionRecord {
  return { fields: {}, findings: [], evidence: [], groups: {}, lineage: [] };
}
