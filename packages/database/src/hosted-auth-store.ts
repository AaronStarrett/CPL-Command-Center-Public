import { createHash, randomUUID } from "node:crypto";
import {
  CPL_HOSTED_OWNER_EMAIL,
  CPL_HOSTED_OWNER_DOMAIN,
  CPL_HOSTED_MFA_MAX_AGE_MS,
  CplHostedAuthenticationError,
  type CplHostedAuthStore,
  type CplHostedSession,
  type CplHostedSessionMaterial,
  type CplHostedOAuthFlow,
  type CplHostedCredential,
} from "@bea/security/hosted";
import type { DatabaseAdapter, SqlExecutor } from "./adapter.js";

type Row = Record<string, unknown>;
function fail(code = "CPL_AUTHENTICATION_REQUIRED", status = 401): never {
  throw new CplHostedAuthenticationError(code, status);
}
function hash(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) fail();
  return value;
}
function time(value: unknown): number {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(parsed)) fail();
  return parsed;
}
function iso(value: unknown): string {
  return new Date(time(value)).toISOString();
}
function validateMaterial(material: CplHostedSessionMaterial, now: string, absolute?: unknown) {
  hash(material.tokenHash);
  hash(material.csrfTokenHash);
  const current = time(now),
    expires = time(material.expiresAt),
    cap = time(material.absoluteExpiresAt);
  if (
    expires <= current ||
    expires > current + 60 * 60_000 ||
    cap < expires ||
    cap > current + 8 * 60 * 60_000 ||
    (absolute !== undefined && cap !== time(absolute))
  )
    fail();
}
function credential(row: Row): CplHostedCredential {
  return {
    id: String(row.id),
    publicKey: String(row.public_key),
    counter: Number(row.counter),
    transports: row.transports_json as string[],
    deviceType: row.device_type as CplHostedCredential["deviceType"],
    backedUp: row.backed_up === true,
  };
}

/** Only the cryptographically validating hosted authentication service calls this
 * store. Identity, session and credential state are revalidated under transaction locks. */
export class SqlCplHostedAuthStore implements CplHostedAuthStore {
  constructor(private readonly database: DatabaseAdapter) {}
  private async audit(
    executor: SqlExecutor,
    identityId: unknown,
    sessionId: unknown,
    action: string,
  ) {
    await executor.query(
      "INSERT INTO cpl_auth_audit_events (id,identity_id,session_id,action) VALUES ($1,$2,$3,$4)",
      [randomUUID(), identityId, sessionId, action],
    );
  }
  private async sessionRow(
    executor: SqlExecutor,
    tokenHash: string,
    now: string,
    lock = false,
  ): Promise<Row | null> {
    const result = await executor.query<Row>(
      `SELECT s.*,i.issuer,i.subject,i.email,i.email_verified,i.hosted_domain,i.display_name,
      EXISTS (SELECT 1 FROM cpl_platform_administrators a WHERE a.identity_id=i.id AND a.status='active') AS platform_administrator
      FROM cpl_sessions s JOIN cpl_identities i ON i.id=s.identity_id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>$2 AND s.absolute_expires_at>$2
        AND s.csrf_token_hash IS NOT NULL AND i.status='active' AND i.email_verified=TRUE
      ${lock ? "FOR UPDATE OF s,i" : ""}`,
      [hash(tokenHash), now],
    );
    return result.rows[0] ?? null;
  }
  private async representation(executor: SqlExecutor, row: Row): Promise<CplHostedSession> {
    let organizationId =
      row.selected_organization_id == null ? null : String(row.selected_organization_id);
    if (organizationId) {
      await executor.query(
        "SELECT set_config('cpl.organization_id',$1,true),set_config('cpl.identity_id',$2,true)",
        [organizationId, row.identity_id],
      );
      const member = await executor.query(
        "SELECT m.identity_id FROM cpl_memberships m JOIN cpl_organizations o ON o.id=m.organization_id WHERE m.organization_id=$1 AND m.identity_id=$2 AND m.status='active' AND o.status='active'",
        [organizationId, row.identity_id],
      );
      if (!member.rows[0]) organizationId = null;
    }
    return {
      id: String(row.id),
      identityId: String(row.identity_id),
      issuer: String(row.issuer),
      subject: String(row.subject),
      email: String(row.email),
      displayName: String(row.display_name),
      createdAt: iso(row.created_at),
      authenticatedAt: iso(row.authenticated_at),
      expiresAt: iso(row.expires_at),
      absoluteExpiresAt: iso(row.absolute_expires_at),
      mfaVerifiedAt: row.mfa_verified_at == null ? null : iso(row.mfa_verified_at),
      selectedOrganizationId: organizationId,
      csrfTokenHash: String(row.csrf_token_hash),
      platformAdministrator: row.platform_administrator === true,
    };
  }
  async createOAuthFlow(flow: CplHostedOAuthFlow): Promise<void> {
    if (
      flow.returnTo !== "/workspace" ||
      !/^[A-Za-z0-9_-]{43,128}$/u.test(flow.nonce) ||
      !/^[A-Za-z0-9_-]{43,128}$/u.test(flow.pkceVerifier)
    )
      fail("CPL_OAUTH_STATE_REJECTED");
    await this.database.query(
      "INSERT INTO cpl_oauth_flows (browser_binding_hash,state_hash,nonce,pkce_verifier,return_to,expires_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [
        hash(flow.browserBindingHash),
        hash(flow.stateHash),
        flow.nonce,
        flow.pkceVerifier,
        flow.returnTo,
        iso(flow.expiresAt),
      ],
    );
  }
  async consumeOAuthFlow(
    input: Parameters<CplHostedAuthStore["consumeOAuthFlow"]>[0],
  ): Promise<CplHostedOAuthFlow | null> {
    const result = await this.database.query<Row>(
      "DELETE FROM cpl_oauth_flows WHERE browser_binding_hash=$1 AND state_hash=$2 AND expires_at>$3 RETURNING *",
      [hash(input.browserBindingHash), hash(input.stateHash), iso(input.now)],
    );
    const row = result.rows[0];
    return row
      ? {
          browserBindingHash: String(row.browser_binding_hash),
          stateHash: String(row.state_hash),
          nonce: String(row.nonce),
          pkceVerifier: String(row.pkce_verifier),
          returnTo: String(row.return_to),
          expiresAt: iso(row.expires_at),
        }
      : null;
  }
  async createSession(
    input: Parameters<CplHostedAuthStore["createSession"]>[0],
  ): Promise<CplHostedSession> {
    validateMaterial(input.material, input.now);
    const identity = input.identity;
    if (
      identity.issuer !== "https://accounts.google.com" ||
      identity.emailVerified !== true ||
      !identity.subject ||
      identity.subject.length > 1000 ||
      !identity.email ||
      identity.email.length > 254 ||
      !identity.displayName ||
      identity.displayName.length > 240 ||
      time(identity.authenticatedAt) > time(input.now) + 30_000 ||
      time(identity.expiresAt) <= time(input.now)
    )
      fail("CPL_OIDC_ASSERTION_REJECTED");
    return this.database.transaction(async (executor) => {
      const identityResult = await executor.query<Row>(
        `INSERT INTO cpl_identities (id,issuer,subject,display_name,email,email_verified,hosted_domain)
        VALUES ($1,$2,$3,$4,$5,TRUE,$6) ON CONFLICT (issuer,subject) DO UPDATE SET display_name=EXCLUDED.display_name,email=EXCLUDED.email,email_verified=TRUE,hosted_domain=EXCLUDED.hosted_domain RETURNING id,status`,
        [
          randomUUID(),
          identity.issuer,
          identity.subject,
          identity.displayName,
          identity.email.toLowerCase(),
          identity.hostedDomain?.toLowerCase() ?? null,
        ],
      );
      const stored = identityResult.rows[0];
      if (!stored || stored.status !== "active") fail();
      if (
        identity.email.toLowerCase() !== CPL_HOSTED_OWNER_EMAIL ||
        identity.hostedDomain?.toLowerCase() !== CPL_HOSTED_OWNER_DOMAIN
      ) {
        const changed = await executor.query(
          "UPDATE cpl_platform_administrators SET status='suspended' WHERE identity_id=$1 AND status='active' AND EXISTS (SELECT 1 FROM cpl_platform_owner_binding WHERE identity_id=$1)",
          [stored.id],
        );
        if (changed.rowCount) await this.audit(executor, stored.id, null, "owner.claims-changed");
      }
      await executor.query(
        "INSERT INTO cpl_sessions (id,identity_id,token_hash,authenticated_at,mfa_verified,expires_at,csrf_token_hash,absolute_expires_at,created_at) VALUES ($1,$2,$3,$4,FALSE,$5,$6,$7,$8)",
        [
          randomUUID(),
          stored.id,
          input.material.tokenHash,
          identity.authenticatedAt,
          input.material.expiresAt,
          input.material.csrfTokenHash,
          input.material.absoluteExpiresAt,
          input.now,
        ],
      );
      const row = await this.sessionRow(executor, input.material.tokenHash, input.now);
      if (!row) fail();
      await this.audit(executor, row.identity_id, row.id, "session.created");
      return this.representation(executor, row);
    });
  }
  async readSession(tokenHash: string, now: string): Promise<CplHostedSession | null> {
    return this.database.transaction(async (executor) => {
      const row = await this.sessionRow(executor, tokenHash, iso(now));
      return row ? this.representation(executor, row) : null;
    });
  }
  async readSessionWithPasskey(tokenHash: string, now: string) {
    return this.database.transaction(async (executor) => {
      const row = await this.sessionRow(executor, tokenHash, iso(now));
      if (!row) return null;
      const session = await this.representation(executor, row);
      const result = await executor.query<{ has_passkey: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM cpl_webauthn_credentials c JOIN cpl_identities i ON i.id=c.identity_id WHERE c.identity_id=$1 AND i.status='active') AS has_passkey",
        [session.identityId],
      );
      if (result.rows.length !== 1 || typeof result.rows[0]?.has_passkey !== "boolean") fail();
      return { session, hasPasskey: result.rows[0].has_passkey };
    });
  }
  private async rotate(
    executor: SqlExecutor,
    row: Row,
    material: CplHostedSessionMaterial,
    now: string,
    mfaAt?: string,
  ): Promise<CplHostedSession> {
    validateMaterial(material, now, row.absolute_expires_at);
    if (material.tokenHash === row.token_hash || material.csrfTokenHash === row.csrf_token_hash)
      fail();
    await executor.query("UPDATE cpl_sessions SET revoked_at=$2 WHERE id=$1", [row.id, now]);
    await executor.query(
      "INSERT INTO cpl_sessions (id,identity_id,token_hash,authenticated_at,mfa_verified,expires_at,csrf_token_hash,absolute_expires_at,mfa_verified_at,selected_organization_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [
        randomUUID(),
        row.identity_id,
        material.tokenHash,
        row.authenticated_at,
        mfaAt !== undefined || row.mfa_verified === true,
        material.expiresAt,
        material.csrfTokenHash,
        material.absoluteExpiresAt,
        mfaAt ?? row.mfa_verified_at,
        row.selected_organization_id,
        row.created_at,
      ],
    );
    const next = await this.sessionRow(executor, material.tokenHash, now);
    if (!next) fail();
    return this.representation(executor, next);
  }
  async rotateSession(
    input: Parameters<CplHostedAuthStore["rotateSession"]>[0],
  ): Promise<CplHostedSession> {
    return this.database.transaction(async (executor) => {
      const row = await this.sessionRow(executor, input.tokenHash, input.now, true);
      if (!row) fail();
      await this.audit(executor, row.identity_id, row.id, "session.rotated");
      return this.rotate(executor, row, input.material, input.now);
    });
  }
  async revokeSession(tokenHash: string, now: string, allSessions = false): Promise<void> {
    await this.database.transaction(async (executor) => {
      const row = await this.sessionRow(executor, tokenHash, now, true);
      if (!row) return;
      await executor.query(
        allSessions
          ? "UPDATE cpl_sessions SET revoked_at=$2 WHERE identity_id=$1 AND revoked_at IS NULL"
          : "UPDATE cpl_sessions SET revoked_at=$2 WHERE id=$1 AND revoked_at IS NULL",
        [allSessions ? row.identity_id : row.id, now],
      );
      await this.audit(
        executor,
        row.identity_id,
        row.id,
        allSessions ? "session.all-revoked" : "session.revoked",
      );
    });
  }
  async selectOrganization(tokenHash: string, organizationId: string, now: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/u.test(organizationId)) fail("CPL_ORGANIZATION_ACCESS_DENIED", 403);
    await this.database.transaction(async (executor) => {
      const row = await this.sessionRow(executor, tokenHash, now, true);
      if (!row) fail();
      await executor.query(
        "SELECT set_config('cpl.organization_id',$1,true),set_config('cpl.identity_id',$2,true)",
        [organizationId, row.identity_id],
      );
      const member = await executor.query(
        "SELECT m.identity_id FROM cpl_memberships m JOIN cpl_organizations o ON o.id=m.organization_id WHERE m.organization_id=$1 AND m.identity_id=$2 AND m.status='active' AND o.status='active' FOR SHARE OF m,o",
        [organizationId, row.identity_id],
      );
      if (!member.rows[0]) fail("CPL_ORGANIZATION_ACCESS_DENIED", 403);
      await executor.query("UPDATE cpl_sessions SET selected_organization_id=$2 WHERE id=$1", [
        row.id,
        organizationId,
      ]);
    });
  }
  async listCredentials(identityId: string): Promise<readonly CplHostedCredential[]> {
    return (
      await this.database.query<Row>(
        "SELECT c.* FROM cpl_webauthn_credentials c JOIN cpl_identities i ON i.id=c.identity_id WHERE c.identity_id=$1 AND i.status='active' ORDER BY c.created_at,c.id",
        [identityId],
      )
    ).rows.map(credential);
  }
  async createChallenge(
    input: Parameters<CplHostedAuthStore["createChallenge"]>[0],
  ): Promise<void> {
    if (
      !/^[A-Za-z0-9_-]{20,256}$/u.test(input.challenge) ||
      !["registration", "authentication"].includes(input.kind)
    )
      fail();
    const result = await this.database.query(
      "INSERT INTO cpl_webauthn_challenges (ceremony_token_hash,session_id,kind,challenge,expires_at) SELECT $1,s.id,$3,$4,$5 FROM cpl_sessions s JOIN cpl_identities i ON i.id=s.identity_id WHERE s.id=$2 AND s.revoked_at IS NULL AND s.expires_at>CURRENT_TIMESTAMP AND s.absolute_expires_at>CURRENT_TIMESTAMP AND i.status='active'",
      [
        hash(input.ceremonyTokenHash),
        input.sessionId,
        input.kind,
        input.challenge,
        iso(input.expiresAt),
      ],
    );
    if (result.rowCount !== 1) fail();
  }
  async consumeChallenge(
    input: Parameters<CplHostedAuthStore["consumeChallenge"]>[0],
  ): Promise<{ challenge: string } | null> {
    const result = await this.database.query<Row>(
      "DELETE FROM cpl_webauthn_challenges c USING cpl_sessions s,cpl_identities i WHERE c.ceremony_token_hash=$1 AND c.session_id=$2 AND c.kind=$3 AND c.expires_at>$4 AND s.id=c.session_id AND i.id=s.identity_id AND s.revoked_at IS NULL AND s.expires_at>$4 AND s.absolute_expires_at>$4 AND i.status='active' RETURNING c.challenge",
      [hash(input.ceremonyTokenHash), input.sessionId, input.kind, iso(input.now)],
    );
    return result.rows[0] ? { challenge: String(result.rows[0].challenge) } : null;
  }
  private async provisionOwner(executor: SqlExecutor, row: Row): Promise<void> {
    if (
      row.email_verified !== true ||
      String(row.email).toLowerCase() !== CPL_HOSTED_OWNER_EMAIL ||
      row.hosted_domain !== CPL_HOSTED_OWNER_DOMAIN ||
      row.issuer !== "https://accounts.google.com"
    )
      return;
    const bound = await executor.query(
      "INSERT INTO cpl_platform_owner_binding (singleton,identity_id,issuer,subject) VALUES (TRUE,$1,$2,$3) ON CONFLICT (singleton) DO NOTHING",
      [row.identity_id, row.issuer, row.subject],
    );
    if (bound.rowCount) await this.audit(executor, row.identity_id, row.id, "owner.bound");
    await executor.query(
      "INSERT INTO cpl_platform_administrators (identity_id,status) SELECT $1,'active' FROM cpl_platform_owner_binding WHERE singleton=TRUE AND identity_id=$1 AND issuer=$2 AND subject=$3 ON CONFLICT DO NOTHING",
      [row.identity_id, row.issuer, row.subject],
    );
  }
  async completeRegistration(
    input: Parameters<CplHostedAuthStore["completeRegistration"]>[0],
  ): Promise<CplHostedSession> {
    const supplied = input.credential;
    if (
      !/^[A-Za-z0-9_-]{1,1400}$/u.test(supplied.id) ||
      !/^[A-Za-z0-9_-]{1,10000}$/u.test(supplied.publicKey) ||
      !Number.isSafeInteger(supplied.counter) ||
      supplied.counter < 0 ||
      !["singleDevice", "multiDevice"].includes(supplied.deviceType) ||
      typeof supplied.backedUp !== "boolean" ||
      !Array.isArray(supplied.transports) ||
      supplied.transports.length > 8 ||
      supplied.transports.some((item) => typeof item !== "string" || item.length > 40)
    )
      fail("CPL_PASSKEY_REJECTED", 403);
    return this.database.transaction(async (executor) => {
      const row = await this.sessionRow(executor, input.tokenHash, input.now, true);
      if (!row) fail();
      const existing = await executor.query(
        "SELECT id FROM cpl_webauthn_credentials WHERE identity_id=$1 LIMIT 1",
        [row.identity_id],
      );
      if (
        !existing.rows[0] &&
        (time(input.now) - time(row.created_at) > 5 * 60_000 ||
          time(row.created_at) > time(input.now))
      )
        fail("CPL_FRESH_SIGN_IN_REQUIRED", 403);
      if (
        existing.rows[0] &&
        (row.mfa_verified_at == null ||
          time(input.now) - time(row.mfa_verified_at) > CPL_HOSTED_MFA_MAX_AGE_MS ||
          time(row.mfa_verified_at) > time(input.now))
      )
        fail("CPL_MFA_REQUIRED", 403);
      await executor.query(
        "INSERT INTO cpl_webauthn_credentials (id,identity_id,public_key,counter,transports_json,device_type,backed_up) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)",
        [
          supplied.id,
          row.identity_id,
          supplied.publicKey,
          supplied.counter,
          JSON.stringify(supplied.transports),
          supplied.deviceType,
          supplied.backedUp,
        ],
      );
      // Enrollment alone is not signed possession proof. A subsequent verified
      // authentication assertion sets MFA and may provision the bound owner.
      await this.audit(executor, row.identity_id, row.id, "passkey.registered");
      return this.rotate(executor, row, input.material, input.now);
    });
  }
  async completeAuthentication(
    input: Parameters<CplHostedAuthStore["completeAuthentication"]>[0],
  ): Promise<CplHostedSession> {
    if (
      !Number.isSafeInteger(input.previousCounter) ||
      !Number.isSafeInteger(input.newCounter) ||
      input.previousCounter < 0 ||
      input.newCounter < 0 ||
      ((input.previousCounter !== 0 || input.newCounter !== 0) &&
        input.newCounter <= input.previousCounter)
    )
      fail("CPL_PASSKEY_REJECTED", 403);
    return this.database.transaction(async (executor) => {
      const row = await this.sessionRow(executor, input.tokenHash, input.now, true);
      if (!row) fail();
      const updated = await executor.query(
        "UPDATE cpl_webauthn_credentials SET counter=$4 WHERE id=$1 AND identity_id=$2 AND counter=$3 RETURNING id",
        [input.credentialId, row.identity_id, input.previousCounter, input.newCounter],
      );
      if (!updated.rows[0]) fail("CPL_PASSKEY_REJECTED", 403);
      await this.provisionOwner(executor, row);
      await this.audit(executor, row.identity_id, row.id, "passkey.authenticated");
      return this.rotate(executor, row, input.material, input.now, input.now);
    });
  }
  async consumeRateLimit(
    input: Parameters<CplHostedAuthStore["consumeRateLimit"]>[0],
  ): Promise<boolean> {
    if (
      !input.key ||
      input.key.length > 500 ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 1000 ||
      !Number.isSafeInteger(input.windowSeconds) ||
      input.windowSeconds < 1 ||
      input.windowSeconds > 3600
    )
      fail("CPL_INVALID_AUTH_LIMIT", 503);
    const key = createHash("sha256").update(input.key).digest("hex");
    const expires = new Date(time(input.now) + input.windowSeconds * 1000).toISOString();
    return this.database.transaction(async (executor) => {
      for (const table of ["cpl_auth_rate_limits", "cpl_oauth_flows", "cpl_webauthn_challenges"]) {
        const column =
          table === "cpl_auth_rate_limits"
            ? "key_hash"
            : table === "cpl_oauth_flows"
              ? "state_hash"
              : "ceremony_token_hash";
        await executor.query(
          `DELETE FROM ${table} WHERE ${column} IN (SELECT ${column} FROM ${table} WHERE expires_at<$1 ORDER BY expires_at LIMIT 100)`,
          [input.now],
        );
      }
      const result = await executor.query<Row>(
        "INSERT INTO cpl_auth_rate_limits (key_hash,count,expires_at) VALUES ($1,1,$3) ON CONFLICT (key_hash) DO UPDATE SET count=CASE WHEN cpl_auth_rate_limits.expires_at<=$2 THEN 1 ELSE LEAST(cpl_auth_rate_limits.count+1,1000000) END,expires_at=CASE WHEN cpl_auth_rate_limits.expires_at<=$2 THEN $3 ELSE cpl_auth_rate_limits.expires_at END RETURNING count",
        [key, input.now, expires],
      );
      return Number(result.rows[0]?.count) <= input.limit;
    });
  }
}
