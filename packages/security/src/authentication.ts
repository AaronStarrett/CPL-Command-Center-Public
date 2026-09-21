import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  AuditSink,
  AuthenticatedUser,
  AuthenticationSession,
  Clock,
  SessionStore,
  UserDirectory,
} from "@bea/domain";

export interface DemoAuthenticationConfiguration {
  readonly appMode: "demo" | "production";
  readonly enabled: boolean;
  readonly sessionTtlMinutes: number;
  readonly secureCookies: boolean;
}

export interface SessionCookieConfiguration {
  readonly name: "bea_session" | "__Host-bea_session";
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: "lax" | "strict";
  readonly path: "/";
  readonly maxAgeSeconds: number;
}

export interface AuthenticatedSession {
  readonly user: AuthenticatedUser;
  readonly session: AuthenticationSession;
}

export interface SignInResult {
  readonly user: AuthenticatedUser;
  readonly sessionToken: string;
  readonly session: AuthenticationSession;
  readonly cookie: SessionCookieConfiguration;
}

export interface TokenGenerator {
  createSessionId(): string;
  createSessionToken(): string;
}

export interface RuntimeAuthenticationAdapter {
  readonly kind: "demo" | "local-owner" | "microsoft-entra";
  signIn(
    identifier: string,
    credentialOrCorrelationId?: string,
    correlationId?: string,
  ): Promise<SignInResult>;
  readSession(sessionToken: string): Promise<AuthenticatedSession | null>;
  authenticate(sessionToken: string): Promise<AuthenticatedUser | null>;
  signOut(sessionToken: string, correlationId?: string): Promise<boolean>;
  switchPersona(
    currentSessionToken: string,
    nextPersonaKey: string,
    correlationId?: string,
  ): Promise<SignInResult>;
}

export interface ExternalAuthenticationAdapter extends RuntimeAuthenticationAdapter {
  readonly kind: "microsoft-entra";
  readonly connected: false;
  beginSignIn(): Promise<never>;
}

export class AuthenticationUnavailableError extends Error {
  readonly code = "AUTHENTICATION_UNAVAILABLE";

  constructor(message: string) {
    super(message);
    this.name = "AuthenticationUnavailableError";
  }
}

const systemClock: Clock = { now: () => new Date() };
const secureTokens: TokenGenerator = {
  createSessionId: () => randomUUID(),
  createSessionToken: () => randomBytes(32).toString("base64url"),
};

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function sessionCookieConfiguration(
  configuration: DemoAuthenticationConfiguration,
): SessionCookieConfiguration {
  return {
    name: "bea_session",
    httpOnly: true,
    secure: configuration.secureCookies,
    sameSite: "lax",
    path: "/",
    maxAgeSeconds: configuration.sessionTtlMinutes * 60,
  };
}

export class DemoAuthenticationAdapter implements RuntimeAuthenticationAdapter {
  readonly kind = "demo" as const;

  constructor(
    private readonly configuration: DemoAuthenticationConfiguration,
    private readonly users: UserDirectory,
    private readonly sessions: SessionStore,
    private readonly audit: AuditSink,
    private readonly clock: Clock = systemClock,
    private readonly tokens: TokenGenerator = secureTokens,
  ) {}

  private assertEnabled(): void {
    if (
      process.env.NODE_ENV !== "test" ||
      this.configuration.appMode !== "demo" ||
      !this.configuration.enabled
    ) {
      throw new AuthenticationUnavailableError(
        "Demo authentication requires explicit demo mode in an isolated NODE_ENV=test harness.",
      );
    }
  }

  async signIn(
    personaKey: string,
    correlationIdOrCredential?: string,
    explicitCorrelationId?: string,
  ): Promise<SignInResult> {
    const correlationId = explicitCorrelationId ?? correlationIdOrCredential;
    this.assertEnabled();
    const user = await this.users.findActiveUserByPersonaKey(personaKey);
    if (!user) {
      await this.audit.record({
        eventType: "authentication.sign-in-denied",
        action: "demo.sign-in",
        outcome: "denied",
        correlationId: correlationId ?? null,
        metadata: { personaKey, reason: "persona-not-found" },
      });
      throw new AuthenticationUnavailableError("The selected demo persona is unavailable.");
    }

    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + this.configuration.sessionTtlMinutes * 60_000);
    const sessionToken = this.tokens.createSessionToken();
    const session: AuthenticationSession = {
      id: this.tokens.createSessionId(),
      userId: user.id,
      tokenHash: hashSessionToken(sessionToken),
      expiresAt: expiresAt.toISOString(),
      revokedAt: null,
      lastSeenAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      version: 1,
    };
    await this.sessions.createSession(session);
    await this.audit.record({
      eventType: "authentication.signed-in",
      action: "demo.sign-in",
      outcome: "succeeded",
      actorUserId: user.id,
      resourceType: "session",
      resourceId: session.id,
      correlationId: correlationId ?? null,
      metadata: { personaKey },
      createdAt: now.toISOString(),
    });

    return {
      user,
      sessionToken,
      session,
      cookie: sessionCookieConfiguration(this.configuration),
    };
  }

  async authenticate(sessionToken: string): Promise<AuthenticatedUser | null> {
    return (await this.readSession(sessionToken))?.user ?? null;
  }

  async readSession(sessionToken: string): Promise<AuthenticatedSession | null> {
    this.assertEnabled();
    const session = await this.sessions.findSessionByTokenHash(hashSessionToken(sessionToken));
    if (
      !session ||
      session.revokedAt ||
      Date.parse(session.expiresAt) <= this.clock.now().getTime()
    ) {
      return null;
    }
    const user = await this.users.findActiveUserById(session.userId);
    return user ? { user, session } : null;
  }

  async signOut(sessionToken: string, correlationId?: string): Promise<boolean> {
    this.assertEnabled();
    const session = await this.sessions.findSessionByTokenHash(hashSessionToken(sessionToken));
    if (!session || session.revokedAt) {
      return false;
    }
    const now = this.clock.now().toISOString();
    await this.sessions.revokeSession(session.id, now);
    await this.audit.record({
      eventType: "authentication.signed-out",
      action: "demo.sign-out",
      outcome: "succeeded",
      actorUserId: session.userId,
      resourceType: "session",
      resourceId: session.id,
      correlationId: correlationId ?? null,
      createdAt: now,
    });
    return true;
  }

  async switchPersona(
    currentSessionToken: string,
    nextPersonaKey: string,
    correlationId?: string,
  ): Promise<SignInResult> {
    const current = await this.sessions.findSessionByTokenHash(
      hashSessionToken(currentSessionToken),
    );
    const now = this.clock.now();
    if (!current || current.revokedAt || Date.parse(current.expiresAt) <= now.getTime()) {
      await this.audit.record({
        eventType: "authentication.persona-switch-denied",
        action: "demo.switch-persona",
        outcome: "denied",
        actorUserId: current?.userId ?? null,
        resourceType: "session",
        resourceId: current?.id ?? null,
        correlationId: correlationId ?? null,
        metadata: { reason: "active-session-required", nextPersonaKey },
        createdAt: now.toISOString(),
      });
      throw new AuthenticationUnavailableError(
        "An active demo session is required to switch personas.",
      );
    }
    const signedOut = await this.signOut(currentSessionToken, correlationId);
    if (!signedOut)
      throw new AuthenticationUnavailableError("The current demo session could not be rotated.");
    const next = await this.signIn(nextPersonaKey, correlationId);
    await this.audit.record({
      eventType: "authentication.persona-switched",
      action: "demo.switch-persona",
      outcome: "succeeded",
      actorUserId: next.user.id,
      resourceType: "session",
      resourceId: next.session.id,
      correlationId: correlationId ?? null,
      metadata: { previousUserId: current?.userId ?? null, nextPersonaKey },
    });
    return next;
  }
}

export const microsoftEntraAuthenticationSeam: ExternalAuthenticationAdapter = {
  kind: "microsoft-entra",
  connected: false,
  async beginSignIn(): Promise<never> {
    throw new AuthenticationUnavailableError(
      "Microsoft Entra authentication is deferred until tenant configuration is supplied.",
    );
  },
  async signIn(): Promise<never> {
    return this.beginSignIn();
  },
  async readSession(): Promise<null> {
    return null;
  },
  async authenticate(): Promise<null> {
    return null;
  },
  async signOut(): Promise<false> {
    return false;
  },
  async switchPersona(): Promise<never> {
    throw new AuthenticationUnavailableError(
      "Persona switching is only available in the Demo authentication provider.",
    );
  },
};
