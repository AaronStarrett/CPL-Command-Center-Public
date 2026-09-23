import { randomBytes, timingSafeEqual } from "node:crypto";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
  AuthenticatorTransport,
} from "@simplewebauthn/server";
import {
  CplHostedAuthenticationError,
  equalHostedToken,
  hostedTokenHash,
  type GoogleOidcAdapter,
} from "./google-oidc.js";
import {
  CPL_HOSTED_MFA_MAX_AGE_MS,
  type CplHostedAuthStore,
  type CplHostedSession,
  type CplHostedSessionMaterial,
  type CplHostedCeremony,
} from "./hosted-authentication-contracts.js";

export const CPL_HOSTED_SESSION_COOKIE = "__Host-cpl-session";
export const CPL_HOSTED_CSRF_COOKIE = "__Host-cpl-csrf";
export const CPL_HOSTED_OAUTH_COOKIE = "__Host-cpl-oauth";
const SESSION_TTL_MS = 60 * 60_000;
const SESSION_ABSOLUTE_TTL_MS = 8 * SESSION_TTL_MS;
const CHALLENGE_TTL_MS = 5 * 60_000;
const token = () => randomBytes(32).toString("base64url");

let webAuthnModule: Promise<typeof import("@simplewebauthn/server")> | undefined;
function loadWebAuthn() {
  // Share only the complete SDK module, never request, session, or ceremony state.
  return (webAuthnModule ??= import("@simplewebauthn/server"));
}

function assertFirstPartyClientData(encoded: string): void {
  const data: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    ("crossOrigin" in data && data.crossOrigin !== false) ||
    "topOrigin" in data
  ) {
    throw new Error("Cross-origin passkey ceremony rejected");
  }
}

export interface CplHostedSignInResult {
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly session: CplHostedSession;
}

export function hostedStepUpRequired(session: CplHostedSession, now = new Date()): boolean {
  const verifiedAt = Date.parse(session.mfaVerifiedAt ?? "");
  return (
    !Number.isFinite(verifiedAt) ||
    verifiedAt > now.getTime() ||
    now.getTime() - verifiedAt > CPL_HOSTED_MFA_MAX_AGE_MS
  );
}

export function assertHostedOrigin(request: Pick<Request, "headers">, origin: string): void {
  if (
    request.headers.get("origin") !== origin ||
    (request.headers.has("sec-fetch-site") &&
      request.headers.get("sec-fetch-site") !== "same-origin")
  ) {
    throw new CplHostedAuthenticationError("CPL_CSRF_REJECTED", 403);
  }
}

export class CplHostedAuthService {
  readonly origin: string;
  private readonly rpId: string;
  private readonly now: () => Date;
  constructor(
    private readonly store: CplHostedAuthStore,
    private readonly oidc: Pick<GoogleOidcAdapter, "authorizationUrl" | "exchangeCode">,
    configuration: { readonly appOrigin: string; readonly now?: () => Date },
  ) {
    const url = new URL(configuration.appOrigin);
    if (
      url.protocol !== "https:" ||
      url.origin !== configuration.appOrigin ||
      url.username ||
      url.password
    )
      throw new CplHostedAuthenticationError("CPL_HOSTED_AUTH_NOT_CONFIGURED", 503);
    this.origin = url.origin;
    this.rpId = url.hostname;
    this.now = configuration.now ?? (() => new Date());
  }

  private async limit(key: string, limit: number, windowSeconds = 300): Promise<void> {
    if (
      !(await this.store.consumeRateLimit({
        key,
        limit,
        windowSeconds,
        now: this.now().toISOString(),
      }))
    )
      throw new CplHostedAuthenticationError("CPL_AUTH_RATE_LIMITED", 429);
  }

  private material(absoluteExpiresAt?: string): {
    material: CplHostedSessionMaterial;
    sessionToken: string;
    csrfToken: string;
  } {
    const now = this.now().getTime();
    const absolute = absoluteExpiresAt
      ? Date.parse(absoluteExpiresAt)
      : now + SESSION_ABSOLUTE_TTL_MS;
    if (!Number.isFinite(absolute) || absolute <= now || absolute > now + SESSION_ABSOLUTE_TTL_MS)
      throw new CplHostedAuthenticationError();
    const sessionToken = token();
    const csrfToken = token();
    return {
      sessionToken,
      csrfToken,
      material: {
        tokenHash: hostedTokenHash(sessionToken),
        csrfTokenHash: hostedTokenHash(csrfToken),
        expiresAt: new Date(Math.min(now + SESSION_TTL_MS, absolute)).toISOString(),
        absoluteExpiresAt: new Date(absolute).toISOString(),
      },
    };
  }

  async beginSignIn(returnTo = "/workspace") {
    await this.limit("oauth:start", 60, 60);
    // Only the released hosted workspace is a valid post-login target.
    const safeReturnTo = returnTo === "/workspace" ? returnTo : "/workspace";
    const browserBinding = token();
    const state = token();
    const nonce = token();
    const verifier = token();
    await this.store.createOAuthFlow({
      browserBindingHash: hostedTokenHash(browserBinding),
      stateHash: hostedTokenHash(state),
      nonce,
      pkceVerifier: verifier,
      returnTo: safeReturnTo,
      expiresAt: new Date(this.now().getTime() + CHALLENGE_TTL_MS).toISOString(),
    });
    return {
      browserBinding,
      authorizationUrl: this.oidc.authorizationUrl({ state, nonce, verifier }),
    };
  }

  async finishSignIn(input: {
    readonly browserBinding: string;
    readonly state: string;
    readonly code: string;
    readonly previousSessionToken?: string;
  }): Promise<CplHostedSignInResult & { readonly returnTo: string }> {
    const flow = await this.store.consumeOAuthFlow({
      browserBindingHash: hostedTokenHash(input.browserBinding),
      stateHash: hostedTokenHash(input.state),
      now: this.now().toISOString(),
    });
    if (!flow) throw new CplHostedAuthenticationError("CPL_OAUTH_STATE_REJECTED");
    const identity = await this.oidc.exchangeCode({
      code: input.code,
      verifier: flow.pkceVerifier,
      nonce: flow.nonce,
    });
    const issued = this.material();
    const session = await this.store.createSession({
      identity,
      material: issued.material,
      now: this.now().toISOString(),
    });
    if (input.previousSessionToken && /^[A-Za-z0-9_-]{43}$/u.test(input.previousSessionToken))
      await this.store.revokeSession(
        hostedTokenHash(input.previousSessionToken),
        this.now().toISOString(),
      );
    return {
      sessionToken: issued.sessionToken,
      csrfToken: issued.csrfToken,
      session,
      returnTo: "/workspace",
    };
  }

  async readSession(sessionToken: string | undefined): Promise<CplHostedSession | null> {
    if (!sessionToken || !/^[A-Za-z0-9_-]{43}$/u.test(sessionToken)) return null;
    const session = await this.store.readSession(
      hostedTokenHash(sessionToken),
      this.now().toISOString(),
    );
    return this.currentSession(session);
  }

  private currentSession(session: CplHostedSession | null): CplHostedSession | null {
    if (!session) return null;
    const expiresAt = Date.parse(session.expiresAt);
    const absoluteExpiresAt = Date.parse(session.absoluteExpiresAt);
    if (
      !Number.isFinite(expiresAt) ||
      !Number.isFinite(absoluteExpiresAt) ||
      expiresAt <= this.now().getTime() ||
      absoluteExpiresAt <= this.now().getTime() ||
      expiresAt > absoluteExpiresAt
    )
      return null;
    return session;
  }

  async requireSession(sessionToken: string | undefined): Promise<CplHostedSession> {
    const session = await this.readSession(sessionToken);
    if (!session) throw new CplHostedAuthenticationError();
    return session;
  }

  async requireMutation(input: {
    readonly request: Pick<Request, "headers">;
    readonly sessionToken: string | undefined;
    readonly csrfCookie: string | undefined;
  }): Promise<CplHostedSession> {
    assertHostedOrigin(input.request, this.origin);
    const supplied = input.request.headers.get("x-cpl-csrf") ?? "";
    if (!equalHostedToken(supplied, input.csrfCookie ?? ""))
      throw new CplHostedAuthenticationError("CPL_CSRF_REJECTED", 403);
    const session = await this.requireSession(input.sessionToken);
    if (
      !/^[a-f0-9]{64}$/u.test(session.csrfTokenHash) ||
      !timingSafeEqual(
        Buffer.from(hostedTokenHash(supplied), "hex"),
        Buffer.from(session.csrfTokenHash, "hex"),
      )
    )
      throw new CplHostedAuthenticationError("CPL_CSRF_REJECTED", 403);
    return session;
  }

  async renew(sessionToken: string): Promise<CplHostedSignInResult> {
    const session = await this.requireSession(sessionToken);
    await this.limit(`renew:${session.identityId}`, 30);
    const issued = this.material(session.absoluteExpiresAt);
    const rotated = await this.store.rotateSession({
      tokenHash: hostedTokenHash(sessionToken),
      material: issued.material,
      now: this.now().toISOString(),
    });
    return { sessionToken: issued.sessionToken, csrfToken: issued.csrfToken, session: rotated };
  }

  async signOut(sessionToken: string, allSessions = false): Promise<void> {
    await this.store.revokeSession(
      hostedTokenHash(sessionToken),
      this.now().toISOString(),
      allSessions,
    );
  }

  async selectOrganization(sessionToken: string, organizationId: string): Promise<void> {
    await this.requireSession(sessionToken);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        organizationId,
      )
    )
      throw new CplHostedAuthenticationError("CPL_ORGANIZATION_ACCESS_DENIED", 403);
    await this.store.selectOrganization(
      hostedTokenHash(sessionToken),
      organizationId.toLowerCase(),
      this.now().toISOString(),
    );
  }

  async hasPasskey(sessionToken: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(sessionToken)) throw new CplHostedAuthenticationError();
    const result = await this.store.readSessionWithPasskey(
      hostedTokenHash(sessionToken),
      this.now().toISOString(),
    );
    // Recheck expiry after the complete transaction, including the credential
    // read, rather than accepting a session that expired while awaiting SQL.
    if (!result || !this.currentSession(result.session)) throw new CplHostedAuthenticationError();
    return result.hasPasskey;
  }

  private async challenge(session: CplHostedSession, kind: CplHostedCeremony, challenge: string) {
    const ceremonyToken = token();
    await this.store.createChallenge({
      sessionId: session.id,
      ceremonyTokenHash: hostedTokenHash(ceremonyToken),
      kind,
      challenge,
      expiresAt: new Date(this.now().getTime() + CHALLENGE_TTL_MS).toISOString(),
    });
    return ceremonyToken;
  }

  private async consume(
    session: CplHostedSession,
    kind: CplHostedCeremony,
    ceremonyToken: string,
  ): Promise<string> {
    await this.limit(`passkey:verify:${session.identityId}`, 10);
    const challenge = await this.store.consumeChallenge({
      sessionId: session.id,
      ceremonyTokenHash: hostedTokenHash(ceremonyToken),
      kind,
      now: this.now().toISOString(),
    });
    if (!challenge) throw new CplHostedAuthenticationError("CPL_PASSKEY_CHALLENGE_REJECTED", 403);
    return challenge.challenge;
  }

  async registrationOptions(sessionToken: string) {
    const session = await this.requireSession(sessionToken);
    await this.limit(`passkey:options:${session.identityId}`, 10);
    const credentials = await this.store.listCredentials(session.identityId);
    const createdAt = Date.parse(session.createdAt);
    if (
      (credentials.length > 0 && hostedStepUpRequired(session, this.now())) ||
      (credentials.length === 0 &&
        (!Number.isFinite(createdAt) ||
          createdAt > this.now().getTime() ||
          this.now().getTime() - createdAt > CHALLENGE_TTL_MS))
    )
      throw new CplHostedAuthenticationError("CPL_FRESH_AUTHENTICATION_REQUIRED", 403);
    const { generateRegistrationOptions } = await loadWebAuthn();
    const options = await generateRegistrationOptions({
      rpName: "CPL Command Center",
      rpID: this.rpId,
      userID: new TextEncoder().encode(session.identityId),
      userName: session.email,
      userDisplayName: session.displayName,
      timeout: 60_000,
      attestationType: "none",
      supportedAlgorithmIDs: [-7, -257],
      excludeCredentials: credentials.map((credential) => ({ id: credential.id })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    });
    return {
      ceremonyToken: await this.challenge(session, "registration", options.challenge),
      options,
    };
  }

  async verifyRegistration(
    sessionToken: string,
    ceremonyToken: string,
    response: RegistrationResponseJSON,
  ): Promise<CplHostedSignInResult> {
    const session = await this.requireSession(sessionToken);
    const challenge = await this.consume(session, "registration", ceremonyToken);
    try {
      assertFirstPartyClientData(response.response.clientDataJSON);
      const { verifyRegistrationResponse } = await loadWebAuthn();
      const result = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpId,
        requireUserVerification: true,
        supportedAlgorithmIDs: [-7, -257],
      });
      if (!result.verified || !result.registrationInfo?.userVerified)
        throw new Error("User verification missing");
      const info = result.registrationInfo;
      const issued = this.material(session.absoluteExpiresAt);
      const verified = await this.store.completeRegistration({
        tokenHash: hostedTokenHash(sessionToken),
        credential: {
          id: info.credential.id,
          publicKey: Buffer.from(info.credential.publicKey).toString("base64url"),
          counter: info.credential.counter,
          transports: info.credential.transports ?? [],
          deviceType: info.credentialDeviceType,
          backedUp: info.credentialBackedUp,
        },
        material: issued.material,
        now: this.now().toISOString(),
      });
      return { sessionToken: issued.sessionToken, csrfToken: issued.csrfToken, session: verified };
    } catch {
      throw new CplHostedAuthenticationError("CPL_PASSKEY_VERIFICATION_REJECTED", 403);
    }
  }

  async authenticationOptions(sessionToken: string) {
    const session = await this.requireSession(sessionToken);
    await this.limit(`passkey:options:${session.identityId}`, 10);
    const credentials = await this.store.listCredentials(session.identityId);
    if (!credentials.length)
      throw new CplHostedAuthenticationError("CPL_PASSKEY_ENROLLMENT_REQUIRED", 403);
    const { generateAuthenticationOptions } = await loadWebAuthn();
    const options = await generateAuthenticationOptions({
      rpID: this.rpId,
      timeout: 60_000,
      userVerification: "required",
      allowCredentials: credentials.map((credential) => ({
        id: credential.id,
        transports: [...credential.transports] as AuthenticatorTransport[],
      })),
    });
    return {
      ceremonyToken: await this.challenge(session, "authentication", options.challenge),
      options,
    };
  }

  async verifyAuthentication(
    sessionToken: string,
    ceremonyToken: string,
    response: AuthenticationResponseJSON,
  ): Promise<CplHostedSignInResult> {
    const session = await this.requireSession(sessionToken);
    const challenge = await this.consume(session, "authentication", ceremonyToken);
    const credential = (await this.store.listCredentials(session.identityId)).find(
      (entry) => entry.id === response?.id,
    );
    if (!credential)
      throw new CplHostedAuthenticationError("CPL_PASSKEY_VERIFICATION_REJECTED", 403);
    try {
      assertFirstPartyClientData(response.response.clientDataJSON);
      if (
        response.response.userHandle &&
        response.response.userHandle !== Buffer.from(session.identityId).toString("base64url")
      )
        throw new Error("Credential identity mismatch");
      const { verifyAuthenticationResponse } = await loadWebAuthn();
      const result = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpId,
        requireUserVerification: true,
        credential: {
          id: credential.id,
          publicKey: new Uint8Array(Buffer.from(credential.publicKey, "base64url")),
          counter: credential.counter,
        },
      });
      if (!result.verified || !result.authenticationInfo.userVerified)
        throw new Error("User verification missing");
      const issued = this.material(session.absoluteExpiresAt);
      const verified = await this.store.completeAuthentication({
        tokenHash: hostedTokenHash(sessionToken),
        credentialId: credential.id,
        previousCounter: credential.counter,
        newCounter: result.authenticationInfo.newCounter,
        material: issued.material,
        now: this.now().toISOString(),
      });
      return { sessionToken: issued.sessionToken, csrfToken: issued.csrfToken, session: verified };
    } catch {
      throw new CplHostedAuthenticationError("CPL_PASSKEY_VERIFICATION_REJECTED", 403);
    }
  }
}
