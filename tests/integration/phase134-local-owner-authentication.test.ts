import { afterEach, describe, expect, it } from "vitest";
import {
  type DatabaseAdapter,
  PGliteDatabaseAdapter,
  type SqlExecutor,
  SqlFoundationRepository,
  SqlLocalOwnerAccountStore,
  migrateDatabase,
  seedSystemDatabase,
} from "../../packages/database/src/index.js";
import {
  LOCAL_OWNER_SESSION_COOKIE,
  type LocalOwnerAccountStore,
  LocalOwnerAuthenticationAdapter,
  LocalOwnerAuthenticationError,
} from "../../packages/security/src/index.js";
import type { AuditEventInput, AuditSink, UserDirectory } from "../../packages/domain/src/index.js";
import { FixedClock } from "../../packages/testing/src/index.js";

let database: PGliteDatabaseAdapter | undefined;

const sessionSecret = "phase134-local-owner-test-secret-".padEnd(80, "x");
const forcedAuditFailure = "Forced Phase 1.3.4 success audit insertion failure.";

class AuditWriteRejectingExecutor implements SqlExecutor {
  constructor(private readonly delegate: SqlExecutor) {}

  async query<Row extends Record<string, unknown>>(
    sql: string,
    parameters: readonly unknown[] = [],
  ) {
    if (/\bINSERT\s+INTO\s+audit_logs\b/iu.test(sql)) throw new Error(forcedAuditFailure);
    return this.delegate.query<Row>(sql, parameters);
  }

  execute(sql: string): Promise<void> {
    return this.delegate.execute(sql);
  }
}

class AuditWriteRejectingDatabase implements DatabaseAdapter {
  readonly kind: DatabaseAdapter["kind"];

  constructor(private readonly delegate: DatabaseAdapter) {
    this.kind = delegate.kind;
  }

  query<Row extends Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []) {
    return this.delegate.query<Row>(sql, parameters);
  }

  execute(sql: string): Promise<void> {
    return this.delegate.execute(sql);
  }

  transaction<T>(operation: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
    return this.delegate.transaction((transaction) =>
      operation(new AuditWriteRejectingExecutor(transaction)),
    );
  }

  health() {
    return this.delegate.health();
  }

  async close(): Promise<void> {
    // The owning test closes the delegated database.
  }
}

afterEach(async () => {
  await database?.close();
  database = undefined;
});

describe("Phase 1.3.4 Local Owner authentication", () => {
  it("provisions one owner without email, locks failures, recovers once, and rotates secure sessions", async () => {
    database = new PGliteDatabaseAdapter("memory://");
    await migrateDatabase(database);
    await seedSystemDatabase(database);
    const repository = new SqlFoundationRepository(database);
    const accounts = new SqlLocalOwnerAccountStore(database);
    const authentication = new LocalOwnerAuthenticationAdapter(
      {
        deploymentProfile: "local-live",
        sessionSecret,
        sessionTtlMinutes: 60,
        failureLimit: 3,
        lockoutMinutes: 15,
      },
      repository,
      accounts,
      repository,
      new FixedClock("2026-08-24T12:00:00.000Z"),
    );
    const originalPassword = "Correct horse battery staple 2026!";
    const replacementPassword = "Replacement passphrase for Local Owner 2026!";
    const provisioned = await authentication.provisionOwner("Owner.Owner", originalPassword);

    expect(provisioned).toMatchObject({
      username: "owner.owner",
      displayName: "Workspace Owner",
      title: "Chief Executive Officer",
    });
    expect(provisioned.passwordHash).not.toContain(originalPassword);
    expect(provisioned.recoveryCodeHash).not.toContain(provisioned.recoveryCode);
    await expect(
      authentication.provisionOwner("second.owner", "A second valid passphrase 2026!"),
    ).rejects.toMatchObject({ code: "LOCAL_OWNER_ALREADY_PROVISIONED" });

    const storedUser = await database.query<{
      email: string | null;
      persona_key: string | null;
      display_name: string;
      title: string;
    }>("SELECT email,persona_key,display_name,title FROM users WHERE id=$1", [provisioned.userId]);
    expect(storedUser.rows[0]).toEqual({
      email: null,
      persona_key: null,
      display_name: "Workspace Owner",
      title: "Chief Executive Officer",
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        authentication.signIn("owner.owner", "Incorrect passphrase", "lockout-test"),
      ).rejects.toBeInstanceOf(LocalOwnerAuthenticationError);
    }
    await expect(
      authentication.signIn("owner.owner", originalPassword, "locked-correct-password"),
    ).rejects.toBeInstanceOf(LocalOwnerAuthenticationError);
    await expect(accounts.findCredentialByUsername("owner.owner")).resolves.toMatchObject({
      failedAttempts: 3,
      lockedUntil: "2026-08-24T12:15:00.000Z",
    });

    const recovery = await authentication.recoverOwner(
      "owner.owner",
      provisioned.recoveryCode,
      replacementPassword,
      "owner-recovery",
    );
    expect(recovery.recoveryCode).not.toBe(provisioned.recoveryCode);
    await expect(
      authentication.recoverOwner(
        "owner.owner",
        provisioned.recoveryCode,
        "Another replacement passphrase 2026!",
      ),
    ).rejects.toBeInstanceOf(LocalOwnerAuthenticationError);

    const first = await authentication.signIn("owner.owner", replacementPassword, "first-session");
    expect(first.cookie).toEqual({
      name: LOCAL_OWNER_SESSION_COOKIE,
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAgeSeconds: 3_600,
    });
    expect(first.user).toMatchObject({
      displayName: "Workspace Owner",
      email: "",
      roleIds: ["owner-admin"],
    });
    await expect(authentication.readSession(first.sessionToken)).resolves.toMatchObject({
      user: { id: provisioned.userId },
    });

    const second = await authentication.signIn(
      "owner.owner",
      replacementPassword,
      "rotated-session",
    );
    await expect(authentication.readSession(first.sessionToken)).resolves.toBeNull();
    await expect(authentication.signOut(second.sessionToken, "sign-out")).resolves.toBe(true);
    await expect(authentication.readSession(second.sessionToken)).resolves.toBeNull();

    const audits = await repository.listAuditLogs(50);
    expect(audits.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "authentication.local-owner-provisioned",
        "authentication.sign-in-denied",
        "authentication.recovered",
        "authentication.signed-in",
        "authentication.signed-out",
      ]),
    );
    expect(
      audits.filter((event) => event.eventType === "authentication.local-owner-provisioned"),
    ).toHaveLength(1);
    expect(audits.filter((event) => event.eventType === "authentication.recovered")).toHaveLength(
      1,
    );
  }, 60_000);

  it("rolls back owner identity creation when its mandatory success audit cannot be inserted", async () => {
    database = new PGliteDatabaseAdapter("memory://");
    await migrateDatabase(database);
    await seedSystemDatabase(database);
    const repository = new SqlFoundationRepository(database);
    const authentication = new LocalOwnerAuthenticationAdapter(
      {
        deploymentProfile: "local-live",
        sessionSecret,
        sessionTtlMinutes: 60,
      },
      repository,
      new SqlLocalOwnerAccountStore(new AuditWriteRejectingDatabase(database)),
      repository,
      new FixedClock("2026-08-24T12:00:00.000Z"),
    );

    await expect(
      authentication.provisionOwner("owner.owner", "Valid rollback passphrase 2026!"),
    ).rejects.toThrow(forcedAuditFailure);

    const state = await database.query<{
      users: string | number;
      identities: string | number;
      credentials: string | number;
      roles: string | number;
      audits: string | number;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM users) AS users,
         (SELECT COUNT(*) FROM auth_identities) AS identities,
         (SELECT COUNT(*) FROM local_owner_credentials) AS credentials,
         (SELECT COUNT(*) FROM user_roles) AS roles,
         (SELECT COUNT(*) FROM audit_logs
           WHERE event_type='authentication.local-owner-provisioned') AS audits`,
    );
    expect(state.rows[0]).toEqual({
      users: 0,
      identities: 0,
      credentials: 0,
      roles: 0,
      audits: 0,
    });
  }, 60_000);

  it("rolls back password, recovery-code, and session rotation when recovery audit insertion fails", async () => {
    database = new PGliteDatabaseAdapter("memory://");
    await migrateDatabase(database);
    await seedSystemDatabase(database);
    const repository = new SqlFoundationRepository(database);
    const accounts = new SqlLocalOwnerAccountStore(database);
    const clock = new FixedClock("2026-08-24T12:00:00.000Z");
    const authentication = new LocalOwnerAuthenticationAdapter(
      { deploymentProfile: "local-live", sessionSecret, sessionTtlMinutes: 60 },
      repository,
      accounts,
      repository,
      clock,
    );
    const provisioned = await authentication.provisionOwner(
      "owner.owner",
      "Original rollback passphrase 2026!",
    );
    const signedIn = await authentication.signIn(
      "owner.owner",
      "Original rollback passphrase 2026!",
    );
    const before = await database.query<{
      password_hash: string;
      recovery_code_hash: string;
      version: number;
    }>("SELECT password_hash,recovery_code_hash,version FROM local_owner_credentials");

    const recoveryWithRejectedAudit = new LocalOwnerAuthenticationAdapter(
      { deploymentProfile: "local-live", sessionSecret, sessionTtlMinutes: 60 },
      repository,
      new SqlLocalOwnerAccountStore(new AuditWriteRejectingDatabase(database)),
      repository,
      clock,
    );
    await expect(
      recoveryWithRejectedAudit.recoverOwner(
        "owner.owner",
        provisioned.recoveryCode,
        "Replacement rollback passphrase 2026!",
      ),
    ).rejects.toThrow(forcedAuditFailure);

    const after = await database.query<{
      password_hash: string;
      recovery_code_hash: string;
      version: number;
    }>("SELECT password_hash,recovery_code_hash,version FROM local_owner_credentials");
    expect(after.rows[0]).toEqual(before.rows[0]);
    await expect(authentication.readSession(signedIn.sessionToken)).resolves.toMatchObject({
      user: { id: provisioned.userId },
    });
    const recoveryAudits = await database.query<{ count: string | number }>(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE event_type='authentication.recovered'",
    );
    expect(Number(recoveryAudits.rows[0]?.count ?? -1)).toBe(0);
  }, 60_000);

  it("keeps non-SQL account stores viable by recording their success audit through the sink", async () => {
    let receivedStoreAudit: AuditEventInput | undefined;
    const recordedAudits: AuditEventInput[] = [];
    const accounts: LocalOwnerAccountStore = {
      findCredentialByUsername: async () => null,
      provisionOwner: async (input) => {
        receivedStoreAudit = input.successAudit;
      },
      recordFailedAttempt: async () => null,
      rotateOwnerSession: async () => undefined,
      completeRecovery: async () => undefined,
      findSessionByTokenHash: async () => null,
      revokeSession: async () => undefined,
      touchSession: async () => undefined,
    };
    const users: UserDirectory = {
      findActiveUserByPersonaKey: async () => null,
      findActiveUserById: async () => null,
    };
    const audit: AuditSink = {
      record: async (event) => {
        recordedAudits.push(event);
        return {
          id: "00000000-0000-4000-8000-000000000001",
          eventType: event.eventType,
          action: event.action,
          outcome: event.outcome,
          actorUserId: event.actorUserId ?? null,
          resourceType: event.resourceType ?? null,
          resourceId: event.resourceId ?? null,
          correlationId: event.correlationId ?? null,
          metadata: event.metadata ?? {},
          createdAt: event.createdAt ?? "2026-08-24T12:00:00.000Z",
        };
      },
    };
    const authentication = new LocalOwnerAuthenticationAdapter(
      { deploymentProfile: "local-live", sessionSecret, sessionTtlMinutes: 60 },
      users,
      accounts,
      audit,
      new FixedClock("2026-08-24T12:00:00.000Z"),
    );

    await expect(
      authentication.provisionOwner("owner.owner", "Non SQL adapter passphrase 2026!"),
    ).resolves.toMatchObject({ username: "owner.owner" });
    expect(receivedStoreAudit).toMatchObject({
      eventType: "authentication.local-owner-provisioned",
      outcome: "succeeded",
    });
    expect(recordedAudits).toHaveLength(1);
    expect(recordedAudits[0]).toBe(receivedStoreAudit);
  }, 60_000);
});
