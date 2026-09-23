import { NextResponse, type NextRequest } from "next/server";
import { cplEntryDecision } from "./lib/cpl-entry-policy";
import {
  hasLocalDevelopmentConfiguration,
  assertLocalDevelopmentRequest,
  readLocalDevelopmentConfiguration,
} from "@bea/security/hosted";
export function proxy(request: NextRequest) {
  const local = hasLocalDevelopmentConfiguration();
  if (!local && request.nextUrl.pathname.startsWith("/api/auth/local/"))
    return NextResponse.json(
      { ok: false },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  if (local) {
    try {
      assertLocalDevelopmentRequest(request);
    } catch {
      return NextResponse.json(
        { code: "CPL_LOCAL_DEVELOPMENT_REFUSED" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
  }
  const decision = cplEntryDecision(
    request.nextUrl.pathname,
    request.method,
    process.env.NODE_ENV,
    process.env.CPL_HOSTED_ENABLED === "true",
    local,
  );
  if (decision === "allow") return NextResponse.next();
  if (decision === "setup" || decision === "workspace") {
    const target = local
      ? new URL(request.nextUrl.pathname, readLocalDevelopmentConfiguration().origin)
      : request.nextUrl.clone();
    target.pathname = decision === "workspace" ? "/workspace" : "/setup";
    target.search = "";
    return NextResponse.redirect(target);
  }
  return NextResponse.json(
    {
      code: "CPL_PRODUCT_RUNTIME_NOT_READY",
      message: "Workspace setup is not complete. Customer operations are unavailable.",
      status: "unconfigured",
    },
    { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "3600" } },
  );
}
export const config = { matcher: "/:path*" };
