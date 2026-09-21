export function safeReturnPath(
  value: FormDataEntryValue | string | null | undefined,
  fallback = "/",
  trustedBaseUrl = process.env.APP_BASE_URL ?? "http://127.0.0.1:3000",
): string {
  if (typeof value !== "string") return fallback;
  if (!value.startsWith("/") || /[\u0000-\u001f\u007f\\]/u.test(value)) return fallback;

  let decoded = value;
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return fallback;
    }
    if (decoded.startsWith("//") || /[\u0000-\u001f\u007f\\]/u.test(decoded)) return fallback;
  }

  try {
    const trusted = new URL(trustedBaseUrl);
    const resolved = new URL(value, trusted);
    if (resolved.origin !== trusted.origin) return fallback;
    const normalized = `${resolved.pathname}${resolved.search}${resolved.hash}`;
    if (!/^\/(?!\/)/u.test(resolved.pathname)) return fallback;
    if (/[\u0000-\u001f\u007f\\]/u.test(normalized)) return fallback;
    return normalized;
  } catch {
    return fallback;
  }
}

export function safeInternalHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return safeReturnPath(value, "") || null;
}
