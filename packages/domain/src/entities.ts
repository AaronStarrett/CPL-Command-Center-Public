import type {
  EntityStatus,
  IntegrationConnectionStatus,
  IntegrationMode,
  RequirementStatus,
  WorkflowStatus,
} from "./status.js";

export type EntityId = string;
export type IsoDateTime = string;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface VersionedEntity {
  id: EntityId;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  version: number;
}

export interface User extends VersionedEntity {
  personaKey: string | null;
  email: string;
  displayName: string;
  title: string | null;
  status: EntityStatus;
  createdByUserId: EntityId | null;
  archivedAt: IsoDateTime | null;
}

export interface Role extends VersionedEntity {
  key: string;
  name: string;
  description: string;
  status: EntityStatus;
  createdByUserId: EntityId | null;
}

export interface Permission extends VersionedEntity {
  key: string;
  name: string;
  description: string;
  status: EntityStatus;
  createdByUserId: EntityId | null;
}

export interface UserRole {
  userId: EntityId;
  roleId: EntityId;
  createdAt: IsoDateTime;
  createdByUserId: EntityId | null;
}

export interface RolePermission {
  roleId: EntityId;
  permissionId: EntityId;
  createdAt: IsoDateTime;
  createdByUserId: EntityId | null;
}

export interface AuthenticationSession extends VersionedEntity {
  userId: EntityId;
  tokenHash: string;
  expiresAt: IsoDateTime;
  revokedAt: IsoDateTime | null;
  lastSeenAt: IsoDateTime | null;
}

export type AuditOutcome = "allowed" | "denied" | "succeeded" | "failed";

export interface AuditLog {
  id: EntityId;
  eventType: string;
  action: string;
  outcome: AuditOutcome;
  actorUserId: EntityId | null;
  resourceType: string | null;
  resourceId: EntityId | null;
  correlationId: string | null;
  metadata: JsonObject;
  createdAt: IsoDateTime;
}

export interface FeatureFlag extends VersionedEntity {
  key: string;
  displayName: string;
  description: string;
  enabled: boolean;
  requirementStatus: RequirementStatus;
  createdByUserId: EntityId | null;
}

export type SettingSensitivity = "public" | "internal" | "secret";

export interface SystemSetting extends VersionedEntity {
  key: string;
  value: JsonValue;
  description: string;
  sensitivity: SettingSensitivity;
  createdByUserId: EntityId | null;
}

export const INTEGRATION_PROVIDER_TYPES = [
  "microsoft-identity",
  "microsoft-graph",
  "outlook-email",
  "outlook-calendar",
  "teams",
  "sharepoint",
  "crm",
  "accounting",
  "timekeeping",
  "telephony",
  "e-signature",
  "ai",
  "embeddings",
  "speech-to-text",
  "text-to-speech",
] as const;

export type IntegrationProviderType = (typeof INTEGRATION_PROVIDER_TYPES)[number];

export interface IntegrationConnection extends VersionedEntity {
  providerType: IntegrationProviderType;
  displayName: string;
  mode: IntegrationMode;
  connectionStatus: IntegrationConnectionStatus;
  requirementStatus: RequirementStatus;
  configurationCompleteness: number;
  requiredPermissions: readonly string[];
  externalIdentifier: string | null;
  lastHealthCheckAt: IsoDateTime | null;
  lastSuccessfulSyncAt: IsoDateTime | null;
  lastFailure: StructuredError | null;
  testMode: boolean;
  mockMode: boolean;
  createdByUserId: EntityId | null;
}

export interface StructuredError {
  code: string;
  message: string;
  retryable: boolean;
  details?: JsonObject;
}

export interface WorkflowRun extends VersionedEntity {
  workflowKey: string;
  status: WorkflowStatus;
  triggerMetadata: JsonObject;
  correlationId: string;
  idempotencyKey: string;
  startedAt: IsoDateTime;
  finishedAt: IsoDateTime | null;
  error: StructuredError | null;
  retryCount: number;
  cancellationRequested: boolean;
  createdByUserId: EntityId | null;
}

export interface WorkflowStepRun extends VersionedEntity {
  workflowRunId: EntityId;
  stepKey: string;
  sequence: number;
  status: WorkflowStatus;
  startedAt: IsoDateTime;
  finishedAt: IsoDateTime | null;
  result: JsonObject | null;
  error: StructuredError | null;
  retryCount: number;
}
