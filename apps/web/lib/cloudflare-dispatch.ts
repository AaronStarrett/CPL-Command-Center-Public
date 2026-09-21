import { cplEntryDecision } from "./cpl-entry-policy";

export interface CplWorkerEnvironment {
  readonly NODE_ENV?: string;
  readonly CPL_HOSTED_ENABLED?: string;
  readonly ASSETS: { fetch(request: Request): Promise<Response> };
}
type Handler = (request: Request) => Promise<Response>;
type CplHandler = (
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) => Promise<Response>;
export interface CplDispatchDependencies<Context> {
  readonly auth: Readonly<Record<string, { readonly GET?: Handler; readonly POST?: Handler }>>;
  readonly cpl: { readonly GET: CplHandler; readonly POST: CplHandler };
  readonly workspaceAsset: string;
  readonly runWithContext: (
    request: Request,
    env: CplWorkerEnvironment,
    context: Context,
    operation: () => Promise<Response>,
  ) => Promise<Response>;
  readonly fallback: (
    request: Request,
    env: CplWorkerEnvironment,
    context: Context,
  ) => Promise<Response>;
}

const siteHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Opener-Policy": "same-origin",
};

/** Next normally consumes its internal cookie mirror. Returning it directly
 * would expose HttpOnly cookie material through a script-readable header. */
export async function directWorkerResponse(response: Response, method: string): Promise<Response> {
  const cookies = response.headers.getSetCookie();
  const headers = new Headers(response.headers);
  for (const key of [...headers.keys()])
    if (key.toLowerCase().startsWith("x-middleware-")) headers.delete(key);
  headers.delete("set-cookie");
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  for (const [key, value] of Object.entries(siteHeaders))
    if (!headers.has(key)) headers.set(key, value);
  if (method === "HEAD") await response.body?.cancel();
  return new Response(method === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function isWorkspaceDocument(request: Request): boolean {
  const url = new URL(request.url);
  return (
    ["GET", "HEAD"].includes(request.method) &&
    url.pathname === "/workspace" &&
    !url.searchParams.has("_rsc") &&
    !["rsc", "next-router-state-tree", "next-router-prefetch", "next-url"].some((name) =>
      request.headers.has(name),
    )
  );
}

/** Only transport changes here. Existing route functions remain responsible
 * for provider verification, sessions, CSRF, permissions and tenant SQL. */
export function createCplWorkerFetch<Context>(dependencies: CplDispatchDependencies<Context>) {
  if (!/^\/cdn-cgi\/cpl-shell\/[A-Za-z0-9_-]+\/workspace\.html$/u.test(dependencies.workspaceAsset))
    throw new Error("Reviewed generated workspace asset required.");
  return async (
    request: Request,
    env: CplWorkerEnvironment,
    context: Context,
  ): Promise<Response> => {
    const url = new URL(request.url);
    const decision = cplEntryDecision(
      url.pathname,
      request.method,
      env.NODE_ENV,
      env.CPL_HOSTED_ENABLED === "true",
    );
    if (decision === "setup" || decision === "workspace") {
      url.pathname = decision === "workspace" ? "/workspace" : "/setup";
      url.search = "";
      return directWorkerResponse(Response.redirect(url, 307), request.method);
    }
    if (decision === "unavailable")
      return directWorkerResponse(
        Response.json(
          {
            code: "CPL_PRODUCT_RUNTIME_NOT_READY",
            message: "Workspace setup is not complete. Customer operations are unavailable.",
            status: "unconfigured",
          },
          { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "3600" } },
        ),
        request.method,
      );
    // The production gate is repeated here: a test/development policy allowance
    // must never accidentally dispatch hosted production handlers.
    if (env.NODE_ENV !== "production" || env.CPL_HOSTED_ENABLED !== "true")
      return dependencies.fallback(request, env, context);
    if (isWorkspaceDocument(request)) {
      const asset = await env.ASSETS.fetch(
        new Request(new URL(dependencies.workspaceAsset, request.url), { method: "GET" }),
      );
      if (asset.status !== 200) {
        await asset.body?.cancel();
        return dependencies.fallback(request, env, context);
      }
      const headers = new Headers(asset.headers);
      headers.set("Content-Type", "text/html; charset=utf-8");
      // This is only a public, identity-free generated shell.
      headers.set("Cache-Control", "public, max-age=0, must-revalidate");
      return directWorkerResponse(new Response(asset.body, { headers }), request.method);
    }
    const auth = dependencies.auth[url.pathname];
    const isCpl = url.pathname.startsWith("/api/cpl/");
    if (!auth && !isCpl) return dependencies.fallback(request, env, context);
    const methods = auth ?? dependencies.cpl;
    if (request.method === "OPTIONS") {
      const allowed = [
        "OPTIONS",
        ...(methods.GET ? ["GET", "HEAD"] : []),
        ...(methods.POST ? ["POST"] : []),
      ];
      return directWorkerResponse(
        new Response(null, { status: 204, headers: { Allow: allowed.sort().join(", ") } }),
        request.method,
      );
    }
    const method = request.method === "HEAD" ? "GET" : request.method;
    const handler = method === "GET" ? methods.GET : method === "POST" ? methods.POST : undefined;
    if (!handler) return directWorkerResponse(new Response(null, { status: 405 }), request.method);
    const response = await dependencies.runWithContext(request, env, context, () => {
      if (auth) return (handler as Handler)(request);
      return (handler as CplHandler)(request, {
        params: Promise.resolve({ path: url.pathname.slice("/api/cpl/".length).split("/") }),
      });
    });
    return directWorkerResponse(response, request.method);
  };
}
