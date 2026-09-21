/** Deployment gate, not an authentication boundary. Runtime/worker repeat the guard. */
export function cplEntryDecision(
  pathname: string,
  method: string,
  nodeEnv: string | undefined,
  hostedEnabled = false,
) {
  if (nodeEnv === "test") return "allow" as const;
  // Capability allowlist only. These routes independently validate provider
  // configuration, sessions, CSRF, membership and tenant-scoped SQL privileges.
  if (hostedEnabled) {
    if ((method === "GET" || method === "HEAD") && ["/", "/setup", "/sign-in"].includes(pathname))
      return "workspace" as const;
    if ((method === "GET" || method === "HEAD") && pathname === "/workspace")
      return "allow" as const;
    if (
      /^\/api\/cpl\/(?:workspace|organizations(?:\/select)?|leads(?:\/[0-9a-f-]+)?|proposals(?:\/[0-9a-f-]+(?:\/download)?)?|jobs)$/u.test(
        pathname,
      )
    )
      return "allow" as const;
    if (
      [
        "/api/auth/google/start",
        "/api/auth/google/callback",
        "/api/auth/session",
        "/api/auth/renew",
        "/api/auth/logout",
        "/api/auth/passkeys/register/options",
        "/api/auth/passkeys/register/verify",
        "/api/auth/passkeys/authenticate/options",
        "/api/auth/passkeys/authenticate/verify",
      ].includes(pathname)
    )
      return "allow" as const;
  }
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
