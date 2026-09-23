import "server-only";
import {
  CplHostedAuthService,
  CplHostedAuthenticationError,
  GoogleOidcAdapter,
  hasLocalDevelopmentConfiguration,
  type CplHostedAuthStore,
} from "@bea/security/hosted";
import { readHostedAuthConfiguration, withHostedRuntime } from "./hosted-auth";
import {
  createSessionTransport,
  sessionReadTransport,
  type SessionReader,
} from "./session-http.mjs";

// Exact additive migration contract required before explicit HTTP activation.
export const SESSION_HTTP_CONTRACT =
  "7e798a073c31f3704d81468ec2e0186acc2f8bdd868c76153c55b48cade6b21e";
type SessionRuntime = { readonly auth: CplHostedAuthService };
type Operation<T> = (runtime: SessionRuntime) => Promise<T>;
type Transport = ReturnType<typeof createSessionTransport>;
type Configuration = {
  readonly connectionString: string;
  readonly policy: {
    readonly host: string;
    readonly database: string;
    readonly role: "cpl_web_runtime";
  };
};
const unavailable = (): never => {
  throw new CplHostedAuthenticationError("CPL_HOSTED_AUTH_UNAVAILABLE", 503);
};

/** This endpoint has no mutation, ceremony or generic SQL capability. */
export function readOnlySessionStore(reader: SessionReader): CplHostedAuthStore {
  const denied = async (): Promise<never> => unavailable();
  return Object.freeze({
    readSession: (hash: string, now: string) => reader.readSession(hash, now),
    readSessionWithPasskey: (hash: string, now: string) => reader.readSessionWithPasskey(hash, now),
    createOAuthFlow: denied,
    consumeOAuthFlow: denied,
    createSession: denied,
    rotateSession: denied,
    revokeSession: denied,
    selectOrganization: denied,
    listCredentials: denied,
    createChallenge: denied,
    consumeChallenge: denied,
    completeRegistration: denied,
    completeAuthentication: denied,
    consumeRateLimit: denied,
  });
}

/** Cache only an immutable configured SDK facade. Readers/results are invocation-local. */
export function createHostedSessionRuntime({
  source = () => process.env as Readonly<Record<string, string | undefined>>,
  readConfiguration = readHostedAuthConfiguration,
  fallback = withHostedRuntime,
  loadDriver = (): Promise<unknown> => import("@neondatabase/serverless"),
  createTransport = createSessionTransport,
  fetchImplementation = (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
} = {}) {
  let pending: Promise<Transport> | undefined, selected: Configuration | undefined;
  return async function withSessionRuntime<T>(
    operation: Operation<T>,
    options: { readonly request?: Request } = {},
  ): Promise<T> {
    const environment = source();
    if (hasLocalDevelopmentConfiguration(environment)) return fallback(operation, options);
    let transport: ReturnType<typeof sessionReadTransport>;
    try {
      transport = sessionReadTransport(environment.CPL_SESSION_READ_TRANSPORT);
    } catch {
      return unavailable();
    }
    if (transport === "hyperdrive") return fallback(operation, options);
    const configuration = readConfiguration(environment);
    // The unchanged platform binding guard remains required for this deployment.
    // DATABASE_URL is the retained origin web role secret, never a browser value
    // or the ephemeral Hyperdrive frontend credential returned by the binding.
    if (
      configuration.databaseTransport !== "hyperdrive" ||
      environment.CPL_SESSION_HTTP_CONTRACT !== SESSION_HTTP_CONTRACT ||
      !environment.DATABASE_URL ||
      !environment.CPL_NEON_WEB_HOST ||
      !environment.CPL_NEON_WEB_DATABASE
    )
      return unavailable();
    const current: Configuration = {
      connectionString: environment.DATABASE_URL,
      policy: {
        host: environment.CPL_NEON_WEB_HOST,
        database: environment.CPL_NEON_WEB_DATABASE,
        role: "cpl_web_runtime",
      },
    };
    if (
      selected &&
      (selected.connectionString !== current.connectionString ||
        selected.policy.host !== current.policy.host ||
        selected.policy.database !== current.policy.database)
    )
      return unavailable();
    if (!pending) {
      selected = current;
      pending = loadDriver().then((driver) =>
        createTransport({
          driver,
          version: "1.1.0",
          ...current,
          fetchImplementation,
        }),
      );
    }
    const factory = await pending,
      reader = factory.invocation();
    try {
      const oidc = new GoogleOidcAdapter({
        appOrigin: configuration.origin,
        clientId: configuration.googleClientId,
        clientSecret: configuration.googleClientSecret,
      });
      return await operation({
        auth: new CplHostedAuthService(readOnlySessionStore(reader), oidc, {
          appOrigin: configuration.origin,
        }),
      });
    } finally {
      reader.close();
    }
  };
}
export const withHostedSessionRuntime = createHostedSessionRuntime();
