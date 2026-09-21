import type { EntityId, IsoDateTime, JsonObject, JsonValue, VersionedEntity } from "./entities.js";
import type { EvidenceKind, FindingSeverity, NormalizedInspectionPayload } from "./operations.js";

export const CONFIGURATION_CONTRACT_VERSION = "phase-3.1a.0";

export function configurationReleaseIdentityMaterial(input: {
  readonly releaseId: string;
  readonly versionNumber: number;
  readonly artifacts: readonly {
    readonly artifactKind: string;
    readonly artifactKey: string;
    readonly payloadChecksum: string;
  }[];
}): string {
  const bound = [...input.artifacts]
    .map((item) => `${item.artifactKind}|${item.artifactKey}|${item.payloadChecksum}`)
    .sort((left, right) => left.localeCompare(right, "en-US"));
  return [`release:${input.releaseId}`, `version:${input.versionNumber}`, ...bound].join("\n");
}

export const CONFIGURATION_RELEASE_STATUSES = [
  "draft",
  "validation_failed",
  "validated",
  "published",
  "active",
  "superseded",
  "archived",
] as const;
export type ConfigurationReleaseStatus = (typeof CONFIGURATION_RELEASE_STATUSES)[number];

export const CONFIGURATION_ARTIFACT_KINDS = [
  "inspection_schema",
  "mapping_profile",
  "validation_rule_set",
  "report_template",
  "review_policy",
  "delivery_policy",
  "storage_policy",
  "sla_policy",
  "workflow_blueprint",
] as const;
export type ConfigurationArtifactKind = (typeof CONFIGURATION_ARTIFACT_KINDS)[number];

export const CANONICAL_FIELD_TYPES = [
  "string",
  "multiline_text",
  "integer",
  "decimal",
  "boolean",
  "date",
  "timestamp",
  "enum",
  "multi_enum",
  "address",
  "person_contact",
  "finding_collection",
  "evidence_collection",
  "signature_reference",
] as const;
export type CanonicalFieldType = (typeof CANONICAL_FIELD_TYPES)[number];

export const MAPPING_SOURCE_TYPES = ["json", "csv"] as const;
export type MappingSourceType = (typeof MAPPING_SOURCE_TYPES)[number];

export const CSV_ROW_MODES = ["single_record", "record_collection"] as const;
export type CsvRowMode = (typeof CSV_ROW_MODES)[number];

export const CSV_SCALAR_STRATEGIES = ["all_rows_must_match", "not_applicable"] as const;
export type CsvScalarStrategy = (typeof CSV_SCALAR_STRATEGIES)[number];

export const COLLECTION_KINDS = ["findings", "evidence", "signature", "repeatable_group"] as const;
export type CollectionKind = (typeof COLLECTION_KINDS)[number];

export const COLLECTION_CARDINALITIES = ["one", "many"] as const;
export type CollectionCardinality = (typeof COLLECTION_CARDINALITIES)[number];

export const COLLECTION_EMPTY_BEHAVIORS = ["block", "allow"] as const;
export type CollectionEmptyBehavior = (typeof COLLECTION_EMPTY_BEHAVIORS)[number];

export const FINDING_BINDING_DESTINATIONS = [
  "code",
  "sectionKey",
  "title",
  "description",
  "severity",
  "location",
] as const;
export type FindingBindingDestination = (typeof FINDING_BINDING_DESTINATIONS)[number];

export const EVIDENCE_BINDING_DESTINATIONS = [
  "findingCode",
  "kind",
  "filename",
  "contentType",
  "sha256",
  "byteLength",
  "storageRef",
  "caption",
] as const;
export type EvidenceBindingDestination = (typeof EVIDENCE_BINDING_DESTINATIONS)[number];

export const SIGNATURE_BINDING_DESTINATIONS = [
  "filename",
  "contentType",
  "sha256",
  "byteLength",
  "storageRef",
] as const;
export type SignatureBindingDestination = (typeof SIGNATURE_BINDING_DESTINATIONS)[number];

export const REPORT_FILENAME_TOKENS = ["reportRef", "inspectionRef", "projectRef"] as const;
export const STORAGE_PLACEHOLDER_TOKENS = [
  "reportRef",
  "inspectionRef",
  "projectRef",
  "filename",
] as const;

export const VALIDATION_EXPRESSION_KINDS = [
  "required",
  "required_if",
  "min_number",
  "max_number",
  "min_length",
  "max_length",
  "allowed_enum",
  "date_ordering",
  "timestamp_ordering",
  "cross_field_compare",
  "min_evidence_count",
  "min_photo_count",
  "required_caption",
  "required_finding_relationship",
  "required_signature",
  "required_reviewer_role",
  "unique_in_group",
  "advisory",
] as const;
export type ValidationExpressionKind = (typeof VALIDATION_EXPRESSION_KINDS)[number];

export const MAX_STAGING_SOURCE_BYTES = 512 * 1024;
export const STAGING_SOURCE_SIZE_POLICY =
  "JSON/CSV text-intake APIs accept at most 524288 UTF-8 bytes of the exact submitted raw string. Oversized sources are rejected without truncation. Exact raw source means the string received by the server and its complete UTF-8 encoding. Original binary-file preservation is not claimed.";

export const MAPPING_TRANSFORM_KINDS = [
  "trim",
  "collapse_whitespace",
  "lowercase",
  "uppercase",
  "parse_date",
  "parse_timestamp",
  "parse_integer",
  "parse_decimal",
  "boolean_map",
  "enum_map",
  "unit_conversion",
  "concat",
  "flatten_array",
  "replace_exact",
  "compose_address",
] as const;
export type MappingTransformKind = (typeof MAPPING_TRANSFORM_KINDS)[number];

export const VALIDATION_SEVERITIES = ["blocking", "warning", "advisory"] as const;
export type ValidationSeverity = (typeof VALIDATION_SEVERITIES)[number];

export const INTAKE_STATUSES = [
  "unknown",
  "assumed_for_demo",
  "awaiting_bea_confirmation",
  "confirmed",
  "configured",
  "tested",
  "approved",
] as const;
export type IntakeStatus = (typeof INTAKE_STATUSES)[number];

export const READINESS_ARCHITECTURE_STATES = [
  "architecture_complete",
  "synthetic_configuration_complete",
  "production_configuration_missing",
  "production_configuration_confirmed",
  "production_configuration_tested",
] as const;
export type ReadinessArchitectureState = (typeof READINESS_ARCHITECTURE_STATES)[number];

export const STAGING_STATUSES = [
  "received",
  "quarantined",
  "mapped",
  "validated",
  "committed",
  "duplicate",
  "failed",
] as const;
export type StagingStatus = (typeof STAGING_STATUSES)[number];

export const CONFIGURATION_SYNTHETIC_DISCLOSURE =
  "SYNTHETIC CONFIGURATION — demonstration only. Not a BEA production inspection type, report template, or confirmed policy.";

export const BEA_PRODUCTION_POLICY_UNCONFIGURED =
  "BEA PRODUCTION POLICY: UNCONFIGURED. Waiting for Owner's Thursday, 3 September 2026 materials.";

export const CONFIGURATION_FAMILY_KEYS = [
  "synthetic-exterior-observation",
  "synthetic-moisture-investigation",
  "bea-production-inspection-report",
] as const;
export type ConfigurationFamilyKey = (typeof CONFIGURATION_FAMILY_KEYS)[number];

export const SEEDED_CONFIGURATION_IDS = {
  exteriorRelease: "c1000000-0000-4000-8000-000000000001",
  moistureRelease: "c1000000-0000-4000-8000-000000000002",
  productionDraft: "c1000000-0000-4000-8000-000000000003",
} as const;

export interface ConfigurationRelease extends VersionedEntity {
  familyKey: string;
  displayName: string;
  versionNumber: number;
  status: ConfigurationReleaseStatus;
  synthetic: boolean;
  productionReady: boolean;
  serviceContextKey: string;
  description: string;
  disclosure: string;
  parentReleaseId: EntityId | null;
  checksum: string | null;
  validatedIdentityChecksum: string | null;
  createdByUserId: EntityId;
  validatedAt: IsoDateTime | null;
  validatedByUserId: EntityId | null;
  publishedAt: IsoDateTime | null;
  publishedByUserId: EntityId | null;
  activatedAt: IsoDateTime | null;
  activatedByUserId: EntityId | null;
  archivedAt: IsoDateTime | null;
  archivedByUserId: EntityId | null;
}

export interface ConfigurationArtifact {
  id: EntityId;
  releaseId: EntityId;
  artifactKind: ConfigurationArtifactKind;
  artifactKey: string;
  payload: JsonObject;
  checksum: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface ConfigurationValidationIssue {
  readonly code: string;
  readonly severity: ValidationSeverity;
  readonly blocking: boolean;
  readonly path: string;
  readonly message: string;
  readonly remediation: string;
}

export interface ConfigurationValidationRun {
  id: EntityId;
  releaseId: EntityId;
  passed: boolean;
  blocking: readonly ConfigurationValidationIssue[];
  warnings: readonly ConfigurationValidationIssue[];
  actorUserId: EntityId | null;
  createdAt: IsoDateTime;
}

export interface ConfigurationReadinessItem extends VersionedEntity {
  gapKey: string;
  area: string;
  description: string;
  currentSyntheticBehavior: string;
  whyConfirmationRequired: string;
  blockingStage: string;
  responsiblePerson: string;
  targetMeeting: string;
  status: IntakeStatus;
  resolution: string | null;
  configurationArtifactKind: ConfigurationArtifactKind | null;
}

export interface ConfigurationIntakeItem extends VersionedEntity {
  questionKey: string;
  sectionKey: string;
  prompt: string;
  status: IntakeStatus;
  answer: string | null;
  notes: string | null;
}

export interface InspectionReadinessItem {
  readonly key: string;
  readonly label: string;
  readonly status: "pending" | "complete" | "blocked";
  readonly detail: string | null;
}

export interface SafeStagingError {
  readonly code: string;
  readonly retryable: boolean;
  readonly correlationId: string;
  readonly failureStage: string;
}

export interface IngestionStagingRun {
  id: EntityId;
  sourceType: string;
  sourceSystemLabel: string | null;
  sourceSchemaVersion: string | null;
  sourceTimestamp: IsoDateTime | null;
  sourceIdentity: string;
  payloadSha256: string;
  rawRepresentation: JsonObject;
  rawSourceText: string | null;
  rawSourceSha256: string | null;
  rawSourceByteLength: number | null;
  inspectionId: EntityId | null;
  sourceIdempotencyKey: string | null;
  lastError: SafeStagingError | null;
  finalizedAt: IsoDateTime | null;
  mappingProfileKey: string | null;
  configurationReleaseId: EntityId | null;
  dryRun: boolean;
  status: StagingStatus;
  mappingReport: JsonObject | null;
  validationPreview: JsonObject | null;
  committedSubmissionId: EntityId | null;
  actorUserId: EntityId | null;
  classificationWarnings: readonly string[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime | null;
}

export interface CanonicalFieldDefinition {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly dataType: CanonicalFieldType;
  readonly required: boolean;
  readonly defaultStatus: "optional" | "required" | "system";
  readonly sectionKey: string;
  readonly displayOrder: number;
  readonly repeatableGroup: string | null;
  readonly allowedValues: readonly string[] | null;
  readonly unit: string | null;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly minLength: number | null;
  readonly maxLength: number | null;
  readonly dateRule: string | null;
  readonly privacyClassification: "operational" | "restricted" | "signature";
  readonly evidenceRelationship: "none" | "requires_evidence" | "is_evidence";
  readonly findingRelationship: "none" | "is_finding" | "requires_finding";
  readonly sourceLineageRequired: boolean;
  readonly correctionGuidance: string;
  readonly visibleIf: FieldCondition | null;
  readonly requiredIf: FieldCondition | null;
}

export interface CanonicalSectionDefinition {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly displayOrder: number;
  readonly parentKey: string | null;
  readonly repeatable: boolean;
}

export interface InspectionSchemaDefinition {
  readonly schemaKey: string;
  readonly schemaVersion: number;
  readonly displayName: string;
  readonly synthetic: boolean;
  readonly disclosure: string;
  readonly sections: readonly CanonicalSectionDefinition[];
  readonly fields: readonly CanonicalFieldDefinition[];
}

export interface FieldCondition {
  readonly kind: "always" | "field_equals" | "field_truthy" | "field_present";
  readonly field?: string;
  readonly value?: JsonValue;
}

export interface MappingTransform {
  readonly kind: MappingTransformKind;
  readonly trueValues?: readonly string[];
  readonly falseValues?: readonly string[];
  readonly map?: Readonly<Record<string, string>>;
  readonly fromUnit?: string;
  readonly toUnit?: string;
  readonly factor?: number;
  readonly separator?: string;
  readonly sources?: readonly string[];
  readonly from?: string;
  readonly to?: string;
  readonly streetPath?: string;
  readonly cityPath?: string;
  readonly regionPath?: string;
  readonly postalPath?: string;
}

export interface SourceMappingRule {
  readonly ruleKey: string;
  readonly sourcePath: string;
  readonly canonicalField: string;
  readonly transforms: readonly MappingTransform[];
  readonly requiredSource: boolean;
  readonly conflictBehavior: "reject" | "first_wins" | "last_wins";
  readonly nullBehavior: "leave_empty" | "use_default";
  readonly defaultValue?: JsonValue;
}

export interface CollectionItemBinding {
  readonly destination: string;
  readonly sourcePath: string;
  readonly transforms: readonly MappingTransform[];
  readonly required: boolean;
  readonly defaultValue?: JsonValue;
}

export interface CollectionRelationshipBinding {
  readonly relationshipKey: string;
  readonly sourcePath: string;
  readonly required: boolean;
}

export interface SourceCollectionMapping {
  readonly collectionKey: string;
  readonly collectionKind: CollectionKind;
  readonly sourcePath: string;
  readonly cardinality: CollectionCardinality;
  readonly destinationGroupKey?: string;
  readonly itemBindings: readonly CollectionItemBinding[];
  readonly relationshipBindings?: readonly CollectionRelationshipBinding[];
  readonly requiredSource: boolean;
  readonly emptyBehavior: CollectionEmptyBehavior;
}

export interface SourceMappingProfile {
  readonly profileKey: string;
  readonly profileVersion: number;
  readonly displayName: string;
  readonly synthetic: boolean;
  readonly sourceType: MappingSourceType;
  readonly sourceSchemaVersion: string;
  readonly applicableConfiguration: string;
  readonly disclosure: string;
  readonly csvRowMode: CsvRowMode;
  readonly csvScalarStrategy: CsvScalarStrategy;
  readonly rules: readonly SourceMappingRule[];
  readonly collections: readonly SourceCollectionMapping[];
}

export interface SourceLineage {
  readonly canonicalField: string;
  readonly sourcePath: string;
  readonly rawValue: JsonValue;
  readonly transformedValue: JsonValue;
  readonly transforms: readonly MappingTransformKind[];
}

export interface CanonicalInspectionRecord {
  readonly fields: Readonly<Record<string, JsonValue>>;
  readonly findings: readonly {
    readonly code: string;
    readonly sectionKey: string;
    readonly title: string;
    readonly description: string;
    readonly severity: FindingSeverity;
    readonly location: string | null;
  }[];
  readonly evidence: readonly {
    readonly findingCode: string | null;
    readonly kind: EvidenceKind;
    readonly filename: string;
    readonly contentType: string;
    readonly sha256: string;
    readonly byteLength: number;
    readonly storageRef: string;
    readonly caption: string | null;
  }[];
  readonly groups: Readonly<Record<string, readonly JsonObject[]>>;
  readonly lineage: readonly SourceLineage[];
}

export interface MappingIssue {
  readonly code: string;
  readonly blocking: boolean;
  readonly ruleKey: string;
  readonly sourcePath: string;
  readonly canonicalField: string | null;
  readonly message: string;
  readonly remediation: string;
}

export interface MappingEngineReport {
  readonly canonical: CanonicalInspectionRecord;
  readonly unmappedSourceFields: readonly string[];
  readonly canonicalFieldsWithoutSource: readonly string[];
  readonly conflicts: readonly string[];
  readonly rejectedTransforms: readonly string[];
  readonly blockingIssues: readonly MappingIssue[];
  readonly rowCount: number;
  readonly humanReadable: readonly string[];
}

export interface ValidationRuleDefinition {
  readonly ruleKey: string;
  readonly label: string;
  readonly description: string;
  readonly severity: ValidationSeverity;
  readonly blocking: boolean;
  readonly sectionKey: string;
  readonly trigger: FieldCondition;
  readonly expression: ValidationExpression;
  readonly remediation: string;
}

export type ValidationExpression =
  | { readonly kind: "required"; readonly field: string }
  | {
      readonly kind: "required_if";
      readonly field: string;
      readonly condition: FieldCondition;
    }
  | { readonly kind: "min_number"; readonly field: string; readonly minimum: number }
  | { readonly kind: "max_number"; readonly field: string; readonly maximum: number }
  | { readonly kind: "min_length"; readonly field: string; readonly minimum: number }
  | { readonly kind: "max_length"; readonly field: string; readonly maximum: number }
  | { readonly kind: "allowed_enum"; readonly field: string; readonly values: readonly string[] }
  | { readonly kind: "date_ordering"; readonly earlierField: string; readonly laterField: string }
  | {
      readonly kind: "timestamp_ordering";
      readonly earlierField: string;
      readonly laterField: string;
    }
  | {
      readonly kind: "cross_field_compare";
      readonly leftField: string;
      readonly operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
      readonly rightField: string;
    }
  | { readonly kind: "min_evidence_count"; readonly minimum: number }
  | { readonly kind: "min_photo_count"; readonly minimum: number }
  | { readonly kind: "required_caption" }
  | { readonly kind: "required_finding_relationship" }
  | { readonly kind: "required_signature" }
  | { readonly kind: "required_reviewer_role"; readonly role: string }
  | { readonly kind: "unique_in_group"; readonly groupKey: string; readonly field: string }
  | { readonly kind: "advisory"; readonly field: string; readonly message: string };

export interface ValidationRuleSet {
  readonly ruleSetKey: string;
  readonly ruleSetVersion: number;
  readonly displayName: string;
  readonly synthetic: boolean;
  readonly disclosure: string;
  readonly rules: readonly ValidationRuleDefinition[];
}

export interface ControlledValidationItem {
  readonly ruleKey: string;
  readonly severity: ValidationSeverity;
  readonly blocking: boolean;
  readonly path: string;
  readonly message: string;
  readonly remediation: string;
}

export interface ControlledValidationResult {
  readonly passed: boolean;
  readonly blocking: readonly ControlledValidationItem[];
  readonly warnings: readonly ControlledValidationItem[];
  readonly advisories: readonly ControlledValidationItem[];
  readonly ruleSetKey: string;
  readonly ruleSetVersion: number;
}

export const REPORT_NODE_KINDS = [
  "cover",
  "title",
  "heading",
  "paragraph",
  "bound_field",
  "label_value",
  "table",
  "repeatable_row",
  "finding_block",
  "evidence_block",
  "photo_grid",
  "caption",
  "signature_block",
  "conditional_section",
  "page_break",
  "static_disclaimer",
  "section_status",
] as const;
export type ReportNodeKind = (typeof REPORT_NODE_KINDS)[number];

export interface ReportTemplateNode {
  readonly kind: ReportNodeKind;
  readonly key: string;
  readonly title?: string;
  readonly text?: string;
  readonly fieldKey?: string;
  readonly columns?: readonly string[];
  readonly groupKey?: string;
  readonly visibleIf?: FieldCondition;
  readonly imagePlacement?: "grid" | "inline" | "finding_adjacent";
}

export interface ReportTemplateSection {
  readonly key: string;
  readonly title: string;
  readonly displayOrder: number;
  readonly visibleIf?: FieldCondition;
  readonly nodes: readonly ReportTemplateNode[];
}

export interface ReportTemplateDefinition {
  readonly templateKey: string;
  readonly templateVersion: number;
  readonly displayName: string;
  readonly synthetic: boolean;
  readonly disclosure: string;
  readonly applicableSchemaKey: string;
  readonly applicableMappingKey: string;
  readonly rendererAdapter: string;
  readonly filenamePattern: string;
  readonly missingValueBehavior: "show_placeholder" | "omit" | "show_not_recorded";
  readonly headerText: string;
  readonly footerText: string;
  readonly includePageNumbers: boolean;
  readonly sections: readonly ReportTemplateSection[];
}

export interface ReportDocumentNode {
  readonly kind: ReportNodeKind;
  readonly key: string;
  readonly title?: string;
  readonly text: string;
  readonly rows?: readonly (readonly string[])[];
}

export interface ReportDocument {
  readonly templateKey: string;
  readonly templateVersion: number;
  readonly configurationReleaseId: string | null;
  readonly configurationReleaseVersion: number | null;
  readonly schemaVersion: string;
  readonly mappingVersion: string;
  readonly ruleSetVersion: string;
  readonly disclosure: string;
  readonly filename: string;
  readonly headerText: string;
  readonly footerText: string;
  readonly includePageNumbers: boolean;
  readonly reportReference: string;
  readonly inspectionReference: string;
  readonly projectReference: string;
  readonly preview: boolean;
  readonly nodes: readonly ReportDocumentNode[];
}

export interface ReviewPolicyDefinition {
  readonly policyKey: string;
  readonly policyVersion: number;
  readonly synthetic: boolean;
  readonly disclosure: string;
  readonly technicalReviewerRole: string;
  readonly assignmentStrategy: "inspection_reviewer" | "role_pool";
  readonly requiredTechnicalApprovals: number;
  readonly selfReviewPermitted: boolean;
  readonly revisionResponsibility: "inspector" | "reviewer";
  readonly deliveryAuthorizerRole: "owner-admin";
  readonly finalSendAuthorizationRequired: true;
}

export interface StoragePolicyDefinition {
  readonly policyKey: string;
  readonly policyVersion: number;
  readonly synthetic: boolean;
  readonly disclosure: string;
  readonly sharePointTenant: string | null;
  readonly site: string | null;
  readonly documentLibrary: string | null;
  readonly projectFolderPattern: string;
  readonly inspectionFolderPattern: string;
  readonly reportFolderPattern: string;
  readonly fileNamePattern: string;
  readonly versionBehavior: "new_version" | "new_file";
  readonly conflictBehavior: "fail" | "suffix";
  readonly metadataFields: readonly string[];
  readonly configured: boolean;
}

export interface DeliveryPolicyDefinition {
  readonly policyKey: string;
  readonly policyVersion: number;
  readonly synthetic: boolean;
  readonly disclosure: string;
  readonly senderMailbox: string | null;
  readonly toPattern: string;
  readonly ccPattern: string | null;
  readonly bccRestricted: boolean;
  readonly subjectPattern: string;
  readonly bodyTemplate: string;
  readonly attachmentNamePattern: string;
  readonly deliveryAuthorizerRole: "owner-admin";
  readonly retryPolicy: string;
  readonly reconciliationPolicy: string;
  readonly configured: boolean;
}

export interface SlaPolicyDefinition {
  readonly policyKey: string;
  readonly policyVersion: number;
  readonly synthetic: boolean;
  readonly disclosure: string;
  readonly calendarMode: "calendar_time" | "business_hours";
  readonly timeZone: string;
  readonly workdays: readonly number[];
  readonly workdayStartMinute: number;
  readonly workdayEndMinute: number;
  readonly holidays: readonly string[];
  readonly targetMinutes: number;
  readonly warningThresholdMinutes: number;
  readonly breachThresholdMinutes: number;
  readonly pauseReasons: readonly string[];
  readonly attributionCategories: readonly string[];
  readonly escalationOwnerRole: string;
  readonly configured: boolean;
}

export interface WorkflowBlueprintParameters {
  readonly policyKey: string;
  readonly policyVersion: number;
  readonly synthetic: boolean;
  readonly humanGate: boolean;
  readonly autoResume: boolean;
  readonly maxAttempts: number;
  readonly finalApprovalRequired: boolean;
}

export interface BoundConfigurationPackage {
  readonly release: Pick<
    ConfigurationRelease,
    | "id"
    | "familyKey"
    | "displayName"
    | "versionNumber"
    | "status"
    | "synthetic"
    | "productionReady"
    | "serviceContextKey"
    | "disclosure"
  >;
  readonly schema: InspectionSchemaDefinition;
  readonly mapping: SourceMappingProfile;
  readonly validation: ValidationRuleSet;
  readonly template: ReportTemplateDefinition;
  readonly review: ReviewPolicyDefinition;
  readonly storage: StoragePolicyDefinition;
  readonly delivery: DeliveryPolicyDefinition;
  readonly sla: SlaPolicyDefinition;
  readonly workflow: WorkflowBlueprintParameters;
}

export interface StorageDeliveryDryRunManifest {
  readonly liveWrites: false;
  readonly connectorStatus: {
    readonly sharePoint: string;
    readonly outlook: string;
  };
  readonly foldersThatWouldBeCreated: readonly string[];
  readonly filesThatWouldBeUploaded: readonly string[];
  readonly metadataThatWouldBeWritten: Readonly<Record<string, string>>;
  readonly emailThatWouldBePrepared: {
    readonly from: string;
    readonly to: readonly string[];
    readonly cc: readonly string[];
    readonly subject: string;
    readonly body: string;
    readonly attachments: readonly string[];
  };
  readonly authorizationRequired: string;
  readonly connectorScopesRequired: readonly string[];
  readonly calendarEventThatWouldBePrepared: {
    readonly title: string;
    readonly disclosure: string;
  };
  readonly disclosure: string;
}

export interface SlaDuePreview {
  readonly calendarPolicyUsed: string;
  readonly configured: boolean;
  readonly totalWallClockAgeMs: number;
  readonly slaElapsedMs: number;
  readonly pausedTimeMs: number;
  readonly remainingMs: number;
  readonly currentStageAgeMs: number;
  readonly responsibleOwner: string;
  readonly dueAt: IsoDateTime;
  readonly disclosure: string;
}

export class ConfigurationValidationError extends Error {
  readonly code = "CONFIGURATION_VALIDATION_FAILED";
  constructor(
    message: string,
    readonly issues: readonly ConfigurationValidationIssue[] = [],
  ) {
    super(message);
    this.name = "ConfigurationValidationError";
  }
}

export class ConfigurationImmutabilityError extends Error {
  readonly code = "CONFIGURATION_RELEASE_IMMUTABLE";
  constructor(message = "Published configuration releases cannot be edited.") {
    super(message);
    this.name = "ConfigurationImmutabilityError";
  }
}

export class ConfigurationActivationError extends Error {
  readonly code = "CONFIGURATION_ACTIVATION_BLOCKED";
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationActivationError";
  }
}

export class UnsafeTransformationError extends Error {
  readonly code = "UNSAFE_TRANSFORMATION_REJECTED";
  constructor(message: string) {
    super(message);
    this.name = "UnsafeTransformationError";
  }
}

export class ProductionMappingNotConfiguredError extends Error {
  readonly code = "PRODUCTION_MAPPING_NOT_CONFIGURED";
  constructor(
    message = "Production mapping is not configured. Fail closed until BEA materials are mapped.",
  ) {
    super(message);
    this.name = "ProductionMappingNotConfiguredError";
  }
}

export class StagingSourceTooLargeError extends Error {
  readonly code = "STAGING_SOURCE_TOO_LARGE";
  constructor(
    readonly byteLength: number,
    readonly maximumBytes: number = MAX_STAGING_SOURCE_BYTES,
  ) {
    super(
      `The submitted source is ${byteLength} bytes and exceeds the ${maximumBytes}-byte JSON/CSV text limit.`,
    );
    this.name = "StagingSourceTooLargeError";
  }
}

export function isConfigurationReleaseStatus(value: string): value is ConfigurationReleaseStatus {
  return (CONFIGURATION_RELEASE_STATUSES as readonly string[]).includes(value);
}

export function isConfigurationArtifactKind(value: string): value is ConfigurationArtifactKind {
  return (CONFIGURATION_ARTIFACT_KINDS as readonly string[]).includes(value);
}

export function isCanonicalFieldType(value: string): value is CanonicalFieldType {
  return (CANONICAL_FIELD_TYPES as readonly string[]).includes(value);
}

export function isMappingTransformKind(value: string): value is MappingTransformKind {
  return (MAPPING_TRANSFORM_KINDS as readonly string[]).includes(value);
}

export function isCsvRowMode(value: string): value is CsvRowMode {
  return (CSV_ROW_MODES as readonly string[]).includes(value);
}

export function isCollectionKind(value: string): value is CollectionKind {
  return (COLLECTION_KINDS as readonly string[]).includes(value);
}

export function isValidationExpressionKind(value: string): value is ValidationExpressionKind {
  return (VALIDATION_EXPRESSION_KINDS as readonly string[]).includes(value);
}

export function utf8ByteLength(rawSourceText: string): number {
  return new TextEncoder().encode(rawSourceText).byteLength;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function sha256Hex(bytes: Uint8Array): string {
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
    .map((value) => value.toString(16).padStart(8, "0"))
    .join("");
}

export function hashRawSourceText(rawSourceText: string): {
  readonly sha256: string;
  readonly byteLength: number;
} {
  const bytes = new TextEncoder().encode(rawSourceText);
  return {
    sha256: sha256Hex(bytes),
    byteLength: bytes.byteLength,
  };
}

export function assertStagingSourceSize(rawSourceText: string): void {
  const byteLength = utf8ByteLength(rawSourceText);
  if (byteLength > MAX_STAGING_SOURCE_BYTES) {
    throw new StagingSourceTooLargeError(byteLength, MAX_STAGING_SOURCE_BYTES);
  }
}

export function assertSyntheticReleaseExecution(synthetic: boolean): void {
  if (!synthetic) {
    throw new ProductionMappingNotConfiguredError(
      "Phase 3.1A blocks mapping, preview, commit, and activation for non-synthetic configuration releases. Production mapping remains unconfigured.",
    );
  }
}

export function stagingSourceIdempotencyKey(inspectionId: string, rawSourceSha256: string): string {
  return `config:${inspectionId}:${rawSourceSha256}`;
}

export function isPlaceholderOperationalReference(value: string): boolean {
  const lowered = value.trim().toLocaleLowerCase("en-US");
  return (
    lowered.startsWith("pending-") ||
    lowered.startsWith("preview-") ||
    lowered.startsWith("placeholder-")
  );
}

export function safeStagingError(input: {
  readonly code: string;
  readonly retryable: boolean;
  readonly correlationId: string;
  readonly failureStage: string;
}): SafeStagingError {
  return {
    code: input.code.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 120),
    retryable: input.retryable,
    correlationId: input.correlationId,
    failureStage: input.failureStage,
  };
}

export const INTAKE_DRAFT_STATUSES = [
  "unknown",
  "assumed_for_demo",
  "awaiting_bea_confirmation",
  "configured",
] as const;
export const INTAKE_TESTED_STATUSES = ["tested"] as const;
export const INTAKE_POLICY_STATUSES = ["confirmed", "approved"] as const;

export function isIntakeStatus(value: string): value is IntakeStatus {
  return (INTAKE_STATUSES as readonly string[]).includes(value);
}

export function releaseIsEditable(status: ConfigurationReleaseStatus): boolean {
  return status === "draft" || status === "validation_failed";
}

export function releaseIsImmutable(status: ConfigurationReleaseStatus): boolean {
  return (
    status === "published" ||
    status === "active" ||
    status === "superseded" ||
    status === "archived"
  );
}

export function defaultReviewPolicy(): ReviewPolicyDefinition {
  return {
    policyKey: "bea-review-policy",
    policyVersion: 1,
    synthetic: true,
    disclosure: CONFIGURATION_SYNTHETIC_DISCLOSURE,
    technicalReviewerRole: "operations",
    assignmentStrategy: "inspection_reviewer",
    requiredTechnicalApprovals: 1,
    selfReviewPermitted: false,
    revisionResponsibility: "inspector",
    deliveryAuthorizerRole: "owner-admin",
    finalSendAuthorizationRequired: true,
  };
}

export function projectCanonicalToNormalized(
  record: CanonicalInspectionRecord,
): NormalizedInspectionPayload {
  const field = (key: string): string | null => {
    const value = record.fields[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  return {
    clientName: field("client_name"),
    siteName: field("site_name"),
    inspectorName: field("inspector_name"),
    completedAt: field("completed_at"),
    serviceKey: field("service_key"),
    attestation: record.fields.attestation === true || record.fields.attestation === "true",
    summary: field("summary"),
    findings: record.findings,
    evidence: record.evidence.map((item) => ({
      findingCode: item.findingCode,
      kind: item.kind,
      filename: item.filename,
      contentType: item.contentType,
      sha256: item.sha256,
      byteLength: item.byteLength,
      storageRef: item.storageRef,
    })),
  };
}

export const CONFIGURATION_RELEASE_STATUS_LABELS: Readonly<
  Record<ConfigurationReleaseStatus, string>
> = {
  draft: "Draft",
  validation_failed: "Validation failed",
  validated: "Validated",
  published: "Published",
  active: "Active",
  superseded: "Superseded",
  archived: "Archived",
};
