export interface OriginAllowlistInput {
  readonly appBaseUrl: string;
  readonly deploymentProfile?: string;
  readonly ownerEvaluationPublicOrigin?: string;
}

function parseExactOrigin(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an exact HTTP(S) origin.`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    value.includes("*") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new Error(
      `${label} must be an exact HTTP(S) origin without credentials, path, query, fragment, or wildcards.`,
    );
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "*" || hostname.startsWith("*.") || hostname.includes("*")) {
    throw new Error(`${label} cannot use a wildcard hostname.`);
  }
  return url;
}

export function parseExactHttpOrigin(value: string, label = "Origin"): string {
  return parseExactOrigin(value, label).origin;
}

function loopbackAliasOrigin(appBaseUrl: string): string | null {
  const url = new URL(appBaseUrl);
  const hostname = url.hostname.toLowerCase();
  if (hostname === "127.0.0.1") {
    url.hostname = "localhost";
    return url.origin;
  }
  if (hostname === "localhost") {
    url.hostname = "127.0.0.1";
    return url.origin;
  }
  if (hostname === "[::1]") {
    url.hostname = "localhost";
    return url.origin;
  }
  return null;
}

/**
 * Exact allowlisted origins for Owner Evaluation. Local Live and other profiles
 * remain single-origin (APP_BASE_URL only).
 *
 * Precedence for the Owner Evaluation sign-in URL:
 * 1. BEA_OWNER_EVALUATION_PUBLIC_ORIGIN when configured
 * 2. APP_BASE_URL
 */
export function trustedRequestOrigins(input: OriginAllowlistInput): readonly string[] {
  const appOrigin = parseExactHttpOrigin(input.appBaseUrl, "APP_BASE_URL");
  const origins = new Set<string>([appOrigin]);
  if (input.deploymentProfile === "owner-evaluation") {
    const alias = loopbackAliasOrigin(input.appBaseUrl);
    if (alias) origins.add(alias);
    if (input.ownerEvaluationPublicOrigin?.trim()) {
      origins.add(
        parseExactHttpOrigin(
          input.ownerEvaluationPublicOrigin,
          "BEA_OWNER_EVALUATION_PUBLIC_ORIGIN",
        ),
      );
    }
  }
  return Object.freeze([...origins]);
}

export function ownerEvaluationSignInOrigin(input: OriginAllowlistInput): string {
  if (input.deploymentProfile === "owner-evaluation" && input.ownerEvaluationPublicOrigin?.trim()) {
    return parseExactHttpOrigin(
      input.ownerEvaluationPublicOrigin,
      "BEA_OWNER_EVALUATION_PUBLIC_ORIGIN",
    );
  }
  return parseExactHttpOrigin(input.appBaseUrl, "APP_BASE_URL");
}

export function isLoopbackHostname(hostname: string): boolean {
  const value = hostname.toLowerCase();
  return (
    value === "localhost" ||
    value.endsWith(".localhost") ||
    value === "127.0.0.1" ||
    value === "[::1]"
  );
}

export function requestOriginIfExact(request: {
  readonly headers: { get(name: string): string | null };
}): string | null {
  const supplied = request.headers.get("origin")?.trim();
  if (!supplied) return null;
  try {
    return parseExactHttpOrigin(supplied, "Origin");
  } catch {
    return null;
  }
}

export function selectTrustedRequestOrigin(
  request: { readonly headers: { get(name: string): string | null } },
  input: OriginAllowlistInput,
): string {
  const trusted = trustedRequestOrigins(input);
  const supplied = requestOriginIfExact(request);
  if (supplied && trusted.includes(supplied)) return supplied;
  return ownerEvaluationSignInOrigin(input);
}
