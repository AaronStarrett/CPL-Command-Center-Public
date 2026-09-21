/** Deployment gate, not an authentication boundary. Runtime/worker repeat the guard. */
export function cplEntryDecision(pathname: string, method: string, nodeEnv: string | undefined) {
  if (nodeEnv === "test") return "allow" as const;
  if (
    (method === "GET" || method === "HEAD") &&
    (pathname === "/setup" ||
      pathname === "/brand/cpl-logo.png" ||
      pathname.startsWith("/_next/static/") ||
      pathname.startsWith("/_next/webpack-hmr"))
  )
    return "allow" as const;
  if (pathname.startsWith("/api/") || (method !== "GET" && method !== "HEAD"))
    return "unavailable" as const;
  return "setup" as const;
}
