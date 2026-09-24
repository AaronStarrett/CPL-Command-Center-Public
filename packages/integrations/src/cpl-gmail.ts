export const CPL_GMAIL_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
] as const;
const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const REVOKE = "https://oauth2.googleapis.com/revoke";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const encoder = new TextEncoder();
const opaque = /^[A-Za-z0-9_-]{43}$/u;
const providerId = /^[A-Za-z0-9_-]{1,256}$/u;
export type CplGoogleOperation =
  | "authorize"
  | "exchange"
  | "jwks"
  | "refresh"
  | "profile"
  | "labels"
  | "messages.list"
  | "messages.get"
  | "history.list"
  | "revoke";
export type CplGmailAccount = {
  issuer: "https://accounts.google.com";
  subject: string;
  email: string;
};
export type CplGmailTokens = {
  accessToken: string;
  expiresAt: string;
  refreshToken?: string;
  scopes: string[];
};
export type CplGmailPage = {
  messageIds: string[];
  nextPageToken: string | null;
  historyId: string | null;
};
export type CplGmailHistoryPage = CplGmailPage & {
  changes: {
    messageId: string;
    historyId: string;
    kind: "message_added" | "label_added" | "message_deleted" | "label_removed";
  }[];
};
export type CplGmailMessage = {
  id: string;
  threadId: string;
  historyId: string;
  internalDate: string;
  labelIds: string[];
  original: Uint8Array;
  originalMediaType: "application/json";
  contentSha256: string;
  subject: string;
  senderNameClaim: string;
  senderEmailClaim: string;
  plainText: string | null;
  parseIssues: string[];
  attachments: {
    id: string | null;
    name: string;
    mediaType: string;
    bytes: number;
    status: "not_ingested" | "unavailable";
  }[];
};
export class CplGmailProviderError extends Error {
  readonly reconnectRequired: boolean;
  readonly resyncRequired: boolean;
  constructor(
    readonly code: string,
    readonly retryable = false,
    readonly httpStatus: number | null = null,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(code);
    this.name = "CplGmailProviderError";
    this.reconnectRequired = [
      "PROVIDER_UNAUTHORIZED",
      "TOKEN_REFRESH_REJECTED",
      "TOKEN_SCOPES_REJECTED",
    ].includes(code);
    this.resyncRequired = code === "HISTORY_EXPIRED";
  }
}
function fail(code = "PROVIDER_RESPONSE_INVALID"): never {
  throw new CplGmailProviderError(code);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 16_384, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && !value)) fail();
  return value;
}
function id(value: unknown): string {
  const result = text(value, 256);
  if (!providerId.test(result)) fail();
  return result;
}
function historyId(value: unknown): string {
  const result = text(value, 32);
  if (!/^[0-9]+$/u.test(result)) fail();
  return result;
}
function list(value: unknown, maximum = 500): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail();
  return value;
}
function optionalList(value: unknown, maximum = 500): unknown[] {
  return value === undefined ? [] : list(value, maximum);
}
function integer(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) fail();
  return Number(value);
}
function token(value: unknown): string {
  const result = text(value);
  if (!/^[\x21-\x7e]+$/u.test(result)) fail("TOKEN_RESPONSE_INVALID");
  return result;
}
function scopes(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.map((v) => text(v, 256))
    : text(value, 2048).split(/ +/u);
  const result = [
    ...new Set(
      raw.map((v) => (v === "https://www.googleapis.com/auth/userinfo.email" ? "email" : v)),
    ),
  ].sort();
  if (
    result.length !== CPL_GMAIL_SCOPES.length ||
    CPL_GMAIL_SCOPES.some((v) => !result.includes(v))
  )
    fail("TOKEN_SCOPES_REJECTED");
  return result;
}
const b64 = (value: Uint8Array) => Buffer.from(value).toString("base64url");
async function challenge(verifier: string) {
  if (!opaque.test(verifier)) fail("PROVIDER_CONFIGURATION_INVALID");
  return b64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
}
async function digest(value: unknown) {
  return Buffer.from(
    await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(value))),
  ).toString("hex");
}
function retryAfter(value: string | null, now: Date): number | null {
  if (!value || value.length > 100) return null;
  const seconds = /^[0-9]+$/u.test(value)
    ? Number(value)
    : (Date.parse(value) - now.getTime()) / 1000;
  return Number.isFinite(seconds) ? Math.max(1, Math.min(86_400, Math.ceil(seconds))) : null;
}
async function bounded(response: Response, maximum: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > maximum) fail("PROVIDER_RESPONSE_TOO_LARGE");
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
function json(value: Uint8Array): Record<string, unknown> {
  try {
    return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)));
  } catch {
    return fail("PROVIDER_RESPONSE_INVALID");
  }
}

export type CplGoogleIdentityVerifier = (input: {
  idToken: string;
  accessToken: string;
  nonce: string;
  clientId: string;
  now: Date;
  fetch: typeof fetch;
  assertCurrent: (operation: "jwks") => Promise<void>;
}) => Promise<CplGmailAccount>;
export type CplGoogleGmailConfiguration = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};
export class CplGoogleGmailAdapter {
  constructor(
    private readonly configuration: CplGoogleGmailConfiguration,
    private readonly dependencies: {
      fetch: typeof fetch;
      assertCurrent: (operation: CplGoogleOperation) => Promise<void>;
      verifyIdentity: CplGoogleIdentityVerifier;
      now?: () => Date;
      signal?: AbortSignal;
    },
  ) {
    let redirect: URL;
    try {
      redirect = new URL(configuration.redirectUri);
    } catch {
      return fail("PROVIDER_CONFIGURATION_INVALID");
    }
    if (
      !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/u.test(configuration.clientId) ||
      !configuration.clientSecret ||
      configuration.clientSecret.length > 1024 ||
      redirect.username ||
      redirect.password ||
      redirect.search ||
      redirect.hash ||
      (redirect.protocol !== "https:" &&
        !(
          redirect.protocol === "http:" && ["localhost", "127.0.0.1"].includes(redirect.hostname)
        )) ||
      redirect.pathname !== "/api/cpl-integrations/oauth/google/callback" ||
      !dependencies.fetch ||
      !dependencies.assertCurrent ||
      !dependencies.verifyIdentity
    )
      fail("PROVIDER_CONFIGURATION_INVALID");
  }
  private now() {
    return this.dependencies.now?.() ?? new Date();
  }
  async authorizationUrl(input: {
    state: string;
    nonce: string;
    verifier: string;
    redirectUri: string;
  }): Promise<string> {
    await this.dependencies.assertCurrent("authorize");
    if (
      !opaque.test(input.state) ||
      !opaque.test(input.nonce) ||
      input.redirectUri !== this.configuration.redirectUri
    )
      fail("PROVIDER_CONFIGURATION_INVALID");
    const url = new URL(AUTH);
    url.search = new URLSearchParams({
      client_id: this.configuration.clientId,
      redirect_uri: this.configuration.redirectUri,
      response_type: "code",
      scope: CPL_GMAIL_SCOPES.join(" "),
      access_type: "offline",
      include_granted_scopes: "false",
      prompt: "consent select_account",
      state: input.state,
      nonce: input.nonce,
      code_challenge_method: "S256",
      code_challenge: await challenge(input.verifier),
    }).toString();
    return url.href;
  }
  private async request(
    operation: CplGoogleOperation,
    url: string,
    input: { accessToken?: string; body?: URLSearchParams; maximum?: number } = {},
  ) {
    await this.dependencies.assertCurrent(operation);
    const deadline = AbortSignal.timeout(10_000);
    const signal = this.dependencies.signal
      ? AbortSignal.any([deadline, this.dependencies.signal])
      : deadline;
    let response: Response;
    try {
      response = await this.dependencies.fetch(url, {
        method: input.body ? "POST" : "GET",
        redirect: "manual",
        signal,
        headers: {
          accept: "application/json",
          ...(input.accessToken ? { authorization: `Bearer ${token(input.accessToken)}` } : {}),
          ...(input.body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        },
        ...(input.body ? { body: input.body } : {}),
      });
    } catch {
      throw new CplGmailProviderError(
        signal.aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE",
        true,
      );
    }
    await this.dependencies.assertCurrent(operation);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      fail("PROVIDER_REDIRECT_REJECTED");
    }
    const raw = await bounded(response, response.ok ? (input.maximum ?? 1_048_576) : 65_536);
    await this.dependencies.assertCurrent(operation);
    if (!response.ok) {
      let reason = "";
      try {
        const body = json(raw);
        if (typeof body.error === "string") reason = body.error;
        else {
          const errors = optionalList(record(body.error).errors, 20);
          const first = errors[0];
          if (first) reason = text(record(first).reason, 80);
        }
      } catch {
        /* Keep a fixed fallback; never retain the response body. */
      }
      if (operation === "history.list" && response.status === 404) fail("HISTORY_EXPIRED");
      if (operation === "messages.get" && response.status === 404) fail("MESSAGE_UNAVAILABLE");
      if (operation === "refresh" && reason === "invalid_grant") fail("TOKEN_REFRESH_REJECTED");
      if (response.status === 401)
        throw new CplGmailProviderError("PROVIDER_UNAUTHORIZED", false, 401);
      if (
        response.status === 429 ||
        (response.status === 403 && ["rateLimitExceeded", "userRateLimitExceeded"].includes(reason))
      )
        throw new CplGmailProviderError(
          "PROVIDER_RATE_LIMITED",
          true,
          response.status,
          retryAfter(response.headers.get("retry-after"), this.now()),
        );
      if (response.status >= 500)
        throw new CplGmailProviderError(
          "PROVIDER_UNAVAILABLE",
          true,
          response.status,
          retryAfter(response.headers.get("retry-after"), this.now()),
        );
      throw new CplGmailProviderError(
        response.status === 403
          ? "PROVIDER_FORBIDDEN"
          : operation === "exchange"
            ? "TOKEN_EXCHANGE_REJECTED"
            : "PROVIDER_RESPONSE_INVALID",
        false,
        response.status,
      );
    }
    return { raw, body: raw.length ? json(raw) : {} };
  }
  private tokens(body: Record<string, unknown>, priorScopes?: string[]): CplGmailTokens {
    const seconds = integer(body.expires_in, 86_400);
    if (seconds < 1 || body.token_type !== "Bearer") fail("TOKEN_RESPONSE_INVALID");
    return {
      accessToken: token(body.access_token),
      expiresAt: new Date(this.now().getTime() + seconds * 1000).toISOString(),
      scopes: scopes(body.scope === undefined ? priorScopes : body.scope),
      ...(body.refresh_token === undefined ? {} : { refreshToken: token(body.refresh_token) }),
    };
  }
  async exchangeCode(input: {
    code: string;
    verifier: string;
    nonce: string;
    redirectUri: string;
  }): Promise<{ account: CplGmailAccount; tokens: CplGmailTokens }> {
    if (
      !opaque.test(input.verifier) ||
      !opaque.test(input.nonce) ||
      input.redirectUri !== this.configuration.redirectUri ||
      !input.code ||
      input.code.length > 4096
    )
      fail("PROVIDER_CONFIGURATION_INVALID");
    const result = await this.request("exchange", TOKEN, {
      maximum: 65_536,
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        client_id: this.configuration.clientId,
        client_secret: this.configuration.clientSecret,
        redirect_uri: this.configuration.redirectUri,
        code_verifier: input.verifier,
      }),
    });
    const tokens = this.tokens(result.body);
    const account = await this.dependencies.verifyIdentity({
      idToken: text(result.body.id_token),
      accessToken: tokens.accessToken,
      nonce: input.nonce,
      clientId: this.configuration.clientId,
      now: this.now(),
      fetch: this.dependencies.fetch,
      assertCurrent: this.dependencies.assertCurrent,
    });
    await this.dependencies.assertCurrent("exchange");
    return { account, tokens };
  }
  async refresh(input: { refreshToken: string; priorScopes: string[] }): Promise<CplGmailTokens> {
    const checkedScopes = scopes(input.priorScopes);
    const result = await this.request("refresh", TOKEN, {
      maximum: 65_536,
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token(input.refreshToken),
        client_id: this.configuration.clientId,
        client_secret: this.configuration.clientSecret,
      }),
    });
    return this.tokens(result.body, checkedScopes);
  }
  async profile(input: { accessToken: string }): Promise<{ email: string; historyId: string }> {
    const { body } = await this.request("profile", `${API}/profile`, input);
    return {
      email: text(body.emailAddress, 254).toLowerCase(),
      historyId: historyId(body.historyId),
    };
  }
  async listLabels(input: { accessToken: string }): Promise<{ id: string; name: string }[]> {
    const { body } = await this.request("labels", `${API}/labels`, input);
    return optionalList(body.labels, 1000).map((label) => {
      const item = record(label);
      return { id: id(item.id), name: text(item.name, 225) };
    });
  }
  private page(url: URL, input: { pageToken?: string; limit: number }) {
    const limit = integer(input.limit, 100);
    if (limit < 1) fail("PROVIDER_CONFIGURATION_INVALID");
    url.searchParams.set("maxResults", String(limit));
    if (input.pageToken !== undefined)
      url.searchParams.set("pageToken", text(input.pageToken, 2048));
  }
  async listMessages(input: {
    accessToken: string;
    labelId: string;
    after: string;
    pageToken?: string;
    limit: number;
  }): Promise<CplGmailPage> {
    const after = Date.parse(input.after);
    if (!Number.isFinite(after)) fail("PROVIDER_CONFIGURATION_INVALID");
    const url = new URL(`${API}/messages`);
    this.page(url, input);
    url.searchParams.set("labelIds", id(input.labelId));
    url.searchParams.set("q", `after:${Math.floor(after / 1000)}`);
    url.searchParams.set("includeSpamTrash", "false");
    const { body } = await this.request("messages.list", url.href, input);
    return {
      messageIds: [
        ...new Set(optionalList(body.messages).map((message) => id(record(message).id))),
      ],
      nextPageToken: body.nextPageToken === undefined ? null : text(body.nextPageToken, 2048),
      historyId: null,
    };
  }
  async listHistory(input: {
    accessToken: string;
    labelId: string;
    startHistoryId: string;
    pageToken?: string;
    limit: number;
  }): Promise<CplGmailHistoryPage> {
    const selectedLabel = id(input.labelId);
    const url = new URL(`${API}/history`);
    this.page(url, input);
    url.searchParams.set("labelId", selectedLabel);
    url.searchParams.set("startHistoryId", historyId(input.startHistoryId));
    const { body } = await this.request("history.list", url.href, input);
    const changes: CplGmailHistoryPage["changes"] = [];
    for (const value of optionalList(body.history)) {
      const entry = record(value);
      const at = historyId(entry.id);
      for (const [key, kind] of [
        ["messagesAdded", "message_added"],
        ["labelsAdded", "label_added"],
        ["messagesDeleted", "message_deleted"],
        ["labelsRemoved", "label_removed"],
      ] as const) {
        for (const item of optionalList(entry[key])) {
          const detail = record(item);
          if (
            (kind === "label_added" || kind === "label_removed") &&
            !list(detail.labelIds).map(id).includes(selectedLabel)
          )
            continue;
          changes.push({ messageId: id(record(detail.message).id), historyId: at, kind });
          if (changes.length > 2000) fail("PROVIDER_RESPONSE_TOO_LARGE");
        }
      }
    }
    return {
      changes,
      messageIds: [
        ...new Set(
          changes
            .filter((item) => item.kind === "message_added" || item.kind === "label_added")
            .map((item) => item.messageId),
        ),
      ],
      nextPageToken: body.nextPageToken === undefined ? null : text(body.nextPageToken, 2048),
      historyId: historyId(body.historyId),
    };
  }
  async getMessage(input: { accessToken: string; messageId: string }): Promise<CplGmailMessage> {
    const result = await this.request(
      "messages.get",
      `${API}/messages/${id(input.messageId)}?format=full`,
      { ...input, maximum: 4_194_304 },
    );
    const message = await parseCplGmailMessage(result.body, result.raw);
    if (message.id !== input.messageId) fail();
    return message;
  }
  async revoke(input: { token: string; projectGrantRevocationConfirmed: true }): Promise<void> {
    if (input.projectGrantRevocationConfirmed !== true) fail("PROVIDER_CONFIGURATION_INVALID");
    await this.request("revoke", REVOKE, {
      maximum: 65_536,
      body: new URLSearchParams({ token: token(input.token) }),
    });
  }
}

function decodeMimeData(value: string): Uint8Array {
  if (value.length > 174_768 || !/^[A-Za-z0-9_-]*={0,2}$/u.test(value)) fail("MIME_INVALID");
  const unpadded = value.replace(/=+$/u, "");
  const result = Buffer.from(unpadded, "base64url");
  if (result.length > 131_072 || result.toString("base64url") !== unpadded) fail("MIME_INVALID");
  return result;
}
function headerDisplay(value: string): string {
  return value
    .replace(/\r?\n[ \t]+/gu, " ")
    .replace(
      /=\?([^?\s]{1,40})\?([bq])\?([^?]{0,16000})\?=/giu,
      (_all, charset: string, encoding: string, encoded: string) => {
        try {
          const raw =
            encoding.toLowerCase() === "b"
              ? Buffer.from(encoded, "base64")
              : Buffer.from(
                  encoded
                    .replace(/_/gu, " ")
                    .replace(/=([a-f0-9]{2})/giu, (_m: string, hex: string) =>
                      String.fromCharCode(parseInt(hex, 16)),
                    ),
                  "latin1",
                );
          return new TextDecoder(charset, { fatal: true }).decode(raw);
        } catch {
          return _all as string;
        }
      },
    );
}
export async function parseCplGmailMessage(
  input: unknown,
  original: Uint8Array,
): Promise<CplGmailMessage> {
  const message = record(input);
  const payload = record(message.payload);
  const attachments: CplGmailMessage["attachments"] = [];
  const plain: string[] = [];
  const issues = new Set<string>();
  let parts = 0;
  let decodedBytes = 0;
  function headers(part: Record<string, unknown>) {
    return optionalList(part.headers, 200).map((item) => {
      const h = record(item);
      return { name: text(h.name, 100).toLowerCase(), value: text(h.value, 16_384, true) };
    });
  }
  function walk(value: unknown, depth: number, insideAttachment = false): unknown {
    if (++parts > 256 || depth > 32) fail("MIME_LIMIT_EXCEEDED");
    const part = record(value);
    const mime = text(part.mimeType, 127).toLowerCase();
    const name = part.filename === undefined ? "" : text(part.filename, 1024, true);
    const h = headers(part);
    const body = part.body === undefined ? {} : record(part.body);
    const size = body.size === undefined ? 0 : integer(body.size, 2_147_483_647);
    const attachmentId = body.attachmentId === undefined ? null : text(body.attachmentId, 2048);
    const disposition =
      h.find((item) => item.name === "content-disposition")?.value.toLowerCase() ?? "";
    const attachment = Boolean(
      name ||
      attachmentId ||
      disposition.startsWith("attachment") ||
      (!mime.startsWith("text/") && !mime.startsWith("multipart/")),
    );
    if (attachment) {
      if (attachments.length >= 100) fail("MIME_LIMIT_EXCEEDED");
      attachments.push({
        id: attachmentId,
        name,
        mediaType: mime,
        bytes: size,
        status: attachmentId || body.data ? "not_ingested" : "unavailable",
      });
    }
    if (
      !attachment &&
      !insideAttachment &&
      mime === "text/plain" &&
      typeof body.data === "string"
    ) {
      const raw = decodeMimeData(body.data);
      decodedBytes += raw.length;
      if (decodedBytes > 131_072) fail("MIME_LIMIT_EXCEEDED");
      const contentType = h.find((item) => item.name === "content-type")?.value ?? "";
      const charset = /charset\s*=\s*"?([^;"\s]+)/iu.exec(contentType)?.[1] ?? "utf-8";
      try {
        plain.push(new TextDecoder(charset, { fatal: true }).decode(raw));
      } catch {
        issues.add("UNSUPPORTED_OR_INVALID_TEXT_ENCODING");
      }
    } else if (!attachment && !insideAttachment && mime === "text/plain")
      issues.add("PLAIN_BODY_UNAVAILABLE");
    else if (!attachment && !insideAttachment && mime === "text/html")
      issues.add("HTML_BODY_NOT_EXTRACTED");
    const children = optionalList(part.parts, 256).map((item) =>
      walk(item, depth + 1, insideAttachment || attachment),
    );
    return {
      partId: part.partId === undefined ? "" : text(part.partId, 100, true),
      mimeType: mime,
      filename: name,
      headers: h,
      body: {
        size,
        attachmentId,
        data: body.data === undefined ? null : text(body.data, 4_194_304, true),
      },
      parts: children,
    };
  }
  const canonicalPayload = walk(payload, 0);
  const top = headers(payload);
  const subject = headerDisplay(top.find((item) => item.name === "subject")?.value ?? "");
  const from = headerDisplay(top.find((item) => item.name === "from")?.value ?? "");
  const match = /^\s*(?:"?([^<>]*?)"?\s*)?<([^\s<>@,]+@[^\s<>@,]+)>\s*$/u.exec(from);
  const bare = /^[^\s<>@,]+@[^\s<>@,]+$/u.test(from) ? from : "";
  const senderEmailClaim = match?.[2] ?? bare;
  if (!senderEmailClaim) issues.add("SENDER_CLAIM_AMBIGUOUS");
  const result = {
    id: id(message.id),
    threadId: id(message.threadId),
    internalDate: historyId(message.internalDate),
  };
  return {
    ...result,
    historyId: historyId(message.historyId),
    labelIds: optionalList(message.labelIds, 1000).map(id),
    original,
    originalMediaType: "application/json",
    contentSha256: await digest({ ...result, payload: canonicalPayload }),
    subject,
    senderNameClaim: match?.[1]?.replace(/^"|"$/gu, "").trim() ?? "",
    senderEmailClaim,
    plainText: plain.length ? plain.join("\n\n") : null,
    parseIssues: [...issues],
    attachments,
  };
}
