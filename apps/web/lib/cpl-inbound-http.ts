import { CommercialInputError, commercialPrivateHeaders } from "./cpl-commercial-http";

export const CPL_INBOUND_BODY_LIMIT = 65_536;
export const CPL_INBOUND_BODY_TIMEOUT_MS = 10_000;
export class InboundBodyTimeout extends Error {
  readonly code = "CPL_INBOUND_TIMEOUT";
  constructor() {
    super("CPL_INBOUND_TIMEOUT");
  }
}
export const inboundHeaders = {
  ...commercialPrivateHeaders,
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
};

export function inboundJson(value: unknown, status = 200, extra: Record<string, string> = {}) {
  return Response.json(value, { status, headers: { ...inboundHeaders, ...extra } });
}

/** Never trust arbitrary forwarding headers for abuse authority. Next does not
 * expose an authenticated socket address here. All unidentified callers share
 * an aggregate bucket, alongside durable global/source quotas in PostgreSQL.
 * A trusted hosted edge address policy requires separate acceptance. */
export function inboundAddressKey(_request: Request) {
  void _request;
  return "unattributed";
}

export function inboundPublicId(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9_-]{24,80}$/u.test(value)) throw new CommercialInputError();
  return value;
}

/** Strict bounded bytes are preserved for HMAC verification before JSON parsing.
 * Content-Length is only an early rejection; it never replaces the stream cap. */
export async function inboundBytes(request: Request): Promise<Uint8Array> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/iu.test(type))
    throw new CommercialInputError();
  const length = request.headers.get("content-length");
  if (
    length !== null &&
    (!/^[0-9]{1,10}$/u.test(length) || Number(length) > CPL_INBOUND_BODY_LIMIT)
  )
    throw new CommercialInputError();
  const reader = request.body?.getReader();
  if (!reader) throw new CommercialInputError();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new InboundBodyTimeout());
      void reader.cancel().catch(() => {});
    }, CPL_INBOUND_BODY_TIMEOUT_MS);
  });
  try {
    while (true) {
      const current = await Promise.race([reader.read(), deadline]);
      if (current.done) break;
      size += current.value.byteLength;
      if (size > CPL_INBOUND_BODY_LIMIT) {
        await reader.cancel();
        throw new CommercialInputError();
      }
      chunks.push(current.value);
    }
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** A browser form is intentionally anonymous, but a foreign origin cannot use
 * the browser's ambient context to submit through this same-origin surface. */
export function requireInquiryOrigin(request: Request, configuredOrigin: string) {
  const site = request.headers.get("sec-fetch-site");
  if (
    request.headers.get("origin") !== configuredOrigin ||
    (site !== null && site !== "same-origin" && site !== "none")
  )
    throw new CommercialInputError();
}

export function signedInboundHeaders(request: Request) {
  const read = (name: string, expression: RegExp) => {
    const value = request.headers.get(name);
    if (!value || !expression.test(value)) throw new CommercialInputError();
    return value;
  };
  return {
    keyId: read("x-cpl-source-key", /^[A-Za-z0-9_-]{16,80}$/u),
    timestamp: read("x-cpl-timestamp", /^[0-9]{10,12}$/u),
    nonce: read("x-cpl-nonce", /^[A-Za-z0-9_-]{22,86}$/u),
    signature: read("x-cpl-signature", /^[A-Za-z0-9_-]{43}$/u),
  };
}
