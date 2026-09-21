import { randomUUID } from "node:crypto";
import type { AuditEventInput, AuthenticationSession } from "@bea/domain";
import type { LocalOwnerAccountStore, LocalOwnerCredentialRecord } from "@bea/security";
import type { DatabaseAdapter, SqlExecutor } from "./adapter.js";

type Row = Record<string, unknown>;

const localOwnerLockClassId = 0x42454131;
const localOwnerLockObjectId = 0;

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function mapCredential(row: Row): LocalOwnerCredentialRecord {
  return {
    userId: String(row.user_id),
    username: String(row.username),
    passwordHash: String(row.password_hash),
    recoveryCodeHash: String(row.recovery_code_hash),
    failedAttempts: Number(row.failed_attempts),
    lockedUntil: nullableIso(row.locked_until),
    passwordChangedAt: iso(row.password_changed_at),
    version: Number(row.version),
  };
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

type MandatorySuccessAudit = AuditEventInput & { readonly createdAt: string };

function requireMandatorySuccessAudit(
  event: AuditEventInput | undefined,
  expected: {
    readonly eventType: string;
    readonly action: string;
    readonly userId: string;
    readonly occurredAt: string;
  },
): MandatorySuccessAudit {
  if (
    !event ||
    event.eventType !== expected.eventType ||
    event.action !== expected.action ||
    event.outcome !== "succeeded" ||
    event.actorUserId !== expected.userId ||
    event.resourceType !== "user" ||
    event.resourceId !== expected.userId ||
    event.createdAt !== expected.occurredAt
  ) {
    throw new Error("A valid mandatory Local Owner success audit event is required.");
  }
  return event as MandatorySuccessAudit;
}

async function insertMandatorySuccessAudit(
  transaction: SqlExecutor,
  event: MandatorySuccessAudit,
): Promise<void> {
  const inserted = await transaction.query<{ id: string }>(
    `INSERT INTO audit_logs
     (id,event_type,action,outcome,actor_user_id,resource_type,resource_id,correlation_id,metadata,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING id::text AS id`,
    [
      randomUUID(),
      event.eventType,
      event.action,
      event.outcome,
      event.actorUserId ?? null,
      event.resourceType ?? null,
      event.resourceId ?? null,
      event.correlationId ?? null,
      JSON.stringify(event.metadata ?? {}),
      event.createdAt,
    ],
  );
  if (inserted.rowCount !== 1) {
    throw new Error("The mandatory Local Owner success audit event was not persisted.");
  }
}

export class LocalOwnerAlreadyProvisionedError extends Error {
  readonly code = "LOCAL_OWNER_ALREADY_PROVISIONED";

  constructor() {
    super("A Local Owner identity is already provisioned.");
    this.name = "LocalOwnerAlreadyProvisionedError";
  }
}

export class LocalOwnerBootstrapNotEmptyError extends Error {
  readonly code = "LOCAL_OWNER_BOOTSTRAP_NOT_EMPTY";

  constructor() {
    super("Local Owner setup requires an empty identity and session store.");
    this.name = "LocalOwnerBootstrapNotEmptyError";
  }
}

export class SqlLocalOwnerAccountStore implements LocalOwnerAccountStore {
  readonly recordsSuccessAuditAtomically = true as const;

  constructor(private readonly database: DatabaseAdapter) {}

  async findCredentialByUsername(username: string): Promise<LocalOwnerCredentialRecord | null> {
    const result = await this.database.query<Row>(
      "SELECT * FROM local_owner_credentials WHERE username=$1",
      [username],
    );
    return result.rows[0] ? mapCredential(result.rows[0]) : null;
  }

  async provisionOwner(input: {
    readonly userId: string;
    readonly identityId: string;
    readonly username: string;
    readonly displayName: "Workspace Owner";
    readonly title: "Chief Executive Officer";
    readonly passwordHash: string;
    readonly recoveryCodeHash: string;
    readonly occurredAt: string;
    readonly successAudit?: AuditEventInput;
  }): Promise<void> {
    const successAudit = requireMandatorySuccessAudit(input.successAudit, {
      eventType: "authentication.local-owner-provisioned",
      action: "local-owner.provision",
      userId: input.userId,
      occurredAt: input.occurredAt,
    });
    await this.database.transaction(async (transaction) => {
      if (this.database.kind === "postgres") {
        await transaction.query("SELECT pg_advisory_xact_lock($1::integer,$2::integer)", [
          localOwnerLockClassId,
          localOwnerLockObjectId,
        ]);
      }
      const bootstrap = await transaction.query<{
        users: string | number;
        auth_identities: string | number;
        local_owner_credentials: string | number;
        sessions: string | number;
        user_roles: string | number;
        local_owners: string | number;
      }>(
        `SELECT
           (SELECT COUNT(*) FROM users) AS users,
           (SELECT COUNT(*) FROM auth_identities) AS auth_identities,
           (SELECT COUNT(*) FROM local_owner_credentials) AS local_owner_credentials,
           (SELECT COUNT(*) FROM sessions) AS sessions,
           (SELECT COUNT(*) FROM user_roles) AS user_roles,
           (SELECT COUNT(*) FROM auth_identities WHERE provider='local-owner') AS local_owners`,
      );
      const state = bootstrap.rows[0];
      if (Number(state?.local_owners ?? 0) !== 0) {
        throw new LocalOwnerAlreadyProvisionedError();
      }
      if (
        Number(state?.users ?? 0) !== 0 ||
        Number(state?.auth_identities ?? 0) !== 0 ||
        Number(state?.local_owner_credentials ?? 0) !== 0 ||
        Number(state?.sessions ?? 0) !== 0 ||
        Number(state?.user_roles ?? 0) !== 0
      ) {
        throw new LocalOwnerBootstrapNotEmptyError();
      }
      const ownerRole = await transaction.query<{ id: string }>(
        "SELECT id::text AS id FROM roles WHERE key='owner-admin' AND status='active'",
      );
      const roleId = ownerRole.rows[0]?.id;
      if (!roleId) {
        throw new Error("The production system seed must be applied before Local Owner setup.");
      }
      await transaction.query(
        `INSERT INTO users
         (id,persona_key,email,display_name,title,status,created_at,updated_at,version)
         VALUES ($1,NULL,NULL,$2,$3,'active',$4,$4,1)`,
        [input.userId, input.displayName, input.title, input.occurredAt],
      );
      await transaction.query(
        `INSERT INTO auth_identities
         (id,user_id,provider,subject,created_at,updated_at,version)
         VALUES ($1,$2,'local-owner',$3,$4,$4,1)`,
        [input.identityId, input.userId, input.username, input.occurredAt],
      );
      await transaction.query(
        `INSERT INTO local_owner_credentials
         (user_id,username,password_hash,recovery_code_hash,failed_attempts,locked_until,
          password_changed_at,created_at,updated_at,version)
         VALUES ($1,$2,$3,$4,0,NULL,$5,$5,$5,1)`,
        [
          input.userId,
          input.username,
          input.passwordHash,
          input.recoveryCodeHash,
          input.occurredAt,
        ],
      );
      await transaction.query(
        `INSERT INTO user_roles (user_id,role_id,created_at)
         VALUES ($1,$2,$3) ON CONFLICT (user_id,role_id) DO NOTHING`,
        [input.userId, roleId, input.occurredAt],
      );
      await insertMandatorySuccessAudit(transaction, successAudit);
    });
  }

  async recordFailedAttempt(input: {
    readonly userId: string;
    readonly occurredAt: string;
    readonly failureLimit: number;
    readonly lockoutUntil: string;
  }): Promise<LocalOwnerCredentialRecord | null> {
    const result = await this.database.query<Row>(
      `UPDATE local_owner_credentials
       SET failed_attempts =
             CASE WHEN locked_until IS NOT NULL AND locked_until <= $2::timestamptz THEN 1
                  ELSE failed_attempts + 1 END,
           locked_until =
             CASE WHEN (CASE WHEN locked_until IS NOT NULL
                                  AND locked_until <= $2::timestamptz THEN 1
                             ELSE failed_attempts + 1 END) >= $3
                  THEN $4::timestamptz ELSE NULL END,
           updated_at=$2::timestamptz,
           version=version+1
       WHERE user_id=$1
       RETURNING *`,
      [input.userId, input.occurredAt, input.failureLimit, input.lockoutUntil],
    );
    return result.rows[0] ? mapCredential(result.rows[0]) : null;
  }

  async rotateOwnerSession(input: {
    readonly userId: string;
    readonly session: AuthenticationSession;
    readonly occurredAt: string;
  }): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const credential = await transaction.query(
        `UPDATE local_owner_credentials
         SET failed_attempts=0,locked_until=NULL,updated_at=$2,version=version+1
         WHERE user_id=$1 RETURNING user_id`,
        [input.userId, input.occurredAt],
      );
      if (credential.rowCount !== 1) throw new Error("Local Owner credential is unavailable.");
      await transaction.query(
        `UPDATE sessions SET revoked_at=$2,updated_at=$2,version=version+1
         WHERE user_id=$1 AND revoked_at IS NULL`,
        [input.userId, input.occurredAt],
      );
      const session = input.session;
      await transaction.query(
        `INSERT INTO sessions
         (id,user_id,token_hash,expires_at,revoked_at,last_seen_at,created_at,updated_at,version)
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
    });
  }

  async completeRecovery(input: {
    readonly userId: string;
    readonly passwordHash: string;
    readonly recoveryCodeHash: string;
    readonly occurredAt: string;
    readonly successAudit?: AuditEventInput;
  }): Promise<void> {
    const successAudit = requireMandatorySuccessAudit(input.successAudit, {
      eventType: "authentication.recovered",
      action: "local-owner.recover",
      userId: input.userId,
      occurredAt: input.occurredAt,
    });
    await this.database.transaction(async (transaction) => {
      const updated = await transaction.query(
        `UPDATE local_owner_credentials
         SET password_hash=$2,recovery_code_hash=$3,failed_attempts=0,locked_until=NULL,
             password_changed_at=$4,updated_at=$4,version=version+1
         WHERE user_id=$1 RETURNING user_id`,
        [input.userId, input.passwordHash, input.recoveryCodeHash, input.occurredAt],
      );
      if (updated.rowCount !== 1) throw new Error("Local Owner credential is unavailable.");
      await transaction.query(
        `UPDATE sessions SET revoked_at=$2,updated_at=$2,version=version+1
         WHERE user_id=$1 AND revoked_at IS NULL`,
        [input.userId, input.occurredAt],
      );
      await insertMandatorySuccessAudit(transaction, successAudit);
    });
  }

  async findSessionByTokenHash(tokenHash: string): Promise<AuthenticationSession | null> {
    const result = await this.database.query<Row>("SELECT * FROM sessions WHERE token_hash=$1", [
      tokenHash,
    ]);
    return result.rows[0] ? mapSession(result.rows[0]) : null;
  }

  async revokeSession(sessionId: string, revokedAt: string): Promise<void> {
    await this.database.query(
      `UPDATE sessions SET revoked_at=$2,updated_at=$2,version=version+1
       WHERE id=$1 AND revoked_at IS NULL`,
      [sessionId, revokedAt],
    );
  }

  async touchSession(sessionId: string, seenAt: string): Promise<void> {
    await this.database.query(
      `UPDATE sessions SET last_seen_at=$2,updated_at=$2,version=version+1
       WHERE id=$1 AND revoked_at IS NULL AND expires_at>$2`,
      [sessionId, seenAt],
    );
  }
}
