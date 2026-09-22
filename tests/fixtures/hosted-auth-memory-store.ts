import { randomUUID } from "node:crypto";
import { CplHostedAuthenticationError } from "../../packages/security/src/google-oidc";
import type {
  CplHostedAuthStore,
  CplHostedCredential,
  CplHostedOAuthFlow,
  CplHostedSession,
} from "../../packages/security/src/hosted-authentication-contracts";

/** Isolated protocol test double. Real locking, RLS and owner provisioning are
 * covered separately against PostgreSQL; this is never a runtime auth adapter. */
export class HostedAuthMemoryStore implements CplHostedAuthStore {
  readonly sessions = new Map<string, CplHostedSession>();
  readonly credentials = new Map<string, CplHostedCredential[]>();
  readonly flows = new Map<string, CplHostedOAuthFlow>();
  readonly challenges = new Map<string, Parameters<CplHostedAuthStore["createChallenge"]>[0]>();
  readonly identityId = randomUUID();
  allowRate = true;
  createOAuthFlow = async (flow: CplHostedOAuthFlow) => {
    this.flows.set(flow.stateHash, flow);
  };
  consumeOAuthFlow = async (input: Parameters<CplHostedAuthStore["consumeOAuthFlow"]>[0]) => {
    const flow = this.flows.get(input.stateHash);
    if (
      !flow ||
      flow.browserBindingHash !== input.browserBindingHash ||
      flow.expiresAt <= input.now
    )
      return null;
    this.flows.delete(input.stateHash);
    return flow;
  };
  createSession = async (input: Parameters<CplHostedAuthStore["createSession"]>[0]) => {
    const session: CplHostedSession = {
      id: randomUUID(),
      identityId: this.identityId,
      issuer: input.identity.issuer,
      subject: input.identity.subject,
      email: input.identity.email,
      displayName: input.identity.displayName,
      createdAt: input.now,
      authenticatedAt: input.identity.authenticatedAt,
      expiresAt: input.material.expiresAt,
      absoluteExpiresAt: input.material.absoluteExpiresAt,
      mfaVerifiedAt: null,
      selectedOrganizationId: null,
      csrfTokenHash: input.material.csrfTokenHash,
      platformAdministrator: false,
    };
    this.sessions.set(input.material.tokenHash, session);
    return session;
  };
  readSession = async (hash: string) => this.sessions.get(hash) ?? null;
  readSessionWithPasskey = async (hash: string) => {
    const session = this.sessions.get(hash);
    return session
      ? { session, hasPasskey: (this.credentials.get(session.identityId)?.length ?? 0) > 0 }
      : null;
  };
  rotateSession = async (input: Parameters<CplHostedAuthStore["rotateSession"]>[0]) => {
    const previous = this.sessions.get(input.tokenHash);
    if (!previous) throw new CplHostedAuthenticationError();
    const session = { ...previous, ...input.material, id: randomUUID() };
    this.sessions.delete(input.tokenHash);
    this.sessions.set(input.material.tokenHash, session);
    return session;
  };
  revokeSession = async (hash: string) => {
    this.sessions.delete(hash);
  };
  selectOrganization = async () => {
    throw new CplHostedAuthenticationError("CPL_ORGANIZATION_ACCESS_DENIED", 403);
  };
  listCredentials = async (identityId: string) => this.credentials.get(identityId) ?? [];
  createChallenge = async (input: Parameters<CplHostedAuthStore["createChallenge"]>[0]) => {
    this.challenges.set(input.ceremonyTokenHash, input);
  };
  consumeChallenge = async (input: Parameters<CplHostedAuthStore["consumeChallenge"]>[0]) => {
    const item = this.challenges.get(input.ceremonyTokenHash);
    if (
      !item ||
      item.sessionId !== input.sessionId ||
      item.kind !== input.kind ||
      item.expiresAt <= input.now
    )
      return null;
    this.challenges.delete(input.ceremonyTokenHash);
    return { challenge: item.challenge };
  };
  completeRegistration = async (
    input: Parameters<CplHostedAuthStore["completeRegistration"]>[0],
  ) => {
    const session = this.sessions.get(input.tokenHash);
    if (!session) throw new CplHostedAuthenticationError();
    this.credentials.set(session.identityId, [
      ...(await this.listCredentials(session.identityId)),
      input.credential,
    ]);
    return this.rotateSession(input);
  };
  completeAuthentication = async (
    input: Parameters<CplHostedAuthStore["completeAuthentication"]>[0],
  ) => {
    const session = this.sessions.get(input.tokenHash);
    if (!session) throw new CplHostedAuthenticationError();
    const credentials = await this.listCredentials(session.identityId);
    const credential = credentials.find((item) => item.id === input.credentialId);
    if (!credential || credential.counter !== input.previousCounter)
      throw new CplHostedAuthenticationError();
    this.credentials.set(
      session.identityId,
      credentials.map((item) =>
        item === credential ? { ...item, counter: input.newCounter } : item,
      ),
    );
    this.sessions.set(input.tokenHash, { ...session, mfaVerifiedAt: input.now });
    return this.rotateSession(input);
  };
  consumeRateLimit = async () => this.allowRate;
}
