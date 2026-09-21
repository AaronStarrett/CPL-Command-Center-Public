import { randomUUID } from "node:crypto";
import type {
  AuditEventInput,
  AuditLog,
  AuditReader,
  AuditSink,
  AuthenticatedUser,
  AuthenticationSession,
  FeatureFlag,
  FeatureFlagStore,
  IntegrationConnection,
  IntegrationConnectionStore,
  JsonValue,
  PermissionGrantStore,
  RoleId,
  SessionStore,
  SessionReader,
  StructuredError,
  SystemSetting,
  SystemSettingStore,
  UserDirectory,
  WorkflowRun,
  WorkflowRunClaim,
  WorkflowStatus,
  WorkflowStepRun,
  WorkflowStore,
} from "@bea/domain";
import type { DatabaseAdapter, SqlExecutor } from "./adapter.js";

type Row = Record<string, unknown>;

export interface RoleGrantSummary {
  readonly roleId: RoleId;
  readonly roleName: string;
  readonly permissionCount: number;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function json<T extends JsonValue | StructuredError | readonly string[]>(
  value: unknown,
  fallback: T,
): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as T;
    }
  }
  return value as T;
}

function mapSession(row: Row): AuthenticationSession {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    tokenHash: String(row.token_hash),
    expiresAt: iso(row.expires_at),
    revokedAt: nullableIso(row.revoked_at),
    lastSeenAt: nullableIso(row.last_seen_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

function mapAudit(row: Row): AuditLog {
  return {
    id: String(row.id),
    eventType: String(row.event_type),
    action: String(row.action),
    outcome: row.outcome as AuditLog["outcome"],
    actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
    resourceType: row.resource_type ? String(row.resource_type) : null,
    resourceId: row.resource_id ? String(row.resource_id) : null,
    correlationId: row.correlation_id ? String(row.correlation_id) : null,
    metadata: json(row.metadata, {}),
    createdAt: iso(row.created_at),
  };
}

function mapFeatureFlag(row: Row): FeatureFlag {
  return {
    id: String(row.id),
    key: String(row.key),
    displayName: String(row.display_name),
    description: String(row.description),
    enabled: Boolean(row.enabled),
    requirementStatus: row.requirement_status as FeatureFlag["requirementStatus"],
    createdByUserId: row.created_by_user_id ? String(row.created_by_user_id) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

function mapSystemSetting(row: Row): SystemSetting {
  return {
    id: String(row.id),
    key: String(row.key),
    value: json(row.value_json, null),
    description: String(row.description),
    sensitivity: row.sensitivity as SystemSetting["sensitivity"],
    createdByUserId: row.created_by_user_id ? String(row.created_by_user_id) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

function mapWorkflowRun(row: Row): WorkflowRun {
  return {
    id: String(row.id),
    workflowKey: String(row.workflow_key),
    status: row.status as WorkflowStatus,
    triggerMetadata: json(row.trigger_metadata, {}),
    correlationId: String(row.correlation_id),
    idempotencyKey: String(row.idempotency_key),
    startedAt: iso(row.started_at),
    finishedAt: nullableIso(row.finished_at),
    error: row.error ? json(row.error, null) : null,
    retryCount: Number(row.retry_count),
    cancellationRequested: Boolean(row.cancellation_requested),
    createdByUserId: row.created_by_user_id ? String(row.created_by_user_id) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

export class ConcurrentUpdateError extends Error {
  readonly code = "CONCURRENT_UPDATE";

  constructor(entity: string, key: string) {
    super(`${entity} ${key} was not found or changed concurrently.`);
    this.name = "ConcurrentUpdateError";
  }
}

export class SqlFoundationRepository
  implements
    AuditSink,
    AuditReader,
    UserDirectory,
    SessionStore,
    SessionReader,
    FeatureFlagStore,
    SystemSettingStore,
    IntegrationConnectionStore,
    PermissionGrantStore,
    WorkflowStore
{
  constructor(private readonly database: DatabaseAdapter) {}

  private async findUser(where: string, value: string): Promise<AuthenticatedUser | null> {
    const result = await this.database.query<Row>(
      `SELECT u.*, COALESCE(array_agg(r.key) FILTER (WHERE r.key IS NOT NULL), ARRAY[]::text[]) AS role_keys
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id AND r.status = 'active'
       WHERE ${where} = $1 AND u.status = 'active' AND u.archived_at IS NULL
       GROUP BY u.id`,
      [value],
    );
    const row = result.rows.at(0);
    if (!row) return null;
    return {
      id: String(row.id),
      personaKey: row.persona_key ? String(row.persona_key) : null,
      email: row.email ? String(row.email) : "",
      displayName: String(row.display_name),
      title: row.title ? String(row.title) : null,
      status: row.status as AuthenticatedUser["status"],
      createdByUserId: row.created_by_user_id ? String(row.created_by_user_id) : null,
      archivedAt: nullableIso(row.archived_at),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      version: Number(row.version),
      roleIds: (row.role_keys as readonly string[]).map((role) => role as RoleId),
    };
  }

  findActiveUserByPersonaKey(personaKey: string): Promise<AuthenticatedUser | null> {
    return this.findUser("u.persona_key", personaKey);
  }

  findActiveUserById(userId: string): Promise<AuthenticatedUser | null> {
    return this.findUser("u.id", userId);
  }

  async createSession(session: AuthenticationSession): Promise<void> {
    await this.database.query(
      `INSERT INTO sessions
       (id, user_id, token_hash, expires_at, revoked_at, last_seen_at, created_at, updated_at, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        session.id,
        session.userId,
        session.tokenHash,
        session.expiresAt,
        session.revokedAt,
        session.lastSeenAt,
        session.createdAt,
        session.updatedAt,
        session.version,
      ],
    );
  }

  async findSessionByTokenHash(tokenHash: string): Promise<AuthenticationSession | null> {
    const result = await this.database.query<Row>("SELECT * FROM sessions WHERE token_hash = $1", [
      tokenHash,
    ]);
    return result.rows[0] ? mapSession(result.rows[0]) : null;
  }

  async revokeSession(sessionId: string, revokedAt: string): Promise<void> {
    await this.database.query(
      "UPDATE sessions SET revoked_at=$2, updated_at=$2, version=version+1 WHERE id=$1 AND revoked_at IS NULL",
      [sessionId, revokedAt],
    );
  }

  async countActiveSessions(at = new Date().toISOString()): Promise<number> {
    const result = await this.database.query<{ count: string | number }>(
      "SELECT COUNT(*) AS count FROM sessions WHERE revoked_at IS NULL AND expires_at > $1",
      [at],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async listWorkflowStepRuns(workflowRunId: string): Promise<readonly WorkflowStepRun[]> {
    const result = await this.database.query<Row>(
      "SELECT * FROM workflow_step_runs WHERE workflow_run_id=$1 ORDER BY sequence",
      [workflowRunId],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      workflowRunId: String(row.workflow_run_id),
      stepKey: String(row.step_key),
      sequence: Number(row.sequence),
      status: row.status as WorkflowStepRun["status"],
      startedAt: iso(row.started_at),
      finishedAt: nullableIso(row.finished_at),
      result: row.result_json ? json(row.result_json, null) : null,
      error: row.error ? json(row.error, null) : null,
      retryCount: Number(row.retry_count),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      version: Number(row.version),
    }));
  }

  async record(event: AuditEventInput): Promise<AuditLog> {
    const id = randomUUID();
    const createdAt = event.createdAt ?? new Date().toISOString();
    const result = await this.database.query<Row>(
      `INSERT INTO audit_logs
       (id,event_type,action,outcome,actor_user_id,resource_type,resource_id,correlation_id,metadata,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING *`,
      [
        id,
        event.eventType,
        event.action,
        event.outcome,
        event.actorUserId ?? null,
        event.resourceType ?? null,
        event.resourceId ?? null,
        event.correlationId ?? null,
        JSON.stringify(event.metadata ?? {}),
        createdAt,
      ],
    );
    return mapAudit(result.rows[0] as Row);
  }

  async listAuditLogs(limit = 25): Promise<readonly AuditLog[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const result = await this.database.query<Row>(
      "SELECT * FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT $1",
      [safeLimit],
    );
    return result.rows.map(mapAudit);
  }

  async userHasPermission(userId: string, permissionKey: string): Promise<boolean> {
    const result = await this.database.query<{ granted: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM users u
         JOIN user_roles ur ON ur.user_id=u.id
         JOIN roles r ON r.id=ur.role_id AND r.status='active'
         JOIN role_permissions rp ON rp.role_id=r.id
         JOIN permissions p ON p.id=rp.permission_id AND p.status='active'
         WHERE u.id=$1 AND u.status='active' AND u.archived_at IS NULL AND p.key=$2
       ) AS granted`,
      [userId, permissionKey],
    );
    return result.rows[0]?.granted === true;
  }

  async listRoleGrantSummaries(): Promise<readonly RoleGrantSummary[]> {
    const result = await this.database.query<Row>(
      `SELECT r.key AS role_key, r.name AS role_name, COUNT(rp.permission_id) AS permission_count
       FROM roles r LEFT JOIN role_permissions rp ON rp.role_id=r.id
       WHERE r.status='active'
       GROUP BY r.id,r.key,r.name ORDER BY r.name`,
    );
    return result.rows.map((row) => ({
      roleId: row.role_key as RoleId,
      roleName: String(row.role_name),
      permissionCount: Number(row.permission_count),
    }));
  }

  async getFeatureFlag(key: string): Promise<FeatureFlag | null> {
    const result = await this.database.query<Row>("SELECT * FROM feature_flags WHERE key=$1", [
      key,
    ]);
    return result.rows[0] ? mapFeatureFlag(result.rows[0]) : null;
  }

  async listFeatureFlags(): Promise<readonly FeatureFlag[]> {
    const result = await this.database.query<Row>("SELECT * FROM feature_flags ORDER BY key");
    return result.rows.map(mapFeatureFlag);
  }

  async setFeatureFlag(
    key: string,
    enabled: boolean,
    actorUserId: string,
    updatedAt: string,
    expectedVersion?: number,
  ): Promise<FeatureFlag> {
    const result = await this.database.query<Row>(
      `UPDATE feature_flags SET enabled=$2, created_by_user_id=$3, updated_at=$4, version=version+1
       WHERE key=$1 AND ($5::integer IS NULL OR version=$5) RETURNING *`,
      [key, enabled, actorUserId, updatedAt, expectedVersion ?? null],
    );
    if (!result.rows[0]) throw new ConcurrentUpdateError("Feature flag", key);
    return mapFeatureFlag(result.rows[0]);
  }

  async getSystemSetting(key: string): Promise<SystemSetting | null> {
    const result = await this.database.query<Row>("SELECT * FROM system_settings WHERE key=$1", [
      key,
    ]);
    return result.rows[0] ? mapSystemSetting(result.rows[0]) : null;
  }

  async listSystemSettings(): Promise<readonly SystemSetting[]> {
    const result = await this.database.query<Row>("SELECT * FROM system_settings ORDER BY key");
    return result.rows.map(mapSystemSetting);
  }

  async setSystemSetting(
    key: string,
    value: JsonValue,
    actorUserId: string,
    updatedAt: string,
    expectedVersion?: number,
  ): Promise<SystemSetting> {
    const result = await this.database.query<Row>(
      `UPDATE system_settings SET value_json=$2::jsonb, created_by_user_id=$3, updated_at=$4, version=version+1
       WHERE key=$1 AND ($5::integer IS NULL OR version=$5) RETURNING *`,
      [key, JSON.stringify(value), actorUserId, updatedAt, expectedVersion ?? null],
    );
    if (!result.rows[0]) throw new ConcurrentUpdateError("System setting", key);
    return mapSystemSetting(result.rows[0]);
  }

  async listIntegrationConnections(): Promise<readonly IntegrationConnection[]> {
    const result = await this.database.query<Row>(
      "SELECT * FROM integration_connections ORDER BY display_name",
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      providerType: row.provider_type as IntegrationConnection["providerType"],
      displayName: String(row.display_name),
      mode: row.mode as IntegrationConnection["mode"],
      connectionStatus: row.connection_status as IntegrationConnection["connectionStatus"],
      requirementStatus: row.requirement_status as IntegrationConnection["requirementStatus"],
      configurationCompleteness: Number(row.configuration_completeness),
      requiredPermissions: json(row.required_permissions, []),
      externalIdentifier: row.external_identifier ? String(row.external_identifier) : null,
      lastHealthCheckAt: nullableIso(row.last_health_check_at),
      lastSuccessfulSyncAt: nullableIso(row.last_successful_sync_at),
      lastFailure: row.last_failure ? json(row.last_failure, null) : null,
      testMode: Boolean(row.test_mode),
      mockMode: Boolean(row.mock_mode),
      createdByUserId: row.created_by_user_id ? String(row.created_by_user_id) : null,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      version: Number(row.version),
    }));
  }

  async claimWorkflowRun(run: WorkflowRun): Promise<WorkflowRunClaim> {
    const result = await this.database.query<Row>(
      `INSERT INTO workflow_runs
       (id,workflow_key,status,trigger_metadata,correlation_id,idempotency_key,started_at,finished_at,error,retry_count,cancellation_requested,created_by_user_id,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
      [
        run.id,
        run.workflowKey,
        run.status,
        JSON.stringify(run.triggerMetadata),
        run.correlationId,
        run.idempotencyKey,
        run.startedAt,
        run.finishedAt,
        run.error ? JSON.stringify(run.error) : null,
        run.retryCount,
        run.cancellationRequested,
        run.createdByUserId,
        run.createdAt,
        run.updatedAt,
        run.version,
      ],
    );
    if (result.rows[0]) return { run: mapWorkflowRun(result.rows[0]), claimed: true };
    const existing = await this.getWorkflowRunByIdempotencyKey(run.idempotencyKey);
    if (!existing) throw new Error("Workflow idempotency claim failed without an existing run.");
    return { run: existing, claimed: false };
  }

  async saveWorkflowStepRun(step: WorkflowStepRun): Promise<void> {
    await this.database.query(
      `INSERT INTO workflow_step_runs
       (id,workflow_run_id,step_key,sequence,status,started_at,finished_at,result_json,error,retry_count,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13)
       ON CONFLICT (workflow_run_id,step_key) DO UPDATE SET status=EXCLUDED.status, finished_at=EXCLUDED.finished_at,
       result_json=EXCLUDED.result_json, error=EXCLUDED.error, retry_count=EXCLUDED.retry_count, updated_at=EXCLUDED.updated_at, version=workflow_step_runs.version+1`,
      [
        step.id,
        step.workflowRunId,
        step.stepKey,
        step.sequence,
        step.status,
        step.startedAt,
        step.finishedAt,
        step.result ? JSON.stringify(step.result) : null,
        step.error ? JSON.stringify(step.error) : null,
        step.retryCount,
        step.createdAt,
        step.updatedAt,
        step.version,
      ],
    );
  }

  async finishWorkflowRun(input: {
    id: string;
    status: WorkflowStatus;
    finishedAt: string;
    error: StructuredError | null;
    expectedVersion: number;
  }): Promise<WorkflowRun> {
    const result = await this.database.query<Row>(
      `UPDATE workflow_runs SET status=$2, finished_at=$3, error=$4::jsonb, updated_at=$3, version=version+1
       WHERE id=$1 AND version=$5 RETURNING *`,
      [
        input.id,
        input.status,
        input.finishedAt,
        input.error ? JSON.stringify(input.error) : null,
        input.expectedVersion,
      ],
    );
    if (!result.rows[0]) throw new ConcurrentUpdateError("Workflow run", input.id);
    return mapWorkflowRun(result.rows[0]);
  }

  async getWorkflowRunByIdempotencyKey(idempotencyKey: string): Promise<WorkflowRun | null> {
    const result = await this.database.query<Row>(
      "SELECT * FROM workflow_runs WHERE idempotency_key=$1",
      [idempotencyKey],
    );
    return result.rows[0] ? mapWorkflowRun(result.rows[0]) : null;
  }

  async getLatestWorkflowRun(workflowKey: string): Promise<WorkflowRun | null> {
    const result = await this.database.query<Row>(
      "SELECT * FROM workflow_runs WHERE workflow_key=$1 ORDER BY started_at DESC LIMIT 1",
      [workflowKey],
    );
    return result.rows[0] ? mapWorkflowRun(result.rows[0]) : null;
  }
}

export async function countRows(
  executor: SqlExecutor,
  table:
    | "users"
    | "roles"
    | "permissions"
    | "feature_flags"
    | "integration_connections"
    | "workflow_runs"
    | "audit_logs",
): Promise<number> {
  const result = await executor.query<{ count: string | number }>(
    `SELECT COUNT(*) AS count FROM ${table}`,
  );
  return Number(result.rows[0]?.count ?? 0);
}
