import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  CplHostedAuthService,
  hostedStepUpRequired,
} from "../../packages/security/src/hosted-authentication";
import { hostedTokenHash } from "../../packages/security/src/google-oidc";
import { HostedAuthMemoryStore } from "../fixtures/hosted-auth-memory-store";
import { softwareAuthenticator } from "../fixtures/signed-webauthn";

const origin = "https://command.example.test";
async function setup() {
  let now = new Date("2026-09-21T18:00:00Z");
  const store = new HostedAuthMemoryStore();
  const oidc = {
    authorizationUrl: vi.fn(
      (input: { state: string; nonce: string; verifier: string }) =>
        `https://accounts.google.com/?state=${input.state}`,
    ),
    exchangeCode: vi.fn(async () => ({
      issuer: "https://accounts.google.com" as const,
      subject: "synthetic-google-subject",
      email: "owner@example.test",
      emailVerified: true as const,
      hostedDomain: "example.test",
      displayName: "Synthetic Owner",
      authenticatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
    })),
  };
  const service = new CplHostedAuthService(store, oidc, { appOrigin: origin, now: () => now });
  const begin = await service.beginSignIn("https://attacker.example.test");
  const state = new URL(begin.authorizationUrl).searchParams.get("state")!;
  const callback = { browserBinding: begin.browserBinding, state, code: "synthetic-code" };
  const signedIn = await service.finishSignIn(callback);
  return {
    service,
    store,
    oidc,
    callback,
    signedIn,
    now: () => now,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

async function enrolled() {
  const context = await setup();
  const authenticator = softwareAuthenticator();
  const options = await context.service.registrationOptions(context.signedIn.sessionToken);
  const registration = await context.service.verifyRegistration(
    context.signedIn.sessionToken,
    options.ceremonyToken,
    authenticator.registration(options.options.challenge, origin),
  );
  return { ...context, authenticator, registration };
}

describe("Hosted sessions and CSRF", () => {
  it("passkey existence uses a second fresh session without loading credential material", async () => {
    const { service, store, signedIn } = await setup();
    expect(await service.readSession(signedIn.sessionToken)).not.toBeNull();
    const composite = vi.spyOn(store, "readSessionWithPasskey");
    const credentials = vi.spyOn(store, "listCredentials");
    expect(await service.hasPasskey(signedIn.sessionToken)).toBe(false);
    expect(composite).toHaveBeenCalledExactlyOnceWith(
      hostedTokenHash(signedIn.sessionToken),
      expect.any(String),
    );
    expect(credentials).not.toHaveBeenCalled();
    await store.revokeSession(hostedTokenHash(signedIn.sessionToken));
    await expect(service.hasPasskey(signedIn.sessionToken)).rejects.toThrow(
      "CPL_AUTHENTICATION_REQUIRED",
    );
  });

  it("passkey session expiry is rechecked after the whole composite resolves", async () => {
    const { service, store, signedIn, advance } = await setup();
    const read = store.readSessionWithPasskey;
    vi.spyOn(store, "readSessionWithPasskey").mockImplementation(async (hash) => {
      const result = await read(hash);
      advance(60 * 60_000);
      return result;
    });
    await expect(service.hasPasskey(signedIn.sessionToken)).rejects.toThrow(
      "CPL_AUTHENTICATION_REQUIRED",
    );
  });

  it.each(["expiresAt", "absoluteExpiresAt"] as const)(
    "composite rejects invalid %s and malformed tokens",
    async (field) => {
      const { service, store, signedIn } = await setup();
      const read = vi.spyOn(store, "readSessionWithPasskey");
      await expect(service.hasPasskey("malformed")).rejects.toThrow("CPL_AUTHENTICATION_REQUIRED");
      expect(read).not.toHaveBeenCalled();
      store.sessions.set(hostedTokenHash(signedIn.sessionToken), {
        ...signedIn.session,
        [field]: "invalid-time",
      });
      await expect(service.hasPasskey(signedIn.sessionToken)).rejects.toThrow(
        "CPL_AUTHENTICATION_REQUIRED",
      );
    },
  );

  it("binds and consumes OAuth state once, creates no MFA/admin, and rejects external return targets", async () => {
    const context = await setup();
    expect(context.signedIn.returnTo).toBe("/workspace");
    expect(context.signedIn.session).toMatchObject({
      mfaVerifiedAt: null,
      platformAdministrator: false,
      selectedOrganizationId: null,
    });
    expect(context.signedIn.sessionToken).toHaveLength(43);
    expect(context.store.sessions.has(context.signedIn.sessionToken)).toBe(false);
    await expect(context.service.finishSignIn(context.callback)).rejects.toMatchObject({
      code: "CPL_OAUTH_STATE_REJECTED",
    });
    expect(context.oidc.exchangeCode).toHaveBeenCalledTimes(1);
  });

  it("rejects a callback from another browser before provider exchange", async () => {
    const { service, oidc } = await setup();
    const begin = await service.beginSignIn();
    const state = new URL(begin.authorizationUrl).searchParams.get("state")!;
    await expect(
      service.finishSignIn({
        state,
        browserBinding: randomBytes(32).toString("base64url"),
        code: "synthetic-code",
      }),
    ).rejects.toThrow();
    expect(oidc.exchangeCode).toHaveBeenCalledTimes(1);
  });

  it.each([
    "foreign origin",
    "missing origin",
    "cross-site",
    "cookie mismatch",
    "stored hash mismatch",
  ])("rejects mutations with %s", async (kind) => {
    const { service, store, signedIn } = await setup();
    const headers = new Headers({
      origin,
      "sec-fetch-site": "same-origin",
      "x-cpl-csrf": signedIn.csrfToken,
    });
    if (kind === "foreign origin") headers.set("origin", "https://attacker.example.test");
    if (kind === "missing origin") headers.delete("origin");
    if (kind === "cross-site") headers.set("sec-fetch-site", "cross-site");
    if (kind === "stored hash mismatch")
      store.sessions.set(hostedTokenHash(signedIn.sessionToken), {
        ...signedIn.session,
        csrfTokenHash: "a".repeat(64),
      });
    await expect(
      service.requireMutation({
        request: { headers },
        sessionToken: signedIn.sessionToken,
        csrfCookie: kind === "cookie mismatch" ? "x".repeat(43) : signedIn.csrfToken,
      }),
    ).rejects.toMatchObject({ code: "CPL_CSRF_REJECTED", status: 403 });
  });

  it("accepts bound CSRF and rotates both opaque tokens without extending absolute expiry", async () => {
    const { service, signedIn, advance } = await setup();
    expect(
      (
        await service.requireMutation({
          request: { headers: new Headers({ origin, "x-cpl-csrf": signedIn.csrfToken }) },
          sessionToken: signedIn.sessionToken,
          csrfCookie: signedIn.csrfToken,
        })
      ).id,
    ).toBe(signedIn.session.id);
    advance(20 * 60_000);
    const renewed = await service.renew(signedIn.sessionToken);
    expect(renewed.sessionToken).not.toBe(signedIn.sessionToken);
    expect(renewed.csrfToken).not.toBe(signedIn.csrfToken);
    expect(renewed.session.absoluteExpiresAt).toBe(signedIn.session.absoluteExpiresAt);
    expect(renewed.session.createdAt).toBe(signedIn.session.createdAt);
    expect(await service.readSession(signedIn.sessionToken)).toBeNull();
    await service.signOut(renewed.sessionToken);
    expect(await service.readSession(renewed.sessionToken)).toBeNull();
  });

  it.each(["expired", "malformed", "beyond absolute"])(
    "fails closed on %s session expiry",
    async (kind) => {
      const { service, store, signedIn, now } = await setup();
      const expiresAt =
        kind === "expired"
          ? now().toISOString()
          : kind === "malformed"
            ? "not-a-date"
            : new Date(Date.parse(signedIn.session.absoluteExpiresAt) + 1).toISOString();
      store.sessions.set(hostedTokenHash(signedIn.sessionToken), {
        ...signedIn.session,
        expiresAt,
      });
      expect(await service.readSession(signedIn.sessionToken)).toBeNull();
      await expect(service.registrationOptions(signedIn.sessionToken)).rejects.toThrow();
    },
  );

  it("honors a persistent limiter refusal and membership denial", async () => {
    const { service, store, signedIn } = await setup();
    store.allowRate = false;
    await expect(service.beginSignIn()).rejects.toMatchObject({ status: 429 });
    await expect(
      service.selectOrganization(signedIn.sessionToken, "7b99be2d-7d8b-45eb-8b36-45e41de7dc51"),
    ).rejects.toMatchObject({ code: "CPL_ORGANIZATION_ACCESS_DENIED" });
  });
});

describe("Passkey cryptographic step-up", () => {
  it("enrolls without MFA, then verifies a real signed UV assertion and rotates the session", async () => {
    const { service, signedIn, registration, authenticator, now } = await enrolled();
    expect(registration.session.mfaVerifiedAt).toBeNull();
    expect(registration.session.platformAdministrator).toBe(false);
    expect(hostedStepUpRequired(registration.session, now())).toBe(true);
    expect(await service.readSession(signedIn.sessionToken)).toBeNull();
    const options = await service.authenticationOptions(registration.sessionToken);
    expect(options.options).toMatchObject({
      rpId: new URL(origin).hostname,
      userVerification: "required",
    });
    const response = authenticator.authentication(
      options.options.challenge,
      origin,
      registration.session.identityId,
    );
    const verified = await service.verifyAuthentication(
      registration.sessionToken,
      options.ceremonyToken,
      response,
    );
    expect(verified.session.mfaVerifiedAt).toBe(now().toISOString());
    expect(hostedStepUpRequired(verified.session, now())).toBe(false);
    expect(await service.readSession(registration.sessionToken)).toBeNull();
    await expect(
      service.verifyAuthentication(verified.sessionToken, options.ceremonyToken, response),
    ).rejects.toMatchObject({ code: "CPL_PASSKEY_CHALLENGE_REJECTED" });
  });

  it.each([
    "origin",
    "challenge",
    "RP ID",
    "user verification",
    "user presence",
    "signature",
    "user handle",
    "credential ID",
    "cross-origin context",
  ])("rejects a signed assertion with wrong %s and consumes the challenge", async (kind) => {
    const { service, registration, authenticator } = await enrolled();
    const options = await service.authenticationOptions(registration.sessionToken);
    const response = authenticator.authentication(
      kind === "challenge" ? "other-challenge" : options.options.challenge,
      kind === "origin" ? "https://attacker.example.test" : origin,
      kind === "user handle" ? "other-identity" : registration.session.identityId,
      {
        rpId: kind === "RP ID" ? "attacker.example.test" : new URL(origin).hostname,
        flags: kind === "user verification" ? 0x01 : kind === "user presence" ? 0x04 : 0x05,
        crossOrigin: kind === "cross-origin context",
      },
    );
    if (kind === "signature") response.response.signature = randomBytes(70).toString("base64url");
    if (kind === "credential ID") response.id = randomBytes(32).toString("base64url");
    await expect(
      service.verifyAuthentication(registration.sessionToken, options.ceremonyToken, response),
    ).rejects.toMatchObject({ code: "CPL_PASSKEY_VERIFICATION_REJECTED" });
    await expect(
      service.verifyAuthentication(registration.sessionToken, options.ceremonyToken, response),
    ).rejects.toMatchObject({ code: "CPL_PASSKEY_CHALLENGE_REJECTED" });
    expect((await service.requireSession(registration.sessionToken)).mfaVerifiedAt).toBeNull();
  });

  it("rejects regressed counters after a previous signed assertion", async () => {
    const { service, registration, authenticator } = await enrolled();
    const first = await service.authenticationOptions(registration.sessionToken);
    const verified = await service.verifyAuthentication(
      registration.sessionToken,
      first.ceremonyToken,
      authenticator.authentication(
        first.options.challenge,
        origin,
        registration.session.identityId,
        { counter: 4 },
      ),
    );
    const next = await service.authenticationOptions(verified.sessionToken);
    await expect(
      service.verifyAuthentication(
        verified.sessionToken,
        next.ceremonyToken,
        authenticator.authentication(next.options.challenge, origin, verified.session.identityId, {
          counter: 3,
        }),
      ),
    ).rejects.toMatchObject({ code: "CPL_PASSKEY_VERIFICATION_REJECTED" });
  });

  it("requires current MFA to add another passkey and expires that assurance after 15 minutes", async () => {
    const { service, registration, authenticator, advance, now } = await enrolled();
    await expect(service.registrationOptions(registration.sessionToken)).rejects.toMatchObject({
      code: "CPL_FRESH_AUTHENTICATION_REQUIRED",
    });
    const options = await service.authenticationOptions(registration.sessionToken);
    const verified = await service.verifyAuthentication(
      registration.sessionToken,
      options.ceremonyToken,
      authenticator.authentication(
        options.options.challenge,
        origin,
        registration.session.identityId,
      ),
    );
    await expect(service.registrationOptions(verified.sessionToken)).resolves.toHaveProperty(
      "options",
    );
    advance(15 * 60_000 + 1);
    expect(hostedStepUpRequired(verified.session, now())).toBe(true);
    await expect(service.registrationOptions(verified.sessionToken)).rejects.toMatchObject({
      code: "CPL_FRESH_AUTHENTICATION_REQUIRED",
    });
  });

  it("does not reset initial enrollment freshness by renewing the session", async () => {
    const { service, signedIn, advance } = await setup();
    advance(5 * 60_000 + 1);
    const renewed = await service.renew(signedIn.sessionToken);
    await expect(service.registrationOptions(renewed.sessionToken)).rejects.toMatchObject({
      code: "CPL_FRESH_AUTHENTICATION_REQUIRED",
    });
  });

  it("rejects a registration without required user verification", async () => {
    const { service, signedIn } = await setup();
    const options = await service.registrationOptions(signedIn.sessionToken);
    await expect(
      service.verifyRegistration(
        signedIn.sessionToken,
        options.ceremonyToken,
        softwareAuthenticator().registration(options.options.challenge, origin, 0x41),
      ),
    ).rejects.toMatchObject({ code: "CPL_PASSKEY_VERIFICATION_REJECTED" });
    expect(await service.hasPasskey(signedIn.sessionToken)).toBe(false);
  });

  it("rejects expired and session-mismatched ceremony tokens", async () => {
    const { service, signedIn, advance } = await setup();
    const options = await service.registrationOptions(signedIn.sessionToken);
    const response = softwareAuthenticator().registration(options.options.challenge, origin);
    const renewed = await service.renew(signedIn.sessionToken);
    await expect(
      service.verifyRegistration(renewed.sessionToken, options.ceremonyToken, response),
    ).rejects.toMatchObject({ code: "CPL_PASSKEY_CHALLENGE_REJECTED" });
    const fresh = await service.registrationOptions(renewed.sessionToken);
    advance(5 * 60_000 + 1);
    await expect(
      service.verifyRegistration(renewed.sessionToken, fresh.ceremonyToken, response),
    ).rejects.toMatchObject({ code: "CPL_PASSKEY_CHALLENGE_REJECTED" });
  });
});
