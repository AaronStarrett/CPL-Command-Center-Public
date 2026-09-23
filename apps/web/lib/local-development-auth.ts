import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import {
  PgDatabaseAdapter,
  SqlCplHostedAuthStore,
  SqlCplTenantRepository,
  verifyHostedDatabaseRole,
  type DatabaseAdapter,
} from "@bea/database/hosted";
import {
  CplHostedAuthService,
  CplHostedAuthenticationError,
  assertLocalDevelopmentRequest,
  readLocalDevelopmentConfiguration,
  hostedTokenHash,
  CPL_LOCAL_DATABASE_NAME,
  CPL_LOCAL_DATABASE_ROLE,
  CPL_LOCAL_IDENTITY_ISSUER,
  CPL_LOCAL_IDENTITY_SUBJECT,
  CPL_LOCAL_IDENTITY_EMAIL,
  type CplHostedSignInResult,
} from "@bea/security/hosted";
import type { CplHostedRuntime } from "./hosted-auth";

const refused = (): never => {
  throw new CplHostedAuthenticationError("CPL_LOCAL_DEVELOPMENT_REFUSED", 503);
};

/** The operator owns the marker and fixture. The web role cannot provision
 * either its privileges or a hosted owner identity through this path. */
export async function verifyLocalDevelopmentDatabase(database: DatabaseAdapter): Promise<void> {
  await verifyHostedDatabaseRole(database, "web");
  const result = await database.query<{
    database_name: string;
    role_name: string;
    server_address: string;
    server_port: number;
    purpose: string;
    hosted_owner_exists: boolean;
  }>(`SELECT current_database() AS database_name,current_user AS role_name,
    host(inet_server_addr()) AS server_address,inet_server_port() AS server_port,
    (SELECT purpose FROM cpl_local_development_marker WHERE singleton=TRUE) AS purpose,
    EXISTS (SELECT 1 FROM cpl_platform_owner_binding) AS hosted_owner_exists`);
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    !row ||
    row.database_name !== CPL_LOCAL_DATABASE_NAME ||
    row.role_name !== CPL_LOCAL_DATABASE_ROLE ||
    row.server_address !== "127.0.0.1" ||
    row.server_port !== 55433 ||
    row.purpose !== "local-development" ||
    row.hosted_owner_exists !== false
  )
    refused();
}

/** Fresh request-local connection, with the same SQL lifecycle, role verifier,
 * forced RLS, tenant repository and auth session reader as the hosted product. */
export async function withLocalDevelopmentRuntime<T>(
  operation: (runtime: CplHostedRuntime) => Promise<T>,
  request: Request | undefined,
): Promise<T> {
  const configuration = readLocalDevelopmentConfiguration();
  if (!request) return refused();
  assertLocalDevelopmentRequest(request, configuration);
  const database = new PgDatabaseAdapter({
    connectionString: configuration.databaseUrl,
    ssl: false,
    max: 1,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 1_000,
    statement_timeout: 15_000,
    idle_in_transaction_session_timeout: 15_000,
    application_name: "cpl-local-development-web",
  });
  try {
    await verifyLocalDevelopmentDatabase(database);
    const store = new SqlCplHostedAuthStore(database);
    return await operation({
      database,
      tenants: new SqlCplTenantRepository(database),
      auth: new CplHostedAuthService(
        store,
        {
          authorizationUrl: refused,
          exchangeCode: async () => refused(),
        },
        { appOrigin: configuration.origin, localDevelopment: true },
      ),
      origin: configuration.origin,
    });
  } finally {
    await database.close();
  }
}

/** Synthetic assurance is confined to an explicitly marked local database.
 * No browser claim chooses an identity, role, organization or MFA timestamp. */
export async function issueLocalDevelopmentSession(
  runtime: CplHostedRuntime,
  request: Request,
  previousSessionToken?: string,
): Promise<CplHostedSignInResult> {
  assertLocalDevelopmentRequest(request);
  if (request.method !== "POST") refused();
  const store = new SqlCplHostedAuthStore(runtime.database);
  const now = new Date().toISOString();
  if (
    !(await store.consumeRateLimit({
      key: "local-development:sign-in",
      limit: 30,
      windowSeconds: 60,
      now,
    }))
  )
    throw new CplHostedAuthenticationError("CPL_AUTH_RATE_LIMITED", 429);
  const sessionToken = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  const id = randomUUID();
  const expiresAt = new Date(Date.parse(now) + 60 * 60_000).toISOString();
  const absoluteExpiresAt = new Date(Date.parse(now) + 8 * 60 * 60_000).toISOString();
  await runtime.database.transaction(async (executor) => {
    const fixture = await executor.query<{ id: string }>(
      `SELECT i.id FROM cpl_identities i JOIN cpl_platform_administrators a ON a.identity_id=i.id
       WHERE i.issuer=$1 AND i.subject=$2 AND i.email=$3 AND i.email_verified=TRUE
         AND i.hosted_domain IS NULL AND i.status='active' AND a.status='active'
       FOR SHARE OF i,a`,
      [CPL_LOCAL_IDENTITY_ISSUER, CPL_LOCAL_IDENTITY_SUBJECT, CPL_LOCAL_IDENTITY_EMAIL],
    );
    if (fixture.rows.length !== 1) refused();
    const identity = fixture.rows[0]!;
    await executor.query(
      `INSERT INTO cpl_sessions(id,identity_id,token_hash,authenticated_at,mfa_verified,
        expires_at,csrf_token_hash,absolute_expires_at,mfa_verified_at,created_at)
       VALUES($1,$2,$3,$4,TRUE,$5,$6,$7,$4,$4)`,
      [
        id,
        identity.id,
        hostedTokenHash(sessionToken),
        now,
        expiresAt,
        hostedTokenHash(csrfToken),
        absoluteExpiresAt,
      ],
    );
    if (previousSessionToken) {
      await executor.query(
        "UPDATE cpl_sessions SET revoked_at=$1 WHERE token_hash=$2 AND identity_id=$3 AND revoked_at IS NULL",
        [now, hostedTokenHash(previousSessionToken), identity.id],
      );
    }
    await executor.query(
      "INSERT INTO cpl_auth_audit_events(id,identity_id,session_id,action) VALUES($1,$2,$3,'local-development.session-issued')",
      [randomUUID(), identity.id, id],
    );
  });
  const organizations = await runtime.tenants.listOrganizations(sessionToken);
  const development = organizations.find((organization) => organization.slug === "cpl-development");
  if (development) await runtime.auth.selectOrganization(sessionToken, development.id);
  return { sessionToken, csrfToken, session: await runtime.auth.requireSession(sessionToken) };
}
