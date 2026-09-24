import { CplGoogleGmailAdapter } from "@bea/integrations/cpl-gmail";
import {
  createGoogleIntegrationIdentityVerifier,
  createIntegrationSecretBox,
  integrationDecodeBase64Url,
  verifyCplInboundSubmission,
} from "@bea/security/cpl-integration-security";
import type { DatabaseAdapter } from "./adapter.js";
import type {
  CplIntegrationRepositoryOptions,
  CplGoogleGmailAdapter as GmailPort,
} from "./cpl-integration-ports.js";

export class CplIntegrationRuntimeError extends Error {
  readonly code = "CPL_INTEGRATION_CONFIGURATION_UNAVAILABLE";
  constructor() {
    super("CPL_INTEGRATION_CONFIGURATION_UNAVAILABLE");
  }
}
function refused(): never {
  throw new CplIntegrationRuntimeError();
}
type Environment = Readonly<Record<string, string | undefined>>;
type FixtureInput = Parameters<
  (typeof import("@bea/security/cpl-integration-fixture"))["createCplGmailHttpFixture"]
>[0];
type FixtureMaterial = {
  version: 1;
  createdAt: string;
  purpose: "synthetic-local-integration-fixture";
  keyVersion: string;
  envelopeKey: string;
  fixtureSecret: string;
  privateJwk: FixtureInput["privateJwk"];
  publicJwk: FixtureInput["publicJwk"];
};
function materialFromEnvironment(source: Environment): FixtureMaterial {
  try {
    const text = source.CPL_LOCAL_INTEGRATION_MATERIAL;
    if (!text || text.length > 16_384) refused();
    const value = JSON.parse(text) as FixtureMaterial;
    if (
      value.version !== 1 ||
      value.purpose !== "synthetic-local-integration-fixture" ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      value.keyVersion !== "local-fixture-v1" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(value.envelopeKey) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(value.fixtureSecret) ||
      value.privateJwk?.kty !== "RSA" ||
      !value.privateJwk.d ||
      value.publicJwk?.kty !== "RSA" ||
      value.publicJwk.d ||
      value.privateJwk.n !== value.publicJwk.n ||
      value.privateJwk.e !== value.publicJwk.e
    )
      refused();
    return value;
  } catch {
    return refused();
  }
}

async function verifyFixtureDatabase(
  database: DatabaseAdapter,
  source: Environment,
  origin: string,
) {
  if (database.kind !== "postgres") refused();
  if (
    process.env.NODE_ENV === "production" ||
    !["development", "test"].includes(source.NODE_ENV ?? "") ||
    source.CPL_LOCAL_DEVELOPMENT_AUTH !== "true" ||
    source.CPL_HOSTED_ENABLED === "true" ||
    source.CPL_HOSTED_BUILD === "true" ||
    source.DATABASE_URL ||
    source.GOOGLE_CLIENT_ID ||
    source.GOOGLE_CLIENT_SECRET ||
    source.CPL_GMAIL_CLIENT_ID ||
    source.CPL_GMAIL_CLIENT_SECRET ||
    source.CPL_GMAIL_REDIRECT_URI ||
    source.CPL_INTEGRATION_KEYS_JSON
  )
    refused();
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    Number(url.port) < 1024 ||
    url.username ||
    url.password
  )
    refused();
  const actual = (
    await database.query<{
      database_name: string;
      role_name: string;
      address: string;
      port: number;
      purpose: string;
    }>(`SELECT current_database() AS database_name,current_user AS role_name,
    host(inet_server_addr()) AS address,inet_server_port() AS port,purpose
    FROM cpl_local_development_marker WHERE singleton=TRUE`)
  ).rows[0];
  if (
    !actual ||
    actual.database_name !== "cpl_local_development" ||
    !["cpl_local_web", "cpl_local_worker"].includes(actual.role_name) ||
    actual.address !== "127.0.0.1" ||
    Number(actual.port) !== 55433 ||
    actual.purpose !== "local-development"
  )
    refused();
}

/** Only trusted server composition passes environment or provider ports. HTTP
 * inputs cannot choose mode, credentials, endpoints, mailbox identity or keys.
 * Every provider operation additionally uses the repository's live SQL fence. */
export async function createCplIntegrationRuntime(input: {
  database: DatabaseAdapter;
  origin: string;
  environment?: Environment;
}): Promise<CplIntegrationRepositoryOptions> {
  const source = input.environment ?? process.env;
  const mode = source.CPL_INTEGRATION_PROVIDER_MODE ?? "disabled";
  if (mode === "disabled") {
    if (source.CPL_LOCAL_INTEGRATION_MATERIAL) refused();
    return { providerMode: "disabled" };
  }
  const redirectUri = input.origin + "/api/cpl-integrations/oauth/google/callback";
  if (mode === "local_fixture") {
    await verifyFixtureDatabase(input.database, source, input.origin);
    const material = materialFromEnvironment(source);
    const key = integrationDecodeBase64Url(material.envelopeKey, 32);
    const secretBox = createIntegrationSecretBox({
      resolveKey: async (version) => {
        if (version !== material.keyVersion) refused();
        return key;
      },
    });
    return {
      providerMode: "local_fixture",
      keyVersion: material.keyVersion,
      redirectUri,
      secretBox,
      signedSubmissions: { verify: verifyCplInboundSubmission },
      createGmailAdapter: async ({ organizationId, assertCurrent, signal }) => {
        const { createCplGmailHttpFixture } = await import("@bea/security/cpl-integration-fixture");
        const fixture = await createCplGmailHttpFixture({
          fixtureId: organizationId,
          privateJwk: material.privateJwk,
          publicJwk: material.publicJwk,
          fixtureSecret: integrationDecodeBase64Url(material.fixtureSecret, 32),
          fixtureEpoch: material.createdAt,
          redirectUri,
        });
        const adapter = new CplGoogleGmailAdapter(fixture.configuration, {
          fetch: fixture.fetch,
          assertCurrent,
          signal,
          verifyIdentity: createGoogleIntegrationIdentityVerifier(),
        });
        // Issue a synthetic authorization code through the fixture's real OAuth
        // protocol. The browser stays on the local origin; exchange/JWKS/Gmail
        // requests still pass through the actual guarded provider adapter.
        return {
          authorizationUrl: async (request) => {
            const authorization = await adapter.authorizationUrl(request);
            const issued = await fixture.authorize(authorization);
            await assertCurrent("authorize");
            const callback = new URL(issued.redirectUri);
            if (callback.toString() !== redirectUri) refused();
            callback.searchParams.set("state", issued.state);
            callback.searchParams.set("code", issued.code);
            return callback.toString();
          },
          exchangeCode: adapter.exchangeCode.bind(adapter),
          refresh: adapter.refresh.bind(adapter),
          listLabels: adapter.listLabels.bind(adapter),
          profile: adapter.profile.bind(adapter),
          listMessages: adapter.listMessages.bind(adapter),
          listHistory: adapter.listHistory.bind(adapter),
          getMessage: adapter.getMessage.bind(adapter),
          revoke: adapter.revoke.bind(adapter),
        } satisfies GmailPort;
      },
    };
  }
  if (
    mode !== "live" ||
    source.CPL_LOCAL_INTEGRATION_MATERIAL ||
    source.CPL_LOCAL_DEVELOPMENT_AUTH ||
    source.NODE_ENV !== "production" ||
    process.env.NODE_ENV !== "production"
  )
    refused();
  try {
    const origin = new URL(input.origin);
    if (
      origin.origin !== input.origin ||
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      source.CPL_GMAIL_REDIRECT_URI !== redirectUri
    )
      refused();
    const keyVersion = source.CPL_INTEGRATION_KEY_VERSION ?? "";
    const serialized = source.CPL_INTEGRATION_KEYS_JSON ?? "";
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(keyVersion) || serialized.length > 4096) refused();
    const keys: unknown = JSON.parse(serialized);
    if (!keys || Array.isArray(keys) || typeof keys !== "object") refused();
    const entries = Object.entries(keys);
    if (
      !entries.length ||
      entries.length > 8 ||
      entries.some(
        ([version, key]) =>
          !/^[A-Za-z0-9_-]{1,64}$/u.test(version) ||
          typeof key !== "string" ||
          !/^[A-Za-z0-9_-]{43}$/u.test(key),
      )
    )
      refused();
    const ring = new Map(entries as [string, string][]);
    if (!ring.has(keyVersion)) refused();
    const clientId = source.CPL_GMAIL_CLIENT_ID ?? "",
      clientSecret = source.CPL_GMAIL_CLIENT_SECRET ?? "";
    if (
      !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/u.test(clientId) ||
      !clientSecret ||
      clientSecret.length > 1024
    )
      refused();
    return {
      providerMode: "live",
      keyVersion,
      redirectUri,
      secretBox: createIntegrationSecretBox({
        resolveKey: async (version) => {
          const value = ring.get(version);
          if (!value) refused();
          return integrationDecodeBase64Url(value, 32);
        },
      }),
      signedSubmissions: { verify: verifyCplInboundSubmission },
      createGmailAdapter: ({ assertCurrent, signal }) =>
        new CplGoogleGmailAdapter(
          { clientId, clientSecret, redirectUri },
          {
            fetch: globalThis.fetch.bind(globalThis),
            assertCurrent,
            signal,
            verifyIdentity: createGoogleIntegrationIdentityVerifier(),
          },
        ),
    };
  } catch {
    return refused();
  }
}
