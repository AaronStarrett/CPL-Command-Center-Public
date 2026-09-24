import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";

export class CplIntegrationSecurityError extends Error {
  constructor(readonly code = "CPL_INTEGRATION_SECURITY_REJECTED") {
    super(code);
    this.name = "CplIntegrationSecurityError";
  }
}

const encoder = new TextEncoder();
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const opaque = /^[A-Za-z0-9_-]{43}$/u;
function reject(): never {
  throw new CplIntegrationSecurityError();
}
const bytes = (value: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(value);
export function integrationBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}
export function integrationDecodeBase64Url(
  value: string,
  maximum = 65_536,
): Uint8Array<ArrayBuffer> {
  if (!value || value.length > Math.ceil((maximum * 4) / 3) + 4 || !/^[A-Za-z0-9_-]+$/u.test(value))
    reject();
  const result = bytes(Buffer.from(value, "base64url"));
  if (result.length > maximum || integrationBase64Url(result) !== value) reject();
  return result;
}
export function createIntegrationOpaqueToken(): string {
  return integrationBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}
export async function integrationSha256(value: Uint8Array): Promise<string> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", bytes(value))).toString("hex");
}
export async function integrationPkceChallenge(verifier: string): Promise<string> {
  if (!opaque.test(verifier)) reject();
  return integrationBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))),
  );
}

export type IntegrationSecretContext = {
  purpose: "gmail_tokens" | "signed_intake_key" | "oauth_attempt";
  organizationId: string;
  sourceId: string;
  credentialRevision: number;
};
export type IntegrationSecretEnvelope = {
  algorithm: "AES-256-GCM";
  keyVersion: string;
  nonce: string;
  ciphertext: string;
  tag: string;
};
function contextBytes(
  context: IntegrationSecretContext,
  keyVersion: string,
): Uint8Array<ArrayBuffer> {
  if (
    !uuid.test(context.organizationId) ||
    !uuid.test(context.sourceId) ||
    !Number.isSafeInteger(context.credentialRevision) ||
    context.credentialRevision < 1 ||
    !["gmail_tokens", "signed_intake_key", "oauth_attempt"].includes(context.purpose) ||
    !/^[A-Za-z0-9._-]{1,80}$/u.test(keyVersion)
  )
    reject();
  return encoder.encode(
    JSON.stringify([
      "cpl-integration-aead-v1",
      context.purpose,
      context.organizationId.toLowerCase(),
      context.sourceId.toLowerCase(),
      context.credentialRevision,
      keyVersion,
    ]),
  );
}
export function createIntegrationSecretBox(dependencies: {
  resolveKey: (keyVersion: string) => Promise<Uint8Array>;
}) {
  async function key(version: string, usage: KeyUsage) {
    const raw = await dependencies.resolveKey(version);
    if (!(raw instanceof Uint8Array) || raw.length !== 32) reject();
    return crypto.subtle.importKey("raw", bytes(raw), "AES-GCM", false, [usage]);
  }
  return {
    async seal(input: {
      plaintext: Uint8Array;
      context: IntegrationSecretContext;
      keyVersion: string;
    }): Promise<IntegrationSecretEnvelope> {
      try {
        if (
          !(input.plaintext instanceof Uint8Array) ||
          input.plaintext.length < 1 ||
          input.plaintext.length > 65_536
        )
          reject();
        const additionalData = contextBytes(input.context, input.keyVersion);
        const nonce = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = new Uint8Array(
          await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: nonce, additionalData, tagLength: 128 },
            await key(input.keyVersion, "encrypt"),
            bytes(input.plaintext),
          ),
        );
        return {
          algorithm: "AES-256-GCM",
          keyVersion: input.keyVersion,
          nonce: integrationBase64Url(nonce),
          ciphertext: integrationBase64Url(encrypted.subarray(0, -16)),
          tag: integrationBase64Url(encrypted.subarray(-16)),
        };
      } catch {
        throw new CplIntegrationSecurityError("CPL_INTEGRATION_ENCRYPTION_FAILED");
      }
    },
    async open(input: {
      envelope: IntegrationSecretEnvelope;
      context: IntegrationSecretContext;
    }): Promise<Uint8Array<ArrayBuffer>> {
      try {
        const envelope = input.envelope;
        if (envelope.algorithm !== "AES-256-GCM") reject();
        const additionalData = contextBytes(input.context, envelope.keyVersion);
        const nonce = integrationDecodeBase64Url(envelope.nonce, 12);
        const tag = integrationDecodeBase64Url(envelope.tag, 16);
        const ciphertext = integrationDecodeBase64Url(envelope.ciphertext);
        if (nonce.length !== 12 || tag.length !== 16) reject();
        const combined = new Uint8Array(ciphertext.length + tag.length);
        combined.set(ciphertext);
        combined.set(tag, ciphertext.length);
        return new Uint8Array(
          await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: nonce, additionalData, tagLength: 128 },
            await key(envelope.keyVersion, "decrypt"),
            combined,
          ),
        );
      } catch {
        throw new CplIntegrationSecurityError("CPL_INTEGRATION_DECRYPTION_FAILED");
      }
    },
  };
}

export type CplSignedSubmissionMaterial = {
  method: "POST";
  publicId: string;
  keyId: string;
  keyGeneration: number;
  timestamp: string;
  nonce: string;
  rawBody: Uint8Array;
};
async function signedMaterial(input: CplSignedSubmissionMaterial) {
  if (
    input.method !== "POST" ||
    !/^[A-Za-z0-9_-]{20,128}$/u.test(input.publicId) ||
    !/^[A-Za-z0-9_-]{16,80}$/u.test(input.keyId) ||
    !Number.isSafeInteger(input.keyGeneration) ||
    input.keyGeneration < 1 ||
    !/^[0-9]{10}$/u.test(input.timestamp) ||
    !opaque.test(input.nonce) ||
    !(input.rawBody instanceof Uint8Array) ||
    input.rawBody.length < 1 ||
    input.rawBody.length > 65_536
  )
    reject();
  const bodySha256 = await integrationSha256(input.rawBody);
  return {
    bodySha256,
    data: encoder.encode(
      JSON.stringify([
        "cpl-inbound-v1",
        input.method,
        input.publicId,
        input.keyId,
        input.keyGeneration,
        input.timestamp,
        input.nonce,
        bodySha256,
      ]),
    ),
  };
}
async function hmacKey(raw: Uint8Array | CryptoKey, usage: KeyUsage) {
  if (raw instanceof CryptoKey) {
    const algorithm = raw.algorithm as HmacKeyAlgorithm;
    if (
      raw.type !== "secret" ||
      algorithm.name !== "HMAC" ||
      algorithm.hash.name !== "SHA-256" ||
      algorithm.length !== 256 ||
      !raw.usages.includes(usage)
    )
      reject();
    return raw;
  }
  if (!(raw instanceof Uint8Array) || raw.length !== 32) reject();
  return crypto.subtle.importKey("raw", bytes(raw), { name: "HMAC", hash: "SHA-256" }, false, [
    usage,
  ]);
}
export async function signCplInboundSubmission(
  input: CplSignedSubmissionMaterial & { key: Uint8Array | CryptoKey },
): Promise<string> {
  const material = await signedMaterial(input);
  return integrationBase64Url(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", await hmacKey(input.key, "sign"), material.data),
    ),
  );
}
export async function verifyCplInboundSubmission(
  input: CplSignedSubmissionMaterial & {
    key: Uint8Array | CryptoKey;
    signature: string;
    now: Date;
  },
): Promise<{ bodySha256: string; timestampSeconds: number }> {
  try {
    const material = await signedMaterial(input);
    const timestampSeconds = Number(input.timestamp);
    const now = input.now.getTime() / 1000;
    if (
      !Number.isFinite(now) ||
      now - timestampSeconds > 300 ||
      timestampSeconds - now > 30 ||
      !opaque.test(input.signature)
    )
      reject();
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(input.key, "verify"),
      integrationDecodeBase64Url(input.signature, 32),
      material.data,
    );
    if (!valid) reject();
    return { bodySha256: material.bodySha256, timestampSeconds };
  } catch {
    throw new CplIntegrationSecurityError("CPL_INBOUND_SIGNATURE_REJECTED");
  }
}

export type GoogleIntegrationIdentity = {
  issuer: "https://accounts.google.com";
  subject: string;
  email: string;
};
export type GoogleIntegrationIdentityInput = {
  idToken: string;
  accessToken: string;
  nonce: string;
  clientId: string;
  now: Date;
  fetch: typeof fetch;
  assertCurrent: (operation: "jwks") => Promise<void>;
};
export function createGoogleIntegrationIdentityVerifier() {
  return async (input: GoogleIntegrationIdentityInput): Promise<GoogleIntegrationIdentity> => {
    try {
      if (
        !opaque.test(input.nonce) ||
        input.idToken.length < 1 ||
        input.idToken.length > 16_384 ||
        !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/u.test(input.clientId) ||
        !Number.isFinite(input.now.getTime())
      )
        reject();
      const jwksUrl = "https://www.googleapis.com/oauth2/v3/certs";
      const keys = createRemoteJWKSet(new URL(jwksUrl), {
        timeoutDuration: 5_000,
        [customFetch]: async (url, init) => {
          if (String(url) !== jwksUrl) reject();
          await input.assertCurrent("jwks");
          const response = await input.fetch(url, {
            ...init,
            redirect: "manual",
            signal: AbortSignal.timeout(5_000),
          });
          await input.assertCurrent("jwks");
          if (response.status !== 200 || !response.body) reject();
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              size += next.value.length;
              if (size > 65_536) reject();
              chunks.push(next.value);
            }
          } catch {
            await reader.cancel().catch(() => undefined);
            throw new CplIntegrationSecurityError();
          }
          const result = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
          }
          return new Response(result, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      });
      const { payload } = await jwtVerify(input.idToken, keys, {
        algorithms: ["RS256"],
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience: input.clientId,
        requiredClaims: ["iss", "sub", "aud", "iat", "exp", "nonce", "email", "email_verified"],
        currentDate: input.now,
        maxTokenAge: 300,
        clockTolerance: 30,
      });
      if (
        payload.aud !== input.clientId ||
        (payload.azp !== undefined && payload.azp !== input.clientId) ||
        payload.nonce !== input.nonce ||
        typeof payload.sub !== "string" ||
        !/^[\x21-\x7e]{1,255}$/u.test(payload.sub) ||
        payload.email_verified !== true ||
        typeof payload.email !== "string" ||
        payload.email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(payload.email)
      )
        reject();
      if (payload.at_hash !== undefined) {
        const hash = new Uint8Array(
          await crypto.subtle.digest("SHA-256", encoder.encode(input.accessToken)),
        );
        if (payload.at_hash !== integrationBase64Url(hash.subarray(0, 16))) reject();
      }
      await input.assertCurrent("jwks");
      return {
        issuer: "https://accounts.google.com",
        subject: payload.sub,
        email: payload.email.toLowerCase(),
      };
    } catch {
      throw new CplIntegrationSecurityError("CPL_INTEGRATION_IDENTITY_REJECTED");
    }
  };
}
