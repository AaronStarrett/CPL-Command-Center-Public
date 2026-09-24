import { importJWK, SignJWT, type JWK } from "jose";
import {
  integrationBase64Url,
  integrationDecodeBase64Url,
  integrationPkceChallenge,
  integrationSha256,
  CplIntegrationSecurityError,
} from "./cpl-integration-security.js";

/** Server-only deterministic HTTP fixture. The runtime must first prove the strict
 * local marker/database/persona boundary. This transport has no network fallback. */
export async function createCplGmailHttpFixture(input: {
  fixtureId: string;
  fixtureEpoch: string;
  privateJwk: JWK;
  publicJwk: JWK;
  fixtureSecret: Uint8Array;
  redirectUri: string;
  now?: () => Date;
}) {
  function fail(): never {
    throw new CplIntegrationSecurityError("CPL_INTEGRATION_FIXTURE_REJECTED");
  }
  const epoch = Date.parse(input.fixtureEpoch);
  if (
    !/^[a-f0-9-]{36}$/iu.test(input.fixtureId) ||
    !Number.isFinite(epoch) ||
    input.fixtureSecret.length !== 32 ||
    input.privateJwk.kty !== "RSA" ||
    input.publicJwk.kty !== "RSA" ||
    !input.privateJwk.d ||
    input.publicJwk.d ||
    input.privateJwk.n !== input.publicJwk.n ||
    input.privateJwk.e !== input.publicJwk.e
  )
    fail();
  const callback = new URL(input.redirectUri);
  if (
    callback.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(callback.hostname) ||
    callback.username ||
    callback.password ||
    callback.search ||
    callback.hash ||
    callback.pathname !== "/api/cpl-integrations/oauth/google/callback"
  )
    fail();
  const now = input.now ?? (() => new Date());
  const encoder = new TextEncoder();
  const hmac = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(input.fixtureSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const signKey = await importJWK(input.privateJwk, "RS256");
  const fixtureHash = await integrationSha256(encoder.encode(input.fixtureId.toLowerCase()));
  const keyId = `cpl-fixture-${(await integrationSha256(encoder.encode(String(input.publicJwk.n)))).slice(0, 16)}`;
  const subject = `cpl-fixture-${fixtureHash.slice(0, 40)}`;
  const email = `fixture-${fixtureHash.slice(0, 12)}@example.invalid`;
  const clientId = "cpl-integration-fixture.apps.googleusercontent.com";
  const clientSecret = integrationBase64Url(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        hmac,
        encoder.encode(`client:${input.fixtureId.toLowerCase()}`),
      ),
    ),
  );
  const labelId = "Label_CPL_FIXTURE";
  const initialHistory = 900719925474099300n;
  const history = String(initialHistory + 2n);
  const fullScopes = "openid email https://www.googleapis.com/auth/gmail.readonly";
  const counters = new Map<string, number>();
  const count = (operation: string) => counters.set(operation, (counters.get(operation) ?? 0) + 1);
  async function envelope(payload: Record<string, unknown>) {
    const data = integrationBase64Url(
      encoder.encode(JSON.stringify({ ...payload, fixtureId: input.fixtureId.toLowerCase() })),
    );
    const signature = integrationBase64Url(
      new Uint8Array(await crypto.subtle.sign("HMAC", hmac, encoder.encode(data))),
    );
    return `${data}.${signature}`;
  }
  async function unpack(value: string, kind: string): Promise<Record<string, unknown>> {
    const [encoded, supplied, extra] = value.split(".");
    if (!encoded || !supplied || extra || value.length > 4096) fail();
    const signature = integrationDecodeBase64Url(supplied, 32);
    if (
      signature.length !== 32 ||
      !(await crypto.subtle.verify("HMAC", hmac, signature, encoder.encode(encoded)))
    )
      fail();
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(integrationDecodeBase64Url(encoded, 3000)),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail();
    const data = parsed as Record<string, unknown>;
    if (
      data.kind !== kind ||
      data.fixtureId !== input.fixtureId.toLowerCase() ||
      data.subject !== subject ||
      typeof data.expires !== "number" ||
      data.expires <= now().getTime()
    )
      fail();
    return data;
  }
  async function newTokens() {
    return {
      access_token: await envelope({
        kind: "access",
        subject,
        expires: now().getTime() + 3_600_000,
      }),
      refresh_token: await envelope({
        kind: "refresh",
        subject,
        expires: epoch + 365 * 86_400_000,
      }),
      expires_in: 3600,
      token_type: "Bearer",
      scope: fullScopes,
    };
  }
  const messages = [0, 1].map((index) => ({
    id: `${fixtureHash.slice(0, 14)}0${index}`,
    threadId: `${fixtureHash.slice(0, 14)}1${index}`,
    historyId: String(initialHistory + BigInt(index + 1)),
    internalDate: String(epoch - (2 - index) * 60_000),
    labelIds: ["INBOX", labelId],
    snippet: "Synthetic development inquiry",
    sizeEstimate: 1024,
    payload: {
      partId: "",
      mimeType: "multipart/mixed",
      filename: "",
      headers: [
        { name: "Subject", value: `SYNTHETIC DEVELOPMENT — fixture inquiry ${index + 1}` },
        {
          name: "From",
          value: `Fictional Fixture Customer <customer-${fixtureHash.slice(0, 8)}@example.invalid>`,
        },
        { name: "To", value: email },
      ],
      body: { size: 0 },
      parts: [
        {
          partId: "0",
          mimeType: "text/plain",
          filename: "",
          headers: [{ name: "Content-Type", value: "text/plain; charset=UTF-8" }],
          body: {
            size: 170,
            data: Buffer.from(
              `SYNTHETIC DEVELOPMENT EVIDENCE. This is not a real customer message.\nPlease review fictional service inquiry ${index + 1} for tenant fixture ${fixtureHash.slice(0, 8)}. No work or sending is authorized.`,
            ).toString("base64url"),
          },
        },
        ...(index === 1
          ? [
              {
                partId: "1",
                mimeType: "application/pdf",
                filename: "synthetic-unread-attachment.pdf",
                headers: [],
                body: { size: 321, attachmentId: `fixture-attachment-${fixtureHash.slice(0, 8)}` },
              },
            ]
          : []),
      ],
    },
  }));
  const response = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const invalidGrant = () => response({ error: "invalid_grant" }, 400);
  const transport: typeof fetch = async (resource, init) => {
    const url = new URL(resource instanceof Request ? resource.url : String(resource));
    const method = init?.method ?? (resource instanceof Request ? resource.method : "GET");
    if (init?.signal?.aborted) throw new DOMException("Fixture request aborted", "AbortError");
    if (url.href === "https://www.googleapis.com/oauth2/v3/certs" && method === "GET") {
      count("jwks");
      return response({
        keys: [
          {
            kty: "RSA",
            n: input.publicJwk.n,
            e: input.publicJwk.e,
            alg: "RS256",
            use: "sig",
            kid: keyId,
          },
        ],
      });
    }
    if (url.href === "https://oauth2.googleapis.com/token" && method === "POST") {
      count("token");
      const body = new URLSearchParams(
        init?.body instanceof URLSearchParams
          ? init.body
          : typeof init?.body === "string"
            ? init.body
            : "",
      );
      if (body.get("client_id") !== clientId || body.get("client_secret") !== clientSecret)
        return response({ error: "invalid_client" }, 401);
      if (body.get("grant_type") === "refresh_token") {
        try {
          await unpack(body.get("refresh_token") ?? "", "refresh");
        } catch {
          return invalidGrant();
        }
        const tokens = await newTokens();
        return response({
          access_token: tokens.access_token,
          expires_in: tokens.expires_in,
          token_type: tokens.token_type,
        });
      }
      if (
        body.get("grant_type") !== "authorization_code" ||
        body.get("redirect_uri") !== input.redirectUri
      )
        return invalidGrant();
      let code: Record<string, unknown>;
      try {
        code = await unpack(body.get("code") ?? "", "code");
        if (
          code.challenge !== (await integrationPkceChallenge(body.get("code_verifier") ?? "")) ||
          code.clientId !== clientId ||
          code.redirectUri !== input.redirectUri
        )
          return invalidGrant();
      } catch {
        return invalidGrant();
      }
      const tokens = await newTokens();
      const accessHash = new Uint8Array(
        await crypto.subtle.digest("SHA-256", encoder.encode(tokens.access_token)),
      );
      const assertion = await new SignJWT({
        nonce: code.nonce,
        email,
        email_verified: true,
        at_hash: integrationBase64Url(accessHash.subarray(0, 16)),
      })
        .setProtectedHeader({ alg: "RS256", kid: keyId })
        .setIssuer("https://accounts.google.com")
        .setAudience(clientId)
        .setSubject(subject)
        .setIssuedAt(Math.floor(now().getTime() / 1000))
        .setExpirationTime(Math.floor(now().getTime() / 1000) + 3600)
        .sign(signKey);
      return response({ ...tokens, id_token: assertion });
    }
    if (url.href === "https://oauth2.googleapis.com/revoke" && method === "POST") {
      // This deterministic fixture proves request construction only, never a real grant revocation.
      count("revoke");
      const body = new URLSearchParams(
        init?.body instanceof URLSearchParams
          ? init.body
          : typeof init?.body === "string"
            ? init.body
            : "",
      );
      const supplied = body.get("token") ?? "";
      try {
        await unpack(supplied, "access");
      } catch {
        try {
          await unpack(supplied, "refresh");
        } catch {
          return response({ error: "invalid_token" }, 400);
        }
      }
      return response({});
    }
    if (
      url.origin !== "https://gmail.googleapis.com" ||
      !url.pathname.startsWith("/gmail/v1/users/me/") ||
      method !== "GET"
    )
      fail();
    const authorization =
      new Headers(
        init?.headers ?? (resource instanceof Request ? resource.headers : undefined),
      ).get("authorization") ?? "";
    try {
      if (!authorization.startsWith("Bearer ")) fail();
      await unpack(authorization.slice(7), "access");
    } catch {
      return response({ error: { errors: [{ reason: "authError" }] } }, 401);
    }
    const route = url.pathname.slice("/gmail/v1/users/me/".length);
    if (route === "profile") {
      count("profile");
      return response({
        emailAddress: email,
        messagesTotal: messages.length,
        threadsTotal: messages.length,
        historyId: history,
      });
    }
    if (route === "labels") {
      count("labels");
      return response({
        labels: [
          { id: labelId, name: "CPL synthetic inquiries", type: "user" },
          { id: "INBOX", name: "INBOX", type: "system" },
        ],
      });
    }
    if (route === "messages") {
      count("messages.list");
      const query = /^after:([0-9]+)$/u.exec(url.searchParams.get("q") ?? "");
      if (
        ![labelId, "INBOX"].includes(url.searchParams.get("labelIds") ?? "") ||
        !query ||
        url.searchParams.get("includeSpamTrash") !== "false"
      )
        fail();
      const limit = Number(url.searchParams.get("maxResults"));
      const offset = Number(url.searchParams.get("pageToken") ?? "0");
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > messages.length
      )
        fail();
      const selected = messages.filter(
        (message) => Number(message.internalDate) >= Number(query[1]) * 1000,
      );
      const page = selected.slice(offset, offset + limit);
      return response({
        messages: page.map(({ id, threadId }) => ({ id, threadId })),
        resultSizeEstimate: selected.length,
        ...(offset + limit < selected.length ? { nextPageToken: String(offset + limit) } : {}),
      });
    }
    if (route === "history") {
      count("history.list");
      const start = url.searchParams.get("startHistoryId") ?? "";
      if (
        ![labelId, "INBOX"].includes(url.searchParams.get("labelId") ?? "") ||
        !/^[0-9]+$/u.test(start)
      )
        fail();
      if (BigInt(start) < initialHistory)
        return response({ error: { errors: [{ reason: "notFound" }] } }, 404);
      return response({
        history: messages
          .filter((message) => BigInt(message.historyId) > BigInt(start))
          .map((message) => ({
            id: message.historyId,
            messagesAdded: [{ message: { id: message.id, threadId: message.threadId } }],
          })),
        historyId: history,
      });
    }
    if (route.startsWith("messages/") && url.searchParams.get("format") === "full") {
      count("messages.get");
      const message = messages.find((item) => item.id === route.slice(9));
      return message
        ? response(message)
        : response({ error: { errors: [{ reason: "notFound" }] } }, 404);
    }
    return fail();
  };
  return {
    configuration: { clientId, clientSecret, redirectUri: input.redirectUri },
    fetch: transport,
    async authorize(
      authorizationUrl: string,
    ): Promise<{ code: string; state: string; redirectUri: string }> {
      const url = new URL(authorizationUrl);
      const p = url.searchParams;
      if (
        url.origin + url.pathname !== "https://accounts.google.com/o/oauth2/v2/auth" ||
        p.get("client_id") !== clientId ||
        p.get("redirect_uri") !== input.redirectUri ||
        p.get("scope") !== fullScopes ||
        p.get("response_type") !== "code" ||
        p.get("access_type") !== "offline" ||
        p.get("code_challenge_method") !== "S256" ||
        !/^[A-Za-z0-9_-]{43}$/u.test(p.get("state") ?? "") ||
        !/^[A-Za-z0-9_-]{43}$/u.test(p.get("nonce") ?? "") ||
        !/^[A-Za-z0-9_-]{43}$/u.test(p.get("code_challenge") ?? "")
      )
        fail();
      count("authorize");
      const code = await envelope({
        kind: "code",
        subject,
        state: p.get("state"),
        nonce: p.get("nonce"),
        challenge: p.get("code_challenge"),
        clientId,
        redirectUri: input.redirectUri,
        expires: now().getTime() + 300_000,
      });
      return { code, state: p.get("state")!, redirectUri: input.redirectUri };
    },
    safeCounters: () => Object.fromEntries(counters),
  };
}
