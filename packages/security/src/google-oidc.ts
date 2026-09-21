import { createHash, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { CplHostedIdentity } from "./hosted-authentication-contracts.js";

export const GOOGLE_OIDC_ISSUER = "https://accounts.google.com";
const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"), {
  timeoutDuration: 5_000,
  cooldownDuration: 30_000,
  cacheMaxAge: 3_600_000,
});

export class CplHostedAuthenticationError extends Error {
  constructor(
    readonly code = "CPL_AUTHENTICATION_REQUIRED",
    readonly status = 401,
  ) {
    super(code);
    this.name = "CplHostedAuthenticationError";
  }
}

export function hostedTokenHash(value: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new CplHostedAuthenticationError();
  return createHash("sha256").update(value).digest("hex");
}

export function equalHostedToken(left: string, right: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(left) || !/^[A-Za-z0-9_-]{43}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

export interface GoogleOidcConfiguration {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly appOrigin: string;
}

export class GoogleOidcAdapter {
  readonly callbackUrl: string;
  constructor(
    private readonly configuration: GoogleOidcConfiguration,
    private readonly dependencies: {
      readonly keys?: JWTVerifyGetKey;
      readonly fetch?: typeof fetch;
      readonly now?: () => Date;
    } = {},
  ) {
    const origin = new URL(configuration.appOrigin);
    if (
      origin.protocol !== "https:" ||
      origin.origin !== configuration.appOrigin ||
      !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/u.test(configuration.clientId) ||
      !configuration.clientSecret ||
      configuration.clientSecret.length > 1_024
    )
      throw new CplHostedAuthenticationError("CPL_HOSTED_AUTH_NOT_CONFIGURED", 503);
    this.callbackUrl = `${origin.origin}/api/auth/google/callback`;
  }

  authorizationUrl(input: {
    readonly state: string;
    readonly nonce: string;
    readonly verifier: string;
  }): string {
    hostedTokenHash(input.state);
    hostedTokenHash(input.nonce);
    hostedTokenHash(input.verifier);
    const url = new URL(GOOGLE_AUTHORIZATION_URL);
    url.search = new URLSearchParams({
      client_id: this.configuration.clientId,
      redirect_uri: this.callbackUrl,
      response_type: "code",
      scope: "openid email profile",
      access_type: "online",
      prompt: "select_account",
      state: input.state,
      nonce: input.nonce,
      code_challenge: createHash("sha256").update(input.verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    return url.toString();
  }

  async exchangeCode(input: {
    readonly code: string;
    readonly verifier: string;
    readonly nonce: string;
  }): Promise<CplHostedIdentity> {
    if (typeof input.code !== "string" || !input.code || input.code.length > 4_096)
      throw new CplHostedAuthenticationError();
    hostedTokenHash(input.verifier);
    try {
      const response = await (this.dependencies.fetch ?? fetch)(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: input.code,
          client_id: this.configuration.clientId,
          client_secret: this.configuration.clientSecret,
          redirect_uri: this.callbackUrl,
          grant_type: "authorization_code",
          code_verifier: input.verifier,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok || !response.body) throw new Error("Token exchange refused");
      const reader = response.body.getReader();
      let length = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        length += result.value.byteLength;
        if (length > 65_536) {
          await reader.cancel();
          throw new Error("Token response too large");
        }
        chunks.push(result.value);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        !body ||
        typeof body !== "object" ||
        !("id_token" in body) ||
        typeof body.id_token !== "string"
      )
        throw new Error("Missing ID token");
      return await this.verifyIdToken(body.id_token, input.nonce);
    } catch {
      // Never expose provider payloads, authorization codes, assertions or client secrets.
      throw new CplHostedAuthenticationError("CPL_IDENTITY_ASSERTION_REJECTED");
    }
  }

  async verifyIdToken(assertion: string, expectedNonce: string): Promise<CplHostedIdentity> {
    hostedTokenHash(expectedNonce);
    if (typeof assertion !== "string" || assertion.length < 1 || assertion.length > 16_384)
      throw new CplHostedAuthenticationError();
    try {
      const now = this.dependencies.now?.() ?? new Date();
      const { payload } = await jwtVerify(assertion, this.dependencies.keys ?? googleKeys, {
        algorithms: ["RS256"],
        issuer: [GOOGLE_OIDC_ISSUER, "accounts.google.com"],
        audience: this.configuration.clientId,
        requiredClaims: ["iss", "sub", "aud", "iat", "exp", "nonce", "email", "email_verified"],
        maxTokenAge: 300,
        clockTolerance: 30,
        currentDate: now,
      });
      if (
        payload.aud !== this.configuration.clientId ||
        (payload.azp !== undefined && payload.azp !== this.configuration.clientId) ||
        typeof payload.nonce !== "string" ||
        !equalHostedToken(payload.nonce, expectedNonce) ||
        typeof payload.sub !== "string" ||
        !/^[A-Za-z0-9_-]{1,255}$/u.test(payload.sub) ||
        payload.email_verified !== true ||
        typeof payload.email !== "string" ||
        payload.email.length > 254 ||
        !/^[^\s@\u0000-\u001f]+@[^\s@\u0000-\u001f]+\.[^\s@\u0000-\u001f]+$/u.test(payload.email) ||
        !Number.isInteger(payload.iat) ||
        !Number.isInteger(payload.exp) ||
        payload.exp! <= now.getTime() / 1_000 ||
        payload.exp! <= payload.iat! ||
        (payload.hd !== undefined &&
          (typeof payload.hd !== "string" || !/^[a-z0-9.-]{1,253}$/u.test(payload.hd)))
      )
        throw new Error("Invalid identity claims");
      const authenticatedAt = payload.auth_time ?? payload.iat!;
      if (
        typeof authenticatedAt !== "number" ||
        !Number.isInteger(authenticatedAt) ||
        authenticatedAt <= 0 ||
        authenticatedAt > payload.iat! + 30
      )
        throw new Error("Invalid authentication time");
      const name = typeof payload.name === "string" ? payload.name.trim() : "";
      return {
        issuer: GOOGLE_OIDC_ISSUER,
        subject: payload.sub,
        email: payload.email.toLowerCase(),
        emailVerified: true,
        hostedDomain: typeof payload.hd === "string" ? payload.hd : null,
        displayName:
          name && name.length <= 240 && !/[\u0000-\u001f]/u.test(name) ? name : payload.email,
        authenticatedAt: new Date(authenticatedAt * 1_000).toISOString(),
        expiresAt: new Date(payload.exp! * 1_000).toISOString(),
      };
    } catch {
      throw new CplHostedAuthenticationError("CPL_IDENTITY_ASSERTION_REJECTED");
    }
  }
}
