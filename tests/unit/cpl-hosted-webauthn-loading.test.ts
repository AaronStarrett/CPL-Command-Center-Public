import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const origin = "https://command.example.test";
const now = new Date("2026-09-21T18:00:00Z");
type WebAuthnModule = typeof import("@simplewebauthn/server");

function observeModule(loadError?: Error) {
  const observed: { initializations: number; sdk?: WebAuthnModule } = { initializations: 0 };
  vi.doMock("@simplewebauthn/server", async (importOriginal) => {
    observed.initializations += 1;
    if (loadError) throw loadError;
    const sdk = await importOriginal<WebAuthnModule>();
    observed.sdk = {
      ...sdk,
      generateRegistrationOptions: vi.fn(sdk.generateRegistrationOptions),
      verifyRegistrationResponse: vi.fn(sdk.verifyRegistrationResponse),
      generateAuthenticationOptions: vi.fn(sdk.generateAuthenticationOptions),
      verifyAuthenticationResponse: vi.fn(sdk.verifyAuthenticationResponse),
    };
    return observed.sdk;
  });
  return observed;
}

async function setup() {
  const { CplHostedAuthService } =
    await import("../../packages/security/src/hosted-authentication");
  const { HostedAuthMemoryStore } = await import("../fixtures/hosted-auth-memory-store");
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
  const flow = await service.beginSignIn();
  const signedIn = await service.finishSignIn({
    browserBinding: flow.browserBinding,
    state: new URL(flow.authorizationUrl).searchParams.get("state")!,
    code: "synthetic-code",
  });
  return { service, store, signedIn };
}

async function registrationChallenge(context: Awaited<ReturnType<typeof setup>>) {
  const { hostedTokenHash } = await import("../../packages/security/src/google-oidc");
  const ceremonyToken = Buffer.alloc(32, 17).toString("base64url");
  await context.store.createChallenge({
    sessionId: context.signedIn.session.id,
    ceremonyTokenHash: hostedTokenHash(ceremonyToken),
    kind: "registration",
    challenge: "synthetic-challenge",
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  });
  return ceremonyToken;
}

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.doUnmock("@simplewebauthn/server");
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("Ceremony-only complete WebAuthn module loading", () => {
  it("does not initialize the SDK for sign-in, session, CSRF, renewal, organization denial, or sign-out", async () => {
    const observed = observeModule();
    const { service, signedIn } = await setup();
    expect(observed.initializations).toBe(0);
    expect(await service.readSession(signedIn.sessionToken)).toEqual(signedIn.session);
    expect(await service.requireSession(signedIn.sessionToken)).toEqual(signedIn.session);
    expect(await service.hasPasskey(signedIn.sessionToken)).toBe(false);
    expect(
      await service.requireMutation({
        sessionToken: signedIn.sessionToken,
        csrfCookie: signedIn.csrfToken,
        request: new Request(origin, {
          headers: { origin, "sec-fetch-site": "same-origin", "x-cpl-csrf": signedIn.csrfToken },
        }),
      }),
    ).toEqual(signedIn.session);
    await expect(service.selectOrganization(signedIn.sessionToken, "invalid")).rejects.toThrow(
      "CPL_ORGANIZATION_ACCESS_DENIED",
    );
    const renewed = await service.renew(signedIn.sessionToken);
    expect(await service.readSession(signedIn.sessionToken)).toBeNull();
    await service.signOut(renewed.sessionToken);
    expect(await service.readSession(renewed.sessionToken)).toBeNull();
    expect(observed.initializations).toBe(0);
  });

  it("rejects missing sessions, credentials, and rate limits before loading the SDK", async () => {
    const observed = observeModule();
    const { service, signedIn, store } = await setup();
    await expect(service.registrationOptions("invalid")).rejects.toThrow(
      "CPL_AUTHENTICATION_REQUIRED",
    );
    await expect(service.authenticationOptions(signedIn.sessionToken)).rejects.toThrow(
      "CPL_PASSKEY_ENROLLMENT_REQUIRED",
    );
    store.allowRate = false;
    await expect(service.registrationOptions(signedIn.sessionToken)).rejects.toThrow(
      "CPL_AUTH_RATE_LIMITED",
    );
    expect(store.challenges.size).toBe(0);
    expect(observed.initializations).toBe(0);
  });

  it("shares one initialization across concurrent ceremonies without sharing challenges", async () => {
    const observed = observeModule();
    const first = await setup();
    const second = await setup();
    const options = await Promise.all([
      first.service.registrationOptions(first.signedIn.sessionToken),
      second.service.registrationOptions(second.signedIn.sessionToken),
    ]);
    expect(observed.initializations).toBe(1);
    expect(observed.sdk!.generateRegistrationOptions).toHaveBeenCalledTimes(2);
    expect(options[0]!.options.challenge).not.toBe(options[1]!.options.challenge);
    expect(options[0]!.ceremonyToken).not.toBe(options[1]!.ceremonyToken);
    expect(first.store.challenges.size).toBe(1);
    expect(second.store.challenges.size).toBe(1);
  });

  it("uses all four complete SDK operations, preserves validation, and rotates sessions only after verification", async () => {
    const observed = observeModule();
    const { service, store, signedIn } = await setup();
    const registrationOptions = await service.registrationOptions(signedIn.sessionToken);
    // This fixture imports SDK helpers; load it only after observing the ceremony's SDK import.
    const { softwareAuthenticator } = await import("../fixtures/signed-webauthn");
    const authenticator = softwareAuthenticator();
    const registrationResponse = authenticator.registration(
      registrationOptions.options.challenge,
      origin,
    );
    const registered = await service.verifyRegistration(
      signedIn.sessionToken,
      registrationOptions.ceremonyToken,
      registrationResponse,
    );
    expect(await service.readSession(signedIn.sessionToken)).toBeNull();
    expect(store.credentials.get(signedIn.session.identityId)).toHaveLength(1);
    const rejected = await service.authenticationOptions(registered.sessionToken);
    await expect(
      service.verifyAuthentication(
        registered.sessionToken,
        rejected.ceremonyToken,
        authenticator.authentication(
          rejected.options.challenge,
          "https://attacker.example.test",
          signedIn.session.identityId,
        ),
      ),
    ).rejects.toThrow("CPL_PASSKEY_VERIFICATION_REJECTED");
    expect(await service.readSession(registered.sessionToken)).not.toBeNull();
    const authenticationOptions = await service.authenticationOptions(registered.sessionToken);
    const authenticationResponse = authenticator.authentication(
      authenticationOptions.options.challenge,
      origin,
      signedIn.session.identityId,
    );
    const authenticated = await service.verifyAuthentication(
      registered.sessionToken,
      authenticationOptions.ceremonyToken,
      authenticationResponse,
    );
    expect(await service.readSession(registered.sessionToken)).toBeNull();
    expect(authenticated.session.mfaVerifiedAt).toBe(now.toISOString());
    expect(observed.initializations).toBe(1);
    expect(observed.sdk!.generateRegistrationOptions).toHaveBeenCalledExactlyOnceWith({
      rpName: "CPL Command Center",
      rpID: "command.example.test",
      userID: new TextEncoder().encode(signedIn.session.identityId),
      userName: signedIn.session.email,
      userDisplayName: signedIn.session.displayName,
      timeout: 60_000,
      attestationType: "none",
      supportedAlgorithmIDs: [-7, -257],
      excludeCredentials: [],
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required",
        // The complete SDK derives this flag on the passed selection object.
        requireResidentKey: false,
      },
    });
    expect(observed.sdk!.verifyRegistrationResponse).toHaveBeenCalledExactlyOnceWith({
      response: registrationResponse,
      expectedChallenge: registrationOptions.options.challenge,
      expectedOrigin: origin,
      expectedRPID: "command.example.test",
      requireUserVerification: true,
      supportedAlgorithmIDs: [-7, -257],
    });
    expect(observed.sdk!.generateAuthenticationOptions).toHaveBeenCalledTimes(2);
    expect(observed.sdk!.generateAuthenticationOptions).toHaveBeenLastCalledWith({
      rpID: "command.example.test",
      timeout: 60_000,
      userVerification: "required",
      allowCredentials: [{ id: registrationResponse.id, transports: ["internal"] }],
    });
    expect(observed.sdk!.verifyAuthenticationResponse).toHaveBeenCalledTimes(2);
    expect(observed.sdk!.verifyAuthenticationResponse).toHaveBeenLastCalledWith({
      response: authenticationResponse,
      expectedChallenge: authenticationOptions.options.challenge,
      expectedOrigin: origin,
      expectedRPID: "command.example.test",
      requireUserVerification: true,
      credential: {
        id: registrationResponse.id,
        publicKey: expect.any(Uint8Array),
        counter: 0,
      },
    });
  });

  it("consumes a cross-origin challenge and rejects it before module initialization", async () => {
    const observed = observeModule();
    const context = await setup();
    const ceremonyToken = await registrationChallenge(context);
    const response = {
      response: {
        clientDataJSON: Buffer.from(JSON.stringify({ crossOrigin: true })).toString("base64url"),
      },
    } as RegistrationResponseJSON;
    await expect(
      context.service.verifyRegistration(context.signedIn.sessionToken, ceremonyToken, response),
    ).rejects.toThrow("CPL_PASSKEY_VERIFICATION_REJECTED");
    expect(context.store.challenges.size).toBe(0);
    expect(context.store.credentials.size).toBe(0);
    expect(observed.initializations).toBe(0);
  });

  it("keeps a failed module load rejected without retry, fallback, credential writes, or session rotation", async () => {
    const loadError = new Error("synthetic-module-load-failure");
    const observed = observeModule(loadError);
    const context = await setup();
    const rejectedLoad: unknown = await context.service
      .registrationOptions(context.signedIn.sessionToken)
      .catch((error: unknown) => error);
    // Vitest wraps a failed module factory; the loader must preserve that rejection.
    expect(rejectedLoad).toMatchObject({ cause: loadError });
    await expect(context.service.registrationOptions(context.signedIn.sessionToken)).rejects.toBe(
      rejectedLoad,
    );
    expect(context.store.challenges.size).toBe(0);
    const ceremonyToken = await registrationChallenge(context);
    const response = {
      response: { clientDataJSON: Buffer.from("{}").toString("base64url") },
    } as RegistrationResponseJSON;
    await expect(
      context.service.verifyRegistration(context.signedIn.sessionToken, ceremonyToken, response),
    ).rejects.toThrow("CPL_PASSKEY_VERIFICATION_REJECTED");
    expect(context.store.challenges.size).toBe(0);
    expect(context.store.credentials.size).toBe(0);
    expect(await context.service.readSession(context.signedIn.sessionToken)).toEqual(
      context.signedIn.session,
    );
    expect(observed.initializations).toBe(1);
  });
});
