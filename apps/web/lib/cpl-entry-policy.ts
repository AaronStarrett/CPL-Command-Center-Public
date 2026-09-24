/** Deployment gate, not an authentication boundary. Runtime/worker repeat the guard. */
export function cplEntryDecision(
  pathname: string,
  method: string,
  nodeEnv: string | undefined,
  hostedEnabled = false,
  localDevelopment = false,
) {
  if (nodeEnv === "test") return "allow" as const;
  // Capability allowlist only. These routes independently validate provider
  // configuration, sessions, CSRF, membership and tenant-scoped SQL privileges.
  if (hostedEnabled || localDevelopment) {
    if (
      /^(?:\/api\/cpl-inbound\/(?:forms|sources)\/|\/inquiry\/)[A-Za-z0-9_-]{24,80}$/u.test(
        pathname,
      )
    )
      return "allow" as const;
    if (
      /^\/api\/cpl-integrations\/(?:workspace|mappings(?:\/(?:preview|[0-9a-f-]+))?|receipts(?:\/[0-9a-f-]+(?:\/(?:retry|reprocess|evidence))?)?|connections(?:\/[0-9a-f-]+(?:\/(?:save|state|sync|labels|oauth\/start))?)?|forms(?:\/[0-9a-f-]+\/(?:preview|state|credential|revoke-credential))?|oauth\/google\/callback)$/u.test(
        pathname,
      )
    )
      return "allow" as const;
    if (
      /^\/api\/cpl-company\/(?:workspace|configuration|profile|intake-policy|policies|audit|templates\/(?:proposal|field|report)|catalog(?:\/[0-9a-f-]+(?:\/(?:archive|reactivate))?)?|directory\/(?:customer|contact|site)(?:\/[0-9a-f-]+(?:\/(?:archive|reactivate))?)?)$/u.test(
        pathname,
      )
    )
      return "allow" as const;
    if (
      /^\/api\/cpl-admin\/(?:bootstrap|platform\/organizations|members|invitations(?:\/accept|\/[0-9a-f-]+\/(?:reissue|revoke))?)$/u.test(
        pathname,
      )
    )
      return "allow" as const;
    if ((method === "GET" || method === "HEAD") && ["/", "/setup", "/sign-in"].includes(pathname))
      return "workspace" as const;
    if ((method === "GET" || method === "HEAD") && pathname === "/workspace")
      return "allow" as const;
    if (
      /^\/api\/cpl\/(?:workspace|directory|organizations(?:\/select)?|leads(?:\/[0-9a-f-]+(?:\/evidence)?)?|proposals(?:\/[0-9a-f-]+(?:\/download)?)?|jobs)$/u.test(
        pathname,
      )
    )
      return "allow" as const;
    if (
      /^\/api\/cpl-commercial\/(?:workspace|templates|branding|projects\/[0-9a-f-]+|proposals(?:\/[0-9a-f-]+(?:\/(?:save|submit|review|revise|outcome|project|project-preview|customer-preview|pdf))?)?)$/u.test(
        pathname,
      )
    )
      return "allow" as const;
    if (
      /^\/api\/cpl-execution\/(?:assigned|agenda|projects\/[0-9a-f-]+(?:\/visits(?:\/[0-9a-f-]+)?)?|visits\/[0-9a-f-]+)$/u.test(
        pathname,
      )
    )
      return "allow" as const;
    if (
      /^\/api\/cpl-field\/(?:templates|projects\/[0-9a-f-]+\/visits\/[0-9a-f-]+(?:\/(?:template|checklist|observations|reopen|photos(?:\/[0-9a-f-]+(?:\/(?:file|retry))?)?))?)$/u.test(
        pathname,
      )
    )
      return "allow" as const;
    if (
      /^\/api\/cpl-reports\/(?:templates|branding|projects\/[0-9a-f-]+(?:\/reports(?:\/[0-9a-f-]+(?:\/(?:save|sources|submit|review|revise|approve|preview|pdf))?)?)?)$/u.test(
        pathname,
      )
    )
      return "allow" as const;
    if (
      /^\/api\/cpl-automation\/(?:workspace|recipes|tasks\/[0-9a-f-]+|executions\/[0-9a-f-]+(?:\/(?:retry|cancel))?|events\/[0-9a-f-]+\/replay)$/u.test(
        pathname,
      )
    )
      return "allow" as const;
    if (
      /^\/api\/cpl-delivery\/projects\/[0-9a-f-]+(?:\/(?:policy|closeout|override|billing-handoff|reports\/[0-9a-f-]+\/withdraw|packages(?:\/[0-9a-f-]+(?:\/(?:save|revise|ready|export|record-sent|acknowledge|manifest|message|attachments\/[0-9a-f-]+))?)?))?$/u.test(
        pathname,
      )
    )
      return "allow" as const;
    if (
      localDevelopment &&
      [
        "/api/auth/local/sign-in",
        "/api/auth/local/status",
        "/api/auth/local/config",
        "/api/auth/session",
        "/api/auth/renew",
        "/api/auth/logout",
      ].includes(pathname)
    )
      return "allow" as const;
    if (
      !localDevelopment &&
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
