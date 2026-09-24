import { beforeAll, describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import {
  createGoogleIntegrationIdentityVerifier,
  createIntegrationOpaqueToken,
  createIntegrationSecretBox,
  integrationBase64Url,
  signCplInboundSubmission,
  verifyCplInboundSubmission,
} from "../../packages/security/src/cpl-integration-security";

const org = "11111111-1111-4111-8111-111111111111";
const source = "22222222-2222-4222-8222-222222222222";
const other = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-09-24T02:00:00Z");
const rawKey = new Uint8Array(32).fill(17);
const context = {
  organizationId: org,
  sourceId: source,
  purpose: "gmail_tokens" as const,
  credentialRevision: 1,
};
const plaintext = new TextEncoder().encode(
  JSON.stringify({ synthetic: true, value: "fixture-only" }),
);

describe("tenant-context authenticated integration encryption", () => {
  const box = createIntegrationSecretBox({
    resolveKey: async (version) => {
      if (version !== "synthetic-v1") throw new Error("No key");
      return rawKey;
    },
  });
  it("round trips with randomized IV and no plaintext in the envelope", async () => {
    const first = await box.seal({ plaintext, context, keyVersion: "synthetic-v1" });
    const second = await box.seal({ plaintext, context, keyVersion: "synthetic-v1" });
    expect(first.nonce).not.toBe(second.nonce);
    expect(JSON.stringify(first)).not.toContain("fixture-only");
    expect(await box.open({ envelope: first, context })).toEqual(plaintext);
  });
  it.each([
    { organizationId: other },
    { sourceId: other },
    { purpose: "signed_intake_key" as const },
    { credentialRevision: 2 },
  ])("rejects a swapped authenticated context %j", async (changed) => {
    const envelope = await box.seal({ plaintext, context, keyVersion: "synthetic-v1" });
    await expect(box.open({ envelope, context: { ...context, ...changed } })).rejects.toMatchObject(
      { code: "CPL_INTEGRATION_DECRYPTION_FAILED" },
    );
  });
  it.each(["nonce", "ciphertext", "tag"] as const)("rejects changed %s", async (field) => {
    const envelope = await box.seal({ plaintext, context, keyVersion: "synthetic-v1" });
    const value = envelope[field];
    envelope[field] = (value[0] === "A" ? "B" : "A") + value.slice(1);
    await expect(box.open({ envelope, context })).rejects.toMatchObject({
      code: "CPL_INTEGRATION_DECRYPTION_FAILED",
    });
  });
  it("fails closed on absent/wrong keys and invalid context, without forwarding resolver messages", async () => {
    await expect(box.seal({ plaintext, context, keyVersion: "unknown" })).rejects.toMatchObject({
      message: "CPL_INTEGRATION_ENCRYPTION_FAILED",
    });
    await expect(
      box.seal({
        plaintext,
        context: { ...context, credentialRevision: 0 },
        keyVersion: "synthetic-v1",
      }),
    ).rejects.toThrow("CPL_INTEGRATION_ENCRYPTION_FAILED");
    const missing = createIntegrationSecretBox({ resolveKey: async () => new Uint8Array(16) });
    await expect(missing.seal({ plaintext, context, keyVersion: "short" })).rejects.toThrow(
      "CPL_INTEGRATION_ENCRYPTION_FAILED",
    );
  });
});

describe("signed raw intake authentication", () => {
  const material = {
    method: "POST" as const,
    publicId: "public-synthetic-form-12345",
    keyId: source,
    keyGeneration: 1,
    timestamp: String(now.getTime() / 1000),
    nonce: createIntegrationOpaqueToken(),
    rawBody: new TextEncoder().encode('{"eventId":"synthetic-event","value":"original"}'),
  };
  it("verifies a raw-key signature through a nonextractable CryptoKey", async () => {
    const signature = await signCplInboundSubmission({ ...material, key: rawKey });
    const key = await crypto.subtle.importKey(
      "raw",
      rawKey,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const result = await verifyCplInboundSubmission({ ...material, signature, key, now });
    expect(result.bodySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.timestampSeconds).toBe(now.getTime() / 1000);
  });
  it.each([
    { publicId: "another-synthetic-form-12345" },
    { keyId: other },
    { keyGeneration: 2 },
    { nonce: "a".repeat(43) },
    { rawBody: new TextEncoder().encode('{ "eventId":"synthetic-event","value":"original"}') },
  ])("rejects modified request binding %j", async (change) => {
    const signature = await signCplInboundSubmission({ ...material, key: rawKey });
    await expect(
      verifyCplInboundSubmission({ ...material, ...change, signature, key: rawKey, now }),
    ).rejects.toThrow("CPL_INBOUND_SIGNATURE_REJECTED");
  });
  it.each([301, -31])(
    "refuses signed requests outside time allowance %i seconds",
    async (seconds) => {
      const signature = await signCplInboundSubmission({ ...material, key: rawKey });
      await expect(
        verifyCplInboundSubmission({
          ...material,
          signature,
          key: rawKey,
          now: new Date(now.getTime() + seconds * 1000),
        }),
      ).rejects.toThrow("CPL_INBOUND_SIGNATURE_REJECTED");
    },
  );
  it("accepts opaque issued key IDs but binds their exact case", async () => {
    const input = { ...material, keyId: "MixedCaseOpaqueKey_123456" };
    const signature = await signCplInboundSubmission({ ...input, key: rawKey });
    await expect(
      verifyCplInboundSubmission({ ...input, signature, key: rawKey, now }),
    ).resolves.toMatchObject({ timestampSeconds: now.getTime() / 1000 });
    await expect(
      verifyCplInboundSubmission({
        ...input,
        keyId: input.keyId.toLowerCase(),
        signature,
        key: rawKey,
        now,
      }),
    ).rejects.toThrow("CPL_INBOUND_SIGNATURE_REJECTED");
  });
  it("rejects malformed encodings without accepting a truncated signature", async () => {
    const signature = await signCplInboundSubmission({ ...material, key: rawKey });
    await expect(
      verifyCplInboundSubmission({
        ...material,
        signature: signature.slice(0, -1),
        key: rawKey,
        now,
      }),
    ).rejects.toThrow("CPL_INBOUND_SIGNATURE_REJECTED");
  });
});

describe("actual integration JWT and guarded JWKS validation", () => {
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  let publicJwk: Awaited<ReturnType<typeof exportJWK>>;
  const clientId = "integration-fixture.apps.googleusercontent.com";
  const nonce = createIntegrationOpaqueToken();
  const accessToken = "synthetic-access-material";
  const verify = createGoogleIntegrationIdentityVerifier();
  const claims: JWTPayload = {
    iss: "https://accounts.google.com",
    sub: "synthetic-subject",
    aud: clientId,
    nonce,
    iat: now.getTime() / 1000,
    exp: now.getTime() / 1000 + 3600,
    email: "Fixture@EXAMPLE.INVALID",
    email_verified: true,
  };
  beforeAll(async () => {
    keys = await generateKeyPair("RS256", { extractable: true });
    publicJwk = await exportJWK(keys.publicKey);
  });
  async function assertion(change: JWTPayload = {}) {
    return new SignJWT({ ...claims, ...change })
      .setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .sign(keys.privateKey);
  }
  const jwks: typeof fetch = async (url, init) => {
    expect(String(url)).toBe("https://www.googleapis.com/oauth2/v3/certs");
    expect(init?.redirect).toBe("manual");
    return Response.json({ keys: [{ ...publicJwk, kid: "fixture", alg: "RS256" }] });
  };
  it("verifies the real signature and at_hash through HTTP and returns issuer/sub account identity", async () => {
    const hash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accessToken)),
    );
    const calls: string[] = [];
    const account = await verify({
      idToken: await assertion({ at_hash: integrationBase64Url(hash.subarray(0, 16)) }),
      accessToken,
      nonce,
      clientId,
      now,
      fetch: jwks,
      assertCurrent: async (op) => {
        calls.push(op);
      },
    });
    expect(account).toEqual({
      issuer: "https://accounts.google.com",
      subject: "synthetic-subject",
      email: "fixture@example.invalid",
    });
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });
  it.each([
    { iss: "https://untrusted.example.invalid" },
    { aud: "other-client" },
    { azp: "other-client" },
    { nonce: "x".repeat(43) },
    { exp: now.getTime() / 1000 - 60 },
    { iat: now.getTime() / 1000 + 60 },
    { email_verified: false },
    { at_hash: "wrong" },
  ])("rejects invalid signed claims %j", async (change) => {
    await expect(
      verify({
        idToken: await assertion(change),
        accessToken,
        nonce,
        clientId,
        now,
        fetch: jwks,
        assertCurrent: async () => undefined,
      }),
    ).rejects.toThrow("CPL_INTEGRATION_IDENTITY_REJECTED");
  });
  it("refuses live authority loss before any JWKS request", async () => {
    let requests = 0;
    await expect(
      verify({
        idToken: await assertion(),
        accessToken,
        nonce,
        clientId,
        now,
        fetch: async () => {
          requests++;
          throw new Error("must not fetch");
        },
        assertCurrent: async () => {
          throw new Error("revoked");
        },
      }),
    ).rejects.toThrow("CPL_INTEGRATION_IDENTITY_REJECTED");
    expect(requests).toBe(0);
  });
  it("rejects a JWKS redirect instead of following it", async () => {
    await expect(
      verify({
        idToken: await assertion(),
        accessToken,
        nonce,
        clientId,
        now,
        fetch: async () =>
          new Response(null, { status: 302, headers: { location: "https://other.invalid" } }),
        assertCurrent: async () => undefined,
      }),
    ).rejects.toThrow("CPL_INTEGRATION_IDENTITY_REJECTED");
  });
});
