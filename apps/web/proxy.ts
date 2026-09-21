import { NextResponse, type NextRequest } from "next/server";
import { cplEntryDecision } from "./lib/cpl-entry-policy";
export function proxy(request: NextRequest) {
  const decision = cplEntryDecision(request.nextUrl.pathname, request.method, process.env.NODE_ENV);
  if (decision === "allow") return NextResponse.next();
  if (decision === "setup") {
    const target = request.nextUrl.clone();
    target.pathname = "/setup";
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
