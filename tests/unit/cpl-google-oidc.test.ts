import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { GoogleOidcAdapter } from "../../packages/security/src/google-oidc";

const origin = "https://command.example.test";
const clientId = "synthetic-client.apps.googleusercontent.com";
const nonce = "n".repeat(43);
const now = new Date("2026-09-21T18:00:00Z");
const seconds = now.getTime() / 1000;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let adapter: GoogleOidcAdapter;
const configuration = { appOrigin: origin, clientId, clientSecret: "synthetic-test-secret" };
const claims: JWTPayload = {
  iss: "https://accounts.google.com",
  aud: clientId,
  sub: "12345678901234567890",
  iat: seconds,
  exp: seconds + 3600,
  nonce,
  email: "OWNER@example.test",
  email_verified: true,
  hd: "example.test",
  name: "Synthetic Owner",
};

async function assertion(overrides: JWTPayload = {}, omit: string[] = []) {
  const payload = { ...claims, ...overrides };
  for (const key of omit) delete payload[key];
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: "test-rsa" })
    .sign(keys.privateKey);
}

beforeAll(async () => {
  keys = await generateKeyPair("RS256", { extractable: true });
  const publicKey = { ...(await exportJWK(keys.publicKey)), kid: "test-rsa", alg: "RS256" };
  adapter = new GoogleOidcAdapter(configuration, {
    keys: createLocalJWKSet({ keys: [publicKey] }),
    now: () => now,
  });
});

describe("Google OIDC cryptographic assertion boundary", () => {
  it("verifies a real RSA signature against the selected JWKS and returns only normalized identity claims", async () => {
    const identity = await adapter.verifyIdToken(
      await assertion({ amr: ["pwd", "mfa"], auth_time: seconds - 60 }),
      nonce,
    );
    expect(identity).toEqual({
      issuer: claims.iss,
      subject: claims.sub,
      email: "owner@example.test",
      emailVerified: true,
      hostedDomain: "example.test",
      displayName: "Synthetic Owner",
      authenticatedAt: new Date((seconds - 60) * 1000).toISOString(),
      expiresAt: new Date((seconds + 3600) * 1000).toISOString(),
    });
    expect(identity).not.toHaveProperty("mfaVerified");
    expect(identity).not.toHaveProperty("amr");
  });

  it.each([
    ["issuer", { iss: "https://attacker.example.test" }],
    ["audience", { aud: "other.apps.googleusercontent.com" }],
    ["multi-audience", { aud: [clientId, "other-client"] }],
    ["authorized party", { azp: "other-client" }],
    ["nonce", { nonce: "x".repeat(43) }],
    ["unverified email", { email_verified: false }],
    ["string email flag", { email_verified: "true" }],
    ["malformed email", { email: "a\n@example.test" }],
    ["subject", { sub: "" }],
    ["expired token", { exp: seconds - 1 }],
    ["old assertion", { iat: seconds - 400 }],
    ["future assertion", { iat: seconds + 60 }],
    ["fractional issue time", { iat: seconds + 0.5 }],
    ["future authentication", { auth_time: seconds + 60 }],
    ["malformed domain", { hd: "https://example.test" }],
  ] as const)("rejects invalid %s", async (_label, changed) => {
    await expect(adapter.verifyIdToken(await assertion(changed), nonce)).rejects.toMatchObject({
      code: "CPL_IDENTITY_ASSERTION_REJECTED",
    });
  });

  it.each(["sub", "aud", "iat", "exp", "nonce", "email", "email_verified"])(
    "requires %s",
    async (claim) => {
      await expect(adapter.verifyIdToken(await assertion({}, [claim]), nonce)).rejects.toThrow();
    },
  );

  it("rejects an attacker signature and unsigned assertions", async () => {
    const attacker = await generateKeyPair("RS256");
    const forged = await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-rsa" })
      .sign(attacker.privateKey);
    await expect(adapter.verifyIdToken(forged, nonce)).rejects.toThrow();
    const unsigned = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`;
    await expect(adapter.verifyIdToken(unsigned, nonce)).rejects.toThrow();
  });

  it("requests only identity scopes with exact callback, state, nonce, and S256 PKCE", () => {
    const verifier = "v".repeat(43),
      state = "s".repeat(43);
    const url = new URL(adapter.authorizationUrl({ state, nonce, verifier }));
    expect(url.origin).toBe("https://accounts.google.com");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      redirect_uri: `${origin}/api/auth/google/callback`,
      response_type: "code",
      scope: "openid email profile",
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    });
    expect(url.searchParams.has("request_amr")).toBe(false);
  });

  it("exchanges only at the fixed endpoint and discards access and refresh tokens", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id_token: await assertion(),
          access_token: "synthetic-access",
          refresh_token: "synthetic-refresh",
        }),
      ),
    );
    const exchange = new GoogleOidcAdapter(configuration, {
      keys: createLocalJWKSet({
        keys: [{ ...(await exportJWK(keys.publicKey)), kid: "test-rsa" }],
      }),
      fetch: fetcher,
      now: () => now,
    });
    const result = await exchange.exchangeCode({
      code: "synthetic-code",
      verifier: "v".repeat(43),
      nonce,
    });
    expect(result.email).toBe("owner@example.test");
    expect(result).not.toHaveProperty("access_token");
    expect(fetcher).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
    const body = fetcher.mock.calls[0]![1]!.body as URLSearchParams;
    expect(body.get("code_verifier")).toBe("v".repeat(43));
    expect(body.get("redirect_uri")).toBe(`${origin}/api/auth/google/callback`);
  });

  it.each(["provider error", "oversized body", "missing assertion"])("redacts %s", async (mode) => {
    const body =
      mode === "oversized body"
        ? "x".repeat(65_537)
        : JSON.stringify({ error: "synthetic-provider-secret" });
    const exchange = new GoogleOidcAdapter(configuration, {
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(body, { status: mode === "provider error" ? 400 : 200 })),
    });
    await expect(
      exchange.exchangeCode({ code: "synthetic-code", verifier: "v".repeat(43), nonce }),
    ).rejects.toMatchObject({ message: "CPL_IDENTITY_ASSERTION_REJECTED" });
  });

  it("retains only a fixed failure category, never provider secrets or network error details", async () => {
    const failures = [
      [new Response("provider-secret-token", { status: 400 }), "TOKEN_ENDPOINT_REJECTED"],
      [new Response("{provider-secret-token"), "TOKEN_RESPONSE_INVALID_JSON"],
      [
        new Response(JSON.stringify({ access_token: "provider-secret-token" })),
        "TOKEN_RESPONSE_MISSING_ASSERTION",
      ],
      [new Error("network error with provider-secret-token"), "TOKEN_REQUEST_FAILED"],
    ] as const;
    for (const [failure, diagnosticCode] of failures) {
      const exchange = new GoogleOidcAdapter(configuration, {
        fetch: async () => {
          if (failure instanceof Error) throw failure;
          return failure;
        },
      });
      const error = await exchange
        .exchangeCode({ code: "synthetic-code", verifier: "v".repeat(43), nonce })
        .catch((value) => value as Error);
      expect(error).toMatchObject({ code: "CPL_IDENTITY_ASSERTION_REJECTED", diagnosticCode });
      expect(JSON.stringify(error)).not.toMatch(
        /provider-secret-token|synthetic-code|synthetic-test-secret/,
      );
      expect(error).not.toHaveProperty("cause");
    }
  });

  it("preserves a fixed JWT failure category through token exchange without leaking signed claims", async () => {
    const exchange = new GoogleOidcAdapter(configuration, {
      keys: createLocalJWKSet({
        keys: [{ ...(await exportJWK(keys.publicKey)), kid: "test-rsa" }],
      }),
      now: () => now,
      fetch: async () =>
        new Response(JSON.stringify({ id_token: await assertion({ exp: seconds - 100 }) })),
    });
    await expect(
      exchange.exchangeCode({ code: "synthetic-code", verifier: "v".repeat(43), nonce }),
    ).rejects.toMatchObject({
      code: "CPL_IDENTITY_ASSERTION_REJECTED",
      diagnosticCode: "JWT_EXPIRED",
    });
  });
});
