import { createHmac, timingSafeEqual } from "node:crypto";
import { CplHostedAuthenticationError } from "./google-oidc.js";

export const CPL_LOCAL_SESSION_COOKIE = "cpl_local_session";
export const CPL_LOCAL_CSRF_COOKIE = "cpl_local_csrf";
export const CPL_LOCAL_IDENTITY_ISSUER = "https://local.cpl.invalid";
export const CPL_LOCAL_IDENTITY_SUBJECT = "local-owner";
export const CPL_LOCAL_IDENTITY_EMAIL = "local-owner@cpl.invalid";
export const CPL_LOCAL_DATABASE_NAME = "cpl_local_development";
export const CPL_LOCAL_DATABASE_ROLE = "cpl_local_web";
export const CPL_LOCAL_AUTH_KEYS = [
  "CPL_LOCAL_DEVELOPMENT_AUTH",
  "CPL_LOCAL_DATABASE_URL",
  "CPL_LOCAL_SESSION_SECRET",
] as const;

export interface LocalDevelopmentConfiguration {
  readonly origin: string;
  readonly databaseUrl: string;
  readonly sessionSecret: string;
}

const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;
function refused(): never {
  throw new CplHostedAuthenticationError("CPL_LOCAL_DEVELOPMENT_REFUSED", 503);
}

export function hasLocalDevelopmentConfiguration(
  source: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return CPL_LOCAL_AUTH_KEYS.some((key) => source[key] !== undefined);
}

/** A server-only fixture gate. A supplied environment can never override a
 * production process, and a loopback browser URL never authorizes a remote DB. */
export function readLocalDevelopmentConfiguration(
  source: Readonly<Record<string, string | undefined>> = process.env,
): LocalDevelopmentConfiguration {
  if (
    !["development", "test"].includes(process.env.NODE_ENV ?? "") ||
    !["development", "test"].includes(source.NODE_ENV ?? "") ||
    source.CPL_LOCAL_DEVELOPMENT_AUTH !== "true" ||
    source.CPL_HOSTED_ENABLED === "true" ||
    source.CPL_HOSTED_BUILD === "true" ||
    Boolean(source.DATABASE_URL) ||
    (source.CPL_DATABASE_TRANSPORT !== undefined && source.CPL_DATABASE_TRANSPORT !== "direct") ||
    source.CPL_SESSION_READ_TRANSPORT !== undefined ||
    source.GOOGLE_CLIENT_ID ||
    source.GOOGLE_CLIENT_SECRET
  )
    refused();
  try {
    const origin = source.APP_BASE_URL ?? "";
    const url = new URL(origin);
    const databaseUrl = source.CPL_LOCAL_DATABASE_URL ?? "";
    const database = new URL(databaseUrl);
    const sessionSecret = source.CPL_LOCAL_SESSION_SECRET ?? "";
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.origin !== origin ||
      !url.port ||
      Number(url.port) < 1024 ||
      url.username ||
      url.password ||
      !["postgres:", "postgresql:"].includes(database.protocol) ||
      database.hostname !== "127.0.0.1" ||
      database.port !== "55433" ||
      database.username !== CPL_LOCAL_DATABASE_ROLE ||
      !database.password ||
      database.pathname !== `/${CPL_LOCAL_DATABASE_NAME}` ||
      database.search ||
      database.hash ||
      !tokenPattern.test(sessionSecret)
    )
      refused();
    return Object.freeze({ origin, databaseUrl, sessionSecret });
  } catch {
    return refused();
  }
}

/** Request URL and Host are checked independently. Forwarded headers cannot
 * select the allowed origin. Mutations additionally require exact Origin. */
export function assertLocalDevelopmentRequest(
  request: Request,
  configuration: LocalDevelopmentConfiguration = readLocalDevelopmentConfiguration(),
): void {
  const current = readLocalDevelopmentConfiguration();
  const url = new URL(request.url);
  const expected = new URL(configuration.origin);
  // NextRequest canonicalizes numeric loopback URLs to localhost. Only this
  // internal URL spelling is equivalent: the original Host and mutation Origin
  // must still name the exact configured numeric loopback endpoint below.
  const normalized = new URL(configuration.origin);
  normalized.hostname = "localhost";
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  if (
    current.origin !== configuration.origin ||
    current.databaseUrl !== configuration.databaseUrl ||
    current.sessionSecret !== configuration.sessionSecret ||
    (url.origin !== expected.origin && url.origin !== normalized.origin) ||
    request.headers.get("host") !== expected.host ||
    (origin !== null && origin !== expected.origin) ||
    (site !== null && site !== "same-origin" && site !== "none") ||
    (!["GET", "HEAD"].includes(request.method) && origin !== expected.origin)
  )
    refused();
}

function signature(token: string, configuration: LocalDevelopmentConfiguration): string {
  return createHmac("sha256", Buffer.from(configuration.sessionSecret, "base64url"))
    .update(`cpl-local-session-v1\n${configuration.origin}\n${token}`)
    .digest("base64url");
}

/** The HMAC wraps a real opaque SQL session. Identity/roles remain server-side;
 * a valid signature never skips expiry, revocation, membership or tenant checks. */
export function signLocalSessionCookie(token: string): string {
  const configuration = readLocalDevelopmentConfiguration();
  if (!tokenPattern.test(token)) refused();
  return `${token}.${signature(token, configuration)}`;
}

export function verifyLocalSessionCookie(value: string | undefined): string | undefined {
  const configuration = readLocalDevelopmentConfiguration();
  if (!value || value.length !== 87) return undefined;
  const [token, supplied] = value.split(".");
  if (!token || !supplied || !tokenPattern.test(token) || !tokenPattern.test(supplied))
    return undefined;
  const expected = signature(token, configuration);
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied)) ? token : undefined;
}
