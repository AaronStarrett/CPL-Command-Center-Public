import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare/cloudflare-context";

import {
  PgDatabaseAdapter,
  SqlCplHostedAuthStore,
  SqlCplTenantRepository,
  verifyHostedDatabaseRole,
  hostedDatabaseTransport,
  hyperdriveConnection,
  hyperdriveTimeoutIntent,
  withHyperdriveDeadlines,
  withHostedWebRoleGuard,
  type DatabaseAdapter,
  type CplTenantPermission,
  type CplTenantRequest,
  type HostedDatabaseBindings,
  type HostedDatabaseTransport,
} from "@bea/database/hosted";
import {
  CplHostedAuthService,
  CplHostedAuthenticationError,
  GoogleOidcAdapter,
  CPL_HOSTED_SESSION_COOKIE,
  CPL_HOSTED_CSRF_COOKIE,
  type CplHostedSession,
} from "@bea/security/hosted";

export interface CplHostedRuntime {
  readonly database: DatabaseAdapter;
  readonly tenants: SqlCplTenantRepository;
  readonly auth: CplHostedAuthService;
  readonly origin: string;
}

export interface HostedAuthConfiguration {
  readonly origin: string;
  readonly databaseUrl: string;
  readonly databaseSsl: false | { readonly rejectUnauthorized: true };
  readonly databaseTransport: HostedDatabaseTransport;
  readonly googleClientId: string;
  readonly googleClientSecret: string;
}

/** OpenNext stores object bindings in its invocation context, not process.env.
 * Read only the two named capabilities; never retain them between requests. */
function invocationDatabaseBindings(): HostedDatabaseBindings {
  const environment = getCloudflareContext().env;
  return {
    CPL_WEB_DB: Reflect.get(environment, "CPL_WEB_DB"),
    CPL_JOBS_DB: Reflect.get(environment, "CPL_JOBS_DB"),
  };
}

export function readHostedAuthConfiguration(
  source: Readonly<Record<string, string | undefined>> = process.env,
  bindings?: HostedDatabaseBindings,
): HostedAuthConfiguration {
  if (source.CPL_HOSTED_ENABLED !== "true" || source.NODE_ENV !== "production")
    throw new CplHostedAuthenticationError("CPL_HOSTED_AUTH_UNAVAILABLE", 503);
  const origin = source.APP_BASE_URL ?? "";
  const clientId = source.GOOGLE_CLIENT_ID ?? "";
  const clientSecret = source.GOOGLE_CLIENT_SECRET ?? "";
  try {
    const parsedOrigin = new URL(origin);
    if (
      parsedOrigin.protocol !== "https:" ||
      parsedOrigin.origin !== origin ||
      !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/u.test(clientId) ||
      !clientSecret ||
      clientSecret.length > 1_024
    )
      throw new Error("Invalid hosted configuration");
    const transport = hostedDatabaseTransport(source.CPL_DATABASE_TRANSPORT);
    let databaseUrl: string;
    let databaseSsl: HostedAuthConfiguration["databaseSsl"];
    if (transport === "hyperdrive") {
      const selected = hyperdriveConnection(bindings ?? invocationDatabaseBindings(), "web");
      databaseUrl = selected.connectionString;
      databaseSsl = selected.ssl;
    } else {
      const database = new URL(source.DATABASE_URL ?? "");
      if (
        !["postgres:", "postgresql:"].includes(database.protocol) ||
        !database.hostname ||
        !database.username ||
        !database.password ||
        [...database.searchParams.keys()].some(
          (key) =>
            (key.toLowerCase().startsWith("ssl") && key !== "sslmode") ||
            key.toLowerCase() === "uselibpqcompat",
        ) ||
        (database.searchParams.has("sslmode") &&
          !["require", "verify-full"].includes(database.searchParams.get("sslmode") ?? ""))
      )
        throw new Error("Invalid hosted configuration");
      // Direct-connection URL SSL options can replace Pool.ssl. Retain the
      // existing strict policy; only a platform binding permits local ssl:false.
      database.searchParams.delete("sslmode");
      databaseUrl = database.toString();
      databaseSsl = { rejectUnauthorized: true };
    }
    return {
      origin,
      databaseUrl,
      databaseSsl,
      databaseTransport: transport,
      googleClientId: clientId,
      googleClientSecret: clientSecret,
    };
  } catch {
    throw new CplHostedAuthenticationError("CPL_HOSTED_AUTH_NOT_CONFIGURED", 503);
  }
}

export function hostedAuthConfigurationStatus(
  source: Readonly<Record<string, string | undefined>> = process.env,
  bindings?: HostedDatabaseBindings,
) {
  const hyperdrive = source.CPL_DATABASE_TRANSPORT === "hyperdrive";
  const required = ["APP_BASE_URL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];
  if (!hyperdrive) required.push("DATABASE_URL");
  const missing = required.filter((key) => !source[key]);
  if (hyperdrive) missing.push("CPL_WEB_DB");
  try {
    const selectedBindings = hyperdrive ? (bindings ?? invocationDatabaseBindings()) : bindings;
    if (hyperdrive && selectedBindings?.CPL_WEB_DB !== undefined)
      missing.splice(missing.indexOf("CPL_WEB_DB"), 1);
    readHostedAuthConfiguration(source, selectedBindings);
    return { enabled: true, configured: true, missing: [] as string[] };
  } catch {
    return { enabled: source.CPL_HOSTED_ENABLED === "true", configured: false, missing };
  }
}

/** A fresh pool belongs to this invocation and is always closed. No connected
 * client or mutable tenant state is cached across Cloudflare Worker requests. */
export async function withHostedRuntime<T>(
  operation: (runtime: CplHostedRuntime) => Promise<T>,
  options: { readonly sessionRequest?: Request } = {},
): Promise<T> {
  const configuration = readHostedAuthConfiguration();
  // Reject an impossible session before opening TLS/SCRAM or querying the DB.
  // A structurally valid cookie still receives every existing server-side check.
  if (options.sessionRequest) {
    const cookie = await hostedCookie(CPL_HOSTED_SESSION_COOKIE, options.sessionRequest);
    if (!cookie || !/^[A-Za-z0-9_-]{43}$/u.test(cookie)) throw new CplHostedAuthenticationError();
  }
  const connection = new PgDatabaseAdapter({
    connectionString: configuration.databaseUrl,
    ssl: configuration.databaseSsl,
    max: 1,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 1_000,
    statement_timeout: 15_000,
    idle_in_transaction_session_timeout: 15_000,
    application_name: "cpl-hosted-web",
    ...(configuration.databaseTransport === "hyperdrive"
      ? { ...hyperdriveTimeoutIntent("web"), query_timeout: 15_000 }
      : {}),
  });
  let database: DatabaseAdapter = connection;
  try {
    database =
      configuration.databaseTransport === "hyperdrive"
        ? withHostedWebRoleGuard(withHyperdriveDeadlines(connection, "web"))
        : connection;
    if (configuration.databaseTransport !== "hyperdrive")
      await verifyHostedDatabaseRole(database, "web");
    const store = new SqlCplHostedAuthStore(database);
    const oidc = new GoogleOidcAdapter({
      appOrigin: configuration.origin,
      clientId: configuration.googleClientId,
      clientSecret: configuration.googleClientSecret,
    });
    return await operation({
      database,
      tenants: new SqlCplTenantRepository(database),
      auth: new CplHostedAuthService(store, oidc, { appOrigin: configuration.origin }),
      origin: configuration.origin,
    });
  } finally {
    await database.close();
  }
}

export async function hostedCookie(name: string, request?: Request): Promise<string | undefined> {
  if (!request) {
    const { cookies } = await import("next/headers");
    const matches = (await cookies()).getAll(name);
    return matches.length === 1 ? matches[0]?.value : undefined;
  }
  const matches = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0]?.slice(name.length + 1) : undefined;
}

export async function requireHostedSession(
  runtime: CplHostedRuntime,
  request?: Request,
): Promise<{ session: CplHostedSession; sessionToken: string }> {
  const sessionToken = await hostedCookie(CPL_HOSTED_SESSION_COOKIE, request);
  const session = await runtime.auth.requireSession(sessionToken);
  return { session, sessionToken: sessionToken! };
}

export async function requireHostedMutation(
  runtime: CplHostedRuntime,
  request: Request,
): Promise<{ session: CplHostedSession; sessionToken: string }> {
  const sessionToken = await hostedCookie(CPL_HOSTED_SESSION_COOKIE, request);
  const session = await runtime.auth.requireMutation({
    request,
    sessionToken,
    csrfCookie: await hostedCookie(CPL_HOSTED_CSRF_COOKIE, request),
  });
  return { session, sessionToken: sessionToken! };
}

export async function requireHostedTenantRequest(
  runtime: CplHostedRuntime,
  request: Request,
  permission: CplTenantPermission,
): Promise<CplTenantRequest> {
  const { session, sessionToken } = ["GET", "HEAD"].includes(request.method)
    ? await requireHostedSession(runtime, request)
    : await requireHostedMutation(runtime, request);
  if (!session.selectedOrganizationId)
    throw new CplHostedAuthenticationError("CPL_ORGANIZATION_REQUIRED", 403);
  const tenantRequest = { sessionToken, organizationId: session.selectedOrganizationId };
  await runtime.tenants.authorize({ ...tenantRequest, permission });
  return tenantRequest;
}
