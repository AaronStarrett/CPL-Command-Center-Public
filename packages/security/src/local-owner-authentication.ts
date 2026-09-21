import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";
import type {
  AuditEventInput,
  AuditSink,
  AuthenticatedUser,
  AuthenticationSession,
  Clock,
  UserDirectory,
} from "@bea/domain";
import {
  AuthenticationUnavailableError,
  type AuthenticatedSession,
  type RuntimeAuthenticationAdapter,
  type SessionCookieConfiguration,
  type SignInResult,
} from "./authentication.js";

export const LOCAL_OWNER_SESSION_COOKIE = "__Host-bea_session" as const;
export const LOCAL_OWNER_DISPLAY_NAME = "Workspace Owner";
export const LOCAL_OWNER_TITLE = "Chief Executive Officer";
export const LOCAL_OWNER_PASSWORD_MINIMUM_CHARACTERS = 14;

const SCRYPT_VERSION = 1;
const SCRYPT_N = 2 ** 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_MAX_MEMORY = 256 * 1024 * 1024;
const LOCAL_OWNER_USERNAME = /^[a-z][a-z0-9._-]{2,63}$/u;
const RECOVERY_CODE = /^bea-recovery-[A-Za-z0-9_-]{43}$/u;

const systemClock: Clock = { now: () => new Date() };

export interface LocalOwnerCredentialRecord {
  readonly userId: string;
  readonly username: string;
  readonly passwordHash: string;
  readonly recoveryCodeHash: string;
  readonly failedAttempts: number;
  readonly lockedUntil: string | null;
  readonly passwordChangedAt: string;
  readonly version: number;
}

export interface LocalOwnerAccountStore {
  /** SQL-backed stores use this capability to persist mandatory success audits atomically. */
  readonly recordsSuccessAuditAtomically?: true;
  findCredentialByUsername(username: string): Promise<LocalOwnerCredentialRecord | null>;
  provisionOwner(input: {
    readonly userId: string;
    readonly identityId: string;
    readonly username: string;
    readonly displayName: typeof LOCAL_OWNER_DISPLAY_NAME;
    readonly title: typeof LOCAL_OWNER_TITLE;
    readonly passwordHash: string;
    readonly recoveryCodeHash: string;
    readonly occurredAt: string;
    readonly successAudit?: AuditEventInput;
  }): Promise<void>;
  recordFailedAttempt(input: {
    readonly userId: string;
    readonly occurredAt: string;
    readonly failureLimit: number;
    readonly lockoutUntil: string;
  }): Promise<LocalOwnerCredentialRecord | null>;
  rotateOwnerSession(input: {
    readonly userId: string;
    readonly session: AuthenticationSession;
    readonly occurredAt: string;
  }): Promise<void>;
  completeRecovery(input: {
    readonly userId: string;
    readonly passwordHash: string;
    readonly recoveryCodeHash: string;
    readonly occurredAt: string;
    readonly successAudit?: AuditEventInput;
  }): Promise<void>;
  findSessionByTokenHash(tokenHash: string): Promise<AuthenticationSession | null>;
  revokeSession(sessionId: string, revokedAt: string): Promise<void>;
  touchSession(sessionId: string, seenAt: string): Promise<void>;
}

export interface LocalOwnerAuthenticationConfiguration {
  readonly deploymentProfile: "local-live";
  readonly sessionSecret: string;
  readonly sessionTtlMinutes: number;
  readonly failureLimit?: number;
  readonly lockoutMinutes?: number;
}

export interface LocalOwnerProvisioningResult {
  readonly userId: string;
  readonly username: string;
  readonly displayName: typeof LOCAL_OWNER_DISPLAY_NAME;
  readonly title: typeof LOCAL_OWNER_TITLE;
  /** One-time material. The caller must show it once and never log or persist the plaintext. */
  readonly recoveryCode: string;
  /** Configure may protect this verifier in its OS credential store; it is never a password. */
  readonly passwordHash: string;
  /** Configure may protect this verifier in its OS credential store; it is never a recovery code. */
  readonly recoveryCodeHash: string;
}

export interface LocalOwnerRecoveryResult {
  readonly recoveryCode: string;
}

export class LocalOwnerAuthenticationError extends Error {
  readonly code = "LOCAL_OWNER_AUTHENTICATION_FAILED";

  constructor() {
    super("Sign-in could not be completed.");
    this.name = "LocalOwnerAuthenticationError";
  }
}

export class LocalOwnerPasswordPolicyError extends Error {
  readonly code = "LOCAL_OWNER_PASSWORD_POLICY";

  constructor(message: string) {
    super(message);
    this.name = "LocalOwnerPasswordPolicyError";
  }
}

function deriveScrypt(
  password: string,
  salt: Uint8Array,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

export function normalizeLocalOwnerUsername(username: string): string {
  const normalized = username.normalize("NFKC").trim().toLowerCase();
  if (!LOCAL_OWNER_USERNAME.test(normalized)) {
    throw new LocalOwnerAuthenticationError();
  }
  return normalized;
}

export function assertLocalOwnerPassword(password: string): void {
  const length = Array.from(password).length;
  if (
    length < LOCAL_OWNER_PASSWORD_MINIMUM_CHARACTERS ||
    Buffer.byteLength(password, "utf8") > 1_024 ||
    password.trim().length < LOCAL_OWNER_PASSWORD_MINIMUM_CHARACTERS
  ) {
    throw new LocalOwnerPasswordPolicyError(
      `Use a passphrase of at least ${LOCAL_OWNER_PASSWORD_MINIMUM_CHARACTERS} characters.`,
    );
  }
}

export async function hashLocalOwnerPassword(password: string): Promise<string> {
  assertLocalOwnerPassword(password);
  const salt = randomBytes(16);
  const derived = await deriveScrypt(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAX_MEMORY,
  });
  return [
    "bea-scrypt",
    `v=${SCRYPT_VERSION}`,
    `N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P},l=${SCRYPT_KEY_LENGTH}`,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

interface ParsedPasswordHash {
  readonly salt: Buffer;
  readonly expected: Buffer;
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly keyLength: number;
}

function parsePasswordHash(encoded: string): ParsedPasswordHash | null {
  const parts = encoded.split("$");
  if (parts.length !== 5 || parts[0] !== "bea-scrypt" || parts[1] !== `v=${SCRYPT_VERSION}`) {
    return null;
  }
  const parameters = /^N=(\d+),r=(\d+),p=(\d+),l=(\d+)$/u.exec(parts[2] ?? "");
  if (!parameters) return null;
  const N = Number(parameters[1]);
  const r = Number(parameters[2]);
  const p = Number(parameters[3]);
  const keyLength = Number(parameters[4]);
  if (N !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P || keyLength !== SCRYPT_KEY_LENGTH) {
    return null;
  }
  try {
    const salt = Buffer.from(parts[3] ?? "", "base64url");
    const expected = Buffer.from(parts[4] ?? "", "base64url");
    return salt.length === 16 && expected.length === keyLength
      ? { salt, expected, N, r, p, keyLength }
      : null;
  } catch {
    return null;
  }
}

export async function verifyLocalOwnerPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const parsed = parsePasswordHash(encoded);
  if (!parsed) return false;
  const derived = await deriveScrypt(password, parsed.salt, parsed.keyLength, {
    N: parsed.N,
    r: parsed.r,
    p: parsed.p,
    maxmem: SCRYPT_MAX_MEMORY,
  });
  return timingSafeEqual(derived, parsed.expected);
}

export function generateLocalOwnerRecoveryCode(): string {
  return `bea-recovery-${randomBytes(32).toString("base64url")}`;
}

export function hashLocalOwnerRecoveryCode(recoveryCode: string): string {
  return createHash("sha256").update(recoveryCode, "utf8").digest("hex");
}

function verifyRecoveryCode(candidate: string, expectedHash: string): boolean {
  const normalized = candidate.trim();
  const candidateHash = hashLocalOwnerRecoveryCode(normalized);
  const left = Buffer.from(candidateHash, "hex");
  const right = /^[a-f0-9]{64}$/u.test(expectedHash)
    ? Buffer.from(expectedHash, "hex")
    : Buffer.alloc(32);
  return (
    RECOVERY_CODE.test(normalized) && left.length === right.length && timingSafeEqual(left, right)
  );
}

export function hashLocalOwnerSessionToken(token: string, sessionSecret: string): string {
  return createHmac("sha256", sessionSecret).update(token, "utf8").digest("hex");
}

function localOwnerCookieConfiguration(sessionTtlMinutes: number): SessionCookieConfiguration {
  return {
    name: LOCAL_OWNER_SESSION_COOKIE,
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAgeSeconds: sessionTtlMinutes * 60,
  };
}

let dummyPasswordHash: Promise<string> | undefined;
function getDummyPasswordHash(): Promise<string> {
  dummyPasswordHash ??= hashLocalOwnerPassword("This is not an owner credential.");
  return dummyPasswordHash;
}

export class LocalOwnerAuthenticationAdapter implements RuntimeAuthenticationAdapter {
  readonly kind = "local-owner" as const;
  readonly #failureLimit: number;
  readonly #lockoutMinutes: number;

  constructor(
    private readonly configuration: LocalOwnerAuthenticationConfiguration,
    private readonly users: UserDirectory,
    private readonly accounts: LocalOwnerAccountStore,
    private readonly audit: AuditSink,
    private readonly clock: Clock = systemClock,
  ) {
    if (
      configuration.deploymentProfile !== "local-live" ||
      configuration.sessionSecret.length < 64
    ) {
      throw new Error(
        "Local Owner authentication requires Local Live and a strong session secret.",
      );
    }
    this.#failureLimit = configuration.failureLimit ?? 5;
    this.#lockoutMinutes = configuration.lockoutMinutes ?? 15;
    if (this.#failureLimit < 3 || this.#failureLimit > 20 || this.#lockoutMinutes < 1) {
      throw new Error("Local Owner lockout configuration is invalid.");
    }
  }

  async provisionOwner(
    username: string,
    password: string,
    correlationId?: string,
  ): Promise<LocalOwnerProvisioningResult> {
    const normalizedUsername = normalizeLocalOwnerUsername(username);
    const passwordHash = await hashLocalOwnerPassword(password);
    const recoveryCode = generateLocalOwnerRecoveryCode();
    const recoveryCodeHash = hashLocalOwnerRecoveryCode(recoveryCode);
    const occurredAt = this.clock.now().toISOString();
    const userId = randomUUID();
    const successAudit: AuditEventInput = {
      eventType: "authentication.local-owner-provisioned",
      action: "local-owner.provision",
      outcome: "succeeded",
      actorUserId: userId,
      resourceType: "user",
      resourceId: userId,
      correlationId: correlationId ?? null,
      metadata: { provider: "local-owner" },
      createdAt: occurredAt,
    };
    await this.accounts.provisionOwner({
      userId,
      identityId: randomUUID(),
      username: normalizedUsername,
      displayName: LOCAL_OWNER_DISPLAY_NAME,
      title: LOCAL_OWNER_TITLE,
      passwordHash,
      recoveryCodeHash,
      occurredAt,
      successAudit,
    });
    if (this.accounts.recordsSuccessAuditAtomically !== true) {
      await this.audit.record(successAudit);
    }
    return {
      userId,
      username: normalizedUsername,
      displayName: LOCAL_OWNER_DISPLAY_NAME,
      title: LOCAL_OWNER_TITLE,
      recoveryCode,
      passwordHash,
      recoveryCodeHash,
    };
  }

  async signIn(username: string, password?: string, correlationId?: string): Promise<SignInResult> {
    let normalizedUsername: string | null = null;
    try {
      normalizedUsername = normalizeLocalOwnerUsername(username);
    } catch {
      // Continue through the same expensive verification path to resist account enumeration.
    }
    const credential = normalizedUsername
      ? await this.accounts.findCredentialByUsername(normalizedUsername)
      : null;
    const boundedPassword =
      password && Buffer.byteLength(password, "utf8") <= 1_024 ? password : "";
    const passwordMatches = await verifyLocalOwnerPassword(
      boundedPassword,
      credential?.passwordHash ?? (await getDummyPasswordHash()),
    );
    const now = this.clock.now();
    const locked = credential?.lockedUntil
      ? Date.parse(credential.lockedUntil) > now.getTime()
      : false;
    if (!credential || !passwordMatches || locked) {
      if (credential && !locked) {
        await this.accounts.recordFailedAttempt({
          userId: credential.userId,
          occurredAt: now.toISOString(),
          failureLimit: this.#failureLimit,
          lockoutUntil: new Date(now.getTime() + this.#lockoutMinutes * 60_000).toISOString(),
        });
      }
      await this.audit.record({
        eventType: "authentication.sign-in-denied",
        action: "local-owner.sign-in",
        outcome: "denied",
        actorUserId: credential?.userId ?? null,
        correlationId: correlationId ?? null,
        metadata: { reason: locked ? "temporarily-locked" : "invalid-credentials" },
        createdAt: now.toISOString(),
      });
      throw new LocalOwnerAuthenticationError();
    }
    const user = await this.users.findActiveUserById(credential.userId);
    if (!user) {
      await this.audit.record({
        eventType: "authentication.sign-in-denied",
        action: "local-owner.sign-in",
        outcome: "denied",
        actorUserId: credential.userId,
        correlationId: correlationId ?? null,
        metadata: { reason: "identity-unavailable" },
        createdAt: now.toISOString(),
      });
      throw new LocalOwnerAuthenticationError();
    }
    const sessionToken = randomBytes(32).toString("base64url");
    const session: AuthenticationSession = {
      id: randomUUID(),
      userId: user.id,
      tokenHash: hashLocalOwnerSessionToken(sessionToken, this.configuration.sessionSecret),
      expiresAt: new Date(
        now.getTime() + this.configuration.sessionTtlMinutes * 60_000,
      ).toISOString(),
      revokedAt: null,
      lastSeenAt: now.toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      version: 1,
    };
    await this.accounts.rotateOwnerSession({
      userId: user.id,
      session,
      occurredAt: now.toISOString(),
    });
    await this.audit.record({
      eventType: "authentication.signed-in",
      action: "local-owner.sign-in",
      outcome: "succeeded",
      actorUserId: user.id,
      resourceType: "session",
      resourceId: session.id,
      correlationId: correlationId ?? null,
      metadata: { provider: "local-owner" },
      createdAt: now.toISOString(),
    });
    return {
      user,
      sessionToken,
      session,
      cookie: localOwnerCookieConfiguration(this.configuration.sessionTtlMinutes),
    };
  }

  async readSession(sessionToken: string): Promise<AuthenticatedSession | null> {
    const session = await this.accounts.findSessionByTokenHash(
      hashLocalOwnerSessionToken(sessionToken, this.configuration.sessionSecret),
    );
    const now = this.clock.now();
    if (!session || session.revokedAt || Date.parse(session.expiresAt) <= now.getTime())
      return null;
    const user = await this.users.findActiveUserById(session.userId);
    if (!user) return null;
    await this.accounts.touchSession(session.id, now.toISOString());
    return { user, session: { ...session, lastSeenAt: now.toISOString() } };
  }

  async authenticate(sessionToken: string): Promise<AuthenticatedUser | null> {
    return (await this.readSession(sessionToken))?.user ?? null;
  }

  async signOut(sessionToken: string, correlationId?: string): Promise<boolean> {
    const session = await this.accounts.findSessionByTokenHash(
      hashLocalOwnerSessionToken(sessionToken, this.configuration.sessionSecret),
    );
    if (!session || session.revokedAt) return false;
    const occurredAt = this.clock.now().toISOString();
    await this.accounts.revokeSession(session.id, occurredAt);
    await this.audit.record({
      eventType: "authentication.signed-out",
      action: "local-owner.sign-out",
      outcome: "succeeded",
      actorUserId: session.userId,
      resourceType: "session",
      resourceId: session.id,
      correlationId: correlationId ?? null,
      createdAt: occurredAt,
    });
    return true;
  }

  async switchPersona(): Promise<never> {
    throw new AuthenticationUnavailableError(
      "Persona switching is only available in the Demo authentication provider.",
    );
  }

  async recoverOwner(
    username: string,
    recoveryCode: string,
    newPassword: string,
    correlationId?: string,
  ): Promise<LocalOwnerRecoveryResult> {
    assertLocalOwnerPassword(newPassword);
    let normalizedUsername: string | null = null;
    try {
      normalizedUsername = normalizeLocalOwnerUsername(username);
    } catch {
      // Use the same generic denial surface below.
    }
    const credential = normalizedUsername
      ? await this.accounts.findCredentialByUsername(normalizedUsername)
      : null;
    const candidateMatches = verifyRecoveryCode(
      recoveryCode,
      credential?.recoveryCodeHash ?? "0".repeat(64),
    );
    const now = this.clock.now();
    const locked = credential?.lockedUntil
      ? Date.parse(credential.lockedUntil) > now.getTime()
      : false;
    if (!credential || !candidateMatches) {
      if (credential && !locked) {
        await this.accounts.recordFailedAttempt({
          userId: credential.userId,
          occurredAt: now.toISOString(),
          failureLimit: this.#failureLimit,
          lockoutUntil: new Date(now.getTime() + this.#lockoutMinutes * 60_000).toISOString(),
        });
      }
      await this.audit.record({
        eventType: "authentication.recovery-denied",
        action: "local-owner.recover",
        outcome: "denied",
        actorUserId: credential?.userId ?? null,
        correlationId: correlationId ?? null,
        metadata: { reason: locked ? "temporarily-locked" : "invalid-recovery" },
        createdAt: now.toISOString(),
      });
      throw new LocalOwnerAuthenticationError();
    }
    const nextRecoveryCode = generateLocalOwnerRecoveryCode();
    const successAudit: AuditEventInput = {
      eventType: "authentication.recovered",
      action: "local-owner.recover",
      outcome: "succeeded",
      actorUserId: credential.userId,
      resourceType: "user",
      resourceId: credential.userId,
      correlationId: correlationId ?? null,
      metadata: { sessionsRevoked: true },
      createdAt: now.toISOString(),
    };
    await this.accounts.completeRecovery({
      userId: credential.userId,
      passwordHash: await hashLocalOwnerPassword(newPassword),
      recoveryCodeHash: hashLocalOwnerRecoveryCode(nextRecoveryCode),
      occurredAt: now.toISOString(),
      successAudit,
    });
    if (this.accounts.recordsSuccessAuditAtomically !== true) {
      await this.audit.record(successAudit);
    }
    return { recoveryCode: nextRecoveryCode };
  }
}
