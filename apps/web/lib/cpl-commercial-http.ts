import type { requireHostedSession } from "./hosted-auth";

export const commercialPrivateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Vary: "Cookie",
  "X-Content-Type-Options": "nosniff",
};

export class CommercialInputError extends Error {
  readonly code = "CPL_INVALID_INPUT";
}
class CommercialContextError extends Error {
  constructor(readonly code = "CPL_ORGANIZATION_CONTEXT_CHANGED") {
    super(code);
  }
}

/** Browser context is a stale-view precondition, never tenant authority. */
export function commercialTenant(
  current: Awaited<ReturnType<typeof requireHostedSession>>,
  request: Request,
  download = false,
) {
  const organizationId = current.session.selectedOrganizationId;
  if (!organizationId) throw new CommercialContextError("CPL_ORGANIZATION_REQUIRED");
  const header = request.headers.get("x-cpl-organization");
  const query = new URL(request.url).searchParams.getAll("organization");
  if (
    query.length > 1 ||
    (query.length && !download) ||
    (header && query.length && header !== query[0])
  )
    throw new CommercialContextError();
  if ((header ?? (download ? query[0] : undefined)) !== organizationId)
    throw new CommercialContextError();
  return { sessionToken: current.sessionToken, organizationId };
}

export function commercialJson(value: unknown, status = 200) {
  return Response.json(value, { status, headers: commercialPrivateHeaders });
}

/** Bounded stream, strict UTF-8 and top-level allowlist; nested domain validation
 * remains mandatory in the tenant service even for non-HTTP callers. */
export async function commercialBody(request: Request, keys: readonly string[], limit = 262_144) {
  if (!/^application\/json(?:\s*;|\s*$)/iu.test(request.headers.get("content-type") ?? ""))
    throw new CommercialInputError();
  const reader = request.body?.getReader();
  if (!reader) throw new CommercialInputError();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new CommercialInputError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CommercialInputError();
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new CommercialInputError();
  return value as Record<string, unknown>;
}

export function commercialString(
  input: Record<string, unknown>,
  key: string,
  optional = false,
): string {
  const value = input[key];
  if (optional && value === undefined) return "";
  if (typeof value !== "string") throw new CommercialInputError();
  return value;
}

export function commercialInteger(
  input: Record<string, unknown>,
  key: string,
  minimum = 1,
): number {
  const value = input[key];
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new CommercialInputError();
  return Number(value);
}

export function commercialVersion(request: Request): number | undefined {
  const values = new URL(request.url).searchParams.getAll("version");
  if (values.length === 0) return undefined;
  if (values.length !== 1 || !/^[1-9][0-9]{0,8}$/u.test(values[0]!))
    throw new CommercialInputError();
  return Number(values[0]);
}
