import type {
  AuditLog,
  AuditOutcome,
  AuthenticationSession,
  EntityId,
  FeatureFlag,
  IntegrationConnection,
  IsoDateTime,
  JsonObject,
  JsonValue,
  StructuredError,
  SystemSetting,
  User,
  WorkflowRun,
  WorkflowStepRun,
} from "./entities.js";
import type { HealthStatus, WorkflowStatus } from "./status.js";
import type { RoleId } from "./personas.js";

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export interface AuditEventInput {
  eventType: string;
  action: string;
  outcome: AuditOutcome;
  actorUserId?: EntityId | null;
  resourceType?: string | null;
  resourceId?: EntityId | null;
  correlationId?: string | null;
  metadata?: JsonObject;
  createdAt?: IsoDateTime;
}

export interface AuditSink {
  record(event: AuditEventInput): Promise<AuditLog>;
}

export interface AuditReader {
  listAuditLogs(limit?: number): Promise<readonly AuditLog[]>;
}

export interface PermissionGrantStore {
  userHasPermission(userId: EntityId, permissionKey: string): Promise<boolean>;
}

export interface AuthenticatedUser extends User {
  roleIds: readonly RoleId[];
}

export interface UserDirectory {
  findActiveUserByPersonaKey(personaKey: string): Promise<AuthenticatedUser | null>;
  findActiveUserById(userId: EntityId): Promise<AuthenticatedUser | null>;
}

export interface SessionStore {
  createSession(session: AuthenticationSession): Promise<void>;
  findSessionByTokenHash(tokenHash: string): Promise<AuthenticationSession | null>;
  revokeSession(sessionId: EntityId, revokedAt: IsoDateTime): Promise<void>;
}

export interface SessionReader {
  countActiveSessions(at?: IsoDateTime): Promise<number>;
}

export interface FeatureFlagStore {
  getFeatureFlag(key: string): Promise<FeatureFlag | null>;
  listFeatureFlags(): Promise<readonly FeatureFlag[]>;
  setFeatureFlag(
    key: string,
    enabled: boolean,
    actorUserId: EntityId,
    updatedAt: IsoDateTime,
    expectedVersion?: number,
  ): Promise<FeatureFlag>;
}

export interface SystemSettingStore {
  getSystemSetting(key: string): Promise<SystemSetting | null>;
  listSystemSettings(): Promise<readonly SystemSetting[]>;
  setSystemSetting(
    key: string,
    value: JsonValue,
    actorUserId: EntityId,
    updatedAt: IsoDateTime,
    expectedVersion?: number,
  ): Promise<SystemSetting>;
}

export interface IntegrationConnectionStore {
  listIntegrationConnections(): Promise<readonly IntegrationConnection[]>;
}

export interface DatabaseHealth {
  status: HealthStatus;
  adapter: "postgres" | "pglite";
  checkedAt: IsoDateTime;
  latencyMs: number;
  detail?: string;
}

export interface DatabaseHealthProvider {
  health(): Promise<DatabaseHealth>;
}

export interface WorkflowRunClaim {
  run: WorkflowRun;
  claimed: boolean;
}

export interface WorkflowStore {
  claimWorkflowRun(run: WorkflowRun): Promise<WorkflowRunClaim>;
  saveWorkflowStepRun(step: WorkflowStepRun): Promise<void>;
  finishWorkflowRun(input: {
    id: EntityId;
    status: WorkflowStatus;
    finishedAt: IsoDateTime;
    error: StructuredError | null;
    expectedVersion: number;
  }): Promise<WorkflowRun>;
  getWorkflowRunByIdempotencyKey(idempotencyKey: string): Promise<WorkflowRun | null>;
  getLatestWorkflowRun(workflowKey: string): Promise<WorkflowRun | null>;
  listWorkflowStepRuns(workflowRunId: EntityId): Promise<readonly WorkflowStepRun[]>;
}
