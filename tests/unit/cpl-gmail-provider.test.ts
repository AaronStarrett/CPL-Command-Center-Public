import { beforeAll, describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, type JWK } from "jose";
import {
  CplGoogleGmailAdapter,
  CPL_GMAIL_SCOPES,
  parseCplGmailMessage,
} from "../../packages/integrations/src/cpl-gmail";
import { createCplGmailHttpFixture } from "../../packages/security/src/cpl-integration-fixture";
import {
  createGoogleIntegrationIdentityVerifier,
  createIntegrationOpaqueToken,
} from "../../packages/security/src/cpl-integration-security";

const now = new Date("2026-09-24T02:00:00Z");
const fixtureId = "11111111-1111-4111-8111-111111111111";
const redirectUri = "http://127.0.0.1:3400/api/cpl-integrations/oauth/google/callback";
let privateJwk: JWK;
let publicJwk: JWK;
beforeAll(async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  privateJwk = await exportJWK(keys.privateKey);
  publicJwk = await exportJWK(keys.publicKey);
});
async function fixture(organization = fixtureId) {
  return createCplGmailHttpFixture({
    fixtureId: organization,
    fixtureEpoch: now.toISOString(),
    privateJwk,
    publicJwk,
    fixtureSecret: new Uint8Array(32).fill(9),
    redirectUri,
    now: () => now,
  });
}
function adapter(
  f: Awaited<ReturnType<typeof fixture>>,
  fetch: typeof globalThis.fetch = f.fetch,
  assertCurrent: (operation: string) => Promise<void> = async () => undefined,
) {
  return new CplGoogleGmailAdapter(f.configuration, {
    fetch,
    assertCurrent,
    verifyIdentity: createGoogleIntegrationIdentityVerifier(),
    now: () => now,
  });
}
async function grant(f: Awaited<ReturnType<typeof fixture>>, api = adapter(f)) {
  const state = createIntegrationOpaqueToken(),
    nonce = createIntegrationOpaqueToken(),
    verifier = createIntegrationOpaqueToken();
  const authorizationUrl = await api.authorizationUrl({ state, nonce, verifier, redirectUri });
  const consent = await f.authorize(authorizationUrl);
  expect(consent.state).toBe(state);
  return {
    ...(await api.exchangeCode({ code: consent.code, nonce, verifier, redirectUri })),
    authorizationUrl,
  };
}

describe("real Gmail adapter via deterministic HTTP boundary", () => {
  it("exercises authorization, PKCE code exchange, JWT/JWKS, labels, pages, MIME and refresh", async () => {
    const f = await fixture();
    const api = adapter(f);
    const result = await grant(f, api);
    const auth = new URL(result.authorizationUrl);
    expect(auth.searchParams.get("scope")).toBe(CPL_GMAIL_SCOPES.join(" "));
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(result.account.email).toMatch(/@example\.invalid$/u);
    const profile = await api.profile({ accessToken: result.tokens.accessToken });
    expect(profile.historyId).toBe("900719925474099302");
    const labels = await api.listLabels({ accessToken: result.tokens.accessToken });
    expect(labels[0]?.id).toBe("Label_CPL_FIXTURE");
    const first = await api.listMessages({
      accessToken: result.tokens.accessToken,
      labelId: "Label_CPL_FIXTURE",
      after: "2026-09-24T00:00:00Z",
      limit: 1,
    });
    expect(first.historyId).toBeNull();
    expect(first.nextPageToken).toBe("1");
    const second = await api.listMessages({
      accessToken: result.tokens.accessToken,
      labelId: "Label_CPL_FIXTURE",
      after: "2026-09-24T00:00:00Z",
      pageToken: first.nextPageToken!,
      limit: 1,
    });
    expect(second.nextPageToken).toBeNull();
    expect(second.messageIds).not.toEqual(first.messageIds);
    const message = await api.getMessage({
      accessToken: result.tokens.accessToken,
      messageId: second.messageIds[0]!,
    });
    expect(message.plainText).toContain("SYNTHETIC DEVELOPMENT EVIDENCE");
    expect(message.attachments).toMatchObject([
      { name: "synthetic-unread-attachment.pdf", status: "not_ingested" },
    ]);
    const history = await api.listHistory({
      accessToken: result.tokens.accessToken,
      labelId: "Label_CPL_FIXTURE",
      startHistoryId: "900719925474099300",
      limit: 100,
    });
    expect(history.changes).toHaveLength(2);
    expect(history.historyId).toBe(profile.historyId);
    const refreshed = await api.refresh({
      refreshToken: result.tokens.refreshToken!,
      priorScopes: result.tokens.scopes,
    });
    expect(refreshed.refreshToken).toBeUndefined();
    expect(refreshed.scopes).toEqual([...CPL_GMAIL_SCOPES].sort());
    expect(f.safeCounters()).toMatchObject({ authorize: 1, jwks: 1, token: 2, "messages.list": 2 });
  });
  it("reconstructs across processes with stable account/content and usable persisted refresh material", async () => {
    const first = await fixture();
    const initial = await grant(first);
    const second = await fixture();
    const api = adapter(second);
    const refreshed = await api.refresh({
      refreshToken: initial.tokens.refreshToken!,
      priorScopes: initial.tokens.scopes,
    });
    const again = await grant(second, api);
    expect(again.account).toEqual(initial.account);
    expect((await api.profile({ accessToken: refreshed.accessToken })).email).toBe(
      initial.account.email,
    );
    const ids = await api.listMessages({
      accessToken: refreshed.accessToken,
      labelId: "Label_CPL_FIXTURE",
      after: "2026-09-24T00:00:00Z",
      limit: 100,
    });
    const a = await adapter(first).getMessage({
      accessToken: initial.tokens.accessToken,
      messageId: ids.messageIds[0]!,
    });
    const b = await api.getMessage({
      accessToken: refreshed.accessToken,
      messageId: ids.messageIds[0]!,
    });
    expect(b.contentSha256).toBe(a.contentSha256);
  });
  it("exchanges a stateless code in a newly constructed request instance", async () => {
    const first = await fixture(),
      next = await fixture();
    const nonce = createIntegrationOpaqueToken(),
      verifier = createIntegrationOpaqueToken();
    const consent = await first.authorize(
      await adapter(first).authorizationUrl({
        state: createIntegrationOpaqueToken(),
        nonce,
        verifier,
        redirectUri,
      }),
    );
    const result = await adapter(next).exchangeCode({
      code: consent.code,
      nonce,
      verifier,
      redirectUri,
    });
    expect(result.account.email).toMatch(/@example\.invalid$/u);
    expect(next.safeCounters()).toMatchObject({ token: 1, jwks: 1 });
  });
  it("isolates fixture subjects/tokens and content by company", async () => {
    const first = await fixture(),
      other = await fixture("22222222-2222-4222-8222-222222222222");
    const a = await grant(first),
      b = await grant(other);
    expect(a.account.subject).not.toBe(b.account.subject);
    await expect(
      adapter(other).profile({ accessToken: a.tokens.accessToken }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAUTHORIZED" });
  });
  it("rejects a wrong verifier through the actual token transport", async () => {
    const f = await fixture(),
      api = adapter(f);
    const nonce = createIntegrationOpaqueToken();
    const auth = await api.authorizationUrl({
      nonce,
      state: createIntegrationOpaqueToken(),
      verifier: createIntegrationOpaqueToken(),
      redirectUri,
    });
    const consent = await f.authorize(auth);
    await expect(
      api.exchangeCode({
        code: consent.code,
        nonce,
        verifier: createIntegrationOpaqueToken(),
        redirectUri,
      }),
    ).rejects.toMatchObject({ code: "TOKEN_EXCHANGE_REJECTED" });
  });
  it("cannot send an unsupported fixture endpoint to the network", async () => {
    const f = await fixture();
    await expect(f.fetch("https://unrecognized.example.invalid/")).rejects.toThrow(
      "CPL_INTEGRATION_FIXTURE_REJECTED",
    );
  });
  it("accepts both advertised existing labels with convergent immutable message identities", async () => {
    const f = await fixture(),
      api = adapter(f);
    const { tokens } = await grant(f);
    const custom = await api.listMessages({
      accessToken: tokens.accessToken,
      labelId: "Label_CPL_FIXTURE",
      after: "2026-09-24T00:00:00Z",
      limit: 100,
    });
    const inbox = await api.listMessages({
      accessToken: tokens.accessToken,
      labelId: "INBOX",
      after: "2026-09-24T00:00:00Z",
      limit: 100,
    });
    expect(inbox.messageIds).toEqual(custom.messageIds);
  });
  it("checks authority before network and again before returning response", async () => {
    const f = await fixture();
    let requests = 0;
    const stopped = adapter(
      f,
      async (...args) => {
        requests++;
        return f.fetch(...args);
      },
      async () => {
        throw new Error("revoked");
      },
    );
    await expect(stopped.profile({ accessToken: "synthetic" })).rejects.toThrow("revoked");
    expect(requests).toBe(0);
    const result = await grant(f);
    let checks = 0;
    const late = adapter(f, f.fetch, async () => {
      if (++checks > 1) throw new Error("changed generation");
    });
    await expect(late.profile({ accessToken: result.tokens.accessToken })).rejects.toThrow(
      "changed generation",
    );
  });
  it.each([
    "openid email",
    "openid email https://mail.google.com/",
    `${CPL_GMAIL_SCOPES.join(" ")} https://www.googleapis.com/auth/gmail.send`,
  ])("rejects missing or broader returned scopes %s", async (scope) => {
    const f = await fixture();
    const bad: typeof fetch = async (url, init) => {
      const response = await f.fetch(url, init);
      if (String(url).endsWith("/token") && response.ok)
        return Response.json({ ...((await response.json()) as object), scope });
      return response;
    };
    await expect(grant(f, adapter(f, bad))).rejects.toMatchObject({
      code: "TOKEN_SCOPES_REJECTED",
    });
  });
  it.each([301, 302, 303, 307, 308])("rejects %i without following redirects", async (status) => {
    const f = await fixture();
    let requests = 0;
    const api = adapter(f, async (_url, init) => {
      requests++;
      expect(init?.redirect).toBe("manual");
      return new Response(null, { status, headers: { location: "https://other.invalid/" } });
    });
    await expect(api.profile({ accessToken: "synthetic" })).rejects.toMatchObject({
      code: "PROVIDER_REDIRECT_REJECTED",
    });
    expect(requests).toBe(1);
  });
  it.each([
    [401, "authError", "PROVIDER_UNAUTHORIZED", false],
    [403, "domainPolicy", "PROVIDER_FORBIDDEN", false],
    [403, "userRateLimitExceeded", "PROVIDER_RATE_LIMITED", true],
    [429, "rateLimitExceeded", "PROVIDER_RATE_LIMITED", true],
    [503, "backendError", "PROVIDER_UNAVAILABLE", true],
  ] as const)(
    "classifies HTTP%i %s without exposing remote data",
    async (status, reason, code, retryable) => {
      const f = await fixture();
      const api = adapter(f, async () =>
        Response.json(
          {
            error: {
              message: "SENSITIVE_REMOTE_TEXT",
              errors: [{ reason, message: "SENSITIVE_REMOTE_TEXT" }],
            },
          },
          { status, headers: { "retry-after": "90" } },
        ),
      );
      try {
        await api.profile({ accessToken: "synthetic" });
        throw new Error("unexpected success");
      } catch (error) {
        expect(error).toMatchObject({ code, retryable });
        expect(JSON.stringify(error)).not.toContain("SENSITIVE_REMOTE_TEXT");
      }
    },
  );
  it("distinguishes history expiry from unavailable messages", async () => {
    const f = await fixture();
    const api = adapter(f);
    const { tokens } = await grant(f);
    await expect(
      api.getMessage({ accessToken: tokens.accessToken, messageId: "missing" }),
    ).rejects.toMatchObject({ code: "MESSAGE_UNAVAILABLE" });
    await expect(
      api.listHistory({
        accessToken: tokens.accessToken,
        labelId: "Label_CPL_FIXTURE",
        startHistoryId: "1",
        limit: 10,
      }),
    ).rejects.toMatchObject({ code: "HISTORY_EXPIRED", resyncRequired: true });
  });
  it("preserves label additions and deletions separately without generic history duplicates", async () => {
    const f = await fixture();
    const api = adapter(f, async () =>
      Response.json({
        historyId: "900719925474099999",
        nextPageToken: "continued",
        history: [
          {
            id: "900719925474099333",
            messages: [{ id: "duplicate-generic" }],
            messagesAdded: [{ message: { id: "new" } }],
            labelsAdded: [
              { message: { id: "old-selected" }, labelIds: ["chosen"] },
              { message: { id: "other" }, labelIds: ["different"] },
            ],
            messagesDeleted: [{ message: { id: "deleted" } }],
            labelsRemoved: [{ message: { id: "removed" }, labelIds: ["chosen"] }],
          },
        ],
      }),
    );
    const page = await api.listHistory({
      accessToken: "synthetic",
      labelId: "chosen",
      startHistoryId: "900719925474099300",
      limit: 10,
    });
    expect(page.messageIds).toEqual(["new", "old-selected"]);
    expect(page.changes.map((item) => item.kind)).toEqual([
      "message_added",
      "label_added",
      "message_deleted",
      "label_removed",
    ]);
    expect(page.nextPageToken).toBe("continued");
  });
  it("bounds streamed response bytes without trusting Content-Length", async () => {
    const f = await fixture();
    const api = adapter(
      f,
      async () => new Response(new Uint8Array(1_048_577), { headers: { "content-length": "1" } }),
    );
    await expect(api.profile({ accessToken: "synthetic" })).rejects.toMatchObject({
      code: "PROVIDER_RESPONSE_TOO_LARGE",
    });
  });
  it("requires explicit project-wide revocation confirmation", async () => {
    const f = await fixture();
    const api = adapter(f);
    const { tokens } = await grant(f, api);
    await expect(
      api.revoke({ token: "synthetic", projectGrantRevocationConfirmed: false as true }),
    ).rejects.toMatchObject({ code: "PROVIDER_CONFIGURATION_INVALID" });
    expect(f.safeCounters().revoke).toBeUndefined();
    await api.revoke({ token: tokens.refreshToken!, projectGrantRevocationConfirmed: true });
    expect(f.safeCounters().revoke).toBe(1);
  });
});

describe("bounded inert Gmail MIME extraction", () => {
  const raw = (payload: unknown, override: object = {}) => ({
    id: "a1",
    threadId: "b1",
    historyId: "900719925474099300",
    internalDate: "1790215200000",
    labelIds: ["INBOX"],
    payload,
    ...override,
  });
  const plain = {
    mimeType: "text/plain",
    headers: [
      { name: "Subject", value: "=?UTF-8?B?VGVzdA==?=" },
      { name: "From", value: "Fictional Sender <sender@example.invalid>" },
    ],
    body: {
      data: Buffer.from("An untrusted <script>text</script> body.").toString("base64url"),
      size: 40,
    },
  };
  const parse = (message: unknown) =>
    parseCplGmailMessage(message, new TextEncoder().encode(JSON.stringify(message)));
  it("keeps text inert and decodes header display claims", async () => {
    const value = await parse(raw(plain));
    expect(value.subject).toBe("Test");
    expect(value.senderEmailClaim).toBe("sender@example.invalid");
    expect(value.plainText).toContain("<script>");
  });
  it("keeps stable content digest when mutable labels/history/snippet change", async () => {
    const a = await parse(raw(plain));
    const b = await parse(
      raw(plain, {
        labelIds: ["Label_CPL_FIXTURE"],
        historyId: "900719925474099999",
        snippet: "changed",
      }),
    );
    expect(a.contentSha256).toBe(b.contentSha256);
  });
  it("marks HTML-only content as unextracted without loading its remote assets", async () => {
    const result = await parse(
      raw({
        mimeType: "text/html",
        body: {
          size: 70,
          data: Buffer.from('<img src="https://untrusted.invalid/pixel">').toString("base64url"),
        },
      }),
    );
    expect(result.plainText).toBeNull();
    expect(result.parseIssues).toContain("HTML_BODY_NOT_EXTRACTED");
  });
  it("retains an unavailable body and ambiguous sender as explicit limitations", async () => {
    const result = await parse(
      raw({
        mimeType: "text/plain",
        headers: [{ name: "From", value: "one@example.invalid, two@example.invalid" }],
        body: { size: 100 },
      }),
    );
    expect(result.parseIssues).toEqual(
      expect.arrayContaining(["PLAIN_BODY_UNAVAILABLE", "SENDER_CLAIM_AMBIGUOUS"]),
    );
  });
  it("does not extract the content of an attached message's nested text body", async () => {
    const result = await parse(
      raw({
        mimeType: "message/rfc822",
        filename: "attached.eml",
        body: { size: 200 },
        parts: [plain],
      }),
    );
    expect(result.plainText).toBeNull();
    expect(result.attachments).toMatchObject([
      { name: "attached.eml", mediaType: "message/rfc822" },
    ]);
  });
  it("rejects malformed base64 and MIME depth instead of claiming extraction success", async () => {
    await expect(parse(raw({ ...plain, body: { data: "%%%" } }))).rejects.toMatchObject({
      code: "MIME_INVALID",
    });
    let nested: object = plain;
    for (let i = 0; i < 34; i++)
      nested = { mimeType: "multipart/mixed", body: {}, parts: [nested] };
    await expect(parse(raw(nested))).rejects.toMatchObject({ code: "MIME_LIMIT_EXCEEDED" });
  });
});
