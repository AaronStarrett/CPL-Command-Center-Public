/** Server-only persistence port. Browser inputs must pass the hosted authentication
 * service before reaching these methods. Every completion/rotation must revalidate
 * the live session and identity atomically; no caller-supplied identity is trusted. */
export interface CplHostedIdentity {
  readonly issuer: "https://accounts.google.com";
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: true;
  readonly hostedDomain: string | null;
  readonly displayName: string;
  readonly authenticatedAt: string;
  readonly expiresAt: string;
}

export interface CplHostedSession {
  readonly id: string;
  readonly identityId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly email: string;
  readonly displayName: string;
  readonly createdAt: string;
  readonly authenticatedAt: string;
  readonly expiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly mfaVerifiedAt: string | null;
  readonly selectedOrganizationId: string | null;
  readonly csrfTokenHash: string;
  readonly platformAdministrator: boolean;
}

export interface CplHostedSessionMaterial {
  readonly tokenHash: string;
  readonly csrfTokenHash: string;
  readonly expiresAt: string;
  readonly absoluteExpiresAt: string;
}

export interface CplHostedOAuthFlow {
  readonly browserBindingHash: string;
  readonly stateHash: string;
  readonly nonce: string;
  readonly pkceVerifier: string;
  readonly returnTo: string;
  readonly expiresAt: string;
}

export interface CplHostedCredential {
  readonly id: string;
  readonly publicKey: string;
  readonly counter: number;
  readonly transports: readonly string[];
  readonly deviceType: "singleDevice" | "multiDevice";
  readonly backedUp: boolean;
}

export type CplHostedCeremony = "registration" | "authentication";

export interface CplHostedAuthStore {
  createOAuthFlow(flow: CplHostedOAuthFlow): Promise<void>;
  /** Atomically consume only an unexpired exact state AND browser binding match. */
  consumeOAuthFlow(input: {
    readonly browserBindingHash: string;
    readonly stateHash: string;
    readonly now: string;
  }): Promise<CplHostedOAuthFlow | null>;
  /** OAuth creates an MFA-unverified session, never a platform administrator. */
  createSession(input: {
    readonly identity: CplHostedIdentity;
    readonly material: CplHostedSessionMaterial;
    readonly now: string;
  }): Promise<CplHostedSession>;
  readSession(tokenHash: string, now: string): Promise<CplHostedSession | null>;
  /** Fresh session/organization representation and active-identity credential
   * existence share one transaction; this never returns credential material. */
  readSessionWithPasskey(
    tokenHash: string,
    now: string,
  ): Promise<{
    readonly session: CplHostedSession;
    readonly hasPasskey: boolean;
  } | null>;
  rotateSession(input: {
    readonly tokenHash: string;
    readonly material: CplHostedSessionMaterial;
    readonly now: string;
  }): Promise<CplHostedSession>;
  revokeSession(tokenHash: string, now: string, allSessions?: boolean): Promise<void>;
  /** Validate active membership before persisting the selection in the session. */
  selectOrganization(tokenHash: string, organizationId: string, now: string): Promise<void>;
  listCredentials(identityId: string): Promise<readonly CplHostedCredential[]>;
  createChallenge(input: {
    readonly sessionId: string;
    readonly ceremonyTokenHash: string;
    readonly kind: CplHostedCeremony;
    readonly challenge: string;
    readonly expiresAt: string;
  }): Promise<void>;
  consumeChallenge(input: {
    readonly sessionId: string;
    readonly ceremonyTokenHash: string;
    readonly kind: CplHostedCeremony;
    readonly now: string;
  }): Promise<{ readonly challenge: string } | null>;
  /** Atomically add credential and rotate/revoke old session, preserving MFA.
   * Registration with attestation:none is not a signed possession proof and must
   * never set recent MFA or provision an administrator. A second credential
   * requires pre-existing recent MFA under row lock; first enrollment must be
   * within five minutes of the original Google session creation. */
  completeRegistration(input: {
    readonly tokenHash: string;
    readonly credential: CplHostedCredential;
    readonly material: CplHostedSessionMaterial;
    readonly now: string;
  }): Promise<CplHostedSession>;
  /** Compare-and-update the credential counter under lock, rotate the session,
   * and set MFA time only after cryptographically verified user verification.
   * Owner provisioning requires exact verified owner email + Workspace domain,
   * then immutable singleton identity binding; never an arbitrary first user. */
  completeAuthentication(input: {
    readonly tokenHash: string;
    readonly credentialId: string;
    readonly previousCounter: number;
    readonly newCounter: number;
    readonly material: CplHostedSessionMaterial;
    readonly now: string;
  }): Promise<CplHostedSession>;
  /** Durable per-session/flow limiter, with bounded windows; never an IP header
   * supplied by the browser as the sole privileged-action limit. */
  consumeRateLimit(input: {
    readonly key: string;
    readonly limit: number;
    readonly windowSeconds: number;
    readonly now: string;
  }): Promise<boolean>;
}

export const CPL_HOSTED_OWNER_EMAIL = "astarrett@cyberpiratelabs.com";
export const CPL_HOSTED_OWNER_DOMAIN = "cyberpiratelabs.com";
export const CPL_HOSTED_MFA_MAX_AGE_MS = 15 * 60_000;
